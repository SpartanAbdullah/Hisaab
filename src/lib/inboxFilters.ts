// Inbox Incoming / Outgoing sub-filters — pure, tested in inboxFilters.test.ts.
//
// Both request tabs mix kinds: loan requests (linked_transaction_requests),
// payment/settlement requests (linked_settlement_requests) and, on Incoming,
// contact-link asks. With ten-plus items a single list gets hard to scan, so
// the list can be narrowed by kind. The chips only appear when there is a
// real choice to make (two or more kinds present) — a lone "All" chip is
// noise.

export type InboxFilter = 'all' | 'loans' | 'payments' | 'contacts';

/** The request kinds a list entry can be (InboxPage's InboxItem.kind). */
export type InboxEntryKind = 'linked' | 'settlement';

export interface InboxFilterCounts {
  all: number;
  loans: number;
  payments: number;
  contacts: number;
}

export function inboxFilterCounts(
  entries: ReadonlyArray<{ kind: InboxEntryKind }>,
  contactAskCount: number,
): InboxFilterCounts {
  let loans = 0;
  let payments = 0;
  for (const e of entries) {
    if (e.kind === 'linked') loans += 1;
    else payments += 1;
  }
  const contacts = Math.max(0, contactAskCount);
  return { all: loans + payments + contacts, loans, payments, contacts };
}

/** Which chips to offer, in display order. Empty when there is nothing to
 *  choose between (fewer than two kinds present). */
export function inboxFilterOptions(counts: InboxFilterCounts): InboxFilter[] {
  const kinds = (['loans', 'payments', 'contacts'] as const).filter((k) => counts[k] > 0);
  return kinds.length >= 2 ? ['all', ...kinds] : [];
}

export function matchesInboxFilter(kind: InboxEntryKind, filter: InboxFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'loans') return kind === 'linked';
  if (filter === 'payments') return kind === 'settlement';
  return false; // 'contacts' shows only the contact asks, which aren't entries
}

/** Contact asks render only under All or Contacts. */
export function showsContactAsks(filter: InboxFilter): boolean {
  return filter === 'all' || filter === 'contacts';
}

/** A filter whose kind has emptied out (an item was acted on, or the tab
 *  changed) falls back to All instead of stranding the user on nothing. */
export function effectiveInboxFilter(filter: InboxFilter, counts: InboxFilterCounts): InboxFilter {
  if (filter === 'all') return 'all';
  return counts[filter] > 0 && inboxFilterOptions(counts).length > 0 ? filter : 'all';
}
