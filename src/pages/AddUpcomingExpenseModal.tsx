import { useState } from 'react';
import { Modal } from '../components/Modal';
import { useDiscardGuard } from '../lib/useDiscardGuard';
import { useSubmitGuard } from '../lib/useSubmitGuard';
import { useAccountStore } from '../stores/accountStore';
import { useUpcomingExpenseStore } from '../stores/upcomingExpenseStore';
import { useToast } from '../components/Toast';
import { AccountSelect } from '../components/AccountSelect';
import { formatMoney } from '../lib/constants';
import { useT } from '../lib/i18n';
import { Glyph } from '../components/Glyph';
import { Tile3D } from '../components/Tile3D';
import type { Tint } from '../lib/material';
import type { Currency } from '../db';
import { localIso } from '../lib/localDate';

interface Props {
  open: boolean;
  onClose: () => void;
}

// Bill categories as glyph tiles — the same glyph + accent the Goals page's
// upcoming-bill rows use for each category.
const CATEGORIES: { value: string; glyph: string; tint: Tint }[] = [
  { value: 'Education', glyph: 'document', tint: 'sky' },
  { value: 'Medical', glyph: 'shield', tint: 'coral' },
  { value: 'Event', glyph: 'gift', tint: 'accent' },
  { value: 'Travel', glyph: 'globe', tint: 'sky' },
  { value: 'Rent', glyph: 'home', tint: 'gold' },
  { value: 'Utilities', glyph: 'flame', tint: 'gold' },
  { value: 'Other', glyph: 'more', tint: 'neutral' },
];

const REMINDER_DAYS = [3, 7, 14, 30];

export function AddUpcomingExpenseModal({ open, onClose }: Props) {
  const { accounts } = useAccountStore();
  const { createExpense } = useUpcomingExpenseStore();
  const toast = useToast();
  const t = useT();
  const guardClose = useDiscardGuard();
  const submitGuard = useSubmitGuard();

  const [step, setStep] = useState(0);
  const [title, setTitle] = useState('');
  const [category, setCategory] = useState('');
  const [amount, setAmount] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [accountId, setAccountId] = useState('');
  const [reminderDays, setReminderDays] = useState(7);
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);

  const selectedAccount = accounts.find(a => a.id === accountId);
  const isDirty = step > 0 || !!title.trim() || !!category || !!amount.trim() || !!dueDate || !!accountId || !!notes.trim();

  const reset = () => {
    setStep(0); setTitle(''); setCategory(''); setAmount(''); setDueDate('');
    setAccountId(''); setReminderDays(7); setNotes('');
  };

  const handleClose = () => { reset(); onClose(); };

  // Ref-backed entry re-check; `saving` state stays for the disabled/label UI.
  const handleSubmit = () => submitGuard.run(runSubmit);

  const runSubmit = async () => {
    setSaving(true);
    try {
      const currency: Currency = selectedAccount?.currency ?? 'AED';
      await createExpense({
        title: title.trim(),
        amount: parseFloat(amount),
        currency,
        dueDate,
        accountId,
        category,
        notes,
        reminderDaysBefore: reminderDays,
      });
      toast.show({ type: 'success', title: t('upcoming_create'), subtitle: `${title} — ${formatMoney(parseFloat(amount), currency)}` });
      reset();
      onClose();
    } catch (err) {
      toast.show({ type: 'error', title: t('error'), subtitle: err instanceof Error ? err.message : 'Failed' });
    } finally { setSaving(false); }
  };

  const stepTitles = [t('upcoming_name'), t('upcoming_amount'), t('upcoming_due'), t('upcoming_account')];

  const canNext = () => {
    if (step === 0) return title.trim().length > 0 && category.length > 0;
    if (step === 1) return parseFloat(amount) > 0;
    if (step === 2) return !!dueDate;
    if (step === 3) return !!accountId;
    return false;
  };

  const footer = step < 3 ? (
    <button
      onClick={() => setStep(s => s + 1)}
      disabled={!canNext()}
      className="m-btn m-btn-primary w-full py-4 text-[14px]"
    >
      {t('quick_next')}<Glyph name="arrow-right" size={16} strokeWidth={2.8} />
    </button>
  ) : (
    <div className="flex gap-2.5">
      <button onClick={() => setStep(s => s - 1)} className="m-btn m-btn-plain px-4" aria-label={t('back')}>
        <Glyph name="arrow-left" size={17} />
      </button>
      <button
        onClick={handleSubmit}
        disabled={saving || !canNext()}
        className="m-btn m-btn-primary flex-1 py-3.5 text-[14px]"
      >
        {saving ? t('upcoming_creating') : t('upcoming_create')}
      </button>
    </div>
  );

  return (
    <Modal open={open} onClose={handleClose} title={stepTitles[step]} footer={footer} confirmClose={() => guardClose(isDirty)}>
      {/* Step progress */}
      <div className="flex gap-1.5 mb-5" aria-hidden="true">
        {[0, 1, 2, 3].map(i => (
          <div key={i} className={`h-1.5 flex-1 rounded-full transition-all duration-300 ${i <= step ? 'bg-gradient-to-r from-accent-500 to-accent-600' : 'bg-accent-100'}`} />
        ))}
      </div>

      {/* Step 0: Title + Category */}
      {step === 0 && (
        <div className="space-y-4 animate-fade-in">
          <div>
            <label className="form-label">
              {t('upcoming_name')}
            </label>
            <input value={title} onChange={e => setTitle(e.target.value)}
              placeholder={t('auem_title_placeholder')}
              className="input-field" autoFocus />
          </div>

          <div>
            <label className="form-label">
              {t('category')}
            </label>
            <div className="grid grid-cols-3 gap-2.5">
              {CATEGORIES.map(cat => (
                <Tile3D
                  key={cat.value}
                  tint={cat.tint}
                  icon={cat.glyph}
                  iconPlacement="top"
                  iconSize="sm"
                  title={cat.value}
                  selected={category === cat.value}
                  onClick={() => setCategory(cat.value)}
                />
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Step 1: Amount */}
      {step === 1 && (
        <div className="space-y-4 animate-fade-in">
          <div className="text-center py-2">
            <div className="m-inset inline-flex items-center gap-2 rounded-xl px-3 py-1.5 mb-4">
              <span className="text-[11.5px] font-semibold text-ink-700">{title}</span>
              <span className="m-chip m-chip-neutral">{category}</span>
            </div>
          </div>
          <div>
            <label className="form-label">
              {t('upcoming_amount')}
            </label>
            <input type="number" step="0.01" value={amount} onChange={e => setAmount(e.target.value)}
              placeholder="0.00"
              className="input-field text-center text-2xl font-bold tabular-nums" autoFocus />
          </div>
          <button onClick={() => setStep(0)}
            className="w-full text-center text-[12px] text-ink-500 py-1 font-medium">{t('common_back_arrow')}</button>
        </div>
      )}

      {/* Step 2: Due Date */}
      {step === 2 && (
        <div className="space-y-4 animate-fade-in">
          <div className="text-center py-2">
            <p className="m-num m-num-violet text-[34px]">{parseFloat(amount || '0').toLocaleString()}</p>
            <p className="text-[11.5px] text-ink-600 mt-2.5">{title} · {category}</p>
          </div>
          <div>
            <label className="form-label">
              {t('upcoming_due')}
            </label>
            <input type="date" value={dueDate} onChange={e => setDueDate(e.target.value)}
              min={localIso(new Date())}
              className="input-field" autoFocus />
          </div>
          <button onClick={() => setStep(1)}
            className="w-full text-center text-[12px] text-ink-500 py-1 font-medium">{t('common_back_arrow')}</button>
        </div>
      )}

      {/* Step 3: Account + Reminder */}
      {step === 3 && (
        <div className="space-y-4 animate-fade-in">
          {/* Summary bar */}
          <div className="m-inset p-3.5 flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-[13.5px] font-semibold text-ink-900 truncate">{title}</p>
              <p className="text-[11px] text-ink-500 mt-0.5">{category} · {dueDate}</p>
            </div>
            <span className="font-semibold text-[16px] tabular-nums text-ink-900 shrink-0">{parseFloat(amount || '0').toLocaleString()}</span>
          </div>

          {/* Account selection */}
          <div>
            <label className="form-label">
              {t('upcoming_account')}
            </label>
            <AccountSelect accounts={accounts} selectedId={accountId} onSelect={setAccountId} />
          </div>

          {/* Reminder timing */}
          <div>
            <label className="form-label">
              {t('auem_reminder_label')}
            </label>
            <div className="flex gap-2 flex-wrap">
              {REMINDER_DAYS.map(days => (
                <button key={days} type="button" onClick={() => setReminderDays(days)}
                  aria-pressed={reminderDays === days}
                  className="m-pill"
                >{t('mv_days_before').replace('{n}', String(days))}</button>
              ))}
            </div>
          </div>

          {/* Notes */}
          <div>
            <label className="form-label">
              {t('quick_note')}
            </label>
            <input value={notes} onChange={e => setNotes(e.target.value)} placeholder={t('auem_notes_placeholder')}
              className="input-field" />
          </div>
        </div>
      )}
    </Modal>
  );
}
