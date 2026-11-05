/** The task header's Prompt and Logs viewers: usable on phones, literal log search, and proper dialog semantics. */
import { expect, test, type Locator, type Page, type Route } from '@playwright/test';
import { ago, capture, fixture } from './task-list-desktop.fixture';
import { expectClearOfChrome, expectWorkspaceInert, installWindowActions, type Shell } from './native-chrome.fixture';

const taskId = 'issue-28-run-0';
const sessionId = 'session-issue-28-run-0';
const title = 'Make task Prompt and Logs dialogs usable on phones';
const fileName = 'issue-28-2026-10-17T21-15-00-788Z-conversation.json';
const eventsName = 'issue-28-2026-10-17T21-15-00-788Z-execution-events.log';
// Safe synthetic content served through the ordinary log list and content endpoints.
const logContent = JSON.stringify({ message: '[INFO] acceptance [payload]', next: 'next line' });
const prompt = {
  prompt: 'Please analyze and implement a solution for GitHub issue #28.\n\nKeep the change focused.',
  sessionId: 'session-issue-28-run-0-0123456789abcdef0123456789abcdef0123456789abcdef',
  model: 'claude-opus-5-5',
  timestamp: ago(52),
  isRetry: false,
  issueRef: { repoOwner: 'integry', repoName: 'propr-desktop-workspaces-and-fleet-routing', number: 28 },
};

async function stubTask(page: Page, shell: Shell = {}) {
  await fixture(page, shell.platform);
  await installWindowActions(page, shell);
  await page.route(`**/api/task/${taskId}/history`, route => route.fulfill({ json: {
    history: [
      { state: 'PENDING', timestamp: ago(60) },
      { state: 'CLAUDE_EXECUTION', timestamp: ago(59) },
      { state: 'COMPLETED', timestamp: ago(51), promptPath: `/api/execution/${sessionId}/prompt`, logsPath: `/api/execution/${sessionId}/logs` },
    ],
    taskInfo: { title, type: 'issue', number: 28, issueNumber: 28, repoOwner: 'integry', repoName: 'propr' },
  } }));
  await page.route(`**/api/task/${taskId}/live-details`, route => route.fulfill({ json: { events: [], todos: [], currentTask: null } }));
  await page.route(`**/api/execution/${sessionId}/prompt`, route => route.fulfill({ contentType: 'application/json', body: JSON.stringify(prompt) }));
  await page.route(`**/api/execution/${sessionId}/logs`, route => route.fulfill({ json: {
    sessionId, files: { conversation: `/var/log/propr/${fileName}`, events: `/var/log/propr/${eventsName}` },
  } }));
  await page.route(`**/api/execution/${sessionId}/logs/conversation`, route => route.fulfill({ contentType: 'text/plain', body: logContent }));
  await page.route(`**/api/execution/${sessionId}/logs/events`, route => route.fulfill({ contentType: 'text/plain', body: '[INFO] run started\n[INFO] run finished' }));
}

/** The header control that opens `label` — directly on wide screens, from the action sheet on phones — and the element focus returns to. */
async function open(page: Page, label: 'Prompt' | 'Logs', keyboard = false): Promise<Locator> {
  const direct = page.locator(`button[title="View ${label}"]`).filter({ visible: true });
  const more = page.getByRole('button', { name: 'More task actions' }).filter({ visible: true });
  await expect(direct.or(more).first()).toBeVisible();
  // The action sheet's rows carry the same title, so decide before it opens.
  const isDirect = (await direct.count()) > 0;
  const opener = isDirect ? direct.first() : more.first();
  const press = async (target: Locator) => {
    if (keyboard) { await target.focus(); await page.keyboard.press('Enter'); } else await target.click();
  };
  await press(opener);
  if (!isDirect) await press(page.getByRole('menuitem', { name: label }));
  return opener;
}

/** True when the element lies inside the viewport and is not clipped by a scrolling part of its dialog. */
async function fullyOnScreen(locator: Locator): Promise<boolean> {
  return locator.evaluate(element => {
    const box = element.getBoundingClientRect();
    if (box.top < 0 || box.left < 0 || box.bottom > window.innerHeight + 0.5 || box.right > window.innerWidth + 0.5) return false;
    const dialog = element.closest('[role="dialog"]');
    for (let parent = element.parentElement; parent && dialog?.contains(parent); parent = parent.parentElement) {
      const style = getComputedStyle(parent);
      if (!/(auto|scroll|hidden)/.test(style.overflowY) && !/(auto|scroll|hidden)/.test(style.overflowX)) continue;
      const clip = parent.getBoundingClientRect();
      if (box.top < clip.top - 0.5 || box.bottom > clip.bottom + 0.5 || box.left < clip.left - 0.5 || box.right > clip.right + 0.5) return false;
    }
    return true;
  });
}

async function expectNoOverflow(page: Page, dialog: Locator) {
  const width = page.viewportSize()!.width;
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  expect(await dialog.evaluate(element => element.scrollWidth - element.clientWidth)).toBe(0);
  const box = (await dialog.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(width + 0.5);
}

async function expectTarget(target: Locator) {
  const box = (await target.boundingBox())!;
  expect(box.width).toBeGreaterThanOrEqual(44);
  expect(box.height).toBeGreaterThanOrEqual(44);
  expect(await fullyOnScreen(target)).toBe(true);
}

const viewports = [
  { name: 'phone-320x640', width: 320, height: 640, stacked: true },
  { name: 'phone-390x844', width: 390, height: 844, stacked: true },
  { name: 'wide-1280x820', width: 1280, height: 820, stacked: false },
];

for (const viewport of viewports) {
  test(`${viewport.name}: Logs opens a long filename, searches literally and returns focus on close`, async ({ page }) => {
    const pageErrors: Error[] = [];
    page.on('pageerror', error => pageErrors.push(error));
    await page.setViewportSize(viewport);
    await stubTask(page);
    await page.goto(`/tasks/${taskId}`);
    await expect(page.getByRole('heading', { name: title }).first()).toBeVisible();

    const opener = await open(page, 'Logs');
    const dialog = page.getByRole('dialog', { name: 'Log Files' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute('aria-modal', 'true');
    const close = dialog.getByRole('button', { name: 'Close log files' });
    await expect(close).toBeFocused();
    await expectTarget(close);
    await expectClearOfChrome(page, dialog, close, {});

    // The long filename is readable in full and selectable.
    const file = dialog.getByRole('button', { name: new RegExp(fileName) });
    expect(await fullyOnScreen(file.getByText(fileName))).toBe(true);
    expect(await file.evaluate(element => element.scrollWidth - element.clientWidth)).toBe(0);
    await file.click();
    await expect(file).toHaveAttribute('aria-current', 'true');

    const heading = dialog.getByRole('heading', { name: fileName });
    const search = dialog.getByRole('textbox', { name: 'Search log' });
    await expect(heading).toBeVisible();
    await expect(dialog.getByTestId('log-file-content')).toContainText('[INFO] acceptance [payload]');
    expect(await fullyOnScreen(heading)).toBe(true);
    expect(await fullyOnScreen(search)).toBe(true);
    await expectNoOverflow(page, dialog);

    // Narrow screens stack the file list above the open file; wide ones keep it beside.
    const list = (await dialog.getByTestId('log-file-list').boundingBox())!;
    const headingBox = (await heading.boundingBox())!;
    if (viewport.stacked) expect(list.y + list.height).toBeLessThanOrEqual(headingBox.y);
    else expect(list.x + list.width).toBeLessThanOrEqual(headingBox.x);

    // Regex metacharacters are ordinary text: no error boundary, counts match highlights.
    const status = dialog.getByRole('status');
    const marks = dialog.getByTestId('log-file-content').locator('mark');
    for (const [query, count] of [['(', 0], ['\\', 0], ['.*', 0], ['[payload]', 1], ['[', 2]] as const) {
      await search.fill(query);
      await expect(status).toHaveText(count ? `1 / ${count}` : 'No matches');
      await expect(marks).toHaveCount(count);
      await expect(page.getByText('Something went wrong on this page')).toHaveCount(0);
    }
    for (const control of [dialog.getByRole('button', { name: 'Previous match' }), dialog.getByRole('button', { name: 'Next match' }), dialog.getByRole('button', { name: 'Clear log search' })]) {
      await expectTarget(control);
    }
    await expectNoOverflow(page, dialog);
    if (viewport.name !== 'phone-390x844') await capture(page, `task-logs-search-${viewport.name}`);

    await dialog.getByRole('button', { name: 'Next match' }).click();
    await expect(status).toHaveText('2 / 2');
    await expect(marks.nth(1)).toHaveAttribute('aria-current', 'true');
    await dialog.getByRole('button', { name: 'Next match' }).click();
    await expect(status).toHaveText('1 / 2');
    await dialog.getByRole('button', { name: 'Previous match' }).click();
    await expect(status).toHaveText('2 / 2');
    // Enter and Shift+Enter step through matches from the search box.
    await search.press('Enter');
    await expect(status).toHaveText('1 / 2');
    await search.press('Shift+Enter');
    await expect(status).toHaveText('2 / 2');
    // Matching ignores case; a new query starts at its first match.
    await search.fill('info');
    await expect(status).toHaveText('1 / 1');
    await expect(marks.first()).toHaveText('INFO');
    await dialog.getByRole('button', { name: 'Clear log search' }).click();
    await expect(search).toHaveValue('');
    await expect(marks).toHaveCount(0);
    await expect(status).toHaveCount(0);

    // Escape closes and returns focus to the opener.
    await search.fill('[');
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(opener).toBeFocused();

    // Reopened by keyboard: a fresh search, Tab stays inside, and Close returns focus again.
    await open(page, 'Logs', true);
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: new RegExp(fileName) }).click();
    await expect(search).toHaveValue('');
    await expectWorkspaceInert(page, dialog, [page.getByRole('heading', { name: title })]);
    await close.click();
    await expect(dialog).toHaveCount(0);
    await expect(opener).toBeFocused();

    await expect(page.getByText('Something went wrong on this page')).toHaveCount(0);
    expect(pageErrors).toEqual([]);
  });

  for (const text of ['default', 'enlarged'] as const) {
    test(`${viewport.name} ${text} text: Prompt is a named dialog whose close stays usable with long metadata`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await stubTask(page);
      await page.goto(`/tasks/${taskId}`);
      if (text === 'enlarged') await page.addStyleTag({ content: 'html { font-size: 150% !important; }' });
      await expect(page.getByRole('heading', { name: title }).first()).toBeVisible();

      const opener = await open(page, 'Prompt');
      const dialog = page.getByRole('dialog', { name: 'LLM Prompt' });
      await expect(dialog).toBeVisible();
      await expect(dialog).toHaveAttribute('aria-modal', 'true');
      const close = dialog.getByRole('button', { name: 'Close prompt' });
      await expect(close).toBeFocused();
      await expectTarget(close);
      await expectClearOfChrome(page, dialog, close, {});
      await expect(dialog).toContainText(prompt.sessionId);
      await expect(dialog).toContainText('integry/propr-desktop-workspaces-and-fleet-routing #28');
      // The model keeps its human-readable display name.
      await expect(dialog).not.toContainText('claude-opus-5-5');
      await expectNoOverflow(page, dialog);
      if (viewport.name === 'phone-320x640') await capture(page, `task-prompt-${viewport.name}-${text}`);

      await expectWorkspaceInert(page, dialog, [page.getByRole('heading', { name: title })]);
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
      await expect(opener).toBeFocused();

      await open(page, 'Prompt', true);
      await expect(dialog).toBeVisible();
      await close.click();
      await expect(dialog).toHaveCount(0);
      await expect(opener).toBeFocused();
    });
  }
}

test('phone 320x640: keyboard users can reach and scroll to the end of a long prompt', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await stubTask(page);
  const lines = Array.from({ length: 120 }, (_, index) => `Step ${index + 1}: keep the change focused.`);
  const longPrompt = { ...prompt, prompt: [...lines, 'Final prompt line'].join('\n') };
  await page.route(`**/api/execution/${sessionId}/prompt`, route => route.fulfill({ contentType: 'application/json', body: JSON.stringify(longPrompt) }));
  await page.goto(`/tasks/${taskId}`);
  await expect(page.getByRole('heading', { name: title }).first()).toBeVisible();

  await open(page, 'Prompt', true);
  const dialog = page.getByRole('dialog', { name: 'LLM Prompt' });
  const close = dialog.getByRole('button', { name: 'Close prompt' });
  const details = dialog.getByRole('region', { name: 'Prompt details' });
  await expect(close).toBeFocused();
  await expect(details.locator('pre')).toContainText('Final prompt line');
  expect(await details.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
  // Whether the end of the prompt text lies within the visible part of the scrolling details.
  const endInView = () => details.evaluate(element => {
    const end = (element.querySelector('pre') as HTMLElement).getBoundingClientRect().bottom;
    const box = element.getBoundingClientRect();
    return end <= box.bottom && end >= box.top && box.bottom <= window.innerHeight;
  });
  expect(await endInView()).toBe(false);

  await page.keyboard.press('Tab');
  await expect(details).toBeFocused();
  await page.keyboard.press('End');
  await expect.poll(endInView).toBe(true);
  await capture(page, 'task-prompt-keyboard-scrolled-phone-320x640');
  await page.keyboard.press('Home');
  await expect.poll(() => details.evaluate(element => element.scrollTop)).toBe(0);
  for (let step = 0; step < 40; step += 1) await page.keyboard.press('ArrowDown');
  await expect.poll(() => details.evaluate(element => element.scrollTop)).toBeGreaterThan(0);

  // Tab wraps back to Close rather than leaving the dialog.
  await page.keyboard.press('Tab');
  await expect(close).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(details).toBeFocused();
});

for (const first of ['Prompt', 'Logs'] as const) {
  test(`phone 320x640: Prompt then Logs while both load opens only Logs (${first} response first)`, async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    await stubTask(page);
    // Hold both responses until each viewer has been requested.
    const held: Record<'Prompt' | 'Logs', () => Promise<void>> = { Prompt: async () => {}, Logs: async () => {} };
    const requested = { Prompt: false, Logs: false };
    const hold = (label: 'Prompt' | 'Logs', url: string, body: Parameters<Route['fulfill']>[0]) =>
      page.route(url, route => {
        requested[label] = true;
        held[label] = () => route.fulfill(body);
      });
    await hold('Prompt', `**/api/execution/${sessionId}/prompt`, { contentType: 'application/json', body: JSON.stringify(prompt) });
    await hold('Logs', `**/api/execution/${sessionId}/logs`, { json: {
      sessionId, files: { conversation: `/var/log/propr/${fileName}` },
    } });
    await page.goto(`/tasks/${taskId}`);
    await expect(page.getByRole('heading', { name: title }).first()).toBeVisible();

    await open(page, 'Prompt');
    await expect.poll(() => requested.Prompt).toBe(true);
    const opener = await open(page, 'Logs');
    await expect.poll(() => requested.Logs).toBe(true);
    await held[first]();
    await held[first === 'Prompt' ? 'Logs' : 'Prompt']();

    const logs = page.getByRole('dialog', { name: 'Log Files' });
    await expect(logs).toBeVisible();
    await expect(logs.getByRole('button', { name: new RegExp(fileName) })).toBeVisible();
    // The abandoned Prompt request never mounts a second dialog.
    await expect(page.getByRole('dialog')).toHaveCount(1);
    await expect(logs.getByRole('button', { name: 'Close log files' })).toBeFocused();
    await expectWorkspaceInert(page, logs, [page.getByRole('heading', { name: title })]);

    // Escape dismisses the active Logs dialog and the workspace is usable again.
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(opener).toBeFocused();
    expect(await page.getByRole('heading', { name: title }).first().evaluate(element => Boolean(element.closest('[inert]')))).toBe(false);
  });
}

test('native Linux 1280x820: Logs keeps clear of the titlebar and side-by-side', async ({ page }) => {
  const shell: Shell = { platform: 'linux' };
  await page.setViewportSize({ width: 1280, height: 820 });
  await stubTask(page, shell);
  await page.goto(`/tasks/${taskId}`);
  await expect(page.getByRole('heading', { name: title }).first()).toBeVisible();

  const opener = await open(page, 'Logs');
  const dialog = page.getByRole('dialog', { name: 'Log Files' });
  const close = dialog.getByRole('button', { name: 'Close log files' });
  await expectClearOfChrome(page, dialog, close, shell);
  await dialog.getByRole('button', { name: new RegExp(fileName) }).click();
  await dialog.getByRole('textbox', { name: 'Search log' }).fill('[');
  await expect(dialog.getByRole('status')).toHaveText('1 / 2');
  expect(await fullyOnScreen(dialog.getByRole('textbox', { name: 'Search log' }))).toBe(true);
  await expectNoOverflow(page, dialog);
  await capture(page, 'task-logs-search-native-linux-1280x820');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();
});
