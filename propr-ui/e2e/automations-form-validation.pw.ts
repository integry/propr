/**
 * The new-automation form at desktop (1440) and phone (390) widths: errors in words under their fields with the first
 * one focused on submit, a full-width coding agent select, capabilities without raw ids, merging held back while the
 * automation is Report only, templates offered once, and the app's own dialog before typed input is replaced or closed.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { user } from './dashboard-sections.fixture';

const admin = { ...user, role: 'admin', permissions: ['instance.manage_settings'] };

async function formFixture(page: Page) {
  await page.routeWebSocket('**/socket.io/**', socket => socket.close());
  const writes: string[] = [];
  await page.route('**/api/**', route => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (request.method() !== 'GET') writes.push(`${request.method()} ${pathname}`);
    const responses: Record<string, unknown> = {
      '/api/auth/demo-mode': { demoMode: false },
      '/api/auth/user': admin,
      '/api/instance/catalog': {
        agents: [
          { alias: 'claude-main', type: 'claude', enabled: true, supportedModels: ['claude-opus-5-5'], defaultModel: 'claude-opus-5-5' },
          { alias: 'codex-main', type: 'codex', enabled: true, supportedModels: ['gpt-5.6-sol'], defaultModel: 'gpt-5.6-sol' },
        ],
        defaultAgentAlias: 'claude-main',
        repositories: [{ name: 'integry/propr', enabled: true }],
      },
      '/api/config/settings': { automation_unproductive_run_threshold: 4 },
      '/api/automation-definitions': { definitions: [], total: 0, limit: 200, offset: 0 },
      '/api/tasks': { tasks: [], total: 0 },
      '/api/notifications/unread-count': { unreadCount: 0 },
      '/api/notifications/preferences': { preferences: {}, quietHours: {}, badgeEnabled: false },
    };
    return route.fulfill(pathname in responses ? { json: responses[pathname] } : { status: 503, json: { error: 'Unavailable in automation form fixture' } });
  });
  return () => writes.filter(write => write.includes('automation'));
}

async function capture(target: Page | Locator, name: string) {
  if (!process.env.PROPR_CAPTURE_PREVIEWS) return;
  const directory = path.resolve('../.propr/previews');
  await mkdir(directory, { recursive: true });
  await target.screenshot({ animations: 'disabled', path: path.join(directory, `${name}.png`) });
}

/** Whether the element's box lies inside the scrolling pane that holds it, so a person can see it. */
const inView = (element: Locator) => element.evaluate(node => {
  const box = node.getBoundingClientRect();
  let scroller = node.parentElement;
  while (scroller && getComputedStyle(scroller).overflowY !== 'auto') scroller = scroller.parentElement;
  const pane = (scroller ?? document.documentElement).getBoundingClientRect();
  return box.top >= pane.top - 1 && box.bottom <= pane.bottom + 1;
});

for (const [label, viewport] of [['desktop', { width: 1440, height: 900 }], ['phone', { width: 390, height: 844 }]] as const) {
  test.describe(`automation form at ${viewport.width}px`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize(viewport);
    });

    test('shows errors under the fields in words and moves to the first one on submit', async ({ page }) => {
      const writes = await formFixture(page);
      await page.goto('/automations/new');
      const form = page.getByTestId('agent-editor');
      await expect(form.getByLabel('Name', { exact: true })).toBeVisible();

      await form.getByRole('button', { name: 'Create automation' }).click();
      const name = form.getByLabel('Name', { exact: true });
      await expect(form.getByTestId('agent-name-error')).toHaveText('Enter a name.');
      await expect(form.getByTestId('agent-prompt-error')).toHaveText('Enter a prompt.');
      await expect(name).toBeFocused();
      await expect(name).toHaveAttribute('aria-invalid', 'true');
      expect(await inView(name)).toBe(true);
      await expect(form.getByRole('alert')).toHaveCount(0);
      await expect(form).not.toContainText('name is required');
      await capture(page, `automation-form-errors-${label}`);

      // Fixing the name and prompt clears their errors; an incomplete schedule is worded and focused next.
      await name.fill('Nightly triage');
      await form.getByLabel('Prompt', { exact: true }).fill('Summarize new issues');
      await expect(form.getByTestId('agent-name-error')).toHaveCount(0);
      await form.getByRole('radio', { name: 'Repeat' }).click();
      await form.getByRole('button', { name: 'Use a cron expression' }).click();
      const cron = form.getByLabel('Cron expression');
      await cron.fill('0 9 * *');
      await expect(form.getByTestId('agent-schedule-feedback')).toHaveText('Enter a schedule with five parts, e.g. 0 9 * * 1-5.');
      await name.focus();
      await form.getByRole('button', { name: 'Create automation' }).click();
      await expect(cron).toBeFocused();
      await expect.poll(() => inView(cron)).toBe(true);
      await cron.fill('*/5 * * * *');
      await expect(form.getByTestId('agent-schedule-feedback')).toHaveText('Run at most every 15 minutes.');
      await expect(form).not.toContainText('cron expression');
      await capture(form.getByTestId('agent-schedule-feedback').locator('xpath=ancestor::div[contains(@class,"grid")][1]'), `automation-form-schedule-error-${label}`);

      // The pause hint states the instance's threshold.
      await expect(form.getByText('Pause the schedule after 4 runs in a row with nothing new')).toBeVisible();
      await expect(form.getByText('You get an Inbox notice either way.')).toBeVisible();

      // An event trigger without repositories asks for one.
      await cron.fill('0 9 * * 1-5');
      await form.getByRole('radio', { name: 'Plan issue blocked' }).click();
      await expect(form.getByText('Runs when a plan issue becomes blocked. Up to 3 runs per issue.')).toBeVisible();
      await form.getByRole('button', { name: 'Create automation' }).click();
      await expect(form.getByTestId('agent-event-trigger-error')).toHaveText('Choose at least one repository first.');
      await expect(form.getByRole('radio', { name: 'Plan issue blocked' })).toBeFocused();
      expect(writes()).toEqual([]);
    });

    test('lays the agent select, capabilities and templates out evenly and holds merging back while Report only', async ({ page }) => {
      await formFixture(page);
      await page.goto('/automations/new');
      const form = page.getByTestId('agent-editor');

      // The coding agent select is as wide as the name field and shows the default's whole name.
      const select = form.getByRole('combobox', { name: 'Coding agent' });
      await expect(select).toBeVisible();
      const [selectBox, nameBox] = await Promise.all([select.boundingBox(), form.getByLabel('Name', { exact: true }).boundingBox()]);
      expect(Math.abs((selectBox?.width ?? 0) - (nameBox?.width ?? 0))).toBeLessThanOrEqual(1);
      expect(await select.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
      await expect(form.getByText('The agent and model that write the report.')).toBeVisible();

      // Capabilities read as labels, with every switch on one vertical line.
      const capabilities = form.getByRole('switch');
      await expect(capabilities).toHaveCount(4);
      for (const id of ['repository_read', 'propr_mcp', 'merge']) await expect(form.locator('code', { hasText: id })).toHaveCount(0);
      const lefts = await capabilities.evaluateAll(nodes => nodes.map(node => Math.round(node.getBoundingClientRect().left)));
      expect(new Set(lefts).size).toBe(1);

      const merge = form.getByRole('switch', { name: /Merge pull requests/ });
      await expect(merge).toBeDisabled();
      await expect(form.getByTestId('agent-capability-merge-hint')).toHaveText('Not available with Report only: there is no action step to merge in.');
      await merge.scrollIntoViewIfNeeded();
      await capture(form.getByRole('switch', { name: /Read repositories/ }).locator('xpath=ancestor::div[contains(@class,"grid")][1]'), `automation-form-capabilities-${label}`);
      // The segments are visually hidden radios; the arrow keys move the choice.
      const reportOnly = form.getByRole('radio', { name: 'Report only' });
      await reportOnly.focus();
      await page.keyboard.press('ArrowRight');
      await page.keyboard.press('ArrowRight');
      await expect(form.getByRole('radio', { name: 'Auto' })).toBeChecked();
      await expect(merge).toBeEnabled();
      await page.keyboard.press('ArrowLeft');
      await page.keyboard.press('ArrowLeft');
      await expect(reportOnly).toBeChecked();
      await expect(merge).toBeDisabled();

      // Templates are listed once, as rows of one column.
      await expect(page.getByTestId('agent-template-links')).toHaveCount(0);
      const options = form.getByTestId('agent-template-option');
      expect(await options.count()).toBeGreaterThan(1);
      const columns = await options.evaluateAll(nodes => new Set(nodes.map(node => Math.round(node.getBoundingClientRect().left))).size);
      expect(columns).toBe(1);
      await form.getByTestId('agent-template-picker').scrollIntoViewIfNeeded();
      await capture(page, `automation-form-templates-${label}`);
    });

    test('asks in the app dialog before a template or Escape replaces typed input', async ({ page }) => {
      const writes = await formFixture(page);
      await page.goto('/automations/new');
      const form = page.getByTestId('agent-editor');
      await form.getByLabel('Name', { exact: true }).fill('My own review');
      await form.getByLabel('Prompt', { exact: true }).fill('Look at the open pull requests');

      await form.getByTestId('agent-template-option').first().click();
      const replace = page.getByRole('dialog', { name: /^Replace what you entered with/ });
      await expect(replace).toBeVisible();
      await capture(page, `automation-template-confirm-${label}`);
      await replace.getByRole('button', { name: 'Keep editing' }).click();
      await expect(replace).toHaveCount(0);
      await expect(form.getByLabel('Name', { exact: true })).toHaveValue('My own review');

      if (label === 'desktop') {
        // Escape (outside a field) closes the pane, but only after asking.
        await form.getByRole('heading', { name: 'New automation' }).click();
        await page.keyboard.press('Escape');
        const discard = page.getByRole('dialog', { name: 'Discard unsaved changes?' });
        await expect(discard).toBeVisible();
        await discard.getByRole('button', { name: 'Keep editing' }).click();
        await expect(page).toHaveURL(/\/automations\/new$/);
        await expect(form.getByLabel('Name', { exact: true })).toHaveValue('My own review');
        await page.getByRole('button', { name: 'Close automation' }).click();
        await page.getByRole('dialog', { name: 'Discard unsaved changes?' }).getByRole('button', { name: 'Discard', exact: true }).click();
        await expect(page).toHaveURL(/\/automations$/);
      } else {
        await page.getByRole('link', { name: 'Back to list' }).click();
        const discard = page.getByRole('dialog', { name: 'Discard unsaved changes?' });
        await expect(discard).toBeVisible();
        await discard.getByRole('button', { name: 'Discard', exact: true }).click();
        await expect(page).toHaveURL(/\/automations$/);
      }
      expect(writes()).toEqual([]);
    });
  });
}
