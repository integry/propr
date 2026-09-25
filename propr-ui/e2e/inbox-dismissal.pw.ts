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

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const pullRequestLink = (prNumber: number) => ({
  type: 'external_link', label: 'Open pull request', href: `https://github.com/integry/propr/pull/${prNumber}`,
});
function triageItem(id: string, minutes: number, fields: Record<string, unknown>) {
  const occurredAt = minutesAgo(minutes);
  return {
    id, deduplicationKey: id, severity: 'success', actions: ['follow_up', 'open_pr', 'dismiss'],
    occurredAt, createdAt: occurredAt, readAt: null, dismissedAt: null, ...fields,
  };
}

// Rows with zero, one and two commands, generated titles and a clean review.
const triageNotifications = [
  triageItem('ready-2498', 6, {
    kind: 'pull_request', severity: 'info',
    target: { type: 'pull_request', repository: 'integry/propr', prNumber: 2498 },
    metadata: { completedImplementationTaskId: 'task-2498' },
    previewMedia: [{
      title: 'Inbox rows', description: 'The denser Inbox list.', type: 'image',
      url: 'https://github.com/user-attachments/assets/inbox-rows',
    }],
    title: 'PR #2498 ready for review',
    body: 'Review deferred until the continuation pull request passes its exact-head checks.',
    action: pullRequestLink(2498),
  }),
  triageItem('review-2511', 14, {
    kind: 'review', target: { type: 'review', repository: 'integry/propr', prNumber: 2511, taskId: 'task-2511' },
    title: '[Epic] MCP Operator Surface: Activity, Control And Observability',
    body: 'Score 6/10 · 2 issues found: Check the head SHA before posting; Guard the empty activity page',
    action: pullRequestLink(2511),
  }),
  triageItem('review-2519', 32, {
    kind: 'review', target: { type: 'review', repository: 'integry/propr', prNumber: 2519, taskId: 'task-2519' },
    title: 'Retry webhook deliveries that time out',
    body: 'Score 3/10 · 4 issues found: Retries never back off; Delivery ids are reused',
    action: pullRequestLink(2519), readAt: minutesAgo(20),
  }),
  triageItem('review-2528', 47, {
    kind: 'review', target: { type: 'review', repository: 'integry/propr', prNumber: 2528, taskId: 'task-2528' },
    title: 'Dashboard cleanup: remove unused widgets and tighten spacing',
    body: 'Score 9/10 · 0 issues found',
    action: pullRequestLink(2528),
  }),
  triageItem('merge-2490', 95, {
    kind: 'pull_request', severity: 'info',
    target: { type: 'pull_request', repository: 'integry/propr', prNumber: 2490 },
    metadata: { completionType: 'merge' },
    title: 'Merge completed for PR #2490',
    body: 'Merged main into 2490/inbox-density cleanly.',
    actions: ['open_pr', 'dismiss'], action: pullRequestLink(2490), readAt: minutesAgo(60),
  }),
];

async function stubInbox(page: Page, items: readonly unknown[] = notifications): Promise<void> {
  await page.routeWebSocket('**/socket.io/**', socket => socket.close());
  await page.route('https://github.com/user-attachments/assets/**', route => previewImage
    ? route.fulfill({ contentType: 'image/png', body: previewImage }) : route.abort());
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    const dismissMatch = path.match(/^\/api\/notifications\/([^/]+)\/dismiss$/);
    if (dismissMatch) {
      const notification = (items as typeof notifications).find(item => item.id === decodeURIComponent(dismissMatch[1]))!;
      return route.fulfill({ json: {
        notification: { ...notification, dismissedAt: '2026-09-16T20:01:00.000Z' },
        unreadCount: 1,
      } });
    }
    const responses: Record<string, unknown> = {
      '/api/auth/demo-mode': { demoMode: false },
      '/api/auth/user': user,
      '/api/notifications': { notifications: items, unreadCount: 2, nextCursor: null },
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

let previewImage: Buffer | undefined;

/** Opens the triage Inbox, using a real screenshot of it as the published preview image. */
async function openTriageInbox(page: Page): Promise<void> {
  await stubInbox(page, triageNotifications);
  await page.goto('/inbox');
  await expect(page.getByRole('article')).toHaveCount(triageNotifications.length);
  previewImage ??= await page.screenshot();
  await page.reload();
  await expect(page.getByRole('img', { name: 'Inbox rows', exact: true })).toBeVisible();
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
    // Status, title and summary lines with the commands in the right rail, not a card per item.
    expect((await article.boundingBox())!.height).toBeLessThanOrEqual(80);
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

test('desktop rows stack title over summary and end their text on one rail whatever the commands', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openTriageInbox(page);
  const ready = page.getByRole('article', { name: 'PR #2498 ready for review' });
  await expect(ready.getByRole('heading', { level: 3 })).toHaveText('Ready for review');
  await expect(ready.getByTitle('Pull request #2498')).toHaveText('PR #2498');
  await expect(ready.getByRole('button')).toHaveText(['/review', '/ultrafix', '']);
  // The widest rail (thumbnail and two commands) still clears the dismiss button.
  await expect(ready.getByRole('group', { name: 'Published visual previews' })).toBeVisible();
  const ultrafix = (await ready.getByRole('button', { name: /ultrafix/ }).boundingBox())!;
  const readyDismiss = (await ready.getByRole('button', { name: /^Dismiss/ }).boundingBox())!;
  expect(ultrafix.x + ultrafix.width).toBeLessThanOrEqual(readyDismiss.x);

  const clean = page.getByRole('article', { name: /^Dashboard cleanup/ });
  await expect(clean.getByRole('button')).toHaveText(['']);
  await expect(page.getByRole('article', { name: /^\[Epic\]/ }).getByRole('button')).toHaveText(['/fix', '']);

  const articles = await page.getByRole('article').all();
  expect(articles).toHaveLength(5);
  const edges = new Set<number>();
  for (const article of articles) {
    const title = (await article.getByRole('heading', { level: 3 }).boundingBox())!;
    const summary = (await article.locator('p').boundingBox())!;
    const time = (await article.locator('time').boundingBox())!;
    // The summary sits on its own line under the title, not after it.
    expect(summary.y).toBeGreaterThanOrEqual(title.y + title.height - 1);
    edges.add(Math.round(time.x + time.width));
    expect((await article.boundingBox())!.height).toBeLessThanOrEqual(80);
  }
  expect([...edges]).toHaveLength(1);

  const dismiss = clean.getByRole('button', { name: /^Dismiss/ });
  const dismissBox = (await dismiss.boundingBox())!;
  expect(dismissBox.width).toBe(24);
  await expect(page.getByRole('button', { name: 'Clear all' })).toHaveCSS('border-top-width', '1px');
  await capture(page, 'inbox-rail-desktop.png');
});

test('phones keep status and time on line one, wrap titles, and give dismiss a 44px target', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openTriageInbox(page);
  const epic = page.getByRole('article', { name: /^\[Epic\]/ });
  await expect(epic.getByRole('heading', { level: 3 })).toBeVisible();

  const status = (await epic.getByRole('img').boundingBox())!;
  const time = (await epic.locator('time').boundingBox())!;
  const chip = (await epic.getByTitle('Pull request #2511').boundingBox())!;
  const fix = (await epic.getByRole('button', { name: 'Send /fix to PR #2511' }).boundingBox())!;
  const dismiss = (await epic.getByRole('button', { name: /^Dismiss/ }).boundingBox())!;
  expect(Math.abs(time.y + time.height / 2 - (status.y + status.height / 2))).toBeLessThan(3);
  // The PR chip and repository share the command line instead of squeezing line one.
  expect(chip.y).toBeGreaterThan(time.y + 30);
  expect(Math.abs(chip.y + chip.height / 2 - (fix.y + fix.height / 2))).toBeLessThan(3);
  await expect(epic.getByTitle('integry/propr')).toHaveText('propr', { useInnerText: true });
  // A thumbnail and two commands don't fit beside the chip, so they wrap rather than truncate the name.
  const ready = page.getByRole('article', { name: 'PR #2498 ready for review' });
  const readyRepository = ready.getByTitle('integry/propr');
  expect(await readyRepository.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  expect((await ready.getByRole('button', { name: /ultrafix/ }).boundingBox())!.y)
    .toBeGreaterThan((await readyRepository.boundingBox())!.y + 20);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(fix.height).toBeGreaterThanOrEqual(40);
  expect(dismiss.width).toBeGreaterThanOrEqual(44);
  expect(dismiss.height).toBeGreaterThanOrEqual(44);
  expect(dismiss.x + dismiss.width / 2 - 8 - (time.x + time.width)).toBeGreaterThanOrEqual(12);

  // The long title wraps to a second line rather than cutting off after a few words.
  const titleBox = (await epic.getByRole('heading', { level: 3 }).boundingBox())!;
  expect(titleBox.height).toBeGreaterThan(30);
  await expect(page.getByRole('article', { name: /^Dashboard cleanup/ }).getByRole('button', { name: /^Send/ }))
    .toHaveCount(0);
  await capture(page, 'inbox-triage-mobile.png');
});
