import { readFileSync } from 'node:fs'
import { defineConfig } from 'vitest/config'

/**
 * The route the CLI tests start the real coding agent with.
 *
 * On a gateway machine the CLI's own default model can be one the gateway does not serve, and then every test that
 * starts it waits for a turn that never answers. The suite runs the route the host itself is configured with, unless
 * the environment names ANTHROPIC_MODEL.
 */
const testModel = (() => {
  try {
    const table = JSON.parse(readFileSync(new URL('./harnesses.json', import.meta.url), 'utf8'))
    // The suite starts a real agent and needs a model that follows tool instructions; `tests.model` names it, and falls
    // back to the router's route when the file names none.
    return table.tests?.model ?? table.router?.model
  } catch { return undefined }
})()

// Share one React instance across DSH client packages and tests.
export default defineConfig({ resolve: { dedupe: ['react', 'react-dom'] },
  test: { include: ['tests/**/*.spec.{ts,tsx}'],
    env: testModel && !process.env.ANTHROPIC_MODEL ? { ANTHROPIC_MODEL: testModel } : {} } })
