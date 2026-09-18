import { useEffect, useState, useRef, lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useLocation, useNavigate, useNavigationType } from 'react-router-dom';
import { BottomNav } from './components/BottomNav';
import { ToastContainer } from './components/Toast';
import { ConfirmDestructiveSheet } from './components/ConfirmDestructiveSheet';
import { ErrorBoundary } from './components/ErrorBoundary';
import { useOnboardingStore } from './stores/onboardingStore';
import { useAppModeStore } from './stores/appModeStore';
import { useSupabaseAuthStore } from './stores/supabaseAuthStore';
import { usePersonStore } from './stores/personStore';
import { useLinkedRequestStore } from './stores/linkedRequestStore';
import { useNotificationStore } from './stores/notificationStore';
import { useSplitStore } from './stores/splitStore';
import { useSettlementRequestStore } from './stores/settlementRequestStore';
import { useBudgetStore } from './stores/budgetStore';
import { useCustomCategoryStore } from './stores/customCategoryStore';
import { useCommitteeStore } from './stores/committeeStore';
import { useRecurringStore } from './stores/recurringStore';
import { useAccountStore } from './stores/accountStore';
import { runRecurringExpansion } from './lib/recurringRunner';
import { runPersonBackfillIfNeeded } from './lib/migrations/backfillPersons';
import { PWAInstallPrompt } from './components/PWAInstallPrompt';
import { useContactLinkStore } from './stores/contactLinkStore';
import { startGlobalRealtime, stopGlobalRealtime, resumeGlobalRealtime } from './lib/realtime';
import { startPushRegistration, stopPushRegistration } from './lib/pushRegistration';
import { supabase } from './lib/supabase';
import { initNativeBridge } from './lib/nativeBridge';
import { isNativeRuntime } from './lib/runtime';
import { useAuthStore } from './stores/authStore';
import { PIN_RELOCK_AFTER_MS } from './lib/pinCrypto';
import { identify, resetTelemetryIdentity } from './lib/telemetry';
// Statically imported on purpose: a lazy chunk that fails to load (offline, or
// a stale deploy) must never be the reason the PIN gate silently doesn't render.
import { PinLockScreen } from './pages/PinLockScreen';
// Same reasoning as PinLockScreen: the version gate exists precisely for stale
// builds, so its screen must not depend on fetching a chunk from a deploy the
// running bundle may no longer match.
import { UpdateRequiredScreen } from './components/UpdateRequiredScreen';
import { appConfigDb } from './lib/supabaseDb';
import {
  getCurrentAppVersion,
  isSupported,
  resolveVersionIdentity,
  type AppVersionConfig,
  type AppVersionIdentity,
} from './lib/versionGate';
import { useT, useI18nStore, reconcileProfileLang } from './lib/i18n';
import { Glyph } from './components/Glyph';
import { LanguageToggle } from './components/LanguageToggle';

// Lazy-loaded pages for code splitting
const AuthPage = lazy(() => import('./pages/AuthPage').then(m => ({ default: m.AuthPage })));
const OnboardingPage = lazy(() => import('./pages/OnboardingPage').then(m => ({ default: m.OnboardingPage })));
const HomePage = lazy(() => import('./pages/HomePage').then(m => ({ default: m.HomePage })));
const TransactionsPage = lazy(() => import('./pages/TransactionsPage').then(m => ({ default: m.TransactionsPage })));
const LoansPage = lazy(() => import('./pages/LoansPage').then(m => ({ default: m.LoansPage })));
const LoanDetailPage = lazy(() => import('./pages/LoanDetailPage').then(m => ({ default: m.LoanDetailPage })));
const GoalsPage = lazy(() => import('./pages/GoalsPage').then(m => ({ default: m.GoalsPage })));
const ActivityPage = lazy(() => import('./pages/ActivityPage').then(m => ({ default: m.ActivityPage })));
const AccountDetailPage = lazy(() => import('./pages/AccountDetailPage').then(m => ({ default: m.AccountDetailPage })));
const AccountsPage = lazy(() => import('./pages/AccountsPage').then(m => ({ default: m.AccountsPage })));
const ContactsPage = lazy(() => import('./pages/ContactsPage').then(m => ({ default: m.ContactsPage })));
const SplitsPage = lazy(() => import('./pages/SplitsPage').then(m => ({ default: m.SplitsPage })));
const GroupDetailPage = lazy(() => import('./pages/GroupDetailPage').then(m => ({ default: m.GroupDetailPage })));
const JoinGroupPage = lazy(() => import('./pages/JoinGroupPage').then(m => ({ default: m.JoinGroupPage })));
const AnalyticsPage = lazy(() => import('./pages/AnalyticsPage').then(m => ({ default: m.AnalyticsPage })));
const SettingsPage = lazy(() => import('./pages/SettingsPage').then(m => ({ default: m.SettingsPage })));
const InboxPage = lazy(() => import('./pages/InboxPage').then(m => ({ default: m.InboxPage })));
const BudgetsPage = lazy(() => import('./pages/BudgetsPage').then(m => ({ default: m.BudgetsPage })));
const SubscriptionsPage = lazy(() => import('./pages/SubscriptionsPage').then(m => ({ default: m.SubscriptionsPage })));
const KametiPage = lazy(() => import('./pages/KametiPage').then(m => ({ default: m.KametiPage })));
const KametiDetailPage = lazy(() => import('./pages/KametiDetailPage').then(m => ({ default: m.KametiDetailPage })));
const InvestmentsPage = lazy(() => import('./pages/InvestmentsPage').then(m => ({ default: m.InvestmentsPage })));
const HoldingDetailPage = lazy(() => import('./pages/HoldingDetailPage').then(m => ({ default: m.HoldingDetailPage })));
const KametiWitnessPage = lazy(() => import('./pages/KametiWitnessPage').then(m => ({ default: m.KametiWitnessPage })));
const KhataLinkPage = lazy(() => import('./pages/KhataLinkPage').then(m => ({ default: m.KhataLinkPage })));
const HisaabAIPage = lazy(() => import('./pages/HisaabAIPage').then(m => ({ default: m.HisaabAIPage })));
const InsightDetailPage = lazy(() => import('./pages/InsightDetailPage').then(m => ({ default: m.InsightDetailPage })));
const PublicInfoPage = lazy(() => import('./pages/PublicInfoPages').then(m => ({ default: m.PublicInfoPage })));
const ConnectByCodePage = lazy(() => import('./pages/ConnectByCodePage').then(m => ({ default: m.ConnectByCodePage })));

// Quick Entry is the only modal launched globally (from the BottomNav FAB).
// The Add Goal / Add Loan / Add Upcoming Expense modals are owned by their
// respective pages and triggered by inline "+" buttons there.
//
// AddGroupExpenseModal + CreateGroupModal ALSO live here at app level —
// the FAB-driven "Group expense" path in QuickEntry hands off to them so
// the user can pick (or create) a group without losing the amount they
// already typed. GroupDetailPage still uses its own local instance of
// AddGroupExpenseModal for the inline "+ Add expense" button.
//
// ── All six are LAZY + mounted on first trigger (audit 03-performance H1 /
//    P2 M2c, docs/performance.md §6.5) ──────────────────────────────────────
// They used to be static imports, which put ~all of QuickEntry (2.2k lines),
// both group-expense modals, and — through MonthlyWrapModal → wrapCard.ts →
// renderNodeToImage.ts — jspdf + modern-screenshot into the eager import graph
// of every cold boot, PWA and bundled-in-the-APK Android alike.
//
// The rule for each: the TRIGGER stays eager and unchanged (it is a state flag,
// a window event listener, or two localStorage reads — all free); only the
// COMPONENT is deferred, and it is fetched the moment its trigger fires.
const QuickEntry = lazy(() => import('./pages/QuickEntry').then(m => ({ default: m.QuickEntry })));
const AddGroupExpenseModal = lazy(() => import('./pages/AddGroupExpenseModal').then(m => ({ default: m.AddGroupExpenseModal })));
const CreateGroupModal = lazy(() => import('./pages/CreateGroupModal').then(m => ({ default: m.CreateGroupModal })));
const RecurringDuePrompt = lazy(() => import('./components/RecurringDuePrompt').then(m => ({ default: m.RecurringDuePrompt })));
const MonthlyWrapModal = lazy(() => import('./components/MonthlyWrapModal').then(m => ({ default: m.MonthlyWrapModal })));
const DailyQuote = lazy(() => import('./components/DailyQuote').then(m => ({ default: m.DailyQuote })));

import { OfflineBanner } from './components/OfflineBanner';
import { AppLoadingScreen } from './components/AppLoadingScreen';
import { GlobalChunkRecoveryOverlay } from './components/GlobalChunkRecoveryOverlay';
import { getPendingInviteResumePath, savePendingInvite } from './lib/pendingInvite';
import { shouldShowDailyQuote } from './lib/dailyQuotePrefs';
import type { WrapStats } from './lib/monthlyWrap';
import type { RecurringDueDetail } from './lib/recurringRunner';
import type { RecurringTransaction, SplitGroup } from './db';

function PageLoader() {
  return <AppLoadingScreen />;
}

// requestIdleCallback where it exists (not Safari/iOS), a macrotask otherwise.
function onIdle(fn: () => void, timeout = 3000): () => void {
  const w = window as Window & {
    requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
    cancelIdleCallback?: (handle: number) => void;
  };
  if (typeof w.requestIdleCallback === 'function') {
    const handle = w.requestIdleCallback(fn, { timeout });
    return () => w.cancelIdleCallback?.(handle);
  }
  const handle = setTimeout(fn, timeout);
  return () => clearTimeout(handle);
}

// Native only (no-op on web): rebuild the local reminder schedule from the
// freshly loaded state. Kept as a module-level helper because BOTH boot
// branches need it — full_tracker chains it after the recurring templates
// land, splits_only (which has no recurring templates) calls it directly.
// Never rejects: a missing plugin must not surface as an unhandled rejection.
function rescheduleLocalNotifications(): Promise<void> {
  return import('./lib/notificationScheduler')
    .then((m) => m.rescheduleNotifications())
    .catch(() => {});
}

function UnverifiedEmailScreen({ email }: { email: string }) {
  const { signOut } = useSupabaseAuthStore();
  const t = useT();
  const [resending, setResending] = useState(false);
  const [resendMessage, setResendMessage] = useState('');

  const resend = async () => {
    if (!email) return;
    setResending(true);
    setResendMessage('');
    try {
      const { error } = await supabase.auth.resend({ type: 'signup', email });
      setResendMessage(error ? error.message : t('verify_resent'));
    } finally {
      setResending(false);
    }
  };

  // Signup with email confirmation leaves no session, so the only way forward
  // is the login form. Flag it so AuthPage greets them with a success banner
  // instead of a bare form, then drop to login via signOut (which clears the
  // transient unconfirmed user). Previously this reloaded and dumped the user
  // on a plain Login screen with no explanation.
  const goLogin = () => {
    sessionStorage.setItem('hisaab_just_verified', '1');
    void signOut();
  };

  // 1d: the hero ground (dark in both themes; .auth-ink-dark flips the ink
  // ramp for the material inside), a mint plate with the mail glyph, the violet
  // primary and the key-material secondary.
  return (
    <div className="auth-ink-dark min-h-dvh relative flex flex-col items-center justify-center bg-navy-bloom text-white px-8 text-center">
      <LanguageToggle className="absolute top-5 right-5 z-50" />
      <div className="m-plate m-mint mb-6" aria-hidden>
        <Glyph name="mail" tone="green" size={26} extrude />
      </div>
      <h1 className="text-[24px] font-semibold tracking-[-0.02em] mb-3">{t('verify_title')}</h1>
      <p className="text-white/70 text-[13px] max-w-[300px] leading-relaxed">{t('verify_body')}</p>
      <p className="text-white text-[14px] font-semibold mt-1.5 break-all max-w-[300px]">{email || '—'}</p>
      <p className="text-white/60 text-[12px] max-w-[290px] leading-relaxed mt-4">{t('verify_instruction')}</p>
      <p className="text-white/60 text-[11px] max-w-[290px] leading-relaxed mt-2">{t('verify_spam')}</p>

      <div className="w-full max-w-[300px] mt-8 space-y-3">
        <button
          onClick={goLogin}
          className="m-btn m-btn-primary w-full py-4 text-[14px]"
        >
          {t('verify_done_login')}
        </button>
        <button
          onClick={resend}
          disabled={resending || !email}
          className="m-btn m-btn-plain w-full py-3.5 text-[13px]"
        >
          {resending ? t('verify_resending') : t('verify_resend')}
        </button>
      </div>

      {resendMessage && (
        <p className="text-receive-text text-[12px] mt-4 max-w-[290px] leading-relaxed">{resendMessage}</p>
      )}

      <button onClick={() => signOut()} className="text-white/70 text-[11.5px] underline underline-offset-2 mt-6 min-h-[44px]">
        {t('verify_diff_account')}
      </button>
    </div>
  );
}

// ── Minimum-supported-version gate (audit H9 / MF-12) ───────────────────────
// Hisaab's three release tracks (Vercel-on-push web, hand-built Play AAB,
// hand-applied SQL) are unsynchronised by construction, so an installed binary
// can be weeks behind the schema it is calling. This hook fetches the
// `app_config` singleton once at boot and hands AppContent a hard block when
// this build is below the floor. See src/lib/versionGate.ts for the release
// policy and supabase-migration-p1-app-config.sql for the row.
//
// FAILS OPEN, always: no config row, an unapplied migration, a thrown fetch, a
// dead network — every one of those resolves to "allowed". Locking a working
// client out because a request timed out on 3G would be a far worse bug than
// the skew this defends against, and is only undoable from Supabase Studio.
//
// Mode-agnostic: nothing here reads appModeStore.
const VERSION_RECHECK_MS = 10 * 60 * 1000;

function useVersionGate(): {
  blocked: boolean;
  config: AppVersionConfig | null;
  version: string;
} {
  const [config, setConfig] = useState<AppVersionConfig | null>(null);
  const [identity, setIdentity] = useState<AppVersionIdentity | null>(null);
  const lastCheckedAt = useRef(0);

  useEffect(() => {
    let cancelled = false;

    const check = async () => {
      // Throttle: boot always checks (lastCheckedAt = 0); resumes re-check at
      // most every 10 minutes, so an operator lowering a mistaken floor is
      // picked up without a reinstall, and a raised floor reaches a
      // long-running session without a cold start.
      const now = Date.now();
      if (now - lastCheckedAt.current < VERSION_RECHECK_MS) return;
      lastCheckedAt.current = now;
      try {
        const [resolved, row] = await Promise.all([
          resolveVersionIdentity(),
          appConfigDb.get(),
        ]);
        if (cancelled) return;
        setIdentity(resolved);
        setConfig(row);
      } catch (err) {
        // Deliberately does NOT clear a previously fetched config: a failed
        // re-check must not un-block a client we already know is too old.
        // Allow a retry sooner than the full interval.
        lastCheckedAt.current = 0;
        console.error('appConfig check failed (non-fatal, failing open)', err);
      }
    };

    void check();

    // Resume re-check. Covers web/PWA tab returns and — because the Capacitor
    // WebView fires visibilitychange on foreground too — the native app.
    const onVisible = () => {
      if (document.visibilityState === 'visible') void check();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', onVisible);
    };
  }, []);

  return {
    // `identity === null` means we have not completed a check yet → allowed.
    blocked: identity !== null && !isSupported(identity, config),
    config,
    version: identity?.current ?? getCurrentAppVersion(),
  };
}

function AppContent() {
  const { completed, loading: onboardingLoading, checkOnboarding } = useOnboardingStore();
  const mode = useAppModeStore(s => s.mode);
  const setMode = useAppModeStore(s => s.setMode);
  const { user, loading: authLoading, initialize } = useSupabaseAuthStore();
  const navigate = useNavigate();
  const location = useLocation();
  const [showQuickEntry, setShowQuickEntry] = useState(false);
  // QuickEntry → Group expense bridge: when the user picks a group inside
  // QuickEntry, we close it and open AddGroupExpenseModal with the
  // already-typed amount. When they pick "Create new group" instead,
  // we open CreateGroupModal first and chain into AddGroupExpenseModal
  // once the new group is created.
  const [groupExpenseTarget, setGroupExpenseTarget] =
    useState<{ group: SplitGroup; amount: string } | null>(null);
  const [createGroupForExpense, setCreateGroupForExpense] =
    useState<{ amount: string } | null>(null);

  // ── Lazy-modal triggers (audit H1 / P2 M2c) ──────────────────────────────
  // Each of these three modals used to self-trigger from inside its own
  // component, which meant the component had to be mounted — and therefore
  // downloaded and parsed — on every single boot just to find out that it had
  // nothing to show. The trigger now lives here (cheap: an event listener, two
  // localStorage reads, one deferred pure computation) and the component is
  // fetched only when the answer is yes.
  const [recurringDue, setRecurringDue] = useState<RecurringTransaction[] | null>(null);
  const [wrapStats, setWrapStats] = useState<WrapStats | null>(null);
  const [showDailyQuote, setShowDailyQuote] = useState(false);
  // QuickEntry and CreateGroupModal are driven by an `open` prop and animate on
  // the way OUT, so once opened they stay MOUNTED for the rest of the session:
  // unmounting them the instant `open` goes false would cut the exit transition,
  // and re-opening must not re-suspend on a chunk the browser already has.
  // Latched by the same handlers that open them — never derived in an effect.
  const [quickEntryMounted, setQuickEntryMounted] = useState(false);
  const [createGroupMounted, setCreateGroupMounted] = useState(false);

  // Version compatibility. Runs unconditionally (hook rules); the block it
  // produces is rendered down with the other gates. Fails open — see
  // useVersionGate above.
  const versionGate = useVersionGate();

  useEffect(() => {
    initialize();
  }, [initialize]);

  // Onboarding is gated on a known user — the DB check requires the uid
  // written by `initialize()`. Running it on mount caused a race where the
  // check would fall back to an unset localStorage flag and briefly show
  // OnboardingPage to a returning user.
  useEffect(() => {
    if (!authLoading) checkOnboarding();
  }, [authLoading, user?.id, checkOnboarding]);

  useEffect(() => {
    if (!user && location.pathname.startsWith('/join/')) {
      savePendingInvite(location.pathname.replace('/join/', ''));
    }
  }, [location.pathname, user]);

  // Capacitor native bridge — initialised once after the router is available.
  // No-op on web. Wires status bar, splash, hardware back button, deep links.
  useEffect(() => {
    void initNativeBridge({
      navigate: (to, opts) => navigate(to, opts),
      // We never want to "exit" while a modal/sheet is open — but Capacitor's
      // back-button only fires when the system gesture wasn't handled, and
      // modals are click-outside-to-close already.
      //
      // Audit MF-07: `history.length` counts every session entry and never
      // decreases on back-navigation, so after the first in-app navigation
      // it's permanently > 1 — back on the home screen called
      // `window.history.back()` (a no-op at the start of history) instead of
      // `CapApp.exitApp()`, which read as a hang. React Router 7 stamps
      // `{ idx }` into `history.state` for every entry it creates (0 at the
      // initial entry), so `idx > 0` is the correct "is there somewhere to
      // go back to" check.
      canGoBack: () => ((window.history.state as { idx?: number } | null)?.idx ?? 0) > 0,
    });
  }, [navigate]);

  // Realtime: subscribe when we know who the user is, tear down on signout.
  // Fires loadGroups / loadNotifications on relevant row changes so the user
  // doesn't need to refresh to see a new group they were added to or new
  // in-app notifications.
  useEffect(() => {
    if (!user?.id) {
      stopGlobalRealtime();
      return;
    }
    startGlobalRealtime(user.id);
    return () => stopGlobalRealtime();
  }, [user?.id]);

  // Resume: a backgrounded tab/app loses its realtime socket without any
  // error surfacing, so coming back has to re-establish it AND refetch —
  // a missed event leaves nothing behind to detect. Capacitor's own
  // appStateChange hook does the same on native (see nativeBridge.ts);
  // these listeners cover web, PWA, and the WebView's own visibility
  // transitions.
  useEffect(() => {
    if (!user?.id) return;
    const onVisible = () => {
      if (document.visibilityState === 'visible') resumeGlobalRealtime();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', resumeGlobalRealtime);
    window.addEventListener('focus', onVisible);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', resumeGlobalRealtime);
      window.removeEventListener('focus', onVisible);
    };
  }, [user?.id]);

  // ── Device PIN gate (audit H7 / QA F-1) ────────────────────────────────
  // PinLockScreen used to have zero importers: Settings could set a PIN and the
  // Play listing sold it, but the app opened straight to Home. The gate now
  // covers (a) cold start — authStore boots isLocked=true whenever a PIN record
  // exists — and (b) resume, once the app has been backgrounded for at least
  // PIN_RELOCK_AFTER_MS. It renders BELOW the auth / email-verification /
  // onboarding gates and below the public routes, so none of those are covered.
  // App-mode independent: full_tracker and splits_only share this shell.
  const hasPin = useAuthStore((s) => s.hasPin);
  const isPinLocked = useAuthStore((s) => s.isLocked);
  const backgroundedAt = useRef<number | null>(null);
  useEffect(() => {
    if (!user?.id) return;
    const onHidden = () => {
      // First hidden event wins: don't restart the clock on a repeat.
      if (backgroundedAt.current === null) backgroundedAt.current = Date.now();
    };
    const onShown = () => {
      const since = backgroundedAt.current;
      backgroundedAt.current = null;
      if (since !== null && Date.now() - since >= PIN_RELOCK_AFTER_MS) {
        // lock() re-derives hasPin from storage, so this is a no-op when the
        // user has no PIN set.
        useAuthStore.getState().lock();
      }
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') onHidden();
      else onShown();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    // Safari/iOS PWA can fire pagehide without a visibilitychange.
    window.addEventListener('pagehide', onHidden);

    // Native: the WebView is suspended wholesale, and Capacitor's lifecycle
    // event is the dependable signal there (see lib/nativeBridge.ts for the
    // same dynamic-import pattern). Its own appStateChange listener stays as
    // it is — Capacitor allows multiple listeners per event.
    let cancelled = false;
    let removeNative: (() => void) | undefined;
    if (isNativeRuntime()) {
      void import('@capacitor/app')
        .then(({ App: CapApp }) =>
          CapApp.addListener('appStateChange', ({ isActive }) => {
            if (isActive) onShown();
            else onHidden();
          }),
        )
        .then((handle) => {
          if (cancelled) void handle.remove();
          else removeNative = () => { void handle.remove(); };
        })
        .catch(() => {
          // Plugin unavailable — visibilitychange still covers most resumes.
        });
    }

    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('pagehide', onHidden);
      removeNative?.();
    };
  }, [user?.id]);

  // FCM registration. No-op on web and on a native build without Firebase
  // config — see docs/push-notifications-setup.md.
  useEffect(() => {
    if (!user?.id) {
      void stopPushRegistration();
      // This is App.tsx's user-became-null backstop (see pushRegistration.ts's
      // stopPushRegistration docstring) — the natural place to also drop the
      // telemetry identity so the next signed-in user on this device is never
      // merged into the previous one.
      resetTelemetryIdentity();
      return;
    }
    void startPushRegistration((to) => navigate(to));
  }, [user?.id, navigate]);

  useEffect(() => {
    if (!user?.id) return;
    void usePersonStore.getState().loadPersons().catch((err) => {
      console.error('loadPersons failed (non-fatal)', err);
    });
    void useLinkedRequestStore.getState().loadRequests().catch((err) => {
      console.error('loadRequests failed (non-fatal)', err);
    });
    void useSettlementRequestStore.getState().loadRequests().catch((err) => {
      console.error('loadSettlements failed (non-fatal)', err);
    });
    // Connection asks ("X added you — add them back?"). Boot-loaded so the
    // bell badge counts them before the user opens the Inbox.
    void useContactLinkStore.getState().loadRequests().catch((err) => {
      console.error('loadContactLinks failed (non-fatal)', err);
    });
    // Boot-load notifications so the bell badge + Inbox "Info" tab reflect
    // unread informational pings (e.g. "someone added you via your code")
    // before the user ever opens the inbox. Realtime keeps it fresh after.
    void useNotificationStore.getState().loadNotifications().catch((err) => {
      console.error('loadNotifications failed (non-fatal)', err);
    });
    // Notification preferences (mute state) feed the bell-badge's honest
    // count (notificationCounts.ts) — load them alongside the notifications
    // they gate, not only lazily from Settings.
    void useNotificationStore.getState().loadPrefs().catch((err) => {
      console.error('loadPrefs failed (non-fatal)', err);
    });
    // Preload groups on app boot so the QuickEntry "Group expense" picker
    // is ready the moment the user opens it from any page. Previously
    // groups only loaded on /groups visit, which made the picker show
    // "no groups yet" for users who'd never opened the Groups tab.
    void useSplitStore.getState().loadGroups().catch((err) => {
      console.error('loadGroups failed (non-fatal)', err);
    });
    // Custom categories feed every category picker; load early so the merged
    // (built-in + custom) lists are ready before the user opens an entry form.
    // Deliberately NOT mode-gated: group expenses are categorised in
    // splits_only too, so the ledger-mode AddGroupExpenseModal needs them.
    void useCustomCategoryStore.getState().loadCategories().catch((err) => {
      console.error('loadCategories failed (non-fatal)', err);
    });
    // Kameti is a no-custody tracker and is routed in BOTH modes, so it stays
    // here. `loadAll` now shares an in-flight promise + 60 s freshness window
    // with HomePage's own call (audit M2: committees were loaded twice per
    // boot = 6 queries).
    void useCommitteeStore.getState().loadAll().catch((err) => {
      console.error('loadCommittees failed (non-fatal)', err);
    });
  }, [user?.id]);

  // ── Full-tracker-only boot loads (audit 03-performance M2 / quick win #8) ──
  // splits_only is a ledger: it has NO accounts, and /accounts, /transactions,
  // /budgets, /subscriptions and /investments are all routed to Navigate("/")
  // in that mode. Loading their stores on every ledger-mode boot was ~4-5
  // requests for data nothing can render.
  //
  // `mode` is read from the store (not the boot effect above) and IS a
  // dependency here, so the flip that App's profile-hydration effect performs
  // — localStorage default → the server's real app_mode — still triggers the
  // loads for a full_tracker user on a fresh device. The mode-independent
  // effect above keeps `[user?.id]` alone so that flip cannot re-run it.
  //
  // Every store below is loaded on mount by each page that needs it
  // (AccountsPage, AddGroupExpenseModal, BudgetsPage, HisaabAIPage, …), so a
  // user who switches splits_only → full_tracker mid-session is covered even
  // before this effect re-runs.
  useEffect(() => {
    if (!user?.id) return;
    const fullTracker = mode === 'full_tracker';

    if (fullTracker) {
      // Accounts feed the globally-mounted QuickEntry (and its "you need an
      // account first" gate). They used to load only when a page that needed
      // them mounted — on an unmatched URL the FAB opened over an empty store
      // and told a 13-account user to create their first account. In
      // splits_only QuickEntry offers only the person/group intents, both of
      // which are account-free (`isLedgerOnlyPersonFlow`), so the gate that
      // reads `accounts.length` is unreachable there.
      void useAccountStore.getState().loadAccounts().catch((err) => {
        console.error('loadAccounts failed (non-fatal)', err);
      });
      // Phase 3: load budgets and recurring templates.
      // Budgets feed the home banner; recurring needs to be loaded BEFORE
      // the expansion runner can decide which entries are due.
      void useBudgetStore.getState().loadBudgets().catch((err) => {
        console.error('loadBudgets failed (non-fatal)', err);
      });
      void useRecurringStore.getState().loadTemplates().then(() => {
        // Defer expansion to next tick so the first paint isn't blocked by
        // potentially many confirmation prompts. The runner only prompts;
        // the user still confirms each expansion.
        void runRecurringExpansion().catch((err) => {
          console.error('runRecurringExpansion failed (non-fatal)', err);
        });
        void rescheduleLocalNotifications();
      }).catch((err) => {
        console.error('loadRecurring failed (non-fatal)', err);
      });
    } else {
      // Ledger mode still gets its reminders: loans, kameti rounds and
      // upcoming expenses all exist in splits_only. Only the recurring
      // *templates* (a full-tracker surface that materialises account
      // transactions) are skipped, so the reschedule is called directly
      // instead of hanging off loadTemplates().
      void rescheduleLocalNotifications();
    }
  }, [user?.id, mode]);

  // Phase 1B-A: historical backfill of person_id on legacy loans/transactions.
  // Deferred ~800ms so other boot work (profile fetch, realtime subscribe,
  // first page render) finishes first. The job itself short-circuits via a
  // localStorage flag after success, so steady-state boots pay almost nothing.
  useEffect(() => {
    const uid = user?.id;
    if (!uid) return;
    const timer = setTimeout(() => {
      void runPersonBackfillIfNeeded(uid);
    }, 800);
    return () => clearTimeout(timer);
  }, [user?.id]);

  useEffect(() => {
    const uid = user?.id;
    if (!uid) return;
    let cancelled = false;
    void useSupabaseAuthStore.getState().getProfile().then((profile) => {
      if (cancelled || !profile) return;
      const name = typeof profile.name === 'string' && profile.name.trim() ? profile.name.trim() : localStorage.getItem('hisaab_user_name');
      const currency = typeof profile.primary_currency === 'string' ? profile.primary_currency : localStorage.getItem('hisaab_primary_currency');
      const profileMode = profile.app_mode === 'splits_only' || profile.app_mode === 'full_tracker' ? profile.app_mode : null;
      if (name) localStorage.setItem('hisaab_user_name', name);
      if (currency) localStorage.setItem('hisaab_primary_currency', currency);
      if (profileMode) setMode(profileMode);
      // Audit N-1: cross-user notification content is written by the *sender*,
      // who can only localize it if the recipient's language lives on the
      // profile row. setLang keeps it current from here on; this catches users
      // who picked a language before profiles.lang existed.
      reconcileProfileLang(profile.lang);
      // Session hydrate: attach the session to the opaque auth id. Person
      // properties are enums/codes only (telemetryEvents.ts PII policy) —
      // never name, email or phone.
      identify(uid, {
        app_mode: profileMode ?? useAppModeStore.getState().mode,
        language: profile.lang === 'ur' || profile.lang === 'en' ? profile.lang : useI18nStore.getState().lang,
      });
    });
    return () => {
      cancelled = true;
    };
  }, [setMode, user?.id]);

  useEffect(() => {
    if (!user || !completed) return;
    const resumePath = getPendingInviteResumePath({
      completed,
      currentPath: location.pathname,
      hasUser: Boolean(user),
    });
    if (resumePath) navigate(resumePath, { replace: true });
  }, [completed, location.pathname, navigate, user]);

  // Scroll restoration (audit MF-18). The browser's own automatic
  // restoration races the logic below and can flash the wrong position
  // before we correct it, so take manual control once up front.
  useEffect(() => {
    if ('scrollRestoration' in window.history) {
      window.history.scrollRestoration = 'manual';
    }
  }, []);

  // Continuously record the current entry's scroll offset, keyed by
  // `location.key` (a unique id React Router assigns per history entry), so
  // a POP navigation back to it can restore where the user left off. Before
  // this, EVERY route change — including back — reset to the top, which
  // turned the core review loop (open TransactionsPage/LoansPage/
  // GroupDetailPage, open a detail route, come back) into O(n^2) scrolling.
  const scrollPositions = useRef(new Map<string, number>()).current;
  useEffect(() => {
    const key = location.key;
    const onScroll = () => {
      scrollPositions.set(key, window.scrollY);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, [location.key, scrollPositions]);

  // POP (back/forward, including the hardware-back path above and
  // GlobalSearch/QuickEntry navigations) restores the recorded offset for
  // that entry; PUSH/REPLACE (opening a new screen) scrolls to top like any
  // freshly-opened page. Always instant (no `behavior: 'smooth'`) — this is
  // scroll RESTORATION, not a scroll animation, so there is no smooth-scroll
  // code path to gate behind `prefers-reduced-motion` in the first place.
  const navigationType = useNavigationType();
  useEffect(() => {
    const target = navigationType === 'POP' ? (scrollPositions.get(location.key) ?? 0) : 0;
    window.scrollTo(0, target);
  }, [location.pathname, location.key, navigationType, scrollPositions]);

  // On logout, reset the URL to Home so the next login lands on Home — not the
  // page the user was on when they signed out (e.g. Settings).
  const wasAuthed = useRef(false);
  useEffect(() => {
    if (wasAuthed.current && !user) navigate('/', { replace: true });
    wasAuthed.current = !!user;
  }, [user, navigate]);

  // ── Lazy-modal trigger effects (audit H1 / P2 M2c) ───────────────────────

  // 1. Recurring due prompt. recurringRunner dispatches `hisaab:recurring-due`
  //    once, from the boot expansion — by the time a lazily-fetched component
  //    could add its own listener the event is long gone, so the FIRST payload
  //    is captured here and seeded into the component as `initialTemplates`.
  //    The component keeps its own listener (deduped by id) for later events.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<RecurringDueDetail>).detail;
      if (!detail || !Array.isArray(detail.templates) || detail.templates.length === 0) return;
      setRecurringDue((prev) => {
        if (!prev) return detail.templates;
        const seen = new Set(prev.map((t) => t.id));
        return [...prev, ...detail.templates.filter((t) => !seen.has(t.id))];
      });
    };
    window.addEventListener('hisaab:recurring-due', handler);
    return () => window.removeEventListener('hisaab:recurring-due', handler);
  }, []);

  // 2. Monthly Wrap. The decision needs the transaction list and the pure
  //    computation in monthlyWrap.ts — both are dynamic-imported so neither
  //    monthlyWrap.ts nor (far more importantly) MonthlyWrapModal's jspdf /
  //    modern-screenshot share stack is in the boot graph.
  //
  //    transactionStore is read IMPERATIVELY (getState + subscribe), never as a
  //    hook: subscribing AppContent to `transactions` would re-render the whole
  //    app shell on every ledger write. The subscription exists because the
  //    store is empty at boot and fills asynchronously — the old component
  //    effect keyed off `transactions.length` for exactly the same reason.
  //
  //    Both app modes: splits_only writes transaction rows too (ledger
  //    repayments, with BOTH account ids null) and /analytics + the wrap are
  //    routed in both modes, so nothing here is mode-gated. computeMonthlyWrap
  //    reads only type/amount/currency/category/createdAt — never an account id.
  useEffect(() => {
    if (!user?.id) return;
    let cancelled = false;
    let unsubscribe: (() => void) | undefined;

    // Same "don't fight auth/onboarding paint" delay the component used.
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const [wrap, currency, txStore] = await Promise.all([
            import('./lib/monthlyWrap'),
            import('./lib/primaryCurrency'),
            import('./stores/transactionStore'),
          ]);
          if (cancelled) return;
          const evaluate = (transactions: Parameters<typeof wrap.computeMonthlyWrap>[0]) => {
            if (cancelled || transactions.length === 0) return false;
            const computed = wrap.computeMonthlyWrap(transactions, currency.getPrimaryCurrency());
            if (!wrap.shouldShowMonthlyWrap(computed)) return false;
            setWrapStats(computed);
            return true;
          };
          const store = txStore.useTransactionStore;
          if (evaluate(store.getState().transactions)) return;
          // Not loaded yet (or nothing to show yet) — watch until the first
          // non-empty snapshot, then stop watching either way.
          unsubscribe = store.subscribe((state) => {
            if (state.transactions.length === 0) return;
            evaluate(state.transactions);
            unsubscribe?.();
            unsubscribe = undefined;
          });
        } catch {
          // The wrap is a nice-to-have; a failed chunk fetch must not surface.
        }
      })();
    }, 1200);

    return () => {
      cancelled = true;
      clearTimeout(timer);
      unsubscribe?.();
    };
  }, [user?.id]);

  // 3. Daily wisdom. Two localStorage reads (src/lib/dailyQuotePrefs.ts — pure,
  //    tested, and deliberately NOT inside the component, which is the chunk we
  //    are trying not to fetch). Gated on a signed-in, onboarded user because
  //    that is the only shell the popup is rendered in.
  useEffect(() => {
    if (!user?.id || !completed) return;
    if (!shouldShowDailyQuote()) return;
    const timer = setTimeout(() => setShowDailyQuote(true), 700);
    return () => clearTimeout(timer);
  }, [user?.id, completed]);

  // 4. Warm the QuickEntry chunk once the app is idle. QuickEntry is the FAB —
  //    the single most-tapped action in the app — so paying a cold chunk fetch
  //    on tap would trade a boot win for a worse interaction on exactly the
  //    low-end/3G devices MF-14 is about. Idle-time prefetch keeps it out of
  //    the entry graph AND out of the modulepreload list while still having it
  //    resident before the first tap. Failure is silent: the lazy() boundary
  //    fetches it again on demand.
  useEffect(() => {
    if (!user?.id || !completed) return;
    return onIdle(() => {
      void import('./pages/QuickEntry').catch(() => {});
    });
  }, [user?.id, completed]);

  // Public witness route — a read-only committee record reachable WITHOUT an
  // account (for non-app members/relatives). Checked before every other gate
  // so the share link opens directly in any browser.
  if (location.pathname.startsWith('/kameti/witness/')) {
    return (
      <Suspense fallback={<PageLoader />}>
        <KametiWitnessPage />
      </Suspense>
    );
  }

  // Public khata route (audit P3 / L2) — the read-only per-counterparty ledger
  // the owner shares over WhatsApp. Same gate-free treatment as the witness
  // link above, and for the same reason: its reader usually has no account at
  // all, so every gate below would be a dead end for them.
  if (location.pathname.startsWith('/khata/')) {
    return (
      <Suspense fallback={<PageLoader />}>
        <KhataLinkPage />
      </Suspense>
    );
  }

  // Dev-only: ?loading-preview pins the loading screen so it can be styled
  // and reviewed (it normally flashes by too fast). Dead code in prod builds.
  if (import.meta.env.DEV && new URLSearchParams(window.location.search).has('loading-preview')) {
    return <AppLoadingScreen />;
  }

  if (authLoading || onboardingLoading) {
    return <AppLoadingScreen />;
  }

  // ── Gate block ────────────────────────────────────────────────────────────
  // Version → auth → email verification → onboarding → PIN. Every one of these
  // renders BELOW the public routes: /privacy, /terms, /contact, /support and
  // /delete-account never reach AppContent (PublicRouteSwitch returns first),
  // and /kameti/witness/* returns above this block — so a shared witness link
  // still opens in any browser even while the app is version-blocked.

  // Version gate (audit H9 / MF-12). FIRST, and deliberately above the auth
  // gate: a binary too old to talk to the current schema must be stopped before
  // it signs in and starts issuing writes against contracts that moved. Fails
  // open on any fetch error, so this can only block when the server actively
  // said so. Mode-agnostic — full_tracker and splits_only are blocked alike.
  if (versionGate.blocked) {
    return <UpdateRequiredScreen config={versionGate.config} version={versionGate.version} />;
  }

  // Auth gate — must be logged in
  if (!user) {
    return (
      <Suspense fallback={<PageLoader />}>
        <AuthPage />
      </Suspense>
    );
  }

  // Email-verification gate. Supabase returns a session for unconfirmed users
  // when "Confirm email" is disabled in the dashboard; even when enabled, a
  // user who reuses a token can land here without a real verified email. We
  // hard-block app access until `email_confirmed_at` is set. The user can
  // resend the verification email or sign out.
  if (!user.email_confirmed_at) {
    return (
      <Suspense fallback={<PageLoader />}>
        <UnverifiedEmailScreen email={user.email ?? ''} />
      </Suspense>
    );
  }

  // Onboarding gate
  if (!completed) {
    return (
      <Suspense fallback={<PageLoader />}>
        <OnboardingPage />
      </Suspense>
    );
  }

  // Device PIN gate. Last gate before the app shell: signed in, verified,
  // onboarded — and now the phone's owner has to prove it's them. "Forgot PIN"
  // inside the screen signs out, which is also what clears the PIN.
  if (hasPin && isPinLocked) {
    return <PinLockScreen />;
  }

  return (
    // 1d shell: the page / sheet surface (cream-bg — #0B0C16 in dark), so any
    // gap a route leaves (lazy-chunk swap, short page) is the sheet, not a
    // second off-shade.
    <div className="min-h-dvh bg-cream-bg">
      <PWAInstallPrompt />
      {/* Connectivity pill — surfaces when navigator.onLine flips. */}
      <OfflineBanner />
      <Suspense fallback={<PageLoader />}>
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/groups" element={<SplitsPage />} />
          <Route path="/group/:id" element={<GroupDetailPage />} />
          <Route path="/join/:token" element={<JoinGroupPage />} />
          <Route path="/analytics" element={<AnalyticsPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/contacts" element={<ContactsPage />} />
          {/* Scanned-QR landing (https://usehisaab.com/u/HSB-XXXXXX). Also
              reachable from the phone's own camera app via App Links. */}
          <Route path="/u/:code" element={<ConnectByCodePage />} />
          <Route path="/activity" element={<ActivityPage />} />
          <Route path="/inbox" element={<InboxPage />} />
          <Route path="/accounts" element={mode === 'full_tracker' ? <AccountsPage /> : <Navigate to="/" replace />} />
          <Route path="/account/:id" element={mode === 'full_tracker' ? <AccountDetailPage /> : <Navigate to="/" replace />} />
          <Route path="/transactions" element={mode === 'full_tracker' ? <TransactionsPage /> : <Navigate to="/" replace />} />
          <Route path="/loans" element={<LoansPage />} />
          <Route path="/loan/:id" element={<LoanDetailPage />} />
          {/* Phase 3 features. Budgets + Recurring stay full_tracker-only
              because they presuppose accounts. */}
          <Route path="/budgets" element={mode === 'full_tracker' ? <BudgetsPage /> : <Navigate to="/" replace />} />
          {/* Recurring + Subscriptions consolidated into the one Subscription
              Tracker. Old /recurring links redirect there. */}
          <Route path="/subscriptions" element={mode === 'full_tracker' ? <SubscriptionsPage /> : <Navigate to="/" replace />} />
          <Route path="/investments" element={mode === 'full_tracker' ? <InvestmentsPage /> : <Navigate to="/" replace />} />
          <Route path="/investment/:marketId/:symbol" element={mode === 'full_tracker' ? <HoldingDetailPage /> : <Navigate to="/" replace />} />
          <Route path="/recurring" element={<Navigate to="/subscriptions" replace />} />
          {/* Kameti / committee — a no-custody tracker; needs no accounts, so
              available in both modes. */}
          <Route path="/kameti" element={<KametiPage />} />
          <Route path="/kameti/:id" element={<KametiDetailPage />} />
          <Route path="/hisaab-ai" element={<HisaabAIPage />} />
          <Route path="/hisaab-ai/insight/:category" element={mode === 'full_tracker' ? <InsightDetailPage /> : <Navigate to="/hisaab-ai" replace />} />
          {/* Remittances feature retired (confused users into thinking Hisaab
              is a remittance app). Data layer kept dormant; old links redirect. */}
          <Route path="/remittances" element={<Navigate to="/" replace />} />

          {/* Savings goals stay full-tracker only. Transactions and loans are
              available in both modes so simple users can still record expense
              notes and manage payables/receivables. */}
          {mode === 'full_tracker' ? (
            <>
              <Route path="/goals" element={<GoalsPage />} />
            </>
          ) : (
            <>
              <Route path="/goals" element={<Navigate to="/" replace />} />
            </>
          )}

          {/* Catch-all: an unmatched URL used to render an empty page with a
              live BottomNav + FAB floating over nothing. Send it home. */}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
      <BottomNav
        onQuickEntry={() => {
          setQuickEntryMounted(true);
          setShowQuickEntry(true);
        }}
      />

      {/* ── App-level modals ──────────────────────────────────────────────
          Every one is lazy (see the lazy() block at the top of this file) and
          mounted only from the frame its trigger fires in. `fallback={null}`
          throughout on purpose: these are overlays, so the correct thing to
          show while a chunk arrives is the page the user is already looking
          at — never a full-screen PageLoader. A chunk that fails to load is
          picked up by GlobalChunkRecoveryOverlay, same as any route. */}

      {quickEntryMounted && (
        <Suspense fallback={null}>
          <QuickEntry
            open={showQuickEntry}
            onClose={() => setShowQuickEntry(false)}
            onPickGroupExpense={(group, amount) => {
              setShowQuickEntry(false);
              setGroupExpenseTarget({ group, amount });
            }}
            onCreateGroupForExpense={(amount) => {
              setShowQuickEntry(false);
              setCreateGroupMounted(true);
              setCreateGroupForExpense({ amount });
            }}
          />
        </Suspense>
      )}

      {/* Phase 3: recurring entries due today appear as a single-prompt
          queue. Mounted at app level so the prompt persists across navigation.
          `recurringDue` is the payload of the first `hisaab:recurring-due`
          event — see trigger effect 1 above. */}
      {recurringDue && (
        <Suspense fallback={null}>
          <RecurringDuePrompt initialTemplates={recurringDue} />
        </Suspense>
      )}

      {/* Phase 3: end-of-month "Hisaab Wrap" — Spotify Wrapped for the
          user's money. Trigger effect 2 above decides; this only renders once
          there are real stats, so the jspdf/modern-screenshot share stack is
          fetched at most once a month instead of on every boot. */}
      {wrapStats && (
        <Suspense fallback={null}>
          <MonthlyWrapModal stats={wrapStats} onClose={() => setWrapStats(null)} />
        </Suspense>
      )}

      {/* Once-a-day money-wisdom popup; can be turned off in Settings.
          Trigger effect 3 above owns the "is it due today?" check. */}
      {showDailyQuote && (
        <Suspense fallback={null}>
          <DailyQuote onDismiss={() => setShowDailyQuote(false)} />
        </Suspense>
      )}

      {/* Create-then-expense chain: when CreateGroupModal returns the new
          group, we immediately open AddGroupExpenseModal with the amount
          the user originally typed in QuickEntry. */}
      {createGroupMounted && (
        <Suspense fallback={null}>
          <CreateGroupModal
            open={!!createGroupForExpense}
            onClose={() => setCreateGroupForExpense(null)}
            onCreated={(group) => {
              const amount = createGroupForExpense?.amount ?? '';
              setCreateGroupForExpense(null);
              setGroupExpenseTarget({ group, amount });
            }}
          />
        </Suspense>
      )}

      {/* AddGroupExpenseModal for the QuickEntry path. GroupDetailPage
          still mounts its own local instance for the inline button —
          they don't conflict because both paths set/clear independent
          state slots and the user can't be on both screens at once. */}
      {groupExpenseTarget && (
        <Suspense fallback={null}>
          <AddGroupExpenseModal
            open
            group={groupExpenseTarget.group}
            prefillAmount={groupExpenseTarget.amount}
            onClose={() => setGroupExpenseTarget(null)}
          />
        </Suspense>
      )}
    </div>
  );
}

function App() {
  return (
    <BrowserRouter>
      <ToastContainer />
      <ConfirmDestructiveSheet />
      <GlobalChunkRecoveryOverlay />
      <ErrorBoundary>
        <PublicRouteSwitch />
      </ErrorBoundary>
    </BrowserRouter>
  );
}

function PublicRouteSwitch() {
  const location = useLocation();

  if (location.pathname === '/privacy') {
    return <Suspense fallback={<PageLoader />}><PublicInfoPage kind="privacy" /></Suspense>;
  }
  if (location.pathname === '/terms') {
    return <Suspense fallback={<PageLoader />}><PublicInfoPage kind="terms" /></Suspense>;
  }
  if (location.pathname === '/contact' || location.pathname === '/support') {
    return <Suspense fallback={<PageLoader />}><PublicInfoPage kind="contact" /></Suspense>;
  }
  if (location.pathname === '/delete-account') {
    return <Suspense fallback={<PageLoader />}><PublicInfoPage kind="delete-account" /></Suspense>;
  }

  return <AppContent />;
}

export default App;
