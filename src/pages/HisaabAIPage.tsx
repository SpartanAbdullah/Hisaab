import { useCallback, useMemo, useRef, useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
// Ghost has no 3c glyph — it stays lucide, matched to the set (2.4 stroke,
// glyph token colour).
import { Ghost } from 'lucide-react';
import { NavyHero } from '../components/NavyHero';
import { Glyph } from '../components/Glyph';
import { useAccountStore } from '../stores/accountStore';
import { useTransactionStore } from '../stores/transactionStore';
import { useRecurringStore } from '../stores/recurringStore';
import { useLoanStore } from '../stores/loanStore';
import { useBudgetStore } from '../stores/budgetStore';
import { useAsyncLoad } from '../hooks/useAsyncLoad';
import { PageErrorState } from '../components/PageErrorState';
import { useToast } from '../components/Toast';
import { useT } from '../lib/i18n';
import { formatMoney } from '../lib/constants';
import { groupAccountsByType } from '../lib/accountGroups';
import { useCategoryOptions } from '../lib/mergedCategories';
import { type ParsedExpense, type Direction } from '../lib/nlExpenseParser';
import { pickAccountForDraft, buildTransactionFromDraft } from '../lib/nlExpenseToTransaction';
import { routeAssistantInput } from '../lib/hisaabAssistant';
import type { ParsedQuery } from '../lib/nlQuery';
import type { ParsedGroupExpense } from '../lib/nlGroupExpenseParser';
import { equalSplits } from '../lib/splitMath';
import { parseAmountExpression } from '../lib/parseAmountExpression';
import { upcomingRenewals, detectGhosts, describeGhost } from '../lib/subscriptionMetrics';
import { computeCloseStreak } from '../lib/dailyClose';
import { useDailyCloseStore } from '../stores/dailyCloseStore';
import { suggestCategory, type HistoryTxn } from '../lib/categorySuggest';
import { getPersona, setPersona, flavor, type Persona } from '../lib/persona';
import { spendAnchor } from '../lib/spendAnchor';
import { useAppModeStore } from '../stores/appModeStore';
import { useSplitStore } from '../stores/splitStore';
import { getActiveGroupMembers } from '../lib/groupActiveMembers';
import { getPrimaryCurrency } from '../lib/primaryCurrency';
import { localIso, localMonthIso } from '../lib/localDate';
import { useVisualViewportInset } from '../hooks/useVisualViewportInset';
import { track } from '../lib/telemetry';
import { bucketAmount, bucketCount } from '../lib/telemetryEvents';
import type { Account, SplitGroup } from '../db';

const EXAMPLE_PROMPTS = ['add 3 aed for karak', 'How much was my income this month?', 'Which card did I spend most from?', 'How do subscriptions work?'];
const SPLITS_EXAMPLES = ['How do I split a bill?', 'How do I settle up?', 'Should I use Full Tracker?'];

// When a data answer maps to a drillable view we attach a "view link": either
// the category-insight page or the transactions list. Threaded through the ai
// Msg so the bubble can render a "View these N transactions" chip under it.
type ViewLink =
  | { kind: 'category'; category: string; count: number }
  | { kind: 'transactions'; count: number };

type Msg =
  | { id: number; role: 'user'; text: string }
  | { id: number; role: 'ai'; text: string; suggestions?: string[]; viewLink?: ViewLink }
  | { id: number; role: 'chip'; draft: ParsedExpense; resolved?: string }
  | { id: number; role: 'groupchip'; draft: ParsedGroupExpense; groupId: string; resolved?: string };

function currentUserId(): string {
  return localStorage.getItem('hisaab_supabase_uid') ?? '';
}

// Fuzzy-match a parsed group-name hint against the user's groups.
function matchGroups(hint: string | null, groups: SplitGroup[]): SplitGroup[] {
  if (!hint) return [];
  const h = hint.toLowerCase();
  return groups.filter((g) => g.name.toLowerCase().includes(h) || h.includes(g.name.toLowerCase()));
}

function primaryCurrency(): string {
  return getPrimaryCurrency();
}

// First name for warm, sparing personalization (greeting only — research says
// name-on-every-line reads as creepy). Empty string when unknown → drops out gracefully.
function firstName(): string {
  return (localStorage.getItem('hisaab_user_name') ?? '').trim().split(/\s+/)[0] || '';
}

// Returns an i18n key resolved at the call site (this fn is module-level and
// can't use the useT hook). English → "Good Morning/Afternoon/Evening";
// Roman Urdu keeps its warmer greetings.
function timeGreetingKey(): 'greet_morning' | 'greet_afternoon' | 'greet_evening' {
  const h = new Date().getHours();
  if (h < 12) return 'greet_morning';
  if (h < 17) return 'greet_afternoon';
  return 'greet_evening';
}

export function HisaabAIPage() {
  const accounts = useAccountStore((s) => s.accounts);
  const loadAccounts = useAccountStore((s) => s.loadAccounts);
  const transactions = useTransactionStore((s) => s.transactions);
  const loadTransactions = useTransactionStore((s) => s.loadTransactions);
  const processTransaction = useTransactionStore((s) => s.processTransaction);
  const groups = useSplitStore((s) => s.groups);
  const loadGroups = useSplitStore((s) => s.loadGroups);
  const addGroupExpense = useSplitStore((s) => s.addGroupExpense);
  const templates = useRecurringStore((s) => s.templates);
  const loadTemplates = useRecurringStore((s) => s.loadTemplates);
  const loans = useLoanStore((s) => s.loans);
  const loadLoans = useLoanStore((s) => s.loadLoans);
  const budgets = useBudgetStore((s) => s.budgets);
  const loadBudgets = useBudgetStore((s) => s.loadBudgets);
  const mode = useAppModeStore((s) => s.mode);
  const isFull = mode === 'full_tracker';
  const greetName = firstName();
  // Audit MF-02: the composer is `position: fixed` with a hard-coded
  // `bottom`, pinned to the (keyboard-unaware) layout viewport on iOS
  // Safari / standalone PWA. Add the covered height on top of that offset
  // so it stays above the keyboard. No-op on Chrome/Android (index.html's
  // `interactive-widget=resizes-content` already handles it there) and on
  // native (hook returns 0).
  const keyboardInset = useVisualViewportInset();
  const [persona, setPersonaState] = useState<Persona>(getPersona());
  const changePersona = (p: Persona) => {
    setPersonaState(p);
    setPersona(p);
  };
  const navigate = useNavigate();
  const toast = useToast();
  const t = useT();

  const load = useCallback(async () => {
    await Promise.all([loadAccounts(), loadTransactions(), loadGroups(), loadTemplates(), loadLoans(), loadBudgets()]);
  }, [loadAccounts, loadTransactions, loadGroups, loadTemplates, loadLoans, loadBudgets]);
  const { status: loadStatus, error: loadError, retry: retryLoad } = useAsyncLoad(load);

  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [busyChipId, setBusyChipId] = useState<number | null>(null);
  const nextId = useRef(1);
  const scrollAnchor = useRef<HTMLDivElement>(null);

  const mkId = () => nextId.current++;

  useEffect(() => {
    scrollAnchor.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages]);

  // ── This month, in the primary currency (no cross-currency summing) ──
  const summary = useMemo(() => {
    const cur = primaryCurrency();
    const ym = localMonthIso(new Date());
    const monthExpenses = transactions.filter(
      (t) => t.type === 'expense' && t.currency === cur && (t.createdAt ? localMonthIso(new Date(t.createdAt)) : '') === ym,
    );
    const spent = monthExpenses.reduce((a, t) => a + t.amount, 0);
    const byCat = new Map<string, number>();
    for (const t of monthExpenses) {
      const k = t.category || 'Other';
      byCat.set(k, (byCat.get(k) ?? 0) + t.amount);
    }
    const top = [...byCat.entries()]
      .map(([name, amt]) => ({ name, amt }))
      .sort((a, b) => b.amt - a.amt)
      .slice(0, 5);
    return { cur, spent, top, count: monthExpenses.length };
  }, [transactions]);

  // Dynamic example chips — seeded from the user's own data so the first run
  // feels personal: busiest account, an open-loan person, and a group. Falls
  // back to the static list whenever a source is empty.
  const dynamicExamples = useMemo(() => {
    if (isFull) {
      const chips: string[] = [];
      // Busiest account this month (primary currency), if any.
      const cur = primaryCurrency();
      const ym = localMonthIso(new Date());
      const byAcct = new Map<string, number>();
      for (const t of transactions) {
        if (t.type === 'expense' && t.currency === cur && (t.createdAt ? localMonthIso(new Date(t.createdAt)) : '') === ym && t.sourceAccountId) {
          byAcct.set(t.sourceAccountId, (byAcct.get(t.sourceAccountId) ?? 0) + t.amount);
        }
      }
      const topAcctId = [...byAcct.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
      const topAcct = topAcctId ? accounts.find((a) => a.id === topAcctId) : undefined;
      if (topAcct) chips.push(`How much did I spend from ${topAcct.name}?`);
      // An active loan person.
      const person = loans.find((l) => l.status === 'active' && l.remainingAmount > 0.01)?.personName;
      if (person) chips.push(`How much does ${person} owe me?`);
      // A group name.
      const group = groups[0]?.name;
      if (group) chips.push(`How do I split a bill with ${group}?`);
      // Top up to 3, padding from the static list without duplicates.
      for (const s of EXAMPLE_PROMPTS) {
        if (chips.length >= 3) break;
        if (!chips.includes(s)) chips.push(s);
      }
      return chips.slice(0, 4);
    }
    // Splits mode: surface a real group if one exists.
    const group = groups[0]?.name;
    const chips = group ? [`How do I split a bill with ${group}?`] : [];
    for (const s of SPLITS_EXAMPLES) {
      if (chips.length >= 3) break;
      if (!chips.includes(s)) chips.push(s);
    }
    return chips;
  }, [isFull, transactions, accounts, loans, groups]);

  // Gentle nudges + streak (Full Tracker feed only). All on-device.
  // Same forgiving streak as the daily close: a day counts when something was
  // logged OR the user closed it ("nothing spent today" is honest, not a gap).
  const todayIso = localIso(new Date());
  const closes = useDailyCloseStore((s) => s.closes);
  const closesLoaded = useDailyCloseStore((s) => s.loaded);
  const loadCloses = useDailyCloseStore((s) => s.load);
  useEffect(() => {
    if (isFull && !closesLoaded) void loadCloses();
  }, [isFull, closesLoaded, loadCloses]);
  const streak = useMemo(() => computeCloseStreak(transactions, closes, todayIso), [transactions, closes, todayIso]);
  const renewals = useMemo(() => upcomingRenewals(templates, todayIso, 7), [templates, todayIso]);
  const ghosts = useMemo(() => detectGhosts(templates, todayIso), [templates, todayIso]);

  // Count transactions backing a category-spend answer (this month, primary
  // currency) so we can offer a precise "View these N transactions" link.
  const countCategorySpend = (category: string): number => {
    const cur = primaryCurrency();
    const ym = localMonthIso(new Date());
    const c = category.trim().toLowerCase();
    return transactions.filter(
      (t) =>
        t.type === 'expense' &&
        t.currency === cur &&
        (t.createdAt ? localMonthIso(new Date(t.createdAt)) : '') === ym &&
        ((t.category || 'Other').toLowerCase().includes(c) || c.includes((t.category || 'other').toLowerCase())),
    ).length;
  };

  // ── Answer "fetch my own data" questions from local stores (no LLM) ──
  const answerQuery = (q: ParsedQuery): { text: string; serious: boolean; viewLink?: ViewLink } => {
    switch (q.kind) {
      case 'person-balance':
        return { text: answerPersonBalance(q.personName ?? ''), serious: false, viewLink: linkForPerson(q.personName ?? '') };
      case 'category-spend': {
        const category = (q.category ?? '').trim();
        const count = category ? countCategorySpend(category) : 0;
        return {
          text: answerCategorySpend(category),
          serious: false,
          viewLink: category && count > 0 ? { kind: 'category', category, count } : undefined,
        };
      }
      case 'net-balance': return { text: answerNetBalance(), serious: false };
      case 'account-balance': return { text: answerAccountBalance(), serious: false };
      case 'top-spend': {
        const top = summary.top[0];
        return {
          text: answerTopSpend(),
          serious: false,
          viewLink: top ? { kind: 'category', category: top.name, count: countCategorySpend(top.name) } : undefined,
        };
      }
      case 'account-spend':
        return { text: answerAccountSpend(q.accountName, q.period ?? 'this'), serious: false, viewLink: { kind: 'transactions', count: summary.count } };
      case 'income': return { text: answerIncome(q.period ?? 'this'), serious: false };
      case 'trend': return { text: answerTrend(), serious: false };
      case 'budget-status': {
        const text = answerBudgetStatus(q.category);
        return { text, serious: /over by/.test(text) }; // over budget → no jokes
      }
    }
  };

  // A person-balance answer links to the transactions list (filtered mentally
  // by the user); we attach a link only when there's an open loan to view.
  const linkForPerson = (name: string): ViewLink | undefined => {
    const n = name.trim().toLowerCase();
    const matches = loans.filter(
      (l) => l.status === 'active' && l.remainingAmount > 0.01 && l.personName.toLowerCase().includes(n),
    );
    return matches.length > 0 ? { kind: 'transactions', count: matches.length } : undefined;
  };

  const answerPersonBalance = (name: string): string => {
    const n = name.trim().toLowerCase();
    const matches = loans.filter(
      (l) => l.status === 'active' && l.remainingAmount > 0.01 && l.personName.toLowerCase().includes(n),
    );
    if (matches.length === 0) {
      return `I couldn't find an open balance with "${name}". If you've recorded a loan with them, double-check the spelling.`;
    }
    const personName = matches[0].personName;
    const byCur = new Map<string, number>();
    for (const l of matches) {
      const sign = l.type === 'given' ? 1 : -1; // "given" = they owe you
      byCur.set(l.currency, (byCur.get(l.currency) ?? 0) + sign * l.remainingAmount);
    }
    const parts: string[] = [];
    for (const [cur, net] of byCur) {
      if (Math.abs(net) < 0.01) continue;
      parts.push(net > 0 ? `${personName} owes you ${formatMoney(net, cur)}` : `you owe ${personName} ${formatMoney(-net, cur)}`);
    }
    if (parts.length === 0) return `You and ${personName} are all settled. 🎉`;
    const s = parts.join(', and ');
    return `${s.charAt(0).toUpperCase()}${s.slice(1)}.`;
  };

  const answerNetBalance = (): string => {
    const owed = new Map<string, number>();
    const iOwe = new Map<string, number>();
    for (const l of loans) {
      if (l.status !== 'active' || l.remainingAmount <= 0.01) continue;
      const m = l.type === 'given' ? owed : iOwe;
      m.set(l.currency, (m.get(l.currency) ?? 0) + l.remainingAmount);
    }
    const fmt = (m: Map<string, number>) => [...m.entries()].map(([c, v]) => formatMoney(v, c)).join(', ');
    if (owed.size === 0 && iOwe.size === 0) return "You're all settled — nothing owed either way. 🎉";
    const bits: string[] = [];
    if (owed.size) bits.push(`you're owed ${fmt(owed)}`);
    if (iOwe.size) bits.push(`you owe ${fmt(iOwe)}`);
    const s = bits.join(', and ');
    return `${s.charAt(0).toUpperCase()}${s.slice(1)}.`;
  };

  const answerCategorySpend = (category: string): string => {
    const cur = primaryCurrency();
    const ym = localMonthIso(new Date());
    const c = category.trim().toLowerCase();
    const rows = transactions.filter(
      (t) =>
        t.type === 'expense' &&
        t.currency === cur &&
        (t.createdAt ? localMonthIso(new Date(t.createdAt)) : '') === ym &&
        ((t.category || 'Other').toLowerCase().includes(c) || c.includes((t.category || 'other').toLowerCase())),
    );
    const total = rows.reduce((a, t) => a + t.amount, 0);
    if (rows.length === 0) return `You haven't logged any ${category} spending this month (in ${cur}).`;
    const anchor = spendAnchor(total, cur);
    const count = `${rows.length} ${rows.length === 1 ? 'transaction' : 'transactions'}`;
    return `You've spent ${formatMoney(total, cur)} on ${category} this month (${count})${anchor ? ` — ${anchor}` : ''}.`;
  };

  const answerTopSpend = (): string => {
    if (summary.count === 0) {
      return `No ${summary.cur} spending logged this month yet — add a few and I'll show you exactly where it goes.`;
    }
    const top = summary.top.slice(0, 3);
    const lead = top[0];
    const pct = summary.spent > 0 ? Math.round((lead.amt / summary.spent) * 100) : 0;
    const rest = top.slice(1).map((c) => `${c.name} (${formatMoney(c.amt, summary.cur)})`).join(', ');
    const anchor = spendAnchor(lead.amt, summary.cur);
    return `Most of your money went to ${lead.name} this month — ${formatMoney(lead.amt, summary.cur)}, about ${pct}% of ${formatMoney(summary.spent, summary.cur)}${anchor ? ` (${anchor})` : ''}.${rest ? ` Then ${rest}.` : ''}`;
  };

  const monthYm = (period: 'this' | 'last'): string => {
    const now = new Date();
    return period === 'last'
      ? localMonthIso(new Date(now.getFullYear(), now.getMonth() - 1, 1))
      : localMonthIso(now);
  };

  const answerIncome = (period: 'this' | 'last'): string => {
    const cur = primaryCurrency();
    const ym = monthYm(period);
    const label = period === 'last' ? 'last month' : 'this month';
    const rows = transactions.filter(
      (t) => t.type === 'income' && t.currency === cur && (t.createdAt ? localMonthIso(new Date(t.createdAt)) : '') === ym,
    );
    const total = rows.reduce((a, t) => a + t.amount, 0);
    if (rows.length === 0) return `You haven't logged any ${cur} income ${label} yet.`;
    const byCat = new Map<string, number>();
    for (const r of rows) byCat.set(r.category || 'Other', (byCat.get(r.category || 'Other') ?? 0) + r.amount);
    const top = [...byCat.entries()].sort((a, b) => b[1] - a[1])[0];
    const topBit = top && byCat.size > 1 ? ` Most of it from ${top[0]}.` : '';
    const count = `${rows.length} ${rows.length === 1 ? 'entry' : 'entries'}`;
    return `You brought in ${formatMoney(total, cur)} ${label} (${count}).${topBit}`;
  };

  const answerAccountSpend = (accountName: string | undefined, period: 'this' | 'last'): string => {
    const cur = primaryCurrency();
    const ym = monthYm(period);
    const label = period === 'last' ? 'last month' : 'this month';
    // A specific card/account named → answer in that account's own currency.
    if (accountName) {
      const acct = accounts.find((a) => a.name.toLowerCase().includes(accountName.toLowerCase()));
      if (!acct) return `I couldn't find an account called "${accountName}". Check the name on the Accounts screen.`;
      const total = transactions
        .filter((t) => t.type === 'expense' && t.sourceAccountId === acct.id && (t.createdAt ? localMonthIso(new Date(t.createdAt)) : '') === ym)
        .reduce((a, t) => a + t.amount, 0);
      if (total <= 0) return `No spending from ${acct.name} ${label}.`;
      return `You spent ${formatMoney(total, acct.currency)} from ${acct.name} ${label}.`;
    }
    // Aggregate "which one most" — scope to the primary currency so we don't
    // compare e.g. PKR vs AED amounts directly (a non-primary card is invisible
    // here, matching the rest of the engine).
    const monthExpenses = transactions.filter(
      (t) => t.type === 'expense' && t.currency === cur && (t.createdAt ? localMonthIso(new Date(t.createdAt)) : '') === ym && t.sourceAccountId,
    );
    if (monthExpenses.length === 0) return `No ${cur} card or account spending logged ${label} yet.`;
    const byAcct = new Map<string, number>();
    for (const t of monthExpenses) {
      const id = t.sourceAccountId as string;
      byAcct.set(id, (byAcct.get(id) ?? 0) + t.amount);
    }
    const ranked = [...byAcct.entries()]
      .map(([id, amt]) => ({ acct: accounts.find((a) => a.id === id), amt }))
      .filter((r) => r.acct)
      .sort((a, b) => b.amt - a.amt);
    if (ranked.length === 0) return `No ${cur} card or account spending logged ${label} yet.`;
    const lead = ranked[0];
    const rest = ranked.slice(1, 3).map((r) => `${r.acct!.name} (${formatMoney(r.amt, cur)})`).join(', ');
    return `Most of your spending went through ${lead.acct!.name} — ${formatMoney(lead.amt, cur)} ${label}.${rest ? ` Then ${rest}.` : ''}`;
  };

  const answerAccountBalance = (): string => {
    const byCur = new Map<string, number>();
    for (const a of accounts) byCur.set(a.currency, (byCur.get(a.currency) ?? 0) + a.balance);
    if (byCur.size === 0) return "You haven't added any accounts yet — add one and I can track your balance.";
    const parts = [...byCur.entries()].map(([c, v]) => formatMoney(v, c));
    return `You've got ${parts.join(' and ')} across your accounts right now.`;
  };

  const answerTrend = (): string => {
    const cur = primaryCurrency();
    const now = new Date();
    const thisYm = localMonthIso(now);
    const lastYm = localMonthIso(new Date(now.getFullYear(), now.getMonth() - 1, 1));
    const sumFor = (ym: string) =>
      transactions
        .filter((t) => t.type === 'expense' && t.currency === cur && (t.createdAt ? localMonthIso(new Date(t.createdAt)) : '') === ym)
        .reduce((a, t) => a + t.amount, 0);
    const a = sumFor(thisYm);
    const b = sumFor(lastYm);
    if (a === 0 && b === 0) return `No ${cur} spending logged this month or last to compare yet.`;
    if (b === 0) return `You've spent ${formatMoney(a, cur)} so far this month — there's no ${cur} spending last month to compare against.`;
    const diff = a - b;
    const pct = Math.round((Math.abs(diff) / b) * 100);
    const verdict = diff > 0 ? `${pct}% more` : diff < 0 ? `${pct}% less` : 'about the same';
    return `So far this month you've spent ${formatMoney(a, cur)} vs ${formatMoney(b, cur)} last month — ${verdict}.`;
  };

  const answerBudgetStatus = (cat?: string): string => {
    if (budgets.length === 0) return "You haven't set any budgets yet — you can add one from the Budgets screen.";
    const cur = primaryCurrency();
    const ym = localMonthIso(new Date());
    const spentOn = (category: string) =>
      transactions
        .filter(
          (t) =>
            t.type === 'expense' &&
            t.currency === cur &&
            (t.createdAt ? localMonthIso(new Date(t.createdAt)) : '') === ym &&
            (t.category || 'Other').toLowerCase() === category.toLowerCase(),
        )
        .reduce((a, t) => a + t.amount, 0);
    const relevant = cat
      ? budgets.filter(
          (b) => b.category.toLowerCase().includes(cat.toLowerCase()) || cat.toLowerCase().includes(b.category.toLowerCase()),
        )
      : budgets;
    if (cat && relevant.length === 0) return `You don't have a budget for "${cat}" yet.`;
    const lines = relevant.slice(0, 4).map((b) => {
      const spent = spentOn(b.category);
      const left = b.monthlyAmount - spent;
      const pct = b.monthlyAmount > 0 ? Math.round((spent / b.monthlyAmount) * 100) : 0;
      return left < 0
        ? `${b.category}: over by ${formatMoney(-left, b.currency)} (${pct}% of ${formatMoney(b.monthlyAmount, b.currency)})`
        : `${b.category}: ${formatMoney(left, b.currency)} left of ${formatMoney(b.monthlyAmount, b.currency)} (${pct}% used)`;
    });
    return `${lines.join(' · ')}.`;
  };

  // Resolve a parsed split into either a group confirm-chip, or guidance that
  // asks which group / how much when we can't pin it down.
  const buildGroupReply = (draft: ParsedGroupExpense): Msg[] => {
    if (!draft.canCreate) {
      return [{ id: mkId(), role: 'ai', text: draft.clarify ?? 'How much should I split?' }];
    }
    if (groups.length === 0) {
      return [{
        id: mkId(),
        role: 'ai',
        text: "You don't have any groups yet. Create one on the Groups tab, then I can split expenses into it.",
      }];
    }
    const matches = matchGroups(draft.groupNameHint, groups);
    let group: SplitGroup | null = null;
    if (matches.length === 1) group = matches[0];
    else if (!draft.groupNameHint && groups.length === 1) group = groups[0];

    if (group) return [{ id: mkId(), role: 'groupchip', draft, groupId: group.id }];

    const picks = (matches.length > 1 ? matches : groups).slice(0, 4);
    const amt = draft.amount ?? 0;
    return [{
      id: mkId(),
      role: 'ai',
      text: draft.groupNameHint
        ? `I couldn't pin down "${draft.groupNameHint}" — which group?`
        : 'Which group should I split this into?',
      suggestions: picks.map((g) => `split ${amt} ${draft.description} with ${g.name}`),
    }];
  };

  const submit = (raw: string) => {
    const text = raw.trim();
    if (!text) return;
    const userMsg: Msg = { id: mkId(), role: 'user', text };
    const reply = routeAssistantInput(text, { mode, defaultCurrency: primaryCurrency() });

    let aiMsgs: Msg[];
    if (reply.kind === 'query' && reply.query) {
      const ans = answerQuery(reply.query);
      aiMsgs = [{ id: mkId(), role: 'ai', text: flavor(ans.text, persona, ans.serious), viewLink: ans.viewLink }];
    } else if (reply.kind === 'group' && reply.group) {
      aiMsgs = buildGroupReply(reply.group);
    } else if (reply.kind === 'command' && reply.command) {
      if (isFull && reply.command.canPost) {
        aiMsgs = [{ id: mkId(), role: 'chip', draft: reply.command }];
      } else if (isFull) {
        // Understood a money intent but the amount is missing — guide, don't post.
        aiMsgs = [{ id: mkId(), role: 'ai', text: reply.command.clarify ?? "How much was it?" }];
      } else {
        // Splits-only has no personal accounts to post against — route to the split flow.
        aiMsgs = [{
          id: mkId(),
          role: 'ai',
          text: "In Splits mode I track shared expenses, not personal accounts. Tell me to \"split\" it with a group, or switch to Full Tracker in Settings to log it as your own expense.",
          suggestions: reply.suggestions,
        }];
      }
    } else if (reply.kind === 'knowledge' && reply.knowledge) {
      aiMsgs = [{ id: mkId(), role: 'ai', text: reply.knowledge.answer }];
    } else {
      aiMsgs = [{ id: mkId(), role: 'ai', text: reply.text ?? 'Try one of these:', suggestions: reply.suggestions }];
    }

    setMessages((m) => [...m, userMsg, ...aiMsgs]);
    setInput('');
  };

  // Live "I understood you" preview as the user types — parses the current
  // input locally (cheap, no LLM) and shows the amount/category it captured
  // before they even hit send. The full editable chip still appears on submit.
  const livePreview = useMemo(() => {
    const text = input.trim();
    if (!isFull || text.length < 3) return null;
    try {
      const reply = routeAssistantInput(text, { mode, defaultCurrency: primaryCurrency() });
      if (reply.kind === 'command' && reply.command && reply.command.canPost) {
        const c = reply.command;
        if (c.amount != null) {
          return { direction: c.direction, amount: c.amount, currency: c.currency ?? primaryCurrency(), category: c.category };
        }
      }
    } catch {
      // Parser hiccup — just show no preview.
    }
    return null;
  }, [input, isFull, mode]);

  const confirmChip = async (chipId: number, input: ReturnType<typeof buildTransactionFromDraft>, summaryText: string) => {
    if (!input) return;
    setBusyChipId(chipId);
    try {
      // Read BEFORE the write — after it, the stores are never empty again.
      const isFirstEver = transactions.length === 0 && loans.length === 0;
      await processTransaction(input);
      await Promise.all([loadAccounts(), loadTransactions()]);
      // Catalog #9 (source=ai) + #27. Never the raw typed text — only the
      // parsed shape, exactly like every other entry_created call site.
      if (input.type === 'expense' || input.type === 'income') {
        const accountId = input.type === 'expense' ? input.sourceAccountId : input.destinationAccountId;
        const currency = accounts.find((a) => a.id === accountId)?.currency;
        if (currency) {
          track('entry_created', {
            entry_type: input.type,
            source: 'ai',
            is_first_ever: isFirstEver,
            mode: 'full_tracker',
            currency,
            amount_bucket: bucketAmount(input.amount),
          });
        }
      }
      track('ai_entry_submitted', { parsed_ok: true, accepted: true });
      setMessages((m) =>
        m
          .map((msg) => (msg.id === chipId && msg.role === 'chip' ? { ...msg, resolved: summaryText } : msg))
          .concat({ id: mkId(), role: 'ai', text: flavor(`Logged — ${summaryText}. What's next?`, persona) }),
      );
      toast.show({ type: 'success', title: 'Saved', subtitle: summaryText });
    } catch (err) {
      toast.show({
        type: 'error',
        title: 'Could not save',
        subtitle: err instanceof Error ? err.message : 'Try again.',
      });
    } finally {
      setBusyChipId(null);
    }
  };

  const confirmGroupChip = async (chipId: number, group: SplitGroup, amount: number, description: string) => {
    const activeMembers = getActiveGroupMembers(group);
    const memberIds = activeMembers.map((m) => m.id);
    const payerId = activeMembers.find((m) => m.profileId === currentUserId())?.id;
    if (memberIds.length === 0) {
      toast.show({ type: 'error', title: 'No active members to split with' });
      return;
    }
    if (!payerId) {
      toast.show({
        type: 'error',
        title: "Couldn't find you in this group",
        subtitle: 'Open the group to add this expense.',
      });
      return;
    }
    setBusyChipId(chipId);
    try {
      // Read BEFORE the write — mirrors confirmChip above.
      const isFirstEver = transactions.length === 0 && loans.length === 0;
      const splits = equalSplits(amount, memberIds);
      await addGroupExpense({
        groupId: group.id,
        description,
        amount,
        paidBy: payerId,
        splitType: 'equal',
        splits,
        category: '',
        notes: '',
      });
      await loadGroups();
      // Catalog #9 (source=group) + #19. This chip bypasses AddGroupExpenseModal
      // entirely, so it mirrors that modal's call site rather than reusing it.
      // Amount and participant count travel as buckets — never the raw split
      // or the chat text that produced this entry.
      track('entry_created', {
        entry_type: 'expense',
        source: 'group',
        is_first_ever: isFirstEver,
        mode,
        currency: group.currency,
        amount_bucket: bucketAmount(amount),
      });
      track('group_expense_added', {
        split_type: 'equal',
        participant_count_bucket: bucketCount(memberIds.length),
      });
      const summaryText = `${formatMoney(amount, group.currency)} · ${description} · split ${memberIds.length} ways`;
      setMessages((m) =>
        m
          .map((msg) => (msg.id === chipId && msg.role === 'groupchip' ? { ...msg, resolved: summaryText } : msg))
          .concat({ id: mkId(), role: 'ai', text: `Done — added to ${group.name}. ${summaryText}.` }),
      );
      toast.show({ type: 'success', title: 'Split added', subtitle: summaryText });
    } catch (err) {
      toast.show({
        type: 'error',
        title: 'Could not add split',
        subtitle: err instanceof Error ? err.message : 'Try again.',
      });
    } finally {
      setBusyChipId(null);
    }
  };

  const cancelChip = (chipId: number) => {
    setMessages((m) =>
      m.map((msg) =>
        msg.id === chipId && (msg.role === 'chip' || msg.role === 'groupchip')
          ? { ...msg, resolved: 'cancelled' }
          : msg,
      ),
    );
  };

  // First visit, nothing cached yet: the hero figure is a skeleton instead of
  // flashing the "log a few expenses" empty copy. A warm store renders at once.
  const loadingFirst = loadStatus === 'loading' && transactions.length === 0;

  return (
    <main className="min-h-dvh bg-cream-bg pb-44">
      {/* ── Hero — the stronger AI violet (radial 130% 80% at 80% -10%) ── */}
      <NavyHero accent="ai">
        <div className="px-5 pt-2 pb-7">
          <div className="flex items-center gap-2.5">
            {/* The assistant's mark: a lit violet face (the AI accent). */}
            <span className="w-9 h-9 rounded-[12px] flex items-center justify-center shrink-0 bg-gradient-to-br from-iris-500 to-iris-600 shadow-[inset_0_1px_0_rgba(255,255,255,0.4)]">
              <Glyph name="sparkles" size={18} className="text-white animate-sparkle" />
            </span>
            <div className="flex items-center gap-2">
              <span className="text-[16px] font-semibold tracking-[-0.01em] text-white">Hisaab AI</span>
              <span className="text-[8px] font-bold tracking-[0.1em] px-[7px] py-[3px] rounded-full bg-white/15 text-white/90">
                BETA
              </span>
            </div>
            {/* The tone dial lives in the hero's free top-right corner
                (founder request 2026-09-19) — Chill / Balanced / Roast. */}
            <div className="m-seg ml-auto" role="group" aria-label="Vibe">
              {(['chill', 'balanced', 'roast'] as Persona[]).map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => changePersona(p)}
                  aria-pressed={persona === p}
                  className="capitalize !min-h-[28px] !px-2.5 !py-1 !text-[10.5px]"
                >
                  {p}
                </button>
              ))}
            </div>
          </div>

          {greetName && (
            <p className="text-[12.5px] text-white/70 mt-4">
              {t(timeGreetingKey())}, <span className="text-white font-medium">{greetName}</span> 👋
            </p>
          )}

          {/* This month headline — only meaningful in Full Tracker (Splits Only
              has no personal accounts). In Splits mode the AI is a guide + split helper. */}
          {isFull ? (
            <>
              <p className="text-[11px] font-semibold tracking-[0.12em] uppercase text-white/70 mt-5 mb-2">
                Spent this month
              </p>
              {loadingFirst ? (
                <div className="m-skel h-10 w-44 rounded-xl" aria-hidden="true" />
              ) : summary.count > 0 ? (
                <div className="flex items-baseline gap-[7px]">
                  {/* The figure itself is extruded — violet, the AI accent. */}
                  <span className="m-num m-num-violet text-[40px] tracking-[-0.035em]">
                    {summary.spent.toLocaleString('en-US', { maximumFractionDigits: 0 })}
                  </span>
                  <span className="text-[15px] font-medium text-white/50">{summary.cur}</span>
                </div>
              ) : (
                <p className="text-[13px] text-white/70 leading-relaxed mt-1">
                  Log a few expenses and I&rsquo;ll show you where your money goes — and one thing you can do about it.
                </p>
              )}
            </>
          ) : (
            <p className="text-[13px] text-white/70 leading-relaxed mt-4">
              Your shared expenses, samjho. Tell me to split a bill, ask who owes whom, or ask how anything in Hisaab works.
            </p>
          )}
        </div>
      </NavyHero>

      <div className="sukoon-body min-h-[60dvh] px-5 pt-5 space-y-3">
        {loadStatus === 'error' && (
          <PageErrorState
            variant="inline"
            title="Couldn't load your data"
            message={loadError ?? 'Some data failed to load.'}
            onRetry={retryLoad}
          />
        )}

        {/* Streak — gentle encouragement only, never shaming (Full Tracker) */}
        {isFull && streak.streak > 0 && (
          <div className="m-card rounded-[16px] px-4 py-3 flex items-center gap-3">
            <span aria-hidden="true" className="m-card m-violet w-8 h-8 rounded-[12px] flex items-center justify-center shrink-0">
              <Glyph name="flame" size={16} tone="violet" />
            </span>
            <p className="text-[12.5px] text-ink-600">
              {(streak.activeToday ? t('ai_streak_done') : t('ai_streak_keep')).replace('{n}', String(streak.streak))}
            </p>
          </div>
        )}

        {/* Where it goes — real data, tappable into the category detail */}
        {isFull && summary.top.length > 0 && (
          <div className="m-card p-4">
            <p className="m-label mb-2.5">
              Where it goes
            </p>
            <div className="space-y-0.5">
              {summary.top.map((c) => {
                const max = summary.top[0].amt || 1;
                const pct = Math.round((c.amt / max) * 100);
                return (
                  <button
                    key={c.name}
                    onClick={() => navigate(`/hisaab-ai/insight/${encodeURIComponent(c.name)}`)}
                    className="w-full min-h-[36px] flex items-center gap-2.5 py-1.5 text-left active:opacity-70 transition-opacity"
                  >
                    <span className="w-[76px] text-[11.5px] text-ink-600 truncate shrink-0">{c.name}</span>
                    {/* Recessed track, violet extruded fill. */}
                    <span className="m-inset flex-1 h-2 rounded-full overflow-hidden">
                      <span
                        className="block h-full rounded-full bg-gradient-to-r from-iris-500 to-iris-600"
                        style={{ width: `${pct}%` }}
                      />
                    </span>
                    <span className="w-[62px] text-right text-[11.5px] font-semibold text-ink-900 tabular-nums shrink-0">
                      {formatMoney(c.amt, summary.cur).replace(`${summary.cur} `, '')}
                    </span>
                    <Glyph name="chevron-right" size={13} className="text-ink-400" />
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* For you — gentle in-app nudges (renewals + forgotten subs) */}
        {isFull && (renewals.length > 0 || ghosts.length > 0) && (
          <div className="space-y-2.5">
            {renewals.slice(0, 1).map((r) => (
              <div
                key={`r-${r.template.id}`}
                className="m-card m-blue rounded-[16px] px-4 py-3 flex items-center gap-2.5"
              >
                <Glyph name="calendar" size={16} tone="blue" />
                <p className="text-[12.5px] text-cobalt-text">
                  <span className="font-semibold">{r.template.label || 'A subscription'}</span> renews{' '}
                  {r.daysUntil === 0 ? 'today' : `in ${r.daysUntil}d`} ·{' '}
                  {formatMoney(r.template.amount, r.template.currency)}
                </p>
              </div>
            ))}
            {ghosts.slice(0, 1).map((g) => (
              <button
                key={`g-${g.template.id}`}
                onClick={() => navigate('/subscriptions')}
                className="m-tile m-coral rounded-[16px] px-4 py-3 flex items-center gap-2.5 text-left"
              >
                <Ghost size={16} strokeWidth={2.4} className="text-glyph-coral shrink-0" />
                <p className="text-[12.5px] text-pay-text flex-1">
                  <span className="font-semibold">{g.template.label || g.template.category}</span> —{' '}
                  {describeGhost(g, todayIso)}
                </p>
                <Glyph name="chevron-right" size={13} className="text-pay-text" />
              </button>
            ))}
          </div>
        )}

        {/* ── Conversation ── */}
        <div className="space-y-3 pt-2">
          {/* Intro / first-run guidance — always visible so a new user is never lost */}
          <AIBubble>
            <p>
              {isFull
                ? `${t('greet_hello')}${greetName ? `, ${greetName}` : ''}! Tell me what you spent in plain words — "200 for groceries", "30 careem" — and I'll log it (always with a card to confirm first). You can also ask me things like "where did my money go?" or "how much does Ali owe me?".`
                : `${t('greet_hello')}${greetName ? `, ${greetName}` : ''}! I'm your Hisaab guide. Ask me how to split a bill, settle up, or which mode fits you — and I'll point you the right way.`}
            </p>
            <div className="flex flex-wrap gap-2 mt-3">
              {dynamicExamples.map((q) => (
                <SuggestionChip key={q} q={q} onTap={() => submit(q)} />
              ))}
            </div>
          </AIBubble>

          {messages.map((m) => {
            if (m.role === 'user') return <UserBubble key={m.id}>{m.text}</UserBubble>;
            if (m.role === 'ai')
              return (
                <AIBubble key={m.id}>
                  <p>{m.text}</p>
                  {m.viewLink && (
                    <button
                      onClick={() =>
                        m.viewLink!.kind === 'category'
                          ? navigate(`/hisaab-ai/insight/${encodeURIComponent(m.viewLink!.category)}`)
                          : navigate('/transactions')
                      }
                      className="mt-1.5 inline-flex items-center gap-1 min-h-[44px] px-3 -ml-3 rounded-lg text-[12px] font-semibold text-iris-text active:opacity-70 transition-opacity"
                    >
                      {m.viewLink.count === 1
                        ? t('ai_view_txn_one')
                        : t('ai_view_txns').replace('{count}', String(m.viewLink.count))}
                      <Glyph name="chevron-right" size={13} />
                    </button>
                  )}
                  {m.suggestions && m.suggestions.length > 0 && (
                    <div className="flex flex-wrap gap-2 mt-3">
                      {m.suggestions.map((q) => (
                        <SuggestionChip key={q} q={q} onTap={() => submit(q)} />
                      ))}
                    </div>
                  )}
                </AIBubble>
              );
            if (m.role === 'groupchip') {
              const g = groups.find((x) => x.id === m.groupId) ?? null;
              return (
                <GroupChipCard
                  key={m.id}
                  draft={m.draft}
                  group={g}
                  resolved={m.resolved}
                  busy={busyChipId === m.id}
                  onConfirm={(amount, description) => g && confirmGroupChip(m.id, g, amount, description)}
                  onCancel={() => cancelChip(m.id)}
                />
              );
            }
            return (
              <ChipCard
                key={m.id}
                draft={m.draft}
                accounts={accounts}
                history={transactions}
                resolved={m.resolved}
                busy={busyChipId === m.id}
                onConfirm={(input, summaryText) => confirmChip(m.id, input, summaryText)}
                onCancel={() => cancelChip(m.id)}
                onAddAccount={() => navigate('/accounts')}
              />
            );
          })}
          <div ref={scrollAnchor} />
        </div>
      </div>

      {/* ── Pinned ask bar (above the bottom nav): a raised dock holding a
          sunken input well and the violet send key. ── */}
      <div
        className="fixed left-1/2 -translate-x-1/2 w-full max-w-[480px] px-5 z-30"
        style={{ bottom: `calc(70px + env(safe-area-inset-bottom) + ${keyboardInset}px)` }}
      >
        {livePreview && (
          <div className="m-card m-violet rounded-[14px] mb-2.5 flex items-center gap-2 px-3 py-2 animate-fade-in">
            <Glyph name="sparkle" size={12} tone="violet" />
            <span className="text-[10.5px] text-ink-600 shrink-0">{t('ai_understood')}</span>
            <span className="min-w-0 truncate text-[11.5px] font-semibold text-ink-900">
              <span className={livePreview.direction === 'income' ? 'text-receive-text' : 'text-pay-text'}>
                {livePreview.direction === 'income' ? '+' : '−'}{formatMoney(livePreview.amount, livePreview.currency)}
              </span>
              {livePreview.category ? <span className="text-ink-600"> · {livePreview.category}</span> : null}
            </span>
          </div>
        )}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit(input);
          }}
          className="m-card rounded-[18px] p-2 flex items-center gap-2"
        >
          {/* The bare input's focus shows on the well: the material's one
              violet ring (outline, so the recess shadows stay intact). */}
          <div className="m-inset flex-1 min-w-0 h-11 rounded-[13px] flex items-center gap-2 pl-3.5 pr-3 focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-accent-500">
            <Glyph name="sparkle" size={15} tone="violet" />
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={isFull ? 'Add an expense — e.g. karak 3 aed' : 'Ask me anything about Hisaab'}
              className="flex-1 min-w-0 bg-transparent outline-none text-ink-900 placeholder:text-ink-400"
            />
          </div>
          <button
            type="submit"
            aria-label="Send"
            disabled={!input.trim()}
            className="m-btn m-btn-primary w-11 h-11 min-h-0 p-0 rounded-[13px] shrink-0"
          >
            <Glyph name="send" size={17} />
          </button>
        </form>
      </div>
    </main>
  );
}

// Example prompt — a material pill in the AI violet. Wraps (long, data-seeded
// prompts), so it drops the pill's nowrap.
function SuggestionChip({ q, onTap }: { q: string; onTap: () => void }) {
  return (
    <button
      type="button"
      onClick={onTap}
      className="m-pill relative whitespace-normal text-left leading-snug text-[11.5px] font-medium text-iris-text before:absolute before:-inset-1 before:content-['']"
    >
      {q}
    </button>
  );
}

// You: a violet-tinted card, right-aligned, the bottom-right corner clipped.
function UserBubble({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex justify-end">
      <div className="m-card m-violet max-w-[82%] rounded-[18px] rounded-br-[6px] px-[15px] py-3 text-[12.5px] font-medium leading-normal text-ink-900 break-words">
        {children}
      </div>
    </div>
  );
}

// The assistant's small mark beside each reply (violet — the AI accent).
function AIAvatar() {
  return (
    <span
      aria-hidden="true"
      className="w-7 h-7 rounded-[9px] flex items-center justify-center shrink-0 mt-0.5 bg-gradient-to-br from-iris-500 to-iris-600"
    >
      <Glyph name="sparkles" size={14} className="text-white" />
    </span>
  );
}

// The assistant: card material, the top-left corner clipped toward its mark.
function AIBubble({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex gap-2.5">
      <AIAvatar />
      <div className="m-card flex-1 min-w-0 rounded-[18px] rounded-tl-[6px] px-4 py-3.5 text-[12.5px] leading-[1.6] text-ink-800">
        {children}
      </div>
    </div>
  );
}

function GroupChipCard({
  draft,
  group,
  resolved,
  busy,
  onConfirm,
  onCancel,
}: {
  draft: ParsedGroupExpense;
  group: SplitGroup | null;
  resolved?: string;
  busy: boolean;
  onConfirm: (amount: number, description: string) => void;
  onCancel: () => void;
}) {
  const [amount, setAmount] = useState(String(draft.amount ?? ''));
  const [description, setDescription] = useState(draft.description);

  if (resolved === 'cancelled') {
    return <AIBubble>No problem — I didn&rsquo;t add that split.</AIBubble>;
  }
  if (!group) {
    return <AIBubble>That group isn&rsquo;t available anymore — try again from the Groups tab.</AIBubble>;
  }

  const activeMembers = getActiveGroupMembers(group);
  const n = activeMembers.length;
  const amt = parseAmountExpression(amount) ?? parseFloat(amount);
  const amountValid = Number.isFinite(amt) && amt > 0;
  const perHead = amountValid && n > 0 ? amt / n : 0;

  return (
    <div className="flex gap-2.5">
      <AIAvatar />
      <div className="m-card flex-1 min-w-0 rounded-[18px] rounded-tl-[6px] px-4 py-3.5">
        {resolved && resolved !== 'cancelled' ? (
          <div className="flex items-center gap-2 text-[13px] text-receive-text font-semibold">
            <Glyph name="check" size={15} strokeWidth={3} /> {resolved}
          </div>
        ) : (
          <>
            <div className="flex items-center gap-2 mb-3">
              <span className="text-[15px]">{group.emoji}</span>
              <span className="text-[13px] font-semibold text-ink-900">{group.name}</span>
              <span className="text-[11px] text-ink-600">· split equally</span>
            </div>
            <div className="flex items-center gap-2 mb-2.5">
              <input
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value.replace(/[^0-9.+\-*/() ]/g, ''))}
                onBlur={() => { const r = parseAmountExpression(amount); if (r != null) setAmount(String(r)); }}
                className="input-field w-28 px-3 py-1.5 font-semibold tabular-nums tracking-[-0.02em]"
                // Inline on purpose: index.css pins every <input> to 16px
                // (the iOS zoom guard), which beats any font-size utility.
                style={{ fontSize: 20 }}
              />
              <span className="text-[12px] font-medium text-ink-400">{group.currency}</span>
            </div>
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What for?"
              className="input-field px-3 py-2 mb-2.5"
            />
            <p className="text-[11.5px] text-ink-600 mb-3">
              Split among {n} {n === 1 ? 'member' : 'members'}
              {amountValid ? ` · ~${formatMoney(perHead, group.currency)} each` : ''}
            </p>
            <div className="flex gap-2">
              <button
                onClick={() => amountValid && onConfirm(amt, description.trim() || draft.description)}
                disabled={busy || !amountValid}
                className="m-btn m-btn-primary flex-1 min-h-[42px] py-2.5 gap-1.5 text-[12.5px]"
              >
                <Glyph name="check" size={14} strokeWidth={3} /> {busy ? 'Adding…' : 'Confirm & split'}
              </button>
              <button
                onClick={onCancel}
                disabled={busy}
                aria-label="Cancel"
                className="m-btn m-btn-plain min-h-[42px] w-12 p-0"
              >
                <Glyph name="close" size={16} />
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

interface ChipCardProps {
  draft: ParsedExpense;
  accounts: Account[];
  history: HistoryTxn[];
  resolved?: string;
  busy: boolean;
  onConfirm: (input: ReturnType<typeof buildTransactionFromDraft>, summaryText: string) => void;
  onCancel: () => void;
  onAddAccount: () => void;
}

function ChipCard({ draft, accounts, history, resolved, busy, onConfirm, onCancel, onAddAccount }: ChipCardProps) {
  const t = useT();
  const [direction, setDirection] = useState<Direction>(draft.direction);
  const [amount, setAmount] = useState(String(draft.amount ?? ''));
  const defaultAccount = useMemo(() => pickAccountForDraft(draft, accounts), [draft, accounts]);
  const [accountId, setAccountId] = useState(defaultAccount?.id ?? '');
  const cats: readonly string[] = useCategoryOptions(direction === 'income' ? 'income' : 'expense');
  // Your own history wins over the parser's cold-start seed: if you've logged
  // this kind of thing before, reuse the category you chose then.
  const [category, setCategory] = useState<string>(() => {
    const learned = suggestCategory(draft.label, history, draft.direction);
    if (learned && cats.includes(learned)) return learned;
    return draft.category && cats.includes(draft.category) ? draft.category : 'Other';
  });
  const learnedNow = suggestCategory(draft.label, history, direction);
  const labelIsEcho = !!draft.category && draft.label.toLowerCase() === draft.category.toLowerCase();
  const [note, setNote] = useState(labelIsEcho ? '' : draft.label);

  // Keep the category valid when the user flips direction. Adjust during render
  // (React's supported pattern) instead of in an effect — it converges because
  // 'Other' is always a valid category.
  if (!cats.includes(category)) setCategory('Other');

  if (resolved === 'cancelled') {
    return <AIBubble>No problem — I didn&rsquo;t save that. Tell me again whenever you&rsquo;re ready.</AIBubble>;
  }

  const account = accounts.find((a) => a.id === accountId) ?? null;
  const amt = parseAmountExpression(amount) ?? parseFloat(amount);
  const amountValid = Number.isFinite(amt) && amt > 0;

  if (accounts.length === 0) {
    return (
      <AIBubble>
        <p>I&rsquo;ve got the details, but you need an account to save it to first.</p>
        <button
          onClick={onAddAccount}
          className="m-btn m-btn-primary mt-3 min-h-[38px] px-3.5 py-2 rounded-[12px] text-[12px]"
        >
          Add an account
        </button>
      </AIBubble>
    );
  }

  const handleConfirm = () => {
    if (!account || !amountValid) return;
    const input = buildTransactionFromDraft(
      { amount: amt, direction, category: category === 'Other' ? null : category, label: note || category },
      account,
    );
    const sign = direction === 'income' ? '+' : '−';
    const summaryText = `${sign} ${formatMoney(amt, account.currency)}${note ? ` · ${note}` : ''} → ${account.name}`;
    onConfirm(input, summaryText);
  };

  return (
    <div className="flex gap-2.5">
      <AIAvatar />
      <div className="m-card flex-1 min-w-0 rounded-[18px] rounded-tl-[6px] px-4 py-3.5">
        {resolved && resolved !== 'cancelled' ? (
          <div className="flex items-center gap-2 text-[13px] text-receive-text font-semibold">
            <Glyph name="check" size={15} strokeWidth={3} /> {resolved}
          </div>
        ) : (
          <>
            <p className="text-[12.5px] leading-[1.6] text-ink-800 mb-3">
              {draft.currencyAssumed && draft.currency
                ? `Got it — saving in ${account?.currency ?? draft.currency}. Confirm or tweak:`
                : "Here's what I understood — confirm or tweak:"}
            </p>

            {/* direction toggle — toned pills: tinted at rest, solid when on */}
            <div className="grid grid-cols-2 gap-2 mb-3">
              {(['expense', 'income'] as Direction[]).map((d) => (
                <button
                  key={d}
                  type="button"
                  onClick={() => setDirection(d)}
                  aria-pressed={direction === d}
                  className={`m-pill ${d === 'income' ? 'm-pill-receive' : 'm-pill-pay'} capitalize`}
                >
                  {d === 'income' ? 'Money in' : 'Money out'}
                </button>
              ))}
            </div>

            {/* amount + currency */}
            <div className="flex items-center gap-2 mb-3">
              <input
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value.replace(/[^0-9.+\-*/() ]/g, ''))}
                onBlur={() => { const r = parseAmountExpression(amount); if (r != null) setAmount(String(r)); }}
                className="input-field w-28 px-3 py-1.5 font-semibold tabular-nums tracking-[-0.02em]"
                // Inline on purpose: index.css pins every <input> to 16px
                // (the iOS zoom guard), which beats any font-size utility.
                style={{ fontSize: 20 }}
              />
              <span className="text-[12px] font-medium text-ink-400">{account?.currency ?? ''}</span>
            </div>

            {/* account */}
            <label className="form-label mb-1.5">
              {direction === 'income' ? 'To account' : 'From account'}
            </label>
            <select
              value={accountId}
              onChange={(e) => setAccountId(e.target.value)}
              className="input-field px-3 py-2 mb-3"
            >
              {groupAccountsByType(accounts).map((g) => (
                <optgroup key={g.id} label={t(g.labelKey)}>
                  {g.accounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name} ({a.currency})
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>

            {/* category */}
            <label className="form-label mb-1.5">
              Category
              {learnedNow && learnedNow === category && (
                <span className="ml-1.5 normal-case tracking-normal text-iris-text font-medium">· like you tagged before</span>
              )}
            </label>
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              className="input-field px-3 py-2 mb-3"
            >
              {cats.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>

            {/* note */}
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Note (optional)"
              className="input-field px-3 py-2 mb-3.5"
            />

            <div className="flex gap-2">
              <button
                onClick={handleConfirm}
                disabled={busy || !amountValid}
                className="m-btn m-btn-primary flex-1 min-h-[42px] py-2.5 gap-1.5 text-[12.5px]"
              >
                <Glyph name="check" size={14} strokeWidth={3} /> {busy ? 'Saving…' : 'Confirm & add'}
              </button>
              <button
                onClick={onCancel}
                disabled={busy}
                aria-label="Cancel"
                className="m-btn m-btn-plain min-h-[42px] w-12 p-0"
              >
                <Glyph name="close" size={16} />
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
