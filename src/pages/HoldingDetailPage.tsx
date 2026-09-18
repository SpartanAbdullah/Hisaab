// One holding: position summary with the avg-cost math visible, trade
// history (buys/sells/dividends with fees), replay-guarded delete, and the
// manual price update entry point.
//
// 1d (redesign 2026-09-18): violet hero with the value figure extruded, the
// breakdown on a card, extruded Buy / Sell / Dividend buttons, and history
// rows keyed by a tinted glyph square (coral = cash out, green = cash in).

import { useCallback, useMemo, useState, type CSSProperties } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { format } from 'date-fns';
import { TrendingUp } from 'lucide-react';
import { NavyHero, TopBar } from '../components/NavyHero';
import { LanguageToggle } from '../components/LanguageToggle';
import { PageErrorState } from '../components/PageErrorState';
import { EmptyState } from '../components/EmptyState';
import { Glyph } from '../components/Glyph';
import { MoneyDisplay } from '../components/MoneyDisplay';
import { useAsyncLoad } from '../hooks/useAsyncLoad';
import { useInvestmentStore } from '../stores/investmentStore';
import { useAccountStore } from '../stores/accountStore';
import { useToast } from '../components/Toast';
import { confirmDestructive } from '../components/ConfirmDestructiveSheet';
import { RecordTradeModal, type RecordTradePreset } from './RecordTradeModal';
import { UpdatePriceModal } from './UpdatePriceModal';
import { computePosition, sortTrades, unrealizedPnl, marketValue } from '../lib/investmentMath';
import { marketColorFor } from '../lib/marketColors';
import { skeletonDelay } from '../lib/material';
import { formatMoney } from '../lib/constants';
import { useT } from '../lib/i18n';
import type { InvestmentTrade } from '../db';

const DAY_MS = 24 * 60 * 60 * 1000;

// formatMoney() prints the magnitude only, so the sign is written here — a
// loss must never rest on colour alone (WCAG 1.4.1). A value that rounds to
// zero carries no sign.
function signedMoney(amount: number, currency: string): string {
  const text = formatMoney(amount, currency);
  if (text === formatMoney(0, currency)) return text;
  return `${amount < 0 ? '−' : '+'}${text}`;
}

const skelDelay = (i: number) => ({ '--m-skel-delay': skeletonDelay(i) }) as CSSProperties;

export function HoldingDetailPage() {
  // React Router already percent-decodes params — decoding again would
  // double-decode (and throw on symbols containing a literal %).
  const { marketId = '', symbol: rawSymbol = '' } = useParams();
  const symbol = rawSymbol.toUpperCase();
  const navigate = useNavigate();
  const t = useT();
  const toast = useToast();

  const markets = useInvestmentStore((s) => s.markets);
  const trades = useInvestmentStore((s) => s.trades);
  const prices = useInvestmentStore((s) => s.prices);
  const loadInvestments = useInvestmentStore((s) => s.loadInvestments);
  const deleteTrade = useInvestmentStore((s) => s.deleteTrade);
  const accounts = useAccountStore((s) => s.accounts);
  const loadAccounts = useAccountStore((s) => s.loadAccounts);

  const [showRecord, setShowRecord] = useState(false);
  const [recordPreset, setRecordPreset] = useState<RecordTradePreset | null>(null);
  const [showPrice, setShowPrice] = useState(false);
  const [busyTradeId, setBusyTradeId] = useState<string | null>(null);

  const load = useCallback(async () => {
    await Promise.all([loadInvestments(), loadAccounts()]);
  }, [loadInvestments, loadAccounts]);
  const { status, error, retry } = useAsyncLoad(load);

  const market = markets.find((m) => m.id === marketId) ?? null;
  const holdingTrades = useMemo(
    () => trades.filter((tr) => tr.marketId === marketId && tr.symbol === symbol),
    [trades, marketId, symbol],
  );
  const position = useMemo(() => computePosition(holdingTrades), [holdingTrades]);
  const priceRow = prices.find((p) => p.marketId === marketId && p.symbol === symbol) ?? null;
  const lastPrice = priceRow?.price ?? null;
  const priceAge = priceRow ? Math.floor((Date.now() - new Date(priceRow.asOf).getTime()) / DAY_MS) : null;

  const isOpen = position.quantity > 0;
  const value = lastPrice !== null ? marketValue(position, lastPrice) : null;
  const pnl = lastPrice !== null && isOpen ? unrealizedPnl(position, lastPrice) : null;

  const history = useMemo(() => sortTrades(holdingTrades).reverse(), [holdingTrades]);

  const openRecord = (kind: RecordTradePreset['kind']) => {
    setRecordPreset({ kind, marketId, symbol, lockSymbol: true });
    setShowRecord(true);
  };

  const handleDelete = async (trade: InvestmentTrade) => {
    const ok = await confirmDestructive({
      title: t('inv_delete_trade_confirm_title'),
      description: t('inv_delete_trade_confirm_body'),
      confirmLabel: t('inv_delete_trade'),
      cancelLabel: t('not_now'),
      tone: 'destructive',
    });
    if (!ok) return;
    setBusyTradeId(trade.id);
    try {
      await deleteTrade(trade.id);
      toast.show({ type: 'success', title: t('inv_delete_trade') + ' ✓' });
    } catch (err) {
      toast.show({ type: 'error', title: t('error'), subtitle: err instanceof Error ? err.message : t('toast_error_generic') });
    } finally {
      setBusyTradeId(null);
    }
  };

  const accountName = (id: string | null) =>
    id ? accounts.find((a) => a.id === id)?.name ?? '' : '';

  if (status === 'loading' && markets.length === 0) {
    // Skeleton in the loaded geometry: market chip + figure in the hero, then
    // the breakdown card, the action row and the history rows.
    return (
      <main className="min-h-dvh bg-cream-bg pb-28">
        <NavyHero accent="violet">
          <TopBar title={t('inv_title')} back showInbox={false} />
          <div className="px-5 pb-7" aria-hidden="true">
            <div className="m-skel h-6 w-28 rounded-full" />
            <div className="m-skel mt-3 h-[34px] w-48 rounded-xl" style={skelDelay(1)} />
            <div className="m-skel mt-3 h-3 w-40" style={skelDelay(2)} />
          </div>
        </NavyHero>
        <div className="sukoon-body min-h-[60dvh] px-5 pt-5 space-y-4" aria-hidden="true">
          <div className="m-skel h-[176px] rounded-[18px]" />
          <div className="flex gap-2.5">
            <div className="m-skel h-11 flex-1 rounded-[16px]" style={skelDelay(1)} />
            <div className="m-skel h-11 flex-1 rounded-[16px]" style={skelDelay(1)} />
            <div className="m-skel h-11 w-24 rounded-[16px]" style={skelDelay(1)} />
          </div>
          <div className="space-y-2.5">
            {[0, 1, 2].map((i) => (
              <div key={i} className="m-card p-3.5 flex items-center gap-3">
                <div className="m-skel w-9 h-9 rounded-[12px] shrink-0" style={skelDelay(i + 2)} />
                <div className="flex-1 min-w-0">
                  <div className="m-skel h-[11px] w-[48%]" style={skelDelay(i + 2)} />
                  <div className="m-skel h-[9px] w-[34%] mt-2" style={skelDelay(i + 2)} />
                </div>
                <div className="m-skel h-3 w-16 shrink-0" style={skelDelay(i + 2)} />
              </div>
            ))}
          </div>
        </div>
      </main>
    );
  }

  if (status === 'error') {
    return (
      <main className="min-h-dvh bg-cream-bg pb-28">
        <NavyHero accent="violet">
          <TopBar title={t('inv_title')} back showInbox={false} />
          <div className="px-5 pb-7" />
        </NavyHero>
        <div className="sukoon-body px-5 pt-5">
          <PageErrorState variant="inline" title={t('error')} message={error ?? ''} onRetry={retry} />
        </div>
      </main>
    );
  }

  if (status === 'ready' && (!market || holdingTrades.length === 0)) {
    return (
      <main className="min-h-dvh bg-cream-bg pb-28">
        <NavyHero accent="violet">
          <TopBar title={t('inv_title')} back showInbox={false} />
          <div className="px-5 pb-7" />
        </NavyHero>
        <div className="sukoon-body px-5 pt-5">
          <EmptyState
            icon={TrendingUp}
            clayIcon="analytics"
            tone="violet"
            title={t('inv_holding_not_found')}
            description=""
            actionLabel={t('inv_title')}
            onAction={() => navigate('/investments')}
          />
        </div>
      </main>
    );
  }

  if (!market) return null;

  const staleTone = priceAge !== null && priceAge > 30 ? 'text-pay-text' : 'text-warn-700';

  return (
    <main className="min-h-dvh bg-cream-bg pb-28">
      <NavyHero accent="violet">
        <TopBar
          title={symbol}
          back
          action={<LanguageToggle />}
        />
        <div className="px-5 pb-7">
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-white/10 ring-1 ring-inset ring-white/10 px-3 py-1 text-[10.5px] font-semibold text-white/90">
              <span aria-hidden="true" className={`w-1.5 h-1.5 rounded-full ${marketColorFor(market.id).dot}`} />
              {market.name} · {market.currency}
            </span>
            {!isOpen && (
              <span className="inline-flex rounded-full bg-white/10 ring-1 ring-inset ring-white/10 px-2.5 py-1 text-[10.5px] font-semibold text-white/80">
                {t('inv_position_closed')}
              </span>
            )}
          </div>
          {isOpen ? (
            <>
              <div className="mt-3.5">
                <MoneyDisplay
                  amount={value !== null ? value : position.costBasis}
                  currency={market.currency}
                  size={34}
                  tone="on-navy"
                  extrude="violet"
                />
              </div>
              <p className="text-[12px] text-white/70 tabular-nums mt-2.5">
                {t('inv_you_hold')
                  .replace('{qty}', position.quantity.toLocaleString())
                  .replace('{price}', formatMoney(position.avgCost, market.currency))}
              </p>
              {pnl !== null && (
                <div className="mt-2.5">
                  {/* Tint re-drawn from the hero-scoped -text token so the
                      pill reads the same in both themes. */}
                  <span
                    className={`m-chip px-[9px] py-[3px] text-[12px] tabular-nums ${
                      pnl >= 0 ? 'm-chip-receive' : 'm-chip-pay'
                    }`}
                  >
                    {signedMoney(pnl, market.currency)} {t('inv_unrealized')}
                  </span>
                </div>
              )}
              <button
                type="button"
                onClick={() => setShowPrice(true)}
                className="relative mt-3 flex w-fit max-w-full items-center gap-2 rounded-[12px] bg-white/10 ring-1 ring-inset ring-white/10 min-h-[36px] px-3 py-2 text-left text-[11.5px] active:bg-white/15 transition-colors before:absolute before:-inset-1 before:content-['']"
              >
                <Glyph name="edit" size={12} className="text-white/70" />
                {lastPrice !== null ? (
                  <span className="min-w-0">
                    <span className="font-semibold text-white tabular-nums">{formatMoney(lastPrice, market.currency)}</span>
                    {priceAge !== null && priceAge >= 7 && (
                      <span className={staleTone}> · {t('inv_price_asof_days').replace('{days}', String(priceAge))}</span>
                    )}
                    <span className="text-white/70"> — {t('inv_update_price')}</span>
                  </span>
                ) : (
                  <span className="text-warn-700">{t('inv_price_never')}</span>
                )}
              </button>
            </>
          ) : (
            <>
              <p
                className={`m-num text-[28px] mt-3.5 ${position.realizedPnl >= 0 ? 'text-receive-text' : 'text-pay-text'}`}
              >
                {signedMoney(position.realizedPnl, market.currency)}
              </p>
              <p className="text-[12px] text-white/70 mt-2">{t('inv_realized')}</p>
            </>
          )}
        </div>
      </NavyHero>

      <div className="sukoon-body min-h-[60dvh] px-5 pt-5 space-y-4">
        {/* Breakdown — auditable, not a black box. */}
        <div className="m-card p-4">
          <div className="space-y-2.5">
            {([
              [t('inv_invested'), position.costBasis, 'neutral'],
              [t('inv_current_value'), value, 'neutral'],
              [t('inv_unrealized'), pnl, 'signed'],
              [t('inv_realized'), position.realizedPnl, 'signed'],
              [t('inv_dividends'), position.dividends, 'neutral'],
              [t('inv_fees_total'), position.feesPaid, 'neutral'],
            ] as const).map(([label, amount, tone]) => (
              <div key={label} className="flex items-baseline justify-between gap-3">
                <span className="text-[12px] text-ink-600">{label}</span>
                <span className={`text-[13px] font-semibold tabular-nums ${
                  tone === 'signed' && amount !== null
                    ? amount >= 0 ? 'text-receive-text' : 'text-pay-text'
                    : 'text-ink-900'
                }`}>
                  {amount === null
                    ? '—'
                    : tone === 'signed'
                      ? signedMoney(amount, market.currency)
                      : formatMoney(amount, market.currency)}
                </span>
              </div>
            ))}
          </div>
          <p className="text-[10.5px] text-ink-400 mt-3 pt-2.5 border-t border-cream-hairline">{t('inv_avg_cost_note')}</p>
        </div>

        {/* Actions — Buy is the solid one (green, as the trade sheet keys it). */}
        <div className="flex gap-2.5">
          <button
            onClick={() => openRecord('buy')}
            className="m-btn m-btn-green flex-1 text-[12.5px]"
          >
            {isOpen ? t('inv_buy_more') : t('inv_buy')}
          </button>
          {isOpen && (
            <button
              onClick={() => openRecord('sell')}
              className="m-btn m-btn-plain flex-1 text-[12.5px]"
            >
              {t('inv_sell')}
            </button>
          )}
          <button
            onClick={() => openRecord('dividend')}
            className="m-btn m-btn-plain px-4 text-[12.5px]"
          >
            {t('inv_dividend')}
          </button>
        </div>

        {/* History */}
        <div className="pt-1">
          <p className="m-label mb-2.5 px-1">{t('inv_history')}</p>
          <div className="space-y-2.5">
            {history.map((tr) => {
              // Cash direction keys the row: a buy spends (coral), a sell or
              // a dividend brings money in (green).
              const cashOut = tr.kind === 'buy';
              const glyph = tr.kind === 'buy' ? 'plus' : tr.kind === 'sell' ? 'arrow-up' : 'coins';
              const cash = tr.kind === 'dividend'
                ? Math.round((tr.amount - tr.fees) * 100) / 100
                : tr.kind === 'buy'
                  ? Math.round((tr.quantity * tr.pricePerUnit + tr.fees) * 100) / 100
                  : Math.round((tr.quantity * tr.pricePerUnit - tr.fees) * 100) / 100;
              const label = tr.kind === 'dividend'
                ? t('inv_dividend')
                : `${t(tr.kind === 'buy' ? 'inv_buy' : 'inv_sell')} ${tr.quantity.toLocaleString()} @ ${tr.pricePerUnit}`;
              return (
                <div key={tr.id} className="m-card p-3.5 flex items-center gap-3">
                  <span
                    aria-hidden="true"
                    className={`m-card ${cashOut ? 'm-coral' : 'm-mint'} w-9 h-9 rounded-[12px] flex items-center justify-center shrink-0`}
                  >
                    <Glyph name={glyph} size={16} tone={cashOut ? 'coral' : 'green'} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-[12.5px] font-semibold text-ink-900 tabular-nums">{label}</p>
                    <p className="text-[10.5px] text-ink-600 mt-0.5">
                      {format(new Date(tr.tradedAt), 'MMM d, yyyy')}
                      {tr.fees > 0 ? ` · ${t('inv_fees')}: ${formatMoney(tr.fees, market.currency)}` : ''}
                      {tr.accountId
                        ? (accountName(tr.accountId) ? ` · ${accountName(tr.accountId)}` : '')
                        : ` · ${t('inv_outside_chip')}`}
                    </p>
                  </div>
                  <p className={`text-[12.5px] font-semibold tabular-nums shrink-0 ${cashOut ? 'text-pay-text' : 'text-receive-text'}`}>
                    {cashOut ? '−' : '+'}{formatMoney(cash, market.currency)}
                  </p>
                  <button
                    type="button"
                    onClick={() => handleDelete(tr)}
                    disabled={busyTradeId === tr.id}
                    aria-label={t('inv_delete_trade')}
                    className="m-ctl relative w-8 h-8 rounded-[10px] flex items-center justify-center shrink-0 text-ink-500 hover:text-pay-text active:text-pay-text transition-colors disabled:opacity-40 before:absolute before:-inset-1.5 before:content-['']"
                  >
                    <Glyph name="trash" size={14} />
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <RecordTradeModal open={showRecord} onClose={() => { setShowRecord(false); setRecordPreset(null); }} preset={recordPreset} />
      <UpdatePriceModal
        open={showPrice}
        onClose={() => setShowPrice(false)}
        marketId={marketId}
        symbol={symbol}
        currency={market.currency}
        currentPrice={lastPrice}
      />
    </main>
  );
}
