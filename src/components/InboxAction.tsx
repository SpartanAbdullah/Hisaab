import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Glyph } from './Glyph';
import { useLinkedRequestStore } from '../stores/linkedRequestStore';
import { useSettlementRequestStore } from '../stores/settlementRequestStore';
import { useNotificationStore } from '../stores/notificationStore';
import { useContactLinkStore } from '../stores/contactLinkStore';
import { useSupabaseAuthStore } from '../stores/supabaseAuthStore';
import { countBellItems } from '../lib/notificationCounts';
import { badgeCount } from '../lib/material';
import { useT } from '../lib/i18n';

interface InboxActionProps {
  tone?: 'on-navy' | 'on-cream';
  className?: string;
}

export function InboxAction({ tone = 'on-navy', className = '' }: InboxActionProps) {
  const navigate = useNavigate();
  const t = useT();
  const userId = useSupabaseAuthStore((s) => s.user?.id ?? '');
  // Every input the badge has, assembled by ONE pure function
  // (notificationCounts.countBellItems) so the rule lives in a tested place
  // instead of being re-derived inline here. Selecting the arrays rather than
  // a number keeps the subscriptions reference-stable between loads.
  const linkedRequests = useLinkedRequestStore((s) => s.requests);
  const settlementRequests = useSettlementRequestStore((s) => s.requests);
  const contactLinkRequests = useContactLinkStore((s) => s.requests);
  const notifications = useNotificationStore((s) => s.notifications);
  const mutes = useNotificationStore((s) => s.mutes);
  const { actionable, waiting, total } = useMemo(
    () => countBellItems({
      notifications,
      linkedRequests,
      settlementRequests,
      contactLinkRequests,
      userId,
      mutes,
    }),
    [notifications, linkedRequests, settlementRequests, contactLinkRequests, userId, mutes],
  );
  // The red counter counts everything still open — incoming asks, unread
  // notifications AND the user's own outgoing requests — and the bell rings
  // whenever it shows a number (founder decision 2026-09-18, restoring the
  // pre-4840d6f alert; notificationCounts.countBellItems).
  const hasCount = total > 0;
  const rings = hasCount;

  const isOnNavy = tone === 'on-navy';

  return (
    <button
      onClick={() => navigate('/inbox')}
      className={`m-ctl relative w-9 h-9 flex items-center justify-center shrink-0 before:absolute before:-inset-1 before:content-[''] ${className}`}
      aria-label={
        hasCount
          ? actionable > 0
            ? t('a11y_inbox_pending').replace('{n}', String(total))
            : t('a11y_inbox_waiting').replace('{n}', String(waiting))
          : t('a11y_inbox')
      }
    >
      {/* Halo pulses out from under the button while something needs the
          user. Decorative and pointer-transparent so it never eats the tap. */}
      {rings && (
        <span
          aria-hidden
          className="absolute inset-0 rounded-[12px] bg-pay-600/40 animate-bell-halo pointer-events-none"
        />
      )}
      <span className={`relative inline-flex ${rings ? 'animate-bell-ring' : ''}`}>
        <Glyph name="bell" size={16} className={isOnNavy ? 'text-white/90' : 'text-ink-800'} />
      </span>
      {hasCount && (
        <span
          role="status"
          aria-live="polite"
          className={`m-badge m-badge-coral absolute -top-[3px] -right-[3px] ${rings ? 'animate-bell-badge' : ''}`}
          style={{ '--m-badge-ring': isOnNavy ? 'var(--color-navy-800)' : 'var(--color-cream-bg)' } as React.CSSProperties}
        >
          {badgeCount(total)}
        </span>
      )}
    </button>
  );
}
