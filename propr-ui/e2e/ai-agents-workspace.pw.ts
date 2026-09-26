import { expect, test, type Locator, type Page } from '@playwright/test';

const user = {
  id: 'layout-user',
  login: 'layout-user',
  username: 'layout-user',
  displayName: 'Layout User',
  email: null,
  avatarUrl: null,
  role: 'admin',
  permissions: [
    'instance.manage_agents',
    'instance.manage_members',
    'instance.manage_runtime',
    'instance.manage_settings',
  ],
  authorizationSource: 'local',
};

const agents = Array.from({ length: 14 }, (_, index) => ({
  id: `codex-${index + 1}`,
  type: 'codex',
  alias: `Codex ${index + 1}`,
  enabled: true,
  dockerImage: 'codex',
  configPath: `/agents/codex-${index + 1}`,
  supportedModels: ['gpt-5.1-codex'],
  defaultModel: 'gpt-5.1-codex',
}));

async function installDesktopPresentation(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const profile = {
      id: 'electron-layout',
      name: 'Electron layout fixture',
      baseUrl: window.location.origin,
      kind: 'local',
    };
    const noop = async () => undefined;
    Object.defineProperty(window, '__PROPR_DESKTOP__', {
      configurable: true,
      value: {
        isDesktop: true,
        platform: 'linux',
        app: { onDeepLink: () => () => undefined },
        profiles: {
          list: async () => [profile],
          save: noop,
          remove: noop,
          getActiveId: async () => profile.id,
          setActiveId: noop,
        },
        discovery: { supported: false, discover: async () => [] },
        authentication: { authenticate: noop },
        externalBrowser: { open: noop },
        localSetup: { supported: false, setup: async () => profile },
        connection: { probe: async () => ({ status: 'ready', version: 'test' }) },
      },
    });
  });
}

async function stubWorkspaceApis(page: Page): Promise<void> {
  await page.route('**/api/**', async route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/api/auth/demo-mode') return route.fulfill({ json: { demoMode: false } });
    if (pathname === '/api/auth/user') return route.fulfill({ json: user });
    if (pathname === '/api/config/agents') return route.fulfill({ json: { agents } });
    if (pathname === '/api/config/synthetic-agents') {
      return route.fulfill({ json: { synthetic_agents: [] } });
    }
    if (pathname === '/api/config/agent-tank/status') {
      return route.fulfill({ json: { available: true } });
    }
    if (pathname === '/api/notifications/unread-count') {
      return route.fulfill({ json: { unreadCount: 0 } });
    }
    if (pathname === '/api/notifications') {
      return route.fulfill({ json: { notifications: [], unreadCount: 0, nextCursor: null } });
    }
    return route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'Unavailable in layout fixture' }),
    });
  });
}

async function box(locator: Locator) {
  const value = await locator.boundingBox();
  expect(value).not.toBeNull();
  return value!;
}

async function expectAlignedPane(
  pane: Locator,
  header: Locator,
  content: Locator,
): Promise<void> {
  const [paneBox, headerBox, contentBox] = await Promise.all([
    box(pane),
    box(header),
    box(content),
  ]);
  expect(Math.abs(headerBox.x - paneBox.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(contentBox.x - paneBox.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(headerBox.x + headerBox.width - (paneBox.x + paneBox.width))).toBeLessThanOrEqual(1);
  expect(Math.abs(contentBox.x + contentBox.width - (paneBox.x + paneBox.width))).toBeLessThanOrEqual(1);
}

for (const fixture of [
  { name: 'desktop web', width: 1440, height: 900, electron: false, dragBy: 150 },
  { name: 'Electron minimum window', width: 880, height: 620, electron: true, dragBy: 70 },
] as const) {
  test(`${fixture.name} keeps pane geometry, scrolling, actions, and drafts stable at unequal splits`, async ({ page }) => {
    await page.setViewportSize({ width: fixture.width, height: fixture.height });
    if (fixture.electron) await installDesktopPresentation(page);
    await stubWorkspaceApis(page);
    await page.goto('/ai-agents');

    const group = page.getByTestId('ai-agents-panel-group');
    const configurationPane = page.getByTestId('ai-agents-configuration-pane');
    const configurationHeader = configurationPane.locator('.ai-agents-pane-header');
    const configurationScroll = page.getByTestId('ai-agents-configuration-scroll');
    const playgroundPane = page.getByTestId('ai-agents-playground-pane');
    const playgroundHeader = playgroundPane.locator('.ai-agents-pane-header');
    const playgroundContent = page.getByTestId('ai-agents-playground-content');
    const handle = page.getByTestId('ai-agents-resize-handle');
    const addButton = configurationPane.getByRole('button', { name: '+ Add Agent' });
    const composer = playgroundPane.getByPlaceholder('Type a message to test...');

    await expect(group).toBeVisible();
    await expect(composer).toBeEnabled();
    await expectAlignedPane(configurationPane, configurationHeader, configurationScroll);
    await expectAlignedPane(playgroundPane, playgroundHeader, playgroundContent);

    const [groupBoxBefore, configurationBoxBefore, handleBoxBefore] = await Promise.all([
      box(group),
      box(configurationPane),
      box(handle),
    ]);
    expect(configurationBoxBefore.width / groupBoxBefore.width).toBeGreaterThan(0.35);
    expect(configurationBoxBefore.width / groupBoxBefore.width).toBeLessThan(0.45);
    const narrowOverflow = await configurationScroll.evaluate(element => ({
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
    }));
    expect(narrowOverflow.scrollWidth).toBeLessThanOrEqual(narrowOverflow.clientWidth + 1);

    await composer.fill('Keep this playground draft while resizing');
    await page.mouse.move(handleBoxBefore.x + handleBoxBefore.width / 2, handleBoxBefore.y + 80);
    await page.mouse.down();
    await page.mouse.move(
      handleBoxBefore.x + handleBoxBefore.width / 2 + fixture.dragBy,
      handleBoxBefore.y + 80,
      { steps: 8 },
    );
    await page.mouse.up();

    const [configurationBoxAfter, handleBoxAfter] = await Promise.all([
      box(configurationPane),
      box(handle),
    ]);
    expect(handleBoxAfter.x - handleBoxBefore.x).toBeGreaterThan(fixture.dragBy / 2);
    expect(configurationBoxAfter.width / groupBoxBefore.width).toBeGreaterThan(0.45);
    await expect(composer).toHaveValue('Keep this playground draft while resizing');
    await expectAlignedPane(configurationPane, configurationHeader, configurationScroll);
    await expectAlignedPane(playgroundPane, playgroundHeader, playgroundContent);

    const headerTopBeforeScroll = (await box(configurationHeader)).y;
    const scrollState = await configurationScroll.evaluate(element => {
      element.scrollTop = element.scrollHeight;
      return {
        clientHeight: element.clientHeight,
        scrollHeight: element.scrollHeight,
        scrollTop: element.scrollTop,
      };
    });
    expect(scrollState.scrollHeight).toBeGreaterThan(scrollState.clientHeight);
    expect(scrollState.scrollTop).toBeGreaterThan(0);
    expect(Math.abs((await box(configurationHeader)).y - headerTopBeforeScroll)).toBeLessThanOrEqual(1);
    await expect(addButton).toBeVisible();
    const [addBox, headerBox] = await Promise.all([box(addButton), box(configurationHeader)]);
    expect(addBox.x).toBeGreaterThanOrEqual(headerBox.x);
    expect(addBox.x + addBox.width).toBeLessThanOrEqual(headerBox.x + headerBox.width + 1);

    await addButton.click();
    const aliasDraft = page.getByLabel('ID / Alias');
    await aliasDraft.fill('resize-draft');
    const handleXBeforeKeyboardResize = (await box(handle)).x;
    await handle.press('ArrowLeft');
    expect(Math.abs((await box(handle)).x - handleXBeforeKeyboardResize)).toBeGreaterThan(1);
    await expect(aliasDraft).toHaveValue('resize-draft');
    await expect(composer).toHaveValue('Keep this playground draft while resizing');
  });
}
