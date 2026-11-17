import assert from 'node:assert/strict';
import { after, beforeEach, describe, mock, test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * GET /api/planner/drafts/:id/issues against a migrated SQLite database and the real epic queue:
 * every issue carries its execution state and edges exactly as GET …/execution-queue reports them,
 * and invalid paging is refused. Only Redis and the BullMQ queue are in memory.
 */

const root = await mkdtemp(path.join(tmpdir(), 'plan-issues-list-'));
process.env.DATA_DIR = root;
process.env.DB_FILENAME = path.join(root, 'core.sqlite');
process.env.NODE_ENV = 'test';

function FakeRedis() {
  return { on: () => {}, get: async () => null, setex: async () => 'OK', set: async () => 'OK', eval: async () => 1,
    llen: async () => 0, keys: async () => [], del: async () => 1, quit: async () => 'OK', disconnect: () => {} };
}
await mock.module('ioredis', { namedExports: { Redis: FakeRedis } });
const fakeQueue = { getJobs: async () => [] };
await mock.module('../packages/core/src/queue/taskQueue.js', { namedExports: {
  GITHUB_ISSUE_QUEUE_NAME: 'test-issues', COMMENT_BATCH_DELAY_MS: 3000, INDEXING_QUEUE_NAME: 'test-indexing',
  getIssueQueue: async () => fakeQueue, getIndexingQueue: async () => fakeQueue, issueQueue: fakeQueue, indexingQueue: fakeQueue,
  createWorker: async () => { throw new Error('not used'); }, shutdownQueue: async () => {},
} });
const publisher = { publishActivity: async () => true, publishTaskUpdate: async () => true, publishDraftUpdate: async () => true };
await mock.module('../packages/core/src/utils/eventPublisher.js', {
  namedExports: { getEventPublisher: () => publisher, closeEventPublisher: async () => {}, publishNotificationUpdateThroughRedis: () => {}, EventPublisher: class {} },
});

const { db, runMigrations, closeConnection } = await import('../packages/core/src/db/connection.js');
const { createEpicExecutionQueue, getEpicExecutionQueue, summarizeEpicQueue } = await import('../packages/core/src/services/taskPlanning/epicExecutionQueue.js');
await mock.module('@propr/core', { namedExports: { ...await import('../packages/core/src/index.ts') } });
const { createGetIssuesHandler } = await import('../packages/api/routes/planIssueListHandler.ts');

await runMigrations();
after(async () => {
  await closeConnection();
  await rm(root, { recursive: true, force: true });
});

const REPOSITORY = 'acme/repo';
const DRAFT = 'draft-issues-list';
const ISSUES = [3557, 3558, 3559, 3560];

beforeEach(async () => {
  await db('epic_execution_queue_issues').delete();
  await db('epic_execution_queues').delete();
  await db('plan_issues').delete();
  await db('task_drafts').delete();
  await db('task_drafts').insert({ draft_id: DRAFT, user_id: 'user-1', repository: REPOSITORY, initial_prompt: 'Plan', status: 'pr_created' });
  for (const issueNumber of ISSUES) {
    await db('plan_issues').insert({ draft_id: DRAFT, repository: REPOSITORY, issue_number: issueNumber, status: 'pending' });
  }
});

async function getIssues(query: Record<string, string>) {
  const handler = createGetIssuesHandler({ verifyOwnership: async () => ({ authorized: true }) } as never);
  const res = {
    statusCode: 200, body: undefined as unknown,
    status(code: number) { this.statusCode = code; return this; },
    json(payload: unknown) { this.body = payload; return this; },
  };
  await handler({ params: { id: DRAFT }, query, user: { id: 'user-1' } } as never, res as never);
  return res;
}

type Listed = { issue_number: number; status: string; execution: Record<string, unknown> | null };

describe('plan issues endpoint', () => {
  test('each issue carries the execution queue state, edges and waits, with and without paging', async () => {
    const created = await createEpicExecutionQueue({ draftId: DRAFT, repository: REPOSITORY, issues: ISSUES, headStartedAt: Date.now() });
    await db('epic_execution_queue_issues').where({ draft_id: DRAFT, issue_number: 3559 }).update({ state: 'skipped' });
    const queue = summarizeEpicQueue(await getEpicExecutionQueue(DRAFT))!;
    assert.deepEqual(queue.issueStates.map(state => [state.issue, state.schedule, state.waitingOn]),
      [[3557, 'in_flight', []], [3558, 'waiting', [3557]], [3559, 'skipped', []], [3560, 'waiting', [3558]]]);

    const bare = await getIssues({});
    assert.equal(bare.statusCode, 200);
    assert.ok(Array.isArray(bare.body), 'without paging parameters the response stays a bare array');
    const paged = await getIssues({ page: '0', limit: '10' });
    const page = paged.body as { issues: Listed[]; total: number; hasMore: boolean };
    assert.deepEqual([page.total, page.hasMore], [4, false]);
    for (const issues of [bare.body as Listed[], page.issues]) {
      const byNumber = new Map(issues.map(issue => [issue.issue_number, issue]));
      for (const { issue, ...state } of queue.issueStates) {
        assert.deepEqual(byNumber.get(issue)!.execution,
          { ...state, executionId: created.executionId, executionMode: 'sequential', queueStatus: 'active' });
      }
      assert.equal(byNumber.get(3559)!.status, 'pending', 'the plan status is unchanged; the skip is in execution.state');
      assert.equal(byNumber.get(3559)!.execution!.state, 'skipped');
      assert.deepEqual(byNumber.get(3560)!.execution!.dependsOn, [3559]);
    }
  });

  test('issues outside any execution report execution null', async () => {
    const issues = (await getIssues({})).body as Listed[];
    assert.deepEqual(issues.map(issue => issue.execution), [null, null, null, null]);
  });

  test('invalid page or limit is refused with 400', async () => {
    for (const query of [{ page: '-1' }, { limit: '0' }, { limit: '-5' }, { page: 'abc' }, { page: '1.5' }, { limit: '1e2' }, { page: '' }]) {
      const res = await getIssues(query);
      assert.equal(res.statusCode, 400, JSON.stringify(query));
    }
    const capped = (await getIssues({ limit: '500' })).body as { limit: number; page: number };
    assert.deepEqual([capped.page, capped.limit], [0, 100]);
  });
});
