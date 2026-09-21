import { describe, expect, it } from 'vitest';
import {
  INBOX_HISTORY_INITIAL,
  INBOX_HISTORY_STEP,
  inboxPagingKey,
  nextHistoryLimit,
  pageInboxEntries,
} from './inboxPaging';
import { matchesInboxFilter, type InboxEntryKind } from './inboxFilters';

type Status = 'pending' | 'accepted' | 'rejected' | 'cancelled';
interface Entry {
  kind: InboxEntryKind;
  item: { id: string; status: Status };
}

function entries(count: number, status: Status, kind: InboxEntryKind = 'linked', prefix = status): Entry[] {
  return Array.from({ length: count }, (_, i) => ({ kind, item: { id: `${prefix}-${kind}-${i}`, status } }));
}
const ids = (list: Entry[]) => list.map((e) => e.item.id);

describe('pageInboxEntries', () => {
  it('always returns every pending entry, however many there are', () => {
    const list = [...entries(25, 'pending'), ...entries(40, 'accepted')];
    const page = pageInboxEntries(list, INBOX_HISTORY_INITIAL);
    expect(page.pending).toHaveLength(25);
    expect(page.history).toHaveLength(INBOX_HISTORY_INITIAL);
  });

  it('caps settled history at the limit, keeping the input (newest-first) order', () => {
    const settled = entries(128, 'accepted');
    const page = pageInboxEntries(settled, 10);
    expect(ids(page.history)).toEqual(ids(settled.slice(0, 10)));
    expect(page.historyTotal).toBe(128);
    expect(page.hiddenHistory).toBe(118);
    expect(page.nextStep).toBe(INBOX_HISTORY_STEP);
  });

  it('counts accepted, rejected and cancelled all as history', () => {
    const list = [
      ...entries(1, 'pending'),
      ...entries(2, 'accepted'),
      ...entries(3, 'rejected'),
      ...entries(4, 'cancelled'),
    ];
    const page = pageInboxEntries(list, 100);
    expect(page.pending).toHaveLength(1);
    expect(page.historyTotal).toBe(9);
    expect(page.hiddenHistory).toBe(0);
  });

  it('keeps pending first even when the input interleaves statuses', () => {
    const list: Entry[] = [
      { kind: 'linked', item: { id: 'a', status: 'accepted' } },
      { kind: 'settlement', item: { id: 'p1', status: 'pending' } },
      { kind: 'linked', item: { id: 'r', status: 'rejected' } },
      { kind: 'linked', item: { id: 'p2', status: 'pending' } },
    ];
    const page = pageInboxEntries(list, 10);
    expect(ids(page.pending)).toEqual(['p1', 'p2']);
    expect(ids(page.history)).toEqual(['a', 'r']);
  });

  it('offers only what is left on the last page, and no button once everything shows', () => {
    const settled = entries(35, 'accepted');
    expect(pageInboxEntries(settled, 30).nextStep).toBe(5);
    const all = pageInboxEntries(settled, 35);
    expect(all.hiddenHistory).toBe(0);
    expect(all.nextStep).toBe(0);
    // A limit past the end is harmless.
    expect(pageInboxEntries(settled, 500).history).toHaveLength(35);
  });

  it('shows no button for a list with no history at all', () => {
    const page = pageInboxEntries(entries(4, 'pending'), INBOX_HISTORY_INITIAL);
    expect(page.history).toEqual([]);
    expect(page.historyTotal).toBe(0);
    expect(page.nextStep).toBe(0);
  });

  it('is total on nonsense limits: negative shows no history, NaN means the first page', () => {
    const settled = entries(30, 'cancelled');
    expect(pageInboxEntries(settled, -5).history).toHaveLength(0);
    expect(pageInboxEntries(settled, Number.NaN).history).toHaveLength(INBOX_HISTORY_INITIAL);
    expect(pageInboxEntries(settled, 12.9).history).toHaveLength(12);
  });

  it('pages AFTER the type filter, so a filter shows its own first page', () => {
    const list = [
      ...entries(2, 'pending', 'settlement'),
      ...entries(15, 'accepted', 'linked'),
      ...entries(15, 'accepted', 'settlement'),
    ];
    const loans = list.filter((e) => matchesInboxFilter(e.kind, 'loans'));
    const loansPage = pageInboxEntries(loans, INBOX_HISTORY_INITIAL);
    expect(loansPage.pending).toHaveLength(0);
    expect(loansPage.historyTotal).toBe(15);
    expect(loansPage.history.every((e) => e.kind === 'linked')).toBe(true);

    const payments = list.filter((e) => matchesInboxFilter(e.kind, 'payments'));
    const paymentsPage = pageInboxEntries(payments, INBOX_HISTORY_INITIAL);
    expect(paymentsPage.pending).toHaveLength(2);
    expect(paymentsPage.historyTotal).toBe(15);
    expect(paymentsPage.history).toHaveLength(INBOX_HISTORY_INITIAL);
  });
});

describe('inboxPagingKey', () => {
  // The paged list is keyed on this, so a distinct key per tab + filter is
  // what makes switching either one reset the paging.
  it('names each tab + filter pair distinctly', () => {
    expect(inboxPagingKey('incoming', 'loans')).not.toBe(inboxPagingKey('outgoing', 'loans'));
    expect(inboxPagingKey('incoming', 'loans')).not.toBe(inboxPagingKey('incoming', 'payments'));
    expect(inboxPagingKey('outgoing', 'all')).toBe(inboxPagingKey('outgoing', 'all'));
  });
});

describe('nextHistoryLimit', () => {
  it('reveals one step more per tap', () => {
    expect(nextHistoryLimit(INBOX_HISTORY_INITIAL, 128)).toBe(INBOX_HISTORY_INITIAL + INBOX_HISTORY_STEP);
    expect(nextHistoryLimit(30, 128)).toBe(50);
  });

  it('stops at the end of the list instead of counting past it', () => {
    expect(nextHistoryLimit(110, 128)).toBe(128);
    expect(nextHistoryLimit(128, 128)).toBe(128);
  });

  it('never shrinks, even when the list got shorter underneath', () => {
    expect(nextHistoryLimit(50, 20)).toBe(50);
    expect(nextHistoryLimit(10, 0)).toBe(10);
  });

  it('walks a long list to the end in whole steps', () => {
    let limit = INBOX_HISTORY_INITIAL;
    let taps = 0;
    while (pageInboxEntries(entries(128, 'accepted'), limit).nextStep > 0) {
      limit = nextHistoryLimit(limit, 128);
      taps += 1;
    }
    expect(limit).toBe(128);
    expect(taps).toBe(6); // 10 → 30 → 50 → 70 → 90 → 110 → 128
  });
});
