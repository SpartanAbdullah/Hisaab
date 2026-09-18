// Investment Tracker main page: per-currency portfolio summary (never
// cross-summed — LoansPage discipline), market chips, holdings grouped by
// market, closed positions collapsed at the bottom. Record-keeping framing
// throughout — Hisaab never advises or holds investments.
//
// 1d (redesign 2026-09-18): violet hero with the value figure itself
// extruded, material pills for the market scope (a coloured dot keys each
// market), holdings as pressable tiles with a violet ticker plate.

import { useCallback, useMemo, useState, type CSSProperties } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { TrendingUp } from 'lucide-react';
import { NavyHero, TopBar } from '../components/NavyHero';
import { LanguageToggle } from '../components/LanguageToggle';
import { EmptyState } from '../components/EmptyState';
import { Glyph } from '../components/Glyph';
import { MoneyDisplay } from '../components/MoneyDisplay';
import { PageErrorState } from '../components/PageErrorState';
import { useAsyncLoad } from '../hooks/useAsyncLoad';
import { useInvestmentStore, holdingsFor, portfolioTotals, type HoldingView } from '../stores/investmentStore';
import { useAccountStore } from '../stores/accountStore';
import { RecordTradeModal, type RecordTradePreset } from './RecordTradeModal';
import { CreateMarketModal } from './CreateMarketModal';
import { ManageMarketsSheet } from './ManageMarketsSheet';
import { UpdatePricesSheet } from './UpdatePricesSheet';
import { formatMoney } from '../lib/constants';
import { unrealizedPnl, marketValue } from '../lib/investmentMath';
import { marketColorFor } from '../lib/marketColors';
import { skeletonDelay } from '../lib/material';
import { currencyMeta } from '../lib/design-tokens';
import { useT } from '../lib/i18n';
import { getPrimaryCurrency } from '../lib/primaryCurrency';

const DAY_MS = 24 * 60 * 60 * 1000;

function priceAgeDays(asOf: string | null): number | null {
  if (!asOf) return null;
  return Math.floor((Date.now() - new Date(asOf).getTime()) / DAY_MS);
}

// formatMoney() prints the magnitude only, so the sign is written here — a
// loss must never rest on colour alone (WCAG 1.4.1). U+2212, like Home. A
// value that rounds to zero carries no sign.
function signedMoney(amount: number, currency: string): string {
  const text = formatMoney(amount, currency);
  if (text === formatMoney(0, currency)) return text;
  return `${amount < 0 ? '−' : '+'}${text}`;
}

// Sign from the ROUNDED value: −0.04% reads 0.0%, never −0.0% (Home's rule).
function signedPct(pct: number): string {
  const rounded = Math.round(pct * 10) / 10;
  if (rounded === 0) return '0.0%';
  return `${rounded < 0 ? '−' : '+'}${Math.abs(rounded).toFixed(1)}%`;
}

const skelDelay = (i: number) => ({ '--m-skel-delay': skeletonDelay(i) }) as CSSProperties;

export function InvestmentsPage() {
  const navigate = useNavigate();
  const t = useT();
  const markets = useInvestmentStore((s) => s.markets);
  const trades = useInvestmentStore((s) => s.trades);
  const prices = useInvestmentStore((s) => s.prices);
  const loadInvestments = useInvestmentStore((s) => s.loadInvestments);
  const loadAccounts = useAccountStore((s) => s.loadAccounts);

  // Home's per-market card rows deep-link here as /investments?market=<id> —
  // land already scoped to that market instead of the mixed all-markets view.
  const [searchParams] = useSearchParams();
  const [scopedMarketId, setScopedMarketId] = useState<string | null>(() => searchParams.get('market'));
  const [showRecord, setShowRecord] = useState(false);
  const [recordPreset, setRecordPreset] = useState<RecordTradePreset | null>(null);
  const [showCreateMarket, setShowCreateMarket] = useState(false);
  const [showManage, setShowManage] = useState(false);
  const [showBulkPrices, setShowBulkPrices] = useState(false);
  const [showClosed, setShowClosed] = useState(false);

  const load = useCallback(async () => {
    await Promise.all([loadInvestments(), loadAccounts()]);
  }, [loadInvestments, loadAccounts]);
  const { status, error, retry } = useAsyncLoad(load);
  const loadingFirst = status === 'loading' && markets.length === 0;

  const scopedMarket = scopedMarketId ? markets.find((m) => m.id === scopedMarketId) ?? null : null;
  const primaryCurrency = getPrimaryCurrency();

  const totals = useMemo(() => {
    const scoped = scopedMarket ? markets.filter((m) => m.id === scopedMarket.id) : markets;
    return portfolioTotals(scoped, trades, prices);
  }, [markets, scopedMarket, trades, prices]);
  // Headline: the primary currency when present, else the biggest bucket.
  const headline = totals.find((b) => b.currency === primaryCurrency) ?? totals[0] ?? null;
  const pockets = totals.filter((b) => b !== headline);

  // Scope by the RESOLVED market, not the raw id — a stale deep-link id
  // (deleted market) must fall back to the all-markets view, not an empty one.
  const holdings = useMemo(
    () => holdingsFor(scopedMarket?.id ?? null, trades, prices),
    [scopedMarket, trades, prices],
  );
  const open = holdings.filter((h) => h.position.quantity > 0);
  const closed = holdings.filter((h) => h.position.quantity === 0);
  const unpricedOpen = open.filter((h) => h.lastPrice === null).length;
  const marketById = useMemo(() => new Map(markets.map((m) => [m.id, m])), [markets]);

  const openRecord = (preset: RecordTradePreset | null = null) => {
    setRecordPreset(preset);
    setShowRecord(true);
  };

  const renderHolding = (h: HoldingView) => {
    const market = marketById.get(h.marketId);
    if (!market) return null;
    const isOpen = h.position.quantity > 0;
    const value = h.lastPrice !== null ? marketValue(h.position, h.lastPrice) : null;
    const pnl = h.lastPrice !== null && isOpen ? unrealizedPnl(h.position, h.lastPrice) : null;
    const pnlPct = pnl !== null && h.position.costBasis > 0 ? (pnl / h.position.costBasis) * 100 : null;
    const age = priceAgeDays(h.priceAsOf);
    return (
      <button
        key={`${h.marketId}:${h.symbol}`}
        type="button"
        onClick={() => navigate(`/investment/${h.marketId}/${encodeURIComponent(h.symbol)}`)}
        // Pressable tile: one hard wall that collapses under the finger.
        className="m-tile rounded-[18px] p-3.5 flex items-center gap-3 text-left"
      >
        {/* Ticker plate — violet (the investments accent) while the position
            is open, a plain face once it's closed. */}
        <span
          aria-hidden="true"
          className={`m-card w-11 h-11 rounded-[14px] flex items-center justify-center shrink-0 text-[12px] font-bold tracking-tight ${
            isOpen ? 'm-violet text-iris-text' : 'text-ink-600'
          }`}
        >
          {h.symbol.slice(0, 3)}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[13.5px] font-semibold text-ink-900 truncate tracking-[-0.01em]">
            {h.symbol}
            {!scopedMarket && (
              <span className="text-[11px] font-normal text-ink-400"> · {market.name}</span>
            )}
          </p>
          {isOpen ? (
            <>
              <p className="text-[11px] text-ink-600 mt-[3px] tabular-nums truncate">
                {h.position.quantity.toLocaleString()} @ {formatMoney(h.position.avgCost, market.currency)}
              </p>
              {/* Price age in the app's age vocabulary (Loans age chips):
                  missing / a week+ is gold, a month+ is coral. */}
              {h.lastPrice === null ? (
                <p className="text-[10.5px] text-warn-700 mt-[3px]">{t('inv_price_never')}</p>
              ) : age !== null && age >= 7 ? (
                <p className={`text-[10.5px] mt-[3px] ${age > 30 ? 'text-pay-text' : 'text-warn-700'}`}>
                  {t('inv_price_asof_days').replace('{days}', String(age))}
                </p>
              ) : null}
            </>
          ) : (
            <p className="text-[11px] text-ink-600 mt-[3px]">{t('inv_position_closed')}</p>
          )}
        </div>
        <div className="text-right shrink-0">
          {isOpen ? (
            <>
              <p className={`text-[13.5px] font-semibold tabular-nums ${value !== null ? 'text-ink-900' : 'text-ink-400'}`}>
                {value !== null ? formatMoney(value, market.currency) : `— ${market.currency}`}
              </p>
              {pnl !== null && (
                <p className={`text-[11px] font-semibold tabular-nums mt-[3px] ${pnl >= 0 ? 'text-receive-text' : 'text-pay-text'}`}>
                  {signedMoney(pnl, market.currency)}
                  {pnlPct !== null ? ` · ${signedPct(pnlPct)}` : ''}
                </p>
              )}
            </>
          ) : (
            <p className={`text-[12px] font-semibold tabular-nums ${h.position.realizedPnl >= 0 ? 'text-receive-text' : 'text-pay-text'}`}>
              {signedMoney(h.position.realizedPnl, market.currency)}
            </p>
          )}
        </div>
      </button>
    );
  };

  return (
    <main className="min-h-dvh bg-cream-bg pb-28">
      <NavyHero accent="violet">
        <TopBar
          title={t('inv_title')}
          back
          action={
            <div className="flex items-center gap-2">
              {markets.length > 0 && (
                // The attention halo (.glow-attention, violet via .glow-violet)
                // pulses on the wrapper's ::after, so the violet button keeps
                // its extruded walls throughout.
                <span className="glow-attention glow-violet inline-flex rounded-full">
                  <button
                    onClick={() => openRecord(scopedMarket ? { marketId: scopedMarket.id } : null)}
                    className="m-btn m-btn-violet relative h-8 min-h-8 px-3.5 py-0 gap-1.5 rounded-full text-[11px] before:absolute before:-inset-1.5 before:content-['']"
                  >
                    <Glyph name="plus" size={12} strokeWidth={3} />
                    {t('inv_record_trade')}
                  </button>
                </span>
              )}
              <LanguageToggle />
            </div>
          }
        />
        <div className="px-5 pb-7">
          {/* Compliance posture, stated once, calmly. */}
          <span className="inline-flex items-center gap-[7px] rounded-full bg-white/10 ring-1 ring-inset ring-white/10 px-[11px] py-1.5">
            <Glyph name="document" size={12} className="text-white/70" />
            <span className="text-[10.5px] font-medium text-white/90">{t('inv_record_only')}</span>
          </span>

          {loadingFirst ? (
            <div aria-hidden="true">
              <div className="m-skel mt-[18px] h-[11px] w-32" />
              <div className="m-skel mt-2.5 h-[34px] w-52 rounded-xl" style={skelDelay(1)} />
              <div className="m-skel mt-3 h-[22px] w-44 rounded-full" style={skelDelay(2)} />
            </div>
          ) : headline && (
            <>
              <p className="mt-[18px] text-[11px] font-semibold uppercase tracking-[0.12em] text-white/70">
                {t('inv_current_value')} · {headline.currency}
              </p>
              <div className="mt-[7px]">
                <MoneyDisplay
                  amount={headline.currentValue}
                  currency={headline.currency}
                  size={34}
                  tone="on-navy"
                  extrude="violet"
                />
              </div>
              <div className="flex items-center gap-2.5 flex-wrap mt-[11px]">
                <span className="text-[12px] text-white/70 tabular-nums">
                  {t('inv_invested')} {formatMoney(headline.invested, headline.currency)}
                </span>
                {/* The m-chip tint is re-drawn from the hero-scoped -text token
                    so the pill reads the same in both themes (the -100 tints
                    are not hero-scoped). */}
                <span
                  className={`m-chip px-[9px] py-[3px] text-[12px] tabular-nums ${
                    headline.unrealized >= 0 ? 'm-chip-receive' : 'm-chip-pay'
                  }`}
                >
                  {signedMoney(headline.unrealized, headline.currency)}
                  {headline.invested > 0 ? ` · ${signedPct((headline.unrealized / headline.invested) * 100)}` : ''}
                </span>
              </div>
              {(headline.realized !== 0 || headline.dividends !== 0) && (
                <p className="text-[11px] text-white/60 tabular-nums mt-[9px]">
                  {t('inv_realized')} {signedMoney(headline.realized, headline.currency)}
                  {headline.dividends !== 0 ? ` · ${t('inv_dividends')} ${formatMoney(headline.dividends, headline.currency)}` : ''}
                </p>
              )}
              {headline.unpricedCount > 0 && (
                <p className="text-[10.5px] text-warn-700 mt-1.5">
                  {t('inv_unpriced_chip').replace('{n}', String(headline.unpricedCount))} — {t('inv_price_never')}
                </p>
              )}
            </>
          )}

          {/* Per-currency pockets — never summed into the headline. */}
          {pockets.length > 0 && (
            <div className="flex flex-col gap-[7px] mt-3.5">
              {pockets.map((b) => {
                // An entirely unpriced bucket sits at cost — it has no change
                // to show, so say so instead of printing a fake 0.0% (Home).
                const allUnpriced = b.unpricedCount > 0 && Math.abs(b.unrealized) < 0.005;
                return (
                  <div
                    key={b.currency}
                    className="flex items-baseline justify-between gap-3 rounded-xl bg-white/5 px-3 py-[9px]"
                  >
                    <span className="text-[11px] font-semibold text-white/70 shrink-0">
                      {currencyMeta[b.currency]?.flag} {b.currency}
                    </span>
                    <span className="text-[12px] font-semibold text-white tabular-nums text-right">
                      {formatMoney(b.currentValue, b.currency)}
                      <span
                        className={`ml-2 ${
                          allUnpriced ? 'font-medium text-white/60' : b.unrealized >= 0 ? 'text-receive-text' : 'text-pay-text'
                        }`}
                      >
                        {allUnpriced
                          ? t('inv_unpriced_chip').replace('{n}', String(b.unpricedCount))
                          : b.invested > 0
                            ? signedPct((b.unrealized / b.invested) * 100)
                            : signedMoney(b.unrealized, b.currency)}
                      </span>
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </NavyHero>

      <div className="sukoon-body min-h-[60dvh] px-5 pt-5 space-y-3.5">
        {status === 'error' && (
          <PageErrorState variant="inline" title={t('error')} message={error ?? ''} onRetry={retry} />
        )}

        {/* A failed load must not fall through to the "create your first
            market" empty state — the user may well have markets. */}
        {status === 'error' && markets.length === 0 ? null : loadingFirst ? (
          // Skeleton in the loaded geometry: the chip row, then holding
          // tiles with a plate, two lines and a trailing figure.
          <div className="space-y-3.5" aria-hidden="true">
            <div className="flex gap-2">
              {[52, 96, 96].map((w, i) => (
                <div key={i} className="m-skel h-[34px] rounded-full" style={{ width: w }} />
              ))}
            </div>
            <div className="space-y-2.5">
              {[0, 1, 2].map((i) => (
                <div key={i} className="m-card rounded-[18px] p-3.5 flex items-center gap-3">
                  <div className="m-skel w-11 h-11 rounded-[14px] shrink-0" style={skelDelay(i + 1)} />
                  <div className="flex-1 min-w-0">
                    <div className="m-skel h-[11px] w-[42%]" style={skelDelay(i + 1)} />
                    <div className="m-skel h-[9px] w-[30%] mt-2" style={skelDelay(i + 1)} />
                  </div>
                  <div className="flex flex-col items-end shrink-0">
                    <div className="m-skel h-[12px] w-[68px]" style={skelDelay(i + 1)} />
                    <div className="m-skel h-[9px] w-[40px] mt-2" style={skelDelay(i + 1)} />
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : markets.length === 0 ? (
          <InvestEmpty actionLabel={t('inv_empty_cta')} onAction={() => setShowCreateMarket(true)} />
        ) : (
          <>
            {/* Market scope chips — hidden while there's only one market. */}
            {markets.length > 1 && (
              <div className="flex gap-2 items-center overflow-x-auto pb-1.5 -mx-1 px-1">
                <button
                  type="button"
                  onClick={() => setScopedMarketId(null)}
                  aria-pressed={!scopedMarketId}
                  className="m-pill shrink-0 min-h-[34px]"
                >
                  {t('inv_all_markets')}
                </button>
                {markets.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => setScopedMarketId(m.id === scopedMarketId ? null : m.id)}
                    aria-pressed={scopedMarketId === m.id}
                    className="m-pill shrink-0 min-h-[34px]"
                  >
                    <span aria-hidden="true" className={`w-1.5 h-1.5 rounded-full shrink-0 ${marketColorFor(m.id).dot}`} />
                    {m.name} · {m.currency}
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => setShowManage(true)}
                  aria-label={t('inv_manage_markets')}
                  className="m-pill shrink-0 w-[34px] h-[34px] min-h-[34px] p-0"
                >
                  <Glyph name="sliders" size={15} />
                </button>
              </div>
            )}
            {markets.length === 1 && (
              <div className="flex items-center justify-between gap-3">
                <p className="m-label flex items-center gap-1.5 min-w-0">
                  <span aria-hidden="true" className={`w-1.5 h-1.5 rounded-full shrink-0 ${marketColorFor(markets[0].id).dot}`} />
                  <span className="truncate">{markets[0].name} · {markets[0].currency}</span>
                </p>
                <button
                  type="button"
                  onClick={() => setShowManage(true)}
                  className="m-pill shrink-0 min-h-[34px] px-3 text-[11px]"
                >
                  <Glyph name="sliders" size={13} /> {t('inv_manage_markets')}
                </button>
              </div>
            )}

            {/* Bulk price update + unpriced hint, shown when useful. */}
            {open.length > 0 && (
              <div className="flex items-center gap-2.5 flex-wrap">
                <button
                  type="button"
                  onClick={() => setShowBulkPrices(true)}
                  className="m-key m-blue inline-flex items-center min-h-[34px] px-3.5 py-1.5 rounded-full text-[11px] font-semibold"
                >
                  {t('inv_update_prices')}
                </button>
                {unpricedOpen > 0 && (
                  <span className="m-chip m-chip-gold px-2.5 py-1 text-[11px]">
                    {t('inv_unpriced_chip').replace('{n}', String(unpricedOpen))}
                  </span>
                )}
              </div>
            )}

            {trades.length === 0 ? (
              <InvestEmpty
                actionLabel={t('inv_first_trade_cta')}
                onAction={() => openRecord(scopedMarket ? { marketId: scopedMarket.id } : null)}
              />
            ) : (
              <>
                {open.length > 0 && <div className="space-y-2.5">{open.map(renderHolding)}</div>}
                {open.length === 0 && closed.length > 0 && (
                  <p className="text-[12px] text-ink-600 text-center py-2">{t('inv_position_closed')}</p>
                )}
                {closed.length > 0 && (
                  <div className="pt-1.5">
                    <button
                      type="button"
                      onClick={() => setShowClosed(!showClosed)}
                      aria-expanded={showClosed}
                      className="w-full min-h-[44px] flex items-center justify-between px-1"
                    >
                      <span className="m-label">
                        {t('inv_closed_positions')} · {closed.length}
                      </span>
                      <Glyph name={showClosed ? 'chevron-down' : 'chevron-right'} size={14} className="text-ink-400" />
                    </button>
                    {showClosed && <div className="space-y-2.5 mt-1.5">{closed.map(renderHolding)}</div>}
                  </div>
                )}
              </>
            )}
          </>
        )}
      </div>

      <RecordTradeModal open={showRecord} onClose={() => { setShowRecord(false); setRecordPreset(null); }} preset={recordPreset} />
      <CreateMarketModal open={showCreateMarket} onClose={() => setShowCreateMarket(false)} />
      <ManageMarketsSheet open={showManage} onClose={() => setShowManage(false)} />
      <UpdatePricesSheet
        open={showBulkPrices}
        onClose={() => setShowBulkPrices(false)}
        marketId={scopedMarketId}
      />
    </main>
  );
}

// Investments empty state. The CTA is the VIOLET one (the handoff's invest
// empty state; this is the record-a-trade flow).
function InvestEmpty({ actionLabel, onAction }: { actionLabel: string; onAction: () => void }) {
  const t = useT();
  return (
    <EmptyState
      icon={TrendingUp}
      clayIcon="analytics"
      tone="violet"
      title={t('inv_empty_title')}
      description={t('inv_empty_desc')}
      actionLabel={actionLabel}
      onAction={onAction}
      actionVariant="hero"
    />
  );
}
