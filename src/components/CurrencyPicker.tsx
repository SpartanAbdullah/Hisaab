import { useEffect, useMemo, useRef, useState } from 'react';
import { Modal } from './Modal';
import { Glyph } from './Glyph';
import { useT, useI18nStore } from '../lib/i18n';
import { useVisualViewportInset } from '../hooks/useVisualViewportInset';
import {
  CURRENCIES,
  currencyMeta,
  searchCurrencies,
  topCurrencies,
  type CurrencyMeta,
} from '../lib/currencies';
import {
  CURRENCY_CHIP_LIMIT,
  currencyChipRow,
  groupCurrenciesByLetter,
  isCurrencyAllowed,
} from '../lib/currencyPickerModel';

// ============================================================================
// The app's ONE currency chooser.
// ============================================================================
// Founder decision (2026-09-04): Hisaab accepts every ISO 4217 currency —
// "display top 5 currencies as it is being displayed and then ask the user to
// choose another currency, and that other currency should be a drop-down
// selector with a search bar so users don't have to scroll all the way down a
// list sorted A–Z."
//
// So the shape is deliberately two-tier:
//   • INLINE — five chips (the ranked top five, with the current value always
//     visible among them per `currencyChipRow`) plus one "Other…" chip. This
//     is what ~95% of users ever touch, and it costs the same taps as the old
//     eight-button grid it replaces.
//   • SHEET — everything else, search-first. Empty query falls back to the
//     full A–Z list with sticky letter headers, so the sheet is never a blank
//     box demanding a query before it shows anything.
//
// It replaces ten hand-rolled `SUPPORTED_CURRENCIES.map(...)` grids across
// nine files (AddAccountStepper carried two) plus one bare <select> in
// BudgetsPage — each of which had drifted into its own chip styling. All the
// selection logic that is not React lives in src/lib/currencyPickerModel.ts;
// the catalogue itself lives in src/lib/currencies.ts.
// ============================================================================

interface Props {
  /** ISO code currently selected. May be a code the catalogue does not carry. */
  value: string;
  onChange: (code: string) => void;
  /**
   * Codes the user already has money in (accounts, loans, this group's
   * transactions…). Feeds the ranking so a returning user's own currencies
   * float into the five visible chips. Cheap, best-effort — derive it from
   * whatever store the screen already has loaded; do not fetch for it.
   */
  used?: string[];
  /** The user's primary currency (profiles.primary_currency). Ranked first. */
  primary?: string;
  /** Field label rendered above the chips. Omit for a bare row. */
  label?: string;
  /**
   * Codes that can actually be SAVED right now. Everything outside it still
   * renders — greyed, with a "coming soon" note — rather than disappearing,
   * so the catalogue never looks like it is missing a currency. Default:
   * every code the catalogue carries.
   */
  allowed?: readonly string[];
  /**
   * 'surface' (default) — the app's `.selector-base` chip on a cream form.
   * 'on-dark'  — the frosted white-on-navy chip used by the onboarding hero,
   *              which is the only screen that paints its own dark ground.
   *              The SHEET is identical in both tones (it is always a cream
   *              sheet over the backdrop).
   */
  tone?: 'surface' | 'on-dark';
  /** Locks the whole control (e.g. a kameti whose currency is frozen). */
  disabled?: boolean;
  className?: string;
}

// Height of the sticky search block inside the sheet body (input 42px +
// 12px gap). The letter headers stick BELOW it, so they need the number.
// Kept as one constant used by both, so the two can never drift apart.
const SEARCH_BLOCK_H = 54;

function CurrencyRow({
  meta,
  selected,
  writable,
  lang,
  onSelect,
  comingSoonLabel,
  selectedLabel,
}: {
  meta: CurrencyMeta;
  selected: boolean;
  writable: boolean;
  lang: 'ur' | 'en';
  onSelect: () => void;
  comingSoonLabel: string;
  selectedLabel: string;
}) {
  return (
    <button
      type="button"
      disabled={!writable}
      onClick={onSelect}
      aria-pressed={selected}
      className={`w-full min-h-[44px] flex items-center gap-3 px-3 py-2 rounded-xl text-left transition-colors ${
        selected ? 'bg-accent-50' : 'active:bg-cream-soft'
      } ${writable ? '' : 'opacity-45'}`}
    >
      <span className="w-9 shrink-0 text-center text-[13px] font-semibold text-ink-500">
        {meta.symbol}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[13px] font-bold tracking-tight text-ink-900">{meta.code}</span>
        <span className="block text-[11px] text-ink-500 truncate">{meta.name[lang]}</span>
      </span>
      {!writable && (
        <span className="m-chip m-chip-neutral m-chip-caps shrink-0">
          {comingSoonLabel}
        </span>
      )}
      {selected && writable && (
        <Glyph name="check" size={16} strokeWidth={2.8} className="text-accent-600" label={selectedLabel} />
      )}
    </button>
  );
}

export function CurrencyPicker({
  value,
  onChange,
  used,
  primary,
  label,
  allowed,
  tone = 'surface',
  disabled = false,
  className = '',
}: Props) {
  const t = useT();
  const lang = useI18nStore((s) => s.lang);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const keyboardInset = useVisualViewportInset();

  // `used` is almost always a fresh array literal at the call site, so memoise
  // on its CONTENT, not its identity — otherwise the ranking recomputes on
  // every keystroke of whatever form this picker sits in.
  const usedKey = (used ?? []).join(',');
  const rankedCodes = useMemo(
    () => topCurrencies({ primary, used: usedKey ? usedKey.split(',') : [], limit: CURRENCY_CHIP_LIMIT })
      .map((c) => c.code),
    [primary, usedKey],
  );

  const { codes: chipCodes } = useMemo(
    () => currencyChipRow({ value, top: rankedCodes }),
    [value, rankedCodes],
  );

  const trimmedQuery = query.trim();
  const results = useMemo(
    () => (trimmedQuery ? searchCurrencies(trimmedQuery, lang) : []),
    [trimmedQuery, lang],
  );
  const letterGroups = useMemo(
    () => (trimmedQuery ? [] : groupCurrenciesByLetter(CURRENCIES)),
    [trimmedQuery],
  );

  // Focus the search field on open WITHOUT an `autoFocus` prop (jsx-a11y
  // flags it, and it is genuinely wrong here: it would also fire on a
  // server-rendered first paint). Modal itself moves focus to its first
  // focusable — the header close button — on a requestAnimationFrame, and
  // Modal's effect runs BEFORE this one (child effects first), so a nested
  // rAF here lands strictly after that and wins.
  useEffect(() => {
    if (!open) return;
    let inner = 0;
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => inputRef.current?.focus());
    });
    return () => {
      cancelAnimationFrame(outer);
      cancelAnimationFrame(inner);
    };
  }, [open]);

  const closeSheet = () => {
    setOpen(false);
    // Reset here rather than on open, so the list is never briefly rendered
    // filtered by the previous session's query as the sheet slides in.
    setQuery('');
  };

  const select = (code: string) => {
    onChange(code);
    closeSheet();
  };

  const onDark = tone === 'on-dark';
  const chipClass = (selected: boolean) => {
    if (onDark) {
      // 1d on the navy ground: the pressable tile material (the navy page
      // re-scopes it to its dark values), violet-tinted with the violet ring
      // when selected — the same selection treatment as every other tile.
      return `m-tile min-h-[48px] flex flex-col items-center justify-center gap-0.5 px-2 py-2 text-center ${
        selected ? 'm-violet m-tile-selected' : ''
      }`;
    }
    return `flex-col items-center justify-center gap-0 px-2 ${
      selected ? 'selector-base selector-selected' : 'selector-base'
    }`;
  };

  return (
    <div className={className}>
      {label && <span className="form-label">{label}</span>}

      {/* Six cells: five currency chips + "Other…". 3-up keeps every chip
          above the 44px touch floor at 360px width without truncating a
          3-letter code. */}
      <div className="grid grid-cols-3 gap-2" role="group" aria-label={label ?? t('cur_pick_title')}>
        {chipCodes.map((code) => {
          const meta = currencyMeta(code);
          const selected = code === value;
          return (
            <button
              key={code}
              type="button"
              disabled={disabled}
              aria-pressed={selected}
              onClick={() => onChange(code)}
              className={chipClass(selected)}
            >
              <span
                className={`text-[13px] font-bold tracking-tight ${onDark ? 'text-white' : 'text-ink-800'}`}
              >
                {code}
              </span>
              {/* The symbol is the recognition cue for a user who thinks in
                  ₨/₱/€ rather than in ISO codes. Suppressed when it is just
                  the code again (AED, SAR, …) so the chip isn't "AED AED". */}
              {meta && meta.symbol !== code && (
                <span className={`text-[10px] ${onDark ? 'text-white/60' : 'text-ink-500'}`}>
                  {meta.symbol}
                </span>
              )}
            </button>
          );
        })}

        <button
          type="button"
          disabled={disabled}
          onClick={() => setOpen(true)}
          className={chipClass(false)}
        >
          {/* Accent-coloured, unlike every currency chip beside it: this cell
              is an ACTION (open the full list), not a sixth currency, and at
              chip size the chevron alone is too quiet to say so. */}
          <span
            className={`text-[12px] font-semibold flex items-center gap-1 ${
              onDark ? 'text-accent-text' : 'text-accent-600'
            }`}
          >
            {t('cur_other')}
            <Glyph name="chevron-down" size={13} strokeWidth={2.6} />
          </span>
        </button>
      </div>

      <Modal open={open} onClose={closeSheet} title={t('cur_pick_title')}>
        {/* Sticky search. Sits above the letter headers (higher z) and is the
            reason they stick at SEARCH_BLOCK_H rather than at 0. */}
        <div
          className="sticky top-0 z-20 bg-cream-bg pb-3"
          style={{ height: SEARCH_BLOCK_H }}
        >
          <label htmlFor="currency-search" className="sr-only">
            {t('cur_search_label')}
          </label>
          <div className="relative">
            <Glyph
              name="search"
              size={15}
              className="absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-500 pointer-events-none z-[1]"
            />
            <input
              id="currency-search"
              ref={inputRef}
              // NOT type="search": Chrome paints its own ✕ clear button inside
              // a search input, which lands on top of the rounded field as a
              // stray blue glyph that is not part of this design system.
              // inputMode still gives the mobile keyboard a "search" key.
              type="text"
              inputMode="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('cur_search_placeholder')}
              autoComplete="off"
              className="input-field h-[42px] py-0 pl-10 pr-3 text-[13px]"
            />
          </div>
        </div>

        {/* The keyboard covers the bottom of the sheet on iOS (see
            useVisualViewportInset); pad the list so its last rows stay
            reachable instead of sitting under the keyboard. */}
        <div style={{ paddingBottom: keyboardInset }}>
          {trimmedQuery ? (
            results.length > 0 ? (
              <div className="space-y-0.5">
                {results.map((meta) => (
                  <CurrencyRow
                    key={meta.code}
                    meta={meta}
                    lang={lang}
                    selected={meta.code === value}
                    writable={isCurrencyAllowed(meta.code, allowed)}
                    onSelect={() => select(meta.code)}
                    comingSoonLabel={t('cur_coming_soon')}
                    selectedLabel={t('cur_selected')}
                  />
                ))}
              </div>
            ) : (
              <div className="py-12 text-center">
                <p className="text-[13px] font-semibold text-ink-900">{t('cur_no_match')}</p>
                {/* The query is echoed so a typo is visible without looking
                    back up at the field the keyboard may be covering. */}
                <p className="text-[12px] text-ink-500 mt-1 break-words">
                  &ldquo;{trimmedQuery}&rdquo;
                </p>
                <p className="text-[11px] text-ink-500 mt-3">{t('cur_no_match_hint')}</p>
              </div>
            )
          ) : (
            <div>
              {letterGroups.map((group, i) => (
                <div key={group.letter}>
                  {/* The one landmark in a ~170-row list. Opaque (not /95) —
                      a translucent header over a scrolling row reads as a
                      rendering glitch — and hairlined, so a stuck header is
                      still legibly a divider and not a floating letter. */}
                  <div
                    className={`m-label sticky z-10 bg-cream-bg border-b border-cream-hairline pb-1.5 px-1 ${
                      i === 0 ? 'pt-1' : 'pt-4'
                    }`}
                    style={{ top: SEARCH_BLOCK_H }}
                  >
                    {group.letter}
                  </div>
                  <div className="space-y-0.5 pb-1">
                    {group.items.map((meta) => (
                      <CurrencyRow
                        key={meta.code}
                        meta={meta}
                        lang={lang}
                        selected={meta.code === value}
                        writable={isCurrencyAllowed(meta.code, allowed)}
                        onSelect={() => select(meta.code)}
                        comingSoonLabel={t('cur_coming_soon')}
                        selectedLabel={t('cur_selected')}
                      />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}

          {allowed && (
            <p className="text-[11px] text-ink-500 mt-4 leading-relaxed">
              {t('cur_coming_soon_note')}
            </p>
          )}
        </div>
      </Modal>
    </div>
  );
}
