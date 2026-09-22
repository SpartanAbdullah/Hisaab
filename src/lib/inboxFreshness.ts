// Stale-while-revalidate plan for opening the Inbox (backlog 2026-09-22 item 8a).
//
// The Inbox used to re-run ~14 store loads (requests, settlements, contact
// asks, notifications, persons, budgets, transactions, templates, accounts,
// upcoming expenses, loans, EMIs, kameti, blocks) on EVERY mount, and started
// each visit in a 'loading' state — so an empty tab flashed a skeleton before
// its empty state, and the smart-landing tab jump waited for the network.
//
// Everything it reads is already kept fresh elsewhere: boot loads the
// cross-user surfaces (App.tsx), realtime reloads them on change, and
// `resumeGlobalRealtime` refetches them after the app was backgrounded. So a
// REVISIT only needs to show what the stores hold and, if the last full Inbox
// load is older than the window below, refresh once in the background.
//
//   'cold'        — never loaded this session: full load, skeleton while empty.
//   'revalidate'  — loaded before but stale: render cached rows now, reload
//                   in the background (no skeleton, no status flip).
//   'fresh'       — loaded within the window: render cached rows, no fetch.
//
// Mode-independent: the plan only decides WHEN the same loaders run; it reads
// no account, so full_tracker and splits_only behave identically.

export type InboxLoadPlan = 'cold' | 'revalidate' | 'fresh';

/** How long a completed Inbox load counts as fresh. Realtime + resume cover
 *  the cross-user rows inside this window; it mainly spares a quick
 *  Inbox → Home → Inbox hop from re-downloading everything. */
export const INBOX_FRESH_MS = 30_000;

export function planInboxLoad(
  lastLoadedAt: number | null,
  now: number,
  freshMs: number = INBOX_FRESH_MS,
): InboxLoadPlan {
  if (lastLoadedAt === null || !Number.isFinite(lastLoadedAt)) return 'cold';
  const age = now - lastLoadedAt;
  // A clock that moved backwards cannot prove freshness — revalidate.
  if (age < 0) return 'revalidate';
  return age < freshMs ? 'fresh' : 'revalidate';
}
