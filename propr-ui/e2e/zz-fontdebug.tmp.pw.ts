import { test, type Route } from '@playwright/test';
import { readFileSync } from 'node:fs';
const INTER = readFileSync(new URL('./fonts/inter-var-latin.woff2', import.meta.url));
const URL1 = 'https://fonts.gstatic.com/s/inter/e2e-fixture/inter-var-latin.woff2';
const CSS = `@font-face { font-family: 'Inter'; font-weight: 400 700; font-display: swap; src: url(${URL1}) format('woff2'); }`;
test.use({ viewport: { width: 320, height: 844 }, isMobile: true, hasTouch: true });
test('debug', async ({ page }) => {
  const t0 = Date.now(); const log = (...a: unknown[]) => console.log(Date.now() - t0, ...a);
  page.on('request', r => r.url().includes('font') && log('request', r.url()));
  page.on('requestfailed', r => log('failed', r.url(), r.failure()?.errorText));
  page.on('console', m => log('console', m.text()));
  await page.route('https://fonts.googleapis.com/**', route => route.fulfill({ contentType: 'text/css', body: CSS }));
  const held: Route[] = [];
  await page.route('https://fonts.gstatic.com/**', route => { log('held'); held.push(route); });
  await page.route('**/api/**', r => r.fulfill({ status: 503, json: {} }));
  await page.goto('/repositories', { waitUntil: 'commit' });
  for (let i = 0; i < 20; i++) {
    log(await page.evaluate(() => [document.readyState, ...[...document.fonts].map(f => `${f.family}:${f.status}`)].join(' ')).catch(e => String(e)));
    await page.waitForTimeout(250);
  }
  await Promise.all(held.map(r => r.fulfill({ contentType: 'font/woff2', headers: { 'access-control-allow-origin': '*' }, body: INTER })));
  await page.waitForTimeout(500);
  log(await page.evaluate(() => [...document.fonts].map(f => `${f.family}:${f.status}`).join(' ')));
});
