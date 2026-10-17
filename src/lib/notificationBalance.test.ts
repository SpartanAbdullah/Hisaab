import { describe, it, expect } from 'vitest';
import {
  balanceLineText,
  balanceTone,
  directionGlyph,
  directionOf,
  moveText,
  readBalanceMove,
  readParamNumber,
} from './notificationBalance';
import { tStatic, useI18nStore } from './i18n';
import type { I18nKey } from './i18n';

const en = (key: I18nKey): string => {
  useI18nStore.setState({ lang: 'en' });
  return tStatic(key);
};
const ur = (key: I18nKey): string => {
  useI18nStore.setState({ lang: 'ur' });
  return tStatic(key);
};

describe('readParamNumber / directionOf', () => {
  it('accepts numbers and numeric strings, rejects the rest', () => {
    expect(readParamNumber({ delta: -50 }, 'delta')).toBe(-50);
    expect(readParamNumber({ delta: '-50.25' }, 'delta')).toBe(-50.25);
    expect(readParamNumber({ delta: '' }, 'delta')).toBeNull();
    expect(readParamNumber({}, 'delta')).toBeNull();
    expect(readParamNumber({ delta: 'x' }, 'delta')).toBeNull();
  });
  it('a move smaller than half a minor unit is flat', () => {
    expect(directionOf(0.004)).toBe('flat');
    expect(directionOf(-0.004)).toBe('flat');
    expect(directionOf(0.01)).toBe('up');
    expect(directionOf(-0.01)).toBe('down');
    expect(directionOf(null)).toBe('flat');
    expect(directionGlyph('up')).toBe('▲');
    expect(directionGlyph('down')).toBe('▼');
    expect(directionGlyph('flat')).toBe('');
  });
});

describe('readBalanceMove — group rows', () => {
  const params = {
    actorName: 'Ali', groupName: 'Flat 12', description: 'Dinner', amount: 150, currency: 'AED',
    delta: -50, balanceAfter: -120, balanceScope: 'pair', counterpartyName: 'Ali',
  };

  it('an expense share: down, you owe, with the payer', () => {
    const move = readBalanceMove('expense_added', params)!;
    expect(move).toMatchObject({ scope: 'pair', direction: 'down', delta: -50, balanceAfter: -120, counterparty: 'Ali', inGroup: true, label: 'now' });
    expect(balanceTone(move)).toBe('pay');
    expect(moveText(move, en)).toBe('Your share: AED 50.00');
    expect(balanceLineText(move, { group: 'Flat 12' }, en)).toBe('Now in Flat 12: You owe Ali AED 120.00');
    expect(moveText(move, ur)).toBe('Aap ka hissa: AED 50.00');
    expect(balanceLineText(move, { group: 'Flat 12' }, ur)).toBe('Ab Flat 12 mein: Aap ne Ali ko AED 120.00 dene hain');
  });

  it('the payer reads the group scope: up, owed, overall', () => {
    const move = readBalanceMove('expense_added', { ...params, delta: 100, balanceAfter: 300, balanceScope: 'group', counterpartyName: undefined })!;
    expect(move.scope).toBe('group');
    expect(move.direction).toBe('up');
    expect(balanceTone(move)).toBe('receive');
    expect(moveText(move, en)).toBe('You paid — AED 100.00 is owed to you');
    expect(balanceLineText(move, { group: 'Flat 12' }, en)).toBe('Now in Flat 12: you are owed AED 300.00 overall');
    expect(balanceLineText(move, { group: 'Flat 12' }, ur)).toBe('Ab Flat 12 mein: kul AED 300.00 aap ko milne hain');
  });

  it('a bystander: flat, nothing changes, settled reads as settled', () => {
    const move = readBalanceMove('settlement_added', { currency: 'AED', delta: 0, balanceAfter: 0, balanceScope: 'group' })!;
    expect(move.direction).toBe('flat');
    expect(balanceTone(move)).toBe('neutral');
    expect(moveText(move, en)).toBe('Nothing changes for you');
    expect(balanceLineText(move, { group: 'Flat 12' }, en)).toBe('Now in Flat 12: all settled up');
    const notYours = readBalanceMove('expense_added', { currency: 'AED', delta: 0, balanceAfter: -20, balanceScope: 'pair', counterpartyName: 'Ali' })!;
    expect(moveText(notYours, en)).toBe('Not your share — nothing changes for you');
  });

  it('edits and settlements use the generic in-your-favour / against-you wording', () => {
    const up = readBalanceMove('settlement_added', { currency: 'AED', delta: 20, balanceAfter: -100, balanceScope: 'pair', counterpartyName: 'Ali' })!;
    expect(moveText(up, en)).toBe('AED 20.00 in your favour');
    // Tone follows the STATE (still owing), the arrow follows the move.
    expect(up.direction).toBe('up');
    expect(balanceTone(up)).toBe('pay');
    const down = readBalanceMove('expense_updated', { currency: 'AED', delta: -20, balanceAfter: 5, balanceScope: 'pair', counterpartyName: 'Ali' })!;
    expect(moveText(down, en)).toBe('AED 20.00 against you');
    expect(moveText(down, ur)).toBe('AED 20.00 aap ke zimme');
    expect(balanceTone(down)).toBe('receive');
  });

  it('a row without the stamp (older trigger) carries no move', () => {
    expect(readBalanceMove('expense_added', { amount: 10, currency: 'AED' })).toBeNull();
    expect(readBalanceMove('member_joined', { delta: 1, balanceAfter: 1 })).toBeNull();
    expect(readBalanceMove(null, { delta: 1 })).toBeNull();
    expect(readBalanceMove('expense_added', [] as unknown as Record<string, unknown>)).toBeNull();
  });
});

describe('readBalanceMove — linked rows', () => {
  it('a request is "if you accept", its delta derived from balanceNow when the stamp is missing', () => {
    const move = readBalanceMove('ltr_request', { actorName: 'Abdullah', currency: 'AED', balanceNow: -5137.41, balanceAfter: -5225.01 })!;
    expect(move.delta).toBe(-87.6);
    expect(move.direction).toBe('down');
    expect(move.label).toBe('if_accepted');
    expect(balanceLineText(move, {}, en)).toBe('If you accept: You owe Abdullah AED 5,225.01');
    expect(balanceLineText(move, {}, ur)).toBe('Accept karne par: Aap ne Abdullah ko AED 5,225.01 dene hain');
    expect(moveText(move, en)).toBe('');
  });

  it('a stamped delta wins; rejected says "Still"; settled is neutral', () => {
    const acc = readBalanceMove('lsr_accepted', { actorName: 'Sara', currency: 'AED', balanceAfter: 0, delta: 50 })!;
    expect(acc.direction).toBe('up');
    expect(balanceTone(acc)).toBe('neutral');
    expect(balanceLineText(acc, {}, en)).toBe('Now: Settled up with Sara');
    const rej = readBalanceMove('ltr_rejected', { actorName: 'Sara', currency: 'AED', balanceAfter: 1000, delta: 0 })!;
    expect(rej.label).toBe('still');
    expect(balanceLineText(rej, {}, en)).toBe('Still: Sara owes you AED 1,000.00');
    expect(balanceLineText(rej, {}, ur)).toBe('Ab bhi: Sara ne aap ko AED 1,000.00 dene hain');
    const confirm = readBalanceMove('lsr_request', { actorName: 'Sara', currency: 'AED', balanceAfter: 500, balanceNow: 700 })!;
    expect(confirm.label).toBe('if_confirmed');
    expect(confirm.direction).toBe('down');
  });

  it('an older row with only balanceAfter has no arrow but still a state', () => {
    const move = readBalanceMove('ltr_accepted', { actorName: 'Sara', currency: 'AED', balanceAfter: -25 })!;
    expect(move.delta).toBeNull();
    expect(move.direction).toBe('flat');
    expect(balanceTone(move)).toBe('pay');
  });
});

describe('readBalanceMove — kameti rows', () => {
  it('a contribution is money out; the line is the member position', () => {
    const move = readBalanceMove('kameti_contribution_recorded', {
      committeeName: 'Office kameti', currency: 'AED', amount: 500, round: 3,
      paidRounds: 3, totalRounds: 10, paidTotal: 1500, delta: -500,
    })!;
    expect(move.scope).toBe('kameti');
    expect(move.direction).toBe('down');
    expect(balanceTone(move)).toBe('pay');
    expect(balanceLineText(move, {}, en)).toBe('Paid 3 of 10 rounds · AED 1,500.00 in so far');
    expect(balanceLineText(move, {}, ur)).toBe('10 mein se 3 round ada · ab tak AED 1,500.00 jama');
    expect(moveText(move, en)).toBe('');
  });
  it('a payout is money in', () => {
    const move = readBalanceMove('kameti_payout_recorded', { currency: 'AED', paidTotal: 1500, delta: 5000, paidRounds: 3, totalRounds: 10 })!;
    expect(move.direction).toBe('up');
    expect(balanceTone(move)).toBe('receive');
  });
  it('a cron notice (round due) carries no position', () => {
    expect(readBalanceMove('kameti_round_due', { amount: 500, currency: 'PKR' })).toBeNull();
  });
});
