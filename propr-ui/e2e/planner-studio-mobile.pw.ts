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
    if (viewport.name === 'mobile') {
      // Tier 1 is the scope pill and step badge; tier 2 gives the title its own line next to GitHub and "…".
      const scope = page.getByTestId('studio-scope-pill');
      await expect(scope).toHaveText('propr/main');
      await expect(page.getByTestId('phase-step-badge')).toHaveText('Step 3/3');
      const title = (await page.getByRole('heading', { level: 1 }).boundingBox())!;
      const scopeBox = (await scope.boundingBox())!;
      expect(title.y).toBeGreaterThan(scopeBox.y + scopeBox.height - 1);
      expect(title.width).toBeGreaterThan(240);
      await expect(page.getByRole('link', { name: 'View issues on GitHub' })).toBeVisible();
      await page.getByRole('button', { name: 'More plan actions' }).click();
      await expect(page.getByRole('menuitem', { name: 'Revise' })).toBeDisabled();
      await page.mouse.click(5, 300);
    } else {
      await expect(page.getByRole('button', { name: 'Revise' })).toBeDisabled();
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
  // The header is one `propr/main` scope pill plus a step badge, not repo picker + branch chip + breadcrumb.
  const repoTrigger = page.getByRole('button', { name: 'propr/main', exact: true });
  await expect(repoTrigger).toBeVisible();
  expect(await repoTrigger.locator('span').last().evaluate(label => label.scrollWidth <= label.clientWidth)).toBe(true);
  await expect(page.getByTestId('branch-chip')).toBeHidden();
  await expect(page.getByTestId('phase-step-badge')).toHaveText('Step 1/3');
  // Prompt and settings run edge to edge on the white page: no inset, rounded, bordered cards.
  for (const surface of [page.getByTestId('setup-composer'), page.getByTestId('setup-settings-group')]) {
    const box = (await surface.boundingBox())!;
    expect(box.x).toBe(0);
    expect(box.width).toBe(390);
    expect(await surface.evaluate(el => getComputedStyle(el).borderTopLeftRadius)).toBe('0px');
  }
  // Every setting is a full-width row of one divided list.
  const settings = page.getByTestId('setup-settings-group');
  await expect(settings.locator(':scope > div')).toHaveCount(5);
  await expect(settings.getByText('Break into', { exact: true })).toBeVisible();
  await expect(settings.getByText('Model', { exact: true })).toBeVisible();
  await expect(settings.getByTestId('context-scope-descriptor')).toHaveText('100% (Full Scan)');
  await expect(settings.getByRole('button', { name: /^Context repos:/ })).toBeVisible();
  await expect(settings.getByTestId('setup-cost-row')).toBeVisible();
  await expect(page.getByTestId('setup-wizard-right-pane')).toHaveCount(0);
  // Generate is docked in the thumb zone, directly above the bottom navigation, without scrolling.
  const dock = page.getByTestId('mobile-generate-dock');
  await expect(dock).toContainText('Generate Plan');
  await expect(generate).toBeInViewport();
  const dockBox = (await dock.boundingBox())!;
  const navBox = (await page.locator('.mobile-bottom-navigation').boundingBox())!;
  expect(Math.abs(dockBox.y + dockBox.height - navBox.y)).toBeLessThanOrEqual(1);
  expect(dockBox.width).toBe(390);
  // The model picker names the model on a phone too, rather than collapsing to its logo.
  const mobileModel = settings.getByTestId('planner-model-selector');
  await expect(mobileModel).toHaveText('Claude Opus 5.5 (Default)');
  expect(await mobileModel.locator('span').last().evaluate(label => label.scrollWidth <= label.clientWidth)).toBe(true);
  await capture(page, 'mobile-define');
  await page.getByTestId('setup-cost-row').scrollIntoViewIfNeeded();
  // Scrolled to the end of the settings, Generate is still in the same docked spot.
  expect((await dock.boundingBox())!.y).toBe(dockBox.y);
  await capture(page, 'mobile-define-scrolled');

  await page.goto('/studio/plan-agents');
  await expect(page.locator('[data-task-index="0"]')).toBeVisible();
  expect(await overflow()).toBeLessThanOrEqual(0);
  // Scope pill and step badge lead; the plan title gets its own line beneath them.
  const reviewScope = page.getByTestId('studio-scope-pill');
  await expect(reviewScope).toHaveText('propr/main');
  await expect(page.getByTestId('phase-step-badge')).toHaveText('Step 2/3');
  const reviewTitle = (await page.getByRole('heading', { level: 1 }).boundingBox())!;
  const reviewScopeBox = (await reviewScope.boundingBox())!;
  expect(reviewTitle.y).toBeGreaterThan(reviewScopeBox.y + reviewScopeBox.height - 1);
  // Back sits on the top-left edge; the title row carries only the "…" menu, which holds Undo/Redo/History/Delete.
  const back = page.getByRole('button', { name: 'Back to Setup' });
  const backBox = (await back.boundingBox())!;
  expect(backBox.x).toBeLessThan(reviewScopeBox.x);
  expect(backBox.x).toBeLessThan(16);
  await expect(page.getByTitle('Undo')).toHaveCount(0);
  await expect(page.getByTitle('Delete Plan')).toHaveCount(0);
  expect(reviewTitle.width).toBeGreaterThan(390 - 80);
  // The footer is two buttons with the count in the primary action.
  const createIssues = page.getByRole('button', { name: 'Create 17 Issues' });
  await expect(createIssues).toBeInViewport();
  await expect(page.getByText('17 tasks', { exact: true })).toHaveCount(0);
  await capture(page, 'mobile-review-17-steps');
  await page.getByRole('button', { name: 'More plan actions' }).click();
  await expect(page.getByRole('menuitem')).toHaveText(['Undo', 'Redo', 'Plan history', 'Delete plan']);
  await capture(page, 'mobile-review-overflow-menu');
  await page.getByRole('button', { name: 'More plan actions' }).click({ force: true });
  await page.mouse.click(10, 400);
  // The task jumper reaches a late task without scrolling through the whole specification.
  const jumper = page.getByTestId('mobile-task-jumper');
  await expect(jumper).toContainText('Task 1 of 17');
  await jumper.click();
  const sheet = page.getByRole('dialog', { name: 'Jump to task' });
  await expect(sheet.locator('li')).toHaveCount(17);
  await capture(page, 'mobile-review-task-jumper');
  await sheet.locator('li').nth(13).getByRole('button').click();
  await expect(sheet).toBeHidden();
  await expect(page.locator('[data-task-index="13"]')).toBeInViewport();
  await expect(jumper).toContainText('Task 14 of 17');
  await capture(page, 'mobile-review-jumped-task-14');
  // On a 360px Android phone the two footer buttons still sit side by side without wrapping or overlapping.
  await page.setViewportSize({ width: 360, height: 780 });
  const refineBox = (await page.getByRole('button', { name: 'Refine' }).boundingBox())!;
  const createBox = (await createIssues.boundingBox())!;
  expect(Math.abs((createBox.y + createBox.height / 2) - (refineBox.y + refineBox.height / 2))).toBeLessThanOrEqual(1);
  expect(createBox.x).toBeGreaterThan(refineBox.x + refineBox.width);
  expect(createBox.x + createBox.width).toBeLessThanOrEqual(360);
  expect(await createIssues.locator('span').evaluate(label => label.scrollWidth <= label.clientWidth)).toBe(true);
  expect(await overflow()).toBeLessThanOrEqual(0);
  await capture(page, 'mobile-review-footer-360');
  await page.setViewportSize({ width: 390, height: 844 });

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
