import { supabase } from './supabase';
import { tStatic } from './i18n';
// Trust & safety (audit M17): pure error→outcome mapping and the server-side
// text caps, kept out of this file so they stay unit-testable in Node.
import {
  BLOCK_REASON_MAX,
  REPORT_CONTEXT_ID_MAX,
  REPORT_CONTEXT_TYPE_MAX,
  REPORT_DETAILS_MAX,
  REPORT_REASON_MAX,
  blockOutcomeFromError,
  normalizeFreeText,
  reportOutcomeFromError,
  type BlockOutcome,
  type ReportContextType,
  type ReportOutcome,
  type ReportReason,
} from './blockStatus';
import {
  joinStatusFromThrown,
  parseJoinByCodeResponse,
  inviteStatusFromThrown,
  parseAcceptInviteResponse,
  type JoinCodeResult,
  type InviteAcceptResult,
} from './joinCodeStatus';
import {
  parseGroupPreviewResponse,
  previewStatusFromThrown,
  type GroupPreviewResult,
} from './groupPreview';
import { isMemberAlreadyExistsError } from './groupGuardErrors';
import {
  missingAdminRpcResult,
  parseSetGroupAdminResult,
  type SetGroupAdminResult,
} from './groupRoles';
import {
  isMissingFunctionError,
  linkStatusFromThrown,
  parseLinkByCodeResponse,
  parseUnlinkResponse,
  type ContactLinkResult,
  type ContactUnlinkResult,
} from './contactLinkStatus';
import { fetchAllPages, type PagedFetchResult } from './pagedFetch';
import { shouldStopWindowPaging } from './historyWindow';
import type { KeysetCursor } from './listPaging';
import type { DailySeriesRow, MonthlySummaryRow, TopExpenseRow } from './analytics';
import type { RecordSettlementResult } from './groupSettlementResult';
// Audit G5/O10 edit history. Types only — the renderer is pure and stays out
// of this module (see the `editHistoryDb` section at the end of the file).
import type { EditHistoryEntry, EditHistoryTable } from './editHistory';
import type {
  Account, Transaction, Loan, EmiSchedule, Goal,
  ActivityLog, UpcomingExpense, SplitGroup, GroupExpense, GroupSettlement,
  GroupMember, GroupInvite, GroupEvent, AppNotification, Person,
  LinkedRequest, LinkedRequestKind, SettlementRequest, Currency,
  Budget, RecurringTransaction, Remittance, CustomCategory,
  Committee, CommitteeMember, CommitteePayment,
  InvestmentMarket, InvestmentTrade, InvestmentPrice,
} from '../db';

export interface DeletedRow {
  id: string;
  deletedAt: string;
}

// Helper to get current user ID (cached in localStorage by App.tsx)
function getUserId(): string {
  const userId = localStorage.getItem('hisaab_supabase_uid');
  if (!userId) throw new Error('Not authenticated');
  return userId;
}

// ══════════════════════════════════════
// ACCOUNTS
// ══════════════════════════════════════
export const accountsDb = {
  async getAll(): Promise<Account[]> {
    const { data, error } = await supabase
      .from('accounts').select('*')
      .eq('user_id', getUserId())
      .is('deleted_at', null)
      .order('created_at', { ascending: true });
    if (error) throw error;
    return (data ?? []).map(mapAccount);
  },
  async getUpdatedSince(updatedAfter: string): Promise<Account[]> {
    const { data, error } = await supabase
      .from('accounts').select('*')
      .eq('user_id', getUserId())
      .is('deleted_at', null)
      .gt('updated_at', updatedAfter)
      .order('updated_at', { ascending: true });
    if (error) throw error;
    return (data ?? []).map(mapAccount);
  },
  async getDeletedSince(deletedAfter: string): Promise<DeletedRow[]> {
    const { data, error } = await supabase
      .from('accounts').select('id, deleted_at')
      .eq('user_id', getUserId())
      .gt('deleted_at', deletedAfter)
      .order('deleted_at', { ascending: true });
    if (error) throw error;
    return (data ?? []).map(mapDeletedRow);
  },
  async add(a: Account) {
    const { error } = await supabase.from('accounts').insert({
      id: a.id, user_id: getUserId(), name: a.name, type: a.type,
      currency: a.currency, balance: a.balance, metadata: a.metadata, created_at: a.createdAt,
    });
    if (error) throw error;
  },
  async update(id: string, changes: Partial<Account>) {
    // Balance updates MUST go through applyBalanceDelta (optimistic lock).
    // Updating balance through this path is permitted only as a last-resort
    // (e.g. reconciliation), so we leave it in place but log a warning.
    if (changes.balance !== undefined && import.meta.env.DEV) {
      console.warn('[accountsDb.update] balance changed without optimistic lock — prefer accountsDb.applyBalanceDelta');
    }
    const row: Record<string, unknown> = {};
    if (changes.balance !== undefined) row.balance = changes.balance;
    if (changes.name !== undefined) row.name = changes.name;
    if (changes.metadata !== undefined) row.metadata = changes.metadata;
    const { error } = await supabase.from('accounts').update(row).eq('id', id).eq('user_id', getUserId());
    if (error) throw error;
  },
  // Optimistic-locked balance mutation. Calls the apply_account_balance_delta RPC
  // which performs `UPDATE accounts SET balance = balance + $delta WHERE balance = $expected`.
  // Throws { code: 'BALANCE_CONFLICT' } if expected_balance didn't match — caller
  // should refresh the local row and retry.
  async applyBalanceDelta(id: string, expectedBalance: number, delta: number): Promise<number> {
    const { data, error } = await supabase.rpc('apply_account_balance_delta', {
      p_account_id: id,
      p_delta: delta,
      p_expected_balance: expectedBalance,
    });
    if (error) {
      const err = error as { message?: string };
      if (err?.message?.includes('BALANCE_CONFLICT')) {
        const conflict = new Error('BALANCE_CONFLICT') as Error & { code: string };
        conflict.code = 'BALANCE_CONFLICT';
        throw conflict;
      }
      throw error;
    }
    return typeof data === 'number' ? data : Number(data);
  },
  async delete(id: string) {
    const { error } = await supabase
      .from('accounts')
      .update({ deleted_at: new Date().toISOString() })
      .eq('id', id)
      .eq('user_id', getUserId());
    if (error) throw error;
  },
  // A plain GET, deliberately not `head: true`: on the live PWA a HEAD through
  // the service worker was observed surfacing as a 503 in the browser while
  // Supabase's edge logged 200 (2026-09-03 post-deploy smoke check). Both
  // callers fall back to 0 on error, and `completeOnboarding` turns 0 into
  // "create a starter wallet" — so a flaky probe could mint a duplicate wallet.
  // Reading the ids (a user has tens of accounts, never thousands) is exact
  // and has no HEAD-specific failure mode.
  async count(): Promise<number> {
    const { data, error } = await supabase
      .from('accounts').select('id')
      .eq('user_id', getUserId())
      .is('deleted_at', null);
    if (error) throw error;
    return data?.length ?? 0;
  },
};

// ══════════════════════════════════════
// TRANSACTIONS
// ══════════════════════════════════════
// Well under the PostgREST max-rows cap (hosted default 1000) so a short page
// genuinely means "end of table" rather than "the server stopped early".
const TRANSACTION_PAGE_SIZE = 500;

/**
 * A bounded history read. `rows` is the newest slice of the table; the two
 * extra fields say what that slice PROVES (see `src/lib/historyWindow.ts`).
 */
export interface TransactionWindowResult extends PagedFetchResult<Transaction> {
  /**
   * The result contains every non-deleted row with `createdAt >= coveredSince`.
   * `null` only when `complete` is true (the walk reached the end of the table).
   */
  coveredSince: string | null;
  /** The walk reached the end of the table: this IS the whole history. */
  complete: boolean;
}

export const transactionsDb = {
  async get(id: string): Promise<Transaction | null> {
    const { data, error } = await supabase
      .from('transactions').select('*')
      .eq('id', id).eq('user_id', getUserId()).is('deleted_at', null).single();
    if (error) return null;
    return data ? mapTransaction(data) : null;
  },
  /**
   * Complete transaction history. Keyset-paged: an unbounded `select('*')` is
   * silently truncated by PostgREST at its max-rows cap (~1000), and the mirror
   * then deleted the overflow locally — invisible history loss about a year in
   * (audit 04-supabase F-FE1). Use `getAllPaged` when you need to know whether
   * the result is complete before overwriting a local copy.
   */
  async getAll(): Promise<Transaction[]> {
    return (await transactionsDb.getAllPaged()).rows;
  },
  async getAllPaged(): Promise<PagedFetchResult<Transaction>> {
    const userId = getUserId();
    return fetchAllPages<Transaction>({
      label: 'transactions.getAll',
      pageSize: TRANSACTION_PAGE_SIZE,
      idOf: (t) => t.id,
      cursorOf: (t) => t.createdAt,
      fetchPage: async (cursor, limit) => {
        let query = supabase
          .from('transactions').select('*')
          .eq('user_id', userId)
          .is('deleted_at', null);
        // Inclusive bound — rows sharing a created_at can straddle a page
        // boundary; fetchAllPages de-duplicates the overlap by id.
        if (cursor) query = query.lte('created_at', cursor);
        const { data, error } = await query
          .order('created_at', { ascending: false })
          .order('id', { ascending: false })
          .limit(limit);
        if (error) throw error;
        return (data ?? []).map(mapTransaction);
      },
    });
  },
  /**
   * The DEFAULT history read: the newest slice, bounded by a date floor AND a
   * row floor (12 months / 1000 rows — `src/lib/historyWindow.ts` owns both
   * numbers and the reasoning).
   *
   * Same keyset walk as `getAllPaged`, with one difference: it stops as soon as
   * BOTH floors are satisfied. `since` is NOT pushed into the SQL as a
   * `gte('created_at', …)` filter, because the row floor has to be able to
   * reach PAST it — a user with 200 lifetime entries gets their whole history
   * (and `complete: true`) rather than 12 months of it.
   *
   * The stop is implemented by making `fetchPage` return an empty page once the
   * floors are met, which is `fetchAllPages`' normal end-of-table signal. That
   * keeps this on the audited pager — id de-duplication, the inclusive cursor
   * bound, and H4's truncation detection all still apply — instead of forking a
   * second keyset loop that would have to re-earn that trust.
   *
   * No predicate on either account id: a `splits_only` row with BOTH account
   * ids null is windowed by date exactly like a full-tracker row.
   */
  async getWindowPaged(options: { since: string; minRows?: number }): Promise<TransactionWindowResult> {
    const userId = getUserId();
    const minRows = options.minRows ?? 0;
    let stopped = false;
    let reachedEnd = false;
    let fetched = 0;
    let oldestFetched: string | null = null;

    const result = await fetchAllPages<Transaction>({
      label: 'transactions.getWindow',
      pageSize: TRANSACTION_PAGE_SIZE,
      idOf: (t) => t.id,
      cursorOf: (t) => t.createdAt,
      fetchPage: async (cursor, limit) => {
        if (stopped) return [];
        let query = supabase
          .from('transactions').select('*')
          .eq('user_id', userId)
          .is('deleted_at', null);
        // Inclusive bound — rows sharing a created_at can straddle a page
        // boundary; fetchAllPages de-duplicates the overlap by id.
        if (cursor) query = query.lte('created_at', cursor);
        const { data, error } = await query
          .order('created_at', { ascending: false })
          .order('id', { ascending: false })
          .limit(limit);
        if (error) throw error;
        const page = (data ?? []).map(mapTransaction);
        fetched += page.length;
        const last = page[page.length - 1];
        if (last) oldestFetched = last.createdAt;
        // A short page normally means end-of-table — EXCEPT when its length is
        // a round hundred, which is far more likely a PostgREST max-rows cap
        // (the same heuristic `fetchAllPages` uses to decide whether to probe).
        // Normally the pager's own probe would settle it, but once we have
        // stopped, the probe comes back empty and cannot; so a suspicious short
        // page is simply never accepted as proof that we saw the whole table.
        if (page.length < limit && !(page.length > 0 && page.length % 100 === 0)) {
          reachedEnd = true;
        }
        stopped = shouldStopWindowPaging({
          oldestFetched,
          rowsFetched: fetched,
          since: options.since,
          minRows,
        });
        return page;
      },
    });

    // `reachedEnd` can only be true if a page came back short, which means the
    // walk saw the oldest row the user owns. Truncation (H4) is the opposite
    // claim, so it vetoes completeness.
    const complete = reachedEnd && !result.truncated;
    return {
      ...result,
      complete,
      // On truncation the pager could not advance its cursor, so the floor we
      // can honestly claim is the last row it managed to read — not `since`.
      coveredSince: complete ? null : (result.truncated ? oldestFetched : options.since),
    };
  },
  /**
   * The on-demand older-history read: every non-deleted row in
   * `[from, to]` (both inclusive). Backs `ensureTransactionHistory({ since })`,
   * which only ever asks for the gap BELOW the coverage floor it already has —
   * so this is a bounded fetch, not a second front door to the whole table.
   */
  async getRangePaged(from: string, to?: string | null): Promise<PagedFetchResult<Transaction>> {
    const userId = getUserId();
    return fetchAllPages<Transaction>({
      label: 'transactions.getRange',
      pageSize: TRANSACTION_PAGE_SIZE,
      idOf: (t) => t.id,
      cursorOf: (t) => t.createdAt,
      fetchPage: async (cursor, limit) => {
        let query = supabase
          .from('transactions').select('*')
          .eq('user_id', userId)
          .is('deleted_at', null)
          .gte('created_at', from);
        // The cursor tightens the upper bound as we walk down; `to` is the
        // initial one. Inclusive on both, as everywhere else in this file.
        const upper = cursor ?? to ?? null;
        if (upper) query = query.lte('created_at', upper);
        const { data, error } = await query
          .order('created_at', { ascending: false })
          .order('id', { ascending: false })
          .limit(limit);
        if (error) throw error;
        return (data ?? []).map(mapTransaction);
      },
    });
  },
  async getUpdatedSince(updatedAfter: string): Promise<Transaction[]> {
    const userId = getUserId();
    const { rows } = await fetchAllPages<Transaction>({
      label: 'transactions.getUpdatedSince',
      pageSize: TRANSACTION_PAGE_SIZE,
      idOf: (t) => t.id,
      // mapTransaction falls back to created_at, so this is never null.
      cursorOf: (t) => t.updatedAt ?? null,
      fetchPage: async (cursor, limit) => {
        let query = supabase
          .from('transactions').select('*')
          .eq('user_id', userId)
          .is('deleted_at', null);
        query = cursor
          ? query.gte('updated_at', cursor)
          : query.gt('updated_at', updatedAfter);
        const { data, error } = await query
          .order('updated_at', { ascending: true })
          .order('id', { ascending: true })
          .limit(limit);
        if (error) throw error;
        return (data ?? []).map(mapTransaction);
      },
    });
    return rows;
  },
  async getDeletedSince(deletedAfter: string): Promise<DeletedRow[]> {
    const userId = getUserId();
    const { rows } = await fetchAllPages<DeletedRow>({
      label: 'transactions.getDeletedSince',
      pageSize: TRANSACTION_PAGE_SIZE,
      idOf: (r) => r.id,
      cursorOf: (r) => r.deletedAt ?? null,
      fetchPage: async (cursor, limit) => {
        let query = supabase
          .from('transactions').select('id, deleted_at')
          .eq('user_id', userId);
        query = cursor
          ? query.gte('deleted_at', cursor)
          : query.gt('deleted_at', deletedAfter);
        const { data, error } = await query
          .order('deleted_at', { ascending: true })
          .order('id', { ascending: true })
          .limit(limit);
        if (error) throw error;
        return (data ?? []).map(mapDeletedRow);
      },
    });
    return rows;
  },
  async add(t: Transaction) {
    const { error } = await supabase.from('transactions').upsert({
      id: t.id, user_id: getUserId(), type: t.type, amount: t.amount, currency: t.currency,
      source_account_id: t.sourceAccountId, destination_account_id: t.destinationAccountId,
      related_person: t.relatedPerson, person_id: t.personId ?? null, related_loan_id: t.relatedLoanId,
      related_goal_id: t.relatedGoalId,
      // Only sent when set: keeps every NON-investment entry working on a
      // database that hasn't applied supabase-migration-investments.sql yet
      // (an unknown column in the payload would fail the whole insert).
      ...(t.relatedInvestmentId != null ? { related_investment_id: t.relatedInvestmentId } : {}),
      conversion_rate: t.conversionRate,
      category: t.category, notes: t.notes, created_at: t.createdAt,
      is_reconciled: t.isReconciled ?? false,
      reconciled_at: t.reconciledAt ?? null,
      reconciled_by: t.reconciledBy ?? null,
      receipt_path: t.receiptPath ?? null,
      deleted_at: null,
    });
    if (error) throw error;
  },
  async update(id: string, changes: Partial<Transaction>) {
    const row: Record<string, unknown> = {};
    if (changes.type !== undefined) row.type = changes.type;
    if (changes.amount !== undefined) row.amount = changes.amount;
    if (changes.currency !== undefined) row.currency = changes.currency;
    if (changes.sourceAccountId !== undefined) row.source_account_id = changes.sourceAccountId;
    if (changes.destinationAccountId !== undefined) row.destination_account_id = changes.destinationAccountId;
    if (changes.relatedPerson !== undefined) row.related_person = changes.relatedPerson;
    if (changes.personId !== undefined) row.person_id = changes.personId;
    if (changes.relatedLoanId !== undefined) row.related_loan_id = changes.relatedLoanId;
    if (changes.relatedGoalId !== undefined) row.related_goal_id = changes.relatedGoalId;
    if (changes.relatedInvestmentId !== undefined) row.related_investment_id = changes.relatedInvestmentId;
    if (changes.conversionRate !== undefined) row.conversion_rate = changes.conversionRate;
    if (changes.category !== undefined) row.category = changes.category;
    if (changes.notes !== undefined) row.notes = changes.notes;
    if (changes.isReconciled !== undefined) row.is_reconciled = changes.isReconciled;
    if (changes.reconciledAt !== undefined) row.reconciled_at = changes.reconciledAt;
    if (changes.reconciledBy !== undefined) row.reconciled_by = changes.reconciledBy;
    if (changes.receiptPath !== undefined) row.receipt_path = changes.receiptPath;
    const { error } = await supabase.from('transactions').update(row).eq('id', id).eq('user_id', getUserId());
    if (error) throw error;
  },
  async delete(id: string) {
    const { error } = await supabase
      .from('transactions')
      .update({ deleted_at: new Date().toISOString() })
      .eq('id', id)
      .eq('user_id', getUserId());
    if (error) throw error;
  },
  // Narrow helper used only by the Phase 1B-A backfill. Deliberately separate
  // from the general `update` path so the write surface is grep-auditable.
  async setPersonId(id: string, personId: string) {
    const { error } = await supabase
      .from('transactions').update({ person_id: personId })
      .eq('id', id).eq('user_id', getUserId());
    if (error) throw error;
  },
};

// ══════════════════════════════════════
// LOANS
// ══════════════════════════════════════
export const loansDb = {
  async get(id: string): Promise<Loan | null> {
    const { data, error } = await supabase
      .from('loans').select('*')
      .eq('id', id).eq('user_id', getUserId()).is('deleted_at', null).maybeSingle();
    if (error) throw error;
    return data ? mapLoan(data) : null;
  },
  /**
   * Keyset-paged (audit 04-supabase F-FE1 / 05-security M12): an unbounded
   * `select('*')` is silently truncated by PostgREST at its max-rows cap
   * (~1000), and the mirror would then delete the overflow locally — the same
   * invisible history loss transactionsDb.getAll used to cause.
   */
  async getAll(): Promise<Loan[]> {
    const userId = getUserId();
    const { rows } = await fetchAllPages<Loan>({
      label: 'loans.getAll',
      pageSize: 500,
      idOf: (l) => l.id,
      cursorOf: (l) => l.createdAt,
      fetchPage: async (cursor, limit) => {
        let query = supabase
          .from('loans').select('*')
          .eq('user_id', userId)
          .is('deleted_at', null);
        // Inclusive bound — rows sharing a created_at can straddle a page
        // boundary; fetchAllPages de-duplicates the overlap by id.
        if (cursor) query = query.lte('created_at', cursor);
        const { data, error } = await query
          .order('created_at', { ascending: false })
          .order('id', { ascending: false })
          .limit(limit);
        if (error) throw error;
        return (data ?? []).map(mapLoan);
      },
    });
    return rows;
  },
  async getUpdatedSince(updatedAfter: string): Promise<Loan[]> {
    const { data, error } = await supabase
      .from('loans').select('*')
      .eq('user_id', getUserId())
      .is('deleted_at', null)
      .gt('updated_at', updatedAfter)
      .order('updated_at', { ascending: true });
    if (error) throw error;
    return (data ?? []).map(mapLoan);
  },
  async getDeletedSince(deletedAfter: string): Promise<DeletedRow[]> {
    const { data, error } = await supabase
      .from('loans').select('id, deleted_at')
      .eq('user_id', getUserId())
      .gt('deleted_at', deletedAfter)
      .order('deleted_at', { ascending: true });
    if (error) throw error;
    return (data ?? []).map(mapDeletedRow);
  },
  async add(l: Loan) {
    const { error } = await supabase.from('loans').upsert({
      id: l.id, user_id: getUserId(), person_name: l.personName, person_id: l.personId ?? null, type: l.type,
      total_amount: l.totalAmount, remaining_amount: l.remainingAmount,
      currency: l.currency, status: l.status, notes: l.notes, created_at: l.createdAt,
      deleted_at: null,
    });
    if (error) throw error;
  },
  // Optimistic-locked remaining-amount mutation — the loan twin of
  // accountsDb.applyBalanceDelta. Calls apply_loan_remaining_delta
  // (supabase-migration-audit-p0-loan-concurrency.sql), which performs
  // `remaining_amount = round(GREATEST(0, remaining_amount + delta), 2)` ONLY
  // when remaining_amount still equals p_expected_remaining, and re-derives
  // status in the same statement. Returns the new remaining amount.
  // Throws { code: 'LOAN_REMAINING_CONFLICT' } when the row moved under us
  // (another device/tab) and { code: 'LOAN_NOT_FOUND' } when it is gone or not
  // ours — src/lib/loanRemainingDelta.ts owns the refetch-and-retry ladder.
  // Every remainingAmount write must come through here (audit F-2 / C-1); the
  // absolute `update` path below is for the other columns.
  async applyRemainingDelta(id: string, expectedRemaining: number, delta: number): Promise<number> {
    const { data, error } = await supabase.rpc('apply_loan_remaining_delta', {
      p_loan_id: id,
      p_delta: delta,
      p_expected_remaining: expectedRemaining,
    });
    if (error) {
      const message = (error as { message?: string })?.message ?? '';
      for (const code of ['LOAN_REMAINING_CONFLICT', 'LOAN_NOT_FOUND'] as const) {
        if (message.includes(code)) {
          const coded = new Error(code) as Error & { code: string };
          coded.code = code;
          throw coded;
        }
      }
      throw error;
    }
    return typeof data === 'number' ? data : Number(data);
  },
  async update(id: string, changes: Partial<Loan>) {
    // remaining_amount MUST go through applyRemainingDelta (optimistic lock).
    // It is still accepted here for the linked-loan/backfill paths that write a
    // whole row, but a bare absolute write is the F-2 lost-update bug.
    if (changes.remainingAmount !== undefined && import.meta.env.DEV) {
      console.warn('[loansDb.update] remainingAmount changed without optimistic lock — prefer loansDb.applyRemainingDelta');
    }
    const row: Record<string, unknown> = {};
    if (changes.personName !== undefined) row.person_name = changes.personName;
    if (changes.personId !== undefined) row.person_id = changes.personId;
    if (changes.totalAmount !== undefined) row.total_amount = changes.totalAmount;
    if (changes.remainingAmount !== undefined) row.remaining_amount = changes.remainingAmount;
    if (changes.currency !== undefined) row.currency = changes.currency;
    if (changes.status !== undefined) row.status = changes.status;
    if (changes.notes !== undefined) row.notes = changes.notes;
    const { error } = await supabase.from('loans').update(row).eq('id', id).eq('user_id', getUserId());
    if (error) throw error;
  },
  async delete(id: string) {
    const { error } = await supabase
      .from('loans')
      .update({ deleted_at: new Date().toISOString() })
      .eq('id', id)
      .eq('user_id', getUserId());
    if (error) throw error;
  },
  // Narrow helper used only by the Phase 1B-A backfill. See transactionsDb.setPersonId.
  async setPersonId(id: string, personId: string) {
    const { error } = await supabase
      .from('loans').update({ person_id: personId })
      .eq('id', id).eq('user_id', getUserId());
    if (error) throw error;
  },
};

// ══════════════════════════════════════
// PERSONS (contacts)
// ══════════════════════════════════════

// The pre-RPC direct write, kept ONLY for a database that has not had
// supabase-migration-audit-p0-consent-guards.sql applied yet (PostgREST
// PGRST202 / 42883: the function isn't there). Migrations in this repo are
// applied by hand, so a client build can meet either database; on a migrated
// one this path is rejected by the guard trigger with 42501 and must never be
// reached. Not exported — both link entry points fall back through here.
async function legacyDirectContactLink(
  personId: string,
  profileId: string,
  displayName: string,
): Promise<ContactLinkResult> {
  const { error } = await supabase
    .from('persons').update({ linked_profile_id: profileId })
    .eq('id', personId).eq('user_id', getUserId());
  if (error) return { status: linkStatusFromThrown(error) };
  // Best-effort ping, exactly as apply_verified_contact_link does server-side:
  // a notification failure must never undo a link that already succeeded.
  try {
    await personsDb.notifyContactLinked(profileId);
  } catch (err) {
    console.error('notifyContactLinked failed (non-fatal)', err);
  }
  // The reciprocal side is unknowable from here without another round trip;
  // 'pending' is the fail-closed answer (it only shows the waiting copy).
  return { status: 'ok', profileId, displayName: displayName || 'Hisaab user', linkState: 'pending' };
}

export const personsDb = {
  async getAll(): Promise<Person[]> {
    const { data, error } = await supabase
      .from('persons').select('*')
      .eq('user_id', getUserId())
      .is('archived_at', null)
      .order('name', { ascending: true });
    if (error) throw error;
    return (data ?? []).map(mapPerson);
  },
  // linked_profile_id is deliberately NOT sent (audit 2026-09 C6 / H2): the
  // consent-guard trigger rejects a non-null value from a client role on
  // INSERT too, and a link may only be created through link_contact_by_code or
  // link_contact_by_discovery.
  async add(p: Person) {
    const { error } = await supabase.from('persons').insert({
      id: p.id, user_id: getUserId(), name: p.name, phone: p.phone ?? null,
      created_at: p.createdAt, updated_at: p.updatedAt,
    });
    if (error) throw error;
  },
  // Create a contact link from the OTHER person's public code. The RPC checks
  // the code server-side (shared 20/hour lookup window), writes the column as
  // definer, and fires notify_contact_linked itself — so the client no longer
  // does either. Never throws on a business outcome; read `.status`.
  //
  // `legacy` keeps a build that lands BEFORE the migration working: when the
  // function is absent we fall back to the old direct write (still permitted
  // there, since the guard trigger arrives in the same file as the RPC).
  async linkByCode(
    personId: string,
    codeNormalized: string,
    legacy?: { profileId: string; displayName: string } | null,
  ): Promise<ContactLinkResult> {
    const { data, error } = await supabase.rpc('link_contact_by_code', {
      p_person_id: personId,
      p_code_normalized: codeNormalized,
    });
    if (!error) return parseLinkByCodeResponse(data);
    // A missing link_contact_by_code means the whole consent-guard file is
    // unapplied, so link_contact_by_discovery is missing too — go straight to
    // the legacy write instead of burning a round trip discovering that.
    if (isMissingFunctionError(error) && legacy?.profileId) {
      return legacyDirectContactLink(personId, legacy.profileId, legacy.displayName);
    }
    return { status: linkStatusFromThrown(error) };
  },
  // The code-LESS link: a phone-discovery hit carries a profile id and no
  // public code. The RPC does NOT trust that pairing — it re-runs the discovery
  // match server-side (this contact's saved phone, normalised the same way
  // phoneIdentity.toE164Candidates does it, against the target's phone_e164
  // while their phone_discoverable opt-in still holds), so we can only link
  // someone lookup_hisaab_users_by_phone would have returned anyway. Charged to
  // the phone-discovery window (20/hour) on a miss, not on a match.
  //
  // Same status vocabulary and same JSON shape as link_contact_by_code, hence
  // the shared parser. Never throws on a business outcome; read `.status`.
  async linkByProfileId(
    personId: string,
    profileId: string,
    displayName: string,
  ): Promise<ContactLinkResult> {
    const { data, error } = await supabase.rpc('link_contact_by_discovery', {
      p_person_id: personId,
      p_profile_id: profileId,
    });
    if (!error) return parseLinkByCodeResponse(data);
    // ONLY "the function isn't there" falls back. A 42501 must NOT: on a
    // migrated database the discovery RPC is the supported path, so a rejection
    // is a real answer and retrying the forbidden write would just relabel it.
    if (isMissingFunctionError(error)) {
      return legacyDirectContactLink(personId, profileId, displayName);
    }
    return { status: linkStatusFromThrown(error) };
  },
  // Clears the link. Same semantics as the old PATCH, minus the ability to
  // point the column anywhere.
  async unlinkProfile(personId: string): Promise<ContactUnlinkResult> {
    const { data, error } = await supabase.rpc('unlink_contact_profile', {
      p_person_id: personId,
    });
    if (!error) return parseUnlinkResponse(data);
    if (isMissingFunctionError(error)) {
      const { error: legacyError } = await supabase
        .from('persons').update({ linked_profile_id: null })
        .eq('id', personId).eq('user_id', getUserId());
      if (legacyError) return { status: linkStatusFromThrown(legacyError) };
      return { status: 'ok', wasLinked: true, unlinkedProfileId: null };
    }
    return { status: linkStatusFromThrown(error) };
  },
  async setPhone(id: string, phone: string | null) {
    const { error } = await supabase
      .from('persons').update({ phone })
      .eq('id', id).eq('user_id', getUserId());
    if (error) throw error;
  },
  async archiveIfSettled(id: string): Promise<ArchiveContactResult> {
    const { data, error } = await supabase.rpc('archive_contact_if_settled', {
      p_contact_id: id,
    });
    if (error) throw error;
    const row = Array.isArray(data) ? data[0] : data;
    return {
      success: Boolean(row?.success),
      reasonCode: (row?.reason_code as ArchiveContactResult['reasonCode']) ?? 'CONTACT_NOT_FOUND',
      userMessage: (row?.user_message as string) ?? 'This contact could not be removed.',
      payableAmount: (row?.payable_amount as Record<string, number>) ?? {},
      receivableAmount: (row?.receivable_amount as Record<string, number>) ?? {},
    };
  },
  // Phase 2A: SECURITY DEFINER RPC. Caller must pass the already-normalised
  // code (same rules as collaboration.normalizePublicCode). Returns null if
  // no match, the resolver's own code, or an invalid code.
  async lookupProfileByCode(normalisedCode: string): Promise<{ profileId: string; displayName: string } | null> {
    const { data, error } = await supabase.rpc('lookup_profile_by_code', { code: normalisedCode });
    if (error) throw error;
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) return null;
    return {
      profileId: (row.profile_id as string) ?? '',
      displayName: (row.display_name as string) ?? 'Hisaab user',
    };
  },
  // Tell the code owner that the caller just linked them (consensual — the
  // owner shared their code). SECURITY DEFINER RPC, guarded server-side so you
  // can only ping someone you've actually linked. Best-effort at the call site.
  async notifyContactLinked(profileId: string): Promise<void> {
    const { error } = await supabase.rpc('notify_contact_linked', { target_profile_id: profileId });
    if (error) throw error;
  },
  // Archived contacts are hidden from getAll; this is the explicit window
  // into them (the "Archived" section on ContactsPage).
  async getArchived(): Promise<Person[]> {
    const { data, error } = await supabase
      .from('persons').select('*')
      .eq('user_id', getUserId())
      .not('archived_at', 'is', null)
      .order('name', { ascending: true });
    if (error) throw error;
    return (data ?? []).map(mapPerson);
  },
  // SECURITY DEFINER RPC (supabase-migration-contacts-merge-unarchive.sql):
  // reassigns every reference from the LOCAL source contact to the target
  // atomically server-side, then archives the source.
  async merge(sourceId: string, targetId: string): Promise<MergePersonResult> {
    const { data, error } = await supabase.rpc('merge_person', {
      p_source_id: sourceId,
      p_target_id: targetId,
    });
    if (error) throw error;
    const row = Array.isArray(data) ? data[0] : data;
    return {
      success: Boolean(row?.success),
      reasonCode: (row?.reason_code as MergePersonResult['reasonCode']) ?? 'CONTACT_NOT_FOUND',
      userMessage: (row?.user_message as string) ?? 'These contacts could not be merged.',
      movedLoans: Number(row?.moved_loans ?? 0),
      movedTransactions: Number(row?.moved_transactions ?? 0),
    };
  },
  // SECURITY DEFINER RPC — the protect-archive trigger blocks direct client
  // writes to archived_at, so restoring goes through the same door.
  async unarchive(id: string): Promise<boolean> {
    const { data, error } = await supabase.rpc('unarchive_contact', { p_contact_id: id });
    if (error) throw error;
    return Boolean(data);
  },
};

export interface MergePersonResult {
  success: boolean;
  reasonCode: 'MERGED' | 'CONTACT_NOT_FOUND' | 'LINKED_CONTACT' | 'SAME_CONTACT';
  userMessage: string;
  movedLoans: number;
  movedTransactions: number;
}

// ══════════════════════════════════════
// CONTACT LINK REQUESTS
// The "someone added you — add them back?" ask. Reads go through RLS
// (participants only); every write is a SECURITY DEFINER RPC, because
// accepting writes a persons row into the ACCEPTER's ledger and declining
// must be unforgeable by the adder.
// See supabase-migration-connections-push-discovery.sql.
// ══════════════════════════════════════
export interface ContactLinkRequest {
  id: string;
  fromUserId: string;
  toUserId: string;
  /** Display-name snapshot of the adder — the receiver can't read profiles. */
  fromName: string;
  status: 'pending' | 'accepted' | 'declined';
  createdAt: string;
  respondedAt: string | null;
}

function mapContactLinkRequest(row: Record<string, unknown>): ContactLinkRequest {
  return {
    id: String(row.id ?? ''),
    fromUserId: String(row.from_user_id ?? ''),
    toUserId: String(row.to_user_id ?? ''),
    fromName: String(row.from_name ?? '') || 'A Hisaab user',
    status: (row.status as ContactLinkRequest['status']) ?? 'pending',
    createdAt: String(row.created_at ?? ''),
    respondedAt: row.responded_at ? String(row.responded_at) : null,
  };
}

export interface RespondContactLinkResult {
  success: boolean;
  reasonCode: 'ACCEPTED' | 'DECLINED' | 'ALREADY_ACCEPTED' | 'ALREADY_DECLINED' | 'NOT_FOUND' | 'NOT_YOURS';
  personId: string | null;
}

export const contactLinksDb = {
  async getAll(): Promise<ContactLinkRequest[]> {
    const me = getUserId();
    const { data, error } = await supabase
      .from('contact_link_requests')
      .select('*')
      .or(`from_user_id.eq.${me},to_user_id.eq.${me}`)
      .order('created_at', { ascending: false });
    if (error) throw error;
    return (data ?? []).map((row) => mapContactLinkRequest(row as Record<string, unknown>));
  },
  async respond(requestId: string, accept: boolean): Promise<RespondContactLinkResult> {
    const { data, error } = await supabase.rpc('respond_contact_link', {
      p_request_id: requestId,
      p_accept: accept,
    });
    if (error) throw error;
    const row = Array.isArray(data) ? data[0] : data;
    return {
      success: Boolean(row?.success),
      reasonCode: (row?.reason_code as RespondContactLinkResult['reasonCode']) ?? 'NOT_FOUND',
      personId: row?.person_id ? String(row.person_id) : null,
    };
  },
};

// ══════════════════════════════════════
// PHONE DISCOVERY  (opt-in, both directions)
// The RPC compares E.164 numbers server-side and returns only the ones that
// matched — it never discloses a number the caller didn't already have.
// ══════════════════════════════════════
export interface PhoneMatch {
  phoneE164: string;
  profileId: string;
  displayName: string;
}

export const phoneDiscoveryDb = {
  /** Look up which of `numbers` (E.164) belong to discoverable Hisaab users.
   *  Max 60 per call, rate-limited server-side to 20 calls/hour. */
  async lookup(numbers: string[]): Promise<PhoneMatch[]> {
    if (numbers.length === 0) return [];
    const { data, error } = await supabase.rpc('lookup_hisaab_users_by_phone', {
      p_numbers: numbers,
    });
    if (error) throw error;
    return ((data ?? []) as Record<string, unknown>[]).map((row) => ({
      phoneE164: String(row.phone_e164 ?? ''),
      profileId: String(row.profile_id ?? ''),
      displayName: String(row.display_name ?? '') || 'Hisaab user',
    }));
  },
  /** Set (or clear, with null) the current user's own discoverable number. */
  async setMyPhone(e164: string | null, discoverable: boolean): Promise<void> {
    const { error } = await supabase
      .from('profiles')
      .update({ phone_e164: e164, phone_discoverable: e164 ? discoverable : false })
      .eq('id', getUserId());
    if (error) throw error;
  },
};

// ══════════════════════════════════════
// PUSH TOKENS (FCM)
// ══════════════════════════════════════
export const pushTokensDb = {
  async register(token: string, platform: 'android' | 'ios' | 'web' = 'android'): Promise<void> {
    const { error } = await supabase.rpc('register_push_token', {
      p_token: token,
      p_platform: platform,
    });
    if (error) throw error;
  },
  async unregister(token: string): Promise<void> {
    const { error } = await supabase
      .from('device_push_tokens')
      .delete()
      .eq('token', token)
      .eq('user_id', getUserId());
    if (error) throw error;
  },
};

// ══════════════════════════════════════
// LINKED TRANSACTION REQUESTS (Phase 2B)
// Cloud-only. Writes go through RLS (insert) or SECURITY DEFINER RPCs
// (accept / reject / cancel). No Dexie mirror.
// ══════════════════════════════════════
export const linkedRequestsDb = {
  // Keyset-paged (audit 04-supabase F-FE1 / 05-security M12): a long-lived
  // pair of connected users can accumulate an unbounded request history the
  // same way transactions did.
  async getAll(): Promise<LinkedRequest[]> {
    const me = getUserId();
    const { rows } = await fetchAllPages<LinkedRequest>({
      label: 'linkedRequests.getAll',
      pageSize: 500,
      idOf: (r) => r.id,
      cursorOf: (r) => r.createdAt,
      fetchPage: async (cursor, limit) => {
        let query = supabase
          .from('linked_transaction_requests')
          .select('*')
          .or(`from_user_id.eq.${me},to_user_id.eq.${me}`);
        // Inclusive bound — rows sharing a created_at can straddle a page
        // boundary; fetchAllPages de-duplicates the overlap by id.
        if (cursor) query = query.lte('created_at', cursor);
        const { data, error } = await query
          .order('created_at', { ascending: false })
          .order('id', { ascending: false })
          .limit(limit);
        if (error) throw error;
        return (data ?? []).map(mapLinkedRequest);
      },
    });
    return rows;
  },
  async insert(input: {
    id: string;
    toUserId: string;
    personId: string;
    kind: LinkedRequestKind;
    amount: number;
    currency: Currency;
    note: string;
    // Phase 2D: when set, marks the request as a "sync past record" rather
    // than a brand-new loan announcement. The accept RPC enforces the
    // sender-owns / status-active / person-id-matches invariants on the
    // referenced loan; we don't re-check them here.
    preExistingLoanId?: string | null;
    // Sender's opted-in account: debited (lent) / credited (borrowed) on
    // accept. Forbidden together with preExistingLoanId (DB-enforced).
    requesterAccountId?: string | null;
  }) {
    const { error } = await supabase.from('linked_transaction_requests').insert({
      id: input.id,
      from_user_id: getUserId(),
      to_user_id: input.toUserId,
      person_id: input.personId,
      kind: input.kind,
      amount: input.amount,
      currency: input.currency,
      note: input.note,
      pre_existing_loan_id: input.preExistingLoanId ?? null,
      requester_account_id: input.requesterAccountId ?? null,
    });
    if (error) throw error;
  },
  async accept(requestId: string, responderAccountId?: string | null): Promise<LinkedRequest> {
    // Only send the account param when actually set: the {request_id}-only
    // shape also resolves against a pre-migration one-arg RPC, so ledger-only
    // accepts keep working even before the SQL migration is applied.
    const { data, error } = await supabase.rpc('accept_linked_request',
      responderAccountId
        ? { request_id: requestId, responder_account_id: responderAccountId }
        : { request_id: requestId });
    if (error) throw error;
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) throw new Error('ltr: accept returned no row');
    return mapLinkedRequest(row as Record<string, unknown>);
  },
  async reject(requestId: string, reason?: string): Promise<LinkedRequest> {
    const { data, error } = await supabase.rpc('reject_linked_request', {
      request_id: requestId,
      reason: reason ?? null,
    });
    if (error) throw error;
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) throw new Error('ltr: reject returned no row');
    return mapLinkedRequest(row as Record<string, unknown>);
  },
  async cancel(requestId: string): Promise<LinkedRequest> {
    const { data, error } = await supabase.rpc('cancel_linked_request', { request_id: requestId });
    if (error) throw error;
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) throw new Error('ltr: cancel returned no row');
    return mapLinkedRequest(row as Record<string, unknown>);
  },
};

function mapLinkedRequest(r: Record<string, unknown>): LinkedRequest {
  return {
    id: r.id as string,
    fromUserId: r.from_user_id as string,
    toUserId: r.to_user_id as string,
    personId: (r.person_id as string) ?? null,
    kind: r.kind as LinkedRequest['kind'],
    amount: Number(r.amount),
    currency: r.currency as LinkedRequest['currency'],
    note: (r.note as string) ?? '',
    status: r.status as LinkedRequest['status'],
    rejectionReason: (r.rejection_reason as string) ?? null,
    requesterLoanId: (r.requester_loan_id as string) ?? null,
    responderLoanId: (r.responder_loan_id as string) ?? null,
    requesterTxnId: (r.requester_txn_id as string) ?? null,
    responderTxnId: (r.responder_txn_id as string) ?? null,
    loanPairId: (r.loan_pair_id as string) ?? null,
    preExistingLoanId: (r.pre_existing_loan_id as string) ?? null,
    requesterAccountId: (r.requester_account_id as string) ?? null,
    responderAccountId: (r.responder_account_id as string) ?? null,
    createdAt: r.created_at as string,
    respondedAt: (r.responded_at as string) ?? null,
  };
}

function mapSettlementRequest(r: Record<string, unknown>): SettlementRequest {
  return {
    id: r.id as string,
    loanPairId: r.loan_pair_id as string,
    requesterLoanId: r.requester_loan_id as string,
    responderLoanId: r.responder_loan_id as string,
    fromUserId: r.from_user_id as string,
    toUserId: r.to_user_id as string,
    amount: Number(r.amount),
    currency: r.currency as SettlementRequest['currency'],
    note: (r.note as string) ?? '',
    status: r.status as SettlementRequest['status'],
    rejectionReason: (r.rejection_reason as string) ?? null,
    requesterTxnId: (r.requester_txn_id as string) ?? null,
    responderTxnId: (r.responder_txn_id as string) ?? null,
    requesterAccountId: (r.requester_account_id as string) ?? null,
    responderAccountId: (r.responder_account_id as string) ?? null,
    createdAt: r.created_at as string,
    respondedAt: (r.responded_at as string) ?? null,
  };
}

// ══════════════════════════════════════
// LINKED SETTLEMENT REQUESTS (Phase 2C-A)
// Cloud-only. Accept writes mirrored repayment transactions and decrements
// remaining_amount on both loans. Account balances move only for the sides
// that opted in (sender at create, receiver at accept) — null stays
// ledger-only.
// ══════════════════════════════════════
export const settlementRequestsDb = {
  // Keyset-paged (audit 04-supabase F-FE1 / 05-security M12) — same unbounded
  // history risk as linkedRequestsDb.getAll.
  async getAll(): Promise<SettlementRequest[]> {
    const me = getUserId();
    const { rows } = await fetchAllPages<SettlementRequest>({
      label: 'settlementRequests.getAll',
      pageSize: 500,
      idOf: (r) => r.id,
      cursorOf: (r) => r.createdAt,
      fetchPage: async (cursor, limit) => {
        let query = supabase
          .from('linked_settlement_requests')
          .select('*')
          .or(`from_user_id.eq.${me},to_user_id.eq.${me}`);
        // Inclusive bound — rows sharing a created_at can straddle a page
        // boundary; fetchAllPages de-duplicates the overlap by id.
        if (cursor) query = query.lte('created_at', cursor);
        const { data, error } = await query
          .order('created_at', { ascending: false })
          .order('id', { ascending: false })
          .limit(limit);
        if (error) throw error;
        return (data ?? []).map(mapSettlementRequest);
      },
    });
    return rows;
  },
  async insert(input: {
    id: string;
    loanPairId: string;
    requesterLoanId: string;
    responderLoanId: string;
    toUserId: string;
    amount: number;
    currency: Currency;
    note: string;
    requesterAccountId?: string | null;
  }) {
    const { error } = await supabase.rpc('create_settlement_request', {
      request_id: input.id,
      loan_pair_id: input.loanPairId,
      requester_loan_id: input.requesterLoanId,
      responder_loan_id: input.responderLoanId,
      to_user_id: input.toUserId,
      amount: input.amount,
      currency: input.currency,
      note: input.note,
      requester_account_id: input.requesterAccountId ?? null,
    });
    if (error) throw error;
  },
  async accept(requestId: string, responderAccountId?: string | null): Promise<SettlementRequest> {
    // Same conditional-params shape as linkedRequestsDb.accept — see there.
    const { data, error } = await supabase.rpc('accept_settlement_request',
      responderAccountId
        ? { request_id: requestId, responder_account_id: responderAccountId }
        : { request_id: requestId });
    if (error) throw error;
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) throw new Error('lsr: accept returned no row');
    return mapSettlementRequest(row as Record<string, unknown>);
  },
  async reject(requestId: string, reason?: string): Promise<SettlementRequest> {
    const { data, error } = await supabase.rpc('reject_settlement_request', {
      request_id: requestId,
      reason: reason ?? null,
    });
    if (error) throw error;
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) throw new Error('lsr: reject returned no row');
    return mapSettlementRequest(row as Record<string, unknown>);
  },
  async cancel(requestId: string): Promise<SettlementRequest> {
    const { data, error } = await supabase.rpc('cancel_settlement_request', { request_id: requestId });
    if (error) throw error;
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) throw new Error('lsr: cancel returned no row');
    return mapSettlementRequest(row as Record<string, unknown>);
  },
};

// ══════════════════════════════════════
// EMI SCHEDULES
// ══════════════════════════════════════
export const emiSchedulesDb = {
  /**
   * Keyset-paged (audit 04-supabase F-FE1 / 05-security M12) — same unbounded
   * `select('*')` risk as loansDb.getAll. installment_number is NOT unique
   * across loans (every loan starts at 1), so it is not itself a valid
   * keyset cursor on its own — the `id` order-by tiebreak is what keeps the
   * (installment_number, id) pair a stable total order; fetchAllPages only
   * ever compares the installment_number cursor value.
   */
  async getAll(): Promise<EmiSchedule[]> {
    const userId = getUserId();
    const { rows } = await fetchAllPages<EmiSchedule>({
      label: 'emiSchedules.getAll',
      pageSize: 500,
      idOf: (e) => e.id,
      cursorOf: (e) => String(e.installmentNumber),
      fetchPage: async (cursor, limit) => {
        let query = supabase
          .from('emi_schedules').select('*')
          .eq('user_id', userId);
        // Inclusive bound — rows sharing an installment_number (across
        // different loans) can straddle a page boundary; fetchAllPages
        // de-duplicates the overlap by id.
        if (cursor) query = query.gte('installment_number', Number(cursor));
        const { data, error } = await query
          .order('installment_number', { ascending: true })
          .order('id', { ascending: true })
          .limit(limit);
        if (error) throw error;
        return (data ?? []).map(mapEmi);
      },
    });
    return rows;
  },
  async bulkAdd(entries: EmiSchedule[]) {
    const rows = entries.map(e => ({
      id: e.id, user_id: getUserId(), loan_id: e.loanId,
      installment_number: e.installmentNumber, due_date: e.dueDate,
      amount: e.amount, status: e.status,
    }));
    const { error } = await supabase.from('emi_schedules').insert(rows);
    if (error) throw error;
  },
  async update(id: string, changes: Partial<EmiSchedule>) {
    const row: Record<string, unknown> = {};
    if (changes.status !== undefined) row.status = changes.status;
    const { error } = await supabase.from('emi_schedules').update(row).eq('id', id).eq('user_id', getUserId());
    if (error) throw error;
  },
  // Re-date an instalment (the statement-day re-anchor migration). Kept
  // separate from update() — which is deliberately status-only — because
  // due_date is otherwise immutable after creation.
  async setDueDate(id: string, dueDate: string) {
    const { error } = await supabase.from('emi_schedules').update({ due_date: dueDate }).eq('id', id).eq('user_id', getUserId());
    if (error) throw error;
  },
  async deleteByLoan(loanId: string) {
    const { error } = await supabase.from('emi_schedules').delete().eq('loan_id', loanId).eq('user_id', getUserId());
    if (error) throw error;
  },
};

// ══════════════════════════════════════
// GOALS
// ══════════════════════════════════════
export const goalsDb = {
  async getAll(): Promise<Goal[]> {
    const { data, error } = await supabase
      .from('goals').select('*')
      .eq('user_id', getUserId())
      .order('created_at', { ascending: false });
    if (error) throw error;
    return (data ?? []).map(mapGoal);
  },
  async add(g: Goal) {
    const { error } = await supabase.from('goals').insert({
      id: g.id, user_id: getUserId(), title: g.title,
      target_amount: g.targetAmount, saved_amount: g.savedAmount,
      currency: g.currency, stored_in_account_id: g.storedInAccountId,
      target_date: g.targetDate ?? null,
      created_at: g.createdAt,
    });
    if (error) throw error;
  },
  async update(id: string, changes: Partial<Goal>) {
    const row: Record<string, unknown> = {};
    if (changes.savedAmount !== undefined) row.saved_amount = changes.savedAmount;
    if (changes.title !== undefined) row.title = changes.title;
    if (changes.targetAmount !== undefined) row.target_amount = changes.targetAmount;
    if (changes.targetDate !== undefined) row.target_date = changes.targetDate ?? null;
    const { error } = await supabase.from('goals').update(row).eq('id', id).eq('user_id', getUserId());
    if (error) throw error;
  },
  async delete(id: string) {
    const { error } = await supabase.from('goals').delete().eq('id', id).eq('user_id', getUserId());
    if (error) throw error;
  },
};

// ══════════════════════════════════════
// ACTIVITIES
// ══════════════════════════════════════
export const activitiesDb = {
  async getAll(): Promise<ActivityLog[]> {
    const { data, error } = await supabase
      .from('activities').select('*')
      .eq('user_id', getUserId())
      .order('timestamp', { ascending: false })
      .limit(100);
    if (error) throw error;
    return (data ?? []).map(mapActivity);
  },
  async add(a: ActivityLog) {
    const { error } = await supabase.from('activities').insert({
      id: a.id, user_id: getUserId(), type: a.type, description: a.description,
      related_entity_id: a.relatedEntityId, related_entity_type: a.relatedEntityType,
      timestamp: a.timestamp,
    });
    if (error) throw error;
  },
  async getByEntity(entityId: string): Promise<ActivityLog[]> {
    const { data, error } = await supabase
      .from('activities').select('*')
      .eq('user_id', getUserId())
      .eq('related_entity_id', entityId)
      .order('timestamp', { ascending: false });
    if (error) throw error;
    return (data ?? []).map(mapActivity);
  },
};

// ══════════════════════════════════════
// UPCOMING EXPENSES
// ══════════════════════════════════════
export const upcomingExpensesDb = {
  async getAll(): Promise<UpcomingExpense[]> {
    const { data, error } = await supabase
      .from('upcoming_expenses').select('*')
      .eq('user_id', getUserId())
      .order('due_date', { ascending: true });
    if (error) throw error;
    return (data ?? []).map(mapUpcoming);
  },
  async add(e: UpcomingExpense) {
    const { error } = await supabase.from('upcoming_expenses').insert({
      id: e.id, user_id: getUserId(), title: e.title, amount: e.amount,
      currency: e.currency, due_date: e.dueDate, account_id: e.accountId,
      category: e.category, notes: e.notes, is_paid: e.isPaid,
      status: e.status, reminder_days_before: e.reminderDaysBefore,
      created_at: e.createdAt,
    });
    if (error) throw error;
  },
  async update(id: string, changes: Partial<UpcomingExpense>) {
    const row: Record<string, unknown> = {};
    if (changes.isPaid !== undefined) row.is_paid = changes.isPaid;
    if (changes.status !== undefined) row.status = changes.status;
    const { error } = await supabase.from('upcoming_expenses').update(row).eq('id', id).eq('user_id', getUserId());
    if (error) throw error;
  },
  async delete(id: string) {
    const { error } = await supabase.from('upcoming_expenses').delete().eq('id', id).eq('user_id', getUserId());
    if (error) throw error;
  },
};

// ══════════════════════════════════════
// SPLIT GROUPS
// ══════════════════════════════════════
export const splitGroupsDb = {
  async getAll(): Promise<SplitGroup[]> {
    const userId = getUserId();
    const [{ data: owned, error: ownedError }, { data: memberships, error: membersError }] = await Promise.all([
      supabase
        .from('split_groups').select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: false }),
      supabase
        .from('group_members').select('group_id')
        .eq('profile_id', userId)
        .eq('status', 'connected'),
    ]);

    if (ownedError) throw ownedError;
    if (membersError && membersError.code !== 'PGRST116') throw membersError;

    const ids = Array.from(new Set([...(owned ?? []).map(row => String(row.id)), ...((memberships ?? []).map(row => String(row.group_id)))]));
    if (ids.length === 0) return [];

    const { data, error } = await supabase
      .from('split_groups').select('*')
      .in('id', ids)
      .order('created_at', { ascending: false });
    if (error) throw error;
    return (data ?? []).map(mapGroup);
  },
  async add(g: SplitGroup) {
    const { error } = await supabase.from('split_groups').insert({
      id: g.id, user_id: getUserId(), name: g.name, emoji: g.emoji,
      members: g.members, currency: g.currency, settled: g.settled,
      created_at: g.createdAt, created_by: g.createdBy ?? getUserId(),
      join_code: g.joinCode ?? null,
      join_code_normalized: g.joinCodeNormalized ?? null,
    });
    if (error) throw error;
  },
  async get(id: string): Promise<SplitGroup | null> {
    const { data, error } = await supabase
      .from('split_groups').select('*')
      .eq('id', id).single();
    if (error) return null;
    return data ? mapGroup(data) : null;
  },
  async delete(id: string) {
    const { error } = await supabase.from('split_groups').delete().eq('id', id).eq('user_id', getUserId());
    if (error) throw error;
  },
  // Owner-or-admin join-code rotation. Join codes expire 14 days after creation
  // or rotation — trg_split_groups_join_code_expiry
  // (supabase-migration-audit-p0-join-abuse-limits.sql SECTION 2) re-stamps
  // join_code_expires_at server-side whenever join_code changes, so this write
  // deliberately does NOT send an expiry of its own (an explicit value would
  // win over the trigger).
  //
  // No `user_id` filter any more: that pinned the write to the OWNER, so a
  // co-admin's rotation (supabase-migration-group-admins.sql §4a) matched zero
  // rows and the UI announced a new code that was never saved. RLS is the
  // gate; `.select('id')` makes a refused write visible instead of silent.
  async rotateJoinCode(id: string, joinCode: string, joinCodeNormalized: string) {
    const { data, error } = await supabase
      .from('split_groups')
      .update({ join_code: joinCode, join_code_normalized: joinCodeNormalized })
      .eq('id', id)
      .select('id');
    if (error) throw error;
    if (!data || data.length === 0) throw new Error(tStatic('grp_code_refresh_not_allowed'));
  },
};

// ══════════════════════════════════════
// GROUP EXPENSES
// ══════════════════════════════════════
// Lean projection used by the splits dashboard for balance + unreconciled-flag
// computation. Includes only the columns those passes actually read, so a
// 1000-row return on a heavy splitter ships ~4 KB instead of ~40 KB.
export interface GroupExpenseBalanceRow {
  groupId: string;
  paidBy: string;
  amount: number;
  splits: GroupExpense['splits'];
  isReconciled: boolean;
}

export interface GroupSettlementBalanceRow {
  groupId: string;
  fromMember: string;
  toMember: string;
  amount: number;
}

export const groupExpensesDb = {
  async get(id: string): Promise<GroupExpense | null> {
    const { data, error } = await supabase
      .from('group_expenses').select('*')
      .eq('id', id)
      .is('deleted_at', null)
      .single();
    if (error) return null;
    return data ? mapGroupExpense(data) : null;
  },
  async getByGroup(groupId: string): Promise<GroupExpense[]> {
    const { data, error } = await supabase
      .from('group_expenses').select('*')
      .eq('group_id', groupId)
      .is('deleted_at', null)
      .order('created_at', { ascending: false });
    if (error) throw error;
    return (data ?? []).map(mapGroupExpense);
  },
  // Returns every expense across every group the caller can see. RLS on
  // group_expenses already limits this to groups the user is a member of,
  // so this is the batched counterpart to getByGroup — two queries for
  // the whole Groups tab instead of 2N.
  //
  // Keyset-paged (audit 04-supabase F-FE1 / 05-security M12): a heavy
  // splitter's all-groups expense feed is exactly the unbounded-select shape
  // that used to silently truncate at PostgREST's max-rows cap.
  async getAllVisible(): Promise<GroupExpense[]> {
    const { rows } = await fetchAllPages<GroupExpense>({
      label: 'groupExpenses.getAllVisible',
      pageSize: 500,
      idOf: (e) => e.id,
      cursorOf: (e) => e.createdAt,
      fetchPage: async (cursor, limit) => {
        let query = supabase
          .from('group_expenses').select('*')
          .is('deleted_at', null);
        // Inclusive bound — rows sharing a created_at can straddle a page
        // boundary; fetchAllPages de-duplicates the overlap by id.
        if (cursor) query = query.lte('created_at', cursor);
        const { data, error } = await query
          .order('created_at', { ascending: false })
          .order('id', { ascending: false })
          .limit(limit);
        if (error) throw error;
        return (data ?? []).map(mapGroupExpense);
      },
    });
    return rows;
  },
  // Same shape as getAllVisible but only the columns the dashboard balance +
  // unreconciled-flag passes consume. The splits JSONB is still selected
  // because the per-member-share math needs it; everything else (notes,
  // payload, audit columns) is dropped.
  async getAllVisibleForBalances(): Promise<GroupExpenseBalanceRow[]> {
    const { data, error } = await supabase
      .from('group_expenses')
      .select('group_id, paid_by, amount, splits, is_reconciled')
      .is('deleted_at', null);
    if (error) throw error;
    return (data ?? []).map((r) => ({
      groupId: r.group_id as string,
      paidBy: r.paid_by as string,
      amount: Number(r.amount),
      splits: (r.splits ?? []) as GroupExpense['splits'],
      isReconciled: Boolean(r.is_reconciled),
    }));
  },
  async add(e: GroupExpense) {
    const { error } = await supabase.from('group_expenses').insert({
      id: e.id, user_id: getUserId(), group_id: e.groupId,
      description: e.description, amount: e.amount, paid_by: e.paidBy,
      split_type: e.splitType, splits: e.splits, category: e.category,
      date: e.date, notes: e.notes, created_at: e.createdAt,
      created_by: e.createdBy ?? getUserId(),
      updated_by: e.updatedBy ?? getUserId(),
      version: e.version ?? 1,
      is_reconciled: e.isReconciled ?? false,
      reconciled_at: e.reconciledAt ?? null,
      reconciled_by: e.reconciledBy ?? null,
    });
    if (error) throw error;
  },
  // `expectedVersion` turns this into an optimistic-lock write (audit F-6).
  // The `version` column was written on every edit but NEVER compared, so two
  // people editing the same expense was last-writer-wins and one person's
  // splits silently replaced the other's. With it, the losing writer matches
  // 0 rows and gets a conflict error instead of quietly winning; the DB-side
  // backstop (group_expenses_version_guard in
  // supabase-migration-audit-p0-group-concurrency.sql) makes the increment
  // mandatory so a caller cannot opt out by just not sending a new version.
  async update(id: string, changes: Partial<GroupExpense>, opts?: { expectedVersion?: number }) {
    const row: Record<string, unknown> = {};
    if (changes.description !== undefined) row.description = changes.description;
    if (changes.amount !== undefined) row.amount = changes.amount;
    if (changes.paidBy !== undefined) row.paid_by = changes.paidBy;
    if (changes.splitType !== undefined) row.split_type = changes.splitType;
    if (changes.splits !== undefined) row.splits = changes.splits;
    if (changes.category !== undefined) row.category = changes.category;
    if (changes.notes !== undefined) row.notes = changes.notes;
    if (changes.updatedBy !== undefined) row.updated_by = changes.updatedBy;
    if (changes.deletedAt !== undefined) row.deleted_at = changes.deletedAt;
    if (changes.deletedBy !== undefined) row.deleted_by = changes.deletedBy;
    if (changes.version !== undefined) row.version = changes.version;
    if (changes.isReconciled !== undefined) row.is_reconciled = changes.isReconciled;
    if (changes.reconciledAt !== undefined) row.reconciled_at = changes.reconciledAt;
    if (changes.reconciledBy !== undefined) row.reconciled_by = changes.reconciledBy;
    // .select() makes RLS-filtered writes VISIBLE: creator-only policies turn
    // a non-creator's update into 0 affected rows, which supabase-js otherwise
    // reports as success — the "edited but nothing changed" trap.
    let query = supabase.from('group_expenses').update(row).eq('id', id);
    if (opts?.expectedVersion !== undefined) {
      query = query.eq('version', opts.expectedVersion);
    }
    const { data, error } = await query.select('id');
    if (error) throw error;
    if ((data ?? []).length === 0) {
      // 0 rows means one of two very different things. Read the live version
      // back to tell them apart, so a conflict is never reported as "you're
      // not the creator" (and, more importantly, never as success).
      if (opts?.expectedVersion !== undefined) {
        const { data: current } = await supabase
          .from('group_expenses')
          .select('version')
          .eq('id', id)
          .is('deleted_at', null)
          .maybeSingle();
        if (current && Number(current.version) !== opts.expectedVersion) {
          throw new Error(tStatic('grp_expense_version_conflict'));
        }
      }
      throw new Error(tStatic('grp_only_creator_edit'));
    }
  },
  // Liveness probe for mirror-transaction guards. Unlike get(), this
  // DISTINGUISHES "row really gone" (0 rows → false) from transport/auth
  // failures (throws) — a flaky connection must keep the guard, not release
  // it and let a live group's mirror be deleted out from under the group.
  async probeExists(id: string): Promise<boolean> {
    const { data, error } = await supabase
      .from('group_expenses')
      .select('id')
      .eq('id', id)
      .is('deleted_at', null);
    if (error) throw error;
    return (data ?? []).length > 0;
  },
  async setReconciled(id: string, isReconciled: boolean): Promise<void> {
    const { error } = await supabase.rpc('reconcile_group_expense', {
      p_expense_id: id,
      p_is_reconciled: isReconciled,
    });
    if (error) throw error;
  },
  async delete(id: string) {
    const { data, error } = await supabase
      .from('group_expenses')
      .update({ deleted_at: new Date().toISOString(), deleted_by: getUserId() })
      .eq('id', id)
      .select('id');
    if (error) throw error;
    if ((data ?? []).length === 0) {
      throw new Error(tStatic('grp_only_creator_delete'));
    }
  },
  async deleteByGroup(groupId: string) {
    const { error } = await supabase.from('group_expenses').delete().eq('group_id', groupId);
    if (error) throw error;
  },
};

// ══════════════════════════════════════
// GROUP SETTLEMENTS
// ══════════════════════════════════════
export const groupSettlementsDb = {
  async getByGroup(groupId: string): Promise<GroupSettlement[]> {
    const { data, error } = await supabase
      .from('group_settlements').select('*')
      .eq('group_id', groupId)
      .is('deleted_at', null)
      .order('created_at', { ascending: false });
    if (error) throw error;
    return (data ?? []).map(mapGroupSettlement);
  },
  // Batched counterpart — RLS scopes to groups the user can see.
  //
  // Keyset-paged (audit 04-supabase F-FE1 / 05-security M12) — same
  // unbounded-select truncation risk as groupExpensesDb.getAllVisible.
  async getAllVisible(): Promise<GroupSettlement[]> {
    const { rows } = await fetchAllPages<GroupSettlement>({
      label: 'groupSettlements.getAllVisible',
      pageSize: 500,
      idOf: (s) => s.id,
      cursorOf: (s) => s.createdAt,
      fetchPage: async (cursor, limit) => {
        let query = supabase
          .from('group_settlements').select('*')
          .is('deleted_at', null);
        // Inclusive bound — rows sharing a created_at can straddle a page
        // boundary; fetchAllPages de-duplicates the overlap by id.
        if (cursor) query = query.lte('created_at', cursor);
        const { data, error } = await query
          .order('created_at', { ascending: false })
          .order('id', { ascending: false })
          .limit(limit);
        if (error) throw error;
        return (data ?? []).map(mapGroupSettlement);
      },
    });
    return rows;
  },
  // Narrow projection for the dashboard balance pass — only the four columns
  // the running-sum needs. Roughly halves payload on heavy splitters.
  async getAllVisibleForBalances(): Promise<GroupSettlementBalanceRow[]> {
    const { data, error } = await supabase
      .from('group_settlements')
      .select('group_id, from_member, to_member, amount')
      .is('deleted_at', null);
    if (error) throw error;
    return (data ?? []).map((r) => ({
      groupId: r.group_id as string,
      fromMember: r.from_member as string,
      toMember: r.to_member as string,
      amount: Number(r.amount),
    }));
  },
  // Record a settlement through the hardened RPC. The outstanding-amount cap
  // used to be a client-side check between two reads and an insert, so two
  // devices recording the same repayment both passed it and the pair
  // over-settled (audit 12-qa-review.md F-7). record_group_settlement takes a
  // group row lock, recomputes the cap under it, and inserts — all in one
  // transaction. Failures come back as DATA (reason_code), never as a raw
  // Postgres error string.
  async record(s: GroupSettlement): Promise<RecordSettlementResult> {
    const { data, error } = await supabase.rpc('record_group_settlement', {
      p_settlement_id: s.id,
      p_group_id: s.groupId,
      p_from_member: s.fromMember,
      p_to_member: s.toMember,
      p_amount: s.amount,
      p_note: s.note ?? '',
      p_date: s.date,
    });
    if (error) throw error;
    return (data ?? {}) as RecordSettlementResult;
  },
  // Soft-delete one settlement (tombstone; every read filters deleted_at).
  // .select() surfaces RLS-filtered 0-row writes as an honest error, and the
  // deleted_at filter makes a two-device race idempotent (second write 0-rows
  // instead of double-tombstoning and double-fanning-out).
  async deleteOne(id: string) {
    const { data, error } = await supabase
      .from('group_settlements')
      .update({ deleted_at: new Date().toISOString(), deleted_by: getUserId() })
      .eq('id', id)
      .is('deleted_at', null)
      .select('id');
    if (error) throw error;
    if ((data ?? []).length === 0) {
      throw new Error(tStatic('grp_only_recorder_settlement'));
    }
  },
  async deleteByGroup(groupId: string) {
    const { error } = await supabase.from('group_settlements').delete().eq('group_id', groupId);
    if (error) throw error;
  },
};

// supabase-migration-audit-p0-consent-guards.sql §2.2 raises SQLSTATE 23505
// (MEMBER_ALREADY_EXISTS) when a client INSERTs a second membership row for a
// profile that already has one in that group — the supported way back in for
// someone who declined is the join code, not a re-invite. Without this the user
// sees a raw Postgres unique-violation string.
function translateMemberInsertError(error: unknown): unknown {
  return isMemberAlreadyExistsError(error)
    ? new Error(tStatic('grp_member_already_exists'))
    : error;
}

export const groupMembersDb = {
  async getByGroup(groupId: string): Promise<GroupMember[]> {
    const { data, error } = await supabase
      .from('group_members').select('*')
      .eq('group_id', groupId)
      .order('created_at', { ascending: true });
    if (error) throw error;
    return (data ?? []).map(mapGroupMember);
  },
  // Batched fetch for loadGroups: gets every member row for the given groups
  // in one round-trip and returns them grouped by group_id. Replaces the
  // N+1 pattern of calling getByGroup() once per group during list-page load.
  async getByGroups(groupIds: string[]): Promise<Map<string, GroupMember[]>> {
    const grouped = new Map<string, GroupMember[]>();
    if (groupIds.length === 0) return grouped;
    const { data, error } = await supabase
      .from('group_members').select('*')
      .in('group_id', groupIds)
      .order('created_at', { ascending: true });
    if (error) throw error;
    for (const row of data ?? []) {
      const gid = String((row as Record<string, unknown>).group_id);
      const bucket = grouped.get(gid) ?? [];
      bucket.push(mapGroupMember(row as Record<string, unknown>));
      grouped.set(gid, bucket);
    }
    return grouped;
  },
  async add(member: GroupMember & { groupId: string; invitedBy?: string | null }) {
    const { error } = await supabase.from('group_members').insert({
      id: member.id,
      group_id: member.groupId,
      profile_id: member.profileId ?? null,
      display_name: member.name,
      role: member.role ?? (member.isOwner ? 'owner' : 'member'),
      status: member.status ?? (member.profileId ? 'connected' : 'guest'),
      invited_by: member.invitedBy ?? getUserId(),
      joined_at: member.joinedAt ?? null,
      created_at: new Date().toISOString(),
    });
    if (error) throw translateMemberInsertError(error);
  },
  async addMany(groupId: string, members: GroupMember[]) {
    if (members.length === 0) return;
    const rows = members.map(member => ({
      id: member.id,
      group_id: groupId,
      profile_id: member.profileId ?? null,
      display_name: member.name,
      role: member.role ?? (member.isOwner ? 'owner' : 'member'),
      status: member.status ?? (member.profileId ? 'connected' : 'guest'),
      invited_by: getUserId(),
      joined_at: member.joinedAt ?? null,
      created_at: new Date().toISOString(),
    }));
    const { error } = await supabase.from('group_members').insert(rows);
    if (error) throw translateMemberInsertError(error);
  },
  // `isAdmin` is deliberately NOT writable here: group_members_admin_flag
  // refuses a client change (GROUP_ADMIN_RPC_ONLY) and the column may not even
  // exist yet — admins move only through groupAdminsDb.setAdmin.
  //
  // `requireRow`: RLS answers a refused UPDATE with zero rows and no error. A
  // caller that has already told the user "saved" (an optimistic rename) asks
  // for the row back and gets a throw instead of a silent no-op.
  async update(id: string, changes: Partial<GroupMember>, opts: { requireRow?: boolean } = {}) {
    const row: Record<string, unknown> = {};
    if (changes.name !== undefined) row.display_name = changes.name;
    if (changes.profileId !== undefined) row.profile_id = changes.profileId;
    if (changes.role !== undefined) row.role = changes.role;
    if (changes.status !== undefined) row.status = changes.status;
    if (changes.joinedAt !== undefined) row.joined_at = changes.joinedAt;
    if (opts.requireRow) {
      const { data, error } = await supabase.from('group_members').update(row).eq('id', id).select('id');
      if (error) throw error;
      if (!data || data.length === 0) throw new Error('GROUP_MEMBER_UPDATE_REFUSED');
      return;
    }
    const { error } = await supabase.from('group_members').update(row).eq('id', id);
    if (error) throw error;
  },
  async getMine(): Promise<Array<{ groupId: string; memberId: string }>> {
    const { data, error } = await supabase
      .from('group_members').select('id, group_id')
      .eq('profile_id', getUserId())
      .eq('status', 'connected');
    if (error) throw error;
    return (data ?? []).map(row => ({ groupId: String(row.group_id), memberId: String(row.id) }));
  },
};

export const groupInvitesDb = {
  async add(invite: GroupInvite) {
    const { error } = await supabase.from('group_invites').insert({
      id: invite.id,
      group_id: invite.groupId,
      token_hash: invite.tokenHash,
      created_by: invite.createdBy,
      linked_member_id: invite.linkedMemberId,
      expires_at: invite.expiresAt,
      revoked_at: invite.revokedAt,
      accepted_by: invite.acceptedBy,
      accepted_at: invite.acceptedAt,
      created_at: invite.createdAt,
    });
    if (error) throw error;
  },
  // getByTokenHash is GONE. It had no caller, and after
  // supabase-migration-audit-p0-consent-guards.sql §3.2 it could not work:
  // token_hash is no longer readable OR filterable by client roles, and the
  // hash stopped being the credential (the raw token is, and only the server
  // may derive its digest).
  //
  // Explicit column list, NOT select('*'): the table-wide SELECT grant was
  // revoked and only these nine columns were granted back, so a star select now
  // fails with "permission denied for column token_hash". This list is exactly
  // what mapGroupInvite reads.
  async getActiveByGroup(groupId: string): Promise<GroupInvite[]> {
    const { data, error } = await supabase
      .from('group_invites')
      .select('id, group_id, created_by, linked_member_id, expires_at, revoked_at, accepted_by, accepted_at, created_at')
      .eq('group_id', groupId)
      .is('revoked_at', null)
      .order('created_at', { ascending: false });
    if (error) throw error;
    return (data ?? []).map(mapGroupInvite);
  },
  async update(id: string, changes: Partial<GroupInvite>) {
    const row: Record<string, unknown> = {};
    if (changes.revokedAt !== undefined) row.revoked_at = changes.revokedAt;
    if (changes.acceptedBy !== undefined) row.accepted_by = changes.acceptedBy;
    if (changes.acceptedAt !== undefined) row.accepted_at = changes.acceptedAt;
    if (changes.linkedMemberId !== undefined) row.linked_member_id = changes.linkedMemberId;
    const { error } = await supabase.from('group_invites').update(row).eq('id', id);
    if (error) throw error;
  },
};

export const groupEventsDb = {
  // Keyset-paged (audit 04-supabase F-FE1 / 05-security M12): a long-lived
  // group's activity feed is unbounded the same way the all-groups reads are.
  async getByGroup(groupId: string): Promise<GroupEvent[]> {
    const { rows } = await fetchAllPages<GroupEvent>({
      label: 'groupEvents.getByGroup',
      pageSize: 500,
      idOf: (e) => e.id,
      cursorOf: (e) => e.createdAt,
      fetchPage: async (cursor, limit) => {
        let query = supabase
          .from('group_events').select('*')
          .eq('group_id', groupId);
        // Inclusive bound — rows sharing a created_at can straddle a page
        // boundary; fetchAllPages de-duplicates the overlap by id.
        if (cursor) query = query.lte('created_at', cursor);
        const { data, error } = await query
          .order('created_at', { ascending: false })
          .order('id', { ascending: false })
          .limit(limit);
        if (error) throw error;
        return (data ?? []).map(mapGroupEvent);
      },
    });
    return rows;
  },
  // NOTE: there is deliberately no add(). Group activity rows are written by
  // the fan-out triggers in supabase-migration-audit-p0-notifications.sql, in
  // the same transaction as the money write, and the client INSERT policy on
  // group_events is dropped there. Client-written events were best-effort —
  // an actor who went offline between the expense insert and the fan-out left
  // no activity record at all (audit 08-notifications.md N-2) — and let any
  // member author arbitrary `summary` text into the shared feed.
};

// ──────────────────────────────────────
// How many notification rows one page costs. The list used to fetch a flat
// `limit(100)` on every boot, every realtime nudge and every resume-refresh,
// and render all 100 (founder request 2026-09-03). It now fetches the newest
// NOTIFICATION_PAGE_SIZE and pages the rest on an explicit tap.
const NOTIFICATION_PAGE_SIZE = 15;
// Unread rows are fetched IN FULL alongside the first page, not paged — see
// `getUnread` for why. This ceiling exists only so a pathological account
// cannot turn "in full" into an unbounded read; the badge shows "9+" long
// before it matters. Exported so the store can tell "no unread rows beyond
// these" apart from "we stopped counting here".
export const NOTIFICATION_UNREAD_CAP = 200;

/** One page of notifications, newest first. */
export interface NotificationPage {
  rows: AppNotification[];
  /**
   * Exact number of notification rows this user owns. Requested only on the
   * first page (PostgREST returns it in the same round-trip as the rows), so
   * it is null on every subsequent page — the caller already has it.
   */
  total: number | null;
}

export const notificationsDb = {
  /**
   * The newest `limit` rows, or — with a cursor — the `limit` rows immediately
   * older than it.
   *
   * Keyset, not offset: ordered `created_at DESC, id DESC`, the same order
   * every other paged read in this file uses. The cursor's timestamp bound is
   * INCLUSIVE and the ids already held at that exact instant are excluded by
   * id, because a server sweep can write several rows for one user inside a
   * single statement and they then share a `created_at` to the millisecond.
   * An exclusive `<` would drop the siblings that straddled the boundary; a
   * bare inclusive `<=` would re-deliver them forever. See
   * `src/lib/listPaging.ts` `cursorAfter`, which builds the cursor.
   */
  async getPage(options?: {
    limit?: number;
    before?: KeysetCursor | null;
  }): Promise<NotificationPage> {
    const limit = options?.limit ?? NOTIFICATION_PAGE_SIZE;
    const before = options?.before ?? null;
    // The count rides along free on the first page and answers "Showing N of
    // M" honestly. Asking for it on every page would make each "Load more" pay
    // for a count of the shrinking remainder that nobody reads.
    const wantCount = !before;
    let query = wantCount
      ? supabase.from('notifications').select('*', { count: 'exact' })
      : supabase.from('notifications').select('*');
    query = query.eq('user_id', getUserId());
    if (before) {
      query = query.lte('created_at', before.createdAt);
      if (before.excludeIds.length > 0) {
        const list = before.excludeIds.map((id) => `"${id}"`).join(',');
        query = query.not('id', 'in', `(${list})`);
      }
    }
    const { data, error, count } = await query
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(limit);
    if (error) throw error;
    return {
      rows: (data ?? []).map(mapNotification),
      total: wantCount && typeof count === 'number' ? count : null,
    };
  },

  /**
   * EVERY unread row, not just the ones on the first page.
   *
   * This is what makes paging the list safe. The unread-count predicate
   * (`countAttentionNotifications` in `src/lib/notificationCounts.ts`) counts
   * over the rows the store holds, and three other surfaces filter the same
   * array for unread rows — the bell badge (`InboxAction`), the Inbox "Info"
   * tab (`isInboxInfoNotification`, which is unread-only) and the per-group
   * unread dots on SplitsPage. If the store held only the newest 15, an unread
   * row sitting at position 16 would silently stop counting.
   *
   * So: the newest page is a WINDOW, but the unread set is COMPLETE. The
   * predicate is untouched, and it now sees strictly more than the old
   * `limit(100)` did.
   *
   * TODO(badge-owner): the one residual gap is an account carrying more than
   * NOTIFICATION_UNREAD_CAP unread rows. Past that ceiling this read is
   * truncated, the store skips its read-reconcile (it can no longer tell
   * "read" from "past the cap"), and `countAttentionNotifications` undercounts.
   * The fix, if the bell ever needs to be exact up there, is a separate
   * `notificationsDb.unreadCount()` — a `head: true, count: 'exact'` request
   * on `read_at is null` that transfers no rows — feeding the badge directly.
   * Not built here: it cannot apply the self-caused/muted parts of the
   * predicate in SQL, so it would be a SECOND definition of "unread" competing
   * with the one in notificationCounts.ts, and every badge in this app already
   * caps its display at "9+".
   */
  async getUnread(): Promise<AppNotification[]> {
    const { data, error } = await supabase
      .from('notifications').select('*')
      .eq('user_id', getUserId())
      .is('read_at', null)
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(NOTIFICATION_UNREAD_CAP);
    if (error) throw error;
    return (data ?? []).map(mapNotification);
  },
  // NOTE: there is deliberately no addMany(). Clients can only ever insert a
  // notification for THEMSELVES now (the INSERT policy in
  // supabase-migration-audit-p0-notifications.sql), and nothing in the app
  // needs to. The old fan-out let any co-member write arbitrary title/body
  // rows into another member's Inbox — forwarded verbatim as app-branded
  // HIGH-priority FCM push (audit 05-security.md H5 / 08-notifications.md
  // N-3). Every cross-user notification is now trigger-written.
  async markRead(id: string) {
    const { error } = await supabase
      .from('notifications')
      .update({ read_at: new Date().toISOString() })
      .eq('id', id)
      .eq('user_id', getUserId());
    if (error) throw error;
  },
  /** Mark a known set of rows read in ONE statement.
   *
   *  Used by the stale-mirror reconciliation
   *  (`notificationStore.reconcileRequestMirrors`): a `linked_request` /
   *  `linked_settlement` ping whose request is no longer pending can never be
   *  cleared by the user — the Inbox card it points at is gone — so 73 of them
   *  sat unread forever in production. `is('read_at', null)` keeps it
   *  idempotent: re-running it writes nothing. */
  async markManyRead(ids: readonly string[]) {
    if (ids.length === 0) return;
    const { error } = await supabase
      .from('notifications')
      .update({ read_at: new Date().toISOString() })
      .in('id', ids as string[])
      .eq('user_id', getUserId())
      .is('read_at', null);
    if (error) throw error;
  },
  async markAllRead() {
    const { error } = await supabase
      .from('notifications')
      .update({ read_at: new Date().toISOString() })
      .eq('user_id', getUserId())
      .is('read_at', null);
    if (error) throw error;
  },
  async markGroupRead(groupId: string) {
    const { error } = await supabase
      .from('notifications')
      .update({ read_at: new Date().toISOString() })
      .eq('user_id', getUserId())
      .eq('group_id', groupId)
      .is('read_at', null);
    if (error) throw error;
  },
};

// ══════════════════════════════════════
// NOTIFICATION PREFERENCES (audit 08-notifications.md N-10)
// ──────────────────────────────────────
// Per-recipient fatigue controls, from
// supabase-migration-p2-notification-maturity.sql §2. One row per
// (user, group); `groupId === null` is the GLOBAL row and the only place
// quiet hours and the timezone are read from — a per-group row carries only
// `muted`.
//
// EVERY read here tolerates the table not existing: the migration is applied
// by hand in Studio (CLAUDE.md), so a shipped client WILL run against a
// database without it for some window. Failing soft means "no prefs" —
// nothing muted, no quiet hours — which is exactly the pre-M5 behaviour.
// ══════════════════════════════════════
export interface NotificationPref {
  groupId: string | null;
  muted: boolean;
  quietHoursStart: number | null;
  quietHoursEnd: number | null;
  tz: string;
}

function mapNotificationPref(r: Record<string, unknown>): NotificationPref {
  return {
    groupId: (r.group_id as string) ?? null,
    muted: r.muted === true,
    quietHoursStart: typeof r.quiet_hours_start === 'number' ? r.quiet_hours_start : null,
    quietHoursEnd: typeof r.quiet_hours_end === 'number' ? r.quiet_hours_end : null,
    tz: (r.tz as string) || 'Asia/Karachi',
  };
}

export const notificationPrefsDb = {
  async getAll(): Promise<NotificationPref[]> {
    const { data, error } = await supabase
      .from('notification_prefs').select('*')
      .eq('user_id', getUserId());
    // Table absent (migration pending) → behave as if the user has no
    // preferences rather than breaking every notification load.
    if (error) return [];
    return (data ?? []).map(mapNotificationPref);
  },

  /** Mute/unmute one group, or — with groupId null — everything. Upserts on
   *  the (user_id, COALESCE(group_id,'')) unique index. */
  async setMuted(groupId: string | null, muted: boolean): Promise<void> {
    const userId = getUserId();
    const { data } = await supabase
      .from('notification_prefs').select('id')
      .eq('user_id', userId)
      .filter('group_id', groupId === null ? 'is' : 'eq', groupId === null ? null : groupId)
      .maybeSingle();
    if (data?.id) {
      const { error } = await supabase
        .from('notification_prefs')
        .update({ muted, updated_at: new Date().toISOString() })
        .eq('id', data.id as string);
      if (error) throw error;
      return;
    }
    const { error } = await supabase
      .from('notification_prefs')
      .insert({ user_id: userId, group_id: groupId, muted });
    if (error) throw error;
  },

  /** Set (or clear, with nulls) the global quiet-hours window. Always writes
   *  the global row — quiet hours are never per-group. */
  async setQuietHours(startHour: number | null, endHour: number | null, tz?: string): Promise<void> {
    const userId = getUserId();
    const zone = tz
      || (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return 'Asia/Karachi'; } })();
    const { data } = await supabase
      .from('notification_prefs').select('id')
      .eq('user_id', userId)
      .is('group_id', null)
      .maybeSingle();
    const patch = {
      quiet_hours_start: startHour,
      quiet_hours_end: endHour,
      tz: zone,
      updated_at: new Date().toISOString(),
    };
    if (data?.id) {
      const { error } = await supabase
        .from('notification_prefs').update(patch).eq('id', data.id as string);
      if (error) throw error;
      return;
    }
    const { error } = await supabase
      .from('notification_prefs')
      .insert({ user_id: userId, group_id: null, muted: false, ...patch });
    if (error) throw error;
  },
};

export const profilesDb = {
  async getCurrent(): Promise<Record<string, unknown> | null> {
    const { data, error } = await supabase
      .from('profiles').select('*')
      .eq('id', getUserId())
      .single();
    if (error) return null;
    return data ?? null;
  },
  async updateCurrent(changes: Record<string, unknown>) {
    const { error } = await supabase.from('profiles').update(changes).eq('id', getUserId());
    if (error) throw error;
  },
  async findByPublicCode(normalizedCode: string): Promise<{ id: string; name: string; publicCode: string } | null> {
    // lookup_profile_by_public_code was dropped by prelaunch-hardening (it
    // leaked the target's code); lookup_profile_by_code is the throttled
    // replacement and returns only profile_id + display_name. The caller
    // already holds the code it typed, so echo that back as publicCode.
    const { data, error } = await supabase.rpc('lookup_profile_by_code', { code: normalizedCode });
    if (error) return null;
    const row = Array.isArray(data) ? data[0] : data;
    if (!row?.profile_id) return null;
    return { id: row.profile_id as string, name: (row.display_name as string) ?? '', publicCode: normalizedCode };
  },
};

export const accountDeletionDb = {
  async deleteCurrentUser() {
    const { error } = await supabase.rpc('delete_current_user');
    if (error) throw error;
  },
};

export interface LeaveGroupResult {
  success: boolean;
  reasonCode: string;
  userMessage: string;
  payableAmount: number;
  receivableAmount: number;
  currency: string | null;
}

// accept_group_membership / decline_group_membership / transfer_group_ownership
// all return leave_group's { success, reason_code, user_message } shape on
// purpose (consent-guards.sql §2.5, account-deletion.sql §5), so one parser
// serves all four.
function parseLeaveGroupShape(data: unknown, fallbackMessage: string): LeaveGroupResult {
  const result = (data ?? {}) as Record<string, unknown>;
  return {
    success: Boolean(result.success),
    reasonCode: String(result.reason_code ?? 'UNKNOWN'),
    userMessage: String(result.user_message ?? fallbackMessage),
    payableAmount: Number(result.payable_amount ?? 0),
    receivableAmount: Number(result.receivable_amount ?? 0),
    currency: result.currency ? String(result.currency) : null,
  };
}

/** One row of list_pending_group_memberships (consent-guards.sql §2.6) — the
 *  ONLY window an invited user has onto a group they have not accepted, since
 *  is_group_member() still means 'connected' and the split_groups SELECT policy
 *  hides the row entirely. Scalar fields only: no member list, no ledger, no
 *  join code. */
export interface PendingGroupInvitation {
  groupId: string;
  memberId: string;
  groupName: string;
  groupEmoji: string;
  currency: string;
  invitedBy: string | null;
  invitedByName: string;
  invitedAt: string | null;
}

export const groupMembershipDb = {
  async leave(groupId: string): Promise<LeaveGroupResult> {
    const { data, error } = await supabase.rpc('leave_group', { p_group_id: groupId });
    if (error) throw new Error(error.message || 'Could not leave this group');
    return parseLeaveGroupShape(data, 'Could not leave this group.');
  },

  // Invitations the caller has NOT accepted yet. Returns [] rather than
  // throwing on an un-migrated database: a missing RPC must not break the
  // Groups tab, it just means there are no pending invitations to show.
  async listPending(): Promise<PendingGroupInvitation[]> {
    const { data, error } = await supabase.rpc('list_pending_group_memberships');
    if (error) {
      if (isMissingFunctionError(error)) return [];
      throw error;
    }
    if (!Array.isArray(data)) return [];
    return data.map((raw) => {
      const row = (raw ?? {}) as Record<string, unknown>;
      return {
        groupId: String(row.group_id ?? ''),
        memberId: String(row.member_id ?? ''),
        groupName: String(row.group_name ?? ''),
        groupEmoji: String(row.group_emoji ?? ''),
        currency: String(row.currency ?? 'PKR'),
        invitedBy: row.invited_by ? String(row.invited_by) : null,
        invitedByName: String(row.invited_by_name ?? ''),
        invitedAt: row.invited_at ? String(row.invited_at) : null,
      };
    }).filter(row => row.groupId !== '');
  },

  // The invitee promotes their OWN status='invited' row to 'connected'. No
  // other party can call it for them (auth.uid() must equal profile_id).
  async accept(groupId: string): Promise<LeaveGroupResult> {
    const { data, error } = await supabase.rpc('accept_group_membership', { p_group_id: groupId });
    if (error) throw new Error(error.message || 'Could not accept this invitation');
    return parseLeaveGroupShape(data, 'Could not accept this invitation.');
  },

  // Unconditional refusal. Deliberately a SEPARATE RPC from leave_group and
  // deliberately carrying NONE of its balance / reconciliation gates — that is
  // the whole point of consent-guards §2.5: a never-accepted user must always
  // be able to say no, or an attacker could conscript them and then wedge the
  // exit shut with an expense.
  async decline(groupId: string): Promise<LeaveGroupResult> {
    const { data, error } = await supabase.rpc('decline_group_membership', { p_group_id: groupId });
    if (error) throw new Error(error.message || 'Could not decline this invitation');
    return parseLeaveGroupShape(data, 'Could not decline this invitation.');
  },
};

/** Result of add_group_guest / remove_group_guest
 *  (supabase-migration-p2-guest-members.sql §4a/§4b).
 *
 *  Both RPCs return failures as DATA, never as exceptions — the repo-wide rule
 *  from audit H1: a RAISE rolls back everything the call already committed,
 *  which is how the join-code rate limiter became a no-op once. So `status` is
 *  always present and 'ok' is the only success (plus the idempotent replays,
 *  ALREADY_ADDED). src/lib/groupGuests.ts owns the code -> copy mapping. */
export interface GuestSeatResult {
  status: string;
  memberId: string | null;
  displayName: string | null;
  hasPhone: boolean;
}

function parseGuestSeatShape(data: unknown): GuestSeatResult {
  const row = (data ?? {}) as Record<string, unknown>;
  return {
    status: String(row.status ?? 'UNKNOWN'),
    memberId: row.member_id ? String(row.member_id) : null,
    displayName: row.display_name ? String(row.display_name) : null,
    hasPhone: Boolean(row.has_phone),
  };
}

/**
 * Guest seats — named group members with no Hisaab account (audit G6 / O4).
 *
 * There is no direct-table equivalent of these two calls and there must not be:
 *   * the INSERT could be done raw by the group OWNER only (the group_members
 *     INSERT policy, supabase-schema.sql:365-374), which would leave every
 *     non-owner member unable to add a guest and would skip the phone hashing
 *     entirely — group_guest_identities is unreachable from a client role;
 *   * group_members has had NO client DELETE path since safe-leave-group.sql,
 *     so removal has to be a definer RPC that first proves the seat carries no
 *     ledger rows.
 */
export const groupGuestsDb = {
  /**
   * `memberId` is minted by the CALLER (uuid, like every other group write in
   * splitStore) so a double tap or a retry after a dropped response replays
   * onto the same row instead of creating a twin — the same idempotency
   * contract record_group_settlement has on p_settlement_id.
   *
   * `phone` is the RAW string the user typed. The server normalises it through
   * phone_e164_candidates and stores only SHA-256 digests; the number itself
   * never lands in a column and can never be read back, by anyone.
   */
  async add(groupId: string, memberId: string, displayName: string, phone?: string | null): Promise<GuestSeatResult> {
    const { data, error } = await supabase.rpc('add_group_guest', {
      p_group_id: groupId,
      p_display_name: displayName,
      p_phone: phone ?? null,
      p_member_id: memberId,
    });
    if (error) throw error;
    return parseGuestSeatShape(data);
  },

  /** Only an UNUSED seat, and only for the owner or whoever added it. Returns
   *  GUEST_HAS_LEDGER the moment any expense, split share or settlement — soft
   *  deleted ones included — references the member id, because deleting it
   *  would dangle paid_by / from_member / splits[].memberId. */
  async remove(groupId: string, memberId: string): Promise<GuestSeatResult> {
    const { data, error } = await supabase.rpc('remove_group_guest', {
      p_group_id: groupId,
      p_member_id: memberId,
    });
    if (error) throw error;
    return parseGuestSeatShape(data);
  },
};

/** archive_group / unarchive_group return leave_group's shape plus the new
 *  archived_at, so the client can update its mirror without a re-fetch. */
export interface GroupArchiveResult {
  success: boolean;
  reasonCode: string;
  userMessage: string;
  archivedAt: string | null;
}

function parseArchiveResult(data: unknown, fallbackMessage: string): GroupArchiveResult {
  const result = (data ?? {}) as Record<string, unknown>;
  return {
    success: Boolean(result.success),
    reasonCode: String(result.reason_code ?? 'UNKNOWN'),
    userMessage: String(result.user_message ?? fallbackMessage),
    archivedAt: result.archived_at ? String(result.archived_at) : null,
  };
}

// Owner-only, non-destructive alternative to deleting a shared group
// (supabase-migration-audit-p0-group-deletion-guard.sql §6). archived_at may
// NOT be PATCHed directly — split_groups_protect_archive refuses that with
// GROUP_ARCHIVE_RPC_ONLY — so the group_event and the member notification can
// never be skipped.
export const groupArchiveDb = {
  async archive(groupId: string): Promise<GroupArchiveResult> {
    const { data, error } = await supabase.rpc('archive_group', { p_group_id: groupId });
    if (error) throw error;
    return parseArchiveResult(data, 'Could not archive this group.');
  },
  async unarchive(groupId: string): Promise<GroupArchiveResult> {
    const { data, error } = await supabase.rpc('unarchive_group', { p_group_id: groupId });
    if (error) throw error;
    return parseArchiveResult(data, 'Could not reopen this group.');
  },
};

// Owner-only ownership handover (supabase-migration-audit-p0-account-deletion
// .sql §5). The target must already be a connected, profile-linked member of
// the same group, so a group can never be handed to a stranger. This is the
// resolution path for BOTH delete_current_user's OWNED_GROUPS_WITH_MEMBERS
// refusal and leave_group's ONLY_OWNER_ADMIN refusal.
export const groupOwnershipDb = {
  async transfer(groupId: string, newOwnerMemberId: string): Promise<LeaveGroupResult> {
    const { data, error } = await supabase.rpc('transfer_group_ownership', {
      p_group_id: groupId,
      p_new_owner_member_id: newOwnerMemberId,
    });
    if (error) throw new Error(error.message || 'Could not transfer ownership');
    return parseLeaveGroupShape(data, 'Could not transfer ownership.');
  },
};

// Owner-only co-admin grant / removal (supabase-migration-group-admins.sql
// §5e). The owner stays the owner either way — this is the fix for the
// founder's "making someone an admin removed me". Failures come back as data
// (status), never as a throw, including the one the CLIENT detects: on a
// database without the migration PostgREST answers PGRST202 ("function not in
// the schema cache") and this returns NEEDS_DB_UPDATE, so the UI can say so
// instead of showing a raw error.
export const groupAdminsDb = {
  async setAdmin(groupId: string, memberId: string, isAdmin: boolean): Promise<SetGroupAdminResult> {
    const { data, error } = await supabase.rpc('set_group_admin', {
      p_group_id: groupId,
      p_member_id: memberId,
      p_is_admin: isAdmin,
    });
    if (error) {
      if (isMissingFunctionError(error)) return missingAdminRpcResult();
      throw error;
    }
    return parseSetGroupAdminResult(data);
  },
};

export const groupsLookupDb = {
  async findByJoinCode(normalizedCode: string): Promise<{ id: string; name: string; emoji: string; currency: string } | null> {
    void normalizedCode;
    throw new Error('Direct group-code lookup is disabled. Join through joinByCode().');
  },

  // Sighted join (audit 2026-09, UX-18). findByJoinCode above stays disabled —
  // a non-member genuinely cannot SELECT split_groups — so the preview goes
  // through a SECURITY DEFINER RPC with a FIXED, minimal projection:
  // {name, emoji, member_count, currency, owner_display_name, is_archived}.
  // No group id, no member list, no money. See
  // supabase-migration-p1-group-preview.sql.
  //
  // Like joinByCode, this never throws for a business outcome — the RPC
  // RETURNs a status object rather than raising, because a RAISE would roll
  // back the join_code_attempts row that charges the miss (audit H1's root
  // cause). Misses share join_group_by_code's own 5-per-5-minute window, so
  // previewing cannot double an attacker's guess rate.
  //
  // A thrown error is mapped, not propagated: an un-migrated database yields
  // 'UNAVAILABLE', which callers treat as a soft failure and fall back to the
  // legacy code-echo confirm. A missing preview must never block a real join.
  async previewByCode(normalizedCode: string): Promise<GroupPreviewResult> {
    try {
      const { data, error } = await supabase.rpc('preview_group_by_code', {
        p_code_normalized: normalizedCode,
      });
      if (error) return { status: previewStatusFromThrown(error) };
      return parseGroupPreviewResponse(data);
    } catch (err) {
      return { status: previewStatusFromThrown(err) };
    }
  },

  // Atomic join: SECURITY DEFINER RPC resolves the code and upserts the
  // caller's membership in one step. Needed because a non-member can't read
  // split_groups directly — the prior "lookup → re-fetch → insert" flow
  // always failed at the re-fetch step under strict RLS.
  //
  // Audit 2026-09 (C5 / security H1): the RPC now returns a jsonb status
  // object rather than raising, because a RAISE rolled back the very
  // join_code_attempts row the brute-force limiter counts. This never throws
  // for a business outcome — callers switch on `status`. The try/catch is kept
  // deliberately: migrations are hand-applied, so prod may briefly still run
  // the old RETURNS TABLE + RAISE version, and its thrown message is mapped
  // into the same vocabulary.
  async joinByCode(
    normalizedCode: string,
    displayName: string,
  ): Promise<JoinCodeResult> {
    try {
      const { data, error } = await supabase.rpc('join_group_by_code', {
        p_code_normalized: normalizedCode,
        p_display_name: displayName,
      });
      if (error) return { status: joinStatusFromThrown(error) };
      return parseJoinByCodeResponse(data);
    } catch (err) {
      return { status: joinStatusFromThrown(err) };
    }
  },
  // Invite-link redemption. Audit 2026-09 (H3 / SEC-07,
  // supabase-migration-audit-p0-consent-guards.sql §3.5): the RAW token goes to
  // the server, which derives the SHA-256 itself with hash_invite_token. The
  // client no longer hashes anything — that was the bug, because the stored
  // hash WAS the password and RLS handed it to every group member. The
  // parameter was renamed p_invite_token_hash -> p_invite_token so an
  // un-updated client fails loudly instead of silently hashing a hash.
  //
  // Like joinByCode, this returns a status and never throws for a business
  // outcome: the RPC must RETURN rather than RAISE or the
  // invite_accept_attempts row the rate limiter counts would roll back.
  //
  // Graceful fallback: migrations are hand-applied, so prod may still run the
  // OLD RETURNS TABLE function, which does not know the new argument name.
  // PGRST202 / 42883 means exactly that — retry once against the legacy
  // signature with the locally-computed hash, so existing invite links keep
  // working in the window before the migration lands.
  async acceptInvite(
    rawToken: string,
    displayName: string,
  ): Promise<InviteAcceptResult> {
    try {
      const { data, error } = await supabase.rpc('accept_group_invite', {
        p_invite_token: rawToken,
        p_display_name: displayName,
      });
      if (!error) return parseAcceptInviteResponse(data);
      if (!isMissingFunctionError(error)) return { status: inviteStatusFromThrown(error) };

      // Dynamic import keeps supabaseDb free of a static edge to collaboration,
      // which itself lazily imports this module.
      const { sha256Hex } = await import('./collaboration');
      const legacy = await supabase.rpc('accept_group_invite', {
        p_invite_token_hash: await sha256Hex(rawToken),
        p_display_name: displayName,
      });
      if (legacy.error) return { status: inviteStatusFromThrown(legacy.error) };
      return parseAcceptInviteResponse(legacy.data);
    } catch (err) {
      return { status: inviteStatusFromThrown(err) };
    }
  },
};


// ══════════════════════════════════════
// Mapping helpers: snake_case DB → camelCase app types
// ══════════════════════════════════════

function mapAccount(r: Record<string, unknown>): Account {
  return {
    id: r.id as string, name: r.name as string, type: r.type as Account['type'],
    currency: r.currency as Account['currency'], balance: Number(r.balance),
    metadata: (r.metadata ?? {}) as Record<string, string>, createdAt: r.created_at as string,
    updatedAt: (r.updated_at as string) ?? (r.created_at as string),
    deletedAt: (r.deleted_at as string) ?? null,
  };
}

function mapDeletedRow(r: Record<string, unknown>): DeletedRow {
  return {
    id: r.id as string,
    deletedAt: r.deleted_at as string,
  };
}

function mapTransaction(r: Record<string, unknown>): Transaction {
  return {
    id: r.id as string, type: r.type as Transaction['type'], amount: Number(r.amount),
    currency: r.currency as Transaction['currency'],
    sourceAccountId: (r.source_account_id as string) ?? null,
    destinationAccountId: (r.destination_account_id as string) ?? null,
    relatedPerson: (r.related_person as string) ?? null,
    personId: (r.person_id as string) ?? null,
    relatedLoanId: (r.related_loan_id as string) ?? null,
    relatedGoalId: (r.related_goal_id as string) ?? null,
    relatedInvestmentId: (r.related_investment_id as string) ?? null,
    conversionRate: r.conversion_rate != null ? Number(r.conversion_rate) : null,
    category: (r.category as string) ?? '', notes: (r.notes as string) ?? '',
    createdAt: r.created_at as string,
    isReconciled: Boolean(r.is_reconciled),
    reconciledAt: (r.reconciled_at as string) ?? null,
    reconciledBy: (r.reconciled_by as string) ?? null,
    receiptPath: (r.receipt_path as string) ?? null,
    updatedAt: (r.updated_at as string) ?? (r.created_at as string),
    deletedAt: (r.deleted_at as string) ?? null,
  };
}

function mapLoan(r: Record<string, unknown>): Loan {
  return {
    id: r.id as string, personName: r.person_name as string,
    personId: (r.person_id as string) ?? null,
    type: r.type as Loan['type'], totalAmount: Number(r.total_amount),
    remainingAmount: Number(r.remaining_amount), currency: r.currency as Loan['currency'],
    status: r.status as Loan['status'], notes: (r.notes as string) ?? '',
    createdAt: r.created_at as string,
    updatedAt: (r.updated_at as string) ?? (r.created_at as string),
    deletedAt: (r.deleted_at as string) ?? null,
    loanPairId: (r.loan_pair_id as string) ?? null,
  };
}

function mapPerson(r: Record<string, unknown>): Person {
  return {
    id: r.id as string,
    name: r.name as string,
    phone: (r.phone as string) ?? null,
    linkedProfileId: (r.linked_profile_id as string) ?? null,
    archivedAt: (r.archived_at as string) ?? null,
    createdAt: r.created_at as string,
    updatedAt: (r.updated_at as string) ?? (r.created_at as string),
  };
}

function mapEmi(r: Record<string, unknown>): EmiSchedule {
  return {
    id: r.id as string, loanId: r.loan_id as string,
    installmentNumber: Number(r.installment_number), dueDate: r.due_date as string,
    amount: Number(r.amount), status: r.status as EmiSchedule['status'],
  };
}

function mapGoal(r: Record<string, unknown>): Goal {
  return {
    id: r.id as string, title: r.title as string,
    targetAmount: Number(r.target_amount), savedAmount: Number(r.saved_amount),
    currency: r.currency as Goal['currency'],
    storedInAccountId: (r.stored_in_account_id as string) ?? '',
    createdAt: r.created_at as string,
    targetDate: (r.target_date as string) ?? null,
  };
}

function mapActivity(r: Record<string, unknown>): ActivityLog {
  return {
    id: r.id as string, type: r.type as ActivityLog['type'],
    description: (r.description as string) ?? '',
    relatedEntityId: (r.related_entity_id as string) ?? '',
    relatedEntityType: (r.related_entity_type as string) ?? '',
    timestamp: r.timestamp as string,
  };
}

function mapUpcoming(r: Record<string, unknown>): UpcomingExpense {
  return {
    id: r.id as string, title: r.title as string,
    amount: Number(r.amount), currency: r.currency as UpcomingExpense['currency'],
    dueDate: r.due_date as string, accountId: (r.account_id as string) ?? '',
    category: (r.category as string) ?? '', notes: (r.notes as string) ?? '',
    isPaid: Boolean(r.is_paid), status: r.status as UpcomingExpense['status'],
    reminderDaysBefore: Number(r.reminder_days_before ?? 0),
    createdAt: r.created_at as string,
  };
}

function mapGroup(r: Record<string, unknown>): SplitGroup {
  return {
    id: r.id as string, name: r.name as string, emoji: (r.emoji as string) ?? '',
    members: r.members as SplitGroup['members'], currency: r.currency as SplitGroup['currency'],
    settled: Boolean(r.settled), createdAt: r.created_at as string,
    createdBy: (r.created_by as string) ?? (r.user_id as string) ?? null,
    joinCode: (r.join_code as string) ?? null,
    joinCodeNormalized: (r.join_code_normalized as string) ?? null,
    // Added by audit-p0-join-abuse-limits / audit-p0-group-deletion-guard.
    // Tolerate their absence so a client running against a pre-migration
    // database still renders the group (undefined ⇒ "no expiry known",
    // "not archived").
    joinCodeExpiresAt: (r.join_code_expires_at as string) ?? null,
    archivedAt: (r.archived_at as string) ?? null,
    archivedBy: (r.archived_by as string) ?? null,
  };
}

function mapGroupExpense(r: Record<string, unknown>): GroupExpense {
  return {
    id: r.id as string, groupId: r.group_id as string,
    description: (r.description as string) ?? '', amount: Number(r.amount),
    paidBy: r.paid_by as string, splitType: r.split_type as GroupExpense['splitType'],
    splits: r.splits as GroupExpense['splits'], category: (r.category as string) ?? '',
    date: (r.date as string) ?? '', notes: (r.notes as string) ?? '',
    createdAt: r.created_at as string,
    createdBy: (r.created_by as string) ?? null,
    updatedBy: (r.updated_by as string) ?? null,
    deletedAt: (r.deleted_at as string) ?? null,
    deletedBy: (r.deleted_by as string) ?? null,
    version: Number(r.version ?? 1),
    isReconciled: Boolean(r.is_reconciled),
    reconciledAt: (r.reconciled_at as string) ?? null,
    reconciledBy: (r.reconciled_by as string) ?? null,
  };
}

function mapGroupSettlement(r: Record<string, unknown>): GroupSettlement {
  return {
    id: r.id as string, groupId: r.group_id as string,
    fromMember: r.from_member as string, toMember: r.to_member as string,
    amount: Number(r.amount), date: (r.date as string) ?? '',
    note: (r.note as string) ?? '', createdAt: r.created_at as string,
    createdBy: (r.created_by as string) ?? null,
    updatedBy: (r.updated_by as string) ?? null,
    deletedAt: (r.deleted_at as string) ?? null,
    deletedBy: (r.deleted_by as string) ?? null,
  };
}

function mapGroupMember(r: Record<string, unknown>): GroupMember {
  const role = (r.role as GroupMember['role']) ?? 'member';
  return {
    id: r.id as string,
    name: (r.display_name as string) ?? '',
    isOwner: role === 'owner',
    profileId: (r.profile_id as string) ?? null,
    role,
    status: (r.status as GroupMember['status']) ?? 'guest',
    joinedAt: (r.joined_at as string) ?? null,
    // supabase-migration-group-admins.sql. Read from select('*') on purpose —
    // naming the column in a select list would 400 on a database that has not
    // been migrated yet. Absent column ⇒ undefined ("no co-admins on this
    // server"), never an error.
    isAdmin: typeof r.is_admin === 'boolean' ? r.is_admin : undefined,
  };
}

function mapGroupInvite(r: Record<string, unknown>): GroupInvite {
  return {
    id: r.id as string,
    groupId: r.group_id as string,
    // Never selected any more (consent-guards §3.2 revoked the column grant).
    // Left optional so a row read by some other path still maps cleanly.
    tokenHash: (r.token_hash as string) ?? undefined,
    createdBy: r.created_by as string,
    linkedMemberId: (r.linked_member_id as string) ?? null,
    expiresAt: (r.expires_at as string) ?? null,
    revokedAt: (r.revoked_at as string) ?? null,
    acceptedBy: (r.accepted_by as string) ?? null,
    acceptedAt: (r.accepted_at as string) ?? null,
    createdAt: r.created_at as string,
  };
}

function mapGroupEvent(r: Record<string, unknown>): GroupEvent {
  return {
    id: r.id as string,
    groupId: r.group_id as string,
    actorProfileId: (r.actor_profile_id as string) ?? null,
    eventType: r.event_type as GroupEvent['eventType'],
    entityType: r.entity_type as GroupEvent['entityType'],
    entityId: r.entity_id as string,
    summary: (r.summary as string) ?? '',
    payload: (r.payload as Record<string, unknown>) ?? {},
    createdAt: r.created_at as string,
  };
}

function mapNotification(r: Record<string, unknown>): AppNotification {
  return {
    id: r.id as string,
    userId: r.user_id as string,
    groupId: (r.group_id as string) ?? null,
    eventId: (r.event_id as string) ?? null,
    type: r.type as AppNotification['type'],
    title: (r.title as string) ?? '',
    body: (r.body as string) ?? '',
    // Added by supabase-migration-audit-p0-notifications.sql. Tolerate their
    // absence so a client running against a pre-migration database (or a row
    // written by an older trigger) still renders the stored title/body.
    template: (r.template as string) ?? null,
    params: (r.params && typeof r.params === 'object' && !Array.isArray(r.params)
      ? r.params
      : {}) as Record<string, unknown>,
    actorId: (r.actor_id as string) ?? null,
    // Added by supabase-migration-p2-notification-maturity.sql. Same
    // tolerance as template/params above: a pre-migration database simply
    // returns nothing here and the client falls back to its own derivation
    // (notificationHref / notificationChannel in notificationContent.ts).
    collapseKey: (r.collapse_key as string) ?? null,
    channelId: (r.channel_id as string) ?? null,
    href: (r.href as string) ?? null,
    readAt: (r.read_at as string) ?? null,
    createdAt: r.created_at as string,
  };
}

// ══════════════════════════════════════
// BUDGETS (Phase 3)
// ══════════════════════════════════════
export const budgetsDb = {
  async getAll(): Promise<Budget[]> {
    const { data, error } = await supabase
      .from('budgets').select('*')
      .eq('user_id', getUserId())
      .is('deleted_at', null)
      .order('category', { ascending: true });
    if (error) throw error;
    return (data ?? []).map(mapBudget);
  },
  async getUpdatedSince(updatedAfter: string): Promise<Budget[]> {
    const { data, error } = await supabase
      .from('budgets').select('*')
      .eq('user_id', getUserId())
      .is('deleted_at', null)
      .gt('updated_at', updatedAfter)
      .order('updated_at', { ascending: true });
    if (error) throw error;
    return (data ?? []).map(mapBudget);
  },
  async getDeletedSince(deletedAfter: string): Promise<DeletedRow[]> {
    const { data, error } = await supabase
      .from('budgets').select('id, deleted_at')
      .eq('user_id', getUserId())
      .gt('deleted_at', deletedAfter)
      .order('deleted_at', { ascending: true });
    if (error) throw error;
    return (data ?? []).map(mapDeletedRow);
  },
  async add(b: Budget) {
    const { error } = await supabase.from('budgets').insert({
      id: b.id, user_id: getUserId(), category: b.category,
      monthly_amount: b.monthlyAmount, currency: b.currency,
      warn_at_percent: b.warnAtPercent, created_at: b.createdAt,
    });
    if (error) throw error;
  },
  async update(id: string, changes: Partial<Budget>) {
    const row: Record<string, unknown> = {};
    if (changes.category !== undefined) row.category = changes.category;
    if (changes.monthlyAmount !== undefined) row.monthly_amount = changes.monthlyAmount;
    if (changes.currency !== undefined) row.currency = changes.currency;
    if (changes.warnAtPercent !== undefined) row.warn_at_percent = changes.warnAtPercent;
    const { error } = await supabase.from('budgets').update(row).eq('id', id).eq('user_id', getUserId());
    if (error) throw error;
  },
  async delete(id: string) {
    const { error } = await supabase
      .from('budgets')
      .update({ deleted_at: new Date().toISOString() })
      .eq('id', id)
      .eq('user_id', getUserId());
    if (error) throw error;
  },
};

function mapBudget(r: Record<string, unknown>): Budget {
  return {
    id: r.id as string,
    category: r.category as string,
    monthlyAmount: Number(r.monthly_amount),
    currency: r.currency as Currency,
    warnAtPercent: Number(r.warn_at_percent ?? 80),
    createdAt: r.created_at as string,
    updatedAt: (r.updated_at as string) ?? (r.created_at as string),
    deletedAt: (r.deleted_at as string) ?? null,
  };
}

// ══════════════════════════════════════
// CUSTOM CATEGORIES (user-defined expense/income names)
// Hard-delete table — see supabase-migration-custom-categories.sql.
// ══════════════════════════════════════
export const customCategoriesDb = {
  async getAll(): Promise<CustomCategory[]> {
    const { data, error } = await supabase
      .from('custom_categories').select('*')
      .eq('user_id', getUserId())
      .order('type', { ascending: true })
      .order('name', { ascending: true });
    if (error) throw error;
    return (data ?? []).map(mapCustomCategory);
  },
  async add(c: CustomCategory) {
    const { error } = await supabase.from('custom_categories').insert({
      id: c.id, user_id: getUserId(), type: c.type, name: c.name,
      created_at: c.createdAt, updated_at: c.updatedAt ?? c.createdAt,
    });
    if (error) throw error;
  },
  async update(id: string, changes: Partial<CustomCategory>) {
    const row: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (changes.name !== undefined) row.name = changes.name;
    const { error } = await supabase
      .from('custom_categories').update(row)
      .eq('id', id).eq('user_id', getUserId());
    if (error) throw error;
  },
  async delete(id: string) {
    const { error } = await supabase
      .from('custom_categories').delete()
      .eq('id', id).eq('user_id', getUserId());
    if (error) throw error;
  },
};

function mapCustomCategory(r: Record<string, unknown>): CustomCategory {
  return {
    id: r.id as string,
    type: r.type as CustomCategory['type'],
    name: r.name as string,
    createdAt: r.created_at as string,
    updatedAt: (r.updated_at as string) ?? (r.created_at as string),
  };
}

// ══════════════════════════════════════
// KAMETI / COMMITTEES (no-custody ROSCA tracker)
// See supabase-migration-committees.sql.
// ══════════════════════════════════════

// Stable failure codes raised by perform_committee_draw (see
// supabase-migration-audit-p0-kameti-draw.sql). PostgREST surfaces the RAISE
// text verbatim in error.message, so we match on the token rather than on
// Postgres error codes.
// The three KAMETI_* codes join the same list on purpose: the editing RPCs
// (supabase-migration-p2-kameti-editing.sql) reuse this file's NOT_ORGANISER /
// NOT_FOUND / NOT_AUTHENTICATED verbatim, and its guard trigger fires on the
// same ORDINARY table writes the draw guards do. One list means one mapper
// (`toCommitteeDrawError`) and one exhaustive `Record` in the UI — adding a
// code here is a TYPE ERROR at every mapping site until it is translated,
// which is what keeps a new refusal from degrading to "something went wrong".
export const COMMITTEE_DRAW_ERRORS = [
  'ALREADY_DRAWN', 'NOT_ORGANISER', 'NOT_FOUND', 'NOT_ACTIVE',
  'TOO_FEW_MEMBERS', 'NOT_AUTHENTICATED', 'DRAW_LOCKED', 'DRAW_FIELDS_ARE_SERVER_ONLY',
  'SLOTS_ALREADY_SET', 'BALLOT_SLOTS_SERVER_ONLY', 'BALLOT_SWITCH_NEEDS_CLEAR_SLOTS',
  'KAMETI_LOCKED_PAYMENTS', 'KAMETI_LOCKED_DRAW', 'KAMETI_INVALID_PATCH',
] as const;
export type CommitteeDrawErrorCode = (typeof COMMITTEE_DRAW_ERRORS)[number];

export class CommitteeDrawError extends Error {
  readonly code: CommitteeDrawErrorCode | 'UNKNOWN';
  constructor(code: CommitteeDrawErrorCode | 'UNKNOWN', message?: string) {
    super(message ?? code);
    this.name = 'CommitteeDrawError';
    this.code = code;
  }
}

/**
 * Map a raw Postgres/PostgREST failure onto one of the stable draw/slot codes.
 *
 * Exported because the ballot guards fire on ORDINARY table writes too, not
 * just `perform_committee_draw`: `committee_members.slot` raises
 * BALLOT_SLOTS_SERVER_ONLY and `committees.payout_method` raises
 * BALLOT_SWITCH_NEEDS_CLEAR_SLOTS. Callers of those plain updates need the same
 * mapping, or the user gets a raw Postgres string.
 */
export function toCommitteeDrawError(err: unknown): CommitteeDrawError {
  if (err instanceof CommitteeDrawError) return err;
  const raw = err as { message?: string; details?: string; hint?: string } | null;
  const message = [raw?.message, raw?.details, raw?.hint].filter(Boolean).join(' ') || String(err);
  const code = COMMITTEE_DRAW_ERRORS.find((c) => message.includes(c));
  return new CommitteeDrawError(code ?? 'UNKNOWN', message);
}

export interface CommitteeDrawResult {
  drawnAt: string;
  drawSeed: string;
  drawCommitment: string;
  drawScheme: string;
  /** Member ids in slot order — index 0 holds slot 1. */
  order: string[];
}

/**
 * Result of `rotate_committee_witness_token`. `token` is the ONLY time the raw
 * value exists on this device — show it, let the user copy/share it, and let it
 * fall out of scope. Never persist it (see docs/trust-and-safety.md §4.5).
 */
export type CommitteeWitnessRotation =
  | {
      status: 'ok';
      token: string;
      expiresAt: string | null;
      initialsOnly: boolean;
      /** True when this rotate killed a link that was already out there. */
      replacedPrevious: boolean;
    }
  | { status: 'NOT_FOUND' | 'NOT_AUTHENTICATED' | 'UNKNOWN' };

export type CommitteeWitnessRevocation =
  | { status: 'ok'; wasActive: boolean }
  | { status: 'NOT_FOUND' | 'NOT_AUTHENTICATED' | 'UNKNOWN' };

/**
 * The only fields `update_committee` accepts (UX-25 /
 * supabase-migration-p2-kameti-editing.sql). Anything else — the derived
 * counters, every draw column, every witness column — is refused as
 * KAMETI_INVALID_PATCH rather than silently dropped, so a client bug surfaces
 * as an error instead of an edit that appears to work and doesn't.
 *
 * name / emoji / notes / status are editable in every lifecycle state; the
 * rest only while nothing has been collected and the ballot is undrawn.
 * `emoji: null` clears it.
 */
export interface CommitteePatch {
  name?: string;
  emoji?: string | null;
  notes?: string;
  status?: Committee['status'];
  currency?: Currency;
  contributionAmount?: number;
  cadence?: Committee['cadence'];
  startDate?: string;
  payoutMethod?: Committee['payoutMethod'];
}

export interface CommitteeMemberAddResult {
  member: CommitteeMember;
  memberCount: number;
  totalRounds: number;
}

export interface CommitteeMemberRemoveResult {
  /** The slot the removed member held, if any — everything above it shifted down by one. */
  removedSlot: number | null;
  memberCount: number;
  totalRounds: number;
}

export const committeesDb = {
  async getAll(): Promise<Committee[]> {
    const { data, error } = await supabase
      .from('committees').select('*')
      .eq('user_id', getUserId())
      .order('created_at', { ascending: false });
    if (error) throw error;
    return (data ?? []).map(mapCommittee);
  },
  async add(c: Committee) {
    const { error } = await supabase.from('committees').insert({
      id: c.id, user_id: getUserId(), name: c.name, emoji: c.emoji ?? null, currency: c.currency,
      contribution_amount: c.contributionAmount, member_count: c.memberCount,
      cadence: c.cadence, total_rounds: c.totalRounds, start_date: c.startDate,
      payout_method: c.payoutMethod, status: c.status, notes: c.notes,
      drawn_at: c.drawnAt ?? null, created_at: c.createdAt,
    });
    if (error) throw error;
  },
  async update(id: string, changes: Partial<Committee>) {
    const row: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (changes.name !== undefined) row.name = changes.name;
    if (changes.payoutMethod !== undefined) row.payout_method = changes.payoutMethod;
    if (changes.status !== undefined) row.status = changes.status;
    if (changes.notes !== undefined) row.notes = changes.notes;
    if (changes.drawnAt !== undefined) row.drawn_at = changes.drawnAt;
    // `witness_initials_only` is an ordinary owner-writable preference (the
    // p2 guard trigger deliberately leaves it alone), so it rides along here.
    if (changes.witnessInitialsOnly !== undefined) row.witness_initials_only = changes.witnessInitialsOnly;
    // drawSeed / drawCommitment are deliberately NOT writable from here. Audit
    // 2026-09 M10: a client-written seed lets the organiser brute-force one that
    // yields a hand-picked order. Only perform_committee_draw() may set them,
    // and a trigger rejects any other write — see
    // supabase-migration-audit-p0-kameti-draw.sql.
    //
    // `shareToken` is likewise gone (audit M19 / p2-trust-safety §7.3): the
    // witness token is server-minted, only its SHA-256 is stored, and any
    // plaintext write raises WITNESS_TOKEN_IS_SERVER_ONLY. Use
    // rotateWitnessToken / revokeWitnessToken below.
    const { error } = await supabase.from('committees').update(row).eq('id', id).eq('user_id', getUserId());
    if (error) throw error;
  },
  async delete(id: string) {
    // Hard delete — FKs cascade members + payments.
    const { error } = await supabase.from('committees').delete().eq('id', id).eq('user_id', getUserId());
    if (error) throw error;
  },
  // The ballot draw. Runs ENTIRELY server-side inside one transaction: the seed
  // comes from Postgres entropy the organiser never sees or supplies, the order
  // is computed in SQL, and a drawn-guard makes a second call fail with
  // ALREADY_DRAWN. The client's only job afterwards is to recompute the same
  // order from the published seed and confirm it (src/lib/committeeDraw.ts).
  async performDraw(committeeId: string): Promise<CommitteeDrawResult> {
    const { data, error } = await supabase.rpc('perform_committee_draw', { p_committee_id: committeeId });
    if (error) throw toCommitteeDrawError(error);
    const raw = data as Record<string, unknown> | null;
    const order = Array.isArray(raw?.order) ? (raw.order as string[]) : [];
    if (!raw || order.length === 0) throw new CommitteeDrawError('UNKNOWN', 'perform_committee_draw returned no order');
    return {
      drawnAt: String(raw.drawnAt),
      drawSeed: String(raw.drawSeed),
      drawCommitment: String(raw.drawCommitment),
      drawScheme: String(raw.drawScheme),
      order,
    };
  },
  // ── Post-creation editing (UX-25) ───────────────────────────────────────
  // `committees` carries a plain owner UPDATE policy, so PostgREST would
  // happily take `contribution_amount = 1` on a kameti whose members have
  // already paid three rounds at 5000 — nothing Postgres can see would be
  // corrupted, and every historical payment would silently start meaning
  // something else. So the whole edit goes through one RPC that validates the
  // patch against the committee's lifecycle state BEFORE touching anything
  // (all-or-nothing: a patch with one illegal key changes not even its legal
  // ones), and a trigger refuses the same writes when they arrive raw.
  //
  // Returns the fields the server echoed back — merge, don't replace: the
  // payload deliberately omits the witness/draw columns it must never touch.
  async patch(id: string, patch: CommitteePatch): Promise<Partial<Committee> & { id: string }> {
    const { data, error } = await supabase.rpc('update_committee', {
      p_committee_id: id,
      p_patch: patch,
    });
    if (error) throw toCommitteeDrawError(error);
    const c = (data as { committee?: Record<string, unknown> } | null)?.committee;
    if (!c) throw new CommitteeDrawError('UNKNOWN', 'update_committee returned no committee');
    return {
      id: c.id as string,
      name: c.name as string,
      emoji: (c.emoji as string) ?? null,
      currency: c.currency as Currency,
      contributionAmount: Number(c.contributionAmount),
      memberCount: Number(c.memberCount),
      cadence: c.cadence as Committee['cadence'],
      totalRounds: Number(c.totalRounds),
      startDate: c.startDate as string,
      payoutMethod: c.payoutMethod as Committee['payoutMethod'],
      status: c.status as Committee['status'],
      notes: (c.notes as string) ?? '',
      drawnAt: (c.drawnAt as string) ?? null,
      updatedAt: (c.updatedAt as string) ?? new Date().toISOString(),
    };
  },
  /**
   * Appends a member AND a round (member_count + 1, total_rounds + 1). The two
   * counters are derived, so they are RPC-only in every state — a client that
   * could move member_count on its own would change what
   * `poolAmount() = contribution × memberCount` promises every member while
   * the roster stood still.
   */
  async addMember(
    committeeId: string,
    input: { name: string; phone?: string | null; personId?: string | null },
  ): Promise<CommitteeMemberAddResult> {
    const { data, error } = await supabase.rpc('add_committee_member', {
      p_committee_id: committeeId,
      p_name: input.name,
      p_phone: input.phone ?? null,
      p_person_id: input.personId ?? null,
    });
    if (error) throw toCommitteeDrawError(error);
    const raw = (data ?? {}) as { member?: Record<string, unknown>; memberCount?: number; totalRounds?: number };
    if (!raw.member) throw new CommitteeDrawError('UNKNOWN', 'add_committee_member returned no member');
    const m = raw.member;
    return {
      member: {
        id: m.id as string,
        committeeId,
        name: m.name as string,
        phone: (m.phone as string) ?? null,
        personId: (m.personId as string) ?? null,
        slot: m.slot != null ? Number(m.slot) : null,
        isOrganizer: false,
        payoutReceivedAt: null,
        exitedAt: null,
        createdAt: (m.createdAt as string) ?? new Date().toISOString(),
      },
      memberCount: Number(raw.memberCount),
      totalRounds: Number(raw.totalRounds),
    };
  },
  /**
   * Removes a member, compacts every slot above theirs DOWN by one and drops a
   * round. Refused once the ballot is drawn, for the organiser, below two
   * members, and whenever a contribution touches the member or any round from
   * their slot onwards (the compaction would re-number a round that already
   * happened).
   */
  async removeMember(committeeId: string, memberId: string): Promise<CommitteeMemberRemoveResult> {
    const { data, error } = await supabase.rpc('remove_committee_member', {
      p_committee_id: committeeId,
      p_member_id: memberId,
    });
    if (error) throw toCommitteeDrawError(error);
    const raw = (data ?? {}) as Record<string, unknown>;
    if (raw.status !== 'ok') throw new CommitteeDrawError('UNKNOWN', 'remove_committee_member did not confirm');
    return {
      removedSlot: raw.removedSlot != null ? Number(raw.removedSlot) : null,
      memberCount: Number(raw.memberCount),
      totalRounds: Number(raw.totalRounds),
    };
  },
  // ── Witness link lifecycle (audit M19 / UX-24) ──────────────────────────
  // BREAKING vs. the old client-minted token: `rotate_committee_witness_token`
  // generates 256 bits of SERVER entropy, stores only the SHA-256, resets the
  // 90-day expiry, clears any revocation, and INVALIDATES the previous link.
  // The raw token comes back exactly once and is never re-readable — so the
  // caller must show/share it immediately and must NOT persist it anywhere.
  async rotateWitnessToken(committeeId: string): Promise<CommitteeWitnessRotation> {
    const { data, error } = await supabase.rpc('rotate_committee_witness_token', {
      p_committee_id: committeeId,
    });
    if (error) throw error;
    const raw = (data ?? {}) as Record<string, unknown>;
    const status = String(raw.status ?? 'UNKNOWN');
    if (status !== 'ok' || typeof raw.token !== 'string') {
      // NOT_FOUND covers "not the organiser" as well as "no such kameti" —
      // deliberately indistinguishable, so the client must not guess which.
      return { status: status === 'NOT_FOUND' || status === 'NOT_AUTHENTICATED' ? status : 'UNKNOWN' };
    }
    return {
      status: 'ok',
      token: raw.token,
      expiresAt: typeof raw.expires_at === 'string' ? raw.expires_at : null,
      initialsOnly: raw.initials_only === true,
      replacedPrevious: raw.replaced_previous === true,
    };
  },
  /** The "stop sharing" kill switch. Idempotent; a revoked link reads as a bad one. */
  async revokeWitnessToken(committeeId: string): Promise<CommitteeWitnessRevocation> {
    const { data, error } = await supabase.rpc('revoke_committee_witness_token', {
      p_committee_id: committeeId,
    });
    if (error) throw error;
    const raw = (data ?? {}) as Record<string, unknown>;
    const status = String(raw.status ?? 'UNKNOWN');
    if (status !== 'ok') {
      return { status: status === 'NOT_FOUND' || status === 'NOT_AUTHENTICATED' ? status : 'UNKNOWN' };
    }
    return { status: 'ok', wasActive: raw.was_active === true };
  },
  // Read-only witness snapshot via the anon SECURITY DEFINER RPC. No auth
  // required — used by the public witness page. Returns null for a bad token
  // AND for a revoked or expired one: the three are deliberately identical.
  async getWitness(token: string): Promise<{ committee: Committee; members: CommitteeMember[]; payments: CommitteePayment[] } | null> {
    const { data, error } = await supabase.rpc('get_committee_witness', { p_token: token });
    if (error) throw error;
    if (!data) return null;
    const raw = data as { committee: Record<string, unknown>; members: Record<string, unknown>[]; payments: { memberId: string; round: number }[] };
    const c = raw.committee;
    const committee: Committee = {
      id: c.id as string, name: c.name as string, currency: c.currency as Currency,
      contributionAmount: Number(c.contributionAmount), memberCount: Number(c.memberCount),
      cadence: c.cadence as Committee['cadence'], totalRounds: Number(c.totalRounds),
      startDate: c.startDate as string, payoutMethod: c.payoutMethod as Committee['payoutMethod'],
      status: c.status as Committee['status'], notes: '',
      drawnAt: (c.drawnAt as string) ?? null, drawSeed: (c.drawSeed as string) ?? null,
      drawCommitment: (c.drawCommitment as string) ?? null,
      // [W4] the payload now carries the link's own expiry and whether the
      // organiser chose initials-only, so the public page can present both as
      // deliberate settings instead of missing data.
      witnessExpiresAt: (c.witnessExpiresAt as string) ?? null,
      witnessInitialsOnly: c.initialsOnly === true,
      createdAt: c.createdAt as string,
    };
    const members: CommitteeMember[] = raw.members.map((m) => ({
      id: m.id as string, committeeId: committee.id, name: m.name as string, phone: null, personId: null,
      slot: m.slot != null ? Number(m.slot) : null, isOrganizer: Boolean(m.isOrganizer),
      payoutReceivedAt: (m.payoutReceivedAt as string) ?? null, exitedAt: (m.exitedAt as string) ?? null,
      createdAt: '',
    }));
    const payments: CommitteePayment[] = raw.payments.map((p, i) => ({
      id: `${p.memberId}-${p.round}-${i}`, committeeId: committee.id, memberId: p.memberId, round: p.round, paidAt: '',
    }));
    return { committee, members, payments };
  },
};

export const committeeMembersDb = {
  async getAll(): Promise<CommitteeMember[]> {
    const { data, error } = await supabase
      .from('committee_members').select('*')
      .eq('user_id', getUserId())
      .order('created_at', { ascending: true });
    if (error) throw error;
    return (data ?? []).map(mapCommitteeMember);
  },
  async addMany(members: CommitteeMember[]) {
    if (members.length === 0) return;
    const rows = members.map((m) => ({
      id: m.id, committee_id: m.committeeId, user_id: getUserId(), name: m.name,
      phone: m.phone ?? null, person_id: m.personId ?? null, slot: m.slot ?? null,
      is_organizer: m.isOrganizer, payout_received_at: m.payoutReceivedAt ?? null,
      exited_at: m.exitedAt ?? null, created_at: m.createdAt,
    }));
    const { error } = await supabase.from('committee_members').insert(rows);
    if (error) throw error;
  },
  async update(id: string, changes: Partial<CommitteeMember>) {
    const row: Record<string, unknown> = {};
    if (changes.name !== undefined) row.name = changes.name;
    if (changes.phone !== undefined) row.phone = changes.phone;
    if (changes.slot !== undefined) row.slot = changes.slot;
    if (changes.payoutReceivedAt !== undefined) row.payout_received_at = changes.payoutReceivedAt;
    if (changes.exitedAt !== undefined) row.exited_at = changes.exitedAt;
    const { error } = await supabase.from('committee_members').update(row).eq('id', id).eq('user_id', getUserId());
    if (error) throw error;
  },
  async delete(id: string) {
    const { error } = await supabase.from('committee_members').delete().eq('id', id).eq('user_id', getUserId());
    if (error) throw error;
  },
};

export const committeePaymentsDb = {
  async getAll(): Promise<CommitteePayment[]> {
    const { data, error } = await supabase
      .from('committee_payments').select('*')
      .eq('user_id', getUserId());
    if (error) throw error;
    return (data ?? []).map(mapCommitteePayment);
  },
  async add(p: CommitteePayment) {
    const { error } = await supabase.from('committee_payments').insert({
      id: p.id, committee_id: p.committeeId, user_id: getUserId(),
      member_id: p.memberId, round: p.round, paid_at: p.paidAt,
    });
    if (error) throw error;
  },
  async remove(memberId: string, round: number) {
    const { error } = await supabase
      .from('committee_payments').delete()
      .eq('user_id', getUserId()).eq('member_id', memberId).eq('round', round);
    if (error) throw error;
  },
};

function mapCommittee(r: Record<string, unknown>): Committee {
  return {
    id: r.id as string,
    name: r.name as string,
    emoji: (r.emoji as string) ?? null,
    currency: r.currency as Currency,
    contributionAmount: Number(r.contribution_amount),
    memberCount: Number(r.member_count),
    cadence: r.cadence as Committee['cadence'],
    totalRounds: Number(r.total_rounds),
    startDate: r.start_date as string,
    payoutMethod: r.payout_method as Committee['payoutMethod'],
    status: r.status as Committee['status'],
    notes: (r.notes as string) ?? '',
    drawnAt: (r.drawn_at as string) ?? null,
    drawSeed: (r.draw_seed as string) ?? null,
    drawCommitment: (r.draw_commitment as string) ?? null,
    // Always null after p2-trust-safety; kept so pre-migration mirrors map.
    shareToken: (r.share_token as string) ?? null,
    // Lifecycle columns the organiser's share card reads. `select('*')` picks
    // them up; they are simply absent (undefined → null) on an un-migrated DB,
    // which witnessLinkState() reads as "no active link".
    witnessExpiresAt: (r.witness_token_expires_at as string) ?? null,
    witnessRevokedAt: (r.witness_token_revoked_at as string) ?? null,
    witnessInitialsOnly: r.witness_initials_only === true,
    createdAt: r.created_at as string,
    updatedAt: (r.updated_at as string) ?? (r.created_at as string),
  };
}

function mapCommitteeMember(r: Record<string, unknown>): CommitteeMember {
  return {
    id: r.id as string,
    committeeId: r.committee_id as string,
    name: r.name as string,
    phone: (r.phone as string) ?? null,
    personId: (r.person_id as string) ?? null,
    slot: r.slot != null ? Number(r.slot) : null,
    isOrganizer: Boolean(r.is_organizer),
    payoutReceivedAt: (r.payout_received_at as string) ?? null,
    exitedAt: (r.exited_at as string) ?? null,
    createdAt: r.created_at as string,
  };
}

function mapCommitteePayment(r: Record<string, unknown>): CommitteePayment {
  return {
    id: r.id as string,
    committeeId: r.committee_id as string,
    memberId: r.member_id as string,
    round: Number(r.round),
    paidAt: r.paid_at as string,
  };
}

export interface ArchiveContactResult {
  success: boolean;
  reasonCode: 'ARCHIVED' | 'CONTACT_NOT_FOUND' | 'LINKED_CONTACT' | 'BALANCE_NOT_SETTLED';
  userMessage: string;
  payableAmount: Record<string, number>;
  receivableAmount: Record<string, number>;
}

// ══════════════════════════════════════
// RECURRING TRANSACTIONS (Phase 3)
// ══════════════════════════════════════
export const recurringTransactionsDb = {
  async getAll(): Promise<RecurringTransaction[]> {
    const { data, error } = await supabase
      .from('recurring_transactions').select('*')
      .eq('user_id', getUserId())
      .order('next_due_date', { ascending: true });
    if (error) throw error;
    return (data ?? []).map(mapRecurring);
  },
  async add(r: RecurringTransaction) {
    const { error } = await supabase.from('recurring_transactions').insert({
      id: r.id, user_id: getUserId(), type: r.type, amount: r.amount, currency: r.currency,
      source_account_id: r.sourceAccountId, destination_account_id: r.destinationAccountId,
      category: r.category, notes: r.notes, cadence: r.cadence, next_due_date: r.nextDueDate,
      active: r.active, label: r.label, created_at: r.createdAt,
    });
    if (error) throw error;
  },
  async update(id: string, changes: Partial<RecurringTransaction>) {
    const row: Record<string, unknown> = {};
    if (changes.type !== undefined) row.type = changes.type;
    if (changes.amount !== undefined) row.amount = changes.amount;
    if (changes.currency !== undefined) row.currency = changes.currency;
    if (changes.sourceAccountId !== undefined) row.source_account_id = changes.sourceAccountId;
    if (changes.destinationAccountId !== undefined) row.destination_account_id = changes.destinationAccountId;
    if (changes.category !== undefined) row.category = changes.category;
    if (changes.notes !== undefined) row.notes = changes.notes;
    if (changes.cadence !== undefined) row.cadence = changes.cadence;
    if (changes.nextDueDate !== undefined) row.next_due_date = changes.nextDueDate;
    if (changes.active !== undefined) row.active = changes.active;
    if (changes.label !== undefined) row.label = changes.label;
    const { error } = await supabase.from('recurring_transactions').update(row).eq('id', id).eq('user_id', getUserId());
    if (error) throw error;
  },
  // Compare-and-set due-date advance: only wins if next_due_date is still the
  // value this device expanded. A second device that already advanced makes
  // this 0-row (returns false) instead of double-advancing — the cross-device
  // half of expansion safety (the post itself is deduped by its note stamp).
  async advanceIfDue(id: string, expectedDueDate: string, nextDueDate: string): Promise<boolean> {
    const { data, error } = await supabase
      .from('recurring_transactions')
      .update({ next_due_date: nextDueDate })
      .eq('id', id)
      .eq('user_id', getUserId())
      .eq('next_due_date', expectedDueDate)
      .select('id');
    if (error) throw error;
    return (data ?? []).length > 0;
  },
  async delete(id: string) {
    const { error } = await supabase.from('recurring_transactions').delete().eq('id', id).eq('user_id', getUserId());
    if (error) throw error;
  },
};

function mapRecurring(r: Record<string, unknown>): RecurringTransaction {
  return {
    id: r.id as string,
    type: r.type as RecurringTransaction['type'],
    amount: Number(r.amount),
    currency: r.currency as Currency,
    sourceAccountId: (r.source_account_id as string) ?? null,
    destinationAccountId: (r.destination_account_id as string) ?? null,
    category: (r.category as string) ?? '',
    notes: (r.notes as string) ?? '',
    cadence: r.cadence as RecurringTransaction['cadence'],
    nextDueDate: r.next_due_date as string,
    active: r.active as boolean,
    label: (r.label as string) ?? '',
    createdAt: r.created_at as string,
  };
}

// ══════════════════════════════════════
// REMITTANCES (Phase 3)
// ══════════════════════════════════════
export const remittancesDb = {
  async getAll(): Promise<Remittance[]> {
    const { data, error } = await supabase
      .from('remittances').select('*')
      .eq('user_id', getUserId())
      .order('sent_at', { ascending: false });
    if (error) throw error;
    return (data ?? []).map(mapRemittance);
  },
  async add(r: Remittance) {
    const { error } = await supabase.from('remittances').insert({
      id: r.id, user_id: getUserId(),
      source_account_id: r.sourceAccountId, source_currency: r.sourceCurrency, source_amount: r.sourceAmount,
      destination_account_id: r.destinationAccountId, destination_currency: r.destinationCurrency,
      destination_amount: r.destinationAmount,
      channel: r.channel, fee_amount: r.feeAmount, fee_currency: r.feeCurrency,
      effective_rate: r.effectiveRate, status: r.status,
      recipient_name: r.recipientName, notes: r.notes,
      source_txn_id: r.sourceTxnId, destination_txn_id: r.destinationTxnId,
      sent_at: r.sentAt, received_at: r.receivedAt, created_at: r.createdAt,
    });
    if (error) throw error;
  },
  async update(id: string, changes: Partial<Remittance>) {
    const row: Record<string, unknown> = {};
    if (changes.status !== undefined) row.status = changes.status;
    if (changes.receivedAt !== undefined) row.received_at = changes.receivedAt;
    if (changes.notes !== undefined) row.notes = changes.notes;
    if (changes.recipientName !== undefined) row.recipient_name = changes.recipientName;
    const { error } = await supabase.from('remittances').update(row).eq('id', id).eq('user_id', getUserId());
    if (error) throw error;
  },
  async delete(id: string) {
    const { error } = await supabase.from('remittances').delete().eq('id', id).eq('user_id', getUserId());
    if (error) throw error;
  },
};

function mapRemittance(r: Record<string, unknown>): Remittance {
  return {
    id: r.id as string,
    sourceAccountId: r.source_account_id as string,
    sourceCurrency: r.source_currency as Currency,
    sourceAmount: Number(r.source_amount),
    destinationAccountId: (r.destination_account_id as string) ?? null,
    destinationCurrency: r.destination_currency as Currency,
    destinationAmount: Number(r.destination_amount),
    channel: r.channel as Remittance['channel'],
    feeAmount: Number(r.fee_amount ?? 0),
    feeCurrency: r.fee_currency as Currency,
    effectiveRate: Number(r.effective_rate),
    status: r.status as Remittance['status'],
    recipientName: (r.recipient_name as string) ?? '',
    notes: (r.notes as string) ?? '',
    sourceTxnId: (r.source_txn_id as string) ?? null,
    destinationTxnId: (r.destination_txn_id as string) ?? null,
    sentAt: r.sent_at as string,
    receivedAt: (r.received_at as string) ?? null,
    createdAt: r.created_at as string,
  };
}

// ══════════════════════════════════════
// INVESTMENTS (record-keeping tracker: markets, trades, manual prices)
// Soft-delete tables — see supabase-migration-investments.sql. Positions are
// derived client-side from trades (investmentMath.ts); no holdings table.
// ══════════════════════════════════════
export const investmentMarketsDb = {
  async getAll(): Promise<InvestmentMarket[]> {
    const { data, error } = await supabase
      .from('investment_markets').select('*')
      .eq('user_id', getUserId())
      .is('deleted_at', null)
      .order('created_at', { ascending: true });
    if (error) throw error;
    return (data ?? []).map(mapInvestmentMarket);
  },
  async add(m: InvestmentMarket) {
    const { error } = await supabase.from('investment_markets').insert({
      id: m.id, user_id: getUserId(), name: m.name, currency: m.currency,
      created_at: m.createdAt,
    });
    if (error) throw error;
  },
  async update(id: string, changes: Partial<InvestmentMarket>) {
    const row: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (changes.name !== undefined) row.name = changes.name;
    if (changes.currency !== undefined) row.currency = changes.currency;
    const { error } = await supabase.from('investment_markets').update(row).eq('id', id).eq('user_id', getUserId());
    if (error) throw error;
  },
  async delete(id: string) {
    const { error } = await supabase
      .from('investment_markets')
      .update({ deleted_at: new Date().toISOString() })
      .eq('id', id)
      .eq('user_id', getUserId());
    if (error) throw error;
  },
};

export const investmentTradesDb = {
  async getAll(): Promise<InvestmentTrade[]> {
    const { data, error } = await supabase
      .from('investment_trades').select('*')
      .eq('user_id', getUserId())
      .is('deleted_at', null)
      .order('traded_at', { ascending: false });
    if (error) throw error;
    return (data ?? []).map(mapInvestmentTrade);
  },
  // Upsert with deleted_at: null so LIFO rollback re-insertion works even if
  // a soft-deleted row with the same id lingers (transactions.add precedent).
  async add(t: InvestmentTrade) {
    const { error } = await supabase.from('investment_trades').upsert({
      id: t.id, user_id: getUserId(), market_id: t.marketId,
      symbol: t.symbol, name: t.name, kind: t.kind,
      quantity: t.quantity, price_per_unit: t.pricePerUnit, amount: t.amount,
      fees: t.fees, account_id: t.accountId, transaction_id: t.transactionId,
      traded_at: t.tradedAt, notes: t.notes, created_at: t.createdAt,
      deleted_at: null,
    });
    if (error) throw error;
  },
  async delete(id: string) {
    const { error } = await supabase
      .from('investment_trades')
      .update({ deleted_at: new Date().toISOString() })
      .eq('id', id)
      .eq('user_id', getUserId());
    if (error) throw error;
  },
};

export const investmentPricesDb = {
  async getAll(): Promise<InvestmentPrice[]> {
    const { data, error } = await supabase
      .from('investment_prices').select('*')
      .eq('user_id', getUserId())
      .is('deleted_at', null);
    if (error) throw error;
    return (data ?? []).map(mapInvestmentPrice);
  },
  // Upsert on the (user, market, symbol) unique key — one manual price per
  // ticker, updated in place.
  async upsert(p: InvestmentPrice) {
    const { error } = await supabase.from('investment_prices').upsert({
      id: p.id, user_id: getUserId(), market_id: p.marketId, symbol: p.symbol,
      price: p.price, as_of: p.asOf, created_at: p.createdAt,
      updated_at: new Date().toISOString(), deleted_at: null,
    }, { onConflict: 'user_id,market_id,symbol' });
    if (error) throw error;
  },
};

function mapInvestmentMarket(r: Record<string, unknown>): InvestmentMarket {
  return {
    id: r.id as string,
    name: r.name as string,
    currency: r.currency as Currency,
    createdAt: r.created_at as string,
    updatedAt: (r.updated_at as string) ?? (r.created_at as string),
    deletedAt: (r.deleted_at as string) ?? null,
  };
}

function mapInvestmentTrade(r: Record<string, unknown>): InvestmentTrade {
  return {
    id: r.id as string,
    marketId: r.market_id as string,
    symbol: r.symbol as string,
    name: (r.name as string) ?? '',
    kind: r.kind as InvestmentTrade['kind'],
    quantity: Number(r.quantity),
    pricePerUnit: Number(r.price_per_unit),
    amount: Number(r.amount),
    fees: Number(r.fees),
    accountId: (r.account_id as string) ?? null,
    transactionId: (r.transaction_id as string) ?? null,
    tradedAt: r.traded_at as string,
    notes: (r.notes as string) ?? '',
    createdAt: r.created_at as string,
    updatedAt: (r.updated_at as string) ?? (r.created_at as string),
    deletedAt: (r.deleted_at as string) ?? null,
  };
}

function mapInvestmentPrice(r: Record<string, unknown>): InvestmentPrice {
  return {
    id: r.id as string,
    marketId: r.market_id as string,
    symbol: r.symbol as string,
    price: Number(r.price),
    asOf: r.as_of as string,
    createdAt: r.created_at as string,
    updatedAt: (r.updated_at as string) ?? (r.created_at as string),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// APP CONFIG (audit H9 / MF-12) — remote kill switch, read before login
// ─────────────────────────────────────────────────────────────────────────────
// The one row in this gateway that is NOT user-scoped. `app_config` is a
// singleton, world-readable row (`id = 'default'`) holding the minimum client
// version the backend still supports — see supabase-migration-p1-app-config.sql
// for the schema, the RLS (SELECT to anon AND authenticated, no client writes)
// and the release policy for raising the floor.
//
// Deliberately does NOT call getUserId(): the version gate runs BEFORE the auth
// gate in src/App.tsx, so this must work with no session at all. A client too
// old to authenticate correctly against a changed schema is exactly the one we
// need to stop.

/** The `app_config` singleton, camel-cased. All fields may be null. */
export interface AppConfigRecord {
  minSupportedVersion: string | null;
  minSupportedVersionCode: number | null;
  messageEn: string | null;
  messageUr: string | null;
  updatedAt: string | null;
}

export const appConfigDb = {
  /**
   * Read the singleton config row. Returns null when the row is absent —
   * including when the migration has not been applied yet, since PostgREST
   * reports a missing table as an error the caller treats the same way
   * (fail open). Callers MUST treat both null and a thrown error as "allowed";
   * `isSupported()` in src/lib/versionGate.ts does exactly that.
   */
  async get(): Promise<AppConfigRecord | null> {
    const { data, error } = await supabase
      .from('app_config')
      .select('min_supported_version, min_supported_version_code, message_en, message_ur, updated_at')
      .eq('id', 'default')
      .maybeSingle();
    if (error) throw error;
    if (!data) return null;
    const r = data as Record<string, unknown>;
    const code = Number(r.min_supported_version_code);
    return {
      minSupportedVersion: typeof r.min_supported_version === 'string' ? r.min_supported_version : null,
      minSupportedVersionCode: Number.isFinite(code) ? code : null,
      messageEn: typeof r.message_en === 'string' ? r.message_en : null,
      messageUr: typeof r.message_ur === 'string' ? r.message_ur : null,
      updatedAt: typeof r.updated_at === 'string' ? r.updated_at : null,
    };
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// ATOMIC MONEY ENGINE — L4 pilot (audit MF-01 / O-1 / F-4)
// ─────────────────────────────────────────────────────────────────────────────
// One server-side transaction per money move, so a flaky network can no longer
// leave money half-moved. `src/lib/mutationSafety.ts:10-13` states the ceiling
// this raises: "Compensations may themselves fail (the same network outage that
// killed the forward write usually kills the inverse)."
//
// Contract, error tokens, artifact table and the Docker evidence live in
// supabase-migration-p3-atomic-transfer.sql and docs/server-side-money-engine.md.
//
// Why this section sits at the END of the file rather than inside the
// `transactionsDb` literal: several agents were editing this file concurrently
// when it was written, and an append is conflict-free. It is a namespace object
// in the same `xxxDb` shape as every other gateway above.

/** Everything `transfer_between_accounts` needs. Amounts are raw JS numbers. */
export interface AtomicTransferInput {
  /** Client-generated uuid. Doubles as the idempotency key on retry. */
  transactionId: string;
  sourceAccountId: string;
  destinationAccountId: string;
  /** Source-currency amount, exactly as it is stored on the transaction row. */
  amount: number;
  /**
   * What the caller expects to land in the destination. Cross-checked by the
   * server (0.01 tolerance), never trusted. Null = "server decides", which is
   * what a same-currency move sends.
   */
  destinationAmount: number | null;
  /** Null for same-currency, else destination-per-source (the client's shape). */
  conversionRate: number | null;
  note: string;
  category: string;
  /** ISO string. The row's created_at, so a backdated entry stays backdated. */
  createdAt: string;
  /** The compare-and-swap expectations — the locally-known balances. */
  expectedSourceBalance: number;
  expectedDestinationBalance: number;
  /**
   * Skip the insufficient-balance guard. The reversal/repair hatch only
   * (mirrors REVERSAL_NEEDS_NEGATIVE). The create path always leaves this
   * false, which is exactly what `checkBalance` does today — including for a
   * credit-card source, whose `balance` IS its available credit.
   */
  allowNegative?: boolean;
}

export interface AtomicTransferResult {
  /** True when the server recognised the id and did NOT move money again. */
  replay: boolean;
  transactionId: string;
  /** Server truth after the move — apply these, do not recompute them. */
  sourceBalance: number;
  destinationBalance: number;
  /** What actually landed. Null on a replay (the row is the record). */
  destinationAmount: number | null;
  conversionRate: number | null;
}

/**
 * A stale compare-and-swap. Carries the same `code` the account CAS already
 * throws, so `accountStore`-style refetch-and-retry-once ladders work
 * unchanged; the fresh balances ride along so a retry needs no extra fetch.
 */
export interface AtomicTransferConflict extends Error {
  code: 'BALANCE_CONFLICT';
  sourceBalance: number | null;
  destinationBalance: number | null;
}

/** The server half of `checkBalance`. `message` is the same bilingual string. */
export interface AtomicTransferInsufficient extends Error {
  code: 'INSUFFICIENT_BALANCE';
  accountName: string;
  available: number;
  requested: number;
}

/** The RPC is missing — the migration has not been applied to this project. */
export interface AtomicTransferUnavailable extends Error {
  code: 'ATOMIC_TRANSFER_UNAVAILABLE';
}

function parseRpcDetail(error: unknown): Record<string, unknown> | null {
  const detail = (error as { details?: unknown })?.details;
  if (typeof detail !== 'string') return null;
  try {
    const parsed: unknown = JSON.parse(detail);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    // DETAIL is prose on the non-money errors (SAME_ACCOUNT, …). Not a failure.
    return null;
  }
}

function numberOrNull(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// ── L4 step 2: the full-tracker loan repayment ──────────────────────────────
// supabase-migration-p3-atomic-repayment.sql. THREE tables and TWO optimistic
// locks in one transaction: the account leg, loans.remaining_amount + status,
// the covered EMI status marks, and the transactions row.
export interface AtomicRepaymentInput {
  transactionId: string;
  loanId: string;
  /**
   * The ONE account this repayment touches. Destination for a loan you GAVE
   * (money comes in), source for one you TOOK (money goes out) — the server
   * derives which from loans.type, so this is a single id either way.
   * Never null: a ledger-mode (splits_only) repayment has no account and
   * belongs to loanStore.applyRepayment, not here.
   */
  accountId: string;
  /** Loan-currency amount, exactly as it is stored on the transaction row. */
  amount: number;
  /**
   * The ACCOUNT-currency figure the client computed. Cross-checked by the
   * server (0.01 tolerance), never trusted. Note the convention is asymmetric:
   * `amount * rate` for a loan given, `amount / rate` for one taken.
   */
  accountAmount: number;
  /** Null for same-currency, else exactly what the client stamps on the row. */
  conversionRate: number | null;
  note: string;
  category: string;
  /** ISO string. The row's created_at, so a backdated entry stays backdated. */
  createdAt: string;
  /** The two compare-and-swap expectations — the locally-known values. */
  expectedAccountBalance: number;
  expectedLoanRemaining: number;
  /**
   * Instalments this repayment covers (src/lib/repaymentAtomicPlan.ts). The
   * server re-validates ownership + loan membership before marking any of
   * them, and silently skips ones already paid.
   */
  emiScheduleIds: string[];
  /**
   * Skip the insufficient-balance guard. TRUE only where the client's own
   * checkBalanceForTransaction is a no-op — i.e. splits_only mode, which
   * deliberately lets these entries make an account negative
   * (isSimpleModeBalanceBypassAllowed). Full tracker always sends false.
   */
  allowNegative?: boolean;
}

export interface AtomicRepaymentResult {
  /** True when the server recognised the id and did NOT move money again. */
  replay: boolean;
  transactionId: string;
  /** Server truth after the move — apply these, do not recompute them. */
  accountBalance: number;
  loanRemaining: number;
  loanStatus: string;
  /** Signed account movement (+ credit, − debit). The inverse negates it. */
  accountDelta: number;
  /**
   * What the LOAN actually moved. Differs from `amount` when the server clamp
   * bit (an overpayment) — compensations must give back THIS, never the
   * requested amount. Zero on a replay.
   */
  loanApplied: number;
  /** Only the instalments that genuinely flipped to paid. */
  emiMarked: string[];
  conversionRate: number | null;
}

/** A stale compare-and-swap on either the account or the loan. */
export interface AtomicRepaymentConflict extends Error {
  code: 'BALANCE_CONFLICT' | 'LOAN_REMAINING_CONFLICT';
  accountBalance: number | null;
  loanRemaining: number | null;
}

/** The loan is gone — same token and same meaning as the loan CAS. */
export interface AtomicRepaymentLoanMissing extends Error {
  code: 'LOAN_NOT_FOUND';
}

/** The RPC is missing — the migration has not been applied to this project. */
export interface AtomicRepaymentUnavailable extends Error {
  code: 'ATOMIC_REPAYMENT_UNAVAILABLE';
}

// ── L4 step 3: creating a loan (loan_given / loan_taken) ────────────────────
// supabase-migration-p3-atomic-loan-create.sql. TWO tables and up to TWO
// account legs in one transaction: the funding/receiving balance, the optional
// credit-card cash-advance balance, the loans row and the transactions row.
export interface AtomicLoanCreateInput {
  transactionId: string;
  /** The loan this row points at — a fresh uuid when creating, else existing. */
  loanId: string;
  /** True to INSERT the loan; false to attach the row to an existing one. */
  createLoan: boolean;
  /** loans.type. The server derives the balance direction from it. */
  direction: 'given' | 'taken';
  personName: string;
  personId: string | null;
  /**
   * The account that funds a loan you GIVE, or receives one you TAKE.
   * Never null: a ledger-mode (splits_only) loan has no account and belongs to
   * loanStore.createLoan, not here.
   */
  accountId: string;
  /**
   * The credit card a cash advance is drawn on — `loan_taken` only. The server
   * re-checks that it is a card and that its currency matches the receiver.
   */
  cardAccountId: string | null;
  amount: number;
  /**
   * The currency the client believes the account has. Cross-checked by the
   * server (which takes the loan currency FROM the account), never trusted.
   */
  currency: string;
  note: string;
  category: string;
  /** ISO string. The row's created_at, so a backdated entry stays backdated. */
  createdAt: string;
  /** Loan.notes — the VISIBLE half only (parseInternalNote strips the meta). */
  loanNotes: string;
  /** ISO string. trackedCreateLoan reads its own clock, separate from the row. */
  loanCreatedAt: string;
  /**
   * The instalments to create with the loan, or null when there is no plan.
   *
   * L4 step 3 addendum: this is no longer always null. When
   * VITE_ATOMIC_LOAN_CREATE is on and the user configured an instalment plan,
   * AddLoanModal / QuickEntry compute the rows with `planEmiRows`
   * (src/lib/emiPlan.ts) BEFORE the call and the server inserts them in the
   * same transaction — closing the window where a drop between
   * `processTransaction` and `emiStore.generateSchedule` orphaned a schedule
   * (migration verification query V7 is the meter). Snake_case because the
   * plpgsql reads it back with `e ->> 'installment_number'`; build it with
   * `toEmiPayload`, never by hand.
   */
  emi: Array<{ id: string; installment_number: number; due_date: string; amount: number }> | null;
  /** The compare-and-swap expectations — the locally-known balances. */
  expectedAccountBalance: number;
  expectedCardBalance: number | null;
  /**
   * Skip the insufficient-balance guard. TRUE only where the client's own
   * checkBalanceForTransaction is a no-op — i.e. splits_only mode, which
   * deliberately lets these entries make an account negative
   * (isSimpleModeBalanceBypassAllowed). Full tracker always sends false.
   */
  allowNegative?: boolean;
}

export interface AtomicLoanCreateResult {
  /** True when the server recognised the id and did NOT move money again. */
  replay: boolean;
  transactionId: string;
  loanId: string;
  /** False on a replay, and when the row attached to an existing loan. */
  loanCreated: boolean;
  /** Server truth after the move — apply these, do not recompute them. */
  accountBalance: number;
  /** Signed account movement (+ credit, − debit). The inverse negates it. */
  accountDelta: number;
  /** Null when there was no cash-advance card. */
  cardBalance: number | null;
  cardDelta: number | null;
  currency: string;
  /** The instalments the server actually inserted. Empty when emi was null. */
  emiInserted: string[];
}

/** A stale compare-and-swap on either account. Same token as the account CAS. */
export interface AtomicLoanCreateConflict extends Error {
  code: 'BALANCE_CONFLICT';
  accountId: string | null;
  accountBalance: number | null;
}

/** The loan being ATTACHED to is gone — same token as the loan CAS. */
export interface AtomicLoanCreateLoanMissing extends Error {
  code: 'LOAN_NOT_FOUND';
}

/** The RPC is missing — the migration has not been applied to this project. */
export interface AtomicLoanCreateUnavailable extends Error {
  code: 'ATOMIC_LOAN_CREATE_UNAVAILABLE';
}

/**
 * The server re-validated the instalment plan and refused it — the union of
 * EMI_PLAN_INVALID (shape / 1..N numbering), EMI_PLAN_MISMATCH (the sum rule)
 * and EMI_ID_COLLISION (an id already in the table).
 *
 * The important half is what it means, not which of the three fired: the RPC is
 * atomic, so a refusal wrote NONE of the five artifacts — no balance moved, no
 * loan exists, no row, no instalments. The message is already the user-facing
 * bilingual string; the caller must NOT retry without the plan, because that
 * would create the loan the user was told was not created.
 */
export interface AtomicLoanCreateEmiRejected extends Error {
  code: 'EMI_PLAN_REJECTED';
  /** The server's own token, for Sentry — never shown to the user. */
  serverToken: 'EMI_PLAN_INVALID' | 'EMI_PLAN_MISMATCH' | 'EMI_ID_COLLISION';
}

// ── L4 step 4a: the goal contribution ───────────────────────────────────────
// supabase-migration-p3-atomic-goal-and-card.sql. TWO tables, up to TWO account
// legs and the FIRST compare-and-swap goals.saved_amount has ever had, in one
// transaction: the source debit, the goal, the optional stored-in-account
// credit and the transactions row.
export interface AtomicGoalContributionInput {
  transactionId: string;
  goalId: string;
  /**
   * The funding account. Never null: splits_only mode has no goals at all
   * (App.tsx routes /goals away), so there is no ledger shape to express.
   */
  sourceAccountId: string;
  /** GOAL currency — exactly as it is stored on the transaction row. */
  amount: number;
  /**
   * The SOURCE-currency figure the client computed. Cross-checked by the server
   * (0.01 tolerance), never trusted. The convention is DIVIDE
   * (`amount / rate`), the opposite of the transfer branch's MULTIPLY.
   * Zero for a self-stored contribution, which moves no money at all.
   */
  sourceAmount: number;
  /** Null for same-currency AND for every self-stored contribution. */
  conversionRate: number | null;
  note: string;
  category: string;
  /** ISO string. The row's created_at, so a backdated entry stays backdated. */
  createdAt: string;
  /**
   * The goal's stored-in account, when the client found one to credit. NOT
   * authoritative — the server derives its own from goals.stored_in_account_id
   * and returns what it used, so a stale local account list is visible as a
   * disagreement rather than a failed contribution.
   */
  linkedAccountId: string | null;
  /** The three compare-and-swap expectations — the locally-known values. */
  expectedSourceBalance: number;
  expectedLinkedBalance: number | null;
  expectedSavedAmount: number;
  /**
   * Skip the insufficient-balance guard. ALWAYS false from the shipped client:
   * 'goal_contribution' is absent from isSimpleModeBalanceBypassAllowed, so the
   * branch uses the strict `checkBalance` and there is no ledger bypass to
   * reproduce. Kept for the future repair queue.
   */
  allowNegative?: boolean;
}

export interface AtomicGoalContributionResult {
  /** True when the server recognised the id and did NOT move money again. */
  replay: boolean;
  transactionId: string;
  goalId: string;
  /** Server truth after the move — apply these, do not recompute them. */
  goalSavedAmount: number;
  /**
   * What the GOAL actually moved. Differs from `amount` only if the clamp bit;
   * compensations must give back THIS. Zero on a replay.
   */
  goalApplied: number;
  sourceBalance: number;
  /** Signed account movement (− debit). Zero when self-stored. */
  sourceDelta: number;
  /** The account the server actually credited, or null. */
  linkedAccountId: string | null;
  linkedBalance: number | null;
  linkedDelta: number | null;
  currency: string;
  /** The goal is kept in the very account funding it — no balances moved. */
  selfStored: boolean;
}

/**
 * A stale compare-and-swap on the source account, the goal's stored-in account,
 * or the GOAL itself.
 *
 * The goal conflict deliberately reuses BALANCE_CONFLICT rather than inventing
 * a token: the template's rule is "reuse what the client already parses"
 * (docs/server-side-money-engine.md §6), and the branch's ladder refetches
 * accounts AND goals, which is correct for either source. Unlike a repayment,
 * the goal write is a pure `+amount` delta, so replaying against a fresh
 * expectation is always correct — no floor is needed.
 */
export interface AtomicGoalConflict extends Error {
  code: 'BALANCE_CONFLICT';
  accountId: string | null;
  accountBalance: number | null;
  goalSavedAmount: number | null;
}

/** The goal is gone — the goal twin of LOAN_NOT_FOUND. Never retried. */
export interface AtomicGoalMissing extends Error {
  code: 'GOAL_NOT_FOUND';
}

/** The RPC is missing — the migration has not been applied to this project. */
export interface AtomicGoalUnavailable extends Error {
  code: 'ATOMIC_GOAL_UNAVAILABLE';
}

// ── L4 step 4b: the credit-card story ───────────────────────────────────────
// supabase-migration-p3-atomic-goal-and-card.sql. FOUR tables in one
// transaction: the wallet debit, the card credit, every cash-advance loan the
// payment settles, the instalments it covers, and every row.
export interface AtomicCardBillLine {
  loan_id: string;
  applied: number;
  expected_remaining: number;
  emi_ids: string[];
  /** A uuid for a bill payment's ledger row; null when the MAIN row is it. */
  row_id: string | null;
  row_note: string;
}

export interface AtomicCardBillInput {
  transactionId: string;
  /**
   * 'transfer'   — a bill payment. The main row is the transfer; each plan line
   *                writes its own ledger-only repayment row (both account ids
   *                NULL), exactly as the legacy tail does.
   * 'repayment'  — a cash-advance repayment that credits the card back. The
   *                main row IS the repayment (source = wallet, destination =
   *                card) and its single line writes no second row.
   */
  rowType: 'transfer' | 'repayment';
  sourceAccountId: string;
  cardAccountId: string;
  /** The ROW's amount: source currency for a transfer, loan currency for a repayment. */
  amount: number;
  /** What the wallet loses, in SOURCE currency. Cross-checked by the server. */
  sourceAmount: number;
  /**
   * What the card gains. For a transfer: `amount × rate` (unclamped, by design
   * — src/lib/cardCredit.ts:7-9). For a repayment: clampCardCredit's `credited`,
   * which the server re-validates against the card's own headroom.
   */
  cardAmount: number;
  /** The ROW's currency. Cross-checked, never trusted. */
  currency: string;
  conversionRate: number | null;
  note: string;
  category: string;
  /** ISO string. The row's created_at, so a backdated entry stays backdated. */
  createdAt: string;
  /** The settlement plan (src/lib/cardBillAtomicPlan.ts). May be empty. */
  plan: AtomicCardBillLine[];
  expectedSourceBalance: number;
  expectedCardBalance: number;
  /**
   * Skip the insufficient-balance guard. TRUE only where the client's own
   * checkBalanceForTransaction is a no-op — a splits_only REPAYMENT. A bill
   * payment is a transfer, which uses the strict `checkBalance`, so it always
   * sends false.
   */
  allowNegative?: boolean;
}

export interface AtomicCardBillLineResult {
  loanId: string;
  /** What the loan ACTUALLY moved — the clamped figure, not the requested one. */
  applied: number;
  remaining: number;
  status: string;
  /** The loan reached zero on THIS call (drives the 'loan_settled' activity). */
  settledNow: boolean;
  personName: string;
  personId: string | null;
  currency: string;
  /** Only the instalments that genuinely flipped to paid. */
  emiMarked: string[];
  /** The ledger row the server wrote for this line, or null. */
  rowId: string | null;
}

export interface AtomicCardBillResult {
  replay: boolean;
  transactionId: string;
  rowType: string;
  /** Server truth after the move — apply these, do not recompute them. */
  sourceBalance: number;
  sourceDelta: number;
  cardBalance: number;
  cardDelta: number;
  currency: string;
  /** How many cash-advance records this payment settled. */
  settled: number;
  lines: AtomicCardBillLineResult[];
}

/** A stale compare-and-swap on either account or on any loan in the plan. */
export interface AtomicCardBillConflict extends Error {
  code: 'BALANCE_CONFLICT' | 'LOAN_REMAINING_CONFLICT';
  accountId: string | null;
  accountBalance: number | null;
  loanId: string | null;
  loanRemaining: number | null;
}

/** A loan in the plan is gone — same token and meaning as the loan CAS. */
export interface AtomicCardBillLoanMissing extends Error {
  code: 'LOAN_NOT_FOUND';
}

/**
 * The server refused the PLAN — the union of PLAN_INVALID (shape),
 * PLAN_OVER_PAYMENT (the lockstep invariant: it settles more principal than the
 * payment credited), CARD_CREDIT_OVER_LIMIT (the headroom clamp) and
 * EMI_SCHEDULE_INVALID (an instalment that belongs to another loan).
 *
 * The important half is what it means, not which fired: the RPC is atomic, so a
 * refusal wrote NOTHING — no balance moved, no loan moved, no rows. The caller
 * must NOT retry the same plan; it is wrong, not stale.
 */
export interface AtomicCardBillPlanRejected extends Error {
  code: 'CARD_BILL_PLAN_REJECTED';
  /** The server's own token, for Sentry — never shown to the user. */
  serverToken: 'PLAN_INVALID' | 'PLAN_OVER_PAYMENT' | 'CARD_CREDIT_OVER_LIMIT' | 'EMI_SCHEDULE_INVALID';
}

/** The RPC is missing — the migration has not been applied to this project. */
export interface AtomicCardBillUnavailable extends Error {
  code: 'ATOMIC_CARD_BILL_UNAVAILABLE';
}

// ── L4 step 5a: the four single-leg entries ─────────────────────────────────
// supabase-migration-p3-atomic-investments-and-single-leg.sql. ONE table and
// ONE account leg in one transaction — the balance and the transactions row.
// The narrowest window in the engine, and the most common write in the app:
// what it leaves behind is a balance that changed with nothing saying why.
export type SingleLegEntryType = 'income' | 'expense' | 'opening_balance' | 'adjustment';

export interface AtomicSingleLegInput {
  transactionId: string;
  type: SingleLegEntryType;
  /**
   * The ONE account. Never null: all four branches throw on a missing account
   * in BOTH app modes, so there is no ledger shape to express and the server
   * refuses one (ACCOUNT_NOT_FOUND).
   */
  accountId: string;
  /** The row's unsigned magnitude. For an adjustment, abs(target − balance). */
  amount: number;
  /**
   * `adjustment` only — the balance the account is set TO, which may legitimately
   * be negative for a credit card. Null for the other three, and the server
   * refuses a non-null value on them.
   */
  targetBalance: number | null;
  note: string;
  category: string;
  /** ISO string. The row's created_at, so a backdated entry stays backdated. */
  createdAt: string;
  /** The compare-and-swap expectation — the locally-known balance. */
  expectedBalance: number;
  /**
   * Skip the insufficient-balance guard. TRUE only where the client's own
   * checkBalanceForTransaction is a no-op — i.e. splits_only mode, and only for
   * 'expense' (isSimpleModeBalanceBypassAllowed). Full tracker always false,
   * and income / opening_balance / adjustment have no guard to skip at all.
   */
  allowNegative?: boolean;
}

export interface AtomicSingleLegResult {
  /** True when the server recognised the id and did NOT move money again. */
  replay: boolean;
  transactionId: string;
  type: string;
  /** Server truth after the move — apply this, do not recompute it. */
  accountBalance: number;
  /** Signed account movement (+ credit, − debit). The inverse negates it. */
  accountDelta: number;
  /**
   * What the ROW says. For an adjustment this is the magnitude the SERVER
   * derived from the locked row, which is the only figure a rollback can undo.
   */
  amount: number;
  currency: string;
}

/** A stale compare-and-swap. Same token as `apply_account_balance_delta`. */
export interface AtomicSingleLegConflict extends Error {
  code: 'BALANCE_CONFLICT';
  accountId: string | null;
  accountBalance: number | null;
}

/** The RPC is missing — the migration has not been applied to this project. */
export interface AtomicSingleLegUnavailable extends Error {
  code: 'ATOMIC_SINGLE_LEG_UNAVAILABLE';
}

// ── L4 step 5b: the investment trade ────────────────────────────────────────
// Same migration. TWO tables and one account leg in one transaction: the
// balance, the investment_trades row and the transactions row. Positions are
// REPLAYED from the trade ledger (src/lib/investmentMath.ts — "there is no
// holdings table to drift"), so losing the trade row loses the position: shares
// paid for that nobody holds, or sold shares that can be sold twice.
export interface AtomicInvestmentTradeInput {
  transactionId: string;
  /** The client-generated trade id. Stamped on both rows. */
  tradeId: string;
  kind: 'buy' | 'sell' | 'dividend';
  marketId: string;
  /** The server upper-cases and trims it, exactly as the store does. */
  symbol: string;
  /** Forced to '' by the server for a dividend (transactionStore.ts:3407). */
  companyName: string;
  quantity: number;
  pricePerUnit: number;
  /** Dividend GROSS. Zero for a buy/sell, and the server refuses anything else. */
  grossAmount: number;
  fees: number;
  /**
   * Source for a buy, destination for a sell or a dividend. Never null: a trade
   * held OUTSIDE Hisaab goes through investmentStore.recordOutsideTrade, which
   * writes no money row at all.
   */
  accountId: string;
  /** The ROW's amount, in MARKET currency. Cross-checked, never trusted. */
  amount: number;
  /**
   * What the ACCOUNT moves, in account currency. Cross-checked (0.01). The
   * convention is asymmetric and is the THIRD in this engine: a buy DIVIDES
   * (`amount / rate`), a sell and a dividend MULTIPLY (`amount × rate`).
   */
  accountAmount: number;
  conversionRate: number | null;
  note: string;
  category: string;
  /** ISO string — the money row's created_at. */
  createdAt: string;
  /** ISO string — the trade's own `traded_at`, which may be backdated. */
  tradedAt: string;
  /** The trade row's notes (separate from the money row's). */
  tradeNotes: string;
  /** ISO string — the trade row's created_at, distinct from `tradedAt`. */
  tradeCreatedAt: string;
  expectedBalance: number;
  /**
   * ALWAYS false from the shipped client: 'investment_*' is absent from
   * isSimpleModeBalanceBypassAllowed, so the branch uses the strict
   * `checkBalance`. Kept for the future repair queue.
   */
  allowNegative?: boolean;
}

export interface AtomicInvestmentTradeResult {
  replay: boolean;
  transactionId: string;
  /**
   * The trade the server stored. On a REPLAY this is the id the FIRST call
   * minted, not the one this retry generated — adopt this, never the local one,
   * or a retry leaves an orphan in the mirror.
   */
  tradeId: string;
  kind: string;
  symbol: string;
  accountBalance: number;
  /** Signed account movement (+ credit, − debit). The inverse negates it. */
  accountDelta: number;
  amount: number;
  currency: string;
  conversionRate: number | null;
}

/** A stale compare-and-swap. Same token as `apply_account_balance_delta`. */
export interface AtomicInvestmentConflict extends Error {
  code: 'BALANCE_CONFLICT';
  accountId: string | null;
  accountBalance: number | null;
}

/**
 * The server re-validated the trade and refused it — the union of
 * INSUFFICIENT_HOLDINGS (the oversell replay), INVALID_TRADE
 * (validateTradeInput), TRADE_AMOUNT_MISMATCH / ACCOUNT_AMOUNT_MISMATCH (the
 * two halves derived different money) and TRADE_ID_COLLISION.
 *
 * The important half is what it means, not which fired: the RPC is atomic, so a
 * refusal wrote NONE of the three artifacts — no balance moved, no trade, no
 * row. Never retried: the trade is wrong, not stale.
 */
export interface AtomicInvestmentRejected extends Error {
  code: 'TRADE_REJECTED';
  /** The server's own token, for Sentry — never shown to the user. */
  serverToken:
    | 'INSUFFICIENT_HOLDINGS' | 'INVALID_TRADE' | 'INVALID_KIND' | 'INVALID_SYMBOL'
    | 'TRADE_AMOUNT_MISMATCH' | 'ACCOUNT_AMOUNT_MISMATCH' | 'TRADE_ID_COLLISION'
    | 'MARKET_NOT_FOUND';
  /** INSUFFICIENT_HOLDINGS only — what the timeline says is really held. */
  held: number | null;
  attempted: number | null;
}

/** The RPC is missing — the migration has not been applied to this project. */
export interface AtomicInvestmentUnavailable extends Error {
  code: 'ATOMIC_INVEST_UNAVAILABLE';
}

// ── L4 step 5c: the goal compensation's own compare-and-swap ────────────────
// Same migration, doc §23 item 6. The goal twin of apply_loan_remaining_delta.
export interface AtomicGoalSavedDeltaResult {
  goalId: string;
  goalSavedAmount: number;
  /** What the goal ACTUALLY moved — the clamped figure, not the requested one. */
  goalApplied: number;
}

export const atomicMoneyDb = {
  /**
   * The whole account→account transfer — both balance legs AND the
   * transactions row — in ONE Postgres transaction.
   *
   * Idempotent on `transactionId`: a retry after a dropped reply returns
   * `{ replay: true }` with the current balances instead of moving money twice.
   *
   * Throws, with a `code` the caller can branch on:
   *   BALANCE_CONFLICT             — refetch and retry once (accountStore ladder)
   *   INSUFFICIENT_BALANCE         — message is already the user-facing string
   *   ATOMIC_TRANSFER_UNAVAILABLE  — supabase-migration-p3-atomic-transfer.sql
   *                                  is not applied; the caller must fall back
   *                                  to the legacy two-leg path
   * Anything else is rethrown untouched.
   */
  async transferAtomic(input: AtomicTransferInput): Promise<AtomicTransferResult> {
    const { data, error } = await supabase.rpc('transfer_between_accounts', {
      p_transaction_id: input.transactionId,
      p_source_account_id: input.sourceAccountId,
      p_destination_account_id: input.destinationAccountId,
      p_amount: input.amount,
      p_destination_amount: input.destinationAmount,
      p_conversion_rate: input.conversionRate,
      p_note: input.note,
      p_category: input.category,
      p_date: input.createdAt,
      p_expected_source_balance: input.expectedSourceBalance,
      p_expected_destination_balance: input.expectedDestinationBalance,
      p_allow_negative: input.allowNegative === true,
    });

    if (error) {
      const message = (error as { message?: string })?.message ?? '';
      const detail = parseRpcDetail(error);

      if (message.includes('BALANCE_CONFLICT')) {
        const conflict = new Error('BALANCE_CONFLICT') as AtomicTransferConflict;
        conflict.code = 'BALANCE_CONFLICT';
        conflict.sourceBalance = numberOrNull(detail?.source_balance);
        conflict.destinationBalance = numberOrNull(detail?.destination_balance);
        throw conflict;
      }

      if (message.includes('INSUFFICIENT_BALANCE')) {
        // Rebuild the EXACT string checkBalance produces today
        // (src/stores/transactionStore.ts:195-204) so the toast the user sees
        // is byte-identical in both languages whichever path raised it.
        const accountName = typeof detail?.account_name === 'string' ? detail.account_name : '';
        const available = numberOrNull(detail?.available) ?? 0;
        const requested = numberOrNull(detail?.requested) ?? 0;
        const err = new Error(
          tStatic('err_insufficient')
            .replace('{account}', accountName)
            .replace('{available}', available.toLocaleString())
            .replace('{amount}', requested.toLocaleString()),
        ) as AtomicTransferInsufficient;
        err.code = 'INSUFFICIENT_BALANCE';
        err.accountName = accountName;
        err.available = available;
        err.requested = requested;
        throw err;
      }

      // PGRST202 = "function not found in the schema cache". The flag was
      // switched on before the migration was applied — say so, loudly.
      if ((error as { code?: string })?.code === 'PGRST202' || message.includes('transfer_between_accounts')) {
        const err = new Error(
          'transfer_between_accounts is not available — apply supabase-migration-p3-atomic-transfer.sql or unset VITE_ATOMIC_TRANSFER.',
        ) as AtomicTransferUnavailable;
        err.code = 'ATOMIC_TRANSFER_UNAVAILABLE';
        throw err;
      }

      throw error;
    }

    const row = (data ?? {}) as Record<string, unknown>;
    const sourceBalance = numberOrNull(row.source_balance);
    const destinationBalance = numberOrNull(row.destination_balance);
    if (sourceBalance === null || destinationBalance === null) {
      // A success reply we cannot read is not a success: the caller would
      // write nonsense into the balance store.
      throw new Error('transfer_between_accounts returned no balances');
    }

    return {
      replay: row.replay === true,
      transactionId: typeof row.transaction_id === 'string' ? row.transaction_id : input.transactionId,
      sourceBalance,
      destinationBalance,
      destinationAmount: numberOrNull(row.destination_amount),
      conversionRate: numberOrNull(row.conversion_rate),
    };
  },

  /**
   * The whole full-tracker loan repayment — the account leg, the loan
   * remaining + status leg, the covered EMI marks AND the transactions row —
   * in ONE Postgres transaction (`record_loan_repayment`).
   *
   * This is the branch where a dropped connection used to be worst: the
   * account CAS and the loan CAS are separate round-trips, so a timeout
   * between them left a moved balance, an unchanged loan and NO record of
   * either — the full-tracker form of the 2026-07-18 "vanished payment
   * records" incident (tasks/lessons.md:6-13).
   *
   * Idempotent on `transactionId`: a retry after a dropped reply returns
   * `{ replay: true }` with the current figures instead of paying twice.
   *
   * Throws, with a `code` the caller can branch on:
   *   BALANCE_CONFLICT             — refetch and retry once (accountStore ladder)
   *   LOAN_REMAINING_CONFLICT      — refetch and retry once, BUT only when the
   *                                  fresh remaining still covers the payment
   *                                  (src/lib/repaymentAtomicPlan.ts)
   *   LOAN_NOT_FOUND               — never retried; the loan is gone
   *   INSUFFICIENT_BALANCE         — message is already the user-facing string
   *   ATOMIC_REPAYMENT_UNAVAILABLE — supabase-migration-p3-atomic-repayment.sql
   *                                  is not applied; unset the flag
   * Anything else is rethrown untouched.
   */
  async repaymentAtomic(input: AtomicRepaymentInput): Promise<AtomicRepaymentResult> {
    const { data, error } = await supabase.rpc('record_loan_repayment', {
      p_transaction_id: input.transactionId,
      p_loan_id: input.loanId,
      p_account_id: input.accountId,
      p_amount: input.amount,
      p_account_amount: input.accountAmount,
      p_conversion_rate: input.conversionRate,
      p_note: input.note,
      p_category: input.category,
      p_date: input.createdAt,
      p_expected_account_balance: input.expectedAccountBalance,
      p_expected_loan_remaining: input.expectedLoanRemaining,
      p_emi_schedule_ids: input.emiScheduleIds,
      p_allow_negative: input.allowNegative === true,
    });

    if (error) {
      const message = (error as { message?: string })?.message ?? '';
      const detail = parseRpcDetail(error);

      // Both conflict tokens are byte-identical to the ones
      // apply_account_balance_delta and apply_loan_remaining_delta already
      // raise, so nothing downstream needs a new branch.
      for (const code of ['BALANCE_CONFLICT', 'LOAN_REMAINING_CONFLICT'] as const) {
        if (message.includes(code)) {
          const conflict = new Error(code) as AtomicRepaymentConflict;
          conflict.code = code;
          conflict.accountBalance = numberOrNull(detail?.account_balance);
          conflict.loanRemaining = numberOrNull(detail?.loan_remaining);
          throw conflict;
        }
      }

      if (message.includes('LOAN_NOT_FOUND')) {
        const err = new Error(tStatic('err_loan_gone')) as AtomicRepaymentLoanMissing;
        err.code = 'LOAN_NOT_FOUND';
        throw err;
      }

      if (message.includes('INSUFFICIENT_BALANCE')) {
        // Rebuild the EXACT string checkBalance produces today
        // (src/stores/transactionStore.ts:200-209) so the toast is
        // byte-identical in both languages whichever path raised it.
        const accountName = typeof detail?.account_name === 'string' ? detail.account_name : '';
        const available = numberOrNull(detail?.available) ?? 0;
        const requested = numberOrNull(detail?.requested) ?? 0;
        const err = new Error(
          tStatic('err_insufficient')
            .replace('{account}', accountName)
            .replace('{available}', available.toLocaleString())
            .replace('{amount}', requested.toLocaleString()),
        ) as AtomicTransferInsufficient;
        err.code = 'INSUFFICIENT_BALANCE';
        err.accountName = accountName;
        err.available = available;
        err.requested = requested;
        throw err;
      }

      // PGRST202 = "function not found in the schema cache". The flag was
      // switched on before the migration was applied — say so, loudly.
      if ((error as { code?: string })?.code === 'PGRST202' || message.includes('record_loan_repayment')) {
        const err = new Error(
          'record_loan_repayment is not available — apply supabase-migration-p3-atomic-repayment.sql or unset VITE_ATOMIC_REPAYMENT.',
        ) as AtomicRepaymentUnavailable;
        err.code = 'ATOMIC_REPAYMENT_UNAVAILABLE';
        throw err;
      }

      throw error;
    }

    const row = (data ?? {}) as Record<string, unknown>;
    const accountBalance = numberOrNull(row.account_balance);
    const loanRemaining = numberOrNull(row.loan_remaining);
    if (accountBalance === null || loanRemaining === null) {
      // A success reply we cannot read is not a success: the caller would
      // write nonsense into the balance and the loan.
      throw new Error('record_loan_repayment returned no balances');
    }

    return {
      replay: row.replay === true,
      transactionId: typeof row.transaction_id === 'string' ? row.transaction_id : input.transactionId,
      accountBalance,
      loanRemaining,
      loanStatus: typeof row.loan_status === 'string' ? row.loan_status : '',
      accountDelta: numberOrNull(row.account_delta) ?? 0,
      loanApplied: numberOrNull(row.loan_applied) ?? 0,
      emiMarked: Array.isArray(row.emi_marked)
        ? (row.emi_marked as unknown[]).filter((id): id is string => typeof id === 'string')
        : [],
      conversionRate: numberOrNull(row.conversion_rate),
    };
  },

  /**
   * The whole full-tracker loan CREATION — the funding/receiving account leg,
   * the optional credit-card cash-advance leg, the loans row and the
   * transactions row — in ONE Postgres transaction (`create_loan_with_leg`).
   *
   * The failure this closes is the ugliest of the three: today a `loan_given`
   * debits the wallet, and if the `loans` INSERT then times out there is no
   * loan saying who owes the money and no row saying it ever left. A
   * `loan_taken` cash advance is worse still — the card's available credit
   * drops and the cash arrives nowhere.
   *
   * Idempotent on `transactionId`: a retry after a dropped reply returns
   * `{ replay: true }` with the current balances instead of lending twice.
   *
   * Throws, with a `code` the caller can branch on:
   *   BALANCE_CONFLICT               — refetch and retry once (accountStore ladder)
   *   LOAN_NOT_FOUND                 — never retried; the attached loan is gone
   *   INSUFFICIENT_BALANCE           — message is already the user-facing string
   *   EMI_PLAN_REJECTED              — the schedule was refused; NOTHING was
   *                                    written, message is user-facing, never retry
   *   ATOMIC_LOAN_CREATE_UNAVAILABLE — supabase-migration-p3-atomic-loan-create.sql
   *                                    is not applied; unset the flag
   * Anything else is rethrown untouched.
   */
  async loanCreateAtomic(input: AtomicLoanCreateInput): Promise<AtomicLoanCreateResult> {
    const { data, error } = await supabase.rpc('create_loan_with_leg', {
      p_transaction_id: input.transactionId,
      p_loan_id: input.loanId,
      p_create_loan: input.createLoan,
      p_type: input.direction,
      p_person_name: input.personName,
      p_person_id: input.personId,
      p_account_id: input.accountId,
      p_card_account_id: input.cardAccountId,
      p_amount: input.amount,
      p_currency: input.currency,
      // Always null: a created loan takes the funding account's currency, so
      // there is no second currency to convert between. The server REFUSES a
      // non-null rate (CONVERSION_RATE_NOT_APPLICABLE) rather than writing one.
      p_conversion_rate: null,
      p_note: input.note,
      p_category: input.category,
      p_date: input.createdAt,
      p_loan_notes: input.loanNotes,
      p_loan_created_at: input.loanCreatedAt,
      p_emi: input.emi,
      p_expected_account_balance: input.expectedAccountBalance,
      p_expected_card_balance: input.expectedCardBalance,
      p_allow_negative: input.allowNegative === true,
    });

    if (error) {
      const message = (error as { message?: string })?.message ?? '';
      const detail = parseRpcDetail(error);

      // Byte-identical to the token apply_account_balance_delta already
      // raises, so nothing downstream needs a new branch.
      if (message.includes('BALANCE_CONFLICT')) {
        const conflict = new Error('BALANCE_CONFLICT') as AtomicLoanCreateConflict;
        conflict.code = 'BALANCE_CONFLICT';
        conflict.accountId = typeof detail?.account_id === 'string' ? detail.account_id : null;
        conflict.accountBalance = numberOrNull(detail?.account_balance);
        throw conflict;
      }

      if (message.includes('LOAN_NOT_FOUND')) {
        const err = new Error(tStatic('err_loan_gone')) as AtomicLoanCreateLoanMissing;
        err.code = 'LOAN_NOT_FOUND';
        throw err;
      }

      // The instalment plan was refused. The client validated the same rules
      // before calling (loanCreateAtomicPlan.emiPlanProblem), so reaching here
      // means the two halves disagree OR an id raced into the table — either
      // way the whole creation was refused as one, and the user must be told
      // that nothing was saved rather than shown a raw Postgres string.
      for (const token of ['EMI_PLAN_MISMATCH', 'EMI_PLAN_INVALID', 'EMI_ID_COLLISION'] as const) {
        if (message.includes(token)) {
          const err = new Error(tStatic('err_emi_plan_rejected')) as AtomicLoanCreateEmiRejected;
          err.code = 'EMI_PLAN_REJECTED';
          err.serverToken = token;
          throw err;
        }
      }

      if (message.includes('INSUFFICIENT_BALANCE')) {
        // Rebuild the EXACT string checkBalance produces today
        // (src/stores/transactionStore.ts:206-215) so the toast is
        // byte-identical in both languages whichever path raised it.
        const accountName = typeof detail?.account_name === 'string' ? detail.account_name : '';
        const available = numberOrNull(detail?.available) ?? 0;
        const requested = numberOrNull(detail?.requested) ?? 0;
        const err = new Error(
          tStatic('err_insufficient')
            .replace('{account}', accountName)
            .replace('{available}', available.toLocaleString())
            .replace('{amount}', requested.toLocaleString()),
        ) as AtomicTransferInsufficient;
        err.code = 'INSUFFICIENT_BALANCE';
        err.accountName = accountName;
        err.available = available;
        err.requested = requested;
        throw err;
      }

      // PGRST202 = "function not found in the schema cache". The flag was
      // switched on before the migration was applied — say so, loudly.
      if ((error as { code?: string })?.code === 'PGRST202' || message.includes('create_loan_with_leg')) {
        const err = new Error(
          'create_loan_with_leg is not available — apply supabase-migration-p3-atomic-loan-create.sql or unset VITE_ATOMIC_LOAN_CREATE.',
        ) as AtomicLoanCreateUnavailable;
        err.code = 'ATOMIC_LOAN_CREATE_UNAVAILABLE';
        throw err;
      }

      throw error;
    }

    const row = (data ?? {}) as Record<string, unknown>;
    const accountBalance = numberOrNull(row.account_balance);
    if (accountBalance === null) {
      // A success reply we cannot read is not a success: the caller would
      // write nonsense into the balance store.
      throw new Error('create_loan_with_leg returned no balance');
    }

    return {
      replay: row.replay === true,
      transactionId: typeof row.transaction_id === 'string' ? row.transaction_id : input.transactionId,
      loanId: typeof row.loan_id === 'string' ? row.loan_id : input.loanId,
      loanCreated: row.loan_created === true,
      accountBalance,
      accountDelta: numberOrNull(row.account_delta) ?? 0,
      cardBalance: numberOrNull(row.card_balance),
      cardDelta: numberOrNull(row.card_delta),
      currency: typeof row.currency === 'string' ? row.currency : input.currency,
      emiInserted: Array.isArray(row.emi_inserted)
        ? (row.emi_inserted as unknown[]).filter((id): id is string => typeof id === 'string')
        : [],
    };
  },

  /**
   * The whole goal contribution — the source account leg, goals.saved_amount,
   * the optional stored-in-account credit leg AND the transactions row — in ONE
   * Postgres transaction (`contribute_to_goal`).
   *
   * This branch's client compensation is the one the pilot's order table called
   * out as the worst shape in the switch (docs/server-side-money-engine.md §6,
   * branch 3): `trackedAddContribution` restores the exact prior savedAmount,
   * so a rollback on THIS device silently erases a contribution made on
   * another. The RPC replaces it with a compare-and-swap and a delta.
   *
   * Idempotent on `transactionId`: a retry after a dropped reply returns
   * `{ replay: true }` with the current figures instead of contributing twice.
   *
   * Throws, with a `code` the caller can branch on:
   *   BALANCE_CONFLICT       — the source account, the stored-in account OR the
   *                            goal was stale. Refetch accounts AND goals,
   *                            retry once. A goal conflict is safe to replay:
   *                            the write is a pure delta, so no floor applies.
   *   GOAL_NOT_FOUND         — never retried; the goal is gone
   *   INSUFFICIENT_BALANCE   — message is already the user-facing string
   *   ATOMIC_GOAL_UNAVAILABLE— supabase-migration-p3-atomic-goal-and-card.sql
   *                            is not applied; unset the flag
   * Anything else is rethrown untouched.
   */
  async goalContributeAtomic(
    input: AtomicGoalContributionInput,
  ): Promise<AtomicGoalContributionResult> {
    const { data, error } = await supabase.rpc('contribute_to_goal', {
      p_transaction_id: input.transactionId,
      p_goal_id: input.goalId,
      p_source_account_id: input.sourceAccountId,
      p_amount: input.amount,
      p_source_amount: input.sourceAmount,
      p_conversion_rate: input.conversionRate,
      p_note: input.note,
      p_category: input.category,
      p_date: input.createdAt,
      p_linked_account_id: input.linkedAccountId,
      p_expected_source_balance: input.expectedSourceBalance,
      p_expected_linked_balance: input.expectedLinkedBalance,
      p_expected_saved_amount: input.expectedSavedAmount,
      p_allow_negative: input.allowNegative === true,
    });

    if (error) {
      const message = (error as { message?: string })?.message ?? '';
      const detail = parseRpcDetail(error);

      // Byte-identical to the token apply_account_balance_delta already raises,
      // so nothing downstream needs a new branch. The DETAIL says which side.
      if (message.includes('BALANCE_CONFLICT')) {
        const conflict = new Error('BALANCE_CONFLICT') as AtomicGoalConflict;
        conflict.code = 'BALANCE_CONFLICT';
        conflict.accountId = typeof detail?.account_id === 'string' ? detail.account_id : null;
        conflict.accountBalance = numberOrNull(detail?.account_balance);
        conflict.goalSavedAmount = numberOrNull(detail?.goal_saved_amount);
        throw conflict;
      }

      if (message.includes('GOAL_NOT_FOUND')) {
        const err = new Error(tStatic('err_goal_gone')) as AtomicGoalMissing;
        err.code = 'GOAL_NOT_FOUND';
        throw err;
      }

      if (message.includes('INSUFFICIENT_BALANCE')) {
        // Rebuild the EXACT string checkBalance produces today so the toast is
        // byte-identical in both languages whichever path raised it.
        const accountName = typeof detail?.account_name === 'string' ? detail.account_name : '';
        const available = numberOrNull(detail?.available) ?? 0;
        const requested = numberOrNull(detail?.requested) ?? 0;
        const err = new Error(
          tStatic('err_insufficient')
            .replace('{account}', accountName)
            .replace('{available}', available.toLocaleString())
            .replace('{amount}', requested.toLocaleString()),
        ) as AtomicTransferInsufficient;
        err.code = 'INSUFFICIENT_BALANCE';
        err.accountName = accountName;
        err.available = available;
        err.requested = requested;
        throw err;
      }

      // PGRST202 = "function not found in the schema cache". The flag was
      // switched on before the migration was applied — say so, loudly.
      if ((error as { code?: string })?.code === 'PGRST202' || message.includes('contribute_to_goal')) {
        const err = new Error(
          'contribute_to_goal is not available — apply supabase-migration-p3-atomic-goal-and-card.sql or unset VITE_ATOMIC_GOAL.',
        ) as AtomicGoalUnavailable;
        err.code = 'ATOMIC_GOAL_UNAVAILABLE';
        throw err;
      }

      throw error;
    }

    const row = (data ?? {}) as Record<string, unknown>;
    const goalSavedAmount = numberOrNull(row.goal_saved_amount);
    const sourceBalance = numberOrNull(row.source_balance);
    if (goalSavedAmount === null || sourceBalance === null) {
      // A success reply we cannot read is not a success: the caller would write
      // nonsense into the goal and the balance store.
      throw new Error('contribute_to_goal returned no figures');
    }

    return {
      replay: row.replay === true,
      transactionId: typeof row.transaction_id === 'string' ? row.transaction_id : input.transactionId,
      goalId: typeof row.goal_id === 'string' ? row.goal_id : input.goalId,
      goalSavedAmount,
      goalApplied: numberOrNull(row.goal_applied) ?? 0,
      sourceBalance,
      sourceDelta: numberOrNull(row.source_delta) ?? 0,
      linkedAccountId: typeof row.linked_account_id === 'string' ? row.linked_account_id : null,
      linkedBalance: numberOrNull(row.linked_balance),
      linkedDelta: numberOrNull(row.linked_delta),
      currency: typeof row.currency === 'string' ? row.currency : '',
      selfStored: row.self_stored === true,
    };
  },

  /**
   * The whole credit-card story — the wallet debit, the card credit, every
   * cash-advance loan the payment settles (remaining + status), every
   * instalment it covers, and every row — in ONE Postgres transaction
   * (`pay_card_bill`).
   *
   * Two user actions, one shape, selected by `rowType`:
   *   'transfer'  — paying a card bill. Today this is the LARGEST flow in the
   *                 switch: 2 balances + 1 row + N × (loan CAS + M instalment
   *                 writes + 1 ledger row). A drop partway leaves a paid bill
   *                 whose loans still say the money is owed, so the app asks
   *                 the user to pay the same debt twice.
   *   'repayment' — repaying a cash-advance loan, which credits the card back.
   *                 This is the case supabase-migration-p3-atomic-repayment.sql
   *                 deliberately left on the legacy path (§8.1), because
   *                 `record_loan_repayment` takes exactly one account id.
   *
   * The ALLOCATION stays in TypeScript (src/lib/cardStatement.ts,
   * src/lib/cardCredit.ts, src/lib/cardBillAtomicPlan.ts): the client plans, the
   * server applies AND re-validates.
   *
   * Idempotent on `transactionId`, and every ledger `row_id` must be free.
   *
   * Throws, with a `code` the caller can branch on:
   *   BALANCE_CONFLICT          — refetch and retry once (accountStore ladder)
   *   LOAN_REMAINING_CONFLICT   — refetch, RE-PLAN, retry once — but only when
   *                               the fresh remaining still covers the payment
   *                               (src/lib/repaymentAtomicPlan.ts's floor)
   *   LOAN_NOT_FOUND            — never retried; a loan in the plan is gone
   *   CARD_BILL_PLAN_REJECTED   — the plan is WRONG, not stale; never retried
   *   INSUFFICIENT_BALANCE      — message is already the user-facing string
   *   ATOMIC_CARD_BILL_UNAVAILABLE — the migration is not applied; unset the flag
   * Anything else is rethrown untouched.
   */
  async payCardBillAtomic(input: AtomicCardBillInput): Promise<AtomicCardBillResult> {
    const { data, error } = await supabase.rpc('pay_card_bill', {
      p_transaction_id: input.transactionId,
      p_row_type: input.rowType,
      p_source_account_id: input.sourceAccountId,
      p_card_account_id: input.cardAccountId,
      p_amount: input.amount,
      p_source_amount: input.sourceAmount,
      p_card_amount: input.cardAmount,
      p_currency: input.currency,
      p_conversion_rate: input.conversionRate,
      p_note: input.note,
      p_category: input.category,
      p_date: input.createdAt,
      p_plan: input.plan,
      p_expected_source_balance: input.expectedSourceBalance,
      p_expected_card_balance: input.expectedCardBalance,
      p_allow_negative: input.allowNegative === true,
    });

    if (error) {
      const message = (error as { message?: string })?.message ?? '';
      const detail = parseRpcDetail(error);

      // Both conflict tokens are byte-identical to the ones
      // apply_account_balance_delta and apply_loan_remaining_delta already
      // raise, so nothing downstream needs a new branch.
      for (const code of ['BALANCE_CONFLICT', 'LOAN_REMAINING_CONFLICT'] as const) {
        if (message.includes(code)) {
          const conflict = new Error(code) as AtomicCardBillConflict;
          conflict.code = code;
          conflict.accountId = typeof detail?.account_id === 'string' ? detail.account_id : null;
          conflict.accountBalance = numberOrNull(detail?.account_balance);
          conflict.loanId = typeof detail?.loan_id === 'string' ? detail.loan_id : null;
          conflict.loanRemaining = numberOrNull(detail?.loan_remaining);
          throw conflict;
        }
      }

      if (message.includes('LOAN_NOT_FOUND')) {
        const err = new Error(tStatic('err_loan_gone')) as AtomicCardBillLoanMissing;
        err.code = 'LOAN_NOT_FOUND';
        throw err;
      }

      for (const token of ['PLAN_OVER_PAYMENT', 'CARD_CREDIT_OVER_LIMIT', 'EMI_SCHEDULE_INVALID', 'PLAN_INVALID'] as const) {
        if (message.includes(token)) {
          const err = new Error(tStatic('err_card_bill_plan')) as AtomicCardBillPlanRejected;
          err.code = 'CARD_BILL_PLAN_REJECTED';
          err.serverToken = token;
          throw err;
        }
      }

      if (message.includes('INSUFFICIENT_BALANCE')) {
        const accountName = typeof detail?.account_name === 'string' ? detail.account_name : '';
        const available = numberOrNull(detail?.available) ?? 0;
        const requested = numberOrNull(detail?.requested) ?? 0;
        const err = new Error(
          tStatic('err_insufficient')
            .replace('{account}', accountName)
            .replace('{available}', available.toLocaleString())
            .replace('{amount}', requested.toLocaleString()),
        ) as AtomicTransferInsufficient;
        err.code = 'INSUFFICIENT_BALANCE';
        err.accountName = accountName;
        err.available = available;
        err.requested = requested;
        throw err;
      }

      if ((error as { code?: string })?.code === 'PGRST202' || message.includes('pay_card_bill')) {
        const err = new Error(
          'pay_card_bill is not available — apply supabase-migration-p3-atomic-goal-and-card.sql or unset VITE_ATOMIC_CARD_BILL.',
        ) as AtomicCardBillUnavailable;
        err.code = 'ATOMIC_CARD_BILL_UNAVAILABLE';
        throw err;
      }

      throw error;
    }

    const row = (data ?? {}) as Record<string, unknown>;
    const sourceBalance = numberOrNull(row.source_balance);
    const cardBalance = numberOrNull(row.card_balance);
    if (sourceBalance === null || cardBalance === null) {
      throw new Error('pay_card_bill returned no balances');
    }

    const rawLines = Array.isArray(row.lines) ? (row.lines as unknown[]) : [];
    return {
      replay: row.replay === true,
      transactionId: typeof row.transaction_id === 'string' ? row.transaction_id : input.transactionId,
      rowType: typeof row.row_type === 'string' ? row.row_type : input.rowType,
      sourceBalance,
      sourceDelta: numberOrNull(row.source_delta) ?? 0,
      cardBalance,
      cardDelta: numberOrNull(row.card_delta) ?? 0,
      currency: typeof row.currency === 'string' ? row.currency : input.currency,
      settled: numberOrNull(row.settled) ?? 0,
      lines: rawLines.map((raw) => {
        const l = (raw ?? {}) as Record<string, unknown>;
        return {
          loanId: typeof l.loan_id === 'string' ? l.loan_id : '',
          applied: numberOrNull(l.applied) ?? 0,
          remaining: numberOrNull(l.remaining) ?? 0,
          status: typeof l.status === 'string' ? l.status : '',
          settledNow: l.settled_now === true,
          personName: typeof l.person_name === 'string' ? l.person_name : '',
          personId: typeof l.person_id === 'string' ? l.person_id : null,
          currency: typeof l.currency === 'string' ? l.currency : input.currency,
          emiMarked: Array.isArray(l.emi_marked)
            ? (l.emi_marked as unknown[]).filter((id): id is string => typeof id === 'string')
            : [],
          rowId: typeof l.row_id === 'string' ? l.row_id : null,
        };
      }),
    };
  },

  /**
   * The four single-leg entries — income, expense, opening_balance and
   * adjustment — as ONE Postgres transaction (`record_single_leg_entry`): the
   * balance compare-and-swap AND the transactions row.
   *
   * This is the narrowest window in the engine and the one the audit did not
   * rank, because it cannot leave money half-moved BETWEEN two places. What it
   * can leave is a balance that changed with NO row saying why — and the user's
   * own repair for that (`adjustment`) is one of the four branches with the
   * same window.
   *
   * The adjustment case is a real tightening, not just a port: the target
   * balance is SET inside the row lock, and the |delta| is derived there rather
   * than from a snapshot that may already be stale.
   *
   * Idempotent on `transactionId`.
   *
   * Throws, with a `code` the caller can branch on:
   *   BALANCE_CONFLICT               — refetch and retry once (accountStore ladder)
   *   INSUFFICIENT_BALANCE           — message is already the user-facing string
   *   ATOMIC_SINGLE_LEG_UNAVAILABLE  — the migration is not applied; unset the flag
   * Anything else is rethrown untouched — including NOTHING_TO_CORRECT, which is
   * the adjustment branch's own guard and whose message the branch already owns.
   */
  async singleLegAtomic(input: AtomicSingleLegInput): Promise<AtomicSingleLegResult> {
    const { data, error } = await supabase.rpc('record_single_leg_entry', {
      p_transaction_id: input.transactionId,
      p_type: input.type,
      p_account_id: input.accountId,
      p_amount: input.amount,
      p_target_balance: input.targetBalance,
      p_note: input.note,
      p_category: input.category,
      p_date: input.createdAt,
      p_expected_balance: input.expectedBalance,
      p_allow_negative: input.allowNegative === true,
    });

    if (error) {
      const message = (error as { message?: string })?.message ?? '';
      const detail = parseRpcDetail(error);

      if (message.includes('BALANCE_CONFLICT')) {
        const conflict = new Error('BALANCE_CONFLICT') as AtomicSingleLegConflict;
        conflict.code = 'BALANCE_CONFLICT';
        conflict.accountId = typeof detail?.account_id === 'string' ? detail.account_id : null;
        conflict.accountBalance = numberOrNull(detail?.account_balance);
        throw conflict;
      }

      if (message.includes('INSUFFICIENT_BALANCE')) {
        // Rebuild the EXACT string checkBalance produces today so the toast is
        // byte-identical in both languages whichever path raised it.
        const accountName = typeof detail?.account_name === 'string' ? detail.account_name : '';
        const available = numberOrNull(detail?.available) ?? 0;
        const requested = numberOrNull(detail?.requested) ?? 0;
        const err = new Error(
          tStatic('err_insufficient')
            .replace('{account}', accountName)
            .replace('{available}', available.toLocaleString())
            .replace('{amount}', requested.toLocaleString()),
        ) as AtomicTransferInsufficient;
        err.code = 'INSUFFICIENT_BALANCE';
        err.accountName = accountName;
        err.available = available;
        err.requested = requested;
        throw err;
      }

      // PGRST202 = "function not found in the schema cache". The flag was
      // switched on before the migration was applied — say so, loudly.
      if ((error as { code?: string })?.code === 'PGRST202' || message.includes('record_single_leg_entry')) {
        const err = new Error(
          'record_single_leg_entry is not available — apply supabase-migration-p3-atomic-investments-and-single-leg.sql or unset VITE_ATOMIC_SINGLE_LEG.',
        ) as AtomicSingleLegUnavailable;
        err.code = 'ATOMIC_SINGLE_LEG_UNAVAILABLE';
        throw err;
      }

      throw error;
    }

    const row = (data ?? {}) as Record<string, unknown>;
    const accountBalance = numberOrNull(row.account_balance);
    if (accountBalance === null) {
      // A success reply we cannot read is not a success: the caller would write
      // nonsense into the balance store.
      throw new Error('record_single_leg_entry returned no balance');
    }

    return {
      replay: row.replay === true,
      transactionId: typeof row.transaction_id === 'string' ? row.transaction_id : input.transactionId,
      type: typeof row.type === 'string' ? row.type : input.type,
      accountBalance,
      accountDelta: numberOrNull(row.account_delta) ?? 0,
      amount: numberOrNull(row.amount) ?? input.amount,
      currency: typeof row.currency === 'string' ? row.currency : '',
    };
  },

  /**
   * An account-linked investment trade — the balance leg, the
   * `investment_trades` row AND the `transactions` row — in ONE Postgres
   * transaction (`record_investment_trade`).
   *
   * The failure this closes is specific to how this feature is built: positions
   * (quantity, average cost, realised P&L) are DERIVED by replaying the trade
   * ledger and are never stored, so a drop between the balance leg and the
   * trade INSERT does not corrupt a figure — it deletes the position outright.
   * A buy leaves a wallet that paid for shares nobody holds; a sell leaves
   * shares that can be sold a second time.
   *
   * The server re-derives the cash amount per kind, re-derives the account
   * movement per the asymmetric currency convention, re-runs `validateTradeInput`
   * and re-runs the FULL `simulateTimeline` oversell replay — including the
   * backdated case and the skip-already-invalid rule. It does NOT re-derive the
   * position: that stays in TypeScript, the same *plan on the client, apply on
   * the server* rule steps 3 and 4 settled.
   *
   * Idempotent on `transactionId`; a repeated `tradeId` is REFUSED rather than
   * upserted over a live trade.
   *
   * Throws, with a `code` the caller can branch on:
   *   BALANCE_CONFLICT           — refetch and retry once (accountStore ladder)
   *   TRADE_REJECTED             — the trade is WRONG, not stale; never retried.
   *                                Message is already the user-facing string.
   *   INSUFFICIENT_BALANCE       — message is already the user-facing string
   *   ATOMIC_INVEST_UNAVAILABLE  — the migration is not applied; unset the flag
   * Anything else is rethrown untouched.
   */
  async investmentTradeAtomic(
    input: AtomicInvestmentTradeInput,
  ): Promise<AtomicInvestmentTradeResult> {
    const { data, error } = await supabase.rpc('record_investment_trade', {
      p_transaction_id: input.transactionId,
      p_trade_id: input.tradeId,
      p_kind: input.kind,
      p_market_id: input.marketId,
      p_symbol: input.symbol,
      p_company_name: input.companyName,
      p_quantity: input.quantity,
      p_price_per_unit: input.pricePerUnit,
      p_gross_amount: input.grossAmount,
      p_fees: input.fees,
      p_account_id: input.accountId,
      p_amount: input.amount,
      p_account_amount: input.accountAmount,
      p_conversion_rate: input.conversionRate,
      p_note: input.note,
      p_category: input.category,
      p_date: input.createdAt,
      p_traded_at: input.tradedAt,
      p_trade_notes: input.tradeNotes,
      p_trade_created_at: input.tradeCreatedAt,
      p_expected_balance: input.expectedBalance,
      p_allow_negative: input.allowNegative === true,
    });

    if (error) {
      const message = (error as { message?: string })?.message ?? '';
      const detail = parseRpcDetail(error);

      if (message.includes('BALANCE_CONFLICT')) {
        const conflict = new Error('BALANCE_CONFLICT') as AtomicInvestmentConflict;
        conflict.code = 'BALANCE_CONFLICT';
        conflict.accountId = typeof detail?.account_id === 'string' ? detail.account_id : null;
        conflict.accountBalance = numberOrNull(detail?.account_balance);
        throw conflict;
      }

      // The trade itself was refused. The client ran the same rules before
      // calling (validateTradeInput + simulateTimeline), so reaching here means
      // the two halves disagree OR another device changed the timeline — either
      // way the whole entry was refused as one, and the user must be told that
      // nothing was saved rather than shown a raw Postgres string.
      for (const token of [
        'INSUFFICIENT_HOLDINGS', 'TRADE_AMOUNT_MISMATCH', 'ACCOUNT_AMOUNT_MISMATCH',
        'TRADE_ID_COLLISION', 'INVALID_TRADE', 'INVALID_KIND', 'INVALID_SYMBOL',
        'MARKET_NOT_FOUND',
      ] as const) {
        if (message.includes(token)) {
          const err = new Error(tStatic('err_trade_rejected')) as AtomicInvestmentRejected;
          err.code = 'TRADE_REJECTED';
          err.serverToken = token;
          err.held = numberOrNull(detail?.held);
          err.attempted = numberOrNull(detail?.attempted);
          throw err;
        }
      }

      if (message.includes('INSUFFICIENT_BALANCE')) {
        const accountName = typeof detail?.account_name === 'string' ? detail.account_name : '';
        const available = numberOrNull(detail?.available) ?? 0;
        const requested = numberOrNull(detail?.requested) ?? 0;
        const err = new Error(
          tStatic('err_insufficient')
            .replace('{account}', accountName)
            .replace('{available}', available.toLocaleString())
            .replace('{amount}', requested.toLocaleString()),
        ) as AtomicTransferInsufficient;
        err.code = 'INSUFFICIENT_BALANCE';
        err.accountName = accountName;
        err.available = available;
        err.requested = requested;
        throw err;
      }

      if ((error as { code?: string })?.code === 'PGRST202' || message.includes('record_investment_trade')) {
        const err = new Error(
          'record_investment_trade is not available — apply supabase-migration-p3-atomic-investments-and-single-leg.sql or unset VITE_ATOMIC_INVEST.',
        ) as AtomicInvestmentUnavailable;
        err.code = 'ATOMIC_INVEST_UNAVAILABLE';
        throw err;
      }

      throw error;
    }

    const row = (data ?? {}) as Record<string, unknown>;
    const accountBalance = numberOrNull(row.account_balance);
    const tradeId = typeof row.trade_id === 'string' ? row.trade_id : null;
    if (accountBalance === null || tradeId === null) {
      // A success reply we cannot read is not a success: without the trade id
      // the mirror would claim a position Postgres does not have.
      throw new Error('record_investment_trade returned no balance or no trade id');
    }

    return {
      replay: row.replay === true,
      transactionId: typeof row.transaction_id === 'string' ? row.transaction_id : input.transactionId,
      tradeId,
      kind: typeof row.kind === 'string' ? row.kind : input.kind,
      symbol: typeof row.symbol === 'string' ? row.symbol : input.symbol,
      accountBalance,
      accountDelta: numberOrNull(row.account_delta) ?? 0,
      amount: numberOrNull(row.amount) ?? input.amount,
      currency: typeof row.currency === 'string' ? row.currency : '',
      conversionRate: numberOrNull(row.conversion_rate),
    };
  },

  /**
   * A compare-and-swap on `goals.saved_amount` (`apply_goal_saved_delta`) — the
   * goal twin of `loansDb.applyRemainingDelta`.
   *
   * Step 4 gave the FORWARD goal write a CAS inside `contribute_to_goal`; the
   * inverse the mutation scope registers still went through `goalsDb.update`,
   * an unlocked read-modify-write that can clobber a contribution made on
   * another device while the rollback is in flight. This closes doc §23 item 6.
   *
   * NOT idempotent — it is a delta with no id to key on. Its only caller is a
   * compensation that runs at most once per scope, and that caller falls back
   * to the legacy unlocked write if the CAS cannot be satisfied: a rollback
   * that REFUSES to run would be strictly worse than one that races.
   *
   * Throws BALANCE_CONFLICT (the same token `contribute_to_goal` raises for a
   * stale goal) or GOAL_NOT_FOUND; anything else is rethrown untouched.
   */
  async goalSavedDelta(
    goalId: string,
    delta: number,
    expectedSaved: number,
  ): Promise<AtomicGoalSavedDeltaResult> {
    const { data, error } = await supabase.rpc('apply_goal_saved_delta', {
      p_goal_id: goalId,
      p_delta: delta,
      p_expected_saved: expectedSaved,
    });

    if (error) {
      const message = (error as { message?: string })?.message ?? '';
      const detail = parseRpcDetail(error);

      if (message.includes('BALANCE_CONFLICT')) {
        const conflict = new Error('BALANCE_CONFLICT') as AtomicGoalConflict;
        conflict.code = 'BALANCE_CONFLICT';
        conflict.accountId = null;
        conflict.accountBalance = null;
        conflict.goalSavedAmount = numberOrNull(detail?.goal_saved_amount);
        throw conflict;
      }

      if (message.includes('GOAL_NOT_FOUND')) {
        const err = new Error(tStatic('err_goal_gone')) as AtomicGoalMissing;
        err.code = 'GOAL_NOT_FOUND';
        throw err;
      }

      if ((error as { code?: string })?.code === 'PGRST202' || message.includes('apply_goal_saved_delta')) {
        const err = new Error(
          'apply_goal_saved_delta is not available — apply supabase-migration-p3-atomic-investments-and-single-leg.sql.',
        ) as AtomicGoalUnavailable;
        err.code = 'ATOMIC_GOAL_UNAVAILABLE';
        throw err;
      }

      throw error;
    }

    const row = (data ?? {}) as Record<string, unknown>;
    const saved = numberOrNull(row.goal_saved_amount);
    if (saved === null) throw new Error('apply_goal_saved_delta returned no figure');

    return {
      goalId: typeof row.goal_id === 'string' ? row.goal_id : goalId,
      goalSavedAmount: saved,
      goalApplied: numberOrNull(row.goal_applied) ?? 0,
    };
  },
};

// ════════════════════════════════════════════════════════════════════════════
// KHATA LINKS — the per-counterparty living-balance link (audit P3 / L2,
// 11-competitive-analysis O2 + G3). Backed by
// supabase-migration-p3-khata-link.sql.
//
// Three RPCs, no table access: `khata_links` is readable by its owner but
// `token_hash` is withheld by a COLUMN grant, and minting/revoking is
// SECURITY DEFINER-only. Everything below therefore goes through .rpc().
//
// `getView` is the ONLY method here that works without a session — it is what
// KhataLinkPage calls on the public /khata/:token route.
//
// NOTE ON THE IMPORTS BELOW: they sit here, not in the header block at the top
// of the file, so this whole feature is one contiguous append. ES module
// imports are hoisted regardless of position, and no lint rule in
// eslint.config.js orders them. Fold them into the header the next time this
// file is edited for another reason.
// ════════════════════════════════════════════════════════════════════════════
import {
  isKhataToken,
  parseCreateKhataLinkResponse,
  parseRevokeKhataLinkResponse,
  parseKhataView,
  khataStatusFromThrown,
  type KhataLinkCreateResult,
  type KhataLinkRevokeResult,
  type KhataView,
} from './khataLinkStatus';
import { reportError } from './errorReporter';

export const khataLinksDb = {
  /**
   * Mint (or rotate) the public khata link for one contact.
   *
   * Rotating is the same call: the server revokes any previous link for that
   * contact before inserting the new one, so the OLD URL DIES. `replacedPrevious`
   * says whether that happened, which is the only way the UI can honestly warn
   * "the link you shared before will stop working".
   *
   * The raw token comes back EXACTLY ONCE and is never stored server-side.
   * Show it, let the user share it, and do not persist it anywhere else — a
   * lost token is recovered by rotating, not by reading.
   *
   * `initialsOnly` / `showNotes` omitted (undefined) keep whatever the
   * previous link had, so a rotate never silently un-hides names or notes.
   */
  async create(personId: string, initialsOnly?: boolean, showNotes?: boolean): Promise<KhataLinkCreateResult> {
    try {
      const { data, error } = await supabase.rpc('create_khata_link', {
        p_person_id: personId,
        p_initials_only: initialsOnly ?? null,
        p_show_notes: showNotes ?? null,
      });
      if (error) throw error;
      return parseCreateKhataLinkResponse(data);
    } catch (err) {
      return { status: khataStatusFromThrown(err) };
    }
  },

  /** Kill the contact's public link. Idempotent — a second call is
   *  `{ status: 'ok', wasActive: false }`, not an error. */
  async revoke(personId: string): Promise<KhataLinkRevokeResult> {
    try {
      const { data, error } = await supabase.rpc('revoke_khata_link', { p_person_id: personId });
      if (error) throw error;
      return parseRevokeKhataLinkResponse(data);
    } catch (err) {
      return { status: khataStatusFromThrown(err) };
    }
  },

  /**
   * Resolve a token into the public read-only view. ANON-CALLABLE — this is
   * the one data-access method on the public route, and it must work with no
   * session at all.
   *
   * Returns null for every refusal the server makes (unknown, revoked,
   * expired, owner deleted, blocked pair, rate-limited) because the server
   * answers all of them with ONE uniform NULL on purpose — a status vocabulary
   * there would be an oracle. A transport failure also lands here as null; the
   * page's single "link not available" state is the honest answer either way,
   * and the error is reported for diagnostics rather than shown as a distinct
   * screen the visitor cannot act on.
   */
  async getView(token: string): Promise<KhataView | null> {
    // Shape-check locally so a mistyped URL never costs a round trip and never
    // charges the server's miss ledger.
    if (!isKhataToken(token)) return null;
    try {
      const { data, error } = await supabase.rpc('get_khata_view', { p_token: token });
      if (error) throw error;
      return parseKhataView(data);
    } catch (err) {
      reportError(err, { feature: 'khataLinksDb.getView' });
      return null;
    }
  },
};

// ══════════════════════════════════════
// TRUST & SAFETY — BLOCKS + REPORTS
// Audit 2026-09 M17. See supabase-migration-p2-trust-safety.sql §1 and
// docs/trust-and-safety.md for the model this data layer must not violate.
// ══════════════════════════════════════

/** One row of MY block list. The blocked party can never read this row. */
export interface BlockRow {
  blockedId: string;
  reason: string | null;
  createdAt: string;
}

export interface ReportInput {
  reportedId: string;
  contextType: ReportContextType;
  contextId: string | null;
  reason: ReportReason;
  details?: string | null;
}

// Both tables are plain PostgREST tables, deliberately: there is NO RPC that
// answers "is this pair blocked", because such an RPC would hand the blocked
// party the exact bit the one-sided model exists to withhold (doc RULE 1).
//
//   • `blocks` has SELECT/INSERT/DELETE policies pinned to blocker_id =
//     auth.uid() and NO policy naming blocked_id, and no UPDATE policy at all
//     — changing a reason is delete + insert, which keeps created_at honest.
//   • `reports` is INSERT-only. There is no SELECT policy, so reading one back
//     is impossible by design; the UI must confirm optimistically.
export const blocksDb = {
  /**
   * My block list. Returns only rows where I am the blocker — RLS guarantees
   * it, and nothing here should ever try to widen that.
   */
  async getAll(): Promise<BlockRow[]> {
    const { data, error } = await supabase
      .from('blocks')
      .select('blocked_id, reason, created_at')
      .order('created_at', { ascending: false });
    if (error) throw error;
    return (data ?? []).map((r: Record<string, unknown>) => ({
      blockedId: r.blocked_id as string,
      reason: (r.reason as string) ?? null,
      createdAt: r.created_at as string,
    }));
  },

  /**
   * Block a user. Idempotent by construction: the PK is the pair, so a repeat
   * collides with 23505 — which `blockOutcomeFromError` maps to
   * ALREADY_BLOCKED, i.e. success. `blocker_id` must equal auth.uid(); RLS
   * enforces it, so a spoof is impossible rather than merely discouraged.
   */
  async block(blockedId: string, reason?: string | null): Promise<BlockOutcome> {
    const { error } = await supabase.from('blocks').insert({
      blocker_id: getUserId(),
      blocked_id: blockedId,
      reason: normalizeFreeText(reason, BLOCK_REASON_MAX),
    });
    return blockOutcomeFromError(error);
  },

  /** Unblock. A pure DELETE — RULE 3: it restores everything, side-effect free. */
  async unblock(blockedId: string): Promise<void> {
    const { error } = await supabase
      .from('blocks')
      .delete()
      .eq('blocker_id', getUserId())
      .eq('blocked_id', blockedId);
    if (error) throw error;
  },
};

export const reportsDb = {
  /**
   * File an abuse report. Never throws for the two outcomes the UI must speak
   * to (the 20/day cap, a refused insert) — it returns them, because a report
   * that failed the cap is not an error the user did anything wrong to cause.
   *
   * Reporting does NOT block. The two actions are separate on purpose: block
   * protects you now, report tells the operator.
   */
  async submit(input: ReportInput): Promise<ReportOutcome> {
    const { error } = await supabase.from('reports').insert({
      reporter_id: getUserId(),
      reported_id: input.reportedId,
      context_type: normalizeFreeText(input.contextType, REPORT_CONTEXT_TYPE_MAX),
      context_id: normalizeFreeText(input.contextId, REPORT_CONTEXT_ID_MAX),
      reason: normalizeFreeText(input.reason, REPORT_REASON_MAX),
      details: normalizeFreeText(input.details, REPORT_DETAILS_MAX),
    });
    return reportOutcomeFromError(error);
  },
};

// ══════════════════════════════════════
// ANALYTICS AGGREGATES (audit P2 M2 / 03-performance H3)
// ══════════════════════════════════════
// SQL-side replacement for AnalyticsPage's client-side summing of the user's
// entire transaction history. Backed by `analytics_monthly_summary` in
// supabase-migration-p2-analytics-aggregates.sql, whose header carries the
// full rule-port table; the TypeScript twin of the same aggregation (and the
// tests that pin the two together) lives in src/lib/analytics.ts.
//
// Gated by VITE_ANALYTICS_RPC — the caller decides; this module just speaks to
// the RPC. With the flag off nothing here is ever called.

export class AnalyticsRpcUnavailableError extends Error {
  readonly code = 'ANALYTICS_RPC_UNAVAILABLE';
  constructor(message: string) {
    super(message);
    this.name = 'AnalyticsRpcUnavailableError';
  }
}

export const analyticsDb = {
  /**
   * Grouped (month, currency, type, category) sums for the window `[from, to]`,
   * INCLUSIVE at both ends — the same comparison every function in
   * src/lib/analytics.ts makes.
   *
   * `tz` is the IANA zone the MONTH buckets are cut in. It defaults to the
   * device's own zone so a UTC+4 user's "April" is their April, matching the
   * client aggregation's use of local `Date` arithmetic. An unresolvable zone
   * falls back to UTC on both sides.
   *
   * Both app modes: the RPC reads no account id, so a splits_only ledger row
   * (BOTH account ids null) is aggregated exactly like a full_tracker row.
   *
   * Throws AnalyticsRpcUnavailableError when the migration has not been applied
   * (PGRST202), so the caller can fall back to the client aggregation instead
   * of showing a finance app an empty chart.
   */
  async monthlySummary(from: Date, to: Date, tz?: string): Promise<MonthlySummaryRow[]> {
    let zone = tz;
    if (!zone) {
      try {
        zone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
      } catch {
        zone = 'UTC';
      }
    }
    const { data, error } = await supabase.rpc('analytics_monthly_summary', {
      p_from: from.toISOString(),
      p_to: to.toISOString(),
      p_tz: zone,
    });
    if (error) {
      const code = (error as { code?: string })?.code;
      const message = error.message ?? '';
      if (code === 'PGRST202' || message.includes('analytics_monthly_summary')) {
        throw new AnalyticsRpcUnavailableError(
          'analytics_monthly_summary is not available — apply supabase-migration-p2-analytics-aggregates.sql or unset VITE_ANALYTICS_RPC.',
        );
      }
      throw error;
    }
    const rows = (data ?? []) as {
      month_start: string;
      currency: string;
      type: string;
      category: string;
      total: number | string;
      tx_count: number | string;
      latest_at: string;
    }[];
    return rows.map((r) => ({
      monthStart: r.month_start,
      currency: r.currency as Currency,
      type: r.type as Transaction['type'],
      category: r.category,
      // NUMERIC / BIGINT arrive as strings over PostgREST when they are wide
      // enough; Number() is safe for both shapes and matches what every other
      // money read in this file does.
      total: Number(r.total),
      txCount: Number(r.tx_count),
      latestAt: r.latest_at,
    }));
  },

  /**
   * Per-(local day, currency, type) sums for the window `[from, to]`, INCLUSIVE
   * at both ends. Backs the daily-spend chart —
   * `analytics_daily_series` in supabase-migration-p2-analytics-aggregates-2.sql
   * (rules D1-D8 in that file's header), TypeScript twin
   * `dailySeriesFromTransactions` in src/lib/analytics.ts.
   *
   * The SQL returns real calendar DATES. The chart's quirk — day-of-month bar
   * keys, 31 bars max, April 5 and May 5 sharing a bar — is applied afterwards
   * by `dailySpendingFromSeries`, using the exact helper the client path uses.
   *
   * Same `tz` and both-app-modes notes as `monthlySummary` above.
   */
  async dailySeries(from: Date, to: Date, tz?: string): Promise<DailySeriesRow[]> {
    const { data, error } = await supabase.rpc('analytics_daily_series', {
      p_from: from.toISOString(),
      p_to: to.toISOString(),
      p_tz: tz ?? resolvedTimeZone(),
    });
    if (error) throw analyticsRpcError(error, 'analytics_daily_series');
    const rows = (data ?? []) as {
      day: string;
      currency: string;
      type: string;
      total: number | string;
      tx_count: number | string;
    }[];
    return rows.map((r) => ({
      day: r.day,
      currency: r.currency as Currency,
      type: r.type as Transaction['type'],
      // NUMERIC / BIGINT arrive as strings over PostgREST when they are wide
      // enough; Number() is safe for both shapes.
      total: Number(r.total),
      txCount: Number(r.tx_count),
    }));
  },

  /**
   * The top `limit` expense ROWS **per currency** in `[from, to]`, ranked
   * amount DESC, created_at DESC, id DESC — `analytics_top_expenses`
   * (rules T1-T7 in the same migration header), TypeScript twin
   * `topExpensesFromTransactions`.
   *
   * Per-currency rather than per-call-currency on purpose: the page lets the
   * user flip currency chips without re-fetching, so one call has to answer
   * every chip. `topExpensesFromRows` does the (unchanged) client-side filter.
   *
   * This is the only analytics RPC that returns row-level data; it therefore
   * returns exactly the six columns the list renders and nothing else — no
   * account ids, no person, no loan/goal links.
   */
  async topExpenses(from: Date, to: Date, limit = 5): Promise<TopExpenseRow[]> {
    const { data, error } = await supabase.rpc('analytics_top_expenses', {
      p_from: from.toISOString(),
      p_to: to.toISOString(),
      p_limit: limit,
    });
    if (error) throw analyticsRpcError(error, 'analytics_top_expenses');
    const rows = (data ?? []) as {
      id: string;
      created_at: string;
      amount: number | string;
      currency: string;
      category: string | null;
      notes: string | null;
    }[];
    return rows.map((r) => ({
      id: r.id,
      createdAt: r.created_at,
      amount: Number(r.amount),
      currency: r.currency as Currency,
      category: r.category ?? '',
      notes: r.notes ?? '',
    }));
  },

  /**
   * How many non-deleted transactions the SERVER holds for this user.
   *
   * A `head: true` count — PostgREST returns the number in a Content-Range
   * header and NO rows, so this costs one tiny request regardless of history
   * size. It exists so TransactionsPage can be honest about H4/F-FE1
   * TRUNCATION: `fetchAllPages` already detects a partial fetch, but it reports
   * it to Sentry only (`reportMessage`), and the path that would carry the flag
   * to the UI runs through mirrorCache + transactionStore, which this task does
   * not own. Comparing this count with what the store actually holds is the
   * ownership-safe equivalent, and it is arguably the stronger signal: it also
   * catches a mirror that is short for reasons pagedFetch never saw.
   *
   * Lives in `analyticsDb` because it is a read-only aggregate with no entity
   * shape, not because Analytics uses it (it does not).
   *
   * Returns null instead of throwing — a page must never fail to render its
   * list because a count request failed.
   */
  async transactionHistoryCount(): Promise<number | null> {
    try {
      const { count, error } = await supabase
        .from('transactions')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', getUserId())
        .is('deleted_at', null);
      if (error || typeof count !== 'number') return null;
      return count;
    } catch {
      return null;
    }
  },
};

/** The device's IANA zone, or UTC when the browser will not resolve one. */
function resolvedTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/**
 * PGRST202 = "function not found in the schema cache" — the flag was switched
 * on before the migration was applied. Every analytics caller falls back to the
 * client aggregation on this, so it must be distinguishable from a real error.
 */
function analyticsRpcError(error: { code?: string; message?: string }, fn: string): Error {
  const message = error.message ?? '';
  if (error.code === 'PGRST202' || message.includes(fn)) {
    return new AnalyticsRpcUnavailableError(
      `${fn} is not available — apply supabase-migration-p2-analytics-aggregates-2.sql or unset VITE_ANALYTICS_RPC.`,
    );
  }
  return error as Error;
}

// ══════════════════════════════════════
// EDIT HISTORY — "who changed what" (audit 11-competitive-analysis G5 / O10)
// ══════════════════════════════════════
// Reads `public.record_edits` from supabase-migration-p2-edit-history.sql.
// READ-ONLY by construction: that table has one SELECT policy and no write
// grant for `authenticated`, so there is deliberately no add()/update() here —
// every row is written by the AFTER triggers inside the same transaction as
// the money write, the same shape `groupEventsDb` follows.
//
// RLS decides visibility, not this module: a group row is readable by any
// connected member of its group (and its author), a loan/transaction row only
// by its owner. Both app modes are identical here — the change JSON carries no
// account id in either, so a splits_only ledger row and a full_tracker row
// produce the same history for the same act.

export class EditHistoryUnavailableError extends Error {
  readonly code = 'EDIT_HISTORY_UNAVAILABLE';
  constructor(message: string) {
    super(message);
    this.name = 'EditHistoryUnavailableError';
  }
}

/**
 * PGRST205 = "table not found in the schema cache"; 42P01 = undefined_table.
 * The migration is applied by hand in Supabase Studio (this repo has no
 * runner), so a client that ships first MUST degrade to "history isn't
 * available yet" rather than showing a finance app a red error.
 */
function editHistoryError(error: { code?: string; message?: string }): Error {
  const message = error.message ?? '';
  if (error.code === 'PGRST205' || error.code === '42P01' || message.includes('record_edits')) {
    return new EditHistoryUnavailableError(
      'record_edits is not available — apply supabase-migration-p2-edit-history.sql.',
    );
  }
  return error as Error;
}

function mapRecordEdit(r: Record<string, unknown>): EditHistoryEntry {
  const changed = (r.changed as Record<string, { old: unknown; new: unknown }>) ?? {};
  return {
    id: Number(r.id),
    tableName: r.table_name as EditHistoryEntry['tableName'],
    recordId: r.record_id as string,
    groupId: (r.group_id as string) ?? null,
    ownerId: (r.owner_id as string) ?? null,
    actorId: (r.actor_id as string) ?? null,
    actorKind: (r.actor_kind as EditHistoryEntry['actorKind']) ?? 'user',
    action: r.action as EditHistoryEntry['action'],
    changed,
    createdAt: r.created_at as string,
  };
}

// One record's history is bounded by how often a person edits one expense or
// loan; a group's is not, so both reads are capped. 200 is far past any real
// dispute and keeps a runaway row count off a phone.
const EDIT_HISTORY_LIMIT = 200;

export const editHistoryDb = {
  /** Newest-first history for ONE record. `id` is the record's own id. */
  async forRecord(table: EditHistoryTable, id: string): Promise<EditHistoryEntry[]> {
    const { data, error } = await supabase
      .from('record_edits').select('*')
      .eq('table_name', table)
      .eq('record_id', id)
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(EDIT_HISTORY_LIMIT);
    if (error) throw editHistoryError(error);
    return (data ?? []).map(mapRecordEdit);
  },

  /**
   * Newest-first history for a whole group — every expense and settlement in
   * it. Personal loans/transactions never carry a group_id, so they can never
   * appear here even for the same user.
   */
  async forGroup(groupId: string): Promise<EditHistoryEntry[]> {
    const { data, error } = await supabase
      .from('record_edits').select('*')
      .eq('group_id', groupId)
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(EDIT_HISTORY_LIMIT);
    if (error) throw editHistoryError(error);
    return (data ?? []).map(mapRecordEdit);
  },
};
