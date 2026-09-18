import { useCallback, useState } from 'react';
import { CreditCard, Pause, Play, PauseCircle } from 'lucide-react';
import { PageHeader } from '../components/PageHeader';
import { EmptyState } from '../components/EmptyState';
import { Card3D } from '../components/Card3D';
import { Glyph } from '../components/Glyph';
import { PageErrorState } from '../components/PageErrorState';
import { ListSkeleton } from '../components/ListSkeleton';
import { AddRecurringModal } from '../components/AddRecurringModal';
import { useRecurringStore } from '../stores/recurringStore';
import { formatMoney } from '../lib/constants';
import { useT } from '../lib/i18n';
import { useToast } from '../components/Toast';
import { confirmDestructive } from '../components/ConfirmDestructiveSheet';
import { useAsyncLoad } from '../hooks/useAsyncLoad';
import { localIso } from '../lib/localDate';
import {
  isSubscription,
  subscriptionTotals,
  upcomingRenewals,
  detectGhosts,
  describeGhost,
  daysUntil,
  monthlyAmount,
} from '../lib/subscriptionMetrics';
import { brandIconFor } from '../lib/brandIcon';
import type { RecurringTransaction } from '../db';

// Brand/category mark for a recurring entry on a raised control, in the app's
// group-emoji avatar style. Falls back to a first-letter mark when nothing
// matches (custom category + unknown name).
function EntryIconTile({ label, category }: { label: string; category: string }) {
  const icon = brandIconFor(label, category);
  return (
    <div className="m-ctl w-10 h-10 rounded-[14px] flex items-center justify-center text-[17px] shrink-0">
      {icon.matched === 'none' ? (
        <span className="text-[14px] font-semibold text-cobalt-text">
          {((label || category).trim()[0] ?? '?').toUpperCase()}
        </span>
      ) : (
        icon.emoji
      )}
    </div>
  );
}

// Row actions: plain key-material buttons, the remove one coral-tinted.
const ROW_ACTION = 'm-btn m-btn-plain min-h-[40px] px-3 py-1.5 rounded-xl text-[11.5px] gap-1.5';
const ROW_ACTION_DANGER = 'm-btn m-btn-danger min-h-[40px] px-3 py-1.5 rounded-xl text-[11.5px] gap-1.5';

export function SubscriptionsPage() {
  const templates = useRecurringStore((s) => s.templates);
  const loadTemplates = useRecurringStore((s) => s.loadTemplates);
  const updateTemplate = useRecurringStore((s) => s.updateTemplate);
  const deleteTemplate = useRecurringStore((s) => s.deleteTemplate);
  const toast = useToast();
  // Named `tr` (not `t`) because the subscription list maps over items bound to
  // a local `t` (a RecurringTransaction); shadowing would break those rows.
  const tr = useT();
  const [showAdd, setShowAdd] = useState(false);
  const [editing, setEditing] = useState<RecurringTransaction | null>(null);

  const load = useCallback(() => loadTemplates(), [loadTemplates]);
  const { status: loadStatus, error: loadError, retry: retryLoad } = useAsyncLoad(load);

  const todayIso = localIso(new Date());
  const subs = templates.filter(isSubscription);
  const totals = subscriptionTotals(templates);
  const renewals = upcomingRenewals(templates, todayIso);
  const ghosts = detectGhosts(templates, todayIso);
  const ghostIds = new Set(ghosts.map((g) => g.template.id));

  // Active first, then paused; within each group soonest-due first.
  const byActiveThenDue = (a: RecurringTransaction, b: RecurringTransaction) => {
    if (a.active !== b.active) return a.active ? -1 : 1;
    return a.nextDueDate.localeCompare(b.nextDueDate);
  };
  const ordered = [...subs].sort(byActiveThenDue);
  // Everything recurring that ISN'T a subscription (rent, salary, EMIs) lives
  // here too, so this is the single recurring home — no separate page.
  const others = templates.filter((t) => !isSubscription(t)).sort(byActiveThenDue);

  const togglePause = async (t: RecurringTransaction) => {
    try {
      await updateTemplate(t.id, { active: !t.active });
    } catch (err) {
      toast.show({
        type: 'error',
        title: tr('subs_err_update'),
        subtitle: err instanceof Error ? err.message : tr('subs_try_again'),
      });
    }
  };

  const handleDelete = async (t: RecurringTransaction) => {
    const ok = await confirmDestructive({
      title: tr('subs_remove_confirm').replace('{name}', t.label || t.category),
      description: tr('subs_remove_body'),
      confirmLabel: tr('subs_remove_cta'),
    });
    if (!ok) return;
    try {
      await deleteTemplate(t.id);
      toast.show({ type: 'success', title: tr('subs_removed') });
    } catch (err) {
      toast.show({
        type: 'error',
        title: tr('subs_err_remove'),
        subtitle: err instanceof Error ? err.message : tr('subs_try_again'),
      });
    }
  };

  return (
    <main className="min-h-dvh bg-cream-bg pb-28">
      <PageHeader
        title={tr('subs_title')}
        back
        action={
          <button
            onClick={() => setShowAdd(true)}
            aria-label={tr('subs_a11y_add')}
            className="nav-icon-button"
          >
            <Glyph name="plus" size={16} strokeWidth={3} className="text-accent-text" />
          </button>
        }
      />

      <div className="px-5 pt-5 space-y-4">
        {loadStatus === 'error' && (
          <PageErrorState
            variant="inline"
            title={tr('subs_err_load')}
            message={loadError ?? tr('err_some_data_failed')}
            onRetry={retryLoad}
          />
        )}

        {loadStatus === 'loading' && subs.length === 0 ? (
          <ListSkeleton rows={3} />
        ) : subs.length === 0 ? (
          loadStatus === 'ready' ? (
            <EmptyState
              icon={CreditCard}
              clayIcon="card"
              tone="blue"
              title={tr('subs_empty_title')}
              description={tr('subs_empty_desc')}
              subhint={tr('subs_empty_subhint')}
              actionLabel={tr('subs_empty_cta')}
              onAction={() => setShowAdd(true)}
            />
          ) : null
        ) : (
          <>
            {/* Burn totals — one pair of cards per currency (no cross-currency
                summing; mixed currencies are shown separately). When every
                subscription is paused there is no burn, so we swap the
                "AED 0" cards for a calm, reassuring banner instead. */}
            {totals.activeCount === 0 ? (
              <Card3D padding="sm" className="flex items-center gap-2.5">
                <PauseCircle size={18} strokeWidth={2.4} className="text-glyph-neutral shrink-0" />
                <p className="text-[12.5px] font-semibold text-ink-700">
                  {tr('subs_paused')}
                </p>
              </Card3D>
            ) : (
              totals.byCurrency.map((c) => (
                // Tinted stat cards. Coral is the money-OUT tint and a
                // subscription burn is money leaving every month.
                <div key={c.currency} className="grid grid-cols-2 gap-2.5">
                  <Card3D tint="coral" padding="sm">
                    <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-pay-text">
                      {tr('subs_per_month')}{totals.mixed ? ` · ${c.currency}` : ''}
                    </p>
                    <p className="text-[21px] font-semibold tracking-[-0.03em] text-ink-900 tabular-nums mt-2 leading-tight">
                      {formatMoney(c.monthly, c.currency)}
                    </p>
                    <p className="text-[11px] text-ink-600 mt-1 tabular-nums">
                      {tr('subs_active_count').replace('{c}', String(c.count))}
                    </p>
                  </Card3D>
                  <Card3D tint="coral" padding="sm">
                    <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-pay-text">
                      {tr('subs_per_year')}{totals.mixed ? ` · ${c.currency}` : ''}
                    </p>
                    <p className="text-[21px] font-semibold tracking-[-0.03em] text-ink-900 tabular-nums mt-2 leading-tight">
                      {formatMoney(c.yearly, c.currency)}
                    </p>
                  </Card3D>
                </div>
              ))
            )}

            {/* Renews soon */}
            {renewals.slice(0, 2).map((r) => (
              <div
                key={`renewal-${r.template.id}`}
                className="m-card m-blue flex items-center gap-2.5 px-3.5 py-3"
              >
                <Glyph name="calendar" size={17} tone="blue" />
                <p className="text-[12px] text-cobalt-text leading-snug">
                  <span className="font-semibold">{r.template.label || tr('subs_a_subscription')}</span>{' '}
                  {r.daysUntil === 0
                    ? tr('subs_renews_today')
                    : tr('subs_renews_in').replace('{n}', String(r.daysUntil))}{' '}·{' '}
                  <span className="tabular-nums">{formatMoney(r.template.amount, r.template.currency)}</span>
                </p>
              </div>
            ))}

            {/* Ghost / forgotten alert */}
            {ghosts.length > 0 && (
              <div className="m-card m-coral p-4">
                <div className="flex items-center gap-2">
                  <Glyph name="eye-off" size={16} tone="coral" />
                  <p className="text-[12.5px] font-semibold text-pay-text">
                    {ghosts.length === 1
                      ? tr('subs_ghost_one')
                      : tr('subs_ghost_many').replace('{n}', String(ghosts.length))}
                  </p>
                </div>
                <div className="mt-3 space-y-2">
                  {ghosts.map((g) => {
                    const isDuplicate = g.reasons.includes('duplicate');
                    return (
                      <div key={`ghost-${g.template.id}`} className="flex items-baseline justify-between gap-2">
                        <p className="text-[12px] text-ink-800 truncate flex items-center gap-1.5 min-w-0">
                          <Glyph name={isDuplicate ? 'copy' : 'eye-off'} size={12} tone="coral" className="self-center" />
                          <span className="truncate">{g.template.label || g.template.category}</span>
                        </p>
                        <p className="text-[11px] text-pay-text shrink-0 text-right">
                          {isDuplicate
                            ? tr('subs_duplicate')
                            : describeGhost(g, todayIso)}
                        </p>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Full list */}
            <div className="space-y-2.5">
              {ordered.map((t) => (
                <div
                  key={t.id}
                  className={`m-card p-4 ${!t.active ? 'opacity-60' : ''}`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-3 min-w-0">
                      <EntryIconTile label={t.label} category={t.category} />
                      <p className="text-[14px] font-semibold text-ink-900 tracking-tight truncate">
                        {t.label || t.category}
                      </p>
                    </div>
                    <div className="text-right shrink-0">
                      <p className="text-[13px] font-semibold text-pay-text tabular-nums">
                        {formatMoney(t.amount, t.currency)}
                      </p>
                      {t.cadence !== 'monthly' && (
                        <p className="text-[10.5px] text-ink-500 tabular-nums mt-0.5">
                          {tr('subs_per_mo').replace('{amount}', formatMoney(monthlyAmount(t.amount, t.cadence), t.currency))}
                        </p>
                      )}
                    </div>
                  </div>
                  <p className="text-[11.5px] text-ink-600 mt-1.5">
                    {cadenceLabel(t, tr)} ·{' '}
                    {statusText(t, ghostIds.has(t.id), todayIso, tr)}
                  </p>
                  <div className="flex items-center gap-2 mt-3.5">
                    <button onClick={() => setEditing(t)} className={ROW_ACTION}>
                      <Glyph name="edit" size={13} /> {tr('subs_edit')}
                    </button>
                    <button onClick={() => togglePause(t)} className={ROW_ACTION}>
                      {t.active ? <Pause size={12} strokeWidth={2.4} /> : <Play size={12} strokeWidth={2.4} />}
                      {t.active ? tr('subs_pause') : tr('subs_resume')}
                    </button>
                    <button onClick={() => handleDelete(t)} className={ROW_ACTION_DANGER}>
                      <Glyph name="trash" size={13} /> {tr('subs_remove_cta')}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}

        {/* Other recurring — rent, salary, EMIs: everything that isn't a
            subscription lives here too, so this is the one recurring home. */}
        {others.length > 0 && (
          <div>
            <div className="flex items-center gap-1.5 pt-1 px-1">
              <Glyph name="recurring" size={13} tone="blue" />
              <p className="text-[10.5px] font-semibold tracking-[0.12em] uppercase text-ink-500">{tr('subs_other_recurring')}</p>
            </div>
            <div className="space-y-2.5 mt-2.5">
              {others.map((t) => (
                <div
                  key={t.id}
                  className={`m-card p-4 ${!t.active ? 'opacity-60' : ''}`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-3 min-w-0">
                      <EntryIconTile label={t.label} category={t.category} />
                      <p className="text-[14px] font-semibold text-ink-900 tracking-tight truncate">
                        {t.label || t.category}
                      </p>
                    </div>
                    <p
                      className={`text-[13px] font-semibold tabular-nums shrink-0 ${
                        t.type === 'income' ? 'text-receive-text' : 'text-pay-text'
                      }`}
                    >
                      {t.type === 'income' ? '+ ' : ''}
                      {formatMoney(t.amount, t.currency)}
                    </p>
                  </div>
                  <p className="text-[11.5px] text-ink-600 mt-1.5">
                    {t.category} · {cadenceLabel(t, tr)} · {statusText(t, false, todayIso, tr)}
                  </p>
                  <div className="flex items-center gap-2 mt-3.5">
                    <button onClick={() => setEditing(t)} className={ROW_ACTION}>
                      <Glyph name="edit" size={13} /> {tr('subs_edit')}
                    </button>
                    <button onClick={() => togglePause(t)} className={ROW_ACTION}>
                      {t.active ? <Pause size={12} strokeWidth={2.4} /> : <Play size={12} strokeWidth={2.4} />}
                      {t.active ? tr('subs_pause') : tr('subs_resume')}
                    </button>
                    <button onClick={() => handleDelete(t)} className={ROW_ACTION_DANGER}>
                      <Glyph name="trash" size={13} /> {tr('subs_remove_cta')}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      <AddRecurringModal
        open={showAdd || !!editing}
        onClose={() => { setShowAdd(false); setEditing(null); }}
        defaultCategory="Subscriptions"
        title={tr('subs_add_title')}
        template={editing}
      />
    </main>
  );
}

type Translate = ReturnType<typeof useT>;

function cadenceLabel(t: RecurringTransaction, tr: Translate): string {
  switch (t.cadence) {
    case 'daily':
      return tr('tw_cad_daily');
    case 'weekly':
      return tr('tw_cad_weekly');
    case 'monthly':
      return tr('tw_cad_monthly');
    case 'yearly':
      return tr('tw_cad_yearly');
  }
}

function statusText(t: RecurringTransaction, isGhost: boolean, todayIso: string, tr: Translate): string {
  if (!t.active) return tr('mv_subs_status_paused');
  const d = daysUntil(todayIso, t.nextDueDate);
  if (isGhost && d < 0) return tr('mv_subs_status_overdue').replace('{n}', String(Math.abs(d)));
  if (d < 0) return tr('mv_subs_status_due_ago').replace('{n}', String(Math.abs(d)));
  if (d === 0) return tr('subs_renews_today');
  return tr('mv_subs_status_next_in').replace('{n}', String(d));
}
