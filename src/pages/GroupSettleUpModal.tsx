import { useEffect, useMemo, useState } from 'react';
import { Modal } from '../components/Modal';
import { Glyph } from '../components/Glyph';
import { useToast } from '../components/Toast';
import { useT } from '../lib/i18n';
import { useSubmitGuard } from '../lib/useSubmitGuard';
import { formatMoney } from '../lib/constants';
import { memberSettleUp, buildMemberCardText } from '../lib/groupSettleUp';
import { generateGroupSettleUpPdf } from '../lib/groupSettleUpPdf';
import { shareStatementFile } from '../lib/shareStatement';
import { buildWhatsAppUrl } from '../lib/whatsappReminder';
import { greetingLine, type GreetingStyle } from '../lib/statementText';
import type { GroupDebt } from '../lib/groupDebts';
import type { SplitGroup, GroupExpense } from '../db';

interface Props {
  open: boolean;
  onClose: () => void;
  group: SplitGroup;
  debts: GroupDebt[]; // the currently-shown debts (direct or simplified)
  expenses: GroupExpense[];
  simplify: boolean;
  currentMemberId?: string;
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

export function GroupSettleUpModal({ open, onClose, group, debts, expenses, simplify, currentMemberId }: Props) {
  const t = useT();
  const toast = useToast();
  const [selectedId, setSelectedId] = useState<string>('');
  const [greetingStyle, setGreetingStyle] = useState<GreetingStyle>('hello');
  // Privacy: hide every figure in the shared card/PDF — names and structure stay.
  const [hideAmounts, setHideAmounts] = useState(false);
  const [preparing, setPreparing] = useState(false);
  // No money moves here, but a double tap on a slow device fires two PDF
  // builds and two share sheets. Same ref-backed guard for uniformity.
  const submitGuard = useSubmitGuard();
  const [copying, setCopying] = useState(false);

  // Default to the current user's own card (privacy-safe — you're not exposing
  // everyone's balances by default).
  useEffect(() => {
    if (open) {
      setSelectedId(currentMemberId ?? group.members[0]?.id ?? '');
      setGreetingStyle('hello');
      setHideAmounts(false);
    }
  }, [open, currentMemberId, group.members]);

  const myName = useMemo(() => (localStorage.getItem('hisaab_user_name') ?? '').trim(), []);
  const selectedMember = group.members.find((m) => m.id === selectedId);
  const su = useMemo(() => memberSettleUp(debts, selectedId), [debts, selectedId]);
  const greeting = useMemo(
    () => greetingLine(greetingStyle, selectedMember?.name ?? ''),
    [greetingStyle, selectedMember?.name],
  );
  const message = useMemo(
    () => buildMemberCardText(su, { groupName: group.name, currency: group.currency, greeting, fromName: myName || undefined, hideAmounts }),
    [su, group.name, group.currency, greeting, myName, hideAmounts],
  );
  const whatsappUrl = buildWhatsAppUrl(null, message); // group members have no stored phone → picker

  const greetLabels: Record<GreetingStyle, string> = {
    hello: t('soa_greet_hello'), salaam: t('soa_greet_salaam'), dear: t('soa_greet_dear'), none: t('soa_greet_none'),
  };

  const netLabel = su.net > 0.005
    ? t('gsu_you_receive').replace('{amount}', formatMoney(su.net, group.currency))
    : su.net < -0.005
    ? t('gsu_you_pay').replace('{amount}', formatMoney(Math.abs(su.net), group.currency))
    : t('gsu_settled');

  const handleCopy = async () => {
    setCopying(true);
    try { await copyText(message); toast.show({ type: 'success', title: t('soa_copied') }); }
    catch { toast.show({ type: 'error', title: t('soa_copy_failed') }); }
    finally { setCopying(false); }
  };

  const handleFullPlanPdf = () => submitGuard.run(runFullPlanPdf);

  const runFullPlanPdf = async () => {
    setPreparing(true);
    try {
      const nameOf = new Map(group.members.map((m) => [m.id, m.name]));
      const planExpenses = expenses.map((e) => ({
        date: e.date, description: e.description, paidByName: nameOf.get(e.paidBy) ?? '?', amount: e.amount,
      }));
      const { blob, filename } = await generateGroupSettleUpPdf({
        groupName: group.name, emoji: group.emoji, currency: group.currency,
        debts, expenses: planExpenses, simplify, asOf: new Date().toISOString(), fromName: myName || undefined,
        hideAmounts,
      });
      const outcome = await shareStatementFile({ blob, filename, title: `${t('gsu_title')} — ${group.name}`, text: `${group.name} · ${t('gsu_title')} (Hisaab)` });
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
      title={t('gsu_title')}
      footer={
        <div className="flex flex-col gap-2.5">
          {/* The full plan PDF is this sheet's primary action — violet. */}
          <button
            onClick={handleFullPlanPdf}
            disabled={preparing}
            className="cta-primary"
          >
            <Glyph name="document" size={17} strokeWidth={2.6} /> {preparing ? t('soa_preparing') : t('gsu_full_plan_pdf')}
          </button>
          <div className="flex gap-2.5">
            {/* WhatsApp keeps its brand green (the whatsapp token). */}
            <a
              href={whatsappUrl}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => toast.show({ type: 'success', title: t('reminder_wa_opening') })}
              className="m-btn m-btn-whatsapp flex-1 text-[13px]"
            >
              <Glyph name="whatsapp" size={15} strokeWidth={2.6} /> {t('gsu_send_card')}
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
      <div className="space-y-5">
        <p className="text-[12px] text-ink-600 leading-relaxed">{t('gsu_intro')}</p>

        {/* Member picker — whose card to send. Defaults to you. */}
        <div>
          <p className="form-label">{t('gsu_for_member')}</p>
          <div className="flex flex-wrap gap-2.5">
            {group.members.map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => setSelectedId(m.id)}
                aria-pressed={selectedId === m.id}
                className={`selector-base w-auto justify-center gap-1.5 min-h-[40px] px-3.5 py-2 rounded-[14px] text-[12px] font-semibold text-ink-800 ${
                  selectedId === m.id ? 'selector-selected' : ''
                }`}
              >
                {selectedId === m.id && <Glyph name="check" size={12} strokeWidth={3} tone="violet" />}
                {m.name}{m.id === currentMemberId ? ` · ${t('label_you')}` : ''}
              </button>
            ))}
          </div>
        </div>

        {/* Net headline for the selected member — a tinted stat card: green
            when they receive, coral when they pay, plain when square. */}
        <div className={`m-card p-4 ${su.net > 0.005 ? 'm-mint' : su.net < -0.005 ? 'm-coral' : ''}`}>
          <p className={`text-[10.5px] font-semibold uppercase tracking-[0.12em] ${su.net > 0.005 ? 'text-receive-text' : su.net < -0.005 ? 'text-pay-text' : 'text-ink-500'}`}>
            {group.currency}
          </p>
          <p className="text-[15px] font-semibold text-ink-900 tracking-[-0.01em] mt-1">{netLabel}</p>
        </div>

        {/* Greeting selector (opens the member card) — one of four. */}
        <div>
          <p className="form-label">{t('soa_greeting_label')}</p>
          <div className="m-seg flex w-full">
            {(['hello', 'salaam', 'dear', 'none'] as GreetingStyle[]).map((style) => (
              <button
                key={style}
                type="button"
                onClick={() => setGreetingStyle(style)}
                aria-pressed={greetingStyle === style}
                className="flex-1 min-w-0 min-h-[40px] px-1 text-[11.5px]"
              >
                {greetLabels[style]}
              </button>
            ))}
          </div>
        </div>

        {/* Privacy: hide the numbers — names and structure stay. The whole
            row is the switch. */}
        <button
          type="button"
          role="switch"
          aria-checked={hideAmounts}
          onClick={() => setHideAmounts((v) => !v)}
          className="selector-base gap-3 px-4 py-3"
        >
          <span className="min-w-0 text-[12.5px] font-semibold text-ink-800">
            {t('soa_hide_amounts')}
            <span className="block text-[10.5px] font-normal text-ink-500 mt-0.5">{t('soa_hide_amounts_sub')}</span>
          </span>
          <span className={`m-switch ${hideAmounts ? 'is-on' : ''}`} aria-hidden="true" />
        </button>

        {/* Preview of the member card — set in a recessed well. */}
        <div>
          <p className="form-label">{t('soa_preview')}</p>
          <div className="m-inset p-4 max-h-56 overflow-auto">
            <p className="text-[12px] text-ink-800 leading-relaxed whitespace-pre-line">{message}</p>
          </div>
          <p className="text-[10.5px] text-ink-500 mt-2">{t('gsu_pick_hint')}</p>
        </div>
      </div>
    </Modal>
  );
}
