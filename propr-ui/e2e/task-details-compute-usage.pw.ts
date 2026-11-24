import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

const taskId = 'task-compute-usage-3762';
const at = (minute: number, second = 0) => `2026-11-24T08:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}.000Z`;
const GIB = 1024 ** 3;

const computeUsage = {
  runtime: 'docker', wallTimeMs: 1_012_000, cpuSeconds: 384.6, peakMemoryBytes: 1.4 * GIB, avgMemoryBytes: 0.9 * GIB,
  costUsd: 0.0171, costSource: 'rate_table',
};

async function fixture(page: Page) {
  await page.routeWebSocket('**/socket.io/**', socket => socket.close());
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    const responses: Record<string, unknown> = {
      '/api/auth/demo-mode': { demoMode: true },
      [`/api/task/${taskId}/history`]: {
        history: [
          { state: 'PENDING', timestamp: at(1), metadata: { model: 'claude-opus-5-5' } },
          { state: 'PROCESSING', timestamp: at(1, 4) },
          { state: 'CLAUDE_EXECUTION', timestamp: at(2), reason: 'Agent execution started' },
          {
            state: 'CLAUDE_EXECUTION', timestamp: at(18, 54), reason: 'claude agent execution completed',
            metadata: {
              model: 'claude-opus-5-5', computeUsage,
              tokenUsage: { input_tokens: 48_200, cache_read_input_tokens: 2_310_000, cache_creation_input_tokens: 182_000, output_tokens: 41_300 },
            },
          },
          { state: 'POST_PROCESSING', timestamp: at(19) },
          { state: 'COMPLETED', timestamp: at(19, 40) },
        ],
        taskInfo: { title: 'Record compute usage and cost per agent run', type: 'issue', number: 3762, issueNumber: 3762, repoOwner: 'acme', repoName: 'web', modelName: 'claude-opus-5-5' },
        usageMetricRecords: [],
      },
      [`/api/task/${taskId}/live-details`]: { events: [], todos: [], currentTask: null },
      '/api/notifications/unread-count': { unreadCount: 0 },
      '/api/notifications/preferences': { preferences: {}, quietHours: {}, badgeEnabled: false },
    };
    return route.fulfill(path in responses ? { json: responses[path] } : { status: 503, json: { error: 'Unavailable in compute usage fixture' } });
  });
}

for (const width of [390, 1440]) {
  test(`the run summary shows compute usage beside token usage at ${width}px`, async ({ page }) => {
    await fixture(page);
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/tasks/${taskId}`);
    const consumption = page.getByRole('group', { name: 'Consumption' }).locator('visible=true').first();
    await expect(consumption).toContainText('↑2.5M↓41.3k');
    const chip = consumption.getByTestId('compute-usage-chip');
    await expect(chip).toHaveText('16m 52s · 384.6 CPU-s · 1.4 GiB peak · $0.02');
    await expect(chip).toHaveAttribute('title', /Runtime: docker .*Average memory: 922 MiB .*Compute cost: \$0\.02 \(from the rate table\)/);
    if (process.env.PROPR_CAPTURE_PREVIEWS) {
      await mkdir('../.propr/previews', { recursive: true });
      await page.screenshot({ animations: 'disabled', path: `../.propr/previews/task-compute-usage-${width}.png` });
    }
  });
}
