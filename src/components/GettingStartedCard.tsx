import { useT } from '../lib/i18n';
import { Card3D } from './Card3D';
import { Button } from './Button';
import { Glyph } from './Glyph';

interface Props {
  accountCount: number;
  transactionCount: number;
  onAddAccount: () => void;
  onLogEntry: () => void;
}

// A two-step "first win" for brand-new users: add an account, then log the
// first entry. Shows live progress and disappears once both are done — the
// populated dashboard is the reward. Replaces the lone add-account CTA so the
// path to value is guided rather than a dead-end empty state.
export function GettingStartedCard({ accountCount, transactionCount, onAddAccount, onLogEntry }: Props) {
  const t = useT();
  const hasAccount = accountCount > 0;
  const hasEntry = transactionCount > 0;
  if (hasAccount && hasEntry) return null;

  const done = (hasAccount ? 1 : 0) + (hasEntry ? 1 : 0);
  const steps = [
    { done: hasAccount, label: t('gs_step_account'), cta: t('gs_cta_add'), onClick: onAddAccount, enabled: true },
    { done: hasEntry, label: t('gs_step_entry'), cta: t('gs_cta_log'), onClick: onLogEntry, enabled: hasAccount },
  ];

  return (
    // The very first thing a new user sees. A violet feature card with the
    // wallet glyph in its corner — step 1 of the two below is "add an
    // account", and a wallet is the picture of an account. The card itself is
    // informational (the two step rows carry the taps), so it is a Card3D,
    // not a tile.
    <Card3D tint="accent" padding="lg" icon="wallet" feature>
      {/* The counter sits on the TITLE line only, so the subtitle keeps the
          full content width (roman Urdu runs long). The icon gutter comes
          from Card3D's `icon` prop. */}
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-[15px] font-semibold text-ink-900 tracking-tight min-w-0">{t('gs_title')}</p>
        <span className="text-[11px] font-semibold text-accent-text tabular-nums shrink-0">
          {t('gs_progress').replace('{done}', String(done)).replace('{total}', '2')}
        </span>
      </div>
      <p className="text-[12px] text-ink-600 mt-0.5">{t('gs_subtitle')}</p>

      {/* `icon` puts a 56px inline-end gutter on the WHOLE card, which is
          right for the two lines that sit under the glyph and wrong for the
          step rows below it. -me-10 hands 40px back, landing the rows on the
          card's own padding. A finished step sinks into the card (an inset
          well, struck through); an open one stays a raised row. */}
      <div className="mt-4 space-y-2.5 -me-10">
        {steps.map((s, i) => (
          <div
            key={i}
            className={`flex items-center gap-3 rounded-2xl p-3 ${
              s.done ? 'm-inset' : 'bg-cream-card shadow-[inset_0_1px_0_var(--m-hi),0_2px_0_var(--m-field-wall)]'
            }`}
          >
            <div
              className={`w-7 h-7 rounded-full flex items-center justify-center shrink-0 ${
                s.done
                  ? 'm-stat-dot m-stat-dot-receive'
                  : s.enabled
                    ? 'm-ctl text-accent-text'
                    : 'bg-cream-soft text-ink-400'
              }`}
            >
              {s.done ? <Glyph name="check" size={14} strokeWidth={3} /> : <span className="text-[12px] font-semibold">{i + 1}</span>}
            </div>
            <p className={`flex-1 text-[13px] font-semibold ${s.done ? 'text-ink-600 line-through' : s.enabled ? 'text-ink-900' : 'text-ink-400'}`}>
              {s.label}
            </p>
            {!s.done && (
              <Button
                size="sm"
                onClick={s.onClick}
                disabled={!s.enabled}
                className="shrink-0 !text-[11.5px]"
              >
                {s.cta}
              </Button>
            )}
          </div>
        ))}
      </div>
    </Card3D>
  );
}
