/**
 * Follow Up on Task in the measured 65px landscape keyboard band (Pixel 5 emulator, Gboard,
 * Chrome 133 at 851×289): the framed layer leaves the dialog room for a whole 44px control,
 * so Close, Cancel and Post Comment can each be scrolled wholly into view and tapped with the
 * keyboard up, while the draft and its destination survive portrait → landscape → portrait.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { layerOf, openTaskAction, stubTask, taskId } from './task-logs.fixture';
import { captureVisible, expectShown, expectUnframed, installKeyboardViewport, setKeyboard, swipeToShow, type Band, type Clipping } from './keyboard-viewport.fixture';

const portrait = { width: 384, height: 692 };
// Portrait with the keyboard open, measured on a Samsung SM-S908B in Chrome 155.
const portraitBand: Band = { height: 382.133, offsetTop: 146.4 };
const landscape = { width: 851, height: 289 };
const band: Band = { height: 65.09091186523438, offsetTop: 0 };
// The same band after the browser pans the visual viewport down the layout (no resize).
const panned: Band = { height: band.height, offsetTop: 112 };
const destination = 'Post a comment to Issue integry/propr#3243';
const draft = 'followup-native-draft';

test.use({ viewport: portrait, isMobile: true, hasTouch: true });

/** The layer and dialog as drawn: the layer's box and vertical padding, and the dialog's scroll area. */
const frameOf = (dialog: Locator) => dialog.evaluate(element => {
  const layer = element.parentElement!;
  const style = getComputedStyle(layer);
  const box = layer.getBoundingClientRect();
  const area = element.getBoundingClientRect();
  return {
    top: box.top, height: box.height, paddingTop: parseFloat(style.paddingTop), paddingBottom: parseFloat(style.paddingBottom),
    dialogTop: area.top, dialogBottom: area.bottom, scrollArea: element.clientHeight, overflowY: getComputedStyle(element).overflowY,
  };
});

/** The comment's first line, where a one-line draft's caret is, lies wholly inside the band and every clip that applies. */
const expectCaretLineShown = (field: Locator, { offsetTop, height }: Band) => expect.poll(() => field.evaluate((element, [top, bottom]) => {
  const style = getComputedStyle(element);
  const lineTop = element.getBoundingClientRect().top + element.clientTop + parseFloat(style.paddingTop) - element.scrollTop;
  const lineBottom = lineTop + parseFloat(style.lineHeight);
  let low = top; let high = bottom;
  for (const clip of (window as unknown as Clipping).__clips(element)) { low = Math.max(low, clip.top); high = Math.min(high, clip.bottom); }
  return lineTop >= low - 0.5 && lineBottom <= high + 0.5;
}, [offsetTop, offsetTop + height] as const), 'the line being edited is shown').toBe(true);

async function rotate(page: Page, to: { width: number; height: number }, from: { width: number; height: number }, field: Locator, next: Band) {
  // Rotating dismisses the keyboard; the reader focuses the field again and it reopens.
  await setKeyboard(page, { height: from.height, offsetTop: 0 });
  await page.setViewportSize(to);
  await setKeyboard(page, { height: to.height, offsetTop: 0 });
  await field.focus();
  await setKeyboard(page, next);
}

test('Follow Up keeps every 44px action reachable in the 65px landscape band, also when panned, with the draft, destination and receipt kept', async ({ page, browserName }) => {
  test.setTimeout(90_000);
  const posts: string[] = [];
  await installKeyboardViewport(page, portrait);
  await stubTask(page, posts);
  await page.goto(`/tasks/${taskId}`);
  await openTaskAction(page, 'Follow Up', 'Follow Up');
  const dialog = page.getByRole('dialog', { name: 'Follow Up on Task' });
  const heading = dialog.getByRole('heading', { name: 'Follow Up on Task' });
  const close = dialog.getByRole('button', { name: 'Close follow-up dialog' });
  const cancel = dialog.getByRole('button', { name: 'Cancel', exact: true });
  const post = dialog.getByRole('button', { name: 'Post Comment' });
  const comment = dialog.getByRole('textbox', { name: 'Comment' });
  const layer = layerOf(dialog);
  const touch = browserName === 'chromium' ? await page.context().newCDPSession(page) : null;
  await expect(comment).toBeFocused();
  await comment.fill('');

  // A short draft typed in portrait with the keyboard up: every action shows at once.
  await setKeyboard(page, portraitBand);
  await comment.pressSequentially(draft);
  await expectShown([heading, close, cancel, post], portraitBand);
  await expect(dialog).toHaveAccessibleDescription(destination);
  const sizes = await Promise.all([close, cancel, post].map(async control => (await control.boundingBox())!));

  await rotate(page, landscape, portrait, comment, band);
  await expect(comment).toBeFocused();
  // The layer is framed to the band, and its inset leaves the dialog a scroll area taller than one 44px control.
  const frame = await frameOf(dialog);
  expect(frame.top).toBeCloseTo(band.offsetTop, 1);
  expect(frame.height).toBeCloseTo(band.height, 1);
  expect(frame.paddingTop + frame.paddingBottom).toBeLessThanOrEqual(band.height - 44 - 2);
  expect(frame.dialogTop).toBeCloseTo(band.offsetTop + frame.paddingTop, 1);
  expect(frame.dialogBottom).toBeCloseTo(band.offsetTop + band.height - frame.paddingBottom, 1);
  expect(frame.scrollArea).toBeGreaterThanOrEqual(44);
  expect(frame.overflowY).toBe('auto');
  await expectShown([layer], band);
  await expectCaretLineShown(comment, band);
  await captureVisible(page, 'followup-short-band', band);

  // Each action scrolls wholly into the dialog's visible part and takes a tap at its centre; sizes are unchanged.
  // The finger drags at the dialog's left edge, beside the comment field.
  const x = 8;
  for (const target of [cancel, post, close, heading, post]) await swipeToShow(page, touch, target, band, { x });
  await captureVisible(page, 'followup-short-band-actions', band);
  for (const [index, control] of [close, cancel, post].entries()) {
    const box = (await control.boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeCloseTo(sizes[index].height, 0);
  }
  await expect(comment).toBeFocused();

  // The browser pans the band down the layout without resizing it: the layer follows, and every action is still reachable.
  await setKeyboard(page, panned, ['scroll']);
  const pannedFrame = await frameOf(dialog);
  expect(pannedFrame.top).toBeCloseTo(panned.offsetTop, 1);
  expect(pannedFrame.height).toBeCloseTo(panned.height, 1);
  expect(pannedFrame.scrollArea).toBeGreaterThanOrEqual(44);
  await expectShown([layer], panned);
  for (const target of [close, cancel, post]) await swipeToShow(page, touch, target, panned, { x });
  await captureVisible(page, 'followup-short-band-panned', panned);
  // The keyboard moves back up with the dialog scrolled to its actions: the line being edited comes back into view.
  await setKeyboard(page, band);
  await expectShown([layer], band);
  await expectCaretLineShown(comment, band);

  // Typing still lands in the field and keeps its line in view.
  await page.keyboard.type(' kept');
  await expect(comment).toHaveValue(`${draft} kept`);
  await expectCaretLineShown(comment, band);

  // Dismissing the keyboard restores the stylesheet inset; back in portrait the draft and destination are unchanged.
  await setKeyboard(page, { height: landscape.height, offsetTop: 0 });
  await expectUnframed(layer);
  expect((await frameOf(dialog)).paddingTop).toBe(16);
  await page.setViewportSize(portrait);
  await setKeyboard(page, { height: portrait.height, offsetTop: 0 });
  expect((await frameOf(dialog)).paddingTop).toBe(8);
  await expect(comment).toHaveValue(`${draft} kept`);
  await expect(dialog).toHaveAccessibleDescription(destination);
  expect(posts).toEqual([]);

  // In the landscape band again, Post Comment is tapped there: the receipt shows and posting the same text again stays off.
  await rotate(page, landscape, portrait, comment, band);
  await swipeToShow(page, touch, post, band, { x });
  await post.tap();
  const alert = dialog.getByRole('alert');
  await expect(alert).toBeFocused();
  await expect(alert).toContainText('4243001');
  expect(posts).toEqual([`${draft} kept`]);
  await expect(post).toBeDisabled();
  await swipeToShow(page, touch, alert.getByText('Comment posted, but the command was not submitted'), band, { x });
  const done = dialog.getByRole('button', { name: 'Close', exact: true });
  await swipeToShow(page, touch, done, band, { x });
  expect((await done.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await captureVisible(page, 'followup-short-band-receipt', band);

  await rotate(page, portrait, landscape, comment, portraitBand);
  await expect(comment).toHaveValue(`${draft} kept`);
  await expect(dialog).toHaveAccessibleDescription(destination);
  await expect(post).toBeDisabled();
  expect(posts).toHaveLength(1);
  await done.scrollIntoViewIfNeeded();
  await done.tap();
  await expect(dialog).toBeHidden();
});
