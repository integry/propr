import assert from 'node:assert/strict';
import { createECDH } from 'node:crypto';
import { after, afterEach, beforeEach, describe, test } from 'node:test';
import knex, { type Knex } from 'knex';
import { up as createNotificationSchema } from '../packages/core/src/db/migrations/20260802000000_create_notification_schema.js';
import {
    down as removeNotificationPreferenceApis,
    up as addNotificationPreferenceApis
} from '../packages/core/src/db/migrations/20260802010000_add_notification_preference_apis.js';
import {
    NotificationService,
    PushSubscriptionConflictError
} from '../packages/core/src/services/notificationService.js';
import {
    parsePushSubscription,
    parsePushSubscriptionInput
} from '../packages/shared/src/notifications.js';
import {
    closeConnection,
    type BetterSqliteConnection
} from '../packages/core/src/db/connection.js';

const timestamp = '2026-08-02T08:00:00.000Z';
function generatedP256dhKey(privateKeyValue: number): string {
    const privateKey = Buffer.alloc(32);
    privateKey[31] = privateKeyValue;
    const ecdh = createECDH('prime256v1');
    ecdh.setPrivateKey(privateKey);
    return ecdh.getPublicKey(undefined, 'uncompressed').toString('base64url');
}

const validP256dhKey = generatedP256dhKey(1);
const refreshedP256dhKey = generatedP256dhKey(2);
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
            'notification_preference_settings_identity_immutable',
            'notification_preference_settings_touch_updated_at',
            'notification_preference_settings_updated_at_managed',
            'notification_preference_settings_updated_at_not_future'
        ]);
    });

    test('canonicalizes legacy endpoints, reconciles collisions, and preserves revocation identity', async () => {
        const canonicalEndpoint =
            'https://fcm.googleapis.com/fcm/send/normalized-default-port';
        const legacySpelling =
            'HTTPS://FCM.GOOGLEAPIS.COM:443/fcm/send/normalized-default-port';
        await database('notification_preferences').insert({
            user_id: 'collision-user-b',
            notification_kind: 'task',
            inbox_enabled: true,
            push_enabled: true
        });
        const legacyService = new NotificationService({
            database,
            now: () => timestamp,
            generateId: () => 'collision-event'
        });
        await legacyService.createNotificationEvent({
            eventId: 'collision-event',
            deduplicationKey: 'migration:collision-event',
            kind: 'task',
            target: {
                type: 'task',
                repository: 'integry/propr',
                taskId: 'collision-task'
            },
            title: 'Canonical endpoint collision',
            body: 'Reconcile legacy endpoint spellings',
            recipients: [{ userId: 'collision-user-b', pushEnabled: true }]
        });
        await database('push_subscriptions').insert([
            {
                subscription_id: 'collision-first-owner',
                user_id: 'collision-user-a',
                endpoint: legacySpelling,
                p256dh_key: validP256dhKey,
                auth_key: validAuthKey,
                expires_at: null,
                user_agent: null,
                last_used_at: null,
                revoked_at: null,
                created_at: '2026-08-02T07:00:00.000Z',
                updated_at: '2026-08-02T07:00:00.000Z'
            },
            {
                subscription_id: 'collision-later-alias',
                user_id: 'collision-user-b',
                endpoint: canonicalEndpoint,
                p256dh_key: validP256dhKey,
                auth_key: validAuthKey,
                expires_at: null,
                user_agent: null,
                last_used_at: null,
                revoked_at: null,
                created_at: timestamp,
                updated_at: timestamp
            }
        ]);
        await database('push_delivery_jobs').insert({
            job_id: 'collision-later-job',
            deduplication_key: 'migration:collision-later-job',
            event_id: 'collision-event',
            user_id: 'collision-user-b',
            subscription_id: 'collision-later-alias',
            attempt_count: 0,
            status: 'pending',
            next_retry_at: null,
            claim_token: null,
            claimed_at: null,
            lease_expires_at: null,
            created_at: timestamp,
            updated_at: timestamp
        });

        await addNotificationPreferenceApis(database);

        const rows = await database('push_subscriptions')
            .where({ endpoint: canonicalEndpoint })
            .orderBy('subscription_id');
        assert.equal(rows.length, 2);
        const firstOwner = rows.find(row => row.subscription_id === 'collision-first-owner');
        const laterAlias = rows.find(row => row.subscription_id === 'collision-later-alias');
        assert.equal(firstOwner?.revoked_at, null);
        assert.equal(laterAlias?.p256dh_key, null);
        assert.equal(laterAlias?.auth_key, null);
        assert.ok(laterAlias?.revoked_at);
        assert.equal(
            await database('push_delivery_jobs')
                .where({ job_id: 'collision-later-job' })
                .first()
                .then(row => row?.status),
            'cancelled'
        );

        const migratedService = new NotificationService({ database });
        await assert.rejects(
            migratedService.upsertPushSubscription('collision-user-b', {
                endpoint: legacySpelling,
                expirationTime: null,
                keys: { p256dh: refreshedP256dhKey, auth: validAuthKey }
            }),
            PushSubscriptionConflictError
        );
        const refreshed = await migratedService.upsertPushSubscription('collision-user-a', {
            endpoint: legacySpelling,
            expirationTime: null,
            keys: { p256dh: refreshedP256dhKey, auth: validAuthKey }
        });
        assert.equal(refreshed.id, 'collision-first-owner');
        assert.equal(refreshed.endpoint, canonicalEndpoint);
        assert.equal(
            await migratedService.revokePushSubscription(
                'collision-user-a',
                legacySpelling
            ),
            true
        );
        assert.deepEqual(await database.raw('PRAGMA foreign_key_check'), []);
    });

    test('revokes legacy active subscriptions whose P-256 point is off-curve', async () => {
        const offCurvePoint = Buffer.alloc(65);
        offCurvePoint[0] = 0x04;
        await database('push_subscriptions').insert({
            subscription_id: 'legacy-off-curve',
            user_id: 'legacy-key-user',
            endpoint: 'https://fcm.googleapis.com/fcm/send/legacy-off-curve',
            p256dh_key: offCurvePoint.toString('base64url'),
            auth_key: validAuthKey,
            expires_at: null,
            user_agent: null,
            last_used_at: null,
            revoked_at: null,
            created_at: timestamp,
            updated_at: timestamp
        });

        await addNotificationPreferenceApis(database);

        const migrated = await database('push_subscriptions')
            .where({ subscription_id: 'legacy-off-curve' })
            .first();
        assert.ok(migrated.revoked_at);
        assert.equal(migrated.p256dh_key, null);
        assert.equal(migrated.auth_key, null);
    });

    test('keeps settings identity immutable and touches mutable updates', async () => {
        await addNotificationPreferenceApis(database);
        await database('notification_preference_settings').insert({
            user_id: 'settings-user',
            quiet_hours_start: null,
            quiet_hours_end: null,
            timezone: 'UTC'
        });
        const before = await database('notification_preference_settings')
            .where({ user_id: 'settings-user' })
            .first();

        await assert.rejects(
            database('notification_preference_settings')
                .where({ user_id: 'settings-user' })
                .update({ user_id: 'transferred-user' }),
            /settings identity is immutable/i
        );
        await assert.rejects(
            database('notification_preference_settings')
                .where({ user_id: 'settings-user' })
                .update({ created_at: '2020-01-01T00:00:00.000Z' }),
            /settings identity is immutable/i
        );

        await database('notification_preference_settings')
            .where({ user_id: 'settings-user' })
            .update({ timezone: 'Europe/Riga' });
        const after = await database('notification_preference_settings')
            .where({ user_id: 'settings-user' })
            .first();
        assert.equal(after.user_id, before.user_id);
        assert.equal(after.created_at, before.created_at);
        assert.ok(after.updated_at > before.updated_at);
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

    test('stores the runtime-normalized form of every accepted endpoint in SQLite', async () => {
        await addNotificationPreferenceApis(database);
        const cases = [
            {
                name: 'public-host',
                endpoint: 'https://fcm.googleapis.com/fcm/send/parity-public',
                p256dh: validP256dhKey,
                auth: validAuthKey,
                accepted: true
            },
            {
                name: 'apple-suffix',
                endpoint: 'https://device.push.apple.com/3/device/parity',
                p256dh: validP256dhKey,
                auth: validAuthKey,
                accepted: true
            },
            {
                name: 'normalized-default-port',
                endpoint: 'HTTPS://FCM.GOOGLEAPIS.COM:443/fcm/send/parity-port',
                p256dh: validP256dhKey,
                auth: validAuthKey,
                accepted: true
            },
            {
                name: 'padded-keys',
                endpoint: 'https://fcm.googleapis.com/fcm/send/parity-padding',
                p256dh: `${validP256dhKey}=`,
                auth: `${validAuthKey}==`,
                accepted: true
            },
            {
                name: 'localhost',
                endpoint: 'http://localhost:4173/push/parity',
                p256dh: validP256dhKey,
                auth: validAuthKey,
                accepted: true
            },
            {
                name: 'empty-local-fragment',
                endpoint: 'http://localhost:4173/push/parity#',
                p256dh: validP256dhKey,
                auth: validAuthKey,
                accepted: false
            },
            {
                name: 'empty-public-fragment',
                endpoint: 'https://fcm.googleapis.com/fcm/send/parity#',
                p256dh: validP256dhKey,
                auth: validAuthKey,
                accepted: false
            },
            {
                name: 'unsupported-host',
                endpoint: 'https://push.attacker.example/parity',
                p256dh: validP256dhKey,
                auth: validAuthKey,
                accepted: false
            },
            {
                name: 'public-nondefault-port',
                endpoint: 'https://fcm.googleapis.com:8443/fcm/send/parity',
                p256dh: validP256dhKey,
                auth: validAuthKey,
                accepted: false
            },
            {
                name: 'invalid-point-prefix',
                endpoint: 'https://fcm.googleapis.com/fcm/send/parity-prefix',
                p256dh: `A${validP256dhKey.slice(1)}`,
                auth: validAuthKey,
                accepted: false
            },
            {
                name: 'noncanonical-auth-bits',
                endpoint: 'https://fcm.googleapis.com/fcm/send/parity-auth',
                p256dh: validP256dhKey,
                auth: `${validAuthKey.slice(0, -1)}B`,
                accepted: false
            }
        ];

        for (const candidate of cases) {
            let runtimeAccepted = true;
            let normalizedEndpoint = candidate.endpoint;
            try {
                normalizedEndpoint = parsePushSubscriptionInput({
                    endpoint: candidate.endpoint,
                    expirationTime: null,
                    keys: { p256dh: candidate.p256dh, auth: candidate.auth }
                }, { allowInsecureLocalhost: true }).endpoint;
            } catch {
                runtimeAccepted = false;
            }

            let sqliteAccepted = true;
            try {
                await database('push_subscriptions').insert({
                    subscription_id: `parity-${candidate.name}`,
                    user_id: 'parity-user',
                    endpoint: normalizedEndpoint,
                    p256dh_key: candidate.p256dh,
                    auth_key: candidate.auth,
                    expires_at: null,
                    user_agent: null,
                    last_used_at: null,
                    revoked_at: null
                });
            } catch {
                sqliteAccepted = false;
            }

            assert.equal(runtimeAccepted, candidate.accepted, candidate.name);
            assert.equal(sqliteAccepted, candidate.accepted, candidate.name);
            if (runtimeAccepted && normalizedEndpoint !== candidate.endpoint) {
                await assert.rejects(
                    database('push_subscriptions').insert({
                        subscription_id: `raw-parity-${candidate.name}`,
                        user_id: 'raw-parity-user',
                        endpoint: candidate.endpoint,
                        p256dh_key: candidate.p256dh,
                        auth_key: candidate.auth,
                        expires_at: null,
                        user_agent: null,
                        last_used_at: null,
                        revoked_at: null
                    }),
                    /push_subscriptions_required_values_check/i,
                    candidate.name
                );
            }
        }
    });

    test('keeps shared subscription lifecycle rules in runtime and SQLite parity', async () => {
        await addNotificationPreferenceApis(database);
        const base = {
            expiresAt: null,
            revokedAt: null,
            createdAt: '2020-01-01T00:00:00.000Z',
            updatedAt: '2020-01-03T00:00:00.000Z'
        };
        const cases = [
            { name: 'active', values: base, accepted: true },
            {
                name: 'revoked-with-expiration',
                values: {
                    ...base,
                    expiresAt: '2020-01-02T00:00:00.000Z',
                    revokedAt: '2020-01-03T00:00:00.000Z'
                },
                accepted: true
            },
            {
                name: 'updated-before-created',
                values: { ...base, updatedAt: '2019-12-31T00:00:00.000Z' },
                accepted: false
            },
            {
                name: 'expiration-before-created',
                values: { ...base, expiresAt: '2019-12-31T00:00:00.000Z' },
                accepted: false
            },
            {
                name: 'revoked-before-created',
                values: { ...base, revokedAt: '2019-12-31T00:00:00.000Z' },
                accepted: false
            },
            {
                name: 'revoked-after-updated',
                values: { ...base, revokedAt: '2020-01-04T00:00:00.000Z' },
                accepted: false
            }
        ];

        for (const candidate of cases) {
            const endpoint = `https://fcm.googleapis.com/fcm/send/lifecycle-${candidate.name}`;
            let runtimeAccepted = true;
            try {
                parsePushSubscription({
                    id: `lifecycle-${candidate.name}`,
                    endpoint,
                    ...candidate.values
                });
            } catch {
                runtimeAccepted = false;
            }

            let sqliteAccepted = true;
            try {
                await database('push_subscriptions').insert({
                    subscription_id: `lifecycle-${candidate.name}`,
                    user_id: 'lifecycle-user',
                    endpoint,
                    p256dh_key: candidate.values.revokedAt === null
                        ? validP256dhKey
                        : null,
                    auth_key: candidate.values.revokedAt === null ? validAuthKey : null,
                    expires_at: candidate.values.expiresAt,
                    user_agent: null,
                    last_used_at: null,
                    revoked_at: candidate.values.revokedAt,
                    created_at: candidate.values.createdAt,
                    updated_at: candidate.values.updatedAt
                });
            } catch {
                sqliteAccepted = false;
            }

            assert.equal(runtimeAccepted, candidate.accepted, candidate.name);
            assert.equal(sqliteAccepted, candidate.accepted, candidate.name);
        }
    });

    test('keeps localhost schema support stable while the runtime opt-in changes', async () => {
        await addNotificationPreferenceApis(database);
        const localService = new NotificationService({
            database,
            now: () => timestamp,
            generateId: () => 'localhost-subscription',
            allowInsecureLocalhost: true
        });
        const input = {
            endpoint: 'http://127.0.0.1:4173/push/browser',
            expirationTime: null,
            keys: { p256dh: validP256dhKey, auth: validAuthKey }
        };
        await localService.upsertPushSubscription('local-user', input);

        // Re-running the migration and changing the process policy do not
        // recompile a conflicting table CHECK.
        await addNotificationPreferenceApis(database);
        assert.equal(await database.schema.hasTable('push_subscriptions_legacy'), false);
        const strictService = new NotificationService({ database, allowInsecureLocalhost: false });
        await assert.rejects(
            strictService.upsertPushSubscription('other-local-user', {
                ...input,
                endpoint: 'http://localhost:4173/push/disabled'
            })
        );
        assert.equal(
            await strictService.revokePushSubscription('local-user', input.endpoint),
            true,
            'turning enrollment off must not strand an existing loopback row'
        );
        const reactivated = await localService.upsertPushSubscription('local-user', input);
        assert.equal(reactivated.id, 'localhost-subscription');

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
