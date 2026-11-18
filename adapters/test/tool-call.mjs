/**
 * Asks a harness to call one engine tool, through the adapter and a stand-in MCP server.
 *
 * The conformance test proves the adapter's shape against fakes; this proves the harder half — that the real CLI connects
 * to an HTTP MCP server, lists its tools and calls one — without needing the engine, GitHub or a ticket.
 *
 *   node adapters/test/tool-call.mjs antigravity
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const harness = process.argv[2] ?? 'antigravity'
const TOKEN = 'probe-token'

/** The stand-in engine server: one tool, and a record of every call it received. */
const calls = []
const server = createServer((req, res) => {
  let body = ''
  req.on('data', chunk => { body += chunk })
  req.on('end', () => {
    const parsed = body ? JSON.parse(body) : undefined
    const method = parsed?.method
    let result
    if (method === 'initialize') result = { protocolVersion: '2025-06-18', capabilities: { tools: {} },
      serverInfo: { name: 'superagent', version: '1.0.0' } }
    else if (method === 'tools/list') result = { tools: [{ name: 'orchestrator_report', description: 'Report the outcome of the ticket',
      inputSchema: { type: 'object', properties: { state: { type: 'string' }, summary: { type: 'string' } }, required: ['state', 'summary'] } }] }
    else if (method === 'tools/call') {
      calls.push(parsed.params)
      result = { content: [{ type: 'text', text: 'recorded' }] }
    }
    res.writeHead(200, { 'content-type': 'application/json', ...parsed?.method === 'initialize' ? {} : {} })
    res.end(JSON.stringify({ jsonrpc: '2.0', id: parsed?.id, result }))
  })
})
await new Promise(resolve => { server.listen(0, '127.0.0.1', resolve) })
const url = `http://127.0.0.1:${server.address().port}/mcp`
const mcpConfig = JSON.stringify({ mcpServers: { superagent: { type: 'http', url, headers: { authorization: `Bearer ${TOKEN}` } } } })

const prompt = 'Call the orchestrator_report tool once, with state "completed" and summary "probe ok". Then say DONE.'
const adapter = join(root, 'adapters', `${harness === 'codex' ? 'codex' : harness.startsWith('antigravity') ? 'agy' : harness}.mjs`)
const child = spawn(process.execPath, [adapter, '-p', prompt, '--output-format', 'stream-json', '--mcp-config', mcpConfig], {
  cwd: '/tmp', stdio: ['ignore', 'pipe', 'pipe'] })
let out = ''
let err = ''
child.stdout.on('data', chunk => { out += chunk })
child.stderr.on('data', chunk => { err += chunk })
child.on('close', code => {
  server.close()
  const events = out.split('\n').filter(Boolean).map(line => { try { return JSON.parse(line) } catch { return {} } })
  const init = events[0] ?? {}
  console.log(`harness: ${harness}`)
  console.log(`exit: ${code}`)
  console.log(`init tools: ${JSON.stringify(init.tools)}`)
  console.log(`tool calls: ${JSON.stringify(calls)}`)
  if (err.trim()) console.log(`stderr: ${err.trim().slice(0, 500)}`)
  process.exit(calls.length > 0 ? 0 : 1)
})
