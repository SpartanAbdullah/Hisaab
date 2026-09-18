import { useState } from 'react';
import { Modal } from './Modal';
import { Glyph } from './Glyph';
import { useToast } from './Toast';
import { confirmDestructive } from './ConfirmDestructiveSheet';
import { useT } from '../lib/i18n';
import { builtInsFor, type CategoryValidationError } from '../lib/mergedCategories';
import { useCustomCategoryStore, CustomCategoryError } from '../stores/customCategoryStore';
import type { CustomCategoryType } from '../db';

interface Props {
  open: boolean;
  onClose: () => void;
}

// Central place to add/remove custom categories for both expense and income.
// Built-ins are shown read-only (they can't be removed); the user's own
// categories sit above them with a delete affordance. Deleting never rewrites
// historical rows — it only removes the name from future pickers.
export function ManageCategoriesModal({ open, onClose }: Props) {
  const t = useT();
  const toast = useToast();
  const categories = useCustomCategoryStore((s) => s.categories);
  const addCategory = useCustomCategoryStore((s) => s.addCategory);
  const deleteCategory = useCustomCategoryStore((s) => s.deleteCategory);

  const [tab, setTab] = useState<CustomCategoryType>('expense');
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);

  const builtIns = builtInsFor(tab);
  const custom = categories.filter((c) => c.type === tab);

  const errorMessage = (code: CategoryValidationError) =>
    code === 'EMPTY' ? t('cat_err_empty') : code === 'TOO_LONG' ? t('cat_err_too_long') : t('cat_err_duplicate');

  const handleAdd = async () => {
    const name = draft.trim();
    if (!name) return;
    setSaving(true);
    try {
      await addCategory(tab, name);
      setDraft('');
      toast.show({ type: 'success', title: t('cat_added') });
    } catch (err) {
      const code = err instanceof CustomCategoryError ? err.code : 'DUPLICATE';
      toast.show({ type: 'error', title: errorMessage(code) });
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    const ok = await confirmDestructive({
      title: t('cat_delete_confirm_title'),
      description: t('cat_delete_confirm_body'),
      confirmLabel: t('cat_remove'),
    });
    if (!ok) return;
    await deleteCategory(id);
    toast.show({ type: 'success', title: t('cat_deleted') });
  };

  return (
    <Modal open={open} onClose={onClose} title={t('cat_manage_title')}>
      <div className="space-y-4">
        {/* Expense / Income tabs */}
        <div className="grid grid-cols-2 gap-2.5">
          {(['expense', 'income'] as CustomCategoryType[]).map((tb) => (
            <button
              key={tb}
              type="button"
              onClick={() => setTab(tb)}
              aria-pressed={tab === tb}
              className={`selector-base justify-center text-[12.5px] font-semibold ${tab === tb ? 'selector-selected' : ''}`}
            >
              {tb === 'expense' ? t('cat_expense_tab') : t('cat_income_tab')}
            </button>
          ))}
        </div>

        {/* Add a new category */}
        <div className="flex gap-2.5">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void handleAdd(); } }}
            placeholder={t('cat_add_placeholder')}
            maxLength={28}
            className="input-field flex-1"
          />
          <button
            type="button"
            onClick={() => void handleAdd()}
            disabled={saving || !draft.trim()}
            className="m-btn m-btn-primary shrink-0 px-4 text-[13px]"
          >
            <Glyph name="plus" size={14} strokeWidth={3} /> {t('cat_add_button')}
          </button>
        </div>

        {/* The user's own categories (deletable) */}
        <div>
          <p className="form-label">{t('cat_your_own')}</p>
          {custom.length === 0 ? (
            <p className="m-inset text-[12px] text-ink-500 p-3 text-center">{t('cat_none_custom')}</p>
          ) : (
            <div className="m-card divide-y divide-cream-hairline overflow-hidden">
              {custom.map((c) => (
                <div key={c.id} className="flex items-center gap-2 pl-4 pr-2 py-1.5">
                  <Glyph name="tag" size={15} tone="violet" />
                  <span className="flex-1 text-[13.5px] text-ink-900">{c.name}</span>
                  <button
                    type="button"
                    onClick={() => void handleDelete(c.id)}
                    className="w-11 h-11 rounded-xl flex items-center justify-center text-pay-text active:bg-pay-50 transition-colors"
                    aria-label={`${t('cat_remove')} ${c.name}`}
                  >
                    <Glyph name="trash" size={16} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Built-in categories (read-only) */}
        <div>
          <p className="form-label">{t('cat_built_in')}</p>
          <div className="flex flex-wrap gap-1.5">
            {builtIns.map((c) => (
              <span key={c} className="m-chip m-chip-neutral px-2.5 py-1 text-[11px]">
                {c}
              </span>
            ))}
          </div>
        </div>
      </div>
    </Modal>
  );
}
