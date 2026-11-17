#!/usr/bin/env node
/**
 * DeepSeek Harness (`dsh headless`) behind the Claude-Code turn contract.
 *
 * What maps where:
 *   prompt            -> the task text (argv after the profile flags)
 *   --system-prompt   -> prepended to the task text
 *   --resume          -> --session-id <id> (dsh adopts a persisted Session by id)
 *   session id        -> the `session` event's sessionId
 *   --mcp-config      -> NOT wired yet: the headless profile ships no MCP plugin, so an agent
 *                        cannot call the engine's orchestrator_* tools through dsh. See README.
 *
 * dsh exits 0 even when the turn failed, and reports the failure in the `final` event, so the exit code alone is not
 * the outcome: the reason kind is what decides it.
 *
 * Environment:
 *   SA_DSH_BIN         the dsh executable (default: the one inside DeepSeek Harness.app)
 *   SA_DSH_PROFILE     the profile to boot (default: headless)
 *   SA_DSH_PERMISSION  --permission-mode preset (default: unset, the profile's own)
 */
import { existsSync } from 'node:fs'
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

emitInit({ sessionId: contract.resume, tools, serverName: endpoint?.name ?? 'superagent', status: endpoint ? 'connected' : 'absent' })

let reportedFailure
const { code, stderr } = await run(bin, args, { cwd: process.cwd(), env: process.env }, line => {
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
