// WhatsApp deep links for payment reminders.
//
// The whole point of this helper is that the recipient does NOT need to be a
// Hisaab user. Most real-world IOUs are with people who will never install the
// app — the shopkeeper, a cousin, a flatmate. WhatsApp is the region's dominant
// channel, so a one-tap "remind on WhatsApp" with a pre-filled message closes
// the biggest gap our competitive benchmark surfaced (every khata app wins on
// free reminders to non-app contacts; we previously only reminded linked users).
//
// Two link shapes:
//   - Known number   -> https://wa.me/<intl-number>?text=...  (opens that chat)
//   - Unknown number  -> https://wa.me/?text=...              (WhatsApp contact picker)
//
// wa.me only dials INTERNATIONAL digits. A number saved the way people write
// it at home ("0300 1234567", "050 123 4567") is not one: wa.me/03001234567
// opens WhatsApp on an "invalid number" error, which reads as "Remind doesn't
// work". So a national-format number is resolved with the same UAE/Pakistan
// rules phone discovery uses (src/lib/phoneIdentity.ts) — and only when
// exactly one country fits. We never GUESS a country: a trunk-prefixed number
// we can't place, or one that fits two countries, is treated as "unknown" so
// the user lands on the picker instead of a broken or wrong chat.

import { toE164Candidates } from './phoneIdentity';

// Strip a stored phone down to the bare international digits wa.me expects:
// no '+', spaces, dashes or parentheses. Returns null when there's nothing
// usable so callers fall back to the contact picker.
export function normalizeWhatsAppPhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const digits = phone.replace(/[^\d]/g, '');
  // Shorter than 7 digits can't be a real international number, and E.164
  // stops at 15 — don't risk a dead link; let the caller fall through to the
  // picker.
  if (digits.length < 7 || digits.length > 15) return null;

  // "+…" and "00…" are explicit; "03…"/"05…" and bare PK/UAE mobiles resolve
  // to exactly one country. Several candidates = ambiguous = never guess.
  const candidates = toE164Candidates(phone);
  if (candidates.length === 1) return candidates[0].slice(1);
  if (candidates.length > 1) return null;

  // A leading 0 is a national trunk prefix wa.me cannot dial, and it isn't a
  // PK/UAE mobile we could place — no chat link rather than a dead one.
  if (digits.startsWith('0')) return null;
  // Digits with no '+' and no trunk 0: they already carry a country code
  // (people paste "447911123456"). Trusted as-is, as before.
  return digits;
}

export function hasWhatsAppNumber(phone: string | null | undefined): boolean {
  return normalizeWhatsAppPhone(phone) !== null;
}

// Build the wa.me URL. `text` is the human-readable reminder body; it is URL
// encoded here so callers pass plain multi-line text.
export function buildWhatsAppUrl(phone: string | null | undefined, text: string): string {
  const number = normalizeWhatsAppPhone(phone);
  const encoded = encodeURIComponent(text);
  return number ? `https://wa.me/${number}?text=${encoded}` : `https://wa.me/?text=${encoded}`;
}
