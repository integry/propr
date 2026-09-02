import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Request, Response } from 'express';
import knex from 'knex';
import { closeConnection } from '@propr/core';
import { up as createGoals } from '../../core/src/db/migrations/20260902000000_create_goals.js';
import { createGoalRoutes } from '../routes/goalRoutes.js';

function request(userId: string, params: Record<string, string> = {}, body: unknown = {}): Request {
    return { user: { id: userId, username: userId }, params, body } as unknown as Request;
}

function response() {
    const state: { status: number; body?: unknown } = { status: 200 };
    const res = {
        status(code: number) { state.status = code; return this; },
        json(body: unknown) { state.body = body; return this; },
    } as unknown as Response;
    return { res, state };
}

test('goal routes keep metadata owner-scoped and queue ordinary input on the same task/session', async () => {
    const database = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
    const queued: Array<{ name: string; data: Record<string, unknown>; options: { jobId: string } }> = [];
    const stopped: string[] = [];
    try {
        await createGoals(database);
        await database.schema.createTable('task_history', table => {
            table.increments('id');
            table.string('task_id');
            table.string('state');
            table.timestamp('timestamp');
        });
        const common = {
            owner_login: 'alice', repository: 'acme/repo', objective: 'Ship it',
            agent_id: 'agent-1', agent_alias: 'codex', agent_type: 'codex', requested_model: 'gpt-5.6',
            desired_state: 'paused', run_generation: 2, session_id: 'thread-1',
            branch_name: 'goal/ship-it', worktree_path: '/worktrees/goal-1',
        };
        await database('goals').insert([
            { ...common, goal_id: 'goal-1', owner_id: 'owner-1', current_task_id: 'goal-task-1' },
            { ...common, goal_id: 'goal-2', owner_id: 'owner-2', current_task_id: 'goal-task-2' },
        ]);
        const routes = createGoalRoutes({
            db: database,
            taskQueue: {
                getJobs: async () => [],
                add: async (name: string, data: Record<string, unknown>, options: { jobId: string }) => {
                    queued.push({ name, data, options });
                },
            } as never,
            redisClient: { del: async () => 1 } as never,
            stopExecution: async taskId => { stopped.push(taskId); return {} as never; },
            getCapabilities: async () => [],
        });

        const listed = response();
        await routes.list(request('owner-1'), listed.res);
        assert.equal(listed.state.status, 200);
        assert.deepEqual((listed.state.body as { goals: Array<{ id: string }> }).goals.map(goal => goal.id), ['goal-1']);

        const hidden = response();
        await routes.get(request('owner-1', { goalId: 'goal-2' }), hidden.res);
        assert.equal(hidden.state.status, 404);

        const taskHidden = response();
        let nextCalled = false;
        await routes.requireGoalTaskOwnership(
            request('owner-2', { taskId: 'goal-task-1' }),
            taskHidden.res,
            () => { nextCalled = true; },
        );
        assert.equal(taskHidden.state.status, 404);
        assert.equal(nextCalled, false);

        const genericMutation = response();
        const mutationRequest = request('owner-1', { taskId: 'goal-task-1' });
        mutationRequest.method = 'POST';
        await routes.requireGoalTaskOwnership(mutationRequest, genericMutation.res, () => { nextCalled = true; });
        assert.equal(genericMutation.state.status, 409);

        const metricHidden = response();
        await routes.requireGoalTaskOwnership(
            request('owner-2', { correlationId: 'goal-1' }), metricHidden.res, () => { nextCalled = true; },
        );
        assert.equal(metricHidden.state.status, 404);

        const continued = response();
        await routes.input(request('owner-1', { goalId: 'goal-1' }, { message: 'Focus on the API first.' }), continued.res);
        assert.equal(continued.state.status, 200);
        assert.equal(queued.length, 1);
        assert.deepEqual(queued[0], {
            name: 'processGoal',
            data: {
                goalId: 'goal-1', taskId: 'goal-task-1', repoOwner: 'acme', repoName: 'repo',
                generation: 3, input: 'Focus on the API first.', continuationKind: 'input',
            },
            options: { jobId: 'goal-goal-1-3' },
        });
        const updated = await database('goals').where({ goal_id: 'goal-1' }).first();
        assert.equal(updated.session_id, 'thread-1');
        assert.equal(updated.current_task_id, 'goal-task-1');
        assert.equal(updated.worktree_path, '/worktrees/goal-1');
        assert.equal(updated.desired_state, 'running');

        const cancelled = response();
        await routes.cancel(request('owner-2', { goalId: 'goal-2' }), cancelled.res);
        assert.equal(cancelled.state.status, 200);
        assert.deepEqual(stopped, ['goal-task-2']);
        assert.equal((await database('goals').where({ goal_id: 'goal-2' }).first()).result_state, 'cancelled');
    } finally {
        await database.destroy();
        await closeConnection();
    }
});
