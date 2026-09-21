import { describe, it, expect } from 'vitest';
import { renderStatementInnerHtml, type StatementPdfOptions } from './statementPdf';
import { buildStatement } from './statementOfAccount';
import { PDF_COLORS } from './pdfLetterhead';
import { foreignFragmentsIn, translatorFor, withAppLanguage } from './testing/docLanguage';
import type { Loan, Transaction } from '../db';

const en = translatorFor('en');
const ur = translatorFor('ur');

function loan(p: Partial<Loan> & Pick<Loan, 'id' | 'type' | 'totalAmount' | 'remainingAmount' | 'currency'>): Loan {
  return { personName: 'Ahmed', personId: 'p1', status: 'active', notes: '', createdAt: '2026-01-01T00:00:00.000Z', ...p } as Loan;
}
function txn(p: Partial<Transaction> & Pick<Transaction, 'id' | 'type' | 'amount' | 'currency' | 'relatedLoanId' | 'createdAt'>): Transaction {
  return { sourceAccountId: null, destinationAccountId: null, relatedPerson: 'Ahmed', personId: 'p1', relatedGoalId: null, conversionRate: null, category: '', notes: '', ...p } as Transaction;
}

// Positive AED (they owe you) + negative PKR (you owe them), with a repayment
// so both the "You received" and "You gave" columns are exercised.
function sampleStatement() {
  const loans = [
    loan({ id: 'L1', type: 'given', totalAmount: 10500, remainingAmount: 8000, currency: 'AED' }),
    loan({ id: 'L2', type: 'taken', totalAmount: 30000, remainingAmount: 30000, currency: 'PKR', createdAt: '2026-06-25T00:00:00.000Z' }),
  ];
  const transactions = [
    txn({ id: 'a1', type: 'loan_given', amount: 10000, currency: 'AED', relatedLoanId: 'L1', createdAt: '2026-06-21T00:00:00.000Z', notes: 'Visa application' }),
    txn({ id: 'a2', type: 'repayment', amount: 2500, currency: 'AED', relatedLoanId: 'L1', createdAt: '2026-06-28T00:00:00.000Z', notes: 'Part payment' }),
    txn({ id: 'a3', type: 'loan_given', amount: 500, currency: 'AED', relatedLoanId: 'L1', createdAt: '2026-07-01T00:00:00.000Z', notes: 'Medical' }),
    txn({ id: 'b1', type: 'loan_taken', amount: 30000, currency: 'PKR', relatedLoanId: 'L2', createdAt: '2026-06-25T00:00:00.000Z', notes: 'Rent deposit' }),
  ];
  return buildStatement({ partyName: 'Maryam Corpuz', loans, transactions, asOf: '2026-07-02T14:30:00.000Z', scope: 'contact' });
}
const baseOpts: StatementPdfOptions = { phone: '+971 52 449 5778', fromName: 'Muhammad Abdullah', greeting: 'Hello Maryam Corpuz,' };
function sampleHtml(extraOpts: Partial<StatementPdfOptions> = {}): string {
  return renderStatementInnerHtml(sampleStatement(), { ...baseOpts, t: en, ...extraOpts });
}

// Every amount and date on the page (CSS numbers ride along; they are the same
// in both languages, so they don't disturb the comparison).
const figures = (s: string) => s.match(/\d[\d,]*\.\d{2}|\d{2} [A-Z][a-z]{2}(?: \d{4})?/g) ?? [];

describe('renderStatementInnerHtml', () => {
  const html = sampleHtml();

  it('carries the trust scaffolding (letterhead, statement no, period, parties, E&OE)', () => {
    expect(html).toContain('Statement of account');
    expect(html).toMatch(/No\. HIS-\d{6}-[0-9A-Z]{4}/); // statement number
    expect(html).toContain('As of 02 Jul 2026');
    expect(html).toContain('Period 21 Jun 2026 – 02 Jul 2026');
    expect(html).toContain('Maryam Corpuz');
    expect(html).toContain('Account of');
    expect(html).toContain('Prepared by');
    expect(html).toContain('E&amp;OE');
    expect(html).toContain('Page 1 of 1');
  });

  it('wears the brand letterhead: navy hero band, violet accent, white type', () => {
    // The band opens the page — the app hero's navy, top to bottom.
    expect(html.trimStart().startsWith('<div style="background:linear-gradient(180deg,#0F1020 0%,#0A0A14 100%)')).toBe(true);
    // Violet mark beside the wordmark + the thin violet rule under the band.
    expect(html).toContain('linear-gradient(135deg,#7C5CFF 0%,#5B47E8 100%)');
    expect(html).toContain('height:3px;background:linear-gradient(90deg,#7C5CFF 0%,#5B47E8 100%)');
    expect(html).toContain(`color:${PDF_COLORS.onNavy};letter-spacing:-0.01em;line-height:1;">Hisaab<`);
    expect(html).toContain(`color:${PDF_COLORS.onNavyViolet};margin-top:6px;">Statement of account<`);
    // The retired letterhead colours are gone.
    for (const old of ['#0B0E2A', '#9DA2C0', '#C7CAE0', '#F1EFE8', '#E7E3D6']) expect(html).not.toContain(old);
  });

  it('leads with one recipient-focused hero per currency — each fact stated once', () => {
    // AED: Maryam owes → she must pay. PKR: she is owed → she receives.
    expect(html).toContain('You need to pay · AED');
    expect(html).toContain('You will receive · PKR');
    expect(html).toContain('To Muhammad Abdullah');
    expect(html).toContain('From Muhammad Abdullah');
    // No prose sentence repeating the hero figure.
    expect(html).not.toContain('You need to pay Muhammad Abdullah');
  });

  it('is English only — no roman-Urdu repeat anywhere', () => {
    expect(foreignFragmentsIn(html, 'ur')).toEqual([]);
    expect(html).not.toContain('Aap ko mila');
    expect(html).not.toContain('dena hai');
  });

  it('uses plain column language instead of Debit/Credit jargon', () => {
    expect(html).toContain('>You received<');
    expect(html).toContain('>You gave<');
    expect(html).toContain('>Balance<');
    expect(html).not.toContain('>Debit<');
    expect(html).not.toContain('>Credit<');
    expect(html).toContain('All amounts in AED');
    expect(html).toContain('All amounts in PKR');
    expect(html).toContain('Opening balance');
    expect(html).toContain('Closing balance');
  });

  it('celebrates a fully settled relationship once and still shows the history under it', () => {
    const loans = [loan({ id: 'L1', type: 'given', totalAmount: 5000, remainingAmount: 0, currency: 'AED', status: 'settled' })];
    const transactions = [
      txn({ id: 't1', type: 'loan_given', amount: 5000, currency: 'AED', relatedLoanId: 'L1', createdAt: '2026-05-01T00:00:00.000Z' }),
      txn({ id: 't2', type: 'repayment', amount: 5000, currency: 'AED', relatedLoanId: 'L1', createdAt: '2026-06-01T00:00:00.000Z' }),
    ];
    const st = buildStatement({ partyName: 'Ahmed', loans, transactions, asOf: '2026-07-02T00:00:00.000Z', scope: 'loan' });
    const settledHtml = renderStatementInnerHtml(st, { t: en });
    expect(settledHtml).toContain('All settled · AED');
    expect(settledHtml).toContain('Nothing pending 🎉');
    expect(settledHtml.match(/🎉/g)).toHaveLength(1);
    expect(settledHtml).not.toContain('Mubarak ho');
    expect(settledHtml).toContain('Activity'); // history table still present
    // Rows without a note are phrased from the reader's side.
    expect(settledHtml).toContain('You borrowed');
    expect(settledHtml).toContain('You paid back');
  });

  it('color-codes from the recipient perspective (pay = −red, receive = +green), CVD-safe', () => {
    expect(html).toContain('#047857'); // receive / credit teal
    expect(html).toContain('#C2410C'); // pay / debit vermillion
    expect(html).toContain('−8,000.00'); // AED: recipient owes ⇒ shown as −, they must pay
    expect(html).toContain('+30,000.00'); // PKR: recipient is owed ⇒ shown as +, they receive
  });

  it('uses contrast-safe muted text on the paper', () => {
    expect(html).toContain(PDF_COLORS.muted);
    expect(html).not.toContain('#9A9A93');
  });

  it('reconciles: the AED closing equals opening + debits − credits', () => {
    // 0 + (10,000 + 500) − 2,500 = 8,000.00 shown as the AED net.
    expect(html).toContain('8,000.00');
  });

  it('opens with the greeting and signs off with the sender name', () => {
    expect(html).toContain('Hello Maryam Corpuz,');
    expect(html).toContain('Thank you,');
    expect(html).toContain('>Muhammad Abdullah<');
  });

  it('masks every amount when hideAmounts is on, while names/dates/structure survive', () => {
    const masked = sampleHtml({ hideAmounts: true });
    // No amount leaks — ledger cells, running balances, tfoot totals and the
    // hero figure all carry the mask instead.
    expect(masked).not.toContain('8,000.00'); // AED net
    expect(masked).not.toContain('10,000.00'); // ledger debit
    expect(masked).not.toContain('2,500.00'); // ledger credit
    expect(masked).not.toContain('30,000.00'); // PKR side
    expect(masked).not.toContain('500.00'); // second loan-given row
    expect(masked).toContain('●●,●●●'); // bare ledger mask
    // The trust scaffolding is untouched: names, dates, statement no, period.
    expect(masked).toContain('Maryam Corpuz');
    expect(masked).toMatch(/No\. HIS-\d{6}-[0-9A-Z]{4}/);
    expect(masked).toContain('Period 21 Jun 2026 – 02 Jul 2026');
    expect(masked).toContain('21 Jun'); // ledger dates survive
    expect(masked).toContain('You need to pay · AED');
    expect(masked).toContain('To Muhammad Abdullah');
  });

  it('omits greeting and sign-off when not provided', () => {
    const loans = [loan({ id: 'L1', type: 'given', totalAmount: 100, remainingAmount: 100, currency: 'AED' })];
    const transactions = [txn({ id: 't1', type: 'loan_given', amount: 100, currency: 'AED', relatedLoanId: 'L1', createdAt: '2026-06-01T00:00:00.000Z' })];
    const st = buildStatement({ partyName: 'Ahmed', loans, transactions, asOf: '2026-07-02T00:00:00.000Z', scope: 'contact' });
    const bare = renderStatementInnerHtml(st, { t: en });
    expect(bare).not.toContain('Thank you,');
    expect(bare).not.toContain('Hello');
    expect(bare).not.toContain('Prepared by');
    expect(bare).not.toContain('To Muhammad'); // no sender ⇒ no counterparty line under the hero
  });
});

describe('renderStatementInnerHtml — roman Urdu', () => {
  const urHtml = renderStatementInnerHtml(sampleStatement(), { ...baseOpts, t: ur });

  it('is roman Urdu only — every label, the hero and the ledger', () => {
    expect(foreignFragmentsIn(urHtml, 'en')).toEqual([]);
    expect(urHtml).toContain('>Hisaab ka statement<');
    expect(urHtml).toContain('02 Jul 2026 tak');
    expect(urHtml).toContain('Muddat 21 Jun 2026 – 02 Jul 2026');
    expect(urHtml).toContain('Khata');
    expect(urHtml).toContain('Bhejne wale');
    expect(urHtml).toContain('Aap ne dene hain · AED');
    expect(urHtml).toContain('Aap ko milenge · PKR');
    expect(urHtml).toContain('Muhammad Abdullah ko');
    expect(urHtml).toContain('Muhammad Abdullah se');
    expect(urHtml).toContain('>Tareekh<');
    expect(urHtml).toContain('>Aap ko mile<');
    expect(urHtml).toContain('>Aap ne diye<');
    expect(urHtml).toContain('>Baqi<');
    expect(urHtml).toContain('Aakhri baqi');
    expect(urHtml).toContain('Shukriya,');
    expect(urHtml).toContain('Safha 1 / 1');
    expect(urHtml).toContain('E&amp;OE');
  });

  it('prints exactly the same amounts and dates as the English page', () => {
    expect(figures(urHtml)).toEqual(figures(sampleHtml()));
  });

  it('wears the same letterhead as the English page', () => {
    expect(urHtml.trimStart().startsWith('<div style="background:linear-gradient(180deg,#0F1020 0%,#0A0A14 100%)')).toBe(true);
    expect(urHtml).toContain('height:3px;background:linear-gradient(90deg,#7C5CFF 0%,#5B47E8 100%)');
  });

  it('follows the app language when no translator is passed', () => {
    expect(withAppLanguage('ur', () => renderStatementInnerHtml(sampleStatement(), baseOpts))).toBe(urHtml);
    expect(withAppLanguage('en', () => renderStatementInnerHtml(sampleStatement(), baseOpts))).toBe(sampleHtml());
  });
});
