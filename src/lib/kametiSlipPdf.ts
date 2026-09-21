// Kameti (committee/ROSCA) payout slip — a premium one-pager the organiser
// sends to the member who just took their baari: the payout, who received it,
// their position so far. Footed with the anonymous witness link so a
// suspicious member can verify the honest ledger + provably-fair draw
// independently. Reuses the shared renderNodeToImage core and the shared
// Hisaab PDF frame (pdfLetterhead.ts — navy letterhead with the violet accent).
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

const { ink: INK, muted: MUTED, hairline: HAIRLINE } = PDF_COLORS;
const POS = '#047857';
const POS_TINT = '#ECFDF5';

export interface KametiSlipInput {
  committeeName: string;
  currency: string;
  round: number;
  totalRounds: number;
  pool: number; // the payout amount
  recipientName: string;
  contributed: number; // recipient's contributions so far
  net: number; // received − contributed
  witnessUrl?: string; // anonymous "verify live" link
  date: string; // ISO payout date
  organiserName?: string;
  // Privacy: every figure renders as the fixed-width mask. NOTE the witness
  // link (when present) still opens the live ledger with real amounts — the
  // slip's trust seal is deliberately not maskable.
  hideAmounts?: boolean;
  t?: DocT; // language of the document; default = the app's current language
}

export function renderKametiSlipInnerHtml(input: KametiSlipInput): string {
  const { committeeName, currency, round, totalRounds, pool, recipientName, contributed, net, witnessUrl, date, organiserName } = input;
  const t = input.t ?? tStatic;
  // "Hide amounts": bare-number mask (currency is stated once in the hero label).
  const fmt = input.hideAmounts ? () => AMOUNT_MASK : pdfAmount;

  const witnessBlock = witnessUrl
    ? `<div style="padding:18px 44px 0;">
        <div style="border:1px solid ${HAIRLINE};border-radius:8px;padding:14px 16px;">
          <p style="margin:0;font-size:11px;color:${MUTED};font-weight:600;letter-spacing:0.04em;text-transform:uppercase;">${esc(t('stmt_kslip_verify_title'))}</p>
          <p style="margin:6px 0 0;font-size:13px;color:${INK};font-family:ui-monospace,SFMono-Regular,Menlo,monospace;word-break:break-all;">${esc(witnessUrl)}</p>
          <p style="margin:6px 0 0;font-size:11px;color:${MUTED};">${esc(t('stmt_kslip_verify_body'))}</p>
        </div>
      </div>`
    : '';

  const preparedBy = organiserName
    ? `<div style="text-align:right;"><p style="margin:0;font-size:10px;color:${MUTED};letter-spacing:0.06em;text-transform:uppercase;">${esc(t('stmt_kslip_organiser'))}</p><p style="margin:3px 0 0;font-size:13px;font-weight:600;color:${INK};">${esc(organiserName)}</p></div>`
    : '';

  return `
    ${letterheadHtml(t('kslip_title'), [
      { text: fillTemplate(t('stmt_kslip_round'), { r: round, n: totalRounds }), tone: 'strong' },
      { text: pdfDate(date), tone: 'muted' },
    ])}

    <div style="padding:18px 44px 0;display:flex;justify-content:space-between;gap:20px;align-items:flex-start;">
      <div>
        <p style="margin:0;font-size:10px;color:${MUTED};letter-spacing:0.06em;text-transform:uppercase;">${esc(t('stmt_kslip_committee'))}</p>
        <p style="margin:4px 0 0;font-size:24px;font-weight:700;color:${INK};letter-spacing:-0.015em;">${esc(committeeName)}</p>
      </div>
      ${preparedBy}
    </div>

    <div style="margin:18px 44px 0;background:${POS_TINT};border-radius:8px;padding:16px 18px;">
      <p style="margin:0;font-size:10px;color:${POS};letter-spacing:0.08em;text-transform:uppercase;font-weight:600;">${esc(fillTemplate(t('stmt_kslip_payout'), { currency }))}</p>
      <p style="margin:4px 0 0;font-size:34px;font-weight:700;color:${POS};letter-spacing:-0.01em;">${fmt(pool)}</p>
      <p style="margin:5px 0 0;font-size:13px;color:${INK};">${esc(fillTemplate(t('stmt_kslip_received_by'), { name: recipientName }))}</p>
    </div>

    <div style="padding:18px 44px 0;">
      <div style="display:flex;gap:44px;">
        <div>
          <p style="margin:0;font-size:10px;color:${MUTED};letter-spacing:0.05em;text-transform:uppercase;">${esc(t('stmt_kslip_contributed'))}</p>
          <p style="margin:4px 0 0;font-size:20px;font-weight:600;">${fmt(contributed)}</p>
        </div>
        <div>
          <p style="margin:0;font-size:10px;color:${MUTED};letter-spacing:0.05em;text-transform:uppercase;">${esc(t('stmt_kslip_net'))}</p>
          <p style="margin:4px 0 0;font-size:20px;font-weight:600;color:${net >= 0 ? POS : INK};">${net >= 0 ? '+' : '−'}${fmt(net)}</p>
        </div>
      </div>
    </div>

    ${witnessBlock}

    ${pdfFooterHtml(esc(fillTemplate(t('stmt_kslip_footer'), { date: pdfDateTime(date) })), t('stmt_pdf_page'))}
  `;
}

export interface KametiSlipResult {
  blob: Blob;
  filename: string;
}

export async function generateKametiSlipPdf(input: KametiSlipInput): Promise<KametiSlipResult> {
  const t = input.t ?? tStatic;
  const html = renderKametiSlipInnerHtml({ ...input, t });
  const blob = await renderHtmlToA4Pdf(html, {
    width: PDF_PAGE_W,
    nodeStyle: PDF_NODE_STYLE,
    scale: 2,
    title: `${t('kslip_title')} — ${input.committeeName} (${fillTemplate(t('stmt_kslip_round'), { r: input.round, n: input.totalRounds })})`,
    subject: t('kslip_title'),
    author: input.organiserName || 'Hisaab',
  });
  // Local calendar day, not toISOString() (UTC) — generating this near local
  // midnight in this app's UTC+4/+5 markets must not date-stamp the filename
  // a day early.
  const datePart = localIso(new Date(input.date));
  const filename = `Kameti-Payout-${sanitizeFilename(input.committeeName, 'kameti')}-R${input.round}-${datePart}.pdf`;
  return { blob, filename };
}
