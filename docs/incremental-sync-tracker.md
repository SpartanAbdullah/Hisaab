# Incremental Sync Tracker

Status: in progress
Owner split: Codex implements app code and migration files. Abdullah runs Supabase migrations and verifies production data.

## Progress

| Step | Status | Owner | Notes |
| --- | --- | --- | --- |
| Audit schema support | Done | Codex | `updated_at` now exists for accounts, transactions, loans, and budgets after the incremental sync migration. |
| Add local sync metadata | Done | Codex | Dexie `mirrorSync` table added in database version 7. |
| Incremental accounts sync | Done | Codex | Cached accounts load first; stale mirrors use `updated_at` incremental refresh when possible. |
| Core table migration | Done | Codex | `supabase-migration-incremental-sync-core.sql` adds `updated_at` triggers and indexes for transactions, loans, budgets, and idempotently accounts. |
| Apply migration in Supabase | Done | Abdullah | Abdullah confirmed the SQL was run in Supabase and changes were pushed to production. |
| Incremental transactions sync | Done | Codex | Uses `updated_at` incremental merge and removes remote tombstones from Dexie. |
| Incremental loans sync | Done | Codex | Uses `updated_at` incremental merge and removes remote tombstones from Dexie. |
| Incremental budgets sync | Done | Codex | Uses `updated_at` incremental merge and removes remote tombstones from Dexie. |
| Tombstone migration | Done | Codex | `supabase-migration-incremental-sync-tombstones.sql` adds `deleted_at` and deleted-row indexes. |
| Apply tombstone migration | Done | Abdullah | Abdullah confirmed `supabase-migration-incremental-sync-tombstones.sql` was run in Supabase. |
| Delete/tombstone strategy | Done | Codex | App deletes are now soft deletes for accounts, transactions, loans, and budgets; incremental sync removes tombstones from Dexie. |
| Settings sync status | Removed | Codex | Settings once showed per-table last sync, last full refresh, and queued offline changes. That card was deleted with the inert outbox on 2026-09-04 (D5, `docs/offline-story.md`); there is no offline queue — writes are online-required. |
| QA: tests/build | Pending | Codex | Run after each implementation slice. |

## Current Decision

Use a hybrid rollout:

- Accounts: true incremental sync now, because `updated_at` is already present.
- Transactions, loans, budgets: true incremental sync is enabled after Abdullah applied `supabase-migration-incremental-sync-core.sql`.
- Deletes: tombstone sync is implemented and the migration has been applied in Supabase.

## Abdullah Actions

- Review the generated sync migration before production. Done.
- Apply the migration when ready. Done.
- Confirm whether hard deletes should become soft deletes for transactions, loans, and budgets.
- Apply `supabase-migration-incremental-sync-tombstones.sql` in Supabase. Done.

## Codex Actions

- Implement Dexie sync metadata. Done.
- Implement incremental account merge. Done.
- Generate the migration for remaining core tables. Done.
- Implement incremental transactions, loans, and budgets. Done.
- Implement tombstone sync and soft deletes. Done.
- Add Settings Sync Status observability panel. Done.
- Keep tests/build green.
