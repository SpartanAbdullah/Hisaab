import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Glyph } from './Glyph';
import type { GlyphName, GlyphTone } from '../lib/glyphs';
import { skeletonDelay } from '../lib/material';
import { useAccountStore } from '../stores/accountStore';
import { useTransactionStore } from '../stores/transactionStore';
import { useLoanStore } from '../stores/loanStore';
import { useSplitStore } from '../stores/splitStore';
import { groupExpensesDb } from '../lib/supabaseDb';
import { formatMoney } from '../lib/constants';
import { useT } from '../lib/i18n';
import { useBackStackLayer } from '../hooks/useBackStackLayer';
import type { Currency, GroupExpense } from '../db';

interface Props {
  open: boolean;
  onClose: () => void;
}

type SearchResult = {
  id: string;
  title: string;
  meta: string;
  /** Stable English scope id — groups the rows and stays searchable ("loan"
   *  finds loans in either language). `scopeLabel` is what the user sees. */
  scope: string;
  scopeLabel: string;
  href: string;
  /** 3c glyph + its domain tone: transactions violet, loans pink (khata),
   *  group expenses blue (splits). */
  glyph: GlyphName;
  tone: GlyphTone;
  terms: string;
};

const normalize = (value: string) => value.trim().toLowerCase();

export function GlobalSearch({ open, onClose }: Props) {
  const navigate = useNavigate();
  const t = useT();
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [groupExpenses, setGroupExpenses] = useState<GroupExpense[]>([]);
  const [loading, setLoading] = useState(false);

  const { accounts, loadAccounts } = useAccountStore();
  const { transactions, loadTransactions } = useTransactionStore();
  const { loans, loadLoans } = useLoanStore();
  const { groups, loadGroups } = useSplitStore();

  useEffect(() => {
    if (!open) return;
    const focusTimer = window.setTimeout(() => {
      setQuery('');
      setLoading(true);
      inputRef.current?.focus();
    }, 80);
    let cancelled = false;
    Promise.all([
      loadAccounts().catch(() => undefined),
      loadTransactions().catch(() => undefined),
      loadLoans().catch(() => undefined),
      loadGroups().catch(() => undefined),
      groupExpensesDb.getAllVisible().catch(() => [] as GroupExpense[]),
    ]).then(([, , , , visibleGroupExpenses]) => {
      if (cancelled) return;
      setGroupExpenses(visibleGroupExpenses ?? []);
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => {
      cancelled = true;
      window.clearTimeout(focusTimer);
    };
  }, [
    open,
    loadAccounts,
    loadTransactions,
    loadLoans,
    loadGroups,
  ]);

  // Audit MF-08: a back press with search open used to fall through to the
  // route underneath.
  useBackStackLayer(open, onClose, 'global-search');

  // Localized labels resolved per render (cheap lookups) and handed to the
  // memo as plain strings: `t` itself is a new function every render, so
  // depending on it would rebuild every row on every keystroke.
  const scopeTxnLabel = t('gs_scope_txn');
  const scopeLoanLabel = t('gs_scope_loan');
  const scopeGroupExpenseLabel = t('gs_scope_group_expense');
  const receivableLabel = t('check_receivable');
  const payableLabel = t('check_payable');
  const someoneLabel = t('ntf_someone');
  const groupFallbackLabel = t('gs_group_fallback');
  const paidByLabel = t('group_paid_by_short');

  const groupById = useMemo(() => new Map(groups.map((group) => [group.id, group])), [groups]);
  const accountById = useMemo(() => new Map(accounts.map((account) => [account.id, account])), [accounts]);

  const results = useMemo<SearchResult[]>(() => {
    const rows: SearchResult[] = [];

    for (const transaction of transactions) {
      const source = transaction.sourceAccountId ? accountById.get(transaction.sourceAccountId)?.name : '';
      const destination = transaction.destinationAccountId ? accountById.get(transaction.destinationAccountId)?.name : '';
      rows.push({
        id: `transaction-${transaction.id}`,
        title: transaction.category || transaction.type.replace(/_/g, ' '),
        meta: `${formatMoney(transaction.amount, transaction.currency)} · ${source || destination || transaction.type}`,
        scope: 'Transaction',
        scopeLabel: scopeTxnLabel,
        href: '/transactions',
        glyph: 'receipt',
        tone: 'violet',
        terms: `${transaction.type} ${transaction.category} ${transaction.notes} ${transaction.relatedPerson ?? ''} ${source ?? ''} ${destination ?? ''} ${transaction.amount} ${transaction.currency}`,
      });
    }

    for (const loan of loans) {
      rows.push({
        id: `loan-${loan.id}`,
        title: loan.personName,
        meta: `${loan.type === 'given' ? receivableLabel : payableLabel} · ${formatMoney(loan.remainingAmount, loan.currency)}`,
        scope: 'Loan',
        scopeLabel: scopeLoanLabel,
        href: `/loan/${loan.id}`,
        glyph: 'banknote',
        tone: 'pink',
        terms: `${loan.personName} ${loan.notes} ${loan.type} loan ${loan.totalAmount} ${loan.remainingAmount} ${loan.currency}`,
      });
    }

    for (const group of groups) {
      for (const expense of groupExpenses.filter(item => item.groupId === group.id)) {
      const group = groupById.get(expense.groupId);
      const paidBy = group?.members.find((member) => member.id === expense.paidBy)?.name ?? someoneLabel;
      const currency = (group?.currency ?? 'AED') as Currency;
      rows.push({
        id: `group-expense-${expense.id}`,
        title: expense.description,
        meta: `${group?.name ?? groupFallbackLabel} · ${paidByLabel} ${paidBy} · ${formatMoney(expense.amount, currency)}`,
        scope: 'Group expense',
        scopeLabel: scopeGroupExpenseLabel,
        href: `/group/${expense.groupId}`,
        glyph: 'split',
        tone: 'blue',
        terms: `${expense.description} ${expense.category} ${expense.notes} ${paidBy} ${group?.name ?? ''} ${expense.amount}`,
      });
      }
    }

    return rows;
  }, [
    accountById, transactions, loans, groups, groupExpenses, groupById,
    scopeTxnLabel, scopeLoanLabel, scopeGroupExpenseLabel, receivableLabel,
    payableLabel, someoneLabel, groupFallbackLabel, paidByLabel,
  ]);

  const trimmedQuery = query.trim();
  const isEmptyQuery = trimmedQuery.length === 0;

  const visibleResults = useMemo(() => {
    const needle = normalize(query);
    if (!needle) return results.slice(0, 12);
    const tokens = needle.split(/\s+/).filter(Boolean);
    return results
      .filter((result) => {
        const haystack = normalize(`${result.title} ${result.meta} ${result.scope} ${result.terms}`);
        return tokens.every((token) => haystack.includes(token));
      })
      .slice(0, 40);
  }, [query, results]);

  // Group the visible rows by scope so the list reads as labelled sections
  // ("Transactions", "Loans", "Group expenses") instead of one flat stream.
  // Insertion order of the map preserves the scope order rows first appear in.
  const groupedResults = useMemo(() => {
    const map = new Map<string, SearchResult[]>();
    for (const result of visibleResults) {
      const bucket = map.get(result.scope);
      if (bucket) bucket.push(result);
      else map.set(result.scope, [result]);
    }
    return [...map.entries()];
  }, [visibleResults]);

  if (!open) return null;

  // 1d: the modal scrim over the page, a sheet-coloured panel with a lit top
  // edge, the sunken search well, and results as hairline rows inside one
  // card per scope — each keyed by its domain glyph on a raised square.
  return (
    <div className="fixed inset-0 z-50 backdrop-blur-sm" style={{ background: 'var(--m-scrim)' }}>
      <div className="min-h-dvh flex items-start justify-center px-4 pt-5">
        <div
          className="w-full max-w-[480px] rounded-[22px] bg-cream-bg overflow-hidden animate-fade-in"
          style={{ boxShadow: 'inset 0 1px 0 var(--m-sheet-hi), 0 24px 60px -20px var(--m-shadow)' }}
        >
          <div className="flex items-center gap-2.5 p-3 border-b border-cream-hairline">
            <div className="relative flex-1">
              <Glyph
                name="search"
                size={15}
                className="absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-400 pointer-events-none z-[1]"
              />
              <input
                ref={inputRef}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t('search_scope_placeholder')}
                className="input-field h-11 py-0 pl-10 pr-3 font-medium"
              />
            </div>
            <button
              type="button"
              onClick={onClose}
              className="m-ctl w-11 h-11 shrink-0 flex items-center justify-center"
              aria-label={t('a11y_close_search')}
            >
              <Glyph name="close" size={16} className="text-ink-600" />
            </button>
          </div>

          <div className="max-h-[72dvh] overflow-y-auto px-3 pt-3.5 pb-4">
            {loading && results.length === 0 ? (
              // Skeleton in the final geometry — a scope label over a card of
              // icon-square rows — so nothing jumps when the rows land.
              <div role="status">
                <span className="sr-only">{t('gs_searching')}</span>
                <div aria-hidden="true">
                  <div className="m-skel h-[10px] w-24 ml-1 mb-2.5" />
                  <div className="m-card overflow-hidden divide-y divide-cream-hairline">
                    {[0, 1, 2].map((i) => (
                      <div
                        key={i}
                        className="flex items-center gap-3 px-3.5 py-3"
                        style={{ '--m-skel-delay': skeletonDelay(i) } as React.CSSProperties}
                      >
                        <div className="m-skel w-9 h-9 rounded-[12px] shrink-0" />
                        <div className="flex-1 min-w-0">
                          <div className="m-skel h-[11px] w-[55%]" />
                          <div className="m-skel h-[9px] w-[35%] mt-2" />
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            ) : visibleResults.length === 0 ? (
              isEmptyQuery ? (
                /* Empty query, nothing to recall yet — tell the user what
                   Search reaches across so the blank box isn't a dead end. */
                <p className="text-center text-[12px] text-ink-600 py-8 px-4 leading-relaxed">
                  {t('search_covers')}
                </p>
              ) : (
                <p className="text-center text-[12px] text-ink-600 py-8 px-4 leading-relaxed">
                  {t('search_no_matches').replace('{q}', trimmedQuery)} {t('search_covers')}
                </p>
              )
            ) : (
              <div className="space-y-4">
                {/* On an empty query the list is the most recent activity —
                    label it so the user knows these aren't search matches. */}
                {isEmptyQuery && (
                  <p className="m-label px-1 -mb-1.5">
                    {t('search_recent')}
                  </p>
                )}
                {groupedResults.map(([scope, rows]) => (
                  <div key={scope}>
                    {/* Scope section header — replaces the per-row chip so the
                        scope label reads at >=10px and the list is grouped. */}
                    <p className="m-label px-1 mb-2">
                      {rows[0]?.scopeLabel ?? scope}
                    </p>
                    <div className="m-card overflow-hidden divide-y divide-cream-hairline">
                      {rows.map((result) => (
                        <button
                          key={result.id}
                          type="button"
                          onClick={() => {
                            navigate(result.href);
                            onClose();
                          }}
                          className="w-full px-3.5 py-3 flex items-center gap-3 text-left active:bg-cream-soft transition-colors"
                        >
                          <div className="m-ctl w-9 h-9 flex items-center justify-center shrink-0" aria-hidden>
                            <Glyph name={result.glyph} tone={result.tone} size={17} />
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className="text-[13.5px] font-semibold text-ink-900 truncate tracking-tight">{result.title}</p>
                            <p className="text-[11px] text-ink-600 truncate mt-0.5 tabular-nums">{result.meta}</p>
                          </div>
                          <Glyph name="chevron-right" size={14} className="text-ink-400" />
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
