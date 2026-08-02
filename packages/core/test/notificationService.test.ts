import assert from 'node:assert/strict';
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
    NotificationValidationError
} from '../src/services/notificationService.js';
import { up } from '../src/db/migrations/20260802000000_create_notification_schema.js';
import { up as addPreferenceApis } from '../src/db/migrations/20260802010000_add_notification_preference_apis.js';

let database: Knex;
let service: NotificationService;
let clock = Date.parse('2026-08-02T10:00:00.000Z');

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
        generateId: () => 'generated-event'
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
        }
        assert.deepEqual(defaults.quietHours, {
            start: null,
            end: null,
            timezone: 'UTC'
        });

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
                p256dh: 'B' + 'A'.repeat(86),
                auth: 'A'.repeat(22)
            }
        }, 'Test Browser');
        const refreshed = await service.upsertPushSubscription('user-a', {
            endpoint,
            expirationTime: null,
            keys: {
                p256dh: 'BA' + 'B'.repeat(84) + 'A',
                auth: 'B'.repeat(21) + 'A'
            }
        });

        assert.equal(refreshed.id, first.id);
        assert.equal(await database('push_subscriptions').count('* as count').first()
            .then(row => Number(row?.count)), 1);
        let stored = await database('push_subscriptions').where({ endpoint }).first();
        assert.equal(stored.p256dh_key, 'BA' + 'B'.repeat(84) + 'A');
        assert.equal(stored.auth_key, 'B'.repeat(21) + 'A');
        assert.equal(stored.revoked_at, null);

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
                p256dh: 'BA' + 'C'.repeat(84) + 'A',
                auth: 'C'.repeat(21) + 'Q'
            }
        });
        assert.equal(reactivated.id, first.id);
        stored = await database('push_subscriptions').where({ endpoint }).first();
        assert.equal(stored.revoked_at, null);
        assert.equal(stored.p256dh_key, 'BA' + 'C'.repeat(84) + 'A');
        assert.equal(await database('push_subscriptions').count('* as count').first()
            .then(row => Number(row?.count)), 1);
    });

    test('validates push endpoints and browser encryption keys', async () => {
        const validKeys = {
            p256dh: 'B' + 'A'.repeat(86),
            auth: 'A'.repeat(22)
        };
        await service.upsertPushSubscription('local-user', {
            endpoint: 'http://localhost:4173/push/browser',
            expirationTime: null,
            keys: validKeys
        });
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
    });
});
