// "Where did the money land?" / "Which account did you pay from?" — asked
// EVERY time a linked settlement is recorded, sent or confirmed in Full
// Tracker. There is deliberately no default: the old "Apply to one of my
// accounts" switch defaulted to OFF, so on 2026-09-24 a real AED 3,000
// repayment was recorded "record only" and never reached the account it was
// deposited into. "Record only" is still one tap away — it just has to be a
// choice, not an accident.
//
// Value: '' = not chosen yet · RECORD_ONLY · an account id.

import { useMemo } from 'react';
import { AccountSelect } from './AccountSelect';
import { Glyph } from './Glyph';
import { useT } from '../lib/i18n';
import type { Account, Currency } from '../db';

export const RECORD_ONLY = '__record_only__';

/** The account id to send to the server: null for "record only". */
// eslint-disable-next-line react-refresh/only-export-components
export function landingAccountId(value: string): string | null {
  return value && value !== RECORD_ONLY ? value : null;
}

interface Props {
  /** 'given' = the money came TO me; 'taken' = it went FROM me. */
  direction: 'given' | 'taken';
  currency: Currency;
  accounts: Account[];
  value: string;
  onChange: (value: string) => void;
  /** Offer "Not in any account — record only" (off for "Add to an account"). */
  allowRecordOnly?: boolean;
  /** Listed first within its group (e.g. the account used last time). */
  preferredAccountId?: string | null;
}

export function SettlementAccountChoice({
  direction,
  currency,
  accounts,
  value,
  onChange,
  allowRecordOnly = true,
  preferredAccountId = null,
}: Props) {
  const t = useT();

  // Same currency only — the server refuses anything else — and the account
  // used last time first, so the common case is one tap.
  const eligible = useMemo(() => {
    const same = accounts.filter((a) => a.currency === currency && !a.deletedAt);
    if (!preferredAccountId) return same;
    return [
      ...same.filter((a) => a.id === preferredAccountId),
      ...same.filter((a) => a.id !== preferredAccountId),
    ];
  }, [accounts, currency, preferredAccountId]);

  const recordOnly = value === RECORD_ONLY;
  const accountValue = recordOnly ? '' : value;

  return (
    <div>
      <label className="form-label">
        {direction === 'given' ? t('stl_land_q_given') : t('stl_land_q_taken')}
      </label>

      {!recordOnly && eligible.length > 0 && (
        <AccountSelect
          accounts={eligible}
          selectedId={accountValue}
          onSelect={onChange}
          preferredCurrency={currency}
        />
      )}

      {allowRecordOnly && (
        <button
          type="button"
          onClick={() => onChange(recordOnly ? '' : RECORD_ONLY)}
          aria-pressed={recordOnly}
          className={`selector-base mt-2.5 ${recordOnly ? 'selector-selected' : ''}`}
        >
          <div className="flex items-center gap-2.5 min-w-0">
            <Glyph name="document" size={16} className="text-ink-500 shrink-0" />
            <div className="min-w-0 text-left">
              <p className="text-[13px] font-semibold text-ink-900">{t('stl_land_record_only')}</p>
              <p className="text-[10.5px] text-ink-500 mt-0.5">{t('stl_land_record_only_hint')}</p>
            </div>
          </div>
          {recordOnly && <Glyph name="check" size={14} strokeWidth={3} className="text-accent-text shrink-0" />}
        </button>
      )}

      {!value && (
        <p className="text-[11px] text-warn-600 font-semibold mt-2">{t('stl_land_required')}</p>
      )}
    </div>
  );
}
