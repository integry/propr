import assert from 'node:assert/strict';
import { after, afterEach, before, describe, test } from 'node:test';
import type { Request, Response } from 'express';
import knex, { type Knex } from 'knex';
import { closeConnection, closeEventPublisher } from '@propr/core';
import { INSTANCE_PERMISSIONS } from '@propr/shared';
import { up as createGoals } from '../../core/src/db/migrations/20260902000000_create_goals.js';
import { up as hardenGoals } from '../../core/src/db/migrations/20260902010000_harden_native_goals.js';
import { up as addGoalCheckpoints } from '../../core/src/db/migrations/20260903000000_add_direct_goal_checkpoints.js';
import { up as addGoalCheckpointDeclarations } from '../../core/src/db/migrations/20260906000000_add_goal_checkpoint_declarations.js';
import { up as addGoalTitles } from '../../core/src/db/migrations/20260907000000_add_goal_titles.js';
import { up as addGoalAttachments } from '../../core/src/db/migrations/20260908000000_add_goal_attachments.js';
import { up as addGoalInputDisplayBody } from '../../core/src/db/migrations/20260923000000_add_goal_input_display_body.js';
import { up as createGoalBlockers } from '../../core/src/db/migrations/20261003050000_create_goal_blockers.js';
import { configureDemoMode, createDemoRedisClient, getDemoUser, resetConfiguredDemoMode } from '../demoMode.js';
import { createGoalRoutes } from '../routes/goalRoutes.js';

const DEMO_REPOSITORY = 'acme/demo';
const HIDDEN_REPOSITORY = 'acme/private';

let database: Knex;
let routes: ReturnType<typeof createGoalRoutes>;

function demoRequest(params: Record<string, string> = {}, method = 'GET'): Request {
    return {
        user: getDemoUser(), params, body: {}, query: {}, method,
        authorization: { role: 'member', permissions: [...INSTANCE_PERMISSIONS], source: 'demo' },
        get: () => undefined,
    } as unknown as Request;
}

function response() {
    const state: { status: number; body?: unknown } = { status: 200 };
    const res = {
        status(code: number) { state.status = code; return this; },
        json(body: unknown) { state.body = body; return this; },
        send(body?: unknown) { state.body = body; return this; },
    } as unknown as Response;
    return { res, state };
}

async function call(handler: (req: Request, res: Response) => Promise<void>, req: Request) {
    const { res, state } = response();
    await handler(req, res);
    return state;
}

const goalIds = (body: unknown) => (body as { goals: Array<{ id?: string; goalId?: string }> }).goals
    .map(goal => goal.id ?? goal.goalId).sort();

before(async () => {
    database = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
    for (const migrate of [createGoals, hardenGoals, addGoalCheckpoints, addGoalCheckpointDeclarations,
        addGoalTitles, addGoalAttachments, addGoalInputDisplayBody, createGoalBlockers]) await migrate(database);
    await database.schema.createTable('task_history', table => {
        table.increments('id'); table.string('task_id'); table.string('state'); table.timestamp('timestamp');
    });
    await database.schema.createTable('tasks', table => { table.string('task_id').primary(); });
    await database.schema.createTable('llm_executions', table => { table.string('execution_id').primary(); table.string('task_id'); });
    await database.schema.createTable('llm_execution_details', table => { table.string('execution_id'); });
    const common = {
        owner_login: 'operator', title: 'Demo goal', objective: 'Ship it', launch_strategy: 'direct',
        initial_prompt: '/goal Ship it', agent_id: 'agent-1', agent_alias: 'codex', agent_type: 'codex',
        requested_model: 'gpt-5.6', desired_state: 'paused', run_generation: 1, run_claim: 'claim-1',
        session_id: null, branch_name: 'goal/demo', worktree_path: '/worktrees/demo',
        pause_confirmed_at: new Date().toISOString(),
        artifact_stats: JSON.stringify({ issues: 0, openIssues: 0, pullRequests: 0, openPullRequests: 0 }),
        artifacts_checked_at: new Date().toISOString(), final_pr_number: 7,
    };
    await database('goals').insert([
        { ...common, goal_id: 'goal-a', owner_id: 'owner-1', repository: DEMO_REPOSITORY, current_task_id: 'task-a' },
        { ...common, goal_id: 'goal-b', owner_id: 'owner-2', repository: DEMO_REPOSITORY, current_task_id: 'task-b' },
        { ...common, goal_id: 'goal-c', owner_id: 'owner-3', repository: HIDDEN_REPOSITORY, current_task_id: 'task-c' },
    ]);
    routes = createGoalRoutes({
        db: database,
        taskQueue: { getJobs: async () => [], add: async () => { throw new Error('demo must not queue work'); } } as never,
        // The demo server's own Redis facade: goal projections read live output through it.
        redisClient: createDemoRedisClient(),
        loadDemoRepositories: async () => [DEMO_REPOSITORY],
        loadVisualPreviewSettings: async () => ({ enabled: true, types: ['image'], instructions: '' }),
        getOctokit: async () => { throw new Error('demo must not read GitHub'); },
    });
});

afterEach(() => resetConfiguredDemoMode());

after(async () => {
    await database.destroy();
    await closeConnection();
    await closeEventPublisher();
});

describe('demo goal visibility', () => {
    test('the demo viewer lists and opens every goal of the demo repositories', async () => {
        configureDemoMode(true);

        const listed = await call(routes.list, demoRequest());
        assert.equal(listed.status, 200);
        assert.deepEqual(goalIds(listed.body), ['goal-a', 'goal-b']);

        assert.equal((await call(routes.get, demoRequest({ goalId: 'goal-b' }))).status, 200);
        assert.equal((await call(routes.inputs, demoRequest({ goalId: 'goal-a' }))).status, 200);
        assert.equal((await call(routes.get, demoRequest({ goalId: 'goal-c' }))).status, 404);

        const attention = await call(routes.attention, demoRequest());
        assert.equal(attention.status, 200);
        assert.deepEqual(goalIds(attention.body), ['goal-a', 'goal-b']);
    });

    test('demo previews stay off GitHub and goal-backed task reads follow goal visibility', async () => {
        configureDemoMode(true);

        const previews = await call(routes.previews, demoRequest({ goalId: 'goal-a' }));
        assert.deepEqual(previews, { status: 200, body: { previews: [] } });

        let nextCalls = 0;
        const guard = async (params: Record<string, string>, method = 'GET') => {
            const { res, state } = response();
            await routes.requireGoalTaskOwnership(demoRequest(params, method), res, () => { nextCalls += 1; });
            return state.status;
        };
        assert.equal(await guard({ taskId: 'task-a' }), 200);
        assert.equal(nextCalls, 1);
        assert.equal(await guard({ taskId: 'task-c' }), 404);
        assert.equal(await guard({ taskId: 'task-a' }, 'POST'), 404);
        assert.equal(nextCalls, 1);
    });

    test('goal mutations keep the owner scope for the demo identity', async () => {
        configureDemoMode(true);
        const paused = await call(routes.pause, demoRequest({ goalId: 'goal-a' }, 'POST'));
        assert.equal(paused.status, 404);
        const removed = await call(routes.remove, demoRequest({ goalId: 'goal-a' }, 'DELETE'));
        assert.equal(removed.status, 404);
        assert.equal(await database('goals').count({ count: '*' }).first().then(row => Number(row?.count)), 3);
    });

    test('with demo mode off the synthetic identity sees only its own (no) goals', async () => {
        configureDemoMode(false);
        const listed = await call(routes.list, demoRequest());
        assert.deepEqual(goalIds(listed.body), []);
        assert.equal((await call(routes.get, demoRequest({ goalId: 'goal-a' }))).status, 404);
        assert.deepEqual(goalIds((await call(routes.attention, demoRequest())).body), []);
    });
});
