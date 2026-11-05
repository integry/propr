import { expect, test } from '@playwright/test';
import { captureTarget } from './dashboard-sections.fixture';
import { isHitTarget, longTitle, mediumTitle, noDocumentOverflow, openPhone, openSearchFromMenu, settle, viewports } from './mobile-menu-search.fixture';

// Below `md` the toolbar (and its search field) is hidden, so the ProPR menu's
// Search row is the only way a touch-only operator reaches global search.
// These run in a plain browser: no desktop adapter, no keyboard to open it.

for (const viewport of viewports) {
  test(`touch opens global search from the ProPR menu at ${viewport.name}px`, async ({ browser }) => {
    const { context, page } = await openPhone(browser, viewport);
    expect(await page.evaluate(() => 'proprDesktop' in window)).toBe(false);
    await expect(page.getByRole('banner', { name: 'Application toolbar' })).toBeHidden();

    // The menu keeps its name, mark and destinations, with Search in its header.
    const moreButton = page.getByRole('navigation', { name: 'Primary navigation' }).getByRole('button', { name: 'More' });
    await moreButton.tap();
    const menu = page.getByRole('dialog', { name: 'ProPR', exact: true });
    await settle(page);
    await expect(menu.getByRole('heading', { level: 2, name: 'ProPR', exact: true }).locator('img')).toHaveAttribute('alt', '');
    for (const name of ['Goals', 'Plans', 'Automations', 'Repositories', 'Settings']) {
      await expect(menu.getByRole('link', { name, exact: true })).toHaveCount(1);
    }
    const searchRow = menu.getByRole('button', { name: 'Search', exact: true });
    await expect(searchRow).toBeInViewport({ ratio: 1 });
    const searchBox = (await searchRow.boundingBox())!;
    expect(searchBox.height).toBeGreaterThanOrEqual(44);
    expect(searchBox.width).toBeGreaterThanOrEqual(44);
    expect(await isHitTarget(searchRow)).toBe(true);
    // Title, then Search, then Close, never overlapping.
    const titleBox = (await menu.getByRole('heading', { level: 2 }).boundingBox())!;
    const closeBox = (await menu.getByRole('button', { name: 'Close ProPR menu' }).boundingBox())!;
    expect(titleBox.x + titleBox.width).toBeLessThanOrEqual(searchBox.x + 0.5);
    expect(searchBox.x + searchBox.width).toBeLessThanOrEqual(closeBox.x + 0.5);
    // The workspace destinations stay above the fold.
    await expect(menu.getByRole('link', { name: 'Repositories', exact: true })).toBeInViewport({ ratio: 1 });
    expect(await noDocumentOverflow(page)).toBe(true);
    await captureTarget(page, `mobile-menu-search-button-${viewport.name}`);
    await menu.getByRole('button', { name: 'Close ProPR menu' }).tap();
    await expect(menu).toHaveCount(0);

    // Search opens alone: the menu is gone, only one modal remains, the field has focus.
    const { sheet, input } = await openSearchFromMenu(page);
    await expect(input).toBeFocused();
    await expect(page.locator('[aria-modal="true"]')).toHaveCount(1);
    expect(await page.evaluate(() => document.body.style.overflow)).toBe('');
    const close = sheet.getByRole('button', { name: 'Close search' });
    await expect(close).toBeInViewport({ ratio: 1 });
    expect(await isHitTarget(close)).toBe(true);
    expect(await isHitTarget(input)).toBe(true);
    await captureTarget(page, `mobile-menu-search-open-${viewport.name}`);

    // Real results: long titles in full with metadata beneath, nothing spilling sideways.
    await input.fill('search');
    const palette = page.getByTestId('global-search-palette');
    const options = palette.getByRole('option');
    await expect(options).toHaveCount(4);
    for (const index of [0, 1, 3]) {
      const row = options.nth(index);
      const title = row.getByText(index === 0 ? mediumTitle : longTitle, { exact: true });
      expect(await title.evaluate(el => el.scrollWidth <= el.clientWidth && el.scrollHeight <= el.clientHeight)).toBe(true);
      const titleBox = (await title.boundingBox())!;
      const metaBox = (await row.getByTestId('global-search-result-meta').boundingBox())!;
      expect(metaBox.y).toBeGreaterThanOrEqual(titleBox.y + titleBox.height - 1);
    }
    const paletteBox = (await palette.boundingBox())!;
    expect(paletteBox.x).toBeGreaterThanOrEqual(0);
    expect(paletteBox.x + paletteBox.width).toBeLessThanOrEqual(viewport.width);
    await expect(palette).not.toContainText('gpt-6-astra');
    expect(await noDocumentOverflow(page)).toBe(true);
    await expect(close).toBeInViewport({ ratio: 1 });
    expect(await isHitTarget(close)).toBe(true);
    await captureTarget(page, `mobile-menu-search-results-${viewport.name}`);

    // Close returns focus to More; reopening works the same way every time.
    await close.tap();
    await expect(sheet).toHaveCount(0);
    await expect(moreButton).toBeFocused();
    await expect(page.locator('[aria-modal="true"]')).toHaveCount(0);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const reopened = await openSearchFromMenu(page);
      await expect(reopened.input).toBeFocused();
      await expect(reopened.input).toHaveValue('');
      await page.keyboard.press('Escape');
      await expect(reopened.sheet).toHaveCount(0);
      await expect(moreButton).toBeFocused();
    }

    // A tap on the long task result opens that task and closes everything.
    const final = await openSearchFromMenu(page);
    await final.input.fill('search');
    await expect(options).toHaveCount(4);
    await options.nth(3).scrollIntoViewIfNeeded();
    await options.nth(3).tap();
    await expect(page).toHaveURL(/\/tasks\/task-1$/);
    await expect(page.locator('[aria-modal="true"]')).toHaveCount(0);
    expect(await noDocumentOverflow(page)).toBe(true);

    // Ctrl+K still takes the same route on the new page.
    await page.keyboard.press('Control+k');
    await expect(page.getByRole('dialog', { name: 'Search' }).getByRole('combobox', { name: 'Search' })).toBeFocused();
    await context.close();
  });
}
