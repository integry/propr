import { expect, test, type Page } from '@playwright/test';

const timestamp = '2026-08-25T00:00:00.000Z';
const notificationPreferences = {
  preferences: Object.fromEntries([
    'plan',
    'task',
    'review',
    'pull_request',
    'indexing',
    'system_failure',
  ].map(kind => [kind, {
    inboxEnabled: true,
    pushEnabled: false,
    updatedAt: timestamp,
  }])),
  quietHours: { start: null, end: null, timezone: 'UTC' },
  badgeEnabled: true,
};

async function stubBrowserSmokeApis(page: Page): Promise<void> {
  await page.route('**/api/**', async route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/api/auth/demo-mode') {
      await route.fulfill({ json: { demoMode: true } });
      return;
    }
    if (pathname === '/api/notifications/unread-count') {
      await route.fulfill({ json: { unreadCount: 3 } });
      return;
    }
    if (pathname === '/api/notifications/preferences') {
      await route.fulfill({ json: notificationPreferences });
      return;
    }
    if (pathname === '/api/notifications') {
      await route.fulfill({
        json: { notifications: [], unreadCount: 3, nextCursor: null },
      });
      return;
    }
    // Layout status widgets recover from unavailable optional APIs. Keeping the
    // remainder local and explicit makes this smoke independent of a backend,
    // credentials, VAPID keys, Redis, and external push providers.
    await route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'Unavailable in browser smoke test' }),
    });
  });
}

test('publishes complete install metadata and reachable icons', async ({ page, request }) => {
  await stubBrowserSmokeApis(page);
  await page.goto('/login');

  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute('href', '/manifest.webmanifest');
  await expect(page.locator('meta[name="viewport"]')).toHaveAttribute(
    'content',
    'width=device-width, initial-scale=1.0, viewport-fit=cover',
  );
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute('content', '#1D8A8A');
  await expect(page.locator('meta[name="apple-mobile-web-app-capable"]')).toHaveAttribute('content', 'yes');

  const manifestResponse = await request.get('/manifest.webmanifest');
  expect(manifestResponse.ok()).toBe(true);
  const manifest = await manifestResponse.json();
  expect(manifest).toMatchObject({
    id: '/',
    name: 'ProPR',
    short_name: 'ProPR',
    start_url: '/',
    scope: '/',
    display: 'standalone',
  });
  expect(manifest.icons).toEqual(expect.arrayContaining([
    expect.objectContaining({ sizes: '192x192', purpose: 'any' }),
    expect.objectContaining({ sizes: '512x512', purpose: 'any' }),
    expect.objectContaining({ sizes: '512x512', purpose: 'maskable' }),
  ]));
  for (const icon of manifest.icons as Array<{ src: string }>) {
    const iconResponse = await request.get(icon.src);
    expect(iconResponse.ok(), `${icon.src} should be reachable`).toBe(true);
    expect(iconResponse.headers()['content-type']).toContain('image/png');
  }
});

for (const width of [320, 390]) {
  test(`keeps primary navigation and Inbox content usable at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 720 });
    await stubBrowserSmokeApis(page);
    await page.goto('/inbox');

    const mobileNavigation = page.getByRole('navigation', { name: 'Primary navigation' });
    await expect(mobileNavigation).toBeVisible();
    await expect(page.locator('header')).toBeHidden();
    await expect(mobileNavigation.getByRole('link', { name: /Inbox/ })).toBeVisible();
    await expect(mobileNavigation.getByRole('link', { name: 'Activity' })).toBeVisible();
    await expect(mobileNavigation.getByRole('button', { name: 'New Plan' })).toBeVisible();
    await expect(mobileNavigation.getByRole('link', { name: 'Repositories' })).toBeVisible();
    await expect(mobileNavigation.getByRole('button', { name: 'More' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Inbox' })).toBeVisible();

    const dimensions = await page.evaluate(() => ({
      viewportWidth: window.innerWidth,
      documentWidth: document.documentElement.scrollWidth,
    }));
    expect(dimensions.documentWidth).toBeLessThanOrEqual(dimensions.viewportWidth);
  });
}

test('restores desktop navigation above the mobile breakpoint', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await stubBrowserSmokeApis(page);
  await page.goto('/inbox');

  await expect(page.getByRole('navigation', { name: 'Primary navigation' })).toBeHidden();
  await expect(page.locator('header')).toBeVisible();
  await expect(page.locator('aside').getByRole('link', { name: 'Inbox' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Inbox' })).toBeVisible();
});
