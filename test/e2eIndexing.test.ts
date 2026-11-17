import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ApiClient } from '../packages/cli/src/api/client.js';
import type { RepositoryIndexingStatus } from '../packages/cli/src/api/repos.js';
import { waitForIndexedRepo, triggerAndWaitForIndexing, INDEXING_BUDGET_MS, INDEXING_TEST_TIMEOUT_MS } from './e2e/indexing.js';

const row = (status: RepositoryIndexingStatus['indexing_status'], branch = 'HEAD') => ({
  full_name: 'owner/repo', branch, indexing_status: status,
  last_indexed_at: '2026-11-04', last_indexed_hash: '12345678',
  progress: { phase: 'files', processedFiles: 2, totalFiles: 8, processedDirectories: 0, totalDirectories: 3 },
});

test('polling accounts for request time and reports progress before the test timeout', async () => {
  let now = 0;
  let requests = 0;
  const client = {
    get: async (_path: string, request: { signal: AbortSignal; timeout: number; retry: boolean }) => {
      assert.ok(request.signal);
      assert.equal(request.retry, false);
      assert.ok(request.timeout <= 100 - now);
      requests++;
      now += 20;
      return { data: { repositories: [row('indexing')] } };
    },
  } as unknown as ApiClient;
  await assert.rejects(waitForIndexedRepo('owner/repo', client, {
    now: () => now, deadline: 100, sleep: async ms => { now += ms; },
  }), /last status=indexing, phase=files, files=2\/8, directories=0\/3.*timed out/);
  assert.equal(now, 100);
  assert.equal(requests, 1, 'no requests after the deadline');
  assert.ok(INDEXING_TEST_TIMEOUT_MS > INDEXING_BUDGET_MS);
});

test('polls immediately and waits for the branch returned by the trigger', async () => {
  let calls = 0;
  const client = {
    post: async () => ({ data: { success: true, baseBranch: 'release' } }),
    get: async () => ({ data: { repositories: [row('completed'), row(++calls === 1 ? 'indexing' : 'completed', 'release')] } }),
  } as unknown as ApiClient;
  await triggerAndWaitForIndexing('owner/repo', false, client, { sleep: async () => {}, log: () => {} });
  assert.equal(calls, 2, 'completed HEAD must not mask unfinished release indexing');
});

test('failed indexing reports its last progress immediately', async () => {
  const client = { get: async () => ({ data: { repositories: [row('failed')] } }) } as unknown as ApiClient;
  await assert.rejects(waitForIndexedRepo('owner/repo', client), /last status=failed.*files=2\/8.*indexing failed/);
});

test('test cancellation stops an in-flight polling request', async () => {
  const controller = new AbortController();
  let requests = 0;
  const client = {
    get: async (_path: string, request: { signal: AbortSignal }) => {
      requests++;
      return new Promise((_resolve, reject) => {
        request.signal.addEventListener('abort', () => reject(new Error('request cancelled')), { once: true });
        controller.abort();
      });
    },
  } as unknown as ApiClient;
  await assert.rejects(waitForIndexedRepo('owner/repo', client, { signal: controller.signal }), /request cancelled/);
  assert.equal(requests, 1);
});

test('already queued indexing is polled without another trigger', async () => {
  let triggers = 0;
  const client = {
    post: async () => { triggers++; throw new Error('Indexing job already queued for this repository and branch'); },
    get: async () => ({ data: { repositories: [row('completed')] } }),
  } as unknown as ApiClient;
  await triggerAndWaitForIndexing('owner/repo', false, client, { log: () => {} });
  assert.equal(triggers, 1);
});

test('unsuccessful trigger responses fail without polling', async () => {
  const client = {
    post: async () => ({ data: { success: false, error: 'Summarization disabled' } }),
    get: async () => { assert.fail('must not poll after a rejected trigger'); },
  } as unknown as ApiClient;
  await assert.rejects(triggerAndWaitForIndexing('owner/repo', false, client), /Summarization disabled/);
});

test('expired indexing budget never submits another job', async () => {
  const client = { post: async () => { assert.fail('deadline passed'); } } as unknown as ApiClient;
  await assert.rejects(triggerAndWaitForIndexing('owner/repo', false, client, {
    deadline: 100, now: () => 100,
  }), /deadline passed before triggering/);
});

test('missing status and incomplete metadata cannot pass as completed', async () => {
  let now = 0;
  let calls = 0;
  const client = {
    get: async () => ({ data: { repositories: ++calls === 1 ? [] : [{ ...row('completed'), last_indexed_hash: null }] } }),
  } as unknown as ApiClient;
  await assert.rejects(waitForIndexedRepo('owner/repo', client, {
    now: () => now, deadline: 10_000, sleep: async ms => { now += ms; },
  }), /last status=completed.*timed out/);
  assert.equal(calls, 2);
});
