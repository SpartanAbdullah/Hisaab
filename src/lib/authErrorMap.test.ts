import { describe, it, expect } from 'vitest';
import { mapAuthError, AUTH_ERROR_MAP } from './authErrorMap';

describe('mapAuthError', () => {
  it('maps invalid credentials to a reset detour', () => {
    const d = mapAuthError('Invalid login credentials');
    expect(d.msgKey).toBe('err_invalid_credentials');
    expect(d.action).toBe('reset');
  });

  it('maps both phrasings of a duplicate signup to a login detour', () => {
    for (const s of ['User already registered', 'Email address has already been registered']) {
      const d = mapAuthError(s);
      expect(d.msgKey).toBe('err_already_registered');
      expect(d.action).toBe('login');
    }
  });

  it('maps an unconfirmed email to a resend detour', () => {
    const d = mapAuthError('Email not confirmed');
    expect(d.msgKey).toBe('err_email_not_confirmed');
    expect(d.action).toBe('resend');
  });

  it('maps a too-short password to a fixPassword detour on the password field', () => {
    const d = mapAuthError('Password should be at least 6 characters.');
    expect(d.msgKey).toBe('err_password_short');
    expect(d.action).toBe('fixPassword');
    expect(d.field).toBe('password');
  });

  it('maps a same-as-old password (set-new-password screen) to a fixPassword detour', () => {
    const d = mapAuthError('New password should be different from the old password.');
    expect(d.msgKey).toBe('err_password_same');
    expect(d.action).toBe('fixPassword');
    expect(d.field).toBe('password');
  });

  it('maps a vanished recovery session to a reset detour', () => {
    const d = mapAuthError('Auth session missing!');
    expect(d.msgKey).toBe('err_recovery_session_missing');
    expect(d.action).toBe('reset');
  });

  // Ordering is load-bearing: specific throttles must win over generic 'rate limit'.
  it('prefers the security-throttle message over the generic rate limit', () => {
    const d = mapAuthError('For security purposes, you can only request this after 21 seconds.');
    expect(d.msgKey).toBe('err_security_throttle');
  });

  it('prefers the email-rate-limit message over the generic rate limit', () => {
    const d = mapAuthError('Email rate limit exceeded');
    expect(d.msgKey).toBe('err_email_rate_limit');
  });

  it('falls back to the generic rate limit for other rate-limit messages', () => {
    const d = mapAuthError('Request rate limit reached');
    expect(d.msgKey).toBe('err_rate_limit');
  });

  it('maps invalid-email messages to an editEmail detour on the email field', () => {
    for (const s of ['Unable to validate email address: invalid format', 'Invalid email']) {
      const d = mapAuthError(s);
      expect(d.msgKey).toBe('err_bad_email');
      expect(d.action).toBe('editEmail');
      expect(d.field).toBe('email');
    }
  });

  it('maps network failures to a retry detour', () => {
    for (const s of ['Failed to fetch', 'NetworkError when attempting to fetch resource']) {
      const d = mapAuthError(s);
      expect(d.msgKey).toBe('err_network');
      expect(d.action).toBe('retry');
    }
  });

  it('maps the deleted-account message to a newAccount detour', () => {
    const d = mapAuthError('This account has been deleted. Please create a new account to use Hisaab again.');
    expect(d.msgKey).toBe('err_deleted_account');
    expect(d.action).toBe('newAccount');
  });

  it('is case-insensitive', () => {
    expect(mapAuthError('INVALID LOGIN CREDENTIALS').msgKey).toBe('err_invalid_credentials');
  });

  it('never leaks a raw string — unknown and empty inputs hit the generic catch-all', () => {
    for (const s of ['some brand new supabase error', '', undefined as unknown as string]) {
      const d = mapAuthError(s);
      expect(d.msgKey).toBe('err_generic');
      expect(d.action).toBe('retry');
    }
  });

  it('always returns a complete detour (msgKey + actionKey + action)', () => {
    const d = mapAuthError('anything at all');
    expect(d.msgKey).toBeTruthy();
    expect(d.actionKey).toBeTruthy();
    expect(d.action).toBeTruthy();
  });

  it('keeps a single empty catch-all entry, and it is last', () => {
    const emptyIdxs = AUTH_ERROR_MAP.map((e, i) => (e.match === '' ? i : -1)).filter(i => i >= 0);
    expect(emptyIdxs).toHaveLength(1);
    expect(emptyIdxs[0]).toBe(AUTH_ERROR_MAP.length - 1);
  });

  it('orders specific rate-limit matches before the generic one', () => {
    const idx = (m: string) => AUTH_ERROR_MAP.findIndex(e => e.match === m);
    expect(idx('for security purposes')).toBeLessThan(idx('rate limit'));
    expect(idx('email rate limit exceeded')).toBeLessThan(idx('rate limit'));
  });
});
