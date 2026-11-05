import assert from 'node:assert/strict';
import { after, mock, test } from 'node:test';
import type { Request, Response } from 'express';
import knex, { type Knex } from 'knex';
import { AgentRegistry, closeConnection, closeEventPublisher, getEventPublisher } from '@propr/core';
import { up as createGoals } from '../../core/src/db/migrations/20260902000000_create_goals.js';
import { up as hardenGoals } from '../../core/src/db/migrations/20260902010000_harden_native_goals.js';
import { up as addGoalCheckpoints } from '../../core/src/db/migrations/20260903000000_add_direct_goal_checkpoints.js';
import { up as addGoalCheckpointDeclarations } from '../../core/src/db/migrations/20260906000000_add_goal_checkpoint_declarations.js';
import { up as addGoalTitles } from '../../core/src/db/migrations/20260907000000_add_goal_titles.js';
import { up as addGoalAttachments } from '../../core/src/db/migrations/20260908000000_add_goal_attachments.js';
import { up as addGoalInputDisplayBody } from '../../core/src/db/migrations/20260923000000_add_goal_input_display_body.js';
import { up as createGoalBlockers } from '../../core/src/db/migrations/20261003050000_create_goal_blockers.js';
import { up as addContinueRequested, down as dropContinueRequested } from '../../core/src/db/migrations/20261024120000_add_goal_continue_requested.js';
import { createGoalRoutes } from '../routes/goalRoutes.js';
import { createToolCatalog } from '../mcp/tools.js';
import { withLiveOutputReads } from './liveOutputRedisFake.js';

after(async () => {
    await closeConnection();
    await closeEventPublisher();
});

function keyedRequest(userId: string, goalId: string, key: string | undefined, body: unknown = {}): Request {
    return {
        user: { id: userId, username: userId }, params: { goalId }, body, method: 'POST',
        get: (header: string) => header.toLowerCase() === 'idempotency-key' ? key : undefined,
    } as unknown as Request;
}

function response() {
    const state: { status: number; body?: unknown } = { status: 200 };
    const res = {
        headersSent: false,
        status(code: number) { state.status = code; return this; },
        json(body: unknown) { state.body = body; return this; },
        send(body?: unknown) { state.body = body; return this; },
    } as unknown as Response;
    return { res, state };
}

const terminalGoal = {
    owner_id: 'owner-1', owner_login: 'alice', repository: 'acme/repo', title: 'Ship it', objective: 'Ship it',
    launch_strategy: 'direct', initial_prompt: '/goal Ship it', agent_id: 'codex-agent', agent_alias: 'codex',
    agent_type: 'codex', requested_model: 'gpt-5.6', desired_state: 'running', result_state: 'failed',
    failure_reason: 'Codex expected active turn id `a` but found `b` (-32600)',
    run_generation: 3, run_claim: 'claim-3', session_id: 'thread-1', conversation_id: 'thread-1',
    branch_name: 'goal/ship-it', worktree_path: '/worktrees/goal-1', claimed_at: '2026-10-24 12:09:11',
    started_at: '2026-10-24 12:09:11', completed_at: '2026-10-24 12:19:35', task_reconciled_at: '2026-10-24 12:19:35',
    final_pr_number: 379, final_pr_url: 'https://github.com/acme/repo/pull/379',
    artifact_stats: JSON.stringify({ issues: 0, openIssues: 0, pullRequests: 1, openPullRequests: 1 }),
    artifacts_checked_at: '2000-01-01T00:00:00.000Z',
};

async function fixture(beforeAttachments?: () => Promise<void>) {
    const database = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
    for (const migrate of [createGoals, hardenGoals, addGoalCheckpoints, addGoalCheckpointDeclarations, addGoalTitles,
        addGoalAttachments, addGoalInputDisplayBody, createGoalBlockers, addContinueRequested]) {
        await migrate(database);
    }
    await database.schema.createTable('task_history', table => {
        table.increments('id');
        table.string('task_id');
        table.string('state');
        table.timestamp('timestamp');
    });
    const queued: Array<{ data: Record<string, unknown>; options: { jobId: string } }> = [];
    const deleted: string[] = [];
    let failEnqueue = false;
    const deps: Parameters<typeof createGoalRoutes>[0] = {
        db: database,
        taskQueue: {
            getJobs: async () => [],
            add: async (_name: string, data: Record<string, unknown>, options: { jobId: string }) => {
                if (failEnqueue) throw new Error('queue offline');
                queued.push({ data, options });
            },
        } as never,
        redisClient: withLiveOutputReads({ get: async () => null, del: async (key: string) => { deleted.push(key); return 1; } }) as never,
        stopExecution: async () => ({ success: true, containerStopped: true, removedQueuedJobs: 0 }) as never,
        getCapabilities: async () => [],
        generateTitle: async () => 'Ship it',
        uploadIdentity: async files => files.map(file => ({ name: file.originalname, size: file.size })),
        processAttachments: async (files, goalId) => {
          await beforeAttachments?.();
          return files.map((file, index) => ({
            id: `attachment-${index + 1}`, originalName: file.originalname,
            storedPath: `/tmp/git-processor/goal-attachments/${goalId}/attachment-${index + 1}.png`,
            mimeType: file.mimetype, size: file.size, tokenEstimate: 12, type: 'image' as const,
        }));
        },
        removeTemporaryUploads: async () => undefined,
    };
    const routes = createGoalRoutes(deps);
    return { database, routes, deps, queued, deleted, setEnqueueFailure: (value: boolean) => { failEnqueue = value; } };
}

async function goalRow(database: Knex, goalId = 'goal-1') {
    return database('goals').where({ goal_id: goalId }).first();
}

test('continue reopens a failed goal on its session and queues the next generation once', async () => {
    const publication = mock.method(getEventPublisher(), 'publishGoalUpdate', async () => true);
    const { database, routes, queued, deleted } = await fixture();
    try {
        await database('goals').insert({ ...terminalGoal, goal_id: 'goal-1', current_task_id: 'goal-task-1' });

        const continued = response();
        await routes.continueGoal(keyedRequest('owner-1', 'goal-1', 'continue-1', { message: '  Now add the VIN decoder pages.  ' }), continued.res);

        assert.equal(continued.state.status, 200, JSON.stringify(continued.state.body));
        const row = await goalRow(database);
        assert.equal(row.result_state, null);
        assert.equal(row.failure_reason, null);
        assert.equal(row.completed_at, null);
        assert.equal(row.task_reconciled_at, null);
        assert.equal(row.desired_state, 'running');
        assert.equal(row.run_generation, 4);
        assert.notEqual(row.run_claim, 'claim-3');
        assert.equal(row.claimed_at, null);
        assert.equal(Boolean(row.continue_requested), true);
        assert.equal(row.session_id, 'thread-1', 'the provider session is kept');
        assert.equal(row.branch_name, 'goal/ship-it');
        assert.equal(row.final_pr_number, 379);
        assert(Number(row.paused_ms) > 0, 'time spent stopped does not count as activity');

        const [input] = await database('goal_inputs').where({ goal_id: 'goal-1' });
        assert.equal(input.kind, 'input');
        assert.equal(input.state, 'pending');
        assert.equal(input.display_message, 'Now add the VIN decoder pages.');
        assert.match(input.message, /reopened this goal after the previous run failed: Codex expected active turn id/);
        assert.match(input.message, /The user added these instructions:\nNow add the VIN decoder pages\.$/);

        assert.deepEqual(queued.map(job => job.options.jobId), ['goal-goal-1-4']);
        assert.equal(queued[0].data.generation, 4);
        assert.equal(queued[0].data.claimId, row.run_claim);
        assert.deepEqual(deleted, ['worker:abort:goal-task-1']);

        // A retried request with the same key replays the result instead of continuing twice.
        const replay = response();
        await routes.continueGoal(keyedRequest('owner-1', 'goal-1', 'continue-1', { message: 'Now add the VIN decoder pages.' }), replay.res);
        assert.equal(replay.state.status, 200);
        assert.equal((await goalRow(database)).run_generation, 4);
        assert.equal(queued.length, 1);
        assert.equal((await database('goal_inputs').where({ goal_id: 'goal-1' })).length, 1);

        // The reopened goal is active again, so a new continuation is refused.
        const active = response();
        await routes.continueGoal(keyedRequest('owner-1', 'goal-1', 'continue-2'), active.res);
        assert.equal(active.state.status, 409);
        assert.match(String((active.state.body as { error: string }).error), /still active/);
    } finally {
        publication.mock.restore();
        await database.destroy();
    }
});

test('continue accepts completed and cancelled goals, with or without a message', async () => {
    const publication = mock.method(getEventPublisher(), 'publishGoalUpdate', async () => true);
    const { database, routes, queued } = await fixture();
    try {
        await database('goals').insert([
            { ...terminalGoal, goal_id: 'goal-done', current_task_id: 'task-done', result_state: 'completed', failure_reason: null },
            { ...terminalGoal, goal_id: 'goal-cancelled', current_task_id: 'task-cancelled', result_state: 'cancelled', desired_state: 'cancelled', failure_reason: null },
        ]);
        for (const goalId of ['goal-done', 'goal-cancelled']) {
            const continued = response();
            await routes.continueGoal(keyedRequest('owner-1', goalId, `key-${goalId}`), continued.res);
            assert.equal(continued.state.status, 200, JSON.stringify(continued.state.body));
            const row = await goalRow(database, goalId);
            assert.equal(row.result_state, null);
            assert.equal(row.desired_state, 'running');
            const [input] = await database('goal_inputs').where({ goal_id: goalId });
            // A bare continue is ProPR's own message and stays out of the operator timeline.
            assert.equal(input.kind, 'resume');
            assert.equal(input.display_message, null);
        }
        const messages = await database('goal_inputs').orderBy('sequence').pluck('message');
        assert.match(messages[0], /after it was completed/);
        assert.match(messages[1], /after it was cancelled/);
        assert.equal(queued.length, 2);
    } finally {
        publication.mock.restore();
        await database.destroy();
    }
});

test('continue is owner-scoped, needs an idempotency key and validates the message', async () => {
    const { database, routes, queued } = await fixture();
    try {
        await database('goals').insert({ ...terminalGoal, goal_id: 'goal-1', current_task_id: 'goal-task-1' });

        const foreign = response();
        await routes.continueGoal(keyedRequest('owner-2', 'goal-1', 'key-1'), foreign.res);
        assert.equal(foreign.state.status, 404);

        const unkeyed = response();
        await routes.continueGoal(keyedRequest('owner-1', 'goal-1', undefined), unkeyed.res);
        assert.equal(unkeyed.state.status, 400);

        const invalid = response();
        await routes.continueGoal(keyedRequest('owner-1', 'goal-1', 'key-2', { message: 42 }), invalid.res);
        assert.equal(invalid.state.status, 400);

        assert.equal((await goalRow(database)).result_state, 'failed');
        assert.equal(queued.length, 0);
    } finally {
        await database.destroy();
    }
});

test('a continued goal whose enqueue fails stays durably running for recovery', async () => {
    const publication = mock.method(getEventPublisher(), 'publishGoalUpdate', async () => true);
    const { database, routes, setEnqueueFailure } = await fixture();
    try {
        await database('goals').insert({ ...terminalGoal, goal_id: 'goal-1', current_task_id: 'goal-task-1' });
        setEnqueueFailure(true);
        const continued = response();
        await routes.continueGoal(keyedRequest('owner-1', 'goal-1', 'key-1'), continued.res);
        assert.equal(continued.state.status, 200);
        const row = await goalRow(database);
        assert.equal(row.result_state, null);
        assert.equal(row.claimed_at, null);
        assert.equal(row.desired_state, 'running');
    } finally {
        publication.mock.restore();
        await database.destroy();
    }
});

test('the continue_requested migration adds and drops the column without rebuilding goals', async () => {
    const database = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
    try {
        await createGoals(database);
        await database.raw('CREATE TRIGGER goals_marker AFTER UPDATE ON goals BEGIN SELECT 1; END');
        await addContinueRequested(database);
        await addContinueRequested(database);
        assert.equal(await database.schema.hasColumn('goals', 'continue_requested'), true);
        await dropContinueRequested(database);
        assert.equal(await database.schema.hasColumn('goals', 'continue_requested'), false);
        const triggers = await database('sqlite_master').where({ type: 'trigger', name: 'goals_marker' });
        assert.equal(triggers.length, 1, 'triggers on goals survive');
    } finally {
        await database.destroy();
    }
});

for (const competing of [false, true]) {
  test(`concurrent continuation ${competing ? 'conflicts for distinct payloads' : 'replays identical accepted requests'}`, async () => {
    const publication = mock.method(getEventPublisher(), 'publishGoalUpdate', async () => true);
    let arrivals = 0;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const { database, routes, queued } = await fixture(async () => { if (++arrivals === 2) release(); await gate; });
    try {
      await database('goals').insert({ ...terminalGoal, goal_id: 'goal-1', current_task_id: 'goal-task-1' });
      const responses = [response(), response()];
      await Promise.all(responses.map((result, index) => routes.continueGoal(keyedRequest('owner-1', 'goal-1', 'same-key', { message: competing ? `message-${index}` : 'same message' }), result.res)));
      assert.deepEqual(responses.map(result => result.state.status).sort(), competing ? [200, 409] : [200, 200]);
      assert.equal(queued.length, 1);
      assert.equal((await database('goal_inputs')).length, 1);
      if (!competing) for (const result of responses) assert.equal((result.state.body as { goal: { resultState: unknown } }).goal.resultState, null);
    } finally { publication.mock.restore(); await database.destroy(); }
  });
}

test('continue waits for old task finalization before reopening', async () => {
  const { database, routes, queued } = await fixture();
  try {
    await database('goals').insert({ ...terminalGoal, task_reconciled_at: null, goal_id: 'goal-1', current_task_id: 'goal-task-1' });
    const result = response();
    await routes.continueGoal(keyedRequest('owner-1', 'goal-1', 'key'), result.res);
    assert.equal(result.state.status, 409);
    assert.match((result.state.body as { error: string }).error, /finalizing/);
    assert.equal(queued.length, 0);
    assert.equal((await goalRow(database)).run_generation, 3);
  } finally { await database.destroy(); }
});

test('stopped time uses UTC even on a non-UTC host', async () => {
  const previousTZ = process.env.TZ;
  process.env.TZ = 'America/Los_Angeles';
  const publication = mock.method(getEventPublisher(), 'publishGoalUpdate', async () => true);
  const { database, routes } = await fixture();
  try {
    const now = Date.now();
    const completed = new Date(now - 60_000).toISOString().slice(0, 19).replace('T', ' ');
    await database('goals').insert({ ...terminalGoal, completed_at: completed, paused_ms: 100, goal_id: 'goal-1', current_task_id: 'goal-task-1' });
    await routes.continueGoal(keyedRequest('owner-1', 'goal-1', 'key'), response().res);
    const row = await goalRow(database);
    assert.ok(row.paused_ms >= 60_100 && row.paused_ms < 65_100, String(row.paused_ms));
  } finally { if (previousTZ === undefined) delete process.env.TZ; else process.env.TZ = previousTZ; publication.mock.restore(); await database.destroy(); }
});

test('continue validates and persists a model atomically and includes it in replay identity', async () => {
  const registry = AgentRegistry.getInstance();
  const init = mock.method(registry, 'ensureInitialized', async () => undefined);
  const lookup = mock.method(registry, 'getAgentById', () => ({ config: { supportedModels: ['new-model'], defaultModel: 'gpt-5.6' } }) as never);
  const publication = mock.method(getEventPublisher(), 'publishGoalUpdate', async () => true);
  const { database, routes, deps } = await fixture();
  try {
    await database('goals').insert({ ...terminalGoal, goal_id: 'goal-1', current_task_id: 'goal-task-1' });
    const invalid = response();
    await routes.continueGoal(keyedRequest('owner-1', 'goal-1', 'key', { model: 'bad' }), invalid.res);
    assert.equal(invalid.state.status, 400);
    const result = response();
    await routes.continueGoal(keyedRequest('owner-1', 'goal-1', 'key', { model: 'new-model' }), result.res);
    assert.equal(result.state.status, 200);
    assert.equal((await goalRow(database)).requested_model, 'new-model');
    const conflict = response();
    await routes.continueGoal(keyedRequest('owner-1', 'goal-1', 'key', { model: 'gpt-5.6' }), conflict.res);
    assert.equal(conflict.state.status, 409);
    await database('goals').insert({ ...terminalGoal, goal_id: '11111111-1111-4111-8111-111111111111', current_task_id: 'task-mcp' });
    const tool = createToolCatalog({ ...deps, db: database, goalServices: deps, runtimeBuildQueue: {} as never,
      policy: { repository: async () => undefined } as never }).find(tool => tool.name === 'continue_goal')!;
    const args = tool.schema.parse({ repository: 'acme/repo', goalId: '11111111-1111-4111-8111-111111111111', idempotencyKey: 'mcp-continue-model', model: 'new-model' });
    const toolResult = await tool.run({ args, principal: { user: { id: 'owner-1', username: 'alice' } } } as never);
    assert.equal(toolResult.status, 200);
    assert.equal((await goalRow(database, '11111111-1111-4111-8111-111111111111')).requested_model, 'new-model');

  } finally { init.mock.restore(); lookup.mock.restore(); publication.mock.restore(); await database.destroy(); }
});

for (const message of ['database file is locked', 'profile service failed', 'Unsupported file type: application/zip. Please upload images or text files.']) {
  test(`continue classifies attachment errors narrowly: ${message}`, async () => {
    const { database, routes } = await fixture(async () => { throw new Error(message); });
    try {
      await database('goals').insert({ ...terminalGoal, goal_id: 'goal-1', current_task_id: 'goal-task-1' });
      const result = response();
      await routes.continueGoal(keyedRequest('owner-1', 'goal-1', 'key'), result.res);
      assert.equal(result.state.status, message.startsWith('Unsupported') ? 400 : 500);
    } finally { await database.destroy(); }
  });
}
