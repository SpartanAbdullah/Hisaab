import { useCallback, useEffect, useRef, useState, type FocusEvent, type KeyboardEvent, type MouseEvent } from 'react';
import { create } from 'zustand';
import { useReducedMotion } from '../hooks/useReducedMotion';
import { useT } from '../lib/i18n';
import { Glyph } from './Glyph';
import type { GlyphName, GlyphTone } from '../lib/glyphs';

type ToastType = 'success' | 'error' | 'info';

// An optional inline action — used mainly for "Undo" so reversible actions can
// happen instantly with a way back, instead of a blocking confirmation.
interface ToastAction {
  label: string;
  onPress: () => void;
}

interface ToastData {
  id: string;
  type: ToastType;
  title: string;
  subtitle?: string;
  duration?: number;
  action?: ToastAction;
}

interface ToastStore {
  toasts: ToastData[];
  show: (toast: Omit<ToastData, 'id'>) => void;
  dismiss: (id: string) => void;
}

/** On screen at once. Centred toasts stack out from the middle of the phone,
 *  so a fourth pushes the oldest out instead of climbing into the header. */
const MAX_TOASTS = 3;

/** The same words already showing (a double-tapped Save, a repeated offline
 *  error) replace the old toast instead of stacking a copy under it. Toasts
 *  with an action never merge: each Undo undoes its own thing. */
function sameMessage(a: Omit<ToastData, 'id'>, b: Omit<ToastData, 'id'>): boolean {
  return (
    !a.action &&
    !b.action &&
    a.type === b.type &&
    a.title === b.title &&
    (a.subtitle ?? '') === (b.subtitle ?? '')
  );
}

// Co-located store — the toast hook and the Toast renderer share this
// closure. Splitting them would force a circular-style import.
// eslint-disable-next-line react-refresh/only-export-components
export const useToast = create<ToastStore>((set) => ({
  toasts: [],
  show: (toast) => {
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2);
    set((s) => ({
      toasts: [...s.toasts.filter((x) => !sameMessage(x, toast)), { ...toast, id }].slice(-MAX_TOASTS),
    }));
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

// Lifetimes are unchanged from the top-anchored toast: 3s, or 6s when there is
// an action to reach (Undo). A caller's own `duration` still wins.
const LIFETIME_MS = 3000;
const LIFETIME_WITH_ACTION_MS = 6000;
const EXIT_MS = 300;
const EXIT_REDUCED_MS = 150;

// 1d toast (founder 2026-09-19: the old top-of-screen strip sat under the
// status bar and over the dark hero, and was hard to read on a phone). It is
// now a solid material card in the MIDDLE of the screen: the tinted `m-card`
// in the semantic tone — money-in green for success, coral (never red) for
// errors, blue for info — with an inset ring in the same tone so its edge
// holds against any page behind it in either theme, keyed by a raised square
// carrying the glyph, so the meaning never rests on colour alone. Title and
// subtitle stay on the ink ramp, which is AA on every tint face in both themes.
const TONES: Record<ToastType, { tint: string; ring: string; key: string; glyph: GlyphName; glyphTone: GlyphTone }> = {
  success: {
    tint: 'm-mint',
    ring: 'outline-receive-600/40',
    key: 'm-stat-dot m-stat-dot-receive',
    glyph: 'check',
    glyphTone: 'current',
  },
  error: {
    tint: 'm-coral',
    ring: 'outline-pay-600/45',
    key: 'm-stat-dot m-stat-dot-pay',
    glyph: 'alert',
    glyphTone: 'current',
  },
  info: {
    tint: 'm-blue',
    ring: 'outline-info-600/40',
    key: 'm-ctl inline-flex items-center justify-center shrink-0',
    glyph: 'info',
    glyphTone: 'blue',
  },
};

function ToastItem({ toast }: { toast: ToastData }) {
  const t = useT();
  const dismiss = useToast((s) => s.dismiss);
  const reduced = useReducedMotion();
  const [visible, setVisible] = useState(false);
  const [exiting, setExiting] = useState(false);
  // Focus inside the toast (keyboard, switch access, a screen reader that
  // moves focus) holds the auto-dismiss, so nobody loses the Undo while they
  // are on their way to it. The clock restarts in full once focus leaves.
  const [held, setHeld] = useState(false);
  // The auto-dismiss timer, a tap and the close button can all land in the
  // same moment; only the first starts the exit.
  const leaving = useRef(false);

  const handleDismiss = useCallback(() => {
    if (leaving.current) return;
    leaving.current = true;
    setExiting(true);
    window.setTimeout(() => dismiss(toast.id), reduced ? EXIT_REDUCED_MS : EXIT_MS);
  }, [dismiss, toast.id, reduced]);

  useEffect(() => {
    const frame = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(frame);
  }, []);

  const lifetime = toast.duration ?? (toast.action ? LIFETIME_WITH_ACTION_MS : LIFETIME_MS);
  useEffect(() => {
    if (held) return;
    const timer = window.setTimeout(handleDismiss, lifetime);
    return () => window.clearTimeout(timer);
  }, [handleDismiss, held, lifetime]);

  const onAction = (e: MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    toast.action?.onPress();
    handleDismiss();
  };
  const onClose = (e: MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    handleDismiss();
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Escape') return;
    // Only the toast closes; a sheet open underneath keeps its own Escape.
    e.stopPropagation();
    handleDismiss();
  };
  const onBlur = (e: FocusEvent<HTMLDivElement>) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setHeld(false);
  };

  const tone = TONES[toast.type];
  const shown = visible && !exiting;
  // A toast is a REPLY to something the user just did, so it arrives with a
  // small settle (the spring curve) rather than a linear glide. The overshoot
  // is entry-only — a bouncy exit reads as indecision. Reduced motion keeps
  // the state change and drops the movement: a short opacity fade, no scale.
  const motionClass = shown
    ? 'opacity-100 scale-100'
    : reduced
      ? 'opacity-0'
      : 'opacity-0 scale-95';

  return (
    // The whole card is the dismiss target (tap anywhere, founder request).
    // role="presentation": the wrapper only catches the tap; the live region
    // around it (ToastContainer) carries the announcement, and the close
    // button below is the keyboard / screen-reader path.
    <div
      role="presentation"
      onClick={handleDismiss}
      onKeyDown={onKeyDown}
      onFocus={() => setHeld(true)}
      onBlur={onBlur}
      className={`w-full max-w-[340px] rounded-[18px] cursor-pointer shadow-[0_22px_44px_-16px_var(--m-shadow)] transition-[opacity,scale] ${
        reduced ? 'duration-150' : 'duration-300'
      } ${motionClass} ${exiting ? 'pointer-events-none' : 'pointer-events-auto'}`}
      style={{
        transitionTimingFunction:
          reduced || exiting ? 'cubic-bezier(0.4, 0, 0.2, 1)' : 'cubic-bezier(0.34, 1.56, 0.64, 1)',
      }}
    >
      <div className={`m-card ${tone.tint} outline-2 -outline-offset-2 ${tone.ring} p-4 flex items-start gap-3`}>
        <span className={`${tone.key} w-8 h-8 rounded-[10px]`} aria-hidden>
          <Glyph name={tone.glyph} tone={tone.glyphTone} size={16} strokeWidth={3} />
        </span>
        <div className="flex-1 min-w-0 pt-1.5">
          <p className="text-[15px] font-semibold leading-snug tracking-[-0.01em] text-ink-900">{toast.title}</p>
          {toast.subtitle && (
            <p className="text-[12.5px] leading-relaxed text-ink-600 mt-1">{toast.subtitle}</p>
          )}
        </div>
        {toast.action && (
          <button
            type="button"
            onClick={onAction}
            className="m-pill relative shrink-0 self-center px-3 text-ink-900 text-[12.5px] font-bold"
          >
            <Glyph name="undo" size={13} strokeWidth={2.6} />
            {toast.action.label}
          </button>
        )}
        <button
          type="button"
          onClick={onClose}
          aria-label={t('a11y_dismiss')}
          className="relative shrink-0 mt-2 text-ink-400 active:text-ink-800 transition-colors before:absolute before:-inset-2.5 before:content-[''] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 rounded"
        >
          <Glyph name="close" size={15} />
        </button>
      </div>
    </div>
  );
}

// Centred on the screen, clear of the notch / status bar / gesture bar (safe
// areas) and above every sheet (z-100 vs 60–70). The layer spans the screen but
// takes no taps: only a toast itself is pointer-active, so the page underneath
// stays usable while one is showing.
//
// Two live regions that exist before any toast does — screen readers announce
// content ADDED to a live region far more reliably than a region that appears
// with its content already in it. Errors are assertive (role="alert"),
// everything else polite (role="status"). They are siblings, not nested, so an
// error is announced once. aria-atomic="false": a new toast reads alone, not
// the whole stack again.
export function ToastContainer() {
  const toasts = useToast((s) => s.toasts);
  const errors = toasts.filter((x) => x.type === 'error');
  const notices = toasts.filter((x) => x.type !== 'error');
  return (
    <div className="fixed inset-0 z-[100] pointer-events-none flex flex-col items-center justify-center pt-[max(16px,env(safe-area-inset-top))] pb-[max(16px,env(safe-area-inset-bottom))] pl-[max(16px,env(safe-area-inset-left))] pr-[max(16px,env(safe-area-inset-right))]">
      <div role="alert" aria-live="assertive" aria-atomic="false" className="w-full flex flex-col items-center gap-2.5">
        {errors.map((x) => (
          <ToastItem key={x.id} toast={x} />
        ))}
      </div>
      <div
        role="status"
        aria-live="polite"
        aria-atomic="false"
        className={`w-full flex flex-col items-center gap-2.5 ${errors.length > 0 && notices.length > 0 ? 'mt-2.5' : ''}`}
      >
        {notices.map((x) => (
          <ToastItem key={x.id} toast={x} />
        ))}
      </div>
    </div>
  );
}
