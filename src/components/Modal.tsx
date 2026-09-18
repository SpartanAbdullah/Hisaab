import { Glyph } from './Glyph';
import { useEffect, useId, useRef, useState } from 'react';
import { useUIStore } from '../stores/uiStore';
import { useBackStackLayer } from '../hooks/useBackStackLayer';
import { useT } from '../lib/i18n';

interface Props {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  // Optional gate for dismissal (backdrop tap / X). Return false (or a Promise
  // resolving false) to KEEP the modal open — used to guard unsaved changes.
  confirmClose?: () => boolean | Promise<boolean>;
  // Overrides the dialog's accessible name for the rare caller whose visible
  // `title` text isn't a good standalone label (e.g. it's decorative or
  // duplicated elsewhere). Default: aria-labelledby -> the title <h2>.
  ariaLabel?: string;
}

// Elements a11y-relevant to the Tab order. Matches the common "focusable"
// census used by most focus-trap implementations (react-focus-lock, etc.):
// interactive elements that aren't disabled or explicitly untabbable.
const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'textarea:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

// ============================================================================
// Dialog a11y contract (audit 09-ui-quality.md finding #2 / MF-08 follow-up)
// ============================================================================
// role="dialog" + aria-modal="true" + aria-labelledby (the title <h2>, or the
// `ariaLabel` override) are set on the visible sheet — not the full-screen
// backdrop wrapper, which is decorative click-catcher only.
//
// THREE independent "close the topmost dialog" signals exist in this app,
// and this component participates in — or coexists with — all three without
// ever double-closing:
//
//   1. Capacitor hardware back (native only) — src/lib/nativeBridge.ts's
//      `backButton` listener calls `useUIStore.getState().closeTopModal()`,
//      which invokes the LAST handler pushed onto `uiStore.modalStack`
//      directly (in-memory stack pop). It never touches `window.history`.
//      Unchanged by this file — read-only per this task's scope.
//
//   2. Browser / PWA back (`useBackStackLayer`, this file, NEW) — covers the
//      desktop/web surface, which has no hardware back button. Each Modal
//      INSTANCE gets its own history layer tag (`modal-${titleId}`, `titleId`
//      from `useId()`) rather than a shared literal `'modal'`. This matters
//      because Modals nest (the scroll-lock effect above already accounts
//      for "a nested sheet closing, e.g. the WhatsApp reminder over the
//      Hisaab check") — `useBackStackLayer`'s popstate matching treats
//      "landed on an entry that still carries MY tag" as a no-op, so two
//      modals sharing one tag would swallow the back press instead of
//      closing the topmost one. Unique tags make each instance react only
//      to the popstate that actually removed ITS OWN pushed entry, which is
//      always the top-of-stack modal (LIFO), so no extra coordination with
//      `uiStore.modalStack` is needed for correctness here.
//
//   3. Escape key + the Tab focus trap (this file, NEW) — both are wired via
//      one `document` keydown listener per open Modal instance. Unlike (2),
//      these have no per-instance signal to key off, so EVERY open modal's
//      listener fires on every keypress; each one checks whether ITS OWN
//      `closeHandler` is the top entry of `uiStore.modalStack` (the SAME
//      stack (1) reads) before reacting, and no-ops otherwise. This reuses
//      the app's one existing definition of "topmost modal" instead of
//      inventing a second one, and keeps Escape/Tab consistent with hardware
//      back: whichever modal hardware-back would close is also the one
//      Escape closes and the one Tab is trapped inside.
//
// Net rule: a given close signal (hardware back / browser back / Escape)
// always closes exactly the topmost open Modal, and the three mechanisms
// cannot double-fire for the same key press or gesture because they listen
// to disjoint event sources (an in-memory stack pop; a popstate scoped by a
// unique per-instance history tag; a document keydown gated by that same
// in-memory stack's top entry).
//
// Focus restore: the element focused immediately before open is remembered
// and refocused on close (if still attached to the document).
//
// App-root inert/aria-hidden while open: NOT implemented. Modal renders
// in-place in the React tree (no portal) at ~40 different call sites, some
// nested deep inside a page's own component tree and some stacked with
// another open Modal. Marking the app root (`#root`) `inert`/aria-hidden
// would inert the Modal's own DOM too, since it is a descendant of #root —
// there is no single stable "everything except the modal" container to
// target without either portal-izing Modal (a structural rewrite, out of
// this item's scope per CLAUDE.md/task boundaries) or auditing all ~40
// call sites' surrounding DOM (unsafe to do blind). The focus trap below
// covers the keyboard-user case (Tab cannot reach the covered page); a
// screen-reader user swiping through the page with a virtual cursor could
// still reach background content. Flagged as a follow-up requiring a portal.
// ============================================================================

export function Modal({ open, onClose, title, children, footer, confirmClose, ariaLabel }: Props) {
  const t = useT();
  const [show, setShow] = useState(false);
  const { openModal, closeModal } = useUIStore();
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);

  const requestClose = async () => {
    if (confirmClose) {
      const ok = await confirmClose();
      if (!ok) return;
    }
    onClose();
  };

  // Register a STABLE close handler on the modal stack so the hardware back
  // button can dismiss this modal. The ref keeps it pointing at the latest
  // requestClose (which closes over the current confirmClose/onClose) without
  // changing identity, so push/pop stay balanced across re-renders.
  const requestCloseRef = useRef(requestClose);
  const closeHandlerRef = useRef(() => { void requestCloseRef.current(); });
  useEffect(() => {
    requestCloseRef.current = requestClose;
  });

  // Browser/PWA back button — see the dialog a11y contract above for how
  // this coexists with uiStore.modalStack (hardware back) and the Escape/Tab
  // handling below.
  useBackStackLayer(open, () => { void requestCloseRef.current(); }, `modal-${titleId}`);

  useEffect(() => {
    const closeHandler = closeHandlerRef.current;
    if (open) {
      document.body.style.overflow = 'hidden';
      openModal(closeHandler);
      requestAnimationFrame(() => setShow(true));
    } else {
      // Intentional: `show` is an animation flag synchronized with the
      // `open` prop. Deriving it via render-time computation would skip
      // the enter/exit transition, which is the whole point.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setShow(false);
      closeModal(closeHandler);
      // Release the body scroll lock only when NO modal remains open — a
      // nested sheet closing (e.g. the WhatsApp reminder over the Hisaab
      // check) must not unlock the page behind its still-open parent. The
      // count check also guards this branch's run on closed-sibling mounts.
      if (useUIStore.getState().modalCount === 0) {
        document.body.style.overflow = '';
      }
    }
    return () => {
      if (open) {
        closeModal(closeHandler);
        if (useUIStore.getState().modalCount === 0) {
          document.body.style.overflow = '';
        }
      }
    };
  }, [open, openModal, closeModal]);

  // Focus management: move focus into the dialog on open, trap Tab/Shift+Tab
  // inside it, restore focus to whatever had it before on close. Escape is
  // handled in the same listener (see the a11y contract above for the
  // "topmost modal only" rule shared with hardware back).
  useEffect(() => {
    if (!open) return;
    previouslyFocusedRef.current = document.activeElement as HTMLElement | null;

    const isTopmostModal = () => {
      const stack = useUIStore.getState().modalStack;
      return stack.length > 0 && stack[stack.length - 1] === closeHandlerRef.current;
    };

    const focusFirst = () => {
      const node = dialogRef.current;
      if (!node) return;
      // Don't steal focus from a modal opened on top of this one in the
      // same tick (defensive — openModal/closeModal ordering already makes
      // this unlikely, but focus is a global side effect worth guarding).
      if (!isTopmostModal()) return;
      const focusables = node.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
      if (focusables.length > 0) {
        focusables[0].focus();
      } else {
        node.focus();
      }
    };
    // rAF so the entering sheet has mounted before we probe it for focusable
    // children (matches the existing `show` transition's rAF timing above).
    const raf = requestAnimationFrame(focusFirst);

    const onKeyDown = (e: KeyboardEvent) => {
      // Only the topmost modal reacts — mirrors uiStore.modalStack's
      // "hardware back closes the top modal only" rule so Escape/Tab and
      // hardware back never disagree about which dialog is active.
      if (!isTopmostModal()) return;

      if (e.key === 'Escape') {
        e.stopPropagation();
        void requestCloseRef.current();
        return;
      }
      if (e.key !== 'Tab') return;

      const node = dialogRef.current;
      if (!node) return;
      const focusables = Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
        .filter((el) => el.offsetParent !== null); // skip hidden/collapsed elements
      if (focusables.length === 0) {
        e.preventDefault();
        node.focus();
        return;
      }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement;
      if (e.shiftKey) {
        if (active === first || !node.contains(active)) {
          e.preventDefault();
          last.focus();
        }
      } else if (active === last || !node.contains(active)) {
        e.preventDefault();
        first.focus();
      }
    };
    // Capture phase so Escape/Tab are trapped even if a child stops
    // propagation during the bubble phase (e.g. an input's own handler).
    document.addEventListener('keydown', onKeyDown, true);

    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener('keydown', onKeyDown, true);
      // Restore focus to whatever triggered the modal, if it's still on the
      // page (it may have been removed/re-rendered away while open).
      const prev = previouslyFocusedRef.current;
      if (prev && document.contains(prev)) {
        prev.focus();
      }
    };
  }, [open]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-center">
      {/* Decorative backdrop — the actual dismiss-on-outside-tap target. Kept
          as a sibling (not an ancestor) of the dialog sheet below, so the
          dialog needs no stopPropagation click-absorber of its own: a click
          inside the sheet never bubbles through this element in the first
          place. role="presentation" (not aria-hidden) because it still needs
          to receive pointer events — aria-hidden elements should generally be
          inert, and hiding a hit-target from a11y tooling while leaving it
          clickable is the narrower, more accurate signal here. */}
      <div
        className={`modal-backdrop ${show ? 'opacity-100' : 'opacity-0'}`}
        role="presentation"
        onClick={requestClose}
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={ariaLabel ? undefined : titleId}
        aria-label={ariaLabel}
        tabIndex={-1}
        className={`modal-sheet ${show ? 'translate-y-0' : 'translate-y-full'}`}
      >
        {/* Drag handle — Sukoon grabber: 38 × 4.5 ink-200 */}
        <div className="flex justify-center pt-3 pb-1 shrink-0">
          <div className="w-[38px] h-[4.5px] rounded-full bg-ink-300" />
        </div>
        {/* Header */}
        <div className="modal-header">
          <h2 id={titleId} className="font-semibold text-[16px] tracking-[-0.01em] text-ink-900 truncate flex-1 min-w-0 pr-3">{title}</h2>
          <button
            onClick={requestClose}
            className="nav-icon-button shrink-0 group"
            aria-label={t('a11y_close')}
          >
            <Glyph name="close" size={15} className="text-ink-600 group-hover:text-pay-text transition-colors" />
          </button>
        </div>
        {/* Scrollable content */}
        <div className="modal-body">{children}</div>
        {/* Pinned footer */}
        {footer && (
          <div className="modal-footer">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
