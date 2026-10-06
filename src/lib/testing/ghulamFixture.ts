// Test-only fixture: a ledger SHAPED like the 2026-10-06 Ghulam case (real
// burst amounts and server-style timestamps; generic ids and notes). One
// borrower ('taken' loans, AED) repays lump sums that the allocation flow
// fanned out across loans, plus one past record synced twice (the duplicate
// 100). Imported only by *.test.ts files.

import type { Loan, SettlementRequest, Transaction } from '../../db';

export interface GhulamFixture {
  loans: Loan[];
  txns: Transaction[];
  settlements: SettlementRequest[];
  ids: { d1: string; d2: string; big: string };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export function ghulamFixture(): GhulamFixture {
  const loans: Loan[] = [];
  const txns: Transaction[] = [];
  const settlements: SettlementRequest[] = [];
  let seq = 0;
  const serverTs = (base: string, offsetMs: number) =>
    new Date(Date.parse(base) + offsetMs).toISOString().replace('Z', '000+00:00');

  function addLoan(total: number, createdAt: string, notes = ''): string {
    const id = `L${++seq}`;
    loans.push({
      id, personName: 'Abdullah', personId: 'pA', type: 'taken', totalAmount: total, remainingAmount: total,
      currency: 'AED', status: 'active', notes, createdAt,
    });
    txns.push({
      id: `T${id}`, type: 'loan_taken', amount: total, currency: 'AED', sourceAccountId: null, destinationAccountId: null,
      relatedPerson: 'Abdullah', personId: 'pA', relatedLoanId: id, relatedGoalId: null, conversionRate: null,
      category: '', notes, createdAt,
    });
    return id;
  }
  function repay(loanId: string, amount: number, createdAt: string, intent?: string) {
    const loan = loans.find((l) => l.id === loanId)!;
    loan.remainingAmount = round2(loan.remainingAmount - amount);
    if (loan.remainingAmount <= 0.00001) {
      loan.remainingAmount = 0;
      loan.status = 'settled';
    }
    const id = `R${++seq}`;
    txns.push({
      id, type: 'repayment', amount, currency: 'AED', sourceAccountId: null, destinationAccountId: null,
      relatedPerson: 'Abdullah', personId: 'pA', relatedLoanId: loanId, relatedGoalId: null, conversionRate: null,
      category: '', notes: '', createdAt,
    });
    if (intent) {
      settlements.push({
        id: `${intent}:${loanId}`, loanPairId: 'pair', requesterLoanId: `their-${loanId}`, responderLoanId: loanId,
        fromUserId: 'abdullah', toUserId: 'ghulam', amount, currency: 'AED', note: '', status: 'accepted',
        rejectionReason: null, requesterTxnId: `their-${id}`, responderTxnId: id, recordedByReceiver: true,
        createdAt, respondedAt: createdAt,
      });
    }
  }
  function burst(intent: string, base: string, parts: Array<[string, number]>) {
    parts.forEach(([loanId, amt], i) => repay(loanId, amt, serverTs(base, i * 1700), intent));
  }

  // The duplicate pair: one 100 AED loan mirrored twice, each repaid once.
  const d1 = addLoan(100, '2026-04-23T19:18:31.632Z', 'Day loan');
  repay(d1, 100, '2026-04-23T19:22:23.441Z');
  const d2 = addLoan(100, '2026-05-26T10:00:09.613Z', 'Day loan');
  addLoan(4596.11, '2026-05-07T18:40:17.549Z', 'Carried over'); // the rest of the open balance
  const c1 = addLoan(2974.25, '2026-09-21T22:26:28.154Z', 'Paint store');
  const c2 = addLoan(126.5, '2026-09-21T22:26:32.997Z', 'Taxi + market');
  const dLeft = addLoan(482.25, '2026-09-21T22:26:22.871Z', 'Fuel + food');
  repay(d2, 100, '2026-09-21T22:27:10.610Z');
  // 24 Sep: 3,000 across 2 loans.
  burst('i3000', '2026-09-24T15:21:38.376871Z', [[c1, 2974.25], [c2, 25.75]]);
  // 26 Sep: 3,100 across 15 loans.
  const smallAmts = [333, 700, 556.5, 159.6, 123, 120, 22, 16, 135, 82.88, 84, 0.5, 286.26];
  const small = smallAmts.map((a, i) => addLoan(a, `2026-09-23T18:45:${String(10 + i).padStart(2, '0')}.000Z`, `Item ${i + 1}`));
  burst('i3100', '2026-09-26T16:30:36.02977Z', [...small.map((id, i): [string, number] => [id, smallAmts[i]]), [c2, 100.75], [dLeft, 380.51]]);
  // 5 Oct: 8,000 across 11 loans, then 2,000 across 10 (one loan in both).
  const big = addLoan(3395.11, '2026-10-05T07:43:08.530Z', 'Tools');
  const eightAmts = [3100, 500, 1256.5, 230, 24, 19, 4.5, 68, 18, 887.25];
  const eight = eightAmts.map((a, i) => addLoan(a, `2026-10-05T07:43:${String(20 + i).padStart(2, '0')}.000Z`, `Bill ${i + 1}`));
  burst('i8000', '2026-10-05T08:24:42.507383Z', [...eight.map((id, i): [string, number] => [id, eightAmts[i]]), [big, 1892.75]]);
  const twoAmts = [31.2, 58, 378, 53, 38.5, 83, 165, 85, 32.5];
  const two = twoAmts.map((a, i) => addLoan(a, `2026-10-05T08:27:${String(10 + i).padStart(2, '0')}.000Z`, `Meal ${i + 1}`));
  burst('i2000', '2026-10-05T17:25:43.15391Z', [...two.map((id, i): [string, number] => [id, twoAmts[i]]), [big, 1075.8]]);

  return { loans, txns, settlements, ids: { d1, d2, big } };
}
