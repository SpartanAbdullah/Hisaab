import { describe, it, expect } from 'vitest';
import { detectRecoveryArrival, stripResetMarker } from './passwordRecovery';

describe('detectRecoveryArrival', () => {
  it('is "none" on an ordinary boot', () => {
    expect(detectRecoveryArrival('', '')).toBe('none');
    expect(detectRecoveryArrival('?add=expense', '')).toBe('none');
    expect(detectRecoveryArrival('', '#/some/hash/route')).toBe('none');
  });

  it('recognises the implicit-flow reset link (marker + type=recovery in the hash)', () => {
    expect(
      detectRecoveryArrival('?reset=1', '#access_token=a.b.c&expires_in=3600&refresh_token=r&token_type=bearer&type=recovery'),
    ).toBe('recovery');
  });

  it('recognises the pkce-flow reset link (marker only — auth-js never raises PASSWORD_RECOVERY there)', () => {
    expect(detectRecoveryArrival('?reset=1&code=abc123', '')).toBe('recovery');
  });

  it('recognises type=recovery without the marker (a link built before the marker existed)', () => {
    expect(detectRecoveryArrival('', '#access_token=x&type=recovery')).toBe('recovery');
    expect(detectRecoveryArrival('?type=recovery', '')).toBe('recovery');
  });

  it('still works once auth-js has blanked the hash (only the query marker survives)', () => {
    expect(detectRecoveryArrival('?reset=1', '')).toBe('recovery');
    expect(detectRecoveryArrival('?reset=1', '#')).toBe('recovery');
  });

  it('ignores a reset marker with the wrong value', () => {
    expect(detectRecoveryArrival('?reset=0', '')).toBe('none');
    expect(detectRecoveryArrival('?reset=', '')).toBe('none');
  });

  it('reports an expired or already-used reset link', () => {
    expect(
      detectRecoveryArrival('?reset=1', '#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired'),
    ).toBe('expired');
    // Some GoTrue versions put the error in the query instead of the hash.
    expect(detectRecoveryArrival('?reset=1&error=access_denied&error_code=otp_expired', '')).toBe('expired');
  });

  it('does not claim an auth error that has no reset marker (signup / magic-link failures)', () => {
    expect(detectRecoveryArrival('', '#error=access_denied&error_code=otp_expired')).toBe('none');
  });

  it('never treats a signup-confirmation arrival as a recovery', () => {
    expect(detectRecoveryArrival('', '#access_token=x&type=signup')).toBe('none');
  });
});

describe('stripResetMarker', () => {
  it('removes only the reset marker and keeps the hash auth-js still needs', () => {
    expect(stripResetMarker('https://usehisaab.com/?reset=1#access_token=x&type=recovery'))
      .toBe('https://usehisaab.com/#access_token=x&type=recovery');
  });

  it('keeps unrelated query params', () => {
    expect(stripResetMarker('https://usehisaab.com/?reset=1&code=abc')).toBe('https://usehisaab.com/?code=abc');
  });

  it('returns null when there is nothing to strip (so no replaceState is issued)', () => {
    expect(stripResetMarker('https://usehisaab.com/')).toBeNull();
    expect(stripResetMarker('https://usehisaab.com/?add=expense')).toBeNull();
    expect(stripResetMarker('not a url')).toBeNull();
  });
});
