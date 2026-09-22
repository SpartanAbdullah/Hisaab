import { describe, it, expect } from 'vitest';
import { memberSettleUp, buildMemberCardText, buildFullPlanText } from './groupSettleUp';
import type { GroupDebt } from './groupDebts';
import { MONEY_TOLERANCE } from './moneyTolerance';
import { greetingLine } from './statementText';
import { foreignFragmentsIn, translatorFor, withAppLanguage } from './testing/docLanguage';

// A owes B 120; C owes A 30. So A: owes 120, owed 30 → net −90 (pays 90 overall).
const debts: GroupDebt[] = [
  { from: 'A', fromName: 'Ali', to: 'B', toName: 'Bilal', amount: 120 },
  { from: 'C', fromName: 'Chand', to: 'A', toName: 'Ali', amount: 30 },
];

describe('memberSettleUp', () => {
  it('nets what a member owes against what they are owed', () => {
    const su = memberSettleUp(debts, 'A');
    expect(su.owes).toHaveLength(1);
    expect(su.owed).toHaveLength(1);
    expect(su.net).toBe(-90); // owes 120, owed 30
  });

  it('is positive when a member only receives', () => {
    expect(memberSettleUp(debts, 'B').net).toBe(120);
  });

  it('is zero for an uninvolved member', () => {
    expect(memberSettleUp(debts, 'Z').net).toBe(0);
  });
});

describe('buildMemberCardText', () => {
  it('is recipient-focused with the exact transfers', () => {
    const su = memberSettleUp(debts, 'A');
    const text = buildMemberCardText(su, { groupName: 'Dubai Trip', currency: 'AED', greeting: 'Hello Ali,', fromName: 'Me' });
    expect(text).toContain('Hello Ali,');
    expect(text).toContain('*Settle up — Dubai Trip*');
    expect(text).toContain('You need to pay AED 90.00 overall.');
    expect(text).toContain('You pay Bilal AED 120.00');
    expect(text).toContain('Chand pays you AED 30.00');
    expect(text).toContain('Thank you,');
  });

  it('says settled when the member has no transfers', () => {
    const text = buildMemberCardText(memberSettleUp(debts, 'Z'), { groupName: 'Dubai Trip', currency: 'AED' });
    expect(text).toContain("You're all settled up in Dubai Trip.");
  });

  // Boundary check for MONEY_TOLERANCE (moneyTolerance.ts), now imported
  // instead of the old inline `0.005` literal — same threshold, same strict
  // `>`, so a net exactly AT the tolerance still reads as settled.
  it('treats a net exactly at MONEY_TOLERANCE as settled, not a payable', () => {
    const zeroed: GroupDebt[] = [];
    const su = memberSettleUp(zeroed, 'Z');
    expect(su.net).toBe(0);
    expect(MONEY_TOLERANCE).toBe(0.005);
    const text = buildMemberCardText({ ...su, net: MONEY_TOLERANCE }, { groupName: 'Dubai Trip', currency: 'AED' });
    expect(text).toContain("You're all settled up in Dubai Trip.");
  });

  it('treats a net just above MONEY_TOLERANCE as a real payable', () => {
    const su = memberSettleUp(debts, 'A');
    const text = buildMemberCardText({ ...su, net: -(MONEY_TOLERANCE + 0.001) }, { groupName: 'Dubai Trip', currency: 'AED' });
    expect(text).toContain('You need to pay');
  });

  it('masks every amount when hideAmounts is on, keeping names and structure', () => {
    const su = memberSettleUp(debts, 'A');
    const text = buildMemberCardText(su, { groupName: 'Dubai Trip', currency: 'AED', hideAmounts: true });
    expect(text).toContain('You need to pay AED ●●,●●● overall.');
    expect(text).toContain('You pay Bilal AED ●●,●●●');
    expect(text).toContain('Chand pays you AED ●●,●●●');
    expect(text).not.toContain('90.00');
    expect(text).not.toContain('120.00');
    expect(text).not.toContain('30.00');
    expect(text).toContain('*Settle up — Dubai Trip*'); // structure survives
  });
});

describe('buildFullPlanText', () => {
  it('lists every X-pays-Y transfer', () => {
    const text = buildFullPlanText(debts, 'Dubai Trip', 'AED');
    expect(text).toContain('Ali pays Bilal AED 120.00');
    expect(text).toContain('Chand pays Ali AED 30.00');
  });

  it('handles a fully settled group', () => {
    expect(buildFullPlanText([], 'Dubai Trip', 'AED')).toContain('Everyone is settled up');
  });
});

// One language per message (founder 2026-09-19; backlog 2026-09-22 item 8b).
// The card used to be English-only, so an Urdu user's card opened with an Urdu
// greeting and carried on in English.
describe('settle-up text — one language', () => {
  const ur = translatorFor('ur');
  const en = translatorFor('en');

  it('writes the whole member card in roman Urdu, greeting included', () => {
    const su = memberSettleUp(debts, 'A');
    const text = buildMemberCardText(
      su,
      { groupName: 'Dubai Trip', currency: 'AED', greeting: greetingLine('salaam', 'Ali', ur), fromName: 'Me' },
      ur,
    );
    expect(text).toBe([
      'Assalam-o-Alaikum Ali,',
      '',
      '*Hisaab barabar karein — Dubai Trip*',
      'Kul mila kar aap ne AED 90.00 dene hain.',
      '',
      '• Aap ne Bilal ko AED 120.00 dene hain',
      '• Chand ne aap ko AED 30.00 dene hain',
      '',
      'Shukriya,',
      'Me',
      '',
      '— via Hisaab',
    ].join('\n'));
    expect(foreignFragmentsIn(text, 'en')).toEqual([]);
  });

  it('the English card carries no roman-Urdu copy', () => {
    const text = buildMemberCardText(memberSettleUp(debts, 'A'), { groupName: 'Dubai Trip', currency: 'AED', fromName: 'Me' }, en);
    expect(foreignFragmentsIn(text, 'ur')).toEqual([]);
  });

  it('says settled in Urdu too', () => {
    const text = buildMemberCardText(memberSettleUp(debts, 'Z'), { groupName: 'Dubai Trip', currency: 'AED' }, ur);
    expect(text).toContain('Dubai Trip mein aap ka hisaab barabar hai.');
    expect(foreignFragmentsIn(text, 'en')).toEqual([]);
  });

  it('follows the app language when no translator is passed', () => {
    const text = withAppLanguage('ur', () => buildMemberCardText(memberSettleUp(debts, 'B'), { groupName: 'Trip', currency: 'AED' }));
    expect(text).toContain('Kul mila kar aap ko AED 120.00 milenge.');
    expect(foreignFragmentsIn(text, 'en')).toEqual([]);
  });

  it('writes the full plan in one language', () => {
    const u = buildFullPlanText(debts, 'Dubai Trip', 'AED', ur);
    expect(u).toContain('• Ali ne Bilal ko AED 120.00 dene hain');
    expect(foreignFragmentsIn(u, 'en')).toEqual([]);
    expect(buildFullPlanText([], 'Dubai Trip', 'AED', ur)).toContain('Sab ka hisaab barabar');
    expect(foreignFragmentsIn(buildFullPlanText(debts, 'Dubai Trip', 'AED', en), 'ur')).toEqual([]);
  });
});
