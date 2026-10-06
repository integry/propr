import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

const taskId = 'task-steer-2742';
const at = (minute: number, second = 0) => `2026-10-06T15:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}.000Z`;

const deliveredSteer = {
  id: 'steer-1', sequence: 1, taskId, author: 'octocat', authorSource: 'session',
  message: 'Keep the public API unchanged; extend the existing retry helper instead of adding a new one.',
  createdAt: at(12), deliveredAt: at(12, 2), delivery: 'live', acknowledgedAt: at(12, 2),
};

async function fixture(page: Page, steering: Record<string, unknown>) {
  await page.routeWebSocket('**/socket.io/**', socket => socket.close());
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    const responses: Record<string, unknown> = {
      '/api/auth/demo-mode': { demoMode: true },
      [`/api/task/${taskId}/history`]: {
        history: [
          { state: 'PENDING', timestamp: at(10), metadata: { model: 'claude-opus-5-5' } },
          { state: 'PROCESSING', timestamp: at(10, 4), reason: 'Agent execution started' },
        ],
        taskInfo: { title: 'Retry transient webhook delivery failures', type: 'issue', number: 2742, issueNumber: 2742, repoOwner: 'acme', repoName: 'web', modelName: 'claude-opus-5-5' },
        usageMetricRecords: [],
      },
      [`/api/task/${taskId}/live-details`]: {
        events: [
          { type: 'thought', timestamp: at(11), content: 'Reading the webhook dispatcher to find where failures are retried.' },
          { type: 'tool_use', timestamp: at(11, 20), toolName: 'Read', input: { file_path: '/home/node/workspace/src/webhooks/dispatcher.ts' } },
          { type: 'thought', timestamp: at(12, 10), content: 'Extending the existing retry helper rather than adding a new one.' },
        ],
        todos: [],
        currentTask: null,
      },
      [`/api/tasks/${taskId}/steers`]: steering,
      [`/api/task/${taskId}/file-changes`]: { taskId, lastUpdated: at(12, 30), files: [] },
      '/api/notifications/unread-count': { unreadCount: 0 },
      '/api/notifications/preferences': { preferences: {}, quietHours: {}, badgeEnabled: false },
    };
    return route.fulfill(path in responses ? { json: responses[path] } : { status: 503, json: { error: 'Unavailable in steering fixture' } });
  });
}

async function capture(page: Page, name: string) {
  if (!process.env.PROPR_CAPTURE_PREVIEWS) return;
  await mkdir('../.propr/previews', { recursive: true });
  await page.screenshot({ animations: 'disabled', path: `../.propr/previews/${name}.png` });
}

const live = { steers: [deliveredSteer], running: true, capability: 'live', agentAlias: 'claude-default', agentType: 'claude', maxMessageLength: 4000, maxSteersPerRun: 20 };

for (const width of [390, 1440]) {
  test(`a running Claude task can be steered next to its live log at ${width}px`, async ({ page }) => {
    await fixture(page, live);
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/tasks/${taskId}`);
    const panel = page.getByTestId('task-steering-panel');
    await panel.scrollIntoViewIfNeeded();
    await expect(panel).toContainText('Operator input during the run');
    await expect(panel).toContainText('octocat · Delivered');
    await panel.getByLabel('Steer the running agent').fill('Also cover the 429 response with Retry-After.');
    await expect(panel.getByRole('button', { name: /send/i })).toBeEnabled();
    await capture(page, `task-steering-${width}`);
  });
}

for (const { agentType, capability } of [{ agentType: 'antigravity', capability: 'next-step' }, { agentType: 'codex', capability: 'live' }]) {
  test(`a running ${agentType} task can be steered (${capability})`, async ({ page }) => {
    await fixture(page, { ...live, steers: [], capability, agentAlias: `${agentType}-default`, agentType });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/tasks/${taskId}`);
    const panel = page.getByTestId('task-steering-panel');
    await panel.scrollIntoViewIfNeeded();
    await panel.getByLabel('Steer the running agent').fill('Keep the public API unchanged.');
    await expect(panel.getByRole('button', { name: /send/i })).toBeEnabled();
    await expect(panel).toContainText(`Delivered once to the running ${agentType} (${capability})`);
    await capture(page, `task-steering-${agentType}-1440`);
  });
}

test('a running task whose agent cannot be steered explains its capability', async ({ page }) => {
  await fixture(page, { ...live, steers: [], capability: 'none', agentAlias: 'opencode-default', agentType: 'opencode' });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/tasks/${taskId}`);
  const panel = page.getByTestId('task-steering-panel');
  await expect(panel).toContainText('The opencode agent cannot receive input during a task run (steering capability: none)');
  await expect(panel.getByLabel('Steer the running agent')).toHaveCount(0);
  await capture(page, 'task-steering-unsupported-1440');
});
