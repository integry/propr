import { expect, test, type Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const status = {
  enabled: true, afterMs: 900_000, source: 'settings', idle: false, idleSince: null, shutdownAt: null,
  blockers: [
    { signal: 'queue_jobs', detail: 'github-issue-processor: 1 active' },
    { signal: 'ui_sessions', detail: '1 open Web UI session' },
  ],
  nextDueAt: '2026-11-24T14:00:00.000Z', checkedAt: '2026-11-24T12:00:00.000Z',
  lastShutdown: { shutdownAt: '2026-11-24T02:00:00.000Z', reason: 'idle for 900s', idleForMs: 900_000, nextDueAt: '2026-11-24T08:00:00.000Z' },
  lastWake: { wokeAt: '2026-11-24T08:00:06.000Z', source: 'connect_ping', coldStartMs: 6200, sleptMs: 21_600_000, shutdownAt: '2026-11-24T02:00:00.000Z' },
};

async function mockApi(page: Page) {
  let saved: unknown = null;
  let settings = { enabled: false, afterMs: 900_000, after: '15m', source: 'default', environmentManaged: false,
    environment: { PROPR_IDLE_SHUTDOWN: null, PROPR_IDLE_SHUTDOWN_AFTER: null }, warnings: [], status: { ...status, enabled: false, source: 'default' } };
  await page.routeWebSocket('**/socket.io/**', socket => socket.close());
  await page.route('**/api/**', async route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/api/admin/idle-shutdown' && route.request().method() === 'PUT') {
      saved = route.request().postDataJSON();
      settings = { ...settings, enabled: true, after: '15m', source: 'settings', status };
      return route.fulfill({ json: settings });
    }
    const responses: Record<string, unknown> = {
      '/api/auth/demo-mode': { demoMode: false },
      '/api/auth/user': { id: 'preview-admin', username: 'preview-admin', login: 'preview-admin', displayName: 'Instance administrator', email: null, avatarUrl: null, role: 'admin', permissions: ['instance.manage_settings', 'instance.manage_agents'], authorizationSource: 'local' },
      '/api/config/settings': { worker_concurrency: 2, auto_followup_score_threshold: 4, ultrafix_rating_goal: 7, ultrafix_max_cycles: 5, ultrafix_pause_seconds: 60, model_reasoning_level: '', github_user_whitelist: [] },
      '/api/config/followup-keywords': { followup_keywords: [] },
      '/api/config/followup-ignore-keywords': { followup_ignore_keywords: [] },
      '/api/config/pr-label': { pr_label: 'propr' },
      '/api/config/primary-processing-labels': { primary_processing_labels: ['AI'] },
      '/api/config/agents': { agents: [] },
      '/api/config/summarization': { enabled: false, agent_alias: '', fallback_agent_alias: '' },
      '/api/config/agent-tank': { mode: 'disabled', enabled: false },
      '/api/config/agent-tank/status': { available: false },
      '/api/config/agent-tank/detect': { detected: false },
      '/api/instance/catalog': { agents: [], repositories: [] },
      '/api/notifications/config': { push: { configured: false, vapidPublicKey: null } },
      '/api/notifications/unread-count': { unreadCount: 0 },
      '/api/admin/idle-shutdown': settings,
    };
    return pathname in responses ? route.fulfill({ json: responses[pathname] }) : route.fulfill({ status: 503, json: { error: 'Unavailable in isolated UI fixture' } });
  });
  return () => saved;
}

test('idle shutdown is off by default and can be turned on from Settings → Maintenance', async ({ page }) => {
  const saved = await mockApi(page);
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.goto('/settings?tab=maintenance');
  await page.getByPlaceholder('Search settings...').fill('idle shutdown');
  const section = page.getByRole('region', { name: 'Idle shutdown', exact: true });
  await expect(section.getByText('1 open Web UI session')).toBeVisible();
  await expect(section.getByLabel('Stop the instance when idle')).not.toBeChecked();
  await section.getByLabel('Stop the instance when idle').check();
  await section.getByRole('button', { name: 'Save' }).click();
  await expect(section.getByText(/applies it within 30 seconds/)).toBeVisible();
  expect(saved()).toEqual({ enabled: true, after: '15m' });
  if (process.env.PROPR_CAPTURE_PREVIEWS) {
    const directory = path.resolve('../.propr/previews'); await mkdir(directory, { recursive: true });
    await section.screenshot({ path: path.join(directory, 'idle-shutdown-desktop.png') });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await page.getByRole('button', { name: 'Back to Settings' }).click();
    await page.getByPlaceholder('Search settings...').fill('idle shutdown');
    await expect(section.getByText('1 open Web UI session')).toBeVisible();
    await section.screenshot({ path: path.join(directory, 'idle-shutdown-mobile.png') });
    await writeFile(path.join(directory, 'manifest.json'), JSON.stringify({ previews: [
      { path: '.propr/previews/idle-shutdown-desktop.png', title: 'Idle shutdown — desktop', description: 'Settings → Maintenance → Idle shutdown after turning it on: the switch, idle window, what keeps the instance awake, next scheduled work, last idle shutdown and last wake (sample data).' },
      { path: '.propr/previews/idle-shutdown-mobile.png', title: 'Idle shutdown — mobile', description: 'The same section at 390 px after saving, with the blockers that keep the instance awake (sample data).' },
    ], toolSuggestions: [] }, null, 2));
  }
});
