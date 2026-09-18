import { useEffect, useState } from 'react';
import { Modal } from './Modal';
import { Glyph } from './Glyph';
import { useDiscardGuard } from '../lib/useDiscardGuard';
import { useSubmitGuard } from '../lib/useSubmitGuard';
import { useRecurringStore } from '../stores/recurringStore';
import { useAccountStore } from '../stores/accountStore';
import { useToast } from './Toast';
import { confirmDestructive } from './ConfirmDestructiveSheet';
import { EXPENSE_CATEGORIES, INCOME_CATEGORIES } from '../lib/constants';
import { useCategoryOptions, withCurrentValue } from '../lib/mergedCategories';
import { groupAccountsByType } from '../lib/accountGroups';
import { useT } from '../lib/i18n';
import { validateRecurringStart } from '../lib/recurringStartValidation';
import { localIso } from '../lib/localDate';
import type { RecurringCadence, RecurringTransaction } from '../db';

// Shared "add a recurring entry" modal. Used by the Subscription Tracker (with
// defaultCategory="Subscriptions" so subscriptions are the one-tap common case)
// and anywhere else recurring income/expenses are created. Pass `template` to
// open in EDIT mode — the form prefills from it and saving patches it in place
// (the store + DB already support full updates, so no delete-and-recreate).
interface AddRecurringModalProps {
  open: boolean;
  onClose: () => void;
  defaultCategory?: string;
  title?: string;
  template?: RecurringTransaction | null;
}

export function AddRecurringModal({ open, onClose, defaultCategory, title, template }: AddRecurringModalProps) {
  const createTemplate = useRecurringStore((s) => s.createTemplate);
  const updateTemplate = useRecurringStore((s) => s.updateTemplate);
  const accounts = useAccountStore((s) => s.accounts);
  const toast = useToast();
  const t = useT();
  const guardClose = useDiscardGuard();
  const submitGuard = useSubmitGuard();
  const isEdit = !!template;
  const seedCategory =
    defaultCategory && (EXPENSE_CATEGORIES as readonly string[]).includes(defaultCategory)
      ? defaultCategory
      : EXPENSE_CATEGORIES[0];
  const [type, setType] = useState<'income' | 'expense'>('expense');
  const [label, setLabel] = useState('');
  const [amount, setAmount] = useState('');
  const [accountId, setAccountId] = useState('');
  const [category, setCategory] = useState<string>(seedCategory);
  const [cadence, setCadence] = useState<RecurringCadence>('monthly');
  const [nextDueDate, setNextDueDate] = useState(() => localIso(new Date()));
  const [saving, setSaving] = useState(false);

  // The modal stays mounted across opens, so hydrate the form whenever it
  // opens: prefill from the template in edit mode, reset to defaults otherwise.
  useEffect(() => {
    if (!open) return;
    if (template) {
      setType(template.type === 'income' ? 'income' : 'expense');
      setLabel(template.label ?? '');
      setAmount(String(template.amount));
      setAccountId(template.sourceAccountId ?? template.destinationAccountId ?? '');
      setCategory(template.category);
      setCadence(template.cadence);
      setNextDueDate(template.nextDueDate);
    } else {
      setType('expense');
      setLabel('');
      setAmount('');
      setAccountId('');
      setCategory(seedCategory);
      setCadence('monthly');
      setNextDueDate(localIso(new Date()));
    }
  }, [open, template, seedCategory]);

  // Disable-until-valid: a positive amount and a chosen account (matches the
  // budget modal), so Save isn't a dead tap on an empty form.
  const canSave = (() => {
    const n = Number(amount);
    return Number.isFinite(n) && n > 0 && !!accountId;
  })();

  // Ref-backed entry re-check (audit F-8/D-1): the `saving` STATE flag is
  // updated asynchronously, so two taps in one frame both read it as false.
  // `saving` stays for the disabled/label UI; the ref is the real guard.
  const handleSave = () => submitGuard.run(runSave);

  const runSave = async () => {
    const numeric = Number(amount);
    if (!Number.isFinite(numeric) || numeric <= 0) {
      toast.show({ type: 'error', title: t('arm_err_amount') });
      return;
    }
    if (!accountId) {
      toast.show({ type: 'error', title: t('arm_err_pick_account') });
      return;
    }
    const account = accounts.find((a) => a.id === accountId);
    if (!account) {
      toast.show({ type: 'error', title: t('arm_err_no_account') });
      return;
    }
    // Only re-validate the start date when it actually changed — an existing
    // template whose date is already in the past shouldn't nag on every edit.
    const dateChanged = !template || nextDueDate !== template.nextDueDate;
    if (dateChanged) {
      const startCheck = validateRecurringStart(nextDueDate, localIso(new Date()));
      if (startCheck.severity === 'block') {
        toast.show({ type: 'error', title: t('arm_err_start_date'), subtitle: startCheck.reason });
        return;
      }
      if (startCheck.severity === 'warn') {
        const ok = await confirmDestructive({
          title: t('arm_past_start_title'),
          description: startCheck.reason ?? '',
          confirmLabel: t('arm_use_this_date'),
          cancelLabel: t('arm_change_date'),
          tone: 'warning',
        });
        if (!ok) return;
      }
    }
    setSaving(true);
    try {
      const payload = {
        type,
        amount: numeric,
        currency: account.currency,
        sourceAccountId: type === 'expense' ? accountId : null,
        destinationAccountId: type === 'income' ? accountId : null,
        category,
        notes: template?.notes ?? '',
        cadence,
        nextDueDate,
        label: label.trim(),
      };
      if (template) {
        await updateTemplate(template.id, payload);
        toast.show({ type: 'success', title: t('arm_updated') });
        onClose();
      } else {
        await createTemplate(payload);
        toast.show({ type: 'success', title: t('arm_saved') });
        onClose();
        setLabel('');
        setAmount('');
        setAccountId('');
      }
    } catch (err) {
      toast.show({
        type: 'error',
        title: t('arm_err_save'),
        subtitle: err instanceof Error ? err.message : 'Try again.',
      });
    } finally {
      setSaving(false);
    }
  };

  // Merged built-in + custom categories; keep the current value visible even
  // if it was a custom category later deleted (edit mode).
  const categoryList = withCurrentValue(useCategoryOptions(type), category);

  const isDirty = template
    ? label !== (template.label ?? '') ||
      amount !== String(template.amount) ||
      accountId !== (template.sourceAccountId ?? template.destinationAccountId ?? '') ||
      category !== template.category ||
      cadence !== template.cadence ||
      nextDueDate !== template.nextDueDate ||
      type !== (template.type === 'income' ? 'income' : 'expense')
    : !!label.trim() || !!amount.trim() || !!accountId;

  return (
    <Modal open={open} onClose={onClose} title={isEdit ? t('mv_arm_title_edit') : (title ?? t('mv_arm_title_new'))}
      confirmClose={() => guardClose(isDirty)}>
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-2.5">
          <button
            type="button"
            onClick={() => {
              setType('expense');
              setCategory(seedCategory);
            }}
            aria-pressed={type === 'expense'}
            className={`selector-base justify-center gap-2 text-[12.5px] font-semibold ${
              type === 'expense' ? 'selector-selected' : ''
            }`}
          >
            <Glyph name="arrow-up" size={15} tone="coral" />
            {t('arm_type_expense')}
          </button>
          <button
            type="button"
            onClick={() => {
              setType('income');
              setCategory(INCOME_CATEGORIES[0]);
            }}
            aria-pressed={type === 'income'}
            className={`selector-base justify-center gap-2 text-[12.5px] font-semibold ${
              type === 'income' ? 'selector-selected' : ''
            }`}
          >
            <Glyph name="arrow-down" size={15} tone="green" />
            {t('arm_type_income')}
          </button>
        </div>

        <div>
          <label className="form-label">{t('arm_label_optional')}</label>
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder={t('arm_label_placeholder')}
            className="input-field"
          />
        </div>

        <div>
          <label className="form-label">{t('arm_amount')}</label>
          <input
            type="number"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0"
            className="input-field tabular-nums"
          />
        </div>

        <div>
          <label className="form-label">{type === 'expense' ? t('quick_from') : t('quick_to')}</label>
          <select value={accountId} onChange={(e) => setAccountId(e.target.value)} className="input-field">
            <option value="">{t('arm_pick_account')}</option>
            {groupAccountsByType(accounts).map((g) => (
              <optgroup key={g.id} label={t(g.labelKey)}>
                {g.accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name} ({a.currency})
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </div>

        <div>
          <label className="form-label">{t('arm_category')}</label>
          <select value={category} onChange={(e) => setCategory(e.target.value)} className="input-field">
            {categoryList.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="form-label">{t('arm_repeats')}</label>
            <select
              value={cadence}
              onChange={(e) => setCadence(e.target.value as RecurringCadence)}
              className="input-field"
            >
              <option value="daily">{t('arm_daily')}</option>
              <option value="weekly">{t('arm_weekly')}</option>
              <option value="monthly">{t('arm_monthly')}</option>
              <option value="yearly">{t('arm_yearly')}</option>
            </select>
          </div>
          <div>
            <label className="form-label">{t('arm_next_due')}</label>
            <input
              type="date"
              value={nextDueDate}
              onChange={(e) => setNextDueDate(e.target.value)}
              className="input-field"
            />
          </div>
        </div>

        <button onClick={handleSave} disabled={saving || !canSave} className="cta-primary">
          {saving ? t('bud_saving') : isEdit ? t('mv_arm_update_cta') : t('common_save')}
        </button>
      </div>
    </Modal>
  );
}
