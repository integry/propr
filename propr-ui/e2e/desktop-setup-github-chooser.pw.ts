import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

// The production renderer's local-setup GitHub chooser, opened through the real desktop entry with an
// injected bridge. This is a renderer fixture: it does not exercise Electron, OAuth or signed packages.
const username = 'octo-long-account-name-for-touch';
const organisation = 'integry-enterprise-platform-team';
const actions = ['Refresh installations', 'Install GitHub App', 'Change GitHub account'];
const directory = path.resolve('../.propr/previews');

async function fixture(page: Page, options: { textScale?: number } = {}) {
  await page.addInitScript(({ username, organisation }) => {
    const decisions: unknown[] = [];
    let release: (() => void) | undefined;
    const identity = (status: string) => ({
      status, username, installAvailable: true,
      permissionExplanation: `@${username} cannot enroll the selected installation yet. Ask an organisation owner to grant access, then refresh the list or change account.`,
      installations: [
        { installationId: '41022391', accountLogin: organisation, accountType: 'Organization' },
        { installationId: '41022392', accountLogin: username, accountType: 'User' },
      ],
    });
    const snapshot = (status: string) => ({
      phase: 'running', capability: { supported: true, kind: 'local', platform: 'linux' },
      sessionId: '11111111-1111-4111-8111-111111111111', logs: [],
      state: { steps: [{ id: 'github-auth', title: 'Connect GitHub', description: 'Choose an installation', status: 'active' }] },
      githubIdentity: identity(status),
    });
    Object.assign(window, {
      __setupDecisions: decisions,
      __releaseSetupDecision: () => release?.(),
      __PROPR_DESKTOP__: {
        isDesktop: true, platform: 'linux',
        app: { onDeepLink: () => () => undefined },
        profiles: { list: async () => [], getActiveId: async () => null, setActiveId: async () => undefined, save: async () => undefined, remove: async () => undefined },
        connection: { probe: async () => ({ status: 'ready' }) },
        authentication: { authenticate: async () => undefined },
        discovery: { supported: false, discover: async () => [] },
        externalBrowser: { open: async () => undefined },
        localSetup: {
          supported: true,
          status: async () => snapshot('selection-required'),
          start: async () => snapshot('selection-required'),
          retry: async () => snapshot('selection-required'),
          cancel: async () => ({ ...snapshot('selection-required'), phase: 'cancelled' }),
          selectPrivateKey: async () => null,
          acquireWebhookSecret: async () => null,
          onProgress: () => () => undefined,
          // Each decision stays pending until the test releases it, so a second activation would be recorded.
          resolveGithubInstallation: async (decision: { action: string }) => {
            decisions.push(decision);
            await new Promise<void>(resolve => { release = resolve; });
            return snapshot(decision.action === 'reauthenticate' ? 'reauthenticating' : 'selection-required');
          },
        },
      },
    });
  }, { username, organisation });
  await page.goto('/');
  if (options.textScale) await page.addStyleTag({ content: `html { font-size: ${options.textScale * 100}%; }` });
  await page.getByRole('button', { name: /Set up this computer/ }).click();
  await expect(page.getByRole('heading', { name: 'Choose a GitHub App installation' })).toBeVisible();
}

const decisions = (page: Page) => page.evaluate(() => (window as unknown as { __setupDecisions: unknown[] }).__setupDecisions);
const releaseDecision = (page: Page) => page.evaluate(() => (window as unknown as { __releaseSetupDecision(): void }).__releaseSetupDecision());

async function expectComfortableLayout(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const choice = page.locator('.desktop-github-choice');
  // The primary reads "Continue with selection" or "Updating…" while a decision is pending.
  const buttons = [...actions.map(name => [name, choice.getByRole('button', { name, exact: true })] as const),
    ['primary', choice.locator('.desktop-primary-button')] as const];
  for (const [name, button] of buttons) {
    await expect(button).toBeVisible();
    const geometry = await button.evaluate(element => {
      const box = element.getBoundingClientRect();
      return { height: box.height, right: box.right, clipped: element.scrollWidth > element.clientWidth || element.scrollHeight > element.clientHeight };
    });
    expect(geometry.height, name).toBeGreaterThanOrEqual(44);
    expect(geometry.right, name).toBeLessThanOrEqual(await page.evaluate(() => innerWidth));
    expect(geometry.clipped, name).toBe(false);
  }
  // Account and installation identity stay readable rather than truncated.
  for (const text of [`@${username}`, organisation]) {
    const identity = page.getByText(text, { exact: true }).first();
    await expect(identity).toBeVisible();
    expect(await identity.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  }
  const recovery = page.getByRole('alert').filter({ hasText: 'cannot enroll the selected installation' });
  expect((await recovery.boundingBox())!.height).toBeGreaterThan(30);
}

// Any Chromium screenshot resets touch emulation, so capture only as the last step of a test.
async function capture(page: Page, name: string) {
  if (!process.env.PROPR_CAPTURE_PREVIEWS) return;
  await mkdir(directory, { recursive: true });
  // Tall enough that the capture is not stitched under the fixed titlebar region.
  await page.setViewportSize({ width: page.viewportSize()!.width, height: 2400 });
  await page.locator('.desktop-setup-wizard').screenshot({ path: path.join(directory, `${name}.png`) });
}

for (const { width, textScale } of [{ width: 320 }, { width: 390 }, { width: 390, textScale: 1.5 }, { width: 880 }]) {
  test.describe(`touch layout at ${width}px${textScale ? ` with ${textScale * 100}% text` : ''}`, () => {
    test.use({ viewport: { width, height: 844 }, hasTouch: true, isMobile: true });

    test('every chooser action is a 44px target without overflow and touch fires one decision', async ({ page }) => {
      await fixture(page, { textScale });
      expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);
      await expectComfortableLayout(page);
      const change = page.getByRole('button', { name: 'Change GitHub account', exact: true });
      await change.tap();
      await expect(change).toBeDisabled();
      await change.tap({ force: true });
      expect(await decisions(page)).toEqual([{ action: 'reauthenticate' }]);
      await releaseDecision(page);
      await expect(page.getByText('Waiting for GitHub sign-in in your browser.', { exact: false })).toBeVisible();
      // Selection stays disabled while the account change is pending.
      for (const radio of await page.getByRole('radio').all()) await expect(radio).toBeDisabled();
      for (const name of actions) await expect(page.getByRole('button', { name, exact: true })).toBeDisabled();
      await expectComfortableLayout(page);
      await capture(page, `setup-github-chooser-${width}${textScale ? '-large-text' : ''}-pending`);
    });

    test('captures the ready chooser', async ({ page }) => {
      test.skip(!process.env.PROPR_CAPTURE_PREVIEWS, 'Preview capture only');
      await fixture(page, { textScale });
      expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);
      await expectComfortableLayout(page);
      await capture(page, `setup-github-chooser-${width}${textScale ? '-large-text' : ''}`);
    });
  });
}

test('narrow fine-pointer layout keeps 44px targets and keyboard activation fires once', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await fixture(page);
  expect(await page.evaluate(() => matchMedia('(pointer: fine)').matches)).toBe(true);
  await expectComfortableLayout(page);
  const refresh = page.getByRole('button', { name: 'Refresh installations', exact: true });
  await refresh.focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Space');
  await page.keyboard.press('Enter');
  expect(await decisions(page)).toEqual([{ action: 'refresh' }]);
  await releaseDecision(page);
  await expect(refresh).toBeEnabled();
});

test('wide desktop pointer layout keeps the compact action row', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await fixture(page);
  const boxes = await Promise.all(actions.map(name => page.getByRole('button', { name, exact: true }).boundingBox()));
  // Compact secondary-button metrics on one row, unchanged from the pre-touch layout.
  for (const box of boxes) expect(box!.height).toBeLessThan(44);
  expect(new Set(boxes.map(box => Math.round(box!.y))).size).toBe(1);
  await capture(page, 'setup-github-chooser-1280');
  await page.getByRole('button', { name: 'Install GitHub App', exact: true }).click();
  expect(await decisions(page)).toEqual([{ action: 'install' }]);
});
