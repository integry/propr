import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, describe, test } from 'node:test';
import knex, { type Knex } from 'knex';
import { closeConnection, type BetterSqliteConnection } from '../src/db/connection.js';
import { up as createNotificationSchema } from '../src/db/migrations/20260802000000_create_notification_schema.js';
import { up as addNotificationPreferenceApis } from '../src/db/migrations/20260802010000_add_notification_preference_apis.js';
import { up as addProjectionState } from '../src/db/migrations/20260802020000_add_notification_projection_state.js';
import { NotificationProjectionService } from '../src/services/notificationProjectionService.js';
import { NotificationSystemProjection } from '../src/services/notificationSystemProjection.js';

const EVENT_TIME = '2026-08-02T08:00:00.000Z';
const SERVICE_TIME = '2026-08-02T16:00:00.000Z';

let database: Knex;
let projection: NotificationProjectionService;

function createDatabase(): Knex {
    return knex({
        client: 'better-sqlite3',
        connection: { filename: ':memory:' },
        useNullAsDefault: true,
        pool: {
            afterCreate(
                connection: BetterSqliteConnection,
                done: (error: Error | null, connection: BetterSqliteConnection) => void
            ) {
                connection.pragma('foreign_keys = ON');
                connection.pragma('recursive_triggers = ON');
                done(null, connection);
            }
        }
    });
}

async function createSourceTables(db: Knex): Promise<void> {
    await db.schema.createTable('tasks', (table) => {
        table.text('task_id').primary();
        table.text('repository').notNullable();
        table.integer('issue_number');
        table.integer('pr_number');
        table.text('task_type').notNullable().defaultTo('issue');
    });
    await db.schema.createTable('task_history', (table) => {
        table.increments('history_id').primary();
        table.text('task_id').notNullable();
        table.text('state').notNullable();
        table.text('timestamp').notNullable();
        table.text('metadata');
    });
    await db.schema.createTable('task_drafts', (table) => {
        table.text('draft_id').primary();
        table.text('repository').notNullable();
        table.text('user_id').notNullable();
        table.text('initial_prompt');
    });
    await db.schema.createTable('plan_issues', (table) => {
        table.increments('id').primary();
        table.text('draft_id').notNullable();
        table.text('repository').notNullable();
        table.integer('issue_number').notNullable();
        table.integer('pr_number');
        table.text('task_id');
    });
}

async function seedPlanAndTask(options: {
    taskId?: string;
    issueNumber?: number;
    prNumber?: number;
} = {}): Promise<void> {
    const taskId = options.taskId ?? 'task-1';
    const issueNumber = options.issueNumber ?? 1719;
    await database('task_drafts').insert({
        draft_id: 'draft-1',
        repository: 'integry/propr',
        user_id: 'user-1',
        initial_prompt: 'SECRET raw prompt must never enter a notification body'
    });
    await database('tasks').insert({
        task_id: taskId,
        repository: 'integry/propr',
        issue_number: issueNumber,
        pr_number: options.prNumber ?? null,
        task_type: 'issue'
    });
    await database('plan_issues').insert({
        draft_id: 'draft-1',
        repository: 'integry/propr',
        issue_number: issueNumber,
        pr_number: options.prNumber ?? null,
        task_id: taskId
    });
}

async function events() {
    return database('notification_events')
        .select('*')
        .orderBy('created_at', 'asc') as Promise<Array<Record<string, unknown>>>;
}

beforeEach(async () => {
    database = createDatabase();
    await createSourceTables(database);
    await createNotificationSchema(database);
    await addNotificationPreferenceApis(database);
    await addProjectionState(database);
    projection = new NotificationProjectionService({
        database,
        now: () => SERVICE_TIME,
        notificationService: undefined
    });
});

afterEach(async () => database.destroy());
after(async () => closeConnection());

describe('notification lifecycle projection', { concurrency: false }, () => {
    test('creates exactly one plan-ready event for a repeated review payload', async () => {
        await seedPlanAndTask();
        const payload = {
            eventType: 'draft:update' as const,
            draftId: 'draft-1',
            step: 'complete',
            status: 'completed' as const,
            draftStatus: 'review' as const,
            timestamp: EVENT_TIME
        };

        await projection.projectDraftUpdate(payload);
        await projection.projectDraftUpdate(payload);

        const stored = await events();
        assert.equal(stored.length, 1);
        assert.equal(stored[0].kind, 'plan');
        assert.equal(stored[0].title, 'Plan ready for review');
        assert.doesNotMatch(String(stored[0].body), /SECRET|raw prompt/i);
        assert.deepEqual(
            await database('notification_user_states').pluck('user_id'),
            ['user-1']
        );
    });

    test('creates distinct implementation and PR-attention events with a safe PR URL', async () => {
        await seedPlanAndTask({ prNumber: 1720 });
        const payload = {
            eventType: 'task:update' as const,
            taskId: 'task-1',
            state: 'completed',
            repository: 'integry/propr',
            issueNumber: 1719,
            timestamp: EVENT_TIME,
            metadata: {
                prNumber: 1720,
                prUrl: 'https://github.com/integry/propr/pull/1720?token=SECRET#logs',
                reason: 'raw stack trace SECRET'
            }
        };

        await projection.projectTaskUpdate(payload);
        await projection.projectTaskUpdate(payload);

        const stored = await events();
        assert.deepEqual(stored.map((event) => event.kind).sort(), ['pull_request', 'task']);
        const prEvent = stored.find((event) => event.kind === 'pull_request');
        assert.ok(prEvent);
        assert.match(String(prEvent.body), /https:\/\/github\.com\/integry\/propr\/pull\/1720/);
        assert.doesNotMatch(String(prEvent.body), /token=|SECRET|stack trace/);
        assert.equal(
            JSON.parse(String(prEvent.action_json)).href,
            'https://github.com/integry/propr/pull/1720'
        );
    });

    test('uses the review kind for completed reviews and does not emit implementation completion', async () => {
        await seedPlanAndTask({ taskId: 'review-task', issueNumber: 1720, prNumber: 1720 });
        await projection.projectTaskUpdate({
            eventType: 'task:update',
            taskId: 'review-task',
            state: 'completed',
            repository: 'integry/propr',
            issueNumber: 1720,
            timestamp: EVENT_TIME,
            metadata: { commandMode: 'review', prNumber: 1720 }
        });

        const stored = await events();
        assert.deepEqual(stored.map((event) => event.kind), ['review']);
        assert.equal(JSON.parse(String(stored[0].target_json)).prNumber, 1720);
    });

    test('tracks task and indexing activity and sanitizes failure bodies', async () => {
        await seedPlanAndTask();
        await projection.projectTaskUpdate({
            eventType: 'task:update',
            taskId: 'task-1',
            state: 'failed',
            repository: 'integry/propr',
            issueNumber: 1719,
            timestamp: EVENT_TIME,
            metadata: { reason: 'SECRET prompt and stack trace' }
        });
        const indexingPayload = {
            eventType: 'indexing:update' as const,
            repository: 'integry/propr',
            branch: 'main',
            phase: 'failed' as const,
            timestamp: '2026-08-02T08:01:00.000Z'
        };
        await projection.projectIndexingUpdate(indexingPayload);
        await projection.projectIndexingUpdate(indexingPayload);

        const stored = await events();
        assert.deepEqual(stored.map((event) => event.kind).sort(), ['indexing', 'task']);
        assert.ok(stored.every((event) => !/SECRET|stack trace|prompt/.test(String(event.body))));
        assert.deepEqual(
            await database('notification_source_activity')
                .select('activity_type', 'status')
                .orderBy('activity_type'),
            [
                { activity_type: 'indexing', status: 'failed' },
                { activity_type: 'task', status: 'failed' }
            ]
        );
    });

    test('emits one stalled event for each unchanged active transition', async () => {
        await seedPlanAndTask();
        await projection.projectTaskUpdate({
            eventType: 'task:update',
            taskId: 'task-1',
            state: 'processing',
            repository: 'integry/propr',
            issueNumber: 1719,
            timestamp: EVENT_TIME
        });

        await projection.detectStalledActivities(30 * 60 * 1000, '2026-08-02T09:00:00.000Z');
        await projection.detectStalledActivities(30 * 60 * 1000, '2026-08-02T09:05:00.000Z');
        assert.equal((await events()).length, 1);

        await projection.projectTaskUpdate({
            eventType: 'task:update',
            taskId: 'task-1',
            state: 'claude_execution',
            repository: 'integry/propr',
            issueNumber: 1719,
            timestamp: '2026-08-02T09:10:00.000Z'
        });
        await projection.detectStalledActivities(30 * 60 * 1000, '2026-08-02T09:45:00.000Z');
        assert.equal((await events()).length, 2);
    });
});

describe('system notification projection', { concurrency: false }, () => {
    test('deduplicates an outage and starts a new episode after recovery', async () => {
        await seedPlanAndTask();
        const systemProjection = new NotificationSystemProjection({
            database,
            now: () => SERVICE_TIME
        });

        await systemProjection.projectSnapshot({ redis: 'disconnected', timestamp: EVENT_TIME });
        await systemProjection.projectSnapshot({
            redis: 'disconnected',
            timestamp: '2026-08-02T08:01:00.000Z'
        });
        assert.equal((await events()).length, 1);

        await systemProjection.projectSnapshot({
            redis: 'connected',
            timestamp: '2026-08-02T08:02:00.000Z'
        });
        await systemProjection.projectSnapshot({
            redis: 'disconnected',
            timestamp: '2026-08-02T08:03:00.000Z'
        });

        const stored = await events();
        assert.equal(stored.length, 2);
        assert.ok(stored.every((event) => event.kind === 'system_failure'));
        assert.notEqual(stored[0].deduplication_key, stored[1].deduplication_key);
        assert.deepEqual(
            await database('notification_user_states').distinct('user_id').pluck('user_id'),
            ['user-1']
        );
    });
});
