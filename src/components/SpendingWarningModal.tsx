import { useState } from 'react';
import { Modal } from './Modal';
import { Glyph } from './Glyph';
import { formatMoney } from '../lib/constants';
import { useT } from '../lib/i18n';
import type { UpcomingExpense } from '../db';

interface Props {
  open: boolean;
  expense: UpcomingExpense | null;
  onContinue: () => void;
  onCancel: () => void;
}

export function SpendingWarningModal({ open, expense, onContinue, onCancel }: Props) {
  const t = useT();
  // One-shot capture — daysLeft is a display calc, not a tick. Date.now()
  // in the render body violates React's purity rule.
  const [now] = useState(() => Date.now());
  if (!expense) return null;

  const daysLeft = Math.ceil((new Date(expense.dueDate).getTime() - now) / (1000 * 60 * 60 * 24));

  return (
    <Modal open={open} onClose={onCancel} title={t('spend_warning_title')}
      footer={
        <div className="flex gap-2.5">
          <button onClick={onCancel} className="cta-secondary flex-1">
            {t('spend_warning_cancel')}
          </button>
          <button onClick={onContinue} className="cta-primary flex-1">
            {t('spend_warning_continue')}
          </button>
        </div>
      }
    >
      <div className="flex flex-col items-center text-center gap-4 py-2">
        <div className="m-plate m-gold" aria-hidden>
          <Glyph name="alert" size={26} tone="gold" extrude />
        </div>
        <div>
          <p className="text-[15px] font-semibold text-ink-900 tracking-tight">
            {t('spend_warning_remember').replace('{title}', expense.title)}
          </p>
          <p className="text-[13px] text-ink-700 mt-2 leading-relaxed">
            {t('spend_warning_body')
              .replace('{amount}', formatMoney(expense.amount, expense.currency))
              .replace('{title}', expense.title)}
          </p>
          <p className="text-[12px] text-ink-500 mt-1.5 tabular-nums">
            {new Date(expense.dueDate).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
            {' — '}
            {daysLeft <= 0 ? t('upcoming_overdue') : `${daysLeft} ${t('upcoming_due_in')}`}
          </p>
        </div>
        <p className="m-card m-gold w-full text-[12.5px] text-warn-700 p-3 font-medium">
          {t('spend_warning_confirm_q')}
        </p>
      </div>
    </Modal>
  );
}
