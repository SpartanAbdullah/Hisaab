// Display shaping over a built Statement section — the layer the person ledger
// page and the full-history PDF read from. Pure, so the rules that decide what
// the reader SEES (one line per real payment, month blocks that add up) stay
// unit-tested and identical on screen and on paper.
//
// Why bursts exist (2026-10-06, the Ghulam exercise): a lump repayment — "I
// gave you 8,000" — is allocated across many loans, and each allocation is
// its own repayment row (11 rows a second apart). Listed raw, the reader sees
// a pile of small "paid back" lines and never "I paid 8,000 and the total
// dropped from X to Y". A burst folds those consecutive rows back into the one
// payment they were, keeping the children for "which loans it cleared".
//
// Sign convention is the statement's: balance > 0 ⇒ they owe you. "Up" and
// "down" are measured on the size of what is owed (see sectionOrientation), so
// "Kul badha / Kul ghata" reads the same whichever way the debt runs.

import type { SettlementRequest } from '../db';
import { localMonthIso } from './localDate';
import { isZeroMoney } from './moneyTolerance';
import type { StatementLine, StatementSection } from './statementOfAccount';

// `|| 0` folds −0 (orientation × 0) into a plain 0 so "−0.00" never renders.
const round2 = (n: number): number => Math.round(n * 100) / 100 || 0;

export type RepaymentKind = 'repayment_received' | 'repayment_paid';

export interface LineRow {
  type: 'line';
  key: string;
  date: string;
  line: StatementLine;
  delta: number;
  balanceBefore: number;
  balanceAfter: number;
}

export interface BurstRow {
  type: 'burst';
  key: string;
  kind: RepaymentKind;
  date: string; // the first child's date — when the payment happened
  total: number; // money that moved (always positive)
  delta: number; // signed effect on the balance (sum of the children)
  count: number;
  balanceBefore: number;
  balanceAfter: number;
  children: StatementLine[];
  exact: boolean; // true ⇒ grouped by the allocation batch id, not by timing
}

export type DisplayRow = LineRow | BurstRow;

export interface BurstOptions {
  // Allocation batch of a line's transaction (settlementBatchKeys). Lines that
  // share a key were ONE payment. Absent / null ⇒ the timing fallback.
  batchKeyOf?: (line: StatementLine) => string | null | undefined;
  gapMs?: number; // max gap between neighbouring rows of one payment
  maxSpanMs?: number; // max first→last span, so small gaps can't chain forever
}

const DEFAULT_GAP_MS = 30_000;
const DEFAULT_SPAN_MS = 5 * 60_000;

function isRepaymentLine(line: StatementLine): line is StatementLine & { kind: RepaymentKind } {
  // Only REAL repayment rows (txnId) — a synthesised summary line is already
  // one line and must never be merged into a payment.
  return (line.kind === 'repayment_received' || line.kind === 'repayment_paid') && !!line.txnId;
}

const noteOf = (line: StatementLine): string => (line.note ?? '').trim();

function lineRow(line: StatementLine, index: number): LineRow {
  return {
    type: 'line',
    key: line.txnId ?? `${line.loanId ?? 'line'}:${index}`,
    date: line.date,
    line,
    delta: line.delta,
    balanceBefore: round2(line.balance - line.delta),
    balanceAfter: line.balance,
  };
}

/**
 * Fold consecutive repayment lines that were ONE real payment into a burst.
 *
 * Joining rule for neighbours `prev → cur` (both real repayment rows of the
 * same kind):
 *  - both carry a batch key ⇒ join iff the keys are equal (exact);
 *  - one keyed, one not ⇒ never join (different sources);
 *  - neither keyed ⇒ timing fallback: 0 < gap ≤ gapMs, run span ≤ maxSpanMs,
 *    same trimmed note, and the loan not already in the run. A gap of exactly
 *    0 never joins: back-dated entries share an identical local-noon stamp,
 *    while the rows of one allocation are separate writes and never identical.
 * Only CONSECUTIVE lines merge, so every row's before/after balance stays exact.
 */
export function groupRepaymentBursts(lines: readonly StatementLine[], opts: BurstOptions = {}): DisplayRow[] {
  const gapMs = opts.gapMs ?? DEFAULT_GAP_MS;
  const maxSpanMs = opts.maxSpanMs ?? DEFAULT_SPAN_MS;
  const keyOf = (l: StatementLine) => opts.batchKeyOf?.(l) ?? null;

  const rows: DisplayRow[] = [];
  let run: StatementLine[] = [];
  let runStart = 0;

  const flush = () => {
    if (run.length >= 2) {
      const first = run[0];
      const last = run[run.length - 1];
      const delta = round2(run.reduce((a, l) => a + l.delta, 0));
      rows.push({
        type: 'burst',
        key: `burst:${first.txnId}`,
        kind: first.kind as RepaymentKind,
        date: first.date,
        total: round2(Math.abs(delta)),
        delta,
        count: run.length,
        balanceBefore: round2(first.balance - first.delta),
        balanceAfter: last.balance,
        children: run,
        exact: run.every((l) => keyOf(l) !== null),
      });
    } else if (run.length === 1) {
      rows.push(lineRow(run[0], rows.length));
    }
    run = [];
  };

  const joins = (prev: StatementLine, cur: StatementLine): boolean => {
    if (!isRepaymentLine(prev) || !isRepaymentLine(cur) || prev.kind !== cur.kind) return false;
    const kp = keyOf(prev);
    const kc = keyOf(cur);
    if (kp !== null || kc !== null) return kp !== null && kp === kc;
    const tp = Date.parse(prev.date);
    const tc = Date.parse(cur.date);
    if (!Number.isFinite(tp) || !Number.isFinite(tc)) return false;
    const gap = tc - tp;
    if (gap <= 0 || gap > gapMs) return false;
    if (tc - runStart > maxSpanMs) return false;
    if (noteOf(prev) !== noteOf(cur)) return false;
    if (cur.loanId && run.some((l) => l.loanId === cur.loanId)) return false;
    return true;
  };

  for (const line of lines) {
    if (run.length > 0 && joins(run[run.length - 1], line)) {
      run.push(line);
      continue;
    }
    flush();
    if (isRepaymentLine(line)) {
      run = [line];
      runStart = Date.parse(line.date);
    } else {
      rows.push(lineRow(line, rows.length));
    }
  }
  flush();
  return rows;
}

/**
 * Allocation batch keys for transaction rows. The allocate-settlement flow ids
 * each settlement request `${intentId}:${loanId}` (AllocateSettlementModal,
 * since 2026-09-02), and each request names the transaction row it wrote on
 * BOTH sides — so every row of one lump payment maps to the same intentId.
 * Legacy plain-uuid ids carry no batch and get no key. Cancelled requests are
 * skipped (an undone record's rows are soft-deleted anyway).
 */
export function settlementBatchKeys(
  requests: readonly Pick<SettlementRequest, 'id' | 'status' | 'requesterTxnId' | 'responderTxnId'>[],
): Map<string, string> {
  const out = new Map<string, string>();
  for (const r of requests) {
    if (r.status !== 'accepted') continue;
    const cut = r.id.indexOf(':');
    if (cut <= 0) continue;
    const key = r.id.slice(0, cut);
    if (r.requesterTxnId) out.set(r.requesterTxnId, key);
    if (r.responderTxnId) out.set(r.responderTxnId, key);
  }
  return out;
}

/**
 * +1 when the section is about what THEY owe you, −1 when it is about what YOU
 * owe them — so "owed" = orientation × balance reads as a positive amount and
 * "badha / ghata" mean what they say. Settled sections take the direction of
 * their first movement.
 */
export function sectionOrientation(section: Pick<StatementSection, 'closing' | 'lines'>): 1 | -1 {
  if (!isZeroMoney(section.closing)) return section.closing < 0 ? -1 : 1;
  const first = section.lines.find((l) => !isZeroMoney(l.delta));
  return first && first.delta < 0 ? -1 : 1;
}

// How a row moves the owed amount: `up` adds to it, `down` reduces it. Fold
// lines (compact statements only) carry gross flows that cancel out — both
// sides are shown so the reader's payments never look erased.
function flowsOf(row: DisplayRow, orientation: 1 | -1): { up: number; down: number } {
  if (row.type === 'line' && (row.line.grossGiven || row.line.grossRepaid)) {
    return { up: row.line.grossGiven ?? 0, down: row.line.grossRepaid ?? 0 };
  }
  const oriented = orientation * row.delta;
  return oriented >= 0 ? { up: oriented, down: 0 } : { up: 0, down: -oriented };
}

export interface MonthBlock {
  monthKey: string; // 'YYYY-MM' (local calendar)
  opening: number; // owed at the start of the month (oriented)
  up: number;
  down: number;
  closing: number; // owed at the end of the month (oriented)
  rows: DisplayRow[]; // chronological
}

/**
 * Month blocks in chronological order. Each block opens at the previous one's
 * closing, the first opens at the section's starting balance (0 for a full
 * statement), and `opening + up − down = closing` holds for every block. A
 * burst belongs to the month of its first child.
 */
export function groupByMonth(
  rows: readonly DisplayRow[],
  opts: { orientation: 1 | -1; monthOf?: (iso: string) => string },
): MonthBlock[] {
  const monthOf = opts.monthOf ?? ((iso: string) => localMonthIso(new Date(iso)));
  const o = opts.orientation;
  const blocks: MonthBlock[] = [];
  for (const row of rows) {
    const key = monthOf(row.date);
    let block = blocks[blocks.length - 1];
    if (!block || block.monthKey !== key) {
      const opening = round2(o * row.balanceBefore);
      block = { monthKey: key, opening, up: 0, down: 0, closing: opening, rows: [] };
      blocks.push(block);
    }
    const { up, down } = flowsOf(row, o);
    block.up = round2(block.up + up);
    block.down = round2(block.down + down);
    block.closing = round2(o * row.balanceAfter);
    block.rows.push(row);
  }
  return blocks;
}

export interface SectionSummary {
  opening: number; // oriented balance before the first line (0 on a full statement)
  up: number; // everything that increased what's owed
  down: number; // everything that reduced it
  closing: number; // oriented closing — opening + up − down
}

/** "Oct 2026" for a 'YYYY-MM' key — language-free, like every date on a
 *  Hisaab document (English month abbreviations in both languages). */
export function monthLabel(monthKey: string): string {
  const d = new Date(`${monthKey}-01T12:00:00`);
  if (Number.isNaN(d.getTime())) return monthKey;
  return d.toLocaleDateString('en-GB', { month: 'short', year: 'numeric' });
}

/** The reconciliation line: "0 + 29,498.41 − 24,374.00 = 5,124.41". */
export function summarizeSection(section: StatementSection, orientation: 1 | -1): SectionSummary {
  const rows = section.lines.map((line, i) => lineRow(line, i));
  let up = 0;
  let down = 0;
  for (const row of rows) {
    const f = flowsOf(row, orientation);
    up += f.up;
    down += f.down;
  }
  const first = rows[0];
  return {
    opening: first ? round2(orientation * first.balanceBefore) : 0,
    up: round2(up),
    down: round2(down),
    closing: round2(orientation * section.closing),
  };
}
