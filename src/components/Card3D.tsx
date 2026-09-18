import { Glyph } from './Glyph';
import { resolveGlyph } from '../lib/glyphs';
import { tintClass, tintTone, type Tint } from '../lib/material';

type Padding = 'none' | 'sm' | 'md' | 'lg';

const PADDING: Record<Padding, string> = {
  none: 'p-0',
  sm: 'p-3.5',
  md: 'p-5',
  lg: 'p-6',
};

interface Props {
  /** `neutral` = the standard card face; any other tint gives the handoff's
   *  tinted stat-card face with matching walls (e.g. mint = "To receive"). */
  tint?: Tint;
  as?: 'div' | 'section' | 'article' | 'li';
  padding?: Padding;
  /** Optional corner glyph (glyph or retired clay name), in the tint's tone. */
  icon?: string;
  /** Feature-card radius (22px) instead of the standard 18px. */
  feature?: boolean;
  style?: React.CSSProperties;
  children: React.ReactNode;
  className?: string;
}

// 1d card: lit-top gradient face + ambient shadow; tinted cards add walls.
export function Card3D({
  tint = 'neutral',
  as: Tag = 'div',
  padding = 'md',
  icon,
  feature = false,
  style,
  children,
  className = '',
}: Props) {
  const resolved = resolveGlyph(icon);
  const tone = tint === 'neutral' && resolved ? (resolved.tone === 'current' ? 'neutral' : resolved.tone) : tintTone(tint);
  const classes = [
    'm-card',
    feature ? 'm-card-feature' : '',
    tintClass(tint),
    PADDING[padding],
    resolved ? 'pe-14' : '',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <Tag className={classes} style={style}>
      {resolved ? (
        <span aria-hidden className="absolute top-4 end-4 inline-flex">
          <Glyph name={resolved.glyph} tone={tone} size={24} extrude />
        </span>
      ) : null}
      {children}
    </Tag>
  );
}
