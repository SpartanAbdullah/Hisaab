import { useCallback, useState } from 'react';
import { Target } from 'lucide-react';
import { useGoalStore } from '../stores/goalStore';
import { useAccountStore } from '../stores/accountStore';
import { useUpcomingExpenseStore } from '../stores/upcomingExpenseStore';
import { useTransactionStore } from '../stores/transactionStore';
import { NavyHero, TopBar } from '../components/NavyHero';
import { LanguageToggle } from '../components/LanguageToggle';
import { EmptyState } from '../components/EmptyState';
import { Card3D } from '../components/Card3D';
import { Glyph } from '../components/Glyph';
import { ProgressRing } from '../components/ProgressRing';
import type { Tint } from '../lib/material';
import type { GlyphName, GlyphTone } from '../lib/glyphs';
import { PageErrorState } from '../components/PageErrorState';
import { ListSkeleton } from '../components/ListSkeleton';
import { useAsyncLoad } from '../hooks/useAsyncLoad';
import { formatMoney } from '../lib/constants';
import { useT } from '../lib/i18n';
import { useSubmitGuard } from '../lib/useSubmitGuard';
import { differenceInDays, format } from 'date-fns';
import { AddGoalModal } from './AddGoalModal';
import { AddUpcomingExpenseModal } from './AddUpcomingExpenseModal';
import { Modal } from '../components/Modal';
import { useToast } from '../components/Toast';
import { confirmDestructive } from '../components/ConfirmDestructiveSheet';
import type { Goal } from '../db';

const GOAL_MILESTONES = [25, 50, 75, 100];

// Upcoming-bill category → 3c glyph + accent (the same map the add-bill
// sheet's category tiles use).
const CATEGORY_GLYPH: Record<string, { glyph: GlyphName; tone: GlyphTone }> = {
  Education: { glyph: 'document', tone: 'blue' },
  Medical: { glyph: 'shield', tone: 'coral' },
  Event: { glyph: 'gift', tone: 'violet' },
  Travel: { glyph: 'globe', tone: 'blue' },
  Rent: { glyph: 'home', tone: 'gold' },
  Utilities: { glyph: 'flame', tone: 'gold' },
  Other: { glyph: 'more', tone: 'neutral' },
};
const DEFAULT_CATEGORY_GLYPH = { glyph: 'calendar', tone: 'neutral' } as const;

export function GoalsPage() {
  const { goals, loadGoals, addContribution, updateGoal, correctSavedAmount, deleteGoal } = useGoalStore();
  const { accounts, loadAccounts } = useAccountStore();
  const { expenses, loadExpenses, markPaid, updateStatus } = useUpcomingExpenseStore();
  const processTransaction = useTransactionStore(s => s.processTransaction);
  const t = useT();
  const toast = useToast();

  // Marking a bill "Done" only hides the reminder — it never moved money. Make
  // that explicit and offer a one-tap way to record the actual spend, so a user
  // who assumed "Done" logged the payment isn't left with a wrong balance.
  const handleBillDone = (exp: (typeof expenses)[number]) => {
    void markPaid(exp.id);
    const account = accounts.find(a => a.id === exp.accountId);
    toast.show({
      type: 'success',
      title: t('upcoming_done_toast').replace('{title}', exp.title),
      action: account
        ? {
            label: t('upcoming_log_expense'),
            onPress: () => {
              void processTransaction({
                type: 'expense',
                sourceAccountId: exp.accountId,
                amount: exp.amount,
                category: exp.category,
                notes: exp.title,
              }).then(() => {
                toast.show({
                  type: 'success',
                  title: t('upcoming_logged').replace('{amount}', formatMoney(exp.amount, exp.currency)),
                });
              });
            },
          }
        : undefined,
    });
  };
  const [showAdd, setShowAdd] = useState(false);
  const [showAddExpense, setShowAddExpense] = useState(false);
  // "Add money" sheet for a specific goal — a simple set-aside that grows the
  // saved bar. It does NOT move money between accounts (keeps the model clear).
  const [selectedGoal, setSelectedGoal] = useState<Goal | null>(null);
  const [addAmount, setAddAmount] = useState('');
  const [addMode, setAddMode] = useState<'add' | 'out'>('add');
  const [savingAdd, setSavingAdd] = useState(false);
  // Ref-backed double-tap guard (audit F-8/D-1): the `saving*` STATE flags
  // update asynchronously, so two taps in one frame both read them as false
  // and would post the contribution / correction twice. Shared across the
  // goal money actions — they all mutate a goal's savedAmount or target.
  const submitGuard = useSubmitGuard();
  // Goal management: edit details / correct saved amount / delete — the
  // recovery paths goals never had (a typo used to be permanent).
  const [menuGoalId, setMenuGoalId] = useState<string | null>(null);
  const [editGoal, setEditGoal] = useState<Goal | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [editTarget, setEditTarget] = useState('');
  const [editDate, setEditDate] = useState('');
  const [savingGoalEdit, setSavingGoalEdit] = useState(false);
  const [correctGoal, setCorrectGoal] = useState<Goal | null>(null);
  const [correctAmount, setCorrectAmount] = useState('');
  const [savingCorrect, setSavingCorrect] = useState(false);

  const handleGoalEditSave = () => submitGuard.run(runGoalEditSave);
  const handleGoalCorrect = () => submitGuard.run(runGoalCorrect);
  const handleGoalDelete = (g: Goal) => submitGuard.run(() => runGoalDelete(g));

  const runGoalEditSave = async () => {
    if (!editGoal) return;
    const target = parseFloat(editTarget);
    if (!editTitle.trim() || !(target > 0)) return;
    setSavingGoalEdit(true);
    try {
      await updateGoal(editGoal.id, {
        title: editTitle.trim(),
        targetAmount: target,
        targetDate: editDate || null,
      });
      toast.show({ type: 'success', title: t('goal_edit_saved') });
      setEditGoal(null);
    } catch (err) {
      toast.show({ type: 'error', title: t('error'), subtitle: err instanceof Error ? err.message : undefined });
    } finally {
      setSavingGoalEdit(false);
    }
  };

  const runGoalCorrect = async () => {
    if (!correctGoal) return;
    const target = parseFloat(correctAmount);
    if (!Number.isFinite(target) || target < 0) return;
    setSavingCorrect(true);
    try {
      await correctSavedAmount(correctGoal.id, target);
      toast.show({ type: 'success', title: t('goal_correct_saved') });
      setCorrectGoal(null);
    } catch (err) {
      toast.show({ type: 'error', title: t('error'), subtitle: err instanceof Error ? err.message : undefined });
    } finally {
      setSavingCorrect(false);
    }
  };

  const runGoalDelete = async (g: Goal) => {
    const ok = await confirmDestructive({
      title: t('goal_delete_title'),
      description: t('goal_delete_body').replace('{title}', g.title),
      confirmLabel: t('goal_delete_cta'),
      cancelLabel: t('not_now'),
      tone: 'destructive',
    });
    if (!ok) return;
    try {
      await deleteGoal(g.id);
      toast.show({ type: 'success', title: t('goal_deleted') });
    } catch (err) {
      toast.show({ type: 'error', title: t('error'), subtitle: err instanceof Error ? err.message : undefined });
    }
  };

  const load = useCallback(async () => {
    await Promise.all([loadGoals(), loadAccounts(), loadExpenses()]);
  }, [loadGoals, loadAccounts, loadExpenses]);
  const { status: loadStatus, error: loadError, retry: retryLoad } = useAsyncLoad(load);

  const upcomingExpenses = expenses
    .filter(e => e.status === 'upcoming')
    .sort((a, b) => new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime());

  const closeAdd = () => {
    setSelectedGoal(null);
    setAddAmount('');
    setAddMode('add');
  };
  const submitAdd = () => submitGuard.run(runSubmitAdd);

  const runSubmitAdd = async () => {
    if (!selectedGoal) return;
    const amt = parseFloat(addAmount);
    if (!amt || amt <= 0) return;

    // Commitment-aware take-out: a dated goal that hasn't reached its date yet
    // gets a gentle confirm so savings aren't raided on impulse (a soft "lock"
    // built on the existing targetDate — no schema, behavioural friction only).
    if (addMode === 'out' && selectedGoal.targetDate) {
      const td = new Date(selectedGoal.targetDate);
      if (differenceInDays(td, new Date()) > 0) {
        const ok = await confirmDestructive({
          title: t('goal_locked_title'),
          description: t('goal_locked_body').replace('{date}', format(td, 'd MMM yyyy')),
          confirmLabel: t('goal_take_out'),
          tone: 'warning',
        });
        if (!ok) return;
      }
    }

    setSavingAdd(true);
    try {
      const beforePct = selectedGoal.targetAmount > 0 ? (selectedGoal.savedAmount / selectedGoal.targetAmount) * 100 : 0;
      await addContribution(selectedGoal.id, addMode === 'out' ? -amt : amt);
      // Celebrate crossing a milestone on the way up (25/50/75/100%).
      const crossed = addMode === 'add' && selectedGoal.targetAmount > 0
        ? GOAL_MILESTONES.filter((m) => beforePct < m && ((selectedGoal.savedAmount + amt) / selectedGoal.targetAmount) * 100 >= m).pop()
        : undefined;
      if (crossed) {
        toast.show({
          type: 'success',
          title: crossed >= 100 ? t('goal_reached') : t('goal_milestone').replace('{pct}', String(crossed)),
        });
      } else {
        toast.show({ type: 'success', title: addMode === 'out' ? t('goal_take_out') : t('goal_add_money') });
      }
      closeAdd();
    } catch (err) {
      toast.show({ type: 'error', title: t('error'), subtitle: err instanceof Error ? err.message : t('err_could_not_save') });
    } finally {
      setSavingAdd(false);
    }
  };

  return (
    <main className="min-h-dvh bg-cream-bg pb-28">
      <NavyHero accent="green">
        <TopBar
          title={t('goals_title')}
          back
          action={
            <div className="flex items-center gap-2">
              <button
                onClick={() => setShowAdd(true)}
                className="m-ctl h-9 px-3 flex items-center gap-1.5 text-[12px] font-semibold text-accent-text"
                aria-label={t('goals_a11y_add')}
              >
                <Glyph name="plus" size={13} strokeWidth={3} /> {t('goals_add_short')}
              </button>
              <button
                onClick={() => setShowAddExpense(true)}
                className="m-ctl h-9 px-3 flex items-center gap-1.5 text-[12px] font-semibold text-white/90"
                aria-label={t('goals_a11y_add_bill')}
              >
                <Glyph name="plus" size={13} strokeWidth={3} /> {t('goals_add_bill_short')}
              </button>
              <LanguageToggle />
            </div>
          }
        />
        <div className="px-5 pb-7">
          <p className="text-[10.5px] font-semibold text-white/70 tracking-[0.12em] uppercase">
            {goals.length === 1
              ? t('goals_count_one')
              : t('goals_count_many').replace('{n}', String(goals.length))}
            {upcomingExpenses.length > 0 && (
              <> · {t('goals_upcoming_count').replace('{n}', String(upcomingExpenses.length))}</>
            )}
          </p>
        </div>
      </NavyHero>

      <div className="sukoon-body min-h-[60dvh] px-5 pt-5 space-y-4">

      {loadStatus === 'error' && (
        <PageErrorState
          variant="inline"
          title={t('goals_err_load')}
          message={loadError ?? t('err_some_data_failed')}
          onRetry={retryLoad}
        />
      )}

      {/* First-load skeleton — never flash "No goals yet" before the
          goals + upcoming-expenses queries finish. */}
      {loadStatus === 'loading' && goals.length === 0 && upcomingExpenses.length === 0 && (
        <ListSkeleton rows={3} />
      )}

      {/* Upcoming Expenses Section */}
      {upcomingExpenses.length > 0 && (
        <div>
          <div className="flex items-center justify-between mb-2.5 px-1">
            <h2 className="text-[10.5px] font-semibold text-ink-500 uppercase tracking-[0.12em] flex items-center gap-1.5">
              <Glyph name="calendar" size={12} tone="violet" /> {t('upcoming_title')}
            </h2>
            <button
              onClick={() => setShowAddExpense(true)}
              className="text-[11px] font-semibold text-accent-text flex items-center gap-1 min-h-[32px] active:opacity-70"
              aria-label={t('goals_a11y_add_bill')}
            >
              <Glyph name="plus" size={12} strokeWidth={3} /> {t('goals_add_bill_short')}
            </button>
          </div>
          <div className="space-y-2.5">
            {upcomingExpenses.map((exp, i) => {
              const daysLeft = differenceInDays(new Date(exp.dueDate), new Date());
              const account = accounts.find(a => a.id === exp.accountId);
              const isOverdue = daysLeft < 0;
              const isDueToday = daysLeft === 0;
              const isUrgent = daysLeft >= 1 && daysLeft <= 7;
              const isSoon = daysLeft > 7 && daysLeft <= 30;
              const hasInsufficientBalance = account ? exp.amount > account.balance : false;

              const cat = CATEGORY_GLYPH[exp.category] ?? DEFAULT_CATEGORY_GLYPH;

              // The same urgency ladder the flat tint encoded — coral for
              // overdue/urgent, gold for due-today/soon, mint for everything
              // comfortably ahead.
              const cardTint: Tint = isOverdue || isUrgent
                ? 'coral'
                : isDueToday || isSoon
                  ? 'gold'
                  : 'mint';

              return (
                <Card3D key={exp.id} tint={cardTint} padding="sm"
                  className="animate-fade-in" style={{ animationDelay: `${Math.min(i, 8) * 60}ms` }}>
                  <div className="flex items-center gap-3">
                    <div className="m-ctl w-10 h-10 rounded-[14px] flex items-center justify-center shrink-0">
                      <Glyph name={cat.glyph} tone={cat.tone} size={19} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="font-semibold text-[13.5px] text-ink-900 tracking-tight truncate">{exp.title}</p>
                      <p className="text-[11px] text-ink-600 mt-0.5 truncate">
                        {account?.name ?? t('mv_unknown_account')} — {format(new Date(exp.dueDate), 'dd MMM yyyy')}
                      </p>
                    </div>
                    <div className="text-right shrink-0">
                      <p className="text-[14px] font-semibold tabular-nums text-ink-900">
                        {formatMoney(exp.amount, exp.currency)}
                      </p>
                      <p className={`text-[10.5px] font-semibold mt-0.5 ${
                        isOverdue ? 'text-pay-text' :
                        isDueToday ? 'text-warn-600' :
                        isUrgent ? 'text-pay-text' :
                        isSoon ? 'text-warn-600' :
                        'text-receive-text'
                      }`}>
                        {isOverdue ? t('upcoming_overdue') :
                         isDueToday ? t('upcoming_due_today') :
                         `${daysLeft} ${t('upcoming_due_in')}`}
                      </p>
                    </div>
                  </div>

                  {/* Low balance warning */}
                  {hasInsufficientBalance && (
                    <div className="m-inset mt-3 px-3 py-2 flex items-center gap-2">
                      <Glyph name="alert" size={13} tone="coral" />
                      <p className="text-[11px] text-pay-text font-semibold">
                        {t('upcoming_low_balance')} — {account?.name}: {formatMoney(account?.balance ?? 0, exp.currency)}
                      </p>
                    </div>
                  )}

                  {/* Actions */}
                  <div className="flex gap-2.5 mt-3.5">
                    <button onClick={() => handleBillDone(exp)}
                      className="m-btn m-btn-green flex-1 py-2 px-3 text-[12px]"
                    >
                      <Glyph name="check" size={13} strokeWidth={3} /> {t('upcoming_status_done')}
                    </button>
                    <button onClick={() => {
                        // Instant cancel with an Undo — the Cancel button sits
                        // right next to Done, so a mis-tap should be painless.
                        const prev = exp.status;
                        void updateStatus(exp.id, 'cancelled');
                        toast.show({
                          type: 'success',
                          title: t('upcoming_cancelled'),
                          action: { label: t('undo'), onPress: () => void updateStatus(exp.id, prev) },
                        });
                      }}
                      className="m-btn m-btn-danger py-2 px-3.5 text-[12px]"
                    >
                      <Glyph name="close" size={13} strokeWidth={3} /> {t('upcoming_status_cancel')}
                    </button>
                  </div>
                </Card3D>
              );
            })}
          </div>
        </div>
      )}

      {/* Goals Section */}
      <div className="space-y-3">
        {goals.length > 0 && (
          <h2 className="text-[10.5px] font-semibold text-ink-500 uppercase tracking-[0.12em] flex items-center gap-1.5 px-1">
            <Glyph name="savings" size={12} tone="green" /> {t('goals_title')}
          </h2>
        )}
        {loadStatus === 'ready' && goals.length === 0 && upcomingExpenses.length === 0 && (
          <EmptyState icon={Target} clayIcon="savings" tone="receive" title={t('empty_goals_title')} description={t('empty_goals_desc')} subhint={t('empty_goals_subhint')} actionLabel={t('empty_goals_cta')} onAction={() => setShowAdd(true)} />
        )}
        {goals.map((g, i) => {
          const progress = g.targetAmount > 0 ? (g.savedAmount / g.targetAmount) * 100 : 0;
          const account = g.storedInAccountId ? accounts.find(a => a.id === g.storedInAccountId) : null;
          const isComplete = progress >= 100;
          // "How much more" + a soft pace estimate from the average saved per
          // month since the goal was created.
          const remaining = Math.max(0, g.targetAmount - g.savedAmount);
          const monthsElapsed = Math.max(
            1,
            differenceInDays(new Date(), new Date(g.createdAt)) / 30,
          );
          const pace = g.savedAmount / monthsElapsed;
          const monthsToGo = pace > 0 ? Math.ceil(remaining / pace) : 0;
          // Deadline (optional): suggest a monthly save + an on-track/behind
          // signal based on linear expected progress from createdAt → target.
          const targetDate = g.targetDate ? new Date(g.targetDate) : null;
          const daysToTarget = targetDate ? differenceInDays(targetDate, new Date()) : null;
          const monthsLeft = daysToTarget != null ? Math.max(0, daysToTarget / 30) : null;
          const monthlyNeeded = monthsLeft != null && monthsLeft > 0 ? remaining / monthsLeft : remaining;
          const onTrack = (() => {
            if (!targetDate) return null;
            const totalDays = differenceInDays(targetDate, new Date(g.createdAt));
            if (totalDays <= 0) return g.savedAmount >= g.targetAmount;
            const elapsed = differenceInDays(new Date(), new Date(g.createdAt));
            const expected = g.targetAmount * Math.min(1, Math.max(0, elapsed / totalDays));
            return g.savedAmount >= expected - 0.01;
          })();
          return (
            // Mint is the savings tint; the ring around the glyph fills with
            // the goal, and a finished goal wears the trophy. `style` carries
            // the staggered entrance delay, which cannot be a class because
            // the value is an index.
            <Card3D key={g.id} tint="mint" padding="lg"
              className="animate-fade-in" style={{ animationDelay: `${Math.min(i, 8) * 60}ms` }}>
              <div className="flex items-center gap-3.5">
                <ProgressRing
                  size={48}
                  strokeWidth={4}
                  progress={Math.min(progress, 100) / 100}
                  color="var(--color-glyph-green)"
                >
                  <Glyph name={isComplete ? 'trophy' : 'savings'} tone="green" size={20} />
                </ProgressRing>
                <div className="flex-1 min-w-0">
                  <p className="font-semibold text-[14px] text-ink-900 tracking-tight">{g.title}</p>
                  <p className="text-[11px] text-ink-600 mt-0.5">
                    {account ? `${account.name} · ${g.currency}` : g.currency}
                  </p>
                </div>
                <div className="text-right">
                  <p className={`text-[15px] font-semibold tabular-nums ${isComplete ? 'text-receive-text' : 'text-ink-900'}`}>
                    {Math.round(progress)}%
                  </p>
                  {isComplete && <p className="text-[10px] text-receive-text font-semibold">{t('goal_done')}</p>}
                </div>
                <div className="relative">
                  <button
                    onClick={() => setMenuGoalId(menuGoalId === g.id ? null : g.id)}
                    className="m-ctl relative w-8 h-8 rounded-[10px] flex items-center justify-center before:absolute before:-inset-1.5 before:content-['']"
                    aria-label={t('goal_manage')}
                    aria-expanded={menuGoalId === g.id}
                  >
                    <Glyph name="more" size={16} strokeWidth={3} className="text-ink-600" />
                  </button>
                  {menuGoalId === g.id && (
                    <>
                      <div className="fixed inset-0 z-40" role="presentation" onClick={() => setMenuGoalId(null)} />
                      {/* bg-cream-card, not m-card: inside the mint card an
                          m-card would inherit the mint tint and walls. */}
                      <div className="absolute right-0 top-10 z-50 bg-cream-card rounded-2xl border border-cream-border shadow-[0_18px_40px_-12px_rgba(0,0,0,0.45)] py-1.5 w-52 animate-fade-in">
                        <button
                          onClick={() => {
                            setMenuGoalId(null);
                            setEditTitle(g.title);
                            setEditTarget(String(g.targetAmount));
                            setEditDate(g.targetDate ?? '');
                            setEditGoal(g);
                          }}
                          className="w-full px-4 py-2.5 min-h-[44px] flex items-center gap-2.5 text-left text-[13px] font-medium text-ink-800 active:bg-cream-soft"
                        >
                          <Glyph name="edit" size={15} className="text-ink-500" />
                          {t('goal_menu_edit')}
                        </button>
                        <button
                          onClick={() => {
                            setMenuGoalId(null);
                            setCorrectAmount(String(g.savedAmount));
                            setCorrectGoal(g);
                          }}
                          className="w-full px-4 py-2.5 min-h-[44px] flex items-center gap-2.5 text-left text-[13px] font-medium text-ink-800 active:bg-cream-soft"
                        >
                          <Glyph name="sliders" size={15} className="text-ink-500" />
                          {t('goal_menu_correct')}
                        </button>
                        <button
                          onClick={() => {
                            setMenuGoalId(null);
                            void handleGoalDelete(g);
                          }}
                          className="w-full px-4 py-2.5 min-h-[44px] flex items-center gap-2.5 text-left text-[13px] font-medium text-pay-text active:bg-pay-50"
                        >
                          <Glyph name="trash" size={15} />
                          {t('goal_menu_delete')}
                        </button>
                      </div>
                    </>
                  )}
                </div>
              </div>

              {/* Drift check: the linked account holds less than this goal
                  claims is stored there (a balance correction desynced them).
                  One tap re-syncs savedAmount to the account's reality. */}
              {account && account.balance < g.savedAmount - 0.005 && (
                <div className="m-inset mt-3 p-3 flex items-center justify-between gap-2.5">
                  <p className="text-[11.5px] text-warn-700 leading-relaxed">
                    {t('goal_drift_warn')
                      .replace('{account}', account.name)
                      .replace('{balance}', formatMoney(account.balance, account.currency))
                      .replace('{saved}', formatMoney(g.savedAmount, g.currency))}
                  </p>
                  <button
                    onClick={() => void correctSavedAmount(g.id, account.balance).then(() => toast.show({ type: 'success', title: t('goal_correct_saved') }))}
                    className="m-btn m-btn-primary shrink-0 min-h-[36px] px-3 py-1.5 text-[11px] rounded-xl"
                  >
                    {t('goal_drift_fix')}
                  </button>
                </div>
              )}

              <div className="m-inset mt-4 rounded-full h-2.5 overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all duration-700 ${
                    isComplete ? 'bg-gradient-to-r from-receive-600 to-receive-700' : 'bg-gradient-to-r from-accent-500 to-accent-600'
                  }`}
                  style={{ width: `${Math.min(100, progress)}%` }}
                />
              </div>
              <div className="flex justify-between mt-2 text-[11px] text-ink-600 tabular-nums">
                <span>{t('goal_saved')}: {formatMoney(g.savedAmount, g.currency)}</span>
                <span>{t('goal_target')}: {formatMoney(g.targetAmount, g.currency)}</span>
              </div>

              {!isComplete && (
                <div className="mt-2 space-y-1">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-[11.5px] font-semibold text-ink-800 tabular-nums">
                      {t('goal_to_go').replace('{amount}', formatMoney(remaining, g.currency))}
                    </p>
                    {targetDate ? (
                      daysToTarget != null && daysToTarget < 0 ? (
                        <span className="m-chip m-chip-pay">
                          {t('goal_date_passed')}
                        </span>
                      ) : (
                        <span className={`m-chip ${onTrack ? 'm-chip-receive' : 'm-chip-gold'}`}>
                          <span className={`w-1.5 h-1.5 rounded-full ${onTrack ? 'bg-receive-600' : 'bg-warn-600'}`} />
                          {onTrack ? t('goal_on_track') : t('goal_behind')}
                        </span>
                      )
                    ) : pace > 0 ? (
                      <p className="text-[11px] text-ink-500 tabular-nums">
                        {t('goal_pace').replace('{n}', String(monthsToGo))}
                      </p>
                    ) : null}
                  </div>
                  {targetDate && (
                    <p className="text-[11px] text-ink-500 tabular-nums">
                      {t('goal_by_date').replace('{date}', format(targetDate, 'd MMM yyyy'))}
                      {daysToTarget != null && daysToTarget >= 0 && remaining > 0 && onTrack !== false && (
                        <> · {t('goal_save_monthly').replace('{amount}', formatMoney(Math.ceil(monthlyNeeded), g.currency))}</>
                      )}
                    </p>
                  )}
                  {/* When behind, the recomputed monthlyNeeded IS the catch-up
                      amount (remaining ÷ months-left rises as you fall behind).
                      Surface it as a clear, self-correcting nudge. */}
                  {targetDate && onTrack === false && daysToTarget != null && daysToTarget >= 0 && remaining > 0 && (
                    <p className="text-[10.5px] font-semibold text-warn-700 tabular-nums">
                      {t('goal_catch_up').replace('{amount}', formatMoney(Math.ceil(monthlyNeeded), g.currency))}
                    </p>
                  )}
                </div>
              )}

              {/* Completed goals keep an affordance too — an over-typed add
                  used to strand the goal at >100% with no way back in. */}
              <button onClick={() => { setAddMode(isComplete ? 'out' : 'add'); setSelectedGoal(g); }}
                className={`m-btn m-btn-plain mt-4 w-full text-[12.5px] ${isComplete ? '' : 'text-accent-text'}`}
              >
                {!isComplete && <Glyph name="plus" size={14} strokeWidth={3} />}
                {isComplete ? t('goal_manage') : t('goal_add_money')}
              </button>
            </Card3D>
          );
        })}
      </div>

      </div>

      <AddGoalModal open={showAdd} onClose={() => setShowAdd(false)} />
      <Modal
        open={!!editGoal}
        onClose={() => setEditGoal(null)}
        title={t('goal_menu_edit')}
        footer={
          <button
            onClick={handleGoalEditSave}
            disabled={savingGoalEdit || !editTitle.trim() || !(parseFloat(editTarget) > 0)}
            className="cta-primary"
          >
            {t('save')}
          </button>
        }
      >
        {editGoal && (
          <div className="space-y-4">
            <div>
              <label className="form-label">{t('goal_name')}</label>
              <input value={editTitle} onChange={(e) => setEditTitle(e.target.value)} className="input-field" />
            </div>
            <div>
              <label className="form-label">{t('goal_target')} ({editGoal.currency})</label>
              <input
                type="number"
                step="0.01"
                value={editTarget}
                onChange={(e) => setEditTarget(e.target.value)}
                className="input-field tabular-nums"
              />
            </div>
            <div>
              <label className="form-label">{t('goal_deadline')}</label>
              <input type="date" value={editDate} onChange={(e) => setEditDate(e.target.value)} className="input-field" />
            </div>
            {editGoal.savedAmount > 0.005 && (
              <p className="m-inset text-[11.5px] text-ink-600 p-3 leading-relaxed">
                {t('goal_currency_locked')}
              </p>
            )}
          </div>
        )}
      </Modal>
      <Modal
        open={!!correctGoal}
        onClose={() => setCorrectGoal(null)}
        title={t('goal_correct_title')}
        footer={
          <button
            onClick={handleGoalCorrect}
            disabled={savingCorrect || !Number.isFinite(parseFloat(correctAmount)) || parseFloat(correctAmount) < 0}
            className="cta-primary"
          >
            {t('save')}
          </button>
        }
      >
        {correctGoal && (
          <div className="space-y-4">
            <p className="text-[12px] text-ink-500 leading-relaxed">{t('goal_correct_hint')}</p>
            <div>
              <label className="form-label">{t('goal_saved')} ({correctGoal.currency})</label>
              <input
                type="number"
                step="0.01"
                value={correctAmount}
                onChange={(e) => setCorrectAmount(e.target.value)}
                autoFocus
                className="input-field text-center text-xl font-bold tabular-nums"
              />
            </div>
            <p className="m-inset text-[12px] text-ink-600 p-3 leading-relaxed">
              {t('goal_track_note')}
            </p>
          </div>
        )}
      </Modal>
      <AddUpcomingExpenseModal open={showAddExpense} onClose={() => setShowAddExpense(false)} />
      <Modal
        open={!!selectedGoal}
        onClose={closeAdd}
        title={selectedGoal ? t('goal_add_to').replace('{title}', selectedGoal.title) : ''}
        footer={
          <button
            onClick={submitAdd}
            disabled={savingAdd || !(parseFloat(addAmount) > 0)}
            className="cta-primary"
          >
            {savingAdd ? t('goal_creating') : addMode === 'out' ? t('goal_take_out') : t('goal_add_money')}
          </button>
        }
      >
        {selectedGoal && (
          <div className="space-y-4">
            <div className="m-inset p-3.5 flex items-center justify-between">
              <span className="text-[12px] text-ink-600">{t('goal_saved')}</span>
              <span className="text-[14px] font-bold tabular-nums text-ink-900">
                {formatMoney(selectedGoal.savedAmount, selectedGoal.currency)} / {formatMoney(selectedGoal.targetAmount, selectedGoal.currency)}
              </span>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <button type="button" onClick={() => setAddMode('add')}
                className={`justify-center text-[12.5px] font-semibold ${addMode === 'add' ? 'selector-base selector-selected' : 'selector-base'}`}
              >{t('goal_add_money')}</button>
              <button type="button" onClick={() => setAddMode('out')}
                className={`justify-center text-[12.5px] font-semibold ${addMode === 'out' ? 'selector-base selector-selected' : 'selector-base'}`}
              >{t('goal_take_out')}</button>
            </div>
            <div>
              <label className="form-label">{t('goal_amount_label')} ({selectedGoal.currency})</label>
              <input
                type="number"
                step="0.01"
                value={addAmount}
                onChange={(e) => setAddAmount(e.target.value)}
                placeholder="0.00"
                autoFocus
                className="input-field text-center text-xl font-bold tabular-nums"
              />
            </div>
            <p className="m-inset text-[12px] text-ink-600 p-3 leading-relaxed">
              {t('goal_track_note')}
            </p>
          </div>
        )}
      </Modal>
    </main>
  );
}
