// "Add to an account" — puts MY side of an already-applied linked settlement
// into the account the money really touched (set_settlement_repayment_account,
// supabase-migration-settlement-receiver-records.sql). This is the fix for a
// settlement recorded "record only" by accident — the founder's 24 Sep AED
// 3,000 that was deposited into Mashreq but never reached Mashreq in Hisaab —
// and the way a payer notified of a receiver's record adds the money that
// left their own account.
//
// Only my own books change; the other person never sees my accounts. Full
// Tracker only (callers gate it).

import { useEffect, useState } from 'react';
import { Modal } from './Modal';
import { Glyph } from './Glyph';
import { SettlementAccountChoice, landingAccountId } from './SettlementAccountChoice';
import { useAccountStore } from '../stores/accountStore';
import { useSettlementRequestStore } from '../stores/settlementRequestStore';
import { useToast } from './Toast';
import { formatMoney, formatSignedMoney } from '../lib/constants';
import { friendlyLinkedError } from '../lib/linkedErrorMap';
import { useT } from '../lib/i18n';
import { useSubmitGuard } from '../lib/useSubmitGuard';
import type { Currency } from '../db';

export interface AddToAccountTarget {
  /** My own repayment row (requester_txn_id / responder_txn_id on my side). */
  txnId: string;
  amount: number;
  currency: Currency;
  /** My loan in the pair: 'given' = the money came to me; 'taken' = it left me. */
  direction: 'given' | 'taken';
  contactName: string;
}

interface Props {
  open: boolean;
  target: AddToAccountTarget | null;
  onClose: () => void;
}

export function AddToAccountSheet({ open, target, onClose }: Props) {
  const t = useT();
  const toast = useToast();
  const submitGuard = useSubmitGuard();
  const { accounts, loadAccounts } = useAccountStore();
  const attachAccount = useSettlementRequestStore((s) => s.attachAccount);
  const [choice, setChoice] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    setChoice('');
    setSaving(false);
    setError('');
    void loadAccounts();
  }, [open, loadAccounts]);

  if (!target) return null;

  const accountId = landingAccountId(choice);
  const account = accountId ? accounts.find((a) => a.id === accountId) : undefined;
  const delta = target.direction === 'given' ? target.amount : -target.amount;

  const handleConfirm = () => submitGuard.run(runConfirm);
  const runConfirm = async () => {
    if (!accountId || !account) return;
    setSaving(true);
    setError('');
    try {
      await attachAccount(target.txnId, accountId);
      toast.show({ type: 'success', title: t('stl_add_done').replace('{account}', account.name) });
      onClose();
    } catch (err) {
      console.error('add settlement to account failed', err);
      const raw = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
      setError(raw ? friendlyLinkedError(raw) : t('toast_error_generic'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={saving ? () => {} : onClose}
      title={`${t('stl_add_to_account')} · ${formatMoney(target.amount, target.currency)}`}
      footer={
        <button onClick={handleConfirm} disabled={saving || !account} className="cta-primary">
          {saving
            ? t('alloc_applying')
            : account
              ? t('stl_add_cta').replace('{account}', account.name)
              : t('stl_add_to_account')}
        </button>
      }
    >
      <div className="space-y-4">
        <SettlementAccountChoice
          direction={target.direction}
          currency={target.currency}
          accounts={accounts}
          value={choice}
          onChange={setChoice}
          allowRecordOnly={false}
        />

        {account && (
          <p className="m-card m-violet text-[12.5px] text-ink-800 p-3 leading-relaxed tabular-nums">
            {account.name} {formatSignedMoney(delta, target.currency)}
          </p>
        )}

        {/* The old copy told people to "update the account yourself" — some
            did. Adding it again would count the same money twice. */}
        <div className="m-card m-gold flex items-start gap-2.5 p-3.5">
          <Glyph name="alert" size={15} tone="gold" className="mt-0.5" />
          <p className="text-[12px] text-ink-800 leading-relaxed">{t('stl_add_warning')}</p>
        </div>

        {error && (
          <p className="text-[12px] text-pay-text font-semibold bg-pay-50 rounded-xl p-3">{error}</p>
        )}
      </div>
    </Modal>
  );
}
