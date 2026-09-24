import { useEffect, useMemo, useState } from 'react';
import { Modal } from '../components/Modal';
import { confirmDestructive } from '../components/ConfirmDestructiveSheet';
import { SettlementAccountChoice, landingAccountId } from '../components/SettlementAccountChoice';
import { useSettlementRequestStore } from '../stores/settlementRequestStore';
import { useLinkedRequestStore } from '../stores/linkedRequestStore';
import { usePersonStore } from '../stores/personStore';
import { useAccountStore } from '../stores/accountStore';
import { useAppModeStore } from '../stores/appModeStore';
import { useSupabaseAuthStore } from '../stores/supabaseAuthStore';
import { useToast } from '../components/Toast';
import { formatMoney } from '../lib/constants';
import { useT } from '../lib/i18n';
import { useSubmitGuard, useSubmitIntentId } from '../lib/useSubmitGuard';
import { resolveSettlementSides } from '../lib/settlementSides';
import { friendlyLinkedError, isFriendlyLinkedError } from '../lib/linkedErrorMap';
import { lastSettlementAccountId, possibleDuplicateClaim } from '../lib/settlementStatus';
import { buildWhatsAppUrl } from '../lib/whatsappReminder';
import type { Loan } from '../db';

interface Props {
  open: boolean;
  onClose: () => void;
  loan: Loan;
}

function errorText(err: unknown): string {
  if (err instanceof Error) return friendlyLinkedError(err.message);
  if (typeof err === 'string') return friendlyLinkedError(err);
  return '';
}

// A repayment on ONE linked loan. Two paths, by who received the money
// (the 2026-09-24 settlement model):
//   · my loan is GIVEN — they paid ME: I record it and both ledgers update at
//     once (record_received_repayment). They are only notified; Undo for 10
//     minutes.
//   · my loan is TAKEN — I paid THEM: it goes to them to confirm (their
//     receivable is at stake), exactly as before.
// Either way, Full Tracker asks where the money went — never a silent
// "record only" default.
export function SettleLinkedLoanModal({ open, onClose, loan }: Props) {
  const createRequest = useSettlementRequestStore((s) => s.createRequest);
  const recordReceived = useSettlementRequestStore((s) => s.recordReceived);
  const acceptSettlement = useSettlementRequestStore((s) => s.accept);
  const undoRecord = useSettlementRequestStore((s) => s.undo);
  const settlementRequests = useSettlementRequestStore((s) => s.requests);
  const linkedRequests = useLinkedRequestStore((s) => s.requests);
  const persons = usePersonStore((s) => s.persons);
  const { accounts, loadAccounts } = useAccountStore();
  const appMode = useAppModeStore((s) => s.mode);
  const currentUserId = useSupabaseAuthStore((s) => s.user?.id ?? '');
  const toast = useToast();
  const t = useT();
  const submitGuard = useSubmitGuard();

  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  // '' = not chosen · RECORD_ONLY · an account id (SettlementAccountChoice).
  const [landing, setLanding] = useState('');
  const isGiven = loan.type === 'given';
  const fullTracker = appMode === 'full_tracker';

  useEffect(() => {
    if (open) {
      // Prefill with the full remaining by default; user can reduce for partial.
      setAmount(String(loan.remainingAmount));
      setNote('');
      setError('');
      setLanding('');
      if (fullTracker) void loadAccounts();
    }
  }, [fullTracker, open, loan.remainingAmount, loadAccounts]);

  const person = loan.personId ? persons.find((x) => x.id === loan.personId) : undefined;
  const counterpartyName = person?.name || loan.personName || t('ltr_unknown_person');

  // Resolve the accepted linked pair + settlement side mapping via the shared
  // helper (same one the bulk settlement path uses, so they can't drift).
  const sides = resolveSettlementSides(loan.id, linkedRequests);

  const preferredAccountId = useMemo(
    () => lastSettlementAccountId(settlementRequests, currentUserId, sides?.toUserId),
    [settlementRequests, currentUserId, sides?.toUserId],
  );

  const canSubmit = (() => {
    const amt = parseFloat(amount);
    if (!Number.isFinite(amt) || amt <= 0) return false;
    if (amt - loan.remainingAmount > 0.00001) return false;
    if (!sides) return false;
    // Full Tracker: an account OR an explicit "record only" is required.
    if (fullTracker && !landing) return false;
    return true;
  })();

  // Ref-backed entry re-check: `saving` state can't stop two taps that land in
  // the same frame. `saving` stays for the disabled/label UI.
  const handleSubmit = () => submitGuard.run(runSubmit);

  // One request id per submit intent — a double tap or an unchanged retry
  // reuses it, so the duplicate insert collides on the primary key instead of
  // queueing a second settlement (or a second record).
  const nextRequestId = useSubmitIntentId([open, loan.id, amount, note, landing].join('|'));

  const showError = (err: unknown, headline: string) => {
    console.error('linked settlement failed', err);
    // An already-localized failure (e.g. the database hasn't taken
    // supabase-migration-audit-p0-currencies.sql yet and rejected the
    // currency) reads as its own sentence — don't bracket it behind the
    // generic headline.
    if (isFriendlyLinkedError(err)) { setError(err.message); return; }
    const detail = errorText(err);
    setError(detail ? `${headline} (${detail})` : headline);
  };

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
    const money = formatMoney(amt, loan.currency);
    const accountId = fullTracker ? landingAccountId(landing) : null;
    const account = accountId ? accounts.find((a) => a.id === accountId) : undefined;
    const landingLine = !fullTracker
      ? ''
      : account
        ? t(isGiven ? 'stl_confirm_lands' : 'stl_confirm_leaves').replace('{amount}', money).replace('{account}', account.name)
        : t('stl_confirm_record_only');

    if (isGiven) {
      // ── They paid me: record it now. First, is this money already on its
      // way in? A pending claim from them for the same amount should be
      // confirmed instead of recorded twice.
      const dup = possibleDuplicateClaim(settlementRequests, {
        loanPairId: sides.loanPairId,
        amount: amt,
        myUserId: currentUserId,
        nowMs: Date.now(),
      });
      if (dup?.kind === 'their_pending_claim') {
        const confirmTheirs = await confirmDestructive({
          title: t('stl_dup_their_claim_title')
            .replace('{name}', counterpartyName)
            .replace('{amount}', formatMoney(dup.request.amount, dup.request.currency)),
          description: t('stl_dup_their_claim_body'),
          confirmLabel: t('stl_dup_confirm_theirs'),
          cancelLabel: t('cancel'),
          tone: 'warning',
        });
        if (!confirmTheirs) return;
        setSaving(true);
        setError('');
        try {
          await acceptSettlement(dup.request.id, accountId);
          toast.show({
            type: 'success',
            title: t('stl_recorded_title'),
            subtitle: t('stl_recorded_subtitle').replace('{name}', counterpartyName),
          });
          onClose();
        } catch (err) {
          showError(err, t('stl_accept_error'));
        } finally {
          setSaving(false);
        }
        return;
      }
      if (dup?.kind === 'already_recorded') {
        const when = new Date(dup.request.respondedAt ?? dup.request.createdAt)
          .toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
        const different = await confirmDestructive({
          title: t('stl_dup_already_title')
            .replace('{amount}', formatMoney(dup.request.amount, dup.request.currency))
            .replace('{date}', when),
          description: t('stl_dup_already_body'),
          confirmLabel: t('stl_dup_different'),
          cancelLabel: t('stl_dup_same_stop'),
          tone: 'warning',
        });
        if (!different) return;
      }

      const ok = await confirmDestructive({
        title: t('stl_record_confirm_title').replace('{amount}', money),
        description: [
          t('stl_record_confirm_body').replace('{name}', counterpartyName).replace('{amount}', money),
          landingLine,
        ].filter(Boolean).join(' '),
        confirmLabel: t('stl_record_cta'),
        cancelLabel: t('cancel'),
        tone: 'warning',
      });
      if (!ok) return;

      setSaving(true);
      setError('');
      try {
        const row = await recordReceived({
          loanPairId: sides.loanPairId,
          requesterLoanId: sides.requesterLoanId,
          responderLoanId: sides.responderLoanId,
          toUserId: sides.toUserId,
          amount: amt,
          currency: loan.currency,
          note,
          requesterAccountId: accountId,
          requestId: nextRequestId(),
        });
        toast.show({
          type: 'success',
          title: t('stl_recorded_title'),
          subtitle: t('stl_recorded_subtitle').replace('{name}', counterpartyName),
          action: {
            label: t('stl_undo'),
            onPress: () => {
              undoRecord(row.id)
                .then(() => toast.show({ type: 'info', title: t('stl_undone_title') }))
                .catch((err: unknown) =>
                  toast.show({ type: 'error', title: t('error'), subtitle: errorText(err) || t('toast_error_generic') }));
            },
          },
        });
        onClose();
      } catch (err) {
        showError(err, t('stl_create_error'));
      } finally {
        setSaving(false);
      }
      return;
    }

    // ── I paid them: their receivable is at stake, so they confirm.
    const ok = await confirmDestructive({
      title: t('stl_confirm_title'),
      description: [t('stl_confirm_body').replace('{amount}', money), landingLine].filter(Boolean).join(' '),
      confirmLabel: t('stl_confirm_cta'),
      cancelLabel: t('cancel'),
      tone: 'warning',
    });
    if (!ok) return;

    setSaving(true);
    setError('');
    try {
      await createRequest({
        loanPairId: sides.loanPairId,
        requesterLoanId: sides.requesterLoanId,
        responderLoanId: sides.responderLoanId,
        toUserId: sides.toUserId,
        amount: amt,
        currency: loan.currency,
        note,
        requesterAccountId: accountId,
        requestId: nextRequestId(),
      });
      // A web counterparty gets no push — one tap tells them on WhatsApp.
      const text = t('req_remind_settlement').replace('{name}', counterpartyName).replace('{amount}', money);
      toast.show({
        type: 'success',
        title: t('stl_sent_title'),
        subtitle: t('stl_sent_subtitle'),
        action: {
          label: t('stl_tell_whatsapp').replace('{name}', counterpartyName),
          onPress: () => { window.open(buildWhatsAppUrl(person?.phone ?? null, text), '_blank', 'noopener,noreferrer'); },
        },
      });
      onClose();
    } catch (err) {
      showError(err, t('stl_create_error'));
    } finally {
      setSaving(false);
    }
  };

  const submitLabel = saving
    ? (isGiven ? t('stl_recording') : t('stl_sending'))
    : (isGiven ? t('stl_record_cta') : t('stl_send'));

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={isGiven
        ? t('stl_record_title').replace('{name}', counterpartyName)
        : t('stl_title').replace('{name}', counterpartyName)}
      footer={
        <button
          onClick={handleSubmit}
          disabled={saving || !canSubmit}
          className="cta-primary"
        >
          {submitLabel}
        </button>
      }
    >
      <div className="space-y-4">
        {/* What this does, on the violet every linked surface wears. */}
        <div className="m-card m-violet p-3.5">
          <p className="text-[13px] text-ink-800 leading-relaxed">
            {isGiven
              ? t('stl_record_intro').split('{name}').join(counterpartyName)
              : t('stl_direction_paying_to')
                .replace('{name}', counterpartyName)
                .replace('{amount}', formatMoney(parseFloat(amount) || 0, loan.currency))}
          </p>
        </div>

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

        {/* Where the money went — asked every time in Full Tracker. */}
        {fullTracker && (
          <SettlementAccountChoice
            direction={isGiven ? 'given' : 'taken'}
            currency={loan.currency}
            accounts={accounts}
            value={landing}
            onChange={setLanding}
            preferredAccountId={preferredAccountId}
          />
        )}

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
