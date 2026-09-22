// The reminder BRAIN: derives every scheduled notification from live state,
// so the schedule can never disagree with reality — a paid card bill simply
// produces no plan entries the next time we reschedule. Pure and tested; the
// Capacitor bridge lives in notificationScheduler.ts.
//
// Behavior contract (the anti-anxiety ladder):
//  - Only things that are ACTUALLY outstanding get reminders. Card bills
//    check owed > 0; EMIs check unpaid + active loan (card-funded ones are
//    the card's debt — suppressed when the card carries a due day, same as
//    thisWeek/inboxInfo); bills check status === 'upcoming'.
//  - Escalation by proximity: a gentle heads-up days ahead, firmer the day
//    before, assertive on the day — never after (overdue nagging lives in
//    the in-app To-do queue, not the lock screen).
//  - A daily cap keeps Hisaab from feeling like a collections agency.
import { daysUntilDayOfMonth } from './inboxInfo';
import { computeBudgetUsages } from '../stores/budgetStore';
import { daysUntil } from './subscriptionMetrics';
import { paymentsForRound, roundDate } from './committeeMath';
import { localIso } from './thisWeek';
import { buildCardStatement } from './cardStatement';
import { formatMoney } from './constants';
import { tStatic, type I18nKey } from './i18n';
import { dayActivity, quietDays, type DailyClose } from './dailyClose';
import type {
  Account,
  Budget,
  Committee,
  CommitteePayment,
  EmiSchedule,
  Loan,
  RecurringTransaction,
  Transaction,
  UpcomingExpense,
} from '../db';

export interface PlannedNotification {
  /** Stable int32 id derived from `key` — reschedules overwrite cleanly. */
  id: number;
  key: string;
  title: string;
  body: string;
  /** Epoch ms of the fire time (REMIND_HOUR local on the target day). */
  atMs: number;
  /** Route to open when the user taps the notification. */
  href: string;
  priority: number;
  /** Registered action-button set (the evening nudge's Add / Nothing today). */
  actionTypeId?: string;
  /** Fire through Doze — only the evening nudge, whose whole point is its time. */
  allowWhileIdle?: boolean;
}

/** The evening "daily close" nudge (section 7). Present only when the user
 *  switched it on; full-tracker only — ledger-only mode has no expenses. */
export interface DailyClosePlanInput {
  hour: number;
  minute: number;
  closes: DailyClose[];
  /** Last Hisaab-check day (YYYY-MM-DD), null if never done. */
  lastCheckIso: string | null;
}

export interface PlanInputs {
  accounts: Account[];
  loans: Loan[];
  schedules: EmiSchedule[];
  templates: RecurringTransaction[];
  upcoming: UpcomingExpense[];
  committees: Committee[];
  committeePayments: CommitteePayment[];
  // Budget breach (audit N-11) is DEVICE-LOCAL — see section 6 below. Both are
  // optional so an older caller (or a test fixture) keeps compiling and simply
  // produces no budget entries.
  budgets?: Budget[];
  transactions?: Transaction[];
  cardFundedLoanIds?: Map<string, string>;
  dailyClose?: DailyClosePlanInput;
  now: Date;
}

// 10:00 local — late enough to be awake, early enough to act the same day.
const REMIND_HOUR = 10;
const HORIZON_DAYS = 10;
const MAX_PER_DAY = 3;
const MAX_TOTAL = 24;

// FNV-1a 32-bit — stable across sessions so cancel/reschedule replaces
// rather than duplicates. Kept positive and below int32 max for Android.
export function notificationId(key: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i += 1) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % 2147483646 + 1;
}

export const DAILY_CLOSE_ACTION_TYPE = 'daily_close';
// Evening nudge: a week ahead (the scheduler rebuilds on every entry and
// every resume, so logging anything cancels that evening's nudge).
const CLOSE_HORIZON_DAYS = 7;
const CLOSE_TEMPLATES = 5;
const CHECK_EVERY_DAYS = 7;

/** Should the nudge ring on a day the user will have been quiet for `quiet`
 *  days? Backs off instead of nagging someone who's stopped listening:
 *  daily for the first 2 quiet days, every other day up to a week, then
 *  about twice a week. Any log or close resets `quiet` to 0. */
export function closeNudgeDue(quiet: number): boolean {
  if (quiet < 3) return true;
  if (quiet < 7) return (quiet - 3) % 2 === 0;
  return (quiet - 7) % 3 === 0;
}

function dayNumber(dayIso: string): number {
  return Math.round(Date.parse(`${dayIso}T00:00:00Z`) / 86_400_000);
}

function fireTime(now: Date, daysFromToday: number): number {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + daysFromToday, REMIND_HOUR, 0, 0).getTime();
}

export function planNotifications(inp: PlanInputs): PlannedNotification[] {
  const todayIso = localIso(inp.now);
  const nowMs = inp.now.getTime();
  const out: PlannedNotification[] = [];
  const push = (p: Omit<PlannedNotification, 'id'>) => {
    // Never schedule into the past — today's already-passed slots belong to
    // the in-app surfaces, not a notification that fires the moment the
    // schedule lands.
    if (p.atMs <= nowMs + 60_000) return;
    out.push({ ...p, id: notificationId(p.key) });
  };

  // 1. Card bills — ONLY while something is owed. T-3 / T-1 / T-0.
  const accountById = new Map(inp.accounts.map((a) => [a.id, a]));
  for (const a of inp.accounts) {
    if (a.type !== 'credit_card') continue;
    const dueDay = parseInt(a.metadata?.dueDay ?? '', 10);
    const d = daysUntilDayOfMonth(dueDay, inp.now);
    if (d === null || d > HORIZON_DAYS) continue;
    const limit = parseFloat(a.metadata.creditLimit || '0');
    const owed = limit > 0 ? Math.round((limit - a.balance) * 100) / 100 : null;
    if (owed !== null && owed <= 0.005) continue; // paid → silence, by construction
    // Remind about THIS cycle's statement (purchases + this cycle's instalment),
    // not the whole revolving balance. If the statement is already covered this
    // cycle (balance carries), stay quiet. Falls back to full owed when the
    // statement can't be computed (no statement day).
    const advanceLoans = inp.loans.filter(
      (l) => l.status === 'active' && inp.cardFundedLoanIds?.get(l.id) === a.id,
    );
    const statement = buildCardStatement({
      card: a, advanceLoans, schedules: inp.schedules, today: inp.now,
    });
    // Only a card WITH a limit can have a computable statement of 0 = "paid".
    // A no-limit card's statementDue is 0 because the amount is UNKNOWABLE, not
    // because nothing is owed — it must keep its (amount-less) reminder.
    if (statement && statement.hasLimit && statement.statementDue <= 0.005) continue;
    const dueAmount = statement && statement.hasLimit ? statement.statementDue : owed;
    const amount = dueAmount !== null ? formatMoney(dueAmount, a.currency) : '';
    const steps: Array<[number, string, number]> = [
      [3, tStatic('notif_bill_in').replace('{d}', '3'), 50],
      [1, tStatic('notif_bill_tomorrow'), 80],
      [0, tStatic('notif_bill_today'), 100],
    ];
    for (const [offset, template, priority] of steps) {
      if (d < offset) continue;
      push({
        // Step-based suffix: stable for the same event across replans on
        // different days (a days-from-now suffix would churn ids daily).
        key: `card:${a.id}:t${offset}`,
        title: a.name,
        // No-limit cards have no knowable amount — drop the separator too,
        // never ship "Bill due today —" with a dangling dash.
        body: amount
          ? template.replace('{amount}', amount)
          : template.replace(/\s*—\s*\{amount\}/u, '').trim(),
        atMs: fireTime(inp.now, d - offset),
        href: `/account/${a.id}`,
        priority,
      });
    }
  }

  // 2. EMI instalments on active loans — unpaid only, card-funded suppressed
  //    when the funding card has its own due day (same-debt-never-twice).
  const loanById = new Map(inp.loans.map((l) => [l.id, l]));
  for (const emi of inp.schedules) {
    if (emi.status === 'paid') continue;
    const loan = loanById.get(emi.loanId);
    if (!loan || loan.status !== 'active') continue;
    const fundingCardId = inp.cardFundedLoanIds?.get(loan.id);
    if (fundingCardId) {
      const card = accountById.get(fundingCardId);
      const cardDueDay = card ? parseInt(card.metadata?.dueDay ?? '', 10) : NaN;
      if (card && Number.isFinite(cardDueDay) && cardDueDay >= 1) continue;
    }
    const d = daysUntil(todayIso, emi.dueDate);
    if (d < 0 || d > HORIZON_DAYS) continue;
    const amount = formatMoney(emi.amount, loan.currency);
    const steps: Array<[number, string, number]> = [
      [1, tStatic('notif_emi_tomorrow'), 70],
      [0, tStatic('notif_emi_today'), 90],
    ];
    for (const [offset, template, priority] of steps) {
      if (d < offset) continue;
      push({
        key: `emi:${emi.id}:t${offset}`,
        title: loan.personName,
        body: template.replace('{n}', String(emi.installmentNumber)).replace('{amount}', amount),
        atMs: fireTime(inp.now, d - offset),
        href: `/loan/${emi.loanId}`,
        priority,
      });
    }
  }

  // 3. Recurring charges — day-of only (the in-app prompt does the posting;
  //    the notification just brings the user to it). Income templates are
  //    not obligations; skip them.
  for (const tpl of inp.templates) {
    if (!tpl.active || tpl.type === 'income') continue;
    const d = daysUntil(todayIso, tpl.nextDueDate);
    if (d < 0 || d > HORIZON_DAYS) continue;
    push({
      key: `recurring:${tpl.id}:${tpl.nextDueDate}`,
      title: tpl.label || tpl.category,
      body: tStatic('notif_recurring_today').replace('{amount}', formatMoney(tpl.amount, tpl.currency)),
      atMs: fireTime(inp.now, d),
      href: '/subscriptions',
      priority: 60,
    });
  }

  // 4. One-off upcoming bills — their own reminder window + day-of.
  for (const e of inp.upcoming) {
    if (e.status !== 'upcoming') continue;
    const d = daysUntil(todayIso, e.dueDate.slice(0, 10));
    if (d < 0 || d > HORIZON_DAYS) continue;
    const lead = Math.max(1, e.reminderDaysBefore ?? 3);
    const amount = formatMoney(e.amount, e.currency);
    // Distinct key suffixes: when d === lead the lead reminder and the
    // day-of reminder are different notifications on different days.
    if (d > lead) {
      push({
        key: `bill:${e.id}:lead`,
        title: e.title,
        // lead === 1 reads as "tomorrow", not "in 1 days".
        body: (lead === 1
          ? tStatic('notif_bill_tomorrow')
          : tStatic('notif_bill_in').replace('{d}', String(lead))
        ).replace('{amount}', amount),
        atMs: fireTime(inp.now, d - lead),
        href: '/',
        priority: 55,
      });
    }
    push({
      key: `bill:${e.id}:t0`,
      title: e.title,
      body: tStatic('notif_bill_today').replace('{amount}', amount),
      atMs: fireTime(inp.now, d),
      href: '/',
      priority: 75,
    });
  }

  // 5. Kameti rounds — day-of, collection framing (no "me" member flag).
  //    A round already fully collected is DONE: it must not ring (same
  //    outstanding-ness gate every other category has).
  for (const c of inp.committees) {
    if (c.status !== 'active') continue;
    const paymentsOfC = inp.committeePayments.filter((p) => p.committeeId === c.id);
    for (let r = 1; r <= c.totalRounds; r += 1) {
      const d = daysUntil(todayIso, localIso(roundDate(c.startDate, c.cadence, r)));
      if (d < 0 || d > HORIZON_DAYS) continue;
      if (paymentsForRound(paymentsOfC, r).length >= c.memberCount) continue;
      push({
        key: `kameti:${c.id}:${r}`,
        title: c.name,
        body: tStatic('notif_kameti_round')
          .replace('{r}', String(r))
          .replace('{amount}', formatMoney(c.contributionAmount, c.currency)),
        atMs: fireTime(inp.now, d),
        href: `/kameti/${c.id}`,
        priority: 45,
      });
    }
  }

  // 6. Budget breach — DEVICE-LOCAL ONLY.
  //
  //    Audit N-11: "Budget breached → Derived Inbox Info card only, visible
  //    when the user opens the Inbox (inboxInfo.ts:140-152). No push/local
  //    reminder even when reminders are on. Monarch/banks alert at 80%/100%.
  //    The planner already has budgets adjacent; a `budget:{id}:80` plan entry
  //    is cheap."
  //
  //    This is deliberately NOT a server trigger and writes NO notifications
  //    row: budgets are computed entirely on the client
  //    (computeBudgetUsages over local transactions), so the database has no
  //    opinion about whether a budget is breached and could not honestly
  //    author one. Consequences the reader should know:
  //      · it fires on THIS DEVICE only — a second phone gets its own copy
  //        derived from its own synced state, and a web-only user gets none;
  //      · it never becomes a push and never reaches the Inbox or the bell;
  //      · it is subject to the same opt-in switch as every other reminder.
  //    Documented as such in docs/notifications.md.
  //
  //    Fire time: today at REMIND_HOUR while that is still ahead, otherwise
  //    tomorrow — a breach found at 14:00 must not silently produce nothing
  //    (push() drops past times). Never scheduled past the end of the month:
  //    the budget resets and a stale "over budget" the following month is a
  //    lie by construction.
  const budgets = inp.budgets ?? [];
  if (budgets.length > 0) {
    const monthEndMs = new Date(inp.now.getFullYear(), inp.now.getMonth() + 1, 1).getTime();
    const todaySlot = fireTime(inp.now, 0);
    const atMs = todaySlot > nowMs + 60_000 ? todaySlot : fireTime(inp.now, 1);
    if (atMs < monthEndMs) {
      for (const u of computeBudgetUsages(budgets, inp.transactions ?? [], inp.now)) {
        // Only the strongest state for a given budget — an over-limit budget
        // is also over-warn, and two entries for one category is nagging.
        const over = u.overLimit;
        if (!over && !u.overWarn) continue;
        const spent = formatMoney(u.spent, u.budget.currency);
        const cap = formatMoney(u.budget.monthlyAmount, u.budget.currency);
        push({
          // The month is part of the key so a new month is a new reminder
          // rather than a silently-replaced stale one.
          key: `budget:${u.budget.id}:${over ? 'over' : 'warn'}:${todayIso.slice(0, 7)}`,
          title: u.budget.category,
          body: (over ? tStatic('notif_budget_over') : tStatic('notif_budget_warn'))
            .replace('{spent}', spent)
            .replace('{limit}', cap)
            .replace('{pct}', String(Math.round(u.percent))),
          atMs,
          href: '/budgets',
          // Below every hard obligation (bills, EMIs, recurring): a budget is
          // information, not a due date.
          priority: over ? 40 : 30,
        });
      }
    }
  }

  // 7. Daily close — the evening "log today" nudge (opt-in, separate switch).
  //    Its own lane: it is never squeezed out by the 10:00 obligation cap,
  //    and at most one per evening.
  const evening: PlannedNotification[] = [];
  if (inp.dailyClose) {
    const dc = inp.dailyClose;
    const txns = inp.transactions ?? [];
    const today = dayActivity(txns, dc.closes, todayIso);
    const activeToday = today.loggedToday || today.closedToday !== null;
    const quietNow = quietDays(txns, dc.closes, todayIso) ?? 0;
    let checkOffered = false;
    for (let i = 0; i < CLOSE_HORIZON_DAYS; i += 1) {
      if (i === 0 && activeToday) continue;
      const atMs = new Date(
        inp.now.getFullYear(), inp.now.getMonth(), inp.now.getDate() + i, dc.hour, dc.minute, 0,
      ).getTime();
      if (atMs <= nowMs + 60_000) continue;
      // Projected quiet days on that evening, assuming nothing gets logged
      // in between (if something does, this plan is rebuilt anyway).
      const quiet = activeToday ? i : quietNow + i;
      if (!closeNudgeDue(quiet)) continue;
      const dayIso = localIso(new Date(atMs));
      const checkDue = !checkOffered && (
        dc.lastCheckIso === null || dayNumber(dayIso) - dayNumber(dc.lastCheckIso) >= CHECK_EVERY_DAYS
      );
      if (checkDue) {
        checkOffered = true;
        evening.push({
          id: notificationId(`close:${dayIso}`),
          key: `close:${dayIso}`,
          title: tStatic('notif_check_title'),
          body: tStatic('notif_check_body'),
          atMs,
          href: '/?check=1',
          priority: 65,
          allowWhileIdle: true,
        });
        continue;
      }
      // Rotate the wording by calendar day — consecutive evenings never
      // repeat (a template seen every night stops being read).
      const n = (dayNumber(dayIso) % CLOSE_TEMPLATES) + 1;
      evening.push({
        id: notificationId(`close:${dayIso}`),
        key: `close:${dayIso}`,
        title: tStatic(`notif_close_t${n}` as I18nKey),
        body: tStatic(`notif_close_b${n}` as I18nKey),
        atMs,
        href: '/?close=today',
        priority: 65,
        actionTypeId: DAILY_CLOSE_ACTION_TYPE,
        allowWhileIdle: true,
      });
    }
  }

  // Daily cap: the most important few win; the rest stay in-app. Then a
  // global cap to stay well inside Android's pending-alarm budget.
  const byDay = new Map<string, PlannedNotification[]>();
  for (const p of out) {
    const day = localIso(new Date(p.atMs));
    const list = byDay.get(day) ?? [];
    list.push(p);
    byDay.set(day, list);
  }
  const capped: PlannedNotification[] = [];
  for (const list of byDay.values()) {
    list.sort((a, b) => b.priority - a.priority);
    capped.push(...list.slice(0, MAX_PER_DAY));
  }
  capped.push(...evening);
  return capped
    .sort((a, b) => a.atMs - b.atMs || b.priority - a.priority)
    .slice(0, MAX_TOTAL);
}
