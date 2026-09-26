import { expect, test, type Locator, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

/**
 * The Settings redesign: one contained column, Utility Headers over 1px
 * dividers, single-column form groups, and quiet status indicators. These
 * checks guard the structure; with PROPR_CAPTURE_PREVIEWS set they also capture
 * one screenshot per tab.
 */

const notificationPreferences = Object.fromEntries([
  'plan', 'task', 'review', 'pull_request', 'indexing', 'system_failure',
].map(kind => [kind, { inboxEnabled: true, pushEnabled: kind === 'system_failure', updatedAt: null }]));

const catalogAgents = [
  { id: 'claude', kind: 'direct' as const, alias: 'claude', enabled: true, supportedModels: ['claude-opus-5', 'claude-sonnet-5'] },
  { id: 'codex', kind: 'direct' as const, alias: 'codex', enabled: true, supportedModels: ['gpt-5-codex'] },
];

async function installSettingsFixture(page: Page): Promise<void> {
  await page.routeWebSocket('**/socket.io/**', socket => socket.close());
  await page.route('**/api/**', async route => {
    const pathname = new URL(route.request().url()).pathname;
    const responses: Record<string, unknown> = {
      '/api/auth/demo-mode': { demoMode: false },
      '/api/auth/user': {
        id: 'preview-user', login: 'preview', username: 'preview', displayName: 'Preview User',
        email: null, avatarUrl: null, role: 'admin', permissions: ['instance.manage_settings'],
        authorizationSource: 'local',
      },
      '/api/config/settings': {
        worker_concurrency: 2,
        auto_followup_score_threshold: 4,
        auto_resolve_merge_conflicts: true,
        ultrafix_rating_goal: 7,
        ultrafix_max_cycles: 5,
        ultrafix_pause_seconds: 60,
        default_agent_alias: 'claude',
        model_reasoning_level: 'high',
        planner_context_model: 'claude:claude-sonnet-5',
        planner_generation_model: 'claude:claude-opus-5',
        pr_review_model: 'claude:claude-opus-5',
        analysis_model_fast: 'codex:gpt-5-codex',
        pr_review_context_enabled: true,
        pr_review_context_model: '',
        pr_review_max_context_tokens: 0,
        pr_review_context_budget_percent: 100,
        github_user_whitelist: ['octocat', 'hubot'],
      },
      '/api/config/followup-keywords': { followup_keywords: ['PROPR', 'FIXIT'] },
      '/api/config/followup-ignore-keywords': { followup_ignore_keywords: ['Deployment In Progress'] },
      '/api/config/pr-label': { pr_label: 'propr' },
      '/api/config/primary-processing-labels': { primary_processing_labels: ['AI'] },
      '/api/config/agents': { agents: [] },
      '/api/config/summarization': { enabled: true, agent_alias: 'claude:claude-sonnet-5', fallback_agent_alias: '' },
      '/api/config/agent-tank': { enabled: true, url: 'http://0.0.0.0:3456' },
      '/api/config/agent-tank/status': { available: true },
      '/api/config/visual-preview-auth': {
        status: 'active', source: 'github_login', configured: true, githubUsername: 'preview-bot',
      },
      '/api/config/preview-storage': { version: 1, state: 'enabled', enabled: true, effective: null },
      '/api/agent-runtime/packages': {
        installationId: 'preview', packages: ['ripgrep'], activePackages: ['ripgrep'],
        status: 'ready', images: { claude: 'sha256:preview' }, updatedAt: '',
      },
      '/api/admin/mcp': {
        status: { enabled: false, resource: null, origin: null },
        settings: { enabled: false, scopeCeiling: ['read'] },
      },
      '/api/instance/catalog': { agents: catalogAgents, repositories: [] },
      '/api/notifications/config': { push: { configured: false, vapidPublicKey: null } },
      '/api/notifications/unread-count': { unreadCount: 0 },
      '/api/notifications/preferences': {
        preferences: notificationPreferences,
        quietHours: { start: '22:00', end: '07:00', timezone: 'UTC' },
        badgeEnabled: true,
      },
    };
    if (pathname in responses) return route.fulfill({ json: responses[pathname] });
    return route.fulfill({ status: 503, json: { error: 'Unavailable in settings layout fixture' } });
  });
}

async function capture(page: Page, name: string, scrollTo?: Locator): Promise<void> {
  if (!process.env.PROPR_CAPTURE_PREVIEWS) return;
  const directory = path.resolve('../.propr/previews');
  await mkdir(directory, { recursive: true });
  if (scrollTo) await scrollTo.scrollIntoViewIfNeeded();
  await page.screenshot({ animations: 'disabled', path: path.join(directory, `${name}.png`) });
}

test('lays settings out as one contained, single-column form', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await installSettingsFixture(page);
  await page.goto('/settings?tab=models');

  // No arbitrary counts beside the tabs.
  for (const label of ['AI & Models', 'Automation', 'Integrations', 'Notifications']) {
    await expect(page.getByRole('tab', { name: label, exact: true })).toBeVisible();
  }

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

  await page.getByRole('tab', { name: 'Automation' }).click();
  await capture(page, 'settings-automation');

  // The "Add" action is a real button, and the chips wrap in a plain flex row
  // rather than sitting inside a padded grey box.
  const whitelist = page.getByRole('region', { name: 'GitHub User Whitelist' });
  await expect(whitelist.getByRole('button', { name: 'Add' })).toBeVisible();
  const chipRemove = whitelist.getByRole('button', { name: 'Remove octocat' });
  await expect(chipRemove).toBeVisible();
  await expect(chipRemove.locator('xpath=../..')).toHaveClass(/flex-wrap/);
  await capture(page, 'settings-automation-lists', whitelist);

  await page.getByRole('tab', { name: 'Integrations' }).click();
  await expect(page.getByRole('heading', { name: 'LLM Usage Tracking' })).toBeVisible();
  await expect(page.getByText('Agent Tank connected')).toBeVisible();
  await capture(page, 'settings-integrations');

  // Card Hell stays banned: these blocks are separated by rules, not boxes.
  for (const name of ['Managed preview storage', 'Voice briefings · Experimental']) {
    const region = page.getByRole('region', { name });
    await expect(region).toHaveCSS('border-top-width', '0px');
    await expect(region).toHaveCSS('border-radius', '0px');
  }
  await capture(page, 'settings-integrations-storage', page.getByRole('region', { name: 'Voice briefings · Experimental' }));

  await page.getByRole('tab', { name: 'Notifications' }).click();
  const inbox = page.getByLabel('Inbox notifications for Plans');
  await expect(inbox).toBeVisible();
  // The checkbox sits centred under its own column header.
  const header = page.getByRole('region', { name: 'Personal notifications' }).getByText('Inbox', { exact: true });
  const [checkboxBox, headerBox] = await Promise.all([inbox.boundingBox(), header.boundingBox()]);
  const centre = (box: { x: number; width: number } | null): number => (box!.x + box!.width / 2);
  expect(Math.abs(centre(checkboxBox) - centre(headerBox))).toBeLessThanOrEqual(2);
  await capture(page, 'settings-notifications');
});

test('keeps the contained settings column usable on a phone', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 780 });
  await installSettingsFixture(page);
  await page.goto('/settings?tab=models');

  const select = page.getByLabel('Plan Generation Model');
  await expect(select).toBeVisible();
  const overflow = await page.evaluate(() => {
    const element = document.scrollingElement!;
    return element.scrollWidth - element.clientWidth;
  });
  expect(overflow).toBeLessThanOrEqual(1);
  await capture(page, 'settings-mobile');
});
