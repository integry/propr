import { afterEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { ApiClient } from '../packages/cli/src/api/client.js';
import { ConfigManager } from '../packages/cli/src/config/ConfigManager.js';
import { NetworkError } from '../packages/cli/src/api/errors.js';

function createClient(): ApiClient {
  return new ApiClient(new ConfigManager('/tmp/propr-cli-api-client-test'), {
    baseUrl: 'https://api.example.test',
    token: 'test-token',
  });
}

afterEach(() => mock.restoreAll());

test('GET retries transient transport failures and returns the later response', async () => {
  let calls = 0;
  mock.method(globalThis, 'fetch', async () => {
    calls++;
    if (calls < 3) throw new TypeError('fetch failed');
    return Response.json({ status: 'ok' });
  });

  const response = await createClient().get<{ status: string }>('/api/status');

  assert.equal(calls, 3);
  assert.deepStrictEqual(response.data, { status: 'ok' });
});

test('GET stops after three transient transport failures', async () => {
  let calls = 0;
  mock.method(globalThis, 'fetch', async () => {
    calls++;
    throw new TypeError('fetch failed');
  });

  await assert.rejects(createClient().get('/api/status'), NetworkError);
  assert.equal(calls, 3);
});

test('mutating requests are never retried after an ambiguous transport failure', async () => {
  let calls = 0;
  mock.method(globalThis, 'fetch', async () => {
    calls++;
    throw new TypeError('fetch failed');
  });

  await assert.rejects(
    createClient().post('/api/plans', { body: { prompt: 'Create a plan' } }),
    NetworkError,
  );
  assert.equal(calls, 1);
});

test('GET does not retry HTTP error responses', async () => {
  let calls = 0;
  mock.method(globalThis, 'fetch', async () => {
    calls++;
    return Response.json({ error: 'Service unavailable' }, { status: 503 });
  });

  await assert.rejects(createClient().get('/api/status'), { status: 503 });
  assert.equal(calls, 1);
});
