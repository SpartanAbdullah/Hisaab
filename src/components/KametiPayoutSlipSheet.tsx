import { useEffect, useId, useMemo, useState } from 'react';
import { Glyph } from './Glyph';
import { Modal } from './Modal';
import { useToast } from './Toast';
import { useT } from '../lib/i18n';
import { formatMoney } from '../lib/constants';
import { moneyFormatter } from '../lib/maskMoney';
import { poolAmount, memberPosition } from '../lib/committeeMath';
import { generateKametiSlipPdf } from '../lib/kametiSlipPdf';
import { shareStatementFile } from '../lib/shareStatement';
import { buildWhatsAppUrl } from '../lib/whatsappReminder';
import type { Committee, CommitteeMember, CommitteePayment } from '../db';

interface Props {
  open: boolean;
  onClose: () => void;
  committee: Committee;
  recipient: CommitteeMember;
  round: number;
  payments: CommitteePayment[];
  witnessUrl?: string;
}

function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text);
  const ta = document.createElement('textarea');
  ta.value = text; ta.style.position = 'fixed'; ta.style.left = '-9999px';
  document.body.appendChild(ta); ta.select();
  try { document.execCommand('copy'); return Promise.resolve(); }
  catch (e) { return Promise.reject(e); }
  finally { document.body.removeChild(ta); }
}

export function KametiPayoutSlipSheet({ open, onClose, committee, recipient, round, payments, witnessUrl }: Props) {
  const t = useT();
  const toast = useToast();
  const [preparing, setPreparing] = useState(false);
  const [copying, setCopying] = useState(false);
  // Privacy: hide every figure in the shared slip/text. The witness link (if
  // present) still opens the live ledger with real amounts — noted in the UI.
  const [hideAmounts, setHideAmounts] = useState(false);
  const hideSwitchId = useId();

  useEffect(() => {
    if (open) setHideAmounts(false);
  }, [open]);

  const organiserName = useMemo(() => (localStorage.getItem('hisaab_user_name') ?? '').trim() || undefined, []);
  const pool = poolAmount(committee.contributionAmount, committee.memberCount);
  const position = useMemo(
    () => memberPosition(recipient, payments, committee.contributionAmount, committee.memberCount, committee.totalRounds),
    [recipient, payments, committee],
  );

  const message = useMemo(() => {
    const lines: string[] = [];
    lines.push(`*${t('kslip_title')} — ${committee.name}*`);
    lines.push(
      t('kslip_received_line')
        .replace('{amount}', moneyFormatter(hideAmounts)(pool, committee.currency))
        .replace('{r}', String(round))
        .replace('{n}', String(committee.totalRounds)),
    );
    lines.push('Shukriya!');
    if (witnessUrl) {
      lines.push('');
      lines.push(`${t('kslip_verify')}: ${witnessUrl}`);
    }
    lines.push('');
    lines.push(organiserName ? `— ${organiserName}, via Hisaab` : '— via Hisaab');
    return lines.join('\n');
  }, [t, committee, pool, round, witnessUrl, organiserName, hideAmounts]);

  const whatsappUrl = buildWhatsAppUrl(recipient.phone ?? null, message);

  const handleCopy = async () => {
    setCopying(true);
    try { await copyText(message); toast.show({ type: 'success', title: t('soa_copied') }); }
    catch { toast.show({ type: 'error', title: t('soa_copy_failed') }); }
    finally { setCopying(false); }
  };

  const handleSendPdf = async () => {
    setPreparing(true);
    try {
      const { blob, filename } = await generateKametiSlipPdf({
        committeeName: committee.name,
        currency: committee.currency,
        round,
        totalRounds: committee.totalRounds,
        pool,
        recipientName: recipient.name,
        contributed: position.contributed,
        net: position.net,
        witnessUrl,
        date: new Date().toISOString(),
        organiserName,
        hideAmounts,
      });
      const outcome = await shareStatementFile({ blob, filename, title: `${t('kslip_title')} — ${committee.name}`, text: `${recipient.name} · ${t('kslip_title')} (Hisaab)` });
      if (outcome === 'downloaded') toast.show({ type: 'success', title: t('soa_downloaded') });
      else if (outcome === 'shared') toast.show({ type: 'success', title: t('soa_ready') });
      else if (outcome === 'error') toast.show({ type: 'error', title: t('soa_share_failed') });
    } catch {
      toast.show({ type: 'error', title: t('soa_share_failed') });
    } finally {
      setPreparing(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('kslip_title')}
      footer={
        <div className="flex flex-col gap-3">
          {/* The slip PDF is this sheet's primary action — the primary (violet) button.
              (It used to be an inline navy fill, which vanished against the
              dark sheet.) The generated slip's own colours live in
              lib/kametiSlipPdf.ts and are untouched. */}
          <button
            onClick={handleSendPdf}
            disabled={preparing}
            className="m-btn m-btn-primary w-full py-3.5 text-[14px]"
          >
            <Glyph name="document" size={16} /> {preparing ? t('soa_preparing') : t('kslip_pdf')}
          </button>
          <div className="flex gap-2.5">
            <a
              href={whatsappUrl}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => toast.show({ type: 'success', title: t('reminder_wa_opening') })}
              className="m-btn m-btn-whatsapp flex-1 px-3 text-[13px]"
            >
              <Glyph name="whatsapp" size={15} /> {t('soa_whatsapp_text')}
            </a>
            <button
              onClick={handleCopy}
              disabled={copying}
              className="m-btn m-btn-plain px-4 text-[13px]"
            >
              <Glyph name="copy" size={15} /> {copying ? t('quick_processing') : t('soa_copy')}
            </button>
          </div>
        </div>
      }
    >
      {/* Receiving the pot is the moment a kameti exists for — months of
          contributions landing at once. The three blocks reveal in reading
          order so the sheet composes itself around that figure instead of
          appearing all at once with the privacy toggle competing for
          attention. */}
      <div className="space-y-4 stagger-in">
        <div className="m-card m-mint p-4">
          <p className="text-[10.5px] font-semibold uppercase tracking-[0.12em] text-receive-text">{t('kslip_received')} · {committee.currency}</p>
          {/* A single 4% swell on the amount — enough to read as "here it is",
              far short of anything that would look like celebration confetti
              over someone else's money. This is the app's one use of
              pulse-once, which is why the token still exists. */}
          <p className="text-[24px] font-semibold tracking-[-0.03em] text-ink-900 mt-1.5 tabular-nums animate-pulse-once">
            {formatMoney(pool, committee.currency)}
          </p>
          <p className="text-[11.5px] text-ink-600 mt-1">
            {t('kslip_intro').replace('{name}', recipient.name).replace('{r}', String(round))}
          </p>
        </div>

        {/* Privacy: hide the numbers — the witness link still shows live amounts. */}
        <div className="m-card flex items-center justify-between gap-3 px-4 py-3.5">
          <label htmlFor={hideSwitchId} className="min-w-0 cursor-pointer">
            <span className="block text-[13px] font-semibold text-ink-900">{t('soa_hide_amounts')}</span>
            <span className="block text-[11px] text-ink-600 mt-0.5 leading-relaxed">
              {witnessUrl ? `${t('soa_hide_amounts_sub')} ${t('kslip_hide_witness_note')}` : t('soa_hide_amounts_sub')}
            </span>
          </label>
          <button
            id={hideSwitchId}
            type="button"
            role="switch"
            aria-checked={hideAmounts}
            onClick={() => setHideAmounts(!hideAmounts)}
            className="m-switch"
          />
        </div>

        <div>
          <p className="form-label">{t('soa_preview')}</p>
          <div className="m-inset p-4 max-h-56 overflow-auto">
            <p className="text-[12px] text-ink-800 leading-relaxed whitespace-pre-line">{message}</p>
          </div>
        </div>
      </div>
    </Modal>
  );
}
