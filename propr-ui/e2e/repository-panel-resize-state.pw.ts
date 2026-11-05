import { expect, test, type Locator, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

// The repository action panel is one live instance across the lg breakpoint:
// resizing only changes the layout, so the selected tab, saved to-do edits,
// deletions and unsent drafts all carry over, and nothing is re-requested or
// written as a side effect of the resize.

const WIDE = { width: 1440, height: 900 };
const NARROW = { width: 900, height: 900 };
const PHONE = { width: 390, height: 844 };

type Todo = { todoId: string; repository: string; categoryId: string | null; content: string; orderIndex: number; isCompleted: boolean };
type Request = { method: string; path: string; search: string; body: unknown };

async function statefulApi(page: Page) {
  const repos = [
    { id: 'alpha', name: 'acme/alpha', enabled: true, visualPreview: { enabled: false, types: ['image'] } },
    { id: 'billing', name: 'acme/billing', enabled: true, visualPreview: { enabled: false, types: ['image'] } },
  ];
  const stamp = '2026-10-18T07:00:00.000Z';
  const todos: Todo[] = [
    { todoId: 'todo-note', repository: 'acme/alpha', categoryId: null, content: 'Original fixture note', orderIndex: 0, isCompleted: false },
    { todoId: 'todo-keep', repository: 'acme/alpha', categoryId: null, content: 'Untouched neighbour', orderIndex: 1, isCompleted: false },
    { todoId: 'todo-billing', repository: 'acme/billing', categoryId: null, content: 'Billing-only note', orderIndex: 0, isCompleted: false },
  ];
  const toRecord = (todo: Todo) => ({
    ...todo, linkedDraftId: null, linkedIssueRepository: null, linkedIssueNumber: null, linkedTaskId: null, createdAt: stamp, updatedAt: stamp,
  });
  const requests: Request[] = [];

  const reads: Record<string, (url: URL) => unknown> = {
    '/api/auth/demo-mode': () => ({ demoMode: false }),
    '/api/auth/user': () => ({ id: 'preview-user', login: 'operator', username: 'operator', displayName: 'Operator', email: null, avatarUrl: null, role: 'member', permissions: [], authorizationSource: 'local' }),
    '/api/config/repos': () => ({ success: true, repos_to_monitor: repos }),
    '/api/instance/catalog': () => ({ repositories: repos, agents: [] }),
    '/api/github/repos': () => ({ repos: [] }),
    '/api/config/settings': () => ({}),
    '/api/user/repo-preferences': () => ({ preferences: {} }),
    '/api/repositories/indexing-status': () => ({ repositories: repos.map(repo => ({ full_name: repo.name, branch: 'HEAD', indexing_status: 'completed', last_indexed_at: stamp })) }),
    '/api/repos/chat/messages': () => ({ messages: [] }),
    '/api/repos/todos/categories': () => ({ categories: [] }),
    '/api/repos/todos': url => ({ todos: todos.filter(todo => todo.repository === url.searchParams.get('repository')).map(toRecord) }),
    '/api/notifications': () => ({ notifications: [], unreadCount: 0, nextCursor: null }),
    '/api/notifications/unread-count': () => ({ unreadCount: 0 }),
    '/api/notifications/config': () => ({ push: { configured: false, vapidPublicKey: null } }),
    '/api/notifications/preferences': () => ({ preferences: {}, quietHours: {}, badgeEnabled: false }),
  };

  await page.routeWebSocket('**/socket.io/**', socket => socket.close());
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    const path = url.pathname;
    requests.push({ method, path, search: url.search, body: method === 'GET' ? undefined : request.postDataJSON() });

    const todoId = path.match(/^\/api\/repos\/todos\/(todo-[^/]+)$/)?.[1];
    const index = todos.findIndex(todo => todo.todoId === todoId);
    if (index >= 0 && method === 'PUT') {
      todos[index] = { ...todos[index], ...request.postDataJSON() };
      return route.fulfill({ json: toRecord(todos[index]) });
    }
    if (index >= 0 && method === 'DELETE') {
      todos.splice(index, 1);
      return route.fulfill({ json: { success: true } });
    }
    const read = method === 'GET' ? reads[path] : undefined;
    return route.fulfill(read
      ? { json: read(url) }
      : { status: 503, json: { error: 'Optional API unavailable in repository panel test' } });
  });

  return {
    todos,
    requests,
    mutations: () => requests.filter(r => r.method !== 'GET').map(({ method, path, body }) => ({ method, path, body })),
    loads: (path: string, repository: string) =>
      requests.filter(r => r.method === 'GET' && r.path === path && new URLSearchParams(r.search).get('repository') === repository).length,
    // Anything that would start or change work, or ask a model provider; the app shell's task and draft list reads are not.
    taskOrProviderRequests: () => requests.filter(r => /^\/api\/repos\/(chat|improvements)$/.test(r.path)
      || (r.method !== 'GET' && /^\/api\/(tasks|planner|studio|drafts|providers?|ai)\b/.test(r.path))),
  };
}

async function capture(page: Page, name: string) {
  if (!process.env.PROPR_CAPTURE_PREVIEWS) return;
  await mkdir('../.propr/previews', { recursive: true });
  await page.screenshot({ path: `../.propr/previews/${name}.png`, animations: 'disabled' });
}

const tab = (page: Page, name: string) => page.getByRole('button', { name, exact: true });
const todoRow = (page: Page, content: string) => page.getByRole('button', { name: `Select todo: ${content}`, exact: true }).locator('..');
const backButton = (page: Page) => page.getByTitle('Back to repositories');
const repoListItem = (page: Page, name: string) => page.getByRole('button', { name: `Select ${name}`, exact: true });

async function expectWideLayout(page: Page) {
  await expect(repoListItem(page, 'acme/alpha')).toBeVisible();
  await expect(backButton(page)).toBeHidden();
}

async function expectNarrowDetail(page: Page) {
  await expect(backButton(page)).toBeVisible();
  await expect(repoListItem(page, 'acme/alpha')).toBeHidden();
}

async function expectTodosTabShowing(page: Page) {
  await expect(tab(page, 'To-Dos')).toHaveAttribute('aria-pressed', 'true');
  await expect(tab(page, 'Settings')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByRole('heading', { name: 'To-Dos', exact: true })).toBeVisible();
}

/** Every DOM copy, visible or not: a hidden twin of the panel would show up here. */
const domCopies = (page: Page, text: string) => page.getByText(text, { exact: true });

async function deleteTodo(row: Locator) {
  await row.hover();
  await row.getByTitle('Delete').click();
}

test('Quick Add → View Todos keeps a saved edit and a deletion across 1440↔900↔phone resizes', async ({ page }) => {
  await page.setViewportSize(WIDE);
  const api = await statefulApi(page);
  await page.goto('/inbox');
  const trigger = page.getByRole('button', { name: 'Quick add to-do' }).filter({ visible: true });
  await trigger.click();
  const quickAdd = trigger.locator('..').locator(':scope > div');
  await expect(quickAdd.getByRole('button', { name: 'acme/alpha' })).toBeVisible();
  await quickAdd.getByRole('button', { name: 'View Todos' }).click();

  await expect(page).toHaveURL(/\/repositories$/);
  await expectWideLayout(page);
  await expectTodosTabShowing(page);
  await expect(todoRow(page, 'Original fixture note')).toBeVisible();
  // One panel, so one copy of the note.
  await expect(domCopies(page, 'Original fixture note')).toHaveCount(1);

  const row = todoRow(page, 'Original fixture note');
  await row.hover();
  await row.getByTitle('Edit').click();
  const editor = row.getByRole('textbox');
  await editor.fill('Edited at 1440');
  await editor.press('Enter');
  await expect(todoRow(page, 'Edited at 1440')).toBeVisible();
  await expect.poll(() => api.mutations()).toEqual([
    { method: 'PUT', path: '/api/repos/todos/todo-note', body: { content: 'Edited at 1440' } },
  ]);

  await page.setViewportSize(NARROW);
  await expectNarrowDetail(page);
  await expectTodosTabShowing(page);
  await expect(todoRow(page, 'Edited at 1440')).toBeVisible();
  await expect(domCopies(page, 'Edited at 1440')).toHaveCount(1);
  await expect(domCopies(page, 'Original fixture note')).toHaveCount(0);
  await capture(page, 'repository-panel-edited-at-900');

  await deleteTodo(todoRow(page, 'Edited at 1440'));
  await expect(domCopies(page, 'Edited at 1440')).toHaveCount(0);
  await expect.poll(() => api.mutations()).toEqual([
    { method: 'PUT', path: '/api/repos/todos/todo-note', body: { content: 'Edited at 1440' } },
    { method: 'DELETE', path: '/api/repos/todos/todo-note', body: null },
  ]);
  expect(api.todos.map(todo => todo.todoId)).toEqual(['todo-keep', 'todo-billing']);

  for (const viewport of [WIDE, PHONE, NARROW, WIDE]) {
    await page.setViewportSize(viewport);
    if (viewport === WIDE) await expectWideLayout(page);
    else await expectNarrowDetail(page);
    await expectTodosTabShowing(page);
    await expect(todoRow(page, 'Untouched neighbour')).toBeVisible();
    await expect(domCopies(page, 'Edited at 1440')).toHaveCount(0);
    await expect(domCopies(page, 'Original fixture note')).toHaveCount(0);
    await expect(domCopies(page, 'Untouched neighbour')).toHaveCount(1);
  }
  await capture(page, 'repository-panel-deleted-stays-deleted-1440');

  // The panel was never remounted: its to-dos were read once, and the resizes wrote nothing.
  expect(api.loads('/api/repos/todos', 'acme/alpha')).toBe(1);
  expect(api.loads('/api/repos/chat/messages', 'acme/alpha')).toBe(1);
  expect(api.mutations()).toHaveLength(2);
  expect(api.taskOrProviderRequests()).toEqual([]);
});

test('a normally selected tab and unsent to-do and chat drafts survive 1440↔900↔phone resizes', async ({ page }) => {
  await page.setViewportSize(WIDE);
  const api = await statefulApi(page);
  await page.goto('/repositories');
  await repoListItem(page, 'acme/alpha').click();
  await expect(tab(page, 'Settings')).toHaveAttribute('aria-pressed', 'true');
  await tab(page, 'To-Dos').click();
  await expectTodosTabShowing(page);

  await page.setViewportSize(NARROW);
  await expectNarrowDetail(page);
  await expectTodosTabShowing(page);
  await capture(page, 'repository-panel-manual-tab-at-900');

  // An edit in progress is neither saved nor dropped by a resize, and keeps focus.
  const row = todoRow(page, 'Original fixture note');
  await row.hover();
  await row.getByTitle('Edit').click();
  const editor = row.getByRole('textbox');
  await editor.fill('Unsent to-do edit');
  for (const viewport of [WIDE, PHONE, NARROW, WIDE]) {
    await page.setViewportSize(viewport);
    await expect(editor).toHaveValue('Unsent to-do edit');
    await expect(editor).toBeFocused();
  }
  expect(api.mutations()).toEqual([]);
  await editor.press('Escape');
  await expect(todoRow(page, 'Original fixture note')).toBeVisible();

  await tab(page, 'Chat').click();
  const chatInput = page.getByPlaceholder('Ask a question about this repository...');
  await chatInput.fill('Unsent chat question');
  for (const viewport of [NARROW, PHONE, WIDE, NARROW]) {
    await page.setViewportSize(viewport);
    await expect(tab(page, 'Chat')).toHaveAttribute('aria-pressed', 'true');
    await expect(chatInput).toHaveValue('Unsent chat question');
    await expect(chatInput).toBeFocused();
  }
  await capture(page, 'repository-panel-chat-draft-at-900');

  expect(api.mutations()).toEqual([]);
  expect(api.loads('/api/repos/todos', 'acme/alpha')).toBe(1);
  expect(api.loads('/api/repos/chat/messages', 'acme/alpha')).toBe(1);
  expect(api.taskOrProviderRequests()).toEqual([]);
});

test('narrow Back and a repository switch still change the repository; desktop panel width survives a resize', async ({ page }) => {
  await page.setViewportSize(WIDE);
  const api = await statefulApi(page);
  await page.goto('/repositories');
  await repoListItem(page, 'acme/alpha').click();

  // Desktop panel resizing still works, and a round trip below lg keeps the chosen width.
  const handle = page.locator('[data-panel-resize-handle-id]');
  const list = page.locator('[data-panel-group]').filter({ has: handle }).locator(':scope > [data-panel]').first();
  const before = (await list.boundingBox())!.width;
  const grip = (await handle.boundingBox())!;
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await page.mouse.down();
  await page.mouse.move(grip.x + grip.width / 2 + 160, grip.y + grip.height / 2, { steps: 8 });
  await page.mouse.up();
  const resized = (await list.boundingBox())!.width;
  expect(resized).toBeGreaterThan(before + 100);
  await page.setViewportSize(NARROW);
  await expectNarrowDetail(page);
  await page.setViewportSize(WIDE);
  await expectWideLayout(page);
  expect(Math.abs((await list.boundingBox())!.width - resized)).toBeLessThanOrEqual(1);

  await page.setViewportSize(PHONE);
  await tab(page, 'To-Dos').click();
  await expect(todoRow(page, 'Original fixture note')).toBeVisible();
  await backButton(page).click();
  await expect(repoListItem(page, 'acme/alpha')).toBeVisible();
  await expect(repoListItem(page, 'acme/alpha')).toHaveAttribute('aria-pressed', 'false');
  await expect(domCopies(page, 'Original fixture note')).toHaveCount(0);

  await repoListItem(page, 'acme/billing').click();
  await expectNarrowDetail(page);
  await expect(page.getByText('acme/billing', { exact: true }).filter({ visible: true }).first()).toBeVisible();
  await expect(todoRow(page, 'Billing-only note')).toBeVisible();
  await expect(domCopies(page, 'Original fixture note')).toHaveCount(0);

  await page.setViewportSize(WIDE);
  await expectWideLayout(page);
  await expect(repoListItem(page, 'acme/billing')).toHaveAttribute('aria-pressed', 'true');
  await expect(domCopies(page, 'Billing-only note')).toHaveCount(1);

  expect(api.loads('/api/repos/todos', 'acme/billing')).toBe(1);
  expect(api.mutations()).toEqual([]);
  expect(api.taskOrProviderRequests()).toEqual([]);
});
