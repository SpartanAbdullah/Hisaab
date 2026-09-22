// What a pending "Sync this record" request (Phase 2D past-record sync) will
// actually mirror, seen from the SENDER's side (backlog 2026-09-22, item 5).
//
// The request's `amount` is the loan's remaining at SEND time. Repayments the
// sender records while it sits pending move the loan but not (client-side) the
// request, so the Outgoing card used to keep promising the stale figure — the
// 2026-09-21 Ghulam incident: "1,581.80" on the card, 48.80 actually open.
// Since supabase-migration-linked-sync-live-amount.sql the accept RPC mirrors
// the loan AS IT IS at accept time (and refuses a settled / deleted one), so
// the card must show the same thing. Only the sender can read the loan (RLS);
// the receiver's figure is kept fresh server-side by the loans trigger.
import type { LinkedRequest, Loan } from '../db/types';

// Money is shown to 2 dp; anything closer than half a cent is "unchanged".
const SAME_EPSILON = 0.005;
// Same settle epsilon the accept RPC uses (remaining <= 0.00001 → settled).
const SETTLED_EPSILON = 0.00001;

export type PendingSyncView =
  /** Not a pending past-record sync I sent, or its loan isn't on this device. */
  | { state: 'not_applicable' }
  /** The loan still carries exactly what was sent. */
  | { state: 'unchanged'; current: number }
  /** Repaid / edited since sending — the accept will mirror `current`. */
  | { state: 'changed'; sent: number; current: number }
  /** Nothing left on the loan — the accept will be refused. */
  | { state: 'settled' }
  /** The loan was deleted (or re-currencied) — the accept will be refused. */
  | { state: 'gone' };

export function pendingSyncView(
  request: Pick<LinkedRequest, 'status' | 'preExistingLoanId' | 'fromUserId' | 'amount' | 'currency'>,
  myUserId: string | null | undefined,
  loans: readonly Pick<Loan, 'id' | 'remainingAmount' | 'status' | 'currency' | 'deletedAt'>[],
): PendingSyncView {
  if (request.status !== 'pending' || !request.preExistingLoanId) return { state: 'not_applicable' };
  if (!myUserId || request.fromUserId !== myUserId) return { state: 'not_applicable' };

  const loan = loans.find((l) => l.id === request.preExistingLoanId);
  // The loans store holds my live (non-deleted) loans. A missing row is a
  // deleted loan — or a store that hasn't loaded yet, which the caller can't
  // tell apart; say nothing rather than alarm on a cold start.
  if (!loan) return { state: 'not_applicable' };
  if (loan.deletedAt || loan.currency !== request.currency) return { state: 'gone' };
  if (loan.status !== 'active' || loan.remainingAmount <= SETTLED_EPSILON) return { state: 'settled' };
  if (Math.abs(loan.remainingAmount - request.amount) < SAME_EPSILON) {
    return { state: 'unchanged', current: request.amount };
  }
  return { state: 'changed', sent: request.amount, current: loan.remainingAmount };
}

/** The figure to show / quote for the request: the live remaining when it moved. */
export function pendingSyncDisplayAmount(
  request: Pick<LinkedRequest, 'amount'>,
  view: PendingSyncView,
): number {
  return view.state === 'changed' ? view.current : request.amount;
}
