import { describe, expect, it } from 'vitest';
import { buildKametiSlipText } from './kametiSlipText';
import { foreignFragmentsIn, translatorFor, withAppLanguage } from './testing/docLanguage';

const en = translatorFor('en');
const ur = translatorFor('ur');
const base = { committeeName: 'Office BC', currency: 'AED', pool: 5000, round: 3, totalRounds: 10 } as const;

describe('buildKametiSlipText — one language (backlog 2026-09-22 item 8b)', () => {
  it('writes the English slip with no roman-Urdu line', () => {
    const text = buildKametiSlipText({ ...base, organiserName: 'Abdullah', witnessUrl: 'https://usehisaab.com/w/abc' }, en);
    expect(text).toBe([
      '*Kameti payout slip — Office BC*',
      'You received AED 5,000.00 — Round 3 of 10.',
      'Thank you!',
      '',
      'Verify live: https://usehisaab.com/w/abc',
      '',
      '— Abdullah, via Hisaab',
    ].join('\n'));
    expect(text).not.toContain('Shukriya');
    expect(foreignFragmentsIn(text, 'ur')).toEqual([]);
  });

  it('writes the Urdu slip with no English line', () => {
    const text = buildKametiSlipText({ ...base, organiserName: 'Abdullah' }, ur);
    expect(text).toContain('Aap ko AED 5,000.00 mile — Baari 3 / 10.');
    expect(text).toContain('Shukriya!');
    expect(text).not.toContain('Round');
    expect(text).not.toContain('Thank you');
    expect(foreignFragmentsIn(text, 'en')).toEqual([]);
  });

  it('signs off plainly without an organiser name', () => {
    expect(buildKametiSlipText(base, en).endsWith('\n— via Hisaab')).toBe(true);
  });

  it('masks the payout when amounts are hidden', () => {
    const text = buildKametiSlipText({ ...base, hideAmounts: true }, en);
    expect(text).not.toContain('5,000');
    expect(text).toContain('●');
  });

  it('follows the app language when no translator is passed', () => {
    const text = withAppLanguage('ur', () => buildKametiSlipText(base));
    expect(text).toContain('Shukriya!');
    expect(foreignFragmentsIn(text, 'en')).toEqual([]);
  });
});
