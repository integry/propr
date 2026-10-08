import { expect, test, type Locator, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { user } from './dashboard-sections.fixture';

const now = Date.parse('2026-10-07T23:23:37.000Z');

const definition = {
  id: 'def-1', ownerId: user.id, name: 'User issue summary', description: 'Hourly digest of new user-reported issues.',
  repositories: ['integry/propr'], prompt: 'Summarize issues opened by users in the last hour and flag anything urgent.',
  attachments: [], agentAlias: 'codex-main', modelName: 'gpt-5.6-sol', capabilities: ['repository_read'],
  includePreviousReports: false, previousReportsLimit: 0, scheduleCron: '0 * * * *', scheduleTimezone: 'UTC',
  scheduleEnabled: true, nextRunAt: now + 36 * 60_000, autonomyMode: 'dry_run', enabled: true, revision: 1,
  createdAt: now - 86_400_000, updatedAt: now - 86_400_000,
};

const run = {
  id: '8292730c-5d1e-4b4f-9a43-1f0e8c2b7d55', definitionId: definition.id, ownerId: user.id, trigger: 'manual',
  triggerSource: 'user:829273', idempotencyKey: null, state: 'queued', autonomyMode: 'dry_run', definitionSnapshot: null,
  reportTaskId: null, actionTaskId: null, report: null, reportTruncated: false, actionSummary: null, skipReason: null,
  failureReason: null, approvedBy: null, operatorNote: null, deferredUntil: null, deferrals: 0,
  createdAt: now, startedAt: null, reportedAt: null, finishedAt: null, updatedAt: now,
};

async function automationsFixture(page: Page) {
  await page.routeWebSocket('**/socket.io/**', socket => socket.close());
  await page.route('**/api/**', route => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (request.method() === 'POST' && pathname === `/api/agent-definitions/${definition.id}/runs`) {
      return route.fulfill({ status: 201, json: { run, created: true } });
    }
    const responses: Record<string, unknown> = {
      '/api/auth/demo-mode': { demoMode: false },
      '/api/auth/user': user,
      '/api/instance/catalog': {
        agents: [
          { alias: 'claude-main', type: 'claude', enabled: true, supportedModels: ['claude-opus-5-5'], defaultModel: 'claude-opus-5-5' },
          { alias: 'codex-main', type: 'codex', enabled: true, supportedModels: ['gpt-5.6-sol'], defaultModel: 'gpt-5.6-sol' },
        ],
        defaultAgentAlias: 'claude-main',
        repositories: [{ name: 'integry/propr', enabled: true }],
      },
      '/api/agent-definitions': { definitions: [definition], total: 1, limit: 200, offset: 0 },
      [`/api/agent-definitions/${definition.id}`]: { definition },
      [`/api/agent-definitions/${definition.id}/runs`]: { runs: [run], total: 1, limit: 1, offset: 0 },
      [`/api/agent-definitions/${definition.id}/capacity`]: { capacity: { status: 'ok', sessionPercent: 20, provider: 'codex' }, threshold: 90 },
      [`/api/agent-runs/${run.id}`]: { run },
      '/api/tasks': { tasks: [], total: 0 },
      '/api/notifications/unread-count': { unreadCount: 0 },
      '/api/notifications/preferences': { preferences: {}, quietHours: {}, badgeEnabled: false },
    };
    return route.fulfill(pathname in responses ? { json: responses[pathname] } : { status: 503, json: { error: 'Unavailable in automations fixture' } });
  });
}

async function capture(target: Page | Locator, name: string) {
  if (!process.env.PROPR_CAPTURE_PREVIEWS) return;
  const directory = path.resolve('../.propr/previews');
  await mkdir(directory, { recursive: true });
  await target.screenshot({ animations: 'disabled', path: path.join(directory, `${name}.png`) });
}

test.beforeEach(async ({ page }) => {
  await automationsFixture(page);
  await page.setViewportSize({ width: 1440, height: 900 });
});

test('the sidebar names the feature Automations, apart from Coding Agents', async ({ page }) => {
  await page.goto('/agents');
  await expect(page).toHaveURL(/\/automations$/);
  await expect(page.getByRole('link', { name: 'Automations', exact: true }).first()).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Automations' })).toBeVisible();
  await expect(page.getByRole('link', { name: /User issue summary/ })).toBeVisible();
});

test('the header creates automations, leaving the list toolbar to search', async ({ page }) => {
  await page.goto('/automations');
  const toolbar = page.locator('header.desktop-content-toolbar');
  await expect(toolbar.getByRole('button', { name: 'New Automation' })).toBeVisible();
  await expect(toolbar.getByRole('button', { name: 'New Task' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'New automation' })).toHaveCount(0);
  const search = page.getByRole('textbox', { name: 'Search automations' });
  // The placeholder fits without truncation now that the toolbar holds only the title and search.
  expect(await search.evaluate((input: HTMLInputElement) => input.scrollWidth <= input.clientWidth)).toBe(true);
  await capture(page, 'automations-header-action');

  await toolbar.getByRole('button', { name: 'New Automation' }).click();
  await expect(page).toHaveURL(/\/automations\/new$/);
  const form = page.getByTestId('agent-editor');
  const top = async (locator: Locator) => (await locator.boundingBox())!.y;
  const name = form.getByLabel('Name');
  const repositories = form.getByText('Repositories', { exact: true });
  const prompt = form.getByText('Prompt', { exact: true }).first();
  await expect(name).toBeVisible();
  await expect(repositories).toBeVisible();
  expect(await top(name)).toBeLessThan(await top(repositories));
  expect(await top(repositories)).toBeLessThan(await top(prompt));
  // A new automation is created, not saved, from the footer at the bottom of the form; Close stays at the right edge of the pane header.
  const footer = form.getByTestId('agent-editor-footer');
  const create = footer.getByRole('button', { name: 'Create automation' });
  const close = form.getByRole('button', { name: 'Close automation' });
  await expect(create).toBeVisible();
  await expect(form.getByRole('button', { name: 'Save changes' })).toHaveCount(0);
  const bottom = async (locator: Locator) => { const box = (await locator.boundingBox())!; return box.y + box.height; };
  expect(await top(create)).toBeGreaterThan(await top(prompt));
  expect(Math.abs(await bottom(footer) - await bottom(form))).toBeLessThan(2);
  const left = async (locator: Locator) => (await locator.boundingBox())!.x;
  expect(await left(close)).toBeGreaterThan(await left(form.getByRole('heading', { name: 'New automation' })));
  await capture(page, 'automations-new-form-top');
});

test('the new automation form labels the coding agent and uses a compact autonomy control', async ({ page }) => {
  await page.goto('/automations/new');
  const form = page.getByTestId('agent-editor');
  await expect(form.getByRole('combobox', { name: 'Coding agent' })).toBeVisible();
  // The default names the model it runs on, the instance default agent's default model.
  await expect(form.getByRole('combobox', { name: 'Coding agent' }).locator('option:checked')).toHaveText('Claude Opus 5.5 (Default)');
  await expect(form.getByRole('checkbox', { name: 'Feed previous run reports back into prompt context' })).toBeVisible();
  const autonomy = form.getByRole('radiogroup', { name: 'Autonomy' });
  // The radio inputs are visually hidden; pointer users click the segment label.
  await autonomy.getByText('Preview & approve', { exact: true }).click();
  await expect(autonomy.getByRole('radio', { name: 'Preview & approve' })).toBeChecked();
  await expect(form.getByTestId('agent-autonomy-description')).toContainText('waits for your approval');
  await autonomy.scrollIntoViewIfNeeded();
  await capture(page, 'automations-new-form');
});

test('the autonomy control is one Tab stop and the arrow keys move the selection', async ({ page }) => {
  await page.goto('/automations/new');
  const form = page.getByTestId('agent-editor');
  const autonomy = form.getByRole('radiogroup', { name: 'Autonomy' });
  const dryRun = autonomy.getByRole('radio', { name: 'Dry run' });
  const preview = autonomy.getByRole('radio', { name: 'Preview & approve' });
  const auto = autonomy.getByRole('radio', { name: 'Auto' });
  await expect(dryRun).toBeChecked();
  await dryRun.focus();

  await page.keyboard.press('ArrowRight');
  await expect(preview).toBeChecked();
  await expect(preview).toBeFocused();
  await expect(form.getByTestId('agent-autonomy-description')).toContainText('waits for your approval');
  await capture(form.getByTestId('agent-autonomy-description').locator('..'), 'automations-autonomy-keyboard');
  await page.keyboard.press('ArrowRight');
  await expect(auto).toBeChecked();
  await page.keyboard.press('ArrowLeft');
  await expect(preview).toBeChecked();

  // Tab leaves the group rather than stepping through the other options.
  await page.keyboard.press('Tab');
  await expect(dryRun).not.toBeFocused();
  await expect(preview).not.toBeFocused();
  await expect(auto).not.toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(preview).toBeFocused();
});

test('on a widescreen the list takes 40% and inputs span up to 672px', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto('/automations/new');
  const form = page.getByTestId('agent-editor');
  const width = async (locator: Locator) => (await locator.boundingBox())!.width;
  const list = await width(page.getByTestId('agent-split-list'));
  const details = await width(page.getByTestId('agent-split-details'));
  expect(list / (list + details)).toBeCloseTo(0.4, 1);
  const name = await width(form.getByLabel('Name'));
  expect(name).toBeGreaterThan(600);
  expect(name).toBeLessThanOrEqual(672);
  await capture(page, 'automations-widescreen');
});

test('editing a saved automation saves changes', async ({ page }) => {
  await page.goto(`/automations/${definition.id}`);
  const form = page.getByTestId('agent-editor');
  await expect(form.getByTestId('agent-editor-footer').getByRole('button', { name: 'Save changes' })).toBeVisible();
  await expect(form.getByRole('button', { name: 'Create automation' })).toHaveCount(0);
});

test('Run now confirms with a toast and opens the run under a breadcrumb', async ({ page }) => {
  await page.goto(`/automations/${definition.id}`);
  await page.getByRole('button', { name: 'Run now' }).click();
  await expect(page).toHaveURL(new RegExp(`/automations/${definition.id}/runs/${run.id}$`));

  const breadcrumb = page.getByRole('navigation', { name: 'Breadcrumb' });
  await expect(breadcrumb).toContainText('User issue summary');
  await expect(breadcrumb.getByRole('link', { name: 'Runs' })).toBeVisible();
  await expect(breadcrumb).toContainText('Run 8292730c');
  await expect(page.getByRole('navigation', { name: 'Automation sections' })).toHaveCount(0);
  await expect(page.getByText('Run started')).toBeVisible();
  await expect(page.getByTestId('agent-run-state')).toHaveText('Queued');
  await capture(page, 'automations-run-breadcrumb');
});
