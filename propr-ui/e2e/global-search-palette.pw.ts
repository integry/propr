import { expect, test } from '@playwright/test';
import { captureTarget, fixture, minutesAgo } from './dashboard-sections.fixture';

const plans = [
  ['Sequential MCP Epic Execution and Observability', 'merged', 2 * 24 * 60],
  ['Expose the repository retrieval through the MCP connector', 'review', 2 * 24 * 60],
  ['MCP Observability Lifecycle and Checkpoint Waits', 'merged', 5 * 24 * 60],
  ['Improve MCP observability: submission and goal lifecycle events', 'failed', 8 * 24 * 60],
].map(([name, status, minutes], index) => ({
  draft_id: `plan-${index}`, repository: 'example/workspace', name, initial_prompt: `Plan ${name}`,
  status, created_at: minutesAgo(minutes as number), updated_at: minutesAgo(minutes as number),
  issue_summary: { total: 6, pending: 1, processing: 1, merged: 4, closed: 0 },
}));

const tasks = [
  { id: 'task-1', title: 'Add MCP connect contract reference to the operator guide', status: 'completed', prNumber: 2480, score: 9 },
  { id: 'task-2', title: 'Expose Live Agent Activity over MCP', status: 'failed', prNumber: 2471, score: 4, failedReason: 'Lint failed on src/mcp/activity.ts' },
  { id: 'task-3', title: 'Redesign Connected MCP Apps list with lifecycle hooks', status: 'processing', prNumber: null, score: null },
].map((task, index) => ({
  ...task, repository: 'example/workspace', issueNumber: 2400 + index, model: 'gpt-6-astra',
  subtitle: 'Wire the MCP surface into the activity stream.', createdAt: minutesAgo((8 + index * 4) * 24 * 60),
}));

test('global search opens a master-preview palette with category scopes', async ({ page }) => {
  await fixture(page, { width: 1440, height: 900 }, [], []);
  await page.route('**/api/planner/drafts?**', route => route.fulfill({ json: { drafts: plans, total: plans.length, page: 1, limit: 5, hasMore: false } }));
  await page.route('**/api/tasks?**', route => route.fulfill({ json: { tasks, total: tasks.length } }));
  await page.route('**/api/instance/catalog', route => route.fulfill({ json: {
    agents: [], repositories: [{ name: 'example/mcptest', enabled: true, baseBranch: 'main', alias: 'MCP test bed' }],
  } }));
  await page.goto('/');

  const input = page.getByRole('combobox', { name: 'Search' });
  await input.fill('mcp');
  const palette = page.getByTestId('global-search-palette');
  await expect(palette.getByRole('option')).toHaveCount(8);
  await input.press('ArrowDown');
  await input.press('ArrowDown');
  await expect(palette.getByTestId('global-search-preview').getByRole('heading')).toHaveText(plans[1].name);
  expect((await palette.boundingBox())!.width).toBe(640);
  await captureTarget(page.locator('body'), 'global-search-palette-plan');

  await input.press('Tab');
  await input.press('Tab');
  await input.press('Tab');
  await input.press('ArrowDown');
  await expect(palette.getByRole('option')).toHaveCount(3);
  await expect(palette.getByTestId('global-search-preview').getByRole('heading')).toHaveText(tasks[1].title);
  await captureTarget(page.locator('body'), 'global-search-palette-tasks');
});
