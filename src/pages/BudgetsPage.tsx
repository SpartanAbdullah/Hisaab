import { useCallback, useEffect, useMemo, useState } from 'react';
import { Wallet2 } from 'lucide-react';
import { PageHeader } from '../components/PageHeader';
import { EmptyState } from '../components/EmptyState';
import { Card3D } from '../components/Card3D';
import { Glyph } from '../components/Glyph';
import { PageErrorState } from '../components/PageErrorState';
import { ListSkeleton } from '../components/ListSkeleton';
import { Modal } from '../components/Modal';
import { useBudgetStore, computeBudgetUsages } from '../stores/budgetStore';
import { useTransactionStore } from '../stores/transactionStore';
import { useLoanStore } from '../stores/loanStore';
import { useEmiStore } from '../stores/emiStore';
import { useCommitteeStore } from '../stores/committeeStore';
import { useRecurringStore } from '../stores/recurringStore';
import { computeFlexBudget, FLEX_INCOME_KEY } from '../lib/flexBudget';
import { EXPENSE_CATEGORIES, formatMoney } from '../lib/constants';
import { useCategoryOptions } from '../lib/mergedCategories';
import { type Currency, type Budget } from '../db';
import { CurrencyPicker } from '../components/CurrencyPicker';
import { getPrimaryCurrency } from '../lib/primaryCurrency';
import { useToast } from '../components/Toast';
import { confirmDestructive } from '../components/ConfirmDestructiveSheet';
import { useAsyncLoad } from '../hooks/useAsyncLoad';
import { useT } from '../lib/i18n';

export function BudgetsPage() {
  const t = useT();
  const budgets = useBudgetStore((s) => s.budgets);
  const loadBudgets = useBudgetStore((s) => s.loadBudgets);
  const transactions = useTransactionStore((s) => s.transactions);
  const loadTransactions = useTransactionStore((s) => s.loadTransactions);
  // Flex-budget sources — raw slices only, filtering in useMemo (React #185).
  const loans = useLoanStore((s) => s.loans);
  const emiSchedules = useEmiStore((s) => s.schedules);
  const committees = useCommitteeStore((s) => s.committees);
  const templates = useRecurringStore((s) => s.templates);

  const [showAdd, setShowAdd] = useState(false);
  const [editing, setEditing] = useState<Budget | null>(null);

  const load = useCallback(async () => {
    const tasks: Promise<unknown>[] = [loadBudgets()];
    if (transactions.length === 0) tasks.push(loadTransactions());
    // Flex-budget sources: cheap reads, usually warm from app boot / Home.
    tasks.push(
      useLoanStore.getState().loadLoans(),
      useEmiStore.getState().loadSchedules(),
      useCommitteeStore.getState().loadAll(),
      useRecurringStore.getState().loadTemplates(),
    );
    await Promise.all(tasks);
  }, [loadBudgets, loadTransactions, transactions.length]);
  const { status: loadStatus, error: loadError, retry: retryLoad } = useAsyncLoad(load);

  // Recompute every time budgets or transactions change. Cheap; pure pass.
  const usages = useMemo(
    () => computeBudgetUsages(budgets, transactions),
    [budgets, transactions],
  );
  const overLimitCount = usages.filter((usage) => usage.overLimit).length;
  const overWarnCount = usages.filter((usage) => usage.overWarn && !usage.overLimit).length;

  // "Left to spend this month" up front — the envelope mental model. Budgets are
  // per-currency, so we total each currency separately (primary first) rather
  // than mixing them into one meaningless number.
  const primaryCurrency = getPrimaryCurrency();
  const leftSummary = useMemo(() => {
    const byCurrency = new Map<Currency, { budget: number; spent: number }>();
    for (const u of usages) {
      const entry = byCurrency.get(u.budget.currency) ?? { budget: 0, spent: 0 };
      entry.budget += u.budget.monthlyAmount;
      entry.spent += u.spent;
      byCurrency.set(u.budget.currency, entry);
    }
    return [...byCurrency.entries()]
      .map(([currency, v]) => ({ currency, budget: v.budget, spent: v.spent, left: v.budget - v.spent }))
      .sort((a, b) => (a.currency === primaryCurrency ? -1 : b.currency === primaryCurrency ? 1 : b.budget - a.budget));
  }, [usages, primaryCurrency]);

  // "Bacha kya hai?" — the one-number flex budget. Income is ENTERED (variable
  // income is the market norm); fixed commitments come from first-class objects:
  // EMIs, kameti rounds, recurring templates. Primary-currency scoped.
  const [flexIncome, setFlexIncome] = useState<number | null>(() => readFlexIncome(primaryCurrency));
  const [showIncomeModal, setShowIncomeModal] = useState(false);
  const [flexNow] = useState(() => new Date());
  const flex = useMemo(() => {
    if (flexIncome === null) return null;
    return computeFlexBudget({
      income: flexIncome,
      currency: primaryCurrency,
      loans,
      schedules: emiSchedules,
      committees,
      templates,
      transactions,
      today: flexNow,
    });
  }, [flexIncome, primaryCurrency, loans, emiSchedules, committees, templates, transactions, flexNow]);
  // Breakdown line without repeating the currency four times.
  const fmtN = (n: number) => Math.round(n).toLocaleString();
  const flexBreakdown = flex
    ? [
        `${t('flex_income_word')} ${fmtN(flex.income)}`,
        // Broad label: this bucket holds schedule-less udhaar repayments too,
        // so a bare "EMI" would claim something the user knows is false.
        ...(flex.fixedParts.emi > 0.005 ? [`${t('flex_part_emi')} −${fmtN(flex.fixedParts.emi)}`] : []),
        ...(flex.fixedParts.kameti > 0.005 ? [`${t('kameti_title')} −${fmtN(flex.fixedParts.kameti)}`] : []),
        ...(flex.fixedParts.recurring > 0.005 ? [`${t('flex_part_recurring')} −${fmtN(flex.fixedParts.recurring)}`] : []),
        `${t('flex_spent_word')} −${fmtN(flex.flexSpent)}`,
      ].join(' · ')
    : '';
  const flexBarColor = flex?.state === 'red'
    ? 'from-pay-600 to-pay-700'
    : flex?.state === 'yellow'
      ? 'from-warn-600 to-warn-700'
      : 'from-receive-600 to-receive-700';
  const flexBarPct = flex && flex.flexTotal > 0
    ? Math.min(100, Math.max(0, (flex.flexSpent / flex.flexTotal) * 100))
    : 100;

  const saveFlexIncome = (value: number | null) => {
    writeFlexIncome(primaryCurrency, value);
    setFlexIncome(value);
    setShowIncomeModal(false);
  };

  return (
    <main className="min-h-dvh bg-cream-bg pb-28">
      <PageHeader
        title={t('bud_title')}
        back
        action={
          <button
            onClick={() => setShowAdd(true)}
            aria-label={t('bud_a11y_add')}
            className="nav-icon-button"
          >
            <Glyph name="plus" size={16} strokeWidth={3} className="text-accent-text" />
          </button>
        }
      />

      <div className="px-5 pt-5 space-y-3">
        <p className="text-[12px] text-ink-600 leading-relaxed">
          {t('bud_intro')}
        </p>

        {loadStatus === 'error' && (
          <PageErrorState
            variant="inline"
            title={t('bud_err_load')}
            message={loadError ?? t('err_some_data_failed')}
            onRetry={retryLoad}
          />
        )}

        {loadStatus === 'ready' && usages.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            {overLimitCount > 0 && (
              <span className="m-chip m-chip-pay px-2.5 py-1 tabular-nums">
                <Glyph name="alert" size={11} strokeWidth={2.8} />
                {t('budget_over').replace('{n}', String(overLimitCount))}
              </span>
            )}
            {overWarnCount > 0 && (
              <span className="m-chip m-chip-gold px-2.5 py-1 tabular-nums">
                {t('budget_near').replace('{n}', String(overWarnCount))}
              </span>
            )}
            {overLimitCount === 0 && overWarnCount === 0 && (
              <span className="m-chip m-chip-receive px-2.5 py-1">
                <Glyph name="check" size={11} strokeWidth={3} />
                {t('budget_on_track')}
              </span>
            )}
          </div>
        )}

        {/* "Bacha kya hai?" — income − fixed commitments − free spending,
            one honest number with a traffic light. Setup state asks for
            income once; the pencil re-opens the editor. */}
        {loadStatus === 'ready' && (
          flex ? (
            // 3D clay tier 2. The tint follows the traffic light the card
            // already computes, so the surface says the same thing the number
            // says — never a green card over a red figure.
            <Card3D tint={flex.state === 'red' ? 'coral' : flex.state === 'yellow' ? 'gold' : 'mint'} padding="sm">
              <div className="flex items-center justify-between gap-2">
                <p className="text-[10.5px] font-semibold text-ink-500 uppercase tracking-[0.12em]">
                  {t('flex_title')}
                </p>
                <button
                  onClick={() => setShowIncomeModal(true)}
                  aria-label={t('flex_edit_income')}
                  className="m-ctl relative w-8 h-8 rounded-[10px] flex items-center justify-center before:absolute before:-inset-1.5 before:content-['']"
                >
                  <Glyph name="edit" size={14} className="text-ink-600" />
                </button>
              </div>
              <div className="mt-1.5 flex items-baseline justify-between gap-2">
                <span className={`text-[24px] font-semibold tabular-nums tracking-[-0.03em] ${
                  flex.state === 'red' ? 'text-pay-text' : flex.state === 'yellow' ? 'text-warn-700' : 'text-ink-900'
                }`}>
                  {flex.remaining < 0 ? '−' : ''}{formatMoney(Math.abs(flex.remaining), primaryCurrency)}
                </span>
                <span className="text-[11px] text-ink-600 tabular-nums">
                  {t('flex_left_of').replace('{total}', formatMoney(Math.max(flex.flexTotal, 0), primaryCurrency))}
                </span>
              </div>
              <div className="m-inset relative mt-3 h-2 rounded-full overflow-hidden">
                <div className={`h-full rounded-full bg-gradient-to-r ${flexBarColor} transition-all`} style={{ width: `${flexBarPct}%` }} />
              </div>
              <p className="mt-2 text-[11px] text-ink-600 tabular-nums leading-relaxed">
                {flexBreakdown}
              </p>
              {flex.state !== 'green' && (
                <p className={`mt-1.5 text-[11px] font-semibold ${flex.state === 'red' ? 'text-pay-text' : 'text-warn-700'}`}>
                  {flex.state === 'red' ? t('flex_out_hint') : t('flex_low_hint')}
                </p>
              )}
            </Card3D>
          ) : (
            <Card3D padding="sm">
              <p className="text-[10.5px] font-semibold text-ink-500 uppercase tracking-[0.12em]">
                {t('flex_title')}
              </p>
              <p className="mt-1.5 text-[12px] text-ink-600 leading-relaxed">
                {t('flex_setup_desc')}
              </p>
              <button onClick={() => setShowIncomeModal(true)} className="mt-3 cta-secondary w-full">
                {t('flex_set_income')}
              </button>
            </Card3D>
          )
        )}

        {loadStatus === 'ready' && leftSummary.length > 0 && (
          <Card3D padding="sm">
            <p className="text-[10.5px] font-semibold text-ink-500 uppercase tracking-[0.12em]">
              {t('budget_left_title')}
            </p>
            <div className="mt-2 space-y-2">
              {leftSummary.map((s) => (
                <div key={s.currency} className="flex items-baseline justify-between gap-2">
                  <span className={`text-[22px] font-semibold tabular-nums tracking-[-0.03em] ${s.left < 0 ? 'text-pay-text' : 'text-ink-900'}`}>
                    {s.left < 0 ? '−' : ''}{formatMoney(Math.abs(s.left), s.currency)}
                  </span>
                  <span className="text-[11px] text-ink-600 tabular-nums">
                    {t('budget_spent_of')
                      .replace('{spent}', formatMoney(s.spent, s.currency))
                      .replace('{total}', formatMoney(s.budget, s.currency))}
                  </span>
                </div>
              ))}
            </div>
          </Card3D>
        )}

        {loadStatus === 'loading' && usages.length === 0 ? (
          <ListSkeleton rows={3} />
        ) : usages.length === 0 ? (
          loadStatus === 'ready' ? (
            <EmptyState
              icon={Wallet2}
              clayIcon="wallet"
              tone="violet"
              title={t('bud_empty_title')}
              description={t('bud_empty_desc')}
              subhint={t('bud_empty_subhint')}
              actionLabel={t('bud_empty_cta')}
              onAction={() => setShowAdd(true)}
            />
          ) : null
        ) : (
          <div className="space-y-2.5">
            {usages.map((usage) => (
              <BudgetCard
                key={usage.budget.id}
                usage={usage}
                onEdit={() => setEditing(usage.budget)}
              />
            ))}
          </div>
        )}
      </div>

      <AddBudgetModal
        open={showAdd}
        onClose={() => setShowAdd(false)}
        existing={budgets}
      />

      <EditBudgetModal
        budget={editing}
        onClose={() => setEditing(null)}
      />

      <FlexIncomeModal
        open={showIncomeModal}
        currency={primaryCurrency}
        current={flexIncome}
        onSave={saveFlexIncome}
        onClose={() => setShowIncomeModal(false)}
      />
    </main>
  );
}

// Income lives ONLY in localStorage, keyed per currency so switching the
// primary currency never shows another wallet's figure. Storage-off devices
// simply re-ask each session.
function readFlexIncome(currency: string): number | null {
  try {
    const raw = localStorage.getItem(FLEX_INCOME_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const val = parsed?.[currency];
    return typeof val === 'number' && Number.isFinite(val) && val > 0 ? val : null;
  } catch {
    return null;
  }
}

function writeFlexIncome(currency: string, value: number | null): void {
  try {
    const raw = localStorage.getItem(FLEX_INCOME_KEY);
    const parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    if (value === null) delete parsed[currency];
    else parsed[currency] = value;
    localStorage.setItem(FLEX_INCOME_KEY, JSON.stringify(parsed));
  } catch {
    // Storage unavailable — the card just won't persist across sessions.
  }
}

interface FlexIncomeModalProps {
  open: boolean;
  currency: Currency | string;
  current: number | null;
  onSave: (value: number | null) => void;
  onClose: () => void;
}

function FlexIncomeModal(props: FlexIncomeModalProps) {
  // Fresh draft every open: remount the inner form (via `key`) instead of
  // resetting state in an effect. Keying on the open/closed boundary forces
  // a new FlexIncomeForm instance — and a fresh lazy-initialized `draft` —
  // on every transition, seeded from whatever `current` is at that moment.
  return <FlexIncomeForm key={props.open ? 'open' : 'closed'} {...props} />;
}

function FlexIncomeForm({ open, currency, current, onSave, onClose }: FlexIncomeModalProps) {
  const t = useT();
  const [draft, setDraft] = useState(() => (current !== null ? String(current) : ''));

  const numeric = Number(draft);
  const valid = Number.isFinite(numeric) && numeric > 0;

  return (
    <Modal open={open} onClose={onClose} title={t('flex_title')}>
      <div className="space-y-4">
        <p className="text-[12px] text-ink-500 leading-relaxed">{t('flex_income_hint')}</p>
        <div>
          <label className="form-label">{t('flex_income_label')} ({currency})</label>
          <input
            type="number"
            inputMode="decimal"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="0"
            className="input-field tabular-nums"
          />
        </div>
        <button onClick={() => onSave(numeric)} disabled={!valid} className="cta-primary disabled:opacity-50">
          {t('flex_save_income')}
        </button>
        {current !== null && (
          <button
            onClick={() => onSave(null)}
            className="w-full text-center text-[12px] text-ink-500 min-h-[44px] font-medium"
          >
            {t('flex_remove')}
          </button>
        )}
      </div>
    </Modal>
  );
}

interface BudgetCardProps {
  usage: ReturnType<typeof computeBudgetUsages>[number];
  onEdit: () => void;
}

function BudgetCard({ usage, onEdit }: BudgetCardProps) {
  const t = useT();
  const { budget, spent, remaining, percent, overLimit, overWarn } = usage;
  const cappedPercent = Math.min(percent, 100);
  // Where "on pace" spending would sit today — a vertical tick on the bar so
  // the user can see if they're ahead of or behind an even monthly burn.
  const now = new Date();
  const dayOfMonth = now.getDate();
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const expectedPercent = Math.min(100, (dayOfMonth / daysInMonth) * 100);
  // Bar color shifts as the user gets closer to the cap. Green → amber → coral
  // so the meaning is obvious without reading the number.
  const barColor = overLimit
    ? 'from-pay-600 to-pay-700'
    : overWarn
      ? 'from-warn-600 to-warn-700'
      : 'from-receive-600 to-receive-700';
  return (
    <button
      onClick={onEdit}
      className={`m-tile p-4 ${overLimit ? 'm-coral' : ''}`}
    >
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-[14px] font-semibold text-ink-900 tracking-tight truncate">
          {budget.category}
        </p>
        <p className={`text-[11px] font-semibold tabular-nums ${overLimit ? 'text-pay-text' : 'text-ink-500'}`}>
          {percent.toFixed(0)}%
        </p>
      </div>
      <div className="flex items-baseline justify-between gap-2 mt-1">
        <p className="text-[12px] text-ink-600 tabular-nums">
          <span className="font-semibold text-ink-900">{formatMoney(spent, budget.currency)}</span>
          {' '}/ {formatMoney(budget.monthlyAmount, budget.currency)}
        </p>
        <p
          className={`text-[11.5px] font-semibold tabular-nums inline-flex items-center gap-1 ${
            overLimit ? 'text-pay-text' : 'text-receive-text'
          }`}
        >
          {overLimit ? (
            <>
              <Glyph name="alert" size={12} strokeWidth={2.8} />
              {t('budget_over_by_short').replace('{amount}', formatMoney(Math.abs(remaining), budget.currency))}
              <span className="sr-only">
                {t('budget_over_by').replace('{amount}', formatMoney(Math.abs(remaining), budget.currency))}
              </span>
            </>
          ) : (
            t('ca_remaining').replace('{amount}', formatMoney(remaining, budget.currency))
          )}
        </p>
      </div>
      <div className="m-inset relative mt-3 h-2 rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full bg-gradient-to-r ${barColor} transition-all`}
          style={{ width: `${cappedPercent}%` }}
        />
        {/* Pace tick — where even spending would put us today. */}
        <span
          aria-hidden="true"
          className="absolute top-0 bottom-0 w-[2px] rounded-full bg-ink-500"
          style={{ left: `${expectedPercent}%` }}
        />
      </div>
    </button>
  );
}

interface AddBudgetModalProps {
  open: boolean;
  onClose: () => void;
  existing: Budget[];
}

function AddBudgetModal({ open, onClose, existing }: AddBudgetModalProps) {
  const createBudget = useBudgetStore((s) => s.createBudget);
  const toast = useToast();
  const t = useT();
  const [category, setCategory] = useState<string>(EXPENSE_CATEGORIES[0]);
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState<Currency>(() => getPrimaryCurrency());
  // Ranks the CurrencyPicker chips from the budgets this user already keeps —
  // `existing` is already a prop on this modal, so nothing new is loaded.
  const usedCurrencies = useMemo(() => [...new Set(existing.map((b) => b.currency))], [existing]);
  const [warnAt, setWarnAt] = useState(80);
  const [saving, setSaving] = useState(false);
  // Merged built-in + custom expense categories, so a user can budget against
  // their own categories (e.g. "Pet Food").
  const categoryOptions = useCategoryOptions('expense');

  const reset = useCallback(() => {
    setCategory(EXPENSE_CATEGORIES[0]);
    setAmount('');
    setWarnAt(80);
  }, []);

  const handleSave = async () => {
    const numeric = Number(amount);
    if (!Number.isFinite(numeric) || numeric <= 0) {
      toast.show({ type: 'error', title: t('bud_err_amount') });
      return;
    }
    // Check for duplicate (same category + currency) up-front so the
    // unique-index violation surfaces as a friendly toast, not a stack trace.
    const dup = existing.find(
      (b) => b.category.toLowerCase() === category.toLowerCase() && b.currency === currency,
    );
    if (dup) {
      toast.show({
        type: 'error',
        title: t('bud_dup_title'),
        subtitle: t('bud_dup_sub').replace('{currency}', currency).replace('{category}', category),
      });
      return;
    }
    setSaving(true);
    try {
      await createBudget({ category, monthlyAmount: numeric, currency, warnAtPercent: warnAt });
      toast.show({ type: 'success', title: t('bud_saved') });
      reset();
      onClose();
    } catch (err) {
      toast.show({
        type: 'error',
        title: t('bud_err_save'),
        subtitle: err instanceof Error ? err.message : t('common_try_again_soon'),
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title={t('bud_new_title')}>
      <div className="space-y-4">
        <div>
          <label className="form-label">{t('bud_field_category')}</label>
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            className="input-field"
          >
            {categoryOptions.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        </div>

        {/* Cap and currency used to share a 2:1 row, which suited the old
            one-line <select>. The CurrencyPicker is a six-cell chip grid, so
            a third of the width would crush it to ~35px per chip — each field
            gets a full-width row instead. */}
        <div>
          <label className="form-label">{t('bud_field_cap')}</label>
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
          <label className="form-label">{t('bud_field_currency')}</label>
          <CurrencyPicker
            value={currency}
            onChange={setCurrency}
            primary={getPrimaryCurrency()}
            used={usedCurrencies}
          />
        </div>

        <div>
          <label className="form-label">{t('bud_field_warn_at')}</label>
          <div className="flex items-center gap-2">
            <input
              type="range"
              min={50}
              max={100}
              step={5}
              value={warnAt}
              onChange={(e) => setWarnAt(Number(e.target.value))}
              className="flex-1 accent-accent-600 min-h-[44px]"
            />
            <span className="text-[12.5px] font-semibold text-ink-900 tabular-nums w-12 text-right">
              {warnAt}%
            </span>
          </div>
          <p className="text-[11px] text-ink-500 mt-1.5">
            {t('bud_warn_help')}
          </p>
        </div>

        <button
          onClick={handleSave}
          disabled={saving || !amount}
          className="cta-primary"
        >
          {saving ? t('bud_saving') : t('bud_save_cta')}
        </button>
      </div>
    </Modal>
  );
}

interface EditBudgetModalProps {
  budget: Budget | null;
  onClose: () => void;
}

function EditBudgetModal({ budget, onClose }: EditBudgetModalProps) {
  const updateBudget = useBudgetStore((s) => s.updateBudget);
  const deleteBudget = useBudgetStore((s) => s.deleteBudget);
  const toast = useToast();
  const t = useT();
  const [amount, setAmount] = useState('');
  const [warnAt, setWarnAt] = useState(80);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (budget) {
      setAmount(String(budget.monthlyAmount));
      setWarnAt(budget.warnAtPercent);
    }
  }, [budget]);

  if (!budget) return null;

  const handleSave = async () => {
    const numeric = Number(amount);
    if (!Number.isFinite(numeric) || numeric <= 0) {
      toast.show({ type: 'error', title: t('bud_err_amount') });
      return;
    }
    setSaving(true);
    try {
      await updateBudget(budget.id, { monthlyAmount: numeric, warnAtPercent: warnAt });
      toast.show({ type: 'success', title: t('bud_updated') });
      onClose();
    } catch (err) {
      toast.show({
        type: 'error',
        title: t('bud_err_save'),
        subtitle: err instanceof Error ? err.message : t('common_try_again_soon'),
      });
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    const ok = await confirmDestructive({
      title: t('bud_delete_confirm').replace('{category}', budget.category),
      description: t('del_budget_body'),
      confirmLabel: t('common_delete'),
    });
    if (!ok) return;
    setSaving(true);
    try {
      await deleteBudget(budget.id);
      toast.show({ type: 'success', title: t('bud_deleted') });
      onClose();
    } catch (err) {
      toast.show({
        type: 'error',
        title: t('bud_err_delete'),
        subtitle: err instanceof Error ? err.message : t('common_try_again_soon'),
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open={!!budget} onClose={onClose} title={t('bud_edit_title').replace('{category}', budget.category)}>
      <div className="space-y-4">
        <div>
          <label className="form-label">{t('bud_field_cap_cur').replace('{currency}', budget.currency)}</label>
          <input
            type="number"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className="input-field tabular-nums"
          />
        </div>

        <div>
          <label className="form-label">{t('bud_field_warn_at')}</label>
          <div className="flex items-center gap-2">
            <input
              type="range"
              min={50}
              max={100}
              step={5}
              value={warnAt}
              onChange={(e) => setWarnAt(Number(e.target.value))}
              className="flex-1 accent-accent-600 min-h-[44px]"
            />
            <span className="text-[12.5px] font-semibold text-ink-900 tabular-nums w-12 text-right">
              {warnAt}%
            </span>
          </div>
        </div>

        <div className="flex gap-2">
          <button
            onClick={handleDelete}
            disabled={saving}
            className="cta-destructive flex-1 flex items-center justify-center gap-2"
          >
            <Glyph name="trash" size={15} /> {t('common_delete')}
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="cta-primary flex-1 flex items-center justify-center gap-2"
          >
            <Glyph name="check" size={15} strokeWidth={3} /> {t('common_save')}
          </button>
        </div>
      </div>
    </Modal>
  );
}
