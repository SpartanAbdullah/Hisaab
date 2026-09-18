import { useState } from 'react';
import { format } from 'date-fns';
import { Glyph } from './Glyph';
import { Modal } from './Modal';
import { useToast } from './Toast';
import { confirmDestructive } from './ConfirmDestructiveSheet';
import { useT } from '../lib/i18n';
import { useSubmitGuard } from '../lib/useSubmitGuard';
import { useCommitteeStore } from '../stores/committeeStore';
import { buildAppShareUrl } from '../lib/collaboration';
import { buildWhatsAppUrl } from '../lib/whatsappReminder';
import { witnessInitials, witnessLinkState } from '../lib/blockStatus';
import type { Committee, CommitteeMember } from '../db';

// ───────────────────────────────────────────────────────────────────────────
// Organiser controls for the public kameti witness link (audit M19 / UX-24).
//
// WHAT CHANGED, AND WHY THIS COMPONENT EXISTS AT ALL:
// the token used to be minted on the organiser's phone, stored in plaintext,
// never expired, and had no un-share path. `supabase-migration-p2-trust-safety`
// nulls the plaintext column and keeps only a SHA-256, so the app CANNOT
// display an existing link any more — it can only mint a new one, once, and
// hand it straight to the share sheet.
//
// Three consequences the UI has to be honest about:
//   1. A link the organiser shared before this migration STILL WORKS (it was
//      hashed in place) and now expires in 90 days — but we can't show it. So
//      "no link we can show you" is offered as *Create link*, and creating one
//      says out loud that it kills whatever is out there.
//   2. The raw token is displayed exactly once and is never stored — not in
//      the store, not in localStorage, not in the payout slip.
//   3. Revoke and expiry both make the link read exactly like a wrong one on
//      the witness page. That is deliberate, not a missing error state.
// ───────────────────────────────────────────────────────────────────────────

interface Props {
  committee: Committee;
  members: CommitteeMember[];
}

function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text).catch(() => Promise.resolve());
  }
  return Promise.resolve();
}

export function CommitteeWitnessLink({ committee, members }: Props) {
  const t = useT();
  const toast = useToast();
  const rotateWitnessToken = useCommitteeStore((s) => s.rotateWitnessToken);
  const revokeWitnessToken = useCommitteeStore((s) => s.revokeWitnessToken);
  const setWitnessInitialsOnly = useCommitteeStore((s) => s.setWitnessInitialsOnly);

  // The minted URL lives ONLY here, in component state, for the life of this
  // sheet. It is never lifted into the store or persisted anywhere.
  const [minted, setMinted] = useState<{ url: string; replacedPrevious: boolean } | null>(null);
  const [busy, setBusy] = useState(false);

  const rotateGuard = useSubmitGuard();
  const revokeGuard = useSubmitGuard();
  const initialsGuard = useSubmitGuard();

  const state = witnessLinkState({
    expiresAt: committee.witnessExpiresAt,
    revokedAt: committee.witnessRevokedAt,
  });
  const initialsOnly = committee.witnessInitialsOnly === true;
  const previewName = members[0]?.name ?? '';

  const stateLine =
    state === 'active' && committee.witnessExpiresAt
      ? t('kwt_state_active').replace('{date}', format(new Date(committee.witnessExpiresAt), 'd MMM yyyy'))
      : state === 'revoked'
        ? t('kwt_state_revoked')
        : state === 'expired'
          ? t('kwt_state_expired')
          : t('kwt_state_none');

  const handleRotate = () => rotateGuard.run(async () => {
    setBusy(true);
    try {
      const result = await rotateWitnessToken(committee.id);
      if (result.status !== 'ok') {
        toast.show({
          type: 'error',
          title: result.status === 'NOT_FOUND' ? t('kwt_not_organiser') : t('kwt_failed'),
        });
        return;
      }
      setMinted({
        url: `${buildAppShareUrl()}/kameti/witness/${result.token}`,
        replacedPrevious: result.replacedPrevious,
      });
    } finally {
      setBusy(false);
    }
  });

  const handleRevoke = () => revokeGuard.run(async () => {
    const ok = await confirmDestructive({
      title: t('kwt_revoke_confirm_title'),
      description: t('kwt_revoke_confirm_body'),
      confirmLabel: t('kwt_revoke_cta'),
      cancelLabel: t('cancel'),
    });
    if (!ok) return;
    setBusy(true);
    try {
      const result = await revokeWitnessToken(committee.id);
      if (result.status !== 'ok') {
        toast.show({
          type: 'error',
          title: result.status === 'NOT_FOUND' ? t('kwt_not_organiser') : t('kwt_failed'),
        });
        return;
      }
      toast.show({ type: 'success', title: t('kwt_revoked_toast') });
    } finally {
      setBusy(false);
    }
  });

  const handleToggleInitials = () => initialsGuard.run(async () => {
    setBusy(true);
    try {
      await setWitnessInitialsOnly(committee.id, !initialsOnly);
    } catch {
      toast.show({ type: 'error', title: t('kwt_failed') });
    } finally {
      setBusy(false);
    }
  });

  const shareBody = minted
    ? t('kameti_witness_msg').replace('{committee}', committee.name).replace('{url}', minted.url)
    : '';

  return (
    <div className="m-card p-4">
      <div className="flex items-center gap-2.5">
        <div className="m-ctl w-8 h-8 rounded-[10px] flex items-center justify-center shrink-0" aria-hidden="true">
          <Glyph name="eye" size={16} tone="gold" />
        </div>
        <div className="min-w-0">
          <p className="text-[13.5px] font-semibold text-ink-900 leading-snug">{t('kwt_section_title')}</p>
          <p className="text-[11px] text-ink-600 mt-0.5">{stateLine}</p>
        </div>
      </div>

      {/* UX-24's privacy warning. Shown BEFORE the first share, not after — it
          is the thing that makes "forwarded to a family WhatsApp group" a
          decision rather than a surprise. */}
      <div className="m-inset mt-3.5 p-3 space-y-1.5">
        <p className="m-label flex items-center gap-1.5">
          <Glyph name="shield" size={12} strokeWidth={2.6} /> {t('kwt_privacy_title')}
        </p>
        {[t('kwt_privacy_1'), t('kwt_privacy_2'), t('kwt_privacy_3')].map((line) => (
          <p key={line} className="text-[11px] text-ink-700 leading-relaxed">{line}</p>
        ))}
      </div>

      {/* Initials-only — a live preview, because "A.R." is only reassuring once
          you have seen it applied to a real member's name. The whole row is
          the switch (a big target); the 1d switch face inside shows state. */}
      <button
        type="button"
        role="switch"
        onClick={handleToggleInitials}
        disabled={busy}
        aria-checked={initialsOnly}
        className="w-full mt-3 flex items-start gap-3 rounded-[14px] p-3 text-left active:bg-cream-soft transition-colors disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-accent-500 focus-visible:outline-offset-2"
      >
        <span className="min-w-0 flex-1">
          <span className="text-[12.5px] font-semibold text-ink-900 flex items-center gap-1.5">
            <Glyph name="eye-off" size={13} tone="neutral" /> {t('kwt_initials_title')}
          </span>
          <span className="block text-[11px] text-ink-600 mt-0.5 leading-relaxed">{t('kwt_initials_sub')}</span>
          {previewName && (
            <span className="block text-[11px] text-ink-700 font-mono mt-1">
              {t('kwt_initials_preview')
                .replace('{name}', previewName)
                .replace('{initials}', witnessInitials(previewName))}
            </span>
          )}
        </span>
        <span className={`m-switch block shrink-0 mt-0.5 ${initialsOnly ? 'is-on' : ''}`} aria-hidden="true" />
      </button>

      {state === 'active' && (
        <p className="text-[10.5px] text-ink-400 mt-2 leading-relaxed">{t('kwt_replace_warn')}</p>
      )}

      <button
        type="button"
        onClick={handleRotate}
        disabled={busy}
        className="m-btn m-btn-plain w-full mt-3 text-[12.5px]"
      >
        <Glyph name="link" size={15} tone="gold" /> {state === 'active' ? t('kwt_replace_cta') : t('kwt_create_cta')}
      </button>

      {state === 'active' && (
        <button
          type="button"
          onClick={handleRevoke}
          disabled={busy}
          className="m-btn m-btn-danger w-full mt-3 text-[12.5px]"
        >
          {t('kwt_revoke_cta')}
        </button>
      )}

      {/* Show-once sheet. Closing it is the last moment this token exists on
          this device — there is no "show again". */}
      <Modal
        open={!!minted}
        onClose={() => setMinted(null)}
        title={t('kwt_token_once_title')}
        footer={
          <button
            type="button"
            onClick={() => setMinted(null)}
            className="cta-primary"
          >
            {t('kwt_done_cta')}
          </button>
        }
      >
        <div className="space-y-3.5">
          <p className="text-[11.5px] text-ink-600 leading-relaxed">{t('kwt_token_once_body')}</p>
          {minted?.replacedPrevious && (
            <p className="text-[11.5px] text-warn-700 bg-warn-50 rounded-[12px] p-3 leading-relaxed">
              {t('kwt_replaced_previous')}
            </p>
          )}
          <div className="m-inset px-3 py-2.5">
            <p className="text-[10.5px] font-mono text-ink-800 break-all leading-snug">{minted?.url}</p>
          </div>
          <div className="flex gap-2.5">
            <button
              type="button"
              onClick={async () => {
                if (!minted) return;
                await copyText(minted.url);
                toast.show({ type: 'success', title: t('kwt_copied_toast') });
              }}
              className="m-btn m-btn-plain flex-1 px-3 text-[12.5px]"
            >
              <Glyph name="copy" size={15} /> {t('kwt_copy_cta')}
            </button>
            <button
              type="button"
              onClick={() => {
                if (!minted) return;
                window.open(buildWhatsAppUrl(null, shareBody), '_blank', 'noopener,noreferrer');
              }}
              className="m-btn m-btn-whatsapp flex-1 px-3 text-[12.5px]"
            >
              <Glyph name="whatsapp" size={15} /> {t('kwt_share_cta')}
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
