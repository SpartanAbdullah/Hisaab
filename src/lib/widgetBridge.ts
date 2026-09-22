// JS → Android home-screen widget. Writes the pure snapshot from
// widgetSnapshot.ts into @capacitor/preferences (Android SharedPreferences
// file "CapacitorStorage", key "widget_snapshot" — the plugin's default group
// stores keys verbatim), then asks the native HisaabWidget plugin to redraw
// every placed widget. No-op on web.
//
// PRIVACY: see widgetSnapshot.ts — counts and the streak only, never amounts,
// balances or names. Sign-out clears the snapshot (supabaseAuthStore).
//
// Triggers: instead of threading a call through every money path, the sync
// subscribes to the stores the status is derived from (transactions, daily
// closes, app mode, language) — every add/edit/delete/undo, close/reopen,
// realtime refresh or load lands here — plus app resume (nativeBridge).
// Debounced, and a snapshot that would render identically is not rewritten.
import { isNativeRuntime } from './runtime';
import { tStatic, useI18nStore } from './i18n';
import { localIso } from './localDate';
import { computeCloseStreak, dayActivity } from './dailyClose';
import { buildWidgetSnapshot, snapshotRenderKey, WIDGET_SNAPSHOT_KEY } from './widgetSnapshot';
import { useTransactionStore } from '../stores/transactionStore';
import { useDailyCloseStore } from '../stores/dailyCloseStore';
import { useAppModeStore } from '../stores/appModeStore';

interface HisaabWidgetPlugin {
  refresh(): Promise<void>;
}

// Native side: android/app/src/main/java/com/usehisaab/app/widget/HisaabWidgetPlugin.java.
// An older binary without it rejects with UNIMPLEMENTED — swallowed below; the
// widget's 30-minute periodic update still picks the snapshot up. Registered
// lazily so @capacitor/core stays out of the web boot path.
let plugin: HisaabWidgetPlugin | null = null;

const DEBOUNCE_MS = 1500;
let timer: ReturnType<typeof setTimeout> | null = null;
let lastRenderKey: string | null = null;
// Set by a sign-out clear; lifted only when a user signs in again, so a
// debounced write already in flight can't put the previous account's
// status back on the home screen.
let blocked = false;
let installed = false;

async function refreshNative(): Promise<void> {
  try {
    if (!plugin) {
      const { registerPlugin } = await import('@capacitor/core');
      plugin = registerPlugin<HisaabWidgetPlugin>('HisaabWidget');
    }
    await plugin.refresh();
  } catch {
    // Plugin missing (older APK) — periodic update covers it.
  }
}

async function signedIn(): Promise<boolean> {
  // Dynamic: the auth store imports this module for the sign-out clear.
  const { useSupabaseAuthStore } = await import('../stores/supabaseAuthStore');
  return useSupabaseAuthStore.getState().user !== null;
}

async function pushSnapshot(): Promise<void> {
  if (blocked || !(await signedIn())) return;
  const ledgerOnly = useAppModeStore.getState().mode === 'splits_only';
  const txState = useTransactionStore.getState();
  // A cold store would read as "nothing today" — wait for the load, whose
  // completion re-triggers this through the subscription.
  if (txState.loading && txState.transactions.length === 0) return;
  if (!ledgerOnly && !useDailyCloseStore.getState().loaded) {
    await useDailyCloseStore.getState().load();
  }
  if (blocked) return;

  const now = new Date();
  const day = localIso(now);
  const { transactions } = useTransactionStore.getState();
  const { closes } = useDailyCloseStore.getState();
  const activity = dayActivity(transactions, closes, day);
  const streak = ledgerOnly ? 0 : computeCloseStreak(transactions, closes, day).streak;
  const snapshot = buildWidgetSnapshot(
    {
      ledgerOnly,
      entriesToday: activity.entriesToday.length,
      closedToday: activity.closedToday !== null,
      streak,
      day,
      nowMs: now.getTime(),
    },
    tStatic,
  );
  const key = snapshotRenderKey(snapshot);
  if (key === lastRenderKey) return;

  const { Preferences } = await import('@capacitor/preferences');
  if (blocked) return;
  await Preferences.set({ key: WIDGET_SNAPSHOT_KEY, value: JSON.stringify(snapshot) });
  lastRenderKey = key;
  await refreshNative();
}

/** Debounced snapshot rewrite + widget redraw. Cheap to call often. */
export function scheduleWidgetRefresh(): void {
  if (!isNativeRuntime()) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void pushSnapshot().catch((err) => {
      console.error('[widget] snapshot write failed (non-fatal)', err);
    });
  }, DEBOUNCE_MS);
}

/** Sign-out teardown: drop the snapshot so the home screen stops showing the
 *  leaving account's status, and redraw the widget to its neutral state.
 *  Never throws. */
export async function clearWidgetSnapshot(): Promise<void> {
  if (!isNativeRuntime()) return;
  blocked = true;
  lastRenderKey = null;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  try {
    const { Preferences } = await import('@capacitor/preferences');
    await Preferences.remove({ key: WIDGET_SNAPSHOT_KEY });
  } catch (err) {
    console.error('[widget] snapshot clear failed (non-fatal)', err);
  }
  await refreshNative();
}

/** Wire the store subscriptions once (native only; called by nativeBridge). */
export function installWidgetSync(): void {
  if (installed || !isNativeRuntime()) return;
  installed = true;
  useTransactionStore.subscribe((s, prev) => {
    if (s.transactions !== prev.transactions || s.loading !== prev.loading) scheduleWidgetRefresh();
  });
  useDailyCloseStore.subscribe((s, prev) => {
    if (s.closes !== prev.closes) scheduleWidgetRefresh();
  });
  useAppModeStore.subscribe((s, prev) => {
    if (s.mode !== prev.mode) scheduleWidgetRefresh();
  });
  useI18nStore.subscribe((s, prev) => {
    if (s.lang !== prev.lang) scheduleWidgetRefresh();
  });
  void import('../stores/supabaseAuthStore').then(({ useSupabaseAuthStore }) => {
    // A boot-time "no session" clear can land before this listener exists;
    // a user already signed in by now must not stay blocked.
    if (useSupabaseAuthStore.getState().user) blocked = false;
    useSupabaseAuthStore.subscribe((s, prev) => {
      if (s.user && !prev.user) {
        blocked = false;
        scheduleWidgetRefresh();
      }
    });
  });
  scheduleWidgetRefresh();
}
