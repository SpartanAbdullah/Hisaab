import { useState } from 'react';
import { Lightbulb } from 'lucide-react';
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

      {/* Rainbow frame. The drifting spectrum lives in this box and the card
          sits on top of it, so all that shows through is the 3px gutter
          between their two border radii — a moving colour outline, with no
          coloured pixel ever landing behind body text. 1d: the spectrum runs
          through the app's own accents (index.css .wisdom-*), and the card
          inside is the lit sheet material. */}
      <div
        className="relative w-full max-w-[380px] rounded-[30px] p-[3px] overflow-hidden animate-scale-in"
        style={{ boxShadow: '0 26px 70px -26px var(--m-shadow)' }}
      >
        <div className="wisdom-spectrum" aria-hidden="true" />

        <div
          className="relative bg-cream-bg rounded-[27px] px-6 pt-8 pb-5 max-h-[85vh] overflow-y-auto"
          style={{ boxShadow: 'inset 0 1px 0 var(--m-sheet-hi)' }}
        >
          <div className="wisdom-wash pointer-events-none absolute inset-x-0 top-0 h-36" aria-hidden="true" />

          <button
            onClick={dismiss}
            className="m-ctl absolute right-3.5 top-3.5 w-9 h-9 flex items-center justify-center"
            aria-label={t('cancel')}
          >
            <Glyph name="close" size={15} className="text-ink-600" />
          </button>

          <div className="relative text-center">
            {/* Same spectrum, second instance, on a plate. The navy scrim over
                it keeps the white bulb legible across every band — white on the
                gold stretch would otherwise all but vanish. */}
            <div className="relative w-14 h-14 rounded-[20px] overflow-hidden mx-auto flex items-center justify-center">
              <div className="wisdom-spectrum" aria-hidden="true" />
              <div className="absolute inset-0 bg-navy-900/35" aria-hidden="true" />
              <Lightbulb size={26} strokeWidth={2.4} className="relative text-white m-glyph-extrude" />
            </div>

            <p
              id="daily-wisdom-title"
              className="wisdom-text text-[10.5px] font-bold uppercase tracking-[0.16em] mt-4"
            >
              {t('quote_daily_title')}
            </p>
            <p className="text-[20px] font-semibold text-ink-900 leading-snug tracking-tight mt-2.5 text-balance">
              &ldquo;{quote.text}&rdquo;
            </p>
            <p className="text-[12.5px] text-ink-600 mt-3 font-medium">&mdash; {quote.author}</p>

            {/* The brand-violet primary is the one solid block on screen, so it reads
                as the action; a rainbow CTA would compete with its own frame. */}
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
    </div>
  );
}
