import { expect, test, type Page } from '@playwright/test';
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
  /** The assignees read answers 409 for a task with no issue or pull request. */
  goal?: boolean;
  /** How a save answers: applied, refused for lack of write access, or GitHub being down. */
  save?: 'ok' | 'forbidden' | 'unavailable';
  /** The assignable-users read reports that GitHub listed more users than it returned. */
  truncated?: boolean;
}

async function fixture(page: Page, options: FixtureOptions = {}) {
  const state = {
    assignees: options.assignees ?? [octocat],
    assignableRequests: 0,
    puts: [] as Array<{ logins: string[]; mode: string }>,
  };
  await page.routeWebSocket('**/socket.io/**', socket => socket.close());
  await page.route('**/api/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === `/api/task/${taskId}/assignees`) {
      if (options.goal) {
        return route.fulfill({ status: 409, json: { error: 'No subject', code: 'NO_GITHUB_SUBJECT', message: 'This task has no GitHub issue or pull request, so there is nothing to assign.' } });
      }
      if (request.method() === 'PUT') {
        const body = request.postDataJSON() as { logins: string[]; mode: string };
        state.puts.push(body);
        if (options.save === 'forbidden') {
          return route.fulfill({ status: 403, json: { error: 'You need write access to integry/propr', code: 'REPOSITORY_WRITE_ACCESS_REQUIRED', message: 'You need write access to integry/propr' } });
        }
        if (options.save === 'unavailable') {
          return route.fulfill({ status: 502, json: { error: 'GitHub could not be reached', code: 'GITHUB_UNAVAILABLE', message: 'GitHub could not be reached' } });
        }
        state.assignees = body.logins.map(login => assignable.find(candidate => candidate.login === login)!);
        return route.fulfill({ json: { subject, assignees: state.assignees, rejected: [] } });
      }
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
          { state: 'PENDING', timestamp: at(0), metadata: { model: 'claude-opus-5-5' } },
          { state: 'CLAUDE_EXECUTION', timestamp: at(1), reason: 'Agent execution started' },
          {
            state: 'COMPLETED', timestamp: at(20),
            metadata: { model: 'claude-opus-5-5', pr: { url: 'https://github.com/integry/propr/pull/2911', number: 2911 } },
          },
        ],
        taskInfo: options.goal
          ? { title: 'Plan the task assignment epic', type: 'goal', repoOwner: 'integry', repoName: 'propr', modelName: 'claude-opus-5-5' }
          : { title: 'Show and edit task assignment on the task detail page', type: 'issue', number: 2894, issueNumber: 2894, repoOwner: 'integry', repoName: 'propr', modelName: 'claude-opus-5-5' },
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

async function capture(page: Page, name: string) {
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
  const state = await fixture(page, { assignees: [octocat, hubot] });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/tasks/${taskId}`);

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
  const state = await fixture(page, { assignees: [] });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/tasks/${taskId}`);

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
  await fixture(page, { assignees: [octocat], save: 'unavailable' });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/tasks/${taskId}`);

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
  const state = await fixture(page, { assignees: [octocat], save: 'forbidden' });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/tasks/${taskId}`);

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
  await fixture(page, { goal: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  const assigneeReads = page.waitForResponse(response => response.url().endsWith(`/api/task/${taskId}/assignees`));
  await page.goto(`/tasks/${taskId}`);
  await assigneeReads;
  await expect(page.getByTestId('task-header-tiers')).toBeVisible();

  await expect(page.getByTestId('task-assignment')).toHaveCount(0);
  await expect(page.getByText('Unassigned', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Assign users|Edit assignees/ })).toHaveCount(0);
});

test('traps focus in the popover and returns it to the trigger on Escape', async ({ page }) => {
  await fixture(page, { assignees: [octocat] });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/tasks/${taskId}`);

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

test('shows the assignment in the expanded mobile summary and leaves the compact bar alone at 390px', async ({ page }) => {
  await fixture(page, { assignees: [octocat, hubot] });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/tasks/${taskId}`);

  const details = page.getByTestId('task-details');
  const assignment = details.getByTestId('task-assignment').filter({ visible: true });
  await expect(assignment).toHaveCount(1);
  await expect(assignment.getByRole('listitem', { name: 'Assigned to @octocat' })).toBeVisible();

  await assignment.getByRole('button', { name: 'Edit assignees' }).click();
  const editor = page.getByRole('dialog', { name: 'Assign users' });
  await expect(editor).toBeVisible();
  const box = (await editor.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  await expectNoHorizontalOverflow(page);
  await capture(page, 'task-assignment-editor-390');
  await page.keyboard.press('Escape');

  const bar = page.getByTestId('task-mobile-compact-bar');
  await details.evaluate(element => {
    element.append(Object.assign(document.createElement('div'), { style: 'height: 1200px; flex: none' }));
    element.scrollTop = 600;
  });
  await expect(bar).toBeVisible();
  expect(Math.round((await bar.boundingBox())!.height)).toBe(44);
  await expect(bar).toHaveText('#2911:Show and edit task assignment on the task detail page');
  await expect(bar.getByTestId('task-assignment')).toHaveCount(0);
  await expectNoHorizontalOverflow(page);
});

test('1440px renders exactly one visible assignment control, with one edit button', async ({ page }) => {
  await fixture(page, { assignees: [octocat] });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/tasks/${taskId}`);

  const details = page.getByTestId('task-details');
  const visible = details.getByTestId('task-assignment').filter({ visible: true });
  await expect(visible).toHaveCount(1);
  await expect(details.getByRole('button', { name: 'Edit assignees' }).filter({ visible: true })).toHaveCount(1);
  await expect(details.getByRole('button', { name: 'Assign users' }).filter({ visible: true })).toHaveCount(0);
  // Inside the Git cluster too: one control, one edit button.
  await expect(gitContext(page).getByTestId('task-assignment')).toHaveCount(1);
  await expect(gitContext(page).getByRole('button', { name: /^(Edit assignees|Assign users)$/ })).toHaveCount(1);
});

test('1440px an unassigned task offers one visible Assign button', async ({ page }) => {
  await fixture(page, { assignees: [] });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/tasks/${taskId}`);

  const details = page.getByTestId('task-details');
  await expect(details.getByTestId('task-assignment').filter({ visible: true })).toHaveCount(1);
  await expect(details.getByRole('button', { name: 'Assign users' }).filter({ visible: true })).toHaveCount(1);
  await expect(gitContext(page).getByRole('button', { name: 'Assign users' })).toHaveCount(1);
});

test('explains a truncated candidate list and points to GitHub for anyone else', async ({ page }) => {
  await fixture(page, { assignees: [octocat], truncated: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/tasks/${taskId}`);

  await gitContext(page).getByRole('button', { name: 'Edit assignees' }).click();
  const editor = page.getByRole('dialog', { name: 'Assign users' });
  await expect(editor.getByText('Only the first 3 assignable users are listed, and the filter searches only these. Assign anyone else on GitHub.')).toBeVisible();
});
