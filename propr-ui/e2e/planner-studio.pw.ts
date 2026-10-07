import { expect, test } from '@playwright/test';
import { capture, fixture, implementRequests, queueRequests } from './planner-studio.fixture';

test.beforeEach(async ({ page }) => {
  await fixture(page);
  await page.setViewportSize({ width: 1440, height: 900 });
});

test('plans index keeps every row to one plain-text line with quiet status and unboxed repo', async ({ page }) => {
  await page.goto('/plans');
  const title = page.getByText(/^Expose the repository retrieval/);
  await expect(title).toBeVisible();
  await expect(page.getByText(/##/)).toHaveCount(0);
  const lineHeight = await title.evaluate(element => parseFloat(getComputedStyle(element).lineHeight));
  expect((await title.boundingBox())!.height).toBeLessThanOrEqual(lineHeight + 1);
  await expect(page.locator('span.rounded-full', { hasText: 'In Review' }).first()).toHaveClass(/bg-slate-100/);
  await expect(page.locator('span.rounded-full', { hasText: 'Merged' }).first()).toHaveClass(/bg-purple-50/);
  await expect(page.locator('span.rounded-full', { hasText: 'Failed' }).first()).toHaveClass(/bg-red-50/);
  await expect(page.getByText('3 issues • 1 running • 2 merged')).toBeVisible();
  await expect(page.locator('a.font-mono', { hasText: /^propr$/ }).first()).not.toHaveClass(/bg-/);
  await expect(page.locator('a.font-mono', { hasText: 'integry/' })).toHaveCount(0);
  await capture(page, 'plans-index');
});

test('review step lists the plan outline with titles instead of a blind numbered rail', async ({ page }) => {
  await page.goto('/studio/plan-agents');
  const outline = page.getByRole('navigation', { name: 'Plan outline' });
  await expect(outline).toBeVisible();
  await expect(outline.getByRole('button', { name: /Shared contracts for agent definitions/ })).toHaveAttribute('aria-current', 'step');
  const longStep = outline.getByRole('button', { name: /Shared contracts for agent definitions/ }).locator('span').last();
  expect(await longStep.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await expect(page.getByTitle('Undo').locator('..')).toHaveClass(/border-slate-200/);
  await expect(page.getByTitle('Delete Plan')).toHaveCount(0);
  await capture(page, 'review-plan-outline');
  await expect(outline.getByRole('listitem')).toHaveCount(17);
  // The Assistant is a fixed 340px companion column; the specification takes the rest.
  expect((await page.getByTestId('plan-assistant').boundingBox())!.width).toBe(340);
  expect((await page.locator('[data-task-list]').boundingBox())!.width).toBeGreaterThan(540);
  await outline.getByRole('button', { name: /Database migration and definition store/ }).click();
  await expect(outline.getByRole('button', { name: /Database migration and definition store/ })).toHaveAttribute('aria-current', 'step');
  // Each step renders its own requirements.
  await expect(page.locator('[data-task-index="1"]')).toContainText('migrations/0042_agent_definitions.sql');
  await expect(page.locator('[data-task-index="1"]')).not.toContainText('agentDefinitions.ts');
  // The drag handle sits inside the row, past the active border and left of the step number.
  const cronStep = outline.getByRole('button', { name: /Cron schedule sweep/ });
  await cronStep.click();
  await expect(cronStep).toHaveAttribute('aria-current', 'step');
  await expect(page.locator('[data-task-index="11"]')).toContainText('agentScheduleSweep.ts');
  // The outline click scrolls the specification to step 12.
  await expect.poll(() => page.locator('[data-task-index="11"]').evaluate(card => Math.round(card.getBoundingClientRect().top - card.closest('[data-task-list]')!.getBoundingClientRect().top))).toBe(0);
  await cronStep.hover();
  const handle = (await outline.getByLabel('Reorder step 12').boundingBox())!;
  const row = (await cronStep.boundingBox())!;
  const number = (await cronStep.locator('span').first().boundingBox())!;
  expect(handle.x).toBeGreaterThanOrEqual(row.x + 2);
  expect(handle.x + handle.width).toBeLessThanOrEqual(number.x + number.width - 12);
  await page.waitForTimeout(300);
  await capture(page, 'review-plan-outline-drag-handle');

  const specBefore = (await page.locator('[data-task-list]').boundingBox())!.width;
  await page.getByRole('button', { name: 'Collapse outline' }).click();
  await page.getByRole('button', { name: 'Assistant' }).click();
  await expect(outline).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Assistant' })).toHaveAttribute('aria-pressed', 'false');
  expect((await page.locator('[data-task-list]').boundingBox())!.width).toBeGreaterThan(specBefore + 500);
  await capture(page, 'review-plan-full-width');
  await page.getByRole('button', { name: 'Show outline' }).click();
  await expect(outline).toBeVisible();
});

test('review step uses a tab bar instead of the outline rail for short plans', async ({ page }) => {
  await page.goto('/studio/plan-short');
  const tabs = page.getByRole('navigation', { name: 'Plan steps' });
  await expect(tabs).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Plan outline' })).toHaveCount(0);
  // Step tabs, not the reorder handles beside them.
  const stepTabs = tabs.getByRole('button', { name: /^\d+\. / });
  await expect(stepTabs).toHaveCount(3);
  await expect(tabs.getByRole('button', { name: '1. Shared Contracts' })).toHaveAttribute('aria-current', 'step');
  await expect(tabs.getByRole('button', { name: '3. Agent Run Store' })).toBeVisible();
  // With room to spare, tabs size to their labels on one line instead of truncating beside empty space.
  const clipped = await stepTabs.evaluateAll(buttons => buttons.flatMap(button => [...button.querySelectorAll('span')])
    .filter(label => label.scrollWidth > label.clientWidth + 1).map(label => label.textContent));
  expect(clipped).toEqual([]);
  const tabHeights = await stepTabs.evaluateAll(buttons => buttons.map(button => Math.round(button.getBoundingClientRect().height)));
  expect(new Set(tabHeights).size).toBe(1);
  // The phase pill keeps clear of the header's icon cluster.
  const pill = (await page.getByRole('navigation', { name: 'Plan phase' }).boundingBox())!;
  const nextControl = await page.getByRole('navigation', { name: 'Plan phase' }).evaluate(nav => {
    const right = nav.getBoundingClientRect().right;
    const header = nav.closest('header') ?? document.body;
    const lefts = [...header.querySelectorAll('button, a')].map(control => control.getBoundingClientRect())
      .filter(box => box.width > 0 && box.left >= right - 1).map(box => box.left);
    return Math.min(...lefts);
  });
  expect(nextControl - (pill.x + pill.width)).toBeGreaterThanOrEqual(12);
  const notes = page.getByText('User Notes').first().locator('xpath=ancestor::div[contains(@class, "rounded-md")][1]');
  await expect(notes).toHaveCSS('border-top-style', 'solid');
  await expect(notes.locator('.border-dashed')).toHaveCount(0);
  expect((await page.locator('[data-task-list]').boundingBox())!.width).toBeGreaterThan(700);
  await expect(tabs).toHaveCSS('background-color', 'rgb(255, 255, 255)');
  await expect(tabs).toHaveCSS('z-index', '10');
  // The tab bar is a fixed row above the scroll container, not sticky inside it.
  await expect(tabs).not.toHaveCSS('position', 'sticky');
  expect(await page.locator('[data-task-list]').evaluate(list => list.contains(document.querySelector('nav[aria-label="Plan steps"]')))).toBe(false);
  // Tabs show a short feature label on one line, with no ellipsis.
  for (const label of await tabs.getByRole('listitem').locator('span:last-child').all()) {
    expect(await label.evaluate(element => element.scrollWidth <= element.clientWidth && element.clientHeight <= parseFloat(getComputedStyle(element).lineHeight) + 1)).toBe(true);
  }
  // Each task has its own requirements, not task 1's copied.
  await expect(page.locator('[data-task-index="2"]')).toContainText('packages/server/src/runStore.ts');
  await expect(page.locator('[data-task-index="2"]')).not.toContainText('agentDefinitions.ts');
  // Headings drop the stored "Agents v1 (n/m):" prefix and let the leading number carry the order.
  await expect(page.locator('[data-task-index="0"]').getByRole('heading').first()).toContainText('Shared contracts for agent definitions');
  await expect(page.locator('[data-task-index="0"]').getByRole('heading').first()).not.toContainText('(1/3)');
  await expect(page.getByText(/\(\d+\/17\)/)).toHaveCount(0);
  // Phases sit on the title row and the primary action sits in the header: no stepper band, no footer bar.
  const header = page.getByRole('heading', { level: 1 }).locator('xpath=ancestor::div[contains(@class, "justify-between")][1]');
  await expect(header.getByRole('navigation', { name: 'Plan phase' })).toContainText('Review(3)');
  await expect(page.getByRole('navigation', { name: 'Progress' })).toBeHidden();
  await expect(header.getByRole('button', { name: 'Create 3 GitHub Issues' })).toBeVisible();
  await expect(page.getByText('3 tasks in plan')).toHaveCount(0);
  expect((await tabs.boundingBox())!.y).toBeLessThan(150);
  await page.getByRole('button', { name: 'More plan actions' }).click();
  await expect(page.getByRole('menuitem', { name: 'Delete plan' })).toBeVisible();
  await page.mouse.click(5, 5);
  await capture(page, 'review-plan-tabs');
  // Scrolled specification text stays below the tabs instead of showing through them.
  await page.locator('[data-task-list]').evaluate(element => { element.scrollTop = 330; });
  const tabBox = (await tabs.boundingBox())!;
  for (const x of [0.2, 0.5, 0.8]) {
    const hit = await page.evaluate(([px, py]) => !!document.elementFromPoint(px, py)?.closest('nav[aria-label="Plan steps"]'), [tabBox.x + tabBox.width * x, tabBox.y + tabBox.height - 2]);
    expect(hit).toBe(true);
  }
  // Wheel-scrolling and tab clicks move only the specification: nothing renders above the tabs.
  const tabTop = tabBox.y;
  await page.mouse.move(tabBox.x + 200, tabBox.y + 300);
  await page.mouse.wheel(0, 600);
  await stepTabs.nth(2).click();
  await expect(stepTabs.nth(2)).toHaveAttribute('aria-current', 'step');
  await page.waitForTimeout(800);
  expect((await tabs.boundingBox())!.y).toBe(tabTop);
  const listTop = (await page.locator('[data-task-list]').boundingBox())!.y;
  expect(listTop).toBeGreaterThanOrEqual(tabTop + tabBox.height - 1);
  await capture(page, 'review-plan-tabs-scrolled');
  // Scroll-spy: the specification is one continuous document, so scrolling moves the active tab.
  const list = page.locator('[data-task-list]');
  const task2Top = await page.locator('[data-task-index="1"]').evaluate(card => {
    const container = card.closest('[data-task-list]')!;
    return container.scrollTop + card.getBoundingClientRect().top - container.getBoundingClientRect().top;
  });
  await list.evaluate((element, top) => { element.scrollTop = top; }, task2Top);
  await expect(stepTabs.nth(1)).toHaveAttribute('aria-current', 'step');
  await capture(page, 'review-plan-tabs-scroll-spy');
  await list.evaluate(element => { element.scrollTop = 0; });
  await expect(stepTabs.nth(0)).toHaveAttribute('aria-current', 'step');
  await page.locator('[data-task-list]').evaluate(element => { element.scrollTop = 0; });
  await notes.scrollIntoViewIfNeeded();
  await capture(page, 'review-plan-user-notes');
});

test('execution step renders one matrix with batch controls and labelled ultrafix inputs', async ({ page }) => {
  await page.goto('/studio/plan-mcp-exec');
  await expect(page.getByRole('radio', { name: 'Execute as Individual Tasks' })).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId('plan-execution-matrix').getByTestId('plan-execution-row')).toHaveCount(3);
  await expect(page.getByTestId('plan-execution-matrix').getByTestId('agent-chip')).toHaveText('Opus 5.5');
  for (const button of await page.getByRole('button', { name: 'Implement' }).all()) await expect(button).not.toHaveClass(/amber/);
  const configButton = page.getByTestId('execution-config-button');
  await expect(configButton).toContainText('Opus 5.5 · Ultrafix (8/10) · Auto-merge');
  await expect(page.getByText('PR Options')).toHaveCount(0);
  expect((await page.getByTestId('execution-options-bar').boundingBox())!.height).toBeLessThanOrEqual(56);
  // Agent and action columns line up across running and pending rows.
  const rows = page.getByTestId('plan-execution-matrix').getByTestId('plan-execution-row');
  const agentX = await rows.getByTestId('agent-column').evaluateAll(cells => cells.map(cell => Math.round(cell.getBoundingClientRect().x)));
  const actionX = await rows.getByTestId('action-column').evaluateAll(cells => cells.map(cell => Math.round(cell.getBoundingClientRect().x)));
  expect(new Set(agentX).size).toBe(1);
  expect(new Set(actionX).size).toBe(1);
  expect(actionX[0]).toBeGreaterThan(agentX[0]);
  await expect(rows.nth(0).getByTestId('action-column')).toContainText('View Progress');
  await expect(rows.nth(1).getByTestId('action-column')).toContainText('Implement');
  await expect(page.getByRole('navigation', { name: 'Plan phase' })).toBeVisible();
  await page.waitForTimeout(500);
  await capture(page, 'execution-matrix');
  await configButton.click();
  await expect(page.getByRole('dialog', { name: 'Execution config' })).toBeVisible();
  await expect(page.getByLabel('Max Loops')).toHaveValue('5');
  await expect(page.getByLabel('Min Review Score').locator('option:checked')).toHaveText('◆ 8/10 (Standard)');
  await expect(page.getByTestId('ultrafix-nested-settings')).toBeVisible();
  const matrix = page.getByTestId('plan-execution-matrix');
  await expect(matrix.getByRole('combobox')).toHaveCount(0);
  await expect(matrix.getByTestId('agent-override-chip').first()).toHaveText('Opus 5.5');
  // #2798 is running; the batch stays available and queues its successors behind it.
  await expect(page.getByRole('button', { name: 'Queue Remaining (2 tasks)' })).toBeEnabled();
  await capture(page, 'execution-config-popover');
  await page.keyboard.press('Escape');
  await matrix.getByTestId('agent-override-chip').first().click();
  const override = page.getByRole('dialog', { name: /Agent override for #2799/ });
  await expect(override).toBeVisible();
  await expect(override.getByRole('button', { name: 'Reset to default' })).toHaveCount(0);
  // A per-issue override offers a way back to the plan default.
  await override.getByRole('combobox').nth(1).selectOption('claude-sonnet-5-5');
  await expect(matrix.getByTestId('agent-override-chip').first()).toHaveText('Sonnet 5.5');
  await expect(override.getByRole('button', { name: 'Reset to default' })).toBeVisible();
  await capture(page, 'execution-agent-override');
  await override.getByRole('button', { name: 'Reset to default' }).click();
  await expect(override).toHaveCount(0);
  await expect(matrix.getByTestId('agent-override-chip').first()).toHaveText('Opus 5.5');
  // Clicking anywhere else dismisses the popover.
  await matrix.getByTestId('agent-override-chip').first().click();
  await expect(override).toBeVisible();
  await page.mouse.click(700, 700);
  await expect(override).toHaveCount(0);
});

test('execution step for a 17-issue plan keeps the title readable and queues the backlog while others run', async ({ page }) => {
  await page.goto('/studio/plan-agents-exec');
  const matrix = page.getByTestId('plan-execution-matrix');
  await expect(matrix.getByTestId('plan-execution-row')).toHaveCount(12);
  // The title keeps at least 320px next to the grouped header controls.
  const title = page.getByRole('heading', { level: 1 });
  expect((await title.boundingBox())!.width).toBeGreaterThanOrEqual(320);
  // A compact repository chip leads the title so the git context is never lost.
  const repoChip = page.getByTestId('plan-repo-chip');
  await expect(repoChip).toHaveText('propr');
  await expect(repoChip).toHaveAttribute('title', 'integry/propr / main');
  expect((await repoChip.boundingBox())!.x).toBeLessThan((await title.boundingBox())!.x);
  await expect(page.getByRole('link', { name: 'View issues on GitHub' })).toHaveText('GitHub');
  // Header clusters are spaced by gaps, with no drawn or typed pipe dividers.
  const header = page.getByTestId('plan-repo-chip').locator('xpath=../..');
  await expect(header.locator('.w-px')).toHaveCount(0);
  expect(await header.innerText()).not.toContain('|');
  await expect(page.getByTitle('Delete Plan')).toHaveCount(0);
  await page.getByRole('button', { name: 'More plan actions' }).click();
  await expect(page.getByRole('menuitem', { name: 'Delete plan' })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.mouse.click(5, 5);
  // Rows lead with the step, not "Agents v1 (6/17):".
  await expect(matrix.getByText('Report-run prompt builder with previous reports and input files', { exact: true })).toBeVisible();
  await expect(matrix.getByText(/Agents v1 \(/)).toHaveCount(0);
  // Running issues do not hold the backlog: the batch queues the rest behind them without starting any now.
  const queue = page.getByRole('button', { name: 'Queue Remaining (10 tasks)' });
  await expect(queue).toBeEnabled();
  await expect(page.getByTestId('execute-all-hint')).toContainText('Queues 10 tasks behind the running work');
  await page.waitForTimeout(500);
  await capture(page, 'execution-17-issues');
  await queue.scrollIntoViewIfNeeded();
  await capture(page, 'execution-17-issues-queue');
  await queue.click();
  await expect(page.getByTestId('execute-all-hint')).toContainText('10 tasks queued. Each starts automatically');
  await expect(page.getByRole('button', { name: /Queue Remaining/ })).toHaveCount(0);
  await expect(matrix.getByText('Queued', { exact: true })).toHaveCount(10);
  expect(queueRequests).toEqual(['plan-agents-exec']);
  expect(implementRequests).toEqual([]);
  await page.getByTestId('execute-all-hint').scrollIntoViewIfNeeded();
  await capture(page, 'execution-17-issues-queued');
});

test('execution title renders in full on a widescreen header', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto('/studio/plan-agents-exec');
  const title = page.getByRole('heading', { level: 1 });
  await expect(title).toHaveText('Add an "Agents" feature to ProPR, scoped to a deliberately small v1');
  expect(await title.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  await page.waitForTimeout(500);
  await capture(page, 'execution-widescreen-title');
});

test('define step shows technical scope estimates and consistent token units', async ({ page }) => {
  await page.goto('/studio/plan-setup');
  await expect(page.getByTestId('context-scope-descriptor')).toContainText('Full Repository Scan');
  await expect(page.getByText(/Slower|\$\$\$/)).toHaveCount(0);
  const generate = page.getByRole('button', { name: /Generate Plan/ });
  const breakPlan = page.getByText('Break plan:');
  expect(Math.abs((await generate.boundingBox())!.y + (await generate.boundingBox())!.height / 2 - ((await breakPlan.boundingBox())!.y + (await breakPlan.boundingBox())!.height / 2))).toBeLessThan(8);
  await expect(page.getByTestId('branch-chip')).toContainText('main');
  // Generation settings are docked to the prompt box, not pinned to a page-wide footer.
  const composerFooter = page.getByTestId('composer-footer');
  await expect(composerFooter.getByRole('button', { name: /Generate Plan/ })).toBeVisible();
  await expect(composerFooter.getByText('Break plan:')).toBeVisible();
  expect((await composerFooter.boundingBox())!.y + (await composerFooter.boundingBox())!.height).toBeLessThan(700);
  await expect(page.getByRole('navigation', { name: 'Plan phase' })).toContainText('Define');
  await capture(page, 'define-context-scope');
});

test('model selectors name the default model instead of a bare "Default"', async ({ page }) => {
  await page.goto('/studio/plan-setup');
  const defineModel = page.getByTestId('composer-footer').getByTestId('planner-model-selector');
  await expect(defineModel).toHaveText('Claude Opus 5.5 (Default)');
  // The docked row leaves the full label readable rather than truncating it to "Cla…".
  expect(await defineModel.locator('span').last().evaluate(label => label.scrollWidth <= label.clientWidth)).toBe(true);
  await defineModel.click();
  const menu = page.getByRole('listbox', { name: 'Plan model' });
  await expect(menu.getByRole('option', { selected: true })).toContainText('Claude Opus 5.5 (Configured Default)');
  await expect(menu.getByRole('option')).toHaveCount(3);
  await capture(page, 'define-model-default-menu');
  await menu.getByRole('option', { name: /Claude Sonnet 5\.5/ }).click();
  await expect(defineModel).toHaveText('Claude Sonnet 5.5');

  await page.goto('/studio/plan-agents');
  const assistant = page.getByTestId('plan-assistant');
  await expect(assistant.getByText('Refine with')).toHaveCount(0);
  await expect(assistant.getByText('Model:')).toBeVisible();
  const refineModel = assistant.getByTestId('planner-model-selector');
  await expect(refineModel).toHaveText('Claude Opus 5.5 (Default)');
  await refineModel.click();
  await expect(page.getByRole('listbox', { name: 'Plan model' }).getByRole('option', { selected: true })).toContainText('Claude Opus 5.5 (Configured Default)');
  await capture(page, 'review-assistant-model-menu');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('listbox', { name: 'Plan model' })).toHaveCount(0);
});

test('short plans can still be reordered from the tab bar', async ({ page }) => {
  await page.goto('/studio/plan-short');
  const tabs = page.getByRole('navigation', { name: 'Plan steps' });
  const stepTabs = tabs.getByRole('button', { name: /^\d+\. / });
  await expect(stepTabs.first()).toHaveAccessibleName('1. Shared Contracts');
  await tabs.getByRole('listitem').nth(2).hover();
  const handle = (await tabs.getByLabel('Reorder step 3').boundingBox())!;
  const firstTab = (await tabs.getByRole('listitem').first().boundingBox())!;
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle.x - 40, handle.y + handle.height / 2, { steps: 5 });
  await page.mouse.move(firstTab.x + 20, firstTab.y + firstTab.height / 2, { steps: 15 });
  await page.mouse.up();
  await expect(stepTabs.first()).toHaveAccessibleName('1. Agent Run Store');
  await expect(stepTabs.nth(1)).toHaveAccessibleName('2. Shared Contracts');
  await expect(page.locator('[data-task-index="0"]')).toContainText('Agent run store');
  // Let the reordered cards finish their layout animation before capturing.
  await page.waitForTimeout(600);
  await capture(page, 'review-plan-tabs-reordered');
});

test('execution popovers stay inside the viewport near its bottom edge', async ({ page }) => {
  // A laptop-height window, so the matrix scrolls and a pending row can sit at the bottom edge.
  await page.setViewportSize({ width: 1440, height: 600 });
  await page.goto('/studio/plan-agents-exec');
  const matrix = page.getByTestId('plan-execution-matrix');
  // The fifth pending row sits at the bottom of the scrolled matrix, with too little room below for the popover.
  const chip = matrix.getByTestId('agent-override-chip').nth(4);
  const chipBox = (await chip.boundingBox())!;
  expect(chipBox.y + chipBox.height).toBeGreaterThan(600 - 70);
  await chip.click();
  const dialog = page.getByRole('dialog', { name: /Agent override for #\d+/ });
  await expect(dialog).toBeVisible();
  const box = (await dialog.boundingBox())!;
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(600);
  // Flipped above the chip rather than running off the bottom of the screen.
  expect(box.y + box.height).toBeLessThanOrEqual(chipBox.y);
  await expect(dialog.getByRole('combobox').first()).toBeInViewport();
  await capture(page, 'execution-agent-override-flipped');
  await page.keyboard.press('Escape');

  // On a short viewport the config popover scrolls internally instead of overflowing.
  await page.setViewportSize({ width: 1440, height: 420 });
  await page.getByTestId('execution-config-button').scrollIntoViewIfNeeded();
  await page.getByTestId('execution-config-button').click();
  const config = page.getByRole('dialog', { name: 'Execution config' });
  await expect(config).toBeVisible();
  const configBox = (await config.boundingBox())!;
  expect(configBox.y).toBeGreaterThanOrEqual(0);
  expect(configBox.y + configBox.height).toBeLessThanOrEqual(420);
  await expect(config).toHaveCSS('overflow-y', 'auto');
  await config.getByLabel('Max Loops').scrollIntoViewIfNeeded();
  await expect(config.getByLabel('Max Loops')).toBeInViewport();
  await capture(page, 'execution-config-short-viewport');
});
