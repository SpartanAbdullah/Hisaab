import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Glyph } from '../components/Glyph';
import { useSplitStore } from '../stores/splitStore';
import { useToast } from '../components/Toast';
import { clearPendingInvite } from '../lib/pendingInvite';
import { useT } from '../lib/i18n';
import {
  inviteStatusCanRetry,
  inviteStatusMessageKey,
  inviteStatusTitleKey,
  type InviteAcceptFailureStatus,
} from '../lib/joinCodeStatus';
import { track } from '../lib/telemetry';

interface InviteFailure {
  status: InviteAcceptFailureStatus;
  canRetry: boolean;
}

// Audit 2026-09 (H3 / SEC-07): accept_group_invite no longer RAISEs on a
// business outcome — a RAISE would roll back the invite_accept_attempts row its
// rate limiter counts. Failures arrive as a STATUS, so this page reads statuses
// rather than sniffing exception strings. The store still maps a thrown/legacy
// error into the same vocabulary (joinCodeStatus.inviteStatusFromThrown), so
// there is exactly one code path either way.
function classifyInviteStatus(status: InviteAcceptFailureStatus): InviteFailure {
  return { status, canRetry: inviteStatusCanRetry(status) };
}

export function JoinGroupPage() {
  const { token } = useParams<{ token: string }>();
  const navigate = useNavigate();
  const toast = useToast();
  const t = useT();
  const { acceptInvite } = useSplitStore();
  const [loading, setLoading] = useState(false);
  const [joined, setJoined] = useState(false);
  const [failure, setFailure] = useState<InviteFailure | null>(null);

  const failureTitle = failure ? t(inviteStatusTitleKey(failure.status)) : '';
  const failureMessage = failure ? t(inviteStatusMessageKey(failure.status)) : '';

  // Catalog #17. The middle step of the group viral loop (report 10 funnel 3:
  // invite shared → invite opened → auth → joined). `is_authed` splits the
  // people who must sign up first from returning users, which is the whole
  // point of a k-factor measurement.
  useEffect(() => {
    track('group_invite_opened', { is_authed: Boolean(localStorage.getItem('hisaab_supabase_uid')) });
  }, []);

  const handleJoin = async () => {
    if (!token) return;
    setLoading(true);
    setFailure(null);
    try {
      const result = await acceptInvite(token);
      if (result.status !== 'ok') {
        const classified = classifyInviteStatus(result.status);
        setFailure(classified);
        if (!classified.canRetry) clearPendingInvite(token);
        // Only toast for retry-able cases; persistent failures are shown inline
        // and would otherwise produce duplicate messaging that vanishes mid-read.
        if (classified.canRetry) {
          toast.show({
            type: 'error',
            title: t(inviteStatusTitleKey(result.status)),
            subtitle: t(inviteStatusMessageKey(result.status)),
          });
        }
        return;
      }
      clearPendingInvite(token);
      // Catalog #18 — the loop closes here.
      track('group_joined', { via: 'link', surface: 'invite_page' });
      setJoined(true);
      toast.show({ type: 'success', title: t('join_success_title'), subtitle: t('join_success_subtitle') });
      setTimeout(() => navigate(`/group/${result.groupId}`, { replace: true }), 450);
    } finally {
      setLoading(false);
    }
  };

  const dismissInvite = () => {
    clearPendingInvite(token);
    navigate(failure && !failure.canRetry ? '/' : '/groups', { replace: true });
  };

  // The plate + glyph say which of the three states this is — joined (green
  // check), failed (coral alert) or the invitation itself (the splits blue) —
  // each alongside its own title, so colour is never the only cue.
  const plate = joined
    ? { tint: 'm-mint', glyph: 'check' as const, tone: 'green' as const }
    : failure
      ? { tint: 'm-coral', glyph: 'alert' as const, tone: 'coral' as const }
      : { tint: 'm-blue', glyph: 'groups' as const, tone: 'blue' as const };

  return (
    <div className="min-h-dvh bg-cream-bg flex items-center justify-center px-5">
      <div className="m-card m-card-feature w-full max-w-md p-6 text-center">
        <div className={`m-plate ${plate.tint} mx-auto`} aria-hidden="true">
          <Glyph name={plate.glyph} size={26} tone={plate.tone} extrude />
        </div>

        <h1 className="text-[17px] font-semibold tracking-[-0.01em] text-ink-900 mt-[18px]">
          {joined ? t('invite_page_joined_title') : failure ? failureTitle : t('invite_page_title')}
        </h1>
        <p className="text-[12.5px] text-ink-600 mt-2 leading-relaxed">
          {joined
            ? t('invite_page_joined_body')
            : failure
              ? failureMessage
              : t('invite_page_intro')}
        </p>

        {!joined && !failure && (
          <div className="m-inset px-4 py-3 mt-5 text-left">
            <div className="flex items-start gap-3">
              <div className="m-ctl w-9 h-9 rounded-[11px] flex items-center justify-center shrink-0">
                <Glyph name="link" size={16} tone="blue" />
              </div>
              <div>
                <p className="text-[13px] font-semibold text-ink-900">{t('invite_page_next_title')}</p>
                <p className="text-[12px] text-ink-600 mt-1 leading-relaxed">
                  {t('invite_page_next_body')}
                </p>
              </div>
            </div>
          </div>
        )}

        <div className="mt-6 mb-1 flex gap-2.5">
          <button
            onClick={dismissInvite}
            className="m-btn m-btn-plain flex-1 text-[13.5px]"
          >
            {failure && !failure.canRetry ? t('invite_page_go_home') : t('not_now')}
          </button>
          {(!failure || failure.canRetry) && (
            <button
              onClick={handleJoin}
              disabled={loading || !token || joined}
              className="m-btn m-btn-primary flex-1 text-[13.5px]"
            >
              {loading
                ? t('invite_page_joining')
                : joined
                  ? t('invite_page_opening')
                  : failure
                    ? t('invite_page_try_again')
                    : t('invite_page_join_cta')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
