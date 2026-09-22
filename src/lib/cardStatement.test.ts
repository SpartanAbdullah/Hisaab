import { describe, expect, it } from 'vitest';
import {
  allocateBillPayment,
  billAdvancesAsOf,
  buildCardStatement,
  statementInstalmentDates,
  type AdvanceForAllocation,
} from './cardStatement';
import type { Account, EmiSchedule, Loan } from '../db';

const card = (over: Partial<Account> = {}): Account => ({
  id: 'card1', name: 'RAK Titanium', type: 'credit_card', currency: 'AED',
  balance: 15000, metadata: { dueDay: '26', creditLimit: '20000' }, // used = 5000
  createdAt: '2026-01-01T00:00:00Z', ...over,
});

const loan = (over: Partial<Loan> = {}): Loan => ({
  id: 'l1', personName: 'RAK Cash Advance', personId: null, type: 'taken', totalAmount: 12000,
  remainingAmount: 3000, currency: 'AED', status: 'active', notes: '',
  createdAt: '2026-05-21T00:00:00Z', ...over,
});

const emi = (over: Partial<EmiSchedule> = {}): EmiSchedule => ({
  id: 'e1', loanId: 'l1', installmentNumber: 5, dueDate: '2026-07-26', amount: 1000,
  status: 'upcoming', ...over,
});

describe('statementInstalmentDates', () => {
  it('anchors every instalment to the statement day, first one strictly after the advance', () => {
    // Advance taken Jul 24, statement day 26 → first bill Jul 26, then monthly.
    expect(statementInstalmentDates(26, 3, '2026-07-24')).toEqual(['2026-07-26', '2026-08-26', '2026-09-26']);
  });

  it('rolls to next month when the statement day this month has already passed', () => {
    // Taken Jul 27 (after the 26th) → first bill Aug 26.
    expect(statementInstalmentDates(26, 2, '2026-07-27')).toEqual(['2026-08-26', '2026-09-26']);
  });

  it('rolls when taken ON the statement day (strictly-after)', () => {
    expect(statementInstalmentDates(26, 1, '2026-07-26')).toEqual(['2026-08-26']);
  });

  it('clamps a 31st statement day to short months and crosses the year', () => {
    expect(statementInstalmentDates(31, 4, '2026-11-15')).toEqual(['2026-11-30', '2026-12-31', '2027-01-31', '2027-02-28']);
  });

  it('rejects an invalid day', () => {
    expect(statementInstalmentDates(0, 3, '2026-07-24')).toEqual([]);
    expect(statementInstalmentDates(26, 0, '2026-07-24')).toEqual([]);
  });
});

describe('buildCardStatement', () => {
  const TODAY = new Date(2026, 6, 24, 12, 0, 0); // 24 Jul, cycle started 26 Jun

  it('the honest bill = revolving (purchases + carried) + this cycle instalment, NOT the whole balance', () => {
    // used 5000 = revolving 2000 + advance remaining 3000; instalment 1000.
    const st = buildCardStatement({
      card: card(),
      advanceLoans: [loan()],
      schedules: [emi({ dueDate: '2026-07-26' })],
      today: TODAY,
    });
    expect(st).not.toBeNull();
    expect(st!.totalOwed).toBe(5000);
    expect(st!.revolving).toBe(2000); // 5000 − 3000 financed
    expect(st!.instalmentDue).toBe(1000);
    expect(st!.statementDue).toBe(3000); // NOT the 5000 total (future instalments excluded)
  });

  it('a plain card with no instalment plan bills its whole balance', () => {
    const st = buildCardStatement({ card: card(), advanceLoans: [], schedules: [], today: TODAY });
    expect(st!.revolving).toBe(5000);
    expect(st!.instalmentDue).toBe(0);
    expect(st!.statementDue).toBe(5000); // full owed, matches the old behaviour
  });

  it('a fully-paid card owes nothing', () => {
    const st = buildCardStatement({ card: card({ balance: 20000 }), advanceLoans: [], schedules: [], today: TODAY });
    expect(st!.totalOwed).toBe(0);
    expect(st!.statementDue).toBe(0);
  });

  it('excludes a paid instalment and one due only next cycle', () => {
    const st = buildCardStatement({
      card: card(),
      advanceLoans: [loan()],
      schedules: [
        emi({ id: 'paid', installmentNumber: 4, dueDate: '2026-06-26', status: 'paid' }),
        emi({ id: 'next', installmentNumber: 6, dueDate: '2026-08-26' }), // next cycle
        emi({ id: 'due', installmentNumber: 5, dueDate: '2026-07-26' }), // this cycle
      ],
      today: TODAY,
    });
    expect(st!.instalmentDue).toBe(1000); // only #5
  });

  it('returns null without a statement day', () => {
    expect(buildCardStatement({ card: card({ metadata: { creditLimit: '20000' } }), advanceLoans: [], schedules: [], today: TODAY })).toBeNull();
  });

  it("REAL RAK card (user's live numbers): statement due = 2,394.69, not the 9,978.04 balance", () => {
    // Total limit 17,600; available 7,621.96 → outstanding 9,978.04. Cash
    // advance 13,000, 4,333.32 paid → 8,666.68 remaining at 1,083.33/mo.
    // Statement CLOSES the 2nd, payment DUE the 27th. Today 25 Jul.
    const rak = card({
      balance: 7621.96,
      metadata: { creditLimit: '17600', statementDay: '2', dueDay: '27' },
    });
    const advance: Loan = {
      id: 'rak-ca', personName: 'RAK Cash Advance', personId: null, type: 'taken',
      totalAmount: 13000, remainingAmount: 8666.68, currency: 'AED', status: 'active',
      notes: '', createdAt: '2026-05-21T00:00:00Z',
    };
    const st = buildCardStatement({
      card: rak,
      advanceLoans: [advance],
      schedules: [{ id: 'i5', loanId: 'rak-ca', installmentNumber: 5, dueDate: '2026-07-27', amount: 1083.33, status: 'upcoming' }],
      today: new Date(2026, 6, 25, 12, 0, 0),
    });
    expect(st).not.toBeNull();
    expect(st!.totalOwed).toBe(9978.04);        // the full balance
    expect(st!.revolving).toBe(1311.36);        // 9,978.04 − 8,666.68 (purchases + carried)
    expect(st!.instalmentDue).toBe(1083.33);    // this cycle's instalment
    expect(st!.statementDue).toBe(2394.69);     // what to actually pay — NOT 9,978.04
    expect(st!.statementDay).toBe(2);           // closes the 2nd
    expect(st!.dueDay).toBe(27);                // due the 27th
    expect(st!.daysUntilDue).toBe(2);           // 25 Jul → 27 Jul
    // Paying the statement steps ONE instalment; paying the full balance clears all.
    const payStatement = allocateBillPayment({ payment: 2394.69, revolvingPurchases: 1311.36, advances: [{ loanId: 'rak-ca', remaining: 8666.68, dueThisCycle: 1083.33, createdAt: '2026-05-21' }] });
    expect(payStatement.perLoan).toEqual([{ loanId: 'rak-ca', principalApplied: 1083.33 }]);
    const payFull = allocateBillPayment({ payment: 9978.04, revolvingPurchases: 1311.36, advances: [{ loanId: 'rak-ca', remaining: 8666.68, dueThisCycle: 1083.33, createdAt: '2026-05-21' }] });
    expect(payFull.perLoan).toEqual([{ loanId: 'rak-ca', principalApplied: 8666.68 }]);
  });

  it('two dates: cycle boundary follows the statement close, countdown follows the payment due', () => {
    // Statement closes 2nd, due 27th, today 25 Jul → cycle started 2 Jul, due in 2 days.
    const st = buildCardStatement({
      card: card({ metadata: { creditLimit: '20000', statementDay: '2', dueDay: '27' } }),
      advanceLoans: [], schedules: [], today: new Date(2026, 6, 25, 12, 0, 0),
    });
    expect(st!.cycleStartIso).toBe('2026-07-02');
    expect(st!.daysUntilDue).toBe(2);
    // No statementDay → both collapse to the due day (backward compatible).
    const single = buildCardStatement({
      card: card({ metadata: { creditLimit: '20000', dueDay: '27' } }),
      advanceLoans: [], schedules: [], today: new Date(2026, 6, 25, 12, 0, 0),
    });
    expect(single!.statementDay).toBe(27);
    expect(single!.cycleStartIso).toBe('2026-06-27');
  });
});

describe('allocateBillPayment', () => {
  const advances = (over: Partial<AdvanceForAllocation> = {}): AdvanceForAllocation => ({
    loanId: 'l1', remaining: 8666.68, dueThisCycle: 1083.33, createdAt: '2026-05-21', ...over,
  });

  it("THE user's worry: paying this month's statement steps ONE instalment, never wipes the advance", () => {
    // Statement = 1,083.33 instalment + 420 purchases = 1,503.33. Pay exactly that.
    const a = allocateBillPayment({ payment: 1503.33, revolvingPurchases: 420, advances: [advances()] });
    expect(a.perLoan).toEqual([{ loanId: 'l1', principalApplied: 1083.33 }]); // ONE instalment, not 8,666
    expect(a.purchasesApplied).toBe(420);
    expect(a.surplus).toBe(0);
  });

  it('paying the FULL balance clears everything (instalment + purchases + prepay the rest)', () => {
    // used 9,978.04 = 8,666.68 advance + 1,311.36 purchases.
    const a = allocateBillPayment({ payment: 9978.04, revolvingPurchases: 1311.36, advances: [advances()] });
    expect(a.perLoan).toEqual([{ loanId: 'l1', principalApplied: 8666.68 }]); // whole advance cleared
    expect(a.purchasesApplied).toBe(1311.36);
    expect(a.surplus).toBe(0);
  });

  it('overpaying beyond the balance leaves a surplus, never over-reduces a plan', () => {
    const a = allocateBillPayment({ payment: 12000, revolvingPurchases: 1311.36, advances: [advances()] });
    expect(a.perLoan[0].principalApplied).toBe(8666.68);
    expect(a.purchasesApplied).toBe(1311.36);
    expect(a.surplus).toBe(2021.96); // 12000 − 9978.04
  });

  it('a partial payment (less than the instalment) applies only what was paid', () => {
    const a = allocateBillPayment({ payment: 500, revolvingPurchases: 420, advances: [advances()] });
    expect(a.perLoan).toEqual([{ loanId: 'l1', principalApplied: 500 }]);
    expect(a.purchasesApplied).toBe(0);
  });

  it('instalments go oldest-advance-first, then purchases, then prepay oldest-first', () => {
    const a = allocateBillPayment({
      payment: 5000,
      revolvingPurchases: 1000,
      advances: [
        advances({ loanId: 'new', remaining: 2000, dueThisCycle: 500, createdAt: '2026-07-01' }),
        advances({ loanId: 'old', remaining: 3000, dueThisCycle: 800, createdAt: '2026-05-01' }),
      ],
    });
    // due: old 800 + new 500 = 1300; purchases 1000; left 2700 → prepay old (2200) then new (500)
    const byId = Object.fromEntries(a.perLoan.map((l) => [l.loanId, l.principalApplied]));
    expect(byId.old).toBe(3000); // 800 due + 2200 prepay = full
    expect(byId.new).toBe(1000); // 500 due + 500 prepay
    expect(a.purchasesApplied).toBe(1000);
    expect(a.surplus).toBe(0);
  });

  it('conserves the payment exactly (Σ perLoan + purchases + surplus = payment)', () => {
    const cases = [
      { payment: 1503.33, revolvingPurchases: 420 },
      { payment: 9978.04, revolvingPurchases: 1311.36 },
      { payment: 12000, revolvingPurchases: 1311.36 },
      { payment: 500, revolvingPurchases: 420 },
    ];
    for (const c of cases) {
      const a = allocateBillPayment({ ...c, advances: [advances()] });
      const total = a.perLoan.reduce((s, l) => s + l.principalApplied, 0) + a.purchasesApplied + a.surplus;
      expect(Math.round(total * 100) / 100).toBe(c.payment);
    }
  });

  it('a pure-revolving card (no advances) just pays down purchases', () => {
    const a = allocateBillPayment({ payment: 300, revolvingPurchases: 1000, advances: [] });
    expect(a.perLoan).toEqual([]);
    expect(a.purchasesApplied).toBe(300);
    expect(a.surplus).toBe(0);
  });
});

describe('billAdvancesAsOf — "this cycle" is decided by the PAYMENT date', () => {
  // Statement/due day 26. Instalment #5 (26 Aug) already paid; #6 due 26 Sep.
  const schedules = [
    emi({ id: 'e5', installmentNumber: 5, dueDate: '2026-08-26', status: 'paid' }),
    emi({ id: 'e6', installmentNumber: 6, dueDate: '2026-09-26' }),
    emi({ id: 'e7', installmentNumber: 7, dueDate: '2026-10-26' }),
  ];
  const loans = [loan()];

  it('a bill paid on 20 Aug (before the Aug due day) owes no September instalment', () => {
    const [a] = billAdvancesAsOf({ loans, schedules, dueDay: 26, when: new Date(2026, 7, 20, 12) });
    expect(a).toEqual({ loanId: 'l1', remaining: 3000, dueThisCycle: 0, createdAt: '2026-05-21T00:00:00Z' });
  });

  it('the same bill recorded today (21 Sep) would step the September instalment', () => {
    const [a] = billAdvancesAsOf({ loans, schedules, dueDay: 26, when: new Date(2026, 8, 21, 9) });
    expect(a.dueThisCycle).toBe(1000);
  });

  it('paid after the Aug due day (29 Aug) → the next due day is 26 Sep, so #6 is this cycle', () => {
    const [a] = billAdvancesAsOf({ loans, schedules, dueDay: 26, when: new Date(2026, 7, 29, 12) });
    expect(a.dueThisCycle).toBe(1000);
  });

  it('an overdue unpaid instalment is always included', () => {
    const overdue = [emi({ id: 'e5', installmentNumber: 5, dueDate: '2026-07-26' }), ...schedules.slice(1)];
    const [a] = billAdvancesAsOf({ loans, schedules: overdue, dueDay: 26, when: new Date(2026, 7, 20, 12) });
    expect(a.dueThisCycle).toBe(1000);
  });

  it('feeds allocateBillPayment unchanged: an early-dated payment prepays instead of stepping', () => {
    const advances = billAdvancesAsOf({ loans, schedules, dueDay: 26, when: new Date(2026, 7, 20, 12) });
    const alloc = allocateBillPayment({ payment: 1500, revolvingPurchases: 500, advances });
    // Nothing due this cycle → purchases first (500), then 1000 prepays the advance.
    expect(alloc.purchasesApplied).toBe(500);
    expect(alloc.perLoan).toEqual([{ loanId: 'l1', principalApplied: 1000 }]);
  });
});
