import { useT } from '../lib/i18n';
import { Glyph } from './Glyph';

interface Props {
  title?: string;
  message?: string;
  secondaryText?: string;
  actionLabel?: string;
  onRetry?: () => void;
  variant?: 'full' | 'inline';
  // When set, a "Contact support" link renders under the retry action — gives
  // the user a real way to act on "contact support" copy instead of a dead end.
  supportHref?: string;
}

// Single source of truth for "this page/section failed to load" UI. `full`
// takes the whole viewport (use when nothing else on the page is usable);
// `inline` is a banner that sits above otherwise-rendered content (use when
// the page has cached/partial data the user can still act on).
//
// 1d: the inline banner is a coral-tinted card (face + walls) keyed by an
// alert glyph in a raised control; the full state is the empty-state plate
// (coral) with a brand-violet primary retry — the same anatomy as EmptyState, so a
// failed screen reads as designed, not as a crash.
export function PageErrorState({
  title,
  message,
  secondaryText,
  actionLabel,
  onRetry,
  variant = 'full',
  supportHref,
}: Props) {
  const t = useT();
  // Localized fallbacks — callers can still override with explicit copy.
  const resolvedTitle = title ?? t('err_page_title');
  const resolvedMessage = message ?? t('err_page_msg');
  const resolvedActionLabel = actionLabel ?? t('err_retry');
  if (variant === 'inline') {
    return (
      <div className="m-card m-coral px-3.5 py-3 flex items-start gap-3">
        <div className="m-ctl w-9 h-9 flex items-center justify-center shrink-0" aria-hidden>
          <Glyph name="alert" tone="coral" size={16} />
        </div>
        <div className="flex-1 min-w-0 pt-0.5">
          <p className="text-[13px] font-semibold text-pay-text tracking-tight">{resolvedTitle}</p>
          <p className="text-[11.5px] text-ink-600 mt-0.5 leading-relaxed">{resolvedMessage}</p>
        </div>
        {onRetry && (
          <button
            onClick={onRetry}
            className="m-pill shrink-0 px-3 text-[11px] text-pay-text"
          >
            <Glyph name="refresh" size={12} strokeWidth={2.6} /> {resolvedActionLabel}
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="min-h-dvh flex items-center justify-center bg-cream-bg px-5">
      <div className="m-card m-card-feature w-full max-w-sm px-6 pt-8 pb-6 text-center">
        <div className="m-plate m-coral mx-auto" aria-hidden>
          <Glyph name="alert" tone="coral" size={26} extrude />
        </div>
        <h3 className="font-semibold text-[15px] text-ink-900 tracking-tight mt-[18px]">{resolvedTitle}</h3>
        <p className="text-[12px] text-ink-600 mt-1.5 leading-relaxed max-w-[270px] mx-auto">{resolvedMessage}</p>
        {secondaryText && (
          <p className="text-[11px] font-medium text-ink-500 mt-3">{secondaryText}</p>
        )}
        {onRetry && (
          <button
            onClick={onRetry}
            className="m-btn m-btn-primary mt-6 w-full py-3.5 text-[13.5px]"
          >
            <Glyph name="refresh" size={15} strokeWidth={2.6} /> {resolvedActionLabel}
          </button>
        )}
        {supportHref && (
          <a
            href={supportHref}
            className="mt-3 inline-flex items-center justify-center gap-1.5 w-full rounded-2xl py-3 text-[13px] font-semibold text-accent-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-offset-2 press"
          >
            <Glyph name="mail" size={14} /> {t('err_contact_support')}
          </a>
        )}
      </div>
    </div>
  );
}
