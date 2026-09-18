import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { Link } from 'react-router-dom';
import { Glyph } from './Glyph';
import { resolveGlyph } from '../lib/glyphs';
import { TILE_GLYPH_PX, tintClass, tintTone, type Tint, type TileGlyphSize } from '../lib/material';

interface Props {
  /** Accent. On `top` tiles (the Home grid) it colours the glyph only — the
   *  face stays neutral, as in the handoff. On `corner` tiles it also tints
   *  the face and walls. */
  tint?: Tint;
  /** A glyph name, or a retired clay icon name. */
  icon?: string;
  iconPlacement?: 'corner' | 'top';
  iconSize?: TileGlyphSize;
  title: string;
  /** `hidden` keeps the title for screen readers only (icon-only tiles). */
  label?: 'below' | 'hidden';
  subtitle?: string;
  badge?: React.ReactNode;
  badgePlacement?: 'inline' | 'corner';
  selected?: boolean;
  onClick?: () => void;
  to?: string;
  disabled?: boolean;
  className?: string;
}

const SQUISH_MS = 420;

// 1d tile: gradient face, lit top edge, one hard 2px wall, ambient shadow.
// Pressing drops the tile onto its wall (index.css .m-tile:active).
//
// All copy comes in as props — the component holds no strings, so both
// languages come from the caller's t() calls.
export function Tile3D({
  tint = 'neutral',
  icon,
  iconPlacement = 'corner',
  iconSize = 'md',
  title,
  label = 'below',
  subtitle,
  badge,
  badgePlacement = 'inline',
  selected,
  onClick,
  to,
  disabled = false,
  className = '',
}: Props) {
  const resolved = resolveGlyph(icon);
  const isTop = iconPlacement === 'top';
  const titleHidden = label === 'hidden' && isTop && Boolean(resolved);

  // Tap squish on the glyph (founder-approved cute motion, 2026-09-05): it
  // squashes down into the face as the face drops onto its wall.
  const [squishing, setSquishing] = useState(false);
  const squishTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (squishTimer.current) clearTimeout(squishTimer.current);
    },
    [],
  );
  const cancelSquish = () => {
    if (squishTimer.current) {
      clearTimeout(squishTimer.current);
      squishTimer.current = null;
    }
    setSquishing(false);
  };
  const cancelSquishIfHeld = (e: ReactPointerEvent<HTMLElement>) => {
    if (e.buttons !== 0) cancelSquish();
  };
  const squish = () => {
    if (disabled || !resolved) return;
    if (squishTimer.current) clearTimeout(squishTimer.current);
    setSquishing(true);
    squishTimer.current = setTimeout(() => {
      squishTimer.current = null;
      setSquishing(false);
    }, SQUISH_MS);
  };

  const tone = tint === 'neutral' && resolved ? (resolved.tone === 'current' ? 'neutral' : resolved.tone) : tintTone(tint);

  const classes = [
    'm-tile',
    isTop ? 'm-tile-top m-neutral text-center px-1 pt-3.5 pb-3' : `${tintClass(tint)} p-3.5`,
    !isTop && resolved ? 'pe-12' : '',
    selected ? 'm-tile-selected' : '',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  const glyph = resolved ? (
    <span
      aria-hidden
      className={[
        'inline-flex',
        isTop ? 'mx-auto mb-2' : 'absolute top-3.5 end-3.5',
        squishing ? 'clay-icon-squish' : '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <Glyph name={resolved.glyph} tone={tone} size={TILE_GLYPH_PX[iconSize]} extrude />
    </span>
  ) : null;

  const body = (
    <>
      {isTop ? <span className="flex justify-center">{glyph}</span> : glyph}
      {/* `sr-only`, never `aria-label` on the element: the title stays a real
          text node, so it is what the accessible name is computed from. */}
      <span
        className={
          titleHidden
            ? 'sr-only'
            : isTop
              ? 'm-tile-label block font-medium leading-tight text-ink-600'
              : 'block text-[14px] font-semibold tracking-tight text-ink-900'
        }
      >
        {title}
      </span>
      {subtitle && !titleHidden ? (
        <span className={isTop ? 'block text-[10px] text-ink-400 mt-0.5' : 'block text-[12px] leading-snug text-ink-600 mt-0.5'}>
          {subtitle}
        </span>
      ) : null}
      {badge ? (
        badgePlacement === 'corner' ? (
          <span className="m-badge m-badge-brand absolute top-1.5 end-1.5">{badge}</span>
        ) : (
          <span className="m-chip m-chip-neutral mt-2">{badge}</span>
        )
      ) : null}
    </>
  );

  if (to && !disabled) {
    return (
      <Link
        to={to}
        className={classes}
        aria-current={selected ? 'page' : undefined}
        onPointerDown={squish}
        onPointerCancel={cancelSquish}
        onPointerLeave={cancelSquishIfHeld}
      >
        {body}
      </Link>
    );
  }

  return (
    <button
      type="button"
      onClick={onClick}
      onPointerDown={squish}
      onPointerCancel={cancelSquish}
      onPointerLeave={cancelSquishIfHeld}
      disabled={disabled}
      aria-pressed={selected}
      className={classes}
    >
      {body}
    </button>
  );
}
