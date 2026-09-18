import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Glyph } from './Glyph';
import type { SettlementNudge } from '../lib/settlementNudges';
import { snoozeNudge } from '../lib/settlementNudges';
import { formatMoney } from '../lib/constants';
import { useT } from '../lib/i18n';

interface Props {
  nudges: SettlementNudge[];
}

// Surfaces only on HomePage. Renders nothing when the list is empty so the
// hosting page doesn't need a conditional wrapper. Tapping "Open in Inbox"
// navigates to /inbox where the user can act on the request properly;
// "Send WhatsApp" opens wa.me only if the contact has a phone on file.
// "Dismiss" snoozes the nudge for 24h.
export function SettlementNudgeBanner({ nudges }: Props) {
  const t = useT();
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const navigate = useNavigate();
  const visible = nudges.filter((n) => !dismissed.has(n.request.id));
  if (visible.length === 0) return null;

  const handleDismiss = (id: string) => {
    snoozeNudge(id);
    setDismissed((prev) => {
      const next = new Set(prev);
      next.add(id);
      return next;
    });
  };

  return (
    // Gold-tinted card: a heads-up, not an alarm. Rows sit on the card face
    // with hairlines between them, like every 1d list.
    <div className="m-card m-gold overflow-hidden">
      <div className="px-4 py-3 flex items-center gap-2 border-b border-cream-hairline">
        <Glyph name="bell" size={15} tone="gold" />
        <p className="text-[12px] font-semibold text-warn-700 tracking-[-0.01em]">
          {visible.length === 1
            ? t('snb_title_one')
            : t('snb_title_many').replace('{n}', String(visible.length))}
        </p>
      </div>
      <div className="divide-y divide-cream-hairline">
        {visible.map((nudge) => (
          <div key={nudge.request.id} className="px-4 py-3 flex items-start gap-3">
            <div className="m-inset w-8 h-8 rounded-[10px] flex items-center justify-center shrink-0" aria-hidden>
              <Glyph name="clock" size={15} tone="gold" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-[13px] font-semibold text-ink-900 tracking-[-0.01em]">
                {nudge.recipientLabel}
              </p>
              <p className="text-[11px] text-ink-600 mt-0.5 tabular-nums">
                {formatMoney(nudge.request.amount, nudge.request.currency)} ·{' '}
                {t('snb_days_ago').replace('{n}', String(nudge.daysOpen))}
              </p>
              <div className="flex items-center gap-2 mt-2.5 pb-1 flex-wrap">
                <button
                  onClick={() => navigate('/inbox')}
                  className="m-btn m-btn-plain px-3.5 py-2 text-[11.5px] rounded-xl gap-1.5"
                >
                  <Glyph name="inbox" size={14} tone="violet" />
                  {t('snb_open_inbox')}
                </button>
                {nudge.whatsappUrl && (
                  <a
                    href={nudge.whatsappUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="m-btn m-btn-plain px-3.5 py-2 text-[11.5px] rounded-xl gap-1.5"
                  >
                    <Glyph name="whatsapp" size={14} tone="green" />
                    {t('snb_whatsapp')}
                  </a>
                )}
              </div>
            </div>
            <button
              onClick={() => handleDismiss(nudge.request.id)}
              aria-label={t('a11y_snooze_24h')}
              className='relative w-7 h-7 rounded-lg flex items-center justify-center text-ink-500 active:opacity-60 transition-opacity shrink-0 before:absolute before:-inset-2 before:content-[""]'
            >
              <Glyph name="close" size={14} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
