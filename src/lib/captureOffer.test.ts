import { describe, expect, it } from 'vitest';
import {
  buildCapturePreset,
  CAPTURE_TEXT_MAX,
  matchCaptureAccount,
  readCaptureParams,
  stripCaptureParams,
} from './captureOffer';

const acc = (id: string, currency: string, last4?: string, deletedAt: string | null = null) => ({
  id,
  name: id,
  type: 'bank',
  currency,
  metadata: (last4 ? { last4 } : {}) as Record<string, string>,
  deletedAt,
});

describe('readCaptureParams / stripCaptureParams', () => {
  it('reads shared text and caps it', () => {
    expect(readCaptureParams('?capture=AED%2050%20at%20X')).toEqual({ text: 'AED 50 at X' });
    const long = 'a'.repeat(CAPTURE_TEXT_MAX + 50);
    expect(readCaptureParams(`?capture=${long}`)?.text).toHaveLength(CAPTURE_TEXT_MAX);
  });
  it('reads a listener capture id, rejecting junk ids', () => {
    expect(readCaptureParams('?capture_id=c_1729000000_ab12')).toEqual({ captureId: 'c_1729000000_ab12' });
    expect(readCaptureParams('?capture_id=../etc')).toBeNull();
    expect(readCaptureParams('?add=expense')).toBeNull();
    expect(readCaptureParams('?capture=%20%20')).toBeNull();
  });
  it('reads an email candidate id (uuid) and rejects junk', () => {
    expect(readCaptureParams('?capture_email=0F1E2D3C-4B5A-4697-8877-66554433AABB')).toEqual({ captureEmailId: '0f1e2d3c-4b5a-4697-8877-66554433aabb' });
    expect(readCaptureParams('?capture_email=not-a-uuid')).toBeNull();
  });
  it('strips only its own params', () => {
    expect(stripCaptureParams('?capture=x&tab=2')).toBe('?tab=2');
    expect(stripCaptureParams('?capture_id=abc')).toBe('');
    expect(stripCaptureParams('?capture_email=abc&x=1')).toBe('?x=1');
  });
});

describe('matchCaptureAccount', () => {
  it('matches a single live account by last-4 in the same currency', () => {
    const a = matchCaptureAccount({ currency: 'AED', accountHint: '4599' }, [acc('cbd', 'AED', '4599'), acc('cash', 'AED')]);
    expect(a?.id).toBe('cbd');
  });
  it('refuses a last-4 match whose currency differs', () => {
    expect(matchCaptureAccount({ currency: 'PKR', accountHint: '4599' }, [acc('cbd', 'AED', '4599')])).toBeNull();
  });
  it('refuses when two accounts share the digits', () => {
    expect(matchCaptureAccount({ currency: 'AED', accountHint: '1234' }, [acc('a', 'AED', '1234'), acc('b', 'AED', '1234')])).toBeNull();
  });
  it('ignores deleted accounts', () => {
    expect(matchCaptureAccount({ currency: 'AED', accountHint: '4599' }, [acc('old', 'AED', '4599', '2026-01-01')])).toBeNull();
  });
  it('without a hint, matches only when the currency is unambiguous', () => {
    expect(matchCaptureAccount({ currency: 'PKR', accountHint: null }, [acc('hbl', 'PKR'), acc('cbd', 'AED')])?.id).toBe('hbl');
    expect(matchCaptureAccount({ currency: 'AED', accountHint: null }, [acc('cbd', 'AED'), acc('cash', 'AED')])).toBeNull();
    expect(matchCaptureAccount({ currency: 'USD', accountHint: null }, [acc('cbd', 'AED')])).toBeNull();
  });
});

describe('buildCapturePreset', () => {
  const history = [
    { type: 'expense', notes: 'Carrefour groceries', category: 'Groceries' },
    { type: 'expense', notes: 'carrefour', category: 'Groceries' },
    { type: 'income', notes: 'Salary Oct', category: 'Salary' },
  ];
  it('debit → expense with account, merchant note and learned category', () => {
    const p = buildCapturePreset({ amount: 120.5, merchant: 'CARREFOUR MOE' }, 'debit', acc('cbd', 'AED', '4599'), history);
    expect(p).toEqual({ type: 'expense', amount: 120.5, accountId: 'cbd', notes: 'CARREFOUR MOE', category: 'Groceries' });
  });
  it('credit → income; no account and no merchant stay absent', () => {
    expect(buildCapturePreset({ amount: 9500, merchant: null }, 'credit', null, history)).toEqual({ type: 'income', amount: 9500 });
  });
  it('an unknown merchant gets no category', () => {
    const p = buildCapturePreset({ amount: 10, merchant: 'ZZZ' }, 'debit', null, history);
    expect(p.category).toBeUndefined();
    expect(p.notes).toBe('ZZZ');
  });
});
