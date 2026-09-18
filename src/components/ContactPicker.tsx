import { useEffect, useMemo, useRef, useState } from 'react';
import { usePersonStore } from '../stores/personStore';
import type { Person } from '../db';
import { useT } from '../lib/i18n';

export interface ContactValue {
  id: string | null;
  name: string;
}

// Co-located display helpers used by ContactPicker and by ContactsPage.
// Moving them out would split tightly-coupled rendering logic across files
// for no real Fast Refresh win.
// eslint-disable-next-line react-refresh/only-export-components
export function getContactTypeLabel(person: Pick<Person, 'linkedProfileId'>): 'Linked' | 'Local' {
  return person.linkedProfileId ? 'Linked' : 'Local';
}

// `labels` lets the picker pass the localized words; the English defaults keep
// the helper usable (and testable) without an i18n context.
// eslint-disable-next-line react-refresh/only-export-components
export function getContactSecondaryText(
  person: Pick<Person, 'linkedProfileId' | 'phone'>,
  labels: { linked: string; local: string } = { linked: 'Hisaab user', local: 'Saved locally' },
): string {
  const typeText = person.linkedProfileId ? labels.linked : labels.local;
  return person.phone ? `${typeText} · ${person.phone}` : typeText;
}

interface Props {
  value: ContactValue;
  onChange: (next: ContactValue) => void;
  placeholder?: string;
  required?: boolean;
  className?: string;
}

// Controlled contact input. Typing sets { id: null, name: typed }.
// Selecting an existing match sets { id, name }. The parent is responsible
// for calling personStore.findOrCreateByName(name) on submit to resolve
// any id-less value into a persisted person before writing the loan/txn.
export function ContactPicker({ value, onChange, placeholder, required, className }: Props) {
  const persons = usePersonStore((s) => s.persons);
  const [open, setOpen] = useState(false);
  const [focused, setFocused] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  const query = value.name.trim();
  const queryLower = query.toLocaleLowerCase();

  const matches = useMemo(() => {
    if (!queryLower) return [];
    return persons
      .filter((p) => !p.archivedAt)
      .filter((p) => p.name.toLocaleLowerCase().includes(queryLower))
      .slice(0, 6);
  }, [persons, queryLower]);

  const exactMatch = useMemo(
    () => matches.find((p) => p.name.toLocaleLowerCase() === queryLower) ?? null,
    [matches, queryLower],
  );

  const t = useT();

  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (!wrapperRef.current) return;
      if (!wrapperRef.current.contains(e.target as Node)) setOpen(false);
    }
    if (open) document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const showDropdown = open && focused && query.length > 0 && (matches.length > 0 || !exactMatch);

  // 1d default: the sunken .input-field well (3:1 edge, violet focus).
  const inputClass = className ?? 'input-field';
  const secondaryLabels = { linked: t('blk_unknown_person'), local: t('cp_saved_locally') };

  return (
    <div ref={wrapperRef} className="relative">
      <input
        value={value.name}
        onChange={(e) => {
          onChange({ id: null, name: e.target.value });
          setOpen(true);
        }}
        onFocus={() => { setFocused(true); setOpen(true); }}
        onBlur={() => setFocused(false)}
        placeholder={placeholder}
        required={required}
        className={inputClass}
        autoComplete="off"
      />

      {/* 1d dropdown: a lifted card (lit face + ambient shadow) with hairline
          rows; "Linked" wears the violet chip, a local contact the neutral
          outline chip — the same pair the Contacts list uses. */}
      {showDropdown && (
        <div className="m-card absolute left-0 right-0 mt-1.5 z-20 overflow-hidden divide-y divide-cream-hairline">
          {matches.map((p) => (
            <button
              type="button"
              key={p.id}
              onMouseDown={(e) => {
                e.preventDefault();
                onChange({ id: p.id, name: p.name });
                setOpen(false);
              }}
              className="w-full text-left px-4 py-2.5 min-h-[44px] hover:bg-cream-soft active:bg-cream-soft transition-colors"
            >
              <span className="flex items-center gap-2 min-w-0">
                <span className="text-[13px] font-medium text-ink-900 truncate">{p.name}</span>
                <span className={`m-chip m-chip-caps shrink-0 ${
                  getContactTypeLabel(p) === 'Linked' ? 'm-chip-violet' : 'm-chip-neutral'
                }`}>
                  {getContactTypeLabel(p) === 'Linked' ? t('contact_linked_pill') : t('cts_local_chip')}
                </span>
              </span>
              <span className="block text-[10.5px] text-ink-600 mt-0.5 truncate">
                {getContactSecondaryText(p, secondaryLabels)}
              </span>
            </button>
          ))}
          {!exactMatch && (
            <button
              type="button"
              onMouseDown={(e) => {
                e.preventDefault();
                // Keep id:null — parent resolves via findOrCreateByName on submit.
                onChange({ id: null, name: query });
                setOpen(false);
              }}
              className="w-full text-left px-4 py-2.5 min-h-[44px] text-[12px] font-semibold text-accent-600 hover:bg-cream-soft active:bg-cream-soft transition-colors"
            >
              {t('cp_create_new_prefix')}&ldquo;{query}&rdquo;
            </button>
          )}
        </div>
      )}
    </div>
  );
}
