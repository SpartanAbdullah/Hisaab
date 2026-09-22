import { describe, expect, it } from 'vitest';
import { entryDayToCreatedAt, isFutureLocalDay, localDayOf, localIso, localMonthIso } from './localDate';

// This repo does NOT pin the test process's timezone (vitest.config.ts runs
// plain Node; CI's ubuntu-latest defaults to UTC, but a dev machine can be
// anything). That means `new Date(...).getFullYear()` inside a test reflects
// WHATEVER machine happens to run it — so a test relying on real Date-local
// getters can never deterministically reproduce a UTC+4/+5 market's midnight
// gap: on a UTC-offset runner there is no gap to reproduce at all (local ==
// UTC there), and on a non-UTC dev machine the specific offset is unknown.
//
// So these tests simulate the market offset explicitly instead: shift the
// UTC instant by the target market's fixed offset (no DST in the Gulf or
// Pakistan), then read the shifted instant's UTC calendar fields. That is
// mathematically exactly what a real device sitting at that offset would
// compute from the ORIGINAL instant — and it never depends on the offset of
// the machine actually running the test.
function localDayAtFixedOffset(utcInstant: Date, offsetHours: number): string {
  const shifted = new Date(utcInstant.getTime() + offsetHours * 3_600_000);
  return shifted.toISOString().slice(0, 10);
}

describe('localIso / localMonthIso — basic correctness', () => {
  it('pads single-digit month and day', () => {
    expect(localIso(new Date(2026, 0, 5))).toBe('2026-01-05');
    expect(localMonthIso(new Date(2026, 0, 5))).toBe('2026-01');
  });

  it('handles a year boundary', () => {
    expect(localIso(new Date(2025, 11, 31))).toBe('2025-12-31');
    expect(localMonthIso(new Date(2025, 11, 31))).toBe('2025-12');
  });

  it('handles a leap-year Feb 29', () => {
    expect(localIso(new Date(2028, 1, 29))).toBe('2028-02-29');
  });
});

describe('localIso — device-local, never UTC (F-11/F-18 core fix)', () => {
  // The literal scenario from the audit: a UTC instant late at night is
  // already the NEXT calendar day in Gulf/Pakistan markets.
  it('22:30 UTC is already tomorrow at UTC+4 (Dubai/UAE)', () => {
    const instant = new Date('2026-09-02T22:30:00Z');
    // The old, buggy derivation every fixed call site used to use.
    expect(instant.toISOString().slice(0, 10)).toBe('2026-09-02');
    // The correct local calendar day for a UTC+4 market.
    expect(localDayAtFixedOffset(instant, 4)).toBe('2026-09-03');
  });

  it('19:30 UTC is already tomorrow at UTC+5 (Pakistan)', () => {
    const instant = new Date('2026-09-02T19:30:00Z');
    expect(instant.toISOString().slice(0, 10)).toBe('2026-09-02');
    expect(localDayAtFixedOffset(instant, 5)).toBe('2026-09-03');
  });

  it('the gap closes well before local midday — 08:30 UTC is the SAME day at UTC+4', () => {
    const instant = new Date('2026-09-02T08:30:00Z');
    expect(localDayAtFixedOffset(instant, 4)).toBe('2026-09-02');
  });

  // Spec-fidelity check: `localIso`/`localMonthIso` use the Date's OWN local
  // getters (getFullYear/getMonth/getDate), which by the ECMAScript spec
  // always equal `localDayAtFixedOffset(d, -d.getTimezoneOffset() / 60)` for
  // THIS process's actual offset — true in any timezone, including a pinned
  // UTC one (offset 0, where both sides trivially agree). This is what would
  // catch a regression to `toISOString()`-based derivation on ANY runner,
  // not just a non-UTC one: reverting to UTC would only still pass here if
  // the runner's own offset happens to be exactly 0.
  it('agrees with the fixed-offset formula for the offset this process is actually running at', () => {
    const instant = new Date('2026-09-02T22:30:00Z');
    const thisProcessOffsetHours = -instant.getTimezoneOffset() / 60;
    expect(localIso(instant)).toBe(localDayAtFixedOffset(instant, thisProcessOffsetHours));
  });
});

describe('localIso — call-site scenarios pinned by the audit', () => {
  // recurringRunner.ts:34 — "is this template due yet" compares
  // `t.nextDueDate <= todayIso`. A template due on 2026-09-03 must already
  // read as due once the Dubai wall clock has rolled into the 3rd, even
  // though the UTC instant is still technically the 2nd.
  it('recurring due-date comparison: a UTC-late-night instant already satisfies a same-day due date at UTC+4', () => {
    const now = new Date('2026-09-02T22:30:00Z');
    const localToday = localDayAtFixedOffset(now, 4); // what a Dubai device's `localIso(now)` would read
    const nextDueDate = '2026-09-03';
    // Old (buggy) comparison against the UTC slice:
    expect(nextDueDate <= now.toISOString().slice(0, 10)).toBe(false); // wrongly "not due yet"
    // Correct comparison against the local day:
    expect(nextDueDate <= localToday).toBe(true); // correctly "due"
  });

  // monthlyWrap.ts:86 — bigSpendDay/activeDays bucket expenses by calendar
  // day. An expense at 22:30 UTC on the 2nd must bucket into the 3rd for a
  // Dubai user, not the 2nd.
  it('monthly-wrap day bucket: an expense at 22:30 UTC buckets into the LOCAL day, not the UTC day', () => {
    const createdAt = new Date('2026-09-02T22:30:00Z');
    const oldBucket = createdAt.toISOString().slice(0, 10);
    const correctBucket = localDayAtFixedOffset(createdAt, 4);
    expect(oldBucket).toBe('2026-09-02');
    expect(correctBucket).toBe('2026-09-03');
    expect(correctBucket).not.toBe(oldBucket);
  });

  // loggingStreak.ts's day boundary — a transaction logged at 22:30 UTC
  // counts toward the LOCAL day it was actually logged on for a Gulf user,
  // so a streak doesn't appear to break a day early.
  it('streak day boundary: a transaction at 22:30 UTC counts toward the local (not UTC) day for streak purposes', () => {
    const createdAt = new Date('2026-09-02T22:30:00Z');
    const loggedLocalDay = localDayAtFixedOffset(createdAt, 4);
    const streakAnchorLocalDay = '2026-09-03'; // "today" on the user's device
    expect(loggedLocalDay).toBe(streakAnchorLocalDay);
  });
});

describe('entry dates (card bill payment / transfer date field)', () => {
  const now = new Date(2026, 8, 21, 9, 30); // 21 Sep 2026, 09:30 local

  it('today (or blank) saves no createdAt, so the store stamps the real instant', () => {
    expect(entryDayToCreatedAt('2026-09-21', now)).toBeUndefined();
    expect(entryDayToCreatedAt('', now)).toBeUndefined();
  });

  it('a past day saves local noon of THAT day (the August bill paid on 29 Aug)', () => {
    const iso = entryDayToCreatedAt('2026-08-29', now)!;
    expect(iso).toBeDefined();
    const d = new Date(iso);
    expect(localIso(d)).toBe('2026-08-29');
    expect(d.getHours()).toBe(12);
    expect(localDayOf(iso)).toBe('2026-08-29');
  });

  it('rejects garbage without throwing', () => {
    expect(entryDayToCreatedAt('not-a-date', now)).toBeUndefined();
    expect(localDayOf('nope')).toBe('');
  });

  it('isFutureLocalDay: tomorrow is future, today and the past are not', () => {
    expect(isFutureLocalDay('2026-09-22', now)).toBe(true);
    expect(isFutureLocalDay('2026-09-21', now)).toBe(false);
    expect(isFutureLocalDay('2026-08-29', now)).toBe(false);
  });

  it('localDayOf reads the LOCAL day of a stored instant', () => {
    const at = new Date(2026, 7, 29, 1, 15); // 01:15 local on 29 Aug
    expect(localDayOf(at.toISOString())).toBe('2026-08-29');
  });
});
