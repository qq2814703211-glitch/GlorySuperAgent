import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { build as bundle } from 'tsdown'
import electronBuilder from 'electron-builder'

const { build } = electronBuilder

const manifest = JSON.parse(await readFile('package.json', 'utf8'))
const out = resolve('.artifacts/installers')
await mkdir(out, { recursive: true })
const dir = await mkdtemp(join(out, 'stage-'))

// Same app payload the portable build ships, so both forms expose identical code.
try {
  await bundle({
    config: false,
    entry: { standalone: 'src/standalone.ts' },
    outDir: join(dir, 'lib'),
    platform: 'node',
    format: 'esm',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    deps: { alwaysBundle: [/^(?!node:)/] },
  })
  for (const asset of ['desktop/main.mjs', 'desktop/options.mjs', 'desktop/dist', 'scripts/router-cli.mjs', 'prompts', 'skills', 'locale', 'LICENSE']) {
    await cp(asset, join(dir, asset), { recursive: true })
  }
  await writeFile(join(dir, 'package.json'), JSON.stringify({
    name: manifest.name,
    version: manifest.version,
    type: 'module',
    main: 'desktop/main.mjs',
    productName: 'GlorySuperAgent',
    description: 'GlorySuperAgent desktop client',
    author: { name: 'GloryCode', email: 'glorycode@users.noreply.github.com' },
    homepage: 'https://github.com/qq2814703211-glitch/GlorySuperAgent',
  }, null, 2))

  await build({
    config: {
      appId: 'org.glorysuperagent.desktop',
      productName: 'GlorySuperAgent',
      copyright: 'GloryCode',
      icon: 'desktop/build/icon.png',
      electronVersion: manifest.devDependencies.electron,
      directories: { app: dir, output: out },
      files: ['**/*'],
      asar: true,
      npmRebuild: false,
      publish: null,
      mac: {
        target: ['dmg'],
        category: 'public.app-category.developer-tools',
        identity: null,
      },
      dmg: { title: 'GlorySuperAgent ${version}' },
      win: {
        target: ['nsis'],
      },
      nsis: {
        oneClick: false,
        perMachine: false,
        allowToChangeInstallationDirectory: true,
        createDesktopShortcut: true,
        createStartMenuShortcut: true,
        shortcutName: 'GlorySuperAgent',
      },
      linux: {
        target: ['deb', 'AppImage'],
        category: 'Development',
        maintainer: 'GloryCode <glorycode@users.noreply.github.com>',
        synopsis: 'GlorySuperAgent desktop client',
      },
    },
  })
} finally {
  await rm(dir, { recursive: true, force: true })
}
