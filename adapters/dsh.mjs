#!/usr/bin/env node
/**
 * DeepSeek Harness (`dsh headless`) behind the Claude-Code turn contract.
 *
 * What maps where:
 *   prompt            -> the task text (argv after the profile flags)
 *   --system-prompt   -> prepended to the task text
 *   --resume          -> --session-id <id> (dsh adopts a persisted Session by id)
 *   session id        -> the `session` event's sessionId
 *   --mcp-config      -> the profile's `mcp-client` row: a headless run takes no server on argv, so the
 *                        adapter exports this turn's endpoint as SA_MCP_URL and its token as
 *                        SA_MCP_TOKEN, which `~/.dsh/profiles/headless/cordis.patch.yml` reads.
 *
 * dsh exits 0 even when the turn failed, and reports the failure in the `final` event, so the exit code alone is not
 * the outcome: the reason kind is what decides it.
 *
 * Environment:
 *   SA_DSH_BIN         the dsh executable (default: the one inside DeepSeek Harness.app)
 *   SA_DSH_PROFILE     the profile to boot (default: headless)
 *   SA_DSH_PERMISSION  --permission-mode preset (default: unset, the profile's own)
 *   SA_GATEWAY_KEY     the model gateway's token; read from the agent CLI's settings when unset
 */
import { existsSync, readFileSync } from 'node:fs'
import { emitEvent, emitInit, fail, joinPrompt, mcpEndpoint, parseContract, probeTools, run } from './lib/contract.mjs'

const APP_DSH = '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh'
const contract = parseContract(process.argv.slice(2))
const endpoint = mcpEndpoint(contract)
const tools = await probeTools(endpoint)
const bin = process.env.SA_DSH_BIN || (existsSync(APP_DSH) ? APP_DSH : 'dsh')

const args = ['--profile', process.env.SA_DSH_PROFILE || 'headless', '--json']
if (contract.resume) args.push('--session-id', contract.resume)
if (process.env.SA_DSH_PERMISSION) args.push('--permission-mode', process.env.SA_DSH_PERMISSION)
for (const dir of contract.addDirs) args.push('--add-dir', dir)
args.push(joinPrompt(contract.systemPrompt, contract.prompt))

// The headless profile reads its MCP server from the profile patch, not from argv: the URL and token a turn gets are
// exported here so that patch's `!!js` rows resolve to this turn's server instead of the fallback.
const env = { ...process.env }
if (endpoint?.url) {
  env.SA_MCP_URL = endpoint.url
  env.SA_MCP_TOKEN = endpoint.token ?? ''
}
// The gateway key lives in the dsh credential store's `refs`, which the profile names through `apiKeyEnv`. A sandboxed
// turn inherits no key, so read the one this profile asks for instead of requiring the host to export it. The gateway is
// the one the agent CLI already talks to, so its token is taken from that CLI's settings.
if (!env.SA_GATEWAY_KEY) {
  try {
    const settings = JSON.parse(readFileSync(`${env.HOME ?? ''}/.claude/settings.json`, 'utf8'))
    const token = settings?.env?.ANTHROPIC_AUTH_TOKEN
    if (token) env.SA_GATEWAY_KEY = token
  } catch { /* an absent settings file leaves the turn to fail as a missing credential, which is the honest report */ }
}

emitInit({ sessionId: contract.resume, tools, serverName: endpoint?.name ?? 'superagent', status: endpoint ? 'connected' : 'absent' })

let reportedFailure
const { code, stderr } = await run(bin, args, { cwd: process.cwd(), env }, line => {
  let parsed
  try { parsed = JSON.parse(line) } catch { return }
  const type = parsed?.type ?? 'unknown'
  if (type === 'session') {
    // The runner resumes the conversation by this id, so it is reported as the session.
    if (!contract.resume && parsed.sessionId) emitEvent('system/session', { session_id: parsed.sessionId })
    return
  }
  if (type === 'final') {
    const reason = parsed.reason
    if (reason?.kind === 'error') reportedFailure = reason.error?.message ?? 'the turn failed'
  }
  if (type === 'status' && parsed.phase === 'turn_end' && parsed.reason?.kind === 'error') {
    reportedFailure = parsed.reason.error?.message ?? reportedFailure
  }
  emitEvent(`dsh/${type}`, { data: parsed })
})

if (code !== 0) fail(stderr || reportedFailure || `dsh ended with ${code}`)
if (reportedFailure) fail(reportedFailure)
