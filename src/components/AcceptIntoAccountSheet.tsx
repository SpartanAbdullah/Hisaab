// Full Money Tracker accept flow for incoming cross-user requests: folds the
// deliberate "this is irreversible" confirmation and the "which account did
// the money actually touch?" choice into ONE sheet, so accepting stays a
// single dialog. "Record only" is the default — picking an account is the
// opt-in, mirroring the sender-side Phase 2C-B toggle.
//
// Simple mode never sees this sheet: InboxPage keeps the plain
// confirmDestructive path there (payables/receivables only, no accounts).

import { useEffect, useMemo, useState } from 'react';
import { Modal } from './Modal';
import { Glyph } from './Glyph';
import { useAccountStore } from '../stores/accountStore';
import { formatMoney, formatSignedMoney } from '../lib/constants';
import { approxOther } from '../lib/currencyValidation';
import { currencyMeta } from '../lib/design-tokens';
import { useT } from '../lib/i18n';
import { useSubmitGuard } from '../lib/useSubmitGuard';
import type { Currency } from '../db';

export interface AcceptIntoAccountRequest {
  amount: number;
  currency: Currency;
  contactName: string;
  // Which way the money moved for ME (the acceptor): 'in' = it landed with
  // me, 'out' = it left me, 'unknown' = direction unresolvable (degraded
  // data) — ask neutrally rather than guessing a wrong preposition.
  direction: 'in' | 'out' | 'unknown';
  // Picks the warning + CTA copy: a fresh shared loan locks editing; a
  // settlement clears balance on both sides.
  flavor: 'loan' | 'settlement';
}

interface Props {
  open: boolean;
  request: AcceptIntoAccountRequest | null;
  onClose: () => void;
  // null accountId = record only (ledger-only accept). The sheet stays open
  // with a busy CTA until the promise settles; the caller closes it.
  onConfirm: (accountId: string | null) => Promise<void>;
}

export function AcceptIntoAccountSheet({ open, request, onClose, onConfirm }: Props) {
  const t = useT();
  const submitGuard = useSubmitGuard();
  const accounts = useAccountStore((s) => s.accounts);
  // '' = record only. Deliberately the default: an account effect the user
  // didn't consciously choose is worse than none.
  const [selectedId, setSelectedId] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setSelectedId('');
      setSaving(false);
    }
  }, [open]);

  const eligible = useMemo(
    () => (request ? accounts.filter((a) => a.currency === request.currency) : []),
    [accounts, request],
  );

  if (!request) return null;

  const amountText = formatMoney(request.amount, request.currency);
  const approx = approxOther(request.amount, request.currency);
  const question =
    request.direction === 'in'
      ? t('acpt_where_in')
      : request.direction === 'out'
        ? t('acpt_where_out')
        : t('acpt_where_neutral');
  const delta = request.direction === 'out' ? -request.amount : request.amount;
  const selectedAccount = eligible.find((a) => a.id === selectedId) ?? null;

  // Ref-backed entry re-check (audit F-8/D-1): the `saving` STATE flag is
  // updated asynchronously, so two taps in one frame both read it as false.
  // `saving` stays for the disabled/label UI; the ref is the real guard.
  const handleConfirm = () => submitGuard.run(runConfirm);

  const runConfirm = async () => {
    setSaving(true);
    try {
      await onConfirm(selectedId || null);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={saving ? () => {} : onClose}
      title={(request.flavor === 'settlement' ? t('confirm_settle_title') : t('confirm_accept_title'))
        .replace('{amount}', amountText)}
      footer={
        <button onClick={handleConfirm} disabled={saving} className="cta-primary">
          {saving
            ? t('ltr_accepting')
            : request.flavor === 'settlement'
              ? t('confirm_settle_cta')
              : t('ltr_accept')}
        </button>
      }
    >
      <div className="space-y-4">
        {/* The same irreversibility warning the old confirmDestructive showed,
            on a gold-tinted (heads-up) card. */}
        <div className="m-card m-gold flex items-start gap-2.5 p-3.5">
          <Glyph name="alert" size={15} tone="gold" className="mt-0.5" />
          <p className="text-[12px] text-ink-800 leading-relaxed">
            {request.flavor === 'settlement'
              ? t('confirm_settle_body')
              : t('confirm_accept_body').replace('{approx}', approx ? `${approx}. ` : '')}
          </p>
        </div>

        <div>
          <label className="form-label">{question}</label>
          <div className="space-y-2.5">
            {/* Record only — the ledger-only default. */}
            <button
              type="button"
              onClick={() => setSelectedId('')}
              aria-pressed={selectedId === ''}
              className={selectedId === '' ? 'selector-base selector-selected' : 'selector-base'}
            >
              <div className="flex items-center gap-2.5">
                <Glyph name="document" size={16} className="text-ink-600" />
                <div className="text-left">
                  <p className="text-[13px] font-semibold text-ink-800">{t('acpt_record_only')}</p>
                  <p className="text-[10.5px] text-ink-600">{t('acpt_record_only_hint')}</p>
                </div>
              </div>
            </button>
            {eligible.map((a) => {
              const meta = currencyMeta[a.currency];
              const isSelected = selectedId === a.id;
              return (
                <button
                  key={a.id}
                  type="button"
                  onClick={() => setSelectedId(a.id)}
                  aria-pressed={isSelected}
                  className={isSelected ? 'selector-base selector-selected' : 'selector-base'}
                >
                  <div className="flex items-center gap-2.5">
                    <span className="text-sm">{meta?.flag}</span>
                    <div className="text-left">
                      <p className="text-[13px] font-semibold text-ink-800">{a.name}</p>
                      <p className="text-[10.5px] text-ink-600 capitalize">{a.type.replace('_', ' ')}</p>
                    </div>
                  </div>
                  <p className="text-[13px] font-semibold text-ink-800 tabular-nums">
                    {formatSignedMoney(a.balance, a.currency)}
                  </p>
                </button>
              );
            })}
          </div>
          {eligible.length === 0 && (
            <p className="text-[11px] text-ink-600 mt-2">
              {t('acpt_no_eligible').replace('{currency}', request.currency)}
            </p>
          )}
          {selectedAccount && request.direction !== 'unknown' && (
            <p className="m-card m-gold text-[12px] text-warn-700 p-3 mt-2.5 leading-relaxed tabular-nums">
              {t('acpt_balance_effect')
                .replace('{account}', selectedAccount.name)
                .replace('{delta}', formatSignedMoney(delta, request.currency))}
            </p>
          )}
        </div>
      </div>
    </Modal>
  );
}
