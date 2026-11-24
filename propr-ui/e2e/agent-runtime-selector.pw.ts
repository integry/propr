import { expect, test } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

// The agent dialog's runtime selector with local API fixtures: choosing Fly
// Sprites saves `runtime: "sprites"` for the agent.
test('a Claude agent can be switched to the Fly Sprites runtime', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1080 });
  let saved: { agents: Array<{ type: string; runtime?: string }> } | undefined;
  await page.route('**/api/**', async route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/api/auth/demo-mode') return route.fulfill({ json: { demoMode: false } });
    if (pathname === '/api/auth/user') return route.fulfill({ json: {
      id: 'test-user', login: 'test-user', username: 'test-user', displayName: 'Test User',
      email: null, avatarUrl: null, role: 'admin',
      permissions: ['instance.manage_agents', 'instance.manage_settings', 'instance.manage_runtime'],
      authorizationSource: 'local',
    } });
    if (pathname === '/api/config/agents') {
      if (route.request().method() !== 'GET') saved = route.request().postDataJSON();
      return route.fulfill({ json: { success: true, ...(saved ?? { agents: [] }) } });
    }
    if (pathname.includes('/versions')) return route.fulfill({ json: {
      agentType: 'claude', defaultVersion: '2.1.330', availableTags: [], recentVersions: [],
    } });
    if (pathname === '/api/config/synthetic-agents') return route.fulfill({ json: { synthetic_agents: [] } });
    if (pathname === '/api/config/agent-tank/status') return route.fulfill({ json: { available: true } });
    if (pathname === '/api/notifications/unread-count') return route.fulfill({ json: { unreadCount: 0 } });
    if (pathname === '/api/notifications') return route.fulfill({ json: { notifications: [], unreadCount: 0, nextCursor: null } });
    return route.fulfill({ status: 503, json: { error: 'Unavailable in runtime selector fixture' } });
  });
  await page.goto('/ai-agents');
  await page.getByRole('button', { name: '+ Add Agent' }).click();
  await expect(page.getByRole('radio', { name: 'Instance default' })).toHaveAttribute('aria-checked', 'true');
  await page.getByRole('radio', { name: 'Fly Sprites' }).click();
  await expect(page.getByRole('radio', { name: 'Fly Sprites' })).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByText(/Needs PROPR_SPRITES_TOKEN on the worker/)).toBeVisible();
  if (process.env.PROPR_CAPTURE_PREVIEW) {
    const directory = resolve(process.cwd(), '../.propr/previews');
    mkdirSync(directory, { recursive: true });
    const runtime = page.getByText('Runtime', { exact: true }).locator('..');
    await runtime.scrollIntoViewIfNeeded();
    await page.getByRole('heading', { name: 'Add new agent' }).locator('../..').screenshot({ path: resolve(directory, 'agent-runtime-sprites.png') });
    await runtime.screenshot({ path: resolve(directory, 'agent-runtime-selector.png') });
  }
  await page.getByRole('button', { name: /^vibe$/i }).click();
  await expect(page.getByRole('radio', { name: 'Fly Sprites' })).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByText('Fly Sprites runs Claude Code and Codex agents only.')).toBeVisible();
  await page.getByRole('button', { name: /^claude$/i }).click();
  await page.getByRole('button', { name: 'Add Agent & Log In', exact: true }).click();
  await expect.poll(() => saved?.agents[0]?.runtime).toBe('sprites');
  expect(saved?.agents[0]?.type).toBe('claude');
});
