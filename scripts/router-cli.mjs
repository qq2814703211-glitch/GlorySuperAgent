import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export function routerCli(table, command, model) {
  const selected = table?.router
  const entry = typeof selected === 'string' ? table.routers?.[selected] : selected
  if (selected != null && (typeof entry?.command !== 'string' || !entry.command)) {
    throw new Error('The router must be a command entry or the name of an entry in routers')
  }
  if (!command && !entry) return undefined
  const cli = command && command !== entry?.command ? { command } : { ...entry }
  const routeModel = model ?? entry?.model
  return { ...cli, ...routeModel ? { model: routeModel } : {} }
}

/** The harness table next to the state directory, when the operator did not name one. A Dock launch has no environment. */
export function defaultHarnessFile(stateDir, exists = existsSync) {
  const file = join(stateDir || join(homedir(), '.superagent'), 'harnesses.json')
  return exists(file) ? file : undefined
}
