# Who owes me — unified person balances + settle-up plans

**Status:** pure logic shipped (`src/lib/whoOwesMe.ts`, `src/lib/settleUpMinimize.ts`,
both with colocated tests). **UI status (2026-09-22):** `settleUpMinimize` drives
the group settle-up plans in `GroupDetailPage.tsx` (via `splitStore`). The
unified Loans "Who owes what" card (`WhoOwesMeCard`) was wired and then
removed in the 2026-09-19 founder batch (44f95aa), so `buildWhoOwesMe` has no
screen today. Nothing here touches accounts, stores, SQL or i18n.

Closes the *math* half of audit `docs/audit-2026-09/11-competitive-analysis.md`
**G4 / O7** ("debt-minimization settle-up + unified who-owes-me surface") and
gives `06-user-experience.md` **UX-23** ("three unsignposted split mechanisms")
the one screen that makes the three doors add up.

---

## 1. The problem

Hisaab records an obligation four different ways:

| # | Mechanism | Where it lives | Person identified by |
|---|-----------|----------------|----------------------|
| 1 | Personal loan | `Loan` row (`given` / `taken`) | `personId` (contact) or free-typed name |
| 2 | Linked loan | the same `Loan` row + `loanPairId` | contact, always linked |
| 3 | Ad-hoc split | **also a `Loan` row** — `splitEvent.ts` fans one action out into one loan per participant | contact or free-typed name |
| 4 | Group split | `SplitGroup` expenses/settlements, netted by `groupDebts.computePairwiseDebts` | a **per-group member id** |

A user with a loan to Bilal, a Friday-lunch split with Bilal and a Dubai-trip
group containing Bilal reads three screens and does the arithmetic in their
head. `buildWhoOwesMe` does it for them.

---

## 2. Netting rules

### 2.1 One row per (person key, currency). Never per direction.

`youAreOwed` and `youOwe` are **separate columns on the same row**; `net` is
derived (`youAreOwed − youOwe`) and every contributing `source` is retained, so
the UI can always explain the number instead of asserting it. Rows never merge
across currency (PKR is never netted into AED — repo-wide rule) and never
collapse a direction away.

Sorting: `|net|` desc → gross volume desc → name → currency → key. Deterministic
and input-order independent.

### 2.2 Ad-hoc splits are a *classification*, not an addition

**This is the load-bearing rule.** `executeSplitEvent` writes one `Loan` per
participant — an ad-hoc split creates no new kind of debt. So
`adhocByLoanId` (built by `buildAdhocSplitIndex` from the `splitEventId` meta
that `internalNotes` stamps on the transaction rows) only **re-labels** a loan's
source as `kind: 'adhoc'` and attaches the split label. The amount is counted
once, from the loan. Passing split rows in as a separate money input would
double every lunch.

*Documented limitation:* in `splits_only` (ledger) mode an ad-hoc split writes
loans with **no transaction rows at all**, so there is nothing to read and those
loans surface as plain `loan` sources. Amount, direction and person are
identical either way — only the label and the deep-link target differ.

### 2.3 What counts

| Included | Excluded |
|----------|----------|
| Active loans with `remainingAmount > 0.005` | `status === 'settled'`, fully repaid, `deletedAt` set |
| Linked loans (flagged `linked: true` on the source) | — |
| Group debts **on an edge the signed-in user is on** | edges between two other members (not your money) |
| Ledger-mode loans with no account leg | — |
| — | groups where "me" cannot be identified (counted as nothing, never guessed) |

Partial repayments count at `remainingAmount`, never `totalAmount`.

### 2.4 Accounts are never touched

The aggregator reads obligations only. It has no account, balance or
transaction-as-money input, so **full_tracker and splits_only produce identical
rows** for the same loans and groups. Transactions are read for exactly one
purpose: labelling which loans came from an ad-hoc split (§2.2). Tolerance is
`0.005`, matching `statementOfAccount` and `groupSettleUp`.

---

## 3. The person-key mapping rule (and its ambiguity)

Loans already key on the repo-wide rule — `personId ?? lowercased trimmed name`
(`LoansPage.tsx:208`, `repaymentGroups.ts:46`). Group members live in a
different namespace (a per-group member id), so they must be mapped onto that
key. `resolveGroupMemberIdentity` walks three rules in order:

| Rule | Condition | Key | `matchedBy` | Confidence |
|------|-----------|-----|-------------|-----------|
| 1 | `member.profileId` matches a contact's `linkedProfileId` | contact id | `profile` | **provable** |
| 2 | exactly ONE non-archived contact's name matches, case/whitespace-insensitive | contact id | `name` | a guess |
| 3 | otherwise | lowercased trimmed member name | `none` | name-only |

Two contacts with the same name ⇒ **no match** (rule 2 refuses rather than
picking one). An archived contact can still satisfy rule 1 (the profile link is
still true) but never wins a rule-2 name guess against a live contact.

### The two ambiguities the UI must be honest about

1. **Rule 3 merges two different people who share a display name.** Two
   distinct "Bilal"s typed by hand become one row. This is *already* how loans
   behave app-wide, so nothing new is broken — but it becomes visible in one
   place, so a row's `matchedBy` is surfaced and a name-keyed row should never
   claim to be a verified person (see `VerifiedBadge` conventions).
2. **A contact-backed row does NOT merge with a same-name free-hand loan.**
   `c-bilal` and `bilal` are different keys, so Bilal-the-contact and
   Bilal-typed-by-hand stay two rows. Silently merging them on a name match is
   exactly the kind of quiet wrongness a trust product cannot afford, and it is
   not what LoansPage does today. Instead `findLikelyDuplicateRows` returns the
   pair as a **hint**, so the UI can offer *"same person? link the contact"* and
   let the user decide.

"Me" inside a group is resolved by `resolveMeMemberId`: explicit `meMemberId` →
`profileId === currentProfileId` → group owner (mirroring
`GroupDetailPage.tsx:393`). The owner fallback is wrong on a group the user does
not belong to, so **callers must pass `currentProfileId` whenever they have it**;
when nothing resolves, the group contributes nothing rather than guessing.

Group debts must come from `computePairwiseDebts` (direct), **not** the store's
simplified list — simplified debts reroute through third parties and would
attribute money to the wrong person on a per-person screen.

---

## 4. The two settle-up plans

`settleUpMinimize.buildSettlePlans({ currency, debts })` returns both plans from
one set of pairwise debts:

| | `direct` | `minimized` |
|---|---|---|
| Source | the pairwise debts themselves (what Hisaab shows today) | greedy largest-creditor ↔ largest-debtor over the net balances |
| Transfers | one per non-zero pair | ≤ n−1 |
| Money moved | ≥ the floor | exactly Σ(positive balances) — the floor |
| Every transfer is between people who… | actually transacted | may never have met |

`transfersSaved`, `rerouted` (the transfers with no direct debt behind them) and
`minimizedFellBackToDirect` are returned so the toggle can be labelled honestly
rather than presented as free magic.

### The trade-off, stated plainly

Simplification is the single biggest trust complaint about Splitwise: it can
tell you to pay a near-stranger. `groupDebts.ts` exists precisely to default
away from that. So the minimized plan must always be an **explicit opt-in**, and
whenever `rerouted` is non-empty the UI owes the user a line to the effect of
*"this routes payments through people you didn't split with"*.

### What "minimized" actually minimizes

The transfer **count**, heuristically. The exact fewest-transfers problem is
NP-hard (set-partition in disguise); this is the standard greedy pass, O(n log n)
from the two sorts, and **not a proven optimum**. Greedy can genuinely lose to
the direct graph — balances `A −4, B −3, C +2, D +2, E +3` settle directly in 3
transfers but greedily in 4. When that happens `buildSettlePlans` **falls back to
the direct plan** and sets `minimizedFellBackToDirect`, so the invariant
`minimized.count ≤ direct.count` holds by construction and the toggle never
offers a "simplified" plan bigger than the plan it simplifies. The fallback only
fires when the direct plan actually settles those balances (a caller passing
unrelated explicit balances is never handed a plan that leaves money owed).

Rounding: balances are folded per id, rounded to 2dp, and the residual cent is
absorbed **deterministically** — onto the entry with the largest `|net|`, ties
broken by the lowest id — so a plan always sums to exactly zero and the output
does not depend on input ordering.

Multi-currency: `buildSettlePlansByCurrency` partitions first and produces one
plan pair per currency. Nothing is ever netted across currencies.

---

## 5. Module contracts

### `src/lib/settleUpMinimize.ts`

```ts
export const SETTLE_TOLERANCE = 0.005;

normalizeBalances(balances: MemberBalance[]): MemberBalance[]
netBalancesFromDebts(debts: GroupDebt[]): MemberBalance[]
minimizeTransfers(balances: MemberBalance[]): Transfer[]
directTransfers(debts: GroupDebt[]): Transfer[]
buildSettlePlans({ currency, debts, balances? }): SettlePlans
buildSettlePlansByCurrency(debts: CurrencyTaggedDebt[]): SettlePlans[]
applyTransfers(balances, transfers): MemberBalance[]   // proof helper
```

`SettlePlans = { currency, balances, direct, minimized, transfersSaved,
rerouted, minimizedFellBackToDirect }`; each plan is
`{ strategy, transfers, count, total }`.

### `src/lib/whoOwesMe.ts`

```ts
export const WHO_OWES_TOLERANCE = 0.005;

personKeyOf(personId, name): string
buildAdhocSplitIndex(transactions: Transaction[]): Map<loanId, AdhocSplitRef>
resolveGroupMemberIdentity(member, contacts): ResolvedIdentity
resolveMeMemberId(group, currentProfileId?): string | null
buildWhoOwesMe(input: WhoOwesInput): WhoOwesRow[]
whoOwesTotals(rows): WhoOwesCurrencyTotal[]
findLikelyDuplicateRows(rows): DuplicateRowHint[]
```

```ts
WhoOwesRow = {
  personKey; personName; personId: string | null; currency;
  youAreOwed; youOwe; net;
  sources: { kind: 'loan'|'group'|'adhoc'; id; amount; direction; currency;
             label; linked?; memberId? }[];
  matchedBy: 'profile' | 'name' | 'none';
}
```

Neither module imports a store, a page, `supabaseDb`, `i18n` or anything with a
side effect. Every label they emit is raw data (a loan note, a group name, a
split label) — **the UI must translate its own chrome through `i18n.ts`**.

---

## 6. UI follow-up (owned by a later batch — nothing below is built)

### 6a. Unified "Who owes me" surface

* **`src/pages/HomePage.tsx`** — the `Mera Hisaab` card at **:1151–1195** already
  shows one net position including people, but its receivable/payable figures
  come from `computeMeraHisaab(loans, accounts)` only: **group balances and
  group-side obligations are missing from the headline number.** Feeding
  `whoOwesTotals(buildWhoOwesMe(...))` in makes it complete. The per-person list
  belongs behind the **2-up "To Receive | To Pay" block at :1003**, which today
  drills straight into `/loans`.
* **`src/pages/LoansPage.tsx`** — tabs are `receivables | payables | settled`
  (**:42**, chips at **:521**). The unified view is a natural fourth surface, or
  better: the existing `groupBy` at **:205–228** keeps its key
  (`${direction}:${currency}:${personKey}`, :208–209) and each row gains the
  group/ad-hoc sources for the same person key, so the loan row for Bilal finally
  says *"+ AED 80 from Dubai Trip"*. Keep `LoanGroup` as-is and merge
  `WhoOwesRow.sources` in at render time — do not re-key.
* Row chrome must respect `matchedBy`: a `name`/`none` row is a guess. Offer
  `findLikelyDuplicateRows` hints as a "link this contact?" affordance; never
  auto-merge.
* New strings go in `src/lib/i18n.ts` as `{ ur, en }` (`ur` = roman Urdu,
  default). Check both render.

### 6b. Settle-up plan toggle

A simplify toggle **already exists** and is where this work lands:

* **`src/pages/GroupDetailPage.tsx:255`** (`const [simplify, setSimplify]`),
  **:420** (`shownDebts = simplify ? debts : pairwiseDebts`), and the toggle
  header at **:1058–1066** — which is **hardcoded English** ("Simplified", "Show
  direct", "Who owes whom") with no i18n keys, no transfer counts and no reroute
  warning.
* **`src/stores/splitStore.ts:1171–1231`** (`getSimplifiedDebts`) is a *second,
  inline copy* of the greedy algorithm. It uses a `0.01` threshold, sorts with no
  id tiebreak (so its output can vary with `Map` iteration order under ties), and
  has **no count guard** — it can hand the user a "simplified" plan with more
  transfers than the direct one. Replace its body with
  `buildSettlePlans({ currency, debts: computePairwiseDebts(...) }).minimized`
  rather than adding a third implementation.
* **`src/pages/GroupSettleUpModal.tsx`** receives `debts` + `simplify` as props
  (**:20–23**) and never tells the recipient which plan they are reading. The
  toggle belongs here too: show `direct.count` vs `minimized.count`
  ("3 transfers → 2"), and when `rerouted.length > 0` render the trust warning
  before the WhatsApp/PDF share (`buildMemberCardText` / `buildFullPlanText` in
  `groupSettleUp.ts` are unchanged and stay the renderers).
* All four new labels need i18n keys; none exist yet.

### 6c. Not in scope here

No SQL, no store rewiring, no account legs. Note that group settle-up still has
**no account leg at all** (audit UX-21) — unrelated to this module, but the same
modal is where that fix lands.

---

## 7. Open risks

1. **The audit's G4 is half-wrong and the doc above corrects it:** debt
   minimization *does* exist, buried in `splitStore.getSimplifiedDebts` and
   toggled by an unlabelled English link. The real gaps are the missing
   count/reroute honesty, the unguarded worse-than-direct case, and the absent
   cross-mechanism person view.
2. **The owner fallback in `resolveMeMemberId`** is wrong for a group the user
   does not belong to. Always pass `currentProfileId`.
3. **Ad-hoc labelling is invisible in ledger mode** (§2.2) — money is right, the
   label is generic.
4. **Rule-3 name collisions** merge distinct same-named people; rule 1/2 vs rule
   3 splits one person into two rows. Both are pre-existing app behaviour, now
   concentrated on one screen.
5. **Two zero-tolerances coexist:** this module and `statementOfAccount` use
   `0.005`; `groupDebts` and `splitStore` use `0.01`. Sub-cent disagreements are
   possible at the boundary. Worth unifying when the store is rewired.

---

## 8. Tolerance rule

`src/lib/moneyTolerance.ts` is the shared home for both tolerances risk #5
names — but they were deliberately **not** collapsed into one number. Full
reasoning and a worked proof live in that file's header and in
`moneyTolerance.test.ts`'s "server boundary" tests; this section is the short
version.

**`MONEY_TOLERANCE = 0.005`** — the general "this is float noise, not real
money" epsilon. `settleUpMinimize.SETTLE_TOLERANCE`, `whoOwesMe.WHO_OWES_TOLERANCE`
and `statementOfAccount`'s inline `0.005` all mean this same number (re-exported
as aliases from `moneyTolerance.ts` for new importers; the three original files
keep their own local exports unchanged). `groupSettleUp.ts` now imports it
directly instead of its old inline `0.005` literals.

**`GROUP_SETTLEMENT_TOLERANCE = 0.01`** — a *different* number: the server's own
zero cutoff for group settlements.
- `record_group_settlement` (`supabase-migration-audit-p0-group-concurrency.sql:381`)
  refuses to record any settlement once the outstanding cap is `<= 0.01`
  (`ALREADY_SETTLED`), and its raw-insert backstop trigger (`:451`) applies the
  same cap.
- `leave_group` (`supabase-migration-safe-leave-group.sql:142`) blocks leaving
  only while `|net| > 0.01` — so an exact one-cent balance is "square enough"
  to leave.

Both gates round through Postgres' `round(x, 2)` before comparing — the same
rounding rule the client uses — so the two RPCs agree with each other exactly,
and both draw the line at **one cent**, not half a cent.

**Why `groupDebts.ts` keeps the stricter (larger) threshold.** `computePairwiseDebts`
is what `record_group_settlement`'s cap mirrors directly (the SQL comment at
concurrency.sql:215-219 says so explicitly), and its output also seeds
`settleUpMinimize`'s balances — the "minimized" plan settles through the same
RPC. If `groupDebts.ts` dropped pairwise nets at `MONEY_TOLERANCE` (0.005)
instead of `GROUP_SETTLEMENT_TOLERANCE` (0.01), an exact one-cent net position
(`0.01 > 0.005`) would be shown to the user as a real, payable debt — and the
server would then refuse to record it (`cap 0.01 <= 0.01` ⇒ `ALREADY_SETTLED`).
Symmetrically, on the leave-group gate, that same one cent is "square enough"
server-side but would still read as an open balance client-side. So
`groupDebts.ts` imports `GROUP_SETTLEMENT_TOLERANCE`, not `MONEY_TOLERANCE` — it
is intentionally the **stricter side** (it calls fewer things "real money" than
a bare 0.005 would), which is the safe direction: everything `groupDebts.ts`
shows as a debt, the server also agrees is non-zero.

**Which side rounds first.** Both sides round to cents before the tolerance
check ever runs — `groupDebts.ts`'s `Math.round(net * 100) / 100` and Postgres'
`round(v_net, 2)` — so in practice every value entering either comparison is
already an exact multiple of one cent. That collapses "half-cent tolerance"
questions to one concrete case: is an exact one-cent net position zero or not.
`moneyTolerance.test.ts` pins that case down directly against a JS mirror of
the SQL (cited by line number) rather than trusting a description of it.

**The residual risk — closed.** `settleUpMinimize.ts` still nets member
balances at `MONEY_TOLERANCE` (0.005) internally, and `minimizeTransfers`
itself is unchanged: it can still legitimately produce a one-cent transfer
between two people who never transacted directly — the tail end of a longer
settle chain, not a bug in the greedy algorithm. `moneyTolerance.test.ts`'s
worked six-person example still demonstrates that raw shape: two real,
well-above-a-cent pairwise debts each contribute to a member's overall
balance, and two *different* members land on net positions of `+0.01` and
`-0.01` with no direct edge between them, so raw `minimizeTransfers` pairs
them for a `0.01` transfer that the server's cap would refuse as
`ALREADY_SETTLED`.

What changed: `buildSettlePlans` now runs every greedy plan through
`absorbSubSettlementTransfers` before it is offered as `minimized`. That
function drops any transfer with amount `<= GROUP_SETTLEMENT_TOLERANCE` (0.01)
and re-absorbs its cents into the largest surviving transfer that shares the
same debtor or creditor, so the money isn't silently unaccounted for; when no
such transfer exists (as with the six-person example's isolated `D↔B` pair),
absorbing would mean inventing a brand-new transfer between a pair with no
plan entry at all, which is worse than the gap it's closing — so the residual
is left on the balance instead. A residual left this way is, by construction,
`<= 0.01`, and the server's own rule (`record_group_settlement` /
`leave_group`, both citing exactly `0.01`) treats that as already square, so
nothing is actually left owing. `settleUpMinimize.test.ts` reproduces the
six-person example and asserts the `minimized` plan no longer contains the
`D↔B` transfer, plus a 200-case property test that every `minimized` transfer
amount is strictly greater than `GROUP_SETTLEMENT_TOLERANCE`. `whoOwesMe.ts`
does not build settle plans and was out of scope for this fix.
