import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, describe, test } from 'node:test';
import knex, { type Knex } from 'knex';
import { closeConnection, type BetterSqliteConnection } from '../src/db/connection.js';
import { up as createNotificationSchema } from '../src/db/migrations/20260802000000_create_notification_schema.js';
import { up as addNotificationPreferenceApis } from '../src/db/migrations/20260802010000_add_notification_preference_apis.js';
import { up as addProjectionState } from '../src/db/migrations/20260802020000_add_notification_projection_state.js';
import { up as addIndexingTransitionIdentity } from '../src/db/migrations/20260802030000_add_indexing_transition_identity.js';
import { up as hardenNotificationProjection } from '../src/db/migrations/20260802040000_harden_notification_projection.js';
import { NotificationProjectionService } from '../src/services/notificationProjectionService.js';
import { NotificationService } from '../src/services/notificationService.js';
import { NotificationStalledDetector } from '../src/services/notificationStalledDetector.js';
import { NotificationSystemProjection } from '../src/services/notificationSystemProjection.js';
import { NotificationSystemSampler } from '../src/services/notificationSystemSampler.js';
import { EventPublisher } from '../src/utils/eventPublisher.js';
import type { TaskProjectionContext } from '../src/services/notificationProjectionStore.js';

const EVENT_TIME = '2026-08-02T08:00:00.000Z';
const SERVICE_TIME = '2026-08-02T16:00:00.000Z';

let database: Knex;
let projection: NotificationProjectionService;

async function grantRepositoryEntitlement(
    userId: string,
    repository = 'integry/propr'
): Promise<void> {
    await database('notification_repository_entitlements').insert({
        user_id: userId,
        repository,
        verified_at: EVENT_TIME,
        expires_at: '2026-08-03T08:00:00.000Z'
    }).onConflict(['user_id', 'repository']).merge();
}

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
        table.json('initial_job_data');
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
        table.text('status').notNullable().defaultTo('draft');
        table.text('updated_at').notNullable();
    });
    await db.schema.createTable('plan_issues', (table) => {
        table.increments('id').primary();
        table.text('draft_id').notNullable();
        table.text('repository').notNullable();
        table.integer('issue_number').notNullable();
        table.integer('pr_number');
        table.text('task_id');
    });
    await db.schema.createTable('system_configs', (table) => {
        table.text('key').primary();
        table.json('value').notNullable();
    });
    await db.schema.createTable('repositories', (table) => {
        table.text('full_name').notNullable();
        table.text('branch').notNullable();
        table.text('indexing_status').notNullable();
        table.text('updated_at').notNullable();
        table.unique(['full_name', 'branch']);
    });
}

async function seedPlanAndTask(options: {
    taskId?: string;
    issueNumber?: number;
    prNumber?: number;
} = {}): Promise<void> {
    const taskId = options.taskId ?? 'task-1';
    const issueNumber = options.issueNumber ?? 1719;
    await grantRepositoryEntitlement('user-1');
    await database('task_drafts').insert({
        draft_id: 'draft-1',
        repository: 'integry/propr',
        user_id: 'user-1',
        initial_prompt: 'SECRET raw prompt must never enter a notification body',
        status: 'review',
        updated_at: EVENT_TIME
    });
    await database('tasks').insert({
        task_id: taskId,
        repository: 'integry/propr',
        issue_number: issueNumber,
        pr_number: options.prNumber ?? null,
        task_type: 'issue',
        initial_job_data: null
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
    await addIndexingTransitionIdentity(database);
    await hardenNotificationProjection(database);
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

    test('uses the durable draft review transition when unrelated edits change updated_at', async () => {
        await seedPlanAndTask();
        await database('task_drafts').where({ draft_id: 'draft-1' }).update({
            review_transition_at: EVENT_TIME,
            updated_at: '2026-08-02T09:00:00.000Z'
        });
        const payload = {
            eventType: 'draft:update' as const,
            draftId: 'draft-1',
            step: 'complete',
            status: 'completed' as const,
            draftStatus: 'review' as const,
            timestamp: '2026-08-02T10:00:00.000Z'
        };

        await projection.projectDraftUpdate(payload);
        await database('task_drafts').where({ draft_id: 'draft-1' }).update({
            updated_at: '2026-08-02T11:00:00.000Z'
        });
        await projection.projectDraftUpdate({ ...payload, timestamp: '2026-08-02T11:00:00.000Z' });

        const stored = await events();
        assert.equal(stored.length, 1);
        assert.equal(JSON.parse(String(stored[0].metadata_json)).transitionAt, EVENT_TIME);
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
                prUrl: 'https://attacker.example/integry/propr/pull/1720?token=SECRET#logs',
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

    test('rolls back a task checkpoint when notification insertion fails and retries cleanly', async () => {
        await seedPlanAndTask();
        const payload = {
            eventType: 'task:update' as const,
            taskId: 'task-1',
            state: 'failed',
            repository: 'integry/propr',
            issueNumber: 1719,
            timestamp: EVENT_TIME
        };
        await database.raw(`
            CREATE TRIGGER fail_projected_notification
            BEFORE INSERT ON notification_events
            BEGIN
                SELECT RAISE(ABORT, 'injected notification failure');
            END
        `);

        await assert.rejects(projection.projectTaskUpdate(payload), /injected notification failure/);
        assert.equal(await database('notification_source_activity').count({ count: '*' }).first().then(row => Number(row?.count)), 0);
        await database.raw('DROP TRIGGER fail_projected_notification');

        await projection.projectTaskUpdate(payload);
        assert.equal((await events()).length, 1);
        assert.equal((await database('notification_source_activity').first()).status, 'failed');
    });

    test('rolls back completion and task activity when PR-attention insertion fails', async () => {
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
                prUrl: 'https://github.com/integry/propr/pull/1720'
            }
        };
        await database.raw(`
            CREATE TRIGGER fail_pr_attention_notification
            BEFORE INSERT ON notification_events
            WHEN NEW.kind = 'pull_request'
            BEGIN
                SELECT RAISE(ABORT, 'injected PR notification failure');
            END
        `);

        await assert.rejects(projection.projectTaskUpdate(payload), /injected PR notification failure/);
        assert.equal((await events()).length, 0);
        assert.equal(await database('notification_source_activity').count({ count: '*' }).first().then(row => Number(row?.count)), 0);
        await database.raw('DROP TRIGGER fail_pr_attention_notification');

        await projection.projectTaskUpdate(payload);
        assert.deepEqual((await events()).map(event => event.kind).sort(), ['pull_request', 'task']);
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

    test('classifies replayed review completion from durable task job data', async () => {
        await database('tasks').insert({
            task_id: 'durable-review-task',
            repository: 'integry/propr',
            issue_number: 1720,
            task_type: 'pr-comment',
            initial_job_data: JSON.stringify({ commandMode: 'review', pullRequestNumber: 1720 })
        });
        await database('task_drafts').insert({
            draft_id: 'review-owner-draft',
            repository: 'integry/propr',
            user_id: 'review-owner',
            status: 'review',
            updated_at: EVENT_TIME
        });
        await grantRepositoryEntitlement('review-owner');

        await projection.projectTaskUpdate({
            eventType: 'task:update',
            taskId: 'durable-review-task',
            state: 'completed',
            timestamp: EVENT_TIME
        });

        assert.deepEqual((await events()).map(event => event.kind), ['review']);
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
            transitionAt: '2026-08-02T08:01:00.000Z',
            runId: 'sanitized-failure-run',
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

    test('rolls back an indexing checkpoint when notification insertion fails', async () => {
        await seedPlanAndTask();
        await database.raw(`
            CREATE TRIGGER fail_indexing_notification
            BEFORE INSERT ON notification_events
            WHEN NEW.kind = 'indexing'
            BEGIN
                SELECT RAISE(ABORT, 'injected indexing notification failure');
            END
        `);
        const payload = {
            eventType: 'indexing:update' as const,
            repository: 'integry/propr',
            branch: 'main',
            phase: 'failed' as const,
            transitionAt: EVENT_TIME,
            runId: 'retryable-indexing-run',
            timestamp: EVENT_TIME
        };

        await assert.rejects(
            projection.projectIndexingUpdate(payload),
            /injected indexing notification failure/
        );
        assert.equal(
            await database('notification_source_activity')
                .where({ activity_type: 'indexing' })
                .count({ count: '*' })
                .first()
                .then((row) => Number(row?.count)),
            0
        );
        await database.raw('DROP TRIGGER fail_indexing_notification');

        await projection.projectIndexingUpdate(payload);
        assert.equal((await events()).length, 1);
        assert.equal(
            await database('notification_source_activity')
                .where({ activity_type: 'indexing', status: 'failed' })
                .count({ count: '*' })
                .first()
                .then((row) => Number(row?.count)),
            1
        );
    });

    test('fans repository activity only to authorized owners and repository subscribers', async () => {
        await database('tasks').insert({
            task_id: 'github-task',
            repository: 'integry/propr',
            issue_number: 1734,
            task_type: 'issue',
            initial_job_data: JSON.stringify({ userId: 'task-owner' })
        });
        await database('notification_preferences').insert({
            user_id: 'notification-subscriber',
            notification_kind: 'task'
        });
        await database('system_configs').insert({
            key: 'user_repo_prefs_repository-subscriber',
            value: JSON.stringify({ 'integry/propr': { starred: true } })
        });
        await grantRepositoryEntitlement('task-owner');
        await grantRepositoryEntitlement('repository-subscriber');
        await database('notification_repository_subscriptions').insert({
            user_id: 'repository-subscriber',
            repository: 'integry/propr',
            hidden: false,
            updated_at: EVENT_TIME
        });

        await projection.projectTaskUpdate({
            eventType: 'task:update',
            taskId: 'github-task',
            state: 'failed',
            repository: 'integry/propr',
            issueNumber: 1734,
            timestamp: EVENT_TIME
        });

        assert.deepEqual(
            (await database('notification_user_states').pluck('user_id')).sort(),
            ['repository-subscriber', 'task-owner']
        );

        await projection.projectIndexingUpdate({
            eventType: 'indexing:update',
            repository: 'integry/propr',
            branch: 'main',
            phase: 'failed',
            transitionAt: '2026-08-02T08:01:00.000Z',
            runId: 'repository-failure-run',
            timestamp: '2026-08-02T08:01:00.000Z'
        });
        const indexingRecipients = await database('notification_user_states as state')
            .join('notification_events as event', 'event.event_id', 'state.event_id')
            .where('event.kind', 'indexing')
            .pluck('state.user_id');
        assert.deepEqual(indexingRecipients.sort(), [
            'repository-subscriber'
        ]);
    });

    test('does not let preferences or historical rows establish repository access', async () => {
        await seedPlanAndTask();
        await database('task_drafts').insert({
            draft_id: 'revoked-user-draft',
            repository: 'integry/propr',
            user_id: 'revoked-user',
            initial_prompt: null,
            status: 'draft',
            updated_at: EVENT_TIME
        });
        await database('notification_repository_subscriptions').insert({
            user_id: 'revoked-user',
            repository: 'integry/propr',
            hidden: false,
            updated_at: EVENT_TIME
        });
        await database('notification_repository_entitlements').insert({
            user_id: 'revoked-user',
            repository: 'integry/propr',
            verified_at: EVENT_TIME,
            expires_at: '2026-08-02T12:00:00.000Z'
        });

        await projection.projectTaskUpdate({
            eventType: 'task:update',
            taskId: 'task-1',
            state: 'failed',
            repository: 'integry/propr',
            issueNumber: 1719,
            timestamp: EVENT_TIME
        });

        assert.deepEqual(await database('notification_user_states').pluck('user_id'), ['user-1']);
    });

    test('ignores out-of-order task and indexing transitions', async () => {
        await seedPlanAndTask();
        const latest = '2026-08-02T09:00:00.000Z';
        const stale = '2026-08-02T08:30:00.000Z';

        await projection.projectTaskUpdate({
            eventType: 'task:update',
            taskId: 'task-1',
            state: 'processing',
            repository: 'integry/propr',
            issueNumber: 1719,
            timestamp: latest
        });
        await projection.projectTaskUpdate({
            eventType: 'task:update',
            taskId: 'task-1',
            state: 'failed',
            repository: 'integry/propr',
            issueNumber: 1719,
            timestamp: stale
        });

        await projection.projectIndexingUpdate({
            eventType: 'indexing:update',
            repository: 'integry/propr',
            branch: 'main',
            phase: 'indexing',
            transitionAt: latest,
            runId: 'ordering-run',
            timestamp: latest
        });
        await projection.projectIndexingUpdate({
            eventType: 'indexing:update',
            repository: 'integry/propr',
            branch: 'main',
            phase: 'failed',
            transitionAt: stale,
            runId: 'ordering-run',
            timestamp: stale
        });

        assert.deepEqual(
            await database('notification_source_activity')
                .select('activity_type', 'status', 'last_activity_at', 'updated_at')
                .orderBy('activity_type'),
            [
                { activity_type: 'indexing', status: 'processing', last_activity_at: latest, updated_at: latest },
                { activity_type: 'task', status: 'processing', last_activity_at: latest, updated_at: latest }
            ]
        );
        assert.equal((await events()).length, 0);
    });

    test('uses the durable task-history timestamp across publisher retries', async () => {
        await grantRepositoryEntitlement('task-owner');
        await database('tasks').insert({
            task_id: 'retry-task',
            repository: 'integry/propr',
            issue_number: 1734,
            task_type: 'issue',
            initial_job_data: JSON.stringify({ userId: 'task-owner' })
        });
        await database('task_history').insert({
            task_id: 'retry-task',
            state: 'completed',
            timestamp: EVENT_TIME,
            metadata: JSON.stringify({})
        });
        const publicationTimes = [
            new Date('2026-08-02T08:01:00.000Z'),
            new Date('2026-08-02T08:02:00.000Z')
        ];
        const publisher = new EventPublisher({
            now: () => publicationTimes.shift()!,
            publish: async () => true,
            projectNotification: (payload) => projection.projectUpdate(payload),
            projectionDeadlineMs: 1000
        });

        await publisher.publishTaskUpdate({ taskId: 'retry-task', state: 'completed' });
        await publisher.publishTaskUpdate({ taskId: 'retry-task', state: 'completed' });

        const stored = await events();
        assert.equal(stored.length, 1);
        assert.equal(stored[0].occurred_at, EVENT_TIME);
        assert.deepEqual(await database('notification_user_states').pluck('user_id'), ['task-owner']);
    });

    test('orders legitimate same-millisecond task transitions by durable history id', async () => {
        await seedPlanAndTask();
        const [processingId] = await database('task_history').insert({
            task_id: 'task-1',
            state: 'processing',
            timestamp: EVENT_TIME,
            metadata: JSON.stringify({})
        });
        const [completedId] = await database('task_history').insert({
            task_id: 'task-1',
            state: 'completed',
            timestamp: EVENT_TIME,
            metadata: JSON.stringify({})
        });

        await projection.projectTaskUpdate({
            eventType: 'task:update',
            taskId: 'task-1',
            state: 'processing',
            timestamp: EVENT_TIME,
            metadata: { transitionSequence: processingId }
        });
        await projection.projectTaskUpdate({
            eventType: 'task:update',
            taskId: 'task-1',
            state: 'completed',
            timestamp: EVENT_TIME,
            metadata: { transitionSequence: completedId }
        });

        const activity = await database('notification_source_activity').first();
        assert.equal(activity.status, 'completed');
        assert.equal(JSON.parse(activity.metadata_json).sourceSequence, completedId);
        assert.deepEqual((await events()).map(event => event.kind), ['task']);
    });

    test('creates late PR-attention delivery for equal-transition metadata enrichment', async () => {
        await seedPlanAndTask();
        const [historyId] = await database('task_history').insert({
            task_id: 'task-1',
            state: 'completed',
            timestamp: EVENT_TIME,
            metadata: JSON.stringify({})
        });
        await projection.projectTaskUpdate({
            eventType: 'task:update',
            taskId: 'task-1',
            state: 'completed',
            timestamp: EVENT_TIME,
            metadata: { transitionSequence: historyId }
        });
        assert.deepEqual((await events()).map(event => event.kind), ['task']);

        await database('tasks').where({ task_id: 'task-1' }).update({ pr_number: 1720 });
        await database('task_history').where({ history_id: historyId }).update({
            metadata: JSON.stringify({
                prResult: {
                    prNumber: 1720,
                    prUrl: 'https://github.com/integry/propr/pull/1720'
                }
            })
        });
        await projection.projectTaskUpdate({
            eventType: 'task:update',
            taskId: 'task-1',
            state: 'completed',
            timestamp: '2026-08-02T08:05:00.000Z',
            metadata: {
                transitionAt: EVENT_TIME,
                transitionSequence: historyId,
                prNumber: 1720,
                prUrl: 'https://github.com/integry/propr/pull/1720'
            }
        });

        assert.deepEqual((await events()).map(event => event.kind).sort(), ['pull_request', 'task']);
    });

    test('does not let a regenerated indexing retry close a newer run', async () => {
        await seedPlanAndTask();
        await database('repositories').insert({
            full_name: 'integry/propr',
            branch: 'main',
            indexing_status: 'failed',
            indexing_transition_at: EVENT_TIME,
            indexing_run_id: 'run-old',
            updated_at: EVENT_TIME
        });
        await projection.projectIndexingUpdate({
            eventType: 'indexing:update',
            repository: 'integry/propr',
            branch: 'main',
            phase: 'failed',
            transitionAt: EVENT_TIME,
            runId: 'run-old',
            timestamp: '2026-08-02T08:01:00.000Z'
        });

        const newerRunAt = '2026-08-02T09:00:00.000Z';
        await database('repositories')
            .where({ full_name: 'integry/propr', branch: 'main' })
            .update({
                indexing_status: 'indexing',
                indexing_transition_at: newerRunAt,
                indexing_run_id: 'run-new',
                updated_at: newerRunAt
            });
        await projection.projectIndexingUpdate({
            eventType: 'indexing:update',
            repository: 'integry/propr',
            branch: 'main',
            phase: 'indexing',
            transitionAt: newerRunAt,
            runId: 'run-new',
            timestamp: newerRunAt
        });

        // This is the old failure republished with a newly generated publisher time.
        await projection.projectIndexingUpdate({
            eventType: 'indexing:update',
            repository: 'integry/propr',
            branch: 'main',
            phase: 'failed',
            transitionAt: EVENT_TIME,
            runId: 'run-old',
            timestamp: '2026-08-02T10:00:00.000Z'
        });

        const activities = await database('notification_source_activity')
            .select('status', 'last_activity_at')
            .where({ activity_type: 'indexing' })
            .orderBy('last_activity_at');
        assert.deepEqual(activities, [
            { status: 'failed', last_activity_at: '2026-08-02T08:01:00.000Z' },
            { status: 'processing', last_activity_at: newerRunAt }
        ]);
        assert.equal((await events()).length, 1);
    });

    test('does not let a delayed stop for an old indexing run cancel its replacement', async () => {
        await projection.projectIndexingUpdate({
            eventType: 'indexing:update', repository: 'integry/propr', branch: 'main',
            phase: 'files', transitionAt: EVENT_TIME, runId: 'stopped-run', timestamp: EVENT_TIME
        });
        await projection.projectIndexingUpdate({
            eventType: 'indexing:update', repository: 'integry/propr', branch: 'main',
            phase: 'indexing', transitionAt: '2026-08-02T09:00:00.000Z',
            runId: 'replacement-run', timestamp: '2026-08-02T09:00:00.000Z'
        });
        await projection.projectIndexingUpdate({
            eventType: 'indexing:update', repository: 'integry/propr', branch: 'main',
            phase: 'idle', transitionAt: '2026-08-02T08:30:00.000Z',
            runId: 'stopped-run', timestamp: '2026-08-02T10:00:00.000Z'
        });

        const activities = await database('notification_source_activity')
            .select('status', 'metadata_json')
            .where({ activity_type: 'indexing' });
        assert.deepEqual(
            activities.map((activity) => ({
                status: activity.status,
                runId: JSON.parse(String(activity.metadata_json)).runId as string
            })).sort((left, right) => left.runId.localeCompare(right.runId)),
            [
                { status: 'processing', runId: 'replacement-run' },
                { status: 'cancelled', runId: 'stopped-run' }
            ]
        );
    });

    test('uses indexing run identity for equal-millisecond transitions', async () => {
        await seedPlanAndTask();
        await projection.projectIndexingUpdate({
            eventType: 'indexing:update',
            repository: 'integry/propr',
            branch: 'main',
            phase: 'indexing',
            transitionAt: EVENT_TIME,
            runId: 'same-ms-run',
            timestamp: EVENT_TIME
        });
        await projection.projectIndexingUpdate({
            eventType: 'indexing:update',
            repository: 'integry/propr',
            branch: 'main',
            phase: 'failed',
            transitionAt: EVENT_TIME,
            runId: 'same-ms-run',
            timestamp: EVENT_TIME
        });

        const activity = await database('notification_source_activity').first();
        assert.equal(activity.status, 'failed');
        assert.deepEqual((await events()).map(event => event.kind), ['indexing']);
    });

    test('does not duplicate an indexing failure after unrelated repository updates', async () => {
        await seedPlanAndTask();
        await database('repositories').insert({
            full_name: 'integry/propr',
            branch: 'main',
            indexing_status: 'failed',
            indexing_transition_at: EVENT_TIME,
            indexing_run_id: 'stable-failure-run',
            updated_at: EVENT_TIME
        });
        const payload = {
            eventType: 'indexing:update' as const,
            repository: 'integry/propr',
            branch: 'main',
            phase: 'failed' as const,
            transitionAt: EVENT_TIME,
            runId: 'stable-failure-run',
            timestamp: '2026-08-02T08:01:00.000Z'
        };
        await projection.projectIndexingUpdate(payload);
        await database('repositories').where({ full_name: 'integry/propr', branch: 'main' }).update({
            updated_at: '2026-08-02T09:00:00.000Z'
        });
        await projection.projectIndexingUpdate({
            ...payload,
            timestamp: '2026-08-02T09:01:00.000Z'
        });

        assert.equal((await events()).length, 1);
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
        assert.equal(
            await database('notification_source_activity')
                .where({ activity_type: 'task', activity_key: 'task-1' })
                .first('stalled_notified_at')
                .then((row) => row?.stalled_notified_at),
            '2026-08-02T09:00:00.000Z'
        );

        await projection.projectTaskUpdate({
            eventType: 'task:update',
            taskId: 'task-1',
            state: 'claude_execution',
            repository: 'integry/propr',
            issueNumber: 1719,
            timestamp: '2026-08-02T09:10:00.000Z'
        });
        const updatedActivity = await database('notification_source_activity')
            .select('last_activity_at', 'updated_at')
            .where({ activity_type: 'task', activity_key: 'task-1' })
            .first();
        assert.equal(updatedActivity.last_activity_at, '2026-08-02T09:10:00.000Z');
        assert.notEqual(updatedActivity.updated_at, EVENT_TIME);
        await projection.detectStalledActivities(30 * 60 * 1000, '2026-08-02T09:45:00.000Z');
        assert.equal((await events()).length, 2);

        await projection.projectIndexingUpdate({
            eventType: 'indexing:update',
            repository: 'integry/propr',
            branch: 'main',
            phase: 'files',
            transitionAt: '2026-08-02T10:00:00.000Z',
            runId: 'stalled-indexing-run',
            timestamp: '2026-08-02T10:00:00.000Z'
        });
        await projection.detectStalledActivities(30 * 60 * 1000, '2026-08-02T10:31:00.000Z');
        assert.equal((await events()).length, 3);
    });

    test('uses live-details heartbeats and keeps stalled task navigation context', async () => {
        await seedPlanAndTask({ prNumber: 1720 });
        await projection.projectTaskUpdate({
            eventType: 'task:update',
            taskId: 'task-1',
            state: 'claude_execution',
            repository: 'integry/propr',
            issueNumber: 1719,
            timestamp: EVENT_TIME,
            metadata: { prNumber: 1720 }
        });
        await projection.projectTaskHeartbeat({
            eventType: 'task:live:update',
            taskId: 'task-1',
            events: [],
            todos: [],
            currentTask: 'still working',
            tokenUsage: null,
            timestamp: '2026-08-02T08:45:00.000Z'
        });

        await projection.detectStalledActivities(30 * 60 * 1000, '2026-08-02T09:00:00.000Z');
        assert.equal((await events()).length, 0);
        await projection.detectStalledActivities(30 * 60 * 1000, '2026-08-02T09:20:00.000Z');

        const [event] = await events();
        assert.equal(JSON.parse(String(event.target_json)).prNumber, 1720);
        assert.equal(JSON.parse(String(event.action_json)).href, '/tasks/task-1');
    });

    test('does not treat process liveness as observable task progress', async () => {
        await seedPlanAndTask();
        await projection.projectTaskUpdate({
            eventType: 'task:update',
            taskId: 'task-1',
            state: 'processing',
            repository: 'integry/propr',
            issueNumber: 1719,
            timestamp: EVENT_TIME
        });
        await projection.projectTaskHeartbeat({
            eventType: 'task:live:update',
            taskId: 'task-1',
            events: [],
            todos: [],
            currentTask: null,
            tokenUsage: null,
            activityKind: 'process_liveness',
            timestamp: '2026-08-02T08:45:00.000Z'
        });

        const activity = await database('notification_source_activity')
            .where({ activity_type: 'task', activity_key: 'task-1' })
            .first('last_activity_at', 'process_heartbeat_at');
        assert.equal(activity.last_activity_at, EVENT_TIME);
        assert.equal(activity.process_heartbeat_at, '2026-08-02T08:45:00.000Z');

        await projection.detectStalledActivities(30 * 60 * 1000, '2026-08-02T08:31:00.000Z');
        assert.equal((await events()).length, 1);
    });

    test('atomically rejects stalled claims changed by a heartbeat or completion during discovery', async () => {
        await seedPlanAndTask();
        await database('tasks').insert({
            task_id: 'task-2',
            repository: 'integry/propr',
            issue_number: 1720,
            task_type: 'issue',
            initial_job_data: JSON.stringify({ userId: 'user-1' })
        });
        for (const taskId of ['task-1', 'task-2']) {
            await projection.projectTaskUpdate({
                eventType: 'task:update',
                taskId,
                state: 'processing',
                repository: 'integry/propr',
                issueNumber: taskId === 'task-1' ? 1719 : 1720,
                timestamp: EVENT_TIME
            });
        }

        const mutableProjection = projection as unknown as {
            store: {
                getTaskRecipients(context: TaskProjectionContext): Promise<string[]>;
            };
        };
        const originalGetTaskRecipients = mutableProjection.store.getTaskRecipients.bind(
            mutableProjection.store
        );
        mutableProjection.store.getTaskRecipients = async (context) => {
            if (context.taskId === 'task-1') {
                await projection.projectTaskHeartbeat({
                    eventType: 'task:live:update',
                    taskId: context.taskId,
                    events: [],
                    todos: [],
                    currentTask: 'new progress',
                    tokenUsage: null,
                    timestamp: '2026-08-02T09:01:00.000Z'
                });
            } else {
                await database('notification_source_activity')
                    .where({ activity_type: 'task', activity_key: context.taskId })
                    .update({
                        status: 'completed',
                        last_activity_at: '2026-08-02T09:01:00.000Z',
                        completed_at: '2026-08-02T09:01:00.000Z'
                    });
            }
            return originalGetTaskRecipients(context);
        };

        const claimed = await projection.detectStalledActivities(
            30 * 60 * 1000,
            '2026-08-02T09:00:00.000Z'
        );

        assert.equal(claimed, 0);
        assert.equal((await events()).length, 0);
        assert.deepEqual(
            await database('notification_source_activity')
                .whereIn('activity_key', ['task-1', 'task-2'])
                .pluck('stalled_notified_at'),
            [null, null]
        );
    });

    test('does not let a later liveness observation suppress queued terminal transitions', async () => {
        await seedPlanAndTask();
        const [processingSequence] = await database('task_history').insert({
            task_id: 'task-1',
            state: 'processing',
            timestamp: EVENT_TIME,
            metadata: '{}'
        });
        await projection.projectTaskUpdate({
            eventType: 'task:update',
            taskId: 'task-1',
            state: 'processing',
            repository: 'integry/propr',
            issueNumber: 1719,
            metadata: { transitionSequence: processingSequence },
            timestamp: EVENT_TIME
        });
        await projection.projectTaskHeartbeat({
            eventType: 'task:live:update',
            taskId: 'task-1',
            events: [],
            todos: [],
            currentTask: null,
            tokenUsage: null,
            timestamp: '2026-08-02T08:31:00.000Z'
        });
        const [completionSequence] = await database('task_history').insert({
            task_id: 'task-1',
            state: 'completed',
            timestamp: '2026-08-02T08:30:00.000Z',
            metadata: '{}'
        });
        await projection.projectTaskUpdate({
            eventType: 'task:update',
            taskId: 'task-1',
            state: 'completed',
            repository: 'integry/propr',
            issueNumber: 1719,
            metadata: {
                transitionAt: '2026-08-02T08:30:00.000Z',
                transitionSequence: completionSequence
            },
            timestamp: '2026-08-02T08:30:00.000Z'
        });

        assert.equal((await events()).length, 1);
        assert.deepEqual(
            await database('notification_source_activity')
                .select('status', 'last_activity_at', 'completed_at')
                .where({ activity_type: 'task', activity_key: 'task-1' })
                .first(),
            {
                status: 'completed',
                last_activity_at: '2026-08-02T08:31:00.000Z',
                completed_at: '2026-08-02T08:31:00.000Z'
            }
        );

        await projection.projectIndexingUpdate({
            eventType: 'indexing:update',
            repository: 'integry/propr',
            branch: 'main',
            phase: 'files',
            transitionAt: EVENT_TIME,
            runId: 'liveness-race-run',
            timestamp: '2026-08-02T08:31:00.000Z'
        });
        await projection.projectIndexingUpdate({
            eventType: 'indexing:update',
            repository: 'integry/propr',
            branch: 'main',
            phase: 'failed',
            transitionAt: '2026-08-02T08:30:00.000Z',
            runId: 'liveness-race-run',
            timestamp: '2026-08-02T08:30:00.000Z'
        });
        assert.equal((await events()).length, 2);
        assert.deepEqual(
            await database('notification_source_activity')
                .select('status', 'last_activity_at', 'completed_at')
                .where({ activity_type: 'indexing' })
                .first(),
            {
                status: 'failed',
                last_activity_at: '2026-08-02T08:31:00.000Z',
                completed_at: '2026-08-02T08:31:00.000Z'
            }
        );
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

    test('keeps unhealthy status changes in one episode and fans out to all known users', async () => {
        await seedPlanAndTask();
        await database('notification_preferences').insert({
            user_id: 'user-2',
            notification_kind: 'system_failure'
        });
        const systemProjection = new NotificationSystemProjection({ database });

        await systemProjection.projectSnapshot({
            daemon: 'failed',
            timestamp: EVENT_TIME
        }, ['polling-user']);
        await systemProjection.projectSnapshot({
            daemon: 'stopped',
            timestamp: '2026-08-02T08:01:00.000Z'
        }, ['different-polling-user']);

        assert.equal((await events()).length, 1);
        assert.deepEqual(
            (await database('notification_user_states').pluck('user_id')).sort(),
            ['different-polling-user', 'polling-user', 'user-1', 'user-2']
        );
        assert.deepEqual(
            await database('notification_system_health')
                .select('status', 'transition_at', 'updated_at')
                .where({ component: 'daemon' })
                .first(),
            {
                status: 'stopped',
                transition_at: EVENT_TIME,
                updated_at: '2026-08-02T08:01:00.000Z'
            }
        );
    });

    test('rolls back a system transition when its outage notification fails', async () => {
        await seedPlanAndTask();
        const systemProjection = new NotificationSystemProjection({ database });
        await database.raw(`
            CREATE TRIGGER fail_system_notification
            BEFORE INSERT ON notification_events
            BEGIN
                SELECT RAISE(ABORT, 'injected system notification failure');
            END
        `);

        await assert.rejects(
            systemProjection.projectSnapshot({ redis: 'disconnected', timestamp: EVENT_TIME }),
            /injected system notification failure/
        );
        assert.equal(await database('notification_system_health').count({ count: '*' }).first().then(row => Number(row?.count)), 0);
        await database.raw('DROP TRIGGER fail_system_notification');

        await systemProjection.projectSnapshot({ redis: 'disconnected', timestamp: EVENT_TIME });
        assert.equal((await events()).length, 1);
    });

    test('rolls back a system notification when lease ownership is lost during insertion', async () => {
        await seedPlanAndTask();
        const notificationService = new NotificationService({ database });
        const createEvent = notificationService.createNotificationEventInTransaction.bind(notificationService);
        let leaseOwned = true;
        notificationService.createNotificationEventInTransaction = async (...args) => {
            const result = await createEvent(...args);
            leaseOwned = false;
            return result;
        };
        const systemProjection = new NotificationSystemProjection({ database, notificationService });

        await assert.rejects(
            systemProjection.projectSnapshot(
                { redis: 'disconnected', timestamp: EVENT_TIME },
                [],
                () => leaseOwned
            ),
            /lease was lost/
        );

        assert.equal((await events()).length, 0);
        assert.equal(
            await database('notification_system_health').count({ count: '*' }).first()
                .then((row) => Number(row?.count)),
            0
        );
    });

    test('advances the system observation high-water mark for unchanged states', async () => {
        const systemProjection = new NotificationSystemProjection({ database });
        await systemProjection.projectSnapshot({
            daemon: 'running',
            timestamp: EVENT_TIME
        });
        await systemProjection.projectSnapshot({
            daemon: 'running',
            timestamp: '2026-08-02T10:00:00.000Z'
        });
        await systemProjection.projectSnapshot({
            daemon: 'stopped',
            timestamp: '2026-08-02T09:00:00.000Z'
        });

        assert.equal((await events()).length, 0);
        assert.deepEqual(
            await database('notification_system_health')
                .select('status', 'transition_at', 'updated_at')
                .where({ component: 'daemon' })
                .first(),
            {
                status: 'running',
                transition_at: EVENT_TIME,
                updated_at: '2026-08-02T10:00:00.000Z'
            }
        );
    });

    test('does not manufacture outages for unknown future component states', async () => {
        const systemProjection = new NotificationSystemProjection({ database });
        await systemProjection.projectSnapshot({
            daemon: 'warming-up',
            agentRuntime: { unifiedAgentImage: { status: 'building' } },
            timestamp: EVENT_TIME
        });

        assert.equal((await events()).length, 0);
        assert.deepEqual(
            await database('notification_system_health')
                .select('component', 'status', 'healthy', 'updated_at')
                .orderBy('component'),
            [
                { component: 'agent-runtime', status: 'building', healthy: 1, updated_at: EVENT_TIME },
                { component: 'daemon', status: 'unknown', healthy: 1, updated_at: EVENT_TIME }
            ]
        );

        await systemProjection.projectSnapshot({
            daemon: 'stopped',
            timestamp: '2026-08-02T07:59:00.000Z'
        });
        assert.equal((await events()).length, 0);
    });
});

describe('notification projection schedulers', { concurrency: false }, () => {
    test('bounds notification projection latency on the publication path', async () => {
        let projectionStarted = false;
        const publisher = new EventPublisher({
            publish: async () => true,
            projectNotification: async () => {
                projectionStarted = true;
                await new Promise<void>(() => undefined);
            },
            projectionDeadlineMs: 10
        });
        const startedAt = Date.now();

        await publisher.publishTaskUpdate({ taskId: 'slow-projection', state: 'processing' });

        assert.equal(projectionStarted, true);
        assert.ok(Date.now() - startedAt < 500);
    });

    test('drains tracked in-flight EventPublisher projections during shutdown', async () => {
        let releaseProjection!: () => void;
        let markStarted!: () => void;
        const started = new Promise<void>(resolve => { markStarted = resolve; });
        const publisher = new EventPublisher({
            publish: async () => true,
            projectNotification: async () => {
                markStarted();
                await new Promise<void>(resolve => { releaseProjection = resolve; });
            },
            projectionDeadlineMs: 10,
            projectionConcurrency: 1,
            projectionMaxQueueSize: 2
        });

        await publisher.publishTaskUpdate({ taskId: 'drained-projection', state: 'processing' });
        await started;
        let closed = false;
        const close = publisher.close().then(() => { closed = true; });
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(closed, false);
        releaseProjection();
        await close;
        assert.equal(closed, true);
    });

    test('caps queued EventPublisher projection work under contention', async () => {
        let release!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        let projected = 0;
        const publisher = new EventPublisher({
            publish: async () => true,
            projectNotification: async () => { projected++; await gate; },
            projectionDeadlineMs: 5,
            projectionConcurrency: 1,
            projectionMaxQueueSize: 2
        });

        await publisher.publishTaskUpdate({ taskId: 'queued-1', state: 'processing' });
        await publisher.publishTaskUpdate({ taskId: 'queued-2', state: 'processing' });
        await publisher.publishTaskUpdate({ taskId: 'dropped-at-capacity', state: 'processing' });
        release();
        await publisher.close();

        assert.equal(projected, 2);
    });

    test('prioritizes terminal projections when low-value work fills the queue', async () => {
        let release!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        const projected: string[] = [];
        const publisher = new EventPublisher({
            publish: async () => true,
            projectNotification: async (payload) => {
                if (payload.eventType !== 'task:update') return;
                projected.push(`${payload.taskId}:${payload.state}`);
                if (payload.taskId === 'active-low-priority') await gate;
            },
            projectionDeadlineMs: 5,
            projectionConcurrency: 1,
            projectionMaxQueueSize: 2
        });

        await publisher.publishTaskUpdate({ taskId: 'active-low-priority', state: 'processing' });
        await publisher.publishTaskUpdate({ taskId: 'queued-low-priority', state: 'processing' });
        await publisher.publishTaskUpdate({ taskId: 'terminal', state: 'completed' });
        release();
        await publisher.close();

        assert.deepEqual(projected, [
            'active-low-priority:processing',
            'terminal:completed'
        ]);
    });

    test('retains terminal work without exceeding projector concurrency', async () => {
        let release!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        let active = 0;
        let maxActive = 0;
        const projected: string[] = [];
        const publisher = new EventPublisher({
            publish: async () => true,
            projectNotification: async (payload) => {
                if (payload.eventType !== 'task:update') return;
                active++;
                maxActive = Math.max(maxActive, active);
                projected.push(`${payload.taskId}:${payload.state}`);
                if (payload.taskId === 'active-at-capacity') await gate;
                active--;
            },
            projectionDeadlineMs: 5,
            projectionConcurrency: 1,
            projectionMaxQueueSize: 1
        });

        await publisher.publishTaskUpdate({ taskId: 'active-at-capacity', state: 'processing' });
        await publisher.publishTaskUpdate({ taskId: 'terminal-overflow', state: 'failed' });
        release();
        await publisher.close();

        assert.equal(maxActive, 1);
        assert.deepEqual(projected, [
            'active-at-capacity:processing',
            'terminal-overflow:failed'
        ]);
    });

    test('does not coalesce observable task progress into process-only liveness', async () => {
        let release!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        const projectedKinds: string[] = [];
        const publisher = new EventPublisher({
            publish: async () => true,
            projectNotification: async (payload) => {
                if (payload.eventType === 'task:update') await gate;
                if (payload.eventType === 'task:live:update') {
                    projectedKinds.push(payload.activityKind ?? 'progress');
                }
            },
            projectionDeadlineMs: 5,
            projectionConcurrency: 1,
            projectionMaxQueueSize: 3
        });

        await publisher.publishTaskUpdate({ taskId: 'queue-blocker', state: 'processing' });
        await publisher.projectTaskProgress('output-producing-task');
        await publisher.projectTaskHeartbeat('output-producing-task');
        release();
        await publisher.close();

        assert.deepEqual(projectedKinds, ['progress']);
    });

    test('bounds EventPublisher shutdown when a projection never settles', async () => {
        const publisher = new EventPublisher({
            publish: async () => true,
            projectNotification: async () => new Promise<void>(() => undefined),
            projectionDeadlineMs: 5,
            projectionDrainTimeoutMs: 10
        });
        await publisher.publishTaskUpdate({ taskId: 'stuck-projection', state: 'processing' });
        const startedAt = Date.now();

        await publisher.close();

        assert.ok(Date.now() - startedAt < 500);
    });

    test('samples system health without a status-route request', async () => {
        await seedPlanAndTask();
        const sampler = new NotificationSystemSampler({
            getSnapshot: async () => ({ redis: 'disconnected', timestamp: EVENT_TIME }),
            projector: new NotificationSystemProjection({ database }),
            intervalMs: 60_000
        });

        assert.equal(await sampler.runOnce(), true);
        assert.equal((await events()).length, 1);
        assert.deepEqual(await database('notification_user_states').pluck('user_id'), ['user-1']);
    });

    test('honors startup grace before taking the first system-health sample', async () => {
        let samples = 0;
        let sampled!: () => void;
        const firstSample = new Promise<void>(resolve => { sampled = resolve; });
        const sampler = new NotificationSystemSampler({
            getSnapshot: async () => {
                samples++;
                sampled();
                return { redis: 'connected', timestamp: EVENT_TIME };
            },
            projector: { projectSnapshot: async () => undefined },
            intervalMs: 60_000,
            startupGraceMs: 25,
            operationTimeoutMs: 100
        });

        sampler.start();
        await new Promise(resolve => setTimeout(resolve, 5));
        assert.equal(samples, 0);
        await Promise.race([
            firstSample,
            new Promise<never>((_resolve, reject) => setTimeout(
                () => reject(new Error('startup-grace sample did not run')),
                500
            ))
        ]);
        assert.equal(samples, 1);
        await sampler.stop();
    });

    test('releases active-run ownership when a system-health probe never settles', async () => {
        let attempts = 0;
        const sampler = new NotificationSystemSampler({
            getSnapshot: async () => {
                attempts++;
                return new Promise<never>(() => undefined);
            },
            projector: { projectSnapshot: async () => undefined },
            intervalMs: 60_000,
            operationTimeoutMs: 10
        });
        const startedAt = Date.now();

        assert.equal(await sampler.runOnce(), false);
        assert.equal(await sampler.runOnce(), false);

        assert.equal(attempts, 2);
        assert.ok(Date.now() - startedAt < 500);
    });

    test('renews and releases the replica lease during a slow system scan', async () => {
        let renewals = 0;
        let releases = 0;
        const sampler = new NotificationSystemSampler({
            getSnapshot: async () => {
                await new Promise(resolve => setTimeout(resolve, 30));
                return { redis: 'connected', timestamp: EVENT_TIME };
            },
            projector: { projectSnapshot: async () => undefined },
            intervalMs: 60_000,
            acquireLease: async () => ({
                renewalIntervalMs: 5,
                renew: async () => { renewals++; return true; },
                release: async () => { releases++; }
            })
        });

        assert.equal(await sampler.runOnce(), true);
        assert.ok(renewals >= 2);
        assert.equal(releases, 1);
    });

    test('abandons a sampled snapshot after losing the replica lease', async () => {
        let projected = 0;
        let releases = 0;
        const sampler = new NotificationSystemSampler({
            getSnapshot: async () => ({ redis: 'disconnected', timestamp: EVENT_TIME }),
            projector: { projectSnapshot: async () => { projected++; } },
            intervalMs: 60_000,
            acquireLease: async () => ({
                renewalIntervalMs: 60_000,
                renew: async () => false,
                release: async () => { releases++; }
            })
        });

        assert.equal(await sampler.runOnce(), false);
        assert.equal(projected, 0);
        assert.equal(releases, 1);
    });

    test('invalidates an in-progress projection when its replica lease is lost', async () => {
        let renewals = 0;
        let guardAfterRenewal = true;
        const sampler = new NotificationSystemSampler({
            getSnapshot: async () => ({ redis: 'disconnected', timestamp: EVENT_TIME }),
            projector: {
                projectSnapshot: async (_snapshot, _recipients, shouldContinue) => {
                    await new Promise(resolve => setTimeout(resolve, 20));
                    guardAfterRenewal = shouldContinue?.() ?? true;
                }
            },
            intervalMs: 60_000,
            operationTimeoutMs: 100,
            acquireLease: async () => ({
                renewalIntervalMs: 5,
                renew: async () => ++renewals === 1,
                release: async () => undefined
            })
        });

        assert.equal(await sampler.runOnce(), false);
        assert.ok(renewals >= 2);
        assert.equal(guardAfterRenewal, false);
    });

    test('waits for an active stalled-activity scan during shutdown', async () => {
        let releaseScan!: () => void;
        let markStarted!: () => void;
        const started = new Promise<void>(resolve => { markStarted = resolve; });
        const detector = new NotificationStalledDetector({
            projector: {
                detectStalledActivities: async () => {
                    markStarted();
                    await new Promise<void>(resolve => { releaseScan = resolve; });
                    return 1;
                }
            },
            intervalMs: 60_000,
            stalledAfterMs: 30_000
        });

        const run = detector.runOnce();
        await started;
        let stopped = false;
        const stop = detector.stop().then(() => { stopped = true; });
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(stopped, false);
        releaseScan();
        await Promise.all([run, stop]);
        assert.equal(stopped, true);
    });
});
