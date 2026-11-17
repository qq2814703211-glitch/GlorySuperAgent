#!/usr/bin/env node
/**
 * Proves each adapter keeps the turn contract the engine's runner reads.
 *
 * The three CLIs are replaced by fakes that record their argv and print the events the real CLI prints, and the
 * engine's MCP server is replaced by a stand-in that lists two tools. What is asserted here is therefore the adapter
 * itself: flag translation, the init event, session propagation, MCP wiring and the failure path — not the CLIs.
 *
 *   node adapters/test/conformance.mjs
 */
import { spawn } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = dirname(here)
const scratch = mkdtempSync(join(tmpdir(), 'sa-adapter-'))
let failures = 0
const check = (name, condition, detail = '') => {
  if (condition) { console.log(`  ok   ${name}`); return }
  failures++
  console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
}

/** The stand-in for the engine's MCP server: two tools, one bearer token to check. */
const mcpRequests = []
const mcp = createServer((req, res) => {
  let body = ''
  req.on('data', chunk => { body += chunk })
  req.on('end', () => {
    const parsed = JSON.parse(body || '{}')
    mcpRequests.push({ method: parsed.method, authorization: req.headers.authorization })
    const result = parsed.method === 'tools/list'
      ? { tools: [{ name: 'probe_one' }, { name: 'probe_two' }] }
      : { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'superagent', version: '1.0.0' } }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ jsonrpc: '2.0', id: parsed.id, result }))
  })
})
await new Promise(resolve => { mcp.listen(0, '127.0.0.1', resolve) })
const mcpUrl = `http://127.0.0.1:${mcp.address().port}/mcp`
const TOKEN = 'test-token-123'

const mcpConfig = JSON.stringify({ mcpServers: { superagent: { type: 'http', url: mcpUrl,
  headers: { authorization: `Bearer ${TOKEN}` } } } })

/** Runs one adapter to completion and returns what it wrote. */
function runAdapter(adapter, { binEnv, fake, fail, resume } = {}) {
  const argvOut = join(scratch, `${adapter}-argv.json`)
  const mcpLog = join(scratch, `${adapter}-mcp.log`)
  const contract = ['-p', 'do the thing', '--output-format', 'stream-json', '--verbose', '--tools', '',
    '--strict-mcp-config', '--disable-slash-commands', '--mcp-config', mcpConfig,
    '--system-prompt', 'SYSTEM RULES', '--model', 'test-model']
  if (resume) contract.push('--resume', resume)
  else contract.push('--session-id', '11111111-2222-3333-4444-555555555555')
  const child = spawn(process.execPath, [join(root, `${adapter}.mjs`), ...contract], {
    cwd: scratch,
    env: { ...process.env, [binEnv]: join(here, 'fakes', fake), FAKE_ARGV_OUT: argvOut, FAKE_MCP_LOG: mcpLog,
      ...fail ? { FAKE_FAIL: fail } : {} },
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr += chunk })
  return new Promise(resolve => {
    child.on('close', code => {
      const lines = stdout.split('\n').filter(Boolean).map(line => { try { return JSON.parse(line) } catch { return {} } })
      let argv = []
      let mcpCalls = []
      try { argv = JSON.parse(readFileSync(argvOut, 'utf8')) } catch {}
      try { mcpCalls = readFileSync(mcpLog, 'utf8').split('\n').filter(Boolean) } catch {}
      resolve({ code, stderr, lines, argv, mcpCalls })
    })
  })
}

for (const [fake, file] of [['codex', 'codex'], ['dsh', 'dsh']]) chmodSync(join(here, 'fakes', file), 0o755)

console.log('\ncodex adapter')
{
  const result = await runAdapter('codex', { binEnv: 'SA_CODEX_BIN', fake: 'codex' })
  const init = result.lines[0] ?? {}
  check('exit 0', result.code === 0, result.stderr)
  check('first line is the init event', init.type === 'system' && init.subtype === 'init')
  check('tools come from the MCP server', JSON.stringify(init.tools) === JSON.stringify(['mcp__superagent__probe_one', 'mcp__superagent__probe_two']), JSON.stringify(init.tools))
  check('MCP server reported connected', init.mcp_servers?.[0]?.status === 'connected')
  check('session id is the thread id', result.lines.some(line => line.type === 'system/session' && line.session_id === 'thread-fake-1'))
  check('the prompt carries the system prompt', result.argv.at(-1)?.includes('SYSTEM RULES') && result.argv.at(-1)?.includes('do the thing'))
  check('codex runs as `exec --json`', result.argv[0] === 'exec' && result.argv.includes('--json'))
  check('MCP is passed as config overrides', result.argv.some(arg => arg.includes('mcp_servers.superagent.url')) &&
    result.argv.some(arg => arg.includes('mcp_servers.superagent.http_headers')))
  check('the model is forwarded', result.argv.includes('-m') && result.argv.includes('test-model'))
  check('--verbose is not forwarded', !result.argv.includes('--verbose'))
}

console.log('\ncodex adapter, resume')
{
  const result = await runAdapter('codex', { binEnv: 'SA_CODEX_BIN', fake: 'codex', resume: 'thread-9' })
  check('resume becomes `exec resume <id>`', result.argv.includes('resume') && result.argv.includes('thread-9'))
  check('a resumed turn reports no new session', !result.lines.some(line => line.type === 'system/session'))
}

console.log('\ncodex adapter, failure')
{
  const result = await runAdapter('codex', { binEnv: 'SA_CODEX_BIN', fake: 'codex', fail: 'the model refused' })
  check('a failed turn exits non-zero', result.code !== 0)
  check('the failure reaches stderr', result.stderr.includes('the model refused'), result.stderr.trim())
}

console.log('\ndsh adapter')
{
  const result = await runAdapter('dsh', { binEnv: 'SA_DSH_BIN', fake: 'dsh' })
  const init = result.lines[0] ?? {}
  check('exit 0', result.code === 0, result.stderr)
  check('first line is the init event', init.type === 'system' && init.subtype === 'init')
  check('tools come from the MCP server', init.tools.length === 2, JSON.stringify(init.tools))
  check('session id is the dsh session', result.lines.some(line => line.type === 'system/session' && line.session_id === 'session-fake-1'))
  check('dsh runs the headless profile with --json', result.argv.includes('--profile') && result.argv.includes('headless') && result.argv.includes('--json'))
  check('the task carries the system prompt', result.argv.at(-1)?.includes('SYSTEM RULES'))
}

console.log('\ndsh adapter, failure reported inside a zero exit')
{
  const result = await runAdapter('dsh', { binEnv: 'SA_DSH_BIN', fake: 'dsh', fail: 'no API key' })
  check('the failure makes the adapter exit non-zero', result.code !== 0, `code=${result.code}`)
  check('the failure reaches stderr', result.stderr.includes('no API key'), result.stderr.trim())
}

console.log('\nagy adapter')
{
  const result = await runAdapter('agy', { binEnv: 'SA_AGY_BIN', fake: 'agy' })
  const init = result.lines[0] ?? {}
  check('exit 0', result.code === 0, result.stderr)
  check('first line is the init event', init.type === 'system' && init.subtype === 'init')
  check('tools come from the MCP server', init.tools.length === 2, JSON.stringify(init.tools))
  check('--verbose is not forwarded (agy rejects it)', !result.argv.includes('--verbose'))
  check('the prompt carries the system prompt', result.argv[result.argv.indexOf('-p') + 1]?.includes('SYSTEM RULES'))
  check('the MCP server is added globally for the turn', result.mcpCalls.some(call => call.startsWith('mcp add') && call.includes(mcpUrl)))
  check('the MCP server is removed afterwards', result.mcpCalls.some(call => call.startsWith('mcp remove')))
  check('the conversation id is reported as the session', result.lines.some(line => line.type === 'system/session' && line.session_id === 'conv-fake-1'))
}

console.log('\nagy adapter, failure')
{
  const result = await runAdapter('agy', { binEnv: 'SA_AGY_BIN', fake: 'agy', fail: 'not eligible' })
  check('a failed turn exits non-zero', result.code !== 0)
  check('the failure reaches stderr', result.stderr.includes('not eligible'), result.stderr.trim())
  check('the MCP server is still removed', result.mcpCalls.some(call => call.startsWith('mcp remove')))
}

console.log('\nMCP probe')
{
  check('the engine server was asked for its tools', mcpRequests.some(request => request.method === 'tools/list'))
  check('every MCP request carried the bearer token', mcpRequests.every(request => request.authorization === `Bearer ${TOKEN}`),
    JSON.stringify(mcpRequests.map(request => request.authorization)))
}

mcp.close()
rmSync(scratch, { recursive: true, force: true })
console.log(failures ? `\n${failures} check(s) failed\n` : '\nall checks passed\n')
process.exit(failures ? 1 : 0)
