import { describe, expect, it } from 'vitest';
import type { SettlementRequest } from '../db';
import {
  UNDO_WINDOW_MS,
  canApplyNow,
  canAttachAccount,
  canUndo,
  formatUndoLeft,
  lastSettlementAccountId,
  myAccountId,
  myRepaymentTxnId,
  possibleDuplicateClaim,
  settlementDisplayStatus,
  undoMsLeft,
} from './settlementStatus';

const ME = 'me';
const THEM = 'them';
const T0 = Date.parse('2026-09-24T15:00:00Z');

function row(over: Partial<SettlementRequest> = {}): SettlementRequest {
  return {
    id: 'r1',
    loanPairId: 'pair-1',
    requesterLoanId: 'my-loan',
    responderLoanId: 'their-loan',
    fromUserId: ME,
    toUserId: THEM,
    amount: 3000,
    currency: 'AED',
    note: '',
    status: 'accepted',
    rejectionReason: null,
    requesterTxnId: 'txn-mine',
    responderTxnId: 'txn-theirs',
    requesterAccountId: null,
    responderAccountId: null,
    recordedByReceiver: true,
    undoneAt: null,
    createdAt: new Date(T0).toISOString(),
    respondedAt: new Date(T0).toISOString(),
    ...over,
  };
}

describe('settlementDisplayStatus', () => {
  it('names the receiver record, the undo, and leaves the rest alone', () => {
    expect(settlementDisplayStatus(row())).toBe('recorded');
    expect(settlementDisplayStatus(row({ recordedByReceiver: false }))).toBe('accepted');
    expect(settlementDisplayStatus(row({ status: 'cancelled', undoneAt: new Date(T0).toISOString() }))).toBe('undone');
    expect(settlementDisplayStatus(row({ status: 'cancelled' }))).toBe('cancelled');
    expect(settlementDisplayStatus(row({ status: 'pending', recordedByReceiver: false }))).toBe('pending');
    expect(settlementDisplayStatus(row({ status: 'rejected', recordedByReceiver: false }))).toBe('rejected');
  });

  it('a row read before the migration (no flag) is a plain accepted row', () => {
    expect(settlementDisplayStatus(row({ recordedByReceiver: undefined, undoneAt: undefined }))).toBe('accepted');
  });
});

describe('Undo — 10 minutes, the recorder only, not once the payer used it', () => {
  it('offers the remaining window to the recorder', () => {
    expect(undoMsLeft(row(), ME, T0 + 60_000)).toBe(UNDO_WINDOW_MS - 60_000);
    expect(canUndo(row(), ME, T0 + UNDO_WINDOW_MS - 1)).toBe(true);
  });

  it('closes exactly at 10 minutes', () => {
    expect(canUndo(row(), ME, T0 + UNDO_WINDOW_MS)).toBe(false);
  });

  it('is never offered to the payer, on a confirmed claim, or once the payer added an account', () => {
    expect(canUndo(row(), THEM, T0)).toBe(false);
    expect(canUndo(row({ recordedByReceiver: false }), ME, T0)).toBe(false);
    expect(canUndo(row({ responderAccountId: 'their-bank' }), ME, T0)).toBe(false);
    expect(canUndo(row({ status: 'cancelled', undoneAt: new Date(T0).toISOString() }), ME, T0)).toBe(false);
    expect(canUndo(row(), null, T0)).toBe(false);
  });

  it('formats the countdown as m:ss', () => {
    expect(formatUndoLeft(UNDO_WINDOW_MS)).toBe('10:00');
    expect(formatUndoLeft(61_000)).toBe('1:01');
    expect(formatUndoLeft(400)).toBe('0:01');
    expect(formatUndoLeft(-5)).toBe('0:00');
  });
});

describe('Apply now', () => {
  it('only my own pending request, and only when I am the one receiving', () => {
    const pending = row({ status: 'pending', recordedByReceiver: false });
    expect(canApplyNow(pending, ME, 'given')).toBe(true);
    expect(canApplyNow(pending, ME, 'taken')).toBe(false); // my claim waits for them
    expect(canApplyNow(pending, THEM, 'given')).toBe(false);
    expect(canApplyNow(row(), ME, 'given')).toBe(false); // already applied
  });
});

describe('Add to an account', () => {
  it('finds my own side of the settlement', () => {
    expect(myRepaymentTxnId(row(), ME)).toBe('txn-mine');
    expect(myRepaymentTxnId(row(), THEM)).toBe('txn-theirs');
    expect(myRepaymentTxnId(row(), 'stranger')).toBeNull();
    expect(myAccountId(row({ requesterAccountId: 'mashreq' }), ME)).toBe('mashreq');
    expect(myAccountId(row({ responderAccountId: 'their-bank' }), THEM)).toBe('their-bank');
  });

  it('THE FIX: an applied, record-only side offers "Add to an account" (full tracker)', () => {
    expect(canAttachAccount(row({ recordedByReceiver: false }), ME, true)).toBe(true);
    expect(canAttachAccount(row(), THEM, true)).toBe(true);
  });

  it('is not offered when my side already landed, in ledger-only mode, or before it applied', () => {
    expect(canAttachAccount(row({ requesterAccountId: 'mashreq' }), ME, true)).toBe(false);
    expect(canAttachAccount(row(), ME, false)).toBe(false);
    expect(canAttachAccount(row({ status: 'pending', requesterTxnId: null }), ME, true)).toBe(false);
    expect(canAttachAccount(row({ status: 'cancelled', undoneAt: 'x' }), ME, true)).toBe(false);
  });
});

describe('possibleDuplicateClaim', () => {
  const nowMs = T0 + 60 * 60 * 1000;

  it('their pending claim for the same money → confirm theirs instead', () => {
    const claim = row({ id: 'c1', fromUserId: THEM, toUserId: ME, status: 'pending', recordedByReceiver: false });
    const hint = possibleDuplicateClaim([claim], { loanPairId: 'pair-1', amount: 3000.004, myUserId: ME, nowMs });
    expect(hint).toEqual({ kind: 'their_pending_claim', request: claim });
  });

  it('my own recent record of the same money on the same pair → warn', () => {
    const mine = row({ id: 'm1' });
    expect(possibleDuplicateClaim([mine], { loanPairId: 'pair-1', amount: 3000, myUserId: ME, nowMs }))
      .toEqual({ kind: 'already_recorded', request: mine });
  });

  it('ignores other pairs, other amounts, old records, undone and my own outgoing claims', () => {
    const others = [
      row({ id: 'a', loanPairId: 'pair-2' }),
      row({ id: 'b', amount: 2999 }),
      row({ id: 'c', respondedAt: new Date(T0 - 4 * 24 * 3600 * 1000).toISOString() }),
      row({ id: 'd', status: 'cancelled', undoneAt: new Date(T0).toISOString() }),
      row({ id: 'e', status: 'pending', recordedByReceiver: false }), // mine, not theirs
    ];
    expect(possibleDuplicateClaim(others, { loanPairId: 'pair-1', amount: 3000, myUserId: ME, nowMs })).toBeNull();
  });
});

describe('lastSettlementAccountId', () => {
  it('returns the account my side used most recently with this person', () => {
    const rows = [
      row({ id: 'a', requesterAccountId: 'wio', respondedAt: new Date(T0 - 1000).toISOString() }),
      row({ id: 'b', requesterAccountId: 'mashreq', respondedAt: new Date(T0).toISOString() }),
      // I was the responder here — my account is the responder one.
      row({ id: 'c', fromUserId: THEM, toUserId: ME, responderAccountId: 'cash', respondedAt: new Date(T0 - 5000).toISOString() }),
    ];
    expect(lastSettlementAccountId(rows, ME, THEM)).toBe('mashreq');
  });

  it('ignores record-only sides, pending rows and other people', () => {
    const rows = [
      row({ id: 'a', requesterAccountId: null }),
      row({ id: 'b', status: 'pending', requesterAccountId: 'wio' }),
      row({ id: 'c', toUserId: 'someone-else', requesterAccountId: 'enbd' }),
    ];
    expect(lastSettlementAccountId(rows, ME, THEM)).toBeNull();
    expect(lastSettlementAccountId(rows, null, THEM)).toBeNull();
  });
});
