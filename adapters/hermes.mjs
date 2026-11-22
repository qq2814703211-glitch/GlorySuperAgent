#!/usr/bin/env node
import { execFile } from 'node:child_process'
import { parseArgs, promisify } from 'node:util'
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const execute = promisify(execFile)
const strings = ['output-format', 'system-prompt', 'model', 'effort', 'resume', 'session-id', 'tools', 'mcp-config',
  'router-state', 'provider', 'base-url', 'hermes-bin']
const switches = ['verbose', 'strict-mcp-config', 'disable-slash-commands']

export function parseTurn(args) {
  const { values } = parseArgs({ args, options: {
    ...Object.fromEntries(strings.map(name => [name, { type: 'string' }])),
    ...Object.fromEntries(switches.map(name => [name, { type: 'boolean' }])),
    prompt: { short: 'p', type: 'string' }, context: { type: 'string', multiple: true },
  } })
  if (!values.prompt || values.tools !== '' || !values['strict-mcp-config'] || !values['disable-slash-commands'] ||
      values['output-format'] !== 'stream-json') throw new Error('Hermes requires a strict router turn')
  if (!isAbsolute(values['router-state'] ?? '')) throw new Error('Configure an absolute private --router-state directory')
  const session = values.resume ?? values['session-id']
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(session ?? '') || Boolean(values.resume) === Boolean(values['session-id'])) {
    throw new Error('Expected one router session identifier')
  }
  let servers
  try { servers = JSON.parse(values['mcp-config']).mcpServers } catch {}
  const server = servers?.superagent
  if (Object.keys(servers ?? {}).length !== 1 || server?.type !== 'http' ||
      !/^Bearer [\w.-]+$/.test(server.headers?.authorization ?? '') ||
      !/^http:\/\/127\.0\.0\.1:\d+\/mcp$/.test(server.url)) throw new Error('Expected the authenticated loopback engine MCP server')
  return { values, session, server }
}

async function engineTools(server) {
  const client = new Client({ name: 'superagent-hermes', version: '1' })
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(server.url), {
      requestInit: { headers: { authorization: server.headers.authorization }, redirect: 'error' },
    }))
    const { tools, nextCursor } = await client.listTools()
    if (!tools.length || nextCursor || tools.some(tool => !/^\w+$/.test(tool.name))) throw new Error()
    return tools.map(tool => tool.name)
  } catch { throw new Error('Unable to enumerate engine MCP tools') } finally { await client.close() }
}

export function verifyTools(listing, expected) {
  const actual = [...listing.matchAll(/^\s*\* (\S+)\s+- /gm)].map(match => match[1]).sort()
  const allowed = expected.map(name => `mcp_superagent_${name}`).sort()
  if (!actual.length || actual.length !== allowed.length || actual.some((name, index) => name !== allowed[index])) {
    throw new Error('Hermes tool inventory differs from the engine MCP inventory')
  }
}

export function translate(stdout, expected) {
  let events
  try { events = stdout.trim().split('\n').map(line => JSON.parse(line)) }
  catch { throw new Error('Invalid Hermes event stream') }
  const first = events.shift()
  const last = events.at(-1)
  if (first?.type !== 'system' || first.subtype !== 'init' || last?.type !== 'result' || last.exit_code !== 0 ||
      !last.session_id || last.error) throw new Error('Hermes did not finish its turn successfully')
  for (const event of events) {
    if (['tool_use', 'tool_result'].includes(event.type) && !expected.includes(event.name)) {
      throw new Error('Hermes reported a tool outside its verified inventory')
    }
  }
  return { events, nativeSession: last.session_id }
}

async function main() {
  const { values, session, server } = parseTurn(process.argv.slice(2))
  const root = values['router-state']
  await mkdir(root, { recursive: true, mode: 0o700 })
  const home = join(root, session)
  if (!values.resume) await mkdir(home, { mode: 0o700 })
  const nativeSession = values.resume && await readFile(join(home, 'router-session'), 'utf8')
  const tools = await engineTools(server)
  const config = { tools: { tool_search: { enabled: 'off' } }, platform_toolsets: { cli: ['mcp-superagent'] },
    mcp_servers: { superagent: { url: server.url, headers: { Authorization: server.headers.authorization },
      tools: { include: tools, prompts: false, resources: false, events: false } } } }
  const scratch = await mkdtemp(join(home, '.config-'))
  const configPath = join(home, 'config.yaml')
  let injected = false
  try {
    try {
      await writeFile(join(scratch, 'config'), JSON.stringify(config), { mode: 0o600 })
      await rename(join(scratch, 'config'), configPath)
      injected = true
    } catch { throw new Error('Unable to inject engine MCP configuration into the router profile') }
    const keys = ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'SYSTEMROOT', 'SSL_CERT_FILE', 'REQUESTS_CA_BUNDLE',
      'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY']
    const env = Object.fromEntries(keys.filter(key => process.env[key]).map(key => [key, process.env[key]]))
    env.HERMES_HOME = home
    const bin = values['hermes-bin'] ?? 'hermes'
    const args = ['chat', '--toolsets', 'mcp-superagent']
    const options = { env, maxBuffer: 8 << 20, encoding: 'utf8' }
    const listing = await execute(bin, [...args, '--list-tools'], { ...options, timeout: 30000 })
      .catch(() => { throw new Error('Hermes tool inventory unavailable') })
    verifyTools(listing.stdout, tools)
    const context = await Promise.all((values.context ?? []).map(path => readFile(path, 'utf8')))
    const prompt = [values['system-prompt'], ...context, values.prompt].filter(Boolean).join('\n\n')
    args.push('--oneshot', '--format', 'stream-json', '--in', process.cwd(), '-q', prompt)
    for (const [flag, value] of [['--model', values.model], ['--provider', values.provider], ['--base-url', values['base-url']],
      ['--reasoning', values.effort], ['--resume', nativeSession]]) if (value) args.push(flag, value)
    console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: session,
      tools: tools.map(name => `mcp__superagent__${name}`), mcp_servers: [{ name: 'superagent', status: 'connected' }] }))
    const { stdout } = await execute(bin, args, options).catch(() => { throw new Error('Hermes chat failed') })
    const turn = translate(stdout, tools.map(name => `mcp_superagent_${name}`))
    await writeFile(join(home, 'router-session'), turn.nativeSession, { mode: 0o600 })
    for (const event of turn.events) console.log(JSON.stringify({ ...event, type: `hermes/${event.type}` }))
  } finally {
    if (injected) await rm(configPath, { force: true })
    await rm(scratch, { recursive: true, force: true })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1 })
}
