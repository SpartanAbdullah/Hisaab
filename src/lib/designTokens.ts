// Hisaab "1d" design tokens — the palette as data.
//
// src/index.css is what the browser reads; this file is what the tests read.
// designTokens.test.ts parses index.css and fails if the two ever disagree, so
// a token nudged in CSS without updating this file (or the reverse) cannot
// ship. That closes the old drift gap where contrast.test.ts pinned hand-copied
// hex that nothing kept in sync with the stylesheet.
//
// Two themes. DARK is the design handoff's "1d" material verbatim (Claude
// Design, 2026-09-18). LIGHT is its ivory counterpart, designed to the same
// material rules: the same gold/green/coral/violet accents, darkened wherever
// they are used as text or as a control edge so every pair clears WCAG AA.
// Heroes stay dark navy in BOTH themes (the big white figures need a dark
// ground), so hero-only colours live in HERO, not in either theme.
//
// Token names are the app's existing Tailwind colour names (cream/ink/accent/
// receive/pay/warn/info/…), so ~4,200 existing utility call sites re-skin by
// value. `accent` is the brand VIOLET — the primary action (founder decision
// 2026-09-19: the handoff's gold primary was replaced by the brand colour).
// `iris` is the same violet family, kept as the section accent for AI,
// investments and linked chips; gold survives only as fixed material for
// kameti and warnings.

export type ThemeName = 'light' | 'dark';

export type ColorToken =
  | 'cream-bg' | 'cream-card' | 'cream-border' | 'cream-hairline' | 'cream-soft'
  | 'ink-200' | 'ink-300' | 'ink-400' | 'ink-500' | 'ink-600' | 'ink-700' | 'ink-800' | 'ink-900'
  | 'accent-50' | 'accent-100' | 'accent-500' | 'accent-600' | 'accent-text'
  | 'iris-50' | 'iris-100' | 'iris-500' | 'iris-600' | 'iris-text'
  | 'cobalt-50' | 'cobalt-100' | 'cobalt-500' | 'cobalt-600' | 'cobalt-text'
  | 'blush-50' | 'blush-100' | 'blush-500' | 'blush-600' | 'blush-text'
  | 'receive-50' | 'receive-100' | 'receive-600' | 'receive-700' | 'receive-text'
  | 'pay-50' | 'pay-100' | 'pay-600' | 'pay-700' | 'pay-text'
  | 'warn-50' | 'warn-600' | 'warn-700'
  | 'info-50' | 'info-600'
  | 'field-border' | 'control-off' | 'control-on' | 'whatsapp'
  | 'glyph-gold' | 'glyph-green' | 'glyph-coral' | 'glyph-violet' | 'glyph-blue' | 'glyph-pink' | 'glyph-neutral';

export const LIGHT: Record<ColorToken, string> = {
  'cream-bg': '#F4F1EA',
  'cream-card': '#FFFFFF',
  'cream-border': '#E6E0D3',
  'cream-hairline': '#EEE9DF',
  'cream-soft': '#F9F7F2',

  'ink-200': '#E6E6EF',
  'ink-300': '#C9CAD8',
  'ink-400': '#62657F',
  'ink-500': '#60627B',
  'ink-600': '#5A5C72',
  'ink-700': '#3F4156',
  'ink-800': '#23253F',
  'ink-900': '#0E102B',

  'accent-50': '#F3F0FF',
  'accent-100': '#EBE6FF',
  'accent-500': '#7C5CFF',
  'accent-600': '#5B47E8',
  'accent-text': '#5B47E8',

  'iris-50': '#F3F0FF',
  'iris-100': '#EBE6FF',
  'iris-500': '#7C5CFF',
  'iris-600': '#5B47E8',
  'iris-text': '#5B47E8',

  'cobalt-50': '#EAF0FD',
  'cobalt-100': '#DCE6FB',
  'cobalt-500': '#4A74E0',
  'cobalt-600': '#335FCB',
  'cobalt-text': '#2F58BF',

  'blush-50': '#FCEDF2',
  'blush-100': '#F7DDE6',
  'blush-500': '#D2527E',
  'blush-600': '#B83D68',
  'blush-text': '#A3305A',

  'receive-50': '#E6F4EE',
  'receive-100': '#DEF1E7',
  'receive-600': '#0B8466',
  'receive-700': '#076B53',
  'receive-text': '#0C7458',

  'pay-50': '#FBEDE7',
  'pay-100': '#F7DDD2',
  'pay-600': '#D9614A',
  'pay-700': '#B4452C',
  'pay-text': '#A6402A',

  'warn-50': '#FBF3DD',
  'warn-600': '#8D6813',
  'warn-700': '#8A6410',
  'info-50': '#E8EEFB',
  'info-600': '#335FCB',

  'field-border': '#857E6D',
  'control-off': '#857E6D',
  'control-on': '#0B8466',
  'whatsapp': '#15873F',

  'glyph-gold': '#A88418',
  'glyph-green': '#0C8F70',
  'glyph-coral': '#D9614A',
  'glyph-violet': '#7C5CFF',
  'glyph-blue': '#4A74E0',
  'glyph-pink': '#D2527E',
  'glyph-neutral': '#3F4156',
};

export const DARK: Record<ColorToken, string> = {
  'cream-bg': '#0B0C16',
  'cream-card': '#141628',
  'cream-border': '#262A40',
  'cream-hairline': '#1B1E30',
  'cream-soft': '#10121F',

  'ink-200': '#262940',
  'ink-300': '#3A3D55',
  'ink-400': '#8A8CA0',
  'ink-500': '#9C9EB2',
  'ink-600': '#B4B6C8',
  'ink-700': '#D2D3DF',
  'ink-800': '#E6E6EF',
  'ink-900': '#FFFFFF',

  'accent-50': '#1F1936',
  'accent-100': '#2A2342',
  'accent-500': '#8E72FF',
  'accent-600': '#7459F0',
  'accent-text': '#B7A4FF',

  'iris-50': '#1C1733',
  'iris-100': '#262045',
  'iris-500': '#8E72FF',
  'iris-600': '#6A55F0',
  'iris-text': '#B7A4FF',

  'cobalt-50': '#121A30',
  'cobalt-100': '#19243F',
  'cobalt-500': '#6B92F5',
  'cobalt-600': '#5A82EE',
  'cobalt-text': '#9BB6FA',

  'blush-50': '#24121B',
  'blush-100': '#321A26',
  'blush-500': '#E56C94',
  'blush-600': '#E0628C',
  'blush-text': '#F09AB6',

  'receive-50': '#10201A',
  'receive-100': '#163026',
  'receive-600': '#2BC99A',
  'receive-700': '#0E8E6E',
  'receive-text': '#3FD7A6',

  'pay-50': '#25140F',
  'pay-100': '#33201A',
  'pay-600': '#EE8468',
  'pay-700': '#D6735D',
  'pay-text': '#F2967C',

  'warn-50': '#2A2410',
  'warn-600': '#D9A52E',
  'warn-700': '#E8C063',
  'info-50': '#121A30',
  'info-600': '#6B92F5',

  'field-border': '#6B6D82',
  'control-off': '#6B6D82',
  'control-on': '#0E8E6E',
  'whatsapp': '#15873F',

  'glyph-gold': '#E8C063',
  'glyph-green': '#3FD7A6',
  'glyph-coral': '#F2967C',
  'glyph-violet': '#8E72FF',
  'glyph-blue': '#6B92F5',
  'glyph-pink': '#E56C94',
  'glyph-neutral': '#E6E6EF',
};

/** Fixed material colours — identical in both themes (a gold button is gold
 *  in the light theme too). Theme-independent, so they live in `@theme`. */
export const FIXED = {
  'navy-900': '#0A0A14',
  'navy-800': '#0F1020',
  'navy-700': '#171A2E',
  'navy-600': '#22264A',
  'gold-300': '#F5DA8F',
  'gold-500': '#E8C063',
  'gold-700': '#B8901F',
  'gold-900': '#7A5C12',
  'gold-ink': '#2A1F06',
} as const;

/** Surfaces text actually sits on, per theme — what the contrast suite checks
 *  every text token against. `card-face-bottom` / `key-face-top` are the
 *  darkest/lightest stops of the gradient faces, i.e. the binding stop. */
export const SURFACES: Record<ThemeName, Record<string, string>> = {
  light: {
    sheet: '#F4F1EA',
    card: '#FFFFFF',
    'card-face-bottom': '#FAF7F1',
    control: '#F2EDE3',
    key: '#F2EDE3',
    inset: '#ECE7DC',
  },
  dark: {
    sheet: '#0B0C16',
    card: '#141628',
    'card-face-bottom': '#0D0F1E',
    control: '#1B1E33',
    key: '#1D2036',
    inset: '#1D2036',
  },
};

/** The hero band — dark in both themes. Text on it is white / white-alpha. */
export const HERO = {
  top: '#0F1020',
  bottom: '#0A0A14',
  /** `text-white/60`-class secondary copy composited over the hero base. */
  secondaryInk: '#B4B6C8',
} as const;

/** Brand primary button (violet) face stops and its white label. One face
 *  for .m-btn-primary, .m-btn-violet, .btn-gradient and .cta-primary (they
 *  share a rule in index.css; designTokens.test.ts reads the stops from it). */
export const PRIMARY_BUTTON = {
  top: '#9A80FF',
  mid: '#6D57F0',
  bottom: '#4A36D6',
  ink: '#FFFFFF',
} as const;

/** WhatsApp button (.m-btn-whatsapp) face stops and its white label. The
 *  middle stop is the brand green (--color-whatsapp) at 45% of the height, so
 *  the label, centred at 50%, never sits on the lighter top. */
export const WHATSAPP_BUTTON = {
  top: '#22A755',
  mid: '#15873F',
  bottom: '#0E6B30',
  ink: '#FFFFFF',
} as const;

/** Bell badge — coral gradient pill, white numeral. The handoff's
 *  #F2967C→#B4452C put 8px white text at ~3:1 where the numeral sits (the
 *  pill's vertical middle), so both stops are deepened one step; the pill
 *  still reads as the same coral and the midpoint clears 4.5:1. */
export const BELL_BADGE = {
  top: '#DB6A50',
  bottom: '#A3381F',
  ink: '#FFFFFF',
} as const;

/** Brand count pill on Home tiles (Subscriptions 2, Contacts 4). */
export const TILE_BADGE = {
  top: '#8E72FF',
  bottom: '#4A36D6',
  ink: '#FFFFFF',
} as const;
