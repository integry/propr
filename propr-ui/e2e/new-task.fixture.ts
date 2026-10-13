import { expect, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

export const title = 'Fix the invoice date format';
export const taskId = 'acme-billing-42-issue-task';
export async function fixture(page: Page, failDispatch = false) {
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
// Records the attachments the page hands to the network, including their bytes,
// so decoded recovery output can be compared in every engine.
type SentAttachment = { name: string; type: string; lastModified: number; size: number; bytes: string };
export async function recordAttachments(page: Page) {
  await page.addInitScript(() => {
    const sent: Array<Promise<SentAttachment>> = [];
    Object.assign(window, { sentAttachments: sent });
    const append = FormData.prototype.append;
    FormData.prototype.append = function (this: FormData, ...args: [string, string | Blob, string?]) {
      const file = args[1];
      if (file instanceof File) sent.push(file.text().then(bytes => ({ name: file.name, type: file.type, lastModified: file.lastModified, size: file.size, bytes })));
      return append.apply(this, args as unknown as [string, Blob]);
    };
  });
  return () => page.evaluate(() => Promise.all((window as unknown as { sentAttachments: Array<Promise<SentAttachment>> }).sentAttachments));
}
export const submissionBodies = (page: Page) => {
  const bodies: Array<{ key: string; body: string }> = [];
  page.on('request', request => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/task-submissions') bodies.push({ key: request.headers()['idempotency-key'], body: request.postDataBuffer()?.toString('utf8') || '' });
  });
  return bodies;
};
export async function screenshot(page: Page, name: string) {
  if (!process.env.PROPR_CAPTURE_PREVIEWS) return;
  await mkdir('../.propr/previews', { recursive: true });
  await page.screenshot({ path: `../.propr/previews/${name}.png`, fullPage: true, animations: 'disabled' });
}
