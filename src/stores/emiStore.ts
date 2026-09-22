import { create } from 'zustand';
import { emiSchedulesDb } from '../lib/supabaseDb';
import type { EmiSchedule, EmiStatus } from '../db';
import { useActivityStore } from './activityStore';
import { uncoveredToPaidIds } from '../lib/emiCoverage';
import { planEmiRows } from '../lib/emiPlan';
import { reportError } from '../lib/errorReporter';

interface GenerateEmiInput {
  loanId: string;
  totalAmount: number;
  installments: number;
  startDate: string;
  // Statement-native cash advances pass explicit instalment due-dates anchored
  // to the funding card's statement day (statementInstalmentDates). When
  // present these win over startDate — a card instalment is billed on the
  // card's statement day, never a free-typed date. Human loans omit it and
  // keep the monthly-from-startDate behaviour.
  dueDates?: string[];
}

interface EmiState {
  schedules: EmiSchedule[];
  loading: boolean;
  loadSchedules: () => Promise<void>;
  generateSchedule: (input: GenerateEmiInput) => Promise<void>;
  markPaid: (emiId: string) => Promise<void>;
  markAllPaidForLoan: (loanId: string) => Promise<void>;
  // Reconcile-only: flip instalments already covered by money repaid (no money
  // moves). Returns how many it marked. Used to fix a schedule that desynced
  // from the loan's paid-down balance.
  reconcileCovered: (loanId: string, paidAmount: number) => Promise<number>;
  // Per-card migration: re-date a cash advance's unpaid instalments onto the
  // funding card's statement day (date-only, no money moves).
  reanchorToStatementDay: (loanId: string, updates: Array<{ id: string; newDue: string }>) => Promise<number>;
  deleteByLoan: (loanId: string) => Promise<void>;
  getByLoan: (loanId: string) => EmiSchedule[];
  reset: () => void;
}

const INITIAL_EMI_STATE = {
  schedules: [] as EmiSchedule[],
  loading: false,
};

export const useEmiStore = create<EmiState>((set, get) => ({
  ...INITIAL_EMI_STATE,

  reset: () => set(INITIAL_EMI_STATE),

  loadSchedules: async () => {
    set({ loading: true });
    try {
      const schedules = await emiSchedulesDb.getAll();
      set({ schedules });
    } finally {
      set({ loading: false });
    }
  },

  // COMPUTE + WRITE. The computation itself lives in src/lib/emiPlan.ts as a
  // pure function so the atomic loan-create path (L4 step 3) can plan the same
  // rows BEFORE the loan exists and hand them to `create_loan_with_leg` as
  // `p_emi`, inside the same Postgres transaction. This method is the legacy
  // half — same arithmetic, same ids, same order, just delegated — and stays
  // the only path in ledger-only (splits_only) mode, which has no RPC.
  generateSchedule: async (input) => {
    const entries: EmiSchedule[] = planEmiRows({
      totalAmount: input.totalAmount,
      installments: input.installments,
      startDate: input.startDate,
      dueDates: input.dueDates,
    }).map((row) => ({
      id: row.id,
      loanId: input.loanId,
      installmentNumber: row.installmentNumber,
      dueDate: row.dueDate,
      amount: row.amount,
      status: 'upcoming' as EmiStatus,
    }));
    await emiSchedulesDb.bulkAdd(entries);
    set((s) => ({ schedules: [...s.schedules, ...entries] }));
  },

  // Apply a planned re-anchor of a cash advance's instalments onto a card's
  // statement day (the per-card migration). The plan comes from the pure
  // planStatementReanchor (src/lib/cardStatement.ts), which already froze
  // paid and already-billed instalments and kept the months monotonic. This
  // write re-checks the live rows as a last guard: a row that is gone, now
  // paid, or already on the target date is skipped. Date-only: no money
  // changes. Returns how many instalments were actually re-dated.
  reanchorToStatementDay: async (loanId, planned) => {
    const live = new Map(
      get().schedules.filter((e) => e.loanId === loanId).map((e) => [e.id, e]),
    );
    const updates = planned.filter((u) => {
      const row = live.get(u.id);
      return !!row && row.status !== 'paid' && !!u.newDue && u.newDue !== row.dueDate;
    });
    if (updates.length === 0) return 0;
    await Promise.all(updates.map((u) => emiSchedulesDb.setDueDate(u.id, u.newDue)));
    const byId = new Map(updates.map((u) => [u.id, u.newDue]));
    set((s) => ({
      schedules: s.schedules.map((e) => (byId.has(e.id) ? { ...e, dueDate: byId.get(e.id)! } : e)),
    }));
    return updates.length;
  },

  markPaid: async (emiId) => {
    await emiSchedulesDb.update(emiId, { status: 'paid' as EmiStatus });
    set((s) => ({
      schedules: s.schedules.map((e) => (e.id === emiId ? { ...e, status: 'paid' as EmiStatus } : e)),
    }));
    const emi = get().schedules.find((e) => e.id === emiId);
    if (emi) {
      await useActivityStore.getState().logActivity(
        'emi_paid',
        `EMI #${emi.installmentNumber} paid`,
        emi.loanId,
        'loan'
      );
    }
  },

  markAllPaidForLoan: async (loanId) => {
    const pendingSchedules = get().schedules.filter(
      (schedule) => schedule.loanId === loanId && schedule.status !== 'paid'
    );

    if (pendingSchedules.length === 0) return;

    await Promise.all(
      pendingSchedules.map((schedule) =>
        emiSchedulesDb.update(schedule.id, { status: 'paid' as EmiStatus })
      )
    );

    set((s) => ({
      schedules: s.schedules.map((schedule) =>
        schedule.loanId === loanId && schedule.status !== 'paid'
          ? { ...schedule, status: 'paid' as EmiStatus }
          : schedule
      ),
    }));

    await useActivityStore.getState().logActivity(
      'emi_paid',
      pendingSchedules.length === 1
        ? `EMI #${pendingSchedules[0].installmentNumber} paid`
        : `${pendingSchedules.length} EMIs marked paid after full repayment`,
      loanId,
      'loan'
    );
  },

  reconcileCovered: async (loanId, paidAmount) => {
    const ids = uncoveredToPaidIds(
      get().schedules.filter((e) => e.loanId === loanId),
      paidAmount,
    );
    if (ids.length === 0) return 0;
    const idSet = new Set(ids);
    await Promise.all(ids.map((id) => emiSchedulesDb.update(id, { status: 'paid' as EmiStatus })));
    set((s) => ({
      schedules: s.schedules.map((e) => (idSet.has(e.id) ? { ...e, status: 'paid' as EmiStatus } : e)),
    }));
    // Activity log is best-effort — the status is already persisted and a log
    // failure must not surface as a failed reconcile.
    try {
      await useActivityStore.getState().logActivity(
        'emi_paid',
        ids.length === 1
          ? 'Instalment reconciled to a payment already made'
          : `${ids.length} instalments reconciled to payments already made`,
        loanId,
        'loan',
      );
    } catch (err) {
      reportError(err, { feature: 'emiStore.reconcileCovered.logActivity', extra: { loanId, count: ids.length } });
    }
    return ids.length;
  },

  deleteByLoan: async (loanId) => {
    await emiSchedulesDb.deleteByLoan(loanId);
    set((s) => ({
      schedules: s.schedules.filter((schedule) => schedule.loanId !== loanId),
    }));
  },

  getByLoan: (loanId) => get().schedules.filter((e) => e.loanId === loanId).sort((a, b) => a.installmentNumber - b.installmentNumber),
}));
