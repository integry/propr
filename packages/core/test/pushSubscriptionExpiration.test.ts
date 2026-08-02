import assert from 'node:assert/strict';
import { createECDH } from 'node:crypto';
import { after, afterEach, beforeEach, describe, test } from 'node:test';
import knex, { type Knex } from 'knex';
import { closeConnection, type BetterSqliteConnection } from '../src/db/connection.js';
import { up as createNotificationSchema } from
    '../src/db/migrations/20260802000000_create_notification_schema.js';
import { up as addPreferenceApis } from
    '../src/db/migrations/20260802010000_add_notification_preference_apis.js';
import { NotificationService } from '../src/services/notificationService.js';

let database: Knex;
let generatedId = 0;

const privateKey = Buffer.alloc(32, 0);
privateKey[31] = 1;
const ecdh = createECDH('prime256v1');
ecdh.setPrivateKey(privateKey);
const p256dh = ecdh.getPublicKey(undefined, 'uncompressed').toString('base64url');
const auth = 'A'.repeat(22);

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

function subscriptionInput(endpoint: string, expirationTime: number | null = null) {
    return { endpoint, expirationTime, keys: { p256dh, auth } };
}

beforeEach(async () => {
    generatedId = 0;
    database = createDatabase();
    await createNotificationSchema(database);
    await addPreferenceApis(database);
});

afterEach(async () => database.destroy());
after(async () => closeConnection());

describe('push subscription expiration lifecycle', { concurrency: false }, () => {
    test('requires object-form producers to declare Push eligibility', async () => {
        const service = new NotificationService({ database });
        await assert.rejects(service.createNotificationEvent({
            eventId: 'explicit-producer-channel',
            deduplicationKey: 'explicit:producer-channel',
            kind: 'task',
            target: {
                type: 'task', repository: 'integry/propr', taskId: 'producer-task'
            },
            title: 'Explicit producer channel',
            body: 'Push eligibility may not be omitted silently',
            recipients: [{ userId: 'producer-user' } as never]
        }), /channels must be booleans/);
    });

    test('releases quota and ownership while erasing keys and cancelling queued work', async () => {
        const service = new NotificationService({
            database,
            now: () => new Date(),
            generateId: () => `expiration-${generatedId += 1}`,
            maxActivePushSubscriptionsPerUser: 2,
            maxStoredPushSubscriptionsPerUser: 10,
            maxPushSubscriptionEnrollmentsPerWindow: 20
        });
        await service.updateNotificationPreferences('user-a', {
            preferences: { task: { pushEnabled: true } }
        });
        await service.createNotificationEvent({
            eventId: 'expiration-event',
            deduplicationKey: 'expiration:event',
            kind: 'task',
            target: {
                type: 'task', repository: 'integry/propr', taskId: 'expiration-task'
            },
            title: 'Expiring subscription',
            body: 'Cancel its queued delivery',
            recipients: [{ userId: 'user-a', pushEnabled: true }]
        });

        const expiresSoon = Date.now() + 1_000;
        const firstEndpoint = 'https://fcm.googleapis.com/fcm/send/expires-first';
        const secondEndpoint = 'https://fcm.googleapis.com/fcm/send/expires-second';
        const first = await service.upsertPushSubscription(
            'user-a', subscriptionInput(firstEndpoint, expiresSoon)
        );
        await service.upsertPushSubscription(
            'user-a', subscriptionInput(secondEndpoint, expiresSoon)
        );
        const firstRow = await database('push_subscriptions')
            .where({ subscription_id: first.id })
            .first();
        await database('push_delivery_jobs').insert({
            job_id: 'expiration-job',
            deduplication_key: 'expiration:job',
            event_id: 'expiration-event',
            user_id: 'user-a',
            subscription_id: first.id,
            created_at: firstRow.created_at,
            updated_at: firstRow.created_at
        });

        await new Promise<void>((resolve) => setTimeout(resolve, 1_150));

        const transferred = await service.upsertPushSubscription(
            'user-b', subscriptionInput(firstEndpoint)
        );
        const replacement = await service.upsertPushSubscription(
            'user-a', subscriptionInput('https://fcm.googleapis.com/fcm/send/replacement')
        );
        assert.notEqual(transferred.id, first.id, 'expired ownership must be released');

        const expiredRows = await database('push_subscriptions')
            .whereIn('endpoint', [firstEndpoint, secondEndpoint])
            .where({ user_id: 'user-a' })
            .orderBy('endpoint');
        assert.equal(expiredRows.length, 2);
        for (const row of expiredRows) {
            assert.ok(row.revoked_at);
            assert.equal(row.p256dh_key, null);
            assert.equal(row.auth_key, null);
        }
        assert.equal(
            await database('push_delivery_jobs')
                .where({ job_id: 'expiration-job' })
                .first()
                .then((row) => row?.status),
            'cancelled'
        );
        assert.deepEqual(
            (await service.listPushSubscriptions('user-a')).map(({ id }) => id),
            [replacement.id]
        );
        assert.equal(
            await service.revokePushSubscriptionById('other-user', replacement.id),
            false
        );
        assert.equal(
            await service.revokePushSubscriptionById('user-a', replacement.id),
            true
        );
        assert.deepEqual(await service.listPushSubscriptions('user-a'), []);
    });

    test('global garbage collection first revokes expired rows in a bounded batch', async () => {
        const service = new NotificationService({
            database,
            now: () => new Date(),
            generateId: () => `maintenance-${generatedId += 1}`
        });
        const endpoint = 'https://fcm.googleapis.com/fcm/send/maintenance-expiration';
        const subscription = await service.upsertPushSubscription(
            'maintenance-user',
            subscriptionInput(endpoint, Date.now() + 1_000)
        );
        await new Promise<void>((resolve) => setTimeout(resolve, 1_150));

        assert.equal(await service.garbageCollectPushSubscriptions(1), 0);
        const stored = await database('push_subscriptions')
            .where({ subscription_id: subscription.id })
            .first();
        assert.ok(stored.revoked_at);
        assert.equal(stored.p256dh_key, null);
        assert.equal(stored.auth_key, null);
    });

    test('keeps an unchanged active refresh on a read-only fast path', async () => {
        const input = subscriptionInput(
            'https://fcm.googleapis.com/fcm/send/read-only-refresh'
        );
        const service = new NotificationService({
            database,
            now: () => new Date(),
            generateId: () => 'read-only-subscription'
        });
        const first = await service.upsertPushSubscription('read-only-user', input);
        const before = await database('push_subscriptions')
            .where({ subscription_id: first.id })
            .first();
        let transactionCalls = 0;
        const readOnlyDatabase = new Proxy(database, {
            get(target, property, receiver) {
                if (property === 'transaction') {
                    return async () => {
                        transactionCalls += 1;
                        throw new Error('unchanged refresh attempted a write transaction');
                    };
                }
                return Reflect.get(target, property, receiver) as unknown;
            }
        }) as Knex;
        const readOnlyService = new NotificationService({
            database: readOnlyDatabase,
            now: () => new Date()
        });

        assert.equal(
            (await readOnlyService.upsertPushSubscription('read-only-user', input)).id,
            first.id
        );
        assert.equal(transactionCalls, 0);
        assert.equal(
            await database('push_subscriptions')
                .where({ subscription_id: first.id })
                .first()
                .then((row) => row?.updated_at),
            before.updated_at
        );
    });

    test('permits loopback enrollment only for a local non-production deployment', async () => {
        const previousNodeEnv = process.env.NODE_ENV;
        const previousPublicUrl = process.env.API_PUBLIC_URL;
        const input = subscriptionInput('http://localhost:4173/push/local');
        try {
            process.env.NODE_ENV = 'test';
            process.env.API_PUBLIC_URL = 'https://preview.example.com';
            const remoteService = new NotificationService({
                database, allowInsecureLocalhost: true
            });
            await assert.rejects(remoteService.upsertPushSubscription('local-user', input));

            process.env.API_PUBLIC_URL = 'http://localhost:4000';
            const localService = new NotificationService({
                database,
                allowInsecureLocalhost: true,
                generateId: () => 'local-development-subscription'
            });
            assert.equal(
                (await localService.upsertPushSubscription('local-user', input)).id,
                'local-development-subscription'
            );

            process.env.NODE_ENV = 'production';
            const productionService = new NotificationService({
                database, allowInsecureLocalhost: true
            });
            await assert.rejects(productionService.upsertPushSubscription(
                'other-local-user',
                subscriptionInput('http://127.0.0.1:4173/push/production')
            ));
        } finally {
            if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
            else process.env.NODE_ENV = previousNodeEnv;
            if (previousPublicUrl === undefined) delete process.env.API_PUBLIC_URL;
            else process.env.API_PUBLIC_URL = previousPublicUrl;
        }
    });
});
