# Hisaab design system — "1d" material + "3c" glyphs

The one source of truth for how Hisaab looks. Since 2026-09-18 the app wears
the **1d / 3c** direction from the Claude Design handoff (`Hisaab app
redesign.zip`, founder-approved): a dark, tactile, extruded material and a
custom stroked glyph icon set. It replaced the pastel 3D-clay look (2026-09-03)
and the 3dicons webp renders, which the client found toy-like.

**Brand colour: violet** (`#7C5CFF` → `#5B47E8`, the colour Hisaab's buttons
always had). The handoff drew the primary in gold; at the second review
(2026-09-19) the founder kept the material but put the brand colour back, so
primary buttons, the + button, selection, focus, links and the default hero
glow are violet. **Gold means Kameti or a warning** (plus a few domain
identities: savings accounts, cash advance, budget), never the brand. The same review
made the walls lighter (one thin 2px wall, no sheet seam line) and set
numerals and glyphs crisp (no offset shadows).

Everything below is enforced by code, not by this page:

| Rule | Where it lives | What guards it |
|---|---|---|
| Token values (both themes) | `src/index.css` `@theme` + `html.dark` | `src/lib/designTokens.test.ts` parses the CSS against `src/lib/designTokens.ts` |
| Contrast (AA text, 3:1 non-text) | `src/lib/designTokens.ts` | ~370 checks in `designTokens.test.ts`: every real pairing in both themes, plus the fixed button/badge faces and the `.auth-ink-dark` copy read back from the CSS |
| Material classes | `src/index.css` "1D MATERIAL" block | `src/lib/material.test.ts` (tint/hero classes exist) |
| Glyphs | `src/lib/glyphs.ts` | `src/lib/glyphs.test.ts` (grid, no fills, every retired clay name mapped) |
| No hardcoded English | `src/lib/i18n.ts` | `npm run lint` |

---

## 1. Themes

- **Dark is the default** for a device with no stored choice
  (`DEFAULT_THEME` in `src/stores/themeStore.ts`, mirrored by
  `public/theme-boot.js`, which sets `html.dark` before first paint — an
  external blocking script because the CSP's `script-src 'self'` refuses
  inline ones). An explicit Light / Dark / System choice is stored in
  `hisaab_theme` and always wins.
- **Light is "ivory"**: the same material and accents on a warm ivory sheet,
  with accent colours darkened wherever they are text or a control edge.
- **The hero band is dark in both themes.** The big white figures need a
  dark ground, and the app already worked this way (navy hero over a light
  body). `.m-hero` / `.bg-navy-bloom` apply the WHOLE dark token set (and the
  dark material variables) to everything inside, so hero content — chips,
  pills, ink, menus — reads identically in either theme.
- Native chrome (status bar, splash, PWA theme-color) is the hero base
  `#0A0A14` with light icons — correct in both themes because every screen
  opens on the hero.
- Tailwind's `dark:` variant follows the class (`@custom-variant dark`), but
  you rarely need it: tokens flip by value.

## 2. Colour roles

All colours are tokens (`bg-*`, `text-*`, `border-*`, `ring-*`, `from-*`…).
**No hex and no Tailwind default palette in JSX** (printed PDFs/share images
in `src/lib/*Pdf.ts` / `wrapCard.ts` are the exception — paper stays light).

| Family | Role | Notes |
|---|---|---|
| `accent-*` | **Violet — the brand and the primary action** | `accent-600` is the label-bearing fill (white label: 6.0:1 light, 4.7:1 dark). `accent-500` is the bright violet for rings, focus, selected edges, dots and progress — in light it never carries a label (white on it is 4.35:1; a test fails if a page pairs `bg-accent-500` with `text-white`). `accent-text` is the readable violet; `text-accent-600/500` auto-paint it. |
| `iris-*` | Violet section accent — Hisaab AI, Investments, Analytics, Inbox, "Linked" | Same family as `accent`, kept separate so a section tint can move without moving the brand. |
| `cobalt-*` | Blue — Group Splits | |
| `blush-*` | Pink — Contacts | |
| `receive-*` / `pay-*` | Money in (green) / money out (coral — never red) | Use `*-text` for amounts. |
| `warn-*` / `info-*` | Functional | |
| `cream-*` | Surfaces: `cream-bg` sheet, `cream-card` card face (gets the lit gradient automatically), `cream-soft`, `cream-border`, `cream-hairline` | Historical name; the light theme is ivory. |
| `ink-*` | Text ramp: 900 figures/titles · 800 body · 600 secondary · 400 muted floor | 400 still clears 4.5:1 on every surface incl. the keypad face. |
| `gold-*` | Fixed gold material (both themes): 300/500/700/900 + `gold-ink` | Kameti, warnings and a few domain identities (savings accounts, cash advance, budget) — never the brand. Gold/amber TEXT is `text-warn-700` (readable in both themes); text on a gold face is always `gold-ink`. |
| `navy-*` | Hero base | |
| `glyph-*` | Icon strokes per semantic tone | ≥3:1 on sheet/card/control in both themes. |
| `field-border`, `control-off/on`, `whatsapp` | Control boundaries (WCAG 1.4.11) | |

Section accents (the hero glow): violet — the `<NavyHero>` default — on Home,
Loans, Settings, Analytics, Investments, Inbox and every screen that doesn't
name one; `ai` (stronger violet) on Hisaab AI; gold on Kameti and its witness
page; blue on Groups; pink on Contacts; green on Goals.

## 3. The material

Every raised element is the same four-part recipe — that is what makes depth
read as real rather than as a drop shadow:

1. a vertical gradient face (lighter top → darker bottom),
2. an inset top highlight — the lit edge,
3. **one thin (2px) hard, zero-blur offset wall** in a darker shade of the
   element's own colour — the extruded side. Pressables only (tile, key,
   control, button, pill, FAB); cards, fields, selectors and plates carry no
   wall,
4. a soft ambient shadow underneath.

Pressing collapses the wall: the element travels down 2px and the wall drops
to 0 (120ms, transform + box-shadow only; reduced-motion keeps the state
change, drops the transition). The founder ruled on 2026-09-18 that the hard
wall IS the design (superseding the 2026-09-03 "no lips" rule), then on
2026-09-19 that the handoff's stacked two-step walls and the highlight line on
the sheet seam read heavy — hence one thin wall and a seamless sheet.

### Classes (`src/index.css`, "1D MATERIAL")

| Class | Use |
|---|---|
| `m-card` (+ `m-card-feature`) | Informational surface, 18px (22px feature), no wall. A tint scope tints the face (tinted stat card). `m-ring-violet` / `-gold` / `-green` add an attention ring that keeps the lit edge. |
| `m-tile` (+ `m-tile-selected`, `m-tile-top`) | Pressable tile, 15px, one thin wall. Tint scopes tint face + wall. Top-placement tiles are size containers whose `m-tile-label` fits itself to the tile (10.5px, down to 8.5px) instead of being abbreviated. |
| `m-key` | Keypad / big pressable, one thin wall. `m-key m-coral` = tinted key (keypad delete). |
| `m-ctl` | 36px raised control: header buttons, row icon squares. |
| `m-inset` | Sunken well: recessed areas, the donut centre. |
| `m-field` | Labelled field card (caption + bare input). |
| `m-btn` + `m-btn-primary` / `-violet` / `-green` / `-coral` / `-whatsapp` / `-plain` / `-danger` | Buttons. `m-btn-primary` is the violet face with a white label; `m-btn-violet`, `.btn-gradient` and `.cta-primary` share it. `m-btn-whatsapp` is the WhatsApp-green solid (share / remind). `<Button variant>` maps onto these (`primary` / `gradient` / `hero` violet, `secondary` plain, `danger` solid coral, `warning` gold-tinted key). |
| `m-fab` | The nav's + button: brand violet deepening into navy, one thin wall, violet glow. |
| `m-hero` + `m-hero-{violet,gold,blue,pink,green,ai}` | Hero band (`<NavyHero accent>`, default `violet`). |
| `m-sheet` / `sukoon-body` | The sheet that slides 16px under the hero, 24px top radius. |
| `m-num` | Big figures: 600, tight tracking, tabular, solid ink. `m-num-gold` / `-violet` / `-blue` (and `MoneyDisplay extrude`) are kept as names but render the same crisp ink — the offset-shadow extrusion was retired as blurry (2026-09-19). |
| `m-label` | Section micro-label (10.5px caps). |
| `m-pill` (+ `m-pill-receive` / `-pay` / `-gold` / `-violet` / `-blue`) | Pills; active = `is-active` / `aria-pressed` / `aria-selected`. `-gold` is kameti-only. |
| `m-seg` | Segmented track (Inbox tabs, EN/UR, theme). |
| `m-chip` + `m-chip-{receive,pay,gold,violet,blue,pink,neutral}` (+ `m-chip-caps`) | Status chips. `m-chip-gold` is the amber attention chip (due / ageing / kameti). |
| `m-badge` + `m-badge-brand` / `m-badge-coral` | Count badges: violet on tiles, coral on the bell. |
| `m-stat-dot` + `-receive` / `-pay` | 26px gradient key square on stat cards (carries a direction glyph). |
| `m-switch` | 48×28 toggle; `role="switch"` + `aria-checked`. |
| `m-avatar` / `m-avatar-self` | Person / current-user avatar (`<UserAvatar self>`, violet). |
| `m-skel` | Loading block (1.6s pulse, `--m-skel-delay` stagger). |
| `m-plate` | 56px empty-state plate (+ tint scope). |
| `m-glyph-extrude` | Retired (a no-op name): glyphs render crisp, with no drop under the stroke. |
| `glow-attention` (+ `glow-violet`) | A pulsing halo on `::after` — never touches the element's own walls. |
| Tint scopes `m-neutral m-gold m-mint m-coral m-violet m-blue m-pink` | Set the face / wall / strong colour for the element they sit on. `m-violet` is the brand tint (e.g. the header "+ New"); `m-gold` means kameti or a warning. |

The long-standing component classes (`.input-field`, `.selector-base` /
`.selector-selected`, `.form-label`, `.modal-*`, `.sheet-*`,
`.nav-icon-button`, `.cta-*`) are re-expressed in the material, so every
modal and form inherits it. The 3D-clay classes (`clay-tile`, `clay-card`,
`clay-depth*`, …), `src/lib/clay.ts`, the 3dicons webp set in `public/3d/`
and its `build:3d` script were removed once the last call site migrated.

### Gotchas

- `bg-white` is white in dark too — card surfaces are `bg-cream-card` or `m-card`.
- `text-ink-900` is white in dark; `bg-white text-ink-900` is auto-flipped to navy ink.
- Every `<input>` is pinned to 16px by an unlayered rule (iOS focus-zoom
  guard) that beats font-size utilities. A bigger input (the Quick Entry
  amount) sets `style={{ fontSize }}` inline.
- The wall sits 2px below a pressable; stacked pressables need `gap-2.5`+ so
  a wall doesn't touch the next face.
- A violet fill that carries text is `bg-accent-600` or `m-btn-primary`,
  never light `bg-accent-500` (guarded by test).
- `.auth-ink-dark` (auth, onboarding, PIN, update screens) re-declares part of
  the dark token set after `.bg-navy-bloom`, so it wins there. It must mirror
  the dark block; `designTokens.test.ts` fails if it drifts (it once kept the
  retired gold accent).

## 4. Glyphs (the "3c" icon set)

`<Glyph name tone size extrude? label? />` (`src/components/Glyph.tsx`, data in
`src/lib/glyphs.ts`): inline SVG on a 24×24 grid, strokes only, round caps and
joins, `stroke="currentColor"` so colour comes from the tone class and flips
with the theme. Stroke width follows the handoff by size (3 on 24px+ tiles, 2.6
inline, 2.4 small). 41 glyphs are verbatim from the prototype; the rest were
drawn for this app in the same geometry (back/close/chevrons, home, trash,
edit, clock, bank…). Tones: `gold green coral violet blue pink neutral current`
— domain colours (gold = kameti / budget / savings / warnings, violet = brand
and AI). The `extrude` prop is kept but draws nothing extra: strokes are crisp.

- **No container behind a tile glyph.** Plates appear only in empty states.
- Decorative by default (`aria-hidden`); pass `label` only when the glyph is
  the only thing that names the control.
- `Icon3D` survives as a shim: it maps every retired 3dicons name onto a glyph
  (`CLAY_TO_GLYPH`) so old call sites keep rendering. Prefer `<Glyph>`.
- No glyph fits? Keep the lucide icon at `strokeWidth={2.4}` in a glyph tone
  class, and add the glyph to `glyphs.ts` (the test pins grid + no fills).

## 5. Type

Geist (self-hosted variable font). Money is always `tabular-nums`.

| Role | Spec |
|---|---|
| Hero figure | 600 46px, -0.04em, solid white, no shadow |
| Entry amount | 600 56px, -0.045em |
| Section figure | 600 34–38px |
| Card figure | 600 21px, -0.03em |
| Screen title | 600 17px, -0.01em |
| Row title | 500–600 13.5–14px |
| Body | 400 11.5–12.5px |
| Micro-label | 600 10–11px caps, 0.12–0.14em |
| Tile label | 500 10.5px, fits itself to the tile (floor 8.5px) |

10px is the floor for anything a user must read.

## 6. Spacing, radii

20px page gutter · 10–12px between cards · 9–10px grid gap · 112px bottom
padding under the nav. Radii: 9 inner pill · 12 control · 14–16 key/button ·
18 card · 20–22 feature card / plate · 24 sheet top · 99 pill.

## 7. Components (shared, restyled in place — APIs unchanged)

`NavyHero` (`accent`), `TopBar`, `PageHeader`, `BottomNav` (glyph + label
tabs — founder choice over the handoff's text-only tabs — and the violet FAB),
`Tile3D`, `Card3D` (`feature`), `Button`, `EmptyState` (tones incl.
`violet`/`blue`/`pink`/`gold`), `ListSkeleton`, `Modal`,
`ConfirmationSheet`, `ConfirmDestructiveSheet`, `InboxAction` (bell),
`UserAvatar` (`self`), `MoneyDisplay` (`extrude`).

## 8. The bell

`InboxAction` shows `countBellItems().total` = incoming requests + unread
attention notifications + the user's own outgoing requests still waiting, and
rings whenever it shows a number (founder decision 2026-09-18, restoring the
pre-4840d6f alert). The coral badge stops are one step deeper than the handoff
so the white numeral clears 4.5:1 at the pill's middle.

## 9. Inbox tabs and type filters

Incoming / Outgoing / Info / Action sit on their own full-width `m-seg` row
under the title, with full labels (the handoff's inline "In / Out" was too
cryptic). Incoming and Outgoing mix kinds — loan requests, payment/settlement
requests and, on Incoming, contact-link asks — so a chip row (`m-pill`,
`aria-pressed`) narrows the list to All / Loans / Payments / Contacts, each
chip showing how many of its kind still wait (pending, like the tab badges —
exact, not capped at 9+). The chips appear only when the tab holds two or more
kinds, each tab remembers its own choice, and a filter whose kind empties out
falls back to All. The logic is pure and tested: `src/lib/inboxFilters.ts`.

## 10. How to add or change a token

1. Change the value in `src/index.css` (`@theme` for light/fixed,
   `html.dark` for dark).
2. Mirror it in `src/lib/designTokens.ts`.
3. `npx vitest run src/lib/designTokens.test.ts` — it fails if the two
   disagree or if any real pairing drops under AA; nudge until it passes and
   note the reason next to the value.

The fixed faces (primary button, WhatsApp button, bell badge, tile badge) are
literal gradients in `index.css`; their stops also live in `PRIMARY_BUTTON` /
`WHATSAPP_BUTTON` / `BELL_BADGE` / `TILE_BADGE`, and the test reads them back
from the CSS — change both.

History: the 3D-clay system (2026-09-03) and the Sukoon palette before it live
in git history (`git log -- docs/design-system.md`).
