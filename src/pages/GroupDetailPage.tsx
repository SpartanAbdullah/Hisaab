import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
// Lucide only where the 3c set has no glyph (restore, remove-person, crown,
// bell-off) — drawn at the glyph weight (2.4) and in glyph tones.
import { ArchiveRestore, UserMinus, Crown, BellOff, Receipt, UserPlus, Clock3 } from 'lucide-react';
import { NavyHero, TopBar } from '../components/NavyHero';
import { Modal } from '../components/Modal';
import { Glyph } from '../components/Glyph';
import { UserAvatar } from '../components/UserAvatar';
import { EmptyState } from '../components/EmptyState';
import { ListSkeleton } from '../components/ListSkeleton';
import type { GlyphName } from '../lib/glyphs';
import { skeletonDelay } from '../lib/material';
import { useSplitStore } from '../stores/splitStore';
import { useNotificationStore } from '../stores/notificationStore';
import { AddGroupExpenseModal } from './AddGroupExpenseModal';
import { EditGroupExpenseModal } from './EditGroupExpenseModal';
import { SettleUpModal } from './SettleUpModal';
import { GroupSettleUpModal } from './GroupSettleUpModal';
import { GroupInviteModal } from '../components/GroupInviteModal';
import { ProgressRing } from '../components/ProgressRing';
import { PageErrorState } from '../components/PageErrorState';
import { confirmDestructive } from '../components/ConfirmDestructiveSheet';
import { VerifiedBadge } from '../components/VerifiedBadge';
import { EditHistorySheet } from '../components/EditHistorySheet';
import { readGroupGuardFailure } from '../lib/groupGuardErrors';
import { buildGuestInviteText, isGuestMember } from '../lib/groupGuests';
import {
  adminCandidates,
  canManageGroup,
  groupSupportsAdmins,
  isGroupAdmin,
  isGroupOwner,
  setGroupAdminFailureCopy,
  transferCandidates as eligibleNewOwners,
} from '../lib/groupRoles';
import { copyText, shareText } from '../lib/clipboard';
import { isNativeRuntime } from '../lib/runtime';
import { buildWhatsAppUrl } from '../lib/whatsappReminder';
import { useT } from '../lib/i18n';
import { formatMoney } from '../lib/constants';
import { useToast } from '../components/Toast';
import { subscribeToGroupMembers } from '../lib/realtime';
import { useBlockStore } from '../stores/blockStore';
import { BlockReportSheet, type BlockReportMode } from '../components/BlockReportSheet';
import { useSubmitGuard } from '../lib/useSubmitGuard';
import { useAsyncLoad } from '../hooks/useAsyncLoad';
import type { SplitGroup, GroupExpense, GroupEvent, GroupMember, GroupSettlement } from '../db';
import type { SettlePlans } from '../lib/settleUpMinimize';
import type { EditHistoryTable } from '../lib/editHistory';

// Compact "May 26, 2026 · 11:39 PM" date format for activity tiles. Sidesteps
// the noisy `toLocaleString()` default ("5/26/2026, 11:39:45 PM") so users can
// scan a date column without parsing slash-separated numerics + seconds.
function formatActivityTime(iso: string): string {
  const d = new Date(iso);
  const date = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return `${date} · ${time}`;
}

// Header control on the blue hero: the 36px raised 1d button (TopBar's back
// button and the bell use the same recipe), with a 44px+ hit area.
const HERO_CTL =
  "m-ctl relative w-9 h-9 flex items-center justify-center shrink-0 before:absolute before:-inset-1 before:content-['']";

// Activity-row icon square: a tinted 1d card per semantic tone (the glyph is
// drawn in the same tone), a raised neutral control for the quiet events.
type ActivityTone = 'green' | 'violet' | 'coral' | 'blue' | 'neutral';
const ACTIVITY_SQUARE: Record<ActivityTone, string> = {
  green: 'm-card m-mint',
  violet: 'm-card m-violet',
  coral: 'm-card m-coral',
  blue: 'm-card m-blue',
  neutral: 'm-ctl',
};
const ACTIVITY_GLYPH_PX = 17;
const activityGlyph = (name: GlyphName, tone: ActivityTone) => (
  <Glyph name={name} size={ACTIVITY_GLYPH_PX} tone={tone} />
);

interface ActivityDisplay {
  icon: ReactNode;
  tone: ActivityTone;
  title: string;
  titleClass?: string;
  subtitle?: string;
  note?: string;
  amount?: string;
  amountClass?: string;
  amountChange?: string;
}

// Maps a GroupEvent + payload to the visual props for its tile. Settlement
// events fall back to the settlements list to recover the note + amount,
// since the event payload only carries member ids and amount and we want
// to surface the "cash diya"-style settler note for context.
function getActivityDisplay(
  event: GroupEvent,
  settlements: GroupSettlement[],
  group: SplitGroup,
  t: ReturnType<typeof useT>,
): ActivityDisplay {
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  const memberName = (id: string | undefined): string => {
    if (!id) return '?';
    return group.members.find(m => m.id === id)?.name ?? '?';
  };

  // Written by set_group_admin (supabase-migration-group-admins.sql §5e).
  // Payload: { memberId, memberProfileId, memberName, isAdmin, actorName }.
  // Matched on the raw string: GroupEventType (src/db/types.ts) predates it.
  const rawType = event.eventType as string;
  if (rawType === 'member_admin_granted' || rawType === 'member_admin_revoked') {
    const granted = rawType === 'member_admin_granted';
    const memberId = typeof payload.memberId === 'string' ? payload.memberId : undefined;
    const fallbackName = typeof payload.memberName === 'string' ? payload.memberName : event.summary;
    return {
      icon: activityGlyph(granted ? 'shield-check' : 'shield-off', granted ? 'blue' : 'neutral'),
      tone: granted ? 'blue' : 'neutral',
      title: group.members.find(m => m.id === memberId)?.name ?? fallbackName,
      subtitle: t(granted ? 'gev_admin_granted' : 'gev_admin_revoked'),
    };
  }

  switch (event.eventType) {
    case 'settlement_added': {
      const settlement = settlements.find(s => s.id === event.entityId);
      const fromId = typeof payload.fromMember === 'string' ? payload.fromMember : settlement?.fromMember;
      const toId = typeof payload.toMember === 'string' ? payload.toMember : settlement?.toMember;
      const amount = typeof payload.amount === 'number' ? payload.amount : settlement?.amount ?? 0;
      return {
        icon: activityGlyph('check', 'green'),
        tone: 'green',
        title: `${memberName(fromId)} → ${memberName(toId)}`,
        subtitle: t('gev_settled_up'),
        note: settlement?.note || undefined,
        amount: formatMoney(amount, group.currency),
        amountClass: 'text-receive-text',
      };
    }
    case 'settlement_deleted': {
      const fromId = typeof payload.fromMember === 'string' ? payload.fromMember : undefined;
      const toId = typeof payload.toMember === 'string' ? payload.toMember : undefined;
      const amount = typeof payload.amount === 'number' ? payload.amount : 0;
      return {
        icon: activityGlyph('undo', 'violet'),
        tone: 'violet',
        title: `${memberName(fromId)} → ${memberName(toId)}`,
        subtitle: t('gev_settlement_removed'),
        amount: formatMoney(amount, group.currency),
        amountClass: 'text-warn-600',
      };
    }
    case 'expense_added': {
      const description = typeof payload.description === 'string' ? payload.description : event.summary;
      const amount = typeof payload.amount === 'number' ? payload.amount : 0;
      const paidById = typeof payload.paidBy === 'string' ? payload.paidBy : undefined;
      const actorName = paidById ? memberName(paidById) : '';
      return {
        icon: activityGlyph('receipt', 'blue'),
        tone: 'blue',
        title: description,
        subtitle: actorName ? t('gev_expense_added_by').replace('{name}', actorName) : t('gev_expense_added'),
        amount: amount > 0 ? formatMoney(amount, group.currency) : undefined,
        amountClass: 'text-ink-900',
      };
    }
    case 'expense_updated': {
      const after = (payload.after ?? {}) as { description?: string; amount?: number };
      const before = (payload.before ?? {}) as { description?: string; amount?: number };
      const description = after.description ?? before.description ?? event.summary;
      const amountChanged = typeof before.amount === 'number' && typeof after.amount === 'number' && Math.abs(before.amount - after.amount) > 0.001;
      return {
        icon: activityGlyph('edit', 'violet'),
        tone: 'violet',
        title: description,
        subtitle: t('gev_expense_updated'),
        amount: typeof after.amount === 'number' && after.amount > 0 ? formatMoney(after.amount, group.currency) : undefined,
        amountClass: 'text-ink-900',
        amountChange: amountChanged
          ? `${formatMoney(before.amount as number, group.currency)} → ${formatMoney(after.amount as number, group.currency)}`
          : undefined,
      };
    }
    case 'expense_deleted': {
      const description = typeof payload.description === 'string' ? payload.description : event.summary;
      const amount = typeof payload.amount === 'number' ? payload.amount : 0;
      return {
        icon: activityGlyph('trash', 'coral'),
        tone: 'coral',
        title: description,
        titleClass: 'line-through text-ink-500',
        subtitle: t('gev_expense_deleted'),
        amount: amount > 0 ? formatMoney(amount, group.currency) : undefined,
        amountClass: 'text-ink-500 line-through',
      };
    }
    case 'member_joined':
      return {
        icon: activityGlyph('user-plus', 'blue'),
        tone: 'blue',
        title: event.summary,
        subtitle: t('gev_member_joined'),
      };
    case 'member_invited':
      return {
        icon: activityGlyph('mail', 'blue'),
        tone: 'blue',
        title: event.summary,
        subtitle: t('gev_member_invited'),
      };
    case 'guest_added':
      // add_group_guest, supabase-migration-p2-guest-members.sql §4a. Written
      // with an EMPTY recipient list on purpose: adding a guest is a group
      // FACT that belongs in the shared feed, but it is nobody's push
      // notification. Payload: { memberId, displayName, groupName, … }
      return {
        icon: activityGlyph('user-plus', 'neutral'),
        tone: 'neutral',
        title: event.summary,
        subtitle: t('gev_guest_added'),
      };
    case 'group_created':
      return {
        icon: activityGlyph('sparkles', 'violet'),
        tone: 'violet',
        title: event.summary,
        subtitle: t('gev_group_created'),
      };
    // ── Lifecycle events written by the audit-2026-09 migrations ────────────
    // All four carry a server-composed `summary`, so the title is that
    // sentence and the subtitle is the localized event label.
    case 'group_archived':
      // archive_group, group-deletion-guard.sql §6b.
      // Payload: { groupId, groupName, currency, actorName, archivedAt }
      return {
        icon: activityGlyph('archive', 'neutral'),
        tone: 'neutral',
        title: event.summary,
        subtitle: t('gev_group_archived'),
      };
    case 'group_unarchived':
      // unarchive_group, §6c. Payload: { …, unarchivedAt }
      return {
        icon: <ArchiveRestore size={ACTIVITY_GLYPH_PX} strokeWidth={2.4} className="text-glyph-green" />,
        tone: 'green',
        title: event.summary,
        subtitle: t('gev_group_unarchived'),
      };
    case 'member_account_deleted':
      // delete_current_user, account-deletion.sql §4b. Payload:
      // { memberId, displayName, expensesRetained, settlementsRetained, deletedAt }
      // The retained counts matter: they are the reassurance that this
      // member's money records did NOT disappear with their account.
      return (() => {
        const displayName = typeof payload.displayName === 'string' ? payload.displayName : '';
        const expensesRetained = Number(payload.expensesRetained ?? 0);
        const settlementsRetained = Number(payload.settlementsRetained ?? 0);
        const retained = expensesRetained + settlementsRetained;
        return {
          icon: <UserMinus size={ACTIVITY_GLYPH_PX} strokeWidth={2.4} className="text-glyph-violet" />,
          tone: 'violet' as const,
          title: displayName || event.summary,
          subtitle: t('gev_member_account_deleted'),
          note: retained > 0 ? event.summary : undefined,
        };
      })();
    case 'group_ownership_transferred':
      // transfer_group_ownership, account-deletion.sql §5. Payload:
      // { newOwnerMemberId, newOwnerProfileId, previousOwnerMemberId }
      return (() => {
        const newOwnerId = typeof payload.newOwnerMemberId === 'string' ? payload.newOwnerMemberId : undefined;
        return {
          icon: <Crown size={ACTIVITY_GLYPH_PX} strokeWidth={2.4} className="text-glyph-violet" />,
          tone: 'violet' as const,
          title: newOwnerId ? memberName(newOwnerId) : event.summary,
          subtitle: t('gev_ownership_transferred'),
        };
      })();
    default:
      return {
        icon: activityGlyph('clock', 'neutral'),
        tone: 'neutral',
        title: event.summary,
      };
  }
}

// Human-readable member status, replacing the raw enum ("connected",
// "invited", "guest"…) that leaked into the UI. Owner wins over status.
// Takes the active translator so the short status words localize.
//
// GUESTS ARE CHECKED FIRST, and it matters: a guest seat carries
// status='connected' — that is precisely what makes them a real ledger
// participant (audit G6 / O4) — so a status-only branch would label the one
// person who is NOT on Hisaab as "on Hisaab".
//
// Admins (supabase-migration-group-admins.sql) say "admin" — like the owner,
// the role is the more useful fact: an admin is on Hisaab by definition.
type MemberBadgeFields = Pick<GroupMember, 'profileId' | 'status' | 'isOwner' | 'role' | 'isAdmin'>;

function memberStatusLabel(t: ReturnType<typeof useT>, member: MemberBadgeFields): string {
  if (isGroupOwner(member)) return t('member_owner');
  if (isGroupAdmin(member)) return t('member_admin');
  if (isGuestMember(member)) return t('guest_tag');
  if (member.status === 'connected') return t('member_on_app');
  if (member.status === 'invited') return t('member_invited');
  return t('member_not_on_app');
}

// Status halo around a member's avatar. Every person wears the same navy 1d
// avatar; the 2px ring carries the status, decoded by the legend in the hero:
// on-app green, invited gold (waiting on them — the same amber as the invite
// sheet's chip), a guest and everyone else (declined, left) a neutral ring. The owner and every co-admin — the people who
// run the group — get the group's blue accent. Glyph tokens are ≥3:1
// on the sheet in both themes, and the hero re-scopes them to their dark
// values, so the same ring reads on the hero and on the balances tab.
function memberStatusRing(member: MemberBadgeFields, onHero: boolean) {
  if (isGroupAdmin(member)) return 'ring-glyph-blue';
  if (isGuestMember(member)) return onHero ? 'ring-white/30' : 'ring-field-border';
  if (member.status === 'connected') return 'ring-glyph-green';
  if (member.status === 'invited') return 'ring-glyph-gold';
  return onHero ? 'ring-white/30' : 'ring-field-border';
}

function MemberAvatar({
  member,
  size,
  onHero = false,
}: {
  member: MemberBadgeFields & Pick<GroupMember, 'name'>;
  size: number;
  onHero?: boolean;
}) {
  return (
    <span className={`inline-flex shrink-0 rounded-full ring-2 ${memberStatusRing(member, onHero)}`}>
      <UserAvatar name={member.name} size={size} />
    </span>
  );
}

// Maps renameGroupGuest's status vocabulary to copy. NOT guestRpcFailureMessage
// (groupGuests.ts) — that helper's NOT_ALLOWED / INVALID_NAME copy is written
// for add/remove ("...can remove this seat", "up to 60 characters") and would
// read wrong here; guest_err_duplicate_name / guest_err_archived /
// guest_err_not_member are reused as-is since they're generic to both flows.
function renameFailureMessage(t: ReturnType<typeof useT>, status: string): string {
  if (status === 'DUPLICATE_NAME') return t('guest_err_duplicate_name');
  if (status === 'INVALID_NAME') return t('guest_err_rename_invalid');
  if (status === 'GROUP_ARCHIVED') return t('guest_err_archived');
  if (status === 'NOT_ACTIVE_MEMBER') return t('guest_err_not_member');
  return t('guest_err_generic');
}

export function GroupDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const t = useT();
  const toast = useToast();
  const { groups, getGroupExpenses, getSettlePlans, deleteGroup, leaveGroup, getGroupEvents, getSettlements, deleteSettlement, loadGroups, setGroupExpenseReconciled, archiveGroup, unarchiveGroup, transferGroupOwnership, setGroupAdmin, refreshJoinCode, createInvite, renameGroupGuest } = useSplitStore();
  const markGroupRead = useNotificationStore((state) => state.markGroupRead);
  // M5 per-group mute (docs/notifications.md §8.1). Silent and one-sided —
  // the group's activity/expense rows are still written for everyone, this
  // just stops notifications+push landing for the muted member.
  const mutes = useNotificationStore((state) => state.mutes);
  const setGroupMuted = useNotificationStore((state) => state.setGroupMuted);
  const groupMuted = mutes.mutedGroupIds instanceof Set && !!id && mutes.mutedGroupIds.has(id);
  const [mutingGroup, setMutingGroup] = useState(false);

  const [group, setGroup] = useState<SplitGroup | null>(null);
  const [expenses, setExpenses] = useState<GroupExpense[]>([]);
  const [events, setEvents] = useState<GroupEvent[]>([]);
  const [settlements, setSettlements] = useState<GroupSettlement[]>([]);
  const [debts, setDebts] = useState<{ from: string; fromName: string; to: string; toName: string; amount: number }[]>([]);
  const [pairwiseDebts, setPairwiseDebts] = useState<{ from: string; fromName: string; to: string; toName: string; amount: number }[]>([]);
  // Both settle-up plans (settleUpMinimize.ts) — direct + minimized, and which
  // minimized transfers reroute through someone the payer never split with.
  // `debts`/`pairwiseDebts` above mirror plans.minimized/direct.transfers so
  // the rest of the page (which predates the shared plan builder) is unchanged.
  const [plans, setPlans] = useState<SettlePlans | null>(null);
  // Default to RAW direct debts (no rerouting to strangers); "Simplify" is opt-in.
  const [simplify, setSimplify] = useState(false);
  // The toggle only makes a real offer when minimizing actually saves a
  // transfer and greedy didn't fall back to the direct plan — otherwise
  // "Simplify" would be a no-op button. `effectiveSimplify` guards every
  // render decision so a stale `simplify=true` from a previous group can't
  // silently apply to one with nothing to simplify.
  const canSimplify = !!plans && plans.transfersSaved > 0 && !plans.minimizedFellBackToDirect;
  const effectiveSimplify = simplify && canSimplify;
  const [tab, setTab] = useState<'expenses' | 'balances' | 'activity'>('expenses');
  const [showAddExpense, setShowAddExpense] = useState(false);
  const [showSettle, setShowSettle] = useState(false);
  const [showSettleShare, setShowSettleShare] = useState(false);
  const [showInvite, setShowInvite] = useState(false);
  const [editExpense, setEditExpense] = useState<GroupExpense | null>(null);
  // Who-changed-what (audit G5/O10). Which record's edit history sheet is
  // open, if any — set from the expense row's history icon or the activity
  // tab's "See what changed" link, and fed to the ONE sheet mounted below.
  const [historyFor, setHistoryFor] = useState<{ table: EditHistoryTable; id: string } | null>(null);
  const [savingReconciliationId, setSavingReconciliationId] = useState<string | null>(null);
  const [leaving, setLeaving] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [refreshingCode, setRefreshingCode] = useState(false);
  const [showTransfer, setShowTransfer] = useState(false);
  const [transferringMemberId, setTransferringMemberId] = useState<string | null>(null);
  // Co-admins (supabase-migration-group-admins.sql): the owner's sheet, and
  // the seat whose set_group_admin call is in flight.
  const [showAdmins, setShowAdmins] = useState(false);
  const [settingAdminId, setSettingAdminId] = useState<string | null>(null);
  const [showMenu, setShowMenu] = useState(false);
  // Trust & safety (audit M17). Blocking a fellow member does NOT remove them
  // from the group and does not hide their ledger rows — it stops notifications
  // between the two of you. The sheet's copy says exactly that; see
  // docs/trust-and-safety.md §6.2 for why a shared group is deliberately NOT
  // filtered (one member silently excluding another from a group they do not
  // own is a bigger abuse surface than the one it would close, and a failed
  // join would leak who is inside a group you cannot see).
  const blocks = useBlockStore((s) => s.blocks);
  const loadBlocks = useBlockStore((s) => s.loadBlocks);
  const unblockMember = useBlockStore((s) => s.unblock);
  const unblockGuard = useSubmitGuard();
  // Ref-backed entry re-check for the two guest-seat actions. Both mint an
  // invite row server-side, so a double tap would leave a second live token
  // pointing at the same seat.
  const guestInviteGuard = useSubmitGuard();
  const [invitingGuestId, setInvitingGuestId] = useState<string | null>(null);
  // Rename a guest seat (docs/guest-members.md §9.4) — owner or admin, gated
  // below on `canManage` next to the rename button itself.
  const renameGuard = useSubmitGuard();
  const [renamingGuest, setRenamingGuest] = useState<GroupMember | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [renaming, setRenaming] = useState(false);
  const [memberSafety, setMemberSafety] = useState<
    { mode: BlockReportMode; userId: string; name: string } | null
  >(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  // One-time member-status legend. Shown the first time a group has any
  // non-connected member; dismissal persists per-device so it doesn't nag.
  const [legendDismissed, setLegendDismissed] = useState(
    () => localStorage.getItem('hisaab_member_legend_dismissed') === '1',
  );
  const dismissLegend = () => {
    localStorage.setItem('hisaab_member_legend_dismissed', '1');
    setLegendDismissed(true);
  };

  // Dismiss the kebab menu when the user taps outside it.
  useEffect(() => {
    if (!showMenu) return;
    const onClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setShowMenu(false);
      }
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [showMenu]);

  useEffect(() => {
    const nextGroup = groups.find(item => item.id === id);
    if (nextGroup) setGroup(nextGroup);
  }, [groups, id]);

  const reload = useCallback(async () => {
    if (!id) return;
    // Deep-links to /group/:id may land here before the global groups list
    // is hydrated. Kick off loadGroups in parallel so the header renders.
    const needsGroups = useSplitStore.getState().groups.length === 0;
    const [, nextExpenses, nextPlans, nextEvents, nextSettlements] = await Promise.all([
      needsGroups ? loadGroups() : Promise.resolve(),
      getGroupExpenses(id),
      getSettlePlans(id),
      getGroupEvents(id),
      getSettlements(id),
    ]);
    setExpenses(nextExpenses);
    setPlans(nextPlans);
    setDebts(nextPlans?.minimized.transfers ?? []);
    setPairwiseDebts(nextPlans?.direct.transfers ?? []);
    setEvents(nextEvents);
    setSettlements(nextSettlements);
  }, [id, getGroupExpenses, getSettlePlans, getGroupEvents, getSettlements, loadGroups]);

  const { status: loadStatus, error: loadError, retry: retryLoad } = useAsyncLoad(reload);

  useEffect(() => {
    if (!id || loadStatus !== 'ready') return;
    void markGroupRead(id).catch(err => console.error('mark group read failed', err));
  }, [id, loadStatus, markGroupRead]);

  // Warm the block list so a member row shows Block or Unblock correctly on
  // first paint. Store-level freshness gate makes repeat mounts free.
  useEffect(() => { void loadBlocks(); }, [loadBlocks]);

  // While this page is open, subscribe to member changes on this group so
  // the header avatars and member count reflect joins/leaves instantly.
  // Realtime refreshes use a fire-and-forget reload — any failure surfaces
  // on the next explicit retry rather than spamming error UI on every poke.
  useEffect(() => {
    if (!id) return;
    const unsubscribe = subscribeToGroupMembers(id, () => {
      void useSplitStore.getState().loadGroups();
      void reload().catch(err => console.error('group realtime reload failed', err));
    });
    return unsubscribe;
  }, [id, reload]);

  // Hard error: the whole page is about this group's data. If it fails,
  // there's nothing useful to show — give the user a retry affordance.
  if (loadStatus === 'error') {
    return (
      <PageErrorState
        title={t('gdp_err_load')}
        message={loadError ?? t('gdp_err_load_sub')}
        onRetry={retryLoad}
      />
    );
  }

  if (!group || loadStatus === 'loading') {
    // Skeletons in the loaded page's geometry: the blue hero with its member
    // row, then the code card, the spend card, the tab pills and the expense
    // list — so nothing jumps when the group lands. The back button is live
    // so a slow load is never a trap.
    const delay = (i: number) => ({ '--m-skel-delay': skeletonDelay(i) }) as CSSProperties;
    return (
      <main className="min-h-dvh bg-cream-bg pb-28" aria-busy="true">
        <NavyHero accent="blue">
          <TopBar back />
          <div className="px-5 pb-7" aria-hidden="true">
            <div className="m-skel h-[10px] w-44" />
            <div className="flex items-center gap-1.5 mt-3">
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="w-14 flex flex-col items-center gap-1.5">
                  <div className="m-skel w-8 h-8 rounded-full" style={delay(i)} />
                  <div className="m-skel h-[7px] w-9" style={delay(i)} />
                </div>
              ))}
            </div>
          </div>
        </NavyHero>
        <div className="sukoon-body px-5 pt-5 space-y-3">
          <p className="sr-only" role="status">{t('gdp_loading')}</p>
          <div aria-hidden="true" className="space-y-3">
            <div className="m-skel h-[68px] rounded-[18px]" />
            <div className="m-skel h-[88px] rounded-[18px]" style={delay(1)} />
            <div className="flex gap-2 pt-2">
              {[0, 1, 2].map((i) => (
                <div key={i} className="m-skel h-8 w-[84px] rounded-full" style={delay(2)} />
              ))}
            </div>
          </div>
          <ListSkeleton rows={4} />
        </div>
      </main>
    );
  }

  /**
   * A guest seat's two affordances — "invite them to Hisaab" (WhatsApp) and
   * "assign this seat to a member" (copy the link) — are ONE mechanism, not
   * two, and not a third claim path either.
   *
   * Both mint an invite carrying `linked_member_id = <this seat>`, and
   * accept_group_invite rebinds a profile_id-NULL seat by that id
   * (consent-guards.sql §3.5, restated by p2-trust-safety §4.2). So whoever
   * opens the link takes over THIS seat together with every expense share and
   * settlement already recorded against it, instead of landing on a fresh row
   * and orphaning the history.
   *
   * The seat's phone number is deliberately unavailable here — add_group_guest
   * keeps only a SHA-256 digest, in a table no client role can read — so the
   * WhatsApp hand-off opens the contact picker rather than a pre-addressed
   * chat. `buildWhatsAppUrl(null, …)` is exactly that fallback.
   */
  const handleGuestInvite = (member: GroupMember, channel: 'whatsapp' | 'copy') =>
    guestInviteGuard.run(async () => {
      setInvitingGuestId(member.id);
      try {
        let url: string;
        try {
          url = (await createInvite(group.id, member.id)).url;
        } catch {
          toast.show({ type: 'error', title: t('ginv_err_create') });
          return;
        }
        if (channel === 'whatsapp') {
          // The link rides inside the message; the clipboard is a courtesy.
          void copyText(url);
          window.open(
            buildWhatsAppUrl(null, buildGuestInviteText(member.name, group.name, url)),
            '_blank',
            'noopener,noreferrer',
          );
        } else if (await copyText(url)) {
          toast.show({ type: 'success', title: t('ginv_link_copied'), subtitle: t('guest_assign_hint') });
        } else {
          // Minting took long enough for the tap's activation to lapse. The
          // invite EXISTS — never report this as "could not create invite".
          offerLinkFallback(url, t('guest_assign_hint'));
        }
      } finally {
        setInvitingGuestId(null);
      }
    });

  // Copy text that is already in hand, with an honest toast. Call it before
  // any await in a tap handler (src/lib/clipboard.ts rule 1).
  const copyWithToast = async (
    text: string,
    success: { title: string; subtitle?: string },
    failureSubtitle?: string,
  ) => {
    if (await copyText(text)) {
      toast.show({ type: 'success', ...success });
      return;
    }
    toast.show({ type: 'error', title: t('grp_copy_failed'), subtitle: failureSubtitle, duration: 6000 });
  };

  // A link minted over the network can outlive the tap's user activation, and
  // then the clipboard refuses it. Offer a FRESH tap instead: the OS share
  // sheet in the Android app (it needs no activation and carries its own Copy
  // target), a synchronous Copy on the web.
  const offerLinkFallback = (url: string, copiedSubtitle?: string) => {
    const native = isNativeRuntime();
    toast.show({
      type: 'info',
      title: t('ginv_link_ready'),
      subtitle: native ? t('ginv_link_ready_share_sub') : copiedSubtitle,
      duration: 10000,
      action: {
        label: native ? t('ginv_share') : t('ginv_copy'),
        onPress: () => {
          if (!native) {
            // A fresh tap with the link in hand: this is the path that works
            // on the web. (No "press and hold" hint — there is no link on this
            // screen to press; the WhatsApp action carries it instead.)
            void copyWithToast(url, { title: t('ginv_link_copied'), subtitle: copiedSubtitle });
            return;
          }
          void shareText({
            title: group.name,
            text: t('ginv_share_text').replace('{group}', group.name),
            url,
            dialogTitle: t('ginv_share'),
          }).then((outcome) => {
            if (outcome === 'failed' || outcome === 'unavailable') {
              toast.show({ type: 'error', title: t('ginv_share_failed') });
            }
          });
        },
      },
    });
  };

  const openRenameGuest = (member: GroupMember) => {
    setRenameValue(member.name);
    setRenamingGuest(member);
  };

  const handleRenameGuest = () => renameGuard.run(async () => {
    if (!renamingGuest) return;
    const trimmed = renameValue.trim();
    setRenaming(true);
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
      setRenaming(false);
    }
  });

  const handleUnblockMember = (profileId: string, name: string) => unblockGuard.run(async () => {
    const ok = await confirmDestructive({
      title: t('blk_unblock_confirm_title').replace('{name}', name),
      description: t('blk_unblock_confirm_body'),
      confirmLabel: t('blk_action_unblock'),
      cancelLabel: t('cancel'),
      tone: 'warning',
    });
    if (!ok) return;
    try {
      await unblockMember(profileId);
      toast.show({ type: 'success', title: t('blk_unblocked_toast').replace('{name}', name) });
    } catch {
      toast.show({ type: 'error', title: t('blk_failed') });
    }
  });

  const getMemberName = (memberId: string) => group.members.find(member => member.id === memberId)?.name ?? '?';
  const currentMember = group.members.find(member => member.profileId === localStorage.getItem('hisaab_supabase_uid'))
    ?? group.members.find(member => member.isOwner);
  const currentUserId = localStorage.getItem('hisaab_supabase_uid') ?? '';
  const isPaidByCurrentUser = (expense: GroupExpense) => {
    const paidByMember = group.members.find(member => member.id === expense.paidBy);
    return paidByMember?.profileId === currentUserId;
  };
  const getSplitTypeLabel = (splitType: GroupExpense['splitType']) => {
    if (splitType === 'equal') return t('group_split_equal');
    if (splitType === 'exact') return t('group_split_exact');
    if (splitType === 'percentage') return t('group_split_pct');
    return t('group_split_shares');
  };
  const getExpenseMeta = (expense: GroupExpense) => {
    const myShare = currentMember
      ? expense.splits.find(split => split.memberId === currentMember.id)?.amount ?? 0
      : 0;
    return {
      paidBy: getMemberName(expense.paidBy),
      split: getSplitTypeLabel(expense.splitType),
      share: formatMoney(myShare, group.currency),
    };
  };

  // Group-level health: total spend, settlements, and how far toward "zero
  // imbalance" the group is. Used both by the summary card and by the
  // per-member rings on the Balances tab.
  const shownDebts = effectiveSimplify ? debts : pairwiseDebts;
  const totalSpend = expenses.reduce((s, e) => s + e.amount, 0);
  const totalSettled = settlements.reduce((s, x) => s + x.amount, 0);
  const totalOutstanding = shownDebts.reduce((s, d) => s + d.amount, 0);
  const settledRatio = totalOutstanding === 0
    ? 1
    : totalSettled / (totalSettled + totalOutstanding);
  const settledPct = Math.round(Math.max(0, Math.min(1, settledRatio)) * 100);

  // Per-member net balance — positive = owed money, negative = owes money.
  const memberNet = new Map<string, number>();
  for (const member of group.members) memberNet.set(member.id, 0);
  for (const d of shownDebts) {
    memberNet.set(d.to, (memberNet.get(d.to) ?? 0) + d.amount);
    memberNet.set(d.from, (memberNet.get(d.from) ?? 0) - d.amount);
  }
  const maxAbs = Math.max(
    1,
    ...Array.from(memberNet.values()).map(v => Math.abs(v)),
  );
  const memberStats = new Map<string, { paid: number; share: number; settlement: number }>();
  for (const member of group.members) memberStats.set(member.id, { paid: 0, share: 0, settlement: 0 });
  for (const expense of expenses) {
    const paidStats = memberStats.get(expense.paidBy) ?? { paid: 0, share: 0, settlement: 0 };
    paidStats.paid += expense.amount;
    memberStats.set(expense.paidBy, paidStats);

    for (const split of expense.splits) {
      const splitStats = memberStats.get(split.memberId) ?? { paid: 0, share: 0, settlement: 0 };
      splitStats.share += split.amount;
      memberStats.set(split.memberId, splitStats);
    }
  }
  for (const settlement of settlements) {
    const fromStats = memberStats.get(settlement.fromMember) ?? { paid: 0, share: 0, settlement: 0 };
    fromStats.settlement += settlement.amount;
    memberStats.set(settlement.fromMember, fromStats);

    const toStats = memberStats.get(settlement.toMember) ?? { paid: 0, share: 0, settlement: 0 };
    toStats.settlement += settlement.amount;
    memberStats.set(settlement.toMember, toStats);
  }
  const balanceRows = group.members
    .map(member => {
      const stats = memberStats.get(member.id) ?? { paid: 0, share: 0, settlement: 0 };
      return {
        member,
        paid: Math.round(stats.paid * 100) / 100,
        share: Math.round(stats.share * 100) / 100,
        settlement: Math.round(stats.settlement * 100) / 100,
        net: Math.round((memberNet.get(member.id) ?? 0) * 100) / 100,
      };
    })
    .filter(row => row.paid > 0.01 || row.share > 0.01 || row.settlement > 0.01 || Math.abs(row.net) > 0.01)
    .sort((a, b) => Math.abs(b.net) - Math.abs(a.net) || b.paid - a.paid || a.member.name.localeCompare(b.member.name));

  // Archived = frozen and readable. The server blocks every write anyway
  // (tg_block_writes_in_archived_group / tg_block_join_archived_group), so
  // hiding the actions is honesty, not enforcement.
  const isArchived = Boolean(group.archivedAt);
  // Roles (src/lib/groupRoles.ts, supabase-migration-group-admins.sql).
  // OWNER-ONLY: delete the group, transfer it, choose admins.
  // OWNER OR ADMIN (`canManage`): archive / reopen, the join code, guest
  // renames, invite links. On a database without the migration nobody is an
  // admin, so `canManage` is exactly the old owner check.
  const isOwner = isGroupOwner(currentMember);
  const canManage = canManageGroup(currentMember);
  const adminsSupported = groupSupportsAdmins(group.members);
  // transfer_group_ownership only accepts a connected, profile-linked member of
  // the same group — mirror that filter so the picker can never offer a
  // candidate the RPC will reject with INVALID_NEW_OWNER.
  const transferCandidates = eligibleNewOwners(group.members, currentUserId);
  const ownerMember = group.members.find((member) => isGroupOwner(member));
  const adminSheetMembers = adminCandidates(group.members);
  const joinCodeExpiresAt = group.joinCodeExpiresAt ? new Date(group.joinCodeExpiresAt) : null;
  const joinCodeExpired = joinCodeExpiresAt !== null
    && Number.isFinite(joinCodeExpiresAt.getTime())
    && joinCodeExpiresAt.getTime() < Date.now();
  const joinCodeExpiryLabel = joinCodeExpiresAt && Number.isFinite(joinCodeExpiresAt.getTime())
    ? joinCodeExpired
      ? t('grp_code_expired')
      : t('grp_code_expires').replace(
          '{date}',
          joinCodeExpiresAt.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
        )
    : null;

  // Archive is the non-destructive alternative and, for a group with other
  // members or unsettled ex-members, the ONLY end state available: the delete
  // guard refuses, and leave_group refuses too once a balance is stuck
  // (group-deletion-guard.sql, residual risk R1).
  const handleArchive = async (confirmFirst = true) => {
    if (archiving) return false;
    if (confirmFirst) {
      const ok = await confirmDestructive({
        title: t('grp_archive_confirm_title'),
        description: t('grp_archive_confirm_body'),
        confirmLabel: t('grp_archive_action'),
        cancelLabel: t('not_now'),
        tone: 'warning',
      });
      if (!ok) return false;
    }
    setArchiving(true);
    try {
      const result = await archiveGroup(group.id);
      toast.show({
        type: result.success ? 'success' : 'error',
        title: result.success ? t('grp_archived_done') : t('grp_archive_failed'),
        subtitle: result.success ? undefined : result.userMessage,
      });
      if (result.success) await reload();
      return result.success;
    } catch (err) {
      toast.show({
        type: 'error',
        title: t('grp_archive_failed'),
        subtitle: err instanceof Error ? err.message : undefined,
      });
      return false;
    } finally {
      setArchiving(false);
    }
  };

  const handleUnarchive = async () => {
    if (archiving) return;
    setArchiving(true);
    try {
      const result = await unarchiveGroup(group.id);
      toast.show({
        type: result.success ? 'success' : 'error',
        title: result.success ? t('grp_unarchived_done') : t('grp_unarchive_failed'),
        subtitle: result.success ? undefined : result.userMessage,
      });
      if (result.success) await reload();
    } catch (err) {
      toast.show({
        type: 'error',
        title: t('grp_unarchive_failed'),
        subtitle: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setArchiving(false);
    }
  };

  const handleDelete = async () => {
    // Unsettled debts vanish with the group — say so explicitly instead of
    // the generic body, so nobody deletes away money they're still owed.
    const outstanding = pairwiseDebts.reduce((s, d) => s + d.amount, 0);
    const ok = await confirmDestructive({
      title: t('group_delete_confirm'),
      description: outstanding > 0.005
        ? `${t('group_delete_unsettled').replace('{amount}', formatMoney(outstanding, group.currency))} ${t('del_group_body')}`
        : t('del_group_body'),
      confirmLabel: t('gdp_delete_group_cta'),
    });
    if (!ok) return;

    // supabase-migration-audit-p0-group-deletion-guard.sql refuses a client
    // hard-delete of a SHARED group. Previously this call had no try/catch at
    // all, so a refusal surfaced as an unhandled rejection and the user got
    // nothing. Both tiers are dead ends by design — Archive is the way out, so
    // it is offered as the primary action right here rather than being buried
    // back in the menu.
    try {
      await deleteGroup(group.id);
      navigate('/groups');
    } catch (err) {
      const blocker = readGroupGuardFailure(err);
      if (blocker?.code === 'GROUP_HAS_OTHER_MEMBERS' || blocker?.code === 'GROUP_HAS_OUTSTANDING_BALANCES') {
        const isMembers = blocker.code === 'GROUP_HAS_OTHER_MEMBERS';
        const body = isMembers ? t('grp_del_blocked_members_body') : t('grp_del_blocked_balances_body');
        const archiveInstead = await confirmDestructive({
          title: isMembers ? t('grp_del_blocked_members_title') : t('grp_del_blocked_balances_title'),
          // The server DETAIL names the members / amounts — keep it, it is the
          // difference between "someone" and "Bilal owes AED 150.00".
          description: blocker.detail ? `${body}\n\n${blocker.detail}` : body,
          confirmLabel: t('grp_del_archive_cta'),
          cancelLabel: t('not_now'),
          tone: 'warning',
        });
        if (archiveInstead) await handleArchive(false);
        return;
      }
      toast.show({
        type: 'error',
        title: t('grp_del_failed'),
        subtitle: err instanceof Error ? err.message : undefined,
      });
    }
  };

  // Owner-only handover. The RPC only accepts a member who is connected AND
  // profile-linked, so a group can never be handed to a guest seat or a
  // stranger — the picker below applies exactly that filter.
  //
  // It now ASKS first. This used to fire on a single tap of a member in a
  // sheet titled "Choose the new admin", and that is how the founder gave a
  // test group away (2026-09-19). The confirm says plainly that the caller
  // stops being the owner — and, once the co-admin migration is live, that
  // they stay on as an admin (transfer_group_ownership keeps them one).
  const handleTransferOwnership = async (member: GroupMember) => {
    if (transferringMemberId) return;
    const ok = await confirmDestructive({
      title: t('grp_transfer_confirm_title').replace('{name}', member.name),
      description: t(adminsSupported ? 'grp_transfer_confirm_body_admin' : 'grp_transfer_confirm_body')
        .replace('{group}', group.name)
        .replace('{name}', member.name),
      confirmLabel: t('grp_transfer_confirm_cta'),
      cancelLabel: t('cancel'),
      tone: 'warning',
    });
    if (!ok) return;
    const memberId = member.id;
    setTransferringMemberId(memberId);
    try {
      const result = await transferGroupOwnership(group.id, memberId);
      toast.show({
        type: result.success ? 'success' : 'error',
        title: result.success ? t('grp_transfer_done') : t('grp_transfer_failed'),
        subtitle: result.success ? undefined : result.userMessage,
      });
      if (result.success) {
        setShowTransfer(false);
        await reload();
      }
    } catch (err) {
      toast.show({
        type: 'error',
        title: t('grp_transfer_failed'),
        subtitle: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setTransferringMemberId(null);
    }
  };

  // Owner-only: make a member a co-admin, or remove them. The owner stays the
  // owner either way — the founder's rule (2026-09-19). On a database without
  // supabase-migration-group-admins.sql the RPC does not exist and the store
  // answers NEEDS_DB_UPDATE, which the copy below says in plain words.
  const handleSetAdmin = async (member: GroupMember, makeAdmin: boolean) => {
    if (settingAdminId) return;
    setSettingAdminId(member.id);
    try {
      const result = await setGroupAdmin(group.id, member.id, makeAdmin);
      if (result.status === 'ok') {
        toast.show({
          type: 'success',
          title: t(makeAdmin ? 'grp_admin_made' : 'grp_admin_removed').replace('{name}', member.name),
          subtitle: makeAdmin ? t('grp_admin_made_sub') : undefined,
        });
        await reload();
        return;
      }
      toast.show({ type: 'error', ...setGroupAdminFailureCopy(result.status), duration: 6000 });
    } catch (err) {
      toast.show({
        type: 'error',
        title: t('grp_admin_err_generic'),
        subtitle: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setSettingAdminId(null);
    }
  };

  // Join codes expire 14 days after creation or rotation. Rotating retires the
  // old code immediately (anyone still holding it can no longer join), which is
  // exactly why this lives behind an explicit owner-or-admin action.
  const handleRefreshJoinCode = async () => {
    if (refreshingCode) return;
    setRefreshingCode(true);
    try {
      const nextCode = await refreshJoinCode(group.id);
      // A courtesy copy only — the toast does not claim it, and the new code
      // is on screen with its own Copy button. (This used to be a bare
      // navigator.clipboard call: where that object does not exist it threw,
      // and a rotation that HAD succeeded was reported as a failure.)
      void copyText(nextCode);
      toast.show({
        type: 'success',
        title: t('grp_code_refreshed'),
        subtitle: t('grp_code_refresh_sub'),
      });
    } catch (err) {
      toast.show({
        type: 'error',
        title: t('grp_code_refresh_failed'),
        subtitle: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setRefreshingCode(false);
    }
  };

  const handleRemoveSettlement = async (settlement: (typeof settlements)[number]) => {
    const fromName = group.members.find((m) => m.id === settlement.fromMember)?.name ?? '?';
    const toName = group.members.find((m) => m.id === settlement.toMember)?.name ?? '?';
    const ok = await confirmDestructive({
      title: t('stl_remove_title'),
      description: t('stl_remove_body')
        .replace('{from}', fromName)
        .replace('{to}', toName)
        .replace('{amount}', formatMoney(settlement.amount, group.currency)),
      confirmLabel: t('stl_remove_cta'),
      cancelLabel: t('not_now'),
      tone: 'warning',
    });
    if (!ok) return;
    try {
      await deleteSettlement(group.id, settlement.id);
      toast.show({ type: 'success', title: t('stl_removed') });
      void reload();
    } catch (err) {
      toast.show({ type: 'error', title: t('error'), subtitle: err instanceof Error ? err.message : undefined });
    }
  };

  const handleToggleMute = async () => {
    if (!id || mutingGroup) return;
    setMutingGroup(true);
    try {
      await setGroupMuted(id, !groupMuted);
    } catch (err) {
      console.error('Failed to update group mute', err);
      toast.show({
        type: 'error',
        title: t('grp_mute_failed'),
        subtitle: err instanceof Error ? err.message : t('common_please_try_again'),
      });
    } finally {
      setMutingGroup(false);
    }
  };

  const handleLeave = async () => {
    if (leaving) return;
    const ok = await confirmDestructive({
      title: t('gdp_leave_confirm_title'),
      description: t('gdp_leave_confirm_body'),
      confirmLabel: t('gdp_leave_confirm_cta'),
      tone: 'warning',
    });
    if (!ok) return;

    setLeaving(true);
    try {
      const result = await leaveGroup(group.id);
      if (!result.success) {
        toast.show({
          type: 'error',
          title: t('gdp_leave_blocked'),
          // The server's ONLY_OWNER_ADMIN sentence says "Assign another admin
          // first" — no longer true: making someone an admin does not let the
          // owner leave, transferring ownership does. Localized, and honest.
          subtitle: result.reasonCode === 'ONLY_OWNER_ADMIN' ? t('grp_leave_owner_blocked') : result.userMessage,
          duration: 6000,
        });
        return;
      }
      navigate('/groups');
      toast.show({ type: 'success', title: result.userMessage });
    } catch (err) {
      console.error('Failed to leave group', err);
      toast.show({
        type: 'error',
        title: t('gdp_leave_failed'),
        subtitle: err instanceof Error ? err.message : t('common_please_try_again'),
      });
    } finally {
      setLeaving(false);
    }
  };

  const handleGroupExpenseReconcile = async (expense: GroupExpense) => {
    if (savingReconciliationId) return;
    setSavingReconciliationId(expense.id);
    try {
      await setGroupExpenseReconciled(expense.id, !(expense.isReconciled ?? false));
      await reload();
    } catch (err) {
      console.error('Failed to update group expense reconciliation', err);
      toast.show({
        type: 'error',
        title: t('gdp_reconcile_failed'),
        subtitle: err instanceof Error ? err.message : t('common_please_try_again'),
      });
    } finally {
      setSavingReconciliationId(null);
    }
  };

  return (
    <main className="min-h-dvh bg-cream-bg pb-28">
      <NavyHero accent="blue">
        <TopBar
          title={`${group.emoji} ${group.name}`}
          back
          action={
            // Compact 2-icon action row + overflow menu. Previously this row
            // showed Invite + Leave + Delete + LanguageToggle, which on
            // narrow Android screens left almost no room for the group
            // title (a `{emoji} {name}` string that's often long).
            <div className="flex items-center gap-2">
              {/* No new members can join an archived group
                  (tg_block_join_archived_group blocks even the definer join
                  RPCs), so an invite link would be born dead. */}
              {!isArchived && (
                <button
                  onClick={() => setShowInvite(true)}
                  className={HERO_CTL}
                  aria-label={t('a11y_invite')}
                >
                  <Glyph name="share" size={15} className="text-white/90" />
                </button>
              )}
              <div className="relative" ref={menuRef}>
                <button
                  onClick={() => setShowMenu((v) => !v)}
                  className={HERO_CTL}
                  aria-label={t('a11y_more')}
                  aria-haspopup="menu"
                  aria-expanded={showMenu}
                >
                  <Glyph name="more" size={16} strokeWidth={3} className="text-white/90" />
                </button>
                {showMenu && (
                  // The menu lives inside the hero, which is dark in BOTH
                  // themes (.m-hero re-scopes the material), so it is a dark
                  // card with white ink everywhere — never theme ink on a
                  // hero-scoped face.
                  <div
                    role="menu"
                    className="m-card absolute right-0 top-11 z-30 min-w-[196px] border border-white/10 overflow-hidden animate-fade-in"
                  >
                    <button
                      role="menuitem"
                      onClick={() => { setShowMenu(false); void handleToggleMute(); }}
                      disabled={mutingGroup}
                      className="w-full px-4 py-3 text-left text-[13px] font-medium text-white active:bg-white/5 flex items-start gap-2.5 disabled:opacity-50 transition-colors"
                    >
                      {groupMuted
                        ? <Glyph name="bell" size={14} className="text-white/70 mt-0.5" />
                        : <BellOff size={14} strokeWidth={2.4} className="text-white/70 mt-0.5 shrink-0" />}
                      <span className="flex flex-col">
                        <span>{t(groupMuted ? 'grp_unmute' : 'grp_mute')}</span>
                        <span className="text-[10.5px] font-normal text-white/70 mt-0.5">
                          {t('grp_mute_sub')}
                        </span>
                      </span>
                    </button>
                    {currentMember?.profileId === currentUserId && (
                      <button
                        role="menuitem"
                        onClick={() => { setShowMenu(false); handleLeave(); }}
                        disabled={leaving}
                        className="w-full px-4 py-3 text-left text-[13px] font-medium text-white active:bg-white/5 flex items-center gap-2.5 border-t border-white/10 disabled:opacity-50 transition-colors"
                      >
                        <Glyph name="logout" size={14} className={`text-white/70 ${leaving ? 'animate-pulse' : ''}`} />
                        {leaving ? t('grp_leaving') : t('grp_leave_cta')}
                      </button>
                    )}
                    {/* Co-admins: share the running of the group without
                        giving it away (the owner stays the owner). Offered
                        on an archived group too — that is how an owner lets
                        a co-admin reopen it. */}
                    {isOwner && (
                      <button
                        role="menuitem"
                        onClick={() => { setShowMenu(false); setShowAdmins(true); }}
                        className="w-full px-4 py-3 text-left text-[13px] font-medium text-white active:bg-white/5 flex items-center gap-2.5 border-t border-white/10 transition-colors"
                      >
                        <Glyph name="shield-check" size={14} className="text-white/70" />
                        {t('grp_admins_action')}
                      </button>
                    )}
                    {isOwner && transferCandidates.length > 0 && !isArchived && (
                      <button
                        role="menuitem"
                        onClick={() => { setShowMenu(false); setShowTransfer(true); }}
                        className="w-full px-4 py-3 text-left text-[13px] font-medium text-white active:bg-white/5 flex items-center gap-2.5 border-t border-white/10 transition-colors"
                      >
                        <Crown size={14} strokeWidth={2.4} className="text-white/70 shrink-0" />
                        {t('grp_transfer_action')}
                      </button>
                    )}
                    {canManage && (
                      <button
                        role="menuitem"
                        onClick={() => { setShowMenu(false); void (isArchived ? handleUnarchive() : handleArchive()); }}
                        disabled={archiving}
                        className="w-full px-4 py-3 text-left text-[13px] font-medium text-white active:bg-white/5 flex items-center gap-2.5 border-t border-white/10 disabled:opacity-50 transition-colors"
                      >
                        {isArchived
                          ? <ArchiveRestore size={14} strokeWidth={2.4} className="text-white/70 shrink-0" />
                          : <Glyph name="archive" size={14} className="text-white/70" />}
                        {isArchived ? t('grp_unarchive_action') : t('grp_archive_action')}
                      </button>
                    )}
                    {isOwner && (
                      <button
                        role="menuitem"
                        onClick={() => { setShowMenu(false); handleDelete(); }}
                        className="w-full px-4 py-3 text-left text-[13px] font-medium text-pay-text active:bg-white/5 flex items-center gap-2.5 border-t border-white/10 transition-colors"
                      >
                        <Glyph name="trash" size={14} tone="coral" />
                        {t('gdp_delete_group_cta')}
                      </button>
                    )}
                  </div>
                )}
              </div>
            </div>
          }
        />
        <div className="px-5 pb-7">
          <p className="text-[10.5px] font-semibold text-white/70 tracking-[0.12em] uppercase">
            {group.members.length} {t('group_members_count')} ·{' '}
            {/* "Connected" means "on Hisaab", and a guest is not — even though
                their seat carries status='connected' so the ledger accepts them
                (audit G6 / O4). Counting them here would make the header claim
                people are on the app who never installed it. */}
            {t('gdp_connected_count').replace('{n}', String(group.members.filter((m) => m.status === 'connected' && !isGuestMember(m)).length))} ·{' '}
            {group.currency}
          </p>

          {/* py-1 keeps the status rings clear of the scroller's clip edge. */}
          <div className="flex items-center gap-1.5 mt-2 py-1 overflow-x-auto no-scrollbar">
            {group.members.map((member) => (
              <div key={member.id} className="flex flex-col items-center gap-1 shrink-0 w-14">
                <MemberAvatar member={member} size={32} onHero />
                <span className="text-[10px] text-white/70 truncate w-full text-center">
                  {memberStatusLabel(t, member)}
                </span>
              </div>
            ))}
          </div>

          {/* One-line status legend — appears the first time a group has any
              non-connected member, so the colour coding on the avatars is
              decodable. Dismissible and remembered per-device. */}
          {/* Guests count as "needs decoding" too: their ring is the neutral
              one, which the legend is the only thing explaining. */}
          {!legendDismissed && group.members.some((m) => !m.isOwner && (m.status !== 'connected' || isGuestMember(m))) && (
            <div className="mt-2.5 flex items-center gap-3 rounded-xl bg-white/10 px-3 py-2 animate-fade-in">
              <span className="flex items-center gap-1.5 text-[10px] text-white/75">
                <span className="w-2 h-2 rounded-full bg-glyph-green" />
                {t('member_on_app')}
              </span>
              <span className="flex items-center gap-1.5 text-[10px] text-white/75">
                <span className="w-2 h-2 rounded-full bg-glyph-gold" />
                {t('member_invited')}
              </span>
              <span className="flex items-center gap-1.5 text-[10px] text-white/75">
                <span className="w-2 h-2 rounded-full bg-white/30" />
                {t('member_not_on_app')}
              </span>
              <button
                onClick={dismissLegend}
                className="ml-auto relative -m-2 p-2 text-white/70 active:text-white transition-colors"
                aria-label={t('a11y_dismiss_legend')}
              >
                <Glyph name="close" size={13} />
              </button>
            </div>
          )}
        </div>
      </NavyHero>

      {/* Sections each carry pt-3 (the 12px card rhythm); pt-2 here makes the
          first one land on the sheet's 20px top gutter. */}
      <div className="sukoon-body pt-2">

      {/* Archived banner. The server refuses every write in an archived group
          (GROUP_ARCHIVED), so this explains a page whose action bar has gone
          rather than letting the user discover it by tapping. */}
      {isArchived && (
        <div className="px-5 pt-3">
          <div className="m-card p-4 flex items-start gap-3 animate-fade-in">
            <div className="m-ctl w-10 h-10 rounded-[14px] flex items-center justify-center shrink-0">
              <Glyph name="lock" size={16} tone="neutral" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-[13.5px] font-semibold text-ink-900 tracking-[-0.01em]">
                {t('grp_archived_banner_title')}
              </p>
              <p className="text-[11.5px] text-ink-600 mt-1 leading-[1.55]">
                {t('grp_archived_banner_body')}
              </p>
              {canManage && (
                <button
                  onClick={() => void handleUnarchive()}
                  disabled={archiving}
                  className="m-btn m-btn-primary mt-3 mb-1 min-h-[36px] px-3.5 py-2 gap-1.5 rounded-xl text-[11.5px]"
                >
                  <ArchiveRestore size={13} strokeWidth={2.4} /> {t('grp_unarchive_action')}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* The join code is dead weight on an archived group — nobody new can
          join one (tg_block_join_archived_group), definer RPCs included. */}
      {!isArchived && group.joinCode && (() => {
        // When the owner is the only connected person, the group code card
        // becomes the primary activation surface — bigger, louder, with an
        // explicit "why you're seeing this" headline. Once others have
        // joined, it compacts back into the quiet reference card.
        const connectedCount = group.members.filter(m => m.status === 'connected').length;
        const isSolo = connectedCount <= 1;
        // Synchronous start inside the tap, and an honest toast either way —
        // the bare navigator.clipboard call this replaces rejected unhandled
        // wherever the API is missing or refused, and the user saw nothing.
        const copyCode = () => {
          if (!group.joinCode) return;
          void copyWithToast(
            group.joinCode,
            { title: t('gdp_code_copied'), subtitle: t('gdp_code_copied_sub') },
            t('grp_copy_failed_code_sub'),
          );
        };

        if (isSolo) {
          return (
            <div className="px-5 pt-3">
              <div className="m-card p-4 animate-fade-in">
                <div className="flex items-start gap-3">
                  <div className="m-card m-blue w-10 h-10 rounded-[14px] flex items-center justify-center shrink-0">
                    <Glyph name="user-plus" size={17} tone="blue" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-[13.5px] font-semibold text-ink-900 tracking-[-0.01em]">
                      {t('group_solo_invite_title')}
                    </p>
                    <p className="text-[11.5px] text-ink-600 mt-1 leading-[1.55]">
                      {t('group_solo_invite_body')}
                    </p>
                  </div>
                </div>
                {/* The code sits in a recessed well — it is the thing to copy. */}
                <div className="m-inset mt-3.5 flex items-center gap-2.5 px-3.5 py-2.5">
                  <div className="flex-1 min-w-0">
                    <p className="text-[15px] font-semibold font-mono tracking-tight text-ink-900 truncate">
                      {group.joinCode}
                    </p>
                    {joinCodeExpiryLabel && (
                      <p className={`text-[10px] mt-0.5 font-semibold ${joinCodeExpired ? 'text-pay-text' : 'text-ink-500'}`}>
                        {joinCodeExpiryLabel}
                      </p>
                    )}
                  </div>
                  <button
                    onClick={copyCode}
                    className="m-btn m-btn-primary shrink-0 min-h-[36px] px-3 py-1.5 gap-1.5 rounded-xl text-[11.5px]"
                  >
                    <Glyph name="copy" size={13} /> {t('gdp_copy')}
                  </button>
                </div>
                {canManage && (
                  <button
                    onClick={() => void handleRefreshJoinCode()}
                    disabled={refreshingCode}
                    className="mt-2.5 inline-flex items-center gap-1.5 text-[11px] font-semibold text-accent-600 active:opacity-60 disabled:opacity-40 min-h-[36px]"
                  >
                    <Glyph name="refresh" size={12} className={refreshingCode ? 'animate-spin' : ''} />
                    {t('grp_code_refresh')}
                  </button>
                )}
              </div>
            </div>
          );
        }

        return (
          <div className="px-5 pt-3">
            <div className="m-card p-3.5 flex items-center gap-3">
              <div className="m-card m-blue w-10 h-10 rounded-[14px] flex items-center justify-center shrink-0">
                <Glyph name="share" size={17} tone="blue" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="m-label">{t('gdp_group_code')}</p>
                <p className="text-[15px] font-semibold text-ink-900 font-mono tracking-tight mt-0.5">{group.joinCode}</p>
                {joinCodeExpiryLabel && (
                  <p className={`text-[10px] mt-0.5 font-semibold ${joinCodeExpired ? 'text-pay-text' : 'text-ink-500'}`}>
                    {joinCodeExpiryLabel}
                  </p>
                )}
              </div>
              {canManage && (
                <button
                  onClick={() => void handleRefreshJoinCode()}
                  disabled={refreshingCode}
                  className="m-ctl relative w-9 h-9 flex items-center justify-center shrink-0 disabled:opacity-40 before:absolute before:-inset-1 before:content-['']"
                  aria-label={t('grp_code_refresh')}
                  title={t('grp_code_refresh')}
                >
                  <Glyph name="refresh" size={14} className={`text-ink-700 ${refreshingCode ? 'animate-spin' : ''}`} />
                </button>
              )}
              <button
                onClick={copyCode}
                className="m-btn m-btn-plain shrink-0 min-h-[36px] px-3 py-2 gap-1.5 rounded-xl text-[11.5px]"
              >
                <Glyph name="copy" size={13} /> {t('gdp_copy')}
              </button>
            </div>
          </div>
        );
      })()}

      {/* Group health — total spend on the left, settled-% ring on the right.
          Always present once there's any activity so users have an at-a-glance
          sense of how far from "fully settled" the group is. */}
      {tab !== 'activity' && totalSpend > 0 && (
        <div className="px-5 pt-3">
          <div className="m-card p-4 flex items-center gap-4">
            <div className="flex-1 min-w-0">
              <p className="m-label">{t('gdp_group_spend')}</p>
              <p className="text-[21px] font-semibold text-ink-900 tabular-nums tracking-[-0.03em] mt-1 leading-tight">
                {formatMoney(totalSpend, group.currency)}
              </p>
              <p className="text-[11px] text-ink-600 mt-1">
                {totalOutstanding === 0 ? (
                  <span className="text-receive-text font-semibold inline-flex items-center gap-1">
                    <VerifiedBadge size={13} title={t('group_settled')} /> {t('group_settled')}
                  </span>
                ) : (
                  <>
                    <span className="text-pay-text font-semibold tabular-nums">{formatMoney(totalOutstanding, group.currency)}</span>
                    <span>{t('gdp_outstanding_suffix')}</span>
                  </>
                )}
                <span className="mx-1.5">·</span>{expenses.length === 1 ? t('gdp_expense_one') : t('gdp_expense_many').replace('{n}', String(expenses.length))}
              </p>
            </div>
            {/* Settled-% ring around a recessed centre well (the handoff's
                donut recipe). Strokes are glyph tokens: ≥3:1 in both themes. */}
            <ProgressRing
              size={56}
              strokeWidth={5}
              progress={settledRatio}
              color={totalOutstanding === 0 ? 'var(--color-glyph-green)' : 'var(--color-glyph-blue)'}
            >
              <span className="m-inset rounded-full w-[42px] h-[42px] flex items-center justify-center">
                <span className={`text-[11px] font-semibold tabular-nums ${
                  totalOutstanding === 0 ? 'text-receive-text' : 'text-cobalt-text'
                }`}>
                  {settledPct}%
                </span>
              </span>
            </ProgressRing>
          </div>
        </div>
      )}

      {shownDebts.length > 0 && tab !== 'activity' && (
        <div className="px-5 pt-3">
          <div className="m-card p-4 space-y-2.5">
            <div className="flex items-center justify-between gap-3 pb-0.5">
              <span className="m-label">
                {effectiveSimplify ? t('gdp_plan_simplified') : t('gdp_plan_direct')}
              </span>
              {canSimplify && (
                <button
                  onClick={() => setSimplify((v) => !v)}
                  className="text-[11px] font-semibold text-accent-600 active:opacity-60 min-h-[32px] -my-1.5 text-right"
                >
                  {effectiveSimplify
                    ? t('gdp_show_direct')
                    : t('gdp_simplify')
                        .replace('{direct}', String(plans?.direct.count ?? 0))
                        .replace('{minimized}', String(plans?.minimized.count ?? 0))}
                </button>
              )}
            </div>
            {effectiveSimplify && plans && plans.rerouted.length > 0 && (
              <div className="rounded-xl bg-warn-50 px-3 py-2 text-[10.5px] font-medium text-warn-700 leading-relaxed">
                {plans.rerouted.length === 1
                  ? t('gdp_reroute_warning_one')
                  : t('gdp_reroute_warning_many').replace('{n}', String(plans.rerouted.length))}
              </div>
            )}
            {[...shownDebts]
              // Float debts involving "you" to the top — that's what the user
              // most likely came here to act on.
              .map((debt, originalIndex) => ({ debt, originalIndex }))
              .sort((a, b) => {
                const aMe = a.debt.from === currentMember?.id || a.debt.to === currentMember?.id;
                const bMe = b.debt.from === currentMember?.id || b.debt.to === currentMember?.id;
                if (aMe === bMe) return a.originalIndex - b.originalIndex;
                return aMe ? -1 : 1;
              })
              .map(({ debt, originalIndex }) => {
                const fromIsMe = debt.from === currentMember?.id;
                const toIsMe = debt.to === currentMember?.id;
                return (
                  <div key={`${debt.from}-${debt.to}-${originalIndex}`} className="flex items-center justify-between gap-3">
                    <p className="text-[12px] text-ink-600 min-w-0">
                      <span className={`font-semibold ${fromIsMe ? 'text-accent-600' : 'text-pay-text'}`}>
                        {fromIsMe ? t('label_you') : debt.fromName}
                      </span>
                      {' '}{t('group_owes')}{' '}
                      <span className={`font-semibold ${toIsMe ? 'text-accent-600' : 'text-receive-text'}`}>
                        {toIsMe ? t('label_you') : debt.toName}
                      </span>
                    </p>
                    <p className="text-[13.5px] font-semibold text-ink-900 tabular-nums tracking-[-0.01em] shrink-0">{formatMoney(debt.amount, group.currency)}</p>
                  </div>
                );
              })}
          </div>
        </div>
      )}

      {/* Tab pills — the active one is light-faced (m-pill + aria-pressed). */}
      <div className="flex gap-2 px-5 pt-5">
        {(['expenses', 'balances', 'activity'] as const).map(nextTab => (
          <button
            key={nextTab}
            onClick={() => setTab(nextTab)}
            aria-pressed={tab === nextTab}
            className="m-pill"
          >
            {nextTab === 'expenses' ? t('group_expenses') : nextTab === 'balances' ? t('group_balances') : t('group_activity')}
          </button>
        ))}
      </div>

      {tab === 'expenses' ? (
        <div className="px-5 pt-4 pb-8">
          {expenses.length === 0 ? (
            // An archived group with no expenses has nothing to activate —
            // every "add" path is refused server-side, so a CTA would be a
            // dead end. The archived banner above already explains the state.
            isArchived ? (
              <div className="flex flex-col items-center text-center py-10 px-6">
                <div className="m-plate mb-[18px]" aria-hidden="true">
                  <Glyph name="receipt" size={26} tone="neutral" extrude />
                </div>
                <p className="text-[15px] font-semibold text-ink-900 tracking-tight">{t('grp_archived_banner_title')}</p>
              </div>
            ) :
            // Activation empty state — strong CTA instead of a passive "no
            // expenses" line. When the owner is still alone, a split isn't
            // possible yet (expenses can only involve connected members), so
            // point them at inviting first instead of an "Add expense" button
            // that opens a modal they can't meaningfully complete.
            group.members.filter(m => m.status === 'connected').length <= 1 ? (
              <EmptyState
                icon={UserPlus}
                clayIcon="user-plus"
                tone="blue"
                size="compact"
                title={t('group_first_invite_title')}
                description={t('group_first_invite_body')}
                actionLabel={t('group_first_invite_cta')}
                onAction={() => {
                  if (!group.joinCode) return;
                  void copyWithToast(
                    group.joinCode,
                    { title: t('group_code_copied'), subtitle: t('group_code_copied_sub') },
                    t('grp_copy_failed_code_sub'),
                  );
                }}
              />
            ) : (
              <EmptyState
                icon={Receipt}
                clayIcon="receipt"
                tone="blue"
                size="compact"
                title={t('group_first_expense_title')}
                description={t('group_first_expense_body')}
                actionLabel={t('group_first_expense_cta')}
                onAction={() => setShowAddExpense(true)}
              />
            )
          ) : (
            // One card, rows split by hairlines: a blue receipt square (the
            // splits accent), what + who/how/your share, the amount, and the
            // history control.
            <div className="m-card overflow-hidden divide-y divide-cream-hairline">
              {expenses.map((expense, index) => {
                const meta = getExpenseMeta(expense);
                const canReconcile = isPaidByCurrentUser(expense);
                const isReconciled = expense.isReconciled ?? false;
                return (
                  <div
                    key={expense.id}
                    onClick={() => setEditExpense(expense)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        setEditExpense(expense);
                      }
                    }}
                    className="flex items-start gap-3 px-3.5 py-3.5 text-left cursor-pointer active:bg-cream-soft transition-colors animate-fade-in"
                    style={{ animationDelay: `${index * 30}ms` }}
                  >
                    <div className="relative shrink-0">
                      <div className="m-card m-blue w-10 h-10 rounded-[14px] flex items-center justify-center" aria-hidden="true">
                        <Glyph name="receipt" size={17} tone="blue" />
                      </div>
                      {/* Reconcile toggle, worn as a check badge on the
                          receipt's corner: hollow ring = not yet, green check =
                          reconciled. A ::before pads its hit area to 38px.
                          Using `aria-disabled` instead of the native `disabled`
                          attribute so that even when this button can't act
                          (non-payer / saving), the onClick still fires and
                          stopPropagation prevents the row click from opening
                          the edit modal. */}
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          if (!canReconcile || savingReconciliationId === expense.id) return;
                          void handleGroupExpenseReconcile(expense);
                        }}
                        aria-pressed={isReconciled}
                        aria-disabled={!canReconcile || savingReconciliationId === expense.id}
                        aria-label={
                          canReconcile
                            ? isReconciled ? t('gdp_reconcile_aria_unmark') : t('gdp_reconcile_aria_mark')
                            : isReconciled ? t('gdp_reconcile_aria_done_by_payer') : t('gdp_reconcile_aria_payer_only')
                        }
                        title={
                          canReconcile
                            ? isReconciled ? t('gdp_reconcile_title_reconciled') : t('gdp_reconcile_title_mark')
                            : isReconciled ? t('gdp_reconcile_title_done_by_payer') : t('gdp_reconcile_title_payer_only')
                        }
                        className={`absolute -bottom-1.5 -right-1.5 w-[22px] h-[22px] rounded-full border-2 flex items-center justify-center transition-transform active:scale-90 before:absolute before:-inset-2 before:content-[''] ${
                          isReconciled
                            ? 'm-stat-dot m-stat-dot-receive border-cream-card'
                            : canReconcile
                              ? 'bg-cream-card border-field-border hover:border-receive-600'
                              : 'bg-cream-soft border-cream-border opacity-50 cursor-default'
                        }`}
                      >
                        {isReconciled && <Glyph name="check" size={11} strokeWidth={3.2} />}
                      </button>
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5 min-w-0">
                        <p className="text-[13.5px] font-semibold text-ink-900 truncate tracking-[-0.01em]">{expense.description}</p>
                        {(expense.version ?? 1) > 1 ? (
                          <span
                            role="img"
                            className="h-2 w-2 rounded-full bg-accent-500 shrink-0"
                            aria-label={t('a11y_edited_expense')}
                            title={t('a11y_edited')}
                          />
                        ) : null}
                      </div>
                      <div className="mt-1.5 flex flex-wrap items-center gap-1">
                        <span className="m-chip m-chip-blue max-w-full">
                          {t('group_paid_by_short')} <span className="font-bold truncate min-w-0">{meta.paidBy}</span>
                        </span>
                        <span className="m-chip m-chip-gold max-w-full">
                          {t('group_split_short')} <span className="font-bold truncate min-w-0">{meta.split}</span>
                        </span>
                        <span className="m-chip m-chip-receive max-w-full">
                          {t('group_your_share_short')} <span className="font-bold tabular-nums">{meta.share}</span>
                        </span>
                      </div>
                    </div>
                    <div className="text-right shrink-0 pt-0.5">
                      <p className="text-[14px] font-semibold text-ink-900 tabular-nums tracking-[-0.01em]">{formatMoney(expense.amount, group.currency)}</p>
                      <p className="text-[10px] text-ink-500 tabular-nums mt-0.5">{new Date(expense.date).toLocaleDateString()}</p>
                    </div>
                    {/* Who-changed-what (audit G5/O10). A small secondary
                        control, not the row's tap target — the row itself
                        still opens the edit modal. */}
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        setHistoryFor({ table: 'group_expenses', id: expense.id });
                      }}
                      aria-label={t('eh_row_title')}
                      title={t('eh_row_title')}
                      className="m-ctl relative w-7 h-7 rounded-[9px] flex items-center justify-center shrink-0 mt-0.5 before:absolute before:-inset-1.5 before:content-['']"
                    >
                      <Glyph name="clock" size={13} className="text-ink-500" />
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      ) : tab === 'balances' ? (
        <div className="px-5 pt-4 pb-44 space-y-2.5">
          {shownDebts.length > 0 && (
            <button
              onClick={() => setShowSettleShare(true)}
              className="m-btn m-btn-plain w-full text-[13px]"
            >
              <Glyph name="share" size={15} tone="blue" /> {t('gsu_cta')}
            </button>
          )}
          {balanceRows.length === 0 ? (
            <EmptyState
              icon={Receipt}
              clayIcon="receipt"
              tone="blue"
              size="compact"
              title={t('gdp_no_balances')}
              description={t('gdp_no_balances_desc')}
            />
          ) : balanceRows.map(({ member, paid, share, net }, index) => {
            const ringProgress = Math.abs(net) / maxAbs;
            const isPositive = net > 0.01;
            const isNegative = net < -0.01;
            // Glyph tokens: ≥3:1 strokes on the card in both themes.
            const ringColor = isPositive
              ? 'var(--color-glyph-green)'
              : isNegative
                ? 'var(--color-glyph-coral)'
                : 'var(--color-ink-300)';
            return (
              <div
                key={member.id}
                className="m-card p-4 animate-fade-in"
                style={{ animationDelay: `${index * 30}ms` }}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-center gap-2.5 min-w-0 flex-1">
                    <MemberAvatar member={member} size={40} />
                    <div className="min-w-0">
                      <p className="text-[13.5px] font-semibold text-ink-900 truncate tracking-[-0.01em]">{member.name}</p>
                      <p className="text-[10.5px] text-ink-500 mt-0.5">
                        {memberStatusLabel(t, member)}
                        {member.id === currentMember?.id ? <span className="font-semibold text-accent-600">{t('gdp_you_suffix')}</span> : null}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    <div className="text-right">
                      {isPositive ? (
                        <>
                          <p className="text-[10px] text-receive-text font-semibold uppercase tracking-[0.08em]">{t('gdp_gets_back')}</p>
                          <p className="text-[13.5px] font-semibold text-receive-text tabular-nums mt-0.5">+{formatMoney(net, group.currency)}</p>
                        </>
                      ) : isNegative ? (
                        <>
                          <p className="text-[10px] text-pay-text font-semibold uppercase tracking-[0.08em]">{t('gdp_has_to_pay')}</p>
                          <p className="text-[13.5px] font-semibold text-pay-text tabular-nums mt-0.5">-{formatMoney(Math.abs(net), group.currency)}</p>
                        </>
                      ) : (
                        <>
                          <p className="text-[10px] text-ink-500 font-semibold uppercase tracking-[0.08em]">{t('gdp_balance')}</p>
                          <p className="text-[11px] text-ink-500 mt-0.5">{t('group_settled')}</p>
                        </>
                      )}
                    </div>
                    <ProgressRing
                      size={38}
                      strokeWidth={3}
                      progress={ringProgress}
                      color={ringColor}
                    />
                  </div>
                </div>
                {/* Paid / share — two recessed stat wells. */}
                <div className="grid grid-cols-2 gap-2 mt-3">
                  <div className="m-inset rounded-[12px] px-3 py-2">
                    <p className="text-[10px] font-semibold text-ink-500 uppercase tracking-[0.1em]">{t('gdp_paid_total')}</p>
                    <p className="text-[12.5px] font-semibold text-ink-800 tabular-nums mt-0.5">{formatMoney(paid, group.currency)}</p>
                  </div>
                  <div className="m-inset rounded-[12px] px-3 py-2">
                    <p className="text-[10px] font-semibold text-ink-500 uppercase tracking-[0.1em]">{t('gdp_share_total')}</p>
                    <p className="text-[12.5px] font-semibold text-ink-800 tabular-nums mt-0.5">{formatMoney(share, group.currency)}</p>
                  </div>
                </div>
                {/* Guest seat actions (audit G6 / O4). A guest has no account,
                    so there is nobody to block or report — instead the two
                    things a real member can do FOR them: hand the seat over,
                    or nudge them onto Hisaab. Both are the same linked-invite
                    mechanism; see handleGuestInvite. Both MINT an invite,
                    which only the owner or an admin may do (group_invites
                    INSERT policy) — for anyone else they could only fail. */}
                {isGuestMember(member) && canManage && (
                  <div className="mt-2.5 pt-2.5 border-t border-cream-hairline">
                    <div className="flex items-center gap-3 flex-wrap">
                      <button
                        type="button"
                        disabled={invitingGuestId === member.id}
                        onClick={() => handleGuestInvite(member, 'whatsapp')}
                        className="text-[11px] font-semibold text-accent-600 active:opacity-60 disabled:opacity-40"
                      >
                        {t('guest_invite_cta')}
                      </button>
                      <button
                        type="button"
                        disabled={invitingGuestId === member.id}
                        onClick={() => handleGuestInvite(member, 'copy')}
                        className="text-[11px] font-semibold text-ink-600 active:opacity-60 disabled:opacity-40"
                      >
                        {t('guest_assign_cta')}
                      </button>
                      {/* Rename — owner or admin (docs/guest-members.md §9.4).
                          The only affordance here that isn't the shared
                          linked-invite mechanism. */}
                      {canManage && (
                        <button
                          type="button"
                          onClick={() => openRenameGuest(member)}
                          className="text-[11px] font-semibold text-ink-500 active:opacity-60 flex items-center gap-1"
                        >
                          <Glyph name="edit" size={11} /> {t('guest_rename_cta')}
                        </button>
                      )}
                    </div>
                    <p className="text-[10px] text-ink-500 mt-1.5 leading-snug">{t('guest_assign_hint')}</p>
                  </div>
                )}
                {/* Per-member safety actions (audit M17). Offered for anyone
                    with a real account other than me — owner included; the
                    group owner is exactly the person who can force-add you. */}
                {member.profileId && member.profileId !== currentUserId && (
                  <div className="flex items-center gap-3 mt-2.5 pt-2.5 border-t border-cream-hairline">
                    <button
                      type="button"
                      onClick={() => setMemberSafety({ mode: 'report', userId: member.profileId!, name: member.name })}
                      className="text-[11px] font-semibold text-ink-400 active:opacity-60"
                    >
                      {t('blk_action_report')}
                    </button>
                    {blocks.some((b) => b.blockedId === member.profileId) ? (
                      <button
                        type="button"
                        onClick={() => handleUnblockMember(member.profileId!, member.name)}
                        className="text-[11px] font-semibold text-ink-600 active:opacity-60"
                      >
                        {t('blk_action_unblock')}
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setMemberSafety({ mode: 'block', userId: member.profileId!, name: member.name })}
                        className="text-[11px] font-semibold text-pay-text active:opacity-60"
                      >
                        {t('blk_action_block')}
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <div className="px-5 pt-4 pb-8">
          {events.length === 0 ? (
            <EmptyState
              icon={Clock3}
              clayIcon="clock"
              tone="blue"
              size="compact"
              title={t('gdp_no_activity')}
              description={t('gdp_no_activity_desc')}
            />
          ) : (
            // The feed as one card with hairline rows; each event wears a
            // tinted icon square in its semantic tone.
            <div className="m-card overflow-hidden divide-y divide-cream-hairline">
              {events.map((event, index) => {
              const display = getActivityDisplay(event, settlements, group, t);
              return (
                <div
                  key={event.id}
                  className="px-3.5 py-3.5 animate-fade-in"
                  style={{ animationDelay: `${index * 30}ms` }}
                >
                  <div className="flex items-start gap-3">
                    <div
                      className={`${ACTIVITY_SQUARE[display.tone]} w-10 h-10 rounded-[14px] flex items-center justify-center shrink-0`}
                      aria-hidden="true"
                    >
                      {display.icon}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-start justify-between gap-3">
                        <p className={`text-[13.5px] font-semibold text-ink-900 leading-snug tracking-[-0.01em] ${display.titleClass ?? ''}`}>
                          {display.title}
                        </p>
                        {display.amount && (
                          <p className={`text-[14px] font-semibold tabular-nums tracking-[-0.01em] shrink-0 ${display.amountClass ?? 'text-ink-900'}`}>
                            {display.amount}
                          </p>
                        )}
                      </div>
                      {display.subtitle && (
                        <p className="text-[11.5px] text-ink-600 mt-0.5">{display.subtitle}</p>
                      )}
                      {display.amountChange && (
                        <p className="text-[11px] text-ink-500 tabular-nums mt-1">{display.amountChange}</p>
                      )}
                      {display.note && (
                        <p className="text-[11px] text-ink-500 mt-1.5 italic break-words">“{display.note}”</p>
                      )}
                      <div className="flex items-center justify-between gap-3 mt-2">
                        <p className="text-[10px] font-semibold text-ink-400 tabular-nums tracking-wide">
                          {formatActivityTime(event.createdAt)}
                        </p>
                        <div className="flex items-center gap-3">
                          {/* Who-changed-what (audit G5/O10). A group_events row
                              and its record_edits rows describe the same act —
                              this links an edit/settlement event straight to the
                              per-field diff for that record. */}
                          {(event.eventType === 'expense_updated' ||
                            event.eventType === 'settlement_added' ||
                            event.eventType === 'settlement_deleted') && (
                            <button
                              type="button"
                              onClick={() =>
                                setHistoryFor({
                                  table: event.entityType === 'group_expense' ? 'group_expenses' : 'group_settlements',
                                  id: event.entityId,
                                })
                              }
                              className="text-[10.5px] font-semibold text-accent-600 active:opacity-70 flex items-center gap-1 min-h-[28px]"
                            >
                              <Glyph name="clock" size={11} /> {t('eh_view_changes')}
                            </button>
                          )}
                          {/* A wrong settle-up (wrong row, double-record from two
                              phones) used to be permanent — the recorder can now
                              remove it and balances recalculate. */}
                          {event.eventType === 'settlement_added' &&
                            (() => {
                              const settlement = settlements.find((s) => s.id === event.entityId);
                              if (!settlement) return null;
                              if (settlement.createdBy && settlement.createdBy !== currentUserId) return null;
                              return (
                                <button
                                  type="button"
                                  onClick={() => void handleRemoveSettlement(settlement)}
                                  className="text-[10.5px] font-semibold text-pay-text active:opacity-70 flex items-center gap-1 min-h-[28px]"
                                >
                                  <Glyph name="trash" size={11} /> {t('stl_remove_cta')}
                                </button>
                              );
                            })()}
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              );
              })}
            </div>
          )}
        </div>
      )}

      {/* Floating action bar — sits just above the BottomNav FAB. Two
          extruded buttons: Add Expense (brand-violet primary, flex-1) and Settle Up
          (the green settle solid, content-width). */}
      {/* Hidden while archived: tg_block_writes_in_archived_group refuses both
          an expense insert and a settlement insert, so offering the buttons
          would only produce a raw GROUP_ARCHIVED error. */}
      {!isArchived && (
      <div className="fixed bottom-[92px] left-0 right-0 px-5 z-30 pointer-events-none">
        <div className="flex gap-2.5 max-w-[440px] mx-auto pointer-events-auto">
          <button
            onClick={() => setShowAddExpense(true)}
            className="m-btn m-btn-primary flex-1 min-h-[42px] py-2.5 gap-1.5 rounded-[14px] text-[12.5px]"
          >
            <Glyph name="plus" size={14} strokeWidth={3} /> {t('group_expense_add')}
          </button>
          <button
            onClick={() => setShowSettle(true)}
            className="m-btn m-btn-green min-h-[42px] py-2.5 px-4 gap-1.5 rounded-[14px] text-[12.5px]"
          >
            <Glyph name="check" size={14} strokeWidth={3} /> {t('group_settle')}
          </button>
        </div>
      </div>
      )}

      </div>

      <AddGroupExpenseModal open={showAddExpense} group={group} recentExpenses={expenses} onClose={() => { setShowAddExpense(false); void reload(); }} />
      <EditGroupExpenseModal open={!!editExpense} group={group} expense={editExpense} onClose={() => { setEditExpense(null); void reload(); }} />
      <SettleUpModal open={showSettle} group={group} debts={shownDebts} currentMemberId={currentMember?.id} onClose={() => { setShowSettle(false); void reload(); }} />
      <GroupSettleUpModal open={showSettleShare} group={group} debts={shownDebts} expenses={expenses} simplify={effectiveSimplify} currentMemberId={currentMember?.id} onClose={() => setShowSettleShare(false)} />
      {/* Who-changed-what (audit G5/O10). actorNames/memberNames reuse the
          same group.members shape the header avatars and reconcile logic
          already derive from — no extra fetch. */}
      <EditHistorySheet
        open={!!historyFor}
        onClose={() => setHistoryFor(null)}
        table={historyFor?.table ?? 'group_expenses'}
        recordId={historyFor?.id ?? ''}
        currency={group.currency}
        actorNames={Object.fromEntries(group.members.filter((m) => m.profileId).map((m) => [m.profileId!, m.name]))}
        memberNames={Object.fromEntries(group.members.map((m) => [m.id, m.name]))}
      />
      <GroupInviteModal open={showInvite} group={group} onClose={() => { setShowInvite(false); void reload(); }} />

      {/* Rename a guest seat (docs/guest-members.md §9.4). Owner or admin,
          unclaimed guest seats only — see the canManage gate on the rename
          button in the balances-tab member row above. */}
      <Modal
        open={!!renamingGuest}
        onClose={() => setRenamingGuest(null)}
        title={t('guest_rename_title')}
        footer={(
          <button
            onClick={handleRenameGuest}
            disabled={renaming || !renameValue.trim()}
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

      {/* Ownership handover — the escape hatch for delete_current_user's
          OWNED_GROUPS_WITH_MEMBERS refusal and for leave_group's
          ONLY_OWNER_ADMIN. Only connected, profile-linked members are offered,
          which is exactly the RPC's own INVALID_NEW_OWNER filter. */}
      <Modal
        open={showTransfer}
        onClose={() => setShowTransfer(false)}
        title={t('grp_transfer_title')}
      >
        <div className="p-5 space-y-3">
          <p className="text-[12px] text-ink-600 leading-relaxed">{t('grp_transfer_body')}</p>
          {transferCandidates.length === 0 ? (
            <p className="text-[12px] text-ink-500 text-center py-6">{t('grp_transfer_none')}</p>
          ) : (
            <div className="space-y-2.5">
              {transferCandidates.map((member) => (
                <button
                  key={member.id}
                  onClick={() => void handleTransferOwnership(member)}
                  disabled={transferringMemberId !== null}
                  className="selector-base gap-3 p-3 disabled:opacity-40"
                >
                  <UserAvatar name={member.name} size={40} />
                  <div className="min-w-0 flex-1">
                    <p className="text-[13.5px] font-semibold text-ink-900 truncate tracking-[-0.01em]">{member.name}</p>
                    <p className="text-[10.5px] text-ink-500 mt-0.5">{memberStatusLabel(t, member)}</p>
                  </div>
                  <Crown size={15} strokeWidth={2.4} className="text-glyph-violet shrink-0" />
                </button>
              ))}
            </div>
          )}
        </div>
      </Modal>

      {/* Co-admins (supabase-migration-group-admins.sql). Owner-only sheet:
          the owner row on top (always an admin, never editable), then every
          seat set_group_admin accepts — connected and on Hisaab — with a
          Make / Remove toggle. Guests, invitees and people who left are not
          listed: the RPC would refuse them (NOT_ELIGIBLE). */}
      <Modal
        open={showAdmins}
        onClose={() => setShowAdmins(false)}
        title={t('grp_admins_title')}
      >
        <div className="p-5 space-y-3">
          <p className="text-[12px] text-ink-600 leading-relaxed">{t('grp_admins_body')}</p>
          {!adminsSupported && (
            <p className="rounded-xl bg-warn-50 px-3 py-2 text-[11px] font-medium text-warn-700 leading-relaxed">
              {t('grp_admins_needs_update')}
            </p>
          )}
          <div className="space-y-2.5">
            {ownerMember && (
              <div className="m-card p-3 flex items-center gap-3">
                <MemberAvatar member={ownerMember} size={40} />
                <div className="min-w-0 flex-1">
                  <p className="text-[13.5px] font-semibold text-ink-900 truncate tracking-[-0.01em]">
                    {ownerMember.name}
                    {ownerMember.profileId === currentUserId ? (
                      <span className="font-semibold text-accent-600">{t('gdp_you_suffix')}</span>
                    ) : null}
                  </p>
                </div>
                <span className="m-chip m-chip-blue m-chip-caps shrink-0">{t('grp_role_owner')}</span>
              </div>
            )}
            {adminSheetMembers.length === 0 ? (
              <p className="text-[12px] text-ink-500 text-center py-4 leading-relaxed">{t('grp_admins_none')}</p>
            ) : adminSheetMembers.map((member) => {
              const memberIsAdmin = isGroupAdmin(member);
              const busy = settingAdminId === member.id;
              return (
                <div key={member.id} className="m-card p-3 flex items-center gap-3">
                  <MemberAvatar member={member} size={40} />
                  <div className="min-w-0 flex-1">
                    <p className="text-[13.5px] font-semibold text-ink-900 truncate tracking-[-0.01em]">{member.name}</p>
                    {memberIsAdmin ? (
                      <span className="m-chip m-chip-blue m-chip-caps mt-1">{t('grp_role_admin')}</span>
                    ) : (
                      <p className="text-[10.5px] text-ink-500 mt-0.5">{t('member_on_app')}</p>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => void handleSetAdmin(member, !memberIsAdmin)}
                    disabled={settingAdminId !== null}
                    aria-busy={busy}
                    className="m-btn m-btn-plain shrink-0 min-h-[36px] px-3 py-2 gap-1.5 rounded-xl text-[11.5px] disabled:opacity-40"
                  >
                    <Glyph
                      name={memberIsAdmin ? 'shield-off' : 'shield-check'}
                      size={13}
                      tone={memberIsAdmin ? 'neutral' : 'blue'}
                      className={busy ? 'animate-pulse' : ''}
                    />
                    {memberIsAdmin ? t('grp_admin_remove') : t('grp_admin_make')}
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      </Modal>

      {/* Block / report a fellow group member (audit M17). */}
      <BlockReportSheet
        open={!!memberSafety}
        mode={memberSafety?.mode ?? 'block'}
        targetUserId={memberSafety?.userId ?? null}
        targetName={memberSafety?.name ?? ''}
        contextType="group_member"
        contextId={group.id}
        onClose={() => setMemberSafety(null)}
      />
    </main>
  );
}
