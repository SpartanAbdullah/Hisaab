import { test } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AUTH_STATE_PATH, hasCreds, SKIP_NO_CREDS_REASON } from './env';
import { I18N } from './i18n-strings';
import { gotoAppShell, openQuickEntry } from './helpers';

// Founder-approval previews — NOT a test. Captures the screens a design change
// touches, in BOTH themes, at the two project viewports (mobile 390×844 and
// the desktop project's default), so the founder rule from 2026-09-03
// ("screenshots for approval BEFORE shipping any design change") is one
// command instead of a hand-driven phone session:
//
//   $env:E2E_PREVIEWS='1'; $env:E2E_EMAIL='<staging account>'; $env:E2E_PASSWORD='<pw>'
//   npx playwright test e2e/founder-previews.spec.ts
//
// Output: test-results/previews/<screen>-<theme>-<project>.png (gitignored).
//
// Doubly gated: it self-skips without E2E_PREVIEWS=1 so the CI e2e job never
// spends time on it, and without staging credentials like every other
// authenticated spec (docs/staging-environment.md — never production).
//
// Theme is device-scoped (src/stores/themeStore.ts: localStorage
// `hisaab_theme`, read at module evaluation), so an init script that seeds the
// key before any app code runs is enough to boot straight into dark mode.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENABLED = process.env.E2E_PREVIEWS === '1';
const OUT_DIR = path.join(__dirname, '..', 'test-results', 'previews');
const THEMES = ['light', 'dark'] as const;

test.describe('founder previews (light + dark)', () => {
  test.skip(!ENABLED, 'Set E2E_PREVIEWS=1 to capture founder-approval screenshots (not a test).');
  test.skip(!hasCreds, SKIP_NO_CREDS_REASON);
  test.use({ storageState: AUTH_STATE_PATH, contextOptions: { reducedMotion: 'reduce' } });

  for (const theme of THEMES) {
    test(`capture · ${theme}`, async ({ page }, testInfo) => {
      test.setTimeout(180_000);
      const project = testInfo.project.name;
      if (project === 'mobile') await page.setViewportSize({ width: 390, height: 844 });

      await page.addInitScript((mode: string) => {
        try { localStorage.setItem('hisaab_theme', mode); } catch { /* storage off */ }
      }, theme);
      mkdirSync(OUT_DIR, { recursive: true });

      const settle = async () => {
        await page.waitForLoadState('networkidle').catch(() => {});
        await page.waitForTimeout(700);
      };
      const shot = async (name: string, opts: { fullPage?: boolean } = {}) => {
        await settle();
        await page.screenshot({
          path: path.join(OUT_DIR, `${name}-${theme}-${project}.png`),
          fullPage: opts.fullPage ?? true,
        });
      };

      // Home + the Quick Entry intent list (F7 order, F9 tiles).
      await gotoAppShell(page);
      await shot('home');
      await openQuickEntry(page);
      await page
        .getByText(I18N.qe_title_what_happened.ur)
        .or(page.getByText(I18N.qe_title_what_happened.en))
        .first()
        .waitFor({ timeout: 10_000 })
        .catch(() => {});
      // Modal bodies scroll internally — a viewport shot is the honest frame.
      await shot('quick-entry-intents', { fullPage: false });

      // Settings (F1 grouping, F2 phone fields, F3/F4 defaults, F5 phone block, F9 toggles/segments/inputs).
      await page.goto('/settings');
      await shot('settings');

      // Inbox (F10) — whichever tab the smart landing picks.
      await page.goto('/inbox');
      await shot('inbox');

      // Groups list + the Create Group modal (F8 member form, F9 fields).
      await page.goto('/groups');
      await shot('groups');
      const createGroup = page
        .getByRole('button', { name: I18N.a11y_create_group.ur })
        .or(page.getByRole('button', { name: I18N.a11y_create_group.en }));
      if (await createGroup.first().isVisible().catch(() => false)) {
        await createGroup.first().click();
        await shot('create-group', { fullPage: false });
      }

      // Contacts + the add-contact form (F6 discovery badge, F9 fields).
      await page.goto('/contacts');
      await shot('contacts');
      const addContact = page
        .getByRole('button', { name: I18N.cts_a11y_add.ur })
        .or(page.getByRole('button', { name: I18N.cts_a11y_add.en }));
      if (await addContact.first().isVisible().catch(() => false)) {
        await addContact.first().click();
        await shot('contacts-add', { fullPage: false });
      }
    });
  }
});
