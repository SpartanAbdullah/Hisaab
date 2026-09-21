// Payment-received receipt text.
//
// The mirror image of a reminder: when money ARRIVES, the receiver sends a warm
// acknowledgement back to the PAYER ("Received AED 500 from you on 3 Jul —
// remaining AED 1,500."). Addressed to the payer ("from you"), strictly
// single-currency, no-custody framing (it records that money was received; it
// never moves money or implies interest).
//
// ONE language — the app's current language (founder, 2026-09-19: the old
// English line + roman-Urdu repeat was redundant). Copy comes from i18n.ts
// through the translator (default: the live UI language); the date and amounts
// are language-free.
//
// Delivered over WhatsApp text so it reaches non-app-users, same as the reminder
// and statement. Pure + unit-tested; the UI (SendStatementModal) composes it.

import { format } from 'date-fns';
import { tStatic } from './i18n';
import { moneyFormatter } from './maskMoney';
import { fillTemplate, type DocT } from './statementText';

export interface ReceiptTextInput {
  receivedAmount: number;
  currency: string;
  // Remaining balance AFTER this payment. null ⇒ not derivable here (e.g. a
  // linked settlement accept) — the receipt then omits the remaining clause.
  remaining: number | null;
  date: string; // ISO timestamp of when it was received
  fromName?: string; // the receiver's own name — signs the receipt off
  greeting?: string; // optional opener, e.g. "Hello Rashid,"
  hideAmounts?: boolean; // privacy: every figure renders as the fixed-width mask
  t?: DocT; // language of the receipt; default = the app's current language
}

export interface ReceiptText {
  line: string; // the "Received …" sentence
  message: string; // full assembled WhatsApp body
}

function shortDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : format(d, 'dd MMM yyyy');
}

export function buildReceiptText(input: ReceiptTextInput): ReceiptText {
  const { receivedAmount, currency, remaining, fromName, greeting } = input;
  const t = input.t ?? tStatic;
  const money = moneyFormatter(!!input.hideAmounts);
  const amount = money(receivedAmount, currency);
  const date = shortDate(input.date);

  const base = date
    ? fillTemplate(t('stmt_rcpt_received_on'), { amount, date })
    : fillTemplate(t('stmt_rcpt_received'), { amount });
  let line: string;
  if (remaining === null || remaining === undefined) {
    line = `${base}.`;
  } else if (remaining <= 0.005) {
    line = `${base} — ${t('stmt_rcpt_settled')}.`;
  } else {
    line = `${base} — ${fillTemplate(t('stmt_rcpt_remaining'), { amount: money(remaining, currency) })}.`;
  }

  const out: string[] = [];
  if (greeting?.trim()) {
    out.push(greeting.trim());
    out.push('');
  }
  out.push(`*${t('rcpt_title')}*`);
  out.push(line);
  if (fromName?.trim()) {
    out.push('');
    out.push(t('stmt_thanks'));
    out.push(fromName.trim());
  }
  out.push('');
  out.push(t('stmt_via'));

  return { line, message: out.join('\n') };
}
