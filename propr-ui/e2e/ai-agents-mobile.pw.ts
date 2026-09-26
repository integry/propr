import { expect, test, type Page } from '@playwright/test';
import { browserVoicePreferenceKey } from '../src/voice/voicePreferenceKey';

const timestamp = '2026-09-11T00:00:00.000Z';
const user = {
  id: 'mobile-preview-admin',
  login: 'mobile-preview-admin',
  username: 'mobile-preview-admin',
  displayName: 'Mobile Preview Admin',
  email: null,
  avatarUrl: null,
  role: 'admin',
  permissions: ['instance.manage_agents'],
  authorizationSource: 'local',
};

const agents = [{
  id: 'codex-mobile',
  type: 'codex',
  alias: 'Production Codex Agent',
  enabled: true,
  dockerImage: 'propr/agent:latest',
  configPath: '/home/node/.config/propr/agents/production-codex-account',
  defaultModel: 'gpt-6-astra',
  supportedModels: [
    'gpt-6-astra',
    'gpt-6-astra-high',
    'gpt-6-astra-xhigh',
    'gpt-5.6-sol',
    'gpt-5.6-sol-high',
    'gpt-5.5',
    'gpt-5.4',
  ],
}];

const notificationPreferences = {
  preferences: {},
  quietHours: { start: null, end: null, timezone: 'UTC' },
  badgeEnabled: false,
  updatedAt: timestamp,
};

async function stubAiAgentsApis(page: Page): Promise<void> {
  await page.route('**/api/**', async route => {
    const pathname = new URL(route.request().url()).pathname;
    const responses: Record<string, unknown> = {
      '/api/auth/demo-mode': { demoMode: false },
      '/api/auth/user': user,
      '/api/config/agents': { agents },
      '/api/config/synthetic-agents': { synthetic_agents: [] },
      '/api/config/agent-tank/status': { available: false },
      '/api/notifications/unread-count': { unreadCount: 0 },
      '/api/notifications/preferences': notificationPreferences,
      '/api/notifications': { notifications: [], unreadCount: 0, nextCursor: null },
    };

    if (pathname in responses) {
      await route.fulfill({ json: responses[pathname] });
      return;
    }

    await route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'Unavailable in AI Agents mobile smoke test' }),
    });
  });
}

async function expectNoPageOverflow(page: Page): Promise<void> {
  const dimensions = await page.evaluate(() => ({
    viewportWidth: window.innerWidth,
    documentWidth: document.documentElement.scrollWidth,
  }));
  expect(dimensions.documentWidth).toBeLessThanOrEqual(dimensions.viewportWidth);
}

test('keeps the Playground usable at 320px', async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 320, height: 720 });
  // Voice briefings are opt-in, so this layout check enables them for this
  // account and instance before asserting that the launcher clears the composer.
  await page.addInitScript(
    key => localStorage.setItem(key, 'true'),
    browserVoicePreferenceKey(new URL(baseURL!).origin, user.id),
  );
  await stubAiAgentsApis(page);
  await page.goto('/ai-agents');

  await expect(page.getByRole('heading', { name: 'AI Agents' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Playground' })).toBeVisible();
  const search = page.getByRole('combobox', { name: 'Search and add models to compare' });
  await expect(search).toBeVisible();
  await expect(page.getByPlaceholder('Type a message to test...').filter({ visible: true })).toBeVisible();
  const sendBounds = await page.getByRole('button', { name: 'Send message' }).boundingBox();
  const briefingBounds = await page.getByRole('button', { name: 'Voice briefing' }).boundingBox();
  expect(sendBounds).not.toBeNull();
  expect(briefingBounds).not.toBeNull();
  expect(sendBounds!.y + sendBounds!.height).toBeLessThanOrEqual(briefingBounds!.y);
  await expectNoPageOverflow(page);

  await search.click();
  const options = page.getByRole('listbox', { name: 'Available models' });
  await expect(options).toBeVisible();
  const optionBounds = await options.boundingBox();
  expect(optionBounds).not.toBeNull();
  expect(optionBounds!.x).toBeGreaterThanOrEqual(0);
  expect(optionBounds!.x + optionBounds!.width).toBeLessThanOrEqual(320);
  expect(optionBounds!.y + optionBounds!.height).toBeLessThanOrEqual(720);
  await expectNoPageOverflow(page);

  await page.getByRole('button', { name: 'Configuration' }).click();
  await expect(page.getByText('Production Codex Agent').first()).toBeVisible();
  await expect(page.getByText('/home/node/.config/propr/agents/production-codex-account').first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Show 2 legacy models' })).toBeVisible();
  await expectNoPageOverflow(page);
});

test('keeps the tabbed mobile layout through the app-shell breakpoint', async ({ page }) => {
  await page.setViewportSize({ width: 700, height: 800 });
  await stubAiAgentsApis(page);
  await page.goto('/ai-agents');

  await expect(page.getByRole('heading', { name: 'AI Agents' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Playground' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Agent Configuration' })).toBeHidden();
  await expectNoPageOverflow(page);
});
