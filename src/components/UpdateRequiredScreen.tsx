import { useT, useI18nStore } from '../lib/i18n';
import { Glyph } from './Glyph';
import { LanguageToggle } from './LanguageToggle';
import { isNativeRuntime } from '../lib/runtime';
import { recoverFromStaleApp } from '../lib/appRecovery';
import { PLAY_STORE_URL, updateMessageFor, type AppVersionConfig } from '../lib/versionGate';

// Terminal screen for the minimum-supported-version gate (audit H9 / MF-12).
//
// Rendered by src/App.tsx when app_config's floor is above this build. It is a
// dead end BY DESIGN — no dismiss, no "later", no navigation — because the
// premise for showing it is that this binary can no longer be trusted to talk
// to the schema without corrupting money records. The only recoveries are
// getting a newer build, or an operator lowering the floor in Supabase Studio
// (which this screen picks up on the next launch/resume).
//
// Mode-agnostic: nothing here reads appModeStore. The skew it defends against
// is binary-vs-schema, which is identical for full_tracker and splits_only.
//
// Statically imported into App.tsx on purpose (like PinLockScreen): a lazy
// chunk that fails to load — offline, or against the very stale deploy that
// triggered this gate — must never be the reason the gate silently doesn't render.
export function UpdateRequiredScreen({
  config,
  version,
}: {
  config: AppVersionConfig | null;
  version: string;
}) {
  const t = useT();
  const lang = useI18nStore((s) => s.lang);

  // Server copy wins when an operator wrote one for this incident; otherwise
  // the bundled translation. Derived on every render so the language toggle
  // below re-picks message_ur / message_en immediately.
  const serverMessage = updateMessageFor(config, lang);
  const native = isNativeRuntime();

  const onUpdate = () => {
    if (native) {
      // Capacitor opens non-app http(s) URLs externally; the Play Store app
      // has an intent filter for this URL, so it deep-links into the listing.
      window.location.href = PLAY_STORE_URL;
      return;
    }
    // Web/PWA: the newest bundle is already deployed — the running tab is just
    // holding a stale one. Clear the hisaab-* caches + SW and reload.
    void recoverFromStaleApp();
  };

  // 1d: the full-screen hero ground, a violet plate with the extruded arrow-up
  // glyph, and the brand-violet primary — the one action this dead end offers.
  return (
    <div className="auth-ink-dark min-h-dvh relative flex flex-col items-center justify-center bg-navy-bloom text-white px-8 text-center">
      <LanguageToggle className="absolute top-[max(20px,env(safe-area-inset-top))] right-5 z-50" />

      <div className="m-plate m-violet mb-6" aria-hidden>
        <Glyph name="arrow-up" tone="violet" size={26} extrude />
      </div>

      <h1 className="text-[24px] font-semibold tracking-[-0.02em] mb-3">{t('upd_required_title')}</h1>
      <p className="text-white/70 text-[13px] max-w-[300px] leading-relaxed">
        {serverMessage ?? t('upd_required_body')}
      </p>
      <p className="text-white/60 text-[12px] max-w-[290px] leading-relaxed mt-4">
        {t('upd_required_safe')}
      </p>

      <div className="w-full max-w-[300px] mt-8">
        <button
          onClick={onUpdate}
          className="m-btn m-btn-primary w-full py-4 text-[14px]"
        >
          {native ? t('upd_required_store') : t('upd_required_reload')}
        </button>
        {!native && (
          <p className="text-white/60 text-[11px] leading-relaxed mt-3">
            {t('upd_required_reload_hint')}
          </p>
        )}
      </div>

      {/* Version string so a support conversation can start with a fact rather
          than "the app says update". */}
      <p className="text-white/60 text-[11px] mt-8">
        {t('upd_required_version').replace('{version}', version)}
      </p>
    </div>
  );
}
