import { useState } from 'react';
import type { MouseEvent } from 'react';
import { format } from 'date-fns';
import type { Transaction } from '../db';
import { useAccountStore } from '../stores/accountStore';
import { useTransactionStore } from '../stores/transactionStore';
import { useToast } from './Toast';
import { Glyph } from './Glyph';
import { useLoanStore } from '../stores/loanStore';
import { formatMoney } from '../lib/constants';
import { useT } from '../lib/i18n';
import type { GlyphName, GlyphTone } from '../lib/glyphs';
import { parseInternalNote } from '../lib/internalNotes';
import { resolvePersonName } from '../lib/resolvePersonName';
import { getActionLabel } from '../lib/transactionLabel';

// 1d row icon: a 40px tinted square per transaction TYPE, holding a 3c glyph
// in the same semantic accent — money in on mint, money out on coral, moves
// between your own accounts on blue, investments on violet, loans you took on
// gold. Bookkeeping entries (opening balance, corrections) sit on a neutral
// raised control. Direction still comes from the signed, coloured amount on
// the right, so the square is never the only cue.
const TYPE_ICON: Record<string, { square: string; glyph: GlyphName; tone: GlyphTone }> = {
  income:              { square: 'm-card m-mint', glyph: 'arrow-down', tone: 'green' },
  repayment:           { square: 'm-card m-mint', glyph: 'undo', tone: 'green' },
  expense:             { square: 'm-card m-coral', glyph: 'arrow-up', tone: 'coral' },
  loan_given:          { square: 'm-card m-coral', glyph: 'coins', tone: 'coral' },
  loan_taken:          { square: 'm-card m-gold', glyph: 'coins', tone: 'gold' },
  goal_contribution:   { square: 'm-card m-mint', glyph: 'savings', tone: 'green' },
  transfer:            { square: 'm-card m-blue', glyph: 'swap', tone: 'blue' },
  opening_balance:     { square: 'm-ctl', glyph: 'bank', tone: 'neutral' },
  adjustment:          { square: 'm-ctl', glyph: 'sliders', tone: 'neutral' },
  investment_buy:      { square: 'm-card m-violet', glyph: 'trend', tone: 'violet' },
  investment_sell:     { square: 'm-card m-violet', glyph: 'trend', tone: 'violet' },
  investment_dividend: { square: 'm-card m-violet', glyph: 'coins', tone: 'violet' },
};
const FALLBACK_ICON = { square: 'm-ctl', glyph: 'swap', tone: 'neutral' } as const;

interface Props {
  transaction: Transaction;
  accountContextId?: string;
  onClick?: () => void;
}

export function TransactionItem({ transaction, accountContextId, onClick }: Props) {
  const t = useT();
  const toast = useToast();
  const [savingReconciliation, setSavingReconciliation] = useState(false);
  const accounts = useAccountStore((state) => state.accounts);
  const loans = useLoanStore((state) => state.loans);
  const setReconciled = useTransactionStore((state) => state.setReconciled);
  const icon = TYPE_ICON[transaction.type] ?? FALLBACK_ICON;
  const { visibleNote, meta } = parseInternalNote(transaction.notes);
  const isReconciled = transaction.isReconciled ?? false;

  const sourceAccount = transaction.sourceAccountId ? accounts.find((account) => account.id === transaction.sourceAccountId) : null;
  const destinationAccount = transaction.destinationAccountId ? accounts.find((account) => account.id === transaction.destinationAccountId) : null;

  const personName = resolvePersonName({ personId: transaction.personId, fallback: transaction.relatedPerson });
  const linkedLoan = transaction.relatedLoanId ? loans.find((l) => l.id === transaction.relatedLoanId) ?? null : null;
  const actionLabel = getActionLabel(transaction, t, { personName, loan: linkedLoan });
  // A split row's title is the event label ("Friday lunch"), which does NOT
  // name the person — so the " · {name}" suffix has to stay, otherwise the row
  // never says who owes it.
  const usesSplitLabel = !meta.groupExpenseId && !!meta.splitEventId && !!meta.splitLabel;
  // Whether the friendly label already names the person — if so, drop the
  // " · {name}" suffix below to avoid "You gave to Ali · Ali".
  const labelHasPerson = !usesSplitLabel
    && ['loan_given', 'loan_taken', 'repayment'].includes(transaction.type)
    && !!personName;

  const contextIsDestination = Boolean(accountContextId && transaction.destinationAccountId === accountContextId);
  const contextIsSource = Boolean(accountContextId && transaction.sourceAccountId === accountContextId);
  const isDebit = accountContextId
    ? contextIsSource && !contextIsDestination
    : transaction.type === 'opening_balance'
      ? false
      : transaction.type === 'repayment' && !transaction.sourceAccountId && !transaction.destinationAccountId
        // A record-only repayment has no account leg to read the direction
        // from — the loan says it: repaying a TAKEN loan is money I paid.
        // (It used to fall through to "+" for both directions.)
        ? linkedLoan?.type === 'taken'
        : transaction.type === 'repayment' || transaction.type === 'adjustment'
          ? !!transaction.sourceAccountId
          : ['expense', 'loan_given', 'transfer', 'goal_contribution', 'investment_buy'].includes(transaction.type);

  const displayMoney = (() => {
    if (!accountContextId) return { amount: transaction.amount, currency: transaction.currency };
    if (contextIsDestination && destinationAccount) {
      const amount = transaction.conversionRate && destinationAccount.currency !== transaction.currency
        ? Math.round(transaction.amount * transaction.conversionRate * 100) / 100
        : transaction.amount;
      return { amount, currency: destinationAccount.currency };
    }
    if (contextIsSource && sourceAccount) {
      // Types whose stored amount is in a FOREIGN currency (loan/goal/market)
      // while the source account was debited amount ÷ rate.
      const usesLoanOrGoalCurrency = ['repayment', 'goal_contribution', 'investment_buy'].includes(transaction.type);
      const amount = transaction.conversionRate && usesLoanOrGoalCurrency && sourceAccount.currency !== transaction.currency
        ? Math.round((transaction.amount / transaction.conversionRate) * 100) / 100
        : transaction.amount;
      return { amount, currency: sourceAccount.currency };
    }
    return { amount: transaction.amount, currency: transaction.currency };
  })();

  // User-set category wins for expense/income (deliberate metadata).
  // Otherwise fall back to the direction-aware action label.
  const categoryWins = ['expense', 'income'].includes(transaction.type) && !!transaction.category;
  const title = meta.groupExpenseId
    ? meta.expenseDescription || (categoryWins ? transaction.category : actionLabel)
    // An ad-hoc split row is one slice of a shared bill; the event's own label
    // ("Friday lunch") says far more than "Food" or "You gave to Ali".
    : usesSplitLabel
      ? meta.splitLabel!
      : (categoryWins ? transaction.category : actionLabel);

  const detailParts = [format(new Date(transaction.createdAt), 'MMM d, h:mm a')];
  if (meta.groupName) detailParts.push(meta.groupName);
  if (meta.splitPartyCount) detailParts.push(t('split_ways').replace('{n}', meta.splitPartyCount));
  if (visibleNote) detailParts.push(visibleNote);

  const handleReconcileClick = async (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    if (savingReconciliation) return;
    setSavingReconciliation(true);
    try {
      await setReconciled(transaction.id, !isReconciled);
    } catch (err) {
      console.error('Failed to update reconciliation', err);
      // The checkmark optimistically flips back; tell the user it didn't stick
      // instead of silently desyncing.
      toast.show({ type: 'error', title: t('reconcile_failed') });
    } finally {
      setSavingReconciliation(false);
    }
  };

  return (
    <div
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={onClick ? (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onClick();
        }
      } : undefined}
      className={`flex items-center gap-2.5 py-3 ${onClick ? 'cursor-pointer active:opacity-80 transition-opacity' : ''}`}
    >
      {/* Reconcile toggle: a sunken well until checked off, then the green
          extruded dot. 24px visual, 44px hit area (the ::before). */}
      <button
        type="button"
        onClick={handleReconcileClick}
        disabled={savingReconciliation}
        aria-pressed={isReconciled}
        aria-label={isReconciled ? t('reconcile_tip_done') : t('reconcile_tip_todo')}
        title={isReconciled ? t('reconcile_tip_done') : t('reconcile_tip_todo')}
        className={`relative w-6 h-6 rounded-full flex items-center justify-center shrink-0 transition-transform active:translate-y-px disabled:opacity-60 before:absolute before:-inset-2.5 before:content-[''] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-offset-2 focus-visible:ring-offset-cream-card ${
          isReconciled
            ? 'm-stat-dot m-stat-dot-receive'
            : 'm-inset border border-field-border text-transparent hover:border-receive-600'
        }`}
      >
        <Glyph name="check" size={12} strokeWidth={3} />
      </button>
      <div className={`${icon.square} w-10 h-10 rounded-[14px] flex items-center justify-center shrink-0`}>
        <Glyph name={icon.glyph} tone={icon.tone} size={19} />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-[13.5px] font-medium text-ink-900 tracking-tight flex items-center gap-1">
          <span className="truncate">
            {title}
            {!labelHasPerson && personName ? ` · ${personName}` : ''}
          </span>
          {transaction.receiptPath ? (
            <Glyph name="receipt" size={12} className="text-ink-400" label={t('receipt_attached')} />
          ) : null}
        </p>
        <p className="text-[11px] text-ink-500 mt-0.5 truncate">
          {detailParts.join(' · ')}
        </p>
      </div>
      <p className={`text-[14px] font-semibold tabular-nums tracking-tight shrink-0 ${isDebit ? 'text-pay-text' : 'text-receive-text'}`}>
        {isDebit ? '−' : '+'}{formatMoney(displayMoney.amount, displayMoney.currency)}
      </p>
    </div>
  );
}
