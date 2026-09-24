import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { contrastRatio } from './contrast';
import { DARK, LIGHT, SURFACES, type ColorToken } from './designTokens';
import { tStatic, useI18nStore } from './i18n';
import {
  TXN_TYPE_CAPSULE,
  acceptSheetKind,
  capsuleToneClass,
  linkedRequestKind,
  notificationKind,
  settlementKind,
  type CapsuleTone,
  type TxnTypeKind,
} from './txnTypeCapsule';

describe('linkedRequestKind — reader perspective', () => {
  it('sender keeps the kind as written', () => {
    expect(linkedRequestKind('lent', true)).toBe('lent');
    expect(linkedRequestKind('borrowed', true)).toBe('borrowed');
  });
  it('receiver reads it flipped (they lent me → I borrowed)', () => {
    expect(linkedRequestKind('lent', false)).toBe('borrowed');
    expect(linkedRequestKind('borrowed', false)).toBe('lent');
  });
});

describe('settlementKind', () => {
  it('a loan I gave is being paid back to me', () => {
    expect(settlementKind('given')).toBe('received_back');
  });
  it('a loan I took is one I am paying back', () => {
    expect(settlementKind('taken')).toBe('paid_back');
  });
  it('unknown side stays neutral instead of guessing', () => {
    expect(settlementKind(null)).toBe('payment');
    expect(settlementKind(undefined)).toBe('payment');
  });
});

describe('acceptSheetKind', () => {
  it('loan: money in = I borrowed, out = I lent', () => {
    expect(acceptSheetKind('loan', 'in')).toBe('borrowed');
    expect(acceptSheetKind('loan', 'out')).toBe('lent');
    expect(acceptSheetKind('loan', 'unknown')).toBe('payment');
  });
  it('settlement: in = received back, out = paid back', () => {
    expect(acceptSheetKind('settlement', 'in')).toBe('received_back');
    expect(acceptSheetKind('settlement', 'out')).toBe('paid_back');
    expect(acceptSheetKind('settlement', 'unknown')).toBe('payment');
  });
});

describe('notificationKind', () => {
  it.each<[{ type?: string; template?: string | null }, TxnTypeKind]>([
    [{ type: 'group_update', template: 'expense_added' }, 'group_expense'],
    [{ type: 'group_update', template: 'expense_deleted' }, 'group_expense'],
    [{ type: 'group_update', template: 'settlement_added' }, 'group_settle'],
    [{ type: 'group_update', template: 'member_joined' }, 'group'],
    [{ type: 'group_update', template: 'group_archived' }, 'group'],
    [{ type: 'group_update', template: null }, 'group'],
    [{ type: 'invite', template: null }, 'group_invite'],
    [{ type: 'kameti', template: 'kameti_round_due' }, 'kameti'],
    [{ type: 'system', template: 'kameti_draw_completed' }, 'kameti'],
    [{ type: 'contact_linked' }, 'contact'],
    [{ type: 'linked_info', template: 'lsr_recorded' }, 'paid_back'],
    [{ type: 'linked_info', template: 'lsr_undone' }, 'paid_back'],
    [{ type: 'system' }, 'update'],
    [{}, 'update'],
  ])('%j → %s', (n, kind) => {
    expect(notificationKind(n)).toBe(kind);
  });
});

describe('capsule table', () => {
  const kinds = Object.keys(TXN_TYPE_CAPSULE) as TxnTypeKind[];

  it('every label is a real bilingual i18n key', () => {
    for (const lang of ['ur', 'en'] as const) {
      useI18nStore.setState({ lang });
      for (const kind of kinds) {
        const key = TXN_TYPE_CAPSULE[kind].labelKey;
        const label = tStatic(key);
        // tStatic echoes the key back when it is missing from the dictionary.
        expect(label, `${kind} (${lang})`).not.toBe(key);
        expect(label.trim(), `${kind} (${lang})`).not.toBe('');
      }
    }
    useI18nStore.setState({ lang: 'en' });
  });

  it('the four money directions never share a colour', () => {
    const tones = (['lent', 'borrowed', 'received_back', 'paid_back'] as TxnTypeKind[]).map(
      (k) => TXN_TYPE_CAPSULE[k].tone,
    );
    expect(new Set(tones).size).toBe(4);
  });

  it('lent is green (owed to me), borrowed is coral (I owe)', () => {
    expect(TXN_TYPE_CAPSULE.lent.tone).toBe('receive');
    expect(TXN_TYPE_CAPSULE.borrowed.tone).toBe('pay');
    expect(TXN_TYPE_CAPSULE.kameti.tone).toBe('gold');
  });
});

// ── Contrast: every capsule tone's text on its fill, both themes ───────────
// Parsed from the real stylesheet so a later edit to a `.m-chip-*` rule is
// checked, not a hand-copied pair.
const css = readFileSync(resolve(__dirname, '../index.css'), 'utf8');

function chipRule(tone: CapsuleTone): string {
  const m = css.match(new RegExp(`\\.${capsuleToneClass(tone)}\\s*\\{([^}]*)\\}`));
  if (!m) throw new Error(`index.css: .${capsuleToneClass(tone)} not found`);
  return m[1];
}

function varToken(rule: string, prop: 'background' | 'color'): string | null {
  const m = rule.match(new RegExp(`(?:^|;|\\s)${prop}:\\s*var\\(--(?:color-)?([a-z0-9-]+)\\)`));
  return m ? m[1] : null;
}

// Alpha-composite a translucent fill (the neutral chip's --m-track) over a
// surface: the chip's real background.
function blend(rgba: [number, number, number, number], base: string): string {
  const [r, g, b, a] = rgba;
  const n = parseInt(base.slice(1), 16);
  const br = (n >> 16) & 255;
  const bg = (n >> 8) & 255;
  const bb = n & 255;
  const mix = (f: number, s: number) => Math.round(f * a + s * (1 - a));
  return `#${[mix(r, br), mix(g, bg), mix(b, bb)].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

const TRACK: Record<'light' | 'dark', [number, number, number, number]> = {
  light: [74, 58, 20, 0.07],
  dark: [255, 255, 255, 0.08],
};

it('the neutral capsule track values match index.css', () => {
  expect(css).toContain('--m-track: rgba(74, 58, 20, 0.07)');
  expect(css).toContain('--m-track: rgba(255, 255, 255, 0.08)');
});

describe.each([
  ['light', LIGHT],
  ['dark', DARK],
] as const)('%s theme — capsule contrast (4.5:1)', (theme, T) => {
  const tones = [...new Set(Object.values(TXN_TYPE_CAPSULE).map((c) => c.tone))];
  it.each(tones)('%s capsule', (tone) => {
    const rule = chipRule(tone);
    const fg = varToken(rule, 'color') as ColorToken;
    expect(T[fg], `${tone} text token`).toBeDefined();
    if (tone === 'neutral') {
      // Translucent track over each surface a row can sit on.
      for (const surface of ['card', 'card-face-bottom', 'sheet'] as const) {
        const bg = blend(TRACK[theme], SURFACES[theme][surface]);
        expect(contrastRatio(T[fg], bg), `${tone} on ${surface}`).toBeGreaterThanOrEqual(4.5);
      }
      return;
    }
    const bgToken = varToken(rule, 'background') as ColorToken;
    expect(T[bgToken], `${tone} fill token`).toBeDefined();
    expect(contrastRatio(T[fg], T[bgToken])).toBeGreaterThanOrEqual(4.5);
  });
});
