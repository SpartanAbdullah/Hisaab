// Password-recovery arrival detection (SDLC review 2026-10-06, P0 #3).
//
// `requestPasswordReset` sends the user a Supabase email whose link lands on
// `${VITE_PUBLIC_APP_URL}/?reset=1`. What that URL carries depends on how the
// auth client is configured and on whether the link is still valid:
//
//   implicit flow (Hisaab's default — no `flowType` is set on the client):
//     /?reset=1#access_token=…&refresh_token=…&type=recovery
//     → auth-js exchanges the hash for a session, blanks the hash, and emits
//       the PASSWORD_RECOVERY event on a setTimeout(0).
//   pkce flow (if the client were ever switched over):
//     /?reset=1&code=…
//     → auth-js exchanges the code, strips `code`, and emits plain SIGNED_IN —
//       PASSWORD_RECOVERY is NEVER raised on this path (redirectType is null).
//   expired / already-used link (either flow):
//     /?reset=1#error=access_denied&error_code=otp_expired&error_description=…
//     → auth-js throws inside _initialize, leaves the hash alone, no session.
//
// So the app needs TWO signals: the PASSWORD_RECOVERY event (handled in
// supabaseAuthStore) and the URL itself (this file). Only the `reset=1` query
// marker survives every variant — the hash is gone by the time React mounts —
// which is why this helper is run at module-evaluation time, before auth-js's
// network round-trip can finish.
//
// Pure: takes the raw `search` + `hash` strings so it is testable under Node.
// Mode-agnostic by construction (nothing here reads appModeStore); the reset
// flow is identical for full_tracker and splits_only.

export type RecoveryArrival =
  /** The user arrived from a valid reset link: show "set a new password". */
  | 'recovery'
  /** The user arrived from a reset link that no longer works: offer a new one. */
  | 'expired'
  /** An ordinary boot. */
  | 'none';

/** The query marker `requestPasswordReset` puts on the redirect URL. */
export const RESET_QUERY_KEY = 'reset';
export const RESET_QUERY_VALUE = '1';

/** Parse `?a=b` / `#a=b` into a flat map. Tolerates a leading `?`/`#`. */
function parseParams(raw: string): Record<string, string> {
  const trimmed = raw.replace(/^[?#]/, '');
  const out: Record<string, string> = {};
  if (!trimmed) return out;
  for (const [key, value] of new URLSearchParams(trimmed)) out[key] = value;
  return out;
}

export function detectRecoveryArrival(search: string, hash: string): RecoveryArrival {
  const query = parseParams(search);
  // auth-js reads auth parameters from BOTH the query and the hash; so do we,
  // so a provider that moves `type=recovery` into the query still works.
  const params = { ...parseParams(hash), ...query };
  const resetMarker = query[RESET_QUERY_KEY] === RESET_QUERY_VALUE;
  const authError = Boolean(params.error || params.error_code);

  if (resetMarker && authError) return 'expired';
  // A failed link with no reset marker is some other flow's problem
  // (signup confirmation, magic link) — leave existing behaviour untouched.
  if (authError) return 'none';
  if (resetMarker || params.type === 'recovery') return 'recovery';
  return 'none';
}

/**
 * The URL to leave behind once the arrival has been captured, so a reload
 * (or the browser's back-forward cache) does not re-trigger the screen after
 * the password was already set. Keeps every other query param and the hash:
 * auth-js still needs the hash to finish the token exchange, and strips it
 * itself afterwards. Returns null when nothing needs changing.
 */
export function stripResetMarker(href: string): string | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (!url.searchParams.has(RESET_QUERY_KEY)) return null;
  url.searchParams.delete(RESET_QUERY_KEY);
  return url.toString();
}
