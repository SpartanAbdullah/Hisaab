import { useEffect, useMemo, useState } from 'react';
import { Modal } from './Modal';
import { Glyph } from './Glyph';
import { SettlementAccountChoice, landingAccountId } from './SettlementAccountChoice';
import { useAccountStore } from '../stores/accountStore';
import { useSettlementRequestStore } from '../stores/settlementRequestStore';
import { useLinkedRequestStore } from '../stores/linkedRequestStore';
import { useAppModeStore } from '../stores/appModeStore';
import { useSupabaseAuthStore } from '../stores/supabaseAuthStore';
import { useToast } from './Toast';
import { confirmDestructive } from './ConfirmDestructiveSheet';
import { formatMoney } from '../lib/constants';
import { useT } from '../lib/i18n';
import { useSubmitGuard, useSubmitIntentId } from '../lib/useSubmitGuard';
import {
  allocateRepayment,
  orderLoansForStrategy,
  previewAllocations,
  totalRemaining,
  type Allocation,
  type AllocationStrategy,
} from '../lib/repaymentAllocation';
import { resolveSettlementSides, type SettlementSides } from '../lib/settlementSides';
import { executeAllocatedSettlements, type SettlementRequestInput } from '../lib/settlementExecution';
import { friendlyLinkedError } from '../lib/linkedErrorMap';
import { lastSettlementAccountId, possibleDuplicateClaim } from '../lib/settlementStatus';
import { buildWhatsAppUrl } from '../lib/whatsappReminder';
import type { Currency, Loan } from '../db';

type Strategy = AllocationStrategy | 'manual';

interface Props {
  open: boolean;
  onClose: () => void;
  loans: Loan[]; // active LINKED loans, one currency + direction, none with a pending request
  direction: 'given' | 'taken';
  currency: Currency;
  personName: string;
  /** For "Tell {name} on WhatsApp" after a payer sends requests. */
  personPhone?: string | null;
  onDone: () => void;
}

function errorText(err: unknown): string {
  if (err instanceof Error) return friendlyLinkedError(err.message);
  if (typeof err === 'string') return friendlyLinkedError(err);
  return '';
}

// One lump across a person's LINKED loans, split one repayment per loan in
// the order the user picks (oldest / newest / smallest / largest / by hand).
// The linked twin of AllocateRepaymentModal. Who received the money decides
// what happens (the 2026-09-24 settlement model):
//   · direction 'given' — they paid ME: every repayment is RECORDED and both
//     ledgers update at once (record_received_repayment); they are only told.
//   · direction 'taken' — I paid THEM: one settlement request per loan, each
//     applied when they confirm it.
export function AllocateSettlementModal({ open, onClose, loans, direction, currency, personName, personPhone, onDone }: Props) {
  const createRequest = useSettlementRequestStore((s) => s.createRequest);
  const recordReceived = useSettlementRequestStore((s) => s.recordReceived);
  const undoRecord = useSettlementRequestStore((s) => s.undo);
  const settlementRequests = useSettlementRequestStore((s) => s.requests);
  const linkedRequests = useLinkedRequestStore((s) => s.requests);
  const { accounts, loadAccounts } = useAccountStore();
  const appMode = useAppModeStore((s) => s.mode);
  const currentUserId = useSupabaseAuthStore((s) => s.user?.id ?? '');
  const toast = useToast();
  const t = useT();
  const submitGuard = useSubmitGuard();

  const receiving = direction === 'given';
  const fullTracker = appMode === 'full_tracker';

  const [lump, setLump] = useState('');
  // Oldest-first default: a consolidated return pays down what's been owed
  // longest — same story as the local allocation flow.
  const [strategy, setStrategy] = useState<Strategy>('oldest');
  const [manual, setManual] = useState<Record<string, string>>({});
  const [note, setNote] = useState('');
  // '' = not chosen · RECORD_ONLY · an account id (SettlementAccountChoice).
  const [landing, setLanding] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setLump('');
    setStrategy('oldest');
    setManual({});
    setNote('');
    setLanding('');
    if (fullTracker) void loadAccounts();
  }, [open, fullTracker, loadAccounts]);

  // Only loans whose accepted pair row resolves can carry a request.
  const sidesByLoan = useMemo(() => {
    const m: Record<string, SettlementSides> = {};
    for (const l of loans) {
      const s = resolveSettlementSides(l.id, linkedRequests);
      if (s) m[l.id] = s;
    }
    return m;
  }, [loans, linkedRequests]);
  const sendableLoans = useMemo(() => loans.filter((l) => sidesByLoan[l.id]), [loans, sidesByLoan]);
  const counterpartyUserId = sendableLoans.length ? sidesByLoan[sendableLoans[0].id]?.toUserId : undefined;

  const maxRemaining = useMemo(() => totalRemaining(sendableLoans), [sendableLoans]);
  const preferredAccountId = useMemo(
    () => lastSettlementAccountId(settlementRequests, currentUserId, counterpartyUserId),
    [settlementRequests, currentUserId, counterpartyUserId],
  );

  const allocations: Allocation[] = useMemo(() => {
    if (strategy === 'manual') {
      return sendableLoans
        .map((l) => {
          const raw = parseFloat(manual[l.id] ?? '');
          const amount = Number.isFinite(raw) ? Math.min(Math.round(raw * 100) / 100, Math.round(l.remainingAmount * 100) / 100) : 0;
          return { loanId: l.id, amount };
        })
        .filter((a) => a.amount > 0);
    }
    const amt = parseFloat(lump);
    if (!Number.isFinite(amt) || amt <= 0) return [];
    return allocateRepayment(sendableLoans, amt, strategy);
  }, [strategy, manual, lump, sendableLoans]);

  const totalAllocated = useMemo(
    () => Math.round(allocations.reduce((a, x) => a + x.amount, 0) * 100) / 100,
    [allocations],
  );
  const leftover = strategy === 'manual'
    ? 0
    : Math.max(0, Math.round(((parseFloat(lump) || 0) - totalAllocated) * 100) / 100);

  // The preview reads in FILL order, so the loan the lump reaches first is on
  // top. Picking by hand lists the newest first — the order the Loans page
  // uses, and the one the founder wanted to clear first.
  const previewOrder = useMemo(
    () => orderLoansForStrategy(sendableLoans, strategy === 'manual' ? 'newest' : strategy),
    [sendableLoans, strategy],
  );
  const previewLines = useMemo(() => previewAllocations(previewOrder, allocations), [previewOrder, allocations]);

  const canSubmit =
    totalAllocated > 0 &&
    totalAllocated <= maxRemaining + 0.001 &&
    (!fullTracker || !!landing);

  // One intent id for the whole batch; each request's id is derived from it
  // plus the loan id, so a double-fired batch re-sends the SAME ids and every
  // duplicate lands on the primary key instead of the counterparty's inbox.
  const nextIntentId = useSubmitIntentId(
    [open, strategy, lump, note, landing, JSON.stringify(manual)].join('|'),
  );

  // Ref-backed entry re-check; `saving` state remains the disabled/label UI.
  const handleSubmit = () => submitGuard.run(runSubmit);

  const runSubmit = async () => {
    if (!canSubmit) return;
    const money = formatMoney(totalAllocated, currency);
    const n = String(allocations.length);
    const accountId = fullTracker ? landingAccountId(landing) : null;
    const account = accountId ? accounts.find((a) => a.id === accountId) : undefined;
    const landingLine = !fullTracker
      ? ''
      : account
        ? t(receiving ? 'stl_confirm_lands' : 'stl_confirm_leaves').replace('{amount}', money).replace('{account}', account.name)
        : t('stl_confirm_record_only');

    if (receiving) {
      // The same money recorded twice? Warn once, on the first match.
      for (const a of allocations) {
        const pair = sidesByLoan[a.loanId]?.loanPairId;
        if (!pair) continue;
        const dup = possibleDuplicateClaim(settlementRequests, {
          loanPairId: pair, amount: a.amount, myUserId: currentUserId, nowMs: Date.now(),
        });
        if (dup?.kind !== 'already_recorded') continue;
        const when = new Date(dup.request.respondedAt ?? dup.request.createdAt)
          .toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
        const different = await confirmDestructive({
          title: t('stl_dup_already_title')
            .replace('{amount}', formatMoney(dup.request.amount, dup.request.currency))
            .replace('{date}', when),
          description: t('stl_dup_already_body'),
          confirmLabel: t('stl_dup_different'),
          cancelLabel: t('stl_dup_same_stop'),
          tone: 'warning',
        });
        if (!different) return;
        break;
      }
    }

    const ok = await confirmDestructive({
      title: `${(receiving ? t('stl_bulk_record_cta') : t('stl_bulk_send')).replace('{n}', n)} · ${money}`,
      description: [
        (receiving ? t('stl_bulk_record_confirm_body') : t('stl_bulk_confirm_body'))
          .replace('{name}', personName)
          .replace('{n}', n)
          .replace('{amount}', money),
        landingLine,
      ].filter(Boolean).join(' '),
      confirmLabel: receiving ? t('stl_record_cta') : t('stl_send'),
      cancelLabel: t('cancel'),
      tone: 'warning',
    });
    if (!ok) return;

    setSaving(true);
    const intentId = nextIntentId();
    const recordedIds: string[] = [];
    try {
      const result = await executeAllocatedSettlements(
        allocations.map((a) => ({ loanId: a.loanId, amount: a.amount })),
        {
          currency,
          note: note.trim() || undefined,
          requesterAccountId: accountId,
          sidesByLoan,
          createRequest: receiving
            ? async (input: SettlementRequestInput) => {
                const row = await recordReceived({ ...input, requesterAccountId: input.requesterAccountId ?? null });
                recordedIds.push(row.id);
                return row;
              }
            : createRequest,
          requestIdFor: (loanId) => `${intentId}:${loanId}`,
        },
      );

      const undoAll = () => {
        void Promise.all(recordedIds.map((id) => undoRecord(id)))
          .then(() => toast.show({ type: 'info', title: t('stl_undone_title') }))
          .catch((err: unknown) =>
            toast.show({ type: 'error', title: t('error'), subtitle: errorText(err) || t('toast_error_generic') }));
      };
      const tellOnWhatsApp = () => {
        const text = t('stl_tell_whatsapp_text')
          .replace('{name}', personName)
          .replace('{n}', String(result.done))
          .replace('{amount}', formatMoney(result.totalRequested, currency));
        window.open(buildWhatsAppUrl(personPhone ?? null, text), '_blank', 'noopener,noreferrer');
      };

      if (!result.failed) {
        toast.show(receiving
          ? {
              type: 'success',
              title: t('stl_recorded_title'),
              subtitle: t('stl_recorded_subtitle').replace('{name}', personName),
              action: { label: recordedIds.length > 1 ? t('stl_undo_all') : t('stl_undo'), onPress: undoAll },
            }
          : {
              type: 'success',
              title: t('stl_bulk_sent_title'),
              subtitle: t('stl_bulk_sent_subtitle').replace('{name}', personName),
              action: { label: t('stl_tell_whatsapp').replace('{name}', personName), onPress: tellOnWhatsApp },
            });
        onDone();
        onClose();
      } else {
        toast.show({
          type: 'error',
          title: result.done > 0
            ? (receiving ? t('stl_bulk_recorded_partial') : t('stl_bulk_partial'))
              .replace('{done}', String(result.done)).replace('{total}', String(result.total))
            : t('error'),
          subtitle: errorText(result.failed.error) || t('toast_error_generic'),
          duration: 6000,
        });
        if (result.done > 0) { onDone(); onClose(); }
      }
    } finally {
      setSaving(false);
    }
  };

  const strategies: { value: Strategy; label: string }[] = [
    { value: 'oldest', label: t('alloc_oldest') },
    { value: 'newest', label: t('alloc_newest') },
    { value: 'smallest', label: t('alloc_smallest') },
    { value: 'largest', label: t('alloc_largest') },
    { value: 'manual', label: t('alloc_manual') },
  ];

  const dateOf = (iso: string) =>
    new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

  const submitLabel = saving
    ? (receiving ? t('stl_recording') : t('stl_sending'))
    : `${(receiving ? t('stl_bulk_record_cta') : t('stl_bulk_send')).replace('{n}', String(allocations.length))} · ${formatMoney(totalAllocated, currency)}`;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`${t('stl_bulk_title')} · ${personName}`}
      footer={
        <button onClick={handleSubmit} disabled={saving || !canSubmit} className="cta-primary">
          {submitLabel}
        </button>
      }
    >
      <div className="space-y-4">
        <p className="text-[12px] text-ink-600 leading-relaxed">
          {(receiving ? t('stl_bulk_record_intro') : t('stl_bulk_intro')).split('{name}').join(personName)}
        </p>

        {/* Strategy */}
        <div>
          <label className="form-label">{t('alloc_strategy_label')}</label>
          <div className="grid grid-cols-2 gap-2.5">
            {strategies.map((s) => (
              <button
                key={s.value}
                type="button"
                onClick={() => setStrategy(s.value)}
                aria-pressed={strategy === s.value}
                className={`selector-base justify-center text-[12px] font-semibold text-ink-800 ${s.value === 'manual' ? 'col-span-2' : ''} ${strategy === s.value ? 'selector-selected' : ''}`}
              >
                {s.label}
              </button>
            ))}
          </div>
        </div>

        {/* Lump amount (auto strategies only) */}
        {strategy !== 'manual' && (
          <div>
            <label className="form-label">{t('alloc_lump_label')} ({currency})</label>
            <input
              type="number"
              step="0.01"
              value={lump}
              onChange={(e) => setLump(e.target.value)}
              placeholder="0.00"
              className="input-field text-center font-semibold tabular-nums tracking-[-0.02em]"
              // Inline on purpose: index.css pins every <input> to 16px (iOS
              // focus-zoom guard), which beats any font-size utility.
              style={{ fontSize: 22 }}
              autoFocus
            />
            <button
              type="button"
              onClick={() => setLump(String(maxRemaining))}
              className="mt-2 min-h-[32px] text-[11.5px] text-accent-600 font-semibold active:opacity-70"
            >
              {t('repay_full_amount').replace('{amount}', formatMoney(maxRemaining, currency))}
            </button>
            {totalAllocated > maxRemaining + 0.001 && (
              <p className="mt-2 text-[11px] text-pay-text font-semibold">{t('alloc_over')}</p>
            )}
          </div>
        )}

        {/* Where the money went — asked every time in Full Tracker, above the
            breakdown so it can't be scrolled past. */}
        {fullTracker && (
          <SettlementAccountChoice
            direction={direction}
            currency={currency}
            accounts={accounts}
            value={landing}
            onChange={setLanding}
            preferredAccountId={preferredAccountId}
          />
        )}

        {/* Preview / manual entry — in fill order, each loan with its date. */}
        <div>
          <label className="form-label">{t('alloc_preview')}</label>
          <div className="m-card overflow-hidden divide-y divide-cream-hairline">
            {previewOrder.map((l, i) => {
              const line = previewLines[i];
              return (
                <div key={l.id} className="px-3.5 py-3">
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-[12.5px] font-semibold text-ink-900 truncate">
                        {l.notes?.trim() || (direction === 'given' ? t('loan_receivable') : t('loan_payable'))}
                      </p>
                      <p className="text-[10.5px] text-ink-600 tabular-nums mt-0.5">
                        {dateOf(l.createdAt)} · {formatMoney(l.remainingAmount, l.currency)} {t('loan_remaining').toLowerCase()}
                      </p>
                    </div>
                    {strategy === 'manual' ? (
                      <input
                        type="number"
                        step="0.01"
                        value={manual[l.id] ?? ''}
                        onChange={(e) => setManual((m) => ({ ...m, [l.id]: e.target.value }))}
                        placeholder="0"
                        className="w-24 input-field text-right font-semibold tabular-nums py-2"
                      />
                    ) : (
                      <div className="text-right shrink-0">
                        <p className={`text-[13px] font-semibold tabular-nums ${line.applied ? 'text-receive-text' : 'text-ink-400'}`}>
                          {line.applied ? formatMoney(line.applied, l.currency) : '—'}
                        </p>
                        {line.cleared ? (
                          <span className="m-chip m-chip-receive m-chip-caps mt-1">
                            <Glyph name="check" size={10} strokeWidth={3} />
                            {t('stl_bulk_clears')}
                          </span>
                        ) : null}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
          {leftover > 0 && (
            <p className="mt-2 text-[11px] text-warn-600">
              {formatMoney(leftover, currency)} {t('alloc_leftover')}
            </p>
          )}
        </div>

        {/* Shared note — lands on every repayment. */}
        <div>
          <label className="form-label">{t('stl_note_label')}</label>
          <input value={note} onChange={(e) => setNote(e.target.value)} className="input-field" />
        </div>

        {/* What happens next, on the violet every linked surface wears. */}
        <p className="m-card m-violet text-[12px] text-iris-text p-3 leading-relaxed">
          {receiving
            ? t('stl_card_recorded_note')
            : t('stl_bulk_confirm_note').replace('{name}', personName)}
        </p>
      </div>
    </Modal>
  );
}
