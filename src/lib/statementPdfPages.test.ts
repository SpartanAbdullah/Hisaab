import { describe, it, expect } from 'vitest';
import { buildPendingItems } from './pendingLedger';
import { buildStatement } from './statementOfAccount';
import { planStatementPages, renderStatementPagesHtml, type FullStatementPdfOptions } from './statementPdfPages';
import { settlementBatchKeys } from './statementRows';
import { foreignFragmentsIn, translatorFor } from './testing/docLanguage';
import { ghulamFixture } from './testing/ghulamFixture';

const en = translatorFor('en');
const ur = translatorFor('ur');
const monthUtc = (iso: string) => new Date(iso).toISOString().slice(0, 7);

function ghulamDoc() {
  const { loans, txns, settlements, ids } = ghulamFixture();
  const statement = buildStatement({ partyName: 'Abdullah', loans, transactions: txns, asOf: '2026-10-06T09:00:00.000Z', scope: 'contact', detail: 'full' });
  const keys = settlementBatchKeys(settlements);
  const pending = buildPendingItems({
    person: { id: 'pA', linkedProfileId: 'abdullah' },
    myUserId: 'ghulam',
    loansById: new Map(loans.map((l) => [l.id, l])),
    personLoanIds: new Set(loans.map((l) => l.id)),
    linkedRequests: [
      { id: 'q1', fromUserId: 'abdullah', toUserId: 'ghulam', personId: 'x', kind: 'lent', amount: 13, currency: 'AED', note: 'Restaurant', status: 'pending', rejectionReason: null, requesterLoanId: null, responderLoanId: null, requesterTxnId: null, responderTxnId: null, loanPairId: null, preExistingLoanId: null, createdAt: '2026-10-05T17:29:44.000Z', respondedAt: null },
      { id: 'q2', fromUserId: 'abdullah', toUserId: 'ghulam', personId: 'x', kind: 'lent', amount: 87.6, currency: 'AED', note: 'Hypermarket', status: 'pending', rejectionReason: null, requesterLoanId: null, responderLoanId: null, requesterTxnId: null, responderTxnId: null, loanPairId: null, preExistingLoanId: null, createdAt: '2026-10-05T17:30:12.000Z', respondedAt: null },
    ],
    settlementRequests: [],
  });
  const opts: FullStatementPdfOptions = {
    perspective: 'self',
    fromName: 'Ghulam Mustafa',
    pending,
    batchKeyOf: (l) => (l.txnId ? keys.get(l.txnId) : undefined),
    duplicateLoanIds: new Map([[ids.d1, 2], [ids.d2, 2]]),
    monthOf: monthUtc,
  };
  return { statement, opts, loans, txns };
}

describe('full-history statement pages', () => {
  const { statement, opts, txns } = ghulamDoc();
  const pagesEn = renderStatementPagesHtml(statement, { ...opts, t: en });
  const pagesUr = renderStatementPagesHtml(statement, { ...opts, t: ur });
  const all = pagesEn.join('\n');

  it('spreads a long ledger over several numbered pages', () => {
    expect(pagesEn.length).toBeGreaterThan(2);
    pagesEn.forEach((p, i) => expect(p).toContain(`Page ${i + 1} of ${pagesEn.length}`));
    pagesUr.forEach((p, i) => expect(p).toContain(`Safha ${i + 1} / ${pagesUr.length}`));
  });

  it('places every ledger row exactly once, and never splits a payment from its loans', () => {
    const plan = planStatementPages(statement, opts);
    const rowKeys = plan.flat().flatMap((i) => (i.k === 'row' ? [i.row.key] : []));
    expect(new Set(rowKeys).size).toBe(rowKeys.length);
    const children = plan.flat().filter((i) => i.k === 'child').length;
    expect(children).toBe(2 + 15 + 11 + 10);
    // Every real loan + repayment row is accounted for (rows + children).
    const lines = statement.sections[0].lines.length;
    const shown = plan.flat().filter((i) => i.k === 'row' || i.k === 'child').length - 4; // 4 burst parents
    expect(shown).toBe(lines);
    expect(lines).toBe(txns.length);
    for (const page of plan) {
      page.forEach((item, idx) => {
        if (item.k === 'row' && item.row.type === 'burst') {
          const after = page.slice(idx + 1, idx + 1 + item.row.count);
          expect(after.every((c) => c.k === 'child')).toBe(true);
        }
      });
    }
  });

  it('carries the balance forward exactly from page to page', () => {
    const value = (html: string, label: string) => {
      const at = html.lastIndexOf(label);
      if (at < 0) return null;
      const m = html.slice(at).match(/>([+−]?[\d,]+\.\d{2})</);
      return m ? m[1] : null;
    };
    let carried = 0;
    for (let i = 0; i < pagesEn.length - 1; i++) {
      const cf = value(pagesEn[i], 'Carried forward');
      if (cf === null) continue;
      carried++;
      const bf = value(pagesEn[i + 1], 'Brought forward');
      expect(bf).toBe(cf);
    }
    expect(carried).toBeGreaterThan(0);
  });

  it('opens with the reconciliation, the pending items and the month table', () => {
    expect(pagesEn[0]).toContain('My copy');
    expect(pagesEn[0]).toContain('You need to pay · AED');
    expect(pagesEn[0]).toContain('To Abdullah');
    expect(pagesEn[0]).toContain('What you owe');
    expect(pagesEn[0]).toMatch(/Checks out: 0\.00 \+ [\d,]+\.\d{2} − [\d,]+\.\d{2} = 5,124\.41/);
    expect(pagesEn[0]).toContain('Awaiting confirmation — not in the total');
    expect(pagesEn[0]).toContain('Waiting for you to confirm');
    expect(pagesEn[0]).toContain('If all are accepted: <span style="color:#C2410C;">−5,225.01</span>');
    expect(all).toContain('Month by month · AED');
    expect(all).toContain('Oct 2026');
  });

  it('reads each lump payment as one row, with the loans it cleared under it', () => {
    expect(all).toContain('You paid back · across 11 loans');
    expect(all).toContain('You paid back · across 15 loans');
    expect(all).toContain('↳ Tools · loan left at 426.56');
    expect(all).toContain('duplicate entry · nets to zero');
    expect(all).toContain('Closing balance');
  });

  it('is one language per document', () => {
    expect(foreignFragmentsIn(all, 'ur')).toEqual([]);
    expect(foreignFragmentsIn(pagesUr.join('\n'), 'en')).toEqual([]);
    expect(pagesUr[0]).toContain('Meri copy');
    expect(pagesUr[0]).toContain('Hisaab theek:');
  });

  it('masks every figure when amounts are hidden', () => {
    const masked = renderStatementPagesHtml(statement, { ...opts, t: en, hideAmounts: true }).join('\n');
    for (const figure of ['5,124.41', '5,225.01', '426.56', '8,000.00', '3,100.00', '87.60', '4,596.11']) {
      expect(masked).not.toContain(figure);
    }
    expect(masked).toContain('Checks out:');
    expect(masked).toContain('Oct 2026'); // structure survives
  });

  it("counterparty perspective mirrors 'My copy' exactly", () => {
    const sent = renderStatementPagesHtml(statement, { ...opts, perspective: 'counterparty', fromName: 'Ghulam Mustafa', t: en });
    // Abdullah reading the copy Ghulam sends him: he will receive the balance.
    expect(sent[0]).toContain('You will receive · AED');
    expect(sent[0]).toContain('From Ghulam Mustafa');
    expect(sent[0]).toContain('What you are owed');
    expect(sent[0]).not.toContain('My copy');
  });
});
