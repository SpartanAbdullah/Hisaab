import { Modal } from './Modal';
import { Glyph } from './Glyph';
import { QRCode } from './QRCode';
import { useToast } from './Toast';
import { useT } from '../lib/i18n';
import { buildConnectUrl } from '../lib/connectQr';
import { buildAppShareUrl } from '../lib/collaboration';

interface Props {
  open: boolean;
  onClose: () => void;
  /** The user's own public code, e.g. "HSB-ABC234". */
  code: string;
}

async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try { await navigator.clipboard.writeText(text); return; } catch { /* fall through */ }
  }
  const ta = document.createElement('textarea');
  ta.value = text; ta.style.position = 'fixed'; ta.style.left = '-9999px';
  document.body.appendChild(ta); ta.select();
  try { document.execCommand('copy'); } finally { document.body.removeChild(ta); }
}

// "Show my code" — the half of face-to-face linking the OTHER person scans.
// Deliberately shows the six-character code underneath the symbol: phones
// die, cameras refuse to focus, and someone will always end up typing it.
export function MyQrSheet({ open, onClose, code }: Props) {
  const t = useT();
  const toast = useToast();
  const payload = code ? buildConnectUrl(code) : '';

  const copy = async () => {
    if (!code) return;
    try {
      await copyText(`@${code}`);
      toast.show({ type: 'success', title: t('connect_code_copied') });
    } catch {
      toast.show({ type: 'error', title: t('connect_code_copy_failed') });
    }
  };

  const share = async () => {
    if (!code) return;
    const text = `${t('connect_share_text')} @${code}`;
    try {
      if (navigator.share) {
        // Brand name — identical in both languages, not a copy string.
        // eslint-disable-next-line no-restricted-syntax
        await navigator.share({ title: 'Hisaab', text, url: payload || buildAppShareUrl() });
        return;
      }
      await copyText(`${text}\n${payload}`);
      toast.show({ type: 'success', title: t('connect_code_copied') });
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      toast.show({ type: 'error', title: t('connect_code_copy_failed') });
    }
  };

  return (
    <Modal open={open} onClose={onClose} title={t('qr_my_title')}>
      <div className="space-y-4">
        <p className="text-[12px] text-ink-600 leading-relaxed">{t('qr_my_desc')}</p>

        {/* The code sits on a white plate in BOTH themes — a scanner needs a
            light quiet zone — lifted on the card material so it still reads
            as part of the 1d sheet rather than a pasted-in image. */}
        <div className="flex justify-center">
          <div className="m-card m-card-feature p-3">
            <div className="rounded-[16px] bg-white p-3">
              <QRCode value={payload} size={224} title={t('qr_my_title')} />
            </div>
          </div>
        </div>

        <button
          type="button"
          onClick={copy}
          className="m-key w-full min-h-[48px] flex items-center justify-center gap-2.5"
        >
          <span className="text-[9px] font-semibold text-ink-400 uppercase tracking-[0.14em]">{t('mcc_hsb_tag')}</span>
          <span className="text-[17px] font-bold text-accent-600 tabular-nums tracking-wide">
            {code ? `@${code}` : '…'}
          </span>
          <Glyph name="copy" size={14} className="text-ink-400" />
        </button>

        <button
          type="button"
          onClick={share}
          disabled={!code}
          className="m-btn m-btn-primary w-full py-3.5 text-[13.5px]"
        >
          <Glyph name="share" size={15} strokeWidth={2.6} /> {t('connect_share')}
        </button>

        <div className="m-card m-violet p-3.5 flex items-start gap-2.5">
          <Glyph name="qr" tone="violet" size={16} className="mt-0.5" />
          <p className="text-[11.5px] text-ink-600 leading-relaxed">{t('qr_my_hint')}</p>
        </div>
      </div>
    </Modal>
  );
}
