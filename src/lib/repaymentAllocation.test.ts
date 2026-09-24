import { describe, expect, it } from 'vitest';
import { allocateRepayment, orderLoansForStrategy, previewAllocations, totalRemaining, type AllocatableLoan } from './repaymentAllocation';

// The scenario from the report: 29, 50, 1000, 6000 owed; pays back 2000.
const loans: AllocatableLoan[] = [
  { id: 'a', remainingAmount: 29, createdAt: '2026-01-01' },
  { id: 'b', remainingAmount: 50, createdAt: '2026-02-01' },
  { id: 'c', remainingAmount: 1000, createdAt: '2026-03-01' },
  { id: 'd', remainingAmount: 6000, createdAt: '2026-04-01' },
];

describe('allocateRepayment — smallest-first', () => {
  it('clears the small loans first, spilling the rest into the next', () => {
    const out = allocateRepayment(loans, 2000, 'smallest');
    // 29 + 50 + 1000 = 1079 cleared, remaining 921 onto the 6000 loan.
    expect(out).toEqual([
      { loanId: 'a', amount: 29 },
      { loanId: 'b', amount: 50 },
      { loanId: 'c', amount: 1000 },
      { loanId: 'd', amount: 921 },
    ]);
  });

  it('sum never exceeds the lump', () => {
    const out = allocateRepayment(loans, 2000, 'smallest');
    const sum = out.reduce((a, x) => a + x.amount, 0);
    expect(sum).toBeCloseTo(2000, 2);
  });
});

describe('allocateRepayment — largest-first', () => {
  it('pours the lump into the biggest loan first', () => {
    const out = allocateRepayment(loans, 2000, 'largest');
    expect(out).toEqual([{ loanId: 'd', amount: 2000 }]);
  });
});

describe('allocateRepayment — oldest-first (FIFO)', () => {
  it('fills by creation order', () => {
    const out = allocateRepayment(loans, 80, 'oldest');
    expect(out).toEqual([
      { loanId: 'a', amount: 29 },
      { loanId: 'b', amount: 50 },
      { loanId: 'c', amount: 1 },
    ]);
  });
});

describe('allocateRepayment — newest-first (LIFO)', () => {
  it('fills by reverse creation order — the most recent loan clears first', () => {
    const out = allocateRepayment(loans, 6050, 'newest');
    expect(out).toEqual([
      { loanId: 'd', amount: 6000 },
      { loanId: 'c', amount: 50 },
    ]);
  });

  it('a lump smaller than the newest loan only touches the newest loan', () => {
    expect(allocateRepayment(loans, 100, 'newest')).toEqual([{ loanId: 'd', amount: 100 }]);
  });
});

describe('orderLoansForStrategy', () => {
  it('lists loans in the order the strategy fills them', () => {
    expect(orderLoansForStrategy(loans, 'newest').map((l) => l.id)).toEqual(['d', 'c', 'b', 'a']);
    expect(orderLoansForStrategy(loans, 'oldest').map((l) => l.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(orderLoansForStrategy(loans, 'smallest').map((l) => l.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(orderLoansForStrategy(loans, 'largest').map((l) => l.id)).toEqual(['d', 'c', 'b', 'a']);
  });

  it('does not mutate its input', () => {
    const copy = loans.map((l) => ({ ...l }));
    orderLoansForStrategy(loans, 'newest');
    expect(loans).toEqual(copy);
  });
});

describe('allocateRepayment — edges', () => {
  it('caps at total remaining when lump exceeds everything', () => {
    const out = allocateRepayment(loans, 999999, 'smallest');
    const sum = out.reduce((a, x) => a + x.amount, 0);
    expect(sum).toBeCloseTo(totalRemaining(loans), 2);
    expect(out).toHaveLength(4);
  });
  it('skips already-cleared loans', () => {
    const out = allocateRepayment(
      [{ id: 'x', remainingAmount: 0, createdAt: '2026-01-01' }, { id: 'y', remainingAmount: 100, createdAt: '2026-01-02' }],
      50,
      'smallest',
    );
    expect(out).toEqual([{ loanId: 'y', amount: 50 }]);
  });
  it('handles decimals without drift', () => {
    const out = allocateRepayment(
      [{ id: 'a', remainingAmount: 33.33, createdAt: '1' }, { id: 'b', remainingAmount: 66.67, createdAt: '2' }],
      50,
      'smallest',
    );
    expect(out).toEqual([
      { loanId: 'a', amount: 33.33 },
      { loanId: 'b', amount: 16.67 },
    ]);
  });
});

describe('previewAllocations', () => {
  it('one line per input loan in input order, with untouched loans at applied 0', () => {
    const allocations = allocateRepayment(loans, 80, 'oldest'); // a:29, b:50, c:1
    const lines = previewAllocations(loans, allocations);
    expect(lines).toEqual([
      { loanId: 'a', before: 29, applied: 29, after: 0, cleared: true },
      { loanId: 'b', before: 50, applied: 50, after: 0, cleared: true },
      { loanId: 'c', before: 1000, applied: 1, after: 999, cleared: false },
      { loanId: 'd', before: 6000, applied: 0, after: 6000, cleared: false },
    ]);
  });

  it('amount equal to the full total clears every line', () => {
    const allocations = allocateRepayment(loans, totalRemaining(loans), 'oldest');
    const lines = previewAllocations(loans, allocations);
    expect(lines.every((l) => l.cleared && l.after === 0)).toBe(true);
  });

  it('after-math stays at 2 dp', () => {
    const decimals: AllocatableLoan[] = [{ id: 'a', remainingAmount: 100.05, createdAt: '1' }];
    const lines = previewAllocations(decimals, [{ loanId: 'a', amount: 33.35 }]);
    expect(lines[0]).toEqual({ loanId: 'a', before: 100.05, applied: 33.35, after: 66.7, cleared: false });
  });

  it('an untouched zero-applied loan is never marked cleared', () => {
    const lines = previewAllocations([{ id: 'a', remainingAmount: 10, createdAt: '1' }], []);
    expect(lines[0].cleared).toBe(false);
  });
});
