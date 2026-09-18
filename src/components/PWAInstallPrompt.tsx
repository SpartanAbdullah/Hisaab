import { useEffect, useRef, useState } from 'react';
import { useT } from '../lib/i18n';
import { Glyph } from './Glyph';
import type { GlyphName } from '../lib/glyphs';
import { isStandaloneRuntime, shouldShowPwaInstallPrompts } from '../lib/runtime';
import { useToast } from './Toast';

const DISMISS_KEY = 'hisaab_pwa_dismissed';
const DISMISS_DAYS = 7;
const DISMISS_MS = DISMISS_DAYS * 24 * 60 * 60 * 1000;

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

type InstallMode = 'native' | 'ios' | 'android' | null;

function isDismissedRecently(): boolean {
  if (typeof window === 'undefined') return false;

  const dismissedAt = Number(window.localStorage.getItem(DISMISS_KEY) ?? 0);
  return Number.isFinite(dismissedAt) && Date.now() - dismissedAt < DISMISS_MS;
}

function getInstallPlatform(): 'ios' | 'android' | 'other' {
  if (typeof window === 'undefined') return 'other';

  const userAgent = window.navigator.userAgent.toLowerCase();
  const isDesktopIpad = userAgent.includes('macintosh') && window.navigator.maxTouchPoints > 1;

  if (/iphone|ipad|ipod/.test(userAgent) || isDesktopIpad) return 'ios';
  if (/android/.test(userAgent)) return 'android';
  return 'other';
}

export function PWAInstallPrompt() {
  const t = useT();
  const toast = useToast();
  const installSuccessShown = useRef(false);
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [dismissed, setDismissed] = useState(isDismissedRecently);
  const [installed, setInstalled] = useState(() => !shouldShowPwaInstallPrompts());
  const [showFallback, setShowFallback] = useState(false);
  const [showManualSteps, setShowManualSteps] = useState(false);

  useEffect(() => {
    if (!shouldShowPwaInstallPrompts()) {
      return;
    }

    const handleBeforeInstallPrompt = (event: Event) => {
      event.preventDefault();
      setDeferredPrompt(event as BeforeInstallPromptEvent);
    };

    const handleAppInstalled = () => {
      setInstalled(true);
      setDeferredPrompt(null);
      if (!installSuccessShown.current) {
        installSuccessShown.current = true;
        toast.show({
          type: 'success',
          title: t('pwa_install_success_title'),
          subtitle: t('pwa_install_success_subtitle'),
          duration: 4500,
        });
      }
    };

    const mediaQuery = window.matchMedia('(display-mode: standalone)');
    const legacyMediaQuery = mediaQuery as MediaQueryList & {
      addListener?: (listener: (event: MediaQueryListEvent) => void) => void;
      removeListener?: (listener: (event: MediaQueryListEvent) => void) => void;
    };
    const handleStandaloneChange = (event?: MediaQueryListEvent) => {
      if ((event?.matches ?? mediaQuery.matches) || isStandaloneRuntime()) {
        setInstalled(true);
        setDeferredPrompt(null);
      }
    };

    window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
    window.addEventListener('appinstalled', handleAppInstalled);

    if ('addEventListener' in mediaQuery) {
      mediaQuery.addEventListener('change', handleStandaloneChange);
    } else if (legacyMediaQuery.addListener) {
      legacyMediaQuery.addListener(handleStandaloneChange);
    }

    const fallbackTimer = window.setTimeout(() => setShowFallback(true), 1500);

    return () => {
      window.removeEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
      window.removeEventListener('appinstalled', handleAppInstalled);
      if ('removeEventListener' in mediaQuery) {
        mediaQuery.removeEventListener('change', handleStandaloneChange);
      } else if (legacyMediaQuery.removeListener) {
        legacyMediaQuery.removeListener(handleStandaloneChange);
      }
      window.clearTimeout(fallbackTimer);
    };
  }, [t, toast]);

  const installPlatform = getInstallPlatform();
  let installMode: InstallMode = null;

  if (!installed && !dismissed) {
    if (deferredPrompt) {
      installMode = 'native';
    } else if (showFallback && installPlatform === 'ios') {
      installMode = 'ios';
    } else if (showFallback && installPlatform === 'android') {
      installMode = 'android';
    }
  }

  const handleInstall = async () => {
    if (!deferredPrompt) {
      setShowManualSteps(true);
      return;
    }

    await deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    setDeferredPrompt(null);

    if (outcome === 'accepted') {
      setInstalled(true);
      if (!installSuccessShown.current) {
        installSuccessShown.current = true;
        toast.show({
          type: 'success',
          title: t('pwa_install_success_title'),
          subtitle: t('pwa_install_success_subtitle'),
          duration: 4500,
        });
      }
    } else {
      setDismissed(true);
      window.localStorage.setItem(DISMISS_KEY, String(Date.now()));
    }
  };

  const handleDismiss = () => {
    setDismissed(true);
    window.localStorage.setItem(DISMISS_KEY, String(Date.now()));
  };

  if (!installMode) return null;

  const promptGlyph: GlyphName = installMode === 'ios' ? 'share' : installMode === 'android' ? 'phone' : 'download';
  const subtitle =
    installMode === 'native'
      ? t('pwa_install_native_sub')
      : installMode === 'ios'
        ? t('pwa_install_ios_sub')
        : t('pwa_install_android_sub');
  const steps =
    installMode === 'ios'
      ? t('pwa_install_ios_steps')
      : installMode === 'android'
        ? t('pwa_install_android_steps')
        : '';

  // 1d: a violet-tinted feature card floating over the hero — the install ask is
  // an invitation, so it wears the primary accent: glyph on a raised square,
  // copy on the ink ramp, and a compact brand-violet primary.
  return (
    <div className="fixed top-4 left-4 right-4 z-[60] animate-fade-in max-w-[448px] mx-auto">
      <div className="m-card m-card-feature m-violet p-3.5 flex items-start gap-3">
        <div className="m-ctl w-10 h-10 rounded-[14px] flex items-center justify-center shrink-0 mt-0.5" aria-hidden>
          <Glyph name={promptGlyph} tone="violet" size={19} />
        </div>
        <div className="flex-1 min-w-0 pt-0.5">
          <p className="text-[13.5px] font-semibold tracking-tight text-ink-900">{t('pwa_install_title')}</p>
          <p className="text-[11px] text-ink-600 mt-0.5 leading-relaxed">{subtitle}</p>
          {steps && showManualSteps ? <p className="text-[11px] text-ink-700 mt-2 leading-relaxed">{steps}</p> : null}
        </div>
        <button
          onClick={handleInstall}
          className="m-btn m-btn-primary shrink-0 min-h-[36px] rounded-xl px-3.5 py-2 text-[12px]"
        >
          {installMode === 'native' ? t('pwa_install_cta') : t('pwa_install_show_steps')}
        </button>
        <button
          onClick={handleDismiss}
          aria-label={t('a11y_dismiss')}
          className="relative shrink-0 mt-2 text-ink-400 active:text-ink-800 transition-colors before:absolute before:-inset-3 before:content-['']"
        >
          <Glyph name="close" size={15} />
        </button>
      </div>
    </div>
  );
}
