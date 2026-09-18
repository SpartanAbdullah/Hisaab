import { useEffect, useMemo, useState } from 'react';
import { Glyph } from './Glyph';
import { Modal } from './Modal';
import { useToast } from './Toast';
import { useDiscardGuard } from '../lib/useDiscardGuard';
import { useSubmitGuard } from '../lib/useSubmitGuard';
import { useCommitteeStore } from '../stores/committeeStore';
import { type CommitteePatch } from '../lib/supabaseDb';
import { committeeErrorKey } from '../lib/committeeErrorText';
import { committeeEditState, isMoneyShapeEditable, poolAmount } from '../lib/committeeMath';
import { getPrimaryCurrency } from '../lib/primaryCurrency';
import { formatMoney } from '../lib/constants';
import { useT, type I18nKey } from '../lib/i18n';
import { type Currency, type Committee, type CommitteeMember, type CommitteePayment, type CommitteeCadence, type CommitteePayoutMethod } from '../db';
import { useAccountStore } from '../stores/accountStore';
import { CurrencyPicker } from './CurrencyPicker';

const EMOJI_PRESETS = ['🏘', '🏦', '👨‍👩‍👧', '🤝', '💼', '🎯', '🕌', '🎲'];

interface Props {
  open: boolean;
  onClose: () => void;
  committee: Committee;
  members: readonly CommitteeMember[];
  payments: readonly CommitteePayment[];
}

/**
 * Post-creation editing of a kameti (audit 06-user-experience UX-25).
 *
 * The fields are enabled or disabled per the matrix in
 * supabase-migration-p2-kameti-editing.sql, mirrored client-side by
 * committeeMath's `committeeEditState` / `isMoneyShapeEditable`. A disabled
 * field ALWAYS comes with the sentence saying why — a lock the organiser
 * cannot explain to their members reads as a bug, and this one is a promise:
 * once a contribution is recorded, the amount everybody agreed to stops moving.
 *
 * The server is the protection, not this component: it re-checks the same
 * matrix, and a trigger refuses the equivalent raw PostgREST write.
 */
export function EditCommitteeSheet({ open, onClose, committee, members, payments }: Props) {
  const t = useT();
  const toast = useToast();
  const guardClose = useDiscardGuard();
  const submitGuard = useSubmitGuard();
  const updateCommittee = useCommitteeStore((s) => s.updateCommittee);

  const state = committeeEditState(committee, payments);
  const moneyEditable = isMoneyShapeEditable(state);

  const [name, setName] = useState(committee.name);
  const [emoji, setEmoji] = useState(committee.emoji ?? '');
  const [notes, setNotes] = useState(committee.notes ?? '');
  const [amount, setAmount] = useState(String(committee.contributionAmount));
  const [currency, setCurrency] = useState<Currency>(committee.currency);
  // Ranks the CurrencyPicker's five inline chips from the currencies this
  // user already holds money in. accountStore is a global store that is
  // already loaded app-wide, so this subscribes to data in memory — no fetch.
  const accounts = useAccountStore((s) => s.accounts);
  const usedCurrencies = useMemo(() => [...new Set(accounts.map((a) => a.currency))], [accounts]);
  const [cadence, setCadence] = useState<CommitteeCadence>(committee.cadence);
  const [startDate, setStartDate] = useState(committee.startDate);
  const [method, setMethod] = useState<CommitteePayoutMethod>(committee.payoutMethod);
  const [completed, setCompleted] = useState(committee.status === 'completed');
  const [saving, setSaving] = useState(false);

  // Re-seed on open (and whenever the row changes underneath us, e.g. another
  // device edited it) so the sheet never shows a stale draft as the truth.
  useEffect(() => {
    if (!open) return;
    setName(committee.name);
    setEmoji(committee.emoji ?? '');
    setNotes(committee.notes ?? '');
    setAmount(String(committee.contributionAmount));
    setCurrency(committee.currency);
    setCadence(committee.cadence);
    setStartDate(committee.startDate);
    setMethod(committee.payoutMethod);
    setCompleted(committee.status === 'completed');
  }, [open, committee]);

  const amt = parseFloat(amount) || 0;

  // Only what actually changed is sent. An empty patch is refused by the RPC
  // (KAMETI_INVALID_PATCH), and sending an unchanged locked field would earn a
  // lock refusal for an edit the organiser never made.
  const patch = useMemo<CommitteePatch>(() => {
    const p: CommitteePatch = {};
    if (name.trim() && name.trim() !== committee.name) p.name = name.trim();
    const nextEmoji = emoji.trim() || null;
    if (nextEmoji !== (committee.emoji ?? null)) p.emoji = nextEmoji;
    if (notes !== (committee.notes ?? '')) p.notes = notes;
    if (completed !== (committee.status === 'completed')) p.status = completed ? 'completed' : 'active';
    if (moneyEditable) {
      if (amt > 0 && amt !== committee.contributionAmount) p.contributionAmount = amt;
      if (currency !== committee.currency) p.currency = currency;
      if (cadence !== committee.cadence) p.cadence = cadence;
      if (startDate !== committee.startDate) p.startDate = startDate;
      if (method !== committee.payoutMethod) p.payoutMethod = method;
    }
    return p;
  }, [name, emoji, notes, completed, moneyEditable, amt, currency, cadence, startDate, method, committee]);

  const isDirty = Object.keys(patch).length > 0;
  const canSave = isDirty && !!name.trim() && (!moneyEditable || amt > 0);

  const handleSave = () => submitGuard.run(runSave);

  const runSave = async () => {
    if (!canSave) return;
    setSaving(true);
    try {
      await updateCommittee(committee.id, patch);
      toast.show({ type: 'success', title: t('kameti_edit_saved') });
      onClose();
    } catch (err) {
      // The server re-checks the same matrix, so this fires whenever THIS
      // device's copy was stale — another tab recorded a payment, or ran the
      // draw, between the sheet opening and Save.
      toast.show({ type: 'error', title: t(committeeErrorKey(err)) });
    } finally {
      setSaving(false);
    }
  };

  const lockNoteKey: I18nKey =
    state === 'drawn' ? 'kameti_edit_locked_draw'
      : state === 'collecting' ? 'kameti_edit_locked_payments'
        : 'kameti_edit_open_note';

  // One padlock badge, reused next to every field the current state freezes.
  const lockBadge = !moneyEditable && (
    <span className="m-chip m-chip-neutral m-chip-caps">
      <Glyph name="lock" size={10} strokeWidth={2.6} /> {t('kameti_field_locked')}
    </span>
  );

  const lockedInput = moneyEditable ? '' : 'opacity-55';

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('kameti_edit')}
      confirmClose={() => guardClose(isDirty)}
      footer={
        <button onClick={handleSave} disabled={saving || !canSave} className="cta-primary">
          {t('cat_save')}
        </button>
      }
    >
      <div className="space-y-4">
        {/* Why this state locks what it locks. Shown in EVERY state — in the
            open one it is a warning that the window is about to close. */}
        <div className={`m-card flex items-start gap-2.5 p-3.5 ${moneyEditable ? 'm-gold' : ''}`}>
          <Glyph name="lock" size={15} tone={moneyEditable ? 'gold' : 'neutral'} className="mt-0.5" />
          <p className="text-[11.5px] text-ink-700 leading-relaxed">{t(lockNoteKey)}</p>
        </div>

        <div>
          <label className="form-label">{t('kameti_name')}</label>
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} className="input-field" />
        </div>

        <div>
          <label className="form-label">{t('kameti_emoji')}</label>
          <div className="flex flex-wrap gap-2.5">
            {EMOJI_PRESETS.map((e) => (
              <button
                key={e}
                type="button"
                onClick={() => setEmoji(emoji === e ? '' : e)}
                aria-pressed={emoji === e}
                className={`m-tile w-11 h-11 rounded-[12px] text-[18px] flex items-center justify-center ${emoji === e ? 'm-gold m-tile-selected' : ''}`}
              >
                {e}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className="form-label">{t('kameti_notes')}</label>
          <input value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={500}
            placeholder={t('kameti_notes_ph')} className="input-field" />
        </div>

        <div>
          <label className="form-label flex items-center gap-2">{t('kameti_amount')} {lockBadge}</label>
          <input
            type="number" step="0.01" inputMode="decimal" value={amount} disabled={!moneyEditable}
            onChange={(e) => setAmount(e.target.value)}
            className={`input-field text-center font-semibold tabular-nums ${lockedInput}`}
            // Inline on purpose: index.css pins every <input> to 16px (iOS
            // focus-zoom guard), which beats any font-size utility.
            style={{ fontSize: 20, letterSpacing: '-0.02em' }}
          />
          {amt > 0 && (
            <p className="text-[11px] text-ink-500 mt-1.5 text-center">
              {t('kameti_pool')}: <span className="font-semibold text-ink-800 tabular-nums">{formatMoney(poolAmount(amt, committee.memberCount), currency)}</span>
              {' · '}{members.length} {t('kameti_members').toLowerCase()}
            </p>
          )}
        </div>

        <div>
          <label className="form-label flex items-center gap-2">{t('common_currency')} {lockBadge}</label>
          <div className={lockedInput}>
            <CurrencyPicker
              value={currency}
              onChange={setCurrency}
              primary={getPrimaryCurrency()}
              used={usedCurrencies}
              disabled={!moneyEditable}
            />
          </div>
        </div>

        <div>
          <label className="form-label flex items-center gap-2">{t('kameti_cadence')} {lockBadge}</label>
          <div className={`grid grid-cols-3 gap-2 ${lockedInput}`}>
            {([['daily', 'kameti_cadence_daily'], ['weekly', 'kameti_cadence_weekly'], ['monthly', 'kameti_cadence_monthly']] as const).map(([c, key]) => (
              <button key={c} type="button" disabled={!moneyEditable} onClick={() => setCadence(c)}
                aria-pressed={cadence === c}
                className="m-pill m-pill-gold min-h-[44px] w-full text-[12.5px]">
                {t(key)}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className="form-label flex items-center gap-2">{t('kameti_start_date')} {lockBadge}</label>
          <input type="date" value={startDate} disabled={!moneyEditable}
            onChange={(e) => setStartDate(e.target.value)} className={`input-field ${lockedInput}`} />
        </div>

        <div>
          <label className="form-label flex items-center gap-2">{t('kameti_method')} {lockBadge}</label>
          <div className={`space-y-2.5 ${lockedInput}`}>
            {([['fixed', 'kameti_method_fixed', 'kameti_method_fixed_desc'], ['ballot', 'kameti_method_ballot', 'kameti_method_ballot_desc']] as const).map(([m, label, desc]) => (
              <button key={m} type="button" disabled={!moneyEditable} onClick={() => setMethod(m)}
                aria-pressed={method === m}
                className={`w-full text-left gap-3 ${method === m ? 'selector-base selector-selected' : 'selector-base'}`}>
                <span className="flex flex-col gap-0.5 min-w-0">
                  <span className="text-[13.5px] font-semibold text-ink-900">{t(label)}</span>
                  <span className="text-[11.5px] text-ink-600">{t(desc)}</span>
                </span>
                {method === m && <Glyph name="check" size={16} tone="gold" strokeWidth={3} />}
              </button>
            ))}
          </div>
          {/* Switching to ballot clears the hand-picked order — the server does
              the documented two-step atomically, but the organiser must know
              the order they typed is about to be thrown away. */}
          {moneyEditable && method === 'ballot' && committee.payoutMethod === 'fixed' && (
            <p className="text-[11px] text-pay-text mt-2 leading-relaxed">{t('kameti_err_ballot_switch_needs_clear_slots')}</p>
          )}
        </div>

        {/* Lifecycle, not money math: never locked. Marking a kameti finished
            is also what silences its round reminders. */}
        <div className="m-card p-3.5 flex items-center justify-between gap-3">
          <span className="min-w-0">
            <label htmlFor="kameti-mark-completed" className="block text-[13px] font-semibold text-ink-900">
              {t('kameti_status_completed')}
            </label>
            <span className="block text-[11px] text-ink-600 leading-relaxed mt-0.5">{t('kameti_status_completed_note')}</span>
          </span>
          <button
            id="kameti-mark-completed" type="button" role="switch" aria-checked={completed}
            onClick={() => setCompleted(!completed)}
            className="m-switch"
          />
        </div>
      </div>
    </Modal>
  );
}
