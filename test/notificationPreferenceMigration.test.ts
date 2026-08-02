import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, describe, test } from 'node:test';
import knex, { type Knex } from 'knex';
import { up as createNotificationSchema } from '../packages/core/src/db/migrations/20260802000000_create_notification_schema.js';
import {
    down as removeNotificationPreferenceApis,
    up as addNotificationPreferenceApis
} from '../packages/core/src/db/migrations/20260802010000_add_notification_preference_apis.js';
import { NotificationService } from '../packages/core/src/services/notificationService.js';
import {
    closeConnection,
    type BetterSqliteConnection
} from '../packages/core/src/db/connection.js';

const timestamp = '2026-08-02T08:00:00.000Z';
const validP256dhKey = 'B' + 'A'.repeat(86);
const validAuthKey = 'A'.repeat(22);

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

async function insertDeliveryHistory(database: Knex): Promise<void> {
    const service = new NotificationService({
        database,
        now: () => timestamp,
        generateId: () => 'migration-event'
    });
    await service.createNotificationEvent({
        eventId: 'migration-event',
        deduplicationKey: 'migration:event',
        kind: 'task',
        target: {
            type: 'task',
            repository: 'integry/propr',
            taskId: 'migration-task'
        },
        title: 'Migration notification',
        body: 'Preserve this delivery history',
        recipients: [{ userId: 'user-a', pushEnabled: true }]
    });
    await database('push_subscriptions').insert({
        subscription_id: 'migration-subscription',
        user_id: 'user-a',
        endpoint: 'https://fcm.googleapis.com/fcm/send/migration',
        p256dh_key: validP256dhKey,
        auth_key: validAuthKey,
        expires_at: null,
        user_agent: 'Migration Browser',
        last_used_at: null,
        revoked_at: null,
        created_at: timestamp,
        updated_at: timestamp
    });
    await database('push_subscriptions').insert({
        subscription_id: 'migration-revoked-version',
        user_id: 'user-a',
        endpoint: 'https://fcm.googleapis.com/fcm/send/migration',
        p256dh_key: null,
        auth_key: null,
        expires_at: null,
        user_agent: 'Earlier Migration Browser',
        last_used_at: null,
        revoked_at: timestamp,
        created_at: timestamp,
        updated_at: timestamp
    });
    await database('push_delivery_jobs').insert({
        job_id: 'migration-job',
        deduplication_key: 'migration:delivery',
        event_id: 'migration-event',
        user_id: 'user-a',
        subscription_id: 'migration-subscription',
        attempt_count: 0,
        status: 'pending',
        next_retry_at: null,
        claim_token: null,
        claimed_at: null,
        lease_expires_at: null,
        created_at: timestamp,
        updated_at: timestamp
    });
}

let database: Knex;

beforeEach(async () => {
    database = createDatabase();
    await createNotificationSchema(database);
});

afterEach(async () => database.destroy());
after(async () => closeConnection());

describe('notification preference API migration', { concurrency: false }, () => {
    test('preserves populated preferences, subscription history, and delivery foreign keys', async () => {
        await database('notification_preferences').insert([
            {
                user_id: 'user-a',
                notification_kind: 'task',
                inbox_enabled: true,
                push_enabled: true
            },
            {
                user_id: 'user-b',
                notification_kind: 'review',
                inbox_enabled: false,
                push_enabled: false
            }
        ]);
        await insertDeliveryHistory(database);

        await addNotificationPreferenceApis(database);

        assert.deepEqual(
            await database('notification_preferences')
                .select('user_id', 'notification_kind', 'push_enabled')
                .orderBy('user_id'),
            [
                { user_id: 'user-a', notification_kind: 'task', push_enabled: 1 },
                { user_id: 'user-b', notification_kind: 'review', push_enabled: 0 }
            ]
        );
        assert.equal(
            await database('push_delivery_jobs').where({ job_id: 'migration-job' }).first()
                .then(row => row?.subscription_id),
            'migration-subscription'
        );
        assert.equal(
            await database('push_subscriptions')
                .where({ endpoint: 'https://fcm.googleapis.com/fcm/send/migration' })
                .count('* as count')
                .first()
                .then(row => Number(row?.count)),
            2,
            'legacy active and revoked endpoint versions must both survive upgrade'
        );
        assert.deepEqual(await database.raw('PRAGMA foreign_key_check'), []);

        await removeNotificationPreferenceApis(database);

        assert.equal(await database.schema.hasTable('notification_preference_settings'), false);
        assert.equal(
            await database('notification_preferences')
                .where({ user_id: 'user-a', notification_kind: 'task' })
                .first()
                .then(row => row?.push_enabled),
            1
        );
        assert.equal(
            await database('push_delivery_jobs').where({ job_id: 'migration-job' }).first()
                .then(row => row?.subscription_id),
            'migration-subscription'
        );
        assert.equal(
            await database('push_subscriptions')
                .where({ endpoint: 'https://fcm.googleapis.com/fcm/send/migration' })
                .count('* as count')
                .first()
                .then(row => Number(row?.count)),
            2
        );
        assert.deepEqual(await database.raw('PRAGMA foreign_key_check'), []);
    });

    test('recreates missing settings triggers when a migration attempt is retried', async () => {
        await addNotificationPreferenceApis(database);
        await database.raw('DROP TRIGGER notification_preference_settings_touch_updated_at');

        await addNotificationPreferenceApis(database);

        const triggers = await database('sqlite_master')
            .select('name')
            .where({ type: 'trigger' })
            .whereLike('name', 'notification_preference_settings_%')
            .orderBy('name');
        assert.deepEqual(triggers.map(({ name }) => name), [
            'notification_preference_settings_touch_updated_at',
            'notification_preference_settings_updated_at_managed',
            'notification_preference_settings_updated_at_not_future'
        ]);
    });

    test('prevents encryption keys from being restored while a row remains revoked', async () => {
        await addNotificationPreferenceApis(database);
        await database('push_subscriptions').insert({
            subscription_id: 'revoked-subscription',
            user_id: 'user-a',
            endpoint: 'https://fcm.googleapis.com/fcm/send/revoked',
            p256dh_key: null,
            auth_key: null,
            expires_at: null,
            user_agent: null,
            last_used_at: null,
            revoked_at: timestamp,
            created_at: timestamp,
            updated_at: timestamp
        });

        await assert.rejects(
            database('push_subscriptions')
                .where({ subscription_id: 'revoked-subscription' })
                .update({ p256dh_key: validP256dhKey, auth_key: validAuthKey }),
            /revoked push subscriptions cannot retain encryption keys/i
        );
        await database('push_subscriptions')
            .where({ subscription_id: 'revoked-subscription' })
            .update({
                p256dh_key: validP256dhKey,
                auth_key: validAuthKey,
                revoked_at: null
            });
        const reactivated = await database('push_subscriptions')
            .where({ subscription_id: 'revoked-subscription' })
            .first();
        assert.equal(reactivated.revoked_at, null);
        assert.equal(reactivated.p256dh_key, validP256dhKey);
    });

    test('rolls back a failed rebuild atomically and has an explicit localhost rollback policy', async () => {
        await addNotificationPreferenceApis(database, { allowInsecureLocalhost: true });
        const service = new NotificationService({
            database,
            now: () => timestamp,
            generateId: () => 'localhost-subscription',
            allowInsecureLocalhost: true
        });
        await service.upsertPushSubscription('local-user', {
            endpoint: 'http://127.0.0.1:4173/push/browser',
            expirationTime: null,
            keys: { p256dh: validP256dhKey, auth: validAuthKey }
        });

        await assert.rejects(
            addNotificationPreferenceApis(database, { allowInsecureLocalhost: false }),
            /push_subscriptions_required_values_check/i
        );
        assert.equal(await database.schema.hasTable('push_subscriptions_legacy'), false);
        assert.equal(
            await database('push_subscriptions')
                .where({ subscription_id: 'localhost-subscription' })
                .first()
                .then(row => row?.endpoint),
            'http://127.0.0.1:4173/push/browser'
        );
        assert.deepEqual(await database.raw('PRAGMA foreign_key_check'), []);

        await removeNotificationPreferenceApis(database);

        assert.equal(
            await database('push_subscriptions')
                .where({ subscription_id: 'localhost-subscription' })
                .first()
                .then(row => row?.endpoint),
            'http://127.0.0.1:4173/push/browser'
        );
        assert.deepEqual(await database.raw('PRAGMA foreign_key_check'), []);
    });
});
