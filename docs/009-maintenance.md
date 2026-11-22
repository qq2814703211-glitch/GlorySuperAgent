# 009 Keeping upgrades recoverable

The project already has a domain engine that can run against in-memory repositories, two hosts that assemble it through ports, and a durable queue for work that must survive a restart. Keep that structure. For an operator upgrading an existing installation, the most consequential shared boundary is the SQLite file: both hosts open it, and a mistake during startup can affect every ticket before either host becomes ready.

## Decision: identify state before changing it

`Store` owns the on-disk format. Runtime takes the state-directory lock before opening it; the Engine and Sources consume repository interfaces rather than choosing a migration. Previously, a missing version marker meant “new installation” even if other tables existed, and a marker such as the JSON string `"11"` could be silently rewritten as a number. Neither is evidence of a compatible format.

| State found at startup | Store contract |
| --- | --- |
| Empty database | Create the tables and version marker in one transaction. Also accept an empty `kv` table alone: an interrupted older initialization could leave this behind. |
| Supported earlier version (currently 10) | Apply the supported migration and update the marker in one transaction. If conversion fails, roll back; do not serve partially migrated records. |
| Current version (11) | Open normally, reconciling derived indexes and working-set columns without replaying the data migration. |
| Unsupported version, or missing/invalid marker in an initialized database | Stop before changing the journal mode or application schema. The operator checks the state path or restores a known backup; the host never guesses the version. |

This checks the format marker, not the integrity of every record. It adds no public API, new schema version or background service. Pull requests exercise the storage and migration suites on the lowest supported Node version as well as in the existing full check. Keeping one durable store also keeps one failure domain: this is recoverability for a single host, not high availability across machines.

## How to change this boundary

1. **Before a format change:** describe the oldest readable version, the last version that can read the new state, and the restore procedure. Keep a fixture in the old on-disk shape, not just objects constructed by the new writer.
2. **In the change:** keep conversion and the version update in the same transaction. Exercise a fresh install, a supported upgrade and reopen, and a failed conversion with the original rows still readable. Run `pnpm exec vitest run tests/migration.spec.ts tests/store.spec.ts` before the full `pnpm check`.
3. **Before deployment:** rehearse the [upgrade and rollback](006-deployment.md#upgrade) on a private, disposable copy. Verify an existing ticket and settings before accepting new work. Never commit operator state as a fixture.

## Next decisions

| Priority | Evidence to collect | When to change the design |
| --- | --- | --- |
| Restart and delivery | Interrupt a test host after an outbound send but before its receipt commits; inspect the durable receipt and what the recipient observed. | If a destination can receive a duplicate, define what that adapter can deduplicate before changing retry policy. A local transaction cannot promise exactly-once delivery to another service. |
| Long-lived installations | Measure database size, backup/restore duration and working-set query time on representative synthetic histories. | Introduce retention only with an explicit rule for which ticket history, subscriptions and receipts must remain recoverable. Do not split the database just to reduce file size. |

For component ownership and existing test fixtures see [007 Architecture](007-architecture.md). For adding an adapter without moving domain decisions into it see [008 Cookbook](008-cookbook.md).
