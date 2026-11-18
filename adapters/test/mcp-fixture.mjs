/**
 * A stand-in engine MCP server built on the same SDK the engine uses, for adapter probes.
 *
 * The hand-rolled JSON servers in the tests answer every request with a result, including notifications. A real MCP
 * client may treat that as a protocol violation: Codex's rmcp transport quits with `unrecognized JSON-RPC message, when
 * send initialized notification`, the connection dies, and the model then reports the tool as unavailable. This fixture
 * exists so a probe measures the adapter against a server that speaks the protocol properly.
 *
 *   node adapters/test/mcp-fixture.mjs [port] [logfile]
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { appendFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'

const port = Number(process.argv[2] ?? 9912)
const logfile = process.argv[3] ?? '/tmp/mcp-calls.log'
writeFileSync(logfile, '')

const server = createServer(async (req, res) => {
  let body = ''
  for await (const chunk of req) body += chunk
  let parsed
  try { parsed = body ? JSON.parse(body) : undefined } catch { parsed = undefined }
  appendFileSync(logfile, `${parsed?.method ?? 'unknown'} ${req.headers.authorization ?? '-'}\n`)
  // A notification carries no id, and the protocol says it gets no response body.
  const mcp = new Server({ name: 'superagent', version: '1.0.0' }, { capabilities: { tools: {} } })
  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: 'orchestrator_report',
    description: 'Report the outcome of a ticket', inputSchema: { type: 'object',
      properties: { state: { type: 'string' }, summary: { type: 'string' } }, required: ['state', 'summary'] } }] }))
  mcp.setRequestHandler(CallToolRequestSchema, async request => {
    appendFileSync(logfile, `CALL ${JSON.stringify(request.params)}\n`)
    return { content: [{ type: 'text', text: 'recorded' }] }
  })
  const transport = new StreamableHTTPServerTransport({})
  await mcp.connect(transport)
  Object.assign(req, { body: parsed })
  try { await transport.handleRequest(req, res, parsed) } catch (error) {
    if (!res.headersSent) { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: String(error) })) }
    else res.end()
  } finally { await mcp.close().catch(() => {}) }
})
server.listen(port, '127.0.0.1', () => { console.log(`ready on ${port}`) })
