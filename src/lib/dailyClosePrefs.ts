// Daily-close reminder preferences (device-local, like the payment reminders
// switch). OPT-IN: the evening nudge only exists once the user turns it on in
// Settings, which also runs the Android 13 permission prompt. Pure +
// storage-only so it stays unit-testable.

export const DAILY_CLOSE_KEY = 'hisaab_daily_close_enabled';
export const DAILY_CLOSE_TIME_KEY = 'hisaab_daily_close_time';
/** 21:30 — after dinner, before bed: the day's spending is done. */
export const DEFAULT_DAILY_CLOSE_TIME = '21:30';

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function dailyCloseEnabled(): boolean {
  try {
    return localStorage.getItem(DAILY_CLOSE_KEY) === 'true';
  } catch {
    return false;
  }
}

/** The stored "HH:MM", or the default when absent/malformed. */
export function dailyCloseTime(): string {
  try {
    const v = localStorage.getItem(DAILY_CLOSE_TIME_KEY);
    if (v && TIME_RE.test(v)) return v;
  } catch {
    /* storage off */
  }
  return DEFAULT_DAILY_CLOSE_TIME;
}

export function parseCloseTime(value: string): { hour: number; minute: number } {
  const m = TIME_RE.exec(value) ?? TIME_RE.exec(DEFAULT_DAILY_CLOSE_TIME)!;
  return { hour: Number(m[1]), minute: Number(m[2]) };
}

/** Persist a time from an <input type="time"> ("HH:MM"). Ignores junk. */
export function setDailyCloseTime(value: string): boolean {
  if (!TIME_RE.test(value)) return false;
  try {
    localStorage.setItem(DAILY_CLOSE_TIME_KEY, value);
    return true;
  } catch {
    return false;
  }
}
