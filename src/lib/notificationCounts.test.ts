import { describe, it, expect } from 'vitest';
import {
  countAttentionNotifications,
  countBellItems,
  countBellNotifications,
  countIncomingPending,
  countOutgoingPending,
  daysWaiting,
  isAttentionNotification,
  isRequestMirrorNotification,
  staleMirrorNotificationIds,
} from './notificationCounts';
import { isInboxInfoNotification } from './inboxInfo';
import type { AppNotification } from '../db';

const ME = 'user-me';
const THEM = 'user-them';

function notif(over: Partial<AppNotification> = {}): AppNotification {
  return {
    id: 'n1',
    userId: ME,
    groupId: null,
    eventId: null,
    type: 'group_update',
    title: 't',
    body: 'b',
    template: null,
    params: {},
    actorId: THEM,
    collapseKey: null,
    channelId: null,
    href: null,
    readAt: null,
    createdAt: '2026-09-02T10:00:00.000Z',
    ...over,
  };
}

describe('isAttentionNotification', () => {
  it('counts an unread row caused by someone else', () => {
    expect(isAttentionNotification(notif(), ME)).toBe(true);
  });

  it('does not count a read row', () => {
    expect(isAttentionNotification(notif({ readAt: '2026-09-02T11:00:00.000Z' }), ME)).toBe(false);
  });

  // Audit 08-notifications.md N-7, one layer down from InboxAction: the badge
  // is a promise that something needs YOU. Your own action is not news.
  it('does not count a row this user caused themselves', () => {
    expect(isAttentionNotification(notif({ actorId: ME }), ME)).toBe(false);
  });

  it('still counts a row with no actor (a server sweep, e.g. a kameti round)', () => {
    expect(isAttentionNotification(notif({ actorId: null, type: 'kameti' }), ME)).toBe(true);
  });

  it('does not count a row from a muted group', () => {
    const n = notif({ groupId: 'g1' });
    expect(isAttentionNotification(n, ME, { mutedGroupIds: new Set(['g1']) })).toBe(false);
    expect(isAttentionNotification(n, ME, { mutedGroupIds: new Set(['g2']) })).toBe(true);
  });

  it('accepts a plain array of muted group ids as well as a Set', () => {
    const n = notif({ groupId: 'g1' });
    expect(isAttentionNotification(n, ME, { mutedGroupIds: ['g1'] })).toBe(false);
  });

  it('mutes everything when the global row is muted, group row or not', () => {
    expect(isAttentionNotification(notif({ groupId: 'g1' }), ME, { allMuted: true })).toBe(false);
    expect(isAttentionNotification(notif({ groupId: null }), ME, { allMuted: true })).toBe(false);
  });

  it('leaves non-group notifications alone when only a group is muted', () => {
    // A per-group mute must never silence a loan request.
    const loan = notif({ type: 'linked_request', groupId: null });
    expect(isAttentionNotification(loan, ME, { mutedGroupIds: new Set(['g1']) })).toBe(true);
  });

  it('counts everything unread when the caller knows no user id and no prefs', () => {
    // Degraded but honest: this is the pre-M5 behaviour, which is what a
    // client running against an un-migrated database should still get.
    expect(isAttentionNotification(notif({ actorId: ME }), null)).toBe(true);
  });
});

describe('countAttentionNotifications', () => {
  it('counts only the inbound, unread, non-muted rows', () => {
    const rows: AppNotification[] = [
      notif({ id: '1' }),                                            // ✓
      notif({ id: '2', readAt: '2026-09-02T11:00:00.000Z' }),        // read
      notif({ id: '3', actorId: ME }),                               // self-caused
      notif({ id: '4', groupId: 'g1' }),                             // muted group
      notif({ id: '5', groupId: 'g2' }),                             // ✓
      notif({ id: '6', type: 'linked_request', actorId: THEM }),     // ✓
    ];
    expect(countAttentionNotifications(rows, ME, { mutedGroupIds: new Set(['g1']) })).toBe(3);
  });

  it('is zero for an empty list', () => {
    expect(countAttentionNotifications([], ME)).toBe(0);
  });
});

// ── The N-7 fix proper: outgoing requests are not attention ────────────────
// "A user who sends one loan request to a slow-to-respond cousin sees a red
//  animated badge for days with nothing to act on."
describe('countIncomingPending / countOutgoingPending', () => {
  const requests = [
    { status: 'pending',  toUserId: ME,   fromUserId: THEM },  // they asked me
    { status: 'pending',  toUserId: THEM, fromUserId: ME },    // I asked them
    { status: 'pending',  toUserId: THEM, fromUserId: THEM },  // neither
    { status: 'accepted', toUserId: ME,   fromUserId: THEM },  // resolved
    { status: 'rejected', toUserId: THEM, fromUserId: ME },    // resolved
  ];

  it('counts only requests waiting on ME', () => {
    expect(countIncomingPending(requests, ME)).toBe(1);
  });

  it('counts requests I am waiting on someone else for, separately', () => {
    expect(countOutgoingPending(requests, ME)).toBe(1);
  });

  it('never double-counts a self-addressed request in the outgoing tally', () => {
    const selfLoop = [{ status: 'pending', toUserId: ME, fromUserId: ME }];
    expect(countIncomingPending(selfLoop, ME)).toBe(1);
    expect(countOutgoingPending(selfLoop, ME)).toBe(0);
  });

  it('is zero while the user id is unknown (signed out / still booting)', () => {
    expect(countIncomingPending(requests, '')).toBe(0);
    expect(countOutgoingPending(requests, '')).toBe(0);
  });
});

// ── The bell badge (founder report 2026-09-03: "the counter is also not
//    there"). The badge counted an ALLOW-list of four notification types, two
//    of which nothing in the product writes — so `group_update`, the app's
//    highest-volume notification, never lit it.
describe('countBellNotifications', () => {
  it('counts an unread group notification — the type the old allow-list dropped', () => {
    expect(countBellNotifications([notif({ type: 'group_update' })], ME)).toBe(1);
  });

  it('counts contact / kameti pings too', () => {
    const rows = [
      notif({ id: '1', type: 'contact_linked', actorId: null }),
      notif({ id: '2', type: 'kameti', actorId: null }),
    ];
    expect(countBellNotifications(rows, ME)).toBe(2);
  });

  it('never counts the linked request/settlement mirrors', () => {
    // These are the ping ABOUT a pending request row, and that row is counted
    // directly. Counting both shows 2 for one loan — and the ping stays unread
    // after the user accepts, so the badge could never reach zero.
    expect(isRequestMirrorNotification(notif({ type: 'linked_request' }))).toBe(true);
    expect(isRequestMirrorNotification(notif({ type: 'linked_settlement' }))).toBe(true);
    expect(isRequestMirrorNotification(notif({ type: 'group_update' }))).toBe(false);
    const rows = [
      notif({ id: '1', type: 'linked_request' }),
      notif({ id: '2', type: 'linked_settlement' }),
      notif({ id: '3', type: 'group_update' }),
    ];
    expect(countBellNotifications(rows, ME)).toBe(1);
  });

  it('still drops read, self-caused and muted-group rows (audit N-7)', () => {
    const rows = [
      notif({ id: '1' }),                                       // ✓
      notif({ id: '2', readAt: '2026-09-02T11:00:00.000Z' }),   // read
      notif({ id: '3', actorId: ME }),                          // self-caused
      notif({ id: '4', groupId: 'g1' }),                        // muted group
    ];
    expect(countBellNotifications(rows, ME, { mutedGroupIds: ['g1'] })).toBe(1);
  });

  it('reaches zero once everything is read', () => {
    const rows = [notif({ id: '1' }), notif({ id: '2', type: 'contact_linked' })];
    const read = rows.map((n) => ({ ...n, readAt: '2026-09-02T12:00:00.000Z' }));
    expect(countBellNotifications(rows, ME)).toBe(2);
    expect(countBellNotifications(read, ME)).toBe(0);
  });

  // The bell must never promise something the /inbox destination cannot show:
  // the Info tab lists exactly the rows this counts (minus the self/mute
  // filters, which can only make the badge SMALLER than the list).
  it('agrees with what the Inbox Info tab lists', () => {
    const rows = [
      notif({ id: '1', type: 'group_update' }),
      notif({ id: '2', type: 'contact_linked' }),
      notif({ id: '3', type: 'kameti' }),
      notif({ id: '4', type: 'linked_request' }),
      notif({ id: '5', readAt: '2026-09-02T11:00:00.000Z' }),
    ];
    expect(countBellNotifications(rows, ME)).toBe(rows.filter(isInboxInfoNotification).length);
  });
});

describe('countBellItems', () => {
  const base = {
    notifications: [] as AppNotification[],
    linkedRequests: [],
    settlementRequests: [],
    contactLinkRequests: [],
    userId: ME,
  };

  it('adds incoming requests and unread notifications', () => {
    expect(countBellItems({
      ...base,
      notifications: [notif({ id: '1' }), notif({ id: '2', type: 'contact_linked' })],
      linkedRequests: [{ status: 'pending', toUserId: ME, fromUserId: THEM }],
      settlementRequests: [{ status: 'pending', toUserId: ME, fromUserId: THEM }],
      contactLinkRequests: [{ status: 'pending', toUserId: ME, fromUserId: THEM }],
    })).toEqual({ actionable: 5, waiting: 0, total: 5 });
  });

  it('keeps requests this user sent in `waiting`, and the red total counts them (2026-09-18)', () => {
    expect(countBellItems({
      ...base,
      linkedRequests: [
        { status: 'pending', toUserId: THEM, fromUserId: ME },   // mine, waiting on them
        { status: 'pending', toUserId: ME, fromUserId: THEM },   // ✓ actionable
      ],
    })).toEqual({ actionable: 1, waiting: 1, total: 2 });
  });

  it('does not double-count a loan request against its own notification', () => {
    // One incoming loan request = one item, even though the trigger also
    // writes the receiver a `linked_request` row.
    expect(countBellItems({
      ...base,
      notifications: [notif({ id: '1', type: 'linked_request' })],
      linkedRequests: [{ status: 'pending', toUserId: ME, fromUserId: THEM }],
    })).toEqual({ actionable: 1, waiting: 0, total: 1 });
  });

  it('is zero when nothing needs the user', () => {
    expect(countBellItems({
      ...base,
      notifications: [notif({ id: '1', readAt: '2026-09-02T11:00:00.000Z' })],
      linkedRequests: [{ status: 'accepted', toUserId: ME, fromUserId: THEM }],
    })).toEqual({ actionable: 0, waiting: 0, total: 0 });
  });

  it('counts unread notifications even before the user id is known', () => {
    // Boot order: notifications can land before the auth store settles. The
    // badge must not blink off — request counts wait for the id, rows do not.
    expect(countBellItems({
      ...base,
      userId: '',
      notifications: [notif({ id: '1' })],
      linkedRequests: [{ status: 'pending', toUserId: ME, fromUserId: THEM }],
    })).toEqual({ actionable: 1, waiting: 0, total: 1 });
  });

  // ── The founder's production account, 2026-09-03, exactly as measured ────
  // 5 outgoing pending linked requests, 3 outgoing pending settlements, 0
  // incoming of either, 0 contact links, 76 group_update rows ALL READ, and 73
  // unread request mirrors (38 linked_request + 35 linked_settlement).
  // Expected (founder decision 2026-09-18): the red number shows 8 — every
  // open request counts, including the user's own outgoing ones.
  it('reproduces the founder’s account: actionable 0, waiting 8, bell shows 8', () => {
    const outgoing = (n: number) =>
      Array.from({ length: n }, () => ({ status: 'pending', toUserId: THEM, fromUserId: ME }));
    const read = (id: string, type: AppNotification['type']) =>
      notif({ id, type, readAt: '2026-09-01T09:00:00.000Z' });
    const unreadMirror = (id: string, type: AppNotification['type']) => notif({ id, type });

    const state = countBellItems({
      notifications: [
        ...Array.from({ length: 76 }, (_, i) => read(`g${i}`, 'group_update')),
        ...Array.from({ length: 38 }, (_, i) => unreadMirror(`lr${i}`, 'linked_request')),
        ...Array.from({ length: 35 }, (_, i) => unreadMirror(`ls${i}`, 'linked_settlement')),
      ],
      linkedRequests: outgoing(5),
      settlementRequests: outgoing(3),
      contactLinkRequests: [],
      userId: ME,
    });
    expect(state).toEqual({ actionable: 0, waiting: 8, total: 8 });
  });
});

// ── Stale request mirrors ─────────────────────────────────────────────────
// The 73 unread pings in that same production account: their requests are all
// resolved, the Inbox can't show them, and nothing the user does clears them.
describe('staleMirrorNotificationIds', () => {
  const T0 = '2026-09-02T10:00:00.000Z';

  it('retires every mirror when nothing of that kind is pending (the founder’s 73)', () => {
    const rows = [
      ...Array.from({ length: 38 }, (_, i) => notif({ id: `lr${i}`, type: 'linked_request' })),
      ...Array.from({ length: 35 }, (_, i) => notif({ id: `ls${i}`, type: 'linked_settlement' })),
    ];
    const ids = staleMirrorNotificationIds({
      notifications: rows,
      // Only OUTGOING pendings — none of these is waiting on ME.
      linkedRequests: [{ status: 'pending', toUserId: THEM, fromUserId: ME, createdAt: T0 }],
      settlementRequests: [{ status: 'pending', toUserId: THEM, fromUserId: ME, createdAt: T0 }],
      userId: ME,
    });
    expect(ids).toHaveLength(73);
  });

  it('never touches a ping whose incoming request is still pending', () => {
    const live = notif({ id: 'live', type: 'linked_request', createdAt: T0 });
    const ids = staleMirrorNotificationIds({
      notifications: [live],
      linkedRequests: [{ status: 'pending', toUserId: ME, fromUserId: THEM, createdAt: T0 }],
      settlementRequests: [],
      userId: ME,
    });
    expect(ids).toEqual([]);
  });

  it('retires an OLD ping even while a different request of that kind is pending', () => {
    const old = notif({ id: 'old', type: 'linked_request', createdAt: '2026-08-01T10:00:00.000Z' });
    const live = notif({ id: 'live', type: 'linked_request', createdAt: T0 });
    const ids = staleMirrorNotificationIds({
      notifications: [old, live],
      linkedRequests: [{ status: 'pending', toUserId: ME, fromUserId: THEM, createdAt: T0 }],
      settlementRequests: [],
      userId: ME,
    });
    expect(ids).toEqual(['old']);
  });

  it('leaves non-mirror and already-read rows alone', () => {
    const ids = staleMirrorNotificationIds({
      notifications: [
        notif({ id: 'g', type: 'group_update' }),
        notif({ id: 'c', type: 'contact_linked' }),
        notif({ id: 'read', type: 'linked_request', readAt: '2026-09-02T11:00:00.000Z' }),
      ],
      linkedRequests: [],
      settlementRequests: [],
      userId: ME,
    });
    expect(ids).toEqual([]);
  });

  it('keeps a ping when a timestamp is unreadable — never clears on a guess', () => {
    const ids = staleMirrorNotificationIds({
      notifications: [notif({ id: 'x', type: 'linked_request', createdAt: 'not-a-date' })],
      linkedRequests: [{ status: 'pending', toUserId: ME, fromUserId: THEM, createdAt: T0 }],
      settlementRequests: [],
      userId: ME,
    });
    expect(ids).toEqual([]);
  });

  it('does nothing while the user id is unknown', () => {
    expect(staleMirrorNotificationIds({
      notifications: [notif({ id: 'x', type: 'linked_request' })],
      linkedRequests: [],
      settlementRequests: [],
      userId: '',
    })).toEqual([]);
  });

  it('is idempotent: a second pass over the marked rows finds nothing', () => {
    const rows = [notif({ id: 'a', type: 'linked_request' })];
    const first = staleMirrorNotificationIds({
      notifications: rows, linkedRequests: [], settlementRequests: [], userId: ME,
    });
    expect(first).toEqual(['a']);
    const marked = rows.map((n) => ({ ...n, readAt: '2026-09-03T10:00:00.000Z' }));
    expect(staleMirrorNotificationIds({
      notifications: marked, linkedRequests: [], settlementRequests: [], userId: ME,
    })).toEqual([]);
  });
});

describe('daysWaiting', () => {
  const now = new Date(2026, 8, 3, 14, 0, 0); // 2026-09-03 local

  it('is 0 for something sent today', () => {
    expect(daysWaiting(new Date(2026, 8, 3, 1, 0, 0).toISOString(), now)).toBe(0);
  });

  it('counts calendar days, so last night is 1 day', () => {
    expect(daysWaiting(new Date(2026, 8, 2, 23, 0, 0).toISOString(), now)).toBe(1);
  });

  it('counts a longer wait', () => {
    expect(daysWaiting(new Date(2026, 7, 24, 12, 0, 0).toISOString(), now)).toBe(10);
  });

  it('clamps a future timestamp to 0 rather than showing a negative wait', () => {
    expect(daysWaiting(new Date(2026, 8, 5, 12, 0, 0).toISOString(), now)).toBe(0);
  });

  it('is null for an unreadable timestamp', () => {
    expect(daysWaiting('nope', now)).toBeNull();
  });
});
