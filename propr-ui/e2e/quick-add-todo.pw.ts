import { expect, test, type Locator, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

async function fixture(page: Page) {
  const submissions: unknown[] = [];
  await page.routeWebSocket('**/socket.io/**', socket => socket.close());
  await page.route('**/api/**', async route => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (pathname === '/api/repos/todos' && request.method() === 'POST') {
      const body = request.postDataJSON();
      submissions.push(body);
      return route.fulfill({ json: { ...body, todoId: `todo-${submissions.length}` } });
    }
    const responses: Record<string, unknown> = {
      '/api/auth/demo-mode': { demoMode: false },
      '/api/auth/user': { id: 'preview-user', login: 'operator', username: 'operator', displayName: 'Operator', email: null, avatarUrl: null, role: 'member', permissions: [], authorizationSource: 'local' },
      '/api/instance/catalog': { repositories: [
        { id: 'alpha', name: 'acme/alpha', enabled: true },
        { id: 'billing', name: 'acme/billing', enabled: true },
      ], agents: [] },
      '/api/repositories/indexing-status': { repositories: [] },
      '/api/user/repo-preferences': { preferences: {} },
      '/api/repos/todos/categories': { categories: [{ categoryId: 'bugs', name: 'Bugs', orderIndex: 0 }] },
      '/api/notifications': { notifications: [], unreadCount: 0, nextCursor: null },
      '/api/notifications/unread-count': { unreadCount: 0 },
      '/api/notifications/config': { push: { configured: false, vapidPublicKey: null } },
      '/api/notifications/preferences': { preferences: {}, quietHours: {}, badgeEnabled: false },
    };
    return route.fulfill(pathname in responses
      ? { json: responses[pathname] }
      : { status: 503, json: { error: 'Optional endpoint unavailable in to-do browser test' } });
  });
  return submissions;
}

async function screenshot(panel: Locator, name: string) {
  if (!process.env.PROPR_CAPTURE_PREVIEWS) return;
  await mkdir('../.propr/previews', { recursive: true });
  await panel.screenshot({ path: `../.propr/previews/${name}.png`, animations: 'disabled' });
}

for (const [device, viewport] of Object.entries({
  desktop: { width: 1440, height: 900 },
  mobile: { width: 390, height: 844 },
  'mobile-small': { width: 320, height: 720 },
})) {
  test.describe(device, () => {
    test.use({ viewport, isMobile: device !== 'desktop', hasTouch: device !== 'desktop' });

    test('adds another blank to-do in the same repository', async ({ page }) => {
      const submissions = await fixture(page);
      await page.goto('/inbox');
      if (device !== 'desktop') await page.getByRole('button', { name: 'More', exact: true }).click();
      const trigger = page.getByRole('button', { name: 'Quick add to-do' }).filter({ visible: true });
      await trigger.click();
      const panel = trigger.locator('..').locator(':scope > div');
      await panel.getByRole('button', { name: 'acme/alpha' }).click();
      await panel.getByRole('button', { name: 'acme/billing' }).click();
      await panel.getByRole('textbox').fill('Fix invoice dates\nUse the account locale.');
      await panel.getByRole('button', { name: 'Uncategorized' }).click();
      await panel.getByRole('button', { name: 'Bugs' }).click();
      await panel.getByRole('button', { name: 'Add To-Do' }).click();
      await expect(panel.getByText('To-Do added')).toBeVisible();
      const addAnother = panel.getByRole('button', { name: 'Add another' });
      await expect(addAnother).toBeInViewport();
      await screenshot(panel, `todo-success-${device}`);
      await addAnother.click();
      await expect(panel.getByRole('textbox')).toBeEmpty();
      await expect(panel.getByRole('textbox')).toBeFocused();
      await expect(panel.getByRole('button', { name: 'acme/billing' })).toBeEnabled();
      await expect(panel.getByRole('button', { name: 'Uncategorized' })).toBeVisible();
      await expect(panel.getByRole('button', { name: 'Add To-Do' })).toBeDisabled();
      await screenshot(panel, `todo-another-${device}`);
      const bounds = await panel.boundingBox();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width);
      await panel.getByRole('textbox').fill('Another idea');
      await panel.getByRole('button', { name: 'Add To-Do' }).click();
      await expect(panel.getByText('To-Do added')).toBeVisible();
      expect(submissions).toEqual([
        { repository: 'acme/billing', content: 'Fix invoice dates\nUse the account locale.', categoryId: 'bugs' },
        { repository: 'acme/billing', content: 'Another idea', categoryId: null },
      ]);
    });
  });
}
