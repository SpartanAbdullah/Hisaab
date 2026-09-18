import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { TINTS, badgeCount, heroClass, skeletonDelay, tintClass, tintTone } from './material';

const css = readFileSync(resolve(__dirname, '../index.css'), 'utf8');

describe('tints', () => {
  it('every tint maps to a scope class that index.css actually defines', () => {
    for (const tint of TINTS) {
      const cls = tintClass(tint);
      expect(css, `.${cls} missing from index.css`).toContain(`.${cls}`);
    }
  });

  it('every tint has a glyph tone', () => {
    expect(tintTone('mint')).toBe('green');
    expect(tintTone('coral')).toBe('coral');
    expect(tintTone('accent')).toBe('violet');
    expect(tintTone('sky')).toBe('blue');
    expect(tintTone('blush')).toBe('pink');
    expect(tintTone('gold')).toBe('gold');
    expect(tintTone('neutral')).toBe('neutral');
  });
});

describe('heroClass', () => {
  it('composes the base hero with its accent', () => {
    expect(heroClass('gold')).toBe('m-hero m-hero-gold');
    expect(heroClass('violet')).toBe('m-hero m-hero-violet');
    expect(heroClass('ai')).toBe('m-hero m-hero-ai');
  });
  it('every accent class exists in index.css', () => {
    for (const a of ['gold', 'violet', 'blue', 'pink', 'green', 'ai'] as const) {
      for (const cls of heroClass(a).split(' ')) expect(css).toContain(`.${cls}`);
    }
  });
});

describe('badgeCount', () => {
  it('caps at 9+ and hides zero / junk', () => {
    expect(badgeCount(0)).toBe('');
    expect(badgeCount(-2)).toBe('');
    expect(badgeCount(Number.NaN)).toBe('');
    expect(badgeCount(1)).toBe('1');
    expect(badgeCount(9)).toBe('9');
    expect(badgeCount(10)).toBe('9+');
    expect(badgeCount(73)).toBe('9+');
  });
});

describe('skeletonDelay', () => {
  it('staggers 0.15s per row and caps', () => {
    expect(skeletonDelay(0)).toBe('0s');
    expect(skeletonDelay(1)).toBe('0.15s');
    expect(skeletonDelay(3)).toBe('0.45s');
    expect(skeletonDelay(10)).toBe('0.45s');
  });
});
