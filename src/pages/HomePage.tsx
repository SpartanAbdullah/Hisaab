import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Users } from "lucide-react";
import { useAccountStore } from "../stores/accountStore";
import { useTransactionStore } from "../stores/transactionStore";
import { useLoanStore } from "../stores/loanStore";
import { oldestCreatedAt } from "../lib/historyWindow";
import { useGoalStore } from "../stores/goalStore";
import { useUpcomingExpenseStore } from "../stores/upcomingExpenseStore";
import { useAppModeStore } from "../stores/appModeStore";
import { useSplitStore } from "../stores/splitStore";
import { useSettlementRequestStore } from "../stores/settlementRequestStore";
import { usePersonStore } from "../stores/personStore";
import { useBudgetStore, computeBudgetUsages } from "../stores/budgetStore";
import { useRecurringStore } from "../stores/recurringStore";
import { useEmiStore } from "../stores/emiStore";
import { useCommitteeStore } from "../stores/committeeStore";
import { useInvestmentStore, portfolioTotals } from "../stores/investmentStore";
import { buildThisWeek, thisWeekTotals } from "../lib/thisWeek";
import {
  computeMeraHisaab,
  monthKeyOf,
  NET_SNAPSHOTS_KEY,
  previousMonthNet,
  upsertSnapshot,
  type NetSnapshot,
} from "../lib/meraHisaab";
import { buildWhoOwesMe, whoOwesTotals } from "../lib/whoOwesMe";
import {
  groupInputsFromNetBalances,
  mergeGroupObligations,
} from "../lib/whoOwesGroupInputs";
import { CHECK_STAMP_KEY, daysSince, type CheckStamp } from "../lib/hisaabCheck";
import { buildInboxActionItems } from "../lib/inboxInfo";
import { HisaabCheckModal } from "../components/HisaabCheckModal";
import { useSupabaseAuthStore } from "../stores/supabaseAuthStore";
import { SettlementNudgeBanner } from "../components/SettlementNudgeBanner";
import { BudgetWarningBanner } from "../components/BudgetWarningBanner";
import { getOverdueSettlements } from "../lib/settlementNudges";
import { TransactionItem } from "../components/TransactionItem";
import { EditTransactionModal } from "../components/EditTransactionModal";
import type { Transaction } from "../db";
import { EmptyState } from "../components/EmptyState";
import { PageErrorState } from "../components/PageErrorState";
// 1d material (docs/design-system.md §3). `Tile3D` / `.m-tile` for anything
// the user can press (hard wall that sinks under the finger), `Card3D` /
// `.m-card` for surfaces that only tell them something (lit face, no wall),
// and 3c glyphs for icons (`Icon3D` still maps the retired clay names onto
// glyphs). Nothing here uses a Card3D as a button.
import { Card3D } from "../components/Card3D";
import { Tile3D } from "../components/Tile3D";
import { Icon3D } from "../components/Icon3D";
import { Glyph } from "../components/Glyph";
import { Button } from "../components/Button";
import { UserAvatar } from "../components/UserAvatar";
import { NavyHero } from "../components/NavyHero";
import { InboxAction } from "../components/InboxAction";
import { AnimatedMoney } from "../components/AnimatedMoney";
import { GlobalSearch } from "../components/GlobalSearch";
import { getPrimaryCurrency } from "../lib/primaryCurrency";
import { GettingStartedCard } from "../components/GettingStartedCard";
import { CoachCards } from "../components/CoachCards";
import { buildCoachCards } from "../lib/coachInsights";
import { AddAccountStepper } from "./AddAccountStepper";
import { QuickEntry } from "./QuickEntry";
import { formatMoney, formatSignedMoney } from "../lib/constants";
import { marketColorFor } from "../lib/marketColors";
import { currencyMeta } from "../lib/design-tokens";
import { useT } from "../lib/i18n";
import { useAsyncLoad } from "../hooks/useAsyncLoad";

function waitForNextPaint(): Promise<void> {
  return new Promise((resolve) => {
    if (
      typeof window === "undefined" ||
      typeof window.requestAnimationFrame !== "function"
    ) {
      resolve();
      return;
    }
    window.requestAnimationFrame(() => window.setTimeout(resolve, 0));
  });
}

// Greeting wave: the hand waves ONCE per app open and then simply stays. A
// module-level flag is the right scope — it survives route changes (Home →
// Loans → Home must not wave again) and resets on a full reload, which is
// what "app open" means for both the PWA and the Capacitor shell.
let wavedThisOpen = false;
const HAND = "\u{1F44B}";

export function HomePage() {
  const { accounts, loadAccounts } = useAccountStore();
  const { transactions, loadTransactions } = useTransactionStore();
  // `cardFundedLoanIds` below keys a loan to the card that funded it, and that
  // link exists ONLY on the loan's origin transaction — which can be older than
  // the default 12-month history window. Missing it would double-count the same
  // debt in "this week" (card bill + the loan). Widened to the oldest loan we
  // hold, and no further (docs/performance.md §7).
  const ensureTransactionHistory = useTransactionStore((s) => s.ensureTransactionHistory);
  const { loans, loadLoans } = useLoanStore();
  const { loadGoals } = useGoalStore();
  const { expenses, loadExpenses } = useUpcomingExpenseStore();
  // Raw slices only — filtering happens inside useMemo (React #185).
  const emiSchedules = useEmiStore((s) => s.schedules);
  const committees = useCommitteeStore((s) => s.committees);
  const committeePayments = useCommitteeStore((s) => s.payments);
  const invMarkets = useInvestmentStore((s) => s.markets);
  const invTrades = useInvestmentStore((s) => s.trades);
  const invPrices = useInvestmentStore((s) => s.prices);
  const mode = useAppModeStore((s) => s.mode);
  const {
    groups,
    balances: groupBalances,
    loadGroups,
    loadBalances,
  } = useSplitStore();
  const navigate = useNavigate();
  const t = useT();
  const [showAddAccount, setShowAddAccount] = useState(false);
  const [showGlobalSearch, setShowGlobalSearch] = useState(false);
  // Tapping a recent transaction opens it for editing (previously inert).
  const [selectedTxn, setSelectedTxn] = useState<Transaction | null>(null);
  // splits_only "Record an IOU" entry — opens QuickEntry locally so the
  // empty-state CTA actually does something instead of pointing at the FAB.
  const [showQuickEntry, setShowQuickEntry] = useState(false);
  const [dismissedReminders, setDismissedReminders] = useState<string[]>([]);
  const [renderNowMs] = useState(() => Date.now());
  // Weekly "Hisaab check" ritual — the stamp drives the "last done Nd ago"
  // line; finishing the walk updates it via onStamped.
  const [showCheck, setShowCheck] = useState(false);
  const [checkStampIso, setCheckStampIso] = useState<string | null>(() => {
    try {
      const raw = localStorage.getItem(CHECK_STAMP_KEY);
      return raw ? ((JSON.parse(raw) as CheckStamp).dateIso ?? null) : null;
    } catch {
      return null;
    }
  });

  const userName = localStorage.getItem("hisaab_user_name") ?? "User";
  // Lazy initialiser: decided once at mount and stable across re-renders, so
  // a data refresh mid-wave can't restart it and a later mount is static.
  const [waveNow] = useState(() => {
    if (wavedThisOpen) return false;
    wavedThisOpen = true;
    return true;
  });
  // The name <p> that hosts the hand is `truncate` (overflow hidden) and
  // shrink-to-content, so its clip edge is flush with the hand; the wave's
  // 16° swing pushes the fingertips ~3px past it. That <p> carries `pr-1`
  // to give the swing room — keep the two in step.
  const handClass = `inline-block ml-1${waveNow ? " animate-wave-once" : ""}`;
  const primaryCurrency = getPrimaryCurrency();
  const userId = useSupabaseAuthStore((s) => s.user?.id ?? "");

  // Load account balances first so the mobile dashboard can paint its core
  // money view before supporting widgets compete for network/CPU.
  const loadEverything = useCallback(async () => {
    if (mode === "splits_only") {
      await Promise.all([loadLoans(), loadGroups().then(loadBalances)]);
      return;
    }
    await loadAccounts();
    await waitForNextPaint();
    await Promise.all([
      loadTransactions(),
      loadLoans(),
      loadGoals(),
      loadExpenses(),
      // "This week" sources: instalment schedules + kameti dates. Both are
      // cheap reads and usually warm (kameti boot-loads in App.tsx).
      useEmiStore.getState().loadSchedules(),
      useCommitteeStore.getState().loadAll(),
      // Portfolio card: three cheap selects (empty tables for non-investors).
      // NON-FATAL — an optional widget must never brick the dashboard (e.g.
      // if the investments migration isn't applied); the card just stays
      // hidden when this fails.
      useInvestmentStore.getState().loadInvestments().catch((err) => {
        console.error("loadInvestments failed (non-fatal)", err);
      }),
    ]);
    // Bounded-history top-up (see the note at `ensureTransactionHistory`).
    // NON-FATAL: the dashboard must render even if this hop fails — the worst
    // case is a card-funded loan showing as a person's debt for one session,
    // which is what the pre-window code did on a cold, offline start anyway.
    const oldestLoanAt = oldestCreatedAt(useLoanStore.getState().loans);
    if (oldestLoanAt) {
      await ensureTransactionHistory({ since: oldestLoanAt }).catch((err) => {
        console.error("ensureTransactionHistory failed (non-fatal)", err);
      });
    }
  }, [
    loadAccounts,
    loadTransactions,
    loadLoans,
    loadGoals,
    loadExpenses,
    loadGroups,
    loadBalances,
    ensureTransactionHistory,
    mode,
  ]);

  const {
    status: loadStatus,
    error: loadError,
    retry: retryLoad,
  } = useAsyncLoad(loadEverything);

  // Until the first load resolves, anything keyed off "is the user-owned
  // collection empty?" is unreliable — every store starts with [] before
  // its Supabase fetch completes. We render placeholder UI (or simply
  // nothing) for those slots until status === 'ready'.
  const isInitialLoading = loadStatus === 'loading';
  const dataReady = loadStatus === 'ready';

  // FIX 2: Credit cards are liabilities, not assets
  // Net worth = regular account balances + (credit card balance - limit) for each card
  const totals = accounts.reduce((acc, a) => {
    if (a.type === "credit_card") {
      const limit = parseFloat(a.metadata.creditLimit || "0");
      const used = limit - a.balance; // amount owed
      acc[a.currency] = (acc[a.currency] ?? 0) - used; // subtract liability
    } else {
      acc[a.currency] = (acc[a.currency] ?? 0) + a.balance;
    }
    return acc;
  }, {} as Record<string, number>);

  const recentTxns = transactions.slice(0, 5);

  // Surface outgoing pending settlements that have been waiting >= 3 days.
  // Snoozable for 24h. Real overdue requests will re-surface — that's
  // intentional: forgetting a settlement is the problem we're solving.
  //
  // IMPORTANT: subscribe to the raw `requests` slice and filter inside
  // a useMemo. Zustand's snapshot getter is invoked twice per render by
  // useSyncExternalStore; if it returns a fresh array each call (which a
  // .filter() inside the selector would), React detects an unstable
  // snapshot and throws #185 "Maximum update depth exceeded."
  const settlementRequests = useSettlementRequestStore((s) => s.requests);
  const persons = usePersonStore((s) => s.persons);
  const overdueNudges = useMemo(() => {
    if (!userId) return [];
    const outgoing = settlementRequests.filter(
      (r) => r.status === 'pending' && r.fromUserId === userId,
    );
    return getOverdueSettlements(outgoing, persons, 3);
  }, [settlementRequests, persons, userId]);

  // Budget usage banner — surfaces categories that crossed their warn
  // threshold. Cheap to compute; runs every time transactions/budgets
  // change. Banner self-hides for the session when dismissed.
  const budgets = useBudgetStore((s) => s.budgets);
  const budgetUsages = useMemo(() => computeBudgetUsages(budgets, transactions), [budgets, transactions]);

  // Quick-tile pending counts. Recurring templates are preloaded at app boot
  // (App.tsx), so reading them here is cheap and already-warm. A subscription
  // is "due soon" when its next charge lands within the next 7 days.
  const recurringTemplates = useRecurringStore((s) => s.templates);
  const subscriptionsDueSoon = useMemo(() => {
    const horizon = renderNowMs + 7 * 24 * 60 * 60 * 1000;
    return recurringTemplates.filter((tpl) => {
      if (!tpl.active) return false;
      const due = new Date(tpl.nextDueDate).getTime();
      return Number.isFinite(due) && due <= horizon;
    }).length;
  }, [recurringTemplates, renderNowMs]);

  // Cash-advance loans, keyed to their funding card — the Loan row carries
  // no card link, only the origin transaction does. thisWeek uses this to
  // keep the same debt (card owed + its EMIs) from double-counting.
  const cardFundedLoanIds = useMemo(() => {
    const map = new Map<string, string>();
    for (const txn of transactions) {
      if (txn.type === "loan_taken" && txn.relatedLoanId && txn.sourceAccountId) {
        map.set(txn.relatedLoanId, txn.sourceAccountId);
      }
    }
    return map;
  }, [transactions]);

  // "This week" rows: the pure lib merges EMIs, kameti rounds, recurring
  // charges, one-off bills and card due days into one 7-day forward view.
  const thisWeekRows = useMemo(
    () =>
      buildThisWeek({
        loans,
        schedules: emiSchedules,
        committees,
        templates: recurringTemplates,
        upcoming: expenses,
        accounts,
        cardFundedLoanIds,
        // Lets a cleared card bill show as praise instead of vanishing.
        transactions,
        today: new Date(renderNowMs),
      }),
    [loans, emiSchedules, committees, recurringTemplates, expenses, accounts, cardFundedLoanIds, transactions, renderNowMs],
  );
  // Header total: the largest outgoing currency bucket (usually the only one).
  const thisWeekOut = useMemo(() => {
    const totals = thisWeekTotals(thisWeekRows).filter((entry) => entry.out > 0);
    return totals[0] ?? null;
  }, [thisWeekRows]);

  // Needs-action queue count (overdue EMIs, missed recurring, kameti rounds,
  // uncategorised expenses) — same pure builder the Inbox "To-do" tab uses,
  // so the number on Home always matches what tapping through reveals.
  const needsActionCount = useMemo(
    () =>
      buildInboxActionItems({
        loans,
        schedules: emiSchedules,
        transactions,
        templates: recurringTemplates,
        committees,
        committeePayments,
        accounts,
        cardFundedLoanIds,
        today: new Date(renderNowMs),
      }).length,
    [loans, emiSchedules, transactions, recurringTemplates, committees, committeePayments, accounts, cardFundedLoanIds, renderNowMs],
  );
  const checkDays = daysSince(checkStampIso, new Date(renderNowMs));

  // Portfolio totals per currency — shown as its OWN card, not folded into
  // "Where I Stand": holdings are volatile and price-dependent, liquid money
  // is settled fact. Blurring them would make both numbers less trustworthy.
  const invMarketRows = useMemo(() => {
    // One row PER MARKET (not per currency) so each part of the card can
    // deep-link into its own market on the Investment Tracker page.
    const rows = invMarkets
      .map((market) => ({ market, bucket: portfolioTotals([market], invTrades, invPrices)[0] }))
      .filter((r) => r.bucket && (r.bucket.currentValue > 0.005 || r.bucket.invested > 0.005));
    return rows.sort((a, b) => {
      const aPrimary = a.market.currency === primaryCurrency;
      const bPrimary = b.market.currency === primaryCurrency;
      if (aPrimary !== bPrimary) return aPrimary ? -1 : 1;
      return b.bucket.currentValue - a.bucket.currentValue;
    });
  }, [invMarkets, invTrades, invPrices, primaryCurrency]);

  // "Mera Hisaab" — the net position INCLUDING people: accounts (cards as
  // −owed) + receivables − payables, with cash advances never counted twice.
  //
  // GROUP OBLIGATIONS (audit G4 / docs/who-owes-me.md §6a): the headline used
  // to net loans + accounts ONLY, so a user who was owed AED 400 across three
  // group splits saw none of it here. `buildWhoOwesMe` supplies that half from
  // `splitStore.groups` + `splitStore.balances` — state HomePage already
  // subscribes to, so this adds no fetch. `currentProfileId` is passed so
  // `resolveMeMemberId` never falls back to the group OWNER (wrong for any
  // group the user does not belong to).
  //
  // Loans deliberately do NOT go through buildWhoOwesMe here:
  // `computeMeraHisaab` carries the card-funded cash-advance exclusion (the
  // card already holds that debt in accountsNet) and re-deriving the loan half
  // would silently drop it. Per currency throughout — never merged.
  const groupObligationInputs = useMemo(
    () => groupInputsFromNetBalances(groups, groupBalances, userId || null),
    [groups, groupBalances, userId],
  );
  const groupObligationTotals = useMemo(
    () =>
      whoOwesTotals(
        buildWhoOwesMe({
          loans: [],
          groups: groupObligationInputs,
          currentProfileId: userId || null,
        }),
      ),
    [groupObligationInputs, userId],
  );
  const meraTotals = useMemo(
    () =>
      mergeGroupObligations(
        computeMeraHisaab({ accounts, loans, cardFundedLoanIds }),
        groupObligationTotals,
      ),
    [accounts, loans, cardFundedLoanIds, groupObligationTotals],
  );
  const meraPrimary = useMemo(
    () => meraTotals.find((entry) => entry.currency === primaryCurrency) ?? meraTotals[0] ?? null,
    [meraTotals, primaryCurrency],
  );
  // Monthly snapshot for the vs-last-month delta. Captured once per load
  // when data is ready; localStorage keeps a rolling 13 months.
  const [meraPrevNet, setMeraPrevNet] = useState<number | null>(null);
  useEffect(() => {
    if (!dataReady || !meraPrimary) return;
    try {
      const raw = localStorage.getItem(NET_SNAPSHOTS_KEY);
      const snapshots: NetSnapshot[] = raw ? JSON.parse(raw) : [];
      const monthKey = monthKeyOf(new Date(renderNowMs));
      setMeraPrevNet(previousMonthNet(snapshots, monthKey, meraPrimary.currency));
      localStorage.setItem(NET_SNAPSHOTS_KEY, JSON.stringify(upsertSnapshot(snapshots, monthKey, meraTotals)));
    } catch (err) {
      console.error("net snapshot failed (non-fatal)", err);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataReady, meraPrimary?.currency]);
  const getMonthStats = (accountId: string) => {
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const monthTxns = transactions.filter(
      (t) => new Date(t.createdAt) >= startOfMonth,
    );
    const income = monthTxns
      .filter(
        (t) => t.type === "income" && t.destinationAccountId === accountId,
      )
      .reduce((s, t) => s + t.amount, 0);
    const expense = monthTxns
      .filter((t) => t.type === "expense" && t.sourceAccountId === accountId)
      .reduce((s, t) => s + t.amount, 0);
    return income > 0 || expense > 0 ? { income, expense } : null;
  };
  const activeLoans = loans.filter((l) => l.status === "active");

  // Proactive coach cards — deterministic insights from data we already have.
  const coachCards = useMemo(() => {
    const now = new Date();
    const dayOfMonth = now.getDate();
    const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const expectedPct = (dayOfMonth / daysInMonth) * 100;
    const dayMs = 86400000;

    const budgetOver = budgetUsages
      .filter((u) => u.overLimit)
      .map((u) => ({ category: u.budget.category, amount: Math.abs(u.remaining), currency: u.budget.currency }));
    const budgetPace = budgetUsages
      .filter((u) => !u.overLimit && u.percent >= 50 && u.percent > expectedPct + 15)
      .map((u) => ({ category: u.budget.category, pct: Math.round(u.percent), daysLeft: daysInMonth - dayOfMonth }));

    // Top expense category this month (primary currency).
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const catMap = new Map<string, { count: number; amount: number }>();
    for (const tx of transactions) {
      if (tx.type !== "expense" || tx.currency !== primaryCurrency || new Date(tx.createdAt) < monthStart) continue;
      const key = tx.category || "Other";
      const e = catMap.get(key) ?? { count: 0, amount: 0 };
      e.count += 1; e.amount += tx.amount; catMap.set(key, e);
    }
    const topEntry = [...catMap.entries()].sort((a, b) => b[1].amount - a[1].amount)[0];
    const topCategory = topEntry ? { category: topEntry[0], count: topEntry[1].count, amount: topEntry[1].amount, currency: primaryCurrency } : null;

    // Recurring renewals within 5 days.
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const soon = recurringTemplates.filter((r) => {
      if (!r.active) return false;
      const due = new Date(r.nextDueDate).getTime();
      return due >= todayStart && due - todayStart <= 5 * dayMs;
    });
    const renewalsSoon = soon.length > 0
      ? { count: soon.length, amount: soon.filter((r) => r.currency === primaryCurrency).reduce((s, r) => s + r.amount, 0), currency: primaryCurrency }
      : null;

    // Overdue receivables: distinct people with active given loans older than 14 days.
    const cutoff = now.getTime() - 14 * dayMs;
    const overduePeople = new Set(
      loans
        .filter((l) => l.status === "active" && l.type === "given" && l.remainingAmount > 0 && new Date(l.createdAt).getTime() < cutoff)
        .map((l) => l.personId ?? l.personName.trim().toLowerCase()),
    );

    const lastTs = transactions.reduce((max, tx) => Math.max(max, new Date(tx.createdAt).getTime()), 0);
    const daysSinceLastEntry = lastTs > 0 ? Math.floor((now.getTime() - lastTs) / dayMs) : null;

    return buildCoachCards({
      budgetOver, budgetPace, renewalsSoon, topCategory,
      overdueReceivableCount: overduePeople.size, goalsBehind: [], daysSinceLastEntry,
    });
  }, [budgetUsages, transactions, primaryCurrency, recurringTemplates, loans]);

  // Distinct people who still have an open balance — drives the Contacts
  // quick-tile badge (an "unsettled" count). Keyed by personId when present,
  // else by normalised name so name-only loans still de-dupe.
  const unsettledContactCount = new Set(
    activeLoans.map((l) => l.personId ?? l.personName.trim().toLowerCase()),
  ).size;
  // Keep receivables/payables grouped by currency so AED and PKR don't merge.
  const sumLoansByCurrency = (items: typeof loans) =>
    items.reduce((acc, l) => {
      acc[l.currency] = (acc[l.currency] ?? 0) + l.remainingAmount;
      return acc;
    }, {} as Record<string, number>);
  const receivablesByCurrency = sumLoansByCurrency(
    activeLoans.filter((l) => l.type === "given"),
  );
  const payablesByCurrency = sumLoansByCurrency(
    activeLoans.filter((l) => l.type === "taken"),
  );
  // Order each currency list so the BIG number is the primary currency when
  // present, otherwise the largest balance. The runner-up (if any) is then
  // shown as a concrete amount line — no vague "+1 more ccy" jargon.
  const orderByPrimary = (entries: [string, number][]) =>
    [...entries].sort((a, b) => {
      if (a[0] === primaryCurrency) return -1;
      if (b[0] === primaryCurrency) return 1;
      return b[1] - a[1];
    });
  const receivableEntries = orderByPrimary(
    Object.entries(receivablesByCurrency).filter(([, v]) => v > 0),
  );
  const payableEntries = orderByPrimary(
    Object.entries(payablesByCurrency).filter(([, v]) => v > 0),
  );
  const hasReceivables = receivableEntries.length > 0;
  const hasPayables = payableEntries.length > 0;

  if (mode === "splits_only") {
    const recvLoanCount = activeLoans.filter((l) => l.type === "given").length;
    const payLoanCount = activeLoans.filter((l) => l.type === "taken").length;
    // Pin the big number to the primary currency (fallback: largest), and
    // capture the runner-up currency as a concrete second amount.
    const orderByPrimaryCcy = (map: Record<string, number>) =>
      Object.entries(map)
        .filter(([, v]) => v > 0)
        .sort((a, b) => {
          if (a[0] === primaryCurrency) return -1;
          if (b[0] === primaryCurrency) return 1;
          return b[1] - a[1];
        });
    const recvOrdered = orderByPrimaryCcy(receivablesByCurrency);
    const payOrdered = orderByPrimaryCcy(payablesByCurrency);
    const recvPrimary = recvOrdered[0]?.[1] ?? 0;
    const recvPrimaryCur = recvOrdered[0]?.[0] ?? primaryCurrency;
    const recvSecond = recvOrdered[1] ?? null;
    const payPrimary = payOrdered[0]?.[1] ?? 0;
    const payPrimaryCur = payOrdered[0]?.[0] ?? primaryCurrency;
    const paySecond = payOrdered[1] ?? null;

    // Live people/group summary for the splits hero subtitle: how many
    // people still owe / are owed plus how many groups carry a balance.
    const splitsPeopleCount = activeLoans.length;
    const activeGroupCount = groups.filter(
      (g) => Math.abs(groupBalances[g.id] ?? 0) > 0,
    ).length;

    return (
      <main className="min-h-dvh bg-cream-bg pb-28">
        <NavyHero>
          <div className="flex items-center justify-between px-5 pt-2 pb-3">
            <button
              onClick={() => navigate("/settings")}
              className="flex items-center gap-3 min-w-0 active:opacity-70"
              aria-label={t('a11y_open_settings')}
            >
              <UserAvatar name={userName} size={36} self />
              <div className="text-left min-w-0">
                <p className="text-[11px] text-white/70 truncate">
                  {t('home_greeting_pre')}
                </p>
                <p className="text-[15px] font-semibold text-white tracking-tight truncate pr-1">
                  {userName}
                  <span aria-hidden="true" className={handClass}>
                    {HAND}
                  </span>
                </p>
              </div>
            </button>
            <div className="flex items-center gap-2 shrink-0">
              <button
                onClick={() => setShowGlobalSearch(true)}
                className="m-ctl relative w-9 h-9 flex items-center justify-center before:absolute before:-inset-1 before:content-['']"
                aria-label={t('a11y_search')}
              >
                <Glyph name="search" size={15} className="text-white/90" />
              </button>
              <InboxAction />
            </div>
          </div>

          <button
            onClick={() =>
              navigate(
                splitsPeopleCount > 0 ? "/loans" : activeGroupCount > 0 ? "/groups" : "/loans",
              )
            }
            className="block w-full text-left px-5 pb-7 active:opacity-80 transition-opacity"
          >
            <p className="text-[10.5px] font-semibold text-white/70 tracking-[0.12em] uppercase">
              {t('home_splits_badge')}
            </p>
            <p className="text-white text-[22px] font-semibold tracking-tight mt-1.5 leading-tight">
              {t('home_splits_tagline')}
            </p>
            {/* Live summary from active loans + groups carrying a balance.
                Falls back to the static blurb when nothing is outstanding. */}
            {splitsPeopleCount > 0 || activeGroupCount > 0 ? (
              <p className="text-[12px] text-white/75 mt-2 max-w-[280px] leading-relaxed">
                {splitsPeopleCount > 0 &&
                  t('home_people_to_settle').replace('{n}', String(splitsPeopleCount))}
                {splitsPeopleCount > 0 && activeGroupCount > 0 && " · "}
                {activeGroupCount > 0 &&
                  t('home_groups_active').replace('{n}', String(activeGroupCount))}
              </p>
            ) : (
              <p className="text-[12px] text-white/70 mt-2 max-w-[280px] leading-relaxed">
                {t('home_splits_blurb')}
              </p>
            )}
          </button>
        </NavyHero>

        <div className="sukoon-body min-h-[60dvh] px-5 pt-5 space-y-4">
          {loadStatus === "error" ? (
            <PageErrorState
              message={loadError ?? t('err_some_data_failed')}
              onRetry={retryLoad}
            />
          ) : isInitialLoading ? (
            // Skeletons in the final geometry (16px stat cards, 15px tiles,
            // 22px feature card) so the first real paint doesn't re-corner
            // anything; .m-skel breathes rather than shimmers.
            <div className="space-y-4" aria-hidden="true">
              <div className="grid grid-cols-2 gap-3">
                <div className="m-skel rounded-[16px] h-[104px]" />
                <div className="m-skel rounded-[16px] h-[104px]" style={{ '--m-skel-delay': '0.15s' } as React.CSSProperties} />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="m-skel rounded-[15px] h-[88px]" style={{ '--m-skel-delay': '0.3s' } as React.CSSProperties} />
                <div className="m-skel rounded-[15px] h-[88px]" style={{ '--m-skel-delay': '0.3s' } as React.CSSProperties} />
              </div>
              <div className="m-skel rounded-[22px] h-32" style={{ '--m-skel-delay': '0.45s' } as React.CSSProperties} />
            </div>
          ) : (
            <>
              {receivableEntries.length === 0 && payableEntries.length === 0 ? (
                // Nothing outstanding: a check glyph (the plainest picture of
                // "settled") on a pink card — pink is the khata / "diya aur
                // liya" tint — with the record-an-IOU CTA.
                <Card3D tint="blush" padding="lg" className="text-center">
                  <Icon3D name="tick" size="lg" float className="mx-auto" />
                  <p className="font-semibold text-ink-900 mt-2">
                    {t('home_no_ious')}
                  </p>
                  <p className="text-[12px] text-ink-600 mt-1">
                    {t('home_record_iou_hint')}
                  </p>
                  <Button
                    depth
                    size="sm"
                    onClick={() => setShowQuickEntry(true)}
                    icon={<Glyph name="plus" size={15} strokeWidth={3} />}
                    className="mt-4 min-h-[44px]"
                  >
                    {t('home_record_iou_cta')}
                  </Button>
                </Card3D>
              ) : (
                // Both halves are tappable, so they are tinted TILES (hard
                // walls), not cards. The gradient dot carries a direction
                // arrow so the meaning never rests on colour alone.
                <div className="grid grid-cols-2 gap-3">
                  <button
                    onClick={() => navigate("/loans?tab=receivables")}
                    className="m-tile m-mint p-4 text-left"
                  >
                    <div className="flex items-center gap-2 mb-2.5">
                      <span className="m-stat-dot m-stat-dot-receive" aria-hidden>
                        <Glyph name="arrow-down" size={14} strokeWidth={3} />
                      </span>
                      <p className="text-[10.5px] font-semibold text-receive-text uppercase tracking-[0.1em]">
                        {t('check_receivable')}
                      </p>
                    </div>
                    {recvLoanCount === 0 ? (
                      <>
                        <p className="text-[21px] font-semibold text-ink-600 tabular-nums">—</p>
                        <p className="text-[11px] text-ink-600 mt-1">{t('home_no_one')}</p>
                      </>
                    ) : (
                      <>
                        <p className="text-[21px] font-semibold text-ink-900 tabular-nums tracking-[-0.03em]">
                          {formatMoney(recvPrimary, recvPrimaryCur)}
                        </p>
                        <p className="text-[11px] text-ink-600 mt-1">
                          {recvSecond
                            ? `+ ${formatMoney(recvSecond[1], recvSecond[0])}`
                            : recvLoanCount === 1
                            ? t('common_loan_one')
                            : t('common_loan_many').replace('{n}', String(recvLoanCount))}
                        </p>
                      </>
                    )}
                  </button>
                  <button
                    onClick={() => navigate("/loans?tab=payables")}
                    className="m-tile m-coral p-4 text-left"
                  >
                    <div className="flex items-center gap-2 mb-2.5">
                      <span className="m-stat-dot m-stat-dot-pay" aria-hidden>
                        <Glyph name="arrow-up" size={14} strokeWidth={3} />
                      </span>
                      <p className="text-[10.5px] font-semibold text-pay-text uppercase tracking-[0.1em]">
                        {t('check_payable')}
                      </p>
                    </div>
                    {payLoanCount === 0 ? (
                      <>
                        <p className="text-[21px] font-semibold text-ink-600 tabular-nums">—</p>
                        <p className="text-[11px] text-ink-600 mt-1">{t('home_no_one')}</p>
                      </>
                    ) : (
                      <>
                        <p className="text-[21px] font-semibold text-ink-900 tabular-nums tracking-[-0.03em]">
                          {formatMoney(payPrimary, payPrimaryCur)}
                        </p>
                        <p className="text-[11px] text-ink-600 mt-1">
                          {paySecond
                            ? `+ ${formatMoney(paySecond[1], paySecond[0])}`
                            : payLoanCount === 1
                            ? t('common_loan_one')
                            : t('common_loan_many').replace('{n}', String(payLoanCount))}
                        </p>
                      </>
                    )}
                  </button>
                </div>
              )}

              {/* Splits-only quick-action shortcuts. Since this mode has no
                  accounts/transactions surfaces, surface the remaining
                  browse destinations (Contacts, Activity) directly on home
                  so they're not buried in Settings. */}
              {/* Same 2-up shortcuts as tiles, glyph stacked over the label:
                  the labels are two words each ("Aap ke Contacts", "Recent
                  Activity") and need the tile's full width. */}
              <div className="grid grid-cols-2 gap-3">
                <Tile3D
                  tint="blush"
                  icon="person"
                  iconPlacement="top"
                  title={t('splits_home_contacts')}
                  subtitle={t('splits_home_contacts_sub')}
                  onClick={() => navigate("/contacts")}
                />
                <Tile3D
                  tint="sky"
                  icon="receipt"
                  iconPlacement="top"
                  title={t('splits_home_activity')}
                  subtitle={t('splits_home_activity_sub')}
                  onClick={() => navigate("/activity")}
                />
              </div>

              <div>
                <div className="flex items-center justify-between mb-2.5 px-1">
                  <h2 className="text-[10.5px] font-semibold text-ink-500 uppercase tracking-[0.12em]">
                    {t('home_group_splits')}
                  </h2>
                  <button
                    onClick={() => navigate("/groups")}
                    className="text-[11px] font-semibold text-accent-600 active:opacity-70"
                  >
                    {t('common_view_all')}
                  </button>
                </div>
                {groups.length === 0 ? (
                  <EmptyState
                    icon={Users}
                    tone="accent"
                    size="compact"
                    title={t('home_no_splits_title')}
                    description={t('home_no_splits_desc')}
                    subhint={t('home_no_splits_subhint')}
                  />
                ) : (
                  <Card3D padding="none" className="overflow-hidden divide-y divide-cream-hairline">
                    {groups.slice(0, 3).map((group) => {
                      const balance = groupBalances[group.id] ?? 0;
                      return (
                        <button
                          key={group.id}
                          onClick={() => navigate(`/group/${group.id}`)}
                          className="w-full flex items-center gap-3 px-4 py-3.5 text-left active:bg-cream-soft transition-colors"
                        >
                          <div className="m-ctl w-9 h-9 flex items-center justify-center shrink-0 text-base">
                            {group.emoji}
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="text-[14px] font-medium text-ink-900 truncate tracking-tight">
                              {group.name}
                            </p>
                            <p className="text-[11px] text-ink-500 mt-0.5">
                              {group.members.length === 1
                                ? t('common_member_one')
                                : t('common_member_many').replace('{n}', String(group.members.length))}
                            </p>
                          </div>
                          <p
                            className={`text-[13px] font-semibold tabular-nums ${
                              balance > 0
                                ? "text-receive-text"
                                : balance < 0
                                ? "text-pay-text"
                                : "text-ink-400"
                            }`}
                          >
                            {balance === 0
                              ? t('settled')
                              : `${balance > 0 ? "+" : "−"}${formatMoney(
                                  Math.abs(balance),
                                  group.currency,
                                )}`}
                          </p>
                        </button>
                      );
                    })}
                  </Card3D>
                )}
              </div>

              <Card3D tint="sky" padding="sm">
                <div className="flex items-center gap-3">
                  {/* An alarm clock, not the megaphone the pack files under
                      `bell` — this row is about reminders reaching you. */}
                  <Icon3D name="alarm" size="sm" />
                  <p className="text-[12px] text-ink-700 leading-relaxed">
                    {t('home_notify_needs_app')}
                  </p>
                </div>
              </Card3D>
            </>
          )}
        </div>
        <GlobalSearch open={showGlobalSearch} onClose={() => setShowGlobalSearch(false)} />
        <QuickEntry open={showQuickEntry} onClose={() => setShowQuickEntry(false)} />
      </main>
    );
  }

  const hour = new Date().getHours();
  // Greeting follows the selected language: neutral English ("Good Morning")
  // vs Roman Urdu ("Subah Bakhair"). Keys live in i18n.ts.
  const greeting = t(
    hour < 5
      ? "greet_night"
      : hour < 12
      ? "greet_morning"
      : hour < 17
      ? "greet_afternoon"
      : hour < 21
      ? "greet_evening"
      : "greet_night",
  );
  const greetingEmoji =
    hour < 5
      ? "\u{1F319}"
      : hour < 12
      ? "\u{1F305}"
      : hour < 17
      ? "\u{2600}\u{FE0F}"
      : hour < 21
      ? "\u{1F306}"
      : "\u{1F319}";

  // Upcoming expense reminders — within their reminder window
  const urgentExpenses = expenses
    .filter(
      (e) => e.status === "upcoming" && !dismissedReminders.includes(e.id),
    )
    .filter((e) => {
      const daysLeft = Math.ceil(
        (new Date(e.dueDate).getTime() - renderNowMs) / (1000 * 60 * 60 * 24),
      );
      const reminderWindow = e.reminderDaysBefore ?? 7;
      return daysLeft <= reminderWindow;
    })
    .sort(
      (a, b) => new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime(),
    );

  const primaryTotal = totals[primaryCurrency] ?? 0;
  const accountCount = accounts.length;
  // Show ALL non-primary currency lines — including negatives. Hiding the
  // negatives understated the user's liabilities (e.g. a PKR credit card
  // owed) and made the net-worth line read more positive than reality.
  const otherTotals = Object.entries(totals).filter(
    ([cur, amt]) => cur !== primaryCurrency && amt !== 0,
  );
  const budgetAttentionCount = budgetUsages.filter((usage) => usage.overWarn).length;

  // Does the concrete BudgetWarningBanner actually render? It self-hides for
  // the session via this sessionStorage flag. We mirror the check here so the
  // NextStepHint never duplicates a banner that's already on screen, and so
  // the attention-banner cap counts only what's truly visible.
  const budgetBannerDismissed = (() => {
    try {
      return sessionStorage.getItem("hisaab_budget_warning_dismissed_v1") === "1";
    } catch {
      return false;
    }
  })();
  const budgetBannerVisible = budgetAttentionCount > 0 && !budgetBannerDismissed;

  // De-dup: the urgent-expense strip and BudgetWarningBanner are concrete UI
  // that already speak for those signals. When either is on screen we suppress
  // the matching NextStepHint branch so each alert appears exactly once. The
  // hint is then reserved for onboarding ("no activity yet") and the calm
  // "all up to date" state — and that calm state is hidden whenever any real
  // attention banner is showing.
  const hasUrgentStrip = urgentExpenses.length > 0;
  const hasAttentionBanner =
    hasUrgentStrip || budgetBannerVisible || overdueNudges.length > 0;

  // Cap simultaneous attention banners at 2 (priority: time-sensitive bills →
  // budget → settlement nudges). Anything beyond the first two collapses into
  // a single "N more reminders" chip so the home feed never stacks a wall of
  // amber cards. The chip routes to the most relevant overflow destination.
  const ATTENTION_CAP = 2;
  const activeBanners: { key: "urgent" | "budget" | "settlement"; href: string }[] = [];
  if (hasUrgentStrip) activeBanners.push({ key: "urgent", href: "/subscriptions" });
  if (budgetBannerVisible) activeBanners.push({ key: "budget", href: "/budgets" });
  if (overdueNudges.length > 0) activeBanners.push({ key: "settlement", href: "/inbox" });
  const shownBannerKeys = new Set(activeBanners.slice(0, ATTENTION_CAP).map((b) => b.key));
  const collapsedBanners = activeBanners.slice(ATTENTION_CAP);
  const collapsedReminderHref = collapsedBanners[0]?.href ?? "/";

  // The calm "nothing needs you" status card (copy in i18n, surface a tinted
  // card). Same three conditions as ever.
  const showCalmStatus =
    // The Getting Started card covers the no-account and no-transaction cases.
    accountCount > 0 &&
    transactions.length > 0 &&
    // A concrete strip/banner is already covering the active signal(s) —
    // don't echo it as a hint, and never let the calm state fire alongside
    // an alert.
    !hasAttentionBanner;

  return (
    <main className="min-h-dvh bg-cream-bg pb-28">
      <NavyHero>
        {/* Greeting row: avatar (-> Settings) + bell (-> Inbox) */}
        <div className="flex items-center justify-between px-5 pt-2 pb-3">
          <button
            onClick={() => navigate("/settings")}
            className="flex items-center gap-3 min-w-0 active:opacity-70"
            aria-label={t('a11y_open_settings')}
          >
            <UserAvatar name={userName} size={36} self />
            <div className="text-left min-w-0">
              <p className="text-[11px] text-white/70 truncate">
                {greeting} {greetingEmoji}
              </p>
              <p className="text-[15px] font-semibold text-white tracking-tight truncate pr-1">
                {userName}
                <span aria-hidden="true" className={handClass}>
                  {HAND}
                </span>
              </p>
            </div>
          </button>
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={() => setShowGlobalSearch(true)}
              className="m-ctl relative w-9 h-9 flex items-center justify-center before:absolute before:-inset-1 before:content-['']"
              aria-label={t('a11y_search')}
            >
              <Glyph name="search" size={15} className="text-white/90" />
            </button>
            <InboxAction />
          </div>
        </div>

        {/* Net worth display. Tap (when accounts exist) -> /accounts. */}
        <button
          onClick={() => accountCount > 0 && navigate('/accounts')}
          disabled={accountCount === 0}
          className="block w-full text-left px-5 pb-7 disabled:cursor-default active:opacity-80 transition-opacity"
        >
          <p className="text-[10.5px] font-semibold text-white/70 tracking-[0.12em] uppercase">
            {t('home_your_money')}
          </p>
          {isInitialLoading ? (
            <div className="m-skel mt-2 h-11 w-52 rounded-xl" />
          ) : accountCount === 0 ? (
            <>
              <p className="text-white text-[22px] font-semibold tracking-tight mt-1.5 leading-tight">
                {t('home_no_accounts_title')}
              </p>
              <p className="text-[12px] text-white/70 mt-1.5 max-w-[260px] leading-relaxed">
                {t('home_no_accounts_hero_desc')}
              </p>
            </>
          ) : (
            <>
              <div className="mt-1.5 flex items-center gap-1.5">
                {/* The one number the whole app is about. It counts up on
                    reveal and travels on change, so a balance that moved
                    SHOWS that it moved instead of silently being different.
                    AnimatedMoney is a leaf on purpose — see its header;
                    putting the rAF loop here would re-render this page ~50
                    times per run. */}
                <AnimatedMoney
                  amount={primaryTotal}
                  currency={primaryCurrency}
                  size={46}
                  tone="on-navy"
                  extrude="violet"
                  animate={!isInitialLoading}
                />
                {/* Non-colour liability cue: down-caret + word so a negative
                    net worth never relies on the minus sign alone. */}
                {primaryTotal < 0 && (
                  <span className="inline-flex items-center gap-0.5 rounded-full bg-white/12 px-1.5 py-0.5 text-[10px] font-semibold text-white/80">
                    <Glyph name="chevron-down" size={11} strokeWidth={3} />
                    {t('home_owed')}
                  </span>
                )}
              </div>
              {primaryTotal < 0 && (
                <p className="text-[10.5px] text-white/70 mt-1">
                  {t('home_net_liab')}
                </p>
              )}
              <p className="text-[12px] text-white/70 mt-3">
                {accountCount === 1
                  ? t('common_account_one')
                  : t('common_account_many').replace('{n}', String(accountCount))}
                {otherTotals.length > 0 && (
                  <>
                    {" · "}
                    {otherTotals
                      .map(([cur, amt]) => `${formatMoney(amt, cur)}`)
                      .join(" · ")}
                  </>
                )}
              </p>
            </>
          )}
        </button>
      </NavyHero>

      <div className="sukoon-body min-h-[60dvh] px-5 pt-5 space-y-4">
        {/* Load-failure banner. Stays visible until retry succeeds. */}
        {loadStatus === "error" && (
          <PageErrorState
            variant="inline"
            title={t('home_err_dashboard')}
            message={loadError ?? t('err_some_data_failed')}
            onRetry={retryLoad}
          />
        )}

        {/* First-load skeleton — never flash "Add an account" / quick tiles
            empty state before the accounts query finishes. */}
        {isInitialLoading && (
          // Skeletons in the final geometry — stat cards, the 4x2 tile grid,
          // the feature card — so the first real paint doesn't re-corner
          // anything.
          <div className="space-y-4" aria-hidden="true">
            <div className="grid grid-cols-2 gap-3">
              <div className="m-skel rounded-[16px] h-[104px]" />
              <div className="m-skel rounded-[16px] h-[104px]" style={{ '--m-skel-delay': '0.15s' } as React.CSSProperties} />
            </div>
            <div className="grid grid-cols-4 gap-2.5">
              {Array.from({ length: 8 }).map((_, i) => (
                <div
                  key={i}
                  className="m-skel rounded-[15px] h-[84px]"
                  style={{ '--m-skel-delay': `${0.3 + (i % 4) * 0.05}s` } as React.CSSProperties}
                />
              ))}
            </div>
            <div className="m-skel rounded-[22px] h-32" style={{ '--m-skel-delay': '0.45s' } as React.CSSProperties} />
          </div>
        )}

        {/* Guided first-win: add an account, then log the first entry. Shows
            progress and disappears once both are done. */}
        {dataReady && (accountCount === 0 || transactions.length === 0) && (
          <GettingStartedCard
            accountCount={accountCount}
            transactionCount={transactions.length}
            onAddAccount={() => setShowAddAccount(true)}
            onLogEntry={() => navigate("/transactions")}
          />
        )}

        {/* Proactive coach — surfaces what needs attention (over budget,
            overdue money, renewals…) for users who are past setup. */}
        {dataReady && accountCount > 0 && transactions.length > 0 && (
          <CoachCards cards={coachCards} />
        )}

        {/* 2-up: To Receive | To Pay */}
        {accountCount > 0 && (hasReceivables || hasPayables) && (
          // Tappable, so tinted tiles (mint = to receive, coral = to pay),
          // each keyed by a gradient dot with a direction arrow.
          <div className="grid grid-cols-2 gap-3">
            <button
              onClick={() => navigate("/loans?tab=receivables")}
              className="m-tile m-mint p-4 text-left"
            >
              <div className="flex items-center gap-2 mb-2.5">
                <span className="m-stat-dot m-stat-dot-receive" aria-hidden>
                  <Glyph name="arrow-down" size={14} strokeWidth={3} />
                </span>
                <p className="text-[10.5px] font-semibold text-receive-text uppercase tracking-[0.1em]">
                  {t("loan_receivable")}
                </p>
              </div>
              {hasReceivables ? (
                <>
                  <p className="text-[21px] font-semibold text-ink-900 tabular-nums tracking-[-0.03em]">
                    {formatMoney(
                      receivableEntries[0][1],
                      receivableEntries[0][0],
                    )}
                  </p>
                  <p className="text-[11px] text-ink-600 mt-1">
                    {receivableEntries.length > 1
                      ? `+ ${formatMoney(
                          receivableEntries[1][1],
                          receivableEntries[1][0],
                        )}`
                      : receivableEntries[0][0]}
                  </p>
                </>
              ) : (
                <>
                  <p className="text-[21px] font-semibold text-ink-600 tabular-nums">
                    —
                  </p>
                  <p className="text-[11px] text-ink-600 mt-1">{t('home_no_one')}</p>
                </>
              )}
            </button>
            <button
              onClick={() => navigate("/loans?tab=payables")}
              className="m-tile m-coral p-4 text-left"
            >
              <div className="flex items-center gap-2 mb-2.5">
                <span className="m-stat-dot m-stat-dot-pay" aria-hidden>
                  <Glyph name="arrow-up" size={14} strokeWidth={3} />
                </span>
                <p className="text-[10.5px] font-semibold text-pay-text uppercase tracking-[0.1em]">
                  {t("loan_payable")}
                </p>
              </div>
              {hasPayables ? (
                <>
                  <p className="text-[21px] font-semibold text-ink-900 tabular-nums tracking-[-0.03em]">
                    {formatMoney(payableEntries[0][1], payableEntries[0][0])}
                  </p>
                  <p className="text-[11px] text-ink-600 mt-1">
                    {payableEntries.length > 1
                      ? `+ ${formatMoney(
                          payableEntries[1][1],
                          payableEntries[1][0],
                        )}`
                      : payableEntries[0][0]}
                  </p>
                </>
              ) : (
                <>
                  <p className="text-[21px] font-semibold text-ink-600 tabular-nums">
                    —
                  </p>
                  <p className="text-[11px] text-ink-600 mt-1">{t('home_no_one')}</p>
                </>
              )}
            </button>
          </div>
        )}

        {/* Quick-access tile grid — 4 columns x 2 rows of 1d tiles, each a
            28px extruded glyph in its section's accent over a small label
            (the handoff's Home grid). Glyphs sit inside the tiles, so the
            grid needs no float clearance. Corner badges are the violet count
            pill. */}
        {accountCount > 0 && (
          <div className="grid grid-cols-4 gap-2.5">
            <Tile3D
              tint="mint"
              icon="target"
              iconPlacement="top"
              iconSize="lg"
              title={t("nav_goals")}
              onClick={() => navigate("/goals")}
            />
            <Tile3D
              tint="gold"
              icon="wallet"
              iconPlacement="top"
              iconSize="lg"
              title={t("home_tile_budget")}
              badge={budgetAttentionCount > 0 ? (budgetAttentionCount > 9 ? "9+" : budgetAttentionCount) : undefined}
              badgePlacement="corner"
              onClick={() => navigate("/budgets")}
            />
            <Tile3D
              tint="sky"
              icon="card"
              iconPlacement="top"
              iconSize="lg"
              title={t("home_tile_subs")}
              badge={subscriptionsDueSoon > 0 ? (subscriptionsDueSoon > 9 ? "9+" : subscriptionsDueSoon) : undefined}
              badgePlacement="corner"
              onClick={() => navigate("/subscriptions")}
            />
            <Tile3D
              tint="accent"
              icon="chart"
              iconPlacement="top"
              iconSize="lg"
              title={t("nav_analytics")}
              onClick={() => navigate("/analytics")}
            />
            <Tile3D
              tint="neutral"
              icon="receipt"
              iconPlacement="top"
              iconSize="lg"
              title={t("nav_activity")}
              onClick={() => navigate("/activity")}
            />
            <Tile3D
              tint="blush"
              /* `person` — a single figure is exactly what a contacts list
                 is a list OF. (`chat`, two speech bubbles, is reserved for
                 the GROUP surfaces, where "several people" is the point.) */
              icon="person"
              iconPlacement="top"
              iconSize="lg"
              title={t("home_tile_contacts")}
              badge={unsettledContactCount > 0 ? (unsettledContactCount > 9 ? "9+" : unsettledContactCount) : undefined}
              badgePlacement="corner"
              onClick={() => navigate("/contacts")}
            />
            <Tile3D
              tint="gold"
              icon="coins"
              iconPlacement="top"
              iconSize="lg"
              title={t("kameti_title")}
              onClick={() => navigate("/kameti")}
            />
            <Tile3D
              tint="mint"
              icon="trophy"
              iconPlacement="top"
              iconSize="lg"
              title={t("home_tile_invest")}
              onClick={() => navigate("/investments")}
            />
          </div>
        )}

        {/* "Mera Hisaab" — one net-position number that includes PEOPLE:
            accounts (cards as −owed) + what people owe you − what you owe,
            across loans AND group splits. Loans as balance-sheet items is THE
            differentiator, visible daily; settling a loan or a group split
            visibly moves this number. */}
        {dataReady && meraPrimary && (loans.length > 0 || accounts.length > 0 || groupObligationTotals.length > 0) && (
          <Card3D as="section" padding="lg" feature>
            <div className="flex items-center justify-between mb-1.5">
              <h2 className="text-[10.5px] font-semibold text-ink-600 uppercase tracking-[0.12em] flex items-center gap-1.5">
                <Glyph name="savings" size={12} tone="green" /> {t("home_mera_hisaab")}
              </h2>
              {meraPrevNet !== null && Math.abs(meraPrimary.net - meraPrevNet) > 0.005 && (
                <span className={`text-[10.5px] font-semibold tabular-nums ${meraPrimary.net >= meraPrevNet ? "text-receive-text" : "text-pay-text"}`}>
                  {meraPrimary.net >= meraPrevNet ? "▲" : "▼"} {formatMoney(Math.abs(meraPrimary.net - meraPrevNet), meraPrimary.currency)} · {t("mh_vs_last")}
                </span>
              )}
            </div>
            <p className={`text-[28px] font-semibold tabular-nums tracking-[-0.04em] leading-none mt-1 ${meraPrimary.net < 0 ? "text-pay-text" : "text-ink-900"}`}>
              {formatSignedMoney(meraPrimary.net, meraPrimary.currency)}
            </p>
            {(meraPrimary.receivable > 0.005 || meraPrimary.payable > 0.005) && (
              <p className="text-[11px] text-ink-500 mt-1 tabular-nums">
                {meraPrimary.receivable > 0.005 && (
                  <span className="text-receive-text font-medium">
                    {t("mh_receivable")} +{formatMoney(meraPrimary.receivable, meraPrimary.currency)}
                  </span>
                )}
                {meraPrimary.receivable > 0.005 && meraPrimary.payable > 0.005 && <span> · </span>}
                {meraPrimary.payable > 0.005 && (
                  <span className="text-pay-text font-medium">
                    {t("mh_payable")} −{formatMoney(meraPrimary.payable, meraPrimary.currency)}
                  </span>
                )}
              </p>
            )}
            {meraTotals.length > 1 && (
              <p className="text-[10.5px] text-ink-600 mt-1 tabular-nums">
                {meraTotals
                  .filter((entry) => entry.currency !== meraPrimary.currency)
                  .map((entry) => formatSignedMoney(entry.net, entry.currency))
                  .join(" · ")}
              </p>
            )}
          </Card3D>
        )}

        {/* Investment Tracker — the record-keeping investments, surfaced
            instead of invisible. One tappable row PER MARKET, each landing
            scoped on its own market; the header opens the full book. Only
            renders when something is actually held. */}
        {dataReady && invMarketRows.length > 0 && (
          <Card3D padding="none" className="overflow-hidden">
            <button
              onClick={() => navigate("/investments")}
              className="w-full flex items-center justify-between px-4 pt-3.5 pb-2 text-left active:bg-cream-soft transition-colors"
            >
              {/* span, not h2 — heading content inside a <button> is invalid
                  and vanishes from the screen-reader outline anyway. */}
              <span className="text-[10.5px] font-semibold text-ink-600 uppercase tracking-[0.12em] flex items-center gap-1.5">
                <Glyph name="trend" size={12} tone="violet" /> {t("inv_title")}
              </span>
              <Glyph name="chevron-right" size={14} className="text-ink-400" />
            </button>
            <div className="divide-y divide-cream-hairline">
              {invMarketRows.map(({ market, bucket: b }) => {
                const color = marketColorFor(market.id);
                // Unpriced holdings sit at COST inside currentValue — disclose
                // it (like the Investment Tracker page does) and never dress an
                // entirely-unpriced bucket in a P&L line it doesn't have.
                const allUnpriced = b.unpricedCount > 0 && Math.abs(b.unrealized) < 0.005;
                const pct = b.invested > 0 ? (b.unrealized / b.invested) * 100 : 0;
                // Sign from the ROUNDED value: -0.004% must read 0.0, not -0.0.
                const pctStr = Math.abs(pct) < 0.05 ? "0.0" : pct.toFixed(1);
                const up = b.unrealized >= 0;
                return (
                  <button
                    key={market.id}
                    onClick={() => navigate(`/investments?market=${market.id}`)}
                    className="w-full flex items-center justify-between gap-3 px-4 py-3 text-left active:bg-cream-soft transition-colors"
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
                      <span className={`w-2 h-2 rounded-full ${color.dot} shrink-0`} />
                      <div className="min-w-0">
                        <p className="text-[13px] font-semibold text-ink-900 truncate tracking-tight">{market.name}</p>
                        <p className="text-[10.5px] text-ink-400">{market.currency}</p>
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <p className="text-[15px] font-semibold tabular-nums tracking-tight text-ink-900">
                        {formatMoney(b.currentValue, market.currency)}
                      </p>
                      {allUnpriced ? (
                        <p className="text-[10.5px] text-ink-400 mt-0.5 tabular-nums">
                          {t("inv_unpriced_chip").replace("{n}", String(b.unpricedCount))}
                        </p>
                      ) : (
                        <p className={`text-[10.5px] font-medium mt-0.5 tabular-nums ${up ? "text-receive-text" : "text-pay-text"}`}>
                          {up ? "▲" : "▼"} {formatMoney(Math.abs(b.unrealized), market.currency)} · {pctStr.startsWith("-") ? "" : "+"}{pctStr}%
                          {b.unpricedCount > 0 && (
                            <span className="text-ink-400 font-normal"> · {t("inv_unpriced_chip").replace("{n}", String(b.unpricedCount))}</span>
                          )}
                        </p>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          </Card3D>
        )}

        {/* Weekly ritual + needs-action queue — the review-ceremony entry.
            Top row opens the 5-minute Hisaab check (with its days-since
            memory); the count row appears only when something actually
            needs a hand (overdue EMIs, missed recurring, kameti rounds,
            unfiled expenses) and lands on the Inbox "To-do" tab. */}
        {dataReady && (
          // Both rows are taps, so both are tiles. A `tick` floats over the
          // ritual row — the Hisaab CHECK is literally a checkmark, where
          // the old `shield` drew protection, a promise this row does not
          // make; the to-do row wears gold + an ALARM CLOCK (the asset
          // named `bell` is a megaphone — announcement, not "this needs
          // your hand") and keeps its count in the tile badge. Done-today
          // flips the ritual tile to mint so keeping the ritual is visibly
          // rewarded.
          <div className="space-y-3">
            <Tile3D
              tint={checkDays === 0 ? "mint" : "accent"}
              icon="tick"
              title={t("check_entry_title")}
              subtitle={
                checkDays === null
                  ? t("check_entry_never")
                  : checkDays === 0
                    ? t("check_entry_today")
                    : checkDays === 1
                      ? t("check_entry_days_one")
                      : t("check_entry_days").replace("{d}", String(checkDays))
              }
              onClick={() => setShowCheck(true)}
            />
            {needsActionCount > 0 && (
              <Tile3D
                tint="gold"
                icon="alarm"
                title={
                  needsActionCount === 1
                    ? t("home_action_one")
                    : t("home_action_many").replace("{n}", String(needsActionCount))
                }
                subtitle={t("home_action_sub")}
                badge={needsActionCount > 9 ? "9+" : needsActionCount}
                onClick={() => navigate("/inbox", { state: { tab: "action" } })}
              />
            )}
          </div>
        )}

        {/* "This week" — every KNOWN obligation in the next 7 days, merged:
            EMIs, kameti rounds, recurring charges, bills, card due days.
            The forward view no bank-sync app can match, from data Hisaab
            uniquely holds. Hidden when the week is clear (no noise). */}
        {dataReady && thisWeekRows.length > 0 && (
          <div>
            <div className="flex items-center justify-between mb-2.5 px-1">
              <h2 className="text-[10.5px] font-semibold text-ink-500 uppercase tracking-[0.12em]">
                {t("home_this_week")}
              </h2>
              {thisWeekOut && (
                <span className="text-[10.5px] font-semibold text-pay-text tabular-nums">
                  {t("home_week_out").replace("{amount}", formatMoney(thisWeekOut.out, thisWeekOut.currency))}
                </span>
              )}
            </div>
            <Card3D padding="none" className="overflow-hidden divide-y divide-cream-hairline">
              {thisWeekRows.slice(0, 5).map((row) => (
                <button
                  key={row.id}
                  onClick={() => navigate(row.href)}
                  className="w-full flex items-center gap-2.5 px-3.5 py-2.5 text-left active:bg-cream-soft transition-colors"
                >
                  <div className="m-ctl w-8 h-8 rounded-[10px] flex items-center justify-center shrink-0">
                    {row.sub.kind === "cleared" ? (
                      <Glyph name="check" size={14} tone="green" />
                    ) : (
                      <Glyph name="calendar" size={14} tone={row.daysUntil <= 1 ? "gold" : "blue"} />
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-[13px] font-medium text-ink-900 truncate tracking-tight">{row.label}</p>
                    <p className={`text-[10.5px] leading-tight ${row.sub.kind === "cleared" ? "text-receive-text font-medium" : "text-ink-500"}`}>
                      {(() => {
                        // Structured sub → translated line (the lib stays
                        // i18n-free). 'none' rows show only the due phrase.
                        if (row.sub.kind === "cleared") {
                          return row.sub.daysEarly === 0
                            ? t("tw_cleared_today")
                            : t("tw_cleared").replace("{n}", String(row.sub.daysEarly));
                        }
                        const sub =
                          row.sub.kind === "emi" ? `EMI #${row.sub.n}`
                          : row.sub.kind === "round" ? (
                              row.sub.count > 1
                                ? t("tw_rounds_count").replace("{c}", String(row.sub.count))
                                : t("kameti_round_of").replace("{r}", String(row.sub.r)).replace("{n}", String(row.sub.total))
                            )
                          : row.sub.kind === "cadence" ? t(`tw_cad_${row.sub.cadence}` as Parameters<typeof t>[0])
                          : row.sub.kind === "category" ? row.sub.text
                          : null;
                        const due = row.daysUntil === 0 ? t("cc_due_today") : t("cc_due_in").replace("{n}", String(row.daysUntil));
                        return sub ? `${sub} · ${due}` : due;
                      })()}
                    </p>
                  </div>
                  {row.amount !== null && (
                    <p className={`text-[13px] font-semibold tabular-nums tracking-tight ${row.direction === "receive" ? "text-receive-text" : "text-ink-900"}`}>
                      {row.direction === "receive" ? "+" : ""}{formatMoney(row.amount, row.currency)}
                    </p>
                  )}
                </button>
              ))}
            </Card3D>
            {thisWeekRows.length > 5 && (
              <p className="text-[10.5px] text-ink-400 mt-1.5 px-1">
                {t("home_week_more").replace("{n}", String(thisWeekRows.length - 5))}
              </p>
            )}
          </div>
        )}

        {/* The calm status card: a mint card with a sparkle glyph and i18n
            copy (it replaced a NextStepHint whose copy was hardcoded). */}
        {dataReady && showCalmStatus && (
          <Card3D tint="mint" padding="lg" icon="sparkle">
            <div className="flex items-center gap-1.5">
              <Glyph name="check" size={12} tone="green" />
              <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-receive-text">
                {t('hint_current_status')}
              </p>
            </div>
            <p className="text-[13px] font-semibold text-ink-900 tracking-tight mt-1 leading-snug">
              {t('home_status_ok_title')}
            </p>
            {/* -me-11 gives back 44 of the 64px gutter Card3D's `icon` prop
                reserves on the whole card: the sparkle only overhangs the
                first line or two, and a three-line paragraph should not pay
                for it. */}
            <p className="text-[12px] text-ink-600 mt-1.5 leading-relaxed -me-11">
              {t('home_status_ok_next')}
            </p>
          </Card3D>
        )}

        {shownBannerKeys.has("urgent") && (
          <div className="space-y-2">
            {urgentExpenses.slice(0, 2).map((exp) => {
              const daysLeft = Math.ceil(
                (new Date(exp.dueDate).getTime() - renderNowMs) /
                  (1000 * 60 * 60 * 24),
              );
              return (
                <Card3D key={exp.id} tint="gold" padding="sm">
                  <div className="flex items-center gap-3">
                    <Icon3D name="calendar" size="sm" className="shrink-0" />
                    <div className="flex-1 min-w-0">
                      <p className="text-[13px] font-semibold text-ink-900 truncate">
                        {exp.title} — {formatMoney(exp.amount, exp.currency)}
                      </p>
                      <p className="text-[11px] text-warn-700 mt-0.5">
                        {daysLeft <= 0
                          ? t('home_overdue_bang')
                          : daysLeft === 1
                          ? t('home_due_tomorrow')
                          : `${daysLeft} ${t("upcoming_due_in")}`}
                      </p>
                    </div>
                    <button
                      onClick={() =>
                        setDismissedReminders((d) => [...d, exp.id])
                      }
                      className='relative w-7 h-7 rounded-lg flex items-center justify-center text-ink-600 active:bg-cream-soft transition-colors shrink-0 before:absolute before:-inset-2 before:content-[""]'
                      aria-label={t('a11y_dismiss')}
                    >
                      <Glyph name="close" size={14} />
                    </button>
                  </div>
                </Card3D>
              );
            })}
          </div>
        )}

        {/* Accounts preview — max 3 rows. "See all" wires to /accounts in
            the next slice; for now the inline Add button is the entry. */}
        {accountCount > 0 && (
          <div>
            <div className="flex items-center justify-between mb-2.5 px-1">
              <h2 className="text-[10.5px] font-semibold text-ink-500 uppercase tracking-[0.12em]">
                {t("home_accounts")} · {accountCount}
              </h2>
              <button
                onClick={() => setShowAddAccount(true)}
                className="text-[11px] text-accent-600 font-semibold active:opacity-70 flex items-center gap-1"
                aria-label={t('a11y_add_account')}
              >
                <Glyph name="plus" size={12} strokeWidth={3} /> {t('common_add')}
              </button>
            </div>
            <Card3D padding="none" className="overflow-hidden divide-y divide-cream-hairline">
              {accounts.slice(0, 3).map((a) => {
                const meta = currencyMeta[a.currency];
                const monthStats = getMonthStats(a.id);
                return (
                  <button
                    key={a.id}
                    onClick={() => navigate(`/account/${a.id}`)}
                    className="w-full flex items-center gap-2.5 px-3.5 py-2.5 text-left active:bg-cream-soft transition-colors"
                  >
                    <div className="m-ctl w-8 h-8 rounded-[10px] flex items-center justify-center shrink-0">
                      <Glyph name="bank" size={14} tone="violet" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-[13px] font-medium text-ink-900 truncate tracking-tight">
                        {a.name}
                      </p>
                      <p className="text-[10.5px] text-ink-500 leading-tight">
                        {a.type.replace(/_/g, " ")}
                        {monthStats && (
                          <span className="text-receive-text font-medium">
                            {" · "}+{formatMoney(monthStats.income, a.currency)}{" "}
                            {t('home_month_in_suffix')}
                          </span>
                        )}
                      </p>
                    </div>
                    <div className="text-right shrink-0">
                      <p className={`text-[13px] font-semibold tabular-nums tracking-tight leading-tight ${a.balance < 0 ? 'text-pay-text' : 'text-ink-900'}`}>
                        {formatMoney(a.balance, a.currency)}
                      </p>
                      <p className="text-[9.5px] text-ink-400 leading-tight mt-0.5">
                        {meta?.flag} {a.currency}
                      </p>
                    </div>
                  </button>
                );
              })}
            </Card3D>
            {accounts.length > 3 && (
              <button
                onClick={() => navigate('/accounts')}
                className="w-full mt-2 text-center text-[11px] font-semibold text-accent-600 py-2 active:opacity-70"
              >
                {t('home_more_tap_manage').replace('{n}', String(accounts.length - 3))}
              </button>
            )}
          </div>
        )}

        {/* Empty-dashboard nudge — accounts exist but no transactions yet.
            Gated on dataReady so we don't flash this between the accounts
            load completing and the transactions load completing. */}
        {dataReady && accountCount > 0 && transactions.length === 0 && (
          // No entries yet: the savings glyph on a violet card.
          <Card3D tint="accent" padding="lg" className="flex flex-col items-center text-center">
            <Icon3D name="piggybank" size="lg" float />
            <p className="text-[14px] font-semibold text-ink-900 tracking-tight mt-2">
              {t("empty_dash_title")}
            </p>
            <p className="text-[12px] text-ink-600 mt-1 max-w-[240px] leading-relaxed">
              {t("empty_dash_desc")}
            </p>
            <div className="mt-4 flex items-center gap-1.5 text-accent-600">
              <span className="text-[11px] font-semibold">
                {t("empty_dash_tap")}
              </span>
              <span className="text-base">&#x2192;</span>
            </div>
          </Card3D>
        )}

        {/* Budget warning — most-overspent category surfaces above the
            settlement nudges so the user sees the money decision first.
            Gated by the attention-banner cap (see shownBannerKeys). */}
        {shownBannerKeys.has("budget") && (
          <BudgetWarningBanner usages={budgetUsages} />
        )}

        {/* Settlement nudges — surface outgoing requests sitting >= 3 days.
            Renders nothing on empty so adjacent sections layout normally. */}
        {shownBannerKeys.has("settlement") && (
          <SettlementNudgeBanner nudges={overdueNudges} />
        )}

        {/* Overflow: when more than two attention signals are live, the rest
            collapse into one calm chip instead of stacking more cards. */}
        {collapsedBanners.length > 0 && (
          <button
            onClick={() => navigate(collapsedReminderHref)}
            className="m-tile m-violet min-h-[44px] px-4 flex items-center gap-2.5 text-left"
          >
            <span className="w-7 h-7 rounded-full bg-cream-card flex items-center justify-center shrink-0 text-ink-900 text-[11px] font-bold tabular-nums">
              {collapsedBanners.length}
            </span>
            <span className="text-[12px] font-semibold text-ink-900">
              {collapsedBanners.length === 1
                ? t('home_more_reminder_one')
                : t('home_more_reminders').replace('{n}', String(collapsedBanners.length))}
            </span>
            <Glyph name="chevron-right" size={15} className="text-ink-600 ms-auto" />
          </button>
        )}

        {/* Recent Transactions */}
        {recentTxns.length > 0 && (
          <div>
            <div className="flex items-center justify-between mb-2.5 px-1">
              <h2 className="text-[10.5px] font-semibold text-ink-500 uppercase tracking-[0.12em]">
                {t("home_recent")}
              </h2>
              <button
                onClick={() => navigate("/transactions")}
                className="text-[11px] text-accent-600 font-semibold active:opacity-70"
              >
                {t("home_see_all")} &#x2192;
              </button>
            </div>
            <Card3D padding="none" className="px-4 divide-y divide-cream-hairline">
              {recentTxns.map((txn) => (
                <TransactionItem key={txn.id} transaction={txn} onClick={() => setSelectedTxn(txn)} />
              ))}
            </Card3D>
          </div>
        )}
      </div>

      <AddAccountStepper
        open={showAddAccount}
        onClose={() => setShowAddAccount(false)}
      />
      <GlobalSearch open={showGlobalSearch} onClose={() => setShowGlobalSearch(false)} />
      <EditTransactionModal
        open={!!selectedTxn}
        transaction={selectedTxn}
        onClose={() => setSelectedTxn(null)}
      />
      <HisaabCheckModal
        open={showCheck}
        onClose={() => setShowCheck(false)}
        currency={meraPrimary?.currency ?? primaryCurrency}
        receivable={meraPrimary?.receivable ?? 0}
        payable={meraPrimary?.payable ?? 0}
        thisWeekRows={thisWeekRows}
        onStamped={(iso) => setCheckStampIso(iso)}
      />
    </main>
  );
}

// The old Careem-style QuickTile lived here. It was the home page's only
// consumer, and the quick-access grid now uses Tile3D (docs/design-system.md
// §10), so the component is gone rather than left dead.
