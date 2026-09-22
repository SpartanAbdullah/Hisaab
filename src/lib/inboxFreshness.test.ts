import { describe, expect, it } from 'vitest';
import { INBOX_FRESH_MS, planInboxLoad } from './inboxFreshness';

describe('planInboxLoad', () => {
  const now = 1_000_000;

  it('is cold when the Inbox has never loaded this session', () => {
    expect(planInboxLoad(null, now)).toBe('cold');
  });

  it('is fresh inside the window', () => {
    expect(planInboxLoad(now - 1, now)).toBe('fresh');
    expect(planInboxLoad(now - (INBOX_FRESH_MS - 1), now)).toBe('fresh');
  });

  it('revalidates once the window has passed', () => {
    expect(planInboxLoad(now - INBOX_FRESH_MS, now)).toBe('revalidate');
    expect(planInboxLoad(now - 10 * INBOX_FRESH_MS, now)).toBe('revalidate');
  });

  it('revalidates when the clock went backwards instead of trusting it', () => {
    expect(planInboxLoad(now + 5_000, now)).toBe('revalidate');
  });

  it('treats a non-finite stamp as never loaded', () => {
    expect(planInboxLoad(Number.NaN, now)).toBe('cold');
  });

  it('honours a custom window', () => {
    expect(planInboxLoad(now - 500, now, 1_000)).toBe('fresh');
    expect(planInboxLoad(now - 1_500, now, 1_000)).toBe('revalidate');
  });
});
