// Capacitor bridge for the reminder engine. The contract that keeps stale
// reminders impossible: every run CANCELS the whole pending schedule first,
// then re-derives it from live store state via the pure planner — so a bill
// paid five minutes ago can never ring, by construction. No-op on web.
import { isNativeRuntime } from './runtime';
import { DAILY_CLOSE_ACTION_TYPE, planNotifications } from './notificationPlanner';
import { notificationChannelDefs } from './notificationContent';
import { tStatic } from './i18n';
import { DAILY_CLOSE_KEY, dailyCloseEnabled, dailyCloseTime, parseCloseTime } from './dailyClosePrefs';
import { readCheckStampDay } from './hisaabCheck';
import { useAppModeStore } from '../stores/appModeStore';
import { useDailyCloseStore } from '../stores/dailyCloseStore';
import { useBudgetStore } from '../stores/budgetStore';
import { useAccountStore } from '../stores/accountStore';
import { useLoanStore } from '../stores/loanStore';
import { useEmiStore } from '../stores/emiStore';
import { useRecurringStore } from '../stores/recurringStore';
import { useUpcomingExpenseStore } from '../stores/upcomingExpenseStore';
import { useCommitteeStore } from '../stores/committeeStore';
import { useTransactionStore } from '../stores/transactionStore';

export const REMINDERS_KEY = 'hisaab_payment_reminders_enabled';

// OPT-IN, not opt-out: notifications fire only after the user explicitly
// enables them in Settings (which also runs the Android 13 permission
// prompt). A default-on toggle with no granted permission would show ON
// while nothing ever fires — a lying switch.
export function remindersEnabled(): boolean {
  try {
    return localStorage.getItem(REMINDERS_KEY) === 'true';
  } catch {
    return false;
  }
}

// Loads any cold slices the planner needs. Cheap when warm (each store
// no-ops into its cache-first path); failures are non-fatal — the planner
// simply sees fewer sources this round.
async function ensureLoaded(): Promise<void> {
  const jobs: Promise<unknown>[] = [];
  if (useAccountStore.getState().accounts.length === 0) jobs.push(useAccountStore.getState().loadAccounts());
  if (useLoanStore.getState().loans.length === 0) jobs.push(useLoanStore.getState().loadLoans());
  if (useEmiStore.getState().schedules.length === 0) jobs.push(useEmiStore.getState().loadSchedules());
  if (useRecurringStore.getState().templates.length === 0) jobs.push(useRecurringStore.getState().loadTemplates());
  if (useUpcomingExpenseStore.getState().expenses.length === 0) jobs.push(useUpcomingExpenseStore.getState().loadExpenses());
  if (useCommitteeStore.getState().committees.length === 0) jobs.push(useCommitteeStore.getState().loadAll());
  if (useTransactionStore.getState().transactions.length === 0) jobs.push(useTransactionStore.getState().loadTransactions());
  // Budgets drive the device-local breach reminder (planner section 6).
  if (useBudgetStore.getState().budgets.length === 0) jobs.push(useBudgetStore.getState().loadBudgets());
  // Close markers decide whether tonight's evening nudge is still needed.
  if (!useDailyCloseStore.getState().loaded) jobs.push(useDailyCloseStore.getState().load());
  await Promise.all(jobs.map((j) => j.catch(() => {})));
}

// Android 8+ routes every notification through a channel, and one naming a
// channel the device has never seen is dropped silently. pushRegistration
// creates the same four through the PushNotifications plugin, but a build with
// no google-services.json never reaches that path — so the local path creates
// them too. Both are idempotent at the OS level (audit N-10).
let localChannelsCreated = false;
async function ensureLocalChannels(): Promise<void> {
  if (localChannelsCreated) return;
  try {
    const { LocalNotifications } = await import('@capacitor/local-notifications');
    if (typeof LocalNotifications.createChannel !== 'function') return;
    for (const def of notificationChannelDefs(tStatic)) {
      await LocalNotifications.createChannel(def);
    }
    localChannelsCreated = true;
  } catch (err) {
    console.error('[notifications] channel setup failed (non-fatal)', err);
  }
}

// The evening nudge's two buttons. Android launches the app for either (the
// plugin's action PendingIntent is an activity intent); nativeBridge reads
// `actionId`. Titles are localized at registration time and re-registered on
// every run, so a language switch is picked up on the next reschedule.
async function ensureActionTypes(): Promise<void> {
  try {
    const { LocalNotifications } = await import('@capacitor/local-notifications');
    await LocalNotifications.registerActionTypes({
      types: [{
        id: DAILY_CLOSE_ACTION_TYPE,
        actions: [
          { id: 'log', title: tStatic('notif_close_action_log') },
          { id: 'none', title: tStatic('notif_close_action_none') },
        ],
      }],
    });
  } catch (err) {
    console.error('[notifications] action types failed (non-fatal)', err);
  }
}

// Drops every pending local notification. Shared by the reschedule path
// (which must start from a clean slate) and by the sign-out path.
async function cancelPending(): Promise<void> {
  const { LocalNotifications } = await import('@capacitor/local-notifications');
  const pending = await LocalNotifications.getPending();
  if (pending.notifications.length > 0) {
    await LocalNotifications.cancel({
      notifications: pending.notifications.map((n) => ({ id: n.id })),
    });
  }
}

async function runReschedule(): Promise<void> {
  try {
    const { LocalNotifications } = await import('@capacitor/local-notifications');

    // Always clear first — stale reminders must die even when the feature
    // was just disabled or permission was revoked.
    await cancelPending();

    // Two independent opt-ins: payment reminders (sections 1-6) and the
    // evening daily close (section 7, full tracker only - ledger-only mode
    // has no expenses to log).
    const paymentsOn = remindersEnabled();
    const closeOn = dailyCloseEnabled() && useAppModeStore.getState().mode === 'full_tracker';
    if (!paymentsOn && !closeOn) return;
    const perm = await LocalNotifications.checkPermissions();
    if (perm.display !== 'granted') return;

    await ensureLoaded();
    await ensureLocalChannels();
    if (closeOn) await ensureActionTypes();

    // Cash-advance loans keyed to their funding card (loan_taken origin) —
    // same derivation as HomePage/InboxPage.
    const cardFundedLoanIds = new Map<string, string>();
    for (const txn of useTransactionStore.getState().transactions) {
      if (txn.type === 'loan_taken' && txn.relatedLoanId && txn.sourceAccountId) {
        cardFundedLoanIds.set(txn.relatedLoanId, txn.sourceAccountId);
      }
    }

    const plan = planNotifications({
      // With payment reminders off, sections 1-6 see empty inputs and plan
      // nothing; transactions stay in for the evening section.
      accounts: paymentsOn ? useAccountStore.getState().accounts : [],
      loans: paymentsOn ? useLoanStore.getState().loans : [],
      schedules: paymentsOn ? useEmiStore.getState().schedules : [],
      templates: paymentsOn ? useRecurringStore.getState().templates : [],
      upcoming: paymentsOn ? useUpcomingExpenseStore.getState().expenses : [],
      committees: paymentsOn ? useCommitteeStore.getState().committees : [],
      committeePayments: paymentsOn ? useCommitteeStore.getState().payments : [],
      // Device-local budget breach reminders (audit N-11). Nothing here
      // reaches the server: no notifications row, no push, this phone only.
      budgets: paymentsOn ? useBudgetStore.getState().budgets : [],
      transactions: useTransactionStore.getState().transactions,
      cardFundedLoanIds,
      dailyClose: closeOn
        ? {
            ...parseCloseTime(dailyCloseTime()),
            closes: useDailyCloseStore.getState().closes,
            lastCheckIso: readCheckStampDay(),
          }
        : undefined,
      now: new Date(),
    });
    if (plan.length === 0) return;

    await LocalNotifications.schedule({
      notifications: plan.map((p) => ({
        id: p.id,
        title: p.title,
        body: p.body,
        schedule: { at: new Date(p.atMs), allowWhileIdle: p.allowWhileIdle },
        extra: { href: p.href },
        actionTypeId: p.actionTypeId,
        smallIcon: 'ic_stat_hisaab',
        // Every planned entry is a device-local reminder the user opted into
        // in Settings — its own channel, separate from cross-user money and
        // group traffic, so the two can be tuned independently (audit N-10).
        channelId: 'reminders',
      })),
    });
  } catch (err) {
    console.error('[notifications] reschedule failed (non-fatal)', err);
  }
}

let lastRun = 0;
// Serialize runs: cancel→derive→schedule spans several bridge round-trips,
// and overlapping forced runs (e.g. the consolidated-repayment loop firing
// one per posted transaction) could interleave so a stale plan wins. Chain
// with latest-wins coalescing: at most one QUEUED run at a time — it will
// derive from final store state, which is all that matters.
let chain: Promise<void> = Promise.resolve();
let queued = false;

/** Cancel-and-rebuild the local notification schedule from live state.
 *  Debounced (30s) for burst callers (boot/resume); pass force whenever the
 *  user just resolved something — a debounced skip could let a 10:00
 *  reminder ring for a bill settled at 09:55. */
export function rescheduleNotifications(opts?: { force?: boolean }): Promise<void> {
  if (!isNativeRuntime()) return Promise.resolve();
  const now = Date.now();
  if (!opts?.force && now - lastRun < 30_000) return chain;
  lastRun = now;
  if (queued) return chain; // a queued run will already see the final state
  queued = true;
  chain = chain
    .then(() => {
      queued = false;
      return runReschedule();
    })
    .catch(() => {
      queued = false;
    });
  return chain;
}

/** Sign-out teardown: drop every pending reminder for the account that is
 *  leaving this device.
 *
 *  Audit 2026-09 L5: reminders are scheduled with the OS, not with us — they
 *  survive sign-out, app kill and reboot, and their bodies name real people
 *  and real amounts ("Ali ko 500 AED dena hai"). On a shared/handed-over
 *  phone that is the previous user's ledger leaking into the next holder's
 *  notification tray, indefinitely.
 *
 *  Goes through the same serialization chain as rescheduleNotifications() so
 *  an in-flight or queued reschedule cannot re-populate the schedule in the
 *  window between our getPending() and our cancel(). `lastRun` is stamped so
 *  the debounce also swallows any non-forced run for the next 30s; after
 *  that, remindersEnabled() is false (sign-out clears the opt-in key) and
 *  runReschedule() cancels-and-returns anyway.
 *
 *  No-op on web. Never throws — it runs on the path that declares the user
 *  signed out. */
export function cancelAllScheduledNotifications(): Promise<void> {
  if (!isNativeRuntime()) return Promise.resolve();
  lastRun = Date.now();
  chain = chain
    .then(() => cancelPending())
    .catch((err) => {
      console.error('[notifications] sign-out cancel failed (non-fatal)', err);
    });
  return chain;
}

/** Settings-toggle flow: request permission (Android 13+ runtime prompt),
 *  persist the opt-in, then schedule immediately so the user sees the
 *  effect. OWNS the opt-in key's write — the flag must be true BEFORE the
 *  internal reschedule runs, or that run cancels everything and schedules
 *  nothing (a lying green toggle). Returns whether reminders ended up on. */
export function enableRemindersFlow(): Promise<boolean> {
  return enableNotificationFlow(REMINDERS_KEY);
}

/** Same flow for the evening daily-close nudge (its own opt-in key). */
export function enableDailyCloseFlow(): Promise<boolean> {
  return enableNotificationFlow(DAILY_CLOSE_KEY);
}

async function enableNotificationFlow(key: string): Promise<boolean> {
  if (!isNativeRuntime()) return false;
  try {
    const { LocalNotifications } = await import('@capacitor/local-notifications');
    let perm = await LocalNotifications.checkPermissions();
    if (perm.display !== 'granted') {
      perm = await LocalNotifications.requestPermissions();
    }
    if (perm.display !== 'granted') {
      try { localStorage.setItem(key, 'false'); } catch { /* storage off */ }
      return false;
    }
    try { localStorage.setItem(key, 'true'); } catch { /* storage off */ }
    await rescheduleNotifications({ force: true });
    return true;
  } catch (err) {
    console.error('[notifications] enable flow failed', err);
    return false;
  }
}
