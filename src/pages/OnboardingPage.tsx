import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { profilesDb } from '../lib/supabaseDb';
import { track } from '../lib/telemetry';
import { Play } from 'lucide-react';
import { BrandMark } from '../components/BrandMark';
import { Tile3D } from '../components/Tile3D';
import { Glyph } from '../components/Glyph';
import { LanguageToggle } from '../components/LanguageToggle';
import type { GlyphName, GlyphTone } from '../lib/glyphs';
import type { Tint as ClayTint } from '../lib/material';
import { MODE_QUIZ, recommendMode } from '../lib/modeQuiz';
import { useOnboardingStore } from '../stores/onboardingStore';
import { useAppModeStore } from '../stores/appModeStore';
import { useAccountStore } from '../stores/accountStore';
import { useI18nStore, useT } from '../lib/i18n';
import { Button } from '../components/Button';
import { type Currency, type AppMode, type AccountType } from '../db';
import { CurrencyPicker } from '../components/CurrencyPicker';

// Continuous 5-dot progress for the post-welcome steps (1–5). The active step
// is the violet bar (the 1d primary); completed steps stay lit in a softer violet
// so the journey reads as honest and continuous rather than five disconnected
// "STEP n of 5" counters. Welcome (step 0) is uncounted and never renders this
// row. Hoisted — components defined inside a render body lose state.
function StepDots({ current }: { current: 1 | 2 | 3 | 4 | 5 }) {
  return (
    <div className="flex items-center gap-1.5 mb-3" role="presentation" aria-label={`Step ${current} of 5`}>
      {[1, 2, 3, 4, 5].map((n) => (
        <span
          key={n}
          className={`h-1.5 rounded-full transition-all duration-300 ${
            n === current ? 'w-6 bg-accent-500' : n < current ? 'w-1.5 bg-accent-500/55' : 'w-1.5 bg-white/20'
          }`}
        />
      ))}
    </div>
  );
}

// Welcome bullets: one 3c glyph per promise, in the domain's accent.
const WELCOME_BULLETS: Array<{ glyph: GlyphName; tone: GlyphTone; key: 'onboard_bullet_0' | 'onboard_bullet_1' | 'onboard_bullet_2' | 'onboard_bullet_3' }> = [
  { glyph: 'shield-check', tone: 'green', key: 'onboard_bullet_0' },
  { glyph: 'groups', tone: 'blue', key: 'onboard_bullet_1' },
  { glyph: 'swap', tone: 'pink', key: 'onboard_bullet_2' },
  { glyph: 'globe', tone: 'violet', key: 'onboard_bullet_3' },
];

// First-account type tiles: glyphs instead of emoji, same three types.
const ACCOUNT_TYPE_TILES: Array<{ type: 'cash' | 'bank' | 'digital_wallet'; glyph: GlyphName; tone: GlyphTone; key: 'acct_type_cash' | 'acct_type_bank' | 'acct_type_wallet' }> = [
  { type: 'cash', glyph: 'banknote', tone: 'green', key: 'acct_type_cash' },
  { type: 'bank', glyph: 'bank', tone: 'blue', key: 'acct_type_bank' },
  { type: 'digital_wallet', glyph: 'wallet', tone: 'violet', key: 'acct_type_wallet' },
];

// The intent answer routes the user's FIRST DAY: which tab they land on and
// which differentiator they meet first. Someone who came for udhaar should be
// logging a loan in minute one, not staring at an expense tracker.
type OnboardIntent = 'spending' | 'loans' | 'kameti' | 'splits' | 'budgets';

// 3D clay: each intent carries the tint + 3D icon of the domain it routes to,
// so the tint the user meets here is the tint that domain keeps everywhere
// else (CLAY_TINT_BY_DOMAIN in src/lib/clay.ts). The emoji is gone — the
// rendered icon is the picture now.
const INTENT_OPTIONS: Array<{
  value: OnboardIntent; labelKey: string; leansTo: AppMode; tint: ClayTint; icon: string;
}> = [
  // Art picked for what it SHOWS: a shopping bag for spending, a banknote
  // stack for lending/borrowing, a coin stack for kameti, a calculator for
  // splitting a bill, a dartboard for budget targets.
  { value: 'spending', labelKey: 'onboard_intent_spending', leansTo: 'full_tracker', tint: 'coral', icon: 'bag' },
  { value: 'loans', labelKey: 'onboard_intent_loans', leansTo: 'full_tracker', tint: 'blush', icon: 'money' },
  { value: 'kameti', labelKey: 'onboard_intent_kameti', leansTo: 'full_tracker', tint: 'gold', icon: 'coins' },
  { value: 'splits', labelKey: 'onboard_intent_splits', leansTo: 'splits_only', tint: 'sky', icon: 'calculator' },
  { value: 'budgets', labelKey: 'onboard_intent_budgets', leansTo: 'full_tracker', tint: 'mint', icon: 'target' },
];

const INTENT_LANDING: Record<OnboardIntent, string> = {
  spending: '/',
  loans: '/loans',
  kameti: '/kameti',
  splits: '/groups',
  budgets: '/budgets',
};

export function OnboardingPage() {
  const { completeOnboarding } = useOnboardingStore();
  const { setMode } = useAppModeStore();
  const { lang, setLang } = useI18nStore();
  const t = useT();
  const navigate = useNavigate();
  const [step, setStep] = useState(0);
  const [name, setName] = useState('');
  const [currency, setCurrency] = useState<Currency>('AED');
  const [selectedMode, setSelectedMode] = useState<AppMode>('full_tracker');
  const [intent, setIntent] = useState<OnboardIntent | null>(null);
  const [loading, setLoading] = useState(false);

  // Mode quiz state. Each answer leans toward a mode; on completion we suggest
  // one (the user can still pick either). Skip jumps straight to the cards.
  const [quizAnswers, setQuizAnswers] = useState<AppMode[]>([]);
  const [quizSkipped, setQuizSkipped] = useState(false);
  const quizComplete = quizAnswers.length === MODE_QUIZ.length;
  const quizDone = quizComplete || quizSkipped;
  const recommended = recommendMode(quizAnswers);
  const answerQuiz = (leansTo: AppMode) => {
    const next = [...quizAnswers, leansTo];
    setQuizAnswers(next);
    if (next.length === MODE_QUIZ.length) setSelectedMode(recommendMode(next));
  };

  // Catalog #5. Fired once, when the user leaves the mode screen with a choice
  // committed — the direct measure of "did the quiz put people in the right
  // mode" (report 10 funnel 2). `was_default_kept` is false whenever they
  // overrode the recommendation, which is the quiz-mislead signal.
  const confirmModeSelection = () => {
    track('onboarding_mode_selected', {
      mode: selectedMode,
      quiz_intent: intent ?? 'none',
      was_default_kept: !quizSkipped && selectedMode === recommended,
      quiz_skipped: quizSkipped,
    });
  };

  // Activation funnel, catalog #4: one event per step entered. The biggest
  // drop between consecutive `step` values IS the onboarding problem — today
  // that is unknowable (audit 2026-09 report 10, F1).
  useEffect(() => {
    track('onboarding_step_viewed', { step });
  }, [step]);

  // First-account fields — only used (and only shown) for full_tracker.
  const [acctType, setAcctType] = useState<AccountType>('cash');
  const [acctName, setAcctName] = useState('');
  const [acctBalance, setAcctBalance] = useState('');
  // Opening balance may be blank (= 0) but never negative or non-numeric.
  const acctBalanceValid =
    acctBalance.trim() === '' ||
    (Number.isFinite(parseFloat(acctBalance)) && parseFloat(acctBalance) >= 0);

  // Finish onboarding. For full_tracker, optionally create the first account so
  // the user lands ready; account creation is best-effort and never blocks.
  const handleFinish = async (withAccount: boolean) => {
    if (!name.trim()) return;
    setLoading(true);
    setMode(selectedMode);
    let accountCreated = false;
    if (withAccount && selectedMode === 'full_tracker' && acctName.trim()) {
      try {
        await useAccountStore.getState().createAccount({
          name: acctName.trim(), type: acctType, currency, balance: Math.max(0, parseFloat(acctBalance) || 0),
        });
        accountCreated = true;
        // Catalog #7 for the onboarding source. The accounts-page source is
        // owned by AddAccountStepper (see the telemetry follow-up list).
        track('account_created', { account_type: acctType, is_first: true, source: 'onboarding' });
      } catch (err) {
        console.error('onboarding account create failed (non-fatal)', err);
      }
    }
    await completeOnboarding(name.trim(), currency, selectedMode);
    // Catalog #6 — the activation funnel's second milestone. `mode` here is the
    // fork the whole app branches on, so every downstream cohort splits by it.
    track('onboarding_completed', {
      mode: selectedMode,
      language: lang,
      currency,
      created_first_account: accountCreated,
    });
    // Land the user where their stated intent lives — locally instant,
    // durably mirrored to the profile (best-effort; column may not exist
    // until the migration is applied).
    if (intent) {
      localStorage.setItem('hisaab_onboarding_intent', intent);
      profilesDb.updateCurrent({ onboarding_intent: intent }).catch(() => {});
      const dest = INTENT_LANDING[intent];
      if (dest !== '/') navigate(dest, { replace: true });
    }
  };

  return (
    <div className="auth-ink-dark min-h-dvh relative overflow-y-auto overflow-x-hidden bg-navy-bloom">
      {/* Background — the 1d hero ground (.bg-navy-bloom: navy gradient with
          the violet glow), dark in both themes; .auth-ink-dark flips the ink
          ramp so the material tiles below read light-on-dark in either. */}

      {/* Language — the handoff's EN/UR segmented switch. */}
      <LanguageToggle className="absolute top-5 right-5 z-50" />

      {/* Content */}
      <div className="relative text-white flex flex-col min-h-dvh">

        {/* Step 0: Welcome */}
        {step === 0 && (
          <div className="flex-1 flex flex-col items-center justify-center px-8 text-center animate-fade-in">
            <div className="w-20 h-20 rounded-[21px] mb-8 animate-bounce-in shadow-lg shadow-black/40">
              <BrandMark size={80} />
            </div>
            <h1 className="text-[36px] font-semibold tracking-[-0.035em]">{t('auth_brand_name')}</h1>
            <p className="text-white/85 text-[15px] leading-relaxed max-w-[280px] mt-4 font-medium">
              {t('onboard_tagline')}
            </p>
            <p className="text-white/70 text-[12px] leading-relaxed max-w-[260px] mt-2">
              {t('onboard_tagline_sub')}
            </p>
            {/* Trust leads: our permanent constraint IS the promise — no bank
                sync means nothing to break and nothing to leak. One card,
                hairline rows, each keyed by its 3c glyph. */}
            <div className="m-card mt-8 text-left w-full max-w-[280px] overflow-hidden divide-y divide-cream-hairline">
              {WELCOME_BULLETS.map((item) => (
                <div key={item.key} className="flex items-center gap-3 px-4 py-3">
                  <Glyph name={item.glyph} tone={item.tone} size={18} />
                  <span className="text-[13px] text-white/90 font-medium leading-snug">{t(item.key)}</span>
                </div>
              ))}
            </div>
            {/* Language confirmation — default is Roman Urdu (DEFAULT_LANGUAGE in
                src/lib/i18n.ts); the user can switch to English right at the
                start (also toggleable any time via the corner button and in
                Settings). */}
            <div className="mt-8 w-full max-w-[280px]">
              <p className="m-label text-white/70 mb-2.5 text-left">{t('onboard_language_label')}</p>
              {/* 1d tiles. `selected` is the system's one selection treatment
                  (the violet ring + aria-pressed); the violet tint doubles the
                  signal. */}
              <div className="grid grid-cols-2 gap-2.5">
                {(['en', 'ur'] as const).map((l) => (
                  <Tile3D
                    key={l}
                    tint={lang === l ? 'accent' : 'neutral'}
                    title={l === 'en' ? t('lang_en') : t('lang_ur')}
                    selected={lang === l}
                    onClick={() => setLang(l)}
                    className="text-center font-bold"
                  />
                ))}
              </div>
            </div>
            <div className="mt-6 w-full max-w-[280px]">
              <Button variant="primary" size="lg" onClick={() => setStep(1)} icon={<Glyph name="arrow-right" size={16} strokeWidth={2.8} />}>
                {t('onboard_start')}
              </Button>
            </div>
            <p className="text-white/60 text-[11px] mt-5 tracking-wide">{t('onboard_footer')}</p>
          </div>
        )}

        {/* Step 1: Name + Currency */}
        {step === 1 && (
          <div className="flex-1 flex flex-col px-8 pt-20 animate-fade-in">
            <div className="mb-8">
              <StepDots current={1} />
              <h2 className="text-[24px] font-semibold tracking-[-0.02em] text-white">{t('onboard_your_name')}</h2>
              <p className="text-white/70 text-[13px] mt-2">{t('onboard_name_sub')}</p>
            </div>
            <div className="space-y-6">
              <div>
                <label htmlFor="onboard-name" className="m-label block text-white/70 mb-2">{t('onboard_name_label')}</label>
                <input id="onboard-name" value={name} onChange={e => setName(e.target.value)} placeholder={t('onboard_name_placeholder')}
                  className="m-inset w-full border border-white/35 rounded-[16px] px-4 py-4 text-white placeholder:text-white/60 focus:outline-none focus:ring-2 focus:ring-accent-500/30 focus:border-accent-500/80 tracking-tight transition-[border-color,box-shadow]" autoFocus />
              </div>
              <div>
                <p className="m-label text-white/70 mb-2">{t('onboard_currency_label')}</p>
                <p className="text-[11px] text-white/70 leading-relaxed mb-3">{t('onboard_currency_help')}</p>
                {/* tone="on-dark" — the onboarding hero is the one screen
                    that paints its own navy ground, so the chips are frosted
                    white instead of the cream `.selector-base`. No `used`:
                    this is the very first screen, the user has no accounts. */}
                <CurrencyPicker
                  value={currency}
                  onChange={setCurrency}
                  primary={currency}
                  tone="on-dark"
                />
              </div>
            </div>
            <div className="mt-auto pb-8">
              <Button variant="primary" size="lg" onClick={() => setStep(2)} disabled={!name.trim()} icon={<Glyph name="arrow-right" size={16} strokeWidth={2.8} />}>
                {t('onboard_next')}
              </Button>
            </div>
          </div>
        )}

        {/* Step 2: Intent — "what brings you here" routes the first day */}
        {step === 2 && (
          <div className="flex-1 flex flex-col px-8 pt-20 animate-fade-in">
            <div className="mb-6">
              <StepDots current={2} />
              <h2 className="text-[24px] font-semibold tracking-[-0.02em] text-white">{t('onboard_intent_title')}</h2>
              <p className="text-white/70 text-[13px] mt-2 leading-relaxed">{t('onboard_intent_sub')}</p>
            </div>
            {/* 1d tiles, each tinted in the domain it routes to, its glyph
                inside the tile's corner (nothing overhangs any more, so the
                list only needs the wall clearance). */}
            <div className="space-y-3 flex-1">
              {INTENT_OPTIONS.map((opt) => (
                <Tile3D
                  key={opt.value}
                  tint={opt.tint}
                  icon={opt.icon}
                  title={t(opt.labelKey as Parameters<typeof t>[0])}
                  // Single-line label in a 76px icon tile: centre it vertically
                  // rather than leave it stranded at the top edge.
                  className="flex items-center"
                  onClick={() => {
                    setIntent(opt.value);
                    setSelectedMode(opt.leansTo);
                    setStep(3);
                  }}
                />
              ))}
            </div>
            <div className="pb-6">
              <button onClick={() => setStep(3)} className="text-[12px] text-white/60 w-full text-center min-h-[44px] font-medium">{t('onboard_intent_skip')}</button>
              <button onClick={() => setStep(1)} className="text-[11px] text-white/60 w-full text-center min-h-[44px] font-medium">{t('onboard_back')}</button>
            </div>
          </div>
        )}

        {/* Step 3: Safety Reassurance */}
        {step === 3 && (
          <div className="flex-1 flex flex-col px-8 pt-16 animate-fade-in">
            <div className="flex justify-center mb-3">
              <StepDots current={3} />
            </div>
            <div className="flex items-center justify-center mb-6">
              <div className="m-plate m-mint" aria-hidden>
                <Glyph name="shield-check" tone="green" size={26} extrude />
              </div>
            </div>
            <h2 className="text-[24px] font-semibold tracking-[-0.02em] text-center mb-2 text-white">{t('onboard_safety_title')}</h2>
            <p className="text-white/70 text-[12px] text-center mb-6">{t('onboard_safety_sub')}</p>
            <div className="m-card overflow-hidden divide-y divide-cream-hairline">
              {[
                { text: t('onboard_safety_1'), sub: t('onboard_safety_1_sub') },
                { text: t('onboard_safety_2'), sub: t('onboard_safety_2_sub') },
                { text: t('onboard_safety_3'), sub: t('onboard_safety_3_sub') },
                { text: t('onboard_safety_4'), sub: t('onboard_safety_4_sub') },
                { text: t('onboard_safety_5'), sub: t('onboard_safety_5_sub') },
              ].map((item, i) => (
                <div key={i} className="flex items-start gap-3 px-4 py-3">
                  <Glyph name="check" tone="green" size={15} strokeWidth={3} className="mt-0.5" />
                  <div>
                    <p className="text-[13px] text-white/90 font-medium leading-snug">{item.text}</p>
                    <p className="text-[10.5px] text-white/70 mt-0.5">{item.sub}</p>
                  </div>
                </div>
              ))}
            </div>
            <div className="mt-auto pb-4">
              <Button variant="primary" size="lg" onClick={() => setStep(4)} icon={<Glyph name="arrow-right" size={16} strokeWidth={2.8} />}>
                {t('onboard_safety_btn')}
              </Button>
              <p className="text-white/60 text-[10.5px] text-center mt-3">{t('onboard_safety_footer')}</p>
            </div>
          </div>
        )}

        {/* Step 4: Mode quiz → recommendation */}
        {step === 4 && (
          <div className="flex-1 flex flex-col px-8 pt-16 animate-fade-in">
            <StepDots current={4} />

            {!quizDone ? (
              /* ── Quiz: one fun question at a time ── */
              <>
                <div className="mb-5">
                  <h2 className="text-[24px] font-semibold tracking-[-0.02em] text-white">{t('quiz_title')}</h2>
                  <p className="text-white/70 text-[13px] mt-2 leading-relaxed">{t('quiz_sub')}</p>
                </div>
                <p className="m-label text-accent-600 mb-4">
                  {t('quiz_progress').replace('{n}', String(quizAnswers.length + 1)).replace('{total}', String(MODE_QUIZ.length))}
                </p>
                <div className="flex-1">
                  <p className="text-white text-[17px] font-semibold tracking-[-0.01em] mb-5 leading-snug">{t(MODE_QUIZ[quizAnswers.length].promptKey as Parameters<typeof t>[0])}</p>
                  <div className="space-y-3">
                    {MODE_QUIZ[quizAnswers.length].options.map((opt) => (
                      <button
                        key={opt.labelKey}
                        onClick={() => answerQuiz(opt.leansTo)}
                        className="m-tile flex items-center gap-3.5 px-4 py-4 text-left"
                      >
                        <span className="text-2xl shrink-0">{opt.emoji}</span>
                        <span className="text-[13.5px] text-white/90 font-medium leading-snug">{t(opt.labelKey as Parameters<typeof t>[0])}</span>
                      </button>
                    ))}
                  </div>
                </div>
                <div className="pb-6">
                  <button onClick={() => setQuizSkipped(true)} className="text-[12px] text-white/60 w-full text-center min-h-[44px] font-medium">{t('quiz_skip')}</button>
                  <button onClick={() => setStep(3)} className="text-[11px] text-white/60 w-full text-center min-h-[44px] font-medium">{t('onboard_back')}</button>
                </div>
              </>
            ) : (
              /* ── Result: recommendation + both mode cards (still selectable) ── */
              <>
                <div className="mb-4">
                  <h2 className="text-[24px] font-semibold tracking-[-0.02em] text-white">{t('mode_select_title')}</h2>
                </div>

                {!quizSkipped && (
                  <div className="m-card m-violet mb-4 flex items-start gap-2.5 px-4 py-3 animate-fade-in">
                    <Glyph name="sparkle" tone="violet" size={15} className="mt-0.5" />
                    <p className="text-[12px] text-white/90 font-medium leading-snug">
                      {t('quiz_reco')}{' '}
                      <span className="font-bold text-white">{recommended === 'full_tracker' ? t('mode_full_title') : t('mode_splits_title')}</span>
                    </p>
                  </div>
                )}

                {/* 1d. The two mode cards are real pressable tiles: the
                    CHOSEN one carries its domain tint (violet = the money
                    tracker, blue = splits) plus `.m-tile-selected` — the violet
                    ring, same treatment Tile3D's `selected` emits — and the
                    other stays the plain tile. They are raw <button>s rather
                    than <Tile3D> because each holds a three-bullet list Tile3D
                    has no slot for, so aria-pressed is wired by hand here. The
                    glyph sits inside the tile's corner; pe-14 keeps the copy
                    clear of it. */}
                <div className="space-y-3 flex-1">
                  {/* Full Tracker */}
                  <button onClick={() => setSelectedMode('full_tracker')}
                    aria-pressed={selectedMode === 'full_tracker'}
                    className={`m-tile ps-5 pe-14 py-5 rounded-[22px] ${selectedMode === 'full_tracker' ? 'm-violet m-tile-selected' : 'm-neutral'}`}>
                    <Glyph name="wallet" tone="violet" size={26} extrude className="absolute top-5 end-5" />
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="font-semibold text-[14.5px] tracking-tight">{t('mode_full_title')}</p>
                      {!quizSkipped && recommended === 'full_tracker' && (
                        <span className="m-chip m-chip-violet m-chip-caps shrink-0">{t('quiz_for_you')}</span>
                      )}
                    </div>
                    <p className="text-[11px] text-ink-600 mt-0.5">{t('mode_full_sub')}</p>
                    <div className="space-y-1.5 mt-3">
                      <p className="text-[11px] text-ink-600">• {t('mode_full_1')}</p>
                      <p className="text-[11px] text-ink-600">• {t('mode_full_2')}</p>
                      <p className="text-[11px] text-ink-600">• {t('mode_full_3')}</p>
                    </div>
                  </button>

                  {/* Splits Only */}
                  <button onClick={() => setSelectedMode('splits_only')}
                    aria-pressed={selectedMode === 'splits_only'}
                    className={`m-tile ps-5 pe-14 py-5 rounded-[22px] ${selectedMode === 'splits_only' ? 'm-blue m-tile-selected' : 'm-neutral'}`}>
                    {/* A calculator: splits-only mode IS the "work out who
                        owes what" half of the app, with no wallet behind it. */}
                    <Glyph name="calculator" tone="blue" size={26} extrude className="absolute top-5 end-5" />
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="font-semibold text-[14.5px] tracking-tight">{t('mode_splits_title')}</p>
                      {!quizSkipped && recommended === 'splits_only' && (
                        <span className="m-chip m-chip-violet m-chip-caps shrink-0">{t('quiz_for_you')}</span>
                      )}
                    </div>
                    <p className="text-[11px] text-ink-600 mt-0.5">{t('mode_splits_sub')}</p>
                    <div className="space-y-1.5 mt-3">
                      <p className="text-[11px] text-ink-600">• {t('mode_splits_1')}</p>
                      <p className="text-[11px] text-ink-600">• {t('mode_splits_2')}</p>
                      <p className="text-[11px] text-ink-600">• {t('mode_splits_3')}</p>
                    </div>
                  </button>

                  <p className="text-white/60 text-[11px] text-center px-2">{t('onboard_switch_anytime')}</p>
                </div>

                <div className="pb-4">
                  <Button variant="primary" size="lg" onClick={() => { confirmModeSelection(); setStep(5); }} icon={<Glyph name="arrow-right" size={16} strokeWidth={2.8} />}>
                    {t('onboard_next')}
                  </Button>
                  <button onClick={() => { setQuizAnswers([]); setQuizSkipped(false); }} className="text-[11px] text-white/60 w-full text-center min-h-[44px] mt-2 font-medium">
                    {t('quiz_retake')}
                  </button>
                </div>
              </>
            )}
          </div>
        )}

        {/* Step 5 (full_tracker): create the first account so the user lands ready */}
        {step === 5 && selectedMode === 'full_tracker' && (
          <div className="flex-1 flex flex-col px-8 pt-16 animate-fade-in">
            <div className="mb-6">
              <StepDots current={5} />
              <h2 className="text-[24px] font-semibold tracking-[-0.02em] text-white">{name.trim()}, {t('onboard_acct_title')}</h2>
              <p className="text-white/70 text-[13px] mt-2 leading-relaxed">{t('onboard_acct_sub')}</p>
            </div>
            <div className="space-y-5 flex-1">
              <div>
                <p className="m-label text-white/70 mb-2">{t('onboard_acct_type')}</p>
                <div className="grid grid-cols-3 gap-2.5">
                  {ACCOUNT_TYPE_TILES.map(({ type: ty, glyph, tone, key }) => (
                    <button key={ty} type="button" onClick={() => setAcctType(ty)}
                      aria-pressed={acctType === ty}
                      className={`m-tile px-2 pt-3.5 pb-3 text-center ${acctType === ty ? 'm-violet m-tile-selected' : ''}`}>
                      <Glyph name={glyph} tone={tone} size={24} extrude className="mx-auto" />
                      <p className="font-semibold text-[12px] mt-1.5 text-white">{t(key)}</p>
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <label htmlFor="onboard-acct-name" className="m-label block text-white/70 mb-2">{t('onboard_acct_name')}</label>
                <input id="onboard-acct-name" value={acctName} onChange={e => setAcctName(e.target.value)} placeholder={t('onboard_acct_name_ph')}
                  className="m-inset w-full border border-white/35 rounded-[16px] px-4 py-4 text-white placeholder:text-white/60 focus:outline-none focus:ring-2 focus:ring-accent-500/30 focus:border-accent-500/80 tracking-tight transition-[border-color,box-shadow]" autoFocus />
              </div>
              <div>
                <label htmlFor="onboard-acct-balance" className="m-label block text-white/70 mb-2">{t('onboard_acct_balance')}</label>
                <div className="relative">
                  <span className="absolute left-4 top-1/2 -translate-y-1/2 text-white/70 text-[13px] font-semibold z-[1] pointer-events-none">{currency}</span>
                  <input id="onboard-acct-balance" type="number" inputMode="decimal" value={acctBalance} onChange={e => setAcctBalance(e.target.value)} placeholder="0.00"
                    className="m-inset w-full border border-white/35 rounded-[16px] pl-16 pr-4 py-4 text-white placeholder:text-white/60 focus:outline-none focus:ring-2 focus:ring-accent-500/30 focus:border-accent-500/80 tracking-tight transition-[border-color,box-shadow] tabular-nums" />
                </div>
                {!acctBalanceValid && <p className="text-[11px] text-pay-text mt-1.5 font-medium">{t('val_balance_invalid')}</p>}
              </div>
            </div>
            {loading && (
              <div className="text-center py-4">
                <div className="w-8 h-8 border-2 border-white/15 border-t-accent-500 rounded-full animate-spin mx-auto" />
                <p className="text-[12px] text-white/70 mt-3">{t('onboard_loading')}</p>
              </div>
            )}
            <div className="pb-6 space-y-1">
              <Button variant="primary" size="lg" onClick={() => handleFinish(true)} disabled={loading || !acctName.trim() || !acctBalanceValid} icon={<Glyph name="arrow-right" size={16} strokeWidth={2.8} />}>
                {t('onboard_acct_create')}
              </Button>
              <button onClick={() => handleFinish(false)} disabled={loading} className="text-[12px] text-white/60 w-full text-center min-h-[44px] font-medium">{t('onboard_acct_skip')}</button>
              <button onClick={() => setStep(4)} className="text-[11px] text-white/60 w-full text-center min-h-[44px] font-medium">{t('onboard_back')}</button>
            </div>
          </div>
        )}

        {/* Step 5 (splits_only): fresh start — no account needed */}
        {step === 5 && selectedMode === 'splits_only' && (
          <div className="flex-1 flex flex-col px-8 pt-20 animate-fade-in">
            <div className="mb-8">
              <StepDots current={5} />
              <h2 className="text-[24px] font-semibold tracking-[-0.02em] text-white">{name.trim()}, {t('onboard_how_start')}</h2>
              <p className="text-white/70 text-[13px] mt-2">{t('onboard_how_sub')}</p>
              <p className="text-receive-text text-[12px] font-semibold mt-3">{t('onboard_start_instruction')}</p>
            </div>
            {/* 1d: the finish action for splits-only mode is a real mint tile,
                its sparkle glyph inside the corner. */}
            <div className="space-y-3 flex-1">
              <button onClick={() => handleFinish(false)} disabled={loading}
                className="m-tile m-mint ps-6 pe-14 py-6 rounded-[22px]">
                <Glyph name="sparkle" tone="green" size={26} extrude className="absolute top-6 end-5" />
                <div className="flex items-center gap-3 mb-3">
                  <div className="m-ctl w-11 h-11 rounded-[14px] flex items-center justify-center shrink-0" aria-hidden>
                    <Play size={20} className="text-glyph-green" strokeWidth={2.4} />
                  </div>
                  <div>
                    <p className="font-semibold text-[14.5px] tracking-tight">{t('onboard_fresh_title')}</p>
                    <p className="text-[11px] text-ink-600">{t('onboard_fresh_sub')}</p>
                  </div>
                </div>
                <p className="text-[12px] text-ink-600 leading-relaxed">
                  {selectedMode === 'splits_only' ? t('onboard_fresh_desc_splits') : t('onboard_fresh_desc')}
                </p>
                <div className="mt-5 space-y-2.5">
                  {(selectedMode === 'splits_only'
                    ? [
                        t('onboard_fresh_tip_iou'),
                        t('onboard_fresh_tip_groups'),
                        t('onboard_fresh_tip_contacts'),
                        t('onboard_fresh_tip_reminders'),
                      ]
                    : [
                        t('onboard_fresh_tip_cash'),
                        t('onboard_fresh_tip_bank'),
                        t('onboard_fresh_tip_savings'),
                        t('onboard_fresh_tip_loans'),
                        t('onboard_fresh_tip_transactions'),
                      ]).map((tip) => (
                    <div key={tip} className="flex items-start gap-2.5">
                      <Glyph name="check" tone="green" size={14} strokeWidth={3} className="mt-0.5" />
                      <p className="text-[11px] text-ink-700 leading-snug">{tip}</p>
                    </div>
                  ))}
                </div>
                {/* The tile's call to action wears the brand-violet primary material
                    (a presentational block — the whole tile is the button). */}
                <div className="m-btn m-btn-primary flex mt-5 -me-8 py-3 text-[13px]">
                  {t('onboard_fresh_cta')}
                </div>
              </button>
              <div className="m-card p-4">
                <p className="text-[12px] text-white/75 leading-relaxed">{t('onboard_linked_contacts_help')}</p>
              </div>
            </div>
            {loading && (
              <div className="text-center py-6">
                <div className="w-8 h-8 border-2 border-white/15 border-t-accent-500 rounded-full animate-spin mx-auto" />
                <p className="text-[12px] text-white/70 mt-3">{t('onboard_loading')}</p>
              </div>
            )}
            <div className="pb-8">
              <button onClick={() => setStep(4)} className="text-[11px] text-white/60 w-full text-center min-h-[44px] font-medium">{t('onboard_back')}</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
