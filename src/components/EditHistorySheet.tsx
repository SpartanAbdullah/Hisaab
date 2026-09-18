import { useCallback, useEffect, useMemo, useState } from 'react';
import { format, isToday, isYesterday } from 'date-fns';
import { History } from 'lucide-react';
import { Modal } from './Modal';
import { Glyph } from './Glyph';
import { EmptyState } from './EmptyState';
import { skeletonDelay } from '../lib/material';
import { useT, useI18nStore } from '../lib/i18n';
import { formatMoney } from '../lib/constants';
import { useSupabaseAuthStore } from '../stores/supabaseAuthStore';
import { editHistoryDb, EditHistoryUnavailableError } from '../lib/supabaseDb';
import {
  renderEditHistory,
  type EditHistoryEntry,
  type EditHistoryTable,
} from '../lib/editHistory';

// ════════════════════════════════════════════════════════════════════════════
// Edit history sheet — audit 11-competitive-analysis.md G5 / O10.
//
// "For a two-sided ledger — Hisaab's defining feature — edit accountability is
// the dispute-resolution layer; Settle Up's and Tricount's 2025 sync scandals
// show ledger-integrity doubt is the fatal failure mode."
//
// Read-only. Every row comes from `public.record_edits`, written by an AFTER
// trigger in the same transaction as the money write. Nothing on this screen
// can create, edit or delete a history row — that is the whole point, and the
// subtitle says so to the user.
//
// BOTH APP MODES: identical. The change JSON carries no account id, so a
// splits_only (ledger) loan or transaction — which has no account legs at all
// — produces exactly the same sentences as a full_tracker one.
// ════════════════════════════════════════════════════════════════════════════

interface Props {
  open: boolean;
  onClose: () => void;
  /** Which table the record lives in. */
  table: EditHistoryTable;
  /** The record's own id. */
  recordId: string;
  /** Currency for money formatting. Falls back to plain numbers when absent. */
  currency?: string;
  /**
   * profileId → display name, for naming the ACTOR. Group surfaces pass their
   * `group_members` display names; a personal loan needs none (every actor is
   * the owner, who renders as "Aap"/"You").
   */
  actorNames?: Record<string, string>;
  /**
   * memberId → display name, for naming split PARTICIPANTS and the payer.
   * Group surfaces only.
   */
  memberNames?: Record<string, string>;
}

export function EditHistorySheet({
  open,
  onClose,
  table,
  recordId,
  currency,
  actorNames,
  memberNames,
}: Props) {
  const t = useT();
  const lang = useI18nStore((s) => s.lang);
  const currentUserId = useSupabaseAuthStore((s) => s.user?.id ?? '');

  const [entries, setEntries] = useState<EditHistoryEntry[]>([]);
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'error' | 'unavailable'>('idle');

  const load = useCallback(async () => {
    setStatus('loading');
    try {
      const rows = await editHistoryDb.forRecord(table, recordId);
      setEntries(rows);
      setStatus('ready');
    } catch (err) {
      // The migration is applied by hand in Supabase Studio, so a client that
      // ships first must degrade to an honest "not available yet" instead of
      // an error a user would read as "my records are broken".
      setEntries([]);
      setStatus(err instanceof EditHistoryUnavailableError ? 'unavailable' : 'error');
    }
  }, [table, recordId]);

  useEffect(() => {
    if (!open) return;
    // Fetching on open IS the "synchronize with an external system" case the
    // rule is aimed past — same false positive `useAsyncLoad` disables at
    // src/hooks/useAsyncLoad.ts:45. (useAsyncLoad itself is not usable here:
    // it fires on mount, and this sheet must only read when it is opened.)
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [open, load]);

  const resolveActor = useCallback(
    (entry: EditHistoryEntry): string => {
      if (entry.actorKind === 'system') return t('eh_actor_system');
      if (!entry.actorId) return t('eh_actor_removed');
      if (currentUserId && entry.actorId === currentUserId) return t('eh_actor_you');
      const named = actorNames?.[entry.actorId];
      return named && named.trim() ? named.trim() : t('eh_actor_someone');
    },
    [actorNames, currentUserId, t],
  );

  const rendered = useMemo(
    () =>
      renderEditHistory(entries, (entry) => ({
        lang,
        actorName: resolveActor(entry),
        memberName: (id: string) => memberNames?.[id] ?? id,
        money: currency ? (value: number) => formatMoney(value, currency) : undefined,
        date: formatHistoryDate,
      })),
    [entries, lang, resolveActor, memberNames, currency],
  );

  return (
    <Modal open={open} onClose={onClose} title={t('eh_title')}>
      <div className="space-y-4">
        <div className="m-inset flex items-start gap-2.5 p-3">
          <Glyph name="shield-check" size={16} tone="green" className="mt-0.5" />
          <p className="text-[11.5px] text-ink-600 leading-relaxed">{t('eh_subtitle')}</p>
        </div>

        {/* Loading in the final geometry: timestamped entry cards. */}
        {status === 'loading' && (
          <div className="space-y-3" role="status">
            <span className="sr-only">{t('loading')}</span>
            {[76, 60, 76].map((h, i) => (
              <div
                key={i}
                aria-hidden
                className="m-skel rounded-[18px]"
                style={{ height: h, '--m-skel-delay': skeletonDelay(i) } as React.CSSProperties}
              />
            ))}
          </div>
        )}

        {status === 'unavailable' && (
          <EmptyState
            icon={History}
            clayIcon="clock"
            tone="violet"
            size="compact"
            title={t('eh_unavailable')}
            description={t('eh_unavailable_sub')}
          />
        )}

        {status === 'error' && (
          <div className="text-center py-6">
            <p className="text-[13px] font-semibold text-ink-900">{t('eh_err')}</p>
            <button
              type="button"
              onClick={() => void load()}
              className="m-btn m-btn-plain mt-3 px-4 py-2 text-[12px]"
            >
              <Glyph name="refresh" size={14} /> {t('err_retry')}
            </button>
          </div>
        )}

        {status === 'ready' && rendered.length === 0 && (
          <div className="flex flex-col items-center gap-2 py-6 text-center">
            <Glyph name="clock" size={20} className="text-ink-400" />
            <p className="text-[12px] text-ink-500">{t('eh_empty')}</p>
          </div>
        )}

        {status === 'ready' && rendered.length > 0 && (
          <ol className="relative space-y-3">
            {rendered.map(({ entry, lines }) => (
              <li key={entry.id} className="m-card p-3.5">
                <p className="m-label text-[10px] tabular-nums">
                  {stampLabel(entry.createdAt, t)}
                </p>
                <ul className="mt-1.5 space-y-1">
                  {lines.map((line) => (
                    <li key={line.key} className="text-[12.5px] text-ink-800 leading-relaxed">
                      {line.text}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ol>
        )}
      </div>
    </Modal>
  );
}

/**
 * A tappable row that opens the sheet. Kept in this file so every surface that
 * mounts edit history gets the same label, icon and affordance shape.
 */
export function EditHistoryRow({ onClick }: { onClick: () => void }) {
  const t = useT();
  return (
    <button
      type="button"
      onClick={onClick}
      className="m-tile rounded-[18px] px-4 py-3.5 flex items-center gap-3"
    >
      <div className="m-ctl w-9 h-9 rounded-[11px] flex items-center justify-center shrink-0" aria-hidden>
        <Glyph name="clock" size={16} tone="neutral" />
      </div>
      <div className="flex-1 min-w-0 text-left">
        <p className="text-[13.5px] font-medium text-ink-900 tracking-[-0.01em]">{t('eh_row_title')}</p>
        <p className="text-[10.5px] text-ink-600 mt-0.5">{t('eh_row_sub')}</p>
      </div>
      <Glyph name="chevron-right" size={15} className="text-ink-400" />
    </button>
  );
}

// ── Dates ───────────────────────────────────────────────────────────────────
// Same helpers ActivityPage uses (date-fns `isToday` / `isYesterday` /
// `format`), so a timestamp reads the same wherever it appears in the app.

function stampLabel(iso: string, t: (key: 'activity_today' | 'activity_yesterday') => string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  if (isToday(d)) return `${t('activity_today')} · ${format(d, 'h:mm a')}`;
  if (isYesterday(d)) return `${t('activity_yesterday')} · ${format(d, 'h:mm a')}`;
  return format(d, 'd MMM yyyy · h:mm a');
}

/** Date VALUES inside a change (an expense's `date`, a transaction's date). */
function formatHistoryDate(raw: string): string {
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return raw;
  return format(d, 'd MMM yyyy');
}
