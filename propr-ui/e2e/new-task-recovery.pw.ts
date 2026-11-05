import { test, expect } from '@playwright/test';
import { fixture, recordAttachments, screenshot, submissionBodies, taskId, title } from './new-task.fixture';

test('mobile dispatch error keeps the issue, instruction and attachments available', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await fixture(page, true);
  await page.goto('/tasks/new');
  await page.getByText('Select a repository', { exact: true }).click();
  await page.getByRole('button', { name: /acme.*billing/ }).click();
  await page.getByLabel('Prompt', { exact: true }).fill(title);
  await page.getByLabel('Attach files', { exact: true }).setInputFiles({ name: 'invoice-example.txt', mimeType: 'text/plain', buffer: Buffer.from('Expected invoice date: 22/09/2026') });
  await page.getByRole('button', { name: 'Run task', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveCount(1);
  await expect(page.getByRole('alert')).toContainText('Issue #42 created, but agent failed to queue');
  await expect(page.getByLabel('Prompt', { exact: true })).toHaveValue(title);
  await expect(page.getByText('invoice-example.txt')).toBeVisible();
  await page.getByRole('button', { name: 'Retry agent' }).scrollIntoViewIfNeeded();
  await expect(page.getByRole('link', { name: 'View issue #42' })).toBeVisible();
  const retryBox = await page.getByRole('button', { name: 'Retry agent' }).boundingBox();
  expect(retryBox!.y + retryBox!.height).toBeLessThanOrEqual(844);
  await expect(page.getByRole('button', { name: 'Start over' })).toHaveCount(0);
  await screenshot(page, 'new-task-error-mobile');
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page).toHaveURL(/\/tasks$/);
  await page.goto('/tasks/new');
  await expect(page.getByLabel('Prompt', { exact: true })).toBeEnabled();
  await expect(page.getByLabel('Prompt', { exact: true })).toHaveValue('');
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
    await page.getByLabel('Prompt', { exact: true }).fill(title);
    await page.getByRole('button', { name: 'Run task', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Edit request' })).toBeEnabled();
    await page.getByRole('button', { name: 'Edit request' }).scrollIntoViewIfNeeded();
    await screenshot(page, `new-task-rejected-${device}`);
    // Restore the definitive rejection from the submission endpoint.
    await page.route('**/api/task-submissions/*', route => route.fulfill({ json: { id: 'rejected', state: 'prepared', issueNumber: null, issueUrl: null, taskId: null, error: 'GitHub rejected issue creation.' } }));
    await page.reload();
    await page.getByRole('button', { name: 'Edit request' }).click();
    await expect(page.getByLabel('Prompt', { exact: true })).toBeEnabled();
    await expect(page.getByLabel('Prompt', { exact: true })).toHaveValue(title);
    await page.getByLabel('Prompt', { exact: true }).fill(`${title}. Use the account locale.`);
    await page.getByRole('button', { name: 'Run task', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Edit request' })).toBeEnabled();
    expect(keys).toHaveLength(2);
    expect(keys[1]).not.toBe(keys[0]);
  });
}

test('completing one tab preserves another tab’s lost-response request and attachment bytes', async ({ page, context, browserName }) => {
  const other = await context.newPage();
  await fixture(page, true);
  await fixture(other, true);
  const sentAttachments = await recordAttachments(other);
  const otherBodies = submissionBodies(other);
  const keys: string[] = [];
  page.on('request', request => { if (new URL(request.url()).pathname === '/api/task-submissions') keys[0] = request.headers()['idempotency-key']; });
  other.on('request', request => { if (new URL(request.url()).pathname === '/api/task-submissions') keys[1] = request.headers()['idempotency-key']; });
  await other.route('**/api/task-submissions**', route => route.fulfill({ status: 503, json: { error: 'Response lost; retry this submission to recover.' } }));
  // Both launchers are open before either writes recovery data.
  await Promise.all([page.goto('/tasks/new'), other.goto('/tasks/new')]);
  for (const tab of [page, other]) {
    await tab.getByText('Select a repository', { exact: true }).click();
    await tab.getByRole('button', { name: /acme.*billing/ }).click();
    await tab.getByLabel('Prompt', { exact: true }).fill(title);
  }
  await other.getByLabel('Attach files', { exact: true }).setInputFiles({ name: 'recovery.txt', mimeType: 'text/plain', buffer: Buffer.from('Retain these recovery bytes') });
  await page.getByRole('button', { name: 'Run task', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Retry agent' })).toBeEnabled();
  await other.getByRole('button', { name: 'Run task', exact: true }).click();
  await expect(other.getByRole('alert')).toContainText('HTTP 503');
  expect(keys[1]).not.toBe(keys[0]);
  const [original] = await sentAttachments();
  expect(original).toMatchObject({ name: 'recovery.txt', type: 'text/plain', size: 27, bytes: 'Retain these recovery bytes' });
  await page.route('**/api/task-submissions/*', route => route.fulfill({ json: { id: 'completed', state: 'queued', issueNumber: 42, issueUrl: null, taskId, error: null } }));
  await page.reload();
  await expect(page).toHaveURL(new RegExp(`/tasks/${taskId}$`));
  await other.reload();
  await expect(other.getByLabel('Prompt', { exact: true })).toHaveValue(title);
  await expect(other.getByText('recovery.txt')).toBeVisible();
  // Recovery records persist portable bytes and file metadata, not engine-specific File objects.
  const saved = await other.evaluate(async () => {
    const db = await new Promise<IDBDatabase>(resolve => { const request = indexedDB.open('propr-task-launcher', 1); request.onsuccess = () => resolve(request.result); });
    try {
      const rows = await new Promise<Array<{ key: string; files: Array<{ name: string; type: string; lastModified: number; bytes: ArrayBuffer }> }>>(resolve => { const request = db.transaction('submissions').objectStore('submissions').getAll(); request.onsuccess = () => resolve(request.result); });
      return rows.map(row => ({ key: row.key, files: row.files.map(file => ({ name: file.name, type: file.type, lastModified: file.lastModified, bytes: new TextDecoder().decode(file.bytes) })) }));
    } finally { db.close(); }
  });
  expect(saved).toEqual([{ key: keys[1], files: [{ name: 'recovery.txt', type: 'text/plain', lastModified: original.lastModified, bytes: 'Retain these recovery bytes' }] }]);
  await other.getByRole('button', { name: 'Retry submission' }).click();
  await expect(other.getByRole('alert')).toContainText('HTTP 503');
  expect(keys[1]).toBe(saved[0].key);
  // The reconstructed File carries the same name, type, lastModified and bytes.
  expect(await sentAttachments()).toEqual([original]);
  expect(otherBodies.map(({ key }) => key)).toEqual([keys[1], keys[1]]);
  for (const { body } of otherBodies) {
    expect(body).toContain('filename="recovery.txt"\r\nContent-Type: text/plain');
    // WebKit omits Blob parts from intercepted request bodies; the bytes are checked at FormData above.
    if (browserName === 'chromium') expect(body).toContain('Content-Type: text/plain\r\n\r\nRetain these recovery bytes\r\n');
  }
});

test('a storage failure keeps the request and files without submitting, and the next run succeeds', async ({ page }) => {
  const pageErrors: Error[] = [];
  page.on('pageerror', error => pageErrors.push(error));
  const requests = await fixture(page);
  const sentAttachments = await recordAttachments(page);
  await page.addInitScript(() => {
    // Mirror WebKit's Blob/File write failure: the request fails after put() and transaction.error stays null.
    Object.assign(window, { failTaskStorage: true });
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore['put']>) {
      const request = put.apply(this, args);
      if ((window as unknown as { failTaskStorage: boolean }).failTaskStorage) this.transaction.abort();
      return request;
    };
  });
  await page.goto('/tasks/new');
  await page.getByText('Select a repository', { exact: true }).click();
  await page.getByRole('button', { name: /acme.*billing/ }).click();
  await page.getByLabel('Prompt', { exact: true }).fill(title);
  await page.getByLabel('Attach files', { exact: true }).setInputFiles({ name: 'invoice-example.txt', mimeType: 'text/plain', buffer: Buffer.from('Expected invoice date: 22/09/2026') });
  await page.getByRole('button', { name: 'Run task', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Task not submitted: this browser could not save it for safe retry.');
  await expect(page.getByRole('alert')).toContainText('Could not save task recovery data in this browser.');
  await expect(page).toHaveURL(/\/tasks\/new$/);
  await expect(page.getByLabel('Prompt', { exact: true })).toBeEnabled();
  await expect(page.getByLabel('Prompt', { exact: true })).toHaveValue(title);
  await expect(page.getByText('invoice-example.txt')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Run task', exact: true })).toBeEnabled();
  expect(requests.filter(request => request.startsWith('POST /api/task-submissions'))).toEqual([]);
  expect(await sentAttachments()).toEqual([]);
  await page.getByRole('alert').scrollIntoViewIfNeeded();
  await screenshot(page, 'new-task-storage-failure-desktop');
  await page.evaluate(() => Object.assign(window, { failTaskStorage: false }));
  await page.getByRole('button', { name: 'Run task', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/tasks/${taskId}$`));
  expect(requests.filter(request => request === 'POST /api/task-submissions')).toHaveLength(1);
  expect(await sentAttachments()).toEqual([expect.objectContaining({ name: 'invoice-example.txt', type: 'text/plain', size: 33, bytes: 'Expected invoice date: 22/09/2026' })]);
  expect(pageErrors).toEqual([]);
});

test('legacy File-based recovery records restore exact bytes, metadata and identity', async ({ page }) => {
  await fixture(page, true);
  const sentAttachments = await recordAttachments(page);
  const bodies = submissionBodies(page);
  await page.route('**/api/task-submissions**', route => route.fulfill({ status: 503, json: { error: 'Response lost; retry this submission to recover.' } }));
  await page.goto('/tasks/new');
  await page.getByText('Select a repository', { exact: true }).click();
  await page.getByRole('button', { name: /acme.*billing/ }).click();
  await page.getByLabel('Prompt', { exact: true }).fill(title);
  await page.getByRole('button', { name: 'Run task', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('HTTP 503');
  // Rewrite the record as an older release stored it: File objects under the bare scope key.
  const legacyKey = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>(resolve => { const request = indexedDB.open('propr-task-launcher', 1); request.onsuccess = () => resolve(request.result); });
    try {
      return await new Promise<string | null>(resolve => {
        const tx = db.transaction('submissions', 'readwrite');
        const store = tx.objectStore('submissions');
        let key: string | null = null;
        store.openCursor().onsuccess = event => {
          const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;
          const [scope] = JSON.parse(String(cursor.key));
          key = cursor.value.key;
          const file = new File(['Legacy invoice bytes'], 'legacy-invoice.txt', { type: 'text/plain', lastModified: 1758531600000 });
          store.put({ key, payload: cursor.value.payload, files: [file] }, scope);
          cursor.delete();
          sessionStorage.removeItem(`task-active-submission:${scope}`);
        };
        tx.oncomplete = () => resolve(key);
        tx.onabort = () => resolve(null);
      });
    } finally { db.close(); }
  });
  // Engines that cannot store File objects (WebKit) never wrote File-based records.
  test.skip(!legacyKey, 'This engine cannot persist File objects in IndexedDB');
  await page.reload();
  await expect(page.getByLabel('Prompt', { exact: true })).toHaveValue(title);
  await expect(page.getByText('legacy-invoice.txt')).toBeVisible();
  await page.getByRole('button', { name: 'Retry submission' }).click();
  await expect(page.getByRole('alert')).toContainText('HTTP 503');
  expect(bodies.map(({ key }) => key)).toEqual([legacyKey, legacyKey]);
  expect(bodies[1].body).toMatch(/filename="legacy-invoice.txt"\r\nContent-Type: text\/plain\r\n\r\nLegacy invoice bytes\r\n/);
  expect(await sentAttachments()).toEqual([{ name: 'legacy-invoice.txt', type: 'text/plain', lastModified: 1758531600000, size: 20, bytes: 'Legacy invoice bytes' }]);
});

test('legacy recovery snapshots are adopted and discarded only with their matching identity', async ({ page }) => {
  await fixture(page, true);
  await page.goto('/tasks/new');
  await page.getByText('Select a repository', { exact: true }).click();
  await page.getByRole('button', { name: /acme.*billing/ }).click();
  await page.getByLabel('Prompt', { exact: true }).fill(title);
  await page.getByRole('button', { name: 'Run task', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Retry agent' })).toBeEnabled();
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
  await expect(page.getByLabel('Prompt', { exact: true })).toHaveValue(title);
  await expect(page.getByRole('button', { name: 'Close', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page).toHaveURL(/\/tasks$/);
  await page.goto('/tasks/new');
  await expect(page.getByLabel('Prompt', { exact: true })).toBeEnabled();
  await expect(page.getByLabel('Prompt', { exact: true })).toHaveValue('');
  await expect(page.getByRole('button', { name: 'Retry agent' })).toHaveCount(0);
});
