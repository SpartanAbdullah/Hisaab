// "Hisaab check" — the weekly 5-minute review ritual's math. Monarch's
// stickiest pattern is a bounded review ceremony with a visible
// days-since-last counter; Hisaab's version walks money-in/out, people
// deltas, the upcoming week, and ends with ONE suggested action that
// exercises the WhatsApp-reminder differentiator. Pure + tested; the
// swipe UI stays in the component.
import type { Loan, Transaction } from '../db';

export const CHECK_STAMP_KEY = 'hisaab_check_last';

export interface CheckStamp {
  dateIso: string; // YYYY-MM-DD
  receivable: number;
  payable: number;
  currency: string;
}

/** Day of the last completed Hisaab check, or null (never / unreadable).
 *  The evening planner uses it to swap in the weekly check nudge. */
export function readCheckStampDay(): string | null {
  try {
    const raw = localStorage.getItem(CHECK_STAMP_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<CheckStamp>;
    return typeof parsed?.dateIso === 'string' ? parsed.dateIso : null;
  } catch {
    return null;
  }
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Real money in/out over the last 7 days, one currency. Internal moves
 *  (transfers, adjustments, goal contributions) are excluded — the ritual
 *  reads FLOW, not shuffling. Loans count by their CASH leg: lending money
 *  out is real out, borrowed cash landing in a wallet is real in — the same
 *  lifecycle whose repayments are already counted below. Ledger-only rows
 *  (no account leg — money moved outside the app, or a write-off) carry no
 *  flow. */
export function weekFlow(
  transactions: Transaction[],
  currency: string,
  today: Date,
): { moneyIn: number; moneyOut: number } {
  const cutoff = today.getTime() - 7 * DAY_MS;
  let moneyIn = 0;
  let moneyOut = 0;
  for (const txn of transactions) {
    if (txn.currency !== currency) continue;
    const at = new Date(txn.createdAt).getTime();
    if (!Number.isFinite(at) || at < cutoff || at > today.getTime() + DAY_MS) continue;
    if (txn.type === 'income') moneyIn = round2(moneyIn + txn.amount);
    else if (txn.type === 'expense') moneyOut = round2(moneyOut + txn.amount);
    else if (txn.type === 'repayment') {
      // Direction by which leg carries the user's money: destination-only =
      // received back; source set = paid out.
      if (txn.sourceAccountId) moneyOut = round2(moneyOut + txn.amount);
      else if (txn.destinationAccountId) moneyIn = round2(moneyIn + txn.amount);
    } else if (txn.type === 'loan_given') {
      if (txn.sourceAccountId) moneyOut = round2(moneyOut + txn.amount);
    } else if (txn.type === 'loan_taken') {
      if (txn.destinationAccountId) moneyIn = round2(moneyIn + txn.amount);
    }
  }
  return { moneyIn, moneyOut };
}

export function daysSince(dateIso: string | null, today: Date): number | null {
  if (!dateIso) return null;
  const then = new Date(`${dateIso}T00:00:00`).getTime();
  if (!Number.isFinite(then)) return null;
  return Math.max(0, Math.floor((today.getTime() - then) / DAY_MS));
}

/** Receivable/payable deltas since the last check (null with no history). */
export function peopleDelta(
  current: { receivable: number; payable: number },
  stamp: CheckStamp | null,
  currency: string,
): { receivable: number; payable: number } | null {
  if (!stamp || stamp.currency !== currency) return null;
  return {
    receivable: round2(current.receivable - stamp.receivable),
    payable: round2(current.payable - stamp.payable),
  };
}

/** Only nag-worthy after a couple of weeks — a fresh loan isn't an "action". */
const NAG_AFTER_DAYS = 14;

export interface SuggestedAction {
  /** The app-wide person key: personId ?? lowercased trimmed name. */
  personKey: string;
  /** The contact behind the loans, when they point at one (phone lookup,
   *  "add their number"). Null for a name-only person. */
  personId: string | null;
  personName: string;
  /** What this person owes you IN TOTAL in this currency — the sum of every
   *  active given loan, never just one of them. */
  remaining: number;
  currency: string;
  /** How many active loans make up `remaining`. */
  loanCount: number;
  /** When the oldest of those loans was opened: how long they have owed you. */
  sinceIso: string;
  daysOpen: number;
}

interface PersonBalance {
  personKey: string;
  personId: string | null;
  personName: string;
  currency: string;
  remaining: number;
  loanCount: number;
  /** Oldest open loan's timestamp (ms); Infinity when no loan has a date. */
  oldestAt: number;
  oldestIso: string;
  /** Newest loan's timestamp — its name spelling is the one shown. */
  newestAt: number;
}

/**
 * The ONE action: remind the person who has owed you the longest — for
 * EVERYTHING they owe you, not one loan of it.
 *
 * It used to pick the single oldest LOAN, so someone owing 4,000+ across
 * several loans was suggested for the 5 AED of their oldest one (founder
 * report 2026-09-19). Now it works per person, the LoansPage grouping rule:
 * key = direction × currency × (personId ?? lowercased trimmed name). A person
 * can hold both directions and several currencies at once, and none of those
 * are ever merged — each (person, currency) is its own candidate.
 *
 * Who goes first: LONGEST-WAITING — the person whose oldest still-open loan
 * is oldest — because a debt that has sat untouched is the one a nudge is
 * for; the biggest total breaks a tie. Eligible only once that oldest loan is
 * NAG_AFTER_DAYS old.
 *
 * Receivables only: this is the "chase what you're owed" step. If payables
 * are ever added here, a card cash advance is the card's debt, never a
 * person's (isCardHeldAdvance in src/lib/meraHisaab.ts) — it must not appear.
 */
export function suggestAction(loans: Loan[], today: Date): SuggestedAction | null {
  const byPerson = new Map<string, PersonBalance>();
  for (const loan of loans) {
    if (loan.status !== 'active' || loan.type !== 'given' || loan.remainingAmount <= 0.005) continue;
    if (loan.deletedAt) continue;
    const personKey = loan.personId ?? loan.personName.trim().toLowerCase();
    // Direction is fixed to 'given' by the filter above; the key still names
    // it so widening the filter can never fold a payable into a receivable.
    const key = `${loan.type}:${loan.currency}:${personKey}`;
    const at = new Date(loan.createdAt).getTime();
    const bucket = byPerson.get(key) ?? {
      personKey,
      personId: loan.personId ?? null,
      personName: loan.personName.trim(),
      currency: loan.currency,
      remaining: 0,
      loanCount: 0,
      oldestAt: Number.POSITIVE_INFINITY,
      oldestIso: '',
      newestAt: Number.NEGATIVE_INFINITY,
    };
    bucket.remaining = round2(bucket.remaining + loan.remainingAmount);
    bucket.loanCount += 1;
    if (Number.isFinite(at) && at < bucket.oldestAt) {
      bucket.oldestAt = at;
      bucket.oldestIso = loan.createdAt.slice(0, 10);
    }
    if (Number.isFinite(at) && at > bucket.newestAt) {
      bucket.newestAt = at;
      bucket.personName = loan.personName.trim();
    }
    byPerson.set(key, bucket);
  }

  const daysOpenOf = (b: PersonBalance) =>
    Math.max(0, Math.floor((today.getTime() - b.oldestAt) / DAY_MS));

  const pick = [...byPerson.values()]
    .filter((b) => Number.isFinite(b.oldestAt) && daysOpenOf(b) >= NAG_AFTER_DAYS)
    .sort(
      (a, b) =>
        a.oldestAt - b.oldestAt ||
        b.remaining - a.remaining ||
        a.personKey.localeCompare(b.personKey) ||
        a.currency.localeCompare(b.currency),
    )[0];
  if (!pick) return null;

  return {
    personKey: pick.personKey,
    personId: pick.personId,
    personName: pick.personName,
    remaining: pick.remaining,
    currency: pick.currency,
    loanCount: pick.loanCount,
    sinceIso: pick.oldestIso,
    daysOpen: daysOpenOf(pick),
  };
}
