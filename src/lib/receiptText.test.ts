import { describe, it, expect } from 'vitest';
import { buildReceiptText } from './receiptText';
import { foreignFragmentsIn, translatorFor, withAppLanguage } from './testing/docLanguage';

const en = translatorFor('en');
const ur = translatorFor('ur');
const base = { receivedAmount: 500, currency: 'AED', remaining: 1500, date: '2026-07-03T09:00:00.000Z' } as const;

describe('buildReceiptText', () => {
  it('includes the remaining balance on a partial payment', () => {
    const r = buildReceiptText({ ...base, t: en });
    expect(r.line).toBe('Received AED 500.00 from you on 03 Jul 2026 — remaining AED 1,500.00.');
    expect(r.message).toContain('*Payment received*');
    expect(r.message).toContain('— via Hisaab');
  });

  it('writes the whole receipt in roman Urdu when that is the language — no English line', () => {
    const r = buildReceiptText({ ...base, t: ur, greeting: 'Hello Rashid,', fromName: 'Muhammad Abdullah' });
    expect(r.line).toBe('03 Jul 2026 ko aap se AED 500.00 mil gaye — baqi AED 1,500.00.');
    expect(r.message).toBe([
      'Hello Rashid,',
      '',
      '*Payment mil gayi*',
      '03 Jul 2026 ko aap se AED 500.00 mil gaye — baqi AED 1,500.00.',
      '',
      'Shukriya,',
      'Muhammad Abdullah',
      '',
      '— via Hisaab',
    ].join('\n'));
    expect(foreignFragmentsIn(r.message, 'en')).toEqual([]);
  });

  it('the English receipt carries no roman-Urdu repeat', () => {
    const r = buildReceiptText({ ...base, t: en, fromName: 'Muhammad Abdullah' });
    expect(r.message.split('\n').filter((l) => l.includes('AED'))).toHaveLength(1);
    expect(foreignFragmentsIn(r.message, 'ur')).toEqual([]);
  });

  it('says fully settled when nothing remains', () => {
    const r = buildReceiptText({ ...base, receivedAmount: 1500, remaining: 0, t: en });
    expect(r.line).toBe('Received AED 1,500.00 from you on 03 Jul 2026 — now fully settled.');
    expect(r.line).not.toContain('remaining');
    const u = buildReceiptText({ ...base, receivedAmount: 1500, remaining: 0, t: ur });
    expect(u.line).toBe('03 Jul 2026 ko aap se AED 1,500.00 mil gaye — ab hisaab barabar.');
  });

  it('omits the remaining clause when remaining is unknown (null)', () => {
    const r = buildReceiptText({ ...base, currency: 'PKR', remaining: null, t: en });
    expect(r.line).toBe('Received ₨ 500.00 from you on 03 Jul 2026.');
    expect(r.line).not.toContain('remaining');
    expect(r.line).not.toContain('settled');
    expect(buildReceiptText({ ...base, currency: 'PKR', remaining: null, t: ur }).line).toBe('03 Jul 2026 ko aap se ₨ 500.00 mil gaye.');
  });

  it('keeps amounts in the given currency only (never mixes)', () => {
    const r = buildReceiptText({ ...base, currency: 'PKR', t: en });
    expect(r.line).toContain('₨ 500.00');
    expect(r.line).toContain('₨ 1,500.00');
    expect(r.line).not.toContain('AED');
  });

  it('adds greeting and sign-off when provided', () => {
    const r = buildReceiptText({ ...base, t: en, greeting: 'Hello Rashid,', fromName: 'Muhammad Abdullah' });
    const lines = r.message.split('\n');
    expect(lines[0]).toBe('Hello Rashid,');
    expect(r.message).toContain('Thank you,');
    expect(r.message).toContain('Muhammad Abdullah');
  });

  it('masks the amounts when hideAmounts is on, keeping the date and structure', () => {
    const r = buildReceiptText({ ...base, hideAmounts: true, t: en });
    expect(r.line).toBe('Received AED ●●,●●● from you on 03 Jul 2026 — remaining AED ●●,●●●.');
    expect(r.line).not.toContain('500'); // no digits leak in amount positions
    expect(r.message).toContain('*Payment received*');
    expect(r.message).toContain('03 Jul 2026'); // the date survives
    expect(buildReceiptText({ ...base, hideAmounts: true, t: ur }).line).toBe('03 Jul 2026 ko aap se AED ●●,●●● mil gaye — baqi AED ●●,●●●.');
  });

  it('omits greeting and sign-off when absent', () => {
    const r = buildReceiptText({ ...base, t: en });
    expect(r.message).not.toContain('Thank you,');
    const lines = r.message.split('\n');
    expect(lines[0]).toBe('*Payment received*');
  });

  it('follows the app language when no translator is passed', () => {
    expect(withAppLanguage('ur', () => buildReceiptText(base).message)).toBe(buildReceiptText({ ...base, t: ur }).message);
    expect(withAppLanguage('en', () => buildReceiptText(base).message)).toBe(buildReceiptText({ ...base, t: en }).message);
  });
});
