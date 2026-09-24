import { describe, expect, it } from 'vitest';
import type { Loan } from '../db';
import {
  isLinkedLoan,
  assertLinkedLoanEditAllowed,
  assertLinkedLoanDeleteAllowed,
  isSettlementRepayment,
  linkedPairIdForLoan,
} from './linkedLoanGuards';

function loan(over: Partial<Loan> = {}): Loan {
  return {
    id: 'l1',
    personName: 'Ali',
    personId: 'p1',
    type: 'given',
    totalAmount: 500,
    remainingAmount: 500,
    currency: 'AED',
    status: 'active',
    notes: '',
    createdAt: '2026-06-01T00:00:00Z',
    loanPairId: 'pair-1',
    ...over,
  } as Loan;
}

describe('isLinkedLoan', () => {
  it('is true when a pair id is present', () => {
    expect(isLinkedLoan(loan())).toBe(true);
  });
  it('is false for a local-only loan', () => {
    expect(isLinkedLoan(loan({ loanPairId: null }))).toBe(false);
  });
});

describe('assertLinkedLoanEditAllowed', () => {
  it('blocks a currency change on an active linked loan', () => {
    expect(() => assertLinkedLoanEditAllowed(loan(), { currency: 'PKR' })).toThrow(/linked/i);
  });
  it('blocks a totalAmount change on an active linked loan', () => {
    expect(() => assertLinkedLoanEditAllowed(loan(), { totalAmount: 600 })).toThrow(/linked/i);
  });
  it('allows the same currency (no actual change)', () => {
    expect(() => assertLinkedLoanEditAllowed(loan(), { currency: 'AED' })).not.toThrow();
  });
  it('allows edits on a non-linked loan', () => {
    expect(() => assertLinkedLoanEditAllowed(loan({ loanPairId: null }), { currency: 'PKR' })).not.toThrow();
  });
  it('allows edits once the linked loan is settled (not active)', () => {
    expect(() => assertLinkedLoanEditAllowed(loan({ status: 'settled' }), { currency: 'PKR' })).not.toThrow();
  });
  it('does not block unrelated changes (no currency/amount in the patch)', () => {
    expect(() => assertLinkedLoanEditAllowed(loan(), {})).not.toThrow();
  });
});

describe('assertLinkedLoanDeleteAllowed', () => {
  it('blocks deleting an active linked loan', () => {
    expect(() => assertLinkedLoanDeleteAllowed(loan())).toThrow(/linked/i);
  });
  it('allows deleting a settled linked loan', () => {
    expect(() => assertLinkedLoanDeleteAllowed(loan({ status: 'settled' }))).not.toThrow();
  });
  it('allows deleting a local-only loan', () => {
    expect(() => assertLinkedLoanDeleteAllowed(loan({ loanPairId: null }))).not.toThrow();
  });
});

describe('linkedPairIdForLoan — the pair comes from the request rows', () => {
  const rows = [
    { id: 'pair-1', status: 'accepted', requesterLoanId: 'L1', responderLoanId: 'B1' },
    { id: 'pair-2', status: 'pending', requesterLoanId: 'L2', responderLoanId: null },
    { id: 'pair-3', status: 'rejected', requesterLoanId: 'L3', responderLoanId: 'B3' },
  ];

  it('finds the accepted pair from either side', () => {
    expect(linkedPairIdForLoan('L1', rows)).toBe('pair-1');
    expect(linkedPairIdForLoan('B1', rows)).toBe('pair-1');
  });

  it('a pending or rejected request does not make a loan linked', () => {
    expect(linkedPairIdForLoan('L2', rows)).toBeNull();
    expect(linkedPairIdForLoan('L3', rows)).toBeNull();
    expect(linkedPairIdForLoan('nope', rows)).toBeNull();
  });

  it('THE FIX: fed the derived pair id, the guards fire on an active linked loan', () => {
    const loanPairId = linkedPairIdForLoan('L1', rows);
    expect(() => assertLinkedLoanDeleteAllowed({ loanPairId, status: 'active' })).toThrow();
    expect(() => assertLinkedLoanEditAllowed(
      { loanPairId, status: 'active', currency: 'AED', totalAmount: 100 }, { totalAmount: 90 },
    )).toThrow();
  });
});

describe('isSettlementRepayment', () => {
  const settlements = [
    { status: 'accepted', requesterTxnId: 'T-mine', responderTxnId: 'T-theirs' },
    { status: 'cancelled', requesterTxnId: 'T-undone', responderTxnId: 'T-undone-2' },
  ];

  it('is true for either side of an applied settlement', () => {
    expect(isSettlementRepayment('T-mine', settlements)).toBe(true);
    expect(isSettlementRepayment('T-theirs', settlements)).toBe(true);
  });

  it('is false for undone settlements and ordinary repayments', () => {
    expect(isSettlementRepayment('T-undone', settlements)).toBe(false);
    expect(isSettlementRepayment('T-local', settlements)).toBe(false);
  });
});
