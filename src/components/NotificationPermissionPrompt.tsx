import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Glyph } from './Glyph';
import { useT } from '../lib/i18n';
import { isNativeRuntime } from '../lib/runtime';
import { remindersEnabled, enableRemindersFlow } from '../lib/notificationScheduler';
import { requestPushPermissionAndRegister } from '../lib/pushRegistration';

// MF-06 (docs/audit-2026-09/07-mobile-first.md): the only way to turn on
// notification permission was a buried Settings toggle, so on Android 13+
// essentially no one ever grants it. This is a small, dismissible, contextual
// ask shown at a HIGH-INTENT moment instead — a place the user has just shown
// they care about being reminded, rather than at boot (where it would just
// train a reflex-deny).
//
// Native only: reminders/push are Capacitor-only, so this renders nothing on
// the web PWA. It reuses the same permission flow as the Settings toggle
// (`enableRemindersFlow` + `requestPushPermissionAndRegister`) rather than
// requesting permission itself, so both entry points stay in lockstep.
const DISMISS_KEY = 'hisaab_notif_prompt_dismissed_at';
const DISMISS_DAYS = 14;
const DISMISS_MS = DISMISS_DAYS * 24 * 60 * 60 * 1000;

function isDismissedRecently(): boolean {
  try {
    const dismissedAt = Number(localStorage.getItem(DISMISS_KEY) ?? 0);
    return Number.isFinite(dismissedAt) && dismissedAt > 0 && Date.now() - dismissedAt < DISMISS_MS;
  } catch {
    return false;
  }
}

interface Props {
  /** Bump this to a new value at the high-intent moment (e.g. a counter
   *  incremented each time). The prompt re-checks eligibility and reveals
   *  itself on every change after the initial mount value. */
  trigger: number;
}

export function NotificationPermissionPrompt({ trigger }: Props) {
  const t = useT();
  const navigate = useNavigate();
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (trigger === 0) return; // ignore the initial mount value — only react to real triggers
    if (!isNativeRuntime()) return;
    if (remindersEnabled()) return;
    if (isDismissedRecently()) return;
    setVisible(true);
  }, [trigger]);

  if (!visible) return null;

  const dismiss = () => {
    try {
      localStorage.setItem(DISMISS_KEY, String(Date.now()));
    } catch {
      /* storage off — worst case we ask again next time */
    }
    setVisible(false);
  };

  const handleAllow = async () => {
    setBusy(true);
    try {
      // Same OWNS-the-flag flow as the Settings reminders toggle: request
      // permission, persist it, reschedule. Android 13+ has one
      // POST_NOTIFICATIONS grant for the whole app, so once it's granted we
      // also register for push in the same breath — asking twice trains a
      // reflex-deny.
      const enabled = await enableRemindersFlow();
      if (enabled) {
        void requestPushPermissionAndRegister((to) => navigate(to));
      }
    } finally {
      setBusy(false);
      setVisible(false);
    }
  };

  // 1d: the hero material in miniature — a navy band (dark in both themes, so
  // it reads as a system moment over any sheet) with the bell glyph on a raised
  // square and the brand-violet primary for "Allow".
  return (
    <div className="fixed left-4 right-4 bottom-24 z-50 max-w-[448px] mx-auto animate-fade-in">
      <div className="m-hero m-hero-violet rounded-[22px] p-4 flex items-start gap-3 shadow-2xl ring-1 ring-white/10">
        <div className="m-ctl w-10 h-10 rounded-[14px] flex items-center justify-center shrink-0 mt-0.5" aria-hidden>
          <Glyph name="bell" tone="violet" size={19} />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-[13.5px] font-semibold tracking-tight text-white">{t('notif_prompt_title')}</p>
          <p className="text-[11.5px] text-white/70 mt-0.5 leading-relaxed">{t('notif_prompt_body')}</p>
          <div className="flex items-center gap-2 mt-3">
            <button
              onClick={() => void handleAllow()}
              disabled={busy}
              className="m-btn m-btn-primary px-4 py-2.5 text-[12.5px]"
            >
              {t('notif_prompt_allow')}
            </button>
            <button
              onClick={dismiss}
              disabled={busy}
              className="min-h-[44px] px-3 rounded-xl text-[12.5px] font-semibold text-white/70 active:text-white/90 disabled:opacity-60"
            >
              {t('notif_prompt_not_now')}
            </button>
          </div>
        </div>
        <button
          onClick={dismiss}
          aria-label={t('notif_prompt_not_now')}
          className="relative w-6 h-6 -m-1 flex items-center justify-center text-white/60 active:text-white/90 shrink-0 before:absolute before:-inset-2.5 before:content-['']"
        >
          <Glyph name="close" size={15} />
        </button>
      </div>
    </div>
  );
}
