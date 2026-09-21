import { describe, it, expect } from 'vitest';
import { renderKametiSlipInnerHtml, type KametiSlipInput } from './kametiSlipPdf';
import { foreignFragmentsIn, translatorFor, withAppLanguage } from './testing/docLanguage';

const en = translatorFor('en');
const ur = translatorFor('ur');

const input: KametiSlipInput = {
  committeeName: 'Office Committee',
  currency: 'PKR',
  round: 3,
  totalRounds: 10,
  pool: 80000,
  recipientName: 'Bilal',
  contributed: 24000,
  net: 56000,
  witnessUrl: 'https://usehisaab.com/kameti/witness/abc123',
  date: '2026-07-03T09:00:00.000Z',
  organiserName: 'Muhammad Abdullah',
};

describe('renderKametiSlipInnerHtml', () => {
  const html = renderKametiSlipInnerHtml({ ...input, t: en });

  it('leads with the payout amount, recipient, and round', () => {
    expect(html).toContain('Office Committee');
    expect(html).toContain('Payout · PKR');
    expect(html).toContain('80,000.00');
    expect(html).toContain('Round 3 of 10');
    expect(html).toContain('Received by Bilal');
    expect(html).toContain('Organiser');
  });

  it('shows the recipient position and the witness verify link', () => {
    expect(html).toContain('24,000.00'); // contributed
    expect(html).toContain('56,000.00'); // net
    expect(html).toContain('usehisaab.com/kameti/witness/abc123');
    expect(html).toContain('Verify this kameti live');
    expect(html).toContain('#047857'); // received teal
  });

  it('wears the shared brand letterhead (navy band, violet accent)', () => {
    expect(html.trimStart().startsWith('<div style="background:linear-gradient(180deg,#0F1020 0%,#0A0A14 100%)')).toBe(true);
    expect(html).toContain('height:3px;background:linear-gradient(90deg,#7C5CFF 0%,#5B47E8 100%)');
    expect(html).toContain('>Kameti payout slip<');
    for (const old of ['#0B0E2A', '#9DA2C0', '#FAF8F1', '#E7E3D6']) expect(html).not.toContain(old);
  });

  it('is English only', () => {
    expect(foreignFragmentsIn(html, 'ur')).toEqual([]);
  });

  it('masks every amount when hideAmounts is on, while names/round/witness survive', () => {
    const masked = renderKametiSlipInnerHtml({ ...input, hideAmounts: true, t: en });
    expect(masked).not.toContain('80,000.00'); // pool hero
    expect(masked).not.toContain('24,000.00'); // contributed
    expect(masked).not.toContain('56,000.00'); // net
    expect(masked).toContain('●●,●●●');
    expect(masked).toContain('Round 3 of 10'); // round survives
    expect(masked).toContain('Received by Bilal'); // names survive
    expect(masked).toContain('usehisaab.com/kameti/witness/abc123'); // trust seal survives
  });

  it('omits the witness block when no url is given', () => {
    const bare = renderKametiSlipInnerHtml({
      committeeName: 'C', currency: 'PKR', round: 1, totalRounds: 5, pool: 5000,
      recipientName: 'A', contributed: 1000, net: 4000, date: '2026-07-03T09:00:00.000Z', t: en,
    });
    expect(bare).not.toContain('Verify this kameti live');
  });
});

describe('renderKametiSlipInnerHtml — roman Urdu', () => {
  // A committee name without English words, so any English on the page is ours.
  const urHtml = renderKametiSlipInnerHtml({ ...input, committeeName: 'Dost Kameti', t: ur });

  it('is roman Urdu only', () => {
    expect(foreignFragmentsIn(urHtml, 'en')).toEqual([]);
    expect(urHtml).toContain('Baari 3 / 10');
    expect(urHtml).toContain('Bilal ko mila');
    expect(urHtml).toContain('Ab tak jama kiye');
    expect(urHtml).toContain('Is kameti ko live verify karein');
    expect(urHtml).toContain('Safha 1 / 1');
  });

  it('prints the same figures as the English slip', () => {
    for (const n of ['80,000.00', '24,000.00', '+56,000.00', '03 Jul 2026']) expect(urHtml).toContain(n);
  });

  it('follows the app language when no translator is passed', () => {
    expect(withAppLanguage('ur', () => renderKametiSlipInnerHtml({ ...input, committeeName: 'Dost Kameti' }))).toBe(urHtml);
  });
});
