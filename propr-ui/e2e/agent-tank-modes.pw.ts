import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

/**
 * The three-state Agent Tank integration setting: a radio group where the
 * Daemon URL field only exists in external mode. With PROPR_CAPTURE_PREVIEWS
 * set it also captures the section in each state.
 */

const agents = [
  {
    id: 'claude', type: 'claude', alias: 'claude', enabled: true, dockerImage: 'propr/agent:latest', configPath: '~/.claude',
    supportedModels: ['claude-opus-5-5'], defaultModel: 'claude-opus-5-5',
  },
];

async function installFixture(
  page: Page,
  agentTank: Record<string, unknown>,
): Promise<Array<Record<string, unknown>>> {
  const saved: Array<Record<string, unknown>> = [];
  let tank = { ...agentTank };
  await page.routeWebSocket('**/socket.io/**', socket => socket.close());
  await page.route('**/api/**', async route => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (pathname === '/api/config/agent-tank' && request.method() === 'POST') {
      const body = request.postDataJSON() as Record<string, unknown>;
      saved.push(body);
      tank = { ...tank, ...body, enabled: body.mode !== 'disabled' };
      return route.fulfill({ json: { success: true } });
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
      },
      '/api/config/followup-keywords': { followup_keywords: [] },
      '/api/config/followup-ignore-keywords': { followup_ignore_keywords: [] },
      '/api/config/pr-label': { pr_label: 'propr' },
      '/api/config/primary-processing-labels': { primary_processing_labels: ['AI'] },
      '/api/config/agents': { agents },
      '/api/config/summarization': { enabled: false, agent_alias: '', fallback_agent_alias: '' },
      '/api/config/agent-tank': tank,
      '/api/config/agent-tank/status': { available: true, mode: tank.mode },
      '/api/config/agent-tank/detect': { detected: false },
      '/api/instance/catalog': {
        agents: agents.map(agent => ({ id: agent.id, kind: 'direct', alias: agent.alias, enabled: true, supportedModels: agent.supportedModels })),
        repositories: [],
      },
      '/api/notifications/config': { push: { configured: false, vapidPublicKey: null } },
      '/api/notifications/unread-count': { unreadCount: 0 },
    };
    if (pathname in responses) return route.fulfill({ json: responses[pathname] });
    return route.fulfill({ status: 503, json: { error: 'Unavailable in Agent Tank mode fixture' } });
  });
  return saved;
}

async function capture(page: Page, name: string): Promise<void> {
  if (!process.env.PROPR_CAPTURE_PREVIEWS) return;
  const directory = path.resolve('../.propr/previews');
  await mkdir(directory, { recursive: true });
  const section = page.getByRole('region', { name: 'LLM Usage Tracking' });
  await section.scrollIntoViewIfNeeded();
  const box = await section.boundingBox();
  if (!box) throw new Error('LLM Usage Tracking section is not visible');
  await page.screenshot({
    animations: 'disabled',
    path: path.join(directory, `${name}.png`),
    clip: {
      x: Math.max(0, box.x - 24),
      y: Math.max(0, box.y - 24),
      width: box.width + 48,
      height: box.height + 48,
    },
  });
}

test('offers three modes and shows the daemon URL only for external', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  const saved = await installFixture(page, { mode: 'disabled', enabled: false, url: 'http://host.docker.internal:3456' });
  await page.goto('/settings?tab=integrations');

  await expect(page.getByRole('radio', { name: /Disabled/ })).toBeChecked();
  await expect(page.getByLabel('Daemon URL')).toHaveCount(0);
  await capture(page, 'agent-tank-disabled');

  await page.getByRole('radio', { name: /Bundled/ }).check();
  await expect.poll(() => saved.at(-1)?.mode).toBe('bundled');
  await expect(page.getByLabel('Daemon URL')).toHaveCount(0);
  const section = page.getByRole('region', { name: 'LLM Usage Tracking' });
  await expect(section.getByRole('status')).toContainText('Bundled Agent Tank ready');
  await capture(page, 'agent-tank-bundled');

  await page.getByRole('radio', { name: /External/ }).check();
  await expect.poll(() => saved.at(-1)?.mode).toBe('external');
  await expect(page.getByLabel('Daemon URL')).toHaveValue('http://host.docker.internal:3456');
  await capture(page, 'agent-tank-external');
});

test('loads a legacy enabled installation as external with its saved URL', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  // An older backend answers without `mode`; the UI must still select external.
  await installFixture(page, { enabled: true, url: 'http://host.docker.internal:3456' });
  await page.goto('/settings?tab=integrations');

  await expect(page.getByRole('radio', { name: /External/ })).toBeChecked();
  await expect(page.getByLabel('Daemon URL')).toHaveValue('http://host.docker.internal:3456');
});
