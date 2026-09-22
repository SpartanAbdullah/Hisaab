// The daily close — a 30-second evening sheet: what you logged today, your
// usual everyday spends as one-tap chips (last time's amount pre-filled), and
// one button that closes the day ("nothing spent today" is an answer too).
// Math lives in src/lib/dailyClose.ts (pure + tested); the marker lives in
// dailyCloseStore. Opened from the Home "Close today" tile and from the
// evening nudge (`/?close=today`).
import { useMemo, useState } from 'react';
import { CelebrationMark } from './CelebrationMark';
import { Glyph } from './Glyph';
import { Modal } from './Modal';
import { useToast } from './Toast';
import { useTransactionStore } from '../stores/transactionStore';
import { useAccountStore } from '../stores/accountStore';
import { useDailyCloseStore } from '../stores/dailyCloseStore';
import { computeCloseStreak, dayActivity, usualItems, type UsualItem } from '../lib/dailyClose';
import { parseInternalNote } from '../lib/internalNotes';
import { localIso } from '../lib/localDate';
import { formatMoney } from '../lib/constants';
import { useT } from '../lib/i18n';
import type { QuickEntryPreset } from '../pages/QuickEntry';
import type { Transaction } from '../db';

interface Props {
  open: boolean;
  onClose: () => void;
  /** Open QuickEntry — with a chip's pre-fill, or blank for "Something else". */
  onAdd: (preset: QuickEntryPreset) => void;
  /** Today's data has loaded. Until then the sheet can't know whether
   *  anything was logged, so closing is disabled (a premature tap would
   *  record "nothing spent" on a day that has entries). */
  ready?: boolean;
}

const ENTRIES_SHOWN = 6;
const MONEY_IN: ReadonlySet<Transaction['type']> = new Set(['income', 'loan_taken', 'investment_sell', 'investment_dividend']);

export function DailyCloseSheet(props: Props) {
  // Fresh state every open (the "just closed" payoff must not persist).
  return <DailyCloseBody key={props.open ? 'open' : 'closed'} {...props} />;
}

function DailyCloseBody({ open, onClose, onAdd, ready = true }: Props) {
  const t = useT();
  const toast = useToast();
  const transactions = useTransactionStore((s) => s.transactions);
  const accounts = useAccountStore((s) => s.accounts);
  const closes = useDailyCloseStore((s) => s.closes);
  const closeDay = useDailyCloseStore((s) => s.closeDay);
  const reopen = useDailyCloseStore((s) => s.reopen);
  const [now] = useState(() => new Date());
  const [busy, setBusy] = useState(false);
  const [justClosed, setJustClosed] = useState(false);

  const todayIso = localIso(now);
  const activity = useMemo(() => dayActivity(transactions, closes, todayIso), [transactions, closes, todayIso]);
  const streak = useMemo(() => computeCloseStreak(transactions, closes, todayIso), [transactions, closes, todayIso]);
  const usual = useMemo(() => usualItems(transactions, now), [transactions, now]);
  const accountName = useMemo(() => new Map(accounts.map((a) => [a.id, a.name])), [accounts]);

  const dateLabel = now.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'short' });

  const handleClose = async () => {
    setBusy(true);
    try {
      await closeDay(activity.loggedToday ? 'closed' : 'no_spend', now);
      setJustClosed(true);
    } catch {
      toast.show({ type: 'error', title: t('close_save_failed') });
    } finally {
      setBusy(false);
    }
  };

  const handleReopen = async () => {
    setBusy(true);
    try {
      await reopen(todayIso);
    } catch {
      toast.show({ type: 'error', title: t('close_save_failed') });
    } finally {
      setBusy(false);
    }
  };

  const chipPreset = (item: UsualItem): QuickEntryPreset => ({
    type: 'expense',
    amount: item.lastAmount,
    category: item.category || undefined,
    notes: item.notes || undefined,
    accountId: item.accountId && accountName.has(item.accountId) ? item.accountId : undefined,
  });

  const entryLabel = (txn: Transaction) =>
    parseInternalNote(txn.notes).visibleNote.trim() || txn.category || txn.relatedPerson || '—';
  const entryAccount = (txn: Transaction) =>
    accountName.get(txn.sourceAccountId ?? '') ?? accountName.get(txn.destinationAccountId ?? '') ?? '';

  const closedKind = justClosed ? 'closed' : activity.closedToday;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('close_title')}
      footer={
        closedKind ? (
          <button onClick={onClose} className="cta-primary w-full">
            {t('check_finish')}
          </button>
        ) : (
          <div className="flex gap-2">
            <button onClick={() => onAdd({ type: 'expense' })} className="cta-secondary flex-1" disabled={busy}>
              {t('close_add_other')}
            </button>
            <button onClick={handleClose} className="cta-primary flex-1" disabled={busy || !ready}>
              {activity.loggedToday ? t('close_btn_close') : t('close_btn_nothing')}
            </button>
          </div>
        )
      }
    >
      <div className="space-y-4">
        {/* Date + streak — encouragement only, never a scold. */}
        <div className="flex items-center justify-between gap-3">
          <p className="text-[12.5px] text-ink-500">{dateLabel}</p>
          {streak.streak > 0 || justClosed ? (
            <p className="flex items-center gap-1.5 text-[12px] font-semibold text-ink-900">
              <Glyph name="flame" size={14} tone="gold" />
              {t('close_streak').replace('{n}', String(Math.max(streak.streak, 1)))}
              {streak.graceUsedRecently && (
                <span className="font-normal text-ink-500">· {t('close_streak_rest')}</span>
              )}
            </p>
          ) : (
            <p className="text-[11.5px] text-ink-500">{t('close_streak_start')}</p>
          )}
        </div>

        {closedKind ? (
          <div className="animate-fade-in flex flex-col items-center text-center py-4">
            <CelebrationMark size={52} className="mb-3" burst={false} />
            <p className="text-[16px] font-bold text-ink-900 tracking-tight">{t('close_done')}</p>
            <p className="text-[12px] text-ink-500 mt-1">{t('close_done_body')}</p>
            {!justClosed && (
              <button onClick={handleReopen} disabled={busy} className="m-pill mt-4">
                <Glyph name="undo" size={13} />
                {t('close_reopen')}
              </button>
            )}
          </div>
        ) : (
          <>
            {/* Today's entries */}
            <div>
              <p className="text-[10.5px] font-semibold text-ink-500 uppercase tracking-[0.1em] mb-2">
                {t('close_entries')}
              </p>
              {activity.entriesToday.length === 0 ? (
                <div className="m-card p-3.5 flex items-center gap-2.5">
                  <Glyph name="clock" size={16} tone="neutral" />
                  <p className="text-[12.5px] text-ink-600">{t('close_no_entries')}</p>
                </div>
              ) : (
                <div className="m-card divide-y divide-cream-hairline">
                  {activity.entriesToday.slice(0, ENTRIES_SHOWN).map((txn) => (
                    <div key={txn.id} className="flex items-center gap-2.5 px-3.5 py-2.5">
                      <div className="flex-1 min-w-0">
                        <p className="text-[12.5px] font-medium text-ink-900 truncate tracking-tight">{entryLabel(txn)}</p>
                        {entryAccount(txn) && <p className="text-[10.5px] text-ink-500 truncate">{entryAccount(txn)}</p>}
                      </div>
                      <p className={`text-[12.5px] font-semibold tabular-nums ${MONEY_IN.has(txn.type) ? 'text-receive-text' : 'text-ink-900'}`}>
                        {MONEY_IN.has(txn.type) ? '+' : ''}{formatMoney(txn.amount, txn.currency)}
                      </p>
                    </div>
                  ))}
                  {activity.entriesToday.length > ENTRIES_SHOWN && (
                    <p className="px-3.5 py-2 text-[10.5px] text-ink-400">
                      {t('close_more_entries').replace('{n}', String(activity.entriesToday.length - ENTRIES_SHOWN))}
                    </p>
                  )}
                </div>
              )}
            </div>

            {/* Usual spends — one tap opens QuickEntry with last time's amount. */}
            {usual.length > 0 && (
              <div>
                <p className="text-[10.5px] font-semibold text-ink-500 uppercase tracking-[0.1em]">{t('close_usual')}</p>
                <p className="text-[11px] text-ink-500 mt-0.5 mb-2">{t('close_usual_hint')}</p>
                <div className="flex flex-wrap gap-2">
                  {usual.map((item) => (
                    <button key={item.key} onClick={() => onAdd(chipPreset(item))} className="m-pill max-w-full">
                      <Glyph name="plus" size={12} />
                      <span className="truncate max-w-[140px]">{item.label}</span>
                      <span className="tabular-nums text-ink-900">{formatMoney(item.lastAmount, item.currency)}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
