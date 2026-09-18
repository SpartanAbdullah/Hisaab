import { useEffect, useMemo, useState } from 'react';
import { Modal } from './Modal';
import { Glyph } from './Glyph';
import { useAccountStore } from '../stores/accountStore';
import { useSettlementRequestStore } from '../stores/settlementRequestStore';
import { useLinkedRequestStore } from '../stores/linkedRequestStore';
import { useAppModeStore } from '../stores/appModeStore';
import { useToast } from './Toast';
import { confirmDestructive } from './ConfirmDestructiveSheet';
import { formatMoney, formatSignedMoney } from '../lib/constants';
import { currencyMeta } from '../lib/design-tokens';
import { useT } from '../lib/i18n';
import { useSubmitGuard, useSubmitIntentId } from '../lib/useSubmitGuard';
import { allocateRepayment, previewAllocations, totalRemaining, type Allocation, type AllocationStrategy } from '../lib/repaymentAllocation';
import { resolveSettlementSides, type SettlementSides } from '../lib/settlementSides';
import { executeAllocatedSettlements } from '../lib/settlementExecution';
import type { Currency, Loan } from '../db';

type Strategy = AllocationStrategy | 'manual';

interface Props {
  open: boolean;
  onClose: () => void;
  loans: Loan[]; // active LINKED loans, one currency + direction, none with a pending request
  direction: 'given' | 'taken';
  currency: Currency;
  personName: string;
  onDone: () => void;
}

// One lump across a person's LINKED loans: splits into one settlement request
// per loan (oldest first by default). Nothing settles locally — the
// counterparty confirms each request from their inbox, and both mirrored
// ledgers update on acceptance. The linked twin of AllocateRepaymentModal.
export function AllocateSettlementModal({ open, onClose, loans, direction, currency, personName, onDone }: Props) {
  const createRequest = useSettlementRequestStore((s) => s.createRequest);
  const linkedRequests = useLinkedRequestStore((s) => s.requests);
  const { accounts, loadAccounts } = useAccountStore();
  const appMode = useAppModeStore((s) => s.mode);
  const toast = useToast();
  const t = useT();
  const submitGuard = useSubmitGuard();

  const [lump, setLump] = useState('');
  // Oldest-first default: a consolidated return pays down what's been owed
  // longest — same story as the local allocation flow.
  const [strategy, setStrategy] = useState<Strategy>('oldest');
  const [manual, setManual] = useState<Record<string, string>>({});
  const [note, setNote] = useState('');
  const [applyToBalance, setApplyToBalance] = useState(false);
  const [accountId, setAccountId] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setLump('');
    setStrategy('oldest');
    setManual({});
    setNote('');
    setApplyToBalance(false);
    setAccountId('');
    if (appMode === 'full_tracker') void loadAccounts();
  }, [open, appMode, loadAccounts]);

  // Only loans whose accepted pair row resolves can carry a request.
  const sidesByLoan = useMemo(() => {
    const m: Record<string, SettlementSides> = {};
    for (const l of loans) {
      const s = resolveSettlementSides(l.id, linkedRequests);
      if (s) m[l.id] = s;
    }
    return m;
  }, [loans, linkedRequests]);
  const sendableLoans = useMemo(() => loans.filter((l) => sidesByLoan[l.id]), [loans, sidesByLoan]);

  const maxRemaining = useMemo(() => totalRemaining(sendableLoans), [sendableLoans]);
  const eligibleAccounts = useMemo(
    () => accounts.filter((a) => a.currency === currency),
    [accounts, currency],
  );

  const allocations: Allocation[] = useMemo(() => {
    if (strategy === 'manual') {
      return sendableLoans
        .map((l) => {
          const raw = parseFloat(manual[l.id] ?? '');
          const amount = Number.isFinite(raw) ? Math.min(Math.round(raw * 100) / 100, Math.round(l.remainingAmount * 100) / 100) : 0;
          return { loanId: l.id, amount };
        })
        .filter((a) => a.amount > 0);
    }
    const amt = parseFloat(lump);
    if (!Number.isFinite(amt) || amt <= 0) return [];
    return allocateRepayment(sendableLoans, amt, strategy);
  }, [strategy, manual, lump, sendableLoans]);

  const totalAllocated = useMemo(
    () => Math.round(allocations.reduce((a, x) => a + x.amount, 0) * 100) / 100,
    [allocations],
  );
  const leftover = strategy === 'manual'
    ? 0
    : Math.max(0, Math.round(((parseFloat(lump) || 0) - totalAllocated) * 100) / 100);

  const previewOrder = useMemo(
    () => [...sendableLoans].sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    [sendableLoans],
  );
  const previewLines = useMemo(() => previewAllocations(previewOrder, allocations), [previewOrder, allocations]);

  const canSubmit =
    totalAllocated > 0 &&
    totalAllocated <= maxRemaining + 0.001 &&
    (!applyToBalance || !!accountId);

  // One intent id for the whole batch; each request's id is derived from it
  // plus the loan id, so a double-fired batch re-sends the SAME ids and every
  // duplicate lands on the primary key instead of the counterparty's inbox.
  const nextIntentId = useSubmitIntentId(
    [open, strategy, lump, note, applyToBalance, accountId, JSON.stringify(manual)].join('|'),
  );

  // Ref-backed entry re-check; `saving` state remains the disabled/label UI.
  const handleSubmit = () => submitGuard.run(runSubmit);

  const runSubmit = async () => {
    if (!canSubmit) return;
    const ok = await confirmDestructive({
      title: `${t('stl_bulk_send').replace('{n}', String(allocations.length))} · ${formatMoney(totalAllocated, currency)}`,
      description: t('stl_bulk_confirm_body')
        .replace('{name}', personName)
        .replace('{n}', String(allocations.length))
        .replace('{amount}', formatMoney(totalAllocated, currency)),
      confirmLabel: t('stl_send'),
      cancelLabel: t('cancel'),
      tone: 'warning',
    });
    if (!ok) return;

    setSaving(true);
    const intentId = nextIntentId();
    try {
      const result = await executeAllocatedSettlements(
        allocations.map((a) => ({ loanId: a.loanId, amount: a.amount })),
        {
          currency,
          note: note.trim() || undefined,
          requesterAccountId: applyToBalance && accountId ? accountId : null,
          sidesByLoan,
          createRequest,
          requestIdFor: (loanId) => `${intentId}:${loanId}`,
        },
      );
      if (!result.failed) {
        toast.show({
          type: 'success',
          title: t('stl_bulk_sent_title'),
          subtitle: t('stl_bulk_sent_subtitle').replace('{name}', personName),
        });
        onDone();
        onClose();
      } else {
        const err = result.failed.error;
        toast.show({
          type: 'error',
          title: result.done > 0
            ? t('stl_bulk_partial').replace('{done}', String(result.done)).replace('{total}', String(result.total))
            : t('error'),
          subtitle: err instanceof Error ? err.message : t('toast_error_generic'),
          duration: 6000,
        });
        if (result.done > 0) { onDone(); onClose(); }
      }
    } finally {
      setSaving(false);
    }
  };

  const strategies: { value: Strategy; label: string }[] = [
    { value: 'oldest', label: t('alloc_oldest') },
    { value: 'smallest', label: t('alloc_smallest') },
    { value: 'largest', label: t('alloc_largest') },
    { value: 'manual', label: t('alloc_manual') },
  ];

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`${t('stl_bulk_title')} · ${personName}`}
      footer={
        <button onClick={handleSubmit} disabled={saving || !canSubmit} className="cta-primary">
          {saving
            ? t('stl_sending')
            : `${t('stl_bulk_send').replace('{n}', String(allocations.length))} · ${formatMoney(totalAllocated, currency)}`}
        </button>
      }
    >
      <div className="space-y-4">
        <p className="text-[12px] text-ink-600 leading-relaxed">
          {t('stl_bulk_intro').replace('{name}', personName)}
        </p>

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
                className={`selector-base justify-center text-[12px] font-semibold text-ink-800 ${strategy === s.value ? 'selector-selected' : ''}`}
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

        {/* Preview / manual entry — oldest first so it reads in fill order. */}
        <div>
          <label className="form-label">{t('alloc_preview')}</label>
          <div className="m-card overflow-hidden divide-y divide-cream-hairline">
            {previewOrder.map((l, i) => {
              const line = previewLines[i];
              return (
                <div key={l.id} className="px-3.5 py-3">
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-[12.5px] font-semibold text-ink-900 truncate">
                        {l.notes?.trim() || (direction === 'given' ? t('loan_receivable') : t('loan_payable'))}
                      </p>
                      <p className="text-[10.5px] text-ink-600 tabular-nums mt-0.5">
                        {formatMoney(l.remainingAmount, l.currency)} {t('loan_remaining').toLowerCase()}
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
                        <p className={`text-[13px] font-semibold tabular-nums ${line.applied ? 'text-receive-text' : 'text-ink-400'}`}>
                          {line.applied ? formatMoney(line.applied, l.currency) : '—'}
                        </p>
                        {line.cleared ? (
                          <span className="m-chip m-chip-receive m-chip-caps mt-1">
                            <Glyph name="check" size={10} strokeWidth={3} />
                            {t('stl_bulk_clears')}
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

        {/* Shared note — lands on every request. */}
        <div>
          <label className="form-label">{t('stl_note_label')}</label>
          <input value={note} onChange={(e) => setNote(e.target.value)} className="input-field" />
        </div>

        {/* Optional apply-to-balance (full tracker): the same account is
            stamped on every request; the debit/credit lands when the
            counterparty accepts. */}
        {appMode === 'full_tracker' && eligibleAccounts.length > 0 && (
          <>
            {/* The whole row is the switch (role="switch"): the label is its
                accessible name and the full row is the tap target. */}
            <button
              type="button"
              role="switch"
              aria-checked={applyToBalance}
              onClick={() => {
                const next = !applyToBalance;
                setApplyToBalance(next);
                if (!next) setAccountId('');
              }}
              className="m-card w-full flex items-center gap-3 px-4 py-3 text-left"
            >
              <span className="text-[13px] text-ink-800 font-medium flex-1">{t('stl_apply_toggle_label')}</span>
              <span aria-hidden className={`m-switch block ${applyToBalance ? 'is-on' : ''}`} />
            </button>
            {applyToBalance && (
              <div>
                <label className="form-label">{t('stl_apply_pick_account')}</label>
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
                </div>
              </div>
            )}
          </>
        )}

        {/* Linked settlements go to the other side to confirm — violet, the
            colour every linked surface wears. */}
        <p className="m-card m-violet text-[12px] text-iris-text p-3 leading-relaxed">
          {t('stl_bulk_confirm_note').replace('{name}', personName)}
        </p>
      </div>
    </Modal>
  );
}
