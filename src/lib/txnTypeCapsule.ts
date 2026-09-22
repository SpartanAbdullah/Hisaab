// One colour capsule per transaction type on every Inbox / notification row
// (founder, 2026-09-21: a long list of pending requests to one contact read
// as identical rows — Lent, Borrowed and Paid back were hard to tell apart).
//
// Everything here is from the READER's side: a request where the other
// person lent to me is "Borrowed" for me, and a settlement on a loan I gave
// is "Received back". The capsule always carries its word — colour is never
// the only signal (a11y) — and its tone is one of the contrast-tested
// `.m-chip-*` classes in src/index.css (designTokens.test.ts covers each
// text-on-fill pair in both themes).
//
// Tone map (semantic):
//   lent            receive (green)  — they owe me
//   borrowed        pay (coral)      — I owe them
//   received_back   blue             — a settlement paid to me
//   paid_back       pink             — a settlement I paid (pink, not violet,
//                                      so it never doubles the violet
//                                      "pending" status chip on the same card)
//   payment         neutral          — settlement whose side we can't resolve
//   past_record     neutral          — modifier beside Lent / Borrowed
//   group_*         blue             — groups' domain colour (these rows live
//                                      on the Info tab, never beside
//                                      received_back)
//   kameti          gold             — kameti's domain colour
//   contact         violet           — connections (the Inbox's own colour)
//   update          neutral          — anything else / system
//
// Pure: no store reads, no DOM. Words come from i18n keys at the render site.

import type { I18nKey } from './i18n';
import type { LoanType } from '../db/types';

export type TxnTypeKind =
  | 'lent'
  | 'borrowed'
  | 'received_back'
  | 'paid_back'
  | 'payment'
  | 'past_record'
  | 'group_expense'
  | 'group_settle'
  | 'group'
  | 'group_invite'
  | 'kameti'
  | 'contact'
  | 'update';

export type CapsuleTone = 'receive' | 'pay' | 'blue' | 'pink' | 'violet' | 'gold' | 'neutral';

export interface TxnTypeCapsule {
  labelKey: I18nKey;
  tone: CapsuleTone;
}

export const TXN_TYPE_CAPSULE: Record<TxnTypeKind, TxnTypeCapsule> = {
  lent: { labelKey: 'cap_lent', tone: 'receive' },
  borrowed: { labelKey: 'cap_borrowed', tone: 'pay' },
  received_back: { labelKey: 'cap_received_back', tone: 'blue' },
  paid_back: { labelKey: 'cap_paid_back', tone: 'pink' },
  payment: { labelKey: 'cap_payment', tone: 'neutral' },
  past_record: { labelKey: 'inbox_past_record_tag', tone: 'neutral' },
  group_expense: { labelKey: 'cap_group_expense', tone: 'blue' },
  group_settle: { labelKey: 'cap_group_settle', tone: 'blue' },
  group: { labelKey: 'cap_group', tone: 'blue' },
  group_invite: { labelKey: 'cap_group_invite', tone: 'blue' },
  kameti: { labelKey: 'cap_kameti', tone: 'gold' },
  contact: { labelKey: 'cap_contact', tone: 'violet' },
  update: { labelKey: 'cap_update', tone: 'neutral' },
};

/** The `.m-chip-*` modifier for a tone (src/index.css). */
export function capsuleToneClass(tone: CapsuleTone): string {
  return `m-chip-${tone}`;
}

/** A linked loan request, seen by me. `kind` is written from the SENDER's
 *  side ('lent' = the sender lent), so the receiver reads it flipped. */
export function linkedRequestKind(kind: 'lent' | 'borrowed', iAmSender: boolean): TxnTypeKind {
  const senderLent = kind === 'lent';
  return senderLent === iAmSender ? 'lent' : 'borrowed';
}

/** A settlement request, seen by me: my own loan in the pair says which side
 *  I'm on — a loan I gave is being paid back TO me. Unknown (loan not loaded,
 *  or degraded data) stays a neutral "Payment" rather than guessing. */
export function settlementKind(myLoanType: LoanType | null | undefined): TxnTypeKind {
  if (myLoanType === 'given') return 'received_back';
  if (myLoanType === 'taken') return 'paid_back';
  return 'payment';
}

/** The AcceptIntoAccountSheet's request: direction is already from the
 *  acceptor's side ('in' = the money landed with me). */
export function acceptSheetKind(
  flavor: 'loan' | 'settlement',
  direction: 'in' | 'out' | 'unknown',
): TxnTypeKind {
  if (flavor === 'loan') {
    // They lent me money (it came in) → I borrowed; it went out → I lent.
    if (direction === 'in') return 'borrowed';
    if (direction === 'out') return 'lent';
    return 'payment';
  }
  if (direction === 'in') return 'received_back';
  if (direction === 'out') return 'paid_back';
  return 'payment';
}

/** A persisted notification row (Inbox → Info feed). Template wins over the
 *  coarse `type`, so a group expense and a group settle-up read differently. */
export function notificationKind(n: { type?: string | null; template?: string | null }): TxnTypeKind {
  const template = (n.template ?? '').trim();
  if (template.startsWith('kameti_') || n.type === 'kameti') return 'kameti';
  if (template.startsWith('expense_')) return 'group_expense';
  if (template.startsWith('settlement_')) return 'group_settle';
  if (n.type === 'invite') return 'group_invite';
  if (
    n.type === 'group_update' ||
    template === 'group_added' ||
    template.startsWith('member_') ||
    template.startsWith('group_')
  ) {
    return 'group';
  }
  if (n.type === 'contact_linked') return 'contact';
  return 'update';
}
