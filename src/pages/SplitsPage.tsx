import { useCallback, useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSplitStore } from '../stores/splitStore';
import { useNotificationStore } from '../stores/notificationStore';
import { NavyHero, TopBar } from '../components/NavyHero';
import { MoneyDisplay } from '../components/MoneyDisplay';
import { GroupCard } from '../components/GroupCard';
import { Glyph } from '../components/Glyph';
import { PageErrorState } from '../components/PageErrorState';
import { CreateGroupModal } from './CreateGroupModal';
import { JoinGroupModal } from './JoinGroupModal';
import { useToast } from '../components/Toast';
import { confirmDestructive } from '../components/ConfirmDestructiveSheet';
import { useT } from '../lib/i18n';
import { track } from '../lib/telemetry';
import { useAsyncLoad } from '../hooks/useAsyncLoad';
import { formatMoney } from '../lib/constants';
import { getPrimaryCurrency } from '../lib/primaryCurrency';
import { skeletonDelay } from '../lib/material';
import type { GlyphName } from '../lib/glyphs';

// Header control on the blue hero: the 36px raised 1d button (same recipe as
// TopBar's back button and the bell), with a 44px+ hit area.
const HERO_CTL =
  "m-ctl relative w-9 h-9 flex items-center justify-center shrink-0 before:absolute before:-inset-1 before:content-['']";

// Wraps the `{token}` inside a translated sentence in a node, so the amount in
// "Across groups, you should receive {amount}." can be set in the figure ink
// without splitting the sentence into two keys (word order differs per
// language, so the split has to follow the template, not the code).
function emphasize(template: string, token: string, value: ReactNode): ReactNode {
  const at = template.indexOf(token);
  if (at < 0) return template;
  return (
    <>
      {template.slice(0, at)}
      {value}
      {template.slice(at + token.length)}
    </>
  );
}

// Loading: group-card shells in the loaded list's exact geometry (emoji
// square, name + members line, hairline, state + amount), so nothing jumps
// when the list lands. Blocks breathe on the staggered 1d pulse.
function GroupsListSkeleton() {
  return (
    <div className="flex flex-col gap-2.5" aria-hidden="true">
      {[0, 1, 2].map((i) => {
        const delay = { '--m-skel-delay': skeletonDelay(i) } as CSSProperties;
        return (
          <div key={i} className="m-card p-3.5">
            <div className="flex items-center gap-3">
              <div className="m-skel w-11 h-11 rounded-[15px] shrink-0" style={delay} />
              <div className="flex-1 min-w-0">
                <div className="m-skel h-[11px] w-[46%]" style={delay} />
                <div className="m-skel h-[9px] w-[30%] mt-2" style={delay} />
              </div>
            </div>
            <div className="mt-3 pt-3 border-t border-cream-hairline flex items-center justify-between">
              <div className="m-skel h-[9px] w-[36%]" style={delay} />
              <div className="m-skel h-[12px] w-16" style={delay} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

// Onboarding card for users with zero groups: the handoff's blue education
// card — the groups glyph in a recessed well, the promise, the three benefits
// and the solo-start hint. Copy unchanged; it wraps instead of truncating so
// the whole promise is readable in both languages.
function GroupsEducationCard() {
  const t = useT();
  const benefits: { glyph: GlyphName; title: string; body: string }[] = [
    { glyph: 'split', title: t('groups_edu_split_title'), body: t('groups_edu_split_body') },
    { glyph: 'swap', title: t('groups_edu_track_title'), body: t('groups_edu_track_body') },
    { glyph: 'check', title: t('groups_edu_settle_title'), body: t('groups_edu_settle_body') },
  ];
  return (
    <section className="m-card m-blue p-[18px]">
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-[14px] bg-cobalt-50 shadow-[inset_0_1px_0_var(--m-hi)] flex items-center justify-center shrink-0">
          <Glyph name="groups" size={20} className="text-cobalt-text" />
        </div>
        <div className="min-w-0">
          <p className="text-[14px] font-semibold text-ink-900 tracking-[-0.01em] leading-[1.35]">
            {t('groups_edu_title')}
          </p>
          <p className="text-[11px] text-ink-600 mt-1 leading-[1.55]">
            {t('groups_edu_subtitle')}
          </p>
        </div>
      </div>

      <ul className="mt-4 space-y-2.5">
        {benefits.map(({ glyph, title, body }) => (
          <li key={title} className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-[10px] bg-cobalt-50 shadow-[inset_0_1px_0_var(--m-hi)] flex items-center justify-center shrink-0">
              <Glyph name={glyph} size={14} className="text-cobalt-text" />
            </div>
            <div className="min-w-0 leading-normal">
              <p className="text-[12px] font-semibold text-ink-900 tracking-[-0.01em]">{title}</p>
              <p className="text-[11px] text-ink-600">{body}</p>
            </div>
          </li>
        ))}
      </ul>

      <p className="text-[11px] text-ink-500 mt-4 text-center leading-[1.55]">
        {t('groups_edu_hint')}
      </p>
    </section>
  );
}

// Accept / Decline card for a group the user was added to but has not joined.
// This section is REQUIRED, not a nicety: an 'invited' member fails
// is_group_member(), so the split_groups SELECT policy hides the group row
// entirely (supabase-migration-audit-p0-consent-guards.sql §2.6). Without this
// list — fed by the list_pending_group_memberships RPC, the invitee's only read
// window — the invitation is invisible and undecidable, and the 'invite'
// notification deep-links here for exactly that reason.
function PendingInvitationsSection() {
  const t = useT();
  const toast = useToast();
  const pendingInvitations = useSplitStore((s) => s.pendingInvitations);
  const acceptGroupMembership = useSplitStore((s) => s.acceptGroupMembership);
  const declineGroupMembership = useSplitStore((s) => s.declineGroupMembership);
  const [busyGroupId, setBusyGroupId] = useState<string | null>(null);

  if (pendingInvitations.length === 0) return null;

  const handleAccept = async (groupId: string) => {
    if (busyGroupId) return;
    setBusyGroupId(groupId);
    try {
      const result = await acceptGroupMembership(groupId);
      toast.show({
        type: result.success ? 'success' : 'error',
        title: result.success ? t('ginv_accepted') : t('ginv_accept_failed'),
        subtitle: result.success ? undefined : result.userMessage,
      });
    } catch (err) {
      toast.show({
        type: 'error',
        title: t('ginv_accept_failed'),
        subtitle: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setBusyGroupId(null);
    }
  };

  const handleDecline = async (groupId: string) => {
    if (busyGroupId) return;
    const ok = await confirmDestructive({
      title: t('ginv_decline_confirm_title'),
      description: t('ginv_decline_confirm_body'),
      confirmLabel: t('ginv_decline'),
      cancelLabel: t('not_now'),
      tone: 'warning',
    });
    if (!ok) return;
    setBusyGroupId(groupId);
    try {
      const result = await declineGroupMembership(groupId);
      toast.show({
        type: result.success ? 'success' : 'error',
        title: result.success ? t('ginv_declined') : t('ginv_decline_failed'),
        subtitle: result.success ? undefined : result.userMessage,
      });
    } catch (err) {
      toast.show({
        type: 'error',
        title: t('ginv_decline_failed'),
        subtitle: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setBusyGroupId(null);
    }
  };

  return (
    <section className="pt-2">
      <div className="flex items-center gap-[7px] mb-2.5 px-0.5">
        <Glyph name="mail" size={12} tone="violet" />
        <h2 className="m-label">{t('ginv_pending_heading')}</h2>
        <span className="text-[11px] text-ink-400 font-semibold tabular-nums ms-auto">
          {pendingInvitations.length}
        </span>
      </div>
      <div className="flex flex-col gap-2.5">
        {pendingInvitations.map((invitation) => (
          // Violet-tinted card: an invitation is waiting on YOU, the same
          // attention tone the handoff gives it.
          <article
            key={invitation.groupId}
            className="m-card m-violet px-[15px] py-3.5 animate-fade-in"
          >
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-[14px] bg-accent-50 shadow-[inset_0_1px_0_var(--m-hi)] flex items-center justify-center text-[18px] leading-none shrink-0">
                {invitation.groupEmoji || '👥'}
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-[14px] font-medium text-ink-900 truncate tracking-[-0.01em]">
                  {invitation.groupName}
                </p>
                <p className="text-[11px] text-ink-600 mt-0.5 leading-snug">
                  {t('ginv_pending_sub').replace('{name}', invitation.invitedByName)}
                </p>
              </div>
            </div>
            <div className="mt-3.5 mb-1 flex gap-2.5">
              <button
                type="button"
                onClick={() => void handleAccept(invitation.groupId)}
                disabled={busyGroupId !== null}
                className="m-btn m-btn-green flex-1 min-h-[40px] py-2 text-[12.5px]"
              >
                <Glyph name="check" size={14} strokeWidth={2.8} />
                {t('ginv_accept')}
              </button>
              <button
                type="button"
                onClick={() => void handleDecline(invitation.groupId)}
                disabled={busyGroupId !== null}
                className="m-btn m-btn-plain min-h-[40px] py-2 px-4 text-[12.5px]"
              >
                {t('ginv_decline')}
              </button>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

export function SplitsPage() {
  const { groups, loadGroups, balances, balancesLoaded, loadBalances, unreconciledFlags, loadUnreconciledFlags, loadPendingInvitations } = useSplitStore();
  const { notifications, loadNotifications } = useNotificationStore();
  const [showCreate, setShowCreate] = useState(false);
  const [showJoin, setShowJoin] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const navigate = useNavigate();
  const t = useT();
  const primaryCurrency = getPrimaryCurrency();
  const currentUserId = localStorage.getItem('hisaab_supabase_uid') ?? '';

  // Funnel-top steps for the group loop: opening the sheet vs. actually
  // creating/joining. The gap between these and `group_created`/`group_joined`
  // is the sheet-abandonment rate, which report 10's funnel 3 needs to tell
  // "nobody tries" apart from "everybody tries and fails".
  const openCreate = () => {
    track('group_create_started', { source: 'groups_page' });
    setShowCreate(true);
  };
  const openJoin = () => {
    track('group_join_started', { source: 'groups_page' });
    setShowJoin(true);
  };

  const load = useCallback(async () => {
    await Promise.all([loadGroups(), loadNotifications()]);
    void loadBalances();
    void loadUnreconciledFlags(currentUserId);
    void loadPendingInvitations();
  }, [loadGroups, loadNotifications, loadBalances, loadUnreconciledFlags, loadPendingInvitations, currentUserId]);

  const { status, error, retry } = useAsyncLoad(load);

  useEffect(() => {
    if (groups.length > 0) {
      void loadBalances();
      void loadUnreconciledFlags(currentUserId);
    }
  }, [groups, loadBalances, loadUnreconciledFlags, currentUserId]);

  useEffect(() => {
    const onFocus = () => {
      void loadNotifications();
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [loadNotifications]);

  const hasGroups = groups.length > 0;
  const isInitialLoading = status === 'loading' && !hasGroups;
  const showEducation = status === 'ready' && !hasGroups;
  const unreadGroupIds = new Set(
    notifications
      .filter(
        (notification) =>
          notification.type === 'group_update' &&
          notification.groupId &&
          !notification.readAt,
      )
      .map((notification) => notification.groupId as string),
  );

  // "Across all groups" net — sum of primary-currency group balances. Groups
  // in non-primary currencies are reflected as a small "+ X others" note
  // below the headline so the hero number stays unambiguous.
  const primaryNet = groups
    .filter((g) => g.currency === primaryCurrency)
    .reduce((acc, g) => acc + (balances[g.id] ?? 0), 0);
  const otherCcyGroups = groups.filter((g) => g.currency !== primaryCurrency);
  const q = searchQuery.trim().toLowerCase();
  const matchingGroups = q
    ? groups.filter((g) => g.name.toLowerCase().includes(q))
    : groups;
  // Archived groups stay fully readable but accept nothing new, so they must
  // not sit among the live ones competing for attention. They get their own
  // collapsed section below (group-deletion-guard.sql §3).
  const visibleGroups = matchingGroups.filter((g) => !g.archivedAt);
  const archivedGroups = matchingGroups.filter((g) => Boolean(g.archivedAt));

  // Direction cue under the hero figure. The figure itself stays white and
  // extruded; the WORD carries the direction (receive green / pay coral) so a
  // negative net never rests on the minus sign alone. Withheld until the
  // balances land (the net reads 0 until then) and when the net is zero —
  // a +50 and a −50 group cancel to 0 without either being settled.
  const netCue =
    !balancesLoaded || Math.abs(primaryNet) <= 0.005
      ? null
      : primaryNet > 0
        ? { label: t('group_you_owed'), tone: 'text-receive-text' }
        : { label: t('group_you_owe'), tone: 'text-pay-text' };

  // The status line in the summary card (was a NextStepHint; the handoff's
  // plain sentence with the amount set in the figure ink).
  const hintAmount = (value: number) => (
    <span className="font-semibold text-ink-900 tabular-nums">{formatMoney(value, primaryCurrency)}</span>
  );
  const hintStatus: ReactNode = q
    ? t(visibleGroups.length === 1 ? 'splits_hint_search_match_one' : 'splits_hint_search_match_many').replace('{n}', String(visibleGroups.length))
    : primaryNet === 0
    ? t('splits_hint_settled')
    : primaryNet > 0
    ? emphasize(t('splits_hint_receive'), '{amount}', hintAmount(primaryNet))
    : emphasize(t('splits_hint_pay'), '{amount}', hintAmount(Math.abs(primaryNet)));

  return (
    <main className="min-h-dvh bg-cream-bg pb-28">
      <NavyHero accent="blue">
        <TopBar
          title={t('groups_title')}
          action={
            // Compact icon-only action row. Previously "Join code" carried
            // a text label which on narrow Android screens squeezed the
            // page title (flex-1 + truncate) down to almost nothing,
            // making the actions appear to overlap the heading.
            <div className="flex items-center gap-2">
              <button
                onClick={() => setShowSearch((v) => !v)}
                className={HERO_CTL}
                aria-label={t('a11y_search')}
                aria-pressed={showSearch}
              >
                <Glyph name="search" size={15} className="text-white/90" />
              </button>
              <button
                onClick={openJoin}
                className={HERO_CTL}
                aria-label={t('a11y_join_with_code')}
                title={t('a11y_join_with_code')}
              >
                <Glyph name="key" size={15} className="text-white/90" />
              </button>
              <button
                onClick={openCreate}
                className={HERO_CTL}
                aria-label={t('a11y_create_group')}
              >
                <Glyph name="plus" size={15} strokeWidth={2.6} className="text-white/90" />
              </button>
            </div>
          }
        />

        <div className="px-5 pb-[26px]">
          <p className="text-[10.5px] font-semibold text-white/70 tracking-[0.12em] uppercase">
            {t('grp_hero_across').replace('{currency}', primaryCurrency)}
          </p>
          {isInitialLoading ? (
            <div aria-hidden="true">
              <div className="m-skel mt-2.5 h-[38px] w-48 rounded-xl" />
              <div className="m-skel mt-3 h-[11px] w-36" style={{ '--m-skel-delay': '0.15s' } as CSSProperties} />
            </div>
          ) : hasGroups ? (
            <>
              <div className="mt-2">
                {/* Extruded like every hero figure, in the section's blue. */}
                <MoneyDisplay
                  amount={primaryNet}
                  currency={primaryCurrency}
                  size={38}
                  tone="on-navy"
                  signed
                  extrude="blue"
                />
              </div>
              <p className="text-[12px] text-white/70 mt-2.5">
                {netCue && (
                  <>
                    <span className={`font-semibold ${netCue.tone}`}>{netCue.label}</span>
                    {' · '}
                  </>
                )}
                {groups.length} {groups.length === 1 ? t('grp_unit_split') : t('grp_unit_splits')}
                {otherCcyGroups.length > 0 && (
                  <> {t('grp_other_currencies').replace('{n}', String(otherCcyGroups.length))}</>
                )}
              </p>
            </>
          ) : (
            <>
              <p className="text-white text-[22px] font-semibold tracking-[-0.02em] mt-2 leading-[1.25]">
                {t('grp_no_splits_title')}
              </p>
              <p className="text-[12px] text-white/70 mt-2 max-w-[260px] leading-[1.55]">
                {t('grp_no_splits_body')}
              </p>
            </>
          )}
        </div>
      </NavyHero>

      <div className="sukoon-body min-h-[60dvh] px-5 pt-5 space-y-3.5">
        {showSearch && (
          <div className="relative">
            <Glyph
              name="search"
              size={14}
              className="absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-400 pointer-events-none"
            />
            <input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={t('grp_search_placeholder')}
              className="input-field pl-10 pr-11 text-[13px]"
              autoFocus
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery('')}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 w-9 h-9 flex items-center justify-center text-ink-400 press-xs"
                aria-label={t('a11y_clear_search')}
              >
                <Glyph name="close" size={14} />
              </button>
            )}
          </div>
        )}

        {status === 'error' && (
          <PageErrorState
            variant="inline"
            title={t('groups_load_error_title')}
            message={error ?? t('groups_load_error_msg')}
            onRetry={retry}
          />
        )}

        {/* Create / Join — two pressable tiles, the glyph on the tile face
            with no container behind it: a blue `plus` for "make a new one",
            a neutral `key` for "let me in with this code". Shown on the empty
            screen too (as in the handoff), so the first action is right there
            next to the education card instead of only in the header. */}
        {(hasGroups || showEducation) && (
          <div className="grid grid-cols-2 gap-2.5">
            <button type="button" onClick={openCreate} className="m-tile m-blue rounded-[16px] p-3.5 text-left">
              <Glyph name="plus" size={24} extrude className="block mb-2.5 text-cobalt-text" />
              <span className="block text-[13px] font-semibold text-ink-900 tracking-[-0.01em]">
                {t('groups_action_create_title')}
              </span>
              <span className="block mt-[3px] text-[10.5px] text-ink-600 leading-snug">
                {t('groups_action_create_sub')}
              </span>
            </button>
            <button type="button" onClick={openJoin} className="m-tile rounded-[16px] p-3.5 text-left">
              <Glyph name="key" size={24} tone="neutral" extrude className="block mb-2.5" />
              <span className="block text-[13px] font-semibold text-ink-900 tracking-[-0.01em]">
                {t('groups_action_join_title')}
              </span>
              <span className="block mt-[3px] text-[10.5px] text-ink-600 leading-snug">
                {t('groups_action_join_sub')}
              </span>
            </button>
          </div>
        )}

        {status === 'ready' && hasGroups && (
          <div className="m-card px-[15px] py-[13px]">
            <p className="text-[11.5px] text-ink-600 leading-[1.55]">
              {hintStatus}{' '}
              {q ? t('splits_hint_next_search') : t('splits_hint_next_open')}
            </p>
            {q && (
              <button
                type="button"
                onClick={() => setSearchQuery('')}
                className="mt-1.5 inline-flex items-center gap-1.5 min-h-[32px] text-[12px] font-semibold text-accent-600 active:opacity-70 transition-opacity"
              >
                {t('splits_hint_clear_search')}
                <Glyph name="arrow-right" size={12} />
              </button>
            )}
          </div>
        )}

        {isInitialLoading && <GroupsListSkeleton />}

        <PendingInvitationsSection />

        {/* When every remaining group is archived, the archived section below
            carries the list — showing an empty "no matches" above it would be
            a lie. */}
        {hasGroups && (visibleGroups.length > 0 || archivedGroups.length === 0) && (() => {
          return (
            <section className="pt-2">
              <div className="flex items-center justify-between mb-2.5 px-0.5">
                <h2 className="m-label">{t('groups_list_heading')}</h2>
                <span className="text-[11px] text-ink-400 font-semibold tabular-nums">
                  {visibleGroups.length}
                </span>
              </div>
              {visibleGroups.length === 0 ? (
                <p className="text-[12px] text-ink-500 text-center py-6">
                  {t('grp_no_matches_for').replace('{q}', searchQuery)}
                </p>
              ) : (
                <div className="flex flex-col gap-2.5">
                  {visibleGroups.map((g) => {
                    // Outstanding count from this user's per-group net: a
                    // non-zero balance means one balance still to settle in
                    // that group. Reuses the already-loaded balances map so
                    // there's no extra fetch.
                    const groupBalance = balances[g.id] ?? 0;
                    const outstandingCount = Math.abs(groupBalance) > 0.01 ? 1 : 0;
                    return (
                      <GroupCard
                        key={g.id}
                        group={g}
                        balance={groupBalance}
                        balanceLoaded={balancesLoaded}
                        settledLabel={t('group_settled')}
                        membersLabel={t('group_members_count')}
                        hasUnreadActivity={unreadGroupIds.has(g.id)}
                        hasUnreconciled={Boolean(unreconciledFlags[g.id])}
                        outstandingCount={outstandingCount}
                        onClick={() => navigate(`/group/${g.id}`)}
                      />
                    );
                  })}
                </div>
              )}
            </section>
          );
        })()}

        {archivedGroups.length > 0 && (
          <section className="pt-2">
            <button
              onClick={() => setShowArchived((v) => !v)}
              className="w-full min-h-[44px] flex items-center gap-[7px] px-0.5 text-left"
              aria-expanded={showArchived}
            >
              <Glyph name="archive" size={13} className="text-ink-400" />
              {/* span, not h2 — heading content inside a <button> is invalid. */}
              <span className="m-label">{t('grp_archived_section')}</span>
              <span className="ms-auto flex items-center gap-1.5 text-[11px] text-ink-400 font-semibold tabular-nums">
                {archivedGroups.length}
                <Glyph
                  name="chevron-down"
                  size={12}
                  className={`transition-transform ${showArchived ? 'rotate-180' : ''}`}
                />
              </span>
            </button>
            {showArchived && (
              <div className="flex flex-col gap-2.5 mt-1">
                {archivedGroups.map((g) => {
                  const groupBalance = balances[g.id] ?? 0;
                  return (
                    <GroupCard
                      key={g.id}
                      group={g}
                      balance={groupBalance}
                      balanceLoaded={balancesLoaded}
                      settledLabel={t('group_settled')}
                      membersLabel={t('group_members_count')}
                      hasUnreadActivity={unreadGroupIds.has(g.id)}
                      hasUnreconciled={Boolean(unreconciledFlags[g.id])}
                      outstandingCount={Math.abs(groupBalance) > 0.01 ? 1 : 0}
                      onClick={() => navigate(`/group/${g.id}`)}
                    />
                  );
                })}
              </div>
            )}
          </section>
        )}

        {showEducation && <GroupsEducationCard />}
      </div>

      <CreateGroupModal
        open={showCreate}
        onClose={() => {
          setShowCreate(false);
          void loadGroups();
        }}
      />
      <JoinGroupModal
        open={showJoin}
        onClose={() => {
          setShowJoin(false);
          void loadGroups();
        }}
      />
    </main>
  );
}
