/**
 * The automation editor's Schedule row at desktop (1440) and phone (390) widths: Repeat builds the cron from plain
 * controls that fit on one or two rows without horizontal scroll, each with a label and reachable by keyboard, and
 * Custom (cron) shows the expression they wrote.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { user } from './dashboard-sections.fixture';

async function formFixture(page: Page) {
  await page.routeWebSocket('**/socket.io/**', socket => socket.close());
  await page.route('**/api/**', route => {
    const pathname = new URL(route.request().url()).pathname;
    const responses: Record<string, unknown> = {
      '/api/auth/demo-mode': { demoMode: false },
      '/api/auth/user': user,
      '/api/instance/catalog': {
        agents: [{ alias: 'claude-main', type: 'claude', enabled: true, supportedModels: ['claude-opus-5-5'], defaultModel: 'claude-opus-5-5' }],
        defaultAgentAlias: 'claude-main',
        repositories: [{ name: 'integry/propr', enabled: true }],
      },
      '/api/config/settings': { automation_unproductive_run_threshold: 4 },
      '/api/automation-definitions': { definitions: [], total: 0, limit: 200, offset: 0 },
      '/api/tasks': { tasks: [], total: 0 },
      '/api/notifications/unread-count': { unreadCount: 0 },
      '/api/notifications/preferences': { preferences: {}, quietHours: {}, badgeEnabled: false },
    };
    return route.fulfill(pathname in responses ? { json: responses[pathname] } : { status: 503, json: { error: 'Unavailable in schedule fixture' } });
  });
}

async function capture(target: Page | Locator, name: string) {
  if (!process.env.PROPR_CAPTURE_PREVIEWS) return;
  const directory = path.resolve('../.propr/previews');
  await mkdir(directory, { recursive: true });
  await target.screenshot({ animations: 'disabled', path: path.join(directory, `${name}.png`) });
}

/** Distinct top edges of the visible controls: one per row they wrap onto. */
const rowsOf = (controls: Locator) => controls.evaluateAll(nodes => new Set(nodes
  .map(node => (node.closest('label') ?? node).getBoundingClientRect())
  .filter(box => box.width > 0)
  .map(box => Math.round(box.top / 8))).size);

const noHorizontalScroll = (page: Page) => page.evaluate(() => [...document.querySelectorAll('*')]
  .filter(node => node.scrollWidth > node.clientWidth + 1 && ['auto', 'scroll'].includes(getComputedStyle(node).overflowX))
  .length === 0 && document.documentElement.scrollWidth <= window.innerWidth);

for (const [label, viewport] of [['desktop', { width: 1440, height: 900 }], ['phone', { width: 390, height: 844 }]] as const) {
  test(`schedule Repeat controls fit and are labelled at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await formFixture(page);
    await page.goto('/automations/new');
    const form = page.getByTestId('agent-editor');
    const modes = form.getByRole('radiogroup', { name: 'Schedule' });
    await expect(modes.getByRole('radio')).toHaveText(['Off', 'Repeat', 'Custom (cron)']);

    await modes.getByRole('radio', { name: 'Repeat' }).click();
    const every = form.getByLabel('Every', { exact: true });
    await expect(every).toHaveValue('days');
    await expect(form.getByLabel('Hour (UTC)')).toHaveValue('9');
    await expect(form.getByLabel('Minute')).toHaveValue('0');
    await expect(form.getByTestId('agent-schedule-feedback')).toContainText('Next run:');

    // Every 3 hours, chosen with the keyboard.
    await every.focus();
    await every.selectOption('hours');
    await page.keyboard.press('Shift+Tab');
    await expect(form.getByLabel('Every', { exact: true })).toBeFocused();
    await form.getByLabel('Every', { exact: true }).selectOption('3');
    await page.keyboard.press('Tab');
    await expect(form.getByLabel('Unit')).toBeFocused();
    await capture(form.getByTestId('agent-schedule-feedback').locator('xpath=ancestor::div[contains(@class,"grid")][1]'), `automation-schedule-every-3-hours-${label}`);

    // Weekly on chosen days: every control has a name, and the days are reached with Tab.
    await form.getByLabel('Unit').selectOption('weeks');
    const controls = form.locator('#agent-schedule, #agent-schedule-every, #agent-schedule-time, select[aria-label="Minute"], input[type="checkbox"][aria-label$="day"]');
    for (const control of await controls.all()) expect(await control.evaluate(node => (node as HTMLInputElement).labels?.length || node.getAttribute('aria-label'))).toBeTruthy();
    await form.getByLabel('Hour (UTC)').selectOption('7');
    await form.getByLabel('Minute').selectOption('30');
    await form.getByRole('checkbox', { name: 'Monday' }).focus();
    await page.keyboard.press('Tab');
    await expect(form.getByRole('checkbox', { name: 'Tuesday' })).toBeFocused();
    await page.keyboard.press('Space');
    await form.locator('label').filter({ hasText: /^Thu$/ }).click();
    await expect(form.getByRole('checkbox', { name: 'Thursday' })).toBeChecked();
    expect(await rowsOf(controls)).toBeLessThanOrEqual(2);
    expect(await noHorizontalScroll(page)).toBe(true);
    await capture(form.getByTestId('agent-schedule-feedback').locator('xpath=ancestor::div[contains(@class,"grid")][1]'), `automation-schedule-weekly-${label}`);

    await modes.getByRole('radio', { name: 'Custom (cron)' }).click();
    await expect(form.getByLabel('Cron expression')).toHaveValue('30 7 * * 1,2,4');
    expect(await noHorizontalScroll(page)).toBe(true);
    await capture(form.getByTestId('agent-schedule-feedback').locator('xpath=ancestor::div[contains(@class,"grid")][1]'), `automation-schedule-custom-${label}`);
  });
}
