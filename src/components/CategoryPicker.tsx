import { useState } from 'react';
import { useToast } from './Toast';
import { Glyph } from './Glyph';
import { useT } from '../lib/i18n';
import { useCategoryOptions, withCurrentValue, type CategoryValidationError } from '../lib/mergedCategories';
import { useCustomCategoryStore, CustomCategoryError } from '../stores/customCategoryStore';
import type { CustomCategoryType } from '../db';

interface Props {
  type: CustomCategoryType;
  value: string;
  onChange: (category: string) => void;
  // Keep the current value visible even if it's not in the merged list (e.g.
  // editing a transaction whose custom category was later deleted).
  includeCurrent?: boolean;
  // Show the inline "+ New" affordance. Default on.
  allowCreate?: boolean;
}

// Button-grid category picker with an inline "+ New" affordance. The merged
// (built-in + custom) list comes from the custom-category store, so a category
// created here immediately appears in every other picker too.
export function CategoryPicker({ type, value, onChange, includeCurrent = false, allowCreate = true }: Props) {
  const t = useT();
  const toast = useToast();
  const addCategory = useCustomCategoryStore((s) => s.addCategory);
  const baseOptions = useCategoryOptions(type);
  const options = includeCurrent ? withCurrentValue(baseOptions, value) : baseOptions;

  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);

  const errorMessage = (code: CategoryValidationError) =>
    code === 'EMPTY' ? t('cat_err_empty') : code === 'TOO_LONG' ? t('cat_err_too_long') : t('cat_err_duplicate');

  const cancelAdd = () => { setAdding(false); setDraft(''); };

  const submit = async () => {
    const name = draft.trim();
    if (!name) { cancelAdd(); return; }
    setSaving(true);
    try {
      const created = await addCategory(type, name);
      onChange(created.name);
      toast.show({ type: 'success', title: t('cat_added') });
      cancelAdd();
    } catch (err) {
      const code = err instanceof CustomCategoryError ? err.code : 'DUPLICATE';
      toast.show({ type: 'error', title: errorMessage(code) });
    } finally {
      setSaving(false);
    }
  };

  // 1d pills: raised at rest, light-faced when picked; "+ New" is a brand-violet
  // pill, and the inline editor is a recessed well edged in the brand violet.
  return (
    <div className="flex flex-wrap gap-2">
      {options.map((c) => (
        <button
          key={c}
          type="button"
          onClick={() => onChange(c)}
          aria-pressed={value === c}
          className="m-pill"
        >
          {c}
        </button>
      ))}

      {allowCreate && !adding && (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="m-pill text-accent-text"
        >
          <Glyph name="plus" size={12} strokeWidth={3} /> {t('cat_add_new')}
        </button>
      )}

      {allowCreate && adding && (
        <span className="m-inset inline-flex items-center gap-1 rounded-full border border-accent-500 pl-3 pr-1 py-0.5">
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); void submit(); }
              if (e.key === 'Escape') cancelAdd();
            }}
            placeholder={t('cat_new_placeholder')}
            maxLength={28}
            className="w-28 bg-transparent outline-none text-ink-900 placeholder:text-ink-400"
          />
          <button
            type="button"
            disabled={saving}
            onClick={() => void submit()}
            className="w-8 h-8 flex items-center justify-center text-receive-text disabled:opacity-40 press-xs"
            aria-label={t('cat_save')}
          >
            <Glyph name="check" size={15} strokeWidth={3} />
          </button>
          <button type="button" onClick={cancelAdd} className="w-8 h-8 flex items-center justify-center text-ink-500 press-xs" aria-label={t('cancel')}>
            <Glyph name="close" size={14} strokeWidth={2.8} />
          </button>
        </span>
      )}
    </div>
  );
}
