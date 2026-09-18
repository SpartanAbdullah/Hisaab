// Rename / delete investment markets. Deleting is blocked while the market
// has trades (money history); currency is shown but never editable here —
// it locks at the first trade.

import { useState } from 'react';
import { Modal } from '../components/Modal';
import { Glyph } from '../components/Glyph';
import { CreateMarketModal } from './CreateMarketModal';
import { useInvestmentStore } from '../stores/investmentStore';
import { useToast } from '../components/Toast';
import { confirmDestructive } from '../components/ConfirmDestructiveSheet';
import { marketColorFor } from '../lib/marketColors';
import { currencyMeta } from '../lib/design-tokens';
import { useT } from '../lib/i18n';

interface Props {
  open: boolean;
  onClose: () => void;
}

export function ManageMarketsSheet({ open, onClose }: Props) {
  const markets = useInvestmentStore((s) => s.markets);
  const trades = useInvestmentStore((s) => s.trades);
  const renameMarket = useInvestmentStore((s) => s.renameMarket);
  const deleteMarket = useInvestmentStore((s) => s.deleteMarket);
  const toast = useToast();
  const t = useT();

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [showCreate, setShowCreate] = useState(false);

  const tradeCount = (marketId: string) => trades.filter((tr) => tr.marketId === marketId).length;
  // Holdings = distinct symbols, not trade rows (five buys of EMAAR ≠ 5 holdings).
  const holdingCount = (marketId: string) =>
    new Set(trades.filter((tr) => tr.marketId === marketId).map((tr) => tr.symbol)).size;

  const handleRename = async (id: string) => {
    try {
      await renameMarket(id, editName);
      setEditingId(null);
    } catch (err) {
      toast.show({ type: 'error', title: t('error'), subtitle: err instanceof Error ? err.message : t('toast_error_generic') });
    }
  };

  const handleDelete = async (id: string, name: string) => {
    if (tradeCount(id) > 0) {
      toast.show({ type: 'error', title: name, subtitle: t('inv_market_delete_blocked') });
      return;
    }
    const ok = await confirmDestructive({
      title: t('inv_delete_market_confirm').replace('{name}', name),
      description: '',
      confirmLabel: t('inv_delete_market'),
      cancelLabel: t('not_now'),
      tone: 'destructive',
    });
    if (!ok) return;
    try {
      await deleteMarket(id);
    } catch (err) {
      toast.show({ type: 'error', title: t('error'), subtitle: err instanceof Error ? err.message : t('toast_error_generic') });
    }
  };

  return (
    <>
      <Modal open={open && !showCreate} onClose={onClose} title={t('inv_manage_markets')}>
        <div className="space-y-2.5">
          {markets.map((m) => {
            const color = marketColorFor(m.id);
            return (
              <div key={m.id} className="m-card p-3.5">
                {editingId === m.id ? (
                  <div className="flex items-center gap-2">
                    <input
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      autoFocus
                      className="input-field flex-1 min-w-0 px-3 py-2"
                    />
                    <button
                      onClick={() => handleRename(m.id)}
                      disabled={!editName.trim()}
                      className="m-btn m-btn-primary min-h-[40px] px-3.5 py-2 rounded-[12px] text-[12px]"
                    >
                      {t('quick_save')}
                    </button>
                  </div>
                ) : (
                  <div className="flex items-center gap-3">
                    {/* Monogram plate in the market's own tint (the same hue
                        as its dot on the scope chips). */}
                    <div
                      aria-hidden="true"
                      className={`m-card ${color.scope} w-9 h-9 rounded-[12px] flex items-center justify-center shrink-0`}
                    >
                      <span className={`text-[10px] font-bold tracking-tight ${color.text}`}>{m.name.slice(0, 3).toUpperCase()}</span>
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-[13px] font-semibold text-ink-900 truncate">
                        {currencyMeta[m.currency]?.flag} {m.name} · {m.currency}
                      </p>
                      <p className="text-[10.5px] text-ink-600 mt-0.5">
                        {t('inv_market_has_holdings').replace('{n}', String(holdingCount(m.id)))} · {t('inv_market_currency_locked')}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => { setEditingId(m.id); setEditName(m.name); }}
                      aria-label={t('inv_rename_market')}
                      className="m-ctl relative w-9 h-9 flex items-center justify-center shrink-0 text-ink-600 before:absolute before:-inset-1 before:content-['']"
                    >
                      <Glyph name="edit" size={15} />
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDelete(m.id, m.name)}
                      aria-label={t('inv_delete_market')}
                      className="m-ctl relative w-9 h-9 flex items-center justify-center shrink-0 text-ink-600 hover:text-pay-text active:text-pay-text transition-colors before:absolute before:-inset-1 before:content-['']"
                    >
                      <Glyph name="trash" size={15} />
                    </button>
                  </div>
                )}
              </div>
            );
          })}
          <button
            type="button"
            onClick={() => setShowCreate(true)}
            className="m-btn m-btn-plain w-full text-[12.5px]"
          >
            <Glyph name="plus" size={14} strokeWidth={3} tone="violet" /> {t('inv_new_market')}
          </button>
        </div>
      </Modal>
      <CreateMarketModal open={showCreate} onClose={() => setShowCreate(false)} />
    </>
  );
}
