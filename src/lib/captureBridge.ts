// JS ↔ Android "HisaabCapture" plugin (android/.../capture/HisaabCapturePlugin.java).
//
// Two native sources hand bank-alert text to the web app:
//   - the share sheet — MainActivity rewrites an ACTION_SEND into the deep
//     link `https://usehisaab.com/?capture=<text>`, which nativeBridge routes
//     like every other deep link; nothing here is involved.
//   - the notification listener — it queues a candidate on the device and
//     posts a "Record this?" notification whose tap opens
//     `/?capture_id=<id>`; App.tsx then calls `takeCapture(id)` here.
//
// Everything is a no-op on web and on an older binary without the plugin, so
// callers can use it unconditionally.

import { isNativeRuntime } from './runtime';
import { tStatic } from './i18n';

export interface CaptureStatus {
  /** Android's Notification access is granted to Hisaab. */
  granted: boolean;
  /** The user switched auto-capture on in Settings (persisted natively). */
  enabled: boolean;
}

export interface CapturedCandidate {
  id: string;
  text: string;
  title: string | null;
  packageName: string | null;
  postedAt: number;
}

interface HisaabCapturePlugin {
  getStatus(): Promise<CaptureStatus>;
  setEnabled(opts: { enabled: boolean; labels: CaptureLabels }): Promise<void>;
  openSettings(): Promise<void>;
  take(opts: { id: string }): Promise<{ found: boolean; candidate?: CapturedCandidate }>;
  clear(): Promise<void>;
}

/** Localised strings for the native notification; the listener cannot reach
 *  i18n.ts, so JS hands them over whenever the toggle or the language changes. */
export interface CaptureLabels {
  title: string;
  body: string;
}

let plugin: HisaabCapturePlugin | null = null;

async function load(): Promise<HisaabCapturePlugin | null> {
  if (!isNativeRuntime()) return null;
  if (plugin) return plugin;
  try {
    const { registerPlugin } = await import('@capacitor/core');
    plugin = registerPlugin<HisaabCapturePlugin>('HisaabCapture');
    return plugin;
  } catch {
    return null;
  }
}

export function captureLabels(): CaptureLabels {
  return { title: tStatic('capture_notif_title'), body: tStatic('capture_notif_body') };
}

export async function getCaptureStatus(): Promise<CaptureStatus> {
  const p = await load();
  if (!p) return { granted: false, enabled: false };
  try {
    return await p.getStatus();
  } catch {
    return { granted: false, enabled: false };
  }
}

export async function setCaptureEnabled(enabled: boolean): Promise<void> {
  const p = await load();
  if (!p) return;
  try {
    await p.setEnabled({ enabled, labels: captureLabels() });
  } catch {
    // Older binary — the toggle simply has no effect there.
  }
}

/** Language change: re-send the notification text while capture is on. */
export async function refreshCaptureLabels(): Promise<void> {
  const status = await getCaptureStatus();
  if (status.enabled) await setCaptureEnabled(true);
}

/** Opens Android's Notification-access page (the Hisaab row when the OS
 *  supports deep-linking to it). */
export async function openCaptureSettings(): Promise<void> {
  const p = await load();
  if (!p) return;
  try {
    await p.openSettings();
  } catch {
    // Nothing to do on an older binary.
  }
}

/** Removes and returns the queued candidate, or null when it is gone (already
 *  taken, expired, or a stale notification). */
export async function takeCapture(id: string): Promise<CapturedCandidate | null> {
  const p = await load();
  if (!p) return null;
  try {
    const res = await p.take({ id });
    return res.found && res.candidate ? res.candidate : null;
  } catch {
    return null;
  }
}

/** Sign-out: drop every queued alert and switch capture off, so the next
 *  account on this phone starts from nothing and must opt in itself. */
export async function teardownCapture(): Promise<void> {
  const p = await load();
  if (!p) return;
  try {
    await p.clear();
    await p.setEnabled({ enabled: false, labels: captureLabels() });
  } catch {
    // Best effort.
  }
}
