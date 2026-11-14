import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.pw.ts',
  // Spec files run side by side, one worker each; tests inside a file stay in
  // order unless the file opts in with `test.describe.configure`. One worker
  // by default; CI sets PROPR_BROWSER_TEST_WORKERS to the runner's CPU count.
  fullyParallel: false,
  workers: Math.max(1, Number.parseInt(process.env.PROPR_BROWSER_TEST_WORKERS ?? '', 10) || 1),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: 'http://127.0.0.1:4173',
    browserName: 'chromium',
    serviceWorkers: 'block',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npm run build && npm run preview -- --host 127.0.0.1 --port 4173 --strictPort',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
