import type { CapacitorConfig } from '@capacitor/cli';

// Capacitor configuration for the Hisaab Android wrapper.
// - `webDir` points at the Vite build output; `npx cap sync` copies that into
//   the Android assets folder.
// - `androidScheme` is `https` so the WebView treats the bundled app as a
//   secure origin (required for service worker, crypto.subtle, etc.).
// - Plugin defaults are tuned for a navy/cream finance app aesthetic.
const config: CapacitorConfig = {
  appId: 'com.usehisaab.app',
  appName: 'Hisaab',
  webDir: 'dist',
  // WebView ground before the first paint — the 1d hero base, so a cold
  // start never flashes white between the splash and the app (either theme
  // opens on the dark hero).
  backgroundColor: '#0A0A14',
  server: {
    // Required so the app loads at https://localhost rather than http://,
    // which keeps SW + cross-origin cookies working consistently with PWA.
    androidScheme: 'https',
  },
  android: {
    // App-internal links route through Hisaab's WebView. Disable to fall back
    // to a system browser for any non-app URL.
    allowMixedContent: false,
    captureInput: true,
    webContentsDebuggingEnabled: false,
  },
  plugins: {
    StatusBar: {
      // The 1d hero base (dark in both themes — every screen opens on the
      // hero), so light status-bar icons are right in either theme.
      backgroundColor: '#0A0A14',
      style: 'DARK',
      overlaysWebView: false,
    },
    SplashScreen: {
      launchShowDuration: 600,
      launchAutoHide: true,
      backgroundColor: '#0A0A14',
      androidScaleType: 'CENTER_CROP',
      showSpinner: false,
      splashFullScreen: true,
      splashImmersive: true,
    },
    Keyboard: {
      resize: 'native',
      resizeOnFullScreen: true,
    },
    LocalNotifications: {
      // White-on-transparent status-bar glyph (res/drawable/ic_stat_hisaab)
      // — without it Android falls back to a grey launcher-icon square.
      smallIcon: 'ic_stat_hisaab',
      iconColor: '#0B0E2A',
    },
  },
};

export default config;
