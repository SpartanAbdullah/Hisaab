import type { I18nKey } from './i18n';

// "A good error is a detour sign, not a dead end." Every raw Supabase auth
// message is rewritten into warm, bilingual copy that carries an inline
// recovery action, so the user is re-routed instead of stuck.
//
// The store still sets its `.error` to the raw Supabase message; the UI must
// route EVERY error string (store error and local call results alike) through
// mapAuthError so a raw string never reaches the screen. Keep the
// enumeration-safe password-reset "If an account exists…" copy OUT of this map
// — it must not reveal whether an email exists.

export type DetourAction =
  | 'reset'        // switch to password-reset mode, keep the typed email
  | 'login'        // switch to login, focus the password field
  | 'resend'       // resend the signup confirmation email
  | 'fixPassword'  // focus the password field (live checklist guides the fix)
  | 'editEmail'    // focus + select the email field
  | 'retry'        // re-run the same submit (network blips)
  | 'newAccount'   // start a fresh signup (deleted account)
  | 'dismiss';     // acknowledge only (throttles/rate limits)

export interface Detour {
  msgKey: I18nKey;
  actionKey: I18nKey;
  action: DetourAction;
  field?: 'email' | 'password';
}

// Matched by lowercased substring, IN ORDER. Ordering is load-bearing:
//   • 'for security purposes' and 'email rate limit exceeded' are more specific
//     than the generic 'rate limit' and MUST be checked first.
//   • both phrasings Supabase uses for a duplicate signup are covered.
//   • the empty-substring catch-all is LAST so it always matches and no raw
//     Supabase string can ever leak to the UI.
export const AUTH_ERROR_MAP: ({ match: string } & Detour)[] = [
  { match: 'invalid login credentials', msgKey: 'err_invalid_credentials', actionKey: 'err_invalid_credentials_action', action: 'reset' },
  { match: 'user already registered', msgKey: 'err_already_registered', actionKey: 'err_already_registered_action', action: 'login' },
  { match: 'already been registered', msgKey: 'err_already_registered', actionKey: 'err_already_registered_action', action: 'login' },
  { match: 'email not confirmed', msgKey: 'err_email_not_confirmed', actionKey: 'err_email_not_confirmed_action', action: 'resend' },
  { match: 'password should be at least', msgKey: 'err_password_short', actionKey: 'err_password_action', action: 'fixPassword', field: 'password' },
  { match: 'weak password', msgKey: 'err_password_weak', actionKey: 'err_password_action', action: 'fixPassword', field: 'password' },
  // updateUser({ password }) on the set-new-password screen: same as before.
  { match: 'different from the old password', msgKey: 'err_password_same', actionKey: 'err_password_action', action: 'fixPassword', field: 'password' },
  // The recovery session expired (tab left open) before the password was set.
  { match: 'auth session missing', msgKey: 'err_recovery_session_missing', actionKey: 'err_recovery_session_action', action: 'reset' },
  { match: 'for security purposes', msgKey: 'err_security_throttle', actionKey: 'err_action_try_again', action: 'dismiss' },
  { match: 'email rate limit exceeded', msgKey: 'err_email_rate_limit', actionKey: 'err_email_rate_limit_action', action: 'dismiss' },
  { match: 'rate limit', msgKey: 'err_rate_limit', actionKey: 'err_action_dismiss', action: 'dismiss' },
  { match: 'unable to validate email address', msgKey: 'err_bad_email', actionKey: 'err_bad_email_action', action: 'editEmail', field: 'email' },
  { match: 'invalid email', msgKey: 'err_bad_email', actionKey: 'err_bad_email_action', action: 'editEmail', field: 'email' },
  { match: 'failed to fetch', msgKey: 'err_network', actionKey: 'err_action_try_again', action: 'retry' },
  { match: 'network', msgKey: 'err_network', actionKey: 'err_action_try_again', action: 'retry' },
  { match: 'has been deleted', msgKey: 'err_deleted_account', actionKey: 'err_deleted_account_action', action: 'newAccount' },
  // Catch-all — empty substring always matches; MUST stay last.
  { match: '', msgKey: 'err_generic', actionKey: 'err_action_try_again', action: 'retry' },
];

export function mapAuthError(raw: string): Detour {
  const lower = (raw || '').toLowerCase();
  const hit = AUTH_ERROR_MAP.find(e => e.match === '' || lower.includes(e.match))!;
  return { msgKey: hit.msgKey, actionKey: hit.actionKey, action: hit.action, field: hit.field };
}
