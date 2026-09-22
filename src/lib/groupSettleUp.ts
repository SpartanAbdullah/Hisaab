// Group settle-up — the Statement of Account, for splits.
//
// Turns the group's pairwise debts (from groupDebts.computePairwiseDebts) into
// (a) a recipient-focused card for one member ("You pay Ali AED 120 · Bilal pays
// you AED 30") and (b) a full "who pays whom" plan. Recipient-focused and
// written in ONE language — the app's current one (founder, 2026-09-19;
// backlog 2026-09-22 item 8b) — delivered over WhatsApp text (reaches non-app
// members). Pure + tested; the PDF renderer and modal compose these.

import { formatMoney } from './constants';
import { moneyFormatter } from './maskMoney';
import type { GroupDebt } from './groupDebts';
import { MONEY_TOLERANCE } from './moneyTolerance';
import { tStatic } from './i18n';
import { fillTemplate, type DocT } from './statementText';

export interface MemberSettleUp {
  net: number; // signed: + this member receives overall, − they pay overall
  owes: GroupDebt[]; // debts where this member is the payer (`from`)
  owed: GroupDebt[]; // debts where this member is the payee (`to`)
}

// The transfers that involve `memberId`, plus their net position in the group.
export function memberSettleUp(debts: ReadonlyArray<GroupDebt>, memberId: string): MemberSettleUp {
  const owes = debts.filter((d) => d.from === memberId);
  const owed = debts.filter((d) => d.to === memberId);
  const owesTotal = owes.reduce((s, d) => s + d.amount, 0);
  const owedTotal = owed.reduce((s, d) => s + d.amount, 0);
  return { net: Math.round((owedTotal - owesTotal) * 100) / 100, owes, owed };
}

export interface MemberCardOptions {
  groupName: string;
  currency: string;
  greeting?: string;
  fromName?: string;
  hideAmounts?: boolean; // privacy: every figure renders as the fixed-width mask
}

// Recipient-focused WhatsApp body for one member: their net + the exact
// transfers they should make/receive. `t` defaults to the live UI language.
export function buildMemberCardText(su: MemberSettleUp, opts: MemberCardOptions, t: DocT = tStatic): string {
  const { groupName, currency, greeting, fromName } = opts;
  const money = moneyFormatter(!!opts.hideAmounts);
  const out: string[] = [];
  if (greeting?.trim()) {
    out.push(greeting.trim());
    out.push('');
  }
  out.push(`*${fillTemplate(t('stmt_gsu_card_title'), { group: groupName })}*`);

  if (su.net > MONEY_TOLERANCE) out.push(fillTemplate(t('stmt_gsu_card_receive'), { amount: money(su.net, currency) }));
  else if (su.net < -MONEY_TOLERANCE) out.push(fillTemplate(t('stmt_gsu_card_pay'), { amount: money(Math.abs(su.net), currency) }));
  else out.push(fillTemplate(t('stmt_gsu_card_settled'), { group: groupName }));

  if (su.owes.length > 0 || su.owed.length > 0) {
    out.push('');
    for (const d of su.owes) {
      out.push(`• ${fillTemplate(t('stmt_gsu_card_you_pay'), { name: d.toName, amount: money(d.amount, currency) })}`);
    }
    for (const d of su.owed) {
      out.push(`• ${fillTemplate(t('stmt_gsu_card_pays_you'), { name: d.fromName, amount: money(d.amount, currency) })}`);
    }
  }

  if (fromName?.trim()) {
    out.push('');
    out.push(t('stmt_thanks'));
    out.push(fromName.trim());
  }
  out.push('');
  out.push(t('stmt_via'));
  return out.join('\n');
}

// The whole group's plan as text (every X-pays-Y transfer).
export function buildFullPlanText(
  debts: ReadonlyArray<GroupDebt>,
  groupName: string,
  currency: string,
  t: DocT = tStatic,
): string {
  const out: string[] = [];
  out.push(`*${fillTemplate(t('stmt_gsu_card_title'), { group: groupName })}*`);
  if (debts.length === 0) {
    out.push(t('stmt_gsu_all_settled'));
  } else {
    out.push('');
    for (const d of debts) {
      out.push(`• ${fillTemplate(t('stmt_gsu_plan_line'), { from: d.fromName, to: d.toName, amount: formatMoney(d.amount, currency) })}`);
    }
  }
  out.push('');
  out.push(t('stmt_via'));
  return out.join('\n');
}
