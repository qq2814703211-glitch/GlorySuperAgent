import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { defaultHarnessFile } from '../scripts/router-cli.mjs'

describe('defaultHarnessFile', () => {
  it('uses the harness table in the state directory when nobody named one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sa-harness-'))
    const file = join(dir, 'harnesses.json')
    writeFileSync(file, '{}\n')
    expect(defaultHarnessFile(dir)).toBe(file)
    expect(defaultHarnessFile(join(dir, 'absent'))).toBeUndefined()
  })
})
