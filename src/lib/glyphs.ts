// The "3c" glyph set — Hisaab's icon language (design handoff, 2026-09-18).
//
// Pure data: each glyph is a list of SVG elements on a 24x24 grid, drawn as
// STROKES (no fills), round caps + joins. <Glyph> renders them with
// stroke="currentColor", so colour comes from the tone class and flips with
// the theme. No containers, plates or circles behind a glyph — plates appear
// only in empty states (.m-plate).
//
// The first block is copied verbatim from the handoff prototype; the second
// was drawn for this app in the same geometry.
//
// Clay migration: the 3dicons webp renders are retired. CLAY_TO_GLYPH maps
// every old ClayIconName onto a glyph (and CLAY_DEFAULT_TONE onto its tone),
// so any <Icon3D name="..."> call site keeps rendering — as a glyph.

export type GlyphElement = readonly [
  'path' | 'circle' | 'rect' | 'ellipse',
  Readonly<Record<string, string>>,
];

export const GLYPHS = {
  // -- Verbatim from the handoff prototype (Hisaab Prototype.dc.html) --
  'search': [['circle', { cx: '11', cy: '11', r: '6.5' }], ['path', { d: 'M16 16l4 4' }]],
  'bell': [['path', { d: 'M18 8.5a6 6 0 0 0-12 0c0 6.5-2.5 7.5-2.5 7.5h17S18 15 18 8.5' }], ['path', { d: 'M13.7 19.5a2 2 0 0 1-3.4 0' }]],
  'savings': [['circle', { cx: '12', cy: '12', r: '8' }], ['circle', { cx: '12', cy: '12', r: '2.6' }]],
  'wallet': [['rect', { x: '4', y: '7', width: '16', height: '11', rx: '3.5' }], ['path', { d: 'M15 12.5h3.4' }]],
  'card': [['rect', { x: '3.5', y: '6.5', width: '17', height: '11', rx: '3.5' }], ['path', { d: 'M3.5 11h17' }]],
  'analytics': [['path', { d: 'M6.5 17.5V12' }], ['path', { d: 'M12 17.5V7' }], ['path', { d: 'M17.5 17.5v-3.6' }]],
  'activity': [['rect', { x: '6', y: '4.5', width: '12', height: '15', rx: '3' }], ['path', { d: 'M10 9.5h4M10 13.5h4' }]],
  'person': [['circle', { cx: '12', cy: '9.2', r: '3.4' }], ['path', { d: 'M6.4 18.6c1-3 3.2-4.2 5.6-4.2s4.6 1.2 5.6 4.2' }]],
  'coins': [['ellipse', { cx: '12', cy: '8.6', rx: '6.4', ry: '3' }], ['path', { d: 'M5.6 8.6v5c0 1.7 2.9 3 6.4 3s6.4-1.3 6.4-3v-5' }]],
  'trophy': [['path', { d: 'M6 18.5h12' }], ['path', { d: 'M7.6 6.2h8.8v2.6a4.4 4.4 0 0 1-8.8 0z' }], ['path', { d: 'M12 13.2v5.3' }]],
  'banknote': [['rect', { x: '2.5', y: '7', width: '19', height: '10.5', rx: '3' }], ['circle', { cx: '12', cy: '12.25', r: '2.4' }], ['path', { d: 'M6 12.25h.01M18 12.25h.01' }]],
  'copy': [['rect', { x: '9', y: '9', width: '11', height: '11', rx: '2.5' }], ['path', { d: 'M15 5.5H6.5A1.5 1.5 0 0 0 5 7v8.5' }]],
  'lock': [['rect', { x: '4.5', y: '10.5', width: '15', height: '9.5', rx: '3' }], ['path', { d: 'M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5' }]],
  'globe': [['circle', { cx: '12', cy: '12', r: '8' }], ['path', { d: 'M4 12h16' }], ['path', { d: 'M12 4c2.2 2.2 2.2 13.6 0 16' }]],
  'arrow-up': [['path', { d: 'M12 5.5v13' }], ['path', { d: 'M6.5 9.5 12 5.5l5.5 4' }]],
  'database': [['path', { d: 'M4.5 8.5c0-1.9 3.4-3.4 7.5-3.4s7.5 1.5 7.5 3.4-3.4 3.4-7.5 3.4-7.5-1.5-7.5-3.4z' }], ['path', { d: 'M4.5 8.5v7c0 1.9 3.4 3.4 7.5 3.4s7.5-1.5 7.5-3.4v-7' }]],
  'download': [['path', { d: 'M12 4.5v11' }], ['path', { d: 'M7.5 11.5 12 15.5l4.5-4' }], ['path', { d: 'M5 19h14' }]],
  'link': [['path', { d: 'M10 14 14 10' }], ['path', { d: 'M13.5 7.5 15 6a3.5 3.5 0 0 1 5 5l-1.5 1.5' }], ['path', { d: 'M10.5 16.5 9 18a3.5 3.5 0 0 1-5-5l1.5-1.5' }]],
  'qr': [['rect', { x: '4', y: '4', width: '6.5', height: '6.5', rx: '1.5' }], ['rect', { x: '13.5', y: '4', width: '6.5', height: '6.5', rx: '1.5' }], ['rect', { x: '4', y: '13.5', width: '6.5', height: '6.5', rx: '1.5' }], ['path', { d: 'M14 14h2M18 14h2M14 18h2M18 18h2' }]],
  'share': [['path', { d: 'M12 4.5v10' }], ['path', { d: 'M7.5 9 12 4.5 16.5 9' }], ['path', { d: 'M5 19h14' }]],
  'whatsapp': [['path', { d: 'M12 4.5a7.5 7.5 0 0 0-6.4 11.4L4.5 19.5l3.7-1.1A7.5 7.5 0 1 0 12 4.5z' }]],
  'shield': [['path', { d: 'M12 4 19 7v5c0 4.2-2.9 7-7 8.5C7.9 19 5 16.2 5 12V7z' }]],
  'check': [['path', { d: 'M5 12.5 10 17.5 19 7.5' }]],
  'document': [['path', { d: 'M5 5.5h10l4 4v9H5z' }], ['path', { d: 'M9 11h6M9 14.5h4' }]],
  'sliders': [['path', { d: 'M5 8h14M5 16h14' }], ['circle', { cx: '10', cy: '8', r: '2.2' }], ['circle', { cx: '15', cy: '16', r: '2.2' }]],
  'key': [['circle', { cx: '8.5', cy: '12', r: '3.8' }], ['path', { d: 'M12.3 12H20l-1.6 2.2' }]],
  'plus': [['path', { d: 'M12 5.5v13M5.5 12h13' }]],
  'mail': [['rect', { x: '3.5', y: '6', width: '17', height: '12', rx: '2.5' }], ['path', { d: 'm4 7 8 6 8-6' }]],
  'archive': [['rect', { x: '3.5', y: '4.5', width: '17', height: '4.5', rx: '1.5' }], ['path', { d: 'M5.5 9v8.5a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V9' }], ['path', { d: 'M10 13h4' }]],
  'groups': [['path', { d: 'M4 18v-1a4 4 0 0 1 4-4h2a4 4 0 0 1 4 4v1' }], ['circle', { cx: '9', cy: '8', r: '3' }], ['path', { d: 'M16 12a4 4 0 0 1 4 4v2' }], ['circle', { cx: '16.5', cy: '7.5', r: '2.5' }]],
  'sparkles': [['path', { d: 'M12 4l1.8 4.7L18.5 10l-4.7 1.8L12 16.5l-1.8-4.7L5.5 10l4.7-1.3z' }], ['path', { d: 'M18 16.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z' }]],
  'shield-check': [['path', { d: 'M12 4 19 7v5c0 4.2-2.9 7-7 8.5C7.9 19 5 16.2 5 12V7z' }], ['path', { d: 'm9.5 12 1.8 1.8L15 10' }]],
  'flame': [['path', { d: 'M12 3.5s5 4.2 5 8.5a5 5 0 0 1-10 0c0-1.7.8-3.3 1.8-4.6.4 1.4 1.3 2.3 2.2 2.6 0-2.4.5-4.6 1-6.5z' }]],
  'calendar': [['rect', { x: '3.5', y: '5.5', width: '17', height: '15', rx: '3' }], ['path', { d: 'M8 3.5v4M16 3.5v4M3.5 10.5h17' }]],
  'sparkle': [['path', { d: 'M12 4l1.8 4.7L18.5 10l-4.7 1.8L12 16.5l-1.8-4.7L5.5 10l4.7-1.3z' }]],
  'inbox': [['path', { d: 'M4 13h4l1.6 3h4.8l1.6-3h4' }], ['path', { d: 'M4 13 6.5 5.5h11L20 13v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z' }]],
  'user-plus': [['circle', { cx: '10', cy: '9', r: '3.4' }], ['path', { d: 'M4.5 19c.9-3 3-4.3 5.5-4.3s4.6 1.3 5.5 4.3' }], ['path', { d: 'M18 8v5M15.5 10.5h5' }]],
  'recurring': [['path', { d: 'M5 8.5 8 5.5l3 3' }], ['path', { d: 'M8 5.5v7a4 4 0 0 0 4 4h7' }], ['path', { d: 'M19 15.5 16 18.5l3 3' }]],

  // ── Drawn for Hisaab in the same geometry (24 grid, round caps/joins, no
  //    fills) for the controls the prototype renders as text ("←", "×", "›")
  //    and the domains it doesn't show. ──
  'arrow-left': [['path', { d: 'M19 12H5.5' }], ['path', { d: 'M11 6.5 5.5 12l5.5 5.5' }]],
  'arrow-right': [['path', { d: 'M5 12h13.5' }], ['path', { d: 'M13 6.5l5.5 5.5-5.5 5.5' }]],
  'arrow-down': [['path', { d: 'M12 5.5v13' }], ['path', { d: 'M6.5 14.5 12 18.5l5.5-4' }]],
  'chevron-right': [['path', { d: 'm9.5 6 6 6-6 6' }]],
  'chevron-left': [['path', { d: 'm14.5 6-6 6 6 6' }]],
  'chevron-down': [['path', { d: 'm6 9.5 6 6 6-6' }]],
  'chevron-up': [['path', { d: 'm6 14.5 6-6 6 6' }]],
  'close': [['path', { d: 'M6.5 6.5l11 11M17.5 6.5l-11 11' }]],
  'minus': [['path', { d: 'M5.5 12h13' }]],
  'home': [['path', { d: 'M4.5 10.8 12 4.5l7.5 6.3' }], ['path', { d: 'M6.5 9.3V17a2.5 2.5 0 0 0 2.5 2.5h6a2.5 2.5 0 0 0 2.5-2.5V9.3' }]],
  'swap': [['path', { d: 'M6 8.5h12' }], ['path', { d: 'm15 5.5 3 3-3 3' }], ['path', { d: 'M18 15.5H6' }], ['path', { d: 'm9 12.5-3 3 3 3' }]],
  'trash': [['path', { d: 'M5 7.5h14' }], ['path', { d: 'M9.5 7.5V6a1.5 1.5 0 0 1 1.5-1.5h2A1.5 1.5 0 0 1 14.5 6v1.5' }], ['path', { d: 'M7 7.5l.7 10.3a2 2 0 0 0 2 1.7h4.6a2 2 0 0 0 2-1.7L17 7.5' }]],
  'edit': [['path', { d: 'M5 19l.9-3.9L15.6 5.4a2.1 2.1 0 0 1 3 3L8.9 18.1z' }], ['path', { d: 'M13.5 7.5l3 3' }]],
  'more': [['path', { d: 'M6.5 12h.01M12 12h.01M17.5 12h.01' }]],
  'clock': [['circle', { cx: '12', cy: '12', r: '8' }], ['path', { d: 'M12 8v4.3l2.8 1.7' }]],
  'chat': [['path', { d: 'M5 6.5A2.5 2.5 0 0 1 7.5 4h9A2.5 2.5 0 0 1 19 6.5v7a2.5 2.5 0 0 1-2.5 2.5H11l-4.5 3.5V16A2.5 2.5 0 0 1 5 13.5z' }]],
  'phone': [['rect', { x: '7', y: '3.5', width: '10', height: '17', rx: '3' }], ['path', { d: 'M11 17h2' }]],
  'calculator': [['rect', { x: '5.5', y: '3.5', width: '13', height: '17', rx: '3' }], ['path', { d: 'M9 8h6' }], ['path', { d: 'M9 12.5h.01M12 12.5h.01M15 12.5h.01M9 16h.01M12 16h.01M15 16h.01' }]],
  'eye': [['path', { d: 'M3.5 12s3-6 8.5-6 8.5 6 8.5 6-3 6-8.5 6-8.5-6-8.5-6z' }], ['circle', { cx: '12', cy: '12', r: '2.6' }]],
  'eye-off': [['path', { d: 'M4.5 4.5l15 15' }], ['path', { d: 'M9.9 6.3A8.4 8.4 0 0 1 12 6c5.5 0 8.5 6 8.5 6a14.5 14.5 0 0 1-2.3 3.1M14.1 17.7A8.4 8.4 0 0 1 12 18c-5.5 0-8.5-6-8.5-6a14.5 14.5 0 0 1 2.3-3.1' }]],
  'info': [['circle', { cx: '12', cy: '12', r: '8' }], ['path', { d: 'M12 11v5' }], ['path', { d: 'M12 8h.01' }]],
  'alert': [['path', { d: 'M12 4.5 20 18.5H4z' }], ['path', { d: 'M12 10v4' }], ['path', { d: 'M12 16.5h.01' }]],
  'receipt': [['path', { d: 'M6 4.5h12v15l-2-1.3-2 1.3-2-1.3-2 1.3-2-1.3-2 1.3z' }], ['path', { d: 'M9.5 9h5M9.5 12.5h5' }]],
  'logout': [['path', { d: 'M14 5.5H7.5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2H14' }], ['path', { d: 'M11 12h9' }], ['path', { d: 'm17 9 3 3-3 3' }]],
  'refresh': [['path', { d: 'M19 12a7 7 0 1 1-2.1-5' }], ['path', { d: 'M19 5v4h-4' }]],
  'undo': [['path', { d: 'M9 5.5 5 9.5l4 4' }], ['path', { d: 'M5 9.5h9a5 5 0 0 1 0 10h-2.5' }]],
  'gift': [['rect', { x: '4.5', y: '10', width: '15', height: '9.5', rx: '2.5' }], ['path', { d: 'M3.5 7.5h17V10h-17z' }], ['path', { d: 'M12 7.5v12' }], ['path', { d: 'M12 7.5C10.5 4 7 4 7 6.3c0 1.2 2.4 1.2 5 1.2zM12 7.5C13.5 4 17 4 17 6.3c0 1.2-2.4 1.2-5 1.2z' }]],
  'bank': [['path', { d: 'M4 9.5 12 5l8 4.5' }], ['path', { d: 'M6 10.5v6M10 10.5v6M14 10.5v6M18 10.5v6' }], ['path', { d: 'M4.5 19h15' }]],
  'moon': [['path', { d: 'M19 14.5A7.5 7.5 0 1 1 9.5 5a6 6 0 0 0 9.5 9.5z' }]],
  'sun': [['circle', { cx: '12', cy: '12', r: '3.6' }], ['path', { d: 'M12 3.5v1.8M12 18.7v1.8M3.5 12h1.8M18.7 12h1.8M6 6l1.3 1.3M16.7 16.7 18 18M6 18l1.3-1.3M16.7 7.3 18 6' }]],
  'send': [['path', { d: 'M4.5 11.5 19.5 4.5l-5 15-3-6.5z' }], ['path', { d: 'M11.5 13 19.5 4.5' }]],
  'trend': [['path', { d: 'M4.5 17.5 9.5 12l3.5 3 6.5-7.5' }], ['path', { d: 'M15 7.5h4.5V12' }]],
  'store': [['path', { d: 'M5 9.5 6.5 5h11L19 9.5' }], ['path', { d: 'M5 9.5h14v1a2.3 2.3 0 0 1-4.6 0 2.3 2.3 0 0 1-4.8 0 2.3 2.3 0 0 1-4.6 0z' }], ['path', { d: 'M6.5 13.5V19h11v-5.5' }]],
  'split': [['path', { d: 'M12 19.5V13' }], ['path', { d: 'M12 13 6.5 7.5M12 13l5.5-5.5' }], ['path', { d: 'M5.5 11V6.5H10M18.5 11V6.5H14' }]],
  'tag': [['path', { d: 'M4.5 12.3V5.5a1 1 0 0 1 1-1h6.8l7.2 7.2a1.5 1.5 0 0 1 0 2.1l-5.2 5.2a1.5 1.5 0 0 1-2.1 0z' }], ['path', { d: 'M8.5 8.5h.01' }]],
  'crown': [['path', { d: 'M5 17.5 4 8l4.5 3.5L12 5.5l3.5 6L20 8l-1 9.5z' }], ['path', { d: 'M5.5 20.5h13' }]],
  'flag': [['path', { d: 'M6 20.5V4.5' }], ['path', { d: 'M6 5h10.5l-2 4 2 4H6' }]],
  'ban': [['circle', { cx: '12', cy: '12', r: '8' }], ['path', { d: 'M6.5 6.5l11 11' }]],
  'shield-off': [['path', { d: 'M12 4 19 7v5c0 1.3-.3 2.5-.8 3.5M16 18.4a10.5 10.5 0 0 1-4 2.1C7.9 19 5 16.2 5 12V7l2-.9' }], ['path', { d: 'M4.5 4.5l15 15' }]],
  'archive-restore': [['rect', { x: '3.5', y: '4.5', width: '17', height: '4.5', rx: '1.5' }], ['path', { d: 'M5.5 9v8.5a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V9' }], ['path', { d: 'M12 17v-5M9.5 14.5 12 12l2.5 2.5' }]],
  'bell-off': [['path', { d: 'M18 8.5a6 6 0 0 0-9.7-4.7M6 8.5c0 6.5-2.5 7.5-2.5 7.5h13.5' }], ['path', { d: 'M13.7 19.5a2 2 0 0 1-3.4 0' }], ['path', { d: 'M4.5 4.5l15 15' }]],
  'unlock': [['rect', { x: '4.5', y: '10.5', width: '15', height: '9.5', rx: '3' }], ['path', { d: 'M8.5 10.5V8a3.5 3.5 0 0 1 6.8-1.2' }]],
  'external-link': [['path', { d: 'M13.5 5.5h5v5' }], ['path', { d: 'M18.5 5.5 11 13' }], ['path', { d: 'M17 13.5v4a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h4' }]],
  'backspace': [['path', { d: 'M9 5.5h9.5a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H9l-5.5-6.5z' }], ['path', { d: 'M12 9.5l5 5M17 9.5l-5 5' }]],
  'lightbulb': [['path', { d: 'M12 3.5a5.5 5.5 0 0 0-3.2 10c.7.5 1.2 1.3 1.2 2.2v.3h4v-.3c0-.9.5-1.7 1.2-2.2A5.5 5.5 0 0 0 12 3.5z' }], ['path', { d: 'M10 19.5h4' }]],
  'cloud-off': [['path', { d: 'M7 18.5h9.5M19.3 16.3A4 4 0 0 0 16.5 9.6a6 6 0 0 0-8.8-3.3M5.6 9.2A4.5 4.5 0 0 0 7 18.5' }], ['path', { d: 'M4.5 4.5l15 15' }]],
  'play': [['path', { d: 'M8 5.5v13l10.5-6.5z' }]],
  'keyboard': [['rect', { x: '3', y: '6.5', width: '18', height: '11', rx: '3' }], ['path', { d: 'M7 10.5h.01M10.5 10.5h.01M14 10.5h.01M17.5 10.5h.01M8 14h8' }]],
  'ghost': [['path', { d: 'M6 19.5V11a6 6 0 0 1 12 0v8.5l-2-1.5-2 1.5-2-1.5-2 1.5-2-1.5z' }], ['path', { d: 'M10 11h.01M14 11h.01' }]],
  'dice': [['rect', { x: '4.5', y: '4.5', width: '15', height: '15', rx: '3.5' }], ['path', { d: 'M9 9h.01M12 12h.01M15 15h.01' }]],
  'user-minus': [['circle', { cx: '10', cy: '9', r: '3.4' }], ['path', { d: 'M4.5 19c.9-3 3-4.3 5.5-4.3s4.6 1.3 5.5 4.3' }], ['path', { d: 'M15.5 10.5h5' }]],
} as const satisfies Record<string, readonly GlyphElement[]>;

export type GlyphName = keyof typeof GLYPHS;

/** Semantic stroke tones. Each is a `--color-glyph-*` token (≥3:1 on every
 *  surface, both themes — designTokens.test.ts). `current` inherits. */
export type GlyphTone = 'gold' | 'green' | 'coral' | 'violet' | 'blue' | 'pink' | 'neutral' | 'current';

export const GLYPH_TONE_CLASS: Record<GlyphTone, string> = {
  gold: 'text-glyph-gold',
  green: 'text-glyph-green',
  coral: 'text-glyph-coral',
  violet: 'text-glyph-violet',
  blue: 'text-glyph-blue',
  pink: 'text-glyph-pink',
  neutral: 'text-glyph-neutral',
  current: '',
};

/** Stroke width by rendered size, per the handoff: 3 on 24px+ tiles, 2.6 at
 *  inline 17–23px, 2.4 on small 12–16px glyphs (header search/bell). */
export function glyphStrokeWidth(sizePx: number): number {
  if (sizePx >= 24) return 3;
  if (sizePx >= 17) return 2.6;
  return 2.4;
}

export function isGlyphName(name: string | undefined | null): name is GlyphName {
  return !!name && Object.prototype.hasOwnProperty.call(GLYPHS, name);
}

/** Domain → accent. Kameti gold, Group Splits blue, contacts/khata pink,
 *  savings/receive green, spending/pay coral, the brand primary and
 *  AI/investments/analytics violet. */
export const DOMAIN_TONE = {
  kameti: 'gold',
  splits: 'blue',
  khata: 'pink',
  contacts: 'pink',
  savings: 'green',
  receive: 'green',
  spending: 'coral',
  pay: 'coral',
  primary: 'violet',
  ai: 'violet',
  investments: 'violet',
  analytics: 'violet',
  plain: 'neutral',
} as const satisfies Record<string, GlyphTone>;

/** Every retired 3dicons name → the glyph that now stands in for it. */
export const CLAY_TO_GLYPH = {
  alarm: 'clock',
  bag: 'wallet',
  bell: 'bell',
  calculator: 'calculator',
  calendar: 'calendar',
  card: 'card',
  chart: 'analytics',
  chat: 'chat',
  coins: 'coins',
  cup: 'trophy',
  gift: 'gift',
  handshake: 'check',
  key: 'key',
  link: 'link',
  lock: 'lock',
  money: 'banknote',
  person: 'person',
  person2: 'groups',
  phone: 'phone',
  piggybank: 'savings',
  plus: 'plus',
  pot: 'coins',
  receipt: 'activity',
  shield: 'shield',
  sparkle: 'sparkle',
  target: 'savings',
  tick: 'check',
  trophy: 'trophy',
  wallet: 'wallet',
} as const satisfies Record<string, GlyphName>;

export type ClayIconAlias = keyof typeof CLAY_TO_GLYPH;

/** The tone a retired clay icon renders in when the call site gives none. */
export const CLAY_DEFAULT_TONE: Record<ClayIconAlias, GlyphTone> = {
  alarm: 'coral',
  bag: 'gold',
  bell: 'violet',
  calculator: 'gold',
  calendar: 'blue',
  card: 'blue',
  chart: 'violet',
  chat: 'blue',
  coins: 'gold',
  cup: 'green',
  gift: 'pink',
  handshake: 'green',
  key: 'neutral',
  link: 'violet',
  lock: 'blue',
  money: 'gold',
  person: 'pink',
  person2: 'blue',
  phone: 'neutral',
  piggybank: 'green',
  plus: 'violet',
  pot: 'gold',
  receipt: 'neutral',
  shield: 'green',
  sparkle: 'violet',
  target: 'green',
  tick: 'green',
  trophy: 'green',
  wallet: 'gold',
};

/** Old ClayTint (the Tile3D / Card3D `tint` prop) → glyph tone. */
export const TINT_TO_TONE = {
  gold: 'gold',
  sky: 'blue',
  blush: 'pink',
  mint: 'green',
  coral: 'coral',
  accent: 'violet',
  neutral: 'neutral',
} as const satisfies Record<string, GlyphTone>;

/** Resolve a name that may be a glyph name OR a retired clay icon name. */
export function resolveGlyph(
  name: string | undefined | null,
): { glyph: GlyphName; tone: GlyphTone } | null {
  if (!name) return null;
  if (isGlyphName(name)) return { glyph: name, tone: 'current' };
  if (Object.prototype.hasOwnProperty.call(CLAY_TO_GLYPH, name)) {
    const alias = name as ClayIconAlias;
    return { glyph: CLAY_TO_GLYPH[alias], tone: CLAY_DEFAULT_TONE[alias] };
  }
  return null;
}
