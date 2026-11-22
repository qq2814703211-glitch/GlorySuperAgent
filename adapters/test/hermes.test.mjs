import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:http'
import { parseTurn, translate, verifyTools } from '../hermes.mjs'
import { routerCli } from '../../scripts/router-cli.mjs'

const config = port => JSON.stringify({ mcpServers: { superagent: { type: 'http', url: `http://127.0.0.1:${port}/mcp`,
  headers: { authorization: 'Bearer dummy' } } } })
const common = ['-p', 'hello', '--tools', '', '--strict-mcp-config', '--disable-slash-commands', '--output-format', 'stream-json']

test('accepts a strict router contract and refuses absent MCP credentials', () => {
  const args = [...common, '--router-state', '/private/router', '--session-id', 'new']
  assert.equal(parseTurn([...args, '--mcp-config', config(1234)]).values.prompt, 'hello')
  assert.throws(() => parseTurn(args), /authenticated/)
  assert.throws(() => parseTurn([...args, '--mcp-config', config(1234), '--tools', 'shell']), /strict router/)
})

test('verifies the complete Hermes inventory', () => {
  const one = '    * mcp_superagent_route - choose a route'
  verifyTools(one, ['route'])
  for (const listing of ['', `${one}\n    * terminal - run commands`]) assert.throws(() => verifyTools(listing, ['route']), /inventory/)
})

test('takes the native session ID from a completed result', () => {
  const events = [{ type: 'system', subtype: 'init', session_id: '' }, { type: 'text', text: 'answer' },
    { type: 'result', exit_code: 0, session_id: 'native-session' }]
  const stream = () => events.map(event => JSON.stringify(event)).join('\n')
  assert.deepEqual(translate(stream(), []), { events: events.slice(1), nativeSession: 'native-session' })
  events[2].exit_code = 1
  assert.throws(() => translate(stream(), []), /finish/)
})

test('reports MCP config injection failure before invoking Hermes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hermes-test-'))
  const server = createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    if (!body) { res.writeHead(405).end(); return }
    const message = JSON.parse(body)
    if (!message.id && message.id !== 0) { res.writeHead(202).end(); return }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    const result = message.method === 'initialize' ? { protocolVersion: '2025-06-18', capabilities: { tools: {} },
      serverInfo: { name: 'engine', version: '1' } } : { tools: [{ name: 'route', inputSchema: { type: 'object' } }] }
    res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }))
  })
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    await mkdir(join(root, 'session', 'config.yaml'), { recursive: true })
    await writeFile(join(root, 'session', 'router-session'), 'native')
    const args = [fileURLToPath(new URL('../hermes.mjs', import.meta.url)), ...common, '--resume', 'session',
      '--router-state', root, '--mcp-config', config(server.address().port)]
    await assert.rejects(promisify(execFile)(process.execPath, args), error =>
      error.stdout === '' && error.stderr.includes('Unable to inject') && !error.stderr.includes('dummy'))
  } finally { server.close(); await rm(root, { recursive: true, force: true }) }
})

test('supports both inline and named router entries', () => {
  const entry = { command: 'node', args: ['/opt/adapters/hermes.mjs'], readable: ['/opt/adapters'], effort: 'low' }
  assert.deepEqual(routerCli({ router: 'hermes', routers: { hermes: entry } }), entry)
  assert.deepEqual(routerCli({ router: entry }), entry)
  assert.deepEqual(routerCli({ router: entry }, 'claude'), { command: 'claude' })
  assert.throws(() => routerCli({ router: 'missing' }))
})
