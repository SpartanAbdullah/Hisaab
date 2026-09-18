// Collapsed account selector. Shows ONLY the chosen account as a single row;
// tapping it expands the full list — grouped Wallets & Cash / Banks / Credit
// Cards via AccountGroupSections — to pick a different one. Replaces the
// always-expanded lists that overwhelmed users with several accounts. With no
// selection yet the list starts expanded, so first-time flows lose nothing.

import { useState, type ReactNode } from 'react';
import { AccountGroupSections } from './AccountGroupSections';
import { Glyph } from './Glyph';
import { formatSignedMoney } from '../lib/constants';
import { currencyMeta } from '../lib/design-tokens';
import { orderAccountsForCurrency } from '../lib/accountCurrencyOrder';
import { useT } from '../lib/i18n';
import type { Account, AccountType, Currency } from '../db';

const TYPE_LABEL_KEY: Record<AccountType, 'type_cash' | 'type_bank' | 'type_wallet' | 'type_savings' | 'type_credit_card'> = {
  cash: 'type_cash',
  bank: 'type_bank',
  digital_wallet: 'type_wallet',
  savings: 'type_savings',
  credit_card: 'type_credit_card',
};

interface Props {
  accounts: Account[];
  selectedId: string;
  onSelect: (id: string) => void;
  /** Locked: render the selected row only — no expansion affordance. */
  locked?: boolean;
  /** Right-hand content per row (defaults to the signed balance). */
  renderRight?: (account: Account) => ReactNode;
  /**
   * The currency the flow already knows the money is in (e.g. the loan's).
   * Matching accounts float to the top of each section; mismatched ones stay
   * pickable but carry a "rate needed" tag so a PKR account never masquerades
   * as an option equal to an AED one on an AED loan.
   */
  preferredCurrency?: Currency;
}

export function AccountSelect({ accounts, selectedId, onSelect, locked = false, renderRight, preferredCurrency }: Props) {
  const t = useT();
  const ordered = orderAccountsForCurrency(accounts, preferredCurrency);
  const selected = accounts.find((a) => a.id === selectedId) ?? null;
  const [expanded, setExpanded] = useState(false);
  // Derived, not synced: with no valid selection (none yet, or the selection
  // was filtered out of the list) the list is always expanded — no stale or
  // empty collapsed row is possible.
  const open = expanded || !selected;

  const right = (a: Account) => renderRight?.(a) ?? (
    <p className="text-[13px] font-semibold text-ink-900 tabular-nums">{formatSignedMoney(a.balance, a.currency)}</p>
  );

  const isMismatch = (a: Account) => Boolean(preferredCurrency && a.currency !== preferredCurrency);

  const rowLeft = (a: Account) => (
    <div className="flex items-center gap-2.5 min-w-0">
      <span className="text-sm">{currencyMeta[a.currency]?.flag}</span>
      <div className="min-w-0">
        <p className="text-[13.5px] font-semibold text-ink-900 truncate tracking-tight">{a.name}</p>
        <p className="text-[10.5px] text-ink-500 flex items-center gap-1 mt-0.5">
          {t(TYPE_LABEL_KEY[a.type] ?? 'type_bank')}
          {isMismatch(a) && (
            <span className="m-chip m-chip-gold">
              {a.currency} · {t('acct_rate_needed')}
            </span>
          )}
        </p>
      </div>
    </div>
  );

  // Nothing to offer — don't render a "Choose an account" prompt over an
  // empty list (e.g. a locked account that has since been deleted).
  if (accounts.length === 0) return null;

  if (selected && locked) {
    return (
      <div className="selector-base selector-selected cursor-default active:transform-none">
        {rowLeft(selected)}
        <div className="flex items-center gap-2 shrink-0 ml-2">
          <div className="text-right">{right(selected)}</div>
          <Glyph name="lock" size={14} className="text-accent-text" />
        </div>
      </div>
    );
  }

  if (selected && !open) {
    return (
      <button
        type="button"
        onClick={() => setExpanded(true)}
        className="selector-base selector-selected"
      >
        {rowLeft(selected)}
        <div className="flex items-center gap-2 shrink-0 ml-2">
          <div className="text-right">{right(selected)}</div>
          <div className="flex flex-col items-center text-accent-text">
            <Glyph name="chevron-down" size={14} strokeWidth={2.8} />
            <span className="text-[8.5px] font-semibold uppercase tracking-[0.08em]">{t('acct_select_change')}</span>
          </div>
        </div>
      </button>
    );
  }

  return (
    <div className="animate-fade-in">
      {!selected && (
        <p className="text-[11px] text-ink-500 mb-2">{t('acct_select_placeholder')}</p>
      )}
      <AccountGroupSections
        accounts={ordered}
        renderAccount={(a) => (
          <button
            key={a.id}
            type="button"
            onClick={() => {
              // Re-tapping the current selection just collapses — no onSelect,
              // so consumers' change side-effects (e.g. clearing a typed
              // conversion rate) only fire on a real change.
              if (a.id !== selectedId) onSelect(a.id);
              setExpanded(false);
            }}
            aria-pressed={a.id === selectedId}
            className={`selector-base ${a.id === selectedId ? 'selector-selected' : ''}`}
          >
            {rowLeft(a)}
            <div className="text-right shrink-0 ml-2">{right(a)}</div>
          </button>
        )}
      />
    </div>
  );
}
