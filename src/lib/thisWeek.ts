// "This week" — the forward-looking merge of every obligation Hisaab KNOWS
// about without any bank sync: EMI instalments, kameti rounds, recurring
// charges, upcoming bills and credit-card due days, all within the next
// 7 days. Monarch sells this anticipation as its recurring feature's core
// value; Hisaab computes it from first-class objects instead of guesses.
// Pure + tested; rendering stays in HomePage.
import { cardPaymentThisCycle, daysUntilDayOfMonth } from './inboxInfo';
import { buildCardStatement } from './cardStatement';
import { daysUntil } from './subscriptionMetrics';
import { roundDate } from './committeeMath';
import { localIso } from './localDate';
import type {
  Account,
  Committee,
  EmiSchedule,
  Loan,
  RecurringTransaction,
  Transaction,
  UpcomingExpense,
} from '../db';

export type ThisWeekKind = 'emi' | 'kameti' | 'recurring' | 'bill' | 'card';

// Structured secondary line — the COMPONENT translates it (i18n lives in
// React, not here), which also kills the 'Due 25 · Due in 3d' double-Due.
export type ThisWeekSub =
  | { kind: 'emi'; n: number }
  | { kind: 'round'; r: number; total: number; count: number }
  | { kind: 'cadence'; cadence: string }
  | { kind: 'category'; text: string }
  // A card bill already CLEARED before its due day — the row praises
  // instead of nagging (daysEarly = days between now and the due day).
  | { kind: 'cleared'; daysEarly: number }
  | { kind: 'none' };

export interface ThisWeekRow {
  id: string;
  kind: ThisWeekKind;
  label: string;
  sub: ThisWeekSub;
  /** null = date-only row (e.g. a card with no limit set). */
  amount: number | null;
  currency: string;
  daysUntil: number;
  href: string;
  direction: 'pay' | 'receive';
}

export interface ThisWeekInputs {
  loans: Loan[];
  schedules: EmiSchedule[];
  committees: Committee[];
  templates: RecurringTransaction[];
  upcoming: UpcomingExpense[];
  accounts: Account[];
  /**
   * loanId → funding credit-card accountId, for cash-advance loans (derived
   * from the loan_taken transaction's sourceAccountId — the Loan row itself
   * carries no card link). Used to keep the SAME debt from appearing twice:
   * a cash-advance EMI is part of the card's owed amount, so when the card
   * itself can carry the obligation (it has a due day), the EMI row is
   * suppressed in favour of the card row.
   */
  cardFundedLoanIds?: Map<string, string>;
  /** When provided, a card due this week whose bill is ALREADY cleared
   *  (owed ≈ 0 + a payment landed this cycle) emits a praise row instead
   *  of silently vanishing. Optional so callers without transaction data
   *  keep the old behavior. */
  transactions?: Transaction[];
  today: Date;
}

const WINDOW_DAYS = 7;

// Local calendar date as YYYY-MM-DD. Every surface that compares against
// date-only fields (dueDate, nextDueDate, stamps) must use the SAME calendar
// — toISOString() is UTC and lags local by 4-5h in this app's Gulf/Pakistan
// markets, misclassifying "today" between midnight and dawn. Canonical home
// is src/lib/localDate.ts; re-exported here for existing importers.
export { localIso } from './localDate';

export function buildThisWeek(inp: ThisWeekInputs): ThisWeekRow[] {
  const todayIso = localIso(inp.today);
  const rows: ThisWeekRow[] = [];

  // 1) EMI instalments on active loans, both directions. Cash-advance EMIs
  //    are the card's debt (paying the bill settles them — cardCredit.ts):
  //    when the funding card can carry the obligation itself (it has a due
  //    day configured), the EMI row is suppressed so the same debt never
  //    counts twice in the weekly total.
  const loanById = new Map(inp.loans.map((l) => [l.id, l]));
  const accountById = new Map(inp.accounts.map((a) => [a.id, a]));
  for (const emi of inp.schedules) {
    if (emi.status === 'paid') continue;
    const loan = loanById.get(emi.loanId);
    if (!loan || loan.status !== 'active') continue;
    const fundingCardId = inp.cardFundedLoanIds?.get(loan.id);
    if (fundingCardId) {
      const card = accountById.get(fundingCardId);
      const cardDueDay = card ? parseInt(card.metadata?.dueDay ?? '', 10) : NaN;
      if (card && Number.isFinite(cardDueDay) && cardDueDay >= 1) continue;
    }
    const d = daysUntil(todayIso, emi.dueDate);
    if (d < 0 || d > WINDOW_DAYS) continue;
    rows.push({
      id: `emi-${emi.id}`,
      kind: 'emi',
      label: loan.personName,
      sub: { kind: 'emi', n: emi.installmentNumber },
      amount: emi.amount,
      currency: loan.currency,
      daysUntil: d,
      href: `/loan/${emi.loanId}`,
      direction: loan.type === 'taken' ? 'pay' : 'receive',
    });
  }

  // 2) Kameti rounds. currentRound() is backward-looking, so scan forward.
  //    ALL rounds inside the window are summed into one row — a daily kameti
  //    has up to 8, and the weekly total must reflect every one of them.
  //    The app tracks the whole committee (members carry no "me" flag), so
  //    this is "round due", with the per-member contribution as the amount.
  for (const c of inp.committees) {
    if (c.status !== 'active') continue;
    let firstRound: number | null = null;
    let firstDays = 0;
    let count = 0;
    for (let r = 1; r <= c.totalRounds; r += 1) {
      const d = daysUntil(todayIso, localIso(roundDate(c.startDate, c.cadence, r)));
      if (d < 0) continue;
      if (d > WINDOW_DAYS) break;
      if (firstRound === null) {
        firstRound = r;
        firstDays = d;
      }
      count += 1;
    }
    if (firstRound !== null) {
      rows.push({
        id: `kameti-${c.id}-r${firstRound}`,
        kind: 'kameti',
        label: c.name,
        sub: { kind: 'round', r: firstRound, total: c.totalRounds, count },
        amount: Math.round(c.contributionAmount * count * 100) / 100,
        currency: c.currency,
        daysUntil: firstDays,
        href: `/kameti/${c.id}`,
        direction: 'pay',
      });
    }
  }

  // 3) Recurring templates (all kinds, not just subscriptions).
  for (const tpl of inp.templates) {
    if (!tpl.active) continue;
    const d = daysUntil(todayIso, tpl.nextDueDate);
    if (d < 0 || d > WINDOW_DAYS) continue;
    rows.push({
      id: `rec-${tpl.id}`,
      kind: 'recurring',
      label: tpl.label || tpl.category,
      sub: { kind: 'cadence', cadence: tpl.cadence },
      amount: tpl.amount,
      currency: tpl.currency,
      daysUntil: d,
      href: '/subscriptions',
      direction: tpl.type === 'income' ? 'receive' : 'pay',
    });
  }

  // 4) Upcoming one-off bills.
  for (const bill of inp.upcoming) {
    if (bill.status !== 'upcoming') continue;
    const d = daysUntil(todayIso, bill.dueDate);
    if (d < 0 || d > WINDOW_DAYS) continue;
    rows.push({
      id: `bill-${bill.id}`,
      kind: 'bill',
      label: bill.title,
      sub: { kind: 'category', text: bill.category },
      amount: bill.amount,
      currency: bill.currency,
      daysUntil: d,
      href: '/goals',
      direction: 'pay',
    });
  }

  // 5) Credit-card due days. A fully paid (or overpaid) card has no
  //    obligation this week — only cards that actually owe, or whose owed
  //    amount is UNKNOWABLE (no limit configured), earn a row.
  for (const a of inp.accounts) {
    if (a.type !== 'credit_card') continue;
    const dueDay = parseInt(a.metadata?.dueDay ?? '', 10);
    const d = daysUntilDayOfMonth(dueDay, inp.today);
    if (d === null || d > WINDOW_DAYS) continue;
    const limit = parseFloat(a.metadata.creditLimit || '0');
    const owed = limit > 0 ? Math.round((limit - a.balance) * 100) / 100 : null;
    if (owed !== null && owed <= 0.005) {
      // Bill already cleared. If we can SEE the payment that cleared it
      // this cycle, acknowledge the win instead of going silent — paying
      // early should feel better than paying late, not invisible.
      if (inp.transactions && cardPaymentThisCycle(a, inp.transactions, inp.today) > 0.005) {
        rows.push({
          id: `card-cleared-${a.id}`,
          kind: 'card',
          label: a.name,
          sub: { kind: 'cleared', daysEarly: d },
          amount: null,
          currency: a.currency,
          daysUntil: d,
          href: `/account/${a.id}`,
          direction: 'pay',
        });
      }
      continue;
    }
    // Owed > 0: show THIS cycle's statement (purchases + this cycle's
    // instalment), not the entire revolving balance — a card financing a
    // cash advance over months isn't "9,978 going out this week". Falls back
    // to full owed when transaction data isn't available.
    let dueAmount = owed;
    if (inp.transactions) {
      const advanceLoans = inp.loans.filter(
        (l) => l.status === 'active' && inp.cardFundedLoanIds?.get(l.id) === a.id,
      );
      const statement = buildCardStatement({
        card: a,
        advanceLoans,
        schedules: inp.schedules,
        today: inp.today,
        // Spend after the statement closed is next bill's, not this week's.
        transactions: inp.transactions,
      });
      // Only a limited card has a computable statement. A no-limit card's
      // statement is 0 because the amount is UNKNOWABLE — keep its date-only
      // row (amount stays null) rather than dropping it.
      if (statement && statement.hasLimit) {
        dueAmount = statement.statementDue;
        // This cycle's statement already covered (but a balance carries) —
        // nothing to flag as due this week.
        if (dueAmount <= 0.005) continue;
      }
    }
    rows.push({
      id: `card-${a.id}`,
      kind: 'card',
      label: a.name,
      sub: { kind: 'none' },
      amount: dueAmount,
      currency: a.currency,
      daysUntil: d,
      href: `/account/${a.id}`,
      direction: 'pay',
    });
  }

  return rows.sort(
    (a, b) => a.daysUntil - b.daysUntil || (b.amount ?? 0) - (a.amount ?? 0),
  );
}

/** Per-currency totals for the header line ("Rs 18,500 going out"). */
export function thisWeekTotals(rows: ThisWeekRow[]): Array<{ currency: string; out: number; incoming: number }> {
  const byCurrency = new Map<string, { out: number; incoming: number }>();
  for (const row of rows) {
    if (row.amount === null) continue;
    const entry = byCurrency.get(row.currency) ?? { out: 0, incoming: 0 };
    if (row.direction === 'pay') entry.out = Math.round((entry.out + row.amount) * 100) / 100;
    else entry.incoming = Math.round((entry.incoming + row.amount) * 100) / 100;
    byCurrency.set(row.currency, entry);
  }
  return [...byCurrency.entries()]
    .map(([currency, v]) => ({ currency, ...v }))
    .sort((a, b) => b.out - a.out);
}
