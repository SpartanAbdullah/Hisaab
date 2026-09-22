import { describe, expect, it } from 'vitest';
import { closeNudgeDue, notificationId, planNotifications, type PlanInputs } from './notificationPlanner';
import type { Account, Budget, Committee, EmiSchedule, Loan, RecurringTransaction, Transaction, UpcomingExpense } from '../db';

// 09:00 on 24 Jul — before the 10:00 fire slot, so same-day (T-0) entries
// are still schedulable.
const NOW = new Date(2026, 6, 24, 9, 0, 0);

const card = (over: Partial<Account> = {}): Account => ({
  id: 'c1', name: 'RAK Titanium', type: 'credit_card', currency: 'AED',
  balance: 7621.96, metadata: { dueDay: '26', creditLimit: '17600' },
  createdAt: '2026-01-01T00:00:00Z', ...over,
});

const loan = (over: Partial<Loan> = {}): Loan => ({
  id: 'l1', personName: 'Ali', personId: null, type: 'taken', totalAmount: 5000,
  remainingAmount: 5000, currency: 'AED', status: 'active', notes: '',
  createdAt: '2026-06-01T00:00:00Z', ...over,
});

const emi = (over: Partial<EmiSchedule> = {}): EmiSchedule => ({
  id: 'e1', loanId: 'l1', installmentNumber: 2, dueDate: '2026-07-25',
  amount: 500, status: 'upcoming', ...over,
});

const inputs = (over: Partial<PlanInputs> = {}): PlanInputs => ({
  accounts: [], loans: [], schedules: [], templates: [], upcoming: [],
  committees: [], committeePayments: [], now: NOW, ...over,
});

describe('planNotifications', () => {
  it('a card still owing gets the escalation ladder; a PAID card gets nothing', () => {
    const owing = planNotifications(inputs({ accounts: [card()] }));
    // due in 2d → T-1 (tomorrow) and T-0 (due day); T-3 is already past.
    expect(owing.map((p) => p.key).sort()).toEqual(['card:c1:t0', 'card:c1:t1'].sort());
    const dayOf = owing.find((p) => p.key === 'card:c1:t0');
    expect(dayOf?.priority).toBe(100);
    expect(dayOf?.body).toContain('9,978');

    const paid = planNotifications(inputs({ accounts: [card({ balance: 17600 })] }));
    expect(paid).toHaveLength(0);
  });

  it('a no-limit card still gets bill reminders (statement 0 = unknowable, not paid)', () => {
    // dueDay 26 (2 days out from NOW=24 Jul), NO creditLimit.
    const plan = planNotifications(inputs({ accounts: [card({ metadata: { dueDay: '26' } })] }));
    expect(plan.map((p) => p.key).sort()).toEqual(['card:c1:t0', 'card:c1:t1'].sort());
    // No amount known → body carries no dangling dash.
    expect(plan.find((p) => p.key === 'card:c1:t0')?.body).not.toContain('—');
  });

  it('EMIs remind T-1/T-0, but card-funded ones defer to the funding card', () => {
    const base = inputs({ loans: [loan()], schedules: [emi()] });
    const plain = planNotifications(base);
    expect(plain.map((p) => p.key)).toContain('emi:e1:t0');

    const suppressed = planNotifications({
      ...base,
      accounts: [card()],
      cardFundedLoanIds: new Map([['l1', 'c1']]),
    });
    expect(suppressed.find((p) => p.key.startsWith('emi:'))).toBeUndefined();
  });

  it('paid EMIs and settled loans never ring', () => {
    expect(planNotifications(inputs({ loans: [loan()], schedules: [emi({ status: 'paid' })] }))).toHaveLength(0);
    expect(planNotifications(inputs({ loans: [loan({ status: 'settled' })], schedules: [emi()] }))).toHaveLength(0);
  });

  it('never schedules into the past — an overdue item stays in-app, not on the lock screen', () => {
    const plan = planNotifications(inputs({ loans: [loan()], schedules: [emi({ dueDate: '2026-07-20' })] }));
    expect(plan).toHaveLength(0);
  });

  it('caps each day at 3, keeping the highest-priority reminders', () => {
    const tpl = (id: string): RecurringTransaction => ({
      id, type: 'expense', amount: 100, currency: 'AED', sourceAccountId: 'a',
      destinationAccountId: null, category: 'Bills', notes: '', cadence: 'monthly',
      nextDueDate: '2026-07-25', active: true, label: id, createdAt: '', ...( {} ),
    });
    const bill = (id: string): UpcomingExpense => ({
      id, title: id, amount: 50, currency: 'AED', dueDate: '2026-07-25T00:00:00Z',
      accountId: 'a', category: '', notes: '', isPaid: false, status: 'upcoming',
      reminderDaysBefore: 1, createdAt: '',
    });
    const plan = planNotifications(inputs({
      loans: [loan()],
      schedules: [emi({ dueDate: '2026-07-25' })],
      templates: [tpl('r1'), tpl('r2')],
      upcoming: [bill('b1'), bill('b2')],
    }));
    const onDueDay = plan.filter((p) => new Date(p.atMs).getDate() === 25);
    expect(onDueDay).toHaveLength(3);
    // EMI day-of (90) and the two bill day-ofs (75) outrank recurring (60).
    expect(onDueDay.map((p) => p.key)).toContain('emi:e1:t0');
  });

  it('ids are stable and positive int32', () => {
    expect(notificationId('card:c1:0')).toBe(notificationId('card:c1:0'));
    expect(notificationId('card:c1:0')).not.toBe(notificationId('card:c1:1'));
    const id = notificationId('anything');
    expect(id).toBeGreaterThan(0);
    expect(id).toBeLessThanOrEqual(2147483647);
  });

  it('kameti rounds inside the horizon ring on the day — unless already fully collected', () => {
    const committee = {
      id: 'k1', name: 'Office', currency: 'AED', contributionAmount: 200, memberCount: 2,
      cadence: 'monthly', totalRounds: 5, startDate: '2026-07-26', payoutMethod: 'fixed',
      status: 'active', notes: '', createdAt: '',
    } as Committee;
    const plan = planNotifications(inputs({ committees: [committee] }));
    expect(plan.map((p) => p.key)).toContain('kameti:k1:1');

    const collected = planNotifications(inputs({
      committees: [committee],
      committeePayments: [1, 2].map((n) => ({
        id: `p${n}`, committeeId: 'k1', memberId: `m${n}`, round: 1, paidAt: '2026-07-24T08:00:00Z',
      })),
    }));
    expect(collected.find((p) => p.key === 'kameti:k1:1')).toBeUndefined();
  });
});

// ── Budget breach — DEVICE-LOCAL (audit 08-notifications.md N-11) ───────────
// "Budget breached → Derived Inbox Info card only, visible when the user opens
//  the Inbox. No push/local reminder even when reminders are on."
// These entries never become a notifications row and never become a push; they
// exist only in this phone's local schedule. See notificationPlanner section 6.
describe('planNotifications — budget breach', () => {
  const budget = (over: Partial<Budget> = {}): Budget => ({
    id: 'b1', category: 'Groceries', monthlyAmount: 1000, currency: 'AED',
    warnAtPercent: 80, createdAt: '2026-07-01T00:00:00Z', ...over,
  });

  const spend = (amount: number, over: Partial<Transaction> = {}): Transaction => ({
    id: `t-${amount}`, type: 'expense', amount, currency: 'AED',
    category: 'Groceries', description: '', sourceAccountId: null,
    destinationAccountId: null, createdAt: '2026-07-10T00:00:00Z', ...over,
  } as Transaction);

  it('says nothing while spending is under the warn threshold', () => {
    const plan = planNotifications(inputs({
      budgets: [budget()], transactions: [spend(500)],
    }));
    expect(plan.filter((p) => p.key.startsWith('budget:'))).toHaveLength(0);
  });

  it('warns once at the warn threshold', () => {
    const plan = planNotifications(inputs({
      budgets: [budget()], transactions: [spend(850)],
    }));
    const entries = plan.filter((p) => p.key.startsWith('budget:'));
    expect(entries).toHaveLength(1);
    expect(entries[0].key).toBe('budget:b1:warn:2026-07');
    expect(entries[0].href).toBe('/budgets');
    expect(entries[0].title).toBe('Groceries');
  });

  it('escalates to over-limit and never emits BOTH for one budget', () => {
    const plan = planNotifications(inputs({
      budgets: [budget()], transactions: [spend(1200)],
    }));
    const entries = plan.filter((p) => p.key.startsWith('budget:'));
    expect(entries).toHaveLength(1);
    expect(entries[0].key).toBe('budget:b1:over:2026-07');
    // Below every hard obligation — a budget is information, not a due date.
    expect(entries[0].priority).toBeLessThan(45);
  });

  it('ignores spending in another category or another currency', () => {
    const plan = planNotifications(inputs({
      budgets: [budget()],
      transactions: [
        spend(2000, { category: 'Fuel' }),
        spend(2000, { currency: 'PKR' } as Partial<Transaction>),
      ],
    }));
    expect(plan.filter((p) => p.key.startsWith('budget:'))).toHaveLength(0);
  });

  it('schedules tomorrow when today\'s 10:00 slot has already passed', () => {
    // 14:00 — past REMIND_HOUR. Without the tomorrow fallback the entry would
    // be silently dropped by the never-schedule-into-the-past guard.
    const afternoon = new Date(2026, 6, 24, 14, 0, 0);
    const plan = planNotifications(inputs({
      now: afternoon, budgets: [budget()], transactions: [spend(1200)],
    }));
    const entry = plan.find((p) => p.key.startsWith('budget:'));
    expect(entry).toBeDefined();
    expect(new Date(entry!.atMs).getDate()).toBe(25);
  });

  it('never schedules past the end of the month — the budget resets', () => {
    // 31 Jul at 14:00: the only remaining slot would be 1 Aug, in a new
    // budget month, where "over budget" would be a lie.
    const lastDay = new Date(2026, 6, 31, 14, 0, 0);
    const plan = planNotifications(inputs({
      now: lastDay, budgets: [budget()], transactions: [spend(1200, { createdAt: '2026-07-30T00:00:00Z' })],
    }));
    expect(plan.filter((p) => p.key.startsWith('budget:'))).toHaveLength(0);
  });

  it('produces nothing when the caller passes no budgets (older callers)', () => {
    expect(planNotifications(inputs()).filter((p) => p.key.startsWith('budget:'))).toHaveLength(0);
  });
});

describe('planNotifications — daily close (section 7)', () => {
  // 24 Jul 2026, 09:00 local. The evening slot is 21:30.
  const expenseOn = (day: string): Transaction => ({
    id: `x-${day}`, type: 'expense', amount: 12, currency: 'AED', sourceAccountId: 'cash',
    destinationAccountId: null, relatedPerson: null, personId: null, relatedLoanId: null,
    relatedGoalId: null, conversionRate: null, category: 'Food', notes: '', createdAt: `${day}T08:00:00Z`,
  });
  const dc = (over: Partial<NonNullable<PlanInputs['dailyClose']>> = {}): PlanInputs['dailyClose'] => ({
    hour: 21, minute: 30, closes: [], lastCheckIso: '2026-07-23', ...over,
  });
  const closeKeys = (inp: PlanInputs) => planNotifications(inp).filter((p) => p.key.startsWith('close:'));

  it('is off unless the caller passes dailyClose', () => {
    expect(closeKeys(inputs({ transactions: [expenseOn('2026-07-23')] }))).toHaveLength(0);
  });

  it('nudges every evening at the chosen time, with the action buttons — thinning out only if nothing gets logged', () => {
    // Last logged yesterday. The plan assumes nothing more is logged: daily
    // for 3 evenings, then every other day (any entry rebuilds the plan).
    const plan = closeKeys(inputs({ transactions: [expenseOn('2026-07-23')], dailyClose: dc() }));
    expect(plan.map((p) => p.key)).toEqual([
      'close:2026-07-24', 'close:2026-07-25', 'close:2026-07-26',
      'close:2026-07-28', 'close:2026-07-30',
    ]);
    const first = plan[0];
    expect(new Date(first.atMs).getHours()).toBe(21);
    expect(new Date(first.atMs).getMinutes()).toBe(30);
    expect(first.actionTypeId).toBe('daily_close');
    expect(first.allowWhileIdle).toBe(true);
    expect(first.href).toBe('/?close=today');
  });

  it('skips tonight once today is logged or closed', () => {
    const logged = closeKeys(inputs({ transactions: [expenseOn('2026-07-24')], dailyClose: dc() }));
    expect(logged[0].key).toBe('close:2026-07-25');
    const closed = closeKeys(inputs({ dailyClose: dc({ closes: [{ day: '2026-07-24', kind: 'no_spend' }] }) }));
    expect(closed[0].key).toBe('close:2026-07-25');
  });

  it('never schedules tonight once the time has passed', () => {
    const late = new Date(2026, 6, 24, 22, 0, 0);
    const plan = closeKeys(inputs({ now: late, transactions: [expenseOn('2026-07-23')], dailyClose: dc() }));
    expect(plan[0].key).toBe('close:2026-07-25');
  });

  it('backs off for someone who has gone quiet', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(closeNudgeDue)).toEqual(
      [true, true, true, true, false, true, false, true, false, false, true],
    );
    // Last activity 10 days ago → quiet 10 tonight: only 10, 13 in the week.
    const plan = closeKeys(inputs({ transactions: [expenseOn('2026-07-14')], dailyClose: dc() }));
    expect(plan.map((p) => p.key)).toEqual(['close:2026-07-24', 'close:2026-07-27', 'close:2026-07-30']);
  });

  it('consecutive evenings never share the same wording', () => {
    const plan = closeKeys(inputs({ transactions: [expenseOn('2026-07-23')], dailyClose: dc() }));
    for (let i = 1; i < 4; i += 1) expect(plan[i].title + plan[i].body).not.toBe(plan[i - 1].title + plan[i - 1].body);
  });

  it('swaps in the weekly Hisaab check once, on the first evening it is due', () => {
    const plan = closeKeys(inputs({ transactions: [expenseOn('2026-07-23')], dailyClose: dc({ lastCheckIso: '2026-07-19' }) }));
    const checks = plan.filter((p) => p.href === '/?check=1');
    expect(checks.map((p) => p.key)).toEqual(['close:2026-07-26']);
    expect(checks[0].actionTypeId).toBeUndefined();
  });

  it('is not squeezed out by the 10:00 obligation cap', () => {
    const many = Array.from({ length: 5 }, (_, i) => emi({ id: `e${i}`, dueDate: '2026-07-24' }));
    const plan = planNotifications(inputs({
      loans: [loan()], schedules: many, transactions: [expenseOn('2026-07-23')], dailyClose: dc(),
    }));
    expect(plan.some((p) => p.key === 'close:2026-07-24')).toBe(true);
  });
});
