/* eslint-disable max-lines -- planner background success, failure, abort, and CAS races share one database fixture */
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, mock, test } from 'node:test';
import knex from 'knex';

process.env.NODE_ENV = 'test';
process.env.PROPR_DEMO_MODE = 'true';

const {
  buildPlannerAbortSignalKey,
  checkAbortSignal,
  clearWorkerAbortSignal,
  plannerAbortSignalKeyForTask,
  runWithPlannerAbortContext,
  shouldTerminateAfterAbortLookupFailure,
} = await import('../../core/src/claude/docker/dockerExecutor.js');
const { closeConnection } = await import('@propr/core');
const { persistGenerationCompletion } = await import('../../core/src/services/taskPlanningService.js');
const { runBackgroundGeneration } = await import('../routes/plannerHelpers/utils.js');
const { createRefineHandler } = await import('../routes/plannerHelpers/handlers/generationHandlers.js');
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
    table.string('repository').defaultTo('unconfigured');
    table.string('status').notNullable();
    table.text('generation_trace');
    table.text('refinement_result');
    table.text('generated_context');
    table.text('plan_json');
    table.text('plan_cause');
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
  test('uses the parent planner run marker for nested execution task IDs', async () => {
    const key = await runWithPlannerAbortContext('draft-parent', 'generation-run-1', async () => (
      plannerAbortSignalKeyForTask('nested-analysis-task')
    ));
    assert.equal(key, buildPlannerAbortSignalKey('draft-parent', 'generation-run-1'));
  });

  test('tolerates one transient planner abort lookup failure but fails closed on sustained unavailability', () => {
    const plannerKey = buildPlannerAbortSignalKey('draft-1', 'generation-run-1');
    assert.equal(shouldTerminateAfterAbortLookupFailure(plannerKey, 1), false);
    assert.equal(shouldTerminateAfterAbortLookupFailure(plannerKey, 2), true);
    assert.equal(shouldTerminateAfterAbortLookupFailure('planner:abort:draft-1', 10), false);
  });

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

  test('publishes a classified planner failure without raw paths or credentials', async t => {
    t.mock.method(console, 'error', () => undefined);
    const draftId = 'generation-sensitive-failure';
    const runId = 'generation-run-sensitive';
    await database('task_drafts').insert({
      draft_id: draftId,
      status: 'generating',
      generation_trace: JSON.stringify({ steps: [{ name: 'llm', status: 'in_progress' }], runId }),
    });
    const publishDraftUpdate = mock.fn(async (payload: { generationTrace: unknown }) => typeof payload === 'object');
    const rawError = 'provider failed at /srv/private/repo: https://user:secret@example.test/api?token=secret';

    await runBackgroundGeneration({
      db: database,
      draftId,
      worktreePath: '/tmp/worktree',
      authToken: 'token',
      correlationId: runId,
      runId,
    }, {
      generate: async () => { throw new Error(rawError); },
      getPublisher: () => ({ publishDraftUpdate }) as never,
    });

    const current = await database('task_drafts').where({ draft_id: draftId }).first();
    const failure = JSON.parse(current.generation_trace);
    const publishedTrace = publishDraftUpdate.mock.calls[0].arguments[0].generationTrace;
    assert.equal(failure.error, 'Plan generation failed. Detailed diagnostics are available in server logs.');
    assert.equal(JSON.stringify(failure).includes(rawError), false);
    assert.equal(JSON.stringify(publishedTrace).includes(rawError), false);
  });

  test('retries a failure CAS miss while the same generation run remains active', async t => {
    t.mock.method(console, 'error', () => undefined);
    t.mock.method(console, 'log', () => undefined);
    const draftId = 'generation-failure-cas-race';
    const runId = 'generation-run-cas';
    const initialTrace = JSON.stringify({
      steps: [{ name: 'context', status: 'in_progress' }],
      runId,
    });
    const racedTrace = JSON.stringify({
      steps: [{ name: 'context', status: 'completed' }, { name: 'llm', status: 'in_progress' }],
      runId,
    });
    await database('task_drafts').insert({
      draft_id: draftId,
      status: 'generating',
      generation_trace: initialTrace,
    });
    await database.raw(`
      CREATE TRIGGER generation_failure_cas_race
      BEFORE UPDATE OF status ON task_drafts
      WHEN OLD.draft_id = '${draftId}'
        AND NEW.status = 'failed'
        AND OLD.generation_trace = '${initialTrace}'
      BEGIN
        UPDATE task_drafts SET generation_trace = '${racedTrace}' WHERE draft_id = OLD.draft_id;
        SELECT RAISE(IGNORE);
      END
    `);
    const publishDraftUpdate = mock.fn(async (payload: { runId?: string }) => typeof payload === 'object');

    try {
      await runBackgroundGeneration({
        db: database,
        draftId,
        worktreePath: '/tmp/worktree',
        authToken: 'token',
        correlationId: runId,
        runId,
      }, {
        generate: async () => { throw new Error('generation failed'); },
        getPublisher: () => ({ publishDraftUpdate }) as never,
      });
    } finally {
      await database.raw('DROP TRIGGER IF EXISTS generation_failure_cas_race');
    }

    const current = await database('task_drafts').where({ draft_id: draftId }).first();
    const failure = JSON.parse(current.generation_trace);
    assert.equal(current.status, 'failed');
    assert.equal(failure.runId, runId);
    assert.deepEqual(failure.steps.map((step: { status: string }) => step.status), ['completed', 'failed']);
    assert.equal(publishDraftUpdate.mock.callCount(), 1);
    assert.equal(publishDraftUpdate.mock.calls[0].arguments[0].runId, runId);
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

  test('keeps the prior plan byte-identical when refinement output validation fails', async t => {
    t.mock.method(console, 'error', () => undefined);
    const draftId = 'refinement-invalid-output';
    const runId = 'refinement-run-invalid-output';
    const originalPlan = '[ { "title": "Keep me", "body": "Complete body", "implementation": "Complete implementation" } ]';
    await database('task_drafts').insert({
      draft_id: draftId,
      status: 'refining',
      plan_json: originalPlan,
      refinement_result: JSON.stringify({ status: 'in_progress', runId }),
      generated_context: 'context',
    });

    await runBackgroundRefinement({
      db: database,
      draftId,
      currentPlan: JSON.parse(originalPlan),
      instruction: 'change it',
      generationModel: 'test-model',
      correlationId: runId,
      accessToken: 'token',
      runId,
    }, {
      checkAborted: async () => false,
      getRepoContext: async () => ({ worktreePath: '/tmp/worktree', repository: 'owner/repo', authToken: 'token' }),
      refine: async () => ({
        action: 'modified',
        summary: 'Returned a partial task',
        model: 'test-model',
        plan: [{ title: 'Unsafe replacement', body: 'No implementation' }],
      }) as never,
    });

    const current = await database('task_drafts').where({ draft_id: draftId }).first();
    const failure = JSON.parse(current.refinement_result);
    assert.equal(current.status, 'review');
    assert.equal(current.plan_json, originalPlan);
    assert.equal(failure.status, 'failed');
    assert.equal(failure.code, 'REFINEMENT_OUTPUT_INVALID');
    assert.deepEqual(failure.details, {
      reason: 'incomplete_tasks',
      incomplete: [{ index: 0, missing: ['implementation'] }],
    });
  });

  test('persists merged edit output with an explicit merge summary', async t => {
    t.mock.method(console, 'log', () => undefined);
    t.mock.method(console, 'error', () => undefined);
    const draftId = 'refinement-merged-output';
    const runId = 'refinement-run-merged-output';
    const currentPlan = [
      { title: 'First', body: 'First body', implementation: 'First implementation' },
      { title: 'Second', body: 'Second body', implementation: 'Second implementation' },
    ];
    await database('task_drafts').insert({
      draft_id: draftId,
      status: 'refining',
      plan_json: JSON.stringify(currentPlan),
      plan_cause: 'generation',
      refinement_result: JSON.stringify({ status: 'in_progress', runId }),
    });

    await runBackgroundRefinement({
      db: database,
      draftId,
      currentPlan,
      instruction: 'extend and add',
      generationModel: 'test-model',
      correlationId: runId,
      accessToken: 'token',
      runId,
    }, {
      checkAborted: async () => false,
      getRepoContext: async () => ({ worktreePath: '/tmp/worktree', repository: 'owner/repo', authToken: 'token' }),
      refine: async () => ({
        action: 'modified', summary: 'Updated the requested work.', model: 'test-model',
        plan: [
          { action: 'extend', index: 1, body: 'More' },
          { action: 'add', title: 'Third', body: 'Third body', implementation: 'Third implementation' },
        ],
      }) as never,
    });

    const current = await database('task_drafts').where({ draft_id: draftId }).first();
    const plan = JSON.parse(current.plan_json);
    const metadata = JSON.parse(current.refinement_result);
    assert.deepEqual(plan.map((task: { title: string }) => task.title), ['First', 'Second', 'Third']);
    assert.equal(plan[1].body, 'Second body\n\nMore');
    assert.equal(metadata.merged, true);
    assert.match(metadata.summary, /^Applied 2 edits to the existing plan\./);
    assert.equal(current.plan_cause, 'refinement', 'a saved refined plan records refinement provenance');
  });

  test('saves a result that core already normalised without merging or prefixing it again', async t => {
    t.mock.method(console, 'log', () => undefined);
    const draftId = 'refinement-core-normalised';
    const runId = 'refinement-run-core-normalised';
    const currentPlan = [{ title: 'First', body: 'First body', implementation: 'First implementation' }];
    // An edit-shaped task title proves the handler does not normalise again.
    const refinedPlan = [
      { title: 'First', body: 'First body\n\nMore', implementation: 'First implementation' },
      { title: 'action', body: 'Second body', implementation: 'Second implementation' },
    ];
    await database('task_drafts').insert({
      draft_id: draftId, status: 'refining', plan_json: JSON.stringify(currentPlan), plan_cause: 'generation',
      refinement_result: JSON.stringify({ status: 'in_progress', runId }),
    });

    await runBackgroundRefinement({ db: database, draftId, currentPlan, instruction: 'extend and add',
      generationModel: 'test-model', correlationId: runId, accessToken: 'token', runId }, {
      checkAborted: async () => false,
      getRepoContext: async () => ({ worktreePath: '/tmp/worktree', repository: 'owner/repo', authToken: 'token' }),
      refine: async () => ({ action: 'modified', summary: 'Applied 2 edits to the existing plan. Extended the work.',
        model: 'test-model', plan: refinedPlan, merged: true, operations: 2 }) as never,
    });

    const current = await database('task_drafts').where({ draft_id: draftId }).first();
    const metadata = JSON.parse(current.refinement_result);
    assert.deepEqual(JSON.parse(current.plan_json), refinedPlan);
    assert.equal(metadata.merged, true);
    assert.equal(metadata.summary, 'Applied 2 edits to the existing plan. Extended the work.');
    assert.equal(current.plan_cause, 'refinement');
  });

  test('keeps the existing provenance when a modified result equals the stored plan', async t => {
    t.mock.method(console, 'log', () => undefined);
    const draftId = 'refinement-identical-output';
    const runId = 'refinement-run-identical-output';
    const currentPlan = [{ title: 'Keep me', body: 'Complete body', implementation: 'Complete implementation' }];
    await database('task_drafts').insert({
      draft_id: draftId, status: 'refining', plan_json: JSON.stringify(currentPlan), plan_cause: 'restore',
      refinement_result: JSON.stringify({ status: 'in_progress', runId }),
    });

    await runBackgroundRefinement({ db: database, draftId, currentPlan, instruction: 'Tidy up',
      generationModel: 'test-model', correlationId: runId, accessToken: 'token', runId }, {
      checkAborted: async () => false,
      getRepoContext: async () => ({ worktreePath: '/tmp/worktree', repository: 'owner/repo', authToken: 'token' }),
      refine: async () => ({ action: 'modified', summary: 'Nothing needed changing.', model: 'test-model',
        plan: currentPlan }) as never,
    });

    const current = await database('task_drafts').where({ draft_id: draftId }).first();
    assert.equal(JSON.parse(current.refinement_result).status, 'completed');
    assert.equal(current.plan_json, JSON.stringify(currentPlan));
    assert.equal(current.plan_cause, 'restore');
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
    assert.equal((await database('task_drafts').where({ draft_id: draftId }).first()).plan_cause, 'generation');

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


for (const action of ['answered', 'clarify'] as const) {
  test(`${action} in background preserves incomplete current tasks`, async () => {
    const draftId = `incomplete-${action}`;
    const runId = `run-${action}`;
    const currentPlan = [{ title: 'Add metrics', body: 'Emit counters' }];
    await database('task_drafts').insert({ draft_id: draftId, status: 'refining', plan_cause: 'generation',
      plan_json: JSON.stringify(currentPlan), refinement_result: JSON.stringify({ status: 'in_progress', runId }) });
    await runBackgroundRefinement({ db: database, draftId, currentPlan, instruction: 'How?',
      generationModel: 'test-model', correlationId: runId, accessToken: 'token', runId }, {
      checkAborted: async () => false,
      getRepoContext: async () => ({ worktreePath: '/tmp/worktree', repository: 'owner/repo', authToken: 'token' }),
      refine: async () => ({ action, summary: 'Use a counter.', model: 'test-model',
        plan: [{ title: 'Unrequested', body: 'Change', implementation: 'Steps' }] }) as never,
      getPublisher: () => ({ publishDraftUpdate: async () => undefined }) as never,
    });
    const current = await database('task_drafts').where({ draft_id: draftId }).first();
    assert.equal(current.status, 'review');
    assert.deepEqual(JSON.parse(current.plan_json), currentPlan);
    const meta = JSON.parse(current.refinement_result);
    assert.equal(meta.status, 'completed');
    assert.equal(meta.action, action);
    assert.equal(current.plan_cause, 'generation', 'a preserved plan keeps the cause that created it');
  });

  test(`${action} in background keeps provenance when the caller's copy of the plan is saved`, async t => {
    t.mock.method(console, 'log', () => undefined);
    const draftId = `client-copy-${action}`;
    const runId = `run-client-copy-${action}`;
    const storedPlan = [{ title: 'Add metrics', body: 'Emit counters', implementation: 'Use the registry' }];
    // The editor sends its in-memory copy, which carries client-side task ids.
    const currentPlan = storedPlan.map((task, index) => ({ ...task, id: `task-${index}` }));
    await database('task_drafts').insert({ draft_id: draftId, status: 'refining', plan_cause: 'generation',
      plan_json: JSON.stringify(storedPlan), refinement_result: JSON.stringify({ status: 'in_progress', runId }) });
    await runBackgroundRefinement({ db: database, draftId, currentPlan: currentPlan as never, instruction: 'How?',
      generationModel: 'test-model', correlationId: runId, accessToken: 'token', runId }, {
      checkAborted: async () => false,
      getRepoContext: async () => ({ worktreePath: '/tmp/worktree', repository: 'owner/repo', authToken: 'token' }),
      refine: async () => ({ action, summary: 'Use a counter.', model: 'test-model', plan: currentPlan }) as never,
    });
    const current = await database('task_drafts').where({ draft_id: draftId }).first();
    assert.deepEqual(JSON.parse(current.plan_json), currentPlan);
    assert.equal(JSON.parse(current.refinement_result).action, action);
    assert.equal(current.plan_cause, 'generation');
  });
}


for (const action of ['answered', 'clarify'] as const) {
  test(`${action} in the legacy handler preserves incomplete current tasks`, async () => {
    const draftId = `legacy-${action}`;
    const currentPlan = [{ title: 'Add metrics', body: 'Emit counters' }];
    await database('task_drafts').insert({ draft_id: draftId, status: 'review', plan_cause: 'generation',
      plan_json: JSON.stringify(currentPlan) });
    const handler = createRefineHandler({ db: database, verifyOwnership: async () => ({ authorized: true }),
      refinePlan: async () => ({ action, summary: 'Use a counter.', plan: [{ title: 'Unrequested change' }] }) });
    let resolve!: () => void;
    const saved = new Promise<void>(done => { resolve = done; });
    const onQuery = (_response: unknown, query: { sql: string; bindings: unknown[] }) => {
      if (query.sql.startsWith('update `task_drafts`') && query.bindings.includes('review')) resolve();
    };
    database.on('query-response', onQuery);
    try {
      const response = { status: () => response, json: () => response };
      await handler({ body: { draftId, plan: currentPlan, instruction: 'How?' }, user: { id: 'user' } } as never, response as never);
      await saved;
    } finally { database.off('query-response', onQuery); }
    const current = await database('task_drafts').where({ draft_id: draftId }).first();
    assert.deepEqual(JSON.parse(current.plan_json), currentPlan);
    assert.equal(JSON.parse(current.refinement_result).action, action);
    assert.equal(JSON.parse(current.refinement_result).error, undefined);
    assert.equal(current.plan_cause, 'generation', 'a preserved plan keeps the cause that created it');
  });
}

test('modified in the legacy handler records refinement provenance for the saved plan', async t => {
  t.mock.method(console, 'log', () => undefined);
  const draftId = 'legacy-modified';
  const currentPlan = [{ title: 'Add metrics', body: 'Emit counters', implementation: 'Use the registry' }];
  const refinedPlan = [{ title: 'Add metrics', body: 'Emit counters and gauges', implementation: 'Use the registry' }];
  await database('task_drafts').insert({ draft_id: draftId, status: 'review', plan_cause: 'generation',
    plan_json: JSON.stringify(currentPlan) });
  const handler = createRefineHandler({ db: database, verifyOwnership: async () => ({ authorized: true }),
    refinePlan: async () => ({ action: 'modified', summary: 'Added gauges.', plan: refinedPlan }) });
  let resolve!: () => void;
  const saved = new Promise<void>(done => { resolve = done; });
  const onQuery = (_response: unknown, query: { sql: string; bindings: unknown[] }) => {
    if (query.sql.startsWith('update `task_drafts`') && query.bindings.includes('review')) resolve();
  };
  database.on('query-response', onQuery);
  try {
    const response = { status: () => response, json: () => response };
    await handler({ body: { draftId, plan: currentPlan, instruction: 'Add gauges' }, user: { id: 'user' } } as never, response as never);
    await saved;
  } finally { database.off('query-response', onQuery); }
  const current = await database('task_drafts').where({ draft_id: draftId }).first();
  assert.deepEqual(JSON.parse(current.plan_json), refinedPlan);
  assert.equal(JSON.parse(current.refinement_result).action, 'modified');
  assert.equal(current.plan_cause, 'refinement');
});
