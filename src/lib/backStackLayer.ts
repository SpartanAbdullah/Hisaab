// Pure helpers for `useBackStackLayer` (src/hooks/useBackStackLayer.ts).
// Split out so the state-matching logic can be unit-tested without a DOM
// (vitest runs in Node — see vitest.config.ts header).
//
// Context (audit MF-08): ConfirmDestructiveSheet, GlobalSearch, and the QR
// scanner render as full-screen overlays that never register on the
// history/back stack, so a hardware or browser back press while one is open
// falls through to the page underneath instead of closing the overlay. The
// fix pushes a synthetic history entry tagged `{ layer: <name> }` while the
// overlay is open, and treats a `popstate` landing on an entry WITHOUT that
// tag as "the user pressed back — close this layer" instead of letting the
// router navigate.

export interface LayerState {
  layer?: string;
  [key: string]: unknown;
}

/** True when `state` is the history-entry marker for the named overlay layer. */
export function isLayerState(state: unknown, layerName: string): boolean {
  return Boolean(
    state &&
    typeof state === 'object' &&
    (state as LayerState).layer === layerName,
  );
}

/**
 * Builds the `history.state` object for a newly-pushed overlay-layer entry.
 * Preserves whatever was already there (e.g. React Router's own
 * `{ usr, key, idx }` shape) so popping back off this layer lands on a state
 * the rest of the app still recognises — we only ever ADD the `layer` tag,
 * never replace the entry outright.
 */
export function withLayer(currentState: unknown, layerName: string): LayerState {
  const base = currentState && typeof currentState === 'object'
    ? (currentState as Record<string, unknown>)
    : {};
  return { ...base, layer: layerName };
}

/**
 * Sequencing for overlay history entries (2026-09-19). Closing an overlay
 * consumes its entry with an ASYNC `history.back()`. An overlay that opens in
 * the same tick pushes its own entry first, and when that back() lands it
 * lands on the new overlay's entry — which reads as "back pressed" and closes
 * it at once (the "Remind does nothing" report). So a push waits while any
 * programmatic back() is still in flight.
 *
 * The queue only counts and defers; the hook owns the DOM. `notePop` runs for
 * EVERY popstate before the overlays' own listeners, and waiters run on the
 * NEXT tick so no overlay sees the very pop that released it.
 */
export interface BackQueue {
  /** A programmatic history.back() was just issued. */
  noteBack(): void;
  /** A popstate arrived, from any source. */
  notePop(): void;
  /** Run `fn` once no programmatic back() is in flight — now, if none is. */
  whenIdle(fn: () => void): void;
  /** How many programmatic backs are still in flight (for tests). */
  readonly inFlight: number;
}

export function createBackQueue(
  schedule: (fn: () => void, ms: number) => unknown,
  cancel: (handle: unknown) => void,
  // A back() that never produces a popstate (the page is going away, or there
  // was nothing to go back to) must not park every later overlay forever.
  safetyMs = 600,
): BackQueue {
  let inFlight = 0;
  let waiters: Array<() => void> = [];
  let safety: unknown = null;

  const release = () => {
    inFlight = 0;
    if (safety !== null) {
      cancel(safety);
      safety = null;
    }
    if (waiters.length === 0) return;
    const ready = waiters;
    waiters = [];
    schedule(() => ready.forEach((fn) => fn()), 0);
  };

  return {
    noteBack() {
      inFlight += 1;
      if (safety !== null) cancel(safety);
      safety = schedule(release, safetyMs);
    },
    notePop() {
      if (inFlight === 0) return;
      inFlight -= 1;
      if (inFlight === 0) release();
    },
    whenIdle(fn) {
      if (inFlight === 0) fn();
      else waiters.push(fn);
    },
    get inFlight() {
      return inFlight;
    },
  };
}
