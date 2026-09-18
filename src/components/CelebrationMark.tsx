import type { CSSProperties } from 'react';
import { confettiBits } from '../lib/motion';

interface Props {
  size?: number;
  /** 'receive' = settled / cleared (green). 'accent' = a neutral milestone. */
  tone?: 'receive' | 'accent';
  className?: string;
  /**
   * Twenty clay-coloured bits burst outward and fade — the founder-approved
   * "settle-up burst" (2026-09-05), reserved for a debt actually closing.
   * On by default: ConfirmationSheet renders the mark only when a repayment
   * settled a loan, so it takes the default. The daily Hisaab check passes
   * false — a burst that fires every day becomes a tic and devalues the one
   * it is meant for. Pass false too where the mark sits inside a dense
   * layout that can't afford the ~95px overflow.
   */
  burst?: boolean;
}

// The "you're clear" mark.
//
// A static tick says "this is true". A tick that DRAWS says "this just became
// true" — and that difference is the whole payoff of the Hisaab check ritual
// and of settling a debt. Those are the two moments the product exists for,
// so they get the app's only bouncy curve; everything else settles on the
// calm expo ease.
//
// Call sites: ConfirmationSheet with `settled` (a repayment that closed a
// loan — ring, pop, tick AND the confetti) and HisaabCheckModal step 4 (the
// daily ritual — ring, pop and tick only, burst={false}).
//
// Four layers on one timeline (see .animate-celebrate-* and
// .animate-confetti-bit in index.css):
//   0.00s  disc scales up past 1 and settles back
//   0.05s  ring expands outward and dissolves
//   0.16s  confetti bits leave the centre in five 40ms waves, fade by ~1.2s
//   0.28s  checkmark strokes itself on, left segment then right
//
// Ring, disc and tick are done by ~0.75s: long enough to register as a
// moment, short enough that it's finished before the user's thumb reaches
// the Done button. The last confetti fades a beat later, once the tick is
// already read, so it decorates the moment without delaying it.
//
// Geometry for the burst is computed ONCE at module load: it is pure and
// deterministic (src/lib/motion.ts), so every mount and re-render hands the
// CSS the same custom properties and an in-flight burst is never re-aimed.
const BITS = confettiBits();

// 1d disc: the empty-state plate material in the round — the tint scope's lit
// face (--m-top → --m-bottom), a lit top edge and one hard 3px wall — so the
// mark sits on the same extruded surface as every other plate. Stroke and ring
// take the 3c glyph tone (≥3:1 on the plate in both themes, and re-scoped to
// the dark values inside a hero band such as ConfirmationSheet's).
const DISC_STYLE: CSSProperties = {
  backgroundImage: 'linear-gradient(var(--m-top), var(--m-bottom))',
  boxShadow: 'inset 0 1px 0 var(--m-hi-strong), 0 3px 0 var(--m-wall-1)',
};

export function CelebrationMark({ size = 56, tone = 'receive', className = '', burst = true }: Props) {
  const ringColor = tone === 'receive' ? 'var(--color-glyph-green)' : 'var(--color-glyph-violet)';
  const discClass = tone === 'receive' ? 'm-mint' : 'm-violet';
  const strokeColor = ringColor;

  return (
    // No overflow-hidden here, deliberately: the ring and the confetti both
    // travel well outside this box, and a clip would decapitate the burst.
    <div
      className={`relative inline-flex items-center justify-center shrink-0 ${className}`}
      style={{ width: size, height: size }}
    >
      {/* Expanding ring. Pointer-events-none and aria-hidden: it is pure
          decoration that briefly overflows its box. */}
      <span
        aria-hidden
        className="absolute inset-0 rounded-full animate-celebrate-ring pointer-events-none"
        style={{ border: `2px solid ${ringColor}` }}
      />
      <span
        className={`absolute inset-0 rounded-full ${discClass} animate-celebrate-pop`}
        style={DISC_STYLE}
        aria-hidden
      />
      <svg
        width={size * 0.5}
        height={size * 0.5}
        viewBox="0 0 24 24"
        fill="none"
        className="relative"
        aria-hidden
      >
        {/* One continuous path so the tick draws as a single gesture.
            pathLength normalises its length to 100 units no matter what the
            geometry actually measures, which is what lets
            .animate-celebrate-check use an exact dash array. Without it the
            dash values have to guess the real length (~23.35 here) and the
            draw either finishes early and idles, or never closes. */}
        <path
          d="M4 12.5 L9.5 18 L20 6.5"
          pathLength={100}
          stroke={strokeColor}
          strokeWidth={3}
          strokeLinecap="round"
          strokeLinejoin="round"
          className="animate-celebrate-check"
        />
      </svg>
      {/* Confetti. Each bit starts at the mark's centre (left/top 50%, pulled
          back 4px so the 8px body is centred) and the CSS flies it to
          --dx/--dy while spinning to --rot after --d. Rendered AFTER the disc
          so the bits pass over it, as in the approved preview. The class owns
          the rest state (opacity 0) and the reduced-motion gate, so nothing
          here needs to know whether motion is on. */}
      {burst &&
        BITS.map((bit, i) => (
          <i
            key={i}
            aria-hidden
            className={`absolute left-1/2 top-1/2 -m-1 pointer-events-none animate-confetti-bit ${
              bit.shape === 'dot' ? 'w-2 h-2 rounded-full' : 'w-[7px] h-[10px] rounded-[2px]'
            }`}
            style={
              {
                '--dx': `${bit.dx}px`,
                '--dy': `${bit.dy}px`,
                '--rot': `${bit.rot}deg`,
                '--d': `${bit.delayMs}ms`,
                background: `rgb(${bit.color})`,
              } as CSSProperties
            }
          />
        ))}
    </div>
  );
}
