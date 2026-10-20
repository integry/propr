/**
 * The narrow Search sheet opened by touch from the ProPR menu keeps its field and Close
 * search inside the visible area while an on-screen keyboard shrinks and pans the visual
 * viewport, and its results scroll in their own pane above the keyboard.
 */
import { expect, test, type CDPSession, type Locator, type Page } from '@playwright/test';
import { captureVisible, expectShown, expectUnframed, installKeyboardViewport, listenerCount, setKeyboard, type Band } from './keyboard-viewport.fixture';
import { longTitle, openPhone, openSearchFromMenu } from './mobile-menu-search.fixture';

// Measured on the Android emulator in Chrome with Gboard open over the Search sheet: the
// layout viewport stays 747px tall while the visible band is 421.09px, and a swipe that the
// results could not take panned it down to 301.82px. The 320px phone keeps the same share.
const phones = [
  { name: '412', layout: { width: 412, height: 747 }, keyboard: { height: 421.09, offsetTop: 0 }, panned: { height: 421.09, offsetTop: 301.82 } },
  { name: '320', layout: { width: 320, height: 640 }, keyboard: { height: 360.75, offsetTop: 0 }, panned: { height: 360.75, offsetTop: 258.58 } },
];

const innerSize = (page: Page) => page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));

/** The palette and its results pane lie inside the band; the pane scrolls rather than running behind the keyboard. */
async function expectPaneAboveKeyboard(palette: Locator, list: Locator, band: Band) {
  const box = (await palette.boundingBox())!;
  expect(box.y, 'palette starts inside the visible area').toBeGreaterThanOrEqual(band.offsetTop - 0.5);
  expect(box.y + box.height, 'palette ends above the keyboard').toBeLessThanOrEqual(band.offsetTop + band.height + 0.5);
  const { clientHeight, scrollHeight } = await list.evaluate(element => ({ clientHeight: element.clientHeight, scrollHeight: element.scrollHeight }));
  expect(scrollHeight, 'the results scroll inside their own pane').toBeGreaterThan(clientHeight + 1);
}

/**
 * Drags the results pane with trusted touch until `target` shows inside it and the band. The
 * finger stays on the pane: the palette around it clips (`overflow: hidden`) but does not
 * scroll, and its footer would take a drag as a pan of the whole page.
 */
async function swipeResults(page: Page, touch: CDPSession, list: Locator, target: Locator, band: Band) {
  const measure = () => target.evaluate((element, { offsetTop, height }) => {
    const pane = element.closest('.overflow-y-auto')!.getBoundingClientRect();
    const low = Math.max(offsetTop, pane.top); const high = Math.min(offsetTop + height, pane.bottom);
    const box = element.getBoundingClientRect();
    return { top: box.top - low, bottom: high - box.bottom, low, high };
  }, band);
  for (let step = 0; step < 30; step++) {
    const { top, bottom, low, high } = await measure();
    if (top >= -0.5 && bottom >= -0.5) break;
    // Past Chromium's 15px touch slop, slowly enough not to fling.
    const distance = (top < 0 ? 1 : -1) * Math.min(15 + Math.ceil(top < 0 ? -top : -bottom) + 1, high - low - 6);
    const x = Math.round(page.viewportSize()!.width / 2); const y = (low + high) / 2;
    await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: Math.round(y - distance / 2) }] });
    for (let move = 1; move <= 8; move++) await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: Math.round(y - distance / 2 + distance * move / 8) }] });
    await page.waitForTimeout(50);
    await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await list.evaluate(element => new Promise<void>(resolve => {
      let last = NaN; let still = 0;
      const check = () => { still = element.scrollTop === last ? still + 1 : 0; last = element.scrollTop; if (still >= 3) resolve(); else requestAnimationFrame(check); };
      requestAnimationFrame(check);
    }));
  }
  const { top, bottom } = await measure();
  expect(top, `${target} starts inside the results pane`).toBeGreaterThanOrEqual(-0.5);
  expect(bottom, `${target} ends inside the results pane, above the keyboard`).toBeGreaterThanOrEqual(-0.5);
  await expectShown([target], band);
}

for (const phone of phones) {
  test(`Search stays usable above the on-screen keyboard at ${phone.name}px`, async ({ browser }) => {
    const { context, page } = await openPhone(browser, phone.layout, target => installKeyboardViewport(target, phone.layout));
    const touch = await context.newCDPSession(page);
    const full: Band = { height: phone.layout.height, offsetTop: 0 };
    const idle = await listenerCount(page);
    const { moreButton, sheet, input } = await openSearchFromMenu(page);
    const close = sheet.getByRole('button', { name: 'Close search' });
    const palette = page.getByTestId('global-search-palette');
    // The pane that scrolls the results: the listbox's container.
    const list = palette.getByRole('listbox').locator('..');
    const options = palette.getByRole('option');
    await expect(input).toBeFocused();

    // The keyboard opens over the focused field, then the query returns long results.
    await setKeyboard(page, phone.keyboard);
    await input.pressSequentially('search');
    await expect(options).toHaveCount(4);
    expect(await innerSize(page)).toEqual(phone.layout);
    await expectShown([input, close], phone.keyboard);
    await expectPaneAboveKeyboard(palette, list, phone.keyboard);
    // Every title and its metadata stay whole; nothing was cut to make the list fit.
    const lastTitle = options.nth(3).getByText(longTitle, { exact: true });
    expect(await lastTitle.evaluate(el => el.scrollHeight <= el.clientHeight && el.scrollWidth <= el.clientWidth)).toBe(true);
    await expect(options.nth(3).getByTestId('global-search-result-meta')).toBeVisible();
    await captureVisible(page, `mobile-search-keyboard-${phone.name}`, phone.keyboard);

    // A trusted swipe scrolls the results pane to the end of the last result (taller than the
    // pane, so its metadata line); the field and Close stay put.
    const lastMeta = options.nth(3).getByTestId('global-search-result-meta');
    await swipeResults(page, touch, list, lastMeta, phone.keyboard);
    expect(await list.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
    await expectShown([input, close, lastMeta], phone.keyboard);
    await expect(input).toBeFocused();

    // The browser pans the visible band (a scroll without a resize): the sheet follows it.
    await setKeyboard(page, phone.panned, ['scroll']);
    expect(await innerSize(page)).toEqual(phone.layout);
    await expectShown([input, close], phone.panned);
    await expectPaneAboveKeyboard(palette, list, phone.panned);
    await swipeResults(page, touch, list, options.first().getByTestId('global-search-result-meta'), phone.panned);
    await expectShown([input, close], phone.panned);
    await captureVisible(page, `mobile-search-keyboard-panned-${phone.name}`, phone.panned);

    // Filtering to Tasks with the keyboard up keeps the field focused and the palette inside the band.
    await palette.getByRole('tab', { name: /^Tasks/ }).tap();
    await expect(options).toHaveCount(1);
    await expect(input).toBeFocused();
    const filtered = (await palette.boundingBox())!;
    expect(filtered.y + filtered.height).toBeLessThanOrEqual(phone.panned.offsetTop + phone.panned.height + 0.5);
    await expectShown([input, close], phone.panned);
    await swipeResults(page, touch, list, options.first().getByTestId('global-search-result-meta'), phone.panned);

    // Close search still answers a tap while panned; focus returns to More.
    await close.tap();
    await expect(sheet).toHaveCount(0);
    await expect(moreButton).toBeFocused();
    await setKeyboard(page, full);
    expect(await listenerCount(page)).toBe(idle);

    // Reopened with the keyboard already up and panned: placed from the current band, and a
    // tap on a result opens it. Dismissing the keyboard first restores the stylesheet layout.
    const reopened = await openSearchFromMenu(page);
    await setKeyboard(page, phone.panned);
    await expectShown([reopened.input, reopened.sheet.getByRole('button', { name: 'Close search' })], phone.panned);
    await setKeyboard(page, full);
    await expectUnframed(reopened.sheet);
    await setKeyboard(page, phone.keyboard);
    await reopened.input.pressSequentially('search');
    await expect(options).toHaveCount(4);
    await expectPaneAboveKeyboard(palette, list, phone.keyboard);
    await swipeResults(page, touch, list, lastMeta, phone.keyboard);
    await lastMeta.tap();
    await expect(page).toHaveURL(/\/tasks\/task-1$/);
    await expect(page.locator('[aria-modal="true"]')).toHaveCount(0);
    await context.close();
  });
}
