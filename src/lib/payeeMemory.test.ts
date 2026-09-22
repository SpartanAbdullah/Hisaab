import { describe, expect, it } from 'vitest';
import { buildPayeeProfiles, matchPayee, mismatchedTxnIds, normalizePayee } from './payeeMemory';
import { buildInternalNote } from './internalNotes';
import type { Transaction } from '../db';

const tx = (over: Partial<Transaction>): Transaction => ({
  id: Math.random().toString(36).slice(2),
  type: 'expense',
  amount: 100,
  currency: 'AED',
  sourceAccountId: 'bank',
  destinationAccountId: null,
  relatedPerson: null,
  personId: null,
  relatedLoanId: null,
  relatedGoalId: null,
  conversionRate: null,
  category: 'General',
  notes: 'Careem',
  createdAt: '2026-07-01T10:00:00Z',
  ...over,
});

describe('normalizePayee', () => {
  it('lowercases, trims and collapses whitespace', () => {
    expect(normalizePayee('  K-Electric   Bill ')).toBe('k-electric bill');
  });
});

describe('buildPayeeProfiles + matchPayee', () => {
  it('learns category, account and typical amount after two uses, matching case-insensitively', () => {
    const profiles = buildPayeeProfiles([
      tx({ notes: 'Careem', category: 'Transport', amount: 35, createdAt: '2026-07-01T10:00:00Z' }),
      tx({ notes: 'careem ', category: 'Transport', amount: 55, sourceAccountId: 'wallet', createdAt: '2026-07-10T10:00:00Z' }),
    ]);
    const match = matchPayee(profiles, 'CAREEM');
    expect(match).toMatchObject({ category: 'Transport', accountId: 'wallet', typicalAmount: 45, lastAmount: 55, count: 2 });
  });

  it('one use is a coincidence, not a habit — no profile', () => {
    const profiles = buildPayeeProfiles([tx({ notes: 'Careem' })]);
    expect(matchPayee(profiles, 'Careem')).toBeNull();
  });

  it('most frequent category wins; ties break toward the most recent use', () => {
    const profiles = buildPayeeProfiles([
      tx({ notes: 'Daraz', category: 'Shopping', createdAt: '2026-06-01T00:00:00Z' }),
      tx({ notes: 'Daraz', category: 'Gifts', createdAt: '2026-07-01T00:00:00Z' }),
      tx({ notes: 'Daraz', category: 'Shopping', createdAt: '2026-05-01T00:00:00Z' }),
    ]);
    expect(matchPayee(profiles, 'daraz')?.category).toBe('Shopping');
    const tied = buildPayeeProfiles([
      tx({ notes: 'Daraz', category: 'Shopping', createdAt: '2026-06-01T00:00:00Z' }),
      tx({ notes: 'Daraz', category: 'Gifts', createdAt: '2026-07-01T00:00:00Z' }),
    ]);
    expect(matchPayee(tied, 'daraz')?.category).toBe('Gifts');
  });

  it('excludes group-linked mirrors and non-expenses', () => {
    const profiles = buildPayeeProfiles([
      tx({ notes: buildInternalNote('Careem', { groupExpenseId: 'g1' }) }),
      tx({ notes: buildInternalNote('Careem', { groupExpenseId: 'g2' }) }),
      tx({ type: 'income', notes: 'Careem' }),
    ]);
    expect(matchPayee(profiles, 'Careem')).toBeNull();
  });
});

describe('mismatchedTxnIds', () => {
  it('finds past personal entries of the payee filed under another category', () => {
    const a = tx({ id: 'a', notes: 'Careem', category: 'General' });
    const b = tx({ id: 'b', notes: 'careem', category: 'Transport' });
    const c = tx({ id: 'c', notes: buildInternalNote('Careem', { groupExpenseId: 'g1' }), category: 'General' });
    expect(mismatchedTxnIds([a, b, c], 'careem', 'Transport')).toEqual(['a']);
  });
});
