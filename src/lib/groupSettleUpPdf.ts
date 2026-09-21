// One-page "settle-up plan" PDF for a split group: every X-pays-Y transfer plus
// the itemised expenses behind them. Reuses the shared renderNodeToImage core
// and the shared Hisaab PDF frame (pdfLetterhead.ts — navy letterhead with the
// violet accent, hairlines, tabular figures, currency stated once, E&OE).
//
// ONE language per document — the app's current language (founder,
// 2026-09-19). Copy comes from i18n.ts through the translator (default: the
// live UI language); amounts and dates are language-free.

import { tStatic } from './i18n';
import { localIso } from './localDate';
import { AMOUNT_MASK } from './maskMoney';
import {
  PDF_COLORS,
  PDF_NODE_STYLE,
  PDF_PAGE_W,
  escapeHtml as esc,
  letterheadHtml,
  pdfAmount,
  pdfDate,
  pdfDateTime,
  pdfFooterHtml,
  sanitizeFilename,
} from './pdfLetterhead';
import { renderHtmlToA4Pdf } from './renderNodeToImage';
import { fillTemplate, type DocT } from './statementText';
import type { GroupDebt } from './groupDebts';

const { ink: INK, muted: MUTED, hairline: HAIRLINE, rowline: ROWLINE, navy: NAVY } = PDF_COLORS;

export interface GroupPlanExpense {
  date: string; // ISO
  description: string;
  paidByName: string;
  amount: number;
}

export interface GroupSettleUpPdfInput {
  groupName: string;
  emoji?: string;
  currency: string;
  debts: ReadonlyArray<GroupDebt>;
  expenses: ReadonlyArray<GroupPlanExpense>;
  simplify: boolean;
  asOf: string; // ISO
  fromName?: string;
  hideAmounts?: boolean; // privacy: every figure renders as the fixed-width mask
  t?: DocT; // language of the document; default = the app's current language
}

export function renderGroupSettleUpInnerHtml(input: GroupSettleUpPdfInput): string {
  const { groupName, emoji, currency, debts, expenses, simplify, asOf } = input;
  const t = input.t ?? tStatic;
  // "Hide amounts": bare-number mask (currency is stated once in the header).
  const fmt = input.hideAmounts ? () => AMOUNT_MASK : pdfAmount;

  const transfersRows = debts.length === 0
    ? `<tr><td colspan="3" style="padding:10px 6px 10px 0;color:${MUTED};font-style:italic;border-top:1px solid ${ROWLINE};">${esc(t('stmt_gsu_all_settled'))}</td></tr>`
    : debts.map((d) => `<tr>
        <td style="padding:8px 6px 8px 0;border-top:1px solid ${ROWLINE};">${esc(d.fromName)}</td>
        <td style="padding:8px 6px;border-top:1px solid ${ROWLINE};color:${MUTED};">→ ${esc(d.toName)}</td>
        <td style="padding:8px 0 8px 6px;text-align:right;white-space:nowrap;border-top:1px solid ${ROWLINE};font-weight:600;">${fmt(d.amount)}</td>
      </tr>`).join('');

  const expenseTotal = expenses.reduce((s, e) => s + e.amount, 0);
  const expenseRows = expenses.length === 0
    ? `<tr><td colspan="4" style="padding:10px 6px 10px 0;color:${MUTED};font-style:italic;border-top:1px solid ${ROWLINE};">${esc(t('stmt_gsu_no_expenses'))}</td></tr>`
    : expenses.map((e) => `<tr>
        <td style="padding:7px 6px 7px 0;color:${MUTED};white-space:nowrap;border-top:1px solid ${ROWLINE};">${pdfDate(e.date)}</td>
        <td style="padding:7px 6px;border-top:1px solid ${ROWLINE};">${esc(e.description || '—')}</td>
        <td style="padding:7px 6px;color:${MUTED};border-top:1px solid ${ROWLINE};">${esc(e.paidByName)}</td>
        <td style="padding:7px 0 7px 6px;text-align:right;white-space:nowrap;border-top:1px solid ${ROWLINE};">${fmt(e.amount)}</td>
      </tr>`).join('');

  const th = 'font-weight:600;padding:8px 6px 6px;';

  return `
    ${letterheadHtml(t('stmt_gsu_doc'), [
      { text: fillTemplate(t('stmt_as_of'), { date: pdfDate(asOf) }), tone: 'strong' },
      { text: t(simplify ? 'stmt_gsu_simplified' : 'stmt_gsu_direct'), tone: 'muted' },
    ])}

    <div style="padding:18px 44px 0;">
      <p style="margin:0;font-size:10px;color:${MUTED};letter-spacing:0.06em;text-transform:uppercase;">${esc(t('stmt_gsu_group'))}</p>
      <p style="margin:4px 0 0;font-size:24px;font-weight:700;color:${INK};letter-spacing:-0.015em;">${emoji ? `${esc(emoji)} ` : ''}${esc(groupName)}</p>
    </div>

    <div style="padding:18px 44px 0;">
      <div style="display:flex;justify-content:space-between;align-items:baseline;border-bottom:1px solid ${HAIRLINE};padding-bottom:6px;">
        <span style="font-size:10px;color:${MUTED};letter-spacing:0.06em;text-transform:uppercase;font-weight:600;">${esc(t('stmt_gsu_who_pays'))}</span>
        <span style="font-size:10px;color:${MUTED};">${esc(fillTemplate(t('stmt_pdf_amounts_in'), { currency }))}</span>
      </div>
      <table style="width:100%;border-collapse:collapse;margin-top:2px;font-size:13px;font-variant-numeric:tabular-nums;">
        <tbody>${transfersRows}</tbody>
      </table>
    </div>

    <div style="padding:20px 44px 0;">
      <div style="border-bottom:1px solid ${HAIRLINE};padding-bottom:6px;">
        <span style="font-size:10px;color:${MUTED};letter-spacing:0.06em;text-transform:uppercase;font-weight:600;">${esc(t('stmt_gsu_expenses'))}</span>
      </div>
      <table style="width:100%;border-collapse:collapse;margin-top:2px;font-size:12.5px;font-variant-numeric:tabular-nums;">
        <thead>
          <tr style="color:${MUTED};font-size:10px;letter-spacing:0.05em;text-transform:uppercase;">
            <th style="${th}text-align:left;padding-left:0;">${esc(t('stmt_pdf_col_date'))}</th>
            <th style="${th}text-align:left;">${esc(t('stmt_pdf_col_desc'))}</th>
            <th style="${th}text-align:left;">${esc(t('stmt_gsu_col_paid_by'))}</th>
            <th style="${th}text-align:right;padding-right:0;">${esc(t('stmt_gsu_col_amount'))}</th>
          </tr>
        </thead>
        <tbody>${expenseRows}</tbody>
        <tfoot>
          <tr style="border-top:2px solid ${NAVY};">
            <td colspan="3" style="padding:10px 6px 0 0;font-weight:600;">${esc(t('stmt_gsu_total'))}</td>
            <td style="padding:10px 0 0 6px;text-align:right;font-weight:700;">${fmt(expenseTotal)}</td>
          </tr>
        </tfoot>
      </table>
    </div>

    ${pdfFooterHtml(esc(fillTemplate(t('stmt_gsu_footer'), { date: pdfDateTime(asOf) })), t('stmt_pdf_page'))}
  `;
}

export interface GroupSettleUpPdfResult {
  blob: Blob;
  filename: string;
}

export async function generateGroupSettleUpPdf(input: GroupSettleUpPdfInput): Promise<GroupSettleUpPdfResult> {
  const t = input.t ?? tStatic;
  const html = renderGroupSettleUpInnerHtml({ ...input, t });
  const blob = await renderHtmlToA4Pdf(html, {
    width: PDF_PAGE_W,
    nodeStyle: PDF_NODE_STYLE,
    scale: 2,
    title: `${t('stmt_gsu_doc')} — ${input.groupName}`,
    subject: t('stmt_gsu_doc'),
    author: input.fromName || 'Hisaab',
  });
  // Local calendar day, not toISOString() (UTC) — generating this near local
  // midnight in this app's UTC+4/+5 markets must not date-stamp the filename
  // a day early.
  const datePart = localIso(new Date(input.asOf));
  const filename = `SettleUp-${sanitizeFilename(input.groupName, 'group')}-${datePart}.pdf`;
  return { blob, filename };
}
