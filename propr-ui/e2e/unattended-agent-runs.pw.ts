import { expect, test, type Locator, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

/**
 * The unattended agent run limits in Settings (usage pause, concurrency cap,
 * local-time window, and the malformed-window warning) and the notice the
 * agent editor shows when scheduled runs would wait. With
 * PROPR_CAPTURE_PREVIEWS set it also captures each state.
 */

const agents = [
  {
    id: 'claude', type: 'claude', alias: 'claude', enabled: true, dockerImage: 'propr/agent:latest', configPath: '~/.claude',
    supportedModels: ['claude-opus-5-5'], defaultModel: 'claude-opus-5-5',
  },
];

const NOW = Date.UTC(2026, 9, 7, 12, 0);

const definition = {
  id: 'def-nightly', ownerId: 'preview-user', name: 'Nightly dependency review', description: 'Checks outdated dependencies.',
  repositories: [], prompt: 'Review dependency updates and summarize what needs attention.', attachments: [],
  agentAlias: 'claude', modelName: 'claude-opus-5-5', capabilities: ['repository_read'], includePreviousReports: false,
  previousReportsLimit: 3, scheduleCron: '0 1 * * *', scheduleTimezone: 'UTC', scheduleEnabled: true, nextRunAt: NOW + 13 * 3_600_000,
  autonomyMode: 'dry_run', enabled: true, revision: 1, createdAt: NOW, updatedAt: NOW,
};

interface Fixture {
  saved: Array<Record<string, unknown>>;
}

async function installFixture(page: Page, unattended: Record<string, unknown>): Promise<Fixture> {
  const fixture: Fixture = { saved: [] };
  await page.clock.setFixedTime(NOW);
  await page.routeWebSocket('**/socket.io/**', socket => socket.close());
  await page.route('**/api/**', async route => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (pathname === '/api/config/settings' && request.method() === 'POST') {
      const body = request.postDataJSON() as { settings: Record<string, unknown> };
      fixture.saved.push(body.settings);
      return route.fulfill({ json: { success: true, settings: body.settings } });
    }
    const responses: Record<string, unknown> = {
      '/api/auth/demo-mode': { demoMode: false },
      '/api/auth/user': {
        id: 'preview-user', login: 'preview', username: 'preview', displayName: 'Preview User',
        email: null, avatarUrl: null, role: 'admin', permissions: ['instance.manage_settings', 'instance.manage_agents'],
        authorizationSource: 'local',
      },
      '/api/config/settings': {
        worker_concurrency: 2, auto_followup_score_threshold: 4, auto_resolve_merge_conflicts: false,
        ultrafix_rating_goal: 7, ultrafix_max_cycles: 5, ultrafix_pause_seconds: 60,
        default_agent_alias: 'claude', model_reasoning_level: '', planner_context_model: '',
        planner_generation_model: '', pr_review_model: 'claude:claude-opus-5-5', analysis_model_fast: '',
        pr_review_context_enabled: true, pr_review_context_model: '', github_user_whitelist: [],
        agent_run_usage_pause_percent: 90, unattended_max_concurrent: 1, ...unattended,
      },
      '/api/config/followup-keywords': { followup_keywords: [] },
      '/api/config/followup-ignore-keywords': { followup_ignore_keywords: [] },
      '/api/config/pr-label': { pr_label: 'propr' },
      '/api/config/primary-processing-labels': { primary_processing_labels: ['AI'] },
      '/api/config/agents': { agents },
      '/api/config/summarization': { enabled: false, agent_alias: '', fallback_agent_alias: '' },
      '/api/config/agent-tank': { mode: 'disabled', enabled: false, url: '' },
      '/api/config/agent-tank/status': { mode: 'disabled', available: false },
      '/api/instance/catalog': {
        agents: agents.map(agent => ({ id: agent.id, kind: 'direct', type: agent.type, alias: agent.alias, enabled: true, supportedModels: agent.supportedModels })),
        repositories: [],
      },
      '/api/notifications/config': { push: { configured: false, vapidPublicKey: null } },
      '/api/notifications/unread-count': { unreadCount: 0 },
      '/api/agent-definitions': { definitions: [definition], total: 1, limit: 50, offset: 0 },
      [`/api/agent-definitions/${definition.id}`]: { definition },
      [`/api/agent-definitions/${definition.id}/runs`]: { runs: [], total: 0, limit: 50, offset: 0 },
      [`/api/agent-definitions/${definition.id}/capacity`]: {
        threshold: 90,
        capacity: { status: 'unknown', provider: 'claude' },
        unattended: {
          concurrency: { active: 0, cap: 1, reached: false },
          window: {
            configured: true, value: '02:00-07:00@Europe/Riga', description: '02:00-07:00 Europe/Riga', timeZone: 'Europe/Riga',
            open: false, opensAt: Date.UTC(2026, 9, 7, 23, 0), opensAtLocal: '02:00',
          },
        },
      },
    };
    if (pathname in responses) return route.fulfill({ json: responses[pathname] });
    return route.fulfill({ status: 503, json: { error: 'Unavailable in the unattended limits fixture' } });
  });
  return fixture;
}

async function capture(page: Page, target: Locator, name: string): Promise<void> {
  if (!process.env.PROPR_CAPTURE_PREVIEWS) return;
  const directory = path.resolve('../.propr/previews');
  await mkdir(directory, { recursive: true });
  await target.scrollIntoViewIfNeeded();
  const box = await target.boundingBox();
  if (!box) throw new Error(`${name} target is not visible`);
  await page.screenshot({
    animations: 'disabled',
    path: path.join(directory, `${name}.png`),
    clip: { x: Math.max(0, box.x - 24), y: Math.max(0, box.y - 24), width: box.width + 48, height: box.height + 48 },
  });
}

test('saves a valid unattended window on its own and shows whether it is open', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  const fixture = await installFixture(page, { unattended_window: null });
  await page.goto('/settings?tab=automation');

  const section = page.getByRole('region', { name: 'Unattended agent runs' });
  await expect(section.getByLabel('Pause at % of subscription usage')).toHaveValue('90');
  await expect(section.getByLabel('Concurrent unattended runs')).toHaveValue('1');

  const window = section.getByLabel('Unattended window (local time)');
  await window.fill('02:00-07:00@Europe/Riga');
  await window.blur();
  await expect.poll(() => fixture.saved.at(-1)).toEqual({ unattended_window: '02:00-07:00@Europe/Riga' });
  await expect(section.getByTestId('unattended-window-state'))
    .toHaveText('Outside the window (02:00-07:00 Europe/Riga) until 02:00 Europe/Riga: unattended runs wait.');
  await capture(page, section, 'unattended-agent-runs-settings');
});

test('warns that a malformed stored window blocks unattended runs', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  await installFixture(page, { unattended_window: '02:00-07:00@Europe/Atlantis', unattended_window_error: 'unknown time zone "Europe/Atlantis"' });
  await page.goto('/settings?tab=automation');

  const section = page.getByRole('region', { name: 'Unattended agent runs' });
  await expect(section.getByTestId('unattended-window-warning')).toContainText('Unattended agent runs are blocked and skipped until you fix or clear it.');
  await expect(section.getByText('Blocked: window is malformed')).toBeVisible();
  await capture(page, section, 'unattended-agent-runs-malformed-window');
});

test('the agent editor says when scheduled runs wait for the unattended window', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await installFixture(page, { unattended_window: '02:00-07:00@Europe/Riga' });
  await page.goto(`/agents/${definition.id}`);

  const notice = page.getByTestId('agent-unattended-notice');
  await expect(notice).toHaveText('Unattended runs wait: outside the unattended window until 02:00 Europe/Riga.');
  await capture(page, page.getByTestId('agent-schedule-feedback').locator('..'), 'agent-editor-unattended-notice');
});
