import assert from 'node:assert/strict';
import { after, beforeEach, mock, test } from 'node:test';
import knex, { type Knex } from 'knex';
import type { ReasoningLevel } from '@propr/shared';
import { resolveAgentModelReasoningLevel, resolveRuntimeModelReasoningLevel } from '../packages/core/src/config/configManagerReasoning.js';
import { describeRepositoryValidationStatus } from '../packages/core/src/workflow/repositoryValidationResult.js';
import { isDefaultRetryableError } from '../packages/core/src/utils/retryHandler.js';
import { up as addLineage } from '../packages/core/src/db/migrations/20261006000000_add_task_replacement_lineage.js';
import { closeConnection } from '../packages/core/src/db/connection.js';

after(async () => { await closeConnection(); });

// --- Agents, settings and usage the ladder resolves against ---

const configs: Record<string, { alias: string; type: string; enabled: boolean; supportedModels: string[]; modelReasoningLevels: Record<string, ReasoningLevel> }> = {
    claude: { alias: 'claude', type: 'claude', enabled: true, supportedModels: ['claude-sonnet-5-5', 'claude-opus-5-5'], modelReasoningLevels: {} },
    codex: { alias: 'codex', type: 'codex', enabled: true, supportedModels: ['gpt-6'], modelReasoningLevels: {} },
};
let settings = { enabled: true, models: ['claude:claude-opus-5-5'], maxReasoningLevels: 2, validationFollowupEnabled: false };
let usage: Record<string, { sessionPercent?: number; weeklyPercent?: number }> = {};
const enqueued: Array<{ name: string; data: Record<string, unknown>; jobId: string }> = [];
const comments: string[] = [];
const history: Array<Record<string, unknown>> = [];
beforeEach(() => {
    settings = { enabled: true, models: ['claude:claude-opus-5-5'], maxReasoningLevels: 2, validationFollowupEnabled: false };
    usage = {};
    configs.codex.enabled = true;
    enqueued.length = 0; comments.length = 0; history.length = 0;
});

const quiet = { info() {}, warn() {}, error() {}, debug() {} };
await mock.module('@propr/core', { namedExports: {
    isDefaultRetryableError,
    describeRepositoryValidationStatus,
    logger: quiet,
    AgentRegistry: { getInstance: () => ({ ensureInitialized: async () => {}, getAgentByAlias: (alias: string) => configs[alias] ? { config: configs[alias] } : undefined }) },
    loadImplementationEscalationSettings: async () => settings,
    loadUltrafixEscalationSettings: async () => ({ enabled: false, models: [], patience: 1, maxReasoningLevels: 0 }),
    loadModelReasoningLevel: async () => 'medium',
    resolveAgentModelReasoningLevel,
    resolveRuntimeModelReasoningLevel,
    resolveLlmLabel: async (model: string) => ({ agentAlias: model.split(':')[0], model: model.split(':')[1] }),
    // Like the real resolver, a bare model ID resolves to its agent's qualified ID.
    resolveConfiguredModel: async (model: string) => model.includes(':') ? model : `${Object.values(configs).find(config => config.supportedModels.includes(model))?.alias}:${model}`,
    issueQueue: { add: async (name: string, data: Record<string, unknown>, opts: { jobId: string }) => { enqueued.push({ name, data, jobId: opts.jobId }); } },
    getAuthenticatedOctokit: async () => ({ request: async (_route: string, params: { body: string }) => { comments.push(params.body); } }),
    getStateManager: () => ({ getTaskState: async () => ({ state: 'completed' }) }),
    db: () => ({ insert: async (row: Record<string, unknown>) => { history.push(row); } }),
} });
await mock.module('../packages/core/src/services/syntheticUsageSnapshotProvider.js', { namedExports: {
    AliasSpecificAgentTankSnapshotProvider: class { async getSnapshot(alias: string) { return usage[alias] ?? null; } },
} });

const { planImplementationEscalation, escalateReplacementJob, implementationEscalationEvent, requestValidationFollowup, validationFollowupClaimKey } = await import('../src/jobs/implementationEscalation.js');
const { createTaskReplacementService } = await import('../src/taskReplacement/service.js');
const { createTaskReplacementStore, recordReplayableIssueTask } = await import('../src/taskReplacement/store.js');

// --- Ladder ---

test('the ladder climbs one reasoning level per step up to the maximum, then hands off at the next model\'s base effort', async () => {
    let model = 'claude:claude-sonnet-5-5';
    let effort: ReasoningLevel | undefined;
    let ladder;
    const steps: Array<[string, string, string | undefined]> = [];
    for (let attempt = 0; attempt < 4; attempt++) {
        const escalation = await planImplementationEscalation({ model, effort, ladder, reason: 'provider_transient' }, settings);
        assert.ok(escalation);
        steps.push([escalation.step, escalation.to.model, escalation.to.effort]);
        ({ model } = escalation.to);
        effort = escalation.to.effort;
        ladder = escalation.ladder;
    }
    assert.deepEqual(steps, [
        ['reasoning_increased', 'claude:claude-sonnet-5-5', 'high'],
        ['reasoning_increased', 'claude:claude-sonnet-5-5', 'xhigh'],
        // The maximum of two increases is reached: the next model takes over at its own configured effort.
        ['model_handoff', 'claude:claude-opus-5-5', 'medium'],
        ['reasoning_increased', 'claude:claude-opus-5-5', 'high'],
    ]);
    assert.deepEqual(ladder, { models: ['claude:claude-sonnet-5-5', 'claude:claude-opus-5-5'], maxReasoningLevels: 2, modelIndex: 1, climbs: 1 });
});

test('a maximum of 0 hands off directly, and an exhausted ladder keeps the current selection', async () => {
    settings.maxReasoningLevels = 0;
    const handoff = await planImplementationEscalation({ model: 'codex:gpt-6', effort: 'high', reason: 'provider_transient' }, settings);
    assert.deepEqual(handoff && [handoff.step, handoff.from, handoff.to], ['model_handoff', { model: 'codex:gpt-6', effort: 'high' }, { model: 'claude:claude-opus-5-5', effort: 'medium' }]);
    assert.equal(await planImplementationEscalation({ model: 'claude:claude-opus-5-5', effort: 'medium', ladder: handoff!.ladder, reason: 'provider_transient' }, settings), null);
});

test('a handoff skips unavailable, disabled and usage-exhausted candidates, like Ultrafix', async () => {
    settings = { ...settings, maxReasoningLevels: 0, models: ['missing:model', 'codex:gpt-6', 'claude:claude-opus-5-5'] };
    usage = { codex: { weeklyPercent: 100 } };
    const skippedByUsage = await planImplementationEscalation({ model: 'claude:claude-sonnet-5-5', reason: 'infra_lost' }, settings);
    assert.equal(skippedByUsage?.to.model, 'claude:claude-opus-5-5');
    assert.equal(skippedByUsage?.ladder.modelIndex, 3);
    usage = {};
    configs.codex.enabled = false;
    assert.equal((await planImplementationEscalation({ model: 'claude:claude-sonnet-5-5', reason: 'infra_lost' }, settings))?.to.model, 'claude:claude-opus-5-5');
    configs.codex.enabled = true;
    assert.equal((await planImplementationEscalation({ model: 'claude:claude-sonnet-5-5', reason: 'infra_lost' }, settings))?.to.model, 'codex:gpt-6');
});

test('an alias of the current model is not a handoff, so the run never restarts the same model at a lower effort', async () => {
    settings = { ...settings, maxReasoningLevels: 0, models: ['claude-sonnet-5-5'] };
    // The bare ID resolves to the current model: no step is left, and the current high effort is kept.
    assert.equal(await planImplementationEscalation({ model: 'claude:claude-sonnet-5-5', effort: 'high', reason: 'provider_transient' }, settings), null);
    assert.equal(await escalateReplacementJob({ agentAlias: 'claude', modelName: 'claude-sonnet-5-5', reasoningLevel: 'high' }, 'provider_transient'), null);

    settings.models = ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude:claude-opus-5-5'];
    const handoff = await planImplementationEscalation({ model: 'claude:claude-sonnet-5-5', effort: 'high', reason: 'provider_transient' }, settings);
    assert.deepEqual(handoff && [handoff.step, handoff.to], ['model_handoff', { model: 'claude:claude-opus-5-5', effort: 'medium' }]);
    assert.deepEqual(handoff?.ladder.models, ['claude:claude-sonnet-5-5', 'claude:claude-opus-5-5'], 'the ladder holds canonical IDs without aliases');
});

test('a carried ladder skips aliases of the current or an earlier rung', async () => {
    settings.maxReasoningLevels = 0;
    const carried = { models: ['claude:claude-sonnet-5-5', 'claude-sonnet-5-5'], maxReasoningLevels: 0, modelIndex: 0, climbs: 0 };
    assert.equal(await planImplementationEscalation({ model: 'claude:claude-sonnet-5-5', effort: 'high', ladder: carried, reason: 'infra_lost' }, settings), null);
    const pastHandoff = { models: ['claude:claude-sonnet-5-5', 'claude:claude-opus-5-5', 'claude-sonnet-5-5', 'codex:gpt-6'], maxReasoningLevels: 0, modelIndex: 1, climbs: 0 };
    const next = await planImplementationEscalation({ model: 'claude:claude-opus-5-5', effort: 'high', ladder: pastHandoff, reason: 'infra_lost' }, settings);
    assert.deepEqual(next && [next.to.model, next.ladder.modelIndex], ['codex:gpt-6', 3]);
});

test('the escalation event names from, to and reason', async () => {
    const escalation = await planImplementationEscalation({ model: 'claude:claude-sonnet-5-5', effort: 'medium', reason: 'provider_transient' }, settings);
    const event = implementationEscalationEvent(escalation!);
    assert.equal(event.reason, 'Raised reasoning from claude:claude-sonnet-5-5 (medium) to claude:claude-sonnet-5-5 (high): the previous attempt ended with a transient provider error');
    assert.deepEqual([event.metadata.from, event.metadata.to, event.metadata.reason], [
        { model: 'claude:claude-sonnet-5-5', effort: 'medium' }, { model: 'claude:claude-sonnet-5-5', effort: 'high' }, 'provider_transient',
    ]);
});

test('replacement escalation is off unless enabled', async () => {
    settings.enabled = false;
    assert.equal(await escalateReplacementJob({ agentAlias: 'claude', modelName: 'claude-sonnet-5-5' }, 'provider_transient'), null);
    settings.enabled = true;
    const result = await escalateReplacementJob({ agentAlias: 'claude', modelName: 'claude-sonnet-5-5', reasoningLevel: 'high' }, 'provider_transient');
    assert.deepEqual(result?.jobData && [result.jobData.agentAlias, result.jobData.modelName, result.jobData.reasoningLevel], ['claude', 'claude-sonnet-5-5', 'xhigh']);
});

// --- Replacement service integration ---

const databases: Knex[] = [];
after(async () => { await Promise.all(databases.map(database => database.destroy())); });

async function createDatabase(): Promise<Knex> {
    const database = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
    databases.push(database);
    await database.schema.createTable('tasks', table => {
        table.string('task_id').primary(); table.string('job_id').unique(); table.string('correlation_id');
        table.string('repository').notNullable(); table.integer('issue_number'); table.string('task_type').notNullable();
        table.string('model_name'); table.timestamp('created_at'); table.json('initial_job_data');
    });
    await database.schema.createTable('task_history', table => {
        table.increments('history_id').primary(); table.string('task_id').notNullable(); table.string('state').notNullable();
        table.timestamp('timestamp').notNullable(); table.text('reason'); table.json('metadata');
    });
    await database.schema.createTable('llm_executions', table => {
        table.increments('execution_id').primary(); table.string('task_id').notNullable(); table.decimal('cost_usd', 10, 6);
    });
    await addLineage(database);
    return database;
}

async function seedFailedTask(database: Knex, taskId: string, job: Record<string, unknown> = {}): Promise<void> {
    await database('tasks').insert({
        task_id: taskId, job_id: `job-${taskId}`, correlation_id: 'c', repository: 'integry/propr', issue_number: 3441,
        task_type: 'issue', model_name: 'claude-sonnet-5-5', created_at: '2026-11-12T08:00:00.000Z', initial_job_data: '{}',
    });
    await recordReplayableIssueTask(database, taskId, {
        repoOwner: 'integry', repoName: 'propr', number: 3441, agentAlias: 'claude', modelName: 'claude-sonnet-5-5', correlationId: 'c', ...job,
    } as never);
    await database('task_history').insert([
        { task_id: taskId, state: 'claude_execution', timestamp: '2026-11-12T08:01:00.000Z', reason: 'started', metadata: '{}' },
        { task_id: taskId, state: 'failed', timestamp: '2026-11-12T08:02:00.000Z', reason: 'failed', metadata: '{}' },
    ]);
}

let ids = 0;
function service(database: Knex, escalate = true, replacementEnqueued: Array<Record<string, unknown>> = []) {
    return createTaskReplacementService({
        store: createTaskReplacementStore(database),
        async enqueue(_name, data) { replacementEnqueued.push(data as unknown as Record<string, unknown>); },
        loadMaxProviderReplacements: async () => 5,
        infraLostEnabled: () => true,
        ...(escalate ? {
            async escalate(replay, cause) {
                const result = await escalateReplacementJob(replay, cause);
                return result && { jobData: result.jobData, event: implementationEscalationEvent(result.escalation) };
            },
        } : {}),
        randomId: () => `id-${++ids}`,
        now: () => new Date('2026-11-12T09:00:00.000Z'),
    });
}

async function escalationEvents(database: Knex, taskId: string) {
    const rows = await database('task_history').where({ task_id: taskId }).orderBy('history_id') as Array<{ metadata: string; reason: string }>;
    return rows.map(row => ({ reason: row.reason, ...JSON.parse(row.metadata) })).filter(event => event.event === 'task.escalation');
}

test('each replacement of a failed attempt runs one step higher and records the escalation on the failed task', async () => {
    const database = await createDatabase();
    await seedFailedTask(database, 'task-1');
    const jobs: Array<Record<string, unknown>> = [];
    const first = await service(database, true, jobs).complete({ taskId: 'task-1', cause: 'provider_transient', error: '529 Overloaded' });
    assert.ok(first.action === 'dispatched');
    assert.deepEqual([jobs[0].agentAlias, jobs[0].modelName, jobs[0].reasoningLevel], ['claude', 'claude-sonnet-5-5', 'high']);
    const [event] = await escalationEvents(database, 'task-1');
    assert.deepEqual([event.from, event.to, event.reason, event.replacementTaskId], [
        { model: 'claude:claude-sonnet-5-5', effort: 'medium' }, { model: 'claude:claude-sonnet-5-5', effort: 'high' }, 'provider_transient', first.replacementTaskId,
    ]);
    // The spend of every attempt counts toward the escalated run's cap.
    assert.deepEqual(jobs[0].costBudgetTaskIds, ['task-1']);

    // The replacement carries the ladder: its own failure climbs one more step, then hands off.
    await database('task_history').insert({ task_id: first.replacementTaskId, state: 'failed', timestamp: '2026-11-12T09:10:00.000Z', reason: 'failed', metadata: '{}' });
    const second = await service(database, true, jobs).complete({ taskId: first.replacementTaskId, cause: 'infra_lost' });
    assert.ok(second.action === 'dispatched');
    assert.equal(jobs[1].reasoningLevel, 'xhigh');
    await database('task_history').insert({ task_id: second.replacementTaskId, state: 'failed', timestamp: '2026-11-12T09:20:00.000Z', reason: 'failed', metadata: '{}' });
    const third = await service(database, true, jobs).complete({ taskId: second.replacementTaskId, cause: 'provider_transient' });
    assert.ok(third.action === 'dispatched');
    assert.deepEqual([jobs[2].modelName, jobs[2].reasoningLevel], ['claude-opus-5-5', 'medium']);
    assert.match(third.replacementTaskId, /claude-opus-5-5/, 'the replacement task is named after the handoff model');
    assert.equal((await escalationEvents(database, second.replacementTaskId))[0].step, 'model_handoff');
    assert.deepEqual(jobs[2].costBudgetTaskIds, ['task-1', first.replacementTaskId, second.replacementTaskId]);
});

test('with escalation off, or when it fails, the replacement reruns the failed attempt\'s selection', async () => {
    const database = await createDatabase();
    await seedFailedTask(database, 'task-off', { reasoningLevel: 'low' });
    settings.enabled = false;
    const jobs: Array<Record<string, unknown>> = [];
    assert.equal((await service(database, true, jobs).complete({ taskId: 'task-off', cause: 'provider_transient' })).action, 'dispatched');
    assert.deepEqual([jobs[0].modelName, jobs[0].reasoningLevel, jobs[0].implementationEscalation], ['claude-sonnet-5-5', 'low', undefined]);
    assert.deepEqual(await escalationEvents(database, 'task-off'), []);

    settings.enabled = true;
    await seedFailedTask(database, 'task-error', { reasoningLevel: 'low' });
    const failing = createTaskReplacementService({
        store: createTaskReplacementStore(database), async enqueue(_name, data) { jobs.push(data as never); },
        loadMaxProviderReplacements: async () => 5, infraLostEnabled: () => true,
        escalate: async () => { throw new Error('registry unavailable'); },
    });
    assert.equal((await failing.complete({ taskId: 'task-error', cause: 'provider_transient' })).action, 'dispatched');
    assert.equal(jobs[1].reasoningLevel, 'low');
});

// --- Validation follow-up ---

const failedValidation = {
    overall: 'failed' as const,
    commands: [
        { index: 0, command: 'npm run lint', status: 'passed' as const, verified: true },
        { index: 1, command: 'npm test', status: 'failed' as const, exitCode: 1, verified: true },
    ],
};

function followupParams(overrides: Record<string, unknown> = {}) {
    return {
        taskId: 'issue-task-1',
        issueRef: { repoOwner: 'integry', repoName: 'propr', number: 3441, userId: '42', costBudgetTaskIds: ['earlier-attempt'], maxCostUsd: 4 },
        agentAlias: 'claude', modelName: 'claude-sonnet-5-5',
        claudeResult: { success: true, reasoningLevel: 'medium' as ReasoningLevel, repositoryValidationResult: failedValidation },
        pullRequest: { number: 77 },
        correlatedLogger: quiet,
        ...overrides,
    } as Parameters<typeof requestValidationFollowup>[0];
}

function claims() {
    const held = new Map<string, string>();
    return {
        held,
        claim: async (key: string) => !held.has(key) && !!held.set(key, 'pending'),
        readClaim: async (key: string) => held.get(key) ?? null,
        completeClaim: async (key: string) => held.get(key) === 'pending' && !!held.set(key, 'delivered'),
        release: async (key: string) => { if (held.get(key) === 'pending') held.delete(key); },
        jobExists: async (jobId: string) => enqueued.some(job => job.jobId === jobId),
    };
}

test('a failed validation queues one escalated follow-up asking to fix the failing commands', async () => {
    settings = { ...settings, enabled: false, validationFollowupEnabled: true };
    const guard = claims();
    assert.equal(await requestValidationFollowup(followupParams(), { ...guard, randomId: () => 'followup-correlation' }), 'queued');
    assert.equal(enqueued.length, 1);
    const { name, data, jobId } = enqueued[0];
    assert.equal(name, 'processPullRequestComment');
    assert.match(jobId, /^pr-validation-followup-integry-propr-77-/);
    assert.deepEqual([data.pullRequestNumber, data.llm, data.reasoningLevel, data.userId, data.correlationId], [77, 'claude:claude-sonnet-5-5', 'high', '42', 'followup-correlation']);
    assert.deepEqual(data.effortEscalation, { model: 'claude:claude-sonnet-5-5', effort: 'high', reason: 'repository_validation_failed', sourceTaskId: 'issue-task-1' });
    // Spend counts toward the task's cap together with its earlier attempts.
    assert.deepEqual([data.maxCostUsd, data.costBudgetTaskIds], [4, ['earlier-attempt', 'issue-task-1']]);
    const [request] = data.comments as Array<{ id: number; author: string; body: string }>;
    assert.equal(request.id, 0);
    assert.equal(request.author, 'propr-escalation');
    assert.match(request.body, /`npm test`: Failed \(exit 1\)/);
    assert.doesNotMatch(request.body, /npm run lint/, 'only the failing commands are listed');
    const event = JSON.parse(String(history[0].metadata));
    assert.deepEqual([history[0].task_id, event.event, event.reason, event.to], ['issue-task-1', 'task.escalation', 'repository_validation_failed', { model: 'claude:claude-sonnet-5-5', effort: 'high' }]);
    assert.match(comments[0], /One automatic follow-up/);

    // At most one follow-up per task.
    assert.equal(await requestValidationFollowup(followupParams(), guard), 'duplicate');
    assert.equal(enqueued.length, 1);
});

test('the validation follow-up is off by default and only follows a failed validation on an opened pull request', async () => {
    const guard = claims();
    assert.equal(await requestValidationFollowup(followupParams(), guard), 'disabled');
    settings.validationFollowupEnabled = true;
    const incomplete = { ...failedValidation, overall: 'incomplete' as const };
    assert.equal(await requestValidationFollowup(followupParams({ claudeResult: { success: true, repositoryValidationResult: incomplete } }), guard), 'not_failed');
    assert.equal(await requestValidationFollowup(followupParams({ claudeResult: { success: false, repositoryValidationResult: failedValidation } }), guard), 'not_failed');
    assert.equal(await requestValidationFollowup(followupParams({ pullRequest: null }), guard), 'no_pull_request');
    settings = { ...settings, models: [], maxReasoningLevels: 0 };
    assert.equal(await requestValidationFollowup(followupParams(), guard), 'ladder_exhausted');
    assert.equal(enqueued.length, 0);
});

test('a follow-up the queue rejected releases its claim, so a retry of the run can still start it', async () => {
    settings.validationFollowupEnabled = true;
    const guard = claims();
    await assert.rejects(requestValidationFollowup(followupParams(), { ...guard, enqueue: async () => { throw new Error('redis down'); } }), /redis down/);
    assert.equal(await requestValidationFollowup(followupParams(), guard), 'queued');
});

test('a reservation interrupted before its job was queued is recovered instead of suppressing the follow-up', async () => {
    settings.validationFollowupEnabled = true;
    const guard = claims();
    // A previous invocation stopped right after reserving the follow-up.
    guard.held.set(validationFollowupClaimKey('issue-task-1'), 'pending');
    assert.equal(await requestValidationFollowup(followupParams(), guard), 'queued');
    assert.equal(enqueued.length, 1);
    assert.equal(comments.length, 1);
    assert.equal(guard.held.get(validationFollowupClaimKey('issue-task-1')), 'delivered');
    assert.equal(await requestValidationFollowup(followupParams(), guard), 'duplicate');
    assert.equal(enqueued.length, 1);
});

test('a reservation interrupted after its job was queued is completed without queueing it twice', async () => {
    settings.validationFollowupEnabled = true;
    const guard = claims();
    let stop = true;
    const interrupted = { ...guard, completeClaim: async (key: string) => { if (stop) throw new Error('worker stopped'); return guard.completeClaim(key); } };
    await assert.rejects(requestValidationFollowup(followupParams(), interrupted), /worker stopped/);
    assert.equal(enqueued.length, 1);
    assert.equal(guard.held.get(validationFollowupClaimKey('issue-task-1')), 'pending', 'an undelivered reservation is not a completed follow-up');
    stop = false;
    assert.equal(await requestValidationFollowup(followupParams(), guard), 'queued');
    assert.equal(enqueued.length, 1, 'the existing deterministic job is reused');
    assert.equal(comments.length, 1);
});

test('when a concurrent recovery delivered the follow-up first, only that invocation reports it', async () => {
    settings.validationFollowupEnabled = true;
    const guard = claims();
    const raced = { ...guard, completeClaim: async () => false };
    assert.equal(await requestValidationFollowup(followupParams(), raced), 'duplicate');
    assert.equal(enqueued.length, 1);
    assert.deepEqual([comments.length, history.length], [0, 0]);
});
