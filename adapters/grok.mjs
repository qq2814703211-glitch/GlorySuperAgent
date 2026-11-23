#!/usr/bin/env node
/**
 * grok build behind the Claude-Code turn contract.
 *
 * What maps where:
 *   prompt            -> -p <prompt>
 *   --system-prompt   -> --rules <text> (grok has a real system-prompt flag, so it is not folded into the prompt)
 *   --model           -> -m
 *   --resume          -> --resume <id>; `-s/--session-id` only mints an id for a new conversation, it does not resume one
 *   --effort          -> --reasoning-effort
 *   --add-dir         -> --cwd, the first directory only (grok has no flag for the others)
 *   --mcp-config      -> SA_MCP_URL / SA_MCP_TOKEN in the child's environment
 *   session id        -> the `system/init` event's session_id
 *
 * Output is `--output-format streaming-messages-json`: its events already have the shapes the runner stores, so
 * assistant and user events pass through untouched, and anything else is kept under `grok/<type>`.
 *
 * Worker only: grok always brings a shell and filesystem tools, so nothing here can prove a built-in-free tool list,
 * and this adapter claims no router behaviour.
 *
 * Environment:
 *   SA_GROK_BIN     the grok executable (default: grok)
 *   SA_ADAPTER_LOG  opt-in file recording how the turn ended
 */
import { emitEvent, emitInit, fail, mcpEndpoint, parseContract, probeTools, run } from './lib/contract.mjs'

const contract = parseContract(process.argv.slice(2))
const endpoint = mcpEndpoint(contract)
const tools = await probeTools(endpoint)

// `--yolo` skips grok's permission prompts: a turn the host starts has nobody to answer one, and the host already
// confines the whole process. `--no-auto-update` keeps a self-update from replacing the binary mid-turn.
const args = ['--output-format', 'streaming-messages-json', '--yolo', '--no-auto-update']
if (contract.model) args.push('-m', contract.model)
if (contract.effort) args.push('--reasoning-effort', contract.effort)
if (contract.systemPrompt) args.push('--rules', contract.systemPrompt)
// A repeated --add-dir has no grok flag behind it; the first directory is the turn's working directory.
if (contract.addDirs[0]) args.push('--cwd', contract.addDirs[0])
if (contract.resume) args.push('--resume', contract.resume)
args.push('-p', contract.prompt)

// grok has no per-turn MCP flag: the endpoint travels in the environment the child reads.
const env = { ...process.env }
if (endpoint?.url) {
  env.SA_MCP_URL = endpoint.url
  env.SA_MCP_TOKEN = endpoint.token ?? ''
}

// The runner takes the session id from the init line, and grok takes its own id from the conversation it opens, so a
// new turn waits for grok's `system/init` instead of reporting the id the runner suggested. The init line is still the
// first line emitted: anything grok prints before its init event is held and flushed behind it.
let sessionId = contract.resume
let announcedSession = contract.resume
let initSent = false
const held = []
const report = (type, fields) => {
  if (initSent) emitEvent(type, fields)
  else held.push([type, fields])
}
const sendInit = id => {
  if (initSent) return
  initSent = true
  emitInit({
    sessionId: id ?? sessionId,
    tools,
    serverName: endpoint?.name ?? 'superagent',
    status: endpoint ? 'connected' : 'absent',
  })
  for (const [type, fields] of held.splice(0)) emitEvent(type, fields)
}
/** Reports a conversation the runner can resume next turn; the id it already knows is not news. */
const announce = id => {
  if (!id || id === announcedSession) return
  announcedSession = id
  report('system/session', { session_id: id })
}

// A resumed turn already knows its conversation, so its init line goes out before grok starts and is first whatever
// grok prints. A new turn gets one as soon as grok names the conversation it opened.
if (contract.resume) sendInit(contract.resume)

let stopReason
let reportedFailure
const { code, stderr } = await run(process.env.SA_GROK_BIN || 'grok', args, { cwd: process.cwd(), env }, line => {
  let parsed
  try { parsed = JSON.parse(line) } catch { return }
  const type = parsed?.type ?? 'unknown'
  if (type === 'system' && parsed.subtype === 'init') {
    if (parsed.session_id) sessionId = parsed.session_id
    sendInit(parsed.session_id)
    announce(parsed.session_id)
    return
  }
  // Already in the runner's shape: the message goes through as grok wrote it.
  if (type === 'assistant' || type === 'user') {
    report(type, parsed)
    return
  }
  if (type === 'result') {
    if (parsed.session_id) {
      sessionId = parsed.session_id
      announce(parsed.session_id)
    }
    stopReason = parsed.stop_reason
    // grok can exit 0 while saying the turn failed; only a success result that is not an error is a success.
    if (parsed.subtype !== 'success' || parsed.is_error !== false) {
      reportedFailure = `grok stopped: ${parsed.stop_reason ?? parsed.subtype ?? 'the turn did not succeed'}`
    }
    return
  }
  report(`grok/${type}`, { data: parsed })
})

if (process.env.SA_ADAPTER_LOG) {
  const { appendFileSync } = await import('node:fs')
  appendFileSync(process.env.SA_ADAPTER_LOG,
    `${new Date().toISOString()} grok exit=${code} stop_reason=${stopReason ?? 'none'} failure=${reportedFailure ?? 'none'} stderr=${(stderr ?? '').slice(-600).replaceAll('\n', ' | ')}\n`)
}
if (code !== 0 && !reportedFailure) {
  const detail = (stderr ?? '').trim()
  fail(detail ? `grok: ${detail}` : `grok ended with exit code ${code}`)
}
// A turn that ended before grok named its conversation still reports its tools, so the runner reads a complete turn.
sendInit()
if (reportedFailure) fail(reportedFailure)
