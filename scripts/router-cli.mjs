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
