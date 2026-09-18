// Record a Buy / Sell / Dividend. One bottom sheet with progressive
// disclosure (AddGroupExpenseModal precedent — no stepper): kind pills →
// market chips → symbol → numbers → settlement. The sell preview shows the
// realized P/L BEFORE saving and blocks overselling; the "held outside
// Hisaab" toggle records the trade without touching any account.
//
// 1d (redesign 2026-09-18): toned kind pills (Buy green · Sell coral ·
// Dividend violet), material market pills keyed by their colour dot, sunken
// input wells, tinted preview cards, and the violet save — this is the
// record-a-trade flow, the investments accent.

import { useEffect, useMemo, useState } from 'react';
import { Modal } from '../components/Modal';
import { Glyph } from '../components/Glyph';
import { AccountSelect } from '../components/AccountSelect';
import { CurrencyConversionCard } from '../components/CurrencyConversionCard';
import { ConfirmationSheet } from '../components/ConfirmationSheet';
import { CreateMarketModal } from './CreateMarketModal';
import { useInvestmentStore, holdingsFor } from '../stores/investmentStore';
import { useAccountStore } from '../stores/accountStore';
import { useTransactionStore } from '../stores/transactionStore';
import { useToast } from '../components/Toast';
import { useDiscardGuard } from '../lib/useDiscardGuard';
import { useSubmitGuard } from '../lib/useSubmitGuard';
import { computePosition, simulateTimeline, validateTradeInput } from '../lib/investmentMath';
import { localIso } from '../lib/localDate';
import { marketColorFor } from '../lib/marketColors';
import { rateIsSane } from '../lib/conversionMath';
import { formatMoney } from '../lib/constants';
import { currencyMeta } from '../lib/design-tokens';
import { useT } from '../lib/i18n';
import type { InvestmentTradeKind } from '../db';

export interface RecordTradePreset {
  kind?: InvestmentTradeKind;
  marketId?: string;
  symbol?: string;
  lockSymbol?: boolean;
}

interface Props {
  open: boolean;
  onClose: () => void;
  preset?: RecordTradePreset | null;
}

const round2 = (x: number) => Math.round(x * 100) / 100;

export function RecordTradeModal({ open, onClose, preset }: Props) {
  const markets = useInvestmentStore((s) => s.markets);
  const trades = useInvestmentStore((s) => s.trades);
  const prices = useInvestmentStore((s) => s.prices);
  const recordOutsideTrade = useInvestmentStore((s) => s.recordOutsideTrade);
  const tradesForSymbol = useInvestmentStore((s) => s.tradesForSymbol);
  const accounts = useAccountStore((s) => s.accounts);
  const processTransaction = useTransactionStore((s) => s.processTransaction);
  const toast = useToast();
  const t = useT();
  const guardClose = useDiscardGuard();
  const submitGuard = useSubmitGuard();

  const [kind, setKind] = useState<InvestmentTradeKind>('buy');
  const [marketId, setMarketId] = useState('');
  const [symbolText, setSymbolText] = useState('');
  const [symbolPicked, setSymbolPicked] = useState(false);
  const [qty, setQty] = useState('');
  const [price, setPrice] = useState('');
  const [dividendAmount, setDividendAmount] = useState('');
  const [fees, setFees] = useState('');
  const [tradedAt, setTradedAt] = useState('');
  const [notes, setNotes] = useState('');
  const [outside, setOutside] = useState(false);
  const [accountId, setAccountId] = useState('');
  const [conversionRate, setConversionRate] = useState('');
  const [saving, setSaving] = useState(false);
  const [showCreateMarket, setShowCreateMarket] = useState(false);
  const [showConfirmation, setShowConfirmation] = useState(false);
  const [confirmData, setConfirmData] = useState<{
    title: string;
    description: string;
    changes: Array<{ accountName: string; currency: string; before: number; after: number }>;
    route?: string;
  }>({ title: '', description: '', changes: [] });

  useEffect(() => {
    if (!open) return;
    setKind(preset?.kind ?? 'buy');
    setMarketId(preset?.marketId ?? (markets.length === 1 ? markets[0].id : ''));
    setSymbolText(preset?.symbol ?? '');
    setSymbolPicked(!!preset?.symbol);
    setQty('');
    setPrice('');
    setDividendAmount('');
    setFees('');
    setTradedAt(localIso(new Date()));
    setNotes('');
    // No accounts at all → this can only be an outside-Hisaab record.
    setOutside(accounts.length === 0);
    setAccountId('');
    setConversionRate('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, preset]);

  const market = markets.find((m) => m.id === marketId) ?? null;
  const symbol = symbolText.trim().toUpperCase();

  // Holdings in the chosen market — the symbol autocomplete source. Sells
  // and dividends must reference an existing holding (sells: qty > 0).
  const marketHoldings = useMemo(
    () => (market ? holdingsFor(market.id, trades, prices) : []),
    [market, trades, prices],
  );
  const suggestions = useMemo(() => {
    if (!market || preset?.lockSymbol) return [];
    const pool = kind === 'buy' ? marketHoldings : kind === 'sell'
      ? marketHoldings.filter((h) => h.position.quantity > 0)
      : marketHoldings;
    const q = symbol;
    const matches = q ? pool.filter((h) => h.symbol.includes(q)) : pool;
    return matches.slice(0, 6);
  }, [market, marketHoldings, kind, symbol, preset?.lockSymbol]);
  const symbolIsExisting = marketHoldings.some((h) => h.symbol === symbol);
  // Buys accept free-text new symbols; sells/dividends need an existing one.
  const symbolValid = !!symbol && (kind === 'buy' || symbolIsExisting);

  const position = useMemo(() => {
    if (!market || !symbol) return null;
    const list = tradesForSymbol(market.id, symbol);
    return list.length ? computePosition(list) : null;
  }, [market, symbol, tradesForSymbol, trades]); // eslint-disable-line react-hooks/exhaustive-deps

  const qtyNum = parseFloat(qty) || 0;
  const priceNum = parseFloat(price) || 0;
  const feesNum = parseFloat(fees) || 0;
  const dividendNum = parseFloat(dividendAmount) || 0;
  const gross = round2(qtyNum * priceNum);
  // Cash that moves, in market currency.
  const cashAmount = kind === 'buy' ? round2(gross + feesNum)
    : kind === 'sell' ? round2(gross - feesNum)
    : round2(dividendNum - feesNum);

  // Sell preview: realized P/L at avg cost, shown before saving.
  const sellPreview = useMemo(() => {
    if (kind !== 'sell' || !position || qtyNum <= 0) return null;
    if (qtyNum > position.quantity + 1e-9) return { oversell: true as const, held: position.quantity };
    const realized = round2(qtyNum * (priceNum - position.avgCost) - feesNum);
    return { oversell: false as const, held: position.quantity, realized };
  }, [kind, position, qtyNum, priceNum, feesNum]);

  const account = accounts.find((a) => a.id === accountId) ?? null;
  const isCrossCurrency = !outside && !!account && !!market && account.currency !== market.currency;

  const validationMsg = useMemo(() => {
    if (!market || !symbolValid) return null;
    return validateTradeInput({
      kind,
      quantity: kind === 'dividend' ? 0 : qtyNum,
      pricePerUnit: kind === 'dividend' ? 0 : priceNum,
      amount: kind === 'dividend' ? dividendNum : 0,
      fees: feesNum,
    });
  }, [market, symbolValid, kind, qtyNum, priceNum, dividendNum, feesNum]);

  const canSave = (() => {
    if (!market || !symbolValid || saving) return false;
    if (validationMsg) return false;
    if (kind !== 'dividend' && (qtyNum <= 0 || priceNum < 0)) return false;
    if (kind === 'dividend' && dividendNum <= 0) return false;
    if (sellPreview?.oversell) return false;
    if (!outside) {
      if (!accountId) return false;
      // A rate matters only when cash actually moves — a zero-cash entry
      // (e.g. bonus shares at price 0) needs no conversion.
      if (isCrossCurrency && cashAmount > 0 && !rateIsSane(parseFloat(conversionRate))) return false;
    }
    return true;
  })();

  const isDirty = !!symbolText.trim() || !!qty || !!price || !!dividendAmount;

  const handleClose = () => onClose();

  // Ref-backed entry re-check (audit F-8/D-1): the `saving` STATE flag is
  // updated asynchronously, so two taps in one frame both read it as false.
  // `saving` stays for the disabled/label UI; the ref is the real guard.
  const handleSave = () => submitGuard.run(runSave);

  const runSave = async () => {
    if (!canSave || !market) return;
    // Captured BEFORE the save so "first trade ever" is detected correctly.
    const isFirstTradeEver = trades.length === 0;
    setSaving(true);
    try {
      const tradedAtIso = tradedAt ? new Date(`${tradedAt}T12:00:00`).toISOString() : undefined;
      const changes: Array<{ accountName: string; currency: string; before: number; after: number }> = [];

      if (outside) {
        // Ledger-only: no account, no transaction, no balance change.
        const check = kind === 'sell' && position
          ? simulateTimeline(tradesForSymbol(market.id, symbol), {
              add: {
                id: 'candidate', kind, quantity: qtyNum, pricePerUnit: priceNum, amount: 0,
                fees: feesNum, tradedAt: tradedAtIso ?? new Date().toISOString(),
                createdAt: new Date().toISOString(),
              },
            })
          : { ok: true as const };
        if (!check.ok) throw new Error(t('inv_sell_too_many').replace('{qty}', String(check.violation.heldQty)));
        await recordOutsideTrade({
          marketId: market.id,
          symbol,
          kind,
          quantity: kind === 'dividend' ? 0 : qtyNum,
          pricePerUnit: kind === 'dividend' ? 0 : priceNum,
          amount: kind === 'dividend' ? dividendNum : 0,
          fees: feesNum,
          tradedAt: tradedAtIso,
          notes,
        });
      } else {
        const rate = isCrossCurrency && cashAmount > 0 ? parseFloat(conversionRate) : undefined;
        if (kind === 'buy') {
          const before = account!.balance;
          const deduct = rate ? round2(cashAmount / rate) : cashAmount;
          changes.push({ accountName: account!.name, currency: account!.currency, before, after: round2(before - deduct) });
          await processTransaction({
            type: 'investment_buy', amount: 0, marketId: market.id, symbol,
            quantity: qtyNum, pricePerUnit: priceNum, fees: feesNum,
            sourceAccountId: accountId, conversionRate: rate,
            tradedAt: tradedAtIso, notes,
          });
        } else if (kind === 'sell') {
          const before = account!.balance;
          const credit = rate ? round2(cashAmount * rate) : cashAmount;
          changes.push({ accountName: account!.name, currency: account!.currency, before, after: round2(before + credit) });
          await processTransaction({
            type: 'investment_sell', amount: 0, marketId: market.id, symbol,
            quantity: qtyNum, pricePerUnit: priceNum, fees: feesNum,
            destinationAccountId: accountId, conversionRate: rate,
            tradedAt: tradedAtIso, notes,
          });
        } else {
          const before = account!.balance;
          const credit = rate ? round2(cashAmount * rate) : cashAmount;
          changes.push({ accountName: account!.name, currency: account!.currency, before, after: round2(before + credit) });
          await processTransaction({
            type: 'investment_dividend', amount: 0, marketId: market.id, symbol,
            grossAmount: dividendNum, fees: feesNum,
            destinationAccountId: accountId, conversionRate: rate,
            tradedAt: tradedAtIso, notes,
          });
        }
      }

      // Celebrate the moment — small interactions keep tracking a habit.
      // First trade ever gets the big cheer; profitable sells get their win
      // acknowledged; a loss gets an honest, encouraging note instead.
      const soldAtProfit = kind === 'sell' && sellPreview && !sellPreview.oversell && sellPreview.realized >= 0;
      const soldAtLoss = kind === 'sell' && sellPreview && !sellPreview.oversell && sellPreview.realized < 0;
      const title = isFirstTradeEver
        ? t('inv_cheer_first_trade')
        : kind === 'buy'
          ? t('inv_cheer_buy')
          : kind === 'dividend'
            ? t('inv_cheer_dividend')
            : soldAtProfit
              ? t('inv_cheer_sell_profit').replace('{amount}', formatMoney(sellPreview.realized, market.currency))
              : t('inv_trade_saved_sell');
      const facts = kind === 'dividend'
        ? `${symbol} — ${formatMoney(cashAmount, market.currency)}`
        : `${qtyNum} ${symbol} @ ${priceNum} — ${formatMoney(cashAmount, market.currency)}${
            kind === 'sell' && sellPreview && !sellPreview.oversell
              ? ` · ${t('inv_realized_preview')}: ${formatMoney(sellPreview.realized, market.currency)}`
              : ''
          }`;
      const description = `${facts}${soldAtLoss ? ` ${t('inv_cheer_sell_loss')}` : ''}${
        isFirstTradeEver ? ` ${t('inv_cheer_first_trade_guide')}` : ''
      }`;
      setConfirmData({
        title,
        description,
        changes,
        route: `/investment/${market.id}/${encodeURIComponent(symbol)}`,
      });
      setShowConfirmation(true);
    } catch (err) {
      toast.show({ type: 'error', title: t('error'), subtitle: err instanceof Error ? err.message : t('toast_error_generic') });
    } finally {
      setSaving(false);
    }
  };

  // The sunken 1d well (index.css .input-field — field-border edge, violet focus).
  const inputClass = 'input-field';

  // Toned pills: tinted at rest, solid when pressed (the Loans-tab vocabulary).
  // Buy / Sell keep the trading convention the old emerald / rose pills had.
  const KINDS: { value: InvestmentTradeKind; label: string; tone: string }[] = [
    { value: 'buy', label: t('inv_buy'), tone: 'm-pill-receive' },
    { value: 'sell', label: t('inv_sell'), tone: 'm-pill-pay' },
    { value: 'dividend', label: t('inv_dividend'), tone: 'm-pill-violet' },
  ];

  return (
    <>
      <Modal
        open={open && !showCreateMarket}
        onClose={handleClose}
        confirmClose={() => guardClose(isDirty)}
        title={t('inv_record_trade')}
        footer={
          <button
            onClick={handleSave}
            disabled={!canSave}
            className="m-btn m-btn-violet w-full py-3.5 text-[14px]"
          >
            {saving ? t('quick_processing') : `${t('quick_save')} ✓`}
          </button>
        }
      >
        <div className="space-y-4">
          {/* Kind pills */}
          <div className="grid grid-cols-3 gap-2">
            {KINDS.map((k) => (
              <button
                key={k.value}
                type="button"
                onClick={() => {
                  setKind(k.value);
                  // Buy and sell use OPPOSITE rate semantics (divide vs
                  // multiply) — a rate typed for one kind must never
                  // silently carry into the other.
                  setConversionRate('');
                }}
                aria-pressed={kind === k.value}
                className={`m-pill ${k.tone} min-h-[44px] text-[13px]`}
              >
                {k.label}
              </button>
            ))}
          </div>

          {/* Market chips — the coloured dot keys each market. */}
          <div>
            <label className="form-label">
              {t('inv_market_name')}
            </label>
            <div className="flex gap-2 flex-wrap">
              {markets.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => { setMarketId(m.id); setConversionRate(''); }}
                  aria-pressed={marketId === m.id}
                  className="m-pill min-h-[40px] text-[12px]"
                >
                  <span aria-hidden="true" className={`w-1.5 h-1.5 rounded-full shrink-0 ${marketColorFor(m.id).dot}`} />
                  {currencyMeta[m.currency]?.flag} {m.name} · {m.currency}
                </button>
              ))}
              <button
                type="button"
                onClick={() => setShowCreateMarket(true)}
                className="m-pill min-h-[40px] text-[12px] text-iris-text"
              >
                <Glyph name="plus" size={12} strokeWidth={3} /> {t('inv_new_market')}
              </button>
            </div>
          </div>

          {/* Symbol */}
          {market && (
            <div>
              <label className="form-label">
                {t('inv_symbol')}
              </label>
              {preset?.lockSymbol ? (
                // Locked by the holding page: a read-only well with a lock.
                <div className="m-inset flex items-center gap-2.5 px-4 py-3">
                  <Glyph name="lock" size={14} className="text-ink-400" />
                  <p className="text-[14px] font-semibold text-ink-900">{symbol}</p>
                </div>
              ) : (
                <>
                  <input
                    value={symbolText}
                    onChange={(e) => { setSymbolText(e.target.value.toUpperCase()); setSymbolPicked(false); }}
                    placeholder={t('inv_symbol_ph')}
                    className={`${inputClass} uppercase`}
                  />
                  {!symbolPicked && suggestions.length > 0 && (
                    <div className="m-card mt-2.5 overflow-hidden divide-y divide-cream-hairline">
                      {suggestions.map((h) => (
                        <button
                          key={`${h.marketId}:${h.symbol}`}
                          type="button"
                          onClick={() => { setSymbolText(h.symbol); setSymbolPicked(true); }}
                          className="row-base row-interactive w-full justify-between min-h-[44px] px-4 py-2.5"
                        >
                          <span className="text-[13px] font-semibold text-ink-900">{h.symbol}</span>
                          <span className="text-[11px] text-ink-600 tabular-nums">
                            {h.position.quantity > 0
                              ? t('inv_you_hold')
                                  .replace('{qty}', String(h.position.quantity))
                                  .replace('{price}', formatMoney(h.position.avgCost, market.currency))
                              : t('inv_position_closed')}
                          </span>
                        </button>
                      ))}
                    </div>
                  )}
                  {kind === 'buy' && symbol && !symbolIsExisting && (
                    <p className="text-[11px] text-iris-text mt-1.5">
                      {t('inv_new_symbol_hint').replace('{market}', market.name)}
                    </p>
                  )}
                  {kind !== 'buy' && symbol && !symbolIsExisting && (
                    <p className="text-[11px] text-ink-600 mt-1.5">
                      {kind === 'sell' ? t('inv_sell_too_many').replace('{qty}', '0') : t('inv_holding_not_found')}
                    </p>
                  )}
                </>
              )}
              {position && position.quantity > 0 && (
                <p className="text-[11px] text-ink-600 mt-1.5 tabular-nums">
                  {t('inv_you_hold')
                    .replace('{qty}', String(position.quantity))
                    .replace('{price}', formatMoney(position.avgCost, market.currency))}
                </p>
              )}
            </div>
          )}

          {/* Numbers */}
          {market && symbolValid && (
            <>
              {kind !== 'dividend' ? (
                <div>
                  <div className="grid grid-cols-2 gap-2.5">
                    <div>
                      <label className="form-label">
                        {t('inv_qty')}
                      </label>
                      <input type="number" inputMode="decimal" min="0" step="any" value={qty}
                        onChange={(e) => setQty(e.target.value)} placeholder="500" className={inputClass} />
                    </div>
                    <div>
                      <label className="form-label">
                        {t('inv_price_per_unit')}
                      </label>
                      <input type="number" inputMode="decimal" min="0" step="any" value={price}
                        onChange={(e) => setPrice(e.target.value)} placeholder="2.36" className={inputClass} />
                    </div>
                  </div>
                  {qtyNum > 0 && priceNum > 0 && (
                    <p className="text-[11.5px] text-ink-600 mt-2 tabular-nums">
                      {qtyNum.toLocaleString()} × {priceNum.toLocaleString()} = {formatMoney(gross, market.currency)}
                    </p>
                  )}
                </div>
              ) : (
                <div>
                  <label className="form-label">
                    {t('inv_dividend_amount')} ({market.currency})
                  </label>
                  <input type="number" inputMode="decimal" min="0" step="any" value={dividendAmount}
                    onChange={(e) => setDividendAmount(e.target.value)} placeholder="1000" className={inputClass} />
                </div>
              )}

              <div className="grid grid-cols-2 gap-2.5">
                <div>
                  <label className="form-label">
                    {kind === 'dividend' ? t('inv_fees_dividend') : t('inv_fees')}
                  </label>
                  <input type="number" inputMode="decimal" min="0" step="any" value={fees}
                    onChange={(e) => setFees(e.target.value)} placeholder="0" className={inputClass} />
                </div>
                <div>
                  <label className="form-label">
                    {t('inv_trade_date')}
                  </label>
                  <input type="date" value={tradedAt} onChange={(e) => setTradedAt(e.target.value)} className={inputClass} />
                </div>
              </div>

              {validationMsg && (
                <p className="m-card m-coral px-3.5 py-2.5 text-[11.5px] font-semibold leading-relaxed text-pay-text">
                  {validationMsg}
                </p>
              )}

              {/* Total line */}
              {cashAmount > 0 && !validationMsg && (
                <div className="m-card p-3.5 flex items-baseline justify-between gap-3">
                  <span className="m-label">
                    {kind === 'buy' ? t('inv_total_cost') : t('inv_total_proceeds')}
                  </span>
                  <span className="text-[17px] font-semibold text-ink-900 tabular-nums tracking-[-0.02em]">
                    {formatMoney(cashAmount, market.currency)}
                  </span>
                </div>
              )}

              {/* Sell preview / oversell block */}
              {kind === 'sell' && sellPreview && (
                sellPreview.oversell ? (
                  <p className="m-card m-coral px-3.5 py-2.5 text-[11.5px] font-semibold leading-relaxed text-pay-text">
                    {t('inv_sell_too_many').replace('{qty}', String(sellPreview.held))}
                  </p>
                ) : qtyNum > 0 && priceNum > 0 ? (
                  // Tinted stat card (Home's recipe): the label wears the
                  // tint, the figure stays ink; the sign is written out
                  // because formatMoney prints the magnitude only.
                  <div className={`m-card p-3.5 ${sellPreview.realized >= 0 ? 'm-mint' : 'm-coral'}`}>
                    <p className={`m-label ${sellPreview.realized >= 0 ? 'text-receive-text' : 'text-pay-text'}`}>
                      {t('inv_realized_preview')}
                    </p>
                    <p className="text-[17px] font-semibold text-ink-900 tabular-nums tracking-[-0.02em] mt-1">
                      {sellPreview.realized >= 0 ? '+' : '−'}{formatMoney(sellPreview.realized, market.currency)}
                    </p>
                  </div>
                ) : null
              )}

              {/* Settlement */}
              <div>
                <label className="form-label">
                  {kind === 'buy' ? t('inv_paid_from') : t('inv_received_into')}
                </label>
                {/* On/off, so it is a switch: the whole row toggles it. */}
                <button
                  type="button"
                  role="switch"
                  aria-checked={outside}
                  onClick={() => setOutside(!outside)}
                  className="selector-base gap-3 mb-2.5"
                >
                  <span className="text-[12.5px] font-semibold text-ink-800">{t('inv_outside_toggle')}</span>
                  <span aria-hidden="true" className={`m-switch ${outside ? 'is-on' : ''}`} />
                </button>
                {!outside && accounts.length === 0 && (
                  <p className="m-card px-3.5 py-3 text-[11.5px] text-ink-600 leading-relaxed">
                    {t('acct_need_for_tx')}
                  </p>
                )}
                {!outside && (
                  <AccountSelect
                    accounts={accounts}
                    selectedId={accountId}
                    onSelect={(id) => { setAccountId(id); setConversionRate(''); }}
                  />
                )}
              </div>

              {/* Cross-currency conversion */}
              {isCrossCurrency && cashAmount > 0 && (
                <CurrencyConversionCard
                  knownAmount={cashAmount}
                  knownCurrency={market.currency}
                  otherCurrency={account!.currency}
                  otherSide={kind === 'buy' ? 'paying' : 'receiving'}
                  rateSemantics={kind === 'buy' ? 'known-per-other' : 'other-per-known'}
                  rate={conversionRate}
                  onRateChange={setConversionRate}
                />
              )}

              <div>
                <label className="form-label">{t('quick_note')}</label>
                <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder={t('quick_note_placeholder')} className={inputClass} />
              </div>
            </>
          )}
        </div>
      </Modal>

      <CreateMarketModal
        open={showCreateMarket}
        onClose={() => setShowCreateMarket(false)}
        onCreated={(m) => setMarketId(m.id)}
      />
      <ConfirmationSheet
        open={showConfirmation}
        onClose={() => { setShowConfirmation(false); onClose(); }}
        title={confirmData.title}
        description={confirmData.description}
        balanceChanges={confirmData.changes}
        viewRoute={confirmData.route}
      />
    </>
  );
}
