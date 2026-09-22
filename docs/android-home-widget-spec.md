# Android home-screen widget — as built (2026-09-22)

Replaces the original W7 spec (cream card, balance at a glance, `hisaab://`
scheme). What shipped instead serves the daily-logging habit, shows no money,
and reuses the https deep links the launcher shortcuts already use.

## What it shows

About a 4x1 dark card (the app's hero base, `#0A0A14`), resizable:

- the Hisaab mark and name, then a one-line status for today:
  `Today: 3 entries · streak 12`, `Not closed yet · streak 12`,
  `Day closed ✓ · streak 12`, or the neutral `Tap to log today`
- **Add expense** opens QuickEntry on the amount step (`/?add=expense`, App.tsx)
- **Close today** opens the daily-close sheet (`/?close=today`, HomePage)
- tapping the header/status opens the app

**Privacy rule:** the widget is on the home screen for anyone to see. It shows
entry **counts** and the streak only, never amounts, balances, payees or names.
`widgetSnapshot.ts` has a test that pins the snapshot's fields.

Ledger-only (`splits_only`) mode has no daily close, so the status stays
neutral and the Close button is hidden. Add expense still works there.

## Files

| Side | File |
|---|---|
| Provider | `android/app/src/main/java/com/usehisaab/app/widget/QuickAddWidget.java` |
| JS bridge plugin | `android/.../widget/HisaabWidgetPlugin.java` (`HisaabWidget.refresh()`), registered in `MainActivity.onCreate` before `super` |
| Layout / info | `res/layout/widget_quick_add.xml`, `res/xml/widget_quick_add_info.xml` |
| Look | `res/drawable/widget_quick_add_bg.xml`, `widget_button_primary.xml`, `widget_button_secondary.xml`, `widget_*` colours in `res/values/colors.xml` |
| Manifest | `<receiver android:name=".widget.QuickAddWidget" exported="true">` with `APPWIDGET_UPDATE` |
| Snapshot builder (pure, tested) | `src/lib/widgetSnapshot.ts` + `.test.ts` |
| Bridge | `src/lib/widgetBridge.ts` |

## Data flow: JS to prefs to widget

1. `widgetBridge.installWidgetSync()` (called from `nativeBridge`) subscribes to
   the transaction, daily-close, app-mode and language stores. App resume also
   calls `scheduleWidgetRefresh()`. Writes are debounced (1.5 s) and skipped
   when the rendered result would not change.
2. It computes `dayActivity` + `computeCloseStreak` for the local day, builds the
   snapshot with every string **already localized in the in-app language**
   (the `widget_*` keys in `i18n.ts`, because Android's locale is not the app's
   language), and writes it with `@capacitor/preferences`. That is the
   SharedPreferences file `CapacitorStorage`, key `widget_snapshot` (the plugin's
   default group stores keys as-is).
3. It calls `HisaabWidget.refresh()`, which redraws every placed widget.
   `updatePeriodMillis` (30 min, the floor) is the backstop.
4. The provider reads the JSON. If its `day` is not the device's current date,
   it shows the snapshot's localized `neutral` text. With no snapshot at all, it
   uses the English resource fallbacks.

Sign-out (and account deletion, a blocked deleted account, or a session that
ends elsewhere) removes the snapshot and redraws the widget as neutral
(`supabaseAuthStore` teardown → `clearWidgetSnapshot`).

## Verify on device (founder)

- Long-press the home screen, open Widgets, find Hisaab, and place it. The
  preview and the placed card should look right, and the text should not be
  clipped at 1 row. If your launcher's rows are short, resize it to 2 rows.
- Log an expense. Within about 2 s the count goes up. Close the day and the
  widget shows `Day closed ✓`. Reopen the day and it goes back.
- Tap Add expense with the app killed, then again with it in the background.
  Both times QuickEntry should open on the amount step. Do the same for Close
  today, which should open the sheet.
- Switch the app language. The status and both buttons follow it.
- Switch to ledger-only mode. The status is neutral and the Close button is gone.
- Sign out. The widget goes neutral (English fallback).
- The next day, before opening the app, the widget shows the neutral prompt.
