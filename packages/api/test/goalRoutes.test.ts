import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import type { Request, Response } from 'express';
import knex from 'knex';
import { AgentRegistry, closeConnection } from '@propr/core';
import { up as createGoals } from '../../core/src/db/migrations/20260902000000_create_goals.js';
import { up as hardenGoals } from '../../core/src/db/migrations/20260902010000_harden_native_goals.js';
import { createGoalRoutes } from '../routes/goalRoutes.js';

function request(userId: string, params: Record<string, string> = {}, body: unknown = {}): Request {
    return {
        user: { id: userId, username: userId }, params, body, method: 'GET',
        get: () => undefined,
    } as unknown as Request;
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
    const stopAttempts = new Map<string, number>();
    const capabilityRequests: Array<{ force?: boolean } | undefined> = [];
    try {
        await createGoals(database);
        await hardenGoals(database);
        await database.schema.createTable('task_history', table => {
            table.increments('id');
            table.string('task_id');
            table.string('state');
            table.timestamp('timestamp');
        });
        const common = {
            owner_login: 'alice', repository: 'acme/repo', objective: 'Ship it',
            launch_strategy: 'direct', initial_prompt: '/goal Ship it\n\nSaved policy',
            agent_id: 'agent-1', agent_alias: 'claude', agent_type: 'claude', requested_model: 'gpt-5.6',
            desired_state: 'paused', run_generation: 2, run_claim: 'claim-2', session_id: 'thread-1',
            branch_name: 'goal/ship-it', worktree_path: '/worktrees/goal-1',
            pause_confirmed_at: new Date().toISOString(),
            artifact_stats: JSON.stringify({ issues: 0, openIssues: 0, pullRequests: 0, openPullRequests: 0 }),
            artifacts_checked_at: '2000-01-01T00:00:00.000Z',
        };
        await database('goals').insert([
            { ...common, goal_id: 'goal-1', owner_id: 'owner-1', current_task_id: 'goal-task-1' },
            { ...common, goal_id: 'goal-2', owner_id: 'owner-2', current_task_id: 'goal-task-2' },
            {
                ...common, goal_id: 'goal-3', owner_id: 'owner-2', current_task_id: 'goal-task-3',
                desired_state: 'running', pause_confirmed_at: null, claimed_at: new Date().toISOString(),
            },
            {
                ...common, goal_id: 'goal-4', owner_id: 'owner-2', current_task_id: 'goal-task-4',
                desired_state: 'running', pause_confirmed_at: null, claimed_at: new Date().toISOString(),
            },
            {
                ...common, goal_id: 'goal-5', owner_id: 'owner-2', current_task_id: 'goal-task-5',
                desired_state: 'running', pause_confirmed_at: null, claimed_at: new Date().toISOString(),
            },
            {
                ...common, goal_id: 'goal-6', owner_id: 'owner-2', current_task_id: 'goal-task-6',
                desired_state: 'running', pause_confirmed_at: null, claimed_at: null, session_id: null,
            },
            {
                ...common, goal_id: 'goal-7', owner_id: 'owner-2', current_task_id: 'goal-task-7',
                agent_alias: 'codex', agent_type: 'codex',
            },
        ]);
        const routes = createGoalRoutes({
            db: database,
            taskQueue: {
                getJobs: async () => [],
                add: async (name: string, data: Record<string, unknown>, options: { jobId: string }) => {
                    queued.push({ name, data, options });
                },
            } as never,
            redisClient: {
                get: async (key: string) => key === 'agent:output:goal-task-1' ? [
                    JSON.stringify({ type: 'assistant', timestamp: '2026-09-02T20:00:00Z', message: {
                        content: [{ type: 'tool_use', name: 'TodoWrite', input: { todos: [
                            { id: 'todo-1', content: 'Inspect API', status: 'completed' },
                            { id: 'todo-2', content: 'Run tests', status: 'in_progress' },
                        ] } }], usage: { input_tokens: 12, output_tokens: 4 },
                    } }),
                ].join('\n') : null,
                del: async () => 1,
            } as never,
            stopExecution: async taskId => {
                stopped.push(taskId);
                const attempt = (stopAttempts.get(taskId) ?? 0) + 1;
                stopAttempts.set(taskId, attempt);
                return taskId === 'goal-task-2' && attempt === 1
                    ? { success: true, containerStopped: false, removedQueuedJobs: 0, abortSignalled: true } as never
                    : { success: true, containerStopped: true, removedQueuedJobs: 0 } as never;
            },
            getCapabilities: async options => {
                capabilityRequests.push(options);
                return [];
            },
        });

        const listed = response();
        await routes.list(request('owner-1'), listed.res);
        assert.equal(listed.state.status, 200);
        const listedGoals = (listed.state.body as { goals: Array<{ id: string; launchStrategy: string; initialPrompt: string; liveSummary: { currentTask: string; todos: unknown[]; tokenUsage: { input_tokens: number } } }> }).goals;
        assert.deepEqual(listedGoals.map(goal => goal.id), ['goal-1']);
        assert.equal(listedGoals[0].launchStrategy, 'direct');
        assert.equal(listedGoals[0].initialPrompt, '/goal Ship it\n\nSaved policy');
        assert.equal(listedGoals[0].liveSummary.currentTask, 'Run tests');
        assert.equal(listedGoals[0].liveSummary.todos.length, 2);
        assert.equal(listedGoals[0].liveSummary.tokenUsage.input_tokens, 12);
        assert.equal((await database('goals').where({ goal_id: 'goal-1' }).first()).artifacts_checked_at, '2000-01-01T00:00:00.000Z');

        const invalidStrategy = response();
        await routes.create(request('owner-1', {}, {
            repository: 'acme/repo', objective: 'Ship it', agentId: 'agent-1', model: 'gpt-5.6',
            launchStrategy: 'planner',
        }), invalidStrategy.res);
        assert.equal(invalidStrategy.state.status, 400);
        assert.deepEqual(invalidStrategy.state.body, { error: 'launchStrategy must be direct or orchestrate' });

        const registry = AgentRegistry.getInstance();
        mock.method(registry, 'ensureInitialized', async () => {});
        mock.method(registry, 'getAgentById', (agentId: string) => ({ config: {
            id: agentId, alias: agentId, type: agentId === 'codex-agent' ? 'codex' : 'claude',
            supportedModels: ['gpt-5.6', 'gpt-5.6-fast'],
        } } as never));
        const recheckRequest = request('owner-1');
        (recheckRequest as unknown as { query: Record<string, string> }).query = { recheck: 'true' };
        const rechecked = response();
        await routes.capabilities(recheckRequest, rechecked.res);
        assert.equal(rechecked.state.status, 200);
        assert.deepEqual(capabilityRequests, [{ force: true }]);

        const oversizedCodexPrompt = response();
        const oversizedCodexRequest = request('owner-1', {}, {
            repository: 'acme/repo', objective: '😀'.repeat(4_000), agentId: 'codex-agent', model: 'gpt-5.6',
            launchStrategy: 'direct',
        });
        oversizedCodexRequest.get = () => 'oversized-codex-prompt';
        await routes.create(oversizedCodexRequest, oversizedCodexPrompt.res);
        assert.equal(oversizedCodexPrompt.state.status, 400);
        assert.match((oversizedCodexPrompt.state.body as { error: string }).error, /Final Codex goal prompt/);

        await database('goals').where({ goal_id: 'goal-1' }).update({
            create_idempotency_key: 'create-key-1',
            create_idempotency_operation: 'goal.create',
            create_payload_hash: 'different-payload',
        });
        const mismatchedCreate = response();
        const createRequest = request('owner-1', {}, {
            repository: 'acme/repo', objective: 'Different goal', agentId: 'agent-1', model: 'gpt-5.6',
            launchStrategy: 'direct',
        });
        createRequest.get = () => 'create-key-1';
        await routes.create(createRequest, mismatchedCreate.res);
        assert.equal(mismatchedCreate.state.status, 409);

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
        const inputRequest = request('owner-1', { goalId: 'goal-1' }, { message: 'Focus on the API first.' });
        inputRequest.get = () => 'owner-input-1';
        await routes.input(inputRequest, continued.res);
        assert.equal(continued.state.status, 200);
        assert.equal(queued.length, 1);
        assert.equal(queued[0].name, 'processGoal');
        assert.deepEqual(queued[0].options, { jobId: 'goal-goal-1-3', attempts: 1 });
        assert.deepEqual({ ...queued[0].data, claimId: undefined }, {
            goalId: 'goal-1', taskId: 'goal-task-1', repoOwner: 'acme', repoName: 'repo',
            generation: 3, claimId: undefined, recovery: false,
        });
        assert.equal(typeof queued[0].data.claimId, 'string');
        const savedInput = await database('goal_inputs').where({ goal_id: 'goal-1' }).first();
        assert.equal(savedInput.message, 'Focus on the API first.');
        assert.equal(savedInput.state, 'pending');
        const duplicateInput = response();
        await routes.input(inputRequest, duplicateInput.res);
        assert.equal(duplicateInput.state.status, 200);
        assert.equal(queued.length, 1);
        assert.equal(Number((await database('goal_inputs').count('* as count').first()).count), 1);
        const mismatchedInput = response();
        const mismatchedRequest = request('owner-1', { goalId: 'goal-1' }, { message: 'A different payload.' });
        mismatchedRequest.get = () => 'owner-input-1';
        await routes.input(mismatchedRequest, mismatchedInput.res);
        assert.equal(mismatchedInput.state.status, 409);
        const missingKeyInput = response();
        await routes.input(request('owner-1', { goalId: 'goal-1' }, { message: 'No key.' }), missingKeyInput.res);
        assert.equal(missingKeyInput.state.status, 400);
        const updated = await database('goals').where({ goal_id: 'goal-1' }).first();
        assert.equal(updated.session_id, 'thread-1');
        assert.equal(updated.current_task_id, 'goal-task-1');
        assert.equal(updated.worktree_path, '/worktrees/goal-1');
        assert.equal(updated.desired_state, 'running');

        const runningClaudeInput = response();
        const runningInputRequest = request('owner-2', { goalId: 'goal-3' }, { message: 'Apply this at a safe boundary.' });
        runningInputRequest.get = () => 'owner-running-input-1';
        await routes.input(runningInputRequest, runningClaudeInput.res);
        assert.equal(runningClaudeInput.state.status, 200);
        const boundary = await database('goals').where({ goal_id: 'goal-3' }).first();
        assert.equal(boundary.desired_state, 'paused');
        assert.equal(Boolean(boundary.resume_requested), true);
        assert.equal(boundary.control_generation, 1);
        assert.ok(stopped.includes('goal-task-3'));

        const preSessionInput = response();
        const preSessionRequest = request('owner-2', { goalId: 'goal-6' }, { message: 'Keep the initial goal, then apply this correction.' });
        preSessionRequest.get = () => 'owner-pre-session-input-1';
        await routes.input(preSessionRequest, preSessionInput.res);
        assert.equal(preSessionInput.state.status, 200);
        const preSessionBoundary = await database('goals').where({ goal_id: 'goal-6' }).first();
        assert.equal(preSessionBoundary.desired_state, 'running');
        assert.equal(preSessionBoundary.run_generation, 2);
        assert.equal(preSessionBoundary.control_generation, 1);
        assert.equal(stopped.includes('goal-task-6'), false);
        assert.equal((await database('goal_inputs').where({ goal_id: 'goal-6' }).first()).state, 'pending');

        const nativeResume = response();
        const nativeResumeRequest = request('owner-2', { goalId: 'goal-7' });
        nativeResumeRequest.get = () => 'owner-native-resume-1';
        await routes.resume(nativeResumeRequest, nativeResume.res);
        assert.equal(nativeResume.state.status, 200);
        assert.equal(queued.length, 2);
        const nativeResumeRecord = await database('goal_inputs').where({ goal_id: 'goal-7', operation: 'goal.resume' }).first();
        assert.equal(nativeResumeRecord.kind, 'control');
        assert.equal(nativeResumeRecord.state, 'delivered');
        assert.equal(nativeResumeRecord.message, '');

        const pauseRequest = request('owner-2', { goalId: 'goal-4' });
        pauseRequest.get = () => 'owner-pause-1';
        await routes.pause(pauseRequest, response().res);
        await routes.pause(pauseRequest, response().res);
        assert.equal(stopped.filter(taskId => taskId === 'goal-task-4').length, 2);

        const modelRequest = request('owner-2', { goalId: 'goal-5' }, { model: 'gpt-5.6-fast' });
        modelRequest.get = () => 'owner-model-1';
        await routes.requestModel(modelRequest, response().res);
        const modelBoundary = await database('goals').where({ goal_id: 'goal-5' }).first();
        assert.equal(modelBoundary.requested_model, 'gpt-5.6-fast');
        assert.equal(modelBoundary.desired_state, 'paused');
        assert.equal(Boolean(modelBoundary.resume_requested), true);
        assert.equal(modelBoundary.control_generation, 1);
        assert.ok(stopped.includes('goal-task-5'));

        const cancelled = response();
        const cancelRequest = request('owner-2', { goalId: 'goal-2' });
        cancelRequest.get = () => 'owner-cancel-1';
        await routes.cancel(cancelRequest, cancelled.res);
        assert.equal((await database('goals').where({ goal_id: 'goal-2' }).first()).result_state, null);
        await routes.cancel(cancelRequest, cancelled.res);
        assert.equal(cancelled.state.status, 200);
        assert.ok(stopped.includes('goal-task-2'));
        assert.equal(stopped.filter(taskId => taskId === 'goal-task-2').length, 2);
        assert.equal((await database('goals').where({ goal_id: 'goal-2' }).first()).result_state, 'cancelled');
    } finally {
        await database.destroy();
        await closeConnection();
    }
});
