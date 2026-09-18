// 1d material — the small amount of logic behind the CSS in index.css's
// "1D MATERIAL" block. Pure (no DOM), tested in material.test.ts.
//
// Tints keep the names the clay system used (so `tint="mint"` call sites keep
// working) but map onto the 1d tint scopes and glyph tones.

import { TINT_TO_TONE, type GlyphTone } from './glyphs';

export const TINTS = ['gold', 'sky', 'blush', 'mint', 'coral', 'accent', 'neutral'] as const;
export type Tint = (typeof TINTS)[number];

/** Tint → the CSS scope class that sets the face, walls and strong colour. */
const TINT_CLASS: Record<Tint, string> = {
  gold: 'm-gold',
  sky: 'm-blue',
  blush: 'm-pink',
  mint: 'm-mint',
  coral: 'm-coral',
  accent: 'm-violet',
  neutral: 'm-neutral',
};

export function tintClass(tint: Tint): string {
  return TINT_CLASS[tint];
}

export function tintTone(tint: Tint): GlyphTone {
  return TINT_TO_TONE[tint];
}

/** Hero accent per section (the radial glow in the hero band). */
export type HeroAccent = 'gold' | 'violet' | 'blue' | 'pink' | 'green' | 'ai';

export function heroClass(accent: HeroAccent): string {
  return accent === 'ai' ? 'm-hero m-hero-ai' : `m-hero m-hero-${accent}`;
}

/** Glyph px for the three tile icon sizes (tiles render 28 at `lg`). */
export const TILE_GLYPH_PX = { sm: 22, md: 26, lg: 28 } as const;
export type TileGlyphSize = keyof typeof TILE_GLYPH_PX;

/** Count badges cap at 9+ — a bigger number is noise at 16px. */
export function badgeCount(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '';
  return n > 9 ? '9+' : String(Math.floor(n));
}

/** Stagger for skeleton rows: 0.15s per row, capped so a long list doesn't
 *  crawl (the handoff's pulse delays run 0 → .45s). */
export function skeletonDelay(index: number): string {
  return `${Number((Math.min(Math.max(index, 0), 3) * 0.15).toFixed(2))}s`;
}
