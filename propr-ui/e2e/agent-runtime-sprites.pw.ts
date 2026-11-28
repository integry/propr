import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const PREFIX = 'propr-a21b1d274add47ba-';

async function mockApi(page: Page) {
  const removals: unknown[] = [];
  let sprites = [
    { name: `${PREFIX}7f3c9e2a`, status: 'cold', createdAt: '2026-11-27T22:56:00.000Z' },
  ];
  await page.routeWebSocket('**/socket.io/**', socket => socket.close());
  await page.route('**/api/**', async route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/api/admin/sprites/remove' && route.request().method() === 'POST') {
      removals.push(route.request().postDataJSON());
      const deleted = sprites.length;
      sprites = [];
      return route.fulfill({ json: { deleted, failed: [] } });
    }
    const responses: Record<string, unknown> = {
      '/api/auth/demo-mode': { demoMode: false },
      '/api/auth/user': { id: 'preview-admin', username: 'preview-admin', login: 'preview-admin', displayName: 'Instance administrator', email: null, avatarUrl: null, role: 'admin', permissions: ['instance.manage_settings', 'instance.manage_agents', 'instance.manage_runtime'], authorizationSource: 'local' },
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
      '/api/admin/sprites': { configured: true, prefix: PREFIX, count: sprites.length, busy: 0, sprites },
    };
    return pathname in responses ? route.fulfill({ json: responses[pathname] }) : route.fulfill({ status: 503, json: { error: 'Unavailable in isolated UI fixture' } });
  });
  return removals;
}

test('Settings → Maintenance → Agent runtime removes this instance\'s Sprites after a confirmation naming the count', async ({ page }) => {
  const removals = await mockApi(page);
  const capture = process.env.PROPR_CAPTURE_PREVIEWS ? path.resolve('../.propr/previews') : null;
  if (capture) await mkdir(capture, { recursive: true });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/settings?tab=maintenance');
  await page.getByPlaceholder('Search settings...').fill('remove sprites');
  const section = page.getByRole('region', { name: 'Agent runtime', exact: true });
  await expect(section.getByText(`${PREFIX}7f3c9e2a`)).toBeVisible();
  await expect(section.getByText(PREFIX, { exact: true })).toBeVisible();
  if (capture) await section.screenshot({ path: path.join(capture, 'agent-runtime-sprites.png') });

  await section.getByRole('button', { name: 'Remove all Sprites of this instance' }).click();
  const dialog = page.getByRole('dialog', { name: 'Remove 1 Sprite?' });
  await expect(dialog).toBeVisible();
  if (capture) await page.screenshot({ path: path.join(capture, 'agent-runtime-sprites-confirm.png') });
  expect(removals).toEqual([]);

  await dialog.getByRole('button', { name: 'Remove 1 Sprite' }).click();
  await expect(section.getByText('Removed 1 Sprite.')).toBeVisible();
  await expect(section.getByRole('status').first()).toHaveText('No Sprites');
  await expect(section.getByRole('button', { name: 'Remove all Sprites of this instance' })).toHaveCount(0);
  expect(removals).toEqual([{ count: 1 }]);
  if (capture) await section.screenshot({ path: path.join(capture, 'agent-runtime-sprites-removed.png') });
});
