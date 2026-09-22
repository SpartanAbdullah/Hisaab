# Notifications

**Scope:** every notification Hisaab can produce, who receives it, on which channel, where it deep-links, and what silences it.
**Written:** 2026-09-02, for P2 item M5 (`supabase-migration-p2-notification-maturity.sql`).
**Audit basis:** `docs/audit-2026-09/08-notifications.md` findings N-6 … N-12 and recommendations 4–10.

---

## 1. The delivery ladder (unchanged by M5)

Three tiers, native Android. `docs/push-notifications-setup.md` covers the Firebase side.

| Tier | Condition | Path |
|---|---|---|
| 1 | App visible | realtime `postgres_changes` on `notifications` → `loadNotifications()` → bell/Inbox. No tray entry, by design. |
| 2 | App backgrounded, process alive | same realtime event → `instantNotify.surfaceNewNotifications` → `LocalNotifications.schedule` with no `schedule` field (delivers immediately). |
| 3 | App killed | Postgres `AFTER INSERT` trigger `tg_notifications_push` → `pg_net.http_post` → edge function `push-notify` → FCM HTTP v1 → tray. |

Tier 3 is a silent no-op until `app_push_config` holds `edge_url` + `edge_secret`. **Audit N-4 records tier 3 as believed unconfigured in production; M5 does not change that, and none of the work below is observable until it is turned on.**

A fourth, parallel channel exists and is *not* part of this ladder: **device-local scheduled reminders** (`notificationPlanner.ts` → `notificationScheduler.ts`), opt-in in Settings, derived entirely from local state. They never touch the `notifications` table.

---

## 2. Event catalog

Every row in `public.notifications` is written by a `SECURITY DEFINER` trigger or RPC. Clients can insert only for themselves (`audit-p0-notifications.sql` §2) and nothing in the app does.

| Template / type | Trigger or RPC | Recipients | Channel | Deep link |
|---|---|---|---|---|
| `linked_request` (created) | `tg_ltr_notify` INSERT — `linked-notifications-realtime.sql:42` | `to_user_id` (the reviewer) | `money` | `/inbox` |
| `linked_request` (accepted / rejected) | `tg_ltr_notify` UPDATE — `:52-65` | `from_user_id` (the sender) | `money` | `/inbox` |
| `linked_settlement` (created) | `tg_lsr_notify` INSERT — `:86` | `to_user_id` (the creditor) | `money` | `/inbox` |
| `linked_settlement` (accepted / rejected) | `tg_lsr_notify` UPDATE — `:96-109` | `from_user_id` (the payer) | `money` | `/inbox` |
| `contact_linked` | `link_contact_by_code` / `link_contact_by_discovery` / `respond_contact_link` | the other party | `groups` | `/inbox` |
| `invite` | `tg_group_members_notify_invited` — `audit-p0-consent-guards.sql` §2.4 | the invitee | `groups` | `/groups` *(never `/group/:id` — RLS hides the group from an invitee, so that would be a permanent "Loading…")* |
| `group_added` | `tg_group_members_notify` — `audit-p0-notifications.sql` §5 | the added member | `groups` | `/group/:id` |
| `member_joined` | same | every other connected member | `groups` | `/group/:id` |
| **`member_left`** | **`tg_group_members_notify_left` — M5 §5b** | every remaining connected member | `groups` | `/group/:id` |
| `expense_added` / `_updated` / `_deleted` | `tg_group_expenses_notify` | every other connected member | `groups` | `/group/:id` |
| `settlement_added` / `_deleted` | `tg_group_settlements_notify` | every other connected member | `groups` | `/group/:id` |
| `group_archived` / `group_unarchived` | `notify_group_archive_state` — `audit-p0-group-deletion-guard.sql` §6a | every connected member | `groups` | `/group/:id` |
| **`kameti_draw_completed`** | **`tg_committees_notify_draw` — M5 §6.1** | profile-linked committee members | `kameti` | `/kameti/:id` |
| **`kameti_round_due`** | **`notify_committee_rounds_due` sweep — M5 §7** | profile-linked members, only while the round is not fully collected | `kameti` | `/kameti/:id` |
| **`kameti_payout_due`** | **same sweep** | the profile-linked holder of that round's slot | `kameti` | `/kameti/:id` |
| *(device-local)* bills, EMIs, recurring, kameti rounds, **budget breach** | `notificationPlanner.ts` | this device's owner | `reminders` | `/account/:id`, `/loan/:id`, `/subscriptions`, `/kameti/:id`, `/budgets` |

**Bold = new in M5.** Everything else predates it and is listed so the catalog is complete.

### 2.1 Settlement accepted / rejected — already covered

The task list asked for these; they already exist and were **deliberately not duplicated**. `tg_lsr_notify`'s UPDATE branch fires on `pending → accepted` and `pending → rejected` and notifies `new.from_user_id`; `tg_ltr_notify` does the same for loan requests. The audit says so itself (`08-notifications.md:153`). Adding a second writer would have produced two rows per outcome.

### 2.2 Who is reachable for a kameti

Committees are single-owner tables (`supabase-migration-committees.sql`, owner-only RLS). There is no membership table to fan out over, so reachability runs through the organiser's contact list:

```
committee_members.person_id → persons.id → persons.linked_profile_id
```

A member is notified only if the organiser has linked them to a real Hisaab account **and** that link was consented to (`persons.linked_profile_id` is writable only by the link RPCs since `audit-p0-consent-guards.sql` H2). Members with no `person_id`, an unlinked contact, or an `exited_at` receive nothing — the witness link (`get_committee_witness`) stays their channel. The organiser is never notified about their own committee; they already have the device-local day-of reminder.

Use operator query **Q6** in the migration footer to see how many members of each live committee are actually reachable.

### 2.3 Budget breach is DEVICE-LOCAL, and that is a deliberate limitation

Audit N-11 asks for a budget alert. It is implemented in `src/lib/notificationPlanner.ts` section 6 as a scheduled *local* notification (`budget:<id>:warn:<YYYY-MM>` / `budget:<id>:over:<YYYY-MM>`), **not** as a server trigger.

Why: budgets are computed entirely on the client. `computeBudgetUsages` (`src/stores/budgetStore.ts:108`) walks the device's local `transactions` array; the database has no view of a budget's state and could not honestly author a row saying one was breached. Faking a trigger would mean re-implementing that math in SQL and keeping two copies in step forever.

What that costs the user, stated plainly:

- it fires on **that device only** — a second phone derives its own copy from its own synced state, and a web-only user gets none;
- it never becomes a push, never reaches the Inbox, and never lights the bell;
- it is gated by the same Settings opt-in as every other reminder;
- it fires at 10:00 local (or tomorrow at 10:00 if the breach is found after that), and never in a month the budget does not belong to.

The in-app Inbox "Info" card (`inboxInfo.ts:140-152`) remains the cross-device signal.

### 2.4 Daily close — the evening "log today" nudge (DEVICE-LOCAL, own opt-in)

Planner section 7 (`src/lib/notificationPlanner.ts`), added 2026-09-22 after the founder's balance reconciliation showed how far unlogged days drift. Like section 6 it is a scheduled *local* notification, never a server row or a push.

- **Opt-in of its own:** `hisaab_daily_close_enabled` + `hisaab_daily_close_time` (`src/lib/dailyClosePrefs.ts`, default 21:30), set in Settings → Daily close via `enableDailyCloseFlow()`. Payment reminders (`REMINDERS_KEY`, sections 1-6) are independent: either can be on alone. Full tracker only.
- **Never stale:** one entry per evening for the next 7 (`close:<YYYY-MM-DD>`), skipped for a day already logged (any non-bookkeeping transaction) or closed (`daily_closes` row, `supabase-migration-daily-close.sql`). Every transaction write and every close/reopen forces a reschedule, so logging at 20:00 silences 21:30.
- **Backs off:** daily for the first 2 quiet days, every other day up to a week, then every third day (`closeNudgeDue`). Any log or close resets it. Five wordings rotate by calendar day.
- **Weekly check swap:** when the Hisaab check is 7+ days old, one evening's nudge becomes the check (`/?check=1`).
- **Own lane:** exempt from the 3-per-day cap on 10:00 reminders; `allowWhileIdle` (inexact — no exact-alarm permission).
- **Buttons** (`actionTypeId: 'daily_close'`, registered in `notificationScheduler.ts`): **Add expense** → `/?add=expense` (QuickEntry on the amount step); **Nothing today** → closes the day (`no_spend`) and toasts the streak. Both launch the app; `nativeBridge.ts` reads `actionId`. Tapping the body opens `/?close=today` (the Close-day sheet).
- **Web:** no scheduled nudge; the Home "Close today" tile (from 17:00, or once something is logged) is the habit's surface.

---

## 3. Preferences model

`public.notification_prefs` — M5 §2. One row per `(user_id, group_id)`, enforced by a unique index on `(user_id, COALESCE(group_id, ''))`.

| Column | Meaning |
|---|---|
| `group_id` | `NULL` = the user's **global** row. Non-null = a per-group override. |
| `muted` | On a per-group row: mute that group. On the global row: mute everything. |
| `quiet_hours_start` / `_end` | Local hours 0–23. **Read from the global row only.** Both null, or equal, means no window. |
| `tz` | IANA zone the quiet window is evaluated in. Defaults to `Asia/Karachi`; the client writes `Intl.DateTimeFormat().resolvedOptions().timeZone`. |

RLS is **self-only on all four verbs**, and the two oracles (`notification_muted`, `notification_in_quiet_hours`) are `REVOKE`d from every client role. This mirrors the block model in `p2-trust-safety.sql`: a mute is one-sided and silent, so "has X muted my group" must not be answerable by anyone but X.

### Mute vs. quiet hours — the one rule that matters

> **Mute suppresses the row. Quiet hours suppress only the ring.**

- A **muted** group writes **no `notifications` row** for that recipient (`fan_out_group_notification`, the `[M5-b]` line). The shared `group_events` activity row is still written for everyone — the same carve-out the block filter makes — so the activity feed stays whole and the member sees the change when they open the group.
- **Quiet hours never suppress a row.** The in-app Inbox and bell must stay complete or the user silently loses records. Quiet hours are evaluated at **delivery**, in the edge function.

### Quiet-hours delivery decision: deliver silently, do not defer

Inside the window the push is still sent and still lands in the tray, but with:

```
android.priority                        = NORMAL   (not HIGH)
android.notification.notification_priority = PRIORITY_LOW
android.notification.default_sound      = false
android.notification.default_vibrate_timings = false
```

The user wakes up to the notification already waiting instead of being woken by it.

**Why not defer to 08:00.** `pg_net` is fire-and-forget and there is no scheduler in this pipeline. Deferring would need a pending-push table plus a cron drain — a second delivery path that can fail silently, which is exactly the failure mode audit N-4 is about. Silent delivery gets almost all of the benefit for almost none of the machinery. If a future version does want true deferral, the natural shape is a `pending_pushes` table filled by `tg_notifications_push` when `quiet` is true and drained by the same pg_cron job that prunes.

The `quiet` flag itself is **computed in the trigger** (where the prefs row is one index lookup away) and **enforced in the edge function** (where the FCM message is built). The trigger never decides whether to push.

---

## 4. Channels and collapse keys

### Android channels (audit N-10)

Four, created by both plugins (`pushRegistration.ensureNotificationChannels` and `notificationScheduler.ensureLocalChannels` — a build with no `google-services.json` never reaches the push path, so both must create them; Android channels are app-global and creation is idempotent).

| id | Importance | Carries |
|---|---|---|
| `money` | HIGH (4) | loan and repayment requests, and their outcomes |
| `groups` | DEFAULT (3) | group expenses, settlements, joins, leaves, invites, contact links |
| `kameti` | DEFAULT (3) | draw completed, round due, your payout |
| `reminders` | HIGH (4) | device-local bill / EMI / recurring / kameti / budget reminders |

**Android ignores importance changes on a channel that already exists** — that setting belongs to the user once created. Pick correctly the first time; a later change only affects fresh installs.

**A message naming a channel the device has not created is dropped silently.** That is why `notificationChannel()` and the edge function both fall back to `groups` for an unknown id rather than passing it through.

### Collapse keys

`notification_collapse_key_for()` (SQL) and `notificationCollapseKey()` (TS) must agree:

| Shape | Key | Effect |
|---|---|---|
| group traffic | `group:<groupId>:<template>` | ten expenses in one trip → **one** tray entry that updates |
| kameti | `kameti:<committeeId>:<template>` | one entry per committee per event kind |
| everything else | `<type>:<notificationId>` | no collapsing — two loan requests are two decisions |

The key is forwarded to FCM as `android.notification.tag` only. **`android.collapse_key` is deliberately not set**: FCM allows four distinct collapse keys per device and may discard an entire key's messages beyond that, so a user in five active groups could lose a thread. `tag` collapses in the tray with no such limit and no risk of dropped delivery.

### Burst summaries (audit N-9)

`instantNotify` used to **drop** a batch of more than three fresh rows and show nothing. It now collapses:

- ≤ 3 fresh rows → one tray entry each;
- more, from ≤ 3 distinct actors → one summary per actor ("Ali — 4 updates"), deep-linked to the newest item's target, on that item's channel;
- more actors than that → one honest total ("7 new updates in Hisaab") pointing at `/inbox`.

Summary ids are keyed `summary:<actor>:<minuteBucket>`, so repeated bursts inside the same minute replace rather than stack — the per-actor-per-minute contract.

---

## 5. Deep links

Every row carries an `href`, stamped by `tg_notifications_defaults` (M5 §3) using `notification_href_for()`. The edge function forwards it as `data.href`; the tap handler prefers it over the old type-based guess.

Three implementations must agree, and drift between them is invisible in production (the push and the in-app tap would just quietly disagree):

| Where | Function |
|---|---|
| SQL, at write time | `notification_href_for(type, group_id, template, params)` |
| TS, in-app and tier 2 | `notificationHref()` in `src/lib/notificationContent.ts` |
| TS, tier 3 tap | `hrefForPush()` in `src/lib/pushRegistration.ts` |

`src/lib/notificationContent.test.ts` pins the TS side; the migration's verification block §8 pins the SQL side against the same expectations.

Both TS entry points **refuse an `href` that is not an in-app absolute path** (`/…` but not `//…`). The value is handed to `navigate()`; a full URL or a protocol-relative path from any future writer would be an open redirect.

---

## 6. Lifecycle (audit N-12)

`prune_notifications(read_days = 90, unread_days = 180, limit = 20000)` deletes read notifications older than 90 days and unread ones older than 180. Bounded per call so a first run on a large table cannot hold a long lock; re-run until it returns 0. Supported by `idx_notifications_prune ON notifications ((read_at IS NULL), created_at)`.

Scheduling is **guarded on pg_cron being installed**, because it is not enabled by default on Supabase and the file must apply cleanly without it:

- extension present → two daily jobs, `hisaab-prune-notifications` (03:17 UTC) and `hisaab-kameti-rounds-due` (04:05 UTC);
- extension absent → the migration raises a `NOTICE` naming the exact statements to schedule.

**Dashboard alternative** (no pg_cron): Supabase Studio → Integrations → Cron, or any external scheduler, running these two daily:

```sql
SELECT public.prune_notifications();          -- lifecycle
SELECT public.notify_committee_rounds_due();  -- kameti round / payout
```

If **neither** is set up, the only consequence is: the table grows (the pre-M5 status quo) and kameti round/payout notifications never fire. Draw-completed and every other event are trigger-driven and unaffected.

The kameti sweep is idempotent within 20 hours via the `collapse_key`, so running it twice — a retry, a manual run, two schedulers — cannot double-notify.

---

## 7. App modes

**Notifications are mode-agnostic, and M5 keeps them that way.** Nothing in the migration reads `accounts`, `transactions.source_account_id`, or any other full-tracker-only artifact: group fan-out keys off `group_members`, kameti off `committee_members`, and prefs / quiet hours / pruning are per-user. A `splits_only` (ledger-only) user gets identical rows, channels and deep links to a `full_tracker` user.

The one place the distinction could have leaked in is the device-local budget reminder, which is client-side — and budgets exist in both modes.

---

## 8. Client follow-ups — not built by M5

M5 shipped the backend, the store and the delivery shaping. Three pieces of UI were left missing; **all three have since shipped** (group mute in `GroupDetailPage.tsx`, quiet hours + mute-all + the push section in `SettingsPage.tsx`, the bell via `countBellItems` in `InboxAction.tsx`), as have both one-liners in §8.4. The insertion notes below are kept as the historical plan; line numbers are stale.

### 8.1 Per-group mute toggle — `src/pages/GroupDetailPage.tsx`

The overflow menu at **line 733** (`{showMenu && (<div role="menu" …>`) already holds Leave / Transfer / Archive. Add a mute item as the first entry:

```tsx
// near line 243, beside the existing markGroupRead selector
const mutes = useNotificationStore((s) => s.mutes);
const setGroupMuted = useNotificationStore((s) => s.setGroupMuted);
const muted = mutes.mutedGroupIds instanceof Set && mutes.mutedGroupIds.has(id!);

// inside the role="menu" div, before the Leave button (~line 738)
<button
  role="menuitem"
  onClick={() => { setShowMenu(false); void setGroupMuted(id!, !muted); }}
  className="w-full px-4 py-3 text-left text-[13px] font-medium text-ink-800 active:bg-cream-soft flex items-center gap-2.5 transition-colors"
>
  {muted ? <Bell size={14} /> : <BellOff size={14} />}
  {t(muted ? 'grp_unmute' : 'grp_mute')}
</button>
```

`setGroupMuted` is already in the store (optimistic, rolls back on failure, throws so the caller can toast). Needs two i18n keys (`grp_mute` / `grp_unmute`) and the `Bell`/`BellOff` lucide imports on line 3.

Copy suggestion: mute must read as *"stop the notifications"*, never *"leave"* — a muted group still shows every expense when opened, and its `group_events` activity row is still written.

### 8.2 Quiet hours + a real push section — `src/pages/SettingsPage.tsx`

The reminders toggle lives at **lines 788–830**. Add a sibling block below it:

- two hour pickers writing `notificationPrefsDb.setQuietHours(start, end)` (already implemented; it also stores the device tz);
- a "mute everything" switch calling `notificationPrefsDb.setMuted(null, true)`.

The same screen still carries audit **N-6**: push opt-in is welded to the reminders toggle (line 812 calls `requestPushPermissionAndRegister` only when reminders are enabled), and `push_title` / `push_desc` (`i18n.ts:1973-1975`) are referenced by zero components. M5 does not fix that — the strings are still waiting for the section they were written for.

### 8.3 Bell badge — `src/components/InboxAction.tsx`

The N-7 fix is written and tested (`src/lib/notificationCounts.ts`, 15 tests) but not wired, because M5 does not own `src/components/`. Lines 18–33 currently read:

```tsx
s.requests.filter((r) => r.status === 'pending' && (r.toUserId === userId || r.fromUserId === userId)).length
```

Replace both selectors with:

```tsx
import { countIncomingPending } from '../lib/notificationCounts';
const linkedPending    = useLinkedRequestStore((s) => countIncomingPending(s.requests, userId));
const settlementPending = useSettlementRequestStore((s) => countIncomingPending(s.requests, userId));
```

Outgoing pending stays in the Outgoing tab, which `InboxPage.tsx:167-172` already computes separately — `countOutgoingPending` is exported for it.

### 8.4 Two one-liners

- **`src/lib/inboxInfo.ts:21-23`** — `isInboxInfoNotification` listed `contact_linked | system | invite`. ~~Add `'kameti'`~~ **Done differently (2026-09-03):** the allow-list was the bug. `system` and `invite` are written by nothing (§1.1), so the Info tab and the bell badge only ever counted contact pings — a user with hundreds of unread `group_update` rows saw an empty bell. The predicate is now a DENY-list: every unread row except `linked_request` / `linked_settlement` (those are mirrors of a pending request row, which `countIncomingPending` counts directly and which clears when the user acts). `isRequestMirrorNotification` in `notificationCounts.ts` owns the rule; `countBellItems` assembles the whole badge.
- **`src/App.tsx:470`** — the boot block calls `loadNotifications()`. Add `void useNotificationStore.getState().loadPrefs()` beside it, so mutes are known before the first count is rendered. Without it, the first badge of a session ignores mutes until something else triggers a prefs load.

### 8.5 Native tap handler — `src/lib/nativeBridge.ts` (not owned by M5)

Line **136** reads the deep link out of a *local* notification:

```ts
const href = (event.notification.extra as { href?: string } | undefined)?.href;
if (href) opts.navigate(href);
```

This is already correct for every local reminder and for tier 2, because `instantNotify` and `notificationPlanner` both set `extra.href`. **No change is required for tier 3** — FCM taps are handled by `pushRegistration.ts`'s own `pushNotificationActionPerformed` listener, which M5 updated to prefer `data.href`.

The one change worth making, if the maintainer of that file wants it: the `href` there is trusted unconditionally. It comes from our own scheduler today, but mirroring the guard used in the other two entry points is cheap insurance:

```ts
if (href && href.startsWith('/') && !href.startsWith('//')) opts.navigate(href);
```

---

## 9. Manual test plan

### 9.1 Database (no Firebase needed)

`./supabase/tests/run.sh` applies the whole corpus and runs `supabase/tests/tests/60-notification-maturity.sql` — 31 assertions covering routing defaults, mute suppression, `member_left`, quiet-hours wrap and timezone, kameti draw/round/payout, sweep idempotency, and pruning.

In Studio, after applying, use operator queries **Q1–Q8** in the migration footer.

### 9.2 Edge function (needs a deployed function and a real device)

The function is Deno and cannot be typechecked or run by the repo's toolchain. It was reviewed by reading. To verify on a device:

1. Deploy: `supabase functions deploy push-notify --no-verify-jwt`.
2. Confirm `app_push_config` holds `edge_url` and `edge_secret`, and `FCM_SERVICE_ACCOUNT` / `PUSH_SHARED_SECRET` are set on the function.
3. Install a build with the M5 client. Open Settings → enable reminders (this grants POST_NOTIFICATIONS and registers FCM). Confirm four channels appear in Android Settings → Apps → Hisaab → Notifications.
4. **Deep link:** from a second account, add an expense to a shared group. Kill the app. Tap the push → it must open **that group**, not `/groups`.
5. **Collapse:** post four expenses to the same group in quick succession. The tray must show **one** entry that updates, not four.
6. **Channel:** demote "Groups" to Silent in Android settings, then repeat step 4 (silent) and send a loan request (still rings) — proving the split.
7. **Quiet hours:** set a window covering now via `notificationPrefsDb.setQuietHours`, then trigger any cross-user event. The notification must appear in the tray **without sound or heads-up**, and the row must still be in the Inbox.
8. **Mute:** mute the group (§8.1, or a direct insert into `notification_prefs`), post an expense, and confirm **no** tray entry, **no** Inbox row, but the change **is** visible in the group and in the activity feed.
9. Check the function's response body — it now returns `{ sent, devices, channel, quiet, tag }`, which is enough to diagnose steps 5–7 from the logs alone.

---

## 10. Open risks

1. **Tier 3 is still believed off in production** (audit N-4). Every anti-fatigue improvement above is invisible until Firebase and `app_push_config` are set up. Nothing in this work changes that, and every layer still degrades silently by design.
2. **No web push.** Audit N-5 stands: a PWA user learns about a loan request only if a tab is open. Channels, collapse keys and quiet hours are Android concepts and buy the web surface nothing.
3. **Push text is still English.** `profiles.lang` exists (`p1-profile-lang.sql`) but nothing reads it server-side. In-app and tier-2 notifications render `template` + `params` through i18n and are correctly localized; the tier-3 tray text is the frozen server-composed `title`/`body`. That is a separate, tracked item.
4. **Channel importance is write-once.** If `money` should have been MAX rather than HIGH, existing installs will never change. Only fresh installs pick up a revision.
5. **The kameti sweep needs a scheduler.** With no pg_cron and no dashboard cron, `kameti_round_due` / `kameti_payout_due` never fire. The draw notification is trigger-driven and unaffected. There is no alert for the sweep not running — check `cron.job_run_details` (Q5) or the absence of rows in Q1.
6. **Kameti reach depends on the organiser's contact links.** A committee whose members were typed as plain names notifies nobody, and there is no UI telling the organiser that. Q6 quantifies it; a "3 of 8 members will be notified" hint on the kameti screen would close it.
7. ~~**`notification_prefs` has no UI yet** (§8).~~ Closed: the group mute (§8.1) and Settings quiet hours / mute-all (§8.2) are built, so the fatigue controls are reachable by a normal user.
8. **The prefs mirror can be stale.** The store loads prefs once; a mute set on another device is not pushed over realtime (`notification_prefs` is not in the publication). The server-side filter is authoritative, so the worst case is a locally-optimistic count until the next `loadPrefs()`.
9. **Three copies of the routing rules** (SQL, `notificationContent.ts`, `pushRegistration.ts`) must be edited together. Tests pin each side against the same expectations, but nothing mechanically diffs them.
