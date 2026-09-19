// "Mera Hisaab" — the net-position number that includes PEOPLE, not just
// accounts. Monarch's most-loved feature is a single net-worth line; Hisaab
// can compute one Monarch structurally cannot: what you hold, plus what
// people owe you, minus what you owe (cards and people). Loans-to-people as
// first-class balance-sheet items is THE differentiator, made visible daily.
// Pure + tested; snapshots persist in the caller.
import type { Account, Loan } from '../db';

export interface MeraHisaabTotals {
  currency: string;
  /** Accounts' contribution — cards enter as balance − limit (i.e. −owed). */
  accountsNet: number;
  /** Active given loans still outstanding: "log aap ko denge". */
  receivable: number;
  /** Active taken loans still outstanding: "aap ne dene hain". Card-funded
   *  cash advances are EXCLUDED when a limited card already carries that
   *  debt in accountsNet — the same debt never counts twice. */
  payable: number;
  net: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export interface MeraHisaabInputs {
  accounts: Account[];
  loans: Loan[];
  /** loanId → funding card accountId (from the loan_taken transaction). */
  cardFundedLoanIds?: Map<string, string>;
}

/** A cash advance whose funding card still exists is the CARD's debt, not a
 *  person's: the card's used amount already carries it (used = purchases +
 *  what's left on its advances — via the −owed limit math, or via the balance
 *  the advance drove down on a card with no limit), and its instalments are
 *  lines on the card's statement. Counting the loan too would double the
 *  debt. Only a deleted funding card leaves the loan as the sole record.
 *
 *  The one rule behind every "you owe people" surface — Where I Stand, the
 *  Home To-pay card, the Contacts tile's unsettled count — so they cannot
 *  disagree. `cardFundedLoanIds` is loanId → funding card id, derived from
 *  the loan_taken transaction's sourceAccountId (loans carry no card link). */
export function isCardHeldAdvance(
  loanId: string,
  cardFundedLoanIds: ReadonlyMap<string, string> | undefined,
  accountIds: ReadonlySet<string>,
): boolean {
  const fundingCardId = cardFundedLoanIds?.get(loanId);
  return fundingCardId !== undefined && accountIds.has(fundingCardId);
}

export function computeMeraHisaab(inp: MeraHisaabInputs): MeraHisaabTotals[] {
  const byCurrency = new Map<string, MeraHisaabTotals>();
  const entry = (currency: string): MeraHisaabTotals => {
    let e = byCurrency.get(currency);
    if (!e) {
      e = { currency, accountsNet: 0, receivable: 0, payable: 0, net: 0 };
      byCurrency.set(currency, e);
    }
    return e;
  };

  const accountIds = new Set(inp.accounts.map((a) => a.id));
  for (const a of inp.accounts) {
    const e = entry(a.currency);
    if (a.type === 'credit_card') {
      // Same math as the Home dashboard: contribution = balance − limit
      // (−owed). A card with no limit configured contributes its raw
      // balance — consistent with the existing net-worth treatment.
      const limit = parseFloat(a.metadata?.creditLimit || '0');
      e.accountsNet = round2(e.accountsNet + a.balance - limit);
    } else {
      e.accountsNet = round2(e.accountsNet + a.balance);
    }
  }

  for (const loan of inp.loans) {
    if (loan.status !== 'active' || loan.remainingAmount <= 0.005) continue;
    const e = entry(loan.currency);
    if (loan.type === 'given') {
      e.receivable = round2(e.receivable + loan.remainingAmount);
    } else {
      // The card's contribution to accountsNet already carries its advances.
      if (isCardHeldAdvance(loan.id, inp.cardFundedLoanIds, accountIds)) continue;
      e.payable = round2(e.payable + loan.remainingAmount);
    }
  }

  const totals = [...byCurrency.values()];
  for (const e of totals) {
    e.net = round2(e.accountsNet + e.receivable - e.payable);
  }
  // Primary-currency selection happens in the caller; order by activity size.
  return totals.sort((a, b) => Math.abs(b.net) - Math.abs(a.net));
}

// ── Monthly snapshots (trend without a schema) ──────────────────────────────

export interface NetSnapshot {
  monthKey: string; // YYYY-MM
  nets: Record<string, number>; // currency → net
}

export const NET_SNAPSHOTS_KEY = 'hisaab_net_snapshots';
const KEEP_MONTHS = 13;

export function monthKeyOf(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

/** Insert-or-replace this month's snapshot, keeping a rolling window. */
export function upsertSnapshot(
  snapshots: NetSnapshot[],
  monthKey: string,
  totals: MeraHisaabTotals[],
): NetSnapshot[] {
  const nets: Record<string, number> = {};
  for (const t of totals) nets[t.currency] = t.net;
  const next = snapshots.filter((s) => s.monthKey !== monthKey);
  next.push({ monthKey, nets });
  next.sort((a, b) => a.monthKey.localeCompare(b.monthKey));
  return next.slice(-KEEP_MONTHS);
}

/** Last month's net for a currency, or null when no history exists yet. */
export function previousMonthNet(
  snapshots: NetSnapshot[],
  currentMonthKey: string,
  currency: string,
): number | null {
  const prior = snapshots
    .filter((s) => s.monthKey < currentMonthKey && currency in s.nets)
    .sort((a, b) => b.monthKey.localeCompare(a.monthKey));
  return prior.length > 0 ? prior[0].nets[currency] : null;
}
