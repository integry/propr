/** Shared checks that app dialogs stay below the desktop titlebar and leave its native window controls usable. */
import { expect, type Locator, type Page } from '@playwright/test';

export const controlNames = ['Application menu', 'Minimize window', 'Maximize or restore window', 'Close window'] as const;

export interface Shell { platform?: 'linux' | 'macos'; expanded?: boolean }

export const shells: Array<{ name: string } & Shell> = [
  { name: 'linux-restored', platform: 'linux' },
  { name: 'linux-maximized', platform: 'linux', expanded: true },
  { name: 'macos', platform: 'macos' },
];

/**
 * Records the native bridge's window actions instead of moving a real window, and sets the Linux preload's frame
 * state. Call after the fixture that installs `window.__PROPR_DESKTOP__`.
 */
export async function installWindowActions(page: Page, shell: Shell) {
  if (!shell.platform) return;
  await page.addInitScript(({ platform, expanded }) => {
    const calls: string[] = [];
    Object.assign(window, { __windowCalls: calls });
    const record = (name: string) => async () => { calls.push(name); };
    Object.assign(window.__PROPR_DESKTOP__!.app, {
      minimize: record('minimize'), toggleMaximize: record('toggleMaximize'), closeWindow: record('closeWindow'),
      showApplicationMenu: async () => { calls.push('showApplicationMenu'); },
    });
    // The production frame CSS keys off these attributes.
    if (platform === 'linux') document.addEventListener('DOMContentLoaded', () => {
      Object.assign(document.documentElement.dataset, { desktopWindow: 'linux', windowFocused: 'true', windowExpanded: String(expanded) });
    });
  }, { platform: shell.platform, expanded: Boolean(shell.expanded) });
}

/**
 * Every sampled point of the element (corners, edge midpoints, centre) hit-tests to the element itself. Corners are
 * sampled just inside its rounded shape (hit testing follows border-radius) or `minInset` px in, whichever is deeper.
 */
export async function strayPoints(locator: Locator, minInset = 1): Promise<string[]> {
  return locator.evaluate((element, minInset) => {
    const box = element.getBoundingClientRect();
    const radius = parseFloat(getComputedStyle(element).borderTopLeftRadius) || 0;
    const inset = Math.max(minInset, Math.ceil(radius * (1 - Math.SQRT1_2)) + 1);
    const xs = [box.left + inset, box.left + box.width / 2, box.right - inset];
    const ys = [box.top + inset, box.top + box.height / 2, box.bottom - inset];
    const stray: string[] = [];
    for (const x of xs) for (const y of ys) {
      const hit = document.elementFromPoint(x, y);
      if (!hit || !element.contains(hit)) {
        const owner = hit?.closest('[aria-label]')?.getAttribute('aria-label') ?? (hit ? `${hit.tagName}.${hit.className}` : 'nothing');
        stray.push(`${Math.round(x)},${Math.round(y)} -> ${owner}`);
      }
    }
    return stray;
  }, minInset);
}

/**
 * The app's own inert regions (a hidden pane or sheet). Closing a dialog leaves no part of the app inert that was not
 * already; the app may show one of its own (the phone's compact bar after a scroll) meanwhile.
 */
export const inertRegions = (page: Page) => page.evaluate(() => Array.from(document.querySelectorAll('[inert]'), element => element.outerHTML.slice(0, 120)));

export const inert = (locator: Locator) => locator.evaluate(element => element.matches('[inert], [inert] *'));

/**
 * The dialog keeps clear of the titlebar row and of every window control; its close control owns all of its points
 * and is at least `minSize` px square.
 */
export async function expectClearOfChrome(page: Page, dialog: Locator, close: Locator, shell: Shell, minSize = 44) {
  await expect(close).toBeVisible();
  const closeBox = (await close.boundingBox())!;
  expect(closeBox.width).toBeGreaterThanOrEqual(minSize);
  expect(closeBox.height).toBeGreaterThanOrEqual(minSize);
  expect(await strayPoints(close)).toEqual([]);
  const layer = await dialog.evaluate(element => {
    const box = element.parentElement!.getBoundingClientRect();
    return { top: box.top, bottom: window.innerHeight - box.bottom };
  });
  const dialogBox = (await dialog.boundingBox())!;
  // The dialog never spills out of its layer, so no part of it reaches the titlebar or past the window's bottom.
  expect(dialogBox.y).toBeGreaterThanOrEqual(layer.top);
  expect(dialogBox.y + dialogBox.height).toBeLessThanOrEqual(page.viewportSize()!.height - layer.bottom + 0.5);
  if (!shell.platform) {
    // Ordinary web/mobile UI reserves no titlebar.
    expect(layer.top).toBe(0);
    return;
  }
  // The native titlebar row (Linux controls, macOS traffic lights) belongs to the window, not the dialog.
  expect(layer.top).toBe(44);
  expect(closeBox.y).toBeGreaterThanOrEqual(44);
  expect(await page.evaluate(() => {
    const hit = document.elementFromPoint(window.innerWidth / 2, 22);
    return Boolean(hit?.closest('[role="dialog"]'));
  })).toBe(false);
  if (shell.platform !== 'linux') return;

  const controls = page.getByRole('group', { name: 'Window controls' });
  await expect(controls).toBeVisible();
  expect(await inert(controls)).toBe(false);
  const controlsBox = (await controls.boundingBox())!;
  expect(controlsBox.y + controlsBox.height).toBeLessThanOrEqual(dialogBox.y);
  for (const name of controlNames) {
    const control = controls.getByRole('button', { name });
    await expect(control).toBeVisible();
    expect(await inert(control), name).toBe(false);
    // The restored frame rounds the window's top-right corner, so its last pixels belong to the desktop.
    expect(await strayPoints(control, 3), name).toEqual([]);
  }
}

/** Each window control dispatches its own native action while the dialog stays open; nothing reaches the dialog. */
export async function expectControlsDispatch(page: Page, dialog: Locator) {
  const controls = page.getByRole('group', { name: 'Window controls' });
  await page.evaluate(() => { (window as unknown as { __windowCalls: string[] }).__windowCalls.length = 0; });
  for (const name of controlNames) await controls.getByRole('button', { name }).click();
  expect(await page.evaluate(() => (window as unknown as { __windowCalls: string[] }).__windowCalls))
    .toEqual(['showApplicationMenu', 'minimize', 'toggleMaximize', 'closeWindow']);
  await expect(dialog).toBeVisible();
}

/** The workspace behind the dialog is inert, and keyboard focus never reaches it in either Tab direction. */
export async function expectWorkspaceInert(page: Page, dialog: Locator, workspace: Locator[]) {
  for (const part of workspace) expect(await inert(part.first())).toBe(true);
  for (const key of ['Tab', 'Shift+Tab']) {
    for (let step = 0; step < 8; step += 1) {
      await page.keyboard.press(key);
      expect(await page.evaluate(() => {
        const active = document.activeElement;
        return !active || active === document.body
          || Boolean(active.closest('[role="dialog"], [data-window-chrome]'));
      }), `${key} ${step}`).toBe(true);
    }
  }
  await expect(dialog).toBeVisible();
}
