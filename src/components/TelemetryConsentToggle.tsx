import { useEffect, useState } from 'react';
import { useT } from '../lib/i18n';
import { Glyph } from './Glyph';
import {
  hasTelemetryConsent,
  isTelemetryConfigured,
  setTelemetryConsent,
  subscribeTelemetryConsent,
} from '../lib/telemetry';

// Settings card for the opt-in usage-stats toggle (audit 2026-09 report 10
// §5.2 rule 4). Self-contained on purpose: drop
//   <TelemetryConsentToggle />
// into the "Data & backup" or "About & legal" group in SettingsPage and it
// needs nothing else.
//
// Consent is DEVICE-level (localStorage), DEFAULT OFF. Report 10 left
// default-on-vs-off to counsel; this ships OFF, which is the safe default for
// PK/UAE users and cannot become wrong after legal review — only more generous.
//
// The disclosure below is not marketing copy: it is the user-facing statement
// of the schema in src/lib/telemetryEvents.ts, where "no free text, no amounts"
// is structurally enforced. Keep the two in sync.

export function TelemetryConsentToggle() {
  const t = useT();
  const configured = isTelemetryConfigured();
  const [granted, setGranted] = useState(() => hasTelemetryConsent());

  // Another surface (a future onboarding disclosure step) can flip consent too.
  useEffect(() => subscribeTelemetryConsent(setGranted), []);

  const toggle = () => {
    const next = !granted;
    setTelemetryConsent(next, 'settings');
    setGranted(next);
  };

  // 1d settings card: row header with the analytics glyph, the 48×28 material
  // switch (role="switch" — green when on), then the two disclosure lists in
  // sunken wells so they read as detail under the row, not as more rows.
  return (
    <div className="m-card overflow-hidden">
      <div className="flex items-center gap-3 px-4 py-3.5">
        <div className="m-ctl w-9 h-9 flex items-center justify-center shrink-0" aria-hidden>
          <Glyph name="analytics" tone="violet" size={18} />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-[13.5px] font-semibold text-ink-900">{t('tlm_consent_title')}</p>
          <p className="text-[11px] text-ink-600 mt-0.5">{t('tlm_consent_sub')}</p>
        </div>
        <button
          type="button"
          role="switch"
          onClick={toggle}
          disabled={!configured}
          aria-checked={granted}
          aria-label={t('tlm_consent_title')}
          className="m-switch"
        />
      </div>

      <div className="px-4 pb-4 space-y-3">
        <p className="text-[11.5px] text-ink-600 leading-relaxed">{t('tlm_consent_body')}</p>

        <div className="m-inset p-3 space-y-2">
          <p className="m-label">
            {t('tlm_consent_collected_title')}
          </p>
          {[t('tlm_consent_collected_1'), t('tlm_consent_collected_2'), t('tlm_consent_collected_3')].map((line) => (
            <div key={line} className="flex items-start gap-2">
              <Glyph name="check" tone="green" size={13} strokeWidth={3} className="mt-px" />
              <p className="text-[11px] text-ink-700 leading-snug">{line}</p>
            </div>
          ))}
        </div>

        <div className="m-inset p-3 space-y-2">
          <p className="m-label">
            {t('tlm_consent_never_title')}
          </p>
          {[t('tlm_consent_never_1'), t('tlm_consent_never_2'), t('tlm_consent_never_3')].map((line) => (
            <div key={line} className="flex items-start gap-2">
              <Glyph name="close" tone="coral" size={13} strokeWidth={3} className="mt-px" />
              <p className="text-[11px] text-ink-700 leading-snug">{line}</p>
            </div>
          ))}
        </div>

        <p className="text-[10.5px] text-ink-400 leading-relaxed">
          {configured ? t('tlm_consent_off_note') : t('tlm_consent_unavailable')}
        </p>
      </div>
    </div>
  );
}
