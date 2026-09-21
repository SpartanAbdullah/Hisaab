// The account's own phone number — ONE number, ONE place to edit it.
//
// Founder, 2026-09-19: "why we have two place to put my number?" Settings
// used to carry two unrelated fields:
//   • My Account → "Mobile Number": a pre-Supabase stub that only ever wrote
//     `localStorage.hisaab_mobile` on this device. Nothing read it, it never
//     reached the server, and it was swept on sign-out (audit UX-29, founder
//     round F2).
//   • "My phone number" (PhoneDiscoverySection): the real one —
//     `profiles.phone_e164`, matched by phone discovery.
// They could disagree freely. Now `profiles.phone_e164` is the only store: My
// Account edits it, and the discovery card only flips `phone_discoverable`
// for that same number.
//
// These rules are pure so both surfaces agree on them and the consent
// default below is pinned by a test.

/** The legacy device-local key the old My Account field wrote. Read once as
 *  a draft for "Add" (see legacyPhoneDraft), then removed. */
export const LEGACY_MOBILE_KEY = 'hisaab_mobile';

export interface MyPhone {
  /** The saved number in E.164 (+923001234567), or null when none is on file. */
  e164: string | null;
  /** Whether people who already have this number saved can find the account. */
  discoverable: boolean;
}

/**
 * The phone columns off a `profiles` row. Null when there is no row or the
 * columns aren't there (the discovery migration isn't applied) — callers hide
 * the phone UI rather than show a control that silently fails.
 */
export function readMyPhone(profile: Record<string, unknown> | null | undefined): MyPhone | null {
  if (!profile || !('phone_e164' in profile)) return null;
  const raw = profile.phone_e164;
  const e164 = typeof raw === 'string' && raw ? raw : null;
  // Findable needs a number: the lookup RPCs require both, so a stray flag on
  // a row with no number must never read as "people can find you".
  return { e164, discoverable: e164 !== null && profile.phone_discoverable === true };
}

/**
 * What `phone_discoverable` to store with a number being saved. Unchanged
 * from PhoneDiscoverySection's original rule (and founder round F6: "turned
 * on by default as soon as number is entered"):
 *   • the FIRST number on file switches discovery on — the editor says so
 *     right under the input before Save (settings `setph_add_note`), and the
 *     switch is one tap away to turn it back off;
 *   • replacing an existing number keeps whatever the user already chose.
 */
export function discoverableForSave(current: MyPhone): boolean {
  return current.e164 ? current.discoverable : true;
}

/**
 * The draft "Add" starts from. The old device-local field is only ever a
 * starting point for typing — never saved on its own, never made findable —
 * and only when the server holds no number: when it does, the server value
 * (the one discovery actually uses) wins and the local leftover is dropped.
 */
export function legacyPhoneDraft(legacy: string | null | undefined, current: MyPhone | null): string {
  if (!current || current.e164) return '';
  return (legacy ?? '').trim();
}
