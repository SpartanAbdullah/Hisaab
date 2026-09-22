// Capacitor native-only initialisation. Loaded only when running inside the
// Capacitor WebView (isNativeRuntime() true). The dynamic imports keep these
// plugin entry-points out of the web bundle.
//
// Wires:
//   - Status bar colour + style (Sukoon navy + light icons)
//   - Splash screen (auto-hides after the React tree first paints)
//   - Hardware back button → React Router history.back() / app exit
//   - Deep links → react-router navigate() for `/join/:token` etc.
//
// Call once from App.tsx after the router is mounted. Safe to call again on
// hot-reload — every listener registration tracks its handle and re-uses it.

import { isNativeRuntime } from './runtime';
import { extractDeepLinkPath } from './deepLinkRoute';
import { rescheduleNotifications } from './notificationScheduler';
import { resumeGlobalRealtime } from './realtime';
import { installWidgetSync, scheduleWidgetRefresh } from './widgetBridge';
import { useUIStore } from '../stores/uiStore';
import { track } from './telemetry';

type NavigateFn = (to: string, opts?: { replace?: boolean }) => void;
type CanGoBackFn = () => boolean;

let initialised = false;

// "Nothing today" from the notification: close the day, then say so. The
// action launches the app (possibly cold), so wait for the stored session
// before the write — an early call would reach the server unauthenticated.
async function closeTodayFromNotification(): Promise<void> {
  const [{ supabase }, { useDailyCloseStore }, { useTransactionStore }, { computeCloseStreak }, { useToast }, { tStatic }] =
    await Promise.all([
      import('./supabase'),
      import('../stores/dailyCloseStore'),
      import('../stores/transactionStore'),
      import('./dailyClose'),
      import('../components/Toast'),
      import('./i18n'),
    ]);
  try {
    await supabase.auth.getSession();
    await useDailyCloseStore.getState().closeDay('no_spend');
    const streak = computeCloseStreak(
      useTransactionStore.getState().transactions,
      useDailyCloseStore.getState().closes,
      new Date().toISOString(),
    ).streak;
    useToast.getState().show({ type: 'success', title: tStatic('close_toast_closed').replace('{n}', String(streak)) });
  } catch {
    useToast.getState().show({ type: 'error', title: tStatic('close_save_failed') });
  }
}

export async function initNativeBridge(opts: {
  navigate: NavigateFn;
  canGoBack: CanGoBackFn;
}): Promise<void> {
  if (initialised) return;
  if (!isNativeRuntime()) return;
  initialised = true;

  try {
    const { App: CapApp } = await import('@capacitor/app');
    const { StatusBar, Style } = await import('@capacitor/status-bar');
    const { SplashScreen } = await import('@capacitor/splash-screen');

    // Status bar: the 1d hero base, light icons (the hero is dark in both
    // themes). Try/catch each call so a single plugin failure doesn't abort
    // the rest of the boot.
    StatusBar.setBackgroundColor({ color: '#0A0A14' }).catch(() => {});
    StatusBar.setStyle({ style: Style.Dark }).catch(() => {});
    StatusBar.setOverlaysWebView({ overlay: false }).catch(() => {});

    // The native splash auto-hides after launchShowDuration, but call hide()
    // anyway in case the React tree paints faster — avoids a brief blank
    // screen between Capacitor's splash and the first paint.
    SplashScreen.hide().catch(() => {});

    // Hardware back button → router history when there's something to pop,
    // otherwise exit the app. This is the single most important Capacitor
    // wire-up: without it, every back press kills the app immediately.
    CapApp.addListener('backButton', () => {
      // A back press first dismisses the topmost open modal (closing it, or
      // prompting to discard unsaved input) instead of navigating the page
      // underneath. Only when nothing is open do we pop history / exit.
      if (useUIStore.getState().closeTopModal()) return;
      if (opts.canGoBack()) {
        window.history.back();
      } else {
        CapApp.exitApp();
      }
    });

    // Deep links — two delivery paths for the SAME https://usehisaab.com/join/XYZ
    // (or capacitor://) URL, and both must be wired or one class of tap is
    // silently dropped (MF-03, docs/audit-2026-09/07-mobile-first.md):
    //   - `appUrlOpen` fires from Capacitor's App plugin only when the
    //     singleTask MainActivity is already running (`onNewIntent`) — a
    //     WARM start.
    //   - `getLaunchUrl()` below is the only way to see the VIEW intent that
    //     CREATED the activity — a COLD start (app was killed, user tapped
    //     an invite/witness link). This is the common case for the
    //     receiving side of a WhatsApp invite, the app's primary
    //     acquisition loop.
    // On some OS/Capacitor combinations a cold start can ALSO fire
    // `appUrlOpen` once in addition to being visible via `getLaunchUrl()`;
    // the time-boxed dedupe below collapses that into a single navigate().
    let lastDeepLinkUrl: string | null = null;
    let lastDeepLinkAt = 0;
    const DEEP_LINK_DEDUPE_MS = 2000;
    const handleDeepLink = (url: string) => {
      const now = Date.now();
      if (url === lastDeepLinkUrl && now - lastDeepLinkAt < DEEP_LINK_DEDUPE_MS) return;
      lastDeepLinkUrl = url;
      lastDeepLinkAt = now;
      const path = extractDeepLinkPath(url);
      if (path) opts.navigate(path, { replace: true });
    };

    CapApp.addListener('appUrlOpen', ({ url }) => handleDeepLink(url));

    // Cold start: read whatever VIEW intent launched the activity, if any.
    // Called after the listener above is attached — not before — so a race
    // where the OS also fires `appUrlOpen` immediately doesn't slip past an
    // unregistered listener; the dedupe above then collapses the two into a
    // single navigate() either way.
    CapApp.getLaunchUrl()
      .then((result) => {
        if (result?.url) handleDeepLink(result.url);
      })
      .catch(() => {
        // No launch URL, or the plugin doesn't support it on this OS
        // version — a plain app launch, nothing to route.
      });

    // App resume — fired when the user brings Hisaab back to the
    // foreground after backgrounding it. Supabase's JS client refreshes
    // its session automatically on most events, but the access-token
    // refresh job pauses while the WebView is suspended, so after a long
    // background the cached session can be stale. Explicitly nudging
    // getSession() forces a refresh-and-reload of `auth.user` so any
    // gated UI re-evaluates with the live state.
    CapApp.addListener('appStateChange', ({ isActive }) => {
      if (!isActive) return;
      // Dynamic import so we don't pay this dependency cost on web boot.
      import('./supabase')
        .then(({ supabase }) => supabase.auth.getSession())
        .catch((err) => {
          console.error('[nativeBridge] session refresh on resume failed', err);
        });
      // Re-derive the reminder schedule from live state on every resume —
      // anything the user paid while the app was open (or on another
      // device, once stores refresh) stops ringing here.
      void rescheduleNotifications();
      // The realtime websocket does NOT survive the WebView being suspended.
      // Without this the app came back subscribed-in-name-only and showed
      // stale data until the user force-closed it — the single biggest cause
      // of "the notification took ages / only showed after a restart".
      resumeGlobalRealtime();
      // The home-screen widget's "today" may have rolled over while we were
      // backgrounded — rewrite its snapshot (debounced, no-op if unchanged).
      scheduleWidgetRefresh();
    });

    // Home-screen widget: keep its snapshot in step with today's entries,
    // closes, app mode and language (src/lib/widgetBridge.ts).
    installWidgetSync();

    // Notification taps route into the app (href stashed at schedule time).
    try {
      const { LocalNotifications } = await import('@capacitor/local-notifications');
      void LocalNotifications.addListener('localNotificationActionPerformed', (event) => {
        // The evening nudge's buttons (planner section 7). 'tap' (the body)
        // falls through to the href below like every other reminder.
        if (event.actionId === 'log') {
          opts.navigate('/?add=expense');
          track('notification_opened', { type: 'reminder' });
          return;
        }
        if (event.actionId === 'none') {
          void closeTodayFromNotification();
          track('notification_opened', { type: 'reminder' });
          return;
        }
        const href = (event.notification.extra as { href?: string } | undefined)?.href;
        // Mirrors pushRegistration.ts's hrefForPush guard: only an in-app
        // absolute path is navigable — a full URL or a protocol-relative
        // "//evil" is refused rather than handed to navigate().
        if (href && href.startsWith('/') && !href.startsWith('//')) {
          opts.navigate(href);
          // Catalog #25. Every locally-scheduled notification IS a payment/
          // kameti/etc. reminder by construction — 'reminder', not the
          // destination-based classification FCM taps use.
          track('notification_opened', { type: 'reminder' });
        }
      });
    } catch {
      // Plugin unavailable (older binary) — reminders simply stay off.
    }
  } catch (err) {
    console.error('[nativeBridge] init failed', err);
  }
}
