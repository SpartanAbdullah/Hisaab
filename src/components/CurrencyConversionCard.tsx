// Cross-currency conversion, redesigned around what users actually know:
// not the exchange rate, but what they sent and what landed on the other
// side. The primary input is the OTHER side's amount; the rate is derived
// and shown in both directions so there is nothing to get backwards. Typing
// a rate directly is still possible ("Enter rate instead") with an explicit
// direction flip — the component converts whatever the user expresses into
// the rate semantic the calling store math expects, so a label/math
// direction mismatch can never corrupt balances again.

import { useEffect, useMemo, useState } from 'react';
import { Glyph } from './Glyph';
import { deriveRate, invertRate, formatRate, rateIsSane } from '../lib/conversionMath';
import { formatMoney } from '../lib/constants';
import { useT } from '../lib/i18n';

interface Props {
  /** The amount the user already typed, in `knownCurrency`. */
  knownAmount: number;
  knownCurrency: string;
  otherCurrency: string;
  /** Whether the other side is money arriving or money leaving — copy only. */
  otherSide: 'receiving' | 'paying';
  /**
   * The rate direction the caller's store math expects:
   * 'other-per-known'  → store computes otherAmount = knownAmount * rate
   * 'known-per-other'  → store computes otherAmount = knownAmount / rate
   */
  rateSemantics: 'other-per-known' | 'known-per-other';
  /** The caller's conversionRate string state (in the caller's semantic). */
  rate: string;
  onRateChange: (rate: string) => void;
}

export function CurrencyConversionCard({
  knownAmount,
  knownCurrency,
  otherCurrency,
  otherSide,
  rateSemantics,
  rate,
  onRateChange,
}: Props) {
  const t = useT();
  const [mode, setMode] = useState<'amount' | 'rate'>('amount');
  const [otherText, setOtherText] = useState('');
  // Direction the user is expressing a manual rate in. 'forward' reads
  // "1 known = N other" — the natural direction for AED→PKR movers.
  const [rateDir, setRateDir] = useState<'forward' | 'inverse'>('forward');
  const [rateText, setRateText] = useState('');

  // "1 known = N other" — the human-facing rate, independent of the store
  // semantic. Everything displayed is based on this.
  const forwardRate = useMemo(() => {
    const r = parseFloat(rate);
    if (!Number.isFinite(r) || r <= 0) return null;
    return rateSemantics === 'other-per-known' ? r : 1 / r;
  }, [rate, rateSemantics]);

  const emitForwardRate = (fwd: number | null) => {
    if (fwd === null) { onRateChange(''); return; }
    const semantic = rateSemantics === 'other-per-known' ? fwd : 1 / fwd;
    onRateChange(String(semantic));
  };

  // Amount mode: the other-side amount is the source of truth. Re-derive the
  // rate when it — or the known amount — changes, so editing the main amount
  // after filling this card keeps the pair consistent.
  useEffect(() => {
    if (mode !== 'amount') return;
    const other = parseFloat(otherText);
    emitForwardRate(deriveRate(knownAmount, other));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, otherText, knownAmount]);

  const otherAmount = forwardRate !== null ? Math.round(knownAmount * forwardRate * 100) / 100 : null;
  const inverse = forwardRate !== null ? invertRate(forwardRate) : null;
  const otherParsed = parseFloat(otherText);
  const amountEntered = otherText.trim() !== '' && Number.isFinite(otherParsed) && otherParsed > 0;
  const amountOutOfRange = mode === 'amount' && amountEntered && forwardRate === null;

  const semanticRateParsed = parseFloat(rate);
  const rateEntered = rateText.trim() !== '';
  const rateInvalid =
    mode === 'rate' && rateEntered && (!Number.isFinite(semanticRateParsed) || !rateIsSane(semanticRateParsed));

  const askLabel = (otherSide === 'receiving' ? t('conv_ask_received') : t('conv_ask_paid'))
    .replace('{currency}', otherCurrency);

  const switchToRateMode = () => {
    setMode('rate');
    setRateDir('forward');
    setRateText(forwardRate !== null ? String(Math.round(forwardRate * 10000) / 10000) : '');
  };
  const switchToAmountMode = () => {
    setMode('amount');
    setOtherText(otherAmount !== null ? String(otherAmount) : '');
  };

  const handleRateText = (text: string, dir: 'forward' | 'inverse') => {
    setRateText(text);
    const v = parseFloat(text);
    if (!Number.isFinite(v) || v <= 0) { onRateChange(''); return; }
    emitForwardRate(dir === 'forward' ? v : (1 / v));
  };

  const flipRateDir = () => {
    const next = rateDir === 'forward' ? 'inverse' : 'forward';
    setRateDir(next);
    // Re-express the current rate in the new direction so the number the
    // user sees always matches the sentence around it.
    const current = next === 'forward' ? forwardRate : inverse;
    setRateText(current !== null ? String(Math.round(current * 1000000) / 1000000) : '');
  };

  const inputClass = 'input-field py-2.5 font-semibold tabular-nums';

  return (
    <div className="m-card m-blue p-4 space-y-3 animate-fade-in">
      <p className="text-[10.5px] font-semibold text-cobalt-text uppercase tracking-[0.12em]">{t('conv_title')}</p>

      {/* The move, stated as a sentence with no jargon: known side → other side. */}
      <div className="flex items-center gap-2">
        <div className="flex-1 min-w-0 bg-cream-card rounded-[14px] shadow-[inset_0_1px_0_var(--m-hi)] px-3 py-2.5">
          <p className="text-[9.5px] font-semibold text-ink-500 uppercase tracking-[0.12em]">
            {otherSide === 'receiving' ? t('conv_side_sending') : t('conv_side_paying_back')}
          </p>
          <p className="text-[15px] font-semibold text-ink-900 tabular-nums mt-0.5 truncate">
            {formatMoney(knownAmount, knownCurrency)}
          </p>
        </div>
        <Glyph name="arrow-right" size={15} tone="blue" />
        <div className="flex-1 min-w-0 bg-cream-card rounded-[14px] shadow-[inset_0_1px_0_var(--m-hi)] px-3 py-2.5">
          <p className="text-[9.5px] font-semibold text-ink-500 uppercase tracking-[0.12em]">
            {otherSide === 'receiving' ? t('conv_side_arrives') : t('conv_side_leaves')}
          </p>
          <p className="text-[15px] font-semibold text-ink-900 tabular-nums mt-0.5 truncate">
            {otherAmount !== null ? formatMoney(otherAmount, otherCurrency) : `— ${otherCurrency}`}
          </p>
        </div>
      </div>

      {mode === 'amount' ? (
        <div>
          <label className="block text-[11.5px] font-semibold text-ink-700 mb-1.5">{askLabel}</label>
          <div className="flex items-center gap-2">
            <input
              type="number"
              inputMode="decimal"
              min="0"
              value={otherText}
              onChange={(e) => setOtherText(e.target.value)}
              placeholder={t('conv_amount_placeholder')}
              className={inputClass}
              autoFocus
            />
            <span className="text-[12px] font-semibold text-ink-500 shrink-0">{otherCurrency}</span>
          </div>
          {amountOutOfRange && (
            <p className="mt-1.5 text-[11px] text-pay-text font-semibold leading-relaxed">{t('conv_amount_implausible')}</p>
          )}
        </div>
      ) : (
        <div>
          <div className="flex items-center gap-2">
            <span className="text-[12.5px] font-semibold text-ink-700 shrink-0 tabular-nums">
              1 {rateDir === 'forward' ? knownCurrency : otherCurrency} =
            </span>
            <input
              type="number"
              inputMode="decimal"
              min="0"
              step="any"
              value={rateText}
              onChange={(e) => handleRateText(e.target.value, rateDir)}
              placeholder={t('conv_rate_placeholder')}
              className={inputClass}
              autoFocus
            />
            <span className="text-[12px] font-semibold text-ink-500 shrink-0">
              {rateDir === 'forward' ? otherCurrency : knownCurrency}
            </span>
            <button
              type="button"
              onClick={flipRateDir}
              aria-label={t('conv_flip_direction')}
              className="m-ctl w-10 h-10 flex items-center justify-center shrink-0"
            >
              <Glyph name="swap" size={15} tone="blue" />
            </button>
          </div>
          {rateInvalid && (
            <p className="mt-1.5 text-[11px] text-pay-text font-semibold leading-relaxed">{t('conv_amount_implausible')}</p>
          )}
        </div>
      )}

      {/* Derived rate, both directions — nothing to get backwards. */}
      {forwardRate !== null && inverse !== null && (
        <p className="text-[11px] text-ink-600 tabular-nums leading-relaxed">
          1 {knownCurrency} ≈ {formatRate(forwardRate)} {otherCurrency} · 1 {otherCurrency} ≈ {formatRate(inverse)} {knownCurrency}
        </p>
      )}

      <button
        type="button"
        onClick={mode === 'amount' ? switchToRateMode : switchToAmountMode}
        className="text-[11.5px] font-semibold text-cobalt-text min-h-[32px] active:opacity-70 transition-opacity"
      >
        {mode === 'amount' ? t('conv_enter_rate_instead') : t('conv_enter_amount_instead')}
      </button>
    </div>
  );
}
