import { LEGACY_CURRENCIES } from '../lib/currencies';

/**
 * The eight founding currencies (AED PKR PHP SAR QAR OMR KWD BHD).
 *
 * This is NOT a write gate any more. Founder decision 2026-09-04 widened the
 * app to every active ISO 4217 currency (`CURRENCY_CODES` in
 * src/lib/currencies.ts), and `supabase-migration-p3-currencies-iso4217.sql`
 * (applied to production 2026-09-04) replaced every per-column whitelist
 * CHECK with a `public.currencies` reference table plus a FOREIGN KEY from
 * each currency column — so the database accepts exactly what
 * `isSupportedCurrency` accepts. This constant survives only as the legacy
 * chip-row order and the `LINKED_REQUEST_CURRENCIES` alias; see
 * `LEGACY_CURRENCIES` for what still depends on it.
 *
 * Single source of truth is `LEGACY_CURRENCIES`; this is an alias so the
 * existing import sites keep compiling.
 */
export const SUPPORTED_CURRENCIES = LEGACY_CURRENCIES;

/** The full ISO 4217 list, re-exported for `../db` consumers. */
export { CURRENCY_CODES } from '../lib/currencies';

/**
 * An ISO 4217 currency code.
 *
 * Widened from the eight-member literal union to `string` on 2026-09-04: the
 * app now accepts any active ISO code, and a compile-time union of ~160
 * members bought nothing but friction. Validation moved to runtime —
 * `isSupportedCurrency(code)` from src/lib/currencies.ts is the gate, and the
 * `public.currencies` foreign key (p3-currencies-iso4217, applied) is the
 * backstop.
 */
export type Currency = string;

export type AccountType = 'cash' | 'bank' | 'digital_wallet' | 'savings' | 'credit_card';

export interface Account {
  id: string;
  name: string;
  type: AccountType;
  currency: Currency;
  balance: number;
  metadata: Record<string, string>;
  createdAt: string;
  updatedAt?: string;
  deletedAt?: string | null;
}

export type TransactionType =
  | 'income'
  | 'expense'
  | 'loan_given'
  | 'loan_taken'
  | 'repayment'
  | 'transfer'
  | 'goal_contribution'
  | 'opening_balance'
  | 'adjustment'
  | 'investment_buy'
  | 'investment_sell'
  | 'investment_dividend';

export interface Transaction {
  id: string;
  type: TransactionType;
  amount: number;
  currency: Currency;
  sourceAccountId: string | null;
  destinationAccountId: string | null;
  relatedPerson: string | null;
  personId?: string | null;
  relatedLoanId: string | null;
  relatedGoalId: string | null;
  // Links investment_buy/sell/dividend rows to their investment_trades row —
  // O(1) two-way lookup for delete reversal (mirrors relatedGoalId).
  relatedInvestmentId?: string | null;
  conversionRate: number | null;
  category: string;
  notes: string;
  createdAt: string;
  isReconciled?: boolean;
  reconciledAt?: string | null;
  reconciledBy?: string | null;
  updatedAt?: string;
  deletedAt?: string | null;
  // Storage path of an attached receipt photo in the private `receipts`
  // bucket ({user_id}/{transaction_id}.jpg). Null = no receipt. Displayed via
  // a short-lived signed URL — see receiptStorage.ts.
  receiptPath?: string | null;
}

export type LoanType = 'given' | 'taken';
export type LoanStatus = 'active' | 'settled';

export interface Loan {
  id: string;
  personName: string;
  personId?: string | null;
  type: LoanType;
  totalAmount: number;
  remainingAmount: number;
  currency: Currency;
  status: LoanStatus;
  notes: string;
  createdAt: string;
  updatedAt?: string;
  deletedAt?: string | null;
  // Set (backfilled by accept_linked_request) when this loan is mirrored to
  // another Hisaab user. A linked loan must not be unilaterally edited/deleted
  // — that would diverge the two ledgers. See linkedLoanGuards.ts.
  loanPairId?: string | null;
}

export interface Person {
  id: string;
  name: string;
  phone?: string | null;
  linkedProfileId?: string | null;
  archivedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

// Phase 2B: linked transaction request. Cloud-only; no Dexie mirror.
export type LinkedRequestKind = 'lent' | 'borrowed';
export type LinkedRequestStatus = 'pending' | 'accepted' | 'rejected' | 'cancelled';

export interface LinkedRequest {
  id: string;
  fromUserId: string;
  toUserId: string;
  personId: string | null;
  kind: LinkedRequestKind;
  amount: number;
  currency: Currency;
  note: string;
  status: LinkedRequestStatus;
  rejectionReason: string | null;
  requesterLoanId: string | null;
  responderLoanId: string | null;
  requesterTxnId: string | null;
  responderTxnId: string | null;
  loanPairId: string | null;
  // Phase 2D: set when the request references an already-existing sender-side
  // loan from before the contact got linked. Acceptance reuses that loan
  // instead of creating a duplicate; the recipient still gets a fresh mirror.
  // Distinguishes "sync past record" cards from fresh-loan requests in Inbox.
  preExistingLoanId: string | null;
  // Cross-user account effects: each side's optional account. Null on a side
  // ⇒ that side stays ledger-only (simple mode / "record only"). Sender picks
  // at send time, receiver at accept time. Forbidden on past-record syncs.
  requesterAccountId?: string | null;
  responderAccountId?: string | null;
  createdAt: string;
  respondedAt: string | null;
}

// Phase 2C-A: linked settlement request. Cloud-only; same mirroring pattern
// as LinkedRequest. No account-related fields — Phase 2C-A is ledger-only.
export type SettlementRequestStatus = 'pending' | 'accepted' | 'rejected' | 'cancelled';

export interface SettlementRequest {
  id: string;
  loanPairId: string;
  requesterLoanId: string;
  responderLoanId: string;
  fromUserId: string;
  toUserId: string;
  amount: number;
  currency: Currency;
  note: string;
  status: SettlementRequestStatus;
  rejectionReason: string | null;
  requesterTxnId: string | null;
  responderTxnId: string | null;
  // Phase 2C-B (sender opt-in). Null ⇒ sender side ledger-only.
  requesterAccountId?: string | null;
  // Receiver's landing account, picked at accept time. Null ⇒ receiver side
  // ledger-only.
  responderAccountId?: string | null;
  // 2026-09-24 settlement model (supabase-migration-settlement-receiver-
  // records.sql): TRUE when the person who RECEIVED the money recorded it — it
  // applied to both ledgers at once, nobody confirmed anything. Optional so a
  // row read before the migration is applied maps cleanly (reads as false).
  recordedByReceiver?: boolean;
  // Set when that record was undone inside the 10-minute window; the row's
  // status is then 'cancelled'.
  undoneAt?: string | null;
  createdAt: string;
  respondedAt: string | null;
}

export type EmiStatus = 'upcoming' | 'paid' | 'late';

export interface EmiSchedule {
  id: string;
  loanId: string;
  installmentNumber: number;
  dueDate: string;
  amount: number;
  status: EmiStatus;
}

export interface Goal {
  id: string;
  title: string;
  targetAmount: number;
  savedAmount: number;
  currency: Currency;
  storedInAccountId: string; // empty string = tracked internally
  createdAt: string;
  // Optional deadline (YYYY-MM-DD). When set, the goal can suggest a monthly
  // save amount and show an on-track / behind signal. Null = open-ended.
  targetDate?: string | null;
}

export type UpcomingExpenseStatus = 'upcoming' | 'done' | 'cancelled';

export interface UpcomingExpense {
  id: string;
  title: string;
  amount: number;
  currency: Currency;
  dueDate: string;
  accountId: string; // which account will be charged
  category: string;
  notes: string;
  isPaid: boolean;
  status: UpcomingExpenseStatus;
  reminderDaysBefore: number;
  createdAt: string;
}

export type ActivityType =
  | 'account_created'
  | 'account_deleted'
  | 'transaction_created'
  | 'transaction_modified'
  | 'transaction_deleted'
  | 'loan_created'
  | 'loan_settled'
  | 'emi_paid'
  | 'goal_created'
  | 'goal_contribution'
  | 'opening_balance'
  | 'group_created'
  | 'group_expense'
  | 'group_settlement';

export interface ActivityLog {
  id: string;
  type: ActivityType;
  description: string;
  relatedEntityId: string;
  relatedEntityType: string;
  timestamp: string;
}

// ── Group Splits ──
export type SplitType = 'equal' | 'exact' | 'percentage' | 'shares';

export interface GroupMember {
  id: string;
  name: string;
  isOwner: boolean;
  profileId?: string | null;
  role?: 'owner' | 'member';
  status?: 'guest' | 'invited' | 'connected' | 'left';
  joinedAt?: string | null;
  // Co-admin flag (supabase-migration-group-admins.sql). The owner is always
  // an admin regardless of it — ask src/lib/groupRoles.ts, never read it raw.
  // `undefined` means the database predates the migration (the column does
  // not exist yet), which is why it is optional: `false` is a real answer
  // from a migrated database, `undefined` is "this server has no co-admins".
  isAdmin?: boolean;
}

export interface SplitGroup {
  id: string;
  name: string;
  emoji: string;
  members: GroupMember[];
  currency: Currency;
  settled: boolean;
  createdAt: string;
  createdBy?: string | null;
  joinCode?: string | null;
  joinCodeNormalized?: string | null;
  // Join codes expire 14 days after creation/rotation (trigger in
  // supabase-migration-audit-p0-join-abuse-limits.sql). Null on a database that
  // hasn't been migrated yet, and on legacy rows with no code.
  joinCodeExpiresAt?: string | null;
  // Wind-down state (supabase-migration-audit-p0-group-deletion-guard.sql §3):
  // fully readable by every member, but closed to new expenses, settlements and
  // joins. Written ONLY by the archive_group / unarchive_group RPCs — a direct
  // PATCH is refused with GROUP_ARCHIVE_RPC_ONLY. Distinct from `settled`,
  // which is a reversible all-square badge, not a lifecycle state.
  archivedAt?: string | null;
  archivedBy?: string | null;
}

export interface SplitDetail {
  memberId: string;
  amount: number;
}

export interface GroupExpense {
  id: string;
  groupId: string;
  description: string;
  amount: number;
  paidBy: string; // member id
  splitType: SplitType;
  splits: SplitDetail[];
  category: string;
  date: string;
  notes: string;
  createdAt: string;
  createdBy?: string | null;
  updatedBy?: string | null;
  deletedAt?: string | null;
  deletedBy?: string | null;
  version?: number;
  isReconciled?: boolean;
  reconciledAt?: string | null;
  reconciledBy?: string | null;
}

export interface GroupSettlement {
  id: string;
  groupId: string;
  fromMember: string; // member id
  toMember: string;   // member id
  amount: number;
  date: string;
  note: string;
  createdAt: string;
  createdBy?: string | null;
  updatedBy?: string | null;
  deletedAt?: string | null;
  deletedBy?: string | null;
}

export type GroupEventType =
  | 'group_created'
  | 'member_invited'
  | 'member_joined'
  | 'expense_added'
  | 'expense_updated'
  | 'expense_deleted'
  | 'settlement_added'
  | 'settlement_deleted'
  // Written by archive_group / unarchive_group
  // (supabase-migration-audit-p0-group-deletion-guard.sql §6b/§6c).
  // Payload: { groupId, groupName, currency, actorName, archivedAt|unarchivedAt }
  | 'group_archived'
  | 'group_unarchived'
  // Written by delete_current_user when a member deletes their Hisaab account
  // (supabase-migration-audit-p0-account-deletion.sql §4b). Payload:
  // { memberId, displayName, expensesRetained, settlementsRetained, deletedAt }
  | 'member_account_deleted'
  // Written by transfer_group_ownership (account-deletion.sql §5). Payload:
  // { newOwnerMemberId, newOwnerProfileId, previousOwnerMemberId }
  | 'group_ownership_transferred'
  // Written by add_group_guest (supabase-migration-p2-guest-members.sql §4a)
  // when a member adds a named seat for someone who is not on Hisaab.
  // Payload: { memberId, displayName, groupId, groupName, currency, actorName }.
  // Deliberately fanned out with an EMPTY recipient list: adding a guest is a
  // group FACT the shared activity feed must record, but nobody's push.
  | 'guest_added';

export interface GroupInvite {
  id: string;
  groupId: string;
  // Unreadable by clients since supabase-migration-audit-p0-consent-guards.sql
  // §3.2 revoked the column grant — the hash is no longer the credential, and
  // nothing the app renders needs it. Still WRITTEN on create (the owner knows
  // the raw token at that moment), so it stays on the type as optional.
  tokenHash?: string;
  createdBy: string;
  linkedMemberId: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  acceptedBy: string | null;
  acceptedAt: string | null;
  createdAt: string;
}

export interface GroupEvent {
  id: string;
  groupId: string;
  actorProfileId: string | null;
  eventType: GroupEventType;
  entityType: 'group' | 'member' | 'group_expense' | 'group_settlement' | 'invite';
  entityId: string;
  summary: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface AppNotification {
  id: string;
  userId: string;
  groupId: string | null;
  eventId: string | null;
  // 'kameti' is written by notify_committee_members
  // (supabase-migration-p2-notification-maturity.sql §6) for draw-completed,
  // round-due and payout-due — the cross-user kameti gap in audit
  // 08-notifications.md N-11.
  // 'linked_info' (supabase-migration-settlement-receiver-records.sql) is an
  // informational money notice with nothing to act on — "{name} recorded your
  // repayment" / "…removed the repayment". Deliberately NOT a request mirror.
  type: 'group_update' | 'invite' | 'system' | 'linked_request' | 'linked_settlement' | 'linked_info' | 'contact_linked' | 'kameti';
  // Server-composed fallback text. Since the fan-out moved into Postgres
  // triggers (supabase-migration-audit-p0-notifications.sql) these are written
  // ONLY by the database — a client can no longer author notification text for
  // anyone (audit 05-security.md H5). They stay the render fallback for legacy
  // rows and are what the FCM push pipeline sends.
  title: string;
  body: string;
  // Structured content: `template` names a server template, `params` carries
  // its variables (actor name, amount, currency, group name, entity ids). The
  // client renders these through i18n so cross-user notifications finally
  // appear in the reader's language (audit 08-notifications.md N-1).
  // null/{} for legacy rows.
  template: string | null;
  params: Record<string, unknown>;
  // Who caused it. Also the key the server-side per-sender rate limit uses.
  actorId: string | null;
  // Routing + grouping metadata, stamped server-side by the
  // tg_notifications_defaults BEFORE INSERT trigger
  // (supabase-migration-p2-notification-maturity.sql §3) so EVERY writer's
  // rows carry them, not just the group fan-out.
  //   collapseKey — tray grouping ("group:<id>:expense_added"): ten expenses
  //     in one trip become one tray entry (audit N-10).
  //   channelId   — Android notification channel: money | groups | kameti,
  //     so group chatter is demotable without losing loan requests (N-10).
  //   href        — the in-app route to open on tap (N-8: pushes used to dump
  //     the user at the top of /groups).
  // All three are null on rows written before that migration; the client
  // derives its own fallback via notificationHref() / notificationChannel().
  collapseKey: string | null;
  channelId: string | null;
  href: string | null;
  readAt: string | null;
  createdAt: string;
}

// ── Custom Categories ──
// A user-defined expense/income category name that extends the built-in lists
// (EXPENSE_CATEGORIES / INCOME_CATEGORIES). Only the NAME is stored here — the
// transaction/budget/recurring rows keep categories as plain strings, so the
// app just merges built-in + custom names at read time. See mergedCategories.ts.
export type CustomCategoryType = 'expense' | 'income';

export interface CustomCategory {
  id: string;
  type: CustomCategoryType;
  name: string;
  createdAt: string;
  updatedAt?: string;
}

// ── Budgets ──
// A monthly spending cap per (category, currency). Multiple budgets per
// category are NOT supported on purpose — one user, one currency, one
// monthly cap. If the user wants to track spend across currencies they
// can create one budget per currency.
export interface Budget {
  id: string;
  category: string;
  monthlyAmount: number;
  currency: Currency;
  // Optional soft-warning threshold as a percentage. Defaults to 80% if
  // not set; surfaces a non-blocking banner on Home once crossed.
  warnAtPercent: number;
  createdAt: string;
  updatedAt?: string;
  deletedAt?: string | null;
}

// ── Recurring Transactions ──
export type RecurringCadence = 'daily' | 'weekly' | 'monthly' | 'yearly';

// A template that materialises into a real Transaction on its due date.
// Designed for salary, rent, subscriptions, EMIs the user wants tracked
// without re-typing. The runner in src/lib/recurringRunner.ts walks the
// list on app boot and prompts confirmation for any due entries.
export interface RecurringTransaction {
  id: string;
  // The Transaction shape this expands into. Only the leaf fields the user
  // can edit at template time are kept — generated fields (id, createdAt)
  // are produced fresh at expansion.
  type: 'income' | 'expense' | 'transfer';
  amount: number;
  currency: Currency;
  sourceAccountId: string | null;
  destinationAccountId: string | null;
  category: string;
  notes: string;
  // Scheduling. nextDueDate advances by `cadence` after each expansion.
  cadence: RecurringCadence;
  nextDueDate: string; // ISO date (YYYY-MM-DD)
  // Soft-pause without deleting. Useful for "I quit Netflix this month
  // but might restart next month" — keeps the template, skips the run.
  active: boolean;
  // Display label for the user. Defaults to the category when unset.
  label: string;
  createdAt: string;
}

// ── Remittances ──
// A first-class money-home record. NOT a Transaction subtype because
// remittances have their own metadata (channel, fees, effective rate)
// that doesn't belong on the generic ledger row. The send-side debit
// and receive-side credit are still represented as transactions on
// the linked accounts; the Remittance entity is the umbrella that
// ties them together with the cost-of-conversion context.
export type RemittanceChannel = 'bank_transfer' | 'wise' | 'remitly' | 'western_union' | 'hundi' | 'other';
export type RemittanceStatus = 'pending' | 'received' | 'failed';

export interface Remittance {
  id: string;
  // Send side — money leaving the source country.
  sourceAccountId: string;
  sourceCurrency: Currency;
  sourceAmount: number;
  // Receive side — money arriving in the destination country.
  destinationAccountId: string | null; // null when received in cash / unlinked
  destinationCurrency: Currency;
  destinationAmount: number;
  // Channel + cost transparency.
  channel: RemittanceChannel;
  feeAmount: number;
  feeCurrency: Currency;
  // Derived: destinationAmount / (sourceAmount - feeAmountInSourceCurrency)
  // Stored explicitly so the user can compare channels across months
  // without re-deriving from rates that decay over time.
  effectiveRate: number;
  status: RemittanceStatus;
  recipientName: string;
  notes: string;
  // The two transaction IDs we wrote on commit. Kept so reconciling
  // a remittance can find and reconcile both legs in one shot.
  sourceTxnId: string | null;
  destinationTxnId: string | null;
  sentAt: string;
  receivedAt: string | null;
  createdAt: string;
}

// ── Kameti / Committee (ROSCA) ──
// A no-custody rotating-savings committee tracker. Hisaab records the structure
// and who paid; it never holds the pool. See supabase-migration-committees.sql.
export type CommitteeCadence = 'daily' | 'weekly' | 'monthly';
export type CommitteePayoutMethod = 'fixed' | 'ballot';
export type CommitteeStatus = 'active' | 'completed';

export interface Committee {
  id: string;
  name: string;
  /**
   * Optional decoration for the kameti card (UX-25 / p2-kameti-editing). Pure
   * label: no money meaning, editable in every lifecycle state alongside the
   * name. Absent on rows written before the migration.
   */
  emoji?: string | null;
  currency: Currency;
  contributionAmount: number;
  memberCount: number;        // N slots
  cadence: CommitteeCadence;
  totalRounds: number;        // usually = memberCount
  startDate: string;          // YYYY-MM-DD
  payoutMethod: CommitteePayoutMethod;
  status: CommitteeStatus;
  notes: string;
  drawnAt?: string | null;    // when the order/ballot was set
  // Provably-fair ballot (commit-reveal): the seed and its SHA-256 commitment.
  drawSeed?: string | null;
  drawCommitment?: string | null;
  // Read-only "witness link" token (phase 2 transparency).
  //
  // AUDIT M19 / supabase-migration-p2-trust-safety.sql §7: the raw token is no
  // longer stored — the server keeps only its SHA-256 and hands the plaintext
  // back exactly once, from `rotate_committee_witness_token`. `shareToken` is
  // therefore ALWAYS null now (the migration nulls the column) and is kept only
  // so old rows in the local mirror still typecheck. Never write it: a trigger
  // raises WITNESS_TOKEN_IS_SERVER_ONLY.
  shareToken?: string | null;
  /** When the current witness link stops working (90 days from the rotate). */
  witnessExpiresAt?: string | null;
  /** Set by revoke_committee_witness_token — the organiser's "stop sharing". */
  witnessRevokedAt?: string | null;
  /** UX-24: show member INITIALS instead of names on the public witness page. */
  witnessInitialsOnly?: boolean;
  createdAt: string;
  updatedAt?: string;
}

export interface CommitteeMember {
  id: string;
  committeeId: string;
  name: string;
  phone?: string | null;
  personId?: string | null;
  slot?: number | null;       // payout round (1..N); null until assigned
  isOrganizer: boolean;
  payoutReceivedAt?: string | null;
  exitedAt?: string | null;
  createdAt: string;
}

// One row per paid (member, round). Absence of a row = not paid.
export interface CommitteePayment {
  id: string;
  committeeId: string;
  memberId: string;
  round: number;
  paidAt: string;
}

// ── Investments ──
// A record-keeping tracker for user-entered stock trades — Hisaab never holds,
// trades, or advises on investments (see PublicInfoPages disclaimer). Positions
// (quantity / avg cost / P&L) are DERIVED by replaying trades in
// investmentMath.ts — trades are the single source of truth; there is no
// materialized holdings row to drift. See supabase-migration-investments.sql.

// A user-defined market with a FIXED currency (DFM→AED, PSX→PKR, ...). The
// currency locks once the market has trades — changing it retroactively would
// corrupt every P&L figure under it.
export interface InvestmentMarket {
  id: string;
  name: string;
  currency: Currency;
  createdAt: string;
  updatedAt?: string;
  deletedAt?: string | null;
}

export type InvestmentTradeKind = 'buy' | 'sell' | 'dividend';

export interface InvestmentTrade {
  id: string;
  marketId: string;
  symbol: string;        // uppercased ticker, e.g. EMAAR
  name: string;          // optional company name ('' when unset)
  kind: InvestmentTradeKind;
  // buy/sell: quantity > 0, pricePerUnit >= 0, amount = 0 (total derives from
  // qty × price). dividend: quantity = 0, pricePerUnit = 0, amount = gross cash.
  quantity: number;
  pricePerUnit: number;
  amount: number;
  fees: number;          // buy: capitalized into cost basis; sell/dividend: reduce proceeds
  // null = "held outside Hisaab" — ledger-only, no account balance touched.
  accountId: string | null;
  // The transactions row that moved the money; null for outside-Hisaab trades.
  // Any conversionRate lives on that row only (never duplicated here).
  transactionId: string | null;
  tradedAt: string;      // ISO — user-editable trade date
  notes: string;
  createdAt: string;
  updatedAt?: string;
  deletedAt?: string | null;
}

// Manual "last price + as-of" per (market, symbol) — updated independently of
// trading and survives a fully-sold position. Upsert-only.
export interface InvestmentPrice {
  id: string;
  marketId: string;
  symbol: string;
  price: number;
  asOf: string;          // ISO — when the user says this price was true
  createdAt: string;
  updatedAt?: string;
}

// ── App Mode ──
export type AppMode = 'splits_only' | 'full_tracker';
