// Kameti payout slip — the WhatsApp / copy text sibling of kametiSlipPdf.ts.
//
// ONE language — the app's current one (founder, 2026-09-19; backlog
// 2026-09-22 item 8b). It used to be composed inline in KametiPayoutSlipSheet
// with a hardcoded roman-Urdu "Shukriya!" under an English line and an English
// "via Hisaab" sign-off under an Urdu one. Every sentence now comes from
// i18n.ts through the translator (default: the live UI language); amounts are
// language-free and honour the "Hide amounts" mask.

import { tStatic } from './i18n';
import { moneyFormatter } from './maskMoney';
import { fillTemplate, type DocT } from './statementText';

export interface KametiSlipTextInput {
  committeeName: string;
  currency: string;
  pool: number;
  round: number;
  totalRounds: number;
  witnessUrl?: string;
  organiserName?: string;
  hideAmounts?: boolean;
}

export function buildKametiSlipText(input: KametiSlipTextInput, t: DocT = tStatic): string {
  const money = moneyFormatter(!!input.hideAmounts);
  const lines: string[] = [];
  lines.push(`*${t('kslip_title')} — ${input.committeeName}*`);
  lines.push(
    fillTemplate(t('kslip_received_line'), {
      amount: money(input.pool, input.currency),
      r: input.round,
      n: input.totalRounds,
    }),
  );
  lines.push(t('stmt_kslip_thanks'));
  if (input.witnessUrl) {
    lines.push('');
    lines.push(`${t('kslip_verify')}: ${input.witnessUrl}`);
  }
  lines.push('');
  const organiser = input.organiserName?.trim();
  lines.push(organiser ? fillTemplate(t('stmt_kslip_signoff'), { name: organiser }) : t('stmt_via'));
  return lines.join('\n');
}
