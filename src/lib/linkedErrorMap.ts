// Maps the backend's terse 'lsr:'/'ltr:' RPC error strings to bilingual,
// recovery-oriented copy. The RPCs raise developer-grade messages ("lsr:
// requester account was deleted") that used to surface verbatim in toasts —
// meaningless to users and English-only. authErrorMap precedent. Unknown
// messages pass through untouched so genuine diagnostics stay visible.
import { tStatic, type I18nKey } from './i18n';

const LINKED_ERROR_KEYS: Array<{ match: string; key: I18nKey }> = [
  { match: 'lsr: requester account was deleted', key: 'lsr_err_account_deleted' },
  { match: 'lsr: amount exceeds remaining', key: 'lsr_err_amount_exceeds' },
  { match: 'lsr: loan is no longer active', key: 'lsr_err_loan_inactive' },
  { match: 'lsr: only the target user can accept', key: 'lsr_err_not_target' },
  { match: 'lsr: request not found', key: 'lsr_err_not_found' },
  // Past-record sync refused at accept (supabase-migration-linked-sync-live-amount.sql).
  { match: 'ltr: pre_existing loan has been settled or archived', key: 'ltr_err_sync_loan_settled' },
  { match: 'ltr: pre_existing loan no longer available', key: 'ltr_err_sync_loan_gone' },
  { match: 'ltr: pre_existing loan changed currency', key: 'ltr_err_sync_loan_gone' },
  // Receiver records / Undo / "Add to an account"
  // (supabase-migration-settlement-receiver-records.sql).
  { match: 'lsr: the undo window has passed', key: 'lsr_err_undo_window' },
  { match: 'lsr: they already added it to an account', key: 'lsr_err_undo_attached' },
  { match: 'lsr: this payment was changed since it was recorded', key: 'lsr_err_changed' },
  { match: 'lsr: only the person receiving the money can record it', key: 'lsr_err_not_receiver' },
  { match: 'lsr: this repayment is already in an account', key: 'lsr_err_already_in_account' },
  { match: 'lsr: only a confirmed settlement repayment can be added to an account', key: 'lsr_err_attach_not_settlement' },
  { match: "lsr: this repayment can't be added to an account", key: 'lsr_err_attach_not_settlement' },
  { match: 'lsr: account currency mismatch', key: 'lsr_err_account_currency' },
  // PostgREST PGRST202 before the migration is applied: the client shipped
  // first. Say so plainly instead of showing a schema-cache message.
  { match: 'function public.record_received_repayment', key: 'lsr_err_needs_update' },
  { match: 'function public.apply_own_settlement_request', key: 'lsr_err_needs_update' },
  { match: 'function public.undo_received_repayment', key: 'lsr_err_needs_update' },
  { match: 'function public.set_settlement_repayment_account', key: 'lsr_err_needs_update' },
];

export function friendlyLinkedError(raw: string): string {
  for (const { match, key } of LINKED_ERROR_KEYS) {
    if (raw.includes(match)) return tStatic(key);
  }
  return raw;
}

// ───────────────────────────────────────────────────────────────────────────
// Unsupported-currency fallback (audit 2026-09, F-MIG2 / H6).
//
// linked_transaction_requests / linked_settlement_requests carried a hard
// `check (currency in ('AED','PKR'))` while the client accepted more (eight then,
// every active ISO 4217 currency since 2026-09-04),
// so a Gulf/Filipino user's linked udhaar died with a raw Postgres 23514 and a
// lost entry. supabase-migration-audit-p0-currencies.sql widens both CHECKs to
// the full SUPPORTED_CURRENCIES list — but migrations here are applied by hand
// (no runner), so a client build can reach a database that hasn't caught up.
// This maps that specific violation to honest, actionable copy instead of a
// Postgres string. It is a graceful fallback, NOT a client-side block: the UI
// still offers every currency in src/lib/currencies.ts, because all of them
// are valid once the widening migrations (audit-p0-currencies, then
// p3-currencies-iso4217) have landed — both are applied in production.
// ───────────────────────────────────────────────────────────────────────────

/** Which write failed — picks the recovery advice that actually applies. */
export type LinkedWriteKind = 'loan' | 'settlement';

// PostgrestError is an Error subclass carrying { code, details, hint }, but a
// thrown value can also be a bare object or a string, so read defensively.
function errorText(err: unknown): { code: string; text: string } {
  if (typeof err === 'string') return { code: '', text: err };
  if (err && typeof err === 'object') {
    const e = err as Record<string, unknown>;
    const parts = [e.message, e.details, e.hint, e.constraint]
      .filter((v): v is string => typeof v === 'string');
    return { code: typeof e.code === 'string' ? e.code : '', text: parts.join(' | ') };
  }
  return { code: '', text: '' };
}

/**
 * True when the failure is a Postgres CHECK violation (SQLSTATE 23514) on a
 * currency constraint of the cross-user request tables — i.e. the database
 * still refuses this currency.
 *
 * Deliberately narrow: the other CHECKs on these tables (amount > 0, kind,
 * status, *_different_parties) never mention "currency", and the RPCs'
 * "currency mismatch" guards are plpgsql RAISEs (P0001), not 23514, so they
 * keep their own existing messages.
 */
export function isUnsupportedCurrencyError(err: unknown): boolean {
  const { code, text } = errorText(err);
  if (!text) return false;
  const isCheckViolation = code === '23514' || /violates check constraint/i.test(text);
  return isCheckViolation && /currency/i.test(text);
}

/**
 * True when the failure is a Postgres unique/primary-key violation (SQLSTATE
 * 23505). Cross-user request rows carry a CLIENT-supplied `id text primary
 * key`, so when a submit reuses its intent id (double tap, or a retry after an
 * ambiguous network failure) the second insert collides here instead of
 * creating a second, independently-acceptable request — the F-8 blast radius.
 * The stores translate that collision into "already created" and return the
 * existing row; the row is then re-read from the server, so a 23505 raised by
 * some OTHER unique constraint still fails loudly at the lookup.
 */
export function isDuplicateKeyError(err: unknown): boolean {
  const { code, text } = errorText(err);
  if (code === '23505') return true;
  return /duplicate key value violates unique constraint/i.test(text);
}

/**
 * Friendly copy for a linked-request WRITE failure, or `null` when the error
 * isn't one we recognise — callers keep their own fallback so genuine
 * diagnostics still reach the screen.
 */
export function friendlyLinkedWriteError(err: unknown, kind: LinkedWriteKind): string | null {
  if (isUnsupportedCurrencyError(err)) {
    return tStatic(kind === 'settlement'
      ? 'lsr_err_currency_unsupported'
      : 'ltr_err_currency_unsupported');
  }
  const { text } = errorText(err);
  if (!text) return null;
  const mapped = friendlyLinkedError(text);
  return mapped === text ? null : mapped;
}

/**
 * Marker class: an error whose `message` is already user-facing, localized
 * copy. Lets UI catch blocks skip their "wrap the raw detail in parentheses"
 * formatting and render the message as-is.
 */
export class FriendlyLinkedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FriendlyLinkedError';
  }
}

export function isFriendlyLinkedError(err: unknown): err is FriendlyLinkedError {
  return err instanceof FriendlyLinkedError;
}

/**
 * Wrap a linked-request write failure in localized copy when we recognise it,
 * otherwise hand the original error straight back (unknown failures keep their
 * diagnostic value). Intended for `throw translateLinkedWriteError(err, …)`.
 */
export function translateLinkedWriteError(err: unknown, kind: LinkedWriteKind): unknown {
  const friendly = friendlyLinkedWriteError(err, kind);
  return friendly ? new FriendlyLinkedError(friendly) : err;
}
