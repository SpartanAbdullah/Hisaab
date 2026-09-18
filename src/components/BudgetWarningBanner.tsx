import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Glyph } from './Glyph';
import type { BudgetUsage } from '../stores/budgetStore';
import { formatMoney } from '../lib/constants';
import { useT } from '../lib/i18n';

interface Props {
  usages: BudgetUsage[];
}

const DISMISS_KEY = 'hisaab_budget_warning_dismissed_v1';

// Renders only when at least one budget has crossed its warn threshold.
// The dismiss state is per-session-only — keeps the banner from being
// annoying mid-session but it will return tomorrow if the user is still
// over-budget. (That's the point.)
export function BudgetWarningBanner({ usages }: Props) {
  const t = useT();
  const navigate = useNavigate();
  const [hidden, setHidden] = useState(() => {
    try {
      const raw = sessionStorage.getItem(DISMISS_KEY);
      return raw === '1';
    } catch {
      return false;
    }
  });

  const flagged = usages.filter((u) => u.overWarn);
  if (hidden || flagged.length === 0) return null;

  // Lead with the most-overspent budget so the headline is immediately
  // actionable even when multiple are flagged.
  const headline = [...flagged].sort((a, b) => b.percent - a.percent)[0];

  const handleDismiss = () => {
    try {
      sessionStorage.setItem(DISMISS_KEY, '1');
    } catch {
      /* sessionStorage unavailable — UI still hides via state */
    }
    setHidden(true);
  };

  // Tinted card in the budget's state: coral once over the cap, gold while
  // only nearing it — the wallet glyph wears the same accent.
  return (
    <div
      className={`m-card ${headline.overLimit ? 'm-coral' : 'm-gold'} px-4 py-3.5 flex items-center gap-3`}
    >
      <div className="m-ctl w-10 h-10 rounded-[14px] flex items-center justify-center shrink-0">
        <Glyph name="wallet" size={19} tone={headline.overLimit ? 'coral' : 'gold'} />
      </div>
      <button
        onClick={() => navigate('/budgets')}
        className="flex-1 min-w-0 text-left"
      >
        <p className="text-[13px] font-semibold text-ink-900 tracking-tight">
          {headline.overLimit ? t('bwb_over_budget') : t('bwb_near_cap')} ·{' '}
          {headline.budget.category}
        </p>
        <p className="text-[11.5px] text-ink-600 mt-0.5 leading-snug tabular-nums">
          {t('bwb_spent_of')
            .replace('{spent}', formatMoney(headline.spent, headline.budget.currency))
            .replace('{total}', formatMoney(headline.budget.monthlyAmount, headline.budget.currency))}
          {flagged.length > 1 && ` · ${t('wom_more_sources').replace('{n}', String(flagged.length - 1))}`}
        </p>
      </button>
      <button
        onClick={handleDismiss}
        aria-label={t('a11y_dismiss')}
        className='relative w-8 h-8 rounded-[10px] flex items-center justify-center text-ink-500 active:bg-cream-soft transition-colors shrink-0 before:absolute before:-inset-1.5 before:content-[""]'
      >
        <Glyph name="close" size={14} />
      </button>
    </div>
  );
}
