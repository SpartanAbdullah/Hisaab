import { describe, expect, it } from 'vitest';
import { computeMeraHisaab, isCardHeldAdvance, monthKeyOf, previousMonthNet, upsertSnapshot } from './meraHisaab';
import type { Account, Loan } from '../db';

const account = (over: Partial<Account>): Account => ({
  id: 'a', name: 'Bank', type: 'bank', currency: 'AED', balance: 1000,
  metadata: {}, createdAt: '', ...over,
});

const loan = (over: Partial<Loan>): Loan => ({
  id: 'l', personName: 'Ali', personId: null, type: 'given', totalAmount: 500,
  remainingAmount: 500, currency: 'AED', status: 'active', notes: '', createdAt: '', ...over,
});

describe('computeMeraHisaab', () => {
  it('cards contribute balance minus limit (−owed), never their raw available', () => {
    const totals = computeMeraHisaab({
      accounts: [
        account({ id: 'bank', balance: 10000 }),
        account({ id: 'cc', type: 'credit_card', balance: 15000, metadata: { creditLimit: '16500' } }),
      ],
      loans: [],
    });
    // 10000 + (15000 − 16500) = 8500
    expect(totals[0]).toMatchObject({ currency: 'AED', accountsNet: 8500, net: 8500 });
  });

  it('people are on the balance sheet: receivables add, payables subtract', () => {
    const totals = computeMeraHisaab({
      accounts: [account({ balance: 1000 })],
      loans: [
        loan({ id: 'g', type: 'given', remainingAmount: 700 }),
        loan({ id: 't', type: 'taken', remainingAmount: 200 }),
        loan({ id: 'settled', type: 'taken', remainingAmount: 0, status: 'settled' }),
      ],
    });
    expect(totals[0]).toMatchObject({ receivable: 700, payable: 200, net: 1500 });
  });

  it('card-funded cash advances are NOT double-counted as payables when the limited card carries them', () => {
    const totals = computeMeraHisaab({
      accounts: [account({ id: 'cc', type: 'credit_card', balance: 15000, metadata: { creditLimit: '16500' } })],
      loans: [loan({ id: 'ca', type: 'taken', remainingAmount: 1500 })],
      cardFundedLoanIds: new Map([['ca', 'cc']]),
    });
    // The card already contributes −1500; the loan must not subtract again.
    expect(totals[0]).toMatchObject({ payable: 0, net: -1500 });
  });

  it('a 0-limit funding card still carries the debt via its driven-down balance — no double count', () => {
    // The advance decremented the card's balance by 1500; that negative
    // balance IS the debt in accountsNet. Counting the loan again would
    // make the net −3000 for a −1500 reality.
    const totals = computeMeraHisaab({
      accounts: [account({ id: 'cc', type: 'credit_card', balance: -1500, metadata: {} })],
      loans: [loan({ id: 'ca', type: 'taken', remainingAmount: 1500 })],
      cardFundedLoanIds: new Map([['ca', 'cc']]),
    });
    expect(totals[0]).toMatchObject({ accountsNet: -1500, payable: 0, net: -1500 });
  });

  it('keeps the payable when the funding card was DELETED (loan is the only record left)', () => {
    const totals = computeMeraHisaab({
      accounts: [],
      loans: [loan({ id: 'ca', type: 'taken', remainingAmount: 1500 })],
      cardFundedLoanIds: new Map([['ca', 'gone-card']]),
    });
    expect(totals[0]).toMatchObject({ payable: 1500, net: -1500 });
  });

  it('splits by currency', () => {
    const totals = computeMeraHisaab({
      accounts: [account({ id: 'aed', balance: 100 }), account({ id: 'pkr', currency: 'PKR', balance: 90000 })],
      loans: [],
    });
    expect(totals.map((t) => t.currency)).toEqual(['PKR', 'AED']);
  });
});

describe('isCardHeldAdvance — the card, not a person, holds the debt', () => {
  const funded = new Map([['ca', 'card']]);
  it('is true for a cash advance whose funding card still exists', () => {
    expect(isCardHeldAdvance('ca', funded, new Set(['card', 'bank']))).toBe(true);
  });
  it('is false for a loan no card funded — a real person owes or is owed', () => {
    expect(isCardHeldAdvance('ali', funded, new Set(['card']))).toBe(false);
  });
  it('is false once the funding card is deleted — the loan is the only record left', () => {
    expect(isCardHeldAdvance('ca', funded, new Set(['bank']))).toBe(false);
  });
  it('is false with no funding map (splits-only mode has no cards)', () => {
    expect(isCardHeldAdvance('ca', undefined, new Set(['card']))).toBe(false);
  });
});

describe('snapshots', () => {
  it('upserts this month and reads last month back', () => {
    let snaps = upsertSnapshot([], '2026-06', [{ currency: 'AED', accountsNet: 0, receivable: 0, payable: 0, net: 8000 }]);
    snaps = upsertSnapshot(snaps, '2026-07', [{ currency: 'AED', accountsNet: 0, receivable: 0, payable: 0, net: 8500 }]);
    // Re-capturing the same month replaces, not duplicates.
    snaps = upsertSnapshot(snaps, '2026-07', [{ currency: 'AED', accountsNet: 0, receivable: 0, payable: 0, net: 9000 }]);
    expect(snaps).toHaveLength(2);
    expect(previousMonthNet(snaps, '2026-07', 'AED')).toBe(8000);
    expect(previousMonthNet(snaps, '2026-06', 'AED')).toBeNull();
  });

  it('monthKeyOf formats local months', () => {
    expect(monthKeyOf(new Date('2026-07-23T10:00:00'))).toBe('2026-07');
  });
});
