import { expect, test, type Locator, type Page } from '@playwright/test';
import { ago, capture, detailsHistory, fixture, selectedRun, tasks } from './task-list-desktop.fixture';

const taskTitle = 'Stop work when an issue or PR withdraws intent';
const filePath = 'src/jobs/withdrawalLabels.ts';
// Long enough that the diff scrolls at the native window's minimum height.
const longDiff = ['@@ -1,4 +1,80 @@', '-export const WITHDRAW = true;',
  ...Array.from({ length: 80 }, (_, line) => `+export const WITHDRAW_${line} = isIntentLabel(label);`)].join('\n');

const wide = { width: 1280, height: 820 };
const narrow = { width: 880, height: 620 };

async function stub(page: Page, posts: string[]) {
  await fixture(page, 'linux');
  // A completed run of an open pull request takes a follow-up.
  await page.route('**/api/tasks', route => route.fulfill({ json: {
    tasks: tasks.map(task => task.id === selectedRun ? { ...task, status: 'completed' } : task), total: 1842, totalRuns: 14769,
  } }));
  await page.route(`**/api/task/${selectedRun}/history`, route => route.fulfill({ json: {
    history: [...detailsHistory, { state: 'COMPLETED', timestamp: ago(0) }],
    taskInfo: { title: taskTitle, type: 'pr', number: 2664, issueNumber: 2664, repoOwner: 'integry', repoName: 'propr', modelName: 'gpt-6-astra',
      followupTarget: { taskId: selectedRun, repository: 'integry/propr', kind: 'pull_request', number: 2664 } },
  } }));
  await page.route(`**/api/task/${selectedRun}/file-changes`, route => route.fulfill({ json: {
    taskId: selectedRun, lastUpdated: new Date().toISOString(),
    files: [{ path: filePath, linesAdded: 80, linesRemoved: 1, status: 'modified', diff: longDiff }],
  } }));
  await page.route('**/api/tasks/*/followup', route => {
    posts.push(route.request().postData() ?? '');
    return route.fulfill({ status: 500, json: { error: 'A resize must not post' } });
  });
}

/** Whether a click at the element's centre lands on it, so nothing covers it. */
const hitTestable = (locator: Locator) => locator.evaluate(element => {
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && element.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
});

const state = (page: Page) => page.evaluate(() => ({ url: location.pathname + location.search, history: history.length }));

async function openTask(page: Page) {
  await page.goto('/tasks?search=withdraw');
  await page.getByRole('link', { name: taskTitle }).first().click();
  await expect(page).toHaveURL(new RegExp(`[?&]task=${selectedRun}`));
  await expect(page.getByTestId('task-split-details').getByTestId('task-details')).toBeVisible();
}

async function openFollowup(page: Page): Promise<Locator> {
  const details = page.getByTestId('task-split-details');
  const direct = details.locator('button[title^="Follow Up"]').filter({ visible: true });
  await expect(direct.or(details.getByRole('button', { name: /more actions/i }).filter({ visible: true })).first()).toBeVisible();
  if (await direct.count()) await direct.first().click();
  else {
    await details.getByRole('button', { name: /more actions/i }).filter({ visible: true }).first().click();
    await page.getByRole('menuitem', { name: /Follow Up/ }).click();
  }
  const dialog = page.getByRole('dialog', { name: 'Follow Up on Task' });
  await expect(dialog).toBeVisible();
  return dialog;
}

test('an open diff stays open, readable and scrolled as the window crosses the split breakpoint', async ({ page }) => {
  await page.setViewportSize(wide);
  await stub(page, []);
  await openTask(page);
  // The list keeps its place while the task covers it, and focus left in the list moves to the task.
  await page.getByRole('link', { name: taskTitle }).first().focus();
  const listScroller = page.getByTestId('task-split-list').locator('*').filter({ visible: true })
    .and(page.locator('[class*="overflow-y-auto"], [class*="overflow-auto"]')).first();
  await listScroller.evaluate(element => { element.scrollTop = 120; });
  const listTop = await listScroller.evaluate(element => element.scrollTop);
  expect(listTop).toBeGreaterThan(0);
  await page.setViewportSize(narrow);
  await expect(page.getByTestId('task-split-workspace')).toHaveAttribute('data-layout', 'single');
  expect(await page.getByTestId('task-split-details').evaluate(element => element.contains(document.activeElement))).toBe(true);
  await page.setViewportSize(wide);
  await expect(page.getByTestId('task-split-workspace')).toHaveAttribute('data-layout', 'split');
  // The list reflows at each width, so scroll anchoring may shift the offset, but it is not reset to the top.
  expect(await listScroller.evaluate(element => element.scrollTop)).toBeGreaterThan(listTop / 2);

  await page.getByTestId('task-split-details').getByText('withdrawalLabels.ts', { exact: true }).first().click();
  const dialog = page.getByRole('dialog', { name: 'withdrawalLabels.ts' });
  const close = dialog.getByRole('button', { name: 'Close diff view' });
  await expect(dialog).toBeVisible();
  const scroller = dialog.locator('[tabindex="0"]');
  await scroller.evaluate(element => { element.scrollTop = 400; });
  const before = await state(page);

  for (const viewport of [narrow, wide, narrow]) {
    await page.setViewportSize(viewport);
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId('diff-file-path')).toHaveText(filePath);
    await expect(close).toBeInViewport();
    expect(await hitTestable(close)).toBe(true);
    expect(await scroller.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
    expect(await state(page)).toEqual(before);
  }
  await capture(page, 'resize-diff-880');

  await close.click();
  await expect(dialog).toHaveCount(0);
  // Narrow, the task covers the list as a single pane, and the way back reopens the list where it was.
  const details = page.getByTestId('task-split-details');
  await expect(details.getByTestId('task-details')).toBeVisible();
  await expect(page.getByTestId('task-split-workspace')).toHaveAttribute('data-layout', 'single');
  const back = details.getByRole('button', { name: 'Back to tasks' }).filter({ visible: true });
  expect(await hitTestable(back.first())).toBe(true);
  await back.first().click();
  await expect(details).toHaveCount(0);
  await expect(page).toHaveURL(/\/tasks\?search=withdraw$/);
  await expect(page.getByRole('link', { name: taskTitle }).first()).toBeVisible();
});

test('an unsent follow-up keeps its draft across the breakpoint and to phone widths, and posts nothing', async ({ page }) => {
  const posts: string[] = [];
  await page.setViewportSize(wide);
  await stub(page, posts);
  await openTask(page);
  const dialog = await openFollowup(page);
  const draft = 'Diagnostic draft: do not post';
  await dialog.getByRole('textbox', { name: 'Comment' }).fill(draft);
  const before = await state(page);

  for (const viewport of [narrow, wide, { width: 390, height: 844 }, { width: 320, height: 640 }, wide]) {
    await page.setViewportSize(viewport);
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('textbox', { name: 'Comment' })).toHaveValue(draft);
    const header = dialog.getByRole('button', { name: 'Close follow-up dialog' });
    await expect(header).toBeInViewport();
    expect(await hitTestable(header)).toBe(true);
    expect(await state(page)).toEqual(before);
    if (viewport.width === 880) await capture(page, 'resize-followup-880');
  }
  await expect(page.getByTestId('task-split-workspace')).toHaveAttribute('data-layout', 'split');
  expect(posts).toEqual([]);
});

for (const viewport of [{ width: 390, height: 844 }, { width: 320, height: 640 }]) {
  test(`a task linked at ${viewport.width}px opens as one pane, and keeps its diff when widened`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await stub(page, []);
    await page.goto(`/tasks?search=withdraw&task=${selectedRun}`);
    const details = page.getByTestId('task-split-details');
    await expect(details.getByTestId('task-details')).toBeVisible();
    await expect(page.getByTestId('task-split-workspace')).toHaveAttribute('data-layout', 'single');
    // One pane fills the width: the list is not squeezed in beside it, nor reachable under it.
    const box = await details.boundingBox();
    expect(box!.x).toBeLessThanOrEqual(1);
    expect(await page.getByTestId('task-split-list').evaluate(element => (element as HTMLElement).inert)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const back = details.getByRole('button', { name: 'Back to tasks' }).filter({ visible: true });
    await expect(back).toHaveCount(1);
    expect(await hitTestable(back)).toBe(true);
    await capture(page, `resize-linked-${viewport.width}`);

    await details.getByText('withdrawalLabels.ts', { exact: true }).filter({ visible: true }).first().click();
    const dialog = page.getByRole('dialog', { name: 'withdrawalLabels.ts' });
    await expect(dialog).toBeVisible();
    const before = await state(page);
    await page.setViewportSize(wide);
    await expect(page.getByTestId('task-split-workspace')).toHaveAttribute('data-layout', 'split');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId('diff-file-path')).toHaveText(filePath);
    expect(await state(page)).toEqual(before);
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    // Escape closes the diff only; the task stays open beside the list.
    await expect(details.getByTestId('task-details')).toBeVisible();
    await expect(page.getByRole('link', { name: taskTitle }).first()).toBeVisible();
  });
}
