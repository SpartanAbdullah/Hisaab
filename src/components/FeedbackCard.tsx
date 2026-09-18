import { useEffect, useState } from 'react';
import { useT } from '../lib/i18n';
import { Glyph } from './Glyph';
import { buildWhatsAppUrl } from '../lib/whatsappReminder';
import { track } from '../lib/telemetry';

// Settings card that gives a confused-but-not-crashed user a way to speak
// (audit 2026-09 report 10, F3 — today the only channel is a support address
// buried on a public page, or the crash screen's mailto).
//
// Self-contained: drop <FeedbackCard /> into SettingsPage's "About & legal"
// group. Nothing else to wire.
//
// TODO(founder-contact): set VITE_FEEDBACK_WHATSAPP to the founder's number in
// international digits (e.g. 923001234567) in Vercel + the local .env before
// launch. Deliberately NOT hardcoded here — a personal number does not belong
// in the repo. With it unset, the WhatsApp button still works: wa.me opens the
// contact picker instead of a direct chat (see buildWhatsAppUrl).
const FEEDBACK_WHATSAPP = ((import.meta.env.VITE_FEEDBACK_WHATSAPP as string | undefined) ?? '').trim();
const FEEDBACK_EMAIL = ((import.meta.env.VITE_FEEDBACK_EMAIL as string | undefined) ?? '').trim()
  || 'support@usehisaab.com';

// The typed note is a scratchpad ONLY. There is no backend for in-app feedback
// yet, so it is persisted to this device and never transmitted — the copy says
// so plainly rather than pretending a message was delivered.
const DRAFT_KEY = 'hisaab_feedback_draft';

export function FeedbackCard() {
  const t = useT();
  // Lazy initialiser, not an effect: the draft is known before first paint, so
  // there is no reason to render empty and then re-render with the text.
  const [note, setNote] = useState(() => {
    try {
      return localStorage.getItem(DRAFT_KEY) ?? '';
    } catch {
      // Storage blocked — the field simply starts empty.
      return '';
    }
  });
  const [savedAt, setSavedAt] = useState(0);

  // Debounced local save so a half-written thought survives a navigation.
  useEffect(() => {
    const id = window.setTimeout(() => {
      try {
        if (note.trim()) {
          localStorage.setItem(DRAFT_KEY, note);
          setSavedAt(Date.now());
        } else {
          localStorage.removeItem(DRAFT_KEY);
        }
      } catch {
        // ignore
      }
    }, 600);
    return () => window.clearTimeout(id);
  }, [note]);

  // The draft rides along as the prefilled body so nothing has to be retyped.
  const body = note.trim() ? `${t('fbk_prefill')}\n\n${note.trim()}` : t('fbk_prefill');

  const openWhatsApp = () => {
    track('feedback_opened', { channel: 'whatsapp' });
    window.open(buildWhatsAppUrl(FEEDBACK_WHATSAPP || null, body), '_blank', 'noopener,noreferrer');
  };

  const openEmail = () => {
    track('feedback_opened', { channel: 'email' });
    const subject = encodeURIComponent(t('fbk_email_subject'));
    window.location.href = `mailto:${FEEDBACK_EMAIL}?subject=${subject}&body=${encodeURIComponent(body)}`;
  };

  // 1d settings card: the standard row header (36px raised square + toned
  // glyph), two key-material actions, and the sunken .input-field note well.
  return (
    <div className="m-card overflow-hidden">
      <div className="flex items-center gap-3 px-4 py-3.5">
        <div className="m-ctl w-9 h-9 flex items-center justify-center shrink-0" aria-hidden>
          <Glyph name="chat" tone="violet" size={18} />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-[13.5px] font-semibold text-ink-900">{t('fbk_title')}</p>
          <p className="text-[11px] text-ink-600 mt-0.5">{t('fbk_sub')}</p>
        </div>
      </div>

      <div className="px-4 pb-4 space-y-3.5">
        <div className="flex gap-2.5">
          <button
            onClick={openWhatsApp}
            className="m-btn m-btn-plain flex-1 px-3 py-2.5 text-[12.5px]"
          >
            <Glyph name="whatsapp" tone="green" size={16} />
            {t('fbk_whatsapp')}
          </button>
          <button
            onClick={openEmail}
            className="m-btn m-btn-plain flex-1 px-3 py-2.5 text-[12.5px]"
          >
            <Glyph name="mail" tone="blue" size={16} />
            {t('fbk_email')}
          </button>
        </div>

        <div>
          <label htmlFor="feedback-note" className="form-label">
            {t('fbk_note_label')}
          </label>
          <textarea
            id="feedback-note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={3}
            maxLength={1000}
            placeholder={t('fbk_note_ph')}
            className="input-field resize-none leading-relaxed"
          />
          <p className="text-[10.5px] text-ink-400 mt-1.5 leading-relaxed">
            {savedAt > 0 ? `${t('fbk_note_saved')} · ` : ''}
            {t('fbk_note_local_only')}
          </p>
        </div>
      </div>
    </div>
  );
}
