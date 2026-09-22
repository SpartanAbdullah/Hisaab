import { useCallback, useEffect, useRef, useState } from 'react';

export type AsyncStatus = 'loading' | 'ready' | 'error';

export interface AsyncLoadResult {
  status: AsyncStatus;
  error: string | null;
  retry: () => void;
}

// Async-data hook with a friendly error message and a retry function.
//
// Pass a memoised loader (useCallback) or a stable module-level function —
// the effect re-runs whenever `load` changes identity. If the loader throws,
// `status` flips to 'error' and `error` holds a display-ready message.
//
// Cancels in-flight results on unmount so a late-returning request can't
// overwrite state on an unmounted or re-mounted component.
//
// `options.background` (read once, at mount): the caller already holds data
// worth showing, so the hook starts 'ready' and the FIRST run refreshes
// silently — no 'loading' flip, no skeleton (stale-while-revalidate; see
// src/lib/inboxFreshness.ts). A failure still surfaces as 'error', and an
// explicit retry() always shows 'loading' again.
export interface AsyncLoadOptions {
  background?: boolean;
}

export function useAsyncLoad(load: () => Promise<void>, options?: AsyncLoadOptions): AsyncLoadResult {
  const [status, setStatus] = useState<AsyncStatus>(options?.background ? 'ready' : 'loading');
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const silentFirstRun = useRef(!!options?.background);

  const run = useCallback(() => {
    const token = ++generation.current;
    if (silentFirstRun.current) {
      silentFirstRun.current = false;
    } else {
      setStatus('loading');
      setError(null);
    }
    void load()
      .then(() => {
        if (token !== generation.current) return;
        setStatus('ready');
      })
      .catch((err) => {
        if (token !== generation.current) return;
        console.error('[useAsyncLoad]', err);
        setError(friendlyMessage(err));
        setStatus('error');
      });
  }, [load]);

  useEffect(() => {
    // `run` issues setState internally as the async load progresses.
    // This is exactly the kind of "synchronize with external system"
    // case useEffect is designed for — the rule's false positive.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    run();
    return () => {
      generation.current += 1;
    };
  }, [run]);

  return { status, error, retry: run };
}

function friendlyMessage(err: unknown): string {
  if (err instanceof Error && err.message) {
    const raw = err.message;
    if (/network|failed to fetch|load failed/i.test(raw)) {
      return 'Network issue. Check your connection and try again.';
    }
    return raw;
  }
  return 'Something went wrong while loading. Try again in a moment.';
}
