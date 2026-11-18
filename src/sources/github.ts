/** GitHub source kind definition, notification and repository polling loops, and Cordis plugin entry. */
import type { Context } from '@deepseek-ai/cordis'
import { key, type Thread } from '../core/index.ts'
import { sameName } from '../infra/text.ts'
import { GithubAccountsSchema } from '../deployment.ts'
import { CliError, validItems, type Tally } from '../infra/commands.ts'
import { ciCounts, ciFact, ciFailures, ciSummary, githubThreadContext, pullChecks } from './github-read.ts'
import { branchCiTrigger, ciTrigger, commentTrigger, CommentSchema, githubAddress, issueTrigger, IssueSchema, pullTrigger, repositoryOfThread, SOURCE,
  threadId, threadRepository } from './github-trigger.ts'
import { githubLink, sendGithub } from './github-channel.ts'
import type { GithubComment, PullRef } from './github-trigger.ts'
import { observePull, pullsOf, readPull, type FollowedPull, type Pull } from './github-pull.ts'
import { health, sourceContext, type Health, type SourceContext, type SourceHost } from './host.ts'
import { KV } from '../kv.ts'
import { cursorAt, pause, POLL_HORIZON_MS, pollThreads as pollEach } from './poll.ts'
import type { Localized, SourceKind } from './kind.ts'
import { z } from 'zod'

export { commentTrigger, type GithubComment } from './github-trigger.ts'
/** A notification of the agent account; `subject.url` is the API address of its Issue or PR. */
const NotificationSchema = z.looseObject({
  repository: z.looseObject({ full_name: z.string() }), subject: z.looseObject({ url: z.string().nullish() }),
})

const GithubConfigSchema = GithubAccountsSchema.extend({ pollSeconds: z.number().int().min(60).max(3600).default(60),
  failuresBeforeError: z.number().int().min(1).max(20).default(3),
  observeIssues: z.boolean().default(false), observePulls: z.boolean().default(false), observeComments: z.boolean().default(false),
  observeCi: z.boolean().default(false), receiveOwnIssues: z.boolean().default(false) }).strict()
export type GithubConfig = z.infer<typeof GithubConfigSchema>
const OBSERVED = { issues: 'observeIssues', pulls: 'observePulls', comments: 'observeComments', ci: 'observeCi' } as const
type Scope = keyof typeof OBSERVED
function scopeOf(meta: Record<string, unknown>): Scope | undefined {
  if (meta.ci === true) return typeof meta.branch === 'string' ? 'ci' : undefined
  if (meta.kind === 'issue') return 'issues'
  if (meta.kind === 'pull') return 'pulls'
  return meta.kind === 'conversation' || meta.kind === 'inline' || meta.kind === 'review' ? 'comments' : undefined
}
export const githubKind: SourceKind<GithubConfig> = {
  kind: SOURCE,
  title: { zh: 'GitHub', en: 'GitHub' },
  description: { zh: '智能体的 GitHub 账号；接收仓库里发给它的通知、已订阅 Issue 与 PR 的讨论、CI 状态变化和 PR 合并关闭。', en: 'The agent\'s GitHub accounts; receives notifications to it in the repositories, discussion on subscribed Issues and PRs, CI changes, and PR merge or close.' },
  schema: GithubConfigSchema,
  fields: [
    { key: 'repository', type: 'text', pattern: '[A-Za-z0-9_.\\-]+/[A-Za-z0-9_.\\-]+(\\s*[,\\s]\\s*[A-Za-z0-9_.\\-]+/[A-Za-z0-9_.\\-]+)*', label: { zh: '监听的仓库', en: 'Repositories' },
      hint: { zh: '写作 owner/name；多个仓库用逗号、空格或换行分隔，第一个是主仓库。这个来源接收这些仓库的通知和讨论；保存时检查智能体账号能否推送到每一个，然后重启 dsh-superagent。', en: 'Written owner/name; separate several with commas, spaces or newlines, the first being the primary one. This Source receives these repositories\' notifications and discussion; saving checks that the agent account can push to each, then restarts dsh-superagent.' } },
    { key: 'cli', type: 'text', label: { zh: '智能体的 GitHub CLI', en: 'Agent GitHub CLI' },
      hint: { zh: '命令名或绝对路径，通常是用 GH_CONFIG_DIR 登录智能体账号的 gh 包装脚本。智能体以它登录的账号行事，执行器以 gh 调用它。保存时检查它登录的账号能否推送到仓库，然后重启 dsh-superagent。', en: 'A command name or absolute path, usually a gh wrapper signed in to the agent account through GH_CONFIG_DIR. The agent acts as the account it is signed in to, and the Executor calls it as gh. Saving checks that this account can push to the repositories, then restarts dsh-superagent.' } },
    { key: 'pollSeconds', type: 'number', advanced: true, min: 60, max: 3600, label: { zh: '轮询间隔 / 秒', en: 'Polling interval / seconds' }, hint: { zh: 'GitHub 要求更长间隔时以 GitHub 为准。', en: 'A longer interval requested by GitHub wins.' } },
    { key: 'failuresBeforeError', type: 'number', advanced: true, min: 1, max: 20, label: { zh: '连续失败几次后报告异常', en: 'Failed polls before reporting an error' }, hint: { zh: '单次网络中断会在下一次轮询时自动重试，不必报告。', en: 'A single network interruption is retried on the next poll and need not be reported.' } },
    { key: 'observeIssues', type: 'switch', label: { zh: '接收仓库里的新 Issue', en: 'Receive new Issues in the repositories' },
      hint: { zh: '打开后，没有 @ 智能体的新 Issue 也会收到，由策略的接收表决定是否成为候选。从打开的时候开始，不读以前的。', en: 'New Issues that do not mention the agent are received too, and the Policy\'s admission table decides whether they become candidates. Starts when switched on; earlier ones are not read.' } },
    { key: 'observePulls', type: 'switch', label: { zh: '接收仓库里的新 PR', en: 'Receive new pull requests in the repositories' },
      hint: { zh: '打开后，没有 @ 智能体的新 PR 也会收到，由策略的接收表决定是否成为候选。', en: 'New pull requests that do not mention the agent are received too, and the Policy\'s admission table decides whether they become candidates.' } },
    { key: 'observeComments', type: 'switch', label: { zh: '接收仓库里的评论', en: 'Receive comments in the repositories' },
      hint: { zh: '打开后，Issue 和 PR 上没有 @ 智能体的评论和代码评论也会收到，由策略的接收表决定是否成为候选。', en: 'Comments and review comments on Issues and PRs that do not mention the agent are received too, and the Policy\'s admission table decides whether they become candidates.' } },
    { key: 'receiveOwnIssues', type: 'switch', advanced: true, label: { zh: '接收智能体账号自己开的 Issue', en: 'Receive Issues opened by the agent account' },
      hint: { zh: '仅用于测试：智能体与操作者共用一个账号时，让该账号开的新 Issue 也能收到。账号自己的评论和 PR 仍然被忽略。', en: 'For testing only: when the agent and the operator share one account, new Issues opened by that account are received too. The account\'s own comments and pull requests are still ignored.' } },
    { key: 'observeCi', type: 'switch', label: { zh: '接收默认分支的 CI', en: 'Receive each default branch\'s CI' },
      hint: { zh: '打开后，默认分支的 CI 失败和恢复会收到，由策略的接收表决定是否成为候选。', en: 'Failures of a default branch\'s CI, and its recovery, are received, and the Policy\'s admission table decides whether they become candidates.' } }],
  // What the Source observes across the repositories it receives in full; elsewhere, only what addresses the agent.
  scope: ({ meta }, config) => {
    const row = scopeOf(meta)
    return { listened: true, observed: row !== undefined && config[OBSERVED[row]], ...row ? { row } : {} }
  },
  health: ['github'],
  channel: { send: sendGithub, link: githubLink },
  threadContext: githubThreadContext,
  // `#12`, `12`, a page of an Issue or PR, or `owner/name#12` names that Thread; a bare number needs the repository it is asked in.
  find: (query, repository) => {
    const page = /github\.com\/([^/\s]+\/[^/\s]+)\/(?:pull|issues)\/(\d+)/.exec(query.trim())
    const qualified = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#(\d+)$/.exec(query.trim())
    const found = page ? { repository: page[1]!, number: Number(page[2]) } : qualified ? { repository: qualified[1]!, number: Number(qualified[2]) }
      : { repository, number: Number(/^#?(\d+)$/.exec(query.trim())?.[1]) }
    const qualifiedId = found.repository && Number.isInteger(found.number) && found.number > 0 ? [`${SOURCE}:${threadId(found.repository, found.number)}`] : []
    return { threads: qualifiedId, terms: [] }
  },
  policy: {
    schema: z.object({ allowed: z.array(z.object({ id: z.string().regex(/^[A-Za-z0-9-]+$/) }).strict()).default([]),
      bots: z.array(z.object({ id: z.string().regex(/^[A-Za-z0-9-]+(\[bot\])?$/) }).strict()).optional() }).strict(),
    fields: [{ key: 'allowed', type: 'rows', label: { zh: '能发起工作的 GitHub 账号', en: 'GitHub accounts that may originate work' },
      columns: [{ key: 'id', type: 'text', label: { zh: '账号', en: 'Account' }, pattern: '[A-Za-z0-9\\-]+' }] },
    { key: 'bots', type: 'rows', label: { zh: '评论可以成为候选的机器人', en: 'Bots whose comments may become candidates' },
      hint: { zh: '名单里的机器人账号（例如 dependabot[bot]）的评论在来源收到时成为推断的候选，交给评估：评论 @ 了智能体，或者打开了“接收仓库里的评论”。它们不能发起明确的请求，也不能停止工单；其他机器人的评论不接收。', en: 'A comment of a bot account on this list, such as dependabot[bot], becomes an inferred candidate for an assessment when the Source receives it: when it mentions the agent, or with Receive comments in the repositories on. Such a comment never makes an explicit request or stops a ticket; other bots\' comments are not admitted.' },
      columns: [{ key: 'id', type: 'text', label: { zh: '账号', en: 'Account' }, pattern: '[A-Za-z0-9\\-]+(\\[bot\\])?' }] }],
    explicit: { zh: '名单里的账号在 Issue 或评论里 @ 智能体的账号。', en: 'An account on the list mentions the agent\'s account in an Issue or a comment.' },
    rows(stored) {
      const config = GithubConfigSchema.partial().parse(stored)
      const note = (observed: boolean | undefined) => observed ? { zh: '全部', en: 'All' } : { zh: '仅 @', en: '@ only' }
      const row = (id: Scope, label: { zh: string; en: string }) => ({ id, label, note: note(config[OBSERVED[id]]),
        cells: { listedUnaddressed: !!config[OBSERVED[id]], unlistedAddressed: true, unlistedUnaddressed: !!config[OBSERVED[id]] } })
      return [row('issues', { zh: '新 Issue', en: 'New Issues' }), row('pulls', { zh: '新 PR', en: 'New pull requests' }),
        row('comments', { zh: '评论', en: 'Comments' }),
        // CI has no sender, so only the cell of a sender off the list who does not address the agent applies.
        { id: 'ci', label: { zh: '默认分支的 CI', en: 'Default branch CI' }, note: config.observeCi ? { zh: '接收', en: 'Received' } : { zh: '不接收', en: 'Not received' },
          cells: { listedUnaddressed: false, unlistedAddressed: false, unlistedUnaddressed: !!config.observeCi } }]
    },
  },
  environment: {
    variables: [
      { key: 'DSH_SUPERAGENT_GITHUB_REPOSITORY', description: { zh: '这个工单的主 thread 所在的仓库，owner/name；工单不是从 GitHub 来的时是主仓库。智能体在这里开的 PR，分支最后一段是 DSH_SUPERAGENT_NAME 时（例如 agent/$DSH_SUPERAGENT_NAME）会关联到工单', en: 'The repository of this ticket\'s primary thread, as owner/name; the primary repository when the ticket did not start on GitHub. A PR the agent opens here from a branch whose last path segment is DSH_SUPERAGENT_NAME (for example agent/$DSH_SUPERAGENT_NAME) binds to the ticket' } },
      { key: 'DSH_SUPERAGENT_GITHUB_ACCOUNT', description: { zh: '智能体的 GitHub 账号；gh 以它登录，除自动合并外的 GitHub 操作都用 gh，不用其他账号或凭据', en: 'The agent\'s GitHub account. gh is signed in to it; use gh for every GitHub operation except auto-merge, and never another account or credential' } },
      { key: 'DSH_SUPERAGENT_GITHUB_COMMIT_EMAIL', description: { zh: '智能体账号的提交邮箱。这里的 git 没有身份：按提示词写明的作者提交，没有写明时用智能体账号和这个邮箱', en: 'Commit email of the agent\'s account. git has no identity here: commit as the author these instructions name, or as the agent\'s account with this email when they name none' } },
      { key: 'DSH_SUPERAGENT_GITHUB_NUMBER', description: { zh: '接下工单的 Issue 或 PR 编号；工单不是从 GitHub 来的时为空', en: 'Number of the Issue or PR that started the ticket; empty when the ticket did not start on GitHub' } },
      { key: 'DSH_SUPERAGENT_GITHUB_PR_HEAD', description: { zh: '接下工单的 PR 的 head 引用 refs/pull/<编号>/head；不是 PR 时为空', en: 'Head ref refs/pull/<number>/head of the PR that started the ticket; empty when it was not a PR' } },
    ],
    values: ({ deployment, trigger }) => {
      const number = trigger?.threads[0]?.source === SOURCE ? Number(trigger.meta.number) || 0 : 0
      // The ticket's own repository, so a worker on the second repository clones and opens PRs there.
      const repository = (trigger ? repositoryOfThread(trigger.threads.find(ref => ref.source === SOURCE)?.id ?? '') : undefined) ?? deployment.repository
      return { DSH_SUPERAGENT_GITHUB_REPOSITORY: repository, DSH_SUPERAGENT_GITHUB_ACCOUNT: deployment.github.login, DSH_SUPERAGENT_GITHUB_COMMIT_EMAIL: deployment.github.noreply, DSH_SUPERAGENT_GITHUB_NUMBER: number ? String(number) : '',
        DSH_SUPERAGENT_GITHUB_PR_HEAD: number && trigger?.meta.isPr === true ? `refs/pull/${number}/head` : '' }
    },
  },
  facts: (deployment): Record<string, Localized | string> => deployment ? {
    cli: { zh: `当前账号 @${deployment.github.login}`, en: `Current account @${deployment.github.login}` },
  } : {},
}
export const name = 'dsh-superagent-github'
export const inject = ['orchestrator']
/**
 * Registers the GitHub Source and starts its polling, returning the disposer that stops it.
 *
 * The host decides how this runs: the harness plugin stops it with the plugin's fiber, and the plain Node host stops it
 * when the process shuts down.
 */
export function startGithub(host: SourceHost): () => Promise<void> {
  host.sources.register(githubKind)
  const source = sourceContext(host, githubKind)
  const controller = new AbortController()
  // Unhandled rejections terminate the DSH process, so a failure escaping the polling loop is reported as source health instead.
  const running = watch(source, controller.signal)
    .catch((error: unknown) => { source.report('github', { state: 'error', detail: String(error) }) })
  return async () => { controller.abort(); await running }
}
export function apply(ctx: Context): void {
  ctx.effect(() => startGithub(ctx.orchestrator), 'github: source kind')
}
/** Returns an error health once `failures` consecutive polls fail, or undefined so a single network interruption stays quiet. */
export function pollFailure(failures: number, threshold: number, error: unknown): Health | undefined {
  return failures >= threshold ? health('error', 'pollFailures', { count: String(failures), error: String(error) }) : undefined
}
async function watch(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  let interval = 60
  let failures = 0
  await ctx.ready
  // Setup restarts dsh-superagent once it resolves the accounts; until then nothing is polled.
  if (!ctx.configured()) { ctx.report('github', health('paused', 'setupPending')); return }
  while (!signal.aborted) {
    const config = ctx.config<GithubConfig>(SOURCE)
    try {
      if (config) interval = await pollRound(ctx, signal)
      else ctx.report('github', health('paused', 'sourceOff'))
      failures = 0
    } catch (error) {
      failures += 1
      const failed = pollFailure(failures, config?.failuresBeforeError ?? 1, error)
      if (!signal.aborted && failed) ctx.report('github', failed)
    }
    await pause(Math.max(interval, ctx.config<GithubConfig>(SOURCE)?.pollSeconds ?? 60) * 1000, signal)
  }
}
interface Round {
  started: string; signal?: AbortSignal | undefined
  /** Pulls read in this round, by `<repository>#<number>`; a pull request is read once even when a notification and a ticket name it. */
  pulls: Map<string, Promise<Pull>>; read: Set<string>; failures: string[]; dropped: string[]; abandoned: string[]
  tally: Tally
}
const newRound = (signal?: AbortSignal): Round => ({ started: new Date().toISOString(), signal, pulls: new Map(), read: new Set(),
  failures: [], dropped: [], abandoned: [], tally: { skipped: 0 } })
const stopped = (ctx: SourceContext, round: Round): boolean => !!round.signal?.aborted || !ctx.config(SOURCE)
export interface Retry { since: string; pr: boolean; failedAt?: string; attempts?: number }
const RETRY_WINDOW_MS = 24 * 3600_000
/** True when GitHub returns HTTP 410 (Gone); HTTP 404 is retried because it can indicate revoked access to a private repository. */
const deleted = (error: unknown): boolean => error instanceof CliError && error.code === 410
const threadKeyOf = (repository: string, number: number): string => `${SOURCE}:${threadId(repository, number)}`
/** Records a failed read on the Thread and in the round; deleted (410) or abandoned (24h+) threads do not fail the round. */
function failed(ctx: SourceContext, round: Round, repository: string, number: number, error: unknown, abandoned = false): void {
  if (deleted(error)) round.dropped.push(threadId(repository, number))
  else if (abandoned) round.abandoned.push(threadId(repository, number))
  else round.failures.push(`${threadId(repository, number)}: ${String(error)}`)
  ctx.threads.patch(threadKeyOf(repository, number), { pollError: String(error) })
}
function included(raw: string): { headers: string; body: string } {
  const split = raw.search(/\r?\n\r?\n/)
  if (split < 0) throw new Error('GitHub returned no HTTP headers')
  return { headers: raw.slice(0, split), body: raw.slice(split).trim() }
}
const ListedSchema = CommentSchema.extend({ issue_url: z.string().nullish(), pull_request_url: z.string().nullish() })
/** Repository-wide event streams; GitHub's `/issues` endpoint includes PRs, and `/issues/comments` covers issue and PR conversation comments (excluding inline review comments). */
const STREAMS = [
  { id: 'issues', observed: (config: GithubConfig) => config.observeIssues || config.observePulls, path: 'issues?state=all' },
  { id: 'comments', observed: (config: GithubConfig) => config.observeComments, path: 'issues/comments?' },
  { id: 'review-comments', observed: (config: GithubConfig) => config.observeComments, path: 'pulls/comments?' },
] as const
/** Polls one repository's event streams (new Issues/PRs, comments, default-branch CI); each stream reads from when it was switched on, resets when switched off, and fails independently. */
async function pollRepository(ctx: SourceContext, round: Round, repository: string): Promise<void> {
  const config = ctx.config<GithubConfig>(SOURCE)
  if (!config) return
  for (const stream of STREAMS) {
    if (stopped(ctx, round)) return
    if (!stream.observed(config)) { ctx.state.set(KV.github.stream(repository, stream.id), undefined); continue }
    try { await readStream(ctx, round, repository, stream.id, stream.path, config) }
    catch (error) { if (!stopped(ctx, round)) round.failures.push(`${repository} ${stream.id}: ${String(error)}`) }
  }
  // When CI observation is turned off, clear the failure baseline but preserve the revision counter so future triggers have unique IDs.
  if (!config.observeCi) {
    const seen = ctx.state.get(KV.github.branchCi(repository))
    ctx.state.set(KV.github.branchCi(repository), seen && { revision: seen.revision })
    return
  }
  try { await pollBranchCi(ctx, round, repository) }
  catch (error) { if (!stopped(ctx, round)) round.failures.push(`${repository} default branch CI: ${String(error)}`) }
}
/**
 * Polls one repository-wide event stream (oldest first) since its cursor and steps the cursor to five seconds before the
 * newest item (`cursorAt`), relying on Trigger ID deduplication so repeated messages are no-ops. While the cursor stays
 * unchanged (including when clamped to the hourly horizon), sending the last page's ETag makes an unchanged list return
 * HTTP 304 and cost no rate limit. Items from before their kind was switched on or beyond the horizon are ignored.
 */
async function readStream(ctx: SourceContext, round: Round, repository: string, id: string, path: string, config: GithubConfig): Promise<void> {
  const name = KV.github.stream(repository, id)
  const stored = ctx.state.get(name)
  const kinds = id === 'issues' ? [...config.observeIssues ? ['issues'] : [], ...config.observePulls ? ['pulls'] : []] : ['comments']
  const before = typeof stored?.started === 'object' ? stored.started : {}
  const started: Record<string, string> = Object.fromEntries(kinds.map(kind => [kind, before[kind] ?? round.started]))
  const horizon = Math.floor((Date.parse(round.started) - POLL_HORIZON_MS) / 3_600_000) * 3_600_000
  const since = new Date(Math.max(Date.parse(stored?.since ?? round.started), horizon)).toISOString()
  const conditional = stored?.etag && stored.since === since ? ['-H', `If-None-Match: ${stored.etag}`] : []
  let raw: string
  const listed = `${path}&sort=updated&direction=asc&per_page=100&since=${encodeURIComponent(since)}`
  const commands = ctx.commands.withSignal(round.signal).forRepository(repository)
  try { raw = await commands.api(listed, '--include', ...conditional) }
  catch (error) {
    if (error instanceof CliError && error.code === 304) return
    throw error
  }
  const { headers, body } = included(raw)
  const items = validItems(ListedSchema, z.array(z.unknown()).parse(JSON.parse(body)), round.tally)
  const { login } = ctx.deployment.github
  const fresh = (at: string | null | undefined, kind: string) =>
    kind in started && Date.parse(at ?? '') >= Math.max(Date.parse(started[kind]!), horizon)
  for (const item of items) {
    // Stopping mid-stream aborts before advancing the cursor so unread items are retried.
    if (stopped(ctx, round)) throw new Error('The GitHub Source stopped during the poll')
    if (sameName(item.user.login, login) && !(id === 'issues' && config.receiveOwnIssues && !(item as { pull_request?: unknown }).pull_request)) continue
    if (id === 'issues') {
      const issue = IssueSchema.safeParse(item)
      const pr = issue.success && !!issue.data.pull_request
      if (!issue.success || !fresh(issue.data.created_at, pr ? 'pulls' : 'issues')) continue
      await ctx.receive(pr ? pullTrigger(issue.data, login, repository) : issueTrigger(issue.data, login, repository))
      nameThread(ctx, repository, issue.data.number, issue.data.title)
      continue
    }
    const number = Number(/\/(?:issues|pulls)\/(\d+)$/.exec((id === 'comments' ? item.issue_url : item.pull_request_url) ?? '')?.[1])
    if (!number || !fresh(item.updated_at ?? item.created_at, 'comments')) continue
    const isPr = id === 'review-comments' || /\/pull\//.test(item.html_url ?? '')
    const ref = { repository, number, isPr, ...item.html_url ? { url: item.html_url } : {} }
    const trigger = commentTrigger(item, ref, id === 'comments' ? 'conversation' : 'inline', login)
    if (trigger.text) await ctx.receive(trigger)
  }
  const newest = Math.max(...items.map(item => Date.parse(item.updated_at ?? '')).filter(Number.isFinite))
  const moved = Number.isFinite(newest) ? cursorAt(new Date(newest).toISOString()) : since
  const next = Date.parse(moved) > Date.parse(since) ? moved : since
  const etag = /^etag:\s*(.+)$/im.exec(headers)?.[1]?.trim()
  // The ETag belongs to this request, which the next round repeats only while the cursor stays unchanged.
  ctx.state.set(name, { since: next, started, ...etag && next === since ? { etag } : {} })
}
/** Polls one repository's default-branch CI checks, emitting a trigger only when the set of failing checks changes after the initial baseline. */
async function pollBranchCi(ctx: SourceContext, round: Round, repository: string): Promise<void> {
  const commands = ctx.commands.withSignal(round.signal).forRepository(repository)
  const { default_branch: branch } = await commands.api(z.looseObject({ default_branch: z.string() }), '')
  const head = await commands.api(z.looseObject({ sha: z.string() }), `commits/${encodeURIComponent(branch)}`)
  const snapshot = await pullChecks(commands, head.sha, round.tally)
  const previous = ctx.state.get(KV.github.branchCi(repository))
  // The first observation after switching on or renaming the default branch establishes the baseline.
  const known = previous?.branch === branch ? previous.failures : undefined
  const failures = ciFailures(snapshot)
  const counts = ciCounts(snapshot)
  // Retain previous failures while checks are still running so recovery is reported only once all checks pass.
  const now = failures.length || !counts.running ? failures : known ?? []
  let revision = previous?.revision ?? 0
  if (known && JSON.stringify(now) !== JSON.stringify(known)) {
    revision += 1
    const summary = ciSummary(snapshot, branch, `github/commits/${head.sha}/checks`)
    const url = `https://github.com/${repository}/commit/${head.sha}`
    await ctx.receive(branchCiTrigger(repository, branch, head.sha, revision, summary, url))
    ctx.threads.describe(`${SOURCE}:${repository}#ci:${branch}`, { label: `CI on ${branch}`, facts: { ci: ciFact(counts) } })
  }
  ctx.state.set(KV.github.branchCi(repository), { branch, failures: now, revision })
}
/**
 * One polling round: notifications, then each repository's observed streams, then the PRs of open tickets with their CI,
 * then subscribed Threads. Each step and each Issue, PR, or Thread fails independently so all steps run before the round
 * fails. Other read failures (including 404) fail the round toward the error threshold, whereas deleted (410) or abandoned
 * (24h+) threads are recorded only on the thread and in health detail.
 * @returns the polling interval requested by GitHub, in seconds.
 */
export async function pollRound(ctx: SourceContext, signal?: AbortSignal): Promise<number> {
  const round = newRound(signal)
  const notified = await pollNotifications(ctx, round).then(value => ({ value }), (error: unknown) => ({ error }))
  for (const repository of ctx.deployment.repositories) await pollRepository(ctx, round, repository)
  await pollTicketPulls(ctx, signal, round)
  await pollThreads(ctx, signal, round)
  if ('error' in notified) throw notified.error
  const { count, interval } = notified.value
  if (signal?.aborted) return interval
  if (round.failures.length) throw new Error(`${round.failures.length} GitHub reads failed: ${round.failures.slice(0, 3).join('; ')}`)
  const named = (ids: string[]) => [...new Set(ids)].sort().join(', ')
  const dropped = (round.dropped.length ? `; deleted on GitHub: ${named(round.dropped)}` : '')
    + (round.abandoned.length ? `; dropped after their reads kept failing: ${named(round.abandoned)}` : '')
    + (round.tally.skipped ? `; ${round.tally.skipped} unreadable items skipped` : '')
  // One line per repository, so a healthy repository's line is not hidden by another's reads.
  const detail = ctx.deployment.repositories.map(repository => `${repository}: ${count.get(repository) ?? 0} notifications; next poll ≥ ${interval}s`).join('\n')
  ctx.report('github', { state: 'ready', detail: `${detail}${dropped}`, at: round.started })
  return interval
}
/** Reads notifications since the earliest repository cursor and each Issue or PR they name, advancing each repository's cursor and retry map; deleted (410) Issues are dropped once their error is recorded. */
async function pollNotifications(ctx: SourceContext, round: Round): Promise<{ count: Map<string, number>; interval: number }> {
  const { state } = ctx
  // The notification list is the account's, so it is read under the primary repository, whose path names the same account.
  const commands = ctx.commands.withSignal(round.signal).forRepository(ctx.deployment.repository)
  const repositories = ctx.deployment.repositories
  const since: Record<string, string> = {}
  for (const repository of repositories) {
    since[repository] = state.get(KV.github.since(repository)) ?? round.started
    if (state.get(KV.github.since(repository)) === undefined) state.set(KV.github.since(repository), since[repository])
  }
  // The notification list is the account's, not a repository's: it is read once from the earliest repository cursor, and
  // each repository's own cursor and retry map decide what of it is read.
  const earliest = [round.started, ...Object.values(since)].sort()[0]!
  const path = `notifications?all=true&per_page=50&since=${encodeURIComponent(earliest)}`
  const raw = await commands.api(path, '--include')
  const split = raw.search(/\r?\n\r?\n/)
  if (split < 0) throw new Error('GitHub returned no HTTP headers')
  const headers = raw.slice(0, split)
  const body = raw.slice(split).trim()
  const asked = Number(/x-poll-interval:\s*(\d+)/i.exec(headers)?.[1] ?? 60)
  const interval = Math.max(60, Number.isFinite(asked) ? asked : 60)
  const notifications = /rel="next"/.test(headers)
    ? await commands.pages(NotificationSchema, path, round.tally)
    : validItems(NotificationSchema, z.array(z.unknown()).parse(JSON.parse(body)), round.tally)
  const retries: Record<string, Record<string, Retry>> = {}
  const items = new Map<string, Map<number, Retry>>()
  for (const repository of repositories) {
    retries[repository] = { ...state.get(KV.github.retries(repository)) }
    items.set(repository, new Map(Object.entries(retries[repository]!).map(([number, retry]) => [Number(number), retry])))
  }
  const count = new Map<string, number>()
  // Failed items from the previous round run first, followed by newly notified items in chronological order; each is read once.
  for (const notification of notifications.reverse()) {
    const repository = repositories.find(name => sameName(notification.repository.full_name, name))
    if (!repository) continue
    const address = githubAddress(notification.subject.url ?? '', repository)
    if (!address || address.discussion) continue
    count.set(repository, (count.get(repository) ?? 0) + 1)
    const own = items.get(repository)!
    if (own.has(address.number)) continue
    own.set(address.number, { since: [state.get(KV.github.cursor(repository, address.number)) ?? since[repository]!, since[repository]!].sort().at(-1)!, pr: address.pr })
  }
  for (const [repository, own] of items) {
    const repositoryRetries = retries[repository]!
    for (const [number, item] of own) {
      if (stopped(ctx, round)) return { count, interval }
      round.read.add(threadId(repository, number))
      try {
        await readNotified(ctx, round, repository, number, item)
        delete repositoryRetries[number]
      } catch (error) {
        if (stopped(ctx, round)) return { count, interval }
        const retry = { ...item, failedAt: item.failedAt ?? round.started, attempts: (item.attempts ?? 0) + 1 }
        // Abandon notification retries after 24 hours of failures so a permanently unreadable thread does not hold source health in error; its cursor stays so a later notification or thread poll still reads what was missed.
        const abandoned = Date.parse(round.started) - Date.parse(retry.failedAt) >= RETRY_WINDOW_MS
        failed(ctx, round, repository, number, error, abandoned)
        if (!deleted(error) && !abandoned) { repositoryRetries[number] = retry; continue }
        delete repositoryRetries[number]
      }
    }
  }
  ctx.atomic(() => {
    for (const repository of repositories) {
      state.set(KV.github.since(repository), cursorAt(round.started))
      state.set(KV.github.retries(repository), retries[repository]!)
    }
  })
  return { count, interval }
}
async function readNotified(ctx: SourceContext, round: Round, repository: string, number: number, item: Retry): Promise<void> {
  const { since } = item
  const commands = ctx.commands.withSignal(round.signal).forRepository(repository)
  let isPr = item.pr
  if (!isPr) {
    const issue = await commands.api(IssueSchema, `issues/${number}`)
    // `issues/<n>` also returns PRs with `pull_request` set; handle them in the PR branch below.
    isPr = !!issue.pull_request
    if (!isPr) {
      // An Issue opened by someone other than the agent since the cursor brings its body so a mention in it reaches the gate.
      // A mention added by a later edit to the body is not read: only the author can be the actor of the body.
      const { login } = ctx.deployment.github
      const opened = Date.parse(issue.created_at) >= Date.parse(since) && (ctx.config<GithubConfig>(SOURCE)?.receiveOwnIssues || !sameName(issue.user.login, login))
      if (opened) await ctx.receive(issueTrigger(issue, login, repository))
      await intakeComments(ctx, round, { repository, number, isPr: false, url: issue.html_url }, since)
      nameThread(ctx, repository, number, issue.title)
    }
  }
  if (isPr) {
    const pr = await pull(ctx, round, repository, number)
    // Emit a PR description trigger for PRs opened since the cursor; its ID is the same as the one produced by the repository PR stream.
    const { login } = ctx.deployment.github
    if (pr.created_at && Date.parse(pr.created_at) >= Date.parse(since) && !sameName(pr.user.login, login)) {
      const opened = { number, title: pr.title ?? '', body: pr.body, user: pr.user, created_at: pr.created_at, html_url: pr.html_url }
      await ctx.receive(pullTrigger(opened, login, repository))
    }
    await intakeComments(ctx, round, { repository, number, isPr: true, url: pr.html_url, prAuthor: pr.user.login }, since)
    if (pr.title) nameThread(ctx, repository, number, pr.title)
  }
  ctx.state.set(KV.github.cursor(repository, number), cursorAt(round.started))
  ctx.threads.patch(threadKeyOf(repository, number), { pollError: undefined })
}
/** Reads and observes a PR at most once per polling round. */
function pull(ctx: SourceContext, round: Round, repository: string, number: number): Promise<Pull> {
  const id = threadId(repository, number)
  let read = round.pulls.get(id)
  if (!read) {
    read = readPull(ctx, repository, number, round.signal).then(async pr => { await observePull(ctx, pr); return pr })
    round.pulls.set(id, read)
  }
  return read
}
async function intakeComments(ctx: SourceContext, round: Round, ref: PullRef, since: string): Promise<void> {
  const commands = ctx.commands.withSignal(round.signal).forRepository(ref.repository)
  const { login } = ctx.deployment.github
  const kinds = ref.isPr ? ['conversation', 'inline', 'review'] as const : ['conversation'] as const
  for (const kind of kinds) {
    const suffix = `&since=${encodeURIComponent(since)}`
    const path = kind === 'conversation' ? `issues/${ref.number}/comments?per_page=100${suffix}` : kind === 'inline' ? `pulls/${ref.number}/comments?per_page=100${suffix}` : `pulls/${ref.number}/reviews?per_page=100`
    const comments = await commands.pages(CommentSchema, path, round.tally)
    for (const comment of comments) {
      // Stopping mid-read throws so the thread's cursor stays where it was.
      if (stopped(ctx, round)) throw new Error('The GitHub Source stopped during the poll')
      const timestamp = Date.parse(comment.updated_at ?? comment.submitted_at ?? comment.created_at ?? '')
      if (!Number.isFinite(timestamp) || timestamp < Date.parse(since)) continue
      if (sameName(comment.user.login, login)) continue
      // A review decision without a body still reaches the ticket: a worker may be waiting for that approval.
      const trigger = commentTrigger(comment, ref, kind, login)
      if (trigger.text) await ctx.receive(trigger)
    }
  }
}
export async function pollTicketPulls(ctx: SourceContext, signal?: AbortSignal, round = newRound(signal)): Promise<void> {
  // The PRs of open tickets are read in the repository each ticket belongs to.
  const pulls = new Map<string, FollowedPull>()
  for (const ticket of ctx.tickets.open()) for (const pull of pullsOf(ticket, true)) pulls.set(threadId(pull.repository, pull.number), pull)
  for (const { repository, number } of pulls.values()) {
    if (stopped(ctx, round)) return
    try {
      const pr = await pull(ctx, round, repository, number)
      if (pr.state !== 'closed' && !pr.merged) await pollChecks(ctx, round, number, pr)
    } catch (error) { if (!stopped(ctx, round)) failed(ctx, round, repository, number, error) }
  }
}
/** Polls a PR's CI checks; only changes after the first baseline observation become Triggers. */
async function pollChecks(ctx: SourceContext, round: Round, number: number, pr: Pull): Promise<void> {
  const commands = ctx.commands.withSignal(round.signal).forRepository(pr.repository)
  const snapshot = await pullChecks(commands, pr.head.sha, round.tally)
  const fingerprint = key(JSON.stringify(snapshot))
  const previous = ctx.state.get(KV.github.ci(pr.repository, number))
  if (previous?.fingerprint === fingerprint) return
  const revision = previous ? previous.revision + 1 : 0
  if (previous) await ctx.receive(ciTrigger(pr, revision, ciSummary(snapshot, `PR #${number}`, `github/pulls/${number}/checks`)))
  ctx.state.set(KV.github.ci(pr.repository, number), { fingerprint, revision })
  ctx.threads.describe(threadKeyOf(pr.repository, number), { facts: { ci: ciFact(ciCounts(snapshot)) } })
}
function nameThread(ctx: SourceContext, repository: string, number: number, title: string): void {
  ctx.threads.patch(threadKeyOf(repository, number), { title })
  ctx.threads.describe(threadKeyOf(repository, number), { label: `#${number} ${title}`, facts: { number: { value: `#${number}` }, repository: { value: repository } } })
}
/** Polls subscribed Issue and PR Threads not already read in this round; a deleted (410) Issue is still polled within the horizon (costing one read) and does not fail the round. */
export async function pollThreads(ctx: SourceContext, signal?: AbortSignal, round = newRound(signal)): Promise<void> {
  await pollEach(ctx, SOURCE, () => stopped(ctx, round), async thread => {
    try { await pollThread(ctx, round, thread) }
    catch (error) {
      if (stopped(ctx, round)) throw error
      if (deleted(error)) round.dropped.push(thread.ref.id); else round.failures.push(`${thread.key}: ${String(error)}`)
      throw error
    }
  }, thread => round.read.has(thread.ref.id))
}
async function pollThread(ctx: SourceContext, round: Round, thread: Thread): Promise<void> {
  // Every GitHub Thread id names its repository; an unqualified id from an older database is a foreign key violation.
  const repository = threadRepository(thread.ref.id)
  const rest = thread.ref.id.slice(thread.ref.id.indexOf('#') + 1)
  // The default branch's CI Thread has no Issue or PR to read; its CI arrives as Triggers.
  if (rest.startsWith('ci:')) return
  const number = Number(rest)
  if (!Number.isInteger(number) || number <= 0) throw new Error('Subscribed thread has no GitHub issue or PR number')
  round.read.add(thread.ref.id)
  const commands = ctx.commands.withSignal(round.signal).forRepository(repository)
  if (typeof thread.meta.isPr !== 'boolean' || typeof thread.meta.title !== 'string') {
    const issue = await commands.api(IssueSchema, `issues/${number}`)
    ctx.threads.patch(thread.key, { number, isPr: !!issue.pull_request, url: issue.html_url, repository })
    if (issue.title) nameThread(ctx, repository, number, issue.title)
    thread = ctx.threads.get(thread.key) ?? thread
  }
  const checkpoint = KV.github.cursor(repository, number)
  const since = ctx.state.get(checkpoint) ?? thread.createdAt
  if (thread.meta.isPr === true) {
    const pr = await pull(ctx, round, repository, number)
    await intakeComments(ctx, round, { repository, number, isPr: true, url: pr.html_url, prAuthor: pr.user.login }, since)
  } else await intakeComments(ctx, round, { repository, number, isPr: false }, since)
  ctx.state.set(checkpoint, cursorAt(round.started))
}
