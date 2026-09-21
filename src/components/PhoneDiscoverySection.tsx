import { useEffect, useRef, useState } from 'react';
import { Glyph } from './Glyph';
import { useT } from '../lib/i18n';
import { formatE164, toE164 } from '../lib/phoneIdentity';
import type { MyPhone } from '../lib/myPhone';

// The account's own phone number, and whether people can find you by it.
//
// ONE number, ONE place to type it (founder 2026-09-19 — Settings used to
// have a dead device-only "Mobile Number" field in My Account AND this
// section's own input; see src/lib/myPhone.ts). The number lives in
// `profiles.phone_e164` and is edited only by <MyPhoneField> inside My
// Account. <PhoneDiscoverySection> keeps just the switch for that same number.
// SettingsPage owns the state and the writes, so the two can never disagree.
//
// Phone discovery is the privacy-preserving alternative to scanning the
// device address book: Hisaab never reads contacts and never asks for
// READ_CONTACTS. Each user decides whether their own number can be matched;
// discovery then only ever fires on numbers the OTHER person already had
// saved themselves.
//
// Two independent facts, deliberately not collapsed into one toggle:
//   • whether a number is stored at all          → My Account (this file's MyPhoneField)
//   • whether it may be matched                  → the switch (PhoneDiscoverySection)
// Turning discovery off keeps the number (it's useful to have on file) but
// makes the user unfindable, which is what "off" has to mean to be honest.
// A newly added number defaults to findable (discoverableForSave): the
// editor says so under the input before Save, and the switch is one tap away.
// A self-typed number proves nothing about ownership (audit SEC-09), so none
// of this ever shows a verified seal.

interface FieldProps {
  /** Undefined while the profile row loads. */
  phone: MyPhone | undefined;
  busy: boolean;
  editing: boolean;
  onEditingChange: (editing: boolean) => void;
  /** Starting text for "Add" when no number is saved (the legacy local field). */
  draftSeed: string;
  onSave: (e164: string) => void | Promise<void>;
  onRemove: () => void | Promise<void>;
}

/** The single "Mobile Number" field in Settings → My Account. */
export function MyPhoneField({ phone, busy, editing, onEditingChange, draftSeed, onSave, onRemove }: FieldProps) {
  const t = useT();

  if (editing && phone) {
    return (
      <div>
        <label htmlFor="settings-mobile" className="form-label">{t('settings_mobile')}</label>
        {/* Mounted per edit session, so every open starts from a fresh draft. */}
        <MyPhoneEditor
          initial={phone.e164 ?? draftSeed}
          firstNumber={!phone.e164}
          busy={busy}
          onSave={onSave}
          onCancel={() => onEditingChange(false)}
        />
      </div>
    );
  }

  // Same shape as the other My Account fields: a read-only well, with the
  // action on a plain button beside it (like the user-code Copy). While the
  // profile loads it holds its place, empty and inert.
  const number = phone?.e164 ?? null;
  const canEdit = phone !== undefined && !busy;
  return (
    <div>
      <label htmlFor="settings-mobile" className="form-label">{t('settings_mobile')}</label>
      <div className="flex gap-2">
        {/* Tapping the well edits too — it is the only place to type it. */}
        <input
          id="settings-mobile"
          type="tel"
          value={number ? formatE164(number) : ''}
          readOnly
          onClick={() => { if (canEdit) onEditingChange(true); }}
          placeholder={phone ? t('disc_my_phone_none') : ''}
          className="input-field flex-1 min-w-0 tabular-nums"
        />
        <button
          type="button"
          disabled={!canEdit}
          onClick={() => onEditingChange(true)}
          className="m-btn m-btn-plain shrink-0 px-4 text-[12px]"
        >
          <Glyph name={number ? 'edit' : 'plus'} size={14} className="text-ink-600" />
          {number ? t('contact_whatsapp_edit') : t('contact_whatsapp_add')}
        </button>
      </div>
      {phone?.e164 && (
        <div className="flex items-center gap-3 mt-1">
          <p className="flex-1 min-w-0 text-[10.5px] text-ink-600 leading-relaxed">
            {phone.discoverable ? t('setph_status_findable') : t('disc_my_phone_hidden')}
          </p>
          <button
            type="button"
            disabled={busy}
            onClick={() => void onRemove()}
            className="shrink-0 min-h-[32px] text-[11.5px] font-semibold text-pay-text disabled:opacity-50"
          >
            {t('cat_remove')}
          </button>
        </div>
      )}
    </div>
  );
}

interface EditorProps {
  initial: string;
  /** No number on file yet — saving this one switches discovery on. */
  firstNumber: boolean;
  busy: boolean;
  onSave: (e164: string) => void | Promise<void>;
  onCancel: () => void;
}

function MyPhoneEditor({ initial, firstNumber, busy, onSave, onCancel }: EditorProps) {
  const t = useT();
  const [draft, setDraft] = useState(initial);
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus on open (the user just asked to type). No scroll jump: opened in
  // place it is already on screen, and opened from the discovery card's "Add
  // number" SettingsPage smooth-scrolls it into view itself.
  useEffect(() => {
    inputRef.current?.focus({ preventScroll: true });
  }, []);

  // Live preview of what will actually be stored. Showing the normalised form
  // BEFORE saving is what stops "I entered my number but nobody finds me" —
  // if we couldn't parse it, the user sees that immediately.
  const previewed = toE164(draft);
  const draftHasDigits = draft.replace(/[^\d]/g, '').length > 0;

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <input
          ref={inputRef}
          id="settings-mobile"
          type="tel"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && previewed && !busy) { e.preventDefault(); void onSave(previewed); }
            if (e.key === 'Escape') onCancel();
          }}
          placeholder={t('disc_my_phone_placeholder')}
          inputMode="tel"
          autoComplete="tel"
          enterKeyHint="done"
          className="input-field flex-1 min-w-0 tabular-nums"
        />
        <button
          type="button"
          disabled={busy || !previewed}
          onClick={() => { if (previewed) void onSave(previewed); }}
          className="m-ctl w-10 h-10 shrink-0 flex items-center justify-center disabled:opacity-40"
          aria-label={t('cat_save')}
        >
          <Glyph name="check" tone="green" size={17} strokeWidth={2.8} />
        </button>
        <button
          type="button"
          onClick={onCancel}
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
      {firstNumber && (
        <p className="text-[10.5px] text-ink-600 leading-relaxed">{t('setph_add_note')}</p>
      )}
    </div>
  );
}

interface SectionProps {
  sectionClass: string;
  rowClass: string;
  /** Undefined while the profile row loads. */
  phone: MyPhone | undefined;
  busy: boolean;
  onToggle: (discoverable: boolean) => void | Promise<void>;
  /** Opens My Account on its number editor. */
  onAddNumber: () => void;
}

// "Let people who already have my number find me on Hisaab." Only the switch
// lives here — the number itself is My Account's.
//
// 1d: the caller's settings card + row classes (SettingsPage owns the card
// material); the row wears the standard raised icon square and the 48×28
// material switch (role="switch").
export function PhoneDiscoverySection({ sectionClass, rowClass, phone, busy, onToggle, onAddNumber }: SectionProps) {
  const t = useT();
  const number = phone?.e164 ?? null;

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
            <p className="text-[13.5px] font-semibold text-ink-900">{t('disc_my_phone_toggle')}</p>
            <p className="text-[11px] text-ink-600 mt-0.5 leading-relaxed">{t('disc_my_phone_desc')}</p>
          </div>
          {/* No number, no switch: "findable" means nothing without one. */}
          {phone && number && (
            <button
              type="button"
              role="switch"
              disabled={busy}
              onClick={() => void onToggle(!phone.discoverable)}
              aria-checked={phone.discoverable}
              aria-label={t('disc_my_phone_toggle')}
              className="m-switch"
            />
          )}
        </div>

        <div className="px-4 pb-4 pt-0.5">
          {!phone ? (
            // Holds the card's place while the profile loads, so nothing
            // below it jumps when the real line arrives.
            <div className="m-skel h-[11px] w-[62%] my-[5px]" aria-hidden="true" />
          ) : number ? (
            <p className="text-[11px] text-ink-600 leading-relaxed">
              <span className="tabular-nums">{t('setph_disc_uses').replace('{number}', formatE164(number))}</span>
              {!phone.discoverable && (
                <span className="block text-[10.5px] text-ink-500 mt-0.5">{t('disc_my_phone_hidden')}</span>
              )}
            </p>
          ) : (
            <div className="flex items-center gap-3">
              <p className="flex-1 min-w-0 text-[11px] text-ink-600 leading-relaxed">{t('setph_disc_need')}</p>
              <button
                type="button"
                onClick={onAddNumber}
                className="m-btn m-btn-plain shrink-0 px-3.5 py-2 text-[11.5px]"
              >
                <Glyph name="plus" size={13} className="text-ink-600" />
                {t('setph_disc_add_cta')}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
