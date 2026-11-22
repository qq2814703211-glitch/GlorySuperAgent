/**
 * A coding-agent CLI that answers the Claude-Code turn contract.
 *
 * The engine's runner starts a CLI once per turn as
 *
 *   <cli> -p PROMPT --output-format stream-json --verbose [--tools ''] [--strict-mcp-config]
 *         [--disable-slash-commands] [--mcp-config JSON] [--system-prompt TEXT]
 *         [--model M] [--resume ID | --session-id UUID]
 *
 * and reads newline-delimited JSON from stdout. The first line has to be the init event, because the runner takes the
 * session id, the tools and the MCP servers from it:
 *
 *   {"type":"system","subtype":"init","session_id":"...","tools":["mcp__superagent__..."],"mcp_servers":[...]}
 *
 * Every adapter in this directory parses that contract here and translates it to one CLI, so the engine can run any of
 * them as its agent without knowing which one it is talking to.
 */

/** What the runner asked for, in the runner's own words. */
export const FLAGS_WITH_VALUE = new Set([
  '-p', '--print', '--prompt', '--output-format', '--input-format', '--mcp-config', '--system-prompt',
  '--append-system-prompt', '--model', '--resume', '-r', '--session-id', '--tools', '--allowedTools',
  '--disallowedTools', '--permission-mode', '--max-turns', '--max-budget-usd', '--effort', '--agent',
  '--mode', '--settings', '--json-schema', '--add-dir', '--print-timeout', '--project',
])

/**
 * Reads the runner's argv.
 *
 * Unknown flags are ignored rather than refused: the runner may pass one before this adapter knows it, and failing a
 * turn over a flag nobody uses is worse than dropping it. The prompt is the value of `-p`, which is how the runner
 * always sends it.
 */
export function parseContract(argv) {
  const contract = {
    prompt: undefined,
    outputFormat: 'text',
    tools: undefined,
    strictMcp: false,
    noCommands: false,
    noBuiltins: false,
    mcpConfig: undefined,
    systemPrompt: undefined,
    model: undefined,
    resume: undefined,
    sessionId: undefined,
    verbose: false,
    effort: undefined,
    addDirs: [],
  }
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]
    const next = () => argv[++index]
    switch (argument) {
      case '-p': case '--print': case '--prompt': contract.prompt = next(); break
      case '--output-format': contract.outputFormat = next(); break
      case '--input-format': next(); break
      case '--tools': contract.tools = next(); contract.noBuiltins = contract.tools === ''; break
      case '--strict-mcp-config': contract.strictMcp = true; break
      case '--disable-slash-commands': contract.noCommands = true; break
      case '--mcp-config': contract.mcpConfig = next(); break
      case '--system-prompt': contract.systemPrompt = next(); break
      case '--append-system-prompt': contract.systemPrompt = [contract.systemPrompt, next()].filter(Boolean).join('\n\n'); break
      case '--model': contract.model = next(); break
      case '--resume': case '-r': contract.resume = next(); break
      case '--session-id': contract.sessionId = next(); break
      case '--verbose': contract.verbose = true; break
      case '--effort': contract.effort = next(); break
      case '--add-dir': contract.addDirs.push(next()); break
      // Value-taking flags this adapter has no use for still consume their value, or the value becomes a stray prompt.
      case '--allowedTools': case '--disallowedTools': case '--permission-mode': case '--max-turns':
      case '--max-budget-usd': case '--agent': case '--mode': case '--settings': case '--json-schema':
      case '--print-timeout': case '--project': next(); break
      default: break
    }
  }
  if (contract.prompt === undefined) {
    fail('no prompt: the runner sends it as -p PROMPT')
  }
  return contract
}

/** The MCP server the engine offers this agent, as the runner configured it. */
export function mcpEndpoint(contract) {
  if (!contract.mcpConfig) return undefined
  let parsed
  try { parsed = JSON.parse(contract.mcpConfig) } catch { return undefined }
  const servers = parsed?.mcpServers
  if (!servers || typeof servers !== 'object') return undefined
  const [name, server] = Object.entries(servers)[0] ?? []
  if (!name || !server?.url) return undefined
  const headers = server.headers ?? {}
  const authorization = headers.authorization ?? headers.Authorization ?? ''
  const token = String(authorization).replace(/^Bearer\s+/i, '')
  return { name, url: server.url, token, headers }
}

/**
 * Asks the engine's MCP server which tools this agent has.
 *
 * The router is refused by the runner unless every tool the CLI reports is one of the engine's, so the adapter reports
 * what the server itself lists instead of inventing a list. A probe that fails is not fatal: the turn can still run,
 * it just reports no tools.
 */
export async function probeTools(endpoint, { timeoutMs = 4000 } = {}) {
  if (!endpoint) return []
  // A server the agent cannot reach is not a reason to fail the turn: the CLI would report the same thing, and the
  // runner treats a reported tool it does not know as a refusal.
  try {
    const call = async (body, sessionId) => {
    const response = await fetch(endpoint.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...endpoint.token ? { authorization: `Bearer ${endpoint.token}` } : {},
        ...sessionId ? { 'mcp-session-id': sessionId } : {},
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
    const session = response.headers.get('mcp-session-id') ?? sessionId
    const type = response.headers.get('content-type') ?? ''
    let text = await response.text()
    if (type.includes('text/event-stream')) {
      const payloads = text.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trim())
      text = payloads.at(-1) ?? ''
    }
    if (!text) return { body: undefined, session }
    return { body: JSON.parse(text), session }
  }
  await call({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18',
    capabilities: {}, clientInfo: { name: 'superagent-adapter', version: '1.0.0' } } })
  const listed = await call({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
  const tools = listed.body?.result?.tools
  return Array.isArray(tools) ? tools.map(tool => tool.name).filter(name => typeof name === 'string') : []
  } catch {
    return []
  }
}

/** Writes one transcript line. Everything the runner reads is NDJSON on stdout. */
export const emit = value => { process.stdout.write(`${JSON.stringify(value)}\n`) }

/**
 * Writes the init event the runner reads first.
 *
 * `tools` is what the CLI can actually call: the engine's own tools, prefixed as Claude Code prefixes them, plus
 * nothing else. Reporting a built-in here would get the router refused, which is the check working as intended.
 */
export const emitInit = ({ sessionId, tools, serverName = 'superagent', status = 'connected' }) => {
  emit({
    type: 'system',
    subtype: 'init',
    session_id: sessionId ?? '',
    tools: tools.map(name => `mcp__${serverName}__${name}`),
    mcp_servers: [{ name: serverName, status }],
    model: undefined,
  })
}

/** Writes a transcript event in the shape the runner stores. */
export const emitEvent = (type, data) => { emit({ type, ...data }) }

/** Ends the turn the way the runner reads it: a message on stderr and a non-zero exit code. */
export function fail(message, code = 1) {
  process.stderr.write(`${message.trim()}\n`)
  process.exit(code)
}

/**
 * The system prompt and the prompt as one block.
 *
 * CLIs without a system-prompt flag take their instructions in the prompt, so the adapter puts them there under a
 * heading that reads as instructions rather than as part of the request.
 */
export function joinPrompt(systemPrompt, prompt) {
  if (!systemPrompt) return prompt
  return `<instructions>\n${systemPrompt}\n</instructions>\n\n${prompt}`
}

/** Runs a child process and forwards its stdout lines to `onLine`. */
export function run(command, args, options, onLine) {
  return import('node:child_process').then(({ spawn }) => new Promise(resolve => {
    const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] })
    let buffer = ''
    let stderr = ''
    let settled = false
    /** Resolves the turn once, flushing the last partial line; later events are ignored. */
    const settle = (code, message) => {
      if (settled) return
      settled = true
      if (message) stderr += message
      if (buffer.trim()) { onLine(buffer); buffer = '' }
      resolve({ code, stderr })
    }
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', chunk => {
      buffer += chunk
      let index
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index)
        buffer = buffer.slice(index + 1)
        if (line.trim()) onLine(line)
      }
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('error', error => settle(1, error.message))
    // A turn ends when the CLI exits. `close` waits for every pipe to close too, and a grandchild that inherited
    // them (an MCP server, a sign-in helper) can outlive the CLI for minutes — the turn would look like it never ended.
    child.on('exit', code => setTimeout(() => settle(code ?? 1), 250))
    child.on('close', code => settle(code ?? 1))
    for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal))
  }))
}
