// Per-market colour identity, on the 1d token layer (redesign 2026-09-18).
//
// A market is keyed by ONE hue, drawn from the semantic token families — never
// the Tailwind default palette — so every pairing is already AA-verified in
// both themes (designTokens.test.ts):
//   iris (violet) · cobalt (blue) · blush (pink) · receive (green) ·
//   pay (coral) · warn (gold)
// Six distinct hues. The gold slot uses `warn` (amber text / tint, #E8C063 in
// dark): `accent` is the brand violet since 2026-09-19 and would repeat iris.
//
// Stable per market (hashed id). The slot order follows the retired palette's
// hues (teal→green, indigo→violet, amber→gold, rose→pink, blue→blue) so most
// markets keep their family; the last slot (was emerald, a second green) moves
// to coral so no two slots share a hue.
//
// The idle chip is the material pill everywhere now (.m-pill), so the colour
// mostly travels as the small `dot`; `tint` + `text` are the m-chip pairing
// for a coloured market tag, `scope` tints a material plate (.m-card etc.).

export interface MarketColor {
  /** Soft tinted surface for a market tag — pair with `text` (m-chip). */
  tint: string;
  /** Readable hue text on the sheet, a card, or the `tint` surface. */
  text: string;
  /** Whisper-strength border in the hue (decorative). */
  border: string;
  /** Solid fill WITH its own label colour — AA in both themes on the sheet
   *  and cards. Not for the hero: it is dark in both themes. */
  solid: string;
  /** Small identity dot. A glyph token (≥3:1 on sheet / card / control), and
   *  re-scoped by .m-hero — so the same dot also reads inside the hero. */
  dot: string;
  /** Material tint scope (`m-card ${scope}` → tinted face + walls; the
   *  `text` colour is that scope's strong label). */
  scope: string;
}

const PALETTE: readonly MarketColor[] = [
  { tint: 'bg-receive-100', text: 'text-receive-text', border: 'border-receive-text/25', solid: 'bg-receive-text text-cream-bg', dot: 'bg-glyph-green', scope: 'm-mint' },
  { tint: 'bg-iris-100', text: 'text-iris-text', border: 'border-iris-text/25', solid: 'bg-iris-text text-cream-bg', dot: 'bg-glyph-violet', scope: 'm-violet' },
  { tint: 'bg-warn-50', text: 'text-warn-700', border: 'border-warn-700/25', solid: 'bg-warn-700 text-cream-bg', dot: 'bg-glyph-gold', scope: 'm-gold' },
  { tint: 'bg-blush-100', text: 'text-blush-text', border: 'border-blush-text/25', solid: 'bg-blush-text text-cream-bg', dot: 'bg-glyph-pink', scope: 'm-pink' },
  { tint: 'bg-cobalt-100', text: 'text-cobalt-text', border: 'border-cobalt-text/25', solid: 'bg-cobalt-text text-cream-bg', dot: 'bg-glyph-blue', scope: 'm-blue' },
  { tint: 'bg-pay-100', text: 'text-pay-text', border: 'border-pay-text/25', solid: 'bg-pay-text text-cream-bg', dot: 'bg-glyph-coral', scope: 'm-coral' },
];

/** Deterministic, well-distributed hash of the market id. */
function hashCode(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

export function marketColorFor(marketId: string): MarketColor {
  return PALETTE[hashCode(marketId) % PALETTE.length];
}

/** Every palette slot — exported for the tests (token-only, distinct hues). */
export const MARKET_PALETTE = PALETTE;
