import assert from 'node:assert/strict';
import { beforeEach, mock, test } from 'node:test';

let status = 'completed';
let writes: string[] = [];
let workerStatus = 'completed';
let enqueueError: Error | undefined;
let statusError: Error | undefined;

mock.module('@propr/core', {
  namedExports: {
    loadSummarizationSettings: async () => ({ enabled: true, agent_alias: 'test' }),
    normalizeSummarizationBranch: (branch?: string) => branch || 'HEAD',
    getSummarizationCooldown: async () => null,
    getIndexingQueue: async () => ({
      getJobs: async () => [],
      add: async () => {
        assert.equal(status, 'indexing', 'queued work must already be marked indexing');
        if (enqueueError) throw enqueueError;
        // The worker finishes before Redis acknowledges enqueueing to the API.
        status = workerStatus;
        return { id: 'index-test' };
      },
    }),
    generateCorrelationId: () => 'test',
    ensureRepoCloned: async () => '/tmp/index-test',
    getRepoUrl: () => 'https://example.com/owner/repo',
    getAuthenticatedOctokit: async () => ({ auth: async () => ({ token: 'fixture' }) }),
    fetchLatestChanges: async () => ({ success: true }),
    updateRepositoryStatus: async (_repo: string, next: string, branch: string) => {
      assert.equal(branch, 'release');
      if (statusError) throw statusError;
      writes.push(next);
      status = next;
    },
    requestIndexingCancellation: async () => {},
    db: () => { throw new Error('Unexpected database call for incremental reindex'); },
  },
});

const { queueIndexingJob } = await import('../packages/api/routes/indexingQueueHelpers.js');

beforeEach(() => {
  status = 'completed';
  writes = [];
  workerStatus = 'completed';
  enqueueError = undefined;
  statusError = undefined;
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

test('enqueue failure does not leave the repository stuck indexing', async () => {
  enqueueError = new Error('Redis unavailable');
  await assert.rejects(queueIndexingJob('owner/repo', false, 'release'), enqueueError);
  assert.equal(status, 'failed');
  assert.deepEqual(writes, ['indexing', 'failed']);
});

test('status persistence failure prevents enqueueing', async () => {
  statusError = new Error('Database unavailable');
  await assert.rejects(queueIndexingJob('owner/repo', false, 'release'), statusError);
  assert.equal(status, 'completed');
});
