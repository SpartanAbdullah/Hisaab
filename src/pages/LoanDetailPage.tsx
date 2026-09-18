import { useCallback, useState } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { format, isPast, differenceInDays } from 'date-fns';
import { FileQuestion } from 'lucide-react';
import { useLoanStore } from '../stores/loanStore';
import { useEmiStore } from '../stores/emiStore';
import { useTransactionStore } from '../stores/transactionStore';
import { useAccountStore } from '../stores/accountStore';
import { useAppModeStore } from '../stores/appModeStore';
import { track } from '../lib/telemetry';
import { Modal } from '../components/Modal';
import { Glyph } from '../components/Glyph';
import { EmptyState } from '../components/EmptyState';
import { ListSkeleton } from '../components/ListSkeleton';
import { useLinkedRequestStore } from '../stores/linkedRequestStore';
import { useSettlementRequestStore } from '../stores/settlementRequestStore';
import { usePersonStore } from '../stores/personStore';
import { useSupabaseAuthStore } from '../stores/supabaseAuthStore';
import { NavyHero, TopBar } from '../components/NavyHero';
import { MoneyDisplay } from '../components/MoneyDisplay';
import { UserAvatar } from '../components/UserAvatar';
import { LanguageToggle } from '../components/LanguageToggle';
import { TransactionItem } from '../components/TransactionItem';
import { EditTransactionModal } from '../components/EditTransactionModal';
import { PaymentReminderModal } from '../components/PaymentReminderModal';
import { NotificationPermissionPrompt } from '../components/NotificationPermissionPrompt';
import { SendStatementModal } from '../components/SendStatementModal';
import { PageErrorState } from '../components/PageErrorState';
import { EditHistorySheet, EditHistoryRow } from '../components/EditHistorySheet';
import { confirmDestructive } from '../components/ConfirmDestructiveSheet';
import { useToast } from '../components/Toast';
import { useSubmitGuard } from '../lib/useSubmitGuard';
import { useAsyncLoad } from '../hooks/useAsyncLoad';
import { formatMoney } from '../lib/constants';
import { skeletonDelay } from '../lib/material';
import { useT } from '../lib/i18n';
import { RepaymentModal } from './RepaymentModal';
import { SettleLinkedLoanModal } from './SettleLinkedLoanModal';
import { resolvePersonName } from '../lib/resolvePersonName';
import { getOldestIsoDate } from '../lib/paymentReminders';
import { uncoveredToPaidIds } from '../lib/emiCoverage';
import { buildInternalNote } from '../lib/internalNotes';
import { isLoanRemainingConflict } from '../lib/loanRemainingDelta';
import type { EmiSchedule, Transaction, SettlementRequest } from '../db';

export function LoanDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { loans, loadLoans, applyRepayment, updateLoan } = useLoanStore();
  const { schedules, loadSchedules, reconcileCovered } = useEmiStore();
  const { loadTransactions, getByLoan, deleteLoanCascade } = useTransactionStore();
  const { loadAccounts, accounts } = useAccountStore();
  const linkedRequests = useLinkedRequestStore((s) => s.requests);
  const settlementRequests = useSettlementRequestStore((s) => s.requests);
  const cancelSettlement = useSettlementRequestStore((s) => s.cancel);
  const persons = usePersonStore((s) => s.persons);
  const currentUserId = useSupabaseAuthStore((s) => s.user?.id ?? '');
  const appMode = useAppModeStore((s) => s.mode);
  const t = useT();
  const toast = useToast();
  const [cancellingSettlementId, setCancellingSettlementId] = useState<string | null>(null);
  const [reconciling, setReconciling] = useState(false);
  const [showMenu, setShowMenu] = useState(false);
  const [showEditDetails, setShowEditDetails] = useState(false);
  const [editName, setEditName] = useState('');
  const [editNotes, setEditNotes] = useState('');
  const [savingEdit, setSavingEdit] = useState(false);
  const [settlingNoMoney, setSettlingNoMoney] = useState(false);
  const [deletingLoan, setDeletingLoan] = useState(false);
  const [showRepayment, setShowRepayment] = useState(false);
  const [showSettleLinked, setShowSettleLinked] = useState(false);
  const [showReminder, setShowReminder] = useState(false);
  // MF-06: high-intent moment for the contextual notification-permission ask
  // — bumped every time the payment-reminder sheet closes (the user just
  // acted on reminding this person, a natural moment to offer reminding
  // them too). Starts at 0, which NotificationPermissionPrompt ignores.
  const [notifPromptTrigger, setNotifPromptTrigger] = useState(0);
  const [showStatement, setShowStatement] = useState(false);
  // Audit G5/O10: the dispute-resolution layer. A loan's history is private to
  // its owner (record_edits RLS), and reads identically in both app modes —
  // a ledger-mode loan has no account leg and the change JSON has no account
  // id, so nothing about the sentences differs.
  const [showHistory, setShowHistory] = useState(false);
  const [statementIntro, setStatementIntro] = useState<string | undefined>(undefined);
  const [receiptData, setReceiptData] = useState<{ receivedAmount: number; currency: string; remaining: number | null; date: string } | undefined>(undefined);
  const [selectedTransaction, setSelectedTransaction] = useState<Transaction | null>(null);
  const [selectedEmi, setSelectedEmi] = useState<(EmiSchedule & { isOverdue: boolean }) | null>(null);
  const settleNoMoneyGuard = useSubmitGuard();
  const deleteLoanGuard = useSubmitGuard();

  const load = useCallback(async () => {
    await Promise.all([loadLoans(), loadSchedules(), loadTransactions(), loadAccounts()]);
  }, [loadAccounts, loadLoans, loadSchedules, loadTransactions]);
  const { status: loadStatus, error: loadError, retry: retryLoad } = useAsyncLoad(load);

  const loan = loans.find((entry) => entry.id === id);

  // Deep-links into /loan/:id need to wait for the loans list to land before
  // we can decide whether the loan really doesn't exist. Showing the
  // "not found" copy mid-load creates panic for a record the user knows
  // exists.
  if (!loan) {
    if (loadStatus === 'error') {
      return (
        <PageErrorState
          title={t('ldp_err_load')}
          message={loadError ?? t('ldp_err_load_sub')}
          onRetry={retryLoad}
        />
      );
    }
    if (loadStatus === 'loading') {
      // Skeleton in the page's final geometry: identity row, hero figure,
      // progress track, then the next-instalment card and a history list.
      const delay = (i: number) => ({ '--m-skel-delay': skeletonDelay(i) }) as React.CSSProperties;
      return (
        <main className="min-h-dvh bg-cream-bg pb-28">
          <NavyHero accent="violet">
            <TopBar back />
            <div className="px-5 pb-7" aria-hidden>
              <div className="flex items-center gap-3 mb-5">
                <div className="m-skel w-14 h-14 rounded-full shrink-0" />
                <div className="flex-1">
                  <div className="m-skel h-4 w-36" />
                  <div className="m-skel h-3 w-24 mt-2" style={delay(1)} />
                </div>
              </div>
              <div className="m-skel h-3 w-28" style={delay(1)} />
              <div className="m-skel h-10 w-52 mt-2.5 rounded-xl" style={delay(2)} />
              <div className="m-skel h-1.5 w-full mt-5 rounded-full" style={delay(3)} />
            </div>
          </NavyHero>
          <div className="sukoon-body min-h-[60dvh] px-5 pt-5 space-y-4">
            <p className="sr-only" role="status">{t('loading')}</p>
            <div className="m-skel h-[132px] rounded-[18px]" aria-hidden />
            <ListSkeleton rows={3} withAvatar={false} />
          </div>
        </main>
      );
    }
    return (
      <main className="min-h-dvh bg-cream-bg pb-28">
        <NavyHero accent="violet">
          <TopBar back />
          <div className="pb-7" />
        </NavyHero>
        <div className="sukoon-body min-h-[60dvh] px-5 pt-5">
          <EmptyState
            icon={FileQuestion}
            clayIcon="banknote"
            tone="violet"
            title={t('loan_not_found')}
            description={t('ldp_not_found_desc')}
          />
        </div>
      </main>
    );
  }

  const displayName = resolvePersonName({ personId: loan.personId, fallback: loan.personName });
  const loanTransactions = getByLoan(loan.id);

  // Card-funded (cash advance) loans: the "counterparty" is the user's own
  // credit card, not a person — human-only affordances (WhatsApp reminders,
  // statements, person avatar) must not render for a piece of plastic.
  const cashAdvanceTx = loanTransactions.find(
    (t) => t.type === 'loan_taken' && Boolean(t.sourceAccountId),
  );
  const isCardLoan = Boolean(cashAdvanceTx);

  const linkedPair = linkedRequests.find(
    (r) => r.status === 'accepted' && (r.requesterLoanId === loan.id || r.responderLoanId === loan.id),
  ) ?? null;
  const isLinkedLoan = (() => {
    if (!loan.personId) return false;
    const p = persons.find((x) => x.id === loan.personId);
    return !!(p?.linkedProfileId) && !!linkedPair;
  })();
  const canSettleLinked = isLinkedLoan && loan.status === 'active' && loan.remainingAmount > 0;
  const loanPairId = linkedPair?.id ?? null;
  const settlementHistory = loanPairId
    ? settlementRequests.filter((r) => r.loanPairId === loanPairId).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    : [];

  const emiItems = schedules
    .filter((schedule) => schedule.loanId === loan.id)
    .sort((left, right) => left.installmentNumber - right.installmentNumber);
  const enrichedEmis = emiItems.map((schedule) => ({
    ...schedule,
    isOverdue: schedule.status === 'upcoming' && isPast(new Date(schedule.dueDate)),
  }));
  const reminderStartedAt = getOldestIsoDate(
    enrichedEmis
      .filter((schedule) => schedule.status !== 'paid' && isPast(new Date(schedule.dueDate)))
      .map((schedule) => schedule.dueDate),
  ) ?? loan.createdAt;

  const paidCount = enrichedEmis.filter((s) => s.status === 'paid').length;
  const totalCount = enrichedEmis.length;
  // Instalments the loan's paid-down balance already covers but that still show
  // unpaid (the desync). These can be marked paid with no money movement.
  const paidDownAmount = Math.round((loan.totalAmount - loan.remainingAmount) * 100) / 100;
  const coveredUnpaidIds = new Set(uncoveredToPaidIds(emiItems, paidDownAmount));
  const nextInstalment = enrichedEmis.find((s) => s.status !== 'paid' && !coveredUnpaidIds.has(s.id)) ?? null;
  const daysToNext = nextInstalment ? differenceInDays(new Date(nextInstalment.dueDate), new Date()) : null;
  const progressPct = (loan.totalAmount - loan.remainingAmount) / loan.totalAmount;

  const isGiven = loan.type === 'given';
  // Hero label flips based on direction: "X owes you" (receivable) vs
  // "You owe X" (payable). Plain copy beats abbreviations on a hero.
  const heroLabel = (isGiven ? t('loan_hero_owes_you') : t('loan_hero_you_owe'))
    .replace('{name}', displayName || loan.personName);

  const refreshLoanDetail = () => {
    void loadLoans();
    void loadSchedules();
    void loadTransactions();
    void loadAccounts();
  };

  // Money-free settle: the remaining balance is recorded as paid WITHOUT any
  // account leg — for debts cleared outside the app or written off. Kills the
  // fake-entry workaround users invented to close a loan.
  const handleSettleNoMoney = () => settleNoMoneyGuard.run(runSettleNoMoney);

  const runSettleNoMoney = async () => {
    const ok = await confirmDestructive({
      title: t('loan_settle_nomoney_title'),
      description: t('loan_settle_nomoney_body').replace('{amount}', formatMoney(loan.remainingAmount, loan.currency)),
      confirmLabel: t('loan_settle_nomoney_cta'),
      cancelLabel: t('not_now'),
      tone: 'warning',
    });
    if (!ok) return;
    setSettlingNoMoney(true);
    try {
      // writeOff meta: this record is forgiveness, not cash — money views
      // (flex budget's fixed, weekly flow) must not count it as spending.
      await applyRepayment(loan.id, loan.remainingAmount, buildInternalNote(t('loan_settle_nomoney_note'), { writeOff: '1' }));
      // Catalog #12. A write-off always clears the whole remaining balance.
      track('repayment_recorded', {
        consolidated: false,
        settles_loan: true,
        mode: appMode === 'splits_only' ? 'splits_only' : 'full_tracker',
        currency: loan.currency,
      });
      toast.show({ type: 'success', title: t('loan_settle_nomoney_done') });
      refreshLoanDetail();
    } catch (err) {
      // Audit C10: the write-off is a repayment for the WHOLE remaining
      // balance, so it is the most likely thing to lose an optimistic-lock
      // race. Pull the page back to truth before the user re-reads the figure.
      if (isLoanRemainingConflict(err)) refreshLoanDetail();
      toast.show({ type: 'error', title: t('error'), subtitle: err instanceof Error ? err.message : undefined });
    } finally {
      setSettlingNoMoney(false);
    }
  };

  // Cascade delete: loan + repayments + origin entry + EMI schedule, with
  // every balance effect reversed. The escape hatch for a mis-entered loan.
  const handleDeleteLoan = () => deleteLoanGuard.run(runDeleteLoan);

  const runDeleteLoan = async () => {
    const recordCount = loanTransactions.length;
    const ok = await confirmDestructive({
      title: t('loan_delete_title'),
      description: t('loan_delete_body').replace('{n}', String(recordCount)),
      confirmLabel: t('loan_delete_cta'),
      cancelLabel: t('not_now'),
      tone: 'destructive',
    });
    if (!ok) return;
    setDeletingLoan(true);
    try {
      await deleteLoanCascade(loan.id);
      toast.show({ type: 'success', title: t('loan_deleted') });
      navigate('/loans');
    } catch (err) {
      // Reversal blocked because a credited account spent the money since —
      // offer to proceed with that account going visibly negative.
      const blocked = err as Error & { code?: string; accountName?: string; balanceAfter?: number; accountCurrency?: string };
      if (blocked?.code === 'REVERSAL_NEEDS_NEGATIVE') {
        const proceed = await confirmDestructive({
          title: t('del_anyway_title'),
          description: t('del_anyway_body')
            .replace(/\{account\}/g, blocked.accountName ?? '')
            .replace('{after}', `${blocked.accountCurrency ?? ''} ${(blocked.balanceAfter ?? 0).toLocaleString()}`),
          confirmLabel: t('del_anyway_cta'),
          cancelLabel: t('not_now'),
          tone: 'warning',
        });
        if (proceed) {
          try {
            await deleteLoanCascade(loan.id, { allowNegative: true });
            toast.show({ type: 'success', title: t('loan_deleted') });
            navigate('/loans');
          } catch (retryErr) {
            toast.show({ type: 'error', title: t('error'), subtitle: retryErr instanceof Error ? retryErr.message : undefined });
          }
        }
        setDeletingLoan(false);
        return;
      }
      toast.show({ type: 'error', title: t('error'), subtitle: err instanceof Error ? err.message : undefined });
    } finally {
      setDeletingLoan(false);
    }
  };

  const handleSaveDetails = async () => {
    setSavingEdit(true);
    try {
      await updateLoan(loan.id, {
        ...(loan.personId ? {} : { personName: editName.trim() || loan.personName }),
        notes: editNotes.trim(),
      });
      toast.show({ type: 'success', title: t('loan_edit_saved') });
      setShowEditDetails(false);
      refreshLoanDetail();
    } catch (err) {
      toast.show({ type: 'error', title: t('error'), subtitle: err instanceof Error ? err.message : undefined });
    } finally {
      setSavingEdit(false);
    }
  };

  // Post-repayment nudge. On a loan the user GAVE, money came back to them, so
  // default to a "payment received" receipt for the payer; on a loan they TOOK
  // (they paid) keep the statement-only nudge. Read the freshest remaining from
  // the store since the repayment has already committed by this point.
  const handleRepaid = (info?: { amount: number }) => {
    // A credit card doesn't get sent statements or receipts — skip the nudge.
    if (isCardLoan) {
      refreshLoanDetail();
      return;
    }
    const name = displayName || loan.personName;
    if (loan.type === 'given') {
      const remaining = useLoanStore.getState().loans.find((l) => l.id === loan.id)?.remainingAmount ?? loan.remainingAmount;
      setReceiptData({ receivedAmount: info?.amount ?? 0, currency: loan.currency, remaining, date: new Date().toISOString() });
      setStatementIntro(t('rcpt_nudge_intro').replace('{name}', name));
    } else {
      setReceiptData(undefined);
      setStatementIntro(t('soa_nudge_intro').replace('{name}', name));
    }
    setShowStatement(true);
  };

  // Reconcile-only: mark instalments the loan's paid-down balance already
  // covers as paid, WITHOUT moving any money. Fixes a schedule that desynced
  // from the balance (e.g. a repayment recorded via Quick Entry that never
  // targeted a specific instalment). Works on settled loans too.
  const handleReconcile = async () => {
    setReconciling(true);
    try {
      const marked = await reconcileCovered(loan.id, paidDownAmount);
      if (marked > 0) {
        toast.show({
          type: 'success',
          title: marked === 1 ? t('emi_marked_paid_one') : t('emi_marked_paid_many').replace('{n}', String(marked)),
          subtitle: t('emi_marked_paid_sub'),
        });
      }
      refreshLoanDetail();
    } catch (err) {
      toast.show({
        type: 'error',
        title: t('error'),
        subtitle: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setReconciling(false);
    }
  };

  // Cancel a pending settlement request the current user sent. Confirms first
  // (cross-user action), then refreshes so the row flips to "cancelled".
  const handleCancelSettlement = async (request: SettlementRequest) => {
    const ok = await confirmDestructive({
      title: t('loan_cancel_settle_title'),
      description: t('loan_cancel_settle_body').replace('{amount}', formatMoney(request.amount, loan.currency)),
      confirmLabel: t('ltr_cancel'),
      cancelLabel: t('not_now'),
      tone: 'warning',
    });
    if (!ok) return;
    setCancellingSettlementId(request.id);
    try {
      await cancelSettlement(request.id);
      refreshLoanDetail();
    } catch (err) {
      toast.show({
        type: 'error',
        title: t('stl_cancel_error'),
        subtitle: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setCancellingSettlementId(null);
    }
  };

  return (
    <main className="min-h-dvh bg-cream-bg pb-28">
      <NavyHero accent="violet">
        <TopBar
          back
          action={
            <div className="flex items-center gap-2">
              {loan.status === 'active' && loan.remainingAmount > 0 && !isCardLoan && (
                <button
                  onClick={() => setShowReminder(true)}
                  className="m-ctl h-9 px-3 flex items-center gap-1.5 text-[11.5px] font-semibold text-white"
                  aria-label={t('reminder_cta')}
                >
                  <Glyph name="bell" size={13} tone="violet" /> {t('reminder_cta')}
                </button>
              )}
              <div className="relative">
                <button
                  onClick={() => setShowMenu(!showMenu)}
                  className="m-ctl relative w-9 h-9 flex items-center justify-center before:absolute before:-inset-1 before:content-['']"
                  aria-label={t('a11y_more')}
                  aria-expanded={showMenu}
                >
                  <Glyph name="more" size={17} strokeWidth={3} className="text-white/90" />
                </button>
                {showMenu && (
                  <>
                    <div
                      className="fixed inset-0 z-40"
                      role="presentation"
                      onClick={() => setShowMenu(false)}
                    />
                    {/* The menu opens inside the hero, which is dark in both
                        themes — so it is dark material with white ink in both
                        themes too (a theme-following ink would vanish on the
                        hero-scoped card face in light mode). */}
                    <div className="m-card absolute right-0 top-11 z-50 py-1.5 w-56 overflow-hidden animate-fade-in">
                      <button
                        onClick={() => {
                          setShowMenu(false);
                          setEditName(displayName || loan.personName);
                          setEditNotes(loan.notes ?? '');
                          setShowEditDetails(true);
                        }}
                        className="w-full px-4 py-2.5 flex items-center gap-2.5 text-[13px] font-medium text-white active:bg-white/10"
                      >
                        <Glyph name="edit" size={15} className="text-white/70" /> {t('loan_edit_details')}
                      </button>
                      {/* Nothing left to forgive → no action. applyRepayment
                          now REFUSES a zero/sub-paisa amount (it would be a
                          record of nothing) instead of silently no-op'ing, so
                          the affordance has to disappear with the balance —
                          0.005 matches the store's rounding epsilon. */}
                      {loan.status === 'active' && loan.remainingAmount > 0.005 && !isLinkedLoan && (
                        <button
                          onClick={() => { setShowMenu(false); void handleSettleNoMoney(); }}
                          disabled={settlingNoMoney}
                          className="w-full px-4 py-2.5 flex items-center gap-2.5 text-[13px] font-medium text-white active:bg-white/10 disabled:opacity-50"
                        >
                          <Glyph name="check" size={15} tone="green" /> {t('loan_settle_nomoney')}
                        </button>
                      )}
                      {!(isLinkedLoan && loan.status === 'active') && (
                        <button
                          onClick={() => { setShowMenu(false); void handleDeleteLoan(); }}
                          disabled={deletingLoan}
                          className="w-full px-4 py-2.5 flex items-center gap-2.5 text-[13px] font-medium text-pay-text active:bg-white/10 disabled:opacity-50"
                        >
                          <Glyph name="trash" size={15} /> {t('loan_delete')}
                        </button>
                      )}
                    </div>
                  </>
                )}
              </div>
              <LanguageToggle />
            </div>
          }
        />

        <div className="px-5 pb-7">
          {/* Identity: a person's avatar — or a card face for cash advances,
              which have no human counterparty. */}
          <div className="flex items-center gap-3 mb-5">
            {isCardLoan ? (
              <div className="m-ctl w-14 h-14 rounded-full flex items-center justify-center shrink-0">
                <Glyph name="card" size={24} tone="violet" extrude />
              </div>
            ) : (
              <UserAvatar name={displayName || loan.personName} size={56} />
            )}
            <div className="min-w-0">
              <p className="text-white text-[17px] font-semibold tracking-[-0.01em] truncate">
                {displayName || loan.personName}
              </p>
              <p className="text-[11px] text-white/70 mt-1 flex items-center gap-1.5 flex-wrap">
                <span>{t('loan_since_date').replace('{date}', format(new Date(loan.createdAt), 'd MMM yyyy'))}</span>
                {/* Hero chips use hero-safe fills: the hero is dark in both
                    themes, so a theme-following chip tint would go light. */}
                {isLinkedLoan && (
                  <span className="inline-flex items-center gap-1 text-[9.5px] font-semibold uppercase tracking-[0.08em] text-iris-text bg-iris-500/20 rounded-full px-1.5 py-0.5">
                    <Glyph name="link" size={10} strokeWidth={2.8} />
                    {t('ldp_linked_pill')}
                  </span>
                )}
                {isCardLoan && (
                  <span className="inline-flex items-center gap-1 text-[9.5px] font-semibold uppercase tracking-[0.08em] text-warn-700 bg-white/10 rounded-full px-2 py-0.5">
                    {t('ca_pill')}
                  </span>
                )}
              </p>
            </div>
          </div>

          <p className="text-[10.5px] font-semibold text-white/70 tracking-[0.12em] uppercase">
            {heroLabel}
          </p>
          <div className="mt-2">
            <MoneyDisplay
              amount={loan.remainingAmount}
              currency={loan.currency}
              size={40}
              tone="on-navy"
              extrude="violet"
            />
          </div>
          <p className="text-[12px] text-white/70 mt-2.5">
            {t('loan_of_total').replace('{amount}', formatMoney(loan.totalAmount, loan.currency))}
            {totalCount > 0 && (
              <> · {t('emi_cleared_line').replace('{paid}', String(paidCount)).replace('{total}', String(totalCount))}</>
            )}
          </p>

          {/* Segmented progress — one lit violet segment per paid instalment
              (coral when overdue) when an EMI plan exists, else a single
              smooth bar, in a recessed white-10% track. */}
          {totalCount > 0 ? (
            <div className="flex gap-1 mt-4">
              {enrichedEmis.map((s) => (
                <div
                  key={s.id}
                  className={`flex-1 h-1.5 rounded-full ${
                    s.status === 'paid'
                      ? 'bg-gradient-to-b from-accent-500 to-accent-600 shadow-[inset_0_1px_0_rgb(255_255_255/0.45)]'
                      : s.isOverdue
                      ? 'bg-pay-600/70'
                      : 'bg-white/10'
                  }`}
                />
              ))}
            </div>
          ) : (
            <div className="mt-4 h-2 rounded-full bg-white/10 overflow-hidden">
              <div
                className="h-full rounded-full bg-gradient-to-b from-accent-500 to-accent-600 shadow-[inset_0_1px_0_rgb(255_255_255/0.45)]"
                style={{ width: `${Math.max(0, Math.min(100, progressPct * 100))}%` }}
              />
            </div>
          )}

          {loan.status === 'settled' && (
            <div className="mt-4 inline-flex items-center gap-1.5 rounded-full bg-white/10 px-3 py-1 text-[11px] font-semibold text-receive-text">
              <Glyph name="check" size={13} strokeWidth={3} /> {t('loan_completed')}
            </div>
          )}
          {loan.notes && (
            <p className="mt-3 text-[11.5px] text-white/70 italic">"{loan.notes}"</p>
          )}
        </div>
      </NavyHero>

      <div className="sukoon-body min-h-[60dvh] px-5 pt-5 space-y-4">
        {/* Reconcile banner — the loan's paid-down balance already covers
            instalments that still show unpaid (a desync, e.g. a repayment
            recorded via Quick Entry that never targeted an instalment). Offer
            a no-money "mark paid" instead of forcing another payment. Shown
            even on settled loans so an orphaned instalment is never stuck. */}
        {coveredUnpaidIds.size > 0 && (
          <div className="m-card m-mint p-4">
            <div className="flex items-center gap-2">
              <Glyph name="check" size={16} tone="green" />
              <p className="text-[13.5px] font-semibold text-ink-900 tracking-[-0.01em]">{t('emi_reconcile_title')}</p>
            </div>
            <p className="text-[11.5px] text-ink-600 mt-1.5 leading-relaxed">
              {t('emi_reconcile_body')
                .replace('{amount}', formatMoney(paidDownAmount, loan.currency))
                .replace('{n}', String(coveredUnpaidIds.size))}
            </p>
            <button
              onClick={handleReconcile}
              disabled={reconciling}
              className="m-btn m-btn-green mt-3.5 w-full py-2.5 text-[12.5px]"
            >
              {reconciling ? t('emi_reconcile_marking') : t('emi_reconcile_cta').replace('{n}', String(coveredUnpaidIds.size))}
            </button>
          </div>
        )}

        {/* Next instalment card — shown only when EMI plan exists and
            there's an unpaid instalment. Without an EMI plan, the same
            actions surface as full-width buttons in the next section. */}
        {nextInstalment && loan.status === 'active' && (
          <div className="m-card m-card-feature p-4">
            <div className="flex items-center gap-3">
              {/* Date block: a tinted square — coral when overdue, violet
                  (the page accent) otherwise. */}
              <div
                className={`m-card ${nextInstalment.isOverdue ? 'm-coral' : 'm-violet'} w-12 h-14 rounded-[14px] flex flex-col items-center justify-center shrink-0`}
              >
                <p
                  className={`text-[9px] font-semibold uppercase tracking-[0.1em] ${
                    nextInstalment.isOverdue ? 'text-pay-text' : 'text-accent-text'
                  }`}
                >
                  {format(new Date(nextInstalment.dueDate), 'MMM').toUpperCase()}
                </p>
                <p
                  className={`text-[18px] font-semibold tabular-nums leading-none mt-0.5 ${
                    nextInstalment.isOverdue ? 'text-pay-text' : 'text-accent-text'
                  }`}
                >
                  {format(new Date(nextInstalment.dueDate), 'd')}
                </p>
              </div>
              <div className="flex-1 min-w-0">
                <p className={`text-[10.5px] font-semibold uppercase tracking-[0.1em] ${nextInstalment.isOverdue ? 'text-pay-text' : 'text-ink-400'}`}>
                  {t('emi_next_label')} ·{' '}
                  {nextInstalment.isOverdue
                    ? t('reminder_overdue_days').replace('{count}', String(Math.abs(daysToNext ?? 0)))
                    : daysToNext === 0
                    ? t('reminder_duration_today')
                    : t('emi_due_in_days').replace('{n}', String(daysToNext))}
                </p>
                <p className="text-[21px] font-semibold text-ink-900 tabular-nums tracking-[-0.03em] mt-0.5">
                  {formatMoney(nextInstalment.amount, loan.currency)}
                </p>
                {isLinkedLoan && (
                  <p className="text-[10.5px] text-ink-600 mt-0.5">
                    {t('ldp_linked_to_account')}
                  </p>
                )}
              </div>
            </div>
            {/* Unified payment CTA. Previously this row showed two buttons —
                "Mark Paid" (EMI lock-amount) and "Repay" (free-form) — for
                what users perceive as one action. Now a single button: for
                linked loans it routes to the settlement flow; for unlinked
                it opens RepaymentModal pre-filled with the next instalment
                amount (editable). */}
            <div className="mt-4">
              {canSettleLinked ? (
                <button
                  onClick={() => setShowSettleLinked(true)}
                  className="m-btn m-btn-primary w-full py-3 text-[13px]"
                >
                  <Glyph name="link" size={15} /> {t('loan_record_payment')}
                </button>
              ) : isLinkedLoan ? (
                <p className="text-[11px] text-ink-600 text-center py-2">
                  {t('ldp_use_linked_settle')}
                </p>
              ) : (
                <button
                  onClick={() => setSelectedEmi(nextInstalment)}
                  className="m-btn m-btn-primary w-full py-3 text-[13px]"
                >
                  <Glyph name="banknote" size={15} /> {t('loan_record_payment')}
                </button>
              )}
              <p className="text-[10.5px] text-ink-500 mt-2.5 text-center leading-relaxed">
                {canSettleLinked
                  ? t('loan_record_payment_linked_sub').replace('{person}', displayName)
                  : isLinkedLoan
                  ? null
                  : t('loan_record_payment_local_sub')}
              </p>
            </div>
          </div>
        )}

        {/* No EMI plan but loan still active → surface the unified payment
            CTA. Same vocabulary as the next-instalment card above. */}
        {!nextInstalment && loan.status === 'active' && loan.remainingAmount > 0 && (
          <div>
            {canSettleLinked ? (
              <button
                onClick={() => setShowSettleLinked(true)}
                className="m-btn m-btn-primary w-full py-3.5 text-[13.5px]"
              >
                <Glyph name="link" size={16} /> {t('loan_record_payment')}
              </button>
            ) : (
              <button
                onClick={() => setShowRepayment(true)}
                className="m-btn m-btn-primary w-full py-3.5 text-[13.5px]"
              >
                <Glyph name="banknote" size={16} /> {t('loan_record_payment')}
              </button>
            )}
            <p className="text-[10.5px] text-ink-500 mt-2.5 text-center leading-relaxed">
              {canSettleLinked
                ? t('loan_record_payment_linked_sub').replace('{person}', displayName)
                : t('loan_record_payment_local_sub')}
            </p>
          </div>
        )}

        {/* EMI schedule rows */}
        {enrichedEmis.length > 0 && (
          <div>
            <h2 className="m-label mb-2.5 px-0.5">
              {t('emi_schedule_heading')} · {paidCount}/{totalCount}
            </h2>
            <div className="m-card overflow-hidden divide-y divide-cream-hairline">
              {enrichedEmis.map((schedule) => {
                const isPaid = schedule.status === 'paid';
                const isNext = !isPaid && schedule === nextInstalment;
                return (
                  <div
                    key={schedule.id}
                    className="flex items-center gap-3 px-4 py-3"
                  >
                    {/* State square: paid (green check) / overdue (coral
                        alert) / next (violet number) / future (recessed well
                        with a clock — not due yet). */}
                    {isPaid ? (
                      <div className="m-card m-mint w-9 h-9 rounded-[12px] flex items-center justify-center shrink-0">
                        <Glyph name="check" size={16} tone="green" />
                      </div>
                    ) : schedule.isOverdue ? (
                      <div className="m-card m-coral w-9 h-9 rounded-[12px] flex items-center justify-center shrink-0">
                        <Glyph name="alert" size={16} tone="coral" />
                      </div>
                    ) : isNext ? (
                      <div className="m-card m-violet w-9 h-9 rounded-[12px] flex items-center justify-center shrink-0 text-[12.5px] font-semibold text-accent-text tabular-nums">
                        {schedule.installmentNumber}
                      </div>
                    ) : (
                      <div className="m-inset w-9 h-9 rounded-[12px] flex items-center justify-center shrink-0">
                        <Glyph name="clock" size={15} className="text-ink-400" />
                      </div>
                    )}

                    <div className="flex-1 min-w-0">
                      <p className="text-[13.5px] font-medium text-ink-900 tracking-[-0.01em]">
                        {t('emi_instalment_n').replace('{n}', String(schedule.installmentNumber))}
                      </p>
                      <p className="text-[10.5px] text-ink-600 mt-0.5">
                        {format(new Date(schedule.dueDate), 'd MMM yyyy')}
                        {isPaid && ` · ${t('emi_row_paid')}`}
                        {schedule.isOverdue && (
                          <span className="text-pay-text font-semibold"> · {t('emi_row_overdue')}</span>
                        )}
                      </p>
                    </div>
                    <div className="text-right shrink-0">
                      <p
                        className={`text-[13px] font-semibold tabular-nums ${
                          isPaid ? 'text-receive-text' : schedule.isOverdue ? 'text-pay-text' : 'text-ink-900'
                        }`}
                      >
                        {formatMoney(schedule.amount, loan.currency)}
                      </p>
                      {!isPaid && coveredUnpaidIds.has(schedule.id) ? (
                        // Already covered by money repaid → reconcile, no charge.
                        <button
                          onClick={handleReconcile}
                          disabled={reconciling}
                          className="text-[10px] text-receive-text font-semibold mt-0.5 active:opacity-70 disabled:opacity-50"
                        >
                          {t('loan_mark_paid')}
                        </button>
                      ) : !isPaid && loan.status === 'active' ? (
                        <button
                          onClick={() => setSelectedEmi(schedule)}
                          className="text-[10px] text-accent-600 font-semibold mt-0.5 active:opacity-70"
                        >
                          {t('loan_mark_paid')}
                        </button>
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Settlement history (linked loans only) */}
        {isLinkedLoan && (
          <div>
            <h2 className="m-label mb-2.5 px-0.5">
              {t('stl_history_title')}
            </h2>
            {settlementHistory.length === 0 ? (
              <p className="text-[12px] text-ink-400 text-center py-5">
                {t('stl_history_empty')}
              </p>
            ) : (
              <div className="space-y-2.5">
                {settlementHistory.map((s) => {
                  const appliedFromName =
                    s.requesterAccountId && s.fromUserId === currentUserId
                      ? accounts.find((a) => a.id === s.requesterAccountId)?.name ?? null
                      : null;
                  return (
                    <SettlementHistoryRow
                      key={s.id}
                      request={s}
                      currency={loan.currency}
                      appliedFromAccountName={appliedFromName}
                      canCancel={s.status === 'pending' && s.fromUserId === currentUserId}
                      cancelling={cancellingSettlementId === s.id}
                      onCancel={() => handleCancelSettlement(s)}
                    />
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* Transaction history */}
        <div>
          <div className="flex items-center justify-between mb-2.5 px-0.5">
            <h2 className="m-label">
              {t('tx_history')}
            </h2>
            {(loanTransactions.length > 0 || loan.remainingAmount > 0.005) && !isCardLoan && (
              <button
                type="button"
                onClick={() => { setStatementIntro(undefined); setShowStatement(true); }}
                className="min-h-[32px] text-[11.5px] font-semibold text-accent-600 flex items-center gap-1 active:opacity-70"
              >
                <Glyph name="document" size={13} /> {t('soa_cta')}
              </button>
            )}
          </div>
          {loanTransactions.length === 0 ? (
            <p className="text-[12px] text-ink-400 text-center py-5">
              {t('loan_no_tx')}
            </p>
          ) : (
            <div className="m-card px-4 divide-y divide-cream-hairline">
              {loanTransactions.map((transaction) => (
                <button
                  key={transaction.id}
                  type="button"
                  onClick={() => setSelectedTransaction(transaction)}
                  className="w-full text-left active:opacity-80 transition-opacity"
                >
                  <TransactionItem transaction={transaction} />
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Who changed what. Always present — a persistent affordance, not one
            that appears only when something looks wrong (lessons.md: never
            gate a primary capability behind an edge case). */}
        <EditHistoryRow onClick={() => setShowHistory(true)} />
      </div>

      {loan.status === 'active' && (
        <RepaymentModal
          open={showRepayment}
          onClose={() => {
            setShowRepayment(false);
            refreshLoanDetail();
          }}
          loan={loan}
          onRepaid={handleRepaid}
        />
      )}
      {loan.status === 'active' && selectedEmi && (
        <RepaymentModal
          open={!!selectedEmi}
          onClose={() => {
            setSelectedEmi(null);
            refreshLoanDetail();
          }}
          loan={loan}
          emiId={selectedEmi.id}
          presetAmount={Math.min(selectedEmi.amount, loan.remainingAmount)}
          installmentNumber={selectedEmi.installmentNumber}
          onRepaid={handleRepaid}
        />
      )}
      <Modal open={showEditDetails} onClose={() => setShowEditDetails(false)} title={t('loan_edit_details')}
        footer={
          <button onClick={handleSaveDetails} disabled={savingEdit} className="cta-primary">
            {savingEdit ? '…' : t('save')}
          </button>
        }
      >
        <div className="space-y-4">
          <div>
            <label className="form-label">{t('loan_edit_name')}</label>
            {loan.personId ? (
              <p className="m-inset text-[12px] text-ink-600 p-3 leading-relaxed">
                {t('loan_edit_name_locked')}
              </p>
            ) : (
              <input
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                className="input-field"
              />
            )}
          </div>
          <div>
            <label className="form-label">{t('quick_note')}</label>
            <input
              value={editNotes}
              onChange={(e) => setEditNotes(e.target.value)}
              placeholder={t('quick_note_placeholder')}
              className="input-field"
            />
          </div>
        </div>
      </Modal>
      <EditTransactionModal
        open={!!selectedTransaction}
        transaction={selectedTransaction}
        onClose={() => setSelectedTransaction(null)}
      />
      <PaymentReminderModal
        open={showReminder}
        onClose={() => {
          setShowReminder(false);
          setNotifPromptTrigger((n) => n + 1);
        }}
        personName={displayName || loan.personName}
        amount={loan.remainingAmount}
        currency={loan.currency}
        direction={loan.type === 'given' ? 'receivable' : 'payable'}
        startedAt={reminderStartedAt}
        hasDueDate={totalCount > 0}
        phone={(loan.personId ? persons.find((x) => x.id === loan.personId)?.phone : null) ?? null}
      />
      <NotificationPermissionPrompt trigger={notifPromptTrigger} />
      <EditHistorySheet
        open={showHistory}
        onClose={() => setShowHistory(false)}
        table="loans"
        recordId={loan.id}
        currency={loan.currency}
      />
      <SendStatementModal
        open={showStatement}
        onClose={() => { setShowStatement(false); setStatementIntro(undefined); setReceiptData(undefined); }}
        partyName={displayName || loan.personName}
        loans={[loan]}
        transactions={loanTransactions}
        scope="loan"
        phone={(loan.personId ? persons.find((x) => x.id === loan.personId)?.phone : null) ?? null}
        intro={statementIntro}
        receipt={receiptData}
      />
      {isLinkedLoan && (
        <SettleLinkedLoanModal
          open={showSettleLinked}
          onClose={() => {
            setShowSettleLinked(false);
            refreshLoanDetail();
          }}
          loan={loan}
        />
      )}
    </main>
  );
}

function SettlementHistoryRow({
  request,
  currency,
  appliedFromAccountName,
  canCancel = false,
  cancelling = false,
  onCancel,
}: {
  request: SettlementRequest;
  currency: string;
  appliedFromAccountName?: string | null;
  // True only when this is a pending request the current user sent — the only
  // case where it can still be withdrawn.
  canCancel?: boolean;
  cancelling?: boolean;
  onCancel?: () => void;
}) {
  const t = useT();
  const statusKey = (`stl_status_${request.status}`) as
    | 'stl_status_pending' | 'stl_status_accepted' | 'stl_status_rejected' | 'stl_status_cancelled';
  // Pending = violet (it lives in the Inbox), accepted = green, closed = neutral.
  const statusChip = {
    pending:   'm-chip-violet',
    accepted:  'm-chip-receive',
    rejected:  'm-chip-neutral',
    cancelled: 'm-chip-neutral',
  }[request.status];
  return (
    <div className="m-card p-3.5">
      <div className="flex items-center gap-3">
      <div className="flex-1 min-w-0">
        <p className="text-[13.5px] font-semibold text-ink-900 tabular-nums tracking-[-0.01em]">
          {formatMoney(request.amount, currency)}
        </p>
        <p className="text-[10.5px] text-ink-400 mt-0.5 tabular-nums">
          {format(new Date(request.createdAt), 'MMM d, h:mm a')}
        </p>
        {appliedFromAccountName && (
          <p className="text-[10.5px] text-accent-600 mt-0.5">
            {t('stl_applied_account').replace('{account}', appliedFromAccountName)}
          </p>
        )}
        {request.note && (
          <p className="text-[11px] text-ink-600 italic mt-1 truncate">&ldquo;{request.note}&rdquo;</p>
        )}
      </div>
      <span className={`m-chip m-chip-caps shrink-0 ${statusChip}`}>
        {t(statusKey)}
      </span>
      {request.status === 'pending' && (
        <Link
          to="/inbox"
          className="relative text-[10.5px] text-iris-text font-semibold active:opacity-70 transition-opacity flex items-center gap-0.5 before:absolute before:-inset-2 before:content-['']"
        >
          {t('stl_history_view_in_inbox')} <Glyph name="chevron-right" size={11} strokeWidth={2.8} />
        </Link>
      )}
      </div>
      {/* Withdraw a still-pending request you sent — the coral-tinted
          secondary: calm, but clearly destructive. */}
      {canCancel && onCancel && (
        <button
          type="button"
          onClick={onCancel}
          disabled={cancelling}
          className="m-btn m-btn-danger mt-3.5 w-full text-[12.5px]"
        >
          {cancelling ? t('ltr_cancelling') : t('loan_cancel_request')}
        </button>
      )}
    </div>
  );
}
