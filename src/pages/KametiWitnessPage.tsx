import { useEffect, useState } from 'react';
import { format } from 'date-fns';
import { committeesDb } from '../lib/supabaseDb';
import { CommitteeVerifyDraw } from '../components/CommitteeVerifyDraw';
import { NavyHero } from '../components/NavyHero';
import { Glyph } from '../components/Glyph';
import { UserAvatar } from '../components/UserAvatar';
import { MoneyDisplay } from '../components/MoneyDisplay';
import { ListSkeleton } from '../components/ListSkeleton';
import { formatMoney } from '../lib/constants';
import { useT } from '../lib/i18n';
import { track } from '../lib/telemetry';
import {
  poolAmount, currentRound, roundDate, recipientForRound, hasPaid, paymentsForRound,
} from '../lib/committeeMath';
import type { Committee, CommitteeMember, CommitteePayment } from '../db';

// Read-only "witness" view of a committee, reachable WITHOUT an account via a
// share token. Renders the same honest ledger every member sees: schedule,
// who-paid-this-round, the baari recipient, and the provably-fair draw to
// verify. No edit controls. Token is parsed from the path so it works whether
// or not it's mounted inside the router.
//
// 1d shell: the gold hero band (NavyHero only — no TopBar, which would bring
// the signed-in Inbox bell to a visitor who has no account) over the sheet.
export function KametiWitnessPage() {
  const t = useT();
  const [data, setData] = useState<{ committee: Committee; members: CommitteeMember[]; payments: CommitteePayment[] } | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'invalid'>('loading');

  useEffect(() => {
    const token = window.location.pathname.split('/').filter(Boolean).pop() ?? '';
    let active = true;
    void committeesDb.getWitness(token)
      .then((res) => {
        if (!active) return;
        if (res) {
          setData(res);
          setStatus('ready');
          // Catalog #23 — deliberately anonymous. A witness has no session
          // and is never identify()'d; this is a bare, unidentified event.
          track('kameti_witness_viewed', {});
        } else {
          setStatus('invalid');
        }
      })
      .catch(() => { if (active) setStatus('invalid'); });
    return () => { active = false; };
  }, []);

  if (status === 'loading') {
    // Skeleton in the loaded page's geometry: hero title block, the trust
    // banner, the pool card, then the member list.
    return (
      <main className="min-h-dvh bg-cream-bg pb-12" aria-busy="true">
        <NavyHero accent="gold">
          <div className="px-5 pt-2 pb-8" aria-hidden="true">
            <div className="m-skel h-[11px] w-32" />
            <div className="m-skel mt-3 h-7 w-56 rounded-lg" />
            <div className="m-skel mt-3 h-[11px] w-44" />
          </div>
        </NavyHero>
        <div className="sukoon-body px-5 pt-5 space-y-4" aria-hidden="true">
          <div className="m-skel h-16 rounded-[18px]" />
          <div className="m-skel h-24 rounded-[18px]" style={{ '--m-skel-delay': '0.15s' } as React.CSSProperties} />
          <ListSkeleton rows={4} />
        </div>
      </main>
    );
  }
  if (status === 'invalid' || !data) {
    return (
      <main className="min-h-dvh m-hero m-hero-gold flex flex-col items-center justify-center px-6 text-center">
        <div className="m-plate m-gold mb-[18px]" aria-hidden="true">
          <Glyph name="link" tone="gold" size={26} extrude />
        </div>
        <p className="text-white text-[15px] font-semibold max-w-[300px] leading-snug">{t('kameti_witness_invalid')}</p>
        <a href="/" className="m-btn m-btn-primary mt-6 text-[13px]">{t('kameti_get_app')}</a>
      </main>
    );
  }

  const { committee, members, payments } = data;
  const pool = poolAmount(committee.contributionAmount, committee.memberCount);
  const round = currentRound(committee.startDate, committee.cadence, committee.totalRounds);
  const collected = paymentsForRound(payments, round).length;
  const recipient = recipientForRound(members, round);

  return (
    <main className="min-h-dvh bg-cream-bg pb-12">
      <NavyHero accent="gold">
        <div className="px-5 pt-2 pb-8">
          <div className="flex items-center gap-1.5 text-white/70">
            <Glyph name="eye" size={14} />
            <span className="text-[10.5px] font-semibold uppercase tracking-[0.12em]">{t('kameti_witness_title')}</span>
          </div>
          <h1 className="text-[22px] font-semibold text-white mt-2 tracking-[-0.02em] leading-tight">{committee.name}</h1>
          <p className="text-[12px] text-white/70 mt-1.5 tabular-nums">
            {formatMoney(committee.contributionAmount, committee.currency)} · {members.length} {t('kameti_members').toLowerCase()} · {t('kameti_round_of').replace('{r}', String(round)).replace('{n}', String(committee.totalRounds))}
          </p>
        </div>
      </NavyHero>

      <div className="sukoon-body px-5 pt-5 space-y-4">
        {/* Witness banner. The expiry and the initials-only notice ride along
            (audit UX-24): a link that dies in 90 days should say so, and
            initials must read as a deliberate privacy setting rather than as
            missing data. */}
        <div className="m-card m-mint flex items-start gap-2.5 p-3.5">
          <Glyph name="shield" size={16} tone="green" className="mt-0.5" />
          <div className="min-w-0">
            <p className="text-[11.5px] text-receive-text leading-relaxed">{t('kameti_witness_banner')}</p>
            {committee.witnessExpiresAt && (
              <p className="text-[10.5px] text-receive-text/80 mt-1 tabular-nums">
                {t('kameti_witness_expires_on').replace('{date}', format(new Date(committee.witnessExpiresAt), 'd MMM yyyy'))}
              </p>
            )}
          </div>
        </div>

        {committee.witnessInitialsOnly && (
          <div className="m-card flex items-start gap-2.5 p-3.5">
            <Glyph name="eye-off" size={15} tone="neutral" className="mt-0.5" />
            <p className="text-[11px] text-ink-600 leading-relaxed">{t('kameti_witness_initials_note')}</p>
          </div>
        )}

        {/* Pool */}
        <div className="m-card m-gold m-card-feature p-5 flex items-end justify-between gap-3">
          <div className="min-w-0">
            <p className="m-label">{t('kameti_pool')}</p>
            <div className="mt-2">
              <MoneyDisplay amount={pool} currency={committee.currency} size={28} extrude="gold" />
            </div>
          </div>
          <span className="m-chip m-chip-receive shrink-0">{t('kameti_sood_free')}</span>
        </div>

        {/* Provably-fair draw */}
        <CommitteeVerifyDraw committee={committee} members={members} />

        {/* This round's recipient */}
        {recipient && (
          <div className="m-card m-gold p-4 flex items-center gap-3">
            <div className="w-10 h-10 flex items-center justify-center shrink-0" aria-hidden="true">
              <Glyph name="trophy" tone="gold" size={26} extrude />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-[10px] font-semibold text-warn-700 uppercase tracking-[0.1em]">{t('kameti_baari_label')}</p>
              <p className="text-[15px] font-semibold text-ink-900 truncate mt-0.5">{recipient.name}</p>
            </div>
            {recipient.payoutReceivedAt && (
              <span className="m-chip m-chip-receive shrink-0">
                <Glyph name="check" size={11} strokeWidth={3} /> {t('kameti_received')}
              </span>
            )}
          </div>
        )}

        {/* This round — read-only paid list */}
        <div>
          <div className="flex items-center justify-between mb-2.5">
            <h2 className="m-label">{t('kameti_this_round')}</h2>
            <span className="text-[11px] font-semibold text-ink-700 tabular-nums">{t('kameti_collected').replace('{paid}', String(collected)).replace('{total}', String(members.length))}</span>
          </div>
          <div className="m-card overflow-hidden divide-y divide-cream-hairline">
            {members.map((m) => {
              const paid = hasPaid(payments, m.id, round);
              return (
                <div key={m.id} className="flex items-center gap-2.5 px-3.5 py-3">
                  <span
                    className={`w-[26px] h-[26px] rounded-full flex items-center justify-center shrink-0 ${paid ? 'm-stat-dot m-stat-dot-receive' : 'm-inset border border-field-border'}`}
                    aria-hidden="true"
                  >
                    {paid && <Glyph name="check" size={13} strokeWidth={3} />}
                  </span>
                  <UserAvatar name={m.name} size={34} />
                  <p className="flex-1 min-w-0 text-[13.5px] font-medium text-ink-900 flex items-center gap-1.5">
                    <span className="truncate">{m.name}</span>
                    {m.slot != null && <span className="text-[10px] text-ink-400 font-semibold shrink-0 tabular-nums">#{m.slot}</span>}
                  </p>
                  <span className={`m-chip shrink-0 ${paid ? 'm-chip-receive' : 'm-chip-pay'}`}>
                    {paid ? t('kameti_paid_badge') : t('kameti_unpaid_badge')}
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        {/* Schedule */}
        <div>
          <h2 className="m-label mb-2.5">{t('kameti_schedule')}</h2>
          <div className="m-card overflow-hidden divide-y divide-cream-hairline">
            {Array.from({ length: committee.totalRounds }, (_, i) => i + 1).map((r) => {
              const rec = recipientForRound(members, r);
              return (
                <div key={r} className={`flex items-center gap-3 px-3.5 py-2.5 ${r === round ? 'bg-warn-50' : ''}`}>
                  <span className={`text-[11px] font-bold tabular-nums w-5 ${r === round ? 'text-warn-700' : 'text-ink-400'}`}>{r}</span>
                  <span className="flex-1 text-[12.5px] text-ink-900 truncate">{rec?.name ?? '—'}</span>
                  {rec?.payoutReceivedAt && <Glyph name="check" size={13} tone="green" strokeWidth={3} />}
                  <span className="text-[10.5px] text-ink-400 tabular-nums shrink-0">{format(roundDate(committee.startDate, committee.cadence, r), 'd MMM')}</span>
                </div>
              );
            })}
          </div>
        </div>

        <a href="/" className="m-btn m-btn-plain w-full text-[12.5px] text-accent-600">{t('kameti_get_app')}</a>
      </div>
    </main>
  );
}
