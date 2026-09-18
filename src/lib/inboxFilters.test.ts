import { describe, expect, it } from 'vitest';
import {
  effectiveInboxFilter,
  inboxFilterCounts,
  inboxFilterOptions,
  matchesInboxFilter,
  showsContactAsks,
} from './inboxFilters';

const L = { kind: 'linked' as const };
const S = { kind: 'settlement' as const };

describe('inboxFilterCounts', () => {
  it('counts loans, payments and contact asks', () => {
    expect(inboxFilterCounts([L, L, S], 2)).toEqual({ all: 5, loans: 2, payments: 1, contacts: 2 });
  });
  it('is all zeros for an empty tab', () => {
    expect(inboxFilterCounts([], 0)).toEqual({ all: 0, loans: 0, payments: 0, contacts: 0 });
  });
  it('never goes negative on a bad contact count', () => {
    expect(inboxFilterCounts([L], -3).contacts).toBe(0);
  });
});

describe('inboxFilterOptions', () => {
  it('offers All + each present kind when two or more kinds exist', () => {
    expect(inboxFilterOptions(inboxFilterCounts([L, S], 1))).toEqual(['all', 'loans', 'payments', 'contacts']);
    expect(inboxFilterOptions(inboxFilterCounts([L, L, S], 0))).toEqual(['all', 'loans', 'payments']);
  });
  it('offers nothing when only one kind is present — a lone chip is noise', () => {
    expect(inboxFilterOptions(inboxFilterCounts([L, L, L], 0))).toEqual([]);
    expect(inboxFilterOptions(inboxFilterCounts([], 3))).toEqual([]);
    expect(inboxFilterOptions(inboxFilterCounts([], 0))).toEqual([]);
  });
});

describe('matchesInboxFilter / showsContactAsks', () => {
  it('routes each kind to its chip', () => {
    expect(matchesInboxFilter('linked', 'all')).toBe(true);
    expect(matchesInboxFilter('settlement', 'all')).toBe(true);
    expect(matchesInboxFilter('linked', 'loans')).toBe(true);
    expect(matchesInboxFilter('settlement', 'loans')).toBe(false);
    expect(matchesInboxFilter('settlement', 'payments')).toBe(true);
    expect(matchesInboxFilter('linked', 'payments')).toBe(false);
    expect(matchesInboxFilter('linked', 'contacts')).toBe(false);
  });
  it('shows contact asks only under All or Contacts', () => {
    expect(showsContactAsks('all')).toBe(true);
    expect(showsContactAsks('contacts')).toBe(true);
    expect(showsContactAsks('loans')).toBe(false);
    expect(showsContactAsks('payments')).toBe(false);
  });
});

describe('effectiveInboxFilter', () => {
  it('keeps a filter while its kind still has items', () => {
    expect(effectiveInboxFilter('payments', inboxFilterCounts([L, S], 0))).toBe('payments');
  });
  it('falls back to All once the kind empties out', () => {
    expect(effectiveInboxFilter('payments', inboxFilterCounts([L, L], 0))).toBe('all');
  });
  it('falls back to All when chips disappear (single kind left)', () => {
    expect(effectiveInboxFilter('loans', inboxFilterCounts([L], 0))).toBe('all');
  });
});
