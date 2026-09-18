import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { NavyHero, TopBar } from '../components/NavyHero';
import { Glyph } from '../components/Glyph';
import { UserAvatar } from '../components/UserAvatar';
import { PageErrorState } from '../components/PageErrorState';
import { ListSkeleton } from '../components/ListSkeleton';
import { useToast } from '../components/Toast';
import { usePersonStore, DuplicateLinkedContactError } from '../stores/personStore';
import { useSupabaseAuthStore } from '../stores/supabaseAuthStore';
import { codeLookupBudgetSpent, resolveProfileByCode } from '../lib/collaboration';
import { formatLinkError, retryAfterMinutes } from '../lib/contactLinkStatus';
import { extractConnectCode } from '../lib/connectQr';
import { useSubmitGuard } from '../lib/useSubmitGuard';
import { useT } from '../lib/i18n';
import { track } from '../lib/telemetry';

// Landing page for a scanned Hisaab QR (https://usehisaab.com/u/HSB-XXXXXX).
//
// A QR opened in the phone's own camera app has no idea Hisaab exists, so it
// hands the URL to the browser or — once App Links verify — straight to the
// app. Either way it arrives HERE, and here has one job: show who this code
// belongs to and offer to add them. Nothing is written until the user taps.
export function ConnectByCodePage() {
  const { code: rawCode } = useParams<{ code: string }>();
  const navigate = useNavigate();
  const toast = useToast();
  const t = useT();

  const user = useSupabaseAuthStore((s) => s.user);
  const persons = usePersonStore((s) => s.persons);
  const createPerson = usePersonStore((s) => s.createPerson);
  const linkToProfile = usePersonStore((s) => s.linkToProfile);

  const [status, setStatus] = useState<'loading' | 'ready' | 'notfound' | 'limited' | 'error'>('loading');
  const [found, setFound] = useState<{ profileId: string; displayName: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  // Double-tap guard (audit C10/F-8). See src/lib/useSubmitGuard.ts.
  const addGuard = useSubmitGuard();

  const normalised = extractConnectCode(rawCode ?? '');

  const resolve = useCallback(async () => {
    if (!normalised) {
      setStatus('notfound');
      return;
    }
    setStatus('loading');
    try {
      const result = await resolveProfileByCode(normalised);
      if (!result) {
        // A throttled lookup answers with zero rows — same as a genuine miss —
        // so the only signal we have is our own count of charges this hour.
        setStatus(codeLookupBudgetSpent() ? 'limited' : 'notfound');
        return;
      }
      setFound(result);
      setStatus('ready');
    } catch {
      setStatus('error');
    }
  }, [normalised]);

  useEffect(() => {
    // Resolution needs an authenticated session (the lookup RPC excludes the
    // caller's own row). Signed-out visitors get sent to auth; the URL is
    // preserved by the router so they land back here afterwards.
    if (!user?.id) return;
    void resolve();
  }, [user?.id, resolve]);

  // Already in the user's contacts — nothing to do but say so.
  const existing = found ? persons.find((p) => p.linkedProfileId === found.profileId) ?? null : null;

  const handleAdd = () => addGuard.run(runAdd);
  const runAdd = async () => {
    if (!found) return;
    setSaving(true);
    setError('');
    try {
      const created = await createPerson(found.displayName, null);
      // The CODE crosses the wire, not the resolved uuid: only the server may
      // decide which account a code belongs to (audit 2026-09 C6). `found` is
      // passed as the pre-migration fallback and for nothing else.
      let linkState: 'pending' | 'mutual' = 'pending';
      try {
        const linked = await linkToProfile(created.id, normalised ?? '', found);
        linkState = linked.linkState;
      } catch (err) {
        if (err instanceof DuplicateLinkedContactError) {
          setError(t('contact_dup_link_generic'));
          return;
        }
        setError(formatLinkError(err, t));
        return;
      }
      // Catalog #13 — this page is the code-lookup landing for a scanned
      // Hisaab QR, so 'code' regardless of whether the tap that opened the
      // camera was itself a QR scan or a typed code.
      track('contact_link_requested', { via: 'code' });
      toast.show({
        type: 'success',
        title: t('cts_added_connected').replace('{name}', found.displayName),
        // Consent semantics: a link is one-sided until they add you back.
        subtitle:
          linkState === 'mutual'
            ? t('clink_mutual')
            : t('clink_waiting').replace('{name}', found.displayName),
      });
      navigate('/contacts', { replace: true });
    } catch {
      setError(t('addc_link_err_lookup'));
    } finally {
      setSaving(false);
    }
  };

  if (!user?.id) {
    return (
      <main className="min-h-dvh bg-cream-bg">
        <NavyHero accent="pink">
          <TopBar title={t('cbc_title')} back />
          <div className="pb-5" />
        </NavyHero>
        <div className="sukoon-body px-5 pt-6">
          <PageErrorState
            variant="inline"
            title={t('cbc_signin_title')}
            message={t('cbc_signin_body')}
            onRetry={() => navigate('/auth')}
            actionLabel={t('cbc_signin_cta')}
          />
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-dvh bg-cream-bg pb-28">
      {/* 1d: the pink Contacts hero (this page is the contacts domain),
          with the scanned code as the hero's micro-label in the violet ink. */}
      <NavyHero accent="pink">
        <TopBar title={t('cbc_title')} back />
        <div className="px-5 pb-6">
          <p className={`m-label ${normalised ? 'text-accent-600 tabular-nums' : 'text-white/70'}`}>
            {normalised ? `HSB-${normalised}` : t('cbc_invalid_code')}
          </p>
        </div>
      </NavyHero>

      <div className="sukoon-body min-h-[50dvh] px-5 pt-5 space-y-3">
        {status === 'loading' && <ListSkeleton rows={2} />}

        {status === 'notfound' && (
          <PageErrorState
            variant="inline"
            title={t('addc_link_err_notfound')}
            message={t('cbc_notfound_body')}
            onRetry={() => navigate('/contacts')}
            actionLabel={t('cbc_go_contacts')}
          />
        )}

        {status === 'limited' && (
          <PageErrorState
            variant="inline"
            title={t('clink_err_rate_limited').replace('{minutes}', String(retryAfterMinutes(undefined)))}
            message={t('clink_err_no_match')}
            onRetry={() => void resolve()}
          />
        )}

        {status === 'error' && (
          <PageErrorState
            variant="inline"
            title={t('addc_link_err_lookup')}
            message={t('err_page_msg')}
            onRetry={() => void resolve()}
          />
        )}

        {status === 'ready' && found && (
          <>
            <div className="m-card m-card-feature p-5 flex items-center gap-3.5">
              <UserAvatar name={found.displayName} size={44} />
              <div className="min-w-0 flex-1">
                {/* No verified seal here (audit 2026-09 SEC-09): this is a
                    code lookup, not a link — nothing has been accepted by
                    either side yet, and the seal must mean exactly one thing
                    app-wide (an accepted, two-way contact link). */}
                <p className="text-[15px] font-semibold text-ink-900 flex items-center gap-1.5 min-w-0">
                  <span className="truncate">{found.displayName}</span>
                </p>
                <p className="text-[11.5px] text-ink-600 mt-0.5">{t('cbc_on_hisaab')}</p>
              </div>
            </div>

            {existing ? (
              <div className="m-card m-mint p-4 flex items-start gap-3">
                <Glyph name="check" tone="green" size={18} strokeWidth={2.8} className="mt-0.5" />
                <div className="min-w-0">
                  <p className="text-[13px] font-semibold text-ink-900">
                    {t('cbc_already_contact').replace('{name}', existing.name)}
                  </p>
                  <p className="text-[11.5px] text-ink-600 mt-0.5 leading-relaxed">
                    {t('cbc_already_contact_sub')}
                  </p>
                </div>
              </div>
            ) : (
              <>
                <div className="m-card m-violet p-4 flex items-start gap-3">
                  <Glyph name="link" tone="violet" size={17} className="mt-0.5" />
                  <p className="text-[11.5px] text-ink-600 leading-relaxed">
                    {t('addc_link_q_desc')}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => void handleAdd()}
                  disabled={saving}
                  className="m-btn m-btn-primary w-full py-3.5 text-[13.5px]"
                >
                  <Glyph name="user-plus" size={16} strokeWidth={2.6} />
                  {saving ? t('cbc_connecting') : t('addc_cta_linked')}
                </button>
              </>
            )}

            {error && (
              <p role="alert" className="m-card m-coral text-[12px] text-pay-text font-semibold px-3.5 py-3 leading-relaxed">{error}</p>
            )}
          </>
        )}
      </div>
    </main>
  );
}
