# Audit remediation tracker (P0–P3)

**Scope:** the full 2026-09 audit roadmap — P0 items C1–C11 from
[00-executive-summary.md §6.1](00-executive-summary.md) (pre-launch, blocking;
plus two extras picked up during implementation: group-deletion-guard, C10's
settlement-row-locks half), P1 items H1–H10 (30-day), P2 items M1–M9
(90-day), and P3 items L1–L7 (strategic). All work lives on branch
`audit-p0-remediation`, currently **uncommitted / partially-committed
working-tree changes** (not merged into `main`, not pushed — pushing `main`
auto-deploys the web app to Vercel via Vercel's Git integration, so this
branch is deliberately kept off `main` until the release checklist below is
run). `git log --oneline main..HEAD` at time of writing: `16268c8` (audit
docs) → `dfdec7e` + `0055472` (P0 client + SQL) → `e02f53f` (P1 batch A) →
`93f456c` (P1 batch B + P2/P3 first wave) → `586aa9e` (P2/P3 wave 2 — money
engine steps 3–4, guest members, khata link, edit history, kameti editing,
notifications UI, performance, accessibility, DB test suite + Playwright,
docs; gates at that commit: `tsc` clean, 1940 tests green, lint 0 errors),
plus further uncommitted work on top — L4 step 5
(`supabase-migration-p3-atomic-investments-and-single-leg.sql` and its client
wiring) is mid-edit as of 2026-09-03 (see APPLY-ORDER.md §2b row 14).

Migration apply order and integration-run results: **[APPLY-ORDER.md](APPLY-ORDER.md)**
(companion doc — read it before applying anything; not duplicated here).
**`supabase/tests/apply-order.txt` is the canonical apply order** for the
whole corpus now (APPLY-ORDER.md §2b) — **74 production files** (1 schema +
73 migrations, after `p3-rls-initplan-and-indexes.sql` and
`p3-rpc-execute-grants.sql` were added on 2026-09-03 and
`p3-currencies-iso4217.sql` on 2026-09-04), machine-checked via
`supabase/tests/run.sh`, run in CI on every push/PR to `main`.
Production had all 73 of those applied as of 2026-09-03, so
**exactly one file is pending**: `supabase-migration-p3-currencies-iso4217.sql`
(founder decision, every active ISO 4217 currency — see
[currencies.md](../currencies.md)). Its position is third from last, after
`p3-rls-initplan-and-indexes.sql` and before `p3-invariant-monitoring.sql`.
`supabase-migration-p3-rpc-execute-grants.sql` is now the **last** line and
must stay last: it is a sweep over `pg_proc`, so anything applied after it
escapes both the EXECUTE revoke and the `search_path` pin. The assertion count has grown in steps as each new
suite landed (248 → 331 → 357 → 449, per the individual migration docs cited
in APPLY-ORDER.md §2b) and is not restated here as one fixed number — read
the CI job or run the harness locally for the current true count, since this
tracker would otherwise go stale the next time a file is added.

Source of truth for what each migration does: the header comment of each
`supabase-migration-*.sql` file at the repo root. This tracker summarizes
those headers and the accompanying docs (`docs/notifications.md`,
`docs/trust-and-safety.md`, `docs/server-side-money-engine.md`,
`docs/performance.md`, `docs/release-and-rollback.md`,
`docs/testing-the-trust-boundary.md`); the SQL files themselves are
canonical.

---

## 1. Release checklist

Do these in order. Do not skip or reorder — several migrations are BREAKING
in one or both directions (see §2), and the P1–P3 tail adds flag-gated
migrations that must not be enabled before their own pre-flight query has
been run (APPLY-ORDER.md §2b). Full procedure, rollback playbook and CI
gating: `docs/release-and-rollback.md`.

1. **Run `supabase-audit-p0-verification.sql`** in Supabase Studio → SQL
   Editor (read-only, safe to run any time) against production. Export the
   full result grid.
2. **Reconcile.** Any row whose `result` starts with `!!` needs founder
   attention before proceeding — it means production is not in the state the
   rest of the batch assumes. Section 13 (migration verdicts) is the
   fastest read; the two expected flags (`app_push_config`,
   `lookup_profile_by_public_code`) are documented, harmless exceptions
   (APPLY-ORDER.md §3).
3. **Apply ALL files in `supabase/tests/apply-order.txt` order, in one
   window, with the matching client.** This now covers the 11 audit-p0
   files *and* the 19-file P1/P2/P3 tail (APPLY-ORDER.md §2b, rows 1–18 plus
   `p2-analytics-aggregates.sql`) — not just the original 11, and grown again
   on 2026-09-03 (see A3 in §6.2). Via Supabase Studio SQL Editor (there is
   no migration runner in this repo — see `CLAUDE.md`). Confirm each file's
   own embedded verification notice says `OK`/`verification passed` before
   moving to the next. **`supabase-migration-p3-rpc-execute-grants.sql` is
   the last file and must be pasted last** — it sweeps `pg_proc`, so anything
   applied after it keeps the `anon`/`authenticated` EXECUTE that Supabase's
   default privileges hand every new function. Re-running it later is safe and
   is the intended fix if a subsequent migration adds functions.
   3a. **Re-run Supabase Studio → Advisors → Security afterwards.** The
   2026-09-03 production run
   ([prod-verification-2026-09-03.md](prod-verification-2026-09-03.md))
   reported 0 ERROR / 56 WARN / 2 INFO. After the batch, expect
   `anon_security_definer_function_executable` to list **exactly two**
   functions — `get_committee_witness` and `get_khata_view`, the two
   capability-URL public pages, both documented in
   `p3-rpc-execute-grants.sql` §2 — `function_search_path_mutable` to be
   empty for `public`, and `authenticated_security_definer_function_executable`
   to contain no `tg_*` / `handle_new_user` / `rls_auto_enable` entries.
   `rls_auto_enable` is a Supabase-platform function, not a Hisaab object —
   it exists nowhere in this repo's SQL and is deliberately not touched.
   `auth_leaked_password_protection` is a dashboard toggle (Auth → Providers →
   Email), not a migration.
4. **Set feature flags only after their own pre-flight (V-) query**, never
   before, and **one flag per release cycle** — the recommended enable order,
   per `docs/server-side-money-engine.md` §5/§10/§15/§21 (the L4 money-engine
   flags are additionally ordered by risk, transfer first / investments
   last):
   1. `VITE_ATOMIC_TRANSFER` — after `p3-atomic-transfer.sql` V1–V4 pass.
   2. `VITE_ATOMIC_REPAYMENT` — after `p3-atomic-repayment.sql` V6 (the F-2
      corruption-signature finder) has been read and understood, and only
      after `VITE_ATOMIC_TRANSFER` has had its own release cycle.
   3. `VITE_ATOMIC_LOAN_CREATE` — after `p3-atomic-loan-create.sql` V7 (the
      EMI-schedule-orphan drift watch) has been read, and only after
      `VITE_ATOMIC_REPAYMENT`'s own release cycle.
   4. `VITE_ATOMIC_GOAL` — after `p3-atomic-goal-and-card.sql` V6 (the
      goal-accounting signature), and only after `VITE_ATOMIC_LOAN_CREATE`'s
      own release cycle. Smaller blast radius than card-bill, so it goes
      first of that file's two flags.
   5. `VITE_ATOMIC_CARD_BILL` — after the same file's V7 (the card lockstep
      invariant — Σ cash-advance-remaining vs. the card's `used`), and only
      after `VITE_ATOMIC_GOAL`'s own release cycle.
   6. `VITE_ATOMIC_SINGLE_LEG` / `VITE_ATOMIC_INVEST` — **not yet ready to
      schedule.** `p3-atomic-investments-and-single-leg.sql` is still in
      progress (APPLY-ORDER.md §2b row 14) and `docs/server-side-money-engine.md`
      has no rollout section for it yet; do not set a target release cycle
      until both land.
   7. `VITE_REALTIME_BROADCAST` — order-independent of the L4 flags (no
      shared object), but still only after its own V6 *live* proof (save a
      real expense, confirm a broadcast row — Docker cannot verify this one).
   8. `VITE_ANALYTICS_RPC` — order-independent; safe to enable once
      `p2-analytics-aggregates.sql` + `p2-analytics-aggregates-2.sql` are
      applied and their V1–V7 checks pass (`AnalyticsPage` fails soft to
      client aggregation on any RPC error either way).

   None of these flags is required for this release to ship — all default
   off, and two flags flipped together make an incident un-bisectable, which
   is the reason for the one-per-cycle rule (§6 D8).
5. **Resolve the founder decisions in §6** before or during this window — at
   minimum acknowledge them; C2's R1 (unsettleable debt on deletion) and M1
   (the offline story) should be decided before merge, not after.
6. **Merge `audit-p0-remediation` → `main` and push.** Web deploys
   automatically via Vercel on push to `main`.
7. **Android:** `npm run build && npx cap sync android`, then hand the
   Gradle AAB build off to the founder (`gradlew` cannot run inside the
   agent sandbox — see `docs/updating-the-android-app.md` for the exact
   steps, version bump, and signing). Staged rollout: 20% → 50% → 100%
   (`docs/release-and-rollback.md` §2.3).
8. **Raise the `app_config` floor LAST**, only once web is live at 100% and
   the Android staged rollout has reached 100% — never before the fixed
   build is available to update to (`docs/release-and-rollback.md` §2.4).
9. **Coordinate the window.** Steps 3 and 6–7 must land close together:
   client-before-SQL breaks invites/linking (consent-guards,
   join-abuse-limits contracts change shape); SQL-before-client is fine to
   apply early EXCEPT where a migration's header says otherwise
   (loan-concurrency: `full_tracker` repayments start failing the moment
   it's applied until the matching client ships).
10. **Smoke test** after both are live (full list:
    `docs/release-and-rollback.md` §2.5):
    - Full-tracker: record a repayment on a loan from two browser tabs (same
      account) — confirm the second gets a conflict, not a silent
      double-debit.
    - Splits-only: record a group settlement from two tabs against the same
      debt — confirm the second is rejected, not an over-settle.
    - Join a group by code, then by invite link — confirm both still work
      end-to-end (contract changed shape in join-abuse-limits +
      consent-guards); confirm the group preview card (P1 H8) shows before
      joining.
    - Draw a kameti — confirm the draw button is inert after the first draw
      (no re-roll); confirm a hand-written slot before a draw is refused.
    - Record a linked (cross-user) udhaar entry in a non-AED/PKR currency
      (e.g. SAR) — confirm it saves.
    - Delete a test account that is a member (not owner) of a shared group
      with a non-zero balance — confirm the group's ledger survives for the
      remaining members.
    - Trigger a group notification (add an expense in a 2-person group) —
      confirm the other member receives it and it renders in the active
      language.
    - PIN: set a PIN, background the app 60s+, confirm the lock screen gates
      re-entry; confirm cold start also gates.
11. **First reconciliation run is a census, not an alarm.** Once
    `p3-invariant-monitoring.sql` is applied, run `run_reconciliation()`
    once and treat its output as the baseline population, not a fire drill
    — compare the *second* run's delta against the first before reacting to
    any row (APPLY-ORDER.md §2b).

---

## 2. Per-item status

Effort/impact framing follows §6.1 of the executive summary. "Breaking" is as declared in the migration's own header (search each file for `BREAKING`).

| # | Item | Migration file(s) | Breaking | Client files touched (evidence: `git diff --stat main`, `grep` for RPC/module usage) | Docker/throwaway-DB validated (per header) | Open follow-ups |
|---|------|--------------------|:---:|----------------------------------------------------------------------------------------|:---:|------------------|
| C1 | Prod schema unprovable — verification + CLI adoption | `supabase-audit-p0-verification.sql` (read-only) | No | — (SQL-only; runbook at [P0-C1-runbook.md](P0-C1-runbook.md)) | Y (PostgreSQL 15, both artifact-present/absent branches exercised) | **USER ACTION:** run it in Supabase Studio, paste output for review. Supabase CLI migration adoption (numbered, tracked, CI-applied) is still pending — blocked on the user connecting the Supabase CLI to the project. |
| C2 | Account deletion cascades into shared-group ledgers | `supabase-migration-audit-p0-account-deletion.sql` | Not flagged BREAKING (additive: FK CASCADE→SET NULL, columns made nullable) | `src/pages/GroupDetailPage.tsx`, `src/stores/splitStore.ts`, `src/lib/supabaseDb.ts`, `src/db/types.ts` (all reference `transfer_group_ownership` — the "Assign another admin" UI) | Y (throwaway Postgres 15, `supabase-schema.sql` + `reconciliation` loaded) | **PRODUCT DECISION** open — see §6.1 (D1). Header also files two smaller residuals (R2: owner can still hard-delete a shared group outright — closed separately by group-deletion-guard below; R3: departed member's `display_name` is deliberately retained on ledger rows — confirm against privacy policy before launch). |
| C3 | False listing claims (PIN / offline / currency) | none (docs + client only) | N/A | `docs/play-store-listing.md`, `docs/play-store-data-safety.md`, `docs/privacy-data-safety-inventory.md`, `RELEASE.md`; PIN wiring: `src/App.tsx`, `src/pages/PinLockScreen.tsx`, `src/stores/authStore.ts`, `src/lib/pinCrypto.ts` (new, PBKDF2 150k salted) | N/A | Listing claims corrected; PIN now actually gates cold start + 60s background + is asked for on re-auth. The PIN claim should return to the public store listing only after a device-verification pass (§7.C of the executive summary — no device farm has run yet). |
| C4 | `group_settlements` FOR ALL policy lets ex-members falsify the ledger | `supabase-migration-audit-p0-group-ledger-integrity.sql` | Not flagged BREAKING | RLS/trigger-only; no direct client dependency (client already writes rows through the same shape) | Not stated in header | None recorded beyond what's in the file. |
| C5 | Join-code brute-force limiter is a no-op; join codes never expire | `supabase-migration-audit-p0-join-abuse-limits.sql` | **Yes** — `join_group_by_code` return type changes `TABLE(...)` → `jsonb`, never raises for a business outcome | `src/pages/JoinGroupModal.tsx`, `src/pages/JoinGroupPage.tsx`, `src/stores/splitStore.ts`, `src/lib/collaboration.ts`, `src/lib/joinCodeStatus.ts` (new), `src/components/GroupCard.tsx` (Refresh-code UI) | Not stated in header | Join codes now expire 14 days; Refresh-code UI shipped in `GroupCard.tsx`. |
| C6 | Cross-user consent predicates are client-writable | `supabase-migration-audit-p0-consent-guards.sql` | **Yes** — see the 4 breaking changes listed in the migration's own header: (1) `persons.linked_profile_id` PATCH now rejected (42501) — use `link_contact_by_code` / `link_contact_by_discovery` / `unlink_contact_profile`; (2) owner-inserted `group_members` land as `'invited'`, not visible until accepted; (3) `group_invites` `select('*')` → permission denied, explicit columns only; (4) `accept_group_invite` — renamed argument, raw token (not hash), jsonb return | `src/pages/ContactDetailSheet.tsx`, `src/pages/ContactsPage.tsx`, `src/stores/personStore.ts`, `src/lib/contactLinkStatus.ts` (new), `src/lib/contactVerification.ts` (new), `src/pages/GroupDetailPage.tsx`, `src/pages/JoinGroupModal.tsx`, `src/pages/JoinGroupPage.tsx`, `src/components/GroupInviteModal.tsx`, `src/components/VerifiedBadge.tsx`, `src/lib/collaboration.ts`, `src/lib/supabaseDb.ts` | Not stated in header | **DATA DECISION** open — see §6.1 (D2). Pre-existing conscripted `'connected'` group members are NOT auto-migrated to `'invited'`; migration's verification query 4.6 lists the affected rows for manual triage. |
| C7 | Notification fan-out is client-side and forgeable | `supabase-migration-audit-p0-notifications.sql` | Ships with client (fan-out moves server-side; rows now also carry `template`+`params`) | `src/lib/notificationContent.ts` (new — renders template+params through i18n), `src/lib/instantNotify.ts`, `src/pages/InboxPage.tsx`, `src/pages/ActivityPage.tsx` | Not stated in header | Group notifications now render in the active language via `template`+`params`; `title`/`body` kept as fallback for legacy rows and the push pipeline. |
| C8 | Session hygiene (sign-out failure, re-auth, VerifiedBadge) | none (client only) | N/A | `src/stores/supabaseAuthStore.ts`, `src/pages/SettingsPage.tsx`, `src/components/VerifiedBadge.tsx` | N/A | — |
| C9 | Cross-user currency CHECK hard-limited to AED/PKR | `supabase-migration-audit-p0-currencies.sql` | Apply **BEFORE** client deploy (per header) | `src/pages/AddLoanModal.tsx`, `src/pages/SettleLinkedLoanModal.tsx`, `src/db/types.ts` | Not Docker-validated; header states widen-only CHECK is safe by construction (no existing row can become invalid) | None recorded. |
| C10 | Concurrency floor (loans, groups, kameti, settlements, client double-tap) | `supabase-migration-audit-p0-loan-concurrency.sql` (loans) · `supabase-migration-audit-p0-group-concurrency.sql` (group expense version + settlement cap) · `supabase-migration-audit-p0-kameti-draw.sql` (draw binding) · `supabase-migration-audit-p0-settlement-row-locks.sql` (cross-user accept RPC deadlock/lock-order fixes) + client double-tap guards | loan-concurrency: **Yes** — `full_tracker` repayments FAIL until applied (client already calls `apply_loan_remaining_delta`). group-concurrency, kameti-draw: ship with client. settlement-row-locks: server-only, no client contract change (per header, the loan-row lock behavior was already correct; this closes a deadlock + a missing lock + a lock-order inversion). | `src/lib/loanRemainingDelta.ts` (new), `src/stores/loanStore.ts`, `src/stores/transactionStore.ts`, `src/pages/RepaymentModal.tsx`, `src/pages/LoanDetailPage.tsx`, `src/pages/QuickEntry.tsx`, `src/components/AllocateRepaymentModal.tsx` (loans); `src/lib/groupSettlementResult.ts` (new), `src/stores/splitStore.ts`, `src/pages/GroupSettleUpModal.tsx`, `src/components/AllocateSettlementModal.tsx` (groups); `src/lib/committeeDraw.ts`, `src/stores/committeeStore.ts`, `src/components/CommitteeVerifyDraw.tsx`, `src/pages/KametiDetailPage.tsx`, `src/pages/CreateCommitteeModal.tsx` (kameti); `src/lib/useSubmitGuard.ts` (new — double-tap re-check + idempotency key), applied across ~25 submit surfaces (see diff stat) | settlement-row-locks: Y (Docker `postgres:15`, header says "faithful" reproduction). Others: not stated in header. | Kameti draw fix is single-phase (server-generated seed inside the same transaction, not two-RPC commit-reveal) — header explains why commit-reveal buys nothing here (organiser never sees the seed pre-commit). |
| C11 | Splits-only repayment records are best-effort | client only (depends on `loan-concurrency`) | Depends on loan-concurrency | `src/stores/loanStore.ts`, `src/stores/transactionStore.ts` | N/A | Direct recurrence-prevention for the documented "vanished payment records" incident class (`tasks/lessons.md`). |
| Extra | Owner can hard-delete a shared group outright (C2's R2 residual) | `supabase-migration-audit-p0-group-deletion-guard.sql` | Must apply **AFTER** `group-ledger-integrity.sql` (Section 0 of the file refuses to install otherwise) | `src/pages/GroupDetailPage.tsx`, `src/stores/splitStore.ts`, `src/lib/supabaseDb.ts`, `src/db/types.ts`, `src/lib/groupGuardErrors.ts` (new) — archive/unarchive UI | Y (throwaway PostgreSQL 15.19 with an auth shim, per header) | Order relative to `account-deletion.sql` does not matter (disjoint objects, per header's Section 0.2 interaction analysis). |

---

## 3. P1 (30-day) — status

Source: commit messages `e02f53f` (batch A) and `93f456c` (batch B), plus
`00-executive-summary.md` §6.2 for each item's original ask. All ten H-items
are landed on the branch; none has a pending SQL migration of its own beyond
what §2b of APPLY-ORDER.md already lists.

| # | Item | Outcome | Follow-ups |
|---|---|---|---|
| H1 | Observability | 82 `reportError` call sites added across stores/lib; `mutationSafety` rollback signals (+12 tests); 10s de-dupe; a Sentry scope-leak grouping bug fixed; native crash-reporting decision doc written. | Native crash reporting itself (Sentry Android / Crashlytics) is a **decision doc**, not shipped — see `docs/native-crash-reporting.md` and §6 below. |
| H2 | Product analytics | Consent-gated PostHog EU (default off), structural PII guard, lazy-loaded; typed event catalog (28 at P1 batch B, now 32 per `src/lib/telemetryEvents.ts` — commit `586aa9e` records "remaining deferred events wired"); consent toggle + feedback/WhatsApp card components; data-safety docs updated. | PostHog project key + the feedback WhatsApp number are still env vars nobody has set — the whole catalog is inert until they exist. Founder action (§6 A6). |
| H3 | Android launch chain | Cold-start deep links via `getLaunchUrl`; `assetlinks.json` published (placeholder fingerprints); `/kameti/witness` autoVerify; release-build guard for `google-services.json`; contextual notification-permission prompt. | `assetlinks.json` fingerprints are placeholders — need the real Play App Signing SHA-256 (founder action). `google-services.json` itself still not provided. |
| H4 | Data layer | Mirror dirty-flag + blocking incremental sync (per-expense payload ~1MB → ~2KB); 20s resume cooldown; money tables added to resume refresh; keyset pagination with truncation detection (`fetchAllPages`); `onRefreshed` hook. | None recorded beyond what shipped. |
| H5 | i18n integrity | Default language flipped to roman Urdu (single `DEFAULT_LANGUAGE` constant, explicit choices win); ~460 hardcoded strings across 36 files moved into `{ur, en}`; `profiles.lang` migration + client sync (`p1-profile-lang.sql`); ESLint ratchet against bare JSX literals. | 197 bare-literal violations remain across 9 files, tracked as an explicit ratchet allowlist in `eslint.config.js` — not yet zero. Server-side push-text localization is a separate, deferred item (`docs/notifications.md` §10.3). Native-speaker Roman Urdu review (register: tu/tum) is still outstanding — founder action (§6). |
| H6 | Security headers + session hygiene | HTTP security headers in `vercel.json` (CSP w/ `frame-ancestors`, HSTS, `nosniff`, Referrer/Permissions-Policy); glob-discovered store-reset registry + keep-list localStorage sweep; push-token/reminder teardown before sign-out. | None recorded beyond what shipped. |
| H7 | PWA input integrity | `interactive-widget=resizes-content` viewport; `visualViewport` keyboard-inset handling; back-stack layers for sheets/search/scanner; `history.state.idx`-based back; scroll restoration on POP. | None recorded beyond what shipped. |
| H8 | UX honesty | EMI plan no longer silently dropped on linked loans; transactional backup import with a key allowlist; sync card gated behind `VITE_ENABLE_OUTBOX` (card and flag since deleted with the outbox scaffold, 2026-09-04 — D5); Analytics uses the house loading pattern; single primary-currency fallback; `preview_group_by_code` RPC + preview card (`p1-group-preview.sql`). | None recorded beyond what shipped. |
| H9 | Version-skew gate | `app_config` table (`p1-app-config.sql`) + `UpdateRequiredScreen` + `__APP_VERSION__` Vite define; fails open by design until a human raises the floor. | Gate is inert until the founder deliberately raises `min_supported_version`/`_code` — not before this release is 100% live on both surfaces (§1 step 8). |
| H10 | Money-value bounds | 37 CHECK constraints + a single-source currency whitelist + a `group_expenses.splits` sum trigger (`p1-money-bounds.sql`); client-side amount bounds as the first line of `processTransaction`; split checks. | Pre-flight F1/F2 queries (APPLY-ORDER.md §2b row 4) must be run against production before this migration ships — not yet done, since production has not been touched. |

Gates recorded at the P1 batch B commit: `tsc -b` clean, 1386 tests green,
`eslint` 0 errors.

---

## 4. P2 (90-day) — status

Source: commits `93f456c` and `586aa9e`, and the docs written across both
(`docs/performance.md`, `docs/notifications.md`, `docs/trust-and-safety.md`,
`docs/testing-the-trust-boundary.md`, `docs/ops-checklist.md`,
`docs/release-and-rollback.md`, `docs/design-system.md`,
`docs/accessibility-contrast.md`, `docs/offline-story.md`,
`docs/who-owes-me.md`, `docs/guest-members.md`, `docs/edit-history.md`), plus
`00-executive-summary.md` §6.3 for each item's original ask. **2026-09-03
update below (marked ✅) corrects several rows this table previously carried
as "in progress" — the underlying docs/source had moved past the tracker.**

| # | Item | Status | Detail / source |
|---|---|---|---|
| M1 | Decide the offline story | **DECIDED 2026-09-04: Option A — scaffold deleted.** ✅ | `docs/offline-story.md` (2026-09-02) lays out three options and recommends **Option A now** (delete the inert `outbox` scaffold — `src/lib/outboxRunner.ts` and its Settings "Sync Status" card, since every dispatch handler still throws and nothing has ever drained a row) with **Option B** (a narrow single-row, non-cross-user replay queue) held as a post-launch experiment gated on two telemetry signals (`error_surfaced` filtered to `feature: 'money_mutation'`, `quick_entry_abandoned`), and **Option C** (full offline-first) ruled out. Resolved 2026-09-04: the founder approved Option A and the scaffold is deleted — `src/lib/outboxRunner.ts`, the `outbox` Dexie store (dropped by schema version 8), the `App.tsx` runner lifecycle, the Settings "Sync Status" card with its `sync_*` i18n keys, and `VITE_ENABLE_OUTBOX`. Option B remains a telemetry-gated backlog item. See §6 D5 below. |
| M2 | Performance program | **Complete**, small residuals noted. ✅ | (a) vendor chunk splitting + CI bundle-size script + self-hosted Geist: entry chunk 1.27 MB → 282 KB raw / 367 → 81 KB gzip (`docs/performance.md` §1–§5). (b) lazy Sentry SDK, Realtime Broadcast behind `VITE_REALTIME_BROADCAST`, boot-load dedupe (`docs/performance.md` §6). (c), previously "in progress," is now done per `docs/performance.md` §7 "Done since this list was written": all six eagerly-mounted app-level modals are lazy (entry chunk 72.73 → 42.90 kB gzip further), SQL-side analytics aggregates shipped as two migrations (`p2-analytics-aggregates.sql` + `p2-analytics-aggregates-2.sql`, `VITE_ANALYTICS_RPC`), transactions-list virtualization landed as day-group windowing + a 90-day default view (§6.6.5), and the previously-unbounded transaction fetch is now a bounded 12-month-or-1000-row window with an explicit `historyCoverage` contract (§7.1, landed 2026-09-02, no SQL/no flag). `check:bundle` **is** wired into CI (`.github/workflows/e2e.yml:64`) — `docs/performance.md` §7's "still not wired" bullet is stale. **Genuinely still open:** boot RPC consolidation (~15 parallel PostgREST reads, not batched into 1–2 RPCs), parallelising `isDeletedProfile` with the session publish, a single `analytics_bundle` RPC, and a device pass on the M2(d) client work (`docs/performance.md` §7's "Remaining M2-family items" list). |
| M3 | Accessibility floor | **Complete**, incl. lint + axe. ✅ | Accessible `Modal`, WCAG token values, `PageHeader` fix (`docs/accessibility-contrast.md` §1–§5) — as before. Previously-open items now shipped per `docs/accessibility-contrast.md` §6: `eslint-plugin-jsx-a11y@6.10.2` wired into `eslint.config.js` (critical rules as `error`, the rest `warn`); `A11Y_SWEEP_TODO` (the per-file ignore list) is confirmed **empty** in the live file (`eslint.config.js:197`) — all 8 originally-flagged files got a real `role="presentation"`/`aria-hidden` fix, `npm run lint` exits 0; `@axe-core/playwright@4.13.0` scans every no-session route in both languages on both Playwright projects in CI (`e2e/a11y.spec.ts`, `.github/workflows/e2e.yml`), with the two real findings it caught (a near-miss `color-contrast` on the legal-page "Last updated" line, a missing `button-name` on the password show/hide toggle) both fixed, not fixme'd; `<html lang>` now follows the active language (`documentLangFor`, `ur` → `ur-Latn` for the roman-Urdu-as-Latin-script reason, `en` → `en`), including the static `index.html` tag for the common (Urdu, first-visit) case. **Residual, explicitly not closed:** a real Android TalkBack pass and a keyboard-only desktop walkthrough on a live build (`docs/accessibility-contrast.md` §6.5) — no automated suite substitutes for it. |
| M4 | Design-system truth | **Done.** | `design-tokens.ts` cut from 264 to 35 lines (~250 dead CSS lines removed); `Button.tsx` moved onto house tokens; `docs/design-system.md` written as the single source of truth. |
| M5 | Notification maturity | **Complete** — backend and client UI both done. ✅ | `p2-notification-maturity.sql`: `member_left` fan-out, kameti `draw_completed`/`round_due`/`payout_due`, `notification_prefs` (mute + quiet hours + tz), Android channels + collapse keys, `notification_href_for()`, 90-day pruning. The three UI pieces `docs/notifications.md` §8 still lists as "not built" **are wired in source** (that doc is stale, not the code): the per-group mute toggle is live in `src/pages/GroupDetailPage.tsx` (`useNotificationStore` mutes, `grp_mute`/`grp_unmute` copy); quiet hours + a push section are live in `src/pages/SettingsPage.tsx` (`quietHours` from the store, a busy-state toggle); the bell badge in `src/components/InboxAction.tsx` reads `countIncomingPending` from `notificationCounts.ts` and renders it. |
| M6 | Trust & safety | **SQL + client done.** ✅ | `p2-trust-safety.sql`: `blocks` + `reports` tables enforced at 13 cross-user entry points, server-hashed/expiring/rotatable kameti witness tokens, receipts bucket 5 MiB/MIME cap + purge on deletion — Docker-validated (`docs/trust-and-safety.md` §7, 62 functional-smoke assertions). Client side, previously "not built yet," is now shipped: `src/components/BlockReportSheet.tsx` + `src/stores/blockStore.ts`, mounted in `GroupDetailPage.tsx`, `ContactDetailSheet.tsx` and `InboxPage.tsx` (per `docs/play-store-listing.md`'s claims ledger); witness-link rotate/revoke/initials-only UI in `src/components/CommitteeWitnessLink.tsx`. Migration itself is still **PENDING production apply**. |
| M7 | Test the trust boundary | **DB suite + Playwright done.** ✅ | `supabase/tests/` — full corpus in canonical order, attacked as role `authenticated` by multiple users, CI-gated on every push/PR to `main` (`.github/workflows/db-tests.yml`); it found and fixed a real defect in place (the kameti-draw pre-draw slot gap — APPLY-ORDER.md §2b). The Playwright half (`e2e/`), previously "not yet written," now exists: 7 specs (`public-pages`, `auth-page`, `onboarding`, `quick-entry`, `pin-lock`, `cross-user-loan`, `a11y`), public specs need no session, authenticated specs log into a pre-provisioned `hisaab-staging` account and self-skip (not fail) with no credentials configured, wired into `.github/workflows/e2e.yml` against the production build on `vite preview` (`docs/testing-the-trust-boundary.md` "E2E smoke (Playwright)"). |
| M8 | Unify the calendar + product opportunities | **Complete** (calendar + product both shipped). ✅ | Calendar half unchanged: `localDate.ts` + ~20 call sites moved off UTC slicing. Product half, previously "not shipped," now is: **guest members** (G6/O4) — non-app group members, `add_group_guest`/`remove_group_guest`, phone-hash claim, rename-race fix (`supabase-migration-p2-guest-members.sql`, `docs/guest-members.md`, 31+ assertions); **who-owes-me** (O7) — one row per (person key, currency), ad-hoc splits as a classification not an addition, the existing-but-buried debt-minimization settle-up now documented with its trade-offs (`docs/who-owes-me.md`); **edit history** (O10) — append-only `record_edits` table + 4 triggers, read-only to clients, `EditHistorySheet` mounted on `LoanDetailPage` (`supabase-migration-p2-edit-history.sql`, `docs/edit-history.md`); **kameti post-creation editing** (UX-25) — the open/collecting/drawn edit matrix, `update_committee`/`add_committee_member`/`remove_committee_member` (`supabase-migration-p2-kameti-editing.sql`); and the **money tolerance** unification — `src/lib/moneyTolerance.ts` as the shared home for `MONEY_TOLERANCE = 0.005` (float-noise epsilon) and `GROUP_SETTLEMENT_TOLERANCE = 0.01` (the server's own group-settlement zero cutoff), deliberately kept as two distinct numbers, not collapsed (`docs/who-owes-me.md` §8). Consolidated-repayment's lump marker is the one item from the original M8 ask not confirmed shipped here. |
| M9 | Ops floor | **Done** (the shippable slice — see the caveats). | Dependabot (`.github/dependabot.yml`), a security workflow (npm audit + gitleaks with verified fingerprints, `.gitleaks.toml` / `.gitleaksignore`), `docs/release-and-rollback.md`, `docs/ops-checklist.md`, `CLAUDE.md` committed. **Caveats, not yet closed:** deploy gating (branch protection + Vercel "Ignored Build Step") is a GitHub/Vercel dashboard setting this repo cannot commit — `docs/release-and-rollback.md` §5 says today "push passed CI" is advisory, not enforced. OTA (Capgo) is explicitly deferred, not "not yet built" — `docs/release-and-rollback.md` §6 says adopt only after this batch has stabilized and one full Play release cycle has run. Keystore-backup confirmation is a founder action (`docs/ops-checklist.md`), not verifiable from the repo. |

---

## 5. P3 — status

Source: `docs/server-side-money-engine.md`, `docs/trust-and-safety.md`
(khata-link is the P2-adjacent half of L2), `docs/release-and-rollback.md`
§4, `docs/performance.md`, `docs/phone-auth.md`, `docs/monetization.md`,
`docs/staging-environment.md`, `docs/play-store-listing.md`'s claims ledger,
and `00-executive-summary.md` §6.4.

| # | Item | Status | Detail / source |
|---|---|---|---|
| L1 | Phone/OTP-first auth + onboarding collapse | **Design doc.** | `docs/phone-auth.md` (new, 189 lines) — no migration, no client change yet. Blocks both H5's follow-up (native Urdu review still needed regardless) and M6's residual (block is per-account, defeated by delete-and-re-register — `docs/trust-and-safety.md` §6.3). SMS provider choice is still a founder decision (§6 D6). |
| L2 | Counterparty living-balance link ("khata link") + WhatsApp nudge loop | **Done.** ✅ | `supabase-migration-p3-khata-link.sql` — capability-URL, read-only, per-person ledger page, reusing the witness-link security pattern; strict six-field projection incl. a `show_notes` privacy toggle (added in-place — APPLY-ORDER.md §2b); fully additive, inert until a link is minted. Client wiring, previously pending, is now shipped: `src/components/ShareKhataLinkSheet.tsx` (share sheet + share-at-save nudge), `src/pages/KhataLinkPage.tsx`, `src/stores/khataLinkStore.ts`, route wired at `src/App.tsx` (`docs/play-store-listing.md` claims ledger). Migration itself is still **PENDING production apply**. The automatic WhatsApp share-prompt-at-save half of O2's *first* half remains as originally scoped in the migration's own header. |
| L3 | Monetization mechanism | **Design doc.** | `docs/monetization.md` (new, 200 lines) — no billing code written. Pricing/entitlement model is still a founder decision (§6 D7) — the audit's own concern ("a promise string, not a mechanism") stands until this ships. |
| L4 | Progressive server-side money engine | **Steps 1–4 done (flag-gated); step 5 (investments + single-leg) in progress.** ✅ | Step 1 `transfer_between_accounts` (`VITE_ATOMIC_TRANSFER`), step 2 `record_loan_repayment` (`VITE_ATOMIC_REPAYMENT`), step 3 `create_loan_with_leg` (`VITE_ATOMIC_LOAN_CREATE`, 248 SQL assertions), and step 4 `contribute_to_goal` + `pay_card_bill` (`VITE_ATOMIC_GOAL` / `VITE_ATOMIC_CARD_BILL`, 449 SQL assertions incl. a hand-run two-session lock race) are all built, Docker-validated and default-off (`docs/server-side-money-engine.md` §14/§20, APPLY-ORDER.md §2b rows 8/9/12/13). §22's "final branch table" marks every multi-leg branch of `processTransaction` ✅. Step 5 — `record_single_leg_entry`, `record_investment_trade`, `apply_goal_saved_delta` (`VITE_ATOMIC_SINGLE_LEG` / `VITE_ATOMIC_INVEST`) — is **in progress**: `supabase-migration-p3-atomic-investments-and-single-leg.sql` reads complete (own V1–V9 verification), but `docs/server-side-money-engine.md` has not been updated with a rollout section for it (§22/§23 still describe these two shapes as uncovered), and its paired test file was mid-edit in the working tree as of this review (APPLY-ORDER.md §2b row 14). |
| L5 | Staging environment + environment separation | **Runbook written, not stood up.** | `docs/staging-environment.md` (new, 199 lines) plus `docs/release-and-rollback.md` §4 name the exact recommendation (a second Supabase project as staging, replayed via the Supabase CLI or Studio in `apply-order.txt` order) and what it closes (real PostgREST behavior, `max_rows` truncation risk). `e2e/`'s Playwright suite (M7 above) already assumes this project exists under the name `hisaab-staging` — it is a live dependency now, not just a nice-to-have. Requires the founder to actually create the project and grant CLI/Vercel-env access (§6 A9). |
| L6 | Kameti-led marketing + Splitwise-refugee campaign + iOS evaluation | **Doc only.** | `docs/go-to-market.md` written. No campaign executed, no iOS evaluation performed — both are explicitly sequenced after the trust story ships and analytics can measure it. |
| L7 | Business-invariant monitoring | **Done.** | `supabase-migration-p3-invariant-monitoring.sql` — nightly reconciliation (`run_reconciliation()`, `reconciliation_findings`, `reconciliation_summary()`), read-only, RLS-on/zero-policies, applies LAST. First run is a census, not an alarm (§1 step 11, APPLY-ORDER.md §2b). |

---

## 6. Founder decisions/actions

Consolidated from every doc above — the P0 tracker's original §3/§4, plus
what P1/P2/P3 added. Grouped as **decisions** (pick an option, product
consequence either way) and **actions** (no judgment call, just needs doing
by someone with access this agent doesn't have).

### 6.1 Decisions

| # | Decision | Detail | Source |
|---|---|---|---|
| D1 | ~~C2/R1 — account deletion with an unsettled shared-group balance~~ **DECIDED 2026-09-04 (a): refuse until settled, mirroring `leave_group`.** Shipped as `supabase-migration-p3-account-deletion-balance-gate.sql`: `delete_current_user()` now also raises `UNSETTLED_GROUP_BALANCES` (DETAIL = `"Flatmates: owes AED 20.00; …"`) when the caller has a non-zero net (`group_member_net_balance`, 0.01 tolerance) in any shared group that still has another connected member; owner guard is evaluated first. Client: `SettingsPage.readUnsettledBalancesBlocker` + `del_account_unsettled_*` copy. Harness: `50-lifecycle-and-config.sql` (+5 assertions, incl. the DETAIL text and the guard order). **Applied to production by the founder 2026-09-04** and verified read-only through the Supabase MCP (both markers present, grants `authenticated` only, `search_path` pin intact; V3 census = 3 members / 3 profiles / 1 group currently carrying an open balance with a counterparty present). Pending migrations: none. | `supabase-migration-p3-account-deletion-balance-gate.sql` header; prod-verification-2026-09-03.md § "Decision census 2026-09-04" |
| D2 | ~~C6 — pre-existing conscripted `'connected'` group members~~ **DECIDED 2026-09-04: grandfather — and the set is empty.** Founder delegated the call; the census (consent-guards.sql query 4.6) was run read-only against production on 2026-09-04 and returned **0 rows** (0 members, 0 groups, 0 profiles). There is nothing to backfill or notify; every future owner-add already lands as `'invited'` and needs acceptance (consent-guards §2.3). No migration. Evidence: `prod-verification-2026-09-03.md` § "Decision census 2026-09-04". | `supabase-migration-audit-p0-consent-guards.sql` 4.6; prod-verification-2026-09-03.md |
| D3 | R3 (C2) — departed member's display-name retention | `group_members.display_name` is deliberately kept on a deleted user's row so the shared ledger stays readable; the row no longer links to any account or auth identity. Confirm this is consistent with the published privacy policy before launch (flagged, not blocking). | `supabase-migration-audit-p0-account-deletion.sql` header |
| D4 | ~~Kameti legacy/test draws~~ **DECIDED 2026-09-04: nothing to purge.** Founder delegated the call ("do whatever you want with it"). Read-only census of `public.committees` on 2026-09-04: **exactly one kameti in production** (ballot, active, 4 members, 0 slots, 0 payments, `draw_seed` / `draw_commitment` / `drawn_at` all NULL) — it has never been drawn, so no pre-fix draw exists and every future draw goes through `perform_committee_draw()` with server entropy. "Provably fair" can be marketed as-is. | prod-verification-2026-09-03.md § "Decision census 2026-09-04" |
| D5 | M1 — the offline story | **DECIDED 2026-09-04: Option A, scaffold deleted.** The memo (`docs/offline-story.md`, 2026-09-02) recommended, and the founder approved, **Option A** — delete the inert outbox scaffold now (`src/lib/outboxRunner.ts` and everything listed in the memo's §2 removal table; every `dispatch()` handler still throws, nothing has ever drained a row, and the Play listing's offline claim is already removed) — hours of work, not weeks. Hold **Option B** (a narrow single-row, non-cross-user replay queue) as a post-launch experiment, gated on two telemetry signals from §3 of the memo (`error_surfaced` filtered to `money_mutation`, `quick_entry_abandoned`) — do not build it speculatively. **Option C** (full offline-first) is recommended against, in this form, permanently. The scaffold is now deleted (schema version 8 drops the `outbox` store from existing devices); the memo's §5 records the decision, plus the founder's platform question ("can work with the Android app but not the web app") and its answer — both surfaces are one bundle, so the constraint is which writes are safe to replay, not the platform. P3 L4 (the server-side money engine) fixes a *different* problem — corruption while online — and does not replace this decision for what L4 doesn't cover (single-leg/offline still needs a network either way). | `docs/offline-story.md` §2, §3, §5; `docs/server-side-money-engine.md` §23 item 8 |
| D6 | ~~L1 — SMS/OTP provider~~ **DECIDED 2026-09-04: no paid SMS provider for now.** Auth stays email-first; `docs/phone-auth.md` is parked, not cancelled. Task L1 closed as parked. | `docs/phone-auth.md` |
| D7 | ~~L3 — pricing / entitlement model~~ **DECIDED 2026-09-04: free for now, revisit later.** No billing code; `docs/monetization.md` is parked. Task L3 closed as parked. | `docs/monetization.md` |
| D8 | VITE_* flag rollout order | **Eight** independent flags now exist: `VITE_ATOMIC_TRANSFER`, `VITE_ATOMIC_REPAYMENT`, `VITE_ATOMIC_LOAN_CREATE`, `VITE_ATOMIC_GOAL`, `VITE_ATOMIC_CARD_BILL` (all L4, risk-ordered), `VITE_ATOMIC_SINGLE_LEG` / `VITE_ATOMIC_INVEST` (L4 step 5, not yet ready to schedule — the migration is still in progress), `VITE_REALTIME_BROADCAST`, `VITE_ANALYTICS_RPC` — plus the always-on `app_config` gate. The documented rule is unchanged in kind, just longer: one flag per release cycle, each only after its own pre-flight query, the L4 flags in their risk order (transfer → repayment → loan-create → goal → card-bill), and the `app_config` floor raised only after both surfaces are 100% live. Written down in full at §1 step 4 above and `docs/server-side-money-engine.md` §5/§10/§15/§21 — still needs someone to actually own sequencing it rather than flipping several at once. **2026-09-04: the agent owns the sequencing; the founder sets each variable in Vercel (Project → Settings → Environment Variables, Production) and redeploys. Flag 1 `VITE_ATOMIC_TRANSFER` pre-flight PASSED on production the same day (V1–V3 + V5: function present, definer, grants right, all nine invariants, 0 drift rows over 16 live transfers) — safe to enable on web; Android picks it up next Play release.** | `docs/server-side-money-engine.md` §5/§10/§15/§21; §1 step 4 above; prod-verification-2026-09-03.md § "Decision census 2026-09-04" |

| D-F1 … D-F10 | Founder feedback round 2026-09-06 (Settings grouping, phone fields, telemetry default, notification defaults, phone block, discovery, Quick Entry order, add-members form, contrast, Inbox) | Ten decisions with recommendations, each naming what it blocks — see the consolidated list in [`../founder-feedback-2026-09-06.md`](../founder-feedback-2026-09-06.md) § "Decisions the founder must make". F7 is applied and gated; the F9 core is applied on branch `founder-round-2026-09-06`; nothing ships before the 390px light/dark screenshot approval | `docs/founder-feedback-2026-09-06.md` |

### 6.2 Actions (no judgment call — needs doing)

| # | Action | Why | Source |
|---|---|---|---|
| A1 | ~~Run `supabase-audit-p0-verification.sql` in Supabase Studio against **production** and share the output~~ **DONE 2026-09-03** — run read-only through the Supabase MCP before and after the batch; evidence in `prod-verification-2026-09-03.md` | The prerequisite for treating any "fixed" claim in this tracker as confirmed in prod, not just in Docker (C1) | §1 step 1–2 above |
| A2 | Connect the Supabase CLI to the project | Long-term fix for C1 — moves migrations to a numbered, tracked, CI-applied model instead of hand-pasting into Studio | `00-executive-summary.md` C1; `docs/release-and-rollback.md` §4 |
| A3 | Apply every file in `supabase/tests/apply-order.txt` order, in one window, with the matching client build | Covers all **32** pending migrations (11 audit-p0 + 21 P1/P2/P3, per APPLY-ORDER.md §2b rows 1–18 plus `p2-analytics-aggregates.sql`/`p2-realtime-broadcast.sql` already covered inline, plus `p3-rls-initplan-and-indexes.sql` and `p3-rpc-execute-grants.sql` added late on 2026-09-03), not just the original 11 or the 23 this action used to cite — the P2/P3 tail grew again on 2026-09-03. **`p3-rpc-execute-grants.sql` goes last**, then re-run the Security advisor (step 3a). **DONE 2026-09-03** — all 32 were applied to production in one window. `supabase-migration-p3-currencies-iso4217.sql` (2026-09-04) was applied on its own the same day and verified read-only through the Supabase MCP (157 rows / 156 active, 16 validated FKs, 0 leftover whitelist CHECKs, RLS on, anon SELECT only). **Pending migrations: none** — production matches `apply-order.txt` in full. | §1 step 3/3a above; APPLY-ORDER.md §2b |
| A4 | After merge + push (web) and `npm run build && npx cap sync android`, run the Gradle AAB build locally. **2026-09-05: the founder ran `gradlew bundleRelease`; it FAILED by design at `android/app/build.gradle:121` — the H3 release guard refuses to build without `android/app/google-services.json` (no Firebase config = zero push delivery while the app is killed). Blocked on A7's Firebase half — UNBLOCKED later on 2026-09-05: `google-services.json` in place, build succeeded (`android/app/build/outputs/bundle/release/app-release.aab`, 2026-09-05 16:51, signed with the upload key). Not yet uploaded to Play. NOTE: the animation round (5476aef) landed after that build, so the next AAB should be rebuilt before upload.** | `gradlew` needs a loopback socket the agent sandbox blocks — see `docs/updating-the-android-app.md`; the guard is documented in `docs/push-notifications-setup.md` | CLAUDE.md "Shipping rule" |
| A5 | Rotate the Supabase anon key | `git log` on `main` still contains commits (`88ed40c`, `dfea60e`) with the production anon key baked into build artifacts; RLS limits the blast radius but rotation is still recommended defense-in-depth and has not been done | `docs/testing-the-trust-boundary.md` §7 (secret-scanning section) |
| A6 | Set the PostHog project key + the feedback WhatsApp number as env vars | H2's analytics/feedback work is built and consent-gated but inert without these. The event-wiring half of A6 has since progressed — commit `586aa9e` records "remaining deferred events wired" (`src/lib/telemetryEvents.ts` now defines 32 typed events, up from 28) — but that only matters once these two env vars actually exist; nothing fires without them | §3 H2 above |
| A7 | Provide the real Play App Signing SHA-256 fingerprint for `assetlinks.json`, and a real `google-services.json`. **2026-09-05: upload-key fingerprint filled into slot 0 of `public/.well-known/assetlinks.json` (read from `hisaab-upload.jks` via `keytool`); the Play App Signing slot stays a placeholder until the first Play upload. `google-services.json` was the single blocker for A4 — DONE later on 2026-09-05: founder created Firebase project `hisaab-2`, placed the file, and `gradlew bundleRelease` produced a signed AAB (5.9 MB, upload-key cert). Server half of push also DONE the same day: `pg_net` enabled, `push-notify` v1 deployed through the Supabase MCP with `verify_jwt=false` (the function authenticates on `PUSH_SHARED_SECRET`; probe: no-secret POST → 401, GET → 405), founder set `FCM_SERVICE_ACCOUNT` + `PUSH_SHARED_SECRET` in Edge Function secrets and inserted both `app_push_config` rows; dry-run notification → function replied `200 {"sent":0,"reason":"no_devices"}` (secrets correct, JSON parsed). Remaining: on-device test (token registration + force-stop delivery), then the Play App Signing fingerprint for assetlinks slot 1.** | H3's Android launch-chain work currently ships placeholder fingerprints and no Firebase config; deep links and push both need these to work on a real device | §3 H3 above; `docs/android-setup.md` |
| A8 | Native-speaker Roman Urdu review (register: tu/tum vs aap across adjacent strings) | H5 moved ~460 strings into `{ur, en}` but nobody has proofread them for register consistency; also named in the original audit's "Human validation" gap list | `00-executive-summary.md` §7.D item 16 |
| A9 | Confirm Supabase org / Vercel project env access is available for a second (staging) project | L5's recommendation can't be executed without someone actually provisioning it | §5 L5 above; `docs/release-and-rollback.md` §4 |
| A10 | Confirm Play App Signing enrollment and Supabase PITR/backup settings | Both are dashboard states this repo cannot read or set; `docs/ops-checklist.md` §1.3 and §5 give the exact checks to run and where to record the result | `docs/ops-checklist.md` §1.3, §5 |
| A11 | Decide the `@sentry/capacitor` adoption window and run its Gradle-build verification | A conditional drop-in for H1's native crash-reporting gap — every version constraint checks out on paper but the native Android path is unproven without a real Gradle build (same sandbox limitation as A4); `docs/native-crash-reporting.md` §4 is the checklist, with Firebase Crashlytics as the named fallback if it fails | `docs/native-crash-reporting.md` §Decision, §4 |
| A12 | Verify the Android keystore backup exists and is restorable | Losing `hisaab-upload.jks` or its passwords permanently ends the ability to publish updates to the existing Play listing | `docs/ops-checklist.md` §1 |
| A13 | Own the trust-and-safety report queue | `public.reports` has no operator console by design (INSERT-only for clients); someone has to run the SQL query in `docs/trust-and-safety.md` §3 periodically once M6's client side ships | `docs/trust-and-safety.md` §3, §5 (Play UGC policy mapping) |
| A14 | Run `record_edits` Q1 (volume census by table) and Q2 (table size) a week after `p2-edit-history.sql` is applied, before trusting the 180-day retention figure | `transactions` is the app's highest-write table and this migration adds one `record_edits` INSERT to every write against it — real volume is unknown until measured. If it dominates, the cheapest lever is dropping the `insert` action for that one table, then shortening `transactions`-specific retention | `docs/edit-history.md` §8; `supabase-migration-p2-edit-history.sql` footer (Q1–Q6) |
| A15 | Treat the first `run_reconciliation()` call after `p3-invariant-monitoring.sql` is applied as a **census, not an alarm** — do not page anyone off it; compare the *second* run's delta against the first before reacting to any row | `reconciliation_findings` rows are opened when first seen and refreshed while they persist, so the very first run establishes the baseline population, not a fire drill | §1 step 11 above; APPLY-ORDER.md §2b row 11 |

**Resolved since the last pass — recorded, not re-flagged as open:** the Play
listing's app title is now 29 characters (`docs/play-store-listing.md`'s
"App title (≤ 30 chars · this is 29)" header) — the title-length overrun this
tracker's C3 row used to imply is closed; no action item remains for it.

---

## 7. Known open risks

Deduped from every doc's own open-risk section. Not a to-do list — recorded
so nobody re-discovers the same gap and re-litigates it as new.

- **Production drift is the largest unclosed gap in the entire batch.** Every Docker/throwaway-DB validation in this tracker proves the SQL composes with itself; none of it proves what production actually has applied. Nothing closes this except A1. (APPLY-ORDER.md §7, `docs/release-and-rollback.md` §4, `docs/trust-and-safety.md` §7)
- **PostgREST is untested end-to-end everywhere.** Every Docker session in this batch ran raw SQL as role `authenticated` — named-argument RPC binding, `jsonb` return-shape mapping, and whether `DETAIL` reaches `PostgrestError.details` are unverified for every new RPC (join-abuse-limits, consent-guards, group-preview, atomic-transfer, atomic-repayment, khata-link, trust-safety's rotate/revoke). Staging smoke-testing through a real client is the named gap-closer for all of them. (APPLY-ORDER.md §7; `docs/server-side-money-engine.md` §4, §9)
- **Tier-3 push is still believed off in production.** Every notification anti-fatigue improvement (M5) is invisible until Firebase + `app_push_config` are actually configured; this predates the current batch and nothing in it changes that. (`docs/notifications.md` §10.1)
- **No web push exists at all.** A PWA-only user only learns about a cross-user event if a tab is open; channels/collapse-keys/quiet-hours are Android-only concepts. (`docs/notifications.md` §10.2)
- **Push text is still English**, even after `profiles.lang` exists — nothing reads it server-side yet; only in-app/tier-2 notifications are correctly localized. (`docs/notifications.md` §10.3)
- **Block is per-account, and accounts are free.** A harasser who deletes and re-registers gets a clean slate; nothing in SQL can fix this without phone verification (L1/H10's OTP work, itself a founder decision — D6). (`docs/trust-and-safety.md` §6.3)
- **The "merely a member" carve-out in the block model is a deliberate, real hole.** A blocked user can still join a group whose *owner* they haven't blocked, even if the blocker is a member; the alternative (letting one member exclude others) was judged worse. Confirmed as intentional, not a bug — but it must be stated correctly in the block-sheet copy or users will believe they're more protected than they are. (`docs/trust-and-safety.md` §6.2)
- **Receipt deletion is a logical purge, not a physical one.** Deleting a `storage.objects` row removes the index entry but does not itself issue a delete against the underlying blob; a real guarantee needs a storage-API purge, not yet automated. Do not claim otherwise in the privacy policy. (`docs/trust-and-safety.md` §6.1)
- **Unbounded receipt object count is still open** — the 5 MiB size cap doesn't stop one account writing many small objects under arbitrary names in its own folder. (`docs/trust-and-safety.md` §6.6)
- **No true SQL rollback exists past `group-ledger-integrity.sql`** in the dependency chain — forward-fix is the only safe path for 7 of the 11 audit-p0 migrations plus everything that depends on them; reverting risks reopening a closed vulnerability or breaking the client currently live. (`docs/release-and-rollback.md` §3.3)
- **Nothing currently stops a red `main` from deploying to production** — Vercel's git integration is independent of CI status; branch protection + an Ignored-Build-Step gate are both outside-the-repo settings, not yet turned on (M9 caveat, A2-adjacent). (`docs/release-and-rollback.md` §5)
- **The kameti notification sweep has no alerting if it stops running** — `kameti_round_due`/`kameti_payout_due` depend on a scheduler (pg_cron or a dashboard cron) that isn't guaranteed to exist; check `cron.job_run_details` rather than assuming silence means nothing due. (`docs/notifications.md` §10.5)
- **Kameti reach depends on the organiser having linked contacts** — a committee typed as plain names notifies nobody, with no UI telling the organiser. (`docs/notifications.md` §10.6)
- **`notification_prefs` has no UI yet** — mute/quiet-hours exist server-side and are unreachable by a normal user until M5's client follow-ups ship (§4 above). (`docs/notifications.md` §10.7)
- **Realtime Broadcast's V6 check cannot be satisfied by Docker** — it needs a live Supabase project and a real save; treat "V1–V5 clean" as necessary, not sufficient, before enabling `VITE_REALTIME_BROADCAST` on any surface. (APPLY-ORDER.md §2b; `docs/performance.md` §6.4)
- **M9's OTA / deploy-gating / keystore items are dashboard or vendor decisions this repo cannot verify from source** — see A9–A12 above; treating M9 as fully closed would be wrong even though its shippable SQL/CI/doc slice is done. (`docs/release-and-rollback.md` §5–§6, `docs/ops-checklist.md`)
- **The card-bill-pay branch of the server-side money engine (L4 step 5) forks the allocation engine if done naively** — `allocateBillPayment`/`clampCardCredit` is real tested business logic; the right shape (plan-on-client, apply-on-server) is a bigger design decision than steps 1–3 and hasn't been made yet. (`docs/server-side-money-engine.md` §6 "Order, by risk")
- **`profiles.lang` push localization is a precondition, not a fix** — the column exists and the client writes it, but no trigger or edge function reads it yet; closing the gap is tracked as a separate, larger unit of work. (`supabase-migration-p1-profile-lang.sql` header)
- **Hisaab needs a network to record money, full stop, and the fix is a documented non-decision.** `docs/offline-story.md` confirms every outbox dispatch handler still throws and nothing has ever drained a queued op; the recommended fix (Option A) is deletion of the scaffold, not a working offline path — see D5. Resolved 2026-09-04: Option A approved, scaffold deleted. (`docs/offline-story.md` §1, §5)
- **Two "who owes me" edge cases are pre-existing app behaviour, now just concentrated on one screen.** Rule-3 name-collision matching can both merge distinct same-named people and split one real person into two rows depending on which netting rule fires first; `resolveMeMemberId`'s owner fallback is wrong for a group the current user doesn't belong to (always pass `currentProfileId` explicitly). Neither is new, both are now easier to hit from the unified view. (`docs/who-owes-me.md` §7)
- **Two money-tolerance constants coexist on purpose but can still disagree at the boundary.** `MONEY_TOLERANCE = 0.005` (float-noise epsilon) and `GROUP_SETTLEMENT_TOLERANCE = 0.01` (the server's group-settlement zero cutoff) are deliberately not collapsed into one number; a sub-cent case can read "settled" under one and "outstanding" under the other. Worth unifying only when the store housing them is rewired. (`docs/who-owes-me.md` §5, §8)
- **A guest's phone-hash claim proves same-input, not same-person** — `profiles.phone_e164` is self-asserted with no OTP verification, so the claim mechanism proves "typed the same number," not "controls that number." Bounded by the join-code keyspace + rate limit and by `member_joined` fan-out announcing every claim; the owner-assigned invite path needs no phone and is the stronger option. Same root cause as L1/D6 (phone verification is unbuilt). (`docs/guest-members.md` §9)
- **A guest cannot be merged into an existing contact** — guests key by name like every other account-less person; `whoOwesMe`'s `findLikelyDuplicateRows` hint is the only bridge and no UI consumes it yet. (`docs/guest-members.md` §9)
- **`record_edits` roughly doubles the write cost of `transactions`, the app's busiest table, and real volume is unmeasured** — mitigated by a narrow column whitelist, an empty-diff no-op rule, and 180-day pruning, but the actual growth curve won't be known until a week of production traffic exists. See A14. Two smaller, permanent gaps in the same feature: hard-deletes (`deleteLoanCascade`) leave orphaned-but-readable history rows with no record of the deletion itself, and a hard-deleted group takes its whole edit trail with it (`group_id ON DELETE CASCADE`). (`docs/edit-history.md` §8)
- **A rising `actor_kind='system'` share on group-table edit history would mean the audit trail is losing names** — any future `SECURITY DEFINER` path that runs without a JWT logs anonymously; `record_edits` Q4 is the census to watch. (`docs/edit-history.md` §8)
- **A live Android TalkBack pass and a keyboard-only desktop walkthrough are still outstanding** — `eslint-plugin-jsx-a11y` + axe-in-CI + the `role="presentation"`/`aria-hidden` sweep narrow the automated floor, but none of it substitutes for a device pass on a live build. (`docs/accessibility-contrast.md` §6.5)
- **The new Playwright E2E suite's authenticated specs are only as good as a staging account that doesn't exist yet** — `e2e/global-setup.ts` needs `E2E_EMAIL`/`E2E_PASSWORD` (+ `_2` for the cross-user spec) pointed at a `hisaab-staging` Supabase project; with no secrets configured the authenticated specs self-skip (a supported, green outcome) rather than actually running, which means CI is currently only proving the public-page and auth-page specs on every push. Same missing prerequisite as L5/A9. (`docs/testing-the-trust-boundary.md` "The staging-account rule", "CI"; §5 L5 above)

---

*Maintained by the engagement lead as the founder's single tracker for P0–P3 remediation. See [00-executive-summary.md §6](00-executive-summary.md) for the original findings this tracker implements, and [APPLY-ORDER.md](APPLY-ORDER.md) for the canonical migration apply sequence and integration-run results.*
