import assert from 'node:assert/strict';
import { beforeEach, mock, test } from 'node:test';

let status: string | undefined = 'completed';
let writes: string[] = [];
let workerStatus = 'completed';
let enqueueError: Error | undefined;
let statusError: Error | undefined;
let statusAfterFetch: string | undefined;
let fetchError: Error | undefined;
let statusBeforeReject: string | undefined;
let payloads: { fullReindex: boolean; baseBranch: string }[] = [];
let expectedBranch = 'release';

const db = Object.assign((table: string) => {
  assert.equal(table, 'repositories');
  return {
    where: (filter: Record<string, string>) => {
      assert.equal(filter.full_name, 'owner/repo');
      assert.equal(filter.branch, expectedBranch);
      return {
        first: async () => status === undefined ? undefined : { indexing_status: status },
        update: async (data: { indexing_status: string; updated_at: unknown }) => {
          assert.equal(filter.indexing_status, 'indexing');
          assert.deepEqual(Object.keys(data).sort(), ['indexing_status', 'updated_at'],
            'rollback must preserve indexing completion metadata');
          if (status !== filter.indexing_status) return 0;
          writes.push(data.indexing_status);
          status = data.indexing_status;
          return 1;
        },
      };
    },
  };
}, { fn: { now: () => 'now' } });

mock.module('@propr/core', {
  namedExports: {
    loadSummarizationSettings: async () => ({ enabled: true, agent_alias: 'test' }),
    normalizeSummarizationBranch: (branch?: string) => branch || 'HEAD',
    getSummarizationCooldown: async () => null,
    getIndexingQueue: async () => ({
      getJobs: async () => [],
      add: async (_name: string, data: { fullReindex: boolean; baseBranch: string }) => {
        payloads.push(data);
        assert.equal(status, 'indexing', 'queued work must already be marked indexing');
        if (enqueueError) {
          if (statusBeforeReject) status = statusBeforeReject;
          throw enqueueError;
        }
        // The worker finishes before Redis acknowledges enqueueing to the API.
        status = workerStatus;
        return { id: 'index-test' };
      },
    }),
    generateCorrelationId: () => 'test',
    ensureRepoCloned: async () => '/tmp/index-test',
    getRepoUrl: () => 'https://example.com/owner/repo',
    getAuthenticatedOctokit: async () => ({ auth: async () => ({ token: 'fixture' }) }),
    fetchLatestChanges: async () => {
      if (fetchError) throw fetchError;
      if (statusAfterFetch) status = statusAfterFetch;
      return { success: true };
    },
    updateRepositoryStatus: async (_repo: string, next: string, branch: string) => {
      assert.equal(branch, expectedBranch);
      if (statusError) throw statusError;
      writes.push(next);
      status = next;
    },
    requestIndexingCancellation: async () => {},
    db,
  },
});

const { queueIndexingJob } = await import('../packages/api/routes/indexingQueueHelpers.js');

beforeEach(() => {
  status = 'completed';
  writes = [];
  workerStatus = 'completed';
  enqueueError = undefined;
  statusError = undefined;
  statusAfterFetch = undefined;
  fetchError = undefined;
  statusBeforeReject = undefined;
  payloads = [];
  expectedBranch = 'release';
});

for (const terminal of ['completed', 'failed']) {
  test(`enqueueing preserves a fast worker's ${terminal} status`, async () => {
    workerStatus = terminal;
    const result = await queueIndexingJob('owner/repo', false, 'release');
    assert.equal(result.success, true);
    assert.equal(result.baseBranch, 'release');
    assert.equal(status, terminal);
    assert.deepEqual(writes, ['indexing']);
  });
}

for (const initialStatus of ['completed', 'idle', 'failed', undefined]) {
  for (const fullReindex of [true, false]) {
    test(`rejected ${fullReindex ? 'full' : 'incremental'} enqueue restores ${initialStatus ?? 'new repository'} status and preserves retry semantics`, async () => {
      status = initialStatus;
      enqueueError = new Error('Redis unavailable');
      await assert.rejects(queueIndexingJob('owner/repo', fullReindex, 'release'), enqueueError);
      assert.equal(status, initialStatus ?? 'idle');
      assert.deepEqual(writes, ['indexing', initialStatus ?? 'idle']);

      enqueueError = undefined;
      const result = await queueIndexingJob('owner/repo', true, 'release');
      assert.equal(result.success, true);
      assert.equal(payloads[0].fullReindex, fullReindex && initialStatus !== 'failed');
      assert.equal(payloads[1].fullReindex, initialStatus !== 'failed',
        'only execution failure should cause a full request to resume');
    });
  }
}

test('rollback and retry use the normalized default branch', async () => {
  expectedBranch = 'HEAD';
  enqueueError = new Error('Redis unavailable');
  await assert.rejects(queueIndexingJob('owner/repo', true), enqueueError);
  assert.equal(status, 'completed');
  enqueueError = undefined;
  const result = await queueIndexingJob('owner/repo', true);
  assert.equal(result.baseBranch, 'HEAD');
  assert.deepEqual(payloads.map(data => [data.baseBranch, data.fullReindex]), [
    ['HEAD', true], ['HEAD', true],
  ]);
});

test('snapshot is taken after repository preparation finishes', async () => {
  status = 'failed';
  statusAfterFetch = 'completed';
  enqueueError = new Error('Redis unavailable');
  await assert.rejects(queueIndexingJob('owner/repo', true, 'release'), enqueueError);
  assert.equal(status, 'completed');
  assert.equal(payloads[0].fullReindex, true);
});

for (const terminal of ['completed', 'failed', 'idle']) {
  test(`enqueue rejection preserves a concurrent worker's ${terminal} status`, async () => {
    enqueueError = new Error('Redis acknowledgement lost');
    statusBeforeReject = terminal;
    await assert.rejects(queueIndexingJob('owner/repo', true, 'release'), enqueueError);
    assert.equal(status, terminal);
    assert.deepEqual(writes, ['indexing']);
  });
}

test('status persistence failure prevents enqueueing', async () => {
  statusError = new Error('Database unavailable');
  await assert.rejects(queueIndexingJob('owner/repo', false, 'release'), statusError);
  assert.equal(status, 'completed');
});


for (const name of ['RepositoryRepairRequiredError', 'RepositoryPreparationBusyError']) {
  test(`${name} from the fetch stops preparation before indexing is queued`, async () => {
    fetchError = Object.assign(new Error(`Preparation stopped: ${name}`), { name });
    const result = await queueIndexingJob('owner/repo', false, 'release');
    assert.deepEqual(result, { success: false, error: fetchError.message });
    assert.deepEqual(writes, []);
    assert.deepEqual(payloads, []);
  });
}
