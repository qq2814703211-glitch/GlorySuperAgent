/**
 * A harness runs under the profile the host builds for it.
 *
 * A CLI that works outside the sandbox can still fail inside it: the profile denies the home directory, so a harness
 * needs its own state and its interpreter named in `readable`, and a profile that misses one turns a working CLI into a
 * turn that fails with EACCES. This builds the real policy and starts the real command, so what it reports is what a
 * ticket would get.
 *
 * The turn costs a model call, so it runs only when asked: `SA_HARNESS_PROBE=antigravity pnpm vitest run tests/harness-sandbox.spec.ts`
 */
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { policyFor } from '../src/sandbox/index.ts'
import { seatbeltProfile } from '../src/sandbox/seatbelt.ts'
import { readHarnessTable } from '../src/host/harness-table.ts'

const run = promisify(execFile)
const root = dirname(dirname(fileURLToPath(import.meta.url)))
const harness = process.env.SA_HARNESS_PROBE
const table = harness ? readHarnessTable(join(root, 'harnesses.json')) : undefined
const entry = harness ? table?.harnesses?.[harness] : undefined
const sandbox = existsSync('/usr/bin/sandbox-exec')

it.skipIf(!harness || !entry || !sandbox)(`runs the ${harness} harness inside the host's seatbelt profile`, async () => {
  if (!entry || !harness) return
  const stateDir = join(homedir(), '.superagent')
  const workspace = join(stateDir, 'probe-workspace')
  mkdirSync(workspace, { recursive: true })
  const policy = policyFor({ workspace, stateDir, command: entry.command, extras: { readable: entry.readable ?? [] },
    ...entry.state ? { cliState: entry.state } : {} })
  const argv: [string, ...string[]] = ['/usr/bin/sandbox-exec', '-p', seatbeltProfile(policy), entry.command, ...(entry.args ?? []),
    ...(harness === 'claude' ? ['-p', 'Reply with exactly: SANDBOX_OK', '--output-format', 'json']
      : harness.startsWith('antigravity') ? ['-p', 'Reply with exactly: SANDBOX_OK', '--output-format', 'json',
        ...(entry.model ? ['--model', entry.model] : [])]
      : ['-p', 'Reply with exactly: SANDBOX_OK', '--output-format', 'stream-json'])]
  // Dumping the profile and the command line makes a failing harness debuggable without rerunning the suite.
  if (process.env.SA_HARNESS_DUMP) {
    writeFileSync(`/tmp/sa-profile-${harness}.json`, JSON.stringify({ profile: seatbeltProfile(policy), argv, workspace }, null, 2))
    return
  }
  const { stdout } = await run(argv[0], argv.slice(1), { cwd: workspace, timeout: 180_000, encoding: 'utf8',
    maxBuffer: 8 << 20 }).catch((error: { stdout?: string; stderr?: string }) => {
    throw new Error(`the ${harness} harness failed inside the sandbox: ${(error.stderr ?? '').slice(0, 600)}`)
  })
  expect(stdout).toContain('SANDBOX_OK')
}, 200_000)
