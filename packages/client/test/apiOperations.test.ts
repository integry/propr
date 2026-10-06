import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  operationPath,
  ProprClient,
  ProprClientError,
  withQuery,
  type ProprApi,
} from '../src/index.js';

interface RecordedRequest {
  url: string;
  init: RequestInit | undefined;
}

function recordingClient(body: unknown, status = 200) {
  const requests: RecordedRequest[] = [];
  const client = new ProprClient({
    baseUrl: 'https://propr.example.com',
    authentication: { type: 'bearer', getAccessToken: () => 'gho_token' },
    fetch: async (input, init) => {
      requests.push({ url: String(input), init });
      return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    },
  });
  return { client, requests };
}

const submission: ProprApi.TaskSubmission = {
  id: 'submission-1', state: 'queued', issueNumber: 12, issueUrl: 'https://github.com/acme/app/issues/12',
  taskId: 'task-1', error: null,
};

describe('Typed dashboard API operations', () => {
  it('expands path templates with encoded values and rejects missing parameters', () => {
    assert.equal(operationPath('getTaskHistory', { taskId: 'acme/app#1' }), '/api/task/acme%2Fapp%231/history');
    assert.throws(() => operationPath('getTaskHistory'), ProprClientError);
    assert.throws(() => operationPath('getTaskSubmission', { key: '' }), ProprClientError);
  });

  it('appends only defined query values', () => {
    assert.equal(withQuery('/api/tasks', { status: 'active', limit: 10, search: undefined }), '/api/tasks?status=active&limit=10');
    assert.equal(withQuery('/api/tasks', {}), '/api/tasks');
  });

  it('lists tasks with query filters and bearer authentication', async () => {
    const page: ProprApi.TaskPage = { tasks: [], total: 0, offset: 0, limit: 5 };
    const { client, requests } = recordingClient(page);
    assert.deepEqual(await client.listTasks({ repository: 'acme/app', limit: 5 }), page);
    assert.equal(requests[0].url, 'https://propr.example.com/api/tasks?repository=acme%2Fapp&limit=5');
    assert.equal(new Headers(requests[0].init?.headers).get('Authorization'), 'Bearer gho_token');
  });

  it('gets a task with its events', async () => {
    const history: ProprApi.TaskHistory = { taskId: 'task-1', history: [{ state: 'completed', timestamp: '2026-10-06T00:00:00.000Z' }], taskInfo: null };
    const { client, requests } = recordingClient(history);
    assert.deepEqual(await client.getTaskHistory('task-1'), history);
    assert.equal(requests[0].url, 'https://propr.example.com/api/task/task-1/history');
  });

  it('creates a task submission with an idempotency key', async () => {
    const { client, requests } = recordingClient(submission);
    const request: ProprApi.TaskSubmissionRequest = { repository: 'acme/app', instruction: 'Fix the login redirect' };
    assert.deepEqual(await client.createTaskSubmission(request, { idempotencyKey: 'key-1' }), submission);
    const [{ url, init }] = requests;
    assert.equal(url, 'https://propr.example.com/api/task-submissions');
    assert.equal(init?.method, 'POST');
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('Idempotency-Key'), 'key-1');
    assert.equal(headers.get('Content-Type'), 'application/json');
    assert.deepEqual(JSON.parse(String(init?.body)), request);
  });

  it('refuses submissions without a usable idempotency key before any request', async () => {
    const { client, requests } = recordingClient(submission);
    const request = { repository: 'acme/app', instruction: 'Fix it' };
    for (const idempotencyKey of ['', '  ', 'a\nb', 'k'.repeat(256)]) {
      await assert.rejects(client.createTaskSubmission(request, { idempotencyKey }), (error: unknown) =>
        error instanceof ProprClientError && error.kind === 'configuration');
    }
    assert.equal(requests.length, 0);
  });

  it('reads and retries a submission by key', async () => {
    const { client, requests } = recordingClient(submission);
    await client.getTaskSubmission('key 1');
    await client.retryTaskSubmission('key 1');
    assert.equal(requests[0].url, 'https://propr.example.com/api/task-submissions/key%201');
    assert.equal(requests[1].url, 'https://propr.example.com/api/task-submissions/key%201/retry');
    assert.equal(requests[1].init?.method, 'POST');
  });

  it('surfaces the legacy error body and code of a failed request', async () => {
    const { client } = recordingClient({ error: 'Submission identity was already used with different content' }, 409);
    await assert.rejects(client.createTaskSubmission({ repository: 'acme/app', instruction: 'x' }, { idempotencyKey: 'k' }),
      (error: unknown) => error instanceof ProprClientError && error.status === 409 && error.kind === 'http');
  });
});
