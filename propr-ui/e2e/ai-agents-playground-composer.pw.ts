import { expect, test, type Locator, type Page } from '@playwright/test';
import { browserVoicePreferenceKey } from '../src/voice/voicePreferenceKey';
import { installWindowActions, strayPoints, type Shell } from './native-chrome.fixture';

// Run in both engines with `npm run test:browser -- e2e/ai-agents-playground-composer.pw.ts`, once with the default
// Chromium config and once with a config whose `browserName` is 'webkit'. Provider replies are stubbed.

const user = {
  id: 'playground-composer-admin',
  login: 'playground-composer-admin',
  username: 'playground-composer-admin',
  displayName: 'Playground Composer Admin',
  email: null,
  avatarUrl: null,
  role: 'admin',
  permissions: ['instance.manage_agents'],
  authorizationSource: 'local',
};

const agents = [{
  id: 'claude-playground',
  type: 'claude',
  alias: 'Claude Code',
  enabled: true,
  dockerImage: 'propr/agent:latest',
  configPath: '/agents/claude-playground',
  defaultModel: 'claude-opus-5-5',
  supportedModels: ['claude-opus-5-5', 'claude-sonnet-5-5'],
}];

const cases: Array<{ name: string; size: { width: number; height: number }; shell?: Shell; voice?: boolean }> = [
  // The signed Linux app at 880x820 zoomed until the renderer was 370x345 CSS px.
  { name: 'native Linux 370x345', size: { width: 370, height: 345 }, shell: { platform: 'linux' } },
  { name: 'native Linux maximized 370x345', size: { width: 370, height: 345 }, shell: { platform: 'linux', expanded: true } },
  { name: 'native macOS 370x345', size: { width: 370, height: 345 }, shell: { platform: 'macos' } },
  { name: 'web 370x345', size: { width: 370, height: 345 } },
  // The opt-in floating Voice briefing launcher sits just above the navigation.
  { name: 'web 370x345 with Voice briefing', size: { width: 370, height: 345 }, voice: true },
  { name: 'web 320x568 with Voice briefing', size: { width: 320, height: 568 }, voice: true },
  { name: 'web 320x400', size: { width: 320, height: 400 } },
  { name: 'web 320x720', size: { width: 320, height: 720 } },
  { name: 'web 390x844', size: { width: 390, height: 844 } },
  { name: 'web desktop 1280x800', size: { width: 1280, height: 800 } },
];

/** A controlled desktop bridge with a synthetic workspace; it never reaches a real instance. */
async function installDesktopBridge(page: Page, platform: 'linux' | 'macos') {
  await page.addInitScript(platform => {
    const profile = { id: 'composer-fixture', name: 'Preview workspace', kind: 'remote' as const, baseUrl: 'https://fixture.example.test' };
    window.__PROPR_DESKTOP__ = {
      isDesktop: true, platform,
      app: { onDeepLink: () => () => undefined },
      profiles: { list: async () => [profile], getActiveId: async () => profile.id, setActiveId: async () => undefined, save: async () => undefined, remove: async () => undefined },
      connection: { probe: async () => ({ status: 'ready' }) },
      authentication: { authenticate: async () => undefined },
      discovery: { supported: false, discover: async () => [] },
      localSetup: { supported: false, setup: async () => profile },
      externalBrowser: { open: async () => undefined },
    };
  }, platform);
}

async function stubApis(page: Page) {
  const prompts: string[] = [];
  await page.route('**/api/**', async route => {
    const pathname = new URL(route.request().url()).pathname;
    const responses: Record<string, unknown> = {
      '/api/auth/demo-mode': { demoMode: false },
      '/api/auth/user': user,
      '/api/config/agents': { agents },
      '/api/config/synthetic-agents': { synthetic_agents: [] },
      '/api/config/agent-tank/status': { available: false },
      '/api/notifications/unread-count': { unreadCount: 0 },
      '/api/notifications': { notifications: [], unreadCount: 0, nextCursor: null },
    };
    if (pathname in responses) return route.fulfill({ json: responses[pathname] });
    if (/^\/api\/agents\/[^/]+\/health$/.test(pathname)) {
      return route.fulfill({ json: { agentId: pathname.split('/')[3], status: 'ready', model: 'claude-opus-5-5' } });
    }
    return route.fulfill({ status: 503, json: { error: 'Unavailable in Playground composer test' } });
  });
  await page.route('**/api/agents/chat', async route => {
    const request = route.request().postDataJSON() as { prompt: string; queries: Array<{ agentId: string; model: string }> };
    prompts.push(request.prompt);
    await route.fulfill({
      json: {
        results: request.queries.map(query => ({
          agentId: query.agentId, agentAlias: 'Claude Code', model: query.model, response: 'Controlled reply', durationMs: 12,
        })),
      },
    });
  });
  return prompts;
}

const visible = (locator: Locator) => locator.filter({ visible: true });

/**
 * The control owns every sampled point, including a row just inside its lower edge, and lies wholly above the
 * fixed mobile navigation when that is shown. A bounding box inside the window is not enough: the navigation
 * overlays the page.
 */
async function expectUnobscured(page: Page, control: Locator) {
  await expect(control).toBeVisible();
  expect(await strayPoints(control, 2)).toEqual([]);
  const box = (await control.boundingBox())!;
  const nav = page.getByRole('navigation', { name: 'Primary navigation' });
  if (await nav.isVisible()) expect(box.y + box.height).toBeLessThanOrEqual((await nav.boundingBox())!.y);
  else expect(box.y + box.height).toBeLessThanOrEqual(page.viewportSize()!.height);
  // Interior points near the lower edge, at the 90% line the native report found covered.
  expect(await control.evaluate(element => {
    const rect = element.getBoundingClientRect();
    return [0.1, 0.5, 0.9].flatMap(fx => [0.9, 0.95].map(fy => {
      const hit = document.elementFromPoint(rect.left + rect.width * fx, rect.top + rect.height * fy);
      return Boolean(hit && element.contains(hit));
    }));
  })).not.toContain(false);
}

for (const { name, size, shell, voice } of cases) {
  test(`${name}: the Playground composer stays above the mobile navigation and sends`, async ({ page, baseURL }) => {
    if (shell?.platform) {
      await installDesktopBridge(page, shell.platform);
      await installWindowActions(page, shell);
    }
    if (voice) {
      await page.addInitScript(
        key => localStorage.setItem(key, 'true'),
        browserVoicePreferenceKey(new URL(baseURL!).origin, user.id),
      );
    }
    const prompts = await stubApis(page);
    await page.setViewportSize(size);
    await page.goto('/ai-agents');

    const mobile = size.width < 768;
    const input = visible(page.getByPlaceholder('Type a message to test...'));
    const send = visible(page.getByRole('button', { name: 'Send message' }));
    await expect(visible(page.getByRole('button', { name: 'Claude Code: Claude Opus 5.5', exact: true })))
      .toHaveAttribute('aria-pressed', 'true');
    await input.fill('Composer draft');

    if (mobile) {
      await page.getByRole('button', { name: 'Configuration', exact: true }).click();
      await expect(page.getByTestId('ai-agents-mobile-configuration-scroll')).toBeVisible();
      await page.getByRole('button', { name: 'Playground', exact: true }).click();
    }
    await expect(input).toHaveValue('Composer draft');
    const capture = process.env.PROPR_CAPTURE_PREVIEWS && name === 'native Linux 370x345';
    if (capture) await page.screenshot({ path: '../.propr/previews/playground-composer-draft-native-370x345.png' });

    await expectUnobscured(page, input);
    await expectUnobscured(page, send);
    const clear = visible(page.getByTitle('Clear History'));
    if (voice) {
      // The floating launcher sits in its own band, wholly below the composer.
      const launcher = page.getByRole('button', { name: 'Voice briefing' });
      await expect(launcher).toBeVisible();
      const sendBox = (await send.boundingBox())!;
      expect(sendBox.y + sendBox.height).toBeLessThanOrEqual((await launcher.boundingBox())!.y);
      // Its band leaves too little height for every point of the selector row at 345px, but Clear stays operable.
      expect(await clear.evaluate(element => {
        const rect = element.getBoundingClientRect();
        return element.contains(document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2));
      })).toBe(true);
    } else {
      // Model selection stays usable beside the composer, and its list opens over it.
      await expectUnobscured(page, clear);
    }
    const search = visible(page.getByRole('combobox', { name: 'Search and add models to compare' }));
    await expectUnobscured(page, search);
    await search.click();
    await expectUnobscured(page, page.getByRole('listbox', { name: 'Available models' }));
    await page.keyboard.press('Escape');
    await search.blur();
    await expect(page.getByRole('listbox', { name: 'Available models' })).toHaveCount(0);

    // A normal pointer click on the lower part of Send.
    const box = (await send.boundingBox())!;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height * 0.9);
    const transcript = visible(page.getByTestId('ai-agents-playground-transcript'));
    await expect(transcript.getByText('Controlled reply')).toBeVisible();
    await expect(transcript.getByText('Controlled reply')).toBeInViewport();
    expect(prompts).toEqual(['Composer draft']);
    await expect(input).toHaveValue('');
    await expectUnobscured(page, input);
    await expectUnobscured(page, send);
    await expect(visible(page.getByRole('button', { name: 'Claude Code: Claude Opus 5.5', exact: true })))
      .toHaveAttribute('aria-pressed', 'true');

    const dimensions = await page.evaluate(() => ({
      viewportWidth: window.innerWidth,
      documentWidth: document.documentElement.scrollWidth,
    }));
    expect(dimensions.documentWidth).toBeLessThanOrEqual(dimensions.viewportWidth);
    if (capture) await page.screenshot({ path: '../.propr/previews/playground-composer-reply-native-370x345.png' });
  });
}
