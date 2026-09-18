import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CelebrationMark } from './CelebrationMark';
import { CONFETTI_COLORS, confettiBits } from '../lib/motion';

// The checkmark's draw-on is a CONTRACT ACROSS TWO FILES: index.css hard-codes
// stroke-dasharray/dashoffset: 100, and this component has to normalise the
// path to that same length with pathLength="100".
//
// Break either side and nothing throws — the tick just draws wrong, and only
// in a 0.42s window that is easy to miss. During development the dash array
// was 32 against a real path length of 23.35, which drew the tick fully at 73%
// and then idled through dead time. These tests pin the coupling.
describe('CelebrationMark', () => {
  it('normalises the checkmark path to the length the CSS dash array assumes', () => {
    const html = renderToStaticMarkup(<CelebrationMark />);
    expect(html).toContain('pathLength="100"');
  });

  it('carries the three animation layers the celebration timeline drives', () => {
    const html = renderToStaticMarkup(<CelebrationMark />);
    expect(html).toContain('animate-celebrate-ring');
    expect(html).toContain('animate-celebrate-pop');
    expect(html).toContain('animate-celebrate-check');
  });

  it('renders the tick as one continuous path so it draws as a single gesture', () => {
    const html = renderToStaticMarkup(<CelebrationMark />);
    // Two <path> elements would draw as two disconnected strokes.
    expect(html.match(/<path/g)?.length).toBe(1);
  });

  it('keeps the decorative layers out of the accessibility tree', () => {
    const html = renderToStaticMarkup(<CelebrationMark />);
    // The mark is pure decoration; the surrounding copy carries the meaning.
    expect(html.match(/aria-hidden/g)?.length).toBeGreaterThanOrEqual(3);
  });

  it('honours the accent tone without falling back to the settled green', () => {
    // 1d: the disc is a tinted plate — the violet tint scope for a milestone,
    // the mint one for a settled debt — and the tick takes the matching glyph tone.
    const accent = renderToStaticMarkup(<CelebrationMark tone="accent" />);
    expect(accent).toContain('m-violet');
    expect(accent).toContain('var(--color-glyph-violet)');
    expect(accent).not.toContain('m-mint');
    expect(accent).not.toContain('var(--color-glyph-green)');

    const settled = renderToStaticMarkup(<CelebrationMark />);
    expect(settled).toContain('m-mint');
    expect(settled).toContain('var(--color-glyph-green)');
  });

  it('never clips its own overflow — the ring and the burst both leave the box', () => {
    const html = renderToStaticMarkup(<CelebrationMark />);
    expect(html).not.toContain('overflow-hidden');
  });
});

// The burst is a SECOND cross-file contract: index.css's .animate-confetti-bit
// reads --dx/--dy/--rot/--d off each bit and owns the rest state (opacity 0)
// plus the reduced-motion gate. The component's only job is to emit exactly
// those custom properties on exactly those elements.
describe('CelebrationMark confetti burst', () => {
  const bitTags = (html: string) => html.match(/<i\b[^>]*>/g) ?? [];

  it('renders 20 confetti bits carrying the animate-confetti-bit class by default', () => {
    const html = renderToStaticMarkup(<CelebrationMark />);
    expect(html.match(/animate-confetti-bit/g)?.length).toBe(20);
    const tags = bitTags(html);
    expect(tags).toHaveLength(20);
    for (const tag of tags) expect(tag).toContain('animate-confetti-bit');
  });

  it('hides every bit from assistive tech', () => {
    const html = renderToStaticMarkup(<CelebrationMark />);
    const tags = bitTags(html);
    expect(tags).toHaveLength(20);
    for (const tag of tags) expect(tag).toMatch(/aria-hidden="true"/);
  });

  it('renders no bits when burst={false} and leaves the other three layers intact', () => {
    const html = renderToStaticMarkup(<CelebrationMark burst={false} />);
    expect(html).not.toContain('animate-confetti-bit');
    expect(bitTags(html)).toHaveLength(0);
    expect(html).toContain('animate-celebrate-ring');
    expect(html).toContain('animate-celebrate-pop');
    expect(html).toContain('animate-celebrate-check');
    expect(html).toContain('pathLength="100"');
  });

  it('hands the CSS the custom properties it animates on, per bit, from the pure geometry', () => {
    const html = renderToStaticMarkup(<CelebrationMark />);
    const tags = bitTags(html);
    const bits = confettiBits();
    tags.forEach((tag, i) => {
      const bit = bits[i];
      expect(tag).toContain(`--dx:${bit.dx}px`);
      expect(tag).toContain(`--dy:${bit.dy}px`);
      expect(tag).toContain(`--rot:${bit.rot}deg`);
      expect(tag).toContain(`--d:${bit.delayMs}ms`);
      expect(tag).toContain(`background:rgb(${bit.color})`);
    });
  });

  it('starts every bit at the centre of the mark and never lets it intercept a tap', () => {
    const html = renderToStaticMarkup(<CelebrationMark />);
    for (const tag of bitTags(html)) {
      expect(tag).toContain('absolute');
      expect(tag).toContain('left-1/2');
      expect(tag).toContain('top-1/2');
      expect(tag).toContain('-m-1');
      expect(tag).toContain('pointer-events-none');
    }
  });

  it('shapes every third bit as a shard and the rest as round dots', () => {
    const html = renderToStaticMarkup(<CelebrationMark />);
    const tags = bitTags(html);
    tags.forEach((tag, i) => {
      if (i % 3 === 0) {
        expect(tag).toContain('w-[7px] h-[10px] rounded-[2px]');
        expect(tag).not.toContain('rounded-full');
      } else {
        expect(tag).toContain('w-2 h-2 rounded-full');
      }
    });
    expect(tags.filter((t) => t.includes('rounded-[2px]'))).toHaveLength(7);
  });

  it('uses every one of the six clay tints', () => {
    const html = renderToStaticMarkup(<CelebrationMark />);
    for (const color of CONFETTI_COLORS) {
      expect(html).toContain(`rgb(${color})`);
    }
  });
});
