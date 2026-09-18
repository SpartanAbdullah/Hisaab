import { Button } from './Button';
import { Glyph } from './Glyph';
import { GLYPH_TONE_CLASS, resolveGlyph, type GlyphTone } from '../lib/glyphs';
import type { LucideIcon } from 'lucide-react';

type Tone = 'indigo' | 'accent' | 'receive' | 'pay' | 'warn' | 'violet' | 'blue' | 'pink' | 'gold';

interface Props {
  /** Fallback line icon, used only when `clayIcon` doesn't resolve. */
  icon?: LucideIcon;
  /** A 3c glyph name (or a retired clay icon name) — preferred. */
  clayIcon?: string;
  title: string;
  description: string;
  subhint?: string;
  actionLabel?: string;
  onAction?: () => void;
  secondaryActionLabel?: string;
  onSecondaryAction?: () => void;
  tone?: Tone;
  size?: 'default' | 'compact';
  /** The CTA's button variant. Violet `primary` by default; `hero` (same
   *  violet) on AI / Investments empty states, per the handoff. */
  actionVariant?: 'primary' | 'hero';
}

// Tone → the plate's tint scope + the glyph's accent. `indigo`/`accent` are the
// historical names for the primary tone: the brand violet.
const TONES: Record<Tone, { plate: string; glyph: GlyphTone }> = {
  indigo: { plate: 'm-violet', glyph: 'violet' },
  accent: { plate: 'm-violet', glyph: 'violet' },
  gold: { plate: 'm-gold', glyph: 'gold' },
  receive: { plate: 'm-mint', glyph: 'green' },
  pay: { plate: 'm-coral', glyph: 'coral' },
  warn: { plate: 'm-gold', glyph: 'gold' },
  violet: { plate: 'm-violet', glyph: 'violet' },
  blue: { plate: 'm-blue', glyph: 'blue' },
  pink: { plate: 'm-pink', glyph: 'pink' },
};

// The 1d empty state: a 56px tinted plate holding a 26px extruded glyph, a
// 15px title, a short body (≤270px) and an optional primary (violet) CTA. The one place a
// glyph sits on a plate. The plate floats gently (empty screens only — see
// .animate-float-idle in index.css).
export function EmptyState({
  icon: Icon,
  clayIcon,
  title,
  description,
  subhint,
  actionLabel,
  onAction,
  secondaryActionLabel,
  onSecondaryAction,
  tone = 'indigo',
  size = 'default',
  actionVariant = 'primary',
}: Props) {
  const tn = TONES[tone];
  const isCompact = size === 'compact';
  const resolved = resolveGlyph(clayIcon);

  return (
    <div
      className={`flex flex-col items-center justify-center text-center ${
        isCompact ? 'py-10 px-6' : 'pt-12 pb-10 px-7'
      }`}
    >
      <div className={`m-plate ${tn.plate} mb-[18px] ${isCompact ? '' : 'animate-float-idle'}`} aria-hidden>
        {resolved ? (
          <Glyph name={resolved.glyph} tone={tn.glyph} size={26} extrude />
        ) : Icon ? (
          <Icon size={24} strokeWidth={2.4} className={GLYPH_TONE_CLASS[tn.glyph]} />
        ) : null}
      </div>
      <h3 className="font-semibold text-[15px] text-ink-900 tracking-tight">{title}</h3>
      <p className="text-[12px] text-ink-600 mt-1.5 max-w-[270px] leading-relaxed">{description}</p>
      {subhint && (
        <p className="text-[11.5px] text-ink-400 italic mt-2 max-w-[250px]">{subhint}</p>
      )}
      {(actionLabel && onAction) || (secondaryActionLabel && onSecondaryAction) ? (
        <div className="mt-5 flex flex-col items-stretch gap-2 min-w-[200px]">
          {actionLabel && onAction && (
            <Button variant={actionVariant} size="md" onClick={onAction} className="justify-center">
              {actionLabel}
            </Button>
          )}
          {secondaryActionLabel && onSecondaryAction && (
            <button
              onClick={onSecondaryAction}
              className="text-[12px] font-semibold text-ink-500 active:text-ink-700 py-2 transition-colors"
            >
              {secondaryActionLabel}
            </button>
          )}
        </div>
      ) : null}
    </div>
  );
}
