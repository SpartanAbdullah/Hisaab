import { useEffect, useMemo, useRef, useState } from 'react';
import { Modal } from './Modal';
import { Glyph } from './Glyph';
import { UserAvatar } from './UserAvatar';
import { useSplitStore } from '../stores/splitStore';
import { useToast } from './Toast';
import { useT } from '../lib/i18n';
import { useSubmitGuard } from '../lib/useSubmitGuard';
import { buildWhatsAppUrl } from '../lib/whatsappReminder';
import {
  MAX_GROUP_GUESTS,
  MAX_GUEST_NAME_LENGTH,
  buildGuestInviteText,
  getGuestMembers,
  guestNameProblemMessage,
  guestRpcFailureMessage,
  isGuestMember,
  validateGuestName,
} from '../lib/groupGuests';
import { canManageGroup, isGroupAdmin, isGroupOwner } from '../lib/groupRoles';
import { copyText, shareText } from '../lib/clipboard';
import { isNativeRuntime } from '../lib/runtime';
import type { GroupInvite, GroupMember, SplitGroup } from '../db';

interface Props {
  open: boolean;
  group: SplitGroup;
  onClose: () => void;
}

// The raw enum used to be printed straight into the badge ("invited",
// "guest"). Since owner-added members now land as 'invited' by default (audit
// H6 / SEC-05) that string is on screen for every new group, so it goes through
// i18n like every other user-facing word — same vocabulary GroupDetailPage's
// member chips use.
//
// The GUEST case is checked FIRST and deliberately: a guest seat is
// status='connected' (that is what makes them a real ledger participant), so
// the status-only branch below would otherwise label them "on Hisaab", which is
// exactly the one thing they are not. The owner and co-admins
// (supabase-migration-group-admins.sql) come before either — a role is the more
// useful fact, and an admin is on Hisaab by definition.
function statusLabel(t: ReturnType<typeof useT>, member: GroupMember): string {
  if (isGroupOwner(member)) return t('member_owner');
  if (isGroupAdmin(member)) return t('member_admin');
  if (isGuestMember(member)) return t('guest_tag');
  if (member.status === 'connected') return t('member_on_app');
  if (member.status === 'invited') return t('member_invited');
  return t('member_not_on_app');
}

// Status chip tone: the people who run the group (owner, admins) wear the
// group's blue — the same accent as their avatar ring on GroupDetailPage; on
// the app = green, invited = gold (waiting on them), a guest and everyone else
// = neutral.
function statusBadgeClass(member: GroupMember) {
  if (isGroupAdmin(member)) return 'm-chip-blue';
  if (isGuestMember(member)) return 'm-chip-neutral';
  if (member.status === 'connected') return 'm-chip-receive';
  if (member.status === 'invited') return 'm-chip-gold';
  return 'm-chip-neutral';
}

// Maps renameGroupGuest's status vocabulary to copy. Not the same helper as
// guestRpcFailureMessage (groupGuests.ts): that one's NOT_ALLOWED / INVALID_NAME
// copy is written for add/remove ("...can remove this seat", "up to 60
// characters") and would read wrong here, so rename gets its own small map —
// reusing guest_err_duplicate_name / guest_err_archived / guest_err_not_member
// as-is since those are generic enough to fit both flows.
function renameFailureMessage(t: ReturnType<typeof useT>, status: string): string {
  if (status === 'DUPLICATE_NAME') return t('guest_err_duplicate_name');
  if (status === 'INVALID_NAME') return t('guest_err_rename_invalid');
  if (status === 'GROUP_ARCHIVED') return t('guest_err_archived');
  if (status === 'NOT_ACTIVE_MEMBER') return t('guest_err_not_member');
  return t('guest_err_generic');
}

/** A minted invite URL, pinned to the group it belongs to: this component can
 *  stay mounted while the route moves to another group. */
interface MintedLink {
  groupId: string;
  url: string;
  /** The seat a linked invite rebinds; null for the open "anyone" link. */
  memberId: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// WHY THE LINK IS MINTED BEFORE THE TAP ("copy group invite link not working",
// founder, 2026-09-19)
//
// This sheet used to mint the invite INSIDE the tap — hydrate the group, SHA-256
// the token, INSERT the row — and only then write the clipboard. A clipboard
// write needs the tap's user activation; after two to four round trips on a
// phone that activation had lapsed, Android's WebView (and Safari) refused the
// write, and the refusal was reported as "Could not create invite" — although
// the invite existed — or, in the guest flow, swallowed without a word.
//
// Now, for the owner or an admin, the open link is minted as soon as the sheet
// opens, so the footer tap copies a link that is already in hand, synchronously
// inside the gesture (src/lib/clipboard.ts). An open invite admits ONE person
// (accept_group_invite stamps accepted_by), so every tap hands out a fresh link
// and the next is minted in the background. Links minted on demand (a specific
// seat) can still outlive the activation; then the link is shown in the sheet
// with Copy and Share buttons — each a fresh tap — and nothing claims a copy
// that did not happen.
//
// Plain members cannot mint at all (group_invites INSERT is owner-or-admin), so
// they get the group code instead of a button that could only fail.
// ─────────────────────────────────────────────────────────────────────────────
export function GroupInviteModal({ open, group, onClose }: Props) {
  const t = useT();
  const toast = useToast();
  const { createInvite, getGroupInvites, addGroupGuest, removeGroupGuest, renameGroupGuest } = useSplitStore();
  const [loading, setLoading] = useState(false);
  const [invites, setInvites] = useState<GroupInvite[]>([]);
  const [guestName, setGuestName] = useState('');
  const [guestPhone, setGuestPhone] = useState('');
  // Ref-backed entry re-check: two taps in one frame both read `loading ===
  // false` (state is async) and would fire two add_group_guest calls with two
  // different minted ids, i.e. two seats for one person. The RPC's idempotency
  // is per member id, so it cannot save us here — this guard is the protection.
  const addGuard = useSubmitGuard();
  const removeGuard = useSubmitGuard();
  const renameGuard = useSubmitGuard();
  const [renamingGuest, setRenamingGuest] = useState<GroupMember | null>(null);
  const [renameValue, setRenameValue] = useState('');

  // Invite links and guest renames are OWNER-OR-ADMIN (group_invites INSERT
  // and group_members UPDATE policies, supabase-migration-group-admins.sql).
  // On a database without that migration nobody is an admin, so this is the
  // old owner check. Offering either action to anyone else could only fail.
  // A legacy owner seat can carry a NULL profile_id (splitStore's
  // isKnownNonMember note); such a seat can only be the caller's own, so it
  // stands in when no seat carries the caller's id — the server gates on
  // split_groups.user_id, not on the seat.
  const currentUserId = localStorage.getItem('hisaab_supabase_uid');
  const me = group.members.find((m) => m.profileId === currentUserId)
    ?? group.members.find((m) => isGroupOwner(m) && !m.profileId);
  const canManage = canManageGroup(me);

  // The pre-minted open link (see the header), and the last link handed out —
  // shown in the sheet so it can be copied or shared again with a fresh tap.
  const [readyLink, setReadyLink] = useState<MintedLink | null>(null);
  const [lastLink, setLastLink] = useState<MintedLink | null>(null);
  const premintingRef = useRef(false);
  const readyUrl = readyLink?.groupId === group.id ? readyLink.url : null;
  const shownLink = lastLink?.groupId === group.id ? lastLink : null;
  const canShare = isNativeRuntime() || (typeof navigator !== 'undefined' && typeof navigator.share === 'function');

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void getGroupInvites(group.id).then((rows) => {
      if (!cancelled) setInvites(rows);
    }).catch(() => {
      if (!cancelled) setInvites([]);
    });
    return () => {
      cancelled = true;
    };
  }, [getGroupInvites, group.id, open]);

  useEffect(() => {
    if (!open || !canManage || readyUrl || premintingRef.current) return;
    premintingRef.current = true;
    const groupId = group.id;
    void createInvite(groupId, null)
      .then((result) => setReadyLink({ groupId, url: result.url, memberId: null }))
      // Silent on purpose: the tap then mints on demand and reports its own
      // failure (offline, or no longer allowed).
      .catch(() => {})
      .finally(() => { premintingRef.current = false; });
  }, [open, canManage, readyUrl, createInvite, group.id]);

  const inviteLookup = useMemo(
    () => new Map(invites.filter(invite => invite.linkedMemberId).map(invite => [invite.linkedMemberId as string, invite])),
    [invites],
  );

  const guestCount = getGuestMembers(group).length;

  const shareInput = (url: string) => ({
    title: group.name,
    text: t('ginv_share_text').replace('{group}', group.name),
    url,
    dialogTitle: t('ginv_share'),
  });

  // Hand a link over. copyText() is the FIRST thing that runs, so when the
  // link was already in hand the write starts inside the tap. A refusal is
  // never reported as a failed invite: the link exists, and the sheet now
  // shows it with Copy and Share.
  const deliverLink = async (url: string, copiedSubtitle: string) => {
    if (await copyText(url)) {
      toast.show({ type: 'success', title: t('ginv_link_copied'), subtitle: copiedSubtitle });
      return;
    }
    toast.show({ type: 'info', title: t('ginv_link_ready'), subtitle: t('ginv_link_ready_sub'), duration: 6000 });
  };

  const mintAndDeliver = async (linkedMemberId: string | null) => {
    setLoading(true);
    try {
      let url: string;
      try {
        url = (await createInvite(group.id, linkedMemberId)).url;
      } catch {
        toast.show({ type: 'error', title: t('ginv_err_create') });
        return;
      }
      setLastLink({ groupId: group.id, url, memberId: linkedMemberId });
      await deliverLink(url, linkedMemberId ? t('ginv_copied_sub_member') : t('ginv_copied_sub_open'));
      if (linkedMemberId) {
        // Best-effort refresh of the "Invite ready" labels — a failure here is
        // not a failed invite, so it must not say so.
        try {
          setInvites(await getGroupInvites(group.id));
        } catch {
          /* keep the labels we have */
        }
      }
    } finally {
      setLoading(false);
    }
  };

  // Footer: the open "anyone with the link" invite.
  const handleCopyGroupLink = () => {
    if (readyUrl) {
      const url = readyUrl;
      setReadyLink(null); // consumed — the effect above mints the next one
      setLastLink({ groupId: group.id, url, memberId: null });
      void deliverLink(url, t('ginv_copied_sub_open'));
      return;
    }
    void mintAndDeliver(null);
  };

  // A member's own seat. Within this sheet the same seat reuses the link it
  // was just given — synchronously — instead of minting another.
  const handleMemberInvite = (member: GroupMember) => {
    if (shownLink && shownLink.memberId === member.id) {
      void deliverLink(shownLink.url, t('ginv_copied_sub_member'));
      return;
    }
    void mintAndDeliver(member.id);
  };

  // The link box's buttons: a fresh tap each, with the link in hand.
  const handleCopyShownLink = (url: string) => {
    void copyText(url).then((copied) => {
      toast.show(copied
        ? { type: 'success', title: t('ginv_link_copied') }
        : { type: 'error', title: t('grp_copy_failed'), subtitle: t('ginv_copy_failed_sub'), duration: 6000 });
    });
  };

  const handleShareShownLink = (url: string) => {
    void shareText(shareInput(url)).then((outcome) => {
      if (outcome === 'failed' || outcome === 'unavailable') {
        toast.show({ type: 'error', title: t('ginv_share_failed'), subtitle: t('ginv_copy_failed_sub') });
      }
    });
  };

  // Plain members: the join code, which every member can see and share.
  const handleCopyCode = () => {
    if (!group.joinCode) return;
    void copyText(group.joinCode).then((copied) => {
      toast.show(copied
        ? { type: 'success', title: t('gdp_code_copied'), subtitle: t('gdp_code_copied_sub') }
        : { type: 'error', title: t('grp_copy_failed'), subtitle: t('grp_copy_failed_code_sub'), duration: 6000 });
    });
  };

  /**
   * "Invite them to Hisaab" for a guest seat.
   *
   * This is the SAME mechanism as assigning the seat, not a second one: the
   * invite carries `linked_member_id`, and accept_group_invite rebinds a
   * profile_id-NULL seat by that id (consent-guards.sql §3.5). So whoever opens
   * the link takes over this seat WITH its expenses and settlements, instead of
   * landing on a fresh row and orphaning the history.
   *
   * The number the seat was created with is NOT available here — add_group_guest
   * stores it only as a hash in a table no client can read — so the WhatsApp
   * link opens the contact picker rather than a pre-addressed chat.
   */
  const handleInviteGuest = (member: GroupMember) => {
    setLoading(true);
    void (async () => {
      try {
        let url: string;
        try {
          url = (await createInvite(group.id, member.id)).url;
        } catch {
          toast.show({ type: 'error', title: t('ginv_err_create') });
          return;
        }
        setLastLink({ groupId: group.id, url, memberId: member.id });
        const text = buildGuestInviteText(member.name, group.name, url);
        // The link rides inside the WhatsApp message; the clipboard is only a
        // courtesy, so its answer does not decide anything here.
        void copyText(url);
        window.open(buildWhatsAppUrl(null, text), '_blank', 'noopener,noreferrer');
        try {
          setInvites(await getGroupInvites(group.id));
        } catch {
          /* keep the labels we have */
        }
      } finally {
        setLoading(false);
      }
    })();
  };

  const handleAddGuest = () => addGuard.run(async () => {
    const problem = validateGuestName(guestName, group.members);
    if (problem) {
      toast.show({ type: 'error', title: guestNameProblemMessage(problem) });
      return;
    }
    setLoading(true);
    try {
      const result = await addGroupGuest(group.id, guestName.trim(), guestPhone.trim() || undefined);
      if (result.status !== 'ok' && result.status !== 'ALREADY_ADDED') {
        toast.show({ type: 'error', title: guestRpcFailureMessage(result.status) });
        return;
      }
      setGuestName('');
      setGuestPhone('');
      toast.show({ type: 'success', title: t('guest_added'), subtitle: result.displayName ?? undefined });
    } catch {
      toast.show({ type: 'error', title: t('guest_err_generic') });
    } finally {
      setLoading(false);
    }
  });

  const handleRemoveGuest = (member: GroupMember) => removeGuard.run(async () => {
    setLoading(true);
    try {
      const result = await removeGroupGuest(group.id, member.id);
      if (result.status !== 'ok') {
        toast.show({ type: 'error', title: guestRpcFailureMessage(result.status) });
        return;
      }
      toast.show({ type: 'success', title: t('guest_removed'), subtitle: member.name });
    } catch {
      toast.show({ type: 'error', title: t('guest_err_generic') });
    } finally {
      setLoading(false);
    }
  });

  const openRenameGuest = (member: GroupMember) => {
    setRenameValue(member.name);
    setRenamingGuest(member);
  };

  const handleRenameGuest = () => renameGuard.run(async () => {
    if (!renamingGuest) return;
    const trimmed = renameValue.trim();
    setLoading(true);
    try {
      const result = await renameGroupGuest(group.id, renamingGuest.id, trimmed);
      if (result.status !== 'ok') {
        toast.show({ type: 'error', title: renameFailureMessage(t, result.status) });
        return;
      }
      toast.show({ type: 'success', title: t('guest_renamed'), subtitle: trimmed });
      setRenamingGuest(null);
    } catch {
      toast.show({ type: 'error', title: t('guest_err_generic') });
    } finally {
      setLoading(false);
    }
  });

  const footer = canManage ? (
    <button
      onClick={handleCopyGroupLink}
      // Disabled only while an on-demand mint runs; a pre-minted link is
      // copied synchronously, so it never waits on the network.
      disabled={loading}
      className="cta-primary"
    >
      <Glyph name="link" size={16} strokeWidth={2.6} /> {loading ? t('ginv_creating_link') : t('ginv_copy_link_cta')}
    </button>
  ) : group.joinCode ? (
    <button onClick={handleCopyCode} className="cta-primary">
      <Glyph name="copy" size={16} strokeWidth={2.6} /> {t('ginv_copy_code_cta')}
    </button>
  ) : undefined;

  return (
    <>
    <Modal
      open={open}
      onClose={onClose}
      title={t('ginv_title')}
      footer={footer}
    >
      <div className="p-5 space-y-4">
        <div className="m-card m-blue px-4 py-3.5">
          <p className="text-[13px] font-semibold text-cobalt-text">{t('ginv_transparency_title')}</p>
          <p className="text-[12px] text-ink-600 mt-1 leading-relaxed">
            {t('ginv_transparency_body')}
          </p>
        </div>

        {!canManage && (
          <div className="m-card px-4 py-3.5">
            <p className="text-[13px] font-semibold text-ink-900">{t('ginv_members_only_title')}</p>
            <p className="text-[12px] text-ink-600 mt-1 leading-relaxed">{t('ginv_members_only_body')}</p>
            {group.joinCode && (
              <p className="m-inset mt-2.5 px-3.5 py-2.5 text-[15px] font-semibold font-mono tracking-tight text-ink-900 select-all">
                {group.joinCode}
              </p>
            )}
          </div>
        )}

        {/* The last link handed out, for a second try with a fresh tap —
            select-all so a press-and-hold copies the whole of it. */}
        {canManage && shownLink && (
          <div className="m-card p-3.5 animate-fade-in">
            <p className="m-label">{t('ginv_link_label')}</p>
            <p className="m-inset mt-2 px-3 py-2 text-[12px] font-mono text-ink-800 break-all select-all">
              {shownLink.url}
            </p>
            <div className="flex gap-2.5 mt-2.5">
              <button
                onClick={() => handleCopyShownLink(shownLink.url)}
                className="m-btn m-btn-plain flex-1 min-h-[38px] px-3 py-2 gap-1.5 rounded-xl text-[12px]"
              >
                <Glyph name="copy" size={14} tone="blue" /> {t('ginv_copy')}
              </button>
              {canShare && (
                <button
                  onClick={() => handleShareShownLink(shownLink.url)}
                  className="m-btn m-btn-plain flex-1 min-h-[38px] px-3 py-2 gap-1.5 rounded-xl text-[12px]"
                >
                  <Glyph name="share" size={14} tone="blue" /> {t('ginv_share')}
                </button>
              )}
            </div>
          </div>
        )}

        <div className="space-y-2.5">
          {group.members.map((member) => {
            const linkedInvite = inviteLookup.get(member.id);
            const guest = isGuestMember(member);
            return (
              <div key={member.id} className="m-card p-3">
                <div className="flex items-center gap-3">
                  {/* Every person wears the navy avatar; the owner's and the
                      admins' are ringed in the group's blue accent. */}
                  <span className={`inline-flex shrink-0 rounded-full ${isGroupAdmin(member) ? 'ring-2 ring-glyph-blue' : ''}`}>
                    <UserAvatar name={member.name} size={40} />
                  </span>
                  <div className="flex-1 min-w-0">
                    <p className="text-[13.5px] font-semibold text-ink-900 truncate tracking-[-0.01em]">{member.name}</p>
                    <div className="flex items-center gap-2 mt-1">
                      <span className={`m-chip m-chip-caps ${statusBadgeClass(member)}`}>
                        {statusLabel(t, member)}
                      </span>
                      {linkedInvite && (
                        <span className="text-[10.5px] text-ink-500 truncate">
                          {t('ginv_invite_ready')}
                        </span>
                      )}
                    </div>
                  </div>
                  {/* A guest is status='connected', so the old
                      `status !== 'connected'` test would have hidden every
                      affordance for exactly the people who need one. Both
                      buttons mint an invite — owner or admin only. */}
                  {canManage && !isGroupOwner(member) && (member.status !== 'connected' || guest) && (
                    <button
                      onClick={() => (guest ? handleInviteGuest(member) : handleMemberInvite(member))}
                      disabled={loading}
                      className="m-btn m-btn-plain shrink-0 min-h-[36px] px-3 py-2 gap-1.5 rounded-xl text-[11.5px]"
                    >
                      <Glyph
                        name={guest ? 'send' : linkedInvite ? 'copy' : 'user-plus'}
                        size={13}
                        tone="blue"
                      />
                      {guest ? t('guest_invite_cta') : linkedInvite ? t('ginv_copy') : t('ginv_invite')}
                    </button>
                  )}
                </div>
                {guest && (
                  <div className="mt-2.5 pt-2.5 border-t border-cream-hairline flex items-center justify-between gap-3">
                    <p className="text-[10.5px] text-ink-500 leading-snug">{t('guest_assign_hint')}</p>
                    <div className="shrink-0 flex items-center gap-3">
                      {canManage && (
                        <button
                          onClick={() => openRenameGuest(member)}
                          disabled={loading}
                          aria-label={t('guest_rename_cta')}
                          className="relative w-8 h-8 flex items-center justify-center text-ink-500 active:opacity-60 disabled:opacity-40"
                        >
                          <Glyph name="edit" size={14} />
                        </button>
                      )}
                      <button
                        onClick={() => handleRemoveGuest(member)}
                        disabled={loading}
                        className="text-[11px] font-semibold text-pay-text active:opacity-60 flex items-center gap-1 min-h-[32px] disabled:opacity-40"
                      >
                        <Glyph name="trash" size={12} /> {t('guest_remove_cta')}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* ── Add someone who is not on Hisaab (audit G6 / O4) ───────────────
            Any CONNECTED member may do this, not just the owner — see the
            migration's §0b. Nothing about it touches accounts in either app
            mode; a guest is a ledger seat, never a money movement. */}
        <div className="m-card p-3.5">
          <p className="text-[12.5px] font-semibold text-ink-900">{t('guest_add_cta')}</p>
          <p className="text-[11px] text-ink-600 mt-1 leading-relaxed">{t('guest_add_hint')}</p>
          <div className="flex gap-2.5 mt-3">
            <input
              className="input-field"
              value={guestName}
              maxLength={MAX_GUEST_NAME_LENGTH}
              onChange={(e) => setGuestName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleAddGuest(); } }}
              placeholder={t('guest_name_placeholder')}
            />
            <button
              onClick={handleAddGuest}
              disabled={loading || !guestName.trim() || guestCount >= MAX_GROUP_GUESTS}
              className="m-ctl shrink-0 w-12 h-12 rounded-[14px] flex items-center justify-center disabled:opacity-40"
              aria-label={t('guest_add_cta')}
            >
              <Glyph name="user-plus" size={19} tone="neutral" />
            </button>
          </div>
          <input
            className="input-field mt-2.5"
            value={guestPhone}
            onChange={(e) => setGuestPhone(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleAddGuest(); } }}
            placeholder={t('guest_phone_placeholder')}
            inputMode="tel"
            autoComplete="off"
          />
          <p className="text-[11px] text-ink-500 mt-2 leading-relaxed">{t('guest_phone_hint')}</p>
        </div>
      </div>
    </Modal>

    {/* Rename sheet (docs/guest-members.md §9.4). Owner or admin, unclaimed
        guest seats only — see the canManage gate on the pencil button above. */}
    <Modal
      open={!!renamingGuest}
      onClose={() => setRenamingGuest(null)}
      title={t('guest_rename_title')}
      footer={(
        <button
          onClick={handleRenameGuest}
          disabled={loading || !renameValue.trim()}
          className="cta-primary"
        >
          {t('save')}
        </button>
      )}
    >
      <div className="p-5">
        <input
          className="input-field"
          value={renameValue}
          maxLength={40}
          autoFocus
          onChange={(e) => setRenameValue(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleRenameGuest(); } }}
          placeholder={t('guest_name_placeholder')}
        />
      </div>
    </Modal>
    </>
  );
}
