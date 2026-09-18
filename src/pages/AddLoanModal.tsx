import { useEffect, useMemo, useState } from 'react';
import { Modal } from '../components/Modal';
import { Glyph } from '../components/Glyph';
import { useDiscardGuard } from '../lib/useDiscardGuard';
import { useSubmitGuard, useSubmitIntentId } from '../lib/useSubmitGuard';
import { useAccountStore } from '../stores/accountStore';
import { useTransactionStore, loanScheduleAlreadyCreated } from '../stores/transactionStore';
import { useEmiStore } from '../stores/emiStore';
import { useLoanStore } from '../stores/loanStore';
import { usePersonStore } from '../stores/personStore';
import { useLinkedRequestStore } from '../stores/linkedRequestStore';
import { useAppModeStore } from '../stores/appModeStore';
import { ContactPicker, type ContactValue } from '../components/ContactPicker';
import { useToast } from '../components/Toast';
import { AccountSelect } from '../components/AccountSelect';
import { ShareKhataLinkSheet } from '../components/ShareKhataLinkSheet';
import { useT } from '../lib/i18n';
import { decideLinkedBranch } from '../lib/linkedRequestBranch';
import { confirmCrossUserRequest } from '../lib/confirmCrossUserRequest';
import { getPrimaryCurrency } from '../lib/primaryCurrency';
import { planEmiRows } from '../lib/emiPlan';
import { track } from '../lib/telemetry';
import { shouldOfferKhataShareNudge, snoozeKhataShareNudge } from '../lib/khataLinkStatus';
import { type Currency, type LoanType, type Person } from '../db';
import { CurrencyPicker } from '../components/CurrencyPicker';

interface Props { open: boolean; onClose: () => void; }

export function AddLoanModal({ open, onClose }: Props) {
  const { accounts, loadAccounts } = useAccountStore();
  const { processTransaction } = useTransactionStore();
  const { generateSchedule } = useEmiStore();
  const { loans, createLoan } = useLoanStore();
  const appMode = useAppModeStore((s) => s.mode);
  const isLedgerOnlyMode = appMode === 'splits_only';
  const toast = useToast();
  const t = useT();
  const guardClose = useDiscardGuard();
  const submitGuard = useSubmitGuard();

  const [loanType, setLoanType] = useState<LoanType>('given');
  const [contact, setContact] = useState<ContactValue>({ id: null, name: '' });
  const [amount, setAmount] = useState('');
  const [accountId, setAccountId] = useState('');
  // UX-34: one helper, one fallback. See src/lib/primaryCurrency.ts.
  const [ledgerCurrency, setLedgerCurrency] = useState<Currency>(getPrimaryCurrency);
  // Ranks the CurrencyPicker's five inline chips. accounts/loans are already
  // subscribed above — this is a map over data in memory, never a fetch.
  const usedCurrencies = useMemo(
    () => [...new Set([...accounts.map(a => a.currency), ...loans.map(l => l.currency)])],
    [accounts, loans],
  );
  const [cashAdvanceSourceId, setCashAdvanceSourceId] = useState('');
  const [notes, setNotes] = useState('');
  const [hasEmi, setHasEmi] = useState(false);
  const [installments, setInstallments] = useState('');
  const [startDate, setStartDate] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  // L2 share-at-save nudge (audit 2026-09 P3): offered at most once every 14
  // days per person, from any of the three save paths below.
  const [khataNudge, setKhataNudge] = useState<{ personId: string; personName: string; phone: string | null } | null>(null);

  void loans;

  const offerKhataNudge = (recipient: Pick<Person, 'id' | 'name' | 'phone'>) => {
    if (!shouldOfferKhataShareNudge(recipient.id)) return;
    snoozeKhataShareNudge(recipient.id);
    toast.show({
      type: 'info',
      title: t('khata_nudge_toast_title').replace('{name}', recipient.name),
      action: {
        label: t('khata_nudge_toast_action'),
        onPress: () => setKhataNudge({ personId: recipient.id, personName: recipient.name, phone: recipient.phone ?? null }),
      },
    });
  };

  useEffect(() => {
    if (open && !isLedgerOnlyMode) {
      void loadAccounts();
    }
  }, [isLedgerOnlyMode, open, loadAccounts]);

  const destinationAccount = accounts.find((account) => account.id === accountId);
  const availableCashAdvanceCards = accounts.filter((account) => (
    account.type === 'credit_card' &&
    account.id !== accountId &&
    (!destinationAccount || account.currency === destinationAccount.currency)
  ));
  // Phase 2B: detect if the current form state will branch into a linked
  // request. Used purely to swap the CTA label and show an inline hint.
  const personInStore = contact.id
    ? usePersonStore.getState().persons.find((p) => p.id === contact.id) ?? null
    : null;
  const selectedAccount = accounts.find((a) => a.id === accountId);
  const requestCurrency = isLedgerOnlyMode ? ledgerCurrency : selectedAccount?.currency;
  const wouldBranchToLinked = !!(
    personInStore?.linkedProfileId &&
    requestCurrency
  );

  // UX-12 (audit 2026-09): the EMI section is NOT available on the linked
  // branch. That branch creates no loan on this device — accept_linked_request
  // mints the loan rows on both sides only when the counterparty confirms — so
  // there is nothing for generateSchedule() to attach a schedule to, and
  // linked_transaction_requests has no instalment columns to carry one across
  // (supabase-migration-phase2b-linked-requests.sql:7-26). The old code left
  // the section visible AND required here and then `return`ed before any
  // schedule generation: a user could configure 12 instalments, tap send, and
  // end up with no schedule on either side and no warning. We hide it and say
  // why instead. The typed values are parked, not cleared, so flipping back to
  // an unlinked contact restores them.
  const emiAvailable = !wouldBranchToLinked;
  const emiActive = hasEmi && emiAvailable;

  // Disable-until-valid: a positive amount, a name, an account (when tracking),
  // and — if an EMI plan is toggled on AND reachable — both EMI fields, so the
  // user can't think they set up instalments and silently get none.
  const parsedAmount = parseFloat(amount);
  const amountValid = Number.isFinite(parsedAmount) && parsedAmount > 0;
  const emiConfigured = !emiActive || (parseInt(installments) > 0 && !!startDate);
  const canSubmit = !!contact.name.trim() && amountValid && (isLedgerOnlyMode || !!accountId) && emiConfigured;
  const isDirty = !!contact.name.trim() || !!amount.trim() || !!notes.trim() || hasEmi;

  // One request id per submit intent: the same id survives a double tap and a
  // retry of an unchanged form (so a duplicate insert collides on the primary
  // key instead of mirroring a second debt onto the other user), and is
  // replaced the instant any field — or the modal's open state — changes.
  const nextRequestId = useSubmitIntentId(
    [open, loanType, contact.id ?? '', contact.name.trim(), amount, notes, accountId, ledgerCurrency].join('|'),
  );

  // Entry re-check lives in submitGuard (a ref, so two taps in one frame can't
  // both pass); `saving` stays purely for the disabled/label UI.
  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    return submitGuard.run(runSubmit);
  };

  const runSubmit = async () => {
    setError('');
    const amt = parseFloat(amount);
    const trimmedName = contact.name.trim();
    if (!amountValid) { setError(t('val_need_amount')); return; }
    if (!trimmedName) { setError(t('val_need_name')); return; }
    if (!isLedgerOnlyMode && !accountId) { setError(t('val_pick_account')); return; }
    if (!emiConfigured) { setError(t('val_emi_incomplete')); return; }
    setSaving(true);
    try {
      const person = contact.id
        ? await ensureResolvedPerson(trimmedName, contact.id)
        : await usePersonStore.getState().findOrCreateByName(trimmedName);

      const txType = loanType === 'given' ? 'loan_given' : 'loan_taken';
      const branch = decideLinkedBranch({
        type: txType,
        person,
        requestCurrency,
      });

      if (branch.branch === true) {
        // Backstop for UX-12. `wouldBranchToLinked` (which drives whether the
        // EMI section renders) is a UI-level approximation of this decision:
        // it reads only the person already in the store and ignores
        // archivedAt, so a typed name that resolves to a linked person can
        // land here with hasEmi still true. Refuse loudly rather than drop the
        // plan — the same rule as the section-level hide above.
        if (hasEmi) { setError(t('ltr_emi_unavailable_body')); return; }
        // Deliberate confirm before mirroring a currency-locked record to them.
        const guard = await confirmCrossUserRequest({ amount: amt, currency: branch.currency, personName: person.name });
        if (guard.blockedReason) { setError(guard.blockedReason); return; }
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
        track('loan_created', {
          direction: loanType,
          linked_contact: true,
          has_schedule: false,
          currency: branch.currency,
          mode: isLedgerOnlyMode ? 'splits_only' : 'full_tracker',
        });
        toast.show({ type: 'success', title: t('ltr_sent_title'), subtitle: t('ltr_sent_subtitle') });
        offerKhataNudge(person);
        setContact({ id: null, name: '' }); setAmount(''); setAccountId(''); setCashAdvanceSourceId(''); setNotes('');
        setHasEmi(false); setInstallments(''); setStartDate('');
        onClose();
        return;
      }

      if (isLedgerOnlyMode) {
        const loan = await createLoan({
          personName: person.name,
          personId: person.id,
          type: loanType,
          totalAmount: amt,
          currency: ledgerCurrency,
          notes,
        });
        const scheduled = emiActive && !!installments && !!startDate;
        if (scheduled) {
          await generateSchedule({ loanId: loan.id, totalAmount: amt, installments: parseInt(installments), startDate });
        }
        track('loan_created', {
          direction: loanType,
          linked_contact: false,
          has_schedule: scheduled,
          currency: ledgerCurrency,
          mode: 'splits_only',
        });
        offerKhataNudge(person);
        setContact({ id: null, name: '' }); setAmount(''); setAccountId(''); setCashAdvanceSourceId(''); setNotes('');
        setHasEmi(false); setInstallments(''); setStartDate('');
        onClose();
        return;
      }

      // L4 step 3: plan the instalments BEFORE the money call, so they can ride
      // into `create_loan_with_leg` and be inserted in the same Postgres
      // transaction as the loan. `planEmiRows` is the same arithmetic
      // generateSchedule runs (src/lib/emiPlan.ts) — with the flag off the
      // store ignores this field and the call below still does the writing.
      const wantsSchedule = emiActive && !!installments && !!startDate;
      const emiPlan = wantsSchedule
        ? planEmiRows({ totalAmount: amt, installments: parseInt(installments), startDate })
        : null;

      const tx = await processTransaction(
        loanType === 'given'
          ? { type: 'loan_given', amount: amt, sourceAccountId: accountId, personName: person.name, personId: person.id, notes, emiPlan }
          : {
              type: 'loan_taken',
              amount: amt,
              destinationAccountId: accountId,
              sourceAccountId: cashAdvanceSourceId || undefined,
              personName: person.name,
              personId: person.id,
              notes,
              emiPlan,
            }
      );
      const scheduled = emiActive && !!tx.relatedLoanId && !!installments && !!startDate;
      // Skip only when the schedule provably already landed inside the creation
      // itself. Anything else — the flag off, a plan the store declined to
      // forward — still generates it here, exactly as it always has.
      if (scheduled && !loanScheduleAlreadyCreated(tx.relatedLoanId)) {
        await generateSchedule({ loanId: tx.relatedLoanId!, totalAmount: amt, installments: parseInt(installments), startDate });
      }
      track('loan_created', {
        direction: loanType,
        linked_contact: false,
        has_schedule: scheduled,
        currency: destinationAccount?.currency ?? ledgerCurrency,
        mode: 'full_tracker',
      });
      offerKhataNudge(person);
      setContact({ id: null, name: '' }); setAmount(''); setAccountId(''); setCashAdvanceSourceId(''); setNotes('');
      setHasEmi(false); setInstallments(''); setStartDate('');
      onClose();
    } catch (err) { setError(err instanceof Error ? err.message : t('ltr_create_error')); }
    finally { setSaving(false); }
  };

  // Fetch the full Person row (needed for linkedProfileId when the contact
  // was picked from the ContactPicker dropdown rather than typed fresh).
  async function ensureResolvedPerson(name: string, id: string) {
    const existing = usePersonStore.getState().persons.find((p) => p.id === id);
    if (existing) return existing;
    return usePersonStore.getState().findOrCreateByName(name);
  }

  return (
    <>
    <Modal open={open} onClose={onClose} title={t('loan_new')}
      confirmClose={() => guardClose(isDirty)}
      footer={
        <button type="submit" form="loan-form" disabled={saving || !canSubmit}
          className="cta-primary"
        >{saving ? t('loan_creating') : wouldBranchToLinked ? t('ltr_branch_cta') : t('loan_create')}</button>
      }
    >
      <form id="loan-form" onSubmit={handleSubmit} className="space-y-4">
        {/* Direction: toned pills like the Loans tabs — "I gave" is money
            owed to you (green), "I took" is money you owe (coral). Tinted at
            rest, solid when chosen. */}
        <div className="flex gap-2.5">
          {(['given', 'taken'] as const).map(tp => (
            <button key={tp} type="button" onClick={() => setLoanType(tp)}
              aria-pressed={loanType === tp}
              className={`m-pill ${tp === 'given' ? 'm-pill-receive' : 'm-pill-pay'} flex-1 min-h-[44px] text-[13px]`}
            >{tp === 'given' ? t('loan_i_gave') : t('loan_i_took')}</button>
          ))}
        </div>

        <div>
          <label className="form-label">{t('loan_to_whom')}</label>
          <ContactPicker value={contact} onChange={setContact} placeholder={t('quick_who_placeholder')} required className="input-field" />
          {wouldBranchToLinked ? (
            <p className="text-[11px] text-iris-text mt-1.5">{t('ltr_branch_helper')}</p>
          ) : (
            <p className="text-[11px] text-ink-600 mt-1.5">{t('ltr_linked_only_helper')}</p>
          )}
        </div>

        <div>
          <label className="form-label">{t('amount_label')}</label>
          <input type="number" step="0.01" value={amount} onChange={e => setAmount(e.target.value)} placeholder="0.00"
            className="input-field text-center font-semibold tabular-nums tracking-[-0.02em]"
            // Inline on purpose: index.css pins every <input> to 16px (iOS
            // focus-zoom guard), which beats any font-size utility.
            style={{ fontSize: 22 }}
            required />
        </div>

        {isLedgerOnlyMode ? (
          <div>
            <label className="form-label">{t('onboard_currency_label')}</label>
            <CurrencyPicker
              value={ledgerCurrency}
              onChange={setLedgerCurrency}
              primary={getPrimaryCurrency()}
              used={usedCurrencies}
            />
          </div>
        ) : (
          <div>
            <label className="form-label">{loanType === 'given' ? t('loan_paid_from') : t('loan_received_into')}</label>
            <AccountSelect accounts={accounts} selectedId={accountId} onSelect={setAccountId} />
          </div>
        )}

        {!isLedgerOnlyMode && loanType === 'taken' && availableCashAdvanceCards.length > 0 && (
          <div>
            <label className="form-label">{t('cash_advance_source')}</label>
            <div className="space-y-2.5">
              <button
                type="button"
                onClick={() => setCashAdvanceSourceId('')}
                aria-pressed={!cashAdvanceSourceId}
                className={`selector-base text-[12px] font-semibold ${
                  !cashAdvanceSourceId ? 'selector-selected text-accent-text' : 'text-ink-600'
                }`}
              >
                {t('cash_advance_none')}
              </button>
              {availableCashAdvanceCards.map(a => (
                <button key={a.id} type="button" onClick={() => setCashAdvanceSourceId(a.id)}
                  aria-pressed={cashAdvanceSourceId === a.id}
                  className={`selector-base ${cashAdvanceSourceId === a.id ? 'selector-selected' : ''}`}
                >
                  <span className="text-[13px] font-semibold text-ink-800 flex items-center gap-2">
                    <Glyph name="card" size={15} tone="blue" />
                    {a.name}
                  </span>
                  <span className="text-[12px] text-ink-600 tabular-nums">{a.currency}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        <div>
          <label className="form-label">{t('quick_note')}</label>
          <input value={notes} onChange={e => setNotes(e.target.value)} placeholder={t('quick_note_placeholder')} className="input-field" />
        </div>

        <p className="m-inset text-[12px] text-ink-600 p-3 leading-relaxed">
          {t('money_not_moved_notice')}
        </p>

        {/* UX-12: the qist/EMI section only exists on the paths that actually
            create a loan row here. On the linked branch it is replaced by an
            explanation — never rendered-then-ignored. */}
        {emiAvailable ? (
          <>
            {/* The whole row is the switch (role="switch"): the label is its
                accessible name and the full row is the tap target. */}
            <button
              type="button"
              role="switch"
              aria-checked={hasEmi}
              onClick={() => setHasEmi((v) => !v)}
              className="m-card w-full flex items-center gap-3 px-4 py-3 text-left"
            >
              <span className="text-[13px] text-ink-800 font-medium flex-1">{t('loan_set_emi')}</span>
              <span aria-hidden className={`m-switch block ${hasEmi ? 'is-on' : ''}`} />
            </button>

            {hasEmi && (
              <div className="grid grid-cols-2 gap-3 animate-fade-in">
                <div>
                  <label className="form-label">{t('loan_installments')}</label>
                  <input type="number" value={installments} onChange={e => setInstallments(e.target.value)} placeholder="12" className="input-field" required />
                </div>
                <div>
                  <label className="form-label">{t('kameti_start_date')}</label>
                  <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} className="input-field" required />
                </div>
              </div>
            )}
            {hasEmi && !emiConfigured && (
              <p className="text-[11px] text-warn-700 -mt-1.5">{t('val_emi_incomplete')}</p>
            )}
          </>
        ) : (
          <div className="m-inset p-3">
            <p className="text-[12px] font-semibold text-ink-800 leading-snug">{t('ltr_emi_unavailable_title')}</p>
            <p className="text-[11px] text-ink-600 mt-1 leading-relaxed">{t('ltr_emi_unavailable_body')}</p>
            {hasEmi && (
              // The user HAD configured a plan before the contact turned out to
              // be linked. Say so — the values are kept, not thrown away.
              <p className="text-[11px] text-warn-700 font-semibold mt-2 leading-relaxed">
                {t('ltr_emi_kept_warning')}
              </p>
            )}
          </div>
        )}

        {/* Glanceable confirm/private chip near the Save CTA — mirrors
            QuickEntry's loan helper. Linked contacts get a confirm request
            (violet, the linked colour); everyone else stays a private
            local-only record (a quiet recessed note). */}
        {wouldBranchToLinked ? (
          <div className="m-card m-violet flex items-center gap-2 px-3 py-2.5">
            <Glyph name="link" size={14} tone="violet" />
            <p className="text-[11px] font-semibold text-iris-text leading-snug">
              {t('loan_will_confirm').replace('{name}', contact.name.trim() || t('loan_they'))}
            </p>
          </div>
        ) : (
          <div className="m-inset flex items-center gap-2 px-3 py-2.5">
            <Glyph name="lock" size={14} className="text-ink-500" />
            <p className="text-[11px] font-semibold text-ink-600 leading-snug">
              {t('loan_private')}
            </p>
          </div>
        )}

        {error && <p className="text-[12px] text-pay-text font-semibold bg-pay-50 rounded-xl p-3">{error}</p>}
      </form>
    </Modal>
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
