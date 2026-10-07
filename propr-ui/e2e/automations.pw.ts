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
        agents: [{ alias: 'codex-main', type: 'codex', enabled: true, supportedModels: ['gpt-5.6-sol'], defaultModel: 'gpt-5.6-sol' }],
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

test('the new automation form labels the coding agent and uses a compact autonomy control', async ({ page }) => {
  await page.goto('/automations/new');
  const form = page.getByTestId('agent-editor');
  await expect(form.getByRole('combobox', { name: 'Coding agent' })).toBeVisible();
  await expect(form.getByRole('option', { name: 'Default coding agent' })).toBeAttached();
  const autonomy = form.getByRole('radiogroup', { name: 'Autonomy' });
  await autonomy.getByRole('radio', { name: 'Preview & approve' }).click();
  await expect(form.getByTestId('agent-autonomy-description')).toContainText('waits for your approval');
  await autonomy.scrollIntoViewIfNeeded();
  await capture(page, 'automations-new-form');
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
