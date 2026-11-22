/** Pull request binding, lifecycle observation, and terminal IM notification helpers. */
import { z } from 'zod'
import { isChinese, key, liveTicket, type Follow, type OutboundMessage, type ThreadFact, type Ticket, type Trigger } from '../core/index.ts'
import type { Deployment } from '../deployment.ts'
import { sameName } from '../infra/text.ts'
import type { SourceContext } from './host.ts'
import { githubPage, repositoryOfThread, SOURCE, threadId, threadRepository, UserSchema } from './github-trigger.ts'

const PullSchema = z.looseObject({
  title: z.string().optional(), state: z.string(), html_url: z.string(), user: UserSchema,
  body: z.string().nullish(), created_at: z.string().optional(),
  merged: z.boolean().optional(), merged_at: z.string().nullish(), closed_at: z.string().nullish(), auto_merge: z.unknown().optional(),
  head: z.looseObject({ sha: z.string(), ref: z.string(), repo: z.looseObject({ full_name: z.string() }).nullish() }),
})
/** A pull request as its own repository returns it; the repository is what its Thread id names. */
export type Pull = z.infer<typeof PullSchema> & { number: number; repository: string }
export const readPull = async (ctx: Pick<SourceContext, 'commands'>, repository: string, number: number, signal?: AbortSignal): Promise<Pull> =>
  ({ ...await ctx.commands.withSignal(signal).forRepository(repository).api(PullSchema, `pulls/${number}`), number, repository })
/** A pull request a ticket follows, as its Thread id names it. */
export interface FollowedPull { repository: string; number: number }
/** Reads a followed Thread key (`github:<owner>/<name>#<number>`) as its pull request; undefined for other Threads. */
function followed(thread: string): FollowedPull | undefined {
  const id = thread.startsWith(`${SOURCE}:`) ? thread.slice(SOURCE.length + 1) : ''
  const repository = repositoryOfThread(id)
  const number = Number(id.slice(id.indexOf('#') + 1))
  return repository && Number.isInteger(number) && number > 0 ? { repository, number } : undefined
}
export const pullsOf = (ticket: Pick<Ticket, 'follows'>, open = false): FollowedPull[] =>
  (ticket.follows ?? []).filter(item => !open || !item.closed).flatMap(item => followed(item.thread) ?? [])
export const pullOf = (ticket: Pick<Ticket, 'follows'>): FollowedPull | undefined => pullsOf(ticket, true).at(-1) ?? pullsOf(ticket).at(-1)
/**
 * The repository a ticket belongs to: the one of its primary Thread, or of the first GitHub Thread it follows. Only a
 * ticket with no GitHub Thread at all, such as one from Feishu, falls back to the deployment's first repository.
 */
export function repositoryOfTicket(ctx: { triggers: { get(id: string): Trigger | undefined }; deployment: Pick<Deployment, 'repository'> },
  ticket: Pick<Ticket, 'origin' | 'follows'>): string {
  const source = ctx.triggers.get(ticket.origin.triggerId)
  const followedThread = ticket.follows?.flatMap(item => item.thread.startsWith(`${SOURCE}:`) ? [item.thread.slice(SOURCE.length + 1)] : [])[0]
  const id = source?.threads.find(ref => ref.source === SOURCE)?.id ?? followedThread
  // A stored GitHub Thread id that names no repository is a foreign key violation; only a ticket with no such Thread
  // falls back to the deployment's first repository.
  return id ? threadRepository(id) : ctx.deployment.repository
}
/** True when the PR was opened by the agent account from a branch in `repository` (not a fork). */
export const agentPull = (pr: { user: { login: string }; head?: { repo?: { full_name: string } | null } | null },
  deployment: Pick<Deployment, 'github'>, repository: string): boolean =>
  sameName(pr.user.login, deployment.github.login) && sameName(pr.head?.repo?.full_name ?? '', repository)
/** True when a branch belongs to the ticket: its last path segment is the ticket's short name, such as `agent/<name>`. */
export const ticketBranch = (ticket: Pick<Ticket, 'execution'>, ref: string): boolean =>
  !!ticket.execution?.name && ref.split('/').at(-1) === ticket.execution.name
const AUTO_MERGE_ON: ThreadFact = { label: { zh: '自动合并', en: 'Auto-merge' }, value: { zh: '已开启', en: 'on' } }
const threadOf = (pr: Pick<Pull, 'repository' | 'number'>): string => `${SOURCE}:${threadId(pr.repository, pr.number)}`

/**
 * Validates and binds an open PR to a ticket when the PR is either the ticket's origin PR or an agent-authored PR on the ticket's branch, enforcing that one PR binds to at most one open ticket.
 * Returns an error message when binding is rejected, or undefined when the PR is bound or when the PR is not open (which is not an error).
 */
export function claimPull(ctx: SourceContext, ticketId: string, pr: Pull): string | undefined {
  const ticket = ctx.tickets.get(ticketId)
  if (!ticket || !liveTicket(ticket)) return 'Ticket ended because its PR was closed'
  const repository = repositoryOfTicket(ctx, ticket)
  const source = ctx.triggers.get(ticket.origin.triggerId)
  const sourceThread = source?.threads.find(ref => ref.source === SOURCE)?.id ?? ''
  const started = source?.source === SOURCE && source.meta.isPr === true && source.meta.number === pr.number
    && sameName(repositoryOfThread(sourceThread) ?? '', pr.repository)
  const opened = agentPull(pr, ctx.deployment, repository) && ticketBranch(ticket, pr.head.ref)
  if (!started && !opened) {
    const { login } = ctx.deployment.github
    return `PR does not belong to this ticket: use the source PR or a PR by ${login} from a branch whose last path segment is DSH_SUPERAGENT_NAME; omit pr_number when no PR exists`
  }
  const owner = ctx.tickets.open().find(item => pullsOf(item, true).some(pull => pull.repository === pr.repository && pull.number === pr.number))
  if (owner && owner.id !== ticketId) return 'PR already belongs to another active ticket'
  const follow = ticket.follows?.find(item => item.thread === threadOf(pr))
  if (pr.state === 'open' && (!follow || follow.closed || (opened && !follow.own))) bind(ctx, ticketId, pr, opened)
  return undefined
}
/**
 * Reconciles a polled PR's open/merged/closed state and auto-merge fact with any bound or branch-matching ticket.
 * An open agent PR auto-binds to the single open ticket on its branch unless that ticket already follows another open PR
 * (which only the Executor's report changes).
 * @returns whether the PR has ended.
 */
export async function observePull(ctx: SourceContext, pr: Pull): Promise<boolean> {
  const ended = pr.state === 'closed' || !!pr.merged
  if (ended) closePull(ctx, pr)
  else {
    const candidates = agentPull(pr, ctx.deployment, pr.repository) ? ctx.tickets.open()
      .filter(ticket => repositoryOfTicket(ctx, ticket) === pr.repository && ticketBranch(ticket, pr.head.ref)) : []
    const ticket = candidates.length === 1 ? candidates[0]! : undefined
    // A PR the ticket followed until it closed, and that is open again, is followed again.
    const reopened = ticket?.follows?.some(item => item.thread === threadOf(pr) && item.closed)
    if (ticket && (reopened || pullsOf(ticket, true).every(pull => pull.repository === pr.repository && pull.number === pr.number))) claimPull(ctx, ticket.id, pr)
  }
  ctx.threads.describe(threadOf(pr), { facts: { autoMerge: !ended && pr.auto_merge != null ? AUTO_MERGE_ON : null } })
  return ended
}
function bind(ctx: SourceContext, ticketId: string, pr: Pull, own: boolean): void {
  ctx.atomic(() => {
    ctx.tickets.bindThread(ticketId, { source: SOURCE, id: threadId(pr.repository, pr.number) }, own)
    ctx.threads.patch(threadOf(pr), { number: pr.number, isPr: true, url: pr.html_url, prAuthor: pr.user.login })
  })
}
/**
 * Reports a merged or closed PR once to the open tickets that follow it, whose end the core decides.
 * Their subscription to the PR stays so a later human comment there resumes the ticket.
 */
function closePull(ctx: SourceContext, pr: Pull): void {
  if (!ctx.tickets.open().some(ticket => pullsOf(ticket, true).some(pull => pull.repository === pr.repository && pull.number === pr.number))) return
  const at = pr.merged_at ?? pr.closed_at ?? new Date().toISOString()
  ctx.tickets.threadClosed({ source: SOURCE, id: threadId(pr.repository, pr.number) }, pr.merged ? 'merged' : 'closed', at)
}
/**
 * Builds idempotent outbound notices for IM conversations when a ticket ends with its PR (selecting the last-closed PR it
 * opened, else the last one it followed). The notice language follows the ticket's source request: Chinese when it contains
 * Han characters and no kana, otherwise English.
 */
export function pullEndNotices(ticket: Ticket, request: string, repository: string): OutboundMessage[] {
  const outcome = ticket.ended?.outcome
  const follows = (ticket.follows ?? []).filter(item => item.closed && followed(item.thread) !== undefined)
  const latest = (items: Follow[]) => items.sort((a, b) => b.closed!.at.localeCompare(a.closed!.at))[0]
  const follow = latest(follows.filter(item => item.own)) ?? latest(follows)
  if ((outcome !== 'merged' && outcome !== 'closed') || !follow) return []
  const number = followed(follow.thread)!.number
  const url = githubPage(repository, number, true)
  const text = isChinese(request)
    ? outcome === 'merged' ? `[PR #${number}](${url}) 已合并。` : `[PR #${number}](${url}) 已关闭，未合并。`
    : outcome === 'merged' ? `[PR #${number}](${url}) has merged.` : `[PR #${number}](${url}) was closed without merging.`
  // GitHub timelines and linked issues already show the merge or closure, so GitHub channels are skipped.
  return ticket.channels.filter(channel => channel.source !== SOURCE).map(channel => ({
    id: key('pr-terminal', String(number), channel.source, JSON.stringify(channel.address), outcome), channel, text, kind: 'notice', ticketId: ticket.id }))
}
