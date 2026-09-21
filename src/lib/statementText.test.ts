import { describe, it, expect } from 'vitest';
import {
  describeStatementLine,
  fillTemplate,
  greetingLine,
  netBalanceLabel,
  payOrReceiveLabel,
  renderStatementText,
} from './statementText';
import { buildStatement } from './statementOfAccount';
import { foreignFragmentsIn, translatorFor, withAppLanguage } from './testing/docLanguage';
import type { Loan, Transaction } from '../db';

const en = translatorFor('en');
const ur = translatorFor('ur');

function loan(p: Partial<Loan> & Pick<Loan, 'id' | 'type' | 'totalAmount' | 'remainingAmount' | 'currency'>): Loan {
  return { personName: 'Maryam', personId: 'p1', status: 'active', notes: '', createdAt: '2026-01-01T00:00:00.000Z', ...p } as Loan;
}
function txn(p: Partial<Transaction> & Pick<Transaction, 'id' | 'type' | 'amount' | 'currency' | 'relatedLoanId' | 'createdAt'>): Transaction {
  return { sourceAccountId: null, destinationAccountId: null, relatedPerson: 'Maryam', personId: 'p1', relatedGoalId: null, conversionRate: null, category: '', notes: '', ...p } as Transaction;
}

// AED: the user lent Maryam 10,000 + 500 and she paid 2,500 back ⇒ she pays 8,000.
// PKR: the user borrowed 30,000 from her ⇒ she receives 30,000.
const statement = buildStatement({
  partyName: 'Maryam Corpuz',
  loans: [
    loan({ id: 'L1', type: 'given', totalAmount: 10500, remainingAmount: 8000, currency: 'AED' }),
    loan({ id: 'L2', type: 'taken', totalAmount: 30000, remainingAmount: 30000, currency: 'PKR', createdAt: '2026-06-25T00:00:00.000Z' }),
  ],
  transactions: [
    txn({ id: 'a1', type: 'loan_given', amount: 10000, currency: 'AED', relatedLoanId: 'L1', createdAt: '2026-06-21T00:00:00.000Z', notes: 'Visa application' }),
    txn({ id: 'a2', type: 'repayment', amount: 2500, currency: 'AED', relatedLoanId: 'L1', createdAt: '2026-06-28T00:00:00.000Z' }),
    txn({ id: 'a3', type: 'loan_given', amount: 500, currency: 'AED', relatedLoanId: 'L1', createdAt: '2026-07-01T00:00:00.000Z' }),
    txn({ id: 'b1', type: 'loan_taken', amount: 30000, currency: 'PKR', relatedLoanId: 'L2', createdAt: '2026-06-25T00:00:00.000Z' }),
  ],
  asOf: '2026-07-02T14:30:00.000Z',
  scope: 'contact',
});
const opts = { greeting: 'Hello Maryam Corpuz,', fromName: 'Muhammad Abdullah' };

// Every amount and date a message carries, in order of appearance.
const figures = (s: string) => s.match(/[−+]?(?:AED|₨) [\d,]+\.\d{2}|\d{1,2} [A-Z][a-z]{2} \d{4}/g) ?? [];

describe('renderStatementText — one language per message', () => {
  const english = renderStatementText(statement, { ...opts, t: en });
  const urdu = renderStatementText(statement, { ...opts, t: ur });

  it('English: every sentence is English, and speaks to the reader', () => {
    expect(english).toBe([
      'Hello Maryam Corpuz,',
      '',
      '*Statement of account*',
      'Maryam Corpuz',
      'As of 2 Jul 2026',
      '',
      'You need to pay Muhammad Abdullah AED 8,000.00',
      '• 21 Jun 2026 · You borrowed · −AED 10,000.00',
      '• 28 Jun 2026 · You paid back · +AED 2,500.00',
      '• 1 Jul 2026 · You borrowed · −AED 500.00',
      '',
      'You will receive ₨ 30,000.00 from Muhammad Abdullah',
      '• 25 Jun 2026 · You lent · +₨ 30,000.00',
      '',
      'Thank you,',
      'Muhammad Abdullah',
      '',
      '— via Hisaab',
    ].join('\n'));
    expect(foreignFragmentsIn(english, 'ur')).toEqual([]);
  });

  it('roman Urdu: every sentence is roman Urdu — no English repeat', () => {
    expect(urdu).toBe([
      'Hello Maryam Corpuz,',
      '',
      '*Hisaab ka statement*',
      'Maryam Corpuz',
      '2 Jul 2026 tak',
      '',
      'Aap ne Muhammad Abdullah ko AED 8,000.00 dene hain',
      '• 21 Jun 2026 · Aap ko udhaar mila · −AED 10,000.00',
      '• 28 Jun 2026 · Aap ne wapas diye · +AED 2,500.00',
      '• 1 Jul 2026 · Aap ko udhaar mila · −AED 500.00',
      '',
      'Aap ko Muhammad Abdullah se ₨ 30,000.00 milenge',
      '• 25 Jun 2026 · Aap ne udhaar diya · +₨ 30,000.00',
      '',
      'Shukriya,',
      'Muhammad Abdullah',
      '',
      '— via Hisaab',
    ].join('\n'));
    expect(foreignFragmentsIn(urdu, 'en')).toEqual([]);
  });

  it('the language check is not vacuous: it sees each document\'s own language', () => {
    expect(foreignFragmentsIn(english, 'en').length).toBeGreaterThanOrEqual(5);
    expect(foreignFragmentsIn(urdu, 'ur').length).toBeGreaterThanOrEqual(5);
    // …and it would catch the old bilingual output.
    expect(foreignFragmentsIn(`${english}\nAap ko Muhammad Abdullah ko AED 8,000.00 dene hain`, 'ur')).toContain('dene hain');
  });

  it('states each currency headline once (no closing "Outstanding —" repeat)', () => {
    expect(english.split('You need to pay Muhammad Abdullah AED 8,000.00')).toHaveLength(2);
    expect(english).not.toContain('Outstanding');
    expect(urdu.split('dene hain')).toHaveLength(2);
  });

  it('carries exactly the same amounts and dates in both languages', () => {
    expect(figures(urdu)).toEqual(figures(english));
    expect(figures(english)).toEqual([
      '2 Jul 2026',
      'AED 8,000.00', '21 Jun 2026', '−AED 10,000.00', '28 Jun 2026', '+AED 2,500.00', '1 Jul 2026', '−AED 500.00',
      '₨ 30,000.00', '25 Jun 2026', '+₨ 30,000.00',
    ]);
  });

  it('follows the app language when no translator is passed', () => {
    expect(withAppLanguage('ur', () => renderStatementText(statement, opts))).toBe(urdu);
    expect(withAppLanguage('en', () => renderStatementText(statement, opts))).toBe(english);
  });

  it('masks every amount in either language, keeping names, dates and structure', () => {
    for (const t of [en, ur]) {
      const masked = renderStatementText(statement, { ...opts, t, hideAmounts: true });
      expect(masked).not.toMatch(/\d,\d{3}\.\d{2}/);
      expect(masked).toContain('AED ●●,●●●');
      expect(masked).toContain('21 Jun 2026');
      expect(masked).toContain('Muhammad Abdullah');
    }
  });

  it('a settled currency gets one warm line, in one language', () => {
    const settled = buildStatement({
      partyName: 'Ahmed',
      loans: [loan({ id: 'S1', type: 'given', totalAmount: 5000, remainingAmount: 0, currency: 'AED', status: 'settled' })],
      transactions: [
        txn({ id: 's1', type: 'loan_given', amount: 5000, currency: 'AED', relatedLoanId: 'S1', createdAt: '2026-05-01T00:00:00.000Z' }),
        txn({ id: 's2', type: 'repayment', amount: 5000, currency: 'AED', relatedLoanId: 'S1', createdAt: '2026-06-01T00:00:00.000Z' }),
      ],
      asOf: '2026-07-02T00:00:00.000Z',
      scope: 'loan',
    });
    const e = renderStatementText(settled, { t: en });
    const u = renderStatementText(settled, { t: ur });
    expect(e).toContain('All settled in AED — nothing pending 🎉');
    expect(e).not.toContain('Mubarak');
    expect(u).toContain('AED mein hisaab barabar — kuch baqi nahi 🎉');
    expect(u).not.toContain('Congratulations');
    expect(e.match(/🎉/g)).toHaveLength(1);
    expect(u.match(/🎉/g)).toHaveLength(1);
  });

  it('a statement with no sections says "all settled" once', () => {
    const empty = buildStatement({ partyName: 'Ahmed', loans: [], transactions: [], asOf: '2026-07-02T00:00:00.000Z', scope: 'contact' });
    expect(renderStatementText(empty, { t: en })).toContain('All settled — nothing pending 🎉');
    const u = renderStatementText(empty, { t: ur });
    expect(u).toContain('Hisaab barabar — kuch baqi nahi 🎉');
    expect(foreignFragmentsIn(u, 'en')).toEqual([]);
  });

  it('folds older rows into a brought-forward line, in the message language', () => {
    const e = renderStatementText(statement, { t: en, maxLinesPerSection: 2 });
    expect(e).toContain('• Brought forward · −AED 7,500.00 (2 earlier entries)');
    const u = renderStatementText(statement, { t: ur, maxLinesPerSection: 2 });
    expect(u).toContain('• Pichla baqi · −AED 7,500.00 (2 purani entries)');
  });

  it('settled-loan fold lines show the cleared amount with a tick', () => {
    const folded = buildStatement({
      partyName: 'Ahmed',
      loans: [
        loan({ id: 'open', type: 'given', totalAmount: 500, remainingAmount: 500, currency: 'AED' }),
        loan({ id: 'old1', type: 'given', totalAmount: 100, remainingAmount: 0, currency: 'AED', status: 'settled', createdAt: '2025-11-01T00:00:00.000Z' }),
        loan({ id: 'old2', type: 'given', totalAmount: 200, remainingAmount: 0, currency: 'AED', status: 'settled', createdAt: '2025-12-01T00:00:00.000Z' }),
      ],
      transactions: [txn({ id: 't1', type: 'loan_given', amount: 500, currency: 'AED', relatedLoanId: 'open', createdAt: '2026-05-01T00:00:00.000Z' })],
      asOf: '2026-07-02T00:00:00.000Z',
      scope: 'contact',
    });
    expect(renderStatementText(folded, { t: en })).toContain('• 1 Nov 2025 · 2 earlier loans — settled in full · AED 300.00 ✓');
    expect(renderStatementText(folded, { t: ur })).toContain('• 1 Nov 2025 · 2 purane qarz — poore ada · AED 300.00 ✓');
  });

  it('keeps the estimated-entries note, once, in the message language', () => {
    const ledgerOnly = buildStatement({
      partyName: 'Ahmed',
      loans: [loan({ id: 'L1', type: 'taken', totalAmount: 8000, remainingAmount: 3000, currency: 'AED' })],
      transactions: [],
      asOf: '2026-07-02T00:00:00.000Z',
      scope: 'loan',
    });
    const e = renderStatementText(ledgerOnly, { t: en });
    expect(e).toContain('Paid back to you (summary)');
    expect(e).toContain('(Some entries are summarised from loan balances, not recorded one by one.)');
    const u = renderStatementText(ledgerOnly, { t: ur });
    expect(u).toContain('Aap ko wapas mile (khulasa)');
    expect(foreignFragmentsIn(u, 'en')).toEqual([]);
  });
});

describe('describeStatementLine', () => {
  it('names the loan on a repayment without its own note', () => {
    const s = buildStatement({
      partyName: 'Ahmed',
      loans: [loan({ id: 'L1', type: 'given', totalAmount: 500, remainingAmount: 440, currency: 'AED', notes: 'April mess' })],
      transactions: [
        txn({ id: 't1', type: 'loan_given', amount: 500, currency: 'AED', relatedLoanId: 'L1', createdAt: '2026-05-01T00:00:00.000Z' }),
        txn({ id: 't2', type: 'repayment', amount: 60, currency: 'AED', relatedLoanId: 'L1', createdAt: '2026-06-01T00:00:00.000Z' }),
      ],
      asOf: '2026-07-02T00:00:00.000Z',
      scope: 'loan',
    });
    const repayment = s.sections[0].lines[1];
    expect(describeStatementLine(repayment, en)).toBe('You paid back — April mess');
    expect(describeStatementLine(repayment, ur)).toBe('Aap ne wapas diye — April mess');
  });
});

describe('greetingLine / netBalanceLabel / payOrReceiveLabel', () => {
  it('greets in the chosen style; none or no name ⇒ empty', () => {
    expect(greetingLine('hello', ' Rashid ', en)).toBe('Hello Rashid,');
    expect(greetingLine('salaam', 'Rashid', ur)).toBe('Assalam-o-Alaikum Rashid,');
    expect(greetingLine('dear', 'Rashid', en)).toBe('Dear Rashid,');
    expect(greetingLine('none', 'Rashid', en)).toBe('');
    expect(greetingLine('hello', '  ', en)).toBe('');
  });

  it('the in-app headline follows the language (the sender view)', () => {
    expect(netBalanceLabel('Ahmed', 100, 'AED', undefined, en)).toBe('Ahmed owes you AED 100.00');
    expect(netBalanceLabel('Ahmed', 100, 'AED', undefined, ur)).toBe('Ahmed ne aap ko AED 100.00 dene hain');
    expect(netBalanceLabel('Ahmed', -40, 'AED', undefined, en)).toBe('You owe Ahmed AED 40.00');
    expect(netBalanceLabel('Ahmed', -40, 'AED', undefined, ur)).toBe('Aap ne Ahmed ko AED 40.00 dene hain');
    expect(netBalanceLabel('Ahmed', 0, 'AED', undefined, en)).toBe('Settled up with Ahmed');
    expect(netBalanceLabel('Ahmed', 0, 'AED', undefined, ur)).toBe('Ahmed ke saath hisaab barabar');
  });

  it('tells the reader to pay, receive, or that they are settled', () => {
    expect(payOrReceiveLabel(50, 'AED', 'Ali', undefined, en)).toEqual({ mode: 'pay', text: 'You need to pay Ali AED 50.00' });
    expect(payOrReceiveLabel(50, 'AED', undefined, undefined, ur)).toEqual({ mode: 'pay', text: 'Aap ne AED 50.00 dene hain' });
    expect(payOrReceiveLabel(-50, 'AED', 'Ali', undefined, ur)).toEqual({ mode: 'receive', text: 'Aap ko Ali se AED 50.00 milenge' });
    expect(payOrReceiveLabel(-50, 'AED', undefined, undefined, en)).toEqual({ mode: 'receive', text: 'You will receive AED 50.00' });
    expect(payOrReceiveLabel(0.004, 'AED', 'Ali', undefined, en).mode).toBe('settled');
  });
});

describe('fillTemplate', () => {
  it('fills in one pass: substituted values are never re-expanded, $ is literal', () => {
    expect(fillTemplate('Pay {name} {amount}', { name: '{amount}', amount: 'AED 5' })).toBe('Pay {amount} AED 5');
    expect(fillTemplate('To {name}', { name: 'A $& B' })).toBe('To A $& B');
    expect(fillTemplate('Keep {unknown}', {})).toBe('Keep {unknown}');
  });
});
