// Phase 2B: decide whether a new loan entry should be saved locally (existing
// path) or branched into a linked_transaction_request.
//
// Branching rule: the picked contact is linked to another Hisaab user and the
// entry type is loan_given or loan_taken. No cross-currency gate: Phase 2B
// mirrors record only the obligation (no balance movement, account ids are
// null at accept time), so the sender's / receiver's account currencies don't
// constrain acceptance. Cross-currency handling re-enters the design when
// balance movement returns in a later phase.
//
// One exception: a CASH ADVANCE never branches. It is money borrowed from the
// user's own card (the card is the lender, not a person), so there is nobody
// to confirm it. Lending to a person FROM a card is not a cash advance — it
// branches like any other account, and the card is charged when they accept.
// Quick Entry used to treat every card-funded loan as a cash advance, so card
// lends to linked contacts were saved locally and only reached the other
// person through a manual "Sync past records" (2026-07-12 → 2026-09-19).

import type { Currency, LinkedRequestKind, Person } from '../db';

export type BranchDecision =
  | { branch: false }
  | { branch: true; kind: LinkedRequestKind; toUserId: string; personId: string; currency: Currency };

export function decideLinkedBranch(input: {
  type: 'loan_given' | 'loan_taken';
  person: Person | null | undefined;
  requestCurrency: Currency | null | undefined;
  /** The Quick Entry cash-advance flow (borrowing from the user's own card) —
   *  NOT merely "the chosen account is a credit card". */
  cashAdvance?: boolean;
}): BranchDecision {
  const { type, person, requestCurrency, cashAdvance } = input;
  if (cashAdvance) return { branch: false };
  if (!person || person.archivedAt || !person.linkedProfileId) return { branch: false };
  if (!requestCurrency) return { branch: false };

  return {
    branch: true,
    kind: type === 'loan_given' ? 'lent' : 'borrowed',
    toUserId: person.linkedProfileId,
    personId: person.id,
    currency: requestCurrency,
  };
}
