import assert from 'node:assert/strict';
import { createECDH } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, beforeEach, describe, test } from 'node:test';
import knex, { type Knex } from 'knex';
import { closeConnection, type BetterSqliteConnection } from '../src/db/connection.js';
import {
    NotificationQueryValidationError,
    MAX_NOTIFICATION_LIST_LIMIT,
    decodeNotificationCursor,
    parseNotificationListLimit
} from '../src/services/notificationPagination.js';
import {
    NotificationService,
    NotificationValidationError,
    PushSubscriptionConflictError
} from '../src/services/notificationService.js';
import { up } from '../src/db/migrations/20260802000000_create_notification_schema.js';
import { up as addPreferenceApis } from '../src/db/migrations/20260802010000_add_notification_preference_apis.js';

let database: Knex;
let service: NotificationService;
let clock = Date.parse('2026-08-02T10:00:00.000Z');

function generatedP256dhKey(privateKeyValue: number): string {
    const privateKey = Buffer.alloc(32);
    privateKey[31] = privateKeyValue;
    const ecdh = createECDH('prime256v1');
    ecdh.setPrivateKey(privateKey);
    return ecdh.getPublicKey(undefined, 'uncompressed').toString('base64url');
}

const p256dhKey1 = generatedP256dhKey(1);
const p256dhKey2 = generatedP256dhKey(2);
const p256dhKey3 = generatedP256dhKey(3);
const p256dhKey4 = generatedP256dhKey(4);

function createDatabase(filename = ':memory:'): Knex {
    return knex({
        client: 'better-sqlite3',
        connection: { filename },
        useNullAsDefault: true,
        pool: {
            afterCreate(
                connection: BetterSqliteConnection,
                done: (error: Error | null, connection: BetterSqliteConnection) => void
            ) {
                connection.pragma('foreign_keys = ON');
                connection.pragma('recursive_triggers = ON');
                connection.pragma('busy_timeout = 1000');
                done(null, connection);
            }
        }
    });
}

async function createEvent(
    eventId: string,
    occurredAt: string,
    recipients: Array<string | { userId: string; inboxEnabled?: boolean; pushEnabled?: boolean }>
) {
    return service.createNotificationEvent({
        eventId,
        deduplicationKey: `dedupe:${eventId}`,
        kind: 'task',
        severity: 'success',
        target: {
            type: 'task',
            repository: 'integry/propr',
            taskId: `task-${eventId}`
        },
        title: `Event ${eventId}`,
        body: `Body ${eventId}`,
        occurredAt,
        recipients
    });
}

beforeEach(async () => {
    clock = Date.parse('2026-08-02T10:00:00.000Z');
    database = createDatabase();
    await up(database);
    await addPreferenceApis(database);
    service = new NotificationService({
        database,
        now: () => new Date(clock += 1000),
        generateId: () => 'generated-event',
        allowInsecureLocalhost: false
    });
});

afterEach(async () => database.destroy());
after(async () => closeConnection());

describe('notification service', { concurrency: false }, () => {
    test('returns the original event and assigns new recipients on a duplicate', async () => {
        const original = await service.createNotificationEvent({
            eventId: 'original-event',
            deduplicationKey: 'stable-operation',
            kind: 'task',
            target: {
                type: 'task',
                repository: 'integry/propr',
                taskId: 'task-1'
            },
            title: 'Original title',
            body: 'Original body',
            occurredAt: '2026-08-02T08:00:00.000Z',
            recipients: ['user-a']
        });
        const duplicate = await service.createNotificationEvent({
            eventId: 'replacement-event',
            deduplicationKey: 'stable-operation',
            kind: 'task',
            target: {
                type: 'task',
                repository: 'integry/propr',
                taskId: 'task-2'
            },
            title: 'Replacement title',
            body: 'Replacement body',
            occurredAt: '2026-08-02T09:00:00.000Z',
            recipients: ['user-b']
        });

        assert.equal(original.id, 'original-event');
        assert.equal(duplicate.id, original.id);
        assert.equal(duplicate.title, 'Original title');
        assert.equal(await database('notification_events').count('* as count').first().then(row => Number(row?.count)), 1);
        assert.deepEqual(
            await database('notification_user_states').select('event_id', 'user_id').orderBy('user_id'),
            [
                { event_id: 'original-event', user_id: 'user-a' },
                { event_id: 'original-event', user_id: 'user-b' }
            ]
        );
    });

    test('paginates by occurrence and ID while excluding non-Inbox receipts', async () => {
        await createEvent('event-a', '2026-08-02T07:00:00.000Z', ['user-a']);
        await createEvent('event-b', '2026-08-02T08:00:00.000Z', ['user-a']);
        await createEvent('event-c', '2026-08-02T08:00:00.000Z', ['user-a', 'user-b']);
        await createEvent('event-hidden', '2026-08-02T09:00:00.000Z', [
            { userId: 'user-a', inboxEnabled: false, pushEnabled: true }
        ]);

        const firstPage = await service.listNotifications('user-a', { limit: 2 });
        assert.deepEqual(firstPage.notifications.map(item => item.id), ['event-c', 'event-b']);
        assert.equal(firstPage.unreadCount, 3);
        assert.ok(firstPage.nextCursor);
        assert.deepEqual(decodeNotificationCursor(firstPage.nextCursor), {
            occurredAt: '2026-08-02T08:00:00.000Z',
            eventId: 'event-b'
        });

        const secondPage = await service.listNotifications('user-a', {
            limit: 2,
            cursor: firstPage.nextCursor
        });
        assert.deepEqual(secondPage.notifications.map(item => item.id), ['event-a']);
        assert.equal(secondPage.nextCursor, null);
        assert.deepEqual(
            (await service.listNotifications('user-b')).notifications.map(item => item.id),
            ['event-c']
        );
    });

    test('keeps read and dismissed state idempotent and isolated per user', async () => {
        await createEvent('event-a', '2026-08-02T07:00:00.000Z', ['user-a']);
        await createEvent('event-b', '2026-08-02T08:00:00.000Z', ['user-a', 'user-b']);
        await createEvent('event-c', '2026-08-02T09:00:00.000Z', ['user-a', 'user-b']);

        const read = await service.markNotificationRead('user-a', 'event-c');
        assert.ok(read);
        assert.equal(read.unreadCount, 2);
        assert.ok(read.notification.readAt);
        const readAgain = await service.markNotificationRead('user-a', 'event-c');
        assert.equal(readAgain?.notification.readAt, read.notification.readAt);
        assert.equal(await service.getUnreadNotificationCount('user-b'), 2);

        const dismissed = await service.dismissNotification('user-a', 'event-b');
        assert.ok(dismissed?.notification.dismissedAt);
        assert.equal(dismissed?.unreadCount, 1);
        const dismissedAgain = await service.dismissNotification('user-a', 'event-b');
        assert.equal(
            dismissedAgain?.notification.dismissedAt,
            dismissed?.notification.dismissedAt
        );

        assert.deepEqual(
            (await service.listNotifications('user-a')).notifications.map(item => item.id),
            ['event-c', 'event-a']
        );
        const history = await service.listNotifications('user-a', { includeDismissed: true });
        assert.deepEqual(history.notifications.map(item => item.id), ['event-c', 'event-b', 'event-a']);
        assert.ok(history.notifications[1].dismissedAt);
        const otherUser = await service.listNotifications('user-b');
        assert.deepEqual(otherUser.notifications.map(item => item.id), ['event-c', 'event-b']);
        assert.equal(otherUser.notifications[0].readAt, null);
        assert.equal(otherUser.notifications[1].dismissedAt, null);
        assert.equal(await service.dismissNotification('user-b', 'event-a'), null);
    });

    test('rejects malformed pagination inputs and clamps large valid limits', async () => {
        assert.equal(parseNotificationListLimit(10_000), MAX_NOTIFICATION_LIST_LIMIT);
        await assert.rejects(
            () => service.listNotifications('user-a', { cursor: 'not-a-cursor' }),
            NotificationQueryValidationError
        );
        await assert.rejects(
            () => service.listNotifications('user-a', { limit: 0 }),
            NotificationQueryValidationError
        );
        await assert.rejects(
            () => service.listNotifications('user-a', { limit: 1.5 }),
            NotificationQueryValidationError
        );
        assert.equal((await service.listNotifications('user-a', { limit: 10_000 })).notifications.length, 0);
    });

    test('returns opt-in-safe defaults and preserves unrelated preference updates', async () => {
        const beforeRead = await database('notification_preferences')
            .where({ user_id: 'user-a' })
            .count('* as count')
            .first();
        const defaults = await service.getNotificationPreferences('user-a');
        assert.deepEqual(Object.keys(defaults.preferences), [
            'plan',
            'task',
            'review',
            'pull_request',
            'indexing',
            'system_failure'
        ]);
        for (const preference of Object.values(defaults.preferences)) {
            assert.equal(preference.inboxEnabled, true);
            assert.equal(preference.pushEnabled, false);
            assert.equal(preference.updatedAt, null);
        }
        assert.deepEqual(defaults.quietHours, {
            start: null,
            end: null,
            timezone: 'UTC'
        });
        assert.equal(Number(beforeRead?.count), 0);
        assert.equal(
            await database('notification_preferences')
                .where({ user_id: 'user-a' })
                .count('* as count')
                .first()
                .then(row => Number(row?.count)),
            0,
            'GET must synthesize defaults without writing preference rows'
        );
        assert.equal(
            await database('notification_preference_settings')
                .where({ user_id: 'user-a' })
                .count('* as count')
                .first()
                .then(row => Number(row?.count)),
            0,
            'GET must not write settings in read-only deployments'
        );

        const updated = await service.updateNotificationPreferences('user-a', {
            preferences: {
                task: { pushEnabled: true },
                plan: { inboxEnabled: false }
            },
            quietHours: {
                start: '22:30',
                end: '07:15',
                timezone: 'America/New_York'
            }
        });
        assert.equal(updated.preferences.task.pushEnabled, true);
        assert.equal(updated.preferences.task.inboxEnabled, true);
        assert.equal(updated.preferences.plan.inboxEnabled, false);
        assert.equal(updated.preferences.plan.pushEnabled, false);
        assert.ok(updated.preferences.task.updatedAt);
        assert.deepEqual(updated.quietHours, {
            start: '22:30',
            end: '07:15',
            timezone: 'America/New_York'
        });

        const partial = await service.updateNotificationPreference(
            'user-a',
            'review',
            { inboxEnabled: false }
        );
        assert.equal(partial.preferences.review.inboxEnabled, false);
        assert.equal(partial.preferences.review.pushEnabled, false);
        assert.equal(partial.preferences.task.pushEnabled, true);
        assert.deepEqual(partial.quietHours, updated.quietHours);
    });

    test('rejects invalid categories, quiet-hour values, and timezones', async () => {
        const invalidUpdates = [
            { preferences: { unknown: { pushEnabled: true } } },
            { quietHours: { start: '24:00' } },
            { quietHours: { end: '7:00' } },
            { quietHours: { timezone: 'Mars/Olympus_Mons' } }
        ];
        for (const update of invalidUpdates) {
            await assert.rejects(
                () => service.updateNotificationPreferences('user-a', update as never),
                NotificationValidationError
            );
        }
    });

    test('upserts, revokes, and reactivates a subscription by owned endpoint', async () => {
        const endpoint = 'https://fcm.googleapis.com/fcm/send/browser-a';
        const first = await service.upsertPushSubscription('user-a', {
            endpoint,
            expirationTime: null,
            keys: {
                p256dh: p256dhKey1,
                auth: 'A'.repeat(22)
            }
        }, 'Test Browser');
        const firstStored = await database('push_subscriptions').where({ endpoint }).first();
        await database('push_subscriptions')
            .where({ subscription_id: first.id })
            .update({ last_used_at: firstStored.created_at });
        const refreshed = await service.upsertPushSubscription('user-a', {
            endpoint,
            expirationTime: null,
            keys: {
                p256dh: p256dhKey2,
                auth: 'B'.repeat(21) + 'A'
            }
        });

        assert.equal(refreshed.id, first.id);
        assert.equal(await database('push_subscriptions').count('* as count').first()
            .then(row => Number(row?.count)), 1);
        let stored = await database('push_subscriptions').where({ endpoint }).first();
        assert.equal(stored.p256dh_key, p256dhKey2);
        assert.equal(stored.auth_key, 'B'.repeat(21) + 'A');
        assert.equal(stored.revoked_at, null);
        assert.equal(stored.user_agent, 'Test Browser');
        assert.equal(stored.last_used_at, null);

        assert.equal(await service.revokePushSubscription('user-b', endpoint), false);
        stored = await database('push_subscriptions').where({ endpoint }).first();
        assert.equal(stored.revoked_at, null);
        assert.equal(await service.revokePushSubscription('user-a', endpoint), true);
        stored = await database('push_subscriptions').where({ endpoint }).first();
        assert.ok(stored.revoked_at);
        assert.equal(stored.p256dh_key, null);
        assert.equal(stored.auth_key, null);

        const reactivated = await service.upsertPushSubscription('user-a', {
            endpoint,
            expirationTime: null,
            keys: {
                p256dh: p256dhKey3,
                auth: 'C'.repeat(21) + 'Q'
            }
        });
        assert.equal(reactivated.id, first.id);
        stored = await database('push_subscriptions').where({ endpoint }).first();
        assert.equal(stored.revoked_at, null);
        assert.equal(stored.p256dh_key, p256dhKey3);
        assert.equal(await database('push_subscriptions').count('* as count').first()
            .then(row => Number(row?.count)), 1);
    });

    test('validates push endpoints and browser encryption keys', async () => {
        const validKeys = {
            p256dh: p256dhKey1,
            auth: 'A'.repeat(22)
        };
        const localInput = {
            endpoint: 'http://localhost:4173/push/browser',
            expirationTime: null,
            keys: validKeys
        };
        await assert.rejects(
            () => service.upsertPushSubscription('local-user', localInput),
            NotificationValidationError
        );
        const explicitlyLocalService = new NotificationService({
            database,
            now: () => new Date(clock += 1000),
            generateId: () => 'local-subscription',
            allowInsecureLocalhost: true
        });
        await explicitlyLocalService.upsertPushSubscription('local-user', localInput);
        await assert.rejects(
            () => explicitlyLocalService.upsertPushSubscription('fragment-user', {
                ...localInput,
                endpoint: 'http://localhost:4173/push/browser#'
            }),
            NotificationValidationError
        );
        await assert.rejects(
            () => service.upsertPushSubscription('user-a', {
                endpoint: 'http://fcm.googleapis.com/fcm/send/insecure',
                expirationTime: null,
                keys: validKeys
            }),
            NotificationValidationError
        );
        await assert.rejects(
            () => service.upsertPushSubscription('user-a', {
                endpoint: 'https://fcm.googleapis.com/fcm/send/invalid-key',
                expirationTime: null,
                keys: { p256dh: 'short', auth: 'short' }
            }),
            NotificationValidationError
        );
        const offCurvePoint = Buffer.alloc(65);
        offCurvePoint[0] = 0x04;
        await assert.rejects(
            () => service.upsertPushSubscription('user-a', {
                endpoint: 'https://fcm.googleapis.com/fcm/send/off-curve-key',
                expirationTime: null,
                keys: {
                    p256dh: offCurvePoint.toString('base64url'),
                    auth: validKeys.auth
                }
            }),
            (error: unknown) => error instanceof NotificationValidationError
                && /P-256 curve/.test(error.message)
        );
    });

    test('bounds User-Agent metadata in one UTF-8-aware pass', async () => {
        let generated = 0;
        const userAgentService = new NotificationService({
            database,
            now: () => new Date(clock += 1000),
            generateId: () => `user-agent-${generated += 1}`
        });
        const firstEndpoint = 'https://fcm.googleapis.com/fcm/send/large-user-agent';
        await userAgentService.upsertPushSubscription('user-a', {
            endpoint: firstEndpoint,
            expirationTime: null,
            keys: { p256dh: p256dhKey1, auth: 'A'.repeat(22) }
        }, 'a'.repeat(100_000));
        const firstStored = await database('push_subscriptions')
            .where({ endpoint: firstEndpoint })
            .first();
        assert.equal(Buffer.byteLength(firstStored.user_agent, 'utf8'), 512);
        assert.equal(firstStored.user_agent, 'a'.repeat(512));

        const secondEndpoint = 'https://fcm.googleapis.com/fcm/send/unicode-user-agent';
        await userAgentService.upsertPushSubscription('user-a', {
            endpoint: secondEndpoint,
            expirationTime: null,
            keys: { p256dh: p256dhKey1, auth: 'A'.repeat(22) }
        }, `${'a'.repeat(511)}💥trailing`);
        const secondStored = await database('push_subscriptions')
            .where({ endpoint: secondEndpoint })
            .first();
        assert.equal(secondStored.user_agent, 'a'.repeat(511));
        assert.equal(Buffer.byteLength(secondStored.user_agent, 'utf8'), 511);
    });

    test('refreshes the owned active row before tied revoked history', async () => {
        const endpoint = 'https://fcm.googleapis.com/fcm/send/history-tie';
        const active = await service.upsertPushSubscription('user-a', {
            endpoint,
            expirationTime: null,
            keys: { p256dh: p256dhKey1, auth: 'A'.repeat(22) }
        }, 'Preserved Browser');
        const activeRow = await database('push_subscriptions')
            .where({ subscription_id: active.id })
            .first();
        await database('push_subscriptions').insert({
            subscription_id: 'zz-revoked-history',
            user_id: 'user-a',
            endpoint,
            p256dh_key: null,
            auth_key: null,
            expires_at: null,
            user_agent: 'Old Browser',
            last_used_at: null,
            revoked_at: activeRow.updated_at,
            created_at: activeRow.created_at,
            updated_at: activeRow.updated_at
        });

        const refreshed = await service.upsertPushSubscription('user-a', {
            endpoint,
            expirationTime: null,
            keys: {
                p256dh: p256dhKey4,
                auth: 'D'.repeat(21) + 'A'
            }
        });

        assert.equal(refreshed.id, active.id);
        assert.equal(
            await database('push_subscriptions')
                .where({ endpoint })
                .whereNull('revoked_at')
                .count('* as count')
                .first()
                .then(row => Number(row?.count)),
            1
        );
    });

    test('maps competing endpoint enrollment to a conflict and keeps same-user retries idempotent', async () => {
        const endpoint = 'https://fcm.googleapis.com/fcm/send/concurrent';
        const input = {
            endpoint,
            expirationTime: null,
            keys: { p256dh: p256dhKey1, auth: 'A'.repeat(22) }
        };
        const firstService = new NotificationService({
            database,
            now: () => new Date(clock += 1000),
            generateId: () => 'concurrent-a'
        });
        const secondService = new NotificationService({
            database,
            now: () => new Date(clock += 1000),
            generateId: () => 'concurrent-b'
        });

        const sameUser = await Promise.all([
            firstService.upsertPushSubscription('user-a', input),
            secondService.upsertPushSubscription('user-a', input)
        ]);
        assert.equal(sameUser[0].id, sameUser[1].id);
        await assert.rejects(
            () => secondService.upsertPushSubscription('user-b', input),
            PushSubscriptionConflictError
        );
    });

    test('applies submitted keys during same-user race reconciliation', async () => {
        const endpoint = 'https://fcm.googleapis.com/fcm/send/forced-reconciliation';
        const initial = await service.upsertPushSubscription('user-a', {
            endpoint,
            expirationTime: null,
            keys: { p256dh: p256dhKey1, auth: 'A'.repeat(22) }
        }, 'Original Browser');
        const forcedRace = Object.assign(
            new Error('UNIQUE constraint failed: push_subscriptions.endpoint'),
            { code: 'SQLITE_CONSTRAINT_UNIQUE' }
        );
        const reconciliationDatabase = new Proxy(database, {
            get(target, property, receiver) {
                if (property === 'transaction') {
                    return async () => { throw forcedRace; };
                }
                return Reflect.get(target, property, receiver) as unknown;
            }
        }) as Knex;
        const reconciliationService = new NotificationService({
            database: reconciliationDatabase,
            now: () => '2026-08-02T10:00:02.000Z'
        });

        const refreshed = await reconciliationService.upsertPushSubscription('user-a', {
            endpoint,
            expirationTime: null,
            keys: { p256dh: p256dhKey2, auth: 'B'.repeat(21) + 'A' }
        }, 'Refreshed Browser');

        assert.equal(refreshed.id, initial.id);
        const stored = await database('push_subscriptions').where({ endpoint }).first();
        assert.equal(stored.p256dh_key, p256dhKey2);
        assert.equal(stored.auth_key, 'B'.repeat(21) + 'A');
        assert.equal(stored.user_agent, 'Refreshed Browser');
    });

    test('reconciles a real cross-connection endpoint enrollment race', async () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'propr-push-race-'));
        const filename = path.join(directory, 'notifications.sqlite');
        const firstDatabase = createDatabase(filename);
        let secondDatabase: Knex | undefined;
        try {
            await up(firstDatabase);
            await addPreferenceApis(firstDatabase);
            secondDatabase = createDatabase(filename);
            await secondDatabase.raw('SELECT 1');
            const endpoint = 'https://fcm.googleapis.com/fcm/send/cross-connection-race';
            const input = {
                endpoint,
                expirationTime: null,
                keys: { p256dh: p256dhKey1, auth: 'A'.repeat(22) }
            };
            const firstService = new NotificationService({
                database: firstDatabase,
                now: () => '2026-08-02T10:00:00.000Z',
                generateId: () => 'race-first'
            });
            const secondService = new NotificationService({
                database: secondDatabase,
                now: () => '2026-08-02T10:00:00.000Z',
                generateId: () => 'race-second'
            });

            const results = await Promise.allSettled([
                firstService.upsertPushSubscription('user-a', input),
                secondService.upsertPushSubscription('user-b', input)
            ]);
            const fulfilled = results.filter(result => result.status === 'fulfilled');
            const rejected = results.filter(result => result.status === 'rejected');
            assert.equal(fulfilled.length, 1);
            assert.equal(rejected.length, 1);
            assert.ok(rejected[0].status === 'rejected');
            assert.ok(rejected[0].reason instanceof PushSubscriptionConflictError);
            assert.equal(
                await firstDatabase('push_subscriptions')
                    .where({ endpoint })
                    .whereNull('revoked_at')
                    .count('* as count')
                    .first()
                    .then(row => Number(row?.count)),
                1
            );

            const sameUserEndpoint =
                'https://fcm.googleapis.com/fcm/send/cross-connection-refresh';
            const sameUserResults = await Promise.all([
                new NotificationService({
                    database: firstDatabase,
                    now: () => '2026-08-02T10:00:01.000Z',
                    generateId: () => 'same-user-first'
                }).upsertPushSubscription('user-a', {
                    ...input,
                    endpoint: sameUserEndpoint
                }),
                new NotificationService({
                    database: secondDatabase,
                    now: () => '2026-08-02T10:00:01.000Z',
                    generateId: () => 'same-user-second'
                }).upsertPushSubscription('user-a', {
                    ...input,
                    endpoint: sameUserEndpoint,
                    keys: { p256dh: p256dhKey2, auth: 'B'.repeat(21) + 'A' }
                })
            ]);
            assert.equal(sameUserResults[0].id, sameUserResults[1].id);
            assert.equal(
                await firstDatabase('push_subscriptions')
                    .where({ endpoint: sameUserEndpoint })
                    .whereNull('revoked_at')
                    .count('* as count')
                    .first()
                    .then(row => Number(row?.count)),
                1
            );
            const storedRefresh = await firstDatabase('push_subscriptions')
                .where({ endpoint: sameUserEndpoint })
                .whereNull('revoked_at')
                .first();
            assert.ok([p256dhKey1, p256dhKey2].includes(storedRefresh.p256dh_key));
        } finally {
            await Promise.allSettled([
                firstDatabase.destroy(),
                secondDatabase?.destroy()
            ]);
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });

    test('backs off and surfaces exhausted SQLite contention', async () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'propr-push-busy-'));
        const filename = path.join(directory, 'notifications.sqlite');
        const lockingDatabase = createDatabase(filename);
        const blockedDatabase = createDatabase(filename);
        let lockHeld = false;
        try {
            await up(lockingDatabase);
            await addPreferenceApis(lockingDatabase);
            await blockedDatabase.raw('PRAGMA busy_timeout = 0');
            // EXCLUSIVE blocks both the write attempt and the ownership read in
            // its catch path, exercising contention-safe reconciliation.
            await lockingDatabase.raw('BEGIN EXCLUSIVE');
            lockHeld = true;
            const blockedService = new NotificationService({
                database: blockedDatabase,
                now: () => '2026-08-02T10:00:00.000Z',
                generateId: () => 'blocked-subscription'
            });

            await assert.rejects(
                () => blockedService.upsertPushSubscription('user-a', {
                    endpoint: 'https://fcm.googleapis.com/fcm/send/busy',
                    expirationTime: null,
                    keys: { p256dh: p256dhKey1, auth: 'A'.repeat(22) }
                }),
                (error: unknown) => {
                    const code = (error as { code?: string }).code;
                    return code === 'SQLITE_BUSY' || code === 'SQLITE_BUSY_SNAPSHOT';
                }
            );
        } finally {
            if (lockHeld) await lockingDatabase.raw('ROLLBACK');
            await Promise.allSettled([
                lockingDatabase.destroy(),
                blockedDatabase.destroy()
            ]);
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });
});
