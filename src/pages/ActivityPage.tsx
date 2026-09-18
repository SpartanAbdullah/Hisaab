import { useCallback, useState } from 'react';
import { format, isToday, isYesterday } from 'date-fns';
import { Clock } from 'lucide-react';
import { useActivityStore } from '../stores/activityStore';
import { useNotificationStore } from '../stores/notificationStore';
import { NavyHero, TopBar } from '../components/NavyHero';
import { LanguageToggle } from '../components/LanguageToggle';
import { EmptyState } from '../components/EmptyState';
import { PageErrorState } from '../components/PageErrorState';
import { ListSkeleton } from '../components/ListSkeleton';
import { Glyph } from '../components/Glyph';
import { useAsyncLoad } from '../hooks/useAsyncLoad';
import { useT } from '../lib/i18n';
import type { GlyphName, GlyphTone } from '../lib/glyphs';
import { renderNotificationContent } from '../lib/notificationContent';

// 1d row icon per activity kind: a 40px tinted square + 3c glyph. The tint
// keeps the old colour semantics (new = violet, money in/settled = mint,
// removals and group spends = coral, moves = blue, edits = neutral).
const ACTIVITY_ICON: Record<string, { square: string; glyph: GlyphName; tone: GlyphTone }> = {
  account_created: { square: 'm-card m-blue', glyph: 'bank', tone: 'blue' },
  account_deleted: { square: 'm-card m-coral', glyph: 'trash', tone: 'coral' },
  transaction_created: { square: 'm-card m-violet', glyph: 'plus', tone: 'violet' },
  opening_balance: { square: 'm-card m-violet', glyph: 'bank', tone: 'violet' },
  loan_created: { square: 'm-card m-violet', glyph: 'coins', tone: 'violet' },
  emi_paid: { square: 'm-card m-mint', glyph: 'card', tone: 'green' },
  loan_settled: { square: 'm-card m-mint', glyph: 'check', tone: 'green' },
  group_settlement: { square: 'm-card m-mint', glyph: 'check', tone: 'green' },
  goal_created: { square: 'm-card m-mint', glyph: 'savings', tone: 'green' },
  goal_contribution: { square: 'm-card m-mint', glyph: 'savings', tone: 'green' },
  transaction_modified: { square: 'm-ctl', glyph: 'edit', tone: 'neutral' },
  transaction_deleted: { square: 'm-card m-coral', glyph: 'trash', tone: 'coral' },
  transfer: { square: 'm-card m-blue', glyph: 'swap', tone: 'blue' },
  group_created: { square: 'm-card m-blue', glyph: 'groups', tone: 'blue' },
  group_expense: { square: 'm-card m-blue', glyph: 'split', tone: 'blue' },
};
const DEFAULT_ICON = { square: 'm-ctl', glyph: 'activity', tone: 'neutral' } as const;

type Tab = 'shared' | 'personal';

export function ActivityPage() {
  const { activities, loadActivities } = useActivityStore();
  const { notifications, loadNotifications, markAllRead, unreadCount } = useNotificationStore();
  // Paging state for the Shared tab (founder request 2026-09-03). The store
  // fetches the newest 15 rows plus every unread row; older pages arrive only
  // when the user asks. See `notificationsDb.getPage` / `getUnread`.
  const notificationsTotal = useNotificationStore((s) => s.notificationsTotal);
  const hasMoreNotifications = useNotificationStore((s) => s.hasMoreNotifications);
  const loadingMoreNotifications = useNotificationStore((s) => s.loadingMoreNotifications);
  const loadMoreNotifications = useNotificationStore((s) => s.loadMoreNotifications);
  const t = useT();
  // Default to Shared so any unread notifications surface immediately. The
  // tab choice is intentionally session-local — we don't persist it, since
  // most visits to /activity are short and people land here from the bell
  // badge expecting to see what's new first.
  const [tab, setTab] = useState<Tab>('shared');

  const load = useCallback(async () => {
    await Promise.all([loadActivities(), loadNotifications()]);
  }, [loadActivities, loadNotifications]);
  const { status: loadStatus, error: loadError, retry: retryLoad } = useAsyncLoad(load);

  function getDateLabel(dateStr: string): string {
    const date = new Date(dateStr);
    if (isToday(date)) return t('activity_today');
    if (isYesterday(date)) return t('activity_yesterday');
    return format(date, 'dd MMM yyyy');
  }

  const grouped = activities.reduce((acc, activity) => {
    const label = getDateLabel(activity.timestamp);
    if (!acc[label]) acc[label] = [];
    acc[label].push(activity);
    return acc;
  }, {} as Record<string, typeof activities>);

  const hasAnyItems = notifications.length > 0 || activities.length > 0;

  return (
    <main className="min-h-dvh bg-cream-bg pb-28">
      <NavyHero>
        <TopBar
          title={t('activity_title')}
          back
          action={
            <div className="flex items-center gap-2">
              {tab === 'shared' && unreadCount > 0 && (
                <button
                  onClick={() => void markAllRead()}
                  className="m-ctl h-9 px-3 flex items-center gap-1.5 text-[11.5px] font-semibold text-white/90"
                  aria-label={t('a11y_mark_all_read')}
                >
                  <Glyph name="check" size={13} strokeWidth={3} />
                  {t('act_mark_read_short')}
                </button>
              )}
              <LanguageToggle />
            </div>
          }
        />
        <div className="px-5 pb-7">
          <p className="text-[10.5px] font-semibold text-white/70 tracking-[0.12em] uppercase">
            {tab === 'shared'
              ? t('mv_act_hero_shared').replace('{n}', String(notifications.length)) +
                (unreadCount > 0 ? ` · ${t('mv_act_hero_unread').replace('{n}', String(unreadCount))}` : '')
              : activities.length === 1
                ? t('mv_act_hero_personal_one')
                : t('mv_act_hero_personal_many').replace('{n}', String(activities.length))}
          </p>
        </div>
      </NavyHero>

      <div className="sukoon-body min-h-[60dvh] px-5 pt-5 space-y-4">
        {/* Tab pills — Shared / Personal. The coral dot on Shared signals
            unread shared notifications regardless of which tab is active,
            so unread state lives at the tab level only (per the spec) and
            not on individual notification rows. */}
        <div className="flex gap-2">
          <TabPill
            label={t('mv_act_tab_shared')}
            active={tab === 'shared'}
            onClick={() => setTab('shared')}
            showDot={unreadCount > 0}
          />
          <TabPill
            label={t('mv_act_tab_personal')}
            active={tab === 'personal'}
            onClick={() => setTab('personal')}
          />
        </div>

        {loadStatus === 'error' && (
          <PageErrorState
            variant="inline"
            title={t('act_err_load')}
            message={loadError ?? t('err_some_data_failed')}
            onRetry={retryLoad}
          />
        )}

        {loadStatus === 'loading' && !hasAnyItems ? (
          <ListSkeleton rows={4} />
        ) : !hasAnyItems ? (
          loadStatus === 'ready' ? (
            <EmptyState
              icon={Clock}
              clayIcon="activity"
              tone="violet"
              title={t('empty_activity_title')}
              description={t('empty_activity_desc')}
              subhint={t('empty_activity_subhint')}
            />
          ) : null
        ) : tab === 'shared' ? (
          notifications.length === 0 ? (
            <div className="m-inset p-4 text-[12px] text-ink-500 text-center">
              {t('ntf_no_shared_yet')}
            </div>
          ) : (
            <div className="space-y-2.5">
              <div className="m-card overflow-hidden divide-y divide-cream-hairline">
              {notifications.map((notification, index) => {
                // Group notifications are template+params rows written by the
                // server now, so this renders in the reader's language instead
                // of the actor's frozen English (audit N-1). Legacy rows fall
                // back to their stored title/body.
                const content = renderNotificationContent(notification, t);
                return (
                  <div
                    key={notification.id}
                    className="px-4 py-3.5 flex items-start gap-3 animate-fade-in"
                    style={{ animationDelay: `${Math.min(index, 8) * 30}ms` }}
                  >
                    <div className="m-card m-violet w-10 h-10 rounded-[14px] flex items-center justify-center shrink-0">
                      <Glyph name="bell" tone="violet" size={19} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-[13.5px] font-semibold text-ink-900 leading-snug tracking-tight">
                        {content.title}
                      </p>
                      <p className="text-[12px] text-ink-600 mt-1 leading-relaxed">
                        {content.body}
                      </p>
                      <p className="text-[10.5px] text-ink-400 mt-1 tabular-nums">
                        {format(new Date(notification.createdAt), 'dd MMM, h:mm a')}
                      </p>
                    </div>
                  </div>
                );
              })}
              </div>

              {/* Honest footer. "N of M" is the rows this device holds against
                  the exact server-side count that rode along free with the
                  first page — not an estimate, and not a claim that the rest
                  do not exist. The button fetches the next 15 by keyset cursor
                  and merges them in; nothing already on screen moves. */}
              {notificationsTotal !== null && notificationsTotal > notifications.length && (
                <p className="text-[10.5px] text-ink-500 px-1 pt-1 tabular-nums">
                  {t('list_showing_n_of_m')
                    .replace('{n}', String(notifications.length))
                    .replace('{m}', String(notificationsTotal))}
                </p>
              )}
              {hasMoreNotifications && (
                <button
                  type="button"
                  onClick={() => void loadMoreNotifications()}
                  disabled={loadingMoreNotifications}
                  className="m-btn m-btn-plain w-full text-[12.5px]"
                >
                  {loadingMoreNotifications ? t('list_loading_more') : t('list_load_more')}
                </button>
              )}
            </div>
          )
        ) : activities.length === 0 ? (
          <div className="m-inset p-4 text-[12px] text-ink-500 text-center">
            {t('act_no_personal_yet')}
          </div>
        ) : (
          <div className="space-y-5">
            {Object.entries(grouped).map(([dateLabel, items]) => (
              <div key={dateLabel}>
                <p className="text-[10.5px] font-semibold text-ink-500 uppercase tracking-[0.12em] mb-2.5 px-1">
                  {dateLabel}
                </p>
                <div className="m-card overflow-hidden divide-y divide-cream-hairline">
                  {items.map((activity, index) => {
                    const icon = ACTIVITY_ICON[activity.type] ?? DEFAULT_ICON;
                    return (
                      <div
                        key={activity.id}
                        className="px-4 py-3.5 flex items-start gap-3 animate-fade-in"
                        style={{ animationDelay: `${Math.min(index, 8) * 30}ms` }}
                      >
                        <div className={`${icon.square} w-10 h-10 rounded-[14px] flex items-center justify-center shrink-0`}>
                          <Glyph name={icon.glyph} tone={icon.tone} size={19} />
                        </div>
                        <div className="flex-1 min-w-0 pt-0.5">
                          <p className="text-[13.5px] text-ink-900 leading-snug tracking-tight">
                            {activity.description}
                          </p>
                          <p className="text-[10.5px] text-ink-400 mt-1 tabular-nums">
                            {format(new Date(activity.timestamp), 'h:mm a')}
                          </p>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </main>
  );
}

// Shared / Personal tab — the 1d pill (light-faced when active). The coral
// dot rides on the Shared tab while anything there is unread.
function TabPill({
  label,
  active,
  onClick,
  showDot,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  showDot?: boolean;
}) {
  const t = useT();
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className="m-pill shrink-0"
    >
      {label}
      {showDot && (
        <span
          className="w-1.5 h-1.5 rounded-full bg-pay-600 shrink-0"
          role="img"
          aria-label={t('a11y_unread')}
        />
      )}
    </button>
  );
}
