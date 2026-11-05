import { expect, test, type Page } from '@playwright/test';
import { DESKTOP_UI_COMMAND_EVENT } from '../src/desktop/useDesktopNativeCommands';
import { capture, fixture, tasks } from './task-list-desktop.fixture';

// The operator's reproduction: a 1280x820 window is CSS 1224x784; at 207% zoom an
// 880x620 window is CSS 406x286, below `md`, where the desktop toolbar collapses.
const layouts = [
  { name: 'normal', width: 1224, height: 784, deviceScaleFactor: 1.046875 },
  { name: 'zoomed', width: 406, height: 286, deviceScaleFactor: 2.1708 },
  { name: 'narrow', width: 320, height: 568, deviceScaleFactor: 2 },
];

const sendSearch = (page: Page) => page.evaluate(event =>
  window.dispatchEvent(new CustomEvent(event, { detail: 'search', cancelable: true })), DESKTOP_UI_COMMAND_EVENT);

const noDocumentOverflow = (page: Page) => page.evaluate(() => {
  const root = document.documentElement;
  return root.scrollWidth <= root.clientWidth;
});

const openPage = async (page: Page) => {
  await fixture(page, 'linux');
  await page.route('**/api/planner/drafts?**', route => route.fulfill({ json: { drafts: [], total: 0, page: 1, limit: 5, hasMore: false } }));
  await page.goto('/tasks');
  await expect(page.getByRole('main')).toBeVisible();
};

for (const layout of layouts) {
  test(`native Search opens a visible, usable search control at ${layout.name} size`, async ({ browser }) => {
    const { name, ...viewport } = layout;
    const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, deviceScaleFactor: viewport.deviceScaleFactor });
    const page = await context.newPage();
    await openPage(page);
    const toolbar = page.getByRole('banner', { name: 'Application toolbar' });
    const narrow = viewport.width < 768;
    await expect(toolbar).toBeVisible({ visible: !narrow });

    const opener = page.locator('main').getByRole('button').first();
    await opener.focus();
    await sendSearch(page);

    const sheet = page.getByRole('dialog', { name: 'Search' });
    const input = narrow ? sheet.getByRole('combobox', { name: 'Search' }) : toolbar.getByRole('combobox', { name: 'Search' });
    await expect(input).toBeVisible();
    await expect(input).toBeFocused();
    await expect(sheet).toHaveCount(narrow ? 1 : 0);

    await page.keyboard.type('Stop work');
    const palette = page.getByTestId('global-search-palette');
    await expect(palette.getByRole('option').first()).toBeVisible();
    const box = (await palette.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
    expect(await noDocumentOverflow(page)).toBe(true);
    await capture(page, `native-search-${name}`);

    // Escape dismisses safely and returns focus to where the operator was.
    await page.keyboard.press('Escape');
    await expect(palette).toHaveCount(0);
    await expect(sheet).toHaveCount(0);
    if (narrow) {
      await expect(opener).toBeFocused();
      // One press on the dimmed area below the results closes the whole sheet,
      // even though the palette's own backdrop is the element under the pointer.
      await sendSearch(page);
      await page.keyboard.type('Stop work');
      await expect(palette.getByRole('option').first()).toBeVisible();
      await page.mouse.click(viewport.width - 4, viewport.height - 4);
      await expect(sheet).toHaveCount(0);
      await expect(opener).toBeFocused();
      // Without a query the sheet's own backdrop takes the press, with the same result.
      await sendSearch(page);
      await expect(input).toBeVisible();
      await expect(input).toBeFocused();
      await page.mouse.click(viewport.width - 4, viewport.height - 4);
      await expect(sheet).toHaveCount(0);
      await expect(opener).toBeFocused();
    }

    // Ctrl+K takes the same route, and choosing a result navigates.
    await page.keyboard.press('Control+k');
    await expect(input).toBeFocused();
    await input.fill('Stop work');
    await expect(palette.getByRole('option').first()).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(new RegExp(`/tasks/${tasks[0].id}$`));
    await expect(sheet).toHaveCount(0);
    expect(await noDocumentOverflow(page)).toBe(true);
    await context.close();
  });
}

// A press can reach the sheet after it appears but before its field takes focus (the field is
// focused in an effect after the sheet commits). Closing then must still return focus to where
// the operator was, not to the field that is being removed. The press is dispatched from a
// MutationObserver so it lands in exactly that interval on every run.
test('a backdrop press as the narrow Search sheet appears still returns focus', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 320, height: 568 }, deviceScaleFactor: 2 });
  const page = await context.newPage();
  await openPage(page);
  const opener = page.locator('main').getByRole('button').first();
  await opener.focus();
  const pressedBeforeFieldFocus = await page.evaluate(event => new Promise<boolean>(resolve => {
    const observer = new MutationObserver(() => {
      const sheet = document.querySelector('[data-testid="mobile-search-overlay"]');
      if (!sheet) return;
      observer.disconnect();
      const unfocused = !sheet.contains(document.activeElement);
      sheet.firstElementChild!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
      resolve(unfocused);
    });
    observer.observe(document.body, { childList: true, subtree: true });
    window.dispatchEvent(new CustomEvent(event, { detail: 'search', cancelable: true }));
  }), DESKTOP_UI_COMMAND_EVENT);
  expect(pressedBeforeFieldFocus).toBe(true);
  await expect(page.getByRole('dialog', { name: 'Search' })).toHaveCount(0);
  await expect(opener).toBeFocused();

  // The next request opens a usable sheet as usual.
  await sendSearch(page);
  await expect(page.getByRole('dialog', { name: 'Search' }).getByRole('combobox', { name: 'Search' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(opener).toBeFocused();
  await context.close();
});
