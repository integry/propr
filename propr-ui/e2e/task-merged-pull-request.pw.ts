import { expect, test, type Page } from '@playwright/test';
import { ago, capture, fixture, tag, tasks } from './task-list-desktop.fixture';

// PR #2663 has merged: its newest run is a finished fix, the run before it a review.
const prNumber = 2663;
const newest = `pr-${prNumber}-run-0`;
const title = `Fix PR #${prNumber}: ${tag(2660)} Repo-owned workflow file with lifecycle hooks (.propr/workflow.yml)`;

async function mergedPullRequest(page: Page) {
  await fixture(page);
  const merged = tasks.map(task => ('prNumber' in task && task.prNumber === prNumber ? { ...task, prState: 'merged' } : task));
  await page.route(url => url.pathname === '/api/tasks', route => route.fulfill({ json: { tasks: merged, total: 1842, totalRuns: 14769 } }));
  await page.route(`**/api/task/${newest}/history`, route => route.fulfill({ json: {
    history: [
      { state: 'PENDING', timestamp: ago(60) },
      { state: 'CLAUDE_EXECUTION', timestamp: ago(59) },
      { state: 'COMPLETED', timestamp: ago(51) },
    ],
    taskInfo: { title, subtitle: 'Include validation reports in PR follow-up completion comments', type: 'pr-comment', number: prNumber, issueNumber: prNumber, repoOwner: 'integry', repoName: 'propr', modelName: 'gpt-6-astra' },
  } }));
  await page.route(`**/api/task/${newest}/live-details`, route => route.fulfill({ json: { events: [], todos: [], currentTask: null } }));
  await page.route(`**/api/task/${newest}/file-changes`, route => route.fulfill({ json: {
    taskId: newest, lastUpdated: ago(51),
    files: [{ path: '.propr/workflow.yml', linesAdded: 6, linesRemoved: 0, status: 'modified', diff: '@@ -1,0 +1,6 @@\n+validation:\n+  report: true' }],
  } }));
  await page.route(`**/api/task/${newest}/assignees`, route => route.fulfill({ json: {
    subject: { owner: 'integry', repo: 'propr', number: prNumber, kind: 'pull_request' }, assignees: [], synced: true,
  } }));
  await page.route(`**/api/pull-requests/${prNumber}/scores**`, route => route.fulfill({ json: {
    repository: 'integry/propr', pr_number: prNumber, outcome: 'merged', merged_at: ago(40), closed_at: null, scores: [],
  } }));
}

test('1440px a merged pull request ends its run track in violet and offers no follow-up actions', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await mergedPullRequest(page);
  await page.goto(`/tasks?task=${newest}`);
  const pane = page.getByTestId('task-details');
  await expect(pane.getByText(`Merged`).filter({ visible: true }).first()).toBeVisible();

  // The row's track ends on the merge, in the violet that marks Merged alone.
  const row = page.getByTestId('task-card').filter({ hasText: 'Repo-owned workflow file' });
  const markers = row.getByTestId('run-track').locator('[data-outcome]');
  await expect(markers.last()).toHaveAttribute('data-outcome', 'merged');
  await expect(row.getByText('Merged').first()).toBeVisible();

  // A merged PR cannot be worked on: no commands, no Follow Up.
  await expect(pane.getByRole('button', { name: /^Send \// })).toHaveCount(0);
  await expect(pane.getByRole('button', { name: 'Follow Up' })).toHaveCount(0);
  await expect(pane.getByRole('button', { name: 'More task actions' }).filter({ visible: true })).toHaveCount(1);
  await capture(page, 'task-merged-pull-request-1440');
});
