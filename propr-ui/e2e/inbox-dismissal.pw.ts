import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

const timestamp = '2026-09-16T20:00:00.000Z';
const user = {
  id: 'inbox-preview-user', login: 'operator', username: 'operator',
  displayName: 'Inbox operator', email: null, avatarUrl: null, role: 'admin',
  permissions: ['instance.manage_settings'], authorizationSource: 'local',
};

const notifications = [
  {
    id: 'review-81', deduplicationKey: 'review-81', kind: 'review', severity: 'success',
    target: { type: 'review', repository: 'integry/propr', prNumber: 81, taskId: 'review-task-81' },
    title: 'Guard Inbox recaps against empty metadata',
    body: 'Score 8/10 · 2 issues found: Guard empty recap metadata; Ignore vertical touch movement',
    actions: ['follow_up', 'open_pr', 'dismiss'],
    action: { type: 'external_link', label: 'Open pull request', href: 'https://github.com/integry/propr/pull/81' },
    occurredAt: timestamp, createdAt: timestamp, readAt: null, dismissedAt: null,
  },
  {
    id: 'fix-81', deduplicationKey: 'fix-81', kind: 'pull_request', severity: 'info',
    target: { type: 'pull_request', repository: 'integry/propr', prNumber: 81 },
    metadata: { completedImplementationTaskId: 'fix-task-81', completionType: 'fix' },
    title: 'Guard Inbox recaps against empty metadata',
    body: 'Fixed 2 review findings in 3 files; tests pass.',
    actions: ['follow_up', 'open_pr', 'dismiss'],
    action: { type: 'external_link', label: 'Open pull request', href: 'https://github.com/integry/propr/pull/81' },
    occurredAt: '2026-09-16T19:55:00.000Z', createdAt: '2026-09-16T19:55:00.000Z',
    readAt: '2026-09-16T19:56:00.000Z', dismissedAt: null,
  },
  {
    id: 'plan-inbox', deduplicationKey: 'plan-inbox', kind: 'plan', severity: 'success',
    target: { type: 'plan', repository: 'integry/propr', draftId: 'draft-inbox' },
    title: 'Improve Inbox notifications',
    body: 'Ready for review with 4 planned tasks.',
    actions: ['refine', 'approve_execute', 'dismiss'],
    occurredAt: '2026-09-16T19:45:00.000Z', createdAt: '2026-09-16T19:45:00.000Z',
    readAt: null, dismissedAt: null,
  },
  {
    id: 'system-redis', deduplicationKey: 'system-redis', kind: 'system_failure', severity: 'error',
    target: { type: 'system_failure', component: 'redis' },
    title: 'System component unhealthy: redis',
    body: 'redis reported “disconnected”; administrator attention may be required.',
    actions: ['dismiss'],
    occurredAt: '2026-09-16T19:40:00.000Z', createdAt: '2026-09-16T19:40:00.000Z',
    readAt: null, dismissedAt: null,
  },
];

async function stubInbox(page: Page): Promise<void> {
  await page.routeWebSocket('**/socket.io/**', socket => socket.close());
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    const dismissMatch = path.match(/^\/api\/notifications\/([^/]+)\/dismiss$/);
    if (dismissMatch) {
      const notification = notifications.find(item => item.id === decodeURIComponent(dismissMatch[1]))!;
      return route.fulfill({ json: {
        notification: { ...notification, dismissedAt: '2026-09-16T20:01:00.000Z' },
        unreadCount: 1,
      } });
    }
    const responses: Record<string, unknown> = {
      '/api/auth/demo-mode': { demoMode: false },
      '/api/auth/user': user,
      '/api/notifications': { notifications, unreadCount: 2, nextCursor: null },
      '/api/notifications/unread-count': { unreadCount: 2 },
      '/api/notifications/config': { push: { configured: false, vapidPublicKey: null } },
      '/api/notifications/preferences': {
        preferences: {}, quietHours: { start: null, end: null, timezone: 'UTC' }, badgeEnabled: false,
      },
      '/api/instance/catalog': { repositories: [], agents: [] },
      '/api/status': { status: 'ok' },
    };
    return route.fulfill(path in responses
      ? { json: responses[path] }
      : { status: 503, json: { error: 'Optional API unavailable in Inbox fixture' } });
  });
}

async function capture(page: Page, name: string): Promise<void> {
  if (!process.env.PROPR_CAPTURE_PREVIEWS) return;
  await mkdir('../.propr/previews', { recursive: true });
  await page.screenshot({ animations: 'disabled', path: `../.propr/previews/${name}` });
}

const prTitle = 'Guard Inbox recaps against empty metadata';

test('touch swipe moves the card out without extra affordances or undo', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await stubInbox(page);
  await page.goto('/inbox');
  const card = page.getByRole('article', { name: prTitle }).first();
  await expect(card.getByText('Score 8/10 · 2 issues found', { exact: false })).toBeVisible();
  await card.scrollIntoViewIfNeeded();
  const surface = card.locator('..');
  const box = await surface.boundingBox();
  expect(box).not.toBeNull();
  await surface.dispatchEvent('pointerdown', {
    pointerId: 1, pointerType: 'touch', clientX: box!.x + 16, clientY: box!.y + 80,
  });
  await surface.dispatchEvent('pointermove', {
    pointerId: 1, pointerType: 'touch', clientX: box!.x + 150, clientY: box!.y + 82,
  });
  await expect(page.getByText('Release')).toHaveCount(0);
  await capture(page, 'inbox-swipe-mobile.png');
  await surface.dispatchEvent('pointerup', {
    pointerId: 1, pointerType: 'touch', clientX: box!.x + 150, clientY: box!.y + 82,
  });
  await expect(page.getByRole('article', { name: prTitle })).toHaveCount(1);
  await expect(page.getByText('Score 8/10 · 2 issues found', { exact: false })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Undo' })).toHaveCount(0);
});

test('desktop shows one newest-first list titled by PR, with only System collapsed apart', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await stubInbox(page);
  await page.goto('/inbox');
  await expect(page.getByText('Fixed 2 review findings in 3 files; tests pass.')).toBeVisible();
  const systemToggle = page.getByRole('button', { name: 'System 1' });
  await expect(systemToggle).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByRole('article', { name: 'System component unhealthy: redis' })).toHaveCount(0);
  await expect(page.getByRole('heading', { level: 2 })).toContainText(['System']);

  const articles = page.getByRole('article');
  await expect(articles).toHaveCount(3);
  const [review, fix, plan] = [articles.nth(0), articles.nth(1), articles.nth(2)];
  await expect(review).toHaveAccessibleName(prTitle);
  await expect(review).toContainText('Review completed');
  await expect(review.getByTitle('Pull request #81')).toHaveText('PR #81');
  await expect(review.getByRole('img', { name: 'Unread · Score 8/10 · 2 issues' })).toBeVisible();
  await expect(review.getByRole('button')).toHaveText(['/fix', '']);
  await expect(fix).toContainText('Fix completed');
  await expect(fix.getByRole('button')).toHaveText(['/review', '/ultrafix', '']);
  await expect(plan).toHaveAccessibleName('Improve Inbox notifications');
  await expect(plan.getByRole('button')).toHaveCount(1);
  for (const article of await articles.all()) {
    await expect(article).toHaveCSS('background-color', 'rgb(255, 255, 255)');
    await expect(article).toHaveCSS('border-radius', '0px');
    // Two-line rows with the commands in the right rail, not a card per item.
    expect((await article.boundingBox())!.height).toBeLessThanOrEqual(64);
  }
  await capture(page, 'inbox-cards-desktop.png');

  const dismissButton = fix.getByRole('button', { name: `Dismiss ${prTitle}` });
  await dismissButton.focus();
  await page.keyboard.press('Enter');
  await expect(articles).toHaveCount(2);
  await expect(page.getByText('Fixed 2 review findings in 3 files; tests pass.')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Undo' })).toHaveCount(0);
  await expect(page.getByText('Notification dismissed.')).toHaveCount(0);
});

test('header offers a labelled Clear all with confirmation, and System sits in a grey band below the feed', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await stubInbox(page);
  await page.goto('/inbox');
  await expect(page.getByText('Fixed 2 review findings in 3 files; tests pass.')).toBeVisible();
  await expect(page.getByRole('button', { name: /Refresh/ })).toHaveCount(0);
  const clearAll = page.getByRole('button', { name: 'Clear all' });
  await expect(clearAll).toHaveText('Clear all');
  await clearAll.click();
  await expect(page.getByRole('dialog', { name: 'Clear all notifications?' })).toBeVisible();
  await capture(page, 'inbox-clear-all-confirmation-desktop.png');
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByText(/in one place/)).toHaveCount(0);

  const systemToggle = page.getByRole('button', { name: 'System 1' });
  const lastCard = page.getByRole('article').last();
  expect((await systemToggle.boundingBox())!.y).toBeGreaterThan((await lastCard.boundingBox())!.y);
  await expect(page.locator('section[aria-labelledby="inbox-system"]')).toHaveCSS('background-color', 'rgb(248, 250, 252)');
  await systemToggle.click();
  await expect(page.getByRole('article', { name: 'System component unhealthy: redis' })).toBeVisible();
  await page.getByRole('article', { name: 'System component unhealthy: redis' }).scrollIntoViewIfNeeded();
  await capture(page, 'inbox-header-system-desktop.png');
});
