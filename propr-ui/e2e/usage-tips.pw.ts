import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { resolveUsageTips, rotateUsageTipCandidates, USAGE_TIPS_BY_ID, type UsageTipCandidate } from '@propr/shared';
import { heuristicUsageTipCandidates } from '../../packages/core/src/services/usageTips/selection';

async function fixture(page: Page, discovery = false, savedCandidates?: UsageTipCandidate[]) {
  const dismissed = new Map<string, number>();
  const events: string[] = [];
  const pool = ['pr-ultrafix', 'planner-studio', 'indexing-options', 'repository-todos',
    ...(discovery ? ['mcp-chat-control', 'visual-previews'] : [])];
  const candidates = heuristicUsageTipCandidates({ tasks: 12, manualCycles: 4, ultrafix: 0,
    oneOffTasks: 8, plans: 0, indexingFailures: 2, todos: 0,
    ...(discovery ? { mcpUsage: 0, visualPreviewRepos: 0 } : {}) });
  const savedPool = savedCandidates ?? pool.map(id => candidates.find(c => c.id === id)!);
  let reads = 0;
  const settings = { usage_tips_enabled: true };
  await page.routeWebSocket('**/socket.io/**', socket => socket.close());
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url()).pathname;
    if (url === '/api/usage-tips') {
      reads++;
      return route.fulfill({ json: { enabled: settings.usage_tips_enabled,
        tips: settings.usage_tips_enabled ? resolveUsageTips(savedPool,
          [...dismissed].map(([tip_id, dismissed_at]) => ({ tip_id, dismissed_at, dismissal_count: 1 })),
          Date.now()) : [] } });
    }
    if (url === '/api/usage-tips/dismiss') {
      const body = route.request().postDataJSON(); events.push(body.eventId); dismissed.set(body.tipId, Date.now());
      return route.fulfill({ json: { success: true } });
    }
    if (url === '/api/config/settings' && route.request().method() === 'POST') {
      Object.assign(settings, route.request().postDataJSON().settings);
      return route.fulfill({ json: { success: true, settings } });
    }
    const responses: Record<string, unknown> = {
      '/api/auth/demo-mode': { demoMode: false },
      '/api/auth/user': { id: 'fixture-operator', login: 'operator', username: 'operator', displayName: 'Operator', email: null, avatarUrl: null,
        role: 'admin', permissions: ['instance.manage_settings'], authorizationSource: 'local' },
      '/api/config/settings': settings,
      '/api/config/followup-keywords': { followup_keywords: [] },
      '/api/config/followup-ignore-keywords': { followup_ignore_keywords: [] },
      '/api/config/pr-label': { pr_label: 'propr' },
      '/api/config/primary-processing-labels': { primary_processing_labels: ['AI'] },
      '/api/config/agents': { agents: [{ id: 'agent', alias: 'coding', name: 'Coding agent', type: 'codex', supportedModels: ['gpt-6-astra'], enabled: true, defaultModel: 'gpt-6-astra' }] },
      '/api/config/summarization': { enabled: true, agent_alias: 'coding', fallback_agent_alias: '' },
      '/api/config/agent-tank': { enabled: true, url: 'http://localhost:3456' },
      '/api/config/agent-tank/usage': { enabled: true, agents: {} },
      '/api/instance/catalog': { agents: [{ id: 'agent', alias: 'coding', type: 'codex', enabled: true, supportedModels: ['gpt-6-astra'], name: 'Coding agent', defaultModel: 'gpt-6-astra' }], repositories: [{ name: 'example/workspace', enabled: true, baseBranch: 'main' }] },
      '/api/notifications/unread-count': { unreadCount: 0 },
      '/api/notifications/config': { push: { configured: false, vapidPublicKey: null } },
      '/api/notifications/preferences': { preferences: {}, quietHours: { start: null, end: null, timezone: 'UTC' }, badgeEnabled: false },
      '/api/tasks': { tasks: [], total: 0 },
      '/api/queue/stats': { active: 0, waiting: 0, completed: 34, failed: 0 },
      '/api/status': { status: 'ok' },
      '/api/stats/generating-plans': { count: 0 },
      '/api/dashboard/narrative': { repository: 'all', enabled: false, summary: '' },
      '/api/dashboard/summary': { repository: 'all', needsAttention: 0, running: 0, queued: 0, completedRecently: 4, recentWindowHours: 24 },
      '/api/dashboard/attention': { repository: 'all', items: [], counts: { blocked: 0, decisions: 0, total: 0 } },
      '/api/dashboard/active': { repository: 'all', running: [], queued: [], queue: { queuedCount: 0, reason: null }, counts: { running: 0, queued: 0 } },
      '/api/dashboard/outcomes': { repository: 'all', limit: 50, items: [] },
      '/api/stats/dashboard': { period: '7d', repository: 'all', completed: 34, successRate: 87.5, recordedSpend: 12.42,
        dailyCompleted: [{ date: '2026-09-26', count: 12 }, { date: '2026-09-27', count: 22 }], previous: { completed: 29, successRate: 80, recordedSpend: 10 } },
    };
    return url in responses ? route.fulfill({ json: responses[url] }) : route.fulfill({ status: 503, json: { error: 'Fixture unavailable' } });
  });
  return { events, settings, get reads() { return reads; } };
}

async function capture(page: Page, name: string, selector: string) {
  if (!process.env.PROPR_CAPTURE_PREVIEWS) return;
  const directory = path.resolve('../.propr/previews');
  await mkdir(directory, { recursive: true });
  await page.locator(selector).screenshot({ animations: 'disabled', path: path.join(directory, name) });
}

test('dashboard places tips below stats, persists only deliberate dismissal and replaces it', async ({ page }) => {
  await page.setViewportSize({ width: 1360, height: 1000 });
  const state = await fixture(page);
  await page.goto('/');
  const tips = page.getByRole('region', { name: 'Usage tips' });
  await expect(tips).toBeVisible();
  const statsBounds = await page.getByTestId('historical-stats-section').boundingBox();
  const tipBounds = await tips.boundingBox();
  expect(tipBounds!.y).toBeGreaterThanOrEqual(statsBounds!.y + statsBounds!.height - 1);
  expect(state.events).toHaveLength(0);
  expect(state.reads).toBe(1);
  await expect(tips.getByText(/Automate repeated manual review and fix runs with \/ultrafix/)).toBeVisible();
  await expect(tips.getByText(/reduce the commands you need to send/)).toBeVisible();
  await capture(page, 'usage-tips-desktop.png', '[data-testid="historical-stats-section"] + section');
  await tips.getByRole('button', { name: 'Dismiss Try /ultrafix' }).click();
  await expect(tips.getByText('Keep repository to-dos')).toBeVisible();
  expect(state.events).toHaveLength(1);
  await page.reload();
  await expect(page.getByRole('region', { name: 'Usage tips' })).toBeVisible();
  await expect(page.getByText('Try /ultrafix')).toHaveCount(0);
  expect(state.events).toHaveLength(1);
  await page.setViewportSize({ width: 390, height: 844 });
  const advice = tips.locator('p');
  for (const paragraph of await advice.all()) {
    expect(await paragraph.evaluate(element => element.scrollHeight <= element.clientHeight)).toBe(true);
  }
  await capture(page, 'usage-tips-mobile.png', '[aria-label="Usage tips"]');
});

test('automation settings save the tips toggle from the last section', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const state = await fixture(page);
  await page.goto('/settings?tab=automation');
  await expect(page.getByLabel('Dismissal cooldown days')).toHaveCount(0);
  await expect(page.locator('#settings-panel-automation [data-settings-section]').last()).toHaveAttribute('data-settings-section', 'usage-tips');
  await capture(page, 'usage-tips-settings.png', '[data-settings-section="usage-tips"]');
  await page.getByLabel('Show usage tips').uncheck();
  await page.getByLabel('Show usage tips').blur();
  await expect.poll(() => state.settings.usage_tips_enabled).toBe(false);
});


test('discovery tips share the strip and dismissal replaces the discovery slot', async ({ page }) => {
  await page.setViewportSize({ width: 1360, height: 1000 });
  const state = await fixture(page, true);
  await page.goto('/');
  const tips = page.getByRole('region', { name: 'Usage tips' });
  await expect(tips.getByText('New to you')).toHaveCount(1);
  await expect(tips.getByRole('link', { name: 'Run ProPR from your chat assistant' })).toBeVisible();
  await expect(tips.getByRole('link')).toHaveCount(3);
  expect(state.reads).toBe(1);
  expect(state.events).toHaveLength(0);
  await capture(page, 'discovery-tips-desktop.png', '[aria-label="Usage tips"]');
  await tips.getByRole('button', { name: 'Dismiss Run ProPR from your chat assistant' }).click();
  await expect(tips.getByRole('link', { name: 'See visual previews on pull requests' })).toBeVisible();
  await expect(tips.getByText('New to you')).toHaveCount(1);
  expect(state.events).toHaveLength(1);
  await page.setViewportSize({ width: 390, height: 844 });
  await capture(page, 'discovery-tips-mobile.png', '[aria-label="Usage tips"]');
});

for (const [kind, ids, scores] of [
  ['corrective', ['pr-ultrafix', 'planner-studio', 'mcp-chat-control', 'visual-previews', 'pr-switch'], [95, 85, 78, 76, 55]],
  ['discovery', ['epic-auto-merge', 'mcp-chat-control', 'pr-fix', 'pr-review', 'visual-previews'], [79, 78, 77, 76, 70]],
] as const) {
  test(`interleaved pool preserves the dismissed ${kind} slot after reload`, async ({ page }) => {
    await page.setViewportSize({ width: 1360, height: 1000 });
    const pool = rotateUsageTipCandidates(ids.map((id, i) => ({ id, score: scores[i], reason: USAGE_TIPS_BY_ID.get(id)!.body })), 0);
    const state = await fixture(page, true, pool);
    await page.goto('/');
    const tips = page.getByRole('region', { name: 'Usage tips' });
    const title = (id: string) => USAGE_TIPS_BY_ID.get(id)!.title;
    await expect(tips.getByRole('link')).toHaveText(ids.slice(0, 3).map(title));
    await tips.getByRole('button', { name: `Dismiss ${title(ids[1])}` }).click();
    const expected = [ids[0], ids[2], ids[4]].map(title);
    await expect(tips.getByRole('link')).toHaveText(expected);
    await expect(tips.getByText('New to you')).toHaveCount(kind === 'corrective' ? 1 : 2);
    expect(state.events).toHaveLength(1);
    await page.reload();
    await expect(tips.getByRole('link')).toHaveText(expected);
    expect(state.events).toHaveLength(1);
    await capture(page, `dismissal-${kind}-replacement.png`, '[aria-label="Usage tips"]');
  });
}
