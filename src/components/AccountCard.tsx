import { useState } from 'react';
import type { Account, UpcomingExpense } from '../db';
import { formatMoney, formatSignedMoney } from '../lib/constants';
import { currencyMeta } from '../lib/design-tokens';
import { useT, type I18nKey } from '../lib/i18n';
import type { GlyphName, GlyphTone } from '../lib/glyphs';
import { Glyph } from './Glyph';

// 1d account card: a pressable tile wearing the account type's tint (face +
// walls), a 3c glyph for the type, and tabular balances. Same type mapping as
// the Accounts list and Account detail: cash green, bank blue, wallet violet,
// savings gold, card coral.
const cardDesign: Record<string, {
  tint: string;
  glyph: GlyphName;
  tone: GlyphTone;
  labelText: string;
  typeKey: I18nKey;
}> = {
  cash: { tint: 'm-mint', glyph: 'banknote', tone: 'green', labelText: 'text-receive-text', typeKey: 'type_cash' },
  bank: { tint: 'm-blue', glyph: 'bank', tone: 'blue', labelText: 'text-cobalt-text', typeKey: 'type_bank' },
  digital_wallet: { tint: 'm-violet', glyph: 'wallet', tone: 'violet', labelText: 'text-iris-text', typeKey: 'type_wallet' },
  savings: { tint: 'm-gold', glyph: 'savings', tone: 'gold', labelText: 'text-warn-700', typeKey: 'type_savings' },
  credit_card: { tint: 'm-coral', glyph: 'card', tone: 'coral', labelText: 'text-pay-text', typeKey: 'type_credit_card' },
};

interface Props {
  account: Account;
  onClick?: () => void;
  nearestExpense?: UpcomingExpense | null;
  monthStats?: { income: number; expense: number } | null;
}

export function AccountCard({ account, onClick, nearestExpense, monthStats }: Props) {
  const t = useT();
  const design = cardDesign[account.type] ?? cardDesign.cash;
  const meta = currencyMeta[account.currency];
  const isCreditCard = account.type === 'credit_card';
  const creditLimit = isCreditCard ? parseFloat(account.metadata.creditLimit || '0') : 0;
  const used = isCreditCard ? creditLimit - account.balance : 0;
  const dueDay = isCreditCard ? account.metadata.dueDay : '';
  const last4 = isCreditCard ? account.metadata.last4 : '';

  const glyphBox = (
    <div className="m-ctl w-11 h-11 rounded-[14px] flex items-center justify-center shrink-0">
      <Glyph name={design.glyph} tone={design.tone} size={21} extrude />
    </div>
  );

  if (isCreditCard) {
    return (
      <button onClick={onClick} className={`m-tile ${design.tint} p-4 text-left`}>
        <div className="flex items-center gap-3.5">
          {glyphBox}
          <div className="flex-1 min-w-0">
            <p className={`text-[9.5px] font-semibold uppercase tracking-[0.14em] mb-0.5 ${design.labelText}`}>{t(design.typeKey)}</p>
            <p className="font-semibold text-[13.5px] text-ink-900 truncate tracking-tight">
              {account.metadata.issuer || account.name} {last4 ? `••••${last4}` : ''}
            </p>
            <p className="text-[11px] text-ink-600 mt-0.5 flex items-center gap-1 tabular-nums">
              <span>{meta?.flag}</span>
              {t('cc_used')}: {formatMoney(used, account.currency)} / {formatMoney(creditLimit, account.currency)}
            </p>
            {dueDay && (
              <p className="text-[10.5px] font-semibold mt-0.5 text-accent-text">
                {t('cc_next_due')}: {dueDay}{getOrdinal(parseInt(dueDay))} {t('ac_of_month')}
              </p>
            )}
          </div>
          <div className="text-right shrink-0">
            <p className={`font-semibold text-[15px] tabular-nums tracking-tight ${account.balance < 0 ? 'text-pay-text' : 'text-ink-900'}`}>
              {formatSignedMoney(account.balance, account.currency)}
            </p>
            <p className="text-[10.5px] text-ink-500 mt-0.5">{t('cc_available')}</p>
          </div>
        </div>
        {nearestExpense && <UpcomingBadge expense={nearestExpense} />}
      </button>
    );
  }

  return (
    <button onClick={onClick} className={`m-tile ${design.tint} p-4 text-left`}>
      <div className="flex items-center gap-3.5">
        {glyphBox}
        <div className="flex-1 min-w-0">
          <p className={`text-[9.5px] font-semibold uppercase tracking-[0.14em] mb-0.5 ${design.labelText}`}>{t(design.typeKey)}</p>
          <p className="font-semibold text-[13.5px] text-ink-900 truncate tracking-tight">{account.name}</p>
          <p className="text-[11px] mt-0.5 flex items-center gap-1 text-ink-600">
            <span>{meta?.flag}</span>
            {account.currency}
            {account.metadata.bankName && ` · ${account.metadata.bankName}`}
            {account.metadata.walletType && ` · ${account.metadata.walletType}`}
          </p>
        </div>
        <div className="text-right shrink-0">
          <p className={`font-semibold text-[15px] tabular-nums tracking-tight ${account.balance < 0 ? 'text-pay-text' : 'text-ink-900'}`}>
            {formatSignedMoney(account.balance, account.currency)}
          </p>
          <p className="text-[10.5px] text-ink-500 mt-0.5">{t('ac_balance')}</p>
        </div>
      </div>
      {monthStats && (monthStats.income > 0 || monthStats.expense > 0) && (
        <div className="mt-2.5 flex items-center gap-2 text-[10.5px] font-medium text-ink-500 tabular-nums">
          <span>{t('ac_this_month')}</span>
          {monthStats.income > 0 && <span className="text-receive-text">+{formatMoney(monthStats.income, account.currency)}</span>}
          {monthStats.income > 0 && monthStats.expense > 0 && <span>/</span>}
          {monthStats.expense > 0 && <span className="text-pay-text">−{formatMoney(monthStats.expense, account.currency)}</span>}
        </div>
      )}
      {nearestExpense && <UpcomingBadge expense={nearestExpense} />}
    </button>
  );
}

function UpcomingBadge({ expense }: { expense: UpcomingExpense }) {
  const t = useT();
  // Captured once at mount — the daysLeft display does not need to
  // re-compute every render. React's purity rule forbids Date.now() in
  // the render body, so we initialize state lazily instead.
  const [now] = useState(() => Date.now());
  const daysLeft = Math.ceil((new Date(expense.dueDate).getTime() - now) / (1000 * 60 * 60 * 24));
  const urgent = daysLeft <= 7;
  return (
    <div className="m-inset mt-3 px-3 py-2 flex items-center gap-2">
      <Glyph name="alert" size={13} tone={urgent ? 'coral' : 'gold'} />
      <p className={`text-[10.5px] font-semibold truncate flex-1 ${urgent ? 'text-pay-text' : 'text-accent-text'}`}>
        {expense.title} — {formatMoney(expense.amount, expense.currency)}
        {' — '}{daysLeft <= 0 ? t('upcoming_overdue') : `${daysLeft} ${t('upcoming_due_in')}`}
      </p>
    </div>
  );
}

function getOrdinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return s[(v - 20) % 10] || s[v] || s[0];
}
