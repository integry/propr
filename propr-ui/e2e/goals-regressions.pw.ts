import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

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

const checkpointDeclaration = JSON.stringify({
  checkpointReady: true,
  message: 'feat(goals): publish stable dashboard slice',
  include: ['src/dashboard.tsx', 'src/dashboard.css', 'test/dashboard.test.tsx'],
  exclude: ['src/follow-up.ts'],
  summary: 'The responsive dashboard and its focused coverage are ready.',
});

async function stubGoalApis(page: Page): Promise<void> {
  await page.routeWebSocket('**/socket.io/**', socket => socket.close());
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
    if (pathname === '/api/goals/goal-1') {
      await route.fulfill({ json: { goal: {
        ...goal,
        launchStrategy: 'direct',
        checkpoint: {
          intervalMinutes: 15, count: 1, lastAt: timestamp, lastCommitSha: 'abc1234', error: null, pending: false,
          latest: {
            kind: 'agent', state: 'completed', message: 'feat(goals): publish stable dashboard slice',
            summary: 'The responsive dashboard and its focused coverage are ready.',
            include: ['src/dashboard.tsx', 'src/dashboard.css', 'test/dashboard.test.tsx'],
            exclude: ['src/follow-up.ts'], commitSha: 'abc1234', error: null,
          },
        },
      } } });
      return;
    }
    if (pathname === '/api/task/goal-task-1/live-details') {
      await route.fulfill({ json: {
        events: [
          { id: 'thought-1', type: 'thought', content: 'The focused tests pass and the stable slice is ready.', timestamp },
          { id: 'checkpoint-1', type: 'thought', content: checkpointDeclaration, timestamp: '2026-09-10T00:01:30.000Z' },
          { id: 'thought-2', type: 'thought', content: 'Continuing with the remaining dashboard polish.', timestamp: '2026-09-10T00:01:40.000Z' },
        ],
        todos: [], currentTask: null, tokenUsage: { input_tokens: 1200, output_tokens: 400 },
      } });
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
  await page.routeWebSocket('**/socket.io/**', socket => socket.close());
  await page.clock.install({ time: Date.parse(timestamp) + 120_000 });
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
  if (process.env.PROPR_CAPTURE_PREVIEWS) {
    await mkdir('../.propr/previews', { recursive: true });
    await page.screenshot({ path: '../.propr/previews/goals-queue.png', animations: 'disabled' });
  }
});

test('dismisses the repository picker before the dirty goal creator on Escape', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 820 });
  await page.goto('/goals');
  await page.getByRole('button', { name: 'New Goal', exact: true }).click();

  const creator = page.getByRole('dialog', { name: 'Start a goal' });
  await expect(creator).toBeVisible();
  await creator.getByLabel('Prompt').fill('Preserve this browser-tested draft');
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
  await expect(creator.getByLabel('Prompt')).toHaveValue('Preserve this browser-tested draft');
  expect(discardPrompts).toBe(0);
});

test('highlights checkpoint declarations in the readable goal log', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/goals/goal-1');

  const checkpoint = page.getByTestId('goal-checkpoint-event');
  await expect(checkpoint).toBeVisible();
  await expect(checkpoint.getByText('CHECKPOINT', { exact: true })).toBeVisible();
  await expect(checkpoint.getByText('feat(goals): publish stable dashboard slice')).toBeVisible();
  await expect(checkpoint.getByText('3 included · 1 excluded')).toBeVisible();
  await expect(page.getByText(checkpointDeclaration)).toHaveCount(0);
  if (process.env.PROPR_CAPTURE_PREVIEWS) {
    await mkdir('../.propr/previews', { recursive: true });
    await checkpoint.screenshot({ path: '../.propr/previews/goal-checkpoint-log.png', animations: 'disabled' });
  }
});

for (const [device, viewport] of Object.entries({ desktop: { width: 1440, height: 960 }, mobile: { width: 390, height: 844 } })) {
  test(`goal creation uses collapsed session settings and docked attachments on ${device}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto('/goals?new=1');
    const dialog = page.getByRole('dialog', { name: 'Start a goal' });
    const prompt = dialog.getByLabel('Prompt', { exact: true });
    await expect(prompt).toBeFocused();
    await expect(dialog.getByLabel('Agent', { exact: true })).toBeHidden();
    await prompt.fill('Ship the customer analytics dashboard with accessible filters and responsive charts.');
    await dialog.getByLabel('Attach files', { exact: true }).setInputFiles({ name: 'dashboard-requirements.txt', mimeType: 'text/plain', buffer: Buffer.from('Support keyboard navigation and mobile layouts.') });
    await expect(dialog.getByText('dashboard-requirements.txt')).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Start goal' })).toBeEnabled();
    if (process.env.PROPR_CAPTURE_PREVIEWS) {
      const { mkdir } = await import('node:fs/promises');
      await mkdir('../.propr/previews', { recursive: true });
      await page.screenshot({ path: `../.propr/previews/new-goal-${device}.png`, animations: 'disabled' });
    }
    await dialog.locator('summary').click();
    await expect(dialog.getByLabel('Agent', { exact: true })).toBeVisible();
    await dialog.getByLabel('Maximum parallel tasks').fill('5');
    await dialog.getByLabel('Agent orchestrates through ProPR').check();
    await expect(dialog.getByLabel('Checkpoint target cadence', { exact: true })).toHaveCount(0);
    await expect(dialog.locator('summary')).toHaveText('Advanced Options');
    if (process.env.PROPR_CAPTURE_PREVIEWS) {
      await page.screenshot({ path: `../.propr/previews/new-goal-options-${device}.png`, animations: 'disabled' });
    }
    await dialog.locator('summary').click();
    await expect(dialog.locator('summary')).toContainText('5 parallel tasks · Orchestrate');
    const submit = page.waitForRequest(request => new URL(request.url()).pathname === '/api/goals' && request.method() === 'POST');
    await page.route('**/api/goals', route => route.request().method() === 'POST'
      ? route.fulfill({ status: 503, json: { error: 'Preview submission unavailable' } })
      : route.fallback());
    await dialog.getByRole('button', { name: 'Start goal' }).click();
    const request = await submit;
    expect(request.postData()).toContain('Ship the customer analytics dashboard');
    expect(request.postData()).toContain('orchestrate');
    expect(request.postData()).toContain('dashboard-requirements.txt');
    await expect(dialog.getByRole('alert')).toBeVisible();
    await expect(prompt).toHaveValue('Ship the customer analytics dashboard with accessible filters and responsive charts.');
  });
}
