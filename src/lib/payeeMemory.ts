// Payee memory — the manual-entry answer to a rules engine. Entry speed IS
// the product in a no-bank-sync app: when the user types a payee they've
// used before ("Careem", "K-Electric"), we already know the category and
// account they'll pick. Matching is EXACT on the normalized note text —
// prefix guessing risks silently filing money under the wrong head, which
// violates the record-reality philosophy. Pure + tested; the QuickEntry
// wiring stays in the component.
import { parseInternalNote } from './internalNotes';
import type { Transaction } from '../db';

export interface PayeeProfile {
  /** Most recent original spelling — what we display back. */
  payee: string;
  normalized: string;
  /** Most frequent category (ties break toward the most recent use). */
  category: string;
  /** Most recently used source account. */
  accountId: string | null;
  /** Median amount across uses, 2dp. */
  typicalAmount: number;
  /** Amount of the newest use — what the daily-close chips offer back. */
  lastAmount: number;
  count: number;
  lastUsedAt: string;
}

export function normalizePayee(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, ' ');
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const raw = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return Math.round(raw * 100) / 100;
}

/**
 * Build payee profiles from the user's own expense history. Group-linked
 * mirrors are excluded (their notes carry group meta and their categories
 * belong to the group's context, not the personal ledger's habits).
 */
export function buildPayeeProfiles(transactions: Transaction[]): Map<string, PayeeProfile> {
  const groups = new Map<string, Transaction[]>();
  for (const txn of transactions) {
    if (txn.type !== 'expense') continue;
    const parsed = parseInternalNote(txn.notes);
    if (parsed.meta.groupExpenseId) continue;
    const normalized = normalizePayee(parsed.visibleNote);
    if (normalized.length < 3) continue;
    const list = groups.get(normalized) ?? [];
    list.push(txn);
    groups.set(normalized, list);
  }

  const profiles = new Map<string, PayeeProfile>();
  for (const [normalized, txns] of groups) {
    // Need at least 2 uses before we presume a habit — one entry is a
    // coincidence, two is a pattern.
    if (txns.length < 2) continue;
    const sorted = [...txns].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const categoryCounts = new Map<string, number>();
    for (const txn of txns) {
      const cat = txn.category ?? '';
      if (!cat) continue;
      categoryCounts.set(cat, (categoryCounts.get(cat) ?? 0) + 1);
    }
    let category = '';
    let best = 0;
    // Iterate newest-first so ties resolve toward the most recent habit.
    for (const txn of sorted) {
      const cat = txn.category ?? '';
      if (!cat) continue;
      const n = categoryCounts.get(cat) ?? 0;
      if (n > best) {
        best = n;
        category = cat;
      }
    }
    profiles.set(normalized, {
      payee: parseInternalNote(sorted[0].notes).visibleNote.trim(),
      normalized,
      category,
      accountId: sorted.find((txn) => txn.sourceAccountId)?.sourceAccountId ?? null,
      typicalAmount: median(txns.map((txn) => txn.amount)),
      lastAmount: sorted[0].amount,
      count: txns.length,
      lastUsedAt: sorted[0].createdAt,
    });
  }
  return profiles;
}

/** Exact-normalized lookup; null for empty/too-short input. */
export function matchPayee(profiles: Map<string, PayeeProfile>, typed: string): PayeeProfile | null {
  const normalized = normalizePayee(typed);
  if (normalized.length < 3) return null;
  return profiles.get(normalized) ?? null;
}

/**
 * Past personal expenses of this payee filed under a DIFFERENT category —
 * the candidates for the "apply to N past entries too?" bulk re-file.
 */
export function mismatchedTxnIds(
  transactions: Transaction[],
  normalizedPayee: string,
  newCategory: string,
): string[] {
  const ids: string[] = [];
  for (const txn of transactions) {
    if (txn.type !== 'expense') continue;
    const parsed = parseInternalNote(txn.notes);
    if (parsed.meta.groupExpenseId) continue;
    if (normalizePayee(parsed.visibleNote) !== normalizedPayee) continue;
    if ((txn.category ?? '') === newCategory) continue;
    ids.push(txn.id);
  }
  return ids;
}
