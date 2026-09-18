import { useEffect, useMemo, useState } from 'react';
import { Modal } from '../components/Modal';
import { confirmDestructive } from '../components/ConfirmDestructiveSheet';
import { useSettlementRequestStore } from '../stores/settlementRequestStore';
import { useLinkedRequestStore } from '../stores/linkedRequestStore';
import { usePersonStore } from '../stores/personStore';
import { useAccountStore } from '../stores/accountStore';
import { useAppModeStore } from '../stores/appModeStore';
import { useToast } from '../components/Toast';
import { formatMoney, formatSignedMoney } from '../lib/constants';
import { currencyMeta } from '../lib/design-tokens';
import { useT } from '../lib/i18n';
import { useSubmitGuard, useSubmitIntentId } from '../lib/useSubmitGuard';
import { resolveSettlementSides } from '../lib/settlementSides';
import { isFriendlyLinkedError } from '../lib/linkedErrorMap';
import type { Loan } from '../db';

interface Props {
  open: boolean;
  onClose: () => void;
  loan: Loan;
}

// Phase 2C-A: linked settlement request. Either side can send it; the other
// linked user must confirm before both mirrored loans are repaid.
export function SettleLinkedLoanModal({ open, onClose, loan }: Props) {
  const { createRequest } = useSettlementRequestStore();
  const linkedRequests = useLinkedRequestStore((s) => s.requests);
  const persons = usePersonStore((s) => s.persons);
  const { accounts, loadAccounts } = useAccountStore();
  const appMode = useAppModeStore((s) => s.mode);
  const toast = useToast();
  const t = useT();
  const submitGuard = useSubmitGuard();

  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  // Phase 2C-B: sender-side optional apply-to-balance.
  const [applyToBalance, setApplyToBalance] = useState(false);
  const [selectedAccountId, setSelectedAccountId] = useState('');
  const isGiven = loan.type === 'given';

  useEffect(() => {
    if (open) {
      // Prefill with the full remaining by default; user can reduce for partial.
      setAmount(String(loan.remainingAmount));
      setNote('');
      setError('');
      setApplyToBalance(false);
      setSelectedAccountId('');
      if (appMode === 'full_tracker') void loadAccounts();
    }
  }, [appMode, open, loan.remainingAmount, loadAccounts]);

  // Currency-strict filter: only the loan's currency is eligible.
  const eligibleAccounts = useMemo(
    () => accounts.filter((a) => a.currency === loan.currency),
    [accounts, loan.currency],
  );
  const hasEligibleAccounts = appMode === 'full_tracker' && eligibleAccounts.length > 0;

  // Resolve the counterparty name for the header.
  const counterpartyName = (() => {
    if (loan.personId) {
      const p = persons.find((x) => x.id === loan.personId);
      if (p) return p.name;
    }
    return loan.personName || t('ltr_unknown_person');
  })();

  // Resolve the accepted linked pair + settlement side mapping via the shared
  // helper (same one the bulk settlement path uses, so they can't drift).
  const sides = resolveSettlementSides(loan.id, linkedRequests);

  const canSubmit = (() => {
    const amt = parseFloat(amount);
    if (!Number.isFinite(amt) || amt <= 0) return false;
    if (amt - loan.remainingAmount > 0.00001) return false;
    if (!sides) return false;
    // If opt-in is on, an eligible account must be selected. Otherwise the
    // submit is ledger-only and always allowed.
    if (applyToBalance) {
      if (!selectedAccountId) return false;
      if (!eligibleAccounts.some((a) => a.id === selectedAccountId)) return false;
    }
    return true;
  })();

  // Ref-backed entry re-check: `saving` state can't stop two taps that land in
  // the same frame. `saving` stays for the disabled/label UI.
  const handleSubmit = () => submitGuard.run(runSubmit);

  // One request id per submit intent — a double tap or an unchanged retry
  // reuses it, so the duplicate insert collides on the primary key instead of
  // queueing a second settlement the counterparty could also accept.
  const nextRequestId = useSubmitIntentId(
    [open, loan.id, amount, note, applyToBalance, selectedAccountId].join('|'),
  );

  const runSubmit = async () => {
    if (!sides) {
      setError(t('stl_create_error'));
      return;
    }
    const amt = parseFloat(amount);
    if (!Number.isFinite(amt) || amt <= 0 || amt - loan.remainingAmount > 0.00001) {
      setError(t('stl_amount_invalid'));
      return;
    }

    const ok = await confirmDestructive({
      title: t('stl_confirm_title'),
      description: `${t('stl_confirm_body').replace('{amount}', formatMoney(amt, loan.currency))}${applyToBalance ? ' ' + t('stl_confirm_balance_note') : ''}`,
      confirmLabel: t('stl_confirm_cta'),
      cancelLabel: t('cancel'),
      tone: 'warning',
    });
    if (!ok) return;

    setSaving(true);
    setError('');
    try {
      const requesterAccountId = applyToBalance && selectedAccountId ? selectedAccountId : null;
      await createRequest({
        loanPairId: sides.loanPairId,
        requesterLoanId: sides.requesterLoanId,
        responderLoanId: sides.responderLoanId,
        toUserId: sides.toUserId,
        amount: amt,
        currency: loan.currency,
        note,
        requesterAccountId,
        requestId: nextRequestId(),
      });
      toast.show({ type: 'success', title: t('stl_sent_title'), subtitle: t('stl_sent_subtitle') });
      onClose();
    } catch (err) {
      console.error('settlement request create failed', err);
      // An already-localized failure (e.g. the database hasn't taken
      // supabase-migration-audit-p0-currencies.sql yet and rejected the
      // currency) reads as its own sentence — don't bracket it behind the
      // generic headline.
      if (isFriendlyLinkedError(err)) { setError(err.message); return; }
      const detail = err instanceof Error ? err.message : '';
      setError(detail ? `${t('stl_create_error')} (${detail})` : t('stl_create_error'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('stl_title').replace('{name}', counterpartyName)}
      footer={
        <button
          onClick={handleSubmit}
          disabled={saving || !canSubmit}
          className="cta-primary"
        >
          {saving ? t('stl_sending') : t('stl_send')}
        </button>
      }
    >
      <div className="space-y-4">
        {/* What this request says, on the violet every linked surface wears. */}
        <div className="m-card m-violet p-3.5">
          <p className="text-[13px] text-ink-800 leading-relaxed">
            {(isGiven ? t('stl_direction_receiving_from') : t('stl_direction_paying_to'))
              .replace('{name}', counterpartyName)
              .replace('{amount}', formatMoney(parseFloat(amount) || 0, loan.currency))}
          </p>
        </div>

        <p className="m-inset text-[12px] text-ink-600 p-3 leading-relaxed">
          {t('money_not_moved_notice')}
        </p>

        <div>
          <label className="form-label">
            {t('stl_amount_label')}
          </label>
          <input
            type="number"
            step="0.01"
            min="0"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className="input-field text-center font-semibold tabular-nums tracking-[-0.02em]"
            // Inline on purpose: index.css pins every <input> to 16px (iOS
            // focus-zoom guard), which beats any font-size utility.
            style={{ fontSize: 22 }}
          />
          <p className="text-[11px] text-ink-600 mt-1.5">
            {t('stl_amount_hint').replace('{remaining}', formatMoney(loan.remainingAmount, loan.currency))}
          </p>
          {Number.isFinite(parseFloat(amount)) && parseFloat(amount) - loan.remainingAmount > 0.00001 && (
            <p className="text-[11px] text-pay-text mt-1 font-semibold">{t('stl_amount_over')}</p>
          )}
        </div>

        <div>
          <label className="form-label">
            {t('stl_note_label')}
          </label>
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            className="input-field"
            placeholder=""
          />
        </div>

        {appMode === 'full_tracker' && (
        <>
        {/* Phase 2C-B: sender-side opt-in toggle + account picker. The whole
            row is the switch (role="switch"), so the label is its name and
            the tap target is the full row. */}
        <button
          type="button"
          role="switch"
          aria-checked={applyToBalance}
          disabled={!hasEligibleAccounts}
          onClick={() => {
            const next = !applyToBalance;
            setApplyToBalance(next);
            if (!next) setSelectedAccountId('');
          }}
          className="m-card w-full flex items-center gap-3 px-4 py-3 text-left disabled:opacity-60 disabled:cursor-not-allowed"
        >
          <span className="text-[13px] text-ink-800 font-medium flex-1">
            {t('stl_apply_toggle_label')}
          </span>
          <span aria-hidden className={`m-switch block ${applyToBalance ? 'is-on' : ''}`} />
        </button>

        {hasEligibleAccounts ? (
          <p className="text-[11px] text-ink-600 -mt-2">{t('stl_apply_toggle_hint')}</p>
        ) : (
          <p className="text-[11px] text-warn-600 -mt-2">{t('stl_apply_no_eligible')}</p>
        )}

        {applyToBalance && hasEligibleAccounts ? (
          <div>
            <label className="form-label">
              {t('stl_apply_pick_account')}
            </label>
            <div className="space-y-2">
              {eligibleAccounts.map((a) => {
                const meta = currencyMeta[a.currency];
                const isSelected = selectedAccountId === a.id;
                return (
                  <button
                    key={a.id}
                    type="button"
                    onClick={() => setSelectedAccountId(a.id)}
                    className={isSelected ? 'selector-base selector-selected' : 'selector-base'}
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-sm">{meta?.flag}</span>
                      <div>
                        <p className="text-[13px] font-semibold text-ink-800">{a.name}</p>
                        <p className="text-[10px] text-ink-500 capitalize">{a.type.replace('_', ' ')}</p>
                      </div>
                    </div>
                    <p className="text-[13px] font-bold text-ink-800 tabular-nums">
                      {formatSignedMoney(a.balance, a.currency)}
                    </p>
                  </button>
                );
              })}
            </div>
          </div>
        ) : null}

        {applyToBalance && selectedAccountId ? (
          <p className="m-card m-violet text-[12px] text-accent-text p-3 leading-relaxed">
            {isGiven ? t('stl_apply_increase_hint') : t('stl_apply_reduce_hint')}
          </p>
        ) : (
          <p className="m-card m-violet text-[12px] text-iris-text p-3 leading-relaxed">
            {t('stl_ledger_only_hint')}
          </p>
        )}
        </>
        )}

        {appMode === 'splits_only' ? (
          <p className="m-card m-violet text-[12px] text-iris-text p-3 leading-relaxed">
            {t('stl_ledger_only_hint')}
          </p>
        ) : null}

        {error && (
          <p className="text-[12px] text-pay-text font-semibold bg-pay-50 rounded-xl p-3">{error}</p>
        )}
      </div>
    </Modal>
  );
}
