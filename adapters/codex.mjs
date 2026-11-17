#!/usr/bin/env node
/**
 * Codex (`codex exec`) behind the Claude-Code turn contract.
 *
 * What maps where:
 *   prompt            -> argv[PROMPT]
 *   --system-prompt   -> prepended to the prompt (codex has no system-prompt flag)
 *   --mcp-config      -> -c mcp_servers.<name>.url / .http_headers (streamable HTTP, bearer token)
 *   --model           -> -m
 *   --resume          -> `codex exec resume <id>`
 *   session id        -> the `thread.started` event's thread_id
 *
 * Environment:
 *   SA_CODEX_BIN       the codex executable (default: codex)
 *   SA_CODEX_SANDBOX   codex's own sandbox mode for the turn (default: workspace-write);
 *                      the host's seatbelt already confines the process, this is the inner one.
 *   SA_CODEX_EXTRA     extra argv for codex, space separated
 */
import { emitEvent, emitInit, fail, joinPrompt, mcpEndpoint, parseContract, probeTools, run } from './lib/contract.mjs'

const contract = parseContract(process.argv.slice(2))
const endpoint = mcpEndpoint(contract)
const tools = await probeTools(endpoint)
const sessionId = contract.resume ?? contract.sessionId

const args = ['exec', '--json', '--skip-git-repo-check', '--color', 'never', '-C', process.cwd()]
if (contract.model) args.push('-m', contract.model)
const sandbox = process.env.SA_CODEX_SANDBOX || 'workspace-write'
args.push('-s', sandbox)
if (endpoint) {
  args.push('-c', `mcp_servers.${endpoint.name}.url=${JSON.stringify(endpoint.url)}`)
  args.push('-c', `mcp_servers.${endpoint.name}.http_headers={${JSON.stringify('Authorization')}=${JSON.stringify(`Bearer ${endpoint.token}`)}}`)
}
if (process.env.SA_CODEX_EXTRA) args.push(...process.env.SA_CODEX_EXTRA.split(' ').filter(Boolean))
const prompt = joinPrompt(contract.systemPrompt, contract.prompt)
if (contract.resume) args.push('resume', contract.resume, prompt)
else args.push(prompt)

emitInit({ sessionId, tools, serverName: endpoint?.name ?? 'superagent', status: endpoint ? 'connected' : 'absent' })

let reportedFailure
const { code, stderr } = await run(process.env.SA_CODEX_BIN || 'codex', args, { cwd: process.cwd(), env: process.env }, line => {
  let parsed
  try { parsed = JSON.parse(line) } catch { return }
  const type = parsed?.type ?? 'unknown'
  if (type === 'thread.started') {
    // The runner resumes the conversation by this id, so it is reported as the session.
    if (!contract.resume && parsed.thread_id) emitEvent('system/session', { session_id: parsed.thread_id })
    return
  }
  if (type === 'error') {
    reportedFailure = parsed.message ?? parsed.error?.message ?? 'codex reported an error'
  }
  if (type === 'turn.failed') {
    reportedFailure = parsed.error?.message ?? 'the turn failed'
  }
  emitEvent(`codex/${type}`, { data: parsed })
})

if (code !== 0) fail(stderr || reportedFailure || `codex ended with ${code}`)
if (reportedFailure) fail(reportedFailure)
