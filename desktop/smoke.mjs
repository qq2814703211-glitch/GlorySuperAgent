import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { chromium, _electron as electron } from 'playwright-core'

const [executablePath, baseline] = process.argv.slice(2)
const state = await mkdtemp(join(tmpdir(), 'superagent-smoke-'))
const environment = { ...process.env, SUPERAGENT_STATE_DIR: join(state, 'state') }
const output = resolve('.artifacts/comparison')
await mkdir(output, { recursive: true })
async function capture(page, name) {
  await page.emulateMedia({ colorScheme: 'light' })
  await page.locator('#dt-tab-overview').click()
  await page.locator('.dt-stat-value').first().waitFor()
  await page.screenshot({ path: join(output, `${name}.png`), scale: 'css' })
}
if (baseline) {
  const child = spawn(process.execPath, ['scripts/superagent.mjs', '--port', '0', '--no-open'], {
    cwd: baseline, env: { ...environment, SUPERAGENT_STATE_DIR: join(state, 'before') }, stdio: ['ignore', 'pipe', 'inherit'],
  })
  const browser = await chromium.launch({ channel: 'chrome', chromiumSandbox: true })
  try {
    let origin
    for await (const line of createInterface({ input: child.stdout })) {
      origin = /Open the panel at (http:\/\/127\.0\.0\.1:\d+\/)/.exec(line)?.[1]
      if (origin) break
    }
    assert.ok(origin, 'Baseline did not start')
    const page = await browser.newPage({ viewport: { width: 1100, height: 720 }, locale: 'en-US' })
    await page.goto(origin)
    await capture(page, 'before')
  } finally { await browser.close(); child.kill() }
}
const application = await electron.launch({ executablePath, env: environment, chromiumSandbox: true, timeout: 45000 })
try {
  const page = await application.firstWindow({ timeout: 45000 })
  await capture(page, 'after')
  const origin = new URL(page.url()).origin
  assert.equal((await fetch(origin)).status, 403)
  assert.equal(await page.evaluate(() => typeof globalThis.require), 'undefined')
  await page.locator('#dt-tab-settings').click()
  await page.getByRole('tab', { selected: true }).first().waitFor()
} finally { await application.close() }
