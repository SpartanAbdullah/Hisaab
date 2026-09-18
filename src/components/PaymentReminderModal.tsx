import { useMemo, useState } from 'react';
import { Modal } from './Modal';
import { Glyph } from './Glyph';
import { useToast } from './Toast';
import { formatMoney } from '../lib/constants';
import { useT } from '../lib/i18n';
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

export function PaymentReminderModal({ open, onClose, personName, amount, currency, direction, startedAt, hasDueDate = true, phone = null }: Props) {
  const t = useT();
  const toast = useToast();
  const [tone, setTone] = useState<PaymentReminderTone>('friendly');
  const [copying, setCopying] = useState(false);
  const [sharing, setSharing] = useState(false);

  const age = useMemo(() => getReminderAge(startedAt), [startedAt]);
  const amountText = formatMoney(amount, currency);
  const duration = formatDuration(age, t);
  const shareAvailable = typeof navigator !== 'undefined' && typeof navigator.share === 'function';
  const knownNumber = hasWhatsAppNumber(phone);

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
  const whatsappUrl = buildWhatsAppUrl(phone, message);

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
    if (!shareAvailable) return;
    setSharing(true);
    try {
      await navigator.share({ text: message });
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) {
        toast.show({ type: 'error', title: t('reminder_share_failed') });
      }
    } finally {
      setSharing(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('reminder_title')}
      footer={
        <div className="flex flex-col gap-2.5">
          {/* WhatsApp is the primary action — it's how this audience actually
              chases payments, and it works whether or not the contact uses
              Hisaab. Rendered as an anchor so Android hands it to the
              WhatsApp intent (chat when we know the number, picker when not). */}
          {/* Green solid (the 1d accept/send green) with the WhatsApp mark. */}
          <a
            href={whatsappUrl}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => toast.show({ type: 'success', title: t('reminder_wa_opening') })}
            className="m-btn m-btn-green w-full py-3.5 text-[14px]"
          >
            <Glyph name="whatsapp" size={17} strokeWidth={2.6} /> {t('reminder_whatsapp')}
          </a>
          <div className="flex gap-2.5">
            <button
              onClick={handleCopy}
              disabled={copying}
              className="m-btn m-btn-plain flex-1 py-3 text-[13px]"
            >
              <Glyph name="copy" size={15} /> {copying ? t('quick_processing') : t('reminder_copy')}
            </button>
            {shareAvailable ? (
              <button
                onClick={handleShare}
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
            {(knownNumber ? t('reminder_wa_to_name') : t('reminder_wa_pick')).replace('{name}', personName)}
          </p>
        </div>
      </div>
    </Modal>
  );
}
