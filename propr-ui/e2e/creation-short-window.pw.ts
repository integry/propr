/**
 * The shared creation shell (New Task, New Goal) in short and narrow windows with no on-screen keyboard: a native
 * Linux window zoomed in until it is 370×345 CSS px, and narrow web layouts. However the header and the wrapped
 * actions fit, real wheel, touch and keyboard input bring every action wholly into view and back to the prompt.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { dragToShow, notch, scrollPoint, settle, settled, uncovered, wheelToShow } from './creation-scroll.fixture';
import { expectClearOfChrome, inert, installWindowActions, strayPoints, type Shell } from './native-chrome.fixture';
import { fixture as newTaskFixture, stubGoals } from './new-task.fixture';
import { capture, fixture as desktopFixture } from './task-list-desktop.fixture';
import { serveInter } from './task-logs.fixture';

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
  // The reviewer's enlarged-text probe on eb98095: 150% and 200% root text wrap the title and the action labels,
  // so a header that stuck at the 7.5rem band covered the actions (at 370x288 and 200%, a 233px Start a goal header
  // left 5px for its 112px action). Whether the header sticks follows what the wrapped contents measure.
  { name: 'web 370x216 150% text', size: { width: 370, height: 216 }, scale: 1, text: '150%' },
  { name: 'web 370x288 200% text', size: { width: 370, height: 288 }, scale: 1, text: '200%' },
  { name: 'web 390x288 200% text', size: { width: 390, height: 288 }, scale: 1, text: '200%' },
  { name: 'web 370x345 200% text', size: { width: 370, height: 345 }, scale: 1, text: '200%' },
];

// Inter comes from a local copy rather than Google Fonts, so how long the font takes to arrive (6.5s on one slow
// network) is not a prerequisite of any case here. The late-font cases below control their own reflow.
test.beforeEach(async ({ page }) => {
  await serveInter(page);
});

/** An unsent draft with the acceptance repository selected, typed to its end; returns the field's value. */
async function writeDraft(page: Page, dialog: Locator, field: Locator) {
  const repository = dialog.getByText('Select a repository', { exact: true });
  if (await repository.isVisible()) {
    await repository.click();
    await page.getByRole('button', { name: /acme.*billing/ }).click();
  }
  await field.fill(draft);
  await field.press('End');
  await field.pressSequentially('.');
  return `${draft}.`;
}

/** Whether the header sticks, and whether the tallest of `actions` fits whole in the pane below it. */
const headerFit = (dialog: Locator, actions: string[]) => dialog.evaluate((pane, names) => {
  const header = pane.querySelector('header')!;
  const heights = Array.from(pane.querySelectorAll('button')).filter(button => names.includes(button.textContent!.trim())).map(button => button.getBoundingClientRect().height);
  return { sticky: getComputedStyle(header).position === 'sticky', fits: pane.clientHeight - header.getBoundingClientRect().height + 0.5 >= Math.max(...heights) };
}, actions);

/** The whole 44px action is drawn and takes a press at each sampled point, not just at its centre. */
async function expectWhole(action: Locator) {
  await settled(action);
  const { top, bottom } = await uncovered(action);
  expect(top, `${action} starts inside the pane`).toBeGreaterThanOrEqual(-0.5);
  expect(bottom, `${action} ends inside the pane`).toBeGreaterThanOrEqual(-0.5);
  expect((await action.boundingBox())!.height).toBeGreaterThanOrEqual(43.5);
  expect(await strayPoints(action)).toEqual([]);
}

/** A return trip's destination is wholly in view below any sticky header and takes a press at its centre. */
async function expectShown(target: Locator) {
  await settled(target);
  const { top, bottom } = await uncovered(target);
  expect(top, `${target} starts in view`).toBeGreaterThanOrEqual(-0.5);
  expect(bottom, `${target} ends in view`).toBeGreaterThanOrEqual(-0.5);
  expect(await target.evaluate(element => {
    const box = element.getBoundingClientRect();
    return element.contains(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2));
  }), `${target} is not covered`).toBe(true);
}

/** Where the caret's line of glyphs sits in what the reader sees, wrapped as the field wraps it (enlarged text wraps the draft's lines). */
const caretShown = (field: Locator) => field.evaluate(element => {
  const area = element as HTMLTextAreaElement;
  const style = getComputedStyle(area);
  const lineHeight = parseFloat(style.lineHeight);
  // A mirror of the field's text box up to the caret, with the field's width, font and wrapping.
  const mirror = document.createElement('div');
  for (const property of ['boxSizing', 'width', 'paddingLeft', 'paddingRight', 'borderLeftWidth', 'borderRightWidth', 'fontFamily', 'fontSize', 'fontWeight', 'letterSpacing', 'lineHeight', 'tabSize', 'overflowWrap', 'wordBreak'] as const) mirror.style[property] = style[property];
  Object.assign(mirror.style, { position: 'absolute', visibility: 'hidden', top: '0', left: '0', whiteSpace: 'pre-wrap', borderStyle: 'solid', paddingTop: '0', paddingBottom: '0', borderTopWidth: '0', borderBottomWidth: '0' });
  // The field's scrollbar narrows its text box.
  mirror.style.width = `${area.getBoundingClientRect().width - (area.offsetWidth - area.clientWidth - parseFloat(style.borderLeftWidth) - parseFloat(style.borderRightWidth))}px`;
  mirror.textContent = area.value.slice(0, area.selectionStart);
  const marker = mirror.appendChild(document.createElement('span'));
  marker.textContent = '\u200b';
  document.body.appendChild(mirror);
  const line = Math.round(marker.offsetTop / lineHeight);
  mirror.remove();
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

/** The caret is at the end of the draft, where typing or Control+End put it, and its line is wholly in view. */
async function expectCaret(field: Locator) {
  await settled(field);
  expect(await field.evaluate(element => {
    const area = element as HTMLTextAreaElement;
    return area.selectionStart === area.value.length && area.selectionEnd === area.value.length;
  }), 'the caret is at the end of the draft').toBe(true);
  const caret = await caretShown(field);
  expect(caret.top, 'the caret line starts in view').toBeGreaterThanOrEqual(-0.5);
  expect(caret.bottom, 'the caret line ends in view').toBeGreaterThanOrEqual(-0.5);
}

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
        // Where the header scrolls away, the focused field may have taken it out of view; the reader scrolls back up.
        await wheelToShow(page, close);
        // The native titlebar stays the window's, and the shell keeps its 40px close control.
        await expectClearOfChrome(page, dialog, close, shell, 40);
        if (shell.header) {
          const position = await dialog.locator('header').evaluate(header => getComputedStyle(header).position);
          expect(position, 'the header sticks only where a whole action fits beneath it').toBe(shell.header === 'sticky' ? 'sticky' : 'static');
        }

        const typed = await writeDraft(page, dialog, field);
        await expect(field).toHaveValue(typed);
        await expectCaret(field);
        const actions = form.actions.map(name => dialog.getByRole('button', { name, exact: true }));
        const run = actions.at(-1)!;
        await expect(run).toBeEnabled();
        // However the header and the actions wrap, it sticks only where its tallest whole action fits below it. A
        // taller pane, past the 20rem short band, keeps a static header even where an action would fit, so a fit
        // does not require a sticky header; the explicit `header` windows pin which side of the band each is on.
        const fit = await headerFit(dialog, form.actions);
        if (fit.sticky) expect(fit.fits, 'the header sticks only where its tallest action fits whole beneath it').toBe(true);

        // A wheel over the pane reaches each whole action, then scrolls back up to the start of the field.
        for (const action of actions) {
          await wheelToShow(page, action);
          await expectWhole(action);
        }
        await capture(page, `creation-short-window-${form.path.split('/')[1].replace(/\?.*/, '')}-${shell.name.replace(/[ .]/g, '-')}`);
        const label = dialog.getByText(form.field, { exact: true });
        await wheelToShow(page, label);
        await expectShown(label);

        // Touch drags travel the same way, back down to the submit action and up to the repository.
        if (browserName === 'chromium') {
          const touch = await page.context().newCDPSession(page);
          await dragToShow(page, touch, run);
          await expectWhole(run);
          const repositoryButton = dialog.getByRole('button', { name: /acme.*billing/ }).first();
          await dragToShow(page, touch, repositoryButton);
          await expectShown(repositoryButton);
        }

        // Keyboard focus scrolls the submit action wholly into view, and focusing the field brings its caret back.
        await run.focus();
        await expect(run).toBeFocused();
        await expectWhole(run);
        await field.focus();
        await field.press('Control+End');
        await expectCaret(field);

        // Nothing was lost or sent, and the window controls still belong to the window.
        await expect(field).toHaveValue(typed);
        await expect(dialog.getByRole('button', { name: /acme.*billing/ }).first()).toBeVisible();
        await wheelToShow(page, close);
        await expectClearOfChrome(page, dialog, close, shell, 40);
        if (shell.platform === 'linux') expect(await inert(page.getByRole('group', { name: 'Window controls' }))).toBe(false);
        expect(requests.filter(request => !request.startsWith('GET '))).toEqual([]);
      });
    }
  });
}

// The reviewer's executed probe on b23ee74: set up at 370×345, then the window shrinks to 370×130 with no keyboard.
// That leaves a 106px pane (the layer's 12px padding either side) whose 73px header, if it stayed sticky, would
// leave 31px for the 44px enabled action, so at maximum scroll only 15px of it showed beneath the header.
test.describe('web 370x345 resized to 370x130', () => {
  test.use({ viewport: zoomed, deviceScaleFactor: 1, hasTouch: true });

  for (const form of forms) {
    test(`web 370x345 resized to 370x130: ${form.name} shows its whole enabled action at maximum wheel scroll`, async ({ page }) => {
      test.setTimeout(60_000);
      const requests = await newTaskFixture(page);
      await stubGoals(page);
      await page.goto(form.path);
      const dialog = page.getByRole('dialog', { name: form.name });
      const field = dialog.getByLabel(form.field, { exact: true });
      await expect(field).toBeFocused();
      const repository = dialog.getByText('Select a repository', { exact: true });
      if (await repository.isVisible()) {
        await repository.click();
        await page.getByRole('button', { name: /acme.*billing/ }).click();
      }
      await field.focus();
      await field.pressSequentially('Unsent draft');
      const run = dialog.getByRole('button', { name: form.actions.at(-1)!, exact: true });
      await expect(run).toBeEnabled();

      await page.setViewportSize({ width: 370, height: 130 });
      await settle(page);
      const header = dialog.locator('header');
      expect((await dialog.boundingBox())!.height, 'the pane fills the layer inside its padding').toBeCloseTo(106, 0);
      expect((await header.boundingBox())!.height, 'the bordered pane keeps its 73px header').toBeCloseTo(73, 0);

      // Up to eighteen real wheel notches in the pane's gutter, until nothing around the action scrolls further down.
      for (let step = 0; step < 18; step++) {
        const point = await scrollPoint(run, false);
        if (!point) break;
        await page.mouse.move(point.x, point.y);
        await notch(page, run, 100);
      }
      const scroll = await dialog.evaluate(pane => ({ top: pane.scrollTop, max: pane.scrollHeight - pane.clientHeight }));
      expect(scroll.top, 'the wheel reached the end of the pane').toBeGreaterThanOrEqual(scroll.max - 1);
      await expectWhole(run);
      const headerBox = (await header.boundingBox())!;
      expect(headerBox.y + headerBox.height, 'the header is clear of the action').toBeLessThanOrEqual((await run.boundingBox())!.y + 0.5);
      expect(await header.evaluate(element => getComputedStyle(element).position), 'below the band the header scrolls away').toBe('static');

      // Wheeling back up returns the close control clear of the window's chrome, and nothing was sent.
      const close = dialog.getByRole('button', { name: form.close });
      await wheelToShow(page, close);
      await expectClearOfChrome(page, dialog, close, {}, 40);
      expect(requests.filter(request => !request.startsWith('GET '))).toEqual([]);
    });
  }
});

// The operator's run on e8940dc: the fallback font laid out the pane, the helper put its wheel pointer in the form's
// body, and only then did Inter arrive and wrap the actions, so that point fell outside the body's band and every
// notch at it left the field's label 304px out of view. Which fonts load and how they set is host-dependent, so here
// one stylesheet keeps the actions on one row and, once the pointer is in place, a late one sets the header 7.5rem
// taller and spaces the action labels until they wrap: on every host the body moves out from under the pointer.
const lateFont = {
  fallback: '[data-creation-actions] > * { font-size: 9px !important; letter-spacing: 0 !important; }',
  loaded: '[role="dialog"] header { padding-bottom: 7.5rem !important; } [data-creation-actions] > * { letter-spacing: 1em !important; }',
};
test.describe('web 370x345 late font', () => {
  test.use({ viewport: zoomed, deviceScaleFactor: 1, hasTouch: true });

  for (const form of forms) {
    test(`web 370x345 late font: ${form.name} keeps every whole action and the caret in reach when the pane re-lays out mid-scroll`, async ({ page, browserName }) => {
      test.setTimeout(60_000);
      const requests = await newTaskFixture(page);
      await stubGoals(page);
      await page.goto(form.path);
      const fallback = await page.addStyleTag({ content: lateFont.fallback });
      const dialog = page.getByRole('dialog', { name: form.name });
      const field = dialog.getByLabel(form.field, { exact: true });
      await expect(field).toBeFocused();
      const typed = await writeDraft(page, dialog, field);
      const actions = form.actions.map(name => dialog.getByRole('button', { name, exact: true }));
      const run = actions.at(-1)!;
      await expect(run).toBeEnabled();
      for (const action of actions) {
        await wheelToShow(page, action);
        await expectWhole(action);
      }

      // The font arrives after the helper has placed its pointer for the first notch up to the label.
      const body = dialog.locator('form > div').first();
      const label = dialog.getByText(form.field, { exact: true });
      const footer = dialog.locator('[data-creation-actions]');
      const oneRow = (await footer.boundingBox())!.height;
      let stale: { x: number; y: number } | undefined;
      await wheelToShow(page, label, async point => {
        if (stale) return;
        stale = point;
        expect(await body.evaluate((element, [x, y]) => element.contains(document.elementFromPoint(x, y)), [point.x, point.y]), 'the pointer starts over the body').toBe(true);
        await fallback.evaluate(element => (element as HTMLStyleElement).remove());
        await page.addStyleTag({ content: lateFont.loaded });
        await settle(page);
        expect((await footer.boundingBox())!.height, 'the late font wraps the actions').toBeGreaterThan(oneRow + 40);
        expect(await body.evaluate((element, [x, y]) => element.contains(document.elementFromPoint(x, y)), [point.x, point.y]), 'the body moved out from under the pointer').toBe(false);
        expect(await dialog.evaluate(pane => pane.scrollTop), 'and the pane has nothing above to scroll to').toBe(0);
      });
      expect(stale, 'the transition happened mid-scroll').toBeDefined();
      await expectShown(label);

      // Wheel, touch and keyboard still reach every whole action, the repository and the caret in the new layout.
      for (const action of actions) {
        await wheelToShow(page, action);
        await expectWhole(action);
      }
      if (browserName === 'chromium') {
        const touch = await page.context().newCDPSession(page);
        const repositoryButton = dialog.getByRole('button', { name: /acme.*billing/ }).first();
        await dragToShow(page, touch, repositoryButton);
        await expectShown(repositoryButton);
        await dragToShow(page, touch, run);
        await expectWhole(run);
      }
      await run.focus();
      await expectWhole(run);
      await field.focus();
      await field.press('Control+End');
      await expectCaret(field);
      await expect(field).toHaveValue(typed);
      await expect(dialog.getByRole('button', { name: /acme.*billing/ }).first()).toBeVisible();
      expect(requests.filter(request => !request.startsWith('GET '))).toEqual([]);
    });
  }
});

// Real sequential keyboard navigation at the issue's geometry: Tab and Shift+Tab go through the browser's focus
// order and the dialog's wrap-around handler rather than focusing a control directly, and each step brings the
// focused action wholly into view below the header and, going back, the field's caret.
const issueWindow = windows[0];
test.describe(`${issueWindow.name} Tab traversal`, () => {
  test.use({ viewport: issueWindow.size, deviceScaleFactor: issueWindow.scale, hasTouch: true });

  for (const form of forms) {
    test(`${issueWindow.name}: ${form.name} Tab and Shift+Tab bring each whole action and the caret into view`, async ({ page }) => {
      test.setTimeout(60_000);
      await desktopFixture(page, issueWindow.platform!);
      await installWindowActions(page, issueWindow);
      const requests = await newTaskFixture(page);
      await stubGoals(page);
      await page.goto(form.path);
      const dialog = page.getByRole('dialog', { name: form.name });
      const close = dialog.getByRole('button', { name: form.close });
      const field = dialog.getByLabel(form.field, { exact: true });
      await expect(field).toBeFocused();
      // Focus has to land below a header that stays put, not one that scrolls away with the form.
      expect(await dialog.locator('header').evaluate(header => getComputedStyle(header).position), 'the header sticks here').toBe('sticky');
      const typed = await writeDraft(page, dialog, field);
      const actions = form.actions.map(name => dialog.getByRole('button', { name, exact: true }));
      const run = actions.at(-1)!;
      await expect(run).toBeEnabled();
      const focused = (target: Locator) => target.evaluate(element => element === document.activeElement);
      const tabTo = async (target: Locator, key: 'Tab' | 'Shift+Tab') => {
        for (let step = 0; step < 40 && !(await focused(target)); step++) await page.keyboard.press(key);
        await expect(target).toBeFocused();
        await settle(page);
      };

      // Forward from the field, each action in turn takes focus and is scrolled wholly into view.
      for (const action of actions) {
        await tabTo(action, 'Tab');
        await expectWhole(action);
      }
      // Past the last control, focus wraps to the close button, shown clear of the window's chrome; Shift+Tab from it
      // wraps back to the submit action, whole again.
      await tabTo(close, 'Tab');
      await expectShown(close);
      await expectClearOfChrome(page, dialog, close, issueWindow, 40);
      await page.keyboard.press('Shift+Tab');
      await expect(run).toBeFocused();
      await settle(page);
      await expectWhole(run);
      // Back through the actions to the field, whose caret comes back into view.
      for (const action of actions.slice(0, -1).reverse()) {
        await tabTo(action, 'Shift+Tab');
        await expectWhole(action);
      }
      await tabTo(field, 'Shift+Tab');
      await field.press('Control+End');
      await expectCaret(field);

      await expect(field).toHaveValue(typed);
      await expect(dialog.getByRole('button', { name: /acme.*billing/ }).first()).toBeVisible();
      expect(await inert(page.getByRole('group', { name: 'Window controls' }))).toBe(false);
      expect(requests.filter(request => !request.startsWith('GET '))).toEqual([]);
    });
  }
});
