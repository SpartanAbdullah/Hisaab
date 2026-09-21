import { useId, useMemo, useState } from 'react';
import { Modal } from './Modal';
import { Glyph } from './Glyph';
import { useToast } from './Toast';
import { formatMoney } from '../lib/constants';
import { useT } from '../lib/i18n';
import { isNativeRuntime } from '../lib/runtime';
import { usePersonStore } from '../stores/personStore';
import {
  buildPaymentReminderMessage,
  getReminderAge,
  type PaymentReminderDirection,
  type PaymentReminderTone,
  type ReminderAge,
  type ReminderTemplateMap,
} from '../lib/paymentReminders';
import { buildWhatsAppUrl, hasWhatsAppNumber } from '../lib/whatsappReminder';
import type { Currency } from '../db';

interface Props {
  open: boolean;
  onClose: () => void;
  personName: string;
  amount: number;
  currency: Currency;
  direction: PaymentReminderDirection;
  startedAt?: string | null;
  // When false, the loan has no EMI/due date, so we never label it "overdue" —
  // a neutral "open for N days" is shown instead. Defaults to true to preserve
  // existing call-site behaviour.
  hasDueDate?: boolean;
  // The contact's phone, when we have it on file. Lets the WhatsApp button open
  // their chat directly; when absent we fall back to WhatsApp's contact picker.
  // The recipient does NOT need to be a Hisaab user.
  phone?: string | null;
  // The contact the reminder is about. When WhatsApp has no number it can
  // dial, the sheet offers to save one on that contact right here. A
  // name-only person has no contact to keep it on — they get the share sheet.
  personId?: string | null;
}

type ShareOutcome = 'shared' | 'cancelled' | 'unavailable';

// Whether this runtime has an OS share sheet for plain text. Android's WebView
// has no navigator.share, so inside the app it is the @capacitor/share plugin
// — the same one the statement PDF already reaches WhatsApp through on
// Android (src/lib/shareStatement.ts). Browsers use the Web Share API.
function canShareText(): boolean {
  return isNativeRuntime() || (typeof navigator !== 'undefined' && typeof navigator.share === 'function');
}

function isShareCancel(err: unknown): boolean {
  if (err instanceof DOMException && err.name === 'AbortError') return true;
  // The Capacitor plugin rejects with "Share canceled" when dismissed.
  const message = err instanceof Error ? err.message.toLowerCase() : '';
  return message.includes('cancel') || message.includes('abort') || message.includes('dismiss');
}

async function shareReminderText(text: string, title: string): Promise<ShareOutcome> {
  if (isNativeRuntime()) {
    try {
      const { Share } = await import('@capacitor/share');
      await Share.share({ text, dialogTitle: title });
      return 'shared';
    } catch (err) {
      if (isShareCancel(err)) return 'cancelled';
      // Plugin missing or refused — fall through to what the page itself has.
    }
  }
  if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
    try {
      await navigator.share({ text });
      return 'shared';
    } catch (err) {
      if (isShareCancel(err)) return 'cancelled';
      throw err;
    }
  }
  return 'unavailable';
}

function copyWithFallback(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text).catch(() => copyWithTextareaFallback(text));
  }

  return copyWithTextareaFallback(text);
}

function copyWithTextareaFallback(text: string): Promise<void> {
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', 'true');
  textarea.style.position = 'fixed';
  textarea.style.left = '-9999px';
  document.body.appendChild(textarea);
  textarea.select();

  try {
    document.execCommand('copy');
    return Promise.resolve();
  } catch (error) {
    return Promise.reject(error);
  } finally {
    document.body.removeChild(textarea);
  }
}

function formatDuration(age: ReminderAge, t: ReturnType<typeof useT>) {
  if (age.days === null) return t('reminder_duration_fallback');
  if (age.days === 0) return t('reminder_duration_today');
  if (age.days === 1) return t('reminder_duration_yesterday');
  if (age.days < 30) return t('reminder_duration_days').replace('{count}', String(age.days));

  const months = Math.max(1, Math.floor(age.days / 30));
  if (months === 1) return t('reminder_duration_month');
  return t('reminder_duration_months').replace('{count}', String(months));
}

function formatMeta(age: ReminderAge, t: ReturnType<typeof useT>, hasDueDate: boolean) {
  if (age.days === null) return t('reminder_no_due_date');
  if (age.days === 0) return t('reminder_open_today');
  if (age.days === 1) return t('reminder_open_days').replace('{count}', '1');
  // Only call it "overdue" when there's an actual due date to be overdue
  // against. Open-ended loans stay neutral: "open for N days".
  if (hasDueDate && age.isOverdue) return t('reminder_overdue_days').replace('{count}', String(age.days));
  return t('reminder_open_days').replace('{count}', String(age.days));
}

export function PaymentReminderModal({ open, onClose, personName, amount, currency, direction, startedAt, hasDueDate = true, phone = null, personId = null }: Props) {
  const t = useT();
  const toast = useToast();
  const updatePhone = usePersonStore((s) => s.updatePhone);
  // The contact's number as the store holds it NOW, so a number saved from
  // this sheet re-targets the WhatsApp button without reopening it.
  const contactPhone = usePersonStore((s) =>
    personId ? s.persons.find((p) => p.id === personId)?.phone ?? null : null,
  );
  const [tone, setTone] = useState<PaymentReminderTone>('friendly');
  const [copying, setCopying] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [phoneDraft, setPhoneDraft] = useState('');
  const [phoneInvalid, setPhoneInvalid] = useState(false);
  const [savingPhone, setSavingPhone] = useState(false);
  const phoneInputId = useId();

  const age = useMemo(() => getReminderAge(startedAt), [startedAt]);
  const amountText = formatMoney(amount, currency);
  const duration = formatDuration(age, t);
  const effectivePhone = contactPhone ?? phone;
  // A number WhatsApp can actually dial (national formats included — see
  // normalizeWhatsAppPhone), not merely "something is saved".
  const knownNumber = hasWhatsAppNumber(effectivePhone);
  const shareAvailable = canShareText();
  const canAddNumber = !knownNumber && Boolean(personId);

  const templates: ReminderTemplateMap = {
    receivable: {
      friendly: t('reminder_receivable_friendly'),
      neutral: t('reminder_receivable_neutral'),
      formal: t('reminder_receivable_formal'),
    },
    payable: {
      friendly: t('reminder_payable_friendly'),
      neutral: t('reminder_payable_neutral'),
      formal: t('reminder_payable_formal'),
    },
  };

  const message = buildPaymentReminderMessage({
    name: personName,
    amount: amountText,
    duration,
    direction,
    tone,
  }, templates);

  // The WhatsApp deep link carries the live message (so it respects the chosen
  // tone). Recomputed each render — cheap, and keeps it in sync with `tone`.
  const whatsappUrl = buildWhatsAppUrl(effectivePhone, message);

  const handleCopy = async () => {
    setCopying(true);
    try {
      await copyWithFallback(message);
      toast.show({ type: 'success', title: t('reminder_copied') });
    } catch {
      toast.show({ type: 'error', title: t('reminder_copy_failed') });
    } finally {
      setCopying(false);
    }
  };

  const handleShare = async () => {
    setSharing(true);
    try {
      let outcome: ShareOutcome;
      try {
        outcome = await shareReminderText(message, t('reminder_title'));
      } catch {
        outcome = 'unavailable';
      }
      // No share sheet after all (the button only renders when one should
      // exist): still never a dead tap — hand the text over by copying it.
      if (outcome === 'unavailable') {
        try {
          await copyWithFallback(message);
          toast.show({ type: 'success', title: t('reminder_copied') });
        } catch {
          toast.show({ type: 'error', title: t('reminder_share_failed') });
        }
      }
    } finally {
      setSharing(false);
    }
  };

  const handleSavePhone = async () => {
    if (!personId || savingPhone) return;
    // Only a number WhatsApp can open is worth saving from here — the whole
    // point is sending this reminder straight to their chat.
    if (!hasWhatsAppNumber(phoneDraft)) {
      setPhoneInvalid(true);
      return;
    }
    setSavingPhone(true);
    try {
      await updatePhone(personId, phoneDraft);
      setPhoneDraft('');
      toast.show({ type: 'success', title: t('contact_whatsapp_saved') });
    } catch {
      toast.show({ type: 'error', title: t('err_could_not_save') });
    } finally {
      setSavingPhone(false);
    }
  };

  const whatsappLink = (className: string, label: string, glyph: { size: number; tone?: 'green' }) => (
    // An anchor, like every WhatsApp button in the app: on Android the WebView
    // hands wa.me to the WhatsApp intent (their chat when we know the number,
    // WhatsApp's own picker when not); in a browser it opens a new tab.
    <a
      href={whatsappUrl}
      target="_blank"
      rel="noopener noreferrer"
      onClick={() => toast.show({ type: 'success', title: t('reminder_wa_opening') })}
      className={className}
    >
      <Glyph name="whatsapp" size={glyph.size} strokeWidth={2.6} tone={glyph.tone} /> {label}
    </a>
  );

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('reminder_title')}
      footer={
        <div className="flex flex-col gap-2.5">
          {/* The primary action ALWAYS does something visible. A number
              WhatsApp can dial → straight into their chat (how this audience
              actually chases payments, Hisaab user or not). No such number →
              the OS share sheet (WhatsApp, SMS, anything), or WhatsApp's own
              picker where a runtime has no share sheet. */}
          {knownNumber || !shareAvailable ? (
            whatsappLink('m-btn m-btn-whatsapp w-full py-3.5 text-[14px]', t('reminder_whatsapp'), { size: 17 })
          ) : (
            <button
              type="button"
              onClick={() => void handleShare()}
              disabled={sharing}
              className="m-btn m-btn-primary w-full py-3.5 text-[14px]"
            >
              <Glyph name="share" size={17} /> {sharing ? t('quick_processing') : t('rmd_share_cta')}
            </button>
          )}
          <div className="flex gap-2.5">
            {!knownNumber && shareAvailable &&
              whatsappLink('m-btn m-btn-plain flex-1 px-3 py-3 text-[13px]', t('rmd_whatsapp_short'), { size: 15, tone: 'green' })}
            <button
              type="button"
              onClick={() => void handleCopy()}
              disabled={copying}
              className="m-btn m-btn-plain flex-1 py-3 text-[13px]"
            >
              <Glyph name="copy" size={15} /> {copying ? t('quick_processing') : t('reminder_copy')}
            </button>
            {knownNumber && shareAvailable ? (
              <button
                type="button"
                onClick={() => void handleShare()}
                disabled={sharing}
                className="m-btn m-btn-plain px-4 py-3 text-[13px]"
              >
                <Glyph name="share" size={15} /> {t('reminder_share')}
              </button>
            ) : null}
          </div>
        </div>
      }
    >
      <div className="space-y-4">
        {/* Tinted stat card in the direction's own tone. */}
        <div className={`m-card ${direction === 'receivable' ? 'm-mint' : 'm-coral'} p-4`}>
          <p className={`text-[10.5px] font-semibold uppercase tracking-[0.12em] ${direction === 'receivable' ? 'text-receive-text' : 'text-pay-text'}`}>
            {direction === 'receivable' ? t('reminder_they_owe_me') : t('reminder_i_owe_them')}
          </p>
          <p className="text-[26px] font-semibold text-ink-900 tabular-nums tracking-[-0.03em] mt-1.5 leading-tight">{amountText}</p>
          <p className="text-[12px] text-ink-600 mt-1">{personName} - {formatMeta(age, t, hasDueDate)}</p>
        </div>

        <div>
          <p className="form-label">{t('reminder_tone')}</p>
          {/* Segmented track — the chosen tone is light-faced. */}
          <div className="m-seg flex w-full">
            {(['friendly', 'neutral', 'formal'] as PaymentReminderTone[]).map((nextTone) => (
              <button
                key={nextTone}
                type="button"
                onClick={() => setTone(nextTone)}
                aria-pressed={tone === nextTone}
                className="flex-1 min-h-[36px] text-[11.5px]"
              >
                {nextTone === 'friendly' ? t('reminder_tone_friendly') : nextTone === 'neutral' ? t('reminder_tone_neutral') : t('reminder_tone_formal')}
              </button>
            ))}
          </div>
        </div>

        <div>
          <p className="form-label">{t('reminder_preview')}</p>
          <div className="m-inset p-4">
            <p className="text-[13px] text-ink-800 leading-relaxed whitespace-pre-line">{message}</p>
          </div>
          <p className="text-[10.5px] text-ink-500 mt-2">
            {(knownNumber
              ? t('reminder_wa_to_name')
              : shareAvailable
              ? t('rmd_no_number_hint')
              : t('reminder_wa_pick')
            ).replace('{name}', personName)}
          </p>
        </div>

        {/* Missing number, right where it's missed: save it on the contact
            and the primary button becomes "straight into their chat". */}
        {canAddNumber && (
          <div className="m-card p-3.5">
            <label htmlFor={phoneInputId} className="flex items-center gap-2 text-[12.5px] font-semibold text-ink-900">
              <Glyph name="whatsapp" size={15} tone="green" />
              {t('rmd_add_number_title').replace('{name}', personName)}
            </label>
            <p className="text-[11px] text-ink-600 mt-1 leading-relaxed">{t('rmd_add_number_sub')}</p>
            <div className="flex items-center gap-2 mt-2.5">
              <input
                id={phoneInputId}
                value={phoneDraft}
                onChange={(e) => { setPhoneDraft(e.target.value); setPhoneInvalid(false); }}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void handleSavePhone(); } }}
                placeholder="+92 300 1234567"
                inputMode="tel"
                autoComplete="tel"
                aria-invalid={phoneInvalid}
                className="input-field flex-1 min-w-0 py-2"
              />
              <button
                type="button"
                onClick={() => void handleSavePhone()}
                disabled={savingPhone || !phoneDraft.trim()}
                className="m-btn m-btn-primary shrink-0 px-4 py-2 text-[12.5px]"
              >
                {savingPhone ? t('quick_processing') : t('cat_save')}
              </button>
            </div>
            {phoneInvalid && (
              <p className="text-[11px] text-pay-text mt-2 leading-relaxed" role="alert">
                {t('rmd_add_number_invalid')}
              </p>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}
