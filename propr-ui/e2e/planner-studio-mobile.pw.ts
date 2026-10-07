import { expect, test } from '@playwright/test';
import { capture, creatingIssueUpdates, fixture, generationUpdate, liveDraftUpdates } from './planner-studio.fixture';

test.beforeEach(async ({ page }) => {
  await fixture(page);
  await page.setViewportSize({ width: 1440, height: 900 });
});


for (const viewport of [{ name: 'mobile', width: 390, height: 844 }, { name: 'laptop', width: 1024, height: 768 }]) {
  test(`planner screens fit a ${viewport.name} viewport without horizontal overflow`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

    await page.goto('/studio/plan-short');
    await expect(page.locator('[data-task-index="0"]')).toBeVisible();
    expect(await overflow()).toBeLessThanOrEqual(0);
    await capture(page, `review-plan-${viewport.name}`);

    await page.goto('/studio/plan-agents-exec');
    const matrix = page.getByTestId('plan-execution-matrix');
    await expect(matrix.getByTestId('plan-execution-row')).toHaveCount(12);
    expect(await overflow()).toBeLessThanOrEqual(0);
    await expect(page.getByTestId('execution-config-button')).toBeInViewport();
    // Each row keeps its title and action visible inside the matrix.
    const matrixBox = (await matrix.boundingBox())!;
    const action = (await matrix.getByTestId('action-column').first().boundingBox())!;
    expect(action.x + action.width).toBeLessThanOrEqual(matrixBox.x + matrixBox.width + 1);
    await capture(page, `execution-${viewport.name}`);
  });
}

for (const viewport of [{ name: 'desktop', width: 1440, height: 900 }, { name: 'mobile', width: 390, height: 844 }]) {
  test(`active planner states render their live progress on ${viewport.name}`, async ({ page }) => {
    await liveDraftUpdates(page, { 'plan-gathering': [generationUpdate('plan-gathering')], 'plan-generating': [generationUpdate('plan-generating')], 'plan-creating': creatingIssueUpdates });
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

    await page.goto('/studio/plan-gathering');
    await expect(page.getByText('Gathering Context')).toBeVisible();
    await expect(page.getByText(/remaining$/)).toHaveCount(1);
    await expect(page.getByText('In Progress')).toHaveCount(1);
    await expect(page.getByText('Will analyze context and generate implementation plan')).toBeVisible();
    // The canvas below the steps streams what discovery has found so far.
    const telemetry = page.getByTestId('generation-telemetry');
    await expect(telemetry.getByText('packages/core/src/services/taskPlanningService.ts')).toBeVisible();
    await expect(telemetry.getByText('(100% match)')).toBeVisible();
    await expect(telemetry.getByTestId('telemetry-tokens')).toContainText(/Accumulating context: ≈\d+k tokens/);
    await expect(telemetry.getByTestId('telemetry-files')).toContainText(/^\d+\/18 files scanned$/);
    expect(await overflow()).toBeLessThanOrEqual(0);
    await page.waitForTimeout(600);
    await capture(page, `active-gathering-context-${viewport.name}`);

    await page.goto('/studio/plan-generating');
    await expect(page.getByText('Generating Plan')).toBeVisible();
    await expect(page.getByText(/remaining$/)).toHaveCount(1);
    await expect(page.getByText(/^Will /)).toHaveCount(0);
    await expect(page.getByTestId('telemetry-files')).toHaveText('18/18 files scanned');
    await expect(page.getByTestId('telemetry-tokens')).toHaveText('Context assembled: 842k tokens');
    await expect(page.getByText('Prompting the model with 842k tokens…')).toBeVisible();
    if (viewport.name === 'mobile') {
      // The file stream scrolls inside a bounded box, so the status line stays on screen above the nav.
      expect((await page.getByTestId('telemetry-log').boundingBox())!.height).toBeLessThanOrEqual(224);
      await expect(page.getByText('Prompting the model with 842k tokens…')).toBeInViewport();
    }
    if (viewport.name === 'desktop') {
      // The telemetry fills the canvas under the steps instead of leaving it blank.
      const box = (await page.getByTestId('generation-telemetry').boundingBox())!;
      expect(box.y + box.height).toBeGreaterThan(viewport.height - 40);
    }
    expect(await overflow()).toBeLessThanOrEqual(0);
    await page.waitForTimeout(600);
    await capture(page, `active-generating-plan-${viewport.name}`);

    await page.goto('/studio/plan-creating');
    await expect(page.getByText('6/17', { exact: true })).toBeVisible();
    // Every created row links its issue, not just the latest one.
    const rows = page.getByTestId('issue-creation-row');
    for (let index = 0; index < 6; index++) {
      await expect(rows.nth(index).getByRole('link', { name: `#${2900 + index}` })).toBeVisible();
    }
    // Rows lead with the step, not the repeated "Agents v1 (n/17):" prefix.
    await expect(rows.first()).toContainText('1. Shared contracts');
    await expect(rows.filter({ hasText: 'Agents v1 (' })).toHaveCount(0);
    await expect(page.getByTestId('plan-footer-stats')).toHaveText(/^6 of 17 Issues Created\s*\(1 Creating · 10 Queued\)$/);
    // Revising mid-creation would race the run, so it is locked until creation finishes.
    await expect(page.getByRole('button', { name: 'Revise' })).toBeDisabled();
    if (viewport.name === 'mobile') {
      // The title gets its own full-width line under the repo chip and phase pill.
      const title = (await page.getByRole('heading', { level: 1 }).boundingBox())!;
      const chip = (await page.getByTestId('plan-repo-chip').boundingBox())!;
      expect(title.y).toBeGreaterThan(chip.y + chip.height - 1);
      expect(title.width).toBeGreaterThan(300);
    }
    expect(await overflow()).toBeLessThanOrEqual(0);
    await page.waitForTimeout(600);
    await capture(page, `active-creating-issues-${viewport.name}`);
  });
}

test('planner screens on a mobile viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

  await page.goto('/plans');
  await expect(page.getByText(/^Expose the repository retrieval/)).toBeVisible();
  expect(await overflow()).toBeLessThanOrEqual(0);
  await capture(page, 'mobile-plans-index');

  await page.goto('/studio/plan-setup');
  const generate = page.getByRole('button', { name: /Generate Plan/ });
  await expect(generate).toBeVisible();
  expect(await overflow()).toBeLessThanOrEqual(0);
  // The header repo slug renders whole next to the branch chip and phase pill; the branch lives in the chip.
  const repoTrigger = page.getByRole('button', { name: 'propr', exact: true });
  await expect(repoTrigger).toBeVisible();
  expect(await repoTrigger.locator('span').last().evaluate(label => label.scrollWidth <= label.clientWidth)).toBe(true);
  // Every setting under the prompt is a row of one divided group, not a stack of separate cards.
  const settings = page.getByTestId('setup-settings-group');
  await expect(settings.locator(':scope > div')).toHaveCount(5);
  await expect(settings.getByText('Break into', { exact: true })).toBeVisible();
  await expect(settings.getByText('Model', { exact: true })).toBeVisible();
  await expect(settings.getByTestId('context-scope-descriptor')).toHaveText('100% (Full Scan)');
  await expect(settings.getByRole('button', { name: /^Context repos:/ })).toBeVisible();
  await expect(settings.getByTestId('setup-cost-row')).toBeVisible();
  await expect(page.getByTestId('setup-wizard-right-pane')).toHaveCount(0);
  // Generate ends the input flow, right after the group.
  const settingsBox = (await settings.boundingBox())!;
  expect((await generate.boundingBox())!.y).toBeGreaterThan(settingsBox.y + settingsBox.height);
  // The model picker names the model on a phone too, rather than collapsing to its logo.
  const mobileModel = settings.getByTestId('planner-model-selector');
  await expect(mobileModel).toHaveText('Claude Opus 5.5 (Default)');
  expect(await mobileModel.locator('span').last().evaluate(label => label.scrollWidth <= label.clientWidth)).toBe(true);
  await capture(page, 'mobile-define');
  await page.getByTestId('composer-footer').scrollIntoViewIfNeeded();
  await capture(page, 'mobile-define-action-bar');

  await page.goto('/studio/plan-agents');
  await expect(page.locator('[data-task-index="0"]')).toBeVisible();
  expect(await overflow()).toBeLessThanOrEqual(0);
  await capture(page, 'mobile-review-17-steps');

  await page.goto('/studio/plan-mcp-exec');
  await expect(page.getByTestId('plan-execution-matrix').getByTestId('plan-execution-row')).toHaveCount(3);
  expect(await overflow()).toBeLessThanOrEqual(0);
  await page.waitForTimeout(500);
  await capture(page, 'mobile-execution-4-issues');
  await page.getByTestId('execution-config-button').click();
  const config = page.getByRole('dialog', { name: 'Execution config' });
  await expect(config).toBeVisible();
  const box = (await config.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  await capture(page, 'mobile-execution-config');
  await page.keyboard.press('Escape');

  await page.goto('/studio/plan-agents-exec');
  // Issues stream edge to edge with hairline separators instead of sitting in an inset, rounded card.
  const mobileMatrix = page.getByTestId('plan-execution-matrix');
  await expect(mobileMatrix.getByTestId('plan-execution-row')).toHaveCount(12);
  const matrixBox = (await mobileMatrix.boundingBox())!;
  expect(matrixBox.x).toBe(0);
  expect(matrixBox.width).toBe(390);
  expect(await mobileMatrix.evaluate(el => getComputedStyle(el).borderTopLeftRadius)).toBe('0px');
  const queue = page.getByRole('button', { name: 'Queue Remaining (10 tasks)' });
  // The batch action stays pinned above the footer without scrolling past every row.
  await expect(queue).toBeInViewport();
  const queueBox = (await queue.boundingBox())!;
  expect(queueBox.width).toBeGreaterThan(390 - 64);
  await page.waitForTimeout(500);
  await capture(page, 'mobile-execution-17-issues-queue');
});
