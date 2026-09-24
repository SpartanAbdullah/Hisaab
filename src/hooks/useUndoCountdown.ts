// Milliseconds of Undo left on a receiver-recorded settlement, re-rendering
// once a second while the window is open (the 2026-09-24 settlement model;
// the server enforces the same 10 minutes in undo_received_repayment).
//
// The clock is read only in the lazy initial state and the interval callback
// — never during render — and the interval runs only while there is time left.

import { useEffect, useState } from 'react';
import type { SettlementRequest } from '../db';
import { undoMsLeft } from '../lib/settlementStatus';

export function useUndoCountdown(request: SettlementRequest, myUserId: string): number {
  const [now, setNow] = useState(() => Date.now());
  const left = undoMsLeft(request, myUserId, now);
  const ticking = left > 0;

  useEffect(() => {
    if (!ticking) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [ticking]);

  return left;
}
