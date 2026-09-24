// Distribute a single lump repayment across several individual loans with one
// person (same currency + direction). The net effect on balances is identical
// to one big repayment — this only changes WHICH loans clear, so a user can
// wipe out the small ones first instead of only chipping the largest. Pure so
// it can be unit-tested and reused; the UI loops the existing single-loan
// repayment for each returned allocation.

// 'newest' (LIFO) was added 2026-09-24: the founder wanted a lump to clear the
// most recent loan first and had to type per-loan amounts by hand to do it.
export type AllocationStrategy = 'smallest' | 'largest' | 'oldest' | 'newest';

export interface AllocatableLoan {
  id: string;
  remainingAmount: number;
  createdAt: string;
}

export interface Allocation {
  loanId: string;
  amount: number; // > 0, never exceeds the loan's remaining
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// The order a strategy fills loans in. Exported so a preview can list the
// loans in fill order (a newest-first lump reads top-down, like oldest-first).
export function orderLoansForStrategy<T extends AllocatableLoan>(
  loans: T[],
  strategy: AllocationStrategy,
): T[] {
  return loans.slice().sort((a, b) => {
    if (strategy === 'smallest') return a.remainingAmount - b.remainingAmount || a.createdAt.localeCompare(b.createdAt);
    if (strategy === 'largest') return b.remainingAmount - a.remainingAmount || a.createdAt.localeCompare(b.createdAt);
    if (strategy === 'newest') return b.createdAt.localeCompare(a.createdAt); // newest first (LIFO)
    return a.createdAt.localeCompare(b.createdAt); // oldest first (FIFO)
  });
}

// Greedily fill loans in the strategy's order until the lump runs out, never
// over-paying a loan. Returns only loans that receive a positive amount, in
// fill order. The sum equals min(lump, total remaining), to 2 dp.
export function allocateRepayment(
  loans: AllocatableLoan[],
  lump: number,
  strategy: AllocationStrategy,
): Allocation[] {
  const order = orderLoansForStrategy(loans.filter((l) => l.remainingAmount > 0.001), strategy);

  let pool = round2(lump);
  const out: Allocation[] = [];
  for (const loan of order) {
    if (pool <= 0.001) break;
    const amount = round2(Math.min(round2(loan.remainingAmount), pool));
    if (amount <= 0) continue;
    out.push({ loanId: loan.id, amount });
    pool = round2(pool - amount);
  }
  return out;
}

// Total remaining across a set of loans (2 dp).
export function totalRemaining(loans: AllocatableLoan[]): number {
  return round2(loans.reduce((a, l) => a + Math.max(0, l.remainingAmount), 0));
}

export interface AllocationPreviewLine {
  loanId: string;
  before: number;
  applied: number; // 0 when untouched
  after: number;
  cleared: boolean;
}

// Per-loan before/after math for the breakdown shown before a lump commits.
// One line per input loan, input order preserved, so the UI can render the
// full group including loans the pool never reached.
export function previewAllocations(
  loans: AllocatableLoan[],
  allocations: Allocation[],
): AllocationPreviewLine[] {
  const byId = new Map(allocations.map((a) => [a.loanId, a.amount]));
  return loans.map((l) => {
    const before = round2(l.remainingAmount);
    const applied = round2(byId.get(l.id) ?? 0);
    const after = round2(Math.max(0, before - applied));
    return { loanId: l.id, before, applied, after, cleared: applied > 0 && after <= 0.001 };
  });
}
