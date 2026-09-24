import { useEffect, useMemo, useState } from 'react';
import { Modal } from './Modal';
import { Glyph } from './Glyph';
import { useSubmitGuard } from '../lib/useSubmitGuard';
import { useAccountStore } from '../stores/accountStore';
import { useTransactionStore } from '../stores/transactionStore';
import { useLoanStore } from '../stores/loanStore';
import { useAppModeStore } from '../stores/appModeStore';
import { useToast } from './Toast';
import { confirmDestructive } from './ConfirmDestructiveSheet';
import { formatMoney, formatSignedMoney } from '../lib/constants';
import { currencyMeta } from '../lib/design-tokens';
import { useT } from '../lib/i18n';
import { allocateRepayment, orderLoansForStrategy, totalRemaining, type Allocation, type AllocationStrategy } from '../lib/repaymentAllocation';
import { executeAllocatedRepayments } from '../lib/repaymentExecution';
import { isLoanRemainingConflict } from '../lib/loanRemainingDelta';
import { track } from '../lib/telemetry';
import type { Currency, Loan } from '../db';

type Strategy = AllocationStrategy | 'manual';

interface Props {
  open: boolean;
  onClose: () => void;
  loans: Loan[]; // active, non-linked, one currency + direction
  direction: 'given' | 'taken';
  currency: Currency;
  personName: string;
  onDone: (info?: { totalApplied: number }) => void;
  // Pre-fill for hand-offs (e.g. RepaymentModal overflow: the user already
  // typed a lump bigger than one loan — carry it in instead of re-asking).
  initialLump?: number;
  initialStrategy?: Strategy;
  initialAccountId?: string;
}

// Spread one lump repayment across several of a person's loans. Same net math
// as a single big repayment — it just lets the user decide WHICH loans clear
// (e.g. wipe the small ones first), which is what users expect.
export function AllocateRepaymentModal({ open, onClose, loans, direction, currency, personName, onDone, initialLump, initialStrategy, initialAccountId }: Props) {
  const { accounts, loadAccounts } = useAccountStore();
  const processTransaction = useTransactionStore((s) => s.processTransaction);
  const applyRepayment = useLoanStore((s) => s.applyRepayment);
  const loadLoans = useLoanStore((s) => s.loadLoans);
  const isLedgerOnlyMode = useAppModeStore((s) => s.mode) === 'splits_only';
  const toast = useToast();
  const t = useT();
  const submitGuard = useSubmitGuard();

  const [lump, setLump] = useState('');
  const [strategy, setStrategy] = useState<Strategy>('smallest');
  const [manual, setManual] = useState<Record<string, string>>({});
  const [accountId, setAccountId] = useState('');
  const [saving, setSaving] = useState(false);

  const maxRemaining = useMemo(() => totalRemaining(loans), [loans]);
  const isGiven = direction === 'given';

  useEffect(() => {
    if (!open) return;
    setLump(initialLump != null && initialLump > 0 ? String(initialLump) : '');
    setStrategy(initialStrategy ?? 'smallest');
    setManual({});
    setAccountId(initialAccountId ?? '');
    if (!isLedgerOnlyMode) void loadAccounts();
  }, [open, isLedgerOnlyMode, loadAccounts, initialLump, initialStrategy, initialAccountId]);

  const eligibleAccounts = useMemo(
    () => accounts.filter((a) => a.currency === currency),
    [accounts, currency],
  );

  // Loans listed in the order the chosen strategy fills them, so the loan the
  // lump reaches first is on top. By hand: newest first, like the Loans page.
  const displayLoans = useMemo(
    () => orderLoansForStrategy(loans, strategy === 'manual' ? 'newest' : strategy),
    [loans, strategy],
  );

  const allocations: Allocation[] = useMemo(() => {
    if (strategy === 'manual') {
      return loans
        .map((l) => {
          const raw = parseFloat(manual[l.id] ?? '');
          const amount = Number.isFinite(raw) ? Math.min(Math.round(raw * 100) / 100, Math.round(l.remainingAmount * 100) / 100) : 0;
          return { loanId: l.id, amount };
        })
        .filter((a) => a.amount > 0);
    }
    const amt = parseFloat(lump);
    if (!Number.isFinite(amt) || amt <= 0) return [];
    return allocateRepayment(loans, amt, strategy);
  }, [strategy, manual, lump, loans]);

  const totalAllocated = useMemo(
    () => Math.round(allocations.reduce((a, x) => a + x.amount, 0) * 100) / 100,
    [allocations],
  );
  const leftover = strategy === 'manual'
    ? 0
    : Math.max(0, Math.round(((parseFloat(lump) || 0) - totalAllocated) * 100) / 100);

  const allocById = useMemo(() => {
    const m = new Map<string, number>();
    for (const a of allocations) m.set(a.loanId, a.amount);
    return m;
  }, [allocations]);

  const canSubmit =
    totalAllocated > 0 &&
    totalAllocated <= maxRemaining + 0.001 &&
    (isLedgerOnlyMode || !!accountId);

  // Entry re-check lives in submitGuard (a ref, so two taps in one frame
  // can't both pass); `saving` stays purely for the disabled/label UI.
  const handleSubmit = () => submitGuard.run(runSubmit);

  const runSubmit = async () => {
    if (!canSubmit) return;
    const ok = await confirmDestructive({
      title: `${t('alloc_apply')} · ${formatMoney(totalAllocated, currency)}`,
      description: (isGiven ? t('alloc_confirm_received') : t('alloc_confirm_paid'))
        .replace('{person}', personName)
        .replace('{amount}', formatMoney(totalAllocated, currency))
        .replace('{n}', String(allocations.length)),
      confirmLabel: t('alloc_apply'),
      cancelLabel: t('confirm_repayment_no'),
      tone: 'warning',
    });
    if (!ok) return;

    setSaving(true);
    try {
      const result = await executeAllocatedRepayments(
        allocations.map((a) => ({ loanId: a.loanId, amount: a.amount })),
        {
          mode: isLedgerOnlyMode ? 'splits_only' : 'tracker',
          direction,
          accountId: accountId || undefined,
          processTransaction,
          applyRepayment,
        },
      );
      // Catalog #12. This modal IS the cross-loan lump allocator, so
      // `consolidated` is always true here (see RepaymentModal's comment on
      // the same event) — a single-loan repayment lump goes through
      // RepaymentModal/QuickEntry instead, which track their own falses.
      // `settles_loan` mirrors the group-repayment case in QuickEntry: true
      // if at least one of the loans actually applied to reached zero.
      // Each repayment commits independently (repaymentExecution.ts), so
      // this fires once for whatever prefix committed — nothing if none did.
      if (result.done > 0) {
        const remainingById = new Map(loans.map((l) => [l.id, l.remainingAmount]));
        const settlesAny = result.applied.some((a) => {
          const remaining = remainingById.get(a.loanId);
          return remaining != null && a.amount >= remaining - 0.001;
        });
        track('repayment_recorded', {
          consolidated: true,
          settles_loan: settlesAny,
          mode: isLedgerOnlyMode ? 'splits_only' : 'full_tracker',
          currency,
        });
      }
      if (!result.failed) {
        toast.show({
          type: 'success',
          title: t('alloc_done'),
          subtitle: `${formatMoney(result.totalApplied, currency)} · ${result.total === 1 ? t('qe_group_one_loan') : t('qe_group_n_loans').replace('{n}', String(result.total))}`,
        });
        onDone({ totalApplied: result.totalApplied });
        onClose();
      } else {
        // Each repayment commits independently; report how far we got so a
        // retry only needs to cover the rest.
        const err = result.failed.error;
        // Audit C10: a mid-batch stop can be the optimistic lock refusing a
        // stale write (another device moved this loan). Re-pull the loans so
        // the preview + the retry allocate against the real remainings, not
        // the figures that just lost the race.
        if (isLoanRemainingConflict(err)) await loadLoans();
        toast.show({
          type: 'error',
          title: result.done > 0
            ? t('alloc_partial_title').replace('{done}', String(result.done)).replace('{total}', String(result.total))
            : t('error'),
          subtitle: err instanceof Error ? err.message : t('toast_error_generic'),
          duration: 6000,
        });
        if (result.done > 0) { onDone({ totalApplied: result.totalApplied }); onClose(); }
      }
    } finally {
      setSaving(false);
    }
  };

  const strategies: { value: Strategy; label: string }[] = [
    { value: 'smallest', label: t('alloc_smallest') },
    { value: 'largest', label: t('alloc_largest') },
    { value: 'oldest', label: t('alloc_oldest') },
    { value: 'newest', label: t('alloc_newest') },
    { value: 'manual', label: t('alloc_manual') },
  ];

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`${t('alloc_title')} · ${personName}`}
      footer={
        <button onClick={handleSubmit} disabled={saving || !canSubmit} className="cta-primary">
          {saving ? t('alloc_applying') : `${t('alloc_apply')} · ${formatMoney(totalAllocated, currency)}`}
        </button>
      }
    >
      <div className="space-y-4">
        <p className="text-[12px] text-ink-600 leading-relaxed">{t('alloc_intro')}</p>

        {/* Strategy */}
        <div>
          <label className="form-label">{t('alloc_strategy_label')}</label>
          <div className="grid grid-cols-2 gap-2.5">
            {strategies.map((s) => (
              <button
                key={s.value}
                type="button"
                onClick={() => setStrategy(s.value)}
                aria-pressed={strategy === s.value}
                className={`selector-base justify-center text-[12px] font-semibold text-ink-800 ${s.value === 'manual' ? 'col-span-2' : ''} ${strategy === s.value ? 'selector-selected' : ''}`}
              >
                {s.label}
              </button>
            ))}
          </div>
        </div>

        {/* Lump amount (auto strategies only) */}
        {strategy !== 'manual' && (
          <div>
            <label className="form-label">{t('alloc_lump_label')} ({currency})</label>
            <input
              type="number"
              step="0.01"
              value={lump}
              onChange={(e) => setLump(e.target.value)}
              placeholder="0.00"
              className="input-field text-center font-semibold tabular-nums tracking-[-0.02em]"
              // Inline on purpose: index.css pins every <input> to 16px (iOS
              // focus-zoom guard), which beats any font-size utility.
              style={{ fontSize: 22 }}
              autoFocus
            />
            <button
              type="button"
              onClick={() => setLump(String(maxRemaining))}
              className="mt-2 min-h-[32px] text-[11.5px] text-accent-600 font-semibold active:opacity-70"
            >
              {t('repay_full_amount').replace('{amount}', formatMoney(maxRemaining, currency))}
            </button>
            {totalAllocated > maxRemaining + 0.001 && (
              <p className="mt-2 text-[11px] text-pay-text font-semibold">{t('alloc_over')}</p>
            )}
          </div>
        )}

        {/* Account (full tracker) */}
        {!isLedgerOnlyMode && (
          <div>
            <label className="form-label">{t('alloc_account_label')}</label>
            <div className="space-y-2.5">
              {eligibleAccounts.map((a) => {
                const meta = currencyMeta[a.currency];
                return (
                  <button
                    key={a.id}
                    type="button"
                    onClick={() => setAccountId(a.id)}
                    aria-pressed={accountId === a.id}
                    className={accountId === a.id ? 'selector-base selector-selected' : 'selector-base'}
                  >
                    <span className="text-[13px] font-semibold text-ink-800 flex items-center gap-1.5">
                      <span>{meta?.flag}</span> {a.name}
                    </span>
                    <span className="text-[12px] text-ink-600 tabular-nums">{formatSignedMoney(a.balance, a.currency)}</span>
                  </button>
                );
              })}
              {eligibleAccounts.length === 0 && (
                <p className="m-card m-gold text-[12px] text-warn-700 p-3 leading-relaxed">{t('alloc_no_account').replace('{currency}', currency)}</p>
              )}
            </div>
          </div>
        )}

        {/* Preview / manual entry */}
        <div>
          <label className="form-label">{t('alloc_preview')}</label>
          <div className="m-card overflow-hidden divide-y divide-cream-hairline">
            {displayLoans.map((l) => {
              const applied = strategy === 'manual' ? undefined : (allocById.get(l.id) ?? 0);
              const willClear = applied != null && applied >= l.remainingAmount - 0.001;
              return (
                <div key={l.id} className="px-3.5 py-3">
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-[12.5px] font-semibold text-ink-900 truncate">
                        {l.notes?.trim() || `${isGiven ? t('loan_receivable') : t('loan_payable')}`}
                      </p>
                      <p className="text-[10.5px] text-ink-600 tabular-nums mt-0.5">
                        {new Date(l.createdAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}
                        {' · '}{formatMoney(l.remainingAmount, l.currency)} {t('loan_remaining').toLowerCase()}
                      </p>
                    </div>
                    {strategy === 'manual' ? (
                      <input
                        type="number"
                        step="0.01"
                        value={manual[l.id] ?? ''}
                        onChange={(e) => setManual((m) => ({ ...m, [l.id]: e.target.value }))}
                        placeholder="0"
                        className="w-24 input-field text-right font-semibold tabular-nums py-2"
                      />
                    ) : (
                      <div className="text-right shrink-0">
                        <p className={`text-[13px] font-semibold tabular-nums ${applied ? 'text-receive-text' : 'text-ink-400'}`}>
                          {applied ? formatMoney(applied, l.currency) : '—'}
                        </p>
                        {willClear && applied ? (
                          <span className="m-chip m-chip-receive m-chip-caps mt-1">
                            <Glyph name="check" size={10} strokeWidth={3} />
                            {t('alloc_cleared')}
                          </span>
                        ) : null}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
          {leftover > 0 && (
            <p className="mt-2 text-[11px] text-warn-600">
              {formatMoney(leftover, currency)} {t('alloc_leftover')}
            </p>
          )}
        </div>

        {!isLedgerOnlyMode && (
          <p className="m-inset text-[12px] text-ink-600 p-3 leading-relaxed">
            {t('money_not_moved_notice')}
          </p>
        )}
      </div>
    </Modal>
  );
}
