import { expect, test, type Page } from '@playwright/test';

const timestamp = '2026-09-10T00:00:00.000Z';

const goal = {
  id: 'goal-1', owner: 'operator', repository: 'acme/web',
  title: 'Launch Customer Analytics Dashboard',
  objective: 'Ship the dashboard with bounded queue content beside the desktop navigation.',
  launchStrategy: 'orchestrate', initialPrompt: '/goal Ship the dashboard', attachments: [],
  baseBranch: null, branchName: 'goal/dashboard', worktreePath: '/tmp/goal-dashboard',
  agent: { id: 'agent-1', alias: 'codex', type: 'codex' },
  requestedModel: 'gpt-5.6-sol', effectiveModel: 'gpt-5.6-sol',
  maxParallelTasks: 3, ultrafix: true, desiredState: 'running', resultState: null,
  failureReason: null, pausePending: false,
  control: { requestGeneration: 0, acknowledgedGeneration: 0, pending: false },
  taskId: 'goal-task-1', sessionId: 'thread-1', conversationId: null, finalPr: null,
  checkpoint: null, artifacts: [],
  artifactStats: { issues: 2, openIssues: 1, pullRequests: 1, openPullRequests: 1 },
  liveSummary: {
    currentTask: 'Implement responsive queue and browser coverage',
    todos: [{ id: 'todo-1', content: 'Implement responsive queue', status: 'in_progress' }],
    tokenUsage: { input_tokens: 1200, output_tokens: 400 }, nativeGoal: null,
  },
  taskState: 'claude_execution', createdAt: timestamp, updatedAt: timestamp,
  startedAt: timestamp, pausedAt: null, completedAt: null,
  elapsedMs: 120_000, activeMs: 120_000, pausedMs: 0,
};

const catalog = {
  agents: [{
    id: 'agent-1', alias: 'codex', type: 'codex', enabled: true,
    models: ['gpt-5.6-sol'], defaultModel: 'gpt-5.6-sol',
  }],
  repositories: [
    { name: 'acme/web', enabled: true },
    { name: 'acme/api', enabled: true },
  ],
};

async function stubGoalApis(page: Page): Promise<void> {
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    const { pathname } = url;
    if (pathname === '/api/auth/demo-mode') {
      await route.fulfill({ json: { demoMode: false } });
      return;
    }
    if (pathname === '/api/auth/user') {
      await route.fulfill({ json: {
        id: 'user-1', login: 'operator', username: 'operator', displayName: 'Operations',
        email: null, avatarUrl: null, role: 'admin', permissions: [], authorizationSource: 'local',
      } });
      return;
    }
    if (pathname === '/api/instance/catalog') {
      await route.fulfill({ json: catalog });
      return;
    }
    if (pathname === '/api/goals/capabilities') {
      await route.fulfill({ json: { agents: [{
        agentId: 'agent-1', agentAlias: 'codex', agentType: 'codex', goalCapable: true,
        lifecycle: { launch: 'native-goal', resume: 'native-goal', runningInput: 'live-steer' },
        controls: { liveInput: true, inputAtBoundary: true, modelAtBoundary: true, pauseAtBoundary: true },
        models: ['gpt-5.6-sol'], defaultModel: 'gpt-5.6-sol',
      }] } });
      return;
    }
    if (pathname === '/api/goals' && route.request().method() === 'GET') {
      // A busy row beside a settled one: both must measure the same on the desktop table.
      await route.fulfill({ json: { goals: [goal, {
        ...goal, id: 'goal-2', repository: 'acme/api', title: 'Prepare Billing API',
        resultState: 'completed',
        artifactStats: { issues: 0, openIssues: 0, pullRequests: 0, openPullRequests: 0 },
        liveSummary: { ...goal.liveSummary, currentTask: null, todos: [] },
      }] } });
      return;
    }
    if (pathname === '/api/tasks') {
      await route.fulfill({ json: { tasks: [], total: 0 } });
      return;
    }
    if (pathname === '/api/notifications/unread-count') {
      await route.fulfill({ json: { unreadCount: 0 } });
      return;
    }
    if (pathname === '/api/notifications/preferences') {
      await route.fulfill({ json: { preferences: {}, quietHours: { start: null, end: null, timezone: 'UTC' }, badgeEnabled: false } });
      return;
    }
    await route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'Unavailable in goals browser regression fixture' }),
    });
  });
}

async function contentWidths(page: Page) {
  return page.evaluate(() => {
    const workQueue = document.querySelector('[aria-label="Goal work queue"]');
    const main = document.querySelector('main');
    if (!(workQueue instanceof HTMLElement) || !(main instanceof HTMLElement)) {
      throw new Error('Goal work queue layout was not rendered');
    }
    return {
      queueClientWidth: workQueue.clientWidth,
      queueScrollWidth: workQueue.scrollWidth,
      mainClientWidth: main.clientWidth,
      mainScrollWidth: main.scrollWidth,
    };
  });
}

// Every desktop row holds the same height, whatever its status, activity or artifact counts.
async function rowHeights(page: Page) {
  return page.evaluate(() => Array.from(
    document.querySelectorAll('[aria-label="Goal work queue"] a'),
    row => Math.round(row.getBoundingClientRect().height),
  ));
}

test.beforeEach(async ({ page }) => {
  await stubGoalApis(page);
});

test('keeps the goal work queue within the available 1024px desktop content width', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 820 });
  await page.goto('/goals');

  const queue = page.getByRole('list', { name: 'Goal work queue' });
  await expect(queue.getByRole('link')).toHaveCount(2);
  const dimensions = await contentWidths(page);

  expect(dimensions.queueScrollWidth).toBeLessThanOrEqual(dimensions.queueClientWidth);
  expect(dimensions.mainScrollWidth).toBeLessThanOrEqual(dimensions.mainClientWidth);
  // A narrow desktop keeps the table and drops the two secondary measures instead of stacking cards.
  await expect(page.getByTestId('goal-queue-columns')).toBeVisible();
  await expect(page.getByTestId('goal-queue-column-tokens')).toBeHidden();
  await expect(page.getByTestId('goal-queue-column-active-time')).toBeHidden();
  expect(await rowHeights(page)).toEqual([64, 64]);

  await page.setViewportSize({ width: 1280, height: 820 });
  await expect(page.getByTestId('goal-queue-columns')).toBeVisible();
  await expect(page.getByTestId('goal-queue-column-tokens')).toBeVisible();
  await expect(page.getByTestId('goal-queue-column-active-time')).toBeVisible();
  expect(await rowHeights(page)).toEqual([64, 64]);
  const wideDimensions = await contentWidths(page);
  expect(wideDimensions.queueScrollWidth).toBeLessThanOrEqual(wideDimensions.queueClientWidth);
  expect(wideDimensions.mainScrollWidth).toBeLessThanOrEqual(wideDimensions.mainClientWidth);
});

test('dismisses the repository picker before the dirty goal creator on Escape', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 820 });
  await page.goto('/goals');
  await page.getByRole('button', { name: 'New goal' }).click();

  const creator = page.getByRole('dialog', { name: 'Start a goal' });
  await expect(creator).toBeVisible();
  await creator.getByLabel('Objective').fill('Preserve this browser-tested draft');
  await creator.getByRole('button', { name: /acme.*web/i }).click();
  const repositoryFilter = creator.getByPlaceholder('Filter repositories...');
  await expect(repositoryFilter).toBeFocused();

  let discardPrompts = 0;
  page.on('dialog', async dialog => {
    discardPrompts += 1;
    await dialog.dismiss();
  });
  await repositoryFilter.press('Escape');

  await expect(repositoryFilter).toBeHidden();
  await expect(creator).toBeVisible();
  await expect(creator.getByLabel('Objective')).toHaveValue('Preserve this browser-tested draft');
  expect(discardPrompts).toBe(0);
});
