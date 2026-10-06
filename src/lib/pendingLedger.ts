// What is waiting for a confirmation with ONE person, in the statement's sign
// convention (positive ⇒ they owe you), so the person ledger and the PDF can
// say "not in the total yet — if accepted, the total becomes X".
//
// Pending items never touch a loan until accepted (accept_linked_request /
// accept_settlement_request write the rows), so every total in the app already
// excludes them; this module only makes them VISIBLE next to that total. It
// must never be folded into `closing`.
//
// Matching subtleties (verified against prod rows, 2026-10-06):
//  - An INCOMING linked request's `personId` is the SENDER's contact row, not
//    mine — match it by `fromUserId === person.linkedProfileId`.
//  - An OUTGOING past-record sync (`preExistingLoanId`) is a loan already on
//    my books; counting it again would double it (see pendingSyncAmount.ts).
//  - A settlement request names a loan on each side; mine is the requester's
//    when I sent it, the responder's when I received it. Its sign follows MY
//    loan's direction: a repayment always moves the balance toward zero.
//  - A receiver-recorded settlement applied at once — it is not pending.

import type { Currency, LinkedRequest, Loan, Person, SettlementRequest } from '../db';

const round2 = (n: number): number => Math.round(n * 100) / 100;

export interface PendingItem {
  id: string;
  source: 'loan' | 'settlement';
  direction: 'awaiting_me' | 'awaiting_them';
  currency: Currency;
  amount: number; // positive
  delta: number; // signed effect on the balance IF accepted
  note: string;
  createdAt: string;
  isSync: boolean; // a past-record sync, not a new loan
}

export interface PendingBucket {
  items: PendingItem[]; // oldest first
  totalDelta: number;
}

export interface BuildPendingInput {
  person: Pick<Person, 'id' | 'linkedProfileId'>;
  myUserId: string | null | undefined;
  loansById: ReadonlyMap<string, Pick<Loan, 'id' | 'type' | 'currency'>>;
  personLoanIds: ReadonlySet<string>;
  linkedRequests: readonly LinkedRequest[];
  settlementRequests: readonly SettlementRequest[];
}

export function buildPendingItems(input: BuildPendingInput): Map<Currency, PendingBucket> {
  const { person, myUserId, loansById, personLoanIds } = input;
  const items: PendingItem[] = [];
  if (!myUserId) return new Map();
  const theirId = person.linkedProfileId ?? null;

  for (const r of input.linkedRequests) {
    if (r.status !== 'pending') continue;
    const incoming = r.toUserId === myUserId && !!theirId && r.fromUserId === theirId;
    const outgoing =
      r.fromUserId === myUserId &&
      (r.personId === person.id || (!!theirId && r.toUserId === theirId));
    if (!incoming && !outgoing) continue;
    if (outgoing && r.preExistingLoanId) continue; // already on my books
    // `kind` is the SENDER's side. I lent ⇒ they owe me more (+).
    const iLent = incoming ? r.kind === 'borrowed' : r.kind === 'lent';
    items.push({
      id: r.id,
      source: 'loan',
      direction: incoming ? 'awaiting_me' : 'awaiting_them',
      currency: r.currency,
      amount: round2(r.amount),
      delta: round2(iLent ? r.amount : -r.amount),
      note: (r.note ?? '').trim(),
      createdAt: r.createdAt,
      isSync: !!r.preExistingLoanId,
    });
  }

  for (const s of input.settlementRequests) {
    if (s.status !== 'pending' || s.recordedByReceiver) continue;
    const mine = s.fromUserId === myUserId ? s.requesterLoanId : s.toUserId === myUserId ? s.responderLoanId : null;
    if (!mine || !personLoanIds.has(mine)) continue;
    const loan = loansById.get(mine);
    if (!loan) continue;
    items.push({
      id: s.id,
      source: 'settlement',
      direction: s.toUserId === myUserId ? 'awaiting_me' : 'awaiting_them',
      currency: loan.currency,
      amount: round2(s.amount),
      // Money back on a loan I GAVE reduces what they owe me (−); paying back
      // a loan I TOOK reduces what I owe them (+).
      delta: round2(loan.type === 'given' ? -s.amount : s.amount),
      note: (s.note ?? '').trim(),
      createdAt: s.createdAt,
      isSync: false,
    });
  }

  items.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  const out = new Map<Currency, PendingBucket>();
  for (const item of items) {
    const bucket = out.get(item.currency) ?? { items: [], totalDelta: 0 };
    bucket.items.push(item);
    bucket.totalDelta = round2(bucket.totalDelta + item.delta);
    out.set(item.currency, bucket);
  }
  return out;
}

/**
 * My loans that mirror the SAME loan on the other person's side. Happens when
 * a past record is synced twice (2026-05 Ghulam: one 100 AED loan of
 * Abdullah's accepted twice → two loans here, each repaid once, net zero).
 * Nothing is wrong with the totals, but the history reads like a second
 * borrowing — the ledger labels these lines instead of hiding them.
 * Returns myLoanId → how many of my loans share that counterpart.
 */
export function duplicateMirrorLoans(
  linkedRequests: readonly LinkedRequest[],
  myUserId: string | null | undefined,
): Map<string, number> {
  const byTheirLoan = new Map<string, Set<string>>();
  if (!myUserId) return new Map();
  for (const r of linkedRequests) {
    if (r.status !== 'accepted') continue;
    const iSent = r.fromUserId === myUserId;
    if (!iSent && r.toUserId !== myUserId) continue;
    const myLoan = iSent ? (r.requesterLoanId ?? r.preExistingLoanId) : r.responderLoanId;
    const theirLoan = iSent ? r.responderLoanId : (r.requesterLoanId ?? r.preExistingLoanId);
    if (!myLoan || !theirLoan) continue;
    const set = byTheirLoan.get(theirLoan) ?? new Set<string>();
    set.add(myLoan);
    byTheirLoan.set(theirLoan, set);
  }
  const out = new Map<string, number>();
  for (const mine of byTheirLoan.values()) {
    if (mine.size < 2) continue;
    for (const id of mine) out.set(id, mine.size);
  }
  return out;
}
