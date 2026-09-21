import { describe, it, expect } from 'vitest';
import { renderGroupSettleUpInnerHtml, type GroupSettleUpPdfInput } from './groupSettleUpPdf';
import { foreignFragmentsIn, translatorFor, withAppLanguage } from './testing/docLanguage';

const en = translatorFor('en');
const ur = translatorFor('ur');

const input: GroupSettleUpPdfInput = {
  groupName: 'Dubai Trip',
  emoji: '🏝️',
  currency: 'AED',
  debts: [
    { from: 'a', fromName: 'Ali', to: 'b', toName: 'Bilal', amount: 120 },
    { from: 'c', fromName: 'Sana', to: 'b', toName: 'Bilal', amount: 45.5 },
  ],
  expenses: [
    { date: '2026-07-01T19:00:00.000Z', description: 'Dinner', paidByName: 'Bilal', amount: 240 },
    { date: '2026-07-02T10:00:00.000Z', description: 'Taxi', paidByName: 'Ali', amount: 91 },
  ],
  simplify: true,
  asOf: '2026-07-03T09:00:00.000Z',
  fromName: 'Bilal',
};

describe('renderGroupSettleUpInnerHtml', () => {
  const html = renderGroupSettleUpInnerHtml({ ...input, t: en });

  it('lists every transfer and the expenses behind them', () => {
    expect(html).toContain('>Settle-up plan<');
    expect(html).toContain('As of 03 Jul 2026');
    expect(html).toContain('Simplified — fewest transfers');
    expect(html).toContain('🏝️ Dubai Trip');
    expect(html).toContain('Who pays whom');
    expect(html).toContain('All amounts in AED');
    expect(html).toContain('→ Bilal');
    expect(html).toContain('120.00');
    expect(html).toContain('45.50');
    expect(html).toContain('>Paid by<');
    expect(html).toContain('331.00'); // 240 + 91
    expect(html).toContain('E&amp;OE');
    expect(html).toContain('Page 1 of 1');
  });

  it('wears the shared brand letterhead (navy band, violet accent)', () => {
    expect(html.trimStart().startsWith('<div style="background:linear-gradient(180deg,#0F1020 0%,#0A0A14 100%)')).toBe(true);
    expect(html).toContain('height:3px;background:linear-gradient(90deg,#7C5CFF 0%,#5B47E8 100%)');
    for (const old of ['#0B0E2A', '#9DA2C0', '#FAF8F1', '#E7E3D6']) expect(html).not.toContain(old);
  });

  it('is English only', () => {
    expect(foreignFragmentsIn(html, 'ur')).toEqual([]);
  });

  it('names the direct plan when not simplified, and the empty states', () => {
    const empty = renderGroupSettleUpInnerHtml({ ...input, debts: [], expenses: [], simplify: false, t: en });
    expect(empty).toContain('Direct — who owes whom');
    expect(empty).toContain('Everyone is settled up — nothing outstanding.');
    expect(empty).toContain('No expenses recorded.');
  });

  it('masks every amount when hideAmounts is on', () => {
    const masked = renderGroupSettleUpInnerHtml({ ...input, hideAmounts: true, t: en });
    for (const n of ['120.00', '45.50', '240.00', '91.00', '331.00']) expect(masked).not.toContain(n);
    expect(masked).toContain('●●,●●●');
    expect(masked).toContain('Dinner');
  });
});

describe('renderGroupSettleUpInnerHtml — roman Urdu', () => {
  const urHtml = renderGroupSettleUpInnerHtml({ ...input, t: ur });

  it('is roman Urdu only', () => {
    expect(foreignFragmentsIn(urHtml, 'en')).toEqual([]);
    expect(urHtml).toContain('03 Jul 2026 tak');
    expect(urHtml).toContain('Simplified — kam se kam transfers');
    expect(urHtml).toContain('Kis ne kis ko dena hai');
    expect(urHtml).toContain('Tamam raqam AED mein');
    expect(urHtml).toContain('>Kharche<');
    expect(urHtml).toContain('>Kul<');
    expect(urHtml).toContain('Safha 1 / 1');
    const empty = renderGroupSettleUpInnerHtml({ ...input, debts: [], expenses: [], simplify: false, t: ur });
    expect(empty).toContain('Sab ka hisaab barabar — kuch baqi nahi.');
    expect(foreignFragmentsIn(empty, 'en')).toEqual([]);
  });

  it('prints the same figures as the English plan', () => {
    for (const n of ['120.00', '45.50', '240.00', '91.00', '331.00', '01 Jul 2026']) expect(urHtml).toContain(n);
  });

  it('follows the app language when no translator is passed', () => {
    expect(withAppLanguage('ur', () => renderGroupSettleUpInnerHtml(input))).toBe(urHtml);
  });
});
