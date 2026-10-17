// "Record this?" — the offer a captured bank alert turns into.
//
// Fed by App.tsx with the raw text from either the Android share sheet or
// the notification listener (src/lib/captureBridge.ts). Shows what the
// parser understood (amount, direction, where, which account, date), lets
// the user flip the direction, and hands a prefilled Quick Entry preset back
// through `onRecord`. It never writes a transaction itself: Quick Entry stays
// the single place money is entered, with all its guards (both app modes,
// account currency, overpayment, undo).
import { useEffect, useMemo, useState } from 'react';
import { Modal } from './Modal';
import { Glyph } from './Glyph';
import { useT } from '../lib/i18n';
import { formatMoney } from '../lib/constants';
import { isNeverCapture, parseBankAlert, type AlertDirection } from '../lib/bankAlertParser';
import { buildCapturePreset, matchCaptureAccount, type CapturePreset, type CaptureSource } from '../lib/captureOffer';
import { useAccountStore } from '../stores/accountStore';
import { useTransactionStore } from '../stores/transactionStore';
import { useAppModeStore } from '../stores/appModeStore';
import { track } from '../lib/telemetry';

interface Props {
  open: boolean;
  source: CaptureSource;
  text: string;
  onClose: () => void;
  /** Parsed and confirmed: open Quick Entry with this preset. */
  onRecord: (preset: CapturePreset) => void;
  /** Nothing usable parsed: open Quick Entry blank (amount if we had one). */
  onManual: (partial: { amount?: number; notes?: string }) => void;
}

export function CaptureSheet({ open, source, text, onClose, onRecord, onManual }: Props) {
  const t = useT();
  const accounts = useAccountStore((s) => s.accounts);
  const transactions = useTransactionStore((s) => s.transactions);
  const mode = useAppModeStore((s) => s.mode);
  const ledgerOnly = mode === 'splits_only';

  const refused = useMemo(() => isNeverCapture(text), [text]);
  const parsed = useMemo(() => (refused ? null : parseBankAlert(text)), [text, refused]);
  const account = useMemo(
    () => (parsed && !ledgerOnly ? matchCaptureAccount(parsed, accounts) : null),
    [parsed, accounts, ledgerOnly],
  );

  const [direction, setDirection] = useState<AlertDirection>('debit');
  const [showRaw, setShowRaw] = useState(false);

  // Re-seed per offer: the sheet is reused across captures.
  useEffect(() => {
    if (!open) return;
    setDirection(parsed?.direction ?? 'debit');
    setShowRaw(false);
    track('capture_offered', { source, parsed: refused ? 'refused' : parsed ? 'ok' : 'none' });
    // `text` is the identity of an offer; the other deps are derived from it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, text]);

  if (!open) return null;

  const sourceLabel = source === 'share' ? t('capture_from_share') : t('capture_from_notification');

  const record = () => {
    if (!parsed) return;
    const preset = buildCapturePreset(parsed, direction, account, transactions);
    track('capture_resolved', { action: 'record' });
    onRecord(preset);
  };
  const manual = () => {
    track('capture_resolved', { action: 'manual' });
    onManual({ amount: parsed?.amount, notes: parsed?.merchant ?? undefined });
  };
  const dismiss = () => {
    track('capture_resolved', { action: 'dismiss' });
    onClose();
  };

  // ── Nothing to offer ─────────────────────────────────────────────────────
  if (refused || !parsed) {
    return (
      <Modal
        open={open}
        onClose={dismiss}
        title={refused ? t('capture_refused_title') : t('capture_unparsed_title')}
        footer={
          refused ? (
            <button type="button" onClick={dismiss} className="m-btn m-btn-primary w-full py-3.5 text-[13.5px]">
              {t('done_btn')}
            </button>
          ) : (
            <button type="button" onClick={manual} className="m-btn m-btn-primary w-full py-3.5 text-[13.5px]">
              {t('capture_enter_manually')}
            </button>
          )
        }
      >
        <div className="space-y-3">
          <p className="text-[13px] text-ink-700 leading-relaxed">
            {refused ? t('capture_refused_body') : t('capture_unparsed_body')}
          </p>
          <RawText text={text} />
        </div>
      </Modal>
    );
  }

  // ── The offer ────────────────────────────────────────────────────────────
  const amountText = formatMoney(parsed.amount, parsed.currency);
  const spent = direction === 'debit';

  return (
    <Modal
      open={open}
      onClose={dismiss}
      title={t('capture_sheet_title')}
      footer={
        <div className="space-y-2">
          <button type="button" onClick={record} className="m-btn m-btn-primary w-full py-3.5 text-[13.5px]">
            {t('capture_record_cta')} · {amountText}
          </button>
          <button
            type="button"
            onClick={dismiss}
            className="w-full min-h-[44px] text-center text-[13px] font-semibold text-ink-500 active:text-ink-700 transition-colors"
          >
            {t('capture_not_this')}
          </button>
        </div>
      }
    >
      <div className="space-y-3">
        <p className="m-label text-[10px] flex items-center gap-1.5">
          <Glyph name={source === 'share' ? 'share' : 'bell'} size={13} tone="violet" /> {sourceLabel}
        </p>

        {/* Amount + direction. The direction is the one thing the parser gets
            wrong most, so it is a visible two-way switch, not a hidden guess. */}
        <div className="m-card p-4">
          <p className={`text-[26px] font-bold tracking-tight ${spent ? 'text-pay-text' : 'text-receive-text'}`}>
            {spent ? '−' : '+'}
            {amountText}
          </p>
          <div className="mt-3 grid grid-cols-2 gap-2" role="radiogroup" aria-label={t('capture_dir_unknown_hint')}>
            <DirectionChip
              active={spent}
              label={t('capture_dir_spent')}
              glyph="arrow-up"
              tone="coral"
              onClick={() => setDirection('debit')}
            />
            <DirectionChip
              active={!spent}
              label={t('capture_dir_received')}
              glyph="arrow-down"
              tone="green"
              onClick={() => setDirection('credit')}
            />
          </div>
          {parsed.direction === null && (
            <p className="text-[11.5px] text-warn-700 mt-2">{t('capture_dir_unknown_hint')}</p>
          )}
        </div>

        <div className="m-inset p-3.5 space-y-2 text-[12.5px]">
          {parsed.merchant && <Row label={t('capture_merchant_label')} value={parsed.merchant} />}
          {!ledgerOnly && (
            <Row
              label={t('capture_account_label')}
              value={
                account
                  ? account.name
                  : parsed.accountHint
                    ? t('capture_account_unmatched').replace('{last4}', parsed.accountHint)
                    : t('capture_account_pick')
              }
              muted={!account}
            />
          )}
          {parsed.occurredAt && <Row label={t('capture_date_label')} value={parsed.occurredAt} />}
          {parsed.balanceAfter !== null && (
            <p className="text-[11.5px] text-ink-500">
              {t('capture_balance_after').replace('{amount}', formatMoney(parsed.balanceAfter, parsed.currency))}
            </p>
          )}
          {ledgerOnly && <p className="text-[11.5px] text-ink-500">{t('capture_ledger_only_hint')}</p>}
        </div>

        <button
          type="button"
          onClick={() => setShowRaw((v) => !v)}
          aria-expanded={showRaw}
          className="text-[12px] font-semibold text-accent-600 min-h-[36px]"
        >
          {t('capture_raw_toggle')}
        </button>
        {showRaw && <RawText text={text} />}
      </div>
    </Modal>
  );
}

function Row({ label, value, muted = false }: { label: string; value: string; muted?: boolean }) {
  return (
    <div className="flex items-baseline gap-3">
      <span className="m-label text-[10px] w-16 shrink-0">{label}</span>
      <span className={`flex-1 ${muted ? 'text-ink-500' : 'text-ink-900 font-medium'}`}>{value}</span>
    </div>
  );
}

function DirectionChip({
  active,
  label,
  glyph,
  tone,
  onClick,
}: {
  active: boolean;
  label: string;
  glyph: 'arrow-up' | 'arrow-down';
  tone: 'coral' | 'green';
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      onClick={onClick}
      className={`m-ctl min-h-[44px] rounded-xl flex items-center justify-center gap-1.5 text-[13px] font-semibold transition-colors ${
        active ? 'ring-2 ring-accent-500 text-ink-900' : 'text-ink-500'
      }`}
    >
      <Glyph name={glyph} size={14} tone={active ? tone : 'neutral'} /> {label}
    </button>
  );
}

function RawText({ text }: { text: string }) {
  return (
    <pre className="m-inset p-3 text-[11px] text-ink-700 whitespace-pre-wrap break-words max-h-40 overflow-y-auto font-mono">
      {text}
    </pre>
  );
}
