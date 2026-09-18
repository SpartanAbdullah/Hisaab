// What the bell is allowed to count.
//
// THE BUG THIS FILE EXISTS FOR — audit 08-notifications.md N-7:
//
//   "`InboxAction` counts pending requests where the user is sender OR
//    receiver (`InboxAction.tsx:18-33`: `r.toUserId === userId ||
//    r.fromUserId === userId`), then pulses a halo and rings the bell icon
//    whenever the count is nonzero. A user who sends one loan request to a
//    slow-to-respond cousin sees a red animated badge for days with nothing
//    to act on — the exact 'counter stays at 1' anxiety the codebase fought
//    elsewhere."
//
// The same class of mistake lived one layer down in `notificationStore`,
// which counted `!readAt` over every loaded row — so a row the user caused
// themselves, or one from a group they have since muted, still lit the badge.
//
// The rule, in one sentence: a badge is a PROMISE THAT SOMETHING NEEDS YOU.
// It may only count things that are (a) inbound — someone else's action,
// aimed at this user, (b) unread, and (c) not silenced by that user's own
// notification preferences. Outgoing pending requests are real and belong in
// the Outgoing tab's own count (InboxPage.tsx already computes that
// separately); they are not attention.
//
// Everything here is pure so it can be unit-tested without a store, a DOM, or
// a database — the repo's testing philosophy (vitest.config.ts header).

import type { AppNotification } from '../db';

/** The subset of the user's notification preferences that affects counting.
 *  Mirrors `notification_prefs` rows
 *  (supabase-migration-p2-notification-maturity.sql §2): one global entry
 *  plus zero or more per-group ones. */
export interface NotificationMuteState {
  /** True when the user muted EVERYTHING (the global row with muted = true). */
  allMuted?: boolean;
  /** Group ids the user has muted individually. */
  mutedGroupIds?: ReadonlySet<string> | readonly string[];
}

function isMuted(n: AppNotification, mutes?: NotificationMuteState): boolean {
  if (!mutes) return false;
  if (mutes.allMuted) return true;
  if (!n.groupId) return false;
  const ids = mutes.mutedGroupIds;
  if (!ids) return false;
  if (Array.isArray(ids)) return ids.includes(n.groupId);
  return (ids as ReadonlySet<string>).has(n.groupId);
}

/** Is this row something the reader has to be told about?
 *
 *  A notification row is always addressed to its `userId` — the server never
 *  writes one to the actor (fan_out_group_notification skips
 *  `gm.profile_id IS DISTINCT FROM p_actor`). But the linked-request triggers
 *  DO notify the SENDER of an outcome ("Ali confirmed the shared loan"), and
 *  the group fan-out's rate limit or a future writer could regress the
 *  actor-skip. `actorId === self` is therefore checked here as a floor: if
 *  you caused it, it is not news to you.
 *
 *  Exported so the store, the Activity tab and any future surface all agree
 *  on one definition of "counts". */
export function isAttentionNotification(
  n: AppNotification,
  selfUserId?: string | null,
  mutes?: NotificationMuteState,
): boolean {
  if (n.readAt) return false;
  if (selfUserId && n.actorId && n.actorId === selfUserId) return false;
  if (isMuted(n, mutes)) return false;
  return true;
}

/** How many unread notifications deserve the badge.
 *
 *  Replaces `notifications.filter(n => !n.readAt).length`, which counted
 *  self-caused rows and rows from muted groups. */
export function countAttentionNotifications(
  notifications: readonly AppNotification[],
  selfUserId?: string | null,
  mutes?: NotificationMuteState,
): number {
  let count = 0;
  for (const n of notifications) {
    if (isAttentionNotification(n, selfUserId, mutes)) count += 1;
  }
  return count;
}

/** Notification types that MIRROR a row the bell already counts as a pending
 *  request.
 *
 *  `linked_request` / `linked_settlement` rows are the *ping about* a
 *  `linked_transaction_requests` / `linked_settlement_requests` row
 *  (`tg_ltr_notify` / `tg_lsr_notify`,
 *  supabase-migration-linked-notifications-realtime.sql). The request row
 *  itself is counted by `countIncomingPending`, so counting the ping too would
 *  show 2 for one loan — and worse, the ping stays UNREAD after the user
 *  accepts while the request leaves `pending`, so the badge could never reach
 *  zero (the "counter stays at 1" bug the store fights in `locallyRead`).
 *
 *  The request row is the honest one: it clears the instant you act. */
export function isRequestMirrorNotification(n: AppNotification): boolean {
  return n.type === 'linked_request' || n.type === 'linked_settlement';
}

/** Unread notifications the BELL is allowed to count: every attention row that
 *  is not already represented by a pending request (see
 *  `isRequestMirrorNotification`).
 *
 *  THE BUG THIS EXISTS FOR (founder report 2026-09-03, "my bell isn't alerting
 *  me anymore if there are any unread notifications"): the bell's notification
 *  term was `isInboxInfoNotification` — an ALLOW-list of four types, two of
 *  which (`invite`, `system`) no writer in the product ever produces (audit
 *  08-notifications.md §1.1). So the single highest-volume notification in the
 *  app — `group_update`, the group fan-out — never lit the bell at all, and a
 *  user with hundreds of unread rows saw nothing. Deny-listing the two
 *  request mirrors instead of allow-listing four types means every NEW
 *  notification type is counted by default, which is the safe direction for a
 *  badge whose job is "something is waiting for you".
 *
 *  Everything the Inbox "Info" tab lists is exactly this set minus the
 *  self/mute filters (`isInboxInfoNotification` in inboxInfo.ts shares this
 *  predicate), so every counted row has a place the user can open and clear. */
export function countBellNotifications(
  notifications: readonly AppNotification[],
  selfUserId?: string | null,
  mutes?: NotificationMuteState,
): number {
  let count = 0;
  for (const n of notifications) {
    if (isRequestMirrorNotification(n)) continue;
    if (isAttentionNotification(n, selfUserId, mutes)) count += 1;
  }
  return count;
}

/** The shape both `linkedRequestStore` and `settlementRequestStore` rows
 *  share, reduced to what a badge needs. */
export interface BadgeRequest {
  status: string;
  toUserId?: string | null;
  fromUserId?: string | null;
}

/** Pending requests that need THIS user to decide. The N-7 fix: `fromUserId`
 *  matches are dropped, so a request you SENT never rings your own bell.
 *
 *  Use `countOutgoingPending` for the Outgoing tab — outgoing items are worth
 *  showing, just not worth alarming about. */
export function countIncomingPending(
  requests: readonly BadgeRequest[],
  userId: string,
): number {
  if (!userId) return 0;
  let count = 0;
  for (const r of requests) {
    if (r.status === 'pending' && r.toUserId === userId) count += 1;
  }
  return count;
}

/** Pending requests this user is waiting on someone else for. Belongs in the
 *  Outgoing tab count, never in the attention badge. */
export function countOutgoingPending(
  requests: readonly BadgeRequest[],
  userId: string,
): number {
  if (!userId) return 0;
  let count = 0;
  for (const r of requests) {
    if (r.status === 'pending' && r.fromUserId === userId && r.toUserId !== userId) count += 1;
  }
  return count;
}

/** Everything the home-header bell (`InboxAction`) counts, in one place. */
export interface BellCountInput {
  /** The loaded slice of the `notifications` table (newest 100). */
  notifications: readonly AppNotification[];
  /** `linked_transaction_requests` rows for this user, both directions. */
  linkedRequests: readonly BadgeRequest[];
  /** `linked_settlement_requests` rows for this user, both directions. */
  settlementRequests: readonly BadgeRequest[];
  /** `contact_link_requests` — "X added you, add them back?" asks. */
  contactLinkRequests: readonly BadgeRequest[];
  /** The signed-in user. '' while signing in / booting ⇒ no request counts. */
  userId: string;
  mutes?: NotificationMuteState;
}

/** What the bell has to show, split by who it is waiting on. */
export interface BellState {
  /** Needs THIS user: incoming pending requests + unread notifications.
   *  Drives the red number badge. */
  actionable: number;
  /** This user is waiting on SOMEONE ELSE: their own outgoing pending
   *  requests. Drives a quiet neutral dot — never a red number. */
  waiting: number;
  /** What the bell's red number shows: `actionable + waiting`. Founder
   *  decision 2026-09-18 — the red counter counts everything still open,
   *  including the user's own outgoing requests (reverses the 4840d6f split,
   *  which left the founder's bell with no number at all). The two parts stay
   *  separate for the Inbox copy and the a11y label. */
  total: number;
}

/** The bell badge, split.
 *
 *  `actionable` — two kinds of thing, both of which the /inbox destination
 *  shows and the user can clear there:
 *    1. requests waiting on a DECISION from this user (Incoming tab), and
 *    2. unread notifications that are not a mirror of (1) (Info tab).
 *
 *  `waiting` — outgoing pending requests. Audit N-7 kept these off the red
 *  number and 4840d6f gave them a quiet dot instead — which left the founder's
 *  bell showing no number at all (production: 5 outgoing loan requests + 3
 *  outgoing settlements, nothing incoming). Founder decision 2026-09-18: the
 *  red counter is `total` = actionable + waiting, so every open request is
 *  counted. The split is kept for the Inbox "Waiting on others" copy and the
 *  a11y label, which still say which side the items are on.
 *
 *  Deliberately NOT counted anywhere: the derived To-do queue
 *  (`buildInboxActionItems`), which has never been part of this badge and
 *  would make the bell depend on half a dozen full-tracker-only stores.
 *
 *  Known, pre-existing overlap: a contact ask writes BOTH a pending
 *  `contact_link_requests` row and a `contact_linked` notification to the same
 *  user (supabase-migration-connections-push-discovery.sql:150-178), so one
 *  ask can count twice. The notification carries no request id, so there is no
 *  key to de-duplicate on; acting on the ask and reading the ping both drive
 *  the number down, and it still reaches zero. */
export function countBellItems(input: BellCountInput): BellState {
  const actionable =
    countIncomingPending(input.linkedRequests, input.userId) +
    countIncomingPending(input.settlementRequests, input.userId) +
    countIncomingPending(input.contactLinkRequests, input.userId) +
    // `|| null`: an empty id means "not signed in yet", not "the actor is ''".
    countBellNotifications(input.notifications, input.userId || null, input.mutes);
  const waiting =
    countOutgoingPending(input.linkedRequests, input.userId) +
    countOutgoingPending(input.settlementRequests, input.userId);
  return { actionable, waiting, total: actionable + waiting };
}

/** Whole days a request has been waiting, local-calendar style (a request sent
 *  last night is "1 day", not "0"). Negative clock skew clamps to 0, and an
 *  unparseable timestamp returns null so the caller can just omit the line.
 *
 *  Feeds the Inbox "Waiting on others" section: "who / what" are already on the
 *  card, "how long" is the part that tells the user whether to nudge. */
export function daysWaiting(createdAtIso: string, now: Date): number | null {
  const at = Date.parse(createdAtIso);
  if (!Number.isFinite(at)) return null;
  const then = new Date(at);
  const startOfThen = new Date(then.getFullYear(), then.getMonth(), then.getDate()).getTime();
  const startOfNow = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const days = Math.round((startOfNow - startOfThen) / 86_400_000);
  return days > 0 ? days : 0;
}

// ── Stale request mirrors ──────────────────────────────────────────────────
// Production, the founder's account: 38 unread `linked_request` + 35 unread
// `linked_settlement` notifications, against ZERO pending incoming requests.
// Every one of those pings is dead: it is either an outcome notice the
// triggers send the SENDER ("Shared loan confirmed",
// supabase-migration-linked-notifications-realtime.sql:58-63, 102-107) — whose
// request left `pending` at the moment it was written — or a request ping the
// user already acted on. Nothing in the app can ever clear them: the Inbox
// Info tab excludes mirrors and the card they refer to is gone. That is the
// "counter stays at 1" family, 73 rows deep, and it keeps `unreadCount` (the
// Activity tab's number) permanently wrong.
//
// The rows carry NO request id — `tg_ltr_notify` inserts `event_id` null and
// no params — so staleness is inferred from the pending set instead:
//
//   an unread mirror is STALE unless a request of the same kind, still
//   pending and addressed to this user, was created within `windowMs` of it.
//
// The trigger writes its notification inside the request's own INSERT
// transaction, so a live pair's timestamps agree to well under a second; the
// default window is minutes wide, which errs toward LEAVING a row unread. When
// nothing of that kind is pending — the founder's case — every mirror of that
// kind is stale, which is the invariant this is really for: if nothing of a
// kind is waiting on you, no ping of that kind may still be unread.

/** Minutes, not seconds: generous on purpose. A false "stale" hides a real
 *  request ping; a false "live" just leaves one row unread until next time. */
export const MIRROR_STALE_WINDOW_MS = 5 * 60 * 1000;

export interface MirrorReconcileInput {
  notifications: readonly AppNotification[];
  /** Pending-or-not `linked_transaction_requests` rows, both directions. */
  linkedRequests: readonly (BadgeRequest & { createdAt?: string })[];
  /** Pending-or-not `linked_settlement_requests` rows, both directions. */
  settlementRequests: readonly (BadgeRequest & { createdAt?: string })[];
  userId: string;
  windowMs?: number;
}

function pendingIncomingTimes(
  requests: readonly (BadgeRequest & { createdAt?: string })[],
  userId: string,
): number[] {
  const times: number[] = [];
  for (const r of requests) {
    if (r.status !== 'pending' || r.toUserId !== userId) continue;
    const at = Date.parse(r.createdAt ?? '');
    // A pending request with an unreadable timestamp still protects its ping —
    // NaN here would silently turn "live" into "stale".
    times.push(Number.isFinite(at) ? at : Number.NaN);
  }
  return times;
}

function hasLiveMatch(times: readonly number[], at: number, windowMs: number): boolean {
  for (const t of times) {
    if (!Number.isFinite(t) || !Number.isFinite(at)) return true; // can't tell ⇒ keep
    if (Math.abs(t - at) <= windowMs) return true;
  }
  return false;
}

/** Ids of unread request-mirror notifications whose request is no longer
 *  pending. Pure, order-preserving, and empty when there is nothing to do —
 *  the caller uses that to skip the write entirely. */
export function staleMirrorNotificationIds(input: MirrorReconcileInput): string[] {
  if (!input.userId) return [];
  const windowMs = input.windowMs ?? MIRROR_STALE_WINDOW_MS;
  const linkedTimes = pendingIncomingTimes(input.linkedRequests, input.userId);
  const settlementTimes = pendingIncomingTimes(input.settlementRequests, input.userId);
  const ids: string[] = [];
  for (const n of input.notifications) {
    if (n.readAt) continue;
    if (!isRequestMirrorNotification(n)) continue;
    const times = n.type === 'linked_request' ? linkedTimes : settlementTimes;
    if (times.length === 0) { ids.push(n.id); continue; }
    if (!hasLiveMatch(times, Date.parse(n.createdAt), windowMs)) ids.push(n.id);
  }
  return ids;
}
