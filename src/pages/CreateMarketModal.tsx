// Create an investment market (name + fixed currency). Seed chips prefill
// the common Gulf/Pakistan exchanges; anything can be typed free-form.

import { useMemo, useState } from 'react';
import { Modal } from '../components/Modal';
import { useInvestmentStore } from '../stores/investmentStore';
import { useToast } from '../components/Toast';
import { currencyMeta } from '../lib/design-tokens';
import { useT } from '../lib/i18n';
import { useSubmitGuard } from '../lib/useSubmitGuard';
import { type Currency, type InvestmentMarket } from '../db';
import { CurrencyPicker } from '../components/CurrencyPicker';
import { getPrimaryCurrency } from '../lib/primaryCurrency';

const SUGGESTIONS: { name: string; currency: Currency }[] = [
  { name: 'DFM', currency: 'AED' },
  { name: 'ADX', currency: 'AED' },
  { name: 'PSX', currency: 'PKR' },
];

interface Props {
  open: boolean;
  onClose: () => void;
  onCreated?: (market: InvestmentMarket) => void;
}

export function CreateMarketModal({ open, onClose, onCreated }: Props) {
  const createMarket = useInvestmentStore((s) => s.createMarket);
  const toast = useToast();
  const t = useT();
  const submitGuard = useSubmitGuard();

  const [name, setName] = useState('');
  const [currency, setCurrency] = useState<Currency>(() => getPrimaryCurrency());
  const [saving, setSaving] = useState(false);

  const handleClose = () => {
    setName('');
    setSaving(false);
    onClose();
  };

  const markets = useInvestmentStore((s) => s.markets);
  // Ranks the CurrencyPicker chips from the markets this user already tracks.
  const usedCurrencies = useMemo(() => [...new Set(markets.map((m) => m.currency))], [markets]);

  // Ref-backed entry re-check (audit F-8/D-1): the `saving` STATE flag is
  // updated asynchronously, so two taps in one frame both read it as false.
  // `saving` stays for the disabled/label UI; the ref is the real guard.
  const handleCreate = () => submitGuard.run(runCreate);

  const runCreate = async () => {
    if (!name.trim() || saving) return;
    const isFirstMarket = markets.length === 0;
    setSaving(true);
    try {
      const market = await createMarket({ name, currency });
      // A little encouragement + the obvious next step keeps momentum going.
      toast.show({
        type: 'success',
        title: isFirstMarket ? t('inv_cheer_first_market') : `${market.name} ✓`,
        subtitle: isFirstMarket ? t('inv_cheer_first_market_guide') : undefined,
      });
      onCreated?.(market);
      handleClose();
    } catch (err) {
      toast.show({ type: 'error', title: t('error'), subtitle: err instanceof Error ? err.message : t('toast_error_generic') });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title={t('inv_new_market')}
      footer={
        <button
          onClick={handleCreate}
          disabled={!name.trim() || saving}
          className="m-btn m-btn-primary w-full py-3.5 text-[14px]"
        >
          {saving ? t('quick_processing') : t('inv_empty_cta')}
        </button>
      }
    >
      <div className="space-y-4">
        <div>
          <label className="form-label">
            {t('inv_market_suggest')}
          </label>
          <div className="flex gap-2 flex-wrap">
            {SUGGESTIONS.map((s) => (
              <button
                key={s.name}
                type="button"
                onClick={() => { setName(s.name); setCurrency(s.currency); }}
                aria-pressed={name.trim().toUpperCase() === s.name}
                className="m-pill min-h-[40px] text-[12px]"
              >
                {currencyMeta[s.currency]?.flag} {s.name} · {s.currency}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className="form-label">
            {t('inv_market_name')}
          </label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('inv_market_name_ph')}
            className="input-field"
          />
        </div>

        <div>
          <label className="form-label">
            {t('inv_market_currency')}
          </label>
          <CurrencyPicker
            value={currency}
            onChange={setCurrency}
            primary={getPrimaryCurrency()}
            used={usedCurrencies}
          />
          <p className="text-[10.5px] text-ink-600 mt-2">{t('inv_market_currency_locked')}</p>
        </div>
      </div>
    </Modal>
  );
}
