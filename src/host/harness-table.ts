import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import type { CliConfig } from '../runner/cli/claude.ts'

interface HarnessTable {
  router?: CliConfig
  default?: string
  harnesses?: Record<string, CliConfig>
  tests?: { model?: string }
}

export function readHarnessTable(file: string): HarnessTable {
  const table: HarnessTable = JSON.parse(readFileSync(file, 'utf8'))
  const prefix = '${tableDir}/'
  const expand = (value: string) => value.startsWith(prefix) ? resolve(dirname(file), value.slice(prefix.length)) : value
  if (!table.harnesses) return table
  for (const [name, entry] of Object.entries(table.harnesses)) {
    table.harnesses[name] = { ...entry, ...entry.args && { args: entry.args.map(expand) },
      ...entry.readable && { readable: entry.readable.map(expand) } }
  }
  return table
}
