// Renders a persisted notification row into display text.
//
// Group notifications used to be composed on the ACTOR's device and frozen as
// English `title`/`body` at write time (splitStore's fanOutGroupUpdate) — which
// meant (a) any co-member could write whatever text they liked into your Inbox
// and your push tray (audit 05-security.md H5), and (b) an Urdu-default app
// shipped its highest-traffic cross-user surface in English only (audit
// 08-notifications.md N-1).
//
// Server triggers now write a `template` key plus structured `params`
// (supabase-migration-audit-p0-notifications.sql) alongside a server-composed
// English `title`/`body`. This module turns template+params into localized
// copy; the stored title/body remain the fallback for legacy rows, for
// templates a newer server knows and this client doesn't, and for the FCM push
// pipeline (which renders server text verbatim and cannot run this code).
//
// Pure: no store reads, no DOM. The translator is injected so both the React
// (useT) and non-React (tStatic) callers work, and so it is unit-testable.

import type { I18nKey } from './i18n';
import { formatMoney } from './constants';

export interface NotificationContentInput {
  template?: string | null;
  params?: Record<string, unknown> | null;
  title?: string | null;
  body?: string | null;
}

export interface NotificationContent {
  title: string;
  body: string;
}

export type NotificationTranslate = (key: I18nKey) => string;

// Must stay in step with the catalog in
// supabase-migration-audit-p0-notifications.sql (SECTION 3).
const TITLE_KEYS: Record<string, I18nKey> = {
  group_added: 'ntf_group_added_title',
  member_joined: 'ntf_member_joined_title',
  // tg_group_members_notify_left, supabase-migration-p2-notification-
  // maturity.sql §5b. Params: { groupId, groupName, memberId, memberName,
  // actorName }. Audit N-11: members used to discover a departure silently.
  member_left: 'ntf_member_left_title',
  // notify_committee_members, same migration §6. Params: { committeeId,
  // committeeName, currency, amount, round, slot, memberName }.
  kameti_draw_completed: 'ntf_kameti_draw_title',
  kameti_round_due: 'ntf_kameti_round_due_title',
  kameti_payout_due: 'ntf_kameti_payout_title',
  expense_added: 'ntf_expense_added_title',
  expense_updated: 'ntf_expense_updated_title',
  expense_deleted: 'ntf_expense_deleted_title',
  settlement_added: 'ntf_settlement_added_title',
  settlement_deleted: 'ntf_settlement_deleted_title',
  // notify_group_archive_state, supabase-migration-audit-p0-group-deletion-
  // guard.sql §6a. Params: { groupId, groupName, currency, actorName }.
  group_archived: 'ntf_group_archived_title',
  group_unarchived: 'ntf_group_unarchived_title',
  // _lsr_notify_info, supabase-migration-settlement-receiver-records.sql §3.
  // type 'linked_info'. Params: { actorName, amount, currency, requestId }.
  lsr_recorded: 'ntf_lsr_recorded_title',
  lsr_undone: 'ntf_lsr_undone_title',
};

const BODY_KEYS: Record<string, I18nKey> = {
  group_added: 'ntf_group_added_body',
  member_joined: 'ntf_member_joined_body',
  member_left: 'ntf_member_left_body',
  kameti_draw_completed: 'ntf_kameti_draw_body',
  kameti_round_due: 'ntf_kameti_round_due_body',
  kameti_payout_due: 'ntf_kameti_payout_body',
  expense_added: 'ntf_expense_added_body',
  expense_updated: 'ntf_expense_updated_body',
  expense_deleted: 'ntf_expense_deleted_body',
  settlement_added: 'ntf_settlement_added_body',
  settlement_deleted: 'ntf_settlement_deleted_body',
  group_archived: 'ntf_group_archived_body',
  group_unarchived: 'ntf_group_unarchived_body',
  lsr_recorded: 'ntf_lsr_recorded_body',
  lsr_undone: 'ntf_lsr_undone_body',
};

// Amount is optional on the money templates: an expense whose params predate
// the amount field, or a settlement written by an older trigger, must still
// read as a sentence rather than "… for  was added".
const BODY_KEYS_NO_AMOUNT: Record<string, I18nKey> = {
  expense_added: 'ntf_expense_added_body_plain',
  settlement_added: 'ntf_settlement_added_body_plain',
};

function text(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

/** Numeric params arrive as JSON numbers, but a jsonb round-trip can hand
 *  back a string ("250.50") — accept both, reject anything else. */
export function readAmount(params: Record<string, unknown>): number | null {
  const raw = params.amount;
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
  return Number.isFinite(n) ? n : null;
}

function fill(template: string, vars: Record<string, string>): string {
  let out = template;
  for (const [key, value] of Object.entries(vars)) {
    out = out.split(`{${key}}`).join(value);
  }
  return out;
}

/** Render one notification's title + body, localized when possible. */
export function renderNotificationContent(
  n: NotificationContentInput,
  t: NotificationTranslate,
): NotificationContent {
  const stored: NotificationContent = {
    title: (n.title ?? '').trim(),
    body: (n.body ?? '').trim(),
  };

  const template = typeof n.template === 'string' ? n.template.trim() : '';
  // No template (legacy row, or a linked-request/contact-link row written by
  // an older trigger) → the server text is all there is.
  if (!template) return stored;

  const titleKey = TITLE_KEYS[template];
  if (!titleKey) return stored;

  const params: Record<string, unknown> =
    n.params && typeof n.params === 'object' && !Array.isArray(n.params)
      ? (n.params as Record<string, unknown>)
      : {};

  const amount = readAmount(params);
  const currency = text(params, 'currency');
  const vars: Record<string, string> = {
    actor: text(params, 'actorName') || t('ntf_someone'),
    group: text(params, 'groupName') || t('ntf_the_group'),
    desc: text(params, 'description') || t('ntf_an_expense'),
    from: text(params, 'fromName') || t('ntf_someone'),
    to: text(params, 'toName') || t('ntf_someone'),
    amount: amount === null ? '' : formatMoney(amount, currency || 'PKR'),
    // Kameti templates (audit N-11). `member` is the person the event is
    // ABOUT, which for member_left is the leaver and for kameti is the
    // recipient's own committee_members row.
    kameti: text(params, 'committeeName') || t('ntf_the_kameti'),
    member: text(params, 'memberName') || t('ntf_someone'),
    round: text(params, 'round'),
    slot: text(params, 'slot'),
  };

  const bodyKey = amount === null && BODY_KEYS_NO_AMOUNT[template]
    ? BODY_KEYS_NO_AMOUNT[template]
    : BODY_KEYS[template];

  const title = fill(t(titleKey), vars).trim();
  const body = bodyKey ? fill(t(bodyKey), vars).trim() : '';

  // Never render an empty card: a missing translation falls back to whatever
  // the server composed.
  if (!title) return stored;
  return { title, body: body || stored.body };
}

/** Where a notification should land when tapped. Group rows deep-link to the
 *  group itself (the audit's N-8: everything used to dump the user at the top
 *  of /groups and make them hunt).
 *
 *  MUST stay in step with notification_href_for() in
 *  supabase-migration-p2-notification-maturity.sql §3, which stamps the same
 *  route into `notifications.href` so the FCM payload — which cannot run this
 *  code — deep-links identically. The stored value wins when present; this
 *  function is the fallback for rows written before that migration. */
export function notificationHref(n: {
  type?: string | null;
  groupId?: string | null;
  href?: string | null;
  params?: Record<string, unknown> | null;
}): string {
  const stored = typeof n.href === 'string' ? n.href.trim() : '';
  // Only accept an in-app absolute path. A row is server-written, but this is
  // the value we hand to navigate() — refusing anything that isn't "/…" keeps
  // a future writer from turning a notification into an open redirect.
  if (stored.startsWith('/') && !stored.startsWith('//')) return stored;

  const committeeId = n.params && typeof n.params === 'object' && !Array.isArray(n.params)
    ? (n.params as Record<string, unknown>).committeeId
    : undefined;
  if (n.type === 'kameti' && typeof committeeId === 'string' && committeeId) {
    return `/kameti/${committeeId}`;
  }
  if (n.type === 'group_update' && n.groupId) return `/group/${n.groupId}`;
  // 'invite' rows are written by tg_group_members_notify_invited
  // (supabase-migration-audit-p0-consent-guards.sql §2.4) and DO carry a
  // group_id — but the recipient is only 'invited', so is_group_member() fails
  // and RLS hides that group row entirely. Deep-linking to /group/:id would
  // land them on a permanent "Loading…". The Groups tab is where the
  // Accept/Decline card lives, so that is the only correct destination.
  if (n.type === 'group_update' || n.type === 'invite') return '/groups';
  return '/inbox';
}

// ── Android notification channels (audit N-10) ─────────────────────────────
// Before M5 every push landed on one undifferentiated channel, so a user who
// wanted less group chatter could only turn Hisaab off entirely — taking loan
// requests with it. Splitting them lets the OS settings screen do the job a
// preference centre would otherwise have to.
//
// 'reminders' is client-only: it is where notificationPlanner's device-local
// bill/EMI/kameti/budget reminders go, and no server row ever carries it.
export const NOTIFICATION_CHANNELS = ['money', 'groups', 'kameti', 'reminders'] as const;
export type NotificationChannel = typeof NOTIFICATION_CHANNELS[number];

const CHANNEL_SET = new Set<string>(NOTIFICATION_CHANNELS);

// Android 8+ requires a channel, and a message naming one the device has never
// seen is DROPPED SILENTLY — so all four are created before the first
// notification of either kind can arrive.
//
// Creating a channel is idempotent, but Android IGNORES importance changes on
// an existing channel: that setting belongs to the user once created. Pick
// carefully the first time; a later revision only reaches fresh installs.
//   money     HIGH    — a loan request or a repayment to confirm is the reason
//                       this app sends notifications at all.
//   groups    DEFAULT — expenses and joins: worth knowing, not worth peeking.
//   kameti    DEFAULT — a draw or a round is a day-scale event.
//   reminders HIGH    — device-local bill/EMI/budget reminders, which the user
//                       opted into explicitly in Settings.
const CHANNEL_IMPORTANCE: Record<NotificationChannel, 1 | 2 | 3 | 4 | 5> = {
  money: 4,
  groups: 3,
  kameti: 3,
  reminders: 4,
};

const CHANNEL_NAME_KEYS: Record<NotificationChannel, I18nKey> = {
  money: 'notif_channel_money',
  groups: 'notif_channel_groups',
  kameti: 'notif_channel_kameti',
  reminders: 'notif_channel_reminders',
};

const CHANNEL_DESC_KEYS: Record<NotificationChannel, I18nKey> = {
  money: 'notif_channel_money_desc',
  groups: 'notif_channel_groups_desc',
  kameti: 'notif_channel_kameti_desc',
  reminders: 'notif_channel_reminders_desc',
};

export interface NotificationChannelDef {
  id: NotificationChannel;
  name: string;
  description: string;
  importance: 1 | 2 | 3 | 4 | 5;
  visibility: 1;
  vibration: boolean;
}

/** The four channel descriptors, translated at call time so a language change
 *  before first creation is honoured.
 *
 *  Two callers create these through DIFFERENT Capacitor plugins —
 *  pushRegistration (PushNotifications) and notificationScheduler
 *  (LocalNotifications) — because a build with no google-services.json never
 *  reaches the push path at all. Android channels are app-global, so whichever
 *  gets there first wins and the other's call is a no-op. The translator is
 *  passed in to keep this module free of a runtime i18n import. */
export function notificationChannelDefs(t: NotificationTranslate): NotificationChannelDef[] {
  return NOTIFICATION_CHANNELS.map((id) => ({
    id,
    name: t(CHANNEL_NAME_KEYS[id]),
    description: t(CHANNEL_DESC_KEYS[id]),
    importance: CHANNEL_IMPORTANCE[id],
    // VISIBILITY_PRIVATE: shown on the lock screen, but amounts and names are
    // hidden until unlocked. These notifications name real people and real
    // money.
    visibility: 1 as const,
    vibration: true,
  }));
}

/** Which Android channel a persisted notification belongs to.
 *
 *  MUST stay in step with notification_channel_for() in
 *  supabase-migration-p2-notification-maturity.sql §3. The stored value wins;
 *  this is the fallback for pre-migration rows and for a channel this build
 *  does not know about (an unregistered channel_id makes Android drop the
 *  notification silently, so an unknown value must never be passed through). */
export function notificationChannel(n: {
  type?: string | null;
  template?: string | null;
  channelId?: string | null;
}): NotificationChannel {
  const stored = typeof n.channelId === 'string' ? n.channelId.trim() : '';
  if (CHANNEL_SET.has(stored)) return stored as NotificationChannel;
  if (n.type === 'kameti' || (n.template ?? '').startsWith('kameti_')) return 'kameti';
  // 'linked_info' rows are stamped channel_id='money' server-side; this is the
  // fallback for a build that meets a row without it.
  if (n.type === 'linked_request' || n.type === 'linked_settlement' || n.type === 'linked_info') return 'money';
  return 'groups';
}

/** Tray grouping key. Mirrors notification_collapse_key_for() in the same
 *  migration §3: group traffic collapses per (group, template) so a trip
 *  entered as ten expenses is ONE tray entry; money items key off the row id
 *  so two different loan requests stay two different decisions. */
export function notificationCollapseKey(n: {
  id: string;
  type?: string | null;
  groupId?: string | null;
  template?: string | null;
  collapseKey?: string | null;
  params?: Record<string, unknown> | null;
}): string {
  const stored = typeof n.collapseKey === 'string' ? n.collapseKey.trim() : '';
  if (stored) return stored;
  const params = n.params && typeof n.params === 'object' && !Array.isArray(n.params)
    ? (n.params as Record<string, unknown>)
    : {};
  const committeeId = typeof params.committeeId === 'string' ? params.committeeId : '';
  if (committeeId && (n.type === 'kameti' || (n.template ?? '').startsWith('kameti_'))) {
    return `kameti:${committeeId}:${n.template || n.type}`;
  }
  if (n.groupId) return `group:${n.groupId}:${n.template || n.type}`;
  return `${n.type || 'system'}:${n.id}`;
}
