import { readFileSync } from 'node:fs'

/** Reads the command's options; each has a default and an environment variable. */
function options(argv) {
  const values = {}
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]
    if (argument === '--state-dir') values.stateDir = argv[++index]
    else if (argument === '--port') values.port = Number(argv[++index])
    else if (argument === '--cli') values.cli = argv[++index]
    else if (argument === '--cli-model') values.cliModel = argv[++index]
    else if (argument === '--worker-cli') values.workerCli = argv[++index]
    else if (argument === '--worker-cli-model') values.workerCliModel = argv[++index]
    else if (argument === '--harnesses') values.harnesses = argv[++index]
    else if (argument === '--default-harness') values.defaultHarness = argv[++index]
    else if (argument === '--sandbox') values.sandbox = argv[++index]
    else if (argument === '--allow-read') (values.readable ??= []).push(argv[++index])
    else if (argument === '--allow-write') (values.writable ??= []).push(argv[++index])
    else if (argument === '--help' || argument === '-h') {
      console.log('Usage: Superagent [--state-dir DIR] [--port N] [--cli COMMAND] [--cli-model MODEL] [--sandbox auto|seatbelt|bubblewrap|off] [--allow-read PATH] [--allow-write PATH]')
      process.exit(0)
    } else throw new Error(`Unknown option: ${argument}`)
  }
  return values
}

/** A JSON file of harness entries: `{ router?, default, harnesses: { name: { command, args?, model?, effort?, readable?, state? } } }`. */
export function hostOptions(argv) {
  const values = options(argv)
  const harnessFile = values.harnesses ?? process.env.SUPERAGENT_HARNESSES
  const harnessTable = harnessFile ? JSON.parse(readFileSync(harnessFile, 'utf8')) : undefined
  const stateDir = values.stateDir ?? process.env.SUPERAGENT_STATE_DIR
  const port = values.port ?? (process.env.SUPERAGENT_PORT ? Number(process.env.SUPERAGENT_PORT) : undefined)
  const routerEntry = harnessTable?.router
  const cli = values.cli ?? process.env.SUPERAGENT_CLI ?? routerEntry?.command
  const cliModel = values.cliModel ?? process.env.SUPERAGENT_CLI_MODEL ?? routerEntry?.model
  const workerCli = values.workerCli ?? process.env.SUPERAGENT_WORKER_CLI
  const defaultHarness = values.defaultHarness ?? process.env.SUPERAGENT_DEFAULT_HARNESS ?? harnessTable?.default
  const workerCliModel = values.workerCliModel ?? process.env.SUPERAGENT_WORKER_CLI_MODEL
  const sandbox = values.sandbox ?? process.env.SUPERAGENT_SANDBOX
  return {
    ...stateDir ? { stateDir } : {}, port: port ?? 0,
    ...sandbox ? { sandbox } : {},
    ...values.readable || values.writable ? { sandboxExtras: { readable: values.readable ?? [], writable: values.writable ?? [] } } : {},
    ...cli ? { cli: { command: cli, ...cliModel ? { model: cliModel } : {} } } : {},
    ...workerCli ? { workerCli: { command: workerCli, ...workerCliModel ? { model: workerCliModel } : {} } } : {},
    ...harnessTable?.harnesses ? { harnesses: harnessTable.harnesses } : {},
    ...defaultHarness ? { defaultHarness } : {},
  }
}
