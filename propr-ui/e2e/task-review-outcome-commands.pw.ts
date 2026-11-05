import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { ago, capture, fixture } from './task-list-desktop.fixture';

// What `GET /api/tasks` returns for completed reviews with each recorded outcome; the API's own test asserts it.
const projectedTasks = JSON.parse(readFileSync(new URL('../src/components/TaskDetails/reviewOutcomeTasks.fixture.json', import.meta.url), 'utf8')) as Array<{
  id: string; title: string; subtitle: string; prNumber: number; modelName: string;
}>;

/** Serves the API's task projection and each review's details, recording any follow-up sent. */
async function serveProjection(page: Page, followups: string[]) {
  await fixture(page);
  // The clean review ran on a pull request an earlier run opened, so its timeline counts two runs once they are read.
  const implementation = { id: 'implementation-33', repository: 'integry/propr', prNumber: 33, title: 'Document the acceptance checklist',
    subtitle: null, status: 'completed', commandMode: null, modelName: 'gpt-6-astra', score: null, reviewOutcome: null, createdAt: '2026-10-17T23:00:00.000Z' };
  const tasks = [...projectedTasks, implementation];
  await page.route(url => url.pathname === '/api/tasks', route => route.fulfill({ json: {
    tasks: tasks.map(task => ({ ...task, repositoryOwner: 'integry', repositoryName: 'propr', issueNumber: task.prNumber, assignees: [] })),
    total: tasks.length, totalRuns: tasks.length, offset: 0, limit: 25,
  } }));
  for (const task of projectedTasks) {
    await page.route(`**/api/task/${task.id}/history`, route => route.fulfill({ json: {
      history: [
        { state: 'PENDING', timestamp: ago(60) },
        { state: 'CLAUDE_EXECUTION', timestamp: ago(59) },
        { state: 'COMPLETED', timestamp: ago(51) },
      ],
      taskInfo: { title: task.title, subtitle: task.subtitle, commandMode: 'review', type: 'pr', number: task.prNumber, issueNumber: task.prNumber,
        repoOwner: 'integry', repoName: 'propr', modelName: task.modelName },
    } }));
    await page.route(`**/api/task/${task.id}/live-details`, route => route.fulfill({ json: { events: [], todos: [], currentTask: null } }));
  }
  await page.route('**/api/tasks/*/followup', route => {
    followups.push(`${new URL(route.request().url()).pathname.split('/').at(-2)} ${route.request().postDataJSON().body}`);
    return route.fulfill({ json: { success: true, state: 'queued' } });
  });
}

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test(`${viewport.width}px a confirmed clean review offers no /fix; findings, a failed reviewer or an unknown outcome keep it`, async ({ page }) => {
    const followups: string[] = [];
    await page.setViewportSize(viewport);
    await serveProjection(page, followups);
    const fix = (prNumber: number) => page.getByRole('button', { name: `Send /fix to PR #${prNumber}` }).filter({ visible: true });

    await page.goto('/tasks/review-clean');
    await expect(page.getByTestId('task-details')).toContainText('Review PR #33');
    // Commands follow the task's runs, so their absence is checked only once the runs are read.
    await expect(page.getByTestId('timeline-run-count').filter({ visible: true })).toHaveText('(2 runs)');
    await expect(page.getByRole('button', { name: 'Follow Up' }).filter({ visible: true }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: /^Send \// })).toHaveCount(0);
    await capture(page, `task-review-outcome-clean-${viewport.width}`);

    for (const id of ['review-findings', 'review-failed', 'review-legacy', 'review-unknown']) {
      const { prNumber } = projectedTasks.find(task => task.id === id)!;
      await page.goto(`/tasks/${id}`);
      await expect(fix(prNumber)).toHaveCount(1);
      if (id === 'review-findings') await capture(page, `task-review-outcome-findings-${viewport.width}`);
    }
    expect(followups).toEqual([]);
  });
}
