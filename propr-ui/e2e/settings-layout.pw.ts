import { expect, test } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { capture, installSettingsFixture } from './settings-layout.fixture';

/**
 * The Settings redesign: one contained column, Utility Headers over 1px
 * dividers, single-column form groups, and quiet status indicators. These
 * checks guard the structure; with PROPR_CAPTURE_PREVIEWS set they also capture
 * one screenshot per tab.
 */

test('lays settings out as a vertical rail beside one contained, single-column form', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await installSettingsFixture(page);
  await page.goto('/settings?tab=models');

  // A vertical rail lists the settings domains, with no arbitrary counts.
  const rail = page.getByRole('tablist', { name: 'Settings categories' });
  await expect(rail.getByRole('tab')).toHaveText([
    'General', 'AI Models & Reasoning', 'Workflow & PR Rules', 'Ultrafix & Escalation',
    'Sandbox & Network', 'Agent Extensions & Packages', 'Integrations & MCP', 'Notifications',
  ]);
  const tabBoxes = await Promise.all((await rail.getByRole('tab').all()).map(tab => tab.boundingBox()));
  for (const box of tabBoxes.slice(1)) {
    expect(Math.abs(box!.x - tabBoxes[0]!.x)).toBeLessThanOrEqual(1);
    expect(box!.y).toBeGreaterThan(tabBoxes[0]!.y);
  }
  // The rail names the open domain; the pane does not repeat it as a heading.
  await expect(page.getByRole('heading', { name: 'AI Models & Reasoning' })).toHaveCount(0);

  // The form is contained rather than stretching across a 1600px canvas.
  const select = page.getByLabel('Plan Generation Model');
  await expect(select).toBeVisible();
  const width = await select.evaluate(element => element.getBoundingClientRect().width);
  expect(width).toBeLessThanOrEqual(672);

  // Utility Headers divide sections instead of side-headers in a left gutter.
  for (const heading of ['Implementation', 'Planning', 'Review']) {
    await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible();
  }
  await capture(page, 'settings-ai-models');

  await page.getByRole('tab', { name: 'Workflow & PR Rules' }).click();
  await expect(page).toHaveURL(/\/settings\?tab=workflow$/);
  await expect(page.getByLabel('Worker Concurrency')).toBeVisible();
  // Ultrafix, sandbox and usage-tip settings no longer share this page.
  for (const label of ['Max Cycles', 'Network mode', 'Show usage tips']) {
    await expect(page.getByLabel(label, { exact: true })).toBeHidden();
  }
  await capture(page, 'settings-workflow');

  // List settings are tag inputs: chips sit inside the input container and
  // Enter or comma turns the typed text into a chip.
  const whitelist = page.getByRole('region', { name: 'GitHub trigger whitelist' });
  await expect(whitelist.getByRole('button', { name: 'Add' })).toHaveCount(0);
  const chipRemove = whitelist.getByRole('button', { name: 'Remove octocat' });
  await expect(chipRemove).toBeVisible();
  const tagInput = whitelist.getByLabel('GitHub username');
  await expect(chipRemove.locator('xpath=../..')).toHaveAttribute('data-tag-input');
  await expect(tagInput.locator('xpath=..')).toHaveAttribute('data-tag-input');
  await tagInput.fill('monalisa');
  await tagInput.press('Enter');
  await tagInput.pressSequentially('dependabot,');
  await expect(whitelist.getByRole('button', { name: 'Remove monalisa' })).toBeVisible();
  await expect(whitelist.getByRole('button', { name: 'Remove dependabot' })).toBeVisible();
  await expect(tagInput).toHaveValue('');
  // A pasted list becomes one chip per entry, saved together; Enter adds the last one.
  const pasted = page.waitForRequest(request => request.url().endsWith('/api/config/settings') && request.method() === 'POST');
  await tagInput.fill('alice,bob,carol');
  expect((await pasted).postDataJSON().settings.github_user_whitelist).toEqual(['octocat', 'hubot', 'monalisa', 'dependabot', 'alice', 'bob']);
  await expect(tagInput).toHaveValue('carol');
  await tagInput.press('Enter');
  await expect(whitelist.getByRole('button', { name: /^Remove (alice|bob|carol)$/ })).toHaveCount(3);
  await capture(page, 'settings-workflow-lists', whitelist);

  await page.getByRole('tab', { name: 'Sandbox & Network' }).click();
  const network = page.getByRole('region', { name: 'Agent network' });
  await expect(network.getByLabel('Network mode')).toHaveValue('restricted');
  await expect(network.getByLabel('Additional allowed hosts')).toHaveValue('registry.example.com\n*.internal.example.com');
  await expect(network.getByLabel('Repository allowed hosts')).toHaveValue('true');
  // The watchdog guards every agent run, so it sits with the other execution limits.
  await expect(page.getByRole('region', { name: 'Agent watchdog' })).toBeVisible();
  if (process.env.PROPR_CAPTURE_PREVIEWS) {
    await mkdir(path.resolve('../.propr/previews'), { recursive: true });
    await network.scrollIntoViewIfNeeded();
    await network.screenshot({ animations: 'disabled', path: path.resolve('../.propr/previews/settings-agent-network.png') });
  }

  await page.getByRole('tab', { name: 'Ultrafix & Escalation' }).click();
  // A newly opened category starts at its top, not at the previous one's scroll offset.
  await expect.poll(() => page.locator('[data-settings-scroll]').evaluate(element => element.scrollTop)).toBe(0);
  await expect(page.getByLabel('Target Review Score')).toHaveValue('7');
  await expect(page.getByLabel('Target Review Score').locator('option:checked')).toHaveText('7/10 (Default)');
  await expect(page.getByRole('region', { name: 'Agent watchdog' })).toBeHidden();
  await capture(page, 'settings-ultrafix');

  await page.getByRole('tab', { name: 'General' }).click();
  await expect(page.getByLabel('Show usage tips')).toBeVisible();
  await expect(page.getByRole('checkbox', { name: 'Enable voice briefings' })).toBeVisible();
  await capture(page, 'settings-general');

  await page.getByRole('tab', { name: 'Integrations & MCP' }).click();
  await expect(page.getByRole('heading', { name: 'LLM Usage Tracking' })).toBeVisible();
  await expect(page.getByText('Agent Tank connected')).toBeVisible();
  await capture(page, 'settings-integrations');
  await capture(page, 'settings-mcp', page.getByRole('region', { name: 'MCP Server', exact: true }));

  // Card Hell stays banned: these blocks are separated by rules, not boxes.
  const storage = page.getByRole('region', { name: 'Managed preview storage' });
  await expect(storage).toHaveCSS('border-top-width', '0px');
  await expect(storage).toHaveCSS('border-radius', '0px');
  await capture(page, 'settings-integrations-storage', storage);

  await page.getByRole('tab', { name: 'Notifications' }).click();
  const inbox = page.getByLabel('Inbox notifications for Plans');
  await expect(inbox).toBeVisible();
  // The checkbox sits centred under its own column header.
  const header = page.getByRole('region', { name: 'Personal notifications' }).getByText('Inbox', { exact: true });
  const [checkboxBox, headerBox] = await Promise.all([inbox.boundingBox(), header.boundingBox()]);
  const centre = (box: { x: number; width: number } | null): number => (box!.x + box!.width / 2);
  expect(Math.abs(centre(checkboxBox) - centre(headerBox))).toBeLessThanOrEqual(2);
  await capture(page, 'settings-notifications');
  if (process.env.PROPR_CAPTURE_PREVIEWS) {
    await page.getByRole('region', { name: 'Personal notifications' }).screenshot({ path: '../.propr/previews/settings-personal-notifications.png', animations: 'disabled' });
  }
});

test('balances a widescreen canvas with an inspector beside the form', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await installSettingsFixture(page);
  await page.goto('/settings?tab=sandbox');

  const inspector = page.getByRole('complementary', { name: 'About Sandbox & Network' });
  await expect(inspector).toBeVisible();
  await expect(inspector).toContainText('per-run proxy');
  await expect(inspector.getByRole('link', { name: 'Restricted network mode' }))
    .toHaveAttribute('href', 'https://docs.propr.dev/docs/features/execution-safety#restricted-network-mode');

  // Rail, form and inspector sit in one centred band: the space left of the
  // rail and right of the inspector match instead of pooling on the right.
  const scroll = (await page.locator('[data-settings-scroll]').boundingBox())!;
  const rail = (await page.locator('[data-settings-rail]').boundingBox())!;
  const inspectorBox = (await inspector.boundingBox())!;
  const leftGutter = rail.x - scroll.x;
  const rightGutter = scroll.x + scroll.width - (inspectorBox.x + inspectorBox.width);
  expect(Math.abs(leftGutter - rightGutter)).toBeLessThanOrEqual(24);
  expect(rightGutter).toBeLessThan(scroll.width * 0.2);
  // The save status starts where the rail does.
  const status = (await page.getByRole('status').filter({ hasText: 'Changes save automatically' }).boundingBox())!;
  expect(Math.abs(status.x - rail.x)).toBeLessThanOrEqual(2);
  await capture(page, 'settings-widescreen-sandbox');

  await page.getByRole('tab', { name: 'Ultrafix & Escalation' }).click();
  await expect(page.getByRole('complementary', { name: 'About Ultrafix & Escalation' })).toContainText('6 → 7 resets patience');
  await capture(page, 'settings-widescreen-ultrafix');

  // Search results mix categories, so the inspector steps aside.
  await page.getByRole('searchbox', { name: 'Search settings' }).fill('labels');
  await expect(page.locator('[data-settings-inspector]')).toHaveCount(0);

  // Below 2xl the inspector folds away and the form keeps its width.
  await page.getByRole('searchbox', { name: 'Search settings' }).fill('');
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.getByRole('complementary', { name: 'About Ultrafix & Escalation' })).toBeHidden();
});

test('keeps helper text inside the block it belongs to', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await installSettingsFixture(page);
  await page.goto('/settings?tab=workflow');

  const labels = page.locator('[data-settings-section="primary-processing-labels"]');
  const helper = labels.getByText('State labels (-processing, -done) are generated automatically.');
  await expect(labels).toHaveCSS('border-bottom-width', '1px');
  const [helperBox, labelsBox, nextBox] = await Promise.all([
    helper.boundingBox(),
    labels.boundingBox(),
    page.locator('[data-settings-section="follow-up-keywords"]').boundingBox(),
  ]);
  // The helper ends inside its block, and the rule sits no further from it
  // than from the next block's header, so the helper reads as part of its own block.
  const ruleY = labelsBox!.y + labelsBox!.height;
  const helperToRule = ruleY - (helperBox!.y + helperBox!.height);
  const ruleToNext = nextBox!.y - ruleY;
  expect(helperToRule).toBeGreaterThanOrEqual(24);
  expect(helperToRule).toBeLessThanOrEqual(ruleToNext + 1);
  await capture(page, 'settings-block-separation', page.locator('[data-settings-section="follow-up-keywords"]'));
});

test('drills into settings on a phone instead of scrolling a tab strip', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 780 });
  await installSettingsFixture(page);
  await page.goto('/settings');

  // Screen 1: every category is listed vertically and fully readable.
  const tabs = page.getByRole('tablist', { name: 'Settings categories' }).getByRole('tab');
  await expect(tabs).toHaveCount(8);
  for (const tab of await tabs.all()) {
    await expect(tab).toBeInViewport({ ratio: 1 });
    expect(await tab.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  }
  await expect(page.getByLabel('Show usage tips')).toBeHidden();
  await capture(page, 'settings-mobile-menu');

  // Screen 2: one category under a back button.
  await page.getByRole('tab', { name: 'Workflow & PR Rules' }).click();
  const back = page.getByRole('button', { name: 'Back to Settings' });
  await expect(back).toBeVisible();
  await expect(page.getByLabel('Worker Concurrency')).toBeVisible();
  await expect(page.getByRole('searchbox', { name: 'Search settings' })).toBeHidden();
  await expect(page.locator('[data-settings-mobile-header]')).toContainText('Workflow & PR Rules');
  await capture(page, 'settings-mobile-category');

  await back.click();
  await expect(tabs.first()).toBeVisible();
  await expect(page.getByLabel('Worker Concurrency')).toBeHidden();

  // A link that names a category opens straight into it, without overflowing.
  await page.goto('/settings?tab=models');
  await expect(page.getByRole('button', { name: 'Back to Settings' })).toBeVisible();
  const select = page.getByLabel('Plan Generation Model');
  await expect(select).toBeVisible();
  const overflow = await page.evaluate(() => {
    const element = document.scrollingElement!;
    return element.scrollWidth - element.clientWidth;
  });
  expect(overflow).toBeLessThanOrEqual(1);
  await capture(page, 'settings-mobile');
});


test('walks the phone category list with the keyboard before opening one', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 780 });
  await installSettingsFixture(page);
  await page.goto('/settings');

  const tabs = page.getByRole('tablist', { name: 'Settings categories' });
  await tabs.getByRole('tab', { name: 'General' }).focus();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');

  // Arrows only move focus: the list stays up and the route is unchanged.
  const workflow = tabs.getByRole('tab', { name: 'Workflow & PR Rules' });
  await expect(workflow).toBeFocused();
  await expect(workflow).toBeVisible();
  expect(new URL(page.url()).search).toBe('');
  await expect(page.getByRole('button', { name: 'Back to Settings' })).toHaveCount(0);

  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\?tab=workflow$/);
  await expect(page.getByRole('button', { name: 'Back to Settings' })).toBeVisible();
  await expect(page.getByLabel('Worker Concurrency')).toBeVisible();
});

test('fast analysis model describes the review context scout', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 820 });
  await installSettingsFixture(page);
  await page.goto('/settings?tab=models');
  const field = page.getByLabel('Fast Analysis Model');
  await expect(field).toBeVisible();
  await expect(field).toHaveValue('codex:gpt-5-codex');
  await expect(page.getByText('Used by /review to gather repository context before the review.')).toBeVisible();
  await expect(page.getByText('Post-Implementation Analysis Model')).toHaveCount(0);
  await field.scrollIntoViewIfNeeded();
  if (process.env.PROPR_CAPTURE_PREVIEWS) {
    const directory = path.resolve('../.propr/previews');
    await mkdir(directory, { recursive: true });
    await page.locator('label[for="analysis_model_fast"]').locator('..').screenshot({
      animations: 'disabled', path: path.join(directory, 'fast-analysis-model.png'),
    });
  }
  await page.getByRole('tab', { name: 'Workflow & PR Rules' }).click();
  await expect(page.getByLabel('Auto-Followup Score Threshold')).toHaveCount(0);
});

test('ultrafix escalation controls retain ordered models and support direct handoff', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  await installSettingsFixture(page);
  await page.goto('/settings?tab=ultrafix');
  const section = page.getByRole('region', { name: 'Ultrafix', exact: true });
  await expect(section.getByLabel('Automatic Escalation')).not.toBeChecked();
  for (const label of ['Add escalation model', 'Escalation Patience', 'Max Reasoning Levels per Model']) {
    await expect(section.getByLabel(label)).toHaveCount(0);
  }
  const pause = section.getByLabel('Pause Between Cycles');
  const toggle = section.getByLabel('Automatic Escalation');
  expect(await pause.evaluate((element, nextId) => Boolean(
    element.compareDocumentPosition(document.getElementById(nextId)!) & Node.DOCUMENT_POSITION_FOLLOWING
  ), 'ultrafix_escalation_enabled')).toBe(true);
  await toggle.check();
  const models = section.getByLabel('Escalation model 1', { exact: true });
  await section.getByLabel('Add escalation model').selectOption('codex:gpt-6-astra');
  await section.getByLabel('Add escalation model').selectOption('claude:claude-opus-5-5');
  await models.selectOption('codex:gpt-5-codex');
  await expect(models).toHaveValue('codex:gpt-5-codex');
  await models.selectOption('codex:gpt-6-astra');
  await section.getByLabel('Add escalation model').selectOption('claude:claude-sonnet-5-5');
  await section.getByRole('button', { name: 'Remove escalation model 3' }).click();
  await expect(section.getByLabel('Escalation model 3', { exact: true })).toHaveCount(0);
  await section.getByLabel('Escalation Patience').fill('4');
  await section.getByLabel('Max Reasoning Levels per Model').fill('0');
  await expect(models).toHaveValue('codex:gpt-6-astra');
  await expect(section.getByLabel('Escalation model 2', { exact: true })).toHaveValue('claude:claude-opus-5-5');
  await expect(section.getByLabel('Automatic Escalation')).toBeChecked();
  await expect(section.getByLabel('Max Reasoning Levels per Model')).toHaveValue('0');
  const saved = page.waitForResponse(response => {
    const request = response.request();
    return new URL(response.url()).pathname === '/api/config/settings'
      && request.method() === 'POST'
      && request.postDataJSON().settings.ultrafix_escalation_max_reasoning_levels === 0;
  });
  await section.getByLabel('Max Reasoning Levels per Model').blur();
  const response = await saved;
  expect(response.ok()).toBe(true);
  expect(response.request().postDataJSON().settings).toMatchObject({
    ultrafix_escalation_enabled: true,
    ultrafix_escalation_models: ['codex:gpt-6-astra', 'claude:claude-opus-5-5'],
    ultrafix_escalation_patience: 4,
    ultrafix_escalation_max_reasoning_levels: 0,
  });
  await expect(page.getByRole('status').filter({ hasText: 'All changes saved' })).toBeVisible();
  await page.reload();
  await expect(section.getByLabel('Automatic Escalation')).toBeChecked();
  await expect(models).toHaveValue('codex:gpt-6-astra');
  await expect(section.getByLabel('Escalation model 2', { exact: true })).toHaveValue('claude:claude-opus-5-5');
  await expect(section.getByLabel('Escalation Patience')).toHaveValue('4');
  await expect(section.getByLabel('Max Reasoning Levels per Model')).toHaveValue('0');
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    const boxes = await Promise.all([
      models.boundingBox(),
      section.getByLabel('Escalation model 2', { exact: true }).boundingBox(),
      section.getByLabel('Add escalation model').boundingBox(),
    ]);
    for (const box of boxes) {
      expect(box).not.toBeNull();
      expect(Math.abs(box!.x - boxes[0]!.x)).toBeLessThanOrEqual(1);
      expect(Math.abs(box!.width - boxes[0]!.width)).toBeLessThanOrEqual(1);
    }
    expect(await page.evaluate(() => document.scrollingElement!.scrollWidth - document.scrollingElement!.clientWidth))
      .toBeLessThanOrEqual(1);
    if (process.env.PROPR_CAPTURE_PREVIEWS) {
      await mkdir(path.resolve('../.propr/previews'), { recursive: true });
      if (width === 1280) await page.setViewportSize({ width, height: 1400 });
      const preview = width === 390
        ? section.locator('label').filter({ hasText: 'Escalation Models (in order)' }).locator('..')
        : section;
      await preview.screenshot({ path: `../.propr/previews/ultrafix-escalation-${width}.png`, animations: 'disabled' });
    }
  }
  await toggle.uncheck();
  for (const label of ['Escalation model 1', 'Add escalation model', 'Escalation Patience', 'Max Reasoning Levels per Model']) {
    await expect(section.getByLabel(label, { exact: true })).toHaveCount(0);
  }
  if (process.env.PROPR_CAPTURE_PREVIEWS) {
    await page.setViewportSize({ width: 1280, height: 1000 });
    await section.screenshot({ path: '../.propr/previews/ultrafix-escalation-disabled.png', animations: 'disabled' });
  }
  await toggle.check();
  await expect(models).toHaveValue('codex:gpt-6-astra');
  await expect(section.getByLabel('Escalation Patience')).toHaveValue('4');
  await expect(section.getByLabel('Max Reasoning Levels per Model')).toHaveValue('0');
});

test('agent watchdog thresholds save as overrides of the environment defaults', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await installSettingsFixture(page);
  await page.goto('/settings?tab=sandbox');
  const section = page.getByRole('region', { name: 'Agent watchdog' });
  await expect(section).toBeVisible();
  const stall = section.getByLabel('Stall timeout (minutes)', { exact: true });
  await expect(stall).toHaveValue('5');
  await expect(section.getByLabel('Tool stall timeout (minutes)')).toHaveAttribute('placeholder', 'Default: 30');

  const saved = page.waitForRequest(request => request.url().endsWith('/api/config/settings') && request.method() === 'POST');
  await stall.fill('15');
  await stall.blur();
  expect((await saved).postDataJSON().settings).toMatchObject({
    agent_stall_timeout_ms: 900_000, agent_tool_stall_timeout_ms: null, agent_degenerate_output_limit: null,
  });
  if (process.env.PROPR_CAPTURE_PREVIEWS) {
    const directory = path.resolve('../.propr/previews');
    await mkdir(directory, { recursive: true });
    await section.scrollIntoViewIfNeeded();
    await section.screenshot({ animations: 'disabled', path: path.join(directory, 'agent-watchdog-settings.png') });
  }
});
