import { useEffect, useState, type ReactNode } from 'react';
import { useReducedMotion } from '../hooks/useReducedMotion';

interface Props {
  size?: number;
  strokeWidth?: number;
  progress: number; // 0..1
  color?: string;
  trackColor?: string;
  children?: ReactNode;
  className?: string;
}

// Minimal SVG progress ring. Rotated -90° so progress grows clockwise from 12
// o'clock. Animated via stroke-dashoffset transition.
//
// That transition used to be dead code. The ring rendered its final offset on
// the very first paint, and a CSS transition only fires on a CHANGE — so
// there was nothing to animate FROM and the arc simply appeared. Every ring a
// user actually meets (opening Goals, opening a group) is a mount, so the
// draw-on the 0.7s curve was written for never played once.
//
// Now the first paint is committed at zero and the real value lands on the
// next frame. Two frames of empty ring is imperceptible; a goal visibly
// filling is the entire reason to draw a progress ring instead of a number.
// 1d: both strokes default to theme tokens — the violet accent arc over the
// material's recessed track tint (--m-track), so a ring sits in a card the way
// the inset progress bars do and flips with the theme. Callers may still pass
// any CSS colour (prefer a var(--color-*) token).
export function ProgressRing({
  size = 48,
  strokeWidth = 4,
  progress,
  color = 'var(--color-accent-500)',
  trackColor = 'var(--m-track)',
  children,
  className,
}: Props) {
  const clamped = Math.max(0, Math.min(1, Number.isFinite(progress) ? progress : 0));
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const reduced = useReducedMotion();

  // Reduced motion starts AT the true value: no draw-on, and no empty first
  // frame to explain away.
  const [shown, setShown] = useState(() => (reduced ? clamped : 0));

  useEffect(() => {
    if (reduced) {
      const id = requestAnimationFrame(() => setShown(clamped));
      return () => cancelAnimationFrame(id);
    }
    // Double rAF: the first frame guarantees the zero state is committed,
    // the second changes it. With a single frame the browser can coalesce
    // both values into one style recalculation, which collapses the
    // transition back into the instant jump this is fixing.
    let inner = 0;
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => setShown(clamped));
    });
    return () => {
      cancelAnimationFrame(outer);
      cancelAnimationFrame(inner);
    };
  }, [clamped, reduced]);

  const offset = circumference * (1 - shown);

  return (
    <div
      className={`relative inline-flex items-center justify-center shrink-0 ${className ?? ''}`}
      style={{ width: size, height: size }}
    >
      <svg width={size} height={size} className="-rotate-90" aria-hidden>
        {/* Strokes go through `style`, not the stroke attribute: a var()
            token resolves reliably in CSS, where presentation-attribute
            support for var() varies between WebViews. */}
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          strokeWidth={strokeWidth}
          fill="none"
          style={{ stroke: trackColor }}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          strokeWidth={strokeWidth}
          fill="none"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          strokeLinecap="round"
          style={{
            stroke: color,
            transition: reduced
              ? 'none'
              : 'stroke-dashoffset 0.9s cubic-bezier(0.16,1,0.3,1)',
          }}
        />
      </svg>
      {children && (
        <div className="absolute inset-0 flex items-center justify-center">
          {children}
        </div>
      )}
    </div>
  );
}
