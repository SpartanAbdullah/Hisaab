import { describe, it, expect } from 'vitest';
import type { LinkedRequest, Loan, SettlementRequest } from '../db';
import { buildPendingItems, duplicateMirrorLoans } from './pendingLedger';

const ME = 'ghulam';
const THEM = 'abdullah';
const person = { id: 'pA', linkedProfileId: THEM };

function lreq(partial: Partial<LinkedRequest> & Pick<LinkedRequest, 'id' | 'fromUserId' | 'toUserId' | 'kind' | 'amount'>): LinkedRequest {
  return {
    personId: null, currency: 'AED', note: '', status: 'pending', rejectionReason: null,
    requesterLoanId: null, responderLoanId: null, requesterTxnId: null, responderTxnId: null,
    loanPairId: null, preExistingLoanId: null, createdAt: '2026-10-05T17:29:44.000Z', respondedAt: null,
    ...partial,
  };
}

function sreq(partial: Partial<SettlementRequest> & Pick<SettlementRequest, 'id' | 'fromUserId' | 'toUserId' | 'requesterLoanId' | 'responderLoanId' | 'amount'>): SettlementRequest {
  return {
    loanPairId: 'pair', currency: 'AED', note: '', status: 'pending', rejectionReason: null,
    requesterTxnId: null, responderTxnId: null, createdAt: '2026-10-05T10:00:00.000Z', respondedAt: null,
    ...partial,
  };
}

const myLoans = new Map<string, Pick<Loan, 'id' | 'type' | 'currency'>>([
  ['taken1', { id: 'taken1', type: 'taken', currency: 'AED' }],
  ['given1', { id: 'given1', type: 'given', currency: 'PKR' }],
]);

describe('buildPendingItems', () => {
  it('Ghulam: two incoming lend requests from Abdullah would raise what he owes by 100.60', () => {
    const out = buildPendingItems({
      person, myUserId: ME, loansById: myLoans, personLoanIds: new Set(['taken1', 'given1']),
      linkedRequests: [
        // personId on an INCOMING row is the sender's contact row — not mine.
        lreq({ id: 'r1', fromUserId: THEM, toUserId: ME, kind: 'lent', amount: 13, personId: 'abdullahs-row-for-ghulam' }),
        lreq({ id: 'r2', fromUserId: THEM, toUserId: ME, kind: 'lent', amount: 87.6, createdAt: '2026-10-05T17:30:12.000Z' }),
        lreq({ id: 'old', fromUserId: THEM, toUserId: ME, kind: 'lent', amount: 50, status: 'rejected' }),
      ],
      settlementRequests: [],
    });
    const aed = out.get('AED')!;
    expect(aed.items.map((i) => [i.id, i.direction, i.delta])).toEqual([['r1', 'awaiting_me', -13], ['r2', 'awaiting_me', -87.6]]);
    expect(aed.totalDelta).toBe(-100.6);
    // The ledger shows: closing −5,124.41 ⇒ if accepted −5,225.01.
    expect(Math.round((-5124.41 + aed.totalDelta) * 100) / 100).toBe(-5225.01);
  });

  it('signs follow MY side: incoming borrowed ⇒ I lent (+), outgoing borrowed ⇒ I owe (−)', () => {
    const out = buildPendingItems({
      person, myUserId: ME, loansById: myLoans, personLoanIds: new Set(),
      linkedRequests: [
        lreq({ id: 'in', fromUserId: THEM, toUserId: ME, kind: 'borrowed', amount: 40 }),
        lreq({ id: 'out', fromUserId: ME, toUserId: THEM, kind: 'borrowed', amount: 25, personId: 'pA' }),
      ],
      settlementRequests: [],
    });
    expect(out.get('AED')!.items.map((i) => [i.id, i.direction, i.delta])).toEqual([['in', 'awaiting_me', 40], ['out', 'awaiting_them', -25]]);
  });

  it('skips my own outgoing past-record syncs (already on my books) and other people', () => {
    const out = buildPendingItems({
      person, myUserId: ME, loansById: myLoans, personLoanIds: new Set(),
      linkedRequests: [
        lreq({ id: 'sync', fromUserId: ME, toUserId: THEM, kind: 'lent', amount: 48.8, personId: 'pA', preExistingLoanId: 'x' }),
        lreq({ id: 'other', fromUserId: 'someone', toUserId: ME, kind: 'lent', amount: 10 }),
      ],
      settlementRequests: [],
    });
    expect(out.size).toBe(0);
  });

  it('settlements resolve MY loan and move the balance toward zero; recorded/accepted ones are ignored', () => {
    const out = buildPendingItems({
      person, myUserId: ME, loansById: myLoans, personLoanIds: new Set(['taken1', 'given1']),
      linkedRequests: [],
      settlementRequests: [
        // I sent a payer's claim on my taken loan ⇒ what I owe drops (+).
        sreq({ id: 's1', fromUserId: ME, toUserId: THEM, requesterLoanId: 'taken1', responderLoanId: 'their', amount: 500 }),
        // They claim they paid me back on my given loan ⇒ what they owe drops (−).
        sreq({ id: 's2', fromUserId: THEM, toUserId: ME, requesterLoanId: 'their2', responderLoanId: 'given1', amount: 1000, currency: 'PKR' }),
        sreq({ id: 's3', fromUserId: THEM, toUserId: ME, requesterLoanId: 'x', responderLoanId: 'taken1', amount: 9, recordedByReceiver: true }),
        sreq({ id: 's4', fromUserId: ME, toUserId: THEM, requesterLoanId: 'taken1', responderLoanId: 'y', amount: 9, status: 'accepted' }),
        sreq({ id: 's5', fromUserId: ME, toUserId: THEM, requesterLoanId: 'not-this-person', responderLoanId: 'y', amount: 9 }),
      ],
    });
    expect(out.get('AED')!.items.map((i) => [i.id, i.direction, i.delta])).toEqual([['s1', 'awaiting_them', 500]]);
    expect(out.get('PKR')!.items.map((i) => [i.id, i.direction, i.delta])).toEqual([['s2', 'awaiting_me', -1000]]);
  });

  it('returns nothing without a signed-in user', () => {
    expect(buildPendingItems({ person, myUserId: null, loansById: myLoans, personLoanIds: new Set(), linkedRequests: [], settlementRequests: [] }).size).toBe(0);
  });
});

describe('duplicateMirrorLoans', () => {
  it('flags my two loans that mirror the same loan of theirs (the duplicate 100)', () => {
    const dupes = duplicateMirrorLoans([
      lreq({ id: 'a', fromUserId: THEM, toUserId: ME, kind: 'lent', amount: 100, status: 'accepted', requesterLoanId: 'their71', responderLoanId: 'mine1' }),
      lreq({ id: 'b', fromUserId: THEM, toUserId: ME, kind: 'lent', amount: 100, status: 'accepted', preExistingLoanId: 'their71', responderLoanId: 'mine2' }),
      lreq({ id: 'c', fromUserId: THEM, toUserId: ME, kind: 'lent', amount: 31, status: 'accepted', requesterLoanId: 'their2', responderLoanId: 'mine3' }),
      lreq({ id: 'd', fromUserId: THEM, toUserId: ME, kind: 'lent', amount: 31, status: 'rejected', requesterLoanId: 'their2', responderLoanId: 'mine4' }),
    ], ME);
    expect([...dupes.entries()].sort()).toEqual([['mine1', 2], ['mine2', 2]]);
  });
});
