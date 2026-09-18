import { useEffect, useRef, useState } from 'react';
import { Camera, Loader2 } from 'lucide-react';
import { useToast } from './Toast';
import { Glyph } from './Glyph';
import { confirmDestructive } from './ConfirmDestructiveSheet';
import { useT } from '../lib/i18n';
import {
  uploadReceipt, getReceiptUrl, deleteReceipt, isImageFile,
  ReceiptRejectedError,
} from '../lib/receiptStorage';

interface Props {
  transactionId: string;
  receiptPath: string | null | undefined;
  // Called after a successful upload (new path) or removal (null). The caller
  // persists it on the transaction (transactionStore.setReceiptPath).
  onChange: (path: string | null) => void;
}

// Attach / view / replace / remove a receipt photo for a transaction. Uses a
// plain file input with capture="environment" so Android opens the camera
// directly (and the Capacitor WebView handles it) without a native plugin.
export function ReceiptField({ transactionId, receiptPath, onChange }: Props) {
  const t = useT();
  const toast = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [viewing, setViewing] = useState(false);

  // Refresh the signed URL whenever the path changes.
  useEffect(() => {
    let active = true;
    if (!receiptPath) { setUrl(null); return; }
    void getReceiptUrl(receiptPath).then((u) => { if (active) setUrl(u); });
    return () => { active = false; };
  }, [receiptPath]);

  const pick = () => inputRef.current?.click();

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // let the user re-pick the same file
    if (!file) return;
    if (!isImageFile(file)) { toast.show({ type: 'error', title: t('receipt_not_image') }); return; }
    setBusy(true);
    try {
      const path = await uploadReceipt(transactionId, file);
      onChange(path);
      toast.show({ type: 'success', title: t('receipt_added') });
    } catch (err) {
      // The bucket's 5 MiB cap / MIME allowlist (audit M13) rejects silently at
      // the API boundary — receiptStorage pre-checks and raises a typed error so
      // the user gets a sentence they can act on instead of "couldn't save".
      if (err instanceof ReceiptRejectedError) {
        toast.show({
          type: 'error',
          title: err.code === 'TOO_LARGE' ? t('receipt_too_large') : t('receipt_bad_type'),
        });
      } else {
        toast.show({ type: 'error', title: t('receipt_failed') });
      }
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    const ok = await confirmDestructive({ title: t('receipt_remove_title'), confirmLabel: t('cat_remove') });
    if (!ok) return;
    setBusy(true);
    try {
      if (receiptPath) await deleteReceipt(receiptPath);
      onChange(null);
      toast.show({ type: 'success', title: t('receipt_removed') });
    } catch {
      toast.show({ type: 'error', title: t('receipt_failed') });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <label className="form-label">{t('receipt_label')}</label>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={handleFile}
      />

      {receiptPath ? (
        <div className="m-card flex items-center gap-3 p-2.5">
          <button
            type="button"
            onClick={() => url && setViewing(true)}
            className="m-inset w-14 h-14 rounded-xl overflow-hidden shrink-0 flex items-center justify-center press-sm"
          >
            {url ? (
              <img src={url} alt={t('receipt_label')} className="w-full h-full object-cover" />
            ) : (
              <Glyph name="receipt" size={20} tone="neutral" />
            )}
          </button>
          <div className="flex-1 min-w-0">
            <p className="text-[12.5px] font-semibold text-ink-900">{t('receipt_attached')}</p>
            <button type="button" onClick={pick} disabled={busy} className="text-[11.5px] text-accent-text font-semibold min-h-[32px] disabled:opacity-50">
              {t('receipt_replace')}
            </button>
          </div>
          <button
            type="button"
            onClick={remove}
            disabled={busy}
            className="w-11 h-11 rounded-xl flex items-center justify-center text-pay-text active:bg-pay-50 transition-colors disabled:opacity-50"
            aria-label={t('receipt_remove_title')}
          >
            {busy ? <Loader2 size={16} strokeWidth={2.4} className="animate-spin" /> : <Glyph name="trash" size={16} />}
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={pick}
          disabled={busy}
          className="m-btn m-btn-plain w-full text-[13px]"
        >
          {busy
            ? <Loader2 size={16} strokeWidth={2.4} className="animate-spin" />
            : <Camera size={16} strokeWidth={2.4} className="text-glyph-violet" />}
          {busy ? t('receipt_uploading') : t('receipt_add')}
        </button>
      )}

      {viewing && url && (
        <div
          className="fixed inset-0 z-[60] bg-navy-900/90 flex items-center justify-center p-4"
          role="presentation"
          onClick={() => setViewing(false)}
        >
          <img src={url} alt={t('receipt_label')} className="max-w-full max-h-[85vh] rounded-xl" />
        </div>
      )}
    </div>
  );
}
