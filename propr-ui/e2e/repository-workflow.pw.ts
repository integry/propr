import { expect, test } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { fixture } from './dashboard-sections.fixture';

test('task history displays the pinned repository workflow revision', async ({ page }) => {
  await fixture(page, { width: 1440, height: 1000 });
  await page.routeWebSocket('**/socket.io/**', socket => socket.close());
  const revision = '7cfa835a15fdcd9482f79a5c5eb4868b489c1f25';
  await page.route('**/api/task/workflow-example/**', route => {
    const endpoint = new URL(route.request().url()).pathname.split('/').at(-1);
    const responses: Record<string, unknown> = {
      history: {
        history: [
          { state: 'pending', timestamp: '2026-09-30T12:00:00Z' },
          { state: 'processing', timestamp: '2026-09-30T12:00:02Z', metadata: { repositoryWorkflow: {
            path: '.propr/workflow.yml', baseBranch: 'release/2.0', revision,
            fileRevision: '034bf6d905b5e34d4e58c78f526de68ebd719284', maxParallelTasks: 3, timeoutMs: 600000,
          } } },
          { state: 'claude_execution', timestamp: '2026-09-30T12:00:05Z', reason: 'Implementation started' },
          { state: 'completed', timestamp: '2026-09-30T12:02:05Z' },
        ],
        taskInfo: { title: 'Apply repository workflow policy', type: 'issue', number: 42, issueNumber: 42, repoOwner: 'example', repoName: 'workspace', modelName: 'gpt-6-astra' },
        usageMetricRecords: [],
      },
      'live-details': { events: [], todos: [], currentTask: null },
      'file-changes': { taskId: 'workflow-example', lastUpdated: '2026-09-30T12:02:05Z', files: [] },
      analysis: { analysis: { analysis: JSON.stringify({ summary_of_changes: 'Repository instructions applied. Validation: npm test and npm run lint passed.' }) } },
    };
    return route.fulfill({ json: responses[endpoint!] ?? {} });
  });
  await page.goto('/tasks/workflow-example');
  const workflow = page.getByTitle(`Base commit: ${revision}; workflow blob: 034bf6d905b5e34d4e58c78f526de68ebd719284`);
  await expect(workflow).toBeVisible();
  await expect(workflow).toHaveAttribute('title', `Base commit: ${revision}; workflow blob: 034bf6d905b5e34d4e58c78f526de68ebd719284`);
  if (process.env.PROPR_CAPTURE_PREVIEWS) {
    await mkdir('../.propr/previews', { recursive: true });
    const bounds = await page.getByTestId('task-details').boundingBox();
    await page.screenshot({ path: '../.propr/previews/repository-workflow.png', animations: 'disabled', clip: { ...bounds!, height: Math.min(bounds!.height, 430) } });
  }
});
