// What the person ledger and the full-history PDF need beyond the statement
// itself, derived ONCE from the live stores so the screen and the paper can
// never disagree: what's awaiting confirmation with this person, which
// repayment rows were one lump payment, and which loans are duplicate mirrors.
// All of it is display-only — none of it touches a total.

import { useMemo } from 'react';
import type { Currency, Loan, Person } from '../db';
import { buildPendingItems, duplicateMirrorLoans, type PendingBucket } from '../lib/pendingLedger';
import type { StatementLine } from '../lib/statementOfAccount';
import { settlementBatchKeys } from '../lib/statementRows';
import { useLinkedRequestStore } from '../stores/linkedRequestStore';
import { useSettlementRequestStore } from '../stores/settlementRequestStore';
import { useSupabaseAuthStore } from '../stores/supabaseAuthStore';

export interface PersonLedgerExtras {
  pending: Map<Currency, PendingBucket>;
  batchKeyOf: (line: StatementLine) => string | undefined;
  duplicateLoanIds: Map<string, number>;
}

export function usePersonLedgerExtras(
  person: Pick<Person, 'id' | 'linkedProfileId'> | null | undefined,
  personLoans: readonly Loan[],
): PersonLedgerExtras {
  const linkedRequests = useLinkedRequestStore((s) => s.requests);
  const settlementRequests = useSettlementRequestStore((s) => s.requests);
  const myUserId = useSupabaseAuthStore((s) => s.user?.id ?? null);

  return useMemo(() => {
    const keys = settlementBatchKeys(settlementRequests);
    const batchKeyOf = (line: StatementLine) => (line.txnId ? keys.get(line.txnId) : undefined);
    if (!person) return { pending: new Map(), batchKeyOf, duplicateLoanIds: new Map() };
    const ids = new Set(personLoans.map((l) => l.id));
    const pending = buildPendingItems({
      person,
      myUserId,
      loansById: new Map(personLoans.map((l) => [l.id, l])),
      personLoanIds: ids,
      linkedRequests,
      settlementRequests,
    });
    const duplicateLoanIds = new Map(
      [...duplicateMirrorLoans(linkedRequests, myUserId)].filter(([loanId]) => ids.has(loanId)),
    );
    return { pending, batchKeyOf, duplicateLoanIds };
  }, [person, personLoans, linkedRequests, settlementRequests, myUserId]);
}
