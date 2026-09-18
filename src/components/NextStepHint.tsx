import { Lightbulb, type LucideIcon } from 'lucide-react';
import { useT } from '../lib/i18n';
import { Glyph } from './Glyph';

type Tone = 'accent' | 'receive' | 'pay' | 'warn' | 'info';

interface Props {
  icon?: LucideIcon;
  status: string;
  next: string;
  tone?: Tone;
  actionLabel?: string;
  onAction?: () => void;
}

// 1d: a tinted card in the hint's tone (face + walls), the icon on a raised
// control in the matching glyph accent, and the action as a key-material
// button. The icon prop stays a LucideIcon (the API every caller uses); it is
// drawn at the 3c weight (2.4) in a glyph-tone colour so it sits with the
// glyph set.
const TONES: Record<Tone, { card: string; icon: string; status: string }> = {
  accent: { card: 'm-violet', icon: 'text-glyph-violet', status: 'text-accent-text' },
  receive: { card: 'm-mint', icon: 'text-glyph-green', status: 'text-receive-text' },
  pay: { card: 'm-coral', icon: 'text-glyph-coral', status: 'text-pay-text' },
  warn: { card: 'm-gold', icon: 'text-glyph-gold', status: 'text-warn-700' },
  info: { card: 'm-blue', icon: 'text-glyph-blue', status: 'text-cobalt-text' },
};

export function NextStepHint({
  icon: Icon = Lightbulb,
  status,
  next,
  tone = 'info',
  actionLabel,
  onAction,
}: Props) {
  const tt = TONES[tone];
  const t = useT();

  return (
    <div className={`m-card ${tt.card} p-4 flex items-start gap-3`}>
      <div className="m-ctl w-10 h-10 rounded-[14px] flex items-center justify-center shrink-0">
        <Icon size={18} strokeWidth={2.4} className={tt.icon} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <Glyph name="check" size={12} strokeWidth={3} className={tt.status} />
          <p className={`text-[10.5px] font-semibold uppercase tracking-[0.12em] ${tt.status}`}>
            {t('hint_current_status')}
          </p>
        </div>
        <p className="text-[13.5px] font-semibold text-ink-900 tracking-tight mt-1 leading-snug">
          {status}
        </p>
        <p className="text-[12px] text-ink-600 mt-1.5 leading-relaxed">{next}</p>
        {actionLabel && onAction ? (
          <button
            type="button"
            onClick={onAction}
            className="m-btn m-btn-plain mt-3 min-h-[40px] px-3.5 py-2 rounded-xl text-[12px]"
          >
            {actionLabel}
            <Glyph name="arrow-right" size={13} strokeWidth={2.8} />
          </button>
        ) : null}
      </div>
    </div>
  );
}
