/**
 * The router and the worker may run different CLIs.
 *
 * The router reads text from strangers and has to prove it holds no built-in tool, which only some CLIs can do; the
 * worker runs inside the ticket's sandbox and may be any CLI that speaks the turn contract. This pins the split: an
 * orchestrator turn runs the router CLI, a worker turn runs the worker CLI, and a runner without one uses the router CLI
 * for both.
 */
import { describe, expect, it } from 'vitest'
import { ClaudeRunner } from '../src/runner/cli/claude.ts'
import type { Subprocess, SubprocessSpec } from '../src/runner/port.ts'

/** A subprocess that records the command line it was asked to run and reports an empty turn. */
function recorder(): { subprocess: Subprocess; argv: string[][] } {
  const argv: string[][] = []
  const subprocess: Subprocess = {
    spawn(spec: SubprocessSpec) {
      argv.push([...spec.argv])
      const text = `${JSON.stringify({ type: 'system', subtype: 'init', session_id: 's-1', tools: [], mcp_servers: [] })}\n`
      return {
        done: Promise.resolve({ exitCode: 0 }),
        collected: { stdout: { readFrom: () => ({ text }) }, stderr: { readFrom: () => ({ text: '' }) } },
      }
    },
  }
  return { subprocess, argv }
}

/** The message shape the runner accepts from the engine. */
const message = (id: string) => ({ id, role: 'user', content: [{ type: 'text', text: 'go' }],
  source: { kind: 'dsh-superagent' } }) as never

describe('router and worker CLIs', () => {
  it('runs the router CLI for an orchestrator turn and the worker CLI for a worker turn', async () => {
    const { subprocess, argv } = recorder()
    const runner = new ClaudeRunner({ cli: { command: '/router-cli' }, workerCli: { command: '/worker-cli' },
      subprocess, logger: { warn: () => {}, error: () => {} } })
    const router = await runner.create({ id: 'router', cwd: '/tmp', role: 'orchestrator' })
    const worker = await runner.create({ id: 'worker', cwd: '/tmp', role: 'worker' })
    await runner.deliver(router as never, message('m1'), 'queue')
    await runner.deliver(worker as never, message('m2'), 'queue')
    expect(argv.map(line => line[0])).toEqual(['/router-cli', '/worker-cli'])
    // The router still runs with its own tools taken away; that is what makes the split possible at all.
    expect(argv[0]).toContain('--tools')
    expect(argv[1]).not.toContain('--tools')
  })

  it('uses the router CLI for workers when no worker CLI is configured', async () => {
    const { subprocess, argv } = recorder()
    const runner = new ClaudeRunner({ cli: { command: '/only-cli' }, subprocess,
      logger: { warn: () => {}, error: () => {} } })
    const worker = await runner.create({ id: 'worker', cwd: '/tmp', role: 'worker' })
    await runner.deliver(worker as never, message('m1'), 'queue')
    expect(argv.map(line => line[0])).toEqual(['/only-cli'])
  })

  it('takes the model from the CLI that runs the turn', async () => {
    const { subprocess, argv } = recorder()
    const runner = new ClaudeRunner({ cli: { command: '/router-cli', model: 'router-model' },
      workerCli: { command: '/worker-cli', model: 'worker-model' }, subprocess,
      logger: { warn: () => {}, error: () => {} } })
    const worker = await runner.create({ id: 'worker', cwd: '/tmp', role: 'worker' })
    await runner.deliver(worker as never, message('m1'), 'queue')
    expect(argv[0]).toContain('worker-model')
    expect(argv[0]).not.toContain('router-model')
  })
})
