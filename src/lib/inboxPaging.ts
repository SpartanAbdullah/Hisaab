// Inbox Incoming / Outgoing paging — pure, tested in inboxPaging.test.ts.
//
// WHY (founder, 2026-09-19): a long-connected pair of users piles up hundreds
// — for an active account, thousands — of settled requests, and both request
// tabs painted every one of them on open: a full card each, with its contact,
// account and WhatsApp-link lookups. Outgoing got slow, and the one or two asks
// that still wait were a scroll away from everything else.
//
// The rule is the one listPaging.ts applies to the transaction history — what
// still needs someone is always on screen; history shows its newest few and the
// rest is one explicit tap away:
//
//   * PENDING entries are never paged. Something still waiting, on you or on
//     the other side, must never sit behind a button.
//   * SETTLED history (accepted / rejected / cancelled) shows the newest
//     INBOX_HISTORY_INITIAL, then INBOX_HISTORY_STEP more per "Show more".
//   * Paging runs on the list AFTER the type filter (inboxFilters.ts), and a
//     different list — another tab or another filter — starts again at the
//     first page: InboxPage mounts one list per inboxPagingKey, so React
//     drops the old list's paging with it.
//
// Only the RENDER is bounded. The stores still hold every request: sync-past-
// records, loan-pair linkage, the bell and the notification reconcile all read
// the full lists (see linkedRequestStore / settlementRequestStore).

export const INBOX_HISTORY_INITIAL = 10;
export const INBOX_HISTORY_STEP = 20;

/** The minimum an entry needs for paging: InboxPage's `{ kind, item }`. */
export interface PageableInboxEntry {
  item: { status: string };
}

export interface InboxPagedList<T> {
  /** Every pending entry, in input order. Never paged. */
  pending: T[];
  /** The settled entries to render, in input order (the page sorts newest first). */
  history: T[];
  /** Settled entries in the list, rendered or not: the "M" of "N of M". */
  historyTotal: number;
  /** Settled entries still behind "Show more". */
  hiddenHistory: number;
  /** How many one "Show more" tap reveals. 0 means there is no button. */
  nextStep: number;
}

/** Normalise a history limit: whole, never negative; nonsense means "first page". */
function safeLimit(limit: number): number {
  if (!Number.isFinite(limit)) return INBOX_HISTORY_INITIAL;
  return Math.max(0, Math.floor(limit));
}

/** Normalise a page step: whole and at least 1; nonsense means the default. */
function safeStep(step: number): number {
  if (!Number.isFinite(step)) return INBOX_HISTORY_STEP;
  return Math.max(1, Math.floor(step));
}

/**
 * Split an (already filtered, already sorted) request list into the pending
 * block, which is always shown whole, and the first `historyLimit` settled
 * entries. Input order is kept inside each group.
 */
export function pageInboxEntries<T extends PageableInboxEntry>(
  entries: readonly T[],
  historyLimit: number,
  step: number = INBOX_HISTORY_STEP,
): InboxPagedList<T> {
  const pending: T[] = [];
  const settled: T[] = [];
  for (const entry of entries) {
    if (entry.item.status === 'pending') pending.push(entry);
    else settled.push(entry);
  }
  const history = settled.slice(0, safeLimit(historyLimit));
  const hiddenHistory = settled.length - history.length;
  return {
    pending,
    history,
    historyTotal: settled.length,
    hiddenHistory,
    nextStep: Math.min(safeStep(step), hiddenHistory),
  };
}

/**
 * Name of the list being paged: one per tab + type-filter pair. InboxPage uses
 * it as the React key of the paged list, so switching tab or filter mounts a
 * fresh list on its first page — and coming back does too.
 */
export function inboxPagingKey(tab: string, filter: string): string {
  return `${tab}:${filter}`;
}

/**
 * The limit after one more "Show more" tap. Grows only, and never past what
 * the list can fill, so tapping on the last page is a no-op rather than an
 * unbounded counter (the same rule as listPaging.nextPageCount).
 */
export function nextHistoryLimit(
  current: number,
  historyTotal: number,
  step: number = INBOX_HISTORY_STEP,
): number {
  const base = safeLimit(current);
  const total = Number.isFinite(historyTotal) ? Math.max(0, Math.floor(historyTotal)) : 0;
  if (base >= total) return base;
  return Math.min(base + safeStep(step), total);
}
