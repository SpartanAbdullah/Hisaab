import { useCallback, useMemo, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
// Crown (organiser), Dices (ballot) and UserMinus (remove from the kameti) have
// no 3c glyph yet — kept as lucide at the glyph stroke weight (2.4).
import { Crown, Dices, UserMinus } from 'lucide-react';
import { format } from 'date-fns';
import { useCommitteeStore } from '../stores/committeeStore';
import { CommitteeDrawError } from '../lib/supabaseDb';
import { EditCommitteeSheet } from '../components/EditCommitteeSheet';
import { committeeErrorKey } from '../lib/committeeErrorText';
import { Modal } from '../components/Modal';
import { PageHeader } from '../components/PageHeader';
import { PageErrorState } from '../components/PageErrorState';
import { CommitteeVerifyDraw } from '../components/CommitteeVerifyDraw';
import { CommitteeWitnessLink } from '../components/CommitteeWitnessLink';
import { Glyph } from '../components/Glyph';
import { UserAvatar } from '../components/UserAvatar';
import { MoneyDisplay } from '../components/MoneyDisplay';
import { ListSkeleton } from '../components/ListSkeleton';
import { useToast } from '../components/Toast';
import { confirmDestructive } from '../components/ConfirmDestructiveSheet';
import { useAsyncLoad } from '../hooks/useAsyncLoad';
import { useSubmitGuard } from '../lib/useSubmitGuard';
import { formatMoney } from '../lib/constants';
import { useT, type I18nKey } from '../lib/i18n';
import { buildWhatsAppUrl } from '../lib/whatsappReminder';
import { KametiPayoutSlipSheet } from '../components/KametiPayoutSlipSheet';
import {
  poolAmount, currentRound, roundDate, recipientForRound, hasPaid,
  paymentsForRound, slotKind, buildSchedule,
  canAddCommitteeMember, canRemoveCommitteeMember,
  type MemberAddBlock, type MemberRemoveBlock,
} from '../lib/committeeMath';
import type { CommitteeMember } from '../db';

// The refusal → sentence map that used to live here is now
// `committeeErrorKey` in src/lib/committeeErrorText.ts: the editing RPCs raise
// into the same code space as the draw and EditCommitteeSheet surfaces them
// too, so two exhaustive copies would drift. It is still exhaustive by
// construction — a code added to COMMITTEE_DRAW_ERRORS is a type error there
// rather than a silent "couldn't run the draw".

// Why the Add / Remove affordance is unavailable — one sentence per refusal in
// add_committee_member / remove_committee_member. Exhaustive `Record`s over the
// two reason unions, for the same reason as above.
const ADD_BLOCK_KEY: Record<MemberAddBlock, I18nKey> = {
  drawn: 'kameti_add_blocked_drawn',
  payout_confirmed: 'kameti_add_blocked_payout',
  cycle_over: 'kameti_add_blocked_cycle_over',
  completed: 'kameti_add_blocked_completed',
  too_many: 'kameti_add_blocked_too_many',
};

const REMOVE_BLOCK_KEY: Record<MemberRemoveBlock, I18nKey> = {
  drawn: 'kameti_remove_blocked_drawn',
  organizer: 'kameti_remove_blocked_organizer',
  too_few: 'kameti_remove_blocked_too_few',
  member_has_payments: 'kameti_remove_blocked_payments',
  payout_received: 'kameti_remove_blocked_payout',
  rounds_collected: 'kameti_remove_blocked_rounds',
  not_found: 'kameti_draw_failed',
};

export function KametiDetailPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const t = useT();
  const toast = useToast();

  const getCommittee = useCommitteeStore((s) => s.getCommittee);
  const committee = useCommitteeStore((s) => s.committees.find((c) => c.id === id));
  // Subscribe to the RAW members/payments arrays (not the selector functions)
  // so the page re-renders the instant a payment toggles or a payout is
  // confirmed — otherwise the store updates but the UI stays stale.
  const allMembers = useCommitteeStore((s) => s.members);
  const allPayments = useCommitteeStore((s) => s.payments);
  const loadAll = useCommitteeStore((s) => s.loadAll);
  const runBallot = useCommitteeStore((s) => s.runBallot);
  const setPaid = useCommitteeStore((s) => s.setPaid);
  const confirmPayout = useCommitteeStore((s) => s.confirmPayout);
  const updateMember = useCommitteeStore((s) => s.updateMember);
  const addMember = useCommitteeStore((s) => s.addMember);
  const removeMember = useCommitteeStore((s) => s.removeMember);
  const deleteCommittee = useCommitteeStore((s) => s.deleteCommittee);

  const load = useCallback(async () => { if (!getCommittee(id)) await loadAll(); }, [getCommittee, id, loadAll]);
  const { status } = useAsyncLoad(load);

  const members = useMemo(
    () => allMembers.filter((m) => m.committeeId === id).sort((a, b) => (a.slot ?? 999) - (b.slot ?? 999) || a.createdAt.localeCompare(b.createdAt)),
    [allMembers, id],
  );
  const payments = useMemo(() => allPayments.filter((p) => p.committeeId === id), [allPayments, id]);

  const liveRound = committee ? currentRound(committee.startDate, committee.cadence, committee.totalRounds) : 1;
  const [viewRound, setViewRound] = useState<number | null>(null);
  const [drawing, setDrawing] = useState(false);
  const [slip, setSlip] = useState<{ recipient: CommitteeMember; round: number; witnessUrl?: string } | null>(null);
  // Fix a member's name / WhatsApp number after creation (name typo, missing
  // number). Draw order and payments are untouched.
  const [editMember, setEditMember] = useState<CommitteeMember | null>(null);
  const [editName, setEditName] = useState('');
  const [editPhone, setEditPhone] = useState('');
  const openEditMember = (m: CommitteeMember) => {
    setEditName(m.name);
    setEditPhone(m.phone ?? '');
    setEditMember(m);
  };
  const saveEditMember = async () => {
    if (!editMember || !editName.trim()) return;
    await updateMember(editMember.id, { name: editName.trim(), phone: editPhone.trim() || null });
    setEditMember(null);
  };
  // Post-creation editing (audit UX-25): the committee sheet, plus adding and
  // removing members. `busy` is the ref-backed double-tap guard's visible half
  // — add/remove both move member_count and total_rounds, so a duplicated tap
  // would silently lengthen the cycle.
  const [editingCommittee, setEditingCommittee] = useState(false);
  const [addingMember, setAddingMember] = useState(false);
  const [newMemberName, setNewMemberName] = useState('');
  const [newMemberPhone, setNewMemberPhone] = useState('');
  const [rosterBusy, setRosterBusy] = useState(false);
  const memberGuard = useSubmitGuard();
  const round = viewRound ?? liveRound;

  if (status === 'loading' && !committee) {
    // Skeleton in the loaded page's geometry: the gold pool card, then the
    // member list.
    return (
      <main className="min-h-dvh bg-cream-bg pb-28">
        <PageHeader title={t('kameti_title')} back />
        <div className="px-5 pt-3 space-y-4" aria-hidden="true">
          <div className="m-card m-gold m-card-feature p-5">
            <div className="m-skel h-[10px] w-24" />
            <div className="m-skel mt-3 h-8 w-44 rounded-lg" />
            <div className="m-skel mt-3 h-[10px] w-36" />
            <div className="mt-4 flex gap-1.5">
              <div className="m-skel h-5 w-32 rounded-full" />
              <div className="m-skel h-5 w-20 rounded-full" />
            </div>
          </div>
          <ListSkeleton rows={4} />
        </div>
      </main>
    );
  }
  if (!committee) {
    return (
      <main className="min-h-dvh bg-cream-bg">
        <PageHeader title={t('kameti_title')} back />
        <div className="px-5 pt-8"><PageErrorState variant="inline" title={t('kameti_title')} message={t('kameti_not_found')} /></div>
      </main>
    );
  }

  const pool = poolAmount(committee.contributionAmount, committee.memberCount);
  // A draw RECORD exists the moment the server stamps drawn_at / draw_seed —
  // that, not the slots being visible, is what must retire the draw button
  // (audit 2026-09 F-13: the ballot had no drawn-guard at all, so a double tap
  // or a stale tab could re-roll an order witnesses had already seen).
  const hasDrawRecord = !!committee.drawnAt || !!committee.drawSeed;
  const isDrawn = hasDrawRecord && members.some((m) => m.slot != null);
  const recipient = recipientForRound(members, round);
  const collected = paymentsForRound(payments, round).length;

  // Client mirror of the server's add/remove matrix (UX-25). Used to disable
  // the affordance AND to name the reason — an action that is simply missing
  // teaches the organiser nothing. The RPCs re-check every rule.
  const addCheck = canAddCommitteeMember(committee, members);
  const removeCheckFor = (memberId: string) => canRemoveCommitteeMember(committee, members, payments, memberId);

  const handleAddMember = () => memberGuard.run(async () => {
    const name = newMemberName.trim();
    if (!name) return;
    setRosterBusy(true);
    try {
      await addMember(committee.id, { name, phone: newMemberPhone.trim() || null });
      toast.show({ type: 'success', title: t('kameti_member_added') });
      setNewMemberName('');
      setNewMemberPhone('');
      setAddingMember(false);
    } catch (err) {
      toast.show({ type: 'error', title: t(committeeErrorKey(err)) });
    } finally {
      setRosterBusy(false);
    }
  });

  const handleRemoveMember = (m: CommitteeMember) => memberGuard.run(async () => {
    const check = removeCheckFor(m.id);
    if (!check.ok) {
      toast.show({ type: 'error', title: t(REMOVE_BLOCK_KEY[check.reason]) });
      return;
    }
    const ok = await confirmDestructive({
      title: t('kameti_remove_member'),
      description: t('kameti_remove_member_confirm').replace('{name}', m.name),
      confirmLabel: t('kameti_remove_member'),
    });
    if (!ok) return;
    setRosterBusy(true);
    try {
      await removeMember(committee.id, m.id);
      toast.show({ type: 'success', title: t('kameti_member_removed') });
    } catch (err) {
      toast.show({ type: 'error', title: t(committeeErrorKey(err)) });
    } finally {
      setRosterBusy(false);
    }
  });

  // Edit (name / WhatsApp number) + remove (from the kameti). Remove only
  // appears where the server would actually accept it, so the organiser is
  // never offered an action that comes back as a refusal.
  const memberActions = (m: CommitteeMember) => (
    <>
      <button onClick={() => openEditMember(m)}
        className="w-8 h-8 rounded-[10px] flex items-center justify-center shrink-0 text-ink-500 active:bg-cream-soft transition-colors"
        aria-label={t('kameti_edit_member')}>
        <Glyph name="edit" size={14} />
      </button>
      {removeCheckFor(m.id).ok && (
        <button onClick={() => handleRemoveMember(m)} disabled={rosterBusy}
          className="w-8 h-8 -mr-1.5 rounded-[10px] flex items-center justify-center shrink-0 text-ink-500 active:bg-pay-50 active:text-pay-text disabled:opacity-30 transition-colors"
          aria-label={t('kameti_remove_member')}>
          <UserMinus size={14} strokeWidth={2.4} />
        </button>
      )}
    </>
  );

  // The "add a member" affordance, with its reason when it is unavailable.
  // Rendered under both rosters (the pre-draw one and the collection list) —
  // for a FIXED kameti the collection list IS the roster, and that is exactly
  // where a late joiner is remembered.
  const addMemberRow = (
    <div className="mt-3">
      {addCheck.ok ? (
        <button type="button" onClick={() => setAddingMember(true)}
          className="m-btn m-btn-plain w-full text-[12.5px] text-warn-700">
          <Glyph name="user-plus" size={15} tone="gold" /> {t('kameti_add_member')}
        </button>
      ) : (
        <p className="text-[10.5px] text-ink-400 leading-relaxed px-1">{t(ADD_BLOCK_KEY[addCheck.reason])}</p>
      )}
    </div>
  );

  const handleDraw = async () => {
    // Belt and braces around the server's ALREADY_DRAWN guard: never even ask
    // if this device already knows an order exists.
    if (drawing || hasDrawRecord) return;
    const ok = await confirmDestructive({
      title: t('kameti_draw_confirm_title'),
      description: t('kameti_draw_confirm_body'),
      confirmLabel: t('kameti_draw_confirm_cta'),
      cancelLabel: t('cancel'),
      tone: 'warning',
    });
    if (!ok) return;
    setDrawing(true);
    const start = Date.now();
    try {
      await runBallot(committee.id);
      // Hold the rolling-dice animation for a minimum beat so the draw feels
      // like an event, not an instant jump.
      const elapsed = Date.now() - start;
      if (elapsed < 1900) await new Promise((r) => setTimeout(r, 1900 - elapsed));
      toast.show({ type: 'success', title: t('kameti_draw_done') });
    } catch (err) {
      // ALREADY_DRAWN is not a failure to apologise for — the store has already
      // resynced the real order, so show it as information.
      const drawnElsewhere = err instanceof CommitteeDrawError && err.code === 'ALREADY_DRAWN';
      toast.show({ type: drawnElsewhere ? 'info' : 'error', title: t(committeeErrorKey(err)) });
    } finally {
      setDrawing(false);
    }
  };

  const remind = (name: string, phone: string | null | undefined) => {
    const text = t('kameti_reminder_text')
      .replace('{name}', name)
      .replace('{committee}', committee.name)
      .replace('{amount}', formatMoney(committee.contributionAmount, committee.currency));
    window.open(buildWhatsAppUrl(phone ?? null, text), '_blank');
  };

  const shareStatement = async () => {
    const lines: string[] = [];
    lines.push(`${committee.name} — ${formatMoney(committee.contributionAmount, committee.currency)} ${t(`kameti_cadence_${committee.cadence}` as 'kameti_cadence_monthly')}`);
    lines.push(`${t('kameti_pool')}: ${formatMoney(pool, committee.currency)} · ${members.length} ${t('kameti_members').toLowerCase()}`);
    lines.push('');
    lines.push(`${t('kameti_schedule')}:`);
    for (const row of buildSchedule(committee, members)) {
      const m = members.find((x) => x.id === row.recipientId);
      const got = m?.payoutReceivedAt ? ' ✓' : '';
      lines.push(`  ${row.round}. ${m?.name ?? '—'} — ${format(row.date, 'd MMM yyyy')}${got}`);
    }
    lines.push('');
    lines.push(`${t('kameti_round_of').replace('{r}', String(round)).replace('{n}', String(committee.totalRounds))} · ${t('kameti_collected').replace('{paid}', String(collected)).replace('{total}', String(members.length))}`);
    lines.push('');
    lines.push(`🔒 ${t('kameti_no_custody')}`);
    const text = lines.join('\n');
    if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
      try { await navigator.share({ text }); return; } catch { /* fall through */ }
    }
    window.open(buildWhatsAppUrl(null, text), '_blank');
  };

  const handleDelete = async () => {
    const ok = await confirmDestructive({ title: t('kameti_delete'), description: t('kameti_delete_confirm'), confirmLabel: t('kameti_delete') });
    if (!ok) return;
    await deleteCommittee(committee.id);
    toast.show({ type: 'success', title: t('kameti_deleted') });
    navigate('/kameti', { replace: true });
  };

  return (
    <main className="min-h-dvh bg-cream-bg pb-28">
      <PageHeader title={committee.emoji ? `${committee.emoji} ${committee.name}` : committee.name} back />

      {/* Rolling-dice overlay while the ballot draws — turns the draw into a
          little moment of suspense. */}
      {drawing && (
        <div className="fixed inset-0 z-[70] bg-navy-900/85 backdrop-blur-sm flex flex-col items-center justify-center px-8 text-center">
          <span className="text-[64px] leading-none animate-dice inline-block" aria-hidden>🎲</span>
          <p className="text-white text-[15px] font-semibold mt-7">{t('kameti_drawing')}</p>
          <p className="text-white/70 text-[12px] mt-2 max-w-[280px] leading-relaxed">{t('kameti_draw_fair_note')}</p>
        </div>
      )}

      <div className="px-5 pt-3 space-y-4">
        {/* Pool + round + trust badges. Kameti's gold material; informational,
            so a card and never a tile. The pool figure is the page's one
            extruded numeral. */}
        <div className="m-card m-gold m-card-feature p-5">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="m-label">{t('kameti_pool')}</p>
              <div className="mt-2">
                <MoneyDisplay amount={pool} currency={committee.currency} size={30} extrude="gold" />
              </div>
            </div>
            <p className="text-[12px] font-medium text-ink-600 tabular-nums shrink-0 mt-0.5">{t('kameti_round_of').replace('{r}', String(liveRound)).replace('{n}', String(committee.totalRounds))}</p>
          </div>
          <p className="text-[11.5px] text-ink-600 mt-2.5 tabular-nums">
            {formatMoney(committee.contributionAmount, committee.currency)} × {members.length} {t(`kameti_cadence_${committee.cadence}` as 'kameti_cadence_monthly').toLowerCase()}
          </p>
          <div className="flex flex-wrap gap-1.5 mt-3">
            <span className="m-chip m-chip-receive">
              <Glyph name="shield" size={11} strokeWidth={2.6} /> {t('kameti_no_custody')}
            </span>
            <span className="m-chip m-chip-receive">{t('kameti_sood_free')}</span>
          </div>
        </div>

        {/* Undrawn ballot → draw CTA. Gated on hasDrawRecord (not isDrawn) so
            the button disappears the instant the server records a draw, even if
            the member slots haven't been re-read yet. */}
        {!hasDrawRecord && (
          <div className="m-card p-5 text-center">
            <Dices size={26} strokeWidth={2.4} className="text-glyph-gold mx-auto m-glyph-extrude" aria-hidden />
            <p className="text-[14px] font-semibold text-ink-900 mt-2.5">{t('kameti_undrawn')}</p>
            <p className="text-[11.5px] text-ink-600 mt-1 leading-relaxed">{t('kameti_method_ballot_desc')}</p>
            <button onClick={handleDraw} disabled={drawing} className="m-btn m-btn-primary mt-4 w-full text-[13.5px]">
              {drawing ? t('kameti_drawing') : t('kameti_run_ballot')}
            </button>
          </div>
        )}

        {/* Draw recorded on the server but the slots aren't in this device's
            copy yet (stale tab, or a draw run elsewhere). Never offer a redraw
            here — say it's locked and let the refresh land. */}
        {hasDrawRecord && !isDrawn && (
          <div className="m-card p-4 flex items-start gap-3">
            <div className="m-ctl w-8 h-8 rounded-[10px] flex items-center justify-center shrink-0" aria-hidden>
              <Glyph name="lock" size={15} tone="neutral" />
            </div>
            <p className="text-[11.5px] text-ink-600 leading-relaxed self-center">{t('kameti_draw_locked')}</p>
          </div>
        )}

        {/* The roster, BEFORE the ballot is drawn. Everything below this point
            is gated on `isDrawn`, so an undrawn ballot used to show no member
            list at all — leaving the organiser no way to fix a name or drop
            someone who never joined except deleting the kameti (audit UX-25).
            This is also the last moment adding or removing is free. */}
        {!hasDrawRecord && (
          <div>
            <h2 className="m-label mb-2.5">{t('kameti_roster')}</h2>
            <div className="m-card overflow-hidden divide-y divide-cream-hairline">
              {members.map((m) => (
                <div key={m.id} className="flex items-center gap-3 px-3.5 py-3">
                  {/* Only the organiser can open this page (owner-only rows),
                      so the organiser row IS the signed-in user: violet avatar. */}
                  <UserAvatar name={m.name} size={34} self={m.isOrganizer} />
                  <div className="flex-1 min-w-0">
                    <p className="text-[13.5px] font-medium text-ink-900 flex items-center gap-1.5 min-w-0">
                      <span className="truncate">{m.name}</span>
                      {m.isOrganizer && <Crown size={12} strokeWidth={2.4} className="text-glyph-gold shrink-0" aria-label={t('kameti_you_organizer')} />}
                    </p>
                    {m.phone && <p className="text-[10.5px] text-ink-400 tabular-nums mt-0.5">{m.phone}</p>}
                  </div>
                  {memberActions(m)}
                </div>
              ))}
            </div>
            {addMemberRow}
          </div>
        )}

        {/* Round navigator */}
        {isDrawn && (
          <div className="flex items-center justify-between">
            <button onClick={() => setViewRound(Math.max(1, round - 1))} disabled={round <= 1} className="nav-icon-button disabled:opacity-30" aria-label={t('a11y_prev_round')}>
              <Glyph name="chevron-left" size={16} className="text-ink-700" />
            </button>
            <div className="text-center">
              <p className="text-[14px] font-semibold text-ink-900 tabular-nums">{t('kameti_round_of').replace('{r}', String(round)).replace('{n}', String(committee.totalRounds))}</p>
              <p className="text-[10.5px] text-ink-500 tabular-nums mt-0.5">{format(roundDate(committee.startDate, committee.cadence, round), 'd MMM yyyy')}</p>
            </div>
            <button onClick={() => setViewRound(Math.min(committee.totalRounds, round + 1))} disabled={round >= committee.totalRounds} className="nav-icon-button disabled:opacity-30" aria-label={t('a11y_next_round')}>
              <Glyph name="chevron-right" size={16} className="text-ink-700" />
            </button>
          </div>
        )}

        {/* This round's recipient (baari). The winner moment: gold material +
            the extruded trophy glyph — the one place in the kameti flow that
            should feel like a prize. */}
        {isDrawn && recipient && (
          <div className="m-card m-gold p-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 flex items-center justify-center shrink-0" aria-hidden>
                <Glyph name="trophy" tone="gold" size={26} extrude />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-[10px] font-semibold text-warn-700 uppercase tracking-[0.1em]">{t('kameti_baari_label')}</p>
                <p className="text-[15px] font-semibold text-ink-900 truncate mt-0.5">{recipient.name}</p>
              </div>
              <button
                onClick={async () => {
                  const next = !recipient.payoutReceivedAt;
                  await confirmPayout(recipient.id, next);
                  // On marking received, offer a payout slip to send the
                  // recipient. Un-marking does nothing.
                  //
                  // The slip no longer carries a witness URL (audit M19 /
                  // docs/trust-and-safety.md §4.5 item 7): minting one is now a
                  // ROTATE, which would silently kill whatever link the
                  // organiser had already shared with the group — every time
                  // they ticked a payout. A printed capability URL that expires
                  // in 90 days is stale paper anyway. The organiser shares the
                  // link deliberately, from the Witness link card below.
                  if (next) setSlip({ recipient, round });
                }}
                className={`m-btn shrink-0 min-h-[38px] px-3.5 py-2 rounded-[12px] text-[11.5px] gap-1.5 ${recipient.payoutReceivedAt ? 'm-btn-green' : 'm-btn-primary'}`}
              >
                <Glyph name="check" size={13} strokeWidth={3} /> {recipient.payoutReceivedAt ? t('kameti_received') : t('kameti_mark_received')}
              </button>
            </div>
          </div>
        )}

        {/* Provably-fair draw — verify the ballot wasn't rigged */}
        {isDrawn && <CommitteeVerifyDraw committee={committee} members={members} />}

        {/* This round's collection list */}
        {isDrawn && (
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <h2 className="m-label">{t('kameti_this_round')}</h2>
              <span className="text-[11px] font-semibold text-ink-700 tabular-nums">{t('kameti_collected').replace('{paid}', String(collected)).replace('{total}', String(members.length))}</span>
            </div>
            <p className="text-[11px] text-ink-500 mb-2.5">{t('kameti_tap_mark_paid')}</p>
            <div className="m-card overflow-hidden divide-y divide-cream-hairline">
              {members.map((m) => {
                const paid = hasPaid(payments, m.id, round);
                const kind = m.slot ? slotKind(m.slot, committee.totalRounds) : 'mid';
                // Rounds before the live round this member never paid — otherwise
                // a missed month silently vanishes when the round rolls over.
                const missed = liveRound > 1
                  ? Array.from({ length: liveRound - 1 }, (_, i) => i + 1).filter((r) => !hasPaid(payments, m.id, r)).length
                  : 0;
                return (
                  <div key={m.id} className="flex items-center gap-2.5 px-3.5 py-3">
                    {/* Paid toggle: a sunken empty well until paid, then the
                        green gradient dot with a check. */}
                    <button
                      onClick={() => setPaid(committee.id, m.id, round, !paid)}
                      className={`w-[26px] h-[26px] rounded-full flex items-center justify-center shrink-0 transition-transform active:scale-95 ${paid ? 'm-stat-dot m-stat-dot-receive' : 'm-inset border border-field-border'}`}
                      aria-pressed={paid}
                      aria-label={paid ? t('kameti_paid_badge') : t('kameti_unpaid_badge')}
                    >
                      {paid && <Glyph name="check" size={13} strokeWidth={3} />}
                    </button>
                    <UserAvatar name={m.name} size={34} self={m.isOrganizer} />
                    <div className="flex-1 min-w-0">
                      <p className="text-[13.5px] font-medium text-ink-900 flex items-center gap-1.5 min-w-0">
                        <span className="truncate">{m.name}</span>
                        {m.isOrganizer && <Crown size={12} strokeWidth={2.4} className="text-glyph-gold shrink-0" aria-label={t('kameti_you_organizer')} />}
                        {m.slot != null && <span className="text-[10px] text-ink-400 font-semibold shrink-0 tabular-nums">#{m.slot}</span>}
                      </p>
                      <div className="flex items-center gap-1.5 mt-1 min-w-0">
                        <span className={`m-chip shrink-0 ${paid ? 'm-chip-receive' : 'm-chip-pay'}`}>
                          {paid ? t('kameti_paid_badge') : t('kameti_unpaid_badge')}
                        </span>
                        {m.slot != null && (kind === 'early' || kind === 'late') && (
                          <span className="text-[10px] text-ink-400 truncate">{t(kind === 'early' ? 'kameti_slot_early' : 'kameti_slot_late')}</span>
                        )}
                      </div>
                      {missed > 0 && (
                        <p className="text-[10.5px] font-semibold text-pay-text mt-1">
                          {t('kameti_arrears').replace('{amount}', formatMoney(missed * committee.contributionAmount, committee.currency)).replace('{n}', String(missed))}
                        </p>
                      )}
                    </div>
                    {!paid && (
                      <button onClick={() => remind(m.name, m.phone)}
                        className="m-ctl w-8 h-8 rounded-[10px] flex items-center justify-center shrink-0"
                        aria-label={t('kameti_remind')}>
                        <Glyph name="whatsapp" size={15} tone="green" />
                      </button>
                    )}
                    {memberActions(m)}
                  </div>
                );
              })}
            </div>
            {addMemberRow}
          </div>
        )}

        {/* Full baari schedule — the organizer's most basic question ("kis
            mahine kis ki baari hai?") answered at a glance, instead of only one
            round at a time behind the chevrons. Mirrors the witness page. */}
        {isDrawn && (
          <div>
            <h2 className="m-label mb-2.5">{t('kameti_schedule')}</h2>
            <div className="m-card overflow-hidden divide-y divide-cream-hairline">
              {Array.from({ length: committee.totalRounds }, (_, i) => i + 1).map((r) => {
                const rec = recipientForRound(members, r);
                return (
                  <button
                    key={r}
                    onClick={() => setViewRound(r)}
                    className={`w-full flex items-center gap-3 px-3.5 py-2.5 text-left transition-colors ${r === round ? 'bg-warn-50' : 'active:bg-cream-soft'}`}
                  >
                    <span className={`text-[11px] font-bold tabular-nums w-5 ${r === round ? 'text-warn-700' : 'text-ink-400'}`}>{r}</span>
                    <span className="flex-1 text-[12.5px] text-ink-900 truncate">{rec?.name ?? '—'}</span>
                    {rec?.payoutReceivedAt && <Glyph name="check" size={13} tone="green" strokeWidth={3} />}
                    <span className="text-[10.5px] text-ink-400 tabular-nums shrink-0">{format(roundDate(committee.startDate, committee.cadence, r), 'd MMM')}</span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Witness link — create / replace / stop sharing, plus the
            initials-only privacy toggle. Replaces the old one-tap "Share
            witness link" button, which minted a never-expiring plaintext token
            on this device (audit M19 / UX-24). */}
        <CommitteeWitnessLink committee={committee} members={members} />

        {/* Footer actions. "Edit" is organiser-only by construction: committees
            are owner-only rows (committees.sql RLS), so the only person who can
            open this page IS the organiser — and update_committee refuses
            anyone else with NOT_ORGANISER regardless. */}
        <div className="flex gap-2.5">
          <button onClick={() => setEditingCommittee(true)} className="m-btn m-btn-plain flex-1 px-3 text-[12.5px] leading-tight text-center">
            <Glyph name="sliders" size={15} /> {t('kameti_edit')}
          </button>
          <button onClick={shareStatement} className="m-btn m-btn-plain flex-1 px-3 text-[12.5px] leading-tight text-center">
            <Glyph name="share" size={15} /> {t('kameti_share_statement')}
          </button>
          <button onClick={handleDelete} className="m-btn m-btn-danger px-4" aria-label={t('kameti_delete')}>
            <Glyph name="trash" size={16} />
          </button>
        </div>
      </div>

      {slip && (
        <KametiPayoutSlipSheet
          open={!!slip}
          onClose={() => setSlip(null)}
          committee={committee}
          recipient={slip.recipient}
          round={slip.round}
          payments={payments}
          witnessUrl={slip.witnessUrl}
        />
      )}

      <EditCommitteeSheet
        open={editingCommittee}
        onClose={() => setEditingCommittee(false)}
        committee={committee}
        members={members}
        payments={payments}
      />

      <Modal
        open={addingMember}
        onClose={() => setAddingMember(false)}
        title={t('kameti_member_add_title')}
        footer={
          <button
            onClick={handleAddMember}
            disabled={rosterBusy || !newMemberName.trim()}
            className="cta-primary"
          >
            {t('kameti_add_member')}
          </button>
        }
      >
        <div className="space-y-4">
          {/* Adding a member adds a ROUND: say so before the tap, not after. */}
          <div className="m-card m-gold p-3.5 flex items-start gap-2.5">
            <Glyph name="info" size={15} tone="gold" className="mt-0.5" />
            <p className="text-[11.5px] text-ink-700 leading-relaxed">{t('kameti_member_add_note')}</p>
          </div>
          <label className="block">
            <span className="form-label">{t('kameti_member_name')}</span>
            <input value={newMemberName} onChange={(e) => setNewMemberName(e.target.value)} maxLength={60}
              autoCapitalize="words" className="input-field" />
          </label>
          <label className="block">
            <span className="form-label">{t('kameti_member_phone')}</span>
            <input value={newMemberPhone} onChange={(e) => setNewMemberPhone(e.target.value)} inputMode="tel" placeholder="+92…"
              className="input-field tabular-nums" />
          </label>
        </div>
      </Modal>

      <Modal
        open={!!editMember}
        onClose={() => setEditMember(null)}
        title={t('kameti_edit_member')}
        footer={
          <button
            onClick={saveEditMember}
            disabled={!editName.trim()}
            className="cta-primary"
          >
            {t('cat_save')}
          </button>
        }
      >
        <div className="space-y-4">
          <label className="block">
            <span className="form-label">{t('kameti_member_name')}</span>
            <input value={editName} onChange={(e) => setEditName(e.target.value)} autoFocus
              autoCapitalize="words" className="input-field" />
          </label>
          <label className="block">
            <span className="form-label">{t('kameti_member_phone')}</span>
            <input value={editPhone} onChange={(e) => setEditPhone(e.target.value)} inputMode="tel" placeholder="+92…"
              className="input-field tabular-nums" />
          </label>
        </div>
      </Modal>
    </main>
  );
}
