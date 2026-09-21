// The shared frame of every generated Hisaab PDF — statement of account
// (statementPdf.ts), group settle-up plan (groupSettleUpPdf.ts) and kameti
// payout slip (kametiSlipPdf.ts) — so the three documents cannot drift apart:
// the print palette, the letterhead band, the footer strip, the offscreen page
// node and the date/amount formatting they share.
//
// Brand ("1d", docs/design-system.md): the letterhead IS the app's hero — a
// dark navy band (#0F1020 → #0A0A14) with white type — and carries the brand
// violet (#7C5CFF → #5B47E8) as a small mark beside the wordmark, a light-violet
// document title and a thin violet rule under the band. Gold is never the
// brand. The body stays light: these are printed / shared paper. Hex is allowed
// here (the design system's printing exemption for src/lib/*Pdf.ts);
// pdfLetterhead.test.ts pins these values to the app tokens in designTokens.ts.

export const PDF_COLORS = {
  // Letterhead band — the app hero (designTokens HERO.top / HERO.bottom).
  navy: '#0F1020',
  navyDeep: '#0A0A14',
  // Brand violet (designTokens accent-500 → accent-600).
  violet: '#7C5CFF',
  violetDeep: '#5B47E8',
  // Type on the band: white, the hero's secondary ink, and the dark theme's
  // readable violet (accent-text) for the document title. All ≥ 8:1 on navy.
  onNavy: '#FFFFFF',
  onNavyMuted: '#B4B6C8',
  onNavyViolet: '#B7A4FF',
  // Paper. Cool neutrals so the frame reads as one with the navy + violet
  // letterhead (the old warm cream hairlines belonged to the retired palette).
  ink: '#1A1A24',
  muted: '#63637A', // ≈5.8:1 on white, ≈5.3:1 on the footer tint
  hairline: '#E6E5EF',
  rowline: '#F0EFF6',
  footerTint: '#F5F4FA',
} as const;

// A4 at 96dpi ≈ 794 × 1123 CSS px. Building at that size lets the raster map
// cleanly onto the page and lets the footer pin to the bottom edge so the page
// reads as framed and filled, not a screenshot with white space below.
export const PDF_PAGE_W = 794;
export const PDF_PAGE_H = 1123;

// Inline style of the offscreen page node every PDF is rasterised from. It
// carries min-height so the footer (margin-top:auto) pins to the page bottom.
export const PDF_NODE_STYLE = [
  `width:${PDF_PAGE_W}px`,
  `min-height:${PDF_PAGE_H}px`,
  'display:flex',
  'flex-direction:column',
  'box-sizing:border-box',
  'background:#ffffff',
  "font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,'Noto Sans','Noto Nastaliq Urdu',sans-serif",
  `color:${PDF_COLORS.ink}`,
  'font-variant-numeric:tabular-nums',
].join(';');

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Dates and amounts are deliberately language-free (English month
// abbreviations, en-US digit grouping) — the same figures in either language.
export function pdfDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

export function pdfDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

// Bare number, grouped, fixed 2dp — the currency is declared once per block,
// not per row (accounting convention), so ledger cells stay aligned.
export function pdfAmount(n: number): string {
  return Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function sanitizeFilename(name: string, fallback: string): string {
  return name.replace(/[^\w.-]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '') || fallback;
}

export interface LetterheadMeta {
  text: string;
  // strong = white (the key fact, e.g. the date) · muted = secondary ·
  // mono = reference numbers.
  tone?: 'strong' | 'muted' | 'mono';
}

// The navy band: violet mark + "Hisaab" wordmark + the document title on the
// left, the document's reference facts on the right, then the violet rule.
export function letterheadHtml(title: string, meta: ReadonlyArray<LetterheadMeta>): string {
  const C = PDF_COLORS;
  const metaHtml = meta
    .filter((m) => m.text)
    .map((m, i) => {
      const gap = i > 0 ? 'margin-top:2px;' : '';
      const style =
        m.tone === 'mono'
          ? `font-size:11px;color:${C.onNavyMuted};font-family:ui-monospace,SFMono-Regular,Menlo,monospace;`
          : m.tone === 'muted'
            ? `font-size:11px;color:${C.onNavyMuted};`
            : `font-size:12px;color:${C.onNavy};`;
      return `<div style="${gap}${style}">${escapeHtml(m.text)}</div>`;
    })
    .join('');
  return `
    <div style="background:linear-gradient(180deg,${C.navy} 0%,${C.navyDeep} 100%);padding:22px 44px 20px;display:flex;justify-content:space-between;align-items:flex-start;gap:24px;">
      <div>
        <div style="display:flex;align-items:center;gap:9px;">
          <span style="display:inline-block;width:11px;height:11px;border-radius:3px;background:linear-gradient(135deg,${C.violet} 0%,${C.violetDeep} 100%);"></span>
          <span style="font-size:20px;font-weight:700;color:${C.onNavy};letter-spacing:-0.01em;line-height:1;">Hisaab</span>
        </div>
        <div style="font-size:12px;font-weight:500;color:${C.onNavyViolet};margin-top:6px;">${escapeHtml(title)}</div>
      </div>
      <div style="text-align:right;line-height:1.5;">${metaHtml}</div>
    </div>
    <div style="height:3px;background:linear-gradient(90deg,${C.violet} 0%,${C.violetDeep} 100%);"></div>`;
}

// The footer strip, pinned to the page bottom. `noteHtml` is trusted markup
// (callers escape their own copy); `pageLabel` is escaped here.
export function pdfFooterHtml(noteHtml: string, pageLabel: string): string {
  const C = PDF_COLORS;
  return `
    <div style="margin-top:auto;padding:14px 44px;background:${C.footerTint};border-top:1px solid ${C.hairline};display:flex;justify-content:space-between;align-items:flex-end;gap:16px;">
      <p style="margin:0;font-size:10px;color:${C.muted};line-height:1.6;">${noteHtml}</p>
      <p style="margin:0;font-size:10px;color:${C.muted};white-space:nowrap;">${escapeHtml(pageLabel)}</p>
    </div>`;
}
