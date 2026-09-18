import { useMemo, useState } from 'react';
import { Modal } from '../components/Modal';
import { Glyph } from '../components/Glyph';
import { useDiscardGuard } from '../lib/useDiscardGuard';
import { useSubmitGuard } from '../lib/useSubmitGuard';
import { useGoalStore } from '../stores/goalStore';
import { useT } from '../lib/i18n';
import { type Currency } from '../db';
import { useAccountStore } from '../stores/accountStore';
import { CurrencyPicker } from '../components/CurrencyPicker';
import { getPrimaryCurrency } from '../lib/primaryCurrency';
import { localIso } from '../lib/localDate';

interface Props { open: boolean; onClose: () => void; }

// A goal is a simple set-aside tracker: a name + a target + (optionally) a
// deadline. Adding money just grows the saved bar — it does NOT move money
// between accounts, which keeps the model easy to grasp for new users. The old
// "link a savings account / internal" question was a no-op label and is gone.
export function AddGoalModal({ open, onClose }: Props) {
  const { createGoal } = useGoalStore();
  const t = useT();
  const guardClose = useDiscardGuard();
  const submitGuard = useSubmitGuard();

  const [title, setTitle] = useState('');
  const [targetAmount, setTargetAmount] = useState('');
  const [currency, setCurrency] = useState<Currency>(() => getPrimaryCurrency());
  // Ranks the CurrencyPicker's five inline chips from the currencies this
  // user already holds money in. accountStore is a global store that is
  // already loaded app-wide, so this subscribes to data in memory — no fetch.
  const accounts = useAccountStore((s) => s.accounts);
  const usedCurrencies = useMemo(() => [...new Set(accounts.map((a) => a.currency))], [accounts]);
  const [targetDate, setTargetDate] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const today = localIso(new Date());

  // Disable-until-valid: a name and a finite, positive target (a bare `!amt`
  // check lets negatives and "12abc" through).
  const parsedTarget = parseFloat(targetAmount);
  const targetValid = Number.isFinite(parsedTarget) && parsedTarget > 0;
  const canSubmit = !!title.trim() && targetValid;

  // preventDefault stays OUTSIDE the guard: a dropped second tap must still
  // not let the browser submit the form natively.
  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    return submitGuard.run(runSubmit);
  };

  const runSubmit = async () => {
    setError('');
    const amt = parseFloat(targetAmount);
    if (!title.trim()) { setError(t('val_need_name')); return; }
    if (!targetValid) { setError(t('val_need_amount')); return; }

    setSaving(true);
    try {
      await createGoal({
        title: title.trim(),
        targetAmount: amt,
        currency,
        targetDate: targetDate || null,
      });
      setTitle(''); setTargetAmount(''); setTargetDate('');
      onClose();
    } catch (err) { setError(err instanceof Error ? err.message : 'Failed'); }
    finally { setSaving(false); }
  };

  const isDirty = !!title.trim() || !!targetAmount.trim() || !!targetDate;

  return (
    <Modal open={open} onClose={onClose} title={t('goal_new')}
      confirmClose={() => guardClose(isDirty)}
      footer={
        <button type="submit" form="goal-form" disabled={saving || !canSubmit} className="cta-primary">
          {saving ? t('goal_creating') : t('goal_create')}
        </button>
      }
    >
      <form id="goal-form" onSubmit={handleSubmit} className="space-y-4">
        <div className="m-inset p-3.5 flex items-start gap-2.5">
          <Glyph name="savings" size={16} tone="green" className="mt-0.5" />
          <p className="text-[12px] text-ink-600 leading-relaxed">
            {t('goal_intro')}
          </p>
        </div>

        <div>
          <label className="form-label">{t('goal_name')}</label>
          <input value={title} onChange={e => setTitle(e.target.value)} placeholder={t('agm_title_placeholder')} className="input-field" required />
        </div>

        <div>
          <label className="form-label">{t('goal_target')}</label>
          <input type="number" step="0.01" value={targetAmount} onChange={e => setTargetAmount(e.target.value)} placeholder="0.00" className="input-field text-center text-lg font-bold tabular-nums" required />
        </div>

        <div>
          <label className="form-label">{t('common_currency')}</label>
          <CurrencyPicker
            value={currency}
            onChange={setCurrency}
            primary={getPrimaryCurrency()}
            used={usedCurrencies}
          />
        </div>

        <div>
          <label className="form-label">{t('goal_target_date')}</label>
          <input type="date" min={today} value={targetDate} onChange={e => setTargetDate(e.target.value)} className="input-field" />
          <p className="text-[11px] text-ink-500 mt-1.5 leading-relaxed">{t('goal_target_date_help')}</p>
        </div>

        {error && (
          <div className="m-card m-coral p-3 flex items-start gap-2" role="alert">
            <Glyph name="alert" size={15} tone="coral" className="mt-px" />
            <p className="text-[12px] text-pay-text font-semibold">{error}</p>
          </div>
        )}
      </form>
    </Modal>
  );
}
