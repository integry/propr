import { expect, test, type Page } from '@playwright/test';
import { capture, fixture, tasks } from './task-list-desktop.fixture';

const user = (login: string, id: number) => ({ id: String(id), login, displayName: null, avatarUrl: null });
const me = user('mona', 1);
const octocat = user('octocat', 2);
const hubot = user('hubot', 3);
const crowd = [hubot, user('defunkt', 4), user('pjhyett', 5), user('wycats', 6), user('mojombo', 7)];

// Assignment belongs to the pull request, so every run of a PR carries the same assignees.
const ASSIGNEES: Record<number, ReturnType<typeof user>[]> = { 2664: [me, octocat], 2661: crowd, 2663: [hubot] };
const assignedTasks = tasks.map(task => ({ ...task, assignees: ASSIGNEES[(task as { prNumber?: number }).prNumber ?? 0] ?? [] }));

const signedIn = {
  id: me.id, login: me.login, username: me.login, displayName: 'Mona', email: null, avatarUrl: null,
  role: 'admin', permissions: [], authorizationSource: 'demo',
};

/** The task-list fixture plus assignees, an assignee-aware `/api/tasks`, and optionally a signed-in user. */
async function assigneeFixture(page: Page, { signedInUser = true } = {}) {
  await fixture(page);
  const requests: URL[] = [];
  // Registered after the fixture's catch-all, so these answer first. Without a user the
  // catch-all's 503 stands: the demo instance stays open with nobody signed in.
  if (signedInUser) await page.route(url => url.pathname === '/api/auth/user', route => route.fulfill({ json: signedIn }));
  await page.route(url => url.pathname === '/api/tasks', route => {
    const url = new URL(route.request().url());
    requests.push(url);
    const assignee = url.searchParams.get('assignee');
    if (assignee && !/^(?:me|unassigned|@?[A-Za-z0-9-]+)$/.test(assignee)) {
      return route.fulfill({ status: 400, json: { error: `assignee contains an invalid GitHub login: ${assignee}` } });
    }
    const login = assignee === 'me' ? me.login : assignee?.replace(/^@/, '');
    const matching = assignedTasks.filter(task => !assignee ? true
      : assignee === 'unassigned' ? task.assignees.length === 0
        : task.assignees.some(person => person.login === login));
    return route.fulfill({ json: { tasks: matching, total: assignee ? matching.length : 1842, totalRuns: 14769 } });
  });
  return requests;
}

const pageFits = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

test('1440px the ledger shows an Assignees column between Agent and Duration', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await assigneeFixture(page);
  await page.goto('/tasks');
  const table = page.getByRole('table', { name: 'Tasks' });
  await expect(table.getByRole('columnheader')).toHaveText(['Task / PR', 'Repo', 'Status', 'Agent', 'Assignees', 'Duration', 'Updated', 'Score']);

  const rows = table.getByTestId('task-row');
  const cell = (text: string) => rows.filter({ hasText: text }).getByTestId('task-assignees');
  // Overlapping avatars, capped at three with a `+N` naming the rest.
  await expect(cell('Stop work when an issue').getByRole('listitem')).toHaveCount(2);
  await expect(cell('Stop work when an issue').getByLabel('Assigned to @octocat')).toBeVisible();
  await expect(cell('read-only GitHub token').getByTestId('assignee-stack-avatar')).toHaveCount(3);
  await expect(cell('read-only GitHub token').getByTestId('assignee-overflow')).toHaveText('+2');
  await expect(cell('Repo-owned workflow file').getByTestId('assignee-stack-avatar')).toHaveCount(1);
  // Nobody assigned: the em dash keeps the column aligned.
  await expect(cell('Retry webhook deliveries').getByTestId('assignee-unassigned')).toHaveText('—Unassigned');

  // Zero, one, two or five assignees: every row is the same height, and every cell fits its column.
  const layout = await table.evaluate(element => ({
    heights: [...element.querySelectorAll('[data-testid="task-row"] > [role="row"]')].map(row => Math.round(row.getBoundingClientRect().height)),
    overflow: [...element.querySelectorAll('[data-testid="task-assignees"]')].some(node => node.scrollWidth > node.parentElement!.clientWidth),
  }));
  expect(new Set(layout.heights).size).toBe(1);
  expect(layout.overflow).toBe(false);
  expect(await pageFits(page)).toBe(true);
  await capture(page, 'tasks-assignees-1440');
});

test('1200px expanding a row or resizing the window never shifts the columns', async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 820 });
  await assigneeFixture(page);
  await page.goto('/tasks');
  const table = page.getByRole('table', { name: 'Tasks' });
  const widths = () => table.evaluate(element => {
    const measure = (cells: Element[]) => cells.slice(1).map(cell => Math.round(cell.getBoundingClientRect().width));
    return {
      header: measure([...element.querySelectorAll('[role="columnheader"]')]),
      rows: [...element.querySelectorAll('[data-testid="task-row"] > [role="row"]:first-child')].map(row => measure([...row.children])),
    };
  });
  const before = await widths();
  for (const row of before.rows) expect(row).toEqual(before.header);
  await table.getByRole('button', { name: '7 runs' }).click();
  await expect(table.getByRole('list', { name: 'Earlier runs' })).toBeVisible();
  expect((await widths()).header).toEqual(before.header);
  // Only STATUS and the gutters tighten below a 1100px list, so compare two widths above it.
  await page.setViewportSize({ width: 1440, height: 820 });
  const wide = await widths();
  await page.setViewportSize({ width: 1920, height: 1080 });
  expect((await widths()).header).toEqual(wide.header);
});

test('the assignee filter narrows the list, lives in the URL and resets to page 1', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const requests = await assigneeFixture(page);
  await page.goto('/tasks?page=2');
  const table = page.getByRole('table', { name: 'Tasks' });
  await expect(table).toBeVisible();
  const filter = page.getByRole('combobox', { name: 'Assignee' });
  await expect(filter).toHaveValue('all');
  // Everyone, me, nobody, then the people on the page and the signed-in user.
  await expect(filter.locator('option')).toHaveText(['All assignees', 'Assigned to me', 'Unassigned', '@defunkt', '@hubot', '@mojombo', '@mona', '@octocat', '@pjhyett', '@wycats']);
  const rows = table.getByTestId('task-row');

  await filter.selectOption('me');
  await expect(page).toHaveURL(/\/tasks\?assignee=me$/);
  await expect(rows).toHaveCount(1);
  await expect(rows).toContainText('Stop work when an issue or PR withdraws intent');
  const last = requests.at(-1)!;
  expect(last.searchParams.get('assignee')).toBe('me');
  expect(last.searchParams.get('offset')).toBe('0');

  // Reloading restores the selection.
  await page.reload();
  await expect(page.getByRole('combobox', { name: 'Assignee' })).toHaveValue('me');
  await expect(rows).toHaveCount(1);

  await page.getByRole('combobox', { name: 'Assignee' }).selectOption('unassigned');
  await expect(page).toHaveURL(/\/tasks\?assignee=unassigned$/);
  await expect(rows).toHaveCount(7);
  await expect(table.getByTestId('assignee-stack-avatar')).toHaveCount(0);

  await page.getByRole('combobox', { name: 'Assignee' }).selectOption('all');
  await expect(rows).toHaveCount(10);
  await page.getByRole('combobox', { name: 'Assignee' }).selectOption('hubot');
  await expect(page).toHaveURL(/\/tasks\?assignee=hubot$/);
  await expect(rows).toHaveCount(2);
  await expect(rows.filter({ hasText: 'Stop work when an issue' })).toHaveCount(0);

  // All assignees removes the parameter.
  await page.getByRole('combobox', { name: 'Assignee' }).selectOption('all');
  await expect(page).toHaveURL(/\/tasks$/);
  expect(requests.at(-1)!.searchParams.has('assignee')).toBe(false);
});

test('an unknown ?assignee= surfaces the API error instead of a blank page', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await assigneeFixture(page);
  await page.goto('/tasks?assignee=not%20a%20login');
  await expect(page.getByText('assignee contains an invalid GitHub login: not a login')).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Assignee' })).toBeVisible();
});

test('without a signed-in user the filter offers only All and Unassigned', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await assigneeFixture(page, { signedInUser: false });
  await page.goto('/tasks');
  await expect(page.getByRole('table', { name: 'Tasks' })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Assignee' }).locator('option')).toHaveText(['All assignees', 'Unassigned']);
});

test('390px the card shows assignees on its meta line and the filter shares the search row', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await assigneeFixture(page);
  await page.goto('/tasks');
  const cards = page.getByTestId('task-card');
  await expect(cards.first()).toBeVisible();

  const card = cards.filter({ hasText: 'Stop work when an issue' });
  const meta = card.getByTestId('task-card-meta');
  // After the work-type badge, on the same one-line meta row: the card stays three lines.
  await expect(meta.getByTestId('task-card-assignees').getByRole('listitem')).toHaveCount(2);
  const metaLayout = await meta.evaluate(node => {
    const badge = node.querySelector('[data-testid="work-type-badge"]')!.getBoundingClientRect();
    const assignees = node.querySelector('[data-testid="task-card-assignees"]')!.getBoundingClientRect();
    return { height: Math.round(node.getBoundingClientRect().height), after: assignees.left >= badge.right, sameLine: Math.abs(assignees.top - badge.top) < 6 };
  });
  expect(metaLayout).toEqual({ height: 20, after: true, sameLine: true });
  await expect(cards.filter({ hasText: 'Retry webhook deliveries' }).getByTestId('task-card-assignees')).toHaveCount(0);

  // The filter sits beside search, not as a fourth control on the title line.
  const search = page.getByRole('textbox', { name: 'Search tasks' });
  const filter = page.getByRole('combobox', { name: 'Assignee' });
  const [searchBox, filterBox, statusBox] = await Promise.all([search, filter, page.getByRole('combobox', { name: 'Task status' })].map(locator => locator.boundingBox()));
  expect(Math.abs(filterBox!.y + filterBox!.height / 2 - (searchBox!.y + searchBox!.height / 2))).toBeLessThan(4);
  expect(filterBox!.y).toBeGreaterThan(statusBox!.y + statusBox!.height);
  expect(filterBox!.x + filterBox!.width).toBeLessThanOrEqual(390);
  expect(await pageFits(page)).toBe(true);
  await capture(page, 'tasks-assignees-390');

  await filter.selectOption('me');
  await expect(page).toHaveURL(/assignee=me/);
  await expect(cards).toHaveCount(1);
  expect(await pageFits(page)).toBe(true);
});

for (const width of [768, 1440, 1920]) {
  test(`${width}px no horizontal overflow, including beside an open task`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await assigneeFixture(page);
    await page.goto('/tasks');
    await expect(page.getByRole('combobox', { name: 'Assignee' })).toBeVisible();
    expect(await pageFits(page)).toBe(true);
    if (width < 1440) return;
    await page.goto('/tasks?task=pr-2664-run-0');
    await expect(page.getByTestId('task-split-details')).toBeVisible();
    const list = page.getByTestId('task-split-list');
    await expect(list.getByRole('combobox', { name: 'Assignee' })).toBeVisible();
    const fits = await list.evaluate(node => {
      const pane = node.getBoundingClientRect();
      return [...node.querySelectorAll('select, input, button, h1')].every(control => {
        const box = control.getBoundingClientRect();
        return box.width === 0 || (box.left >= pane.left - 1 && box.right <= pane.right + 1);
      });
    });
    expect(fits).toBe(true);
    expect(await pageFits(page)).toBe(true);
    await capture(page, `tasks-assignees-split-${width}`);
  });
}
