// Verified seal, Meta-style (founder 2026-09-19: "exactly look like meta's
// blue tick, that looks so sleek"): a blue scalloped rosette with a crisp
// white check.
//
// The outline is Hisaab's own geometry, not Meta's asset: twelve convex bump
// arcs (r 1.9) joined by twelve concave valley arcs (r ≈1.24), each joint
// tangent so the edge has no cusps, bumps on the cardinal points — tips at
// radius 11.5 and valleys at 9.95 on the 24-grid. Tuned for 14–18px: the
// scallops stay distinct on 2–3x phone screens and soften into a gently wavy
// circle at 1x, the way Meta's does. The check is a round-capped 2.4 stroke
// (≈1.7px at 17px), bold enough to stay crisp at the smallest call site.
//
// Colour is the `--color-verified` token (src/index.css, both themes; the seal
// on every surface and the white check on the seal are proven ≥3:1 in
// designTokens.test.ts) — never a hex here.
//
// Usage semantics across the app (keep these consistent):
//   - Contacts: the two accounts hold a CONSENT-VERIFIED link — an accepted
//     contact_link_request. Gate every contact-side render on
//     `isConsentVerifiedLink()` from src/lib/contactVerification.ts and NEVER
//     on `person.linkedProfileId` or a phone-discovery hit: both are claims
//     made by one side alone, and phone numbers carry no ownership check at
//     all, so the seal would vouch for an impersonator (audit 2026-09 SEC-09).
//   - Loans: the loan (or a person's whole ledger) is fully SETTLED
//   - Groups: on the group DETAIL page, every debt in the group is settled;
//     on the groups LIST card, the CURRENT USER is square (whole-group debt
//     data isn't loaded there — same scope as the card's "Settled" pill)
import { useT } from '../lib/i18n';

interface Props {
  /** The size (px) of the text the seal sits beside; the seal renders a
   *  touch larger (VISUAL_SCALE) so it keeps pace with that text. */
  size?: number;
  className?: string;
  /** Accessible label; defaults to "Verified". */
  title?: string;
}

// The rosette fills ~90% of its box where the old lucide seal showed ~77%
// (its white outline ate the rest), so growing the box 1.1× makes the visible
// seal ~1.25× bigger — "a little bigger" — while keeping Meta's seal-to-name
// proportion. One knob for the whole app; call sites keep their numbers
// (13 → 14px, 14 → 15px, 15 → 17px).
const VISUAL_SCALE = 1.1;

const ROSETTE =
  'M10.25 1.67A1.9 1.9 0 0 1 13.75 1.67A1.24 1.24 0 0 0 15.65 2.18A1.9 1.9 0 0 1 18.68 3.93' +
  'A1.24 1.24 0 0 0 20.07 5.32A1.9 1.9 0 0 1 21.82 8.35A1.24 1.24 0 0 0 22.33 10.25' +
  'A1.9 1.9 0 0 1 22.33 13.75A1.24 1.24 0 0 0 21.82 15.65A1.9 1.9 0 0 1 20.07 18.68' +
  'A1.24 1.24 0 0 0 18.68 20.07A1.9 1.9 0 0 1 15.65 21.82A1.24 1.24 0 0 0 13.75 22.33' +
  'A1.9 1.9 0 0 1 10.25 22.33A1.24 1.24 0 0 0 8.35 21.82A1.9 1.9 0 0 1 5.32 20.07' +
  'A1.24 1.24 0 0 0 3.93 18.68A1.9 1.9 0 0 1 2.18 15.65A1.24 1.24 0 0 0 1.67 13.75' +
  'A1.9 1.9 0 0 1 1.67 10.25A1.24 1.24 0 0 0 2.18 8.35A1.9 1.9 0 0 1 3.93 5.32' +
  'A1.24 1.24 0 0 0 5.32 3.93A1.9 1.9 0 0 1 8.35 2.18A1.24 1.24 0 0 0 10.25 1.67Z';

// Short arm : long arm ≈ 1 : 2, its bounding box centred on the seal.
const CHECK = 'M7.55 12.15 10.6 15.15 16.55 9.05';

export function VerifiedBadge({ size = 14, className = '', title }: Props) {
  const t = useT();
  const px = Math.round(size * VISUAL_SCALE);
  return (
    <span
      role="img"
      className={`inline-flex items-center shrink-0 ${className}`}
      title={title}
      aria-label={title ?? t('a11y_verified')}
    >
      <svg
        width={px}
        height={px}
        viewBox="0 0 24 24"
        aria-hidden="true"
        focusable="false"
        className="block"
      >
        <path d={ROSETTE} className="fill-verified" />
        <path
          d={CHECK}
          fill="none"
          className="stroke-white"
          strokeWidth={2.4}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  );
}
