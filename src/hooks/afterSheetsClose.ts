/**
 * Run `next` once `count` closing sheets have given back their history entry.
 *
 * Every <Modal> pushes a history entry while it is open (useBackStackLayer —
 * the browser/PWA back gesture) and consumes it on close with an ASYNC
 * `history.back()`. Anything that pushes history in the SAME tick as a close
 * is undone when that back() lands: a sheet opened in the same tick closes
 * itself at once, and a route pushed in the same tick bounces back to where
 * the sheet was (reproduced in headless Chromium, 2026-09-19 — the "Remind
 * does nothing" report). So a hand-off that has to CLOSE a sheet first waits
 * for its pop; one that can leave the sheet open simply stacks the next sheet
 * on top (the reminder does that). useBackStackLayer now guards against both
 * failures itself (it never undoes a newer entry and holds new sheets until
 * in-flight backs land); this helper stays because waiting for the pop also
 * leaves no stale sheet entry behind in history.
 *
 * Shared by every sheet that leaves for a route: LoansPage's person sheet and
 * ContactDetailSheet (→ the person ledger).
 */
export function afterSheetsClose(count: number, next: () => void) {
  let seen = 0;
  let fallback = 0;
  const onPop = () => {
    seen += 1;
    if (seen >= count) finish();
  };
  const finish = () => {
    window.removeEventListener('popstate', onPop);
    window.clearTimeout(fallback);
    next();
  };
  window.addEventListener('popstate', onPop);
  // A sheet with no entry to give back sends no pop — never strand the tap.
  fallback = window.setTimeout(finish, 800);
}
