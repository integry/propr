import { expect, test, type Locator, type Page } from '@playwright/test';
import { capture, now, ago, tasks } from './task-list-desktop.fixture';

// A phone search for Tasks, Plans and Goals: entered, applied through each list's existing
// request/URL path, and cleared, including a URL-supplied query that matches nothing.

const goal = (id: string, title: string, repository: string) => ({
  id, owner: 'operator', repository, title, objective: `${title} for the release.`,
  launchStrategy: 'orchestrate', initialPrompt: `/goal ${title}`, attachments: [],
  baseBranch: null, branchName: `goal/${id}`, worktreePath: `/tmp/${id}`,
  agent: { id: 'agent-1', alias: 'codex', type: 'codex' },
  requestedModel: 'gpt-6-astra', effectiveModel: 'gpt-6-astra',
  maxParallelTasks: 3, ultrafix: true, desiredState: 'running', resultState: null,
  failureReason: null, pausePending: false,
  control: { requestGeneration: 0, acknowledgedGeneration: 0, pending: false },
  taskId: `${id}-task`, sessionId: null, conversationId: null, finalPr: null,
  checkpoint: null, artifacts: [],
  artifactStats: { issues: 0, openIssues: 0, pullRequests: 0, openPullRequests: 0 },
  liveSummary: { currentTask: null, todos: [], tokenUsage: { input_tokens: 0, output_tokens: 0 }, nativeGoal: null },
  taskState: 'claude_execution', createdAt: ago(60), updatedAt: ago(5),
  startedAt: ago(60), pausedAt: null, completedAt: null,
  elapsedMs: 60_000, activeMs: 60_000, pausedMs: 0,
});
const goals = [
  goal('goal-1', 'Launch Customer Analytics Dashboard', 'integry/propr'),
  goal('goal-2', 'Prepare Billing API', 'integry/api'),
];

const draft = (id: string, name: string, status: string, repository = 'integry/propr') => ({
  draft_id: id, repository, name, initial_prompt: name, status, updated_at: ago(30), created_at: ago(90),
});
const drafts = [
  draft('draft-1', 'Mobile search for list pages', 'draft'),
  draft('draft-2', 'Retry webhook deliveries', 'review'),
  draft('draft-3', 'Cache repository indexes', 'draft', 'integry/api'),
];

const matches = (text: string, search: string | null) => !search || text.toLowerCase().includes(search.toLowerCase());

async function stub(page: Page) {
  await page.clock.install({ time: now });
  await page.routeWebSocket('**/socket.io/**', socket => socket.close());
  await page.route('**/api/**', route => {
    const url = new URL(route.request().url());
    const search = url.searchParams.get('search');
    const status = url.searchParams.get('status');
    const responses: Record<string, unknown> = {
      '/api/auth/demo-mode': { demoMode: false },
      '/api/auth/user': { id: 'user-1', login: 'operator', username: 'operator', displayName: 'Operations', email: null, avatarUrl: null, role: 'admin', permissions: [], authorizationSource: 'local' },
      '/api/instance/catalog': { agents: [{ id: 'agent-1', alias: 'codex', type: 'codex', enabled: true, models: ['gpt-6-astra'], defaultModel: 'gpt-6-astra' }], repositories: [{ name: 'integry/propr', enabled: true }, { name: 'integry/api', enabled: true }] },
      '/api/tasks': (() => {
        const found = tasks.filter(task => matches(task.title, search) && (!status || status === 'all' || task.status === status));
        return { tasks: found, total: new Set(found.map(task => ('prNumber' in task ? task.prNumber : task.id))).size, totalRuns: found.length };
      })(),
      '/api/stats/repositories': { repositories: [{ repository: 'integry/propr', total: 30, completed: 20, failed: 2, inProgress: 1, successRate: 80 }, { repository: 'integry/desktop-workspaces', total: 1, completed: 0, failed: 1, inProgress: 0, successRate: 0 }] },
      '/api/planner/drafts': (() => {
        const found = drafts.filter(item => matches(item.name, search) && (!status || item.status === status));
        return { drafts: found, total: found.length, page: 1, limit: 50, hasMore: false };
      })(),
      '/api/planner/drafts/repositories': { repositories: [{ repo: 'integry/propr', count: 2 }, { repo: 'integry/api', count: 1 }], total: 3 },
      '/api/goals': { goals },
      '/api/queue/stats': { active: 0, waiting: 0, completed: 0, failed: 0 },
      '/api/stats/generating-plans': { count: 0 },
      '/api/notifications/unread-count': { unreadCount: 0 },
      '/api/notifications/preferences': { preferences: {}, quietHours: { start: null, end: null, timezone: 'UTC' }, badgeEnabled: false },
    };
    return url.pathname in responses
      ? route.fulfill({ json: responses[url.pathname] })
      : route.fulfill({ status: 503, json: { error: 'Unavailable in list search fixture' } });
  });
}

/** Search params of every list request the page makes to `pathname`. */
function recordRequests(page: Page, pathname: string) {
  const seen: URLSearchParams[] = [];
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.pathname === pathname) seen.push(url.searchParams);
  });
  return seen;
}

/** Holds every searched request to `pathname` for a second, so a debounced reload is still pending while the user types. */
async function delaySearchedRequests(page: Page, pathname: string) {
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === pathname && url.searchParams.get('search')) await new Promise(resolve => setTimeout(resolve, 1000));
    await route.fallback();
  });
}

/**
 * Types `first`, waits past the debounce while that searched reload is still pending, then types
 * `next` without touching the field again. The same focused input must take both keystrokes.
 */
async function typeAcrossPendingReload(page: Page, search: Locator, { requests, skeleton, first, next, preview }: { requests: URLSearchParams[]; skeleton: Locator; first: string; next: string; preview: string }) {
  await search.tap();
  const field = await search.elementHandle();
  await page.keyboard.type(first);
  await expect.poll(() => requests.some(params => params.get('search') === first)).toBe(true);
  await expect(skeleton).toBeVisible();
  await expect(page.getByRole('textbox')).toHaveCount(1);
  await expect(search).toBeFocused();
  await expect(search).toHaveValue(first);
  expect(await field!.evaluate(node => node.isConnected && node === document.activeElement)).toBe(true);
  // All of that held while the reload was still pending.
  await expect(skeleton).toBeVisible();
  await capture(page, preview);

  await page.keyboard.type(next);
  await expect.poll(() => requests.some(params => params.get('search') === first + next)).toBe(true);
  await expect(skeleton).toBeHidden();
  await expect(search).toBeFocused();
  await expect(search).toHaveValue(first + next);
  expect(await field!.evaluate(node => node.isConnected && node === document.activeElement)).toBe(true);
  await expect(page).toHaveURL(new RegExp(`search=${first + next}(&|$)`));
  expect(requests.at(-1)!.get('search')).toBe(first + next);
}

/** The search field and its clear action fit the phone: on screen, unclipped, clear of the bottom bar, finger-sized. */
async function expectUsable(page: Page, search: Locator, width: number) {
  const clear = page.getByRole('button', { name: 'Clear search', exact: true });
  const nav = page.getByRole('navigation', { name: 'Primary navigation' });
  const [field, button, bar] = await Promise.all([search.boundingBox(), clear.boundingBox(), nav.boundingBox()]);
  expect(field!.x).toBeGreaterThanOrEqual(0);
  expect(field!.x + field!.width).toBeLessThanOrEqual(width);
  expect(field!.height).toBeGreaterThanOrEqual(40);
  expect(button!.x).toBeGreaterThanOrEqual(field!.x);
  expect(button!.x + button!.width).toBeLessThanOrEqual(field!.x + field!.width);
  expect(Math.min(button!.width, button!.height)).toBeGreaterThanOrEqual(40);
  if (bar) expect(field!.y + field!.height).toBeLessThanOrEqual(bar.y);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

for (const width of [320, 390]) {
  test.describe(`${width}px phone`, () => {
    test.use({ hasTouch: true, isMobile: true });
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width, height: 740 });
      await stub(page);
    });

    test('Tasks: a URL query that matches nothing can be cleared, then a typed query is sent with the status filter', async ({ page }) => {
      const requests = recordRequests(page, '/api/tasks');
      await page.goto('/tasks?status=failed&search=zzz-no-such-task');
      const search = page.getByRole('textbox', { name: 'Search tasks' });
      await expect(search).toBeVisible();
      await expect(search).toHaveValue('zzz-no-such-task');
      await expect(page.getByText(/No tasks found/)).toBeVisible();
      expect(requests.some(params => params.get('search') === 'zzz-no-such-task' && params.get('status') === 'failed')).toBe(true);
      await expectUsable(page, search, width);
      await capture(page, `tasks-search-no-results-${width}`);

      await page.getByRole('button', { name: 'Clear search', exact: true }).tap();
      await expect(search).toHaveValue('');
      await expect(search).toBeFocused();
      await expect(page).not.toHaveURL(/search=/);
      await expect(page).toHaveURL(/status=failed/);
      await expect(page.locator('[data-testid="task-card"]').first()).toBeVisible();
      expect(requests.at(-1)!.get('search')).toBeNull();
      expect(requests.at(-1)!.get('status')).toBe('failed');

      await page.getByRole('combobox', { name: 'Task status' }).selectOption('all');
      await search.fill('webhook');
      await expect(page).toHaveURL(/search=webhook/);
      await expect(page.locator('[data-testid="task-card"]')).toHaveCount(1);
      await expect(page.locator('[data-testid="task-card"]')).toContainText('Retry webhook deliveries');
      expect(requests.at(-1)!.get('search')).toBe('webhook');
      await expectUsable(page, search, width);
      await capture(page, `tasks-search-${width}`);
    });

    test('Plans: search is sent with the repository and status filters, and a no-results query clears back to the list', async ({ page }) => {
      const requests = recordRequests(page, '/api/planner/drafts');
      await page.goto('/plans?status=draft&repository=integry%2Fpropr&search=nothing-here');
      const search = page.getByRole('textbox', { name: 'Search plans' });
      await expect(search).toHaveValue('nothing-here');
      await expect(page.getByText('No plans found matching "nothing-here"')).toBeVisible();
      expect(requests.some(params => params.get('search') === 'nothing-here' && params.get('status') === 'draft' && params.get('repository') === 'integry/propr')).toBe(true);
      await expectUsable(page, search, width);
      await capture(page, `plans-search-no-results-${width}`);

      await page.getByRole('button', { name: 'Clear search', exact: true }).tap();
      await expect(search).toHaveValue('');
      await expect(page).not.toHaveURL(/search=/);
      await expect(page).toHaveURL(/status=draft/);
      await expect(page).toHaveURL(/repository=integry%2Fpropr/);
      await expect(page.getByText('Mobile search for list pages').first()).toBeVisible();

      await search.fill('mobile');
      await expect(page).toHaveURL(/search=mobile/);
      await expect(page).toHaveURL(/page=1/);
      await expect.poll(() => requests.at(-1)?.get('search')).toBe('mobile');
      expect(requests.at(-1)!.get('status')).toBe('draft');
      expect(requests.at(-1)!.get('repository')).toBe('integry/propr');
      await expect(page.getByText('Mobile search for list pages').first()).toBeVisible();
      await expectUsable(page, search, width);
      await capture(page, `plans-search-${width}`);
    });

    test('Tasks: typing carries on in the same focused field while a searched reload is pending', async ({ page }) => {
      await delaySearchedRequests(page, '/api/tasks');
      const requests = recordRequests(page, '/api/tasks');
      await page.goto('/tasks?status=completed&page=2');
      const search = page.getByRole('textbox', { name: 'Search tasks' });
      const cards = page.locator('[data-testid="task-card"]');
      await expect(cards.first()).toBeVisible();

      await typeAcrossPendingReload(page, search, { requests, skeleton: page.getByTestId('tasks-skeleton'), first: 'w', next: 'e', preview: `tasks-search-pending-${width}` });
      // The search resets to the first page and keeps the status filter.
      expect(requests.at(-1)!.get('offset')).toBe('0');
      expect(requests.at(-1)!.get('status')).toBe('completed');
      await expect(page).not.toHaveURL(/page=/);
      await expect(page).toHaveURL(/status=completed/);
      // "Retry webhook deliveries" and "Cache repository indexes between runs".
      await expect(cards).toHaveCount(2);
      await expect(cards.filter({ hasText: 'Retry webhook deliveries' })).toHaveCount(1);
      await expect(cards.filter({ hasText: 'Cache repository indexes between runs' })).toHaveCount(1);
      await expect(search).toBeFocused();
      await expectUsable(page, search, width);
    });

    test('Plans: typing carries on in the same focused field while a searched reload is pending', async ({ page }) => {
      await delaySearchedRequests(page, '/api/planner/drafts');
      const requests = recordRequests(page, '/api/planner/drafts');
      await page.goto('/plans?status=review&repository=integry%2Fpropr&page=2');
      const search = page.getByRole('textbox', { name: 'Search plans' });
      await expect(page.getByText('Retry webhook deliveries').first()).toBeVisible();

      await typeAcrossPendingReload(page, search, { requests, skeleton: page.getByTestId('plans-skeleton'), first: 'w', next: 'e', preview: `plans-search-pending-${width}` });
      expect(requests.at(-1)!.get('status')).toBe('review');
      expect(requests.at(-1)!.get('repository')).toBe('integry/propr');
      expect(requests.at(-1)!.get('page')).toBe('1');
      await expect(page).toHaveURL(/page=1/);
      await expect(page).toHaveURL(/status=review/);
      await expect(page).toHaveURL(/repository=integry%2Fpropr/);
      await expect(page.getByText('Retry webhook deliveries').first()).toBeVisible();
      await expect(search).toBeFocused();
      await expectUsable(page, search, width);
    });

    test('Goals: search narrows the queue, keeps the status filter, and a URL query with no matches clears from the field', async ({ page }) => {
      await page.goto('/goals?status=running&search=nonexistent');
      const search = page.getByRole('textbox', { name: 'Search goals' });
      await expect(search).toHaveValue('nonexistent');
      await expect(page.getByText('No goals match “nonexistent”')).toBeVisible();
      await expectUsable(page, search, width);
      await capture(page, `goals-search-no-results-${width}`);

      await page.getByRole('button', { name: 'Clear search', exact: true }).tap();
      await expect(search).toHaveValue('');
      await expect(page).not.toHaveURL(/search=/);
      await expect(page).toHaveURL(/status=running/);
      const queue = page.getByRole('list', { name: 'Goal work queue' });
      await expect(queue.getByRole('listitem')).toHaveCount(2);

      await search.fill('billing');
      await expect(page).toHaveURL(/search=billing/);
      await expect(queue.getByRole('listitem')).toHaveCount(1);
      await expect(queue).toContainText('Prepare Billing API');
      await expectUsable(page, search, width);
      await capture(page, `goals-search-${width}`);
    });
  });
}

test('desktop keeps search inline beside the filters, with no phone row', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await stub(page);
  for (const [path, label, filter] of [['/tasks', 'Search tasks', 'Task status'], ['/plans', 'Search plans', null], ['/goals', 'Search goals', 'Filter goals by status']] as const) {
    await page.goto(path);
    const search = page.getByRole('textbox', { name: label });
    await expect(search).toHaveCount(1);
    await expect(search).toBeVisible();
    // Same line as the page title.
    const [title, field] = await Promise.all([page.getByRole('heading', { level: 1 }).first().boundingBox(), search.boundingBox()]);
    expect(Math.abs(title!.y + title!.height / 2 - (field!.y + field!.height / 2))).toBeLessThan(6);
    if (filter) {
      const select = await page.getByRole('combobox', { name: filter }).boundingBox();
      expect(field!.x + field!.width).toBeLessThanOrEqual(select!.x);
    }
  }
  await page.goto('/tasks?search=webhook');
  await expect(page.getByRole('textbox', { name: 'Search tasks' })).toHaveValue('webhook');
  await expect(page.getByRole('button', { name: 'Clear search', exact: true })).toBeVisible();
  await capture(page, 'tasks-search-1280');
});
