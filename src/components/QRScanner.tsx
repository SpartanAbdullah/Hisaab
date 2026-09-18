import { useCallback, useEffect, useRef, useState } from 'react';
import { CameraOff, Keyboard, ScanLine } from 'lucide-react';
import { extractConnectCode } from '../lib/connectQr';
import { Glyph } from './Glyph';
import { useT } from '../lib/i18n';
import { useBackStackLayer } from '../hooks/useBackStackLayer';

type JsQrFn = typeof import('jsqr')['default'];

interface Props {
  open: boolean;
  onClose: () => void;
  /** Fired once, with the NORMALISED Hisaab code, then the scanner closes. */
  onCode: (normalisedCode: string) => void;
  /** "Type it instead" escape hatch — the scanner must never be a dead end. */
  onManualEntry?: () => void;
}

type Phase = 'starting' | 'scanning' | 'denied' | 'unavailable';

// Decode at a reduced resolution: jsQR is O(pixels) and a 1080p frame on a
// budget Android costs ~200ms, which drops the effective frame rate below
// what feels responsive. 480px on the long edge decodes a code held at
// arm's length reliably and keeps each pass under ~30ms.
const DECODE_EDGE = 480;
// ~8 attempts/second. Faster burns battery for no perceptible gain.
const SCAN_INTERVAL_MS = 120;

interface BarcodeDetectorLike {
  detect: (source: CanvasImageSource) => Promise<Array<{ rawValue: string }>>;
}
interface WindowWithDetector extends Window {
  BarcodeDetector?: new (opts?: { formats?: string[] }) => BarcodeDetectorLike;
}

/** Mount-gated wrapper. The active scanner owns a camera stream and a decode
 *  loop, so "closed" has to mean UNMOUNTED, not hidden — a paused component
 *  holding the camera open is how apps end up with the recording indicator
 *  stuck on. It also means every open starts from clean initial state
 *  instead of an effect that resets six things. */
export function QRScanner({ open, onClose, onCode, onManualEntry }: Props) {
  if (!open) return null;
  return <ActiveScanner onClose={onClose} onCode={onCode} onManualEntry={onManualEntry} />;
}

function ActiveScanner({ onClose, onCode, onManualEntry }: Omit<Props, 'open'>) {
  const t = useT();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<number | null>(null);
  const detectorRef = useRef<BarcodeDetectorLike | null>(null);
  // jsQR is ~30KB and only ever needed once the user actually opens the
  // scanner — loading it with the Contacts page would tax every visit for a
  // feature used on a fraction of them.
  const jsQrRef = useRef<JsQrFn | null>(null);
  // One-shot guard: the decode loop can fire twice before teardown finishes,
  // and handing the same code to the caller twice would double-run the link.
  const firedRef = useRef(false);
  // The camera must start exactly once. Keeping the callback in a ref means
  // a parent re-render (new inline arrow) can't retrigger the start effect
  // and tear the video stream down mid-scan.
  const onCodeRef = useRef(onCode);
  useEffect(() => { onCodeRef.current = onCode; }, [onCode]);

  const [phase, setPhase] = useState<Phase>('starting');
  // A QR that decoded fine but isn't ours. Told apart from "nothing seen yet"
  // so the user isn't left waving a valid-but-wrong code at a silent screen.
  const [wrongCode, setWrongCode] = useState(false);

  // Audit MF-08: a back press with the scanner open used to strand the
  // camera flow (fall through to the route underneath, camera left running
  // until the mount-gated wrapper unmounted for some other reason).
  // ActiveScanner only ever mounts while open, so the layer is "always open"
  // for its lifetime.
  useBackStackLayer(true, onClose, 'qr-scanner');

  const stop = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
    const stream = streamRef.current;
    if (stream) {
      stream.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    if (videoRef.current) videoRef.current.srcObject = null;
  }, []);

  useEffect(() => {
    let cancelled = false;

    const handleDecoded = (raw: string) => {
      const code = extractConnectCode(raw);
      if (!code) {
        setWrongCode(true);
        return;
      }
      if (firedRef.current) return;
      firedRef.current = true;
      stop();
      onCodeRef.current(code);
    };

    const tick = async () => {
      const video = videoRef.current;
      const canvas = canvasRef.current;
      if (!video || !canvas || video.readyState < 2 || firedRef.current) return;

      const vw = video.videoWidth;
      const vh = video.videoHeight;
      if (!vw || !vh) return;

      const scale = Math.min(1, DECODE_EDGE / Math.max(vw, vh));
      const w = Math.round(vw * scale);
      const h = Math.round(vh * scale);
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      // willReadFrequently: without it Chrome keeps the canvas GPU-backed and
      // every getImageData round-trips the bus — the single biggest cost in
      // this loop.
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) return;
      ctx.drawImage(video, 0, 0, w, h);

      if (detectorRef.current) {
        try {
          const found = await detectorRef.current.detect(canvas);
          if (found.length > 0 && found[0].rawValue) {
            handleDecoded(found[0].rawValue);
            return;
          }
        } catch {
          // Detector blew up mid-stream (happens when the Play Services
          // barcode module is updating). Fall through to jsQR from here on.
          detectorRef.current = null;
        }
      }

      const decoder = jsQrRef.current;
      if (!decoder) return; // still loading; the next tick will catch it
      const image = ctx.getImageData(0, 0, w, h);
      const result = decoder(image.data, w, h, { inversionAttempts: 'dontInvert' });
      if (result?.data) handleDecoded(result.data);
    };

    const start = async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        setPhase('unavailable');
        return;
      }
      // Kick the decoder fetch off in parallel with the camera permission
      // prompt — by the time a stream exists, it has almost always landed.
      void import('jsqr')
        .then((m) => { if (!cancelled) jsQrRef.current = m.default; })
        .catch((err) => console.error('[qr] decoder load failed', err));
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          // Rear camera. `ideal` rather than `exact` so a laptop webcam (or a
          // phone with an unusual camera set) still works instead of throwing.
          video: { facingMode: { ideal: 'environment' } },
          audio: false,
        });
        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        streamRef.current = stream;
        const video = videoRef.current;
        if (!video) return;
        video.srcObject = stream;
        // playsInline: without it iOS Safari hands the video to a fullscreen
        // native player and the scanner UI disappears behind it.
        video.setAttribute('playsinline', 'true');
        await video.play().catch(() => {});

        // Native BarcodeDetector when the WebView ships it (Chrome 83+ with
        // the Play Services barcode module): hardware-accelerated and far
        // cheaper than a JS decode. jsQR is the guaranteed fallback.
        const w = window as WindowWithDetector;
        if (w.BarcodeDetector) {
          try {
            detectorRef.current = new w.BarcodeDetector({ formats: ['qr_code'] });
          } catch {
            detectorRef.current = null;
          }
        }

        setPhase('scanning');
        timerRef.current = window.setInterval(() => { void tick(); }, SCAN_INTERVAL_MS);
      } catch (err) {
        if (cancelled) return;
        const name = (err as { name?: string } | null)?.name ?? '';
        setPhase(name === 'NotAllowedError' || name === 'SecurityError' ? 'denied' : 'unavailable');
      }
    };

    void start();
    return () => {
      cancelled = true;
      stop();
    };
  }, [stop]);

  const typeInstead = onManualEntry
    ? () => { onClose(); onManualEntry(); }
    : null;

  // 1d: the chrome around the camera is the hero material (dark in both
  // themes — .m-hero re-scopes the control material), the viewfinder stays
  // true black, and the reticle is drawn in the brand-violet primary.
  return (
    <div className="m-hero fixed inset-0 z-[70] flex flex-col">
      <div className="flex items-center justify-between gap-3 px-5 pt-[env(safe-area-inset-top)] h-16 shrink-0">
        <p className="text-[17px] font-semibold tracking-[-0.01em] text-white">{t('qr_scan_title')}</p>
        <button
          type="button"
          onClick={onClose}
          className="m-ctl relative w-9 h-9 flex items-center justify-center shrink-0 before:absolute before:-inset-1 before:content-['']"
          aria-label={t('cancel')}
        >
          <Glyph name="close" size={16} className="text-white" />
        </button>
      </div>

      <div className="relative flex-1 overflow-hidden bg-black">
        <video
          ref={videoRef}
          className="absolute inset-0 w-full h-full object-cover"
          muted
          playsInline
          autoPlay
        />
        <canvas ref={canvasRef} className="hidden" />

        {phase === 'scanning' && (
          // Reticle: a fixed square the user aims at. Scanning actually runs
          // on the whole frame — cropping to the box would reject codes the
          // decoder can already read, which reads as the scanner being broken.
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className="relative w-[68vw] max-w-[280px] aspect-square">
              <span className="absolute -top-px -left-px w-10 h-10 border-t-[3px] border-l-[3px] border-accent-500 rounded-tl-2xl" />
              <span className="absolute -top-px -right-px w-10 h-10 border-t-[3px] border-r-[3px] border-accent-500 rounded-tr-2xl" />
              <span className="absolute -bottom-px -left-px w-10 h-10 border-b-[3px] border-l-[3px] border-accent-500 rounded-bl-2xl" />
              <span className="absolute -bottom-px -right-px w-10 h-10 border-b-[3px] border-r-[3px] border-accent-500 rounded-br-2xl" />
            </div>
          </div>
        )}

        {(phase === 'denied' || phase === 'unavailable') && (
          <div className="m-hero absolute inset-0 flex flex-col items-center justify-center px-8 text-center">
            <div className="m-plate m-coral mb-[18px]" aria-hidden>
              <CameraOff size={24} strokeWidth={2.4} className="text-glyph-coral" />
            </div>
            <p className="text-[15px] font-semibold tracking-tight text-white">
              {phase === 'denied' ? t('qr_scan_denied_title') : t('qr_scan_unavailable_title')}
            </p>
            <p className="text-[12px] text-white/70 mt-1.5 leading-relaxed max-w-[270px]">
              {phase === 'denied' ? t('qr_scan_denied_body') : t('qr_scan_unavailable_body')}
            </p>
            {typeInstead && (
              <button
                type="button"
                onClick={typeInstead}
                className="m-btn m-btn-primary mt-5 px-5 py-2.5 text-[12.5px]"
              >
                <Keyboard size={14} strokeWidth={2.4} /> {t('qr_scan_type_instead')}
              </button>
            )}
          </div>
        )}
      </div>

      <div className="shrink-0 px-6 pt-4 pb-[calc(1.25rem+env(safe-area-inset-bottom))] text-center">
        {wrongCode ? (
          <p className="text-[12.5px] text-accent-600 font-semibold leading-relaxed">
            {t('qr_scan_wrong_code')}
          </p>
        ) : (
          <p className="text-[12.5px] text-white/70 leading-relaxed flex items-center justify-center gap-2">
            <ScanLine size={14} strokeWidth={2.4} className="shrink-0 text-glyph-violet" />
            {phase === 'starting' ? t('qr_scan_starting') : t('qr_scan_hint')}
          </p>
        )}
        {typeInstead && phase === 'scanning' && (
          <button
            type="button"
            onClick={typeInstead}
            className="mt-3 text-[12px] font-semibold text-white/80 underline underline-offset-4 min-h-[44px]"
          >
            {t('qr_scan_type_instead')}
          </button>
        )}
      </div>
    </div>
  );
}
