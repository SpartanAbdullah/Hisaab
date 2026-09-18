import { useI18nStore, useT, type Language } from '../lib/i18n';

interface Props {
  // `on-navy` is the canonical placement — inside a NavyHero TopBar action
  // slot, or on a full-screen navy page (auth, onboarding, update gate).
  // `on-cream` is for the pages still using PageHeader (Goals, Analytics,
  // Activity) and any sheet-body inline placements.
  tone?: 'on-navy' | 'on-cream';
  className?: string;
}

// Language codes, not copy — identical in both languages by definition.
const LANGS: { code: Language; label: string }[] = [
  { code: 'en', label: 'EN' },
  { code: 'ur', label: 'UR' },
];

// The handoff's EN/UR switcher: a 1d segmented track (.m-seg) with the active
// language on the light-faced pill. Two real buttons, so each language is one
// tap and the current one is announced (aria-pressed) instead of being implied
// by a single button that reads the OTHER language.
export function LanguageToggle({ tone = 'on-navy', className = '' }: Props) {
  const t = useT();
  const { lang, setLang } = useI18nStore();
  const isOnNavy = tone === 'on-navy';
  return (
    <div role="group" aria-label={t('settings_language')} className={`m-seg shrink-0 ${className}`}>
      {LANGS.map(({ code, label }) => {
        const active = lang === code;
        return (
          <button
            key={code}
            type="button"
            aria-pressed={active}
            onClick={() => setLang(code)}
            // Compact, as in the handoff header (≈68px wide, 36px tall):
            // header rows also carry back, title, actions and the bell.
            // The track's inactive ink is only re-scoped for dark inside
            // .m-hero; the full-screen navy pages (.bg-navy-bloom) need it
            // said explicitly, or the idle code reads navy-on-navy.
            className={`px-2 text-[10px] font-bold tracking-[0.04em] ${
              !active && isOnNavy ? 'text-white/70' : ''
            }`}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}
