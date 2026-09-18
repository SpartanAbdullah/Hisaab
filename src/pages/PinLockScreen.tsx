import { useEffect, useState } from 'react';
import { Delete } from 'lucide-react';
import { useAuthStore } from '../stores/authStore';
import { Glyph } from '../components/Glyph';
import { useSupabaseAuthStore } from '../stores/supabaseAuthStore';
import { useT } from '../lib/i18n';
import { PIN_FREE_ATTEMPTS } from '../lib/pinCrypto';

// After this many wrong attempts the store imposes an escalating, PERSISTED
// lockout (30s, then doubling to a 15-minute cap — see lib/pinCrypto). We
// surface "{n} tries left" once the user has slipped at least once, counting
// down to this ceiling.
const MAX_ATTEMPTS = PIN_FREE_ATTEMPTS;

export function PinLockScreen() {
  const t = useT();
  const { verifyPin, lockedUntil, failedAttempts, removePin } = useAuthStore();
  const { signOut } = useSupabaseAuthStore();
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [shake, setShake] = useState(false);
  const [showForgot, setShowForgot] = useState(false);
  const [recovering, setRecovering] = useState(false);
  // PBKDF2 at 150k rounds takes ~100-300ms on a mid-range phone. Without this
  // guard a fast tapper can queue several verifications, each burning an
  // attempt against the (now persisted) lockout counter.
  const [checking, setChecking] = useState(false);
  // Tick `now` every second so the lock screen auto-releases when the
  // lockout window passes. Reading Date.now() in render directly would
  // violate React's purity rule and never refresh anyway.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (lockedUntil === null || lockedUntil <= now) return;
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, [lockedUntil, now]);

  const isTimeLocked = lockedUntil !== null && now < lockedUntil;
  const secondsLeft = isTimeLocked ? Math.ceil(((lockedUntil as number) - now) / 1000) : 0;
  // The escalating schedule reaches 15 minutes, and "Try again in 900s" reads
  // like a bug. Switch to m+s past a minute.
  const lockoutLabel = secondsLeft >= 60
    ? t('pin_try_again_long')
        .replace('{m}', String(Math.floor(secondsLeft / 60)))
        .replace('{s}', String(secondsLeft % 60))
    : t('pin_try_again').replace('{s}', String(secondsLeft));
  // Show "{n} tries left" only after the first wrong attempt and before the
  // hard lockout kicks in.
  const triesLeft = MAX_ATTEMPTS - failedAttempts;
  const showTriesLeft = !isTimeLocked && failedAttempts > 0 && triesLeft > 0;

  // Recovery: there's no PIN reset by design (the PIN guards a re-auth gate).
  // Signing out drops the local PIN guard and returns to the auth screen, where
  // the user re-authenticates; we also clear the local PIN so the next session
  // starts clean.
  const handleForgotPin = async () => {
    setRecovering(true);
    try {
      removePin();
      await signOut();
      window.location.reload();
    } catch {
      setRecovering(false);
    }
  };

  const handleDigit = (d: string) => {
    if (isTimeLocked || checking) return;
    const next = pin + d;
    setPin(next);
    setError('');
    if (next.length === 4) {
      setChecking(true);
      setTimeout(() => {
        void (async () => {
          try {
            const ok = await verifyPin(next);
            // On success the app shell swaps this screen out; nothing to do.
            if (!ok) {
              setPin('');
              setError(t('pin_wrong'));
              setShake(true);
              setTimeout(() => setShake(false), 500);
            }
          } finally {
            setChecking(false);
          }
        })();
      }, 100);
    }
  };

  const handleDelete = () => {
    if (checking) return;
    setPin(pin.slice(0, -1));
    setError('');
  };

  const dots = Array.from({ length: 4 }, (_, i) => i < pin.length);

  // 1d: the hero ground (dark in both themes — .auth-ink-dark flips the ink
  // ramp for the material inside), a violet plate with the lock glyph, sunken
  // wells that fill violet as digits land, and the handoff's pressable keypad
  // (two-step walls that collapse under the finger; coral delete key).
  return (
    <div className="auth-ink-dark min-h-dvh bg-navy-bloom flex flex-col items-center justify-center px-8">
      <div className="m-plate m-violet mb-6" aria-hidden>
        <Glyph name="lock" tone="violet" size={26} extrude />
      </div>

      <h1 className="text-[20px] font-semibold tracking-[-0.02em] text-white mb-1">{t('pin_title')}</h1>
      <p className="text-[13px] text-white/70 mb-8">{t('pin_subtitle')}</p>

      {/* PIN dots — sunken wells that fill with violet */}
      <div className={`flex gap-4 mb-8 ${shake ? 'animate-shake' : ''}`}>
        {dots.map((filled, i) => (
          <div
            key={i}
            className={`w-4 h-4 rounded-full transition-all duration-200 ${
              filled ? 'bg-gradient-to-b from-accent-500 to-accent-600 scale-110' : 'm-inset rounded-full'
            }`}
          />
        ))}
      </div>

      {/* Status — wrong PIN, live lockout countdown, or remaining tries. None
          is colour-only: each pairs the tint with explicit words. */}
      <div className="min-h-[40px] flex flex-col items-center justify-center mb-2">
        {error && !isTimeLocked && (
          <p className="text-pay-text text-[13px] font-semibold animate-fade-in">{error}</p>
        )}
        {isTimeLocked && (
          <>
            <p className="text-warn-700 text-[13px] font-semibold tabular-nums" aria-live="polite">
              {lockoutLabel}
            </p>
            <p className="text-white/60 text-[11px] font-medium mt-1">{t('pin_locked_note')}</p>
          </>
        )}
        {showTriesLeft && (
          <p className="text-warn-700 text-[12px] font-medium mt-1">
            {triesLeft === 1
              ? t('pin_tries_left_one')
              : t('pin_tries_left').replace('{n}', String(triesLeft))}
          </p>
        )}
      </div>

      {/* Numpad — the 1d keypad: 56px keys (>=44px touch target), 10px gap
          so the hard walls never touch. */}
      <div className="grid grid-cols-3 gap-2.5 w-full max-w-[260px]">
        {['1','2','3','4','5','6','7','8','9','','0','⌫'].map(key => (
          <button key={key} disabled={!key || isTimeLocked || checking}
            onClick={() => key === '⌫' ? handleDelete() : handleDigit(key)}
            aria-label={key === '⌫' ? t('qe_numpad_delete') : undefined}
            className={`h-14 min-h-[44px] flex items-center justify-center text-[22px] font-medium tabular-nums ${
              !key ? 'invisible' : `m-key disabled:opacity-40 ${key === '⌫' ? 'm-coral' : ''}`
            }`}>
            {key === '⌫' ? <Delete size={20} strokeWidth={2.4} aria-hidden /> : key}
          </button>
        ))}
      </div>

      {/* Forgot PIN — recovery is sign-out + re-auth, then the PIN is cleared. */}
      <button
        onClick={() => setShowForgot((v) => !v)}
        aria-expanded={showForgot}
        className="text-white/70 text-[12px] font-medium mt-6 min-h-[44px] px-4 active:text-white transition-colors"
      >
        {t('pin_forgot')}
      </button>
      {showForgot && (
        <div className="m-card w-full max-w-[300px] mt-1 p-4 text-center animate-fade-in">
          <p className="text-white/75 text-[12px] leading-relaxed">
            {t('pin_recovery')}
          </p>
          <button
            onClick={handleForgotPin}
            disabled={recovering}
            className="m-btn m-btn-primary mt-3.5 w-full py-3 text-[13px]"
          >
            {recovering ? t('pin_signing_out') : t('pin_signout_reset')}
          </button>
        </div>
      )}
    </div>
  );
}
