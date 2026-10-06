import { describe, it, expect } from 'vitest';
import type { SettlementRequest } from '../db';
import { buildStatement, type StatementLine } from './statementOfAccount';
import { ghulamFixture } from './testing/ghulamFixture';
import {
  groupByMonth,
  groupRepaymentBursts,
  sectionOrientation,
  settlementBatchKeys,
  summarizeSection,
  type BurstRow,
  type DisplayRow,
} from './statementRows';

const monthUtc = (iso: string) => new Date(iso).toISOString().slice(0, 7);

function line(partial: Partial<StatementLine> & Pick<StatementLine, 'date' | 'delta' | 'balance'>): StatementLine {
  return { description: '', kind: 'repayment_paid', ...partial };
}

// A run of repayment lines `stepMs` apart, starting from `balance0`.
function repayRun(n: number, opts: { start: string; stepMs: number; balance0: number; amount: number; idPrefix: string }): StatementLine[] {
  const out: StatementLine[] = [];
  let bal = opts.balance0;
  for (let i = 0; i < n; i++) {
    bal = Math.round((bal + opts.amount) * 100) / 100;
    out.push(line({
      date: new Date(Date.parse(opts.start) + i * opts.stepMs).toISOString(),
      delta: opts.amount,
      balance: bal,
      txnId: `${opts.idPrefix}${i}`,
      loanId: `L${opts.idPrefix}${i}`,
    }));
  }
  return out;
}

describe('groupRepaymentBursts', () => {
  it('folds a fanned-out lump payment into one burst with exact before/after', () => {
    const lines = repayRun(12, { start: '2026-10-05T08:24:42.000Z', stepMs: 1500, balance0: -1200, amount: 100, idPrefix: 't' });
    const rows = groupRepaymentBursts(lines);
    expect(rows).toHaveLength(1);
    const burst = rows[0] as BurstRow;
    expect(burst.type).toBe('burst');
    expect(burst.count).toBe(12);
    expect(burst.total).toBe(1200);
    expect(burst.balanceBefore).toBe(-1200);
    expect(burst.balanceAfter).toBe(0);
    expect(burst.balanceAfter - burst.balanceBefore).toBe(burst.delta);
    expect(burst.exact).toBe(false);
  });

  it('a single repayment stays a plain line', () => {
    const rows = groupRepaymentBursts(repayRun(1, { start: '2026-10-05T08:00:00.000Z', stepMs: 0, balance0: -100, amount: 50, idPrefix: 's' }));
    expect(rows.map((r) => r.type)).toEqual(['line']);
    expect(rows[0].balanceBefore).toBe(-100);
    expect(rows[0].balanceAfter).toBe(-50);
  });

  it('splits on a gap beyond the limit and caps the total span', () => {
    const a = repayRun(3, { start: '2026-10-05T08:00:00.000Z', stepMs: 1000, balance0: -600, amount: 100, idPrefix: 'a' });
    const b = repayRun(3, { start: '2026-10-05T09:00:00.000Z', stepMs: 1000, balance0: -300, amount: 100, idPrefix: 'b' });
    expect(groupRepaymentBursts([...a, ...b]).map((r) => (r.type === 'burst' ? r.count : 1))).toEqual([3, 3]);
    // 20 rows 25 s apart = every gap is fine, but the run would span ~8 min.
    const long = repayRun(20, { start: '2026-10-05T10:00:00.000Z', stepMs: 25_000, balance0: -2000, amount: 100, idPrefix: 'l' });
    const counts = groupRepaymentBursts(long).map((r) => (r.type === 'burst' ? r.count : 1));
    expect(counts.reduce((x, y) => x + y, 0)).toBe(20);
    expect(counts.length).toBeGreaterThan(1);
  });

  it('never merges identical (back-dated noon) timestamps, a different note, kind or a repeated loan', () => {
    const noon = '2026-09-10T08:00:00.000Z';
    const twins = [
      line({ date: noon, delta: 50, balance: -50, txnId: 'x1', loanId: 'L1' }),
      line({ date: noon, delta: 50, balance: 0, txnId: 'x2', loanId: 'L2' }),
    ];
    expect(groupRepaymentBursts(twins).map((r) => r.type)).toEqual(['line', 'line']);

    const notes = [
      line({ date: '2026-09-10T08:00:00.000Z', delta: 50, balance: -50, txnId: 'n1', loanId: 'L1', note: 'cash' }),
      line({ date: '2026-09-10T08:00:01.000Z', delta: 50, balance: 0, txnId: 'n2', loanId: 'L2', note: 'bank' }),
    ];
    expect(groupRepaymentBursts(notes).map((r) => r.type)).toEqual(['line', 'line']);

    const kinds = [
      line({ date: '2026-09-10T08:00:00.000Z', delta: 50, balance: 50, txnId: 'k1', kind: 'repayment_paid' }),
      line({ date: '2026-09-10T08:00:01.000Z', delta: -50, balance: 0, txnId: 'k2', kind: 'repayment_received' }),
    ];
    expect(groupRepaymentBursts(kinds).map((r) => r.type)).toEqual(['line', 'line']);

    const sameLoan = [
      line({ date: '2026-09-10T08:00:00.000Z', delta: 50, balance: -50, txnId: 'r1', loanId: 'L1' }),
      line({ date: '2026-09-10T08:00:01.000Z', delta: 50, balance: 0, txnId: 'r2', loanId: 'L1' }),
    ];
    expect(groupRepaymentBursts(sameLoan).map((r) => r.type)).toEqual(['line', 'line']);
  });

  it('a line in between splits a burst so per-row balances stay exact', () => {
    const lines = [
      line({ date: '2026-09-10T08:00:00.000Z', delta: 50, balance: -150, txnId: 'p1', loanId: 'L1' }),
      line({ date: '2026-09-10T08:00:01.000Z', delta: -40, balance: -190, txnId: 'g1', kind: 'loan_taken', loanId: 'L9' }),
      line({ date: '2026-09-10T08:00:02.000Z', delta: 50, balance: -140, txnId: 'p2', loanId: 'L2' }),
    ];
    expect(groupRepaymentBursts(lines).map((r) => r.type)).toEqual(['line', 'line', 'line']);
  });

  it('a batch key groups rows minutes apart exactly, and never mixes keyed with unkeyed rows', () => {
    const lines = [
      line({ date: '2026-09-24T15:21:00.000Z', delta: 2974.25, balance: -3025.75, txnId: 'b1', loanId: 'L1' }),
      line({ date: '2026-09-24T15:24:00.000Z', delta: 25.75, balance: -3000, txnId: 'b2', loanId: 'L2' }),
      line({ date: '2026-09-24T15:24:01.000Z', delta: 100, balance: -2900, txnId: 'u1', loanId: 'L3' }),
    ];
    const keys = new Map([['b1', 'intent-1'], ['b2', 'intent-1']]);
    const rows = groupRepaymentBursts(lines, { batchKeyOf: (l) => keys.get(l.txnId ?? '') });
    expect(rows.map((r) => r.type)).toEqual(['burst', 'line']);
    expect((rows[0] as BurstRow).exact).toBe(true);
    expect((rows[0] as BurstRow).total).toBe(3000);
  });

  it('synthesised summary lines are never merged into a payment', () => {
    const lines = [
      line({ date: '2026-09-10T08:00:00.000Z', delta: 50, balance: -50, kind: 'repayments_made_summary', loanId: 'L1' }),
      line({ date: '2026-09-10T08:00:01.000Z', delta: 50, balance: 0, kind: 'repayments_made_summary', loanId: 'L2' }),
    ];
    expect(groupRepaymentBursts(lines).map((r) => r.type)).toEqual(['line', 'line']);
  });
});

describe('settlementBatchKeys', () => {
  it('maps both sides’ txn rows of an allocated request to its intent; legacy ids get none', () => {
    const reqs = [
      { id: 'intent-a:loan1', status: 'accepted', requesterTxnId: 'rt1', responderTxnId: 'mt1' },
      { id: 'intent-a:loan2', status: 'accepted', requesterTxnId: 'rt2', responderTxnId: 'mt2' },
      { id: '6f1c0b9e-0000-4000-8000-000000000000', status: 'accepted', requesterTxnId: 'rt3', responderTxnId: 'mt3' },
      { id: 'intent-b:loan3', status: 'cancelled', requesterTxnId: 'rt4', responderTxnId: 'mt4' },
    ] as Pick<SettlementRequest, 'id' | 'status' | 'requesterTxnId' | 'responderTxnId'>[];
    const keys = settlementBatchKeys(reqs);
    expect(keys.get('mt1')).toBe('intent-a');
    expect(keys.get('rt2')).toBe('intent-a');
    expect(keys.has('mt3')).toBe(false);
    expect(keys.has('mt4')).toBe(false);
  });
});

describe('groupByMonth', () => {
  it('opens each month at the previous closing, and opening + up − down = closing', () => {
    const lines: StatementLine[] = [
      line({ date: '2026-08-01T10:00:00.000Z', delta: -500, balance: -500, kind: 'loan_taken', txnId: 'a' }),
      line({ date: '2026-08-20T10:00:00.000Z', delta: -200, balance: -700, kind: 'loan_taken', txnId: 'b' }),
      line({ date: '2026-09-02T10:00:00.000Z', delta: 300, balance: -400, txnId: 'c', loanId: 'L1' }),
      line({ date: '2026-09-02T10:00:01.000Z', delta: 100, balance: -300, txnId: 'd', loanId: 'L2' }),
      line({ date: '2026-10-05T10:00:00.000Z', delta: -50, balance: -350, kind: 'loan_taken', txnId: 'e' }),
    ];
    const rows = groupRepaymentBursts(lines);
    const months = groupByMonth(rows, { orientation: -1, monthOf: monthUtc });
    expect(months.map((m) => m.monthKey)).toEqual(['2026-08', '2026-09', '2026-10']);
    expect(months[0].opening).toBe(0);
    for (let i = 0; i < months.length; i++) {
      const m = months[i];
      expect(Math.round((m.opening + m.up - m.down) * 100) / 100).toBe(m.closing);
      if (i > 0) expect(m.opening).toBe(months[i - 1].closing);
    }
    expect(months[1].rows).toHaveLength(1); // the two September repayments are one payment
    expect(months[1].down).toBe(400);
    expect(months[2].closing).toBe(350);
  });

  it('a burst belongs to the month of its first child', () => {
    const lines = [
      line({ date: '2026-09-30T23:59:59.000Z', delta: 100, balance: -100, txnId: 'x', loanId: 'L1' }),
      line({ date: '2026-10-01T00:00:01.000Z', delta: 100, balance: 0, txnId: 'y', loanId: 'L2' }),
    ];
    const months = groupByMonth(groupRepaymentBursts(lines), { orientation: -1, monthOf: monthUtc });
    expect(months.map((m) => m.monthKey)).toEqual(['2026-09']);
  });
});

describe('sectionOrientation', () => {
  it('follows the closing sign, else the first movement', () => {
    expect(sectionOrientation({ closing: -5, lines: [] })).toBe(-1);
    expect(sectionOrientation({ closing: 5, lines: [] })).toBe(1);
    expect(sectionOrientation({ closing: 0, lines: [line({ date: 'x', delta: -10, balance: -10 })] })).toBe(-1);
  });
});

// ── A ledger shaped like the 2026-10-06 Ghulam case (testing/ghulamFixture) ──
describe('Ghulam-shaped ledger', () => {
  const { loans, txns, settlements, ids: { big } } = ghulamFixture();
  const statement = buildStatement({ partyName: 'Abdullah', loans, transactions: txns, asOf: '2026-10-06T09:00:00.000Z', scope: 'contact', detail: 'full' });
  const section = statement.sections[0];
  const keys = settlementBatchKeys(settlements);

  it('closes at exactly what the loans say is open (5,124.41 owed)', () => {
    expect(section.closing).toBe(-5124.41);
    const open = loans.reduce((a, l) => a + l.remainingAmount, 0);
    expect(Math.round(open * 100) / 100).toBe(5124.41);
  });

  it('full detail itemises every settled loan (no "previously settled" fold)', () => {
    expect(section.lines.some((l) => l.kind.startsWith('settled_'))).toBe(false);
    const compact = buildStatement({ partyName: 'Abdullah', loans, transactions: txns, asOf: '2026-10-06T09:00:00.000Z', scope: 'contact' });
    expect(compact.sections[0].closing).toBe(section.closing);
    expect(compact.sections[0].lines.length).toBeLessThan(section.lines.length);
  });

  const expectPayments = (rows: DisplayRow[]) => {
    const bursts = rows.filter((r): r is BurstRow => r.type === 'burst');
    expect(bursts.map((b) => [b.total, b.count])).toEqual([[3000, 2], [3100, 15], [8000, 11], [2000, 10]]);
    // Every row hands its closing balance to the next.
    for (let i = 1; i < rows.length; i++) expect(rows[i].balanceBefore).toBe(rows[i - 1].balanceAfter);
    expect(rows[rows.length - 1].balanceAfter).toBe(-5124.41);
  };

  it('reads the four lump payments back as four payments — by batch id', () => {
    const rows = groupRepaymentBursts(section.lines, { batchKeyOf: (l) => (l.txnId ? keys.get(l.txnId) : undefined) });
    expectPayments(rows);
    expect(rows.filter((r): r is BurstRow => r.type === 'burst').every((b) => b.exact)).toBe(true);
  });

  it('…and the same four by timing alone (older rows have no batch id)', () => {
    expectPayments(groupRepaymentBursts(section.lines));
  });

  it('names what each child loan was left at — the shared loan ends at 426.56', () => {
    const rows = groupRepaymentBursts(section.lines, { batchKeyOf: (l) => (l.txnId ? keys.get(l.txnId) : undefined) });
    const last = rows.filter((r): r is BurstRow => r.type === 'burst').pop()!;
    const bigChild = last.children.find((c) => c.loanId === big)!;
    expect(bigChild.loanRemainingAfter).toBe(426.56);
  });

  it('month blocks and the overall summary reconcile', () => {
    const o = sectionOrientation(section);
    expect(o).toBe(-1);
    const months = groupByMonth(groupRepaymentBursts(section.lines), { orientation: o, monthOf: monthUtc });
    expect(months[0].opening).toBe(0);
    expect(months[months.length - 1].closing).toBe(5124.41);
    const sum = summarizeSection(section, o);
    expect(sum.opening).toBe(0);
    expect(Math.round((sum.opening + sum.up - sum.down) * 100) / 100).toBe(sum.closing);
    expect(sum.closing).toBe(5124.41);
    const taken = loans.reduce((a, l) => a + l.totalAmount, 0);
    expect(sum.up).toBe(Math.round(taken * 100) / 100);
  });
});
