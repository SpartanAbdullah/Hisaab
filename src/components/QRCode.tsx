import { useMemo } from 'react';
import { buildQrMatrix } from '../lib/qrMatrix';

interface Props {
  /** The string to encode. */
  value: string;
  /** Rendered edge length in CSS pixels. */
  size?: number;
  /** Quiet-zone width in MODULES. The spec asks for 4; below that, scanners
   *  start failing against busy backgrounds. */
  margin?: number;
  className?: string;
  title?: string;
}

// Module + quiet-zone paint. Fixed tokens, NOT theme-flipping ones: a QR must
// be dark-on-light in both themes or scanners give up. The quiet zone is pure
// white and the modules the navy-900 hero ink (#0A0A14) — ~19:1, which is the
// contrast scanners want. Classes rather than inline hex, so the colours live
// in the token layer (index.css @theme).
const QR_QUIET_ZONE_CLASS = 'fill-white';
const QR_MODULE_CLASS = 'fill-navy-900';

// SVG rather than canvas: a QR is pure geometry, so vector output stays
// razor-sharp on every DPR (a canvas at 1x is visibly soft on a 3x phone,
// and soft modules are exactly what makes a scan take three tries). It also
// costs no ref/effect and re-renders synchronously with the value.
//
// The grid itself is built by lib/qrMatrix.ts, which is round-trip tested
// against the same decoder the in-app scanner uses.
export function QRCode({ value, size = 220, margin = 4, className = '', title }: Props) {
  const matrix = useMemo(
    () => (value ? buildQrMatrix(value, margin) : null),
    [value, margin],
  );

  if (!matrix) {
    return (
      <div
        className={`m-skel rounded-2xl ${className}`}
        style={{ width: size, height: size }}
        aria-hidden
      />
    );
  }

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${matrix.extent} ${matrix.extent}`}
      className={className}
      role="img"
      aria-label={title ?? 'QR code'}
      // shape-rendering: crispEdges stops the browser antialiasing module
      // boundaries into grey mush at small sizes.
      shapeRendering="crispEdges"
    >
      {/* Explicit white quiet zone. A transparent background would inherit
          the card colour, and low-contrast quiet zones are a classic cause
          of "it won't scan". */}
      <rect width={matrix.extent} height={matrix.extent} className={QR_QUIET_ZONE_CLASS} />
      <path d={matrix.path} className={QR_MODULE_CLASS} />
    </svg>
  );
}
