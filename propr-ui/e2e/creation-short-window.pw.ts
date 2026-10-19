/**
 * The shared creation shell (New Task, New Goal) in short and narrow windows with no on-screen keyboard: a native
 * Linux window zoomed in until it is 370×345 CSS px, and narrow web layouts. However the header and the wrapped
 * actions fit, real wheel, touch and keyboard input bring every action wholly into view and back to the prompt.
 */
import { expect, test, type CDPSession, type Locator, type Page } from '@playwright/test';
import { expectClearOfChrome, inert, installWindowActions, strayPoints, type Shell } from './native-chrome.fixture';
import { fixture as newTaskFixture, stubGoals } from './new-task.fixture';
import { capture, fixture as desktopFixture } from './task-list-desktop.fixture';

// Measured in the signed Linux build: an 880×820 window zoomed in to 370×345 CSS px at this device pixel ratio.
const zoomed = { width: 370, height: 345 };
const zoomedScale = 2.3779921531677246;
const draft = Array.from({ length: 30 }, (_, line) => `Unsent draft line ${line + 1}`).join('\n');

const forms = [
  { name: 'New task', path: '/tasks/new', close: 'Close task creation', field: 'Prompt', actions: ['Cancel', 'Plan first', 'Run task'] },
  { name: 'Start a goal', path: '/goals?new=1', close: 'Close goal creation', field: 'Prompt', actions: ['Cancel', 'Start goal'] },
];

const windows: Array<{ name: string; size: { width: number; height: number }; scale: number; text?: string; header?: 'sticky' | 'scrolls' } & Shell> = [
  { name: 'linux-restored zoomed 370x345', platform: 'linux', size: zoomed, scale: zoomedScale },
  { name: 'linux-maximized zoomed 370x345', platform: 'linux', expanded: true, size: zoomed, scale: zoomedScale },
  // Taller than the shell's 20rem short band, but too short for the wrapped header and actions around a usable form.
  { name: 'web 370x345', size: zoomed, scale: 1 },
  { name: 'web 260x420', size: { width: 260, height: 420 }, scale: 1 },
  { name: 'linux-restored 420x480 enlarged text', platform: 'linux', size: { width: 420, height: 480 }, scale: 1, text: '150%' },
  // Either side of the 7.5rem band (inside the layer's padding) where the 73px header plus a 44px action fit under
  // it: below, the header scrolls away with the form; from it up, it stays put above at least a whole action.
  { name: 'web 370x130', size: { width: 370, height: 130 }, scale: 1, header: 'scrolls' },
  { name: 'web 370x144', size: { width: 370, height: 144 }, scale: 1, header: 'sticky' },
];

/**
 * How far `element` lies inside what the reader sees: every clipping ancestor's client area, below a sticky header
 * it is not part of. Negative `top`/`bottom` is the part cut off at that edge.
 */
const uncovered = (element: Locator) => element.evaluate(target => {
  let low = 0;
  let high = window.innerHeight;
  for (let parent = target.parentElement; parent; parent = parent.parentElement) {
    if (getComputedStyle(parent).overflowY === 'visible') continue;
    const box = parent.getBoundingClientRect();
    low = Math.max(low, box.top + parent.clientTop);
    high = Math.min(high, box.top + parent.clientTop + parent.clientHeight);
  }
  const header = target.closest('[role="dialog"]')?.querySelector('header');
  if (header && !header.contains(target) && getComputedStyle(header).position === 'sticky') low = Math.max(low, header.getBoundingClientRect().bottom);
  const box = target.getBoundingClientRect();
  return { top: box.top - low, bottom: high - box.bottom };
});

/**
 * A point in the pane's side gutter below its header, where no drag or wheel starts on a control, and the height of
 * the strip it centres, which a drag must stay within to start and end on the pane.
 */
async function gutter(dialog: Locator) {
  const pane = (await dialog.boundingBox())!;
  const header = (await dialog.locator('header').boundingBox())!;
  const top = Math.max(header.y + header.height, pane.y);
  const bottom = Math.min(pane.y + pane.height, top + 200);
  return { x: Math.round(pane.x + 8), y: Math.round((top + bottom) / 2), span: Math.floor(bottom - top) - 4 };
}

const settle = (page: Page) => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));

/** Scrolls with trusted wheel notches over the pane's gutter until `target` is wholly shown, as a reader would. */
async function wheelToShow(page: Page, dialog: Locator, target: Locator) {
  const { x, y } = await gutter(dialog);
  await page.mouse.move(x, y);
  for (let step = 0; step < 40; step++) {
    const { top, bottom } = await uncovered(target);
    if (top >= -0.5 && bottom >= -0.5) return;
    // Notches up to 40px, finer as the target nears, as a precision wheel or touchpad lands it in a tight gap.
    await page.mouse.wheel(0, top < 0 ? -Math.min(40, Math.ceil(-top)) : Math.min(40, Math.ceil(-bottom)));
    await settle(page);
  }
}

/** The same with trusted touch drags past Chromium's 15px touch slop, slow enough not to fling. */
async function dragToShow(page: Page, touch: CDPSession, dialog: Locator, target: Locator) {
  for (let step = 0; step < 40; step++) {
    const { top, bottom } = await uncovered(target);
    if (top >= -0.5 && bottom >= -0.5) return;
    const { x, y, span } = await gutter(dialog);
    const distance = (top < 0 ? 1 : -1) * Math.min(15 + Math.min(Math.ceil(top < 0 ? -top : -bottom) + 1, 30), span);
    await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: y - distance / 2 }] });
    for (let move = 1; move <= 8; move++) await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: Math.round(y - distance / 2 + distance * move / 8) }] });
    await page.waitForTimeout(50);
    await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await settle(page);
  }
}

/** The whole 44px action is drawn and takes a press at each sampled point, not just at its centre. */
async function expectWhole(action: Locator) {
  const { top, bottom } = await uncovered(action);
  expect(top, `${action} starts inside the pane`).toBeGreaterThanOrEqual(-0.5);
  expect(bottom, `${action} ends inside the pane`).toBeGreaterThanOrEqual(-0.5);
  expect((await action.boundingBox())!.height).toBeGreaterThanOrEqual(43.5);
  expect(await strayPoints(action)).toEqual([]);
}

/** A return trip's destination is wholly in view below any sticky header and takes a press at its centre. */
async function expectShown(target: Locator) {
  const { top, bottom } = await uncovered(target);
  expect(top, `${target} starts in view`).toBeGreaterThanOrEqual(-0.5);
  expect(bottom, `${target} ends in view`).toBeGreaterThanOrEqual(-0.5);
  expect(await target.evaluate(element => {
    const box = element.getBoundingClientRect();
    return element.contains(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2));
  }), `${target} is not covered`).toBe(true);
}

/** Where the caret's line of glyphs sits in what the reader sees; the draft's lines are too short to wrap. */
const caretShown = (field: Locator) => field.evaluate(element => {
  const area = element as HTMLTextAreaElement;
  const style = getComputedStyle(area);
  const lineHeight = parseFloat(style.lineHeight);
  const line = area.value.slice(0, area.selectionStart).split('\n').length - 1;
  const lineTop = area.getBoundingClientRect().top + area.clientTop + parseFloat(style.paddingTop) + line * lineHeight - area.scrollTop;
  let low = 0;
  let high = window.innerHeight;
  for (let parent: HTMLElement | null = area; parent; parent = parent.parentElement) {
    if (getComputedStyle(parent).overflowY === 'visible') continue;
    const box = parent.getBoundingClientRect();
    low = Math.max(low, box.top + parent.clientTop);
    high = Math.min(high, box.top + parent.clientTop + parent.clientHeight);
  }
  const header = area.closest('[role="dialog"]')?.querySelector('header');
  if (header && getComputedStyle(header).position === 'sticky') low = Math.max(low, header.getBoundingClientRect().bottom);
  // The caret spans the glyphs, not the line's leading above and below them.
  const glyphTop = lineTop + (lineHeight - parseFloat(style.fontSize)) / 2;
  return { top: glyphTop - low, bottom: high - glyphTop - parseFloat(style.fontSize) };
});

for (const shell of windows) {
  test.describe(shell.name, () => {
    test.use({ viewport: shell.size, deviceScaleFactor: shell.scale, hasTouch: true });

    for (const form of forms) {
      test(`${shell.name}: ${form.name} brings every whole action and the caret into view by wheel, touch and keyboard`, async ({ page, browserName }) => {
        test.setTimeout(90_000);
        if (shell.platform) await desktopFixture(page, shell.platform);
        await installWindowActions(page, shell);
        const requests = await newTaskFixture(page);
        await stubGoals(page);
        await page.goto(form.path);
        if (shell.text) await page.addStyleTag({ content: `html { font-size: ${shell.text} !important; }` });
        const dialog = page.getByRole('dialog', { name: form.name });
        const close = dialog.getByRole('button', { name: form.close });
        const field = dialog.getByLabel(form.field, { exact: true });
        await expect(field).toBeFocused();
        // Below the sticky band the focused field has scrolled the header away; the reader scrolls back up to it.
        if (shell.header === 'scrolls') await wheelToShow(page, dialog, close);
        // The native titlebar stays the window's, and the shell keeps its 40px close control.
        await expectClearOfChrome(page, dialog, close, shell, 40);
        if (shell.header) {
          const position = await dialog.locator('header').evaluate(header => getComputedStyle(header).position);
          expect(position, 'the header sticks only where a whole action fits beneath it').toBe(shell.header === 'sticky' ? 'sticky' : 'static');
        }

        // An unsent draft with the acceptance repository selected.
        const repository = dialog.getByText('Select a repository', { exact: true });
        if (await repository.isVisible()) {
          await repository.click();
          await page.getByRole('button', { name: /acme.*billing/ }).click();
        }
        await field.fill(draft);
        await field.press('End');
        await field.pressSequentially('.');
        const typed = `${draft}.`;
        await expect(field).toHaveValue(typed);
        const caret = await caretShown(field);
        expect(caret.top, 'the caret line starts in view').toBeGreaterThanOrEqual(-0.5);
        expect(caret.bottom, 'the caret line ends in view').toBeGreaterThanOrEqual(-0.5);
        const actions = form.actions.map(name => dialog.getByRole('button', { name, exact: true }));
        const run = actions.at(-1)!;
        await expect(run).toBeEnabled();

        // A wheel over the pane reaches each whole action, then scrolls back up to the start of the field.
        for (const action of actions) {
          await wheelToShow(page, dialog, action);
          await expectWhole(action);
        }
        await capture(page, `creation-short-window-${form.path.split('/')[1].replace(/\?.*/, '')}-${shell.name.replace(/[ .]/g, '-')}`);
        const label = dialog.getByText(form.field, { exact: true });
        await wheelToShow(page, dialog, label);
        await expectShown(label);

        // Touch drags travel the same way, back down to the submit action and up to the repository.
        if (browserName === 'chromium') {
          const touch = await page.context().newCDPSession(page);
          await dragToShow(page, touch, dialog, run);
          await expectWhole(run);
          const repositoryButton = dialog.getByRole('button', { name: /acme.*billing/ }).first();
          await dragToShow(page, touch, dialog, repositoryButton);
          await expectShown(repositoryButton);
        }

        // Keyboard focus scrolls the submit action wholly into view, and focusing the field brings its caret back.
        await run.focus();
        await expect(run).toBeFocused();
        await expectWhole(run);
        await field.focus();
        await field.press('Control+End');
        const back = await caretShown(field);
        expect(back.top, 'the caret line starts in view').toBeGreaterThanOrEqual(-0.5);
        expect(back.bottom, 'the caret line ends in view').toBeGreaterThanOrEqual(-0.5);

        // Nothing was lost or sent, and the window controls still belong to the window.
        await expect(field).toHaveValue(typed);
        await expect(dialog.getByRole('button', { name: /acme.*billing/ }).first()).toBeVisible();
        await wheelToShow(page, dialog, close);
        await expectClearOfChrome(page, dialog, close, shell, 40);
        if (shell.platform === 'linux') expect(await inert(page.getByRole('group', { name: 'Window controls' }))).toBe(false);
        expect(requests.filter(request => !request.startsWith('GET '))).toEqual([]);
      });
    }
  });
}
