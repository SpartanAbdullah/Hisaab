// Editing a saved card-bill payment (backlog 2026-09-22 item 1).
//
// A transfer INTO a credit card that settled cash-advance instalments owns a
// set of ledger-only 'repayment' rows (both account ids null), one per advance
// it paid down, each carrying `linkedTransactionId = <the transfer's id>` in
// its internal note ("Covered by card bill payment"). Those rows are keyed to
// the transfer's AMOUNT and ACCOUNTS, so changing any of those would desync
// the loans — that still means delete + re-enter. But the DATE and the note are
// pure metadata: moving the date must move every linked row with it, or the
// loan's history says the instalment was paid on a different day than the
// bill that paid it.
import { parseInternalNote } from './internalNotes';

interface RowLike {
  id: string;
  type: string;
  notes?: string | null;
}

/** The ledger rows a bill-payment transfer wrote (empty for a plain transfer). */
export function linkedBillPaymentRows<T extends RowLike>(transactions: T[], transferId: string): T[] {
  return transactions.filter(
    (row) =>
      row.id !== transferId &&
      row.type === 'repayment' &&
      parseInternalNote(row.notes).meta.linkedTransactionId === transferId,
  );
}

interface TransferMoneyFields {
  amount: number;
  sourceAccountId: string | null;
  destinationAccountId: string | null;
  conversionRate?: number | null;
}

/** True when an edit to a transfer changes NOTHING that moves money — only its
 *  date and/or note. Amounts compare at 2dp; a missing rate equals no rate. */
export function transferEditKeepsMoney(existing: TransferMoneyFields, next: TransferMoneyFields): boolean {
  const cents = (n: number) => Math.round(n * 100);
  const rate = (r: number | null | undefined) => (r && r > 0 ? r : null);
  return (
    cents(existing.amount) === cents(next.amount) &&
    (existing.sourceAccountId ?? null) === (next.sourceAccountId ?? null) &&
    (existing.destinationAccountId ?? null) === (next.destinationAccountId ?? null) &&
    rate(existing.conversionRate) === rate(next.conversionRate)
  );
}
