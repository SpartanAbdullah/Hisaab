import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeftRight } from 'lucide-react';
import {
  startOfDay,
  subDays,
  startOfWeek,
  endOfWeek,
  startOfMonth,
  endOfMonth,
  startOfYear,
  endOfYear,
  subWeeks,
  subMonths,
  subYears,
  isWithinInterval,
  isSameDay,
  format,
} from 'date-fns';
import { useTransactionStore } from '../stores/transactionStore';
import { useAccountStore } from '../stores/accountStore';
import { useLoanStore } from '../stores/loanStore';
import { useGoalStore } from '../stores/goalStore';
import { TransactionItem } from '../components/TransactionItem';
import { EditTransactionModal } from '../components/EditTransactionModal';
import { NavyHero, TopBar } from '../components/NavyHero';
import { Glyph } from '../components/Glyph';
import { MoneyDisplay } from '../components/MoneyDisplay';
import { LanguageToggle } from '../components/LanguageToggle';
import { EmptyState } from '../components/EmptyState';
import { PageErrorState } from '../components/PageErrorState';
import { ListSkeleton } from '../components/ListSkeleton';
import { NextStepHint } from '../components/NextStepHint';
import { useAsyncLoad } from '../hooks/useAsyncLoad';
import { QuickEntry } from './QuickEntry';
import { deferredBlockStyle, estimateGroupHeight } from '../components/VirtualList';
import { DEFAULT_LIST_PAGE_SIZE, nextPageCount, sliceBlocks } from '../lib/listPaging';
import { analyticsDb } from '../lib/supabaseDb';
import { formatMoney } from '../lib/constants';
import { useT } from '../lib/i18n';
import { parseInternalNote } from '../lib/internalNotes';
import { bundleSplitEvents, type LedgerEntry } from '../lib/splitLedger';
import { getPrimaryCurrency } from '../lib/primaryCurrency';
import type { TransactionType, Transaction } from '../db';

type SplitLedgerEntry = Extract<LedgerEntry, { kind: 'split' }>;

// ── The recent window (audit P2 M2 / 03-performance H3) ────────────────────
// The default view is the last 90 days, not the whole history. This is a
// RENDERING window, not a fetch window: the store still holds everything (other
// screens need it), so nothing about search or filtering changes — see
// `windowActive` below, which switches the window OFF the moment any filter or
// search is on, so a search always searches the complete history.
//
// 90 days is chosen to cover the review loop this screen exists for ("what did
// I spend recently", "did that repayment land") while bounding the default
// render on a fresh boot. Anything older is one tap away and the tap says how
// many entries are behind it.
const RECENT_WINDOW_DAYS = 90;

// ── The render page (founder request 2026-09-03) ───────────────────────────
// On top of the 90-day recent window, only the newest ENTRIES_PER_PAGE entries
// are painted on arrival; "Load more" adds another page.
//
// This replaces the IntersectionObserver reveal that used to sit here (M2(d),
// docs/performance.md §6.6.5): that one mounted 8 day groups and quietly
// prepared the next 8 whenever the sentinel came within 800 px, so a scroll
// walked the whole window without the user ever asking for it. A day group is
// also the wrong unit for the promise the footer makes — one group can be one
// row or forty — so the cut is by entry now, and the count under the list is
// the number of lines the user can actually see.
//
// This is a RENDERING page, not a fetch page. Paging the fetch here would be
// wrong twice over: `transactionStore` is shared with HomePage, LoansPage, the
// statement generators and the analytics fallback, and its fetch is already
// bounded (12 months / 1000 rows, docs/performance.md §7.1) with an explicit
// "Show full history" escape. So the rows are local; only the paint is paged.
const ENTRIES_PER_PAGE = DEFAULT_LIST_PAGE_SIZE;

// How many pages the list had grown to, kept for the session across unmounts —
// the same trick, and the same reason, as VirtualList's `blockMemory`:
// `src/App.tsx` (H7 / MF-18) restores `window.scrollY` right after a POP
// navigation commits, and it can only land if the page re-renders at the height
// it left with. A ref or component state would reset to page 1 on every trip to
// a transaction detail sheet and dump the user back at the top.
let rememberedPages = 1;

// One ad-hoc split shown as the single event it was. Collapsed it reads like a
// normal expense line carrying the FULL bill (that is what left the account);
// expanded it shows the payer's own share and each person's receivable, which
// are the rows that actually settle.
function SplitEventRow({
  entry,
  expanded,
  onToggle,
  onSelect,
}: {
  entry: SplitLedgerEntry;
  expanded: boolean;
  onToggle: () => void;
  onSelect: (txn: Transaction) => void;
}) {
  const t = useT();
  return (
    <div className="py-1">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="w-full flex items-center gap-2.5 py-2.5 text-left active:opacity-80 transition-opacity"
      >
        <div className="m-card m-blue w-10 h-10 rounded-[14px] flex items-center justify-center shrink-0 ml-[34px]">
          <Glyph name="split" tone="blue" size={19} />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-[13.5px] font-medium text-ink-900 tracking-tight truncate">
            {entry.label || t('tx_expense')}
          </p>
          <p className="text-[11px] text-ink-500 mt-0.5 truncate">
            {format(new Date(entry.items[0].createdAt), 'MMM d, h:mm a')}
            {' · '}
            {t('split_ways').replace('{n}', String(entry.partyCount))}
          </p>
        </div>
        <p className="text-[14px] font-semibold tabular-nums tracking-tight text-pay-text shrink-0">
          −{formatMoney(entry.total, entry.currency)}
        </p>
        <span className={`inline-flex shrink-0 transition-transform ${expanded ? 'rotate-180' : ''}`}>
          <Glyph name="chevron-down" size={14} className="text-ink-400" />
        </span>
      </button>
      {expanded && (
        <div className="pl-[34px] border-l border-cream-hairline ml-[18px] divide-y divide-cream-hairline">
          {entry.items.map((txn) => (
            <TransactionItem key={txn.id} transaction={txn} onClick={() => onSelect(txn)} />
          ))}
        </div>
      )}
    </div>
  );
}

type TimeFilter =
  | 'all'
  | 'today'
  | 'yesterday'
  | 'this_week'
  | 'last_week'
  | 'this_month'
  | 'last_month'
  | 'this_year'
  | 'last_year';

function filterByTime(txns: Transaction[], timeFilter: TimeFilter): Transaction[] {
  if (timeFilter === 'all') return txns;
  const now = new Date();
  let start: Date;
  let end: Date;

  switch (timeFilter) {
    case 'today':
      start = startOfDay(now);
      end = now;
      break;
    case 'yesterday': {
      const yesterday = subDays(now, 1);
      start = startOfDay(yesterday);
      end = startOfDay(now);
      break;
    }
    case 'this_week':
      start = startOfWeek(now, { weekStartsOn: 1 });
      end = endOfWeek(now, { weekStartsOn: 1 });
      break;
    case 'last_week': {
      const lastWeek = subWeeks(now, 1);
      start = startOfWeek(lastWeek, { weekStartsOn: 1 });
      end = endOfWeek(lastWeek, { weekStartsOn: 1 });
      break;
    }
    case 'this_month':
      start = startOfMonth(now);
      end = endOfMonth(now);
      break;
    case 'last_month': {
      const lastMonth = subMonths(now, 1);
      start = startOfMonth(lastMonth);
      end = endOfMonth(lastMonth);
      break;
    }
    case 'this_year':
      start = startOfYear(now);
      end = endOfYear(now);
      break;
    case 'last_year': {
      const lastYear = subYears(now, 1);
      start = startOfYear(lastYear);
      end = endOfYear(lastYear);
      break;
    }
    default:
      return txns;
  }

  return txns.filter((txn) => isWithinInterval(new Date(txn.createdAt), { start, end }));
}

// Sign convention for the month flow hero:
//   income, loan_taken, opening_balance → positive (money in)
//   expense, loan_given, goal_contribution, repayment-from-account → negative
// Mirrors HomePage's net-worth ring math so the two screens agree.
function classifyForFlow(tx: Transaction): 'in' | 'out' | 'neutral' {
  if (tx.type === 'income' || tx.type === 'loan_taken' || tx.type === 'opening_balance') return 'in';
  if (
    tx.type === 'expense' ||
    tx.type === 'loan_given' ||
    tx.type === 'goal_contribution' ||
    (tx.type === 'repayment' && Boolean(tx.sourceAccountId))
  ) {
    return 'out';
  }
  return 'neutral';
}

export function TransactionsPage() {
  const { transactions, loadTransactions } = useTransactionStore();
  // The bounded-history contract (docs/performance.md §7). `loadTransactions()`
  // now brings back a WINDOW, not the whole table, so this page has to ask for
  // the rest — and it asks at exactly the two moments the user's intent says it
  // must: tapping "Show full history", and turning on any filter or search
  // (whose documented promise is that they run over the complete history).
  const ensureTransactionHistory = useTransactionStore((s) => s.ensureTransactionHistory);
  const historyCoverage = useTransactionStore((s) => s.historyCoverage);
  const historyLoading = useTransactionStore((s) => s.historyLoading);
  const { loadAccounts } = useAccountStore();
  const { loadLoans } = useLoanStore();
  const { loadGoals } = useGoalStore();
  const t = useT();

  const primaryCurrency = getPrimaryCurrency();

  const [showAdd, setShowAdd] = useState(false);
  const [filter, setFilter] = useState<TransactionType | 'all'>('all');
  const [timeFilter, setTimeFilter] = useState<TimeFilter>('all');
  const [search, setSearch] = useState('');
  const [showSearch, setShowSearch] = useState(false);
  const [selectedTransaction, setSelectedTransaction] = useState<Transaction | null>(null);
  const [expandedSplits, setExpandedSplits] = useState<Set<string>>(new Set());
  const toggleSplit = useCallback((splitEventId: string) => {
    setExpandedSplits((prev) => {
      const next = new Set(prev);
      if (next.has(splitEventId)) next.delete(splitEventId);
      else next.add(splitEventId);
      return next;
    });
  }, []);

  const load = useCallback(async () => {
    await Promise.all([loadTransactions(), loadAccounts(), loadLoans(), loadGoals()]);
  }, [loadTransactions, loadAccounts, loadLoans, loadGoals]);
  const { status: loadStatus, error: loadError, retry: retryLoad } = useAsyncLoad(load);

  const typeFilters: { label: string; value: TransactionType | 'all' }[] = [
    { label: t('txpage_all'), value: 'all' },
    { label: t('tx_income'), value: 'income' },
    { label: t('tx_expense'), value: 'expense' },
    { label: t('tx_transfer'), value: 'transfer' },
    { label: t('nav_loans'), value: 'loan_given' },
  ];

  const timeFilterOptions: { label: string; value: TimeFilter }[] = [
    { label: t('time_all'), value: 'all' },
    { label: t('time_today'), value: 'today' },
    { label: t('time_yesterday'), value: 'yesterday' },
    { label: t('time_this_week'), value: 'this_week' },
    { label: t('time_last_week'), value: 'last_week' },
    { label: t('time_this_month'), value: 'this_month' },
    { label: t('time_last_month'), value: 'last_month' },
    { label: t('time_this_year'), value: 'this_year' },
    { label: t('time_last_year'), value: 'last_year' },
  ];

  // This-month totals for the navy hero. Always in primary currency so the
  // headline number is unambiguous; transactions in other currencies still
  // show in the list below.
  const monthFlow = useMemo(() => {
    const now = new Date();
    const monthStart = startOfMonth(now);
    const monthEnd = endOfMonth(now);
    const monthTxns = transactions.filter(
      (tx) =>
        tx.currency === primaryCurrency &&
        isWithinInterval(new Date(tx.createdAt), { start: monthStart, end: monthEnd }),
    );
    let inflow = 0;
    let outflow = 0;
    for (const tx of monthTxns) {
      const kind = classifyForFlow(tx);
      if (kind === 'in') inflow += tx.amount;
      else if (kind === 'out') outflow += tx.amount;
    }
    return { inflow, outflow, net: inflow - outflow };
  }, [transactions, primaryCurrency]);

  const filtered = useMemo(() => {
    let result =
      filter === 'all'
        ? transactions
        : filter === 'loan_given'
        ? transactions.filter(
            (txn) => txn.type === 'loan_given' || txn.type === 'loan_taken' || txn.type === 'repayment',
          )
        : transactions.filter((txn) => txn.type === filter);

    result = filterByTime(result, timeFilter);

    if (search.trim()) {
      const query = search.toLowerCase();
      result = result.filter(
        (txn) =>
          parseInternalNote(txn.notes).visibleNote.toLowerCase().includes(query) ||
          txn.category?.toLowerCase().includes(query) ||
          (txn.relatedPerson ?? '').toLowerCase().includes(query) ||
          txn.amount?.toString().includes(query),
      );
    }

    return result;
  }, [transactions, filter, timeFilter, search]);

  const filtersActive = filter !== 'all' || timeFilter !== 'all' || search.trim().length > 0;

  // ── The recent window ────────────────────────────────────────────────────
  // Active ONLY on the unfiltered default view. Any type filter, any time
  // filter, any search text and the window switches off, so search/filter
  // semantics are byte-identical to before this change: they always run over
  // the complete loaded history.
  const [showFullHistory, setShowFullHistory] = useState(false);
  // "Show full history" is now BOTH a render-window release and a fetch. Before
  // the store was bounded, every row was already local and this was pure
  // rendering; a tap that only lifted the render window would now show the same
  // 12 months back and call it "full history", which is a lie in a finance app.
  const revealFullHistory = useCallback(() => {
    setShowFullHistory(true);
    void ensureTransactionHistory({ all: true }).catch(() => {
      // A failed older-history fetch must not blank the list: the window is
      // still lifted, the rows we DO hold still render, and the honest footer
      // below keeps saying the local copy is short of the server.
    });
  }, [ensureTransactionHistory]);

  // Any filter or search is a request for the whole history — §6.6.5 states
  // outright that "a search always runs over the complete loaded history".
  // With a bounded store that promise has to be paid for, on demand.
  useEffect(() => {
    if (!filtersActive) return;
    if (historyCoverage.complete) return;
    void ensureTransactionHistory({ all: true }).catch(() => {});
  }, [filtersActive, historyCoverage.complete, ensureTransactionHistory]);

  const recentCutoff = useMemo(() => startOfDay(subDays(new Date(), RECENT_WINDOW_DAYS)), []);
  const windowActive = !showFullHistory && !filtersActive;
  const windowed = useMemo(
    () => (windowActive
      ? filtered.filter((txn) => new Date(txn.createdAt) >= recentCutoff)
      : filtered),
    [filtered, windowActive, recentCutoff],
  );
  const hiddenByWindow = filtered.length - windowed.length;

  // ── Truncation honesty (audit H4 / 04-supabase F-FE1) ────────────────────
  // `fetchAllPages` already DETECTS a partial fetch, but it reports it to
  // Sentry only, and the flag's route to this page runs through mirrorCache and
  // transactionStore — files this task does not own. A single `head: true`
  // count (no rows transferred, one request per mount) tells us the same thing
  // from the other end, and catches a short mirror that pagedFetch never saw.
  // Fails silently: a count that does not answer must never block the list.
  const [serverCount, setServerCount] = useState<number | null>(null);
  const countRequested = useRef(false);
  useEffect(() => {
    if (countRequested.current || loadStatus !== 'ready') return;
    countRequested.current = true;
    let cancelled = false;
    void analyticsDb.transactionHistoryCount().then((count) => {
      if (!cancelled && typeof count === 'number') setServerCount(count);
    });
    return () => { cancelled = true; };
  }, [loadStatus]);
  // Optimistic local rows can make the store LARGER than the server count; only
  // the other direction means history is missing from this device.
  const missingLocally =
    serverCount !== null && serverCount > transactions.length
      ? serverCount - transactions.length
      : 0;

  // Day-group the windowed list — Sukoon's per-day section pattern. Each
  // group carries its own signed total so the user can scan a day at a
  // glance without doing the math.
  const dayGroups = useMemo(() => {
    const groups = new Map<string, { date: Date; items: Transaction[]; signedSum: number }>();
    const sorted = [...windowed].sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
    for (const tx of sorted) {
      const day = startOfDay(new Date(tx.createdAt));
      const key = day.toISOString();
      let entry = groups.get(key);
      if (!entry) {
        entry = { date: day, items: [], signedSum: 0 };
        groups.set(key, entry);
      }
      entry.items.push(tx);
      if (tx.currency === primaryCurrency) {
        const kind = classifyForFlow(tx);
        if (kind === 'in') entry.signedSum += tx.amount;
        else if (kind === 'out') entry.signedSum -= tx.amount;
      }
    }
    // Day totals are computed from the raw rows above, THEN the rows are
    // bundled for display — so collapsing a split never changes the day's
    // arithmetic, only how many lines it takes to show it.
    return [...groups.values()].map((g) => ({ ...g, entries: bundleSplitEvents(g.items) }));
  }, [windowed, primaryCurrency]);

  // ── Paged RENDERING on top of the windowed data ──────────────────────────
  // The newest 15 entries paint on arrival; each "Load more" tap adds 15 more.
  // Grows only, and remembers how far it grew across unmounts (see
  // `rememberedPages`) so a trip into a detail sheet and back does not collapse
  // the list under App.tsx's scroll restoration.
  const [pageCount, setPageCount] = useState(rememberedPages);
  useEffect(() => {
    rememberedPages = pageCount;
  }, [pageCount]);
  // A new filter, a new search or lifting the 90-day window is a NEW list, so
  // it starts at page one. Nothing else resets it — in particular a realtime
  // arrival or a resume-refresh does not, so new rows land at the top of a list
  // that is still as deep as the user left it.
  //
  // Adjusted DURING RENDER rather than in an effect, which is React's own
  // "adjusting state when a prop changes" pattern
  // (react.dev/learn/you-might-not-need-an-effect). An effect would be wrong
  // twice here: it fires on MOUNT too, throwing away the remembered depth on
  // every return from a detail sheet — the exact case `rememberedPages` exists
  // to serve — and it would paint one frame of the old page count first.
  const listIdentity = `${filter}|${timeFilter}|${search}|${showFullHistory}`;
  const [lastListIdentity, setLastListIdentity] = useState(listIdentity);
  if (lastListIdentity !== listIdentity) {
    setLastListIdentity(listIdentity);
    setPageCount(1);
  }

  // Day totals are NOT affected by the page: `dayGroups` above already computed
  // each `signedSum` from every row of that day. A day's arithmetic must not
  // change because the user has not tapped "Load more" yet — only the number of
  // visible lines does. The same holds for the month-flow hero, the results
  // count and the "N older entries are hidden" footer, all of which are
  // computed from `transactions`/`filtered`, never from what is painted.
  const page = useMemo(
    () => sliceBlocks(dayGroups.map((g) => g.entries.length), pageCount * ENTRIES_PER_PAGE),
    [dayGroups, pageCount],
  );
  const visibleGroups = page.blocks;
  const loadMoreEntries = useCallback(() => {
    setPageCount((current) => nextPageCount(current, ENTRIES_PER_PAGE, page.total));
  }, [page.total]);

  const today = new Date();
  const yesterday = subDays(today, 1);
  const formatDayLabel = (d: Date) => {
    if (isSameDay(d, today)) return `${t('tx_day_today')} · ${format(d, 'EEE d MMM')}`;
    if (isSameDay(d, yesterday)) return `${t('tx_day_yesterday')} · ${format(d, 'EEE d MMM')}`;
    return format(d, 'EEE d MMM');
  };

  // Keep the search box expanded whenever a filter or search is active, so the
  // active query stays visible and editable instead of collapsing away.
  const searchExpanded = showSearch || filtersActive;

  return (
    <main className="min-h-dvh bg-cream-bg pb-28">
      <NavyHero>
        <TopBar
          title={t('txpage_title')}
          action={
            <div className="flex items-center gap-2">
              <button
                onClick={() => setShowSearch((v) => !v)}
                className="m-ctl relative w-9 h-9 flex items-center justify-center before:absolute before:-inset-1 before:content-['']"
                aria-label={t('a11y_search')}
                aria-pressed={searchExpanded}
              >
                <Glyph name="search" size={15} className="text-white/90" />
              </button>
              <button
                onClick={() => setShowAdd(true)}
                className="m-ctl h-9 px-3 flex items-center gap-1.5 text-[12px] font-semibold text-accent-text"
                aria-label={t('a11y_add')}
              >
                <Glyph name="plus" size={13} strokeWidth={3} /> {t('naya')}
              </button>
              <LanguageToggle />
            </div>
          }
        />

        <div className="px-5 pb-7">
          <p className="text-[10.5px] font-semibold text-white/70 tracking-[0.12em] uppercase">
            {t('tx_this_month')} · {primaryCurrency}
          </p>
          <div className="mt-2 flex items-end justify-between gap-3">
            <MoneyDisplay
              amount={monthFlow.net}
              currency={primaryCurrency}
              size={36}
              tone="on-navy"
              extrude="violet"
            />
            {monthFlow.inflow > 0 && (
              <span className="text-[11px] font-semibold px-2.5 py-1 rounded-full tabular-nums shrink-0 bg-white/10 text-receive-text">
                +{formatMoney(monthFlow.inflow, primaryCurrency)} {t('tx_flow_in')}
              </span>
            )}
          </div>
          <p className="text-[11.5px] text-white/70 mt-2.5 tabular-nums">
            {monthFlow.outflow > 0
              ? `−${formatMoney(monthFlow.outflow, primaryCurrency)} ${t('tx_flow_out')}`
              : t('tx_no_outflow_yet')}
          </p>
        </div>
      </NavyHero>

      <div className="sukoon-body min-h-[60dvh] px-5 pt-5 space-y-3">
        {searchExpanded && (
          <div>
            <div className="relative">
              <Glyph name="search" size={15} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-400 pointer-events-none" />
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder={t('tx_search_placeholder')}
                className="input-field pl-10 pr-11"
                autoFocus={showSearch}
              />
              {search && (
                <button
                  onClick={() => setSearch('')}
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 text-ink-500 w-10 h-10 flex items-center justify-center press-xs"
                  aria-label={t('a11y_clear_search')}
                >
                  <Glyph name="close" size={14} />
                </button>
              )}
            </div>
            {/* Results count sits directly under the search box for a tight
                search → result-count reading order. */}
            {filtersActive && (
              <p className="text-[10.5px] text-ink-500 font-semibold mt-1.5 px-1">
                {filtered.length} {t('time_results')}
              </p>
            )}
          </div>
        )}

        {/* Type filter — raised pills; the light-faced one is active. */}
        <div className="flex gap-2 overflow-x-auto no-scrollbar -mx-1 px-1 pb-1">
          {typeFilters.map((item) => (
            <button
              key={item.value}
              type="button"
              onClick={() => setFilter(item.value)}
              aria-pressed={filter === item.value}
              className="m-pill shrink-0"
            >
              {item.label}
            </button>
          ))}
        </div>

        {/* Time filter — the quieter, secondary control: one recessed track. */}
        <div className="overflow-x-auto no-scrollbar -mx-1 px-1">
          <div className="m-seg">
            {timeFilterOptions.map((item) => (
              <button
                key={item.value}
                type="button"
                onClick={() => setTimeFilter(item.value)}
                aria-pressed={timeFilter === item.value}
                className="shrink-0 whitespace-nowrap"
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>

        {loadStatus === 'ready' && transactions.length > 0 && (
          <NextStepHint
            icon={ArrowLeftRight}
            tone={filtersActive ? 'info' : monthFlow.net >= 0 ? 'receive' : 'pay'}
            status={
              filtersActive
                ? filtered.length === 1
                  ? t('tx_hint_filtered_one')
                  : t('tx_hint_filtered_many').replace('{n}', String(filtered.length))
                : monthFlow.net >= 0
                ? t('tx_hint_month_up').replace('{amount}', formatMoney(monthFlow.net, primaryCurrency))
                : t('tx_hint_month_down').replace('{amount}', formatMoney(Math.abs(monthFlow.net), primaryCurrency))
            }
            next={
              filtersActive
                ? t('tx_hint_next_filtered')
                : monthFlow.outflow > monthFlow.inflow
                ? t('tx_hint_next_overspend')
                : t('tx_hint_next_keep_logging')
            }
            actionLabel={filtersActive ? t('tx_clear_filters') : t('tx_add_transaction')}
            onAction={
              filtersActive
                ? () => {
                    setFilter('all');
                    setTimeFilter('all');
                    setSearch('');
                  }
                : () => setShowAdd(true)
            }
          />
        )}

        {loadStatus === 'error' && (
          <PageErrorState
            variant="inline"
            title={t('tx_err_load')}
            message={loadError ?? t('err_some_data_failed')}
            onRetry={retryLoad}
          />
        )}

        {/* Day-grouped list — never show the empty-state until the first
            load resolves, otherwise users see "no transactions" flash before
            their real history arrives. */}
        {loadStatus === 'loading' && transactions.length === 0 ? (
          <ListSkeleton rows={4} />
        ) : windowed.length === 0 && filtered.length > 0 ? (
          // Everything the filters matched is older than the recent window —
          // never show "no transactions" when there ARE transactions.
          <div className="m-card p-4 text-center space-y-3">
            <p className="text-[12px] text-ink-600 leading-relaxed">
              {t('tx_window_recent').replace('{d}', String(RECENT_WINDOW_DAYS))}
              {' · '}
              {t('tx_window_older').replace('{n}', String(hiddenByWindow))}
            </p>
            <button
              onClick={revealFullHistory}
              disabled={historyLoading}
              className="m-btn m-btn-plain px-4 py-2.5 text-[12px]"
            >
              <Glyph name="clock" size={14} />
              {historyLoading ? t('tx_history_loading') : t('tx_load_older')}
            </button>
          </div>
        ) : filtered.length === 0 ? (
          loadStatus === 'ready' ? (
            <EmptyState
              icon={ArrowLeftRight}
              clayIcon="swap"
              tone="violet"
              title={t('empty_tx_title')}
              description={t('empty_tx_desc')}
              subhint={t('empty_tx_subhint')}
              actionLabel={t('empty_tx_cta')}
              onAction={() => setShowAdd(true)}
            />
          ) : null
        ) : (
          // Stagger by DAY GROUP, not by individual transaction. Grouped
          // rows already read as one block, and delaying 40 rows would
          // outlast the user's patience — a long history should feel fast.
          // Re-keying on the filters means switching filter re-plays the
          // reveal, which is the correct signal that the list changed.
          // Deliberately NOT keyed on `search` — re-animating on every
          // keystroke would make typing feel like the page was thrashing.
          <div className="space-y-4 stagger-in" key={`${filter}-${timeFilter}`}>
            {dayGroups.slice(0, visibleGroups).map((group, groupIndex) => {
              // The page can cut mid-day. The header's total still covers the
              // WHOLE day (see the note above `page`); only the rows below it
              // are trimmed, and the footer says how many of how many are shown.
              const entries =
                groupIndex === visibleGroups - 1
                  ? group.entries.slice(0, page.lastBlockEntries)
                  : group.entries;
              return (
              // One day group = one deferred block. Off-screen blocks skip
              // layout and paint entirely (content-visibility), and groups past
              // the current page are not mounted at all.
              <div
                key={group.date.toISOString()}
                style={deferredBlockStyle(estimateGroupHeight(entries.length))}
              >
                <div className="flex items-baseline justify-between px-1 mb-2">
                  <p className="text-[10.5px] font-semibold text-ink-500 uppercase tracking-[0.12em]">
                    {formatDayLabel(group.date)}
                  </p>
                  {group.signedSum !== 0 && (
                    <p
                      className={`text-[11.5px] font-semibold tabular-nums ${
                        group.signedSum > 0 ? 'text-receive-text' : 'text-pay-text'
                      }`}
                    >
                      {group.signedSum > 0 ? '+' : '−'}
                      {formatMoney(Math.abs(group.signedSum), primaryCurrency)}
                    </p>
                  )}
                </div>
                <div className="m-card px-4 divide-y divide-cream-hairline">
                  {entries.map((entry) =>
                    entry.kind === 'txn' ? (
                      <TransactionItem
                        key={entry.key}
                        transaction={entry.txn}
                        onClick={() => setSelectedTransaction(entry.txn)}
                      />
                    ) : (
                      <SplitEventRow
                        key={entry.key}
                        entry={entry}
                        expanded={expandedSplits.has(entry.splitEventId)}
                        onToggle={() => toggleSplit(entry.splitEventId)}
                        onSelect={setSelectedTransaction}
                      />
                    ),
                  )}
                </div>
              </div>
              );
            })}

            {/* "Showing N of M" over the list the filters produced — M is every
                entry that matched, not a guess, and it is the same number the
                results count above reports. One tap adds another 15. */}
            {page.hasMore && (
              <div className="space-y-2 pt-1">
                <p className="text-[10.5px] text-ink-500 px-1 tabular-nums">
                  {t('list_showing_n_of_m')
                    .replace('{n}', String(page.rendered))
                    .replace('{m}', String(page.total))}
                </p>
                <button
                  type="button"
                  onClick={loadMoreEntries}
                  className="m-btn m-btn-plain w-full text-[12.5px]"
                >
                  {t('list_load_more')}
                </button>
              </div>
            )}
          </div>
        )}

        {/* ── The honest footer ──────────────────────────────────────────────
            Two DIFFERENT truths, deliberately worded apart:
              · the recent window is OUR choice and is undoable in one tap;
              · a short local mirror is a FACT about this device's data and is
                not something a button can undo. Never conflate them. */}
        {/* The affordance can no longer be keyed off `hiddenByWindow` alone.
            The store is bounded now, so a user whose loaded window is entirely
            inside 90 days hides NOTHING locally while years still sit on the
            server — and the one tap that would fetch them would have vanished.
            Incomplete coverage keeps the button on screen, with copy that says
            which of the two truths applies. */}
        {windowActive && (hiddenByWindow > 0 || !historyCoverage.complete) && (
          <div className="m-inset px-4 py-3 flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-[11.5px] font-semibold text-ink-600">
                {t('tx_window_recent').replace('{d}', String(RECENT_WINDOW_DAYS))}
              </p>
              <p className="text-[11px] text-ink-500 mt-0.5">
                {hiddenByWindow > 0
                  ? t('tx_window_older').replace('{n}', String(hiddenByWindow))
                  : t('tx_window_server')}
              </p>
            </div>
            <button
              onClick={revealFullHistory}
              disabled={historyLoading}
              className="m-btn m-btn-plain shrink-0 px-3 py-2 text-[11.5px] gap-1.5"
            >
              <Glyph name="clock" size={13} />
              {historyLoading ? t('tx_history_loading') : t('tx_load_older')}
            </button>
          </div>
        )}

        {missingLocally > 0 && (
          <p className="text-[10.5px] text-ink-500 px-1 leading-snug">
            {t('tx_history_partial')
              .replace('{n}', String(transactions.length))
              .replace('{m}', String(serverCount ?? transactions.length))}
          </p>
        )}

      </div>

      <QuickEntry open={showAdd} onClose={() => setShowAdd(false)} />
      <EditTransactionModal
        open={!!selectedTransaction}
        transaction={selectedTransaction}
        onClose={() => setSelectedTransaction(null)}
      />
    </main>
  );
}
