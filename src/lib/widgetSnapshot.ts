// Android home-screen widget snapshot — pure builder (the bridge that writes
// it lives in widgetBridge.ts; the widget itself is
// android/app/src/main/java/com/usehisaab/app/widget/QuickAddWidget.java).
//
// PRIVACY RULE: the widget sits on the home screen, visible to anyone who
// glances at the phone. The snapshot carries entry COUNTS and the streak
// only — never an amount, a balance, a payee, a person's name or a note.
// Keep it that way: nothing here may take a Transaction's money fields.
//
// Every string is already localized in the user's in-app language (Android's
// locale is not the app's language), so the native side only binds text.
import type { I18nKey } from './i18n';

export const WIDGET_SNAPSHOT_KEY = 'widget_snapshot';

export interface WidgetSnapshot {
  /** Schema version, for the native reader. */
  v: 1;
  /** Local calendar day (YYYY-MM-DD) the status describes. The widget shows
   *  `neutral` instead of `status` once the device date moves past it. */
  day: string;
  status: string;
  /** Localized fallback for a stale snapshot (tomorrow, before the app runs). */
  neutral: string;
  addLabel: string;
  closeLabel: string;
  /** Ledger-only mode has no daily close — the native side hides the button. */
  showClose: boolean;
  updatedAt: number;
}

export interface WidgetSnapshotInput {
  ledgerOnly: boolean;
  /** How many rows were logged today (a count, never the rows). */
  entriesToday: number;
  closedToday: boolean;
  streak: number;
  day: string;
  nowMs: number;
}

export function buildWidgetSnapshot(input: WidgetSnapshotInput, t: (key: I18nKey) => string): WidgetSnapshot {
  const neutral = t('widget_neutral');
  const s = String(Math.max(0, Math.floor(input.streak)));
  let status: string;
  if (input.ledgerOnly) {
    status = neutral;
  } else if (input.closedToday) {
    status = t('widget_done').replace('{s}', s);
  } else if (input.entriesToday > 0) {
    status =
      input.entriesToday === 1
        ? t('widget_today_one').replace('{s}', s)
        : t('widget_today_entries').replace('{n}', String(input.entriesToday)).replace('{s}', s);
  } else {
    status = input.streak > 0 ? t('widget_open_streak').replace('{s}', s) : t('widget_open');
  }
  return {
    v: 1,
    day: input.day,
    status,
    neutral,
    addLabel: t('widget_add'),
    closeLabel: t('widget_close'),
    showClose: !input.ledgerOnly,
    updatedAt: input.nowMs,
  };
}

/** Everything but the timestamp — two snapshots that would render the same
 *  widget share a key, so the bridge can skip a redundant native write. */
export function snapshotRenderKey(snap: WidgetSnapshot): string {
  return JSON.stringify({ ...snap, updatedAt: 0 });
}
