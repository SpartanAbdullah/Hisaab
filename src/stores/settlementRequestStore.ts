import { create } from 'zustand';
import { v4 as uuid } from 'uuid';
import { settlementRequestsDb } from '../lib/supabaseDb';
import type { SettlementRequest, Currency } from '../db';
import { translateLinkedWriteError, isDuplicateKeyError } from '../lib/linkedErrorMap';
import { useLoanStore } from './loanStore';
import { useTransactionStore } from './transactionStore';
import { useAccountStore } from './accountStore';
import { useEmiStore } from './emiStore';
import { useActivityStore } from './activityStore';
import { reportError } from '../lib/errorReporter';

interface CreateInput {
  loanPairId: string;
  requesterLoanId: string;
  responderLoanId: string;
  toUserId: string;
  amount: number;
  currency: Currency;
  note?: string;
  // Phase 2C-B: optional sender-side opt-in. Null ⇒ ledger-only on both sides.
  requesterAccountId?: string | null;
  // Idempotency key (audit 2026-09, F-8) — see linkedRequestStore.CreateInput.
  // `linked_settlement_requests.id` is a client-supplied `text primary key`
  // and create_settlement_request inserts it verbatim, so reusing one id per
  // submit intent turns a double-fire into a 23505 instead of two settlement
  // requests the counterparty could both accept. Omitted ⇒ fresh uuid.
  requestId?: string;
}

// The receiver's record (2026-09-24 settlement model). Same shape as a
// request, but it applies to both ledgers at once — no confirmation.
interface RecordInput {
  loanPairId: string;
  requesterLoanId: string;
  responderLoanId: string;
  toUserId: string;
  amount: number;
  currency: Currency;
  note?: string;
  // Where the money landed. Null ⇒ record only (the user chose that
  // explicitly — SettlementAccountChoice never defaults to it).
  requesterAccountId: string | null;
  requestId?: string;
}

interface SettlementRequestState {
  requests: SettlementRequest[];
  loading: boolean;
  loadRequests: () => Promise<void>;
  createRequest: (input: CreateInput) => Promise<SettlementRequest>;
  recordReceived: (input: RecordInput) => Promise<SettlementRequest>;
  applyNow: (requestId: string) => Promise<SettlementRequest>;
  undo: (requestId: string) => Promise<SettlementRequest>;
  attachAccount: (txnId: string, accountId: string) => Promise<number>;
  accept: (requestId: string, responderAccountId?: string | null) => Promise<SettlementRequest>;
  reject: (requestId: string, reason?: string) => Promise<SettlementRequest>;
  cancel: (requestId: string) => Promise<SettlementRequest>;
  byLoanPair: (loanPairId: string) => SettlementRequest[];
  incomingPending: (myUserId: string) => SettlementRequest[];
  outgoingPending: (myUserId: string) => SettlementRequest[];
  reset: () => void;
}

const INITIAL: Pick<SettlementRequestState, 'requests' | 'loading'> = {
  requests: [],
  loading: false,
};

function upsert(list: SettlementRequest[], next: SettlementRequest): SettlementRequest[] {
  const idx = list.findIndex((r) => r.id === next.id);
  if (idx === -1) return [next, ...list];
  const copy = list.slice();
  copy[idx] = next;
  return copy;
}

// Every server-side settlement write moves loans, repayment rows, possibly an
// account, and EMI coverage. emi_schedules is on neither realtime transport,
// so it has to be reloaded explicitly or LoanDetail shows stale instalments.
// Best-effort: the money is already committed; a failed refresh is reported,
// never thrown back at the user.
async function reloadMoneyAfterSettlement(feature: string, id: string): Promise<void> {
  try {
    await useLoanStore.getState().loadLoans();
    await useTransactionStore.getState().loadTransactions();
    await useAccountStore.getState().loadAccounts();
    await useEmiStore.getState().loadSchedules();
  } catch (err) {
    reportError(err, { feature, extra: { id } });
  }
}

export const useSettlementRequestStore = create<SettlementRequestState>((set, get) => ({
  ...INITIAL,

  reset: () => set(INITIAL),

  loadRequests: async () => {
    set({ loading: true });
    try {
      const requests = await settlementRequestsDb.getAll();
      set({ requests });
    } finally {
      set({ loading: false });
    }
  },

  createRequest: async (input) => {
    const id = input.requestId ?? uuid();
    try {
      await settlementRequestsDb.insert({
        id,
        loanPairId: input.loanPairId,
        requesterLoanId: input.requesterLoanId,
        responderLoanId: input.responderLoanId,
        toUserId: input.toUserId,
        amount: input.amount,
        currency: input.currency,
        note: input.note ?? '',
        requesterAccountId: input.requesterAccountId ?? null,
      });
    } catch (err) {
      // Idempotent create (audit F-8): a primary-key collision on OUR intent
      // id means this exact request already landed (double tap, or a retry
      // after an ambiguous failure). Fall through to the reload and return the
      // row that exists; a 23505 from any other constraint still throws below
      // because the id lookup finds nothing.
      if (!isDuplicateKeyError(err)) {
        // linked_settlement_requests carried the same AED/PKR-only currency
        // CHECK (audit F-MIG2 / H6, widened by
        // supabase-migration-audit-p0-currencies.sql). If this build meets a
        // database without that migration, translate the raw SQLSTATE 23514
        // instead of showing the Postgres string. Covers SettleLinkedLoanModal
        // and the bulk AllocateSettlementModal loop.
        // Report the RAW error: the translation below deliberately hides the
        // SQLSTATE from the user, which also hid a missing migration from us.
        reportError(err, { feature: 'settlementRequestStore.createRequest', extra: { requestId: id } });
        throw translateLinkedWriteError(err, 'settlement');
      }
    }
    await get().loadRequests();
    const inserted = get().requests.find((r) => r.id === id);
    if (!inserted) throw new Error('Settlement request created but could not be reloaded');
    return inserted;
  },

  recordReceived: async (input) => {
    const id = input.requestId ?? uuid();
    let recorded: SettlementRequest | null = null;
    try {
      recorded = await settlementRequestsDb.recordReceived({
        id,
        loanPairId: input.loanPairId,
        requesterLoanId: input.requesterLoanId,
        responderLoanId: input.responderLoanId,
        toUserId: input.toUserId,
        amount: input.amount,
        currency: input.currency,
        note: input.note ?? '',
        requesterAccountId: input.requesterAccountId,
      });
    } catch (err) {
      // Same idempotency contract as createRequest: our intent id already
      // exists ⇒ this exact record landed on an earlier (double) fire.
      if (!isDuplicateKeyError(err)) {
        reportError(err, { feature: 'settlementRequestStore.recordReceived', extra: { requestId: id } });
        throw translateLinkedWriteError(err, 'settlement');
      }
    }
    if (recorded) {
      const row = recorded;
      set((s) => ({ requests: upsert(s.requests, row) }));
    }
    // The money is committed server-side; a failed refresh must not read as a
    // failed record (a retry would then duplicate-key harmlessly anyway).
    try {
      await get().loadRequests();
    } catch (err) {
      reportError(err, { feature: 'settlementRequestStore.recordReceived.requests', extra: { requestId: id } });
    }
    await reloadMoneyAfterSettlement('settlementRequestStore.recordReceived.reload', id);
    const row = get().requests.find((r) => r.id === id) ?? recorded;
    if (!row) throw new Error('Repayment recorded but could not be reloaded');
    return row;
  },

  applyNow: async (requestId) => {
    const updated = await settlementRequestsDb.applyNow(requestId);
    set((s) => ({ requests: upsert(s.requests, updated) }));
    await reloadMoneyAfterSettlement('settlementRequestStore.applyNow.reload', requestId);
    return updated;
  },

  undo: async (requestId) => {
    const updated = await settlementRequestsDb.undo(requestId);
    set((s) => ({ requests: upsert(s.requests, updated) }));
    await reloadMoneyAfterSettlement('settlementRequestStore.undo.reload', requestId);
    return updated;
  },

  attachAccount: async (txnId, accountId) => {
    const balance = await settlementRequestsDb.attachAccount(txnId, accountId);
    // Adopt the balance the SERVER computed at once (never recompute it
    // locally), then reload so the request's account line and the
    // transaction's leg catch up too.
    useAccountStore.setState((s) => ({
      accounts: s.accounts.map((a) =>
        a.id === accountId ? { ...a, balance, updatedAt: new Date().toISOString() } : a,
      ),
    }));
    try {
      await get().loadRequests();
    } catch (err) {
      reportError(err, { feature: 'settlementRequestStore.attachAccount.requests', extra: { txnId } });
    }
    await reloadMoneyAfterSettlement('settlementRequestStore.attachAccount.reload', txnId);
    // Account ids are not tracked by record_edits, so leave a trail here.
    // Post-commit and best-effort, like loanStore's derived activity rows.
    try {
      const account = useAccountStore.getState().accounts.find((a) => a.id === accountId);
      const txn = useTransactionStore.getState().transactions.find((t) => t.id === txnId);
      const what = txn ? `${txn.currency} ${txn.amount}` : 'a repayment';
      await useActivityStore.getState().logActivity(
        'transaction_modified',
        `Repayment of ${what} added to ${account?.name ?? 'an account'}`,
        txnId,
        'transaction',
      );
    } catch (err) {
      reportError(err, { feature: 'settlementRequestStore.attachAccount.activity', extra: { txnId } });
    }
    return balance;
  },

  accept: async (requestId, responderAccountId) => {
    const updated = await settlementRequestsDb.accept(requestId, responderAccountId ?? null);
    set((s) => ({ requests: upsert(s.requests, updated) }));
    // Unconditionally refresh accounts (a no-op for ledger-only settlements;
    // picks up the sender's opted-in effect and the receiver's landing
    // account chosen just now) — and EMIs, which accept marks paid
    // server-side.
    await reloadMoneyAfterSettlement('settlementRequestStore.accept.reload', requestId);
    return updated;
  },

  reject: async (requestId, reason) => {
    const updated = await settlementRequestsDb.reject(requestId, reason);
    set((s) => ({ requests: upsert(s.requests, updated) }));
    return updated;
  },

  cancel: async (requestId) => {
    const updated = await settlementRequestsDb.cancel(requestId);
    set((s) => ({ requests: upsert(s.requests, updated) }));
    return updated;
  },

  byLoanPair: (loanPairId) =>
    get().requests.filter((r) => r.loanPairId === loanPairId),

  incomingPending: (myUserId) =>
    get().requests.filter((r) => r.status === 'pending' && r.toUserId === myUserId),

  outgoingPending: (myUserId) =>
    get().requests.filter((r) => r.status === 'pending' && r.fromUserId === myUserId),
}));
