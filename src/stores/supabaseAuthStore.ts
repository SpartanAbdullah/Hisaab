import { create } from 'zustand';
import { supabase } from '../lib/supabase';
import type { User, Session } from '@supabase/supabase-js';
import { generatePublicCodeCandidate, normalizePublicCode } from '../lib/collaboration';
import { resetAllUserStores } from './resetAllStores';
import { accountDeletionDb } from '../lib/supabaseDb';
import { stopPushRegistration } from '../lib/pushRegistration';
import { cancelAllScheduledNotifications } from '../lib/notificationScheduler';
import { clearWidgetSnapshot } from '../lib/widgetBridge';
import { reportError, reportMessage } from '../lib/errorReporter';
import { getCachedProfile, invalidateProfileCache } from '../lib/profileCache';

interface SupabaseAuthState {
  user: User | null;
  session: Session | null;
  loading: boolean;
  error: string | null;

  initialize: () => Promise<void>;
  signUp: (email: string, password: string) => Promise<{ success: boolean; message: string }>;
  signIn: (email: string, password: string) => Promise<{ success: boolean; message: string }>;
  signOut: () => Promise<void>;
  deleteAccount: () => Promise<void>;
  requestPasswordReset: (email: string) => Promise<{ success: boolean; message: string }>;
  updateProfile: (data: { name?: string; primary_currency?: string; app_mode?: string; lang?: string }) => Promise<void>;
  changePassword: (newPassword: string) => Promise<void>;
  getProfile: () => Promise<Record<string, unknown> | null>;
}

function buildAuthRedirectUrl(path = '/'): string {
  const configuredUrl = import.meta.env.VITE_PUBLIC_APP_URL as string | undefined;
  const fallbackUrl = typeof window === 'undefined' ? '' : window.location.origin;
  const baseUrl = (configuredUrl?.trim() || fallbackUrl).replace(/\/+$/, '');
  const nextPath = path.startsWith('/') ? path : `/${path}`;
  return baseUrl ? `${baseUrl}${nextPath}` : nextPath;
}

// Belt-and-braces LOCAL session teardown.
//
// Audit 2026-09 (SEC-11 / H8): `supabase.auth.signOut()` posts to /logout and,
// on ANY non-401/403/404 error — an offline AuthRetryableFetchError included —
// returns BEFORE it calls `_removeSession()`. The `sb-<ref>-auth-token` key
// survives in localStorage, so the next launch silently restores the session a
// user believed they had ended. On the shared / handed-over phones this app is
// built for, that is account takeover.
//
// `signOut({ scope: 'local' })` is NOT sufficient on its own: auth-js still
// makes the same network call first and bails out at the same point. So the
// last step here removes GoTrue's storage keys by hand. They are the only
// source of session state — `__loadSession()` reads them from storage on every
// use, and there is no in-memory copy that could write them back — so once the
// keys are gone the device is genuinely logged out, network or no network.
//
// Every step swallows its own failure: this must never throw, because the
// caller runs it on the path that declares the user signed out.
async function clearLocalAuthSession(): Promise<void> {
  try {
    // Second attempt, local-only. Succeeds (and stops the refresh ticker
    // cleanly) whenever the first failure was server-side rather than offline.
    await supabase.auth.signOut({ scope: 'local' });
  } catch (err) {
    reportError(err, { feature: 'supabaseAuthStore.clearLocalAuthSession.signOutLocal' });
  }
  try {
    // Last resort. GoTrue parks everything under the `sb-` prefix:
    // `sb-<ref>-auth-token`, `-code-verifier`, `-user`, and chunked `.0`/`.1`
    // variants. Nothing else in Hisaab uses that prefix (our keys are
    // `hisaab_*`), so a prefix sweep is safe and covers all of them.
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith('sb-')) localStorage.removeItem(key);
    }
  } catch (err) {
    // The device may still hold a usable refresh token - a real security event.
    reportError(err, { feature: 'supabaseAuthStore.clearLocalAuthSession.keyPurge' });
  }
}

// Budget for the device-side notification teardown below. A dead network must
// never be able to trap someone in a session they explicitly asked to end
// (the whole point of H8), so every step is raced against this timeout and
// sign-out continues regardless. 3s is ample for a single PostgREST DELETE on
// a warm connection and short enough to feel instant when there is no
// connection at all.
const DEVICE_TEARDOWN_TIMEOUT_MS = 3000;

function withTeardownTimeout(label: string, work: Promise<unknown>): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      reportMessage('device teardown timed out during sign-out', {
        feature: 'supabaseAuthStore.withTeardownTimeout.timeout',
        level: 'warning',
        extra: { step: label, timeoutMs: DEVICE_TEARDOWN_TIMEOUT_MS },
      });
      resolve();
    }, DEVICE_TEARDOWN_TIMEOUT_MS);
    void work
      .catch((err) => {
        reportError(err, { feature: 'supabaseAuthStore.withTeardownTimeout.stepFailed', extra: { step: label } });
      })
      .finally(() => {
        clearTimeout(timer);
        resolve();
      });
  });
}

// Everything that must happen while the session is STILL VALID.
//
// Audit 2026-09 M5 / L5: both of these used to run after the session was
// already gone (App.tsx's user-became-null effect), or not at all.
//
//   - The FCM token row is deleted by an authenticated, RLS-scoped DELETE.
//     After `supabase.auth.signOut()` there is no JWT to sign it with, so the
//     row survives and the departing account's loan/settlement pushes keep
//     landing on a phone it no longer controls.
//   - Local reminders live with the OS, not with us. They outlive sign-out,
//     app kill and reboot, and their text names real people and amounts.
//     (This half needs no session — it is bundled here so there is exactly
//     one "device teardown" step to keep in the right place.)
//
// Never throws; both callees already swallow their own failures and the
// timeout wrapper is the second belt.
//
// Mode-agnostic by construction: neither push tokens nor local reminders are
// gated on full_tracker vs splits_only, and nothing on this path reads
// appModeStore.
async function teardownDeviceNotifications(): Promise<void> {
  await Promise.all([
    withTeardownTimeout('push token unregister', stopPushRegistration()),
    withTeardownTimeout('scheduled reminder cancel', cancelAllScheduledNotifications()),
    // The home-screen widget shows today's entry count + streak; the next
    // holder of this phone must not see the leaving account's.
    withTeardownTimeout('widget snapshot clear', clearWidgetSnapshot()),
  ]);
}

// Audit 03-performance M2: this used to be its own `profiles` SELECT, fired
// once from initialize() and again from the INITIAL_SESSION auth event —
// while onboardingStore and App.tsx read the same row twice more. It now goes
// through the shared boot cache, so all four reads collapse into one request.
// Failure semantics are unchanged: no row / any error ⇒ "not deleted", i.e.
// the gate fails OPEN exactly as before (a deleted account is still refused
// server-side by the RESTRICTIVE active-profile RLS policies).
async function isDeletedProfile(userId: string): Promise<boolean> {
  const profile = await getCachedProfile(userId);
  return profile?.is_deleted === true;
}

async function blockDeletedSession(set: (state: Partial<SupabaseAuthState>) => void) {
  const userId = localStorage.getItem('hisaab_supabase_uid');
  // Same ordering rule as signOut(): the push-token DELETE needs the session
  // that is about to be revoked.
  await teardownDeviceNotifications();
  try {
    await supabase.auth.signOut();
  } finally {
    // Same H8 hole as signOut(): a deleted account whose revocation call fails
    // must still lose its token on this device.
    await clearLocalAuthSession();
    try {
      await resetAllUserStores(userId ?? undefined);
    } catch (err) {
      reportError(err, { feature: 'supabaseAuthStore.blockDeletedSession.storeReset' });
    }
    localStorage.removeItem('hisaab_supabase_uid');
    set({
      user: null,
      session: null,
      loading: false,
      error: 'This account has been deleted. Please create a new account to use Hisaab again.',
    });
  }
}

export const useSupabaseAuthStore = create<SupabaseAuthState>((set, get) => ({
  user: null,
  session: null,
  loading: true,
  error: null,

  initialize: async () => {
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (session?.user?.id && await isDeletedProfile(session.user.id)) {
        await blockDeletedSession(set);
        return;
      }
      // Write uid synchronously BEFORE resolving so any DB call that depends on
      // localStorage.hisaab_supabase_uid sees the right value on the first paint.
      if (session?.user?.id) {
        const previousUserId = localStorage.getItem('hisaab_supabase_uid');
        if (previousUserId && previousUserId !== session.user.id) {
          await resetAllUserStores(previousUserId);
        }
        localStorage.setItem('hisaab_supabase_uid', session.user.id);
      } else {
        localStorage.removeItem('hisaab_supabase_uid');
      }
      set({ session, user: session?.user ?? null, loading: false });

      // Listen for auth changes
      supabase.auth.onAuthStateChange((event, session) => {
        void (async () => {
          if (session?.user?.id) {
            const previousUserId = localStorage.getItem('hisaab_supabase_uid');
            if (previousUserId && previousUserId !== session.user.id) {
              // A different user: the memoized profile row belongs to the
              // previous one and must never be served to this session.
              invalidateProfileCache();
              await resetAllUserStores(previousUserId);
            }
            localStorage.setItem('hisaab_supabase_uid', session.user.id);
            // Audit 03-performance quick win #9: TOKEN_REFRESHED fires roughly
            // hourly for every open session and cannot change is_deleted, so it
            // no longer triggers the gate — that was a fleet-wide query per
            // user per hour. INITIAL_SESSION still runs it, and is now free:
            // initialize() already primed the shared profile cache.
            if (event !== 'TOKEN_REFRESHED') {
              void isDeletedProfile(session.user.id).then((isDeleted) => {
                if (isDeleted) void blockDeletedSession(set);
              });
            }
          } else {
            const previousUserId = localStorage.getItem('hisaab_supabase_uid');
            invalidateProfileCache();
            // Session ended outside signOut() (expiry, revoked elsewhere):
            // the widget must not keep showing this account's status.
            void clearWidgetSnapshot();
            await resetAllUserStores(previousUserId ?? undefined);
            localStorage.removeItem('hisaab_supabase_uid');
          }
          set({ session, user: session?.user ?? null });
        })();
      });
    } catch (err) {
      reportError(err, { feature: 'supabaseAuthStore.initialize' });
      set({ loading: false });
    }
  },

  signUp: async (email, password) => {
    set({ error: null });
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        emailRedirectTo: buildAuthRedirectUrl('/'),
      },
    });

    if (error) {
      set({ error: error.message });
      return { success: false, message: error.message };
    }

    if (data.user) {
      const previousUserId = localStorage.getItem('hisaab_supabase_uid');
      if (previousUserId && previousUserId !== data.user.id) {
        await resetAllUserStores(previousUserId);
      }
      localStorage.setItem('hisaab_supabase_uid', data.user.id);
      // Name is collected during onboarding, not signup. Seed the public_code
      // here so it's ready when the user wants to share group invites.
      const publicCode = generatePublicCodeCandidate();
      await supabase.from('profiles').update({
        onboarding_completed: false,
        public_code: publicCode,
        public_code_normalized: normalizePublicCode(publicCode),
      }).eq('id', data.user.id);
      set({ user: data.user, session: data.session });
    }

    return { success: true, message: 'Account created! Check your email to verify.' };
  },

  signIn: async (email, password) => {
    set({ error: null });
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });

    if (error) {
      set({ error: error.message });
      return { success: false, message: error.message };
    }

    if (data.user && await isDeletedProfile(data.user.id)) {
      await blockDeletedSession(set);
      return {
        success: false,
        message: 'This account has been deleted. Please create a new account to use Hisaab again.',
      };
    }

    const previousUserId = localStorage.getItem('hisaab_supabase_uid');
    if (previousUserId && previousUserId !== data.user.id) {
      await resetAllUserStores(previousUserId);
    }
    localStorage.setItem('hisaab_supabase_uid', data.user.id);
    set({ user: data.user, session: data.session });
    return { success: true, message: 'Logged in!' };
  },

  signOut: async () => {
    // Clear local user-owned state unconditionally, even if the network
    // signOut fails. Intent is explicit; we must not leave the previous
    // user's accounts/loans/groups visible for a second user on this device.
    const userId = localStorage.getItem('hisaab_supabase_uid');
    // FIRST, and before the session is revoked: unregister this device's push
    // token (needs a live JWT) and cancel every pending local reminder.
    // Bounded by DEVICE_TEARDOWN_TIMEOUT_MS so an offline device still signs
    // out immediately.
    await teardownDeviceNotifications();
    try {
      // Best effort at REVOKING the refresh token server-side. This is the
      // half that needs the network; it is allowed to fail.
      const { error } = await supabase.auth.signOut();
      if (error) {
        // Not fatal, but worth recording: the refresh token is still live
        // server-side and only the local teardown below protects the device.
        reportError(error, { feature: 'supabaseAuthStore.signOut.serverRevocationFailed' });
      }
    } catch (err) {
      reportError(err, { feature: 'supabaseAuthStore.signOut.serverRevocationThrew' });
    } finally {
      // ...and this is the half that must ALWAYS happen. Runs first in the
      // finally block so nothing downstream can throw before the device's
      // token is gone. Ordering of the store/DB cleanup below is unchanged.
      await clearLocalAuthSession();
      try {
        await resetAllUserStores(userId ?? undefined);
      } catch (err) {
        // A failed Dexie/store wipe must not leave the user "still signed in".
        reportError(err, { feature: 'supabaseAuthStore.signOut.storeReset' });
      }
      localStorage.removeItem('hisaab_supabase_uid');
      invalidateProfileCache();
      set({ user: null, session: null, error: null });
    }
  },

  deleteAccount: async () => {
    // Before the user row is destroyed: the push-token DELETE needs both a
    // live session AND a live profile row to satisfy RLS, and the pending
    // local reminders must die whether or not the server call succeeds.
    // signOut() runs this again below; it is idempotent (no token to drop,
    // nothing left pending) and costs one no-op bridge call on native.
    await teardownDeviceNotifications();
    await accountDeletionDb.deleteCurrentUser();
    await get().signOut();
  },

  requestPasswordReset: async (email) => {
    if (!email) return { success: false, message: 'Email required' };
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: buildAuthRedirectUrl('/?reset=1'),
    });
    if (error) return { success: false, message: error.message };
    // Always show the same message regardless of whether the email exists —
    // prevents user-enumeration via the password-reset endpoint.
    return { success: true, message: 'If an account exists for this email, a reset link has been sent.' };
  },

  updateProfile: async (data) => {
    const user = get().user;
    if (!user) return;
    await supabase.from('profiles').update(data).eq('id', user.id);
    // The boot memo must never mask a write the user just made.
    invalidateProfileCache();
  },

  changePassword: async (newPassword) => {
    const { error } = await supabase.auth.updateUser({ password: newPassword });
    if (error) throw error;
  },

  // Shares the boot cache with the deleted-account gate and
  // onboardingStore.checkOnboarding (audit M2: the same row was read 3-4×
  // per cold boot). Pass through to the same query when the memo is cold.
  getProfile: async () => {
    const user = get().user;
    if (!user) return null;
    return getCachedProfile(user.id);
  },
}));
