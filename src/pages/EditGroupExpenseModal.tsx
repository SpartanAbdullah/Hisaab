import { useEffect, useState } from 'react';
import { Modal } from '../components/Modal';
import { Glyph } from '../components/Glyph';
import { useDiscardGuard } from '../lib/useDiscardGuard';
import { useSubmitGuard } from '../lib/useSubmitGuard';
import { useSplitStore } from '../stores/splitStore';
import { useAccountStore } from '../stores/accountStore';
import { useAppModeStore } from '../stores/appModeStore';
import { useToast } from '../components/Toast';
import { confirmDestructive } from '../components/ConfirmDestructiveSheet';
import { AccountSelect } from '../components/AccountSelect';
import { EditHistorySheet, EditHistoryRow } from '../components/EditHistorySheet';
import { useT } from '../lib/i18n';
import { formatMoney } from '../lib/constants';
import { parseInternalNote } from '../lib/internalNotes';
import type { SplitGroup, GroupExpense, SplitType, SplitDetail } from '../db';
import {
  friendlyGroupParticipantError,
  getActiveGroupMembers,
  getInactiveGroupMembers,
  NEED_TWO_ACTIVE_MEMBERS_MESSAGE,
} from '../lib/groupActiveMembers';
import { isGuestMember } from '../lib/groupGuests';

interface Props {
  open: boolean;
  group: SplitGroup;
  expense: GroupExpense | null;
  onClose: () => void;
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

export function EditGroupExpenseModal({ open, group, expense, onClose }: Props) {
  const t = useT();
  const toast = useToast();
  const guardClose = useDiscardGuard();
  // Shared by save AND delete: they mutate the same row, so a save landing on
  // top of an in-flight delete (or vice versa) is exactly what we must block.
  const submitGuard = useSubmitGuard();
  const { updateGroupExpense, deleteGroupExpense } = useSplitStore();
  const { accounts, loadAccounts } = useAccountStore();
  const appMode = useAppModeStore((s) => s.mode);
  const activeMembers = getActiveGroupMembers(group);
  const inactiveMembers = getInactiveGroupMembers(group);

  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState('');
  const [paidBy, setPaidBy] = useState('');
  const [splitType, setSplitType] = useState<SplitType>('equal');
  const [selectedMembers, setSelectedMembers] = useState<string[]>([]);
  const [exactAmounts, setExactAmounts] = useState<Record<string, string>>({});
  const [percentages, setPercentages] = useState<Record<string, string>>({});
  const [shares, setShares] = useState<Record<string, string>>({});
  const [category, setCategory] = useState('General');
  const [paidFromAccountId, setPaidFromAccountId] = useState('');
  // Whether "Not tracked in my wallet" is the deliberate choice — as opposed
  // to '' merely meaning "no account picked yet" while the picker is open.
  const [dontTrack, setDontTrack] = useState(true);
  const [saving, setSaving] = useState(false);
  // Who-changed-what (audit G5/O10) — especially valuable on the non-creator
  // banner below: "only {creator} can edit this" is the honest completion of
  // that sentence with "…here's what they changed."
  const [showHistory, setShowHistory] = useState(false);

  const currentUserId = localStorage.getItem('hisaab_supabase_uid') ?? '';
  const currentUserName = localStorage.getItem('hisaab_user_name') ?? '';
  // Creator-only editing (matches the RLS policy on the shared row). Rows
  // created before created_by existed (null) stay editable — the DB layer's
  // 0-row check is the backstop for those.
  const isCreator = !expense?.createdBy || expense.createdBy === currentUserId;
  const creatorName = expense?.createdBy
    ? group.members.find((m) => m.profileId === expense.createdBy)?.name ?? null
    : null;
  const paidByMember = group.members.find(member => member.id === paidBy);
  const isPaidByMe = Boolean(
    paidByMember?.profileId === currentUserId ||
    (paidByMember && !paidByMember.profileId && sameDisplayName(paidByMember.name, currentUserName)),
  );
  const shouldTrackExpense = appMode === 'full_tracker' && isPaidByMe && accounts.length > 0;

  useEffect(() => {
    if (open && appMode === 'full_tracker') {
      void loadAccounts();
    }
  }, [appMode, open, loadAccounts]);

  useEffect(() => {
    if (expense && open) {
      const meta = parseInternalNote(expense.notes).meta;
      setDescription(expense.description);
      setAmount(String(expense.amount));
      setPaidBy(expense.paidBy);
      setSplitType(expense.splitType);
      const activeMemberIds = new Set(getActiveGroupMembers(group).map((member) => member.id));
      setSelectedMembers(expense.splits.map(split => split.memberId).filter((id) => activeMemberIds.has(id)));
      setCategory(expense.category || 'General');
      setPaidFromAccountId(meta.paidFromAccountId ?? '');
      setDontTrack(!meta.paidFromAccountId);
      if (expense.splitType === 'exact') {
        const values: Record<string, string> = {};
        expense.splits.forEach(split => { values[split.memberId] = String(split.amount); });
        setExactAmounts(values);
      }
      // Percentage/shares were previously dropped on edit — the fallback
      // recomputed them as equal splits. Re-derive the editors' inputs from
      // the stored amounts so the original proportions survive a save.
      if (expense.splitType === 'percentage' && expense.amount > 0) {
        // Remainder-correct: independently rounded per-member percentages can
        // sum to 99.93 or 100.07 and then fail the modal's own 100% check on
        // an untouched expense. Pin the last member to whatever closes the
        // gap so the seeded set always sums to exactly 100.
        const values: Record<string, string> = {};
        let running = 0;
        expense.splits.forEach((split, index) => {
          if (index === expense.splits.length - 1) {
            values[split.memberId] = String(Math.round((100 - running) * 100) / 100);
          } else {
            const pct = Math.round((split.amount / expense.amount) * 100 * 100) / 100;
            values[split.memberId] = String(pct);
            running = Math.round((running + pct) * 100) / 100;
          }
        });
        setPercentages(values);
      }
      if (expense.splitType === 'shares') {
        // Raw share counts aren't persisted (only amounts). Normalize by the
        // smallest amount so proportions survive AND the scale stays share-
        // like — a newly toggled member's default share of '1' then means
        // "same as the smallest", not a rounding error against raw amounts.
        const smallest = Math.min(...expense.splits.map(s => s.amount).filter(a => a > 0));
        const values: Record<string, string> = {};
        expense.splits.forEach(split => {
          const share = smallest > 0 ? Math.round((split.amount / smallest) * 100) / 100 : 1;
          values[split.memberId] = String(share);
        });
        setShares(values);
      }
    }
  }, [expense, group, open]);

  useEffect(() => {
    if (!open) return;
    if (!shouldTrackExpense) {
      setPaidFromAccountId('');
      return;
    }
    if (paidFromAccountId && !accounts.some(account => account.id === paidFromAccountId)) {
      setPaidFromAccountId('');
    }
  }, [open, shouldTrackExpense, paidFromAccountId, accounts]);

  const amt = parseFloat(amount) || 0;

  const toggleMember = (id: string) => {
    setSelectedMembers(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  };

  const computeSplits = (): { valid: boolean; splits: SplitDetail[]; error?: string } => {
    if (selectedMembers.length === 0) return { valid: false, splits: [], error: t('fill_all') };
    if (splitType === 'equal') {
      const base = Math.floor((amt * 100) / selectedMembers.length) / 100;
      const remainder = Math.round((amt - base * selectedMembers.length) * 100) / 100;
      return {
        valid: true,
        splits: selectedMembers.map((id, index) => ({
          memberId: id,
          amount: index === selectedMembers.length - 1 ? base + remainder : base,
        })),
      };
    }
    if (splitType === 'exact') {
      const splits = selectedMembers.map(id => ({ memberId: id, amount: parseFloat(exactAmounts[id] || '0') }));
      const total = splits.reduce((sum, split) => sum + split.amount, 0);
      if (Math.abs(total - amt) > 0.01) return { valid: false, splits, error: t('group_total_mismatch') };
      return { valid: true, splits };
    }
    if (splitType === 'percentage') {
      const splits = selectedMembers.map(id => {
        const pct = parseFloat(percentages[id] || '0');
        return { memberId: id, amount: Math.round((pct / 100) * amt * 100) / 100 };
      });
      // Round the float sum to 2dp BEFORE comparing — 99.99 must fail and
      // 100.00 must pass without 1e-14 float dust flipping the verdict.
      const totalPct = Math.round(selectedMembers.reduce((sum, id) => sum + parseFloat(percentages[id] || '0'), 0) * 100) / 100;
      if (Math.abs(totalPct - 100) > 0.01) return { valid: false, splits, error: t('group_pct_mismatch') };
      return { valid: true, splits };
    }
    if (splitType === 'shares') {
      const totalShares = selectedMembers.reduce((sum, id) => sum + parseFloat(shares[id] || '1'), 0);
      if (totalShares === 0) return { valid: false, splits: [], error: t('val_shares_zero') };
      const splits = selectedMembers.map(id => {
        const share = parseFloat(shares[id] || '1');
        return { memberId: id, amount: Math.round((share / totalShares) * amt * 100) / 100 };
      });
      return { valid: true, splits };
    }
    return { valid: true, splits: selectedMembers.map(id => ({ memberId: id, amount: amt / selectedMembers.length })) };
  };

  const handleSave = () => submitGuard.run(runSave);
  const handleDelete = () => submitGuard.run(runDelete);

  const runSave = async () => {
    if (!expense) return;
    if (!description.trim() || amt <= 0 || !paidBy) {
      toast.show({ type: 'error', title: t('fill_all') });
      return;
    }
    if (activeMembers.length < 2) {
      toast.show({ type: 'error', title: NEED_TWO_ACTIVE_MEMBERS_MESSAGE });
      return;
    }
    const { valid, splits, error } = computeSplits();
    if (!valid) {
      toast.show({ type: 'error', title: error || t('error') });
      return;
    }
    setSaving(true);
    try {
      await updateGroupExpense(expense.id, {
        description: description.trim(),
        amount: amt,
        paidBy,
        splitType,
        splits,
        category,
        paidFromAccountId: shouldTrackExpense ? paidFromAccountId || null : null,
      });
      toast.show({ type: 'success', title: t('egem_updated') });
      onClose();
    } catch (err) {
      const message = friendlyGroupParticipantError(err) || t('error');
      toast.show({ type: 'error', title: t('egem_not_updated'), subtitle: message });
    } finally {
      setSaving(false);
    }
  };

  const runDelete = async () => {
    if (!expense) return;
    const ok = await confirmDestructive({
      title: t('egem_delete_confirm'),
      description: t('egem_delete_body'),
      confirmLabel: t('common_delete'),
    });
    if (!ok) return;
    setSaving(true);
    try {
      await deleteGroupExpense(expense.id);
      toast.show({ type: 'success', title: t('egem_deleted') });
      onClose();
    } catch (err) {
      // Honest failure — previously a silently no-op'd delete toasted success.
      toast.show({
        type: 'error',
        title: t('grp_expense_not_deleted'),
        subtitle: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
    <Modal open={open} onClose={onClose} title={t('egem_title')}
      confirmClose={() => guardClose(!!expense && (
        description !== expense.description ||
        amount !== String(expense.amount) ||
        paidBy !== expense.paidBy ||
        splitType !== expense.splitType
      ))}
      footer={
      <div className="flex gap-2.5">
        <button onClick={handleDelete} disabled={saving || !isCreator} aria-label={t('common_delete')}
          className="m-btn m-btn-danger px-4">
          <Glyph name="trash" size={17} />
        </button>
        <button onClick={handleSave} disabled={saving || !isCreator || !description.trim() || amt <= 0}
          className="cta-primary flex-1">
          {saving ? t('quick_processing') : t('save')}
        </button>
      </div>
    }>
      <div className="space-y-5 p-5">
        {/* Only the creator's shared row is writable (RLS). Everyone else
            used to get a fake success toast while nothing changed. */}
        {!isCreator && (
          <p className="text-[12px] text-warn-700 bg-warn-50 rounded-[14px] p-3 leading-relaxed">
            {creatorName
              ? t('grp_creator_banner').replace('{name}', creatorName)
              : t('grp_creator_banner_generic')}
          </p>
        )}
        <div>
          <label className="form-label">{t('group_desc')}</label>
          <input className="input-field" value={description} onChange={e => setDescription(e.target.value)} />
        </div>

        <div>
          <label className="form-label">{t('group_amount')}</label>
          <input className="input-field font-semibold tabular-nums" type="number" inputMode="decimal" value={amount} onChange={e => setAmount(e.target.value)} />
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
                    the server's paid_by trigger uses (audit G6 / O4). */}
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
            <div className="space-y-2.5">
              <button
                type="button"
                onClick={() => { setDontTrack(true); setPaidFromAccountId(''); }}
                aria-pressed={dontTrack}
                className={`selector-base ${dontTrack ? 'selector-selected' : ''}`}
              >
                <span className="min-w-0">
                  <span className="block text-[13px] font-semibold text-ink-800">{t('egem_not_tracked')}</span>
                  <span className="block text-[10.5px] text-ink-500 mt-0.5">{t('egem_not_tracked_sub')}</span>
                </span>
                {dontTrack && <Glyph name="check" size={15} strokeWidth={3} tone="violet" />}
              </button>
              {/* "Not tracked" is a deliberate state (paidFromAccountId=''),
                  so the account picker only appears once the user opts back
                  into tracking — otherwise its "Choose an account" prompt
                  would contradict the selected option above. */}
              {dontTrack ? (
                <button
                  type="button"
                  onClick={() => setDontTrack(false)}
                  className="selector-base"
                >
                  <span className="text-[13px] font-semibold text-ink-800">{t('acct_select_placeholder')}…</span>
                  <Glyph name="chevron-right" size={14} className="text-ink-400" />
                </button>
              ) : (
                <AccountSelect accounts={accounts} selectedId={paidFromAccountId} onSelect={setPaidFromAccountId} preferredCurrency={group.currency} />
              )}
            </div>
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

        {amt > 0 && selectedMembers.length > 0 && splitType === 'equal' && (
          <p className="m-inset text-[12px] text-ink-600 px-3 py-2.5 text-center font-medium">
            {t('group_each_pays')}: <span className="font-semibold text-ink-900 tabular-nums">{formatMoney(Math.round((amt / selectedMembers.length) * 100) / 100, group.currency)}</span>
          </p>
        )}

        {amt > 0 && splitType === 'exact' && selectedMembers.map(id => (
          <div key={id} className="flex items-center gap-2.5">
            <span className="text-[12px] text-ink-800 font-medium w-20 truncate">{group.members.find(member => member.id === id)?.name}</span>
            <input className="input-field flex-1 min-h-[44px] px-3 py-2" type="number" inputMode="decimal"
              value={exactAmounts[id] || ''} onChange={e => setExactAmounts({ ...exactAmounts, [id]: e.target.value })} placeholder="0" />
          </div>
        ))}

        {amt > 0 && splitType === 'percentage' && selectedMembers.map(id => (
          <div key={id} className="flex items-center gap-2.5">
            <span className="text-[12px] text-ink-800 font-medium w-20 truncate">{group.members.find(member => member.id === id)?.name}</span>
            <input className="input-field flex-1 min-h-[44px] px-3 py-2" type="number" inputMode="decimal"
              value={percentages[id] || ''} onChange={e => setPercentages({ ...percentages, [id]: e.target.value })} placeholder="%" />
            <span className="text-[11px] text-ink-500">%</span>
          </div>
        ))}

        {amt > 0 && splitType === 'shares' && selectedMembers.map(id => (
          <div key={id} className="flex items-center gap-2.5">
            <span className="text-[12px] text-ink-800 font-medium w-20 truncate">{group.members.find(member => member.id === id)?.name}</span>
            <input className="input-field flex-1 min-h-[44px] px-3 py-2" type="number" inputMode="decimal"
              value={shares[id] || '1'} onChange={e => setShares({ ...shares, [id]: e.target.value })} placeholder="1" />
            <span className="text-[11px] text-ink-500">{t('group_split_shares')}</span>
          </div>
        ))}

        <div>
          <label className="form-label">{t('category')}</label>
          <div className="flex flex-wrap gap-2">
            {CATEGORIES.map(item => (
              <button key={item} type="button" onClick={() => setCategory(item)} aria-pressed={category === item}
                className="m-pill min-h-[40px] px-3.5 text-[11.5px]">
                {item}
              </button>
            ))}
          </div>
        </div>

        {/* Who-changed-what (audit G5/O10). Always present — a persistent
            affordance, not one that appears only when something looks wrong
            (tasks/lessons.md: never gate a primary capability behind an edge
            case). */}
        {expense && <EditHistoryRow onClick={() => setShowHistory(true)} />}
      </div>
    </Modal>
    {expense && (
      <EditHistorySheet
        open={showHistory}
        onClose={() => setShowHistory(false)}
        table="group_expenses"
        recordId={expense.id}
        currency={group.currency}
        actorNames={Object.fromEntries(group.members.filter((m) => m.profileId).map((m) => [m.profileId!, m.name]))}
        memberNames={Object.fromEntries(group.members.map((m) => [m.id, m.name]))}
      />
    )}
    </>
  );
}
