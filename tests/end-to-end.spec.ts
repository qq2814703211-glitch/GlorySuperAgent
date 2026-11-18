/**
 * A ticket through the standalone host and the Claude Code CLI, from the request to the worker's report.
 *
 * This is the whole chain in one test: the host boots with the CLI behind it, a request arrives, the router accepts it, the
 * worker runs in its own directory, and the worker's report reaches the ticket.
 *
 * The GitHub CLI is a fake script, so the test needs no account and no network. The Claude Code CLI is the real one, so the
 * test is skipped where it is not installed or not signed in.
 */
import { execFile } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import { startStandalone, type Standalone } from '../src/standalone.ts'
import { SettingsSchema } from '../src/policy.ts'
import type { Trigger } from '../src/core/index.ts'

const run = promisify(execFile)
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
/** The `claude` binary, when this machine has one. */
const CLAUDE = ['/opt/homebrew/bin/claude', '/usr/local/bin/claude', '/usr/bin/claude'].find(path => existsSync(path))

/** Whether the CLI is signed in, which a turn needs. */
async function signedIn(): Promise<boolean> {
  if (!CLAUDE) return false
  const { stdout } = await run(CLAUDE, ['-p', 'Reply with the word ok.', '--output-format', 'stream-json'], {
    cwd: process.env.TMPDIR ?? '/tmp', timeout: 120_000, encoding: 'utf8',
  }).catch((error: { stdout?: string }) => ({ stdout: error.stdout ?? '' }))
  return !stdout.includes('authentication_failed')
}

let running: Standalone | undefined
const directories: string[] = []
afterEach(async () => {
  await running?.stop()
  running = undefined
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

/**
 * A GitHub CLI that answers what setup asks for: the account, and the repository with push access.
 *
 * It is a real script, so the host's own subprocess service runs it as it would the operator's CLI.
 */
function fakeGithub(directory: string): string {
  const file = join(directory, 'gh')
  writeFileSync(file, `#!/bin/sh
case "$2" in
  user) echo '{"login":"agent-bot","id":7}' ;;
  repos/*) echo '{"name":"acme/widgets","push":true}' ;;
  *) echo '{}' ;;
esac
`, { mode: 0o755 })
  return file
}

/** A request from a person on a chat channel. */
function request(id: string): Trigger {
  return { id, source: 'feishu', threads: [{ source: 'feishu', id: 'oc_team:om_root' }],
    actor: { source: 'feishu', id: 'ou_alice' }, human: true, addressed: 'mention',
    text: `${process.env.SA_E2E_HARNESS ? `[${process.env.SA_E2E_HARNESS}] ` : ''}@bot fix the failing test`, at: new Date().toISOString(),
    meta: { chatId: 'oc_team', messageId: 'om_root', mentioned: true } }
}

it.skipIf(!CLAUDE)('runs a ticket from the request to the worker\'s report', async () => {
  if (!await signedIn()) return
  const directory = mkdtempSync(join(tmpdir(), 'superagent-e2e-'))
  directories.push(directory)
  const stateDir = join(directory, 'state')
  const cli = fakeGithub(directory)
  // The route the host itself is configured with, so the test does not depend on the CLI's own default (which on a
  // gateway machine can be a model nobody serves); SA_TEST_CLI_MODEL overrides it.
  const table = JSON.parse(readFileSync(join(ROOT, 'harnesses.json'), 'utf8'))
  // The suite's own route first: it is the one chosen for tool-following, and this test asks the worker to do work.
  const model = process.env.SA_TEST_CLI_MODEL ?? table.tests?.model ?? table.router?.model
  // With a harness named, the ticket runs that CLI instead: the same chain, a different worker.
  // SA_E2E_DEFAULT runs the table's own default instead, so a change to default harness is covered by a real turn.
  const harness = process.env.SA_E2E_HARNESS
  const useDefault = process.env.SA_E2E_DEFAULT === '1'
  const host = running = await startStandalone({ stateDir, port: 0, cli: { command: CLAUDE!, ...model ? { model } : {} },
    ...harness ? { harnesses: table.harnesses, defaultHarness: harness }
      : useDefault ? { harnesses: table.harnesses, defaultHarness: table.default } : {} })
  const runtime = host.runtime

  // The host starts without a repository, and says so.
  expect(runtime.configured()).toBe(false)
  expect(runtime.setupProblem?.code).toBe('repositoryUnset')

  // The operator configures the GitHub Source in the panel. The change is saved, and the host restarts to run setup again.
  const settings = runtime.store.settings()
  runtime.store.saveSettings(SettingsSchema.parse({
    ...settings,
    eval: { ...settings.eval, mode: 'auto' },
    policy: { ...settings.policy, sources: { ...settings.policy.sources,
      feishu: { allowed: [{ id: 'ou_alice', name: 'Alice' }], syncChat: 'oc_team' } } },
    sources: { ...settings.sources,
      github: { enabled: true, config: { repository: 'acme/widgets', cli } },
      feishu: { enabled: true, config: { cli: '', chats: [{ chatId: 'oc_team', listen: 'all' }], directMessages: true } } },
    executor: { ...settings.executor, prepare: `mkdir -p work && cd work && git init -q . && echo '# fixture' > README.md` },
  }))
  // The restart rebuilds the runtime, which runs setup with the new settings.
  await host.restart()
  expect(host.runtime.configured()).toBe(true)

  // The request reaches the engine as a candidate, and the router receives its card.
  const received = host.runtime.receive(request('trigger-1'))
  await host.runtime.idle()
  expect(received).toBe('stored')
  const candidate = host.runtime.engine.candidate('trigger-1')
  expect(candidate).toBeDefined()
  // A person's explicit request is routed, not assessed.
  expect(candidate!.strength).toBe('explicit')

  // The router accepts it, which creates the ticket and starts the worker.
  const decision = host.runtime.engine.decide('trigger-1', { kind: 'accept', title: 'Fix the failing test', scope: 'Fix the failing test',
    reason: { code: 'explicitRouted' }, acknowledgement: 'Fixing the failing test.', name: 'fix-test' })
  expect(decision.kind).toBe('accept')
  const ticketId = decision.ticketId!
  expect(ticketId).toBeTruthy()
  // The ticket kept the harness its request named, which is what the worker turn runs.
  if (harness) expect(host.runtime.store.tickets.get(ticketId)!.harness).toBe(harness)

  // The ticket has a workspace of its own, which the prepare command created.
  const ticket = host.runtime.store.tickets.get(ticketId)!
  expect(ticket.execution?.directory).toBeTruthy()
  expect(ticket.execution!.directory).toContain('fix-test')

  // The worker launches in that workspace and the CLI runs there.
  await vi.waitFor(() => {
    expect(host.runtime.store.tickets.get(ticketId)!.assignments.length).toBeGreaterThan(0)
  }, { timeout: 60_000, interval: 500 })
  // The worker launches in that workspace and the CLI runs there.
  await vi.waitFor(() => {
    expect(host.runtime.runner.get(`worker-${ticketId}`)).toBeDefined()
  }, { timeout: 90_000, interval: 500 })
  // The worker's session exists, and it is the CLI's.
  const worker = host.runtime.runner.get(`worker-${ticketId}`)
  expect(worker).toBeDefined()
  // The CLI ran in the ticket's directory, not in the host's.
  expect((worker as unknown as { cwd: string }).cwd).toBe(ticket.execution!.directory)

  // The worker's tools are the engine's own, and the CLI can call them: the report reaches the ticket.
  // Wait for the report to exist, not for its text: the summary is the model's own writing, and a route may answer the
  // fixture ticket with an empty one. What the wait proves is that the worker's tool call reached the ticket.
  await vi.waitFor(() => {
    const report = host.runtime.store.tickets.get(ticketId)!.assignments.at(-1)?.report
    expect(report).toBeTruthy()
  }, { timeout: Number(process.env.SA_TEST_REPORT_TIMEOUT ?? 240_000), interval: 1000 })
  const report = host.runtime.store.tickets.get(ticketId)!.assignments.at(-1)!.report!
  // The worker reported through the engine's tool, so the ticket knows what happened.
  // A failed turn is recorded as a report too, so the state is what distinguishes the worker's own result. A harness
  // run on the fixture repository has nothing to fix, and reporting that honestly is the chain working.
  if (process.env.SA_DEBUG_REPORT) console.log('REPORT', JSON.stringify(report))
  // Which state the worker picks is its own judgement of a fixture ticket with nothing to fix; what the test proves is
  // that the report came from the worker's tool call, and `failed` is the state the host writes when the turn itself dies.
  expect(['ready', 'blocked', 'progress', 'waiting']).toContain(report.state)
  // The summary is the model's own text; a route can answer a fixture ticket with an empty one, and what this test
  // proves is that the worker's tool call reached the ticket at all.
  expect(typeof report.summary).toBe('string')
}, 300_000)
