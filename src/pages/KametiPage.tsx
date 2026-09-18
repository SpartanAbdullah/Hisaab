import { useCallback, useMemo, useState } from 'react';
import { Coins } from 'lucide-react';
import { format } from 'date-fns';
import { useNavigate } from 'react-router-dom';
import { useCommitteeStore } from '../stores/committeeStore';
import { NavyHero, TopBar } from '../components/NavyHero';
import { LanguageToggle } from '../components/LanguageToggle';
import { EmptyState } from '../components/EmptyState';
import { Glyph } from '../components/Glyph';
import { MoneyDisplay } from '../components/MoneyDisplay';
import { useAsyncLoad } from '../hooks/useAsyncLoad';
import { CreateCommitteeModal } from './CreateCommitteeModal';
import { formatMoney } from '../lib/constants';
import { useT } from '../lib/i18n';
import { skeletonDelay } from '../lib/material';
import { getPrimaryCurrency } from '../lib/primaryCurrency';
import { currentRound, poolAmount, paymentsForRound, roundDate } from '../lib/committeeMath';
import type { Committee, Currency } from '../db';

// The next payout on the calendar: the first round date that is today or
// later. Null once every round date has passed (the last round is running).
function nextPayoutDate(c: Committee, today: Date): Date | null {
  const midnight = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  for (let r = 1; r <= c.totalRounds; r++) {
    const d = roundDate(c.startDate, c.cadence, r);
    if (d.getTime() >= midnight) return d;
  }
  return null;
}

export function KametiPage() {
  const t = useT();
  const navigate = useNavigate();
  const committees = useCommitteeStore((s) => s.committees);
  const loadAll = useCommitteeStore((s) => s.loadAll);
  const membersOf = useCommitteeStore((s) => s.membersOf);
  const paymentsOf = useCommitteeStore((s) => s.paymentsOf);
  const [showCreate, setShowCreate] = useState(false);

  const load = useCallback(async () => { await loadAll(); }, [loadAll]);
  const { status } = useAsyncLoad(load);

  const active = useMemo(() => committees.filter((c) => c.status === 'active'), [committees]);

  // Hero figure: what the user has signed up to pay in over every round of
  // their active kametis (contribution × rounds), per currency — kametis in
  // different currencies are never added together. The primary currency
  // leads when present; the rest ride along on the line underneath.
  const committed = useMemo(() => {
    const totals = new Map<Currency, number>();
    for (const c of active) {
      totals.set(c.currency, (totals.get(c.currency) ?? 0) + c.contributionAmount * c.totalRounds);
    }
    const primary = getPrimaryCurrency();
    const lead = totals.has(primary) ? primary : totals.keys().next().value;
    const others = [...totals].filter(([cur]) => cur !== lead);
    return { lead, leadAmount: lead ? totals.get(lead) ?? 0 : 0, others };
  }, [active]);

  const isFirstLoad = status === 'loading' && committees.length === 0;
  const today = new Date();

  return (
    <main className="min-h-dvh bg-cream-bg pb-28">
      <NavyHero accent="gold">
        <TopBar
          title={t('kameti_title')}
          back
          action={
            <div className="flex items-center gap-2">
              <button
                onClick={() => setShowCreate(true)}
                className="m-key m-gold h-9 px-3 rounded-xl flex items-center gap-1.5 text-[12px] font-semibold"
              >
                <Glyph name="plus" size={13} strokeWidth={2.8} /> {t('naya')}
              </button>
              <LanguageToggle />
            </div>
          }
        />
        <div className="px-5 pb-7">
          {isFirstLoad ? (
            <div aria-hidden="true">
              <div className="m-skel h-[11px] w-28" />
              <div className="m-skel mt-3 h-10 w-52 rounded-xl" />
              <div className="m-skel mt-3 h-[11px] w-20" />
            </div>
          ) : active.length > 0 && committed.lead ? (
            <>
              <p className="text-[10.5px] font-semibold text-white/70 tracking-[0.12em] uppercase">
                {t('kameti_total_committed')}
              </p>
              <div className="mt-2">
                <MoneyDisplay
                  amount={committed.leadAmount}
                  currency={committed.lead}
                  size={38}
                  tone="on-navy"
                  extrude="gold"
                />
              </div>
              <p className="text-[12px] text-white/70 mt-2.5 tabular-nums">
                {t('kameti_active_count').replace('{n}', String(active.length))}
                {committed.others.map(([cur, amt]) => (
                  <span key={cur}>{' · '}{formatMoney(amt, cur)}</span>
                ))}
              </p>
            </>
          ) : (
            <p className="text-[10.5px] font-semibold text-white/70 tracking-[0.12em] uppercase">
              {t('kameti_active_count').replace('{n}', String(active.length))}
            </p>
          )}
          {/* No-custody promise: a hairline-edged glass chip with the green
              shield — the one trust line every kameti screen carries. */}
          <div className="mt-3.5 inline-flex items-center gap-[7px] rounded-full bg-white/10 px-[11px] py-1.5 ring-1 ring-inset ring-white/10">
            <Glyph name="shield" size={12} tone="green" strokeWidth={2.6} />
            <span className="text-[10.5px] font-medium text-white/90">{t('kameti_no_custody')}</span>
          </div>
        </div>
      </NavyHero>

      <div className="sukoon-body min-h-[60dvh] px-5 pt-5">
        {isFirstLoad ? (
          // Skeleton in the loaded card's geometry: glyph tile, two lines,
          // pool figure, progress track.
          <div className="space-y-3" aria-hidden="true">
            {[0, 1, 2].map((i) => {
              const delay = { '--m-skel-delay': skeletonDelay(i) } as React.CSSProperties;
              return (
                <div key={i} className="m-card p-4">
                  <div className="flex items-center gap-3">
                    <div className="m-skel w-10 h-10 rounded-[14px] shrink-0" style={delay} />
                    <div className="flex-1 min-w-0">
                      <div className="m-skel h-[11px] w-[55%]" style={delay} />
                      <div className="m-skel h-[9px] w-[35%] mt-2" style={delay} />
                    </div>
                    <div className="m-skel h-[13px] w-16 shrink-0" style={delay} />
                  </div>
                  <div className="m-skel h-2 w-full rounded-full mt-5" style={delay} />
                </div>
              );
            })}
          </div>
        ) : committees.length === 0 ? (
          <EmptyState
            icon={Coins}
            clayIcon="coins"
            tone="gold"
            title={t('kameti_empty_title')}
            description={t('kameti_empty_desc')}
            actionLabel={t('kameti_empty_cta')}
            onAction={() => setShowCreate(true)}
          />
        ) : (
          <div className="space-y-3">
            {committees.map((c) => {
              const members = membersOf(c.id);
              const payments = paymentsOf(c.id);
              const isActive = c.status === 'active';
              const round = currentRound(c.startDate, c.cadence, c.totalRounds);
              const collected = paymentsForRound(payments, round).length;
              const recipient = members.find((m) => m.slot === round);
              const pool = poolAmount(c.contributionAmount, c.memberCount);
              const next = isActive ? nextPayoutDate(c, today) : null;
              const progress = c.totalRounds > 0 ? Math.min(100, Math.round((round / c.totalRounds) * 100)) : 0;
              return (
                <button
                  key={c.id}
                  onClick={() => navigate(`/kameti/${c.id}`)}
                  className={`m-tile ${isActive ? 'm-gold' : ''} rounded-[18px] p-4`}
                >
                  <div className="flex items-center gap-3">
                    {/* A kameti the user named with an emoji keeps its emoji;
                        everything else gets the coins glyph (a finished one
                        gets the green check). */}
                    <div
                      className={`m-card ${isActive ? 'm-gold' : ''} w-10 h-10 rounded-[14px] flex items-center justify-center shrink-0 text-lg`}
                      aria-hidden="true"
                    >
                      {c.emoji ? c.emoji : isActive ? (
                        <Glyph name="coins" tone="gold" size={20} />
                      ) : (
                        <Glyph name="check" tone="green" size={20} />
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 min-w-0">
                        <p className="text-[14px] font-semibold text-ink-900 tracking-[-0.01em] truncate">{c.name}</p>
                        {!isActive && (
                          <span className="m-chip m-chip-receive m-chip-caps shrink-0">{t('loan_completed')}</span>
                        )}
                      </div>
                      <p className="text-[11px] text-ink-600 mt-0.5 tabular-nums truncate">
                        {formatMoney(c.contributionAmount, c.currency)} · {members.length} {t('kameti_members').toLowerCase()}
                      </p>
                    </div>
                    <div className="text-right shrink-0">
                      <p className={`text-[13px] font-bold tabular-nums ${isActive ? 'text-warn-700' : 'text-ink-900'}`}>
                        {formatMoney(pool, c.currency)}
                      </p>
                      <p className="text-[10px] text-ink-400 mt-0.5">{t('kameti_pool')}</p>
                    </div>
                    <Glyph name="chevron-right" size={15} className="text-ink-400" />
                  </div>

                  {isActive && (
                    <div className="mt-3.5">
                      <div className="flex items-center justify-between gap-2 text-[11px] tabular-nums">
                        <span className="font-semibold text-ink-800">
                          {t('kameti_round_of').replace('{r}', String(round)).replace('{n}', String(c.totalRounds))}
                        </span>
                        {next && (
                          <span className="text-ink-600 truncate">
                            {t('kameti_next_payout').replace('{date}', format(next, 'd MMM'))}
                          </span>
                        )}
                      </div>
                      {/* Round progress: a sunken track with the gold
                          material poured into it. */}
                      <div className="m-inset h-2 rounded-full mt-2 overflow-hidden" aria-hidden="true">
                        <div
                          className="h-full rounded-full bg-gradient-to-b from-gold-300 via-gold-500 to-gold-700"
                          style={{ width: `${progress}%` }}
                        />
                      </div>
                    </div>
                  )}

                  {isActive && c.drawnAt && (
                    <div className="mt-3.5 pt-3 border-t border-ink-900/10 flex items-center justify-between gap-2 text-[10.5px] text-ink-600">
                      <span className="truncate">
                        {recipient ? `${t('kameti_baari_label')}: ${recipient.name}` : t('kameti_undrawn')}
                      </span>
                      <span className="tabular-nums shrink-0">
                        {t('kameti_collected').replace('{paid}', String(collected)).replace('{total}', String(members.length))}
                      </span>
                    </div>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>

      <CreateCommitteeModal open={showCreate} onClose={() => setShowCreate(false)} onCreated={(id) => navigate(`/kameti/${id}`)} />
    </main>
  );
}
