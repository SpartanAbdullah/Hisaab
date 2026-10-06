# SDLC review — 2026-10-06

How Hisaab is planned, built, tested, released, operated and secured, measured against current
(2025–26) practice: DORA delivery capabilities, OpenSSF/SLSA supply-chain guidance, OWASP ASVS +
Mobile Top 10, Supabase's own security/performance linter, WCAG 2.2. It builds on the
[September audit](audit-2026-09/00-executive-summary.md) rather than repeating it: every earlier
recommendation was re-checked as DONE / PARTIAL / OPEN (appendix).

**Method.** Three read-only reviews in parallel (delivery pipeline · code & testing · security &
data), then live checks against GitHub, Vercel and production Supabase (advisors, reconciliation
tables, env-var *names* only). Claims marked **✓** were re-verified directly while writing this.
No production data was changed.

---

## The short version

The engineering *inside* the code is strong — zero `any`, a real database trust-boundary harness
(869 assertions), money RPCs with locks and compare-and-swap, RLS on every table, strong HTTP
headers, lessons turned into rules. What is weak is everything *around* it: nothing stops a red
build from reaching users, the website reports no errors, money alarms ring into an empty room,
and Android and web run different money code. Those are cheap to fix and they are where the risk
is.

| SDLC phase | Status | One line |
|---|---|---|
| Plan / requirements | Good | Decisions, trackers and lessons are written down; scattered across ~60 docs, no ADR folder. |
| Design / architecture | Needs work | Sound layering; three god-files keep growing; database rows are untyped. |
| Build | Good | Strict TypeScript, lint rules for i18n + a11y, conventional commits. |
| Test | Needs work | Excellent pure-logic + DB tests; pages, most stores and signed-in E2E are untested. |
| Release / deploy | **Gap** | No branch protection, no PRs, deploys start before CI ends; manual DB migrations; manual AAB. |
| Operate / monitor | **Gap** | Website sends no errors; 6 money-integrity findings unattended for 33 days. |
| Security | Good, with gaps | Server side is solid; recovery flow, push abuse, signals nobody reads. |
| Data & privacy | Needs work | Non-atomic money paths on Android; deletion leaves edit history behind. |

---

## Priorities

### P0 — this week (each is small; together they close the real exposure)

1. **Money alarms nobody hears ✓.** Nightly reconciliation (`docs/invariant-monitoring.md`) runs —
   33 runs, last 2026-10-05 22:00 — and has reported the same **6 open findings every night since
   2026-09-03**:
   - CBD ••••4599 (credit card): stored balance **6,458.01**, its own transactions sum to
     **3,837.46** — off by **2,620.55**.
   - Mashreq ••••2489 (credit card): off by **2.00**.
   - A 557.03 AED shared loan where one side was deleted on 24 Sep — the debt is now one-sided
     (founder ↔ another contact; not Ghulam).
   - Two shared pairs between other users where one side is settled and the other still open
     (50 AED, 12,000 PKR); one other user's loan whose remaining is 3,000 off its repayments.
   **Do:** triage these six; then make a *new* finding page someone (email/webhook from the
   reconciliation job), with a 48-hour triage rule. A monitor without an alert is a log.

2. **The website reports no errors ✓.** Vercel has three env vars (`VITE_SUPABASE_URL`,
   `VITE_SUPABASE_ANON_KEY`, `VITE_ATOMIC_TRANSFER`); **`VITE_SENTRY_DSN` is not one of them**, so
   usehisaab.com sends nothing to Sentry — only the Android build (local `.env`) does.
   **Do:** add the DSN to Production + Preview; upload hidden source maps with
   `@sentry/vite-plugin`; set `release` = version+commit and a `platform` tag; add a `beforeSend`
   that strips capability tokens (`/khata/:token`, `/join/:token`, witness URLs) and amounts.

3. **"Forgot password" never sets a new password ✓.** The reset email redirects to `/?reset=1`
   (`supabaseAuthStore.ts:354`), but nothing handles the `PASSWORD_RECOVERY` event and there is no
   `updateUser({ password })` anywhere — the link just signs the user in. **Do:** on
   `PASSWORD_RECOVERY`, show a "set a new password" screen before the app.

4. **Android runs the non-atomic money paths ✓.** Seven `VITE_ATOMIC_*` flags default off
   (`transactionStore.ts`), the Android build's `.env` sets none, and today's Android bundle
   contains **zero** calls to the atomic RPCs. Web has only `VITE_ATOMIC_TRANSFER`. So the same
   tap writes money differently on the two surfaces, and Android uses multi-step client writes
   that can half-complete on a dropped connection. **Do:** put the flags in the Android build env
   (match web first), roll out repayment and loan-create, then read flags at runtime from
   `app_config` (already loaded at boot) so a flag flip doesn't need an AAB.

5. **Nothing gates `main`.** No branch protection or ruleset, no PR ever opened, and the Vercel
   production deploy starts before CI finishes; CI only runs on `main`, so a branch push (e.g.
   `feat/person-ledger-running-balance`) gets a preview but no tests. **Do:** a ruleset on `main`
   requiring a PR and the `test` / `sql` / `e2e` / `npm-audit` / `gitleaks` checks; run CI on every
   branch; let Vercel's Ignored Build Step wait for checks (or deploy from Actions).

### P1 — this month

6. **Previews talk to the production database ✓.** The Supabase URL/key target production,
   preview *and* development. **Do:** a `hisaab-staging` Supabase project for Preview (the GitHub
   integration is already linked — moving SQL into `supabase/migrations/` turns on per-PR branch
   databases).
7. **Schema changes by hand, no ledger, no drift check.** 88 root SQL files pasted into Studio;
   prod has no `schema_migrations`; the grants sweep must be re-run by hand; the DB harness pins
   **Postgres 15 while prod is 17.6 ✓**. **Do:** adopt `supabase/migrations/` + `supabase db push`
   (staging first), a nightly read-only drift check, and `postgres:17` in the harness.
8. **Retries can still double-write.** The transaction id is minted inside `processTransaction`
   ✓ (`transactionStore.ts:2804`), so if the server commits but the reply is lost, the retry gets a
   new id — the atomic RPCs are idempotent per id, but only if the id survives the retry.
   **Do:** mint the id per *submit intent* and pass it through (linked/settlement requests already
   do this). Apply `supabase-migration-ltr-no-duplicate-sync.sql` (written today, 869/869 green)
   and add a per-pair pending cap for settlement requests (a real duplicate Tabby instalment is in
   `tasks/backlog-2026-09-22.md`).
9. **Security signals that reach no one.** The weekly full-history gitleaks scan has failed
   5 of 5 runs since 7 Sep (a finding inside `.gitleaksignore` itself); Dependabot alerts and
   security updates are disabled; Supabase **leaked-password protection is off ✓**; the push
   trigger has no per-sender throttle (push is live); the anon key in the public repo was never
   rotated. **Do:** fix the gitleaks allowlist, enable Dependabot alerts, flip leaked-password
   protection (Auth → Password security), throttle `tg_notifications_push`, rotate the anon key.
10. **Privacy residue.** Account deletion hard-deletes the login and tombstones the profile ✓,
    but `record_edits` keeps names, notes and amounts (`ON DELETE SET NULL`); receipts are purged
    logically only; data export omits persons, committees, budgets, recurring and linked requests.
    **Do:** purge the user's `record_edits` and storage objects inside `delete_current_user`;
    complete the export.

### P2 — next quarter (code health)

- **Shrink the god-files.** `transactionStore.ts` 4,834 lines (`processTransaction` ≈1,195),
  `supabaseDb.ts` 5,934, `i18n.ts` 6,000, QuickEntry 2,437, GroupDetail 2,182, Inbox 2,041 — all
  grew since September. Split `processTransaction` per type; split the DAL by domain; delete the
  legacy compensation paths once the atomic flags are on everywhere.
- **Type the database.** `createClient` has no `Database` type and 31 mappers read
  `Record<string, unknown>` (≈345 casts). Generate types from the harness DB in CI — this is the
  class of bug behind `Loan.loanPairId` (mapped from `loans.loan_pair_id`, a column that never
  existed; still mapped today).
- **Tests above the math.** 0 of 51 pages and most stores (loan, account, linked-request,
  settlement) are untested; the signed-in E2E specs skip because the CI secrets don't exist.
  Provision a staging E2E account, add store tests with the existing mock-DAL pattern, add a
  coverage ratchet on `src/lib` + `src/stores`.
- **Errors.** 62 `console.error` calls never reach Sentry (incl. Inbox accept/reject). Lint-ban
  `console.error` in `src` in favour of `reportError`; wrap `restoreTransaction` in a mutation
  scope; route `goalStore` contributions through the atomic delta.
- **Performance.** First load is ≈378 kB gzip; i18n ships both languages (86 kB). Load only the
  active language; budget the whole first load, not just the entry chunk; add Web Vitals.
- **Database polish (Supabase linter ✓).** 5 RLS policies re-evaluate `auth.uid()` per row
  (`notification_prefs` ×4, `record_edits`) — wrap in `(select auth.uid())`; 38 unindexed foreign
  keys and 53 unused indexes are harmless at 23 MB and can wait.
- **Android.** CI job for the AAB + Play internal-track upload; one version source with a CI check;
  `minifyEnabled true`; `FLAG_SECURE`/privacy screen on money screens; native crash reporting.
- **Docs.** README is still the Vite template; add `docs/adr/`; CLAUDE.md drift (see below).

---

## Already strong — keep doing this

- Zero `any`, zero `@ts-ignore`; strict compiler options.
- Database trust-boundary harness in CI with an apply-order completeness check (869 assertions).
- Money RPCs: canonical lock order, compare-and-swap balance writes, idempotent per transaction id.
- RLS on every public table, asserted by tests; grants sweep with an exact client-RPC allowlist and
  zero `anon` leaks outside the two capability-URL pages.
- Hashed, expiring, revocable khata and witness tokens; block/report enforced at 13 entry points.
- Strong HTTP headers (CSP, HSTS preload, `frame-ancestors 'none'`).
- Version kill switch, additive-only schema policy, per-layer rollback playbook.
- Nightly invariant reconciliation actually running; `tasks/lessons.md` as living postmortems.
- 161 of 174 `src/lib` modules unit-tested; bundle budget + axe in CI; TZ pinned.

## Corrections this review makes to existing docs

- pg_cron **is** running in production (reconciliation ran 33 nights); the "absent" note in
  `audit-2026-09/prod-verification-2026-09-03.md` is out of date.
- `CLAUDE.md`: account deletion is a profile tombstone **plus a hard delete of the login**, not a
  soft delete; "30+" migrations → 88; four workflows, not one; the "pure functions only" testing
  note is stale (store tests exist).
- `docs/release-and-rollback.md`: cites `APPLY-ORDER.md` instead of
  `supabase/tests/apply-order.txt`, omits the grants re-run, and says the db-tests workflow
  doesn't exist yet (it does).

## Appendix — September audit, re-checked

| Item | Status |
|---|---|
| Branch protection / CI-gated deploy | OPEN |
| Migration runner / ledger, prod schema provable | OPEN (harness in CI = PARTIAL) |
| Staging environment | OPEN |
| Web error reporting / source maps | OPEN (✓ DSN absent in Vercel) |
| Native crash reporting | OPEN |
| Password recovery (M3) | OPEN (✓) |
| Email gate before data effects (M4) | OPEN |
| Push denial-of-wallet throttle (M14), push-token hijack (M15) | OPEN |
| Rate-limit bypass / captcha (M11) | OPEN |
| Anon key rotation (M9/A5) | OPEN |
| Deep-link allowlist (L6), edge-function hygiene (L11), tokens in localStorage (L3) | OPEN |
| God store (H-3), oversized pages (M-3), untyped rows (M-1) | OPEN, worse |
| Atomic money engine (L4) | PARTIAL (web: transfer only; Android: none ✓) |
| Dependabot | PARTIAL (config present, alerts off) |
| Secret scanning | PARTIAL (scheduled scan failing) |
| E2E smoke | PARTIAL (signed-in specs skip) |
| Product analytics | PARTIAL (no key in Vercel; CSP would block it) |
| Phone ownership (H10), deleted-account gate (M6), receipts (M13), membership oracle (M16) | PARTIAL |
| Stores reset on logout, reportError in stores, offline outbox removed, CLAUDE.md tracked | DONE |
| Consent, linked-profile forgery, join limiter, invite hashing, notification phishing | DONE |
| PIN hardening, sign-out wipe, re-auth, import allowlist, money bounds, block/report | DONE |
| HTTP security headers, version kill switch, bundle budget, axe, TZ pin, npm audit in CI | DONE |
| Invariant monitoring | DONE — but unalerted (P0 #1) |
