import { expect, test, type Page } from '@playwright/test';
import { capture, now } from './task-list-desktop.fixture';

const taskId = 'agent-run-18e98dff-report';
const at = (seconds: number) => new Date(now - (120 - seconds) * 1000).toISOString();

// A completed report-only run of a dry-run automation: no issue, no PR, the default model resolved at execution.
const history = [
  { state: 'pending', timestamp: at(0), reason: 'Task created', metadata: {} },
  { state: 'processing', timestamp: at(2), reason: 'Preparing agent workspace', metadata: {} },
  { state: 'claude_execution', timestamp: at(8), reason: 'Running agent codex', metadata: { model: 'gpt-6-astra', executionRouting: { model: 'gpt-6-astra', agentAlias: 'codex' } } },
  { state: 'post_processing', timestamp: at(70), reason: 'Storing agent report', metadata: {} },
  { state: 'completed', timestamp: at(72), reason: 'Agent report stored', metadata: {} },
];

async function reportTask(page: Page) {
  await page.clock.install({ time: now });
  await page.route('**/api/**', route => {
    const pathname = new URL(route.request().url()).pathname;
    const responses: Record<string, unknown> = {
      '/api/auth/demo-mode': { demoMode: true },
      '/api/notifications/unread-count': { unreadCount: 0 },
      [`/api/task/${taskId}/history`]: {
        history,
        taskInfo: {
          title: 'Agent: Desktop acceptance', subtitle: 'Report run', type: 'agent-run', taskKind: 'automation-report',
          number: 0, repoOwner: 'acme', repoName: 'web', modelName: 'gpt-6-astra', agentAlias: 'codex',
        },
        usageMetricRecords: [],
      },
      [`/api/task/${taskId}/live-details`]: { events: [], todos: [], currentTask: null },
      [`/api/task/${taskId}/file-changes`]: { taskId, files: [], lastUpdated: at(72) },
    };
    const noSubject = 'This task has no GitHub issue or pull request, so there is nothing to assign.';
    if (pathname === `/api/task/${taskId}/assignees`) return route.fulfill({ status: 409, json: { error: noSubject, code: 'NO_GITHUB_SUBJECT', message: noSubject } });
    return pathname in responses ? route.fulfill({ json: responses[pathname] }) : route.fulfill({ status: 503, json: { error: 'Unavailable in fixture' } });
  });
}

for (const [layout, viewport] of [['desktop', { width: 1440, height: 900 }], ['phone', { width: 390, height: 844 }]] as const) {
  test(`an automation report task reads as a report on ${layout}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await reportTask(page);
    await page.goto(`/tasks/${taskId}`);

    await expect(page.getByText('GPT-6 Astra', { exact: true }).filter({ visible: true }).first()).toBeVisible();
    for (const label of ['Preparing Analysis', 'Generating Report', 'Storing Report', 'Report Ready']) {
      await expect(page.getByText(label, { exact: true }).filter({ visible: true }).first()).toBeVisible();
    }
    for (const label of ['Unknown Model', 'Implementing Changes', 'Creating Pull Request']) {
      await expect(page.getByText(label, { exact: true }).filter({ visible: true })).toHaveCount(0);
    }
    await expect(page.getByRole('button', { name: /Follow Up/ }).filter({ visible: true })).toHaveCount(0);
    await capture(page, `automation-report-task-${layout}`);

    // The overflow still offers the task's own actions, but no GitHub comment.
    await page.getByRole('button', { name: 'More task actions' }).filter({ visible: true }).first().click();
    const menu = page.getByRole('menu', { name: 'More task actions' }).filter({ visible: true });
    await expect(menu.getByRole('menuitem', { name: /Delete/ })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: /Follow Up/ })).toHaveCount(0);
    await capture(page, `automation-report-task-${layout}-actions`);
  });
}
