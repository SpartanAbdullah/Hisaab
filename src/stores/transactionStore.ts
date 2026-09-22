import { create } from 'zustand';
import { v4 as uuid } from 'uuid';
import { db } from '../db';
import {
  transactionsDb, emiSchedulesDb, loansDb, goalsDb, groupExpensesDb,
  // L4 pilot — the atomic-transfer RPC gateway (flag-gated, see
  // ATOMIC_TRANSFER_ENABLED below) and the account refetch its retry needs.
  accountsDb, atomicMoneyDb, type AtomicTransferResult,
  // L4 step 2 — the atomic-repayment RPC result type (ATOMIC_REPAYMENT_ENABLED).
  type AtomicRepaymentResult,
  // L4 step 3 — the atomic loan-creation RPC result type
  // (ATOMIC_LOAN_CREATE_ENABLED).
  type AtomicLoanCreateResult,
  // L4 step 4 — the goal-contribution and card-bill RPC result types
  // (ATOMIC_GOAL_ENABLED / ATOMIC_CARD_BILL_ENABLED).
  type AtomicGoalContributionResult, type AtomicCardBillResult,
  // L4 step 5 — the single-leg and investment-trade RPC result types
  // (ATOMIC_SINGLE_LEG_ENABLED / ATOMIC_INVEST_ENABLED).
  type AtomicSingleLegResult, type AtomicInvestmentTradeResult,
  type SingleLegEntryType,
} from '../lib/supabaseDb';
import {
  clearMirrorCoverage, loadCacheFirst, markMirrorStale, mirrorBulkPut, mirrorDelete, mirrorPut,
  readMirrorCoverageSeed, writeMirrorCoverage,
} from '../lib/mirrorCache';
// The bounded-history contract: window arithmetic, the coverage lattice and the
// non-destructive merge. Pure + unit-tested (src/lib/historyWindow.test.ts).
import {
  HISTORY_MIN_ROWS,
  coverageSatisfies,
  emptyCoverage,
  fullCoverage,
  historyGap,
  mergeCoverage,
  mergeTransactionRows,
  oldestCreatedAt,
  planHistoryLoad,
  type HistoryCoverage,
  type HistoryRequest,
} from '../lib/historyWindow';
import { addMonths, format } from 'date-fns';
import type { Transaction, Currency, EmiSchedule, EmiStatus, Loan, ActivityType, InvestmentTrade } from '../db';
import { useAccountStore } from './accountStore';
import { useLoanStore, loanDeltaDeps, syncLocalRemaining, type CreateLoanInput } from './loanStore';
import { useGoalStore } from './goalStore';
import { useEmiStore } from './emiStore';
import { useActivityStore } from './activityStore';
import { useAppModeStore } from './appModeStore';
import { useInvestmentStore } from './investmentStore';
import { buildInternalNote, parseInternalNote } from '../lib/internalNotes';
import { tStatic } from '../lib/i18n';
import { statusSyncToPaid, uncoveredToPaidIds } from '../lib/emiCoverage';
import { clampCardCredit } from '../lib/cardCredit';
import { billAdvancesAsOf } from '../lib/cardStatement';
import { linkedBillPaymentRows, transferEditKeepsMoney } from '../lib/billPaymentEdit';
import { assertLinkedLoanDeleteAllowed } from '../lib/linkedLoanGuards';
import { simulateTimeline, validateTradeInput } from '../lib/investmentMath';
import { rateIsSane } from '../lib/conversionMath';
import { MAX_MONEY_MAGNITUDE, checkMoneyAmount, type MoneyAmountProblem } from '../lib/currencyValidation';
import { MutationScope, runSafeMutation } from '../lib/mutationSafety';
import { reportError } from '../lib/errorReporter';
import { applyLoanRemainingDelta, loanRemainingConflictError, round2 } from '../lib/loanRemainingDelta';
import {
  canRetryRepayment, planRepaymentEmiMarks, repaymentRetryFloor,
  type RepaymentEmiPlan,
} from '../lib/repaymentAtomicPlan';
import {
  planLoanCreateLegs, emiPlanProblem, toEmiPayload,
  type LoanDirection, type LoanEmiPlanPayloadRow,
} from '../lib/loanCreateAtomicPlan';
// L4 step 3 addendum — the instalment plan the pages compute BEFORE the RPC so
// the schedule rides into the same transaction as the loan (src/lib/emiPlan.ts).
import type { EmiPlanRow } from '../lib/emiPlan';
// L4 step 4 — the pure halves of the goal and credit-card engines.
import { planGoalContributionLegs } from '../lib/goalContributionPlan';
import {
  cardBillPlanExceedsPayment, planCardBillPrincipal, toCardBillPayload,
  type CardBillPlanLine,
} from '../lib/cardBillAtomicPlan';

interface BaseTransactionInput {
  amount: number;
  category?: string;
  notes?: string;
  createdAt?: string;
}

interface IncomeInput extends BaseTransactionInput {
  type: 'income';
  destinationAccountId: string;
}

interface ExpenseInput extends BaseTransactionInput {
  type: 'expense';
  sourceAccountId: string;
}

interface TransferInput extends BaseTransactionInput {
  type: 'transfer';
  sourceAccountId: string;
  destinationAccountId: string;
  conversionRate?: number;
}

/**
 * The instalment schedule to create WITH the loan, planned by the page with
 * `planEmiRows` (src/lib/emiPlan.ts).
 *
 * Honoured ONLY on the flagged atomic path, and only when the entry actually
 * creates a loan (no `loanId`). With the flag off it is ignored entirely and
 * the page keeps calling `emiStore.generateSchedule` afterwards, exactly as it
 * always has — see `loanScheduleAlreadyCreated`, which is how a page knows
 * which of the two happened.
 */
type LoanEmiPlanInput = { emiPlan?: EmiPlanRow[] | null };

interface LoanGivenInput extends BaseTransactionInput, LoanEmiPlanInput {
  type: 'loan_given';
  sourceAccountId: string;
  personName: string;
  personId?: string | null;
  loanId?: string;
}

interface LoanTakenInput extends BaseTransactionInput, LoanEmiPlanInput {
  type: 'loan_taken';
  destinationAccountId: string;
  personName: string;
  personId?: string | null;
  loanId?: string;
  sourceAccountId?: string;
}

interface RepaymentInput extends BaseTransactionInput {
  type: 'repayment';
  loanId: string;
  sourceAccountId?: string;
  destinationAccountId?: string;
  emiId?: string;
  conversionRate?: number;
}

interface GoalContributionInput extends BaseTransactionInput {
  type: 'goal_contribution';
  sourceAccountId: string;
  goalId: string;
  conversionRate?: number;
}

interface OpeningBalanceInput extends BaseTransactionInput {
  type: 'opening_balance';
  destinationAccountId: string;
}

// Set an account's balance to a known-true figure via a visible, reversible
// correction entry. The recovery hatch for drifted balances (e.g. a credit
// card mangled by historical double-credits) — no fake income/expense needed.
// `amount` on BaseTransactionInput is ignored; the engine derives the delta.
interface AdjustmentInput extends BaseTransactionInput {
  type: 'adjustment';
  accountId: string;
  targetBalance: number;
}

// Investment trades funded from (or credited to) a real account. The trade
// row itself is created INSIDE the mutation scope (trackedAddInvestmentTrade)
// so a failed money leg never leaves an orphan trade — loan_given precedent.
// `amount` on BaseTransactionInput is ignored for these; the engine computes
// the true cash amount from qty × price ± fees.
interface InvestmentTradeFields {
  marketId: string;
  symbol: string;
  companyName?: string;
  quantity: number;
  pricePerUnit: number;
  fees: number;
  tradedAt?: string;
}

interface InvestmentBuyInput extends BaseTransactionInput, InvestmentTradeFields {
  type: 'investment_buy';
  sourceAccountId: string;
  conversionRate?: number;
}

interface InvestmentSellInput extends BaseTransactionInput, InvestmentTradeFields {
  type: 'investment_sell';
  destinationAccountId: string;
  conversionRate?: number;
}

interface InvestmentDividendInput extends BaseTransactionInput {
  type: 'investment_dividend';
  destinationAccountId: string;
  marketId: string;
  symbol: string;
  grossAmount: number;
  fees: number;
  tradedAt?: string;
  conversionRate?: number;
}

export type TransactionInput =
  | IncomeInput
  | ExpenseInput
  | TransferInput
  | LoanGivenInput
  | LoanTakenInput
  | RepaymentInput
  | GoalContributionInput
  | OpeningBalanceInput
  | AdjustmentInput
  | InvestmentBuyInput
  | InvestmentSellInput
  | InvestmentDividendInput;

interface TransactionState {
  transactions: Transaction[];
  loading: boolean;
  /**
   * What the store PROVES it holds — see `src/lib/historyWindow.ts` for the
   * full contract. Screens read it to be honest about a partial view; screens
   * that must be complete call `ensureTransactionHistory` instead of guessing.
   */
  historyCoverage: HistoryCoverage;
  /** An `ensureTransactionHistory` fetch is in flight (older rows arriving). */
  historyLoading: boolean;
  /**
   * The default, BOUNDED load: the last 12 months or the newest 1000 rows,
   * whichever reaches further back (`historyWindow.ts` owns both numbers).
   *
   * `since` widens that floor for one call. The floor never narrows: a reload
   * after the user asked for full history still fetches full history.
   */
  loadTransactions: (options?: { since?: string | null }) => Promise<void>;
  /**
   * Page older rows in on demand and merge them into the store AND the mirror,
   * deleting nothing. Resolves immediately when coverage already answers the
   * request, so it is safe to call on every render path.
   *
   * `{ all: true }` — the whole history. Anything that must not compute on a
   * partial set (statements, the person backfill, the analytics fallback) uses
   * this and awaits it.
   * `{ since }` — everything from an instant onward. Cheaper; used when the
   * caller knows its own horizon (a date filter, the oldest open loan).
   */
  ensureTransactionHistory: (request?: HistoryRequest) => Promise<void>;
  processTransaction: (input: TransactionInput) => Promise<Transaction>;
  updateTransaction: (
    id: string,
    input: ExpenseInput | IncomeInput | TransferInput | LoanGivenInput | LoanTakenInput,
    options?: { allowLinkedGroupExpense?: boolean }
  ) => Promise<Transaction>;
  setReconciled: (id: string, isReconciled: boolean) => Promise<void>;
  // Attach/detach a receipt photo (storage path or null). Lightweight — patches
  // only receipt_path, never re-runs balance logic (unlike updateTransaction).
  setReceiptPath: (id: string, receiptPath: string | null) => Promise<void>;
  // Metadata-only category patch — no balance legs (payee-memory re-file).
  setCategory: (id: string, category: string) => Promise<void>;
  deleteTransaction: (id: string, options?: { allowLinkedGroupExpense?: boolean; allowInvestment?: boolean; allowNegative?: boolean }) => Promise<void>;
  // Remove a loan AND everything attached to it (repayments, origin entry,
  // EMI schedule), reversing every balance effect. The escape hatch for a
  // mis-entered loan that guards used to lock forever.
  deleteLoanCascade: (loanId: string, options?: { allowNegative?: boolean }) => Promise<void>;
  // Used by rollback paths that need to re-insert a transaction with its
  // original id and re-apply the matching balance delta. Not for general use.
  restoreTransaction: (snapshot: Transaction) => Promise<void>;
  getTransaction: (id: string) => Transaction | undefined;
  getByAccount: (accountId: string) => Transaction[];
  getByLoan: (loanId: string) => Transaction[];
  reset: () => void;
}

const INITIAL_TRANSACTION_STATE = {
  transactions: [] as Transaction[],
  loading: false,
  historyCoverage: emptyCoverage(),
  historyLoading: false,
};

// ── History coverage plumbing (audit P2 M2 / docs/performance.md §7) ────────
// One in-flight `ensureTransactionHistory` per shape, shared by every caller.
// Three screens mounting at once (Home + a statement sheet + the backfill) must
// cost one keyset walk, not three.
const inFlightHistory = new Map<string, Promise<void>>();

function historyRequestKey(request: HistoryRequest): string {
  return request.all ? 'all' : `since:${request.since ?? ''}`;
}

/** Merge fetched rows into the store without dropping anything it already had. */
function mergeHistoryIntoStore(rows: Transaction[]) {
  if (rows.length === 0) return;
  useTransactionStore.setState((s) => ({
    transactions: mergeTransactionRows(s.transactions, rows),
  }));
}

/** The `mirrorSync` key this store's rows and coverage floor live under. */
const TRANSACTIONS_MIRROR_KEY = 'transactions';

/**
 * Widen the store's claim by what a fetch just proved, and persist the result
 * so the next boot does not start from nothing (docs/performance.md §7.1).
 *
 * **Call this only after the fetched rows are in the mirror.** A floor written
 * before the merge lands would survive a merge that then failed — a claim about
 * rows that are not there, which is the one failure mode persisting a floor
 * must never introduce.
 *
 * The write REPLACES what is stored (see `writeMirrorCoverage`) rather than
 * widening it, so a session that started without trusting a stale floor cannot
 * resurrect it. It is skipped when nothing changed — a no-op load leaves the
 * stored floor exactly as it was.
 */
function adoptHistoryCoverage(earned: HistoryCoverage) {
  const before = useTransactionStore.getState().historyCoverage;
  const next = mergeCoverage(before, earned);
  if (next.since === before.since && next.complete === before.complete) return;
  useTransactionStore.setState({ historyCoverage: next });
  void writeMirrorCoverage(TRANSACTIONS_MIRROR_KEY, next);
}

type BalanceCheckedTransactionType = Extract<TransactionInput['type'], 'expense' | 'loan_given' | 'loan_taken' | 'repayment'>;
type BalanceCheckedAccount = { name: string; balance: number; type: string; metadata: Record<string, string> };

// Insufficient balance check helper (creation-time: spending money you don't
// have). Bilingual via tStatic — the old hardcoded Roman Urdu leaked to
// English users on every money surface.
function checkBalance(account: BalanceCheckedAccount, amount: number) {
  if (account.balance < amount) {
    throw new Error(
      tStatic('err_insufficient')
        .replace('{account}', account.name)
        .replace('{available}', account.balance.toLocaleString())
        .replace('{amount}', amount.toLocaleString()),
    );
  }
}

// Reversal-time balance guard. Unlike creation, a blocked reversal has a real
// escape: the user may confirm the account going negative (the credited money
// was since spent — reality already diverged, and a visible negative beats a
// permanently stuck row). The error carries a code + fields so the UI can
// offer exactly that retry with { allowNegative: true }.
export interface ReversalBlocked extends Error {
  code: 'REVERSAL_NEEDS_NEGATIVE';
  accountName: string;
  balanceAfter: number;
  accountCurrency: string;
}

function checkReversalBalance(
  account: BalanceCheckedAccount & { currency?: string },
  amount: number,
  allowNegative: boolean | undefined,
) {
  if (allowNegative) return;
  if (account.balance < amount) {
    const err = new Error(
      tStatic('err_reversal_spent')
        .replace(/\{account\}/g, account.name)
        .replace('{available}', account.balance.toLocaleString()),
    ) as ReversalBlocked;
    err.code = 'REVERSAL_NEEDS_NEGATIVE';
    err.accountName = account.name;
    err.balanceAfter = Math.round((account.balance - amount) * 100) / 100;
    err.accountCurrency = account.currency ?? '';
    throw err;
  }
}

function isSimpleModeBalanceBypassAllowed(transactionType: BalanceCheckedTransactionType): boolean {
  return useAppModeStore.getState().mode === 'splits_only'
    && (
      transactionType === 'expense'
      || transactionType === 'loan_given'
      || transactionType === 'loan_taken'
      || transactionType === 'repayment'
    );
}

function checkBalanceForTransaction(
  account: BalanceCheckedAccount,
  amount: number,
  transactionType: BalanceCheckedTransactionType,
) {
  // Simple mode is for recording reality, so these entries may intentionally
  // make an account negative. Full Money Tracker still uses strict validation.
  if (isSimpleModeBalanceBypassAllowed(transactionType)) return;
  checkBalance(account, amount);
}

async function ensureSupportingStoresLoaded() {
  const accountStore = useAccountStore.getState();
  const loanStore = useLoanStore.getState();
  const goalStore = useGoalStore.getState();
  const emiStore = useEmiStore.getState();

  // Audit 03-performance M11 / quick win #4: these four are independent
  // reads of four different tables, and awaiting them one after the other put
  // up to four serial round-trips (~1-2 s on 3G) in front of the FIRST save
  // after a cold boot — the exact interaction the product optimises for.
  // Running them together changes nothing else: no ordering existed between
  // them, and each still only runs when its store is empty. Rejections
  // propagate as before (Promise.all rejects with the first failure).
  const jobs: Promise<unknown>[] = [];
  if (accountStore.accounts.length === 0) jobs.push(accountStore.loadAccounts());
  if (loanStore.loans.length === 0) jobs.push(loanStore.loadLoans());
  if (goalStore.goals.length === 0) jobs.push(goalStore.loadGoals());
  if (emiStore.schedules.length === 0) jobs.push(emiStore.loadSchedules());
  if (jobs.length > 0) await Promise.all(jobs);
}

function isEditableTransactionType(type: Transaction['type']): type is 'expense' | 'income' | 'transfer' | 'loan_given' | 'loan_taken' {
  return type === 'expense' || type === 'income' || type === 'transfer' || type === 'loan_given' || type === 'loan_taken';
}

// Tracked mutation helpers. Each performs the forward write and registers its
// inverse on the scope. Inverses run LIFO on rollback. Every helper here is
// delta-based or snapshot-based so concurrent mutations commute.

// A mirror transaction is locked to its group expense ("edit it from the
// group screen") — but only while that group expense still EXISTS. Group
// deletion cascades the shared rows away server-side, and the old
// unconditional guard then locked every member's mirror forever. Only a
// CONFIRMED 0-row probe releases the mirror; probeExists throws on
// transport/auth failures, so a flaky connection keeps the guard (fail
// safe) instead of letting a live group's mirror slip out from under it.
async function groupExpenseStillExists(groupExpenseId: string): Promise<boolean> {
  try {
    return await groupExpensesDb.probeExists(groupExpenseId);
  } catch (err) {
    // Fail-safe: an unconfirmed probe keeps the mirror locked. Silent before
    // audit H1 — but a persistent probe failure is exactly why a member's
    // mirror row would look permanently un-deletable.
    reportError(err, {
      feature: 'transactionStore.groupExpenseStillExists.probeFailed',
      extra: { groupExpenseId },
    });
    return true;
  }
}

async function trackedBalanceDelta(scope: MutationScope, accountId: string, delta: number): Promise<void> {
  const accounts = useAccountStore.getState();
  await accounts.updateBalance(accountId, delta);
  scope.register(() => useAccountStore.getState().updateBalance(accountId, -delta));
}

// ═══════════════════════════════════════════════════════════════════════════
// SERVER-SIDE MONEY ENGINE — L4 pilot: the account→account transfer
//
// audit docs/audit-2026-09/07-mobile-first.md MF-01, 12-qa-review.md O-1/F-4,
// 00-executive-summary.md M1/L4. The two-leg client sequence above can commit
// leg 1, fail leg 2, and then fail its own compensation in the same outage —
// mutationSafety.ts:10-13 says so in its own header. `transfer_between_accounts`
// (supabase-migration-p3-atomic-transfer.sql) does both legs AND the row in one
// Postgres transaction, which is the only place that guarantee can live.
//
// OFF BY DEFAULT. The RPC does not exist until the user applies the migration,
// so the flag stays false and the legacy path below runs byte-for-byte
// unchanged. Rollout: docs/server-side-money-engine.md.
// ═══════════════════════════════════════════════════════════════════════════

const ATOMIC_TRANSFER_ENABLED = import.meta.env.VITE_ATOMIC_TRANSFER === 'true';

interface AtomicTransferLeg {
  transactionId: string;
  sourceAccountId: string;
  destinationAccountId: string;
  amount: number;
  destinationAmount: number;
  conversionRate: number | null;
  note: string;
  category: string;
  createdAt: string;
  /** Signed, already 2dp — what the source loses. Used only by the inverse. */
  sourceDelta: number;
  /** Signed, already 2dp — what the destination gains. Inverse only. */
  destinationDelta: number;
}

/** Adopt a balance the SERVER computed. Never recompute it locally. */
async function setKnownBalance(accountId: string, balance: number): Promise<void> {
  useAccountStore.setState((s) => ({
    accounts: s.accounts.map((a) =>
      a.id === accountId ? { ...a, balance, updatedAt: new Date().toISOString() } : a,
    ),
  }));
  const updated = useAccountStore.getState().accounts.find((a) => a.id === accountId);
  if (updated) await mirrorPut(db.accounts, updated);
  markMirrorStale('accounts');
}

/**
 * Call the atomic-transfer RPC and register the inverse for the rest of the
 * scope (the card-bill auto-settle still runs client-side after it).
 *
 * BALANCE_CONFLICT → refetch the accounts once and retry, the same ladder
 * accountStore.updateBalance already runs against the account CAS. Two
 * consecutive conflicts surface to the caller, exactly as they do today.
 *
 * The inverse is still a best-effort client compensation — but it now has only
 * ONE thing to undo instead of a half-applied pair, and the forward move can no
 * longer be partially committed, which is the failure MF-01 describes.
 */
async function atomicTransfer(scope: MutationScope, leg: AtomicTransferLeg): Promise<AtomicTransferResult> {
  const call = async (): Promise<AtomicTransferResult> => {
    const accounts = useAccountStore.getState();
    const src = accounts.getAccount(leg.sourceAccountId);
    const dest = accounts.getAccount(leg.destinationAccountId);
    if (!src || !dest) throw new Error('Account not found');
    return atomicMoneyDb.transferAtomic({
      transactionId: leg.transactionId,
      sourceAccountId: leg.sourceAccountId,
      destinationAccountId: leg.destinationAccountId,
      amount: leg.amount,
      destinationAmount: leg.destinationAmount,
      conversionRate: leg.conversionRate,
      note: leg.note,
      category: leg.category,
      createdAt: leg.createdAt,
      expectedSourceBalance: src.balance,
      expectedDestinationBalance: dest.balance,
      // Creation never goes negative — identical to checkBalance above, which
      // is applied to a credit-card source too (a card's balance is its
      // available credit). The escape belongs to the reversal path only.
      allowNegative: false,
    });
  };

  let result: AtomicTransferResult;
  try {
    result = await call();
  } catch (err) {
    if ((err as { code?: string })?.code !== 'BALANCE_CONFLICT') {
      reportError(err, {
        feature: 'transactionStore.atomicTransfer.rpcFailed',
        extra: { transactionId: leg.transactionId },
      });
      throw err;
    }
    // Another device/tab moved one of these accounts. Learn the truth, retry
    // once. A conflict means NOTHING moved, so there is nothing to compensate.
    const fresh = await accountsDb.getAll();
    useAccountStore.setState({ accounts: fresh });
    result = await call();
  }

  await setKnownBalance(leg.sourceAccountId, result.sourceBalance);
  await setKnownBalance(leg.destinationAccountId, result.destinationBalance);

  scope.register(async () => {
    // Reverse both legs through the account CAS (delta-based, so a concurrent
    // mutation commutes) and remove the row the server wrote. The tail's
    // trackedAddTransaction registers its own delete which runs first under
    // LIFO; deleting twice is a no-op.
    const accounts = useAccountStore.getState();
    await accounts.updateBalance(leg.sourceAccountId, -leg.sourceDelta);
    await useAccountStore.getState().updateBalance(leg.destinationAccountId, -leg.destinationDelta);
    await transactionsDb.delete(leg.transactionId);
    await mirrorDelete(db.transactions, leg.transactionId);
    markMirrorStale('transactions');
    useTransactionStore.setState((s) => ({
      transactions: s.transactions.filter((t) => t.id !== leg.transactionId),
    }));
  });

  return result;
}

// NOTE: these helpers deliberately bypass the store-level create/update
// methods and talk to the DB directly. The store methods embed
// await logActivity(...) after the real write, so any activity-log failure
// would throw AFTER the record was persisted, defeating compensation
// registration and leaving ghost records. Activity logging is treated here
// as best-effort (same policy as logActivitySafe).
async function trackedCreateLoan(scope: MutationScope, input: CreateLoanInput): Promise<Loan> {
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
  useLoanStore.setState(s => ({ loans: [...s.loans, loan] }));
  scope.register(async () => {
    await loansDb.delete(loan.id);
    await mirrorDelete(db.loans, loan.id);
    markMirrorStale('loans');
    useLoanStore.setState(s => ({ loans: s.loans.filter(l => l.id !== loan.id) }));
  });
  try {
    await useActivityStore.getState().logActivity(
      'loan_created',
      `Loan ${input.type === 'given' ? 'given to' : 'taken from'} ${input.personName}: ${input.currency} ${input.totalAmount}`,
      loan.id,
      'loan',
    );
  } catch (err) {
    reportError(err, { feature: 'transactionStore.trackedCreateLoan.logActivity', extra: { loanId: loan.id } });
  }
  return loan;
}

// Full-tracker repayment leg: knock `amount` off the loan's remaining balance.
//
// Audit 2026-09 C10 / F-2. This used to read the local snapshot, compute
// `Math.max(0, remaining - amount)` and write that ABSOLUTE figure — the loan
// twin of the account lost-update bug. Two devices repaying the same loan both
// read 2000, both wrote 1500, and one repayment vanished from the loan while
// BOTH transaction rows and BOTH account legs survived. Worse, the rollback
// path restored the snapshot ("set it back to 2000"), so a failed mutation on
// this device silently ERASED a concurrent repayment made on another.
//
// Both halves now go through apply_loan_remaining_delta (compare-and-swap,
// clamped at 0, status derived server-side), via the shared conflict ladder in
// src/lib/loanRemainingDelta.ts. A delta commutes: the inverse gives back
// exactly what this step took and leaves anyone else's concurrent change
// intact. On an unresolvable conflict the whole mutation throws — the account
// leg, the transaction row and the EMI marks all unwind together, so the user
// never ends up with a payment record the loan never absorbed.
async function trackedApplyRepayment(scope: MutationScope, loanId: string, amount: number): Promise<void> {
  const before = useLoanStore.getState().loans.find(l => l.id === loanId);
  if (!before) throw new Error(`Loan ${loanId} not found`);
  const prevStatus = before.status;
  const requested = round2(amount);
  // A zero/negative leg was a no-op under the old arithmetic (and the RPC
  // rejects a zero delta) — keep it a no-op rather than a new failure mode.
  if (!(requested > 0)) return;

  const deps = loanDeltaDeps(loanId);
  const result = await applyLoanRemainingDelta(
    {
      expectedRemaining: before.remainingAmount,
      // Not pre-clamped: the RPC's own GREATEST(0, …) reproduces the old
      // Math.max(0, …) exactly, so an overpayment still settles the loan
      // instead of driving it negative.
      delta: -requested,
      // Retry guard. After a conflict refetch we only replay when the fresh
      // loan can still absorb what we believed we were applying; otherwise the
      // account leg + transaction row would overstate the loan's reduction —
      // the corruption the lock exists to prevent.
      requireRemainingAtLeast: Math.min(requested, round2(before.remainingAmount)),
    },
    deps,
  );
  scope.register(async () => {
    // Give back exactly what moved (`applied`, not the requested amount — they
    // differ when the server clamp bit), expected-locked on the value our
    // forward write produced.
    if (result.applied === 0) return;
    const reversed = await applyLoanRemainingDelta(
      { expectedRemaining: result.newRemaining, delta: result.applied },
      deps,
    );
    syncLocalRemaining(loanId, reversed.newRemaining);
  });
  syncLocalRemaining(loanId, result.newRemaining);

  if (result.newRemaining === 0 && prevStatus !== 'settled') {
    try {
      await useActivityStore.getState().logActivity(
        'loan_settled',
        `Loan with ${before.personName} fully settled`,
        loanId,
        'loan',
      );
    } catch (err) {
      reportError(err, { feature: 'transactionStore.trackedApplyRepayment.settledActivity', extra: { loanId } });
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// SERVER-SIDE MONEY ENGINE — L4 step 2: the full-tracker loan repayment
//
// audit docs/audit-2026-09/07-mobile-first.md MF-01, 12-qa-review.md F-2/C-1
// and O-1/F-4, 00-executive-summary.md M1/L4.
//
// This is the branch the pilot's order table (docs/server-side-money-engine.md
// §6) rates highest-risk, because its legs span THREE tables and TWO different
// optimistic locks, each its own round-trip:
//     apply_account_balance_delta → apply_loan_remaining_delta →
//     N × emi_schedules status → transactions INSERT
// A drop after the first one leaves a moved balance, an unchanged loan and NO
// record of either. `record_loan_repayment`
// (supabase-migration-p3-atomic-repayment.sql) does all four in one Postgres
// transaction.
//
// OFF BY DEFAULT. The RPC does not exist until the user applies the migration,
// so the flag stays false and the legacy path runs byte-for-byte unchanged.
//
// NOT COVERED, deliberately: a repayment that also credits a cash-advance
// CREDIT CARD is a second account leg plus the clampCardCredit business rule,
// which this one-account RPC cannot express. The branch below keeps that case
// on the legacy path — see the artifact table in the migration header.
// ═══════════════════════════════════════════════════════════════════════════

const ATOMIC_REPAYMENT_ENABLED = import.meta.env.VITE_ATOMIC_REPAYMENT === 'true';

interface AtomicRepaymentLeg {
  transactionId: string;
  loanId: string;
  /** The single account: destination for a 'given' loan, source for 'taken'. */
  accountId: string;
  /** Loan-currency amount — what lands on the row. */
  amount: number;
  /** Account-currency amount: amount × rate (given) or amount ÷ rate (taken). */
  accountAmount: number;
  conversionRate: number | null;
  note: string;
  category: string;
  createdAt: string;
  /** The loan's remaining BEFORE this repayment — the CAS expectation. */
  remainingBefore: number;
  /** The loan's status BEFORE, so the settled activity fires exactly once. */
  statusBefore: Loan['status'];
  personName: string;
  loanTotalAmount: number;
  targetedEmiId?: string;
  /**
   * True only where the client's own checkBalanceForTransaction is a no-op —
   * splits_only mode (isSimpleModeBalanceBypassAllowed). Full tracker: false.
   */
  allowNegative: boolean;
}

/** Adopt a loan figure the SERVER computed, and mirror it. */
function adoptEmiMarks(marked: string[]): void {
  if (marked.length === 0) return;
  const ids = new Set(marked);
  useEmiStore.setState((s) => ({
    schedules: s.schedules.map((e) => (ids.has(e.id) ? { ...e, status: 'paid' as EmiStatus } : e)),
  }));
}

/**
 * Call the atomic-repayment RPC, adopt the server's figures, and register the
 * inverse for the rest of the scope.
 *
 * The retry ladder is the UNION of the two the legacy path already ran, and
 * keeps both of their rules:
 *   · BALANCE_CONFLICT       → refetch the accounts once and retry
 *                              (accountStore.updateBalance's ladder).
 *   · LOAN_REMAINING_CONFLICT→ refetch the loan once and retry, but ONLY when
 *                              the fresh remaining still covers the payment
 *                              (loanRemainingDelta.ts's requireRemainingAtLeast
 *                              floor). Retrying past that floor is how a 500
 *                              payment ends up reducing a 200 loan by 200 while
 *                              the row still says 500 — audit F-2 exactly.
 * A conflict means NOTHING moved, so there is nothing to compensate.
 */
async function atomicRepayment(scope: MutationScope, leg: AtomicRepaymentLeg): Promise<AtomicRepaymentResult> {
  const floor = repaymentRetryFloor(leg.amount, leg.remainingBefore);

  const call = async (expectedRemaining: number): Promise<{ result: AtomicRepaymentResult; planned: RepaymentEmiPlan; before: { id: string; status: EmiStatus }[] }> => {
    const account = useAccountStore.getState().getAccount(leg.accountId);
    if (!account) throw new Error('Account not found');
    const schedules = useEmiStore.getState().schedules.filter((e) => e.loanId === leg.loanId);
    // Recomputed on every attempt: after a conflict refetch the loan's
    // remaining has changed, so the coverage prefix has too.
    const planned = planRepaymentEmiMarks({
      schedules,
      loanTotalAmount: leg.loanTotalAmount,
      remainingBefore: expectedRemaining,
      amount: leg.amount,
      targetedEmiId: leg.targetedEmiId,
    });
    const beforeStatuses = schedules
      .filter((e) => planned.allIds.includes(e.id))
      .map((e) => ({ id: e.id, status: e.status }));
    const result = await atomicMoneyDb.repaymentAtomic({
      transactionId: leg.transactionId,
      loanId: leg.loanId,
      accountId: leg.accountId,
      amount: leg.amount,
      accountAmount: leg.accountAmount,
      conversionRate: leg.conversionRate,
      note: leg.note,
      category: leg.category,
      createdAt: leg.createdAt,
      expectedAccountBalance: account.balance,
      expectedLoanRemaining: expectedRemaining,
      emiScheduleIds: planned.allIds,
      allowNegative: leg.allowNegative,
    });
    return { result, planned, before: beforeStatuses };
  };

  const deps = loanDeltaDeps(leg.loanId);
  let attempt: Awaited<ReturnType<typeof call>>;
  try {
    attempt = await call(leg.remainingBefore);
  } catch (err) {
    const code = (err as { code?: string })?.code;
    if (code !== 'BALANCE_CONFLICT' && code !== 'LOAN_REMAINING_CONFLICT') {
      reportError(err, {
        feature: 'transactionStore.atomicRepayment.rpcFailed',
        extra: { transactionId: leg.transactionId, loanId: leg.loanId },
      });
      throw err;
    }
    // Learn the truth on BOTH sides — either lock may have been the stale one,
    // and a second attempt has to carry two fresh expectations.
    const fresh = await accountsDb.getAll();
    useAccountStore.setState({ accounts: fresh });
    // refetchRemaining also syncs local state and drops the loan when it is
    // gone (loanStore.loanDeltaDeps).
    const freshRemaining = await deps.refetchRemaining();
    if (freshRemaining === null || freshRemaining === undefined) {
      throw loanRemainingConflictError(deps.missingMessage);
    }
    if (!canRetryRepayment(freshRemaining, floor)) {
      throw loanRemainingConflictError(deps.conflictMessage);
    }
    attempt = await call(round2(freshRemaining));
  }

  const { result } = attempt;

  // Adopt SERVER truth everywhere. Never recompute it locally.
  await setKnownBalance(leg.accountId, result.accountBalance);
  syncLocalRemaining(leg.loanId, result.loanRemaining);
  adoptEmiMarks(result.emiMarked);

  const markedSet = new Set(result.emiMarked);
  const restore = attempt.before.filter((e) => markedSet.has(e.id));

  scope.register(async () => {
    // Reverse each leg the way the legacy path reverses it: the account
    // through its CAS (delta-based, so a concurrent mutation commutes), the
    // loan through apply_loan_remaining_delta with the amount that ACTUALLY
    // moved (`loanApplied`, not the requested amount — they differ when the
    // server clamp bit), the EMI rows back to their exact prior status
    // (including 'late'), and the row the server wrote away.
    if (result.accountDelta !== 0) {
      await useAccountStore.getState().updateBalance(leg.accountId, -result.accountDelta);
    }
    if (result.loanApplied !== 0) {
      const reversed = await applyLoanRemainingDelta(
        { expectedRemaining: result.loanRemaining, delta: result.loanApplied },
        deps,
      );
      syncLocalRemaining(leg.loanId, reversed.newRemaining);
    }
    if (restore.length > 0) {
      await Promise.all(restore.map((e) => emiSchedulesDb.update(e.id, { status: e.status })));
      useEmiStore.setState((s) => ({
        schedules: s.schedules.map((e) => {
          const prev = restore.find((r) => r.id === e.id);
          return prev ? { ...e, status: prev.status } : e;
        }),
      }));
    }
    // The tail's trackedAddTransaction registers its own delete, which runs
    // first under LIFO; deleting twice is a no-op.
    await transactionsDb.delete(leg.transactionId);
    await mirrorDelete(db.transactions, leg.transactionId);
    markMirrorStale('transactions');
    useTransactionStore.setState((s) => ({
      transactions: s.transactions.filter((t) => t.id !== leg.transactionId),
    }));
  });

  // ── Post-commit, best-effort. Byte-for-byte the entries the legacy helpers
  //    write, and in the same order: the targeted instalment first (its own
  //    'emi_paid' from trackedMarkEmiPaid), then the covered set (a second
  //    'emi_paid' from trackedMarkCoveredEmisPaid, which never includes the
  //    targeted one because it was already flipped), then 'loan_settled'.
  //    An activity failure must NEVER roll back money that has moved.
  const schedulesNow = useEmiStore.getState().schedules;
  const numberOf = (id: string) => schedulesNow.find((e) => e.id === id)?.installmentNumber;
  const targetedMarked = attempt.planned.targetedId && markedSet.has(attempt.planned.targetedId)
    ? attempt.planned.targetedId
    : null;
  const coveredMarked = attempt.planned.coveredIds.filter((id) => markedSet.has(id));

  if (targetedMarked) {
    try {
      await useActivityStore.getState().logActivity(
        'emi_paid', `EMI #${numberOf(targetedMarked)} paid`, leg.loanId, 'loan',
      );
    } catch (err) {
      reportError(err, { feature: 'transactionStore.atomicRepayment.emiActivity', extra: { loanId: leg.loanId } });
    }
  }
  if (coveredMarked.length > 0) {
    try {
      await useActivityStore.getState().logActivity(
        'emi_paid',
        coveredMarked.length === 1
          ? `EMI #${numberOf(coveredMarked[0])} paid`
          : `${coveredMarked.length} EMIs marked paid after repayment`,
        leg.loanId,
        'loan',
      );
    } catch (err) {
      reportError(err, { feature: 'transactionStore.atomicRepayment.emiActivity', extra: { loanId: leg.loanId } });
    }
  }
  if (result.loanRemaining === 0 && leg.statusBefore !== 'settled') {
    try {
      await useActivityStore.getState().logActivity(
        'loan_settled', `Loan with ${leg.personName} fully settled`, leg.loanId, 'loan',
      );
    } catch (err) {
      reportError(err, { feature: 'transactionStore.atomicRepayment.settledActivity', extra: { loanId: leg.loanId } });
    }
  }

  return result;
}

// ═══════════════════════════════════════════════════════════════════════════
// SERVER-SIDE MONEY ENGINE — L4 step 3: creating a loan
//
// audit docs/audit-2026-09/07-mobile-first.md MF-01, 12-qa-review.md O-1/F-4,
// 02-repository-architecture.md H-3/H-4, 00-executive-summary.md M1/L4.
//
// This is branch #4 in the pilot's order table
// (docs/server-side-money-engine.md §6), and the first that brings a new
// OBLIGATION into existence rather than only moving money:
//     loan_given  → balance CAS → loans INSERT → transactions INSERT
//     loan_taken  → [card CAS] → balance CAS → loans INSERT → transactions INSERT
// A drop after the first leg leaves a wallet lighter with no loan saying who
// owes it and no row saying it ever happened — and, for a cash advance, a card
// charged for money that arrived nowhere. `create_loan_with_leg`
// (supabase-migration-p3-atomic-loan-create.sql) does all of it in one
// Postgres transaction.
//
// OFF BY DEFAULT. The RPC does not exist until the user applies the migration,
// so the flag stays false and the legacy path runs byte-for-byte unchanged.
//
// THE EMI SCHEDULE — now covered (step 3 addendum). It used to be written by
// the PAGES, after processTransaction resolved and outside the MutationScope
// entirely, so a drop between the two left a funded loan with a missing
// schedule and nothing rolled back (migration query V7 counts the existing
// orphans). The pages now PLAN the rows first (`planEmiRows`, src/lib/emiPlan.ts)
// and pass them in as `input.emiPlan`; this branch forwards them as `p_emi` and
// the server inserts them in the SAME transaction. The page then skips its
// post-commit `generateSchedule` call — it asks `loanScheduleAlreadyCreated`
// rather than reading the flag, so the two halves can never both fire or both
// skip. With the flag off nothing here runs and the page's own call is still
// the only writer. Ledger-only (splits_only) never reaches any of this: it goes
// through loanStore.createLoan and keeps generating client-side.
// ═══════════════════════════════════════════════════════════════════════════

const ATOMIC_LOAN_CREATE_ENABLED = import.meta.env.VITE_ATOMIC_LOAN_CREATE === 'true';

/**
 * Did the loan's instalment schedule already land, inside the creation itself?
 *
 * The ONE question AddLoanModal / QuickEntry ask before deciding whether to
 * call `emiStore.generateSchedule`. Deliberately not "is the flag on": it reads
 * the actual outcome, so a plan that was dropped (an entry attaching to an
 * existing loan, a server that inserted nothing) still gets its client-side
 * schedule instead of silently getting none — the failure mode this whole step
 * exists to kill, reintroduced one level up.
 *
 * Always false with the flag off, which is what keeps the legacy path
 * byte-for-byte.
 */
export function loanScheduleAlreadyCreated(loanId: string | null | undefined): boolean {
  if (!ATOMIC_LOAN_CREATE_ENABLED || !loanId) return false;
  return useEmiStore.getState().schedules.some((e) => e.loanId === loanId);
}

interface AtomicLoanCreateLeg {
  transactionId: string;
  loanId: string;
  /** False when the entry attaches to a loan that already exists. */
  createLoan: boolean;
  direction: LoanDirection;
  personName: string;
  personId: string | null;
  /** Source for a loan given, destination for one taken. */
  accountId: string;
  /** The cash-advance credit card. `loan_taken` only, else null. */
  cardAccountId: string | null;
  amount: number;
  currency: Currency;
  note: string;
  category: string;
  createdAt: string;
  /** Loan.notes — the visible half only, exactly as trackedCreateLoan stores. */
  loanNotes: string;
  /**
   * The instalments to insert in the same transaction, already validated, or
   * null. Only ever set when `createLoan` is true — see the branch.
   */
  emiRows: EmiPlanRow[] | null;
  /**
   * True only where the client's own checkBalanceForTransaction is a no-op —
   * splits_only mode (isSimpleModeBalanceBypassAllowed). Full tracker: false.
   */
  allowNegative: boolean;
}

/**
 * The instalment plan, validated and converted to the wire shape — or a throw.
 *
 * Validating here as well as in the RPC is not redundancy: on 3G a refusal that
 * costs a round-trip is a refusal the user waits for, and the message has to be
 * the same either way. `emiPlanProblem` is the client's copy of the server's
 * own rules (src/lib/loanCreateAtomicPlan.ts) and the tokens are asserted equal.
 *
 * A plan is only ever attached to a loan this call CREATES. Attaching an entry
 * to a loan that already exists must not smuggle a second schedule onto it, and
 * the compensation below can only unwind instalments by deleting the whole
 * loan's schedule — safe for a loan born in this call, destructive for one that
 * was already there. Dropping the plan is safe because the page then sees
 * `loanScheduleAlreadyCreated === false` and generates it client-side.
 */
function prepareEmiPayload(
  rows: EmiPlanRow[] | null | undefined,
  loanAmount: number,
  createLoan: boolean,
): { rows: EmiPlanRow[] | null; payload: LoanEmiPlanPayloadRow[] | null } {
  if (!rows || rows.length === 0 || !createLoan) return { rows: null, payload: null };
  const problem = emiPlanProblem(rows, loanAmount);
  if (problem) {
    const err = new Error(tStatic('err_emi_plan_rejected')) as Error & { code: string };
    err.code = 'EMI_PLAN_REJECTED';
    reportError(err, {
      feature: 'transactionStore.atomicLoanCreate.emiPlanRefusedLocally',
      extra: { problem, count: rows.length, loanAmount },
    });
    throw err;
  }
  return { rows, payload: toEmiPayload(rows) };
}

/**
 * Call the loan-creation RPC, adopt the server's balances, materialise the loan
 * locally and register the inverse for the rest of the scope.
 *
 * BALANCE_CONFLICT → refetch the accounts once and retry, the same ladder
 * accountStore.updateBalance already runs against the account CAS. A conflict
 * means NOTHING was written — no balance moved, no loan exists — so there is
 * nothing to compensate. Two consecutive conflicts surface to the caller
 * exactly as they do today.
 *
 * The local mirror/store/activity work is byte-for-byte trackedCreateLoan's,
 * minus the `loansDb.add` the server already did.
 */
async function atomicLoanCreate(
  scope: MutationScope,
  leg: AtomicLoanCreateLeg,
): Promise<AtomicLoanCreateResult> {
  // Validated ONCE, before the first attempt: the plan does not change between
  // a conflict and its retry (the ids are already minted, and a retry that
  // re-planned would mint a second set and orphan the first).
  const { rows: emiRows, payload: emiPayload } = prepareEmiPayload(leg.emiRows, leg.amount, leg.createLoan);

  const call = async (): Promise<AtomicLoanCreateResult> => {
    const accounts = useAccountStore.getState();
    const account = accounts.getAccount(leg.accountId);
    if (!account) throw new Error('Account not found');
    const card = leg.cardAccountId ? accounts.getAccount(leg.cardAccountId) : null;
    if (leg.cardAccountId && !card) throw new Error('Source account not found');
    return atomicMoneyDb.loanCreateAtomic({
      transactionId: leg.transactionId,
      loanId: leg.loanId,
      createLoan: leg.createLoan,
      direction: leg.direction,
      personName: leg.personName,
      personId: leg.personId,
      accountId: leg.accountId,
      cardAccountId: leg.cardAccountId,
      amount: leg.amount,
      currency: leg.currency,
      note: leg.note,
      category: leg.category,
      createdAt: leg.createdAt,
      loanNotes: leg.loanNotes,
      // trackedCreateLoan reads its own clock, separate from the row's.
      loanCreatedAt: new Date().toISOString(),
      // The instalments, inserted by the server in THIS transaction. Null when
      // the user configured no plan, or the flag left the pages generating it.
      emi: emiPayload,
      expectedAccountBalance: account.balance,
      expectedCardBalance: card ? card.balance : null,
      allowNegative: leg.allowNegative,
    });
  };

  let result: AtomicLoanCreateResult;
  try {
    result = await call();
  } catch (err) {
    if ((err as { code?: string })?.code !== 'BALANCE_CONFLICT') {
      reportError(err, {
        feature: 'transactionStore.atomicLoanCreate.rpcFailed',
        extra: { transactionId: leg.transactionId, loanId: leg.loanId },
      });
      throw err;
    }
    // Another device/tab moved one of these accounts. Learn the truth, retry
    // once. A conflict means NOTHING was written, so there is nothing to undo.
    const fresh = await accountsDb.getAll();
    useAccountStore.setState({ accounts: fresh });
    result = await call();
  }

  // Cross-check the server's arithmetic against the client's copy of the same
  // rule (src/lib/loanCreateAtomicPlan.ts). They are two implementations of one
  // decision — which account moves which way — and a silent fork between them
  // would mean the inverse registered below hands money back to the wrong
  // account, or in the wrong direction. Reported, never thrown: the money has
  // already committed correctly by the server's own reckoning, and rolling it
  // back on a disagreement would be the more destructive of the two choices.
  const expectedLegs = planLoanCreateLegs({
    direction: leg.direction,
    amount: leg.amount,
    accountId: leg.accountId,
    cardAccountId: leg.cardAccountId,
  });
  if (!result.replay
    && (round2(result.accountDelta) !== expectedLegs.accountDelta
      || round2(result.cardDelta ?? 0) !== (expectedLegs.cardDelta ?? 0))) {
    reportError(new Error('ATOMIC_LOAN_CREATE_DELTA_FORK'), {
      feature: 'transactionStore.atomicLoanCreate.deltaFork',
      extra: {
        transactionId: leg.transactionId,
        serverAccountDelta: result.accountDelta,
        clientAccountDelta: expectedLegs.accountDelta,
        serverCardDelta: result.cardDelta,
        clientCardDelta: expectedLegs.cardDelta,
      },
    });
  }

  // Adopt SERVER truth everywhere. Never recompute it locally.
  await setKnownBalance(leg.accountId, result.accountBalance);
  if (leg.cardAccountId && result.cardBalance !== null) {
    await setKnownBalance(leg.cardAccountId, result.cardBalance);
  }

  // The loans row is already committed server-side; mirror it locally exactly
  // as trackedCreateLoan does, and register the same inverse.
  if (result.loanCreated) {
    const loan: Loan = {
      id: result.loanId,
      personName: leg.personName,
      personId: leg.personId,
      type: leg.direction,
      totalAmount: leg.amount,
      remainingAmount: leg.amount,
      currency: leg.currency,
      status: 'active',
      notes: leg.loanNotes,
      createdAt: new Date().toISOString(),
    };
    loan.updatedAt = loan.createdAt;
    await mirrorPut(db.loans, loan);
    markMirrorStale('loans');
    useLoanStore.setState((s) => ({ loans: [...s.loans, loan] }));
  }

  // ── Adopt the instalments the server actually inserted ────────────────────
  // Driven by result.emiInserted, NOT by the plan we sent: the server is the
  // only thing that knows which rows exist, and a mirror claiming instalments
  // Postgres does not have is exactly the desync `reconcileCovered` was built
  // to clean up after. A replay reports an empty list (the rows are already
  // there from the original call), so nothing is duplicated on a retry.
  const adoptedEmis: EmiSchedule[] = [];
  if (emiRows && result.emiInserted.length > 0) {
    const byId = new Map(emiRows.map((row) => [row.id, row]));
    for (const id of result.emiInserted) {
      const planned = byId.get(id);
      if (!planned) continue;
      adoptedEmis.push({
        id: planned.id,
        loanId: result.loanId,
        installmentNumber: planned.installmentNumber,
        dueDate: planned.dueDate,
        amount: planned.amount,
        status: 'upcoming' as EmiStatus,
      });
    }
    if (adoptedEmis.length > 0) {
      for (const row of adoptedEmis) await mirrorPut(db.emiSchedules, row);
      markMirrorStale('emiSchedules');
      useEmiStore.setState((s) => ({ schedules: [...s.schedules, ...adoptedEmis] }));
    }
  }

  scope.register(async () => {
    // Reverse every leg the way the legacy path reverses it: the balances
    // through the account CAS (delta-based, so a concurrent mutation
    // commutes), the loan by deletion, and the row the server wrote away.
    if (result.accountDelta !== 0) {
      await useAccountStore.getState().updateBalance(leg.accountId, -result.accountDelta);
    }
    if (leg.cardAccountId && result.cardDelta) {
      await useAccountStore.getState().updateBalance(leg.cardAccountId, -result.cardDelta);
    }
    if (result.loanCreated) {
      // The instalments FIRST, and only for a loan this call created — the
      // schedule points at the loan by foreign key, and `deleteByLoan` is the
      // only delete emiSchedulesDb exposes. Safe here precisely because a
      // created loan cannot have carried a pre-existing schedule; a plan is
      // never attached to a loan that already existed (prepareEmiPayload).
      if (adoptedEmis.length > 0) {
        const adoptedIds = new Set(adoptedEmis.map((e) => e.id));
        await emiSchedulesDb.deleteByLoan(result.loanId);
        for (const e of adoptedEmis) await mirrorDelete(db.emiSchedules, e.id);
        markMirrorStale('emiSchedules');
        useEmiStore.setState((s) => ({ schedules: s.schedules.filter((e) => !adoptedIds.has(e.id)) }));
      }
      await loansDb.delete(result.loanId);
      await mirrorDelete(db.loans, result.loanId);
      markMirrorStale('loans');
      useLoanStore.setState((s) => ({ loans: s.loans.filter((l) => l.id !== result.loanId) }));
    }
    // The tail's trackedAddTransaction registers its own delete, which runs
    // first under LIFO; deleting twice is a no-op.
    await transactionsDb.delete(leg.transactionId);
    await mirrorDelete(db.transactions, leg.transactionId);
    markMirrorStale('transactions');
    useTransactionStore.setState((s) => ({
      transactions: s.transactions.filter((t) => t.id !== leg.transactionId),
    }));
  });

  // Post-commit, best-effort — byte-for-byte trackedCreateLoan's entry. An
  // activity failure must NEVER roll back money that has moved.
  if (result.loanCreated) {
    try {
      await useActivityStore.getState().logActivity(
        'loan_created',
        `Loan ${leg.direction === 'given' ? 'given to' : 'taken from'} ${leg.personName}: ${leg.currency} ${leg.amount}`,
        result.loanId,
        'loan',
      );
    } catch (err) {
      reportError(err, {
        feature: 'transactionStore.atomicLoanCreate.logActivity',
        extra: { loanId: result.loanId },
      });
    }
  }

  return result;
}

// ═══════════════════════════════════════════════════════════════════════════
// SERVER-SIDE MONEY ENGINE — L4 step 4a: the goal contribution
//
// audit docs/audit-2026-09/07-mobile-first.md MF-01, 12-qa-review.md O-1/F-4,
// 00-executive-summary.md M1/L4. Branch #3 in the pilot's order table
// (docs/server-side-money-engine.md §6).
//
// Up to FOUR legs today:
//     account CAS → goals.saved_amount (an ABSOLUTE write) →
//     stored-in account CAS → transactions INSERT
// A drop after the first leaves a lighter wallet, an ungrown goal and no row.
// And leg 2 is the one the order table singles out: its compensation restores
// the exact prior savedAmount (trackedAddContribution below), so a rollback on
// THIS device silently erases a contribution made on another.
// `contribute_to_goal` (supabase-migration-p3-atomic-goal-and-card.sql) does
// all four in one Postgres transaction, behind the first compare-and-swap
// goals.saved_amount has ever had.
//
// OFF BY DEFAULT. The RPC does not exist until the user applies the migration,
// so the flag stays false and the legacy path runs byte-for-byte unchanged.
// ═══════════════════════════════════════════════════════════════════════════

const ATOMIC_GOAL_ENABLED = import.meta.env.VITE_ATOMIC_GOAL === 'true';

interface AtomicGoalLeg {
  transactionId: string;
  goalId: string;
  sourceAccountId: string;
  /** GOAL currency — what lands on the row and on saved_amount. */
  amount: number;
  /** SOURCE currency: amount ÷ rate (cross-currency), else amount, else 0. */
  sourceAmount: number;
  conversionRate: number | null;
  note: string;
  category: string;
  createdAt: string;
  /** The client's own decision; the server derives its own and returns it. */
  linkedAccountId: string | null;
  /** The goal's saved_amount BEFORE this contribution — the CAS expectation. */
  savedBefore: number;
}

/** Adopt a goal figure the SERVER computed. Never recompute it locally. */
function setKnownGoalSaved(goalId: string, savedAmount: number): void {
  useGoalStore.setState((s) => ({
    goals: s.goals.map((g) => (g.id === goalId ? { ...g, savedAmount } : g)),
  }));
}

/**
 * Call the goal-contribution RPC, adopt the server's figures, and register the
 * inverse for the rest of the scope.
 *
 * BALANCE_CONFLICT → refetch the accounts AND the goals once, then retry. The
 * token covers all three compare-and-swaps (source account, stored-in account,
 * goal), which is why the ladder refetches both stores. A conflict means
 * NOTHING moved, so there is nothing to compensate.
 *
 * There is deliberately NO retry floor here, unlike the repayment ladder: the
 * goal write is a pure `+amount` delta, so replaying it against a fresh
 * expectation adds exactly the same amount to whatever the truth now is. The
 * floor exists in repaymentAtomicPlan because a loan CLAMPS at zero and a blind
 * replay would overstate the reduction; a goal contribution cannot.
 *
 * The inverse it registers is a strict improvement on the legacy one: a DELTA
 * (`addContribution(-applied)`), which commutes with a concurrent contribution,
 * instead of the snapshot restore that clobbers it.
 */
async function atomicGoalContribution(
  scope: MutationScope,
  leg: AtomicGoalLeg,
): Promise<AtomicGoalContributionResult> {
  const call = async (): Promise<AtomicGoalContributionResult> => {
    const accounts = useAccountStore.getState();
    const src = accounts.getAccount(leg.sourceAccountId);
    if (!src) throw new Error('Source account not found');
    const goal = useGoalStore.getState().getGoal(leg.goalId);
    if (!goal) throw new Error('Goal not found');
    const linked = leg.linkedAccountId ? accounts.getAccount(leg.linkedAccountId) : null;
    return atomicMoneyDb.goalContributeAtomic({
      transactionId: leg.transactionId,
      goalId: leg.goalId,
      sourceAccountId: leg.sourceAccountId,
      amount: leg.amount,
      sourceAmount: leg.sourceAmount,
      conversionRate: leg.conversionRate,
      note: leg.note,
      category: leg.category,
      createdAt: leg.createdAt,
      linkedAccountId: leg.linkedAccountId,
      expectedSourceBalance: src.balance,
      expectedLinkedBalance: linked ? linked.balance : null,
      expectedSavedAmount: goal.savedAmount,
      // The branch uses the STRICT checkBalance — 'goal_contribution' is absent
      // from isSimpleModeBalanceBypassAllowed — so there is no ledger bypass to
      // reproduce and this is always false.
      allowNegative: false,
    });
  };

  let result: AtomicGoalContributionResult;
  try {
    result = await call();
  } catch (err) {
    if ((err as { code?: string })?.code !== 'BALANCE_CONFLICT') {
      reportError(err, {
        feature: 'transactionStore.atomicGoalContribution.rpcFailed',
        extra: { transactionId: leg.transactionId, goalId: leg.goalId },
      });
      throw err;
    }
    // Another device/tab moved one of the accounts or the goal. Learn the truth
    // on BOTH sides, retry once. A conflict means NOTHING moved.
    const [freshAccounts] = await Promise.all([
      accountsDb.getAll(),
      useGoalStore.getState().loadGoals(),
    ]);
    useAccountStore.setState({ accounts: freshAccounts });
    result = await call();
  }

  // The server derives the credit leg from the GOAL's own stored_in_account_id;
  // the client derived it from the local account list. A disagreement means the
  // local list was stale — reported, never thrown, because the money has
  // already committed correctly by the server's own reckoning and rolling it
  // back on a bookkeeping disagreement would be the more destructive choice.
  if (!result.replay && result.linkedAccountId !== leg.linkedAccountId) {
    reportError(new Error('ATOMIC_GOAL_LINKED_FORK'), {
      feature: 'transactionStore.atomicGoalContribution.linkedFork',
      extra: {
        transactionId: leg.transactionId,
        serverLinkedAccountId: result.linkedAccountId,
        clientLinkedAccountId: leg.linkedAccountId,
      },
    });
  }

  // Adopt SERVER truth everywhere. Never recompute it locally.
  if (!result.selfStored) await setKnownBalance(leg.sourceAccountId, result.sourceBalance);
  if (result.linkedAccountId && result.linkedBalance !== null) {
    await setKnownBalance(result.linkedAccountId, result.linkedBalance);
  }
  setKnownGoalSaved(leg.goalId, result.goalSavedAmount);

  scope.register(async () => {
    // Reverse each leg the way the legacy path reverses it — except the goal,
    // which is reversed by DELTA rather than by snapshot (see the doc comment).
    if (result.sourceDelta !== 0) {
      await useAccountStore.getState().updateBalance(leg.sourceAccountId, -result.sourceDelta);
    }
    if (result.linkedAccountId && result.linkedDelta) {
      await useAccountStore.getState().updateBalance(result.linkedAccountId, -result.linkedDelta);
    }
    if (result.goalApplied !== 0) {
      // L4 step 5 (doc §23 item 6): the delta now goes through the
      // `apply_goal_saved_delta` compare-and-swap, with a retry and a fallback
      // to this exact call if the CAS cannot be satisfied — see
      // atomicGoalSavedDelta. It was the last unlocked writer of
      // goals.saved_amount left in the goal path.
      await atomicGoalSavedDelta(leg.goalId, -result.goalApplied);
    }
    // The tail's trackedAddTransaction registers its own delete, which runs
    // first under LIFO; deleting twice is a no-op.
    await transactionsDb.delete(leg.transactionId);
    await mirrorDelete(db.transactions, leg.transactionId);
    markMirrorStale('transactions');
    useTransactionStore.setState((s) => ({
      transactions: s.transactions.filter((t) => t.id !== leg.transactionId),
    }));
  });

  return result;
}

// ═══════════════════════════════════════════════════════════════════════════
// SERVER-SIDE MONEY ENGINE — L4 step 4b: the whole credit-card story
//
// audit docs/audit-2026-09/07-mobile-first.md MF-01, 12-qa-review.md F-2 and
// O-1/F-4, 00-executive-summary.md M1/L4. Branch #5 in the pilot's order table
// (docs/server-side-money-engine.md §6) — the one it deliberately left last,
// because the allocation is real business logic with its own tested engine.
//
// The decision that table asked for is made here: PLAN ON THE CLIENT, APPLY ON
// THE SERVER. `allocateBillPayment` and `clampCardCredit` stay in TypeScript
// (they are the source of truth and have 30+ tests behind them); the RPC
// applies the plan they produce, in one transaction, and RE-VALIDATES every
// number in it.
//
// Two user actions, one shape:
//   'transfer'  — paying a card bill. The LARGEST flow in the switch:
//                 2 balances + 1 row + N × (loan CAS + M instalment writes +
//                 1 ledger row). A drop partway leaves a PAID bill whose loans
//                 still say the money is owed, so the app asks the user to pay
//                 the same debt twice — the double-credit disaster reached from
//                 the other direction.
//   'repayment' — repaying a cash-advance loan, which credits the card back.
//                 THIS IS THE CASE STEP 2 DEFERRED (see the comment above
//                 ATOMIC_REPAYMENT_ENABLED and
//                 supabase-migration-p3-atomic-repayment.sql §8.1): a second
//                 account leg plus the clampCardCredit rule, which a
//                 one-account RPC cannot express. It lands here instead.
//
// OFF BY DEFAULT. The RPC does not exist until the user applies the migration,
// so the flag stays false and BOTH legacy paths run byte-for-byte unchanged.
// ═══════════════════════════════════════════════════════════════════════════

const ATOMIC_CARD_BILL_ENABLED = import.meta.env.VITE_ATOMIC_CARD_BILL === 'true';

interface AtomicCardBillLeg {
  transactionId: string;
  rowType: 'transfer' | 'repayment';
  sourceAccountId: string;
  cardAccountId: string;
  /** The ROW's amount. */
  amount: number;
  /** What the wallet loses, in SOURCE currency. */
  sourceAmount: number;
  /** What the card gains — unclamped for a transfer, clamped for a repayment. */
  cardAmount: number;
  currency: Currency;
  conversionRate: number | null;
  note: string;
  category: string;
  createdAt: string;
  /**
   * Recomputed on EVERY attempt: after a conflict refetch the loans' remaining
   * amounts have changed, so the allocation and the coverage prefix have too.
   * Returns the lines together with the EMI statuses they are about to
   * overwrite, so the inverse can restore them exactly (including 'late').
   */
  buildPlan: () => Promise<{ lines: CardBillPlanLine[]; emiBefore: { id: string; status: EmiStatus }[] }>;
  allowNegative: boolean;
}

/**
 * Call the card-bill RPC, adopt the server's figures, materialise the ledger
 * rows it wrote, and register the inverse for the rest of the scope.
 *
 * The retry ladder is the UNION of the two the legacy path already ran:
 *   · BALANCE_CONFLICT        → refetch the accounts, RE-PLAN, retry once.
 *   · LOAN_REMAINING_CONFLICT → refetch the loans, RE-PLAN, retry once. For a
 *                               BILL PAYMENT the re-plan is self-limiting
 *                               (allocateBillPayment caps every line at its
 *                               loan's remaining, and the ledger row records
 *                               the recomputed figure), so no floor is needed.
 *                               For a REPAYMENT the row's amount is FIXED, so
 *                               the repaymentAtomicPlan floor applies exactly as
 *                               it does in step 2 — replaying past it is how a
 *                               500 payment reduces a now-200 loan by 200 while
 *                               the row still says 500 (audit F-2).
 * A conflict means NOTHING moved, so there is nothing to compensate.
 */
async function atomicPayCardBill(
  scope: MutationScope,
  leg: AtomicCardBillLeg,
): Promise<AtomicCardBillResult> {
  const loansBefore = new Map(
    useLoanStore.getState().loans.map((l) => [l.id, { status: l.status, remaining: l.remainingAmount }]),
  );

  const call = async (): Promise<{
    result: AtomicCardBillResult;
    lines: CardBillPlanLine[];
    emiBefore: { id: string; status: EmiStatus }[];
  }> => {
    const accounts = useAccountStore.getState();
    const src = accounts.getAccount(leg.sourceAccountId);
    const card = accounts.getAccount(leg.cardAccountId);
    if (!src || !card) throw new Error('Account not found');
    const { lines, emiBefore } = await leg.buildPlan();
    // The client half of the server's lockstep invariant. A refusal that costs
    // a round-trip on 3G is a refusal the user waits for.
    if (leg.rowType === 'transfer' && cardBillPlanExceedsPayment(lines, leg.cardAmount)) {
      throw new Error(tStatic('err_card_bill_plan'));
    }
    const result = await atomicMoneyDb.payCardBillAtomic({
      transactionId: leg.transactionId,
      rowType: leg.rowType,
      sourceAccountId: leg.sourceAccountId,
      cardAccountId: leg.cardAccountId,
      amount: leg.amount,
      sourceAmount: leg.sourceAmount,
      cardAmount: leg.cardAmount,
      currency: leg.currency,
      conversionRate: leg.conversionRate,
      note: leg.note,
      category: leg.category,
      createdAt: leg.createdAt,
      plan: toCardBillPayload(lines),
      expectedSourceBalance: src.balance,
      expectedCardBalance: card.balance,
      allowNegative: leg.allowNegative,
    });
    return { result, lines, emiBefore };
  };

  let attempt: Awaited<ReturnType<typeof call>>;
  try {
    attempt = await call();
  } catch (err) {
    const code = (err as { code?: string })?.code;
    if (code !== 'BALANCE_CONFLICT' && code !== 'LOAN_REMAINING_CONFLICT') {
      reportError(err, {
        feature: 'transactionStore.atomicPayCardBill.rpcFailed',
        extra: { transactionId: leg.transactionId, rowType: leg.rowType },
      });
      throw err;
    }
    // Learn the truth on BOTH sides — either lock may have been the stale one,
    // and a second attempt has to carry fresh expectations AND a fresh plan.
    const [freshAccounts] = await Promise.all([
      accountsDb.getAll(),
      useLoanStore.getState().loadLoans(),
    ]);
    useAccountStore.setState({ accounts: freshAccounts });

    if (leg.rowType === 'repayment') {
      // The row's amount is fixed, so the step-2 floor rule applies verbatim.
      const [only] = (await leg.buildPlan()).lines;
      const before = loansBefore.get(only?.loanId ?? '');
      const floor = repaymentRetryFloor(leg.amount, before?.remaining ?? leg.amount);
      const fresh = useLoanStore.getState().loans.find((l) => l.id === only?.loanId);
      if (!fresh) throw loanRemainingConflictError(tStatic('err_loan_gone'));
      if (!canRetryRepayment(fresh.remainingAmount, floor)) {
        throw loanRemainingConflictError(tStatic('err_loan_gone'));
      }
    }
    attempt = await call();
  }

  const { result } = attempt;

  // Adopt SERVER truth everywhere. Never recompute it locally.
  await setKnownBalance(leg.sourceAccountId, result.sourceBalance);
  await setKnownBalance(leg.cardAccountId, result.cardBalance);
  for (const line of result.lines) {
    syncLocalRemaining(line.loanId, line.remaining);
    adoptEmiMarks(line.emiMarked);
  }

  // The ledger rows are already committed server-side; mirror them locally
  // exactly as trackedAddTransaction does, minus the write the server did.
  const adoptedRows: Transaction[] = [];
  for (const line of result.lines) {
    if (!line.rowId) continue;
    const planned = attempt.lines.find((l) => l.loanId === line.loanId);
    const row: Transaction = {
      id: line.rowId,
      type: 'repayment',
      amount: planned ? planned.applied : line.applied,
      currency: line.currency as Currency,
      sourceAccountId: null,
      destinationAccountId: null,
      relatedPerson: line.personName,
      personId: line.personId,
      relatedLoanId: line.loanId,
      relatedGoalId: null,
      relatedInvestmentId: null,
      conversionRate: null,
      category: '',
      notes: planned ? planned.rowNote : '',
      createdAt: leg.createdAt,
      isReconciled: false,
      reconciledAt: null,
      reconciledBy: null,
    };
    row.updatedAt = row.createdAt;
    await mirrorPut(db.transactions, row);
    adoptedRows.push(row);
  }
  if (adoptedRows.length > 0) {
    markMirrorStale('transactions');
    useTransactionStore.setState((s) => ({ transactions: [...adoptedRows, ...s.transactions] }));
  }

  const markedSet = new Set(result.lines.flatMap((l) => l.emiMarked));
  const restore = attempt.emiBefore.filter((e) => markedSet.has(e.id));

  scope.register(async () => {
    // Reverse every leg the way the legacy path reverses it: the balances
    // through the account CAS (delta-based, so a concurrent mutation commutes),
    // each loan through apply_loan_remaining_delta with the amount that
    // ACTUALLY moved (`applied`, not the requested figure — they differ when
    // the server clamp bit), the instalments back to their exact prior status
    // (including 'late'), and every row the server wrote away.
    if (result.sourceDelta !== 0) {
      await useAccountStore.getState().updateBalance(leg.sourceAccountId, -result.sourceDelta);
    }
    if (result.cardDelta !== 0) {
      await useAccountStore.getState().updateBalance(leg.cardAccountId, -result.cardDelta);
    }
    for (const line of result.lines) {
      if (line.applied === 0) continue;
      const deps = loanDeltaDeps(line.loanId);
      const reversed = await applyLoanRemainingDelta(
        { expectedRemaining: line.remaining, delta: line.applied },
        deps,
      );
      syncLocalRemaining(line.loanId, reversed.newRemaining);
    }
    if (restore.length > 0) {
      await Promise.all(restore.map((e) => emiSchedulesDb.update(e.id, { status: e.status })));
      useEmiStore.setState((s) => ({
        schedules: s.schedules.map((e) => {
          const prev = restore.find((r) => r.id === e.id);
          return prev ? { ...e, status: prev.status } : e;
        }),
      }));
    }
    const doomed = [
      ...result.lines.map((l) => l.rowId).filter((id): id is string => Boolean(id)),
      // The tail's trackedAddTransaction registers its own delete for the main
      // row, which runs first under LIFO; deleting twice is a no-op.
      leg.transactionId,
    ];
    for (const id of doomed) {
      await transactionsDb.delete(id);
      await mirrorDelete(db.transactions, id);
    }
    markMirrorStale('transactions');
    const doomedSet = new Set(doomed);
    useTransactionStore.setState((s) => ({
      transactions: s.transactions.filter((t) => !doomedSet.has(t.id)),
    }));
  });

  // ── Post-commit, best-effort. Byte-for-byte the entries the legacy helpers
  //    write: trackedMarkCoveredEmisPaid's 'emi_paid' (singular or counted) and
  //    trackedApplyRepayment's 'loan_settled', once per loan that reached zero
  //    and was not already settled. An activity failure must NEVER roll back
  //    money that has moved.
  const schedulesNow = useEmiStore.getState().schedules;
  const numberOf = (id: string) => schedulesNow.find((e) => e.id === id)?.installmentNumber;
  for (const line of result.lines) {
    if (line.emiMarked.length > 0) {
      try {
        await useActivityStore.getState().logActivity(
          'emi_paid',
          line.emiMarked.length === 1
            ? `EMI #${numberOf(line.emiMarked[0])} paid`
            : `${line.emiMarked.length} EMIs marked paid after repayment`,
          line.loanId,
          'loan',
        );
      } catch (err) {
        reportError(err, {
          feature: 'transactionStore.atomicPayCardBill.emiActivity',
          extra: { loanId: line.loanId },
        });
      }
    }
    if (line.settledNow && loansBefore.get(line.loanId)?.status !== 'settled') {
      try {
        await useActivityStore.getState().logActivity(
          'loan_settled', `Loan with ${line.personName} fully settled`, line.loanId, 'loan',
        );
      } catch (err) {
        reportError(err, {
          feature: 'transactionStore.atomicPayCardBill.settledActivity',
          extra: { loanId: line.loanId },
        });
      }
    }
  }

  return result;
}

// ═══════════════════════════════════════════════════════════════════════════
// SERVER-SIDE MONEY ENGINE — L4 step 5: the last two shapes
//
// audit docs/audit-2026-09/07-mobile-first.md MF-01, 12-qa-review.md O-1/F-4,
// 00-executive-summary.md M1/L4. These are the two rows §22 of
// docs/server-side-money-engine.md left uncovered when step 4 closed every
// MULTI-leg branch.
//
//   income / expense / opening_balance / adjustment
//     balance CAS → transactions INSERT. The narrowest window in the engine —
//     it cannot leave money half-moved BETWEEN two places — but it is the most
//     common write in the app, and what it leaves is a balance that changed
//     with NO row saying why. The user's own repair for that is `adjustment`,
//     which is one of the four branches with the same window.
//
//   investment_buy / investment_sell / investment_dividend
//     balance CAS → investment_trades INSERT → transactions INSERT. Positions
//     here are DERIVED by replaying the trade ledger (src/lib/investmentMath.ts
//     — "there is no holdings table to drift"), so a drop between the first two
//     does not corrupt a figure, it DELETES the position: a wallet that paid
//     for shares nobody holds, or sold shares that can be sold again.
//
// BOTH OFF BY DEFAULT. The RPCs do not exist until the user applies
// supabase-migration-p3-atomic-investments-and-single-leg.sql, so the flags stay
// false and the legacy paths below run byte-for-byte unchanged.
// ═══════════════════════════════════════════════════════════════════════════

const ATOMIC_SINGLE_LEG_ENABLED = import.meta.env.VITE_ATOMIC_SINGLE_LEG === 'true';
const ATOMIC_INVEST_ENABLED = import.meta.env.VITE_ATOMIC_INVEST === 'true';

interface AtomicSingleLegLeg {
  transactionId: string;
  type: SingleLegEntryType;
  accountId: string;
  /** The row's unsigned magnitude. For an adjustment, the client's |delta|. */
  amount: number;
  /** `adjustment` only — the balance the account is set TO. */
  targetBalance: number | null;
  note: string;
  category: string;
  createdAt: string;
  /**
   * True only where the client's own checkBalanceForTransaction is a no-op —
   * splits_only mode, and only for 'expense' (isSimpleModeBalanceBypassAllowed).
   */
  allowNegative: boolean;
}

/**
 * Call the single-leg RPC, adopt the server's balance, and register the inverse.
 *
 * BALANCE_CONFLICT → refetch the accounts once and retry, the same ladder
 * accountStore.updateBalance already runs against the account CAS. A conflict
 * means NOTHING moved, so there is nothing to compensate.
 *
 * There is no retry floor and none is needed: every one of the four is a plain
 * signed delta (an adjustment re-derives its own from the freshly locked row),
 * so replaying against a fresh expectation is always correct.
 */
async function atomicSingleLeg(
  scope: MutationScope,
  leg: AtomicSingleLegLeg,
): Promise<AtomicSingleLegResult> {
  const call = async (): Promise<AtomicSingleLegResult> => {
    const account = useAccountStore.getState().getAccount(leg.accountId);
    if (!account) throw new Error('Account not found');
    // An adjustment's magnitude is a FUNCTION of the balance it is correcting,
    // so it must be re-derived on the retry as well: after a conflict refetch
    // the account has moved, and sending the pre-conflict |delta| alongside the
    // post-conflict expectation is a payload whose two halves describe
    // different worlds — the server's own cross-check (AMOUNT_MISMATCH) would
    // refuse it, correctly. Every other type carries a fixed amount.
    const amount = leg.type === 'adjustment' && leg.targetBalance !== null
      ? Math.abs(round2(leg.targetBalance - account.balance))
      : leg.amount;
    return atomicMoneyDb.singleLegAtomic({
      transactionId: leg.transactionId,
      type: leg.type,
      accountId: leg.accountId,
      amount,
      targetBalance: leg.targetBalance,
      note: leg.note,
      category: leg.category,
      createdAt: leg.createdAt,
      expectedBalance: account.balance,
      allowNegative: leg.allowNegative,
    });
  };

  let result: AtomicSingleLegResult;
  try {
    result = await call();
  } catch (err) {
    if ((err as { code?: string })?.code !== 'BALANCE_CONFLICT') {
      reportError(err, {
        feature: 'transactionStore.atomicSingleLeg.rpcFailed',
        extra: { transactionId: leg.transactionId, type: leg.type },
      });
      throw err;
    }
    const fresh = await accountsDb.getAll();
    useAccountStore.setState({ accounts: fresh });
    result = await call();
  }

  await setKnownBalance(leg.accountId, result.accountBalance);

  scope.register(async () => {
    // Reverse through the account CAS (delta-based, so a concurrent mutation
    // commutes) and remove the row the server wrote. The tail's
    // trackedAddTransaction registers its own delete which runs first under
    // LIFO; deleting twice is a no-op.
    if (result.accountDelta !== 0) {
      await useAccountStore.getState().updateBalance(leg.accountId, -result.accountDelta);
    }
    await transactionsDb.delete(leg.transactionId);
    await mirrorDelete(db.transactions, leg.transactionId);
    markMirrorStale('transactions');
    useTransactionStore.setState((s) => ({
      transactions: s.transactions.filter((t) => t.id !== leg.transactionId),
    }));
  });

  return result;
}

interface AtomicInvestmentLeg {
  transactionId: string;
  /** The trade the branch built. Its id is a REQUEST — the server's reply wins. */
  trade: InvestmentTrade;
  kind: 'buy' | 'sell' | 'dividend';
  accountId: string;
  /** The ROW's amount, in MARKET currency. */
  amount: number;
  /** What the ACCOUNT moves: buy DIVIDES, sell and dividend MULTIPLY. */
  accountAmount: number;
  conversionRate: number | null;
  note: string;
  category: string;
  createdAt: string;
}

/** Adopt a trade row the SERVER wrote. State only — the row already exists. */
function adoptTradeRow(trade: InvestmentTrade): void {
  useInvestmentStore.setState((s) => (
    s.trades.some((t) => t.id === trade.id) ? s : { trades: [trade, ...s.trades] }
  ));
}

/**
 * Call the investment-trade RPC, adopt the server's figures, and register the
 * inverse for the rest of the scope.
 *
 * BALANCE_CONFLICT → refetch the accounts once and retry. Everything else is
 * final: a TRADE_REJECTED means the server re-ran `validateTradeInput` and
 * `simulateTimeline` and disagreed with us, which is not something a retry can
 * fix — and because the RPC is atomic, it wrote NONE of the three artifacts.
 *
 * The trade the store adopts is the one the SERVER reports, not the one this
 * call generated: on a replay the server returns the id the FIRST attempt
 * minted, and a mirror claiming a trade Postgres does not have is precisely the
 * desync a derived-position feature cannot survive.
 */
async function atomicInvestmentTrade(
  scope: MutationScope,
  leg: AtomicInvestmentLeg,
): Promise<{ result: AtomicInvestmentTradeResult; trade: InvestmentTrade }> {
  const call = async (): Promise<AtomicInvestmentTradeResult> => {
    const account = useAccountStore.getState().getAccount(leg.accountId);
    if (!account) throw new Error('Account not found');
    return atomicMoneyDb.investmentTradeAtomic({
      transactionId: leg.transactionId,
      tradeId: leg.trade.id,
      kind: leg.kind,
      marketId: leg.trade.marketId,
      symbol: leg.trade.symbol,
      companyName: leg.trade.name,
      quantity: leg.trade.quantity,
      pricePerUnit: leg.trade.pricePerUnit,
      grossAmount: leg.trade.amount,
      fees: leg.trade.fees,
      accountId: leg.accountId,
      amount: leg.amount,
      accountAmount: leg.accountAmount,
      conversionRate: leg.conversionRate,
      note: leg.note,
      category: leg.category,
      createdAt: leg.createdAt,
      tradedAt: leg.trade.tradedAt,
      tradeNotes: leg.trade.notes,
      tradeCreatedAt: leg.trade.createdAt,
      expectedBalance: account.balance,
      // 'investment_*' is absent from isSimpleModeBalanceBypassAllowed, so the
      // branch uses the STRICT checkBalance and there is no bypass to reproduce.
      allowNegative: false,
    });
  };

  let result: AtomicInvestmentTradeResult;
  try {
    result = await call();
  } catch (err) {
    if ((err as { code?: string })?.code !== 'BALANCE_CONFLICT') {
      reportError(err, {
        feature: 'transactionStore.atomicInvestmentTrade.rpcFailed',
        extra: {
          transactionId: leg.transactionId,
          kind: leg.kind,
          serverToken: (err as { serverToken?: string })?.serverToken ?? null,
        },
      });
      throw err;
    }
    const fresh = await accountsDb.getAll();
    useAccountStore.setState({ accounts: fresh });
    result = await call();
  }

  // The server is the only thing that knows which trade row exists.
  const stored: InvestmentTrade = { ...leg.trade, id: result.tradeId };
  await setKnownBalance(leg.accountId, result.accountBalance);
  adoptTradeRow(stored);

  scope.register(async () => {
    await useInvestmentStore.getState().removeTradeRow(stored.id);
    if (result.accountDelta !== 0) {
      await useAccountStore.getState().updateBalance(leg.accountId, -result.accountDelta);
    }
    await transactionsDb.delete(leg.transactionId);
    await mirrorDelete(db.transactions, leg.transactionId);
    markMirrorStale('transactions');
    useTransactionStore.setState((s) => ({
      transactions: s.transactions.filter((t) => t.id !== leg.transactionId),
    }));
  });

  return { result, trade: stored };
}

/**
 * The goal compensation's own compare-and-swap (doc §23 item 6).
 *
 * Step 4 gave the FORWARD goal write a CAS inside `contribute_to_goal`. The
 * INVERSE the scope registers still went through `goalStore.addContribution` →
 * `goalsDb.update`, an unlocked read-modify-write that can clobber a
 * contribution made on another device while the rollback is in flight. This
 * routes it through `apply_goal_saved_delta` instead.
 *
 * THE LADDER MATTERS MORE THAN THE CAS. A compare-and-swap on a *compensation*
 * is a knife with two edges: a rollback that REFUSES to run is strictly worse
 * than one that races. So:
 *   1. try the CAS against the local snapshot;
 *   2. on BALANCE_CONFLICT, reload the goals and retry ONCE against the truth
 *      (a pure delta is always safe to replay against a fresh expectation —
 *      the same reasoning as the forward path's missing retry floor);
 *   3. on ANY remaining failure — a second conflict, a missing RPC because the
 *      step-5 migration has not been applied, a network drop — fall back to the
 *      legacy unlocked write, and report.
 * The result is never worse than today and usually better.
 *
 * Deliberately NOT behind its own flag: it is only ever reached from the
 * already-flagged VITE_ATOMIC_GOAL path, and step 3 of the ladder means a
 * project that has step 4's migration but not step 5's still rolls back
 * exactly as it does today.
 */
async function atomicGoalSavedDelta(goalId: string, delta: number): Promise<void> {
  if (delta === 0) return;

  const expected = (): number | null => {
    const goal = useGoalStore.getState().getGoal(goalId);
    return goal ? goal.savedAmount : null;
  };

  try {
    const before = expected();
    if (before === null) throw new Error('Goal not found');
    let applied;
    try {
      applied = await atomicMoneyDb.goalSavedDelta(goalId, delta, before);
    } catch (err) {
      if ((err as { code?: string })?.code !== 'BALANCE_CONFLICT') throw err;
      await useGoalStore.getState().loadGoals();
      const fresh = expected();
      if (fresh === null) throw err;
      applied = await atomicMoneyDb.goalSavedDelta(goalId, delta, fresh);
    }
    setKnownGoalSaved(goalId, applied.goalSavedAmount);
    return;
  } catch (err) {
    reportError(err, {
      feature: 'transactionStore.atomicGoalSavedDelta.fellBack',
      extra: { goalId, delta },
    });
  }

  // The floor: exactly what the compensation did before this function existed.
  await useGoalStore.getState().addContribution(goalId, delta);
}

async function trackedUpdateLoan(
  scope: MutationScope,
  loanId: string,
  changes: Partial<Loan>,
): Promise<void> {
  const before = useLoanStore.getState().loans.find(l => l.id === loanId);
  if (!before) throw new Error(`Loan ${loanId} not found`);
  // Snapshot only the fields being changed so compensation restores exactly
  // those, not the entire row (safer against interleaved realtime updates).
  const snapshot: Partial<Loan> = {};
  for (const key of Object.keys(changes) as (keyof Loan)[]) {
    (snapshot as Record<string, unknown>)[key] = before[key];
  }
  await useLoanStore.getState().updateLoan(loanId, changes);
  scope.register(() => useLoanStore.getState().updateLoan(loanId, snapshot));
}

async function trackedAddContribution(scope: MutationScope, goalId: string, amount: number): Promise<void> {
  // Snapshot-based inverse: addContribution clamps savedAmount at 0, so a
  // negated delta is asymmetric whenever the forward step hit the clamp —
  // rollback must restore the exact prior figure, not undo a delta.
  const prevSaved = useGoalStore.getState().getGoal(goalId)?.savedAmount;
  await useGoalStore.getState().addContribution(goalId, amount);
  scope.register(async () => {
    if (prevSaved === undefined) return;
    await goalsDb.update(goalId, { savedAmount: prevSaved });
    useGoalStore.setState((s) => ({
      goals: s.goals.map((g) => (g.id === goalId ? { ...g, savedAmount: prevSaved } : g)),
    }));
  });
}

// Investment trade rows ride inside the money-mutation scope so a failed
// balance leg can never leave an orphan trade (and vice versa). The store
// primitives touch only the row + local state — balances stay owned here.
async function trackedAddInvestmentTrade(scope: MutationScope, trade: InvestmentTrade): Promise<void> {
  await useInvestmentStore.getState().insertTradeRow(trade);
  scope.register(() => useInvestmentStore.getState().removeTradeRow(trade.id));
}

async function trackedDeleteInvestmentTrade(scope: MutationScope, trade: InvestmentTrade): Promise<void> {
  await useInvestmentStore.getState().removeTradeRow(trade.id);
  scope.register(() => useInvestmentStore.getState().restoreTradeRow(trade));
}

async function trackedMarkEmiPaid(scope: MutationScope, emiId: string): Promise<void> {
  // Bypass store.markPaid because it awaits logActivity AFTER the DB write —
  // a log failure would throw without letting us register compensation.
  const before = useEmiStore.getState().schedules.find(e => e.id === emiId);
  if (!before) throw new Error(`EMI ${emiId} not found`);
  const prevStatus: EmiStatus = before.status;
  if (prevStatus === 'paid') return;
  await emiSchedulesDb.update(emiId, { status: 'paid' as EmiStatus });
  useEmiStore.setState(s => ({
    schedules: s.schedules.map(e => (e.id === emiId ? { ...e, status: 'paid' as EmiStatus } : e)),
  }));
  scope.register(async () => {
    await emiSchedulesDb.update(emiId, { status: prevStatus });
    useEmiStore.setState(s => ({
      schedules: s.schedules.map(e => (e.id === emiId ? { ...e, status: prevStatus } : e)),
    }));
  });
  try {
    await useActivityStore.getState().logActivity(
      'emi_paid',
      `EMI #${before.installmentNumber} paid`,
      before.loanId,
      'loan',
    );
  } catch (err) {
    reportError(err, { feature: 'transactionStore.trackedMarkEmiPaid.logActivity', extra: { loanId: before.loanId } });
  }
}

async function trackedMarkCoveredEmisPaid(scope: MutationScope, loanId: string): Promise<void> {
  // Reconcile the loan's binary EMI schedule to its paid-down balance. After a
  // repayment that carried no specific emiId, mark the oldest instalments now
  // fully covered by (totalAmount - remainingAmount) as paid. This must run
  // AFTER trackedApplyRepayment so remainingAmount is already current.
  //
  // Subsumes the old "full settlement marks everything" branch — a full payoff
  // covers every instalment. Snapshots exact prior status (incl. 'late') so
  // rollback restores it. Bypasses store.markPaid for the same reason as
  // trackedMarkEmiPaid (embedded logActivity would throw before compensation).
  const loan = useLoanStore.getState().loans.find(l => l.id === loanId);
  if (!loan) return;
  const schedules = useEmiStore.getState().schedules.filter(e => e.loanId === loanId);
  if (schedules.length === 0) return;
  const paid = Math.round((loan.totalAmount - loan.remainingAmount) * 100) / 100;
  const ids = uncoveredToPaidIds(schedules, paid);
  if (ids.length === 0) return;
  const idSet = new Set(ids);
  const before = schedules
    .filter(e => idSet.has(e.id))
    .map(e => ({ id: e.id, status: e.status, installmentNumber: e.installmentNumber }));
  await Promise.all(before.map(s => emiSchedulesDb.update(s.id, { status: 'paid' as EmiStatus })));
  useEmiStore.setState(state => ({
    schedules: state.schedules.map(e => (idSet.has(e.id) ? { ...e, status: 'paid' as EmiStatus } : e)),
  }));
  scope.register(async () => {
    await Promise.all(before.map(s => emiSchedulesDb.update(s.id, { status: s.status })));
    useEmiStore.setState(state => ({
      schedules: state.schedules.map(e => {
        const prev = before.find(b => b.id === e.id);
        return prev ? { ...e, status: prev.status } : e;
      }),
    }));
  });
  try {
    await useActivityStore.getState().logActivity(
      'emi_paid',
      before.length === 1
        ? `EMI #${before[0].installmentNumber} paid`
        : `${before.length} EMIs marked paid after repayment`,
      loanId,
      'loan',
    );
  } catch (err) {
    reportError(err, { feature: 'transactionStore.trackedMarkCoveredEmisPaid.logActivity', extra: { loanId } });
  }
}

async function trackedAddTransaction(scope: MutationScope, tx: Transaction): Promise<void> {
  await transactionsDb.add(tx);
  await mirrorPut(db.transactions, tx);
  markMirrorStale('transactions');
  useTransactionStore.setState(s => ({ transactions: [tx, ...s.transactions] }));
  scope.register(async () => {
    await transactionsDb.delete(tx.id);
    await mirrorDelete(db.transactions, tx.id);
    markMirrorStale('transactions');
    useTransactionStore.setState(s => ({ transactions: s.transactions.filter(t => t.id !== tx.id) }));
  });
}

async function trackedUpdateTransaction(scope: MutationScope, id: string, updated: Transaction, snapshot: Transaction): Promise<void> {
  await transactionsDb.update(id, updated);
  await mirrorPut(db.transactions, updated);
  markMirrorStale('transactions');
  useTransactionStore.setState(state => ({
    transactions: state.transactions.map(t => (t.id === id ? updated : t)),
  }));
  scope.register(async () => {
    await transactionsDb.update(id, snapshot);
    await mirrorPut(db.transactions, snapshot);
    markMirrorStale('transactions');
    useTransactionStore.setState(state => ({
      transactions: state.transactions.map(t => (t.id === id ? snapshot : t)),
    }));
  });
}

async function trackedDeleteTransaction(scope: MutationScope, tx: Transaction): Promise<void> {
  await transactionsDb.delete(tx.id);
  await mirrorDelete(db.transactions, tx.id);
  markMirrorStale('transactions');
  useTransactionStore.setState(state => ({
    transactions: state.transactions.filter(t => t.id !== tx.id),
  }));
  scope.register(async () => {
    await transactionsDb.add(tx);
    await mirrorPut(db.transactions, tx);
    markMirrorStale('transactions');
    useTransactionStore.setState(s => ({ transactions: [tx, ...s.transactions] }));
  });
}

async function trackedDeleteLoan(scope: MutationScope, loanId: string): Promise<void> {
  const before = useLoanStore.getState().loans.find(l => l.id === loanId);
  if (!before) {
    // Nothing to delete; nothing to compensate.
    return;
  }
  await useLoanStore.getState().deleteLoan(loanId);
  scope.register(async () => {
    await loansDb.add(before);
    await mirrorPut(db.loans, before);
    markMirrorStale('loans');
    useLoanStore.setState(s => ({ loans: [...s.loans, before] }));
  });
}

async function trackedDeleteEmisByLoan(scope: MutationScope, loanId: string): Promise<void> {
  const snapshot: EmiSchedule[] = useEmiStore.getState().schedules.filter(e => e.loanId === loanId);
  if (snapshot.length === 0) return;
  await useEmiStore.getState().deleteByLoan(loanId);
  scope.register(async () => {
    await emiSchedulesDb.bulkAdd(snapshot);
    useEmiStore.setState(s => ({ schedules: [...s.schedules, ...snapshot] }));
  });
}

// Rebuild a schedule over a new total: same instalment count and start date,
// fresh 'upcoming' rows (only reachable when the loan has zero repayments).
// Inverse is a whole-loan wipe — safe because it always runs BEFORE the
// paired trackedDeleteEmisByLoan inverse re-adds the old rows (LIFO).
async function trackedRegenerateEmis(
  scope: MutationScope,
  loanId: string,
  totalAmount: number,
  installments: number,
  startDueDate: string,
): Promise<void> {
  const emiAmount = Math.round((totalAmount / installments) * 100) / 100;
  const start = new Date(startDueDate);
  const entries: EmiSchedule[] = [];
  for (let i = 0; i < installments; i++) {
    entries.push({
      id: uuid(),
      loanId,
      installmentNumber: i + 1,
      dueDate: format(addMonths(start, i), 'yyyy-MM-dd'),
      amount: i === installments - 1
        ? Math.round((totalAmount - emiAmount * (installments - 1)) * 100) / 100
        : emiAmount,
      status: 'upcoming' as EmiStatus,
    });
  }
  await emiSchedulesDb.bulkAdd(entries);
  useEmiStore.setState(s => ({ schedules: [...s.schedules, ...entries] }));
  scope.register(async () => {
    await emiSchedulesDb.deleteByLoan(loanId);
    const ids = new Set(entries.map(e => e.id));
    useEmiStore.setState(s => ({ schedules: s.schedules.filter(e => !ids.has(e.id)) }));
  });
}

// After a mutation commits, we log to activity. Failures here must NOT surface
// to the user — the money already moved and rolling it back now would be
// worse. Swallowed for the user, reported for the operator (audit H1) — a
// spike here means the audit trail is drifting behind the money.
async function logActivitySafe(type: ActivityType, description: string, entityId: string, entityType: string): Promise<void> {
  try {
    await useActivityStore.getState().logActivity(type, description, entityId, entityType);
  } catch (err) {
    reportError(err, {
      feature: 'transactionStore.logActivitySafe',
      extra: { activityType: type, entityType, entityId },
    });
  }
}

// If rollback itself partially failed, local state may have drifted from
// remote. Force-refetch the stores that carry money-critical data. Runs
// the five fetches in parallel — these are independent reads and the
// post-rollback path is exactly where every saved millisecond matters
// (the user is staring at an error toast).
async function refetchMoneyStores(): Promise<void> {
  try {
    await Promise.all([
      useAccountStore.getState().loadAccounts(),
      useTransactionStore.getState().loadTransactions(),
      useLoanStore.getState().loadLoans(),
      useEmiStore.getState().loadSchedules(),
      useGoalStore.getState().loadGoals(),
    ]);
  } catch (err) {
    // The last line of defence after a failed rollback: local state is now
    // known-stale against remote truth until the next navigation.
    reportError(err, { feature: 'transactionStore.refetchMoneyStores.postRollback' });
  }
}

// Money moved (or un-moved) → the Android reminder schedule may be stale:
// a bill payment must silence tonight's "due today", and undoing one must
// bring the reminder back. Forced (the 30s debounce must never swallow a
// resolution right before the 10:00 fire time); dynamic import avoids a
// static store↔scheduler cycle; no-op on web.
function nudgeReminderSchedule(): void {
  void import('../lib/notificationScheduler')
    .then((m) => m.rescheduleNotifications({ force: true }))
    .catch((err) => {
      reportError(err, { feature: 'transactionStore.nudgeReminderSchedule' });
    });
}

async function findCashAdvanceCardForLoan(loanId: string): Promise<string | null> {
  let transactions = useTransactionStore.getState().transactions;
  if (transactions.length === 0) {
    transactions = await transactionsDb.getAll();
    useTransactionStore.setState({ transactions });
  }

  const cashAdvance = transactions.find(
    (transaction) =>
      transaction.type === 'loan_taken' &&
      transaction.relatedLoanId === loanId &&
      Boolean(transaction.sourceAccountId),
  );

  return cashAdvance?.sourceAccountId ?? null;
}

// Reverse lookup of findCashAdvanceCardForLoan: the still-open taken loans a
// given credit card funded, oldest first. Used by the pay-card-bill path so a
// bill payment settles the debt's loan record instead of leaving it to be
// paid a second time.
async function findActiveCashAdvanceLoansForCard(cardId: string): Promise<Loan[]> {
  let transactions = useTransactionStore.getState().transactions;
  if (transactions.length === 0) {
    transactions = await transactionsDb.getAll();
    useTransactionStore.setState({ transactions });
  }
  const loanIds = new Set(
    transactions
      .filter((t) => t.type === 'loan_taken' && t.sourceAccountId === cardId && t.relatedLoanId)
      .map((t) => t.relatedLoanId as string),
  );
  return useLoanStore.getState().loans
    .filter((l) => loanIds.has(l.id) && l.type === 'taken' && l.status === 'active' && l.remainingAmount > 0.005)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/**
 * Which of a card's cash advances a bill payment knocks down, and by how much.
 *
 * Lifted OUT of the transfer branch's credit-card tail (L4 step 4) so the
 * legacy path and the flagged atomic path consume the SAME plan rather than two
 * copies of one rule. The allocation itself lives in
 * src/lib/cardBillAtomicPlan.ts → src/lib/cardStatement.ts; this is only the
 * gathering of its inputs.
 *
 * Reads PRE-payment state exclusively (`cardBalanceBefore` is the card's
 * balance before this payment credits it), which is what makes it correct to
 * call BEFORE the money moves as well as after — the atomic path needs the plan
 * up front, because the RPC applies it in the same transaction as the transfer
 * legs.
 */
async function prepareCardBillPlan(inp: {
  cardId: string;
  cardCurrency: Currency;
  /** The card's balance BEFORE this payment credits it. */
  cardBalanceBefore: number;
  cardMetadata: Record<string, string>;
  /** The payment, in CARD currency (already converted for a cross-currency move). */
  pool: number;
  /** The payment's own date — decides which instalment is "this cycle's". */
  when: Date;
}): Promise<Array<{ loan: Loan; applied: number }>> {
  const cardLimit = parseFloat(inp.cardMetadata?.creditLimit || '0');
  const cardDueDay = parseInt(inp.cardMetadata?.dueDay ?? '', 10);
  const statementNative = cardLimit > 0 && Number.isFinite(cardDueDay) && cardDueDay >= 1;
  const fundedLoans = (await findActiveCashAdvanceLoansForCard(inp.cardId))
    .filter((l) => l.currency === inp.cardCurrency);

  let revolvingPurchases = 0;
  let advances = fundedLoans.map((l) => ({
    loanId: l.id, remaining: l.remainingAmount, dueThisCycle: 0, createdAt: l.createdAt,
  }));

  if (statementNative && fundedLoans.length > 0) {
    const sumRemaining = fundedLoans.reduce((s, l) => s + l.remainingAmount, 0);
    // cardBalanceBefore is the PRE-credit balance, so this is the true
    // pre-payment revolving = used − Σ(advance remaining).
    revolvingPurchases = Math.max(
      0,
      Math.round(((cardLimit - inp.cardBalanceBefore) - sumRemaining) * 100) / 100,
    );
    // "This cycle's instalment" is decided from the PAYMENT's date (a
    // back-dated bill steps the instalment of the statement it paid).
    advances = billAdvancesAsOf({
      loans: fundedLoans,
      schedules: useEmiStore.getState().schedules,
      dueDay: cardDueDay,
      when: inp.when,
    });
  }

  const out: Array<{ loan: Loan; applied: number }> = [];
  for (const line of planCardBillPrincipal({
    pool: inp.pool, statementNative, revolvingPurchases, advances,
  })) {
    const l = fundedLoans.find((f) => f.id === line.loanId);
    if (l) out.push({ loan: l, applied: line.applied });
  }
  return out;
}

/**
 * Turn a settlement plan into the lines `pay_card_bill` binds, together with
 * the instalment statuses they are about to overwrite (so the scope's inverse
 * can restore them exactly, including 'late').
 *
 * The instalment coverage is `planRepaymentEmiMarks` — the same pure function
 * step 2 uses — which reproduces `trackedMarkCoveredEmisPaid` exactly: the
 * oldest instalments the paid-down total will fully cover, computed from the
 * remaining the payment WILL leave, not the one it starts from.
 *
 * `rowNote` non-null means "each line writes its own ledger row" (a bill
 * payment). Null means the MAIN row is the record (a cash-advance repayment),
 * and a second row would double-count the payment.
 */
function toCardBillLines(
  plan: Array<{ loan: Loan; applied: number }>,
  rowNote: string | null,
  targetedEmiId?: string,
): { lines: CardBillPlanLine[]; emiBefore: { id: string; status: EmiStatus }[] } {
  const all = useEmiStore.getState().schedules;
  const lines: CardBillPlanLine[] = [];
  const emiBefore: { id: string; status: EmiStatus }[] = [];
  for (const { loan, applied } of plan) {
    if (applied <= 0.005) continue;
    const planned = planRepaymentEmiMarks({
      schedules: all.filter((e) => e.loanId === loan.id),
      loanTotalAmount: loan.totalAmount,
      remainingBefore: loan.remainingAmount,
      amount: applied,
      targetedEmiId,
    });
    for (const id of planned.allIds) {
      const e = all.find((s) => s.id === id);
      if (e) emiBefore.push({ id: e.id, status: e.status });
    }
    lines.push({
      loanId: loan.id,
      applied,
      expectedRemaining: loan.remainingAmount,
      emiIds: planned.allIds,
      rowId: rowNote === null ? null : uuid(),
      rowNote: rowNote ?? '',
    });
  }
  return { lines, emiBefore };
}

// Two-way EMI reconcile: sync the schedule's binary statuses to the loan's
// CURRENT paid-down amount — marking newly covered instalments paid AND
// un-marking paid instalments the money no longer backs (repayment deleted).
// Must run AFTER the loan row inside the scope reflects its final remaining.
async function trackedSyncEmisToLoan(scope: MutationScope, loanId: string): Promise<void> {
  const loan = useLoanStore.getState().loans.find(l => l.id === loanId);
  if (!loan) return;
  const schedules = useEmiStore.getState().schedules.filter(e => e.loanId === loanId);
  if (schedules.length === 0) return;
  const paid = Math.round((loan.totalAmount - loan.remainingAmount) * 100) / 100;
  const { toPaid, toUpcoming } = statusSyncToPaid(schedules, paid);
  if (toPaid.length === 0 && toUpcoming.length === 0) return;
  const targets = new Map<string, EmiStatus>();
  for (const id of toPaid) targets.set(id, 'paid');
  for (const id of toUpcoming) targets.set(id, 'upcoming');
  const before = schedules
    .filter(e => targets.has(e.id))
    .map(e => ({ id: e.id, status: e.status }));
  await Promise.all([...targets.entries()].map(([id, status]) => emiSchedulesDb.update(id, { status })));
  useEmiStore.setState(state => ({
    schedules: state.schedules.map(e => (targets.has(e.id) ? { ...e, status: targets.get(e.id)! } : e)),
  }));
  scope.register(async () => {
    await Promise.all(before.map(s => emiSchedulesDb.update(s.id, { status: s.status })));
    useEmiStore.setState(state => ({
      schedules: state.schedules.map(e => {
        const prev = before.find(b => b.id === e.id);
        return prev ? { ...e, status: prev.status } : e;
      }),
    }));
  });
}

// The card credit a repayment row actually applied — the clamped figure from
// its internal note when present, else the full row amount. Reversals must
// debit exactly this.
function cardCreditedAmountOf(transaction: Transaction): number {
  const meta = parseInternalNote(transaction.notes).meta;
  const stamped = meta.cardCreditedAmount ? parseFloat(meta.cardCreditedAmount) : NaN;
  return Number.isFinite(stamped) ? stamped : transaction.amount;
}

// ═══════════════════════════════════════════════════════════════════════════
// Money bounds — the client's server of last resort
//
// Audit docs/audit-2026-09/12-qa-review.md V-1 / F-9 (HIGH): "Store-level
// money mutations accept unvalidated amounts for several types (income,
// opening_balance) — the single validation layer is per-form and
// inconsistent; any new caller (AI flows, future outbox replay) can post
// negative/NaN money."
//
// Every guard that existed was in a FORM. QuickEntry, RepaymentModal,
// AddAccountStepper and the AI split confirm each validate well; nothing
// validated at the seam they all funnel through. These run BEFORE
// runSafeMutation opens a scope, so a rejected amount never moves a balance,
// never creates a loan, never writes a trade, and needs no compensation.
//
// The magnitude ceiling and the finiteness rule are shared verbatim with
// supabase-migration-p1-money-bounds.sql, so the client and the DB agree on
// what "absurd" means instead of drifting.
// ═══════════════════════════════════════════════════════════════════════════

// Bilingual via tStatic, like checkBalance above — these surface as toasts on
// every money surface, in both languages.
function moneyProblemMessage(problem: MoneyAmountProblem, allowZero: boolean): string {
  if (problem === 'not_a_number') return tStatic('err_money_amount_invalid');
  if (problem === 'too_large') return tStatic('err_money_amount_too_large');
  return tStatic(allowZero ? 'err_money_amount_negative' : 'err_money_amount_not_positive');
}

function assertMoneyAmount(amount: number, options: { allowZero?: boolean } = {}): void {
  const problem = checkMoneyAmount(amount, options);
  if (problem) throw new Error(moneyProblemMessage(problem, options.allowZero === true));
}

/**
 * Validate every money value a TransactionInput carries, per type.
 *
 * Traced across all twelve cases of the switch below; the table records who
 * validated what BEFORE this function existed, so the next reader can see
 * which guards are new and which are belt-and-braces:
 *
 *   income            input.amount   — NOTHING validated it. NEW. (F-9)
 *   opening_balance   input.amount   — NOTHING validated it. NEW. (F-9)
 *   expense           input.amount   — only checkBalanceForTransaction, which
 *                                      compares against the balance and is
 *                                      BYPASSED entirely in splits_only mode
 *                                      (isSimpleModeBalanceBypassAllowed), so
 *                                      ledger mode had no amount guard at all.
 *   transfer          input.amount   — only checkBalance (same gap, plus a
 *                                      negative amount would CREDIT the source).
 *   loan_given        input.amount   — checkBalanceForTransaction; bypassed in
 *                                      ledger mode. Also the ad-hoc-split entry
 *                                      point (the 2026-09 "split without a
 *                                      group" feature posts loan_given rows).
 *   loan_taken        input.amount   — nothing on the destination leg; the
 *                                      cash-advance source leg had a balance
 *                                      check only.
 *   repayment         input.amount   — RepaymentModal validates, and
 *                                      loanStore.applyRepayment clamps; but a
 *                                      NaN reached trackedApplyRepayment first.
 *   goal_contribution input.amount   — nothing beyond checkBalance.
 *   adjustment        targetBalance  — nothing. `amount` is ignored by design
 *                                      (the engine derives |delta|), so this
 *                                      bounds the TARGET, which may legitimately
 *                                      be negative (credit cards) — magnitude
 *                                      only, and NaN is rejected because
 *                                      `targetBalance - balance` would be NaN
 *                                      and slip past the `< 0.005` no-op test.
 *   investment_buy    qty/price/fees — validateTradeInput already covers
 *   investment_sell                    finiteness and sign inside the branch;
 *   investment_dividend gross/fees     the magnitude ceiling is what is new.
 *
 * BOTH APP MODES: not one check here reads an account, a balance, or the app
 * mode. A splits_only (ledger-only) entry — where both account ids end up null
 * — is validated identically to a full-tracker one. That is deliberate: the
 * balance-based guards are exactly the ones ledger mode switches off, which is
 * why ledger mode had no amount protection before this.
 */
function assertInputAmountsInBounds(input: TransactionInput): void {
  switch (input.type) {
    case 'adjustment':
      // Not an amount that moves — a target the balance is set TO. Negative is
      // correct for a credit card carrying debt, so only magnitude and
      // finiteness are asserted.
      if (!Number.isFinite(input.targetBalance)) {
        throw new Error(tStatic('err_money_amount_invalid'));
      }
      if (Math.abs(input.targetBalance) >= MAX_MONEY_MAGNITUDE) {
        throw new Error(tStatic('err_money_amount_too_large'));
      }
      return;

    case 'investment_buy':
    case 'investment_sell':
      // Sign and finiteness: validateTradeInput, inside the branch.
      // Magnitude: here, so a 1e300 price can't overflow the derived cash
      // amount before that branch ever runs.
      assertMoneyAmount(input.quantity, { allowZero: true });
      assertMoneyAmount(input.pricePerUnit, { allowZero: true });
      assertMoneyAmount(input.fees, { allowZero: true });
      return;

    case 'investment_dividend':
      assertMoneyAmount(input.grossAmount);
      assertMoneyAmount(input.fees, { allowZero: true });
      return;

    default:
      // The nine value-carrying types. Strictly positive: an income, expense,
      // loan, repayment, transfer, goal contribution or opening balance of
      // exactly 0 is not a record, it is a no-op that still writes a row and
      // an activity entry.
      assertMoneyAmount(input.amount);
  }
}

export const useTransactionStore = create<TransactionState>((set, get) => ({
  ...INITIAL_TRANSACTION_STATE,

  reset: () => {
    // A user switch must drop the coverage claim with the rows — otherwise the
    // next account inherits "we hold everything" over an empty store.
    inFlightHistory.clear();
    set({ ...INITIAL_TRANSACTION_STATE, historyCoverage: emptyCoverage() });
    // ...and the PERSISTED floor with it. `resetAllUserStores` runs every
    // store's reset() before it deletes this user's Dexie partition, so this
    // still targets the outgoing user's row; the wipe that follows would remove
    // it anyway. Belt and braces, because the one thing worse than an extra
    // fetch is the next account inheriting a claim over data it cannot see.
    void clearMirrorCoverage(TRANSACTIONS_MIRROR_KEY);
  },

  loadTransactions: async (options) => {
    // The BOUNDED default (docs/performance.md §7). This used to be a keyset
    // walk of the user's entire transactions table on every boot, every money
    // write and every realtime nudge; it now asks for the last 12 months or the
    // newest 1000 rows, whichever reaches further back, and records what that
    // proves in `historyCoverage`.
    //
    // The floor never narrows: `planHistoryLoad` takes the EARLIEST of the
    // window start, the coverage we already established and any explicit
    // `since`. A user who tapped "Show full history" and then saved an expense
    // is not silently demoted back to 12 months by the reload that follows.
    const plan = planHistoryLoad({
      coverage: get().historyCoverage,
      requestedSince: options?.since ?? null,
    });
    // Set by fetchRemote — which loadCacheFirst SKIPS on the cache-hit and
    // incremental plans. Staying null there is correct: no rows were fetched,
    // so no new guarantee was earned and coverage is left exactly as it was.
    let fetchedCoverage: HistoryCoverage | null = null;

    set({ loading: true });
    try {
      const { rows: transactions, fromCache } = await loadCacheFirst<Transaction>({
        key: TRANSACTIONS_MIRROR_KEY,
        table: db.transactions,
        fetchRemote: async () => {
          if (plan.all) {
            // Paged variant: it reports whether PostgREST truncated the result,
            // so the mirror merges instead of clearing away history it never saw.
            const result = await transactionsDb.getAllPaged();
            fetchedCoverage = result.truncated
              ? { since: oldestCreatedAt(result.rows), complete: false }
              : fullCoverage();
            return result;
          }
          const result = await transactionsDb.getWindowPaged({
            since: plan.since,
            minRows: HISTORY_MIN_ROWS,
          });
          fetchedCoverage = result.complete
            ? fullCoverage()
            : { since: result.coveredSince, complete: false };
          return {
            rows: result.rows,
            // A window is a PARTIAL set by construction — never let the mirror
            // clear on it. `completeFrom` additionally lets mirrorCache prune
            // rows deleted elsewhere INSIDE the window without touching the
            // older history it is keeping for us.
            truncated: !result.complete,
            completeFrom: result.complete ? undefined : result.coveredSince,
            // The DAL's own max-rows warning, kept separate from the flag
            // above: `truncated` here only means "a window is partial, do not
            // clear", and is true on every windowed fetch. This one means the
            // SERVER under-reported, and it is what drops the persisted
            // coverage floor (docs/performance.md §7.1).
            serverTruncated: result.truncated,
          };
        },
        fetchUpdatedSince: transactionsDb.getUpdatedSince,
        fetchDeletedSince: transactionsDb.getDeletedSince,
        getUpdatedAt: (transaction) => transaction.updatedAt ?? transaction.createdAt,
        // Ledger-only rows (BOTH account ids null) are ordered and windowed by
        // `createdAt` exactly like full-tracker rows — no account id is read
        // anywhere on this path, in either app mode.
        windowKeyOf: (transaction) => transaction.createdAt,
        sort: (a, b) => b.createdAt.localeCompare(a.createdAt),
        // A background refresh used to land in Dexie only, leaving the list
        // rendering the pre-refresh snapshot (audit 04-supabase F-RT1).
        onRefreshed: (rows) => {
          set({ transactions: rows });
          // The background full refresh DID fetch, so it earned a guarantee —
          // one that used to be thrown away because `loadTransactions` had
          // already returned by the time `fetchRemote` ran. It lands here, after
          // the mirror merge that produced these rows.
          if (fetchedCoverage) adoptHistoryCoverage(fetchedCoverage);
        },
      });
      set({ transactions });
      if (fetchedCoverage) {
        adoptHistoryCoverage(fetchedCoverage);
      } else if (fromCache) {
        // A cache-answered load fetched nothing, so it PROVED nothing on its
        // own — that is why it earned no coverage before. It may now adopt the
        // floor the mirror itself carries, but only when the sync cursors say
        // an incremental diff is what runs next; if the daily full refresh is
        // due, the stored floor is not believed until that refresh lands and
        // re-establishes it (`persistedCoverageIsTrustworthy`).
        const seeded = await readMirrorCoverageSeed(TRANSACTIONS_MIRROR_KEY, {
          hasCache: transactions.length > 0,
          canIncremental: true,
        });
        if (seeded.complete || seeded.since) {
          // Merged into state directly, NOT through `adoptHistoryCoverage`:
          // this is a claim read back off disk, not one this load proved, so it
          // must not be written back as if it were newly earned.
          set((s) => ({ historyCoverage: mergeCoverage(s.historyCoverage, seeded) }));
        }
      }
    } finally {
      set({ loading: false });
    }
  },

  ensureTransactionHistory: async (requested = { all: true }) => {
    // A caller that names no horizon is asking for everything — the same rule
    // `coverageSatisfies` applies. Normalised HERE so `{ since: undefined }`
    // (an easy accident at a call site computing a date) can never degrade into
    // a silent no-op that leaves a statement computing on a window.
    const request: HistoryRequest =
      requested.all || requested.since ? requested : { all: true };
    if (coverageSatisfies(get().historyCoverage, request)) return;

    const key = historyRequestKey(request);
    const existing = inFlightHistory.get(key);
    if (existing) return existing;

    const job = (async () => {
      set({ historyLoading: true });
      try {
        if (request.all) {
          const result = await transactionsDb.getAllPaged();
          // Merge, never replace: the fetch is authoritative for the rows it
          // returned, and the store/mirror may hold rows written locally in the
          // same tick. `mergeTransactionRows` keeps both.
          await mirrorBulkPut(db.transactions, result.rows);
          mergeHistoryIntoStore(result.rows);
          // After the mirror write, never before — the persisted floor this
          // widens is a promise about rows that are in the mirror.
          adoptHistoryCoverage(
            result.truncated
              ? { since: oldestCreatedAt(result.rows), complete: false }
              : fullCoverage(),
          );
          return;
        }

        const since = request.since ?? null;
        if (!since) return;
        // Only the gap BELOW the floor we already hold — not the whole table.
        const gap = historyGap(get().historyCoverage, since);
        const result = await transactionsDb.getRangePaged(gap.from, gap.to);
        await mirrorBulkPut(db.transactions, result.rows);
        mergeHistoryIntoStore(result.rows);
        adoptHistoryCoverage(
          // A truncated gap walk did not reach `since`; claim only the oldest
          // row it actually read, so the next request re-tries the remainder.
          { since: result.truncated ? oldestCreatedAt(result.rows) : since, complete: false },
        );
      } finally {
        set({ historyLoading: false });
        inFlightHistory.delete(key);
      }
    })();

    inFlightHistory.set(key, job);
    return job;
  },

  processTransaction: async (input) => {
    // FIRST line, before any store load and before runSafeMutation opens a
    // scope: a bad amount must fail with nothing to compensate. See
    // assertInputAmountsInBounds for the per-type trace (audit V-1/F-9).
    assertInputAmountsInBounds(input);

    await ensureSupportingStoresLoaded();
    // Investment branches need markets/trades; loaded lazily so non-investment
    // users never pay a fetch for permanently-empty tables.
    if (input.type === 'investment_buy' || input.type === 'investment_sell' || input.type === 'investment_dividend') {
      const inv = useInvestmentStore.getState();
      if (inv.markets.length === 0) await inv.loadInvestments();
    }

    const { transaction, description } = await runSafeMutation<{ transaction: Transaction; description: string }>(
      async (scope) => {
        const accountStore = useAccountStore.getState();
        const loanStore = useLoanStore.getState();
        const goalStore = useGoalStore.getState();

        // Generated before the switch so investment branches can stamp the
        // trade row's transactionId at insert time — no post-hoc patch write.
        const transactionId = uuid();
        // Investment branches compute the true cash amount (qty × price ± fees)
        // themselves; every other branch leaves this as the caller's amount.
        let amount = input.amount;
        let currency: Currency = 'AED';
        let sourceAccountId: string | null = null;
        let destinationAccountId: string | null = null;
        let relatedPerson: string | null = null;
        let personId: string | null = null;
        let relatedLoanId: string | null = null;
        let relatedGoalId: string | null = null;
        let relatedInvestmentId: string | null = null;
        let conversionRate: number | null = null;
        let description = '';
        // Set when a branch needs to stamp internal meta into the row's notes
        // (e.g. a clamped card credit); wins over input.notes at build time.
        let notesOverride: string | null = null;

        switch (input.type) {
          case 'income': {
            // input.amount is already bounded (finite, > 0, < 1e12) by
            // assertInputAmountsInBounds at the top of processTransaction —
            // this branch used to be the one with NO amount guard at all
            // (audit V-1/F-9). Nothing else here may assume it.
            const destAccount = accountStore.getAccount(input.destinationAccountId);
            if (!destAccount) throw new Error('Destination account not found');
            currency = destAccount.currency;
            destinationAccountId = input.destinationAccountId;
            if (ATOMIC_SINGLE_LEG_ENABLED) {
              // ── L4 STEP 5 ─────────────────────────────────────────────────
              // Pin the timestamp BEFORE the server writes the row, so the
              // tail's `input.createdAt ?? new Date().toISOString()` produces
              // the identical value and its idempotent upsert rewrites the same
              // row rather than a differently-stamped one. (The transfer pilot
              // established this; see supabase-migration-p3-atomic-transfer.sql.)
              input.createdAt = input.createdAt ?? new Date().toISOString();
              await atomicSingleLeg(scope, {
                transactionId, type: 'income',
                accountId: input.destinationAccountId,
                amount: input.amount, targetBalance: null,
                note: input.notes ?? '', category: input.category ?? '',
                createdAt: input.createdAt,
                // income has no balance guard at all, in either mode.
                allowNegative: false,
              });
            } else {
              await trackedBalanceDelta(scope, input.destinationAccountId, input.amount);
            }
            description = `Income of ${currency} ${input.amount} → ${destAccount.name}`;
            break;
          }

          case 'expense': {
            const srcAccount = accountStore.getAccount(input.sourceAccountId);
            if (!srcAccount) throw new Error('Source account not found');
            checkBalanceForTransaction(srcAccount, input.amount, input.type);
            currency = srcAccount.currency;
            sourceAccountId = input.sourceAccountId;
            if (ATOMIC_SINGLE_LEG_ENABLED) {
              input.createdAt = input.createdAt ?? new Date().toISOString();
              await atomicSingleLeg(scope, {
                transactionId, type: 'expense',
                accountId: input.sourceAccountId,
                amount: input.amount, targetBalance: null,
                note: input.notes ?? '', category: input.category ?? '',
                createdAt: input.createdAt,
                // TRUE only where checkBalanceForTransaction above was a no-op
                // — splits_only mode, which deliberately lets an expense make
                // an account negative.
                allowNegative: isSimpleModeBalanceBypassAllowed('expense'),
              });
            } else {
              await trackedBalanceDelta(scope, input.sourceAccountId, -input.amount);
            }
            description = `Expense of ${currency} ${input.amount} from ${srcAccount.name}`;
            break;
          }

          case 'transfer': {
            const src = accountStore.getAccount(input.sourceAccountId);
            const dest = accountStore.getAccount(input.destinationAccountId);
            if (!src || !dest) throw new Error('Account not found');
            if (src.id === dest.id) throw new Error('Choose a different destination account');
            checkBalance(src, input.amount);
            currency = src.currency;
            sourceAccountId = input.sourceAccountId;
            destinationAccountId = input.destinationAccountId;

            // Cross-currency check runs BEFORE any balance movement so we
            // don't debit the source and then realise we can't credit the
            // destination.
            if (src.currency !== dest.currency && !input.conversionRate) {
              throw new Error('Conversion rate required for cross-currency move');
            }

            // ── L4 STEP 4, branch 5 (audit MF-01 / F-2 / O-1 / F-4) ───────
            // Paying a card bill is the LARGEST flow in this switch: two
            // balances and a row, PLUS a loan compare-and-swap, N instalment
            // writes and a ledger row for every cash advance the card funded.
            // A drop partway leaves a PAID bill whose loans still say the money
            // is owed — so the app asks the user to pay the same debt twice.
            //
            // The plan is therefore computed BEFORE any money moves, because
            // `pay_card_bill` applies it in the SAME transaction as the
            // transfer legs. It reads only PRE-payment state (`dest.balance`
            // was captured above, before either leg), so hoisting it is
            // invisible to the legacy path below, which consumes the identical
            // plan through the identical helper.
            const payingCardBill = dest.type === 'credit_card';
            const billPool = src.currency !== dest.currency
              ? Math.round(input.amount * (input.conversionRate ?? 0) * 100) / 100
              : input.amount;
            const cardPlan = payingCardBill
              ? await prepareCardBillPlan({
                cardId: dest.id,
                cardCurrency: dest.currency,
                cardBalanceBefore: dest.balance,
                cardMetadata: dest.metadata ?? {},
                pool: billPool,
                when: input.createdAt ? new Date(input.createdAt) : new Date(),
              })
              : [];
            // With NOTHING to settle, a card transfer is a plain two-leg move
            // and step 1 already owns it — routing it here would add a plan
            // parameter and a second code path for no atomicity gain.
            const useCardBillAtomic = ATOMIC_CARD_BILL_ENABLED
              && payingCardBill
              && cardPlan.some((p) => p.applied > 0.005);

            if (useCardBillAtomic) {
              // Pin the timestamp BEFORE the server writes the rows, so the
              // tail's `input.createdAt ?? new Date().toISOString()` produces
              // the identical value and its idempotent upsert rewrites the same
              // row rather than a differently-stamped one.
              input.createdAt = input.createdAt ?? new Date().toISOString();
              const rowNote = buildInternalNote('Covered by card bill payment', {
                linkedTransactionId: transactionId,
              });

              const applied = await atomicPayCardBill(scope, {
                transactionId,
                rowType: 'transfer',
                sourceAccountId: input.sourceAccountId,
                cardAccountId: input.destinationAccountId,
                amount: input.amount,
                sourceAmount: input.amount,
                // A direct transfer's card credit is DELIBERATELY UNCLAMPED
                // (src/lib/cardCredit.ts:7-9): an explicit "I moved money" is
                // recorded as typed, and the UI surfaces the overpaid state.
                cardAmount: billPool,
                currency,
                conversionRate: src.currency !== dest.currency ? input.conversionRate! : null,
                note: input.notes ?? '',
                category: input.category ?? '',
                createdAt: input.createdAt,
                // Re-planned on every attempt: after a conflict refetch the
                // loans' remaining amounts have changed, so the allocation has.
                buildPlan: async () => toCardBillLines(
                  await prepareCardBillPlan({
                    cardId: dest.id,
                    cardCurrency: dest.currency,
                    cardBalanceBefore:
                      useAccountStore.getState().getAccount(dest.id)?.balance ?? dest.balance,
                    cardMetadata: dest.metadata ?? {},
                    pool: billPool,
                    when: new Date(input.createdAt!),
                  }),
                  rowNote,
                ),
                // A transfer uses the strict `checkBalance` — there is no
                // splits_only bypass for it (it is absent from
                // isSimpleModeBalanceBypassAllowed), so this is always false.
                allowNegative: false,
              });

              if (src.currency !== dest.currency) {
                conversionRate = input.conversionRate!;
                description = `Moved ${src.currency} ${input.amount} → ${dest.currency} ${billPool} (rate: ${conversionRate})`;
              } else {
                description = `Moved ${currency} ${input.amount}: ${src.name} → ${dest.name}`;
              }
              if (applied.settled > 0) {
                description += ` · settled ${applied.settled} cash-advance record${applied.settled > 1 ? 's' : ''}`;
              }
            } else if (ATOMIC_TRANSFER_ENABLED) {
              // ── L4 PILOT (audit MF-01 / O-1 / F-4) ──────────────────────
              // ONE server-side transaction moves both legs and writes the
              // row, so a network drop between them can no longer leave the
              // source debited and the destination uncredited. Everything
              // below the switch — the Transaction object, the mirror, the
              // activity entry, the reminder nudge, and the card-bill
              // auto-settle immediately after this block — is unchanged: see
              // the artifact contract table in
              // supabase-migration-p3-atomic-transfer.sql.
              const destAmount = src.currency !== dest.currency
                ? Math.round(input.amount * input.conversionRate! * 100) / 100
                : input.amount;

              // Pin the timestamp BEFORE the server writes the row, so the
              // tail's `input.createdAt ?? new Date().toISOString()` produces
              // the identical value and its idempotent upsert rewrites the
              // same row rather than a differently-stamped one.
              input.createdAt = input.createdAt ?? new Date().toISOString();

              const applied = await atomicTransfer(scope, {
                transactionId,
                sourceAccountId: input.sourceAccountId,
                destinationAccountId: input.destinationAccountId,
                amount: input.amount,
                destinationAmount: destAmount,
                conversionRate: src.currency !== dest.currency ? input.conversionRate! : null,
                note: input.notes ?? '',
                category: input.category ?? '',
                createdAt: input.createdAt,
                sourceDelta: -Math.round(input.amount * 100) / 100,
                destinationDelta: Math.round(destAmount * 100) / 100,
              });

              if (src.currency !== dest.currency) {
                conversionRate = input.conversionRate!;
                description = `Moved ${src.currency} ${input.amount} → ${dest.currency} ${applied.destinationAmount ?? destAmount} (rate: ${conversionRate})`;
              } else {
                description = `Moved ${currency} ${input.amount}: ${src.name} → ${dest.name}`;
              }
            } else {
              await trackedBalanceDelta(scope, input.sourceAccountId, -input.amount);

              if (src.currency !== dest.currency) {
                conversionRate = input.conversionRate!;
                const destAmount = Math.round(input.amount * conversionRate * 100) / 100;
                await trackedBalanceDelta(scope, input.destinationAccountId, destAmount);
                description = `Moved ${src.currency} ${input.amount} → ${dest.currency} ${destAmount} (rate: ${conversionRate})`;
              } else {
                await trackedBalanceDelta(scope, input.destinationAccountId, input.amount);
                description = `Moved ${currency} ${input.amount}: ${src.name} → ${dest.name}`;
              }
            }

            // Paying a card bill IS paying back its cash advances — the same
            // debt lives in two records (card balance + loan). We knock the
            // paid amount off the funded loans as ledger-only repayments (no
            // account legs — the money already moved via the transfer legs
            // above); without this, a paid bill left the loan open and forced
            // a second "pay" (the double-credit disaster).
            //
            // STATEMENT-NATIVE allocation: this cycle's instalment(s) first,
            // then purchases, then prepay — so paying THIS month's statement
            // steps each plan one instalment (not the whole advance), while
            // paying the full balance still clears everything. A card missing
            // a limit or statement day falls back to the legacy greedy settle
            // (no behaviour change for those).
            //
            // The plan itself is `cardPlan`, computed above — the SAME helper
            // the atomic path uses, so the two cannot drift. When the atomic
            // path ran, it already applied all of this inside the RPC's
            // transaction and this block is skipped entirely.
            if (payingCardBill && !useCardBillAtomic) {
              let settledCount = 0;
              for (const { loan: fundedLoan, applied } of cardPlan) {
                if (applied <= 0.005) continue;
                await trackedApplyRepayment(scope, fundedLoan.id, applied);
                await trackedMarkCoveredEmisPaid(scope, fundedLoan.id);
                const record: Transaction = {
                  id: uuid(),
                  type: 'repayment',
                  amount: applied,
                  currency: fundedLoan.currency,
                  sourceAccountId: null,
                  destinationAccountId: null,
                  relatedPerson: fundedLoan.personName,
                  personId: fundedLoan.personId ?? null,
                  relatedLoanId: fundedLoan.id,
                  relatedGoalId: null,
                  relatedInvestmentId: null,
                  conversionRate: null,
                  category: '',
                  notes: buildInternalNote('Covered by card bill payment', { linkedTransactionId: transactionId }),
                  createdAt: input.createdAt ?? new Date().toISOString(),
                  isReconciled: false,
                  reconciledAt: null,
                  reconciledBy: null,
                };
                record.updatedAt = record.createdAt;
                await trackedAddTransaction(scope, record);
                settledCount += 1;
              }
              if (settledCount > 0) {
                description += ` · settled ${settledCount} cash-advance record${settledCount > 1 ? 's' : ''}`;
              }
            }
            break;
          }

          case 'loan_given': {
            const src = accountStore.getAccount(input.sourceAccountId);
            if (!src) throw new Error('Source account not found');
            checkBalanceForTransaction(src, input.amount, input.type);
            currency = src.currency;
            sourceAccountId = input.sourceAccountId;
            relatedPerson = input.personName;
            personId = input.personId ?? null;

            // Only the human-visible part. Loan.notes is rendered RAW on
            // LoansPage, LoanDetailPage, the repayment allocators and
            // statements, so a caller that stamps internal meta into the
            // transaction note (ad-hoc splits) must not leak
            // `[[HISAAB_META:…]]` into all of them.
            const givenLoanNotes = parseInternalNote(input.notes).visibleNote;

            if (ATOMIC_LOAN_CREATE_ENABLED) {
              // ── L4 STEP 3 (audit MF-01 / O-1 / F-4) ─────────────────────
              // ONE server-side transaction debits the funding account, brings
              // the loan into existence AND writes the row — so a network drop
              // between them can no longer take money out of a wallet with no
              // loan saying who owes it. Everything below the switch (the
              // Transaction object, the mirror, the activity entry, the
              // reminder nudge) is unchanged: see the artifact contract table
              // in supabase-migration-p3-atomic-loan-create.sql.
              //
              // Pin the timestamp BEFORE the server writes the row, so the
              // tail's `input.createdAt ?? new Date().toISOString()` produces
              // the identical value and its idempotent upsert rewrites the
              // same row rather than a differently-stamped one.
              input.createdAt = input.createdAt ?? new Date().toISOString();
              relatedLoanId = input.loanId ?? uuid();

              await atomicLoanCreate(scope, {
                transactionId,
                loanId: relatedLoanId,
                createLoan: !input.loanId,
                direction: 'given',
                personName: input.personName,
                personId: input.personId ?? null,
                accountId: input.sourceAccountId,
                cardAccountId: null,
                amount: input.amount,
                currency,
                note: input.notes ?? '',
                category: input.category ?? '',
                createdAt: input.createdAt,
                loanNotes: givenLoanNotes,
                // The instalment plan the page computed BEFORE this call, so
                // it commits with the loan instead of after it.
                emiRows: input.emiPlan ?? null,
                // Ledger mode deliberately lets a loan push an account
                // negative (isSimpleModeBalanceBypassAllowed waives
                // checkBalanceForTransaction above); the server guard has to be
                // waived in exactly the same case, and only that case.
                allowNegative: isSimpleModeBalanceBypassAllowed('loan_given'),
              });
            } else {
              await trackedBalanceDelta(scope, input.sourceAccountId, -input.amount);

              if (!input.loanId) {
                const loan = await trackedCreateLoan(scope, {
                  personName: input.personName,
                  personId: input.personId ?? null,
                  type: 'given',
                  totalAmount: input.amount,
                  currency,
                  notes: givenLoanNotes,
                });
                relatedLoanId = loan.id;
              } else {
                relatedLoanId = input.loanId;
              }
            }
            description = `Loan given to ${input.personName}: ${currency} ${input.amount}`;
            break;
          }

          case 'loan_taken': {
            const dest = accountStore.getAccount(input.destinationAccountId);
            if (!dest) throw new Error('Destination account not found');
            currency = dest.currency;
            destinationAccountId = input.destinationAccountId;
            relatedPerson = input.personName;
            personId = input.personId ?? null;

            // Every cash-advance guard runs BEFORE any money moves, on both
            // paths — shared and byte-for-byte unchanged.
            if (input.sourceAccountId) {
              const src = accountStore.getAccount(input.sourceAccountId);
              if (!src) throw new Error('Source account not found');
              if (src.type !== 'credit_card') throw new Error('Cash advance source must be a credit card account');
              if (src.currency !== dest.currency) throw new Error('Cash advance source card must match the receiving account currency');
              checkBalanceForTransaction(src, input.amount, input.type);
              sourceAccountId = input.sourceAccountId;
              description = `Cash advance from ${src.name} into ${dest.name}: ${currency} ${input.amount}`;
            }

            // Human-visible part only — see the loan_given branch above.
            const takenLoanNotes = parseInternalNote(input.notes).visibleNote;

            if (ATOMIC_LOAN_CREATE_ENABLED) {
              // ── L4 STEP 3 (audit MF-01 / O-1 / F-4) ─────────────────────
              // ONE server-side transaction charges the cash-advance card (when
              // there is one), credits the receiving account, brings the loan
              // into existence AND writes the row. The four-leg cash advance is
              // the worst instance of MF-01 in the whole switch: today a drop
              // after the card leg leaves available credit consumed and the
              // cash arriving nowhere. See the artifact contract table in
              // supabase-migration-p3-atomic-loan-create.sql.
              //
              // Pin the timestamp BEFORE the server writes the row — see the
              // loan_given branch.
              input.createdAt = input.createdAt ?? new Date().toISOString();
              relatedLoanId = input.loanId ?? uuid();

              await atomicLoanCreate(scope, {
                transactionId,
                loanId: relatedLoanId,
                createLoan: !input.loanId,
                direction: 'taken',
                personName: input.personName,
                personId: input.personId ?? null,
                accountId: input.destinationAccountId,
                cardAccountId: input.sourceAccountId ?? null,
                amount: input.amount,
                currency,
                note: input.notes ?? '',
                category: input.category ?? '',
                createdAt: input.createdAt,
                loanNotes: takenLoanNotes,
                // The instalment plan the page computed BEFORE this call. For a
                // cash advance these are the statement-anchored dates
                // (statementInstalmentDates), planned by QuickEntry.
                emiRows: input.emiPlan ?? null,
                // Ledger mode waives checkBalanceForTransaction on the card
                // leg above; the server guard is waived in exactly that case.
                allowNegative: isSimpleModeBalanceBypassAllowed('loan_taken'),
              });
            } else {
              if (input.sourceAccountId) {
                await trackedBalanceDelta(scope, input.sourceAccountId, -input.amount);
              }

              await trackedBalanceDelta(scope, input.destinationAccountId, input.amount);

              if (!input.loanId) {
                const loan = await trackedCreateLoan(scope, {
                  personName: input.personName,
                  personId: input.personId ?? null,
                  type: 'taken',
                  totalAmount: input.amount,
                  currency,
                  notes: takenLoanNotes,
                });
                relatedLoanId = loan.id;
              } else {
                relatedLoanId = input.loanId;
              }
            }
            if (!description) {
              description = `Loan taken from ${input.personName}: ${currency} ${input.amount}`;
            }
            break;
          }

          case 'repayment': {
            const loan = loanStore.getLoan(input.loanId);
            if (!loan) throw new Error('Loan not found');
            relatedLoanId = input.loanId;
            relatedPerson = loan.personName;
            personId = loan.personId ?? null;
            currency = loan.currency;

            // ── L4 step 2 (flag-gated) ────────────────────────────────────
            // When set, the account leg is NOT applied here: it rides into
            // `record_loan_repayment` together with the loan leg, the EMI
            // marks and the transactions row. Everything else in this branch —
            // the guards, the currency arithmetic, the descriptions — is
            // shared and byte-for-byte unchanged.
            let atomicLeg: { accountId: string; accountAmount: number } | null = null;

            // ── L4 step 4b (flag-gated) ───────────────────────────────────
            // The case step 2 deliberately left behind: a repayment that ALSO
            // credits a cash-advance credit card. Two account legs plus the
            // clampCardCredit rule, which `record_loan_repayment`'s single
            // account id cannot express — so it rides into `pay_card_bill`
            // instead, as a one-line plan whose MAIN row is the record.
            let cardBillLeg: {
              accountId: string;
              sourceAmount: number;
              cardId: string;
              credited: number;
            } | null = null;

            if (loan.type === 'given') {
              if (!input.destinationAccountId) throw new Error('Destination account required');
              const dest = accountStore.getAccount(input.destinationAccountId);
              if (!dest) throw new Error('Destination account not found');
              destinationAccountId = input.destinationAccountId;

              if (dest.currency !== loan.currency) {
                if (!input.conversionRate) throw new Error('Conversion rate required — different currencies');
                conversionRate = input.conversionRate;
                const destAmt = Math.round(input.amount * input.conversionRate * 100) / 100;
                if (ATOMIC_REPAYMENT_ENABLED) {
                  atomicLeg = { accountId: input.destinationAccountId, accountAmount: destAmt };
                } else {
                  await trackedBalanceDelta(scope, input.destinationAccountId, destAmt);
                }
                description = `Received ${loan.currency} ${input.amount} → ${dest.currency} ${destAmt} from ${loan.personName} (rate: ${input.conversionRate})`;
              } else {
                if (ATOMIC_REPAYMENT_ENABLED) {
                  atomicLeg = { accountId: input.destinationAccountId, accountAmount: input.amount };
                } else {
                  await trackedBalanceDelta(scope, input.destinationAccountId, input.amount);
                }
                description = `Received ${currency} ${input.amount} from ${loan.personName}`;
              }
            } else {
              if (!input.sourceAccountId) throw new Error('Source account required');
              const src = accountStore.getAccount(input.sourceAccountId);
              if (!src) throw new Error('Source account not found');
              const cashAdvanceCardId = await findCashAdvanceCardForLoan(input.loanId);
              const cashAdvanceCard = cashAdvanceCardId ? accountStore.getAccount(cashAdvanceCardId) : null;
              if (cashAdvanceCard && cashAdvanceCard.currency !== loan.currency) {
                throw new Error('Cash advance card currency must match the loan currency');
              }

              // Card credit is CLAMPED to the card's remaining headroom. If the
              // bill was already paid another way (a transfer), headroom is 0 and
              // the credit leg is skipped entirely — the same debt must never be
              // credited back twice (the Available-above-Limit bug). When the
              // clamp bites partially, the actual credited figure is stamped into
              // the row's internal note so deletion reverses exactly that.
              const cardCredit = cashAdvanceCard
                ? clampCardCredit(cashAdvanceCard, input.amount)
                : { credited: 0, skipped: 0 };

              // The cash-advance CARD CREDIT is a second account leg plus the
              // clampCardCredit business rule, and `record_loan_repayment`
              // takes exactly one account — so step 2 left this case on the
              // legacy path (see the artifact table in
              // supabase-migration-p3-atomic-repayment.sql §8.1). L4 STEP 4
              // picks it up: `pay_card_bill` takes BOTH accounts, and the
              // clamped figure the client computed is re-validated against the
              // card's own headroom server-side.
              const creditsTheCard = Boolean(cashAdvanceCard) && cardCredit.credited > 0;
              const useCardBillHere = ATOMIC_CARD_BILL_ENABLED && creditsTheCard;
              const useAtomicHere = ATOMIC_REPAYMENT_ENABLED && !creditsTheCard;

              if (src.currency !== loan.currency) {
                if (!input.conversionRate) throw new Error('Conversion rate required — different currencies');
                conversionRate = input.conversionRate;
                const srcDeduct = Math.round(input.amount / input.conversionRate * 100) / 100;
                checkBalanceForTransaction(src, srcDeduct, input.type);
                sourceAccountId = input.sourceAccountId;
                if (useAtomicHere) {
                  atomicLeg = { accountId: input.sourceAccountId, accountAmount: srcDeduct };
                } else if (!useCardBillHere) {
                  await trackedBalanceDelta(scope, input.sourceAccountId, -srcDeduct);
                }
                if (cashAdvanceCard && cardCredit.credited > 0) {
                  destinationAccountId = cashAdvanceCard.id;
                  if (useCardBillHere) {
                    cardBillLeg = {
                      accountId: input.sourceAccountId,
                      sourceAmount: srcDeduct,
                      cardId: cashAdvanceCard.id,
                      credited: cardCredit.credited,
                    };
                  } else {
                    await trackedBalanceDelta(scope, cashAdvanceCard.id, cardCredit.credited);
                  }
                  description = `Repaid ${loan.currency} ${cardCredit.credited} to ${cashAdvanceCard.name} from ${src.name} (deducted ${src.currency} ${srcDeduct}, rate: ${input.conversionRate})`;
                } else if (cashAdvanceCard) {
                  description = `Repaid ${loan.currency} ${input.amount} on the ${cashAdvanceCard.name} cash advance from ${src.name} — card bill already covered (rate: ${input.conversionRate})`;
                } else {
                  description = `Repaid ${loan.currency} ${input.amount} (deducted ${src.currency} ${srcDeduct}) to ${loan.personName} (rate: ${input.conversionRate})`;
                }
              } else {
                checkBalanceForTransaction(src, input.amount, input.type);
                sourceAccountId = input.sourceAccountId;
                if (useAtomicHere) {
                  atomicLeg = { accountId: input.sourceAccountId, accountAmount: input.amount };
                } else if (!useCardBillHere) {
                  await trackedBalanceDelta(scope, input.sourceAccountId, -input.amount);
                }
                if (cashAdvanceCard && cardCredit.credited > 0) {
                  destinationAccountId = cashAdvanceCard.id;
                  if (useCardBillHere) {
                    cardBillLeg = {
                      accountId: input.sourceAccountId,
                      sourceAmount: input.amount,
                      cardId: cashAdvanceCard.id,
                      credited: cardCredit.credited,
                    };
                  } else {
                    await trackedBalanceDelta(scope, cashAdvanceCard.id, cardCredit.credited);
                  }
                  description = `Repaid ${currency} ${cardCredit.credited} to ${cashAdvanceCard.name} from ${src.name}`;
                } else if (cashAdvanceCard) {
                  description = `Repaid ${currency} ${input.amount} on the ${cashAdvanceCard.name} cash advance from ${src.name} — card bill already covered`;
                } else {
                  description = `Repaid ${currency} ${input.amount} to ${loan.personName}`;
                }
              }

              if (cashAdvanceCard && cardCredit.credited > 0 && cardCredit.skipped > 0) {
                notesOverride = buildInternalNote(input.notes ?? '', {
                  cardCreditedAmount: String(cardCredit.credited),
                });
              }
            }

            if (cardBillLeg) {
              // ── L4 STEP 4b (audit MF-01 / F-2 / O-1 / F-4) ──────────────
              // ONE server-side transaction debits the paying account, credits
              // the cash-advance card by the CLAMPED figure, reduces the loan,
              // flips the covered instalments AND writes the row — the case
              // step 2 could not express with a single account id. Everything
              // below the switch is unchanged.
              //
              // Pin the timestamp BEFORE the server writes the row — see the
              // transfer branch.
              input.createdAt = input.createdAt ?? new Date().toISOString();

              await atomicPayCardBill(scope, {
                transactionId,
                rowType: 'repayment',
                sourceAccountId: cardBillLeg.accountId,
                cardAccountId: cardBillLeg.cardId,
                amount: input.amount,
                sourceAmount: cardBillLeg.sourceAmount,
                // clampCardCredit's `credited`, re-validated server-side
                // against the card's own headroom.
                cardAmount: cardBillLeg.credited,
                currency: loan.currency,
                conversionRate,
                note: notesOverride ?? input.notes ?? '',
                category: input.category ?? '',
                createdAt: input.createdAt,
                // One line, no ledger row: the MAIN row IS the repayment
                // record, and a second one would double-count the payment.
                // Re-planned on every attempt so a conflict retry carries a
                // fresh remaining and a fresh coverage prefix.
                buildPlan: async () => {
                  const fresh = useLoanStore.getState().loans.find((l) => l.id === input.loanId);
                  if (!fresh) throw loanRemainingConflictError(tStatic('err_loan_gone'));
                  return toCardBillLines(
                    [{ loan: fresh, applied: input.amount }], null, input.emiId,
                  );
                },
                // Ledger mode deliberately lets a repayment push an account
                // negative (isSimpleModeBalanceBypassAllowed waives
                // checkBalanceForTransaction above); the server guard has to be
                // waived in exactly the same case, and only that case.
                allowNegative: isSimpleModeBalanceBypassAllowed('repayment'),
              });
            } else if (atomicLeg) {
              // ── L4 STEP 2 (audit MF-01 / F-2 / O-1 / F-4) ───────────────
              // ONE server-side transaction applies the account leg, the loan
              // leg, the covered EMI marks AND writes the row — so a network
              // drop between them can no longer move a balance without
              // recording it, or reduce a loan the record never matches.
              // Everything below the switch (the Transaction object, the
              // mirror, the activity entry, the reminder nudge) is unchanged:
              // see the artifact contract table in
              // supabase-migration-p3-atomic-repayment.sql.
              //
              // Pin the timestamp BEFORE the server writes the row, so the
              // tail's `input.createdAt ?? new Date().toISOString()` produces
              // the identical value and its idempotent upsert rewrites the
              // same row rather than a differently-stamped one.
              input.createdAt = input.createdAt ?? new Date().toISOString();

              await atomicRepayment(scope, {
                transactionId,
                loanId: input.loanId,
                accountId: atomicLeg.accountId,
                amount: input.amount,
                accountAmount: atomicLeg.accountAmount,
                conversionRate,
                note: notesOverride ?? input.notes ?? '',
                category: input.category ?? '',
                createdAt: input.createdAt,
                remainingBefore: loan.remainingAmount,
                statusBefore: loan.status,
                personName: loan.personName,
                loanTotalAmount: loan.totalAmount,
                targetedEmiId: input.emiId,
                // Ledger mode deliberately lets a repayment push an account
                // negative (isSimpleModeBalanceBypassAllowed waives
                // checkBalanceForTransaction above); the server guard has to
                // be waived in exactly the same case, and only that case.
                allowNegative: isSimpleModeBalanceBypassAllowed('repayment'),
              });
            } else {
              await trackedApplyRepayment(scope, input.loanId, input.amount);
              if (input.emiId) {
                await trackedMarkEmiPaid(scope, input.emiId);
                // Overpaying against one instalment must also cover the later
                // instalments the extra money reaches — the amount is editable
                // now, so a targeted payment is no longer capped at one EMI.
                await trackedMarkCoveredEmisPaid(scope, input.loanId);
              } else {
                // No specific instalment was targeted (generic / partial repayment,
                // multi-loan allocation, full payoff). Reconcile the schedule to the
                // new paid-down balance so instalments don't orphan.
                await trackedMarkCoveredEmisPaid(scope, input.loanId);
              }
            }
            break;
          }

          case 'goal_contribution': {
            const src = accountStore.getAccount(input.sourceAccountId);
            if (!src) throw new Error('Source account not found');
            const goal = goalStore.getGoal(input.goalId);
            if (!goal) throw new Error('Goal not found');

            // ── L4 STEP 4a (audit MF-01 / O-1 / F-4) ──────────────────────
            // Which legs run, and how much leaves the wallet, is one pure
            // decision (src/lib/goalContributionPlan.ts) shared by BOTH paths
            // below — so the flagged path and the legacy path cannot disagree
            // about a self-stored contribution or a cross-currency conversion.
            // The guards, the balance check and every description string stay
            // exactly where they were; only the MOVEMENT forks.
            const goalLegs = planGoalContributionLegs({
              sourceAccountId: input.sourceAccountId,
              sourceCurrency: src.currency,
              goalCurrency: goal.currency,
              goalStoredInAccountId: goal.storedInAccountId ?? '',
              // The branch's own `if (linkedAccount)` guard: stored_in_account_id
              // is a label, not a foreign key, so a goal may name an account
              // that no longer exists — and that must contribute WITHOUT a
              // credit leg rather than fail.
              storedInAccountExists: Boolean(
                goal.storedInAccountId
                && goal.storedInAccountId !== input.sourceAccountId
                && accountStore.getAccount(goal.storedInAccountId),
              ),
              amount: input.amount,
              conversionRate: input.conversionRate,
            });

            // Contributing FROM the account the goal is stored in: the money
            // physically stays where it is — debiting the source (with no
            // credit back) would push its balance below reality. Record-only:
            // savedAmount moves, no balance legs, flagged in the internal note
            // so the delete path skips the refund symmetrically.
            if (goalLegs.selfStored) {
              currency = goal.currency;
              sourceAccountId = input.sourceAccountId;
              relatedGoalId = input.goalId;
              // Stamped BEFORE the write on both paths, because the server
              // stores the note verbatim and the flag has to be in it.
              notesOverride = buildInternalNote(input.notes ?? '', { goalSelfStored: '1' });
              if (ATOMIC_GOAL_ENABLED) {
                // Pin the timestamp BEFORE the server writes the row — see the
                // transfer branch.
                input.createdAt = input.createdAt ?? new Date().toISOString();
                await atomicGoalContribution(scope, {
                  transactionId,
                  goalId: input.goalId,
                  sourceAccountId: input.sourceAccountId,
                  amount: input.amount,
                  sourceAmount: goalLegs.sourceAmount,
                  conversionRate: goalLegs.conversionRate,
                  note: notesOverride,
                  category: input.category ?? '',
                  createdAt: input.createdAt,
                  linkedAccountId: goalLegs.linkedAccountId,
                  savedBefore: goal.savedAmount,
                });
              } else {
                await trackedAddContribution(scope, input.goalId, input.amount);
              }
              description = `Goal contribution: ${currency} ${input.amount} → "${goal.title}" (kept in ${src.name})`;
              break;
            }

            const linkedAccount = goalLegs.linkedAccountId
              ? accountStore.getAccount(goalLegs.linkedAccountId)
              : undefined;

            if (src.currency !== goal.currency) {
              if (!input.conversionRate) throw new Error('Conversion rate required — different currencies');
              conversionRate = input.conversionRate;
              const srcDeduct = goalLegs.sourceAmount;
              checkBalance(src, srcDeduct);
              currency = goal.currency;
              sourceAccountId = input.sourceAccountId;
              relatedGoalId = input.goalId;
              if (linkedAccount) destinationAccountId = linkedAccount.id;

              if (ATOMIC_GOAL_ENABLED) {
                input.createdAt = input.createdAt ?? new Date().toISOString();
                await atomicGoalContribution(scope, {
                  transactionId,
                  goalId: input.goalId,
                  sourceAccountId: input.sourceAccountId,
                  amount: input.amount,
                  sourceAmount: srcDeduct,
                  conversionRate: goalLegs.conversionRate,
                  note: input.notes ?? '',
                  category: input.category ?? '',
                  createdAt: input.createdAt,
                  linkedAccountId: goalLegs.linkedAccountId,
                  savedBefore: goal.savedAmount,
                });
              } else {
                await trackedBalanceDelta(scope, input.sourceAccountId, -srcDeduct);
                await trackedAddContribution(scope, input.goalId, input.amount);
                if (linkedAccount) {
                  await trackedBalanceDelta(scope, linkedAccount.id, input.amount);
                }
              }

              description = linkedAccount
                ? `Goal "${goal.title}": ${src.currency} ${srcDeduct} → ${goal.currency} ${input.amount} (rate: ${input.conversionRate})`
                : `Goal contribution: ${src.currency} ${srcDeduct} → ${goal.currency} ${input.amount} → "${goal.title}" (rate: ${input.conversionRate})`;
            } else {
              checkBalance(src, input.amount);
              currency = src.currency;
              sourceAccountId = input.sourceAccountId;
              relatedGoalId = input.goalId;
              if (linkedAccount) destinationAccountId = linkedAccount.id;

              if (ATOMIC_GOAL_ENABLED) {
                input.createdAt = input.createdAt ?? new Date().toISOString();
                await atomicGoalContribution(scope, {
                  transactionId,
                  goalId: input.goalId,
                  sourceAccountId: input.sourceAccountId,
                  amount: input.amount,
                  sourceAmount: goalLegs.sourceAmount,
                  conversionRate: goalLegs.conversionRate,
                  note: input.notes ?? '',
                  category: input.category ?? '',
                  createdAt: input.createdAt,
                  linkedAccountId: goalLegs.linkedAccountId,
                  savedBefore: goal.savedAmount,
                });
              } else {
                await trackedBalanceDelta(scope, input.sourceAccountId, -input.amount);
                await trackedAddContribution(scope, input.goalId, input.amount);
                if (linkedAccount) {
                  await trackedBalanceDelta(scope, linkedAccount.id, input.amount);
                }
              }

              if (linkedAccount) {
                description = `Goal "${goal.title}": ${currency} ${input.amount} from ${src.name} → ${linkedAccount.name}`;
              } else if (goal.storedInAccountId && goal.storedInAccountId !== input.sourceAccountId) {
                description = `Goal contribution: ${currency} ${input.amount} → "${goal.title}" (tracked internally)`;
              } else {
                description = `Goal contribution: ${currency} ${input.amount} → "${goal.title}"`;
              }
            }
            break;
          }

          case 'opening_balance': {
            // Bounded (finite, > 0, < 1e12) by assertInputAmountsInBounds —
            // the second branch the audit found unguarded (V-1/F-9). Note the
            // rule is `> 0`, not `>= 0`, and that is correct: an opening
            // balance of ZERO writes no row at all. accountStore.createAccount
            // only logs the opening entry `if (input.balance > 0)`, so a
            // zero-opening account never reaches here — asking for one is
            // asking for an empty record, and the DB CHECK (`amount >= 0`) is
            // deliberately the looser of the two so an existing zero row from
            // any other writer still validates.
            const destAccount = accountStore.getAccount(input.destinationAccountId);
            if (!destAccount) throw new Error('Destination account not found');
            currency = destAccount.currency;
            destinationAccountId = input.destinationAccountId;
            if (ATOMIC_SINGLE_LEG_ENABLED) {
              input.createdAt = input.createdAt ?? new Date().toISOString();
              await atomicSingleLeg(scope, {
                transactionId, type: 'opening_balance',
                accountId: input.destinationAccountId,
                amount: input.amount, targetBalance: null,
                note: input.notes ?? '', category: input.category ?? '',
                createdAt: input.createdAt,
                allowNegative: false,
              });
            } else {
              await trackedBalanceDelta(scope, input.destinationAccountId, input.amount);
            }
            description = `Opening Balance — ${currency} ${input.amount} in ${destAccount.name}`;
            break;
          }

          case 'adjustment': {
            const account = accountStore.getAccount(input.accountId);
            if (!account) throw new Error('Account not found');
            const delta = Math.round((input.targetBalance - account.balance) * 100) / 100;
            if (Math.abs(delta) < 0.005) throw new Error('Balance is already exactly that — nothing to correct');
            currency = account.currency;
            amount = Math.abs(delta);
            // Direction is carried by which leg the account sits on, so the
            // stored amount stays positive like every other row.
            if (delta > 0) destinationAccountId = input.accountId;
            else sourceAccountId = input.accountId;
            if (ATOMIC_SINGLE_LEG_ENABLED) {
              input.createdAt = input.createdAt ?? new Date().toISOString();
              // The server SETS the target inside the row lock and derives its
              // own |delta| there — the local `delta` above is computed from a
              // snapshot that a concurrent write may already have invalidated,
              // and "set it to X" is only truthfully X if the read and the write
              // are the same transaction. It cross-checks `amount` against its
              // own figure (AMOUNT_MISMATCH) rather than trusting either.
              const applied = await atomicSingleLeg(scope, {
                transactionId, type: 'adjustment',
                accountId: input.accountId,
                amount, targetBalance: input.targetBalance,
                note: input.notes ?? '', category: input.category ?? '',
                createdAt: input.createdAt,
                // An adjustment has no balance guard at all — setting a credit
                // card to a negative balance is the correct use of it.
                allowNegative: false,
              });
              // Adopt the SERVER's magnitude and direction: after a refetch and
              // retry the locked balance may differ from the one `delta` was
              // derived from, and the row must agree with the money.
              amount = applied.amount;
              destinationAccountId = applied.accountDelta > 0 ? input.accountId : null;
              sourceAccountId = applied.accountDelta > 0 ? null : input.accountId;
            } else {
              await trackedBalanceDelta(scope, input.accountId, delta);
            }
            description = `Balance corrected — ${account.name} set to ${currency} ${input.targetBalance}`;
            break;
          }

          case 'investment_buy':
          case 'investment_sell': {
            const inv = useInvestmentStore.getState();
            const market = inv.getMarket(input.marketId);
            if (!market) throw new Error('Market not found');
            const symbol = input.symbol.trim().toUpperCase();
            if (!symbol) throw new Error('Symbol is required');
            const kind = input.type === 'investment_buy' ? ('buy' as const) : ('sell' as const);
            const validationError = validateTradeInput({
              kind, quantity: input.quantity, pricePerUnit: input.pricePerUnit, amount: 0, fees: input.fees,
            });
            if (validationError) throw new Error(validationError);

            // The transaction row's amount is the CASH that moved, in market
            // currency: buy = total cost incl. fees; sell = net proceeds.
            const gross = Math.round(input.quantity * input.pricePerUnit * 100) / 100;
            amount = kind === 'buy'
              ? Math.round((gross + input.fees) * 100) / 100
              : Math.round((gross - input.fees) * 100) / 100;
            currency = market.currency;

            const now = new Date().toISOString();
            const trade: InvestmentTrade = {
              id: uuid(),
              marketId: market.id,
              symbol,
              name: input.companyName?.trim() ?? '',
              kind,
              quantity: input.quantity,
              pricePerUnit: input.pricePerUnit,
              amount: 0,
              fees: input.fees,
              accountId: input.type === 'investment_buy' ? input.sourceAccountId : input.destinationAccountId,
              transactionId,
              tradedAt: input.tradedAt ?? now,
              notes: input.notes ?? '',
              createdAt: now,
            };

            // Oversell guard runs BEFORE any money moves — the full timeline
            // replay also catches backdated sells.
            if (kind === 'sell') {
              const check = simulateTimeline(inv.tradesForSymbol(market.id, symbol), { add: trade });
              if (!check.ok) {
                throw new Error(
                  `You only hold ${check.violation.heldQty} ${symbol} — cannot sell ${check.violation.attemptedQty}`,
                );
              }
            }

            // What the WALLET moves, in ACCOUNT currency. Derived before any
            // money moves so the flagged and legacy paths below consume the
            // identical figure and cannot drift. The convention is asymmetric —
            // a buy DIVIDES (market-per-account), a sell MULTIPLIES
            // (account-per-market) — and one "convert" implementation would
            // mis-derive one of them by a factor of rate².
            let accountAmount = amount;
            let legAccountId: string;
            if (input.type === 'investment_buy') {
              const src = accountStore.getAccount(input.sourceAccountId);
              if (!src) throw new Error('Source account not found');
              sourceAccountId = src.id;
              legAccountId = src.id;
              // Zero-cash entries (bonus shares at price 0) move no money —
              // no rate needed, both deltas are 0 via the same-currency path.
              if (src.currency !== market.currency && amount > 0) {
                if (!input.conversionRate || !rateIsSane(input.conversionRate)) {
                  throw new Error('Conversion rate required — different currencies');
                }
                conversionRate = input.conversionRate;
                // rate = market-per-account (divide) — goal_contribution shape.
                accountAmount = Math.round((amount / conversionRate) * 100) / 100;
                description = `Bought ${input.quantity} ${symbol} (${market.name}) — ${currency} ${amount}, paid ${src.currency} ${accountAmount} from ${src.name} (rate: ${conversionRate})`;
              } else {
                description = `Bought ${input.quantity} ${symbol} (${market.name}) — ${currency} ${amount} from ${src.name}`;
              }
              // The STRICT checkBalance — 'investment_*' is absent from
              // isSimpleModeBalanceBypassAllowed — applied to exactly the
              // figure both sub-branches computed, as before.
              checkBalance(src, accountAmount);
            } else {
              const dest = accountStore.getAccount(input.destinationAccountId);
              if (!dest) throw new Error('Destination account not found');
              destinationAccountId = dest.id;
              legAccountId = dest.id;
              if (dest.currency !== market.currency && amount > 0) {
                if (!input.conversionRate || !rateIsSane(input.conversionRate)) {
                  throw new Error('Conversion rate required — different currencies');
                }
                conversionRate = input.conversionRate;
                // rate = account-per-market (multiply) — repayment-given shape.
                accountAmount = Math.round(amount * conversionRate * 100) / 100;
                description = `Sold ${input.quantity} ${symbol} (${market.name}) — ${currency} ${amount}, received ${dest.currency} ${accountAmount} into ${dest.name} (rate: ${conversionRate})`;
              } else {
                description = `Sold ${input.quantity} ${symbol} (${market.name}) — ${currency} ${amount} → ${dest.name}`;
              }
            }

            if (ATOMIC_INVEST_ENABLED) {
              // ── L4 STEP 5 ─────────────────────────────────────────────────
              // ONE server-side transaction moves the balance, writes the trade
              // AND writes the row, so a drop between them can no longer leave
              // a wallet that paid for shares nobody holds. Everything below the
              // switch is unchanged.
              input.createdAt = input.createdAt ?? new Date().toISOString();
              const applied = await atomicInvestmentTrade(scope, {
                transactionId, trade, kind,
                accountId: legAccountId,
                amount, accountAmount, conversionRate,
                note: input.notes ?? '',
                // The tail resolves this the same way; passing the resolved
                // value keeps the server's row and the upsert byte-identical.
                category: input.category ?? 'Investments',
                createdAt: input.createdAt,
              });
              // The SERVER's trade id, never the local one: on a replay it is
              // the id the FIRST attempt minted.
              relatedInvestmentId = applied.trade.id;
            } else {
              await trackedBalanceDelta(
                scope, legAccountId,
                input.type === 'investment_buy' ? -accountAmount : accountAmount,
              );
              await trackedAddInvestmentTrade(scope, trade);
              relatedInvestmentId = trade.id;
            }
            break;
          }

          case 'investment_dividend': {
            const inv = useInvestmentStore.getState();
            const market = inv.getMarket(input.marketId);
            if (!market) throw new Error('Market not found');
            const symbol = input.symbol.trim().toUpperCase();
            if (!symbol) throw new Error('Symbol is required');
            const validationError = validateTradeInput({
              kind: 'dividend', quantity: 0, pricePerUnit: 0, amount: input.grossAmount, fees: input.fees,
            });
            if (validationError) throw new Error(validationError);

            amount = Math.round((input.grossAmount - input.fees) * 100) / 100;
            currency = market.currency;
            const dest = accountStore.getAccount(input.destinationAccountId);
            if (!dest) throw new Error('Destination account not found');
            destinationAccountId = dest.id;

            const now = new Date().toISOString();
            const trade: InvestmentTrade = {
              id: uuid(),
              marketId: market.id,
              symbol,
              name: '',
              kind: 'dividend',
              quantity: 0,
              pricePerUnit: 0,
              amount: input.grossAmount,
              fees: input.fees,
              accountId: input.destinationAccountId,
              transactionId,
              tradedAt: input.tradedAt ?? now,
              notes: input.notes ?? '',
              createdAt: now,
            };

            // A dividend converts on the currency test ALONE — unlike a buy or
            // a sell, which also require amount > 0. Its net is positive by
            // construction (validateTradeInput refuses fees ≥ gross), so the
            // two are equivalent here; the shapes are kept apart because the
            // server reproduces each branch's own condition, not a merged one.
            let creditedAmount = amount;
            if (dest.currency !== market.currency) {
              if (!input.conversionRate || !rateIsSane(input.conversionRate)) {
                throw new Error('Conversion rate required — different currencies');
              }
              conversionRate = input.conversionRate;
              creditedAmount = Math.round(amount * conversionRate * 100) / 100;
              description = `Dividend ${symbol} (${market.name}) — ${currency} ${amount}, received ${dest.currency} ${creditedAmount} into ${dest.name} (rate: ${conversionRate})`;
            } else {
              description = `Dividend ${symbol} (${market.name}) — ${currency} ${amount} → ${dest.name}`;
            }

            if (ATOMIC_INVEST_ENABLED) {
              input.createdAt = input.createdAt ?? new Date().toISOString();
              const applied = await atomicInvestmentTrade(scope, {
                transactionId, trade, kind: 'dividend',
                accountId: dest.id,
                amount, accountAmount: creditedAmount, conversionRate,
                note: input.notes ?? '',
                category: input.category ?? 'Investments',
                createdAt: input.createdAt,
              });
              relatedInvestmentId = applied.trade.id;
            } else {
              await trackedBalanceDelta(scope, dest.id, creditedAmount);
              await trackedAddInvestmentTrade(scope, trade);
              relatedInvestmentId = trade.id;
            }
            break;
          }
        }

        const transaction: Transaction = {
          id: transactionId,
          type: input.type,
          amount,
          currency,
          sourceAccountId,
          destinationAccountId,
          relatedPerson,
          personId,
          relatedLoanId,
          relatedGoalId,
          relatedInvestmentId,
          conversionRate,
          category: input.category ?? (relatedInvestmentId ? 'Investments' : ''),
          notes: notesOverride ?? input.notes ?? '',
          createdAt: input.createdAt ?? new Date().toISOString(),
          isReconciled: false,
          reconciledAt: null,
          reconciledBy: null,
        };
        transaction.updatedAt = transaction.createdAt;

        await trackedAddTransaction(scope, transaction);

        return { transaction, description };
      },
      refetchMoneyStores,
      'transactionStore.processTransaction',
    );

    // Post-commit: activity log is a secondary audit trail. Its failure must
    // NOT roll back real money (which has already moved successfully).
    await logActivitySafe(
      transaction.type === 'opening_balance' ? 'opening_balance' : 'transaction_created',
      description,
      transaction.id,
      'transaction',
    );

    nudgeReminderSchedule();

    return transaction;
  },

  updateTransaction: async (id, input, options = {}) => {
    await ensureSupportingStoresLoaded();

    const existing = get().transactions.find((transaction) => transaction.id === id) ?? await transactionsDb.get(id);
    if (!existing) throw new Error('Transaction not found');

    const existingNoteMeta = parseInternalNote(existing.notes).meta;
    if (
      existingNoteMeta.groupExpenseId &&
      !options.allowLinkedGroupExpense &&
      await groupExpenseStillExists(existingNoteMeta.groupExpenseId)
    ) {
      throw new Error('This expense belongs to a group. Edit it from the group details screen.');
    }

    if (!isEditableTransactionType(existing.type)) {
      throw new Error('This entry type cannot be edited — delete and re-enter it instead.');
    }

    if (existing.type !== input.type) {
      throw new Error('Changing the transaction type is not supported yet.');
    }

    // A card-bill transfer that auto-settled cash-advance loans carries
    // ledger rows keyed to ITS amount and accounts — changing those would
    // desync them, so that still means delete + re-enter (deletion reverses
    // everything). The DATE and the note are metadata, though: they are
    // edited in place, and a new date moves every linked row with it
    // (backlog 2026-09-22 item 1 — previously fixed by console scripts).
    if (existing.type === 'transfer') {
      // The linked rows are stamped within moments of the transfer; make sure
      // the window around it is loaded before deciding there are none.
      const around = new Date(new Date(existing.createdAt).getTime() - 86_400_000).toISOString();
      await get().ensureTransactionHistory({ since: around });
      const linkedRows = linkedBillPaymentRows(get().transactions, existing.id);
      if (linkedRows.length > 0) {
        const transferInput = input as TransferInput;
        if (!transferEditKeepsMoney(existing, transferInput)) {
          throw new Error(tStatic('bill_edit_money_locked'));
        }
        const nextCreatedAt = input.createdAt;
        const updated = await runSafeMutation<Transaction>(
          async (scope) => {
            const now = new Date().toISOString();
            const next: Transaction = {
              ...existing,
              notes: transferInput.notes ?? '',
              ...(nextCreatedAt ? { createdAt: nextCreatedAt } : {}),
              updatedAt: now,
            };
            await trackedUpdateTransaction(scope, existing.id, next, existing);
            if (nextCreatedAt) {
              for (const row of linkedRows) {
                await trackedUpdateTransaction(
                  scope,
                  row.id,
                  { ...row, createdAt: nextCreatedAt, updatedAt: now },
                  row,
                );
              }
            }
            return next;
          },
          refetchMoneyStores,
          'transactionStore.updateTransaction.billPaymentMeta',
        );
        await logActivitySafe(
          'transaction_modified',
          nextCreatedAt
            ? `Re-dated card bill payment (${linkedRows.length} covered instalment record${linkedRows.length > 1 ? 's' : ''} moved with it)`
            : 'Updated card bill payment note',
          updated.id,
          'transaction',
        );
        return updated;
      }
    }

    const { updated, description } = await runSafeMutation<{ updated: Transaction; description: string }>(
      async (scope) => {
        const accountStore = useAccountStore.getState();
        const emiStore = useEmiStore.getState();

        let updated: Transaction = existing;
        let description = '';

        switch (existing.type) {
          case 'expense': {
            const expenseInput = input as ExpenseInput;
            const previousSource = existing.sourceAccountId ? accountStore.getAccount(existing.sourceAccountId) : undefined;
            const nextSource = accountStore.getAccount(expenseInput.sourceAccountId);
            if (!previousSource || !nextSource) throw new Error('Source account not found');

            // Pre-flight: will the new source have enough? If not, don't
            // refund the old account at all — we used to refund first, then
            // discover the shortfall, leaving the user silently richer.
            if (previousSource.id !== nextSource.id) {
              checkBalanceForTransaction(nextSource, expenseInput.amount, expenseInput.type);
            } else {
              // Same account — refund-then-charge nets (next - existing);
              // only that delta needs to be available.
              const netDebit = expenseInput.amount - existing.amount;
              if (netDebit > 0) checkBalanceForTransaction(nextSource, netDebit, expenseInput.type);
            }

            await trackedBalanceDelta(scope, previousSource.id, existing.amount);
            await trackedBalanceDelta(scope, nextSource.id, -expenseInput.amount);

            updated = {
              ...existing,
              amount: expenseInput.amount,
              currency: nextSource.currency,
              sourceAccountId: expenseInput.sourceAccountId,
              category: expenseInput.category ?? '',
              notes: expenseInput.notes ?? '',
              isReconciled: false,
              reconciledAt: null,
              reconciledBy: null,
            };
            description = `Updated expense: ${nextSource.currency} ${expenseInput.amount} from ${nextSource.name}`;
            break;
          }

          case 'income': {
            const incomeInput = input as IncomeInput;
            const previousDest = existing.destinationAccountId ? accountStore.getAccount(existing.destinationAccountId) : undefined;
            const nextDest = accountStore.getAccount(incomeInput.destinationAccountId);
            if (!nextDest) throw new Error('Destination account not found');

            if (previousDest && previousDest.id === nextDest.id) {
              // Same account — only the net delta moves. Shrinking the income
              // needs that much still present (income-delete precedent).
              const delta = Math.round((incomeInput.amount - existing.amount) * 100) / 100;
              if (delta < -0.004) checkReversalBalance(nextDest, -delta, undefined);
              if (Math.abs(delta) > 0.004) await trackedBalanceDelta(scope, nextDest.id, delta);
            } else {
              if (previousDest) {
                checkReversalBalance(previousDest, existing.amount, undefined);
                await trackedBalanceDelta(scope, previousDest.id, -existing.amount);
              }
              await trackedBalanceDelta(scope, nextDest.id, incomeInput.amount);
            }

            updated = {
              ...existing,
              amount: incomeInput.amount,
              currency: nextDest.currency,
              destinationAccountId: incomeInput.destinationAccountId,
              category: incomeInput.category ?? '',
              notes: incomeInput.notes ?? '',
              isReconciled: false,
              reconciledAt: null,
              reconciledBy: null,
            };
            description = `Updated income: ${nextDest.currency} ${incomeInput.amount} → ${nextDest.name}`;
            break;
          }

          case 'transfer': {
            const transferInput = input as TransferInput;
            const previousSource = existing.sourceAccountId ? accountStore.getAccount(existing.sourceAccountId) : undefined;
            const previousDest = existing.destinationAccountId ? accountStore.getAccount(existing.destinationAccountId) : undefined;
            const nextSource = accountStore.getAccount(transferInput.sourceAccountId);
            const nextDest = accountStore.getAccount(transferInput.destinationAccountId);
            if (!nextSource || !nextDest) throw new Error('Account not found');
            if (nextSource.id === nextDest.id) throw new Error('Choose a different destination account');
            if (nextSource.currency !== nextDest.currency && !transferInput.conversionRate) {
              throw new Error('Conversion rate required for cross-currency move');
            }

            // Reverse the old legs first, then apply the new ones. Balance
            // checks run against FRESH store state (the reversal may credit
            // or debit the very accounts the new legs touch).
            const previousDestAmount = existing.conversionRate
              ? Math.round(existing.amount * existing.conversionRate * 100) / 100
              : existing.amount;
            if (previousDest) {
              checkReversalBalance(previousDest, previousDestAmount, undefined);
              await trackedBalanceDelta(scope, previousDest.id, -previousDestAmount);
            }
            if (previousSource) await trackedBalanceDelta(scope, previousSource.id, existing.amount);

            const freshSource = useAccountStore.getState().getAccount(nextSource.id);
            if (!freshSource) throw new Error('Account not found');
            checkBalance(freshSource, transferInput.amount);
            await trackedBalanceDelta(scope, nextSource.id, -transferInput.amount);

            const nextRate = nextSource.currency !== nextDest.currency ? transferInput.conversionRate! : null;
            const nextDestAmount = nextRate
              ? Math.round(transferInput.amount * nextRate * 100) / 100
              : transferInput.amount;
            await trackedBalanceDelta(scope, nextDest.id, nextDestAmount);

            updated = {
              ...existing,
              amount: transferInput.amount,
              currency: nextSource.currency,
              sourceAccountId: transferInput.sourceAccountId,
              destinationAccountId: transferInput.destinationAccountId,
              conversionRate: nextRate,
              category: transferInput.category ?? existing.category,
              notes: transferInput.notes ?? '',
              isReconciled: false,
              reconciledAt: null,
              reconciledBy: null,
            };
            description = `Updated transfer: ${nextSource.currency} ${transferInput.amount} ${nextSource.name} → ${nextDest.name}`;
            break;
          }

          case 'loan_given': {
            const loanGivenInput = input as LoanGivenInput;
            const relatedLoanId = existing.relatedLoanId;
            if (!relatedLoanId) throw new Error('Loan record not found for this entry');
            const hasRepayments = get().transactions.some(
              (transaction) => transaction.relatedLoanId === relatedLoanId && transaction.type === 'repayment'
            );
            if (hasRepayments) {
              throw new Error('This loan already has repayments. Remove those repayments first.');
            }
            // A schedule no longer blocks the edit — it is regenerated over the
            // new amount below (same instalment count and start date).
            const priorSchedule = emiStore.getByLoan(relatedLoanId);

            const previousSource = existing.sourceAccountId ? accountStore.getAccount(existing.sourceAccountId) : undefined;
            const nextSource = accountStore.getAccount(loanGivenInput.sourceAccountId);
            if (!previousSource || !nextSource) throw new Error('Source account not found');

            if (previousSource.id !== nextSource.id) {
              checkBalanceForTransaction(nextSource, loanGivenInput.amount, loanGivenInput.type);
            } else {
              const netDebit = loanGivenInput.amount - existing.amount;
              if (netDebit > 0) checkBalanceForTransaction(nextSource, netDebit, loanGivenInput.type);
            }

            await trackedBalanceDelta(scope, previousSource.id, existing.amount);
            await trackedBalanceDelta(scope, nextSource.id, -loanGivenInput.amount);

            await trackedUpdateLoan(scope, relatedLoanId, {
              personName: loanGivenInput.personName,
              ...(loanGivenInput.personId !== undefined ? { personId: loanGivenInput.personId } : {}),
              totalAmount: loanGivenInput.amount,
              remainingAmount: loanGivenInput.amount,
              currency: nextSource.currency,
              status: 'active',
              notes: loanGivenInput.notes ?? '',
            });

            if (priorSchedule.length > 0) {
              await trackedDeleteEmisByLoan(scope, relatedLoanId);
              await trackedRegenerateEmis(
                scope,
                relatedLoanId,
                loanGivenInput.amount,
                priorSchedule.length,
                priorSchedule[0].dueDate,
              );
            }

            updated = {
              ...existing,
              amount: loanGivenInput.amount,
              currency: nextSource.currency,
              sourceAccountId: loanGivenInput.sourceAccountId,
              relatedPerson: loanGivenInput.personName,
              ...(loanGivenInput.personId !== undefined ? { personId: loanGivenInput.personId } : {}),
              notes: loanGivenInput.notes ?? '',
              isReconciled: false,
              reconciledAt: null,
              reconciledBy: null,
            };
            description = `Updated money lent to ${loanGivenInput.personName}: ${nextSource.currency} ${loanGivenInput.amount}`;
            break;
          }

          case 'loan_taken': {
            const loanTakenInput = input as LoanTakenInput;
            const relatedLoanId = existing.relatedLoanId;
            if (!relatedLoanId) throw new Error('Loan record not found for this entry');
            const hasRepayments = get().transactions.some(
              (transaction) => transaction.relatedLoanId === relatedLoanId && transaction.type === 'repayment'
            );
            if (hasRepayments) {
              throw new Error('This loan already has repayments. Remove those repayments first.');
            }
            // A schedule no longer blocks the edit — it is regenerated over the
            // new amount below (same instalment count and start date).
            const priorSchedule = emiStore.getByLoan(relatedLoanId);

            const previousDestination = existing.destinationAccountId ? accountStore.getAccount(existing.destinationAccountId) : undefined;
            if (!previousDestination) throw new Error('Destination account not found');

            const nextDestination = accountStore.getAccount(loanTakenInput.destinationAccountId);
            if (!nextDestination) throw new Error('Destination account not found');

            // Pre-flight the next cash advance card BEFORE any mutation so we
            // don't partially reverse prior state and then bail out.
            if (loanTakenInput.sourceAccountId) {
              const nextCard = accountStore.getAccount(loanTakenInput.sourceAccountId);
              if (!nextCard) throw new Error('Cash advance card not found');
              if (nextCard.type !== 'credit_card') throw new Error('Cash advance source must be a credit card account');
              if (nextCard.currency !== nextDestination.currency) {
                throw new Error('Cash advance source card must match the receiving account currency');
              }
              // If the card is the same as the previous card, we refund
              // existing.amount before debiting loanTakenInput.amount — only
              // the net debit needs to be available.
              if (existing.sourceAccountId === nextCard.id) {
                const netDebit = loanTakenInput.amount - existing.amount;
                if (netDebit > 0) checkBalanceForTransaction(nextCard, netDebit, loanTakenInput.type);
              } else {
                checkBalanceForTransaction(nextCard, loanTakenInput.amount, loanTakenInput.type);
              }
            }

            await trackedBalanceDelta(scope, previousDestination.id, -existing.amount);

            if (existing.sourceAccountId) {
              const previousCashAdvanceCard = accountStore.getAccount(existing.sourceAccountId);
              if (!previousCashAdvanceCard) throw new Error('Cash advance card not found');
              await trackedBalanceDelta(scope, previousCashAdvanceCard.id, existing.amount);
            }

            let nextSourceAccountId: string | null = null;
            if (loanTakenInput.sourceAccountId) {
              await trackedBalanceDelta(scope, loanTakenInput.sourceAccountId, -loanTakenInput.amount);
              nextSourceAccountId = loanTakenInput.sourceAccountId;
            }

            await trackedBalanceDelta(scope, nextDestination.id, loanTakenInput.amount);

            await trackedUpdateLoan(scope, relatedLoanId, {
              personName: loanTakenInput.personName,
              ...(loanTakenInput.personId !== undefined ? { personId: loanTakenInput.personId } : {}),
              totalAmount: loanTakenInput.amount,
              remainingAmount: loanTakenInput.amount,
              currency: nextDestination.currency,
              status: 'active',
              notes: loanTakenInput.notes ?? '',
            });

            if (priorSchedule.length > 0) {
              await trackedDeleteEmisByLoan(scope, relatedLoanId);
              await trackedRegenerateEmis(
                scope,
                relatedLoanId,
                loanTakenInput.amount,
                priorSchedule.length,
                priorSchedule[0].dueDate,
              );
            }

            updated = {
              ...existing,
              amount: loanTakenInput.amount,
              currency: nextDestination.currency,
              sourceAccountId: nextSourceAccountId,
              destinationAccountId: loanTakenInput.destinationAccountId,
              relatedPerson: loanTakenInput.personName,
              ...(loanTakenInput.personId !== undefined ? { personId: loanTakenInput.personId } : {}),
              conversionRate: null,
              notes: loanTakenInput.notes ?? '',
              isReconciled: false,
              reconciledAt: null,
              reconciledBy: null,
            };
            description = nextSourceAccountId
              ? `Updated cash advance from credit card for ${loanTakenInput.personName}: ${nextDestination.currency} ${loanTakenInput.amount}`
              : `Updated borrowed money from ${loanTakenInput.personName}: ${nextDestination.currency} ${loanTakenInput.amount}`;
            break;
          }
        }

        // Date correction: budgets/analytics bucket by createdAt, so a wrong
        // month was previously permanent (delete+recreate lands on today).
        if (input.createdAt) {
          updated = { ...updated, createdAt: input.createdAt };
        }
        updated = { ...updated, updatedAt: new Date().toISOString() };
        await trackedUpdateTransaction(scope, id, updated, existing);

        return { updated, description };
      },
      refetchMoneyStores,
      'transactionStore.updateTransaction',
    );

    await logActivitySafe('transaction_modified', description, updated.id, 'transaction');

    nudgeReminderSchedule();

    return updated;
  },

  setReconciled: async (id, isReconciled) => {
    const existing = get().transactions.find((transaction) => transaction.id === id) ?? await transactionsDb.get(id);
    if (!existing) throw new Error('Transaction not found');

    const reconciledBy = localStorage.getItem('hisaab_supabase_uid');
    const changes: Partial<Transaction> = {
      isReconciled,
      reconciledAt: isReconciled ? new Date().toISOString() : null,
      reconciledBy: isReconciled ? reconciledBy : null,
      updatedAt: new Date().toISOString(),
    };

    await transactionsDb.update(id, changes);
    const updated = { ...existing, ...changes };
    await mirrorPut(db.transactions, updated);
    markMirrorStale('transactions');
    set(state => ({
      transactions: state.transactions.map(transaction =>
        transaction.id === id ? updated : transaction
      ),
    }));
  },

  setReceiptPath: async (id, receiptPath) => {
    const existing = get().transactions.find((t) => t.id === id) ?? await transactionsDb.get(id);
    if (!existing) throw new Error('Transaction not found');
    const changes: Partial<Transaction> = { receiptPath, updatedAt: new Date().toISOString() };
    await transactionsDb.update(id, changes);
    const updated = { ...existing, ...changes };
    await mirrorPut(db.transactions, updated);
    markMirrorStale('transactions');
    set(state => ({
      transactions: state.transactions.map(t => (t.id === id ? updated : t)),
    }));
  },

  // Category-only patch (payee-memory bulk re-file). Never re-runs balance
  // legs — a category is pure metadata, so this stays as light as
  // setReceiptPath and is safe to loop over dozens of rows.
  setCategory: async (id, category) => {
    const existing = get().transactions.find((t) => t.id === id) ?? await transactionsDb.get(id);
    if (!existing) throw new Error('Transaction not found');
    const changes: Partial<Transaction> = { category, updatedAt: new Date().toISOString() };
    await transactionsDb.update(id, changes);
    const updated = { ...existing, ...changes };
    await mirrorPut(db.transactions, updated);
    markMirrorStale('transactions');
    set(state => ({
      transactions: state.transactions.map(t => (t.id === id ? updated : t)),
    }));
  },

  deleteTransaction: async (id, options = {}) => {
    await ensureSupportingStoresLoaded();

    const existing = get().transactions.find((transaction) => transaction.id === id) ?? await transactionsDb.get(id);
    if (!existing) return;

    const existingNoteMeta = parseInternalNote(existing.notes).meta;
    if (
      existingNoteMeta.groupExpenseId &&
      !options.allowLinkedGroupExpense &&
      await groupExpenseStillExists(existingNoteMeta.groupExpenseId)
    ) {
      throw new Error('This expense belongs to a group. Delete it from the group details screen.');
    }

    const isInvestmentTxn =
      existing.type === 'investment_buy' || existing.type === 'investment_sell' || existing.type === 'investment_dividend';
    if (isInvestmentTxn && !options.allowInvestment) {
      // The Investments screen runs the position-integrity replay guard
      // before delegating here — a raw History delete would skip it.
      throw new Error('This entry belongs to an investment. Delete it from the Investments screen.');
    }
    if (isInvestmentTxn) {
      const inv = useInvestmentStore.getState();
      if (inv.markets.length === 0 && inv.trades.length === 0) await inv.loadInvestments();
    }

    await runSafeMutation(async (scope) => {
      const accountStore = useAccountStore.getState();
      // Accounts are soft-deleted; a missing account on a REVERSAL leg means
      // the user retired it — there is no live balance left to maintain, so
      // the leg is skipped instead of stranding the row behind 'not found'.

      switch (existing.type) {
        case 'expense': {
          const source = existing.sourceAccountId ? accountStore.getAccount(existing.sourceAccountId) : undefined;
          if (source) await trackedBalanceDelta(scope, source.id, existing.amount);
          break;
        }

        case 'income':
        case 'opening_balance': {
          const destination = existing.destinationAccountId ? accountStore.getAccount(existing.destinationAccountId) : undefined;
          if (destination) {
            checkReversalBalance(destination, existing.amount, options.allowNegative);
            await trackedBalanceDelta(scope, destination.id, -existing.amount);
          }
          break;
        }

        case 'transfer': {
          const source = existing.sourceAccountId ? accountStore.getAccount(existing.sourceAccountId) : undefined;
          const destination = existing.destinationAccountId ? accountStore.getAccount(existing.destinationAccountId) : undefined;
          const destinationAmount = existing.conversionRate
            ? Math.round(existing.amount * existing.conversionRate * 100) / 100
            : existing.amount;
          if (destination) {
            checkReversalBalance(destination, destinationAmount, options.allowNegative);
            await trackedBalanceDelta(scope, destination.id, -destinationAmount);
          }
          if (source) await trackedBalanceDelta(scope, source.id, existing.amount);

          // A bill payment into a credit card auto-settled that card's
          // cash-advance loans via ledger rows stamped with this transfer's
          // id. Deleting the transfer must re-open those loans and remove the
          // rows — otherwise the card debt returns while the loans stay
          // settled (the mirror image of the original double-credit bug).
          const settledRows = get().transactions.filter(
            (t) =>
              t.type === 'repayment' &&
              !t.sourceAccountId &&
              !t.destinationAccountId &&
              t.relatedLoanId &&
              parseInternalNote(t.notes).meta.linkedTransactionId === existing.id,
          );
          for (const row of settledRows) {
            const rowLoan = useLoanStore.getState().getLoan(row.relatedLoanId!);
            if (rowLoan) {
              await trackedUpdateLoan(scope, rowLoan.id, {
                remainingAmount: Math.min(
                  rowLoan.totalAmount,
                  Math.round((rowLoan.remainingAmount + row.amount) * 100) / 100,
                ),
                status: 'active',
              });
              await trackedSyncEmisToLoan(scope, rowLoan.id);
            }
            await trackedDeleteTransaction(scope, row);
          }
          break;
        }

        case 'loan_given': {
          const relatedLoanId = existing.relatedLoanId;
          if (!relatedLoanId) throw new Error('Loan record not found for this entry');
          const hasRepayments = get().transactions.some(
            (transaction) => transaction.relatedLoanId === relatedLoanId && transaction.type === 'repayment'
          );
          if (hasRepayments) {
            throw new Error('This loan already has repayments. Remove those repayments first.');
          }

          const source = existing.sourceAccountId ? accountStore.getAccount(existing.sourceAccountId) : undefined;
          if (source) await trackedBalanceDelta(scope, source.id, existing.amount);
          await trackedDeleteEmisByLoan(scope, relatedLoanId);
          await trackedDeleteLoan(scope, relatedLoanId);
          break;
        }

        case 'loan_taken': {
          const relatedLoanId = existing.relatedLoanId;
          if (!relatedLoanId) throw new Error('Loan record not found for this entry');
          const hasRepayments = get().transactions.some(
            (transaction) => transaction.relatedLoanId === relatedLoanId && transaction.type === 'repayment'
          );
          if (hasRepayments) {
            throw new Error('This loan already has repayments. Remove those repayments first.');
          }

          const destination = existing.destinationAccountId ? accountStore.getAccount(existing.destinationAccountId) : undefined;
          if (destination) await trackedBalanceDelta(scope, destination.id, -existing.amount);

          if (existing.sourceAccountId) {
            const cashAdvanceCard = accountStore.getAccount(existing.sourceAccountId);
            if (cashAdvanceCard) await trackedBalanceDelta(scope, cashAdvanceCard.id, existing.amount);
          }

          await trackedDeleteEmisByLoan(scope, relatedLoanId);
          await trackedDeleteLoan(scope, relatedLoanId);
          break;
        }

        case 'repayment': {
          const relatedLoanId = existing.relatedLoanId;
          if (!relatedLoanId) throw new Error('Loan record not found for this repayment');
          const loan = useLoanStore.getState().getLoan(relatedLoanId);
          if (!loan) throw new Error('Loan not found');
          // A repayment on an ACTIVE linked (cross-user) loan exists on both
          // users' books — deleting it one-sided would silently diverge them.
          if (loan.loanPairId && loan.status === 'active') {
            throw new Error(tStatic('err_linked_repayment_delete').replace('{person}', loan.personName));
          }
          // Ledger-only records (written by loanStore.applyRepayment) carry no
          // account legs — there is no balance to reverse, only the loan.
          const isLedgerRecord = !existing.sourceAccountId && !existing.destinationAccountId;
          if (isLedgerRecord) {
            // no balance legs to reverse
          } else if (loan.type === 'given') {
            const destination = existing.destinationAccountId ? accountStore.getAccount(existing.destinationAccountId) : undefined;
            const creditedAmount = existing.conversionRate
              ? Math.round(existing.amount * existing.conversionRate * 100) / 100
              : existing.amount;
            if (destination) {
              checkReversalBalance(destination, creditedAmount, options.allowNegative);
              await trackedBalanceDelta(scope, destination.id, -creditedAmount);
            }
          } else {
            const source = existing.sourceAccountId ? accountStore.getAccount(existing.sourceAccountId) : undefined;
            const deductedAmount = existing.conversionRate
              ? Math.round((existing.amount / existing.conversionRate) * 100) / 100
              : existing.amount;
            if (source) await trackedBalanceDelta(scope, source.id, deductedAmount);
            if (existing.destinationAccountId) {
              const cashAdvanceCard = accountStore.getAccount(existing.destinationAccountId);
              if (cashAdvanceCard) {
                // Reverse exactly what was credited — clamped repayments stamp
                // the true figure into their internal note.
                const creditedBack = cardCreditedAmountOf(existing);
                checkReversalBalance(cashAdvanceCard, creditedBack, options.allowNegative);
                await trackedBalanceDelta(scope, cashAdvanceCard.id, -creditedBack);
              }
            }
          }
          await trackedUpdateLoan(scope, relatedLoanId, {
            remainingAmount: Math.min(loan.totalAmount, Math.round((loan.remainingAmount + existing.amount) * 100) / 100),
            status: 'active',
          });
          // The schedule must follow the money: un-mark instalments this
          // repayment had covered (and re-mark any still covered). This is the
          // reverse flow the old blanket guard ("linked to an EMI schedule")
          // claimed existed elsewhere but never did — repayments on EMI loans
          // are now deletable, which also un-deadlocks loan edit/delete.
          await trackedSyncEmisToLoan(scope, relatedLoanId);
          break;
        }

        case 'adjustment': {
          const adjustedId = existing.destinationAccountId ?? existing.sourceAccountId;
          const adjusted = adjustedId ? accountStore.getAccount(adjustedId) : undefined;
          if (adjusted) {
            // destination leg = balance was raised → reverse lowers it (and may
            // need the money to still be there); source leg = the opposite.
            const delta = existing.destinationAccountId ? -existing.amount : existing.amount;
            if (delta < 0) checkReversalBalance(adjusted, existing.amount, options.allowNegative);
            await trackedBalanceDelta(scope, adjusted.id, delta);
          }
          break;
        }

        case 'goal_contribution': {
          if (!existing.relatedGoalId) throw new Error('Savings contribution details not found');
          // Self-stored contributions moved no balances (goalSelfStored flag)
          // — only the goal's saved total reverses.
          const selfStored = existingNoteMeta.goalSelfStored === '1';
          const source = existing.sourceAccountId ? accountStore.getAccount(existing.sourceAccountId) : undefined;
          const restoredAmount = existing.conversionRate
            ? Math.round((existing.amount / existing.conversionRate) * 100) / 100
            : existing.amount;
          if (!selfStored && existing.destinationAccountId) {
            const destination = accountStore.getAccount(existing.destinationAccountId);
            if (destination) {
              checkReversalBalance(destination, existing.amount, options.allowNegative);
              await trackedBalanceDelta(scope, destination.id, -existing.amount);
            }
          }
          if (!selfStored && source) await trackedBalanceDelta(scope, source.id, restoredAmount);
          await trackedAddContribution(scope, existing.relatedGoalId, -existing.amount);
          break;
        }

        case 'investment_buy': {
          const source = existing.sourceAccountId ? accountStore.getAccount(existing.sourceAccountId) : undefined;
          // Refund exactly what was deducted (same conversion arithmetic as apply).
          const deducted = existing.conversionRate
            ? Math.round((existing.amount / existing.conversionRate) * 100) / 100
            : existing.amount;
          if (source) await trackedBalanceDelta(scope, source.id, deducted);
          // Two-way lookup: relatedInvestmentId is primary, transactionId is
          // the fallback for rows restored from backups that predate the link
          // column — otherwise the trade row would survive as phantom shares.
          const invTrades = useInvestmentStore.getState().trades;
          const trade = (existing.relatedInvestmentId
            ? invTrades.find((t) => t.id === existing.relatedInvestmentId)
            : undefined) ?? invTrades.find((t) => t.transactionId === existing.id);
          if (trade) await trackedDeleteInvestmentTrade(scope, trade);
          break;
        }

        case 'investment_sell':
        case 'investment_dividend': {
          const destination = existing.destinationAccountId ? accountStore.getAccount(existing.destinationAccountId) : undefined;
          const credited = existing.conversionRate
            ? Math.round(existing.amount * existing.conversionRate * 100) / 100
            : existing.amount;
          if (destination) {
            // The credited money may have been spent since — income-delete precedent.
            checkReversalBalance(destination, credited, options.allowNegative);
            await trackedBalanceDelta(scope, destination.id, -credited);
          }
          const invTrades = useInvestmentStore.getState().trades;
          const trade = (existing.relatedInvestmentId
            ? invTrades.find((t) => t.id === existing.relatedInvestmentId)
            : undefined) ?? invTrades.find((t) => t.transactionId === existing.id);
          if (trade) await trackedDeleteInvestmentTrade(scope, trade);
          break;
        }
      }

      await trackedDeleteTransaction(scope, existing);
    }, refetchMoneyStores, 'transactionStore.deleteTransaction');

    await logActivitySafe(
      'transaction_deleted',
      `Deleted ${existing.type.replace(/_/g, ' ')} entry`,
      existing.id,
      'transaction',
    );

    nudgeReminderSchedule();
  },

  deleteLoanCascade: async (loanId, options = {}) => {
    await ensureSupportingStoresLoaded();
    if (get().transactions.length === 0) {
      const transactions = await transactionsDb.getAll();
      set({ transactions });
    }

    const loan = useLoanStore.getState().getLoan(loanId);
    if (!loan) throw new Error('Loan not found');
    // Linked (cross-user) active loans must not vanish from one side only.
    assertLinkedLoanDeleteAllowed(loan);

    const related = get().transactions.filter((t) => t.relatedLoanId === loanId);
    const repayments = related.filter((t) => t.type === 'repayment');
    const origins = related.filter((t) => t.type === 'loan_given' || t.type === 'loan_taken');

    await runSafeMutation(async (scope) => {
      const accountStore = useAccountStore.getState();

      // 1) Reverse every repayment's balance legs and remove the rows. The
      //    per-row loan restore is skipped — the loan itself dies at the end.
      //    Missing (soft-deleted) accounts simply skip their leg.
      for (const r of repayments) {
        const isLedgerRecord = !r.sourceAccountId && !r.destinationAccountId;
        if (!isLedgerRecord && loan.type === 'given') {
          const destination = r.destinationAccountId ? accountStore.getAccount(r.destinationAccountId) : undefined;
          const credited = r.conversionRate
            ? Math.round(r.amount * r.conversionRate * 100) / 100
            : r.amount;
          if (destination) {
            checkReversalBalance(destination, credited, options.allowNegative);
            await trackedBalanceDelta(scope, destination.id, -credited);
          }
        } else if (!isLedgerRecord) {
          const source = r.sourceAccountId ? accountStore.getAccount(r.sourceAccountId) : undefined;
          const deducted = r.conversionRate
            ? Math.round((r.amount / r.conversionRate) * 100) / 100
            : r.amount;
          if (source) await trackedBalanceDelta(scope, source.id, deducted);
          if (r.destinationAccountId) {
            const cashAdvanceCard = accountStore.getAccount(r.destinationAccountId);
            if (cashAdvanceCard) {
              const creditedBack = cardCreditedAmountOf(r);
              checkReversalBalance(cashAdvanceCard, creditedBack, options.allowNegative);
              await trackedBalanceDelta(scope, cashAdvanceCard.id, -creditedBack);
            }
          }
        }
        await trackedDeleteTransaction(scope, r);
      }

      // 2) Reverse the principal legs of the origin entry (if any — ledger-only
      //    loans have none) and remove it. Mirrors the single-delete branches.
      for (const o of origins) {
        if (o.type === 'loan_given') {
          const source = o.sourceAccountId ? accountStore.getAccount(o.sourceAccountId) : undefined;
          if (source) await trackedBalanceDelta(scope, source.id, o.amount);
        } else {
          const destination = o.destinationAccountId ? accountStore.getAccount(o.destinationAccountId) : undefined;
          if (destination) await trackedBalanceDelta(scope, destination.id, -o.amount);
          if (o.sourceAccountId) {
            const cashAdvanceCard = accountStore.getAccount(o.sourceAccountId);
            if (cashAdvanceCard) await trackedBalanceDelta(scope, cashAdvanceCard.id, o.amount);
          }
        }
        await trackedDeleteTransaction(scope, o);
      }

      // 3) Schedule and loan row last, so LIFO rollback restores them first.
      await trackedDeleteEmisByLoan(scope, loanId);
      await trackedDeleteLoan(scope, loanId);
    }, refetchMoneyStores, 'transactionStore.deleteLoanCascade');

    await logActivitySafe(
      'transaction_deleted',
      `Deleted loan with ${loan.personName} (${loan.currency} ${loan.totalAmount}) — ${repayments.length + origins.length} record(s) removed, balances restored`,
      loanId,
      'loan',
    );

    nudgeReminderSchedule();
  },

  getTransaction: (id) => get().transactions.find((transaction) => transaction.id === id),

  getByAccount: (accountId) =>
    get().transactions.filter(
      (t) => t.sourceAccountId === accountId || t.destinationAccountId === accountId
    ),

  getByLoan: (loanId) => get().transactions.filter((t) => t.relatedLoanId === loanId),

  // Re-insert a previously-deleted transaction with its original id and
  // re-apply the balance delta that the delete had reversed. Used only by
  // splitStore.updateGroupExpense rollback. Best-effort: failure of the
  // balance step does NOT abort the row re-insert — we accept a small drift
  // over leaving the ledger row missing entirely. The mutationScope upstream
  // will surface drift via refetch.
  restoreTransaction: async (snapshot) => {
    // Only expense/income balance effects can be faithfully re-applied here.
    // Anything else (loans, EMIs, goals, cards, trades) would resurrect the
    // row WITHOUT its money — and a later re-delete would reverse balances a
    // second time, minting money. Callers (Undo toasts) must not offer this
    // for other types; this guard makes that a hard rule, not a convention.
    if (snapshot.type !== 'expense' && snapshot.type !== 'income') {
      throw new Error('Undo is only supported for expense and income entries');
    }
    const accountStore = useAccountStore.getState();
    await transactionsDb.add(snapshot);
    await mirrorPut(db.transactions, snapshot);
    markMirrorStale('transactions');
    set((s) => ({ transactions: [snapshot, ...s.transactions] }));

    // Re-apply balance deltas matching the snapshot's type. Only the small
    // subset of types that linked group-expenses can produce is handled —
    // everything else is left to manual reconciliation.
    try {
      if (snapshot.type === 'expense' && snapshot.sourceAccountId) {
        await accountStore.updateBalance(snapshot.sourceAccountId, -snapshot.amount);
      } else if (snapshot.type === 'income' && snapshot.destinationAccountId) {
        await accountStore.updateBalance(snapshot.destinationAccountId, snapshot.amount);
      }
    } catch (err) {
      // Row restored but the balance leg did not re-apply — a real desync.
      reportError(err, {
        feature: 'transactionStore.restoreTransaction.balanceReapply',
        extra: { transactionId: snapshot.id, transactionType: snapshot.type },
      });
    }

    nudgeReminderSchedule();
  },
}));
