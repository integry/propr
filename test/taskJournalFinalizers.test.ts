import assert from 'node:assert/strict';
import { after, beforeEach, mock, test } from 'node:test';
import knex from 'knex';
import { up as createJournal } from '../packages/core/src/db/migrations/20261112160000_create_repository_events.js';
import { up as addTaskDomain } from '../packages/core/src/db/migrations/20261114120000_add_task_repository_event_domain.js';

/**
 * The PR comment job completion path (BullMQ `completed` / `failed`
 * finalizers in src/jobs) ends follow-up tasks through the task state
 * manager, which journals the `task` events. Real finalizers and state
 * manager, SQLite journal, in-memory Redis.
 */
const database = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
const log = { info() {}, debug() {}, warn() {}, error() {}, withCorrelation: () => log };
const redisValues = new Map<string, string>();
await mock.module('ioredis', { namedExports: { Redis: function Redis() {
    return {
        setex: async (key: string, _ttl: number, value: string) => { redisValues.set(key, value); return 'OK'; },
        set: async (key: string, value: string) => {
            if (redisValues.has(key)) return null;
            redisValues.set(key, value); return 'OK';
        },
        get: async (key: string) => redisValues.get(key) ?? null,
        eval: async (_script: string, _keys: number, key: string, current: string, _ttl: number, next: string) => {
            if (redisValues.get(key) !== current) return 0;
            redisValues.set(key, next); return 1;
        },
        on: () => {}, quit: async () => {}, disconnect: () => {},
    };
} } });
await mock.module('../packages/core/src/db/connection.js', { namedExports: { db: database, closeConnection: async () => {} } });
await mock.module('../packages/core/src/utils/logger.js', { defaultExport: log, namedExports: { generateCorrelationId: () => 'corr' } });
await mock.module('../packages/core/src/utils/eventPublisher.js', { namedExports: {
    getEventPublisher: () => ({ publishTaskUpdate: async () => true, publishActivity: async () => true }),
} });
const { WorkerStateManager, TaskStates } = await import('../packages/core/src/utils/workerStateManager.js');
const { taskStateExpectation } = await import('../packages/core/src/utils/workerStateTransition.js');
// The finalizers only need these two values from the core package.
await mock.module('@propr/core', { namedExports: { TaskStates, taskStateExpectation } });
const { finalizeCompletedPRCommentTask, finalizeFailedPRCommentTask } = await import('../src/jobs/prCommentTaskFinalizer.js');
const { listRepositoryEvents } = await import('../packages/core/src/services/repositoryEventJournal.js');

await database.schema.createTable('tasks', table => {
    table.string('task_id').primary(); table.string('job_id').unique(); table.string('correlation_id'); table.string('repository');
    table.integer('issue_number'); table.string('task_type'); table.string('model_name'); table.timestamp('created_at'); table.text('initial_job_data');
});
await database.schema.createTable('task_history', table => {
    table.increments('history_id'); table.string('task_id'); table.string('state'); table.timestamp('timestamp');
    table.text('reason'); table.json('metadata');
});
await createJournal(database);
await addTaskDomain(database);

const manager = new WorkerStateManager({ keyPrefix: 'test:task-journal-finalizers:', stateExpiry: 3600 });
after(async () => { await manager.close(); await database.destroy(); });
beforeEach(async () => {
    for (const table of ['tasks', 'task_history', 'repository_events']) await database(table).delete();
    redisValues.clear();
});

const PROMPT = 'SENTINEL_FOLLOWUP_PROMPT_c41d';
async function startFollowUp(taskId: string): Promise<void> {
    await manager.createTaskStateIfAbsent(taskId, {
        number: 31, pullRequestNumber: 31, repoOwner: 'acme', repoName: 'app', type: 'pr-comment',
        agentAlias: 'claude', modelName: 'claude-sonnet-5-5', commentBody: PROMPT,
    } as never, null, `job-${taskId}`);
    await manager.updateTaskState(taskId, TaskStates.PROCESSING, { reason: `Processing ${PROMPT}` });
    await manager.updateTaskState(taskId, TaskStates.CLAUDE_EXECUTION, { reason: 'Agent running' });
}
const events = async () => (await listRepositoryEvents(database, { repository: 'acme/app', domains: ['task'] }));

test('a follow-up completed by the BullMQ completion finalizer journals queued, started, completed', async () => {
    await startFollowUp('pr-comments-31-a');
    const result = await finalizeCompletedPRCommentTask('pr-comments-31-a', { status: 'complete', reason: PROMPT } as never, manager);
    assert.equal(result.outcome, 'finalized');
    const journal = await events();
    assert.deepEqual(journal.map(event => event.type), ['queued', 'started', 'completed']);
    assert.ok(journal.every(event => event.prNumber === 31 && event.payload.kind === 'follow-up' && event.payload.taskId === 'pr-comments-31-a'));
    assert.equal(journal[2].payload.status, 'completed');
    assert.ok(!JSON.stringify(journal).includes(PROMPT));
});

test('a follow-up cancelled through its job result journals cancelled with the coded reason', async () => {
    await startFollowUp('pr-comments-31-b');
    await finalizeCompletedPRCommentTask('pr-comments-31-b', { status: 'cancelled', reason: 'cancelled_pr_closed' } as never, manager);
    const journal = await events();
    assert.deepEqual(journal.map(event => event.type), ['queued', 'started', 'cancelled']);
    assert.equal(journal[2].payload.terminalReason, 'cancelled_pr_closed');
});

test('a follow-up whose job failed journals failed with a failure category and no error text', async () => {
    await startFollowUp('pr-comments-31-c');
    await finalizeFailedPRCommentTask('pr-comments-31-c', new Error(`tool output: ${PROMPT}`), manager);
    const journal = await events();
    assert.deepEqual(journal.map(event => event.type), ['queued', 'started', 'failed']);
    assert.equal(journal[2].payload.failureCategory, 'worker');
    assert.ok(!JSON.stringify(journal).includes(PROMPT));
});

test('a requeued follow-up is a queue handoff, not a cancellation', async () => {
    await startFollowUp('pr-comments-31-d');
    await finalizeCompletedPRCommentTask('pr-comments-31-d', { status: 'requeued', reason: 'capacity' } as never, manager);
    assert.deepEqual((await events()).map(event => event.type), ['queued', 'started']);
});

test('the finalizer outcome is unchanged when the journal cannot be written', async () => {
    await database.schema.renameTable('repository_events', 'repository_events_away');
    try {
        await startFollowUp('pr-comments-31-e');
        const result = await finalizeCompletedPRCommentTask('pr-comments-31-e', { status: 'complete' } as never, manager);
        assert.equal(result.outcome, 'finalized');
        assert.equal((await manager.getTaskState('pr-comments-31-e'))?.state, TaskStates.COMPLETED);
    } finally {
        await database.schema.renameTable('repository_events_away', 'repository_events');
    }
});
