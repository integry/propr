import { test, expect, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

const title = 'Fix the invoice date format';
const taskId = 'acme-billing-42-issue-task';
async function fixture(page: Page, failDispatch = false) {
  let submitted = false;
  let polls = 0;
  const requests: string[] = [];
  await page.routeWebSocket('**/socket.io/**', socket => socket.close());
  await page.route('**/api/**', async route => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    requests.push(`${request.method()} ${pathname}`);
    if (pathname.startsWith('/api/task-submissions')) {
      if (request.method() === 'POST') {
        expect(request.postData()).toContain('Fix the invoice date format');
        expect(request.headers()['idempotency-key']).toBeTruthy();
        submitted = true;
      } else polls++;
      return route.fulfill({ json: { id: 'submission', state: failDispatch ? 'failed' : submitted ? 'queued' : 'creating', issueNumber: 42, issueUrl: 'https://github.com/acme/billing/issues/42', taskId: !failDispatch && polls > 0 ? taskId : null, error: failDispatch ? 'Implementation could not be queued. Retry to start the existing issue.' : null } });
    }
    const responses: Record<string, unknown> = {
      '/api/auth/demo-mode': { demoMode: false },
      '/api/auth/user': { id: 'preview-user', login: 'operator', username: 'operator', displayName: 'Operator', email: null, avatarUrl: null, role: 'admin', permissions: ['instance.manage_settings'], authorizationSource: 'local' },
      '/api/instance/catalog': { repositories: [{ id: 'billing', name: 'acme/billing', enabled: true, baseBranch: 'main' }], agents: [{ alias: 'codex', enabled: true, supportedModels: ['gpt-6-astra'], defaultModel: 'gpt-6-astra' }], defaultAgentAlias: 'codex' },
      '/api/config/repos': { success: true, repos_to_monitor: [{ id: 'billing', name: 'acme/billing', alias: 'Billing service', enabled: true }] },
      '/api/repositories/indexing-status': { repositories: [] },
      '/api/repos/chat/messages': { messages: [] },
      '/api/repos/todos/categories': { categories: [] },
      '/api/repos/todos': { todos: [{ todoId: 'todo-1', categoryId: null, content: title, isCompleted: false, orderIndex: 0 }] },
      '/api/user/repo-preferences': { preferences: {} },
      '/api/notifications/unread-count': { unreadCount: 0 },
      '/api/notifications/config': { push: { configured: false, vapidPublicKey: null } },
      '/api/notifications/preferences': { preferences: {}, quietHours: {}, badgeEnabled: false },
      '/api/planner/drafts': { drafts: [] },
      '/api/stats/active-work': { counts: { tasks: 0, plans: 0, goals: 0, total: 0 } },
      '/api/tasks': { tasks: [{ id: taskId, repository: 'acme/billing', issueNumber: 42, title, status: 'completed', modelName: 'gpt-6-astra', createdAt: '2026-09-22T09:00:00Z', prNumber: 43 }], total: 1 },
      [`/api/task/${taskId}/history`]: {
        history: [
          { state: 'PENDING', timestamp: '2026-09-22T09:00:00Z' },
          { state: 'CLAUDE_EXECUTION', timestamp: '2026-09-22T09:01:00Z' },
          { state: 'COMPLETED', timestamp: '2026-09-22T09:05:00Z', metadata: { pr: { url: 'https://github.com/acme/billing/pull/43', number: 43 } } },
        ], taskInfo: { title, type: 'issue', number: 42, issueNumber: 42, repoOwner: 'acme', repoName: 'billing', modelName: 'gpt-6-astra' }, usageMetricRecords: [],
      },
      [`/api/task/${taskId}/live-details`]: { events: [], todos: [{ id: '1', content: 'Use the account locale for invoice dates', status: 'completed' }], currentTask: null },
      [`/api/task/${taskId}/file-changes`]: { taskId, lastUpdated: '2026-09-22T09:05:00Z', files: [{ path: 'src/invoices/dateFormat.ts', status: 'modified', linesAdded: 8, linesRemoved: 3, diff: '' }] },
      [`/api/task/${taskId}/analysis`]: { analysis: { analysis: JSON.stringify({ summary_of_changes: 'Invoice dates now use the account locale on the invoice page and PDF export. Formatting tests pass.', implementation_critique_score: 9 }) } },
    };
    return route.fulfill(pathname in responses ? { json: responses[pathname] } : { status: 503, json: { error: 'Optional endpoint unavailable in visual fixture' } });
  });
  return requests;
}
async function screenshot(page: Page, name: string) {
  if (!process.env.PROPR_CAPTURE_PREVIEWS) return;
  await mkdir('../.propr/previews', { recursive: true });
  await page.screenshot({ path: `../.propr/previews/${name}.png`, fullPage: true, animations: 'disabled' });
}
for (const [device, viewport] of Object.entries({ desktop: { width: 1440, height: 960 }, mobile: { width: 390, height: 844 } })) {
  test(`launches an ordinary issue task on ${device}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const requests = await fixture(page);
    await page.goto('/tasks');
    await page.getByRole('button', { name: 'New Task', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'New task', exact: true })).toBeVisible();
    await page.getByText('Select a repository', { exact: true }).click();
    await page.getByRole('button', { name: /acme.*billing/ }).click();
    await page.getByLabel('Instruction').fill('Fix the invoice date format. Use the account locale on the invoice page and PDF export.');
    await expect(page.getByRole('button', { name: 'Run task', exact: true })).toBeEnabled();
    await screenshot(page, `new-task-${device}`);
    await page.getByRole('button', { name: 'Run task', exact: true }).click();
    await expect(page.getByRole('link', { name: 'Open issue #42' })).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/tasks/${taskId}$`));
    await expect(page.getByTestId('task-details')).toBeVisible();
    await expect(page.getByText(title, { exact: true }).filter({ visible: true }).first()).toBeVisible();
    await expect(page.getByText("What's done?", { exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Pause goal|Continue goal|Send correction/ })).toHaveCount(0);
    expect(requests.filter(request => request === 'POST /api/task-submissions')).toHaveLength(1);
    expect(requests.some(request => request.startsWith('POST /api/goals'))).toBe(false);
    expect(requests.some(request => request.startsWith('POST /api/planner'))).toBe(false);
    await screenshot(page, `new-task-destination-${device}`);
  });
}


test('repository and todo launchers prefill the request without completing the todo', async ({ page }) => {
  const requests = await fixture(page);
  await page.goto('/repositories');
  await page.getByRole('button', { name: 'Select acme/billing', exact: true }).first().click();
  await page.getByRole('link', { name: 'New task', exact: true }).click();
  await expect(page).toHaveURL(/\/tasks\/new$/);
  await expect(page.getByText('billing', { exact: true })).toBeVisible();
  await page.goto('/repositories');
  await page.getByRole('button', { name: 'Select acme/billing', exact: true }).first().click();
  await page.getByRole('button', { name: 'To-Dos', exact: true }).click();
  await page.getByRole('button', { name: `Select todo: ${title}` }).click();
  await page.getByRole('button', { name: 'Run task', exact: true }).click();
  await expect(page.getByLabel('Instruction')).toHaveValue(title);
  await expect(page.getByText('billing', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Run task', exact: true })).toBeEnabled();
  expect(requests.filter(request => /^(POST|PATCH|PUT|DELETE) \/api\/repos\/todos/.test(request))).toEqual([]);
});


test('mobile dispatch error keeps the issue, instruction and attachments available', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await fixture(page, true);
  await page.goto('/tasks/new');
  await page.getByText('Select a repository', { exact: true }).click();
  await page.getByRole('button', { name: /acme.*billing/ }).click();
  await page.getByLabel('Instruction').fill(title);
  await page.getByLabel('Attach files', { exact: true }).setInputFiles({ name: 'invoice-example.txt', mimeType: 'text/plain', buffer: Buffer.from('Expected invoice date: 22/09/2026') });
  await page.getByRole('button', { name: 'Run task', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('existing issue');
  await expect(page.getByLabel('Instruction')).toHaveValue(title);
  await expect(page.getByText('invoice-example.txt')).toBeVisible();
  await page.getByRole('button', { name: 'Retry submission' }).scrollIntoViewIfNeeded();
  await expect(page.getByRole('link', { name: 'Open issue #42' })).toBeVisible();
  const retryBox = await page.getByRole('button', { name: 'Retry submission' }).boundingBox();
  const navigationBox = await page.locator('.mobile-bottom-navigation').boundingBox();
  expect(retryBox!.y + retryBox!.height).toBeLessThanOrEqual(navigationBox!.y);
  await expect(page.getByRole('button', { name: 'Start over' })).toBeEnabled();
  await screenshot(page, 'new-task-error-mobile');
  await page.getByRole('button', { name: 'Start over' }).click();
  await expect(page.getByLabel('Instruction')).toBeEnabled();
  await expect(page.getByLabel('Instruction')).toHaveValue('');
  await expect(page.getByText('invoice-example.txt')).toHaveCount(0);
});

for (const [device, viewport] of Object.entries({ desktop: { width: 1440, height: 960 }, mobile: { width: 390, height: 844 } })) {
  test(`a rejected creation can be edited and submitted with a new identity on ${device}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await fixture(page);
    const keys: string[] = [];
    await page.route('**/api/task-submissions', route => {
      keys.push(route.request().headers()['idempotency-key']);
      return route.fulfill({ json: { id: 'rejected', state: 'prepared', issueNumber: null, issueUrl: null, taskId: null, error: 'GitHub rejected issue creation. Update the request and try again.' } });
    });
    await page.goto('/tasks/new');
    await page.getByText('Select a repository', { exact: true }).click();
    await page.getByRole('button', { name: /acme.*billing/ }).click();
    await page.getByLabel('Instruction').fill(title);
    await page.getByRole('button', { name: 'Run task', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Edit request' })).toBeEnabled();
    await page.getByRole('button', { name: 'Edit request' }).scrollIntoViewIfNeeded();
    await screenshot(page, `new-task-rejected-${device}`);
    // Restore the definitive rejection from the submission endpoint.
    await page.route('**/api/task-submissions/*', route => route.fulfill({ json: { id: 'rejected', state: 'prepared', issueNumber: null, issueUrl: null, taskId: null, error: 'GitHub rejected issue creation.' } }));
    await page.reload();
    await page.getByRole('button', { name: 'Edit request' }).click();
    await expect(page.getByLabel('Instruction')).toBeEnabled();
    await expect(page.getByLabel('Instruction')).toHaveValue(title);
    await page.getByLabel('Instruction').fill(`${title}. Use the account locale.`);
    await page.getByRole('button', { name: 'Run task', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Edit request' })).toBeEnabled();
    expect(keys).toHaveLength(2);
    expect(keys[1]).not.toBe(keys[0]);
  });
}

test('completing one tab preserves another tab’s lost-response request and attachment bytes', async ({ page, context }) => {
  const other = await context.newPage();
  await fixture(page, true);
  await fixture(other, true);
  const keys: string[] = [];
  page.on('request', request => { if (new URL(request.url()).pathname === '/api/task-submissions') keys[0] = request.headers()['idempotency-key']; });
  other.on('request', request => { if (new URL(request.url()).pathname === '/api/task-submissions') keys[1] = request.headers()['idempotency-key']; });
  await other.route('**/api/task-submissions**', route => route.fulfill({ status: 503, json: { error: 'Response lost; retry this submission to recover.' } }));
  // Both launchers are open before either writes recovery data.
  await Promise.all([page.goto('/tasks/new'), other.goto('/tasks/new')]);
  for (const tab of [page, other]) {
    await tab.getByText('Select a repository', { exact: true }).click();
    await tab.getByRole('button', { name: /acme.*billing/ }).click();
    await tab.getByLabel('Instruction').fill(title);
  }
  await other.getByLabel('Attach files', { exact: true }).setInputFiles({ name: 'recovery.txt', mimeType: 'text/plain', buffer: Buffer.from('Retain these recovery bytes') });
  await page.getByRole('button', { name: 'Run task', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Retry submission' })).toBeEnabled();
  await other.getByRole('button', { name: 'Run task', exact: true }).click();
  await expect(other.getByRole('alert')).toContainText('HTTP 503');
  expect(keys[1]).not.toBe(keys[0]);
  await page.route('**/api/task-submissions/*', route => route.fulfill({ json: { id: 'completed', state: 'queued', issueNumber: 42, issueUrl: null, taskId, error: null } }));
  await page.reload();
  await expect(page).toHaveURL(new RegExp(`/tasks/${taskId}$`));
  await other.reload();
  await expect(other.getByLabel('Instruction')).toHaveValue(title);
  await expect(other.getByText('recovery.txt')).toBeVisible();
  const saved = await other.evaluate(async () => {
    const db = await new Promise<IDBDatabase>(resolve => { const request = indexedDB.open('propr-task-launcher', 1); request.onsuccess = () => resolve(request.result); });
    try {
      const rows = await new Promise<Array<{ key: string; files: File[] }>>(resolve => { const request = db.transaction('submissions').objectStore('submissions').getAll(); request.onsuccess = () => resolve(request.result); });
      return Promise.all(rows.map(async row => ({ key: row.key, bytes: await row.files[0].text() })));
    } finally { db.close(); }
  });
  expect(saved).toEqual([{ key: keys[1], bytes: 'Retain these recovery bytes' }]);
  await other.getByRole('button', { name: 'Retry submission' }).click();
  await expect(other.getByRole('alert')).toContainText('HTTP 503');
  expect(keys[1]).toBe(saved[0].key);
});

test('legacy recovery snapshots are adopted and discarded only with their matching identity', async ({ page }) => {
  await fixture(page, true);
  await page.goto('/tasks/new');
  await page.getByText('Select a repository', { exact: true }).click();
  await page.getByRole('button', { name: /acme.*billing/ }).click();
  await page.getByLabel('Instruction').fill(title);
  await page.getByRole('button', { name: 'Run task', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Retry submission' })).toBeEnabled();
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>(resolve => { const request = indexedDB.open('propr-task-launcher', 1); request.onsuccess = () => resolve(request.result); });
    try {
      await new Promise<void>(resolve => {
        const tx = db.transaction('submissions', 'readwrite');
        const store = tx.objectStore('submissions');
        const request = store.openCursor();
        request.onsuccess = () => {
          const cursor = request.result!;
          const [scope] = JSON.parse(String(cursor.key));
          store.put(cursor.value, scope);
          cursor.delete();
          sessionStorage.removeItem(`task-active-submission:${scope}`);
        };
        tx.oncomplete = () => resolve();
      });
    } finally { db.close(); }
  });
  await page.reload();
  await expect(page.getByLabel('Instruction')).toHaveValue(title);
  await expect(page.getByRole('button', { name: 'Start over' })).toBeEnabled();
  await page.getByRole('button', { name: 'Start over' }).click();
  await expect(page.getByLabel('Instruction')).toBeEnabled();
  await page.reload();
  await expect(page.getByLabel('Instruction')).toHaveValue('');
  await expect(page.getByRole('button', { name: 'Retry submission' })).toHaveCount(0);
});
