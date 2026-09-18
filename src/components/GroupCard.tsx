import { Glyph } from './Glyph';
import { UserAvatar } from './UserAvatar';
import { VerifiedBadge } from './VerifiedBadge';
import type { SplitGroup } from '../db';
import { formatMoney } from '../lib/constants';
import { useT } from '../lib/i18n';

// Faces shown in the member stack before it stops — a trip group of twelve
// shouldn't run the row; the "3 / 12 members" line carries the full count.
const STACK_MAX = 4;

interface Props {
  group: SplitGroup;
  balance: number;
  balanceLoaded: boolean;
  settledLabel: string;
  membersLabel: string;
  hasUnreadActivity: boolean;
  // True when the current user paid for an expense in this group that
  // isn't reconciled yet. Surfaces as a small hollow ring next to the state
  // label so the user can scan the list for "what needs my attention"
  // without opening every group. Kept visually distinct from the unread
  // activity dot (filled, top-right of the avatar) so the two never blur.
  hasUnreconciled?: boolean;
  // Number of outstanding balances the current user still has to settle in
  // this group (0 = square). Drives the settle-status pill: "Settled" when
  // zero, "{n} to settle" otherwise. Derived from per-group balances on the
  // Splits page so no extra fetch is needed.
  outstandingCount?: number;
  onClick: () => void;
}

// One row in the Groups list, in the 1d material: a pressable tile (lit face,
// one hard wall that collapses under the finger) holding the emoji in a raised
// control, the member stack, and a hairline footer with the state label, the
// settle chip and this user's balance. Direction lives in the amount colour
// (receive green / pay coral) plus the state WORD, never in the tile tint —
// a list of groups stays calm. The skeleton pulse on the amount prevents a
// misleading "All settled" flash before the batched balance query resolves.
export function GroupCard({
  group,
  balance,
  balanceLoaded,
  settledLabel,
  membersLabel,
  hasUnreadActivity,
  hasUnreconciled,
  outstandingCount,
  onClick,
}: Props) {
  const t = useT();
  const connected = group.members.filter((m) => m.status === 'connected').length;
  const owed = balance > 0.01;
  const owes = balance < -0.01;
  // Archived groups are still fully readable — they just accept nothing new.
  // The tag has to be on the row itself, not only in the section header, so a
  // search result (which is flat) is never ambiguous.
  const isArchived = Boolean(group.archivedAt);
  const currentUserId = localStorage.getItem('hisaab_supabase_uid');
  // The faces still in the group — someone who left is history, not a member
  // to show. The signed-in user wears the violet "self" avatar.
  const stack = group.members.filter((m) => m.status !== 'left').slice(0, STACK_MAX);

  // Settle-status: prefer an explicit outstandingCount from the parent; fall
  // back to deriving it from this user's net balance (non-zero ⇒ one balance
  // left to settle). Pairs the colour with a dot + word so it isn't
  // colour-only.
  const toSettle = outstandingCount ?? (owed || owes ? 1 : 0);
  const isSquare = toSettle === 0;

  // State copy. The group cards label the state explicitly ("You're owed" /
  // "You owe" / "All settled") rather than relying on the +/− sign alone.
  const stateLabel = owed ? t('group_you_owed') : owes ? t('group_you_owe') : settledLabel;

  return (
    <button
      type="button"
      onClick={onClick}
      className={`m-tile rounded-[18px] p-3.5 text-left ${isArchived ? 'opacity-75' : ''}`}
    >
      <span className="flex items-center gap-3">
        <span className="m-ctl relative w-11 h-11 rounded-[15px] flex items-center justify-center text-[19px] leading-none shrink-0">
          {group.emoji}
          {/* Unread-activity dot — present ONLY when there's unread activity, so
              its mere presence (not its colour) carries the meaning. The ring
              is the card face, so the dot reads as cut out of the corner. */}
          {hasUnreadActivity && (
            <span
              role="img"
              className="absolute -top-[3px] -right-[3px] h-3 w-3 rounded-full ring-2 ring-cream-card bg-pay-600"
              aria-label={t('a11y_unread_group')}
            />
          )}
        </span>

        <span className="flex-1 min-w-0">
          <span className="flex items-center gap-1.5 min-w-0 text-[14px] font-medium text-ink-900 tracking-[-0.01em]">
            <span className="truncate">{group.name}</span>
            {isArchived && (
              <span className="m-chip m-chip-neutral m-chip-caps shrink-0">
                {t('grp_archived_tag')}
              </span>
            )}
            {/* Verified seal: this user is square in the group. */}
            {balanceLoaded && isSquare && <VerifiedBadge size={14} title={t('status_settled')} />}
          </span>
          <span className="flex items-center gap-2 mt-1 min-w-0">
            {stack.length > 0 && (
              // Decorative: the members line beside it is the accessible
              // count. Each face is ringed in the card colour so the overlap
              // reads as a stack, not a smear.
              <span className="flex items-center -space-x-1.5 shrink-0" aria-hidden="true">
                {stack.map((member) => (
                  <span key={member.id} className="inline-flex rounded-full ring-2 ring-cream-card">
                    <UserAvatar
                      name={member.name}
                      size={20}
                      self={Boolean(currentUserId) && member.profileId === currentUserId}
                    />
                  </span>
                ))}
              </span>
            )}
            <span className="text-[11px] text-ink-600 truncate">
              {connected} / {group.members.length} {membersLabel}
            </span>
          </span>
        </span>

        <Glyph name="chevron-right" size={14} className="text-ink-400" />
      </span>

      <span className="mt-3 pt-3 border-t border-cream-hairline flex items-center justify-between gap-2">
        <span className="flex items-center gap-[7px] min-w-0">
          <span className="text-[11px] font-semibold text-ink-400 uppercase tracking-[0.08em] truncate">
            {balanceLoaded ? stateLabel : t('loading')}
          </span>
          {/* Unreconciled marker — a hollow amber ring with a '!' glyph, kept
              visually distinct from the filled unread-activity dot on the
              emoji so the two signals never read as the same thing. */}
          {hasUnreconciled && (
            <span
              role="img"
              className="shrink-0 w-[15px] h-[15px] rounded-full border border-warn-600 text-warn-700 flex items-center justify-center text-[9px] font-bold leading-none"
              aria-label={t('a11y_unreconciled')}
              title={t('a11y_unreconciled')}
            >
              !
            </span>
          )}
          {/* Settle-status chip — colour + dot + word, never colour alone:
              gold while something is still to settle, green once square. */}
          {balanceLoaded && (
            <span className={`m-chip shrink-0 ${isSquare ? 'm-chip-receive' : 'm-chip-gold'}`}>
              <span
                className={`w-1.5 h-1.5 rounded-full ${isSquare ? 'bg-receive-600' : 'bg-warn-600'}`}
                aria-hidden="true"
              />
              {isSquare ? t('status_settled') : t('group_to_settle').replace('{n}', String(toSettle))}
            </span>
          )}
        </span>
        {!balanceLoaded ? (
          <span className="m-skel h-3.5 w-16 rounded-full shrink-0" aria-hidden="true" />
        ) : owed ? (
          <span className="text-[14px] font-semibold tabular-nums tracking-[-0.01em] text-receive-text shrink-0">
            +{formatMoney(balance, group.currency)}
          </span>
        ) : owes ? (
          <span className="text-[14px] font-semibold tabular-nums tracking-[-0.01em] text-pay-text shrink-0">
            −{formatMoney(Math.abs(balance), group.currency)}
          </span>
        ) : (
          <span className="text-[12px] font-medium text-ink-400 shrink-0">—</span>
        )}
      </span>
    </button>
  );
}
