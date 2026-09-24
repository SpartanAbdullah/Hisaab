import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useAccountStore } from '../stores/accountStore';
import { useAsyncLoad } from '../hooks/useAsyncLoad';
import { PageErrorState } from '../components/PageErrorState';
import { useTransactionStore } from '../stores/transactionStore';
import { useLoanStore } from '../stores/loanStore';
import { useEmiStore } from '../stores/emiStore';
import { buildCardStatement, planStatementReanchor, type ReanchorUpdate } from '../lib/cardStatement';
import { StatementCycleField } from '../components/StatementCycleField';
import { localIso } from '../lib/thisWeek';
import { useUpcomingExpenseStore } from '../stores/upcomingExpenseStore';
import { NavyHero, TopBar } from '../components/NavyHero';
import { MoneyDisplay } from '../components/MoneyDisplay';
import { LanguageToggle } from '../components/LanguageToggle';
import { TransactionItem } from '../components/TransactionItem';
import { EditTransactionModal } from '../components/EditTransactionModal';
import { EmptyState } from '../components/EmptyState';
import { ListSkeleton } from '../components/ListSkeleton';
import { Modal } from '../components/Modal';
import { Glyph } from '../components/Glyph';
import { confirmDestructive } from '../components/ConfirmDestructiveSheet';
import { formatMoney } from '../lib/constants';
import { currencyMeta } from '../lib/design-tokens';
import { daysUntilDayOfMonth } from '../lib/inboxInfo';
import { useT, type I18nKey } from '../lib/i18n';
import type { GlyphName, GlyphTone } from '../lib/glyphs';
import { useSubmitGuard } from '../lib/useSubmitGuard';
import { ArrowLeftRight } from 'lucide-react';
import type { Account } from '../db';
import { QuickEntry, type QuickEntryPreset } from './QuickEntry';
import { useToast } from '../components/Toast';
import {
  startOfDay,
  subDays,
  startOfWeek,
  endOfWeek,
  startOfMonth,
  endOfMonth,
  startOfYear,
  endOfYear,
  subWeeks,
  subMonths,
  subYears,
  isWithinInterval,
  differenceInDays,
} from 'date-fns';
import type { Transaction } from '../db';

type TimeFilter =
  | 'all'
  | 'today'
  | 'yesterday'
  | 'this_week'
  | 'last_week'
  | 'this_month'
  | 'last_month'
  | 'this_year'
  | 'last_year';

function filterByTime(txns: Transaction[], timeFilter: TimeFilter): Transaction[] {
  if (timeFilter === 'all') return txns;
  const now = new Date();
  let start: Date;
  let end: Date;

  switch (timeFilter) {
    case 'today': start = startOfDay(now); end = now; break;
    case 'yesterday': { const yd = subDays(now, 1); start = startOfDay(yd); end = startOfDay(now); break; }
    case 'this_week': start = startOfWeek(now, { weekStartsOn: 1 }); end = endOfWeek(now, { weekStartsOn: 1 }); break;
    case 'last_week': { const lw = subWeeks(now, 1); start = startOfWeek(lw, { weekStartsOn: 1 }); end = endOfWeek(lw, { weekStartsOn: 1 }); break; }
    case 'this_month': start = startOfMonth(now); end = endOfMonth(now); break;
    case 'last_month': { const lm = subMonths(now, 1); start = startOfMonth(lm); end = endOfMonth(lm); break; }
    case 'this_year': start = startOfYear(now); end = endOfYear(now); break;
    case 'last_year': { const ly = subYears(now, 1); start = startOfYear(ly); end = endOfYear(ly); break; }
    default: return txns;
  }
  return txns.filter((tx) => isWithinInterval(new Date(tx.createdAt), { start, end }));
}

// Account-type glyph + accent (shared mapping: cash green, bank blue, wallet
// violet, savings gold, card coral).
const TYPE_GLYPH: Record<string, { glyph: GlyphName; tone: GlyphTone }> = {
  cash: { glyph: 'banknote', tone: 'green' },
  bank: { glyph: 'bank', tone: 'blue' },
  digital_wallet: { glyph: 'wallet', tone: 'violet' },
  savings: { glyph: 'savings', tone: 'gold' },
  credit_card: { glyph: 'card', tone: 'coral' },
};
const typeLabelKeys: Record<string, I18nKey> = {
  cash: 'type_cash',
  bank: 'type_bank',
  digital_wallet: 'type_wallet',
  savings: 'type_savings',
  credit_card: 'type_credit_card',
};

export function AccountDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { accounts, loadAccounts, renameAccount, deleteAccount, updateMetadata } = useAccountStore();
  const { loadTransactions, getByAccount } = useTransactionStore();
  const ensureTransactionHistory = useTransactionStore((s) => s.ensureTransactionHistory);
  const transactions = useTransactionStore((s) => s.transactions);
  const loans = useLoanStore((s) => s.loans);
  const emiSchedules = useEmiStore((s) => s.schedules);
  const { expenses, loadExpenses } = useUpcomingExpenseStore();
  const [reanchoring, setReanchoring] = useState(false);
  // Declared with the other top-level hooks (this component has early
  // returns below). Ref-backed double-tap guard for the money-mutating
  // actions on this page — opening balance, correct-balance and re-anchor.
  const submitGuard = useSubmitGuard();
  const t = useT();
  const toast = useToast();
  const navigate = useNavigate();
  const [showAdd, setShowAdd] = useState(false);
  const [quickPreset, setQuickPreset] = useState<QuickEntryPreset | null>(null);
  const [showOpeningBalance, setShowOpeningBalance] = useState(false);
  const [openingAmount, setOpeningAmount] = useState('');
  const [openingDate, setOpeningDate] = useState(() => localIso(new Date()));
  const [openingNote, setOpeningNote] = useState('');
  const [savingOpeningBalance, setSavingOpeningBalance] = useState(false);
  const [timeFilter, setTimeFilter] = useState<TimeFilter>('all');
  const [showMenu, setShowMenu] = useState(false);
  const [showCardSettings, setShowCardSettings] = useState(false);
  const [limitInput, setLimitInput] = useState('');
  const [dueDayInput, setDueDayInput] = useState('');
  const [statementDayInput, setStatementDayInput] = useState('');
  // The card's last 4 digits were only ever settable when the card was
  // added; a card created with the wrong digits kept them forever (founder,
  // 2026-09-24: CBD ••••4599 and EI ••••5828 both stored "1234"). Bank
  // alerts are matched to cards by these digits.
  const [last4Input, setLast4Input] = useState('');
  const [showRename, setShowRename] = useState(false);
  const [newName, setNewName] = useState('');
  const [showCorrect, setShowCorrect] = useState(false);
  const [correctInput, setCorrectInput] = useState('');
  const [savingCorrect, setSavingCorrect] = useState(false);
  const [selectedTransaction, setSelectedTransaction] = useState<Transaction | null>(null);

  const load = useCallback(async () => {
    await Promise.all([
      loadAccounts(),
      loadTransactions(),
      loadExpenses(),
      // Statement breakdown + instalment plans read loans/schedules — a web
      // deep-link/refresh lands here with both stores cold (Home warms them
      // otherwise). Cheap cache-first no-ops when already warm.
      useLoanStore.getState().loadLoans(),
      useEmiStore.getState().loadSchedules(),
    ]);
    // This page is an account's STATEMENT: it lists every entry that touched
    // the account and, for a credit card, derives the cycle's debt from the
    // cash-advance and bill-payment rows — origin rows that can be years old.
    // The store's default 12-month window would silently shorten both, so this
    // screen asks for the whole history (docs/performance.md §7). It is a
    // user-initiated navigation, not a boot path, and it is a no-op once
    // coverage is already complete.
    await ensureTransactionHistory({ all: true });
  }, [loadAccounts, loadTransactions, loadExpenses, ensureTransactionHistory]);
  const { status: loadStatus, error: loadError, retry: retryLoad } = useAsyncLoad(load);

  const account = accounts.find((a) => a.id === id);
  const isCreditCard = account?.type === 'credit_card';

  // Statement-native view: a card financing a cash advance bills purchases +
  // this cycle's instalment (not the whole balance), and its instalment plans
  // live INSIDE the card. Also detect advances still on their old (non-
  // statement) dates so we can offer the per-card re-anchor.
  // Hook must run unconditionally on every render (rules-of-hooks) — kept
  // above the `!account` early return below, with a null-safe body.
  const cardAdvances = useMemo(() => {
    if (!isCreditCard || !account) return { statement: null, advanceLoans: [], misaligned: [] as Array<{ loan: (typeof loans)[number]; updates: ReanchorUpdate[] }> };
    const map = new Map<string, string>();
    for (const txn of transactions) {
      if (txn.type === 'loan_taken' && txn.relatedLoanId && txn.sourceAccountId) map.set(txn.relatedLoanId, txn.sourceAccountId);
    }
    const advanceLoans = loans.filter((l) => l.status === 'active' && map.get(l.id) === account.id);
    const today = new Date();
    // Transactions sharpen "due this statement": spend after the statement
    // closed belongs to the next bill (buildCardStatement's close rule).
    const statement = buildCardStatement({ card: account, advanceLoans, schedules: emiSchedules, today, transactions });
    const dd = parseInt(account.metadata.dueDay ?? '', 10);
    const validDueDay = Number.isFinite(dd) && dd >= 1 && dd <= 31;
    // A plan needs aligning only if Align would actually move something —
    // paid and already-billed instalments are frozen, so an off-date but
    // billed instalment never keeps the banner up with nothing to do.
    const misaligned = validDueDay
      ? advanceLoans
          .map((l) => ({
            loan: l,
            updates: planStatementReanchor({
              schedules: emiSchedules.filter((s) => s.loanId === l.id),
              dueDay: dd,
              today,
            }),
          }))
          .filter((p) => p.updates.length > 0)
      : [];
    return { statement, advanceLoans, misaligned };
  }, [isCreditCard, account, loans, emiSchedules, transactions]);

  // An account that's gone (deleted here or on another device, or an old
  // link/bookmark/refresh of a deleted account's URL) is a dead end — once
  // the list has really loaded, go to Accounts instead of stranding the user
  // on a blank "not found" page. replace: so Back and refresh don't loop.
  const accountMissing = loadStatus === 'ready' && !account;
  // Set while THIS page deletes the account: its own "Account deleted"
  // toast and navigation win, so the redirect below stays silent.
  const deletingHereRef = useRef(false);
  useEffect(() => {
    if (!accountMissing || deletingHereRef.current) return;
    toast.show({ type: 'info', title: t('acct_gone_title'), subtitle: t('acct_gone_sub') });
    navigate('/accounts', { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountMissing]);

  // Don't render "account not found" until the accounts list has actually
  // finished loading — otherwise a deep-link to /account/:id flashes the
  // not-found screen for ~1s while Supabase responds.
  if (!account) {
    if (loadStatus === 'error') {
      return (
        <PageErrorState
          title={t('adp_err_load')}
          message={loadError ?? t('adp_err_load_sub')}
          onRetry={retryLoad}
        />
      );
    }
    if (loadStatus === 'loading') {
      // Skeleton in the page's own geometry — hero figure, action tiles,
      // then the statement list — so nothing jumps when the account lands.
      return (
        <main className="min-h-dvh bg-cream-bg pb-28">
          <NavyHero>
            <TopBar title="" back />
            <div className="px-5 pb-7" aria-hidden="true">
              <div className="flex items-center gap-3 mb-4">
                <div className="m-skel w-11 h-11 rounded-[14px]" />
                <div className="m-skel h-[11px] w-28" />
              </div>
              <div className="m-skel h-10 w-52 rounded-xl" />
            </div>
          </NavyHero>
          <div className="sukoon-body min-h-[60dvh] px-5 pt-5 space-y-4">
            <p className="sr-only">{t('loading')}</p>
            <div className="grid grid-cols-3 gap-2.5" aria-hidden="true">
              {[0, 1, 2].map((i) => (
                <div key={i} className="m-skel rounded-[15px] h-[70px]" />
              ))}
            </div>
            <ListSkeleton rows={4} />
          </div>
        </main>
      );
    }
    // Shown only for the moment before the redirect above lands — and as the
    // way out if it ever can't: a real page with a back button and actions.
    return (
      <main className="min-h-dvh bg-cream-bg pb-28">
        <NavyHero>
          <TopBar title="" back />
          <div className="pb-7" />
        </NavyHero>
        <div className="sukoon-body min-h-[60dvh] px-5 pt-5">
          <EmptyState
            clayIcon="wallet"
            title={t('account_not_found')}
            description={t('acct_gone_sub')}
            actionLabel={t('acct_gone_cta')}
            onAction={() => navigate('/accounts', { replace: true })}
            secondaryActionLabel={t('acct_gone_home')}
            onSecondaryAction={() => navigate('/', { replace: true })}
          />
        </div>
      </main>
    );
  }

  const accountTxns = getByAccount(account.id);
  const typeGlyph = TYPE_GLYPH[account.type] ?? TYPE_GLYPH.cash;
  const meta = currencyMeta[account.currency];
  const creditLimit = isCreditCard ? parseFloat(account.metadata.creditLimit || '0') : 0;
  const used = isCreditCard ? creditLimit - account.balance : 0;

  const handleReanchor = () => submitGuard.run(runReanchor);

  const runReanchor = async () => {
    const dd = parseInt(account.metadata.dueDay ?? '', 10);
    if (!Number.isFinite(dd) || dd < 1 || dd > 31) return;
    setReanchoring(true);
    try {
      // Count PLANS actually re-anchored (a plan counts if any of its
      // instalments moved), so the toast never claims a no-op succeeded.
      let plansMoved = 0;
      // Plan from the LIVE store at tap time (not the memo) — paid and
      // already-billed instalments are frozen; only future ones move.
      const live = useEmiStore.getState().schedules;
      for (const { loan: l } of cardAdvances.misaligned) {
        const updates = planStatementReanchor({
          schedules: live.filter((s) => s.loanId === l.id),
          dueDay: dd,
          today: new Date(),
        });
        const moved = await useEmiStore.getState().reanchorToStatementDay(l.id, updates);
        if (moved > 0) plansMoved += 1;
      }
      if (plansMoved > 0) {
        toast.show({ type: 'success', title: t('reanchor_done').replace('{n}', String(plansMoved)) });
      } else {
        toast.show({ type: 'info', title: t('reanchor_none') });
      }
    } catch {
      toast.show({ type: 'error', title: t('error') });
    } finally {
      setReanchoring(false);
    }
  };

  const accountUpcoming = expenses.filter(
    (e) => e.accountId === account.id && e.status === 'upcoming',
  );
  const totalUpcoming = accountUpcoming.reduce((s, e) => s + e.amount, 0);
  const hasWarning = totalUpcoming > account.balance;

  const hasNoTransactions = accountTxns.length === 0;
  const isZeroBalance = account.balance === 0;
  const showOpeningBalancePrompt = hasNoTransactions && isZeroBalance;

  // Only show the "How this affects Your Money" breakdown when there's
  // actual math to explain. With zero credit cards in the user's
  // portfolio, every account contributes its balance one-for-one — the
  // card would just say "Balance = +Balance" which is noise. The moment
  // any credit card exists somewhere (this account or elsewhere), the
  // breakdown earns its space by making the +/− contribution visible
  // per account.
  const showMoneyMath = accounts.some((a) => a.type === 'credit_card');

  const TIME_FILTERS: { label: string; value: TimeFilter }[] = [
    { label: t('time_all'), value: 'all' },
    { label: t('time_today'), value: 'today' },
    { label: t('time_yesterday'), value: 'yesterday' },
    { label: t('time_this_week'), value: 'this_week' },
    { label: t('time_last_week'), value: 'last_week' },
    { label: t('time_this_month'), value: 'this_month' },
    { label: t('time_last_month'), value: 'last_month' },
    { label: t('time_this_year'), value: 'this_year' },
    { label: t('time_last_year'), value: 'last_year' },
  ];

  const filteredTxns = filterByTime(accountTxns, timeFilter);

  const closeOpeningBalance = () => {
    setShowOpeningBalance(false);
    setOpeningAmount('');
    setOpeningDate(localIso(new Date()));
    setOpeningNote('');
  };

  const saveOpeningBalance = () => submitGuard.run(runSaveOpeningBalance);

  const runSaveOpeningBalance = async () => {
    const amount = parseFloat(openingAmount);
    if (!amount || amount <= 0) return;
    setSavingOpeningBalance(true);
    try {
      await useTransactionStore.getState().processTransaction({
        type: 'opening_balance',
        amount,
        destinationAccountId: account.id,
        notes: openingNote.trim() || t('tx_opening_balance'),
        createdAt: openingDate ? new Date(`${openingDate}T12:00:00`).toISOString() : undefined,
      });
      await Promise.all([loadAccounts(), loadTransactions()]);
      toast.show({ type: 'success', title: t('acct_opening_saved') });
      closeOpeningBalance();
    } catch (err) {
      toast.show({ type: 'error', title: err instanceof Error ? err.message : 'Failed' });
    } finally {
      setSavingOpeningBalance(false);
    }
  };

  return (
    <main className="min-h-dvh bg-cream-bg pb-28">
      <NavyHero>
        <TopBar
          title={account.name}
          back
          action={
            <div className="flex items-center gap-2">
              <button
                onClick={() => {
                  setQuickPreset({ accountId: account.id, lockAccount: true });
                  setShowAdd(true);
                }}
                className="m-ctl h-9 px-3 flex items-center gap-1.5 text-[11.5px] font-semibold text-accent-text"
                aria-label={t('add_entry')}
              >
                <Glyph name="plus" size={13} strokeWidth={3} /> {t('add_entry')}
              </button>
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
                    {/* This menu renders INSIDE the hero, which re-scopes the
                        material and accent tokens to their dark values — so
                        it deliberately uses only un-scoped tokens (cream-soft
                        surface, ink text, pay-700) to stay a light sheet in
                        the light theme and a dark one in dark. */}
                    <div className="absolute right-0 top-11 z-50 bg-cream-soft rounded-2xl border border-cream-border shadow-[0_18px_40px_-12px_rgba(0,0,0,0.45)] py-1.5 w-48 animate-fade-in">
                      <button
                        onClick={() => {
                          setShowMenu(false);
                          setNewName(account.name);
                          setShowRename(true);
                        }}
                        className="w-full px-4 py-2.5 min-h-[44px] flex items-center gap-2.5 text-[13px] font-medium text-ink-800 active:bg-cream-bg"
                      >
                        <Glyph name="edit" size={15} className="text-ink-500" /> {t('rename')}
                      </button>
                      <button
                        onClick={() => {
                          setShowMenu(false);
                          setCorrectInput(String(account.balance));
                          setShowCorrect(true);
                        }}
                        className="w-full px-4 py-2.5 min-h-[44px] flex items-center gap-2.5 text-[13px] font-medium text-ink-800 active:bg-cream-bg"
                      >
                        <Glyph name="sliders" size={15} className="text-ink-500" /> {t('acct_correct_balance')}
                      </button>
                      <button
                        onClick={async () => {
                          setShowMenu(false);
                          if (account.balance !== 0) {
                            toast.show({
                              type: 'error',
                              title: t('acct_delete_nonzero'),
                              subtitle: t('acct_delete_nonzero_desc'),
                            });
                            return;
                          }
                          const ok = await confirmDestructive({
                            title: t('acct_delete_confirm'),
                            description: t('del_account_body'),
                            confirmLabel: t('adp_delete_account_cta'),
                          });
                          if (ok) {
                            try {
                              deletingHereRef.current = true;
                              await deleteAccount(account.id);
                              toast.show({ type: 'success', title: t('acct_deleted') });
                              // Replace, don't push: Back must never return
                              // to the page of an account that's gone.
                              navigate('/accounts', { replace: true });
                            } catch (err) {
                              deletingHereRef.current = false;
                              toast.show({
                                type: 'error',
                                title: err instanceof Error ? err.message : t('adp_failed'),
                              });
                            }
                          }
                        }}
                        className="w-full px-4 py-2.5 min-h-[44px] flex items-center gap-2.5 text-[13px] font-medium text-pay-700 active:bg-cream-bg"
                      >
                        <Glyph name="trash" size={15} /> {t('common_delete')}
                      </button>
                    </div>
                  </>
                )}
              </div>
              <LanguageToggle />
            </div>
          }
        />

        <div className="px-5 pb-7">
          <div className="flex items-center gap-3 mb-4">
            <div className="m-ctl w-11 h-11 rounded-[14px] flex items-center justify-center shrink-0">
              <Glyph name={typeGlyph.glyph} tone={typeGlyph.tone} size={21} extrude />
            </div>
            <div className="min-w-0">
              <p className="text-[10.5px] font-semibold text-white/70 tracking-[0.12em] uppercase">
                {typeLabelKeys[account.type] ? t(typeLabelKeys[account.type]) : account.type.replace('_', ' ')}
              </p>
              <p className="text-[11.5px] text-white/70 flex items-center gap-1 mt-0.5">
                <span>{meta?.flag}</span> {account.currency}
                {account.metadata.bankName && (
                  <span className="text-white/60"> · {account.metadata.bankName}</span>
                )}
              </p>
            </div>
          </div>

          <p className="text-[10.5px] font-semibold text-white/70 tracking-[0.12em] uppercase">
            {isCreditCard ? t('cc_available') : t('label_balance')}
          </p>
          <div className="mt-2">
            <MoneyDisplay
              amount={account.balance}
              currency={account.currency}
              size={38}
              tone="on-navy"
              extrude="violet"
            />
          </div>

          {isCreditCard && creditLimit > 0 && (() => {
            const utilPct = Math.max(0, Math.min(100, (used / creditLimit) * 100));
            // Coral when nearly maxed, gold mid-range, white when healthy.
            const barColor = utilPct >= 80
              ? 'bg-gradient-to-r from-pay-600 to-pay-700'
              : utilPct >= 50
                ? 'bg-gradient-to-r from-gold-300 to-gold-700'
                : 'bg-white/85';
            const dueDay = account.metadata.dueDay ? parseInt(account.metadata.dueDay, 10) : NaN;
            const dueIn = daysUntilDayOfMonth(dueDay, new Date());
            const dueUrgent = dueIn !== null && dueIn <= 3;
            return (
              <>
                <div className="mt-4 h-[7px] rounded-full bg-white/10 shadow-[inset_0_1px_2px_rgba(0,0,0,0.5)] overflow-hidden">
                  <div
                    className={`h-full rounded-full ${barColor} transition-all duration-500`}
                    style={{ width: `${utilPct}%` }}
                  />
                </div>
                <div className="flex justify-between gap-3 mt-2 text-[11px]">
                  <span className="text-white/70 tabular-nums">
                    {used < -0.005
                      ? t('acct_overpaid').replace('{amount}', formatMoney(Math.abs(used), account.currency))
                      : <>{t('cc_used')}: {formatMoney(used, account.currency)} · {Math.round(utilPct)}%</>}
                  </span>
                  <span className="text-white/85 font-medium tabular-nums text-right">
                    {t('cc_limit')}: {formatMoney(creditLimit, account.currency)}
                  </span>
                </div>
                {/* Available above the limit is almost always a double-recorded
                    payment, never a healthy state — say so instead of the old
                    silent "0%" and point at the repair tool. */}
                {used < -0.005 && (
                  <button
                    type="button"
                    onClick={() => { setCorrectInput(String(creditLimit)); setShowCorrect(true); }}
                    className="mt-3 w-full text-left rounded-2xl bg-white/10 p-3 flex items-start gap-2.5 active:bg-white/15 transition-colors"
                  >
                    <Glyph name="alert" size={15} className="text-warn-700 mt-0.5" />
                    <p className="text-[11.5px] text-white/90 leading-relaxed font-medium">
                      {t('acct_over_limit_hint')}
                    </p>
                  </button>
                )}
                {account.metadata.dueDay && (
                  <div className={`mt-3 inline-flex items-center gap-1.5 rounded-full bg-white/10 px-3 py-1 text-[11px] font-semibold ${dueUrgent ? 'text-pay-text' : 'text-warn-700'}`}>
                    <Glyph name="calendar" size={12} />
                    {t('cc_next_due')}: {account.metadata.dueDay}
                    {getOrdinal(parseInt(account.metadata.dueDay))}
                    {dueIn !== null && (
                      <span className="text-white/85 font-medium">
                        {' · '}
                        {dueIn === 0 ? t('cc_due_today') : t('cc_due_in').replace('{n}', String(dueIn))}
                      </span>
                    )}
                  </div>
                )}
              </>
            );
          })()}
        </div>
      </NavyHero>

      <div className="sukoon-body min-h-[60dvh] px-5 pt-5 space-y-4">
        {/* Per-card re-anchor migration (user-approved, date-only): shift this
            card's cash-advance instalments onto its statement day. */}
        {isCreditCard && cardAdvances.misaligned.length > 0 && account.metadata.dueDay && (
          <div className="m-card m-violet p-4">
            <div className="flex items-center gap-2 mb-1">
              <Glyph name="calendar" size={16} tone="violet" />
              <p className="text-[13.5px] font-semibold text-ink-900 tracking-tight">{t('reanchor_title')}</p>
            </div>
            <p className="text-[12px] text-ink-600 leading-relaxed">
              {t('reanchor_body').replace('{day}', `${account.metadata.dueDay}${getOrdinal(parseInt(account.metadata.dueDay))}`)}
            </p>
            <div className="flex gap-2 mt-3">
              <button
                onClick={handleReanchor}
                disabled={reanchoring}
                className="cta-primary flex-1 disabled:opacity-50"
              >
                {reanchoring ? t('reanchor_working') : t('reanchor_cta')}
              </button>
            </div>
          </div>
        )}

        {/* Statement breakdown — only when the card finances an instalment
            plan (otherwise the hero's "used" already IS the statement). The
            honest monthly bill: purchases/carried + this cycle's instalment. */}
        {isCreditCard && cardAdvances.statement && (cardAdvances.advanceLoans.length > 0 || cardAdvances.statement.postCloseSpend > 0.005) && cardAdvances.statement.statementDue > 0.005 && (
          <div className="m-card p-4">
            <div className="flex items-center justify-between mb-2">
              <p className="text-[10.5px] font-semibold text-ink-500 uppercase tracking-[0.12em]">{t('cc_statement_title')}</p>
              {cardAdvances.statement.daysUntilDue !== null && (
                <span className="m-chip m-chip-gold tabular-nums">
                  {cardAdvances.statement.daysUntilDue === 0 ? t('cc_due_today') : t('cc_due_in').replace('{n}', String(cardAdvances.statement.daysUntilDue))}
                </span>
              )}
            </div>
            <p className="text-[24px] font-semibold text-ink-900 tabular-nums tracking-[-0.03em]">
              {formatMoney(cardAdvances.statement.statementDue, account.currency)}
            </p>
            {/* Two-date cycle, when a distinct statement day is set. */}
            {cardAdvances.statement.statementDay !== cardAdvances.statement.dueDay && (
              <p className="text-[10.5px] text-ink-400 mt-0.5 tabular-nums">
                {t('cc_cycle_closes_on').replace('{d}', `${cardAdvances.statement.statementDay}${getOrdinal(cardAdvances.statement.statementDay)}`)}
                {' · '}
                {t('cc_cycle_due_on').replace('{d}', `${cardAdvances.statement.dueDay}${getOrdinal(cardAdvances.statement.dueDay)}`)}
              </p>
            )}
            <div className="mt-2 space-y-1 text-[11.5px] text-ink-600 tabular-nums">
              {cardAdvances.statement.statementRevolving > 0.005 && (
                <div className="flex justify-between">
                  <span>{t('cc_statement_purchases')}</span>
                  <span>{formatMoney(cardAdvances.statement.statementRevolving, account.currency)}</span>
                </div>
              )}
              {cardAdvances.statement.instalmentDue > 0.005 && (
                <div className="flex justify-between">
                  <span>{t('cc_statement_instalment')}</span>
                  <span>{formatMoney(cardAdvances.statement.instalmentDue, account.currency)}</span>
                </div>
              )}
              {/* Spend after the statement closed — owed, but on the NEXT
                  bill, so it's shown here and kept out of the figure above. */}
              {cardAdvances.statement.postCloseSpend > 0.005 && (
                <div className="flex justify-between text-ink-400">
                  <span>{t('cc_statement_after_close')}</span>
                  <span>{formatMoney(cardAdvances.statement.postCloseSpend, account.currency)}</span>
                </div>
              )}
              <div className="flex justify-between pt-1 border-t border-cream-hairline text-ink-400">
                <span>{t('cc_statement_total_balance')}</span>
                <span>{formatMoney(cardAdvances.statement.totalOwed, account.currency)}</span>
              </div>
            </div>
          </div>
        )}

        {/* Instalment plans — the cash-advance summary the user asked for:
            how much taken, when, how many instalments, paid, remaining. One
            card per active advance; tap opens the loan's full history. */}
        {isCreditCard && cardAdvances.advanceLoans.length > 0 && (
          <div>
            <h2 className="text-[10.5px] font-semibold text-ink-500 uppercase tracking-[0.12em] mb-2.5 px-1">
              {t('ca_plans_title')}
            </h2>
            <div className="space-y-2.5">
              {cardAdvances.advanceLoans.map((adv) => {
                const plan = emiSchedules
                  .filter((s) => s.loanId === adv.id)
                  .sort((a, b) => a.installmentNumber - b.installmentNumber);
                const paidAmount = Math.max(0, Math.round((adv.totalAmount - adv.remainingAmount) * 100) / 100);
                // Count + next from COVERAGE, not schedule statuses: money is
                // the source of truth, so "{p} of {n} — {amount}" can never
                // contradict itself even if a status drifted (e.g. an edited-
                // down targeted payment that still flipped its instalment).
                let cumulative = 0;
                let paidCount = 0;
                let nextUnpaid: (typeof plan)[number] | undefined;
                for (const s of plan) {
                  cumulative = Math.round((cumulative + s.amount) * 100) / 100;
                  if (cumulative <= paidAmount + 0.00001) paidCount += 1;
                  else if (!nextUnpaid) nextUnpaid = s;
                }
                const pct = adv.totalAmount > 0 ? Math.min(100, (paidAmount / adv.totalAmount) * 100) : 0;
                return (
                  <button
                    key={adv.id}
                    onClick={() => navigate(`/loan/${adv.id}`)}
                    className="m-tile p-4"
                  >
                    <div className="flex items-baseline justify-between gap-2">
                      <p className="text-[15px] font-semibold text-ink-900 tabular-nums tracking-tight">
                        {formatMoney(adv.totalAmount, adv.currency)}
                      </p>
                      <span className="m-chip m-chip-gold m-chip-caps shrink-0">
                        {t('ca_pill')}
                      </span>
                    </div>
                    <p className="text-[11px] text-ink-500 mt-0.5 tabular-nums">
                      {t('ca_taken_on').replace('{date}', new Date(adv.createdAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }))}
                      {plan.length > 0 && <> · {t('ca_plan_count').replace('{n}', String(plan.length))}</>}
                    </p>
                    <div className="m-inset relative mt-3 h-2 rounded-full overflow-hidden">
                      <div className="h-full rounded-full bg-gradient-to-r from-receive-600 to-receive-700 transition-all" style={{ width: `${pct}%` }} />
                    </div>
                    <div className="flex items-baseline justify-between mt-2 text-[11px] tabular-nums">
                      <span className="text-receive-text font-semibold">
                        {plan.length > 0
                          ? t('ca_paid_progress').replace('{p}', String(paidCount)).replace('{n}', String(plan.length)).replace('{amount}', formatMoney(paidAmount, adv.currency))
                          : t('ca_paid_plain').replace('{amount}', formatMoney(paidAmount, adv.currency))}
                      </span>
                      <span className="text-ink-600 font-semibold">
                        {t('ca_remaining').replace('{amount}', formatMoney(adv.remainingAmount, adv.currency))}
                      </span>
                    </div>
                    {nextUnpaid && (
                      <p className="text-[10.5px] text-ink-500 mt-1.5 tabular-nums">
                        {t('ca_next_instalment')
                          .replace('{amount}', formatMoney(nextUnpaid.amount, adv.currency))
                          .replace('{date}', new Date(`${nextUnpaid.dueDate}T12:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }))}
                      </p>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Account-scoped quick-action tiles, PERSONALIZED per account type.
            A credit card is not a wallet: you can't "receive" into it, and
            moving/splitting from it makes no sense — its real verbs are
            spend, pay the bill, take a cash advance, and adjust the limit.
            Other account types keep the full Spend/Receive/Move + person +
            group set. Locked account context flows through the preset. */}
        {isCreditCard ? (
          <div className="grid grid-cols-2 gap-2.5">
            <button
              type="button"
              onClick={() => {
                setQuickPreset({ type: 'expense', accountId: account.id, lockAccount: true });
                setShowAdd(true);
              }}
              className="m-tile px-3 py-3.5 flex items-center justify-center gap-2 text-[12.5px] font-semibold text-ink-800"
            >
              <Glyph name="arrow-up" tone="coral" size={17} />
              {t('acct_action_card_spend')}
            </button>
            <button
              type="button"
              onClick={() => {
                setQuickPreset({ type: 'transfer', destinationAccountId: account.id });
                setShowAdd(true);
              }}
              className="m-tile m-violet px-3 py-3.5 flex items-center justify-center gap-2 text-[12.5px] font-semibold text-accent-text"
            >
              <Glyph name="card" tone="violet" size={17} />
              {t('acct_action_pay_card')}
            </button>
            <button
              type="button"
              onClick={() => {
                setQuickPreset({ type: 'loan_taken', cashAdvanceCardId: account.id });
                setShowAdd(true);
              }}
              className="m-tile px-3 py-3.5 flex items-center justify-center gap-2 text-[12.5px] font-semibold text-ink-800"
            >
              <Glyph name="banknote" tone="violet" size={17} />
              {t('acct_action_cash_advance')}
            </button>
            <button
              type="button"
              onClick={() => {
                setLimitInput(account.metadata.creditLimit ?? '');
                setDueDayInput(account.metadata.dueDay ?? '');
                setStatementDayInput(account.metadata.statementDay ?? '');
                setLast4Input(account.metadata.last4 ?? '');
                setShowCardSettings(true);
              }}
              className="m-tile px-3 py-3.5 flex items-center justify-center gap-2 text-[12.5px] font-semibold text-ink-800"
            >
              <Glyph name="sliders" tone="neutral" size={17} />
              {t('acct_action_card_settings')}
            </button>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-3 gap-2.5">
              {[
                { type: 'expense' as const, label: t('intent_spend'), glyph: 'arrow-up' as const, tone: 'coral' as const },
                { type: 'income' as const, label: t('intent_receive'), glyph: 'arrow-down' as const, tone: 'green' as const },
                { type: 'transfer' as const, label: t('intent_move'), glyph: 'swap' as const, tone: 'blue' as const },
              ].map((action) => (
                <button
                  key={action.type}
                  type="button"
                  onClick={() => {
                    setQuickPreset({ type: action.type, accountId: account.id, lockAccount: true });
                    setShowAdd(true);
                  }}
                  className="m-tile px-2 pt-3.5 pb-3 flex flex-col items-center gap-2 text-center text-[12px] font-semibold text-ink-800"
                >
                  <Glyph name={action.glyph} tone={action.tone} size={22} extrude />
                  {action.label}
                </button>
              ))}
            </div>
            <div className="grid grid-cols-2 gap-2.5">
              <button
                type="button"
                onClick={() => {
                  setQuickPreset({ intent: 'person_money', accountId: account.id, lockAccount: true });
                  setShowAdd(true);
                }}
                className="m-tile px-3 py-3.5 flex items-center justify-center gap-2 text-[12px] font-semibold text-ink-800"
              >
                <Glyph name="person" tone="pink" size={18} />
                {t('acct_action_person')}
              </button>
              <button
                type="button"
                onClick={() => {
                  // Group expense uses splits across multiple accounts; the
                  // account context isn't locked here.
                  setQuickPreset({ intent: 'group_expense' });
                  setShowAdd(true);
                }}
                className="m-tile px-3 py-3.5 flex items-center justify-center gap-2 text-[12px] font-semibold text-ink-800"
              >
                <Glyph name="groups" tone="blue" size={18} />
                {t('acct_action_group')}
              </button>
            </div>
          </>
        )}
        {/* "How this affects Your Money" breakdown. Only renders when the
            user actually has at least one credit card in their portfolio
            — otherwise the math is trivially Balance = Balance and the
            card is pure noise. Two variants below: credit cards do
            limit/used/owed math; regular accounts show a single-line
            "added to your money" so the user can trace the contribution
            into the dashboard total. */}
        {showMoneyMath && (
          <MoneyMathCard
            account={account}
            isCreditCard={isCreditCard}
            creditLimit={creditLimit}
            used={used}
          />
        )}

        {/* Opening balance prompt — only when no txns + zero balance */}
        {showOpeningBalancePrompt && (
          <div className="m-card m-card-feature p-5 flex flex-col items-center text-center">
            <div className="m-plate m-violet mb-3" aria-hidden>
              <Glyph name="wallet" tone="violet" size={26} extrude />
            </div>
            <p className="text-[13.5px] font-semibold text-ink-900 tracking-tight mb-4 max-w-[260px]">
              {t('acct_opening_bal_prompt')}
            </p>
            <button
              onClick={() => setShowOpeningBalance(true)}
              className="m-btn m-btn-primary px-5 text-[13px]"
            >
              {t('acct_add_opening_bal')}
            </button>
          </div>
        )}

        {/* Upcoming expense warning */}
        {accountUpcoming.length > 0 && (
          <div className={`m-card ${hasWarning ? 'm-coral' : 'm-gold'} p-4`}>
            <div className="flex items-center gap-2.5">
              <Glyph name="alert" size={17} tone={hasWarning ? 'coral' : 'gold'} />
              <div className="flex-1">
                <p
                  className={`text-[11px] font-semibold uppercase tracking-[0.1em] ${
                    hasWarning ? 'text-pay-text' : 'text-warn-700'
                  }`}
                >
                  {accountUpcoming.length} {t('upcoming_title')}
                </p>
                <p className="text-[11.5px] text-ink-600">
                  {t('adp_total_label').replace('{amount}', formatMoney(totalUpcoming, account.currency))}
                  {hasWarning && ` — ${t('upcoming_low_balance')}!`}
                </p>
              </div>
            </div>
            <div className="mt-3 space-y-2">
              {accountUpcoming.slice(0, 3).map((e) => {
                const daysLeft = differenceInDays(new Date(e.dueDate), new Date());
                return (
                  <div
                    key={e.id}
                    className="flex items-center justify-between gap-3 text-[11.5px]"
                  >
                    <span className="text-ink-800 font-medium truncate">{e.title}</span>
                    <div className="flex items-center gap-2 shrink-0">
                      <span className="text-ink-900 font-semibold tabular-nums">
                        {formatMoney(e.amount, e.currency)}
                      </span>
                      <span
                        className={`text-[10px] font-semibold ${
                          daysLeft < 0
                            ? 'text-pay-text'
                            : daysLeft <= 3
                            ? 'text-warn-600'
                            : 'text-ink-500'
                        }`}
                      >
                        {daysLeft < 0
                          ? t('upcoming_overdue')
                          : daysLeft === 0
                          ? t('upcoming_due_today')
                          : `${daysLeft} ${t('upcoming_due_in')}`}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Time filter — one recessed segmented track. */}
        <div className="overflow-x-auto no-scrollbar -mx-1 px-1">
          <div className="m-seg">
            {TIME_FILTERS.map((f) => (
              <button
                key={f.value}
                type="button"
                onClick={() => setTimeFilter(f.value)}
                aria-pressed={timeFilter === f.value}
                className="shrink-0 whitespace-nowrap"
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>

        {timeFilter !== 'all' && (
          <p className="text-[11px] text-ink-500 font-semibold px-1">
            {filteredTxns.length} {t('time_results')}
          </p>
        )}

        {/* Transaction history */}
        <div>
          <h2 className="text-[10.5px] font-semibold text-ink-500 uppercase tracking-[0.12em] mb-2.5 px-1">
            {t('tx_history')}
          </h2>
          {filteredTxns.length === 0 ? (
            <EmptyState
              icon={ArrowLeftRight}
              clayIcon="swap"
              tone="violet"
              size="compact"
              title={t('no_tx')}
              description={t('no_tx_desc')}
              actionLabel={t('txpage_add')}
              onAction={() => setShowAdd(true)}
            />
          ) : (
            <div className="m-card px-4 divide-y divide-cream-hairline">
              {filteredTxns.map((txn) => (
                <TransactionItem
                  key={txn.id}
                  transaction={txn}
                  accountContextId={account.id}
                  onClick={() => setSelectedTransaction(txn)}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      <QuickEntry
        open={showAdd}
        preset={quickPreset}
        onClose={() => {
          setShowAdd(false);
          setQuickPreset(null);
        }}
      />
      <Modal
        open={showOpeningBalance}
        onClose={closeOpeningBalance}
        title={t('acct_opening_title')}
        footer={
          <button
            onClick={saveOpeningBalance}
            disabled={savingOpeningBalance || !parseFloat(openingAmount) || !openingDate}
            className="cta-primary"
          >
            {savingOpeningBalance ? t('quick_processing') : t('acct_opening_save')}
          </button>
        }
      >
        <div className="space-y-4">
          <p className="text-[12px] text-ink-600 leading-relaxed">{t('acct_opening_help')}</p>
          <div>
            <label className="form-label">
              {t('acct_opening_amount')}
            </label>
            <input
              type="number"
              step="0.01"
              min="0"
              value={openingAmount}
              onChange={(e) => setOpeningAmount(e.target.value)}
              placeholder="0.00"
              autoFocus
              className="input-field text-center text-lg font-semibold tabular-nums"
            />
          </div>
          <div>
            <label className="form-label">
              {t('acct_opening_date')}
            </label>
            <input
              type="date"
              value={openingDate}
              onChange={(e) => setOpeningDate(e.target.value)}
              className="input-field"
            />
          </div>
          <div>
            <label className="form-label">
              {t('quick_note')}
            </label>
            <input
              value={openingNote}
              onChange={(e) => setOpeningNote(e.target.value)}
              placeholder={t('acct_opening_note_placeholder')}
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
      {/* The three centred dialogs live at the page root, not inside
          .sukoon-body: that sheet is its own stacking context (z-index 1),
          so a z-50 dialog inside it painted UNDER the fixed bottom nav
          (z-40) — the nav covered Card settings' Save button on short
          screens (found 2026-09-25). */}
      {/* Rename modal (lightweight — kept inline since the Modal helper is
          optimised for the bottom-sheet pattern, not centred dialogs) */}
      {showRename && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--m-scrim)] backdrop-blur-sm animate-fade-in"
          role="presentation"
          onClick={() => setShowRename(false)}
        >
          <div
            className="m-card m-card-feature p-5 w-[90%] max-w-sm"
            role="presentation"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-[15px] font-semibold text-ink-900 tracking-tight mb-3">{t('adp_rename_title')}</h3>
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              autoFocus
              className="input-field mb-4"
            />
            <div className="flex gap-2.5">
              <button
                onClick={() => setShowRename(false)}
                className="m-btn m-btn-plain flex-1 text-[13px]"
              >
                {t('cancel')}
              </button>
              <button
                disabled={!newName.trim() || newName.trim() === account.name}
                onClick={async () => {
                  if (newName.trim() && newName.trim() !== account.name) {
                    await renameAccount(account.id, newName.trim());
                    toast.show({ type: 'success', title: t('adp_renamed') });
                  }
                  setShowRename(false);
                }}
                className="m-btn m-btn-primary flex-1 text-[13px]"
              >
                {t('common_save')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Card settings dialog — the card's limit changes in real life
          (bank raises/lowers it) and the app must keep up. Same inline
          centred-dialog pattern as Rename. */}
      {showCardSettings && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--m-scrim)] backdrop-blur-sm animate-fade-in"
          role="presentation"
          onClick={() => setShowCardSettings(false)}
        >
          <div
            className="m-card m-card-feature p-5 w-[90%] max-w-sm max-h-[90dvh] overflow-y-auto"
            role="presentation"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-[15px] font-semibold text-ink-900 tracking-tight mb-3">{t('cc_settings_title')}</h3>
            <label className="form-label">
              {t('cc_settings_limit')} ({account.currency})
            </label>
            <input
              type="number"
              min="0"
              step="0.01"
              value={limitInput}
              onChange={(e) => setLimitInput(e.target.value)}
              autoFocus
              className="input-field tabular-nums mb-3"
            />
            <div className="mb-4">
              <StatementCycleField
                statementDay={statementDayInput}
                dueDay={dueDayInput}
                onStatementDay={setStatementDayInput}
                onDueDay={setDueDayInput}
              />
            </div>
            <label className="form-label">{t('cc_last4')}</label>
            <input
              value={last4Input}
              onChange={(e) => setLast4Input(e.target.value.replace(/\D/g, '').slice(0, 4))}
              placeholder="e.g. 4521"
              maxLength={4}
              inputMode="numeric"
              className="input-field text-center font-bold tracking-[0.3em] tabular-nums"
            />
            <p className="text-[11px] text-ink-500 mt-1.5 mb-4 leading-relaxed">{t('cc_last4_hint')}</p>
            <div className="flex gap-2.5">
              <button
                onClick={() => setShowCardSettings(false)}
                className="m-btn m-btn-plain flex-1 text-[13px]"
              >
                {t('cancel')}
              </button>
              <button
                disabled={(() => {
                  const lim = parseFloat(limitInput);
                  if (!Number.isFinite(lim) || lim <= 0) return true;
                  // Exactly 4 digits, or blank to clear.
                  if (last4Input !== '' && !/^\d{4}$/.test(last4Input)) return true;
                  if (dueDayInput.trim() !== '') {
                    const d = parseInt(dueDayInput, 10);
                    if (!Number.isInteger(d) || d < 1 || d > 31) return true;
                  }
                  return false;
                })()}
                onClick={async () => {
                  try {
                    const sdRaw = parseInt(statementDayInput, 10);
                    const oldLast4 = account.metadata.last4 ?? '';
                    await updateMetadata(account.id, {
                      creditLimit: String(parseFloat(limitInput)),
                      dueDay: dueDayInput.trim() === '' ? '' : String(parseInt(dueDayInput, 10)),
                      // Blank clears it → the model falls back to the due day.
                      statementDay: Number.isFinite(sdRaw) && sdRaw >= 1 && sdRaw <= 31 ? String(sdRaw) : '',
                      // Blank deletes the key (updateMetadata semantics).
                      last4: last4Input,
                    });
                    // A card named from its digits ("CBD ••••1234", the
                    // add-card default) follows the correction; a name the
                    // user wrote themselves is left alone.
                    if (oldLast4 && last4Input && oldLast4 !== last4Input && account.name.includes(`••••${oldLast4}`)) {
                      await renameAccount(account.id, account.name.replace(`••••${oldLast4}`, `••••${last4Input}`));
                    }
                    toast.show({ type: 'success', title: t('cc_settings_saved') });
                    setShowCardSettings(false);
                  } catch (err) {
                    toast.show({ type: 'error', title: err instanceof Error ? err.message : 'Failed' });
                  }
                }}
                className="m-btn m-btn-primary flex-1 text-[13px]"
              >
                {t('save')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Balance correction: set the balance to the true figure via a
          visible, reversible adjustment entry — the sanctioned repair for
          drifted accounts (no more fake income/expense entries). */}
      {showCorrect && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--m-scrim)] backdrop-blur-sm animate-fade-in"
          role="presentation"
          onClick={() => setShowCorrect(false)}
        >
          <div
            className="m-card m-card-feature p-5 w-[90%] max-w-sm"
            role="presentation"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-[15px] font-semibold text-ink-900 tracking-tight mb-1.5">{t('acct_correct_title')}</h3>
            <p className="text-[12px] text-ink-600 leading-relaxed mb-3">{t('acct_correct_hint')}</p>
            <label className="form-label">
              {isCreditCard ? t('cc_available') : t('label_balance')} ({account.currency})
            </label>
            <input
              type="number"
              step="0.01"
              value={correctInput}
              onChange={(e) => setCorrectInput(e.target.value)}
              autoFocus
              className="input-field tabular-nums mb-4"
            />
            <div className="flex gap-2.5">
              <button
                onClick={() => setShowCorrect(false)}
                className="m-btn m-btn-plain flex-1 text-[13px]"
              >
                {t('cancel')}
              </button>
              <button
                disabled={savingCorrect || !Number.isFinite(parseFloat(correctInput)) || Math.abs(parseFloat(correctInput) - account.balance) < 0.005}
                onClick={() => submitGuard.run(async () => {
                  setSavingCorrect(true);
                  try {
                    await useTransactionStore.getState().processTransaction({
                      type: 'adjustment',
                      amount: 0,
                      accountId: account.id,
                      targetBalance: parseFloat(correctInput),
                      notes: t('acct_correct_note'),
                    });
                    await Promise.all([loadAccounts(), loadTransactions()]);
                    toast.show({ type: 'success', title: t('acct_correct_saved') });
                    setShowCorrect(false);
                  } catch (err) {
                    toast.show({ type: 'error', title: err instanceof Error ? err.message : 'Failed' });
                  } finally {
                    setSavingCorrect(false);
                  }
                })}
                className="m-btn m-btn-primary flex-1 text-[13px]"
              >
                {t('acct_correct_cta')}
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}

function getOrdinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return s[(v - 20) % 10] || s[v] || s[0];
}

// Inline explainer for what this account contributes to "Your Money" on
// the home dashboard. Keeps the math out of code-comment territory so
// users can verify the number themselves. Two variants:
//   • Regular accounts (cash/bank/wallet/savings) — single +Balance line.
//   • Credit cards — three-line breakdown (Limit / Used / Available) plus
//     a clear "subtracted from your money" total. If no limit is set we
//     show a warning so the user knows the math is incomplete.
function MoneyMathCard({
  account,
  isCreditCard,
  creditLimit,
  used,
}: {
  account: Account;
  isCreditCard: boolean;
  creditLimit: number;
  used: number;
}) {
  const t = useT();
  const currency = account.currency;

  if (!isCreditCard) {
    return (
      <div className="m-card p-4">
        <div className="flex items-center gap-2 mb-3">
          <div className="m-ctl w-8 h-8 rounded-[10px] flex items-center justify-center shrink-0">
            <Glyph name="calculator" size={15} tone="violet" />
          </div>
          <p className="text-[10.5px] font-semibold text-ink-500 uppercase tracking-[0.12em]">
            {t('mm_title')}
          </p>
        </div>
        <div className="flex items-baseline justify-between px-1">
          <span className="text-[12.5px] text-ink-600">{t('label_balance')}</span>
          <span className="text-[13px] font-semibold text-ink-900 tabular-nums">
            {formatMoney(account.balance, currency)}
          </span>
        </div>
        <div className="mt-3 pt-3 border-t border-cream-hairline flex items-baseline justify-between px-1">
          <span className="text-[11px] font-semibold text-receive-text uppercase tracking-[0.08em]">
            {t('mm_added')}
          </span>
          <span className="text-[14px] font-semibold text-receive-text tabular-nums">
            +{formatMoney(account.balance, currency)}
          </span>
        </div>
      </div>
    );
  }

  // Credit-card variant. `used` is computed in the parent as
  // (creditLimit − balance). When creditLimit is 0 (unset), used is
  // negative — surface a clear "set a limit" CTA instead of showing
  // misleading math, since the dashboard will under-report what you owe.
  const limitMissing = creditLimit <= 0;
  const available = account.balance;

  return (
    <div className="m-card p-4">
      <div className="flex items-center gap-2 mb-3">
        <div className="m-ctl w-8 h-8 rounded-[10px] flex items-center justify-center shrink-0">
          <Glyph name="calculator" size={15} tone="coral" />
        </div>
        <p className="text-[10.5px] font-semibold text-ink-500 uppercase tracking-[0.12em]">
          {t('mm_title')}
        </p>
      </div>

      {limitMissing ? (
        <div className="m-inset px-3 py-2.5 flex items-start gap-2">
          <Glyph name="info" size={14} tone="violet" className="mt-0.5" />
          <p className="text-[11.5px] text-ink-700 leading-relaxed">
            {t('mm_no_limit_warn')}
          </p>
        </div>
      ) : (
        <>
          <div className="space-y-1.5 px-1">
            <div className="flex items-baseline justify-between">
              <span className="text-[12.5px] text-ink-600">{t('cc_settings_limit')}</span>
              <span className="text-[13px] font-medium text-ink-900 tabular-nums">
                {formatMoney(creditLimit, currency)}
              </span>
            </div>
            <div className="flex items-baseline justify-between">
              <span className="text-[12.5px] text-ink-600">
                {t('mm_available_balance')}
              </span>
              <span className="text-[13px] font-medium text-ink-900 tabular-nums">
                − {formatMoney(available, currency)}
              </span>
            </div>
          </div>
          {/* used < 0 = credited past the limit; formatMoney's abs() would
              flip that into fake debt ("You owe 11,150" on an overpaid card),
              so the row switches to an explicit overpaid reading. */}
          <div className="mt-2 pt-2 border-t border-cream-hairline flex items-baseline justify-between px-1">
            <span className="text-[12.5px] text-ink-700">
              {used < -0.005 ? t('mm_overpaid_above') : t('mm_you_owe_used')}
            </span>
            <span className={`text-[13.5px] font-semibold tabular-nums ${used < -0.005 ? 'text-warn-700' : 'text-pay-text'}`}>
              {formatMoney(Math.abs(used), currency)}
            </span>
          </div>
          <div className="mt-3 pt-3 border-t border-cream-hairline flex items-baseline justify-between px-1">
            <span className={`text-[11px] font-semibold uppercase tracking-[0.08em] ${used < -0.005 ? 'text-receive-text' : 'text-pay-text'}`}>
              {used < -0.005 ? t('mm_added') : t('mm_subtracted')}
            </span>
            <span className={`text-[14px] font-semibold tabular-nums ${used < -0.005 ? 'text-receive-text' : 'text-pay-text'}`}>
              {used < -0.005 ? '+' : '−'}{formatMoney(Math.abs(used), currency)}
            </span>
          </div>
        </>
      )}
    </div>
  );
}
