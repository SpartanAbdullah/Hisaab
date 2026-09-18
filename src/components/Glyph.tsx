import { createElement } from 'react';
import {
  GLYPHS,
  GLYPH_TONE_CLASS,
  glyphStrokeWidth,
  type GlyphName,
  type GlyphTone,
} from '../lib/glyphs';

interface Props {
  name: GlyphName;
  /** Semantic accent; `current` (default) inherits the text colour. */
  tone?: GlyphTone;
  /** Rendered px (square). Tiles 28 · empty-state plates 26 · inline 15–19. */
  size?: number;
  /** Defaults by size (3 / 2.6 / 2.4 — see glyphStrokeWidth). */
  strokeWidth?: number;
  /** The handoff's hard, unblurred drop under the stroke — the extrusion.
   *  Tiles and plates use it; inline glyphs in text don't. */
  extrude?: boolean;
  /** Give the glyph an accessible name. Omit for decorative use (default),
   *  which hides it from assistive tech — the adjacent label carries meaning. */
  label?: string;
  className?: string;
}

// The 3c icon: inline SVG, stroke only, colour from a theme-aware token class.
export function Glyph({
  name,
  tone = 'current',
  size = 20,
  strokeWidth,
  extrude = false,
  label,
  className = '',
}: Props) {
  const elements = GLYPHS[name];
  if (!elements) return null;
  const classes = [
    'shrink-0',
    GLYPH_TONE_CLASS[tone],
    extrude ? 'm-glyph-extrude' : '',
    className,
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth ?? glyphStrokeWidth(size)}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={classes}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      focusable="false"
    >
      {elements.map(([tag, attrs], i) => createElement(tag, { key: i, ...attrs }))}
    </svg>
  );
}
