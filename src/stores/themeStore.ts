import { create } from 'zustand';

// Appearance preference. Device-scoped (like language) — NOT cleared on logout,
// and persisted to localStorage under hisaab_theme. The actual `.dark` class is
// applied to <html>. public/theme-boot.js (a blocking <script src> in
// index.html — an inline script would be refused by the CSP's script-src
// 'self') applies it before first paint so there is no light flash, and this
// store keeps it in sync afterwards. The two must agree on DEFAULT_THEME.
export type ThemeMode = 'light' | 'dark' | 'system';

const KEY = 'hisaab_theme';

/** What a device with NO stored choice gets. The 1d redesign (2026-09-18) is
 *  dark-first; flip this one constant (and the mirror in public/theme-boot.js)
 *  to revert. Any explicit Light/Dark/System pick is stored and always wins. */
export const DEFAULT_THEME: ThemeMode = 'dark';

function systemPrefersDark(): boolean {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-color-scheme: dark)').matches;
}

export function resolveIsDark(mode: ThemeMode): boolean {
  return mode === 'dark' || (mode === 'system' && systemPrefersDark());
}

function applyThemeClass(mode: ThemeMode): void {
  if (typeof document === 'undefined') return;
  document.documentElement.classList.toggle('dark', resolveIsDark(mode));
}

function readStoredMode(): ThemeMode {
  const raw = (typeof localStorage !== 'undefined' && localStorage.getItem(KEY)) as ThemeMode | null;
  return raw === 'light' || raw === 'dark' || raw === 'system' ? raw : DEFAULT_THEME;
}

interface ThemeState {
  mode: ThemeMode;
  setMode: (mode: ThemeMode) => void;
}

export const useThemeStore = create<ThemeState>((set) => ({
  mode: readStoredMode(),
  setMode: (mode) => {
    try { localStorage.setItem(KEY, mode); } catch { /* storage disabled — class still applies */ }
    applyThemeClass(mode);
    set({ mode });
  },
}));

// Call once at boot. Applies the current preference and, while on "system",
// follows OS changes live.
export function initTheme(): void {
  const mode = useThemeStore.getState().mode;
  applyThemeClass(mode);
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if (useThemeStore.getState().mode === 'system') applyThemeClass('system');
    });
  }
}
