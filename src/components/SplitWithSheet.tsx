import { useMemo, useState } from 'react';
import { Modal } from './Modal';
import { Glyph } from './Glyph';
import { ContactPicker, type ContactValue } from './ContactPicker';
import { useDiscardGuard } from '../lib/useDiscardGuard';
import { computeShares, type ShareMethod } from '../lib/splitMath';
import { SHARE_ERROR_KEYS } from '../lib/shareErrors';
import { formatMoney } from '../lib/constants';
import { useT } from '../lib/i18n';
import type { SplitDirection } from '../lib/splitEvent';
import type { Currency } from '../db';

// The current user's slot in the share calculation. Not a Person row — "me" is
// never a contact — so it gets a reserved key the participant list understands.
export const ME = '__me__';

export interface SplitPlanParticipant {
  personId: string;
  personName: string;
  amount: number;
}

// What the sheet hands back. Amounts are already resolved to the cent, so the
// caller just executes — no re-deriving share math at submit time.
export interface SplitPlan {
  direction: SplitDirection;
  method: ShareMethod;
  myShare: number;
  /** i_paid: who owes me what. they_paid: empty — their debts aren't mine. */
  others: SplitPlanParticipant[];
  payer: { personId: string; personName: string } | null;
  partyCount: number;
}

interface Row {
  key: string;
  personId: string | null;
  name: string;
}

interface Props {
  open: boolean;
  onClose: () => void;
  total: number;
  currency: Currency;
  /** Reopening with an existing plan restores it for editing. */
  initial?: SplitPlan | null;
  /**
   * splits_only mode: no accounts exist, so the split records loans ONLY.
   * Purely a copy switch — the "the full bill leaves your account" summary is
   * simply untrue there, and telling a ledger-only user their account moved is
   * exactly the kind of phantom record-keeping this repo has been bitten by.
   */
  ledgerOnly?: boolean;
  onApply: (plan: SplitPlan | null) => void;
}

// Remounted on every open (see the `key` below) so the form seeds itself from
// `initial` through useState initialisers. No state-syncing effect to keep in
// step, and no chance of a stale participant list surviving a close/reopen.
export function SplitWithSheet(props: Props) {
  return <SplitWithSheetForm key={props.open ? 'open' : 'closed'} {...props} />;
}

function seedRows(initial: SplitPlan | null | undefined): Row[] {
  if (!initial) return [];
  const fromOthers = initial.others.map((o) => ({ key: o.personId, personId: o.personId, name: o.personName }));
  // they_paid keeps no `others` (their debts aren't ours to track), so the
  // payer is the only participant to restore.
  if (initial.direction === 'they_paid' && initial.payer) {
    return [
      { key: initial.payer.personId, personId: initial.payer.personId, name: initial.payer.personName },
      ...fromOthers,
    ];
  }
  return fromOthers;
}

function SplitWithSheetForm({ open, onClose, total, currency, initial, ledgerOnly = false, onApply }: Props) {
  const t = useT();
  const guardClose = useDiscardGuard();

  const [direction, setDirection] = useState<SplitDirection>(initial?.direction ?? 'i_paid');
  const [rows, setRows] = useState<Row[]>(() => seedRows(initial));
  const [method, setMethod] = useState<ShareMethod>(initial?.method ?? 'equal');
  const [exact, setExact] = useState<Record<string, string>>({});
  const [percentages, setPercentages] = useState<Record<string, string>>({});
  const [shares, setShares] = useState<Record<string, string>>({});
  const [payerKey, setPayerKey] = useState<string>(initial?.payer?.personId ?? '');
  const [picker, setPicker] = useState<ContactValue>({ id: null, name: '' });
  const [error, setError] = useState('');

  // Me first so the "last participant absorbs the rounding remainder" rule in
  // splitMath never quietly hands the user's own share the odd cent — it lands
  // on the last person added, which is at least consistent and visible.
  const participantKeys = useMemo(() => [ME, ...rows.map((r) => r.key)], [rows]);
  const nameFor = (key: string) => (key === ME ? t('split_you') : rows.find((r) => r.key === key)?.name ?? '');

  const result = useMemo(
    () => computeShares({ amount: total, participantIds: participantKeys, method, exact, percentages, shares }),
    [total, participantKeys, method, exact, percentages, shares],
  );

  const shareFor = (key: string) => result.splits.find((s) => s.memberId === key)?.amount ?? 0;
  const myShare = shareFor(ME);
  const owedToMe = useMemo(
    () => Math.round(result.splits.filter((s) => s.memberId !== ME).reduce((sum, s) => sum + s.amount, 0) * 100) / 100,
    [result.splits],
  );

  const isDirty = rows.length > 0 || method !== 'equal';
  const needsPayer = direction === 'they_paid';

  const addRow = (value: ContactValue) => {
    const name = value.name.trim();
    if (!name) return;
    // A person can only appear once — a duplicate row would silently double
    // their share and create two loans against the same contact.
    const already = rows.some((r) =>
      value.id ? r.personId === value.id : r.name.toLocaleLowerCase() === name.toLocaleLowerCase(),
    );
    if (already) {
      setError(t('split_already_added').replace('{name}', name));
      setPicker({ id: null, name: '' });
      return;
    }
    setError('');
    setRows((prev) => [...prev, { key: value.id ?? `new:${name.toLocaleLowerCase()}`, personId: value.id, name }]);
    setPicker({ id: null, name: '' });
  };

  const removeRow = (key: string) => {
    setRows((prev) => prev.filter((r) => r.key !== key));
    if (payerKey === key) setPayerKey('');
    setError('');
  };

  const handleApply = () => {
    if (rows.length === 0) {
      setError(t('val_pick_member'));
      return;
    }
    if (!result.valid) {
      setError(t(SHARE_ERROR_KEYS[result.error!]));
      return;
    }
    if (needsPayer && !payerKey) {
      setError(t('split_need_payer'));
      return;
    }

    // Rows carry a null personId until the parent resolves typed names through
    // findOrCreateByName at save time. `personId` here is a placeholder key;
    // the caller replaces it with the real Person id.
    const payerRow = rows.find((r) => r.key === payerKey) ?? null;
    onApply({
      direction,
      method,
      myShare,
      others: direction === 'i_paid'
        ? rows.map((r) => ({ personId: r.personId ?? r.key, personName: r.name, amount: shareFor(r.key) }))
        : [],
      payer: payerRow ? { personId: payerRow.personId ?? payerRow.key, personName: payerRow.name } : null,
      partyCount: participantKeys.length,
    });
    onClose();
  };

  const clearSplit = () => {
    onApply(null);
    onClose();
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('split_with_title')}
      confirmClose={() => guardClose(isDirty)}
      footer={
        <div className="space-y-2.5">
          {error && (
            <p role="alert" className="text-[12px] font-medium text-pay-text bg-pay-50 border border-pay-100 rounded-[12px] px-3 py-2 leading-snug">
              {error}
            </p>
          )}
          <button onClick={handleApply} disabled={rows.length === 0} className="cta-primary">
            {t('split_apply')}
          </button>
          {initial && (
            <button onClick={clearSplit} className="w-full min-h-[40px] text-[12px] font-semibold text-ink-500 py-2">
              {t('split_remove')}
            </button>
          )}
        </div>
      }
    >
      <div className="space-y-5 p-5">
        <div>
          <label className="form-label">{t('split_who_paid')}</label>
          {/* The fork of the flow: two big selectors, the chosen one violet-lit. */}
          <div className="flex gap-2.5">
            {(['i_paid', 'they_paid'] as const).map((d) => (
              <button
                key={d}
                type="button"
                onClick={() => { setDirection(d); setError(''); }}
                aria-pressed={direction === d}
                className={`selector-base flex-1 justify-center py-3 text-[13px] font-semibold text-ink-800 ${
                  direction === d ? 'selector-selected' : ''
                }`}
              >
                {d === 'i_paid' ? t('split_i_paid') : t('split_they_paid')}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className="form-label">{t('split_between')}</label>
          <div className="flex flex-wrap gap-2 mb-3">
            <span className="m-chip m-chip-violet px-3.5 py-2 text-[12px]">
              {t('split_you')}
            </span>
            {rows.map((r) => (
              <span key={r.key} className="m-chip m-chip-neutral ps-3.5 pe-1 py-1 text-[12px] text-ink-800">
                {r.name}
                <button
                  type="button"
                  onClick={() => removeRow(r.key)}
                  aria-label={t('split_remove_person').replace('{name}', r.name)}
                  className="w-7 h-7 rounded-full flex items-center justify-center text-ink-500 active:bg-cream-border transition-colors"
                >
                  <Glyph name="close" size={12} strokeWidth={2.8} />
                </button>
              </span>
            ))}
          </div>
          <ContactPicker
            value={picker}
            onChange={(next) => {
              setPicker(next);
              // Selecting a saved contact commits immediately; typed names wait
              // for the explicit Add so a half-typed name isn't captured.
              if (next.id) addRow(next);
            }}
            placeholder={t('split_add_placeholder')}
            className="input-field"
          />
          {picker.name.trim() && !picker.id && (
            <button
              type="button"
              onClick={() => addRow(picker)}
              className="m-btn m-btn-plain mt-2.5 w-full min-h-[42px] py-2.5 text-[12.5px] text-accent-600"
            >
              <Glyph name="user-plus" size={15} tone="violet" />
              {t('split_add_named').replace('{name}', picker.name.trim())}
            </button>
          )}
        </div>

        {needsPayer && rows.length > 0 && (
          <div>
            <label className="form-label">{t('split_payer_label')}</label>
            <div className="flex flex-wrap gap-2.5">
              {rows.map((r) => (
                <button
                  key={r.key}
                  type="button"
                  onClick={() => { setPayerKey(r.key); setError(''); }}
                  aria-pressed={payerKey === r.key}
                  className={`selector-base w-auto justify-center gap-1.5 min-h-[44px] px-3.5 py-2 rounded-[14px] text-[12px] font-semibold text-ink-800 ${
                    payerKey === r.key ? 'selector-selected' : ''
                  }`}
                >
                  {payerKey === r.key && <Glyph name="check" size={12} strokeWidth={3} tone="violet" />}
                  {r.name}
                </button>
              ))}
            </div>
          </div>
        )}

        <div>
          <label className="form-label">{t('group_split_type')}</label>
          {/* One mode at a time — the segmented track, active face lit. */}
          <div className="m-seg flex w-full">
            {(['equal', 'exact', 'percentage', 'shares'] as ShareMethod[]).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => { setMethod(m); setError(''); }}
                aria-pressed={method === m}
                className="flex-1 min-w-0 min-h-[44px] px-1 text-[11.5px] leading-tight"
              >
                {m === 'equal' ? t('group_split_equal') : m === 'exact' ? t('group_split_exact') : m === 'percentage' ? t('group_split_pct') : t('group_split_shares')}
              </button>
            ))}
          </div>
        </div>

        {method !== 'equal' && rows.length > 0 && (
          <div className="space-y-2.5">
            {participantKeys.map((key) => (
              <div key={key} className="flex items-center gap-2.5">
                <span className="text-[12px] text-ink-800 font-medium w-20 truncate">{nameFor(key)}</span>
                <input
                  className="input-field flex-1 min-h-[44px] px-3 py-2"
                  type="number"
                  inputMode="decimal"
                  placeholder={method === 'shares' ? '1' : method === 'percentage' ? '%' : '0'}
                  value={
                    method === 'exact' ? exact[key] ?? ''
                      : method === 'percentage' ? percentages[key] ?? ''
                      : shares[key] ?? '1'
                  }
                  onChange={(e) => {
                    const v = e.target.value;
                    if (method === 'exact') setExact((p) => ({ ...p, [key]: v }));
                    else if (method === 'percentage') setPercentages((p) => ({ ...p, [key]: v }));
                    else setShares((p) => ({ ...p, [key]: v }));
                    setError('');
                  }}
                />
                <span className="text-[11px] text-ink-500 w-8 shrink-0">
                  {method === 'percentage' ? '%' : method === 'shares' ? '×' : currency}
                </span>
              </div>
            ))}
          </div>
        )}

        {rows.length > 0 && (
          <div className="m-card p-3.5 space-y-2">
            {participantKeys.map((key) => (
              <div key={key} className="flex items-center justify-between gap-3">
                <span className={`text-[12.5px] min-w-0 truncate ${key === ME ? 'font-semibold text-ink-900' : 'font-medium text-ink-800'}`}>
                  {nameFor(key)}
                </span>
                <span className="text-[12.5px] font-semibold tabular-nums text-ink-900 shrink-0">
                  {formatMoney(shareFor(key), currency)}
                </span>
              </div>
            ))}
            <div className="pt-2.5 border-t border-cream-hairline flex items-start gap-2">
              <Glyph name={direction === 'i_paid' ? 'wallet' : 'groups'} size={14} tone="violet" className="mt-px" />
              <p className="text-[11.5px] font-semibold text-accent-600 leading-snug">
                {direction === 'i_paid'
                  ? t(ledgerOnly ? 'split_summary_i_paid_ledger' : 'split_summary_i_paid')
                      .replace('{total}', formatMoney(total, currency))
                      .replace('{mine}', formatMoney(myShare, currency))
                      .replace('{owed}', formatMoney(owedToMe, currency))
                  : t('split_summary_they_paid')
                      .replace('{name}', nameFor(payerKey) || t('loan_they'))
                      .replace('{mine}', formatMoney(myShare, currency))}
              </p>
            </div>
          </div>
        )}

        <p className="m-inset text-[11.5px] text-ink-600 px-3.5 py-3 leading-relaxed">
          {t('split_no_group_hint')}
        </p>
      </div>
    </Modal>
  );
}
