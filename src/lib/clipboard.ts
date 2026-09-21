// Copy (and share) text reliably — on the web AND inside the Android
// Capacitor WebView.
//
// WHY THIS EXISTS — "copy group invite link not working" (founder, 2026-09-19).
// GroupInviteModal minted the invite first (hydrate the group, SHA-256 the
// token, INSERT the row — two to four network round trips) and only THEN
// called navigator.clipboard.writeText. A clipboard write needs the tap's
// transient user activation: Safari drops it at the first await, and Chromium
// (Android's WebView included) lets it lapse a few seconds after the tap — a
// slow mobile round trip is enough. The write then rejects with
// NotAllowedError, and the two call sites handled that in the two worst ways:
// one reported "Could not create invite" although the invite had been created,
// the other swallowed the rejection (`.catch(() => {})`) and said nothing at
// all. Every group copy site also assumed `navigator.clipboard` exists, which
// it does not outside a secure context.
//
// The rules this module gives its callers:
//   1. When the text is already known, call copyText() INSIDE the tap handler,
//      before any await — the write starts while the activation is live.
//   2. Two paths, best first: the async Clipboard API, then the legacy hidden
//      textarea + execCommand('copy') (synchronous; the one old WebViews and
//      non-secure contexts still honour).
//   3. Never throws, never lies: it resolves true only when a path reported
//      success, so the caller can show an honest toast — and, when it is
//      false, offer shareText() (the OS share sheet, which has its own Copy
//      target on Android) or a visible link the user can select.
//
// Pure apart from the default dependency wiring; tests inject fakes.

import { isNativeRuntime } from './runtime';

export interface CopyDeps {
  /** navigator.clipboard.writeText, when the runtime has it. */
  writeText?: ((text: string) => Promise<void>) | null;
  /** The synchronous legacy path. Returns true when the browser reported success. */
  legacyCopy?: ((text: string) => boolean) | null;
  /** How long to wait for writeText before trying the legacy path anyway. A
   *  WebView that never settles the promise must not leave the user hanging. */
  timeoutMs?: number;
}

const DEFAULT_WRITE_TIMEOUT_MS = 1500;

/**
 * The legacy copy: select the text in an off-layout textarea and ask the
 * browser to copy the selection. Synchronous, so inside a tap it runs while the
 * user activation is guaranteed to be live.
 */
export function legacyCopyText(text: string): boolean {
  if (typeof document === 'undefined' || !document.body) return false;

  const textarea = document.createElement('textarea');
  textarea.value = text;
  // readonly: focusing it must not flash the soft keyboard on a phone.
  textarea.setAttribute('readonly', '');
  textarea.setAttribute('aria-hidden', 'true');
  textarea.setAttribute('tabindex', '-1');
  // Inside the viewport (top-left, 1px, invisible) rather than far off-screen:
  // iOS will not select text positioned outside it. 16px stops the iOS
  // focus-zoom.
  Object.assign(textarea.style, {
    position: 'fixed',
    top: '0',
    left: '0',
    width: '1px',
    height: '1px',
    padding: '0',
    border: '0',
    opacity: '0',
    pointerEvents: 'none',
    fontSize: '16px',
  });

  // Mount inside the open dialog when there is one, so a focus trap cannot
  // pull focus (and with it the selection) back out before the copy runs.
  const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const host = active?.closest('[role="dialog"]') ?? document.body;
  const selection = document.getSelection();
  const savedRange = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;

  host.appendChild(textarea);
  let copied = false;
  try {
    textarea.focus({ preventScroll: true });
    textarea.select();
    textarea.setSelectionRange(0, text.length);
    copied = document.execCommand('copy');
  } catch {
    copied = false;
  } finally {
    textarea.remove();
    if (selection && savedRange) {
      selection.removeAllRanges();
      selection.addRange(savedRange);
    }
    active?.focus({ preventScroll: true });
  }
  return copied;
}

function defaultCopyDeps(): CopyDeps {
  const clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
  return {
    writeText: clipboard && typeof clipboard.writeText === 'function'
      ? (text: string) => clipboard.writeText(text)
      : null,
    legacyCopy: legacyCopyText,
  };
}

function settlesWithin(promise: Promise<void>, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    promise.then(
      () => { clearTimeout(timer); resolve(true); },
      () => { clearTimeout(timer); resolve(false); },
    );
  });
}

/**
 * Copy `text` to the clipboard. Resolves true only when a path reported
 * success; never rejects. Call it before the first await of a tap handler
 * whenever the text is already in hand.
 */
export async function copyText(text: string, deps: CopyDeps = defaultCopyDeps()): Promise<boolean> {
  if (!text) return false;

  if (deps.writeText) {
    let pending: Promise<void> | null = null;
    try {
      // Called synchronously, so the write is issued inside the gesture.
      pending = deps.writeText(text);
    } catch {
      pending = null;
    }
    if (pending && await settlesWithin(pending, deps.timeoutMs ?? DEFAULT_WRITE_TIMEOUT_MS)) {
      return true;
    }
  }

  if (deps.legacyCopy) {
    try {
      return deps.legacyCopy(text);
    } catch {
      return false;
    }
  }
  return false;
}

// ── Share: the fallback that needs no clipboard at all ─────────────────────

export type ShareOutcome = 'shared' | 'cancelled' | 'unavailable' | 'failed';

export interface ShareInput {
  title?: string;
  text?: string;
  url?: string;
  /** Android chooser heading (native only). */
  dialogTitle?: string;
}

export interface ShareDeps {
  isNative: () => boolean;
  /** @capacitor/share — the OS share sheet. It needs no user activation, so it
   *  still works after the network round trip that broke the clipboard. */
  nativeShare?: ((input: ShareInput) => Promise<unknown>) | null;
  /** navigator.share — web only, and it DOES need a live user activation. */
  webShare?: ((input: ShareData) => Promise<void>) | null;
}

function defaultShareDeps(): ShareDeps {
  const nav = typeof navigator !== 'undefined' ? navigator : undefined;
  return {
    isNative: isNativeRuntime,
    nativeShare: async (input) => {
      const { Share } = await import('@capacitor/share');
      return Share.share(input);
    },
    webShare: nav && typeof nav.share === 'function' ? (data) => nav.share(data) : null,
  };
}

function isCancellation(err: unknown): boolean {
  if (err && typeof err === 'object' && (err as { name?: unknown }).name === 'AbortError') return true;
  const message = err instanceof Error ? err.message.toLowerCase() : String(err ?? '').toLowerCase();
  return /cancel|abort|dismiss/.test(message);
}

/** Open the platform share sheet for a link. Never rejects. */
export async function shareText(input: ShareInput, deps: ShareDeps = defaultShareDeps()): Promise<ShareOutcome> {
  try {
    if (deps.isNative() && deps.nativeShare) {
      await deps.nativeShare(input);
      return 'shared';
    }
    if (deps.webShare) {
      await deps.webShare({ title: input.title, text: input.text, url: input.url });
      return 'shared';
    }
    return 'unavailable';
  } catch (err) {
    return isCancellation(err) ? 'cancelled' : 'failed';
  }
}
