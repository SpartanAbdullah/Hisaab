// From a parsed bank alert to a Quick Entry preset. Pure; tested.
//
// Three small jobs the CaptureSheet and App.tsx share:
//   1. `readCaptureParams` — the two URL params the Android side delivers a
//      capture through (`?capture=<text>` from the share sheet,
//      `?capture_id=<id>` from the notification listener's tap).
//   2. `matchCaptureAccount` — which of the user's accounts the alert names.
//      Conservative on purpose: a wrong account silently moves money in the
//      wrong book, so an ambiguous or currency-mismatched hint matches nothing
//      and the user picks in Quick Entry.
//   3. `buildCapturePreset` — the prefilled Quick Entry (amount, direction,
//      account, merchant as the note, a category learned from history).

import type { AlertDirection, ParsedAlert } from './bankAlertParser';
import { suggestCategory, type HistoryTxn } from './categorySuggest';

export type CaptureSource = 'share' | 'notification' | 'email';

export interface CaptureParams {
  /** Raw shared text (share sheet). */
  text?: string;
  /** Id of a candidate held by the native listener's queue. */
  captureId?: string;
  /** Id of a capture_candidates row written by the inbound-email function. */
  captureEmailId?: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The share sheet caps text natively; mirror it so a crafted URL cannot
 *  hand the sheet megabytes. */
export const CAPTURE_TEXT_MAX = 4000;

export function readCaptureParams(search: string): CaptureParams | null {
  const params = new URLSearchParams(search);
  const text = params.get('capture');
  const captureId = params.get('capture_id');
  if (text && text.trim()) return { text: text.slice(0, CAPTURE_TEXT_MAX) };
  if (captureId && /^[A-Za-z0-9_-]{1,64}$/.test(captureId)) return { captureId };
  const captureEmailId = params.get('capture_email');
  if (captureEmailId && UUID_RE.test(captureEmailId)) return { captureEmailId: captureEmailId.toLowerCase() };
  return null;
}

/** The same search string without the capture params (so Back / reload does
 *  not re-open the sheet). Returns '' or '?a=b'. */
export function stripCaptureParams(search: string): string {
  const params = new URLSearchParams(search);
  params.delete('capture');
  params.delete('capture_id');
  params.delete('capture_email');
  const rest = params.toString();
  return rest ? `?${rest}` : '';
}

export interface CaptureAccountLike {
  id: string;
  name: string;
  type: string;
  currency: string;
  metadata: Record<string, string>;
  deletedAt?: string | null;
}

/**
 * Pick the account an alert belongs to.
 *   - last-4 hint → the one live account whose `metadata.last4` matches AND
 *     whose currency is the alert's; two matches or a currency clash → null.
 *   - no hint → only when exactly one live account holds that currency.
 */
export function matchCaptureAccount<A extends CaptureAccountLike>(
  parsed: Pick<ParsedAlert, 'currency' | 'accountHint'>,
  accounts: ReadonlyArray<A>,
): A | null {
  const live = accounts.filter((a) => !a.deletedAt);
  if (parsed.accountHint) {
    const byDigits = live.filter((a) => a.metadata?.last4 === parsed.accountHint);
    if (byDigits.length === 1 && byDigits[0].currency === parsed.currency) return byDigits[0];
    return null;
  }
  const sameCurrency = live.filter((a) => a.currency === parsed.currency);
  return sameCurrency.length === 1 ? sameCurrency[0] : null;
}

export interface CapturePreset {
  type: 'expense' | 'income';
  amount: number;
  accountId?: string;
  notes?: string;
  category?: string;
}

export function buildCapturePreset(
  parsed: Pick<ParsedAlert, 'amount' | 'merchant'>,
  direction: AlertDirection,
  account: CaptureAccountLike | null,
  history: ReadonlyArray<HistoryTxn>,
): CapturePreset {
  const type = direction === 'credit' ? 'income' : 'expense';
  const preset: CapturePreset = { type, amount: parsed.amount };
  if (account) preset.accountId = account.id;
  if (parsed.merchant) {
    preset.notes = parsed.merchant;
    const category = suggestCategory(parsed.merchant, history, type);
    if (category) preset.category = category;
  }
  return preset;
}
