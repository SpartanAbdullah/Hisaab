// Which way a money notice moved the reader's balance, and where it stands
// after — the Splitwise second line ("You now owe Ali AED 120").
//
// The server stamps the facts on the notifications row
// (supabase-migration-notify-direction-and-balance.sql):
//   delta         the READER's signed move: + ⇒ owed more / owes less,
//                 − ⇒ owes more / owed less. On a request it is the move IF
//                 the reader accepts (pending is never counted — pendingLedger).
//   balanceAfter  the reader's signed net after the change (same sign rule as
//                 statementOfAccount: positive ⇒ the other side owes the reader).
//   balanceScope  'pair'   with one person (a linked loan; a group expense's
//                          payer; the other side of a settlement)
//                 'group'  the reader's overall net in the group (they paid,
//                          or were not a party to the settlement)
//                 'kameti' a committee position: rounds paid of total
//   counterpartyName  the 'pair' person for group rows (linked rows: actorName)
//
// This module is pure: it reads params, decides direction/tone and composes
// the line through an injected translator, so the Inbox card, the Activity
// feed and the tray text (instantNotify) all say the same thing.

import type { I18nKey } from './i18n';
import { formatMoney } from './constants';

export type BalanceDirection = 'up' | 'down' | 'flat';
/** Colour of the line: the STATE after the move (Splitwise green = owed to
 *  you, orange = you owe), never the direction — the arrow carries that. */
export type BalanceTone = 'receive' | 'pay' | 'neutral';
export type BalanceScope = 'pair' | 'group' | 'kameti';
export type BalanceLabel = 'now' | 'if_accepted' | 'if_confirmed' | 'still';

export interface BalanceMove {
  template: string;
  scope: BalanceScope;
  label: BalanceLabel;
  /** null when the row predates the delta stamp (notify-balance-after rows). */
  delta: number | null;
  direction: BalanceDirection;
  balanceAfter: number;
  currency: string;
  /** 'pair': the other person. Otherwise ''. */
  counterparty: string;
  /** Group rows name the group in the line ("Now in Flat 12: …"). */
  inGroup: boolean;
  /** kameti only */
  paidRounds: number | null;
  totalRounds: number | null;
}

export type BalanceTranslate = (key: I18nKey) => string;

const LINKED_TEMPLATES = new Set([
  'ltr_request', 'ltr_accepted', 'ltr_rejected',
  'lsr_request', 'lsr_accepted', 'lsr_rejected',
  'lsr_recorded', 'lsr_undone',
]);
const GROUP_TEMPLATES = new Set([
  'expense_added', 'expense_updated', 'expense_deleted',
  'settlement_added', 'settlement_deleted',
]);
const KAMETI_TEMPLATES = new Set([
  'kameti_contribution_recorded', 'kameti_contribution_removed', 'kameti_payout_recorded',
]);

const EPS = 0.005;

/** Numeric params arrive as JSON numbers, but a jsonb round-trip can hand
 *  back a string ("250.50") — accept both, reject anything else. */
export function readParamNumber(params: Record<string, unknown>, key: string): number | null {
  const raw = params[key];
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
  return Number.isFinite(n) ? n : null;
}

function readText(params: Record<string, unknown>, key: string): string {
  const v = params[key];
  return typeof v === 'string' ? v.trim() : '';
}

export function directionOf(delta: number | null): BalanceDirection {
  if (delta === null) return 'flat';
  if (delta > EPS) return 'up';
  if (delta < -EPS) return 'down';
  return 'flat';
}

function labelFor(template: string): BalanceLabel {
  if (template === 'ltr_request') return 'if_accepted';
  if (template === 'lsr_request') return 'if_confirmed';
  if (template === 'ltr_rejected' || template === 'lsr_rejected') return 'still';
  return 'now';
}

/** The balance facts on a row, or null when the row carries none (a legacy
 *  row, a template with no money, a reader the server could not compute for). */
export function readBalanceMove(
  template: string | null | undefined,
  params: Record<string, unknown> | null | undefined,
): BalanceMove | null {
  const tpl = (template ?? '').trim();
  if (!tpl || !params || typeof params !== 'object' || Array.isArray(params)) return null;
  const currency = readText(params, 'currency');

  if (LINKED_TEMPLATES.has(tpl)) {
    const balanceAfter = readParamNumber(params, 'balanceAfter');
    if (balanceAfter === null) return null;
    const balanceNow = readParamNumber(params, 'balanceNow');
    let delta = readParamNumber(params, 'delta');
    if (delta === null && balanceNow !== null) delta = Math.round((balanceAfter - balanceNow) * 100) / 100;
    return {
      template: tpl,
      scope: 'pair',
      label: labelFor(tpl),
      delta,
      direction: directionOf(delta),
      balanceAfter,
      currency,
      counterparty: readText(params, 'actorName'),
      inGroup: false,
      paidRounds: null,
      totalRounds: null,
    };
  }

  if (GROUP_TEMPLATES.has(tpl)) {
    const delta = readParamNumber(params, 'delta');
    const balanceAfter = readParamNumber(params, 'balanceAfter');
    if (delta === null || balanceAfter === null) return null;
    const scope: BalanceScope = readText(params, 'balanceScope') === 'pair' ? 'pair' : 'group';
    return {
      template: tpl,
      scope,
      label: 'now',
      delta,
      direction: directionOf(delta),
      balanceAfter,
      currency,
      counterparty: scope === 'pair' ? readText(params, 'counterpartyName') : '',
      inGroup: true,
      paidRounds: null,
      totalRounds: null,
    };
  }

  if (KAMETI_TEMPLATES.has(tpl)) {
    const delta = readParamNumber(params, 'delta');
    const paidTotal = readParamNumber(params, 'paidTotal');
    if (delta === null || paidTotal === null) return null;
    return {
      template: tpl,
      scope: 'kameti',
      label: 'now',
      delta,
      direction: directionOf(delta),
      balanceAfter: paidTotal,
      currency,
      counterparty: '',
      inGroup: false,
      paidRounds: readParamNumber(params, 'paidRounds'),
      totalRounds: readParamNumber(params, 'totalRounds'),
    };
  }

  return null;
}

/** Line colour. Pair/group: the state (owed to you / you owe / settled).
 *  Kameti has no "owe" state, so the direction colours it (in = pay, out
 *  to you = receive). */
export function balanceTone(move: BalanceMove): BalanceTone {
  if (move.scope === 'kameti') {
    return move.direction === 'up' ? 'receive' : move.direction === 'down' ? 'pay' : 'neutral';
  }
  if (move.balanceAfter > EPS) return 'receive';
  if (move.balanceAfter < -EPS) return 'pay';
  return 'neutral';
}

function fill(template: string, vars: Record<string, string>): string {
  let out = template;
  for (const [key, value] of Object.entries(vars)) out = out.split(`{${key}}`).join(value);
  return out;
}

const LABEL_KEYS: Record<BalanceLabel, I18nKey> = {
  now: 'ntf_bal_now',
  if_accepted: 'ntf_bal_if_accepted',
  if_confirmed: 'ntf_bal_if_confirmed',
  still: 'ntf_bal_still',
};

/** "Now: You owe Ali AED 120.00" / "Now in Flat 12: you are owed AED 300.00
 *  overall" / "Paid 3 of 10 rounds · AED 1,500.00 in so far". */
export function balanceLineText(
  move: BalanceMove,
  vars: { group?: string; someone?: string },
  t: BalanceTranslate,
): string {
  const currency = move.currency || 'PKR';
  if (move.scope === 'kameti') {
    return fill(t('ntf_kameti_position'), {
      paid: String(move.paidRounds ?? 0),
      total: String(move.totalRounds ?? 0),
      paidTotal: formatMoney(move.balanceAfter, currency),
    });
  }
  const amount = formatMoney(Math.abs(move.balanceAfter), currency);
  let phrase: string;
  if (move.scope === 'pair') {
    const name = move.counterparty || vars.someone || '';
    phrase = move.balanceAfter > EPS
      ? fill(t('stmt_net_owes_you'), { name, amount })
      : move.balanceAfter < -EPS
        ? fill(t('stmt_net_you_owe'), { name, amount })
        : fill(t('stmt_net_settled'), { name });
  } else {
    phrase = move.balanceAfter > EPS
      ? fill(t('ntf_group_net_owed'), { amount })
      : move.balanceAfter < -EPS
        ? fill(t('ntf_group_net_owe'), { amount })
        : t('ntf_group_net_settled');
  }
  const label = t(LABEL_KEYS[move.label]);
  return move.inGroup
    ? fill(t('ntf_bal_in_group'), { label, group: vars.group ?? '', balance: phrase })
    : fill(t('ntf_bal_plain'), { label, balance: phrase });
}

/** The reader's move on a GROUP row ("Your share: AED 50.00" / "AED 20.00 in
 *  your favour" / "Nothing changes for you"). Linked and kameti rows carry
 *  the move in their event sentence already, so this returns ''. */
export function moveText(move: BalanceMove, t: BalanceTranslate): string {
  if (!move.inGroup || move.delta === null) return '';
  const amount = formatMoney(Math.abs(move.delta), move.currency || 'PKR');
  if (move.template === 'expense_added') {
    if (move.direction === 'down') return fill(t('ntf_move_share'), { amount });
    if (move.direction === 'up') return fill(t('ntf_move_paid'), { amount });
    return t('ntf_move_not_yours');
  }
  if (move.direction === 'up') return fill(t('ntf_move_up'), { amount });
  if (move.direction === 'down') return fill(t('ntf_move_down'), { amount });
  return t('ntf_move_flat');
}

/** The tray cannot colour; it gets the arrow as a character. */
export function directionGlyph(direction: BalanceDirection): string {
  return direction === 'up' ? '▲' : direction === 'down' ? '▼' : '';
}
