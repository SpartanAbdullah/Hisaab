// Turns a freshly-arrived server notification into a real Android tray
// notification, immediately.
//
// Why this exists: Hisaab's only delivery channel used to be the in-app
// list. A backgrounded app therefore "notified" nobody — the user found out
// when they next opened it. FCM (see pushRegistration.ts) covers the case
// where Android has killed the process; this covers the far more common one
// where the app is merely in the background and its realtime socket is still
// alive. Between them the "I had to close and reopen the app" gap closes.
//
// Rules that keep it from becoming noise:
//   • Only fires when the app is NOT the thing the user is looking at.
//     A tray notification for a row they can already see is spam.
//   • Only unread, only recent — a cold boot must never dump three days of
//     history into the tray. The first load PRIMES the seen-set silently.
//   • Ids are derived from the notification row id, so the same row can
//     never surface twice (reloads, reconnects, multi-tab).
//   • Fires with no `schedule`, so it is delivered rather than pending —
//     notificationScheduler's cancel-all-pending sweep can't eat it.
import { isNativeRuntime } from './runtime';
import { notificationChannel, notificationHref, notificationTrayBody, renderNotificationContent } from './notificationContent';
import { isAttentionNotification, type NotificationMuteState } from './notificationCounts';
import { tStatic } from './i18n';
import type { AppNotification } from '../db';

// FNV-1a 32-bit, kept positive and under Android's int32 notification-id
// ceiling. Deliberately a local copy rather than an import of the planner's
// identical helper: notificationStore imports THIS module, and reaching into
// notificationPlanner would drag its whole dependency graph (card statements,
// committee math, budget store) into the eager boot chunk on web, where none
// of it is ever used.
function androidNotificationId(key: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i += 1) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % 2147483646 + 1;
}

// Anything older than this was already missed by other means; surfacing it
// now would be archaeology, not a notification.
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
// Above this many fresh rows in one batch we stop showing them individually
// and COLLAPSE instead — see summariseByActor below.
//
// Audit 08-notifications.md N-9: this used to be a silent DROP. "when a
// reconnect delivers 4+ fresh unread rows the function returns before
// scheduling anything … four genuinely new events (e.g. a group member
// posting four expenses of a trip) yield zero tray signal. Leaders collapse
// instead of dropping: show one summary notification ('4 updates in Hisaab')."
const MAX_PER_BATCH = 3;
// How many per-actor summaries we are willing to show at once. Beyond this,
// one grand-total summary — five people acting at once is a "something is
// happening" signal, not five separate stories.
const MAX_SUMMARIES = 3;

const seen = new Set<string>();
let primed = false;

/** True when the user cannot currently see the app. On Capacitor the
 *  WebView's document goes hidden as the activity backgrounds, so this is
 *  the same signal on web and native. */
function appIsHidden(): boolean {
  if (typeof document === 'undefined') return false;
  return document.visibilityState === 'hidden';
}

/** Mark everything currently known as already-surfaced without notifying.
 *  Called on the first load of a session so boot is silent. */
export function primeInstantNotify(notifications: AppNotification[]): void {
  for (const n of notifications) seen.add(n.id);
  primed = true;
}

/** Forget the seen-set. Sign-out only — the next user's first load primes
 *  again from scratch. */
export function resetInstantNotify(): void {
  seen.clear();
  primed = false;
}

/** The shape LocalNotifications.schedule takes, narrowed to what we set. */
interface TrayItem {
  id: number;
  title: string;
  body: string;
  extra: { href: string };
  smallIcon: string;
  channelId: string;
  group?: string;
}

/** Who caused a row, for summary grouping. `actorId` is the durable key
 *  (added by supabase-migration-audit-p0-notifications.sql); the name from
 *  params is only for display. Rows with no actor — server sweeps like the
 *  kameti round reminder — share one bucket. */
function actorKeyOf(n: AppNotification): string {
  return n.actorId || `template:${n.template || n.type}`;
}

function actorNameOf(n: AppNotification): string {
  const raw = (n.params as Record<string, unknown> | undefined)?.actorName;
  return typeof raw === 'string' && raw.trim() ? raw.trim() : '';
}

/** Collapse a burst into one entry PER ACTOR instead of dropping it.
 *
 *  This is the N-9 fix. Grouping by actor (rather than by group or by type) is
 *  what makes the result readable: "Ali · 4 updates" is a story, "4 updates"
 *  across four different people is noise the user still has to open the app to
 *  decode — so beyond MAX_SUMMARIES actors we fall back to exactly that one
 *  honest total.
 *
 *  Exported for the unit test; not used elsewhere. */
export function summariseByActor(fresh: AppNotification[]): TrayItem[] {
  // Bucket per actor, newest first within each bucket.
  const buckets = new Map<string, AppNotification[]>();
  for (const n of fresh) {
    const key = actorKeyOf(n);
    const list = buckets.get(key) ?? [];
    list.push(n);
    buckets.set(key, list);
  }

  // The minute bucket keeps repeated bursts inside the same minute collapsing
  // onto the SAME tray id (Android replaces rather than stacks), which is the
  // "per-actor-per-minute" contract.
  const minute = Math.floor(Date.now() / 60_000);

  if (buckets.size > MAX_SUMMARIES) {
    return [{
      id: androidNotificationId(`summary:all:${minute}`),
      title: 'Hisaab',
      body: tStatic('notif_summary_updates').replace('{n}', String(fresh.length)),
      // No single entity to open — the Inbox is where every cross-user item
      // lives, and it is also where the user can triage the whole burst.
      extra: { href: '/inbox' },
      smallIcon: 'ic_stat_hisaab',
      channelId: 'groups',
      group: 'hisaab_updates',
    }];
  }

  const out: TrayItem[] = [];
  for (const [key, list] of buckets) {
    // One item from an actor still reads better as itself than as a summary.
    if (list.length === 1) {
      out.push(trayItemFor(list[0]));
      continue;
    }
    const newest = list.reduce((a, b) =>
      new Date(b.createdAt).getTime() > new Date(a.createdAt).getTime() ? b : a);
    const who = actorNameOf(newest);
    out.push({
      id: androidNotificationId(`summary:${key}:${minute}`),
      title: who || 'Hisaab',
      body: (who
        ? tStatic('notif_summary_from')
        : tStatic('notif_summary_updates')
      ).replace('{n}', String(list.length)).replace('{who}', who),
      // Land on the newest item's target: for a group burst that is the group
      // itself, which is exactly where the four expenses are.
      extra: { href: notificationHref(newest) },
      smallIcon: 'ic_stat_hisaab',
      channelId: notificationChannel(newest),
      group: 'hisaab_updates',
    });
  }
  return out;
}

function trayItemFor(n: AppNotification): TrayItem {
  // Render template+params through i18n so a tray notification arrives
  // in the reader's language, not the sender's (audit N-1). Rows without
  // a template fall back to the server-composed text.
  const content = renderNotificationContent(n, tStatic);
  return {
    id: androidNotificationId(`instant:${n.id}`),
    title: content.title || 'Hisaab',
    // The tray has one text slot: event + the reader's move + the balance
    // after, with ▲/▼ as a glyph since there is no colour to lean on.
    body: notificationTrayBody(content),
    // Deep-links group rows to the group itself instead of dumping the
    // user at the top of /groups to hunt (audit N-8). Prefers the
    // server-stamped href when the row has one.
    extra: { href: notificationHref(n) },
    smallIcon: 'ic_stat_hisaab',
    // Audit N-10: money requests and group chatter go to different Android
    // channels so the user can demote one without losing the other.
    channelId: notificationChannel(n),
  };
}

/** Surface anything in `notifications` that we have not surfaced before.
 *  Safe to call on every load; no-op on web and while the app is visible.
 *
 *  `mutes` is the caller's mirror of notification_prefs. The server already
 *  refuses to write rows for a muted group, but a mute toggled on THIS device
 *  must take effect before the next fan-out — so it is applied here too. */
export async function surfaceNewNotifications(
  notifications: AppNotification[],
  mutes?: NotificationMuteState,
): Promise<void> {
  if (!primed) {
    primeInstantNotify(notifications);
    return;
  }

  const cutoff = Date.now() - MAX_AGE_MS;
  const fresh: AppNotification[] = [];
  for (const n of notifications) {
    if (seen.has(n.id)) continue;
    // Mark seen REGARDLESS of whether we end up showing it. A notification
    // skipped because the app was open must not pop the moment it hides.
    seen.add(n.id);
    const at = new Date(n.createdAt).getTime();
    if (!Number.isFinite(at) || at < cutoff) continue;
    // Unread, not self-caused, not muted — the same definition the bell uses.
    if (!isAttentionNotification(n, n.userId, mutes)) continue;
    fresh.push(n);
  }

  if (fresh.length === 0) return;
  if (!isNativeRuntime()) return;
  if (!appIsHidden()) return;

  // Audit N-9: a burst COLLAPSES, it does not vanish.
  const items = fresh.length > MAX_PER_BATCH
    ? summariseByActor(fresh)
    : fresh.map(trayItemFor);

  try {
    const { LocalNotifications } = await import('@capacitor/local-notifications');
    const perm = await LocalNotifications.checkPermissions();
    if (perm.display !== 'granted') return;
    await LocalNotifications.schedule({ notifications: items });
  } catch (err) {
    // Delivery is best-effort by design: the in-app list is the source of
    // truth and has already been updated by the caller.
    console.error('[instantNotify] surface failed (non-fatal)', err);
  }
}
