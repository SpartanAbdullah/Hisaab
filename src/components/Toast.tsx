import { useEffect, useState, useCallback } from 'react';
import { create } from 'zustand';
import { useReducedMotion } from '../hooks/useReducedMotion';
import { useT } from '../lib/i18n';
import { Glyph } from './Glyph';
import type { GlyphName } from '../lib/glyphs';

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

// Co-located store — the toast hook and the Toast renderer share this
// closure. Splitting them would force a circular-style import.
// eslint-disable-next-line react-refresh/only-export-components
export const useToast = create<ToastStore>((set) => ({
  toasts: [],
  show: (toast) => {
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2);
    set((s) => ({ toasts: [...s.toasts, { ...toast, id }] }));
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

// 1d toast: a tinted material card (lit face + hard walls) in the semantic
// tone — money-in green for success, coral (never red) for errors, blue for
// info — keyed by a gradient stat-dot carrying the glyph, so the meaning never
// rests on colour alone. Title/subtitle stay on the ink ramp, which is AA on
// every tint face in both themes.
const TONES: Record<ToastType, { card: string; dot: string; glyph: GlyphName }> = {
  success: { card: 'm-mint', dot: 'm-stat-dot m-stat-dot-receive', glyph: 'check' },
  error: { card: 'm-coral', dot: 'm-stat-dot m-stat-dot-pay', glyph: 'alert' },
  info: { card: 'm-blue', dot: 'm-ctl w-[26px] h-[26px] rounded-[9px] inline-flex items-center justify-center shrink-0', glyph: 'info' },
};

function ToastItem({ toast }: { toast: ToastData }) {
  const t = useT();
  const { dismiss } = useToast();
  const [visible, setVisible] = useState(false);
  const [exiting, setExiting] = useState(false);

  const handleDismiss = useCallback(() => {
    setExiting(true);
    setTimeout(() => dismiss(toast.id), 300);
  }, [dismiss, toast.id]);

  useEffect(() => {
    requestAnimationFrame(() => setVisible(true));
    // Give people longer to react when there's an action to take (e.g. Undo).
    const timer = setTimeout(handleDismiss, toast.duration ?? (toast.action ? 6000 : 3000));
    return () => clearTimeout(timer);
  }, [handleDismiss, toast.duration, toast.action]);

  const tone = TONES[toast.type];
  const reduced = useReducedMotion();

  return (
    <div
      className={`m-card ${tone.card} px-3.5 py-3 flex items-start gap-3 transition-all duration-300 ${
        visible && !exiting ? 'translate-y-0 opacity-100 scale-100' : '-translate-y-3 opacity-0 scale-95'
      }`}
      style={{
        // A toast is a REPLY to something the user just did, so it should
        // arrive with a small settle rather than glide in linearly. The
        // overshoot is entry-only — a bouncy exit reads as indecision, and
        // reduced motion drops straight to the calm curve.
        transitionTimingFunction:
          reduced || exiting
            ? 'cubic-bezier(0.4, 0, 0.2, 1)'
            : 'cubic-bezier(0.34, 1.56, 0.64, 1)',
      }}
    >
      <span className={tone.dot} aria-hidden>
        <Glyph
          name={tone.glyph}
          size={14}
          strokeWidth={3}
          className={toast.type === 'info' ? 'text-glyph-blue' : undefined}
        />
      </span>
      <div className="flex-1 min-w-0 pt-[3px]">
        <p className="text-[13px] font-semibold tracking-tight text-ink-900">{toast.title}</p>
        {toast.subtitle && <p className="text-[11.5px] text-ink-600 mt-0.5 leading-relaxed">{toast.subtitle}</p>}
      </div>
      {toast.action && (
        <button
          onClick={() => {
            toast.action?.onPress();
            handleDismiss();
          }}
          className="m-pill relative shrink-0 -my-0.5 px-3 text-ink-900 text-[12px] font-bold"
        >
          <Glyph name="undo" size={13} strokeWidth={2.6} />
          {toast.action.label}
        </button>
      )}
      <button
        onClick={handleDismiss}
        aria-label={t('a11y_dismiss')}
        className="relative shrink-0 mt-[5px] text-ink-400 active:text-ink-800 transition-colors before:absolute before:-inset-2.5 before:content-[''] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 rounded"
      >
        <Glyph name="close" size={14} />
      </button>
    </div>
  );
}

export function ToastContainer() {
  const { toasts } = useToast();
  return (
    <div className="fixed top-4 left-1/2 -translate-x-1/2 w-full max-w-[440px] px-4 z-[100] flex flex-col gap-2 pointer-events-none">
      {toasts.map((t) => (
        <div key={t.id} className="pointer-events-auto">
          <ToastItem toast={t} />
        </div>
      ))}
    </div>
  );
}
