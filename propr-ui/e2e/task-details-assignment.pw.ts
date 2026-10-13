import { expect, test, type Locator, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

const taskId = 'task-assignment-2894';
const at = (minute: number) => `2026-10-09T06:${String(minute).padStart(2, '0')}:00.000Z`;
const subject = { owner: 'integry', repo: 'propr', number: 2894, kind: 'issue' };

interface FixtureUser { id: string; login: string; displayName: string | null; avatarUrl: string | null }
const user = (id: number, login: string, displayName: string | null = null): FixtureUser => ({ id: String(id), login, displayName, avatarUrl: null });
const octocat = user(1, 'octocat', 'The Octocat');
const hubot = user(2, 'hubot', 'Hubot');
const monalisa = user(3, 'monalisa', 'Mona Lisa');
const assignable = [hubot, monalisa, octocat];

interface FixtureOptions {
  assignees?: FixtureUser[];
  denseGit?: boolean;
  model?: string;
  /** The assignees read answers 409 for a task with no issue or pull request. */
  goal?: boolean;
  /** How a save answers: applied, refused for lack of write access, or GitHub being down. */
  save?: 'ok' | 'forbidden' | 'unavailable';
  /** The assignable-users read reports that GitHub listed more users than it returned. */
  truncated?: boolean;
  /** How many assignee reads answer 502 before they succeed. */
  failedReads?: number;
}

async function fixture(page: Page, options: FixtureOptions = {}) {
  const state = {
    assignees: options.assignees ?? [octocat],
    assignableRequests: 0,
    reads: 0,
    puts: [] as Array<{ logins: string[]; mode: string }>,
  };
  await page.routeWebSocket('**/socket.io/**', socket => socket.close());
  await page.route('**/api/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === `/api/task/${taskId}/assignees`) {
      if (options.goal) return route.fulfill({ status: 409, json: { error: 'No subject', code: 'NO_GITHUB_SUBJECT', message: 'This task has no GitHub issue or pull request, so there is nothing to assign.' } });
      if (request.method() === 'PUT') {
        const body = request.postDataJSON() as { logins: string[]; mode: string };
        state.puts.push(body);
        if (options.save === 'forbidden') return route.fulfill({ status: 403, json: { error: 'You need write access to integry/propr', code: 'REPOSITORY_WRITE_ACCESS_REQUIRED', message: 'You need write access to integry/propr' } });
        if (options.save === 'unavailable') return route.fulfill({ status: 502, json: { error: 'GitHub could not be reached', code: 'GITHUB_UNAVAILABLE', message: 'GitHub could not be reached' } });
        state.assignees = body.logins.map(login => assignable.find(candidate => candidate.login === login)!);
        return route.fulfill({ json: { subject, assignees: state.assignees, rejected: [] } });
      }
      state.reads += 1;
      if (state.reads <= (options.failedReads ?? 0)) return route.fulfill({ status: 502, json: { error: 'GitHub could not be reached', code: 'GITHUB_UNAVAILABLE', message: 'GitHub could not be reached' } });
      return route.fulfill({ json: { subject, assignees: state.assignees, synced: true } });
    }
    if (path === `/api/task/${taskId}/assignable-users`) {
      state.assignableRequests += 1;
      return route.fulfill({ json: { users: assignable, truncated: options.truncated ?? false } });
    }
    const responses: Record<string, unknown> = {
      '/api/auth/demo-mode': { demoMode: false },
      [`/api/task/${taskId}/history`]: {
        history: [
          { state: 'PENDING', timestamp: at(0), metadata: { model: options.model ?? 'claude-opus-5-5' } },
          { state: 'CLAUDE_EXECUTION', timestamp: at(1), reason: 'Agent execution started' },
          { state: 'COMPLETED', timestamp: at(20),
            metadata: { ...(options.denseGit ? { commitResult: { commitHash: '5c7cd9e0123456789' } } : {}), model: options.model ?? 'claude-opus-5-5', pr: { url: 'https://github.com/integry/propr/pull/2911', number: 2911 } } },
        ],
        taskInfo: options.goal
          ? { title: 'Plan the task assignment epic', type: 'goal', repoOwner: 'integry', repoName: 'propr', modelName: options.model ?? 'claude-opus-5-5' }
          : { ...(options.denseGit ? { attemptNumber: 2, attemptLineage: [{ taskId: 'previous', attemptNumber: 1 }, { taskId, attemptNumber: 2 }] } : {}), title: 'Show and edit task assignment on the task detail page', type: 'issue', number: 2894, issueNumber: 2894, repoOwner: 'integry', repoName: 'propr', modelName: options.model ?? 'claude-opus-5-5' },
        usageMetricRecords: [],
      },
      [`/api/task/${taskId}/live-details`]: { events: [], todos: [], currentTask: null },
      '/api/notifications/unread-count': { unreadCount: 0 },
      '/api/notifications/preferences': { preferences: {}, quietHours: {}, badgeEnabled: false },
    };
    return route.fulfill(path in responses ? { json: responses[path] } : { status: 503, json: { error: 'Unavailable in assignment fixture' } });
  });
  return state;
}

async function openTask(page: Page, options: FixtureOptions, viewport = { width: 1440, height: 900 }) {
  const state = await fixture(page, options);
  await page.setViewportSize(viewport);
  await page.goto(`/tasks/${taskId}`);
  return state;
}

async function capture(page: Page | Locator, name: string) {
  if (!process.env.PROPR_CAPTURE_PREVIEWS) return;
  await mkdir('../.propr/previews', { recursive: true });
  await page.screenshot({ animations: 'disabled', path: `../.propr/previews/${name}.png` });
}

/** The desktop header's Git cluster. */
const gitContext = (page: Page) => page.getByTestId('task-header-tiers').getByRole('group', { name: 'Git context' });

async function expectNoHorizontalOverflow(page: Page) {
  const width = await page.evaluate(() => ({ viewport: window.innerWidth, document: document.documentElement.scrollWidth }));
  expect(width.document).toBeLessThanOrEqual(width.viewport);
}

test('shows the assignees in the Git cluster and loads assignable users only when the editor opens', async ({ page }) => {
  const state = await openTask(page, { assignees: [octocat, hubot] });

  const assignment = gitContext(page).getByTestId('task-assignment');
  await expect(assignment.getByRole('listitem', { name: 'Assigned to @octocat' })).toBeVisible();
  await expect(assignment.getByRole('listitem', { name: 'Assigned to @hubot' })).toBeVisible();
  await expect(assignment).toContainText('@octocat');
  expect(state.assignableRequests).toBe(0);

  await assignment.getByRole('button', { name: 'Edit assignees' }).click();
  const editor = page.getByRole('dialog', { name: 'Assign users' });
  await expect(editor).toBeVisible();
  await expect(editor.getByRole('checkbox', { name: /@octocat/ })).toBeChecked();
  await expect(editor.getByRole('checkbox', { name: /@hubot/ })).toBeChecked();
  await expect(editor.getByRole('checkbox', { name: /@monalisa/ })).not.toBeChecked();
  expect(state.assignableRequests).toBe(1);
  await capture(page, 'task-assignment-editor-1440');
  await expectNoHorizontalOverflow(page);

  // Reopening reuses the users already read.
  await editor.getByRole('button', { name: 'Cancel' }).click();
  await assignment.getByRole('button', { name: 'Edit assignees' }).click();
  await expect(editor.getByRole('checkbox', { name: /@monalisa/ })).toBeVisible();
  expect(state.assignableRequests).toBe(1);
});

test('assigns several users and then unassigns everyone', async ({ page }) => {
  const state = await openTask(page, { assignees: [] });

  const assignment = gitContext(page).getByTestId('task-assignment');
  await expect(assignment.getByText('Unassigned', { exact: true })).toBeVisible();
  await assignment.getByRole('button', { name: 'Assign users' }).click();
  const editor = page.getByRole('dialog', { name: 'Assign users' });

  await editor.getByRole('searchbox', { name: 'Filter users' }).fill('mona');
  await expect(editor.getByRole('checkbox')).toHaveCount(1);
  await editor.getByRole('checkbox', { name: /@monalisa/ }).check();
  await editor.getByRole('searchbox', { name: 'Filter users' }).fill('');
  await editor.getByRole('checkbox', { name: /@hubot/ }).check();
  await editor.getByRole('button', { name: 'Save' }).click();

  await expect(editor).toBeHidden();
  await expect(assignment.getByRole('listitem', { name: 'Assigned to @hubot' })).toBeVisible();
  await expect(assignment.getByRole('listitem', { name: 'Assigned to @monalisa' })).toBeVisible();
  expect(state.puts.at(-1)).toEqual({ logins: expect.arrayContaining(['hubot', 'monalisa']), mode: 'replace' });
  expect(state.puts.at(-1)!.logins).toHaveLength(2);
  await capture(page, 'task-assignment-assigned-1440');

  await assignment.getByRole('button', { name: 'Edit assignees' }).click();
  await editor.getByRole('button', { name: 'Clear' }).click();
  await expect(editor.getByRole('checkbox', { checked: true })).toHaveCount(0);
  await editor.getByRole('button', { name: 'Save' }).click();
  await expect(assignment.getByText('Unassigned', { exact: true })).toBeVisible();
  expect(state.puts.at(-1)).toEqual({ logins: [], mode: 'replace' });
});

test('rolls the display back and toasts when a save fails', async ({ page }) => {
  await openTask(page, { assignees: [octocat], save: 'unavailable' });

  const assignment = gitContext(page).getByTestId('task-assignment');
  await assignment.getByRole('button', { name: 'Edit assignees' }).click();
  const editor = page.getByRole('dialog', { name: 'Assign users' });
  await editor.getByRole('checkbox', { name: /@octocat/ }).uncheck();
  await editor.getByRole('checkbox', { name: /@hubot/ }).check();
  await editor.getByRole('button', { name: 'Save' }).click();

  await expect(page.getByText(/Failed to update assignees/)).toBeVisible();
  await expect(assignment.getByRole('listitem', { name: 'Assigned to @octocat' })).toBeVisible();
  await expect(assignment.getByRole('listitem', { name: 'Assigned to @hubot' })).toHaveCount(0);
  // An outage is not a permission problem, so the editor stays on offer.
  await expect(assignment.getByRole('button', { name: 'Edit assignees' })).toBeVisible();
});

test('keeps a read-only display after a 403 and stops offering the editor', async ({ page }) => {
  const state = await openTask(page, { assignees: [octocat], save: 'forbidden' });

  const assignment = gitContext(page).getByTestId('task-assignment');
  await assignment.getByRole('button', { name: 'Edit assignees' }).click();
  const editor = page.getByRole('dialog', { name: 'Assign users' });
  await editor.getByRole('checkbox', { name: /@hubot/ }).check();
  await editor.getByRole('button', { name: 'Save' }).click();

  const toast = page.getByText(/You can't change who is assigned to this task: You need write access/);
  await expect(toast).toHaveCount(1);
  await expect(assignment.getByRole('listitem', { name: 'Assigned to @octocat' })).toBeVisible();
  await expect(assignment.getByRole('listitem', { name: 'Assigned to @hubot' })).toHaveCount(0);
  await expect(page.getByTestId('assignment-trigger')).toHaveCount(0);
  expect(state.puts).toHaveLength(1);
});

test('renders nothing for a goal task that has no issue or pull request', async ({ page }) => {
  const assigneeReads = page.waitForResponse(response => response.url().endsWith(`/api/task/${taskId}/assignees`));
  await openTask(page, { goal: true });
  await assigneeReads;
  await expect(page.getByTestId('task-header-tiers')).toBeVisible();

  await expect(page.getByTestId('task-assignment')).toHaveCount(0);
  await expect(page.getByText('Unassigned', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Assign users|Edit assignees/ })).toHaveCount(0);
});

test('traps focus in the popover and returns it to the trigger on Escape', async ({ page }) => {
  await openTask(page, { assignees: [octocat] });

  const trigger = gitContext(page).getByRole('button', { name: 'Edit assignees' });
  await trigger.click();
  const editor = page.getByRole('dialog', { name: 'Assign users' });
  const filter = editor.getByRole('searchbox', { name: 'Filter users' });
  await expect(filter).toBeFocused();
  await expect(editor.getByRole('checkbox')).toHaveCount(3);

  // Arrow keys walk the checkbox list; Space toggles.
  await page.keyboard.press('ArrowDown');
  await expect(editor.getByRole('checkbox', { name: /@octocat/ })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(editor.getByRole('checkbox', { name: /@hubot/ })).toBeFocused();
  await page.keyboard.press('Space');
  await expect(editor.getByRole('checkbox', { name: /@hubot/ })).toBeChecked();

  // Tab from the last control wraps to the first, and Shift+Tab back again.
  await editor.getByRole('button', { name: 'Save' }).focus();
  await page.keyboard.press('Tab');
  await expect(filter).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(editor.getByRole('button', { name: 'Save' })).toBeFocused();

  await page.keyboard.press('Escape');
  await expect(editor).toBeHidden();
  await expect(trigger).toBeFocused();
  await expect(gitContext(page).getByRole('listitem', { name: 'Assigned to @hubot' })).toHaveCount(0);
});

for (const width of [320, 390]) {
  test(`shows the assignment in the expanded mobile summary and leaves the compact bar alone at ${width}px`, async ({ page }) => {
    const state = await openTask(page, { assignees: [octocat, hubot] }, { width, height: 844 });

    const details = page.getByTestId('task-details');
    const assignment = details.getByTestId('task-assignment').filter({ visible: true });
    await expect(assignment).toHaveCount(1);
    await expect(assignment.getByRole('listitem', { name: 'Assigned to @octocat' })).toBeVisible();

    const metadata = page.getByTestId('task-mobile-metadata');
    const git = metadata.getByRole('group', { name: 'Git context' });
    await expect(git.getByRole('link', { name: 'propr #2911' })).toHaveAttribute('href', 'https://github.com/integry/propr/pull/2911');
    await expect(git.getByRole('link', { name: '#2894' })).toBeVisible();
    await expect(git).not.toContainText('integry/');
    const runtime = metadata.getByRole('group', { name: 'Execution runtime' });
    const modelLabel = runtime.locator('[title="Claude Opus 5.5"] > span');
    await expect(modelLabel).toHaveText('Claude Opus 5.5');
    await expect(modelLabel).toBeVisible();
    await expect.poll(() => modelLabel.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await expect(runtime).toContainText('20m 0s');
    const peopleBox = (await assignment.boundingBox())!;
    const runtimeBox = (await runtime.boundingBox())!;
    if (width === 390) expect(Math.abs(peopleBox.y - runtimeBox.y)).toBeLessThan(4);
    // Only the narrow layout may stack runtime below assignment.
    expect(peopleBox.x + peopleBox.width <= runtimeBox.x || (width === 320 && peopleBox.y + peopleBox.height <= runtimeBox.y)).toBe(true);
    await expect(metadata.getByRole('group', { name: 'Consumption' })).toContainText('↑0↓0(no quota data)');
    await metadata.getByRole('button', { name: 'Follow Up', exact: true }).click({ trial: true });
    await expectNoHorizontalOverflow(page);
    await capture(metadata, `mobile-metadata-${width}`);

    expect((await details.getByRole('button', { name: 'Follow Up', exact: true }).boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await assignment.getByRole('button', { name: 'Edit assignees' }).click();
    const editor = page.getByRole('dialog', { name: 'Assign users' });
    await expect(editor).toBeVisible();
    await expect(editor).toHaveAttribute('aria-modal', 'true');
    await expect(editor).toBeFocused();
    await expect(editor.getByRole('searchbox')).not.toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(editor.getByRole('button', { name: 'Cancel' })).toBeFocused();
    await expect(page.locator('body')).toHaveCSS('position', 'fixed');
    await expect(details).toHaveCSS('overflow', 'hidden');
    const box = (await editor.boundingBox())!;
    await expectNoHorizontalOverflow(page);
    expect(box.x).toBe(0);
    expect(box.width).toBe(width);
    await expect.poll(async () => {
      const settled = (await editor.boundingBox())!;
      return Math.round(settled.y + settled.height);
    }).toBe(844);
    const backdrop = page.getByTestId('assignment-backdrop');
    await expect(backdrop).toHaveCSS('background-color', 'rgba(15, 23, 42, 0.4)');
    for (const row of await editor.getByTestId('assignment-option').all()) {
      expect((await row.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    }
    await editor.getByTestId('assignment-option').filter({ hasText: '@monalisa' }).click();
    await expect(editor.getByRole('checkbox', { name: /@monalisa/ })).toBeChecked();
    const save = editor.getByRole('button', { name: 'Save Assignments' });
    const cancel = editor.getByRole('button', { name: 'Cancel' });
    const saveBox = (await save.boundingBox())!;
    expect(saveBox.height).toBeGreaterThanOrEqual(44);
    expect(saveBox.width).toBeGreaterThanOrEqual(width * 0.85);
    expect(saveBox.width).toBeLessThan(width);
    expect((await cancel.boundingBox())!.y).toBeGreaterThanOrEqual(saveBox.y + saveBox.height);
    await cancel.focus();
    await page.keyboard.press('Tab');
    await expect(editor.getByRole('searchbox')).toBeFocused();
    await capture(page, `task-assignment-sheet-${width}`);
    await cancel.click();
    expect(state.puts).toHaveLength(0);
    await expect(details).toHaveCSS('overflow-y', 'auto');
    await assignment.getByRole('button', { name: 'Edit assignees' }).click();
    await expect(editor.getByRole('checkbox', { name: /@monalisa/ })).not.toBeChecked();
    await backdrop.click({ position: { x: 10, y: 10 } });
    await expect(editor).toBeHidden();
    await expect(assignment.getByRole('button', { name: 'Edit assignees' })).toBeFocused();
    await assignment.getByRole('button', { name: 'Edit assignees' }).click();
    await editor.getByRole('checkbox', { name: /@monalisa/ }).check();
    await save.click();
    await expect(editor).toBeHidden();
    expect(state.puts.at(-1)?.logins).toEqual(expect.arrayContaining(['octocat', 'hubot', 'monalisa']));

    await assignment.getByRole('button', { name: 'Edit assignees' }).click();
    await editor.getByRole('button', { name: 'Clear', exact: true }).click();
    await expect(editor.getByRole('checkbox', { checked: true })).toHaveCount(0);
    await save.click();
    await expect(assignment).toContainText('Unassigned');
    expect(state.puts.at(-1)).toEqual({ logins: [], mode: 'replace' });
    await expect(details).toHaveCSS('overflow-y', 'auto');

    const bar = page.getByTestId('task-mobile-compact-bar');
    await details.evaluate(element => {
      element.append(Object.assign(document.createElement('div'), { style: 'height: 1200px; flex: none' }));
      element.scrollTop = 600;
    });
    await expect(bar).toBeVisible();
    expect((await bar.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    expect((await bar.boundingBox())!.height).toBeLessThanOrEqual(56);
    await expect(bar).toHaveText('#2911:Show and edit task assignment on the task detail page');
    await expect(bar.getByTestId('task-assignment')).toHaveCount(0);
    await expectNoHorizontalOverflow(page);
  });

}

for (const assignees of [[octocat], []]) {
  const buttonName = assignees.length ? 'Edit assignees' : 'Assign users';
  test(`1440px renders exactly one visible assignment control with one ${buttonName} button`, async ({ page }) => {
    await openTask(page, { assignees });
    const details = page.getByTestId('task-details');
    await expect(details.getByTestId('task-assignment').filter({ visible: true })).toHaveCount(1);
    await expect(details.getByRole('button', { name: buttonName }).filter({ visible: true })).toHaveCount(1);
    await expect(details.getByRole('button', { name: assignees.length ? 'Assign users' : 'Edit assignees' }).filter({ visible: true })).toHaveCount(0);
    // Inside the Git cluster too: one control, one assignment button.
    await expect(gitContext(page).getByTestId('task-assignment')).toHaveCount(1);
    await expect(gitContext(page).getByRole('button', { name: /^(Edit assignees|Assign users)$/ })).toHaveCount(1);
    await expect(gitContext(page).getByRole('button', { name: buttonName })).toHaveCount(1);
  });
}

test('explains a truncated candidate list and points to GitHub for anyone else', async ({ page }) => {
  await openTask(page, { assignees: [octocat], truncated: true });

  await gitContext(page).getByRole('button', { name: 'Edit assignees' }).click();
  const editor = page.getByRole('dialog', { name: 'Assign users' });
  await expect(editor.getByText('Only the first 3 assignable users are listed, and the filter searches only these. Assign anyone else on GitHub.')).toBeVisible();
});

for (const [width, height] of [[1440, 900], [390, 844], [320, 844]] as const) {
  test(`${width}px offers a retry when the assignment cannot be read, and shows it once a retry succeeds`, async ({ page }) => {
    const state = await openTask(page, { assignees: [octocat, hubot], failedReads: 1, model: 'gpt-6-astra' }, { width, height });

    const details = page.getByTestId('task-details');
    const failed = details.getByTestId('task-assignment-error').filter({ visible: true });
    await expect(failed).toHaveCount(1);
    await expect(failed).toContainText("Assignees unavailable");
    expect(await failed.innerText()).not.toMatch(/[·•|]/);
    await expect(details.getByTestId('task-assignment').filter({ visible: true })).toHaveCount(0);
    await expectNoHorizontalOverflow(page);
    if (width < 640) {
      const row = details.getByTestId('task-mobile-people-runtime');
      const bounds = (await row.boundingBox())!;
      for (const content of [failed, failed.getByRole('button', { name: 'Retry' }), row.getByRole('group', { name: 'Execution runtime' })]) {
        const box = (await content.boundingBox())!;
        expect(box.x).toBeGreaterThanOrEqual(bounds.x);
        expect(box.x + box.width).toBeLessThanOrEqual(bounds.x + bounds.width + 1);
        expect(box.y + box.height).toBeLessThanOrEqual(bounds.y + bounds.height + 1);
      }
    }
    await capture(page, `task-assignment-read-failed-${width}`);

    await failed.getByRole('button', { name: 'Retry' }).click();
    const assignment = details.getByTestId('task-assignment').filter({ visible: true });
    await expect(assignment.getByRole('listitem', { name: 'Assigned to @octocat' })).toBeVisible();
    await expect(details.getByTestId('task-assignment-error')).toHaveCount(0);
    expect(state.reads).toBe(2);
  });
}

for (const width of [320, 390]) {
  test(`dense mobile metadata stays reachable at ${width}px`, async ({ page }) => {
    const users = [user(11, 'long-assignee-login-for-maintainer-one'), user(12, 'long-assignee-login-for-maintainer-two'), user(13, 'long-assignee-login-for-maintainer-three')];
    await openTask(page, { assignees: users, denseGit: true }, { width, height: 844 });
    const metadata = page.getByTestId('task-mobile-metadata');
    await expect(metadata.getByRole('group', { name: 'Attempt lineage' })).toBeVisible();
    await expect(metadata.getByTitle('View commit on GitHub')).toBeVisible();
    const repo = metadata.getByRole('link', { name: 'propr #2911' });
    await expect(repo).toBeVisible();
    expect((await repo.boundingBox())!.width).toBeGreaterThan(90);
    const gitBox = (await metadata.getByRole('group', { name: 'Git context', exact: true }).boundingBox())!;
    const followUpBox = (await metadata.getByRole('button', { name: 'Follow Up', exact: true }).boundingBox())!;
    expect(gitBox.x + gitBox.width).toBeLessThanOrEqual(followUpBox.x);
    for (const link of await metadata.getByRole('group', { name: 'Git context', exact: true }).getByRole('link').all()) {
      const box = (await link.boundingBox())!;
      expect(box.x + box.width).toBeLessThanOrEqual(gitBox.x + gitBox.width + 1);
    }
    for (const user of users) await expect(metadata.getByRole('listitem', { name: `Assigned to @${user.login}` })).toBeVisible();
    const bounds = await metadata.evaluate(node => [...node.querySelectorAll('a, button, [role="listitem"]')].map(child => {
      const rect = child.getBoundingClientRect();
      return { left: rect.left, right: rect.right };
    }));
    for (const bound of bounds) {
      expect(bound.left).toBeGreaterThanOrEqual(0);
      expect(bound.right).toBeLessThanOrEqual(width);
    }
    await expectNoHorizontalOverflow(page);
    await capture(page, `task-dense-metadata-${width}`);
  });
}

// Mobile emulation does not launch an OS keyboard. This covers a reduced viewport;
// an Android/iOS device run is still needed for actual visualViewport/IME behavior.
// Device checklist (pending): iOS Safari and Android Chrome, OS keyboard open;
// filter/select a user and reach search, results, Save and Cancel without hiding
// the keyboard. Exercise both dismissal paths and verify background scroll restores.
test('mobile assignment search, results, Save and Cancel remain reachable in a reduced viewport', async ({ browser }) => {
  const context = await browser.newContext({ isMobile: true, hasTouch: true, viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  const state = await openTask(page, {}, { width: 390, height: 844 });
  const trigger = page.getByTestId('assignment-trigger').filter({ visible: true });
  await trigger.tap();
  const editor = page.getByRole('dialog', { name: 'Assign users' });
  await expect(editor).toBeFocused();
  await expect(page.locator('main')).toHaveCSS('overflow-y', 'hidden');
  const search = editor.getByRole('searchbox');
  await search.tap();
  await expect(search).toBeFocused();
  await page.setViewportSize({ width: 390, height: 480 });
  await search.fill('monalisa');
  const option = editor.getByRole('checkbox', { name: /@monalisa/ });
  for (const target of [search, option, editor.getByRole('button', { name: 'Save Assignments' }), editor.getByRole('button', { name: 'Cancel' })]) {
    await expect(target).toBeInViewport();
  }
  await option.check();
  await capture(page, 'task-assignment-reduced-mobile-viewport');
  await editor.getByRole('button', { name: 'Cancel' }).tap();
  expect(state.puts).toHaveLength(0);
  await expect(page.locator('main')).toHaveCSS('overflow-y', 'auto');
  await page.setViewportSize({ width: 390, height: 844 });
  await trigger.tap();
  await search.tap();
  await page.setViewportSize({ width: 390, height: 480 });
  await search.fill('monalisa');
  await option.check();
  await editor.getByRole('button', { name: 'Save Assignments' }).tap();
  await expect(editor).toBeHidden();
  expect(state.puts.at(-1)?.logins).toEqual(['octocat', 'monalisa']);
  await context.close();
});
