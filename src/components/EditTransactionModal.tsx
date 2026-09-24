import { useEffect, useState } from 'react';
import { Modal } from './Modal';
import { Glyph } from './Glyph';
import { useDiscardGuard } from '../lib/useDiscardGuard';
import { useSubmitGuard } from '../lib/useSubmitGuard';
import { ContactPicker, type ContactValue } from './ContactPicker';
import { useAccountStore } from '../stores/accountStore';
import { useTransactionStore } from '../stores/transactionStore';
import { useLoanStore } from '../stores/loanStore';
import { useSettlementRequestStore } from '../stores/settlementRequestStore';
import { isSettlementRepayment } from '../lib/linkedLoanGuards';
import { usePersonStore } from '../stores/personStore';
import { useToast } from './Toast';
import { CategoryPicker } from './CategoryPicker';
import { ReceiptField } from './ReceiptField';
import { AccountSelect } from './AccountSelect';
import { formatMoney, formatSignedMoney } from '../lib/constants';
import { confirmDestructive } from './ConfirmDestructiveSheet';
import { groupExpensesDb } from '../lib/supabaseDb';
import { parseInternalNote } from '../lib/internalNotes';
import { linkedBillPaymentRows } from '../lib/billPaymentEdit';
import { isFutureLocalDay, localDayOf, localIso } from '../lib/localDate';
import { useT } from '../lib/i18n';
import { getActionLabel } from '../lib/transactionLabel';
import type { Transaction } from '../db';

interface Props {
  open: boolean;
  transaction: Transaction | null;
  onClose: () => void;
}

export function EditTransactionModal({ open, transaction, onClose }: Props) {
  const { accounts, loadAccounts } = useAccountStore();
  const { updateTransaction, deleteTransaction, restoreTransaction } = useTransactionStore();
  const persistReceiptPath = useTransactionStore((s) => s.setReceiptPath);
  const allTransactions = useTransactionStore((s) => s.transactions);
  const loans = useLoanStore((s) => s.loans);
  // Either side of an applied linked settlement mirrors a row on the other
  // person's books — it can't be deleted on one side (the store refuses too).
  const settlementRequests = useSettlementRequestStore((s) => s.requests);
  const toast = useToast();
  const t = useT();
  const guardClose = useDiscardGuard();
  const submitGuard = useSubmitGuard();

  const [amount, setAmount] = useState('');
  const [accountId, setAccountId] = useState('');
  const [destAccountId, setDestAccountId] = useState('');
  const [conversionRate, setConversionRate] = useState('');
  const [txDate, setTxDate] = useState('');
  const [cashAdvanceCardId, setCashAdvanceCardId] = useState('');
  const [contact, setContact] = useState<ContactValue>({ id: null, name: '' });
  const [originalPersonId, setOriginalPersonId] = useState<string | null>(null);
  const [category, setCategory] = useState('');
  const [notes, setNotes] = useState('');
  const [receiptPath, setReceiptPath] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // Group-mirror liveness, probed once on open: true = group expense still
  // exists (route to the group screen), false = orphan (freely deletable),
  // null = not a group mirror. Assume LIVE until the probe answers.
  const [groupLive, setGroupLive] = useState<boolean | null>(null);

  useEffect(() => {
    if (open) {
      void loadAccounts();
    }
  }, [open, loadAccounts]);

  useEffect(() => {
    if (!open || !transaction) return;
    const gid = parseInternalNote(transaction.notes).meta.groupExpenseId;
    if (!gid) {
      setGroupLive(null);
      return;
    }
    setGroupLive(true);
    void groupExpensesDb
      .probeExists(gid)
      .then((alive) => setGroupLive(alive))
      .catch(() => setGroupLive(true));
  }, [open, transaction]);

  useEffect(() => {
    if (!transaction || !open) return;

    const parsedNote = parseInternalNote(transaction.notes);
    setAmount(String(transaction.amount));
    setAccountId(
      transaction.type === 'loan_taken' || transaction.type === 'income'
        ? transaction.destinationAccountId ?? ''
        : transaction.sourceAccountId ?? '',
    );
    setDestAccountId(transaction.type === 'transfer' ? transaction.destinationAccountId ?? '' : '');
    setConversionRate(transaction.conversionRate ? String(transaction.conversionRate) : '');
    // LOCAL day, never createdAt.slice(0, 10) (the UTC day): an entry saved
    // after local midnight in UTC+4/+5 would otherwise show — and on save,
    // move to — the day before.
    setTxDate(localDayOf(transaction.createdAt ?? ''));
    setCashAdvanceCardId(transaction.type === 'loan_taken' ? transaction.sourceAccountId ?? '' : '');
    // Hydrate contact from personId when present (post-backfill or post-Phase-1
    // rows); fall back to the legacy string cache for the exceptional case
    // where a row predates Phase 1B-A backfill.
    const hydratedId = transaction.personId ?? null;
    const hydratedName = hydratedId
      ? usePersonStore.getState().persons.find((p) => p.id === hydratedId)?.name ?? transaction.relatedPerson ?? ''
      : transaction.relatedPerson ?? '';
    setContact({ id: hydratedId, name: hydratedName });
    setOriginalPersonId(hydratedId);
    setCategory(transaction.category ?? '');
    setNotes(parsedNote.visibleNote);
    setReceiptPath(transaction.receiptPath ?? null);
  }, [transaction, open]);

  // Persist a receipt attach/remove immediately (it's a side attachment, not
  // part of the amount/category edit) so it survives even if the form is
  // closed without saving.
  const handleReceiptChange = async (path: string | null) => {
    if (!transaction) return;
    setReceiptPath(path);
    try {
      await persistReceiptPath(transaction.id, path);
    } catch {
      toast.show({ type: 'error', title: t('receipt_failed') });
    }
  };

  if (!transaction) return null;

  const destinationAccount = transaction.type === 'loan_taken'
    ? accounts.find((account) => account.id === accountId)
    : null;
  const availableCashAdvanceCards = accounts.filter((account) => (
    account.type === 'credit_card' &&
    account.id !== accountId &&
    (!destinationAccount || account.currency === destinationAccount.currency)
  ));
  const selectedCashAdvanceCard = availableCashAdvanceCards.find((account) => account.id === cashAdvanceCardId);

  const editableAmount = parseFloat(amount);
  // Dirty = any editable field differs from the hydrated transaction (receipt
  // changes persist immediately, so they're excluded).
  const origAccountId = transaction.type === 'loan_taken' || transaction.type === 'income'
    ? (transaction.destinationAccountId ?? '')
    : (transaction.sourceAccountId ?? '');
  const origCashAdvance = transaction.type === 'loan_taken' ? (transaction.sourceAccountId ?? '') : '';
  const origDate = localDayOf(transaction.createdAt ?? '');
  const todayIso = localIso(new Date());
  const dateInFuture = !!txDate && isFutureLocalDay(txDate, new Date());
  const isDirty =
    amount !== String(transaction.amount) ||
    accountId !== origAccountId ||
    destAccountId !== (transaction.type === 'transfer' ? transaction.destinationAccountId ?? '' : '') ||
    txDate !== origDate ||
    cashAdvanceCardId !== origCashAdvance ||
    category !== (transaction.category ?? '') ||
    notes !== parseInternalNote(transaction.notes).visibleNote ||
    (contact.id ?? null) !== originalPersonId;
  const isExpense = transaction.type === 'expense';
  const isIncome = transaction.type === 'income';
  const isTransfer = transaction.type === 'transfer';
  const isLoanGiven = transaction.type === 'loan_given';
  const isLoanTaken = transaction.type === 'loan_taken';
  const noteMeta = parseInternalNote(transaction.notes).meta;
  // A split row is one slice of a shared bill. Editing it alone would desync
  // the slices from each other — raise your own share and the account no longer
  // moves by the real total — so the whole event is edited or deleted together.
  const isDirectlyEditable = (isExpense || isIncome || isTransfer || isLoanGiven || isLoanTaken)
    && !noteMeta.groupExpenseId
    && !noteMeta.splitEventId;

  const splitRows = noteMeta.splitEventId
    ? allTransactions.filter((row) => parseInternalNote(row.notes).meta.splitEventId === noteMeta.splitEventId)
    : [];
  // Pre-flight the blocker that deleteTransaction raises per row, so a
  // part-settled split refuses BEFORE we start destroying its siblings rather
  // than halfway through.
  const splitSettledRow = splitRows.find((row) =>
    row.relatedLoanId && allTransactions.some((x) => x.type === 'repayment' && x.relatedLoanId === row.relatedLoanId),
  );

  // A card-bill payment that settled cash-advance instalments: its amount and
  // accounts are locked (the covered-instalment rows are keyed to them), but
  // its date and note stay editable — a new date moves those rows with it.
  const billPaymentRows = isTransfer ? linkedBillPaymentRows(allTransactions, transaction.id) : [];
  const isSettlingBillPayment = billPaymentRows.length > 0;

  const transferSource = isTransfer ? accounts.find((a) => a.id === accountId) : null;
  const transferDest = isTransfer ? accounts.find((a) => a.id === destAccountId) : null;
  const transferCrossCurrency = Boolean(
    transferSource && transferDest && transferSource.currency !== transferDest.currency,
  );

  const canSave = (() => {
    if (!(editableAmount > 0) || !accountId) return false;
    if ((isLoanGiven || isLoanTaken) && !contact.name.trim()) return false;
    if (isTransfer) {
      if (!destAccountId || destAccountId === accountId) return false;
      if (transferCrossCurrency && !(parseFloat(conversionRate) > 0)) return false;
    }
    if (!txDate || dateInFuture) return false;
    return true;
  })();

  // Only send createdAt when the user actually changed the date — the stored
  // value keeps its original time-of-day otherwise.
  const editedCreatedAt = txDate && txDate !== origDate
    ? new Date(`${txDate}T12:00:00`).toISOString()
    : undefined;

  // A non-null original id that the user has since typed over creates a
  // different contact rather than renaming the existing one — surface that
  // so they don't do it unintentionally. Rename lives in a later phase.
  const willCreateNewContact =
    (isLoanGiven || isLoanTaken) &&
    contact.id === null &&
    contact.name.trim() !== '' &&
    originalPersonId !== null;

  // Ref-backed entry re-check (audit F-8/D-1) shared by save/delete: the
  // `saving` STATE flag updates asynchronously, so two taps in one frame
  // both read it as false and would double-apply a balance reversal.
  // `saving` stays for the disabled/label UI.
  const handleSave = () => submitGuard.run(runSave);
  const handleDelete = () => submitGuard.run(runDelete);
  const handleDeleteSplit = () => submitGuard.run(runDeleteSplit);

  const runSave = async () => {
    if (!canSave) return;

    setSaving(true);
    try {
      if (isExpense) {
        await updateTransaction(transaction.id, {
          type: 'expense',
          amount: editableAmount,
          sourceAccountId: accountId,
          category,
          notes,
          createdAt: editedCreatedAt,
        });
      } else if (isIncome) {
        await updateTransaction(transaction.id, {
          type: 'income',
          amount: editableAmount,
          destinationAccountId: accountId,
          category,
          notes,
          createdAt: editedCreatedAt,
        });
      } else if (isTransfer) {
        await updateTransaction(transaction.id, {
          type: 'transfer',
          amount: editableAmount,
          sourceAccountId: accountId,
          destinationAccountId: destAccountId,
          conversionRate: transferCrossCurrency ? parseFloat(conversionRate) : undefined,
          notes,
          createdAt: editedCreatedAt,
        });
      } else if (isLoanGiven) {
        const trimmedName = contact.name.trim();
        const resolved = contact.id
          ? { id: contact.id, name: trimmedName }
          : await usePersonStore.getState().findOrCreateByName(trimmedName);
        await updateTransaction(transaction.id, {
          type: 'loan_given',
          amount: editableAmount,
          sourceAccountId: accountId,
          personName: resolved.name,
          personId: resolved.id,
          notes,
          createdAt: editedCreatedAt,
        });
      } else if (isLoanTaken) {
        const trimmedName = contact.name.trim();
        const resolved = contact.id
          ? { id: contact.id, name: trimmedName }
          : await usePersonStore.getState().findOrCreateByName(trimmedName);
        await updateTransaction(transaction.id, {
          type: 'loan_taken',
          amount: editableAmount,
          destinationAccountId: accountId,
          sourceAccountId: selectedCashAdvanceCard?.id,
          personName: resolved.name,
          personId: resolved.id,
          notes,
          createdAt: editedCreatedAt,
        });
      }

      toast.show({ type: 'success', title: t('tx_updated') });
      onClose();
    } catch (error) {
      toast.show({
        type: 'error',
        title: t('error'),
        subtitle: error instanceof Error ? error.message : 'Failed',
      });
    } finally {
      setSaving(false);
    }
  };

  const runDelete = async () => {
    const snapshot = transaction;
    // One-tap Undo is only offered for the types restoreTransaction can
    // faithfully restore (expense/income — row + balance). For everything
    // else an "undone" row would come back WITHOUT its money effects and a
    // re-delete would reverse balances twice, minting money.
    const canUndo = snapshot.type === 'expense' || snapshot.type === 'income';
    setSaving(true);
    try {
      await deleteTransaction(transaction.id);
      onClose();
      toast.show(
        canUndo
          ? {
              type: 'success',
              title: t('tx_deleted'),
              action: {
                label: t('undo'),
                onPress: () => {
                  void restoreTransaction(snapshot).catch(() =>
                    toast.show({ type: 'error', title: t('undo_failed') }),
                  );
                },
              },
            }
          : {
              type: 'success',
              title: t('tx_deleted'),
              subtitle: t('tx_delete_no_undo_note'),
            },
      );
    } catch (error) {
      // The reversal was blocked because the credited money was since spent.
      // Real escape: let the user delete anyway, taking the account visibly
      // negative (correctable afterwards) instead of stranding the row.
      const blocked = error as Error & { code?: string; accountName?: string; balanceAfter?: number; accountCurrency?: string };
      if (blocked?.code === 'REVERSAL_NEEDS_NEGATIVE') {
        const after = formatSignedMoney(blocked.balanceAfter ?? 0, (blocked.accountCurrency || transaction.currency) as typeof transaction.currency);
        const ok = await confirmDestructive({
          title: t('del_anyway_title'),
          description: t('del_anyway_body')
            .replace(/\{account\}/g, blocked.accountName ?? '')
            .replace('{after}', after),
          confirmLabel: t('del_anyway_cta'),
          cancelLabel: t('not_now'),
          tone: 'warning',
        });
        if (ok) {
          try {
            await deleteTransaction(transaction.id, { allowNegative: true });
            onClose();
            toast.show({ type: 'success', title: t('tx_deleted'), subtitle: t('tx_delete_no_undo_note') });
          } catch (retryErr) {
            toast.show({
              type: 'error',
              title: t('error'),
              subtitle: retryErr instanceof Error ? retryErr.message : 'Failed',
            });
          }
        }
        setSaving(false);
        return;
      }
      toast.show({
        type: 'error',
        title: t('error'),
        subtitle: error instanceof Error ? error.message : 'Failed',
      });
    } finally {
      setSaving(false);
    }
  };

  // Delete every row of an ad-hoc split as one action: the payer's own share
  // AND each receivable. Removing only some of them would leave the account
  // debited for a bill that no longer exists in the ledger.
  const runDeleteSplit = async () => {
    if (splitRows.length === 0) return;
    if (splitSettledRow) {
      toast.show({ type: 'error', title: t('split_delete_blocked') });
      return;
    }
    const ok = await confirmDestructive({
      title: t('split_delete_event'),
      description: t('split_delete_confirm')
        .replace('{n}', String(splitRows.length))
        .replace('{label}', noteMeta.splitLabel || t('tx_expense')),
      confirmLabel: t('tx_delete_entry'),
      cancelLabel: t('not_now'),
      tone: 'destructive',
    });
    if (!ok) return;

    setSaving(true);
    let done = 0;
    try {
      // Receivables first, own-share last — same reasoning as when writing the
      // split: if this stops halfway, the recoverable row is the one left over.
      const ordered = [...splitRows].sort((a, b) => Number(!!b.relatedLoanId) - Number(!!a.relatedLoanId));
      for (const row of ordered) {
        await deleteTransaction(row.id);
        done += 1;
      }
      onClose();
      toast.show({ type: 'success', title: t('tx_deleted'), subtitle: t('tx_delete_no_undo_note') });
    } catch (error) {
      toast.show({
        type: 'error',
        title: t('split_partial_title').replace('{done}', String(done)).replace('{total}', String(splitRows.length)),
        subtitle: error instanceof Error ? error.message : 'Failed',
        duration: 6000,
      });
      if (done > 0) onClose();
    } finally {
      setSaving(false);
    }
  };

  if (!isDirectlyEditable) {
    const lockedBySettlement = transaction.type === 'repayment' && isSettlementRepayment(transaction.id, settlementRequests);
    const source = transaction.sourceAccountId ? accounts.find((account) => account.id === transaction.sourceAccountId) : null;
    const destination = transaction.destinationAccountId ? accounts.find((account) => account.id === transaction.destinationAccountId) : null;
    return (
      <Modal
        open={open}
        onClose={onClose}
        title={t('tx_details_title')}
        footer={(
          // Group mirrors: the on-open probe decides. LIVE group expense →
          // delete disabled (route via the group screen); orphan whose group
          // was deleted → freely deletable (previously locked forever).
          // Ad-hoc splits delete as a whole event, never row by row.
          noteMeta.splitEventId ? (
            <button
              onClick={handleDeleteSplit}
              disabled={saving || !!splitSettledRow}
              className="cta-destructive py-3.5 text-[14px]"
            >
              <Glyph name="trash" size={15} />
              {saving ? t('quick_processing') : t('split_delete_event')}
            </button>
          ) : (
            <button
              onClick={handleDelete}
              disabled={saving || groupLive === true || lockedBySettlement}
              className="cta-destructive py-3.5 text-[14px]"
            >
              <Glyph name="trash" size={15} />
              {saving ? t('quick_processing') : t('tx_delete_entry')}
            </button>
          )
        )}
      >
        <div className="space-y-4">
          <div className="m-inset p-4">
            <p className="m-label">
              {getActionLabel(transaction, t, {
                personName: transaction.relatedPerson,
                loan: transaction.relatedLoanId ? loans.find((l) => l.id === transaction.relatedLoanId) ?? null : null,
              })}
            </p>
            <p className="text-[21px] font-semibold text-ink-900 tabular-nums tracking-[-0.03em] mt-1.5">
              {formatMoney(transaction.amount, transaction.currency)}
            </p>
          </div>
          {source && <p className="text-[13px] text-ink-700">{t('label_from')} <span className="font-semibold text-ink-900">{source.name}</span></p>}
          {destination && <p className="text-[13px] text-ink-700">{t('label_to')} <span className="font-semibold text-ink-900">{destination.name}</span></p>}
          {transaction.relatedPerson && <p className="text-[13px] text-ink-700">{t('label_person')} <span className="font-semibold text-ink-900">{transaction.relatedPerson}</span></p>}
          {transaction.notes && <p className="text-[12px] text-ink-600">{parseInternalNote(transaction.notes).visibleNote}</p>}
          <p className="m-inset text-[12px] text-ink-600 p-3 leading-relaxed">
            {noteMeta.splitEventId ? t('split_locked_edit') : t('tx_readonly_note')}
          </p>
          {lockedBySettlement && (
            <p className="m-card m-violet text-[12px] text-iris-text p-3 leading-relaxed">
              {t('err_linked_repayment_delete').replace('{person}', transaction.relatedPerson ?? '')}
            </p>
          )}
          {noteMeta.splitEventId && (
            <div className="m-card p-3.5 space-y-2">
              <p className="m-label">
                {t('split_ways').replace('{n}', noteMeta.splitPartyCount ?? String(splitRows.length))}
              </p>
              {splitRows.map((row) => (
                <div key={row.id} className="flex items-center justify-between gap-3">
                  <span className="text-[12.5px] text-ink-700 truncate">
                    {row.type === 'expense' ? t('split_you') : row.relatedPerson ?? ''}
                  </span>
                  <span className={`text-[12.5px] font-semibold tabular-nums ${row.id === transaction.id ? 'text-accent-text' : 'text-ink-900'}`}>
                    {formatMoney(row.amount, row.currency)}
                  </span>
                </div>
              ))}
            </div>
          )}
          {splitSettledRow && (
            <div className="m-card m-gold p-3 flex items-start gap-2">
              <Glyph name="alert" size={15} tone="gold" className="mt-px" />
              <p className="text-[12px] text-warn-700 leading-relaxed">{t('split_delete_blocked')}</p>
            </div>
          )}
          {noteMeta.groupExpenseId && groupLive !== false && (
            <div className="m-card m-gold p-3 flex items-start gap-2">
              <Glyph name="alert" size={15} tone="gold" className="mt-px" />
              <p className="text-[12px] text-warn-700 leading-relaxed">{t('tx_group_expense_warn')}</p>
            </div>
          )}
          {noteMeta.groupExpenseId && groupLive === false && (
            <p className="m-inset text-[12px] text-ink-600 p-3 leading-relaxed">
              {t('tx_group_orphan_note')}
            </p>
          )}
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('edit_entry_title')}
      confirmClose={() => guardClose(isDirty)}
      footer={(
        <div className="flex gap-2.5">
          <button
            onClick={handleDelete}
            disabled={saving}
            aria-label={t('tx_delete_entry')}
            className="m-btn m-btn-danger min-w-[52px] px-4"
          >
            <Glyph name="trash" size={17} />
          </button>
          <button
            onClick={handleSave}
            disabled={saving || !canSave}
            className="m-btn m-btn-primary flex-1 py-3.5 text-[14px]"
          >
            {saving ? t('quick_processing') : t('save')}
          </button>
        </div>
      )}
    >
      <div className="space-y-4">
        <div className="m-inset p-3.5">
          <p className="m-label">
            {getActionLabel(transaction, t, {
              personName: contact.name || transaction.relatedPerson,
              loan: transaction.relatedLoanId ? loans.find((l) => l.id === transaction.relatedLoanId) ?? null : null,
            })}
          </p>
          <p className="text-[21px] font-semibold text-ink-900 tabular-nums tracking-[-0.03em] mt-1.5">
            {formatMoney(transaction.amount, transaction.currency)}
          </p>
        </div>

        {isSettlingBillPayment && (
          <p className="m-inset text-[12px] text-ink-600 p-3 leading-relaxed">{t('bill_edit_money_locked')}</p>
        )}

        <div>
          <label className="form-label">{t('amount_label')}</label>
          <input
            type="number"
            step="0.01"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            disabled={isSettlingBillPayment}
            className="input-field text-center text-lg font-bold tabular-nums disabled:opacity-60"
          />
        </div>

        <div>
          <label className="form-label">
            {isLoanTaken ? t('loan_received_into') : isIncome ? t('quick_to') : t('quick_from')}
          </label>
          <AccountSelect
            accounts={accounts}
            selectedId={accountId}
            locked={isSettlingBillPayment}
            onSelect={(id) => {
              setAccountId(id);
              // The main account can't also fund itself as a cash advance,
              // and a transfer can't target its own source.
              if (cashAdvanceCardId === id) setCashAdvanceCardId('');
              if (isTransfer && destAccountId === id) setDestAccountId('');
              setConversionRate('');
            }}
          />
        </div>

        {isTransfer && (
          <div>
            <label className="form-label">{t('quick_to')}</label>
            <AccountSelect
              accounts={accounts.filter((a) => a.id !== accountId)}
              selectedId={destAccountId}
              locked={isSettlingBillPayment}
              onSelect={(id) => {
                setDestAccountId(id);
                setConversionRate('');
              }}
            />
          </div>
        )}

        {isTransfer && transferCrossCurrency && transferSource && transferDest && (
          <div>
            <label className="form-label">
              {t('edit_rate_label')
                .replace('{src}', transferSource.currency)
                .replace('{dst}', transferDest.currency)}
            </label>
            <input
              type="number"
              step="0.0001"
              value={conversionRate}
              onChange={(event) => setConversionRate(event.target.value)}
              disabled={isSettlingBillPayment}
              className="input-field text-center tabular-nums disabled:opacity-60"
              placeholder="0.00"
            />
            {parseFloat(conversionRate) > 0 && editableAmount > 0 && (
              <p className="text-[11px] text-ink-500 mt-1.5 tabular-nums">
                {formatMoney(editableAmount, transferSource.currency)} → {formatMoney(Math.round(editableAmount * parseFloat(conversionRate) * 100) / 100, transferDest.currency)}
              </p>
            )}
          </div>
        )}

        <div>
          <label className="form-label">{t('edit_date_label')}</label>
          <input
            type="date"
            value={txDate}
            max={todayIso}
            onChange={(event) => setTxDate(event.target.value)}
            className="input-field"
          />
          {dateInFuture ? (
            <p className="text-[11px] text-warn-600 mt-1.5">{t('date_future_error')}</p>
          ) : txDate !== origDate && (
            <p className="text-[11px] text-ink-500 mt-1.5">
              {t('edit_date_hint')}
              {isSettlingBillPayment && <> {t('bill_edit_date_moves_rows')}</>}
            </p>
          )}
        </div>

        {isLoanTaken && availableCashAdvanceCards.length > 0 && (
          <div>
            <label className="form-label">{t('cash_advance_source')}</label>
            <div className="space-y-2.5">
              <button
                type="button"
                onClick={() => setCashAdvanceCardId('')}
                aria-pressed={!selectedCashAdvanceCard}
                className={`selector-base text-[12.5px] font-semibold ${
                  !selectedCashAdvanceCard ? 'selector-selected text-accent-text' : 'text-ink-600'
                }`}
              >
                {t('cash_advance_none')}
              </button>
              {availableCashAdvanceCards.map((account) => (
                <button
                  key={account.id}
                  type="button"
                  onClick={() => setCashAdvanceCardId(account.id)}
                  aria-pressed={selectedCashAdvanceCard?.id === account.id}
                  className={`selector-base ${selectedCashAdvanceCard?.id === account.id ? 'selector-selected' : ''}`}
                >
                  <div className="flex items-center gap-2.5 min-w-0">
                    <Glyph name="card" size={17} tone="coral" />
                    <div className="min-w-0">
                      <p className="text-[13px] font-semibold text-ink-900 truncate">{account.name}</p>
                      <p className="text-[10.5px] text-ink-500">{t('etm_credit_card')}</p>
                    </div>
                  </div>
                  <p className="text-[13px] font-semibold text-ink-900 tabular-nums shrink-0 ml-2">{formatSignedMoney(account.balance, account.currency)}</p>
                </button>
              ))}
            </div>
          </div>
        )}

        {(isLoanGiven || isLoanTaken) && (
          <div>
            <label className="form-label">{t('quick_who')}</label>
            <ContactPicker
              value={contact}
              onChange={setContact}
              placeholder={t('quick_who_placeholder')}
              className="input-field"
            />
            {willCreateNewContact && (
              <p className="text-[11px] text-warn-600 mt-1.5">{t('etm_will_create_contact')}</p>
            )}
          </div>
        )}

        {(isExpense || isIncome) && (
          <div>
            <label className="form-label">{t('category')}</label>
            <CategoryPicker type={isIncome ? 'income' : 'expense'} value={category} onChange={setCategory} includeCurrent />
          </div>
        )}

        <div>
          <label className="form-label">{t('quick_note')}</label>
          <input
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
            className="input-field"
            placeholder={t('quick_note_placeholder')}
          />
        </div>

        <ReceiptField
          transactionId={transaction.id}
          receiptPath={receiptPath}
          onChange={(path) => void handleReceiptChange(path)}
        />
      </div>
    </Modal>
  );
}
