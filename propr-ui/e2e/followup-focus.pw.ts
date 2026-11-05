/**
 * Follow Up on Task opened from the keyboard keeps Tab and Shift+Tab inside the dialog and
 * returns focus to the control that opened it on every way out: Escape, Cancel, Close,
 * the result's Close and a successful post. No follow-up leaves the browser.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { ago, fixture } from './task-list-desktop.fixture';
import { controlNames, installWindowActions, type Shell } from './native-chrome.fixture';

const taskId = 'issue-3314-run-0';
const title = 'Keep task Follow Up focus contained';

async function stubTask(page: Page, shell: Shell, posts: string[], outcome: 'receipt' | 'success') {
  await fixture(page, shell.platform);
  await installWindowActions(page, shell);
  await page.route(`**/api/task/${taskId}/history`, route => route.fulfill({ json: {
    history: [
      { state: 'PENDING', timestamp: ago(60) },
      { state: 'CLAUDE_EXECUTION', timestamp: ago(59) },
      { state: 'COMPLETED', timestamp: ago(51) },
    ],
    taskInfo: { title, type: 'issue', number: 3314, issueNumber: 3314, repoOwner: 'integry', repoName: 'propr',
      followupTarget: { taskId, repository: 'integry/propr', kind: 'issue', number: 3314 } },
  } }));
  await page.route(`**/api/task/${taskId}/live-details`, route => route.fulfill({ json: { events: [], todos: [], currentTask: null } }));
  // Recorded and answered here; nothing reaches GitHub.
  await page.route(`**/api/tasks/${taskId}/followup`, route => {
    posts.push(route.request().postDataJSON().body);
    return route.fulfill(outcome === 'success'
      ? { status: 202, json: { success: true, state: 'queued', posted: true, commentId: 3314001, sourceTaskId: taskId, message: 'Follow-up queued.' } }
      : { status: 202, json: { success: false, state: 'failed', posted: true, commentId: 3314002, sourceTaskId: taskId, message: 'Comment posted, but the command failed before submission.' } });
  });
}

/**
 * Focuses the Follow Up button, or on a phone the action sheet's trigger, and opens the
 * dialog with Enter. Returns the control focus belongs to once the dialog closes.
 */
async function openFromKeyboard(page: Page): Promise<{ dialog: Locator; invoker: Locator }> {
  const direct = page.locator('button[title^="Follow Up"]').filter({ visible: true }).first();
  const more = page.getByRole('button', { name: 'More task actions' }).filter({ visible: true }).first();
  await expect(direct.or(more).first()).toBeVisible();
  const invoker = await direct.count() ? direct : more;
  await invoker.focus();
  await expect(invoker).toBeFocused();
  await page.keyboard.press('Enter');
  if (invoker === more) {
    const item = page.getByRole('menuitem', { name: 'Follow Up', exact: true });
    await item.focus();
    await page.keyboard.press('Enter');
  }
  const dialog = page.getByRole('dialog', { name: 'Follow Up on Task' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('textbox', { name: 'Comment' })).toBeFocused();
  await markIsolatedRegions(page);
  return { dialog, invoker };
}

const compactBar = '[data-testid="task-mobile-compact-bar"]';
const preexisting = 'followup-preexisting-inert';

/**
 * A region the app had made inert before Follow Up opened. It sits beside the app root,
 * so the dialog's isolation walks past it; closing must leave it inert.
 */
async function addPreexistingInert(page: Page) {
  await page.evaluate(testId => {
    const region = document.createElement('div');
    region.dataset.testid = testId;
    region.inert = true;
    region.append(Object.assign(document.createElement('button'), { textContent: 'Unreachable' }));
    document.body.append(region);
  }, preexisting);
}

/**
 * Inert regions outside the phone's compact bar, whose inert state follows its own
 * scroll-driven visibility (checked separately by `expectCompactBarConsistent`).
 */
const stableInertRegions = (page: Page) => page.evaluate(bar => Array.from(document.querySelectorAll('[inert]'))
  .filter(element => !element.matches(bar))
  .map(element => element.outerHTML.slice(0, 120)), compactBar);

/**
 * Tags the regions Follow Up isolated: every outermost inert region beyond the ones that
 * were already inert. The task workspace must be inside one of them.
 */
async function markIsolatedRegions(page: Page) {
  const isolated = await page.evaluate(testId => {
    const owned = Array.from(document.querySelectorAll<HTMLElement>('[inert]'))
      .filter(element => !element.parentElement?.closest('[inert]') && element.dataset.testid !== testId);
    owned.forEach(element => { element.dataset.followupIsolated = ''; });
    const workspace = document.querySelector('[data-testid="task-workspace-scroll"]');
    return Boolean(workspace && owned.some(element => element.contains(workspace)));
  }, preexisting);
  expect(isolated).toBe(true);
}

async function expectCompactBarConsistent(page: Page) {
  const bar = page.locator(compactBar);
  if (!await bar.count()) return;
  const state = await bar.evaluate(element => ({
    inert: (element as HTMLElement).inert,
    hidden: element.getAttribute('aria-hidden') === 'true',
    invisible: element.classList.contains('invisible'),
  }));
  expect(state).toEqual({ inert: state.hidden, hidden: state.invisible, invisible: state.invisible });
}

async function expectTabCycle(page: Page, cycle: Locator[]) {
  for (const next of [...cycle.slice(1), cycle[0]]) {
    await page.keyboard.press('Tab');
    await expect(next).toBeFocused();
  }
  for (const previous of [...cycle].reverse()) {
    await page.keyboard.press('Shift+Tab');
    await expect(previous).toBeFocused();
  }
}

async function expectRestored(page: Page, dialog: Locator, invoker: Locator, baseline: string[]) {
  await expect(dialog).toHaveCount(0);
  await expect(invoker).toBeFocused();
  // Everything the dialog isolated is live again, the pre-existing region is still inert,
  // and nothing else was left inert.
  expect(await page.locator('[data-followup-isolated]').evaluateAll(regions => regions.filter(region => (region as HTMLElement).inert).length)).toBe(0);
  await expect(page.getByTestId(preexisting)).toHaveJSProperty('inert', true);
  expect(await stableInertRegions(page)).toEqual(baseline);
  await expectCompactBarConsistent(page);
}

async function openTask(page: Page) {
  await page.goto(`/tasks/${taskId}`);
  await expect(page.getByRole('heading', { name: title }).first()).toBeVisible();
  await addPreexistingInert(page);
  const baseline = await stableInertRegions(page);
  expect(baseline).toEqual([expect.stringContaining(preexisting)]);
  return baseline;
}

const layouts = [
  { name: 'desktop 1280x820', viewport: { width: 1280, height: 820 }, touch: false },
  { name: 'touch 390x844', viewport: { width: 390, height: 844 }, touch: true },
  { name: 'touch 320x640', viewport: { width: 320, height: 640 }, touch: true },
];

for (const layout of layouts) test.describe(layout.name, () => {
  test.use({ viewport: layout.viewport, isMobile: layout.touch, hasTouch: layout.touch });

  test('Tab stays inside Follow Up and every dismissal returns focus to its opener', async ({ page }) => {
    const posts: string[] = [];
    await stubTask(page, {}, posts, 'receipt');
    const baseline = await openTask(page);

    let { dialog, invoker } = await openFromKeyboard(page);
    const comment = dialog.getByRole('textbox', { name: 'Comment' });
    const close = dialog.getByRole('button', { name: 'Close follow-up dialog' });
    const cancel = dialog.getByRole('button', { name: 'Cancel' });
    const post = dialog.getByRole('button', { name: 'Post Comment' });
    await expect(comment).toHaveValue(/^Please address the following/);
    await expectTabCycle(page, [comment, cancel, post, close]);
    await page.keyboard.press('Escape');
    await expectRestored(page, dialog, invoker, baseline);

    ({ dialog, invoker } = await openFromKeyboard(page));
    await page.keyboard.press('Tab');
    await expect(cancel).toBeFocused();
    await page.keyboard.press('Enter');
    await expectRestored(page, dialog, invoker, baseline);

    ({ dialog, invoker } = await openFromKeyboard(page));
    await page.keyboard.press('Shift+Tab');
    await expect(close).toBeFocused();
    await page.keyboard.press('Enter');
    await expectRestored(page, dialog, invoker, baseline);

    // A posted comment whose command failed: the result takes focus, the cycle covers the
    // result's Close and skips the duplicate-blocked Post Comment, and Close restores the opener.
    ({ dialog, invoker } = await openFromKeyboard(page));
    await comment.fill('Synthetic follow-up for the focus check.');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await expect(post).toBeFocused();
    await page.keyboard.press('Enter');
    const alert = dialog.getByRole('alert');
    await expect(alert).toBeFocused();
    await expect(alert).toContainText('3314002');
    await expect(post).toBeDisabled();
    const resultClose = dialog.getByRole('button', { name: 'Close', exact: true });
    await page.keyboard.press('Tab');
    await expect(resultClose).toBeFocused();
    await expectTabCycle(page, [resultClose, close, comment]);
    await page.keyboard.press('Enter');
    await expectRestored(page, dialog, invoker, baseline);
    expect(posts).toEqual(['Synthetic follow-up for the focus check.']);
  });

  test('a successful post closes Follow Up and returns focus to its opener', async ({ page }) => {
    const posts: string[] = [];
    await stubTask(page, {}, posts, 'success');
    const baseline = await openTask(page);

    const { dialog, invoker } = await openFromKeyboard(page);
    await page.keyboard.press('ControlOrMeta+End');
    await page.keyboard.type('Rerun the focus checks.');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await expect(dialog.getByRole('button', { name: 'Post Comment' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expectRestored(page, dialog, invoker, baseline);
    expect(posts).toEqual(['Please address the following based on the previous task execution:\n\nRerun the focus checks.']);
  });
});

test.describe('Linux desktop window', () => {
  test.use({ viewport: { width: 1280, height: 820 } });

  test('window controls keep native Tab order while Follow Up is open', async ({ page }) => {
    const posts: string[] = [];
    await stubTask(page, { platform: 'linux' }, posts, 'receipt');
    const baseline = await openTask(page);

    const { dialog, invoker } = await openFromKeyboard(page);
    const [menu, minimize] = controlNames.map(name => page.getByRole('button', { name }));
    await menu.focus();
    await expect(menu).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(minimize).toBeFocused();
    await dialog.getByRole('textbox', { name: 'Comment' }).focus();
    await page.keyboard.press('Escape');
    await expectRestored(page, dialog, invoker, baseline);
    expect(posts).toEqual([]);
  });
});
