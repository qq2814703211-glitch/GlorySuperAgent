import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { packager } from '@electron/packager'
import { build } from 'tsdown'

const manifest = JSON.parse(await readFile('package.json', 'utf8'))
const out = resolve('.artifacts/desktop')
await mkdir(out, { recursive: true })
const dir = await mkdtemp(join(out, 'stage-'))
try {
  await build({ config: false, entry: { standalone: 'src/standalone.ts' }, outDir: join(dir, 'lib'),
    platform: 'node', format: 'esm', target: 'es2024', fixedExtension: false, dts: false,
    deps: { alwaysBundle: [/^(?!node:)/] } })
  for (const asset of ['desktop/main.mjs', 'desktop/options.mjs', 'desktop/dist', 'scripts/router-cli.mjs', 'prompts', 'skills', 'locale', 'LICENSE']) {
    await cp(asset, join(dir, asset), { recursive: true })
  }
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name: manifest.name, version: manifest.version,
    type: 'module', main: 'desktop/main.mjs', productName: 'GlorySuperAgent' }))
  await packager({ dir, out, name: 'GlorySuperAgent', appBundleId: 'org.glorysuperagent.desktop',
    electronVersion: manifest.devDependencies.electron, asar: true, prune: false, overwrite: true })
} finally { await rm(dir, { recursive: true, force: true }) }
