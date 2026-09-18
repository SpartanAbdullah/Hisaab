import { describe, expect, it } from 'vitest';
import { contrastRatio, hexToRgb, meetsAA, relativeLuminance } from './contrast';

describe('hexToRgb', () => {
  it('parses 6-digit hex', () => {
    expect(hexToRgb('#0B0E2A')).toEqual([11, 14, 42]);
  });

  it('parses 3-digit shorthand hex', () => {
    expect(hexToRgb('#fff')).toEqual([255, 255, 255]);
  });

  it('throws on an invalid color', () => {
    expect(() => hexToRgb('not-a-color')).toThrow();
  });
});

describe('relativeLuminance', () => {
  it('is 0 for black and 1 for white', () => {
    expect(relativeLuminance('#000000')).toBeCloseTo(0, 5);
    expect(relativeLuminance('#FFFFFF')).toBeCloseTo(1, 5);
  });
});

describe('contrastRatio', () => {
  it('is 21:1 for black on white (WCAG reference value)', () => {
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 1);
  });

  it('is 1:1 for a color against itself', () => {
    expect(contrastRatio('#7E809A', '#7E809A')).toBeCloseTo(1, 5);
  });

  it('is order-independent', () => {
    expect(contrastRatio('#A8AABD', '#F4F2EC')).toBeCloseTo(
      contrastRatio('#F4F2EC', '#A8AABD'),
      10,
    );
  });
});

describe('meetsAA', () => {
  it('requires 4.5:1 for normal-size text', () => {
    expect(meetsAA(4.49)).toBe(false);
    expect(meetsAA(4.5)).toBe(true);
  });

  it('drops to 3:1 for large/bold text', () => {
    expect(meetsAA(2.99, true)).toBe(false);
    expect(meetsAA(3, true)).toBe(true);
  });
});

// Token-pair contrast lives in designTokens.test.ts since the 1d redesign
// (2026-09-18): it reads the palette from src/lib/designTokens.ts — which is
// itself checked against src/index.css — and proves every text/surface, chip,
// fill, icon and control pairing in BOTH themes. The hand-copied hex pairs
// that used to sit here could drift from the stylesheet; those cannot.
