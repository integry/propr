import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { fixture as taskFixture } from './task-list-desktop.fixture';
import { fixture as dashboardFixture, user as dashboardUser } from './dashboard-sections.fixture';

/**
 * Navigation the browser's Back button can follow: opening a task or an Inbox
 * item adds a history entry and Back returns to the same list page, a selected
 * repository is its own URL, every unknown id lands on one not-found screen,
 * and a short window keeps every sidebar item reachable.
 */

const historyLength = (page: Page) => page.evaluate(() => window.history.length);

async function capture(page: Page, name: string): Promise<void> {
  if (!process.env.PROPR_CAPTURE_PREVIEWS) return;
  await mkdir('../.propr/previews', { recursive: true });
  await page.screenshot({ animations: 'disabled', path: `../.propr/previews/${name}.png` });
}

const adminUser = {
  id: 'navigation-user', login: 'operator', username: 'operator', displayName: 'Dana Okonkwo',
  email: null, avatarUrl: null, role: 'admin',
  permissions: ['instance.manage_settings', 'instance.manage_agents', 'instance.manage_members'], authorizationSource: 'local',
};

/** The shell's reads, plus `responses` by pathname; anything else is unavailable. */
async function stubShell(page: Page, responses: Record<string, { status?: number; json: unknown }>): Promise<void> {
  await page.routeWebSocket('**/socket.io/**', socket => socket.close());
  await page.route('**/api/**', route => {
    const pathname = new URL(route.request().url()).pathname;
    const shell: Record<string, unknown> = {
      '/api/auth/demo-mode': { demoMode: false },
      '/api/auth/user': adminUser,
      '/api/notifications/unread-count': { unreadCount: 0 },
      '/api/notifications/config': { push: { configured: false, vapidPublicKey: null } },
      '/api/instance/catalog': { repositories: [], agents: [] },
      '/api/tasks': { tasks: [], total: 0 },
    };
    if (pathname in responses) return route.fulfill({ status: responses[pathname].status ?? 200, json: responses[pathname].json });
    if (pathname in shell) return route.fulfill({ json: shell[pathname] });
    return route.fulfill({ status: 503, json: { error: 'Unavailable in the navigation fixture' } });
  });
}

const taskTitle = 'Stop work when an issue or PR withdraws intent';

test('1280px Back from a task opened beside page 2 returns to page 2 of the list', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 820 });
  await taskFixture(page);
  await page.goto('/');
  const start = await historyLength(page);

  await page.locator('aside').getByRole('link', { name: /^Tasks/ }).click();
  await expect(page).toHaveURL(/\/tasks$/);
  const footer = page.getByTestId('task-list-footer');
  await footer.getByRole('button', { name: 'Next' }).click();
  await expect(page).toHaveURL(/\/tasks\?page=2$/);
  await expect(page.getByRole('table', { name: 'Tasks' })).toBeVisible();

  await page.getByRole('table', { name: 'Tasks' }).getByRole('link', { name: taskTitle }).click();
  await expect(page).toHaveURL(/\/tasks\?page=2&task=pr-2664-run-0$/);
  await expect(page.getByTestId('task-split-details').getByTestId('task-details')).toBeVisible();
  // Tasks, page 2 and the opened task are three entries on top of the Dashboard.
  expect(await historyLength(page)).toBe(start + 3);

  await page.goBack();
  await expect(page).toHaveURL(/\/tasks\?page=2$/);
  await expect(page.getByTestId('task-split-details')).toHaveCount(0);
  await expect(footer).toContainText('2/');
  await page.goBack();
  await expect(page).toHaveURL(/\/tasks$/);
  await page.goBack();
  await expect(page).toHaveURL(/\/$/);
});

test('1280px moving between open tasks replaces the entry, so one Back returns to the list', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 820 });
  await taskFixture(page);
  await page.goto('/tasks?repository=integry%2Fpropr');
  const start = await historyLength(page);
  await page.getByRole('table', { name: 'Tasks' }).getByRole('link', { name: taskTitle }).click();
  await expect(page).toHaveURL(/task=pr-2664-run-0/);
  const list = page.getByTestId('task-split-list');
  await list.getByRole('link', { name: /Give implementation runs and direct goals/ }).first().click();
  await expect(page).toHaveURL(/task=pr-2661-run-0/);
  expect(await historyLength(page)).toBe(start + 1);
  await page.goBack();
  await expect(page).toHaveURL(/\/tasks\?repository=integry%2Fpropr$/);
});

test('1024px Back from a task page returns to the same list page and scroll position', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 520 });
  await taskFixture(page);
  await page.goto('/tasks?page=2');
  const scroller = page.getByTestId('task-list-scroll');
  const lastTask = scroller.getByRole('link', { name: /a-very-long-unbroken-configuration-filename/ }).first();
  await expect(lastTask).toBeAttached();
  await scroller.evaluate(element => { element.scrollTop = element.scrollHeight; });
  const scrolled = await scroller.evaluate(element => element.scrollTop);
  expect(scrolled).toBeGreaterThan(0);

  await lastTask.click();
  await expect(page).toHaveURL(/\/tasks\/long-title$/);
  await page.goBack();
  await expect(page).toHaveURL(/\/tasks\?page=2$/);
  await expect(lastTask).toBeAttached();
  await expect.poll(() => scroller.evaluate(element => element.scrollTop)).toBe(scrolled);
});

test('the task search stops at the 500 characters the server accepts', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 820 });
  await taskFixture(page);
  await page.goto('/tasks');
  const search = page.getByPlaceholder('Search tasks...');
  await search.fill('x'.repeat(2000));
  await expect(search).toHaveValue('x'.repeat(500));
  await expect(page).toHaveURL(new RegExp(`search=x{500}$`));
  await expect(page.getByText(/Search cannot exceed/)).toHaveCount(0);
});

const reviewNotification = (id: string, prNumber: number, title: string) => ({
  id, deduplicationKey: id, kind: 'review', severity: 'success',
  target: { type: 'review', repository: 'integry/propr', prNumber, taskId: `task-${prNumber}` },
  title, body: 'Score 8/10 · no blocking findings',
  actions: ['follow_up', 'open_pr', 'dismiss'],
  occurredAt: new Date().toISOString(), createdAt: new Date().toISOString(), readAt: new Date().toISOString(), dismissedAt: null,
});

test('1440px opening an Inbox item adds a history entry and Back returns to the queue', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const notifications = [
    reviewNotification('review-81', 81, 'Guard Inbox recaps against empty metadata'),
    reviewNotification('review-82', 82, 'Retry webhook deliveries that time out'),
  ];
  await stubShell(page, {
    '/api/notifications': { json: { notifications, unreadCount: 0, nextCursor: null } },
  });
  await page.goto('/');
  await page.locator('aside').getByRole('link', { name: /^Inbox/ }).click();
  await expect(page).toHaveURL(/\/inbox$/);
  const start = await historyLength(page);

  await page.getByRole('article', { name: 'Guard Inbox recaps against empty metadata' })
    .getByRole('link', { name: 'Guard Inbox recaps against empty metadata', exact: true }).click();
  await expect(page).toHaveURL(/\/inbox\?notification=review-81$/);
  await expect(page.getByRole('region', { name: 'Triage verdict' })).toBeVisible();
  expect(await historyLength(page)).toBe(start + 1);

  // Moving on to the next item replaces the entry rather than adding another.
  await page.getByRole('article', { name: 'Retry webhook deliveries that time out' })
    .getByRole('link', { name: 'Retry webhook deliveries that time out', exact: true }).click();
  await expect(page).toHaveURL(/notification=review-82$/);
  expect(await historyLength(page)).toBe(start + 1);

  await page.goBack();
  await expect(page).toHaveURL(/\/inbox$/);
  await expect(page.getByRole('region', { name: 'Triage verdict' })).toHaveCount(0);
  // An old `?notification=` link still opens the item.
  await page.goto('/inbox?notification=review-82');
  await expect(page.getByRole('region', { name: 'Triage verdict' })).toBeVisible();
});

test('a selected repository is in the URL, survives a reload and follows Back and Forward', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const repos = [
    { id: 'propr', name: 'integry/propr', enabled: true, visualPreview: { enabled: false, types: ['image'] } },
    { id: 'sdk', name: 'integry/integration-sdk', enabled: true, baseBranch: 'main', visualPreview: { enabled: false, types: ['image'] } },
    { id: 'sdk-release', name: 'integry/integration-sdk', enabled: true, baseBranch: 'release', visualPreview: { enabled: false, types: ['image'] } },
  ];
  await stubShell(page, {
    '/api/config/repos': { json: { success: true, repos_to_monitor: repos } },
    '/api/instance/catalog': { json: { repositories: repos, agents: [] } },
    '/api/github/repos': { json: { repos: [] } },
    '/api/user/repo-preferences': { json: { preferences: {} } },
    '/api/repositories/indexing-status': { json: { repositories: [] } },
    '/api/repos/chat/messages': { json: { messages: [] } },
  });
  await page.goto('/repositories');
  const start = await historyLength(page);

  await page.getByRole('button', { name: 'Select integry/propr', exact: true }).click();
  await expect(page).toHaveURL(/\/repositories\/integry\/propr$/);
  await expect(page.getByRole('region', { name: 'Settings for integry/propr', exact: true })).toBeVisible();
  expect(await historyLength(page)).toBe(start + 1);
  await capture(page, 'repository-deep-link');

  // Two entries track the SDK, so the URL names the branch of the one selected.
  await page.getByRole('button', { name: 'Select integry/integration-sdk', exact: true }).nth(1).click();
  await expect(page).toHaveURL(/\/repositories\/integry\/integration-sdk\?branch=release$/);
  await page.reload();
  await expect(page.getByRole('region', { name: 'Settings for integry/integration-sdk', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Select integry/integration-sdk', exact: true }).nth(1)).toHaveAttribute('aria-pressed', 'true');

  await page.goBack();
  await expect(page).toHaveURL(/\/repositories\/integry\/propr$/);
  await expect(page.getByRole('region', { name: 'Settings for integry/propr', exact: true })).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/\/repositories$/);
  await expect(page.getByRole('region', { name: /^Settings for / })).toHaveCount(0);
  await page.goForward();
  await expect(page.getByRole('region', { name: 'Settings for integry/propr', exact: true })).toBeVisible();
});

type StubResponses = Record<string, { status?: number; json: unknown }>;
const notFoundCases: Array<{ path: string; heading: string; back: string; href: string; responses: StubResponses }> = [
  { path: '/tasks/unknown-task', heading: 'Task not found', back: 'Back to tasks', href: '/tasks',
    responses: { '/api/task/unknown-task/history': { json: { history: [], taskInfo: null } } } },
  { path: '/goals/unknown-goal', heading: 'Goal not found', back: 'Back to goals', href: '/goals',
    responses: { '/api/goals/unknown-goal': { status: 404, json: { error: 'Goal not found' } } } },
  { path: '/studio/nope', heading: 'Plan not found', back: 'Back to plans', href: '/plans',
    responses: { '/api/planner/drafts/nope': { status: 400, json: { error: 'Draft ID must be a valid UUID' } } } },
  { path: '/studio/00000000-0000-4000-8000-000000000000', heading: 'Plan not found', back: 'Back to plans', href: '/plans',
    responses: { '/api/planner/drafts/00000000-0000-4000-8000-000000000000': { status: 404, json: { error: 'Draft not found' } } } },
  { path: '/automations/unknown-automation', heading: 'Automation not found', back: 'Back to automations', href: '/automations',
    responses: {
      '/api/automation-definitions/unknown-automation': { status: 404, json: { error: 'Automation definition not found' } },
      '/api/automation-definitions': { json: { definitions: [], total: 0, limit: 100, offset: 0 } },
    } },
  { path: '/no-such-page', heading: 'Page not found', back: 'Back to dashboard', href: '/', responses: {} },
];

for (const notFound of notFoundCases) {
  test(`${notFound.path} shows the shared not-found screen`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await stubShell(page, notFound.responses);
    await page.goto(notFound.path);
    const screen = page.getByTestId('not-found');
    await expect(screen.getByRole('heading', { name: notFound.heading })).toBeVisible();
    await expect(screen.getByRole('link', { name: notFound.back })).toHaveAttribute('href', notFound.href);
    await expect(page).toHaveTitle('Not found · ProPR');
    // Neutral, like the page-not-found screen: no red error card, no tabs for a record that is not there.
    await expect(screen.getByRole('heading', { name: notFound.heading })).toHaveCSS('color', 'rgb(55, 65, 81)');
    await expect(page.getByRole('tab')).toHaveCount(0);
    if (notFound.path === '/tasks/unknown-task') await capture(page, 'not-found-task');
  });
}

test('every list route titles its tab "<Page> · ProPR"', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await stubShell(page, { '/api/automation-definitions': { json: { definitions: [], total: 0, limit: 100, offset: 0 } } });
  for (const [path, title] of [['/automations', 'Automations'], ['/admin/members', 'Access'], ['/plans', 'Plans'], ['/ai-agents', 'Coding agents']]) {
    await page.goto(path);
    await expect(page).toHaveTitle(`${title} · ProPR`);
  }
});

/** The shell of a signed-in administrator with Agent Tank usage, so the sidebar is whole. */
async function openAdminDashboard(page: Page, viewport: { width: number; height: number }) {
  await dashboardFixture(page, viewport);
  await page.route('**/api/auth/user', route => route.fulfill({ json: { ...dashboardUser, ...adminUser } }));
  await page.goto('/');
  await expect(page.locator('aside').getByText('Usage', { exact: true })).toBeVisible();
}

/** Whether a sidebar link is drawn inside the window and is what a click at its centre hits. */
async function expectClickable(page: Page, name: string) {
  const link = page.locator('aside nav').getByRole('link', { name, exact: true });
  await expect(link).toBeInViewport({ ratio: 1 });
  const hit = await link.evaluate(element => {
    const box = element.getBoundingClientRect();
    const target = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    return Boolean(target && element.contains(target));
  });
  expect(hit, `${name} is covered at its centre`).toBe(true);
}

for (const viewport of [{ width: 1280, height: 720 }, { width: 1024, height: 768 }]) {
  test(`${viewport.width}x${viewport.height} every sidebar item is visible and clickable above Usage`, async ({ page }) => {
    await openAdminDashboard(page, viewport);
    for (const name of ['Dashboard', 'Repositories', 'Coding agents', 'Analytics', 'Settings', 'Access']) await expectClickable(page, name);
    // Usage folded to one line to make the room, rather than covering the last items.
    await expect(page.getByTestId('usage-line')).toBeVisible();
    const usageTop = await page.getByTestId('usage-line').evaluate(element => element.getBoundingClientRect().top);
    const accessBottom = await page.locator('aside nav').getByRole('link', { name: 'Access', exact: true })
      .evaluate(element => element.getBoundingClientRect().bottom);
    expect(accessBottom).toBeLessThanOrEqual(usageTop);
    await capture(page, `sidebar-${viewport.width}x${viewport.height}`);
    await page.locator('aside nav').getByRole('link', { name: 'Access', exact: true }).click();
    await expect(page).toHaveURL(/\/admin\/members$/);
  });
}

test('1280x720 an opened Logs group scrolls the sidebar with a visible fade, and Access stays reachable', async ({ page }) => {
  await openAdminDashboard(page, { width: 1280, height: 720 });
  await page.locator('aside nav').getByRole('button', { name: 'Logs' }).click();
  const nav = page.locator('aside nav');
  await expect(nav).toHaveAttribute('data-scrollable-below', 'true');
  await expect(page.getByTestId('sidebar-nav-fade')).toBeVisible();
  const access = nav.getByRole('link', { name: 'Access', exact: true });
  await access.scrollIntoViewIfNeeded();
  await expectClickable(page, 'Access');
  await expect(nav).not.toHaveAttribute('data-scrollable-below', 'true');
});

test('1920x1080 has room for the full Usage panel', async ({ page }) => {
  await openAdminDashboard(page, { width: 1920, height: 1080 });
  await expect(page.getByTestId('usage-line')).toHaveCount(0);
  await expect(page.locator('aside').getByText('Claude', { exact: true })).toBeVisible();
  await expectClickable(page, 'Access');
});

/** Whether Usage is folded at each of the next `frames` animation frames. */
const foldedPerFrame = (page: Page, frames: number) => page.evaluate(async count => {
  const states: boolean[] = [];
  for (let frame = 0; frame < count; frame += 1) {
    await new Promise(resolve => requestAnimationFrame(resolve));
    states.push(document.querySelector('[data-testid="usage-line"]') !== null);
  }
  return states;
}, frames);

test('growing the window through the fold threshold settles into one layout at every height', async ({ page }) => {
  // About 80 resizes, each sampled over several frames: well past the default
  // 30s budget on a loaded CI host, as in the other resize sweeps.
  test.setTimeout(90_000);
  await openAdminDashboard(page, { width: 1280, height: 720 });
  await expect(page.getByTestId('usage-line')).toBeVisible();
  // Folding tightens the account and footer gaps too, so expanding must budget
  // for them; otherwise a band of heights flips between the layouts every frame.
  let expanded = false;
  for (let height = 720; height <= 1040; height += 4) {
    await page.setViewportSize({ width: 1280, height });
    const states = await foldedPerFrame(page, 10);
    // A layout that flips on every commit ends in React's update-depth error,
    // which the page's error boundary shows instead of the sidebar.
    await expect(page.getByRole('heading', { name: 'Something went wrong on this page' }), `${height}px crashed`).toHaveCount(0);
    const settled = states.slice(4);
    expect(new Set(settled).size, `${height}px keeps switching layouts: ${states.join(',')}`).toBe(1);
    // Access stays reachable in the folded layout and the moment the full panel returns.
    if (!settled[0] && !expanded) await expectClickable(page, 'Access');
    if (!settled[0]) expanded = true;
    // A taller window never folds Usage again once the full panel fitted.
    expect(settled[0] && expanded, `${height}px folded Usage again after it fitted`).toBe(false);
  }
  expect(expanded, 'the full Usage panel returned within the sweep').toBe(true);
  await expectClickable(page, 'Access');
});
