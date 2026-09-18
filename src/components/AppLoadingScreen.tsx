import { useEffect, useState } from 'react';
import { BrandMark } from './BrandMark';
import { Glyph } from './Glyph';
import { useT } from '../lib/i18n';

// The loading hero: one big word typed out, held, deleted, then the next.
// Everything Hisaab handles, in the brand green of the logo tile. English +
// Roman-Urdu mix on purpose — same register as the rest of the app copy.
const TYPE_WORDS = ['Loans', 'Expenses', 'Kameti', 'Splits', 'Savings', 'Sukoon'];

const TYPE_MS = 85; // per character while typing
const DELETE_MS = 45; // per character while deleting
const HOLD_MS = 1300; // full word on screen
const REDUCED_HOLD_MS = 1800; // word swap cadence without animation

// Types the words one character at a time. Under prefers-reduced-motion the
// full word just swaps on a timer — no letter churn. Every state change is
// scheduled through a timeout so the effect body never sets state directly.
function useTypewriter(words: string[]) {
  // Read once — the OS-level motion setting doesn't flip mid-load.
  const [reduced] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const [wordIndex, setWordIndex] = useState(0);
  const [text, setText] = useState('');
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    const word = words[wordIndex];
    let timer: number;
    if (reduced) {
      timer = window.setTimeout(
        () => setWordIndex((current) => (current + 1) % words.length),
        REDUCED_HOLD_MS,
      );
    } else if (!deleting) {
      if (text.length < word.length) {
        timer = window.setTimeout(() => setText(word.slice(0, text.length + 1)), TYPE_MS);
      } else {
        timer = window.setTimeout(() => setDeleting(true), HOLD_MS);
      }
    } else if (text.length > 0) {
      timer = window.setTimeout(() => setText(text.slice(0, -1)), DELETE_MS);
    } else {
      timer = window.setTimeout(() => {
        setDeleting(false);
        setWordIndex((current) => (current + 1) % words.length);
      }, TYPE_MS);
    }
    return () => window.clearTimeout(timer);
  }, [reduced, text, deleting, wordIndex, words]);

  return reduced ? words[wordIndex] : text;
}

export function AppLoadingScreen() {
  const t = useT();
  const typed = useTypewriter(TYPE_WORDS);

  return (
    <main className="app-loading-screen" role="status" aria-live="polite" aria-label={t('als_a11y_loading')}>
      <span className="sr-only">{t('als_sr_loading')}</span>

      <div className="app-loading-content">
        <div className="app-loading-brand">
          <div className="app-loading-mark" aria-hidden="true">
            <BrandMark size={46} />
          </div>
          {/* Brand name — identical in both languages, not a copy string. */}
          {/* eslint-disable-next-line no-restricted-syntax */}
          <h1>Hisaab</h1>
        </div>

        {/* Big typewriter word — the hero of the loading screen. */}
        <div className="app-loading-type" aria-hidden="true">
          <span className="app-loading-word">{typed}</span>
          <span className="app-loading-caret" />
        </div>

        <p className="app-loading-subline">{t('als_subline')}</p>

        <div className="app-loading-progress" aria-hidden="true">
          <span />
        </div>

        <p className="app-loading-trust">
          <Glyph name="lock" size={12} strokeWidth={2.6} className="text-iris-text" />
          {t('als_trust')}
        </p>
      </div>
    </main>
  );
}
