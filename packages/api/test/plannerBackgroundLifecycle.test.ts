import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import knex from 'knex';

process.env.NODE_ENV = 'test';
process.env.PROPR_DEMO_MODE = 'true';

const {
  buildPlannerAbortSignalKey,
  checkAbortSignal,
  clearWorkerAbortSignal,
} = await import('../../core/src/claude/docker/dockerExecutor.js');
const { closeConnection } = await import('@propr/core');
const { persistGenerationCompletion } = await import('../../core/src/services/taskPlanningService.js');
const { runBackgroundGeneration } = await import('../routes/plannerHelpers/utils.js');
const { runBackgroundRefinement } = await import('../routes/plannerHelpers/refineBackground.js');
type AbortRedisFactory = import('../../core/src/claude/docker/dockerExecutor.js').AbortRedisFactory;

const database = knex({
  client: 'better-sqlite3',
  connection: { filename: ':memory:' },
  useNullAsDefault: true,
});

before(async () => {
  await database.schema.createTable('task_drafts', table => {
    table.string('draft_id').primary();
    table.string('status').notNullable();
    table.text('generation_trace');
    table.text('refinement_result');
    table.text('generated_context');
    table.text('plan_json');
    table.timestamp('updated_at');
  });
});

beforeEach(async () => {
  await database('task_drafts').delete();
});

after(async () => {
  await database.destroy();
  await closeConnection();
});

describe('planner background abort reconciliation', () => {
  test('keeps the planner marker through Docker detection and background error handling', async t => {
    t.mock.method(console, 'error', () => undefined);
    const draftId = 'refinement-abort-race';
    const runId = 'refinement-run-1';
    const workerKey = `worker:abort:${draftId}`;
    const plannerKey = buildPlannerAbortSignalKey(draftId, runId);
    const keys = new Map<string, string>();
    const deletedKeys: string[] = [];
    const redisFactory: AbortRedisFactory = () => ({
      get: async key => keys.get(key) ?? null,
      del: async key => { deletedKeys.push(key); return keys.delete(key) ? 1 : 0; },
      quit: async () => undefined,
      disconnect: () => undefined,
    });
    await database('task_drafts').insert({
      draft_id: draftId,
      status: 'refining',
      refinement_result: JSON.stringify({ status: 'in_progress', runId }),
      generated_context: 'context',
    });

    let refinementStarted!: () => void;
    const started = new Promise<void>(resolve => { refinementStarted = resolve; });
    let rejectRefinement!: (error: Error) => void;
    const refinement = runBackgroundRefinement({
      db: database,
      draftId,
      currentPlan: [],
      instruction: 'change it',
      generationModel: 'test-model',
      correlationId: runId,
      accessToken: 'token',
      runId,
    }, {
      checkAborted: async () => keys.has(plannerKey),
      getRepoContext: async () => ({ worktreePath: '/tmp/worktree', repository: 'owner/repo', authToken: 'token' }),
      refine: async () => {
        refinementStarted();
        return new Promise((_, reject) => { rejectRefinement = reject; });
      },
    });
    await started;

    keys.set(workerKey, '1');
    keys.set(plannerKey, '1');
    await database('task_drafts').where({ draft_id: draftId }).update({
      status: 'review',
      refinement_result: JSON.stringify({ action: 'cancelled', summary: 'Cancelled by user' }),
    });
    assert.equal(await checkAbortSignal(draftId, plannerKey, redisFactory), true);
    await clearWorkerAbortSignal(draftId, redisFactory);
    rejectRefinement(new Error('container stopped'));
    await refinement;

    const current = await database('task_drafts').where({ draft_id: draftId }).first();
    assert.deepEqual(deletedKeys, [workerKey]);
    assert.equal(keys.has(workerKey), false);
    assert.equal(keys.has(plannerKey), true);
    assert.equal(current.status, 'review');
    assert.deepEqual(JSON.parse(current.refinement_result), {
      action: 'cancelled',
      summary: 'Cancelled by user',
    });
  });

  test('does not let an obsolete generation failure overwrite cancellation', async t => {
    t.mock.method(console, 'error', () => undefined);
    const draftId = 'generation-abort-race';
    const runId = 'generation-run-1';
    await database('task_drafts').insert({
      draft_id: draftId,
      status: 'generating',
      generation_trace: JSON.stringify({ steps: [], runId }),
    });
    let generationStarted!: () => void;
    const started = new Promise<void>(resolve => { generationStarted = resolve; });
    let rejectGeneration!: (error: Error) => void;
    const generation = runBackgroundGeneration({
      db: database,
      draftId,
      worktreePath: '/tmp/worktree',
      authToken: 'token',
      correlationId: runId,
      runId,
    }, {
      generate: async options => {
        assert.equal(options.runId, runId);
        generationStarted();
        return new Promise((_, reject) => { rejectGeneration = reject; });
      },
      getPublisher: () => { throw new Error('stale run must not publish'); },
    });
    await started;

    const cancellationTrace = JSON.stringify({ steps: [], error: 'Generation aborted by user' });
    await database('task_drafts').where({ draft_id: draftId }).update({
      status: 'draft',
      generation_trace: cancellationTrace,
    });
    rejectGeneration(new Error('container stopped'));
    await generation;

    const current = await database('task_drafts').where({ draft_id: draftId }).first();
    assert.equal(current.status, 'draft');
    assert.equal(current.generation_trace, cancellationTrace);
  });

  test('recovers the active refinement when abort lookup is unavailable', async t => {
    t.mock.method(console, 'error', () => undefined);
    const draftId = 'refinement-abort-lookup-failure';
    const runId = 'refinement-run-redis-failure';
    await database('task_drafts').insert({
      draft_id: draftId,
      status: 'refining',
      refinement_result: JSON.stringify({ status: 'in_progress', runId }),
      generated_context: 'context',
    });

    let abortChecks = 0;
    let refineCalls = 0;
    await runBackgroundRefinement({
      db: database,
      draftId,
      currentPlan: [],
      instruction: 'change it',
      generationModel: 'test-model',
      correlationId: runId,
      accessToken: 'token',
      runId,
    }, {
      checkAborted: async () => {
        abortChecks += 1;
        throw new Error('abort lookup failed');
      },
      getRepoContext: async () => ({ worktreePath: '/tmp/worktree', repository: 'owner/repo', authToken: 'token' }),
      refine: async () => {
        refineCalls += 1;
        throw new Error('refinement should not start');
      },
    });

    const current = await database('task_drafts').where({ draft_id: draftId }).first();
    const failure = JSON.parse(current.refinement_result);
    assert.equal(abortChecks, 2);
    assert.equal(refineCalls, 0);
    assert.equal(current.status, 'review');
    assert.equal(failure.status, 'failed');
    assert.equal(failure.error, 'abort lookup failed');
  });

  test('commits generation completion only for the matching active run snapshot', async () => {
    const draftId = 'generation-completion-race';
    const runId = 'generation-run-1';
    const activeTrace = JSON.stringify({ steps: [{ name: 'llm', status: 'completed' }], runId });
    await database('task_drafts').insert({
      draft_id: draftId,
      status: 'generating',
      generation_trace: activeTrace,
    });

    const activeCompletion = await persistGenerationCompletion({
      database,
      draftId,
      runId,
      expectedTrace: activeTrace,
      updates: { status: 'review', plan_json: JSON.stringify([{ title: 'current plan' }]) },
    });
    assert.equal(activeCompletion, true);

    const replacementTrace = JSON.stringify({ steps: [], runId: 'generation-run-2' });
    await database('task_drafts').where({ draft_id: draftId }).update({
      status: 'generating',
      generation_trace: replacementTrace,
      plan_json: null,
    });
    assert.equal(await persistGenerationCompletion({
      database,
      draftId,
      runId,
      expectedTrace: replacementTrace,
      updates: { status: 'review', plan_json: JSON.stringify([{ title: 'wrong run' }]) },
    }), false);

    await database('task_drafts').where({ draft_id: draftId }).update({
      status: 'draft',
      generation_trace: JSON.stringify({ steps: [], error: 'Generation aborted by user' }),
      plan_json: null,
    });
    const completed = await persistGenerationCompletion({
      database,
      draftId,
      runId,
      expectedTrace: activeTrace,
      updates: { status: 'review', plan_json: JSON.stringify([{ title: 'stale plan' }]) },
    });

    const current = await database('task_drafts').where({ draft_id: draftId }).first();
    assert.equal(completed, false);
    assert.equal(current.status, 'draft');
    assert.equal(current.plan_json, null);
  });

  test('closes abort-check Redis clients on command failures and falls back to disconnect', async () => {
    let quitCalls = 0;
    const failingFactory: AbortRedisFactory = () => ({
      get: async () => { throw new Error('get failed'); },
      del: async () => { throw new Error('del failed'); },
      quit: async () => { quitCalls += 1; },
      disconnect: () => undefined,
    });
    await assert.rejects(
      checkAbortSignal('draft-1', 'planner-key', failingFactory),
      /Abort state unavailable for task draft-1/
    );
    await clearWorkerAbortSignal('draft-1', failingFactory);
    assert.equal(quitCalls, 2);

    let disconnectCalls = 0;
    await checkAbortSignal('draft-1', 'planner-key', () => ({
      get: async () => null,
      del: async () => 0,
      quit: async () => { throw new Error('quit failed'); },
      disconnect: () => { disconnectCalls += 1; },
    }));
    assert.equal(disconnectCalls, 1);
  });
});
