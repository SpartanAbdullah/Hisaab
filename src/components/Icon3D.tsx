import { Glyph } from './Glyph';
import { resolveGlyph, type GlyphTone } from '../lib/glyphs';

type Size = 'sm' | 'md' | 'lg';

// Rendered px per size. The retired 3dicons were 36/48/64px illustrations; a
// glyph reads at a fraction of that, so the steps are the handoff's inline /
// plate / tile sizes.
const PX: Record<Size, number> = { sm: 20, md: 26, lg: 30 };

interface Props {
  /** A glyph name, or a retired clay icon name (mapped via CLAY_TO_GLYPH). */
  name: string;
  size?: Size;
  /** Accent override; defaults to the icon's own semantic tone. */
  tone?: GlyphTone;
  /** @deprecated The floating-over-the-edge clay placement is gone; kept so
   *  existing call sites compile. Has no effect. */
  float?: boolean;
  className?: string;
}

// Kept as the migration shim for every former 3D-clay icon call site: it now
// renders the matching 3c glyph (extruded, decorative). Unknown names render
// nothing, exactly as before. New code should use <Glyph> directly.
export function Icon3D({ name, size = 'md', tone, className = '' }: Props) {
  const resolved = resolveGlyph(name);
  if (!resolved) return null;
  return (
    <Glyph
      name={resolved.glyph}
      tone={tone ?? (resolved.tone === 'current' ? 'neutral' : resolved.tone)}
      size={PX[size]}
      extrude
      className={className}
    />
  );
}
