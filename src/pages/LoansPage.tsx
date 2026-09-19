import { useCallback, useMemo, useState } from 'react';
import { Users } from 'lucide-react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useLoanStore } from '../stores/loanStore';
import { oldestCreatedAt } from '../lib/historyWindow';
import { usePersonStore } from '../stores/personStore';
import { useLinkedRequestStore } from '../stores/linkedRequestStore';
import { useSettlementRequestStore } from '../stores/settlementRequestStore';
import { useSupabaseAuthStore } from '../stores/supabaseAuthStore';
import { AllocateRepaymentModal } from '../components/AllocateRepaymentModal';
import { AllocateSettlementModal } from '../components/AllocateSettlementModal';
import { useEmiStore } from '../stores/emiStore';
import { useTransactionStore } from '../stores/transactionStore';
import { useAccountStore } from '../stores/accountStore';
import { useSplitStore } from '../stores/splitStore';
import { NavyHero, TopBar } from '../components/NavyHero';
import { Glyph } from '../components/Glyph';
import { MoneyDisplay } from '../components/MoneyDisplay';
import { UserAvatar } from '../components/UserAvatar';
import { LanguageToggle } from '../components/LanguageToggle';
import { EmptyState } from '../components/EmptyState';
import { Card3D } from '../components/Card3D';
import { Modal } from '../components/Modal';
import { TransactionItem } from '../components/TransactionItem';
import { PaymentReminderModal } from '../components/PaymentReminderModal';
import { SendStatementModal } from '../components/SendStatementModal';
import { PageErrorState } from '../components/PageErrorState';
import { ListSkeleton } from '../components/ListSkeleton';
import { WhoOwesMeCard } from '../components/WhoOwesMeCard';
import { useAsyncLoad } from '../hooks/useAsyncLoad';
import { formatMoney } from '../lib/constants';
import { skeletonDelay } from '../lib/material';
import { linkedLoanIdSet } from '../lib/linkedLoanIdSet';
import { useT } from '../lib/i18n';
import { getPrimaryCurrency } from '../lib/primaryCurrency';
import {
  buildAdhocSplitIndex,
  buildWhoOwesMe,
  findLikelyDuplicateRows,
} from '../lib/whoOwesMe';
import { groupInputsFromNetBalances } from '../lib/whoOwesGroupInputs';
import {
  getOldestIsoDate,
  getReminderAge,
  type PaymentReminderDirection,
} from '../lib/paymentReminders';
import { AddLoanModal } from './AddLoanModal';
import { format, isPast, differenceInDays } from 'date-fns';
import { Link } from 'react-router-dom';
import type { Currency, Loan } from '../db';

type LoanDirection = 'given' | 'taken';
type Tab = 'receivables' | 'payables' | 'settled';

type LoanAggregate = {
  remaining: number;
  total: number;
  count: number;
};

type LoanGroup = LoanAggregate & {
  key: string;
  name: string;
  currency: Currency;
  direction: LoanDirection;
  loans: Loan[];
  status: 'active' | 'settled';
};

type ReminderTarget = {
  personName: string;
  amount: number;
  currency: Currency;
  direction: PaymentReminderDirection;
  startedAt: string | null;
  hasDueDate: boolean;
  phone: string | null;
};

export function LoansPage() {
  const { loans, loadLoans } = useLoanStore();
  const persons = usePersonStore((s) => s.persons);
  const loadPersons = usePersonStore((s) => s.loadPersons);
  const { schedules, loadSchedules } = useEmiStore();
  const { transactions, loadTransactions } = useTransactionStore();
  // This page reads transaction rows for TWO loan-shaped facts — which loans
  // were funded by a credit card, and which came from an ad-hoc split — and
  // both live on the loan's ORIGIN row, which can be years old. The default
  // 12-month window would drop them and quietly re-classify old card debt as a
  // person's debt. So: widen coverage to the oldest loan we hold, and no
  // further (docs/performance.md §7).
  const ensureTransactionHistory = useTransactionStore((s) => s.ensureTransactionHistory);
  const { loadAccounts } = useAccountStore();
  const linkedRequests = useLinkedRequestStore((s) => s.requests);
  const loadLinkedRequests = useLinkedRequestStore((s) => s.loadRequests);
  const settlementRequests = useSettlementRequestStore((s) => s.requests);
  const loadSettlementRequests = useSettlementRequestStore((s) => s.loadRequests);
  // Groups feed the unified "who owes what" card. Raw slices only — filtering
  // happens inside useMemo (React #185: a selector returning a fresh array on
  // every call makes useSyncExternalStore's snapshot unstable).
  const groups = useSplitStore((s) => s.groups);
  const groupBalances = useSplitStore((s) => s.balances);
  const loadGroups = useSplitStore((s) => s.loadGroups);
  const loadBalances = useSplitStore((s) => s.loadBalances);
  const myId = useSupabaseAuthStore((s) => s.user?.id ?? '');
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const t = useT();
  const primaryCurrency = getPrimaryCurrency();

  const [showAdd, setShowAdd] = useState(false);
  const requestedTab = searchParams.get('tab');
  const tab: Tab =
    requestedTab === 'payables' || requestedTab === 'settled'
      ? requestedTab
      : 'receivables';
  const [selectedGroup, setSelectedGroup] = useState<LoanGroup | null>(null);
  const [reminderTarget, setReminderTarget] = useState<ReminderTarget | null>(null);
  const [showSearch, setShowSearch] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [showAllocate, setShowAllocate] = useState(false);
  const [showSettleAll, setShowSettleAll] = useState(false);
  const [statementFor, setStatementFor] = useState<{ personId: string | null; name: string; phone: string | null } | null>(null);
  const [statementIntro, setStatementIntro] = useState<string | undefined>(undefined);

  const load = useCallback(async () => {
    // loadLinkedRequests is needed so we can exclude linked loans (which must
    // settle via their own confirm flow) from the multi-loan allocation.
    // loadPersons gives us phone numbers for the WhatsApp reminder deep-link.
    // loadGroups → loadBalances (in that order: loadBalances reads the store's
    // hydrated groups) gives the who-owes-what card the group side of the
    // ledger. Two batched queries for every visible expense + settlement, the
    // same pair the Groups tab already runs — not one fetch per group.
    await Promise.all([
      loadLoans(),
      loadSchedules(),
      loadTransactions(),
      loadAccounts(),
      loadLinkedRequests(),
      loadSettlementRequests(),
      loadPersons(),
      loadGroups().then(loadBalances),
    ]);
    // Bounded-history top-up. Runs AFTER the loans land (it needs their dates)
    // and resolves without a request whenever the window already reaches back
    // far enough — which it does for every user whose oldest loan is inside a
    // year, i.e. almost all of them.
    const oldestLoanAt = oldestCreatedAt(useLoanStore.getState().loans);
    if (oldestLoanAt) await ensureTransactionHistory({ since: oldestLoanAt });
  }, [loadAccounts, loadLoans, loadSchedules, loadTransactions, loadLinkedRequests, loadSettlementRequests, loadPersons, loadGroups, loadBalances, ensureTransactionHistory]);
  const { status: loadStatus, error: loadError, retry: retryLoad } = useAsyncLoad(load);

  // Loans mirrored to another Hisaab user (accepted linked pair) — excluded
  // from local multi-loan allocation; they settle through the confirm flow.
  const linkedLoanIds = useMemo(() => linkedLoanIdSet(linkedRequests), [linkedRequests]);

  // Active, non-linked loans in the opened person group — the set a lump
  // payment can be spread across.
  const allocatableLoans = selectedGroup
    ? selectedGroup.loans.filter((l) => l.status === 'active' && l.remainingAmount > 0.01 && !linkedLoanIds.has(l.id))
    : [];
  const hasLinkedInGroup = !!selectedGroup && selectedGroup.loans.some((l) => linkedLoanIds.has(l.id));

  // Active LINKED loans in the group — a lump can settle across these too,
  // as one settlement request per loan (counterparty confirms each). Loans
  // with a request already pending are skipped so we never double-ask.
  const pendingSettlementLoanIds = useMemo(() => {
    const ids = new Set<string>();
    for (const r of settlementRequests) {
      if (r.status !== 'pending') continue;
      ids.add(r.requesterLoanId);
      ids.add(r.responderLoanId);
    }
    return ids;
  }, [settlementRequests]);
  const linkedSettleableLoans = selectedGroup
    ? selectedGroup.loans.filter(
        (l) =>
          l.status === 'active' &&
          l.remainingAmount > 0.01 &&
          linkedLoanIds.has(l.id) &&
          !pendingSettlementLoanIds.has(l.id),
      )
    : [];

  // Cash advances are the card's debt, billed on the card's statement — they
  // live INSIDE the card now, not as separate "people" here. Exclude them from
  // every Loans-page surface (lists, stance totals, counts) so the card debt
  // is shown in exactly one place and "N people to pay" stops counting plastic.
  const cardFundedLoanIds = useMemo(() => {
    const map = new Set<string>();
    for (const txn of transactions) {
      if (txn.type === 'loan_taken' && txn.relatedLoanId && txn.sourceAccountId) map.add(txn.relatedLoanId);
    }
    return map;
  }, [transactions]);
  const peopleLoans = useMemo(
    () => loans.filter((l) => !cardFundedLoanIds.has(l.id)),
    [loans, cardFundedLoanIds],
  );
  const activeLoans = peopleLoans.filter((l) => l.status === 'active');
  const settledLoans = peopleLoans.filter((l) => l.status === 'settled');

  // ── Unified "who owes what" (src/lib/whoOwesMe.ts) ─────────────────────────
  // One row per (person, currency) across loans, linked loans, ad-hoc splits
  // and group balances. The aggregator has NO account or transaction-as-money
  // input, so full_tracker and splits_only produce identical rows for the same
  // loans and groups — ledger-mode loans (no account leg, no transaction row)
  // are counted exactly like any other loan.
  //
  // Transactions are read for ONE purpose: labelling which loans came from an
  // ad-hoc split. In splits_only mode a split writes no transaction rows at
  // all, so those loans surface as plain `loan` sources — same money, same
  // person, only the chip label and deep-link target differ.
  const adhocByLoanId = useMemo(() => buildAdhocSplitIndex(transactions), [transactions]);
  const whoOwesGroups = useMemo(
    () => groupInputsFromNetBalances(groups, groupBalances, myId || null),
    [groups, groupBalances, myId],
  );
  const whoOwesRows = useMemo(
    () =>
      buildWhoOwesMe({
        loans: peopleLoans,
        groups: whoOwesGroups,
        contacts: persons,
        currentProfileId: myId || null,
        adhocByLoanId,
      }),
    [peopleLoans, whoOwesGroups, persons, myId, adhocByLoanId],
  );
  // "Bilal the contact" and "Bilal typed by hand" are different keys and stay
  // different rows — this only offers the user the choice to link them.
  const whoOwesDuplicates = useMemo(() => findLikelyDuplicateRows(whoOwesRows), [whoOwesRows]);

  const sumRemaining = (items: Loan[]) =>
    items.reduce(
      (acc, l) => {
        acc[l.currency] = (acc[l.currency] ?? 0) + l.remainingAmount;
        return acc;
      },
      {} as Record<string, number>,
    );

  const activeReceivablesByCurrency = sumRemaining(
    activeLoans.filter((l) => l.type === 'given'),
  );
  const activePayablesByCurrency = sumRemaining(
    activeLoans.filter((l) => l.type === 'taken'),
  );

  // Hero net stance — primary currency only. Other currencies surface as a
  // separate "pocket" section below the main list so the headline number
  // stays unambiguous.
  const recvPrimary = activeReceivablesByCurrency[primaryCurrency] ?? 0;
  const payPrimary = activePayablesByCurrency[primaryCurrency] ?? 0;
  const netStance = recvPrimary - payPrimary;
  const totalActivity = recvPrimary + payPrimary;
  // Segmented bar widths — leave a 4% gap when both sides have value, per
  // Sukoon's spec. When only one side has activity, drop the gap.
  const hasBothSides = recvPrimary > 0 && payPrimary > 0;
  const gapPct = hasBothSides ? 4 : 0;
  const recvPct = totalActivity > 0 ? (recvPrimary / totalActivity) * (100 - gapPct) : 0;
  const payPct = totalActivity > 0 ? (payPrimary / totalActivity) * (100 - gapPct) : 0;

  // People counts in the primary currency (for the hero split label)
  const distinctPeople = (items: Loan[], currency: string) =>
    new Set(
      items
        .filter((l) => l.currency === currency)
        .map((l) => l.personId ?? l.personName.trim().toLowerCase()),
    ).size;
  const recvPeopleCount = distinctPeople(
    activeLoans.filter((l) => l.type === 'given'),
    primaryCurrency,
  );
  const payPeopleCount = distinctPeople(
    activeLoans.filter((l) => l.type === 'taken'),
    primaryCurrency,
  );

  // Group loans by (direction × currency × person). Used by both the main
  // list and the "other currencies" pocket section.
  const groupBy = (items: Loan[], direction: LoanDirection, status: 'active' | 'settled'): LoanGroup[] => {
    const buckets = new Map<string, LoanGroup>();
    for (const loan of items) {
      const personKey = loan.personId ?? loan.personName.trim().toLowerCase();
      const key = `${direction}:${loan.currency}:${personKey}`;
      const bucket = buckets.get(key) ?? {
        key,
        name: loan.personName,
        currency: loan.currency,
        direction,
        status,
        remaining: 0,
        total: 0,
        count: 0,
        loans: [],
      };
      bucket.remaining += loan.remainingAmount;
      bucket.total += loan.totalAmount;
      bucket.count += 1;
      bucket.loans.push(loan);
      buckets.set(key, bucket);
    }
    return [...buckets.values()].sort((a, b) => b.remaining - a.remaining || b.total - a.total);
  };

  const tabCounts = {
    receivables: distinctPeople(activeLoans.filter((l) => l.type === 'given'), primaryCurrency),
    payables: distinctPeople(activeLoans.filter((l) => l.type === 'taken'), primaryCurrency),
    // People, like the two tabs beside it: it used to count LOANS, so a
    // "Settled · 66" next to "People owe you · 9" read as 66 people.
    settled: distinctPeople(settledLoans, primaryCurrency),
  };

  // Build the visible list for the current tab. Primary-currency groups first;
  // everything else lands in `otherGroups` as a pocket section below.
  let primaryGroups: LoanGroup[] = [];
  let otherGroups: LoanGroup[] = [];
  if (tab === 'receivables') {
    const givens = activeLoans.filter((l) => l.type === 'given');
    const all = groupBy(givens, 'given', 'active');
    primaryGroups = all.filter((g) => g.currency === primaryCurrency);
    otherGroups = all.filter((g) => g.currency !== primaryCurrency);
  } else if (tab === 'payables') {
    const takens = activeLoans.filter((l) => l.type === 'taken');
    const all = groupBy(takens, 'taken', 'active');
    primaryGroups = all.filter((g) => g.currency === primaryCurrency);
    otherGroups = all.filter((g) => g.currency !== primaryCurrency);
  } else {
    // Settled tab: both directions, sorted by total amount (most-impactful first).
    const givensSettled = groupBy(
      settledLoans.filter((l) => l.type === 'given'),
      'given',
      'settled',
    );
    const takensSettled = groupBy(
      settledLoans.filter((l) => l.type === 'taken'),
      'taken',
      'settled',
    );
    const all = [...givensSettled, ...takensSettled].sort((a, b) => b.total - a.total);
    primaryGroups = all.filter((g) => g.currency === primaryCurrency);
    otherGroups = all.filter((g) => g.currency !== primaryCurrency);
  }

  // Free-text name filter — applied uniformly across both pockets so a
  // search like "ali" surfaces matches regardless of which currency the
  // person's loan is in.
  const q = searchQuery.trim().toLowerCase();
  if (q) {
    primaryGroups = primaryGroups.filter((g) => g.name.toLowerCase().includes(q));
    otherGroups = otherGroups.filter((g) => g.name.toLowerCase().includes(q));
  }

  // At-a-glance status derived from the group's unpaid schedules:
  // 'overdue' if any unpaid instalment's dueDate is in the past, 'due-soon'
  // if the next one falls within ~3 days, otherwise none. Groups with no
  // EMI schedule have no status here (open-ended loans aren't "overdue").
  // NOTE: defined before the sort/overdueCount below that call it — moving it
  // later would put it in the temporal dead zone and crash the page.
  type GroupStatus = 'overdue' | 'due-soon' | null;
  const getGroupStatus = (group: LoanGroup): GroupStatus => {
    if (group.status === 'settled') return null;
    const loanIds = new Set(group.loans.map((l) => l.id));
    const unpaid = schedules.filter((s) => loanIds.has(s.loanId) && s.status !== 'paid');
    if (unpaid.length === 0) return null;
    const anyOverdue = unpaid.some((s) => isPast(new Date(s.dueDate)));
    if (anyOverdue) return 'overdue';
    const next = unpaid
      .slice()
      .sort((a, b) => a.dueDate.localeCompare(b.dueDate))[0];
    const days = differenceInDays(new Date(next.dueDate), new Date());
    if (days >= 0 && days <= 3) return 'due-soon';
    return null;
  };

  // Float overdue groups to the top, then due-soon, preserving the existing
  // amount-based order within each band. Settled tab keeps its own ordering.
  if (tab !== 'settled') {
    const statusRank = (g: LoanGroup) => {
      const s = getGroupStatus(g);
      return s === 'overdue' ? 0 : s === 'due-soon' ? 1 : 2;
    };
    const byStatus = (a: LoanGroup, b: LoanGroup) => statusRank(a) - statusRank(b);
    primaryGroups = primaryGroups.slice().sort(byStatus);
    otherGroups = otherGroups.slice().sort(byStatus);
  }

  // Count of overdue people in the active (non-settled) tab — shown as a
  // small alert pill on the tab so users feel the urgency before tapping in.
  const overdueCount =
    tab === 'settled'
      ? 0
      : [...primaryGroups, ...otherGroups].filter((g) => getGroupStatus(g) === 'overdue').length;

  // Pending linked + settlement requests waiting on someone — mirrors the
  // InboxPage selectors so the count matches what the user sees in /inbox.
  const incomingPendingCount =
    linkedRequests.filter((r) => r.status === 'pending' && r.toUserId === myId).length +
    settlementRequests.filter((r) => r.status === 'pending' && r.toUserId === myId).length;
  const outgoingPendingCount =
    linkedRequests.filter((r) => r.status === 'pending' && r.fromUserId === myId).length +
    settlementRequests.filter((r) => r.status === 'pending' && r.fromUserId === myId).length;
  const pendingTotal = incomingPendingCount + outgoingPendingCount;

  const selectedLoanIds = new Set(selectedGroup?.loans.map((l) => l.id) ?? []);
  const selectedTransactions = transactions
    .filter((tx) => tx.relatedLoanId && selectedLoanIds.has(tx.relatedLoanId))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  const getGroupReminderDate = (group: LoanGroup) => {
    const loanIds = new Set(group.loans.map((l) => l.id));
    const overdueScheduleDate = getOldestIsoDate(
      schedules
        .filter((s) => loanIds.has(s.loanId) && s.status !== 'paid')
        .map((s) => s.dueDate),
    );
    return overdueScheduleDate ?? getOldestIsoDate(group.loans.map((l) => l.createdAt));
  };

  // Find the next unpaid EMI instalment for a person's loans, for the
  // "Next: 12 Aug · 300 AED" hint in the row.
  const getNextInstalment = (group: LoanGroup) => {
    const loanIds = new Set(group.loans.map((l) => l.id));
    const upcoming = schedules
      .filter((s) => loanIds.has(s.loanId) && s.status !== 'paid')
      .sort((a, b) => a.dueDate.localeCompare(b.dueDate))[0];
    return upcoming ?? null;
  };

  // Does this person-group include any loan mirrored to another Hisaab user?
  const groupHasLinked = (group: LoanGroup) =>
    group.loans.some((l) => linkedLoanIds.has(l.id));

  // Best phone we have for the group, so the WhatsApp reminder can open the
  // contact's chat directly. Prefer a personId match (exact contact); fall
  // back to a name match for loans created before the contact existed. Null
  // ⇒ the reminder opens WhatsApp's picker instead — still works for non-users.
  const groupPhone = (group: LoanGroup): string | null => {
    for (const l of group.loans) {
      if (!l.personId) continue;
      const p = persons.find((x) => x.id === l.personId);
      if (p?.phone) return p.phone;
    }
    const byName = persons.find(
      (p) => p.name.trim().toLowerCase() === group.name.trim().toLowerCase(),
    );
    return byName?.phone ?? null;
  };

  // A loan only has a real due date when it carries at least one unpaid EMI
  // schedule. Open-ended loans (no schedule) must NOT be called "overdue" —
  // they're simply "open for N days".
  const groupHasDueDate = (group: LoanGroup) => {
    const loanIds = new Set(group.loans.map((l) => l.id));
    return schedules.some((s) => loanIds.has(s.loanId) && s.status !== 'paid');
  };

  const formatReminderMeta = (startedAt: string | null, hasDueDate: boolean) => {
    const age = getReminderAge(startedAt);
    if (age.days === null) return t('reminder_no_due_date');
    // Without a due date, "overdue" is meaningless — fall back to neutral.
    if (hasDueDate && age.isOverdue) return t('reminder_overdue_days').replace('{count}', String(age.days));
    return t('reminder_open_days').replace('{count}', String(age.days));
  };

  const openReminder = (group: LoanGroup) => {
    setSelectedGroup(null);
    setReminderTarget({
      personName: group.name,
      amount: group.remaining,
      currency: group.currency,
      direction: group.direction === 'given' ? 'receivable' : 'payable',
      startedAt: getGroupReminderDate(group),
      hasDueDate: groupHasDueDate(group),
      phone: groupPhone(group),
    });
  };

  // Open a full Statement of Account for this person. The statement itself is
  // rebuilt from the live store (all their loans, every currency + direction),
  // so we only need to capture who it's for — not the currency/direction slice
  // the drill-down group represents.
  const openStatementForGroup = (group: LoanGroup, intro?: string) => {
    setStatementFor({
      personId: group.loans.find((l) => l.personId)?.personId ?? null,
      name: group.name,
      phone: groupPhone(group),
    });
    setStatementIntro(intro);
  };

  const renderPersonRow = (group: LoanGroup) => {
    const isGiven = group.direction === 'given';
    const isSettled = group.status === 'settled';
    const amount = isSettled ? group.total : group.remaining;
    const sign = isGiven ? '+' : '−';
    // Settled rows are history: the amount steps back to muted ink.
    const amountColor = isSettled
      ? 'text-ink-600'
      : isGiven
      ? 'text-receive-text'
      : 'text-pay-text';

    const totalLoans = group.count;
    const nextInst = getNextInstalment(group);
    const remainingInstalments = nextInst
      ? schedules.filter(
          (s) =>
            group.loans.some((l) => l.id === s.loanId) && s.status !== 'paid',
        ).length
      : 0;
    const status = getGroupStatus(group);
    const isLinked = groupHasLinked(group);
    // Age of the oldest loan in this group, so the user can see what's been
    // outstanding longest and prioritise. Colour-coded chip: fresh (green) →
    // ageing (gold) → stale (coral).
    const firstLoanDate = getOldestIsoDate(group.loans.map((l) => l.createdAt));
    const daysOld = firstLoanDate ? Math.max(0, differenceInDays(new Date(), new Date(firstLoanDate))) : null;
    const ageChip = daysOld == null ? '' : daysOld > 30 ? 'm-chip-pay' : daysOld >= 7 ? 'm-chip-gold' : 'm-chip-receive';

    return (
      <button
        key={group.key}
        type="button"
        onClick={() => setSelectedGroup(group)}
        className="w-full flex items-center gap-3 px-4 py-3.5 text-left active:bg-cream-soft transition-colors"
      >
        <UserAvatar name={group.name} size={44} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <p className="text-[14px] font-medium text-ink-900 truncate tracking-[-0.01em]">
              {group.name}
            </p>
            {isSettled && (
              <span className="m-chip m-chip-receive shrink-0">
                <Glyph name="check" size={10} strokeWidth={3} />
                {t('status_settled')}
              </span>
            )}
            {/* Overdue / due-soon both read coral — the glyph and the word
                tell them apart. */}
            {status && (
              <span className="m-chip m-chip-pay shrink-0">
                <Glyph name={status === 'overdue' ? 'alert' : 'clock'} size={10} strokeWidth={2.8} />
                {status === 'overdue' ? t('status_overdue') : t('status_due_soon')}
              </span>
            )}
            {/* Age of the oldest loan — colour-coded so the longest-standing
                debts stand out for prioritising. */}
            {!isSettled && daysOld != null && (
              <span className={`m-chip ${ageChip} shrink-0 tabular-nums`}>
                {daysOld === 0 ? t('loan_age_today') : t('loan_age_days').replace('{n}', String(daysOld))}
              </span>
            )}
            {isLinked && (
              <span className="m-chip m-chip-violet shrink-0">
                <Glyph name="link" size={10} strokeWidth={2.8} />
                {t('status_linked')}
              </span>
            )}
          </div>
          <p className="text-[11px] text-ink-600 mt-[3px]">
            {totalLoans === 1
              ? t('common_loan_one')
              : t('common_loan_many').replace('{n}', String(totalLoans))}
            {remainingInstalments > 0 && (
              <> · {t('loans_instalments_left').replace('{n}', String(remainingInstalments))}</>
            )}
          </p>
          {nextInst && !isSettled && (
            <p className="text-[10.5px] text-ink-400 mt-0.5 tabular-nums">
              {t('loans_next_label')}: {format(new Date(nextInst.dueDate), 'd MMM')} ·{' '}
              {formatMoney(nextInst.amount, group.currency)}
            </p>
          )}
        </div>
        <div className="text-right shrink-0">
          <p className={`text-[14px] font-semibold tabular-nums tracking-[-0.01em] ${amountColor}`}>
            {sign}
            {formatMoney(amount, group.currency)}
          </p>
          <p className="text-[10px] text-ink-400 mt-[3px]">{group.currency}</p>
        </div>
      </button>
    );
  };

  const tabPills: { value: Tab; label: string; count: number }[] = [
    { value: 'receivables', label: t('loan_people_owe'), count: tabCounts.receivables },
    { value: 'payables', label: t('loan_you_owe'), count: tabCounts.payables },
    { value: 'settled', label: t('settled'), count: tabCounts.settled },
  ];

  // First paint before any loan has landed: the hero figure and the list both
  // hold their final geometry as skeleton blocks instead of flashing "0".
  const isFirstLoad = loadStatus === 'loading' && loans.length === 0;

  return (
    <main className="min-h-dvh bg-cream-bg pb-28">
      <NavyHero accent="violet">
        <TopBar
          title={t('loans_title')}
          action={
            <div className="flex items-center gap-2">
              <button
                onClick={() => setShowSearch((v) => !v)}
                className="m-ctl relative w-9 h-9 flex items-center justify-center before:absolute before:-inset-1 before:content-['']"
                aria-label={t('a11y_search')}
                aria-pressed={showSearch}
              >
                <Glyph name="search" size={15} className="text-white/90" />
              </button>
              {/* The handoff's header "+ New": a violet-tinted control (dark
                  violet face, light-violet label, one short wall) — the same
                  height as its neighbours, so the row reads as one strip. */}
              <button
                onClick={() => setShowAdd(true)}
                className="m-key m-violet h-9 px-3 rounded-[12px] inline-flex items-center gap-1 text-[12px] font-semibold"
                aria-label={t('loans_a11y_add')}
              >
                <Glyph name="plus" size={13} strokeWidth={3} /> {t('naya')}
              </button>
              <LanguageToggle />
            </div>
          }
        />

        <div className="px-5 pb-7">
          <p className="text-[10.5px] font-semibold text-white/70 tracking-[0.12em] uppercase">
            {t('loans_your_stance')} · {primaryCurrency}
          </p>
          {isFirstLoad ? (
            <div aria-hidden>
              <div className="m-skel mt-2.5 h-[38px] w-48 rounded-xl" />
              <div className="m-skel mt-3 h-3 w-40" style={{ '--m-skel-delay': skeletonDelay(1) } as React.CSSProperties} />
              <div className="m-skel mt-4 h-2 w-full rounded-full" style={{ '--m-skel-delay': skeletonDelay(2) } as React.CSSProperties} />
            </div>
          ) : (
            <>
              <div className="mt-2">
                <MoneyDisplay
                  amount={netStance}
                  currency={primaryCurrency}
                  size={38}
                  tone="on-navy"
                  signed
                  extrude="violet"
                />
              </div>
              <p className="text-[12px] text-white/70 mt-2.5">
                {netStance > 0
                  ? t('loans_stance_receive_more')
                  : netStance < 0
                  ? t('loans_stance_owe_more')
                  : t('wom_net_square')}
              </p>
            </>
          )}

          {/* Segmented 8px bar: the receive and pay shares as two lit
              segments in a recessed track, 4% apart when both exist. */}
          {!isFirstLoad && totalActivity > 0 && (
            <>
              <div className="mt-4 h-2 rounded-full bg-white/10 overflow-hidden flex gap-[var(--gap-w)]" style={{ ['--gap-w' as string]: hasBothSides ? `${gapPct}%` : '0%' }}>
                {recvPct > 0 && (
                  <div
                    className="h-full rounded-full bg-gradient-to-b from-glyph-green to-receive-700 shadow-[inset_0_1px_0_rgb(255_255_255/0.4)]"
                    style={{ width: `${recvPct}%` }}
                  />
                )}
                {payPct > 0 && (
                  <div
                    className="h-full rounded-full bg-gradient-to-b from-glyph-coral to-pay-700 shadow-[inset_0_1px_0_rgb(255_255_255/0.4)]"
                    style={{ width: `${payPct}%` }}
                  />
                )}
              </div>
              <div className="flex items-start justify-between gap-3 mt-2.5 text-[10.5px] tabular-nums">
                <span className="text-receive-text">
                  +{formatMoney(recvPrimary, primaryCurrency)} {t('loans_to_receive_short')} ·{' '}
                  {recvPeopleCount === 1
                    ? t('loans_people_one')
                    : t('loans_people_many').replace('{n}', String(recvPeopleCount))}
                </span>
                <span className="text-pay-text text-right">
                  −{formatMoney(payPrimary, primaryCurrency)} {t('loans_to_pay_short')} ·{' '}
                  {payPeopleCount === 1
                    ? t('loans_people_one')
                    : t('loans_people_many').replace('{n}', String(payPeopleCount))}
                </span>
              </div>
            </>
          )}
        </div>
      </NavyHero>

      <div className="sukoon-body min-h-[60dvh] px-5 pt-5 space-y-4">
        {showSearch && (
          <div className="relative">
            <Glyph name="search" size={14} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-400 pointer-events-none" />
            <input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={t('loans_search_by_name')}
              className="input-field pl-10 pr-10"
              autoFocus
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 w-8 h-8 flex items-center justify-center text-ink-400 press-xs"
                aria-label={t('a11y_clear_search')}
              >
                <Glyph name="close" size={14} />
              </button>
            )}
          </div>
        )}

        {/* Pending linked/settlement requests waiting in the inbox — a violet
            (Inbox-coloured) tappable banner so the user can act on
            cross-user IOUs without hunting for the bell. */}
        {pendingTotal > 0 && (
          <Link
            to="/inbox"
            className="m-tile m-violet flex items-center gap-2.5 rounded-2xl px-3.5 py-3"
          >
            <Glyph name="bell" size={16} tone="violet" />
            <p className="flex-1 min-w-0 text-[12px] font-semibold text-iris-text leading-snug">
              {(pendingTotal === 1 ? t('loans_pending_banner') : t('loans_pending_banner_plural')).replace('{count}', String(pendingTotal))}
              {incomingPendingCount > 0 && (
                <span className="font-normal text-ink-600">
                  {' '}· {t('loans_pending_reply').replace('{count}', String(incomingPendingCount))}
                </span>
              )}
            </p>
            <Glyph name="chevron-right" size={15} tone="violet" />
          </Link>
        )}

        {/* Tab pills: Receivables / Payables / Settled — toned by financial
            direction (green = owed to you, coral = you owe, neutral =
            settled): a tinted face at rest, the solid tone when active. The
            scroller keeps 4px under the pills so their walls aren't clipped. */}
        <div className="flex gap-2 overflow-x-auto no-scrollbar -mx-1 px-1 pb-1">
          {tabPills.map((p) => {
            const isActive = tab === p.value;
            const tone = p.value === 'receivables' ? 'm-pill-receive' : p.value === 'payables' ? 'm-pill-pay' : '';
            return (
              <button
                key={p.value}
                onClick={() => {
                  setSearchParams({ tab: p.value });
                  setSelectedGroup(null);
                }}
                aria-pressed={isActive}
                className={`m-pill ${tone} shrink-0`}
              >
                <span>
                  {p.label}
                  {p.count > 0 && <span className="tabular-nums"> · {p.count}</span>}
                </span>
                {isActive && p.value !== 'settled' && overdueCount > 0 && (
                  <span className="inline-flex items-center gap-0.5 text-[10px] font-bold leading-none tabular-nums">
                    <Glyph name="alert" size={11} strokeWidth={2.8} />
                    {overdueCount}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {/* The net stance + receive/pay breakdown already live in the hero
            above, so we keep only the one piece that wasn't there: a light
            line of guidance for what to do next on this tab. */}
        {loadStatus === 'ready' && activeLoans.length > 0 && (
          <p className="text-[11.5px] text-ink-600 leading-relaxed px-0.5">
            {primaryGroups.length > 0
              ? t('loans_tap_hint')
              : otherGroups.length > 0
              ? t('loans_other_only_hint')
              : t('loans_switch_tabs_hint')}
          </p>
        )}

        {/* Unified who-owes-what — sits ABOVE the per-direction lists because
            it is the only surface that nets a person's loans, ad-hoc splits and
            group balances together. Hidden on the Settled tab, which is about
            closed history rather than what is outstanding. */}
        {loadStatus !== 'loading' && tab !== 'settled' && (
          <WhoOwesMeCard
            rows={whoOwesRows}
            duplicateHints={whoOwesDuplicates}
            defaultExpanded={whoOwesRows.length > 0}
          />
        )}

        {/* Primary-currency people list */}
        {primaryGroups.length > 0 ? (
          <div className="m-card overflow-hidden divide-y divide-cream-hairline">
            {primaryGroups.map(renderPersonRow)}
          </div>
        ) : null}

        {/* Other-currency pocket section */}
        {otherGroups.length > 0 && (
          <div className="pt-1.5">
            <h2 className="m-label mb-2.5 px-0.5">
              {t('loans_other_currencies')}
            </h2>
            <div className="m-card overflow-hidden divide-y divide-cream-hairline">
              {otherGroups.map(renderPersonRow)}
            </div>
          </div>
        )}

        {loadStatus === 'error' && (
          <PageErrorState
            variant="inline"
            title={t('loans_err_load')}
            message={loadError ?? t('err_some_data_failed')}
            onRetry={retryLoad}
          />
        )}

        {/* First-load skeleton — gate the empty state on a completed load so
            we never flash "No receivables" before Supabase returns. */}
        {isFirstLoad ? (
          <ListSkeleton rows={3} />
        ) : loadStatus === 'ready' && primaryGroups.length === 0 && otherGroups.length === 0 ? (
          // `check` on a green plate = these are DONE; a gold `banknote` =
          // nothing lent or borrowed yet (the handoff's Loans empty state).
          <EmptyState
            icon={Users}
            clayIcon={tab === 'settled' ? 'check' : 'banknote'}
            tone={tab === 'settled' ? 'receive' : 'gold'}
            title={
              tab === 'settled'
                ? t('loan_none_settled')
                : t('empty_loans_title')
            }
            description={
              tab === 'settled'
                ? t('loan_desc_settled')
                : t('empty_loans_desc')
            }
            subhint={tab !== 'settled' ? t('empty_loans_subhint') : undefined}
            actionLabel={tab !== 'settled' ? t('empty_loans_cta') : undefined}
            onAction={tab !== 'settled' ? () => setShowAdd(true) : undefined}
          />
        ) : null}

      </div>

      {/* Drill-down modal: per-person loan summary + individual loans + activity */}
      <Modal
        open={!!selectedGroup}
        onClose={() => setSelectedGroup(null)}
        title={selectedGroup?.name ?? ''}
      >
        {selectedGroup ? (
          <div className="space-y-5">
            <LoanGroupSummary
              group={selectedGroup}
              onRemind={
                selectedGroup.status === 'active' && selectedGroup.remaining > 0
                  ? () => openReminder(selectedGroup)
                  : undefined
              }
              reminderMeta={formatReminderMeta(getGroupReminderDate(selectedGroup), groupHasDueDate(selectedGroup))}
            />

            {/* Multi-loan payment — spread one amount across these loans
                (clear the small ones first, etc.). Only worth offering when
                there are 2+ loans to allocate across. Violet: the primary
                action of this sheet. */}
            {selectedGroup.status === 'active' && allocatableLoans.length >= 2 && (
              <button
                onClick={() => setShowAllocate(true)}
                className="m-btn m-btn-primary w-full py-3 text-[13px]"
              >
                <Glyph name="banknote" size={15} /> {t('alloc_title')}
              </button>
            )}
            {/* Linked loans settle by request — one lump becomes one request
                per loan, each applied when the counterparty confirms. Violet,
                the colour every linked surface wears. */}
            {selectedGroup.status === 'active' && linkedSettleableLoans.length >= 2 && (
              <button
                onClick={() => setShowSettleAll(true)}
                className="m-btn m-btn-violet w-full py-3 text-[13px]"
              >
                <Glyph name="link" size={15} /> {t('stl_bulk_title')}
              </button>
            )}
            {hasLinkedInGroup && linkedSettleableLoans.length < 2 && (
              <p className="text-[11px] text-ink-600 leading-relaxed">{t('alloc_linked_note')}</p>
            )}

            <button
              onClick={() => openStatementForGroup(selectedGroup)}
              className="m-btn m-btn-plain w-full py-3 text-[13px]"
            >
              <Glyph name="document" size={15} tone="violet" /> {t('soa_cta')}
            </button>

            <div>
              <h3 className="m-label mb-2.5 px-0.5">
                {t('loans_individual')}
              </h3>
              <div className="space-y-2.5">
                {selectedGroup.loans
                  .slice()
                  .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
                  .map((loan) => (
                    <LoanDrilldownRow
                      key={loan.id}
                      loan={loan}
                      onClick={() => navigate(`/loan/${loan.id}`)}
                    />
                  ))}
              </div>
            </div>

            <div>
              <h3 className="m-label mb-2.5 px-0.5">
                {t('loans_activity')}
              </h3>
              {selectedTransactions.length === 0 ? (
                <p className="text-[12px] text-ink-400 text-center py-5">
                  {t('loans_no_activity')}
                </p>
              ) : (
                <div className="m-card px-3 divide-y divide-cream-hairline">
                  {selectedTransactions.map((tx) => (
                    <TransactionItem key={tx.id} transaction={tx} />
                  ))}
                </div>
              )}
            </div>
          </div>
        ) : null}
      </Modal>

      {selectedGroup && (
        <AllocateSettlementModal
          open={showSettleAll}
          onClose={() => setShowSettleAll(false)}
          loans={linkedSettleableLoans}
          direction={selectedGroup.direction}
          currency={selectedGroup.currency}
          personName={selectedGroup.name}
          onDone={() => {
            setShowSettleAll(false);
            setSelectedGroup(null);
            void load();
          }}
        />
      )}

      {selectedGroup && (
        <AllocateRepaymentModal
          open={showAllocate}
          onClose={() => setShowAllocate(false)}
          loans={allocatableLoans}
          direction={selectedGroup.direction}
          currency={selectedGroup.currency}
          personName={selectedGroup.name}
          onDone={() => {
            const paidGroup = selectedGroup;
            setShowAllocate(false);
            setSelectedGroup(null);
            void load();
            // Offer an updated statement now that the balance changed.
            if (paidGroup) {
              openStatementForGroup(paidGroup, t('soa_nudge_intro').replace('{name}', paidGroup.name));
            }
          }}
        />
      )}

      {reminderTarget ? (
        <PaymentReminderModal
          open={!!reminderTarget}
          onClose={() => setReminderTarget(null)}
          personName={reminderTarget.personName}
          amount={reminderTarget.amount}
          currency={reminderTarget.currency}
          direction={reminderTarget.direction}
          startedAt={reminderTarget.startedAt}
          hasDueDate={reminderTarget.hasDueDate}
          phone={reminderTarget.phone}
        />
      ) : null}

      {statementFor && (
        <SendStatementModal
          open={!!statementFor}
          onClose={() => { setStatementFor(null); setStatementIntro(undefined); }}
          partyName={statementFor.name}
          loans={loans.filter(
            (l) =>
              !l.deletedAt &&
              (statementFor.personId
                ? l.personId === statementFor.personId
                : l.personName.trim().toLowerCase() === statementFor.name.trim().toLowerCase()),
          )}
          transactions={transactions}
          scope="contact"
          phone={statementFor.phone}
          intro={statementIntro}
        />
      )}

      <AddLoanModal open={showAdd} onClose={() => setShowAdd(false)} />
    </main>
  );
}

function LoanGroupSummary({
  group,
  onRemind,
  reminderMeta,
}: {
  group: LoanGroup;
  onRemind?: () => void;
  reminderMeta?: string;
}) {
  const t = useT();
  const isGiven = group.direction === 'given';
  const isSettled = group.status === 'settled';
  const settledAmount = group.total - group.remaining;
  const progress = group.total > 0 ? settledAmount / group.total : 0;
  const primaryAmount = group.status === 'active' ? group.remaining : group.total;
  // A settled group celebrates in green — a red "TO PAY" header over a fully
  // paid relationship read like money was still owed.
  const tone = isSettled || isGiven ? 'receive' : 'pay';

  return (
    // Tinted stat card: the tint IS the direction the sheet is about — mint =
    // owed to you, coral = you owe; a settled group celebrates in mint.
    <Card3D tint={tone === 'receive' ? 'mint' : 'coral'} padding="sm">
      <p
        className={`text-[10.5px] font-semibold uppercase tracking-[0.12em] ${
          tone === 'receive' ? 'text-receive-text' : 'text-pay-text'
        }`}
      >
        {isSettled ? (
          <span className="inline-flex items-center gap-1">
            <Glyph name="check" size={12} strokeWidth={3} /> {t('loan_group_settled_label')}
          </span>
        ) : (
          isGiven ? t('loan_receivable') : t('loan_payable')
        )} · {group.currency}
      </p>
      <p className="text-[21px] font-semibold text-ink-900 tabular-nums tracking-[-0.03em] mt-1.5 leading-tight">
        {formatMoney(primaryAmount, group.currency)}
      </p>
      <p className="text-[11px] text-ink-600 mt-1">
        {(isGiven ? t('loans_progress_received') : t('loans_progress_paid'))
          .replace('{paid}', formatMoney(settledAmount, group.currency))
          .replace('{total}', formatMoney(group.total, group.currency))}
      </p>
      {/* Recessed track, lit fill in the card's own tone. */}
      <div className="m-inset mt-3 h-2 rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-500 bg-gradient-to-b ${
            tone === 'receive' ? 'from-receive-600 to-receive-700' : 'from-pay-600 to-pay-700'
          }`}
          style={{ width: `${Math.round(progress * 100)}%` }}
        />
      </div>
      {onRemind ? (
        <div className="mt-3.5 flex items-center gap-2">
          {reminderMeta && (
            <p className="flex-1 text-[11px] text-ink-600">{reminderMeta}</p>
          )}
          <button
            type="button"
            onClick={onRemind}
            className="m-btn m-btn-plain ms-auto min-h-[36px] px-3 py-1.5 text-[11.5px] rounded-xl gap-1.5"
          >
            <Glyph name="bell" size={12} tone="violet" /> {t('reminder_cta')}
          </button>
        </div>
      ) : null}
    </Card3D>
  );
}

function LoanDrilldownRow({ loan, onClick }: { loan: Loan; onClick: () => void }) {
  const t = useT();
  const progress = loan.totalAmount > 0 ? (loan.totalAmount - loan.remainingAmount) / loan.totalAmount : 0;
  const isSettled = loan.status === 'settled';
  return (
    <button
      type="button"
      onClick={onClick}
      className="m-tile p-3.5 flex items-center gap-3 text-left"
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between gap-3">
          <p className="text-[13.5px] font-semibold text-ink-900 tabular-nums tracking-[-0.01em]">
            {formatMoney(loan.totalAmount, loan.currency)}
          </p>
          <span className={`m-chip m-chip-caps ${isSettled ? 'm-chip-receive' : 'm-chip-gold'}`}>
            {isSettled && <Glyph name="check" size={10} strokeWidth={3} />}
            {isSettled ? t('loan_status_settled') : t('loan_status_active')}
          </span>
        </div>
        <p className="text-[10.5px] text-ink-600 mt-1 tabular-nums">
          {t('loan_remaining')}: {formatMoney(loan.remainingAmount, loan.currency)}
        </p>
        <div className="m-inset mt-2 h-1.5 rounded-full overflow-hidden">
          <div
            className="h-full rounded-full bg-gradient-to-b from-accent-500 to-accent-600"
            style={{ width: `${Math.round(progress * 100)}%` }}
          />
        </div>
        {loan.notes ? (
          <p className="text-[10.5px] text-ink-400 italic mt-1.5 truncate">"{loan.notes}"</p>
        ) : null}
      </div>
      <Glyph name="chevron-right" size={15} className="text-ink-400" />
    </button>
  );
}
