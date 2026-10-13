import { expect, test } from '@playwright/test';
import { capture, fixture, selectedRun, detailsEvents, detailsHistory } from './task-list-desktop.fixture';

for (const width of [1333, 1584]) {
  test(`master-detail keeps filters, telemetry and terminal visible at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    await fixture(page);
    await page.route(`**/api/task/${selectedRun}/live-details`, route => route.fulfill({ json: {
      events: detailsEvents.map(event => event.type === 'thought' ? { ...event, content: `**Result:** ${event.content}` } : event),
      todos: [], currentTask: null,
    } }));
    await page.route(`**/api/task/${selectedRun}/history`, route => route.fulfill({ json: {
      history: detailsHistory.map(event => ({ ...event, metadata: { model: 'gpt-6-astra' } })),
      taskInfo: { title: 'Task master-detail cleanup', type: 'issue', number: 3016, repoOwner: 'integry', repoName: 'propr', modelName: 'gpt-6-astra' },
    } }));
    await page.goto(`/tasks?repository=integry%2Fpropr&assignee=octocat&task=${selectedRun}`);
    const list = page.getByTestId('task-split-list');
    await expect(list.locator('.task-repo-filter > button')).toContainText('propr');
    await expect(list.locator('.task-repo-filter > button > [data-repo-count]')).toBeHidden();
    await expect(list.locator('.task-assignee-filter-label')).toBeVisible();
    await expect(list.locator('.task-assignee-filter-icon')).toBeHidden();
    await expect(list.locator('.task-assignee-filter-label')).toHaveText('@octocat');
    const repoLabel = list.locator('.task-repo-filter > button > :nth-child(2)');
    expect(await repoLabel.evaluate(node => node.getBoundingClientRect().width)).toBeGreaterThan(40);
    const consumption = page.getByRole('group', { name: 'Consumption' });
    await expect(consumption).toContainText('↑0↓0');
    await expect(consumption).toContainText('no quota data');
    const trace = page.locator('#thinking-log-section');
    await expect(trace).toContainText('Linting flagged the withdrawal handler');
    await expect(trace).not.toContainText('Result:');
    const terminal = page.locator('#execution-event-log-section');
    await expect(terminal).toHaveCSS('background-color', 'rgb(9, 9, 11)');
    await expect(terminal.getByRole('button').first()).toHaveCSS('background-color', 'rgb(9, 9, 11)');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await capture(page, `master-detail-filtered-${width}`);
    await terminal.getByRole('button', { name: /EXECUTION LOG/ }).click();
    await expect(page.locator('#execution-event-log-content')).toHaveCSS('background-color', 'rgb(9, 9, 11)');
    await capture(page, `master-detail-terminal-${width}`);
    await page.goto(`/tasks?task=${selectedRun}`);
    await expect(list.locator('.task-repo-filter > button')).toContainText('All Repos');
    await expect(list.locator('.task-assignee-filter-label')).toBeVisible();
    await expect(list.locator('.task-assignee-filter-icon')).toBeHidden();
    await expect(list.locator('.task-assignee-filter-label')).toHaveText('All assignees');
  });
}

for (const width of [390, 1584, 1920]) {
  test(`timeline and edited files share task scrolling at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    await fixture(page);
    await page.route(`**/api/task/${selectedRun}/history`, route => route.fulfill({ json: {
      history: [
        detailsHistory[0],
        ...Array.from({ length: 12 }, (_, index) => ({
          ...detailsHistory[1],
          metadata: { model: 'gpt-6-astra', description: `Validate withdrawal handler ${index + 1}` },
        })),
      ],
      taskInfo: { title: 'Task master-detail cleanup', type: 'issue', number: 3016, repoOwner: 'integry', repoName: 'propr' },
    } }));
    const files = Array.from({ length: 32 }, (_, index) => ({
      path: `src/jobs/withdrawal/handler-${index + 1}.ts`,
      linesAdded: 12, linesRemoved: 4, status: 'modified',
    }));
    await page.route(`**/api/task/${selectedRun}/file-changes`, route => route.fulfill({
      json: { files, taskId: selectedRun, lastUpdated: new Date().toISOString() },
    }));
    await page.goto(width === 1584 ? `/tasks?task=${selectedRun}` : `/tasks/${selectedRun}`);
    const timeline = page.getByTestId('run-timeline-scroll');
    const changedFiles = page.getByRole('region', { name: 'Changed files' });
    await expect(timeline.getByTestId('run-timeline-run')).toHaveCount(8);
    await expect(changedFiles.getByRole('button')).toHaveCount(32);
    const owner = page.getByTestId(width < 640 ? 'task-details' : 'task-workspace-scroll');
    for (const section of [timeline, changedFiles, page.getByTestId('task-timeline-scroll')]) {
      const metrics = await section.evaluate(node => ({
        height: node.clientHeight, content: node.scrollHeight, overflow: getComputedStyle(node).overflowY,
      }));
      expect(metrics.overflow).not.toMatch(/auto|scroll/);
      expect(metrics.content).toBeLessThanOrEqual(metrics.height);
    }
    expect(await timeline.evaluate(node => node.clientHeight)).toBeGreaterThan(420);
    await changedFiles.getByRole('button').first().scrollIntoViewIfNeeded();
    await capture(page, `task-shared-scroll-${width}`);
    await changedFiles.getByRole('button').last().scrollIntoViewIfNeeded();
    const lastFile = await changedFiles.getByRole('button').last().boundingBox();
    const ownerBox = await owner.boundingBox();
    expect(lastFile!.y).toBeGreaterThanOrEqual(ownerBox!.y);
    expect(lastFile!.y + lastFile!.height).toBeLessThanOrEqual(ownerBox!.y + ownerBox!.height);
    expect(await owner.evaluate(node => node.scrollTop)).toBeGreaterThan(0);
  });
}

for (const width of [390, 1584]) {
  test(`reports alternate quota windows at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    await fixture(page);
    await page.route(`**/api/task/${selectedRun}/history`, route => route.fulfill({ json: {
      history: detailsHistory,
      taskInfo: { title: 'Task master-detail cleanup', type: 'issue', number: 3016, repoOwner: 'integry', repoName: 'propr', modelName: 'gemini-2.5-pro' },
      usageMetricRecords: [
        { agent: 'gemini', metricKey: 'Gemini · Weekly Limit Remaining', metricValue: 12 },
        { agent: 'claude', metricKey: 'weeklySonnet', metricValue: 0 },
      ],
    } }));
    await page.goto(width === 390 ? `/tasks/${selectedRun}` : `/tasks?task=${selectedRun}`);
    const quota = page.getByTitle('Gemini · Weekly Limit: 12.0% | Sonnet: 0.0%').filter({ visible: true });
    await expect(quota).toHaveText('(12.0% Gemini · Weekly Limit)');
    await expect(page.getByText('(no quota data)').filter({ visible: true })).toHaveCount(0);
    await capture(page, `task-alternate-quota-${width}`);
  });
}
