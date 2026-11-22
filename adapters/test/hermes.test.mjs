import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
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
  const one = '    * mcp__superagent__route - choose a route'
  verifyTools(one, ['route'])
  for (const listing of ['', `${one}\n    * terminal - run commands`, `${one}\n    * malformed`]) {
    assert.throws(() => verifyTools(listing, ['route']), /inventory/)
  }
})

test('takes the native session ID from a completed result', () => {
  const events = [{ type: 'system', subtype: 'init', session_id: '' }, { type: 'text', text: 'answer' },
    { type: 'result', exit_code: 0, session_id: 'native-session' }]
  const stream = () => events.map(event => JSON.stringify(event)).join('\nSession: local-not-the-session-id\n') + '\n'
  assert.deepEqual(translate(stream(), []), { events: events.slice(1), nativeSession: 'native-session' })
  assert.throws(() => translate(stream().replace('"type":"text"', '"type":"tool_use","name":"terminal"'), []), /outside/)
  assert.throws(() => translate(stream().replace('"type":"text"', 'malformed'), []), /Invalid Hermes event stream/)
  assert.throws(() => translate(stream().split('{"type":"result"')[0], []), /finish/)
  events[2].exit_code = 1
  assert.throws(() => translate(stream(), []), /finish/)
})

async function engine() {
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
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return server
}

test('reports MCP config injection failure before invoking Hermes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hermes-test-'))
  const server = await engine()
  try {
    await mkdir(join(root, 'session', 'config.yaml'), { recursive: true })
    await writeFile(join(root, 'session', 'router-session'), 'native')
    const args = [fileURLToPath(new URL('../hermes.mjs', import.meta.url)), ...common, '--resume', 'session',
      '--router-state', root, '--mcp-config', config(server.address().port)]
    await assert.rejects(promisify(execFile)(process.execPath, args), error =>
      error.stdout === '' && error.stderr.includes('Unable to inject') && !error.stderr.includes('dummy'))
  } finally { server.close(); await rm(root, { recursive: true, force: true }) }
})

test('isolates one provider and refreshes engine credentials before resuming the native session', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hermes-profile-test-'))
  const server = await engine()
  try {
    const profile = join(root, 'source')
    await mkdir(profile)
    await writeFile(join(profile, 'config.yaml'), 'providers:\n  chosen:\n    api: https://provider.invalid/v1\n    key_env: CHOSEN_KEY\n  other: {}\nmcp_servers:\n  foreign: {}\n')
    await writeFile(join(profile, '.env'), 'CHOSEN_KEY=test-only-value\nOTHER_KEY=unrelated\n')
    await writeFile(join(root, 'notes'), 'A private test context.')
    const bin = join(root, 'hermes')
    await writeFile(bin, `#!${process.execPath}
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const home = process.env.HERMES_HOME, config = JSON.parse(fs.readFileSync(path.join(home, 'config.yaml')));
assert.deepEqual(Object.keys(config.providers), ['chosen']);
assert.deepEqual(Object.keys(config.mcp_servers), ['superagent']);
assert.equal(config.providers.chosen.base_url, 'https://provider.invalid/v1');
assert.equal(fs.readFileSync(path.join(home, '.env'), 'utf8'), 'ROUTER_PROVIDER_API_KEY=test-only-value\\n');
assert.equal(process.env.OPENAI_API_KEY, undefined);
const args = process.argv.slice(2), resume = args.includes('--resume');
assert.equal(args[args.indexOf('--toolsets')+1], 'mcp-superagent');
if (args.includes('--list-tools')) { console.log('    * mcp__superagent__route - route'); process.exit(0) }
assert.ok(!args.includes('A private test context.'));
assert.equal(fs.readFileSync(args[args.indexOf('--query-file')+1], 'utf8'), 'A private test context.\\n\\nhello');
assert.equal(config.mcp_servers.superagent.headers.Authorization, resume ? 'Bearer rotated' : 'Bearer dummy');
if(resume) assert.equal(args[args.indexOf('--resume')+1], 'local-real-id');
console.log(JSON.stringify({type:'system',subtype:'init',session_id:''}));
console.log('Session: local-real-id');
console.log(JSON.stringify({type:'result',session_id:'local-real-id',exit_code:0}));`, { mode: 0o700 })
    const adapter = fileURLToPath(new URL('../hermes.mjs', import.meta.url))
    const args = [adapter, ...common, '--hermes-bin', bin, '--router-state', root, '--provider-profile', profile,
      '--provider', 'chosen', '--context', join(root, 'notes')]
    const mcp = config(server.address().port)
    for (const [sessionFlag, token] of [['--session-id', 'dummy'], ['--resume', 'rotated']]) {
      const { stdout, stderr } = await promisify(execFile)(process.execPath,
        [...args, sessionFlag, 'host-id', '--mcp-config', mcp.replace('dummy', token)],
        { env: { ...process.env, OPENAI_API_KEY: 'unrelated' } })
      assert.equal(stderr, '')
      const events = stdout.trim().split('\n').map(line => JSON.parse(line))
      assert.deepEqual(events[0].tools, ['mcp__superagent__route'])
      assert.equal(events[0].session_id, 'host-id')
      assert.deepEqual(events[1], { type: 'system/session', session_id: 'local-real-id' })
      assert.deepEqual(await readdir(join(root, 'host-id')), ['router-session'])
      assert.equal(await readFile(join(root, 'host-id', 'router-session'), 'utf8'), 'local-real-id')
      assert.doesNotMatch(stdout, /Bearer|test-only-value|private test context/)
    }
  } finally { server.close(); await rm(root, { recursive: true, force: true }) }
})

test('supports both inline and named router entries', () => {
  const entry = { command: 'node', args: ['/opt/adapters/hermes.mjs'], readable: ['/opt/adapters'], effort: 'low' }
  assert.deepEqual(routerCli({ router: 'hermes', routers: { hermes: entry } }), entry)
  assert.deepEqual(routerCli({ router: entry }), entry)
  assert.deepEqual(routerCli({ router: entry }, 'claude'), { command: 'claude' })
  assert.throws(() => routerCli({ router: 'missing' }))
})
