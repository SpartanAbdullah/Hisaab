import { useId, useState } from 'react';
import { Modal } from './Modal';
import { Glyph } from './Glyph';
import { markWrapShown, type WrapStats } from '../lib/monthlyWrap';
import { formatMoney } from '../lib/constants';
import { generateWrapCard } from '../lib/wrapCard';
import { shareStatementFile } from '../lib/shareStatement';
import { useT } from '../lib/i18n';

interface Props {
  /** The already-computed wrap. Non-null: mounting this component means "show it". */
  stats: WrapStats;
  /** Lets the gate that mounted this unmount it again after dismissal. */
  onClose?: () => void;
}

// Spotify-Wrapped-style end-of-month summary.
//
// Audit 03-performance H1 / P2 M2c: this component is LAZY now. It reaches
// wrapCard.ts → renderNodeToImage.ts → jspdf + modern-screenshot, so while it
// was statically imported by src/App.tsx that whole image/PDF stack sat in the
// eager import graph of every cold boot (see docs/performance.md §3).
//
// The trigger — "at least into a new month, not shown yet, >= 3 transactions in
// the prior month in the primary currency" — therefore runs in the gate in
// src/App.tsx, which dynamic-imports the (tiny, pure) monthlyWrap.ts, and only
// mounts this component once it has real stats to render.
export function MonthlyWrapModal({ stats, onClose }: Props) {
  const t = useT();
  const totalsLabelId = useId();
  const [open, setOpen] = useState(true);
  const [includeTotals, setIncludeTotals] = useState(false);
  const [sharing, setSharing] = useState(false);

  const handleClose = () => {
    setOpen(false);
    markWrapShown(stats.monthKey);
    onClose?.();
  };

  // Share the Wrapped as a portrait IMAGE card (WhatsApp Status shaped) so it
  // reaches non-users. Exact totals only ride along when the user opts in.
  const handleShare = async () => {
    if (sharing) return;
    setSharing(true);
    try {
      const { blob, filename } = await generateWrapCard(stats, { showTotals: includeTotals });
      await shareStatementFile({
        blob,
        filename,
        title: `My ${stats.monthLabel} Hisaab Wrap`,
        text: `My ${stats.monthLabel} — tracked with Hisaab`,
      });
    } catch {
      // Share cancelled / failed silently — fine.
    } finally {
      setSharing(false);
    }
  };

  const trendArrow = stats.spendChangePercent == null
    ? ''
    : stats.spendChangePercent < 0
      ? '↓'
      : '↑';
  const trendLabel = stats.spendChangePercent == null
    ? ''
    : `${trendArrow} ${Math.abs(stats.spendChangePercent).toFixed(0)}% ${t('mh_vs_last')}`;

  return (
    <Modal open={open} onClose={handleClose} title={stats.monthLabel}>
      <div className="space-y-3">
        {/* Lead card — the one dark "hero" surface in the sheet. */}
        <div className="bg-navy-bloom rounded-[22px] text-white p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.08),0_16px_28px_-18px_rgba(0,0,0,0.9)]">
          <div className="flex items-center gap-2">
            <Glyph name="sparkles" size={15} tone="violet" extrude />
            <p className="text-[10.5px] font-semibold uppercase tracking-[0.12em] text-white/70">
              {t('mwm_your_wrap')}
            </p>
          </div>
          <p className="text-[20px] font-semibold tracking-tight mt-2.5 leading-snug">
            {stats.headline}
          </p>
          {trendLabel && (
            <p className="text-[12px] text-white/70 mt-2 tabular-nums">{trendLabel}</p>
          )}
        </div>

        {/* Three-up stat strip — tinted stat cards */}
        <div className="grid grid-cols-3 gap-2.5">
          <StatCard
            label={t('flex_spent_word')}
            value={formatMoney(stats.totalSpent, stats.primaryCurrency)}
            tone="pay"
          />
          <StatCard
            label={t('tx_income')}
            value={formatMoney(stats.totalIncome, stats.primaryCurrency)}
            tone="receive"
          />
          <StatCard
            label={t('analytics_net')}
            value={`${stats.net >= 0 ? '+' : ''}${formatMoney(stats.net, stats.primaryCurrency)}`}
            tone={stats.net >= 0 ? 'receive' : 'pay'}
          />
        </div>

        {/* Top categories */}
        {stats.topCategories.length > 0 && (
          <div className="m-card p-4">
            <p className="text-[10.5px] font-semibold uppercase tracking-[0.12em] text-ink-500">
              {t('mwm_where_it_went')}
            </p>
            <div className="mt-3 space-y-2.5">
              {stats.topCategories.map((c) => (
                <div key={c.category}>
                  <div className="flex items-baseline justify-between gap-2 tabular-nums">
                    <p className="text-[13px] font-semibold text-ink-900 truncate">{c.category}</p>
                    <p className="text-[12px] text-ink-700 shrink-0">
                      {formatMoney(c.amount, stats.primaryCurrency)}
                      <span className="text-ink-500 ml-1.5">· {c.share.toFixed(0)}%</span>
                    </p>
                  </div>
                  <div className="m-inset mt-1.5 h-2 rounded-full overflow-hidden">
                    <div
                      className="h-full rounded-full bg-gradient-to-r from-accent-500 to-accent-600"
                      style={{ width: `${Math.min(c.share, 100)}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Biggest + busiest day */}
        <div className="grid grid-cols-2 gap-2.5">
          {stats.biggestExpense && (
            <div className="m-card p-3.5 min-w-0">
              <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-ink-500">
                {t('mwm_biggest_hit')}
              </p>
              <p className="text-[16px] font-semibold text-ink-900 tabular-nums mt-1 truncate">
                {formatMoney(stats.biggestExpense.amount, stats.biggestExpense.currency)}
              </p>
              <p className="text-[11px] text-ink-600 truncate">
                {stats.biggestExpense.category || t('mv_uncategorised')}
              </p>
            </div>
          )}
          {stats.bigSpendDay && (
            <div className="m-card p-3.5 min-w-0">
              <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-ink-500">
                {t('mwm_busiest_day')}
              </p>
              <p className="text-[16px] font-semibold text-ink-900 tabular-nums mt-1 truncate">
                {formatMoney(stats.bigSpendDay.amount, stats.primaryCurrency)}
              </p>
              <p className="text-[11px] text-ink-600">
                {new Date(stats.bigSpendDay.date).toLocaleDateString(undefined, {
                  weekday: 'short',
                  day: 'numeric',
                  month: 'short',
                })}
              </p>
            </div>
          )}
        </div>

        {/* Privacy: default to "proud numbers"; exact totals are opt-in. */}
        <div className="m-card flex items-center justify-between gap-3 px-4 py-3">
          <span id={totalsLabelId} className="text-[12.5px] font-semibold text-ink-800">{t('mwm_include_totals')}</span>
          <button
            type="button"
            role="switch"
            aria-checked={includeTotals}
            aria-labelledby={totalsLabelId}
            onClick={() => setIncludeTotals((v) => !v)}
            className="m-switch"
          />
        </div>

        <div className="flex gap-2.5 pt-1">
          <button
            onClick={handleShare}
            disabled={sharing}
            className="cta-secondary flex-1"
          >
            <Glyph name="share" size={15} /> {sharing ? t('mwm_preparing') : t('mwm_share_card')}
          </button>
          <button onClick={handleClose} className="cta-primary flex-1">
            {t('mwm_see_next_month')}
          </button>
        </div>
      </div>
    </Modal>
  );
}

interface StatCardProps {
  label: string;
  value: string;
  tone: 'receive' | 'pay';
}

// Tinted stat card: the tint + label colour carry direction, the figure
// stays in primary ink.
function StatCard({ label, value, tone }: StatCardProps) {
  return (
    <div className={`m-card ${tone === 'receive' ? 'm-mint' : 'm-coral'} rounded-[16px] p-3 min-w-0`}>
      <p
        className={`text-[9.5px] font-semibold uppercase tracking-[0.12em] ${
          tone === 'receive' ? 'text-receive-text' : 'text-pay-text'
        }`}
      >
        {label}
      </p>
      <p className="text-[14px] font-semibold text-ink-900 tabular-nums mt-1.5 truncate">
        {value}
      </p>
    </div>
  );
}

