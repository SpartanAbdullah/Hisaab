// One-page PDF rendering of a Statement of Account.
//
// Approach: build a fully self-contained, inline-styled DOM node offscreen,
// rasterise it with modern-screenshot, then place that image onto a single A4
// page with jsPDF. Rendering the DOM (rather than drawing text with jsPDF's
// core fonts) means the BROWSER shapes the text — so contact names in any
// script (Urdu/Arabic included) render correctly, and the output matches the
// app's look without embedding fonts. jsPDF + modern-screenshot are lazy
// dynamic-imported so they never touch the initial app bundle.
//
// The layout is grounded in fintech/accounting/typography research: the shared
// Hisaab letterhead (pdfLetterhead.ts — the app's navy hero with the violet
// accent), one HERO net number per currency, a canonical received/gave/balance
// ledger, a CVD-safe color system (teal-green #047857 you'll receive /
// vermillion #C2410C you need to pay, always paired with a sign + label so
// color is never the sole cue — WCAG 1.4.1), tabular figures with the currency
// stated once, restraint over ornament (hairlines, no zebra), and honest trust
// scaffolding (statement number, period, E&OE) with no fake verification marks.
//
// ONE language per document — the app's current language (founder,
// 2026-09-19: the English + roman-Urdu repeats were redundant). Every word
// comes from i18n.ts through the translator (default: the live UI language);
// numbers, dates and the ledger maths are language-free and unchanged.

import { tStatic } from './i18n';
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
  type LetterheadMeta,
} from './pdfLetterhead';
import { renderHtmlToA4Pdf } from './renderNodeToImage';
import { trimSection } from './statementOfAccount';
import type { Statement, StatementLine, StatementSection } from './statementOfAccount';
import {
  describeStatementLine,
  earlierEntriesLabel,
  fillTemplate,
  payOrReceiveMode,
  type DocT,
} from './statementText';

const { ink: INK, muted: MUTED, hairline: HAIRLINE, rowline: ROWLINE, navy: NAVY } = PDF_COLORS;
// Direction (CVD-safe: differ in hue AND luminance; always paired with sign + label)
const POS = '#047857'; // you'll receive / money in  (~4.9:1 on white)
const NEG = '#C2410C'; // you need to pay / money out (~5.0:1 on white)
const NEUTRAL = '#4B5563'; // zero / settled        (~7:1 on white)
const POS_LABEL = '#036249'; // darker teal for small labels on tinted fills
// Hero tints (fill only — never the sole carrier of meaning)
const POS_TINT = '#ECFDF5';
const NEG_TINT = '#FEF2F2';

const MAX_ROWS_PER_SECTION = 16;

function fmtDateShort(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
}

// "Hide amounts": swap every bare ledger number for the fixed-width mask. No
// currency symbol here — the ledger states the currency once per section.
type AmountFmt = (n: number) => string;
function amountFmt(hideAmounts: boolean): AmountFmt {
  return hideAmounts ? () => AMOUNT_MASK : pdfAmount;
}

// Signed, color-coded balance. Color is redundant with the +/− sign so a
// grayscale print or a color-blind reader loses nothing.
function balanceCellHtml(n: number, fmt: AmountFmt = pdfAmount): string {
  if (n > 0.005) return `<span style="color:${POS};">+${fmt(n)}</span>`;
  if (n < -0.005) return `<span style="color:${NEG};">−${fmt(n)}</span>`;
  return `<span style="color:${NEUTRAL};">${fmt(0)}</span>`;
}

// Deterministic, human-readable statement number (no persisted sequence). Same
// party + same as-of day ⇒ same number, so a re-generated statement is stable.
function statementNumber(statement: Statement, override?: string): string {
  if (override) return override;
  const d = new Date(statement.asOf);
  const ym = Number.isNaN(d.getTime())
    ? '000000'
    : `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`;
  const seed = statement.partyName + statement.asOf.slice(0, 10);
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  const suffix = h.toString(36).toUpperCase().slice(0, 4).padStart(4, '0');
  return `HIS-${ym}-${suffix}`;
}

function periodRange(statement: Statement): string | null {
  const dates = statement.sections.flatMap((s) => s.lines.map((l) => l.date)).filter(Boolean);
  if (dates.length === 0) return null;
  const from = dates.reduce((a, b) => (a.localeCompare(b) <= 0 ? a : b));
  return `${pdfDate(from)} – ${pdfDate(statement.asOf)}`;
}

// One currency's headline: what the READER pays or receives. The eyebrow names
// the direction + currency, the figure carries the sign, and the line under it
// names the other party — each fact stated once.
function heroRowHtml(section: StatementSection, big: boolean, t: DocT, senderName?: string, hideAmounts = false): string {
  const fmt = amountFmt(hideAmounts);
  // Recipient perspective: they PAY when they owe (out ⇒ red, −), they RECEIVE
  // when they're owed (in ⇒ green, +). Settled celebrates in green — a clean
  // slate is good news, not a gray zero.
  const mode = payOrReceiveMode(section.closing);
  const owe = mode === 'pay';
  const settled = mode === 'settled';
  const tint = owe ? NEG_TINT : POS_TINT;
  const color = owe ? NEG : POS;
  const labelColor = owe ? NEG : POS_LABEL;
  const eyebrow = fillTemplate(
    t(settled ? 'stmt_pdf_hero_settled' : owe ? 'stmt_pdf_hero_pay' : 'stmt_pdf_hero_receive'),
    { currency: section.currency },
  );
  const figure = settled
    ? `<p style="margin:4px 0 0;font-size:${big ? 21 : 16}px;font-weight:700;color:${color};letter-spacing:-0.01em;">${esc(t('stmt_pdf_hero_nothing'))}</p>`
    : `<p style="margin:4px 0 0;font-size:${big ? 34 : 23}px;font-weight:700;color:${color};letter-spacing:-0.01em;">${owe ? '− ' : '+ '}${fmt(section.closing)}</p>`;
  const who = senderName?.trim();
  const counterparty = who
    ? `<p style="margin:5px 0 0;font-size:13px;color:${INK};">${esc(fillTemplate(
      t(settled ? 'stmt_pdf_hero_with' : owe ? 'stmt_pdf_hero_to' : 'stmt_pdf_hero_from'),
      { name: who },
    ))}</p>`
    : '';
  return `<div style="background:${tint};border-radius:8px;padding:15px 18px;">
    <p style="margin:0;font-size:10px;color:${labelColor};letter-spacing:0.08em;text-transform:uppercase;font-weight:600;">${esc(eyebrow)}</p>
    ${figure}
    ${counterparty}
  </div>`;
}

function heroBlockHtml(statement: Statement, t: DocT, senderName?: string, hideAmounts = false): string {
  if (!statement.hasActivity) {
    return `<div style="margin:18px 44px 0;background:${POS_TINT};border-radius:8px;padding:16px 18px;">
      <p style="margin:0;font-size:16px;font-weight:700;color:${POS};">${esc(t('stmt_all_settled'))}</p>
    </div>`;
  }
  const big = statement.sections.length === 1;
  const rows = statement.sections.map((s) => heroRowHtml(s, big, t, senderName, hideAmounts)).join('');
  return `<div style="margin:18px 44px 0;display:flex;flex-direction:column;gap:10px;">${rows}</div>`;
}

function ledgerRowHtml(line: StatementLine, t: DocT, fmt: AmountFmt = pdfAmount): string {
  // Description prefers the human note; the received/gave column position
  // already encodes the entry type. Otherwise the line is phrased from the
  // reader's side ("You borrowed", "You paid back").
  // Recipient-focused colour: "You received" adds to what THEY owe (red = you'll
  // pay this), "You gave" is a payment they made (green = reduces what you owe).
  // The running balance is negated to the recipient's side (owe = −red,
  // receive = +green).
  const desc = esc(line.note || describeStatementLine(line, t));
  // Fold/summary lines carry gross two-sided flows (given AND repaid, net
  // zero) — show both so the reader's payments never look erased.
  const debit = line.grossGiven && line.grossGiven > 0.005
    ? `<span style="color:${NEG};">${fmt(line.grossGiven)}</span>`
    : line.delta > 0.005 ? `<span style="color:${NEG};">${fmt(line.delta)}</span>` : '';
  const credit = line.grossRepaid && line.grossRepaid > 0.005
    ? `<span style="color:${POS};">${fmt(line.grossRepaid)}</span>`
    : line.delta < -0.005 ? `<span style="color:${POS};">${fmt(line.delta)}</span>` : '';
  return `<tr>
    <td style="padding:7px 6px 7px 0;color:${MUTED};white-space:nowrap;vertical-align:top;border-top:1px solid ${ROWLINE};">${fmtDateShort(line.date)}</td>
    <td style="padding:7px 6px;color:${INK};vertical-align:top;border-top:1px solid ${ROWLINE};">${desc}</td>
    <td style="padding:7px 6px;text-align:right;white-space:nowrap;border-top:1px solid ${ROWLINE};">${debit}</td>
    <td style="padding:7px 6px;text-align:right;white-space:nowrap;border-top:1px solid ${ROWLINE};">${credit}</td>
    <td style="padding:7px 0 7px 6px;text-align:right;white-space:nowrap;border-top:1px solid ${ROWLINE};">${balanceCellHtml(-line.balance, fmt)}</td>
  </tr>`;
}

function sectionHtml(section: StatementSection, t: DocT, hideAmounts = false): string {
  const fmt = amountFmt(hideAmounts);
  const { opening, lines } = trimSection(section, MAX_ROWS_PER_SECTION);
  const openingBalance = opening ? opening.balance : 0;
  const openingLabel = opening
    ? `${t('stmt_bf')} · ${earlierEntriesLabel(opening.count, t)}`
    : t('stmt_pdf_opening');

  // Period totals over the VISIBLE rows so opening + debits − credits = closing
  // reconciles exactly with what's printed.
  let totalDebit = 0;
  let totalCredit = 0;
  for (const l of lines) {
    // Gross lines add equally to both sides (net zero on the balance), so
    // the totals row reflects the REAL money story: everything given,
    // everything paid back, and the difference still reconciles.
    if (l.grossGiven) totalDebit += l.grossGiven;
    if (l.grossRepaid) totalCredit += l.grossRepaid;
    if (l.delta > 0.005) totalDebit += l.delta;
    else if (l.delta < -0.005) totalCredit += -l.delta;
  }

  const estimatedNote = section.estimated
    ? `<p style="margin:8px 0 0;font-size:11px;color:${MUTED};">${esc(t('stmt_estimated_note'))}</p>`
    : '';
  const th = 'font-weight:600;padding:8px 6px 6px;';

  return `<div style="padding:16px 44px 0;">
    <div style="display:flex;justify-content:space-between;align-items:baseline;border-bottom:1px solid ${HAIRLINE};padding-bottom:6px;">
      <span style="font-size:10px;color:${MUTED};letter-spacing:0.06em;text-transform:uppercase;font-weight:600;">${esc(t('stmt_pdf_activity'))}</span>
      <span style="font-size:10px;color:${MUTED};">${esc(fillTemplate(t('stmt_pdf_amounts_in'), { currency: section.currency }))}</span>
    </div>
    <table style="width:100%;border-collapse:collapse;margin-top:2px;font-size:12.5px;font-variant-numeric:tabular-nums;">
      <thead>
        <tr style="color:${MUTED};font-size:10px;letter-spacing:0.05em;text-transform:uppercase;">
          <th style="${th}text-align:left;padding-left:0;">${esc(t('stmt_pdf_col_date'))}</th>
          <th style="${th}text-align:left;">${esc(t('stmt_pdf_col_desc'))}</th>
          <th style="${th}text-align:right;">${esc(t('stmt_pdf_col_received'))}</th>
          <th style="${th}text-align:right;">${esc(t('stmt_pdf_col_gave'))}</th>
          <th style="${th}text-align:right;padding-right:0;">${esc(t('stmt_pdf_col_balance'))}</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td style="padding:7px 6px 7px 0;color:${MUTED};border-top:1px solid ${ROWLINE};">—</td>
          <td style="padding:7px 6px;color:${MUTED};font-style:italic;border-top:1px solid ${ROWLINE};">${esc(openingLabel)}</td>
          <td style="border-top:1px solid ${ROWLINE};"></td>
          <td style="border-top:1px solid ${ROWLINE};"></td>
          <td style="padding:7px 0 7px 6px;text-align:right;border-top:1px solid ${ROWLINE};">${balanceCellHtml(-openingBalance, fmt)}</td>
        </tr>
        ${lines.map((l) => ledgerRowHtml(l, t, fmt)).join('')}
      </tbody>
      <tfoot>
        <tr style="border-top:2px solid ${NAVY};">
          <td colspan="2" style="padding:10px 6px 0 0;font-weight:600;color:${INK};">${esc(t('stmt_pdf_closing'))}</td>
          <td style="padding:10px 6px 0;text-align:right;font-weight:600;color:${NEG};">${fmt(totalDebit)}</td>
          <td style="padding:10px 6px 0;text-align:right;font-weight:600;color:${POS};">${fmt(totalCredit)}</td>
          <td style="padding:10px 0 0 6px;text-align:right;font-weight:700;">${balanceCellHtml(-section.closing, fmt)}</td>
        </tr>
      </tfoot>
    </table>
    ${estimatedNote}
  </div>`;
}

export interface StatementPdfOptions {
  fromName?: string; // current user's display name — shown as "Prepared by" and signs off the statement
  phone?: string | null; // counterparty phone, shown under their name when known
  refCode?: string; // override the auto statement number
  greeting?: string; // friendly opener, e.g. "Hello Rashid," — empty ⇒ omitted
  hideAmounts?: boolean; // privacy: every figure renders as the fixed-width mask
  t?: DocT; // language of the document; default = the app's current language
}

// Inline styles for the offscreen page node — the shared PDF page node.
// Exported so a dev harness / test can render the exact same markup a browser
// rasterises into the PDF.
export const STATEMENT_NODE_STYLE = PDF_NODE_STYLE;

// The full inner markup of the statement page. Pure string → deterministic and
// unit-testable; generateStatementPdf rasterises it.
export function renderStatementInnerHtml(statement: Statement, opts: StatementPdfOptions = {}): string {
  const t = opts.t ?? tStatic;
  const period = periodRange(statement);
  const meta: LetterheadMeta[] = [
    { text: fillTemplate(t('stmt_pdf_no'), { no: statementNumber(statement, opts.refCode) }), tone: 'mono' },
    { text: fillTemplate(t('stmt_as_of'), { date: pdfDate(statement.asOf) }), tone: 'strong' },
  ];
  if (period) meta.push({ text: fillTemplate(t('stmt_pdf_period'), { range: period }), tone: 'muted' });

  const partyPhone = opts.phone
    ? `<p style="margin:1px 0 0;font-size:12px;color:${MUTED};">${esc(opts.phone)}</p>`
    : '';
  const preparedBy = opts.fromName
    ? `<div style="text-align:right;">
        <p style="margin:0;font-size:10px;color:${MUTED};letter-spacing:0.06em;text-transform:uppercase;">${esc(t('stmt_pdf_prepared_by'))}</p>
        <p style="margin:3px 0 0;font-size:13px;font-weight:600;color:${INK};">${esc(opts.fromName)}</p>
      </div>`
    : '';
  // Warm opener + sign-off so the statement reads as a message, not an export.
  const greetingHtml = opts.greeting?.trim()
    ? `<div style="padding:14px 44px 0;"><p style="margin:0;font-size:15px;color:${INK};">${esc(opts.greeting.trim())}</p></div>`
    : '';
  const signOffHtml = opts.fromName?.trim()
    ? `<div style="padding:16px 44px 4px;">
        <p style="margin:0;font-size:12.5px;color:${MUTED};">${esc(t('stmt_thanks'))}</p>
        <p style="margin:2px 0 0;font-size:14px;font-weight:600;color:${INK};">${esc(opts.fromName.trim())}</p>
      </div>`
    : '';
  // How to read the signs, then the honest scaffolding.
  const footerNote =
    `<span style="color:${NEG};font-weight:600;">${esc(t('stmt_pdf_legend_pay'))}</span> &nbsp;·&nbsp; ` +
    `<span style="color:${POS};font-weight:600;">${esc(t('stmt_pdf_legend_receive'))}</span><br>` +
    esc(fillTemplate(t('stmt_pdf_generated'), { date: pdfDateTime(statement.asOf) }));

  return `
    ${letterheadHtml(t('soa_title'), meta)}

    <div style="padding:18px 44px 0;display:flex;justify-content:space-between;gap:20px;align-items:flex-start;">
      <div>
        <p style="margin:0;font-size:10px;color:${MUTED};letter-spacing:0.06em;text-transform:uppercase;">${esc(t('stmt_pdf_account_of'))}</p>
        <p style="margin:4px 0 0;font-size:25px;font-weight:700;color:${INK};letter-spacing:-0.015em;line-height:1.1;">${esc(statement.partyName)}</p>
        ${partyPhone}
      </div>
      ${preparedBy}
    </div>

    ${greetingHtml}

    ${heroBlockHtml(statement, t, opts.fromName, !!opts.hideAmounts)}

    ${statement.hasActivity ? statement.sections.map((s) => sectionHtml(s, t, !!opts.hideAmounts)).join('') : ''}

    ${signOffHtml}

    ${pdfFooterHtml(footerNote, t('stmt_pdf_page'))}
  `;
}

export interface StatementPdfResult {
  blob: Blob;
  filename: string;
}

export async function generateStatementPdf(
  statement: Statement,
  opts: StatementPdfOptions = {},
): Promise<StatementPdfResult> {
  const t = opts.t ?? tStatic;
  const html = renderStatementInnerHtml(statement, { ...opts, t });
  const title = t('soa_title');
  const blob = await renderHtmlToA4Pdf(html, {
    width: PDF_PAGE_W,
    nodeStyle: STATEMENT_NODE_STYLE, // carries min-height so the footer pins to the page bottom
    scale: 2,
    title: `${title} — ${statement.partyName}`,
    subject: `${title} · ${fillTemplate(t('stmt_as_of'), { date: pdfDate(statement.asOf) })}`,
    author: opts.fromName || 'Hisaab',
  });
  // Local date, not UTC — a Gulf user generating at 00:15 local would
  // otherwise get yesterday's date in the filename while the statement
  // itself says today. en-CA formats as YYYY-MM-DD.
  const datePart = new Date(statement.asOf).toLocaleDateString('en-CA');
  const filename = `Statement-${sanitizeFilename(statement.partyName, 'contact')}-${datePart}.pdf`;
  return { blob, filename };
}
