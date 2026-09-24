import { create } from 'zustand';
import { v4 as uuid } from 'uuid';
import { db } from '../db';
import { loansDb, transactionsDb } from '../lib/supabaseDb';
import { loadCacheFirst, markMirrorStale, mirrorDelete, mirrorPut } from '../lib/mirrorCache';
import { assertLinkedLoanEditAllowed, assertLinkedLoanDeleteAllowed, linkedPairIdForLoan } from '../lib/linkedLoanGuards';
import { runSafeMutation } from '../lib/mutationSafety';
import {
  applyLoanRemainingDelta,
  clampRepaymentAmount,
  round2,
  type LoanRemainingDeltaDeps,
} from '../lib/loanRemainingDelta';
import { reportError } from '../lib/errorReporter';
import { tStatic } from '../lib/i18n';
import type { Loan, LoanType, Currency, Transaction } from '../db';
import { useActivityStore } from './activityStore';
import { useLinkedRequestStore } from './linkedRequestStore';
import { useEmiStore } from './emiStore';

export interface CreateLoanInput {
  personName: string;
  personId?: string | null;
  type: LoanType;
  totalAmount: number;
  currency: Currency;
  notes?: string;
}

interface LoanState {
  loans: Loan[];
  loading: boolean;
  loadLoans: () => Promise<void>;
  createLoan: (input: CreateLoanInput) => Promise<Loan>;
  applyRepayment: (loanId: string, amount: number, notes?: string) => Promise<void>;
  updateLoan: (loanId: string, changes: Partial<Loan>) => Promise<void>;
  deleteLoan: (loanId: string) => Promise<void>;
  getLoan: (id: string) => Loan | undefined;
  reset: () => void;
}

const INITIAL_LOAN_STATE = {
  loans: [] as Loan[],
  loading: false,
};

// ─────────────────────────────────────────────────────────────────────────
// Optimistic-locked remainingAmount plumbing (audit 2026-09 C10 / F-2).
//
// remainingAmount is NEVER written absolutely any more. Every change goes
// through apply_loan_remaining_delta, the loan twin of
// apply_account_balance_delta: the server applies `remaining + delta` only if
// our expected value still matches, so two devices repaying the same loan can
// no longer lose one another's update while both payment records survive.
// ─────────────────────────────────────────────────────────────────────────

// Push an authoritative remaining amount into local state + mirror, deriving
// status the same way the RPC does so the two never disagree.
//
// Exported for transactionStore's tracked* helpers (the full_tracker half of
// the same flow) so both stores derive status identically — a second copy of
// this rule is a second place for the two columns to drift apart.
export function syncLocalRemaining(loanId: string, remaining: number): void {
  const status: Loan['status'] = remaining === 0 ? 'settled' : 'active';
  const updatedAt = new Date().toISOString();
  useLoanStore.setState((s) => ({
    loans: s.loans.map((l) =>
      l.id === loanId ? { ...l, remainingAmount: remaining, status, updatedAt } : l,
    ),
  }));
  const next = useLoanStore.getState().loans.find((l) => l.id === loanId);
  if (next) {
    void mirrorPut(db.loans, next);
    markMirrorStale('loans');
  }
}

// Exported for the same reason as syncLocalRemaining: transactionStore's
// full_tracker repayment leg must talk to the identical RPC + refetch ladder,
// including the localized conflict messages the UI toasts.
export function loanDeltaDeps(loanId: string): LoanRemainingDeltaDeps {
  return {
    applyDelta: (expected, delta) => loansDb.applyRemainingDelta(loanId, expected, delta),
    // Conflict path: re-read the row so the single retry uses server truth and
    // the UI stops showing the stale figure the user just failed against.
    refetchRemaining: async () => {
      const fresh = await loansDb.get(loanId);
      if (!fresh) {
        useLoanStore.setState((s) => ({ loans: s.loans.filter((l) => l.id !== loanId) }));
        await mirrorDelete(db.loans, loanId);
        markMirrorStale('loans');
        return null;
      }
      syncLocalRemaining(loanId, fresh.remainingAmount);
      return fresh.remainingAmount;
    },
    conflictMessage: tStatic('err_loan_changed_elsewhere'),
    missingMessage: tStatic('err_loan_gone'),
  };
}

// Rollback couldn't fully undo — local state may now disagree with remote on
// BOTH the loan and its repayment row. Re-pull both from truth (the narrow
// twin of transactionStore's refetchMoneyStores; dynamic import because
// transactionStore statically imports this module).
async function refetchAfterFailedRollback(): Promise<void> {
  try {
    const { useTransactionStore } = await import('./transactionStore');
    await Promise.all([
      useLoanStore.getState().loadLoans(),
      useTransactionStore.getState().loadTransactions(),
    ]);
  } catch (err) {
    reportError(err, { feature: 'loanStore.refetchAfterFailedRollback' });
  }
}

// `Loan.loanPairId` is mapped from loans.loan_pair_id, a column no migration
// ever created — it is always null, so the linked-loan guards never fired
// until 2026-09-24. The pair lives on the accepted linked-request row; derive
// it from there at guard time. (Read lazily: linkedRequestStore imports this
// store, so the lookup must stay inside a function.)
export function withLinkedPair(loan: Loan): Loan {
  if (loan.loanPairId) return loan;
  const loanPairId = linkedPairIdForLoan(loan.id, useLinkedRequestStore.getState().requests);
  return loanPairId ? { ...loan, loanPairId } : loan;
}

export const useLoanStore = create<LoanState>((set, get) => ({
  ...INITIAL_LOAN_STATE,

  reset: () => set(INITIAL_LOAN_STATE),

  loadLoans: async () => {
    set({ loading: true });
    try {
      const { rows: loans } = await loadCacheFirst({
        key: 'loans',
        table: db.loans,
        fetchRemote: loansDb.getAll,
        fetchUpdatedSince: loansDb.getUpdatedSince,
        fetchDeletedSince: loansDb.getDeletedSince,
        getUpdatedAt: (loan) => loan.updatedAt ?? loan.createdAt,
        sort: (a, b) => b.createdAt.localeCompare(a.createdAt),
        // A background refresh used to land in Dexie only, leaving the store
        // rendering the pre-refresh snapshot (audit 04-supabase F-RT1).
        onRefreshed: (rows) => set({ loans: rows }),
      });
      set({ loans });
    } finally {
      set({ loading: false });
    }
  },

  createLoan: async (input) => {
    const loan: Loan = {
      id: uuid(),
      personName: input.personName,
      personId: input.personId ?? null,
      type: input.type,
      totalAmount: input.totalAmount,
      remainingAmount: input.totalAmount,
      currency: input.currency,
      status: 'active',
      notes: input.notes ?? '',
      createdAt: new Date().toISOString(),
    };
    loan.updatedAt = loan.createdAt;
    await loansDb.add(loan);
    await mirrorPut(db.loans, loan);
    markMirrorStale('loans');
    set((s) => ({ loans: [...s.loans, loan] }));
    await useActivityStore.getState().logActivity(
      'loan_created',
      `Loan ${input.type === 'given' ? 'given to' : 'taken from'} ${input.personName}: ${input.currency} ${input.totalAmount}`,
      loan.id,
      'loan'
    );
    return loan;
  },

  // Ledger-mode (splits_only) repayment — and the money-free "settle without
  // payment" write-off in both modes. The tracker path goes through
  // processTransaction instead.
  //
  // Audit 2026-09 F-3 / R-3: this used to mutate remainingAmount FIRST and then
  // write the transaction row + activity entry best-effort inside try/catch.
  // A network blip after the balance write left a changed loan with no record
  // anywhere — the documented 2026-07-18 "vanished payment records" incident
  // (tasks/lessons.md:6-13) in a quieter form, and the caller saw success so
  // not even the "N of M" batch toast fired.
  //
  // The record is no longer optional. Everything below runs inside one
  // MutationScope, in this order:
  //   1. transaction row (the record)   — compensated by delete
  //   2. loans.remainingAmount delta    — compensated by the inverse delta
  //   3. activity entry                 — last, so nothing needs to undo it
  // Any failure unwinds the earlier steps, so the outcome is always either
  // "record + balance + activity" or "nothing at all". Never a moved balance
  // with no trace.
  applyRepayment: async (loanId, amount, notes) => {
    const loan = get().loans.find((l) => l.id === loanId);
    if (!loan) throw new Error(`Loan ${loanId} not found`);

    // Clamp to what the loan can absorb BEFORE writing anything, so the amount
    // stamped on the record always equals the amount the loan actually moves
    // (the server clamps too; this keeps the two from ever disagreeing).
    const applied = clampRepaymentAmount(amount, loan.remainingAmount);
    if (applied <= 0) throw new Error(tStatic('err_repayment_amount_invalid'));

    const createdAt = new Date().toISOString();
    // Pure record: BOTH account ids are null by design in ledger mode (no
    // accounts exist) and for write-offs. Every path over transactions must
    // tolerate that — tasks/lessons.md:26-27.
    const record: Transaction = {
      id: uuid(),
      type: 'repayment',
      amount: applied,
      currency: loan.currency,
      sourceAccountId: null,
      destinationAccountId: null,
      relatedPerson: loan.personName,
      personId: loan.personId ?? null,
      relatedLoanId: loanId,
      relatedGoalId: null,
      conversionRate: null,
      category: '',
      notes: notes?.trim() ?? '',
      createdAt,
    };

    const { newRemaining } = await runSafeMutation(async (scope) => {
      // ── STEP 1 (required): the record lands first ───────────────────────
      // Dynamic import: transactionStore statically imports this store, so a
      // static import back would create a module cycle.
      const { useTransactionStore } = await import('./transactionStore');
      await transactionsDb.add(record);
      scope.register(async () => {
        await transactionsDb.delete(record.id);
        await mirrorDelete(db.transactions, record.id);
        markMirrorStale('transactions');
        useTransactionStore.setState((s) => ({
          transactions: s.transactions.filter((t) => t.id !== record.id),
        }));
      });
      await mirrorPut(db.transactions, record);
      markMirrorStale('transactions');
      useTransactionStore.setState((s) => ({ transactions: [record, ...s.transactions] }));

      // ── STEP 2 (required): optimistic-locked balance change ─────────────
      const deps = loanDeltaDeps(loanId);
      const result = await applyLoanRemainingDelta(
        {
          expectedRemaining: loan.remainingAmount,
          delta: -applied,
          // Only retry a conflict if the refetched loan can still take the
          // full amount — otherwise the record would overstate the reduction.
          requireRemainingAtLeast: applied,
        },
        deps,
      );
      scope.register(async () => {
        const reversed = await applyLoanRemainingDelta(
          { expectedRemaining: result.newRemaining, delta: applied },
          deps,
        );
        syncLocalRemaining(loanId, reversed.newRemaining);
      });
      syncLocalRemaining(loanId, result.newRemaining);

      // ── STEP 3 (required): the activity entry ───────────────────────────
      // Deliberately last and deliberately NOT best-effort: an activity row
      // cannot be deleted (activitiesDb has no delete), so it must be the step
      // nothing else has to unwind. If it fails, steps 2 and 1 roll back and
      // the user retries a clean slate.
      await useActivityStore.getState().logActivity(
        'transaction_created',
        loan.type === 'given'
          ? `Received ${loan.currency} ${applied} from ${loan.personName}`
          : `Repaid ${loan.currency} ${applied} to ${loan.personName}`,
        record.id,
        'transaction',
      );

      return result;
    }, refetchAfterFailedRollback, 'loanStore.applyRepayment');

    // ── Post-commit, best-effort ──────────────────────────────────────────
    // The money and its record are committed; these are derived/decorative and
    // must never fail the repayment retroactively.
    if (newRemaining === 0) {
      try {
        await useActivityStore.getState().logActivity(
          'loan_settled',
          `Loan with ${loan.personName} fully settled`,
          loanId,
          'loan',
        );
      } catch (err) {
        reportError(err, { feature: 'loanStore.applyRepayment.settledActivity' });
      }
    }
    // Ledger-only path bypasses processTransaction, so reconcile any EMI
    // schedule to the new paid-down balance here too — otherwise a partial (or
    // even full) repayment would orphan the schedule. Self-healing on the next
    // reconcile, hence best-effort.
    try {
      await useEmiStore.getState().reconcileCovered(
        loanId,
        round2(loan.totalAmount - newRemaining),
      );
    } catch (err) {
      reportError(err, { feature: 'loanStore.applyRepayment.reconcileCovered' });
    }
  },

  updateLoan: async (loanId, changes) => {
    const loan = get().loans.find((l) => l.id === loanId);
    if (!loan) throw new Error(`Loan ${loanId} not found`);
    // A mirrored (linked) loan can't have its currency/amount changed on one
    // side — that would diverge from the other user's copy.
    assertLinkedLoanEditAllowed(withLinkedPair(loan), changes);

    // remainingAmount is the one column that can be raced across devices, so
    // even an absolute edit (loan amount changed, repayment deleted — the
    // callers in transactionStore) is translated into an expected+delta write
    // against apply_loan_remaining_delta. Everything else is a plain update.
    // Note the delta framing survives a conflict retry deliberately: if another
    // device paid 200 while this edit was in flight, "set remaining to 1500"
    // lands as 1300, keeping their payment instead of clobbering it.
    const { remainingAmount, ...otherChanges } = changes;
    let nextRemaining = loan.remainingAmount;
    let nextStatus = loan.status;

    if (remainingAmount !== undefined && round2(remainingAmount) !== round2(loan.remainingAmount)) {
      const result = await applyLoanRemainingDelta(
        {
          expectedRemaining: loan.remainingAmount,
          delta: round2(remainingAmount) - round2(loan.remainingAmount),
        },
        loanDeltaDeps(loanId),
      );
      nextRemaining = result.newRemaining;
      nextStatus = result.newRemaining === 0 ? 'settled' : 'active';
    }

    // The caller's explicit status (if any) still wins — the RPC only derives
    // one so the two columns can't drift when nobody says otherwise.
    const nextLoan: Loan = {
      ...loan,
      ...changes,
      remainingAmount: nextRemaining,
      status: otherChanges.status ?? nextStatus,
      updatedAt: new Date().toISOString(),
    };

    if (Object.keys(otherChanges).length > 0) await loansDb.update(loanId, otherChanges);
    await mirrorPut(db.loans, nextLoan);
    markMirrorStale('loans');
    set((s) => ({
      loans: s.loans.map((l) => (l.id === loanId ? nextLoan : l)),
    }));
  },

  deleteLoan: async (loanId) => {
    const existing = get().loans.find((l) => l.id === loanId);
    if (existing) assertLinkedLoanDeleteAllowed(withLinkedPair(existing));
    await loansDb.delete(loanId);
    await mirrorDelete(db.loans, loanId);
    markMirrorStale('loans');
    set((s) => ({
      loans: s.loans.filter((l) => l.id !== loanId),
    }));
  },

  getLoan: (id) => get().loans.find((l) => l.id === id),
}));
