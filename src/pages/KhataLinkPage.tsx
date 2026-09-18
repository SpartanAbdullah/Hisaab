import { useEffect, useMemo, useState } from 'react';
import { format } from 'date-fns';
import { Glyph } from '../components/Glyph';
import { skeletonDelay } from '../lib/material';
import { khataLinksDb } from '../lib/supabaseDb';
import { daysUntilExpiry, type KhataView } from '../lib/khataLinkStatus';
import { buildStatement, type StatementSection } from '../lib/statementOfAccount';
import { buildAppShareUrl } from '../lib/collaboration';
import { formatMoney } from '../lib/constants';
import { useT } from '../lib/i18n';

// The PUBLIC per-counterparty ledger — "your khata with X" — reachable WITHOUT
// an account at /khata/:token (audit P3 / L2; 11-competitive-analysis O2+G3).
//
// Mounted by App.tsx's public-route switch before every gate, exactly like
// KametiWitnessPage, so a WhatsApp link opens in any browser even while the
// app is version-blocked or the visitor has never signed in. The token is read
// from the path rather than from a router param for the same reason: the page
// works whether or not it is mounted inside the router.
//
// Its reader may never have used Hisaab, so the page explains itself: what it
// is, who it belongs to, that it is read-only, and what to do if a number
// looks wrong.
//
// THE LEDGER IS BUILT BY buildStatement — the SAME engine the in-app Statement
// of Account uses. That is deliberate: it means the public page and the
// owner's own statement can never disagree about what was paid, and it is what
// makes ledger-only (`splits_only`) history legible here. A splits_only
// repayment arrives as a transaction row with BOTH account ids null (which the
// projection never carried anyway), and the very oldest ledger-only repayments
// — which mutated the loan's remaining amount with no row at all — surface as
// buildStatement's synthesised "repayments (summary)" line. Neither can go
// silently missing (tasks/lessons.md, 2026-07-18).
const round2 = (n: number): number => Math.round(n * 100) / 100;
const isSettled = (n: number): boolean => Math.abs(n) <= 0.005;

function fmtDate(iso: string): string {
  const at = Date.parse(iso);
  return Number.isFinite(at) ? format(new Date(at), 'd MMM yyyy') : '—';
}

export function KhataLinkPage() {
  const t = useT();
  const [view, setView] = useState<KhataView | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'invalid'>('loading');

  useEffect(() => {
    const token = window.location.pathname.split('/').filter(Boolean).pop() ?? '';
    let active = true;
    void khataLinksDb
      .getView(token)
      .then((res) => {
        if (!active) return;
        if (res) {
          setView(res);
          setStatus('ready');
        } else {
          setStatus('invalid');
        }
      })
      .catch(() => {
        if (active) setStatus('invalid');
      });
    return () => {
      active = false;
    };
  }, []);

  const statement = useMemo(() => {
    if (!view) return null;
    return buildStatement({
      partyName: view.personName,
      loans: view.loans,
      transactions: view.transactions,
      asOf: view.asOf,
      scope: 'contact',
    });
  }, [view]);

  if (status === 'loading') {
    // The page shell in its final geometry — hero band, then the headline
    // card and ledger rows as skeleton blocks on the sheet.
    const delay = (i: number) => ({ '--m-skel-delay': skeletonDelay(i) }) as React.CSSProperties;
    return (
      <main className="min-h-dvh bg-cream-bg pb-12">
        <div className="m-hero m-hero-violet px-5 pt-[max(20px,env(safe-area-inset-top))] pb-9" aria-hidden>
          <div className="m-skel h-3 w-32" />
          <div className="m-skel h-6 w-56 mt-3 rounded-lg" style={delay(1)} />
          <div className="m-skel h-3 w-28 mt-3" style={delay(2)} />
        </div>
        <div className="sukoon-body px-5 pt-5 space-y-4">
          <p className="sr-only" role="status">{t('khata_page_loading')}</p>
          <div className="m-skel h-[110px] rounded-[18px]" aria-hidden />
          <div className="m-skel h-[180px] rounded-[18px]" style={delay(1)} aria-hidden />
        </div>
      </main>
    );
  }

  // ONE state for every refusal the server makes — unknown, revoked, expired,
  // owner deleted, blocked pair, rate-limited. The server answers all of them
  // with the same NULL on purpose, so the page must not pretend to know more.
  if (status === 'invalid' || !view || !statement) {
    return (
      <main className="m-hero m-hero-violet min-h-dvh flex flex-col items-center justify-center px-6 text-center">
        <div className="m-plate m-violet mb-[18px]" aria-hidden>
          <Glyph name="lock" size={26} tone="violet" extrude />
        </div>
        <p className="text-white text-[15px] font-semibold tracking-[-0.01em]">{t('khata_page_invalid')}</p>
        <p className="text-white/70 text-[12.5px] mt-2 leading-relaxed max-w-xs">{t('khata_page_invalid_sub')}</p>
        <a href={buildAppShareUrl()} className="m-btn m-btn-primary mt-6 text-[13px]">
          {t('khata_page_cta_button')}
        </a>
      </main>
    );
  }

  const { ownerName, personName } = view;
  const sections: StatementSection[] = statement.sections;
  const expiryDays = daysUntilExpiry(view.expiresAt);

  // The headline uses the ledger's own reconciled closing balance, not a
  // separately-summed figure, so the number at the top always equals the last
  // line of the table below it.
  const headlineSections = sections.length > 0
    ? sections
    : view.net.map((n) => ({ currency: n.currency, lines: [], closing: n.balance, estimated: false }));

  const netLabel = (closing: number) => {
    if (isSettled(closing)) return t('khata_net_settled');
    const key = closing > 0 ? 'khata_net_person_owes' : 'khata_net_owner_owes';
    return t(key).replace('{person}', personName).replace('{owner}', ownerName);
  };

  return (
    <main className="min-h-dvh bg-cream-bg pb-12">
      {/* Navy hero — same shell as the kameti witness page, so the two public
          surfaces read as one product. */}
      <div className="m-hero m-hero-violet px-5 pt-[max(20px,env(safe-area-inset-top))] pb-9">
        <div className="flex items-center gap-1.5 text-white/70">
          <Glyph name="eye" size={14} />
          <span className="text-[10.5px] font-semibold uppercase tracking-[0.12em]">{t('khata_page_eyebrow')}</span>
        </div>
        <h1 className="text-[22px] font-semibold text-white mt-2 tracking-[-0.02em] leading-tight">
          {t('khata_page_between').replace('{owner}', ownerName).replace('{person}', personName)}
        </h1>
        <p className="text-[12px] text-white/70 mt-1.5 tabular-nums">
          {t('khata_page_as_of').replace('{date}', fmtDate(view.asOf))}
        </p>
      </div>

      <div className="sukoon-body px-5 pt-5 space-y-4">
        {/* Read-only banner. The visitor must never wonder whether tapping
            something here changes the other side's records. */}
        <div className="m-card m-blue flex items-start gap-2.5 p-3.5">
          <Glyph name="lock" size={15} tone="blue" className="mt-0.5" />
          <p className="text-[11.5px] text-cobalt-text leading-relaxed">
            {t('khata_page_banner').replace('{owner}', ownerName)}
          </p>
        </div>

        {/* Per-currency headline. PKR is never quietly summed into AED — a
            person can hold both directions and several currencies at once. */}
        {headlineSections.map((section) => {
          const settled = isSettled(section.closing);
          const theyOwe = section.closing > 0;
          return (
            <div
              key={section.currency}
              className={`m-card m-card-feature ${settled || theyOwe ? 'm-mint' : 'm-coral'} p-4`}
            >
              <p className={`text-[10.5px] font-semibold uppercase tracking-[0.12em] ${settled || theyOwe ? 'text-receive-text' : 'text-pay-text'}`}>
                {section.currency}
              </p>
              <p className="text-[26px] font-semibold text-ink-900 mt-1.5 tabular-nums tracking-[-0.03em] leading-tight">
                {settled ? formatMoney(0, section.currency) : formatMoney(Math.abs(section.closing), section.currency)}
              </p>
              <p className="text-[12px] text-ink-600 mt-1">{netLabel(section.closing)}</p>
            </div>
          );
        })}

        {/* The ledger itself */}
        {sections.length === 0 ? (
          <div className="m-card p-4">
            <p className="text-[13px] text-ink-600">{t('khata_page_no_activity')}</p>
          </div>
        ) : (
          sections.map((section) => (
            <div key={section.currency}>
              <div className="flex items-center justify-between mb-2.5 px-0.5">
                <h2 className="m-label">
                  {t('khata_page_entries')}
                </h2>
                <span className="text-[11px] font-semibold text-ink-600 tabular-nums">{section.currency}</span>
              </div>
              <div className="m-card divide-y divide-cream-hairline overflow-hidden">
                {section.lines.map((line, index) => {
                  const positive = line.delta > 0.005;
                  const zero = isSettled(line.delta);
                  return (
                    <div key={`${section.currency}-${index}`} className="px-3.5 py-3">
                      <div className="flex items-baseline gap-2.5">
                        <span className="text-[10.5px] text-ink-400 tabular-nums shrink-0 w-[62px]">
                          {fmtDate(line.date)}
                        </span>
                        <p className="flex-1 text-[12.5px] text-ink-900 leading-snug">
                          {line.description}
                          {line.estimated && <span className="ml-1 text-ink-400">{'★'}</span>}
                        </p>
                        <span
                          className={`text-[12.5px] font-semibold tabular-nums shrink-0 ${zero ? 'text-ink-400' : positive ? 'text-receive-text' : 'text-pay-text'}`}
                        >
                          {zero ? '—' : `${positive ? '+' : '−'}${formatMoney(Math.abs(line.delta), section.currency)}`}
                        </span>
                      </div>
                      <div className="flex items-baseline gap-2.5 mt-0.5">
                        <span className="w-[62px] shrink-0" />
                        <p className="flex-1 text-[10.5px] text-ink-400 leading-snug">
                          {line.note ? line.note : ''}
                        </p>
                        <span className="text-[10.5px] text-ink-400 tabular-nums shrink-0">
                          {t('khata_page_col_balance')}
                          {': '}
                          {formatMoney(Math.abs(round2(line.balance)), section.currency)}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
              {section.estimated && (
                <p className="text-[10.5px] text-ink-500 mt-2 leading-relaxed">{t('khata_page_estimated_note')}</p>
              )}
            </div>
          ))
        )}

        {/* Honest footnotes: who to argue with, that initials are a choice, and
            when the link dies. */}
        <div className="space-y-1.5 pt-1">
          <p className="text-[11px] text-ink-500 leading-relaxed">
            {t('khata_page_disagree').replace('{owner}', ownerName)}
          </p>
          {view.initialsOnly && (
            <p className="text-[11px] text-ink-500 leading-relaxed">
              {t('khata_page_initials_note').replace('{owner}', ownerName)}
            </p>
          )}
          {/* The server sends null for every note when the owner has not opted
              in — say so, rather than let the entries just look empty. */}
          {!view.showNotes && (
            <p className="text-[11px] text-ink-500 leading-relaxed">
              {t('khata_page_notes_hidden').replace('{owner}', ownerName)}
            </p>
          )}
          {expiryDays > 0 && (
            <p className="text-[11px] text-ink-400 leading-relaxed tabular-nums">
              {t('khata_page_expires').replace('{days}', String(expiryDays))}
            </p>
          )}
        </div>

        {/* The acquisition half of O2: every shared khata is a doorway into the
            app for someone who has never installed it. A violet-tinted tile
            (the whole card is the link) with a violet button face inside. */}
        <a
          href={buildAppShareUrl()}
          className="m-tile m-violet block p-4 mt-2"
        >
          <p className="text-[13.5px] font-semibold text-ink-900 tracking-[-0.01em]">{t('khata_page_cta')}</p>
          <p className="text-[11.5px] text-ink-600 mt-0.5 leading-relaxed">{t('khata_page_cta_sub')}</p>
          <span className="m-btn m-btn-primary min-h-[36px] mt-3 px-3.5 py-2 text-[12px] rounded-xl gap-1.5">
            {t('khata_page_cta_button')}
            <Glyph name="arrow-right" size={14} strokeWidth={2.8} />
          </span>
        </a>
      </div>
    </main>
  );
}
