# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Hisaab — a mobile-first personal/social finance app (expenses, loans, group splits, kameti/committees, budgets, investments) for a Pakistani/Urdu-speaking audience. One React codebase ships to two surfaces: a PWA on Vercel (usehisaab.com) and an Android app via a Capacitor wrapper (`android/`, app id `com.usehisaab.app`). There is no custom server: the backend is Supabase (Postgres + Auth + Realtime + one edge function in `supabase/functions/push-notify`), and all business logic lives in the client or in Postgres RPCs.

Read `tasks/lessons.md` at the start of every session — it holds distilled rules from past corrections and near-misses in this repo. `ARCH-RECON-hisaab.md` is a deep architecture/deployment audit if you need more detail than this file.

## Commands

```bash
npm run dev            # Vite dev server
npm run build          # tsc -b && vite build (typecheck + bundle)
npm run lint           # eslint .
npm test               # vitest run (full unit suite, <1s)
npx vitest run src/lib/splitMath.test.ts   # single test file
npm run cap:sync       # build + copy web assets into android/
```

CI (`.github/workflows/ci.yml`) runs `tsc -b`, lint, tests, and a production build on push/PR to `main`.

### Shipping rule: every change goes to BOTH web and Android

Web deploys via Vercel on push. The Android app bundles a copy of the web build, so after any app change also run `npm run build && npx cap sync android`, then **hand the Gradle AAB build off to the user** — `gradlew` needs a localhost socket and fails inside the agent sandbox ("Unable to establish loopback connection"). The user runs it in their own PowerShell (see `docs/updating-the-android-app.md` for the exact steps, version bumping, and signing). Never call a change done web-only.

### Supabase migrations

Schema changes ship as a new `supabase-migration-<name>.sql` file at the repo root (30+ exist; they are the source of truth for tables, RLS, and RPCs). There is no migration runner — **the user applies them manually in Supabase Studio**. When you write one, say so explicitly and track that it's pending until the user confirms it's applied.

Every new migration also goes into `supabase/tests/apply-order.txt` (before the final `p3-rpc-execute-grants` sweep, which must be re-run after any migration that creates a function) and usually gets a DB test in `supabase/tests/tests/` — run the whole harness with `./supabase/tests/run.sh` (needs Docker running; it applies the corpus to a throwaway Postgres and runs every test file as `authenticated`).

## Architecture

### Data flow

Pages/components → Zustand stores (`src/stores/`, one per domain) → `src/lib/supabaseDb.ts` (the single data-access layer for all entity reads/writes) → Supabase Postgres with RLS. Sensitive multi-row operations go through `SECURITY DEFINER` RPCs defined in the migration SQL (e.g. `apply_account_balance_delta` for optimistic-locked balance writes, `join_group_by_code` with rate limiting).

`src/db/` (Dexie/IndexedDB, per-user DB `HisaabDB:user:<uid>`) is a **read mirror only**, not the source of truth — Supabase is authoritative, and the app is **online-required for writes**. There is no offline write queue: the inert outbox scaffold was deleted on 2026-09-04 (decision D5, Option A — `docs/offline-story.md`), and a save while offline fails loudly with the `err_offline` copy so the user retries once connected. Never promise a later save, and never re-introduce a queue without the telemetry case that memo's §3 asks for.

### Money-mutation safety

Supabase has no client-side transactions, so multi-step money mutations (debit one account, credit another) use the compensation pattern in `src/lib/mutationSafety.ts`: wrap the flow in `runSafeMutation`, register an inverse on the `MutationScope` for every side-effect, rollback runs inverses LIFO on failure. Account balance writes go through the `apply_account_balance_delta` RPC (optimistic lock). Overpayment protection lives in UI guards — the store silently clamps at 0, so the UI guard is the real protection. Follow these patterns for any code that moves money.

### Two app modes — trace both, always

`appModeStore` holds `full_tracker` vs `splits_only` (ledger-only). Full-tracker creates transaction rows against real accounts; ledger-only has **no accounts** — transaction rows may have BOTH account ids null, and guards requiring an account need an `isLedgerOnlyMode ||` escape. Before calling any money feature done, enumerate every artifact each mode leaves behind (transaction row? activity entry? statement line? loan history?) and verify each exists. This has silently vanished user payment records before.

### Other conventions that bite

- **i18n:** every user-facing string lives in `src/lib/i18n.ts` as `{ ur, en }` — `ur` is roman Urdu (Latin script). A device with **no stored `hisaab_lang`** gets `ur`: the fallback is the single `DEFAULT_LANGUAGE` constant at the top of `i18n.ts`, and flipping that constant fully reverts the decision (audit 2026-09 UX-04). Any explicit choice — onboarding step 0, the Settings row, `LanguageToggle` — writes `hisaab_lang` via `setLang` and always wins, `'en'` included. `setLang` also mirrors the choice onto `profiles.lang` so server-composed cross-user content can be localized for the *reader* (audit N-1, `supabase-migration-p1-profile-lang.sql`). The Vitest suite pins `hisaab_lang='en'` in `vitest.setup.ts` because several tests assert English copy verbatim. No hardcoded English in JSX; `npm run lint` enforces this in `src/pages` + `src/components` via `no-restricted-syntax` selectors, with a shrinking TODO ignore list documented in `eslint.config.js`. Check both languages render.
- **Pure logic goes in `src/lib/` with a colocated `*.test.ts`.** Vitest runs in Node (no DOM), timezone pinned to UTC via `vitest.setup.ts`. Tests deliberately cover pure functions only; stores/DB writes are verified manually — that's the repo's testing philosophy (see `vitest.config.ts` header). Search `src/lib/` for existing math/allocation/parsing engines before designing new ones.
- **Grouping keys:** person key = `personId ?? lowercased trimmed name` (`src/lib/personLoans.ts` `loansForPerson` is the shared per-contact filter); loan grouping includes direction + currency. A person can hold both directions and multiple currencies simultaneously — never merge across either. (Statements are the one deliberate exception: `buildStatement` nets directions within a currency, never across currencies.)
- **Statements / person ledger:** one pure engine feeds every surface — `statementOfAccount.buildStatement` (`detail: 'compact'` folds settled loans for the WhatsApp text / one-page PDF; `'full'` itemises everything) → `statementRows.ts` (lump repayments regrouped into one row, month blocks that reconcile) → `statementText.ts` / `statementPdf.ts` (one page) / `statementPdfPages.ts` (multi-page, full history) and `PersonLedgerPage` (`/person/:personId/ledger`). Anything that builds a statement must first gate on `ensureTransactionHistory({ all: true })` + `historyCoverage.complete` — the store holds a bounded window. A lump repayment fanned out across loans is identified by its settlement-request ids `${intentId}:${loanId}` (`settlementBatchKeys`); pending linked requests never count in a total (`pendingLedger.ts` shows them beside it).
- **Routing/auth:** `src/App.tsx` lazy-loads every page and hard-gates on email verification (`user.email_confirmed_at`), then onboarding completion. Account deletion is a soft delete (`is_deleted` via RPC).
- **Errors:** report through `reportError(err, context)` from `src/lib/errorReporter.ts` (routes to Sentry when `VITE_SENTRY_DSN` is set, console otherwise).

### Env vars

`VITE_SUPABASE_URL` + `VITE_SUPABASE_ANON_KEY` (required), `VITE_PUBLIC_APP_URL` (canonical/invite URLs), `VITE_SENTRY_DSN` (optional). `.env` is gitignored; `.env.example` lists them, plus the optional rollout flags.
