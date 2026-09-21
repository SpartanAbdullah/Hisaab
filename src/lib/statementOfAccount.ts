// Statement of Account (SOA) builder.
//
// Turns a contact's (or a single loan's) loans + repayment ledger into a
// signed, chronological statement that can be rendered to text (for a WhatsApp
// deep link) or to a one-page PDF (see statementPdf.ts).
//
// Sign convention throughout: POSITIVE means "the counterparty owes you"
// (a receivable), NEGATIVE means "you owe the counterparty" (a payable). This
// matches ContactDetailSheet.relationshipBalances, so a statement's closing
// balance lines up with what the app shows on screen.
//
// Data completeness is handled PER LOAN (hybrid), because a contact can mix
// full-tracker loans (every disbursement + repayment is a Transaction row)
// with ledger-only history (older 'splits_only' repayments lived only on
// Loan.remainingAmount, with no rows):
//   - Real transaction rows become real ledger lines.
//   - A loan with no disbursement row gets a synthesised opening line from
//     its totalAmount + createdAt.
//   - Any paid-down amount not covered by repayment rows becomes one
//     synthesised "repayments (summary)" line, so the closing balance always
//     reconciles with the loan's actual remaining — a repayment can never be
//     silently invisible on a statement.
// Settled loans are included (their lines net to zero) so a fully settled
// relationship still shows its history under the celebration hero.
// Synthesised lines are flagged `estimated` so renderers can add an honest note.

import type { Currency, Loan, Transaction } from '../db';
import { isZeroMoney, MONEY_TOLERANCE } from './moneyTolerance';

export type StatementScope = 'contact' | 'loan';

// What a ledger line records, independent of language. Renderers phrase it in
// the app's current language and from the READER's side (the statement is
// sent to the counterparty) via statementText.describeStatementLine —
// `description` below stays the stable English, user-side label for existing
// consumers (KhataLinkPage, tests).
export type StatementLineKind =
  | 'loan_given' // you lent to them — they owe you more
  | 'loan_taken' // you borrowed from them — you owe them more
  | 'repayment_received' // they paid you back
  | 'repayment_paid' // you paid them back
  | 'repayments_received_summary' // paid down on a loan you gave, no rows behind it
  | 'repayments_made_summary' // paid down on a loan you took, no rows behind it
  | 'settled_earlier' // fold: older fully settled loans (`count`)
  | 'settled_recent' // collapse: 4+ loans settled in the last 7 days (`count`)
  | 'settled_in_full'; // one loan settled in the last 7 days

export interface StatementLine {
  date: string; // ISO timestamp of the underlying event
  description: string; // neutral, human-readable label (English, user's side)
  kind: StatementLineKind; // language-free type of the line (see above)
  loanNote?: string; // the parent loan's note, named on a line that has none of its own
  count?: number; // how many loans a fold / collapse line stands for
  note?: string; // optional free-text from the transaction
  delta: number; // signed change (+ increases what they owe you)
  balance: number; // signed running balance AFTER this line
  estimated?: boolean; // synthetic line (ledger-only mode, no real ledger row)
  // Gross two-sided flows for fold/summary lines covering settled loans:
  // equal money was given AND paid back (net zero), and the reader must SEE
  // both sides — a bare zero row would make their payments look erased.
  grossGiven?: number;
  grossRepaid?: number;
}

export interface StatementSection {
  currency: Currency;
  lines: StatementLine[];
  closing: number; // signed net position in this currency
  estimated: boolean; // true when any line is synthetic
}

export interface Statement {
  partyName: string;
  asOf: string; // ISO timestamp the statement was generated for
  scope: StatementScope;
  sections: StatementSection[];
  hasActivity: boolean; // false ⇒ nothing to show (fully settled / no history)
}

const round2 = (n: number): number => Math.round(n * 100) / 100;
const isNonZero = (n: number): boolean => !isZeroMoney(n);

// One event's signed effect on "what they owe you", given the direction of the
// loan the transaction belongs to. Returns null for transaction types that
// don't belong on a loan ledger.
function signedDelta(txn: Transaction, loanType: Loan['type']): number | null {
  switch (txn.type) {
    case 'loan_given':
      return txn.amount; // you lent — they owe you more
    case 'loan_taken':
      return -txn.amount; // you borrowed — you owe them more
    case 'repayment':
      // A repayment moves the balance back toward zero. On a loan you GAVE,
      // money coming back reduces what they owe you (−). On a loan you TOOK,
      // paying it back reduces what you owe them (+).
      return loanType === 'given' ? -txn.amount : txn.amount;
    default:
      return null;
  }
}

function describe(txn: Transaction, loanType: Loan['type']): string {
  switch (txn.type) {
    case 'loan_given':
      return 'Loan given';
    case 'loan_taken':
      return 'Loan taken';
    case 'repayment':
      return loanType === 'given' ? 'Repayment received' : 'Repayment paid';
    default:
      return 'Adjustment';
  }
}

// Only reached for rows signedDelta accepted (loan_given / loan_taken /
// repayment), so the fallback is never hit in practice.
function kindOf(txn: Transaction, loanType: Loan['type']): StatementLineKind {
  if (txn.type === 'loan_given') return 'loan_given';
  if (txn.type === 'loan_taken') return 'loan_taken';
  return loanType === 'given' ? 'repayment_received' : 'repayment_paid';
}

export interface BuildStatementInput {
  partyName: string;
  // Loans already scoped to the contact (or a single loan). Deleted loans
  // should be filtered out by the caller.
  loans: Loan[];
  // Transactions to draw the ledger from. May be the full store list — only
  // rows whose relatedLoanId matches one of `loans` are used.
  transactions: Transaction[];
  asOf: string; // ISO; callers pass new Date().toISOString()
  scope: StatementScope;
}

export function buildStatement(input: BuildStatementInput): Statement {
  const { partyName, loans, transactions, asOf, scope } = input;

  const loanById = new Map<string, Loan>();
  for (const loan of loans) loanById.set(loan.id, loan);

  // Bucket loans by currency so PKR is never quietly summed into AED.
  const currencies: Currency[] = [];
  const loansByCurrency = new Map<Currency, Loan[]>();
  for (const loan of loans) {
    const bucket = loansByCurrency.get(loan.currency);
    if (bucket) {
      bucket.push(loan);
    } else {
      loansByCurrency.set(loan.currency, [loan]);
      currencies.push(loan.currency);
    }
  }
  currencies.sort((a, b) => a.localeCompare(b));

  const sections: StatementSection[] = [];

  for (const currency of currencies) {
    const currencyLoans = loansByCurrency.get(currency) ?? [];
    const loanIds = new Set(currencyLoans.map((l) => l.id));

    const events = transactions
      .filter((t) => t.relatedLoanId && loanIds.has(t.relatedLoanId) && !t.deletedAt)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

    // Collect dated entries per loan (real rows + synthesised gaps), then merge
    // chronologically and compute the running balance across the whole bucket.
    type Entry = Omit<StatementLine, 'balance'>;
    const entries: Entry[] = [];

    // Long histories drown the signal: a contact with dozens of settled loans
    // pushes the OPEN ones (the reason the statement exists) into the
    // brought-forward fold. Every settled loan's entries net to exactly zero
    // by construction, so on a contact statement that still has open loans:
    //   - open loans stay fully itemised (they ARE the statement);
    //   - loans settled in the last 7 days become ONE celebratory line each —
    //     a just-cleared loan is news, its full payment history is not — and
    //     a mass catch-up (4+ recent settles) collapses to a single line;
    //   - older settled loans fold into one zero-effect count line.
    // Single-loan and fully-settled statements keep their complete history.
    const hasOpen = currencyLoans.some((l) => isNonZero(l.remainingAmount));
    const RECENT_SETTLE_MS = 7 * 24 * 3600 * 1000;
    const recentlySettled = (l: Loan) =>
      !!l.updatedAt && Date.parse(asOf) - Date.parse(l.updatedAt) <= RECENT_SETTLE_MS;
    const foldedSettled: Loan[] = [];
    const recentSettled: Loan[] = [];
    const itemisedLoans: Loan[] = [];
    for (const loan of currencyLoans) {
      const isSettledLoan = !isNonZero(loan.remainingAmount);
      if (scope === 'contact' && hasOpen && isSettledLoan) {
        (recentlySettled(loan) ? recentSettled : foldedSettled).push(loan);
      } else {
        itemisedLoans.push(loan);
      }
    }
    const grossOf = (list: Loan[]) => round2(list.reduce((a, l) => a + l.totalAmount, 0));
    if (foldedSettled.length > 0) {
      const earliest = foldedSettled.reduce(
        (a, l) => (a < l.createdAt ? a : l.createdAt),
        foldedSettled[0].createdAt,
      );
      const gross = grossOf(foldedSettled);
      entries.push({
        date: earliest,
        description: `Previously settled loans (${foldedSettled.length}) — nothing pending from these`,
        kind: 'settled_earlier',
        count: foldedSettled.length,
        delta: 0,
        grossGiven: gross,
        grossRepaid: gross,
      });
    }
    if (recentSettled.length > 3) {
      const latest = recentSettled.reduce(
        (a, l) => ((l.updatedAt ?? l.createdAt) > a ? (l.updatedAt ?? l.createdAt) : a),
        recentSettled[0].updatedAt ?? recentSettled[0].createdAt,
      );
      const gross = grossOf(recentSettled);
      entries.push({
        date: latest,
        description: `Recently settled 🎉 — ${recentSettled.length} loans cleared, nothing pending from these`,
        kind: 'settled_recent',
        count: recentSettled.length,
        delta: 0,
        grossGiven: gross,
        grossRepaid: gross,
      });
    } else {
      for (const loan of recentSettled) {
        const loanNote = loan.notes?.trim();
        entries.push({
          date: loan.updatedAt ?? loan.createdAt,
          description: loanNote ? `Settled in full 🎉 — ${loanNote}` : 'Settled in full 🎉',
          kind: 'settled_in_full',
          ...(loanNote ? { loanNote } : {}),
          delta: 0,
          grossGiven: round2(loan.totalAmount),
          grossRepaid: round2(loan.totalAmount),
        });
      }
    }

    for (const loan of itemisedLoans) {
      const loanTxns = events.filter((t) => t.relatedLoanId === loan.id);

      // Opening: a loan created in ledger-only mode has no disbursement row —
      // synthesise one from the loan itself so the story starts at the start.
      const hasOpening = loanTxns.some((t) => t.type === 'loan_given' || t.type === 'loan_taken');
      if (!hasOpening && isNonZero(loan.totalAmount)) {
        entries.push({
          date: loan.createdAt,
          description: loan.type === 'given' ? 'Loan given' : 'Loan taken',
          kind: loan.type === 'given' ? 'loan_given' : 'loan_taken',
          note: loan.notes?.trim() || undefined,
          delta: loan.type === 'given' ? round2(loan.totalAmount) : round2(-loan.totalAmount),
          estimated: true,
        });
      }

      let recordedRepay = 0;
      for (const txn of loanTxns) {
        const delta = signedDelta(txn, loan.type);
        if (delta === null) continue;
        if (txn.type === 'repayment') recordedRepay = round2(recordedRepay + txn.amount);
        // A bare "Repayment received" doesn't tell the reader WHICH debt it
        // reduced — name the loan so partial settlement is legible.
        const base = describe(txn, loan.type);
        const loanNote =
          txn.type === 'repayment' && !txn.notes?.trim() && loan.notes?.trim()
            ? loan.notes.trim()
            : undefined;
        entries.push({
          date: txn.createdAt,
          description: loanNote ? `${base} — ${loanNote}` : base,
          kind: kindOf(txn, loan.type),
          ...(loanNote ? { loanNote } : {}),
          note: txn.notes?.trim() || undefined,
          delta: round2(delta),
        });
      }

      // Any paid-down amount with no repayment rows behind it (ledger-only
      // history, or a mode switch) becomes one honest summary line — without
      // it the statement would overstate what's still owed.
      const paidDown = round2(loan.totalAmount - loan.remainingAmount);
      const unrecorded = round2(paidDown - recordedRepay);
      if (unrecorded > MONEY_TOLERANCE) {
        entries.push({
          date: loan.updatedAt ?? asOf,
          description: loan.type === 'given' ? 'Repayments received (summary)' : 'Repayments made (summary)',
          kind: loan.type === 'given' ? 'repayments_received_summary' : 'repayments_made_summary',
          delta: loan.type === 'given' ? -unrecorded : unrecorded,
          estimated: true,
        });
      }
    }

    entries.sort((a, b) => a.date.localeCompare(b.date));

    const lines: StatementLine[] = [];
    let running = 0;
    for (const entry of entries) {
      running = round2(running + entry.delta);
      lines.push({ ...entry, balance: running });
    }

    if (lines.length === 0) continue; // nothing to show for this currency

    sections.push({
      currency,
      lines,
      closing: round2(running),
      estimated: lines.some((l) => l.estimated),
    });
  }

  return {
    partyName,
    asOf,
    scope,
    sections,
    hasActivity: sections.length > 0,
  };
}

// Keep a statement to one page by folding older lines into a single
// "brought forward" opening balance. Returns the opening line (or null when no
// trimming was needed) plus the visible tail.
export interface TrimmedSection {
  opening: { balance: number; count: number } | null;
  lines: StatementLine[];
}

export function trimSection(section: StatementSection, maxLines: number): TrimmedSection {
  if (section.lines.length <= maxLines) {
    return { opening: null, lines: section.lines };
  }
  const visibleCount = Math.max(1, maxLines - 1); // reserve a row for the b/f line
  const cutIndex = section.lines.length - visibleCount;
  const openingBalance = section.lines[cutIndex - 1]?.balance ?? 0;
  return {
    opening: { balance: round2(openingBalance), count: cutIndex },
    lines: section.lines.slice(cutIndex),
  };
}
