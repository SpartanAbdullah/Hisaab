// Guards that keep a cross-user (mirrored) loan from silently diverging.
//
// A linked loan exists as TWO rows — one on each user's ledger. They must stay
// in sync, so once linked (loanPairId set) and still active, neither side may
// unilaterally change the currency/amount or delete it. Repayments (which only
// touch remainingAmount) and cosmetic edits (notes) stay allowed so sensible
// users aren't over-blocked. Pure + tested; called from loanStore.

import type { Loan } from '../db';

export interface LinkedPairRowLike {
  id: string;
  status: string;
  requesterLoanId?: string | null;
  responderLoanId?: string | null;
}

/**
 * The accepted linked pair a loan belongs to, from the linked-request rows.
 *
 * Loans carry no pair column: `Loan.loanPairId` is mapped from
 * `loans.loan_pair_id`, which no migration ever created (the column lives on
 * linked_transaction_requests only), so it is always null and every guard in
 * this file silently never fired (found 2026-09-24). Callers pass
 * `loan.loanPairId ?? linkedPairIdForLoan(loan.id, rows)` instead.
 */
export function linkedPairIdForLoan(loanId: string, rows: LinkedPairRowLike[]): string | null {
  const pair = rows.find(
    (r) => r.status === 'accepted' && (r.requesterLoanId === loanId || r.responderLoanId === loanId),
  );
  return pair?.id ?? null;
}

/**
 * True when a repayment row is one side of an APPLIED linked settlement —
 * the mirror of a row on the other person's books. Deleting it on one side
 * would split the two ledgers, whatever the loan's status.
 */
export function isSettlementRepayment(
  txnId: string,
  settlements: Array<{ status: string; requesterTxnId: string | null; responderTxnId: string | null }>,
): boolean {
  return settlements.some(
    (r) => r.status === 'accepted' && (r.requesterTxnId === txnId || r.responderTxnId === txnId),
  );
}

export function isLinkedLoan(loan: Pick<Loan, 'loanPairId'>): boolean {
  return !!loan.loanPairId;
}

// Throws if a change would diverge a still-active mirrored loan. Only the
// structural fields (currency, totalAmount) are protected — remainingAmount
// (repayments), notes, status, personName remain editable.
export function assertLinkedLoanEditAllowed(
  loan: Pick<Loan, 'loanPairId' | 'status' | 'currency' | 'totalAmount'>,
  changes: Partial<Pick<Loan, 'currency' | 'totalAmount'>>,
): void {
  if (!loan.loanPairId || loan.status !== 'active') return;
  if (changes.currency !== undefined && changes.currency !== loan.currency) {
    throw new Error(
      "This loan is linked with another person — its currency can't be changed here. Settle it, or send a corrected request so both sides stay in sync.",
    );
  }
  if (changes.totalAmount !== undefined && changes.totalAmount !== loan.totalAmount) {
    throw new Error(
      "This loan is linked with another person — its amount can't be changed here. Send a corrected request so both sides stay in sync.",
    );
  }
}

// Throws if deleting would orphan the other side's mirrored row.
export function assertLinkedLoanDeleteAllowed(loan: Pick<Loan, 'loanPairId' | 'status'>): void {
  if (loan.loanPairId && loan.status === 'active') {
    throw new Error(
      "This loan is linked with another person — settle it instead of deleting, so their copy doesn't get left behind.",
    );
  }
}
