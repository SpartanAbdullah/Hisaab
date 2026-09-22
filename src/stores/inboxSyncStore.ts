import { create } from 'zustand';
import { planInboxLoad, type InboxLoadPlan } from '../lib/inboxFreshness';

// When the Inbox last finished a full load, for the stale-while-revalidate
// plan in src/lib/inboxFreshness.ts. A store (not a module variable) so the
// sign-out registry in resetAllStores.ts clears it with everything else —
// the next account on this device must start 'cold', never trust a stamp
// that described the previous user's (now wiped) stores.
interface InboxSyncState {
  lastLoadedAt: number | null;
  markLoaded: (at?: number) => void;
  /** The plan for an Inbox mount happening right now. */
  planNow: () => InboxLoadPlan;
  reset: () => void;
}

export const useInboxSyncStore = create<InboxSyncState>((set, get) => ({
  lastLoadedAt: null,
  markLoaded: (at = Date.now()) => set({ lastLoadedAt: at }),
  planNow: () => planInboxLoad(get().lastLoadedAt, Date.now()),
  reset: () => set({ lastLoadedAt: null }),
}));
