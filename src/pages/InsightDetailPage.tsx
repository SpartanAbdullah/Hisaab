import { useCallback, useMemo } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { TrendingUp } from 'lucide-react';
import { PageHeader } from '../components/PageHeader';
import { PageErrorState } from '../components/PageErrorState';
import { ListSkeleton } from '../components/ListSkeleton';
import { EmptyState } from '../components/EmptyState';
import { useTransactionStore } from '../stores/transactionStore';
import { useT } from '../lib/i18n';
import { useAsyncLoad } from '../hooks/useAsyncLoad';
import { formatMoney } from '../lib/constants';
import { parseInternalNote } from '../lib/internalNotes';
import { getPrimaryCurrency } from '../lib/primaryCurrency';

function primaryCurrency(): string {
  return getPrimaryCurrency();
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Drill into one spending category. Honours the period + currency the user had
// selected on Analytics (passed as ?from=&to=&cur=); falls back to the current
// month in the primary currency when opened without them.
export function InsightDetailPage() {
  const t = useT();
  const { category = '' } = useParams();
  const [params] = useSearchParams();
  const cat = decodeURIComponent(category);
  const transactions = useTransactionStore((s) => s.transactions);
  const loadTransactions = useTransactionStore((s) => s.loadTransactions);
  const load = useCallback(() => loadTransactions(), [loadTransactions]);
  const { status, error, retry } = useAsyncLoad(load);

  const data = useMemo(() => {
    const cur = params.get('cur') || primaryCurrency();
    const now = new Date();
    const fromParam = params.get('from');
    const toParam = params.get('to');
    const from = fromParam ? new Date(fromParam) : new Date(now.getFullYear(), now.getMonth(), 1);
    const to = toParam ? new Date(toParam) : now;
    const rows = transactions.filter((t) => {
      if (t.type !== 'expense' || t.currency !== cur || (t.category || 'Other') !== cat) return false;
      const d = new Date(t.createdAt);
      return d >= from && d <= to;
    });
    const total = rows.reduce((a, t) => a + t.amount, 0);

    // Trend buckets: by calendar month when the range spans more than one
    // month, else by week-of-month. Keeps the chart meaningful for any period.
    const spanDays = (to.getTime() - from.getTime()) / 86_400_000;
    const byMonth = spanDays > 32;
    let weekBars: { name: string; amt: number }[];
    if (byMonth) {
      const buckets = new Map<string, number>();
      for (const t of rows) {
        const k = (t.createdAt ?? '').slice(0, 7);
        buckets.set(k, (buckets.get(k) ?? 0) + t.amount);
      }
      weekBars = [...buckets.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([k, amt]) => ({ name: MONTHS[parseInt(k.slice(5, 7), 10) - 1] ?? k, amt }));
    } else {
      const weeks = [0, 0, 0, 0, 0];
      for (const t of rows) {
        const day = new Date(t.createdAt).getDate();
        weeks[Math.min(4, Math.floor((day - 1) / 7))] += t.amount;
      }
      // The week NUMBER is the name; it is formatted ("Wk 2" / "Hafta 2")
      // at render time so this memo does not depend on the language.
      weekBars = weeks.map((amt, i) => ({ name: String(i + 1), amt }));
      while (weekBars.length > 1 && weekBars[weekBars.length - 1].amt === 0) weekBars.pop();
    }

    // by merchant (the note carries the merchant/description). Split-group-linked
    // expenses hide their real label behind a [[HISAAB_META:…]] tag, so parse it
    // out — otherwise the breakdown shows a URL-encoded JSON blob as the merchant.
    const byMerchant = new Map<string, { amt: number; count: number }>();
    for (const t of rows) {
      const parsed = parseInternalNote(t.notes);
      const key = parsed.visibleNote.trim()
        || parsed.meta.expenseDescription
        || parsed.meta.groupName
        || 'Other';
      const e = byMerchant.get(key) ?? { amt: 0, count: 0 };
      e.amt += t.amount;
      e.count += 1;
      byMerchant.set(key, e);
    }
    const merchants = [...byMerchant.entries()]
      .map(([name, v]) => ({ name, ...v }))
      .sort((a, b) => b.amt - a.amt)
      .slice(0, 8);

    return { cur, total, weekBars, merchants, count: rows.length, byMonth };
  }, [transactions, cat, params]);

  const maxWeek = Math.max(1, ...data.weekBars.map((w) => w.amt));

  return (
    <main className="min-h-dvh bg-cream-bg pb-28">
      <PageHeader title={cat || t('category')} back />

      <div className="px-5 pt-5 space-y-3">
        {status === 'error' && (
          <PageErrorState
            variant="inline"
            title={t('idp_err_load')}
            message={error ?? t('err_some_data_failed')}
            onRetry={retry}
          />
        )}

        {status === 'loading' && transactions.length === 0 ? (
          <div className="space-y-3" aria-hidden="true">
            <div className="m-skel rounded-[18px] h-[108px]" />
            <div className="m-skel rounded-[22px] h-[168px]" style={{ '--m-skel-delay': '0.15s' } as React.CSSProperties} />
            <ListSkeleton rows={3} withAvatar={false} />
          </div>
        ) : data.count === 0 ? (
          status === 'ready' ? (
            <EmptyState
              icon={TrendingUp}
              clayIcon="analytics"
              tone="violet"
              title={t('mv_idp_empty_title').replace('{cat}', cat)}
              description={t('mv_idp_empty_desc')}
            />
          ) : null
        ) : (
          <>
            {/* total — the coral "money out" stat card */}
            <div className="m-card m-coral p-4">
              <p className="text-[10px] text-pay-text font-semibold tracking-[0.12em] uppercase">
                {t('idp_total_spent')}
              </p>
              <p className="text-[28px] font-semibold text-ink-900 tabular-nums tracking-[-0.03em] mt-1.5 leading-tight">
                {formatMoney(data.total, data.cur)}
              </p>
              <p className="text-[11.5px] text-ink-600 mt-1">
                {data.count === 1
                  ? t('idp_across_one')
                  : t('idp_across_many').replace('{n}', String(data.count))}
              </p>
            </div>

            {/* by week / month — extruded bars, as on Analytics */}
            {data.weekBars.length > 0 && (
              <div className="m-card m-card-feature p-[18px]">
                <p className="text-[10.5px] text-ink-500 font-semibold tracking-[0.12em] uppercase mb-3">
                  {data.byMonth ? t('mv_idp_by_month') : t('mv_idp_by_week')}
                </p>
                <div className="flex items-end gap-2.5 h-[124px]">
                  {data.weekBars.map((w) => (
                    <div key={w.name} className="flex-1 min-w-0 flex flex-col items-center justify-end gap-1.5 h-full">
                      <span className="text-[10.5px] font-semibold text-ink-800 tabular-nums">
                        {Math.round(w.amt)}
                      </span>
                      <div
                        className="w-full max-w-[34px]"
                        style={{
                          height: `${Math.max(6, Math.round((w.amt / maxWeek) * 80))}px`,
                          backgroundImage: 'linear-gradient(var(--color-iris-500), var(--color-iris-600))',
                          borderRadius: '7px 7px 3px 3px',
                          boxShadow: 'inset 0 2px 0 rgba(255, 255, 255, 0.4), inset 2px 0 0 rgba(255, 255, 255, 0.16), inset -3px 0 0 rgba(0, 0, 0, 0.22), 0 2px 0 color-mix(in srgb, var(--color-iris-600) 55%, black)',
                        }}
                      />
                      <span className="text-[9.5px] font-medium text-ink-500 mt-0.5 whitespace-nowrap">
                        {data.byMonth ? w.name : t('mv_idp_week_n').replace('{n}', w.name)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* by merchant */}
            <div className="m-card m-card-feature overflow-hidden">
              <p className="text-[10.5px] text-ink-500 font-semibold tracking-[0.12em] uppercase px-4 pt-4 pb-1.5">
                {t('idp_where_it_went')}
              </p>
              <div className="divide-y divide-cream-hairline">
                {data.merchants.map((m) => (
                  <div
                    key={m.name}
                    className="flex items-center justify-between gap-3 px-4 py-3"
                  >
                    <div className="min-w-0">
                      <p className="text-[13px] font-semibold text-ink-900 truncate tracking-tight">{m.name}</p>
                      <p className="text-[11px] text-ink-500 mt-0.5">
                        {m.count === 1
                          ? t('mv_idp_charge_one')
                          : t('mv_idp_charge_many').replace('{n}', String(m.count))}
                      </p>
                    </div>
                    <p className="text-[13px] font-semibold text-pay-text tabular-nums shrink-0">
                      −{formatMoney(m.amt, data.cur).replace(`${data.cur} `, '')}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          </>
        )}
      </div>
    </main>
  );
}
