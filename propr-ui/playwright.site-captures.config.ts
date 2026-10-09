import { defineConfig } from '@playwright/test';

/**
 * Marketing-site screenshots rendered from the real UI against mock data.
 * Not part of the test suite: run with `npm run site-captures -w propr-ui`.
 * See e2e/site-captures/README.md.
 */
export default defineConfig({
  testDir: './e2e/site-captures/shots',
  testMatch: '**/*.capture.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'list',
  outputDir: process.env.SITE_CAPTURES_RESULTS ?? 'test-results/site-captures',
  globalTeardown: './e2e/site-captures/lib/contactSheet.ts',
  use: {
    baseURL: 'http://127.0.0.1:4173',
    browserName: 'chromium',
    serviceWorkers: 'block',
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    colorScheme: 'light',
    locale: 'en-US',
    timezoneId: 'UTC',
    contextOptions: { reducedMotion: 'reduce' },
    launchOptions: process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {},
  },
  webServer: {
    command: 'npm run build && npm run preview -- --host 127.0.0.1 --port 4173 --strictPort',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: true,
    timeout: 180_000,
  },
});
