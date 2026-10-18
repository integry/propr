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
  // On desktop the launcher floats at the window's lower-right corner, where the Playground composer ends.
  { name: 'web desktop 1280x800 with Voice briefing', size: { width: 1280, height: 800 }, voice: true },
  { name: 'native Linux desktop 1280x800 with Voice briefing', size: { width: 1280, height: 800 }, shell: { platform: 'linux' }, voice: true },
  { name: 'native Linux maximized desktop 1024x600 with Voice briefing', size: { width: 1024, height: 600 }, shell: { platform: 'linux', expanded: true }, voice: true },
  { name: 'web desktop 768x420 with Voice briefing', size: { width: 768, height: 420 }, voice: true },
];

const desktopProfile = { id: 'composer-fixture', name: 'Preview workspace', kind: 'remote' as const, baseUrl: 'https://fixture.example.test' };

/** A controlled desktop bridge with a synthetic workspace; it never reaches a real instance. */
async function installDesktopBridge(page: Page, platform: 'linux' | 'macos') {
  await page.addInitScript(({ platform, profile }) => {
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
  }, { platform, profile: desktopProfile });
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

/** The floating Voice briefing launcher is shown and operable across its straight middle band (it is a pill). */
async function expectLauncherOperable(page: Page) {
  const launcher = page.getByRole('button', { name: 'Voice briefing' });
  await expect(launcher).toBeVisible();
  expect(await launcher.evaluate(element => {
    const rect = element.getBoundingClientRect();
    return [0.25, 0.5, 0.75].flatMap(fx => [0.2, 0.5, 0.8].map(fy => {
      const hit = document.elementFromPoint(rect.left + rect.width * fx, rect.top + rect.height * fy);
      return Boolean(hit && element.contains(hit));
    }));
  })).not.toContain(false);
  return launcher;
}

async function openPlayground(page: Page, baseURL: string, size: { width: number; height: number }, shell?: Shell, voice?: boolean) {
  if (shell?.platform) {
    await installDesktopBridge(page, shell.platform);
    await installWindowActions(page, shell);
  }
  if (voice) {
    // The opt-in belongs to the instance the app is signed in to: in the shell, the workspace's own URL.
    await page.addInitScript(
      key => localStorage.setItem(key, 'true'),
      browserVoicePreferenceKey(shell?.platform ? desktopProfile.baseUrl : new URL(baseURL).origin, user.id),
    );
  }
  const prompts = await stubApis(page);
  await page.setViewportSize(size);
  await page.goto('/ai-agents');
  return prompts;
}

for (const { name, size, shell, voice } of cases) {
  test(`${name}: the Playground composer stays above the mobile navigation and sends`, async ({ page, baseURL }) => {
    const prompts = await openPlayground(page, baseURL!, size, shell, voice);

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
      // The floating launcher stays operable, wholly below or (in a short panel) beside the composer.
      const launcherBox = (await (await expectLauncherOperable(page)).boundingBox())!;
      const sendBox = (await send.boundingBox())!;
      expect(sendBox.y + sendBox.height <= launcherBox.y || sendBox.x + sendBox.width <= launcherBox.x).toBe(true);
    }
    // Model selection stays usable beside the composer, and its list opens over it.
    await expectUnobscured(page, clear);
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

/**
 * Waits for the responsive layout to finish switching: the mobile Playground panel is the shown one, and across
 * consecutive samples its box is unchanged and no finite animation or transition (the sidebar sliding away) runs.
 */
async function settleMobileLayout(page: Page) {
  await expect(page.getByRole('navigation', { name: 'Primary navigation' })).toBeVisible();
  await expect(visible(page.getByRole('button', { name: 'Playground', exact: true }))).toBeVisible();
  await expect(visible(page.getByTestId('ai-agents-playground-panel'))).toHaveCount(1);
  let previous = '';
  let quietSamples = 0;
  await expect.poll(async () => {
    const state = await page.evaluate(() => {
      const panel = [...document.querySelectorAll('[data-testid="ai-agents-playground-panel"]')]
        .find(element => element.getBoundingClientRect().height > 0);
      const moving = document.getAnimations().some(animation => animation.playState === 'running'
        && animation.effect?.getComputedTiming().iterations !== Infinity);
      return moving ? null : JSON.stringify(panel?.getBoundingClientRect());
    });
    quietSamples = state && state === previous ? quietSamples + 1 : 0;
    previous = state ?? '';
    return quietSamples;
  }, { intervals: [50] }).toBeGreaterThanOrEqual(3);
}

const resizeCases: Array<{ name: string; shell?: Shell; voice?: boolean }> = [
  { name: 'native Linux', shell: { platform: 'linux' } },
  { name: 'native Linux with Voice briefing', shell: { platform: 'linux' }, voice: true },
  { name: 'web with Voice briefing', voice: true },
];

for (const { name, shell, voice } of resizeCases) {
  test(`${name}: a desktop conversation survives a resize to 370x345 and keeps sending`, async ({ page, baseURL }) => {
    const prompts = await openPlayground(page, baseURL!, { width: 1280, height: 800 }, shell, voice);
    const input = visible(page.getByPlaceholder('Type a message to test...'));
    const send = visible(page.getByRole('button', { name: 'Send message' }));
    const search = visible(page.getByRole('combobox', { name: 'Search and add models to compare' }));
    const transcript = visible(page.getByTestId('ai-agents-playground-transcript'));
    const models = ['Claude Code: Claude Opus 5.5', 'Claude Code: Claude Sonnet 5.5'];
    const expectModels = async () => {
      for (const model of models) {
        await expect(visible(page.getByRole('button', { name: model, exact: true }))).toHaveAttribute('aria-pressed', 'true');
      }
    };

    // A desktop conversation: two selected models, one exchange and an unsent draft.
    await expect(visible(page.getByRole('button', { name: models[0], exact: true }))).toHaveAttribute('aria-pressed', 'true');
    await search.click();
    await search.fill('Sonnet');
    await visible(page.getByRole('option', { name: /Claude Sonnet 5\.5/ })).click();
    await page.keyboard.press('Escape');
    await search.blur();
    await expectModels();
    await input.fill('Desktop question');
    // Sent at desktop size with a normal pointer click on the lower part of Send, clear of any launcher.
    await expectUnobscured(page, input);
    await expectUnobscured(page, send);
    if (voice) await expectLauncherOperable(page);
    const desktopBox = (await send.boundingBox())!;
    await page.mouse.click(desktopBox.x + desktopBox.width / 2, desktopBox.y + desktopBox.height * 0.9);
    await expect(transcript.getByText('Controlled reply')).toHaveCount(2);
    await input.fill('Desktop draft');

    // Resize to the short native viewport, and judge hit targets only once the mobile layout has settled.
    await page.setViewportSize({ width: 370, height: 345 });
    await settleMobileLayout(page);
    await expect(input).toHaveValue('Desktop draft');
    await expect(transcript.getByText('Desktop question')).toHaveCount(1);
    await expect(transcript.getByText('Controlled reply')).toHaveCount(2);
    await expectModels();
    await expectUnobscured(page, input);
    await expectUnobscured(page, send);
    await expectUnobscured(page, visible(page.getByTitle('Clear History')));
    if (voice) await expectLauncherOperable(page);

    await expectUnobscured(page, search);
    await search.click();
    const listbox = page.getByRole('listbox', { name: 'Available models' });
    await expectUnobscured(page, listbox);
    await expect(listbox.getByRole('option')).toHaveCount(2);
    await page.keyboard.press('Escape');
    await search.blur();
    await expect(listbox).toHaveCount(0);

    const box = (await send.boundingBox())!;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height * 0.9);
    await expect(transcript.getByText('Controlled reply')).toHaveCount(4);
    // The new exchange's first reply (model replies sit side by side and scroll sideways).
    await expect(transcript.getByText('Controlled reply').nth(2)).toBeInViewport();
    expect(prompts).toEqual(['Desktop question', 'Desktop draft']);
    await expect(input).toHaveValue('');
    await expectModels();
    await expectUnobscured(page, input);
    await expectUnobscured(page, send);
  });
}

/** Waits until the Playground pane's box is unchanged across consecutive samples and no finite animation runs. */
async function settlePane(page: Page) {
  const pane = page.getByTestId('ai-agents-playground-pane');
  let previous = '';
  let quietSamples = 0;
  await expect.poll(async () => {
    const state = await pane.evaluate(element => {
      const moving = document.getAnimations().some(animation => animation.playState === 'running'
        && animation.effect?.getComputedTiming().iterations !== Infinity);
      return moving ? null : JSON.stringify(element.getBoundingClientRect());
    });
    quietSamples = state && state === previous ? quietSamples + 1 : 0;
    previous = state ?? '';
    return quietSamples;
  }, { intervals: [50] }).toBeGreaterThanOrEqual(3);
  return (await pane.boundingBox())!;
}

const minimumSplitCases: Array<{ name: string; size: { width: number; height: number }; shell?: Shell; voice?: boolean }> = [
  // The narrowest supported Playground pane is also short here, too short to stack the composer above the launcher.
  { name: 'web 768x420 with Voice briefing', size: { width: 768, height: 420 }, voice: true },
  { name: 'native Linux 768x420 with Voice briefing', size: { width: 768, height: 420 }, shell: { platform: 'linux' }, voice: true },
  { name: 'web 768x420', size: { width: 768, height: 420 } },
  { name: 'web 880x620 with Voice briefing', size: { width: 880, height: 620 }, voice: true },
  { name: 'web 1024x600 with Voice briefing', size: { width: 1024, height: 600 }, voice: true },
  { name: 'web 1280x800 with Voice briefing', size: { width: 1280, height: 800 }, voice: true },
];

for (const { name, size, shell, voice } of minimumSplitCases) {
  test(`${name}: at the minimum Playground split the full composer and model controls stay usable and send`, async ({ page, baseURL }) => {
    const prompts = await openPlayground(page, baseURL!, size, shell, voice);
    const input = visible(page.getByPlaceholder('Type a message to test...'));
    const send = visible(page.getByRole('button', { name: 'Send message' }));
    const model = visible(page.getByRole('button', { name: 'Claude Code: Claude Opus 5.5', exact: true }));
    await expect(model).toHaveAttribute('aria-pressed', 'true');
    await input.fill('Narrow draft');
    const before = await settlePane(page);

    // The normal keyboard resize to the Playground's supported minimum size.
    const handle = page.getByTestId('ai-agents-resize-handle');
    await handle.focus();
    await page.keyboard.press('End');
    const pane = await settlePane(page);
    const capture = process.env.PROPR_CAPTURE_PREVIEWS && name === 'web 768x420 with Voice briefing';
    if (capture) await page.screenshot({ path: '../.propr/previews/playground-minimum-split-768x420-voice.png' });
    expect(pane.width).toBeLessThan(before.width);
    const group = (await page.getByTestId('ai-agents-panel-group').boundingBox())!;
    expect(pane.width / group.width).toBeGreaterThan(0.28);
    expect(pane.width / group.width).toBeLessThan(0.32);
    await expect(input).toHaveValue('Narrow draft');

    // The whole input and Send, not a sliver of each, and the model controls above them.
    expect((await input.boundingBox())!.width).toBeGreaterThanOrEqual(80);
    await expectUnobscured(page, input);
    await expectUnobscured(page, send);
    // The selected-model chip strip scrolls sideways in a narrow pane; its shown part stays hittable.
    expect(await model.evaluate(element => {
      const rect = element.getBoundingClientRect();
      const strip = element.parentElement!.getBoundingClientRect();
      const left = Math.max(rect.left, strip.left);
      const right = Math.min(rect.right, strip.right);
      return [0.25, 0.5, 0.75].flatMap(fx => [0.5, 0.9].map(fy => {
        const hit = document.elementFromPoint(left + (right - left) * fx, rect.top + rect.height * fy);
        return Boolean(hit && element.contains(hit));
      }));
    })).not.toContain(false);
    const clear = visible(page.getByTitle('Clear History'));
    await expectUnobscured(page, clear);
    const search = visible(page.getByRole('combobox', { name: 'Search and add models to compare' }));
    await expectUnobscured(page, search);
    if (voice) {
      const launcherBox = (await (await expectLauncherOperable(page)).boundingBox())!;
      const sendBox = (await send.boundingBox())!;
      expect(sendBox.y + sendBox.height <= launcherBox.y || sendBox.x + sendBox.width <= launcherBox.x).toBe(true);
    } else {
      // Without the launcher no room is held back for it.
      const composer = page.locator('.launcher-docked-composer').filter({ visible: true });
      expect(await composer.evaluate(element => getComputedStyle(element).paddingRight)).toBe('16px');
      expect(await composer.evaluate(element => getComputedStyle(element).paddingBottom)).toBe('16px');
    }
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
    expect(prompts).toEqual(['Narrow draft']);
    await expect(input).toHaveValue('');
    await expectUnobscured(page, input);
    await expectUnobscured(page, send);
    await expect(model).toHaveAttribute('aria-pressed', 'true');
    if (voice) await expectLauncherOperable(page);
  });
}
