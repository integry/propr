import { expect, test, type Locator, type Page } from '@playwright/test';
import { capture, now, ago, tasks } from './task-list-desktop.fixture';

// A list search that is cleared just before the user leaves must not navigate back to the
// list while the destination's lazy route chunk is still loading. The departing list stays
// mounted during that transition, with its debounced search write still pending.

const QUERY = 'propr-validation-no-match';
// Longer than every list's search debounce (Tasks/Goals 400ms, Plans 300ms).
const PAST_DEBOUNCE_MS = 1_000;

const goal = (id: string, title: string) => ({
  id, owner: 'operator', repository: 'integry/propr', title, objective: `${title} for the release.`,
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
const goals = [goal('goal-1', 'Launch Customer Analytics Dashboard'), goal('goal-2', 'Prepare Billing API')];
const drafts = [
  { draft_id: 'draft-1', repository: 'integry/propr', name: 'Mobile search for list pages', initial_prompt: 'Mobile search', status: 'draft', updated_at: ago(30), created_at: ago(90) },
];

const matches = (text: string, search: string | null) => !search || text.toLowerCase().includes(search.toLowerCase());

async function stub(page: Page) {
  await page.clock.install({ time: now });
  await page.routeWebSocket('**/socket.io/**', socket => socket.close());
  await page.route('**/api/**', route => {
    const url = new URL(route.request().url());
    const search = url.searchParams.get('search');
    const responses: Record<string, unknown> = {
      '/api/auth/demo-mode': { demoMode: false },
      '/api/auth/user': { id: 'user-1', login: 'operator', username: 'operator', displayName: 'Operations', email: null, avatarUrl: null, role: 'admin', permissions: [], authorizationSource: 'local' },
      '/api/instance/catalog': { agents: [{ id: 'agent-1', alias: 'codex', type: 'codex', enabled: true, models: ['gpt-6-astra'], defaultModel: 'gpt-6-astra' }], repositories: [{ name: 'integry/propr', enabled: true }] },
      '/api/tasks': (() => {
        const found = tasks.filter(task => matches(task.title, search));
        return { tasks: found, total: found.length, totalRuns: found.length };
      })(),
      '/api/stats/repositories': { repositories: [{ repository: 'integry/propr', total: 30, completed: 20, failed: 2, inProgress: 1, successRate: 80 }] },
      '/api/planner/drafts': (() => {
        const found = drafts.filter(item => matches(item.name, search));
        return { drafts: found, total: found.length, page: 1, limit: 50, hasMore: false };
      })(),
      '/api/planner/drafts/repositories': { repositories: [{ repo: 'integry/propr', count: 1 }], total: 1 },
      '/api/goals': { goals },
      '/api/queue/stats': { active: 0, waiting: 0, completed: 0, failed: 0 },
      '/api/stats/generating-plans': { count: 0 },
      '/api/notifications/unread-count': { unreadCount: 0 },
      '/api/notifications/preferences': { preferences: {}, quietHours: { start: null, end: null, timezone: 'UTC' }, badgeEnabled: false },
    };
    return url.pathname in responses
      ? route.fulfill({ json: responses[url.pathname] })
      : route.fulfill({ status: 503, json: { error: 'Unavailable in lazy navigation fixture' } });
  });
}

/**
 * Holds the real built Settings route chunk until `release` is called, then lets the
 * original, unchanged response through.
 */
async function holdSettingsChunk(page: Page) {
  let release!: () => void;
  const released = new Promise<void>(resolve => { release = resolve; });
  let requested!: () => void;
  const wasRequested = new Promise<void>(resolve => { requested = resolve; });
  await page.route(/\/assets\/SettingsPage-[\w-]+\.js$/, async route => {
    requested();
    await released;
    await route.continue();
  });
  return { wasRequested, release };
}

/** Stops the page's timers (the installed clock) from here until the test advances them. */
const pauseTimers = async (page: Page) => page.clock.pauseAt(await page.evaluate(() => Date.now()) + 50);

const routePath = (page: Page) => page.evaluate(() => window.location.pathname);
const routeSearch = (page: Page) => page.evaluate(() => window.location.search);

// Goals and Plans write a cleared search at once; Tasks writes it through its debounce.
const lists = [
  { name: 'Tasks', path: '/tasks', label: 'Search tasks', clearsAtOnce: false },
  { name: 'Plans', path: '/plans', label: 'Search plans', clearsAtOnce: true },
  { name: 'Goals', path: '/goals', label: 'Search goals', clearsAtOnce: true },
] as const;

const viewports = [
  { name: '320', width: 320, height: 640, phone: true },
  { name: '390', width: 390, height: 844, phone: true },
  { name: 'desktop', width: 1280, height: 800, phone: false },
] as const;

// The web build's BrowserRouter. The native HashRouter only exists in the desktop
// renderer build; hooks.lazyRoute.test.tsx covers it with the same lazy transition.
for (const viewport of viewports) {
  test.describe(`${viewport.name}`, () => {
    test.use({ hasTouch: viewport.phone, isMobile: viewport.phone });
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await stub(page);
    });

    const press = async (locator: Locator) => (viewport.phone ? locator.tap() : locator.click());
    const openSettings = async (page: Page) => {
      if (viewport.phone) {
        await press(page.getByRole('navigation', { name: 'Primary navigation' }).getByRole('button', { name: 'More' }));
        await press(page.getByRole('dialog', { name: 'ProPR', exact: true }).getByRole('link', { name: 'Settings', exact: true }));
      } else {
        await press(page.locator('aside').first().getByRole('link', { name: 'Settings', exact: true }));
      }
    };
    const visit = async (page: Page, path: string) => {
      await page.goto(path);
      await expect.poll(() => routePath(page)).toBe(path);
    };

    /** Leaves for Settings while its chunk is held, and checks the list never takes the URL back. */
    /**
     * Leaves for Settings while its chunk is held, with the page's timers paused since the
     * list edit, so a pending debounce is certain to still be queued when the route changes.
     */
    const leaveForDelayedSettings = async (page: Page, list: typeof lists[number], chunk: Awaited<ReturnType<typeof holdSettingsChunk>>, preview?: string) => {
      await openSettings(page);
      await chunk.wasRequested;
      await expect.poll(() => routePath(page)).toBe('/settings');
      // Every list search debounce elapses while the destination is still loading.
      await page.clock.runFor(PAST_DEBOUNCE_MS);
      expect(await routePath(page)).toBe('/settings');
      await page.clock.resume();

      chunk.release();
      await expect(page.getByRole('heading', { name: 'Settings', exact: true }).first()).toBeVisible();
      expect(await routePath(page)).toBe('/settings');
      await page.waitForTimeout(PAST_DEBOUNCE_MS);
      expect(await routePath(page)).toBe('/settings');
      await expect(page.getByRole('textbox', { name: list.label })).toHaveCount(0);
      if (preview) await capture(page, preview);

      // Back still returns to the list, without the cleared search.
      await page.goBack();
      await expect.poll(() => routePath(page)).toBe(list.path);
      await expect(page.getByRole('textbox', { name: list.label })).toHaveValue('');
      expect(await routeSearch(page)).not.toContain('search=');
    };

    for (const list of lists) {
      test(`${list.name}: a cleared search does not pull navigation back while Settings loads`, async ({ page }) => {
        const chunk = await holdSettingsChunk(page);
        await visit(page, list.path);
        const search = page.getByRole('textbox', { name: list.label });
        await expect(search).toBeVisible();

        await press(search);
        await page.keyboard.type(QUERY);
        await expect.poll(() => routeSearch(page)).toContain(`search=${QUERY}`);
        // Anything the clear leaves queued (Goals re-commits its debounced value) is still pending on leaving.
        if (list.clearsAtOnce) await pauseTimers(page);
        await press(page.getByRole('button', { name: 'Clear search', exact: true }));
        await expect(search).toHaveValue('');
        await expect(search).toBeFocused();
        await expect.poll(() => routeSearch(page)).not.toContain('search=');
        if (!list.clearsAtOnce) await pauseTimers(page);

        await leaveForDelayedSettings(page, list, chunk, list.name === 'Goals' ? `lazy-settings-after-goals-clear-${viewport.name}` : undefined);
      });

      test(`${list.name}: a typed search still pending does not pull navigation back while Settings loads`, async ({ page }) => {
        const chunk = await holdSettingsChunk(page);
        await visit(page, list.path);
        const search = page.getByRole('textbox', { name: list.label });
        await expect(search).toBeVisible();

        // Leave before the debounce commits the query. The departing list must drop it.
        await press(search);
        await pauseTimers(page);
        await page.keyboard.type(QUERY);
        await expect(search).toHaveValue(QUERY);
        expect(await routeSearch(page)).not.toContain('search=');
        await leaveForDelayedSettings(page, list, chunk);
      });
    }

    test('control: with no list edit, Settings still loads behind the held chunk', async ({ page }) => {
      const chunk = await holdSettingsChunk(page);
      await visit(page, '/goals');
      await expect(page.getByRole('textbox', { name: 'Search goals' })).toBeVisible();
      await pauseTimers(page);
      await leaveForDelayedSettings(page, lists[2], chunk);
    });
  });
}
