import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import knex, { type Knex } from 'knex';
import { closeConnection } from '../src/db/connection.js';
import { up as createNotificationSchema } from '../src/db/migrations/20260802000000_create_notification_schema.js';
import { up as addAdvertisedActions } from '../src/db/migrations/20260824020000_add_notification_advertised_actions.js';
import {
    down as removePlanNotificationActions,
    up as addPlanNotificationActions
} from '../src/db/migrations/20260824030000_add_plan_notification_actions.js';
import { NotificationService } from '../src/services/notificationService.js';

interface SqliteConnection {
    pragma(statement: string): unknown;
}

function createDatabase(): Knex {
    return knex({
        client: 'better-sqlite3',
        connection: { filename: ':memory:' },
        useNullAsDefault: true,
        pool: {
            afterCreate(
                connection: SqliteConnection,
                done: (error: Error | null, connection: SqliteConnection) => void
            ) {
                connection.pragma('foreign_keys = ON');
                connection.pragma('recursive_triggers = ON');
                done(null, connection);
            }
        }
    });
}

after(async () => closeConnection());

test('preserves prior advertised actions across the plan-action migration rollback', async () => {
    const database = createDatabase();
    try {
        await createNotificationSchema(database);
        await addAdvertisedActions(database);

        // Existing installations reached this four-action trigger before this migration existed.
        await removePlanNotificationActions(database);
        await assert.rejects(
            database('notification_events').insert({
                event_id: 'pre-migration-plan',
                deduplication_key: 'pre-migration-plan',
                kind: 'plan',
                severity: 'success',
                target_json: JSON.stringify({
                    type: 'plan',
                    draftId: 'draft-pre-migration',
                    repository: 'integry/propr'
                }),
                title: 'Plan ready',
                body: 'Review the generated plan.',
                action_json: null,
                advertised_actions_json: JSON.stringify(['refine']),
                metadata_json: null,
                occurred_at: '2026-08-24T03:00:00.000Z',
                created_at: '2026-08-24T03:00:00.000Z'
            }),
            /invalid notification advertised actions/
        );

        await addPlanNotificationActions(database);
        const service = new NotificationService({
            database,
            now: () => new Date('2026-08-24T03:01:00.000Z')
        });
        const allActions = [
            'refine',
            'stop',
            'approve_execute',
            'follow_up',
            'open_pr',
            'dismiss'
        ] as const;
        const created = await service.createNotificationEvent({
            eventId: 'migrated-plan',
            deduplicationKey: 'migrated-plan',
            kind: 'plan',
            severity: 'success',
            target: {
                type: 'plan',
                draftId: 'draft-migrated-plan',
                repository: 'integry/propr'
            },
            title: 'Plan ready',
            body: 'Review the generated plan.',
            actions: allActions,
            recipients: ['plan-owner']
        });
        assert.deepEqual(created.actions, allActions);
        assert.deepEqual(
            (await service.listNotifications('plan-owner')).notifications[0].actions,
            allActions
        );

        await removePlanNotificationActions(database);

        const priorActions = ['stop', 'follow_up', 'open_pr', 'dismiss'];
        const stored = await database('notification_events')
            .where({ event_id: 'migrated-plan' })
            .first();
        const storedActions = JSON.parse(stored.advertised_actions_json);
        assert.deepEqual(storedActions, priorActions);
        assert.deepEqual(
            (await service.listNotifications('plan-owner')).notifications[0].actions,
            priorActions
        );
        await assert.rejects(
            service.createNotificationEvent({
                eventId: 'post-rollback-plan',
                deduplicationKey: 'post-rollback-plan',
                kind: 'plan',
                target: {
                    type: 'plan',
                    draftId: 'draft-post-rollback',
                    repository: 'integry/propr'
                },
                title: 'Another plan is ready',
                body: 'The former trigger must reject this action.',
                actions: ['approve_execute']
            }),
            /invalid notification advertised actions/
        );
    } finally {
        await database.destroy();
    }
});
