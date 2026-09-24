import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

const goalId = 'goal-1';
const timestamp = '2026-09-23T09:00:00.000Z';

const todos = [
  { id: 'todo-1', content: 'Align the metadata row', status: 'completed' },
  { id: 'todo-2', content: 'Clip the session identifier inside its metric column', status: 'in_progress' },
  { id: 'todo-3', content: 'Neutralize the pending queue rows', status: 'in_progress' },
  { id: 'todo-4', content: 'Publish the evidence on the goal PR', status: 'pending' },
];

const goal = {
  id: goalId, owner: 'operator', repository: 'acme/web',
  title: 'Launch Customer Analytics Dashboard',
  objective: 'Ship the dashboard with one unambiguous current step in the execution queue.',
  launchStrategy: 'orchestrate', initialPrompt: '/goal Ship the dashboard', attachments: [],
  baseBranch: null, branchName: 'goal/dashboard', worktreePath: '/tmp/goal-dashboard',
  agent: { id: 'agent-1', alias: 'codex', type: 'codex' },
  requestedModel: 'gpt-5.6-sol', effectiveModel: 'gpt-5.6-sol',
  maxParallelTasks: 3, ultrafix: true, desiredState: 'running', resultState: null,
  failureReason: null, pausePending: false,
  control: { requestGeneration: 0, acknowledgedGeneration: 0, pending: false },
  taskId: 'goal-task-1', sessionId: '91e05dd0-c5e0-4491-95ea-cf1596f1278b', conversationId: null,
  finalPr: null, checkpoint: null, artifacts: [],
  artifactStats: { issues: 0, openIssues: 0, pullRequests: 0, openPullRequests: 0 },
  // The provider names its own current activity, which need not be the step it flagged in progress.
  liveSummary: { currentTask: 'Align the metadata row', todos, tokenUsage: { input_tokens: 1200, output_tokens: 400 }, nativeGoal: null },
  taskState: 'claude_execution', createdAt: timestamp, updatedAt: timestamp,
  startedAt: timestamp, pausedAt: null, completedAt: null,
  elapsedMs: 120_000, activeMs: 120_000, pausedMs: 0,
};

async function stub(page: Page, overrides: Record<string, unknown> = {}, live: Record<string, unknown> = {}) {
  await page.routeWebSocket('**/socket.io/**', socket => socket.close());
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    const responses: Record<string, unknown> = {
      '/api/auth/demo-mode': { demoMode: true },
      '/api/instance/catalog': { agents: [], repositories: [{ name: 'acme/web', enabled: true }] },
      '/api/goals/capabilities': { agents: [] },
      [`/api/goals/${goalId}`]: { goal: { ...goal, ...overrides } },
      [`/api/goals/${goalId}/previews`]: { previews: [] },
      '/api/task/goal-task-1/live-details': { events: [], todos, currentTask: goal.liveSummary.currentTask, ...live },
      '/api/notifications/unread-count': { unreadCount: 0 },
      '/api/notifications/preferences': { preferences: {}, quietHours: {}, badgeEnabled: false },
    };
    return route.fulfill(path in responses ? { json: responses[path] } : { status: 503, json: { error: 'Unavailable in goal queue fixture' } });
  });
}

/** Rows painted with any background of their own — the queue's "this is running now" signal. */
const highlightedRows = (page: Page) => page.locator('section:has(h2:text-is("Execution queue")) li').evaluateAll(
  nodes => nodes.filter(node => {
    const background = getComputedStyle(node).backgroundColor;
    return background !== 'rgba(0, 0, 0, 0)' && background !== 'transparent';
  }).map(node => node.textContent?.trim() || ''),
);

test('marks exactly one running step in the goal execution queue', async ({ page }) => {
  await stub(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/goals/${goalId}`);

  const queue = page.locator('section:has(h2:text-is("Execution queue"))');
  await expect(queue.getByText('Clip the session identifier inside its metric column')).toBeVisible();
  // One highlight, and it is the running step — not the completed row, not the queued rows.
  expect(await highlightedRows(page)).toEqual(['⏳Clip the session identifier inside its metric column']);
  await expect(queue.locator('[aria-current="step"]')).toHaveCount(1);
  // No second active surface restating the current step above the queue.
  await expect(queue.getByText('Current:')).toHaveCount(0);

  if (process.env.PROPR_CAPTURE_PREVIEWS) {
    await mkdir('../.propr/previews', { recursive: true });
    await queue.screenshot({ animations: 'disabled', path: '../.propr/previews/goal-execution-queue.png' });
  }
});

test('names the current activity only while no queue step is running', async ({ page }) => {
  const queued = todos.map(todo => ({ ...todo, status: todo.status === 'in_progress' ? 'pending' : todo.status }));
  await stub(page, {}, { todos: queued, currentTask: 'Collecting the published evidence' });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/goals/${goalId}`);

  const queue = page.locator('section:has(h2:text-is("Execution queue"))');
  await expect(queue.getByText('Collecting the published evidence')).toBeVisible();
  expect(await highlightedRows(page)).toEqual([]);
});

test('leaves the settled queue entirely neutral', async ({ page }) => {
  await stub(page, { resultState: 'completed', taskState: 'completed', completedAt: timestamp });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/goals/${goalId}`);

  const queue = page.locator('section:has(h2:text-is("Execution queue"))');
  await expect(queue.getByText('Publish the evidence on the goal PR')).toBeVisible();
  expect(await highlightedRows(page)).toEqual([]);
  await expect(queue.getByText('Current:')).toHaveCount(0);
});
