import { useEffect, useState } from 'react';
import { Modal } from '../components/Modal';
import { Glyph } from '../components/Glyph';
import { useDiscardGuard } from '../lib/useDiscardGuard';
import { useSubmitGuard } from '../lib/useSubmitGuard';
import { useSplitStore } from '../stores/splitStore';
import { useAccountStore } from '../stores/accountStore';
import { useAppModeStore } from '../stores/appModeStore';
import { useTransactionStore } from '../stores/transactionStore';
import { useLoanStore } from '../stores/loanStore';
import { useToast } from '../components/Toast';
import { useT } from '../lib/i18n';
import { formatMoney } from '../lib/constants';
import { track } from '../lib/telemetry';
import { bucketAmount, bucketCount } from '../lib/telemetryEvents';
import type { SplitGroup, SplitType, SplitDetail } from '../db';
import {
  friendlyGroupParticipantError,
  getActiveGroupMembers,
  getInactiveGroupMembers,
  NEED_TWO_ACTIVE_MEMBERS_MESSAGE,
} from '../lib/groupActiveMembers';
import { isGuestMember } from '../lib/groupGuests';
import { computeShares } from '../lib/splitMath';
import { SHARE_ERROR_KEYS } from '../lib/shareErrors';
import { findRecentDuplicate } from '../lib/duplicateExpense';
import { confirmDestructive } from '../components/ConfirmDestructiveSheet';
import { AccountSelect } from '../components/AccountSelect';

interface Props {
  open: boolean;
  group: SplitGroup;
  onClose: () => void;
  // When opened via the QuickEntry "Group expense" flow we already know
  // the amount the user typed on the numpad. Pre-fill it so they don't
  // re-enter; null/undefined keeps the existing "empty form" behaviour
  // for the GroupDetailPage entry point.
  prefillAmount?: string;
  // Recent group expenses (passed by GroupDetailPage) used to warn on a likely
  // duplicate — e.g. both flatmates logging the same rent. Omitted on the
  // QuickEntry handoff path, where the check simply doesn't run.
  recentExpenses?: ReadonlyArray<{ id: string; description: string; amount: number; createdAt: string }>;
}

const CATEGORIES = ['Food', 'Transport', 'Shopping', 'Bills', 'Entertainment', 'Travel', 'Health', 'General'];

// Member picker chip (paid by / split between): the 1d selector at chip scale
// — raised card face with the 3:1 field edge; selected = violet-lit face +
// violet edge, plus a check glyph so the choice never rests on colour alone.
const memberChipClass = (selected: boolean) =>
  `selector-base w-auto justify-center gap-1.5 min-h-[44px] px-3.5 py-2 rounded-[14px] text-[12px] font-semibold text-ink-800 ${
    selected ? 'selector-selected' : ''
  }`;

function sameDisplayName(a: string | null | undefined, b: string | null | undefined): boolean {
  return (a ?? '').trim().toLocaleLowerCase() === (b ?? '').trim().toLocaleLowerCase();
}

export function AddGroupExpenseModal({ open, group, onClose, prefillAmount, recentExpenses }: Props) {
  const t = useT();
  const toast = useToast();
  const guardClose = useDiscardGuard();
  const submitGuard = useSubmitGuard();
  const { addGroupExpense } = useSplitStore();
  const { accounts, loadAccounts } = useAccountStore();
  const appMode = useAppModeStore((s) => s.mode);
  const activeMembers = getActiveGroupMembers(group);
  const inactiveMembers = getInactiveGroupMembers(group);
  const defaultPayerId = activeMembers.find(member => member.profileId === localStorage.getItem('hisaab_supabase_uid'))?.id
    ?? '';

  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState(prefillAmount ?? '');
  const [paidBy, setPaidBy] = useState(defaultPayerId);
  const [splitType, setSplitType] = useState<SplitType>('equal');
  const [selectedMembers, setSelectedMembers] = useState<string[]>(activeMembers.map(m => m.id));
  const [exactAmounts, setExactAmounts] = useState<Record<string, string>>({});
  const [percentages, setPercentages] = useState<Record<string, string>>({});
  const [shares, setShares] = useState<Record<string, string>>({});
  const [category, setCategory] = useState('General');
  const [paidFromAccountId, setPaidFromAccountId] = useState('');
  // When on, the split is still recorded but the payer's personal account
  // balance is NOT touched — for people who don't track their own accounts here.
  const [dontTrackInAccounts, setDontTrackInAccounts] = useState(false);
  const [saving, setSaving] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const amt = parseFloat(amount) || 0;
  // Live running totals for the split preview. Glanceable feedback so the
  // user can see whether an exact/percentage split adds up before saving.
  const exactTotal = selectedMembers.reduce((sum, id) => sum + (parseFloat(exactAmounts[id] || '0') || 0), 0);
  const pctTotal = selectedMembers.reduce((sum, id) => sum + (parseFloat(percentages[id] || '0') || 0), 0);
  const sharesTotal = selectedMembers.reduce((sum, id) => sum + (parseFloat(shares[id] || '1') || 0), 0);
  const exactRemaining = Math.round((amt - exactTotal) * 100) / 100;
  const exactIsOff = Math.abs(exactTotal - amt) > 0.01;
  const pctIsOff = Math.abs(pctTotal - 100) > 0.01;
  const currentUserId = localStorage.getItem('hisaab_supabase_uid') ?? '';
  const currentUserName = localStorage.getItem('hisaab_user_name') ?? '';
  const paidByMember = group.members.find(member => member.id === paidBy);
  const isPaidByMe = Boolean(
    paidByMember?.profileId === currentUserId ||
    (paidByMember && !paidByMember.profileId && sameDisplayName(paidByMember.name, currentUserName)),
  );
  const shouldTrackExpense = appMode === 'full_tracker' && isPaidByMe && accounts.length > 0;
  const activeMemberIdsKey = activeMembers.map((member) => member.id).join('|');

  useEffect(() => {
    if (!open) return;
    const activeMemberIds = new Set(activeMemberIdsKey ? activeMemberIdsKey.split('|') : []);
    setSelectedMembers((current) => current.filter((id) => activeMemberIds.has(id)));
    if (!activeMemberIds.has(paidBy)) setPaidBy(defaultPayerId);
  }, [activeMemberIdsKey, defaultPayerId, open, paidBy]);

  useEffect(() => {
    if (open && appMode === 'full_tracker') {
      void loadAccounts();
    }
  }, [appMode, open, loadAccounts]);

  // When prefillAmount arrives (modal opened from QuickEntry flow), seed
  // the local amount state. Runs on every open transition so consecutive
  // QuickEntry launches with different amounts don't show stale values.
  useEffect(() => {
    if (open && prefillAmount) setAmount(prefillAmount);
  }, [open, prefillAmount]);

  useEffect(() => {
    if (!open) return;
    if (!shouldTrackExpense) {
      setPaidFromAccountId('');
      setDontTrackInAccounts(false);
      return;
    }
    if (paidFromAccountId && !accounts.some(account => account.id === paidFromAccountId)) {
      setPaidFromAccountId('');
    }
  }, [open, shouldTrackExpense, paidFromAccountId, accounts]);

  const toggleMember = (id: string) => {
    setSelectedMembers(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  };

  // Share math lives in splitMath so this form and the ad-hoc split sheet can
  // never drift apart. Only the error TRANSLATION belongs here — the helper
  // returns language-agnostic codes.
  const computeSplits = (): { valid: boolean; splits: SplitDetail[]; error?: string } => {
    const result = computeShares({
      amount: amt,
      participantIds: selectedMembers,
      method: splitType,
      exact: exactAmounts,
      percentages,
      shares,
    });
    return {
      valid: result.valid,
      splits: result.splits,
      error: result.error ? t(SHARE_ERROR_KEYS[result.error]) : undefined,
    };
  };

  // Ref-backed entry re-check (audit F-8/D-1): the `saving` STATE flag can't
  // stop two taps landing in one frame — both would read `saving === false`
  // and post two group expenses. `saving` stays for the disabled/label UI.
  const handleSubmit = () => submitGuard.run(runSubmit);

  const runSubmit = async () => {
    setSubmitError(null);

    if (!defaultPayerId) {
      setSubmitError(t('agem_membership_unmatched'));
      return;
    }
    if (!description.trim()) {
      setSubmitError(t('val_need_name'));
      return;
    }
    if (amt <= 0) {
      setSubmitError(t('val_need_amount'));
      return;
    }
    if (!paidBy) {
      setSubmitError(t('fill_all'));
      return;
    }
    if (activeMembers.length < 2) {
      setSubmitError(NEED_TWO_ACTIVE_MEMBERS_MESSAGE);
      return;
    }
    if (shouldTrackExpense && !dontTrackInAccounts && !paidFromAccountId) {
      setSubmitError(t('group_paid_from_required'));
      return;
    }

    const { valid, splits, error } = computeSplits();
    if (!valid) {
      setSubmitError(error || t('error'));
      return;
    }

    // Soft-warn on a likely duplicate (both flatmates logging the same bill).
    if (recentExpenses && recentExpenses.length > 0) {
      const dup = findRecentDuplicate({ description: description.trim(), amount: amt }, recentExpenses, Date.now());
      if (dup) {
        const ok = await confirmDestructive({
          title: t('agem_dup_title'),
          description: t('agem_dup_body')
            .replace('{desc}', dup.description)
            .replace('{amount}', formatMoney(dup.amount, group.currency)),
          confirmLabel: t('agem_add_anyway'),
          cancelLabel: t('cancel'),
          tone: 'warning',
        });
        if (!ok) return;
      }
    }

    setSaving(true);
    try {
      // Read BEFORE the write — after it, the stores are never empty again.
      const isFirstEver =
        useTransactionStore.getState().transactions.length === 0 &&
        useLoanStore.getState().loans.length === 0;
      await addGroupExpense({
        groupId: group.id,
        description: description.trim(),
        amount: amt,
        paidBy,
        splitType,
        splits,
        category,
        paidFromAccountId: (shouldTrackExpense && !dontTrackInAccounts) ? paidFromAccountId : undefined,
      });
      // Catalog #9 (source=group) + #19. Amount and participant count both
      // travel as buckets — never the raw split.
      const mode = appMode === 'splits_only' ? 'splits_only' : 'full_tracker';
      track('entry_created', {
        entry_type: 'expense',
        source: 'group',
        is_first_ever: isFirstEver,
        mode,
        currency: group.currency,
        amount_bucket: bucketAmount(amt),
      });
      track('group_expense_added', {
        // The store's SplitType spells the percent variant 'percentage'; the
        // telemetry catalog's enum spells it 'percent' — translate rather
        // than let the sanitizer silently drop the property.
        split_type: splitType === 'percentage' ? 'percent' : splitType,
        participant_count_bucket: bucketCount(splits.length),
      });
      const payerName = activeMembers.find((member) => member.id === paidBy)?.name ?? t('agem_someone');
      const paidFrom = paidFromAccountId ? accounts.find((account) => account.id === paidFromAccountId)?.name : null;
      toast.show({
        type: 'success',
        title: t('agem_saved'),
        subtitle: t('agem_saved_sub')
          .replace('{payer}', payerName)
          .replace('{amount}', formatMoney(amt, group.currency))
          .replace('{from}', paidFrom ? t('agem_from_account').replace('{account}', paidFrom) : '')
          .replace('{n}', String(splits.length)),
      });
      setDescription('');
      setAmount('');
      setSubmitError(null);
      onClose();
    } catch (err) {
      // Surface the real message — "error" with no subtitle used to leave
      // the user guessing whether a retry was safe.
      const message = friendlyGroupParticipantError(err) || t('error');
      setSubmitError(message);
      toast.show({ type: 'error', title: t('agem_not_saved'), subtitle: message });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title={t('group_expense_add')}
      confirmClose={() => guardClose(!!description.trim() || !!amount.trim() || splitType !== 'equal')}
      footer={
      <div className="space-y-2.5">
        {submitError && (
          <p
            role="alert"
            className="text-[12px] font-medium text-pay-text bg-pay-50 border border-pay-100 rounded-[12px] px-3 py-2 leading-snug"
          >
            {submitError}
          </p>
        )}
        <button onClick={handleSubmit} disabled={saving || !description.trim() || amt <= 0 || activeMembers.length < 2 || !defaultPayerId || (shouldTrackExpense && !dontTrackInAccounts && !paidFromAccountId)}
          className="cta-primary">
          {saving ? t('quick_processing') : t('group_save_expense')}
        </button>
      </div>
    }>
      <div className="space-y-5 p-5">
        {!defaultPayerId && (
          <p role="alert" className="text-[12px] font-medium text-pay-text bg-pay-50 border border-pay-100 rounded-[12px] px-3 py-2 leading-snug">
            {t('agem_membership_unmatched')}
          </p>
        )}
        {activeMembers.length < 2 && (
          <p role="alert" className="text-[12px] font-medium text-pay-text bg-pay-50 border border-pay-100 rounded-[12px] px-3 py-2 leading-snug">
            {NEED_TWO_ACTIVE_MEMBERS_MESSAGE}
          </p>
        )}
        <div>
          <label className="form-label">{t('group_desc')}</label>
          <input className="input-field" value={description} onChange={e => setDescription(e.target.value)} placeholder={t('group_desc_placeholder')} />
        </div>

        <div>
          <label className="form-label">{t('group_amount')}</label>
          <input className="input-field font-semibold tabular-nums" type="number" inputMode="decimal" value={amount} onChange={e => setAmount(e.target.value)} placeholder="0" />
        </div>

        <div>
          <label className="form-label">{t('group_paid_by')}</label>
          <div className="flex flex-wrap gap-2.5">
            {activeMembers.map(member => (
              <button key={member.id} type="button" onClick={() => setPaidBy(member.id)} aria-pressed={paidBy === member.id}
                className={memberChipClass(paidBy === member.id)}>
                {paidBy === member.id && <Glyph name="check" size={12} strokeWidth={3} tone="violet" />}
                {member.name}
                {/* Guests are in this list because getActiveGroupMembers keys on
                    status and a guest seat is 'connected' — the same predicate
                    the server's paid_by trigger uses (audit G6 / O4). The tag
                    says which of these people will never see this expense in
                    their own app. */}
                {isGuestMember(member) && (
                  <span className={`text-[10px] uppercase tracking-[0.06em] font-semibold ${paidBy === member.id ? 'text-accent-text' : 'text-ink-500'}`}>
                    {t('guest_tag')}
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>

        {shouldTrackExpense && (
          <div>
            <label className="form-label">{t('paid_from')}</label>
            {/* Opt-out for people who don't track their own accounts here — the
                split is still recorded, just without touching a balance. The
                whole row is the switch; the knob shows its state. */}
            <button
              type="button"
              role="switch"
              aria-checked={dontTrackInAccounts}
              onClick={() => setDontTrackInAccounts(v => !v)}
              className="selector-base gap-3 p-3 pl-3.5">
              <span className="text-[13px] font-semibold text-ink-800">{t('group_dont_track')}</span>
              <span className={`m-switch ${dontTrackInAccounts ? 'is-on' : ''}`} aria-hidden="true" />
            </button>
            {!dontTrackInAccounts && (
              <>
                <div className="mt-2.5">
                  <AccountSelect accounts={accounts} selectedId={paidFromAccountId} onSelect={setPaidFromAccountId} preferredCurrency={group.currency} />
                </div>
                <p className="text-[10.5px] text-ink-500 mt-1.5 leading-relaxed">{t('group_paid_from_hint')}</p>
              </>
            )}
          </div>
        )}

        <div>
          <label className="form-label">{t('group_split_between')}</label>
          <div className="flex flex-wrap gap-2.5">
            {activeMembers.map(member => {
              const included = selectedMembers.includes(member.id);
              return (
                <button key={member.id} type="button" onClick={() => toggleMember(member.id)} aria-pressed={included}
                  className={memberChipClass(included)}>
                  {included && <Glyph name="check" size={12} strokeWidth={3} tone="violet" />}
                  {member.name}
                  {isGuestMember(member) && (
                    <span className={`text-[10px] uppercase tracking-[0.06em] font-semibold ${included ? 'text-accent-text' : 'text-ink-500'}`}>
                      {t('guest_tag')}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>

        {inactiveMembers.length > 0 && (
          <p className="text-[11px] text-ink-500">
            {t('agem_historical_members').replace('{names}', inactiveMembers.map((member) => member.name).join(', '))}
          </p>
        )}

        <div>
          <label className="form-label">{t('group_split_type')}</label>
          {/* One mode at a time — the segmented track, active face lit. */}
          <div className="m-seg flex w-full">
            {(['equal', 'exact', 'percentage', 'shares'] as SplitType[]).map(split => (
              <button key={split} type="button" onClick={() => setSplitType(split)} aria-pressed={splitType === split}
                className="flex-1 min-w-0 min-h-[44px] px-1 text-[11.5px] leading-tight">
                {split === 'equal' ? t('group_split_equal') : split === 'exact' ? t('group_split_exact') : split === 'percentage' ? t('group_split_pct') : t('group_split_shares')}
              </button>
            ))}
          </div>
        </div>

        {amt > 0 && selectedMembers.length > 0 && (
          <div className="space-y-2.5">
            {splitType === 'equal' && (
              <p className="m-inset text-[12px] text-ink-600 px-3 py-2.5 text-center font-medium">
                {t('group_each_pays')}: <span className="font-semibold text-ink-900 tabular-nums">{formatMoney(Math.round((amt / selectedMembers.length) * 100) / 100, group.currency)}</span>
              </p>
            )}
            {splitType === 'exact' && selectedMembers.map(id => (
              <div key={id} className="flex items-center gap-2.5">
                <span className="text-[12px] text-ink-800 font-medium w-20 truncate">{group.members.find(member => member.id === id)?.name}</span>
                <input className="input-field flex-1 min-h-[44px] px-3 py-2" type="number" inputMode="decimal"
                  value={exactAmounts[id] || ''} onChange={e => setExactAmounts({ ...exactAmounts, [id]: e.target.value })} placeholder="0" />
              </div>
            ))}
            {splitType === 'exact' && (
              <p className={`text-[11px] font-semibold tabular-nums px-1 ${exactIsOff ? 'text-pay-text' : 'text-ink-500'}`}>
                {t('split_allocated').replace('{a}', formatMoney(exactTotal, group.currency)).replace('{b}', formatMoney(amt, group.currency))}
                {' — '}
                {(exactRemaining < 0 ? t('budget_over_by_short') : t('ca_remaining'))
                  .replace('{amount}', formatMoney(Math.abs(exactRemaining), group.currency))}
              </p>
            )}
            {splitType === 'percentage' && selectedMembers.map(id => (
              <div key={id} className="flex items-center gap-2.5">
                <span className="text-[12px] text-ink-800 font-medium w-20 truncate">{group.members.find(member => member.id === id)?.name}</span>
                <input className="input-field flex-1 min-h-[44px] px-3 py-2" type="number" inputMode="decimal"
                  value={percentages[id] || ''} onChange={e => setPercentages({ ...percentages, [id]: e.target.value })} placeholder="%" />
                <span className="text-[11px] text-ink-500">%</span>
              </div>
            ))}
            {splitType === 'percentage' && (
              <p className={`text-[11px] font-semibold tabular-nums px-1 ${pctIsOff ? 'text-pay-text' : 'text-ink-500'}`}>
                {t('split_total_pct').replace('{n}', String(Math.round(pctTotal * 100) / 100))}
              </p>
            )}
            {splitType === 'shares' && selectedMembers.map(id => (
              <div key={id} className="flex items-center gap-2.5">
                <span className="text-[12px] text-ink-800 font-medium w-20 truncate">{group.members.find(member => member.id === id)?.name}</span>
                <input className="input-field flex-1 min-h-[44px] px-3 py-2" type="number" inputMode="numeric"
                  value={shares[id] || '1'} onChange={e => setShares({ ...shares, [id]: e.target.value })} placeholder="1" />
                <span className="text-[11px] text-ink-500">{t('agem_shares')}</span>
              </div>
            ))}
            {splitType === 'shares' && (
              <p className="text-[11px] font-semibold tabular-nums px-1 text-ink-500">
                {t('split_total_shares').replace('{n}', String(Math.round(sharesTotal * 100) / 100))}
              </p>
            )}
          </div>
        )}

        <div>
          <label className="form-label">{t('category')}</label>
          <div className="flex flex-wrap gap-2">
            {CATEGORIES.map(item => (
              <button key={item} type="button" onClick={() => setCategory(item)} aria-pressed={category === item}
                className="m-pill min-h-[44px] px-3.5 text-[11.5px]">
                {item}
              </button>
            ))}
          </div>
        </div>
      </div>
    </Modal>
  );
}
