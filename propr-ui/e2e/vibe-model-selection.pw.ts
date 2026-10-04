import { expect, test } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

// Exercise the real configuration dialog with local API fixtures; no credentials
// or model inference are needed to verify what is sent to the configuration API.
test('Vibe offers GLM models and saves the selected default', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1080 });
  let saved: { agents: Array<{ type: string; supportedModels: string[]; defaultModel: string }> } | undefined;
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
      agentType: 'vibe', defaultVersion: '2.25.8', availableTags: [], recentVersions: [],
    } });
    if (pathname === '/api/config/synthetic-agents') return route.fulfill({ json: { synthetic_agents: [] } });
    if (pathname === '/api/config/agent-tank/status') return route.fulfill({ json: { available: true } });
    if (pathname === '/api/notifications/unread-count') return route.fulfill({ json: { unreadCount: 0 } });
    if (pathname === '/api/notifications') return route.fulfill({ json: { notifications: [], unreadCount: 0, nextCursor: null } });
    return route.fulfill({ status: 503, json: { error: 'Unavailable in model selection fixture' } });
  });
  await page.goto('/ai-agents');
  await page.getByRole('button', { name: '+ Add Agent' }).click();
  await page.getByRole('button', { name: 'vibe', exact: true }).click();
  await expect(page.getByText('GLM 5.3', { exact: true })).toBeVisible();
  await expect(page.getByText('GLM 5.2', { exact: true })).toBeVisible();
  await expect(page.getByText('llm-vibe-glm53', { exact: true })).toBeVisible();
  const medium = page.locator('div.py-2.px-2').filter({ has: page.locator('code').filter({ hasText: /^mistral-medium-3\.5$/ }) }).last();
  await expect(medium.getByRole('radio')).toBeChecked();
  const glm = page.locator('div.py-2.px-2').filter({ has: page.locator('code').filter({ hasText: /^zai-glm-5-3$/ }) }).last();
  await glm.getByRole('radio').check();
  if (process.env.PROPR_CAPTURE_PREVIEW) {
    const directory = resolve(process.cwd(), '../.propr/previews');
    mkdirSync(directory, { recursive: true });
    await page.getByRole('heading', { name: 'Add New Agent' }).locator('../..').screenshot({ path: resolve(directory, 'vibe-glm-selection.png') });
  }
  await page.getByRole('button', { name: 'Add Agent', exact: true }).click();
  await expect.poll(() => saved?.agents[0]?.defaultModel).toBe('zai-glm-5-3');
  await expect(page.getByRole('heading', { name: 'Add New Agent' })).toBeHidden();
  expect(saved?.agents[0]?.type).toBe('vibe');
  expect(saved?.agents[0]?.supportedModels).toEqual(['mistral-medium-3.5', 'zai-glm-5-3', 'zai-glm-5-2']);
});
