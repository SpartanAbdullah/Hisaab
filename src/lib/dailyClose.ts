// Daily close — the evening habit that keeps balances honest. The whole
// 2026-09 reconciliation (missed bill payments, unrecorded spends, accounts
// untouched since July) was drift that a two-minute evening check prevents.
//
// A day "counts" when the user either logged something on it or explicitly
// closed it ("nothing spent today" is real information, not a gap). The
// streak is forgiving on purpose — one missed day per rolling week does not
// break it (Duolingo's streak-freeze finding: forgiveness keeps people in,
// a broken streak makes them quit). Pure + tested; the store and the sheet
// live elsewhere.
import { dayOf, shiftDay } from './loggingStreak';
import { normalizePayee, buildPayeeProfiles } from './payeeMemory';
import { parseInternalNote } from './internalNotes';
import type { Transaction, TransactionType } from '../db';

export type DailyCloseKind = 'no_spend' | 'closed';

export interface DailyClose {
  /** Local calendar day, YYYY-MM-DD. */
  day: string;
  kind: DailyCloseKind;
}

// Bookkeeping rows are not "logging": an opening balance or a Correct-balance
// adjustment says nothing about whether today's spending was recorded.
const NOT_ACTIVITY: ReadonlySet<TransactionType> = new Set<TransactionType>(['opening_balance', 'adjustment']);

export function isLoggedActivity(txn: Transaction): boolean {
  return !txn.deletedAt && !NOT_ACTIVITY.has(txn.type);
}

export interface DayActivity {
  loggedToday: boolean;
  /** The close marker for today, if the user closed it. */
  closedToday: DailyCloseKind | null;
  /** Today's logged rows, newest first. */
  entriesToday: Transaction[];
}

export function dayActivity(txns: Transaction[], closes: DailyClose[], todayIso: string): DayActivity {
  const today = dayOf(todayIso);
  const entriesToday = txns
    .filter((t) => isLoggedActivity(t) && dayOf(t.createdAt) === today)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const close = closes.find((c) => c.day === today);
  return { loggedToday: entriesToday.length > 0, closedToday: close?.kind ?? null, entriesToday };
}

function activeDays(txns: Transaction[], closes: DailyClose[]): Set<string> {
  const days = new Set<string>();
  for (const t of txns) if (isLoggedActivity(t)) days.add(dayOf(t.createdAt));
  for (const c of closes) days.add(c.day);
  days.delete('');
  return days;
}

function daysBetween(fromIso: string, toIso: string): number {
  return Math.round((Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / 86_400_000);
}

export interface CloseStreak {
  streak: number;
  activeToday: boolean;
  /** A rest (grace) day was spent within the last 7 days — the UI says so,
   *  so the forgiveness is visible rather than a silent fudge. */
  graceUsedRecently: boolean;
}

/** Days apart two grace days must be — "one missed day per rolling week". */
export const GRACE_SPACING_DAYS = 7;
// A streak can't be longer than the ledger; this only bounds a pathological loop.
const MAX_WALK_DAYS = 3650;

export function computeCloseStreak(txns: Transaction[], closes: DailyClose[], todayIso: string): CloseStreak {
  const today = dayOf(todayIso);
  const days = activeDays(txns, closes);
  const activeToday = days.has(today);

  // A not-yet-closed today never breaks anything — the day isn't over.
  let cursor = activeToday ? today : shiftDay(today, -1);
  let streak = 0;
  let lastGraceStep = -Infinity;
  let graceUsedRecently = false;
  for (let step = 0; step < MAX_WALK_DAYS; step += 1) {
    if (days.has(cursor)) {
      streak += 1;
    } else {
      // Grace: a single missing day bridged by an active day before it, and
      // no other grace within the last week of the walk.
      const bridged = days.has(shiftDay(cursor, -1));
      if (!bridged || step - lastGraceStep < GRACE_SPACING_DAYS) break;
      lastGraceStep = step;
      if (daysBetween(cursor, today) <= GRACE_SPACING_DAYS) graceUsedRecently = true;
    }
    cursor = shiftDay(cursor, -1);
  }
  if (streak === 0) graceUsedRecently = false;
  return { streak, activeToday, graceUsedRecently };
}

/** Whole days since the user last logged or closed a day (0 = today).
 *  null when there's no activity at all — a brand-new user is not "ignoring"
 *  anything, so the planner treats null as 0. */
export function quietDays(txns: Transaction[], closes: DailyClose[], todayIso: string): number | null {
  const today = dayOf(todayIso);
  let latest: string | null = null;
  for (const d of activeDays(txns, closes)) {
    if (d > today) continue;
    if (latest === null || d > latest) latest = d;
  }
  return latest === null ? null : daysBetween(latest, today);
}

export interface UsualItem {
  key: string;
  /** What the chip shows — the payee as the user last spelled it, or the category. */
  label: string;
  /** Pre-filled note ('' for a category-only chip). */
  notes: string;
  category: string;
  accountId: string | null;
  lastAmount: number;
  currency: string;
  count: number;
}

const USUAL_WINDOW_DAYS = 30;
// Recency half-weight: a use a week and a half old counts about half as much.
const RECENCY_SCALE_DAYS = 10;

/**
 * The user's usual everyday expenses — "Food 18", "Taxi 12" — for one-tap
 * logging from the daily-close sheet. Payees (used on ≥2 days in the last 30)
 * ranked by recency-weighted frequency, topped up with the most-used
 * categories (also used on ≥2 days) when there aren't enough named payees.
 */
export function usualItems(txns: Transaction[], now: Date, limit = 6): UsualItem[] {
  const cutoffMs = now.getTime() - USUAL_WINDOW_DAYS * 86_400_000;
  const recent = txns.filter((t) => {
    if (t.type !== 'expense' || t.deletedAt) return false;
    const ms = Date.parse(t.createdAt);
    return Number.isFinite(ms) && ms >= cutoffMs && ms <= now.getTime();
  });
  const weight = (t: Transaction) =>
    Math.exp(-(now.getTime() - Date.parse(t.createdAt)) / (RECENCY_SCALE_DAYS * 86_400_000));

  // Full-history profiles give the stable category/account habit; the recent
  // window decides which payees are "usual" right now.
  const profiles = buildPayeeProfiles(txns);
  const byPayee = new Map<string, { score: number; uses: Transaction[] }>();
  const byCategory = new Map<string, { score: number; uses: Transaction[] }>();
  for (const t of recent) {
    const parsed = parseInternalNote(t.notes);
    if (parsed.meta.groupExpenseId) continue;
    const normalized = normalizePayee(parsed.visibleNote);
    if (normalized.length >= 3) {
      const e = byPayee.get(normalized) ?? { score: 0, uses: [] };
      e.score += weight(t);
      e.uses.push(t);
      byPayee.set(normalized, e);
    }
    if (t.category) {
      const c = byCategory.get(t.category) ?? { score: 0, uses: [] };
      c.score += weight(t);
      c.uses.push(t);
      byCategory.set(t.category, c);
    }
  }

  const newest = (uses: Transaction[]) => uses.reduce((a, b) => (b.createdAt > a.createdAt ? b : a));
  const items: UsualItem[] = [];
  // A habit repeats on DIFFERENT days — two charges on one day (a licence
  // paid in two parts) is a one-off, not an everyday chip. Same rule for
  // payees and categories.
  const habitual = (uses: Transaction[]) => new Set(uses.map((u) => dayOf(u.createdAt))).size >= 2;
  const payees = [...byPayee.entries()]
    .filter(([, e]) => habitual(e.uses))
    .sort((a, b) => b[1].score - a[1].score);
  for (const [normalized, e] of payees) {
    if (items.length >= limit) break;
    const last = newest(e.uses);
    const profile = profiles.get(normalized);
    items.push({
      key: `payee:${normalized}`,
      label: parseInternalNote(last.notes).visibleNote.trim(),
      notes: parseInternalNote(last.notes).visibleNote.trim(),
      category: profile?.category || last.category || '',
      accountId: profile?.accountId ?? last.sourceAccountId ?? null,
      lastAmount: last.amount,
      currency: last.currency,
      count: e.uses.length,
    });
  }

  // Categories already represented by a payee chip would just duplicate it.
  const covered = new Set(items.map((i) => i.category).filter(Boolean));
  const categories = [...byCategory.entries()]
    .filter(([, e]) => habitual(e.uses))
    .sort((a, b) => b[1].score - a[1].score);
  for (const [category, e] of categories) {
    if (items.length >= limit) break;
    if (covered.has(category)) continue;
    const last = newest(e.uses);
    items.push({
      key: `category:${category}`,
      label: category,
      notes: '',
      category,
      accountId: last.sourceAccountId ?? null,
      lastAmount: last.amount,
      currency: last.currency,
      count: e.uses.length,
    });
  }
  return items;
}
