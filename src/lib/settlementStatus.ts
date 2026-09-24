// What a linked settlement row means to the person looking at it, and which
// actions it offers — the 2026-09-24 settlement model
// (supabase-migration-settlement-receiver-records.sql):
//
//   · the person who RECEIVED the money records it → both ledgers update at
//     once ("recorded"), undoable for 10 minutes;
//   · the payer's claim still waits for the receiver's OK ("pending");
//   · either side can later "Add to an account" when their side of an
//     applied settlement was record-only.
//
// Pure (no stores, no clock of its own) so every rule here is unit-tested and
// the Inbox card, the LoanDetail history row and the modals agree.

import type { SettlementRequest } from '../db';

/** Must match the SQL literal in undo_received_repayment (10 minutes). */
export const UNDO_WINDOW_MS = 10 * 60 * 1000;

/** A payment recorded twice looks like this: same amount, within these days. */
export const DUPLICATE_WINDOW_DAYS = 3;

export type SettlementDisplayStatus =
  | 'pending'
  | 'accepted' // the other person confirmed a claim
  | 'recorded' // the receiver recorded it — applied at once, nothing to confirm
  | 'rejected'
  | 'cancelled'
  | 'undone';

type Row = Pick<
  SettlementRequest,
  | 'status'
  | 'fromUserId'
  | 'toUserId'
  | 'amount'
  | 'createdAt'
  | 'respondedAt'
  | 'requesterAccountId'
  | 'responderAccountId'
  | 'requesterTxnId'
  | 'responderTxnId'
  | 'recordedByReceiver'
  | 'undoneAt'
>;

export function settlementDisplayStatus(r: Pick<Row, 'status' | 'recordedByReceiver' | 'undoneAt'>): SettlementDisplayStatus {
  if (r.status === 'cancelled' && r.undoneAt) return 'undone';
  if (r.status === 'accepted' && r.recordedByReceiver) return 'recorded';
  return r.status;
}

/** Milliseconds of Undo left for this viewer, or 0 when Undo is not offered. */
export function undoMsLeft(r: Row, myUserId: string | null | undefined, nowMs: number): number {
  if (!myUserId || r.fromUserId !== myUserId) return 0;
  if (r.status !== 'accepted' || !r.recordedByReceiver) return 0;
  // Once the payer has put their side in an account, the server refuses Undo.
  if (r.responderAccountId) return 0;
  if (!r.respondedAt) return 0;
  const at = Date.parse(r.respondedAt);
  if (!Number.isFinite(at)) return 0;
  return Math.max(0, at + UNDO_WINDOW_MS - nowMs);
}

export function canUndo(r: Row, myUserId: string | null | undefined, nowMs: number): boolean {
  return undoMsLeft(r, myUserId, nowMs) > 0;
}

/** "9:41" — minutes:seconds left, for the Undo countdown. */
export function formatUndoLeft(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * The receiver may apply their OWN pending request now — the server checks
 * the same thing (apply_own_settlement_request). `myLoanType` is the type of
 * the viewer's loan in the pair; only a GIVEN loan (they're paying me) can be
 * applied without the other person.
 */
export function canApplyNow(
  r: Pick<Row, 'status' | 'fromUserId'>,
  myUserId: string | null | undefined,
  myLoanType: 'given' | 'taken' | null | undefined,
): boolean {
  return !!myUserId && r.status === 'pending' && r.fromUserId === myUserId && myLoanType === 'given';
}

/** The viewer's own repayment row for an applied settlement, if any. */
export function myRepaymentTxnId(
  r: Pick<Row, 'fromUserId' | 'toUserId' | 'requesterTxnId' | 'responderTxnId'>,
  myUserId: string | null | undefined,
): string | null {
  if (!myUserId) return null;
  if (r.fromUserId === myUserId) return r.requesterTxnId ?? null;
  if (r.toUserId === myUserId) return r.responderTxnId ?? null;
  return null;
}

/** The account the viewer's own side touched (null = record only). */
export function myAccountId(
  r: Pick<Row, 'fromUserId' | 'toUserId' | 'requesterAccountId' | 'responderAccountId'>,
  myUserId: string | null | undefined,
): string | null {
  if (!myUserId) return null;
  if (r.fromUserId === myUserId) return r.requesterAccountId ?? null;
  if (r.toUserId === myUserId) return r.responderAccountId ?? null;
  return null;
}

/**
 * "Add to an account" is offered on an APPLIED settlement whose viewer side is
 * record-only — full tracker only (a ledger-only user has no accounts). The
 * server re-checks everything (set_settlement_repayment_account).
 */
export function canAttachAccount(r: Row, myUserId: string | null | undefined, fullTracker: boolean): boolean {
  if (!fullTracker || r.status !== 'accepted') return false;
  if (!myRepaymentTxnId(r, myUserId)) return false;
  return myAccountId(r, myUserId) === null;
}

export type DuplicateHint =
  | { kind: 'their_pending_claim'; request: SettlementRequest }
  | { kind: 'already_recorded'; request: SettlementRequest };

/**
 * Before the receiver records a payment on a pair, look for the same money
 * already on its way in:
 *   · the other person already sent a pending claim for this amount → offer
 *     to confirm THEIR claim instead of recording a second repayment;
 *   · I already recorded this amount on this pair within a few days → warn.
 * Same pair, amount within 0.01. Returns null when nothing matches.
 */
export function possibleDuplicateClaim(
  requests: SettlementRequest[],
  input: { loanPairId: string; amount: number; myUserId: string; nowMs: number },
): DuplicateHint | null {
  const sameMoney = (r: SettlementRequest) =>
    r.loanPairId === input.loanPairId && Math.abs(r.amount - input.amount) <= 0.01;

  const theirs = requests.find(
    (r) => sameMoney(r) && r.status === 'pending' && r.toUserId === input.myUserId,
  );
  if (theirs) return { kind: 'their_pending_claim', request: theirs };

  const windowMs = DUPLICATE_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const mine = requests.find((r) => {
    if (!sameMoney(r) || r.status !== 'accepted' || !r.recordedByReceiver) return false;
    if (r.fromUserId !== input.myUserId) return false;
    const at = Date.parse(r.respondedAt ?? r.createdAt);
    return Number.isFinite(at) && Math.abs(input.nowMs - at) <= windowMs;
  });
  if (mine) return { kind: 'already_recorded', request: mine };

  return null;
}

/**
 * The account MY side used on my most recent applied settlement with this
 * person. The chooser lists it first — it is never preselected (a silent
 * default is exactly what lost the 24 Sep repayment).
 */
export function lastSettlementAccountId(
  requests: SettlementRequest[],
  myUserId: string | null | undefined,
  otherUserId: string | null | undefined,
): string | null {
  if (!myUserId || !otherUserId) return null;
  let best: { at: number; id: string } | null = null;
  for (const r of requests) {
    const withThem =
      (r.fromUserId === myUserId && r.toUserId === otherUserId) ||
      (r.toUserId === myUserId && r.fromUserId === otherUserId);
    if (!withThem || r.status !== 'accepted') continue;
    const account = myAccountId(r, myUserId);
    if (!account) continue;
    const at = Date.parse(r.respondedAt ?? r.createdAt);
    if (!Number.isFinite(at)) continue;
    if (!best || at > best.at) best = { at, id: account };
  }
  return best?.id ?? null;
}
