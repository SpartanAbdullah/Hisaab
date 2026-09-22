import { create } from 'zustand';
import { dailyClosesDb } from '../lib/supabaseDb';
import { localIso } from '../lib/localDate';
import { shiftDay } from '../lib/loggingStreak';
import { reportError } from '../lib/errorReporter';
import type { DailyClose, DailyCloseKind } from '../lib/dailyClose';

// Closing (or reopening) a day resolves tonight's nudge — force a re-plan.
// Dynamic import avoids a static store↔scheduler cycle (the scheduler reads
// this store); a no-op on web.
function nudgeReminderSchedule(feature: string): void {
  void import('../lib/notificationScheduler')
    .then((m) => m.rescheduleNotifications({ force: true }))
    .catch((err) => {
      reportError(err, { feature: `${feature}.nudgeReminderSchedule` });
    });
}

// How far back the streak can see. A year of closes is ~365 tiny rows.
const HISTORY_DAYS = 400;

interface DailyCloseState {
  closes: DailyClose[];
  loaded: boolean;
  load: () => Promise<void>;
  /** Close today (local day). Online-only: throws on failure so the caller
   *  can show the save-failed copy — never a silent "saved later". */
  closeDay: (kind: DailyCloseKind, now?: Date) => Promise<void>;
  reopen: (dayIso: string) => Promise<void>;
  reset: () => void;
}

export const useDailyCloseStore = create<DailyCloseState>((set, get) => ({
  closes: [],
  loaded: false,

  load: async () => {
    try {
      const closes = await dailyClosesDb.listSince(shiftDay(localIso(new Date()), -HISTORY_DAYS));
      set({ closes, loaded: true });
    } catch (err) {
      reportError(err, { feature: 'dailyCloseStore.load' });
      set({ loaded: true });
    }
  },

  closeDay: async (kind, now = new Date()) => {
    const day = localIso(now);
    await dailyClosesDb.upsert(day, kind);
    set({ closes: [{ day, kind }, ...get().closes.filter((c) => c.day !== day)] });
    nudgeReminderSchedule('dailyCloseStore.closeDay');
  },

  reopen: async (dayIso) => {
    await dailyClosesDb.remove(dayIso);
    set({ closes: get().closes.filter((c) => c.day !== dayIso) });
    nudgeReminderSchedule('dailyCloseStore.reopen');
  },

  reset: () => set({ closes: [], loaded: false }),
}));
