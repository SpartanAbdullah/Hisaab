import { describe, it, expect } from 'vitest';
import { buildStatement, trimSection } from './statementOfAccount';
import type { Loan, Transaction } from '../db';

function loan(partial: Partial<Loan> & Pick<Loan, 'id' | 'type' | 'totalAmount' | 'remainingAmount'>): Loan {
  return {
    personName: 'Ahmed',
    personId: 'p1',
    currency: 'PKR',
    status: 'active',
    notes: '',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...partial,
  } as Loan;
}

function txn(partial: Partial<Transaction> & Pick<Transaction, 'id' | 'type' | 'amount' | 'relatedLoanId' | 'createdAt'>): Transaction {
  return {
    currency: 'PKR',
    sourceAccountId: null,
    destinationAccountId: null,
    relatedPerson: 'Ahmed',
    personId: 'p1',
    relatedGoalId: null,
    conversionRate: null,
    category: '',
    notes: '',
    ...partial,
  } as Transaction;
}

describe('buildStatement', () => {
  it('builds a running-balance ledger for a given loan with repayments', () => {
    const loans = [loan({ id: 'L1', type: 'given', totalAmount: 25000, remainingAmount: 15000 })];
    const transactions = [
      txn({ id: 't1', type: 'loan_given', amount: 25000, relatedLoanId: 'L1', createdAt: '2026-05-12T00:00:00.000Z' }),
      txn({ id: 't2', type: 'repayment', amount: 5000, relatedLoanId: 'L1', createdAt: '2026-05-28T00:00:00.000Z' }),
      txn({ id: 't3', type: 'repayment', amount: 5000, relatedLoanId: 'L1', createdAt: '2026-06-20T00:00:00.000Z' }),
    ];
    const s = buildStatement({ partyName: 'Ahmed', loans, transactions, asOf: '2026-07-02T00:00:00.000Z', scope: 'loan' });
    expect(s.hasActivity).toBe(true);
    expect(s.sections).toHaveLength(1);
    const section = s.sections[0];
    expect(section.currency).toBe('PKR');
    expect(section.lines.map((l) => l.balance)).toEqual([25000, 20000, 15000]);
    expect(section.lines.map((l) => l.delta)).toEqual([25000, -5000, -5000]);
    expect(section.lines.map((l) => l.kind)).toEqual(['loan_given', 'repayment_received', 'repayment_received']);
    expect(section.closing).toBe(15000); // positive ⇒ they owe you
    expect(section.estimated).toBe(false);
  });

  it('tags every line with a language-free kind (renderers phrase it per language)', () => {
    const loans = [loan({ id: 'L1', type: 'taken', totalAmount: 900, remainingAmount: 600 })];
    const transactions = [
      txn({ id: 't1', type: 'loan_taken', amount: 900, relatedLoanId: 'L1', createdAt: '2026-05-12T00:00:00.000Z' }),
      txn({ id: 't2', type: 'repayment', amount: 300, relatedLoanId: 'L1', createdAt: '2026-05-28T00:00:00.000Z' }),
    ];
    const s = buildStatement({ partyName: 'Ahmed', loans, transactions, asOf: '2026-07-02T00:00:00.000Z', scope: 'loan' });
    const lines = s.sections[0].lines;
    expect(lines.map((l) => l.kind)).toEqual(['loan_taken', 'repayment_paid']);
    expect(lines.map((l) => l.description)).toEqual(['Loan taken', 'Repayment paid']); // English labels unchanged
    expect(lines.map((l) => l.delta)).toEqual([-900, 300]);
    expect(s.sections[0].closing).toBe(-600);
  });

  it('nets given (+) against taken (−) within one currency', () => {
    const loans = [
      loan({ id: 'L1', type: 'given', totalAmount: 10000, remainingAmount: 10000 }),
      loan({ id: 'L2', type: 'taken', totalAmount: 4000, remainingAmount: 4000, createdAt: '2026-02-01T00:00:00.000Z' }),
    ];
    const transactions = [
      txn({ id: 't1', type: 'loan_given', amount: 10000, relatedLoanId: 'L1', createdAt: '2026-01-10T00:00:00.000Z' }),
      txn({ id: 't2', type: 'loan_taken', amount: 4000, relatedLoanId: 'L2', createdAt: '2026-02-10T00:00:00.000Z' }),
    ];
    const s = buildStatement({ partyName: 'Ahmed', loans, transactions, asOf: '2026-07-02T00:00:00.000Z', scope: 'contact' });
    expect(s.sections).toHaveLength(1);
    expect(s.sections[0].lines.map((l) => l.balance)).toEqual([10000, 6000]);
    expect(s.sections[0].closing).toBe(6000);
  });

  it('separates currencies into sorted sections', () => {
    const loans = [
      loan({ id: 'L1', type: 'given', totalAmount: 100, remainingAmount: 100, currency: 'PKR' }),
      loan({ id: 'L2', type: 'given', totalAmount: 50, remainingAmount: 50, currency: 'AED' }),
    ];
    const transactions = [
      txn({ id: 't1', type: 'loan_given', amount: 100, relatedLoanId: 'L1', currency: 'PKR', createdAt: '2026-03-01T00:00:00.000Z' }),
      txn({ id: 't2', type: 'loan_given', amount: 50, relatedLoanId: 'L2', currency: 'AED', createdAt: '2026-03-02T00:00:00.000Z' }),
    ];
    const s = buildStatement({ partyName: 'Ahmed', loans, transactions, asOf: '2026-07-02T00:00:00.000Z', scope: 'contact' });
    expect(s.sections.map((sec) => sec.currency)).toEqual(['AED', 'PKR']);
  });

  it('synthesises opening + repayment-summary lines in ledger-only mode (no transactions)', () => {
    const loans = [loan({ id: 'L1', type: 'taken', totalAmount: 8000, remainingAmount: 3000 })];
    const s = buildStatement({ partyName: 'Ahmed', loans, transactions: [], asOf: '2026-07-02T00:00:00.000Z', scope: 'loan' });
    expect(s.sections).toHaveLength(1);
    expect(s.sections[0].estimated).toBe(true);
    expect(s.sections[0].lines.map((l) => l.description)).toEqual(['Loan taken', 'Repayments made (summary)']);
    expect(s.sections[0].lines.map((l) => l.kind)).toEqual(['loan_taken', 'repayments_made_summary']);
    expect(s.sections[0].lines.map((l) => l.delta)).toEqual([-8000, 5000]);
    expect(s.sections[0].closing).toBe(-3000); // negative ⇒ you owe them
  });

  it('a paid-down balance with no repayment rows gets an honest summary line (mode-switch gap)', () => {
    // Loan disbursed under full tracker (row exists), later repaid in
    // ledger-only mode (no rows) — the statement must NOT overstate the debt.
    const loans = [loan({ id: 'L1', type: 'given', totalAmount: 25000, remainingAmount: 10000 })];
    const transactions = [
      txn({ id: 't1', type: 'loan_given', amount: 25000, relatedLoanId: 'L1', createdAt: '2026-05-12T00:00:00.000Z' }),
    ];
    const s = buildStatement({ partyName: 'Ahmed', loans, transactions, asOf: '2026-07-02T00:00:00.000Z', scope: 'loan' });
    const section = s.sections[0];
    expect(section.lines.map((l) => l.description)).toEqual(['Loan given', 'Repayments received (summary)']);
    expect(section.lines.map((l) => l.kind)).toEqual(['loan_given', 'repayments_received_summary']);
    expect(section.lines.map((l) => l.delta)).toEqual([25000, -15000]);
    expect(section.closing).toBe(10000); // matches the loan's actual remaining
    expect(section.estimated).toBe(true);
  });

  it('a ledger-only loan is not dropped when the same currency also has tracked loans (mixed bucket)', () => {
    const loans = [
      loan({ id: 'L1', type: 'given', totalAmount: 10000, remainingAmount: 10000 }),
      loan({ id: 'L2', type: 'given', totalAmount: 4000, remainingAmount: 4000, createdAt: '2026-02-01T00:00:00.000Z' }),
    ];
    // Only L1 has a transaction row; L2 was created in ledger-only mode.
    const transactions = [
      txn({ id: 't1', type: 'loan_given', amount: 10000, relatedLoanId: 'L1', createdAt: '2026-01-10T00:00:00.000Z' }),
    ];
    const s = buildStatement({ partyName: 'Ahmed', loans, transactions, asOf: '2026-07-02T00:00:00.000Z', scope: 'contact' });
    expect(s.sections[0].lines).toHaveLength(2);
    expect(s.sections[0].closing).toBe(14000); // both loans counted
  });

  it('folds older settled loans into one zero-effect line when open loans exist (contact scope)', () => {
    const loans = [
      loan({ id: 'open', type: 'given', totalAmount: 500, remainingAmount: 500 }),
      // Settled long ago (no recent updatedAt) — noise on a pending statement.
      loan({ id: 'old1', type: 'given', totalAmount: 100, remainingAmount: 0, status: 'settled', createdAt: '2025-11-01T00:00:00.000Z' }),
      loan({ id: 'old2', type: 'given', totalAmount: 200, remainingAmount: 0, status: 'settled', createdAt: '2025-12-01T00:00:00.000Z' }),
    ];
    const transactions = [
      txn({ id: 't1', type: 'loan_given', amount: 500, relatedLoanId: 'open', createdAt: '2026-05-01T00:00:00.000Z' }),
      txn({ id: 't2', type: 'loan_given', amount: 100, relatedLoanId: 'old1', createdAt: '2025-11-01T00:00:00.000Z' }),
      txn({ id: 't3', type: 'repayment', amount: 100, relatedLoanId: 'old1', createdAt: '2025-11-20T00:00:00.000Z' }),
    ];
    const s = buildStatement({ partyName: 'Ahmed', loans, transactions, asOf: '2026-07-02T00:00:00.000Z', scope: 'contact' });
    const section = s.sections[0];
    expect(section.lines[0].description).toBe('Previously settled loans (2) — nothing pending from these');
    expect(section.lines[0].kind).toBe('settled_earlier');
    expect(section.lines[0].count).toBe(2);
    expect(section.lines[0].delta).toBe(0);
    // Gross flows visible in both columns — the reader's payments never vanish.
    expect(section.lines[0].grossGiven).toBe(300);
    expect(section.lines[0].grossRepaid).toBe(300);
    // Only the fold line + the open loan's disbursement remain visible.
    expect(section.lines).toHaveLength(2);
    expect(section.lines[1].description).toBe('Loan given');
    expect(section.closing).toBe(500);
  });

  it('shows a loan settled within the last 7 days as ONE celebratory line (news, not noise)', () => {
    const loans = [
      loan({ id: 'open', type: 'given', totalAmount: 500, remainingAmount: 500 }),
      loan({ id: 'fresh', type: 'given', totalAmount: 100, remainingAmount: 0, status: 'settled', notes: 'April mess', updatedAt: '2026-07-01T00:00:00.000Z' }),
    ];
    const transactions = [
      txn({ id: 't1', type: 'loan_given', amount: 500, relatedLoanId: 'open', createdAt: '2026-05-01T00:00:00.000Z' }),
      txn({ id: 't2', type: 'loan_given', amount: 100, relatedLoanId: 'fresh', createdAt: '2026-06-01T00:00:00.000Z' }),
      txn({ id: 't3', type: 'repayment', amount: 100, relatedLoanId: 'fresh', createdAt: '2026-07-01T00:00:00.000Z' }),
    ];
    const s = buildStatement({ partyName: 'Ahmed', loans, transactions, asOf: '2026-07-02T00:00:00.000Z', scope: 'contact' });
    const descriptions = s.sections[0].lines.map((l) => l.description);
    expect(descriptions).toContain('Settled in full 🎉 — April mess');
    expect(descriptions.filter((d) => d === 'Repayment received')).toHaveLength(0); // its history stays folded
    const celebration = s.sections[0].lines.find((l) => l.description.startsWith('Settled in full'))!;
    expect(celebration.kind).toBe('settled_in_full');
    expect(celebration.loanNote).toBe('April mess');
    expect(celebration.grossGiven).toBe(100);
    expect(celebration.grossRepaid).toBe(100);
    expect(s.sections[0].lines).toHaveLength(2); // celebration line + open loan
    expect(s.sections[0].closing).toBe(500);
  });

  it('names the loan on repayment lines that carry no note of their own', () => {
    const loans = [
      loan({ id: 'L1', type: 'given', totalAmount: 500, remainingAmount: 400, notes: 'April mess' }),
    ];
    const transactions = [
      txn({ id: 't1', type: 'loan_given', amount: 500, relatedLoanId: 'L1', createdAt: '2026-05-01T00:00:00.000Z' }),
      txn({ id: 't2', type: 'repayment', amount: 60, relatedLoanId: 'L1', createdAt: '2026-06-01T00:00:00.000Z' }),
      txn({ id: 't3', type: 'repayment', amount: 40, relatedLoanId: 'L1', createdAt: '2026-06-10T00:00:00.000Z', notes: 'via Mashreq CDM' }),
    ];
    const s = buildStatement({ partyName: 'Ahmed', loans, transactions, asOf: '2026-07-02T00:00:00.000Z', scope: 'loan' });
    const descriptions = s.sections[0].lines.map((l) => l.description);
    expect(descriptions).toContain('Repayment received — April mess'); // note-less row names its loan
    expect(descriptions).toContain('Repayment received'); // noted row keeps its own note (rendered separately)
    const [, noteless, noted] = s.sections[0].lines;
    expect(noteless.kind).toBe('repayment_received');
    expect(noteless.loanNote).toBe('April mess'); // renderers append it in either language
    expect(noted.loanNote).toBeUndefined();
    expect(noted.note).toBe('via Mashreq CDM');
  });

  it('collapses a mass catch-up (4+ recent settles) into a single celebratory line', () => {
    const fresh = (id: string) =>
      loan({ id, type: 'given', totalAmount: 50, remainingAmount: 0, status: 'settled', updatedAt: '2026-07-01T00:00:00.000Z' });
    const loans = [
      loan({ id: 'open', type: 'given', totalAmount: 500, remainingAmount: 500 }),
      fresh('f1'), fresh('f2'), fresh('f3'), fresh('f4'), fresh('f5'),
    ];
    const transactions = [
      txn({ id: 't1', type: 'loan_given', amount: 500, relatedLoanId: 'open', createdAt: '2026-05-01T00:00:00.000Z' }),
    ];
    const s = buildStatement({ partyName: 'Ahmed', loans, transactions, asOf: '2026-07-02T00:00:00.000Z', scope: 'contact' });
    const descriptions = s.sections[0].lines.map((l) => l.description);
    expect(descriptions).toContain('Recently settled 🎉 — 5 loans cleared, nothing pending from these');
    const collapse = s.sections[0].lines.find((l) => l.description.startsWith('Recently settled'))!;
    expect(collapse.kind).toBe('settled_recent');
    expect(collapse.count).toBe(5);
    expect(collapse.grossGiven).toBe(250); // 5 × 50 — the reader sees what they actually paid
    expect(collapse.grossRepaid).toBe(250);
    expect(s.sections[0].lines).toHaveLength(2); // one collapse line + the open loan
    expect(s.sections[0].closing).toBe(500);
  });

  it('a fully settled contact keeps its complete history (no fold without open loans)', () => {
    const loans = [
      loan({ id: 'a', type: 'given', totalAmount: 100, remainingAmount: 0, status: 'settled', createdAt: '2025-10-01T00:00:00.000Z' }),
    ];
    const transactions = [
      txn({ id: 't1', type: 'loan_given', amount: 100, relatedLoanId: 'a', createdAt: '2025-10-01T00:00:00.000Z' }),
      txn({ id: 't2', type: 'repayment', amount: 100, relatedLoanId: 'a', createdAt: '2025-12-01T00:00:00.000Z' }),
    ];
    const s = buildStatement({ partyName: 'Ahmed', loans, transactions, asOf: '2026-07-02T00:00:00.000Z', scope: 'contact' });
    expect(s.sections[0].lines).toHaveLength(2);
    expect(s.sections[0].closing).toBe(0);
  });

  it('keeps a fully settled loan history so the statement can celebrate over it', () => {
    const loans = [loan({ id: 'L1', type: 'given', totalAmount: 5000, remainingAmount: 0, status: 'settled' })];
    const transactions = [
      txn({ id: 't1', type: 'loan_given', amount: 5000, relatedLoanId: 'L1', createdAt: '2026-05-01T00:00:00.000Z' }),
      txn({ id: 't2', type: 'repayment', amount: 5000, relatedLoanId: 'L1', createdAt: '2026-06-01T00:00:00.000Z' }),
    ];
    const s = buildStatement({ partyName: 'Ahmed', loans, transactions, asOf: '2026-07-02T00:00:00.000Z', scope: 'loan' });
    expect(s.hasActivity).toBe(true); // history still shown
    expect(s.sections[0].lines).toHaveLength(2);
    expect(s.sections[0].closing).toBe(0); // ⇒ renderers show the settled celebration
  });

  it('ignores deleted transactions', () => {
    const loans = [loan({ id: 'L1', type: 'given', totalAmount: 100, remainingAmount: 100 })];
    const transactions = [
      txn({ id: 't1', type: 'loan_given', amount: 100, relatedLoanId: 'L1', createdAt: '2026-03-01T00:00:00.000Z' }),
      txn({ id: 't2', type: 'repayment', amount: 40, relatedLoanId: 'L1', createdAt: '2026-03-05T00:00:00.000Z', deletedAt: '2026-03-06T00:00:00.000Z' }),
    ];
    const s = buildStatement({ partyName: 'Ahmed', loans, transactions, asOf: '2026-07-02T00:00:00.000Z', scope: 'loan' });
    expect(s.sections[0].lines).toHaveLength(1);
    expect(s.sections[0].closing).toBe(100);
  });

  it('reports no activity when there are no loans', () => {
    const s = buildStatement({ partyName: 'Ahmed', loans: [], transactions: [], asOf: '2026-07-02T00:00:00.000Z', scope: 'contact' });
    expect(s.hasActivity).toBe(false);
    expect(s.sections).toHaveLength(0);
  });
});

describe('trimSection', () => {
  it('folds older lines into a brought-forward opening balance', () => {
    const loans = [loan({ id: 'L1', type: 'given', totalAmount: 6, remainingAmount: 6 })];
    const transactions = [
      txn({ id: 'd', type: 'loan_given', amount: 6, relatedLoanId: 'L1', createdAt: '2026-01-01T00:00:00.000Z' }),
      ...Array.from({ length: 5 }, (_, i) =>
        txn({ id: `r${i}`, type: 'repayment', amount: 0, relatedLoanId: 'L1', createdAt: `2026-01-1${i}T00:00:00.000Z` }),
      ),
    ];
    const s = buildStatement({ partyName: 'Ahmed', loans, transactions, asOf: '2026-07-02T00:00:00.000Z', scope: 'loan' });
    const section = s.sections[0];
    expect(section.lines.length).toBe(6);
    const trimmed = trimSection(section, 3);
    expect(trimmed.opening).not.toBeNull();
    expect(trimmed.opening?.count).toBe(4); // 6 lines − 2 visible = 4 folded
    expect(trimmed.lines).toHaveLength(2);
  });

  it('does not trim when within the limit', () => {
    const loans = [loan({ id: 'L1', type: 'given', totalAmount: 5, remainingAmount: 5 })];
    const transactions = [txn({ id: 'd', type: 'loan_given', amount: 5, relatedLoanId: 'L1', createdAt: '2026-01-01T00:00:00.000Z' })];
    const s = buildStatement({ partyName: 'Ahmed', loans, transactions, asOf: '2026-07-02T00:00:00.000Z', scope: 'loan' });
    const trimmed = trimSection(s.sections[0], 10);
    expect(trimmed.opening).toBeNull();
    expect(trimmed.lines).toHaveLength(1);
  });
});
