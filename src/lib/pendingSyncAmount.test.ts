import { describe, expect, it } from 'vitest';
import { pendingSyncDisplayAmount, pendingSyncView } from './pendingSyncAmount';
import { friendlyLinkedError } from './linkedErrorMap';
import type { LinkedRequest, Loan } from '../db/types';

const ME = 'me';

function req(over: Partial<LinkedRequest> = {}): LinkedRequest {
  return {
    id: 'r1', fromUserId: ME, toUserId: 'ghulam', personId: 'p1', kind: 'lent',
    amount: 1581.8, currency: 'AED', note: '', status: 'pending',
    rejectionReason: null, requesterLoanId: null, responderLoanId: null,
    requesterTxnId: null, responderTxnId: null, loanPairId: null,
    preExistingLoanId: 'L1', requesterAccountId: null, responderAccountId: null,
    createdAt: '2026-09-20T10:00:00Z', respondedAt: null,
    ...over,
  };
}

function loan(over: Partial<Loan> = {}): Loan {
  return {
    id: 'L1', personName: 'Ghulam', personId: 'p1', type: 'given',
    totalAmount: 1581.8, remainingAmount: 1581.8, currency: 'AED',
    status: 'active', notes: '', createdAt: '2026-01-01T00:00:00Z',
    ...over,
  };
}

describe('pendingSyncView', () => {
  it('the 2026-09-21 incident: repaid 1,440 + 93 while pending → changed to 48.80', () => {
    const view = pendingSyncView(req(), ME, [loan({ remainingAmount: 48.8 })]);
    expect(view).toEqual({ state: 'changed', sent: 1581.8, current: 48.8 });
    expect(pendingSyncDisplayAmount(req(), view)).toBe(48.8);
  });

  it('untouched loan → unchanged, shows the sent amount', () => {
    const view = pendingSyncView(req(), ME, [loan()]);
    expect(view).toEqual({ state: 'unchanged', current: 1581.8 });
    expect(pendingSyncDisplayAmount(req(), view)).toBe(1581.8);
  });

  it('sub-cent float noise is not a change', () => {
    const view = pendingSyncView(req({ amount: 48.8 }), ME, [loan({ remainingAmount: 48.800000001 })]);
    expect(view.state).toBe('unchanged');
  });

  it('a loan edited UP is a change too (accept mirrors the live figure either way)', () => {
    expect(pendingSyncView(req(), ME, [loan({ remainingAmount: 2000 })]))
      .toEqual({ state: 'changed', sent: 1581.8, current: 2000 });
  });

  it('settled or zero remaining → settled (the accept will be refused)', () => {
    expect(pendingSyncView(req(), ME, [loan({ status: 'settled', remainingAmount: 0 })]).state).toBe('settled');
    expect(pendingSyncView(req(), ME, [loan({ remainingAmount: 0 })]).state).toBe('settled');
  });

  it('tombstoned or re-currencied loan → gone', () => {
    expect(pendingSyncView(req(), ME, [loan({ deletedAt: '2026-09-21T00:00:00Z' })]).state).toBe('gone');
    expect(pendingSyncView(req(), ME, [loan({ currency: 'PKR' })]).state).toBe('gone');
  });

  it('display amount falls back to the request amount unless changed', () => {
    expect(pendingSyncDisplayAmount(req(), { state: 'settled' })).toBe(1581.8);
    expect(pendingSyncDisplayAmount(req(), { state: 'not_applicable' })).toBe(1581.8);
  });

  describe('not applicable', () => {
    it('a fresh-loan request (no pre-existing loan)', () => {
      expect(pendingSyncView(req({ preExistingLoanId: null }), ME, [loan()]).state).toBe('not_applicable');
    });
    it('a request that is no longer pending', () => {
      for (const status of ['accepted', 'rejected', 'cancelled'] as const) {
        expect(pendingSyncView(req({ status }), ME, [loan({ remainingAmount: 1 })]).state).toBe('not_applicable');
      }
    });
    it('an INCOMING request — I cannot read the sender’s loan; the server keeps its amount fresh', () => {
      expect(pendingSyncView(req({ fromUserId: 'ghulam', toUserId: ME }), ME, [loan({ remainingAmount: 1 })]).state)
        .toBe('not_applicable');
    });
    it('no signed-in user', () => {
      expect(pendingSyncView(req(), null, [loan({ remainingAmount: 1 })]).state).toBe('not_applicable');
    });
    it('the loan is not in the store (cold start) — say nothing', () => {
      expect(pendingSyncView(req(), ME, []).state).toBe('not_applicable');
    });
  });
});

// The accept RPC's three new refusals reach the toast as bilingual copy, not
// as the raw 'ltr:' developer string.
describe('accept refusals for a moved sync loan', () => {
  it.each([
    ['ltr: pre_existing loan has been settled or archived', /fully paid off/],
    ['ltr: pre_existing loan no longer available', /deleted or changed/],
    ['ltr: pre_existing loan changed currency', /deleted or changed/],
  ])('%s', (raw, expected) => {
    const msg = friendlyLinkedError(raw);
    expect(msg).not.toContain('ltr:');
    expect(msg).toMatch(expected);
  });
});
