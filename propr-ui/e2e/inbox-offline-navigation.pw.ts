import { expect, test, type Page } from '@playwright/test';
import { mkdir, readdir } from 'node:fs/promises';

const user = {
  id: 'inbox-offline-user', login: 'operator', username: 'operator',
  displayName: 'Inbox operator', email: null, avatarUrl: null, role: 'admin',
  permissions: ['instance.manage_settings'], authorizationSource: 'local',
};

const notification = {
  id: 'review-90', deduplicationKey: 'review-90', kind: 'review', severity: 'success',
  target: { type: 'review', repository: 'integry/propr', prNumber: 90, taskId: 'review-task-90' },
  title: 'Recover the Inbox after reconnecting',
  body: 'Score 9/10 · 0 issues found',
  actions: ['follow_up', 'open_pr', 'dismiss'],
  occurredAt: '2026-10-06T11:00:00.000Z', createdAt: '2026-10-06T11:00:00.000Z',
  readAt: null, dismissedAt: null,
};

/** Fixture API; returns the list of notification-list reads the Inbox started. */
async function stubApi(page: Page): Promise<string[]> {
  const listReads: string[] = [];
  page.on('request', request => {
    if (new URL(request.url()).pathname === '/api/notifications') listReads.push(request.url());
  });
  await page.routeWebSocket('**/socket.io/**', socket => socket.close());
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname;
    const responses: Record<string, unknown> = {
      '/api/auth/demo-mode': { demoMode: false },
      '/api/auth/user': user,
      '/api/notifications': { notifications: [notification], unreadCount: 1, nextCursor: null },
      '/api/notifications/unread-count': { unreadCount: 1 },
      '/api/notifications/config': { push: { configured: false, vapidPublicKey: null } },
      '/api/notifications/preferences': {
        preferences: {}, quietHours: { start: null, end: null, timezone: 'UTC' }, badgeEnabled: false,
      },
      '/api/instance/catalog': { repositories: [], agents: [] },
      '/api/tasks': { tasks: [], total: 0 },
      '/api/status': { status: 'ok' },
    };
    return route.fulfill(path in responses
      ? { json: responses[path] }
      : { status: 503, json: { error: 'Optional API unavailable in Inbox offline fixture' } });
  });
  return listReads;
}

/**
 * Loads the built Inbox route chunk the way an earlier visit or the browser
 * cache would, so the offline navigation exercises the Inbox state rather
 * than a route chunk that cannot be fetched offline.
 */
async function warmInboxChunk(page: Page): Promise<void> {
  const chunk = (await readdir('dist/assets')).find(name => /^InboxPage-[\w-]+\.js$/.test(name));
  expect(chunk, 'built Inbox route chunk').toBeDefined();
  await page.evaluate(async url => { await import(url); }, `/assets/${chunk}`);
}

async function capture(page: Page, name: string): Promise<void> {
  if (!process.env.PROPR_CAPTURE_PREVIEWS) return;
  await mkdir('../.propr/previews', { recursive: true });
  await page.screenshot({ animations: 'disabled', path: `../.propr/previews/${name}` });
}

test.use({ viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true });

test('first Inbox navigation while offline shows the offline state and loads once reconnected', async ({ page, context }) => {
  const listReads = await stubApi(page);
  await page.goto('/');
  const primaryNavigation = page.getByRole('navigation', { name: 'Primary navigation' });
  const inboxLink = primaryNavigation.getByRole('link', { name: /^Inbox/ });
  await expect(inboxLink).toBeVisible();
  await warmInboxChunk(page);
  // Distinguishes client-side navigation from a document reload.
  await page.evaluate(() => { document.documentElement.dataset.navigationTest = 'preserved'; });

  await context.setOffline(true);
  expect(await page.evaluate(() => navigator.onLine)).toBe(false);
  await inboxLink.tap();

  await expect(page).toHaveURL(/\/inbox$/);
  await expect(page.getByRole('heading', { name: 'Inbox unavailable offline' })).toBeVisible();
  await expect(page.getByText('Reconnect to see your latest notifications.')).toBeVisible();
  await expect(page.getByTestId('inbox-skeleton')).toHaveCount(0);
  await expect(page.getByText('You’re all caught up')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.dataset.navigationTest)).toBe('preserved');
  expect(listReads).toHaveLength(0);
  await capture(page, 'inbox-offline-first-visit-mobile.png');

  await context.setOffline(false);
  await expect(page.getByRole('article', { name: notification.title })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Inbox unavailable offline' })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.dataset.navigationTest)).toBe('preserved');
  // One guarded read on reconnect, not one per trigger.
  await page.waitForTimeout(500);
  expect(listReads).toHaveLength(1);
  await capture(page, 'inbox-offline-reconnected-mobile.png');

  // A later offline interval keeps what was loaded instead of blanking the Inbox.
  await context.setOffline(true);
  await expect(page.getByText('You’re offline. Showing the notifications already loaded.')).toBeVisible();
  await expect(page.getByRole('article', { name: notification.title })).toBeVisible();
});
