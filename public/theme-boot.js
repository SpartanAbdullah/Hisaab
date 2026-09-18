// Pre-paint theme class. Runs synchronously in <head>, before the bundle, so
// the first frame is already in the right theme (no light flash on a dark
// device). Must agree with src/stores/themeStore.ts — including its
// DEFAULT_THEME ('dark' since the 1d redesign, 2026-09-18).
(function () {
  var mode = 'dark';
  try {
    var stored = localStorage.getItem('hisaab_theme');
    if (stored === 'light' || stored === 'dark' || stored === 'system') mode = stored;
  } catch (e) { /* storage blocked — fall back to the default */ }
  var dark = mode === 'dark' ||
    (mode === 'system' && !!window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  if (dark) document.documentElement.classList.add('dark');
})();
