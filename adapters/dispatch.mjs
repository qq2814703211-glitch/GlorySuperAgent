#!/usr/bin/env node
/**
 * The commander's dispatch: hand work to the agent the way a person does — by mentioning it on GitHub.
 *
 * This is the smallest dispatch path that needs no change to the engine: an issue that mentions the agent account is a
 * Trigger, Eval turns it into a Ticket, the Executor runs the worker CLI, and the answer comes back on the issue. The
 * panel is the same list for both, so a task dispatched here and a task a human asked for are one inbox with one history.
 *
 *   node adapters/dispatch.mjs --repo owner/name --agent-login superagent-bot --task "fix the flaky test"
 *   node adapters/dispatch.mjs --repo owner/name --agent-login superagent-bot --task "..." --dry-run
 *   node adapters/dispatch.mjs --tickets            # what the host has now
 *
 * Environment:
 *   SUPERAGENT_API          the host's management address (default: http://127.0.0.1:3082)
 *   SUPERAGENT_STATE_DIR    where panel-token lives (default: ~/.superagent)
 *   SUPERAGENT_AGENT_LOGIN  the agent account, when --agent-login is not given
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)
const api = (process.env.SUPERAGENT_API ?? 'http://127.0.0.1:3082').replace(/\/$/, '')
const stateDir = process.env.SUPERAGENT_STATE_DIR ?? join(homedir(), '.superagent')

/** Reads the panel token the host wrote; the management API authorizes with it. */
function token() {
  try { return readFileSync(join(stateDir, 'panel-token'), 'utf8').trim() } catch {
    throw new Error(`no panel token at ${stateDir}/panel-token — is the host running?`)
  }
}

/** Calls the host's management API the way the panel does. */
async function host(path, init = {}) {
  const response = await fetch(`${api}/orchestrator/api${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token()}`, 'x-orchestrator-request': '1', origin: api, 'content-type': 'application/json',
      ...init.headers },
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`${response.status} ${text.slice(0, 300)}`)
  return text ? JSON.parse(text) : undefined
}

/** Reads the flags. */
function options(argv) {
  const values = { wait: false, dryRun: false, tickets: false, timeout: 1800, interval: 10 }
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]
    const next = () => argv[++index]
    if (argument === '--repo') values.repo = next()
    else if (argument === '--agent-login') values.agent = next()
    else if (argument === '--task') values.task = next()
    else if (argument === '--title') values.title = next()
    else if (argument === '--timeout') values.timeout = Number(next())
    else if (argument === '--interval') values.interval = Number(next())
    else if (argument === '--wait') values.wait = true
    else if (argument === '--dry-run') values.dryRun = true
    else if (argument === '--tickets') values.tickets = true
    else if (argument === '--help' || argument === '-h') { values.help = true }
    else throw new Error(`Unknown option: ${argument}`)
  }
  return values
}

const values = options(process.argv.slice(2))
if (values.help) {
  console.log('Usage: dispatch --repo owner/name --agent-login NAME --task TEXT [--title T] [--wait] [--timeout S] [--dry-run]')
  console.log('       dispatch --tickets')
  process.exit(0)
}

if (values.tickets) {
  const list = await host('/tickets?limit=20')
  for (const ticket of list.tickets ?? list.items ?? []) {
    console.log(`${ticket.id}\t${ticket.state}\t${ticket.title}`)
  }
  process.exit(0)
}

if (!values.repo || !values.task) throw new Error('--repo and --task are required')
const agent = values.agent ?? process.env.SUPERAGENT_AGENT_LOGIN
if (!agent) throw new Error('--agent-login (or SUPERAGENT_AGENT_LOGIN) is required: the issue has to mention the agent account')

const title = values.title ?? values.task.split('\n')[0].slice(0, 72)
const body = `@${agent} ${values.task}`
const args = ['issue', 'create', '--repo', values.repo, '--title', title, '--body', body]
if (values.dryRun) {
  console.log(`gh ${args.map(part => /\s/.test(part) ? JSON.stringify(part) : part).join(' ')}`)
  process.exit(0)
}

// The issue is the dispatch: the agent's Source picks it up on its next poll.
const { stdout } = await run('gh', args, { timeout: 60_000, encoding: 'utf8' })
const issue = stdout.trim().split('\n').at(-1) ?? ''
console.log(`dispatched: ${issue}`)

if (!values.wait) process.exit(0)

// Wait for the Ticket the issue becomes, then for its end.
const deadline = Date.now() + values.timeout * 1000
let ticketId
while (Date.now() < deadline) {
  const list = await host('/tickets?limit=50')
  const tickets = list.tickets ?? list.items ?? []
  const match = ticketId ? tickets.find(ticket => ticket.id === ticketId) : tickets.find(ticket => ticket.title === title)
  if (match) {
    ticketId = match.id
    if (match.state === 'ended') {
      const page = await host(`/tickets/${encodeURIComponent(match.id)}`)
      const ticket = page.ticket ?? page
      console.log(`ended: ${match.id}`)
      console.log(`stage: ${ticket.stage ?? match.stage ?? 'unknown'}`)
      if (ticket.summary) console.log(`summary: ${ticket.summary}`)
      if (ticket.note) console.log(`note: ${JSON.stringify(ticket.note)}`)
      if (ticket.directory) console.log(`directory: ${ticket.directory}`)
      process.exit(0)
    }
    console.log(`ticket ${match.id}: ${match.state}`)
  }
  await new Promise(resolve => { setTimeout(resolve, values.interval * 1000) })
}
console.error(`no ended ticket for "${title}" within ${values.timeout}s`)
process.exit(1)
