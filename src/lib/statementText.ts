// Plain-text rendering of a Statement of Account, for the WhatsApp deep-link
// body (wa.me carries text only) and the "copy" fallback. The PDF renderer in
// statementPdf.ts is the richer sibling; this is the always-available,
// zero-dependency path that works for any contact, app user or not.
//
// ONE language per message — the app's current language (founder, 2026-09-19:
// the old English + roman-Urdu repeats were redundant). Every sentence comes
// from src/lib/i18n.ts; the translator defaults to tStatic (the live UI
// language) and can be injected (tests, or a caller holding useT()). Dates and
// amounts are language-free and computed exactly as before.
//
// The statement is SENT to the counterparty, so it speaks to them: a loan the
// user gave them reads "You borrowed", and each currency's headline says what
// THEY pay or receive.

import { format } from 'date-fns';
import { formatMoney } from './constants';
import { tStatic, type I18nKey } from './i18n';
import { moneyFormatter } from './maskMoney';
import type { Statement, StatementLine, StatementLineKind } from './statementOfAccount';
import { trimSection } from './statementOfAccount';

// formatMoney-compatible formatter threaded through the render helpers so the
// "Hide amounts" toggle swaps every figure for the mask in one place.
export type MoneyFmt = (amount: number, currency: string) => string;

// Translator for document copy: an i18n key → its text in ONE language.
export type DocT = (key: I18nKey) => string;

// Fill `{name}`-style placeholders in a single pass: a substituted value is
// never re-scanned (a name like "{amount}" stays literal) and `$` sequences in
// a value are not special. Unknown placeholders are left as they are.
export function fillTemplate(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : match,
  );
}

// A friendly opener so the statement reads as a message between two people, not
// a bank export. The style is user-selectable; default 'hello'.
export type GreetingStyle = 'hello' | 'salaam' | 'dear' | 'none';

const GREETING_KEY: Record<Exclude<GreetingStyle, 'none'>, I18nKey> = {
  hello: 'stmt_greet_hello',
  salaam: 'stmt_greet_salaam',
  dear: 'stmt_greet_dear',
};

export function greetingLine(style: GreetingStyle, name: string, t: DocT = tStatic): string {
  const n = name.trim();
  if (!n || style === 'none') return '';
  const key = GREETING_KEY[style];
  return key ? fillTemplate(t(key), { name: n }) : '';
}

// The in-app headline on the Send-statement sheet — the SENDER's own view of a
// signed net balance. Positive ⇒ they owe you.
export function netBalanceLabel(
  partyName: string,
  closing: number,
  currency: string,
  fmt: MoneyFmt = formatMoney,
  t: DocT = tStatic,
): string {
  if (closing > 0.005) return fillTemplate(t('stmt_net_owes_you'), { name: partyName, amount: fmt(closing, currency) });
  if (closing < -0.005) return fillTemplate(t('stmt_net_you_owe'), { name: partyName, amount: fmt(Math.abs(closing), currency) });
  return fillTemplate(t('stmt_net_settled'), { name: partyName });
}

// RECIPIENT-focused. The statement is addressed to the account holder, so it
// must tell THEM whether they pay or receive. `closing` is the internal
// (sender-side) net where positive = "they owe you"; from the recipient's seat
// that means THEY must pay. Colour then follows the recipient: pay = out (red),
// receive = in (green).
export type PayReceiveMode = 'pay' | 'receive' | 'settled';

export function payOrReceiveMode(closing: number): PayReceiveMode {
  if (closing > 0.005) return 'pay';
  if (closing < -0.005) return 'receive';
  return 'settled';
}

export interface PayReceiveText {
  mode: PayReceiveMode;
  text: string; // one sentence, in the translator's language
}

export function payOrReceiveLabel(
  closing: number,
  currency: string,
  senderName?: string,
  fmt: MoneyFmt = formatMoney,
  t: DocT = tStatic,
): PayReceiveText {
  const mode = payOrReceiveMode(closing);
  const amount = fmt(Math.abs(closing), currency);
  const name = senderName?.trim();
  if (mode === 'pay') {
    // Recipient owes the sender ⇒ recipient must PAY.
    return { mode, text: name ? fillTemplate(t('stmt_pay_to'), { name, amount }) : fillTemplate(t('stmt_pay'), { amount }) };
  }
  if (mode === 'receive') {
    // Sender owes the recipient ⇒ recipient will RECEIVE.
    return { mode, text: name ? fillTemplate(t('stmt_receive_from'), { name, amount }) : fillTemplate(t('stmt_receive'), { amount }) };
  }
  // A clean slate is good news — one warm line, not a gray zero.
  return { mode, text: fillTemplate(t('stmt_settled_in'), { currency }) };
}

// Ledger-line wording, from the reader's side. `settled_earlier` picks its
// singular/plural key below.
const LINE_KEY: Record<Exclude<StatementLineKind, 'settled_earlier'>, I18nKey> = {
  loan_given: 'stmt_line_you_borrowed',
  loan_taken: 'stmt_line_you_lent',
  repayment_received: 'stmt_line_you_repaid',
  repayment_paid: 'stmt_line_repaid_to_you',
  repayments_received_summary: 'stmt_line_you_repaid_summary',
  repayments_made_summary: 'stmt_line_repaid_to_you_summary',
  settled_recent: 'stmt_line_settled_recent_many',
  settled_in_full: 'stmt_line_settled_in_full',
};

export function describeStatementLine(line: StatementLine, t: DocT = tStatic): string {
  const n = line.count ?? 0;
  const base =
    line.kind === 'settled_earlier'
      ? n === 1
        ? t('stmt_line_settled_earlier_one')
        : fillTemplate(t('stmt_line_settled_earlier_many'), { n })
      : fillTemplate(t(LINE_KEY[line.kind]), { n });
  // Name the loan on a repayment / settle line that has no note of its own.
  return line.loanNote ? `${base} — ${line.loanNote}` : base;
}

// "4 earlier entries" — the rows a brought-forward line stands for.
export function earlierEntriesLabel(count: number, t: DocT = tStatic): string {
  return count === 1 ? t('stmt_earlier_one') : fillTemplate(t('stmt_earlier_many'), { n: count });
}

function signedAmount(delta: number, currency: string, fmt: MoneyFmt = formatMoney): string {
  const sign = delta < 0 ? '−' : '+'; // − vs +
  return `${sign}${fmt(Math.abs(delta), currency)}`;
}

function shortDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : format(d, 'd MMM yyyy');
}

function lineText(line: StatementLine, currency: string, fmt: MoneyFmt, t: DocT): string {
  // Fold/summary lines: equal money given and paid back — show the amount that
  // was cleared (✓) instead of a meaningless "+0.00".
  // Otherwise, recipient perspective: negate so a charge (they owe more) reads
  // as −out and a payment they made reads as +in, matching the PDF's columns.
  const amount = line.grossGiven || line.grossRepaid
    ? `${fmt(line.grossRepaid ?? line.grossGiven ?? 0, currency)} ✓`
    : signedAmount(-line.delta, currency, fmt);
  const parts = [shortDate(line.date), describeStatementLine(line, t), amount];
  return `• ${parts.filter(Boolean).join(' · ')}`; // • date · desc · +amt
}

export interface RenderStatementTextOptions {
  asOfLabel?: string; // pre-formatted date; defaults to formatting statement.asOf
  maxLinesPerSection?: number; // keep the message short; older lines fold to b/f
  greeting?: string; // pre-composed opener, e.g. "Hello Rashid,"
  fromName?: string; // signs the message off: "Thank you, {fromName}"
  hideAmounts?: boolean; // privacy: every figure renders as the fixed-width mask
  t?: DocT; // language of the message; default = the app's current language
}

export function renderStatementText(statement: Statement, opts: RenderStatementTextOptions = {}): string {
  const t = opts.t ?? tStatic;
  const { partyName, sections } = statement;
  const asOf = opts.asOfLabel ?? shortDate(statement.asOf);
  const maxLines = opts.maxLinesPerSection ?? 10;
  const money = moneyFormatter(!!opts.hideAmounts);

  const out: string[] = [];
  if (opts.greeting?.trim()) {
    out.push(opts.greeting.trim());
    out.push('');
  }
  out.push(`*${t('soa_title')}*`);
  out.push(partyName);
  if (asOf) out.push(fillTemplate(t('stmt_as_of'), { date: asOf }));

  if (sections.length === 0) {
    out.push('');
    out.push(t('stmt_all_settled'));
  }

  // Each currency: its headline once (what the reader pays / receives), then
  // the entries behind it. No closing repeat of the headline.
  for (const section of sections) {
    out.push(''); // blank line between blocks
    out.push(payOrReceiveLabel(section.closing, section.currency, opts.fromName, money, t).text);

    const { opening, lines } = trimSection(section, maxLines);
    if (opening) {
      out.push(
        `• ${t('stmt_bf')} · ${signedAmount(-opening.balance, section.currency, money)}` +
          ` (${earlierEntriesLabel(opening.count, t)})`,
      );
    }
    for (const line of lines) out.push(lineText(line, section.currency, money, t));
    if (section.estimated) out.push(`(${t('stmt_estimated_note')})`);
  }

  if (opts.fromName?.trim()) {
    out.push('');
    out.push(t('stmt_thanks'));
    out.push(opts.fromName.trim());
  }

  out.push('');
  out.push(t('stmt_via'));
  return out.join('\n');
}
