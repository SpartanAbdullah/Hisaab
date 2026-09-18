import { describe, expect, it } from 'vitest';
import { MARKET_PALETTE, marketColorFor } from './marketColors';

// The Tailwind default palette is banned in UI code (1d redesign) — every
// market colour must come from the token layer so both themes stay AA.
const DEFAULT_PALETTE =
  /\b(?:bg|text|border|ring|from|to|via|fill|stroke)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d/;

describe('marketColorFor', () => {
  it('is stable for a market id', () => {
    expect(marketColorFor('mkt-dfm')).toBe(marketColorFor('mkt-dfm'));
    expect(marketColorFor('')).toBe(marketColorFor(''));
  });

  it('always lands on a palette slot', () => {
    for (const id of ['a', 'b', 'DFM', 'PSX', '2f1c9e0a-uuid', 'x'.repeat(200)]) {
      expect(MARKET_PALETTE).toContain(marketColorFor(id));
    }
  });

  it('uses token classes only — never the Tailwind default palette', () => {
    for (const slot of MARKET_PALETTE) {
      for (const cls of Object.values(slot).join(' ').split(/\s+/)) {
        expect(cls).not.toMatch(DEFAULT_PALETTE);
        expect(cls).not.toMatch(/#[0-9a-f]{3,8}/i);
      }
    }
  });

  it('gives every slot its own hue', () => {
    expect(new Set(MARKET_PALETTE.map((s) => s.dot)).size).toBe(MARKET_PALETTE.length);
    expect(new Set(MARKET_PALETTE.map((s) => s.scope)).size).toBe(MARKET_PALETTE.length);
  });

  it('keeps each slot one hue — its tag colours match its dot', () => {
    // The gold slot once kept a gold dot but violet tags, when `accent` became
    // the brand violet — the unique-dot check above can't see that.
    const FAMILY_OF_DOT: Record<string, string> = {
      'bg-glyph-green': 'receive',
      'bg-glyph-violet': 'iris',
      'bg-glyph-gold': 'warn',
      'bg-glyph-pink': 'blush',
      'bg-glyph-blue': 'cobalt',
      'bg-glyph-coral': 'pay',
    };
    for (const slot of MARKET_PALETTE) {
      const family = FAMILY_OF_DOT[slot.dot];
      expect(family, `known dot ${slot.dot}`).toBeDefined();
      for (const cls of [slot.tint, slot.text, slot.border, slot.solid.split(' ')[0]]) {
        expect(cls, `${slot.dot} slot`).toContain(`-${family}-`);
      }
    }
  });

  it('keeps `dot` a background utility (HomePage paints it on a 2×2 span)', () => {
    for (const slot of MARKET_PALETTE) expect(slot.dot).toMatch(/^bg-/);
  });
});
