// Full-history, multi-page Statement of Account (2026-10-06, the Ghulam
// exercise). The one-page statement (statementPdf.ts) trims to 16 rows and
// folds settled loans — right for a quick nudge, wrong when the reader doubts
// the total and needs to follow EVERY step. This document:
//
//   page 1  — per currency: the hero, a reconciliation box
//             (opening + increased − decreased = closing, "checks out"), and
//             what is still awaiting confirmation (shown, never counted);
//             then the month-by-month table;
//   then    — every entry, month by month, each with the total after it. A
//             lump payment the allocation flow fanned out across loans reads
//             as ONE payment row (bold, carries the balance) with the loans it
//             cleared indented under it.
//
// Pagination is deterministic: every row has a fixed height (single line,
// ellipsis), the flow is cut into pages by those heights, and a page that
// opens or closes mid-ledger carries a brought-forward / carried-forward row so
// each page reconciles on its own. generateFullStatementPdf measures every
// page before rasterising and re-cuts tighter if one overflows — rows are
// never clipped. Pure HTML strings; same language rules as statementPdf.ts
// (one language per document, all copy from i18n.ts).

import type { Currency } from '../db';
import { tStatic } from './i18n';
import type { PendingBucket } from './pendingLedger';
import {
  PDF_COLORS,
  PDF_NODE_STYLE,
  PDF_PAGE_H,
  PDF_PAGE_W,
  escapeHtml as esc,
  letterheadHtml,
  pdfDate,
  pdfDateTime,
  pdfFooterHtml,
  sanitizeFilename,
  type LetterheadMeta,
} from './pdfLetterhead';
import { measureHtmlHeights, renderPagesToA4Pdf } from './renderNodeToImage';
import type { Statement, StatementLine, StatementSection } from './statementOfAccount';
import {
  NEG,
  POS,
  amountFmt,
  balanceCellHtml,
  fmtDateShort,
  heroRowHtml,
  lineColumns,
  periodRange,
  readerSign,
  renderStatementInnerHtml,
  statementNumber,
  type AmountFmt,
  type StatementPdfOptions,
} from './statementPdf';
import {
  groupByMonth,
  groupRepaymentBursts,
  monthLabel,
  sectionOrientation,
  summarizeSection,
  type DisplayRow,
  type MonthBlock,
} from './statementRows';
import { describeStatementLine, fillTemplate, payOrReceiveMode, type DocT, type StatementPerspective } from './statementText';

const { ink: INK, muted: MUTED, hairline: HAIRLINE, rowline: ROWLINE, navy: NAVY, footerTint: TINT } = PDF_COLORS;
// Pending box: amber reads "not final yet" — never confused with the
// pay (vermillion) / receive (teal) money colours.
const AMBER_INK = '#92400E';
const AMBER_TINT = '#FFFBEB';
const AMBER_LINE = '#F59E0B';

export interface FullStatementPdfOptions extends StatementPdfOptions {
  pending?: ReadonlyMap<Currency, PendingBucket>; // pendingLedger.buildPendingItems
  batchKeyOf?: (line: StatementLine) => string | null | undefined; // settlementBatchKeys
  duplicateLoanIds?: ReadonlyMap<string, number>; // pendingLedger.duplicateMirrorLoans
  monthOf?: (iso: string) => string; // tests pin months to UTC
  capacityScale?: number; // < 1 re-cuts tighter (overflow guard)
}

// ── Fixed geometry (CSS px on the 794 × 1123 A4 node) ────────────────────────
const H = {
  letterhead: 126, // navy band incl. up to 4 meta lines + violet rule
  party: 86, // "Account of" block on page 1
  greeting: 36,
  slim: 34, // "Account of X (continued)" strip on later pages
  footer: 66,
  signOff: 60, // reserved on every page so the last one always fits it
  slack: 24,
  sectionTitle: 30, // "Month by month · AED" / "Every entry · AED"
  thead: 26,
  row: 24,
  child: 20,
  month: 28,
  subtotal: 26,
  bf: 24, // brought / carried forward
  close: 34,
  mtRow: 22,
  hero: 114,
  summary: 124,
  pendingBase: 58, // title + "if all are accepted" line + padding
  pendingItem: 20,
  cardGap: 16,
} as const;

export type LedgerItem =
  | { k: 'lg_head'; cur: Currency; h: number; bal: number; balBefore: number }
  | { k: 'month'; cur: Currency; h: number; block: MonthBlock; bal: number; balBefore: number }
  | { k: 'row'; cur: Currency; h: number; row: DisplayRow; bal: number; balBefore: number }
  | { k: 'child'; cur: Currency; h: number; line: StatementLine; bal: number; balBefore: number }
  | { k: 'subtotal'; cur: Currency; h: number; block: MonthBlock; received: number; gave: number; bal: number; balBefore: number }
  | { k: 'lg_close'; cur: Currency; h: number; received: number; gave: number; bal: number; balBefore: number };

export type FlowItem =
  | { k: 'card'; cur: Currency; h: number }
  | { k: 'mt_head'; cur: Currency; h: number }
  | { k: 'mt_row'; cur: Currency; h: number; block: MonthBlock }
  | LedgerItem;

const isLedger = (i: FlowItem): i is LedgerItem =>
  i.k === 'lg_head' || i.k === 'month' || i.k === 'row' || i.k === 'child' || i.k === 'subtotal' || i.k === 'lg_close';

export interface Unit {
  items: FlowItem[];
  h: number;
}

interface CurrencyCtx {
  section: StatementSection;
  o: 1 | -1; // internal orientation (statementRows.sectionOrientation)
  months: MonthBlock[];
}

const round2 = (n: number): number => Math.round(n * 100) / 100 || 0;

// Reader-side money columns of any signed delta (a burst parent has no line).
function deltaCols(delta: number, r: 1 | -1): { received: number; gave: number } {
  return lineColumns({ delta } as StatementLine, r);
}
function rowCols(row: DisplayRow, r: 1 | -1) {
  return row.type === 'line' ? lineColumns(row.line, r) : deltaCols(row.delta, r);
}

// ── Flow ──────────────────────────────────────────────────────────────────────

function buildCtx(statement: Statement, opts: FullStatementPdfOptions): Map<Currency, CurrencyCtx> {
  const out = new Map<Currency, CurrencyCtx>();
  for (const section of statement.sections) {
    const o = sectionOrientation(section);
    const rows = groupRepaymentBursts(section.lines, { batchKeyOf: opts.batchKeyOf });
    out.set(section.currency, { section, o, months: groupByMonth(rows, { orientation: o, monthOf: opts.monthOf }) });
  }
  return out;
}

function cardHeight(cur: Currency, opts: FullStatementPdfOptions): number {
  const pending = opts.pending?.get(cur);
  const pendingH = pending && pending.items.length > 0 ? H.pendingBase + pending.items.length * H.pendingItem + 10 : 0;
  return H.cardGap + H.hero + 10 + H.summary + pendingH;
}

// A collapsed-border table row renders 1px taller than its CSS height (the
// hairline between rows). Budget it so long pages can't creep past the box.
const B = 1;

function buildUnits(statement: Statement, ctx: Map<Currency, CurrencyCtx>, opts: FullStatementPdfOptions, r: 1 | -1, capN: number): Unit[] {
  const units: Unit[] = [];
  const currencies = statement.sections.map((s) => s.currency);

  for (const cur of currencies) {
    const h = cardHeight(cur, opts);
    units.push({ items: [{ k: 'card', cur, h }], h });
  }

  for (const cur of currencies) {
    const { months } = ctx.get(cur)!;
    months.forEach((block, i) => {
      const row: FlowItem = { k: 'mt_row', cur, h: H.mtRow + B, block };
      if (i === 0) {
        const head: FlowItem = { k: 'mt_head', cur, h: H.sectionTitle + H.thead };
        units.push({ items: [head, row], h: head.h + row.h });
      } else {
        units.push({ items: [row], h: row.h });
      }
    });
  }

  for (const cur of currencies) {
    const { section, months } = ctx.get(cur)!;
    let pendingHead: LedgerItem[] = [{ k: 'lg_head', cur, h: H.sectionTitle + H.thead + H.bf + B, bal: 0, balBefore: 0 }];
    let totalReceived = 0;
    let totalGave = 0;
    let lastBal = 0;
    for (const block of months) {
      const opening = block.rows[0]?.balanceBefore ?? lastBal;
      let monthHead: LedgerItem[] = [{ k: 'month', cur, h: H.month + B, block, bal: opening, balBefore: opening }];
      let mReceived = 0;
      let mGave = 0;
      for (const row of block.rows) {
        const cols = rowCols(row, r);
        mReceived += cols.received;
        mGave += cols.gave;
        const items: LedgerItem[] = [{ k: 'row', cur, h: H.row + B, row, bal: row.balanceAfter, balBefore: row.balanceBefore }];
        if (row.type === 'burst') {
          for (const child of row.children) {
            items.push({ k: 'child', cur, h: H.child + B, line: child, bal: row.balanceAfter, balBefore: row.balanceAfter });
          }
        }
        // Keep a section / month header with the first row under it.
        const lead = [...pendingHead, ...monthHead];
        pendingHead = [];
        monthHead = [];
        pushLedgerUnits(units, [...lead, ...items], capN);
        lastBal = row.balanceAfter;
      }
      totalReceived += mReceived;
      totalGave += mGave;
      const sub: LedgerItem = {
        k: 'subtotal', cur, h: H.subtotal + B, block,
        received: round2(mReceived), gave: round2(mGave), bal: lastBal, balBefore: lastBal,
      };
      units.push({ items: [sub], h: sub.h });
    }
    const close: LedgerItem = {
      k: 'lg_close', cur, h: H.close + 2 * B,
      received: round2(totalReceived), gave: round2(totalGave), bal: section.closing, balBefore: section.closing,
    };
    // The closing row rides with the last month's subtotal.
    const last = units[units.length - 1];
    if (last && last.items[0].k === 'subtotal' && last.items[0].cur === cur) {
      last.items.push(close);
      last.h += close.h;
    } else {
      units.push({ items: [close], h: close.h });
    }
  }
  return units;
}

// A burst taller than a page (dozens of loans in one payment) is cut at child
// boundaries — the continuation repeats nothing, the b/f row carries the
// balance, and every child still appears exactly once.
function pushLedgerUnits(units: Unit[], items: LedgerItem[], capN: number) {
  const max = capN - (H.sectionTitle + H.thead + H.bf + H.bf);
  let chunk: LedgerItem[] = [];
  let h = 0;
  for (const item of items) {
    if (chunk.length > 0 && h + item.h > max) {
      units.push({ items: chunk, h });
      chunk = [];
      h = 0;
    }
    chunk.push(item);
    h += item.h;
  }
  if (chunk.length) units.push({ items: chunk, h });
}

// What a page that OPENS mid-table must repeat: title + column head (+ the
// brought-forward row on the ledger).
function continuationCost(first: FlowItem): number {
  if (first.k === 'mt_row') return H.sectionTitle + H.thead;
  if (isLedger(first) && first.k !== 'lg_head') return H.sectionTitle + H.thead + H.bf + B;
  return 0;
}

export function paginateFlow(units: readonly Unit[], cap1: number, capN: number): FlowItem[][] {
  const pages: FlowItem[][] = [];
  let page: FlowItem[] = [];
  let room = cap1;
  for (const u of units) {
    const first = u.items[0];
    // Room for a carried-forward row if this unit leaves the ledger open.
    const tail = isLedger(first) ? H.bf + B : 0;
    if (page.length > 0 && u.h + tail > room) {
      pages.push(page);
      page = [];
      room = capN;
    }
    const cont = page.length === 0 && pages.length > 0 ? continuationCost(first) : 0;
    page.push(...u.items);
    room -= u.h + cont;
  }
  if (page.length) pages.push(page);
  return pages;
}

// ── HTML pieces ──────────────────────────────────────────────────────────────

interface RenderCtx {
  statement: Statement;
  ctx: Map<Currency, CurrencyCtx>;
  opts: FullStatementPdfOptions;
  t: DocT;
  r: 1 | -1;
  fmt: AmountFmt;
  perspective: StatementPerspective;
  otherParty?: string; // named under the hero, from the reader's seat
}

const td = 'border-top:1px solid ' + ROWLINE + ';white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
const NUM = 'text-align:right;font-variant-numeric:tabular-nums;';

function colgroup(): string {
  return '<colgroup><col style="width:58px"><col><col style="width:96px"><col style="width:96px"><col style="width:108px"></colgroup>';
}

function moneyCell(n: number, color: string, fmt: AmountFmt, extra = ''): string {
  return n > 0.005 ? `<span style="color:${color};${extra}">${fmt(n)}</span>` : '';
}

// Oriented (owed-size) amount, signed only when the direction flipped.
function ownedAmount(n: number, fmt: AmountFmt): string {
  return n < -0.005 ? `−${fmt(n)}` : fmt(n);
}

function cardHtml(rc: RenderCtx, cur: Currency): string {
  const { t, r, fmt, opts } = rc;
  const { section, o } = rc.ctx.get(cur)!;
  const sum = summarizeSection(section, o);
  // Does the owed amount run AGAINST the reader (they pay) or for them?
  const readerPays = o * r > 0;
  const owedLabel = t(readerPays ? 'stmt_pdf_owed_pay' : 'stmt_pdf_owed_receive');
  const closingColor = Math.abs(sum.closing) < 0.005 ? INK : readerPays ? NEG : POS;
  const cell = (label: string, value: string, color: string = INK) =>
    `<div style="flex:1;min-width:0;">
      <p style="margin:0;font-size:9.5px;color:${MUTED};letter-spacing:0.05em;text-transform:uppercase;font-weight:600;">${esc(label)}</p>
      <p style="margin:4px 0 0;font-size:16px;font-weight:700;color:${color};font-variant-numeric:tabular-nums;">${value}</p>
    </div>`;
  const reconcile = fillTemplate(t('stmt_pdf_reconciles'), {
    opening: ownedAmount(sum.opening, fmt),
    up: fmt(sum.up),
    down: fmt(sum.down),
    closing: ownedAmount(sum.closing, fmt),
  });
  const summary = `<div style="margin-top:10px;height:${H.summary - 10}px;box-sizing:border-box;border:1px solid ${HAIRLINE};border-radius:8px;padding:12px 16px;">
      <div style="display:flex;justify-content:space-between;align-items:baseline;">
        <span style="font-size:10px;color:${MUTED};letter-spacing:0.06em;text-transform:uppercase;font-weight:600;">${esc(t('stmt_pdf_summary'))} · ${esc(cur)}</span>
        <span style="font-size:11px;color:${INK};font-weight:600;">${esc(owedLabel)}</span>
      </div>
      <div style="display:flex;gap:14px;margin-top:10px;">
        ${cell(t('stmt_pdf_opening'), ownedAmount(sum.opening, fmt))}
        ${cell(t('stmt_pdf_sum_up'), `+${fmt(sum.up)}`)}
        ${cell(t('stmt_pdf_sum_down'), `−${fmt(sum.down)}`)}
        ${cell(t('stmt_pdf_closing'), ownedAmount(sum.closing, fmt), closingColor)}
      </div>
      <p style="margin:10px 0 0;font-size:11px;color:${MUTED};">✓ ${esc(reconcile)}</p>
    </div>`;

  const bucket = opts.pending?.get(cur);
  let pending = '';
  if (bucket && bucket.items.length > 0) {
    const other = rc.perspective === 'self' ? rc.statement.partyName : (opts.fromName ?? '');
    const rows = bucket.items.map((item) => {
      // 'awaiting_me' = the USER must confirm. On "My copy" that's the reader.
      const readerMustConfirm = (item.direction === 'awaiting_me') === (rc.perspective === 'self');
      const who = readerMustConfirm
        ? t('stmt_pdf_pending_wait_you')
        : fillTemplate(t('stmt_pdf_pending_wait_name'), { name: other });
      const label = [fmtDateShort(item.createdAt), who, item.note].filter(Boolean).join(' · ');
      return `<div style="display:flex;justify-content:space-between;gap:12px;height:${H.pendingItem}px;align-items:center;font-size:11.5px;">
        <span style="color:${INK};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(label)}</span>
        <span style="white-space:nowrap;">${balanceCellHtml(-r * item.delta, fmt)}</span>
      </div>`;
    }).join('');
    const ifAccepted = fillTemplate(t('stmt_pdf_pending_if'), { amount: '{amount}' })
      .split('{amount}')
      .map((s) => esc(s))
      .join(balanceCellHtml(-r * (section.closing + bucket.totalDelta), fmt));
    pending = `<div style="margin-top:10px;background:${AMBER_TINT};border:1px dashed ${AMBER_LINE};border-radius:8px;padding:9px 14px;">
      <p style="margin:0 0 4px;font-size:11px;font-weight:700;color:${AMBER_INK};">${esc(t('stmt_pdf_pending_title'))}</p>
      ${rows}
      <p style="margin:5px 0 0;font-size:11.5px;color:${AMBER_INK};font-weight:600;">${ifAccepted}</p>
    </div>`;
  }

  return `<div style="padding:${H.cardGap}px 44px 0;">
    <div style="height:${H.hero}px;box-sizing:border-box;overflow:hidden;">${heroRowHtml(section, true, t, rc.otherParty, !!opts.hideAmounts, r)}</div>
    ${summary}
    ${pending}
  </div>`;
}

function sectionTitleHtml(title: string, right: string): string {
  return `<div style="height:${H.sectionTitle}px;box-sizing:border-box;padding-top:12px;display:flex;justify-content:space-between;align-items:baseline;border-bottom:1px solid ${HAIRLINE};">
    <span style="font-size:10px;color:${MUTED};letter-spacing:0.06em;text-transform:uppercase;font-weight:600;">${esc(title)}</span>
    <span style="font-size:10px;color:${MUTED};">${esc(right)}</span>
  </div>`;
}

function mtOpen(rc: RenderCtx, cur: Currency, continued: boolean): string {
  const { t } = rc;
  const { o } = rc.ctx.get(cur)!;
  const readerPays = o * rc.r > 0;
  const title = `${t('stmt_pdf_months')} · ${cur}${continued ? ` ${t('stmt_pdf_continued')}` : ''}`;
  const th = `font-weight:600;padding:0 6px;height:${H.thead}px;`;
  return `<div style="padding:0 44px;">${sectionTitleHtml(title, t(readerPays ? 'stmt_pdf_owed_pay' : 'stmt_pdf_owed_receive'))}
    <table style="width:100%;border-collapse:collapse;table-layout:fixed;font-size:11.5px;">
      <thead><tr style="color:${MUTED};font-size:9.5px;letter-spacing:0.05em;text-transform:uppercase;">
        <th style="${th}text-align:left;padding-left:0;">${esc(t('stmt_pdf_col_month'))}</th>
        <th style="${th}${NUM}">${esc(t('stmt_pdf_col_open'))}</th>
        <th style="${th}${NUM}">${esc(t('stmt_pdf_sum_up'))}</th>
        <th style="${th}${NUM}">${esc(t('stmt_pdf_sum_down'))}</th>
        <th style="${th}${NUM}padding-right:0;">${esc(t('stmt_pdf_col_close'))}</th>
      </tr></thead><tbody>`;
}

function mtRowHtml(rc: RenderCtx, block: MonthBlock): string {
  const { fmt } = rc;
  const c = `height:${H.mtRow}px;padding:0 6px;${td}`;
  return `<tr>
    <td style="${c}padding-left:0;color:${INK};font-weight:600;">${esc(monthLabel(block.monthKey))}</td>
    <td style="${c}${NUM}color:${MUTED};">${ownedAmount(block.opening, fmt)}</td>
    <td style="${c}${NUM}">${block.up > 0.005 ? `+${fmt(block.up)}` : ''}</td>
    <td style="${c}${NUM}">${block.down > 0.005 ? `−${fmt(block.down)}` : ''}</td>
    <td style="${c}${NUM}padding-right:0;font-weight:700;">${ownedAmount(block.closing, fmt)}</td>
  </tr>`;
}

function lgOpen(rc: RenderCtx, cur: Currency, continued: boolean): string {
  const { t } = rc;
  const title = `${t('stmt_pdf_ledger')} · ${cur}${continued ? ` ${t('stmt_pdf_continued')}` : ''}`;
  const th = `font-weight:600;padding:0 6px;height:${H.thead}px;`;
  return `<div style="padding:0 44px;">${sectionTitleHtml(title, fillTemplate(t('stmt_pdf_amounts_in'), { currency: cur }))}
    <table style="width:100%;border-collapse:collapse;table-layout:fixed;font-size:11.5px;">${colgroup()}
      <thead><tr style="color:${MUTED};font-size:9.5px;letter-spacing:0.05em;text-transform:uppercase;">
        <th style="${th}text-align:left;padding-left:0;">${esc(t('stmt_pdf_col_date'))}</th>
        <th style="${th}text-align:left;">${esc(t('stmt_pdf_col_desc'))}</th>
        <th style="${th}${NUM}">${esc(t('stmt_pdf_col_received'))}</th>
        <th style="${th}${NUM}">${esc(t('stmt_pdf_col_gave'))}</th>
        <th style="${th}${NUM}padding-right:0;">${esc(t('stmt_pdf_col_balance'))}</th>
      </tr></thead><tbody>`;
}

function plainRow(rc: RenderCtx, label: string, bal: number, h: number = H.bf): string {
  const c = `height:${h}px;padding:0 6px;${td}`;
  return `<tr>
    <td style="${c}padding-left:0;color:${MUTED};">—</td>
    <td style="${c}color:${MUTED};font-style:italic;">${esc(label)}</td>
    <td style="${c}"></td><td style="${c}"></td>
    <td style="${c}${NUM}padding-right:0;">${balanceCellHtml(-rc.r * bal, rc.fmt)}</td>
  </tr>`;
}

function dupTag(rc: RenderCtx, loanId: string | undefined): string {
  if (!loanId || !rc.opts.duplicateLoanIds?.has(loanId)) return '';
  return ` <span style="color:${MUTED};font-size:10px;">· ${esc(rc.t('stmt_pdf_duplicate'))}</span>`;
}

function describe(rc: RenderCtx, line: Pick<StatementLine, 'kind' | 'count' | 'loanNote'>): string {
  return describeStatementLine(line, rc.t, rc.perspective);
}

function ledgerItemHtml(rc: RenderCtx, item: LedgerItem): string {
  const { t, r, fmt } = rc;
  const c = (h: number) => `height:${h}px;padding:0 6px;${td}`;
  switch (item.k) {
    case 'lg_head':
      return plainRow(rc, t('stmt_pdf_opening'), 0);
    case 'month':
      return `<tr style="background:${TINT};">
        <td colspan="4" style="${c(H.month)}padding-left:8px;font-weight:700;color:${INK};">${esc(monthLabel(item.block.monthKey))}</td>
        <td style="${c(H.month)}${NUM}color:${MUTED};">${balanceCellHtml(-r * item.balBefore, fmt)}</td>
      </tr>`;
    case 'row': {
      const row = item.row;
      const cols = rowCols(row, r);
      let desc: string;
      let date: string;
      let weight = '';
      if (row.type === 'burst') {
        const first = row.children[0];
        const note = (first.note ?? '').trim();
        desc = `${esc(describe(rc, { kind: row.kind }))} · ${esc(fillTemplate(t('stmt_pdf_burst'), { n: row.count }))}${note ? ` · ${esc(note)}` : ''}`;
        date = fmtDateShort(row.date);
        weight = 'font-weight:700;';
      } else {
        const line = row.line;
        desc = `${esc(line.note || describe(rc, line))}${dupTag(rc, line.loanId)}`;
        date = fmtDateShort(line.date);
      }
      return `<tr>
        <td style="${c(H.row)}padding-left:0;color:${MUTED};">${date}</td>
        <td style="${c(H.row)}color:${INK};${weight}">${desc}</td>
        <td style="${c(H.row)}${NUM}${weight}">${moneyCell(cols.received, NEG, fmt)}</td>
        <td style="${c(H.row)}${NUM}${weight}">${moneyCell(cols.gave, POS, fmt)}</td>
        <td style="${c(H.row)}${NUM}padding-right:0;${weight}">${balanceCellHtml(-r * item.bal, fmt)}</td>
      </tr>`;
    }
    case 'child': {
      const line = item.line;
      const cols = lineColumns(line, r);
      const what = line.loanNote || line.note || describe(rc, line);
      const left = line.loanRemainingAfter !== undefined
        ? ` · ${fillTemplate(t('stmt_pdf_child_left'), { amount: fmt(line.loanRemainingAfter) })}`
        : '';
      const small = 'font-size:10.5px;color:' + MUTED + ';';
      return `<tr>
        <td style="${c(H.child)}padding-left:0;"></td>
        <td style="${c(H.child)}${small}padding-left:18px;">↳ ${esc(what)}${esc(left)}${dupTag(rc, line.loanId)}</td>
        <td style="${c(H.child)}${NUM}${small}">${cols.received > 0.005 ? fmt(cols.received) : ''}</td>
        <td style="${c(H.child)}${NUM}${small}">${cols.gave > 0.005 ? fmt(cols.gave) : ''}</td>
        <td style="${c(H.child)}padding-right:0;"></td>
      </tr>`;
    }
    case 'subtotal':
      return `<tr>
        <td colspan="2" style="${c(H.subtotal)}padding-left:0;color:${MUTED};font-style:italic;">${esc(fillTemplate(t('stmt_pdf_month_total'), { month: monthLabel(item.block.monthKey) }))}</td>
        <td style="${c(H.subtotal)}${NUM}color:${MUTED};">${item.received > 0.005 ? fmt(item.received) : ''}</td>
        <td style="${c(H.subtotal)}${NUM}color:${MUTED};">${item.gave > 0.005 ? fmt(item.gave) : ''}</td>
        <td style="${c(H.subtotal)}${NUM}padding-right:0;font-weight:600;">${balanceCellHtml(-r * item.bal, fmt)}</td>
      </tr>`;
    case 'lg_close':
      return `<tr style="border-top:2px solid ${NAVY};">
        <td colspan="2" style="height:${H.close}px;padding:0 6px 0 0;font-weight:700;color:${INK};">${esc(t('stmt_pdf_closing'))}</td>
        <td style="padding:0 6px;${NUM}font-weight:600;color:${NEG};">${fmt(item.received)}</td>
        <td style="padding:0 6px;${NUM}font-weight:600;color:${POS};">${fmt(item.gave)}</td>
        <td style="padding:0 0 0 6px;${NUM}font-weight:700;">${balanceCellHtml(-r * item.bal, fmt)}</td>
      </tr>`;
  }
}

// ── Pages ────────────────────────────────────────────────────────────────────

function capacities(opts: FullStatementPdfOptions): { cap1: number; capN: number } {
  const scale = opts.capacityScale ?? 1;
  const greeting = opts.greeting?.trim() ? H.greeting : 0;
  const common = PDF_PAGE_H - H.letterhead - H.footer - H.signOff - H.slack;
  return {
    cap1: Math.floor((common - H.party - greeting) * scale),
    capN: Math.floor((common - H.slim) * scale),
  };
}

/** The page plan — which flow items land on which page. Exposed for tests. */
export function planStatementPages(statement: Statement, opts: FullStatementPdfOptions = {}): FlowItem[][] {
  const r = readerSign(opts.perspective);
  const ctx = buildCtx(statement, opts);
  const { cap1, capN } = capacities(opts);
  return paginateFlow(buildUnits(statement, ctx, opts, r, capN), cap1, capN);
}

/** Every page of the full-history statement as a self-contained HTML string. */
export function renderStatementPagesHtml(statement: Statement, opts: FullStatementPdfOptions = {}): string[] {
  const t = opts.t ?? tStatic;
  const perspective: StatementPerspective = opts.perspective ?? 'counterparty';
  if (!statement.hasActivity) {
    return [renderStatementInnerHtml(statement, { ...opts, t })];
  }
  const r = readerSign(perspective);
  const fmt = amountFmt(!!opts.hideAmounts);
  const ctx = buildCtx(statement, opts);
  const rc: RenderCtx = {
    statement, ctx, opts, t, r, fmt, perspective,
    otherParty: perspective === 'self' ? statement.partyName : opts.fromName,
  };
  const { cap1, capN } = capacities(opts);
  const pages = paginateFlow(buildUnits(statement, ctx, opts, r, capN), cap1, capN);
  const total = pages.length;

  const period = periodRange(statement);
  const meta: LetterheadMeta[] = [
    { text: fillTemplate(t('stmt_pdf_no'), { no: statementNumber(statement, opts.refCode) }), tone: 'mono' },
    { text: fillTemplate(t('stmt_as_of'), { date: pdfDate(statement.asOf) }), tone: 'strong' },
  ];
  if (period) meta.push({ text: fillTemplate(t('stmt_pdf_period'), { range: period }), tone: 'muted' });
  if (perspective === 'self') meta.push({ text: t('stmt_pdf_self_copy'), tone: 'strong' });
  const letterhead = letterheadHtml(t('soa_title'), meta);

  const partyPhone = opts.phone ? `<p style="margin:1px 0 0;font-size:12px;color:${MUTED};">${esc(opts.phone)}</p>` : '';
  const preparedBy = opts.fromName
    ? `<div style="text-align:right;">
        <p style="margin:0;font-size:10px;color:${MUTED};letter-spacing:0.06em;text-transform:uppercase;">${esc(t('stmt_pdf_prepared_by'))}</p>
        <p style="margin:3px 0 0;font-size:13px;font-weight:600;color:${INK};">${esc(opts.fromName)}</p>
      </div>`
    : '';
  const partyBlock = `<div style="height:${H.party}px;box-sizing:border-box;padding:18px 44px 0;display:flex;justify-content:space-between;gap:20px;align-items:flex-start;">
      <div>
        <p style="margin:0;font-size:10px;color:${MUTED};letter-spacing:0.06em;text-transform:uppercase;">${esc(t('stmt_pdf_account_of'))}</p>
        <p style="margin:4px 0 0;font-size:25px;font-weight:700;color:${INK};letter-spacing:-0.015em;line-height:1.1;">${esc(statement.partyName)}</p>
        ${partyPhone}
      </div>
      ${preparedBy}
    </div>`;
  const greeting = opts.greeting?.trim()
    ? `<div style="height:${H.greeting}px;box-sizing:border-box;padding:12px 44px 0;"><p style="margin:0;font-size:15px;color:${INK};">${esc(opts.greeting.trim())}</p></div>`
    : '';
  const slim = `<div style="height:${H.slim}px;box-sizing:border-box;padding:12px 44px 0;font-size:11px;color:${MUTED};">${esc(t('stmt_pdf_account_of'))} <b style="color:${INK};">${esc(statement.partyName)}</b> ${esc(t('stmt_pdf_continued'))}</div>`;
  const signOff = opts.fromName?.trim()
    ? `<div style="padding:16px 44px 4px;">
        <p style="margin:0;font-size:12.5px;color:${MUTED};">${esc(t('stmt_thanks'))}</p>
        <p style="margin:2px 0 0;font-size:14px;font-weight:600;color:${INK};">${esc(opts.fromName.trim())}</p>
      </div>`
    : '';
  const footerNote =
    `<span style="color:${NEG};font-weight:600;">${esc(t('stmt_pdf_legend_pay'))}</span> &nbsp;·&nbsp; ` +
    `<span style="color:${POS};font-weight:600;">${esc(t('stmt_pdf_legend_receive'))}</span><br>` +
    esc(fillTemplate(t('stmt_pdf_generated'), { date: pdfDateTime(statement.asOf) }));

  // Last ledger item of each currency — a page that stops before it carries
  // the balance forward.
  const lastLedgerIndex = new Map<Currency, number>();
  pages.flat().forEach((item, i) => { if (isLedger(item)) lastLedgerIndex.set(item.cur, i); });

  let flatIndex = 0;
  return pages.map((items, pageIdx) => {
    const parts: string[] = [];
    let table: { type: 'mt' | 'lg'; cur: Currency } | null = null;
    let lastLedger: LedgerItem | null = null;
    let lastLedgerFlat = -1;
    const closeTable = () => {
      if (table) parts.push('</tbody></table></div>');
      table = null;
    };
    for (const item of items) {
      const here = flatIndex++;
      if (item.k === 'card') {
        closeTable();
        parts.push(cardHtml(rc, item.cur));
      } else if (item.k === 'mt_head') {
        closeTable();
        parts.push(mtOpen(rc, item.cur, false));
        table = { type: 'mt', cur: item.cur };
      } else if (item.k === 'mt_row') {
        if (!table || table.type !== 'mt' || table.cur !== item.cur) {
          closeTable();
          parts.push(mtOpen(rc, item.cur, true));
          table = { type: 'mt', cur: item.cur };
        }
        parts.push(mtRowHtml(rc, item.block));
      } else {
        if (item.k === 'lg_head') {
          closeTable();
          parts.push(lgOpen(rc, item.cur, false));
          table = { type: 'lg', cur: item.cur };
        } else if (!table || table.type !== 'lg' || table.cur !== item.cur) {
          closeTable();
          parts.push(lgOpen(rc, item.cur, true));
          parts.push(plainRow(rc, t('stmt_bf'), item.balBefore));
          table = { type: 'lg', cur: item.cur };
        }
        parts.push(ledgerItemHtml(rc, item));
        lastLedger = item;
        lastLedgerFlat = here;
      }
    }
    // A ledger left open on this page continues on the next: carry it forward.
    const openLedger = lastLedger as LedgerItem | null;
    if (openLedger && table && (table as { type: string }).type === 'lg' && lastLedgerIndex.get(openLedger.cur) !== lastLedgerFlat) {
      parts.push(plainRow(rc, t('stmt_pdf_cf'), openLedger.bal));
    }
    closeTable();
    const isFirst = pageIdx === 0;
    const isLast = pageIdx === total - 1;
    return `
      ${letterhead}
      ${isFirst ? partyBlock + greeting : slim}
      ${parts.join('')}
      ${isLast ? signOff : ''}
      ${pdfFooterHtml(footerNote, fillTemplate(t('stmt_pdf_page_n'), { n: pageIdx + 1, total }))}
    `;
  });
}

export interface FullStatementPdfResult {
  blob: Blob;
  filename: string;
  pages: number;
}

/**
 * Measure → (re-cut tighter if any page overflows) → rasterise page by page.
 * Never clips a row: up to three progressively tighter cuts, and the last one
 * is used even if a page still runs long (the raster box then shows the top of
 * the page; the measurements make that practically unreachable).
 */
export async function generateFullStatementPdf(
  statement: Statement,
  opts: FullStatementPdfOptions = {},
  onProgress?: (done: number, total: number) => void,
): Promise<FullStatementPdfResult> {
  const t = opts.t ?? tStatic;
  let scale = opts.capacityScale ?? 1;
  let pages: string[] = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    pages = renderStatementPagesHtml(statement, { ...opts, t, capacityScale: scale });
    const heights = await measureHtmlHeights(pages, { width: PDF_PAGE_W, nodeStyle: PDF_NODE_STYLE });
    if (heights.every((h) => h <= PDF_PAGE_H + 1)) break;
    scale *= 0.88;
  }
  const title = t('soa_title');
  const blob = await renderPagesToA4Pdf(pages, {
    width: PDF_PAGE_W,
    height: PDF_PAGE_H,
    nodeStyle: PDF_NODE_STYLE,
    title: `${title} — ${statement.partyName}`,
    subject: `${title} · ${fillTemplate(t('stmt_as_of'), { date: pdfDate(statement.asOf) })}`,
    author: opts.fromName || 'Hisaab',
    onProgress,
  });
  const datePart = new Date(statement.asOf).toLocaleDateString('en-CA');
  const self = opts.perspective === 'self' ? '-MyCopy' : '';
  const filename = `Statement-${sanitizeFilename(statement.partyName, 'contact')}${self}-${datePart}.pdf`;
  return { blob, filename, pages: pages.length };
}

// Reader-mode helper for callers (e.g. a progress label): pay / receive / settled.
export function readerMode(section: StatementSection, perspective: StatementPerspective) {
  return payOrReceiveMode(readerSign(perspective) * section.closing);
}
