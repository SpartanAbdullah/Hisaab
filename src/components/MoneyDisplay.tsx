import { currencyMinorUnits, roundMoney } from '../lib/currencies';

interface MoneyDisplayProps {
  amount: number;
  currency?: string;
  // Font size in px for the integer portion. Currency and cents scale
  // off this — 45% and 42% respectively — per Sukoon's spec.
  size?: number;
  tone?: 'on-navy' | 'on-cream';
  // Show explicit + sign for positive amounts.
  signed?: boolean;
  // Override the muted (currency + cents) color. Useful when the hero
  // background isn't navy/cream — e.g. an accent-tinted card.
  mutedColor?: string;
  // Override the primary (integer) color.
  color?: string;
  // 1d hero numeral (.m-num-gold / -violet / -blue in index.css): solid, crisp
  // ink — the layered extrusion shadows were retired as blurry (2026-09-19) —
  // with the currency code set at the figure's own size, so "AED 42,860"
  // reads as one object. The variant names are kept for call sites.
  extrude?: 'gold' | 'violet' | 'blue';
}

// Sukoon's 3-part baseline-aligned money composition:
//   <currency code>  <integer>  .<cents>
//        45%           100%       42%
// All `tabular-nums`. Currency and cents sit on the same baseline as
// the integer so the number reads as one unit, not three. Letter
// spacing is tightened at display sizes per Sukoon's typography spec.
export function MoneyDisplay({
  amount,
  currency = 'AED',
  size = 36,
  tone = 'on-cream',
  signed = false,
  mutedColor,
  color,
  extrude,
}: MoneyDisplayProps) {
  // Decimal places follow ISO 4217 minor units — a JPY hero shows no cents at
  // all, a KWD hero shows three fils. Rounding happens BEFORE the split so a
  // value like 999.999 renders "1,000" + ".00", never "999" + ".00".
  const digits = currencyMinorUnits(currency);
  const abs = roundMoney(Math.abs(amount), currency);
  const intPart = Math.floor(abs).toLocaleString('en-US');
  const cents = digits > 0 ? (abs - Math.floor(abs)).toFixed(digits).slice(2) : '';
  const isNegative = amount < 0;
  const sign = isNegative ? '−' : signed && amount > 0 ? '+' : '';

  const primary = color ?? (extrude ? undefined : tone === 'on-navy' ? '#ffffff' : 'var(--color-ink-900)');
  const muted   = mutedColor ?? (tone === 'on-navy' ? 'rgba(255,255,255,0.5)' : 'var(--color-ink-500)');

  // Overflow guard for big PKR amounts. Count actual digits (commas excluded)
  // and step the integer one notch (×0.82) down when it runs long (>9 digits,
  // i.e. ≥1,000,000,000) so the number doesn't clip the navy hero. Currency
  // and cents scale off this effective size so the 3-part baseline stays.
  const digitCount = intPart.replace(/,/g, '').length;
  const effectiveSize = digitCount > 9 ? size * 0.82 : size;

  if (extrude) {
    const numClass = `m-num m-num-${extrude}`;
    return (
      <span
        className={`inline-flex items-baseline ${numClass}`}
        style={{ fontSize: effectiveSize, color: primary, maxWidth: '100%', gap: effectiveSize * 0.22 }}
      >
        <span>{currency}</span>
        <span>
          {sign}{intPart}
          {cents !== '' && (
            <span style={{ fontSize: effectiveSize * 0.42, letterSpacing: '-0.01em' }}>.{cents}</span>
          )}
        </span>
      </span>
    );
  }

  return (
    <span
      className="inline-flex items-baseline"
      style={{
        gap: Math.max(4, effectiveSize * 0.12),
        letterSpacing: '-0.025em',
        fontVariantNumeric: 'tabular-nums',
        maxWidth: '100%',
      }}
    >
      <span style={{ fontSize: effectiveSize * 0.45, fontWeight: 500, color: muted }}>{currency}</span>
      <span style={{ fontSize: effectiveSize, fontWeight: 600, color: primary }}>
        {sign}{intPart}
      </span>
      {cents !== '' && (
        <span style={{ fontSize: effectiveSize * 0.42, fontWeight: 500, color: muted }}>.{cents}</span>
      )}
    </span>
  );
}
