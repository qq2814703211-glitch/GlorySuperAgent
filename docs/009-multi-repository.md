# One host, several repositories

The Source has always assumed a single repository: `Deployment.repository` is read by the GitHub Source, the
command builders, the worker environment and the pull-request checks. A deployment that watches two
repositories cannot be expressed, and two hosts would mean two panels and two commanders.

This is the design for making one host serve an ordered list of repositories, with every ticket knowing
which repository it belongs to.

## 1. Configuration

`GithubAccountsSchema.repository` keeps its key and its place in the settings form, and its value becomes a
comma, space or newline separated list of `owner/name` entries. The schema trims, drops empty entries,
lower-cases for comparison but stores as typed, and rejects any entry that does not match `owner/name`.
Duplicate entries collapse to the first occurrence; the order is the operator's and is preserved.

`Deployment` gains `repositories: readonly string[]` and keeps `repository: string` as `repositories[0]` so
existing single-repository code paths keep working unchanged. Setup fails with a named problem when the list
is empty, and the panel's field hint says the list is allowed.

## 2. Thread identity

A thread id is currently `String(issue.number)`, so issue 42 in two repositories is one thread. Every GitHub
thread id becomes qualified:

- issue or pull request: `<owner>/<name>#<number>`
- CI on a branch: `<owner>/<name>#ci:<branch>`

Trigger ids are built with the repository as well (`key('github-issue', repository, String(number))` and the
same for comments, CI and pull requests), so a trigger from one repository never deduplicates against one
from another.

Two helpers live next to `githubAddress` in `src/sources/github-trigger.ts`:

- `threadId(repository: string, number: number): string`
- `repositoryOfThread(id: string): string | undefined` — the part before `#`, or `undefined` when the id is
  not qualified.

## 3. Source polling

The Source polls each configured repository on its own schedule state: the cursor entry, the ETag and the
retry record are keyed by repository, so a slow or failing repository never holds another one's cursor
back. `pollSeconds`, `failuresBeforeError` and the observation switches stay deployment-wide.

Health reports one line per repository.

## 4. Commands

`src/infra/commands.ts` exposes `get repository()` from the deployment. It is replaced by a per-call
`repository` argument on the methods that build API paths (`api`, `repositoryPath`, and anything that
interpolates `repos/<owner>/<name>`), or by constructing the command object for a repository
(`commands.forRepository(repository)`) where a source handles one repository per poll round. No call site may
read a repository from the deployment when the message it is handling carries one.

## 5. The worker

`DSH_SUPERAGENT_GITHUB_REPOSITORY` is the repository of the ticket's primary thread, not the deployment's
first repository. Every other GitHub environment value (account, commit email, number) is unchanged.

The ticket workspace already isolates a ticket's files; nothing there changes. A prepare command that needs
to clone can read `DSH_SUPERAGENT_GITHUB_REPOSITORY`.

## 6. Pull requests

`pullEndNotices(ticket, request, repository)` and the "opened by the agent account from this repository"
check take the ticket's repository. The same applies to the commit URL in status messages.

## 7. Stored state

`SCHEMA_VERSION` goes from 11 to 12, and the migration prefixes every existing GitHub thread id that is not
already qualified with the deployment's primary repository (the number-only ids the old code wrote). Trigger
and ticket rows keep their ids: only thread ids change, so triggers that still point at a number-only thread
resolve through the same prefixing rule.

An unqualified thread id read from a database that claims schema 12 is treated as a foreign key violation and
fails loudly rather than being guessed.

## 8. Acceptance

- `pnpm check` green: typecheck, the whole suite (currently 1291 tests), build.
- New `tests/multi-repository.spec.ts` proves, without a model call: a two-entry list parses and validates; a
  number used in two repositories yields two distinct thread ids and two distinct triggers; a ticket created
  from the second repository carries its repository into the worker environment and into the pull-request
  check; the migration rewrites number-only ids to the primary repository.
- The existing single-repository configuration keeps working with no changes to the settings file.
