/** The shared creation shell (New Task, New Goal) stays inside the visible area while an on-screen keyboard shrinks and pans the visual viewport. */
import { expect, test, type CDPSession, type Locator, type Page } from '@playwright/test';
import { fixture } from './new-task.fixture';
import { captureVisible, expectFieldVisible, expectShown, expectUnframed, expectVisible, installKeyboardViewport, listenerCount, setKeyboard, type Band, type Clipping } from './keyboard-viewport.fixture';

// Measured on a Samsung phone in Chrome: the layout viewport stays 384×692 while the
// keyboard leaves a 382px visual viewport panned 186px down to the focused prompt.
const layout = { width: 384, height: 692 };
const keyboard = { height: 382.133, offsetTop: 186.133 };
const draft = 'Disposable draft typed above the keyboard';

// Measured on an Android 16 Pixel 5 emulator in Chrome with Gboard in landscape: an 851×289 layout
// viewport leaves a 65px band at the top, too short for the 41px header and a 44px action together.
const shortLayout = { width: 851, height: 289 };
const shortKeyboard: Band = { height: 65.09091186523438, offsetTop: 0 };

// Measured on a Samsung SM-S908B (Android 16) in landscape: the layout viewport is 748×298 and
// the keyboard (not an OS fullscreen editor) leaves an 89px band 208px down.
const landscapeLayout = { width: 748, height: 298 };
const landscapeKeyboard: Band = { height: 89.333, offsetTop: 208.533 };

const shells = [
  { name: 'New task', path: '/tasks/new', close: 'Close task creation', actions: ['Cancel', 'Plan first', 'Run task'], preview: 'new-task', agent: 'codex',
    description: 'Describe the change you want. Run task creates an issue and starts implementation.' },
  { name: 'Start a goal', path: '/goals?new=1', close: 'Close goal creation', actions: ['Cancel', 'Start goal'], preview: 'new-goal', agent: 'agent-1',
    description: 'Your reusable session settings are remembered after creation.' },
];

test.use({ viewport: layout, isMobile: true, hasTouch: true });

async function stubGoals(page: Page) {
  await page.route('**/api/goals', route => route.request().method() === 'GET' ? route.fulfill({ json: { goals: [] } }) : route.fallback());
  await page.route('**/api/goals/capabilities', route => route.fulfill({ json: { agents: [{
    agentId: 'agent-1', agentAlias: 'codex', agentType: 'codex', goalCapable: true,
    lifecycle: { launch: 'native-goal', resume: 'native-goal', runningInput: 'live-steer' },
    controls: { liveInput: true, inputAtBoundary: true, modelAtBoundary: true, pauseAtBoundary: true },
    models: ['gpt-6-astra'], defaultModel: 'gpt-6-astra',
  }] } }));
}

for (const shell of shells) {
  test(`${shell.name} keeps its header, prompt and actions above a panned keyboard and restores after it closes`, async ({ page }) => {
    await installKeyboardViewport(page, layout);
    const requests = await fixture(page);
    await stubGoals(page);
    await page.goto(shell.path);
    const dialog = page.getByRole('dialog', { name: shell.name });
    const prompt = dialog.getByLabel('Prompt', { exact: true });
    const heading = dialog.getByRole('heading', { name: shell.name });
    const close = dialog.getByRole('button', { name: shell.close });
    const layer = page.locator('body > .app-modal-layer');
    await expect(prompt).toBeFocused();
    const before = (await close.boundingBox())!;
    const full = { height: layout.height, offsetTop: 0 };
    await expectShown([heading, close], full);
    await expectVisible([prompt], full);

    await setKeyboard(page, keyboard);
    await prompt.pressSequentially(draft);
    await expectShown([heading, close], keyboard);
    await expectVisible([layer], keyboard);
    await expectFieldVisible(prompt, keyboard);
    await expect(prompt).toBeFocused();
    await captureVisible(page, `${shell.preview}-keyboard-open`, keyboard);

    // The form body still scrolls to every action inside the shortened pane.
    for (const name of shell.actions) {
      const action = dialog.getByRole('button', { name, exact: true });
      await action.scrollIntoViewIfNeeded();
      await expectShown([action], keyboard);
    }
    await expectShown([heading, close], keyboard);

    // A pan without a resize (the browser following the caret) is followed too, and so is
    // a resize alone (the keyboard's suggestion strip closing) at the same offset.
    const panned = { height: keyboard.height, offsetTop: 96 };
    await setKeyboard(page, panned, ['scroll']);
    await expectShown([heading, close], panned);
    await expectVisible([layer], panned);
    const taller = { height: 430, offsetTop: 96 };
    await setKeyboard(page, taller, ['resize']);
    await expectShown([heading, close], taller);
    await expectVisible([layer], taller);

    // Dismissing the keyboard restores the stylesheet geometry and keeps the draft.
    await setKeyboard(page, full);
    await expect(layer).toHaveAttribute('style', /^(?![\s\S]*(top|height|bottom))/);
    const after = (await close.boundingBox())!;
    expect(after.y).toBeCloseTo(before.y, 0);
    expect(after.height).toBe(40);
    await expect(prompt).toHaveValue(draft);
    expect(requests.filter(request => !request.startsWith('GET '))).toEqual([]);
  });
}

test('New task opened with the keyboard up is placed from the current viewport, and closing removes its listeners', async ({ page }) => {
  await installKeyboardViewport(page, layout);
  await fixture(page);
  await page.goto('/tasks');
  const idle = await listenerCount(page);
  await page.goto('/tasks/new');
  const dialog = page.getByRole('dialog', { name: 'New task' });
  await expect(dialog.getByLabel('Prompt', { exact: true })).toBeFocused();
  expect(await listenerCount(page)).toBeGreaterThan(idle);

  // Rotate with the keyboard still open: the window resizes and the visible band moves.
  await page.setViewportSize({ width: layout.height, height: layout.width });
  const landscape = { height: 180, offsetTop: 204 };
  await setKeyboard(page, landscape);
  await expectShown([dialog.getByRole('heading', { name: 'New task' }), dialog.getByRole('button', { name: 'Close task creation' })], landscape);

  await dialog.getByRole('button', { name: 'Close task creation' }).click();
  await expect(page).toHaveURL(/\/tasks$/);
  await expect(dialog).toBeHidden();
  expect(await listenerCount(page)).toBe(idle);

  // Reopening while the keyboard band is still offset starts inside it, not at the stale or default position.
  await page.setViewportSize(layout);
  await setKeyboard(page, keyboard);
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await page.getByRole('navigation', { name: 'Create' }).getByRole('link', { name: 'New Task' }).click();
  await expect(dialog).toBeVisible();
  await expectShown([dialog.getByRole('heading', { name: 'New task' }), dialog.getByRole('button', { name: 'Close task creation' })], keyboard);
});

/** The part of `target` the reader sees: inside the band, below the pane's header (unless in it), and not clipped by a scroll area. */
const uncovered = async (target: Locator, header: Locator, band: Band) => header.evaluate((head, [element, { offsetTop, height }]) => {
  let low = head.contains(element) ? offsetTop : Math.max(offsetTop, head.getBoundingClientRect().bottom);
  let high = offsetTop + height;
  for (const clip of (window as unknown as Clipping).__clips(element)) {
    low = Math.max(low, clip.top); high = Math.min(high, clip.bottom);
  }
  const box = element.getBoundingClientRect();
  return { top: box.top - low, bottom: high - box.bottom, shown: Math.min(high, box.bottom) - Math.max(low, box.top) };
}, [await target.elementHandle(), band] as const);

/**
 * Brings `target` wholly into view below the pane's sticky header, then checks it is drawn
 * there and is what a tap at its centre reaches. Chromium scrolls with trusted touch drags on
 * the pane, as a finger would; Playwright has no trusted touch or wheel input for mobile WebKit,
 * so there the browser's own scroll-into-view (which honours the pane's scroll padding) moves it.
 */
async function scrollToShow(page: Page, touch: CDPSession | null, header: Locator, target: Locator, band: Band) {
  if (touch) {
    // The finger rests in the pane's side padding, below the header, so no drag starts on a control.
    const headerBox = (await header.boundingBox())!;
    const x = Math.round(headerBox.x + 8);
    // A header that scrolls with the pane (the shortest bands) may have left the band entirely.
    const y = Math.round((Math.max(headerBox.y + headerBox.height, band.offsetTop) + band.offsetTop + band.height) / 2);
    for (let step = 0; step < 40; step++) {
      const { top, bottom } = await uncovered(target, header, band);
      if (top >= -0.5 && bottom >= -0.5) break;
      // A finger moving up reveals what is below, and down what is above. Chromium starts scrolling only
      // past its 15px touch slop (a shorter drag is a tap), and slow drags do not fling.
      const need = Math.min(Math.ceil(top < 0 ? -top : -bottom) + 1, 30);
      const distance = (top < 0 ? 1 : -1) * (15 + need);
      await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: y - distance / 2 }] });
      for (let move = 1; move <= 8; move++) await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: Math.round(y - distance / 2 + distance * move / 8) }] });
      await page.waitForTimeout(50);
      await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    }
  } else {
    await target.scrollIntoViewIfNeeded();
  }
  const { top, bottom } = await uncovered(target, header, band);
  expect(top, `${target} starts below the sticky header`).toBeGreaterThanOrEqual(-0.5);
  expect(bottom, `${target} ends above the keyboard`).toBeGreaterThanOrEqual(-0.5);
  await expectShown([target], band);
}

for (const shell of shells) {
  test(`${shell.name} stays usable in the measured 89px landscape keyboard band, then restores in portrait`, async ({ page, browserName }) => {
    await installKeyboardViewport(page, layout);
    const requests = await fixture(page);
    await stubGoals(page);
    await page.goto(shell.path);
    const dialog = page.getByRole('dialog', { name: shell.name });
    const header = dialog.locator('header');
    const heading = dialog.getByRole('heading', { name: shell.name });
    const close = dialog.getByRole('button', { name: shell.close });
    const prompt = dialog.getByLabel('Prompt', { exact: true });
    const layer = page.locator('body > .app-modal-layer');
    await expect(prompt).toBeFocused();
    // Scrolling a pane this short by touch takes many drags.
    test.setTimeout(90_000);
    const touch = browserName === 'chromium' ? await page.context().newCDPSession(page) : null;

    // A draft with a repository and a model, made in portrait.
    const repository = dialog.getByText('Select a repository', { exact: true });
    if (await repository.isVisible()) {
      await repository.click();
      await page.getByRole('button', { name: /acme.*billing/ }).click();
    }
    await prompt.fill(draft);
    await dialog.locator('summary', { hasText: 'Advanced Options' }).click();
    const agent = dialog.getByLabel('Agent', { exact: true });
    const model = dialog.getByLabel('Model', { exact: true });
    await agent.selectOption(shell.agent);
    await model.selectOption('gpt-6-astra');
    const run = dialog.getByRole('button', { name: shell.actions.at(-1), exact: true });
    await expect(run).toBeEnabled();

    // Rotating dismisses the keyboard; the reader focuses Prompt again and it reopens.
    await page.setViewportSize(landscapeLayout);
    await setKeyboard(page, { height: landscapeLayout.height, offsetTop: 0 });
    await prompt.focus();
    await setKeyboard(page, landscapeKeyboard);
    await expectVisible([layer], landscapeKeyboard);
    await expectShown([heading, close], landscapeKeyboard);
    expect((await close.boundingBox())!.height).toBe(40);
    expect(await header.evaluate(element => getComputedStyle(element).position)).toBe('sticky');
    await expect(prompt).toBeFocused();
    // The focused prompt shows its start below the header rather than under it.
    const field = await uncovered(prompt, header, landscapeKeyboard);
    expect(field.shown, 'visible prompt height').toBeGreaterThanOrEqual(24);
    await captureVisible(page, `${shell.preview}-landscape-keyboard`, landscapeKeyboard);

    // Every field and action is reached by scrolling the pane, down to the actions and back
    // up to the repository, while the close control stays where it is.
    const targets = [model, ...shell.actions.map(name => dialog.getByRole('button', { name, exact: true })), agent, dialog.getByRole('button', { name: /billing/ }).first()];
    for (const target of targets) {
      await scrollToShow(page, touch, header, target, landscapeKeyboard);
      await expectShown([heading, close], landscapeKeyboard);
    }
    await expect(prompt).toBeFocused();

    // Dismissing the keyboard and reopening it frames the pane again; nothing was lost.
    await setKeyboard(page, { height: landscapeLayout.height, offsetTop: 0 });
    await expectUnframed(layer);
    await prompt.focus();
    await setKeyboard(page, landscapeKeyboard);
    await expectShown([heading, close], landscapeKeyboard);
    await scrollToShow(page, touch, header, run, landscapeKeyboard);
    await captureVisible(page, `${shell.preview}-landscape-keyboard-actions`, landscapeKeyboard);

    // Back in portrait with the keyboard closed, the shell lays out as before with the draft intact.
    await setKeyboard(page, { height: landscapeLayout.height, offsetTop: 0 });
    await page.setViewportSize(layout);
    await setKeyboard(page, { height: layout.height, offsetTop: 0 });
    await expectUnframed(layer);
    const portrait = { height: layout.height, offsetTop: 0 };
    await expectShown([heading, close, dialog.getByText(shell.description, { exact: true })], portrait);
    await expect(prompt).toHaveValue(draft);
    await expect(agent).toHaveValue(shell.agent);
    await expect(model).toHaveValue('gpt-6-astra');
    await expect(dialog.getByRole('button', { name: /billing/ }).first()).toBeVisible();
    for (const name of shell.actions) await expectShown([dialog.getByRole('button', { name, exact: true })], portrait);
    expect(await dialog.evaluate(element => getComputedStyle(element).overflowY)).toBe('hidden');
    expect(requests.filter(request => !request.startsWith('GET '))).toEqual([]);
  });
}

/**
 * Where the line holding `field`'s caret sits relative to what the reader sees (inside the band, below the
 * sticky header, inside every scroll area): `top`/`bottom` are non-negative when the whole line shows. The
 * draft's lines are too short to wrap, so the caret's line is the number of line breaks before it.
 */
const caretShown = async (field: Locator, header: Locator, band: Band) => header.evaluate((head, [element, { offsetTop, height }]) => {
  const area = element as HTMLTextAreaElement;
  let low = Math.max(offsetTop, head.getBoundingClientRect().bottom);
  let high = offsetTop + height;
  for (let parent = area.parentElement; parent; parent = parent.parentElement) {
    if (!/(auto|scroll|hidden|clip)/.test(getComputedStyle(parent).overflowY)) continue;
    const clip = parent.getBoundingClientRect();
    low = Math.max(low, clip.top); high = Math.min(high, clip.bottom);
  }
  const style = getComputedStyle(area);
  const lineHeight = parseFloat(style.lineHeight);
  const index = area.value.slice(0, area.selectionEnd).split('\n').length - 1;
  const lineTop = area.getBoundingClientRect().top + area.clientTop + parseFloat(style.paddingTop) + index * lineHeight - area.scrollTop;
  return { top: lineTop - low, bottom: high - (lineTop + lineHeight), fieldTop: area.getBoundingClientRect().top - low };
}, [await field.elementHandle(), band] as const);

for (const shell of shells) {
  test(`${shell.name} keeps the caret's line of a long draft in view as the 89px landscape band pans and resizes`, async ({ page }) => {
    await installKeyboardViewport(page, landscapeLayout);
    await fixture(page);
    await stubGoals(page);
    await page.setViewportSize(landscapeLayout);
    await page.goto(shell.path);
    const dialog = page.getByRole('dialog', { name: shell.name });
    const header = dialog.locator('header');
    const heading = dialog.getByRole('heading', { name: shell.name });
    const close = dialog.getByRole('button', { name: shell.close });
    const field = dialog.getByLabel('Prompt', { exact: true });
    await expect(field).toBeFocused();
    const lines = Array.from({ length: 12 }, (_, line) => `Draft line ${line + 1}`);
    await field.fill(lines.join('\n'));
    // The caret goes to the end of line 9, well below what fits under the header.
    await field.evaluate((element, at) => (element as HTMLTextAreaElement).setSelectionRange(at, at), lines.slice(0, 9).join('\n').length);
    const expectCaretShown = async (band: Band) => {
      const { top, bottom, fieldTop } = await caretShown(field, header, band);
      expect(top, 'the caret line starts below the sticky header').toBeGreaterThanOrEqual(-0.5);
      expect(bottom, 'the caret line ends above the keyboard').toBeGreaterThanOrEqual(-0.5);
      // Showing the editing line means the field's start has scrolled away.
      expect(fieldTop).toBeLessThan(0);
      await expectShown([heading, close], band);
    };

    await setKeyboard(page, landscapeKeyboard);
    await expectCaretShown(landscapeKeyboard);
    // The reader scrolls the pane a little further down; the editing line still shows and stays put.
    const pane = header.locator('..');
    await pane.evaluate(element => { element.scrollTop += 2; });
    await expectCaretShown(landscapeKeyboard);
    const kept = await pane.evaluate(element => element.scrollTop);

    // A pan alone, then a resize alone, each change the frame.
    const panned: Band = { height: landscapeKeyboard.height, offsetTop: 200 };
    await setKeyboard(page, panned, ['scroll']);
    await expectCaretShown(panned);
    expect(await pane.evaluate(element => element.scrollTop)).toBe(kept);
    const taller: Band = { height: 107.866, offsetTop: 190 };
    await setKeyboard(page, taller, ['resize']);
    await expectCaretShown(taller);

    // Typing lands on the caret's line, which is still in view.
    await page.keyboard.type(' edited');
    await expect(field).toHaveValue([...lines.slice(0, 8), 'Draft line 9 edited', ...lines.slice(9)].join('\n'));
    await expectCaretShown(taller);
    await captureVisible(page, `${shell.preview}-landscape-caret-line`, taller);
  });
}

for (const shell of shells) {
  test(`${shell.name} stays usable in the measured 65px landscape keyboard band, scrolling its header away`, async ({ page, browserName }) => {
    await installKeyboardViewport(page, shortLayout);
    const requests = await fixture(page);
    await stubGoals(page);
    await page.setViewportSize(shortLayout);
    await page.goto(shell.path);
    const dialog = page.getByRole('dialog', { name: shell.name });
    const header = dialog.locator('header');
    const heading = dialog.getByRole('heading', { name: shell.name });
    const close = dialog.getByRole('button', { name: shell.close });
    const prompt = dialog.getByLabel('Prompt', { exact: true });
    const layer = page.locator('body > .app-modal-layer');
    await expect(prompt).toBeFocused();
    test.setTimeout(90_000);
    const touch = browserName === 'chromium' ? await page.context().newCDPSession(page) : null;

    const repository = dialog.getByText('Select a repository', { exact: true });
    if (await repository.isVisible()) {
      await repository.click();
      await page.getByRole('button', { name: /acme.*billing/ }).click();
    }
    const lines = Array.from({ length: 6 }, (_, line) => `Draft line ${line + 1}`);
    await prompt.fill(lines.join('\n'));
    await dialog.locator('summary', { hasText: 'Advanced Options' }).click();
    const agent = dialog.getByLabel('Agent', { exact: true });
    const model = dialog.getByLabel('Model', { exact: true });
    await agent.selectOption(shell.agent);
    await model.selectOption('gpt-6-astra');
    await prompt.focus();
    await prompt.evaluate((element, at) => (element as HTMLTextAreaElement).setSelectionRange(at, at), lines.slice(0, 4).join('\n').length);

    await setKeyboard(page, shortKeyboard);
    await expectVisible([layer], shortKeyboard);
    // The header scrolls with the pane instead of covering all but a sliver of it.
    expect(await header.evaluate(element => getComputedStyle(element).position)).toBe('static');
    await expect(prompt).toBeFocused();
    const caret = await caretShown(prompt, header, shortKeyboard);
    expect(caret.top, 'the caret line starts inside the band').toBeGreaterThanOrEqual(-0.5);
    expect(caret.bottom, 'the caret line ends above the keyboard').toBeGreaterThanOrEqual(-0.5);
    await captureVisible(page, `${shell.preview}-short-keyboard`, shortKeyboard);

    // Each action scrolls wholly into the band and takes a tap at its centre, 44px tall,
    // including at the pane's furthest scroll; the reader scrolls back up to Close.
    const pane = header.locator('..');
    const actions = shell.actions.map(name => dialog.getByRole('button', { name, exact: true }));
    for (const target of [model, ...actions]) await scrollToShow(page, touch, header, target, shortKeyboard);
    for (const action of actions) expect((await action.boundingBox())!.height).toBe(44);
    await pane.evaluate(element => { element.scrollTop = element.scrollHeight; });
    await expectShown([actions.at(-1)!], shortKeyboard);
    await captureVisible(page, `${shell.preview}-short-keyboard-actions`, shortKeyboard);
    for (const target of [agent, dialog.getByRole('button', { name: /billing/ }).first(), close]) await scrollToShow(page, touch, header, target, shortKeyboard);
    await expectShown([heading, close], shortKeyboard);
    expect((await close.boundingBox())!.height).toBe(40);
    await captureVisible(page, `${shell.preview}-short-keyboard-close`, shortKeyboard);
    await expect(prompt).toBeFocused();

    // Typing still lands on the caret's line and keeps it in view as the band resizes.
    await setKeyboard(page, { height: 70, offsetTop: 0 }, ['resize']);
    await page.keyboard.type(' edited');
    const edited = await caretShown(prompt, header, { height: 70, offsetTop: 0 });
    expect(edited.top).toBeGreaterThanOrEqual(-0.5);
    expect(edited.bottom).toBeGreaterThanOrEqual(-0.5);

    // Dismissing the keyboard restores the stylesheet layout with everything kept.
    await setKeyboard(page, { height: shortLayout.height, offsetTop: 0 });
    await expectUnframed(layer);
    await expect(prompt).toHaveValue([...lines.slice(0, 3), 'Draft line 4 edited', ...lines.slice(4)].join('\n'));
    await expect(agent).toHaveValue(shell.agent);
    await expect(model).toHaveValue('gpt-6-astra');
    expect(requests.filter(request => !request.startsWith('GET '))).toEqual([]);
  });
}
