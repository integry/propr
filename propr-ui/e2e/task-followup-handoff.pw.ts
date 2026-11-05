import { expect, test, type Locator, type Page } from '@playwright/test';
import { ago, capture, fixture } from './task-list-desktop.fixture';
import { installWindowActions } from './native-chrome.fixture';

// Synthetic: a failed issue-only run of issue #32 with no pull request, and the fresh run its follow-up starts.
const source = 'issue-32-run-0';
const fresh = 'issue-32-run-1';
const commentId = 9_000_001;
const requester = { id: '297689653', login: 'fixture-requester', username: 'fixture-requester', displayName: 'Fixture Requester', email: null, avatarUrl: null, role: 'member', permissions: [], authorizationSource: 'local' };
const issueTask = (id: string, status: string, minutes: number, extra: Record<string, unknown> = {}) => ({
  id, repository: 'acme/widgets', repositoryOwner: 'acme', repositoryName: 'widgets', issueNumber: 32,
  title: 'New Issue: Export the weekly report as CSV', subtitle: null, status,
  createdAt: ago(minutes), processedAt: ago(minutes), completedAt: status === 'processing' ? null : ago(minutes - 5),
  llmProvider: 'claude', model: 'claude-opus-5-5', score: null, ...extra,
});

interface Stub { posts: string[]; lookups: number }

/**
 * The run's admission is delayed: the lookup finds nothing for its first reads, then the fresh run working, then
 * finished with a pull request. The original run's history never changes.
 */
async function stub(page: Page, platform?: 'linux', { startAfter = 2, completeAfter = 4 } = {}): Promise<Stub> {
  const state: Stub = { posts: [], lookups: 0 };
  await fixture(page, platform);
  if (platform) await installWindowActions(page, { platform });
  await page.route('**/api/auth/user', route => route.fulfill({ json: requester }));
  await page.route(/\/api\/tasks(\?.*)?$/, route => route.fulfill({ json: { tasks: [issueTask(source, 'failed', 40, { failedReason: 'Unit tests failed' })], total: 1, totalRuns: 1 } }));
  await page.route(`**/api/task/${source}/history`, route => route.fulfill({ json: {
    history: [
      { state: 'PENDING', timestamp: ago(40) },
      { state: 'CLAUDE_EXECUTION', timestamp: ago(39) },
      { state: 'FAILED', timestamp: ago(35), message: 'Unit tests failed' },
    ],
    taskInfo: { title: 'New Issue: Export the weekly report as CSV', type: 'issue', number: 32, issueNumber: 32, repoOwner: 'acme', repoName: 'widgets',
      followupTarget: { taskId: source, repository: 'acme/widgets', kind: 'issue', number: 32 } },
  } }));
  await page.route(`**/api/task/${fresh}/history`, route => route.fulfill({ json: {
    history: [
      { state: 'PENDING', timestamp: ago(1) },
      { state: 'CLAUDE_EXECUTION', timestamp: ago(0.8) },
      { state: 'COMPLETED', timestamp: ago(0.1), metadata: { pr: { number: 33, url: 'https://github.com/acme/widgets/pull/33' } } },
    ],
    taskInfo: { title: 'New Issue: Export the weekly report as CSV', type: 'issue', number: 32, issueNumber: 32, repoOwner: 'acme', repoName: 'widgets' },
  } }));
  for (const id of [source, fresh]) {
    await page.route(`**/api/task/${id}/live-details`, route => route.fulfill({ json: { events: [], todos: [], currentTask: null } }));
  }
  await page.route(`**/api/tasks/${source}/followup`, route => {
    state.posts.push(route.request().postDataJSON().body);
    return route.fulfill({ status: 202, json: {
      success: true, state: 'queued', jobId: 'issue-acme-widgets-32', posted: true, commentId, sourceTaskId: source,
      intent: 'issue', issueNumber: 32, message: 'Retry queued on issue #32.',
    } });
  });
  await page.route(`**/api/tasks/${source}/followup-runs**`, route => {
    expect(new URL(route.request().url()).searchParams.get('commentId')).toBe(String(commentId));
    state.lookups += 1;
    const status = state.lookups <= startAfter ? null : state.lookups <= completeAfter ? 'processing' : 'completed';
    return route.fulfill({ json: { sourceTaskId: source, commentId, runs: status ? [{ taskId: fresh, status }] : [] } });
  });
  return state;
}

async function sendFollowup(page: Page) {
  const direct = page.locator('button[title^="Follow Up"]').filter({ visible: true });
  await expect(direct.or(page.getByRole('button', { name: /more actions/i }).filter({ visible: true })).first()).toBeVisible();
  if (await direct.count()) await direct.first().click();
  else {
    await page.getByRole('button', { name: /more actions/i }).filter({ visible: true }).first().click();
    await page.getByRole('menuitem', { name: /Follow Up/ }).click();
  }
  const dialog = page.getByRole('dialog', { name: 'Follow Up on Task' });
  await expect(dialog).toHaveAccessibleDescription('Post a comment to Issue acme/widgets#32');
  await dialog.getByRole('textbox', { name: 'Comment' }).fill('Please retry; the CSV header row was missing.');
  await dialog.getByRole('button', { name: 'Post Comment' }).click();
  await expect(dialog).toBeHidden();
}

const handoff = (page: Page) => page.getByTestId('followup-handoff');

async function expectFitsWidth(page: Page, locator: Locator, width: number) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  const box = (await locator.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(width + 0.5);
}

const viewports = [
  { name: 'desktop-1280x800', width: 1280, height: 800 },
  { name: 'phone-390x844', width: 390, height: 844 },
  { name: 'phone-320x640', width: 320, height: 640 },
];

for (const viewport of viewports) {
  test(`${viewport.name}: a direct failed task page hands an accepted issue follow-up off to its fresh run`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const state = await stub(page);
    await page.goto(`/tasks/${source}`);
    await sendFollowup(page);
    expect(state.posts).toHaveLength(1);

    // Accepted, waiting for admission: persistent, and naming no run yet.
    await expect(handoff(page)).toHaveAttribute('data-phase', 'starting');
    await expect(handoff(page)).toContainText('Follow-up accepted. Starting a new run…');
    await expect(handoff(page).getByRole('link')).toHaveCount(0);
    await expectFitsWidth(page, handoff(page), viewport.width);
    await capture(page, `task-followup-handoff-starting-${viewport.name}`);

    const view = handoff(page).getByRole('link', { name: 'View new run' });
    await expect(view).toHaveAttribute('href', `/tasks/${fresh}`, { timeout: 15_000 });
    await expect(handoff(page)).toContainText('The new run completed', { timeout: 15_000 });
    const box = (await view.boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(44);
    await expectFitsWidth(page, view, viewport.width);
    // The original run is still the failed run it was, with its own history; no ID reaches the product text.
    await expect(page).toHaveURL(new RegExp(`/tasks/${source}$`));
    await expect(page.getByText('Failed', { exact: true }).filter({ visible: true }).first()).toBeVisible();
    await expect(handoff(page)).not.toContainText(fresh);
    await expect(handoff(page)).not.toContainText(String(commentId));
    await capture(page, `task-followup-handoff-completed-${viewport.name}`);

    // A reload keeps the handoff and only reads; the request is never posted again.
    await page.reload();
    await expect(handoff(page).getByRole('link', { name: 'View new run' })).toBeVisible();
    expect(state.posts).toHaveLength(1);

    await handoff(page).getByRole('link', { name: 'View new run' }).click();
    await expect(page).toHaveURL(new RegExp(`/tasks/${fresh}$`));
    await expect(page.getByText('Completed', { exact: true }).filter({ visible: true }).first()).toBeVisible();
    await expect(handoff(page)).toHaveCount(0);

    // The original failure stays inspectable, still pointing at its fresh run.
    await page.goBack();
    await expect(page).toHaveURL(new RegExp(`/tasks/${source}$`));
    await expect(page.getByText('Failed', { exact: true }).filter({ visible: true }).first()).toBeVisible();
    await expect(handoff(page).getByRole('link', { name: 'View new run' })).toBeVisible();
  });
}

test('native Linux desktop: the handoff sits in the task page below the native titlebar', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await stub(page, 'linux', { startAfter: 1, completeAfter: 100 });
  await page.goto(`/tasks/${source}`);
  await sendFollowup(page);
  await expect(handoff(page).getByRole('link', { name: 'View new run' })).toBeVisible({ timeout: 15_000 });
  await expect(handoff(page)).toContainText('A new run is working on your follow-up');
  const controls = page.getByRole('group', { name: 'Window controls' });
  await expect(controls).toBeVisible();
  const [bar, titlebar] = [(await handoff(page).boundingBox())!, (await controls.boundingBox())!];
  expect(bar.y).toBeGreaterThanOrEqual(titlebar.y + titlebar.height);
  await capture(page, 'task-followup-handoff-linux-desktop');
});

test('task-list pane: the handoff opens the fresh run in the pane, and the failed run stays in the list', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await stub(page, undefined, { startAfter: 1, completeAfter: 2 });
  await page.goto(`/tasks?task=${source}`);
  const pane = page.getByTestId('task-split-details');
  await expect(pane.getByTestId('task-details')).toBeVisible();
  await sendFollowup(page);
  const view = pane.getByTestId('followup-handoff').getByRole('link', { name: 'View new run' });
  await expect(view).toBeVisible({ timeout: 15_000 });
  await capture(page, 'task-followup-handoff-pane');
  await view.click();
  await expect(page).toHaveURL(new RegExp(`[?&]task=${fresh}`));
  await expect(pane.getByText('Completed', { exact: true }).filter({ visible: true }).first()).toBeVisible();
  // The list still holds the failed run; opening it shows its failure and the way to the fresh run.
  await page.getByTestId('task-split-list').getByText('Export the weekly report as CSV').first().click();
  await expect(page).toHaveURL(new RegExp(`[?&]task=${source}`));
  await expect(pane.getByText('Failed', { exact: true }).filter({ visible: true }).first()).toBeVisible();
  await expect(pane.getByTestId('followup-handoff').getByRole('link', { name: 'View new run' })).toBeVisible();
});
