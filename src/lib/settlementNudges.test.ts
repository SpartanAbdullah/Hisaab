import { describe, expect, it, beforeEach } from 'vitest';
import { buildNudgeMessage, getOverdueSettlements, snoozeNudge, isSnoozed } from './settlementNudges';
import { foreignFragmentsIn, translatorFor, withAppLanguage } from './testing/docLanguage';
import type { SettlementRequest, Person } from '../db';

function settlement(overrides: Partial<SettlementRequest> = {}): SettlementRequest {
  return {
    id: `sr-${Math.random()}`,
    loanPairId: 'lp-1',
    requesterLoanId: 'l1',
    responderLoanId: 'l2',
    fromUserId: 'me',
    toUserId: 'them',
    amount: 100,
    currency: 'AED',
    note: '',
    status: 'pending',
    rejectionReason: null,
    requesterTxnId: null,
    responderTxnId: null,
    requesterAccountId: null,
    createdAt: daysAgoIso(5),
    respondedAt: null,
    ...overrides,
  };
}

function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

describe('getOverdueSettlements', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('returns empty when no requests are old enough', () => {
    const result = getOverdueSettlements([
      settlement({ createdAt: daysAgoIso(1) }),
      settlement({ createdAt: daysAgoIso(2) }),
    ]);
    expect(result).toEqual([]);
  });

  it('surfaces requests at least 3 days old', () => {
    const r1 = settlement({ id: 'r1', createdAt: daysAgoIso(3) });
    const r2 = settlement({ id: 'r2', createdAt: daysAgoIso(7) });
    const fresh = settlement({ id: 'fresh', createdAt: daysAgoIso(1) });
    const result = getOverdueSettlements([r1, r2, fresh]);
    expect(result).toHaveLength(2);
    expect(result.map((n) => n.request.id)).not.toContain('fresh');
  });

  it('orders nudges by most-overdue first', () => {
    const result = getOverdueSettlements([
      settlement({ id: 'r3', createdAt: daysAgoIso(4) }),
      settlement({ id: 'r10', createdAt: daysAgoIso(10) }),
      settlement({ id: 'r5', createdAt: daysAgoIso(5) }),
    ]);
    expect(result.map((n) => n.request.id)).toEqual(['r10', 'r5', 'r3']);
  });

  it('respects snooze: hides a snoozed request', () => {
    const r = settlement({ id: 'r1', createdAt: daysAgoIso(5) });
    snoozeNudge('r1');
    expect(isSnoozed('r1')).toBe(true);
    expect(getOverdueSettlements([r])).toEqual([]);
  });

  it('caps the result at the supplied limit', () => {
    const requests = Array.from({ length: 10 }, (_, i) =>
      settlement({ id: `r${i}`, createdAt: daysAgoIso(5 + i) }),
    );
    const result = getOverdueSettlements(requests, [], 3);
    expect(result).toHaveLength(3);
  });

  it('uses person name when linked profile matches', () => {
    const persons: Person[] = [
      {
        id: 'p1',
        name: 'Bilal',
        phone: null,
        linkedProfileId: 'them',
        createdAt: '',
        updatedAt: '',
      },
    ];
    const result = getOverdueSettlements(
      [settlement({ id: 'r1', toUserId: 'them' })],
      persons,
    );
    expect(result[0]?.recipientLabel).toBe('Bilal');
  });

  it('builds a WhatsApp URL when person has a phone', () => {
    const persons: Person[] = [
      {
        id: 'p1',
        name: 'Bilal',
        phone: '+971501234567',
        linkedProfileId: 'them',
        createdAt: '',
        updatedAt: '',
      },
    ];
    const result = getOverdueSettlements(
      [settlement({ id: 'r1', toUserId: 'them' })],
      persons,
    );
    expect(result[0]?.whatsappUrl).toMatch(/^https:\/\/wa\.me\/971501234567\?text=/);
  });

  it('returns null whatsappUrl when person has no phone', () => {
    const persons: Person[] = [
      {
        id: 'p1',
        name: 'Bilal',
        phone: null,
        linkedProfileId: 'them',
        createdAt: '',
        updatedAt: '',
      },
    ];
    const result = getOverdueSettlements(
      [settlement({ id: 'r1', toUserId: 'them' })],
      persons,
    );
    expect(result[0]?.whatsappUrl).toBe(null);
  });
});

// One language — the app's (backlog 2026-09-22 item 8b). The nudge used to be
// roman Urdu for everyone.
describe('buildNudgeMessage', () => {
  const r = settlement({ amount: 1500, currency: 'AED' });

  it('is English for an English user', () => {
    const text = buildNudgeMessage('Bilal', r, translatorFor('en'));
    expect(text).toBe([
      'Salam Bilal,',
      '',
      'I sent you a settlement request on Hisaab — AED 1,500.',
      'Please accept it when you get a minute. Thank you 🙂',
    ].join('\n'));
    expect(foreignFragmentsIn(text, 'ur')).toEqual([]);
  });

  it('is roman Urdu for an Urdu user', () => {
    const text = buildNudgeMessage('Bilal', r, translatorFor('ur'));
    expect(text).toContain('Hisaab par maine ek settlement request bheji thi — AED 1,500.');
    expect(text).toContain('Jab time mile, accept kar dena.');
    expect(foreignFragmentsIn(text, 'en')).toEqual([]);
  });

  it('follows the app language by default, fallback label included', () => {
    const [nudge] = withAppLanguage('ur', () => getOverdueSettlements([settlement({ toUserId: 'nobody' })]));
    expect(nudge?.recipientLabel).toBe('Aap ke network mein koi');
  });
});
