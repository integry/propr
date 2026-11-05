import { expect, test, type Locator, type Page } from '@playwright/test';
import { captureTarget, fixture, minutesAgo } from './dashboard-sections.fixture';

// Synthetic titles at the lengths real saved plans reach (~170 and ~500 characters), one carrying an
// unbroken path, under a long repository slug.
const repository = 'example-organisation/very-long-repository-name-for-search-layout-validation-workspace';
const mediumTitle = 'Make the repository settings page keep unsaved branch protection edits when the operator '
  + 'switches tabs, and show which fields still differ from the saved configuration';
const longTitle = 'Consolidate the release readiness checklist so that every packaging target (signed Linux '
  + 'RPM and DEB, notarised macOS DMG, Windows MSI) reports the same artefact provenance, verifies the '
  + 'update feed signature against packages/desktop/src/update/verification/release-feed-signature-policy.ts, '
  + 'records the reviewer who approved the build, links the matching changelog entry, and refuses to publish '
  + 'when any target is missing a reproducible build attestation or the smoke suite on clean hosts fails';

const plans = [mediumTitle, longTitle, 'Short plan about search layout'].map((name, index) => ({
  draft_id: `plan-${index}`, repository, name, initial_prompt: `Synthetic plan ${index + 1} for the layout check.`,
  status: 'review', created_at: minutesAgo((index + 1) * 60), updated_at: minutesAgo((index + 1) * 60),
  issue_summary: { total: 3, pending: 1, processing: 1, merged: 1, closed: 0 },
}));
const tasks = [{
  id: 'task-1', title: longTitle, status: 'completed', prNumber: 2480, score: 9, repository,
  issueNumber: 2400, model: 'gpt-6-astra', subtitle: 'Synthetic task.', createdAt: minutesAgo(3 * 24 * 60),
}];

async function openPalette(page: Page, viewport: { width: number; height: number }) {
  await fixture(page, viewport, [], []);
  await page.route('**/api/planner/drafts?**', route => route.fulfill({ json: { drafts: plans, total: plans.length, page: 1, limit: 5, hasMore: false } }));
  await page.route('**/api/tasks?**', route => route.fulfill({ json: { tasks, total: tasks.length } }));
  await page.route('**/api/instance/catalog', route => route.fulfill({ json: { agents: [], repositories: [] } }));
  await page.goto('/');
  const input = page.getByRole('combobox', { name: 'Search' });
  await input.fill('search');
  const palette = page.getByTestId('global-search-palette');
  await expect(palette.getByRole('option')).toHaveCount(4);
  return { input, palette, list: palette.getByRole('listbox', { name: 'Search results' }) };
}

/** Each row's title spans the copy column beside the icon, with repository/age on its own line below. */
async function expectFullWidthTitles(list: Locator) {
  const listBox = (await list.boundingBox())!;
  const rows = list.getByRole('option');
  // Rows 0-1 are the long plans, row 2 the short plan, row 3 the long task.
  for (const [index, title] of [[0, mediumTitle], [1, longTitle], [3, longTitle]] as const) {
    const row = rows.nth(index);
    // The complete title stays in the row's accessible name and its text is not clipped.
    await expect(row).toHaveAccessibleName(new RegExp(`^${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    const titleText = row.getByText(title, { exact: true });
    expect(await titleText.evaluate(el => el.scrollWidth <= el.clientWidth && el.scrollHeight <= el.clientHeight)).toBe(true);
    const rowBox = (await row.boundingBox())!;
    const iconBox = (await row.locator('svg').first().boundingBox())!;
    const titleBox = (await titleText.boundingBox())!;
    const meta = row.getByTestId('global-search-result-meta');
    const metaBox = (await meta.boundingBox())!;
    // Title runs from just past the icon to the row's inner right edge (8px padding).
    expect(titleBox.x).toBeLessThanOrEqual(iconBox.x + iconBox.width + 9);
    expect(titleBox.x + titleBox.width).toBeGreaterThanOrEqual(rowBox.x + rowBox.width - 9);
    // Metadata is a single compact line under the title, never a column beside it.
    expect(metaBox.y).toBeGreaterThanOrEqual(titleBox.y + titleBox.height - 1);
    expect(metaBox.height).toBeLessThanOrEqual(18);
    expect(Math.abs(metaBox.x - titleBox.x)).toBeLessThanOrEqual(1);
    expect(metaBox.x + metaBox.width).toBeLessThanOrEqual(listBox.x + listBox.width);
    await expect(meta.getByTitle(repository)).toBeVisible();
    await expect(meta).toContainText(/· \d+[mhd]|· just now/);
  }
  expect(await list.locator('xpath=..').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
}

/**
 * Font-independent height check for the ~500-character plan row. Line counts depend on which font renders
 * (Inter is a web font; fallbacks wrap the same title to 11-15 lines here), so instead of a fixed pixel
 * height the title is compared with a hidden copy wrapped at 60% of the row's copy width, the most the
 * old layout left it once repository metadata took its 40%. The row must also be only title + metadata line +
 * padding, so nothing beside the title can stretch it.
 */
async function expectCompactLongRow(list: Locator) {
  const row = list.getByRole('option').nth(1);
  const metrics = await row.getByText(longTitle, { exact: true }).evaluate(title => {
    const li = title.closest('li')!;
    const style = getComputedStyle(li);
    // The row's copy width: from where the title starts to the row's inner right edge.
    const copyWidth = li.getBoundingClientRect().right - parseFloat(style.paddingRight) - parseFloat(style.borderRightWidth)
      - title.getBoundingClientRect().left;
    const copy = title.cloneNode(true) as HTMLElement;
    copy.style.cssText = `position:absolute;visibility:hidden;width:${copyWidth * 0.6}px`;
    title.parentElement!.appendChild(copy);
    const squeezedHeight = copy.getBoundingClientRect().height;
    copy.remove();
    return {
      titleHeight: title.getBoundingClientRect().height, squeezedHeight, rowHeight: li.getBoundingClientRect().height,
      metaHeight: li.querySelector('[data-testid="global-search-result-meta"]')!.getBoundingClientRect().height,
      padding: parseFloat(style.paddingTop) + parseFloat(style.paddingBottom),
    };
  });
  expect(metrics.titleHeight).toBeLessThan(metrics.squeezedHeight * 0.75);
  expect(Math.abs(metrics.rowHeight - (metrics.titleHeight + metrics.metaHeight + metrics.padding))).toBeLessThanOrEqual(1);
}

const expectNoPageOverflow = (page: Page) => expect(page.evaluate(() =>
  document.documentElement.scrollWidth <= window.innerWidth)).resolves.toBe(true);

test('long plan and task titles use the full results-row width at desktop size', async ({ page }) => {
  const { input, palette, list } = await openPalette(page, { width: 1286, height: 800 });
  await expectFullWidthTitles(list);
  await expectNoPageOverflow(page);

  await expectCompactLongRow(list);

  // Keyboard, hover and the preview still drive the one linear list.
  const preview = palette.getByTestId('global-search-preview');
  await input.press('ArrowDown');
  await expect(preview.getByRole('heading')).toHaveText(longTitle);
  await expect(preview.getByTestId('repository-chip')).toHaveAttribute('title', repository);
  await list.getByRole('option').nth(0).hover();
  await expect(preview.getByRole('heading')).toHaveText(mediumTitle);
  await captureTarget(page.locator('body'), 'global-search-row-layout-desktop');

  await input.press('Tab');
  await input.press('Tab');
  await expect(palette.getByRole('option')).toHaveCount(1);
  await input.press('Shift+Tab');
  await input.press('Shift+Tab');
  await expect(palette.getByRole('option')).toHaveCount(4);
  await input.press('ArrowDown');
  await input.press('Enter');
  await expect(page).toHaveURL(/\/studio\/plan-1$/);

  await page.goBack();
  await page.getByRole('combobox', { name: 'Search' }).fill('search');
  await expect(palette).toBeVisible();
  await page.getByRole('combobox', { name: 'Search' }).press('Escape');
  await expect(palette).toBeHidden();
});

for (const width of [320, 390]) {
  test(`at a ${width}px phone width the results rows keep full titles without overflow`, async ({ page }) => {
    // The toolbar search is desktop-only (the header is hidden below md), so on a phone it is not offered
    // and the page itself must not overflow.
    await fixture(page, { width, height: 760 }, [], []);
    await page.goto('/');
    await expect(page.getByRole('combobox', { name: 'Search' })).toBeHidden();
    await expectNoPageOverflow(page);

    // The palette's below-md layout (preview hidden, list full width, 1rem gutters) at the same copy
    // width, so the row geometry is checked where a phone-width list would render it.
    const { input, palette, list } = await openPalette(page, { width: 1286, height: 760 });
    await palette.evaluate((el, w) => { el.style.width = `${w - 32}px`; }, width);
    await palette.getByTestId('global-search-preview').locator('xpath=..').evaluate(el => { el.style.display = 'none'; });
    // The list fills the palette inside its 1px borders, less only the scrollport's own scrollbar: none in
    // headless Chromium, the 6px `.scrollbar-subtle` bar in WebKit, which draws classic scrollbars.
    const boxes = await list.evaluate(el => {
      const scrollport = el.parentElement!;
      const palette = el.closest<HTMLElement>('[data-testid="global-search-palette"]')!;
      return {
        palette: palette.getBoundingClientRect().width, paletteInner: palette.clientWidth,
        scrollport: scrollport.getBoundingClientRect().width, scrollportInner: scrollport.clientWidth,
        list: el.getBoundingClientRect().width,
      };
    });
    expect(boxes.palette).toBe(width - 32);
    expect(boxes.paletteInner).toBe(width - 34);
    expect(boxes.scrollport).toBe(boxes.paletteInner);
    expect(boxes.list).toBe(boxes.scrollportInner);
    expect(boxes.scrollport - boxes.scrollportInner).toBeLessThanOrEqual(6);
    await expectFullWidthTitles(list);
    await expectCompactLongRow(list);
    await input.press('ArrowDown');
    await expect(list.getByRole('option').nth(1)).toHaveAttribute('aria-selected', 'true');
    await captureTarget(palette, `global-search-row-layout-${width}`);
  });
}
