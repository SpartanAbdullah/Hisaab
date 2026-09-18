import { useEffect, useState } from 'react';
import { ShieldOff } from 'lucide-react';
import { Modal } from './Modal';
import { Glyph } from './Glyph';
import { useToast } from './Toast';
import { useT } from '../lib/i18n';
import { useKhataLinkStore } from '../stores/khataLinkStore';
import { daysUntilExpiry, formatKhataError } from '../lib/khataLinkStatus';
import { buildWhatsAppUrl, hasWhatsAppNumber } from '../lib/whatsappReminder';

// Owner-side control panel for one contact's public khata link (audit P3 / L2;
// 11-competitive-analysis O2 + G3).
//
// THREE THINGS ONLY: create/rotate, share, revoke. Everything else about the
// link lives on the server.
//
// WHY THE TOKEN IS NEVER CACHED: create_khata_link returns the raw token
// EXACTLY ONCE and stores only its SHA-256, so there is nothing to re-read.
// The store keeps it in memory while this sheet is open and drops it after —
// persisting a live capability URL to localStorage would undo the reason the
// token is hashed at rest in the first place. A user who loses it rotates,
// which is one tap and is the correct semantics for a capability.
//
// WHY ROTATING IS LOUD: a rotate kills the previous URL. Someone who already
// forwarded the old link over WhatsApp needs to be told, or they will simply
// see it stop opening.

interface Props {
  open: boolean;
  onClose: () => void;
  personId: string;
  personName: string;
  /** The contact's saved WhatsApp number, if any. Null → the contact picker. */
  phone?: string | null;
}

function copyWithFallback(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text).catch(() => copyWithTextarea(text));
  }
  return copyWithTextarea(text);
}

function copyWithTextarea(text: string): Promise<void> {
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

export function ShareKhataLinkSheet({ open, onClose, personId, personName, phone = null }: Props) {
  const t = useT();
  const toast = useToast();
  const link = useKhataLinkStore((s) => s.links[personId] ?? null);
  const busy = useKhataLinkStore((s) => s.busyPersonId === personId);
  const error = useKhataLinkStore((s) => s.error);
  const createLink = useKhataLinkStore((s) => s.createLink);
  const revokeLink = useKhataLinkStore((s) => s.revokeLink);
  const forget = useKhataLinkStore((s) => s.forget);
  const clearError = useKhataLinkStore((s) => s.clearError);

  // Initials-only and show-notes are both chosen BEFORE minting, so the very
  // first link the user shares already honours them — asking afterwards
  // would mean rotating.
  const [initialsOnly, setInitialsOnly] = useState(false);
  // Off by default: a loan/payment note is free text the owner wrote for
  // themselves, not written with a forwardable public page in mind.
  const [showNotes, setShowNotes] = useState(false);
  const [copying, setCopying] = useState(false);

  useEffect(() => {
    if (open) {
      clearError();
      setInitialsOnly(link?.initialsOnly ?? false);
      setShowNotes(link?.showNotes ?? false);
    } else {
      // Drop the in-memory capability URL the moment the sheet closes.
      forget(personId);
    }
    // `link` is read only at open-time to seed the toggle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, personId]);

  const message = link
    ? t('khata_share_wa_text').replace('{name}', personName).replace('{url}', link.url)
    : '';
  const whatsappUrl = buildWhatsAppUrl(phone, message);
  const expiryDays = link ? daysUntilExpiry(link.expiresAt) : 0;

  const handleCreate = async () => {
    const created = await createLink(personId, initialsOnly, showNotes);
    if (!created) {
      toast.show({ type: 'error', title: formatKhataError({ status: useKhataLinkStore.getState().error }, t) });
    }
  };

  const handleRevoke = async () => {
    const ok = await revokeLink(personId);
    if (ok) {
      toast.show({ type: 'success', title: t('khata_share_revoked_toast') });
    } else {
      toast.show({ type: 'error', title: formatKhataError({ status: useKhataLinkStore.getState().error }, t) });
    }
  };

  const handleCopy = async () => {
    if (!link) return;
    setCopying(true);
    try {
      await copyWithFallback(link.url);
      toast.show({ type: 'success', title: t('khata_share_copied') });
    } catch {
      toast.show({ type: 'error', title: t('khata_share_copy_failed') });
    } finally {
      setCopying(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('khata_share_title')}
      footer={
        <div className="flex flex-col gap-3">
          {!link ? (
            <button
              type="button"
              onClick={handleCreate}
              disabled={busy}
              className="m-btn m-btn-primary w-full py-3.5 text-[14px]"
            >
              <Glyph name="link" size={16} /> {busy ? t('khata_share_working') : t('khata_share_create_cta')}
            </button>
          ) : (
            <>
              <div className="flex gap-2.5">
                <a
                  href={whatsappUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={() => toast.show({ type: 'success', title: t('reminder_wa_opening') })}
                  className="m-btn m-btn-green flex-1 py-3 text-[13px]"
                >
                  <Glyph name="whatsapp" size={15} strokeWidth={2.6} /> {t('khata_share_whatsapp')}
                </a>
                <button
                  type="button"
                  onClick={handleCopy}
                  disabled={copying}
                  className="m-btn m-btn-plain px-4 py-3 text-[13px]"
                >
                  <Glyph name="copy" size={15} /> {copying ? t('khata_share_working') : t('khata_share_copy')}
                </button>
              </div>
              <div className="flex gap-2.5">
                <button
                  type="button"
                  onClick={handleCreate}
                  disabled={busy}
                  className="m-btn m-btn-plain flex-1 py-2.5 text-[12px]"
                >
                  <Glyph name="refresh" size={14} /> {t('khata_share_rotate_cta')}
                </button>
                <button
                  type="button"
                  onClick={handleRevoke}
                  disabled={busy}
                  className="m-btn m-btn-danger flex-1 py-2.5 text-[12px] gap-1.5"
                >
                  {/* No 3c glyph for "revoke" — lucide at the glyph stroke weight. */}
                  <ShieldOff size={14} strokeWidth={2.4} className="shrink-0" /> {t('khata_share_revoke_cta')}
                </button>
              </div>
            </>
          )}
        </div>
      }
    >
      <div className="space-y-4">
        <p className="text-[12.5px] text-ink-700 leading-relaxed">
          {t('khata_share_desc').replace('{name}', personName)}
        </p>

        {/* Pre-mint options. Hidden once a link exists, because changing this
            afterwards requires a rotate — which the rotate button already is.
            Each row is a switch (role="switch"): its label is the accessible
            name and the full row is the tap target. */}
        {!link && (
          <div className="m-card overflow-hidden divide-y divide-cream-hairline">
            <button
              type="button"
              role="switch"
              aria-checked={initialsOnly}
              onClick={() => setInitialsOnly((v) => !v)}
              className="w-full flex items-center justify-between gap-3 px-4 py-3 text-left active:bg-cream-soft transition-colors"
            >
              <span className="text-[12.5px] font-semibold text-ink-800">
                {t('khata_share_initials_label')}
                <span className="block text-[10.5px] font-normal text-ink-600 mt-0.5">
                  {t('khata_share_initials_sub')}
                </span>
              </span>
              <span aria-hidden className={`m-switch block ${initialsOnly ? 'is-on' : ''}`} />
            </button>

            {/* Off by default — notes are free text the owner wrote for
                themselves, not written with a forwardable page in mind. */}
            <button
              type="button"
              role="switch"
              aria-checked={showNotes}
              onClick={() => setShowNotes((v) => !v)}
              className="w-full flex items-center justify-between gap-3 px-4 py-3 text-left active:bg-cream-soft transition-colors"
            >
              <span className="text-[12.5px] font-semibold text-ink-800">
                {t('khata_share_notes_label')}
                <span className="block text-[10.5px] font-normal text-ink-600 mt-0.5">
                  {t('khata_share_notes_sub')}
                </span>
              </span>
              <span aria-hidden className={`m-switch block ${showNotes ? 'is-on' : ''}`} />
            </button>
          </div>
        )}

        {/* The minted URL. Shown in full so the user can see exactly what they
            are about to send. */}
        {link && (
          <div>
            <p className="form-label">{t('khata_share_link_label')}</p>
            <div className="m-inset p-3.5">
              <p className="text-[11.5px] text-ink-800 break-all leading-relaxed">{link.url}</p>
            </div>
            {expiryDays > 0 && (
              <p className="text-[10.5px] text-ink-600 mt-2 tabular-nums">
                {t('khata_share_expires').replace('{days}', String(expiryDays))}
              </p>
            )}
          </div>
        )}

        {/* A rotate silently killed a URL the user may already have sent. Say so. */}
        {link?.replacedPrevious && (
          <div className="m-card m-gold flex items-start gap-2.5 p-3.5">
            <Glyph name="alert" size={15} tone="gold" className="mt-0.5" />
            <p className="text-[11.5px] text-warn-700 leading-relaxed">{t('khata_share_replaced')}</p>
          </div>
        )}

        {/* What the link does and does not reveal — the honest version, shown
            before the share, not buried in a settings screen. */}
        <div className="m-card p-3.5 space-y-2.5">
          <div className="flex items-start gap-2.5">
            <Glyph name="lock" size={15} className="text-ink-500 mt-0.5" />
            <p className="text-[11.5px] text-ink-600 leading-relaxed">{t('khata_share_privacy')}</p>
          </div>
          <div className="flex items-start gap-2.5">
            <Glyph name="alert" size={15} className="text-ink-500 mt-0.5" />
            <p className="text-[11.5px] text-ink-600 leading-relaxed">{t('khata_share_capability_warning')}</p>
          </div>
        </div>

        {error && (
          <p className="text-[11.5px] text-pay-text leading-relaxed">{formatKhataError({ status: error }, t)}</p>
        )}

        {link && (
          <p className="text-[10px] text-ink-400">
            {(hasWhatsAppNumber(phone) ? t('reminder_wa_to_name') : t('reminder_wa_pick')).replace('{name}', personName)}
          </p>
        )}
      </div>
    </Modal>
  );
}
