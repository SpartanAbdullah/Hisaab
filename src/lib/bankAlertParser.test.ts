import { describe, expect, it } from 'vitest';
import { isNeverCapture, parseBankAlert } from './bankAlertParser';

// Representative templates (shapes, not verbatim bank copy). Real founder
// samples should be added here as they arrive — one `it` per bank.

describe('parseBankAlert — card purchases (UAE)', () => {
  it('reads a classic "purchase of AED X at MERCHANT" card alert', () => {
    const p = parseBankAlert(
      'Purchase of AED 120.50 at CARREFOUR MALL OF EMIRATES with Credit Card ending 4599 on 17/10/2026 14:33. Available balance AED 5,879.50.',
    );
    expect(p).not.toBeNull();
    expect(p!.amount).toBe(120.5);
    expect(p!.currency).toBe('AED');
    expect(p!.direction).toBe('debit');
    expect(p!.merchant).toBe('CARREFOUR MALL OF EMIRATES');
    expect(p!.accountHint).toBe('4599');
    expect(p!.occurredAt).toBe('2026-10-17');
    expect(p!.balanceAfter).toBe(5879.5);
    expect(p!.confidence).toBe('high');
  });

  it('treats "Dhs" and masked card digits as AED + last 4', () => {
    const p = parseBankAlert('Your card ****2489 was used for Dhs 45.00 at NOON.COM on 16-10-26.');
    expect(p?.currency).toBe('AED');
    expect(p?.amount).toBe(45);
    expect(p?.accountHint).toBe('2489');
    expect(p?.merchant).toBe('NOON.COM');
    expect(p?.occurredAt).toBe('2026-10-16');
    expect(p?.direction).toBe('debit');
  });

  it('does not let "credit card" count as a credit', () => {
    const p = parseBankAlert('AED 300.00 has been debited from your Credit Card ending 5828 at ADNOC.');
    expect(p?.direction).toBe('debit');
    expect(p?.merchant).toBe('ADNOC');
  });

  it('takes the amount, not the limit, when both are present', () => {
    const p = parseBankAlert('Txn of AED 1,250.00 at EMIRATES. Available limit AED 12,000.00');
    expect(p?.amount).toBe(1250);
    expect(p?.balanceAfter).toBe(12000);
  });
});

describe('parseBankAlert — accounts, transfers and credits', () => {
  it('reads a salary credit as income', () => {
    const p = parseBankAlert('Salary of AED 9,500.00 credited to your account ending 1234 on 2026-10-01. Balance AED 11,230.10');
    expect(p?.direction).toBe('credit');
    expect(p?.amount).toBe(9500);
    expect(p?.accountHint).toBe('1234');
    expect(p?.occurredAt).toBe('2026-10-01');
    expect(p?.balanceAfter).toBe(11230.1);
  });

  it('reads a Pakistani "Rs." transfer with a counterparty', () => {
    const p = parseBankAlert('Rs. 25,000 has been transferred to AHMED RAZA from your A/C 9988 on 15 Oct 2026. Bal Rs. 40,000');
    expect(p?.currency).toBe('PKR');
    expect(p?.amount).toBe(25000);
    expect(p?.direction).toBe('debit');
    expect(p?.merchant).toBe('AHMED RAZA');
    expect(p?.accountHint).toBe('9988');
    expect(p?.occurredAt).toBe('2026-10-15');
    expect(p?.balanceAfter).toBe(40000);
  });

  it('reads a wallet "received from" as a credit with the sender as label', () => {
    const p = parseBankAlert('You have received PKR 1,500 from Ali Khan. Your JazzCash balance is PKR 3,200.');
    expect(p?.direction).toBe('credit');
    expect(p?.merchant).toBe('Ali Khan');
    expect(p?.amount).toBe(1500);
  });

  it('reads an amount-then-currency form ("500.00 SAR")', () => {
    const p = parseBankAlert('POS purchase 500.00 SAR at PANDA HYPER on 12/10/26');
    expect(p?.currency).toBe('SAR');
    expect(p?.amount).toBe(500);
    expect(p?.merchant).toBe('PANDA HYPER');
  });

  it('accepts a bare dollar amount', () => {
    const p = parseBankAlert('You spent $12.99 at Netflix.');
    expect(p?.currency).toBe('USD');
    expect(p?.amount).toBe(12.99);
    expect(p?.merchant).toBe('Netflix');
  });

  it('amount only, no verb → low confidence, direction null', () => {
    const p = parseBankAlert('AED 75.00 — Lulu Hypermarket');
    expect(p?.amount).toBe(75);
    expect(p?.direction).toBeNull();
    expect(p?.confidence).toBe('low');
  });
});

describe('parseBankAlert — refuses what must not be recorded', () => {
  it('returns null for an OTP message even with an amount in it', () => {
    expect(parseBankAlert('Your OTP for AED 500.00 payment to NOON is 483921. Do not share.')).toBeNull();
    expect(isNeverCapture('One Time Password 1234')).toBe(true);
  });

  it('returns null for declined / failed transactions', () => {
    expect(parseBankAlert('Transaction of AED 200.00 at ZARA was DECLINED due to insufficient funds')).toBeNull();
  });

  it('returns null for future-tense and due notices', () => {
    expect(parseBankAlert('AED 1,200.00 will be debited on 25/10/2026 for your DEWA bill')).toBeNull();
    expect(parseBankAlert('Minimum due AED 350.00 payment due on 28/10/2026')).toBeNull();
  });

  it('returns null when the only amount is a balance', () => {
    expect(parseBankAlert('Your available balance is AED 5,000.00')).toBeNull();
  });

  it('returns null for text with no money in it', () => {
    expect(parseBankAlert('Hi, lunch tomorrow?')).toBeNull();
    expect(parseBankAlert('')).toBeNull();
  });

  it('ignores unknown three-letter words that look like codes', () => {
    expect(parseBankAlert('Ref ABC 123 for your query')).toBeNull();
  });
});

describe('parseBankAlert — dates', () => {
  it('prefers DD/MM over MM/DD and expands two-digit years', () => {
    expect(parseBankAlert('AED 10 spent on 03/11/26 at X')?.occurredAt).toBe('2026-11-03');
  });
  it('drops an impossible date rather than guessing', () => {
    expect(parseBankAlert('AED 10 spent on 45/13/2026 at X')?.occurredAt).toBeNull();
  });
});
