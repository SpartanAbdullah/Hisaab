// The user's private forwarding address. Pure; tested.
// Mirrors the server side: capture_addresses.token (12 hex chars) and the
// `hisaab-<token>@` local part the inbound-email function recognises
// (supabase/functions/_shared/inboundEmail.ts).

export const CAPTURE_TOKEN_RE = /^[a-f0-9]{12}$/;
export const CAPTURE_ADDRESS_LOCAL_PREFIX = 'hisaab-';

export function isCaptureToken(token: unknown): token is string {
  return typeof token === 'string' && CAPTURE_TOKEN_RE.test(token);
}

/** `hisaab-<token>@<domain>`, or null when either half is unusable. */
export function composeCaptureAddress(token: string | null | undefined, domain: string | null | undefined): string | null {
  if (!isCaptureToken(token)) return null;
  const d = (domain ?? '').trim().toLowerCase();
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(d)) return null;
  return `${CAPTURE_ADDRESS_LOCAL_PREFIX}${token}@${d}`;
}
