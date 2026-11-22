/**
 * One host, several repositories: the settings list, qualified Thread ids and Triggers, per-repository polling state,
 * the worker environment, pull-request ownership, and the schema 12 migration.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Store } from '../src/app/store.ts'
import { KV } from '../src/kv.ts'
import { GithubAccountsSchema, repositoriesOf, resolveDeployment, type Machine } from '../src/deployment.ts'
import { Commands } from '../src/infra/commands.ts'
import { SettingsSchema } from '../src/policy.ts'
import { githubKind, pollRound, type GithubConfig } from '../src/sources/github.ts'
import { agentPull, pullEndNotices, repositoryOfTicket } from '../src/sources/github-pull.ts'
import { branchCiTrigger, commentTrigger, issueTrigger, repositoryOfThread, threadId, threadRepository, type PullRef } from '../src/sources/github-trigger.ts'
import type { SourceContext } from '../src/sources/host.ts'
import type { Ticket, Trigger } from '../src/core/index.ts'
import { testDeployment } from './fixtures/deployment.ts'

const PRIMARY = 'acme/widgets', SECOND = 'acme/gadgets'
const deployment = testDeployment({ repository: PRIMARY, repositories: [PRIMARY, SECOND] })
let directory: string
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'multi-repository-')) })
afterEach(() => { vi.restoreAllMocks(); rmSync(directory, { recursive: true, force: true }) })

const machine = (): Machine => ({ ...testDeployment(), stateDir: join(directory, 'state') })
/** A GitHub CLI stand-in that reports one account and push access to every repository it is asked about. */
const probe = async (argv: string[]): Promise<string> => {
  const asked = argv.find(arg => arg.startsWith('repos/'))
  return JSON.stringify(argv.includes('user') ? { login: 'agent-bot', id: 7 } : { name: asked?.slice('repos/'.length), push: true })
}
const issue = (number: number) => ({ id: number, number, title: `Issue ${number}`, state: 'open', created_at: new Date(Date.now() + 60_000).toISOString(),
  html_url: `https://github.com/${PRIMARY}/issues/${number}`, user: { login: 'alice', type: 'User' }, body: 'please fix' })

describe('the settings list', () => {
  it('splits on commas, spaces and newlines, keeps the typed spelling and order, and collapses a repeated entry', () => {
    expect(repositoriesOf(' acme/widgets, Acme/Gadgets\nthird/repo  ')).toEqual(['acme/widgets', 'Acme/Gadgets', 'third/repo'])
    expect(repositoriesOf('acme/widgets Acme/Widgets')).toEqual(['acme/widgets'])
    expect(repositoriesOf(' , \n ')).toEqual([])
    expect(GithubAccountsSchema.parse({ repository: 'acme/widgets, acme/gadgets' }).repository).toBe('acme/widgets, acme/gadgets')
    expect(GithubAccountsSchema.parse({}).repository).toBe('')
  })
  it('rejects an entry that is not owner/name', () => {
    expect(() => GithubAccountsSchema.parse({ repository: 'acme/widgets acme' })).toThrow(/owner\/name entries: acme/)
    expect(() => GithubAccountsSchema.parse({ repository: 'acme/widgets/extra' })).toThrow(/owner\/name entries/)
  })
  it('resolves every repository, in order, with the first as the primary one', async () => {
    const resolved = await resolveDeployment(machine(), { repository: `${PRIMARY}\n${SECOND}`, cli: 'sh' }, probe)
    expect(resolved.repositories).toEqual([PRIMARY, SECOND])
    expect(resolved.repository).toBe(PRIMARY)
    // A single repository keeps working exactly as before.
    const single = await resolveDeployment(machine(), { repository: PRIMARY, cli: 'sh' }, probe)
    expect(single.repositories).toEqual([PRIMARY])
    expect(single.repository).toBe(PRIMARY)
  })
  it('fails setup with a named problem when the list is empty', async () => {
    await expect(resolveDeployment(machine(), { repository: ' , ', cli: 'sh' }, probe))
      .rejects.toMatchObject({ problem: expect.objectContaining({ code: 'repositoryUnset' }) })
  })
})

describe('thread identity', () => {
  it('qualifies an Issue, a comment and a branch CI with their repository', () => {
    expect(threadId(PRIMARY, 7)).toBe(`${PRIMARY}#7`)
    expect(issueTrigger(issue(7), 'agent-bot', PRIMARY).threads).toEqual([{ source: 'github', id: `${PRIMARY}#7` }])
    const ref: PullRef = { repository: SECOND, number: 7, isPr: true }
    expect(commentTrigger({ id: 3, body: 'x', user: { login: 'alice', type: 'User' } }, ref, 'conversation', 'agent-bot').threads)
      .toEqual([{ source: 'github', id: `${SECOND}#7` }])
    expect(branchCiTrigger(SECOND, 'main', 'abc', 1, 'CI', 'u').threads).toEqual([{ source: 'github', id: `${SECOND}#ci:main` }])
    expect(repositoryOfThread(`${SECOND}#ci:main`)).toBe(SECOND)
    expect(repositoryOfThread('7')).toBeUndefined()
    // A number-only Thread id from before schema 12 is a foreign key violation rather than a guess.
    expect(() => threadRepository('7')).toThrow(/names no repository/)
  })
  it('gives the same number in two repositories two Triggers that never deduplicate', () => {
    const first = issueTrigger(issue(7), 'agent-bot', PRIMARY)
    const second = issueTrigger(issue(7), 'agent-bot', SECOND)
    expect(first.id).not.toBe(second.id)
    expect(first.threads[0]!.id).not.toBe(second.threads[0]!.id)
  })
})

describe('polling one repository at a time', () => {
  const host = () => {
    const store = new Store(join(directory, 'db.sqlite'))
    store.saveSettings(SettingsSchema.parse({ sources: { github: { enabled: true,
      config: { repository: `${PRIMARY},${SECOND}`, cli: 'gh', observeIssues: true } } } }))
    const commands = new Commands(() => deployment, {}, new AbortController().signal)
    const received: Trigger[] = []
    const health: Record<string, unknown> = {}
    const context: SourceContext = {
      deployment, commands, ready: Promise.resolve(), configured: () => true,
      config: <C extends Record<string, unknown>>() => githubKind.schema.parse({ repository: `${PRIMARY},${SECOND}`, cli: 'gh',
        observeIssues: true }) as unknown as C,
      receive: async trigger => { received.push(trigger); return 'stored' as const },
      atomic: work => store.atomic(work),
      state: { get: name => store.get(name), set: (name, value) => { if (value === undefined) store.delete(name); else store.set(name, value) },
        keys: prefix => store.keys(prefix) },
      threads: { get: key => store.threads.get(key), subscribed: source => store.read.subscribedThreads(source),
        describe: (key, description) => store.threads.describe(key, description), patch: (key, meta) => store.threads.patchMeta(key, meta) },
      tickets: { get: id => store.tickets.get(id), open: () => store.tickets.open(), bindThread: () => {}, threadClosed: () => {} },
      triggers: { get: id => store.triggers.get(id), latest: thread => store.read.threadTriggers(thread, 1)[0] },
      notify: () => {}, report: (entry, value) => { health[entry] = value },
    }
    // Widgets' issues read fails; gadgets' succeeds. Each repository keeps its own cursor.
    const state = { failing: true }
    vi.spyOn(Commands.prototype, 'run').mockImplementation(async (_program, args) => {
      const path = args[1]!
      if (path.includes('/notifications')) return `${args.includes('--include') ? 'HTTP/2.0 200 OK\r\n\r\n' : ''}[]`
      if (state.failing && path.includes(`repos/${PRIMARY}/issues?`)) throw new Error('widgets is unavailable')
      if (path.includes(`repos/${SECOND}/issues?`)) return `HTTP/2.0 200 OK\r\n\r\n${JSON.stringify([issue(7)])}`
      if (path.includes(`repos/${PRIMARY}/issues?`)) return 'HTTP/2.0 200 OK\r\n\r\n[]'
      return JSON.stringify(args.includes('--slurp') ? [[]] : [])
    })
    return { store, context, received, health, state }
  }
  it('steps one repository\'s cursor while another repository\'s read fails, and names each in health', async () => {
    const h = host()
    await expect(pollRound(h.context)).rejects.toThrow(/widgets is unavailable/)
    expect(h.store.get(KV.github.stream(SECOND, 'issues'))).toMatchObject({ since: expect.any(String) })
    expect(h.store.get(KV.github.stream(PRIMARY, 'issues'))).toBeUndefined()
    // The successful repository's Trigger naming is its own repository's.
    expect(h.received.map(trigger => trigger.threads[0]!.id)).toEqual([`${SECOND}#7`])
    // Both repositories own a notification cursor, and health names each one's own count.
    expect(h.store.get(KV.github.since(PRIMARY))).toBeDefined()
    expect(h.store.get(KV.github.since(SECOND))).toBeDefined()
    // Once the failing repository answers again, each repository's line names its own count.
    h.state.failing = false
    await pollRound(h.context)
    expect((h.health.github as { detail: string }).detail.split('\n')).toEqual([
      `${PRIMARY}: 0 notifications; next poll ≥ 60s`, `${SECOND}: 0 notifications; next poll ≥ 60s`])
    h.store.close()
  })
})

describe('a ticket knows its repository', () => {
  it('reads and writes in the ticket\'s own repository through a bound command object', async () => {
    const commands = new Commands(() => deployment, {}, new AbortController().signal)
    await expect(commands.api('issues/7')).rejects.toThrow('must name its repository')
    const scoped = commands.forRepository(SECOND)
    const run = vi.spyOn(scoped, 'run').mockResolvedValue('{}')
    await scoped.api('issues/7')
    expect(run).toHaveBeenCalledWith('/bin/false', ['api', `repos/${SECOND}/issues/7`])
  })
  it('carries the ticket\'s repository into the worker environment', () => {
    const values = (trigger?: Trigger) => githubKind.environment!.values({ deployment, config: {} as GithubConfig, ...trigger ? { trigger } : {} })
    expect(values(issueTrigger(issue(7), 'agent-bot', SECOND)).DSH_SUPERAGENT_GITHUB_REPOSITORY).toBe(SECOND)
    // A ticket that did not start on GitHub falls back to the primary repository.
    expect(values().DSH_SUPERAGENT_GITHUB_REPOSITORY).toBe(PRIMARY)
  })
  it('judges a pull request and writes its commit and page links in the ticket\'s repository', () => {
    const pull = { repository: SECOND, number: 5, state: 'open', html_url: `https://github.com/${SECOND}/pull/5`, user: { login: 'agent-bot' },
      head: { sha: 'abc', ref: 'agent/fix', repo: { full_name: SECOND } } }
    expect(agentPull(pull, deployment, SECOND)).toBe(true)
    // The same number in the other repository is another pull request, not this ticket's.
    expect(agentPull(pull, deployment, PRIMARY)).toBe(false)
    const ticket = { id: 't', title: 'Fix', decisionId: 'd', mandate: { strength: 'explicit', policyVersion: '', basis: { via: 'listed' },
      actor: { source: 'feishu', id: 'ou_a' }, scope: '' }, channels: [{ source: 'feishu', thread: 'feishu:oc_1',
      address: { chatId: 'oc_1', messageId: 'om_1' } }], assignments: [], inputs: [], undelivered: [], createdAt: '', updatedAt: '',
    origin: { triggerId: 'x', triggerIds: [] },
    follows: [{ thread: `github:${SECOND}#5`, own: true, closed: { at: '2026-09-01T00:00:00Z', outcome: 'merged' as const } }],
    ended: { at: '2026-09-01T00:00:00Z', by: 'executor' as const, outcome: 'merged' as const } } satisfies Ticket
    expect(pullEndNotices(ticket, 'fix it', SECOND)[0]!.text).toContain(`https://github.com/${SECOND}/pull/5`)
    const trigger: Trigger = { ...issueTrigger(issue(5), 'agent-bot', SECOND), meta: { number: 5, isPr: true, kind: 'pull' } }
    expect(repositoryOfTicket({ triggers: { get: () => trigger }, deployment }, ticket)).toBe(SECOND)
  })
})

describe('the schema 12 migration', () => {
  /** A schema 11 database with a number-only GitHub Thread, Trigger, Ticket, Decision and outbox receipt. */
  const schema11 = (): string => {
    const path = join(directory, 'schema11.sqlite')
    const store = new Store(path)
    store.saveSettings({ sources: { github: { enabled: true, config: { repository: PRIMARY, cli: 'gh' } } } })
    store.set(KV.store.schema, 11)
    const thread = { key: 'github:7', ref: { source: 'github', id: '7' }, createdAt: '', subscriptions: ['t1'], correlated: [], pending: [], meta: {} }
    store.db.prepare('INSERT INTO thread VALUES (?,?)').run(thread.key, JSON.stringify(thread))
    const trigger = { id: 'issue', source: 'github', threads: [{ source: 'github', id: '7' }], actor: { source: 'github', id: 'alice' },
      human: true, at: '2026-09-01T00:00:00.000Z', text: 'fix', meta: {} }
    store.db.prepare('INSERT INTO trigger VALUES (?,?,?)').run(trigger.id, JSON.stringify(trigger), trigger.at)
    store.db.prepare('INSERT INTO trigger_thread VALUES (?,?,?,?)').run('github:7', trigger.id, trigger.at, 1)
    const ticket = { id: 't1', title: 'Fix', decisionId: 'd1', mandate: { strength: 'explicit', policyVersion: '', basis: { via: 'listed' },
      actor: { source: 'github', id: 'alice' }, scope: '' }, channels: [{ source: 'github', thread: 'github:7', address: { number: '7' } }],
    assignments: [], inputs: [], undelivered: [], createdAt: '', updatedAt: '', origin: { triggerId: trigger.id, triggerIds: [trigger.id] },
    follows: [{ thread: 'github:7', own: true }] }
    store.db.prepare('INSERT INTO ticket VALUES (?,?)').run(ticket.id, JSON.stringify(ticket))
    const decision = { id: 'd1', evalId: 'e1', threadKey: 'github:7', triggerIds: [trigger.id], policyVersion: '', at: '', kind: 'accept',
      reason: [], strength: 'explicit' }
    store.db.prepare('INSERT INTO decision VALUES (?,?,?)').run(decision.id, decision.threadKey, JSON.stringify(decision))
    const receipt = { id: 'r1', channel: { source: 'github', thread: 'github:7', address: { number: '7' } }, text: 'Done', kind: 'reply', status: 'sent' }
    store.db.prepare('INSERT INTO outbox VALUES (?,?)').run(receipt.id, JSON.stringify(receipt))
    store.close()
    return path
  }
  it('prefixes every number-only Thread id with the primary repository, and keeps Trigger and Ticket ids', () => {
    const store = new Store(schema11())
    const key = `${PRIMARY}#7`
    expect(store.get(KV.store.schema)).toBe(12)
    expect(store.threads.get(`github:${key}`)).toMatchObject({ ref: { source: 'github', id: key }, subscriptions: ['t1'] })
    expect(store.threads.get('github:7')).toBeUndefined()
    expect(store.triggers.get('issue')).toMatchObject({ id: 'issue', threads: [{ source: 'github', id: key }] })
    // The Thread index the timeline reads follows the Trigger.
    expect(store.db.prepare("SELECT thread FROM trigger_thread WHERE id = 'issue'").all()).toEqual([{ thread: `github:${key}` }])
    expect(store.tickets.get('t1')).toMatchObject({ follows: [{ thread: `github:${key}`, own: true }],
      channels: [{ source: 'github', thread: `github:${key}`, address: { number: '7' } }] })
    expect(store.decisions.get('d1')!.threadKey).toBe(`github:${key}`)
    expect(store.receipts.get('r1')!.channel.thread).toBe(`github:${key}`)
    store.close()
  })
  it('fails loudly instead of guessing when a stored Thread id names no repository', () => {
    const path = join(directory, 'schema12.sqlite')
    const store = new Store(path)
    store.saveSettings({ sources: { github: { enabled: true, config: { repository: PRIMARY, cli: 'gh' } } } })
    store.db.prepare('INSERT INTO thread VALUES (?,?)').run('github:9', JSON.stringify({ key: 'github:9', ref: { source: 'github', id: '9' },
      createdAt: '', subscriptions: ['t1'], correlated: [], pending: [], meta: {} }))
    store.close()
    const reopened = new Store(path)
    const ticket = { origin: { triggerId: 'x', triggerIds: [] }, follows: [{ thread: 'github:9', own: true }] }
    expect(() => repositoryOfTicket({ triggers: { get: () => undefined }, deployment }, ticket)).toThrow(/names no repository/)
    reopened.close()
  })
})
