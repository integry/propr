import { expect, test } from '@playwright/test';
import { AGENT_DEFAULTS, AGENT_MODELS, type AgentType } from '@propr/shared';

const agents = (['claude', 'codex', 'vibe', 'antigravity', 'opencode'] as const).map(type => ({
  id: `${type}-config`,
  type,
  alias: type,
  enabled: type !== 'vibe',
  dockerImage: 'propr/agent:test',
  configPath: AGENT_DEFAULTS[type].configPath,
  supportedModels: AGENT_MODELS[type].map(model => model.id),
  defaultModel: type === 'claude' ? 'claude-opus-5-5' : type === 'codex' ? 'gpt-6.1-sol' : AGENT_MODELS[type][0].id,
}));

for (const viewport of [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'mobile', width: 320, height: 900 },
]) {
  test(`${viewport.name} keeps model aliases compact and providers independently collapsible`, async ({ page, context }) => {
    await page.setViewportSize(viewport);
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.route('**/api/**', async route => {
      const pathname = new URL(route.request().url()).pathname;
      const responses: Record<string, unknown> = {
        '/api/auth/demo-mode': { demoMode: false },
        '/api/auth/user': {
          id: 'configuration-fixture', login: 'configuration-fixture', username: 'configuration-fixture',
          displayName: 'Configuration Fixture', email: null, avatarUrl: null, role: 'admin',
          permissions: ['instance.manage_agents'], authorizationSource: 'local',
        },
        '/api/config/agents': { agents },
        '/api/config/synthetic-agents': { synthetic_agents: [] },
        '/api/config/agent-tank/status': { available: false },
        '/api/notifications/unread-count': { unreadCount: 0 },
        '/api/notifications': { notifications: [], unreadCount: 0, nextCursor: null },
      };
      if (pathname in responses) return route.fulfill({ json: responses[pathname] });
      return route.fulfill({ status: 503, json: { error: 'Unavailable in configuration fixture' } });
    });
    await page.goto('/ai-agents');
    if (viewport.name === 'mobile') await page.getByRole('button', { name: 'Configuration', exact: true }).click();
    const configuration = page.getByTestId(viewport.name === 'desktop'
      ? 'ai-agents-configuration-pane'
      : 'ai-agents-mobile-configuration-scroll');

    await expect(configuration.getByRole('button', { name: 'Collapse claude models' })).toBeVisible();
    await expect(configuration.getByRole('button', { name: 'Collapse codex models' })).toBeVisible();
    for (const provider of ['vibe', 'antigravity', 'opencode'] as AgentType[]) {
      await expect(configuration.getByRole('button', { name: `Expand ${provider} models` })).toBeVisible();
    }
    const opusAlias = configuration.getByRole('button', { name: 'Copy opus55', exact: true });
    await expect(opusAlias).toHaveAttribute('title', /claude-opus-5-5/);
    const modelRow = opusAlias.locator('xpath=../..');
    await expect(modelRow.getByRole('button', { name: /^Copy / })).toHaveCount(1);
    await expect(modelRow).toHaveCSS('grid-template-rows', /^\d+(?:\.\d+)?px$/);
    await expect(opusAlias).toHaveCSS('background-color', 'rgb(241, 245, 249)');
    await expect(configuration.getByText('ID / Alias', { exact: true })).toHaveCount(0);
    await expect(configuration.getByText('claude', { exact: true })).toHaveCount(1);
    await opusAlias.click();
    await expect(opusAlias).toHaveText('Copied');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('opus55');
    await expect(opusAlias).toHaveText('opus55');

    const overflow = await configuration.evaluate(element => ({ client: element.clientWidth, scroll: element.scrollWidth }));
    expect(overflow.scroll).toBeLessThanOrEqual(overflow.client + 1);
    if (process.env.PROPR_CAPTURE_PREVIEWS) {
      await page.mouse.move(0, 0);
      await configuration.screenshot({ animations: 'disabled', path: `../.propr/previews/coding-agents-${viewport.name}.png` });
    }

    await configuration.getByRole('button', { name: 'Expand antigravity models' }).click();
    await expect(configuration.getByRole('button', { name: 'Copy flash38-high', exact: true })).toBeVisible();
    await configuration.getByRole('button', { name: 'Collapse claude models' }).click();
    await expect(opusAlias).toBeHidden();
    await expect(configuration.getByRole('button', { name: 'Copy flash38-high', exact: true })).toBeVisible();
    await configuration.getByRole('button', { name: 'More actions for antigravity' }).click();
    await expect(configuration.getByRole('menuitem', { name: 'Log in' })).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(configuration.getByRole('menuitem', { name: 'Edit path' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(configuration.getByRole('menu')).toHaveCount(0);
    await expect(configuration.getByRole('button', { name: 'More actions for antigravity' })).toBeFocused();

    if (process.env.PROPR_CAPTURE_PREVIEWS && viewport.name === 'desktop') {
      await configuration.getByRole('button', { name: 'More actions for antigravity' }).click();
      await configuration.screenshot({ animations: 'disabled', path: '../.propr/previews/coding-agents-expanded.png' });
    }
  });
}
