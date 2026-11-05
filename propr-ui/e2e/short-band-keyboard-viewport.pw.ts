/**
 * The mobile Create sheet's New To-do form and the Logs viewer in the shortest landscape
 * keyboard bands, too short for their header and a 44px control together: the header
 * scrolls away with the rest, and every control and the log can each be scrolled into view.
 */
import { expect, test, type Page } from '@playwright/test';
import { layerOf, openTaskAction, outputLines, outputName, stubTask, taskId } from './task-logs.fixture';
import { fixture as todoFixture } from './quick-add-todo.fixture';
import { captureVisible, expectReadableLines, expectShown, expectUnframed, installKeyboardViewport, setKeyboard, swipeToShow, type Band } from './keyboard-viewport.fixture';

const portrait = { width: 384, height: 692 };
// Portrait with the keyboard open, measured on a Samsung SM-S908B in Chrome 155.
const portraitTodoBand: Band = { height: 382.133, offsetTop: 310.667 };
// Landscape bands with the keyboard (not an OS fullscreen editor) open, both below the
// sheet's md breakpoint: a Samsung SM-S908B (Android 16) and a Pixel 5 emulator with Gboard
// (Android 36, whose layout height was not reported; its Logs case is 289px tall).
const todoCases = [
  { device: 'Samsung', layout: { width: 748, height: 298 }, band: { height: 89.333, offsetTop: 208.533 } },
  { device: 'Pixel 5', layout: { width: 749, height: 289 }, band: { height: 69.12, offsetTop: 0 } },
];
// The Pixel 5 emulator with Gboard in landscape, on the Logs search.
const logsLayout = { width: 851, height: 289 };
const logsBand: Band = { height: 65.09091186523438, offsetTop: 0 };

test.use({ viewport: portrait, isMobile: true, hasTouch: true });

const position = (page: Page, selector: string) => page.locator(selector).first().evaluate(element => getComputedStyle(element).position);

for (const { device, layout, band } of todoCases) {
  test(`New To-do in the Create sheet stays usable in the ${device} ${band.height}px landscape band, then restores in portrait`, async ({ page, browserName }) => {
    test.setTimeout(90_000);
    await installKeyboardViewport(page, portrait);
    const submissions = await todoFixture(page);
    await page.goto('/inbox');
    await page.getByRole('button', { name: 'Create', exact: true }).tap();
    const sheet = page.getByRole('dialog', { name: 'Create' });
    await sheet.getByRole('button', { name: 'New To-do' }).tap();
    const field = sheet.getByRole('textbox');
    await expect(field).toBeFocused();
    const title = sheet.getByRole('heading', { name: 'Create' });
    const close = sheet.getByRole('button', { name: 'Close Create menu' });
    const add = sheet.getByRole('button', { name: 'Add To-Do' });
    const view = sheet.getByRole('button', { name: 'View Todos' });
    const category = sheet.getByRole('button', { name: 'Uncategorized' });
    const layer = sheet.locator('..');
    const touch = browserName === 'chromium' ? await page.context().newCDPSession(page) : null;

    // A draft with a repository, made in portrait with the keyboard up; the header sticks there.
    await sheet.getByRole('button', { name: 'acme/alpha' }).tap();
    await sheet.getByRole('button', { name: 'acme/billing' }).tap();
    await field.focus();
    await setKeyboard(page, portraitTodoBand);
    await field.pressSequentially('Short to-do draft');
    expect(await position(page, '#mobile-create-sheet > div')).toBe('sticky');
    await expectShown([title, close], portraitTodoBand);

    // Rotating dismisses the keyboard; the reader focuses the field again and it reopens.
    await setKeyboard(page, { height: portrait.height, offsetTop: 0 });
    await page.setViewportSize(layout);
    await setKeyboard(page, { height: layout.height, offsetTop: 0 });
    await field.focus();
    await setKeyboard(page, band);
    await expectShown([layer], band);
    // The header scrolls with the form instead of covering all but a sliver of it.
    expect(await position(page, '#mobile-create-sheet > div')).toBe('static');
    await expect(field).toBeFocused();
    await captureVisible(page, `todo-sheet-short-${band.height}`, band);

    // Each action, the category and the repository scroll wholly into the band and take a
    // tap at their centre, down to the form's end and back up to Close; touch targets stay 44px.
    const x = 8;
    for (const target of [add, view, category, sheet.getByRole('button', { name: 'acme/billing' }), close]) {
      await swipeToShow(page, touch, target, band, { x });
      if (target === add) await captureVisible(page, `todo-sheet-short-${band.height}-actions`, band);
    }
    await captureVisible(page, `todo-sheet-short-${band.height}-close`, band);
    for (const control of [add, view, close]) expect((await control.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await expectShown([title], band);
    await sheet.evaluate(element => { element.scrollTop = element.scrollHeight; });
    await expectShown([add, view], band);
    await expect(field).toBeFocused();

    // Typing still lands in the field and keeps it in view.
    await page.keyboard.type(' kept');
    await expect(field).toHaveValue('Short to-do draft kept');
    await expectShown([layer], band);

    // Back in portrait with the keyboard closed, the sheet lays out as before with the draft intact.
    await setKeyboard(page, { height: layout.height, offsetTop: 0 });
    await expectUnframed(layer);
    await page.setViewportSize(portrait);
    await setKeyboard(page, { height: portrait.height, offsetTop: 0 });
    expect(await position(page, '#mobile-create-sheet > div')).toBe('sticky');
    const full = { height: portrait.height, offsetTop: 0 };
    await expectShown([title, close], full);
    await expect(field).toHaveValue('Short to-do draft kept');
    await expect(sheet.getByRole('button', { name: 'acme/billing' })).toBeVisible();
    await add.scrollIntoViewIfNeeded();
    await expectShown([add, view], full);
    expect(submissions).toEqual([]);

    await close.tap();
    await expect(sheet).toBeHidden();
    expect(new URL(page.url()).pathname).toBe('/inbox');
  });
}

test('Logs stays usable in the measured 65px landscape band: search, match navigation, the log and Close are each reachable', async ({ page, browserName }) => {
  test.setTimeout(90_000);
  await installKeyboardViewport(page, logsLayout);
  await page.setViewportSize(logsLayout);
  await stubTask(page, []);
  await page.goto(`/tasks/${taskId}`);
  const opener = await openTaskAction(page, 'View Logs', 'Logs');
  const dialog = page.getByRole('dialog', { name: 'Log Files' });
  const title = dialog.getByRole('heading', { name: 'Log Files' });
  const close = dialog.getByRole('button', { name: 'Close log files' });
  const search = dialog.getByRole('textbox', { name: 'Search log' });
  const status = dialog.getByRole('status');
  const content = dialog.getByTestId('log-file-content');
  const output = dialog.getByRole('button', { name: new RegExp(outputName) });
  const layer = layerOf(dialog);
  const touch = browserName === 'chromium' ? await page.context().newCDPSession(page) : null;
  // Moving to a match scrolls the log and the dialog smoothly; measure once both stop.
  const settle = () => dialog.evaluate(element => new Promise<void>(resolve => {
    const log = element.querySelector('pre');
    let last = ''; let still = 0;
    const check = () => {
      const now = `${element.scrollTop}:${log?.scrollTop}`;
      still = now === last ? still + 1 : 0; last = now;
      if (still >= 5) resolve(); else requestAnimationFrame(check);
    };
    requestAnimationFrame(check);
  }));
  await expect(close).toBeFocused();
  await output.click();
  await expect(content).toContainText('step 399');
  const unframedLog = (await content.boundingBox())!;

  await search.focus();
  await setKeyboard(page, logsBand);
  await expectShown([layer], logsBand);
  // The whole dialog scrolls; the log keeps a scroll area of its own.
  expect(await dialog.evaluate(element => getComputedStyle(element).overflowY)).toBe('auto');
  await expect(search).toBeFocused();
  await expectShown([search], logsBand);
  await search.pressSequentially('acceptance');
  const matches = outputLines.filter(line => line.includes('acceptance')).length;
  await expect(status).toHaveText(`1 / ${matches}`);
  await settle();

  // The finger drags in the file list's column, beside the log, so it scrolls the dialog.
  const x = 8;
  const prev = dialog.getByRole('button', { name: 'Previous match' });
  const next = dialog.getByRole('button', { name: 'Next match' });
  const clear = dialog.getByRole('button', { name: 'Clear log search' });
  const current = content.locator('mark[aria-current="true"]');
  for (const control of [search, prev, next, clear]) {
    await swipeToShow(page, touch, control, logsBand, { x });
    expect((await control.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  }
  await captureVisible(page, 'logs-short-search', logsBand);
  await next.tap();
  await expect(status).toHaveText(`2 / ${matches}`);
  await settle();
  // The current match and three complete lines of the log are shown together.
  await swipeToShow(page, touch, content, logsBand, { x });
  await expectReadableLines(content, logsBand, 3);
  await expect.poll(async () => { try { await expectShown([current], logsBand); return true; } catch { return false; } }).toBe(true);
  await expect(current).toHaveText('acceptance');
  await captureVisible(page, 'logs-short-content', logsBand);

  // Back up to the match controls, then the file list, the heading and Close.
  await swipeToShow(page, touch, prev, logsBand, { x });
  await prev.tap();
  await expect(status).toHaveText(`1 / ${matches}`);
  await settle();
  // A file's button (two lines of name and its size) is taller than this band; its name scrolls into view.
  await swipeToShow(page, touch, output.getByText(outputName, { exact: true }), logsBand, { x });
  for (const target of [title, close]) await swipeToShow(page, touch, target, logsBand, { x });
  expect((await close.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await captureVisible(page, 'logs-short-close', logsBand);

  // Dismissing the keyboard restores the stylesheet layout with the search kept.
  await setKeyboard(page, { height: logsLayout.height, offsetTop: 0 });
  await expectUnframed(layer);
  expect(await dialog.evaluate(element => getComputedStyle(element).overflowY)).toBe('hidden');
  await expect(search).toHaveValue('acceptance');
  await expect(status).toHaveText(`1 / ${matches}`);
  // The log takes the same space as before the keyboard opened.
  expect((await content.boundingBox())!.height).toBeCloseTo(unframedLog.height, 0);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();
});
