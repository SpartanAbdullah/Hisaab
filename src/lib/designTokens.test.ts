import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { contrastRatio } from './contrast';
import {
  BELL_BADGE,
  DARK,
  FIXED,
  PRIMARY_BUTTON,
  HERO,
  LIGHT,
  SURFACES,
  TILE_BADGE,
  WHATSAPP_BUTTON,
  type ColorToken,
  type ThemeName,
} from './designTokens';

// ── 1. The stylesheet and this data never disagree ─────────────────────────
// Reads the real index.css (Vitest runs in Node) and pulls the token blocks
// out of it: `@theme { … }` holds the LIGHT values + the FIXED material
// colours, `html.dark { … }` the DARK overrides.

const css = readFileSync(resolve(__dirname, '../index.css'), 'utf8');

function block(startMarker: string): string {
  const at = css.indexOf(startMarker);
  if (at < 0) throw new Error(`index.css: marker not found: ${startMarker}`);
  const open = css.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === '{') depth += 1;
    else if (css[i] === '}') {
      depth -= 1;
      if (depth === 0) return css.slice(open + 1, i);
    }
  }
  throw new Error(`index.css: unbalanced block after ${startMarker}`);
}

function declarations(body: string): Map<string, string> {
  const out = new Map<string, string>();
  const noComments = body.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const m of noComments.matchAll(/--color-([a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    out.set(m[1], m[2].trim().toUpperCase());
  }
  return out;
}

const themeBlock = declarations(block('@theme {'));
const darkBlock = declarations(block('/* 1D-DARK-TOKENS'));
// The auth / onboarding / PIN / update screens re-declare part of the dark
// set under .auth-ink-dark, AFTER .bg-navy-bloom — so a stale copy there wins
// on those screens (it kept the retired gold accent once).
const authInkBlock = declarations(block('.auth-ink-dark {'));

describe('index.css ↔ designTokens.ts', () => {
  it.each(Object.entries(LIGHT))('light %s', (name, hex) => {
    expect(themeBlock.get(name), `--color-${name} in @theme`).toBe(hex.toUpperCase());
  });
  it.each(Object.entries(FIXED))('fixed %s', (name, hex) => {
    expect(themeBlock.get(name), `--color-${name} in @theme`).toBe(hex.toUpperCase());
  });
  it.each(Object.entries(DARK))('dark %s', (name, hex) => {
    expect(darkBlock.get(name), `--color-${name} in html.dark`).toBe(hex.toUpperCase());
  });
  it.each([...authInkBlock.entries()])('.auth-ink-dark %s mirrors the dark block', (name, hex) => {
    expect(hex, `--color-${name} in .auth-ink-dark`).toBe(darkBlock.get(name));
  });

  // The fixed-material faces are written as literal gradients in index.css;
  // the contrast checks below only mean something if they read the same stops.
  const face = (rule: RegExp): { stops: string[]; ink: string | undefined } => {
    const body = css.match(rule)?.[1];
    if (!body) throw new Error(`index.css: rule not found: ${rule}`);
    const gradient = body.match(/background-image:\s*linear-gradient\(([^;]*)\);/)?.[1] ?? '';
    return {
      stops: [...gradient.matchAll(/#[0-9a-fA-F]{6}/g)].map((m) => m[0].toUpperCase()),
      ink: body.match(/(?:^|[\s;])color:\s*(#[0-9a-fA-F]{6})/)?.[1].toUpperCase(),
    };
  };
  it.each([
    ['primary button', /\.m-btn-primary,\s*\.m-btn-violet,\s*\.btn-gradient,\s*\.cta-primary\s*\{([^}]*)\}/, PRIMARY_BUTTON],
    ['bell badge', /\.m-badge-coral\s*\{([^}]*)\}/, BELL_BADGE],
    ['tile badge', /\.m-badge-brand\s*\{([^}]*)\}/, TILE_BADGE],
    ['WhatsApp button', /\.m-btn-whatsapp\s*\{([^}]*)\}/, WHATSAPP_BUTTON],
  ] as const)('%s face matches index.css', (_name, rule, tokens) => {
    const expected = 'mid' in tokens ? [tokens.top, tokens.mid, tokens.bottom] : [tokens.top, tokens.bottom];
    expect(face(rule)).toEqual({ stops: expected, ink: tokens.ink });
  });
});

// ── 2. Contrast, both themes ────────────────────────────────────────────────
// Body text needs 4.5:1; icons, control edges and focus rings need 3:1
// (WCAG 1.4.11). Each pair below is a real pairing in the app — the comment
// says where.

const mix = (a: string, b: string): string => {
  const pa = [1, 3, 5].map((i) => parseInt(a.slice(i, i + 2), 16));
  const pb = [1, 3, 5].map((i) => parseInt(b.slice(i, i + 2), 16));
  return `#${pa.map((v, i) => Math.round((v + pb[i]) / 2).toString(16).padStart(2, '0')).join('')}`;
};

const THEMES: Array<[ThemeName, Record<ColorToken, string>]> = [
  ['light', LIGHT],
  ['dark', DARK],
];

describe.each(THEMES)('%s theme — text on surfaces (4.5:1)', (theme, T) => {
  const S = SURFACES[theme];
  const TEXT: ColorToken[] = [
    'ink-900', 'ink-800', 'ink-700', 'ink-600', 'ink-500', 'ink-400',
    'accent-text', 'iris-text', 'cobalt-text', 'blush-text',
    'receive-text', 'pay-text',
  ];
  const ON = ['sheet', 'card', 'card-face-bottom', 'control'];
  for (const token of TEXT) {
    for (const surface of ON) {
      it(`${token} on ${surface}`, () => {
        expect(contrastRatio(T[token], S[surface])).toBeGreaterThanOrEqual(4.5);
      });
    }
  }
  // Keypad digits and inset-field values sit on the key / inset faces.
  it.each(['ink-900', 'ink-600'] as ColorToken[])('%s on key face', (token) => {
    expect(contrastRatio(T[token], S.key)).toBeGreaterThanOrEqual(4.5);
  });
  it.each(['ink-900', 'ink-400'] as ColorToken[])('%s (value / placeholder) on inset field', (token) => {
    expect(contrastRatio(T[token], S.inset)).toBeGreaterThanOrEqual(4.5);
  });
});

describe.each(THEMES)('%s theme — chips and tinted fills (4.5:1)', (_theme, T) => {
  // text-X-text on bg-X-50 / bg-X-100 — every status chip in the app.
  const PAIRS: Array<[ColorToken, ColorToken]> = [
    ['accent-text', 'accent-50'], ['accent-text', 'accent-100'],
    ['iris-text', 'iris-50'], ['iris-text', 'iris-100'],
    ['cobalt-text', 'cobalt-50'], ['cobalt-text', 'cobalt-100'],
    ['blush-text', 'blush-50'], ['blush-text', 'blush-100'],
    ['receive-text', 'receive-50'], ['receive-text', 'receive-100'],
    ['pay-text', 'pay-50'], ['pay-text', 'pay-100'],
    ['pay-700', 'pay-50'],
    ['warn-700', 'warn-50'], ['warn-600', 'warn-50'],
    ['info-600', 'info-50'],
  ];
  it.each(PAIRS)('%s on %s', (fg, bg) => {
    expect(contrastRatio(T[fg], T[bg])).toBeGreaterThanOrEqual(4.5);
  });
});

describe.each(THEMES)('%s theme — solid fills with their label (4.5:1)', (theme, T) => {
  // The brand violet fills (accent-600, iris-600) carry white in both themes;
  // dark accent-500 is light enough that index.css flips its label dark.
  // Light accent-500 is not a label fill at all — see the guard below.
  const labelOn = (fill: ColorToken): string => {
    if (fill === 'accent-600' || fill === 'iris-600') return '#FFFFFF';
    return theme === 'dark' ? T['cream-bg'] : '#FFFFFF';
  };
  const FILLS: ColorToken[] = theme === 'light'
    ? ['accent-600', 'iris-600', 'receive-600', 'pay-700', 'info-600', 'whatsapp']
    : ['accent-600', 'accent-500', 'iris-600', 'receive-600', 'pay-600', 'warn-600', 'whatsapp'];
  it.each(FILLS)('label on %s', (fill) => {
    const fg = fill === 'whatsapp' ? '#FFFFFF' : labelOn(fill);
    expect(contrastRatio(fg, T[fill])).toBeGreaterThanOrEqual(4.5);
  });
});

describe('light theme — the bright brand violet never carries a label', () => {
  // White on light accent-500 (#7C5CFF, the brand's bright violet) is 4.35:1
  // and a dark label does worse (~4:1): no small-text label passes AA on it.
  // It stays for dots, progress bars, rings and focus edges (3:1 non-text,
  // checked below); a violet fill that carries text uses accent-600
  // (#5B47E8, 6.0:1 with white), or the .m-btn-primary face.
  it('no page or component pairs a solid bg-accent-500 with text-white', () => {
    const offenders: string[] = [];
    for (const dir of ['pages', 'components']) {
      const root = resolve(__dirname, '..', dir);
      for (const rel of readdirSync(root, { recursive: true }) as string[]) {
        if (!rel.endsWith('.tsx')) continue;
        const text = readFileSync(resolve(root, rel), 'utf8');
        // bg-accent-500/10 etc. are translucent tints, not the solid fill.
        for (const m of text.matchAll(/bg-accent-500(?![\w/-])/g)) {
          // The class string around the match: out to the nearest quote,
          // backtick or brace, so a ternary's other branch doesn't count.
          const stop = /["'`{}]/;
          let a = m.index;
          while (a > 0 && !stop.test(text[a - 1])) a -= 1;
          let b = m.index;
          while (b < text.length && !stop.test(text[b])) b += 1;
          if (/(^|\s)text-white(?![\w-])/.test(text.slice(a, b))) offenders.push(`${dir}/${rel}`);
        }
      }
    }
    expect(offenders, 'use bg-accent-600 for a violet fill that carries text').toEqual([]);
  });
});

describe.each(THEMES)('%s theme — icons, edges, focus (3:1, WCAG 1.4.11)', (theme, T) => {
  const S = SURFACES[theme];
  const GLYPHS: ColorToken[] = [
    'glyph-gold', 'glyph-green', 'glyph-coral', 'glyph-violet', 'glyph-blue', 'glyph-pink', 'glyph-neutral',
  ];
  for (const g of GLYPHS) {
    for (const surface of ['sheet', 'card', 'control']) {
      it(`${g} on ${surface}`, () => {
        expect(contrastRatio(T[g], S[surface])).toBeGreaterThanOrEqual(3);
      });
    }
  }
  it.each(['sheet', 'card', 'inset'])('field-border edge vs %s', (surface) => {
    expect(contrastRatio(T['field-border'], S[surface])).toBeGreaterThanOrEqual(3);
  });
  it.each(['sheet', 'card'])('accent-500 focus ring / selected edge vs %s', (surface) => {
    expect(contrastRatio(T['accent-500'], S[surface])).toBeGreaterThanOrEqual(3);
  });
  it('switch knob on the ON track', () => {
    expect(contrastRatio('#FFFFFF', T['control-on'])).toBeGreaterThanOrEqual(3);
  });
});

describe.each(THEMES)('%s theme — the verified seal (3:1, WCAG 1.4.11)', (theme, T) => {
  // <VerifiedBadge>: a solid rosette in --color-verified with a white check.
  // It sits beside names on list cards (contacts, groups), in the contact
  // sheet, and on raised tiles (group cards, the merge picker) — so it must
  // stand out as a graphic on each of those faces, and its check on it.
  const S = SURFACES[theme];
  it.each(['sheet', 'card', 'card-face-bottom', 'control', 'key'])('seal vs %s', (surface) => {
    expect(contrastRatio(T.verified, S[surface])).toBeGreaterThanOrEqual(3);
  });
  it('white check on the seal', () => {
    expect(contrastRatio('#FFFFFF', T.verified)).toBeGreaterThanOrEqual(3);
  });
});

describe('fixed material — labels on buttons, badges and the hero', () => {
  it('white on the brand primary button (middle + bottom of the face)', () => {
    expect(contrastRatio(PRIMARY_BUTTON.ink, PRIMARY_BUTTON.mid)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(PRIMARY_BUTTON.ink, PRIMARY_BUTTON.bottom)).toBeGreaterThanOrEqual(4.5);
  });
  it('white on the WhatsApp button (middle + bottom of the face)', () => {
    expect(contrastRatio(WHATSAPP_BUTTON.ink, WHATSAPP_BUTTON.mid)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(WHATSAPP_BUTTON.ink, WHATSAPP_BUTTON.bottom)).toBeGreaterThanOrEqual(4.5);
  });
  it('bell badge numeral at the pill midpoint', () => {
    expect(contrastRatio(BELL_BADGE.ink, mix(BELL_BADGE.top, BELL_BADGE.bottom))).toBeGreaterThanOrEqual(4.5);
  });
  it('tile count badge numeral at the pill midpoint', () => {
    expect(contrastRatio(TILE_BADGE.ink, mix(TILE_BADGE.top, TILE_BADGE.bottom))).toBeGreaterThanOrEqual(4.5);
  });
  it('hero secondary copy on the hero, both stops', () => {
    expect(contrastRatio(HERO.secondaryInk, HERO.top)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(HERO.secondaryInk, HERO.bottom)).toBeGreaterThanOrEqual(4.5);
  });
  it('dark-theme accents stay readable inside the hero in the LIGHT theme too', () => {
    // .m-hero re-scopes receive/pay/accent/iris text to their dark values, so
    // hero content reads the same in both themes.
    for (const t of ['receive-text', 'pay-text', 'accent-text', 'iris-text'] as ColorToken[]) {
      expect(contrastRatio(DARK[t], HERO.top)).toBeGreaterThanOrEqual(4.5);
    }
  });
});
