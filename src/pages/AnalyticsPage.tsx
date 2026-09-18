import { useCallback, useEffect, useRef, useState, useMemo, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { TrendingUp } from 'lucide-react';
import { useTransactionStore } from '../stores/transactionStore';
import { useSplitStore } from '../stores/splitStore';
import { NavyHero, TopBar } from '../components/NavyHero';
import { LanguageToggle } from '../components/LanguageToggle';
import { EmptyState } from '../components/EmptyState';
import { Glyph } from '../components/Glyph';
import { PageErrorState } from '../components/PageErrorState';
import { skeletonDelay } from '../lib/material';
import { useAsyncLoad } from '../hooks/useAsyncLoad';
import { useT } from '../lib/i18n';
import { formatMoney } from '../lib/constants';
import { getPrimaryCurrency } from '../lib/primaryCurrency';
import {
  dailySpending,
  dailySpendingFromSeries,
  endOfMonthExact,
  groupByCategory,
  groupByCategoryFromSummary,
  monthlyTrend,
  monthlyTrendFromSummary,
  sumByCurrency,
  sumByCurrencyFromSummary,
  summaryCurrencies,
  topExpenses,
  topExpensesFromRows,
  toTopExpenseRow,
  totalFromSummary,
  type DailySeriesRow,
  type MonthlySummaryRow,
  type TopExpenseRow,
} from '../lib/analytics';
import { analyticsDb } from '../lib/supabaseDb';
import { reportError } from '../lib/errorReporter';
import { parseInternalNote } from '../lib/internalNotes';
import type { Currency, Transaction } from '../db';

// Audit P2 M2 / 03-performance H3: this page used to sum the user's ENTIRE
// transaction history in the browser, on every render pass.
//
// M2(c) moved the summary cards, the currency chips and the category pie into
// `analytics_monthly_summary`. M2(d) — this pass — adds
// `analytics_daily_series` and `analytics_top_expenses`
// (supabase-migration-p2-analytics-aggregates-2.sql) and, because the monthly
// trend's bucket-end bug is now fixed in TypeScript (`endOfMonthExact`), serves
// the trend and the spend-trend card from the SAME monthly-summary RPC over
// their own windows. With all of it answering, this page NO LONGER CALLS
// `loadTransactions()` at all — the unbounded full-history fetch is gone from
// the Analytics surface.
//
// OFF by default, and off means OFF: with the flag unset nothing here calls a
// single RPC, the page loads transactions exactly as it always did, and every
// figure comes from exactly the same expression as before.
//
// FAILS SOFT: if ANY of the five calls errors (unapplied migration → PGRST202,
// offline, timeout), the failure is reported and the page falls back to
// `loadTransactions()` + the client aggregation. A finance app must never
// answer "how much did I spend" with a blank card because a request failed.
const ANALYTICS_RPC_ENABLED = import.meta.env.VITE_ANALYTICS_RPC === 'true';

type Period = 'this_month' | 'last_month' | '3months' | 'year';

/** The top-expenses list length. One constant, both paths (and the RPC's p_limit). */
const TOP_EXPENSE_LIMIT = 5;

// `now` is passed in rather than read inside, so the period window, the
// previous window and the trend buckets are all cut from ONE instant. Two
// `new Date()` calls a millisecond apart across a midnight boundary would
// otherwise put the cards and the chart in different months.
function getDateRange(period: Period, now: Date): [Date, Date] {
  switch (period) {
    case 'this_month': return [new Date(now.getFullYear(), now.getMonth(), 1), now];
    // endOfMonthExact, not `new Date(y, m, 0, 23, 59, 59)`: the old form
    // dropped the last 999 ms of the month — see src/lib/analytics.ts.
    case 'last_month': return [new Date(now.getFullYear(), now.getMonth() - 1, 1), endOfMonthExact(now.getFullYear(), now.getMonth() - 1)];
    case '3months': return [new Date(now.getFullYear(), now.getMonth() - 2, 1), now];
    case 'year': return [new Date(now.getFullYear(), 0, 1), now];
  }
}

/** How many month buckets the trend chart shows for a period. */
function trendMonthsFor(period: Period): number {
  return period === 'year' ? 12 : period === '3months' ? 3 : 2;
}

/** The window covering every bucket `monthlyTrend` will walk, whole months. */
function trendRange(period: Period, now: Date): [Date, Date] {
  const months = trendMonthsFor(period);
  return [
    new Date(now.getFullYear(), now.getMonth() - (months - 1), 1),
    endOfMonthExact(now.getFullYear(), now.getMonth()),
  ];
}

function inRange(tx: Transaction, start: Date, end: Date) {
  const date = new Date(tx.createdAt);
  return date >= start && date <= end;
}

// The comparable window immediately before the selected period — used for the
// "vs previous period" spend trend. Every end is `endOfMonthExact` now: the old
// `…, 0, 23, 59, 59` form silently excluded anything stamped in the final
// 999 ms of the month from BOTH the period and its comparison.
function previousRange(period: Period, now: Date): [Date, Date] {
  switch (period) {
    case 'this_month': return [new Date(now.getFullYear(), now.getMonth() - 1, 1), endOfMonthExact(now.getFullYear(), now.getMonth() - 1)];
    case 'last_month': return [new Date(now.getFullYear(), now.getMonth() - 2, 1), endOfMonthExact(now.getFullYear(), now.getMonth() - 2)];
    case '3months': return [new Date(now.getFullYear(), now.getMonth() - 5, 1), endOfMonthExact(now.getFullYear(), now.getMonth() - 3)];
    case 'year': return [new Date(now.getFullYear() - 1, 0, 1), endOfMonthExact(now.getFullYear() - 1, 11)];
  }
}

// `sumByCurrency` used to live here; it moved verbatim into src/lib/analytics.ts
// so the RPC path (`sumByCurrencyFromSummary`) has something a unit test can be
// proven equal to. Behaviour is unchanged — same filter, same sort.

// The handoff's tinted stat card: coral "Total spent", mint "Total income".
// The first currency is the 21px card figure; any further currencies sit
// under it at 13px in secondary ink — per-currency, never summed across.
function StatCard({
  label,
  totals,
  tone,
  emptyCurrency,
}: {
  label: string;
  totals: { currency: Currency; amount: number }[];
  tone: 'expense' | 'income';
  /** Shown as "AED 0.00" when the period has no entries of this kind. */
  emptyCurrency: Currency;
}) {
  const [first, ...rest] = totals;
  return (
    <div className={`m-card ${tone === 'expense' ? 'm-coral' : 'm-mint'} rounded-[16px] p-3.5 min-w-0`}>
      <p
        className={`text-[10px] font-semibold uppercase tracking-[0.12em] ${
          tone === 'expense' ? 'text-pay-text' : 'text-receive-text'
        }`}
      >
        {label}
      </p>
      <p className="mt-2 text-[21px] font-semibold tracking-[-0.03em] leading-tight tabular-nums text-ink-900 truncate">
        {formatMoney(first ? first.amount : 0, first ? first.currency : emptyCurrency)}
      </p>
      {rest.map(({ currency, amount }) => (
        <p key={currency} className="mt-0.5 text-[13px] font-semibold tabular-nums text-ink-600 truncate">
          {formatMoney(amount, currency)}
        </p>
      ))}
    </div>
  );
}

// ── Charts ─────────────────────────────────────────────────────────────────
// Hand-built instead of recharts so the marks can wear the 1d material. Every
// colour is a theme token read through var(), so both themes come for free.

// Category ring, largest slice first. The order was chosen with the dataviz
// validator over the design-system glyph tokens so no two touching slices
// collapse under colour-blindness — including the wrap-around pair, since
// the last slice meets the first on a ring (CVD ΔE 10.4 / normal ΔE 20 in
// both themes). Categories past the fifth fold into one neutral, labelled
// slice rather than cycling colours nobody can tell apart.
const DONUT_TONES = [
  'var(--color-glyph-violet)',
  'var(--color-glyph-violet)',
  'var(--color-glyph-pink)',
  'var(--color-glyph-blue)',
  'var(--color-glyph-coral)',
] as const;
const DONUT_REST_TONE = 'var(--color-ink-400)';
const DONUT_SLOTS = DONUT_TONES.length;

type BarTone = 'violet' | 'green';
// Extruded bar faces: a lit gradient in the series' own hue and a hard wall
// in a darker shade of it (color-mix keeps the wall on-hue in both themes).
const BAR_TONES: Record<BarTone, { face: string; wall: string; swatch: string }> = {
  violet: {
    face: 'linear-gradient(var(--color-iris-500), var(--color-iris-600))',
    wall: 'color-mix(in srgb, var(--color-iris-600) 55%, black)',
    swatch: 'var(--color-iris-500)',
  },
  green: {
    face: 'linear-gradient(var(--color-receive-600), var(--color-receive-700))',
    wall: 'color-mix(in srgb, var(--color-receive-700) 55%, black)',
    swatch: 'var(--color-receive-600)',
  },
};

function CategoryDonut({
  categories,
  currency,
  onOpen,
}: {
  categories: { category: string; amount: number; percentage: number }[];
  currency: string;
  onOpen: (category: string) => void;
}) {
  const t = useT();
  const top = categories.slice(0, DONUT_SLOTS);
  const rest = categories.slice(DONUT_SLOTS);
  const restAmount = rest.reduce((s, c) => s + c.amount, 0);
  const total = categories.reduce((s, c) => s + c.amount, 0);

  const slices = [
    ...top.map((c, i) => ({ key: c.category, amount: c.amount, color: DONUT_TONES[i] })),
    ...(restAmount > 0 ? [{ key: '__rest', amount: restAmount, color: DONUT_REST_TONE }] : []),
  ];

  // conic-gradient stops, clockwise from 12 o'clock. A 2° cut of card
  // surface (transparent) separates neighbours — the secondary encoding that
  // keeps touching slices apart without relying on hue alone.
  let acc = 0;
  const stops: string[] = [];
  for (const s of slices) {
    const start = total > 0 ? (acc / total) * 360 : 0;
    acc += s.amount;
    const end = total > 0 ? (acc / total) * 360 : 0;
    const gap = slices.length > 1 ? Math.min(2, (end - start) * 0.3) : 0;
    stops.push(`${s.color} ${start.toFixed(2)}deg ${(end - gap).toFixed(2)}deg`);
    if (gap > 0) stops.push(`transparent ${(end - gap).toFixed(2)}deg ${end.toFixed(2)}deg`);
  }
  const ring: CSSProperties = {
    backgroundImage: `conic-gradient(${stops.join(', ')})`,
    boxShadow: '0 12px 24px -12px var(--m-shadow)',
  };

  const totalText = Math.round(total).toLocaleString('en-US');
  // The centre disc is 60px across; long figures step down instead of
  // abbreviating — a finance app shows the real number.
  const totalSize = totalText.length > 10 ? 8.5 : totalText.length > 8 ? 9.5 : totalText.length > 6 ? 11 : 12.5;
  const restPct = total > 0 ? Math.round((restAmount / total) * 100) : 0;

  return (
    <div className="flex items-center gap-[18px]">
      <div
        className="relative w-[112px] h-[112px] rounded-full shrink-0"
        style={ring}
        role="img"
        aria-label={`${t('label_total')} ${formatMoney(total, currency)}`}
      >
        <span className="m-inset absolute inset-[26px] rounded-full flex items-center justify-center">
          <span
            className="font-semibold text-ink-900 tabular-nums tracking-[-0.02em]"
            style={{ fontSize: totalSize }}
          >
            {totalText}
          </span>
        </span>
      </div>
      <div className="flex-1 min-w-0">
        {top.map((c, i) => (
          <button
            key={c.category}
            type="button"
            onClick={() => onOpen(c.category)}
            className="w-full flex items-center gap-2 min-h-[44px] text-left rounded-lg active:bg-cream-soft transition-colors"
          >
            <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: DONUT_TONES[i] }} />
            <span className="text-[11.5px] text-ink-600 truncate flex-1">{c.category}</span>
            <span className="text-[11.5px] font-semibold text-ink-900 tabular-nums">{c.percentage}%</span>
            <Glyph name="chevron-right" size={12} className="text-ink-400" />
          </button>
        ))}
        {rest.length > 0 && (
          <div className="flex items-center gap-2 min-h-[36px]">
            <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: DONUT_REST_TONE }} />
            <span className="text-[11.5px] text-ink-500 truncate flex-1">
              {t('wom_more_sources').replace('{n}', String(rest.length))}
            </span>
            <span className="text-[11.5px] font-semibold text-ink-900 tabular-nums me-[20px]">{restPct}%</span>
          </div>
        )}
      </div>
    </div>
  );
}

interface BarSeries {
  label: string;
  tone: BarTone;
}
interface BarDatum {
  /** Axis label under the column. */
  label: string;
  /** Readout name for the column (defaults to `label`). */
  name?: string;
  /** One value per series, same order as `series`. */
  values: number[];
}

// Extruded bar chart — the handoff's trend bars: lit face, top + left
// highlight, shaded right side, hard bottom wall. Replaces the recharts
// tooltip with a readout line: the selected column (the latest one until
// the user taps, drags across, hovers, or arrows to another) is marked by a
// recessed violet band and its values are spelled out above the plot.
function ExtrudedBars({
  series,
  data,
  currency,
  dense = false,
  showLabel,
}: {
  series: BarSeries[];
  data: BarDatum[];
  currency: string;
  /** Thin columns (daily): tighter radii, no side highlight. */
  dense?: boolean;
  /** Which axis labels to print (every one by default). */
  showLabel?: (index: number) => boolean;
}) {
  const [picked, setPicked] = useState<number | null>(null);
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const last = data.length - 1;
  const selected = Math.min(picked ?? last, last);
  const max = Math.max(0, ...data.flatMap((d) => d.values));
  const PLOT = 104;

  // Hover (mouse), press and drag (touch) all move the selection — the
  // column under the pointer is the one the readout describes.
  const pickFromPointer = (e: PointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    if (rect.width <= 0) return;
    const i = Math.floor(((e.clientX - rect.left) / rect.width) * data.length);
    setPicked(Math.max(0, Math.min(last, i)));
  };
  const onKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const next = e.key === 'ArrowRight' ? i + 1 : e.key === 'ArrowLeft' ? i - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? last : null;
    if (next === null) return;
    e.preventDefault();
    const clamped = Math.max(0, Math.min(last, next));
    setPicked(clamped);
    buttons.current[clamped]?.focus();
  };

  const current = data[selected];
  const describe = (d: BarDatum) =>
    `${d.name ?? d.label}: ${series.map((s, k) => `${s.label} ${formatMoney(d.values[k] ?? 0, currency)}`).join(', ')}`;

  return (
    <div>
      {current && (
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] mb-3 min-h-[18px]" aria-live="polite">
          <span className="font-semibold text-ink-900">{current.name ?? current.label}</span>
          {series.map((s, k) => (
            <span key={s.label} className="inline-flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-[3px]" style={{ backgroundColor: BAR_TONES[s.tone].swatch }} aria-hidden />
              <span className="text-ink-500">{s.label}</span>
              <span className="font-semibold text-ink-900 tabular-nums">{formatMoney(current.values[k] ?? 0, currency)}</span>
            </span>
          ))}
        </p>
      )}
      <div
        className={`relative flex items-end ${dense ? 'gap-[2px]' : 'gap-2'}`}
        style={{ height: PLOT }}
        onPointerDown={pickFromPointer}
        onPointerMove={pickFromPointer}
      >
        <span className="absolute inset-x-0 bottom-0 h-px bg-cream-hairline" aria-hidden />
        {data.map((d, i) => {
          const isSelected = i === selected;
          return (
            <button
              key={`${d.label}-${i}`}
              ref={(el) => { buttons.current[i] = el; }}
              type="button"
              tabIndex={isSelected ? 0 : -1}
              aria-pressed={isSelected}
              aria-label={describe(d)}
              onClick={() => setPicked(i)}
              onKeyDown={(e) => onKey(e, i)}
              className="relative flex-1 min-w-0 h-full flex items-end justify-center gap-[3px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 rounded-[10px]"
            >
              {isSelected && (
                <span
                  className={`absolute -top-1 bottom-0 bg-accent-50 shadow-[inset_0_2px_5px_var(--m-inset-shade)] ${
                    dense ? 'inset-x-0 rounded-[5px]' : 'left-1/2 -translate-x-1/2 w-full max-w-[68px] rounded-[10px]'
                  }`}
                  aria-hidden
                />
              )}
              {series.map((s, k) => {
                const v = d.values[k] ?? 0;
                const h = max > 0 && v > 0 ? Math.max(3, Math.round((v / max) * (PLOT - 10))) : 0;
                const tone = BAR_TONES[s.tone];
                return (
                  <span
                    key={s.label}
                    aria-hidden
                    className={`relative ${dense ? 'flex-1' : 'flex-1 max-w-[26px]'}`}
                    style={{
                      height: h,
                      backgroundImage: tone.face,
                      borderRadius: dense ? '3px 3px 1px 1px' : '7px 7px 3px 3px',
                      boxShadow: dense
                        ? `inset 0 1px 0 rgba(255, 255, 255, 0.35), 0 2px 0 ${tone.wall}`
                        : `inset 0 2px 0 rgba(255, 255, 255, 0.4), inset 2px 0 0 rgba(255, 255, 255, 0.16), inset -3px 0 0 rgba(0, 0, 0, 0.22), 0 2px 0 ${tone.wall}`,
                    }}
                  />
                );
              })}
            </button>
          );
        })}
      </div>
      {/* Axis labels. Not truncated: a short month name may spill a pixel
          into the gap on a 360px phone, which beats "S…". Thin (daily)
          columns print only every fifth day; the readout names the rest. */}
      <div className={`flex mt-2 ${dense ? 'gap-[2px]' : 'gap-2'}`} aria-hidden>
        {data.map((d, i) => (
          <span
            key={`${d.label}-${i}`}
            className={`flex-1 min-w-0 flex justify-center text-[9.5px] tabular-nums whitespace-nowrap ${
              i === selected ? 'font-semibold text-accent-text' : 'font-medium text-ink-500'
            }`}
          >
            {!showLabel || showLabel(i) ? d.label : ''}
          </span>
        ))}
      </div>
    </div>
  );
}

// Takes the raw note rather than a Transaction, because the top-expenses list
// is now fed by `TopExpenseRow` (six columns) on the RPC path and by a narrowed
// Transaction on the client path — one renderer, one shape.
function getTransactionSubtitle(notes: string) {
  const parsedNote = parseInternalNote(notes);
  return parsedNote.visibleNote || parsedNote.meta.expenseDescription || '';
}

export function AnalyticsPage() {
  const t = useT();
  const navigate = useNavigate();
  const { transactions, loadTransactions } = useTransactionStore();
  // The client-side fallback aggregation is a "must be complete" consumer —
  // see loadEverything below (docs/performance.md §7).
  const ensureTransactionHistory = useTransactionStore((s) => s.ensureTransactionHistory);
  const { loadGroups } = useSplitStore();
  // The selected period AND the instant it was selected at, as ONE state value.
  // Every window on the screen — the period, its previous comparable window and
  // the trend buckets — is cut from that single instant, so the cards and the
  // charts can never disagree about which month it is (a page left open across
  // midnight used to be able to do exactly that).
  const [{ period, now }, setPeriodState] = useState<{ period: Period; now: Date }>(
    () => ({ period: 'this_month', now: new Date() }),
  );
  const setPeriod = useCallback(
    (next: Period) => setPeriodState({ period: next, now: new Date() }),
    [],
  );
  const [selectedCurrency, setSelectedCurrency] = useState<Currency | null>(null);

  // Audit UX-09: Analytics was the sole core page still firing a
  // fire-and-forget effect. It had no error state (a failed fetch was
  // indistinguishable from "you have no spending data" — a lie in a finance
  // app) and it rendered the empty state on the very first frame, before the
  // store's Supabase fetch had returned. Same useAsyncLoad + skeleton +
  // PageErrorState contract as HomePage/TransactionsPage/AccountsPage.
  // ── SQL-side analytics (audit P2 M2) ─────────────────────────────────────
  // `rpcFailed` is the fallback latch: once ANY of the five calls errors, this
  // page behaves exactly as it did before M2 — it loads the full history and
  // aggregates in the browser. `loadEverything`'s identity changes with it, so
  // useAsyncLoad re-runs and actually fetches the rows the fallback needs.
  const [rpcFailed, setRpcFailed] = useState(false);
  const needsClientRows = !ANALYTICS_RPC_ENABLED || rpcFailed;

  const loadEverything = useCallback(async () => {
    // Groups are loaded in both modes; the transaction rows only when the
    // client aggregation is the one that will run.
    //
    // When it does run it must run on the COMPLETE history, not the store's
    // default 12-month window: the period selector offers "this year" and "all
    // time", and `monthlyTrend` walks six months back regardless of the
    // selected period. A windowed store would render those as smaller numbers
    // with no visible difference from real ones — the single worst failure mode
    // a finance app has. `ensureTransactionHistory` is a no-op once coverage is
    // complete, so this costs one walk per session, not one per period tap.
    await Promise.all([
      // `loadTransactions` first so the warm Dexie mirror still serves the
      // rows; `ensureTransactionHistory` then resolves without a request
      // whenever that load already proved completeness (every user under the
      // 1000-row floor), and pages the rest in when it did not.
      needsClientRows
        ? loadTransactions().then(() => ensureTransactionHistory({ all: true }))
        : Promise.resolve(),
      loadGroups(),
    ]);
  }, [needsClientRows, loadTransactions, ensureTransactionHistory, loadGroups]);
  const { status: loadStatus, error: loadError, retry: retryLoad } = useAsyncLoad(loadEverything);

  const [start, end] = useMemo(() => getDateRange(period, now), [period, now]);

  // The rows the RPC path holds. Null in four cases, each of which falls
  // straight back to the client aggregation below: the flag is off, the calls
  // have not resolved yet, they failed, or the period changed and the answer we
  // hold belongs to the previous window. The window travels WITH the rows, so a
  // period switch invalidates them by comparison rather than by an extra
  // synchronous setState inside the effect (react-hooks/set-state-in-effect).
  const windowKey = `${start.getTime()}:${end.getTime()}`;
  const [rpcResult, setRpcResult] = useState<{
    key: string;
    /** The selected period — cards, chips, pie. */
    summary: MonthlySummaryRow[];
    /** The trend's own window (whole months back from now). */
    trend: MonthlySummaryRow[];
    /** The comparable previous window — the spend-trend card. */
    previous: MonthlySummaryRow[];
    daily: DailySeriesRow[];
    top: TopExpenseRow[];
  } | null>(null);

  useEffect(() => {
    if (!ANALYTICS_RPC_ENABLED || rpcFailed) return;
    let cancelled = false;
    const [trendStart, trendEnd] = trendRange(period, now);
    const [prevStart, prevEnd] = previousRange(period, now);
    // Five aggregate calls in parallel, each returning tens of rows, replacing
    // a paged walk of the entire transactions table.
    Promise.all([
      analyticsDb.monthlySummary(start, end),
      analyticsDb.monthlySummary(trendStart, trendEnd),
      analyticsDb.monthlySummary(prevStart, prevEnd),
      analyticsDb.dailySeries(start, end),
      analyticsDb.topExpenses(start, end, TOP_EXPENSE_LIMIT),
    ])
      .then(([summary, trend, previous, daily, top]) => {
        if (!cancelled) setRpcResult({ key: windowKey, summary, trend, previous, daily, top });
      })
      .catch((err) => {
        if (cancelled) return;
        reportError(err, { feature: 'AnalyticsPage.analyticsRpcs' });
        // Latch the fallback: re-running the RPCs on every period change when
        // the migration simply is not applied would be five failed requests a
        // tap. One failure, one fallback, for the life of the screen.
        setRpcFailed(true);
        setRpcResult(null);
      });
    return () => { cancelled = true; };
  }, [start, end, windowKey, period, now, rpcFailed]);

  const rpc = rpcResult?.key === windowKey ? rpcResult : null;
  const rpcRows = rpc?.summary ?? null;
  // On the RPC path the skeleton is owned by the RPC's own in-flight state —
  // `transactions` is deliberately empty and never arrives.
  const isInitialLoading = needsClientRows
    ? loadStatus === 'loading' && transactions.length === 0
    : rpc === null && loadStatus !== 'error';

  const periodTransactions = useMemo(
    () => transactions.filter(tx => inRange(tx, start, end)),
    [transactions, start, end],
  );
  const currencies = useMemo(() => {
    if (rpcRows) return summaryCurrencies(rpcRows);
    const activeCurrencies = new Set<Currency>();
    periodTransactions
      .filter(tx => tx.type === 'expense' || tx.type === 'income')
      .forEach(tx => activeCurrencies.add(tx.currency));
    return Array.from(activeCurrencies).sort();
  }, [periodTransactions, rpcRows]);
  // UX-34: was the PKR-fallback outlier while ~19 other screens fell back to
  // AED. One helper, one fallback — see src/lib/primaryCurrency.ts.
  const primaryCurrency = getPrimaryCurrency();
  const chartCurrency = selectedCurrency && currencies.includes(selectedCurrency)
    ? selectedCurrency
    : currencies.includes(primaryCurrency)
      ? primaryCurrency
      : currencies[0] ?? primaryCurrency;
  const chartTransactions = useMemo(
    () => transactions.filter(tx => tx.currency === chartCurrency),
    [transactions, chartCurrency],
  );

  // Carry the selected period + currency into the drill-in so it shows the same
  // window the user is looking at, not a hardcoded current-month/primary view.
  const insightHref = (category: string) =>
    `/hisaab-ai/insight/${encodeURIComponent(category)}?from=${start.toISOString()}&to=${end.toISOString()}&cur=${chartCurrency}`;

  const categories = useMemo(
    () => (rpcRows
      ? groupByCategoryFromSummary(rpcRows, chartCurrency)
      : groupByCategory(chartTransactions, start, end)),
    [rpcRows, chartCurrency, chartTransactions, start, end],
  );
  const trend = useMemo(
    () => (rpc
      ? monthlyTrendFromSummary(rpc.trend, chartCurrency, trendMonthsFor(period), now)
      : monthlyTrend(chartTransactions, trendMonthsFor(period), now)),
    [rpc, chartCurrency, chartTransactions, period, now],
  );
  const daily = useMemo(
    () => (rpc
      ? dailySpendingFromSeries(rpc.daily, chartCurrency, start, end)
      : dailySpending(chartTransactions, start, end)),
    [rpc, chartCurrency, chartTransactions, start, end],
  );
  const topExp = useMemo(
    () => (rpc
      ? topExpensesFromRows(rpc.top, chartCurrency, TOP_EXPENSE_LIMIT)
      : topExpenses(chartTransactions, start, end, TOP_EXPENSE_LIMIT).map(toTopExpenseRow)),
    [rpc, chartCurrency, chartTransactions, start, end],
  );

  // Spend trend vs the previous comparable window, in the chart currency.
  const spendCompare = useMemo(() => {
    const cur = rpc
      ? totalFromSummary(rpc.summary, 'expense', chartCurrency)
      : chartTransactions.filter((tx) => tx.type === 'expense' && inRange(tx, start, end)).reduce((s, tx) => s + tx.amount, 0);
    const prev = rpc
      ? totalFromSummary(rpc.previous, 'expense', chartCurrency)
      : (() => {
          const [pStart, pEnd] = previousRange(period, now);
          return chartTransactions.filter((tx) => tx.type === 'expense' && inRange(tx, pStart, pEnd)).reduce((s, tx) => s + tx.amount, 0);
        })();
    if (prev <= 0) return null;
    return { pct: Math.round(((cur - prev) / prev) * 100) };
  }, [rpc, chartCurrency, chartTransactions, period, start, end, now]);

  const spentByCurrency = useMemo(
    () => (rpcRows
      ? sumByCurrencyFromSummary(rpcRows, 'expense')
      : sumByCurrency(transactions, 'expense', start, end)),
    [rpcRows, transactions, start, end],
  );
  const incomeByCurrency = useMemo(
    () => (rpcRows
      ? sumByCurrencyFromSummary(rpcRows, 'income')
      : sumByCurrency(transactions, 'income', start, end)),
    [rpcRows, transactions, start, end],
  );
  const hasAnyData = spentByCurrency.length > 0 || incomeByCurrency.length > 0;

  // Net = income − spent, kept per-currency (never summed across currencies).
  // Ordered largest-magnitude first so the headline line is the dominant one.
  const netByCurrency = useMemo(() => {
    const byCur = new Map<Currency, number>();
    for (const { currency, amount } of incomeByCurrency) byCur.set(currency, (byCur.get(currency) ?? 0) + amount);
    for (const { currency, amount } of spentByCurrency) byCur.set(currency, (byCur.get(currency) ?? 0) - amount);
    return Array.from(byCur.entries())
      .map(([currency, amount]) => ({ currency, amount }))
      .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount) || a.currency.localeCompare(b.currency));
  }, [incomeByCurrency, spentByCurrency]);

  const periods: { key: Period; label: string }[] = [
    { key: 'this_month', label: t('analytics_this_month') },
    { key: 'last_month', label: t('analytics_last_month') },
    { key: '3months', label: t('analytics_3months') },
    { key: 'year', label: t('analytics_year') },
  ];
  const periodLabel = periods.find((p) => p.key === period)?.label ?? '';

  // Monthly trend: both existing series stay — spent in the Analytics violet,
  // income in the receive green (a pair the validator clears in both themes).
  const trendSeries: BarSeries[] = [
    { label: t('flex_spent_word'), tone: 'violet' },
    { label: t('tx_income'), tone: 'green' },
  ];
  const trendBars: BarDatum[] = trend.map((m) => ({ label: m.month, values: [m.expense, m.income] }));
  const dailySeries: BarSeries[] = [{ label: t('flex_spent_word'), tone: 'violet' }];
  const dailyBars: BarDatum[] = daily.map((d) => ({
    label: d.day,
    name: t('mv_day_n').replace('{n}', d.day),
    values: [d.amount],
  }));
  const skelDelay = (i: number) => ({ '--m-skel-delay': skeletonDelay(i) }) as CSSProperties;
  const sectionTitle = 'text-[10.5px] font-semibold text-ink-500 uppercase tracking-[0.12em]';

  return (
    <main className="min-h-dvh bg-cream-bg pb-28">
      <NavyHero accent="violet">
        <TopBar title={t('analytics_title')} back action={<LanguageToggle />} />
        <div className="px-5 pb-7">
          <p className="text-[10.5px] font-semibold text-white/70 tracking-[0.12em] uppercase">
            {t('analytics_hero_sub')}
          </p>
        </div>
      </NavyHero>

      <div className="sukoon-body min-h-[60dvh] pt-[18px]">
      {/* Period pills — the light-faced pill is the active window. */}
      <div className="px-5 pb-1 flex gap-2 overflow-x-auto no-scrollbar">
        {periods.map(p => (
          <button
            key={p.key}
            type="button"
            onClick={() => setPeriod(p.key)}
            aria-pressed={period === p.key}
            className="m-pill shrink-0 px-3.5"
          >
            {p.label}
          </button>
        ))}
      </div>

      {/* Period echo beside the cards so the figures are never ambiguous. */}
      <p className="m-label px-5 pt-4">
        {t('analytics_showing')} · {periodLabel}
      </p>

      {isInitialLoading ? (
        // Skeletons in the final geometry: the two stat cards, the trend row,
        // then the category and trend cards.
        <div className="px-5 pt-2.5 space-y-2.5" aria-hidden="true">
          <div className="grid grid-cols-2 gap-2.5">
            <div className="m-skel rounded-[16px] h-[92px]" style={skelDelay(0)} />
            <div className="m-skel rounded-[16px] h-[92px]" style={skelDelay(1)} />
          </div>
          <div className="m-skel rounded-[16px] h-[46px]" style={skelDelay(2)} />
          <div className="pt-4 space-y-2.5">
            <div className="m-skel rounded-[22px] h-[168px]" style={skelDelay(3)} />
            <div className="m-skel rounded-[22px] h-[188px]" style={skelDelay(3)} />
          </div>
        </div>
      ) : (
      <>
      {/* Summary cards — informational, never tappable. The tint carries the
          money direction the figures already mean: coral out, mint in. */}
      <div className="px-5 pt-2.5 grid grid-cols-2 gap-2.5">
        <StatCard label={t('analytics_total_spent')} totals={spentByCurrency} tone="expense" emptyCurrency={primaryCurrency} />
        <StatCard label={t('analytics_total_income')} totals={incomeByCurrency} tone="income" emptyCurrency={primaryCurrency} />
      </div>

      {/* Spend trend vs the previous comparable period (chart currency). For
          spending, up is coral (watch out), down is green (nice). The arrow
          carries the direction so it never rests on colour alone. */}
      {spendCompare && (
        <div className="px-5 pt-2.5">
          <div className="m-card rounded-[16px] px-4 py-3 flex items-center justify-between gap-2">
            <p className="text-[10.5px] text-ink-600 font-semibold uppercase tracking-[0.1em]">{t('analytics_spend_trend')} · {chartCurrency}</p>
            {spendCompare.pct === 0 ? (
              <span className="text-[12px] font-semibold text-ink-500">{t('analytics_no_change')}</span>
            ) : (
              <span className={`inline-flex items-center gap-1 text-[12.5px] font-semibold tabular-nums ${spendCompare.pct > 0 ? 'text-pay-text' : 'text-receive-text'}`}>
                <Glyph name={spendCompare.pct > 0 ? 'arrow-up' : 'arrow-down'} size={13} strokeWidth={2.8} />
                {Math.abs(spendCompare.pct)}% {t('analytics_vs_prev')}
              </span>
            )}
          </div>
        </div>
      )}

      {/* Net (income − spent) per currency. Coloured + signed so it's never
          colour-only: a leading +/− pairs with the receive/pay tint. */}
      {hasAnyData && netByCurrency.length > 0 && (
        <div className="px-5 pt-2.5">
          <div className="m-card rounded-[16px] px-4 py-3 flex items-center justify-between gap-3">
            <p className="text-[10.5px] text-ink-600 font-semibold uppercase tracking-[0.1em] shrink-0">{t('analytics_net')} · {periodLabel}</p>
            <div className="flex flex-col items-end gap-0.5 min-w-0">
              {netByCurrency.map(({ currency, amount }) => {
                const positive = amount >= 0;
                return (
                  <p
                    key={currency}
                    className={`text-[14px] font-semibold tabular-nums leading-tight ${positive ? 'text-receive-text' : 'text-pay-text'}`}
                  >
                    {positive ? '+' : '−'}{formatMoney(Math.abs(amount), currency)}
                  </p>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {currencies.length > 1 && (
        <div className="px-5 pt-3.5">
          <div className="flex items-center gap-2 overflow-x-auto no-scrollbar pb-1">
            <span className="m-label shrink-0">{t('analytics_currency')}</span>
            {currencies.map(currency => (
              <button
                key={currency}
                type="button"
                onClick={() => setSelectedCurrency(currency)}
                aria-pressed={chartCurrency === currency}
                className="m-pill shrink-0 px-3 tabular-nums"
              >
                {currency}
              </button>
            ))}
          </div>
        </div>
      )}

      {loadStatus === 'error' ? (
        // A failed fetch must never masquerade as "no spending data".
        <div className="px-5 pt-6">
          <PageErrorState
            variant="inline"
            message={loadError ?? undefined}
            onRetry={retryLoad}
          />
        </div>
      ) : !hasAnyData ? (
        // Only once the first load has RESOLVED — every store starts at [].
        loadStatus === 'ready' ? (
          <EmptyState
            icon={TrendingUp}
            clayIcon="analytics"
            tone="violet"
            title={t('analytics_no_data')}
            description={t('analytics_empty_desc')}
            actionLabel={t('analytics_empty_cta')}
            onAction={() => navigate('/transactions')}
          />
        ) : null
      ) : (
        <>
          {/* Category donut — recessed centre holds the total. */}
          {categories.length > 0 && (
            <section className="px-5 pt-6">
              <div className="mb-3 flex items-center justify-between gap-3">
                <h2 className={sectionTitle}>{t('analytics_categories')}</h2>
                <span className="m-chip m-chip-neutral tabular-nums">{chartCurrency}</span>
              </div>
              <div className="m-card m-card-feature p-[18px]">
                <CategoryDonut
                  categories={categories}
                  currency={chartCurrency}
                  onOpen={(category) => navigate(insightHref(category))}
                />
              </div>
            </section>
          )}

          {/* Monthly Trend — extruded bars, spent + income per month. */}
          {trend.length > 0 && (
            <section className="px-5 pt-6">
              <div className="mb-3 flex items-center justify-between gap-3">
                <h2 className={sectionTitle}>{t('analytics_trend')}</h2>
                <span className="m-chip m-chip-neutral tabular-nums">{chartCurrency}</span>
              </div>
              <div className="m-card m-card-feature p-[18px]">
                <ExtrudedBars
                  key={`${period}-${chartCurrency}-${now.getTime()}`}
                  series={trendSeries}
                  data={trendBars}
                  currency={chartCurrency}
                />
              </div>
            </section>
          )}

          {/* Daily Spending */}
          {daily.some(d => d.amount > 0) && (
            <section className="px-5 pt-6">
              <div className="mb-3 flex items-center justify-between gap-3">
                <h2 className={sectionTitle}>{t('analytics_daily')}</h2>
                <span className="m-chip m-chip-neutral tabular-nums">{chartCurrency}</span>
              </div>
              <div className="m-card m-card-feature p-[18px]">
                <ExtrudedBars
                  key={`${period}-${chartCurrency}-${now.getTime()}`}
                  series={dailySeries}
                  data={dailyBars}
                  currency={chartCurrency}
                  dense
                  showLabel={(i) => {
                    const day = Number(dailyBars[i]?.label);
                    return day === 1 || day % 5 === 0;
                  }}
                />
              </div>
            </section>
          )}

          {/* Top Expenses */}
          {topExp.length > 0 && (
            <section className="px-5 pt-6">
              <div className="mb-3 flex items-center justify-between gap-3">
                <h2 className={sectionTitle}>{t('analytics_top')}</h2>
                <span className="m-chip m-chip-neutral tabular-nums">{chartCurrency}</span>
              </div>
              <div className="m-card m-card-feature overflow-hidden divide-y divide-cream-hairline">
                {topExp.map(tx => {
                  const subtitle = getTransactionSubtitle(tx.notes);
                  const cat = tx.category || 'Other';
                  return (
                    <button
                      key={tx.id}
                      type="button"
                      onClick={() => navigate(insightHref(cat))}
                      className="w-full px-4 py-3 min-h-[48px] flex items-center gap-2.5 text-left active:bg-cream-soft transition-colors"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="text-[12.5px] font-semibold text-ink-900 truncate tracking-tight">{cat}</p>
                        {subtitle ? <p className="text-[10.5px] text-ink-400 truncate mt-0.5">{subtitle}</p> : null}
                      </div>
                      <p className="text-[13px] font-semibold text-pay-text tabular-nums shrink-0">−{formatMoney(tx.amount, tx.currency)}</p>
                      <Glyph name="chevron-right" size={13} className="text-ink-400" />
                    </button>
                  );
                })}
              </div>
            </section>
          )}
        </>
      )}
      </>
      )}
      </div>
    </main>
  );
}
