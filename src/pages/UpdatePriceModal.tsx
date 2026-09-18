// Manual "last price" update for one holding — the only way prices move in
// v1 (offline-first, no market feeds). Stamps priceAsOf = now on save.

import { useEffect, useState } from 'react';
import { Modal } from '../components/Modal';
import { useInvestmentStore } from '../stores/investmentStore';
import { useToast } from '../components/Toast';
import { formatMoney } from '../lib/constants';
import { useT } from '../lib/i18n';
import { useSubmitGuard } from '../lib/useSubmitGuard';

interface Props {
  open: boolean;
  onClose: () => void;
  marketId: string;
  symbol: string;
  currency: string;
  currentPrice: number | null;
}

export function UpdatePriceModal({ open, onClose, marketId, symbol, currency, currentPrice }: Props) {
  const updatePrice = useInvestmentStore((s) => s.updatePrice);
  const toast = useToast();
  const t = useT();
  const submitGuard = useSubmitGuard();

  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) setText(currentPrice !== null ? String(currentPrice) : '');
  }, [open, currentPrice]);

  const parsed = parseFloat(text);
  const valid = Number.isFinite(parsed) && parsed > 0;

  // Ref-backed entry re-check (audit F-8/D-1): the `saving` STATE flag is
  // updated asynchronously, so two taps in one frame both read it as false.
  // `saving` stays for the disabled/label UI; the ref is the real guard.
  const handleSave = () => submitGuard.run(runSave);

  const runSave = async () => {
    if (!valid || saving) return;
    setSaving(true);
    try {
      await updatePrice(marketId, symbol, parsed);
      onClose();
    } catch (err) {
      toast.show({ type: 'error', title: t('error'), subtitle: err instanceof Error ? err.message : t('toast_error_generic') });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`${t('inv_update_price')} — ${symbol}`}
      footer={
        <button
          onClick={handleSave}
          disabled={!valid || saving}
          className="m-btn m-btn-primary w-full py-3.5 text-[14px]"
        >
          {saving ? t('quick_processing') : t('quick_save')}
        </button>
      }
    >
      <div>
        <label className="form-label">
          {t('inv_price_label')} ({currency})
        </label>
        <input
          type="number"
          inputMode="decimal"
          min="0"
          step="any"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={currentPrice !== null ? String(currentPrice) : 'e.g. 2.36'}
          autoFocus
          className="input-field font-semibold tabular-nums tracking-[-0.02em]"
          // Inline on purpose: index.css pins every <input> to 16px
          // (unlayered, the iOS zoom guard), which beats any font-size
          // utility — the price figure has to win here.
          style={{ fontSize: 20 }}
        />
        {currentPrice !== null && (
          <p className="text-[11px] text-ink-600 mt-2.5 tabular-nums">
            {t('inv_price_label')}: {formatMoney(currentPrice, currency)}
          </p>
        )}
      </div>
    </Modal>
  );
}
