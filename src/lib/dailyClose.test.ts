import { describe, expect, it } from 'vitest';
import { computeCloseStreak, dayActivity, quietDays, usualItems, type DailyClose } from './dailyClose';
import { buildInternalNote } from './internalNotes';
import type { Transaction } from '../db';

let seq = 0;
const tx = (over: Partial<Transaction>): Transaction => ({
  id: `t${(seq += 1)}`,
  type: 'expense',
  amount: 10,
  currency: 'AED',
  sourceAccountId: 'cash',
  destinationAccountId: null,
  relatedPerson: null,
  personId: null,
  relatedLoanId: null,
  relatedGoalId: null,
  conversionRate: null,
  category: 'Food',
  notes: '',
  createdAt: '2026-09-20T12:00:00Z',
  ...over,
});
const on = (day: string, over: Partial<Transaction> = {}) => tx({ createdAt: `${day}T12:00:00Z`, ...over });
const closed = (day: string, kind: DailyClose['kind'] = 'no_spend'): DailyClose => ({ day, kind });

describe('dayActivity', () => {
  it("reports today's entries newest-first and the close marker", () => {
    const a = on('2026-09-22', { createdAt: '2026-09-22T08:00:00Z' });
    const b = on('2026-09-22', { createdAt: '2026-09-22T18:00:00Z' });
    const r = dayActivity([a, on('2026-09-21'), b], [closed('2026-09-22', 'closed')], '2026-09-22');
    expect(r.loggedToday).toBe(true);
    expect(r.entriesToday.map((t) => t.id)).toEqual([b.id, a.id]);
    expect(r.closedToday).toBe('closed');
  });

  it('bookkeeping rows (adjustment, opening balance) and deleted rows are not logging', () => {
    const r = dayActivity([
      on('2026-09-22', { type: 'adjustment' }),
      on('2026-09-22', { type: 'opening_balance' }),
      on('2026-09-22', { deletedAt: '2026-09-22T13:00:00Z' }),
    ], [], '2026-09-22');
    expect(r.loggedToday).toBe(false);
    expect(r.closedToday).toBeNull();
  });

  it('any real movement counts, not only expenses', () => {
    expect(dayActivity([on('2026-09-22', { type: 'transfer' })], [], '2026-09-22').loggedToday).toBe(true);
  });
});

describe('computeCloseStreak', () => {
  it('counts logged and closed days together', () => {
    const r = computeCloseStreak(
      [on('2026-09-20'), on('2026-09-22')],
      [closed('2026-09-21')],
      '2026-09-22',
    );
    expect(r).toEqual({ streak: 3, activeToday: true, graceUsedRecently: false });
  });

  it('an unfinished today never breaks the run — anchored at yesterday', () => {
    const r = computeCloseStreak([on('2026-09-20'), on('2026-09-21')], [], '2026-09-22');
    expect(r.streak).toBe(2);
    expect(r.activeToday).toBe(false);
  });

  it('one missed day is forgiven and shown as a rest day', () => {
    const r = computeCloseStreak([on('2026-09-18'), on('2026-09-19'), on('2026-09-21'), on('2026-09-22')], [], '2026-09-22');
    expect(r.streak).toBe(4);
    expect(r.graceUsedRecently).toBe(true);
  });

  it('two missed days in a row break it', () => {
    const r = computeCloseStreak([on('2026-09-18'), on('2026-09-19'), on('2026-09-22')], [], '2026-09-22');
    expect(r.streak).toBe(1);
  });

  it('only one grace per rolling week', () => {
    // gaps on the 20th and the 17th — 3 days apart, so the second one ends the run
    const days = ['2026-09-15', '2026-09-16', '2026-09-18', '2026-09-19', '2026-09-21', '2026-09-22'];
    expect(computeCloseStreak(days.map((d) => on(d)), [], '2026-09-22').streak).toBe(4);
  });

  it('graces a week apart are both allowed', () => {
    const days = ['2026-09-06', '2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10', '2026-09-11', '2026-09-12', '2026-09-13',
      '2026-09-15', '2026-09-16', '2026-09-17', '2026-09-18', '2026-09-19', '2026-09-20', '2026-09-22'];
    const r = computeCloseStreak(days.map((d) => on(d)), [], '2026-09-22');
    expect(r.streak).toBe(15);
  });

  it('nothing at all is a zero streak without a grace flag', () => {
    expect(computeCloseStreak([], [], '2026-09-22')).toEqual({ streak: 0, activeToday: false, graceUsedRecently: false });
  });
});

describe('quietDays', () => {
  it('is 0 when today is active, else days since the last active day', () => {
    expect(quietDays([on('2026-09-22')], [], '2026-09-22')).toBe(0);
    expect(quietDays([on('2026-09-18')], [closed('2026-09-19')], '2026-09-22')).toBe(3);
  });
  it('is null for a user with no activity', () => {
    expect(quietDays([], [], '2026-09-22')).toBeNull();
  });
});

describe('usualItems', () => {
  const now = new Date('2026-09-22T20:00:00Z');
  it('ranks repeated payees by recency-weighted use and offers the last amount', () => {
    const items = usualItems([
      on('2026-09-01', { notes: 'Careem', category: 'Transport', amount: 30 }),
      on('2026-09-02', { notes: 'Careem', category: 'Transport', amount: 25 }),
      on('2026-09-20', { notes: 'Lemon Grill', category: 'Food', amount: 37 }),
      on('2026-09-21', { notes: 'lemon grill', category: 'Food', amount: 45 }),
    ], now);
    expect(items[0]).toMatchObject({ label: 'lemon grill', notes: 'lemon grill', category: 'Food', lastAmount: 45, count: 2 });
    expect(items[1]).toMatchObject({ label: 'Careem', lastAmount: 25 });
  });

  it('tops up with habitual categories not already covered; skips one-offs, group mirrors and old rows', () => {
    const items = usualItems([
      on('2026-09-20', { notes: 'Lemon Grill', category: 'Food', amount: 37 }),
      on('2026-09-21', { notes: 'Lemon Grill', category: 'Food', amount: 45 }),
      on('2026-09-19', { notes: 'milk', category: 'Groceries', amount: 4 }),
      on('2026-09-21', { notes: 'bread', category: 'Groceries', amount: 6 }),
      on('2026-09-21', { notes: 'kite', category: 'Toys', amount: 9 }),
      on('2026-09-21', { notes: buildInternalNote('Dinner', { groupExpenseId: 'g1' }), category: 'Dining', amount: 90 }),
      on('2026-07-01', { notes: 'old', category: 'Rent', amount: 900 }),
    ], now);
    expect(items.map((i) => i.key)).toEqual(['payee:lemon grill', 'category:Groceries']);
    expect(items[1]).toMatchObject({ label: 'Groceries', notes: '', lastAmount: 6 });
  });

  it('two charges on the same day are a one-off, not a usual payee', () => {
    const items = usualItems([
      on('2026-09-01', { notes: 'Ajman Freezone', category: 'License', amount: 1630.27 }),
      on('2026-09-01', { notes: 'Ajman Freezone', category: 'License', amount: 100.49 }),
    ], now);
    expect(items).toEqual([]);
  });

  it('respects the limit', () => {
    const rows = ['A', 'B', 'C', 'D'].flatMap((c) => [on('2026-09-20', { category: c }), on('2026-09-21', { category: c })]);
    expect(usualItems(rows, now, 2)).toHaveLength(2);
  });
});
