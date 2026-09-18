import { describe, expect, it } from 'vitest';
import {
  CLAY_DEFAULT_TONE,
  CLAY_TO_GLYPH,
  DOMAIN_TONE,
  GLYPHS,
  GLYPH_TONE_CLASS,
  TINT_TO_TONE,
  glyphStrokeWidth,
  isGlyphName,
  resolveGlyph,
} from './glyphs';

// The 29 names the retired 3dicons set shipped (clayIcons.generated.ts, deleted
// with the migration) and the 7 clay tints — pinned here so the mapping can
// never silently drop one.
const RETIRED_CLAY_ICONS = [
  'alarm', 'bag', 'bell', 'calculator', 'calendar', 'card', 'chart', 'chat', 'coins', 'cup',
  'gift', 'handshake', 'key', 'link', 'lock', 'money', 'person', 'person2', 'phone',
  'piggybank', 'plus', 'pot', 'receipt', 'shield', 'sparkle', 'target', 'tick', 'trophy', 'wallet',
];
const CLAY_TINTS = ['gold', 'sky', 'blush', 'mint', 'coral', 'accent', 'neutral'];

describe('glyph data', () => {
  it('every glyph has at least one element and only stroke-safe tags', () => {
    for (const [name, els] of Object.entries(GLYPHS)) {
      expect(els.length, name).toBeGreaterThan(0);
      for (const [tag, attrs] of els) {
        expect(['path', 'circle', 'rect', 'ellipse'], `${name}:${tag}`).toContain(tag);
        // No fills or per-element colours: colour comes from the tone class.
        expect(attrs, name).not.toHaveProperty('fill');
        expect(attrs, name).not.toHaveProperty('stroke');
      }
    }
  });

  it('path data stays on the 24×24 grid', () => {
    for (const [name, els] of Object.entries(GLYPHS)) {
      for (const [, attrs] of els) {
        for (const n of Object.values(attrs).join(' ').match(/-?\d*\.?\d+/g) ?? []) {
          expect(Math.abs(Number(n)), `${name}: ${n}`).toBeLessThanOrEqual(24);
        }
      }
    }
  });
});

describe('clay → glyph migration', () => {
  it('maps EVERY retired 3dicons name, so no <Icon3D> call site goes blank', () => {
    for (const clay of RETIRED_CLAY_ICONS) {
      expect(CLAY_TO_GLYPH, clay).toHaveProperty(clay);
      expect(isGlyphName(CLAY_TO_GLYPH[clay as keyof typeof CLAY_TO_GLYPH]), clay).toBe(true);
      expect(CLAY_DEFAULT_TONE, clay).toHaveProperty(clay);
    }
  });

  it('maps every clay tint to a tone', () => {
    for (const tint of CLAY_TINTS) {
      expect(TINT_TO_TONE, tint).toHaveProperty(tint);
    }
  });

  it('resolves glyph names directly and clay names through the alias', () => {
    expect(resolveGlyph('bell')).toEqual({ glyph: 'bell', tone: 'current' });
    expect(resolveGlyph('piggybank')).toEqual({ glyph: 'savings', tone: 'green' });
    expect(resolveGlyph('tick')).toEqual({ glyph: 'check', tone: 'green' });
    expect(resolveGlyph('not-a-glyph')).toBeNull();
    expect(resolveGlyph(undefined)).toBeNull();
    expect(resolveGlyph('')).toBeNull();
  });
});

describe('tones', () => {
  it('every tone has a class, and every domain resolves to a known tone', () => {
    for (const tone of Object.values(DOMAIN_TONE)) {
      expect(GLYPH_TONE_CLASS, tone).toHaveProperty(tone);
    }
    expect(GLYPH_TONE_CLASS.current).toBe('');
  });
});

describe('glyphStrokeWidth', () => {
  it('follows the handoff: 3 on tiles, 2.6 inline, 2.4 small', () => {
    expect(glyphStrokeWidth(28)).toBe(3);
    expect(glyphStrokeWidth(24)).toBe(3);
    expect(glyphStrokeWidth(19)).toBe(2.6);
    expect(glyphStrokeWidth(17)).toBe(2.6);
    expect(glyphStrokeWidth(16)).toBe(2.4);
  });
});
