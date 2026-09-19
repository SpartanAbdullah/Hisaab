import { useState, useRef, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowDownLeft, ArrowUpRight, ArrowLeftRight,
  HandCoins, Handshake, RotateCcw, Target, Delete, Users, Plus, ChevronDown, ChevronRight, Lock,
  Search, X, CreditCard,
} from 'lucide-react';
import { useAccountStore } from '../stores/accountStore';
import { useTransactionStore, loanScheduleAlreadyCreated, type TransactionInput } from '../stores/transactionStore';
import { useLoanStore } from '../stores/loanStore';
import { useGoalStore } from '../stores/goalStore';
import { useEmiStore } from '../stores/emiStore';
import { useUpcomingExpenseStore } from '../stores/upcomingExpenseStore';
import { usePersonStore } from '../stores/personStore';
import { useLinkedRequestStore, LINKED_REQUEST_CURRENCIES } from '../stores/linkedRequestStore';
import { useAppModeStore } from '../stores/appModeStore';
import { useSplitStore } from '../stores/splitStore';
import { Modal } from '../components/Modal';
import { Tile3D } from '../components/Tile3D';
import { Card3D } from '../components/Card3D';
import type { Tint as ClayTint } from '../lib/material';
import { Glyph } from '../components/Glyph';
import { useDiscardGuard } from '../lib/useDiscardGuard';
import { useSubmitGuard, useSubmitIntentId } from '../lib/useSubmitGuard';
import { ContactPicker, type ContactValue } from '../components/ContactPicker';
import { AccountSelect } from '../components/AccountSelect';
import { decideLinkedBranch } from '../lib/linkedRequestBranch';
import { linkedLoanIdSet } from '../lib/linkedLoanIdSet';
import { useVisualViewportInset } from '../hooks/useVisualViewportInset';
import { buildRepaymentGroups } from '../lib/repaymentGroups';
import { allocateRepayment, previewAllocations } from '../lib/repaymentAllocation';
import { executeAllocatedRepayments } from '../lib/repaymentExecution';
import { isLoanRemainingConflict } from '../lib/loanRemainingDelta';
import { executeSplitEvent } from '../lib/splitEvent';
import { SplitWithSheet, type SplitPlan } from '../components/SplitWithSheet';
import { CurrencyConversionCard } from '../components/CurrencyConversionCard';
import { rateIsSane } from '../lib/conversionMath';
import { confirmCrossUserRequest } from '../lib/confirmCrossUserRequest';
import { ConfirmationSheet } from '../components/ConfirmationSheet';
import { SpendingWarningModal } from '../components/SpendingWarningModal';
import { useToast } from '../components/Toast';
import { buildPayeeProfiles, matchPayee, mismatchedTxnIds, normalizePayee } from '../lib/payeeMemory';
import { formatMoney, formatSignedMoney } from '../lib/constants';
import { statementInstalmentDates } from '../lib/cardStatement';
import { planEmiRows } from '../lib/emiPlan';
import { getPrimaryCurrency } from '../lib/primaryCurrency';
import { localIso } from '../lib/thisWeek';
import { CategoryPicker } from '../components/CategoryPicker';
import { ShareKhataLinkSheet } from '../components/ShareKhataLinkSheet';
import { useT } from '../lib/i18n';
import { track } from '../lib/telemetry';
import { bucketAmount } from '../lib/telemetryEvents';
import { shouldOfferKhataShareNudge, snoozeKhataShareNudge } from '../lib/khataLinkStatus';
import { type Currency, type TransactionType, type SplitGroup, type Loan } from '../db';
import { CurrencyPicker } from '../components/CurrencyPicker';
import { AddAccountStepper } from './AddAccountStepper';

// Internal type slot widened to include the "group_expense" sentinel.
// It's NOT a real `TransactionType` (those map 1:1 to rows in the
// transactions table); group expenses live in their own table and are
// authored via AddGroupExpenseModal, so the type guard is "if the user
// picked this tile, route to the group-picker step and hand off to App."
type EntryKind = TransactionType | 'group_expense';

// 'split' is an intent, never an EntryKind: an ad-hoc split still SAVES as an
// ordinary expense (type stays 'expense') and fans out through
// executeSplitEvent. It exists as its own tile only because "split the coffee"
// has to be findable — buried as a chip halfway down the Spend form, it wasn't.
type EntryIntent = 'expense' | 'income' | 'transfer' | 'person_money' | 'group_expense' | 'cash_advance' | 'split';
type RepaymentDirection = 'received' | 'paid' | null;
// What a repayment applies to: the person(+currency) GROUP — one lump spread
// across their loans oldest-first — or one specific loan line (today's
// behavior, still available under "choose a specific loan").
type RepayTarget = { kind: 'group'; key: string } | { kind: 'loan'; id: string } | null;

export interface QuickEntryPreset {
  type?: Extract<TransactionType, 'expense' | 'income' | 'transfer' | 'loan_given' | 'loan_taken' | 'repayment'>;
  // `intent` lets callers start QuickEntry at a higher level than `type`.
  // 'person_money' starts at the gave/borrowed/paid-back sub-picker;
  // 'group_expense' routes amount → group picker.
  intent?: 'person_money' | 'group_expense';
  contact?: ContactValue;
  repaymentDirection?: Exclude<RepaymentDirection, null>;
  accountId?: string;
  // Pre-fill the transfer DESTINATION (e.g. paying a credit-card bill, where
  // the card is the destination and the user picks which account pays).
  destinationAccountId?: string;
  // Cash advance: pre-select (and lock) the credit card funding a loan_taken.
  // Used by the card page's "Cash advance" action — the user only enters the
  // amount and picks where the cash landed; no contact is asked for.
  cashAdvanceCardId?: string;
  lockContact?: boolean;
  lockAccount?: boolean;
}

interface Props {
  open: boolean;
  onClose: () => void;
  // QuickEntry → Group expense bridge. App holds the AddGroupExpenseModal
  // + CreateGroupModal so the user can finish the entry without losing
  // their typed amount when QuickEntry closes.
  onPickGroupExpense?: (group: SplitGroup, amount: string) => void;
  onCreateGroupForExpense?: (amount: string) => void;
  preset?: QuickEntryPreset | null;
}

export function QuickEntry({
  open,
  onClose,
  onPickGroupExpense,
  onCreateGroupForExpense,
  preset,
}: Props) {
  const { accounts } = useAccountStore();
  const { processTransaction } = useTransactionStore();
  const transactions = useTransactionStore((s) => s.transactions);
  const { loans } = useLoanStore();
  const { createLoan, applyRepayment, loadLoans } = useLoanStore();
  const { goals } = useGoalStore();
  const { generateSchedule } = useEmiStore();
  const { expenses: upcomingExpenses } = useUpcomingExpenseStore();
  const groups = useSplitStore((s) => s.groups);
  const groupsLoading = useSplitStore((s) => s.loading);
  const loadGroups = useSplitStore((s) => s.loadGroups);
  const appMode = useAppModeStore((s) => s.mode);
  const linkedRequests = useLinkedRequestStore((s) => s.requests);
  const navigate = useNavigate();
  const toast = useToast();
  const t = useT();
  const guardClose = useDiscardGuard();
  const submitGuard = useSubmitGuard();
  // Audit MF-02: the Save footer sits inside Modal's fixed bottom sheet,
  // which stays pinned to the (keyboard-unaware) layout viewport on iOS
  // Safari / standalone PWA. Extra bottom padding — invisible until the
  // keyboard covers it — pushes the visible buttons up above the keyboard.
  // No-op on Chrome/Android (index.html's `interactive-widget=resizes-
  // content` already handles it there) and on native (hook returns 0).
  const keyboardInset = useVisualViewportInset();

  const [step, setStep] = useState(0);
  const [intent, setIntent] = useState<EntryIntent | null>(null);
  const [amount, setAmount] = useState('');
  const [type, setType] = useState<EntryKind>('expense');
  const [repaymentDirection, setRepaymentDirection] = useState<RepaymentDirection>(null);
  // Cash-advance mode: a loan_taken funded by one of the user's own credit
  // cards. No counterparty is asked for — the card IS the counterparty.
  const [cashAdvance, setCashAdvance] = useState(false);
  const [sourceId, setSourceId] = useState('');
  const [destId, setDestId] = useState('');
  const [category, setCategory] = useState('');
  const [notes, setNotes] = useState('');
  const [contact, setContact] = useState<ContactValue>({ id: null, name: '' });
  const [repayTarget, setRepayTarget] = useState<RepayTarget>(null);
  const [expandedGroupKey, setExpandedGroupKey] = useState('');
  const [loanSearch, setLoanSearch] = useState('');
  const [goalId, setGoalId] = useState('');
  const [conversionRate, setConversionRate] = useState('');
  const [ledgerCurrency, setLedgerCurrency] = useState<Currency>(() => getPrimaryCurrency());
  const [hasEmi, setHasEmi] = useState(false);
  const [emiInstallments, setEmiInstallments] = useState('');
  const [emiStartDate, setEmiStartDate] = useState('');
  const [saving, setSaving] = useState(false);
  const [showConfirmation, setShowConfirmation] = useState(false);
  // `settled`: this save closed a debt (a repayment that cleared its loan, or a
  // lump that cleared at least one) — the ConfirmationSheet swaps its wallet
  // for the CelebrationMark's confetti burst. Same predicate as the
  // `settles` analytics flag on the matching trackSaved call; keep them equal.
  const [confirmData, setConfirmData] = useState<{ title: string; description: string; changes: Array<{ accountName: string; currency: string; before: number; after: number }>; route?: string; settled?: boolean }>({ title: '', description: '', changes: [] });
  const [showInlineAccount, setShowInlineAccount] = useState(false);
  const [showSpendingWarning, setShowSpendingWarning] = useState(false);
  // Ad-hoc split: a MODIFIER on an ordinary expense, not an entry type of its
  // own. Null = plain expense. Set = the bill is shared, and submit fans the
  // one entry out into the payer's share plus a receivable per person.
  const [splitPlan, setSplitPlan] = useState<SplitPlan | null>(null);
  const [showSplitSheet, setShowSplitSheet] = useState(false);
  // The Split tile is an explicit "I want to split this", so the sheet opens
  // itself once on arrival at the details step. A ref, not state, because
  // dismissing the sheet must NOT re-arm it — otherwise a user who closes it
  // is trapped in a sheet that reopens on every render.
  const splitSheetAutoOpened = useRef(false);
  const amountRef = useRef<HTMLInputElement>(null);

  // One request id per submit intent: the same id survives a double tap and a
  // retry of an unchanged form (so a duplicate insert collides on the primary
  // key instead of mirroring a second debt onto the other user), and is
  // replaced the instant the entry type, amount, contact, or note changes —
  // or the modal reopens.
  const nextRequestId = useSubmitIntentId(
    [open, type, contact.id ?? '', contact.name.trim(), amount, notes].join('|'),
  );

  useEffect(() => {
    if (open && step === 0) setTimeout(() => amountRef.current?.focus(), 300);
  }, [open, step]);

  // ── Telemetry (audit 2026-09 report 10, catalog #8/#9/#10) ──────────────
  // QuickEntry is the activation moment: a user who never reaches
  // `entry_created` never activated. `quick_entry_abandoned` is its shadow —
  // opened, typed, walked away — which no other signal can reconstruct.
  // Refs, not state: the abandonment event fires from a cleanup where the
  // rendered closure is already stale.
  const wasOpenRef = useRef(false);
  const savedRef = useRef(false);
  const firstEverRef = useRef(false);
  const stepRef = useRef(step);
  const hadAmountRef = useRef(false);
  const hasPresetRef = useRef(false);
  useEffect(() => {
    stepRef.current = step;
    hadAmountRef.current = amount.trim().length > 0;
    hasPresetRef.current = !!preset;
  }, [step, amount, preset]);

  useEffect(() => {
    if (open && !wasOpenRef.current) {
      wasOpenRef.current = true;
      savedRef.current = false;
      // "First ever" is decided at OPEN time — after a successful save the
      // stores are no longer empty, so reading it later would always say false.
      firstEverRef.current =
        useTransactionStore.getState().transactions.length === 0
        && useLoanStore.getState().loans.length === 0;
      track('quick_entry_opened', { source: hasPresetRef.current ? 'preset' : 'fab' });
    } else if (!open && wasOpenRef.current) {
      wasOpenRef.current = false;
      if (!savedRef.current) {
        track('quick_entry_abandoned', { last_step: stepRef.current, had_amount: hadAmountRef.current });
      }
    }
  }, [open]);

  // L2 share-at-save nudge (audit 2026-09 P3): offered at most once every 14
  // days per person. See offerKhataNudge below and trackSaved's loan branch.
  const [khataNudge, setKhataNudge] = useState<{ personId: string; personName: string; phone: string | null } | null>(null);
  const offerKhataNudge = (recipient: { id: string; name: string; phone: string | null }) => {
    if (!shouldOfferKhataShareNudge(recipient.id)) return;
    snoozeKhataShareNudge(recipient.id);
    toast.show({
      type: 'info',
      title: t('khata_nudge_toast_title').replace('{name}', recipient.name),
      action: {
        label: t('khata_nudge_toast_action'),
        onPress: () => setKhataNudge({ personId: recipient.id, personName: recipient.name, phone: recipient.phone }),
      },
    });
  };

  // One place where a saved entry is reported. Amount travels as a BUCKET and
  // the note/contact/account names never leave the device (enforced by the
  // schema in src/lib/telemetryEvents.ts).
  const trackSaved = (
    entryType: 'expense' | 'income' | 'transfer' | 'loan_given' | 'loan_taken' | 'repayment'
      | 'goal_contribution' | 'cash_advance' | 'split' | 'linked_request',
    entryCurrency: string,
    amountValue: number,
    extra?: {
      loan?: {
        direction: 'given' | 'taken'; linked: boolean; hasSchedule: boolean;
        // L2 share-at-save nudge (audit 2026-09 P3): who to offer the khata
        // link for. Omitted callers simply skip the nudge.
        person?: { id: string; name: string; phone: string | null };
      };
      repayment?: { consolidated: boolean; settles: boolean };
    },
  ) => {
    savedRef.current = true;
    const mode = appMode === 'splits_only' ? 'splits_only' : 'full_tracker';
    track('entry_created', {
      entry_type: entryType,
      source: 'quick_entry',
      is_first_ever: firstEverRef.current,
      mode,
      currency: entryCurrency,
      amount_bucket: bucketAmount(amountValue),
    });
    if (extra?.loan) {
      track('loan_created', {
        direction: extra.loan.direction,
        linked_contact: extra.loan.linked,
        has_schedule: extra.loan.hasSchedule,
        currency: entryCurrency,
        mode,
      });
      if (extra.loan.person) offerKhataNudge(extra.loan.person);
    }
    if (extra?.repayment) {
      track('repayment_recorded', {
        consolidated: extra.repayment.consolidated,
        settles_loan: extra.repayment.settles,
        mode,
        currency: entryCurrency,
      });
    }
  };

  // Safety-net: kick off a groups load the moment QuickEntry opens. If
  // App.tsx already preloaded on boot (the common case), this is a no-op
  // because the store already has the data — the fetch isn't gated on
  // empty state but `loadGroups` itself returns fast on a warm cache.
  // Belt-and-braces ensures the picker never shows "no groups" when the
  // user actually has some.
  useEffect(() => {
    if (open) void loadGroups().catch(() => {});
  }, [open, loadGroups]);

  // Same safety-net for accounts and loans. QuickEntry can open over a page
  // that never loaded them (an unmatched URL, a cold deep-link) — the gate
  // used to read an empty store and lie: "You need an account first" with 13
  // accounts existing. Cache-first loads make this cheap on a warm cache.
  useEffect(() => {
    if (!open) return;
    const { accounts: loadedAccounts, loadAccounts } = useAccountStore.getState();
    if (loadedAccounts.length === 0) void loadAccounts().catch(() => {});
    const { loans: loadedLoans, loadLoans } = useLoanStore.getState();
    if (loadedLoans.length === 0) void loadLoans().catch(() => {});
    const { schedules, loadSchedules } = useEmiStore.getState();
    if (schedules.length === 0) void loadSchedules().catch(() => {});
  }, [open]);

  // FIX 4: Rename Transfer to Move
  // Eighth tile (`group_expense`) is a sentinel — not a TransactionType.
  // Picking it routes Step 2 to a group picker instead of the normal
  // details form. The actual save happens in AddGroupExpenseModal which
  // App.tsx opens once the user picks (or creates) a group.
  const TX_TYPES = [
    { value: 'expense' as EntryKind, label: t('tx_expense'), sub: t('tx_expense_sub'), icon: ArrowUpRight },
    { value: 'income' as EntryKind, label: t('tx_income'), sub: t('tx_income_sub'), icon: ArrowDownLeft },
    { value: 'transfer' as EntryKind, label: t('tx_transfer'), sub: t('tx_transfer_sub'), icon: ArrowLeftRight },
    { value: 'loan_given' as EntryKind, label: t('tx_loan_given'), sub: t('tx_loan_given_sub'), icon: HandCoins },
    { value: 'loan_taken' as EntryKind, label: t('tx_loan_taken'), sub: t('tx_loan_taken_sub'), icon: Handshake },
    { value: 'repayment' as EntryKind, label: t('tx_repayment'), sub: t('tx_repayment_sub'), icon: RotateCcw },
    { value: 'goal_contribution' as EntryKind, label: t('tx_goal_contribution'), sub: t('tx_goal_contribution_sub'), icon: Target },
    { value: 'group_expense' as EntryKind, label: t('intent_group'), sub: t('intent_group_sub'), icon: Users },
  ];
  // Intent picker. Splits-only mode has no accounts, so the Spend/Receive/
  // Move intents (which require source/dest account selection) are hidden
  // entirely — only the people-oriented intents remain. Full-tracker mode
  // shows everything; "Cash advance" appears only when a credit card exists.
  const hasCreditCard = accounts.some((a) => a.type === 'credit_card');
  // One tinted 1d tile per intent. Tint = the money semantics the app uses
  // everywhere (receive → mint, spend → coral, cash advance → gold, move →
  // neutral, khata → pink, splits/groups → blue); the glyph names the act
  // exactly (a receipt for spending, arrows for moving between accounts).
  const ALL_INTENTS: {
    value: EntryIntent; label: string; sub: string; tint: ClayTint; clayIcon: string;
  }[] = [
    // Art picked by what the asset SHOWS, not by what the tile is filed
    // under: a shopping bag for spending, a banknote stack for money coming
    // in, a wallet for moving your own money between your own accounts, a
    // person for money with one person, a payment card for a cash advance.
    // `group_expense` keeps `chat` — the pack has no multi-person art
    // (`person`/`person2`/`people` are all SINGLE figures), and the two
    // overlapping speech bubbles are the only asset that reads as "several
    // people", so a lone figure would be a downgrade here.
    //
    // ORDER is a founder decision (2026-09-06): Spend first, Money With
    // Someone second, Split an Expense third, then the rest in their previous
    // relative order. Nothing else reads this array by index — the
    // splits_only filter below keeps whatever survives, in this order.
    { value: 'expense', label: t('intent_spend'), sub: t('intent_spend_sub'), tint: 'coral', clayIcon: 'receipt' },
    { value: 'person_money', label: t('intent_person'), sub: t('intent_person_sub'), tint: 'blush', clayIcon: 'person' },
    { value: 'split', label: t('intent_split'), sub: t('intent_split_sub'), tint: 'sky', clayIcon: 'split' },
    { value: 'income', label: t('intent_receive'), sub: t('intent_receive_sub'), tint: 'mint', clayIcon: 'banknote' },
    { value: 'transfer', label: t('intent_move'), sub: t('intent_move_sub'), tint: 'neutral', clayIcon: 'swap' },
    { value: 'group_expense', label: t('intent_group'), sub: t('intent_group_sub'), tint: 'sky', clayIcon: 'groups' },
    { value: 'cash_advance', label: t('intent_cash_advance'), sub: t('intent_cash_advance_sub'), tint: 'gold', clayIcon: 'card' },
  ];
  // The ad-hoc split needs no accounts (executeSplitEvent writes loans only in
  // splits_only), so unlike Spend/Receive/Move it survives the ledger-only
  // filter — it is the single most-asked-for thing a ledger-only user does.
  const INTENTS = appMode === 'splits_only'
    ? ALL_INTENTS.filter((i) => i.value === 'person_money' || i.value === 'group_expense' || i.value === 'split')
    : ALL_INTENTS.filter((i) => i.value !== 'cash_advance' || hasCreditCard);

  const reset = () => {
    setStep(0); setIntent(null); setAmount(''); setType('expense'); setRepaymentDirection(null);
    setCashAdvance(false);
    setSourceId(''); setDestId(''); setCategory('');
    setNotes(''); setContact({ id: null, name: '' }); setRepayTarget(null); setExpandedGroupKey(''); setLoanSearch('');
    setGoalId(''); setConversionRate('');
    setHasEmi(false); setEmiInstallments(''); setEmiStartDate('');
    setSplitPlan(null); setShowSplitSheet(false);
    splitSheetAutoOpened.current = false;
  };
  const handleClose = () => { reset(); onClose(); };

  useEffect(() => {
    if (!open) return;
    // Type-first flow: the wizard opens on "What happened?" (step 1) and only
    // asks for the amount once the type is known, so the amount screen can
    // carry context. Presets that already know the type skip straight to the
    // amount; person_money presets start at the gave/borrowed/paid sub-picker.
    setStep(
      preset?.type || preset?.cashAdvanceCardId || preset?.intent === 'group_expense'
        ? 0
        : preset?.intent === 'person_money'
          ? 3
          : 1,
    );
    setIntent(preset?.intent ?? null);
    setAmount('');
    setType(preset?.intent === 'group_expense' ? 'group_expense' : (preset?.type ?? 'expense'));
    setRepaymentDirection(preset?.repaymentDirection ?? null);
    setCashAdvance(!!preset?.cashAdvanceCardId);
    setSourceId(
      preset?.cashAdvanceCardId
        ? preset.cashAdvanceCardId
        : preset?.accountId && ['expense', 'transfer', 'loan_given'].includes(preset.type ?? '')
          ? preset.accountId
          : '',
    );
    setDestId(
      preset?.accountId && ['income', 'loan_taken'].includes(preset.type ?? '') && !preset?.cashAdvanceCardId
        ? preset.accountId
        : preset?.destinationAccountId && preset.type === 'transfer'
          ? preset.destinationAccountId
          : '',
    );
    setContact(preset?.contact ?? { id: null, name: '' });
    setRepayTarget(null);
    setExpandedGroupKey('');
    setCategory('');
    setNotes('');
    setConversionRate('');
    setSplitPlan(null);
    splitSheetAutoOpened.current = false;
  }, [open, preset]);

  useEffect(() => {
    if (!open) return;
    if (preset?.cashAdvanceCardId) {
      if (type === 'loan_taken') setSourceId(preset.cashAdvanceCardId);
      return; // cash-advance preset carries no accountId — nothing else to re-apply
    }
    if (preset?.accountId) {
      if (['expense', 'transfer', 'loan_given'].includes(type)) setSourceId(preset.accountId);
      if (['income', 'loan_taken'].includes(type)) setDestId(preset.accountId);
      // Repayment splits by loan direction at submit; preselect both sides so
      // whichever one the chosen loan needs is already the viewed account.
      if (type === 'repayment') { setSourceId(preset.accountId); setDestId(preset.accountId); }
    }
    if (preset?.destinationAccountId && type === 'transfer') setDestId(preset.destinationAccountId);
  }, [open, preset?.accountId, preset?.destinationAccountId, preset?.cashAdvanceCardId, type]);

  const numpadPress = (key: string) => {
    if (key === 'del') { setAmount(a => a.slice(0, -1)); }
    else if (key === '.') { if (!amount.includes('.')) setAmount(a => a + '.'); }
    else { const parts = amount.split('.'); if (parts[1]?.length >= 2) return; setAmount(a => a + key); }
  };

  const isLedgerOnlyPersonFlow = appMode === 'splits_only' && ['loan_given', 'loan_taken', 'repayment'].includes(type);
  // Ledger-only ad-hoc split. splits_only has NO accounts, so the split runs
  // as a pure ledger flow: no From picker, no account leg, no expense row —
  // executeSplitEvent(mode: 'splits_only') writes loans only. Without this
  // escape the shared `needsSource` rule for 'expense' would demand an account
  // that can never exist, exactly the class of bug lessons.md warns about.
  const isLedgerOnlySplitFlow = appMode === 'splits_only' && type === 'expense';
  const needsSource = !isLedgerOnlyPersonFlow && !isLedgerOnlySplitFlow && ['expense', 'transfer', 'loan_given', 'goal_contribution'].includes(type);
  const needsDest = !isLedgerOnlyPersonFlow && ['income', 'transfer', 'loan_taken'].includes(type);
  const needsPerson = ['loan_given', 'loan_taken'].includes(type);
  const needsLoan = type === 'repayment';
  const needsGoal = type === 'goal_contribution';
  // No category in the ledger-only split: nothing there writes an expense row,
  // so a category picker would collect a value the save quietly discards.
  const showCategory = ['income', 'expense'].includes(type) && !isLedgerOnlySplitFlow;
  const isGroupExpense = type === 'group_expense';
  // Splitting is offered on a plain expense only. A group expense already has
  // its own split UI, and every other type is either not shared (income,
  // transfer) or already person-to-person (loans, repayments).
  const canSplit = type === 'expense' && !isGroupExpense;

  // Switching away from Spend must drop a configured split — otherwise a plan
  // built for an expense would silently ride along onto an Income or Move
  // entry, whose submit path has no idea what to do with it.
  useEffect(() => {
    if (!canSplit && splitPlan) setSplitPlan(null);
  }, [canSplit, splitPlan]);

  // Split intent → open the sheet the moment the details step is reached, so
  // the tile actually leads somewhere instead of dumping the user on a Spend
  // form and hoping they spot the chip. Fires at most once per open (the ref),
  // and never when a plan already exists — reopening to edit is the chip's job.
  useEffect(() => {
    if (!open || step !== 2 || intent !== 'split') return;
    if (splitPlan || splitSheetAutoOpened.current) return;
    splitSheetAutoOpened.current = true;
    setShowSplitSheet(true);
  }, [open, step, intent, splitPlan]);
  // A loan is "linked" when an accepted linked_transaction_request mirrors it
  // to another Hisaab user. Such a loan must settle through the dedicated
  // settlement-request flow (so the counterparty confirms) — repaying it
  // locally here would diverge the two mirrored ledgers.
  const linkedLoanIds = linkedLoanIdSet(linkedRequests);
  const selectedLoan = repayTarget?.kind === 'loan' ? loans.find(l => l.id === repayTarget.id) : undefined;
  const selectedLoanIsLinked = !!selectedLoan && linkedLoanIds.has(selectedLoan.id);
  const hasAccounts = accounts.length > 0;

  // The person (+ currency) group is the primary repayment target: one lump
  // settles across their loans oldest-first, so ten borrowings never force
  // ten entries. Grouping reuses LoansPage's key rule so it stays consistent
  // app-wide; the search box narrows by name or note. When no direction was
  // picked (top-level Repayment tile) both directions are listed.
  const buildGroupsFor = (direction: 'received' | 'paid') =>
    buildRepaymentGroups({
      loans,
      direction,
      linkedLoanIds,
      personIdFilter: preset?.contact?.id,
      query: loanSearch,
    });
  const repaymentLoanGroups = repaymentDirection
    ? buildGroupsFor(repaymentDirection)
    : [...buildGroupsFor('received'), ...buildGroupsFor('paid')].sort((a, b) => b.totalRemaining - a.totalRemaining);
  // Pre-search count: drives the empty state and when the search box appears
  // (only once the list is long enough that scanning is the friction).
  const repayableLoanCount = loans.filter((l) =>
    l.status === 'active' &&
    (repaymentDirection === 'received' ? l.type === 'given' : repaymentDirection === 'paid' ? l.type === 'taken' : true) &&
    (!preset?.contact?.id || l.personId === preset.contact.id),
  ).length;
  const showLoanSearch = repayableLoanCount > 4;

  // Effective repayment context — one loan or a whole group. Every guard,
  // the account requirement and the conversion card key off these four
  // instead of a single selected loan.
  const selectedRepayGroup = repayTarget?.kind === 'group' ? repaymentLoanGroups.find((g) => g.key === repayTarget.key) : undefined;
  const repayDirectionType = selectedLoan?.type ?? selectedRepayGroup?.direction;
  const repayCurrency = selectedLoan?.currency ?? selectedRepayGroup?.currency;
  const repayCap = selectedLoan ? selectedLoan.remainingAmount : selectedRepayGroup?.allocatableRemaining ?? 0;
  // Oldest-first (FIFO): a consolidated return pays down what they've owed
  // longest — the split the user would have calculated by hand.
  const repayAllocations = selectedRepayGroup && parseFloat(amount) > 0
    ? allocateRepayment(selectedRepayGroup.allocatable, parseFloat(amount), 'oldest')
    : [];
  // A group target that reaches exactly one loan behaves byte-identically to
  // picking that loan directly (incl. the per-loan confirm route).
  const groupSingleLoan = repayTarget?.kind === 'group' && repayAllocations.length === 1
    ? loans.find((l) => l.id === repayAllocations[0].loanId)
    : undefined;
  const effectiveSingleLoan = selectedLoan ?? groupSingleLoan;
  const isGroupBatch = repayTarget?.kind === 'group' && repayAllocations.length > 1;

  // Group-expense handoff. The actual save happens in App's
  // AddGroupExpenseModal — we just close + relay.
  const handlePickGroup = (group: SplitGroup) => {
    onPickGroupExpense?.(group, amount);
    reset();
  };
  const handleCreateNewGroup = () => {
    onCreateGroupForExpense?.(amount);
    reset();
  };

  // BATCH6: Universal cross-currency detection for ALL transaction types
  const srcAccount = accounts.find(a => a.id === sourceId);
  const dstAccount = accounts.find(a => a.id === destId);
  const selectedGoal = goals.find(g => g.id === goalId);
  const availableCashAdvanceCards = accounts.filter(a =>
    a.type === 'credit_card' &&
    a.id !== destId &&
    (!dstAccount || a.currency === dstAccount.currency)
  );
  const selectedCashAdvanceCard = availableCashAdvanceCards.find(a => a.id === sourceId);

  // Side-aware account lock. A preset's accountId locks ONLY the side the
  // viewed account plays for the current type — never both. For transfers the
  // opposite list excludes the locked/selected account, otherwise "Move" from
  // an account page showed the same single account as both From and To and
  // the transfer could never be submitted (sourceId !== destId is required).
  const sourceLockId =
    preset?.lockAccount && preset.accountId && ['expense', 'transfer', 'loan_given', 'goal_contribution'].includes(type)
      ? preset.accountId
      : null;
  const destLockId =
    preset?.lockAccount && preset.accountId && ['income', 'loan_taken'].includes(type)
      ? preset.accountId
      : null;
  const sourceChoices = sourceLockId
    ? accounts.filter((a) => a.id === sourceLockId)
    : accounts.filter((a) => type !== 'transfer' || !destId || a.id !== destId);
  const destChoices = (() => {
    let list = destLockId
      ? accounts.filter((a) => a.id === destLockId)
      : accounts.filter((a) => type !== 'transfer' || !sourceId || a.id !== sourceId);
    // Cash advance: the money lands somewhere spendable — never another card —
    // and must match the funding card's currency (store-enforced).
    if (cashAdvance) {
      list = list.filter(
        (a) => a.type !== 'credit_card' && (!selectedCashAdvanceCard || a.currency === selectedCashAdvanceCard.currency),
      );
    }
    return list;
  })();

  // Seed account defaults when the details step opens so the collapsed
  // selector usually starts with the right account already picked: the
  // last-used account for everyday spend/receive, or the only account when
  // there's exactly one. Transfers stay manual (two sides must differ) and
  // presets/locks always win. The user can still tap the row to change.
  useEffect(() => {
    if (!open || step !== 2 || cashAdvance || isLedgerOnlyPersonFlow) return;
    // Seed ONLY an account whose currency matches what the amount was typed
    // under — expense/income have no conversion step, so a silently seeded
    // different-currency account would record the flat number in the wrong
    // currency. On mismatch we seed nothing and the user picks consciously.
    const seedable = (id: string) => {
      const a = accounts.find((x) => x.id === id);
      return a && a.currency === activeCurrency ? id : '';
    };
    const remembered = (key: string) => seedable(localStorage.getItem(key) ?? '');
    const onlyAccount = accounts.length === 1 ? seedable(accounts[0].id) : '';
    if (needsSource && !sourceId && type !== 'transfer' && !sourceLockId) {
      setSourceId((type === 'expense' ? remembered('hisaab_qe_last_source') : '') || onlyAccount);
    }
    if (needsDest && !destId && type !== 'transfer' && !destLockId) {
      setDestId((type === 'income' ? remembered('hisaab_qe_last_dest') : '') || onlyAccount);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, step, type]);

  // ── Payee memory ──────────────────────────────────────────────────────────
  // Typing a payee you've used before ("Careem") pre-fills the category and
  // account you always pick — entry speed is the product in a manual-entry
  // app. Exact-match only, only-when-empty (never fights a user's pick).
  const payeeProfiles = useMemo(() => buildPayeeProfiles(transactions), [transactions]);
  const payeeMatch = useMemo(
    () => (type === 'expense' && !isGroupExpense ? matchPayee(payeeProfiles, notes) : null),
    [payeeProfiles, notes, type, isGroupExpense],
  );
  // Tracks what the AUTOFILL set (vs a deliberate user pick) so editing the
  // payee away reverts it — an auto-filled value must always have a way back.
  const autoFilledCategoryRef = useRef<string | null>(null);
  useEffect(() => {
    if (!open) {
      autoFilledCategoryRef.current = null;
      return;
    }
    if (!payeeMatch) {
      // The note no longer matches: revert OUR fill (never a user's pick).
      if (autoFilledCategoryRef.current && category === autoFilledCategoryRef.current) {
        setCategory('');
      }
      autoFilledCategoryRef.current = null;
      return;
    }
    if (!category && payeeMatch.category) {
      setCategory(payeeMatch.category);
      autoFilledCategoryRef.current = payeeMatch.category;
    }
    if (!sourceId && !sourceLockId && payeeMatch.accountId) {
      const account = accounts.find((a) => a.id === payeeMatch.accountId);
      if (account && account.currency === activeCurrency) setSourceId(payeeMatch.accountId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payeeMatch, open]);

  // Active currency for the amount step + quick-amount presets. Prefer the
  // preset account's currency (when QuickEntry was launched pinned to an
  // account); otherwise the user's primary currency.
  const primaryCurrency = getPrimaryCurrency();
  const presetAccountId = preset?.accountId ?? preset?.cashAdvanceCardId;
  const presetAccount = presetAccountId ? accounts.find(a => a.id === presetAccountId) : undefined;
  const activeCurrency: Currency = presetAccount?.currency ?? primaryCurrency;
  // Currencies this user already holds money in — ranks the CurrencyPicker's
  // five inline chips. Both stores are already subscribed above, so this is a
  // map over data in memory, never a fetch.
  const usedCurrencies = useMemo(
    () => [...new Set([...accounts.map(a => a.currency), ...loans.map(l => l.currency)])],
    [accounts, loans],
  );
  // Quick-amount chips scale with the primary currency: PKR users deal in
  // far larger nominal amounts than AED users, so offer a bigger preset set.
  const quickAmounts = primaryCurrency === 'PKR'
    ? [500, 1000, 5000, 10000, 50000]
    : [50, 100, 500, 1000, 5000];

  // Determine if cross-currency conversion is needed
  const isCrossCurrency = (() => {
    if (type === 'transfer' && srcAccount && dstAccount) return srcAccount.currency !== dstAccount.currency;
    if (type === 'repayment' && repayCurrency && repayDirectionType) {
      if (repayDirectionType === 'given' && dstAccount) return dstAccount.currency !== repayCurrency;
      if (repayDirectionType === 'taken' && srcAccount) return srcAccount.currency !== repayCurrency;
    }
    if (type === 'goal_contribution' && srcAccount && selectedGoal) return srcAccount.currency !== selectedGoal.currency;
    return false;
  })();

  // Per-type props for the conversion card. `known` is the side the user has
  // already typed (the main amount); `other` is what the card asks about.
  // rateSemantics mirrors the store math EXACTLY:
  //   transfer / repayment-given → other = amount * rate  ('other-per-known')
  //   repayment-taken / goal     → other = amount / rate  ('known-per-other')
  // Previously the repayment-taken label asked for the rate in the opposite
  // direction from what the store divided by — following the label corrupted
  // the deduction. The card derives the rate from amounts, so the direction
  // can no longer be entered backwards.
  const conversionProps = (() => {
    if (type === 'transfer' && srcAccount && dstAccount)
      return { knownCurrency: srcAccount.currency, otherCurrency: dstAccount.currency, otherSide: 'receiving' as const, rateSemantics: 'other-per-known' as const };
    if (type === 'repayment' && repayCurrency && repayDirectionType) {
      // Same per-unit rate applies to every loan in a group batch — they all
      // share the group's currency by construction.
      if (repayDirectionType === 'given' && dstAccount)
        return { knownCurrency: repayCurrency, otherCurrency: dstAccount.currency, otherSide: 'receiving' as const, rateSemantics: 'other-per-known' as const };
      if (repayDirectionType === 'taken' && srcAccount)
        return { knownCurrency: repayCurrency, otherCurrency: srcAccount.currency, otherSide: 'paying' as const, rateSemantics: 'known-per-other' as const };
    }
    if (type === 'goal_contribution' && srcAccount && selectedGoal)
      return { knownCurrency: selectedGoal.currency, otherCurrency: srcAccount.currency, otherSide: 'paying' as const, rateSemantics: 'known-per-other' as const };
    return null;
  })();

  // Conversion-rate sanity bounds (Phase H2 hardening). A typo'd rate
  // would silently corrupt balances; reject outside a sane window.
  const rateIsValid = () => {
    if (!isCrossCurrency) return true;
    return rateIsSane(parseFloat(conversionRate));
  };

  const canSubmit = () => {
    const amt = parseFloat(amount);
    if (!amt) return false;
    // BATCH6: Block ALL cross-currency submissions without rate
    if (isCrossCurrency && !parseFloat(conversionRate)) return false;
    // Phase H2: reject out-of-bounds conversion rates
    if (!rateIsValid()) return false;
    // Phase H2: overpayment guard on repayments (mirrors the simple-mode
    // check at line 337, now applied to all paths). For a group target the
    // cap is the person's total allocatable remaining.
    if (type === 'repayment' && repayTarget) {
      if (amt > repayCap + 0.00001) return false;
    }
    switch (type) {
      case 'income': return !!destId;
      // Ledger-only: there is no account to require, so the split plan IS the
      // requirement — without one there is nothing this mode could record.
      case 'expense': return isLedgerOnlySplitFlow ? !!splitPlan : !!sourceId;
      case 'transfer': return !!sourceId && !!destId && sourceId !== destId;
      case 'loan_given': return (isLedgerOnlyPersonFlow || !!sourceId) && !!contact.name.trim();
      case 'loan_taken':
        // Cash advance: the card is the counterparty — require the card
        // (sourceId) instead of a typed contact.
        if (cashAdvance) return !!destId && !!selectedCashAdvanceCard;
        return (isLedgerOnlyPersonFlow || !!destId) && !!contact.name.trim();
      case 'repayment':
        if (!repayTarget) return false;
        if (repayTarget.kind === 'loan') {
          if (!selectedLoan) return false;
          // Linked loans settle via the loan page, not here.
          if (selectedLoanIsLinked) return false;
        } else if (!selectedRepayGroup || selectedRepayGroup.allocatable.length === 0) {
          return false;
        }
        if (isLedgerOnlyPersonFlow) return true;
        return repayDirectionType === 'given' ? !!destId : !!sourceId;
      case 'goal_contribution': return !!sourceId && !!goalId;
      default: return false;
    }
  };

  // Spending warning: check if source account has an upcoming expense within 30 days
  const upcomingForSource = sourceId
    ? upcomingExpenses.filter(e =>
        e.accountId === sourceId && e.status === 'upcoming' &&
        Math.ceil((new Date(e.dueDate).getTime() - Date.now()) / (1000 * 60 * 60 * 24)) <= 30
      ).sort((a, b) => new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime())
    : [];
  const nearestUpcoming = upcomingForSource[0] ?? null;

  const preSubmit = () => {
    // Only warn when this spend would actually leave the account short of the
    // upcoming bill — i.e. the balance after this deduction drops below the
    // bill amount. Previously EVERY spend for 30 days after adding a bill
    // triggered the full-screen warning, regardless of whether it threatened it.
    const amt = parseFloat(amount) || 0;
    const wouldFallShort =
      nearestUpcoming && srcAccount &&
      srcAccount.balance - amt < nearestUpcoming.amount;
    if (wouldFallShort && ['expense', 'transfer', 'loan_given', 'goal_contribution'].includes(type)) {
      setShowSpendingWarning(true);
      return;
    }
    handleSubmit();
  };

  // Phase 2B: whether the current form state will branch into a linked
  // request on submit. Drives the inline helper + CTA label only.
  const contactInStore = needsPerson && contact.id
    ? usePersonStore.getState().persons.find((p) => p.id === contact.id) ?? null
    : null;
  const branchAccount = type === 'loan_given' ? srcAccount : type === 'loan_taken' ? dstAccount : null;
  // Currency that would carry the cross-user record: the chosen account's
  // currency in full-tracker, the picked ledger currency in split-only.
  const branchCurrency = isLedgerOnlyPersonFlow ? ledgerCurrency : branchAccount?.currency;
  // In split-only the record can only be mirrored for currencies the linked
  // request table accepts (AED/PKR); other currencies stay local. Full-tracker
  // keeps its existing (un-gated) behaviour.
  const branchCurrencyMirrorable = !isLedgerOnlyPersonFlow
    || (!!branchCurrency && (LINKED_REQUEST_CURRENCIES as readonly string[]).includes(branchCurrency));
  const wouldBranchToLinked = !!(
    (type === 'loan_given' || type === 'loan_taken') &&
    contactInStore?.linkedProfileId &&
    branchCurrency &&
    branchCurrencyMirrorable
  );

  async function ensureResolvedPerson(name: string, id: string) {
    const existing = usePersonStore.getState().persons.find((p) => p.id === id);
    if (existing) return existing;
    return usePersonStore.getState().findOrCreateByName(name);
  }

  // Entry re-check lives in submitGuard (a ref, so two taps in one frame
  // can't both pass); `saving` stays purely for the disabled/label UI.
  const handleSubmit = () => submitGuard.run(runSubmit);

  const runSubmit = async () => {
    setShowSpendingWarning(false);
    const amt = parseFloat(amount);
    if (!amt) return;
    setSaving(true);
    try {
      let input: TransactionInput;
      const changes: Array<{ accountName: string; currency: string; before: number; after: number }> = [];

      // Resolve contact once if this entry type needs a person. `needsPerson`
      // is the source of truth for whether a contact row must exist. A cash
      // advance has no human counterparty — the card is the lender — so no
      // Person row is created (it would pollute the contact pickers).
      const resolvedPerson = needsPerson && !cashAdvance
        ? (contact.id
            ? await ensureResolvedPerson(contact.name.trim(), contact.id)
            : await usePersonStore.getState().findOrCreateByName(contact.name.trim()))
        : null;

      // A linked loan must settle through its dedicated flow so the OTHER
      // side confirms — never reduce it locally (that diverges the two
      // mirrored ledgers). Bounce to the loan page's settle action.
      if (type === 'repayment' && selectedLoan && selectedLoanIsLinked) {
        reset();
        onClose();
        navigate(`/loan/${selectedLoan.id}`);
        return;
      }

      if (isLedgerOnlyPersonFlow) {
        if (type === 'repayment') {
          if (amt > repayCap + 0.00001) {
            throw new Error('Repayment cannot exceed the remaining balance');
          }
          if (isGroupBatch && selectedRepayGroup) {
            // Consolidated repayment (ledger-only): one lump across the
            // person's loans, oldest first. No accounts are involved.
            const result = await executeAllocatedRepayments(repayAllocations, {
              mode: 'splits_only',
              direction: selectedRepayGroup.direction,
              notes,
              processTransaction,
              applyRepayment,
            });
            if (result.failed && result.done === 0) {
              throw result.failed.error instanceof Error ? result.failed.error : new Error('Failed');
            }
            if (result.failed) {
              // Committed prefix stays — report how far we got so a retry
              // only needs to cover the rest. A stale-write refusal (audit
              // C10) also means our remainings are behind: re-pull them so
              // the retry allocates against truth.
              if (isLoanRemainingConflict(result.failed.error)) await loadLoans();
              toast.show({
                type: 'error',
                title: t('alloc_partial_title').replace('{done}', String(result.done)).replace('{total}', String(result.total)),
                subtitle: result.failed.error instanceof Error ? result.failed.error.message : t('toast_error_generic'),
                duration: 6000,
              });
              reset();
              onClose();
              return;
            }
            const clearedCount = previewAllocations(selectedRepayGroup.allocatable, repayAllocations).filter((l) => l.cleared).length;
            trackSaved('repayment', selectedRepayGroup.currency, result.totalApplied, {
              repayment: { consolidated: true, settles: clearedCount > 0 },
            });
            setConfirmData({
              title: t('confirm_repayment_saved'),
              description:
                t('qe_group_done_desc')
                  .replace('{amount}', formatMoney(result.totalApplied, selectedRepayGroup.currency))
                  .replace('{n}', String(result.total)) +
                (clearedCount > 0 ? ` · ${t('qe_group_cleared_count').replace('{n}', String(clearedCount))}` : ''),
              changes: [],
              settled: clearedCount > 0,
            });
            setShowConfirmation(true);
            reset();
            return;
          }
          if (!effectiveSingleLoan) throw new Error('Loan not found');
          await applyRepayment(effectiveSingleLoan.id, amt, notes);
          trackSaved('repayment', effectiveSingleLoan.currency, amt, {
            repayment: { consolidated: false, settles: amt >= repayCap - 0.00001 },
          });
          setConfirmData({
            title: t('confirm_repayment_saved'),
            description: (effectiveSingleLoan.type === 'given' ? t('repay_done_received_desc') : t('repay_done_paid_desc'))
              .replace('{person}', effectiveSingleLoan.personName)
              .replace('{amount}', formatMoney(amt, effectiveSingleLoan.currency)),
            changes: [],
            route: `/loan/${effectiveSingleLoan.id}`,
            settled: amt >= repayCap - 0.00001,
          });
        } else {
          // Split-only can still mirror a loan to a linked contact. The
          // cross-user record carries no balance movement (no account is
          // involved), so split-only is irrelevant to it — branch exactly
          // like full-tracker. Only AED/PKR can be mirrored; any other
          // currency stays a local-only ledger loan.
          if (type === 'loan_given' || type === 'loan_taken') {
            const branch = decideLinkedBranch({
              type,
              person: resolvedPerson,
              requestCurrency: ledgerCurrency,
            });
            if (branch.branch === true && (LINKED_REQUEST_CURRENCIES as readonly string[]).includes(ledgerCurrency)) {
              const guard = await confirmCrossUserRequest({ amount: amt, currency: branch.currency, personName: resolvedPerson!.name });
              if (guard.blockedReason) { toast.show({ type: 'error', title: t('qe_err_check_amount'), subtitle: guard.blockedReason }); return; }
              if (!guard.ok) return;
              await useLinkedRequestStore.getState().createRequest({
                toUserId: branch.toUserId,
                personId: branch.personId,
                kind: branch.kind,
                amount: amt,
                currency: branch.currency,
                note: notes,
                requestId: nextRequestId(),
              });
              // Ledger-only mirror of a loan to a linked Hisaab user. It is a
              // real created entry from the user's point of view, so it counts.
              trackSaved('linked_request', branch.currency, amt, {
                loan: {
                  direction: type === 'loan_given' ? 'given' : 'taken', linked: true, hasSchedule: false,
                  person: { id: resolvedPerson!.id, name: resolvedPerson!.name, phone: resolvedPerson!.phone ?? null },
                },
              });
              toast.show({ type: 'success', title: t('ltr_sent_title'), subtitle: t('ltr_sent_subtitle') });
              reset();
              onClose();
              return;
            }
          }
          const loan = await createLoan({
            personName: resolvedPerson!.name,
            personId: resolvedPerson!.id,
            type: type === 'loan_given' ? 'given' : 'taken',
            totalAmount: amt,
            currency: ledgerCurrency,
            notes,
          });
          trackSaved(type === 'loan_given' ? 'loan_given' : 'loan_taken', ledgerCurrency, amt, {
            loan: {
              direction: loan.type, linked: false, hasSchedule: false,
              person: { id: loan.personId ?? resolvedPerson!.id, name: loan.personName, phone: resolvedPerson!.phone ?? null },
            },
          });
          setConfirmData({
            title: t('confirm_loan_saved'),
            description: (loan.type === 'given' ? t('loan_done_owes_you') : t('loan_done_you_owe'))
              .replace('{person}', loan.personName)
              .replace('{amount}', formatMoney(amt, loan.currency)),
            changes: [],
            route: `/loan/${loan.id}`,
          });
        }
        setShowConfirmation(true);
        reset();
        return;
      }

      // Phase 2B: Full Money Tracker can branch linked-contact loan entries
      // into an approval request. Simple mode must record local wallet effects
      // immediately, so it uses the normal transaction path below.
      // A cash advance never branches (it's between the user and their own
      // card). Lending to a person FROM a card does — `selectedCashAdvanceCard`
      // is set whenever the From account is ANY card, so gating on it alone
      // silently saved card lends locally, although the form had promised
      // "Send for confirmation". The card rides on the request as the
      // requester account and is charged when they accept, like any account.
      if (appMode !== 'splits_only' && (type === 'loan_given' || type === 'loan_taken')) {
        const accountForBranch = type === 'loan_given' ? srcAccount : dstAccount;
        const branch = decideLinkedBranch({
          type,
          person: resolvedPerson,
          requestCurrency: accountForBranch?.currency,
          cashAdvance: cashAdvance && !!selectedCashAdvanceCard,
        });
        if (branch.branch === true) {
          // Deliberate confirm before mirroring a currency-locked record to them.
          const guard = await confirmCrossUserRequest({ amount: amt, currency: branch.currency, personName: resolvedPerson!.name });
          if (guard.blockedReason) { toast.show({ type: 'error', title: t('qe_err_check_amount'), subtitle: guard.blockedReason }); return; }
          if (!guard.ok) return;
          await useLinkedRequestStore.getState().createRequest({
            toUserId: branch.toUserId,
            personId: branch.personId,
            kind: branch.kind,
            amount: amt,
            currency: branch.currency,
            note: notes,
            // Full tracker: the account the user picked in this form rides
            // on the request, so their balance moves when the other side
            // accepts — no more silent drift between accounts and reality.
            // (Branch currency IS this account's currency, so the DB's
            // currency-match check can't fire.)
            requesterAccountId: accountForBranch?.id ?? null,
            requestId: nextRequestId(),
          });
          trackSaved('linked_request', branch.currency, amt, {
            loan: {
              direction: type === 'loan_given' ? 'given' : 'taken', linked: true, hasSchedule: false,
              person: { id: resolvedPerson!.id, name: resolvedPerson!.name, phone: resolvedPerson!.phone ?? null },
            },
          });
          toast.show({ type: 'success', title: t('ltr_sent_title'), subtitle: t('ltr_sent_subtitle') });
          reset();
          onClose();
          return;
        }
      }

      // Consolidated repayment (full tracker): one lump across a person's
      // loans, oldest first, executed as N ordinary single-loan repayments.
      // Each commits independently — a mid-batch failure keeps the committed
      // prefix and is reported honestly; a retry with the remainder
      // recomputes from the reduced remainings, so double-pay is impossible.
      if (type === 'repayment' && isGroupBatch && selectedRepayGroup) {
        const direction = selectedRepayGroup.direction;
        const batchAccountId = direction === 'given' ? destId : sourceId;
        const account = accounts.find((a) => a.id === batchAccountId);
        if (!account) throw new Error('Account not found');
        const rate = parseFloat(conversionRate) || undefined;
        // Sum the PER-ITEM rounded conversions — the store rounds each of the
        // N repayments separately, so rounding once on the total here would
        // drift from the real balance by cents and could let a razor-thin
        // 'taken' pre-flight pass only to fail mid-batch.
        const perItemMove = (a: number) => isCrossCurrency && rate
          ? (direction === 'given' ? Math.round(a * rate * 100) / 100 : Math.round(a / rate * 100) / 100)
          : a;
        const totalMove = Math.round(repayAllocations.reduce((a, x) => a + perItemMove(x.amount), 0) * 100) / 100;
        const accountMove = direction === 'given' ? totalMove : -totalMove;
        // The store rejects any single deduction that would overdraw the
        // account, so a 'taken' batch the balance can't fully cover is a
        // guaranteed mid-batch failure — refuse to start instead.
        if (direction === 'taken' && account.balance < -accountMove) {
          toast.show({ type: 'error', title: t('error'), subtitle: t('err_batch_balance_short') });
          return;
        }
        const result = await executeAllocatedRepayments(repayAllocations, {
          mode: 'tracker',
          direction,
          accountId: batchAccountId,
          conversionRate: isCrossCurrency ? rate : undefined,
          notes,
          processTransaction,
          applyRepayment,
        });
        if (result.failed && result.done === 0) {
          throw result.failed.error instanceof Error ? result.failed.error : new Error('Transaction failed');
        }
        if (result.failed) {
          // Same as the ledger batch above: refresh on a stale-write refusal.
          if (isLoanRemainingConflict(result.failed.error)) await loadLoans();
          toast.show({
            type: 'error',
            title: t('alloc_partial_title').replace('{done}', String(result.done)).replace('{total}', String(result.total)),
            subtitle: result.failed.error instanceof Error ? result.failed.error.message : t('toast_error_generic'),
            duration: 6000,
          });
          reset();
          onClose();
          return;
        }
        const clearedCount = previewAllocations(selectedRepayGroup.allocatable, repayAllocations).filter((l) => l.cleared).length;
        trackSaved('repayment', selectedRepayGroup.currency, result.totalApplied, {
          repayment: { consolidated: true, settles: clearedCount > 0 },
        });
        setConfirmData({
          title: `${t('tx_repayment')} — Done!`,
          description:
            t('qe_group_done_desc')
              .replace('{amount}', formatMoney(result.totalApplied, selectedRepayGroup.currency))
              .replace('{n}', String(result.total)) +
            (clearedCount > 0 ? ` · ${t('qe_group_cleared_count').replace('{n}', String(clearedCount))}` : ''),
          // `account` was captured before the batch ran, so before/after
          // reflect the pre-batch balance plus the aggregate move.
          changes: [{ accountName: account.name, currency: account.currency, before: account.balance, after: account.balance + accountMove }],
          settled: clearedCount > 0,
        });
        setShowConfirmation(true);
        reset();
        return;
      }

      // Ad-hoc split. One user action, several rows: the payer's own share as a
      // real expense (so only THAT counts as spending) plus a receivable per
      // person (so the account still moves by the full bill). No group is
      // created — these settle against each contact's running balance, which
      // ContactDetailSheet and the consolidated repayment flow already handle.
      if (canSplit && splitPlan) {
        // splits_only has no accounts at all, so `account` is legitimately
        // undefined there and the currency comes from the ledger picker. Every
        // account-derived value below stays optional for that reason.
        const account = accounts.find((a) => a.id === sourceId);
        const splitCurrency = account?.currency ?? ledgerCurrency;
        // The sheet works with placeholder keys for names typed fresh; resolve
        // every participant to a real Person row before writing anything.
        const resolveParticipant = async (personId: string, personName: string) => {
          const known = usePersonStore.getState().persons.find((p) => p.id === personId);
          if (known) return known;
          return usePersonStore.getState().findOrCreateByName(personName);
        };

        const others = await Promise.all(
          splitPlan.others.map(async (o) => {
            const person = await resolveParticipant(o.personId, o.personName);
            return { personId: person.id, personName: person.name, amount: o.amount };
          }),
        );
        const payer = splitPlan.payer
          ? await resolveParticipant(splitPlan.payer.personId, splitPlan.payer.personName).then((p) => ({ personId: p.id, personName: p.name }))
          : undefined;

        const label = notes.trim() || category || t('tx_expense');
        const result = await executeSplitEvent(
          {
            label,
            category,
            notes,
            mode: appMode === 'splits_only' ? 'splits_only' : 'tracker',
            direction: splitPlan.direction,
            currency: splitCurrency,
            myShare: splitPlan.myShare,
            others,
            payer,
            accountId: account ? sourceId : undefined,
          },
          {
            processTransaction: (splitInput) => processTransaction(splitInput as TransactionInput),
            createLoan: (loanInput) => createLoan(loanInput),
          },
        );

        if (result.failed && result.done === 0) {
          throw result.failed.error instanceof Error ? result.failed.error : new Error(t('toast_error_generic'));
        }
        if (result.failed) {
          // Committed prefix stays — money that already moved is not un-moved.
          // Say exactly how far it got so a retry only covers the remainder.
          toast.show({
            type: 'error',
            title: t('split_partial_title').replace('{done}', String(result.done)).replace('{total}', String(result.total)),
            subtitle: result.failed.error instanceof Error ? result.failed.error.message : t('toast_error_generic'),
            duration: 6000,
          });
          reset();
          onClose();
          return;
        }

        const owed = Math.round(others.reduce((sum, o) => sum + o.amount, 0) * 100) / 100;
        // Ad-hoc split (no group). Participant names/amounts stay local; only
        // the fact that a split happened, and its magnitude band, are reported.
        trackSaved('split', splitCurrency, splitPlan.myShare + owed);
        const accountMove = splitPlan.direction === 'i_paid' && appMode !== 'splits_only'
          ? Math.round((splitPlan.myShare + owed) * 100) / 100
          : 0;
        setConfirmData({
          title: t('split_saved_title'),
          description: splitPlan.direction === 'i_paid'
            // accountMove is 0 in splits_only — no account moved, so the
            // "{total} paid" sentence has nothing true to say. Report the
            // receivables, which ARE what this mode recorded.
            ? t(accountMove > 0 ? 'split_saved_i_paid' : 'split_saved_i_paid_ledger')
                .replace('{total}', formatMoney(accountMove || owed, splitCurrency))
                .replace('{n}', String(others.length))
                .replace('{owed}', formatMoney(owed, splitCurrency))
            : t('split_saved_they_paid')
                .replace('{name}', payer?.personName ?? t('loan_they'))
                .replace('{mine}', formatMoney(splitPlan.myShare, splitCurrency)),
          changes: accountMove > 0 && account
            ? [{ accountName: account.name, currency: splitCurrency, before: account.balance, after: account.balance - accountMove }]
            : [],
        });
        setShowConfirmation(true);
        reset();
        return;
      }

      // ── L4 step 3: the instalment plan, computed BEFORE the money call ────
      // A cash advance's instalments are statement-native: they anchor to the
      // funding card's statement day (dueDay), not a typed start date. Human
      // loans keep the typed start date. This is the same derivation the
      // post-commit block below has always run — kept as a factory, and called
      // TWICE by design, so the legacy path still reads its clock at exactly
      // the moment it always did rather than inheriting a value hoisted above
      // a network round-trip.
      const emiCard = cashAdvance ? selectedCashAdvanceCard : null;
      const emiCardDueDay = emiCard ? parseInt(emiCard.metadata?.dueDay ?? '', 10) : NaN;
      const emiStatementDatesNow = (): string[] | null => (
        emiCard && Number.isFinite(emiCardDueDay) && emiCardDueDay >= 1 && emiInstallments
          ? statementInstalmentDates(emiCardDueDay, parseInt(emiInstallments), localIso(new Date()))
          : null
      );

      // Planned unconditionally; the store honours it only on the atomic path
      // (VITE_ATOMIC_LOAN_CREATE) and only for a loan the entry creates. With
      // the flag off these rows are discarded and the post-commit
      // generateSchedule below is still the only writer.
      const plannedEmiDates = emiStatementDatesNow();
      const loanEmiPlan = hasEmi && emiInstallments && (plannedEmiDates || emiStartDate)
        ? planEmiRows({
            totalAmount: amt,
            installments: parseInt(emiInstallments),
            startDate: emiStartDate || localIso(new Date()),
            ...(plannedEmiDates ? { dueDates: plannedEmiDates } : {}),
          })
        : null;

      switch (type) {
        case 'income': { const d = accounts.find(a => a.id === destId)!; changes.push({ accountName: d.name, currency: d.currency, before: d.balance, after: d.balance + amt }); input = { type: 'income', amount: amt, destinationAccountId: destId, category, notes }; break; }
        case 'expense': { const s = accounts.find(a => a.id === sourceId)!; changes.push({ accountName: s.name, currency: s.currency, before: s.balance, after: s.balance - amt }); input = { type: 'expense', amount: amt, sourceAccountId: sourceId, category, notes }; break; }
        case 'transfer': {
          const s = accounts.find(a => a.id === sourceId)!;
          const d = accounts.find(a => a.id === destId)!;
          changes.push({ accountName: s.name, currency: s.currency, before: s.balance, after: s.balance - amt });
          const rate = parseFloat(conversionRate) || 1;
          const dAmt = s.currency !== d.currency ? Math.round(amt * rate * 100) / 100 : amt;
          changes.push({ accountName: d.name, currency: d.currency, before: d.balance, after: d.balance + dAmt });
          input = { type: 'transfer', amount: amt, sourceAccountId: sourceId, destinationAccountId: destId, conversionRate: s.currency !== d.currency ? rate : undefined, notes };
          break;
        }
        case 'loan_given': { const s = accounts.find(a => a.id === sourceId)!; changes.push({ accountName: s.name, currency: s.currency, before: s.balance, after: s.balance - amt }); input = { type: 'loan_given', amount: amt, sourceAccountId: sourceId, personName: resolvedPerson!.name, personId: resolvedPerson!.id, notes, emiPlan: loanEmiPlan }; break; }
        case 'loan_taken': {
          const d = accounts.find(a => a.id === destId)!;
          if (selectedCashAdvanceCard) {
            changes.push({ accountName: selectedCashAdvanceCard.name, currency: selectedCashAdvanceCard.currency, before: selectedCashAdvanceCard.balance, after: selectedCashAdvanceCard.balance - amt });
          }
          changes.push({ accountName: d.name, currency: d.currency, before: d.balance, after: d.balance + amt });
          // Cash advance: the card is the counterparty — record its name on
          // the loan but create no Person row (personId stays null).
          input = {
            type: 'loan_taken',
            amount: amt,
            destinationAccountId: destId,
            sourceAccountId: selectedCashAdvanceCard?.id,
            personName: cashAdvance && selectedCashAdvanceCard ? selectedCashAdvanceCard.name : resolvedPerson!.name,
            personId: cashAdvance ? null : resolvedPerson!.id,
            notes,
            emiPlan: loanEmiPlan,
          };
          break;
        }
        case 'repayment': {
          if (!effectiveSingleLoan) throw new Error('Loan not found');
          const rate = parseFloat(conversionRate) || undefined;
          if (effectiveSingleLoan.type === 'given' && destId) {
            const d = accounts.find(a => a.id === destId)!;
            const addAmt = isCrossCurrency && rate ? Math.round(amt * rate * 100) / 100 : amt;
            changes.push({ accountName: d.name, currency: d.currency, before: d.balance, after: d.balance + addAmt });
          } else if (effectiveSingleLoan.type === 'taken' && sourceId) {
            const s = accounts.find(a => a.id === sourceId)!;
            const deductAmt = isCrossCurrency && rate ? Math.round(amt / rate * 100) / 100 : amt;
            changes.push({ accountName: s.name, currency: s.currency, before: s.balance, after: s.balance - deductAmt });
          }
          input = { type: 'repayment', amount: amt, loanId: effectiveSingleLoan.id, sourceAccountId: effectiveSingleLoan.type === 'taken' ? sourceId : undefined, destinationAccountId: effectiveSingleLoan.type === 'given' ? destId : undefined, conversionRate: isCrossCurrency ? rate : undefined, notes };
          break;
        }
        case 'goal_contribution': {
          const s = accounts.find(a => a.id === sourceId)!;
          const gcRate = parseFloat(conversionRate) || undefined;
          const deductAmt = isCrossCurrency && gcRate ? Math.round(amt / gcRate * 100) / 100 : amt;
          changes.push({ accountName: s.name, currency: s.currency, before: s.balance, after: s.balance - deductAmt });
          input = { type: 'goal_contribution', amount: amt, sourceAccountId: sourceId, goalId, conversionRate: isCrossCurrency ? gcRate : undefined, notes };
          break;
        }
        default: throw new Error('Unknown type');
      }

      const resultTx = await processTransaction(input);

      // Remember the everyday accounts so the next spend/receive opens with
      // the selector already on the right one. Only from a generic entry —
      // an account-page launch pins its own account and says nothing about
      // the user's habitual choice.
      if (!preset?.accountId) {
        if (type === 'expense' && sourceId) localStorage.setItem('hisaab_qe_last_source', sourceId);
        if (type === 'income' && destId) localStorage.setItem('hisaab_qe_last_dest', destId);
      }

      // Payee memory, learning half: the user filed a KNOWN payee under a
      // different category than its history. Offer a one-tap retroactive
      // re-file of the past entries (category is pure metadata — no balance
      // legs move, and each row keeps its own Undo path via editing).
      if (type === 'expense' && category && payeeMatch && payeeMatch.category !== category) {
        const staleIds = mismatchedTxnIds(transactions, normalizePayee(notes), category)
          .filter((txnId) => txnId !== resultTx.id);
        if (staleIds.length > 0) {
          const payeeName = payeeMatch.payee;
          const chosenCategory = category;
          toast.show({
            type: 'info',
            title: t('qe_payee_refile_q').replace('{payee}', payeeName).replace('{category}', chosenCategory),
            action: {
              label: t('qe_payee_refile_action').replace('{n}', String(staleIds.length)),
              onPress: () => {
                void (async () => {
                  let done = 0;
                  for (const txnId of staleIds) {
                    try {
                      await useTransactionStore.getState().setCategory(txnId, chosenCategory);
                      done += 1;
                    } catch (err) {
                      console.error('payee re-file failed for one entry (non-fatal)', err);
                    }
                  }
                  toast.show({
                    type: 'success',
                    title: t('qe_payee_refiled').replace('{n}', String(done)),
                  });
                })();
              },
            },
          });
        }
      }

      // EMI scheduling is a follow-up write, not part of the transaction
      // itself. If it fails we must NOT show "Transaction Failed" — the money
      // has already moved and a retry would duplicate the transaction. Surface
      // a distinct "partial success" toast instead and still confirm the txn.
      let emiFailed = false;
      // See emiStatementDatesNow above — recomputed HERE, at the same moment it
      // always was, so the legacy path is unchanged.
      const emiStatementDates = emiStatementDatesNow();
      const emiReady = emiStatementDates ? true : !!emiStartDate;
      // The atomic path already inserted the schedule inside the loan's own
      // Postgres transaction; generating a second one here would double it.
      // Anything else — flag off, a plan the store declined to forward — still
      // generates it, exactly as it always has.
      if (hasEmi && resultTx.relatedLoanId && emiInstallments && emiReady
        && !loanScheduleAlreadyCreated(resultTx.relatedLoanId)) {
        try {
          await generateSchedule({
            loanId: resultTx.relatedLoanId,
            totalAmount: amt,
            installments: parseInt(emiInstallments),
            startDate: emiStartDate || localIso(new Date()),
            ...(emiStatementDates ? { dueDates: emiStatementDates } : {}),
          });
        } catch (err) {
          emiFailed = true;
          console.error('generateSchedule failed after successful transaction', err);
          toast.show({
            type: 'error',
            title: t('emi_schedule_failed_title'),
            subtitle: t('emi_schedule_failed_sub'),
            duration: 6000,
          });
        }
      }

      const typeLabel = cashAdvance ? t('intent_cash_advance') : (TX_TYPES.find(tx => tx.value === type)?.label ?? type);
      const confirmationCurrency = changes[0]?.currency ?? getPrimaryCurrency();
      const resultDescription = (() => {
        const first = changes[0];
        if (type === 'expense' && first) return t('qe_done_deducted').replace('{amount}', formatMoney(amt, first.currency)).replace('{account}', first.accountName);
        if (type === 'income' && first) return t('qe_done_added').replace('{amount}', formatMoney(amt, first.currency)).replace('{account}', first.accountName);
        if (type === 'transfer' && changes.length === 2) return t('qe_done_moved').replace('{amount}', formatMoney(amt, changes[0].currency)).replace('{src}', changes[0].accountName).replace('{dst}', changes[1].accountName);
        if (type === 'loan_given') return t('loan_done_owes_you').replace('{person}', resolvedPerson!.name).replace('{amount}', formatMoney(amt, confirmationCurrency));
        if (type === 'loan_taken' && cashAdvance && selectedCashAdvanceCard) {
          return t('qe_ca_done_desc')
            .replace('{amount}', formatMoney(amt, selectedCashAdvanceCard.currency))
            .replace('{card}', selectedCashAdvanceCard.name)
            .replace('{account}', accounts.find(a => a.id === destId)?.name ?? '');
        }
        if (type === 'loan_taken') return t('loan_done_you_owe').replace('{person}', resolvedPerson!.name).replace('{amount}', formatMoney(amt, confirmationCurrency));
        if (type === 'repayment' && effectiveSingleLoan) {
          return (effectiveSingleLoan.type === 'given' ? t('repay_done_received_desc') : t('repay_done_paid_desc'))
            .replace('{person}', effectiveSingleLoan.personName)
            .replace('{amount}', formatMoney(amt, effectiveSingleLoan.currency));
        }
        return `${formatMoney(amt, confirmationCurrency)} saved.`;
      })();
      // Deep-link the "View" button only where a detail page exists: loans
      // (incl. the loan a repayment belongs to) and goals. Plain
      // expense/income/transfer have no per-record route, so leave it unset
      // and the View button hides gracefully.
      const confirmRoute = (() => {
        if ((type === 'loan_given' || type === 'loan_taken') && resultTx.relatedLoanId) return `/loan/${resultTx.relatedLoanId}`;
        if (type === 'repayment' && effectiveSingleLoan) return `/loan/${effectiveSingleLoan.id}`;
        if (type === 'goal_contribution') return '/goals';
        return undefined;
      })();
      // The ordinary full-tracker save path (catalog #9, plus #11/#12 where the
      // entry is also a loan or a repayment).
      trackSaved(
        cashAdvance ? 'cash_advance' : (type as 'expense' | 'income' | 'transfer' | 'loan_given' | 'loan_taken' | 'repayment' | 'goal_contribution'),
        confirmationCurrency,
        amt,
        (type === 'loan_given' || type === 'loan_taken')
          ? {
              loan: {
                direction: type === 'loan_given' ? 'given' : 'taken', linked: false,
                hasSchedule: hasEmi && !emiFailed && !!resultTx.relatedLoanId,
                // Cash advance has no human counterparty (the card is the
                // lender) — resolvedPerson is null there; skip the nudge.
                person: resolvedPerson ? { id: resolvedPerson.id, name: resolvedPerson.name, phone: resolvedPerson.phone ?? null } : undefined,
              },
            }
          : type === 'repayment'
            ? { repayment: { consolidated: false, settles: amt >= repayCap - 0.00001 } }
            : undefined,
      );
      setConfirmData({
        title: (emiFailed ? t('title_saved_emi_pending') : t('title_done')).replace('{label}', typeLabel),
        description: resultDescription,
        changes,
        route: confirmRoute,
        settled: type === 'repayment' && amt >= repayCap - 0.00001,
      });
      setShowConfirmation(true);
      reset();
    } catch (err) {
      // Audit C10: a repayment can be refused because the loan moved (or was
      // deleted) on another device. The message says so; re-pull the loans so
      // the picker's remaining figures — and the overpayment cap built from
      // them — reflect the truth the user must re-enter against.
      if (isLoanRemainingConflict(err)) void loadLoans();
      toast.show({ type: 'error', title: t('qe_err_txn_failed_title'), subtitle: err instanceof Error ? err.message : t('toast_error_generic') });
    } finally { setSaving(false); }
  };

  // The 1d sunken field (index.css .input-field): inset face, 3:1 edge, violet focus.
  const inputClass = "input-field";

  // Heads-up "After: …" preview for source rows (money leaving an account).
  // Glanceable only — never blocks submit. Tints pay-text + shows a small
  // "Low balance" caption when the move would push a non-credit account
  // negative. Credit cards legitimately carry a negative available balance,
  // so we don't flag them.
  const renderAfterBalance = (acct: { balance: number; currency: string; type: string }) => {
    const amt = parseFloat(amount);
    if (!amt) return null;
    const after = acct.balance - amt;
    const goesNegative = after < 0 && acct.type !== 'credit_card';
    return (
      <p className={`text-[10px] mt-0.5 tabular-nums ${goesNegative ? 'text-pay-text' : 'text-ink-500'}`}>
        {t('qe_after').replace('{amount}', formatSignedMoney(after, acct.currency))}
        {goesNegative && <span className="ml-1.5 font-semibold">{t('qe_low_balance')}</span>}
      </p>
    );
  };

  // Type-first flow: the amount screen knows what's being recorded, so its
  // title asks the specific question instead of a context-free "How much?".
  const amountTitle = (() => {
    if (cashAdvance) return t('qe_amt_cash_advance');
    // A split asks for the WHOLE bill, not "how much did you spend" — the
    // user's own share is what the sheet works out from it.
    if (intent === 'split') return t('qe_amt_split');
    switch (type) {
      case 'expense': return t('qe_amt_expense');
      case 'income': return t('qe_amt_income');
      case 'transfer': return t('qe_amt_transfer');
      case 'loan_given': return t('qe_amt_loan_given');
      case 'loan_taken': return t('qe_amt_loan_taken');
      case 'repayment': return repaymentDirection === 'paid' ? t('qe_amt_repay_paid') : t('qe_amt_repay_received');
      case 'goal_contribution': return t('qe_amt_goal');
      case 'group_expense': return t('qe_amt_group');
      default: return t('quick_how_much');
    }
  })();
  // The amount step offers a back arrow only when a previous screen exists —
  // presets that fix the type land directly on the amount.
  const canGoBackFromAmount = !preset?.type && !preset?.cashAdvanceCardId;

  // Audit MF-02: computed once so it can be wrapped with the keyboard-inset
  // padding below without duplicating the step-0/step-2/undefined ternary.
  const footerContent = step === 0 ? (
          <div className="flex gap-2.5">
          {canGoBackFromAmount && (
            <button
              onClick={() => setStep(intent === 'person_money' ? 3 : 1)}
              className="m-btn m-btn-plain px-4"
              aria-label={t('back')}
            >
              <Glyph name="arrow-left" size={17} />
            </button>
          )}
          <button
            onClick={() => {
              if (parseFloat(amount) <= 0) return;
              // Type-first flow: the type is already chosen before the
              // amount, so Next always lands on the details step.
              setStep(2);
            }}
            disabled={!parseFloat(amount)}
            className="m-btn m-btn-primary flex-1 py-4 text-[14px]"
          >{t('quick_next')}<Glyph name="arrow-right" size={16} strokeWidth={2.8} /></button>
          </div>
        ) : step === 2 ? (
          isGroupExpense ? (
            // Group expense exits via the picker tap, not a Save button.
            // Just give the user a way back to change the amount.
            <button
              onClick={() => setStep(0)}
              className="w-full text-center text-[12px] text-ink-500 py-2 font-medium"
            >
              &#x2190; {t('quick_change_amount')}
            </button>
          ) : (
            <div className="flex gap-2.5">
              <button onClick={() => setStep(0)} className="m-btn m-btn-plain px-4" aria-label={t('back')}>
                <Glyph name="arrow-left" size={17} />
              </button>
              <button onClick={preSubmit} disabled={saving || !canSubmit()}
                className="m-btn m-btn-primary flex-1 py-3.5 text-[14px]"
              >{saving ? t('quick_processing') : wouldBranchToLinked ? t('ltr_branch_cta') : `${t('quick_save')} \u2713`}</button>
            </div>
          )
        ) : undefined;

  return (
    <>
      <Modal open={open && !showInlineAccount} onClose={handleClose}
        confirmClose={() => guardClose(!!amount.trim() || step === 2)}
        title={step === 0 ? amountTitle : step === 2 ? t('quick_details') : t('qe_title_what_happened')}
        footer={footerContent && keyboardInset > 0 ? (
          <div style={{ paddingBottom: keyboardInset }}>{footerContent}</div>
        ) : footerContent}
      >

        {/* Step 0: Amount — the 1d entry: an extruded 56px figure over a
            pressable keypad (walls collapse under the finger). */}
        {step === 0 && (
          <div className="space-y-5">
            <div className="text-center pt-3 pb-2">
              <p className="m-label">{activeCurrency}</p>
              {/* readOnly + inputMode="none": the in-app numpad below is the
                  single input surface on touch — previously tapping the field
                  ALSO opened the phone's native keyboard, showing two keypads
                  at once. Physical keyboards still work via onKeyDown. */}
              <input
                ref={amountRef}
                type="text"
                inputMode="none"
                readOnly
                value={amount}
                onKeyDown={(e) => {
                  if (e.key >= '0' && e.key <= '9') { numpadPress(e.key); e.preventDefault(); }
                  else if (e.key === '.') { numpadPress('.'); e.preventDefault(); }
                  else if (e.key === 'Backspace' || e.key === 'Delete') { numpadPress('del'); e.preventDefault(); }
                }}
                placeholder="0"
                className="m-num m-num-violet text-center w-full h-[64px] border-none outline-none bg-transparent caret-transparent placeholder:text-ink-300 mt-2"
                // Inline on purpose: index.css pins every <input> to 16px
                // (unlayered, to stop iOS focus-zoom), which beats any
                // font-size utility — the 56px entry figure has to win here.
                style={{ fontSize: 56, lineHeight: 1, letterSpacing: '-0.045em' }}
              />
              <p className="text-[12px] text-ink-600 mt-3">{t('quick_enter_amount')}</p>
            </div>

            {/* Quick amounts */}
            <div className="flex gap-2 justify-center flex-wrap">
              {quickAmounts.map(v => (
                <button key={v} onClick={() => setAmount(String(v))}
                  className="m-pill min-h-[44px] px-4 text-[12px] tabular-nums"
                >{v.toLocaleString()}</button>
              ))}
            </div>

            {/* Numpad — 1d pressable keys, two-step wall, 52px rows */}
            <div className="grid grid-cols-3 gap-[9px] pb-1" aria-label={t('qe_numpad_label')} role="group">
              {['1','2','3','4','5','6','7','8','9','.','0','del'].map(key => (
                <button key={key} onClick={() => numpadPress(key)}
                  aria-label={key === 'del' ? t('qe_numpad_delete') : undefined}
                  className={`m-key h-[52px] text-[20px] font-medium tabular-nums flex items-center justify-center ${
                    key === 'del' ? 'm-coral' : ''
                  }`}
                >{key === 'del' ? <Delete size={19} strokeWidth={2.4} /> : key}</button>
              ))}
            </div>

            {/* Plain-words entry lives in Hisaab AI — surface it here so the
                headline "type it in words" claim is discoverable from the FAB,
                not hidden behind a separate tab. */}
            <button
              onClick={() => { handleClose(); navigate('/hisaab-ai'); }}
              className="w-full flex items-center justify-center gap-1.5 text-[12px] text-ink-500 pt-1 min-h-[40px] press"
            >
              <Glyph name="sparkle" size={13} tone="violet" />
              {t('quick_type_instead')}
            </button>

          </div>
        )}

        {/* Step 1: What happened? — type-first, so every later screen has
            context. The amount comes next. */}
        {step === 1 && (
          <div className="space-y-5 animate-fade-in">
            <p className="text-[12px] text-ink-500 leading-relaxed">{t('quick_where_money')}</p>
            {/* One tile per intent, one column; the glyph sits in each tile's
                corner, so a 10px gap clears the walls. */}
            <div className="grid grid-cols-1 gap-2.5">
              {INTENTS.map(tx => {
                const isActive = intent === tx.value;
                return (
                  <Tile3D key={tx.value}
                    tint={tx.tint}
                    icon={tx.clayIcon}
                    title={tx.label}
                    subtitle={tx.sub}
                    selected={isActive}
                    onClick={() => {
                    setIntent(tx.value);
                    // Clear account picks left over from a previously chosen
                    // type — a stale credit-card sourceId would otherwise turn
                    // a person-borrow into a silent cash advance. Preset
                    // accounts re-apply via the hydration effect. Category
                    // clears too: a payee-autofilled expense category must
                    // not silently ride onto an Income entry (whose picker
                    // wouldn't even show it as selected).
                    setSourceId('');
                    setDestId('');
                    setCategory('');
                    if (tx.value === 'person_money') {
                      setCashAdvance(false);
                      setStep(3);
                    } else if (tx.value === 'split') {
                      // Still an ordinary expense underneath — the fan-out
                      // happens at submit. Only the intent differs, and it is
                      // what opens the split sheet on the details step.
                      setType('expense');
                      setRepaymentDirection(null);
                      setCashAdvance(false);
                      // Re-arm the one-shot auto-open: coming BACK to this tile
                      // is a fresh "I want to split", even if a previous pass
                      // dismissed the sheet.
                      splitSheetAutoOpened.current = false;
                      setStep(0);
                    } else if (tx.value === 'cash_advance') {
                      // Cash advance is a loan_taken funded by the user's own
                      // credit card — no contact will be asked for.
                      setType('loan_taken');
                      setRepaymentDirection(null);
                      setCashAdvance(true);
                      setStep(0);
                    } else {
                      setType(tx.value);
                      setCashAdvance(false);
                      setStep(0);
                    }
                  }}
                  />
                );
              })}
            </div>
          </div>
        )}

        {step === 3 && (
          <div className="space-y-3 animate-fade-in">
            <p className="text-[12px] text-ink-500 leading-relaxed">{t('intent_person_prompt')}</p>
            {/* Tint carries the direction the app uses everywhere else: mint =
                it lands in your favour, coral = you end up owing. The glyph
                separates a NEW loan (a banknote changing hands) from a
                repayment that CLOSES something (a check). */}
            <div className="grid grid-cols-1 gap-2.5">
            {[
              { value: 'loan_given' as const, label: t('person_gave'), sub: t('person_gave_sub'), tint: 'mint' as ClayTint, clayIcon: 'money' },
              { value: 'loan_taken' as const, label: t('person_borrowed'), sub: t('person_borrowed_sub'), tint: 'coral' as ClayTint, clayIcon: 'money' },
              { value: 'repayment_received' as const, label: t('person_paid_me_back'), sub: t('person_paid_me_back_sub'), tint: 'mint' as ClayTint, clayIcon: 'tick' },
              { value: 'repayment_paid' as const, label: t('person_i_paid_back'), sub: t('person_i_paid_back_sub'), tint: 'coral' as ClayTint, clayIcon: 'tick' },
            ].map((choice) => (
              <Tile3D
                key={choice.value}
                tint={choice.tint}
                icon={choice.clayIcon}
                title={choice.label}
                subtitle={choice.sub}
                onClick={() => {
                  if (choice.value === 'repayment_received' || choice.value === 'repayment_paid') {
                    setType('repayment');
                    setRepaymentDirection(choice.value === 'repayment_received' ? 'received' : 'paid');
                  } else {
                    setType(choice.value);
                    setRepaymentDirection(null);
                  }
                  setCashAdvance(false);
                  // Stale account picks from an earlier type choice must not
                  // leak into this flow; presets re-apply via the effect.
                  setSourceId('');
                  setDestId('');
                  setStep(0);
                }}
              />
            ))}
            </div>
            {/* When the sheet was launched straight into the person picker
                (contact page preset) there is no earlier screen to go back to. */}
            {preset?.intent !== 'person_money' && (
              <button onClick={() => setStep(1)} className="w-full text-center text-[12px] text-ink-500 py-2 font-medium">
                &#x2190; {t('back')}
              </button>
            )}
          </div>
        )}

        {/* Step 2: Details */}
        {step === 2 && (
          <div className="space-y-4 animate-fade-in">
            {/* Summary. Cash advance wears its warn identity here too — the
                same amber as its intent tile, so the mode is unmistakable. */}
            {/* 3D clay, tier 2 (informational — it is not tappable, so it is a
                card, never a tile). Gold keeps cash advance's amber identity. */}
            <Card3D tint={cashAdvance ? 'gold' : 'neutral'} padding="sm" className="flex items-center justify-between !py-3">
              <div className="flex items-center gap-2.5">
                {(() => {
                  // Keyed off the PLAN, not the intent: a user who opened the
                  // split sheet and cancelled is saving a plain expense, and
                  // the summary must say so rather than keep promising a split.
                  const Icon = cashAdvance ? CreditCard : splitPlan ? Users : TX_TYPES.find(tx => tx.value === type)?.icon;
                  if (!Icon) return null;
                  return (
                    <div className={`m-ctl w-8 h-8 rounded-[10px] flex items-center justify-center ${cashAdvance ? 'text-warn-700' : 'text-ink-700'}`}>
                      <Icon size={14} strokeWidth={2.4} />
                    </div>
                  );
                })()}
                <span className={`text-[13px] font-semibold tracking-tight ${cashAdvance ? 'text-warn-700' : 'text-ink-900'}`}>
                  {cashAdvance ? t('intent_cash_advance') : splitPlan ? t('intent_split') : TX_TYPES.find(tx => tx.value === type)?.label}
                </span>
              </div>
              <span className={`font-semibold text-[15px] tabular-nums ${cashAdvance ? 'text-warn-700' : 'text-ink-900'}`}>{parseFloat(amount).toLocaleString()}</span>
            </Card3D>

            {/* Group expense branch — pick an existing group OR create a
                new one. Either path closes QuickEntry; App.tsx then opens
                AddGroupExpenseModal (with the typed amount prefilled) or
                CreateGroupModal → AddGroupExpenseModal chained. */}
            {isGroupExpense && (
              <div className="space-y-3 animate-fade-in">
                <label className="block text-[10.5px] font-semibold text-ink-500 uppercase tracking-[0.12em]">
                  {t('qe_which_group')}
                </label>
                {groupsLoading && groups.length === 0 ? (
                  // Skeleton — visible only when groups truly haven't
                  // loaded yet. Avoids the "no groups" flash for users
                  // who DO have groups but opened QuickEntry before the
                  // boot-time preload finished.
                  <div className="rounded-2xl bg-cream-card border border-cream-border overflow-hidden divide-y divide-cream-hairline">
                    {[0, 1, 2].map((i) => (
                      <div key={i} className="flex items-center gap-3 px-4 py-3 animate-pulse">
                        <div className="m-skel w-9 h-9 rounded-xl shrink-0" />
                        <div className="flex-1 space-y-1.5">
                          <div className="m-skel h-3 w-28 rounded-full" />
                          <div className="m-skel h-2.5 w-20 rounded-full" />
                        </div>
                      </div>
                    ))}
                  </div>
                ) : groups.length === 0 ? (
                  <div className="rounded-2xl bg-cream-card border border-cream-border p-4 text-center space-y-2">
                    <p className="text-[12.5px] text-ink-700 font-medium">
                      {t('qe_no_groups_title')}
                    </p>
                    <p className="text-[11px] text-ink-500 leading-relaxed">
                      {t('qe_no_groups_body')}
                    </p>
                  </div>
                ) : (
                  <div className="rounded-2xl bg-cream-card border border-cream-border overflow-hidden divide-y divide-cream-hairline">
                    {groups.map((g) => {
                      const connected = g.members.filter((m) => m.status === 'connected').length;
                      return (
                        <button
                          key={g.id}
                          type="button"
                          onClick={() => handlePickGroup(g)}
                          className="w-full flex items-center gap-3 px-4 py-3 text-left active:bg-cream-soft transition-colors"
                        >
                          <div className="m-ctl w-9 h-9 flex items-center justify-center text-base shrink-0">
                            {g.emoji}
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="text-[13px] font-medium text-ink-900 truncate tracking-tight">
                              {g.name}
                            </p>
                            <p className="text-[10.5px] text-ink-500 mt-0.5">
                              {t('qe_group_member_count')
                                .replace('{connected}', String(connected))
                                .replace('{total}', String(g.members.length))
                                .replace('{currency}', g.currency)}
                            </p>
                          </div>
                          <ChevronRight size={14} className="text-ink-300 shrink-0" />
                        </button>
                      );
                    })}
                  </div>
                )}
                <button
                  type="button"
                  onClick={handleCreateNewGroup}
                  className="w-full rounded-2xl border-2 border-dashed border-cream-border bg-transparent text-ink-700 py-3 text-[12.5px] font-semibold active:bg-cream-soft transition-colors flex items-center justify-center gap-2"
                >
                  <Plus size={13} strokeWidth={2.4} /> {t('qe_create_new_group')}
                </button>
                <p className="text-[11px] text-ink-500 leading-relaxed bg-cream-card border border-cream-border rounded-2xl p-3">
                  {t('qe_group_pick_hint')}
                </p>
              </div>
            )}

            {/* Account selectors */}
            {(needsSource || needsDest) && !hasAccounts && (
              <div className="m-card m-violet p-4">
                <p className="text-[12px] text-ink-700 leading-relaxed">{t('acct_need_for_tx')}</p>
                <button
                  type="button"
                  onClick={() => setShowInlineAccount(true)}
                  className="m-btn m-btn-primary mt-3 w-full py-2.5 text-[12px]"
                >
                  {t('quick_create_first')}
                </button>
              </div>
            )}
            {/* Cash advance: pick the funding card first (locked when launched
                from the card's own page), then where the cash landed. */}
            {cashAdvance && !isLedgerOnlyPersonFlow && (
              <div>
                <label className="block text-[10.5px] font-semibold text-ink-500 uppercase tracking-[0.12em] mb-2">{t('qe_ca_which_card')}</label>
                {preset?.cashAdvanceCardId && (() => {
                  const lockedCard = accounts.find(a => a.id === preset.cashAdvanceCardId);
                  if (!lockedCard) return null;
                  return (
                    <p className="text-[10.5px] text-accent-600 font-semibold mb-2 flex items-center gap-1.5">
                      <Lock size={11} /> {t('qe_ca_locked').replace('{name}', lockedCard.name)}
                    </p>
                  );
                })()}
                <AccountSelect
                  accounts={preset?.cashAdvanceCardId
                    ? accounts.filter(a => a.id === preset.cashAdvanceCardId)
                    : accounts.filter(a => a.type === 'credit_card' && (!dstAccount || a.currency === dstAccount.currency))}
                  selectedId={sourceId}
                  onSelect={setSourceId}
                  locked={!!preset?.cashAdvanceCardId}
                  renderRight={(a) => (
                    <>
                      <p className="text-[13px] font-semibold text-ink-900 tabular-nums">{formatSignedMoney(a.balance, a.currency)}</p>
                      {renderAfterBalance(a)}
                    </>
                  )}
                />
                <p className="text-[11px] text-ink-500 leading-relaxed bg-cream-card border border-cream-border rounded-2xl p-3 mt-2">
                  {t('qe_ca_helper')}
                </p>
              </div>
            )}

            {needsSource && (
              <div>
                <label className="block text-[10.5px] font-semibold text-ink-500 uppercase tracking-[0.12em] mb-2">{t('quick_from')}</label>
                {sourceLockId && (() => {
                  const lockedAcct = accounts.find(a => a.id === sourceLockId);
                  if (!lockedAcct) return null;
                  return (
                    <p className="text-[10.5px] text-accent-600 font-semibold mb-2 flex items-center gap-1.5">
                      <Lock size={11} /> {t('locked_to_account').replace('{name}', lockedAcct.name)}
                    </p>
                  );
                })()}
                <AccountSelect
                  accounts={sourceChoices}
                  selectedId={sourceId}
                  onSelect={(id) => {
                    setSourceId(id);
                    // A different account can mean a different currency — a
                    // previously typed conversion no longer applies.
                    setConversionRate('');
                  }}
                  locked={!!sourceLockId}
                  renderRight={(a) => (
                    <>
                      <p className="text-[13px] font-semibold text-ink-900 tabular-nums">{formatSignedMoney(a.balance, a.currency)}</p>
                      {renderAfterBalance(a)}
                    </>
                  )}
                />
              </div>
            )}

            {/* Split-this chip. Deliberately a modifier on the Spend flow
                rather than its own entry tile — making "split" a separate type
                is exactly what forces people into groups they don't want. */}
            {canSplit && (sourceId || isLedgerOnlySplitFlow) && (
              <div>
                <label className="block text-[10.5px] font-semibold text-ink-500 uppercase tracking-[0.12em] mb-2">
                  {t('split_chip_label')}
                </label>
                <button
                  type="button"
                  onClick={() => setShowSplitSheet(true)}
                  className={`w-full p-3.5 rounded-2xl border-2 flex items-center justify-between text-left transition-all active:scale-[0.98] ${
                    splitPlan ? 'border-accent-500 bg-accent-50' : 'border-cream-border bg-cream-card'
                  }`}
                >
                  <span className="flex items-center gap-2.5 min-w-0">
                    <Users size={15} className={splitPlan ? 'text-accent-600 shrink-0' : 'text-ink-500 shrink-0'} />
                    <span className="min-w-0">
                      <span className={`block text-[13px] font-semibold ${splitPlan ? 'text-accent-600' : 'text-ink-700'}`}>
                        {splitPlan
                          ? t('split_chip_active').replace('{n}', String(splitPlan.partyCount))
                          : t('split_chip_none')}
                      </span>
                      {splitPlan && (
                        <span className="block text-[10.5px] text-ink-500 truncate mt-0.5">
                          {splitPlan.direction === 'i_paid'
                            ? t(isLedgerOnlySplitFlow ? 'split_summary_i_paid_ledger' : 'split_summary_i_paid')
                                .replace('{total}', formatMoney(parseFloat(amount) || 0, srcAccount?.currency ?? ledgerCurrency))
                                .replace('{mine}', formatMoney(splitPlan.myShare, srcAccount?.currency ?? ledgerCurrency))
                                .replace('{owed}', formatMoney(
                                  Math.round(splitPlan.others.reduce((sum, o) => sum + o.amount, 0) * 100) / 100,
                                  srcAccount?.currency ?? ledgerCurrency,
                                ))
                            : t('split_summary_they_paid')
                                .replace('{name}', splitPlan.payer?.personName ?? t('loan_they'))
                                .replace('{mine}', formatMoney(splitPlan.myShare, srcAccount?.currency ?? ledgerCurrency))}
                        </span>
                      )}
                    </span>
                  </span>
                  <ChevronRight size={15} className="text-ink-400 shrink-0" />
                </button>
              </div>
            )}

            {needsDest && (
              <div>
                <label className="block text-[10.5px] font-semibold text-ink-500 uppercase tracking-[0.12em] mb-2">
                  {cashAdvance ? t('qe_ca_dest_label') : t('quick_to')}
                </label>
                {destLockId && (() => {
                  const lockedAcct = accounts.find(a => a.id === destLockId);
                  if (!lockedAcct) return null;
                  return (
                    <p className="text-[10.5px] text-accent-600 font-semibold mb-2 flex items-center gap-1.5">
                      <Lock size={11} /> {t('locked_to_account').replace('{name}', lockedAcct.name)}
                    </p>
                  );
                })()}
                <AccountSelect
                  accounts={destChoices}
                  selectedId={destId}
                  onSelect={(id) => {
                    setDestId(id);
                    setConversionRate('');
                  }}
                  locked={!!destLockId}
                />
              </div>
            )}

            {/* Cross-currency: ask for the amount that landed/left on the
                other side and derive the rate — no rate-direction guessing. */}
            {isCrossCurrency && conversionProps && (
              <CurrencyConversionCard
                knownAmount={parseFloat(amount) || 0}
                knownCurrency={conversionProps.knownCurrency}
                otherCurrency={conversionProps.otherCurrency}
                otherSide={conversionProps.otherSide}
                rateSemantics={conversionProps.rateSemantics}
                rate={conversionRate}
                onRateChange={setConversionRate}
              />
            )}

            {needsPerson && !cashAdvance && (
              <div>
                <label className="block text-[10.5px] font-semibold text-ink-500 uppercase tracking-[0.12em] mb-2">{t('quick_who')}</label>
                {preset?.lockContact && preset.contact ? (
                  <div className="rounded-2xl border border-accent-100 bg-accent-50 px-4 py-3 flex items-center gap-2.5">
                    <div className="w-8 h-8 rounded-xl bg-accent-100 flex items-center justify-center shrink-0">
                      <Lock size={13} className="text-accent-600" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-[13px] font-semibold text-ink-900 truncate">{preset.contact.name}</p>
                      <p className="text-[10px] text-ink-500">
                        {t('locked_to_contact').replace('{name}', preset.contact.name)}
                      </p>
                    </div>
                  </div>
                ) : (
                  <ContactPicker value={contact} onChange={setContact} placeholder={t('quick_who_placeholder')} className={inputClass} />
                )}
                {wouldBranchToLinked ? (
                  <p className="text-[11px] text-accent-600 mt-1.5">{t('ltr_branch_helper')}</p>
                ) : (
                  <p className="text-[11px] text-ink-500 mt-1.5">{t('ltr_linked_only_helper')}</p>
                )}
              </div>
            )}

            {/* The ledger-only split needs the same currency pick as the
                ledger-only person flows: with no account there is nothing else
                to stamp the loans it writes with. */}
            {((isLedgerOnlyPersonFlow && type !== 'repayment') || isLedgerOnlySplitFlow) && (
              <div>
                <label className="block text-[10.5px] font-semibold text-ink-500 uppercase tracking-[0.12em] mb-2">{t('onboard_currency_label')}</label>
                <CurrencyPicker
                  value={ledgerCurrency}
                  onChange={setLedgerCurrency}
                  primary={primaryCurrency}
                  used={usedCurrencies}
                />
              </div>
            )}

            {/* The old opt-in "Cash Advance Source" picker that hid inside the
                person-borrow flow is gone — cash advances now have their own
                explicit entry (intent tile + card-page action) with the card
                picker rendered above. Borrowing from a person is person-only. */}

            {/* EMI Setup for Loans (incl. cash advances — card installment
                plans are the most common EMI case) */}
            {needsPerson && (
              <div className="space-y-3">
                <label className="flex items-center gap-2.5 cursor-pointer p-3 rounded-2xl bg-cream-card border border-cream-border">
                  <input type="checkbox" checked={hasEmi} onChange={e => setHasEmi(e.target.checked)} className="w-4 h-4 rounded border-field-border text-accent-600 accent-accent-600" />
                  <span className="text-[13px] text-ink-800 font-medium">{t('loan_set_emi')}</span>
                </label>
                {hasEmi && (() => {
                  // Cash advances anchor to the card's statement day — no
                  // start-date field; instalments land on the statement, as
                  // they do on a real card statement.
                  const caCard = cashAdvance ? selectedCashAdvanceCard : null;
                  const caDueDay = caCard ? parseInt(caCard.metadata?.dueDay ?? '', 10) : NaN;
                  const statementAnchored = !!caCard && Number.isFinite(caDueDay) && caDueDay >= 1;
                  const ordSuffix = (() => {
                    const s = ['th', 'st', 'nd', 'rd']; const v = caDueDay % 100;
                    return s[(v - 20) % 10] ?? s[v] ?? s[0];
                  })();
                  return (
                    <div className={`grid gap-3 animate-fade-in ${statementAnchored ? 'grid-cols-1' : 'grid-cols-2'}`}>
                      <div>
                        <label className="block text-[10.5px] font-semibold text-ink-500 uppercase tracking-[0.12em] mb-2">{t('loan_installments')}</label>
                        <input type="number" value={emiInstallments} onChange={e => setEmiInstallments(e.target.value)} placeholder="12" className={inputClass} />
                      </div>
                      {statementAnchored ? (
                        <p className="text-[11px] text-ink-500 leading-relaxed self-end pb-1">
                          {t('emi_statement_anchored').replace('{day}', `${caDueDay}${ordSuffix}`)}
                        </p>
                      ) : (
                        <div>
                          <label className="block text-[10.5px] font-semibold text-ink-500 uppercase tracking-[0.12em] mb-2">{t('kameti_start_date')}</label>
                          <input type="date" value={emiStartDate} onChange={e => setEmiStartDate(e.target.value)} className={inputClass} />
                        </div>
                      )}
                    </div>
                  );
                })()}
              </div>
            )}

            {needsLoan && (
              <div>
                <label className="block text-[10.5px] font-semibold text-ink-500 uppercase tracking-[0.12em] mb-2">{t('quick_which_loan')}</label>
                {repayableLoanCount === 0 ? (
                  <p className="text-[12px] text-ink-500 bg-cream-soft border border-cream-hairline rounded-xl p-3 leading-relaxed">
                    {t('loan_no_tx')}
                  </p>
                ) : (
                  <div className="space-y-3">
                    {/* Only when the target still resolves — a search query can
                        hide the selected group, and an empty error box helps
                        no one (canSubmit already blocks that state). */}
                    {(selectedRepayGroup || selectedLoan) && parseFloat(amount) > repayCap + 0.00001 && (
                      <p className="text-[11px] text-pay-text font-semibold leading-relaxed bg-pay-50 border border-pay-100 rounded-xl px-3 py-2">
                        {selectedRepayGroup
                          ? t('err_overpayment_group')
                              .replace('{person}', selectedRepayGroup.name)
                              .replace('{remaining}', formatMoney(selectedRepayGroup.allocatableRemaining, selectedRepayGroup.currency))
                          : t('err_overpayment').replace('{remaining}', formatMoney(selectedLoan!.remainingAmount, selectedLoan!.currency))}
                      </p>
                    )}
                    {/* Search — appears once the list is long enough that finding
                        the right loan by scanning is the friction users hit. */}
                    {showLoanSearch && (
                      <div className="relative">
                        <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-400 pointer-events-none" />
                        <input
                          value={loanSearch}
                          onChange={(e) => setLoanSearch(e.target.value)}
                          placeholder={t('quick_loan_search_placeholder')}
                          className="input-field pl-9 pr-9 py-2.5"
                        />
                        {loanSearch && (
                          <button
                            type="button"
                            onClick={() => setLoanSearch('')}
                            aria-label={t('a11y_clear_search')}
                            className="absolute right-2.5 top-1/2 -translate-y-1/2 text-ink-400 active:text-ink-600"
                          >
                            <X size={15} />
                          </button>
                        )}
                      </div>
                    )}
                    {repaymentLoanGroups.length === 0 ? (
                      <p className="text-[12px] text-ink-500 bg-cream-soft border border-cream-hairline rounded-xl p-3 leading-relaxed">
                        {t('search_no_matches').replace('{q}', loanSearch.trim())}
                      </p>
                    ) : (
                      // One card per person (+ currency): the person is the
                      // primary payment target — one lump settles across all
                      // their loans, oldest first. Single-loan people keep the
                      // plain per-loan row; "choose a specific loan" expands
                      // the individual lines for line-level control.
                      repaymentLoanGroups.map((group) => {
                        const isSelectedGroup = repayTarget?.kind === 'group' && repayTarget.key === group.key;
                        const multi = group.allocatable.length > 1;
                        const expanded = expandedGroupKey === group.key || group.allocatable.length === 0;
                        const loanRow = (l: Loan) => (
                          <button key={l.id} type="button"
                            onClick={() => {
                              // A different loan can carry a different
                              // currency — drop any typed conversion.
                              if (!(repayTarget?.kind === 'loan' && repayTarget.id === l.id)) setConversionRate('');
                              setRepayTarget({ kind: 'loan', id: l.id });
                            }}
                            className={`w-full p-3.5 rounded-2xl border-2 flex items-center justify-between text-left transition-all active:scale-[0.98] ${
                              repayTarget?.kind === 'loan' && repayTarget.id === l.id ? 'border-accent-500 bg-accent-50' : 'border-cream-border bg-cream-card'
                            }`}
                          >
                            <div className="min-w-0">
                              <p className="text-[12.5px] font-medium text-ink-800 truncate">
                                {l.notes?.trim() ? l.notes : (l.type === 'given' ? t('loan_receivable') : t('loan_payable'))}
                              </p>
                              <p className="text-[10px] text-ink-500 mt-0.5">
                                {new Date(l.createdAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}
                              </p>
                            </div>
                            <p className="text-[13px] font-semibold text-ink-900 tabular-nums shrink-0 ml-2">{formatMoney(l.remainingAmount, l.currency)}</p>
                          </button>
                        );
                        if (!multi) {
                          return (
                            <div key={group.key} className="space-y-1.5">
                              <div className="flex items-center justify-between px-0.5">
                                <p className="text-[12px] font-semibold text-ink-900 truncate">{group.name}</p>
                                <p className="text-[10.5px] text-ink-500 tabular-nums shrink-0 ml-2">
                                  {group.loans.length > 1 ? `${t('qe_group_n_loans').replace('{n}', String(group.loans.length))} · ` : ''}
                                  {formatMoney(group.totalRemaining, group.currency)}
                                </p>
                              </div>
                              <div className="space-y-2">{group.loans.map(loanRow)}</div>
                            </div>
                          );
                        }
                        return (
                          <div key={group.key} className="space-y-1.5">
                            <button type="button"
                              onClick={() => {
                                if (!isSelectedGroup) setConversionRate('');
                                setRepayTarget({ kind: 'group', key: group.key });
                              }}
                              className={`w-full p-3.5 rounded-2xl border-2 flex items-center justify-between text-left transition-all active:scale-[0.98] ${
                                isSelectedGroup ? 'border-accent-500 bg-accent-50' : 'border-cream-border bg-cream-card'
                              }`}
                            >
                              <div className="min-w-0">
                                <p className="text-[13px] font-semibold text-ink-900 truncate">{group.name}</p>
                                <p className="text-[10px] text-ink-500 mt-0.5">
                                  {t('qe_group_n_loans').replace('{n}', String(group.allocatable.length))} · {t('qe_group_all_loans')}
                                </p>
                              </div>
                              <p className="text-[13px] font-semibold text-ink-900 tabular-nums shrink-0 ml-2">
                                {formatMoney(group.allocatableRemaining, group.currency)}
                              </p>
                            </button>
                            {group.linked.length > 0 && (
                              <p className="text-[10.5px] text-ink-500 leading-relaxed px-0.5">{t('alloc_linked_note')}</p>
                            )}
                            {isSelectedGroup && repayAllocations.length > 0 && (
                              <div className="rounded-2xl border border-cream-border bg-cream-soft/60 p-3 space-y-2">
                                <p className="text-[9.5px] font-semibold uppercase tracking-[0.12em] text-ink-500">{t('qe_group_alloc_note')}</p>
                                {(() => {
                                  const ordered = [...group.allocatable].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
                                  const byId = new Map(ordered.map((l) => [l.id, l]));
                                  return previewAllocations(ordered, repayAllocations).map((line) => {
                                    const l = byId.get(line.loanId)!;
                                    return (
                                      <div key={line.loanId} className="flex items-center justify-between gap-2">
                                        <div className="min-w-0">
                                          <p className="text-[11.5px] font-medium text-ink-800 truncate">
                                            {l.notes?.trim() ? l.notes : (l.type === 'given' ? t('loan_receivable') : t('loan_payable'))}
                                          </p>
                                          <p className="text-[9.5px] text-ink-500 mt-0.5">
                                            {new Date(l.createdAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}
                                          </p>
                                        </div>
                                        <div className="text-right shrink-0">
                                          <p className={`text-[12px] font-bold tabular-nums ${line.applied > 0 ? 'text-receive-text' : 'text-ink-400'}`}>
                                            {line.applied > 0 ? formatMoney(line.applied, group.currency) : '—'}
                                          </p>
                                          {line.cleared ? (
                                            <p className="text-[9px] font-semibold uppercase tracking-[0.1em] text-receive-text">{t('alloc_cleared')}</p>
                                          ) : line.applied > 0 ? (
                                            <p className="text-[9px] text-ink-500 tabular-nums">
                                              {t('loan_remaining')}: {formatMoney(line.after, group.currency)}
                                            </p>
                                          ) : null}
                                        </div>
                                      </div>
                                    );
                                  });
                                })()}
                              </div>
                            )}
                            <button type="button"
                              onClick={() => setExpandedGroupKey((k) => (k === group.key ? '' : group.key))}
                              className="flex items-center gap-1 px-0.5 py-1 text-[11px] font-semibold text-accent-600 active:opacity-70"
                            >
                              <ChevronDown size={13} className={`transition-transform ${expanded ? 'rotate-180' : ''}`} />
                              {t('qe_group_pick_specific')}
                            </button>
                            {expanded && <div className="space-y-2">{group.loans.map(loanRow)}</div>}
                          </div>
                        );
                      })
                    )}
                  </div>
                )}
              </div>
            )}
            {needsLoan && selectedLoanIsLinked && (
              <div className="m-card m-violet p-3.5 space-y-2.5">
                <p className="text-[12px] text-iris-text leading-relaxed">{t('ltr_repay_linked_notice')}</p>
                <button
                  type="button"
                  onClick={() => { if (selectedLoan) { reset(); onClose(); navigate(`/loan/${selectedLoan.id}`); } }}
                  className="m-btn m-btn-violet w-full py-2.5 text-[12px]"
                >{t('ltr_repay_linked_cta')}</button>
              </div>
            )}
            {needsLoan && !selectedLoanIsLinked && repayDirectionType === 'given' && (
              <div>
                <label className="block text-[10.5px] font-semibold text-ink-500 uppercase tracking-[0.12em] mb-2">{t('quick_money_where')}</label>
                <AccountSelect
                  accounts={accounts}
                  selectedId={destId}
                  preferredCurrency={repayCurrency}
                  onSelect={(id) => { setDestId(id); setConversionRate(''); }}
                />
              </div>
            )}
            {needsLoan && !selectedLoanIsLinked && repayDirectionType === 'taken' && (
              <div>
                <label className="block text-[10.5px] font-semibold text-ink-500 uppercase tracking-[0.12em] mb-2">{t('quick_pay_from')}</label>
                <AccountSelect
                  accounts={accounts}
                  selectedId={sourceId}
                  preferredCurrency={repayCurrency}
                  onSelect={(id) => { setSourceId(id); setConversionRate(''); }}
                  renderRight={(a) => (
                    <>
                      <p className="text-[13px] font-semibold text-ink-900 tabular-nums">{formatSignedMoney(a.balance, a.currency)}</p>
                      {renderAfterBalance(a)}
                    </>
                  )}
                />
              </div>
            )}

            {needsGoal && (
              <div>
                <label className="block text-[10.5px] font-semibold text-ink-500 uppercase tracking-[0.12em] mb-2">{t('quick_which_goal')}</label>
                <div className="space-y-2">
                  {goals.map(g => {
                    const pct = g.targetAmount > 0 ? Math.min(100, Math.round((g.savedAmount / g.targetAmount) * 100)) : 0;
                    return (
                      <button key={g.id} type="button"
                        onClick={() => {
                          if (g.id !== goalId) setConversionRate('');
                          setGoalId(g.id);
                        }}
                        className={`w-full p-3.5 rounded-2xl border-2 flex items-center justify-between text-left transition-all active:scale-[0.98] ${
                          goalId === g.id ? 'border-accent-500 bg-accent-50' : 'border-cream-border bg-cream-card'
                        }`}
                      >
                        <div className="min-w-0">
                          <p className="text-[13px] font-semibold text-ink-900 truncate">{g.title}</p>
                          <p className="text-[10px] text-ink-500 tabular-nums">{formatMoney(g.savedAmount, g.currency)} / {formatMoney(g.targetAmount, g.currency)} · {pct}%</p>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {showCategory && (
              <div>
                <label className="block text-[10.5px] font-semibold text-ink-500 uppercase tracking-[0.12em] mb-2">{t('category')}</label>
                <CategoryPicker
                  type={type === 'income' ? 'income' : 'expense'}
                  value={category}
                  onChange={setCategory}
                />
              </div>
            )}

            {!isGroupExpense && (
              <div>
                <label className="block text-[10.5px] font-semibold text-ink-500 uppercase tracking-[0.12em] mb-2">{t('quick_note')}</label>
                <input value={notes} onChange={e => setNotes(e.target.value)} placeholder={t('quick_note_placeholder')} className={inputClass} />
                {/* Payee memory: the app remembered this payee's usual filing. */}
                {payeeMatch && category === payeeMatch.category && payeeMatch.category && (
                  <p className="text-[11px] text-accent-600 mt-1.5">
                    {t('qe_payee_filled').replace('{category}', payeeMatch.category)}
                  </p>
                )}
              </div>
            )}

            {/* Cash advances DO move money (card debited, cash credited), so
                the "money not moved" ledger notice would be misleading there. */}
            {(needsPerson || needsLoan) && !cashAdvance && (
              <p className="text-[12px] text-ink-600 bg-cream-card border border-cream-border rounded-2xl p-3 leading-relaxed">
                {t('money_not_moved_notice')}
              </p>
            )}

            {/* Glanceable confirm/private chip near Save — tells the user
                whether this loan will mirror to a linked contact (who must
                confirm) or stay a private local-only record. Not relevant to
                a cash advance (no counterparty to mirror to). */}
            {(type === 'loan_given' || type === 'loan_taken') && !cashAdvance && (() => {
              const personName = (preset?.lockContact && preset.contact ? preset.contact.name : contact.name).trim();
              if (wouldBranchToLinked) {
                return (
                  <div className="flex items-center gap-2 rounded-2xl bg-accent-50 border border-accent-100 px-3 py-2.5">
                    <Users size={13} className="text-accent-600 shrink-0" />
                    <p className="text-[11px] font-semibold text-accent-600 leading-snug">
                      {t('loan_will_confirm').replace('{name}', personName || t('loan_they'))}
                    </p>
                  </div>
                );
              }
              return (
                <div className="flex items-center gap-2 rounded-2xl bg-cream-soft border border-cream-border px-3 py-2.5">
                  <Lock size={13} className="text-ink-500 shrink-0" />
                  <p className="text-[11px] font-semibold text-ink-600 leading-snug">
                    {t('loan_private')}
                  </p>
                </div>
              );
            })()}

          </div>
        )}
      </Modal>

      <AddAccountStepper open={showInlineAccount} onClose={() => setShowInlineAccount(false)} onComplete={() => setShowInlineAccount(false)} inline />
      <SplitWithSheet
        open={showSplitSheet}
        onClose={() => setShowSplitSheet(false)}
        total={parseFloat(amount) || 0}
        currency={srcAccount?.currency ?? ledgerCurrency}
        ledgerOnly={isLedgerOnlySplitFlow}
        initial={splitPlan}
        onApply={setSplitPlan}
      />
      <ConfirmationSheet open={showConfirmation} onClose={() => { setShowConfirmation(false); onClose(); }} title={confirmData.title} description={confirmData.description} balanceChanges={confirmData.changes} viewRoute={confirmData.route} settled={confirmData.settled} />
      <SpendingWarningModal
        open={showSpendingWarning}
        expense={nearestUpcoming}
        onContinue={() => handleSubmit()}
        onCancel={() => setShowSpendingWarning(false)}
      />
      <ShareKhataLinkSheet
        open={!!khataNudge}
        onClose={() => setKhataNudge(null)}
        personId={khataNudge?.personId ?? ''}
        personName={khataNudge?.personName ?? ''}
        phone={khataNudge?.phone ?? null}
      />
    </>
  );
}
