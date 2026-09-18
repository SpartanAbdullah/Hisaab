import { CloudOff } from 'lucide-react';
import { useOnlineStatus } from '../hooks/useOnlineStatus';
import { useT } from '../lib/i18n';

// Small pill that floats below the top safe-area when the device is
// offline. It reads `navigator.onLine` only and does not differentiate
// "captive portal" vs "true offline" vs "Supabase reachability." Hisaab is
// online-required for writes — there is no offline write queue (decision D5,
// 2026-09-04, docs/offline-story.md) — so this pill plus the `err_offline`
// copy on a failed save are the whole offline story: say so, block the save,
// let the user retry once reconnected.
//
// 1d: the coral-tinted material pill (tinted face, lit edge, hard wall) — it
// reads as "something's wrong" on the navy hero and on the sheet alike, in
// both themes. CloudOff is the no-glyph fallback, matched to the 3c stroke.
export function OfflineBanner() {
  const t = useT();
  const { online } = useOnlineStatus();
  if (online) return null;
  return (
    <div className="fixed top-0 left-1/2 -translate-x-1/2 z-50 pt-safe w-full max-w-[480px] flex justify-center pointer-events-none">
      <div
        role="status"
        className="m-pill m-pill-pay pointer-events-auto mt-1 min-h-[30px] px-3.5 py-1.5 text-[11px]"
      >
        <CloudOff size={12} strokeWidth={2.4} className="shrink-0" aria-hidden />
        <span>{t('offline_banner')}</span>
      </div>
    </div>
  );
}
