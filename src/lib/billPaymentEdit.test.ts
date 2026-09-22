import { describe, expect, it } from 'vitest';
import { linkedBillPaymentRows, transferEditKeepsMoney } from './billPaymentEdit';
import { buildInternalNote } from './internalNotes';

const covered = (id: string, linked: string) => ({
  id,
  type: 'repayment',
  notes: buildInternalNote('Covered by card bill payment', { linkedTransactionId: linked }),
});

describe('linkedBillPaymentRows', () => {
  const rows = [
    { id: 'bill', type: 'transfer', notes: '' },
    covered('r1', 'bill'),
    covered('r2', 'bill'),
    covered('r3', 'other-bill'),
    { id: 'plain', type: 'repayment', notes: 'paid Ali back' },
    { id: 'x', type: 'expense', notes: buildInternalNote('', { linkedTransactionId: 'bill' }) },
  ];

  it('finds exactly the repayment rows this bill payment wrote', () => {
    expect(linkedBillPaymentRows(rows, 'bill').map((r) => r.id)).toEqual(['r1', 'r2']);
  });

  it('a plain transfer has none', () => {
    expect(linkedBillPaymentRows(rows, 'plain-transfer')).toEqual([]);
  });
});

describe('transferEditKeepsMoney', () => {
  const base = { amount: 2394.69, sourceAccountId: 'enbd', destinationAccountId: 'rak', conversionRate: null };

  it('a date/note-only edit keeps the money', () => {
    expect(transferEditKeepsMoney(base, { ...base })).toBe(true);
    expect(transferEditKeepsMoney(base, { ...base, conversionRate: undefined })).toBe(true);
    expect(transferEditKeepsMoney(base, { ...base, amount: 2394.690000001 })).toBe(true);
  });

  it('changing the amount, either account or the rate does not', () => {
    expect(transferEditKeepsMoney(base, { ...base, amount: 2394.7 })).toBe(false);
    expect(transferEditKeepsMoney(base, { ...base, sourceAccountId: 'wio' })).toBe(false);
    expect(transferEditKeepsMoney(base, { ...base, destinationAccountId: 'cbd' })).toBe(false);
    expect(transferEditKeepsMoney(base, { ...base, conversionRate: 76.2 })).toBe(false);
  });
});
