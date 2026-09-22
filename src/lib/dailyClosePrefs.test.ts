import { beforeEach, describe, expect, it } from 'vitest';
import {
  DAILY_CLOSE_KEY,
  DAILY_CLOSE_TIME_KEY,
  dailyCloseEnabled,
  dailyCloseTime,
  parseCloseTime,
  setDailyCloseTime,
} from './dailyClosePrefs';

describe('dailyClosePrefs', () => {
  beforeEach(() => localStorage.clear());

  it('is opt-in: only the literal "true" enables it', () => {
    expect(dailyCloseEnabled()).toBe(false);
    localStorage.setItem(DAILY_CLOSE_KEY, 'yes');
    expect(dailyCloseEnabled()).toBe(false);
    localStorage.setItem(DAILY_CLOSE_KEY, 'true');
    expect(dailyCloseEnabled()).toBe(true);
  });

  it('defaults to 21:30 and rejects malformed times', () => {
    expect(dailyCloseTime()).toBe('21:30');
    localStorage.setItem(DAILY_CLOSE_TIME_KEY, '25:00');
    expect(dailyCloseTime()).toBe('21:30');
    expect(setDailyCloseTime('9:5')).toBe(false);
    expect(setDailyCloseTime('20:45')).toBe(true);
    expect(dailyCloseTime()).toBe('20:45');
  });

  it('parses HH:MM, falling back to the default', () => {
    expect(parseCloseTime('07:05')).toEqual({ hour: 7, minute: 5 });
    expect(parseCloseTime('nope')).toEqual({ hour: 21, minute: 30 });
  });
});
