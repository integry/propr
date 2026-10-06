import assert from 'node:assert/strict';
import { after, mock, test } from 'node:test';
import knex, { type Knex } from 'knex';
import { isDefaultRetryableError } from '../packages/core/src/utils/retryHandler.js';
import { up as addLineage } from '../packages/core/src/db/migrations/20261006000000_add_task_replacement_lineage.js';

await mock.module('@propr/core', { namedExports: { isDefaultRetryableError } });

const { createTaskReplacementService, PENDING_REPLACEMENT_RECOVERY_MS, REPLACEMENT_JOB_NAME } = await import('../src/taskReplacement/service.js');
const { createTaskReplacementStore, recordReplayableIssueTask } = await import('../src/taskReplacement/store.js');
const { isTransientProviderError, resolveMaxProviderReplacements, stopReasonExclusion, infraLostReplacementEnabled } = await import('../src/taskReplacement/policy.js');

type Enqueued = { jobName: string; data: Record<string, unknown>; jobId: string };
// Shared across harnesses: a restarted service still draws fresh identities.
let ids = 0;

const databases: Knex[] = [];
after(async () => { await Promise.all(databases.map(database => database.destroy())); });

async function createDatabase(): Promise<Knex> {
    const database = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
    databases.push(database);
    await database.schema.createTable('tasks', table => {
        table.string('task_id').primary();
        table.string('job_id').unique();
        table.string('correlation_id');
        table.string('repository').notNullable();
        table.integer('issue_number');
        table.string('task_type').notNullable();
        table.string('model_name');
        table.timestamp('created_at');
        table.json('initial_job_data');
    });
    await database.schema.createTable('task_history', table => {
        table.increments('history_id').primary();
        table.string('task_id').notNullable();
        table.string('state').notNullable();
        table.timestamp('timestamp').notNullable();
        table.text('reason');
        table.json('metadata');
    });
    await database.schema.createTable('llm_executions', table => {
        table.increments('execution_id').primary();
        table.string('task_id').notNullable();
        table.decimal('cost_usd', 10, 6);
    });
    await addLineage(database);
    return database;
}

const ISSUE_JOB = {
    repoOwner: 'integry', repoName: 'propr', number: 2739, agentAlias: 'claude', modelName: 'claude-opus-5-5',
    correlationId: 'original-correlation', triggeringLabel: 'AI', baseBranch: 'main', reasoningLevel: 'high',
    isChildJob: true, issuePayload: { large: true }, repoPayload: { large: true },
    repositoryWorkflow: { revision: 'sha' }, repositoryWorkflowDeferrals: 3, isRetryFromRateLimit: true,
};

async function seedTask(database: Knex, taskId: string, options: {
    state?: string; terminalReason?: string; taskType?: string; job?: Record<string, unknown> | null; branch?: string;
} = {}): Promise<void> {
    await database('tasks').insert({
        task_id: taskId, job_id: `job-${taskId}`, correlation_id: 'original-correlation', repository: 'integry/propr',
        issue_number: 2739, task_type: options.taskType ?? 'issue', model_name: 'claude-opus-5-5', created_at: '2026-10-06T08:00:00.000Z',
        initial_job_data: '{}', branch_name: options.branch ?? null,
    });
    if (options.job !== null) await recordReplayableIssueTask(database, taskId, { ...ISSUE_JOB, ...options.job } as never);
    await database('task_history').insert([
        { task_id: taskId, state: 'pending', timestamp: '2026-10-06T08:00:00.000Z', reason: 'created', metadata: '{}' },
        { task_id: taskId, state: 'claude_execution', timestamp: '2026-10-06T08:01:00.000Z', reason: 'started', metadata: '{}' },
    ]);
    if (options.state) await markState(database, taskId, options.state, options.terminalReason);
}

async function markState(database: Knex, taskId: string, state: string, terminalReason?: string): Promise<void> {
    await database('task_history').insert({
        task_id: taskId, state, timestamp: '2026-10-06T08:02:00.000Z', reason: `Task ${state}`,
        metadata: JSON.stringify(terminalReason ? { terminalReason } : {}),
    });
}

function harness(database: Knex, overrides: {
    maxProvider?: number; infraEnabled?: boolean; issueState?: string; enqueue?: (entry: Enqueued) => Promise<void>; now?: Date;
} = {}) {
    const enqueued: Enqueued[] = [];
    const comments: string[] = [];
    const published: Array<Record<string, unknown>> = [];
    const service = createTaskReplacementService({
        store: createTaskReplacementStore(database),
        async enqueue(jobName, data, jobId) {
            const entry = { jobName, data: data as unknown as Record<string, unknown>, jobId };
            await overrides.enqueue?.(entry);
            enqueued.push(entry);
        },
        loadMaxProviderReplacements: async () => overrides.maxProvider ?? 2,
        infraLostEnabled: () => overrides.infraEnabled ?? true,
        readIssueState: async () => ({ state: overrides.issueState ?? 'open' }),
        publishTaskUpdate: async payload => { published.push(payload); return true; },
        postIssueComment: async (_owner, _repo, _number, body) => { comments.push(body); },
        frontendUrl: 'https://propr.example',
        randomId: () => `replacement-correlation-${++ids}`,
        now: () => overrides.now ?? new Date('2026-10-06T09:00:00.000Z'),
    });
    return { service, enqueued, comments, published };
}

async function task(database: Knex, taskId: string): Promise<Record<string, unknown>> {
    return await database('tasks').where({ task_id: taskId }).first() as Record<string, unknown>;
}

async function events(database: Knex, taskId: string): Promise<Array<{ event: string; reason?: string; [key: string]: unknown }>> {
    const rows = await database('task_history').where({ task_id: taskId }).orderBy('history_id') as Array<{ metadata: string }>;
    return rows.map(row => JSON.parse(row.metadata ?? '{}')).filter(metadata => metadata.event);
}

test('an orphaned task gets exactly one replacement that reuses its selection and pushed branch', async () => {
    const database = await createDatabase();
    await seedTask(database, 'task-1', { branch: '2739/claude-opus-5-5-replacement-runs' });
    const { service, enqueued, published } = harness(database);

    const plan = await service.prepare({ taskId: 'task-1', cause: 'infra_lost' });
    assert.equal(plan.eligible, true);
    assert.equal((await task(database, 'task-1')).replacement_state, 'pending');
    await markState(database, 'task-1', 'failed');

    const outcome = await service.complete({ taskId: 'task-1', cause: 'infra_lost' });
    assert.equal(outcome.action, 'dispatched');
    const again = await service.complete({ taskId: 'task-1', cause: 'infra_lost' });
    assert.equal(again.action, 'none', 'the claim allows exactly one replacement');
    assert.equal(enqueued.length, 1);

    const [{ jobName, data, jobId }] = enqueued;
    assert.equal(jobName, REPLACEMENT_JOB_NAME);
    assert.match(jobId, /^issue-integry-propr-2739-replacement-[0-9a-f]{16}$/);
    assert.equal(data.agentAlias, 'claude');
    assert.equal(data.modelName, 'claude-opus-5-5');
    assert.equal(data.reasoningLevel, 'high', 'per-task overrides are kept');
    assert.equal(data.baseBranch, 'main');
    assert.equal(data.isChildJob, true);
    assert.equal(data.replacesTaskId, 'task-1');
    assert.equal(data.attemptNumber, 2);
    assert.equal(data.lineageRootTaskId, 'task-1');
    assert.equal(data.replacementCause, 'infra_lost');
    assert.equal(data.replacementBranch, '2739/claude-opus-5-5-replacement-runs');
    assert.match(String(data.correlationId), /^replacement-correlation-\d+$/, 'a fresh correlation gives the replacement its own task identity');
    for (const field of ['issuePayload', 'repoPayload', 'repositoryWorkflow', 'repositoryWorkflowDeferrals', 'isRetryFromRateLimit']) {
        assert.equal(field in data, false, `${field} is not replayed`);
    }

    const original = await task(database, 'task-1');
    assert.ok(outcome.action === 'dispatched');
    assert.equal(original.replaced_by_task_id, outcome.replacementTaskId);
    assert.equal(original.replacement_state, 'dispatched');
    const replacement = await task(database, outcome.replacementTaskId);
    assert.equal(replacement.replaces_task_id, 'task-1');
    assert.equal(replacement.attempt_number, 2);
    assert.equal(replacement.lineage_root_task_id, 'task-1');
    assert.equal(replacement.replacement_cause, 'infra_lost');
    assert.equal(replacement.job_id, jobId);
    assert.deepEqual((await events(database, 'task-1')).map(event => event.event), ['replacement.dispatched']);
    const latest = await database('task_history').where({ task_id: 'task-1' }).orderBy('history_id', 'desc').first();
    assert.equal(latest.state, 'failed', 'timeline events never change the task state');
    assert.deepEqual(published.map(({ taskId, state }) => ({ taskId, state })), [{ taskId: outcome.replacementTaskId, state: 'pending' }]);
});

test('a second orphaning of the same lineage is final and lists every attempt', async () => {
    const database = await createDatabase();
    await seedTask(database, 'task-1', { state: 'failed' });
    const { service, enqueued, comments } = harness(database);
    const first = await service.complete({ taskId: 'task-1', cause: 'infra_lost' });
    assert.ok(first.action === 'dispatched');
    const replacementId = first.replacementTaskId;
    await database('task_history').insert({ task_id: replacementId, state: 'processing', timestamp: '2026-10-06T09:01:00.000Z', reason: 'started', metadata: '{}' });

    const plan = await service.prepare({ taskId: replacementId, cause: 'infra_lost' });
    assert.equal(plan.eligible, false);
    await markState(database, replacementId, 'failed');
    const second = await service.complete({ taskId: replacementId, cause: 'infra_lost' });

    assert.deepEqual(second.action === 'skipped' && [second.reason, second.exhausted], ['cap_reached', true]);
    assert.equal(enqueued.length, 1);
    assert.equal((await task(database, replacementId)).replacement_state, 'exhausted');
    assert.deepEqual((await events(database, replacementId)).map(event => [event.event, event.reason]), [
        ['replacement.skipped', 'cap_reached'],
        ['replacement.exhausted', 'cap_reached'],
    ]);
    assert.equal(comments.length, 1);
    assert.match(comments[0], /after 2 attempts/);
    assert.match(comments[0], /1\. \[task-1\]\(https:\/\/propr\.example\/tasks\/task-1\) — failed/);
    assert.match(comments[0], new RegExp(`2\\. \\[${replacementId}\\]\\(https://propr\\.example/tasks/`));
});

test('user-cancelled, closed-issue, goal and stopped tasks are never replaced', async () => {
    const database = await createDatabase();
    await seedTask(database, 'cancelled', { state: 'cancelled', terminalReason: 'cancelled_by_user' });
    await seedTask(database, 'closed', { state: 'failed' });
    await seedTask(database, 'goal', { state: 'failed', taskType: 'goal' });
    await seedTask(database, 'stalled', { state: 'failed', terminalReason: 'timed_out' });
    const { service, enqueued } = harness(database);
    const closed = harness(database, { issueState: 'closed' });

    const reasons = [
        await service.complete({ taskId: 'cancelled', cause: 'infra_lost' }),
        await closed.service.complete({ taskId: 'closed', cause: 'infra_lost' }),
        await service.complete({ taskId: 'goal', cause: 'infra_lost' }),
        await service.complete({ taskId: 'stalled', cause: 'provider_transient' }),
        await service.complete({ taskId: 'closed', cause: 'provider_transient', terminalReason: 'cost_cap_exceeded' }),
    ].map(outcome => outcome.action === 'skipped' ? outcome.reason : outcome.action);

    assert.deepEqual(reasons, ['user_cancelled', 'issue_closed', 'goal_task', 'watchdog_stop', 'cost_cap_stop']);
    assert.equal(enqueued.length + closed.enqueued.length, 0);
    assert.deepEqual((await events(database, 'closed')).map(event => event.reason), ['issue_closed', 'cost_cap_stop']);
});

test('transient provider failures are replaced up to the cap, counted from durable stamps across restarts', async () => {
    const database = await createDatabase();
    await seedTask(database, 'task-1', { state: 'failed' });
    const chain = ['task-1'];
    for (let attempt = 0; attempt < 2; attempt++) {
        // A fresh service per failure simulates a daemon/worker restart between attempts.
        const { service } = harness(database, { maxProvider: 2 });
        const outcome = await service.complete({ taskId: chain.at(-1)!, cause: 'provider_transient', error: '529 Overloaded' });
        assert.ok(outcome.action === 'dispatched');
        assert.equal(outcome.attemptNumber, attempt + 2);
        chain.push(outcome.replacementTaskId);
        await markState(database, outcome.replacementTaskId, 'failed');
    }
    const { service, enqueued } = harness(database, { maxProvider: 2 });
    const final = await service.complete({ taskId: chain.at(-1)!, cause: 'provider_transient' });
    assert.deepEqual(final.action === 'skipped' && [final.reason, final.exhausted], ['cap_reached', true]);
    assert.equal(enqueued.length, 0);
    assert.deepEqual((await service.lineage(chain[1])).map(attempt => attempt.attemptNumber), [1, 2, 3]);

    const disabled = harness(database, { maxProvider: 0 });
    await seedTask(database, 'task-2', { state: 'failed' });
    const skipped = await disabled.service.complete({ taskId: 'task-2', cause: 'provider_transient' });
    assert.equal(skipped.action === 'skipped' && skipped.reason, 'disabled');
});

test('the replacement cost cap is the original cap minus what earlier attempts spent', async () => {
    const database = await createDatabase();
    await seedTask(database, 'task-1', { state: 'failed', job: { costCapUsd: 5 } });
    await database('llm_executions').insert([{ task_id: 'task-1', cost_usd: 1.25 }, { task_id: 'task-1', cost_usd: 0.75 }]);
    const { service, enqueued } = harness(database);
    const outcome = await service.complete({ taskId: 'task-1', cause: 'provider_transient' });
    assert.ok(outcome.action === 'dispatched');
    assert.equal(enqueued[0].data.costCapUsd, 3);

    const stored = JSON.parse(String((await task(database, outcome.replacementTaskId)).replay_job_data));
    assert.equal(stored.costCapUsd, 5, 'later attempts are budgeted from the original cap');
    await markState(database, outcome.replacementTaskId, 'failed');
    await database('llm_executions').insert({ task_id: outcome.replacementTaskId, cost_usd: 1 });
    const third = await service.complete({ taskId: outcome.replacementTaskId, cause: 'provider_transient' });
    assert.ok(third.action === 'dispatched');
    assert.equal(enqueued[1].data.costCapUsd, 2, 'cap minus everything the lineage spent');
    await markState(database, third.replacementTaskId, 'failed');
    await database('llm_executions').insert({ task_id: third.replacementTaskId, cost_usd: 2 });
    const spent = await harness(database, { maxProvider: 5 }).service.complete({ taskId: third.replacementTaskId, cause: 'provider_transient' });
    assert.deepEqual(spent.action === 'skipped' && [spent.reason, spent.exhausted], ['budget_exhausted', true]);
});

test('a replacement whose queue delivery is uncertain keeps its claim and is redelivered under the same job ID', async () => {
    const database = await createDatabase();
    await seedTask(database, 'task-1');
    const accepted: Enqueued[] = [];
    const claimedAt = new Date('2026-10-06T08:00:00.000Z');
    const { service, published } = harness(database, {
        now: claimedAt,
        // The queue accepts the job, but the response is lost with the connection.
        enqueue: async entry => { accepted.push(entry); throw new Error('Connection is closed.'); },
    });
    await service.prepare({ taskId: 'task-1', cause: 'provider_transient' });
    await markState(database, 'task-1', 'failed');
    const outcome = await service.complete({ taskId: 'task-1', cause: 'provider_transient' });
    assert.equal(outcome.action, 'delivery_pending');
    const replacementTaskId = outcome.action === 'delivery_pending' ? outcome.replacementTaskId : '';
    const original = await task(database, 'task-1');
    assert.equal(original.replaced_by_task_id, replacementTaskId, 'the claim is kept');
    assert.equal(original.replacement_state, 'pending', 'the decision stays recoverable');
    assert.equal(JSON.parse(String(original.replacement_request)).dispatch.jobId, accepted[0].jobId);
    assert.equal((await task(database, replacementTaskId)).job_id, accepted[0].jobId, 'the replacement row keeps its job ID');
    assert.deepEqual(await events(database, 'task-1'), [], 'no skip is recorded for a job the queue may run');
    assert.deepEqual(published, [], 'the held-back failure is not published as final');

    const later = harness(database, { now: new Date(claimedAt.getTime() + PENDING_REPLACEMENT_RECOVERY_MS + 1) });
    assert.deepEqual(await later.service.resumePending(), { resumed: 1, cleared: 0 });
    assert.deepEqual(later.enqueued.map(({ jobId, data }) => [jobId, data.correlationId]),
        [[accepted[0].jobId, accepted[0].data.correlationId]], 'redelivered under the same identity');
    assert.equal((await task(database, 'task-1')).replacement_state, 'dispatched');
    assert.equal((await database('tasks').count({ count: '*' }).first())?.count, 2, 'no second replacement is created');
});

async function markFinalizedBy(database: Knex, taskId: string, finalizedBy: string): Promise<void> {
    await database('task_history').insert({
        task_id: taskId, state: 'failed', timestamp: '2026-10-06T08:02:00.000Z', reason: 'Task execution failed',
        metadata: JSON.stringify({ finalizedBy }),
    });
}

test('an orphan decision pre-empted by another writer\'s failure is withdrawn by recovery, not dispatched', async () => {
    const database = await createDatabase();
    await seedTask(database, 'raced-task');
    await seedTask(database, 'orphaned-task');
    const earlier = harness(database, { now: new Date('2026-10-06T08:00:00.000Z') });
    const orphanRequest = { cause: 'infra_lost' as const, error: 'orphaned', finalizedBy: 'orphan_reconciliation' };
    assert.equal((await earlier.service.prepare({ taskId: 'raced-task', ...orphanRequest })).eligible, true);
    assert.equal((await earlier.service.prepare({ taskId: 'orphaned-task', ...orphanRequest })).eligible, true);
    // Another writer fails the raced task permanently; the reconciler's conditional finalization loses.
    await markState(database, 'raced-task', 'failed');
    await markFinalizedBy(database, 'orphaned-task', 'orphan_reconciliation');

    const direct = await earlier.service.complete({ taskId: 'raced-task', ...orphanRequest });
    assert.equal(direct.action, 'none', 'complete refuses a failure the decision was not made for');
    assert.equal((await task(database, 'raced-task')).replacement_state, null);
    assert.deepEqual(earlier.published.map(({ taskId, state }) => ({ taskId, state })), [{ taskId: 'raced-task', state: 'failed' }],
        'the held-back failure is published');

    // Recovery reaches the same verdict when the reconciler stopped before withdrawing.
    await database('tasks').where({ task_id: 'raced-task' }).update({
        replacement_state: 'pending',
        replacement_request: JSON.stringify({ cause: 'infra_lost', requestedAt: '2026-10-06T08:00:00.000Z', finalizedBy: 'orphan_reconciliation' }),
    });
    const later = harness(database, { now: new Date(Date.parse('2026-10-06T08:00:00.000Z') + PENDING_REPLACEMENT_RECOVERY_MS + 1) });
    assert.deepEqual(await later.service.resumePending(), { resumed: 1, cleared: 1 });
    assert.deepEqual(later.enqueued.map(({ data }) => data.replacesTaskId), ['orphaned-task'], 'only the confirmed orphan is replaced');
    assert.equal((await task(database, 'raced-task')).replaced_by_task_id, null);
    assert.equal((await task(database, 'raced-task')).replacement_state, null);
    assert.deepEqual(await later.service.resumePending(), { resumed: 0, cleared: 0 });
});

test('withdrawing an orphan decision never clears a claim or a newer decision', async () => {
    const database = await createDatabase();
    await seedTask(database, 'task-1');
    await seedTask(database, 'task-2');
    const { service } = harness(database);
    const orphanRequest = { cause: 'infra_lost' as const, finalizedBy: 'orphan_reconciliation' };
    const claimed = await service.prepare({ taskId: 'task-1', ...orphanRequest });
    await markFinalizedBy(database, 'task-1', 'orphan_reconciliation');
    assert.equal((await service.complete({ taskId: 'task-1', ...orphanRequest })).action, 'dispatched');
    assert.equal(await service.withdraw('task-1', claimed.eligible ? claimed.request! : assert.fail()), false);
    assert.notEqual((await task(database, 'task-1')).replaced_by_task_id, null);

    const superseded = await service.prepare({ taskId: 'task-2', ...orphanRequest });
    // A provider failure of the same task records its own decision afterwards.
    await harness(database, { now: new Date('2026-10-06T09:00:01.000Z') }).service.prepare({ taskId: 'task-2', cause: 'provider_transient' });
    assert.equal(await service.withdraw('task-2', superseded.eligible ? superseded.request! : assert.fail()), false);
    assert.equal((await task(database, 'task-2')).replacement_state, 'pending');
    assert.equal(JSON.parse(String((await task(database, 'task-2')).replacement_request)).cause, 'provider_transient');
});

test('a decision interrupted by a restart is completed by the recovery sweep', async () => {
    const database = await createDatabase();
    await seedTask(database, 'failed-task');
    await seedTask(database, 'completed-task');
    const earlier = harness(database, { now: new Date('2026-10-06T08:00:00.000Z') });
    await earlier.service.prepare({ taskId: 'failed-task', cause: 'infra_lost' });
    await earlier.service.prepare({ taskId: 'completed-task', cause: 'provider_transient' });
    await markState(database, 'failed-task', 'failed');
    await markState(database, 'completed-task', 'completed');

    const later = harness(database, { now: new Date(Date.parse('2026-10-06T08:00:00.000Z') + PENDING_REPLACEMENT_RECOVERY_MS + 1) });
    assert.deepEqual(await later.service.resumePending(), { resumed: 1, cleared: 1 });
    assert.equal(later.enqueued.length, 1);
    assert.equal(later.enqueued[0].data.replacesTaskId, 'failed-task');
    assert.equal((await task(database, 'completed-task')).replacement_state, null);
    assert.deepEqual(await later.service.resumePending(), { resumed: 0, cleared: 0 });
});

test('a replacement claimed before a restart is redelivered once under its persisted identity', async () => {
    const database = await createDatabase();
    await seedTask(database, 'task-1', { branch: '2739/claude-opus-5-5-replacement-runs' });
    const claimedAt = new Date('2026-10-06T08:00:00.000Z');
    const store = createTaskReplacementStore(database);
    const crashing = createTaskReplacementService({
        store: {
            ...store,
            async createReplacement(input) {
                assert.equal(await store.createReplacement(input), true);
                throw new Error('worker lost after the claim committed');
            },
        },
        enqueue: async () => { assert.fail('the crashed worker never reaches the queue'); },
        loadMaxProviderReplacements: async () => 2,
        infraLostEnabled: () => true,
        randomId: () => `replacement-correlation-${++ids}`,
        now: () => claimedAt,
    });
    await crashing.prepare({ taskId: 'task-1', cause: 'infra_lost', error: 'orphaned' });
    await markState(database, 'task-1', 'failed');
    await assert.rejects(crashing.complete({ taskId: 'task-1', cause: 'infra_lost', error: 'orphaned' }), /worker lost/);
    const claimed = await task(database, 'task-1');
    const replacementTaskId = String(claimed.replaced_by_task_id);
    const replacementRow = await task(database, replacementTaskId);
    assert.equal(claimed.replacement_state, 'pending', 'the claim alone does not release the decision');

    const early = harness(database, { now: new Date(claimedAt.getTime() + PENDING_REPLACEMENT_RECOVERY_MS - 1) });
    assert.deepEqual(await early.service.resumePending(), { resumed: 0, cleared: 0 }, 'a dispatch still in flight is left alone');

    let failDelivery = true;
    const later = harness(database, {
        now: new Date(claimedAt.getTime() + PENDING_REPLACEMENT_RECOVERY_MS + 1),
        enqueue: async () => { if (failDelivery) throw new Error('Redis unavailable'); },
    });
    assert.deepEqual(await later.service.resumePending(), { resumed: 0, cleared: 0 });
    assert.equal((await task(database, 'task-1')).replacement_state, 'pending', 'a failed redelivery stays recoverable');
    assert.equal((await task(database, 'task-1')).replaced_by_task_id, replacementTaskId);

    failDelivery = false;
    assert.deepEqual(await later.service.resumePending(), { resumed: 1, cleared: 0 });
    assert.equal(later.enqueued.length, 1);
    assert.equal(later.enqueued[0].jobName, REPLACEMENT_JOB_NAME);
    assert.equal(later.enqueued[0].jobId, replacementRow.job_id, 'the persisted job ID is reused');
    assert.equal(later.enqueued[0].data.correlationId, replacementRow.correlation_id);
    assert.equal(later.enqueued[0].data.replacesTaskId, 'task-1');
    assert.equal(later.enqueued[0].data.replacementBranch, '2739/claude-opus-5-5-replacement-runs');
    assert.equal((await task(database, 'task-1')).replacement_state, 'dispatched');
    assert.equal((await database('tasks').count({ count: '*' }).first())?.count, 2, 'no second replacement is created');
    assert.deepEqual((await events(database, 'task-1')).map(entry => [entry.event, entry.replacementTaskId]),
        [['replacement.dispatched', replacementTaskId]]);
    assert.deepEqual(later.published.map(({ taskId, state }) => ({ taskId, state })), [{ taskId: replacementTaskId, state: 'pending' }]);

    assert.deepEqual(await later.service.resumePending(), { resumed: 0, cleared: 0 });
    assert.equal(later.enqueued.length, 1, 'delivered exactly once');
});

test('a claimed replacement that already started is confirmed without queueing it again', async () => {
    const database = await createDatabase();
    await seedTask(database, 'task-1');
    const store = createTaskReplacementStore(database);
    const claimedAt = new Date('2026-10-06T08:00:00.000Z');
    const crashing = createTaskReplacementService({
        store: { ...store, async createReplacement(input) { await store.createReplacement(input); throw new Error('crash'); } },
        enqueue: async () => {},
        loadMaxProviderReplacements: async () => 2,
        infraLostEnabled: () => true,
        randomId: () => `replacement-correlation-${++ids}`,
        now: () => claimedAt,
    });
    await markState(database, 'task-1', 'failed');
    await assert.rejects(crashing.complete({ taskId: 'task-1', cause: 'provider_transient' }), /crash/);
    const replacementTaskId = String((await task(database, 'task-1')).replaced_by_task_id);
    await markState(database, replacementTaskId, 'claude_execution');

    const later = harness(database, { now: new Date(claimedAt.getTime() + PENDING_REPLACEMENT_RECOVERY_MS + 1) });
    assert.deepEqual(await later.service.resumePending(), { resumed: 1, cleared: 0 });
    assert.equal(later.enqueued.length, 0);
    assert.equal((await task(database, 'task-1')).replacement_state, 'dispatched');
    assert.deepEqual(later.published.map(({ taskId, state, metadata }) => [taskId, state, metadata?.replacementStarted]),
        [[replacementTaskId, 'claude_execution', true]], 'a running replacement is announced under its current state, not as pending');
});

async function crashAfterClaim(database: Knex, taskId: string, claimedAt: Date): Promise<string> {
    const store = createTaskReplacementStore(database);
    const crashing = createTaskReplacementService({
        store: { ...store, async createReplacement(input) { await store.createReplacement(input); throw new Error('worker lost after the claim committed'); } },
        enqueue: async () => { assert.fail('the crashed worker never reaches the queue'); },
        loadMaxProviderReplacements: async () => 2,
        infraLostEnabled: () => true,
        randomId: () => `replacement-correlation-${++ids}`,
        now: () => claimedAt,
    });
    await crashing.prepare({ taskId, cause: 'infra_lost', finalizedBy: 'orphan_reconciliation' });
    await markFinalizedBy(database, taskId, 'orphan_reconciliation');
    await assert.rejects(crashing.complete({ taskId, cause: 'infra_lost', finalizedBy: 'orphan_reconciliation' }), /worker lost/);
    return String((await task(database, taskId)).replaced_by_task_id);
}

test('a claimed replacement never delivered to the queue is reported as awaiting delivery until recovery delivers it', async () => {
    const database = await createDatabase();
    await seedTask(database, 'task-1');
    const claimedAt = new Date('2026-10-06T08:00:00.000Z');
    const replacementTaskId = await crashAfterClaim(database, 'task-1', claimedAt);
    const later = harness(database, { now: new Date(claimedAt.getTime() + PENDING_REPLACEMENT_RECOVERY_MS + 1) });

    assert.equal(await later.service.awaitingDelivery(replacementTaskId), true, 'reconciliation must not fail it as orphaned');
    assert.equal(await later.service.awaitingDelivery('task-1'), false, 'the original itself is an ordinary task');
    assert.deepEqual(await later.service.resumePending(), { resumed: 1, cleared: 0 });
    assert.equal(later.enqueued.length, 1);
    assert.equal(await later.service.awaitingDelivery(replacementTaskId), false, 'once delivered it is reconciled normally');
});

test('a reconciler-written failure of an undelivered replacement is not taken as delivery', async () => {
    const database = await createDatabase();
    await seedTask(database, 'task-1');
    const claimedAt = new Date('2026-10-06T08:00:00.000Z');
    const replacementTaskId = await crashAfterClaim(database, 'task-1', claimedAt);
    // Written before delivery was confirmed (e.g. by a worker that predates the delivery guard).
    await markFinalizedBy(database, replacementTaskId, 'orphan_reconciliation');

    const later = harness(database, { now: new Date(claimedAt.getTime() + PENDING_REPLACEMENT_RECOVERY_MS + 1) });
    assert.deepEqual(await later.service.resumePending(), { resumed: 1, cleared: 0 });
    assert.equal(later.enqueued.length, 0, 'a failed task is not re-queued');
    const original = await task(database, 'task-1');
    assert.equal(original.replacement_state, 'skipped', 'the original is not stamped dispatched');
    assert.deepEqual((await events(database, 'task-1')).map(entry => [entry.event, entry.reason]),
        [['replacement.skipped', 'replacement_not_started']]);
    assert.deepEqual(later.published.map(({ taskId, state, metadata }) => [taskId, state, metadata?.replacementSkipped]),
        [['task-1', 'failed', 'replacement_not_started']], 'the held-back failure is published');
    assert.deepEqual(await later.service.resumePending(), { resumed: 0, cleared: 0 });
});

test('a dispatch interrupted before its announcement keeps a recoverable publication obligation', async () => {
    const database = await createDatabase();
    await seedTask(database, 'task-1', { state: 'failed' });
    const claimedAt = new Date('2026-10-06T08:00:00.000Z');
    const enqueued: string[] = [];
    const interrupted = createTaskReplacementService({
        store: createTaskReplacementStore(database),
        enqueue: async (_name, _data, jobId) => { enqueued.push(jobId); },
        loadMaxProviderReplacements: async () => 2,
        infraLostEnabled: () => true,
        randomId: () => `replacement-correlation-${++ids}`,
        now: () => claimedAt,
        // The worker stops after queueing the job and recording the timeline event.
        publishTaskUpdate: async () => { throw new Error('worker lost before the announcement'); },
    });
    await assert.rejects(interrupted.complete({ taskId: 'task-1', cause: 'provider_transient' }), /worker lost/);
    const replacementTaskId = String((await task(database, 'task-1')).replaced_by_task_id);
    assert.equal((await task(database, 'task-1')).replacement_state, 'pending', 'queue delivery alone does not release the decision');

    const later = harness(database, { now: new Date(claimedAt.getTime() + PENDING_REPLACEMENT_RECOVERY_MS + 1) });
    assert.deepEqual(await later.service.resumePending(), { resumed: 1, cleared: 0 });
    assert.deepEqual(later.enqueued.map(entry => entry.jobId), enqueued, 're-adding the same job ID is harmless');
    assert.deepEqual(later.published.map(({ taskId, state, metadata }) => [taskId, state, metadata?.replacesTaskId]),
        [[replacementTaskId, 'pending', 'task-1']], 'the replacement is announced');
    assert.equal((await task(database, 'task-1')).replacement_state, 'dispatched');
    assert.deepEqual((await events(database, 'task-1')).map(entry => entry.event), ['replacement.dispatched'], 'the timeline event is recorded once');
    assert.deepEqual(await later.service.resumePending(), { resumed: 0, cleared: 0 });
});

test('provider classification follows withRetry, excluding 429, usage limits, credentials and run timeouts', () => {
    for (const error of ['API Error: 500 Internal server error', '529 {"type":"overloaded_error"}', 'Service Unavailable', new Error('socket hang up: ECONNRESET network error'), Object.assign(new Error('Bad gateway'), { status: 502 })]) {
        assert.equal(isTransientProviderError(error), true, String(error));
    }
    for (const error of ['429 Too Many Requests', 'rate limit exceeded', 'Claude usage limit reached', 'insufficient quota', 'authentication failed', 'TypeError: undefined is not a function', '', Object.assign(new Error('slow down'), { status: 429 })]) {
        assert.equal(isTransientProviderError(error), false, String(error));
    }
    assert.equal(isTransientProviderError('500 Internal server error', 'timeout'), false);
});

test('replacement configuration resolves the saved setting, then the environment, then the default', () => {
    assert.equal(resolveMaxProviderReplacements(undefined, {}), 2);
    assert.equal(resolveMaxProviderReplacements(undefined, { MAX_PROVIDER_REPLACEMENTS: '0' }), 0);
    assert.equal(resolveMaxProviderReplacements(4, { MAX_PROVIDER_REPLACEMENTS: '0' }), 4);
    assert.equal(resolveMaxProviderReplacements('bogus', { MAX_PROVIDER_REPLACEMENTS: '99' }), 2);
    assert.equal(infraLostReplacementEnabled({}), true);
    assert.equal(infraLostReplacementEnabled({ INFRA_LOST_REPLACEMENT: 'false' }), false);
    assert.equal(stopReasonExclusion('cancelled_issue_closed'), 'user_cancelled');
    assert.equal(stopReasonExclusion('pr_merged'), null);
    assert.equal(stopReasonExclusion('cost_cap'), 'cost_cap_stop', 'a run stopped at its cost cap is never replaced');
});
