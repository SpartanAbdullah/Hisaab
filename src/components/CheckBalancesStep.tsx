// Hisaab check — "Balances" step. One row per account: does the figure in
// Hisaab still match the bank app? "Matches" stamps metadata.verifiedAt;
// "Fix" writes the same Correct-balance adjustment AccountDetailPage does.
// A week's drift is a two-tap fix here; left alone it became the multi-hour
// reconciliation of September 2026. Accounts checked in the last 7 days fold
// away so the weekly walk stays short.
import { useMemo, useState } from 'react';
import { Glyph } from './Glyph';
import { useToast } from './Toast';
import { useAccountStore } from '../stores/accountStore';
import { useTransactionStore } from '../stores/transactionStore';
import { daysSince } from '../lib/hisaabCheck';
import { localIso } from '../lib/localDate';
import { formatMoney } from '../lib/constants';
import { useT } from '../lib/i18n';
import type { Account } from '../db';

const RECHECK_DAYS = 7;

export function CheckBalancesStep() {
  const t = useT();
  const accounts = useAccountStore((s) => s.accounts);
  const [now] = useState(() => new Date());
  // Which accounts need a look is decided ONCE per walk — a row the user
  // just confirmed stays in place showing "Checked" instead of vanishing.
  const [dueIds] = useState(() => new Set(
    accounts
      .filter((a) => {
        if (a.deletedAt) return false;
        const d = daysSince(a.metadata?.verifiedAt ?? null, now);
        return d === null || d >= RECHECK_DAYS;
      })
      .map((a) => a.id),
  ));
  const due = useMemo(() => accounts.filter((a) => dueIds.has(a.id)), [accounts, dueIds]);

  return (
    <div className="animate-fade-in space-y-3">
      <div>
        <p className="text-[14px] font-semibold text-ink-900 tracking-tight">{t('check_bal_title')}</p>
        <p className="text-[11.5px] text-ink-500 mt-0.5 leading-relaxed">{t('check_bal_hint')}</p>
      </div>
      {due.length === 0 ? (
        <div className="m-card m-mint p-4 flex items-center gap-2.5">
          <Glyph name="check" size={18} tone="green" />
          <p className="text-[12.5px] font-medium text-receive-text">{t('check_bal_all_done')}</p>
        </div>
      ) : (
        <div className="m-card divide-y divide-cream-hairline">
          {due.map((a) => (
            <BalanceRow key={a.id} account={a} todayIso={localIso(now)} />
          ))}
        </div>
      )}
    </div>
  );
}

function BalanceRow({ account, todayIso }: { account: Account; todayIso: string }) {
  const t = useT();
  const toast = useToast();
  const updateMetadata = useAccountStore((s) => s.updateMetadata);
  const loadAccounts = useAccountStore((s) => s.loadAccounts);
  const loadTransactions = useTransactionStore((s) => s.loadTransactions);
  const [fixing, setFixing] = useState(false);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const isCard = account.type === 'credit_card';

  const stamp = () => updateMetadata(account.id, { verifiedAt: todayIso });

  const confirmMatch = async () => {
    setBusy(true);
    try {
      await stamp();
      setDone(true);
    } catch {
      toast.show({ type: 'error', title: t('check_bal_failed') });
    } finally {
      setBusy(false);
    }
  };

  const target = parseFloat(value);
  const canSave = Number.isFinite(target) && Math.abs(target - account.balance) >= 0.005;
  const saveFix = async () => {
    if (!canSave) return;
    setBusy(true);
    try {
      await useTransactionStore.getState().processTransaction({
        type: 'adjustment',
        amount: 0,
        accountId: account.id,
        targetBalance: target,
        notes: t('acct_correct_note'),
      });
      await stamp();
      await Promise.all([loadAccounts(), loadTransactions()]);
      setDone(true);
    } catch {
      toast.show({ type: 'error', title: t('check_bal_failed') });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="px-3.5 py-3">
      <div className="flex items-center gap-2.5">
        <div className="flex-1 min-w-0">
          <p className="text-[12.5px] font-medium text-ink-900 truncate tracking-tight">{account.name}</p>
          <p className="text-[11px] text-ink-500 tabular-nums">
            {isCard ? `${t('check_bal_available')} ` : ''}
            {formatMoney(account.balance, account.currency)}
          </p>
        </div>
        {done ? (
          <span className="flex items-center gap-1 text-[11.5px] font-semibold text-receive-text">
            <Glyph name="check" size={13} tone="green" />
            {t('check_bal_checked')}
          </span>
        ) : !fixing ? (
          <div className="flex gap-1.5 shrink-0">
            <button onClick={confirmMatch} disabled={busy} className="m-pill m-pill-receive">
              {t('check_bal_match')}
            </button>
            <button onClick={() => setFixing(true)} disabled={busy} className="m-pill">
              {t('check_bal_fix')}
            </button>
          </div>
        ) : null}
      </div>
      {fixing && !done && (
        <div className="flex gap-2 mt-2.5 animate-fade-in">
          <input
            type="number"
            inputMode="decimal"
            step="0.01"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            aria-label={`${account.name} (${account.currency})`}
            className="input-field py-2 tabular-nums flex-1 min-w-0"
          />
          <button onClick={saveFix} disabled={busy || !canSave} className="m-btn m-btn-primary text-[12.5px] px-4">
            {t('check_bal_save')}
          </button>
        </div>
      )}
    </div>
  );
}
