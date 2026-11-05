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
  /** What the backend answers about whether the selected mode actually works. */
  status: Record<string, unknown> = { available: true },
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
      '/api/config/agent-tank/status': { mode: tank.mode, ...status },
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

/** Whole-viewport variant, for states whose evidence includes the save bar. */
async function captureViewport(page: Page, name: string): Promise<void> {
  if (!process.env.PROPR_CAPTURE_PREVIEWS) return;
  const directory = path.resolve('../.propr/previews');
  await mkdir(directory, { recursive: true });
  await page.screenshot({ animations: 'disabled', path: path.join(directory, `${name}.png`) });
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

test('a write to a legacy backend carries the enabled flag that backend reads', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  const saved = await installFixture(page, { enabled: true, url: 'http://host.docker.internal:3456' });
  await page.goto('/settings?tab=integrations');
  await expect(page.getByRole('radio', { name: /External/ })).toBeChecked();

  await page.getByLabel('Daemon URL').fill('http://127.0.0.1:3456');

  // The pre-mode handler stores `enabled: !!enabled`, so a body carrying only
  // `mode` would turn tracking off while the server still answers success.
  await expect.poll(() => saved.at(-1)).toMatchObject({
    mode: 'external', enabled: true, url: 'http://127.0.0.1:3456',
  });
});

test('bundled mode is refused on a legacy backend instead of reported as applied', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  const saved = await installFixture(page, { enabled: true, url: 'http://host.docker.internal:3456' });
  await page.goto('/settings?tab=integrations');
  await expect(page.getByRole('radio', { name: /External/ })).toBeChecked();

  // Rejection can restore External before check() verifies the clicked radio.
  // Click to attempt the change, then assert the rejected state below.
  await page.getByRole('radio', { name: /Bundled/ }).click();

  await expect(page.getByRole('status').filter({ hasText: 'too old' })).toBeVisible();
  // Nothing was written, and the radio shows the mode that is really stored.
  expect(saved).toEqual([]);
  await expect(page.getByRole('radio', { name: /External/ })).toBeChecked();
  await expect(page.getByRole('radio', { name: /Bundled/ })).not.toBeChecked();
  await captureViewport(page, 'agent-tank-legacy-backend');
});

test('bundled mode with nothing to monitor is not announced as ready', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  // The bundled run succeeded and described no provider - only unsupported
  // agents are enabled - so the backend reports it as unavailable with a reason.
  await installFixture(
    page,
    { mode: 'bundled', enabled: true, url: 'http://host.docker.internal:3456' },
    { available: false, reason: 'no_supported_agents' },
  );
  await page.goto('/settings?tab=integrations');

  const status = page.getByRole('region', { name: 'LLM Usage Tracking' }).getByRole('status');
  await expect(status).toContainText('Bundled Agent Tank unavailable');
  await expect(status).not.toContainText('ready');
  await capture(page, 'agent-tank-bundled-nothing-to-monitor');
});

test('bundled mode whose every provider failed is not announced as ready', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  // The bundled run produced a snapshot, but every provider in it carries an
  // error and no usage, so the backend answers unavailable with its own reason.
  // A provider key is not a usage number: this must not read "ready".
  await installFixture(
    page,
    { mode: 'bundled', enabled: true, url: 'http://host.docker.internal:3456' },
    { available: false, reason: 'no_usage_data' },
  );
  await page.goto('/settings?tab=integrations');

  const status = page.getByRole('region', { name: 'LLM Usage Tracking' }).getByRole('status');
  await expect(status).toContainText('Bundled Agent Tank unavailable');
  await expect(status).not.toContainText('ready');
  await capture(page, 'agent-tank-bundled-all-providers-failed');
});

test('bundled availability is reported only once bundled is the stored mode', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  await installFixture(page, { mode: 'disabled', enabled: false, url: '' });

  // The bundled write asks the backend whether it understands modes before
  // POSTing. Holding that GET open keeps "disabled" stored: a status request
  // answered in this window describes disabled mode, not the bundled selection.
  let storedMode = 'disabled';
  let holdCompatibilityGet = false;
  let releaseCompatibilityGet = () => {};
  const compatibilityGet = new Promise<void>(resolve => { releaseCompatibilityGet = resolve; });
  const backendCalls: string[] = [];
  await page.route('**/api/config/agent-tank**', async route => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (pathname === '/api/config/agent-tank/status') {
      backendCalls.push(`status:${storedMode}`);
      return route.fulfill({ json: { mode: storedMode, available: storedMode === 'bundled' } });
    }
    if (pathname !== '/api/config/agent-tank') return route.fallback();
    if (request.method() === 'POST') {
      storedMode = (request.postDataJSON() as { mode: string }).mode;
      backendCalls.push(`save:${storedMode}`);
      return route.fulfill({ json: { success: true } });
    }
    if (holdCompatibilityGet) await compatibilityGet;
    return route.fulfill({ json: { mode: storedMode, enabled: storedMode !== 'disabled', url: '' } });
  });
  await page.goto('/settings?tab=integrations');
  const section = page.getByRole('region', { name: 'LLM Usage Tracking' });
  await expect(page.getByRole('radio', { name: /Disabled/ })).toBeChecked();

  holdCompatibilityGet = true;
  await page.getByRole('radio', { name: /Bundled/ }).check();
  // Well past the probe delay, and still nothing has been asked: a verdict here
  // would read "Bundled Agent Tank unavailable" about a mode never stored.
  await page.waitForTimeout(1200);
  expect(backendCalls).toEqual([]);
  await expect(section.getByRole('status')).toContainText('Checking connection');
  await capture(page, 'agent-tank-bundled-awaiting-save');

  releaseCompatibilityGet();

  await expect(section.getByRole('status')).toContainText('Bundled Agent Tank ready');
  expect(backendCalls).toEqual(['save:bundled', 'status:bundled']);
  await capture(page, 'agent-tank-bundled-ready-after-save');
});

for (const mode of ['disabled', 'bundled'] as const) {
  test(`restores the saved URL after leaving a blank draft through ${mode}`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 1000 });
    const url = 'http://host.docker.internal:3456';
    const saved = await installFixture(page, { mode: 'external', enabled: true, url });
    await page.goto('/settings?tab=integrations');
    await expect(page.getByLabel('Daemon URL')).toHaveValue(url);

    await page.getByLabel('Daemon URL').fill('');
    await page.getByRole('radio', { name: mode === 'disabled' ? /Disabled/ : /Bundled/ }).check();
    await expect.poll(() => saved.at(-1)).toMatchObject({ mode, url });
    await page.getByRole('radio', { name: /External/ }).check();

    await expect.poll(() => saved.at(-1)).toMatchObject({ mode: 'external', enabled: true, url });
    await expect(page.getByLabel('Daemon URL')).toHaveValue(url);
    await expect(page.getByRole('region', { name: 'LLM Usage Tracking' }).getByRole('status'))
      .toContainText('Agent Tank connected');
    await capture(page, `agent-tank-url-restored-after-${mode}`);
  });
}
