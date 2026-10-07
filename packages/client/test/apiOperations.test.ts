import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  operationPath,
  PROPR_API_OPERATIONS,
  ProprClient,
  ProprClientError,
  withQuery,
  type ProprApi,
  type ProprApiOperationId,
  type ProprDesktopPairingComplete,
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

const pairingId = `dpr_${'A'.repeat(22)}`;
const pairingNow = Date.parse('2026-01-01T00:00:00.000Z');
const pairingBinding = {
  instanceId: 'profile-a',
  origin: 'https://propr.example.com',
  scope: 'desktop-instance' as const,
  credentialGeneration: 'G'.repeat(22),
};
const pairing: ProprDesktopPairingComplete = {
  token: `propr_it_${'C'.repeat(43)}`, tokenType: 'Bearer', pairingId, deviceSecret: 'B'.repeat(43),
  activationTicket: 'T'.repeat(43), activationExpiresAt: new Date(pairingNow + 60_000).toISOString(), ...pairingBinding,
};
const pairingStart = {
  pairingId, deviceSecret: 'B'.repeat(43), approvalUrl: `https://propr.example.com/api/desktop/pairings/${pairingId}/browser`,
  expiresAt: new Date(pairingNow + 10 * 60_000).toISOString(), interval: 2,
};

/**
 * One call per operation in the table, with the path parameters it uses. The
 * `Record` type makes a new table entry fail to compile until it is covered.
 */
const OPERATION_CALLS: Record<ProprApiOperationId, {
  parameters?: Record<string, string>;
  call: (client: ProprClient) => Promise<unknown>;
}> = {
  getCompatibility: { call: client => client.negotiateCompatibility() },
  getDesktopDiscovery: { call: client => client.discoverDesktop() },
  startDesktopPairing: { call: client => client.startDesktopPairing('Test desktop', { binding: pairingBinding, now: () => pairingNow }) },
  pollDesktopPairing: {
    parameters: { pairingId },
    call: client => client.pairDesktop('Test desktop', {
      binding: pairingBinding, now: () => pairingNow, sleep: async () => undefined, onApprovalRequired: () => undefined,
    }),
  },
  activateDesktopPairing: { parameters: { pairingId }, call: client => client.activateDesktopPairing(pairing) },
  cancelDesktopPairing: { parameters: { pairingId }, call: client => client.cancelDesktopPairing(pairing) },
  listTasks: { call: client => client.listTasks() },
  getTaskHistory: { parameters: { taskId: 'task-1' }, call: client => client.getTaskHistory('task-1') },
  createTaskSubmission: {
    call: client => client.createTaskSubmission({ repository: 'acme/app', instruction: 'Fix it' }, { idempotencyKey: 'key-1' }),
  },
  getTaskSubmission: { parameters: { key: 'key-1' }, call: client => client.getTaskSubmission('key-1') },
  retryTaskSubmission: { parameters: { key: 'key-1' }, call: client => client.retryTaskSubmission('key-1') },
};

describe('Typed dashboard API operations', () => {
  for (const [id, { parameters, call }] of Object.entries(OPERATION_CALLS) as [ProprApiOperationId, typeof OPERATION_CALLS[ProprApiOperationId]][]) {
    it(`sends ${id} with the method and path of the operations table`, async () => {
      const { method } = PROPR_API_OPERATIONS[id];
      const target = `https://propr.example.com${operationPath(id, parameters)}`;
      const requests: RecordedRequest[] = [];
      const client = new ProprClient({
        baseUrl: 'https://propr.example.com',
        authentication: { type: 'bearer', getAccessToken: () => 'gho_token' },
        fetch: async (input, init) => {
          const url = String(input);
          requests.push({ url, init });
          // Earlier steps of a flow (the pairing start before a poll) succeed;
          // the request under test fails, which ends the call.
          if (url.split('?')[0] !== target && url.endsWith('/api/desktop/pairings')) {
            return new Response(JSON.stringify(pairingStart), { status: 201, headers: { 'Content-Type': 'application/json' } });
          }
          return new Response('{}', { status: 500, headers: { 'Content-Type': 'application/json' } });
        },
      });
      await call(client).catch(() => undefined);
      const sent = requests.filter(request => request.url.split('?')[0] === target);
      assert.equal(sent.length, 1, `${id} should request ${target}; requested ${requests.map(request => request.url).join(', ')}`);
      assert.equal(sent[0].init?.method ?? 'GET', method);
    });
  }

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
    for (const idempotencyKey of ['', '  ', 'a\nb', 'k'.repeat(256), '.', '..', ' .. ']) {
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

  it('refuses to read or retry a submission by a key the path cannot address', async () => {
    const { client, requests } = recordingClient(submission);
    for (const key of ['', '.', '..', 'a\nb']) {
      await assert.rejects(client.getTaskSubmission(key), (error: unknown) =>
        error instanceof ProprClientError && error.kind === 'configuration');
      await assert.rejects(client.retryTaskSubmission(key), (error: unknown) =>
        error instanceof ProprClientError && error.kind === 'configuration');
    }
    assert.equal(requests.length, 0);
  });

  it('surfaces the legacy error body and code of a failed request', async () => {
    const { client } = recordingClient({ error: 'Submission identity was already used with different content' }, 409);
    await assert.rejects(client.createTaskSubmission({ repository: 'acme/app', instruction: 'x' }, { idempotencyKey: 'k' }),
      (error: unknown) => error instanceof ProprClientError && error.status === 409 && error.kind === 'http');
  });
});
