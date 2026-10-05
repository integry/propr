import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

const taskId = 'task-details-cleanup';
const title = 'New Issue: When starting a new task it should remember the last used settings (repo and agent) and preselect them for the next task';
// The heading drops the workflow verb the badge already shows, as the task list row does.
const heading = title.replace(/^New Issue: /, '');
const at = (seconds: number) => new Date(Date.UTC(2026, 9, 1, 0, 50, seconds)).toISOString();
const files = Array.from({ length: 32 }, (_, index) => ({
  path: index === 31 ? 'packages/core/src/agents/impl/utils/agentWorkerCredentialValidation.test.ts'
    : `packages/core/src/agents/impl/utils/repositoryValidation${index + 1}.test.ts`,
  linesAdded: (index + 1) * 3,
  linesRemoved: index + 1,
  status: 'modified',
  diff: `@@ -1 +1 @@\n-const enabled = false;\n+const enabled = true;`,
}));

async function fixture(page: Page, completed: boolean) {
  await page.routeWebSocket('**/socket.io/**', socket => socket.close());
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname;
    const history = [
      { state: 'PENDING', timestamp: at(28), promptPath: '/fixtures/prompt', logsPath: '/fixtures/logs', metadata: { model: 'gpt-6-astra' } },
      { state: 'PROCESSING', timestamp: at(29) },
      { state: 'PROCESSING', timestamp: at(30) },
      { state: 'CLAUDE_EXECUTION', timestamp: at(37) },
      ...(completed ? [
        { state: 'CLAUDE_EXECUTION_COMPLETED', timestamp: at(648) },
        { state: 'COMPLETED', timestamp: at(660), metadata: {
          pr: { url: 'https://github.com/integry/propr/pull/2661', number: 2661 },
          commitResult: { commitHash: '5c7cd9e0123456789012345678901234567890123' },
        } },
      ] : []),
    ];
    const responses: Record<string, unknown> = {
      '/api/auth/demo-mode': { demoMode: true },
      [`/api/task/${taskId}/history`]: {
        history,
        taskInfo: { title, type: 'issue', number: 2658, issueNumber: 2658, repoOwner: 'integry', repoName: 'propr', modelName: 'gpt-6-astra' },
        usageMetricRecords: [{ agent: 'codex', metricKey: 'Weekly', metricValue: completed ? 1 : 0.4 }],
      },
      [`/api/task/${taskId}/live-details`]: {
        events: [
          { type: 'thought', timestamp: at(40), content: 'I traced the task settings through submission and confirmed where the selected repository and agent need to be remembered.' },
          { type: 'thought', timestamp: at(95), content: 'The implementation now preserves the most recent selection and uses it to preselect the next task. Existing defaults remain available when no previous selection exists.' },
          { type: 'thought', timestamp: at(590), content: completed ? 'The focused regression checks pass. Task settings persist between submissions, and the next task opens with the previous repository and agent selected.' : 'I am checking the task submission flow and validating that both repository and agent selections are restored together.' },
        ],
        todos: [], currentTask: null,
        tokenUsage: { input_tokens: 100_000, cache_read_input_tokens: 3_800_000, output_tokens: 30_000 },
      },
      [`/api/task/${taskId}/file-changes`]: { files, taskId, lastUpdated: at(590) },
      '/api/notifications/unread-count': { unreadCount: 0 },
      '/api/notifications/preferences': { preferences: {}, quietHours: {}, badgeEnabled: false },
    };
    return route.fulfill(path in responses ? { json: responses[path] } : { status: 503, json: { error: 'Unavailable in task details fixture' } });
  });
}

async function capture(page: Page, name: string) {
  if (!process.env.PROPR_CAPTURE_PREVIEWS) return;
  await mkdir('../.propr/previews', { recursive: true });
  await page.getByTestId('task-details').screenshot({ animations: 'disabled', path: `../.propr/previews/${name}.png` });
}

for (const width of [390, 1440]) {
  for (const completed of [false, true]) {
    test(`cleans up ${completed ? 'completed' : 'live'} task details at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
      await fixture(page, completed);
      await page.goto(`/tasks/${taskId}`);
      const task = page.getByTestId('task-details');
      await expect(task).toBeVisible();
      const header = page.getByRole('heading', { name: heading, exact: true });
      await expect(header).toHaveAttribute('title', heading);
      expect(await header.evaluate(node => getComputedStyle(node).webkitLineClamp)).toBe('2');
      await expect(task.getByRole('group', { name: 'Git context' })).toBeVisible();
      await expect(task.getByRole('group', { name: 'Execution runtime' })).toBeVisible();
      const consumption = task.getByRole('group', { name: 'Consumption' });
      await expect(consumption).toContainText('↑3.9M↓30k');
      await expect(consumption).toContainText(`(${completed ? '1.0' : '0.4'}% quota)`);
      await expect(task.getByText('Analyzing Request', { exact: true })).toHaveCount(1);
      await expect(task.getByText('8s', { exact: true })).toBeVisible();
      for (const label of ['Task Queued', 'Analyzing Request', 'Implementing Changes', ...(completed ? ['Task Completed'] : [])]) {
        const alignment = await task.getByText(label, { exact: label !== 'Task Completed' }).evaluate(node => {
          const row = node.closest('.group')!;
          const timestamp = row.firstElementChild!.firstElementChild!;
          const duration = node.parentElement!.nextElementSibling!;
          const timestampText = document.createRange();
          timestampText.selectNodeContents(timestamp);
          return {
            labelTop: node.getBoundingClientRect().top,
            timestampTop: timestamp.getBoundingClientRect().top,
            durationTop: duration.getBoundingClientRect().top,
            labelHeight: getComputedStyle(node).lineHeight,
            timestampHeight: getComputedStyle(timestamp).lineHeight,
            timestampRight: timestampText.getBoundingClientRect().right,
            iconLeft: row.children[1].lastElementChild!.getBoundingClientRect().left,
          };
        });
        expect(alignment.labelTop).toBe(alignment.timestampTop);
        expect(alignment.labelTop).toBe(alignment.durationTop);
        expect(alignment.labelHeight).toBe(alignment.timestampHeight);
        expect(alignment.timestampRight).toBeLessThanOrEqual(alignment.iconLeft);
      }
      const terminal = task.locator('#execution-event-log-section');
      await expect(terminal).toHaveCSS('background-color', 'rgb(9, 9, 11)');
      await expect(terminal).toHaveCSS('color', 'rgb(212, 212, 216)');
      await expect(task.getByRole('menuitem', { name: 'Delete' })).toHaveCount(0);
      await expect(task.getByRole('region', { name: 'Changed files' }).getByRole('button')).toHaveCount(32);
      const more = task.getByRole('button', { name: 'More task actions' });
      await more.click();
      // On mobile the overflow is a bottom sheet laid over the whole page, outside the task pane.
      const deletion = page.getByRole('menuitem', { name: 'Delete' });
      if (completed) await expect(deletion).toBeEnabled();
      else await expect(deletion).toBeDisabled();
      await page.keyboard.press('Escape');
      await expect(more).toBeFocused();
      await expect(page.getByRole('menu')).toHaveCount(0);
      await capture(page, `task-details-${completed ? 'completed' : 'live'}-${width}`);

      const list = task.getByRole('region', { name: 'Changed files' });
      await expect(list.getByRole('button')).toHaveCount(32);
      await expect(list.getByText('packages/…/utils/', { exact: true })).toHaveCount(1);
      await expect(list.getByRole('button').first()).not.toContainText('packages/core/src/agents/impl/utils/');
      const metrics = await list.evaluate(node => ({ height: node.clientHeight, scrollHeight: node.scrollHeight, overflow: getComputedStyle(node).overflowY }));
      expect(metrics.height).toBeLessThanOrEqual(192);
      expect(metrics.scrollHeight).toBeGreaterThan(metrics.height);
      expect(metrics.overflow).toBe('auto');
      await expect(list.getByRole('button').first()).toHaveAccessibleName(`View diff for ${files[31].path}`);
      const lastFile = list.getByRole('button', { name: `View diff for ${files[0].path}` });
      await lastFile.scrollIntoViewIfNeeded();
      await lastFile.click();
      await expect(page.getByTitle('Close diff view')).toBeVisible();
      await page.getByTitle('Close diff view').click();
      if (width === 1440 && completed) {
        await terminal.getByRole('button', { name: /EXECUTION LOG/ }).click();
        await expect(task.locator('#execution-event-log-content')).toHaveCSS('background-color', 'rgb(9, 9, 11)');
        await capture(page, 'task-details-terminal-expanded');
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    });
  }
}
