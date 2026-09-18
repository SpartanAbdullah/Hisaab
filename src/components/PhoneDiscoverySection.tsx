import { useEffect, useState } from 'react';
import { useToast } from './Toast';
import { Glyph } from './Glyph';
import { useT } from '../lib/i18n';
import { phoneDiscoveryDb, profilesDb } from '../lib/supabaseDb';
import { formatE164, toE164 } from '../lib/phoneIdentity';

interface Props {
  sectionClass: string;
  rowClass: string;
}

// "Let people who already have my number find me on Hisaab."
//
// The privacy-preserving alternative to scanning the device address book:
// Hisaab never reads contacts and never asks for READ_CONTACTS. Instead each
// user decides, once, whether their own number can be matched. Discovery then
// only ever fires on numbers the OTHER person already had saved themselves.
//
// Two independent facts, deliberately not collapsed into one toggle:
//   • whether a number is stored at all
//   • whether it may be matched
// Turning discovery off keeps the number (it's useful to have on file) but
// makes the user unfindable, which is what "off" has to mean to be honest.
export function PhoneDiscoverySection({ sectionClass, rowClass }: Props) {
  const t = useT();
  const toast = useToast();

  const [saved, setSaved] = useState<string | null>(null);
  const [discoverable, setDiscoverable] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  // Null means "the columns aren't there yet" — the migration hasn't been
  // applied. Hide the whole section rather than showing a control that
  // silently fails.
  const [available, setAvailable] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const profile = await profilesDb.getCurrent();
      if (cancelled) return;
      if (!profile || !('phone_e164' in profile)) {
        setAvailable(false);
        return;
      }
      setAvailable(true);
      const value = profile.phone_e164;
      setSaved(typeof value === 'string' && value ? value : null);
      setDiscoverable(profile.phone_discoverable === true);
    })().catch(() => { if (!cancelled) setAvailable(false); });
    return () => { cancelled = true; };
  }, []);

  // Live preview of what will actually be stored. Showing the normalised form
  // BEFORE saving is what stops "I entered my number but nobody finds me" —
  // if we couldn't parse it, the user sees that immediately.
  const previewed = editing ? toE164(draft) : null;
  const draftHasDigits = draft.replace(/[^\d]/g, '').length > 0;

  const save = async () => {
    const e164 = toE164(draft);
    if (!e164) return;
    setBusy(true);
    try {
      // A newly added number defaults to discoverable — the user is adding it
      // here, under copy that says exactly what it's for. They can flip the
      // toggle off immediately below.
      await phoneDiscoveryDb.setMyPhone(e164, saved ? discoverable : true);
      setSaved(e164);
      if (!saved) setDiscoverable(true);
      setEditing(false);
      toast.show({ type: 'success', title: t('disc_my_phone_saved') });
    } catch {
      toast.show({ type: 'error', title: t('err_could_not_save') });
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await phoneDiscoveryDb.setMyPhone(null, false);
      setSaved(null);
      setDiscoverable(false);
      setEditing(false);
      toast.show({ type: 'success', title: t('disc_my_phone_removed') });
    } catch {
      toast.show({ type: 'error', title: t('err_could_not_save') });
    } finally {
      setBusy(false);
    }
  };

  const toggleDiscoverable = async () => {
    if (!saved) return;
    const next = !discoverable;
    setBusy(true);
    try {
      await phoneDiscoveryDb.setMyPhone(saved, next);
      setDiscoverable(next);
    } catch {
      toast.show({ type: 'error', title: t('err_could_not_save') });
    } finally {
      setBusy(false);
    }
  };

  if (available !== true) return null;

  // 1d: the caller's settings card + row classes (SettingsPage owns the card
  // material); inside, the row wears the standard raised icon square, the
  // number edits in the sunken .input-field well, and discoverability is the
  // 48×28 material switch (role="switch").
  return (
    <div className={sectionClass}>
      {/* One child, so the card's hairline dividers never split the row from
          its own panel. */}
      <div>
        <div className={rowClass}>
          <div className="m-ctl w-9 h-9 flex items-center justify-center shrink-0" aria-hidden>
            <Glyph name="phone" tone="green" size={18} />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-[13.5px] font-semibold text-ink-900">{t('disc_my_phone_title')}</p>
            <p className="text-[11px] text-ink-600 mt-0.5 leading-relaxed">{t('disc_my_phone_desc')}</p>
          </div>
        </div>

        <div className="px-4 pb-4 pt-0.5 space-y-3">
          {editing ? (
            <>
              <div className="flex items-center gap-2">
                <input
                  autoFocus
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && previewed) { e.preventDefault(); void save(); }
                    if (e.key === 'Escape') setEditing(false);
                  }}
                  placeholder={t('disc_my_phone_placeholder')}
                  inputMode="tel"
                  className="input-field flex-1 min-w-0 py-2.5"
                />
                <button
                  type="button"
                  disabled={busy || !previewed}
                  onClick={() => void save()}
                  className="m-ctl w-10 h-10 shrink-0 flex items-center justify-center disabled:opacity-40"
                  aria-label={t('cat_save')}
                >
                  <Glyph name="check" tone="green" size={17} strokeWidth={2.8} />
                </button>
                <button
                  type="button"
                  onClick={() => setEditing(false)}
                  className="m-ctl w-10 h-10 shrink-0 flex items-center justify-center"
                  aria-label={t('cancel')}
                >
                  <Glyph name="close" size={16} className="text-ink-500" />
                </button>
              </div>
              {previewed ? (
                <p className="text-[11px] text-ink-600">
                  {t('disc_my_phone_confirm').replace('{number}', formatE164(previewed))}
                </p>
              ) : draftHasDigits ? (
                <p className="text-[11px] text-warn-700 leading-relaxed">{t('disc_my_phone_invalid')}</p>
              ) : null}
            </>
          ) : (
            <div className="flex items-center gap-3">
              <p className="flex-1 min-w-0 text-[13px] text-ink-900 tabular-nums truncate">
                {saved ? formatE164(saved) : (
                  <span className="text-ink-400">{t('disc_my_phone_none')}</span>
                )}
              </p>
              <button
                type="button"
                onClick={() => { setDraft(saved ?? ''); setEditing(true); }}
                className="shrink-0 min-h-[36px] text-[11.5px] font-semibold text-accent-600"
              >
                {saved ? t('contact_whatsapp_edit') : t('contact_whatsapp_add')}
              </button>
              {saved && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void remove()}
                  className="shrink-0 min-h-[36px] text-[11.5px] font-semibold text-pay-text disabled:opacity-50"
                >
                  {t('cat_remove')}
                </button>
              )}
            </div>
          )}

          {saved && !editing && (
            <div className="flex items-center gap-3 pt-3 border-t border-cream-hairline">
              <p className="flex-1 min-w-0 text-[12px] text-ink-800 leading-relaxed">
                {t('disc_my_phone_toggle')}
                {!discoverable && (
                  <span className="block text-[10.5px] text-ink-500 mt-0.5">
                    {t('disc_my_phone_hidden')}
                  </span>
                )}
              </p>
              <button
                type="button"
                role="switch"
                disabled={busy}
                onClick={() => void toggleDiscoverable()}
                aria-checked={discoverable}
                aria-label={t('disc_my_phone_toggle')}
                className="m-switch"
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
