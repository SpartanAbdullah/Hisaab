// One list that finally answers "who owes me?" across every mechanism Hisaab
// uses to record an obligation: personal loans, linked loans, ad-hoc splits
// (which materialise AS loans) and group balances.
//
// Renders `buildWhoOwesMe` output — one row per (person, currency), both
// directions kept as columns, sorted by |net| by the module. This component
// adds no arithmetic of its own; if a number looks wrong the bug is in
// src/lib/whoOwesMe.ts or src/lib/whoOwesGroupInputs.ts, not here.
//
// GROUP ROWS ARE PEOPLE NOW (docs/who-owes-me.md open risk #1). The `rows` prop
// may still carry the COARSE group adapter's output, where a whole group stands
// in for a person ("Dubai Trip owes you 400"). `splitStore.loadBalances`
// retains the DIRECT pairwise edges touching the signed-in user — from the two
// batched queries it already ran, so ZERO extra fetches — and
// `rowsWithPairwiseGroups` swaps those group rows for the people behind them,
// merging each into the loan/split row that person may already hold. With no
// pairwise data the call is a no-op and today's coarse rows render unchanged.
//
// HONESTY RULES it implements (docs/who-owes-me.md §3):
//   · a row keyed by NAME alone is a guess — it gets a "name match only"
//     caveat and never a verified mark;
//   · `findLikelyDuplicateRows` pairs ("Bilal the contact" vs "Bilal typed by
//     hand") are surfaced as a *hint*, never auto-merged. Silently combining
//     two people's money on a name match is exactly the quiet wrongness a
//     trust product cannot afford;
//   · every source is shown as its own chip so the number can be explained,
//     not just asserted. Loan and group chips deep-link; an ad-hoc split has
//     no route of its own in App.tsx, so its chip is a plain label.

import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Glyph } from './Glyph';
import { UserAvatar } from './UserAvatar';
import type { GlyphName } from '../lib/glyphs';
import { formatMoney } from '../lib/constants';
import { useT } from '../lib/i18n';
import { useSplitStore } from '../stores/splitStore';
import { usePersonStore } from '../stores/personStore';
import { useSupabaseAuthStore } from '../stores/supabaseAuthStore';
import { isGroupCounterpartyId, rowsWithPairwiseGroups } from '../lib/whoOwesGroupInputs';
import { findLikelyDuplicateRows } from '../lib/whoOwesMe';
import type { DuplicateRowHint, WhoOwesRow, WhoOwesSource } from '../lib/whoOwesMe';

/** Chips beyond this collapse into a "+n more" tail so a row stays one card. */
const MAX_CHIPS = 4;

interface Props {
  rows: WhoOwesRow[];
  /** `findLikelyDuplicateRows(rows)` — rendered as a subtle note, never a merge. */
  duplicateHints?: DuplicateRowHint[];
  /** Start open. Callers pass `rows.length > 0`. */
  defaultExpanded?: boolean;
}

function sourceHref(source: WhoOwesSource): string | null {
  if (source.kind === 'loan') return `/loan/${source.id}`;
  if (source.kind === 'group') return `/group/${source.id}`;
  // Ad-hoc splits have no route in App.tsx — the chip stays a label.
  return null;
}

export function WhoOwesMeCard({ rows, duplicateHints = [], defaultExpanded = true }: Props) {
  const t = useT();
  const [expanded, setExpanded] = useState(defaultExpanded);

  // ── True per-person group attribution, at zero fetch cost ─────────────────
  // The pages that build `rows` may only have the COARSE group adapter's
  // output, where a whole group stands in for a person ("Dubai Trip owes you
  // 400" — docs/who-owes-me.md open risk #1). `splitStore.loadBalances` already
  // retains the DIRECT pairwise edges touching the signed-in user, from the two
  // batched queries it was running anyway, so when that slice is populated we
  // swap the group rows for the people behind them. No extra round-trip; when
  // the slice is empty this is a no-op and the coarse rows render as before.
  const groups = useSplitStore((s) => s.groups);
  const pairwiseByGroup = useSplitStore((s) => s.pairwiseByGroup);
  const contacts = usePersonStore((s) => s.persons);
  const myId = useSupabaseAuthStore((s) => s.user?.id ?? '');

  const shownRows = useMemo(
    () =>
      rowsWithPairwiseGroups(rows, {
        groups,
        pairwiseByGroup,
        currentProfileId: myId || null,
        contacts,
      }),
    [rows, groups, pairwiseByGroup, myId, contacts],
  );

  // Re-attribution creates new person rows, so the "same person? link the
  // contact" hints must be recomputed against what we actually render. When
  // nothing was re-attributed the helper hands back the same array and the
  // caller's hints stand.
  const hints = useMemo(
    () => (shownRows === rows ? duplicateHints : findLikelyDuplicateRows(shownRows)),
    [shownRows, rows, duplicateHints],
  );

  // personKey|currency of every row that a linked row probably duplicates,
  // mapped to the name to offer linking against.
  const hintByRow = useMemo(() => {
    const map = new Map<string, string>();
    for (const hint of hints) {
      map.set(`${hint.unlinked.personKey}|${hint.unlinked.currency}`, hint.linked.personName);
    }
    return map;
  }, [hints]);

  if (shownRows.length === 0) return null;

  return (
    <section className="m-card overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="w-full flex items-center gap-3 px-4 py-3.5 text-left active:bg-cream-soft transition-colors"
      >
        <span className="m-ctl w-8 h-8 rounded-[10px] flex items-center justify-center shrink-0" aria-hidden>
          <Glyph name="banknote" size={16} tone="violet" />
        </span>
        <span className="flex-1 min-w-0">
          <span className="m-label block">
            {t('wom_title')}
          </span>
          <span className="block text-[11px] text-ink-600 mt-0.5 truncate">
            {shownRows.length === 1
              ? t('loans_people_one')
              : t('loans_people_many').replace('{n}', String(shownRows.length))}
            {' · '}
            {t('wom_subtitle')}
          </span>
        </span>
        <Glyph
          name="chevron-down"
          size={16}
          className={`text-ink-400 transition-transform ${expanded ? 'rotate-180' : ''}`}
        />
      </button>

      {expanded && (
        <div className="divide-y divide-cream-hairline border-t border-cream-hairline">
          {shownRows.map((row) => (
            <WhoOwesRowItem
              key={`${row.currency}:${row.personKey}`}
              row={row}
              duplicateOf={hintByRow.get(`${row.personKey}|${row.currency}`) ?? null}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function WhoOwesRowItem({ row, duplicateOf }: { row: WhoOwesRow; duplicateOf: string | null }) {
  const t = useT();
  const isSquare = Math.abs(row.net) <= 0.005;
  const theyOweMe = row.net > 0;
  const netColor = isSquare ? 'text-ink-500' : theyOweMe ? 'text-receive-text' : 'text-pay-text';
  // A row is a GROUP standing in for a person only when every source carries
  // the SYNTHETIC counterparty id the coarse net-balance adapter mints. Keyed
  // off that marker rather than off "no personId + all group sources", because
  // with true pairwise attribution a real person — a guest, or anyone matched
  // by name alone — can legitimately hold group-only money and must still be
  // drawn (and caveated) as a person.
  const isGroupRow =
    row.sources.length > 0 &&
    row.sources.every((s) => s.kind === 'group' && isGroupCounterpartyId(s.memberId));
  const bothDirections = row.youAreOwed > 0.005 && row.youOwe > 0.005;
  const shownSources = row.sources.slice(0, MAX_CHIPS);
  const hiddenCount = row.sources.length - shownSources.length;

  return (
    <div className="px-4 py-3.5">
      <div className="flex items-center gap-3">
        {isGroupRow ? (
          // A group standing in for a person: a blue (Groups) disc.
          <span className="m-card m-blue w-11 h-11 rounded-full flex items-center justify-center shrink-0" aria-hidden>
            <Glyph name="groups" size={19} tone="blue" />
          </span>
        ) : (
          <UserAvatar name={row.personName} size={44} />
        )}

        <div className="flex-1 min-w-0">
          <p className="text-[14px] font-medium text-ink-900 truncate tracking-[-0.01em]">
            {row.personName}
          </p>
          <p className="text-[10.5px] text-ink-500 mt-0.5">
            {isSquare
              ? t('wom_net_square')
              : theyOweMe
              ? t('wom_they_owe')
              : t('wom_you_owe')}
            {row.matchedBy !== 'profile' && !isGroupRow && (
              <>
                {' · '}
                {t('wom_name_only')}
              </>
            )}
          </p>
        </div>

        <div className="text-right shrink-0">
          <p className={`text-[14px] font-semibold tabular-nums tracking-tight ${netColor}`}>
            {isSquare ? '' : theyOweMe ? '+' : '−'}
            {formatMoney(Math.abs(row.net), row.currency)}
          </p>
          <p className="text-[10px] text-ink-400 mt-0.5">{row.currency}</p>
        </div>
      </div>

      {/* Gross columns, only when the net hides a two-way relationship. */}
      {bothDirections && (
        <p className="text-[10.5px] text-ink-500 mt-1.5 tabular-nums pl-[56px]">
          <span className="text-receive-text font-medium">
            +{formatMoney(row.youAreOwed, row.currency)}
          </span>
          {' · '}
          <span className="text-pay-text font-medium">
            −{formatMoney(row.youOwe, row.currency)}
          </span>
        </p>
      )}

      {/* Where the money comes from — one chip per contributing source. */}
      <div className="flex flex-wrap gap-1.5 mt-2 pl-[56px]">
        {shownSources.map((source, index) => (
          <SourceChip
            key={`${source.kind}:${source.id}:${index}`}
            source={source}
            personName={isGroupRow ? null : row.personName}
          />
        ))}
        {hiddenCount > 0 && (
          <span className="m-chip m-chip-neutral">
            {t('wom_more_sources').replace('{n}', String(hiddenCount))}
          </span>
        )}
      </div>

      {duplicateOf && (
        <p className="text-[10.5px] text-ink-400 mt-2 pl-[56px] leading-snug">
          {t('wom_same_person').replace('{name}', duplicateOf)}
        </p>
      )}
    </div>
  );
}

function SourceChip({ source, personName }: { source: WhoOwesSource; personName: string | null }) {
  const t = useT();
  const href = sourceHref(source);
  const glyph: GlyphName = source.kind === 'group' ? 'groups' : source.kind === 'adhoc' ? 'split' : 'banknote';
  const fallback =
    source.kind === 'group'
      ? t('wom_src_group')
      : source.kind === 'adhoc'
      ? t('wom_src_adhoc')
      : t('wom_src_loan');
  const base = source.label.trim() || fallback;
  // With true pairwise attribution a group chip is an edge between two named
  // people, so it names BOTH the group and the counterparty ("Dubai Trip ·
  // Bilal"). The coarse net-balance edge knows no member, so it stays the group
  // name alone rather than inventing one.
  const label =
    source.kind === 'group' && personName && !isGroupCounterpartyId(source.memberId)
      ? t('wom_src_group_person').replace('{group}', base).replace('{name}', personName)
      : base;
  const tone = source.direction === 'owed_to_me' ? 'm-chip-receive' : 'm-chip-pay';
  const body = (
    <>
      <Glyph name={glyph} size={11} strokeWidth={2.6} />
      <span className="truncate max-w-[160px] font-medium">{label}</span>
      <span className="tabular-nums">
        {formatMoney(source.amount, source.currency)}
      </span>
    </>
  );
  const className = `m-chip ${tone} max-w-full`;

  if (!href) return <span className={className}>{body}</span>;
  return (
    <Link to={href} className={`${className} press-xs`}>
      {body}
    </Link>
  );
}
