import { useEffect, useRef } from 'react';
import { createBackQueue, isLayerState, withLayer } from '../lib/backStackLayer';

// One queue for every overlay in the app: a push waits while any overlay's
// closing history.back() is still in flight (see createBackQueue). Its
// popstate listener is registered here, at module load — before any overlay's
// own listener — so each pop is counted before the overlays see it.
const backQueue = createBackQueue(
  (fn, ms) => window.setTimeout(fn, ms),
  (handle) => window.clearTimeout(handle as number),
);
if (typeof window !== 'undefined') {
  window.addEventListener('popstate', () => backQueue.notePop());
}

/**
 * Makes a full-screen overlay (confirm sheet, global search, QR scanner)
 * closeable with the hardware/browser back button, without it falling
 * through to the route underneath (audit MF-08).
 *
 * While `open` is true, pushes a synthetic `history` entry tagged
 * `{ layer: layerName }` on top of whatever's already there. A back press
 * (hardware Android back, or a browser/PWA back gesture) fires `popstate`,
 * landing on the entry below ours — which does NOT carry our layer tag — so
 * we call `onClose()` instead of letting the router react to the
 * navigation. Because the pushed entry shares the current URL (only
 * `history.state` changes), popping it never changes `location.pathname`,
 * so React Router does not re-render routes for it.
 *
 * If the overlay closes by any OTHER means (backdrop tap, X button, Escape,
 * a programmatic close), the synthetic entry is still sitting in history —
 * cleanup consumes it with one `history.back()` so the stack doesn't grow by
 * one entry every open/close cycle (which would otherwise take two back
 * presses to leave the page after the sheet had been opened once).
 *
 * That back() is ASYNC, which used to break every same-tick hand-off
 * (2026-09-19): a route pushed while an overlay closed was undone when the
 * back() landed (search results and new groups bounced back), and an overlay
 * opened as another closed was shut by it (the "Remind does nothing" report).
 * So: cleanup only consumes our entry while it is still the current one, and
 * a new overlay waits for any in-flight back() before pushing (backQueue).
 *
 * Distinct from `uiStore`'s `modalStack` (src/stores/uiStore.ts), which is
 * an in-memory stack the Capacitor `backButton` listener pops directly
 * (src/lib/nativeBridge.ts) — that mechanism doesn't touch `history` at all,
 * so it does nothing for a browser/PWA back gesture. This hook covers both.
 */
export function useBackStackLayer(open: boolean, onClose: () => void, layerName = 'sheet'): void {
  // Ref updated post-render (not during it, which react-hooks/refs flags) so
  // the popstate handler below always calls the latest onClose without
  // needing it in the effect's dependency array.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    if (typeof window === 'undefined' || !open) return;

    let pushed = false;
    let closed = false;
    backQueue.whenIdle(() => {
      if (closed) return; // closed again before its turn came
      window.history.pushState(withLayer(window.history.state, layerName), '');
      pushed = true;
    });

    const onPopState = (event: PopStateEvent) => {
      // Not pushed yet: the pop belongs to another overlay's closing back().
      if (!pushed) return;
      // Landed back on an entry that still carries our tag (shouldn't
      // normally happen — defensive only): nothing to close yet.
      if (isLayerState(event.state, layerName)) return;
      pushed = false;
      onCloseRef.current();
    };

    window.addEventListener('popstate', onPopState);

    return () => {
      closed = true;
      window.removeEventListener('popstate', onPopState);
      if (!pushed) return;
      pushed = false;
      // Closed by something other than a back press — consume our entry, but
      // only while it is still the current one. If a route or another overlay
      // was pushed on top in the same tick, a back() here would undo THAT.
      // The entry left behind carries the same URL, so it is harmless: a
      // later back press simply lands on it.
      if (isLayerState(window.history.state, layerName)) {
        backQueue.noteBack();
        window.history.back();
      }
    };
  }, [open, layerName]);
}
