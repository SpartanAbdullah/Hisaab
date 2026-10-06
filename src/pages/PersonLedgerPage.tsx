// Person ledger — every loan and repayment with ONE person, each with the
// balance after it, month by month (2026-10-06, the Ghulam exercise: "each
// transaction should mention the total increasing or decreasing").
//
// Read from the user's own side. Built from the same pure engine as the PDF
// (statementOfAccount → statementRows), so what this screen shows and what
// the PDF prints can never disagree:
//   - a lump payment the allocation flow fanned out across loans reads as ONE
//     row with before → after, expandable to the loans it cleared;
//   - what is awaiting confirmation is shown next to the total, never in it;
//   - a loan mirrored twice by a double sync is labelled, not hidden.
// Works in both app modes: the engine synthesises ledger-only history from the
// loans themselves (estimated lines), and nothing here needs an account.

import { useCallback, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { FileQuestion } from 'lucide-react';
import { NavyHero, TopBar } from '../components/NavyHero';
import { MoneyDisplay } from '../components/MoneyDisplay';
import { Glyph } from '../components/Glyph';
import { EmptyState } from '../components/EmptyState';
import { ListSkeleton } from '../components/ListSkeleton';
import { PageErrorState } from '../components/PageErrorState';
import { SendStatementModal } from '../components/SendStatementModal';
import { useAsyncLoad } from '../hooks/useAsyncLoad';
import { usePersonLedgerExtras } from '../hooks/usePersonLedgerExtras';
import { formatMoney } from '../lib/constants';
import { useT } from '../lib/i18n';
import { loansForPerson } from '../lib/personLoans';
import type { PendingItem } from '../lib/pendingLedger';
import { buildStatement, type StatementLine, type StatementLineKind, type StatementSection } from '../lib/statementOfAccount';
import {
  groupByMonth,
  groupRepaymentBursts,
  monthLabel,
  sectionOrientation,
  summarizeSection,
  type DisplayRow,
} from '../lib/statementRows';
import { describeStatementLine, fillTemplate, netBalanceLabel } from '../lib/statementText';
import { useLoanStore } from '../stores/loanStore';
import { usePersonStore } from '../stores/personStore';
import { useTransactionStore } from '../stores/transactionStore';
import type { Currency } from '../db';

// What a pending item WOULD record, from the user's side: a new loan (I lent:
// +, I borrowed: −) or a repayment (on a loan I gave: −, on one I took: +).
function pendingKind(item: PendingItem): StatementLineKind {
  if (item.source === 'loan') return item.delta > 0 ? 'loan_given' : 'loan_taken';
  return item.delta < 0 ? 'repayment_received' : 'repayment_paid';
}

function shortDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
}

export function PersonLedgerPage() {
  const { personId } = useParams<{ personId: string }>();
  const navigate = useNavigate();
  const t = useT();
  const loans = useLoanStore((s) => s.loans);
  const loadLoans = useLoanStore((s) => s.loadLoans);
  const persons = usePersonStore((s) => s.persons);
  const loadPersons = usePersonStore((s) => s.loadPersons);
  const transactions = useTransactionStore((s) => s.transactions);
  const loadTransactions = useTransactionStore((s) => s.loadTransactions);
  const ensureTransactionHistory = useTransactionStore((s) => s.ensureTransactionHistory);
  const historyComplete = useTransactionStore((s) => s.historyCoverage.complete);

  // A ledger built on a partial history would understate what was repaid —
  // the same completeness gate as SendStatementModal (docs/performance.md §7).
  const load = useCallback(async () => {
    await Promise.all([loadLoans(), loadPersons(), loadTransactions()]);
    await ensureTransactionHistory({ all: true });
  }, [ensureTransactionHistory, loadLoans, loadPersons, loadTransactions]);
  const { status, error, retry } = useAsyncLoad(load);

  const [asOf] = useState(() => new Date().toISOString());
  const [currency, setCurrency] = useState<Currency | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [showStatement, setShowStatement] = useState(false);

  const person = persons.find((p) => p.id === personId) ?? null;
  const personLoans = useMemo(() => (person ? loansForPerson(loans, person) : []), [loans, person]);
  const extras = usePersonLedgerExtras(person, personLoans);

  const statement = useMemo(() => {
    if (!person || !historyComplete) return null;
    return buildStatement({
      partyName: person.name, loans: personLoans, transactions, asOf, scope: 'contact', detail: 'full',
    });
  }, [asOf, historyComplete, person, personLoans, transactions]);


  if (!person) {
    if (status === 'error') {
      return <PageErrorState title={t('pl_err_load')} message={error ?? ''} onRetry={retry} />;
    }
    if (status === 'loading') return <LedgerSkeleton loadingLabel={t('loading')} />;
    return (
      <main className="min-h-dvh bg-cream-bg pb-28">
        <NavyHero accent="pink">
          <TopBar back />
          <div className="pb-7" />
        </NavyHero>
        <div className="sukoon-body min-h-[60dvh] px-5 pt-5">
          <EmptyState icon={FileQuestion} clayIcon="banknote" tone="pink" title={t('pl_not_found')} description={t('pl_err_load')} />
        </div>
      </main>
    );
  }

  if (!statement) {
    if (status === 'error') {
      return <PageErrorState title={t('pl_err_load')} message={error ?? ''} onRetry={retry} />;
    }
    return <LedgerSkeleton loadingLabel={t('tx_history_loading')} name={person.name} />;
  }

  // The picked currency tab, else the first currency with money still open,
  // else the first one.
  const section: StatementSection | null =
    statement.sections.find((s) => s.currency === currency) ??
    statement.sections.find((s) => Math.abs(s.closing) > 0.005) ??
    statement.sections[0] ??
    null;

  return (
    <main className="min-h-dvh bg-cream-bg pb-28">
      <NavyHero accent="pink">
        <TopBar back title={t('pl_title')} />
        <div className="px-5 pb-6">
          <p className="text-[12px] text-white/70">{person.name}</p>
          {statement.sections.length > 1 && (
            <div className="m-seg flex w-full mt-3">
              {statement.sections.map((s) => (
                <button
                  key={s.currency}
                  type="button"
                  aria-pressed={s.currency === section?.currency}
                  onClick={() => setCurrency(s.currency)}
                  className="flex-1 min-h-[34px] text-[12px]"
                >
                  {s.currency}
                </button>
              ))}
            </div>
          )}
          {section && (
            <>
              <div className="mt-4">
                <MoneyDisplay amount={Math.abs(section.closing)} currency={section.currency} size={38} tone="on-navy" extrude="violet" />
              </div>
              <p className="text-[13px] text-white/80 mt-2">
                {netBalanceLabel(person.name, section.closing, section.currency, formatMoney, t)}
              </p>
            </>
          )}
        </div>
      </NavyHero>

      <div className="sukoon-body min-h-[60dvh] px-5 pt-5 space-y-4">
        {!section ? (
          <p className="m-inset text-[12.5px] text-ink-600 px-3.5 py-3">{t('soa_none').replace('{name}', person.name)}</p>
        ) : (
          <LedgerBody
            section={section}
            personName={person.name}
            extras={extras}
            expanded={expanded}
            onToggle={(key) => setExpanded((prev) => {
              const next = new Set(prev);
              if (next.has(key)) next.delete(key); else next.add(key);
              return next;
            })}
            onOpenInbox={(tab) => navigate('/inbox', { state: { tab } })}
          />
        )}

        <button type="button" onClick={() => setShowStatement(true)} className="m-btn m-btn-primary w-full py-3.5 text-[14px]">
          <Glyph name="document" size={16} /> {t('pl_pdf_cta')}
        </button>
      </div>

      <SendStatementModal
        open={showStatement}
        onClose={() => setShowStatement(false)}
        partyName={person.name}
        loans={personLoans}
        transactions={transactions}
        scope="contact"
        phone={person.phone}
        personId={person.id}
      />
    </main>
  );
}

function LedgerSkeleton({ loadingLabel, name }: { loadingLabel: string; name?: string }) {
  return (
    <main className="min-h-dvh bg-cream-bg pb-28">
      <NavyHero accent="pink">
        <TopBar back />
        <div className="px-5 pb-7" aria-hidden>
          {name ? <p className="text-[12px] text-white/70">{name}</p> : <div className="m-skel h-3 w-28" />}
          <div className="m-skel h-10 w-52 mt-3 rounded-xl" />
          <div className="m-skel h-3 w-40 mt-3" />
        </div>
      </NavyHero>
      <div className="sukoon-body min-h-[60dvh] px-5 pt-5 space-y-4">
        <p className="sr-only" role="status">{loadingLabel}</p>
        <p className="text-[12px] text-ink-600" aria-hidden>{loadingLabel}</p>
        <div className="m-skel h-[96px] rounded-[18px]" aria-hidden />
        <ListSkeleton rows={5} withAvatar={false} />
      </div>
    </main>
  );
}

interface BodyProps {
  section: StatementSection;
  personName: string;
  extras: ReturnType<typeof usePersonLedgerExtras>;
  expanded: ReadonlySet<string>;
  onToggle: (key: string) => void;
  onOpenInbox: (tab: 'incoming' | 'outgoing') => void;
}

function LedgerBody({ section, personName, extras, expanded, onToggle, onOpenInbox }: BodyProps) {
  const t = useT();
  const cur = section.currency;
  const o = sectionOrientation(section);
  const money = (n: number) => formatMoney(Math.abs(n), cur);
  const owed = (n: number) => (n < -0.005 ? `−${money(n)}` : money(n));
  const sum = summarizeSection(section, o);
  const months = groupByMonth(groupRepaymentBursts(section.lines, { batchKeyOf: extras.batchKeyOf }), { orientation: o });
  const bucket = extras.pending.get(cur);
  const reconcile = fillTemplate(t('pl_reconciles'), {
    opening: owed(sum.opening), up: money(sum.up), down: money(sum.down), closing: owed(sum.closing),
  });

  return (
    <>
      {/* The whole story in one line: everything added, everything cleared,
          what's left — and that it adds up. */}
      <div className="m-card p-4">
        <div className="grid grid-cols-3 gap-2">
          <div>
            <p className="m-label">{t('pl_sum_up')}</p>
            <p className="text-[14px] font-semibold text-pay-text tabular-nums mt-1">+{money(sum.up)}</p>
          </div>
          <div>
            <p className="m-label">{t('pl_sum_down')}</p>
            <p className="text-[14px] font-semibold text-receive-text tabular-nums mt-1">−{money(sum.down)}</p>
          </div>
          <div>
            <p className="m-label">{t('pl_sum_left')}</p>
            <p className="text-[14px] font-bold text-ink-900 tabular-nums mt-1">{owed(sum.closing)}</p>
          </div>
        </div>
        <p className="text-[11px] text-ink-600 mt-3 flex items-start gap-1.5">
          <Glyph name="check" tone="green" size={13} className="mt-px shrink-0" />
          <span className="tabular-nums">{reconcile}</span>
        </p>
      </div>

      {/* Awaiting confirmation — shown next to the total, never inside it. */}
      {bucket && bucket.items.length > 0 && (
        <div className="m-card m-gold p-4">
          <p className="text-[12.5px] font-semibold text-ink-900">
            {t('pl_pending_title').replace('{n}', String(bucket.items.length))}
          </p>
          <p className="text-[11px] text-ink-600 mt-0.5">{t('pl_pending_not_counted')}</p>
          <div className="mt-2.5 space-y-1.5">
            {bucket.items.map((item) => {
              const up = o * item.delta > 0;
              return (
                <div key={item.id} className="flex items-start justify-between gap-3 text-[12px]">
                  <div className="min-w-0">
                    <p className="text-ink-900 truncate">{item.note || describeStatementLine({ kind: pendingKind(item) }, t, 'self')}</p>
                    <p className="text-[10.5px] text-ink-600">
                      {shortDate(item.createdAt)} · {item.direction === 'awaiting_me'
                        ? t('pl_pending_awaiting_me')
                        : t('pl_pending_awaiting_them').replace('{name}', personName)}
                    </p>
                  </div>
                  <span className={`shrink-0 font-semibold tabular-nums ${up ? 'text-pay-text' : 'text-receive-text'}`}>
                    {up ? '↑ +' : '↓ −'}{money(item.amount)}
                  </span>
                </div>
              );
            })}
          </div>
          <p className="text-[12px] font-semibold text-ink-900 mt-3 tabular-nums">
            {t('pl_pending_if_accepted').replace('{amount}', owed(o * (section.closing + bucket.totalDelta)))}
          </p>
          <button
            type="button"
            onClick={() => onOpenInbox(bucket.items.some((i) => i.direction === 'awaiting_me') ? 'incoming' : 'outgoing')}
            className="m-btn m-btn-plain w-full py-2.5 text-[12.5px] mt-3"
          >
            <Glyph name="inbox" size={14} tone="violet" /> {t('pl_pending_open_inbox')}
          </button>
        </div>
      )}

      <p className="m-label px-1">{t('pl_newest_first')}</p>
      {[...months].reverse().map((block) => (
        <section key={block.monthKey} className="m-card p-0 overflow-hidden" aria-label={monthLabel(block.monthKey)}>
          <header className="px-4 pt-3 pb-2.5 border-b border-cream-hairline flex items-baseline justify-between gap-3">
            <div>
              <h2 className="text-[13.5px] font-semibold text-ink-900">{monthLabel(block.monthKey)}</h2>
              <p className="text-[10.5px] text-ink-600 tabular-nums mt-0.5">
                {block.up > 0.005 && <span className="text-pay-text">+{money(block.up)}</span>}
                {block.up > 0.005 && block.down > 0.005 && ' · '}
                {block.down > 0.005 && <span className="text-receive-text">−{money(block.down)}</span>}
              </p>
            </div>
            <p className="text-[11px] text-ink-700 tabular-nums text-right">
              {t('pl_month_flow').replace('{from}', owed(block.opening)).replace('{to}', owed(block.closing))}
            </p>
          </header>
          <ul className="divide-y divide-cream-hairline">
            {[...block.rows].reverse().map((row) => (
              <LedgerRow
                key={row.key}
                row={row}
                o={o}
                money={money}
                owed={owed}
                duplicates={extras.duplicateLoanIds}
                open={expanded.has(row.key)}
                onToggle={() => onToggle(row.key)}
              />
            ))}
          </ul>
        </section>
      ))}

      {section.estimated && (
        <p className="text-[10.5px] text-ink-600 px-1 leading-relaxed">{t('stmt_estimated_note')}</p>
      )}
    </>
  );
}

interface RowProps {
  row: DisplayRow;
  o: 1 | -1;
  money: (n: number) => string;
  owed: (n: number) => string;
  duplicates: ReadonlyMap<string, number>;
  open: boolean;
  onToggle: () => void;
}

function LedgerRow({ row, o, money, owed, duplicates, open, onToggle }: RowProps) {
  const t = useT();
  const up = o * row.delta > 0.005;
  const down = o * row.delta < -0.005;
  const change = up
    ? <span className="text-pay-text" aria-label={t('pl_row_up')}>↑ +{money(row.delta)}</span>
    : down
      ? <span className="text-receive-text" aria-label={t('pl_row_down')}>↓ −{money(row.delta)}</span>
      : null;
  const after = t('pl_row_balance_after').replace('{amount}', owed(o * row.balanceAfter));

  if (row.type === 'burst') {
    const note = (row.children[0]?.note ?? '').trim();
    return (
      <li className="px-4 py-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[13px] font-semibold text-ink-900">
              {describeStatementLine({ kind: row.kind }, t, 'self')} · {fillTemplate(t('stmt_pdf_burst'), { n: row.count })}
            </p>
            <p className="text-[10.5px] text-ink-600 mt-0.5">{shortDate(row.date)}{note ? ` · ${note}` : ''}</p>
          </div>
          <div className="text-right shrink-0">
            <p className="text-[13px] font-bold tabular-nums">{change}</p>
            <p className="text-[10.5px] text-ink-700 tabular-nums mt-0.5">{after}</p>
          </div>
        </div>
        <button
          type="button"
          aria-expanded={open}
          onClick={onToggle}
          className="mt-2 text-accent-600 text-[11.5px] font-semibold min-h-[32px] flex items-center gap-1"
        >
          <Glyph name={open ? 'chevron-up' : 'chevron-down'} size={13} /> {open ? t('pl_burst_hide') : t('pl_burst_show')}
        </button>
        {open && (
          <ul className="mt-1.5 m-inset rounded-xl px-3 py-1.5 space-y-1">
            {row.children.map((child) => (
              <BurstChild key={child.txnId ?? child.date} line={child} money={money} duplicate={!!child.loanId && duplicates.has(child.loanId)} />
            ))}
          </ul>
        )}
      </li>
    );
  }

  const line = row.line;
  const kindLabel = describeStatementLine(line, t, 'self');
  const title = line.note || kindLabel;
  const duplicate = !!line.loanId && duplicates.has(line.loanId);
  return (
    <li className="px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[13px] text-ink-900 truncate">{title}</p>
          <p className="text-[10.5px] text-ink-600 mt-0.5">
            {shortDate(line.date)}{line.note ? ` · ${kindLabel}` : ''}
          </p>
          {duplicate && (
            <p className="mt-1 text-[10.5px] text-ink-700 flex items-start gap-1">
              <Glyph name="info" size={12} tone="blue" className="mt-px shrink-0" />
              <span><b className="font-semibold">{t('pl_duplicate_chip')}</b> — {t('pl_duplicate_hint')}</span>
            </p>
          )}
        </div>
        <div className="text-right shrink-0">
          <p className="text-[13px] font-semibold tabular-nums">{change}</p>
          <p className="text-[10.5px] text-ink-700 tabular-nums mt-0.5">{after}</p>
        </div>
      </div>
    </li>
  );
}

function BurstChild({ line, money, duplicate }: { line: StatementLine; money: (n: number) => string; duplicate: boolean }) {
  const t = useT();
  const what = line.loanNote || line.note || describeStatementLine(line, t, 'self');
  return (
    <li className="flex items-start justify-between gap-3 text-[11.5px] py-1">
      <div className="min-w-0">
        <p className="text-ink-800 truncate">↳ {what}</p>
        {line.loanRemainingAfter !== undefined && (
          <p className="text-[10px] text-ink-600 tabular-nums">
            {t('pl_burst_child_left').replace('{amount}', money(line.loanRemainingAfter))}
            {duplicate ? ` · ${t('pl_duplicate_chip')}` : ''}
          </p>
        )}
      </div>
      <span className="shrink-0 tabular-nums text-ink-800">{money(line.delta)}</span>
    </li>
  );
}
