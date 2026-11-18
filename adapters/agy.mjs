#!/usr/bin/env node
/**
 * Antigravity (`agy`) behind the Claude-Code turn contract.
 *
 * agy is the closest of the three to Claude Code's own CLI — `-p`, `--output-format stream-json`,
 * `--disable-slash-commands`, `--add-dir`, `--model`, `--effort` — but three things differ, and this adapter is mostly
 * about those:
 *
 *   1. It rejects `--verbose` outright (Go flag parsing: `flags provided but not defined: -verbose`), so the adapter
 *      never forwards it.
 *   2. It has no `--system-prompt`, so instructions are prepended to the prompt.
 *   3. MCP servers are **global configuration**, not a per-turn flag: `agy mcp add ...` writes
 *      `~/.gemini/config/mcp_config.json`. The engine gives every agent its own bearer token, so two concurrent agy
 *      turns would overwrite each other's server entry. This adapter therefore serialises agy turns behind a lock,
 *      adds a uniquely named server, and removes it in a `finally`.
 *
 * Resume is `--conversation <id>`, and the conversation id comes back in the result event.
 *
 * Environment:
 *   SA_AGY_BIN          the agy executable (default: agy)
 *   SA_AGY_LOCK_WAIT    ms to wait for the MCP lock before running without tools (default: 900000)
 */
import { closeSync, existsSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { emitEvent, emitInit, fail, joinPrompt, mcpEndpoint, parseContract, probeTools, run } from './lib/contract.mjs'

const contract = parseContract(process.argv.slice(2))
const endpoint = mcpEndpoint(contract)
const tools = await probeTools(endpoint)
const bin = process.env.SA_AGY_BIN || 'agy'

/** The MCP configuration agy reads; the lock lives beside it so two turns cannot edit it at once. */
const CONFIG_DIR = join(homedir(), '.gemini', 'config')
const LOCK = join(CONFIG_DIR, '.superagent-adapter.lock')
/** A name per process keeps one turn's entry out of the next one's way. */
const SERVER_NAME = `superagent-${process.pid}`

const sleep = ms => new Promise(resolve => { setTimeout(resolve, ms) })

/** Takes the MCP lock, or reports that it could not within the wait. */
async function lock(waitMs) {
  const deadline = Date.now() + waitMs
  while (Date.now() < deadline) {
    try {
      const fd = openSync(LOCK, 'wx', 0o600)
      writeSync(fd, `${process.pid}\n`)
      closeSync(fd)
      return true
    } catch (error) {
      if (error.code !== 'EEXIST') return false
      // A lock left by a killed turn is stale once its process is gone, or once the turn timeout has passed.
      let stale = false
      try {
        const holder = Number(readFileSync(LOCK, 'utf8').trim())
        if (holder > 0) { try { process.kill(holder, 0) } catch { stale = true } }
      } catch { stale = true }
      try { if (!stale && Date.now() - statSync(LOCK).mtimeMs > 45 * 60_000) stale = true } catch {}
      if (stale) { try { unlinkSync(LOCK) } catch {} }
      await sleep(500)
    }
  }
  return false
}
const unlock = () => { try { unlinkSync(LOCK) } catch {} }

/** Runs one agy subcommand quietly; the answer matters, the output does not. */
async function agyControl(args) {
  const { code, stderr } = await run(bin, args, { cwd: process.cwd(), env: process.env }, () => {})
  return code === 0 ? undefined : (stderr || `agy ${args[0]} ended with ${code}`)
}

// agy auto-denies a tool call that would need a permission prompt, and headless mode has no one to ask: without this the
// model's MCP call is silently dropped and the turn ends with an empty answer. The host already grants a worker full
// access and confines the process in the operating system's sandbox, so the inner prompt adds a failure mode, not safety.
const args = ['-p', joinPrompt(contract.systemPrompt, contract.prompt), '--output-format', 'stream-json',
  '--dangerously-skip-permissions']
// A background job the model leaves running keeps print mode waiting ("root agent idle; waiting for N background
// task(s)") until the host kills the turn. Ending it here turns a stuck job into a reported failure.
const printTimeout = Number(process.env.SA_AGY_PRINT_TIMEOUT ?? 20 * 60_000)
if (printTimeout > 0) args.push('--print-timeout', `${printTimeout}ms`)
if (contract.model) args.push('--model', contract.model)
if (contract.effort) args.push('--effort', contract.effort)
if (contract.noCommands) args.push('--disable-slash-commands')
if (contract.resume) args.push('--conversation', contract.resume)
for (const dir of contract.addDirs) args.push('--add-dir', dir)

let mcpError
let locked = false
if (endpoint) {
  locked = await lock(Number(process.env.SA_AGY_LOCK_WAIT ?? 900_000))
  if (locked) {
    mcpError = await agyControl(['mcp', 'add', '--header', `Authorization: Bearer ${endpoint.token}`, SERVER_NAME, endpoint.url])
  } else {
    mcpError = 'another agy turn held the MCP lock, so this turn ran without the engine tools'
  }
}

emitInit({ sessionId: contract.resume, tools: locked && !mcpError ? tools : [], serverName: endpoint?.name ?? 'superagent',
  status: mcpError ? 'absent' : endpoint ? 'connected' : 'absent' })

let reportedFailure
let outcome
try {
  if (mcpError) process.stderr.write(`${mcpError.trim()}\n`)
  const { code, stderr } = await run(bin, args, { cwd: process.cwd(), env: process.env }, line => {
    let parsed
    try { parsed = JSON.parse(line) } catch { return }
    const type = parsed?.event ?? 'unknown'
    if (type === 'result') {
      const result = parsed.result ?? {}
      if (result.status === 'ERROR') reportedFailure = result.error ?? 'the turn failed'
      // The conversation id resumes this exchange on the next turn.
      if (!contract.resume && result.conversation_id) emitEvent('system/session', { session_id: result.conversation_id })
    }
    emitEvent(`agy/${type}`, { data: parsed })
  })
  // Opt-in: the host gives a turn no terminal, so a failing turn is otherwise silent. SA_ADAPTER_LOG names a file
  // that records the turn's outcome and its stderr tail.
  if (process.env.SA_ADAPTER_LOG) {
    const { appendFileSync } = await import('node:fs')
    appendFileSync(process.env.SA_ADAPTER_LOG, `${new Date().toISOString()} agy exit=${code} failure=${reportedFailure ?? 'none'} stderr=${(stderr ?? '').slice(-800).replaceAll('\n', ' | ')}\n`)
  }
  if (code !== 0) outcome = stderr || reportedFailure || `agy ended with ${code}`
  else if (reportedFailure) outcome = reportedFailure
} finally {
  // The cleanup runs before the turn reports: `process.exit` does not unwind a `finally`, so failing inside the try
  // would leave this turn's MCP entry in the shared config and its lock on disk.
  if (locked) {
    await agyControl(['mcp', 'remove', SERVER_NAME])
    unlock()
  }
}
if (outcome) fail(outcome)
