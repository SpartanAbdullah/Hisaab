import { useState } from 'react';
import { useT } from '../lib/i18n';
import { Glyph } from './Glyph';
import { quoteForDay } from '../lib/financeQuotes';
import { buildWhatsAppUrl } from '../lib/whatsappReminder';
import {
  QUOTE_ENABLED_KEY,
  QUOTE_SHOWN_KEY,
  disableDailyQuote,
  markDailyQuoteShown,
} from '../lib/dailyQuotePrefs';

// Re-exported for the (few) callers that used to import the storage keys from
// here. Their single definition now lives in src/lib/dailyQuotePrefs.ts so the
// lazy-mount gate in src/App.tsx can read them without pulling this chunk.
export { QUOTE_SHOWN_KEY, QUOTE_ENABLED_KEY };

interface Props {
  /**
   * Called once the user has dismissed (or disabled) the popup, so the gate
   * that mounted it can unmount it again. Optional so the component still
   * renders standalone in a story/test.
   */
  onDismiss?: () => void;
}

// Once-a-day money-wisdom popup. Shows on the first app open of each calendar
// day, is easy to dismiss, shareable, and can be turned off entirely (here or
// in Settings).
//
// Audit 03-performance H1 / P2 M2c: this component is now LAZY, mounted by the
// gate in src/App.tsx only once `shouldShowDailyQuote()` says it is due and the
// post-paint delay has elapsed. The "is it due?" + delay logic therefore lives
// in the gate (src/lib/dailyQuotePrefs.ts), not here — mounting this component
// AT ALL now means "show it", so it opens immediately.
export function DailyQuote({ onDismiss }: Props) {
  const t = useT();
  const [open, setOpen] = useState(true);
  const [quote] = useState(() => quoteForDay());

  const dismiss = () => {
    markDailyQuoteShown();
    setOpen(false);
    onDismiss?.();
  };

  const share = () => {
    const text = `"${quote.text}" — ${quote.author}`;
    if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
      navigator.share({ text }).catch(() => {});
    } else {
      window.open(buildWhatsAppUrl(null, text), '_blank');
    }
  };

  const turnOff = () => {
    disableDailyQuote();
    dismiss();
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center p-5"
      role="dialog"
      aria-modal="true"
      aria-labelledby="daily-wisdom-title"
    >
      <div
        className="absolute inset-0 backdrop-blur-sm animate-fade-in"
        style={{ background: 'var(--m-scrim)' }}
        aria-hidden="true"
        onClick={dismiss}
      />

      {/* Calm card (founder 2026-09-22: the rainbow version "looks like a
          clown"). The lit sheet material, one gold accent, a faint quote mark
          as the only ornament — see index.css "DAILY WISDOM". The violet
          primary is the one solid block, so it reads as the action. */}
      <div
        className="relative w-full max-w-[360px] m-card m-card-feature overflow-hidden animate-scale-in max-h-[85vh] overflow-y-auto"
        style={{ boxShadow: '0 26px 70px -26px var(--m-shadow)' }}
      >
        <div className="px-6 pt-5 pb-4">
          <div className="flex items-center gap-3">
            <div className="m-card m-gold w-10 h-10 rounded-[14px] flex items-center justify-center shrink-0" aria-hidden="true">
              <Glyph name="lightbulb" size={19} tone="gold" />
            </div>
            <p
              id="daily-wisdom-title"
              className="wisdom-eyebrow flex-1 text-[10.5px] font-bold uppercase tracking-[0.16em]"
            >
              {t('quote_daily_title')}
            </p>
            <button
              onClick={dismiss}
              className="m-ctl w-9 h-9 flex items-center justify-center shrink-0"
              aria-label={t('cancel')}
            >
              <Glyph name="close" size={15} className="text-ink-600" />
            </button>
          </div>

          <div className="relative mt-5">
            <span className="wisdom-mark absolute -top-5 -left-2 pointer-events-none" aria-hidden="true">&ldquo;</span>
            <p className="relative text-[21px] font-semibold text-ink-900 leading-[1.35] tracking-tight text-pretty pt-3">
              {quote.text}
            </p>
            <div className="flex items-center gap-2.5 mt-4">
              <span className="wisdom-rule" aria-hidden="true" />
              <p className="text-[12.5px] text-ink-600 font-medium">{quote.author}</p>
            </div>
          </div>

          <div className="flex gap-2.5 mt-7">
            <button onClick={dismiss} className="m-btn m-btn-primary flex-1 py-3.5 text-[13.5px]">
              {t('quote_got_it')}
            </button>
            <button onClick={share} className="m-btn m-btn-plain px-5 text-[13px]">
              <Glyph name="share" size={15} strokeWidth={2.6} /> {t('quote_share')}
            </button>
          </div>
          <button onClick={turnOff} className="w-full text-center text-[11px] text-ink-500 mt-2 min-h-[44px]">{t('quote_turn_off')}</button>
        </div>
      </div>
    </div>
  );
}
