import { expect, test } from '@playwright/test';

for (const width of [1280, 320]) {
  test(`agent preparation automatically becomes ready and safe failures wrap at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    let state = 'preparing';
    const diagnostic = 'Preparation could not finish. Check that the worker is running and has enough disk space. ' + 'LongDiagnosticWithoutSpaces'.repeat(35);
    await page.route('**/api/**', async route => {
      const pathname = new URL(route.request().url()).pathname;
      if (/\/api\/agents\/[^/]+\/health$/.test(pathname)) {
        return route.fulfill({ json: { agentId: 'claude', status: state === 'failed' ? 'error' : state,
          ...(state === 'failed' ? { errorCode: 'preparation_failed', error: diagnostic } : {}) } });
      }
      const responses: Record<string, unknown> = {
        '/api/auth/demo-mode': { demoMode: false },
        '/api/auth/user': { id: 'preview', login: 'preview', username: 'preview', displayName: 'Preview', email: null, avatarUrl: null, role: 'admin', permissions: ['instance.manage_agents'], authorizationSource: 'local' },
        '/api/config/agents': { agents: [{ id: 'claude', type: 'claude', alias: 'Claude', enabled: true,
          dockerImage: 'propr/agent:test', configPath: '~/.claude', supportedModels: ['claude-haiku-4-5-20251001'] }] },
        '/api/config/synthetic-agents': { synthetic_agents: [] },
        '/api/config/agent-tank/status': { available: false },
        '/api/notifications/unread-count': { unreadCount: 0 },
        '/api/notifications': { notifications: [], unreadCount: 0, nextCursor: null },
      };
      return route.fulfill({ json: responses[pathname] ?? {} });
    });
    const open = async () => {
      await page.goto('/ai-agents');
      if (width === 320) await page.getByRole('button', { name: 'Configuration', exact: true }).click();
    };
    await open();
    const configuration = page.getByTestId(width === 320 ? 'ai-agents-mobile-configuration-scroll' : 'ai-agents-configuration-pane');
    await expect(configuration.getByText('Preparing agent image…')).toBeVisible();
    const card = configuration.locator('.coding-agent-card');
    if (process.env.PROPR_CAPTURE_PREVIEWS) await card.screenshot({ path: `../.propr/previews/agent-preparing-${width}.png` });
    state = 'ready';
    await expect(configuration.getByText('Ready', { exact: true })).toBeVisible({ timeout: 10000 });
    if (process.env.PROPR_CAPTURE_PREVIEWS) await card.screenshot({ path: `../.propr/previews/agent-ready-${width}.png` });
    state = 'failed';
    await open();
    await expect(configuration.getByRole('alert')).toContainText('Agent image preparation failed');
    await expect(configuration.getByRole('button', { name: 'Check again' })).toBeVisible();
    await expect(configuration.getByRole('button', { name: 'Log in', exact: true })).toHaveCount(0);
    const dimensions = await configuration.evaluate(element => ({ client: element.clientWidth, scroll: element.scrollWidth }));
    expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.client + 1);
    if (process.env.PROPR_CAPTURE_PREVIEWS) await card.screenshot({ path: `../.propr/previews/agent-failed-${width}.png` });
  });
}
