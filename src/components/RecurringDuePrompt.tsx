import { useEffect, useState } from 'react';
import { Pause, SkipForward } from 'lucide-react';
import { Modal } from '../components/Modal';
import { Glyph } from './Glyph';
import { useRecurringStore } from '../stores/recurringStore';
import { useTransactionStore } from '../stores/transactionStore';
import { useAccountStore } from '../stores/accountStore';
import { useToast } from './Toast';
import { formatMoney } from '../lib/constants';
import { brandIconFor } from '../lib/brandIcon';
import { buildInternalNote, parseInternalNote } from '../lib/internalNotes';
import { useT } from '../lib/i18n';
import { useSubmitGuard } from '../lib/useSubmitGuard';
import { useLoanStore } from '../stores/loanStore';
import { track } from '../lib/telemetry';
import { bucketAmount } from '../lib/telemetryEvents';
import type { RecurringTransaction } from '../db';
import type { RecurringDueDetail } from '../lib/recurringRunner';

interface Props {
  /**
   * Templates the gate in src/App.tsx already captured from the FIRST
   * `hisaab:recurring-due` event. That event is what causes this component to
   * be mounted at all, so without seeding it would be missed: the lazy chunk
   * only finishes loading (and this component only starts listening) a tick or
   * two after the event has already been dispatched and gone.
   */
  initialTemplates?: RecurringTransaction[];
}

// Listens for the `hisaab:recurring-due` event fired by recurringRunner.
// Walks due templates one at a time, prompting the user to confirm, skip,
// or pause. Confirmation materialises a real Transaction via the existing
// transactionStore.processTransaction pipeline so balance math + activity
// log stay consistent — recurring entries are not a parallel ledger.
//
// Audit 03-performance H1 / P2 M2c: lazy-mounted. It is only rendered once the
// gate has seen a due event, so on the overwhelming majority of boots (no
// recurring template is due) neither this component nor the Modal/brandIcon/
// submit-guard code it pulls is fetched at all.
export function RecurringDuePrompt({ initialTemplates }: Props = {}) {
  const [queue, setQueue] = useState<RecurringTransaction[]>(() => initialTemplates ?? []);
  const advanceTemplate = useRecurringStore((s) => s.advanceTemplate);
  const updateTemplate = useRecurringStore((s) => s.updateTemplate);
  const processTransaction = useTransactionStore((s) => s.processTransaction);
  const accounts = useAccountStore((s) => s.accounts);
  const toast = useToast();
  const t = useT();
  const [working, setWorking] = useState(false);
  // Declared above the `if (!current) return null` early return — hooks must
  // run unconditionally. Shared by confirm/skip/pause: all three mutate the
  // same template, and confirm posts a real transaction.
  const submitGuard = useSubmitGuard();

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<RecurringDueDetail>).detail;
      if (!detail || !Array.isArray(detail.templates)) return;
      setQueue((prev) => {
        // Dedupe — runner can fire twice in a session if the user reloads.
        const seen = new Set(prev.map((t) => t.id));
        const merged = [...prev];
        for (const t of detail.templates) if (!seen.has(t.id)) merged.push(t);
        return merged;
      });
    };
    window.addEventListener('hisaab:recurring-due', handler);
    return () => window.removeEventListener('hisaab:recurring-due', handler);
  }, []);

  const current = queue[0];
  if (!current) return null;

  const accountName = (id: string | null) =>
    accounts.find((a) => a.id === id)?.name ?? t('mv_unknown_account');

  const pop = () => setQueue((prev) => prev.slice(1));

  // Ref-backed entry re-check (audit F-8/D-1): `working` state updates
  // asynchronously, so two taps in one frame both read it as false.
  const handleConfirm = () => submitGuard.run(runConfirm);
  const handleSkip = () => submitGuard.run(runSkip);
  const handlePause = () => submitGuard.run(runPause);

  const runConfirm = async () => {
    setWorking(true);
    try {
      // Idempotency stamp: (templateId @ dueDate) written into the internal
      // note. A second Confirm — retry after a partial failure, a stale modal
      // on another device — is detected and refused instead of double-posting.
      const expansionKey = `${current.id}@${current.nextDueDate}`;
      const txStore = useTransactionStore.getState();
      if (txStore.transactions.length === 0) {
        try { await txStore.loadTransactions(); } catch { /* stamp check degrades gracefully */ }
      }
      const alreadyPosted = useTransactionStore.getState().transactions.some(
        (t) => parseInternalNote(t.notes).meta.recurringExpansion === expansionKey,
      );
      if (alreadyPosted) {
        toast.show({ type: 'success', title: t('rec_already_posted') });
        try { await advanceTemplate(current.id); } catch { /* re-prompts next boot */ }
        pop();
        return;
      }

      const stampedNotes = buildInternalNote(current.notes ?? '', { recurringExpansion: expansionKey });
      // Post on the DUE date (noon-anchored, opening-balance precedent) — a
      // late confirm must not misfile last month's rent into this month's
      // budget, and delete+recreate can't fix the date afterwards.
      const createdAt = new Date(`${current.nextDueDate}T12:00:00`).toISOString();
      // Read BEFORE the write — after it, the stores are never empty again.
      // Recurring templates only exist in full-tracker (App.tsx skips their
      // load in splits_only), so mode is always 'full_tracker' here.
      const isFirstEver =
        useTransactionStore.getState().transactions.length === 0 && useLoanStore.getState().loans.length === 0;

      if (current.type === 'income' && current.destinationAccountId) {
        await processTransaction({
          type: 'income',
          destinationAccountId: current.destinationAccountId,
          amount: current.amount,
          category: current.category,
          notes: stampedNotes,
          createdAt,
        });
      } else if (current.type === 'expense' && current.sourceAccountId) {
        await processTransaction({
          type: 'expense',
          sourceAccountId: current.sourceAccountId,
          amount: current.amount,
          category: current.category,
          notes: stampedNotes,
          createdAt,
        });
      } else if (
        current.type === 'transfer' &&
        current.sourceAccountId &&
        current.destinationAccountId
      ) {
        await processTransaction({
          type: 'transfer',
          sourceAccountId: current.sourceAccountId,
          destinationAccountId: current.destinationAccountId,
          amount: current.amount,
          category: current.category,
          notes: stampedNotes,
          createdAt,
        });
      } else {
        throw new Error('Template is missing the account references needed to post.');
      }

      // Catalog #9 (source=recurring). Fires only once processTransaction has
      // actually committed — a throw above skips this line entirely.
      track('entry_created', {
        entry_type: current.type,
        source: 'recurring',
        is_first_ever: isFirstEver,
        mode: 'full_tracker',
        currency: current.currency,
        amount_bucket: bucketAmount(current.amount),
      });

      // The money has moved — from here on this entry IS posted, whatever
      // happens to the due-date advance. Never tell the user it failed.
      try {
        await advanceTemplate(current.id);
        toast.show({ type: 'success', title: t('rec_posted_title').replace('{name}', current.label || current.category) });
      } catch {
        toast.show({ type: 'success', title: t('rec_posted_title').replace('{name}', current.label || current.category), subtitle: t('rec_posted_advance_failed') });
      }
      pop();
    } catch (err) {
      toast.show({
        type: 'error',
        title: t('rec_post_failed_title'),
        subtitle: err instanceof Error ? err.message : t('err_page_msg'),
      });
    } finally {
      setWorking(false);
    }
  };

  const runSkip = async () => {
    setWorking(true);
    const prevDue = current.nextDueDate;
    const templateId = current.id;
    try {
      // Advance the due date so we don't keep nagging this session.
      await advanceTemplate(templateId);
      pop();
      // A mis-tap next to Confirm used to silently swallow a month — say what
      // happened and offer the way back.
      toast.show({
        type: 'success',
        title: t('mv_rec_skipped').replace('{name}', current.label || current.category),
        action: {
          label: t('undo'),
          onPress: () => {
            void updateTemplate(templateId, { nextDueDate: prevDue }).catch(() => {});
          },
        },
      });
    } catch {
      pop();
    } finally {
      setWorking(false);
    }
  };

  const runPause = async () => {
    setWorking(true);
    try {
      await updateTemplate(current.id, { active: false });
      toast.show({ type: 'success', title: t('rec_paused_toast') });
      // Drop everything from the queue belonging to this template.
      setQueue((prev) => prev.filter((t) => t.id !== current.id));
    } finally {
      setWorking(false);
    }
  };

  return (
    <Modal open={!!current} onClose={pop} title={t('rec_due_title')}>
      <div className="space-y-4">
        <div className="m-card p-4 flex items-start gap-3">
          {/* Brand/category mark when we can infer one ("Netflix" → 🎬,
              "Salary" → 💰); the recurring glyph otherwise. */}
          <div className="m-card m-blue w-11 h-11 rounded-[14px] flex items-center justify-center shrink-0 text-lg">
            {(() => {
              const icon = brandIconFor(current.label, current.category);
              return icon.matched === 'none' ? <Glyph name="recurring" size={20} tone="blue" /> : icon.emoji;
            })()}
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-[14px] font-semibold text-ink-900 tracking-tight truncate">
              {current.label || current.category}
            </p>
            <p
              className={`text-[15px] font-semibold tabular-nums mt-0.5 ${
                current.type === 'income' ? 'text-receive-text' : 'text-pay-text'
              }`}
            >
              {current.type === 'income' ? '+ ' : '− '}
              {formatMoney(current.amount, current.currency)}
            </p>
            <p className="text-[11.5px] text-ink-600 mt-1">
              {t('rec_due_on').replace('{date}', current.nextDueDate)} ·{' '}
              {current.type === 'income'
                ? t('rec_to_account').replace('{account}', accountName(current.destinationAccountId))
                : t('rec_from_account').replace('{account}', accountName(current.sourceAccountId))}
            </p>
          </div>
        </div>

        <button onClick={handleConfirm} disabled={working} className="cta-primary">
          <Glyph name="check" size={16} strokeWidth={3} /> {working ? t('rec_posting') : t('rec_confirm_post')}
        </button>
        <div className="flex gap-2.5">
          <button
            onClick={handleSkip}
            disabled={working}
            className="cta-secondary flex-1 py-3.5 text-[13px]"
          >
            <SkipForward size={14} strokeWidth={2.4} /> {t('rec_skip_one')}
          </button>
          <button
            onClick={handlePause}
            disabled={working}
            className="cta-secondary flex-1 py-3.5 text-[13px]"
          >
            <Pause size={14} strokeWidth={2.4} /> {t('rec_pause')}
          </button>
        </div>
        {queue.length > 1 && (
          <p className="text-[11px] text-ink-500 text-center">
            {t('rec_more_after').replace('{n}', String(queue.length - 1))}
          </p>
        )}
      </div>
    </Modal>
  );
}
