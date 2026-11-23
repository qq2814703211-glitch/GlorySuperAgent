import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ADAPTER = fileURLToPath(new URL('../grok.mjs', import.meta.url))
const execFileAsync = promisify(execFile)

/**
 * A stand-in for grok, run through SA_GROK_BIN. It records its argv and the MCP environment it was handed, then prints
 * the same lines `--output-format streaming-messages-json` prints.
 */
const FAKE = `#!/bin/sh
if [ -n "\${FAKE_ARGV_OUT:-}" ]; then printf '%s\\n' "$@" > "$FAKE_ARGV_OUT"; fi
if [ -n "\${FAKE_ENV_OUT:-}" ]; then printf '%s\\n%s\\n' "\${SA_MCP_URL:-}" "\${SA_MCP_TOKEN:-}" > "$FAKE_ENV_OUT"; fi
SESSION="\${FAKE_SESSION:-grok-session-1}"
if [ "\${FAKE_LEAD:-0}" = "1" ]; then
  printf '%s\\n' '{"type":"progress","stage":"booting"}'
fi
printf '%s\\n' '{"type":"system","subtype":"init","session_id":"'"$SESSION"'","model":"grok-4"}'
printf '%s\\n' '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"working"}]}}'
printf '%s\\n' '{"type":"user","message":{"role":"user","content":[{"type":"tool_result","content":"done"}]}}'
printf '%s\\n' '{"type":"progress","stage":"thinking"}'
if [ "\${FAKE_RESULT_ERROR:-0}" = "1" ]; then
  printf '%s\\n' '{"type":"result","subtype":"success","is_error":true,"stop_reason":"refusal","session_id":"'"$SESSION"'"}'
  exit 0
fi
printf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"stop_reason":"end_turn","session_id":"'"$SESSION"'"}'
`

/** A scratch directory holding the fake grok and the files it writes. */
async function scratch(t) {
  const root = await mkdtemp(join(tmpdir(), 'grok-adapter-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const bin = join(root, 'fake-grok')
  await writeFile(bin, FAKE, { mode: 0o755 })
  return { root, bin, argv: join(root, 'argv.txt'), env: join(root, 'env.txt') }
}

/** Runs the adapter once, against the fake grok, with the same contract flags the engine's runner sends. */
async function turn(s, args, env = {}) {
  const paths = { argvOut: join(s.root, 'argv.txt'), envOut: join(s.root, 'env.txt') }
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [ADAPTER, ...args], {
      cwd: s.root,
      env: {
        ...process.env,
        SA_GROK_BIN: s.bin,
        FAKE_ARGV_OUT: paths.argvOut,
        FAKE_ENV_OUT: paths.envOut,
        FAKE_RESULT_ERROR: '0',
        ...env,
      },
    })
    return { code: 0, stdout, stderr, ...paths }
  } catch (error) {
    return { code: error.code, stdout: error.stdout ?? '', stderr: error.stderr ?? '', ...paths }
  }
}

const events = stdout => stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
const readArgv = async file => (await readFile(file, 'utf8')).trim().split('\n')

test('a new turn takes grok\'s session id, emits it, and maps every flag', async t => {
  const s = await scratch(t)
  const first = join(s.root, 'first-dir')
  const second = join(s.root, 'second-dir')
  await mkdir(first)
  await mkdir(second)
  const { code, stdout, stderr, argvOut } = await turn(s, [
    '-p', 'hello worker', '--output-format', 'stream-json', '--verbose', '--tools', '',
    '--strict-mcp-config', '--disable-slash-commands', '--system-prompt', 'SYSTEM RULES',
    '--model', 'grok-4', '--effort', 'high', '--add-dir', first, '--add-dir', second,
    '--session-id', '11111111-2222-3333-4444-555555555555',
  ])
  assert.equal(code, 0, stderr)
  assert.equal(stderr, '')

  const lines = events(stdout)
  assert.deepEqual(lines[0], { type: 'system', subtype: 'init', session_id: 'grok-session-1', tools: [],
    mcp_servers: [{ name: 'superagent', status: 'absent' }] })
  assert.deepEqual(lines[1], { type: 'system/session', session_id: 'grok-session-1' })
  assert.equal(lines[2].type, 'assistant')
  assert.equal(lines[2].message.content[0].text, 'working')
  assert.equal(lines[3].type, 'user')
  assert.equal(lines[3].message.content[0].type, 'tool_result')
  assert.ok(lines.some(line => line.type === 'grok/progress' && line.data?.stage === 'thinking'))
  assert.ok(!lines.some(line => line.type === 'result'), 'a result is recorded, not forwarded as a turn event')

  const argv = await readArgv(argvOut)
  assert.equal(argv[argv.indexOf('-p') + 1], 'hello worker')
  assert.ok(!argv[argv.indexOf('-p') + 1].includes('SYSTEM RULES'), 'the system prompt is not folded into the prompt')
  assert.equal(argv[argv.indexOf('--rules') + 1], 'SYSTEM RULES')
  assert.equal(argv[argv.indexOf('-m') + 1], 'grok-4')
  assert.equal(argv[argv.indexOf('--reasoning-effort') + 1], 'high')
  assert.equal(argv[argv.indexOf('--output-format') + 1], 'streaming-messages-json')
  assert.ok(argv.includes('--yolo'))
  assert.ok(argv.includes('--no-auto-update'))
  assert.equal(argv[argv.indexOf('--cwd') + 1], first, 'only the first --add-dir becomes --cwd')
  assert.ok(!argv.includes(second), 'extra directories have no grok flag and are dropped')
  assert.ok(!argv.includes('--session-id'), 'the runner UUID is not sent as a grok session id')
})

test('the init event is the first line even when grok prints something before it', async t => {
  const s = await scratch(t)
  const { code, stdout, stderr } = await turn(s, ['-p', 'hello'], { FAKE_LEAD: '1' })
  assert.equal(code, 0, stderr)
  const lines = events(stdout)
  assert.equal(lines[0].type, 'system')
  assert.equal(lines[0].subtype, 'init')
  assert.equal(lines[1].type, 'grok/progress')
  assert.equal(lines[2].type, 'system/session')
})

test('--resume is forwarded as grok --resume and never as --session-id', async t => {
  const s = await scratch(t)
  const { code, stdout, stderr, argvOut } = await turn(s,
    ['-p', 'continue', '--resume', 'grok-session-9', '--session-id', 'host-assigned-uuid'],
    { FAKE_SESSION: 'grok-session-9' })
  assert.equal(code, 0, stderr)

  const argv = await readArgv(argvOut)
  assert.equal(argv.filter(arg => arg === '--resume').length, 1)
  assert.equal(argv[argv.indexOf('--resume') + 1], 'grok-session-9')
  assert.ok(!argv.includes('--session-id'))
  assert.ok(!argv.includes('-s'))

  const lines = events(stdout)
  assert.equal(lines[0].type, 'system')
  assert.equal(lines[0].session_id, 'grok-session-9')
})

test('MCP goes into the environment as SA_MCP_URL and SA_MCP_TOKEN, not into argv', async t => {
  const s = await scratch(t)
  const mcpConfig = JSON.stringify({ mcpServers: { superagent: { type: 'http', url: 'http://127.0.0.1:9/mcp',
    headers: { authorization: 'Bearer sak-test' } } } })
  const { code, stdout, stderr, argvOut, envOut } = await turn(s, ['-p', 'use tools', '--mcp-config', mcpConfig])
  assert.equal(code, 0, stderr)

  assert.deepEqual((await readFile(envOut, 'utf8')).trim().split('\n'), ['http://127.0.0.1:9/mcp', 'sak-test'])
  const argv = await readArgv(argvOut)
  assert.ok(!argv.some(arg => arg.includes('sak-test')), 'the token never reaches argv')
  const lines = events(stdout)
  assert.deepEqual(lines[0].mcp_servers, [{ name: 'superagent', status: 'connected' }])
  assert.deepEqual(lines[0].tools, [])
})

test('a result with is_error true ends the turn non-zero', async t => {
  const s = await scratch(t)
  const { code, stderr } = await turn(s, ['-p', 'fail please'], { FAKE_RESULT_ERROR: '1' })
  assert.notEqual(code, 0)
  assert.match(stderr, /refusal/)
})

test('a missing grok binary fails with a message that names grok', async t => {
  const s = await scratch(t)
  const { code, stderr } = await turn(s, ['-p', 'hello'], { SA_GROK_BIN: join(s.root, 'grok-missing') })
  assert.notEqual(code, 0)
  assert.match(stderr, /grok/)
})
