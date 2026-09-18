import { useEffect, useRef, useState } from 'react';
import { BrandMark } from '../components/BrandMark';
import { Glyph } from '../components/Glyph';
import { LanguageToggle } from '../components/LanguageToggle';
import { useSupabaseAuthStore } from '../stores/supabaseAuthStore';
import { supabase } from '../lib/supabase';
import { useT } from '../lib/i18n';
import type { I18nKey } from '../lib/i18n';
import { validatePassword, passwordChecks } from '../lib/passwordPolicy';
import { isValidEmail, suggestEmailFix } from '../lib/validateEmail';
import { mapAuthError, type Detour } from '../lib/authErrorMap';
import { track } from '../lib/telemetry';

// ── Rotating feature word ──────────────────────────────────────────────
// One coloured word per real app feature, in that domain's 1d accent
// (violet = loans' linked side, coral = out, gold = kameti, blue = shared,
// green = in). Token classes, not hex: the auth page sits on .bg-navy-bloom,
// which re-scopes every *-text token to its dark-hero value in BOTH themes —
// all ≥6:1 on the navy (iris #B7A4FF, pay #F2967C, gold #E8C063, cobalt
// #9BB6FA, receive #3FD7A6).
const HEADLINE_WORDS: { key: I18nKey; colorClass: string }[] = [
  { key: 'auth_word_loans', colorClass: 'text-iris-text' },
  { key: 'auth_word_expenses', colorClass: 'text-pay-text' },
  { key: 'auth_word_committees', colorClass: 'text-warn-700' },
  { key: 'auth_word_splits', colorClass: 'text-cobalt-text' },
  { key: 'auth_word_savings', colorClass: 'text-receive-text' },
];

function RotatingHeadline() {
  const t = useT();
  const [i, setI] = useState(0);

  useEffect(() => {
    // Reduced-motion: never start the cycle — freeze on the first (flagship) word.
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const id = window.setInterval(() => {
      // Pause while the tab/app is backgrounded (battery on the Capacitor wrapper).
      if (!document.hidden) setI(v => (v + 1) % HEADLINE_WORDS.length);
    }, 2600);
    return () => window.clearInterval(id);
  }, []);

  const w = HEADLINE_WORDS[i];
  return (
    <div className="mt-3 text-center">
      {/* One stable sentence for assistive tech, instead of a flicker of words. */}
      <span className="sr-only">{t('auth_headline_sr')}</span>
      <p aria-hidden className="text-white/70 text-[13px] tracking-wide">{t('auth_headline_prefix')}</p>
      {/* Fixed height so the swap never shifts the layout; overflow clips the rise. */}
      <div aria-hidden className="h-8 flex items-center justify-center overflow-hidden">
        <span key={i} className={`animate-word-morph text-[22px] font-semibold tracking-[-0.02em] leading-none ${w.colorClass}`}>
          {t(w.key)}
        </span>
      </div>
    </div>
  );
}

export function AuthPage() {
  const t = useT();
  const { signIn, signUp, requestPasswordReset, error } = useSupabaseAuthStore();
  const [mode, setMode] = useState<'login' | 'signup' | 'reset'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  // A raw Supabase error is never rendered directly — it's mapped to a Detour.
  const [detour, setDetour] = useState<Detour | null>(null);
  // Reset flow uses an enumeration-safe "if an account exists…" message that is
  // deliberately kept OUT of the error map and shown as a calm confirmation.
  const [resetMsg, setResetMsg] = useState('');
  // After a successful signup we swap the form for a prominent "check your
  // email" screen instead of a faint message line.
  const [signupSent, setSignupSent] = useState(false);
  const [sentEmail, setSentEmail] = useState('');
  const [resending, setResending] = useState(false);
  const [resentMsg, setResentMsg] = useState('');
  // Set by the verification screen when the user taps "I've verified — log in":
  // greet them with a success banner instead of a bare login form.
  const [justVerified, setJustVerified] = useState(false);

  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  // Activation funnel step 1 (telemetry catalog `signup_started`). Fired the
  // first time the user lands on the Sign Up form, so the gap to
  // `auth_completed` measures form abandonment, not submit failures.
  const signupStartedRef = useRef(false);

  const checks = passwordChecks(password);
  const pwStrong = mode === 'signup' && checks.length && checks.letter && checks.number;
  const emailErr = detour?.field === 'email';
  const passwordErr = detour?.field === 'password';
  // "Did you mean gmail.com?" — only when the typed address looks like a known
  // domain typo, so a mistyped email doesn't strand the user in verify limbo.
  const emailSuggestion = suggestEmailFix(email);

  useEffect(() => {
    if (sessionStorage.getItem('hisaab_just_verified')) {
      sessionStorage.removeItem('hisaab_just_verified');
      setJustVerified(true);
      setMode('login');
    }
  }, []);

  // Surface externally-set store errors (e.g. a deleted-account session blocked
  // at app boot) through the same detour mapper. Local call failures set the
  // detour directly in handleSubmit, so this is only a safety net.
  useEffect(() => {
    if (error) setDetour(mapAuthError(error));
  }, [error]);

  const resendVerification = async () => {
    if (!sentEmail) return;
    setResending(true);
    setResentMsg('');
    try {
      const { error: resendError } = await supabase.auth.resend({ type: 'signup', email: sentEmail });
      setResentMsg(resendError ? resendError.message : t('verify_resent'));
    } finally {
      setResending(false);
    }
  };

  // Resend triggered from an "email not confirmed" detour — lands the user in
  // the familiar "check your email" screen on success.
  const resendFromError = async () => {
    if (!email || resending) return;
    setResending(true);
    try {
      const { error: resendError } = await supabase.auth.resend({ type: 'signup', email });
      if (resendError) {
        setDetour(mapAuthError(resendError.message));
      } else {
        setSentEmail(email);
        setSignupSent(true);
        setDetour(null);
      }
    } finally {
      setResending(false);
    }
  };

  const backToLogin = () => {
    setSignupSent(false);
    setMode('login');
    setPassword('');
    setDetour(null);
    setResetMsg('');
    setResentMsg('');
  };

  const switchMode = (next: 'login' | 'signup' | 'reset') => {
    if (next === 'signup' && !signupStartedRef.current) {
      signupStartedRef.current = true;
      track('signup_started', { method: 'email' });
    }
    setMode(next);
    setDetour(null);
    setResetMsg('');
  };

  const handleSubmit = async () => {
    if (!email) return;
    if (mode !== 'reset' && !password) return;
    // Enforce password policy at signup only — login uses whatever password
    // the account already has (may predate the new policy).
    if (mode === 'signup') {
      const policy = validatePassword(password);
      if (!policy.valid) {
        setDetour({
          msgKey: policy.code === 'too_short' ? 'err_password_short' : 'err_password_weak',
          actionKey: 'err_password_action',
          action: 'fixPassword',
          field: 'password',
        });
        return;
      }
    }
    setLoading(true);
    setDetour(null);
    setResetMsg('');

    if (mode === 'signup') {
      const result = await signUp(email, password);
      if (result.success) {
        // Catalog #3. The account exists at this point; email verification is
        // the next gate, which the drop-off between this and `app_opened`
        // (is_logged_in) will show.
        track('auth_completed', { method: 'email', is_new_user: true });
        setSentEmail(email);
        setSignupSent(true);
      } else {
        setDetour(mapAuthError(result.message));
      }
    } else if (mode === 'reset') {
      const result = await requestPasswordReset(email);
      if (result.success) setResetMsg(result.message);
      else setDetour(mapAuthError(result.message));
    } else {
      const result = await signIn(email, password);
      if (result.success) track('auth_completed', { method: 'email', is_new_user: false });
      else setDetour(mapAuthError(result.message));
    }
    setLoading(false);
  };

  // An error's inline action re-routes the user instead of leaving them stuck.
  const runDetour = () => {
    if (!detour) return;
    switch (detour.action) {
      case 'reset':
        switchMode('reset'); // keep the typed email prefilled
        break;
      case 'login':
        setMode('login');
        setPassword('');
        setDetour(null);
        setResetMsg('');
        setTimeout(() => passwordRef.current?.focus(), 0);
        break;
      case 'resend':
        void resendFromError();
        break;
      case 'fixPassword':
        setDetour(null);
        passwordRef.current?.focus();
        break;
      case 'editEmail':
        setDetour(null);
        emailRef.current?.focus();
        emailRef.current?.select();
        break;
      case 'newAccount':
        setMode('signup');
        setEmail('');
        setPassword('');
        setDetour(null);
        setResetMsg('');
        break;
      case 'retry':
        setDetour(null);
        void handleSubmit();
        break;
      case 'dismiss':
      default:
        setDetour(null);
        break;
    }
  };

  // 1d dark field: the sunken well (.m-inset — the navy page re-scopes it to
  // its dark face in both themes) with a hairline rim that lights violet on
  // focus and coral on error. .auth-input drives the floating label.
  const inputBase = 'auth-input peer m-inset w-full border rounded-[16px] px-4 pl-12 pt-6 pb-2 text-white text-[15px] tracking-tight transition-[border-color,box-shadow] focus:outline-none focus:ring-2';
  // white/35 rim ≈ 3.3:1 against the page — the control's WCAG 1.4.11 edge.
  const inputOk = 'border-white/35 focus:ring-accent-500/30 focus:border-accent-500/80';
  const inputBad = 'border-glyph-coral/80 focus:ring-glyph-coral/30 focus:border-glyph-coral';

  return (
    <main className="auth-ink-dark min-h-dvh relative overflow-hidden bg-navy-bloom" aria-labelledby="auth-heading">
      {/* The 1d hero ground (.bg-navy-bloom), dark in both themes, matches
          Onboarding so the auth → onboard flow reads as one surface;
          .auth-ink-dark flips the ink ramp for the material inside. */}

      {/* Language — the handoff's EN/UR segmented switch. */}
      <LanguageToggle className="absolute top-5 right-5 z-50" />

      {/* Prominent "check your email" screen after a successful signup. */}
      {signupSent && (
        <div className="relative text-white flex flex-col items-center justify-center min-h-dvh px-8 text-center animate-fade-in">
          <div className="m-plate m-mint mb-6 animate-bounce-in" aria-hidden>
            <Glyph name="mail" tone="green" size={26} extrude />
          </div>
          <h1 id="auth-heading" className="text-[24px] font-semibold tracking-[-0.02em] mb-3">{t('verify_title')}</h1>
          <p className="text-white/70 text-[13px] leading-relaxed max-w-[300px]">{t('verify_body')}</p>
          <p className="text-white text-[14px] font-semibold mt-1.5 break-all max-w-[300px]">{sentEmail}</p>
          <p className="text-white/60 text-[12px] leading-relaxed max-w-[290px] mt-4">{t('verify_instruction')}</p>
          <p className="text-white/60 text-[11px] leading-relaxed max-w-[290px] mt-2">{t('verify_spam')}</p>

          <div className="w-full max-w-[300px] mt-8 space-y-3">
            {/* 1d: brand-violet primary + the key-material secondary (the navy page
                gives it the dark face; .auth-ink-dark its light label). */}
            <button onClick={backToLogin}
              className="m-btn m-btn-primary w-full py-4 text-[14px]">
              {t('verify_back_login')} <Glyph name="arrow-right" size={16} strokeWidth={2.8} />
            </button>
            <button onClick={resendVerification} disabled={resending}
              className="m-btn m-btn-plain w-full py-3.5 text-[13px]">
              {resending ? t('verify_resending') : t('verify_resend')}
            </button>
          </div>
          {resentMsg && <p className="text-receive-text text-[12px] mt-4 max-w-[290px] leading-relaxed">{resentMsg}</p>}
          <button onClick={() => { setSignupSent(false); setMode('signup'); setResentMsg(''); }}
            className="text-white/60 text-[11px] underline mt-6 min-h-[44px]">{t('verify_diff_email')}</button>
        </div>
      )}

      {!signupSent && (
      <div className="relative text-white flex flex-col min-h-dvh px-8">
        {/* Logo + living headline */}
        <div className="flex flex-col items-center pt-16 mb-8">
          <div className="w-16 h-16 rounded-[17px] mb-4 shadow-lg shadow-black/40">
            <BrandMark size={64} />
          </div>
          <h1 id="auth-heading" className="text-[30px] font-semibold tracking-[-0.03em]">{t('auth_brand_name')}</h1>
          {/* Rotating colored feature word — teaches "what does this app do?" in
              the first few seconds, and pre-cues the violet action color. */}
          <RotatingHeadline />
          {/* Trust line — the no-ads / privacy promise belongs on the very
              first screen, not hidden until after onboarding. */}
          <p className="text-white/60 text-[10.5px] mt-3 tracking-wide">{t('auth_trust')}</p>
        </div>

        {/* Email-confirmed banner — shown after the verification screen hands
            the user back to log in, so the login form isn't a bare dead-end. */}
        {justVerified && mode === 'login' && (
          <div role="status" className="m-card m-mint mb-5 flex items-center justify-center gap-2 px-4 py-3 text-receive-text text-[12.5px] font-medium animate-fade-in">
            <Glyph name="check" size={14} strokeWidth={2.8} />
            <span className="leading-relaxed">{t('verify_confirmed_login')}</span>
          </div>
        )}

        {/* Toggle */}
        {mode !== 'reset' && (
          <div className="m-seg flex w-full mb-6">
            <button onClick={() => switchMode('login')} aria-pressed={mode === 'login'}
              className={`flex-1 min-h-[38px] text-[12.5px] font-bold ${mode === 'login' ? '' : 'text-white/70'}`}>
              {t('auth_tab_login')}
            </button>
            <button onClick={() => switchMode('signup')} aria-pressed={mode === 'signup'}
              className={`flex-1 min-h-[38px] text-[12.5px] font-bold ${mode === 'signup' ? '' : 'text-white/70'}`}>
              {t('auth_tab_signup')}
            </button>
          </div>
        )}

        {/* First-action teach — the blank login screen nudges a newcomer toward
            creating an account instead of assuming they already have one. Kept
            neutral (not violet) so it never competes with the one violet CTA. */}
        {mode === 'login' && (
          <button onClick={() => switchMode('signup')}
            className="m-tile -mt-2 mb-5 flex items-center justify-center gap-2 py-3 px-4 text-[12px] text-white/80">
            <Glyph name="sparkle" tone="violet" size={14} />
            <span>{t('auth_first_action_hint')}</span>
          </button>
        )}

        {mode === 'reset' && (
          <p className="text-white/75 text-[13px] mb-4 text-center leading-relaxed">
            {t('auth_reset_intro')}
          </p>
        )}

        {/* Form */}
        <div className="space-y-4">
          <div className={`relative ${emailErr ? 'animate-shake' : ''}`}>
            <Glyph name="mail" size={16} className="absolute left-4 top-1/2 -translate-y-1/2 text-white/50 pointer-events-none z-[1]" />
            <input id="auth-email" ref={emailRef} type="email" inputMode="email" autoComplete="email"
              value={email} onChange={e => { setEmail(e.target.value); if (detour) setDetour(null); }}
              placeholder=" " aria-invalid={emailErr || undefined}
              aria-describedby={detour ? 'auth-error' : undefined}
              className={`${inputBase} pr-11 ${emailErr ? inputBad : inputOk}`} autoFocus />
            <label htmlFor="auth-email" className="auth-float-label">{t('auth_label_email')}</label>
            {/* Green tick the moment the email format looks valid — confirm, don't just flag. */}
            {isValidEmail(email) && (
              <span className="absolute right-4 top-1/2 -translate-y-1/2 w-5 h-5 rounded-full m-stat-dot-receive flex items-center justify-center animate-scale-in">
                <Glyph name="check" size={11} strokeWidth={3.4} />
              </span>
            )}
          </div>

          {/* "Did you mean gmail.com?" — a valid-format email can still be a
              typo'd domain; one tap fixes it before verify limbo. */}
          {emailSuggestion && (
            <button type="button" onClick={() => { setEmail(emailSuggestion); if (detour) setDetour(null); }}
              className="-mt-2 ml-1 text-left text-white/75 text-[11.5px] underline underline-offset-2 press-sm">
              {t('auth_did_you_mean')} <span className="font-semibold text-receive-text">{emailSuggestion}</span>
            </button>
          )}

          {mode !== 'reset' && (
            <>
              <div className={`relative ${passwordErr ? 'animate-shake' : ''}`}>
                {/* Leading icon crossfades to a green check once the password is strong. */}
                {pwStrong ? (
                  <Glyph name="check" size={16} strokeWidth={3} className="absolute left-4 top-1/2 -translate-y-1/2 text-glyph-green animate-scale-in pointer-events-none z-[1]" />
                ) : (
                  <Glyph name="lock" size={16} className="absolute left-4 top-1/2 -translate-y-1/2 text-white/50 pointer-events-none z-[1]" />
                )}
                <input id="auth-password" ref={passwordRef} type={showPassword ? 'text' : 'password'}
                  autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
                  value={password} onChange={e => { setPassword(e.target.value); if (detour) setDetour(null); }}
                  placeholder=" " aria-invalid={passwordErr || undefined}
                  aria-describedby={detour ? 'auth-error' : undefined}
                  className={`${inputBase} pr-12 ${passwordErr ? inputBad : inputOk}`}
                  onKeyDown={e => e.key === 'Enter' && handleSubmit()} />
                <label htmlFor="auth-password" className="auth-float-label">{t('auth_label_password')}</label>
                <button type="button" tabIndex={-1} onClick={() => setShowPassword(!showPassword)}
                  aria-label={showPassword ? t('auth_hide_password') : t('auth_show_password')}
                  className="absolute right-3 top-1/2 -translate-y-1/2 w-8 h-8 flex items-center justify-center text-white/60 active:text-white">
                  <Glyph name={showPassword ? 'eye-off' : 'eye'} size={16} />
                </button>
              </div>
              {mode === 'signup' && (
                pwStrong ? (
                  // All three rules met — collapse the checklist into one calm win.
                  <div className="flex items-center gap-2 pt-0.5 animate-fade-in">
                    <span className="w-4 h-4 rounded-full flex items-center justify-center shrink-0 m-stat-dot-receive">
                      <Glyph name="check" size={10} strokeWidth={3.4} />
                    </span>
                    <span className="text-[11.5px] font-medium text-receive-text">{t('pw_check_done')}</span>
                  </div>
                ) : (
                  <div className="space-y-1.5 pt-0.5">
                    {([
                      { ok: checks.length, label: t('pw_check_length') },
                      { ok: checks.letter, label: t('pw_check_letter') },
                      { ok: checks.number, label: t('pw_check_number') },
                    ]).map((c, i) => (
                      <div key={i} className="flex items-center gap-2">
                        <span className={`w-4 h-4 rounded-full flex items-center justify-center shrink-0 transition-colors ${c.ok ? 'm-stat-dot-receive' : 'bg-white/10 text-transparent border border-white/20'}`}>
                          <Glyph name="check" size={10} strokeWidth={3.4} />
                        </span>
                        <span className={`text-[11.5px] transition-colors ${c.ok ? 'text-receive-text font-medium' : 'text-white/70'}`}>{c.label}</span>
                      </div>
                    ))}
                  </div>
                )
              )}
            </>
          )}
        </div>

        {/* Forgot-password link (only on Login) */}
        {mode === 'login' && (
          <div className="text-right mt-2">
            <button onClick={() => switchMode('reset')}
              className="text-white/70 text-[11.5px] font-medium underline underline-offset-2 min-h-[32px]">
              {t('auth_forgot')}
            </button>
          </div>
        )}

        {/* Detour error — warm copy + a one-tap way forward, never a dead end. */}
        {detour && (
          <div id="auth-error" role="alert" className="mt-3 text-center animate-fade-in">
            <p className="text-pay-text text-[12.5px] font-medium leading-relaxed">{t(detour.msgKey)}</p>
            <button onClick={runDetour} disabled={resending}
              className="text-white text-[12.5px] font-semibold underline underline-offset-2 mt-1.5 min-h-[36px] disabled:opacity-50">
              {t(detour.actionKey)}
            </button>
          </div>
        )}

        {/* Reset-request confirmation — a done action, not a maybe (enumeration-safe copy). */}
        {resetMsg && (
          <div role="status" className="mt-3 flex items-center justify-center gap-2 text-receive-text text-[12.5px] font-medium animate-fade-in">
            <Glyph name="mail" size={14} />
            <span className="leading-relaxed">{resetMsg}</span>
          </div>
        )}

        {/* Primary CTA — the one violet action on the navy ground: the 1d
            primary (violet face, lit edge, two hard walls that collapse on
            press — index.css .m-btn-primary). */}
        <button onClick={handleSubmit} disabled={loading || !email || (mode !== 'reset' && !password)}
          className="m-btn m-btn-primary w-full mt-6 py-4 text-[15px]">
          {loading ? (
            <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
          ) : (
            <>
              {t(mode === 'login' ? 'auth_cta_login' : mode === 'signup' ? 'auth_cta_signup' : 'auth_cta_reset')}
              <Glyph name="arrow-right" size={16} strokeWidth={2.8} />
            </>
          )}
        </button>

        {/* Footer */}
        <p className="text-white/60 text-[11.5px] text-center mt-6 pb-8">
          {mode === 'reset' ? (
            <>
              {t('auth_remembered')}{' '}
              <button onClick={() => switchMode('login')} className="text-accent-600 font-semibold underline underline-offset-2">{t('auth_back_to_login')}</button>
            </>
          ) : mode === 'login' ? (
            <>
              {t('auth_no_account')}{' '}
              <button onClick={() => switchMode('signup')} className="text-accent-600 font-semibold underline underline-offset-2">{t('auth_tab_signup')}</button>
            </>
          ) : (
            <>
              {t('auth_have_account')}{' '}
              <button onClick={() => switchMode('login')} className="text-accent-600 font-semibold underline underline-offset-2">{t('auth_tab_login')}</button>
            </>
          )}
        </p>
      </div>
      )}
    </main>
  );
}
