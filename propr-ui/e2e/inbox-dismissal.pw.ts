/* eslint-disable max-lines */
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

// 1280px and wider is the triage console; the single-column cases run just below it.
const singleColumnDesktop = { width: 1279, height: 800 };

test('desktop shows one newest-first list titled by PR, with only System collapsed apart', async ({ page }) => {
  await page.setViewportSize(singleColumnDesktop);
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
  // Rows carry no commands at any width: they live in the verdict and on the run in Tasks.
  await expect(review.getByRole('button')).toHaveText(['']);
  await expect(fix).toContainText('Fix completed');
  await expect(fix.getByRole('button')).toHaveText(['']);
  await expect(plan).toHaveAccessibleName('Improve Inbox notifications');
  await expect(plan.getByRole('button')).toHaveCount(1);
  for (const article of await articles.all()) {
    await expect(article).toHaveCSS('background-color', 'rgb(255, 255, 255)');
    await expect(article).toHaveCSS('border-radius', '0px');
    // Status, title and summary lines with the preview in the right rail, not a card per item.
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

test('desktop rows stack title over summary, cluster time with the metadata, and end their text on one rail', async ({ page }) => {
  await page.setViewportSize(singleColumnDesktop);
  await openTriageInbox(page);
  const ready = page.getByRole('article', { name: 'PR #2498 ready for review' });
  await expect(ready.getByRole('heading', { level: 3 })).toHaveText('Ready for review');
  await expect(ready.getByTitle('Pull request #2498')).toHaveText('PR #2498');
  await expect(ready.getByRole('button')).toHaveText(['']);
  // The rail holds only the thumbnail, which still clears the dismiss button.
  await expect(ready.getByRole('group', { name: 'Published visual previews' })).toBeVisible();
  const railThumbnail = (await ready.getByTitle('Inbox rows').boundingBox())!;
  const readyDismiss = (await ready.getByRole('button', { name: /^Dismiss/ }).boundingBox())!;
  expect(railThumbnail.x + railThumbnail.width).toBeLessThanOrEqual(readyDismiss.x);

  const clean = page.getByRole('article', { name: /^Dashboard cleanup/ });
  await expect(clean.getByRole('button')).toHaveText(['']);
  await expect(page.getByRole('article', { name: /^\[Epic\]/ }).getByRole('button')).toHaveText(['']);

  const thumbnail = (await ready.getByTitle('Inbox rows').boundingBox())!;
  expect([thumbnail.width, thumbnail.height]).toEqual([48, 32]);

  const articles = await page.getByRole('article').all();
  expect(articles).toHaveLength(5);
  const titleEdges = new Set<number>();
  for (const article of articles) {
    const title = (await article.getByRole('heading', { level: 3 }).boundingBox())!;
    const summary = (await article.locator('p').boundingBox())!;
    const repository = (await article.getByTitle('integry/propr').boundingBox())!;
    const time = (await article.locator('time').boundingBox())!;
    // The summary sits on its own line under the title, not after it.
    expect(summary.y).toBeGreaterThanOrEqual(title.y + title.height - 1);
    // The time follows the repository in the left cluster instead of floating mid-row.
    expect(time.x - (repository.x + repository.width)).toBeLessThan(24);
    titleEdges.add(Math.round(title.x + title.width));
    expect((await article.boundingBox())!.height).toBeLessThanOrEqual(80);
  }
  expect([...titleEdges]).toHaveLength(1);

  const dismiss = clean.getByRole('button', { name: /^Dismiss/ });
  const dismissBox = (await dismiss.boundingBox())!;
  expect(dismissBox.width).toBe(24);
  await expect(page.getByRole('button', { name: 'Clear all' })).toHaveCSS('border-top-width', '1px');
  await capture(page, 'inbox-rail-desktop.png');
});

test('phones keep the chip, repository and preview on one line, with no commands and a clear dismiss target', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openTriageInbox(page);
  const epic = page.getByRole('article', { name: /^\[Epic\]/ });
  await expect(epic.getByRole('heading', { level: 3 })).toBeVisible();
  // Commands live in the verdict and on the run in Tasks, never in the list.
  await expect(page.getByRole('button', { name: /^(Send \/|More commands)/ })).toHaveCount(0);

  const status = (await epic.getByRole('img').boundingBox())!;
  const time = (await epic.locator('time').boundingBox())!;
  const chip = (await epic.getByTitle('Pull request #2511').boundingBox())!;
  const dismiss = (await epic.getByRole('button', { name: /^Dismiss/ }).boundingBox())!;
  expect(Math.abs(time.y + time.height / 2 - (status.y + status.height / 2))).toBeLessThan(3);
  // The PR chip and repository sit on their own line instead of squeezing line one.
  expect(chip.y).toBeGreaterThan(time.y + 30);
  await expect(epic.getByTitle('integry/propr')).toHaveText('propr', { useInnerText: true });
  // Dismiss is a 32px target on line one that stays clear of the time.
  expect([dismiss.width, dismiss.height]).toEqual([32, 32]);
  expect(Math.abs(dismiss.y + dismiss.height / 2 - (time.y + time.height / 2))).toBeLessThan(3);
  expect(dismiss.x - (time.x + time.width)).toBeGreaterThanOrEqual(8);

  const ready = page.getByRole('article', { name: 'PR #2498 ready for review' });
  const readyChip = (await ready.getByTitle('Pull request #2498').boundingBox())!;
  const thumbnail = (await ready.getByTitle('Inbox rows').boundingBox())!;
  expect(Math.abs(thumbnail.y + thumbnail.height / 2 - (readyChip.y + readyChip.height / 2))).toBeLessThan(3);
  const readyRepository = ready.getByTitle('integry/propr');
  expect(await readyRepository.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  // The long title wraps to a second line rather than cutting off after a few words.
  const titleBox = (await epic.getByRole('heading', { level: 3 }).boundingBox())!;
  expect(titleBox.height).toBeGreaterThan(30);
  await capture(page, 'inbox-triage-mobile.png');
});

test('a preview image that fails to load leaves no placeholder in the rail', async ({ page }) => {
  await page.setViewportSize(singleColumnDesktop);
  await stubInbox(page, triageNotifications);
  await page.route('https://github.com/user-attachments/assets/**', route => route.abort());
  await page.goto('/inbox');
  const ready = page.getByRole('article', { name: 'PR #2498 ready for review' });
  await expect(ready.getByRole('heading', { level: 3 })).toBeVisible();
  await expect(ready.getByRole('group', { name: 'Published visual previews' })).toBeHidden();
  await expect(ready.getByRole('img', { name: /image unavailable/ })).toHaveCount(0);
});

for (const viewport of [singleColumnDesktop, { width: 390, height: 844 }]) {
  test(`notification rows open ProPR and PR chips open GitHub at ${viewport.width}px`, async ({ page, context }) => {
    await page.setViewportSize(viewport);
    const ready = {
      ...notifications[1], id: 'ready-82', title: 'Make notification destinations consistent',
      body: 'Implementation is ready for review.', readAt: null,
      target: { type: 'pull_request', repository: 'integry/propr', prNumber: 82 },
      metadata: { completedImplementationTaskId: 'implementation-82', completionType: 'implementation' },
      action: pullRequestLink(82),
    };
    const items = [ready, ...notifications];
    await stubInbox(page, items);
    const reads: string[] = [];
    await page.route('**/api/notifications/*/read', route => {
      const id = new URL(route.request().url()).pathname.split('/').at(-2)!;
      reads.push(id);
      const item = items.find(item => item.id === id)!;
      return route.fulfill({ json: { notification: { ...item, readAt: new Date().toISOString() }, unreadCount: 0 } });
    });
    await context.route('https://github.com/integry/propr/pull/*', route => route.fulfill({ body: '' }));
    await page.goto('/inbox');
    const row = page.getByRole('article', { name: ready.title });
    await expect(row.getByRole('heading').getByRole('link')).toHaveAttribute('href', '/tasks/implementation-82');
    const fix = page.getByRole('article').filter({ hasText: 'Fixed 2 review findings in 3 files' });
    await expect(fix.getByRole('heading').getByRole('link')).toHaveAttribute('href', '/tasks/fix-task-81');
    const chip = row.getByRole('link', { name: 'PR #82 on GitHub' });
    await chip.focus();
    await capture(page, `inbox-entity-links-${viewport.width}.png`);
    const popupPromise = page.waitForEvent('popup');
    await chip.click();
    const popup = await popupPromise;
    await expect(popup).toHaveURL('https://github.com/integry/propr/pull/82');
    await expect(page).toHaveURL(/\/inbox$/);
    await expect.poll(() => reads).toContain('ready-82');
    await popup.close();
    // A click on the summary exercises the stretched title overlay. Keep a
    // document marker to distinguish client navigation from a full page load.
    await page.evaluate(() => { document.documentElement.dataset.navigationTest = 'preserved'; });
    const box = (await row.locator('p').boundingBox())!;
    await page.mouse.click(box.x + 20, box.y + box.height / 2);
    await expect(page).toHaveURL(/\/tasks\/implementation-82$/);
    expect(await page.evaluate(() => document.documentElement.dataset.navigationTest)).toBe('preserved');
  });
}

/** One run of PR `prNumber`'s task, as `/api/tasks?groupBy=task` lists it. */
const taskRun = (id: string, prNumber: number, title: string, minutes: number, commitHash: string | null = null) => ({
  id, repository: 'integry/propr', repoOwner: 'integry', repoName: 'propr', prNumber, status: 'completed',
  title, createdAt: minutesAgo(minutes), updatedAt: minutesAgo(minutes), commitHash,
});

/**
 * Serves `/api/tasks?groupBy=task&task=<run>` from `groups`, the runs of each
 * task newest first, and records the run each read asked for.
 */
async function stubTaskGroups(page: Page, groups: Record<string, ReturnType<typeof taskRun>[]>): Promise<string[]> {
  const reads: string[] = [];
  await page.route(/\/api\/tasks\?/, route => {
    const params = new URL(route.request().url()).searchParams;
    const runId = params.get('task');
    // The shell reads the task list too; only the verdict's task-scoped reads are recorded.
    if (params.get('groupBy') !== 'task' || !runId) return route.fulfill({ json: { tasks: [], total: 0 } });
    reads.push(`${runId}:${params.get('limit')}`);
    const tasks = Object.values(groups).find(runs => runs.some(run => run.id === runId)) ?? [];
    return route.fulfill({ json: { tasks, total: tasks.length ? 1 : 0, offset: 0, limit: 1, totalRuns: tasks.length } });
  });
  return reads;
}

test('wide screens triage the selected row in a verdict card beside the queue', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await stubInbox(page, triageNotifications);
  // Each review is still its task's newest run, so its verdict offers /fix.
  await stubTaskGroups(page, {
    2511: [taskRun('task-2511', 2511, 'Review PR #2511: MCP operator surface', 14)],
    2519: [taskRun('task-2519', 2519, 'Review PR #2519: Retry webhook deliveries', 32)],
  });
  const fileChangeReads: string[] = [];
  await page.route('**/api/task/*/file-changes', route => {
    const taskId = decodeURIComponent(new URL(route.request().url()).pathname.split('/').at(-2)!);
    fileChangeReads.push(taskId);
    return route.fulfill({ json: {
      taskId, lastUpdated: timestamp,
      files: [{
        path: 'packages/core/src/activity.ts', status: 'modified', linesAdded: 2, linesRemoved: 1,
        diff: [
          '--- a/packages/core/src/activity.ts', '+++ b/packages/core/src/activity.ts', '@@ -40,3 +40,4 @@',
          '-  if (page.items.length) return page;', '+  if (!page?.items?.length) return emptyPage(cursor);', '+  return page;',
        ].join('\n'),
      }],
    } });
  });
  // The triage rows are timed relative to now, so reads and dismissals are stamped now too.
  await page.route(/\/api\/notifications\/[^/]+\/(read|dismiss)$/, route => {
    const [id, action] = new URL(route.request().url()).pathname.split('/').slice(-2);
    const notification = triageNotifications.find(entry => entry.id === decodeURIComponent(id))!;
    const stamp = new Date().toISOString();
    return route.fulfill({ json: {
      notification: { ...notification, ...(action === 'read' ? { readAt: stamp } : { dismissedAt: stamp }) },
      unreadCount: 0,
    } });
  });
  await page.goto('/inbox?repository=integry%2Fpropr');
  const epicTitle = '[Epic] MCP Operator Surface: Activity, Control And Observability';
  const epic = page.getByRole('article', { name: epicTitle });
  await expect(epic).toBeVisible();
  await expect(page.getByRole('region', { name: 'Triage verdict' })).toHaveCount(0);
  // Commands are sent from the verdict card only, never from queue rows.
  await expect(page.getByTestId('inbox-split-list').getByRole('button', { name: /^(Send \/|More commands)/ })).toHaveCount(0);

  const epicLink = epic.getByRole('link', { name: epicTitle, exact: true });
  await expect(epicLink).toHaveAttribute('href', '/tasks/task-2511');
  await epicLink.click();
  await expect(page).toHaveURL(/notification=review-2511/);
  await expect(page).toHaveURL(/repository=integry%2Fpropr/);
  const verdict = page.getByRole('region', { name: 'Triage verdict' });
  await expect(verdict.getByRole('heading', { name: 'Review verdict: 2 findings (Score 6/10)' })).toBeVisible();
  await expect(verdict.getByText('Check the head SHA before posting')).toBeVisible();
  await expect(verdict.getByText('Guard the empty activity page')).toBeVisible();
  await expect(verdict.getByText('+ if (!page?.items?.length) return emptyPage(cursor);')).toBeVisible();
  await expect(verdict.getByRole('link', { name: /Inspect in Tasks/ })).toHaveAttribute('href', '/tasks/task-2511');
  await expect(verdict.getByRole('button', { name: 'Send /fix to PR #2511' })).toBeVisible();
  expect(fileChangeReads).toEqual(['task-2511']);
  // The selected row is anchored by a teal rule and a tint, not only by aria-current.
  await expect(epicLink).toHaveAttribute('aria-current', 'true');
  await expect(epic).toHaveCSS('box-shadow', /rgb\(13, 148, 136\) 4px 0px 0px 0px inset/);
  await expect(epic).toHaveCSS('background-color', 'rgb(240, 253, 250)');
  await expect(page.getByRole('article', { name: 'Retry webhook deliveries that time out' }))
    .toHaveCSS('background-color', 'rgb(255, 255, 255)');

  // The queue keeps about a third of the width; the verdict takes the rest.
  const queueBox = (await page.getByTestId('inbox-split-list').boundingBox())!;
  const verdictBox = (await verdict.boundingBox())!;
  expect(verdictBox.width).toBeGreaterThan(queueBox.width * 1.5);
  await expect(page.getByTestId('inbox-split-list').getByRole('button', { name: /^(Send \/|More commands)/ })).toHaveCount(0);
  await capture(page, 'inbox-triage-console-desktop.png');

  await verdict.getByRole('button', { name: 'Done' }).click();
  await expect(epic).toHaveCount(0);
  await expect(page).toHaveURL(/notification=review-2519/);
  await expect(verdict.getByRole('heading', { name: 'Review verdict: 4 findings (Score 3/10)' })).toBeVisible();
  await expect(verdict.getByText('Retries never back off')).toBeVisible();
  await expect(verdict.getByText('2 more findings in Tasks')).toBeVisible();
  await expect(page.getByRole('article', { name: 'Retry webhook deliveries that time out' }).getByRole('link', {
    name: 'Retry webhook deliveries that time out', exact: true,
  })).toHaveAttribute('aria-current', 'true');
  await capture(page, 'inbox-triage-console-advanced-desktop.png');
});

test('an older review shows the diff it reviewed but no /fix once a newer run of its task exists', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await stubInbox(page, triageNotifications);
  // PR #2511: a fix has run since the review; the review read the implementation's commit.
  const taskReads = await stubTaskGroups(page, {
    2511: [
      taskRun('fix-2511', 2511, 'Fix PR #2511: MCP operator surface', 4, 'f1x0000'),
      taskRun('task-2511', 2511, 'Review PR #2511: MCP operator surface', 14),
      taskRun('impl-2511', 2511, 'Implement PR #2511: MCP operator surface', 40, 'abc1234'),
    ],
  });
  const fileChangeReads: string[] = [];
  await page.route('**/api/task/*/file-changes', route => {
    const taskId = decodeURIComponent(new URL(route.request().url()).pathname.split('/').at(-2)!);
    fileChangeReads.push(taskId);
    // The review itself committed nothing.
    const files = taskId === 'impl-2511' ? [{
      path: 'packages/core/src/activity.ts', status: 'modified', linesAdded: 1, linesRemoved: 0,
      diff: '@@ -40 +40,2 @@\n+  return reviewedPage;',
    }] : [];
    return route.fulfill({ json: { taskId, lastUpdated: timestamp, files } });
  });
  await page.route(/\/api\/notifications\/[^/]+\/read$/, route => {
    const id = decodeURIComponent(new URL(route.request().url()).pathname.split('/').at(-2)!);
    const notification = triageNotifications.find(entry => entry.id === id)!;
    return route.fulfill({ json: { notification: { ...notification, readAt: new Date().toISOString() }, unreadCount: 0 } });
  });
  await page.goto('/inbox?notification=review-2511');
  const verdict = page.getByRole('region', { name: 'Triage verdict' });
  await expect(verdict.getByRole('heading', { name: 'Review verdict: 2 findings (Score 6/10)' })).toBeVisible();
  await expect(verdict.getByText('+   return reviewedPage;')).toBeVisible();
  expect(taskReads).toEqual(['task-2511:1']);
  expect(fileChangeReads).toEqual(['task-2511', 'impl-2511']);
  await expect(verdict.getByRole('button', { name: /^Send \// })).toHaveCount(0);
  await expect(verdict.getByRole('link', { name: /Inspect in Tasks/ })).toHaveAttribute('href', '/tasks/task-2511');
  await capture(page, 'inbox-verdict-superseded-review-desktop.png');
});
