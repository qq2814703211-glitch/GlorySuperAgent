# Adapters: Codex, DeepSeek Harness, Antigravity — and dispatch

The engine runs its agents over the **Claude Code turn contract**: one process per turn, the prompt on argv, newline
delimited JSON on stdout, and an init event first. Only `claude` speaks that natively. The three adapters here are
translators: same contract on the outside, a different CLI underneath.

```
engine  ──turn contract──▶  adapters/<cli>.mjs  ──native argv──▶  codex │ dsh │ agy
                                   │
                                   └── MCP over HTTP ──▶ engine tools (orchestrator_*)
```

## Why the worker slot and not the router slot

The router reads text from strangers, so the host demands proof that the CLI ran with **no built-in tools** and only the
engine's own. `claude` can prove that (`--tools '' --strict-mcp-config`). None of Codex, dsh or `agy` can: they always
bring a shell and a filesystem.

So they are wired as **workers only**, through `--worker-cli`, which this fork adds:

```sh
# router = Claude Code (only CLI that can prove it holds no tool), worker = the adapter
./start.command --cli claude --worker-cli "$PWD/adapters/codex.mjs"
```

`src/runner/cli/claude.ts` picks the CLI by role, and `src/standalone.ts` names it when it confines the turn. Without
`--worker-cli`, the router's CLI runs both, exactly as before.

## The three adapters

### Experimental Hermes router

The standalone launcher accepts an inline `router` entry or the name of an entry in `routers`. For example, an operator's harness file can contain:

```json
{
  "router": "hermes",
  "routers": {
    "claude": { "command": "claude" },
    "hermes": {
      "command": "/opt/node/bin/node",
      "args": ["/opt/superagent/adapters/hermes.mjs", "--router-state", "/var/lib/hermes-router", "--context", "/opt/router-notes/MEMORY.md"],
      "readable": ["/opt/superagent", "/opt/router-notes/MEMORY.md", "/opt/hermes"],
      "state": ["/var/lib/hermes-router"]
    }
  }
}
```

Set installation paths for the local host and retain the worker entries and default. `--context` can be repeated for operator-selected knowledge files whose contents may be sent to the configured model. Use a private router state directory. Each new session creates its own Hermes home there. `--hermes-bin`, `--provider` and `--base-url` may be supplied in the entry's arguments. `model` and `effort` are passed to Hermes chat.

For a custom provider, set `--provider-profile /path/to/profile --provider NAME`. Give the router read access to that profile's `config.yaml` and `.env`, not write access. Only the selected provider's HTTPS endpoint, API mode and key are copied into the turn's private configuration. The adapter reads the key variable named by `key_env` or `api_key_env`; `--provider-key-env VARIABLE` selects it explicitly. Do not pass key values in the harness file or on the command line. The original profile's tools, other providers and unrelated secrets are not imported.

The adapter checks the CLI's tool listing before passing the prompt. A missing inventory or one that differs from the authenticated engine listing aborts the turn. The v0.23.3 client generates this listing outside the gateway session. The gateway's effective tool set, resume after credential rotation, and a real router decision still need validation before deployment. Run `node --test adapters/test/hermes.test.mjs` for the adapter checks.

| Adapter | CLI it drives | MCP to the engine tools | Session resume | State |
| --- | --- | --- | --- | --- |
| `codex.mjs` | `codex exec --json` | yes — `-c mcp_servers.<name>.url` + `http_headers` | `codex exec resume <id>` | flags translated and exercised; the signed-in route answers |
| `dsh.mjs` | `dsh --profile headless --json` | **no** — the headless profile ships no MCP plugin | `--session-id <id>` | events mapped, failure-in-zero-exit handled; no `DEEPSEEK_API_KEY` yet |
| `agy.mjs` | `agy -p ... --output-format stream-json` | yes, but globally: `agy mcp add` writes `~/.gemini/config/mcp_config.json`, so turns take a lock and clean up | `--conversation <id>` | wired and calling engine tools; see the permission note below |

### Per-ticket harness

A request may name the CLI that runs it, so one repository can send a hard refactor to one CLI and a quick fix to
another:

```
[antigravity] fix the flaky test
fix it harness=codex please
```

`src/core/harnesses.ts` reads the marker, the ticket keeps it (`ticket.harness`), and the runner runs that entry of
`harnesses.json` for the worker turn. A ticket that names none runs `default`; a name the table does not hold falls back
to `default` rather than failing the ticket.

`harnesses.json` at the repository root is the table: `router` (the CLI that reads text from strangers), `default`, and
one entry per harness with `command`, `args`, `model`, `effort`, `readable` and `state`. `readable` and `state` matter:
the host's seatbelt denies the home directory, so a CLI's own install and state have to be named or a working CLI turns
into a turn that dies on `EACCES`.

In worker `args` and `readable`, `${tableDir}/` denotes the directory containing the table. The bundled adapter paths therefore work in any checkout directory. Absolute paths and arguments without this prefix are unchanged.

A Hermes router entry needs three things named besides its own data root: the CLI checkout (`~/.hermes/hermes-agent`),
the managed tool tree (`~/.hermes/tools` — launch-time PM activation reads it, and a refused read is reported as
`Gateway draining: update_paused`, not as a permissions error), and the prepared data root in **both** `readable` and
`state`. The data root has to sit outside the host's state directory: the seatbelt denies that directory after the
allow rules, and the last match wins, so anything under it stays unreadable however it is listed.

**The router is not the commander.** It is the gatekeeper that reads untrusted text: one turn, no memory, no built-in
tool, one repository. The commander is the operator's agent, which decides what to dispatch and to whom — and the harness
marker is how that decision reaches the pipeline.

What the contract test (`node adapters/test/conformance.mjs`, 34 checks) proves, against fake CLIs and a fake MCP
server: flag translation, the init event, the tool list coming from the engine's server, session propagation, MCP wiring,
the failure path, and the `agy` lock/cleanup. It does **not** prove any real model call — that is what the auth walls
above block.

### Per-CLI notes

**Codex** — `--verbose` is dropped, `--system-prompt` is prepended to the prompt (codex has no system-prompt flag), and
the session id is the `thread.started` event's `thread_id`. `SA_CODEX_SANDBOX` picks codex's inner sandbox, and it
defaults to `danger-full-access`: codex's own `workspace-write` sandbox **quietly refuses every MCP tool call**, after
which the model reports the engine's tools as unavailable and the turn ends "successfully" with no report. The host's
seatbelt is the confinement that matters, and it wraps the whole process.

**DeepSeek Harness** — `dsh` exits **0 even when the turn failed** and reports the failure in the `final` event, so the
adapter reads the reason kind, not the exit code. It has no MCP wiring yet: the headless profile has no MCP plugin, so an
agent driven through dsh can edit code but **cannot call `orchestrator_report`**, which is how a worker reports back.
Until that plugin is wired, dsh is a useful worker for local work and a poor one for tickets.

**Antigravity** — `agy` is the closest to Claude Code (`-p`, `--output-format stream-json`, `--disable-slash-commands`,
`--add-dir`, `--model`, `--effort`), but it rejects `--verbose` outright (Go flag parsing) and has no per-turn MCP flag.
The engine gives every agent its own token, and `agy` reads one global MCP file, so the adapter serialises agy turns
behind `~/.gemini/config/.superagent-adapter.lock`, adds a per-process server name, and removes it in a `finally`.

## Dispatch: the commander hands work over on GitHub

`adapters/dispatch.mjs` files the task as an issue that mentions the agent account — the same path a person uses, so
there is one inbox, one policy and one history, and no engine change:

```sh
node adapters/dispatch.mjs --repo owner/name --agent-login agent-bot --task "fix the flaky test" --wait
node adapters/dispatch.mjs --tickets          # what the host has right now
node adapters/dispatch.mjs ... --dry-run      # the gh command it would run
```

It reads `panel-token` from the state directory and polls `GET /orchestrator/api/tickets`, so it needs nothing but `gh`
and a running host.

**What this path costs:** a poll interval (60 s by default) and one Eval turn before the worker starts. The alternative —
an engine route that creates a Ticket directly — skips both but adds an API, its authorization and a second way into the
policy. The GitHub path was chosen for the smaller surface; say the word and the direct route can be added beside it.
