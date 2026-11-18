/**
 * Which harness runs a ticket.
 *
 * A request may name the CLI that runs it, so one repository can send a hard refactor to one CLI and a quick fix to
 * another. The name travels in the request text, which every Source already carries: a leading `[name]`, or `harness=name`
 * anywhere in it. A request that names none runs on the operator's default.
 *
 * The name is not interpreted here beyond its shape: whether `codex` exists is the runner's table, and a name the table
 * does not hold falls back to the default rather than failing a ticket that a person asked for.
 */

/** How a harness is named in a request: a leading `[name]`, or `harness=name` in the text. */
const LEADING = /^\s*\[([a-z0-9][a-z0-9_-]*)\]/i
const ANYWHERE = /\bharness\s*=\s*([a-z0-9][a-z0-9_-]*)/i

/** The harness a request names, in lower case, or `undefined` when it names none. */
export function namedHarness(text: string): string | undefined {
  const match = LEADING.exec(text) ?? ANYWHERE.exec(text)
  return match?.[1]?.toLowerCase()
}

/** The request text without the marker, so the title and the prompt do not carry it. */
export function withoutHarness(text: string): string {
  return text.replace(LEADING, '').replace(ANYWHERE, '').replace(/\s{2,}/g, ' ').trim()
}
