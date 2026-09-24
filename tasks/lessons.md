# Lessons

Rules I (Claude) must follow in this repo, distilled from corrections and near-misses.
Review at the start of every session.

## Corrections (2026-07-18 — bulk repayment left no record)

- **Trace BOTH app modes end-to-end for any money flow.** Full-tracker creates transaction
  rows; ledger-only (`splits_only`) historically mutated `loans.remainingAmount` with NO
  transaction, NO activity for partial payments, and NO statement itemisation. Shipping the
  bulk-repayment feature on top of that silently vanished the user's payment records. Rule:
  before calling a money feature done, enumerate every artifact each mode leaves behind
  (transaction row? activity entry? statement line? loan history?) and prove each exists.
- **Never gate a primary action behind an edge-case trigger.** The "spread across their
  loans" offer only appeared on overpayment — invisible the moment the typed amount fit the
  opened loan. Primary capabilities need persistent, always-visible affordances.
- **When end-to-end verification is blocked (no login), say so louder** and walk each state
  transition on paper for both modes — unit tests of the pure math did not catch a
  record-keeping hole one layer up.
- **When a user says "it does nothing", check the submit handler's FIRST guard line before
  anything else.** RepaymentModal's `if (!parsedAmount || !accountId) return;` silently killed
  the Record-payment button in ledger mode (no account picker → accountId always '') while
  canSubmit kept the button enabled. A deploy log proving the build is current means the bug
  is real — stop suspecting staleness and re-read the entry-point guards for each mode.
  Also: every guard that requires an account must carry the `isLedgerOnlyMode ||` exception,
  and any code path over transactions must tolerate rows with BOTH account ids null (ledger
  repayment records).

## Process

- **Search for existing infrastructure before designing new.** The consolidated-repayment
  "missing feature" (2026-07-17) already had a pure, tested allocation engine
  (`src/lib/repaymentAllocation.ts` + `AllocateRepaymentModal`) — it was just buried on a
  secondary screen. The fix was surfacing + wiring, not building. Always grep for prior art
  (allocation, math, modals) before proposing new modules.
- **Every app change ships to BOTH web and Android** (`npm run build` + `npx cap sync android`,
  then hand off the Gradle AAB build). Never call a change done web-only.
- **Pure logic goes in `src/lib/` with a colocated `*.test.ts`** (Vitest). Stores/DB writes are
  verified manually — that's the repo's deliberate testing philosophy (see vitest.config.ts).
- **Money-moving code must follow the existing safety patterns:** `runSafeMutation`/`MutationScope`
  compensation, `apply_account_balance_delta` optimistic lock, UI-level overpayment guards
  (the store silently clamps at 0 — the UI guard is the real protection).
- **Keep grouping keys consistent app-wide:** person key = `personId ?? lowercased trimmed name`,
  group key includes direction + currency (LoansPage rule). A person can hold both directions
  and multiple currencies simultaneously — never merge across either.
- **i18n:** all user-facing strings live in `src/lib/i18n.ts` as `{ ur (roman Urdu), en }`.
  No hardcoded English in JSX; check both languages render.

## 2026-09-03 — first CI run of the audit branch, production apply
- **Never chain a test step with `;` before a push.** A `vitest … | grep ; npm run lint && … && git push` chain pushed with 5 failing tests. Every gate before a push is `&&`, and the push is the last link.
- **Non-migration SQL diagnostics must not be named `supabase-migration-*`.** The db-tests workflow's apply-order sanity check globs that prefix; a read-only preflight named that way failed CI. Use `supabase-<purpose>-<date>.sql` (like `supabase-audit-p0-verification.sql`).
- **Tests that import the data layer need placeholder `VITE_SUPABASE_*` env.** `src/lib/supabase.ts` builds the client at import time; locally `.env` masks the crash, CI has no `.env`. `vitest.config.ts` now supplies placeholders — do not remove them.
- **SQL files are LF-only (`.gitattributes`).** Windows autocrlf rewrote them to CRLF on a branch switch and broke the two tests that assert multi-line SQL. If a migration-parsing test fails only locally, check `file <name>.sql` for CRLF first.
- **Production applies happen in one window with the client deploy, and the 41 historical files are never re-run.** The founder ran the whole `apply-order.txt` including the harness prelude; it was harmless only because every historical file is idempotent and the batch order was preserved. The runbook now states the production list starts at `audit-p0-currencies`.
- **Harness assertions that read `auth.users` must be wrapped in `RESET ROLE; … SET ROLE authenticated;`** — the suite runs as `authenticated`, which has no SELECT on `auth.users`. A bare read aborts the whole file (psql exit 3), and the abort cascades into later files that depend on its fixture state, so the visible failure lands somewhere unrelated (2026-09-04: a D1 assertion in `50-lifecycle` surfaced as an N-10 notification failure in `60-notification-maturity`). When the assertion count drops instead of rising, look for an aborted file before reading the named failure.

## 2026-09-24 — a real AED 3,000 repayment never reached the account it was deposited into
- **A money-landing choice is never a silent default.** "Settle across all loans" had an "Apply to one of my accounts" switch that defaulted OFF and sat below the fold, so a linked repayment the founder had deposited into Mashreq was written record-only — and nothing could fix it afterwards. Any flow where money touches an account in Full Tracker must make the user pick an account OR an explicit "record only"; the submit waits for the choice (`SettlementAccountChoice`). And every record-only outcome needs a later repair path (`set_settlement_repayment_account` / "Add to an account").
- **Before trusting a mapped field, confirm its column exists.** `Loan.loanPairId` is mapped from `loans.loan_pair_id`, which no migration ever created — so it was always null and every linked-loan guard (edit/delete/repayment-delete) silently never fired. When a guard keys on a field, grep the migrations for the column first; derive linked-ness from the source of truth (`linkedPairIdForLoan` over the accepted linked-request rows).
- **One's own books must not wait on the other person.** A repayment recorded by the person who RECEIVED the money only helps the payer, so it applies to both ledgers at once (`record_received_repayment`); only a claim that costs the other side (a payer's claim, a new debt) waits for their OK.
