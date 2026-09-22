// The weekly "Hisaab check" — Monarch's stickiest pattern (a bounded review
// ceremony with a days-since counter) rebuilt on Hisaab's data: last week's
// real flow, people deltas since the previous check, the week ahead, and ONE
// suggested action that exercises the WhatsApp-reminder differentiator.
// Math lives in src/lib/hisaabCheck.ts (pure + tested); this file is only the
// stepped sheet. Completing the walk stamps CHECK_STAMP_KEY so Home can show
// "last done Nd ago" — the ritual's memory.
import { useMemo, useState } from 'react';
import { CelebrationMark } from './CelebrationMark';
import { Glyph } from './Glyph';
import { Modal } from './Modal';
import { StepIndicator } from './StepIndicator';
import { PaymentReminderModal } from './PaymentReminderModal';
import { CheckBalancesStep } from './CheckBalancesStep';
import { useAccountStore } from '../stores/accountStore';
import { useLoanStore } from '../stores/loanStore';
import { useTransactionStore } from '../stores/transactionStore';
import { usePersonStore } from '../stores/personStore';
import {
  CHECK_STAMP_KEY,
  peopleDelta,
  suggestAction,
  weekFlow,
  type CheckStamp,
} from '../lib/hisaabCheck';
import { localIso, type ThisWeekRow } from '../lib/thisWeek';
import { formatMoney } from '../lib/constants';
import { useT } from '../lib/i18n';
import type { Currency } from '../db';

interface Props {
  open: boolean;
  onClose: () => void;
  // Primary-currency people position, computed on Home (meraHisaab totals —
  // card-funded advances already excluded from payable).
  currency: string;
  receivable: number;
  payable: number;
  thisWeekRows: ThisWeekRow[];
  // Fired when the walk completes and the stamp is written, so Home can
  // refresh its "last done" line without re-reading storage.
  onStamped?: (dateIso: string) => void;
}

function readStamp(): CheckStamp | null {
  try {
    const raw = localStorage.getItem(CHECK_STAMP_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CheckStamp;
    return typeof parsed?.dateIso === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

export function HisaabCheckModal(props: Props) {
  // Fresh walk every open: remount the inner walk (via `key`) each time the
  // sheet opens, rather than resetting state in an effect. Keying on the
  // open/closed boundary itself forces a brand new CheckModalWalk instance
  // on every transition — step/now/stamp/reminderOpen all restart from their
  // lazy initializers — with no ref or effect needed.
  return <CheckModalWalk key={props.open ? 'open' : 'closed'} {...props} />;
}

function CheckModalWalk({ open, onClose, currency, receivable, payable, thisWeekRows, onStamped }: Props) {
  const t = useT();
  const transactions = useTransactionStore((s) => s.transactions);
  const loans = useLoanStore((s) => s.loans);
  const persons = usePersonStore((s) => s.persons);
  // The Balances step only exists when there are accounts to check.
  const hasAccounts = useAccountStore((s) => s.accounts.some((a) => !a.deletedAt));

  const [step, setStep] = useState(0);
  const [now] = useState(() => new Date());
  // Re-read the previous stamp at mount time, BEFORE this session's
  // finishCheck() overwrites it (the delta pane compares against it).
  const [stamp] = useState<CheckStamp | null>(() => readStamp());
  const [reminderOpen, setReminderOpen] = useState(false);

  const flow = useMemo(() => weekFlow(transactions, currency, now), [transactions, currency, now]);
  const delta = useMemo(
    () => peopleDelta({ receivable, payable }, stamp, currency),
    [receivable, payable, stamp, currency],
  );
  // One PERSON and everything they owe you in that currency — never a single
  // loan of theirs (src/lib/hisaabCheck.ts has the rule and the ordering).
  const suggested = useMemo(() => suggestAction(loans, now), [loans, now]);
  // Their contact, when the loans point at one: the current name and number
  // (that contact's number only — with none saved, the reminder offers to add
  // it). A name-only person falls back to a same-name contact's number, the
  // rule the Loans person sheet uses (LoansPage.groupPhone).
  const suggestedContact = useMemo(
    () => (suggested?.personId ? persons.find((p) => p.id === suggested.personId) ?? null : null),
    [suggested, persons],
  );
  const suggestedName = suggestedContact?.name || suggested?.personName || '';
  const suggestedPhone = useMemo(() => {
    if (!suggested) return null;
    if (suggested.personId) return suggestedContact?.phone ?? null;
    const nameKey = suggested.personName.trim().toLowerCase();
    return persons.find((p) => p.name.trim().toLowerCase() === nameKey)?.phone ?? null;
  }, [suggested, suggestedContact, persons]);

  const finishCheck = () => {
    // LOCAL calendar date — daysSince parses the stamp as local midnight, and
    // a 00:30 check must read "Done today", not "1 day ago" (UTC lags this
    // app's Gulf/Pakistan markets by 4-5h).
    const dateIso = localIso(new Date());
    try {
      const next: CheckStamp = { dateIso, receivable, payable, currency };
      localStorage.setItem(CHECK_STAMP_KEY, JSON.stringify(next));
    } catch {
      // Storage off — the walk still completes, it just won't be remembered.
    }
    onStamped?.(dateIso);
    setStep(5);
  };

  const signed = (n: number) => `${n >= 0 ? '+' : '−'}${formatMoney(Math.abs(n), currency)}`;
  const noDelta = delta !== null && Math.abs(delta.receivable) < 0.005 && Math.abs(delta.payable) < 0.005;

  // Steps: 0 flow · 1 people · 2 balances · 3 week ahead · 4 one action · 5 done.
  // With no accounts the Balances step is stepped over in both directions.
  const stepLabels = [t('check_step_flow'), t('check_step_people'), t('check_step_balances'), t('check_step_week'), t('check_step_action')];
  const next = (from: number) => (from === 1 && !hasAccounts ? 3 : from + 1);
  const prev = (from: number) => (from === 3 && !hasAccounts ? 1 : from - 1);

  return (
    <>
    <Modal
      open={open}
      onClose={onClose}
      title={t('check_entry_title')}
      footer={
        step < 5 ? (
          <div className="flex gap-2">
            {step > 0 && (
              <button onClick={() => setStep(prev(step))} className="cta-secondary flex-1">
                {t('check_back')}
              </button>
            )}
            <button
              onClick={() => (step === 4 ? finishCheck() : setStep(next(step)))}
              className="cta-primary flex-1"
            >
              {step === 4 ? t('check_finish') : t('check_next')}
            </button>
          </div>
        ) : (
          <button onClick={onClose} className="cta-primary w-full">
            {t('check_finish')}
          </button>
        )
      }
    >
      {step < 5 && (
        <div className="mb-4">
          <StepIndicator steps={stepLabels} current={step} />
        </div>
      )}

      {/* 1 — last 7 days: real in/out, shuffling excluded. */}
      {step === 0 && (
        <div className="animate-fade-in space-y-3">
          <div>
            <p className="text-[14px] font-semibold text-ink-900 tracking-tight">{t('check_flow_title')}</p>
            <p className="text-[11.5px] text-ink-500 mt-0.5 leading-relaxed">{t('check_flow_sub')}</p>
          </div>
          <div className="grid grid-cols-2 gap-2.5">
            <div className="m-card m-mint rounded-[16px] p-3.5 min-w-0">
              <div className="flex items-center gap-2">
                <span className="m-stat-dot m-stat-dot-receive" aria-hidden>
                  <Glyph name="arrow-down" size={14} strokeWidth={3} />
                </span>
                <p className="text-[10.5px] font-semibold text-receive-text uppercase tracking-[0.1em]">
                  {t('check_in_label')}
                </p>
              </div>
              <p className="text-[21px] font-semibold text-ink-900 tabular-nums tracking-[-0.03em] mt-2.5 truncate">
                {formatMoney(flow.moneyIn, currency)}
              </p>
            </div>
            <div className="m-card m-coral rounded-[16px] p-3.5 min-w-0">
              <div className="flex items-center gap-2">
                <span className="m-stat-dot m-stat-dot-pay" aria-hidden>
                  <Glyph name="arrow-up" size={14} strokeWidth={3} />
                </span>
                <p className="text-[10.5px] font-semibold text-pay-text uppercase tracking-[0.1em]">
                  {t('check_out_label')}
                </p>
              </div>
              <p className="text-[21px] font-semibold text-ink-900 tabular-nums tracking-[-0.03em] mt-2.5 truncate">
                {formatMoney(flow.moneyOut, currency)}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* 2 — people: receivable/payable now, delta vs the last check. */}
      {step === 1 && (
        <div className="animate-fade-in space-y-3">
          <p className="text-[14px] font-semibold text-ink-900 tracking-tight">{t('check_people_title')}</p>
          <div className="m-card divide-y divide-cream-hairline">
            <div className="flex items-center justify-between px-3.5 py-3">
              <span className="text-[12.5px] text-ink-600">{t('check_receivable')}</span>
              <span className="text-right">
                <span className="text-[14px] font-semibold text-receive-text tabular-nums">
                  {formatMoney(receivable, currency)}
                </span>
                {delta !== null && Math.abs(delta.receivable) > 0.005 && (
                  <span className="block text-[10px] text-ink-400 tabular-nums">
                    {signed(delta.receivable)} {t('check_since_last')}
                  </span>
                )}
              </span>
            </div>
            <div className="flex items-center justify-between px-3.5 py-3">
              <span className="text-[12.5px] text-ink-600">{t('check_payable')}</span>
              <span className="text-right">
                <span className="text-[14px] font-semibold text-pay-text tabular-nums">
                  {formatMoney(payable, currency)}
                </span>
                {delta !== null && Math.abs(delta.payable) > 0.005 && (
                  <span className="block text-[10px] text-ink-400 tabular-nums">
                    {signed(delta.payable)} {t('check_since_last')}
                  </span>
                )}
              </span>
            </div>
          </div>
          <p className="text-[11px] text-ink-500 leading-relaxed">
            {delta === null ? t('check_first_time') : noDelta ? t('check_no_change') : null}
          </p>
        </div>
      )}

      {/* Balances — does each account still match the bank app? */}
      {step === 2 && <CheckBalancesStep />}

      {/* 3 — the week ahead: Home's thisWeek rows, read-only. */}
      {step === 3 && (
        <div className="animate-fade-in space-y-3">
          <p className="text-[14px] font-semibold text-ink-900 tracking-tight">{t('check_week_title')}</p>
          {thisWeekRows.length === 0 ? (
            <div className="m-card m-mint p-4 flex items-center gap-2.5">
              <Glyph name="check" size={18} tone="green" />
              <p className="text-[12.5px] font-medium text-receive-text">{t('check_week_clear')}</p>
            </div>
          ) : (
            <div className="m-card divide-y divide-cream-hairline">
              {thisWeekRows.slice(0, 5).map((row) => (
                <div key={row.id} className="flex items-center gap-2.5 px-3.5 py-2.5">
                  <div className="m-ctl w-8 h-8 rounded-[10px] flex items-center justify-center shrink-0">
                    {row.sub.kind === 'cleared' ? (
                      <Glyph name="check" size={14} tone="green" />
                    ) : (
                      <Glyph name="calendar" size={14} tone={row.daysUntil <= 1 ? 'gold' : 'blue'} />
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-[12.5px] font-medium text-ink-900 truncate tracking-tight">{row.label}</p>
                    <p className={`text-[10px] ${row.sub.kind === 'cleared' ? 'text-receive-text font-medium' : 'text-ink-500'}`}>
                      {row.sub.kind === 'cleared'
                        ? (row.sub.daysEarly === 0 ? t('tw_cleared_today') : t('tw_cleared').replace('{n}', String(row.sub.daysEarly)))
                        : row.daysUntil === 0 ? t('cc_due_today') : t('cc_due_in').replace('{n}', String(row.daysUntil))}
                    </p>
                  </div>
                  {row.amount !== null && (
                    <p className={`text-[12.5px] font-semibold tabular-nums ${row.direction === 'receive' ? 'text-receive-text' : 'text-ink-900'}`}>
                      {row.direction === 'receive' ? '+' : ''}{formatMoney(row.amount, row.currency)}
                    </p>
                  )}
                </div>
              ))}
              {thisWeekRows.length > 5 && (
                <p className="px-3.5 py-2 text-[10.5px] text-ink-400">
                  {t('home_week_more').replace('{n}', String(thisWeekRows.length - 5))}
                </p>
              )}
            </div>
          )}
        </div>
      )}

      {/* 4 — one action: the person who has owed you longest, for their
          whole balance, WhatsApp one tap away. Nothing nag-worthy → say so
          and let the user finish clean. */}
      {step === 4 && (
        <div className="animate-fade-in space-y-3">
          <p className="text-[14px] font-semibold text-ink-900 tracking-tight">{t('check_action_title')}</p>
          {suggested ? (
            <div className="m-card p-4 space-y-3.5">
              <p className="text-[13px] text-ink-800 leading-relaxed">
                {(suggested.loanCount > 1 ? t('check_action_body_many') : t('check_action_body'))
                  .replace('{name}', suggestedName)
                  .replace('{amount}', formatMoney(suggested.remaining, suggested.currency))
                  .replace('{n}', String(suggested.loanCount))
                  .replace('{days}', String(suggested.daysOpen))}
              </p>
              <button
                onClick={() => setReminderOpen(true)}
                className="m-btn m-btn-primary w-full text-[13px]"
              >
                <Glyph name="bell" size={15} />
                {t('check_action_remind')}
              </button>
            </div>
          ) : (
            <div className="m-card m-mint p-4 flex items-center gap-2.5">
              <Glyph name="check" size={18} tone="green" />
              <p className="text-[12.5px] font-medium text-receive-text leading-relaxed">{t('check_action_none')}</p>
            </div>
          )}
        </div>
      )}

      {/* Done — the ritual's payoff phrase. The mark DRAWS itself here
          rather than appearing: this is the one screen in the app that
          exists purely to say "you're clear", and a tick that completes in
          front of the user is what makes a daily habit feel earned. No
          confetti, though: the burst is reserved for a debt actually closing
          (ConfirmationSheet `settled`), and one that fired every day would
          turn into a tic. */}
      {step === 5 && (
        <div className="animate-fade-in flex flex-col items-center text-center py-6">
          <CelebrationMark size={56} className="mb-3" burst={false} />
          <p className="text-[17px] font-bold text-ink-900 tracking-tight">{t('check_done_title')}</p>
          <p className="text-[12px] text-ink-500 mt-1.5 leading-relaxed max-w-[240px]">{t('check_done_body')}</p>
        </div>
      )}

    </Modal>

    {/* Sibling of the sheet, NOT a child: the sheet's translate transform
        would otherwise become the containing block for this fixed overlay
        and clip it inside the scrollable modal body. */}
    {suggested && (
      <PaymentReminderModal
        open={reminderOpen}
        onClose={() => setReminderOpen(false)}
        personName={suggestedName}
        // The person's TOTAL across their open loans, dated from the oldest.
        amount={suggested.remaining}
        currency={suggested.currency as Currency}
        direction="receivable"
        startedAt={suggested.sinceIso}
        // suggestAction ranks by how long the person has owed, not EMI due
        // dates — never call an open-ended udhaar "overdue" (neutral "open
        // for N days").
        hasDueDate={false}
        phone={suggestedPhone}
        personId={suggested.personId}
      />
    )}
    </>
  );
}
