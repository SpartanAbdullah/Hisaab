// Statement-native credit-card instalments — the pure heart of the model.
//
// A cash advance's instalment is a LINE on the card's monthly statement,
// anchored to the card's statement day (metadata.dueDay), not a separate loan
// on its own calendar. This module owns three pure pieces:
//   1. statementInstalmentDates — anchors an instalment plan to the statement
//      day (used at creation AND by the per-card re-anchor migration).
//   2. buildCardStatement — this cycle's honest bill: purchases + instalment,
//      distinct from the full revolving balance.
//   3. allocateBillPayment — one "Pay bill" that covers this cycle's
//      instalment(s) first, then purchases, then prepays — replacing the old
//      greedy "wipe the oldest advance" bridge.
//
// The invariant every piece preserves (the thing that prevents the old
// double-credit disaster):
//     card `used` (= creditLimit − balance) = revolving purchases + Σ(cash-advance remaining)
// The cash-advance principal is ALREADY inside `used`; the loan just tracks
// its share. So a payment reduces `used` and the matching share of the loans
// in lockstep — the same debt is never counted twice, money never minted.
import { daysUntilDayOfMonth, lastDayOfMonthOccurrence } from './inboxInfo';
// Canonical local-calendar-date helper (src/lib/localDate.ts has no other
// imports, so pulling it in here carries none of the thisWeek↔cardStatement
// import-cycle risk the old inlined copy was dodging).
import { localIso } from './localDate';
import type { Account, EmiSchedule, Loan, Transaction } from '../db';

const round2 = (n: number) => Math.round(n * 100) / 100;

function daysInMonth(year: number, monthIndex: number): number {
  return new Date(year, monthIndex + 1, 0).getDate();
}

function dayOfMonthOrNull(raw: string | undefined): number | null {
  const d = parseInt(raw ?? '', 10);
  return Number.isFinite(d) && d >= 1 && d <= 31 ? d : null;
}

/** The day the payment is DUE (metadata.dueDay). */
export function cardDueDay(card: Account): number | null {
  return dayOfMonthOrNull(card.metadata?.dueDay);
}

/** The day the statement CLOSES (metadata.statementDay). Real cards close the
 *  cycle, then give ~3 weeks to pay — so this is usually well before dueDay.
 *  Falls back to dueDay for cards saved before the two-date model existed. */
export function cardStatementDay(card: Account): number | null {
  return dayOfMonthOrNull(card.metadata?.statementDay) ?? cardDueDay(card);
}

/** Instalment due-dates for a statement-native plan: `count` dates, each on
 *  the card's statement day, one month apart, the first being the next
 *  statement day STRICTLY AFTER `fromIso` — an advance taken today is billed
 *  on the next statement, like a real card. Days are clamped to month length
 *  (a 31st due-day lands on the 30th in a 30-day month). Returns [] for an
 *  invalid due day. */
export function statementInstalmentDates(dueDay: number, count: number, fromIso: string): string[] {
  if (!Number.isFinite(dueDay) || dueDay < 1 || dueDay > 31 || count <= 0) return [];
  const from = new Date(`${fromIso.slice(0, 10)}T00:00:00`);
  const fromMid = from.getTime();
  const y = from.getFullYear();
  let m = from.getMonth();
  // First statement day strictly after `from`; roll to next month if the
  // statement day this month has already passed (or is today).
  const thisMonth = new Date(y, m, Math.min(dueDay, daysInMonth(y, m)));
  if (thisMonth.getTime() <= fromMid) m += 1;
  const out: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const total = m + i;
    const yy = y + Math.floor(total / 12);
    const mm = ((total % 12) + 12) % 12;
    out.push(localIso(new Date(yy, mm, Math.min(dueDay, daysInMonth(yy, mm)))));
  }
  return out;
}

export interface CardStatement {
  /** Payment-due day (metadata.dueDay) — when the bill must be paid. */
  dueDay: number;
  /** Statement-close day (metadata.statementDay, falls back to dueDay) — when
   *  the cycle closes and the bill is issued. */
  statementDay: number;
  /** Local YYYY-MM-DD start of the current statement cycle (last statement-close occurrence). */
  cycleStartIso: string;
  /** Days until the upcoming PAYMENT-due day (0 = today), or null. */
  daysUntilDue: number | null;
  /** Non-instalment balance = used − Σ(advance remaining): purchases + any
   *  carried balance. All of it is due (no financing behind it). */
  revolving: number;
  /** This cycle's instalment(s) due across the card's cash-advance plans. */
  instalmentDue: number;
  /** Card spending dated AFTER the last statement close (cycleStartIso) —
   *  it belongs to the NEXT statement, so it is not part of statementDue.
   *  0 when no transactions were passed or the card has no distinct
   *  statement-close day (see buildCardStatement's rule). */
  postCloseSpend: number;
  /** The revolving share of THIS statement still owed:
   *  max(0, revolving − postCloseSpend). Equals `revolving` when
   *  postCloseSpend is 0. */
  statementRevolving: number;
  /** The honest monthly bill = statementRevolving + this cycle's instalment. The
   *  FUTURE instalment principal (the rest of Σ remaining) is NOT here — that's
   *  what makes it smaller than the full balance for a financed card. */
  statementDue: number;
  /** Full revolving balance = max(0, creditLimit − balance). */
  totalOwed: number;
  hasLimit: boolean;
}

/** How much a transaction ADDED to this card's revolving debt, in the card's
 *  currency (0 if it didn't debit the card, or doesn't count as spending).
 *  Mirrors the per-type balance arithmetic in transactionStore's delete
 *  reversal, so the figure is exactly what the row took off the card:
 *    expense / loan_given / transfer-out   → amount (source currency)
 *    repayment / goal_contribution /
 *    investment_buy (source = card)        → amount ÷ conversionRate when set
 *  Deliberately NOT spending:
 *    loan_taken (cash advance)  — its principal sits in Σ(advance remaining)
 *                                 and is already excluded from `revolving`;
 *    adjustment                 — "Correct balance" is bookkeeping repair of
 *                                 unknown date, not a dated purchase, so it
 *                                 stays with the statement (never hides debt). */
export function cardSpendOf(txn: Transaction, cardId: string): number {
  if (txn.deletedAt) return 0;
  if (txn.sourceAccountId !== cardId) return 0;
  const amt = Number.isFinite(txn.amount) ? Math.max(0, txn.amount) : 0;
  switch (txn.type) {
    case 'expense':
    case 'loan_given':
    case 'transfer':
      return round2(amt);
    case 'repayment':
    case 'goal_contribution':
    case 'investment_buy':
      return txn.conversionRate ? round2(amt / txn.conversionRate) : round2(amt);
    default:
      return 0;
  }
}

/** Σ card spending dated strictly AFTER `closeIso` (local calendar day). A
 *  purchase ON the statement day is inside that statement, like a bank's
 *  "transactions up to and including the statement date". */
export function cardSpendAfter(cardId: string, transactions: Transaction[], closeIso: string): number {
  let sum = 0;
  for (const t of transactions) {
    const spend = cardSpendOf(t, cardId);
    if (spend <= 0) continue;
    const at = new Date(t.createdAt);
    if (!Number.isFinite(at.getTime())) continue;
    if (localIso(at) <= closeIso) continue;
    sum = round2(sum + spend);
  }
  return sum;
}

/** Compute a card's current statement — balance-derived; transactions are
 *  optional (they only sharpen the revolving share, see below). `advanceLoans` are the card's ACTIVE cash-advance loans (caller
 *  derives them via cardFundedLoanIds); `schedules` is the full EMI-schedule
 *  list (filtered by loanId here). Returns null for a non-card or a card with
 *  no statement day configured.
 *
 *  Honest bill = everything you owe EXCEPT the not-yet-due instalment
 *  principal. A plain card (no instalment plan) bills its whole balance; a
 *  card financing a cash advance bills only its purchases + this cycle's
 *  instalment.
 *
 *  STATEMENT-CLOSE RULE (backlog 2026-09-22 #4 — Mashreq: the bank's statement
 *  of 21 Sep said 5,898.15, Hisaab also billed ~711 spent after the 21st):
 *
 *    postCloseSpend     = Σ card spending (cardSpendOf) dated after the last
 *                         statement close (cycleStartIso)
 *    statementRevolving = max(0, revolving − postCloseSpend)
 *    statementDue       = min(totalOwed, statementRevolving + instalmentDue)
 *
 *  Why this is the whole story with the existing model:
 *    • revolving (now) = revolving at close + spend since close − credits since
 *      close. Removing the spend leaves "balance at close − every credit since"
 *      — i.e. the statement balance minus what has already been paid toward it.
 *    • Credits after the close (bill-payment `transfer`s into the card, refunds,
 *      repayments) therefore REDUCE what is still due — a payment made after
 *      the statement is issued pays that statement. They are never subtracted
 *      a second time.
 *    • The instalment share of a bill payment moves `used` and Σ(remaining) in
 *      lockstep (revolving untouched) and flips the instalment to paid, so it
 *      leaves instalmentDue via the schedule — not double-counted here.
 *    • A cash advance after the close raises `used` and Σ(remaining) equally,
 *      so it never reaches revolving; adjustments stay with the statement.
 *    • Clamped at 0: paying the statement in full and then spending leaves 0
 *      due now (the new spend is next statement's).
 *
 *  Applied ONLY when the card has a statement-close day distinct from its due
 *  day. A single-date card (no statementDay, or statementDay === dueDay) has no
 *  knowable close, so it keeps the old behaviour — the whole revolving balance
 *  is due. No `transactions` passed → postCloseSpend 0 → old behaviour. */
export function buildCardStatement(inp: {
  card: Account;
  advanceLoans: Loan[];
  schedules: EmiSchedule[];
  today: Date;
  /** Optional: the user's transactions (any accounts; filtered here). Enables
   *  the statement-close rule above. */
  transactions?: Transaction[];
}): CardStatement | null {
  const { card } = inp;
  if (card.type !== 'credit_card') return null;
  const dueDay = cardDueDay(card);
  if (dueDay === null) return null;
  // Statement CLOSES on statementDay (falls back to dueDay); payment is DUE on
  // dueDay. The cycle boundary follows the close; the countdown follows the due.
  const statementDay = cardStatementDay(card) ?? dueDay;

  const limit = parseFloat(card.metadata?.creditLimit || '0');
  const hasLimit = limit > 0;
  const totalOwed = hasLimit ? Math.max(0, round2(limit - card.balance)) : 0;

  const cycleStart = lastDayOfMonthOccurrence(statementDay, inp.today);
  const cycleStartIso = cycleStart ? localIso(cycleStart) : localIso(inp.today);
  const daysUntilDue = daysUntilDayOfMonth(dueDay, inp.today);
  // Upcoming statement day's ISO — instalments due on/before it belong to this bill.
  const nextDueIso =
    daysUntilDue === null
      ? cycleStartIso
      : localIso(new Date(inp.today.getFullYear(), inp.today.getMonth(), inp.today.getDate() + daysUntilDue));

  // This cycle's instalment = the earliest unpaid instalment per advance whose
  // due date lands on/before the upcoming statement day (includes anything
  // overdue that should already have been billed).
  const loanIds = new Set(inp.advanceLoans.map((l) => l.id));
  const byLoan = new Map<string, EmiSchedule[]>();
  for (const s of inp.schedules) {
    if (!loanIds.has(s.loanId)) continue;
    const list = byLoan.get(s.loanId);
    if (list) list.push(s);
    else byLoan.set(s.loanId, [s]);
  }
  let instalmentDue = 0;
  for (const list of byLoan.values()) {
    const nextUnpaid = list
      .filter((s) => s.status !== 'paid')
      .sort((a, b) => a.installmentNumber - b.installmentNumber)[0];
    if (nextUnpaid && nextUnpaid.dueDate <= nextDueIso) {
      instalmentDue = round2(instalmentDue + nextUnpaid.amount);
    }
  }

  // Non-instalment debt (purchases + carried) — the advance PRINCIPAL sits in
  // Σ remaining and is financed, so it's excluded here.
  const sumRemaining = round2(inp.advanceLoans.reduce((s, l) => s + l.remainingAmount, 0));
  const revolving = hasLimit ? Math.max(0, round2(totalOwed - sumRemaining)) : 0;
  // Statement-close rule (see the doc comment): only with a DISTINCT close day.
  const hasDistinctClose = dayOfMonthOrNull(card.metadata?.statementDay) !== null && statementDay !== dueDay;
  const postCloseSpend =
    hasLimit && hasDistinctClose && inp.transactions && cycleStart
      ? cardSpendAfter(card.id, inp.transactions, cycleStartIso)
      : 0;
  const statementRevolving = Math.max(0, round2(revolving - postCloseSpend));
  const statementDue = hasLimit
    ? Math.min(totalOwed, round2(statementRevolving + instalmentDue))
    : round2(instalmentDue);

  return {
    dueDay, statementDay, cycleStartIso, daysUntilDue, revolving, instalmentDue,
    postCloseSpend, statementRevolving, statementDue, totalOwed, hasLimit,
  };
}

export interface AdvanceForAllocation {
  loanId: string;
  remaining: number;
  /** This statement's instalment amount for this plan (0 if none due). */
  dueThisCycle: number;
  /** Origin date — drives oldest-first ordering. */
  createdAt: string;
}

export interface BillAllocationLine {
  loanId: string;
  principalApplied: number;
}

export interface BillAllocation {
  /** Per-advance principal to knock off (store reduces remaining + marks instalments). */
  perLoan: BillAllocationLine[];
  /** Payment portion covering revolving card purchases (no loan touched). */
  purchasesApplied: number;
  /** Overpayment beyond the full balance → available-credit surplus (Overpaid state). */
  surplus: number;
}

/** Allocate a bill payment the statement-native way:
 *   1. this cycle's instalment(s), oldest advance first;
 *   2. revolving purchases;
 *   3. prepay remaining advance principal, oldest first (so "pay the whole
 *      balance" still clears everything);
 *   4. anything left is surplus (overpayment).
 *  Σ(perLoan) + purchasesApplied + surplus === payment, so the card-balance
 *  credit and the loan reductions always stay consistent with the invariant. */
export function allocateBillPayment(inp: {
  payment: number;
  /** used − Σ(remaining) at payment time; may be negative if already overpaid. */
  revolvingPurchases: number;
  advances: AdvanceForAllocation[];
}): BillAllocation {
  let left = round2(Math.max(0, inp.payment));
  const oldest = [...inp.advances].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const applied = new Map<string, number>();

  const take = (loanId: string, want: number): void => {
    const amt = round2(Math.min(Math.max(0, want), left));
    if (amt <= 0.005) return;
    applied.set(loanId, round2((applied.get(loanId) ?? 0) + amt));
    left = round2(left - amt);
  };

  // 1. This cycle's instalments (never more than the plan's remaining).
  for (const a of oldest) {
    if (left <= 0.005) break;
    take(a.loanId, Math.min(a.dueThisCycle, a.remaining));
  }
  // 2. Revolving purchases.
  const purchasesApplied = round2(Math.min(Math.max(0, inp.revolvingPurchases), left));
  left = round2(left - purchasesApplied);
  // 3. Prepay remaining advance principal, oldest first.
  for (const a of oldest) {
    if (left <= 0.005) break;
    const room = round2(a.remaining - (applied.get(a.loanId) ?? 0));
    if (room > 0.005) take(a.loanId, room);
  }
  // 4. Whatever's left is genuine overpayment.
  const surplus = round2(Math.max(0, left));

  const perLoan = oldest
    .map((a) => ({ loanId: a.loanId, principalApplied: applied.get(a.loanId) ?? 0 }))
    .filter((l) => l.principalApplied > 0.005);

  return { perLoan, purchasesApplied, surplus };
}

/** The allocation inputs for a bill payment made ON `when` (the payment's own
 *  date, not "now" — a bill paid on 29 Aug and recorded on 21 Sep must step
 *  the instalment that was due for AUGUST's statement, not September's).
 *
 *  Per advance, `dueThisCycle` = its earliest unpaid instalment when that
 *  instalment falls due on/before the next payment-due day counted from
 *  `when` (anything overdue is included). Advances are returned in the order
 *  given (the caller passes them oldest-first). */
export function billAdvancesAsOf(inp: {
  loans: Array<Pick<Loan, 'id' | 'remainingAmount' | 'createdAt'>>;
  schedules: Array<Pick<EmiSchedule, 'loanId' | 'status' | 'installmentNumber' | 'dueDate' | 'amount'>>;
  /** metadata.dueDay of the card (1–31). */
  dueDay: number;
  /** The payment's date. */
  when: Date;
}): AdvanceForAllocation[] {
  const dueIn = daysUntilDayOfMonth(inp.dueDay, inp.when) ?? 0;
  const nextDueIso = localIso(
    new Date(inp.when.getFullYear(), inp.when.getMonth(), inp.when.getDate() + dueIn),
  );
  return inp.loans.map((l) => {
    const next = inp.schedules
      .filter((s) => s.loanId === l.id && s.status !== 'paid')
      .sort((a, b) => a.installmentNumber - b.installmentNumber)[0];
    const dueThisCycle = next && next.dueDate <= nextDueIso ? next.amount : 0;
    return { loanId: l.id, remaining: l.remainingAmount, dueThisCycle, createdAt: l.createdAt };
  });
}

export interface ReanchorUpdate {
  id: string;
  oldDue: string;
  newDue: string;
}

/** Plan the "Align to statement day" re-dating for ONE cash-advance plan.
 *  Date-only — amounts never change.
 *
 *  Rule (backlog 2026-09-22 #4 — on the RAK card Align was pressed before the
 *  payments were recorded and every instalment slid a month late):
 *    • FROZEN — keeps its date: a paid instalment, or an unpaid one already
 *      BILLED, i.e. due on/before the upcoming payment-due day (it is on the
 *      statement being paid now, or overdue from an earlier one).
 *    • MOVABLE — every other unpaid instalment moves to the FIRST due-day on or
 *      after its current date, so it stays on the same bill it was already
 *      going to be billed on (buildCardStatement bills an instalment on the
 *      first due day ≥ its date). Never earlier, never a whole month later.
 *    • MONOTONIC — walking the plan in instalment order, a moved instalment
 *      must land in a calendar month strictly after the previous instalment's
 *      month (frozen or moved); if its target would share or precede it, it
 *      is bumped to the next free month. No two instalments share a month.
 *  Returns only the rows whose date actually changes ([] = already aligned). */
export function planStatementReanchor(inp: {
  /** One loan's schedule rows (any order). */
  schedules: Array<Pick<EmiSchedule, 'id' | 'status' | 'installmentNumber' | 'dueDate'>>;
  /** Card metadata.dueDay (1–31). */
  dueDay: number;
  today: Date;
}): ReanchorUpdate[] {
  const { dueDay } = inp;
  if (!Number.isFinite(dueDay) || dueDay < 1 || dueDay > 31) return [];
  const dIn = daysUntilDayOfMonth(dueDay, inp.today);
  if (dIn === null) return [];
  const upcomingDueIso = localIso(
    new Date(inp.today.getFullYear(), inp.today.getMonth(), inp.today.getDate() + dIn),
  );
  const monthKey = (iso: string): number => {
    const y = parseInt(iso.slice(0, 4), 10);
    const m = parseInt(iso.slice(5, 7), 10) - 1;
    return y * 12 + m;
  };
  const dueDateIn = (key: number): string => {
    const y = Math.floor(key / 12);
    const m = key % 12;
    return localIso(new Date(y, m, Math.min(dueDay, daysInMonth(y, m))));
  };

  const ordered = [...inp.schedules].sort((a, b) => a.installmentNumber - b.installmentNumber);
  const out: ReanchorUpdate[] = [];
  let prevKey: number | null = null;
  for (const s of ordered) {
    const current = s.dueDate.slice(0, 10);
    const frozen = s.status === 'paid' || current <= upcomingDueIso;
    if (frozen) {
      const k = monthKey(current);
      prevKey = prevKey === null ? k : Math.max(prevKey, k);
      continue;
    }
    // First due-day on/after the current date — the same bill it's already on.
    let key = monthKey(current);
    if (dueDateIn(key) < current) key += 1;
    if (prevKey !== null && key <= prevKey) key = prevKey + 1;
    prevKey = key;
    const newDue = dueDateIn(key);
    if (newDue !== current) out.push({ id: s.id, oldDue: s.dueDate, newDue });
  }
  return out;
}
