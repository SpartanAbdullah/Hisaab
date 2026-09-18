import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { Button } from './Button';
import { Glyph } from './Glyph';
import { useT } from '../lib/i18n';
import { useBackStackLayer } from '../hooks/useBackStackLayer';

// Imperative replacement for window.confirm() for destructive actions.
// Native confirm() does not render reliably inside iOS standalone PWA / Capacitor
// WebView and visually breaks the app's design language.
//
// Usage:
//   const ok = await confirmDestructive({
//     title: 'Delete this transaction?',
//     description: 'This will reverse the balance change. You can\'t undo this.',
//     confirmLabel: 'Delete',
//   });
//   if (!ok) return;

interface ConfirmOptions {
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: 'destructive' | 'warning';
}

interface ConfirmationActionsProps {
  confirmLabel: string;
  cancelLabel?: string;
  tone?: 'destructive' | 'warning';
  loading?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

export function ConfirmationActions({
  confirmLabel,
  cancelLabel,
  tone = 'destructive',
  loading = false,
  onCancel,
  onConfirm,
}: ConfirmationActionsProps) {
  const t = useT();
  // Default the cancel affordance to the localized "Cancel" label; callers can
  // still pass an explicit cancelLabel to override.
  const resolvedCancelLabel = cancelLabel ?? t('cancel');
  return (
    <div className="sheet-actions space-y-2">
      <Button type="button" variant="secondary" size="lg" onClick={onCancel} disabled={loading}>
        {resolvedCancelLabel}
      </Button>
      <Button
        type="button"
        variant={tone === 'destructive' ? 'danger' : 'warning'}
        size="lg"
        onClick={onConfirm}
        loading={loading}
      >
        {loading ? `${confirmLabel}...` : confirmLabel}
      </Button>
    </div>
  );
}

interface ConfirmState {
  open: boolean;
  options: ConfirmOptions | null;
  resolve: ((ok: boolean) => void) | null;
  ask: (opts: ConfirmOptions) => Promise<boolean>;
  answer: (ok: boolean) => void;
}

const useConfirmStore = create<ConfirmState>((set, get) => ({
  open: false,
  options: null,
  resolve: null,
  ask: (opts) =>
    new Promise<boolean>((resolve) => {
      set({ open: true, options: opts, resolve });
    }),
  answer: (ok) => {
    const r = get().resolve;
    set({ open: false, options: null, resolve: null });
    r?.(ok);
  },
}));

// Imperative API for the destructive sheet — must live next to the
// component it controls (shared store closure). Fast Refresh warning is
// noise here.
// eslint-disable-next-line react-refresh/only-export-components
export function confirmDestructive(opts: ConfirmOptions): Promise<boolean> {
  return useConfirmStore.getState().ask(opts);
}

export function ConfirmDestructiveSheet() {
  const open = useConfirmStore((s) => s.open);
  const options = useConfirmStore((s) => s.options);
  const answer = useConfirmStore((s) => s.answer);
  const [show, setShow] = useState(false);
  const t = useT();

  useEffect(() => {
    if (open) {
      requestAnimationFrame(() => setShow(true));
    } else {
      // Animation flag sync — legitimate setState-in-effect.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setShow(false);
    }
  }, [open]);

  // Audit MF-08: a back press with this sheet open used to fall through to
  // the route underneath. Treat back as Cancel.
  useBackStackLayer(open, () => answer(false), 'confirm-sheet');

  if (!open || !options) return null;

  const tone = options.tone ?? 'destructive';

  return (
    <div className="fixed inset-0 z-[70] flex items-end justify-center" role="presentation" onClick={() => answer(false)}>
      <div
        className="absolute inset-0 transition-opacity"
        style={{ background: 'var(--m-scrim)', backdropFilter: 'blur(6px)', WebkitBackdropFilter: 'blur(6px)' }}
      />
      <div
        className={`sheet-transient ${show ? 'is-open' : ''}`}
        role="presentation"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-6 pt-7 pb-5 text-center">
          {/* The 1d empty-state plate, tinted by what the action costs. */}
          <div className={`m-plate ${tone === 'destructive' ? 'm-coral' : 'm-gold'} mx-auto mb-4`} aria-hidden>
            <Glyph name="alert" tone={tone === 'destructive' ? 'coral' : 'gold'} size={24} extrude />
          </div>
          <p className="font-semibold text-[16px] text-ink-900 tracking-tight">{options.title}</p>
          {options.description && (
            <p className="text-[13px] text-ink-600 mt-2 leading-relaxed">{options.description}</p>
          )}
        </div>

        <ConfirmationActions
          confirmLabel={options.confirmLabel ?? t('confirm_generic')}
          cancelLabel={options.cancelLabel}
          tone={tone}
          onCancel={() => answer(false)}
          onConfirm={() => answer(true)}
        />
      </div>
    </div>
  );
}
