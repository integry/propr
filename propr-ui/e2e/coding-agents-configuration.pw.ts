import { expect, test, type Locator } from '@playwright/test';
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

async function expectHeaderRails(configuration: Locator) {
  const headers = configuration.locator('.coding-agent-header');
  const rails = await headers.evaluateAll(elements => elements.map(element => {
    const left = (selector: string) => element.querySelector(selector)!.getBoundingClientRect().left;
    const path = element.querySelector('.coding-agent-path')!.getBoundingClientRect();
    const status = element.querySelector('.coding-agent-status')!.getBoundingClientRect();
    return { path: path.left, status: status.left, toggle: left('label'), menu: left('[aria-haspopup="menu"]'), pathRight: path.right };
  }));
  expect(rails).toHaveLength(agents.length);
  for (const rail of rails) {
    for (const slot of ['path', 'status', 'toggle', 'menu'] as const) {
      expect(Math.abs(rail[slot] - rails[0][slot])).toBeLessThanOrEqual(1);
    }
    expect(rail.pathRight).toBeLessThanOrEqual(rail.status);
  }
  await expect(configuration.getByText('Inactive', { exact: true })).toBeVisible();
}

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
      if (/\/api\/agents\/[^/]+\/health$/.test(pathname)) return route.fulfill({ json: { agentId: pathname.split('/')[3], status: 'ready', model: 'fixture-model' } });
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
    await expect(configuration.getByText('Ready', { exact: true })).toHaveCount(4);
    await expectHeaderRails(configuration);
    const claudeCard = configuration.locator('.coding-agent-card').filter({
      has: page.getByRole('button', { name: /claude models$/ }),
    });
    const opusAlias = claudeCard.getByRole('button', { name: 'Copy opus55', exact: true });
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
    await expect(configuration.getByRole('button', { name: 'Copy flash38', exact: true })).toBeVisible();
    await configuration.getByRole('button', { name: 'Collapse claude models' }).click();
    await expect(opusAlias).toBeHidden();
    await expect(configuration.getByRole('button', { name: 'Copy flash38', exact: true })).toBeVisible();
    await configuration.getByRole('button', { name: 'More actions for antigravity' }).click();
    await expect(configuration.getByRole('menuitem', { name: 'Log in' })).toBeFocused();
    const menu = await configuration.getByRole('menu').boundingBox();
    const trigger = await configuration.getByRole('button', { name: 'More actions for antigravity' }).boundingBox();
    const firstModel = await configuration.getByRole('button', { name: 'Copy flash38', exact: true }).locator('xpath=../..').boundingBox();
    expect(menu!.y).toBeGreaterThanOrEqual(trigger!.y + trigger!.height);
    expect(Math.abs(menu!.x + menu!.width - trigger!.x - trigger!.width)).toBeLessThanOrEqual(1);
    expect(firstModel!.y).toBeGreaterThanOrEqual(menu!.y + menu!.height);
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


for (const viewport of [
  { name: 'desktop', width: 1440, height: 1000 },
  { name: 'mobile', width: 320, height: 1000 },
]) {
  test(`${viewport.name} shows agent failures and prominent login with enabled-only checks`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const checked: string[] = [];
    let codexReady = false;
    await page.route('**/api/**', async route => {
      const pathname = new URL(route.request().url()).pathname;
      const healthMatch = pathname.match(/^\/api\/agents\/([^/]+)\/health$/);
      if (healthMatch) {
        checked.push(healthMatch[1]);
        return route.fulfill({ json: {
          agentId: healthMatch[1], model: 'lightweight-model',
          ...(healthMatch[1] === 'codex-config' && !codexReady
            ? { status: 'error', errorCode: 'auth_required', error: 'Your login session has expired. Please log in again.' }
            : healthMatch[1] === 'antigravity-config'
              ? { status: 'error', errorCode: 'rate_limit', error: 'Provider rate limit reached. Try again later.' }
              : { status: 'ready' }),
        } });
      }
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
        '/api/config/agent-tank/usage': { enabled: true, agents: {
          antigravity: { name: 'antigravity', usage: { models: [{ model: 'Gemini Flash', percentUsed: 100, resetsIn: '2h' }] } },
        } },
        '/api/notifications/unread-count': { unreadCount: 0 },
        '/api/notifications': { notifications: [], unreadCount: 0, nextCursor: null },
        '/api/agents/codex-config/login-sessions': {
          id: 'fixture-login', agentId: 'codex-config', agentAlias: 'codex', agentType: 'codex',
          status: 'succeeded', output: 'Login completed.', createdAt: new Date().toISOString(),
        },
      };
      if (pathname in responses) return route.fulfill({ json: responses[pathname] });
      return route.fulfill({ status: 503, json: { error: 'Unavailable in configuration fixture' } });
    });
    await page.goto('/ai-agents');
    if (viewport.name === 'mobile') await page.getByRole('button', { name: 'Configuration', exact: true }).click();
    const configuration = page.getByTestId(viewport.name === 'desktop'
      ? 'ai-agents-configuration-pane'
      : 'ai-agents-mobile-configuration-scroll');
    const codexCard = configuration.locator('.coding-agent-card').filter({ has: page.getByRole('button', { name: /codex models$/ }) });
    const claudeCard = configuration.locator('.coding-agent-card').filter({ has: page.getByRole('button', { name: /claude models$/ }) });
    const disabledCard = configuration.locator('.coding-agent-card').filter({ has: page.getByRole('button', { name: /vibe models$/ }) });
    const rateLimitedCard = configuration.locator('.coding-agent-card').filter({ has: page.getByRole('button', { name: /antigravity models$/ }) });
    await expect(codexCard.getByRole('alert')).toContainText('Your login session has expired.');
    await expect(codexCard.getByRole('alert')).toContainText('Authentication Expired');
    await expect(rateLimitedCard.getByRole('alert')).toContainText('Rate Limit Exceeded');
    await expectHeaderRails(configuration);
    await expect(codexCard.getByRole('button', { name: 'Log in', exact: true })).toBeVisible();
    await expect(claudeCard.getByText('Ready', { exact: true })).toBeVisible();
    await expect(claudeCard.locator('.coding-agent-header').getByText('Ready', { exact: true })).toBeVisible();
    await expect(claudeCard.getByRole('button', { name: 'Log in', exact: true })).toHaveCount(0);
    await expect(rateLimitedCard.getByRole('button', { name: 'Log in', exact: true })).toHaveCount(0);
    await expect(rateLimitedCard.getByRole('button', { name: 'View Quota / Usage' })).toBeVisible();
    for (const card of [codexCard, rateLimitedCard]) {
      const retry = card.getByRole('button', { name: 'Check again' });
      await expect(retry).toHaveCSS('border-top-color', 'rgb(203, 213, 225)');
      await expect(retry).toHaveCSS('color', 'rgb(51, 65, 85)');
    }
    await expect(disabledCard.getByText('Checking agent…')).toHaveCount(0);
    expect(checked).not.toContain('vibe-config');
    expect(new Set(checked).size).toBe(4);
    expect(checked).toHaveLength(4);
    const codexModelCount = await codexCard.locator('.coding-agent-name').textContent();
    await codexCard.getByRole('button', { name: 'Collapse codex models' }).click();
    await expect(codexCard.getByRole('alert')).toBeVisible();
    const overflow = await configuration.evaluate(element => ({ client: element.clientWidth, scroll: element.scrollWidth }));
    expect(overflow.scroll).toBeLessThanOrEqual(overflow.client + 1);
    if (process.env.PROPR_CAPTURE_PREVIEWS) {
      await page.mouse.move(0, 0);
      await configuration.screenshot({ animations: 'disabled', path: `../.propr/previews/agent-health-${viewport.name}.png` });
    }
    await rateLimitedCard.getByRole('button', { name: 'View Quota / Usage' }).click();
    await expect(rateLimitedCard.getByRole('region', { name: 'antigravity quota / usage' }).getByText('100%')).toBeVisible();
    if (process.env.PROPR_CAPTURE_PREVIEWS && viewport.name === 'desktop') {
      await rateLimitedCard.screenshot({ animations: 'disabled', path: '../.propr/previews/agent-quota-usage.png' });
    }
    await rateLimitedCard.getByRole('button', { name: 'View Quota / Usage' }).click();
    await rateLimitedCard.getByRole('button', { name: 'Check again' }).click();
    await expect.poll(() => checked.filter(id => id === 'antigravity-config').length).toBe(2);
    await codexCard.getByRole('button', { name: 'Log in', exact: true }).click();
    await expect(page.getByRole('dialog')).toContainText('Log in to codex');
    await expect(page.getByRole('dialog')).toContainText('Login completed. New jobs can now use these credentials.');
    codexReady = true;
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(codexCard.getByText('Ready', { exact: true })).toBeVisible();
    await expect(codexCard.getByRole('alert')).toHaveCount(0);
    await expect(codexCard.locator('.coding-agent-name')).toHaveText(codexModelCount!);
    expect(checked.filter(id => id === 'codex-config')).toHaveLength(2);
  });
}

for (const viewport of [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'mobile', width: 320, height: 900 },
]) {
  test(`${viewport.name} refreshes after successful login during a pending health probe`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const codex = agents.find(agent => agent.type === 'codex')!;
    let initialProbe!: import('@playwright/test').Route;
    let refreshedProbe!: import('@playwright/test').Route;
    let checks = 0;
    await page.route('**/api/**', async route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/api/agents/codex-config/health') {
        checks++;
        if (checks === 1) initialProbe = route;
        else {
          expect(url.searchParams.get('fresh')).toBe('true');
          refreshedProbe = route;
        }
        return;
      }
      const responses: Record<string, unknown> = {
        '/api/auth/demo-mode': { demoMode: false },
        '/api/auth/user': {
          id: 'configuration-fixture', login: 'configuration-fixture', username: 'configuration-fixture',
          displayName: 'Configuration Fixture', email: null, avatarUrl: null, role: 'admin',
          permissions: ['instance.manage_agents'], authorizationSource: 'local',
        },
        '/api/config/agents': { agents: [codex] },
        '/api/config/synthetic-agents': { synthetic_agents: [] },
        '/api/config/agent-tank/status': { available: false },
        '/api/notifications/unread-count': { unreadCount: 0 },
        '/api/notifications': { notifications: [], unreadCount: 0, nextCursor: null },
        '/api/agents/codex-config/login-sessions': {
          id: 'fixture-login', agentId: 'codex-config', agentAlias: 'codex', agentType: 'codex',
          status: 'succeeded', output: 'Login completed.', createdAt: new Date().toISOString(),
        },
      };
      return route.fulfill(url.pathname in responses
        ? { json: responses[url.pathname] }
        : { status: 503, json: { error: 'Unavailable in configuration fixture' } });
    });
    await page.goto('/ai-agents');
    if (viewport.name === 'mobile') await page.getByRole('button', { name: 'Configuration', exact: true }).click();
    const configuration = page.getByTestId(viewport.name === 'desktop'
      ? 'ai-agents-configuration-pane' : 'ai-agents-mobile-configuration-scroll');
    const card = configuration.locator('.coding-agent-card');
    await expect(card.getByText('Checking agent…')).toBeVisible();
    await expect.poll(() => checks).toBe(1);
    await card.getByRole('button', { name: 'More actions for codex' }).click();
    await card.getByRole('menuitem', { name: 'Log in' }).click();
    await expect(page.getByRole('dialog')).toContainText('Login completed. New jobs can now use these credentials.');
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await expect.poll(() => checks).toBe(2);
    await initialProbe.fulfill({ json: {
      agentId: codex.id, status: 'error', errorCode: 'auth_required', error: 'Login expired',
    } });
    await expect(card.getByText('Checking agent…')).toBeVisible();
    await expect(card.getByRole('alert')).toHaveCount(0);
    await refreshedProbe.fulfill({ json: { agentId: codex.id, status: 'ready', model: 'gpt-6-luna' } });
    await expect(card.getByText('Ready', { exact: true })).toBeVisible();
    await expect(card.getByRole('alert')).toHaveCount(0);
    if (process.env.PROPR_CAPTURE_PREVIEWS) {
      await page.mouse.move(0, 0);
      await card.screenshot({ animations: 'disabled', path: `../.propr/previews/post-login-health-${viewport.name}.png` });
    }
  });
}
