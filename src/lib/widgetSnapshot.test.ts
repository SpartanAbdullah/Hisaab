import { afterEach, describe, expect, it } from 'vitest';
import { buildWidgetSnapshot, snapshotRenderKey, type WidgetSnapshotInput } from './widgetSnapshot';
import { tStatic, useI18nStore } from './i18n';

const base: WidgetSnapshotInput = {
  ledgerOnly: false,
  entriesToday: 0,
  closedToday: false,
  streak: 0,
  day: '2026-09-22',
  nowMs: 1_000,
};

describe('buildWidgetSnapshot', () => {
  afterEach(() => useI18nStore.setState({ lang: 'en' }));

  it('counts today’s entries with the streak', () => {
    const snap = buildWidgetSnapshot({ ...base, entriesToday: 3, streak: 12 }, tStatic);
    expect(snap.status).toBe('Today: 3 entries · streak 12');
    expect(snap.showClose).toBe(true);
    expect(snap.day).toBe('2026-09-22');
  });

  it('uses the singular for one entry', () => {
    expect(buildWidgetSnapshot({ ...base, entriesToday: 1, streak: 4 }, tStatic).status).toBe('Today: 1 entry · streak 4');
  });

  it('says the day is closed, even when entries exist', () => {
    const snap = buildWidgetSnapshot({ ...base, entriesToday: 2, closedToday: true, streak: 5 }, tStatic);
    expect(snap.status).toBe('Day closed ✓ · streak 5');
  });

  it('shows not-closed-yet, with the streak only when there is one', () => {
    expect(buildWidgetSnapshot({ ...base, streak: 7 }, tStatic).status).toBe('Not closed yet · streak 7');
    expect(buildWidgetSnapshot(base, tStatic).status).toBe('Not closed yet');
  });

  it('is neutral in ledger-only mode and hides the close button', () => {
    const snap = buildWidgetSnapshot({ ...base, ledgerOnly: true, entriesToday: 4, streak: 9 }, tStatic);
    expect(snap.status).toBe('Tap to log today');
    expect(snap.showClose).toBe(false);
    expect(snap.addLabel).toBe('Add expense');
  });

  it('follows the in-app language, not the device', () => {
    useI18nStore.setState({ lang: 'ur' });
    const snap = buildWidgetSnapshot({ ...base, entriesToday: 3, streak: 12 }, tStatic);
    expect(snap.status).toBe('Aaj: 3 entries · streak 12');
    expect(snap.addLabel).toBe('Kharcha likhein');
    expect(snap.closeLabel).toBe('Din band karein');
    expect(snap.neutral).toBe('Tap karke aaj ka hisaab likhein');
  });

  it('never carries anything but counts, the streak and copy', () => {
    const snap = buildWidgetSnapshot({ ...base, entriesToday: 2, streak: 3 }, tStatic);
    expect(Object.keys(snap).sort()).toEqual(
      ['addLabel', 'closeLabel', 'day', 'neutral', 'showClose', 'status', 'updatedAt', 'v'].sort(),
    );
  });

  it('render key ignores the timestamp only', () => {
    const a = buildWidgetSnapshot({ ...base, nowMs: 1 }, tStatic);
    const b = buildWidgetSnapshot({ ...base, nowMs: 2 }, tStatic);
    const c = buildWidgetSnapshot({ ...base, nowMs: 2, entriesToday: 1 }, tStatic);
    expect(snapshotRenderKey(a)).toBe(snapshotRenderKey(b));
    expect(snapshotRenderKey(a)).not.toBe(snapshotRenderKey(c));
  });
});
