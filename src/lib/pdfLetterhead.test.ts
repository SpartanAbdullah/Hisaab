import { describe, it, expect } from 'vitest';
import {
  PDF_COLORS,
  escapeHtml,
  letterheadHtml,
  pdfAmount,
  pdfDate,
  pdfFooterHtml,
  sanitizeFilename,
} from './pdfLetterhead';
import { DARK, HERO, LIGHT } from './designTokens';
import { contrastRatio } from './contrast';

describe('PDF_COLORS — the printed brand follows the app tokens', () => {
  it('letterhead band is the app hero navy (#0F1020 → #0A0A14)', () => {
    expect(PDF_COLORS.navy).toBe('#0F1020');
    expect(PDF_COLORS.navyDeep).toBe('#0A0A14');
    expect(PDF_COLORS.navy).toBe(HERO.top);
    expect(PDF_COLORS.navyDeep).toBe(HERO.bottom);
    expect(PDF_COLORS.onNavyMuted).toBe(HERO.secondaryInk);
  });

  it('accent is the brand violet (#7C5CFF → #5B47E8), never gold', () => {
    expect(PDF_COLORS.violet).toBe('#7C5CFF');
    expect(PDF_COLORS.violetDeep).toBe('#5B47E8');
    expect(PDF_COLORS.violet).toBe(LIGHT['accent-500']);
    expect(PDF_COLORS.violetDeep).toBe(LIGHT['accent-600']);
    expect(PDF_COLORS.onNavyViolet).toBe(DARK['accent-text']);
  });

  it('every text colour clears WCAG AA on the surface it sits on', () => {
    for (const band of [PDF_COLORS.navy, PDF_COLORS.navyDeep]) {
      expect(contrastRatio(PDF_COLORS.onNavy, band)).toBeGreaterThanOrEqual(7);
      expect(contrastRatio(PDF_COLORS.onNavyMuted, band)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(PDF_COLORS.onNavyViolet, band)).toBeGreaterThanOrEqual(4.5);
    }
    for (const paper of ['#FFFFFF', PDF_COLORS.footerTint]) {
      expect(contrastRatio(PDF_COLORS.muted, paper)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(PDF_COLORS.ink, paper)).toBeGreaterThanOrEqual(7);
    }
  });
});

describe('letterheadHtml', () => {
  const html = letterheadHtml('Statement of account', [
    { text: 'No. HIS-202607-AB12', tone: 'mono' },
    { text: 'As of 02 Jul 2026', tone: 'strong' },
    { text: '', tone: 'muted' }, // empty lines are dropped
  ]);

  it('draws the navy band, the violet mark and the violet rule', () => {
    expect(html).toContain('background:linear-gradient(180deg,#0F1020 0%,#0A0A14 100%)');
    expect(html).toContain('background:linear-gradient(135deg,#7C5CFF 0%,#5B47E8 100%)');
    expect(html).toContain('height:3px;background:linear-gradient(90deg,#7C5CFF 0%,#5B47E8 100%)');
    expect(html).toContain('color:#FFFFFF;letter-spacing:-0.01em;line-height:1;">Hisaab<');
    expect(html).toContain(`color:${PDF_COLORS.onNavyViolet};margin-top:6px;">Statement of account<`);
    expect(html).toContain(`color:#FFFFFF;">As of 02 Jul 2026<`);
    expect(html).toContain('monospace;">No. HIS-202607-AB12<');
    // The empty muted line was dropped: only the reference number wears the muted ink.
    expect(html.split(`color:${PDF_COLORS.onNavyMuted};`)).toHaveLength(2);
  });

  it('escapes its copy', () => {
    const h = letterheadHtml('A <b> & "c"', [{ text: '<i>' }]);
    expect(h).toContain('A &lt;b&gt; &amp; &quot;c&quot;');
    expect(h).toContain('&lt;i&gt;');
  });
});

describe('pdfFooterHtml / helpers', () => {
  it('pins the footer strip to the page bottom on the light tint', () => {
    const f = pdfFooterHtml('note', 'Page <1>');
    expect(f).toContain('margin-top:auto');
    expect(f).toContain(`background:${PDF_COLORS.footerTint}`);
    expect(f).toContain('Page &lt;1&gt;');
  });

  it('formats dates and amounts language-free', () => {
    expect(pdfDate('2026-07-02T14:30:00.000Z')).toBe('02 Jul 2026');
    expect(pdfDate('nope')).toBe('');
    expect(pdfAmount(-1234.5)).toBe('1,234.50');
    expect(escapeHtml('a&b')).toBe('a&amp;b');
    expect(sanitizeFilename('Maryam Corpuz / AED', 'contact')).toBe('Maryam_Corpuz_AED');
    expect(sanitizeFilename('***', 'contact')).toBe('contact');
  });
});
