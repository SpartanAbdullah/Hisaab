# Accessibility — contrast fixes & Modal a11y contract

Scope: P2 item M3 (core half). Source findings: `docs/audit-2026-09/09-ui-quality.md`
finding #1 ("Design-token adoption"), finding #2 (Modal), §4 ("Contrast — systemic
small-text failures"), finding #3 (PageHeader dark mode), and
`docs/audit-2026-09/13-engineering-standards.md` §2.5 ("Accessibility maturity").

Math is done with WCAG 2.x relative luminance / contrast-ratio formulas, extracted
as pure functions in `src/lib/contrast.ts` (tested in `src/lib/contrast.test.ts`).
All ratios below were computed with that module (see the "regression guard" tests
for the exact fixed values pinned against drift).

Only **token values** were changed in `src/index.css` — no token was renamed, no
token was added to the color ramps, and hue/saturation were preserved wherever a
token was darkened/lightened (only lightness moved). One new CSS custom property
(`--header-surface`) was added, mirroring the existing `--nav-surface` pattern —
see item 3 below.

---

## 1. Light theme — before / after

| Token pair | Size class it's used at | Before | AA threshold | After | Passes? |
|---|---|---:|---:|---:|:---:|
| `ink-400` on `cream-bg` | Normal text (labels/amounts, mostly 9-13px — well under the 18.66px-bold "large text" cutoff) | 2.05:1 | 4.5:1 | **4.55:1** | ✅ |
| `ink-400` on `cream-card` (white) | Normal text | 2.30:1 | 4.5:1 | 5.10:1 | ✅ (was already the less-binding surface; bg is the constraint) |
| `ink-500` on `cream-bg` | Normal text (default secondary-text color, all sizes below 18.66px-bold) | 3.45:1 | 4.5:1 | **5.31:1** | ✅ |
| `ink-500` on `cream-card` | Normal text | 3.86:1 | 4.5:1 | 5.95:1 | ✅ |
| `warn-600` on `warn-50` | Normal text (badges/inline warnings, 68 call sites, e.g. `AccountDetailPage.tsx:603,674`) | 2.64:1 | 4.5:1 | **4.60:1** | ✅ |

**Hex changes (`src/index.css`, light `@theme` block):**

```
--color-ink-400:  #A8AABD → #696C8B
--color-ink-500:  #7E809A → #60627B
--color-warn-600: #C28E1A → #8D6813
```

Hue held at ~235° (ink) / ~40° (warn); only HSL lightness moved. The 300→900 ink
ramp stays monotonically darker (ink-300 lightest, ink-900 darkest) and ink-400 /
ink-500 remain visually distinct from each other and from their neighbors:

| Token | L (HSL) |
|---|---:|
| ink-300 | 81.8% |
| **ink-400 (new)** | 47.8% |
| **ink-500 (new)** | 42.9% |
| ink-600 (unchanged) | 40.0% |

Note `ink-400`/`ink-500` moved much closer to `ink-600` than they were — that's
the unavoidable consequence of both needing to individually clear 4.5:1 against
the same light background; there wasn't room to keep the old three-way spacing
and pass AA. They stay in the correct order and each is still a distinguishable
step.

`warn-700` (`#8A6410`, added in an earlier pass specifically "for TEXT on
warn-50" per its own code comment, but never adopted at the actual call sites)
is now close in value to the fixed `warn-600` — expected, since both now clear
the same AA floor against the same background. `warn-700` is unchanged and still
used at its one distinct call site (`GroupCard.tsx:116`, border + text on a
plain card background, not warn-50).

**Not changed (computed, already passing or out of this item's scope):**
- `ink-600` on `cream-bg`: 5.85:1 — already AA.
- `ink-300` on `cream-bg`: 1.45:1 — fails, but audited usage is decorative only
  (disclosure chevrons `<ChevronRight className="text-ink-300"/>`, "—" empty-value
  placeholders) — never real body text. Non-text UI components have a separate,
  lower WCAG bar (1.4.11, 3:1) that these arguably still miss for informative
  chevrons; flagged as a follow-up, out of this item's explicit scope
  (ink-400/ink-500 + warn-600/warn-50 per the task brief).
- `receive-text` (4.16:1) / `pay-text` (4.04:1) on `cream-bg`: both sit just
  under 4.5:1 at the 14px-semibold amount size the audit flagged
  (`TransactionItem.tsx:211`) — semibold (600) doesn't qualify as WCAG "bold"
  (≥700) and 14px is under the 18.66px large-text cutoff either way. Not in this
  item's explicit scope (only ink-400/ink-500/warn-600 were named); left as a
  known gap for a follow-up pass since fixing it changes the money-color
  semantics (`--color-receive-text`/`--color-pay-text`), which double as the
  chart colors and are a more product-sensitive change than the neutral ink
  ramp.

---

## 2. Dark theme — computed pass (all `ink-*`, receive/pay/warn semantic pairs)

The dark ramp's contrast had never been computed (audit note, §4). Full
computation against the dark **page background** `cream-bg` (`#131419`) and the
dark **card surface** `cream-card` (`#1E1F27`) — both matter in dark mode because,
unlike light mode, `cream-card` is *lighter* than `cream-bg` (a raised dark
surface), so it's the harder ("binding") constraint for light-colored text, not
the easier one:

| Token | vs dark `cream-bg` | vs dark `cream-card` | AA (4.5:1) | Action |
|---|---:|---:|:---:|---|
| `ink-200` | 1.35:1 | 1.20:1 | fail | Unchanged — decorative only (surfaces/borders, drag-handle fill), never text. |
| `ink-300` | 1.74:1 | 1.55:1 | fail | Unchanged — decorative only (chevrons/placeholders), same as light ramp. |
| `ink-400` | 3.62:1 | 3.23:1 | **fail** | **Fixed** → `#7B7D93`... see below (card-binding retarget) |
| `ink-500` | 6.01:1 | 5.36:1 | pass | Unchanged. |
| `ink-600` | 9.17:1 | 8.17:1 | pass | Unchanged. |
| `ink-700` | 12.02:1 | 10.71:1 | pass | Unchanged. |
| `ink-800` | 14.83:1 | 13.22:1 | pass | Unchanged. |
| `ink-900` | 16.91:1 | 15.08:1 | pass | Unchanged. |
| `receive-text` | 10.06:1 | — | pass | Unchanged. |
| `pay-text` | 8.26:1 | — | pass | Unchanged. |
| `warn-600` on `warn-50` | 6.90:1 | — | pass | Unchanged. |
| `warn-700` on `warn-50` | 8.95:1 | — | pass | Unchanged. |
| `receive-600` on `receive-50` | 6.21:1 | — | pass | Unchanged. |
| `receive-700` on `receive-50` | 3.83:1 | — | **fail, but unused as text** — see note. |
| `pay-600` on `pay-50` | 5.57:1 | — | pass | Unchanged. |
| `pay-700` on `pay-50` | 3.79:1 | — | **fail, used as text** | **Fixed** → `#CA6752` |

### `ink-400` (dark) — fixed, card-binding

`ink-400` is used as real body text at hundreds of call sites (same audit
pattern as the light ramp — labels, amounts, timestamps). First pass targeted
only `cream-bg` (→ `#7B7D93`, 4.55:1 on bg) but that left the *card* surface at
only 4.06:1 — still failing, because `cream-card` (#1E1F27) is lighter than
`cream-bg` (#131419) in dark mode, so a light-toned `ink-400` gets **less**
contrast against the card, not more (the opposite of light mode, where the
white card is the easy case). Retargeted against the card (the actual binding
constraint):

```
--color-ink-400 (dark): #6B6D82 → #848699
```

Result: 4.57:1 on `cream-card`, 5.12:1 on `cream-bg` — both clear AA. Ramp order
preserved: ink-300 (26.7% L) < ink-400 new (55.9% L) < ink-500 (61.2% L) <
ink-600 (74.5% L).

### `pay-700` (dark) — fixed

Used as text at one real call site, `BudgetsPage.tsx:154-155` (the over-budget
pill: `text-pay-700 bg-pay-50`). In dark mode this pairing was 3.79:1, failing
AA.

```
--color-pay-700 (dark): #C2543C → #CA6752
```

Result: 4.56:1 on dark `pay-50`. `pay-600` (5.57:1) and `pay-text` (8.26:1)
already cleared AA and are unchanged.

### `receive-700` (dark) — computed, left unchanged

3.83:1 against `receive-50`, technically failing — but grepping every usage of
`receive-700` in the codebase shows it is **only** ever used decoratively
(`bg-gradient-to-r from-receive-600 to-receive-700` in `GoalsPage.tsx:520` and
`UserAvatar.tsx:14`, both gradient fills, never `text-receive-700` on
`bg-receive-50`). No text-on-background pairing actually exists at this ratio
today, so it was left as-is rather than darkening a token that's never read as
text (which would just make the gradient direction less deep for no a11y gain).
Flagged here so a future `text-receive-700 bg-receive-50` usage doesn't ship
unnoticed.

---

## 3. PageHeader — token-driven dark-mode background

`PageHeader.tsx` set its sticky header's translucent cream background as a
literal inline `rgba(244, 242, 236, 0.9)` (audit finding #3, §8: "the sticky
header on essentially every screen hardcodes the light surface... in dark mode
the app body goes near-black while every page's header should stay glowing
cream"). Inline styles always win over any stylesheet rule, including
`html.dark` overrides, so no CSS-side fix could reach it — the same problem the
codebase already solved once for `BottomNav` via a `--nav-surface` custom
property (`index.css:129`, referenced from an inline style in `BottomNav.tsx`).

Applied the identical pattern: added `--header-surface` next to `--nav-surface`
in `src/index.css` (`:root` + `html.dark` block), and pointed `PageHeader.tsx`'s
inline `background` at `var(--header-surface)` instead of the literal rgba.
`backdropFilter`/`WebkitBackdropFilter` are unchanged.

```css
:root      { --header-surface: rgba(244, 242, 236, 0.9); }
html.dark  { --header-surface: rgba(19, 20, 25, 0.9); }
```

**Render-unverified.** This is a code-level fix matching the audit's own
prescribed pattern and the identical values `.modal-header` already uses per
theme, but per this item's brief it still needs an actual dark-mode device/PWA
check — no visual-regression tooling exists in this repo (see
`docs/audit-2026-09/13-engineering-standards.md` §2.7).

---

## 4. Modal — accessibility contract

`src/components/Modal.tsx` (the shared bottom-sheet modal used by ~40
create/edit flows) previously had no `role="dialog"`, no `aria-modal`, no focus
trap, no initial-focus move, no Escape handling, and no focus restoration
(audit finding #2, `09-ui-quality.md` §9; `13-engineering-standards.md` §2.5).
Fixed:

- **`role="dialog"` + `aria-modal="true"`** on the visible sheet (`.modal-sheet`
  div), not the full-screen backdrop wrapper (which is a decorative
  click-catcher only).
- **`aria-labelledby`** wired to the title `<h2>` via a `useId()`-generated id.
  An optional `ariaLabel` prop overrides this for the rare caller whose visible
  `title` text isn't a good standalone accessible name.
- **Focus trap**: Tab/Shift+Tab cycle within the dialog's focusable elements;
  wrapping past the first/last element loops to the other end. If the dialog
  has no focusable descendants, focus (and the trap) falls back to the dialog
  container itself (`tabIndex={-1}`).
- **Initial focus**: moves to the first focusable element inside the dialog on
  open (falls back to the dialog container if none exists), after one
  `requestAnimationFrame` so it lands once the entering sheet has mounted.
- **Escape → close**, routed through the same `requestClose()` used by the
  backdrop tap and the X button — so it respects an in-flight `confirmClose`
  guard (used by several callers to block dismissal on unsaved changes) exactly
  like every other dismissal path. There is no "destructive confirm that
  shouldn't close on Escape" case to special-case: `ConfirmDestructiveSheet`
  does **not** render inside `<Modal>` — it's a separate imperative
  full-screen sheet (its own zustand store) that already has its own Escape
  story via `useBackStackLayer(open, () => answer(false), 'confirm-sheet')`
  (unchanged, read-only reference for this item).
- **Focus restoration**: the element focused immediately before the modal
  opened is remembered and refocused on close, if it's still attached to the
  document.

### Back-stack / hardware-back coordination — the rule

Three independent "close the topmost dialog" signals exist in this app. Modal
now participates in (or coexists with) all three without ever double-closing:

1. **Capacitor hardware back** (native only, unchanged) —
   `src/lib/nativeBridge.ts`'s `backButton` listener calls
   `useUIStore.getState().closeTopModal()`, which pops the last handler off
   `uiStore.modalStack` directly (in-memory stack). It never touches
   `window.history`.
2. **Browser/PWA back** (`useBackStackLayer`, new in this item) — covers the
   desktop/web surface, which has no hardware back button (this is the
   audit's MF-08 follow-up named in the task). Each `Modal` **instance** gets
   its own history layer tag, `` `modal-${titleId}` `` (from `useId()`),
   instead of the literal `'modal'` example in the task brief. This is a
   deliberate deviation: Modals **do** nest in this app (the existing
   scroll-lock effect's own comment already accounts for "a nested sheet
   closing, e.g. the WhatsApp reminder over the Hisaab check"), and
   `useBackStackLayer`'s popstate matching treats "landed on a history entry
   that still carries MY tag" as a no-op — two Modal instances sharing one
   literal tag would silently swallow the back press instead of closing the
   topmost one (verified by tracing `isLayerState`/`withLayer` in
   `src/lib/backStackLayer.ts` against a 2-deep stack). Unique per-instance
   tags make each instance react only to the popstate that removed **its own**
   pushed entry, which — because pushes/pops are LIFO — is always the
   topmost modal. No extra coordination with `uiStore.modalStack` is needed
   for this path to be correct.
3. **Escape key + the Tab focus trap** (new in this item) — both are wired
   through one `document` keydown listener per open Modal instance. Unlike
   (2), there's no per-instance browser signal to key off here — every open
   modal's listener fires on every keypress — so each instance checks whether
   **its own** registered close handler is the top entry of
   `uiStore.modalStack` (the *same* stack (1) reads and mutates) before
   reacting, and no-ops otherwise. This reuses the app's one existing
   definition of "topmost modal" instead of inventing a second one, and keeps
   Escape/Tab consistent with hardware back: whichever modal hardware-back
   would close is also the one Escape closes and the one Tab stays trapped
   inside.

**Net rule:** a given close signal (hardware back / browser back / Escape)
always closes exactly the topmost open Modal, and the three mechanisms cannot
double-fire for the same key press or gesture, because they listen to disjoint
event sources — an in-memory stack pop, a `popstate` scoped by a unique
per-instance history tag, and a `document` keydown gated by that same
in-memory stack's top entry.

### App-root `inert`/`aria-hidden` — not implemented (documented per the task's escape clause)

`Modal` renders in-place in the React tree (no `createPortal`) at ~40 different
call sites — some nested deep inside a page's own component tree, some
stacked with another already-open Modal. Marking the app root (`#root`)
`inert`/`aria-hidden` while a modal is open would inert the modal's own DOM
too, since it is a *descendant* of `#root`, not a sibling. There is no single
stable "everything except the modal" container to target without either:

- portal-izing `Modal` (rendering it via `createPortal` into a sibling of
  `#root`) — a structural rewrite of the component's rendering model, which
  is out of this item's "no structural rewrites" boundary and would need its
  own review (stacking/z-index, CSS containment, and the `document.body`
  scroll-lock interaction all get re-verified), or
- auditing all ~40 call sites' surrounding DOM to find a per-page container to
  hide — unsafe to do blind, and would need re-doing every time a new call
  site is added.

The focus trap covers the practical keyboard-user risk (Tab cannot reach the
covered page while a modal is open). A screen-reader user driving a virtual
cursor (not Tab) could still swipe into background content while a modal is
open. **Flagged as a follow-up requiring a portal-based Modal** — a good
candidate for a future, separately-scoped item.

---

## 5. What this item did NOT do (explicitly out of scope / owned elsewhere)

- **`lang` attribute following the active language** (`index.html` hardcodes
  `lang="en"` on a Urdu-default app — `13-engineering-standards.md` §2.5).
  Owned by the i18n agent working concurrently in this same pass; this item
  does not touch `src/lib/i18n.ts` or `index.html`.
- **`eslint-plugin-jsx-a11y` + an axe/Lighthouse-a11y CI check** — no a11y
  linting or automated contrast/ARIA checks exist in `.github/workflows/ci.yml`
  or `eslint.config.js` today. Both are owned elsewhere per this item's file
  boundaries (`eslint.config.js` is explicitly out of scope for this agent).
- **A real TalkBack (Android screen reader) pass and a keyboard-only desktop
  PWA walkthrough on a live build.** Everything in this document is a
  code-level fix verified by `npx vitest run`, `tsc -b`, `eslint`, and
  `npm run build` — none of it is a substitute for the device pass the audit
  explicitly calls out as still required (`09-ui-quality.md`, "Required
  rendered visual pass," items 2 and 5).
- **`text-ink-300`/`text-ink-200` non-text (icon) contrast** and
  **`receive-text`/`pay-text` normal-size AA** — computed and documented above
  as known gaps, but not in this item's named token list (`ink-400`,
  `ink-500`, `warn-600`-on-`warn-50`), so left unchanged rather than risking an
  unreviewed change to the money-color semantics or icon visual weight.
- **`GroupDetailPage`'s pre-Sukoon palette leak** (rose `#f43f5e`, old green
  `#10b981`/indigo `#6366f1` — finding #6 in `09-ui-quality.md`) — a
  page-level fix (`src/pages/GroupDetailPage.tsx`), out of this item's file
  ownership (pages are explicitly off-limits for this agent).

---

## Verification run for this item

- `npx vitest run` — full suite passes except 6 pre-existing failures in
  `SplitWithSheet.test.tsx`, `TransactionItem.test.tsx`, and `inboxInfo.test.ts`
  — all i18n-string assertion mismatches in files this item never touched
  (`git status` confirms only `src/components/Modal.tsx`,
  `src/components/PageHeader.tsx`, `src/index.css`, `src/lib/contrast.ts`, and
  `src/lib/contrast.test.ts` were changed by this agent), caused by a
  concurrently-running i18n agent editing `src/lib/i18n.ts` in the same working
  tree.
- `npx vitest run src/lib/contrast.test.ts` — 15/15 pass (generic WCAG math +
  a regression guard pinning every fixed token's new hex against its AA
  threshold).
- `npx tsc -b --noEmit` — clean.
- `npx eslint src/components/Modal.tsx src/components/PageHeader.tsx src/lib/contrast.ts src/lib/contrast.test.ts` — clean.
- `npm run build` — production build succeeds.

---

## 6. M3 remainder — jsx-a11y lint, axe-in-CI, `lang` attribute

This section covers the rest of M3 (item 5's two "owned elsewhere" bullets
above, plus the `lang` attribute): `eslint-plugin-jsx-a11y`, an axe-core
Playwright suite wired into CI, and the runtime fix for `index.html`'s
hardcoded `lang="en"`. File ownership for this pass: `package.json` +
`package-lock.json`, `eslint.config.js`, `e2e/a11y.spec.ts` (new),
`.github/workflows/e2e.yml`, `src/lib/i18n.ts` (only the `setLang`/initial-
language code path), this doc, and tests — `src/pages/**`, `src/components/**`,
`src/stores/**`, `supabaseDb.ts`, any `supabase-*.sql`, `src/App.tsx`,
`vite.config.ts`, `index.html` were off-limits (other agents' concurrent work).

### 6.1 `eslint-plugin-jsx-a11y`

Installed `eslint-plugin-jsx-a11y@6.10.2` (exact, `npm install --save-dev
--save-exact`; peers on `eslint ^3‒^9`, so it's compatible with this repo's
ESLint 9 flat config). Wired into `eslint.config.js`, scoped to
`src/pages/**/*.tsx` + `src/components/**/*.tsx` (same file scope as the
existing i18n `no-restricted-syntax` block), as a second config object in the
`defineConfig([...])` array — `plugins: { 'jsx-a11y': jsxA11y }`, with
`languageOptions.parserOptions.ecmaFeatures.jsx = true`.

Rule severities: started from `jsxA11y.flatConfigs.recommended.rules` (every
rule "error" except a few already "off" — `anchor-ambiguous-text`,
`control-has-associated-label`, `label-has-for`), then **downgraded every
"error" rule to "warn" except a named critical subset**, which stays "error":

```
jsx-a11y/alt-text
jsx-a11y/aria-props
jsx-a11y/aria-role
jsx-a11y/role-has-required-aria-props
jsx-a11y/label-has-associated-control
jsx-a11y/click-events-have-key-events
jsx-a11y/no-static-element-interactions
```

`jsx-a11y/no-noninteractive-element-interactions` (the task brief's "?" rule)
was evaluated and left at **warn**, not promoted to the critical/error list:
a scoped lint run showed its violations are the same backdrop-click-catcher
shape `no-static-element-interactions` (already critical) already catches at
every one of the same call sites — promoting it too would not add new
blocking coverage, just duplicate errors on files this agent cannot edit.

The severity split is computed in code (`A11Y_CRITICAL_RULES` +
`a11ySeverityOf`/`a11yAsWarn` helpers in `eslint.config.js`), not hand-copied,
so a future `eslint-plugin-jsx-a11y` bump that adds/removes recommended rules
stays consistent automatically.

### 6.2 Per-file ignore list (`A11Y_SWEEP_TODO`)

Same ratchet pattern as `I18N_SWEEP_TODO`: `npm run lint` came up with **33
errors across 8 files** the first time the critical rules were wired in, all
in `src/pages/**`/`src/components/**` — off-limits for this agent to edit.
Every single one is the *same* underlying shape: a full-screen
`<div onClick={...}>` used as a backdrop click-catcher (dismiss a sheet/menu/
dialog on outside-click), or its `stopPropagation()` sibling, with no keyboard
handler and no interactive role — `click-events-have-key-events` +
`no-static-element-interactions` fire as a pair on the same line. (This is
the exact pattern §4 above already calls "a decorative click-catcher only"
for `Modal.tsx`'s own backdrop — Escape-to-close + the focus trap on the
dialog body is the real accessible path, not a keyboard handler on the
backdrop div.) The real fix per site is `role="presentation"` on that div
(removing it from the a11y tree, since it carries no content), a
page/component-level change out of this pass's file ownership.

| File | Errors | Rule pair | Call sites |
|---|---:|---|---|
| `src/components/ConfirmDestructiveSheet.tsx` | 4 | click-events-have-key-events + no-static-element-interactions | backdrop div (L125) + its stopPropagation() sibling (L127) |
| `src/components/ConfirmationSheet.tsx` | 4 | same pair | backdrop div (L70) + sibling (L72) |
| `src/components/DailyQuote.tsx` | 2 | same pair | backdrop div (L70), inside an already `role="dialog"` wrapper |
| `src/components/Modal.tsx` | 3 | same pair (2) + click-events-have-key-events alone (1) | shared backdrop div (L247, L249) — see §4 above |
| `src/components/ReceiptField.tsx` | 2 | same pair | image-viewer backdrop (L136) |
| `src/pages/AccountDetailPage.tsx` | 14 | same pair × 7 sites | overflow-menu scrim (L353) + 3 inline centred-dialog backdrops — rename/card-settings/balance-correct (L757-879) |
| `src/pages/GoalsPage.tsx` | 2 | same pair | per-goal overflow-menu scrim (L462) |
| `src/pages/LoanDetailPage.tsx` | 2 | same pair | overflow-menu scrim (L389) |
| **Total** | **33** | | **8 files** |

With those 8 files ignored for the a11y rule block only (not for the i18n
rule — the two ignore lists are independent), `npm run lint` exits **0** with
**25 warnings** remaining (all `jsx-a11y/no-autofocus` — 24, on modal/sheet
first-field inputs — plus 1 pre-existing `react-hooks/exhaustive-deps` in
`RepaymentModal.tsx`, unrelated to this rule). `no-autofocus` firing 24 times
is itself informative: this app's bottom-sheet pattern relies on
`autoFocus` heavily for its "sheet opens, keyboard is already up" feel —
worth a deliberate product/a11y trade-off discussion before touching, not a
mechanical fix, which is why it's "warn" and not on the sweep-list-required
critical rules.

**2026-09-02 follow-up — 7 of 8 files fixed for real.** Once page/component
ownership passed to the agent doing this cleanup, every click-catcher div
above (both the backdrop and its `stopPropagation()` sibling, where one
exists) got `role="presentation"` — the real fix this section originally
deferred, not a suppression:

- `ConfirmDestructiveSheet.tsx`, `ConfirmationSheet.tsx`,
  `ReceiptField.tsx`, `AccountDetailPage.tsx`, `GoalsPage.tsx`:
  `role="presentation"` added to every flagged div (both halves of each
  backdrop/stopPropagation pair, where a pair exists).
- `DailyQuote.tsx`: `aria-hidden="true"` (not `role="presentation"`) on the
  backdrop div at L70, since it sits *inside* a wrapper that already carries
  `role="dialog"` — matching the "aria-hidden where the backdrop is purely
  decorative and the sheet itself carries the dialog role" case named in this
  pass's task brief.
- `Modal.tsx`: could not take the same `role="presentation"` fix on its
  dialog sheet, because that element already carries the real
  `role="dialog"` this doc's own §4 requires — a second `role` would
  overwrite it. Instead, the dismiss-on-outside-tap handler moved from the
  outer full-screen wrapper onto `.modal-backdrop` (a decorative div that
  was already a *sibling* of the dialog sheet, not an ancestor of it), which
  got `role="presentation"`. Because the backdrop is a sibling, a click
  inside the dialog sheet never bubbles through it in the first place, so
  the sheet's `onClick={(e) => e.stopPropagation()}` became dead code and
  was deleted rather than also role-tagged. Net effect is identical:
  clicking the backdrop still calls `requestClose()`; clicking inside the
  sheet still does nothing. `docs/accessibility-contrast.md` §4's dialog
  contract (focus trap, Escape, back-stack coordination) is unchanged — only
  the backdrop-dismiss wiring moved.

`src/pages/LoanDetailPage.tsx` (the 8th file, same overflow-menu-scrim shape
as `GoalsPage.tsx` L462, at its own L389) is **not** fixed here and stays in
`A11Y_SWEEP_TODO` — it's owned by a different, concurrently-running agent in
this pass, out of this item's file boundaries. Not a different fix, just a
different owner.

### 6.3 axe-core in CI (`e2e/a11y.spec.ts`)

Installed `@axe-core/playwright@4.13.0` (exact; peer is `playwright-core >=
1.0.0`, satisfied by this repo's pinned `@playwright/test@1.62.1`). New
`e2e/a11y.spec.ts` scans, with `AxeBuilder`, every route that renders with
**no session** — `/privacy`, `/terms`, `/contact`, `/delete-account`, and `/`
(the signed-out auth gate, per `e2e/auth-page.spec.ts`) — in both `ur` and
`en`, on both Playwright projects (`mobile` = Pixel 5, `desktop` —
`playwright.config.ts`; unmodified, both projects already run every spec by
default, so no config change was needed for "runs on mobile too"). Language
is set the same way `e2e/public-pages.spec.ts`'s `gotoWithLang` does: seed
`hisaab_lang` in `localStorage` via `page.addInitScript` before `page.goto`,
matching what `src/lib/i18n.ts`'s `readStoredLang()` reads on boot and what
`AuthPage`'s own "EN"/"UR" toggle button writes at runtime.

Threshold: an axe violation with impact `serious` or `critical` **fails** the
test. `moderate` violations are attached to the Playwright report as a JSON
artifact (`testInfo.attach`) and also printed to the console/CI log, per the
task brief — visible without blocking merges on the long tail. Wired into
`.github/workflows/e2e.yml` as its own "Accessibility scan (axe)" step
(before "E2E smoke suite", which also re-runs it as part of the full
`testDir`) — it needs no `E2E_EMAIL`/`E2E_PASSWORD` secrets, same "public
pages only" scope as `e2e/public-pages.spec.ts`.

#### Axe findings (`npx playwright test e2e/a11y.spec.ts` against `npm run dev`, 2026-09-02)

| Page | Lang | Original result | 2026-09-02 follow-up | Rule | Impact | File |
|---|---|---|---|---|---|---|
| `/contact` | ur, en | **pass** | pass | — | — | — |
| `/privacy` | ur, en | fixme'd | **fixed** | `color-contrast` | serious | `src/pages/PublicInfoPages.tsx:66` |
| `/terms` | ur, en | fixme'd | **fixed** | `color-contrast` | serious | `src/pages/PublicInfoPages.tsx:66` |
| `/delete-account` | ur, en | fixme'd | **fixed** | `color-contrast` | serious | `src/pages/PublicInfoPages.tsx:66` |
| `/` (auth) | ur, en | fixme'd | **fixed** | `button-name` | critical | `src/pages/AuthPage.tsx:397-400` |

Two distinct real findings, originally in files off-limits to this agent —
`src/pages/**` — both fixed in the 2026-09-02 follow-up pass once page
ownership passed to the agent doing this cleanup:

1. **`color-contrast` on the shared legal-page header's "Last updated" date**
   — was `<p className="mt-4 text-[11px] text-white/45">Last updated: {LAST_UPDATED}</p>`
   (`src/pages/PublicInfoPages.tsx:66`, rendered by `/privacy`, `/terms`,
   `/delete-account`; `/contact` doesn't render this line, hence its pass).
   Measured **4.46:1** against `bg-navy-900` at 11px/normal-weight — the AA
   floor is 4.5:1, a near-miss. **Fixed** by bumping the opacity utility from
   `text-white/45` to `text-white/60`: white blended at 60% over `navy-900`
   (`#0B0E2A`) computes to **7.16:1** — comfortably clear, not shaved thin
   again, since the exact opacity step nearest the 4.5:1 floor (~50%) is
   close enough to it that a small rendering/antialiasing margin was
   preferred. `text-white/60` is an existing convention at this exact
   opacity elsewhere in the codebase (e.g. `src/App.tsx:188`,
   `src/components/AccountCard.tsx:142`), not a new one-off value.
2. **`button-name` on `AuthPage`'s password show/hide toggle** —
   was `<button type="button" tabIndex={-1} onClick={() => setShowPassword(!showPassword)} className="...">{showPassword ? <EyeOff/> : <Eye/>}</button>`
   (`src/pages/AuthPage.tsx:397-400`). Icon-only, no `aria-label`, so a screen
   reader announced an unlabeled button. **Fixed** with
   `aria-label={showPassword ? t('auth_hide_password') : t('auth_show_password')}`
   — two new toggling i18n keys added next to `auth_label_password` in
   `src/lib/i18n.ts`. `tabIndex={-1}` was deliberately left in place: the
   fix in scope was the missing accessible *name* (the axe `button-name`
   finding), not the button's place in the tab order, which is a separate,
   pre-existing product decision (skip the toggle in Tab order, land on the
   email → password → submit sequence) not covered by this item's brief.

Per the task brief ("mark the assertion `test.fixme` ... rather than
weakening the threshold"): both findings had been captured in
`e2e/a11y.spec.ts`'s `KNOWN_VIOLATIONS` map (keyed by page name — verified
lang-independent, both `ur`/`en` hit the identical single violation), with
the affected test cases calling `test.fixme(true, <rule + file + reason>)` as
their first line. Now that both are fixed, `KNOWN_VIOLATIONS` is emptied
(kept as an empty `const`, not deleted, so a future regression on these same
pages has a documented place to record a fixme again) and every
`test.fixme(!!known, …)` call is a no-op, so all 20 cases (5 pages × 2 langs
× 2 projects) now run for real. See "Verification run for this pass" below
for the actual `npx playwright test e2e/a11y.spec.ts` result.

Also observed (not gating, since `moderate`, but noted for completness) on
`/` (auth) in both languages: `landmark-one-main` (document has no `<main>`
landmark) and `region` (page content — `<h1>Hisaab</h1>`, the email/password
fields, the "no ads" tagline, the sign-up hint — isn't contained in any
landmark region). Both are `AuthPage.tsx`-level structural fixes, out of
scope here; flagged for whoever picks up the `AuthPage.tsx` items above.

### 6.4 `lang` attribute

`index.html` hardcodes `lang="en"` and is out of this pass's file ownership
(per the task's explicit note), so the fix is entirely runtime, in
`src/lib/i18n.ts`:

```ts
export function documentLangFor(lang: Language): string {
  return lang === "ur" ? "ur-Latn" : "en";
}
```

`ur` in this app is **roman Urdu — Latin script**, not the Perso-Arabic
script the bare `ur` IANA subtag implies. Assistive tech (and browser
spell/grammar tooling) selecting voice/phoneme rules from `lang="ur"` alone
would apply Perso-Arabic-Urdu handling to text that's actually transliterated
Latin-alphabet copy — wrong pronunciation, wrong script-direction
assumptions. `ur-Latn` (the `Latn` ISO 15924 script subtag, valid under
BCP 47) is the correct tag for "Urdu language, Latin script" and is what
screen readers are documented to key off for script-specific handling. `en`
needs no script subtag (Latin is English's default script).

`applyDocumentLang(lang)` sets `document.documentElement.lang =
documentLangFor(lang)`, guarded on `typeof document === "undefined"` — Node-
safe, since `vitest.config.ts` runs the pure-function suite in the `node`
environment (no jsdom/happy-dom), so `document` does not exist under test.
Called from two places in `src/lib/i18n.ts`:

- **`setLang`** — every future language switch (Settings toggle, onboarding
  step 0, `AuthPage`'s corner "EN"/"UR" button) now also corrects
  `<html lang>` alongside the existing `localStorage`/`profiles.lang` writes.
- **Module-level, once, at import time** — `applyDocumentLang(useI18nStore
  .getState().lang)`, right after the store is created. This is the boot-time
  fix for `index.html`'s hardcoded `lang="en"`: `i18n.ts` is imported by
  virtually every component (per its own existing module comments), so this
  runs before first paint reads happen in practice, without needing an
  `index.html` edit or an `App.tsx` effect.

Verified live (not just unit-tested) against `npm run dev`: `curl`-free check
via a throwaway Playwright+axe script confirmed `<html lang="ur-Latn">` when
`hisaab_lang=ur` is seeded and `<html lang="en">` when `hisaab_lang=en` is
seeded, on `/` (AuthPage) — see the axe scan's `landmark-one-main` node dumps
in §6.3 above, which happen to include the live `<html>` tag as one of their
target nodes: `target=["html"] html=<html lang="ur-Latn">` /
`html=<html lang="en">`.

**2026-09-02 follow-up — `index.html` static tag fixed, with a known
trade-off.** `index.html`'s `<html lang>` changed from the hardcoded
`lang="en"` to `lang="ur-Latn"`, matching `src/lib/i18n.ts`'s
`DEFAULT_LANGUAGE` and the `documentLangFor('ur')` mapping documented above.
This closes the pre-hydration gap for the common case: `ur` is this app's
default (a fresh install, a cleared-storage device, or any visitor before
`localStorage.hisaab_lang` is ever written) and is the majority of traffic
per the product's audience (CLAUDE.md: "Pakistani/Urdu-speaking audience"),
so the static tag now matches the accessible-name expectation for the
common path instead of the uncommon one.

**Trade-off, not eliminated — just inverted:** a returning visitor who
previously switched to English (`hisaab_lang=en` in `localStorage`) still
hits a brief pre-hydration window where `<html lang="ur-Latn">` is live
before `i18n.ts`'s module-level `applyDocumentLang(...)` corrects it to
`en` on import — a screen reader attached in that instant would apply
Latin-Urdu-tagged handling to what is, for that specific return visitor,
about to render as English copy. This is the same class of gap the original
`lang="en"` had for `ur` users, just for the minority language and the
minority visitor (returning + previously switched, not first-visit), and it
is inherent to any static server-rendered tag when the real preference lives
in client storage — genuinely eliminating it needs a tiny render-blocking
inline `<script>` in `<head>` that reads `localStorage.hisaab_lang` and sets
`document.documentElement.lang` before first paint, which this task's file
ownership (`index.html`'s `lang` attribute "and nothing else") does not
extend to adding. Flagged here as the residual gap, not fixed further in
this pass.

**2026-09-02 second follow-up — CSP checked, inline script deliberately NOT
added.** `index.html`'s meta CSP (`<meta http-equiv="Content-Security-Policy"
...>`) sets `script-src 'self'` with no `'unsafe-inline'`, no nonce, and no
hash source. A render-blocking inline `<script>` in `<head>` — the fix
sketched just above to close the residual returning-English-visitor gap —
would be silently blocked by the browser under this policy (the CSP has no
`unsafe-inline`/nonce/hash to permit it), not merely undesirable. Vite's
build pipeline doesn't emit a per-build nonce or a static hash for a
hand-written inline script either, so there is no low-effort way to satisfy
the existing policy for this one script. Adding the script anyway would ship
dead code that only produces a CSP console violation in every browser,
while leaving the same trade-off unresolved. So: not added. The residual gap
described above (a returning visitor who previously switched to English
sees `<html lang="ur-Latn">` for one pre-hydration instant before
`i18n.ts`'s module-level `applyDocumentLang(...)` corrects it to `en`)
remains open. Closing it for real needs either a build-time nonce/hash
wired into the CSP meta tag (a Vite plugin or a small build script) or
moving the language preference into a cookie a server/edge layer could read
before responding — both bigger than a single-file, "and nothing else"
change, and out of scope for this pass.

### `documentLangFor` unit test

`src/lib/i18n.test.ts` (new) — pure mapping only, 2 cases (`ur` → `ur-Latn`,
`en` → `en`). Importing `i18n.ts` also runs its module-level
`applyDocumentLang(...)` call at boot, which is safe under vitest's `node`
environment because of the guard described above.

### 6.5 Remaining M3 items

Carried over from §5 above; updated for the 2026-09-02 follow-up pass
(§6.2/§6.3/§6.4 above) that cleared most of what this section used to list
as still open:

- **A real Android TalkBack pass and a keyboard-only desktop PWA walkthrough
  on a live build.** Still open. Nothing in this repo — this doc included —
  substitutes for the device pass `09-ui-quality.md` calls out as still
  required. Automated coverage (`eslint-plugin-jsx-a11y`, axe-in-CI, and now
  the `role="presentation"`/`aria-hidden` sweep in §6.2) narrows the gap but
  explicitly cannot catch everything a real screen-reader user would hit
  (e.g. reading order, gesture conflicts, TalkBack-specific quirks).
- **`Modal` portal-ization for app-root `inert`/`aria-hidden`** (§4 above,
  "not implemented" section). Still open. `Modal` still renders in-place in
  the React tree at ~40 call sites, so a background screen-reader user
  driving a virtual cursor (not Tab) can still swipe into covered content
  while a modal is open. Needs `createPortal` plus a re-review of
  stacking/z-index, CSS containment, and the scroll-lock interaction — a
  structural rewrite, out of scope for both the original M3 pass and every
  pass since, including this one.
- **The 33-error / 8-file jsx-a11y ignore list (§6.2)** — **7 of 8 files
  fixed** in the 2026-09-02 follow-up pass (real `role="presentation"` /
  `aria-hidden` fixes, not suppressions — see §6.2 for the per-file
  breakdown). `src/pages/LoanDetailPage.tsx` (2 errors, same overflow-menu
  scrim shape, L389) remains on `A11Y_SWEEP_TODO` — owned by a different
  concurrently-running agent this pass, not a harder fix.
- **The 2 axe findings (§6.3)** — **both fixed** in the 2026-09-02 follow-up
  pass: `PublicInfoPages.tsx:66`'s "Last updated" contrast (`text-white/45`
  → `text-white/60`) and `AuthPage.tsx:397-400`'s password-toggle
  `aria-label`. `e2e/a11y.spec.ts`'s `KNOWN_VIOLATIONS` map is now empty.
- **`index.html`'s static `lang`** (§6.4 follow-up) — **fixed**:
  `lang="en"` → `lang="ur-Latn"`, matching `DEFAULT_LANGUAGE`. Closes the
  pre-hydration gap for the common (Urdu-default) case but, as documented in
  §6.4, inverts rather than eliminates it — a returning visitor who switched
  to English now hits the same brief mis-tagged window the `ur` majority
  used to. A render-blocking inline `<script>` reading
  `localStorage.hisaab_lang` before first paint would close that residual
  gap; not implemented here (outside this item's `index.html` file-ownership
  scope, which was the `lang` attribute "and nothing else").

---

## 7. Non-text UI component contrast — founder round 2026-09-06

Scope: founder feedback from the 2026-09-06 review round (tracked as **F9** in
`docs/founder-feedback-2026-09-06.md`): *"Dark mode & Light mode has issues
with contrast of some of the button's elements & fields, this requires in depth
analysis & fix."* The September pass above (§1–§2) tuned **text** tokens only
(`ink-400`/`ink-500`/`warn-600` light, `ink-400`/`pay-700` dark) against WCAG
1.4.3 (4.5:1 for normal text). It explicitly deferred non-text controls — the
bar there is **WCAG 1.4.11, 3:1** for a component's visual boundary and for
each state it can be in (focus, selected, on/off) — plus the `receive-text` /
`pay-text` 4.16 / 4.04 near-misses on `cream-bg` (§1, "Not changed") and the
`ink-300` chevrons (§1). Every control in the app still borrows the
**decorative** cream ramp for its edge: `cream-border` (`#EAE5D9` light /
`#2E2F3A` dark) is simultaneously every card edge (340 sites, meant to be
soft per the founder's no-hard-edges rule of 2026-09-03), the only visible edge
of every input (~92 sites) and the OFF fill of every toggle (6 sites). Both
app modes render the same controls — `full_tracker` just shows more of them
(account pickers, time inputs, native reminder toggles) and `splits_only` still
shows the Settings toggles, the app-mode picker, Create Group inputs and chips;
no mode-specific styling exists, so one CSS fix covers both.

Method: the same WCAG 2.x relative-luminance / `(L1+0.05)/(L2+0.05)` math as
`src/lib/contrast.ts`, plus sRGB alpha compositing for translucent colours
(`/45` white on navy, `opacity-30` fills, `rgba` borders, Tailwind v4's
`color-mix(currentcolor 50%)` placeholders). **The calculator reproduced the
documented `4.55:1` (light `ink-400` on `cream-bg`) and `4.57:1` (dark
`ink-400` on `cream-card`) values exactly**, and the §6.3 alpha values within
0.02 (white/60 on `navy-900` 7.18 vs 7.16 — integer-channel rounding of the
composite). Two independent recomputes reproduced every ratio below within
0.02. Token hexes were read from `src/index.css` (light `@theme` L33-130,
`html.dark` L168-232, component remaps L247-292, `.input-field` L1157-1170,
`.cta-*` L1190-1257, `.selector-base` L1309-1333, clay block L1489-2145).
Tailwind slate hexes quoted for `Button.secondary`/`.cta-*` are the v3
equivalents of v4's oklch values (±1 per channel, ratios ±0.05). One premise of
the first analysis was wrong and is corrected here: `placeholder:` utilities
**do** exist (11 sites — `CategoryPicker.tsx:93`, `CreateCommitteeModal.tsx:198/203/204`,
`HisaabAIPage.tsx:946/1065/1260` at `placeholder:text-ink-400`,
`CurrencyPicker.tsx:303` at `placeholder:text-ink-500`, and
`OnboardingPage.tsx:260/503/510` at `placeholder:text-white/25` / `/30` on the
navy hero inputs), which changes how the placeholder fix has to be written
(§7.4). There is still no `dark:` variant / `@custom-variant` anywhere (0
hits), so every theme-conditional fix must be a token or an `html.dark` rule.

Disabled controls are WCAG-exempt and hairlines / card borders / clay tile
surfaces are decorative (exempt); they are listed anyway because the founder
sees them, and marked as such.

### 7.1 Findings — light theme

Sorted fails first, by severity. "Call sites" are grep counts across
`src/pages` + `src/components` (corrected where the first count was
under by >30%).

| Pattern | Tokens (fg on bg) | Hex | Ratio | Threshold | Pass | Call sites | Example |
|---|---|---|---:|---:|:---:|---:|---|
| (a) input border — 1px `border-cream-border` on a `bg-cream-card` / transparent field | `cream-border` on `cream-card` | `#EAE5D9` on `#FFFFFF` | 1.26:1 | 3:1 (1.4.11 boundary) | ❌ high | 34 | `CreateGroupModal.tsx:182` (`inputClass`, 19 `bg-cream-card` inputs); `SettingsPage.tsx:691` (Mobile number, transparent on the clay-neutral card, 4 such); 11 `bg-cream-soft` inputs e.g. `SettingsPage.tsx:704` (1.16 vs soft) |
| (a) checkbox / radio box whose only affordance is the border — `border-cream-border text-transparent` unchecked | `cream-border` on `cream-card` | `#EAE5D9` on `#FFFFFF` | 1.26:1 | 3:1 | ❌ high | 8 | `BlockReportSheet.tsx:244/278`, `TransactionItem.tsx:189`, `AddGroupExpenseModal.tsx:346`, `GroupDetailPage.tsx:1403`, `KametiDetailPage.tsx:456`, `KametiWitnessPage.tsx:136`, `RecordTradeModal.tsx:534` (missed by the first analysis; added by review) |
| (a) `.input-field` class border — `rgba(226,232,240,0.6)` composited over white | slate-200/60 on white | `#EEF1F6` on `#FFFFFF` | 1.13:1 | 3:1 | ❌ high | 58 | `src/index.css:1157-1160` (rule); 58 `className="input-field"` sites |
| (a) `.selector-base` — 2px `cream-border` on white (account / cash-advance / bank-preset picker rows) | `cream-border` on white | `#EAE5D9` on `#FFFFFF` | 1.26:1 | 3:1 | ❌ high | 17 | `src/index.css:1309-1321`; selected state `accent-500` on `accent-50` = 3.87 passes (added by review) |
| (b) toggle OFF track — `bg-cream-border` on the Settings `clay-neutral` card | `cream-border` on `cream-card` (high rung; low rung `cream-soft` = 1.16) | `#EAE5D9` on `#FFFFFF` | 1.26:1 | 3:1 (boundary + state) | ❌ high | 6 | `SettingsPage.tsx:863` (daily quote), `:919` (reminders), `:958` (mute all), `:1000` (quiet hours); `PhoneDiscoverySection.tsx:210`; `TelemetryConsentToggle.tsx:54` |
| (b) toggle knob — `bg-white` knob on the OFF `cream-border` track | white on `cream-border` | `#FFFFFF` on `#EAE5D9` | 1.26:1 | 3:1 (state) | ❌ high | 6 | `SettingsPage.tsx:865` (`span … bg-white shadow-sm`); ON knob white on `receive-600` `#0F9D7B` = 3.43 passes |
| (e) chip text — `text-pay-text` on `bg-pay-50` (12-12.5px bold) | `pay-text` on `pay-50` | `#C45339` on `#FBEDE7` | 3.96:1 | 4.5:1 (1.4.3) | ❌ high | 57 | `ContactDetailSheet.tsx:971`; first count was 25 — recounted as lines carrying both classes |
| (e) chip text — `text-receive-text` on `bg-receive-50` (12px) | `receive-text` on `receive-50` | `#0F8466` on `#E6F4EE` | 4.11:1 | 4.5:1 | ❌ high | 39 | `CreateGroupModal.tsx:258`; first count was 23 |
| (e) chip text — `text-info-600` on `bg-info-50` | `info-600` on `info-50` | `#3F6BD9` on `#E8EEFB` | 4.18:1 | 4.5:1 | ❌ high | 11 | `GroupDetailPage.tsx:147`; first count was 2. `warn-600`/`warn-50` (27 sites, 4.60) and `warn-700`/`warn-50` (10, 4.85) pass |
| (i) `text-receive-600` / `text-pay-600` used as **text** (10-14px bold) | `receive-600` on white / `cream-bg` / `cream-soft`; `pay-600` on white / `cream-bg` | `#0F9D7B` on `#FFFFFF` / `#F4F2EC` / `#F8F6F0`; `#D9614A` on `#FFFFFF` / `#F4F2EC` | 3.43 / 3.06 / 3.17; 3.65 / 3.26 | 4.5:1 | ❌ high | 8 | `GoalsPage.tsx:357/366/447/450` (receive), `:340/357` (pay), `ContactDetailSheet.tsx:597`, `CategoryPicker.tsx:99`, `KametiDetailPage.tsx:480`; `BudgetWarningBanner.tsx:54` `bg-pay-100 text-pay-600` = **2.82** (added by review; dark passes 6.48 / 5.31) |
| (i) white label on `bg-receive-600` (12.5px semibold CTA, pills, toast body) | white on `receive-600` | `#FFFFFF` on `#0F9D7B` | 3.43:1 | 4.5:1 | ❌ medium | 4 text + 5 icon | `GroupDetailPage.tsx:1727` (Settle-up CTA), `LoansPage.tsx:739`, `Toast.tsx:45+`, `GettingStartedCard.tsx:62`; check icons `TransactionItem.tsx:188`, `GroupDetailPage.tsx:1401`, `KametiDetailPage.tsx:456`, `KametiWitnessPage.tsx:136`, `AuthPage.tsx:422` pass 3:1 in light (added by review) |
| (i) white label on `bg-pay-600` (Button `danger` + raw sites) | white on `pay-600` | `#FFFFFF` on `#D9614A` | 3.65:1 | 4.5:1 | ❌ medium | 7 + Button | `LoansPage.tsx:740`, `InboxPage.tsx:1046`, `Button.tsx:43` |
| (a) placeholder text — Tailwind v4 preflight `color-mix(currentcolor 50%)` | `ink-900` @50% (or inherited body `#1e293b` @50% = `#8F949D`, 3.05) on `cream-card` | `#878895` on `#FFFFFF` | 3.51:1 | 4.5:1 (placeholder is text) | ❌ medium | ~81 (92 inputs − 11 with `placeholder:` utilities) | `SettingsPage.tsx:690-691` (`+971 50 123 4567`); on `cream-soft` 3.47, on `cream-bg` 3.44 |
| (a) `.input-field:focus` border — hardcoded indigo-400 | `#818cf8` on white; ring `rgba(99,102,241,.2)` | `#818CF8` on `#FFFFFF` | 2.98:1 | 3:1 (focus state) | ❌ medium | 58 | `src/index.css:1167-1170`; the inline `inputClass` sites use `focus:border-accent-500` = 4.35 and pass — the first analysis wrongly generalised that to `.input-field` (corrected by review); off-palette indigo besides |
| (c) segmented picker — unselected option `bg-cream-soft text-ink-500` on the card | `cream-soft` on `cream-card` | `#F8F6F0` on `#FFFFFF` | 1.08:1 | 3:1 (boundary) | ❌ medium | 25 | `SettingsPage.tsx:837` (theme), `:1183/:1192` (app mode), `:1241`; `AddGroupExpenseModal.tsx:389/450`; `EditGroupExpenseModal.tsx:392/436`. Text `ink-500` on `cream-soft` 5.50 and selected `ink-900` fill 18.6 pass — text alone identifies the option, so this is founder-visible polish more than a hard fail |
| (i) `.cta-secondary` — hardcoded slate-500 on slate-100 (14px bold) | `#64748b` on `#f1f5f9` | `#64748B` on `#F1F5F9` | 4.34:1 | 4.5:1 (bold <18.66px is normal text) | ❌ medium | 5 | `src/index.css:1221-1235`; `BudgetsPage.tsx:225`, `HisaabCheckModal.tsx:119` |
| (i) `.cta-destructive` — hardcoded red-500 on red-50 (13px bold) | `#ef4444` on `#fef2f2` | `#EF4444` on `#FEF2F2` | 3.44:1 | 4.5:1 | ❌ medium | 2 | `src/index.css:1240-1257`; `ContactDetailSheet.tsx:813`, `BudgetsPage.tsx:701` — the last pure-red (non-coral) UI |
| (l) hero small text — theme-independent (the hero is always navy) `text-white/45` (11-12px) | white @45% on `navy-900`; bloom peak = `accent-500` @32% over `navy-800` = `#332B72` | `#797A8A` on `#0B0E2A` | 4.47:1 (3.72 on bloom) | 4.5:1 | ❌ medium | 13 text | `AuthPage.tsx:278/295/425`, `OnboardingPage.tsx:264/314/390/463/525`, `App.tsx:189/212`, `UpdateRequiredScreen.tsx:67`, `PinLockScreen.tsx:127`, `AccountDetailPage.tsx:442` (first count 11; recounted) |
| (l) hero small text `text-white/50` (9-12px) | white @50% | `#858696` on `#0B0E2A` / `#332B72` | 5.31 / **4.25** on bloom | 4.5:1 | ❌ medium | 26 (22 text) | `HomePage.tsx:594/995`, `AccountCard.tsx:125` (9px), `OnboardingPage.tsx:258/263/489/501/506` — fails on the bloom peak by the same method that fails `/45` (added by review) |
| (l) hero small text `text-white/40` (10.5-11px) | white @40% | `#6D6E7F` on `#0B0E2A` | 3.77 (3.28 bloom) | 4.5:1 | ❌ medium | 6 (5 text + 1 icon) | `AuthPage.tsx:312`, `OnboardingPage.tsx:244/371/508` (`:508` is the currency prefix inside the input — text, not decoration); `KhataLinkPage.tsx:93` is a decorative Lock icon |
| (l) hero small text `text-white/35` and `text-white/30` (10-11px) | white @35% / @30% | on `#0B0E2A` / `#332B72` | 3.15 / 2.83; 2.63 / 2.47 | 4.5:1 | ❌ medium | 3 + 5 | `/35`: `AuthPage.tsx:279`, `OnboardingPage.tsx:345`, `UpdateRequiredScreen.tsx:79`; `/30` as button/para text: `OnboardingPage.tsx:315/391/526/596`, `UpdateRequiredScreen.tsx:87` (added by review). `/55` eyebrows (27 sites) 6.19 / 4.83 and `/60` (31) 7.18 / 5.41 pass |
| (i) onboarding hero inputs — `bg-white/8 border-white/15` on `navy-800`, placeholders `placeholder:text-white/25` / `/30` | white @15% border; white @25% / @30% placeholder on the `#242740` input composite | border on `#11142F`; placeholder on `#242740` | ≈1.6 (border); 2.25 / 2.65 (placeholder) | 3:1 / 4.5:1 | ❌ medium | 3 | `OnboardingPage.tsx:260/503/510` — same class as (a) but on navy, where a cream field-border token would be wrong (added by review) |
| (m) WhatsApp — inline `#1FA855` fill under a white 13px-bold label | white on inline `#1FA855` (cannot flip) | `#FFFFFF` on `#1FA855` | 3.09:1 | 4.5:1 | ❌ medium | 5 fills + 4 icon/text | `GroupSettleUpModal.tsx:136`, `KametiPayoutSlipSheet.tsx:132`, `PaymentReminderModal.tsx:165`, `SendStatementModal.tsx:221`, `ShareKhataLinkSheet.tsx:154`; icon/text `KametiDetailPage.tsx:480` (inline style overrides its own `text-receive-600`), `ContactDetailSheet.tsx:584/607`, `ContactsPage.tsx:799` (9 sites, not 8 — `:584` added by review). As an icon on white 3.09 clears 3:1 |
| (f) disabled primary CTA — `bg-ink-900 text-white disabled:opacity-30` (and `accent-600` @30/40, `pay-600` @30) | white on `ink-900` composited @0.3 over `cream-card` | `#FFFFFF` on `#B7B7BF` | 1.99:1 | exempt (disabled) | ⚠️ founder-visible | 42 (`/30`) + 42 (`/40`) | `QuickEntry.tsx:1508` (Continue, 1.99 fill and text); `CreateGroupModal.tsx:189` (`accent-600` @0.3 → 1.59); `ShareKhataLinkSheet.tsx:141` (@0.4 → 1.89); `Button.tsx:99` uses @0.6 (ink 4.89, accent 2.71) |
| (i) `.cta-primary` — white 14px-bold label on the hardcoded indigo gradient | white on `#6366f1` → `#4f46e5` | `#FFFFFF` on `#6366F1` (lightest end) | 4.47:1 (6.29 dark end) | 4.5:1 | ❌ low | 23 | `src/index.css:1195-1218` — fails by a hair at one end, and off-palette vs `accent-600` (added by review) |
| (g) disclosure chevrons — `text-ink-300` `ChevronRight` on the card | `ink-300` on `cream-card` | `#C9CAD8` on `#FFFFFF` | 1.62:1 | 3:1 (informative icon) | ❌ low | 28 (26 are chevrons) | `SettingsPage.tsx:666` (My Account, rotates on expand); the §1 follow-up. The 2 non-chevron `ink-300` lines need confirming as decorative before any blanket swap |
| (a/j) focus halo — `focus:ring-2 focus:ring-accent-500/20` | `accent-500` @20% on `cream-card` | `#E5DEFF` on `#FFFFFF` | 1.29:1 | 3:1 | ⚠️ intentional | 38 | `ContactsPage.tsx:393` — the 2px `focus:border-accent-500` on the same element (4.35) carries focus; the halo is decorative |
| (h) hairlines / dividers / card borders — `cream-hairline`, `cream-border` | `cream-hairline` on `cream-card` | `#EFEBE0` on `#FFFFFF` | 1.19:1 (border 1.26) | exempt (decorative) | ⚠️ by design | 164 + 340 | `SettingsPage.tsx:551`; `InboxPage.tsx:1206` — deliberately soft (founder no-hard-edges rule 2026-09-03). This is exactly why `cream-border` must **not** be darkened globally |
| (k) Tile3D clay surfaces — tint rung vs `cream-bg` page | `accent-50` (worst) on `cream-bg` | `#F3F0FF` on `#F4F2EC` | 1.00:1 | exempt (`docs/design-system.md` §10.3: elevation is the shadow, state is the inset ring) | ⚠️ by design | 19 | `HomePage.tsx:751/759`, `QuickEntry.tsx:1619-1626`; selected ring `accent-500` vs tile **passes** every tint — 3.25 (sky) to 4.02 (neutral) |
| (d) small square icon buttons — `text-accent-600` icon on `bg-accent-100` | `accent-600` on `accent-100` | `#5B47E8` on `#EBE6FF` | 4.93:1 | 3:1 (icon) | ✅ | 28 | `CreateGroupModal.tsx:246-249`; surface vs card 1.21 is decorative — the icon is the affordance. `ink-700` on `cream-soft` 9.25; `receive-text` on `receive-50` check 4.11; `ink-400` on `cream-soft` 4.72 all pass |
| (i) Button `secondary` — `bg-slate-100 border-slate-200 text-slate-700` on a light sheet | slate-700 on slate-100 | `#334155` on `#F1F5F9` | 16.45:1 | 4.5:1 | ✅ | 6 | `ConfirmDestructiveSheet.tsx:51`; border slate-200 vs slate-100 1.13 is decorative |
| (j) Button focus-visible ring `ring-accent-500` + `ring-offset-2` | `accent-500` on `cream-card`; offset `#fff` | `#7C6CF0` on `#FFFFFF` | 4.35:1 | 3:1 | ✅ | 52 | `Button.tsx:101`; `.selector-base` / `.row-interactive` / `.clay-tile` outlines (`index.css:1300/1326/1836`) are 2px solid `accent-500` — pass |

### 7.2 Findings — dark theme

Dark `cream-bg` `#131419`, `cream-card` `#1E1F27`, `cream-soft` `#191A21`;
as in §2, the **card** is lighter than the page, so it is the binding surface
for light-toned foregrounds. Modal sheets use `cream-bg` as their surface
(`index.css:1376`); `.sheet-transient` is remapped to `cream-card`
(`index.css:247-252`).

| Pattern | Tokens (fg on bg) | Hex | Ratio | Threshold | Pass | Call sites | Example |
|---|---|---|---:|---:|:---:|---:|---|
| (a) input border — `border-cream-border` on a `bg-cream-card` field | `cream-border` on `cream-card` | `#2E2F3A` on `#1E1F27` | 1.24:1 | 3:1 (1.4.11 boundary) | ❌ high | 34 | `QuickEntry.tsx:1445` (`inputClass`); `ContactsPage.tsx:393` (search); vs `cream-soft` 1.31 |
| (a) checkbox / radio unchecked box — `border-cream-border` | `cream-border` on `cream-card` | `#2E2F3A` on `#1E1F27` | 1.24:1 | 3:1 | ❌ high | 8 | same 8 sites as §7.1 |
| (a) `.input-field` — `html.dark` remap to `cream-border` | `cream-border` on `cream-card` | `#2E2F3A` on `#1E1F27` | 1.24:1 | 3:1 | ❌ high | 58 | `src/index.css:247-252` — a **shared** selector (`.input-field, .selector-base, .sheet-transient`), border line L251 |
| (a) `.selector-base` — same remap | `cream-border` on `cream-card` | `#2E2F3A` on `#1E1F27` | 1.24:1 | 3:1 | ❌ high | 17 | selected state `accent-500` on `accent-50` = 4.66 passes |
| (b) toggle OFF track on the card | `cream-border` on `cream-card` (1.31 vs `cream-soft`) | `#2E2F3A` on `#1E1F27` | 1.24:1 | 3:1 | ❌ high | 6 | `TelemetryConsentToggle.tsx:54-57` — the knob floats on nothing; disabled @50% OFF track = 1.11 |
| (b) toggle ON knob — white on `receive-600` | white on `receive-600` | `#FFFFFF` on `#14B891` | 2.53:1 | 3:1 (state) | ❌ high | 6 | `PhoneDiscoverySection.tsx:210-213` |
| (g) text-link buttons — `text-accent-600` 11-12px semibold (Edit / Add / Change, ghost Button, helper copy) | `accent-600` on `cream-card` / `cream-bg` / `cream-soft` | `#7459F0` on `#1E1F27` | 3.46 / 3.88 / 3.66 | 4.5:1 (1.4.3) | ❌ high | 217 (51 at ≤11.5px) + `.wisdom-text` + `--clay-accent-strong` | `PhoneDiscoverySection.tsx:176`, `ContactDetailSheet.tsx:611`, `Button.tsx:46` (ghost); `.wisdom-text { color: var(--color-accent-600) }` (`index.css:1008-1009`, `DailyQuote.tsx:105`, 10.5px bold) and `--clay-accent-strong` (`index.css:1701`) reach the same colour without the utility class (added by review). Root cause: the single dark `accent-600` must stay dark enough for white-on-`accent-600` buttons (4.74) |
| (e) chip text — `text-accent-600` on `bg-accent-100` (9-12px) | `accent-600` on `accent-100` | `#7459F0` on `#2A2342` | 3.13:1 | 4.5:1 | ❌ high | 28 | `ContactPicker.tsx:107-110` (9px bold), `CreateGroupModal.tsx:254`, `ContactsPage.tsx:571` (first count 20; recounted) |
| (i) white label on `bg-receive-600` | white on `receive-600` | `#FFFFFF` on `#14B891` | 2.53:1 | 4.5:1 (text) / 3:1 (icon) | ❌ high | 4 text + 5 icon | `GroupDetailPage.tsx:1727` (12.5px semibold Settle-up CTA), `LoansPage.tsx:739`, `Toast.tsx:45+` (success body), `GettingStartedCard.tsx:62`; the 5 check-icon sites fail 3:1 too. Worse than the `pay-600` case and missed by the first analysis (added by review) |
| (i) white label on `bg-warn-600` / `bg-pay-600` | white on `warn-600`; white on `pay-600` | `#FFFFFF` on `#D9A52E`; on `#E5705A` | 2.24 / 3.09 | 4.5:1 | ❌ high | 3 + 7 (+ Button `danger`/`warning`) | `LoansPage.tsx:740`, `InboxPage.tsx:1046` (hero chip), `Button.tsx:43-44` |
| (i) Button `secondary` on the onboarding navy hero — `bg-slate-100` → `cream-soft` after the `html.dark` slate remap | `cream-soft` on `navy-800` (`.bg-navy-bloom` base) | `#191A21` on `#11142F` | 1.04:1 | 3:1 | ❌ medium | 5 hero + 1 sheet | `OnboardingPage.tsx:240/278/351/467/522` (`:522` missed by the first analysis); text `ink-900` on `cream-soft` 15.95 passes but the button has no edge (border remap 1.31). Only reachable when `hisaab_theme` was already dark/system before onboarding (`themeStore.ts:26-29` defaults light). `ConfirmDestructiveSheet.tsx:51` is **not** fine in dark: `.sheet-transient` → `cream-card`, so the fill is `#191A21` on `#1E1F27` = **1.06** with a `#2E2F3A` border = 1.31 (corrected by review) |
| (e) `text-accent-600` icon inside a translucent `bg-white/70` well over the accent tint card | `accent-600` on white@70% composite ≈ `#BFBDC6` | `#7459F0` on `#BFBDC6` | 2.53:1 | 3:1 (icon) | ❌ medium | 1 | `KametiWitnessPage.tsx:114-115` (Gift icon) — already failing, and the proposed `accent-text` remap would make it **1.35** unless the well becomes `bg-cream-card` (added by review) |
| (c) segmented picker — unselected `bg-cream-soft` on the card | `cream-soft` on `cream-card` | `#191A21` on `#1E1F27` | 1.06:1 | 3:1 | ❌ medium | 25 | same sites as §7.1; text `ink-500` on `cream-soft` 5.67 and selected fill 15.1 (text flips to `cream-bg` via `index.css:265-269`) pass |
| (f) disabled primary CTA — `ink-900` @0.3 / `accent-600` @0.3 | `cream-bg`-flipped text on `ink-900` @0.3 over `cream-card` | fill 2.59 / text 2.68; `accent-600` @0.3 1.38 | 2.59:1 | exempt (disabled) | ⚠️ founder-visible | 84 | same sites as §7.1 |
| (g) disclosure chevrons — `text-ink-300` | `ink-300` on `cream-card` | `#3C3E4C` on `#1E1F27` | 1.55:1 | 3:1 | ❌ low | 28 | `SettingsPage.tsx:666` |
| (a/j) focus halo `accent-500/20` | `accent-500` @20% on `cream-card` | `#343052` on `#1E1F27` | 1.32:1 | 3:1 | ⚠️ intentional | 38 | `focus:border-accent-500` on the same element = 4.69 carries focus |
| (h) hairlines / card borders | `cream-hairline` / `cream-border` on `cream-card` | `#232430` / `#2E2F3A` on `#1E1F27` | 1.11 / 1.24 | exempt | ⚠️ by design | 164 + 340 | as §7.1 |
| (k) Tile3D surfaces | tint rung vs `cream-bg` | — | 1.03-1.19 | exempt | ⚠️ by design | 19 | selected ring `accent-500` passes every tint — 3.80 (gold) to 4.69 (neutral); 1px hairline = white @7%, decorative |
| (d) icon `text-accent-600` on `bg-accent-100` squares | `accent-600` on `accent-100` | `#7459F0` on `#2A2342` | 3.13:1 | 3:1 (icon) | ✅ (barely) | 28 | `CreateGroupModal.tsx:246-249`; becomes 5.84 once the `accent-text` remap lands |
| (a) placeholder — preflight 50% `currentColor` | `ink-900` @50% on `cream-card` | — | 4.78:1 | 4.5:1 | ✅ | ~81 | dark passes; the fix in §7.4 is for light |
| (a) `.input-field:focus` border | `#818cf8` on `cream-card` | `#818CF8` on `#1E1F27` | 5.50:1 | 3:1 | ✅ | 58 | no `html.dark :focus` override exists; the light rule is the failing one |
| (e) chip text — `pay-text` / `receive-text` / `info-600` on their `-50` tints | `pay-text` on `pay-50` etc. | — | 7.72 / 8.60 / 5.43 | 4.5:1 | ✅ | 57 / 39 / 11 | as §2 |
| (i) `.cta-secondary` / `.cta-destructive` — `html.dark` remaps | `ink-600` on `cream-soft`; `pay-700` on `pay-50` | — | 8.64 / 7.72 | 4.5:1 | ✅ | 7 | `src/index.css:256-259` — the light rules should mirror these |
| (j) Button focus-visible ring + `ring-offset-2` | `accent-500` on `cream-card`; offset `#fff` (Tailwind default) | `#8F7EF5` on `#1E1F27`; `#FFFFFF` on `#1E1F27` | 4.69; 16.4 | 3:1 | ✅ (cosmetic) | 10 | `Button.tsx:101` — passes numerically, but the 2px **white** offset is a visible halo on every focused Button in dark |

### 7.3 Founder-visible examples

- Settings · notification toggles (Daily wisdom / Payment reminders / Mute all
  / Quiet hours) in the OFF state · light · OFF track `#EAE5D9` on the white
  clay card = **1.26:1** and the white knob on that track = **1.26:1** — the
  switch reads as a faint pill with no visible knob (`SettingsPage.tsx:863-865`).
- Settings · the same toggles plus "Let people with my number find me" and
  "Help improve Hisaab" · dark · OFF track `#2E2F3A` on `#1E1F27` = **1.24:1**
  (knob floats on nothing); ON knob white on `#14B891` = **2.53:1**
  (`TelemetryConsentToggle.tsx:54-57`, `PhoneDiscoverySection.tsx:210-213`).
- Settings › My Account · Mobile number and Name fields · light · transparent
  field with a `#EAE5D9` border on the white card = **1.26:1** — the field
  boundary is invisible until focus; same for every modal field
  (`.input-field` slate-200/60 border = **1.13:1**, 58 sites; Create Group
  name/code inputs on the `cream-bg` sheet 1.26:1, `CreateGroupModal.tsx:182`).
- Any modal field · light · tap into it and the `.input-field:focus` border
  is indigo `#818cf8` on white = **2.98:1** — the focused state is barely more
  visible than the resting one (`index.css:1167-1170`).
- Settings · Appearance (Light/Dark/System) and App-mode segmented pickers ·
  both themes · unselected option `cream-soft` on the card = **1.08:1** light /
  **1.06:1** dark — only the selected option looks like a button, the others
  look like loose text (`SettingsPage.tsx:837/1183/1192`).
- Quick Entry · Continue / Save while the form is incomplete
  (`bg-ink-900 text-white disabled:opacity-30`) · light · fill `#B7B7BF` on
  white with white text = **1.99:1**; Create Group's accent CTA at opacity-30
  = **1.59:1** — the primary button looks washed out (`QuickEntry.tsx:1508`,
  `CreateGroupModal.tsx:189`).
- My Phone Number block · "Edit" / "Add" violet text-link buttons, plus
  Contacts/Inbox violet chips and the Daily wisdom eyebrow · dark ·
  `accent-600` `#7459F0` on the card = **3.46:1**, on `accent-100` chips =
  **3.13:1** — muddy violet on charcoal (`PhoneDiscoverySection.tsx:176`,
  `ContactPicker.tsx:107-110`, `DailyQuote.tsx:105`).
- Group detail · green "Settle up" CTA, Loans "receivables" pill, success
  toast · dark · white on `receive-600` `#14B891` = **2.53:1**; light =
  3.43:1 (`GroupDetailPage.tsx:1727`, `LoansPage.tsx:739`, `Toast.tsx:45`).
- Loans / Inbox / Contacts · coral "you owe" chips and green "owed to you"
  chips · light · `pay-text` on `pay-50` = **3.96:1**, `receive-text` on
  `receive-50` = **4.11:1** (`ContactDetailSheet.tsx:971`,
  `CreateGroupModal.tsx:258`).
- Onboarding · the "Skip" / secondary buttons on the navy hero · dark ·
  `cream-soft` `#191A21` on `navy-800` `#11142F` = **1.04:1** — a black slab
  with no edge (`OnboardingPage.tsx:240/278/351/467/522`); and the hero
  inputs' placeholders at `white/25` / `/30` = **2.25 / 2.65:1**
  (`OnboardingPage.tsx:260/503`).
- Settle-up / Kameti payout / Send statement sheets · WhatsApp share button ·
  both themes · white label on `#1FA855` = **3.09:1** (`GroupSettleUpModal.tsx:136`).

### 7.4 Proposed token changes

Shape mirrors the idioms already in `src/index.css`: new tokens next to
`--header-surface`, `html.dark` remap rules next to the slate remaps
(L272-278) and the `.bg-ink-900.text-white` flip (L265-269). `cream-border`,
`cream-hairline` and the clay surfaces are **not** touched. Every "New ratio"
below was reproduced by both independent recomputes.

| Token | Theme | From | To | New ratio | Rationale | Knock-on (what else uses it) |
|---|---|---|---|---:|---|---|
| `--color-field-border` (NEW) | light | (none — fields use `cream-border` `#EAE5D9` = 1.26 on white; `.input-field` slate-200/60 = 1.13) | `#8F8877` | **3.15** (binding: vs `cream-bg` modal sheet); 3.53 vs white, 3.26 vs `cream-soft` | Warm-cream hue (~40°) kept, lightness dropped until a 1px field edge clears 3:1 on every surface a field sits on | Applied **only** to `<input>`/`<textarea>`/`<select>` (≈34 inline `border-cream-border` form-control sites + `.input-field` L1160 + the 8 checkbox/radio boxes + `.selector-base` L1316 + the two disabled Settings fields L679/L733 + time inputs L1024/L1043), the segmented-picker track border and the retokened `Button.secondary` border. `cream-border` itself is untouched, so the 340 card borders, 164 hairlines and every `divide-y` keep their soft edge. Not for the navy-hero inputs (see §7.5) |
| `--color-field-border` (NEW) | dark | `cream-border` `#2E2F3A` (1.24 on card) | `#6B6D82` | **3.23** vs `cream-card`; 3.41 vs `cream-soft`; 3.62 vs `cream-bg` sheet | The pre-audit dark `ink-400` value — a known, already-designed grey | Same sites as light. **Not** via the shared `html.dark` remap at L247-252 (it also covers `.sheet-transient` — that would put a 3.23:1 lip on `ConfirmDestructiveSheet`, which the no-lips rule forbids): add a separate `html.dark .input-field, html.dark .selector-base { border-color: var(--color-field-border); }` and leave L247-252 alone (corrected by review). Design note: `#6B6D82` is at the 3:1 floor (`#5E6075` = 2.66) and only 1.42:1 from dark `ink-400` `#848699`, so the outline is nearly the same grey as its placeholder — accept, or give dark fields a `cream-soft` fill so the outline is not the only cue |
| `--color-control-off` (NEW) | light | `cream-border` `#EAE5D9` as the OFF toggle fill (1.26 vs card; white knob 1.26 on it) | `#8F8877` (same value as `field-border`; separate name so they can diverge) | **3.26** vs the clay-neutral card's `cream-soft` rung; 3.53 vs white; knob 3.53 | OFF track must be 3:1 against the card **and** the white knob 3:1 against the track — one mid-tone does both | 6 toggle sites: `bg-cream-border` → `bg-control-off`. Verified: `bg-cream-border` has exactly those 6 sites plus 8 `active:bg-cream-border` press flashes (`GroupSettleUpModal.tsx:143`, `SplitWithSheet.tsx:234`, `ShareKhataLinkSheet.tsx:162/172`, `SendStatementModal.tsx:228`, `PaymentReminderModal.tsx:173/181`, `KametiPayoutSlipSheet.tsx:139`) which stay as they are |
| `--color-control-off` (NEW) | dark | `cream-border` `#2E2F3A` (1.24 vs card) | `#6B6D82` | **3.23** vs card; 3.41 vs `cream-soft`; white knob on it 5.08 | as light | same 6 sites |
| `--color-control-on` (NEW) | light | `receive-600` `#0F9D7B` used directly | `#0F9D7B` (unchanged value, tokenised) | 3.43 (track vs card and knob — already passing) | Tokenised only so dark can diverge | 6 toggle sites: `bg-receive-600` → `bg-control-on` |
| `--color-control-on` (NEW) | dark | `receive-600` `#14B891` (white knob 2.53) | `#0E8E6E` (= dark `receive-700`) | knob **4.11**; track vs card 3.99 | Reuses the existing dark `receive-700` rung; `receive-600` stays the CTA/chip/gradient colour | 6 toggle sites only. Screenshot-review note: this puts a second, darker green next to every other `receive-600` fill on the same screens (Toast success, check pills, the Settle-up CTA); if the founder prefers one green, the `bg-receive-600.text-white` flip below removes the need to diverge |
| `--color-accent-text` (NEW) | light | `accent-600` `#5B47E8` (5.98 on card, 4.93 on `accent-100`) | `#5B47E8` (identical — no light change) | 5.98 | Mirror of the `receive-text`/`pay-text` "text on cream" pattern: a text-only accent that can be brighter than the fill colour in dark without breaking white-on-`accent-600` buttons (4.74 dark) | Applied via `html.dark .text-accent-600:not(.bg-white) { color: var(--color-accent-text) }` — 217 `text-accent-600` sites flip in dark with no JSX churn; the two `bg-white text-accent-600` pills (`src/pages/PinLockScreen.tsx:167`, `PWAInstallPrompt.tsx:179`, where `#A594FF` would be 2.54) are excluded by the guard |
| `--color-accent-text` (NEW) | dark | `accent-600` `#7459F0` as text (3.46 on card, 3.13 on `accent-100`) | `#A594FF` | **5.84** on `accent-100` chips; 6.47 on `cream-card`; 7.25 on `cream-bg`; 6.75 on `cream-soft` | Same violet hue, lighter | Every dark `text-accent-600` (Edit/Add links, ghost Button, chips, helper copy, Lucide icons). Must **not** be applied to `bg-accent-600` fills. Three gaps the utility-only remap misses (added by review): `.wisdom-text` (`index.css:1008-1009`) and `--clay-accent-strong` (`index.css:1701`) must point at `var(--color-accent-text)` too; `KametiWitnessPage.tsx:114-115`'s `bg-white/70` well must become `bg-cream-card` or its icon drops from 2.53 to 1.35 — grep `bg-white/` ancestors of `text-accent-600` before merging. `ConfirmationSheet.tsx:190`'s `active:text-accent-700` is overridden by the rule, but it was already a no-op (no `--color-accent-700` token exists) |
| `--color-pay-text` | light | `#C45339` | `#AF4730` | **4.88** on `pay-50` chips (was 3.96); 4.98 on `cream-bg` amounts (was 4.04 — the §1 deferred gap); 5.58 on white | Coral hue kept (~14°), lightness down | 57 `bg-pay-50 text-pay-text` chips, every "you owe" amount (`TransactionItem`, `LoansPage`), `LoansPage.tsx:1052` chart stroke, `focus:border-pay-text` (`SettingsPage.tsx:1592/1608`, 5.58 on white still passes), `.cta-destructive` if repointed. On `pay-100` it is only 4.31: the only text pairing is the transient `active:bg-pay-100` press at `QuickEntry.tsx:1585` and the `PageErrorState.tsx:37` icon (4.31 ≥ 3) — see the note below for the 8 `bg-pay-100` lines. `src/lib/contrast.test.ts` does **not** pin `pay-text` today, so a guard must be **added**, not updated |
| `--color-receive-text` | light | `#0F8466` | `#0C7458` | **5.07** on `receive-50` (was 4.11); 5.13 on `cream-bg` (was 4.16); 5.75 on white; 4.88 on `receive-100` | Forest-green hue kept, lightness down | 39 `bg-receive-50 text-receive-text` chips, every "owed to you" amount, `LoansPage.tsx:1051` chart stroke, the WhatsApp icon/text sites once their inline colour is removed, `TelemetryConsentToggle` check icons, the `text-receive-600`-as-text sites in §7.1 once swapped. Zero `receive-100` text pairings exist. Guard must be added to `contrast.test.ts` |
| `--color-info-600` | light | `#3F6BD9` | `#335FCB` | **4.96** on `info-50` (was 4.18); 5.15 on `cream-bg` | Blue hue kept | 11 `bg-info-50 text-info-600` sites, `--clay-sky-strong` (`index.css:1674`), Toast info (white on it 4.87 → 5.77, improves), `InvestmentsPage.tsx:313` hover. No passing pair regresses |
| `--color-whatsapp` (NEW) | both | inline `#1FA855` (white label 3.09) | `#15873F` | **4.60** white on it; 3.57 as a fill vs the dark card | Same green family, dark enough for a white 13px-bold label | 5 share-button fills via `bg-whatsapp text-white`; the 4 icon/text sites (incl. `ContactDetailSheet.tsx:584`) drop their inline colour and use `text-receive-text` (5.75 light / 8.97 dark) |
| `::placeholder` rule (NEW, not a token) — **in `@layer base`** | light | Tailwind v4 preflight `color-mix(currentcolor 50%)` → `#878895` on white (3.51), `#8F949D` when body colour is inherited (3.05) | `@layer base { ::placeholder { color: var(--color-ink-400); } }` → `#696C8B` light / `#848699` dark | **4.55** on `cream-bg`; 5.10 on white; 4.72 on `cream-soft`; dark 4.57 (card) / 4.83 (soft) | `ink-400` was already tuned (§1/§2) to clear 4.5 on every surface in both themes | ≈81 inputs. It must sit in `@layer base` so the 11 existing `placeholder:` utilities keep winning — an unlayered rule (the `html.dark` idiom) would beat them and paint `#696C8B` into the onboarding hero inputs (`#242740` composite) at 2.86:1 light / 4.07 dark (corrected by review). Supersedes the `index.css:1154-1156` comment ("placeholder colour intentionally not set"); `.auth-input` floating labels use `placeholder=" "` so are unaffected; check the Contacts phone placeholder still reads as a hint, not a value |
| `.input-field:focus` border (`index.css:1167-1170`) | light | `#818cf8` indigo-400 (2.98 on white) + `rgba(99,102,241,.2)` ring | `border-color: var(--color-accent-500)` | **4.35** on white (dark `accent-500` on card 4.69 — add the same line under `html.dark` for palette consistency) | Focus state must clear 3:1 on its own; also removes the off-palette indigo. Added by review — repointing only the resting border would have left the focus border below 3:1 | 58 `.input-field` sites; matches what the inline `inputClass` sites already do with `focus:border-accent-500` |
| `.cta-secondary` / `.cta-destructive` light rules (`index.css:1221-1257`) | light | `#f1f5f9`/`#64748b` (4.34) and `#fef2f2`/`#ef4444` (3.44) | `cream-soft`/`ink-600` (`:active` `cream-border`) and `pay-50`/`pay-700` (`:active` `pay-100`) | **6.06** and **4.80** (or 4.88 with the new `pay-text`) | Mirrors the `html.dark` remaps already at `index.css:256-259`, so both themes are token-driven; removes the last pure red | 7 call sites (`BudgetsPage.tsx:225/701`, `HisaabCheckModal.tsx:119`, `ContactDetailSheet.tsx:813`, +3) |
| `html.dark .bg-pay-600.text-white, .bg-warn-600.text-white, .bg-receive-600.text-white { color: var(--color-cream-bg) }` | dark | white on `pay-600` `#E5705A` (3.09) / `warn-600` `#D9A52E` (2.24) / `receive-600` `#14B891` (2.53) | `#131419` text on the same fills | **5.95** (pay) / 8.21 (warn) / 7.26 (receive) | Same systemic idiom as the existing `.bg-ink-900.text-white` flip (`index.css:265-269`). `receive-600` was missing from the first proposal and is the worst of the three (added by review) | Button `danger`/`warning` variants, 7 raw `bg-pay-600 text-white` sites (`LoansPage.tsx:740`, `InboxPage.tsx:1046` hero chip — confirm it still reads as the active filter), 3 `warn-600` sites, the 4 `receive-600` text sites and 5 check-icon sites. Light `pay-600` 3.65 / `receive-600` 3.43 under white stay a founder decision (darkening `--color-pay-600` to `#C44E38` = 4.67 also shifts `--clay-depth-pay-rgb` and the coral chart/gradient uses; `receive-700` `#076B53` gives 6.49 if label fills move) |
| `Button.secondary` retoken + new `hero` variant (`Button.tsx:42`) | both | `bg-slate-100 border-slate-200 text-slate-700` (depends on the blanket slate remaps; 1.04 on the navy hero in dark, 1.06 on `ConfirmDestructiveSheet` in dark) | `secondary` = `bg-cream-soft border border-field-border text-ink-900 active:bg-cream-border`; `hero` = `bg-white/12 border border-white/20 text-white active:bg-white/20` (the existing hero-pill idiom, `SettingsPage.tsx:627`) | `secondary` edge 3.26 light / 3.41 dark; `hero` text 15+ | Stops `secondary` depending on the slate remaps; gives on-navy buttons their own variant | 6 `variant="secondary"` sites: `hero` at `OnboardingPage.tsx:240/278/351/467/522`, `secondary` stays at `ConfirmDestructiveSheet.tsx:51` (now with a visible edge in dark) |
| `Button` focus-visible offset (`Button.tsx:101`) | both | `ring-offset-2` with Tailwind's default `#fff` offset | add `focus-visible:ring-offset-cream-card` | 4.69 dark / 4.35 light (ring vs surface; offset now the surface colour) | Removes the white halo on every focused Button in dark | 10 Button focus sites; 52 `ring-accent-500` sites unaffected |

**Refuted or amended after review** (two independent verifiers, both
reproducing every ratio above; refutations were on execution facts, not on
the token values, which all held):

- *Dropped:* "`bg-pay-100` chips with `pay-text` text should switch to
  `pay-700` `#B4452C`" — `pay-700` on `pay-100` `#F7DDD2` is **4.24:1**, and the
  new `pay-text` there is 4.31; both fail 4.5. The 8 `bg-pay-100` lines that
  carry `pay-text`/`pay-600` text (e.g. `BudgetWarningBanner.tsx:54`, 2.82
  today) should move to a `pay-50` fill (4.88 with the new `pay-text`) instead;
  no darker coral token is added.
- *Amended:* the global `::placeholder` rule now lives in `@layer base` (the
  "no `placeholder:` utility exists" premise was false — 11 sites), and the
  onboarding hero placeholders are fixed per-site (§7.5), never by the global
  rule.
- *Amended:* the dark `.input-field` border is a separate rule, not a repoint
  of the shared L247-252 remap (which also styles `.sheet-transient`).
- *Amended:* "`contrast.test.ts` pins the old hexes and will fail" was wrong —
  the guard pins only `ink-400`/`ink-500`/`warn-600` (light) and
  `ink-400`/`pay-700` (dark); nothing covers `pay-text`/`receive-text`/
  `info-600`, so the suite would pass silently. Guards are to be **added**.
- *Amended:* "217 `text-accent-600` sites flip with zero churn" — true for the
  utility, but `.wisdom-text`, `--clay-accent-strong` and the
  `KametiWitnessPage` `bg-white/70` well need their own lines (table above).
- *Amended:* the `.input-field` focus state does **not** already pass in light
  (2.98, indigo-400) — added as its own row.
- *Amended:* `Button.secondary` has 6 sites, not 5 (`OnboardingPage.tsx:522`
  added), and `ConfirmDestructiveSheet.tsx:51` is a dark-mode fail, not "fine".
- *Amended:* `#1FA855` has 9 sites (`ContactDetailSheet.tsx:584` added); chip
  counts recounted (57/39/11/27/10/28); `text-white/45` is 13 text sites.
- *Added by review, no token needed:* the `bg-receive-600 text-white` flip,
  the `.selector-base` and checkbox/radio boxes taking `field-border`, the
  `text-receive-600`/`text-pay-600`-as-text swaps, the `/50`, `/35`, `/30` hero
  text sweep, `.cta-primary` (4.47 at its light end — low, listed for the
  founder), and the on-navy hero input border (§7.5).
- *Founder-rule alternative the first analysis did not offer:* WCAG 1.4.11's
  Understanding text exempts a text input's boundary when the field is
  identifiable without it (visible label + distinct fill), and every field
  here has a label and a 4.35 / 4.69 `accent-500` focus border. So the real
  choice for **fields** is (A) 1px `#8F8877` / `#6B6D82` outlines on ~92
  fields, or (B) `border-transparent` + `bg-cream-soft` on labelled fields,
  keeping the edge soft — (B) is defensible under 1.4.11 and keeps the flat
  luminous surfaces. (B) is **not** available for the checkboxes or the toggle
  OFF track, which genuinely need the mid-tone. Both screenshot pairs should
  go to the founder.

### 7.5 Per-site changes

- `src/index.css`: add `--color-field-border`, `--color-control-off`,
  `--color-control-on`, `--color-accent-text`, `--color-whatsapp` to the light
  `@theme` block and `html.dark` overrides (values above); add
  `@layer base { ::placeholder { color: var(--color-ink-400); } }`; repoint the
  `.input-field` resting border (L1160) **and** `.input-field:focus` border
  (L1168) at `--color-field-border` / `--color-accent-500`; add a separate
  `html.dark .input-field, html.dark .selector-base { border-color:
  var(--color-field-border); }` (do not edit the shared L247-252 remap);
  repoint `.selector-base`'s 2px border (L1316); retoken
  `.cta-secondary`/`.cta-destructive` light values (L1221-1257); add the
  `html.dark .text-accent-600:not(.bg-white)` remap next to the slate remaps
  (L272-278) and point `.wisdom-text` (L1008-1009) and `--clay-accent-strong`
  (L1701) at `var(--color-accent-text)`; extend the `.bg-ink-900.text-white`
  flip (L265-269) with `.bg-pay-600.text-white`, `.bg-warn-600.text-white`,
  `.bg-receive-600.text-white`; change `--color-pay-text` /
  `--color-receive-text` / `--color-info-600` light values; update the
  L1154-1156 placeholder comment.
- Toggles (6 sites): `SettingsPage.tsx:863/919/958/1000`,
  `PhoneDiscoverySection.tsx:210`, `TelemetryConsentToggle.tsx:54` —
  `bg-receive-600` → `bg-control-on`, `bg-cream-border` → `bg-control-off`.
- Form controls (~34 inline sites): every `<input>`/`<textarea>`/`<select>`
  with `border-cream-border` → `border-field-border` (e.g.
  `CreateGroupModal.tsx:182` `inputClass`, `QuickEntry.tsx:1445` `inputClass`,
  `ContactsPage.tsx:393/444/463`,
  `SettingsPage.tsx:679/691/704/733/754/765/1024/1043`); `border-pay-100`
  fields at `SettingsPage.tsx:1592/1608` → `border-field-border` too. Do
  **not** touch card `border border-cream-border` (340 sites). If the founder
  picks option (B) above, these become `border-transparent bg-cream-soft`
  instead.
- Checkbox / radio boxes (8 sites, always option A): `BlockReportSheet.tsx:244/278`,
  `TransactionItem.tsx:189`, `AddGroupExpenseModal.tsx:346`,
  `GroupDetailPage.tsx:1403`, `KametiDetailPage.tsx:456`,
  `KametiWitnessPage.tsx:136`, `RecordTradeModal.tsx:534` — unchecked
  `border-cream-border` → `border-field-border`.
- Onboarding hero inputs (`OnboardingPage.tsx:260/503/510`): `border-white/15`
  → `border-white/45` (or stronger) as the on-navy field edge — not the cream
  `field-border` token; `placeholder:text-white/25` / `/30` →
  `placeholder:text-white/60` (≈5.5:1 on the `#242740` composite).
- `text-receive-600` / `text-pay-600` used as text (light fails):
  `GoalsPage.tsx:340/357/366/447/450`, `ContactDetailSheet.tsx:597`,
  `CategoryPicker.tsx:99`, `KametiDetailPage.tsx:480` → `text-receive-text` /
  `text-pay-text`; `BudgetWarningBanner.tsx:54` `bg-pay-100 text-pay-600` →
  `bg-pay-50 text-pay-text`. The 8 `bg-pay-100` + `pay-text` lines → `bg-pay-50`.
- Segmented pickers (decision): `SettingsPage.tsx:837` (theme), `:1183/:1192`
  (app mode), `:1241` and the split/category pickers in
  `AddGroupExpenseModal.tsx:389/450`, `EditGroupExpenseModal.tsx:392/436` —
  wrap each group in a `rounded-xl p-1 bg-cream-soft border
  border-field-border` track, unselected options transparent.
- Disabled convention (decision): `disabled:opacity-30` (42 sites) and
  `disabled:opacity-40` (42 sites) → `disabled:opacity-50` (light `ink-900`
  fill/text 3.51, dark 4.78; `accent-600` still 2.25 / 1.80 — exempt, but
  visibly a button); `Button.tsx:99` keeps opacity-60 or aligns to 50. Do it
  with a scripted replace and eyeball three screens.
- `Button.tsx`: add `focus-visible:ring-offset-cream-card` to the base list
  (L101); retoken `secondary` (L42) to `bg-cream-soft border
  border-field-border text-ink-900 active:bg-cream-border
  focus-visible:ring-accent-500`; add a `hero` variant `bg-white/12 border
  border-white/20 text-white active:bg-white/20` and use it at
  `OnboardingPage.tsx:240/278/351/467/522`.
- Hero copy (theme-independent): `text-white/45` → `text-white/60` at the 13
  text sites (`AuthPage.tsx:278/295/425`,
  `OnboardingPage.tsx:264/314/390/463/525`, `App.tsx:189/212`,
  `UpdateRequiredScreen.tsx:67`, `PinLockScreen.tsx:127`,
  `AccountDetailPage.tsx:442`); `text-white/40` → `/60` at `AuthPage.tsx:312`,
  `OnboardingPage.tsx:244/371/508` (leave the `KhataLinkPage.tsx:93` icon);
  `text-white/35` → `/60` at `AuthPage.tsx:279`, `OnboardingPage.tsx:345`,
  `UpdateRequiredScreen.tsx:79`; `text-white/30` text → `/60` at
  `OnboardingPage.tsx:315/391/526/596`, `UpdateRequiredScreen.tsx:87`;
  `text-white/50` → `/60` at the 22 text sites that sit on the bloom
  (`HomePage.tsx:594/995`, `AccountCard.tsx:125`,
  `OnboardingPage.tsx:258/263/489/501/506`, …) — same fix already applied to
  `PublicInfoPages.tsx:66` (§6.3).
- WhatsApp: `GroupSettleUpModal.tsx:136`, `KametiPayoutSlipSheet.tsx:132`,
  `PaymentReminderModal.tsx:165`, `SendStatementModal.tsx:221`,
  `ShareKhataLinkSheet.tsx:154` — replace
  `style={{ background: '#1FA855', color: '#fff' }}` with
  `bg-whatsapp text-white`; `KametiDetailPage.tsx:480`,
  `ContactDetailSheet.tsx:584/607`, `ContactsPage.tsx:799` — delete the inline
  `style={{ color: '#1FA855' }}` and use `text-receive-text`.
- `KametiWitnessPage.tsx:114-115`: `bg-white/70` well → `bg-cream-card` before
  the dark `accent-text` remap lands; grep `bg-white/` ancestors of
  `text-accent-600` for any sibling.
- Chevrons (decision, 26 of 28 `text-ink-300` sites): informative disclosure
  chevrons → `text-ink-400` (5.10 light / 4.57 dark), e.g.
  `SettingsPage.tsx:666`; confirm the 2 non-chevron `ink-300` lines are
  decorative first.
- `.cta-primary` (23 sites, low): swap the hardcoded `#6366f1→#4f46e5`
  gradient for `accent-500→accent-600` or leave — 4.47 at the light end is a
  hair under; founder call.
- `src/lib/contrast.test.ts`: **add** regression guards for the new/changed
  values (`field-border` ≥3 vs white, `cream-bg` and the dark card;
  `control-off`/`control-on` knob ratios; `accent-text` ≥4.5 on dark
  `accent-100`; `pay-text`/`receive-text`/`info-600` ≥4.5 on their `-50` tints
  and on `cream-bg`; `whatsapp` white ≥4.5; `accent-500` `.input-field` focus
  border ≥3 on white). `docs/design-system.md`: list the five new tokens.
- Ship: `npm run build && npx cap sync android`, then hand the Gradle AAB build
  to the founder (CLAUDE.md shipping rule). No Supabase migration, no
  data-collection change — `play-store-data-safety.md` and the privacy page
  are untouched.

### 7.6 Status

Proposed, not shipped. Needs 390px light/dark screenshots and founder approval
before the token values change (founder rule 2026-09-03). Tracked as F9 in
`docs/founder-feedback-2026-09-06.md`.

Decisions the screenshots have to settle: field borders — option (A) 3:1
outlines vs option (B) transparent border + `cream-soft` fill on labelled
fields; disabled `opacity-30/40` → `50`; light `pay-600` / `receive-600` under
white text (darken the fill tokens, or fix dark only); segmented-picker track
treatment; clay tile `--clay-hairline-alpha` 0.14→0.24 / `--clay-rim`
0.07→0.12 (pure design, ring already passes); WhatsApp `#15873F` vs the
brand-ish `#1FA855`; chevrons `ink-300` → `ink-400`; dark `control-on` as a
second green vs one green plus the text flip. Every ratio here is computed,
not rendered — no visual-regression tooling exists (§3), so the founder's
device check remains the gate.

### 7.7 What is applied on branch `founder-round-2026-09-06` (2026-09-06)

Everything in §7.4/§7.5 that needs no founder decision is applied on the
local branch `founder-round-2026-09-06` — **uncommitted, unpushed, not in
any AAB**. Gates run on the branch: `tsc -b`, `eslint .`, `vitest run`,
`vite build` (see the tracker's F9 status for the results of the run that
closed this section).

**Applied**

- `src/index.css`: the five tokens (`field-border`, `control-off`,
  `control-on`, `accent-text`, `whatsapp`) in `@theme` + `html.dark`;
  `@layer base { ::placeholder { color: var(--color-ink-400) } }`;
  `.input-field` border → `field-border`, `:focus` → `accent-500` (light
  and dark); `.selector-base` 2px border → `field-border`; a separate
  `html.dark .input-field, html.dark .selector-base` border rule (the
  shared L247-252 remap is untouched); `.cta-secondary` /
  `.cta-destructive` light values → `cream-soft`/`ink-600` and
  `pay-50`/`pay-700`; `html.dark .text-accent-600:not(.bg-white)` →
  `accent-text`; `.wisdom-text` and `--clay-accent-strong` → `accent-text`;
  the `.bg-{receive,pay,warn}-600.text-white` dark flip; light
  `pay-text` `#AF4730`, `receive-text` `#0C7458`, `info-600` `#335FCB`.
- `src/components/Button.tsx`: `secondary` retokened
  (`bg-cream-soft border border-field-border text-ink-900`), new `hero`
  variant, `focus-visible:ring-offset-cream-card`.
- `src/lib/contrast.test.ts`: 21 new guards for every value above.
- Per-site (74 `border-field-border` sites, all verified to be
  `<input>`/`<textarea>`/`<select>`, an `inputClass` constant, a
  checkbox/radio box, or `Button.secondary`): the six toggle tracks →
  `bg-control-on` / `bg-control-off`; the 8 checkbox/radio boxes; the nine
  `#1FA855` sites (five fills → `bg-whatsapp text-white`, four icon/text →
  `text-receive-text`); `text-receive-600`/`text-pay-600` used as text →
  the `-text` tokens (GoalsPage, ContactDetailSheet, CategoryPicker,
  KametiDetailPage); `BudgetWarningBanner` → `bg-pay-50 text-pay-text`;
  `KametiWitnessPage`'s `bg-white/70` well → `bg-cream-card`; the
  onboarding hero inputs (`border-white/45`, `placeholder:text-white/60`)
  and the five hero `Button`s → `variant="hero"`; the hero small-text
  sweep (`/45`, `/40`, `/35`, `/30` text and the listed `/50` sites →
  `/60`, plus `App.tsx` verify-spam line and the onboarding quiz-retake
  button the first list missed). `CurrencyConversionCard`'s `inputClass`
  and `CreateCommitteeModal`'s member-row wrapper (the only visible edge of
  two borderless inputs) were caught by the leftover sweep and fixed.
- `docs/design-system.md` §2 lists the tokens; the tracker is
  `docs/founder-feedback-2026-09-06.md` F9.

**Not applied — waits on D-F9 (screenshots)**

- Fields option (B) instead of (A): the branch implements (A) — 1px
  `field-border` outlines. Switching to (B) is a mechanical swap of
  `border-field-border` → `border-transparent bg-cream-soft` at the same
  sites plus one `.input-field` rule.
- `disabled:opacity-30/40` → `50` (84 sites, scripted).
- Segmented-picker tracks (Settings theme/app-mode, expense split pickers).
- Chevrons `ink-300` → `ink-400` (26 sites).
- Light `pay-600` / `receive-600` fills under white text (darken the fill
  tokens, or leave light as-is now that dark is fixed by the flip rule).
- `.cta-primary` gradient → `accent-500→accent-600`.
- Clay hairline/rim alpha (pure design).

**How to see it:** check out the branch, then either the device, or
`E2E_PREVIEWS=1` with a `hisaab-staging` login and
`npx playwright test e2e/founder-previews.spec.ts` — it writes
`test-results/previews/{home,quick-entry-intents,settings,inbox,groups,create-group,contacts,contacts-add}-{light,dark}-{mobile,desktop}.png`.
Run it once on `main` first for the "before" set.

## 8. The 1d redesign — both themes, proven by test (2026-09-18)

The redesign (docs/design-system.md) re-valued every token. Contrast is no
longer argued pair-by-pair in this document: `src/lib/designTokens.ts` holds
both palettes as data, `src/lib/designTokens.test.ts` parses `src/index.css`
to prove the stylesheet matches it, and then checks **every real pairing** in
both themes (~370 checks as of 2026-09-19) — every text token on sheet / card /
card-face-bottom / control / key / inset, every chip text on its tint, every
solid fill with its label, every glyph tone and control edge at 3:1, and the
fixed material (primary button, bell badge, tile badge, hero copy). The fixed
faces' gradient stops and the `.auth-ink-dark` token copy are read back from
the CSS too, so neither can drift from what the checks assume.

Values nudged away from the handoff to pass, each noted beside the token:

| Token / element | Handoff | Shipped | Why |
|---|---|---|---|
| dark `ink-400` (muted) | `#848699` | `#8A8CA0` | 4.46 → 4.84 on the keypad / inset face `#1D2036` |
| light `ink-400` | `#696C8B` | `#62657F` | 4.14 → 4.64 on the ivory inset field |
| light `pay-text` | `#AF4730` | `#A6402A` | 4.31 → 4.84 on `pay-100` chips |
| light `receive-600` / `control-on` | `#0F9D7B` | `#0B8466` | white label 3.43 → 4.66; switch knob 4.66 |
| light `field-border` / `control-off` | `#8F8877` | `#857E6D` | 2.86 → 3.26 on the ivory inset field |
| light `glyph-green` | `#0F9D7B` | `#0C8F70` | 2.94 → 3.47 on the raised control |
| bell badge | `#F2967C→#B4452C` | `#DB6A50→#A3381F` | white 9px numeral 3.1 → 4.7 at the pill's middle |

**Brand violet (2026-09-19).** The founder replaced the handoff's gold primary
with Hisaab's own violet; gold stays for kameti and warnings. The violet values
and what they carry:

| Token / element | Light | Dark | Carries |
|---|---|---|---|
| `accent-600` | `#5B47E8` | `#7459F0` | white label — 5.98 light, 4.74 dark |
| `accent-500` | `#7C5CFF` | `#8E72FF` | rings, focus, selected edges, dots, progress (≥3:1 on sheet and card). In light **no label**: white is 4.35, a dark label ~4.0 — mid-luminance violet can't carry small text. Dark flips its label to the sheet colour (5.56) |
| `accent-text` | `#5B47E8` | `#B7A4FF` | violet text; `#B7A4FF` is 8.4:1 on the navy input well (auth focus label) |
| primary button face | `#9A80FF → #6D57F0 → #4A36D6` | same | white label 4.92 at the middle, 7.53 at the bottom |
| tile badge | `#8E72FF → #4A36D6` | same | white numeral ≥4.5 at the pill's middle |

Design decisions that keep contrast honest:

- Violet (`accent`) as text is always `accent-text`; `text-accent-600/500`
  are remapped to it. A violet fill that carries text is `accent-600` or the
  primary button face. A test fails if any page or component pairs a solid
  `bg-accent-500` with `text-white`.
- Text on a gold face (kameti, warnings) is always `gold-ink` (6.6:1+ on every
  gold stop).
- Numerals and glyphs have no offset shadow (2026-09-19). The layered
  extrusion read as blurred text, and it never counted toward contrast anyway.
- Heroes are dark in both themes and re-scope accent-text / glyph tokens to
  their dark values, so hero content never inherits light-theme dark ink.
- Controls keep their §7 boundaries: inputs/selectors a 1px `field-border`
  edge, OFF switch tracks a 1px `control-off` ring.
