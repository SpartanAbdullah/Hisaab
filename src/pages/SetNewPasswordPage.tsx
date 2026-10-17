import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Glyph } from '../components/Glyph';
import { LanguageToggle } from '../components/LanguageToggle';
import { useToast } from '../components/Toast';
import { useSupabaseAuthStore } from '../stores/supabaseAuthStore';
import { useT } from '../lib/i18n';
import { validatePassword, passwordChecks } from '../lib/passwordPolicy';
import { mapAuthError, type Detour } from '../lib/authErrorMap';
import { reportError } from '../lib/errorReporter';

// ── Set a new password (SDLC review 2026-10-06, P0 #3) ──────────────────────
// The screen the password-reset email lands on. supabaseAuthStore raises
// `passwordRecovery` when the user arrives with a recovery session (see
// src/lib/passwordRecovery.ts for how that is detected), and App.tsx renders
// this ABOVE the email-verification and onboarding gates so neither can
// swallow the visit. The password itself is saved through the store's existing
// `changePassword` (supabase.auth.updateUser) — the recovery session is a
// signed-in session, so no current-password re-auth applies here, unlike the
// Settings flow.
//
// Same policy as sign-up (src/lib/passwordPolicy.ts): 8+ characters, a letter
// and a digit — enforced with the same live checklist AuthPage shows.
//
// Mode-agnostic: nothing here reads appModeStore; the flow is identical for
// full_tracker and splits_only.
export function SetNewPasswordPage() {
  const t = useT();
  const navigate = useNavigate();
  const toast = useToast();
  const user = useSupabaseAuthStore(s => s.user);
  const changePassword = useSupabaseAuthStore(s => s.changePassword);
  const clearPasswordRecovery = useSupabaseAuthStore(s => s.clearPasswordRecovery);
  const signOut = useSupabaseAuthStore(s => s.signOut);

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [saving, setSaving] = useState(false);
  // A raw Supabase error is never rendered directly — it's mapped to a Detour.
  const [detour, setDetour] = useState<Detour | null>(null);
  const [mismatch, setMismatch] = useState(false);

  const passwordRef = useRef<HTMLInputElement>(null);
  const confirmRef = useRef<HTMLInputElement>(null);

  const checks = passwordChecks(password);
  const policy = validatePassword(password);
  const pwStrong = checks.length && checks.letter && checks.number;
  const confirmTouched = confirm.length > 0;
  const matches = confirmTouched && confirm === password;
  const canSubmit = policy.valid && confirm === password && !saving;

  const handleSubmit = async () => {
    if (saving) return;
    setDetour(null);
    if (!policy.valid) {
      setDetour({
        msgKey: policy.code === 'too_short' ? 'err_password_short' : 'err_password_weak',
        actionKey: 'err_password_action',
        action: 'fixPassword',
        field: 'password',
      });
      passwordRef.current?.focus();
      return;
    }
    if (confirm !== password) {
      setMismatch(true);
      confirmRef.current?.focus();
      return;
    }
    setSaving(true);
    try {
      await changePassword(password);
      toast.show({ type: 'success', title: t('recov_success') });
      // Leave the recovery screen; the ordinary gates (verification,
      // onboarding, PIN) then run and the user lands on Home.
      clearPasswordRecovery();
      navigate('/', { replace: true });
    } catch (err) {
      reportError(err, { feature: 'SetNewPasswordPage.changePassword' });
      const message = err instanceof Error ? err.message : String(err ?? '');
      setDetour(mapAuthError(message));
    } finally {
      setSaving(false);
    }
  };

  const runDetour = () => {
    if (!detour) return;
    switch (detour.action) {
      case 'fixPassword':
        setDetour(null);
        passwordRef.current?.focus();
        break;
      case 'reset':
        // The recovery session is gone: back to AuthPage, which offers a new
        // link. signOut also clears `passwordRecovery`.
        setDetour(null);
        void signOut();
        break;
      case 'retry':
        setDetour(null);
        void handleSubmit();
        break;
      default:
        setDetour(null);
        break;
    }
  };

  // Same 1d dark field as AuthPage: sunken well, violet focus rim, coral on error.
  const inputBase = 'auth-input peer m-inset w-full border rounded-[16px] px-4 pl-12 pt-6 pb-2 text-white text-[15px] tracking-tight transition-[border-color,box-shadow] focus:outline-none focus:ring-2';
  const inputOk = 'border-white/35 focus:ring-accent-500/30 focus:border-accent-500/80';
  const inputBad = 'border-glyph-coral/80 focus:ring-glyph-coral/30 focus:border-glyph-coral';
  const passwordErr = detour?.field === 'password';
  // Live, not submit-only: the CTA stays disabled while the two differ, so a
  // submit-time message alone would never be seen. Shown once the confirm
  // field has caught up in length (so it doesn't nag mid-typing), or after an
  // Enter-key submit with a mismatch.
  const confirmErr = confirmTouched && !matches && (mismatch || confirm.length >= password.length);

  return (
    <main className="auth-ink-dark min-h-dvh relative overflow-hidden bg-navy-bloom" aria-labelledby="recov-heading">
      <LanguageToggle className="absolute top-5 right-5 z-50" />

      <div className="relative text-white flex flex-col min-h-dvh px-8">
        <div className="flex flex-col items-center pt-16 mb-6 text-center">
          <div className="m-plate m-mint mb-6" aria-hidden>
            <Glyph name="lock" tone="green" size={26} extrude />
          </div>
          <h1 id="recov-heading" className="text-[24px] font-semibold tracking-[-0.02em] mb-3">{t('recov_title')}</h1>
          <p className="text-white/70 text-[13px] leading-relaxed max-w-[300px]">{t('recov_body')}</p>
          <p className="text-white text-[14px] font-semibold mt-1.5 break-all max-w-[300px]">{user?.email || '—'}</p>
        </div>

        <div className="space-y-4">
          {/* New password */}
          <div className={`relative ${passwordErr ? 'animate-shake' : ''}`}>
            {pwStrong ? (
              <Glyph name="check" size={16} strokeWidth={3} className="absolute left-4 top-1/2 -translate-y-1/2 text-glyph-green animate-scale-in pointer-events-none z-[1]" />
            ) : (
              <Glyph name="lock" size={16} className="absolute left-4 top-1/2 -translate-y-1/2 text-white/50 pointer-events-none z-[1]" />
            )}
            <input id="recov-password" ref={passwordRef} type={showPassword ? 'text' : 'password'}
              autoComplete="new-password" autoFocus
              value={password}
              onChange={e => { setPassword(e.target.value); if (detour) setDetour(null); if (mismatch) setMismatch(false); }}
              placeholder=" " aria-invalid={passwordErr || undefined}
              aria-describedby={detour ? 'recov-error' : undefined}
              className={`${inputBase} pr-12 ${passwordErr ? inputBad : inputOk}`}
              onKeyDown={e => e.key === 'Enter' && confirmRef.current?.focus()} />
            <label htmlFor="recov-password" className="auth-float-label">{t('recov_label_new')}</label>
            <button type="button" tabIndex={-1} onClick={() => setShowPassword(!showPassword)}
              aria-label={showPassword ? t('auth_hide_password') : t('auth_show_password')}
              className="absolute right-3 top-1/2 -translate-y-1/2 w-8 h-8 flex items-center justify-center text-white/60 active:text-white">
              <Glyph name={showPassword ? 'eye-off' : 'eye'} size={16} />
            </button>
          </div>

          {/* Live policy checklist — the same three rules as sign-up. */}
          {pwStrong ? (
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
          )}

          {/* Confirm */}
          <div className={`relative ${confirmErr ? 'animate-shake' : ''}`}>
            {matches ? (
              <Glyph name="check" size={16} strokeWidth={3} className="absolute left-4 top-1/2 -translate-y-1/2 text-glyph-green animate-scale-in pointer-events-none z-[1]" />
            ) : (
              <Glyph name="lock" size={16} className="absolute left-4 top-1/2 -translate-y-1/2 text-white/50 pointer-events-none z-[1]" />
            )}
            <input id="recov-confirm" ref={confirmRef} type={showPassword ? 'text' : 'password'}
              autoComplete="new-password"
              value={confirm}
              onChange={e => { setConfirm(e.target.value); if (mismatch) setMismatch(false); }}
              placeholder=" " aria-invalid={confirmErr || undefined}
              aria-describedby={confirmErr ? 'recov-mismatch' : undefined}
              className={`${inputBase} pr-12 ${confirmErr ? inputBad : inputOk}`}
              onKeyDown={e => e.key === 'Enter' && handleSubmit()} />
            <label htmlFor="recov-confirm" className="auth-float-label">{t('recov_label_confirm')}</label>
          </div>
          {confirmErr && (
            <p id="recov-mismatch" role="alert" className="-mt-2 text-pay-text text-[12px] font-medium leading-relaxed">{t('recov_mismatch')}</p>
          )}
        </div>

        {/* Detour error — warm copy + a one-tap way forward, never a dead end. */}
        {detour && (
          <div id="recov-error" role="alert" className="mt-3 text-center animate-fade-in">
            <p className="text-pay-text text-[12.5px] font-medium leading-relaxed">{t(detour.msgKey)}</p>
            <button onClick={runDetour} disabled={saving}
              className="text-white text-[12.5px] font-semibold underline underline-offset-2 mt-1.5 min-h-[36px] disabled:opacity-50">
              {t(detour.actionKey)}
            </button>
          </div>
        )}

        <button onClick={handleSubmit} disabled={!canSubmit}
          className="m-btn m-btn-primary w-full mt-6 py-4 text-[15px]">
          {saving ? (
            <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
          ) : (
            <>
              {t('recov_cta')}
              <Glyph name="arrow-right" size={16} strokeWidth={2.8} />
            </>
          )}
        </button>

        <p className="text-white/60 text-[11.5px] text-center mt-6 pb-8">
          <button onClick={() => void signOut()} disabled={saving}
            className="text-white/70 underline underline-offset-2 min-h-[44px] disabled:opacity-50">
            {t('recov_not_you')}
          </button>
        </p>
      </div>
    </main>
  );
}
