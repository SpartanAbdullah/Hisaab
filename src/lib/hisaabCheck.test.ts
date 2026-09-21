import { describe, expect, it } from 'vitest';
import { daysSince, peopleDelta, suggestAction, weekFlow } from './hisaabCheck';
import type { Loan, Transaction } from '../db';

const TODAY = new Date('2026-07-23T12:00:00');

const txn = (over: Partial<Transaction>): Transaction => ({
  id: Math.random().toString(36).slice(2), type: 'expense', amount: 100, currency: 'AED',
  sourceAccountId: 'a', destinationAccountId: null, relatedPerson: null, personId: null,
  relatedLoanId: null, relatedGoalId: null, conversionRate: null, category: '',
  notes: '', createdAt: '2026-07-20T10:00:00', ...over,
});

const loan = (over: Partial<Loan>): Loan => ({
  id: 'l', personName: 'Ali', personId: null, type: 'given', totalAmount: 1000,
  remainingAmount: 800, currency: 'AED', status: 'active', notes: '',
  createdAt: '2026-06-01T00:00:00', ...over,
});

describe('weekFlow', () => {
  it('sums real in/out, treats repayments and loans by their money leg, ignores shuffling', () => {
    const { moneyIn, moneyOut } = weekFlow([
      txn({ type: 'income', amount: 5000, sourceAccountId: null, destinationAccountId: 'a' }),
      txn({ type: 'expense', amount: 1200 }),
      txn({ type: 'repayment', amount: 300, sourceAccountId: null, destinationAccountId: 'a' }),
      txn({ type: 'repayment', amount: 150, sourceAccountId: 'a', destinationAccountId: null }),
      // Lending cash out / borrowed cash landing in are REAL flow…
      txn({ type: 'loan_given', amount: 2000, sourceAccountId: 'a', destinationAccountId: null }),
      txn({ type: 'loan_taken', amount: 700, sourceAccountId: null, destinationAccountId: 'a' }),
      // …but ledger-only loan rows (no account leg) are not.
      txn({ type: 'loan_given', amount: 9999, sourceAccountId: null, destinationAccountId: null }),
      txn({ type: 'transfer', amount: 9999, destinationAccountId: 'b' }),
      txn({ type: 'adjustment', amount: 9999 }),
      txn({ type: 'expense', amount: 9999, createdAt: '2026-07-10T10:00:00' }), // outside window
      txn({ type: 'expense', amount: 9999, currency: 'PKR' }),
    ], 'AED', TODAY);
    expect(moneyIn).toBe(6000);
    expect(moneyOut).toBe(3350);
  });
});

describe('daysSince + peopleDelta', () => {
  it('computes elapsed days and deltas against the stamp', () => {
    expect(daysSince('2026-07-16', TODAY)).toBe(7);
    expect(daysSince(null, TODAY)).toBeNull();
    expect(
      peopleDelta({ receivable: 900, payable: 200 }, { dateIso: '2026-07-16', receivable: 1000, payable: 350, currency: 'AED' }, 'AED'),
    ).toEqual({ receivable: -100, payable: -150 });
    expect(peopleDelta({ receivable: 1, payable: 1 }, null, 'AED')).toBeNull();
  });
});

describe('suggestAction', () => {
  it('picks the person who has owed longest, only after 14 days', () => {
    const action = suggestAction([
      loan({ id: 'new', createdAt: '2026-07-20T00:00:00' }),
      loan({ id: 'old', createdAt: '2026-05-01T00:00:00', personName: 'Maryam', remainingAmount: 450 }),
      loan({ id: 'taken', type: 'taken', createdAt: '2026-01-01T00:00:00' }),
      loan({ id: 'settled', status: 'settled', createdAt: '2026-01-01T00:00:00' }),
    ], TODAY);
    expect(action).toMatchObject({ personName: 'Maryam', remaining: 450, loanCount: 1, sinceIso: '2026-05-01' });
    expect(action!.daysOpen).toBeGreaterThan(14);
  });

  // Founder report 2026-09-19: Ghulam owed 4,000+ but the check said "remind
  // him for 5 AED" — the amount of his oldest loan alone.
  it('reminds for the person\'s TOTAL, not their oldest loan', () => {
    const action = suggestAction([
      loan({ id: 'g1', personId: 'p-ghulam', personName: 'Ghulam', remainingAmount: 5, totalAmount: 5, createdAt: '2026-05-10T00:00:00' }),
      loan({ id: 'g2', personId: 'p-ghulam', personName: 'Ghulam', remainingAmount: 3500, totalAmount: 4000, createdAt: '2026-07-18T00:00:00' }),
      loan({ id: 'g3', personId: 'p-ghulam', personName: 'Ghulam', remainingAmount: 600, totalAmount: 600, createdAt: '2026-06-20T00:00:00' }),
      // His fully repaid / settled history is not owed any more.
      loan({ id: 'g4', personId: 'p-ghulam', personName: 'Ghulam', remainingAmount: 0, status: 'settled', createdAt: '2026-01-01T00:00:00' }),
      loan({ id: 'b1', personName: 'Bilal', remainingAmount: 9000, createdAt: '2026-07-01T00:00:00' }),
    ], TODAY);
    expect(action).toMatchObject({
      personId: 'p-ghulam',
      personName: 'Ghulam',
      remaining: 4105,
      currency: 'AED',
      loanCount: 3,
      // "How long" comes from the oldest loan still open.
      sinceIso: '2026-05-10',
    });
    expect(action!.remaining).not.toBe(5);
    expect(action!.daysOpen).toBe(74);
  });

  it('keys people by personId, else by trimmed lowercased name — never across the two', () => {
    const byName = suggestAction([
      loan({ id: 'a', personName: 'Ghulam ', remainingAmount: 100, createdAt: '2026-05-01T00:00:00' }),
      loan({ id: 'b', personName: 'ghulam', remainingAmount: 250, createdAt: '2026-06-01T00:00:00' }),
    ], TODAY);
    expect(byName).toMatchObject({ personKey: 'ghulam', personId: null, remaining: 350, loanCount: 2 });
    // The newest loan's spelling is the one shown.
    expect(byName!.personName).toBe('ghulam');

    // A contact "Ghulam" and a hand-typed "Ghulam" are different people until
    // the user links them — their money is not added together.
    const split = suggestAction([
      loan({ id: 'c', personId: 'p-ghulam', personName: 'Ghulam', remainingAmount: 100, createdAt: '2026-05-01T00:00:00' }),
      loan({ id: 'd', personName: 'Ghulam', remainingAmount: 900, createdAt: '2026-06-01T00:00:00' }),
    ], TODAY);
    expect(split).toMatchObject({ personId: 'p-ghulam', remaining: 100, loanCount: 1 });
  });

  it('never merges currencies or directions', () => {
    const action = suggestAction([
      loan({ id: 'aed', personId: 'p1', personName: 'Ali', currency: 'AED', remainingAmount: 300, createdAt: '2026-05-01T00:00:00' }),
      loan({ id: 'pkr', personId: 'p1', personName: 'Ali', currency: 'PKR', remainingAmount: 50000, createdAt: '2026-06-01T00:00:00' }),
      // What you owe Ali is not netted against what he owes you.
      loan({ id: 'owe', personId: 'p1', personName: 'Ali', type: 'taken', currency: 'AED', remainingAmount: 250, createdAt: '2026-04-01T00:00:00' }),
    ], TODAY);
    expect(action).toMatchObject({ currency: 'AED', remaining: 300, loanCount: 1 });
  });

  it('orders by longest-waiting first, the bigger total breaking a tie', () => {
    const longest = suggestAction([
      loan({ id: 'x', personId: 'p-big', personName: 'Big', remainingAmount: 5000, createdAt: '2026-06-15T00:00:00' }),
      loan({ id: 'y', personId: 'p-old', personName: 'Old', remainingAmount: 40, createdAt: '2026-05-15T00:00:00' }),
    ], TODAY);
    expect(longest!.personName).toBe('Old');

    const tie = suggestAction([
      loan({ id: 'x', personId: 'p-small', personName: 'Small', remainingAmount: 40, createdAt: '2026-05-15T00:00:00' }),
      loan({ id: 'y', personId: 'p-large', personName: 'Large', remainingAmount: 700, createdAt: '2026-05-15T00:00:00' }),
    ], TODAY);
    expect(tie!.personName).toBe('Large');
  });

  it('waits until the person has owed for 14 days, however big the total', () => {
    expect(suggestAction([
      loan({ id: 'fresh1', personId: 'p', remainingAmount: 4000, createdAt: '2026-07-15T00:00:00' }),
      loan({ id: 'fresh2', personId: 'p', remainingAmount: 900, createdAt: '2026-07-20T00:00:00' }),
    ], TODAY)).toBeNull();
  });

  it('returns null when nothing is nag-worthy', () => {
    expect(suggestAction([loan({ createdAt: '2026-07-15T00:00:00' })], TODAY)).toBeNull();
    expect(suggestAction([loan({ remainingAmount: 0.004, createdAt: '2026-01-01T00:00:00' })], TODAY)).toBeNull();
    expect(suggestAction([], TODAY)).toBeNull();
  });
});
