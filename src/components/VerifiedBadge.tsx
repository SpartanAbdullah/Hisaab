// Verified-style seal: a blue rosette with a white check — the universally
// understood "confirmed / settled / linked" mark. Deliberately NOT a pixel
// copy of Meta's verified badge (that exact scalloped asset is their brand
// property); this uses the generic seal-check geometry from our icon set,
// filled in the app's cobalt, which reads identically at a glance.
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
import { BadgeCheck } from 'lucide-react';
import { useT } from '../lib/i18n';

interface Props {
  size?: number;
  className?: string;
  /** Accessible label; defaults to "Verified". */
  title?: string;
}

// 1d: the fill is the cobalt token (the semantic blue), not a brand hex, so it
// follows the theme — cobalt-600 carries a white check at ≥3:1 in both themes.
export function VerifiedBadge({ size = 14, className = '', title }: Props) {
  const t = useT();
  return (
    <span
      className={`inline-flex items-center shrink-0 ${className}`}
      title={title}
      aria-label={title ?? t('a11y_verified')}
    >
      <BadgeCheck
        size={size}
        className="fill-cobalt-600 stroke-white"
        strokeWidth={2.2}
        aria-hidden
      />
    </span>
  );
}
