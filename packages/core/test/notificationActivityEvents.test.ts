import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, describe, test } from 'node:test';
import knex, { type Knex } from 'knex';
import type { NotificationUpdatePayload } from '@propr/shared';
import { closeConnection, type BetterSqliteConnection } from '../src/db/connection.js';
import { NotificationService } from '../src/services/notificationService.js';
import { up } from '../src/db/migrations/20260802000000_create_notification_schema.js';
import { up as addPreferenceApis } from '../src/db/migrations/20260802010000_add_notification_preference_apis.js';
import { up as addBadgePreference } from '../src/db/migrations/20260824010000_add_notification_badge_preference.js';
import { up as addAdvertisedActions } from '../src/db/migrations/20260824020000_add_notification_advertised_actions.js';
import { up as addSystemFailureState } from '../src/db/migrations/20260829000000_add_notification_system_failure_state.js';
import { up as addPullRequestState } from '../src/db/migrations/20260829010000_add_notification_pull_request_state.js';

type Announcement = Omit<NotificationUpdatePayload, 'eventType'>;

let database: Knex;
let service: NotificationService;
let published: Announcement[];
let publishError: Error | null;
let clock = Date.parse('2026-09-26T10:00:00.000Z');

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
                connection.pragma('busy_timeout = 1000');
                done(null, connection);
            }
        }
    });
}

async function createEvent(eventId: string, recipients: string[]) {
    return service.createNotificationEvent({
        eventId,
        deduplicationKey: `dedupe:${eventId}`,
        kind: 'task',
        severity: 'success',
        target: { type: 'task', repository: 'integry/propr', taskId: `task-${eventId}` },
        title: `Event ${eventId}`,
        body: `Body ${eventId}`,
        recipients
    });
}

beforeEach(async () => {
    clock = Date.parse('2026-09-26T10:00:00.000Z');
    published = [];
    publishError = null;
    database = createDatabase();
    await up(database);
    await addPreferenceApis(database);
    await addBadgePreference(database);
    await addAdvertisedActions(database);
    await addSystemFailureState(database);
    await addPullRequestState(database);
    service = new NotificationService({
        database,
        now: () => new Date(clock += 1000),
        allowInsecureLocalhost: false,
        publishUpdate: async payload => {
            if (publishError) throw publishError;
            published.push(payload);
        }
    });
});

afterEach(async () => database.destroy());
after(async () => closeConnection());

describe('notification activity events', { concurrency: false }, () => {
    test('a created event announces itself to the recipients that received it', async () => {
        await createEvent('event-1', ['user-a', 'user-b']);

        assert.equal(published.length, 1);
        assert.equal(published[0].change, 'created');
        assert.equal(published[0].eventId, 'event-1');
        assert.deepEqual(published[0].recipientIds.sort(), ['user-a', 'user-b']);
        assert.equal(published[0].repository, 'integry/propr');
        assert.equal(new Date(published[0].occurredAt).toISOString(), published[0].occurredAt);
    });

    test('a recipient who disabled the kind is not told about the event', async () => {
        await service.updateNotificationPreference('user-b', 'task', {
            inboxEnabled: false,
            pushEnabled: false
        });
        published = [];
        await createEvent('event-1', ['user-a', 'user-b']);

        assert.deepEqual(published.map(announcement => announcement.recipientIds), [['user-a']]);
    });

    test('reading and dismissing each announce once, repeats announce nothing', async () => {
        await createEvent('event-1', ['user-a']);
        published = [];

        await service.markNotificationRead('user-a', 'event-1');
        await service.markNotificationRead('user-a', 'event-1');
        await service.dismissNotification('user-a', 'event-1');
        await service.dismissNotification('user-a', 'event-1');

        assert.deepEqual(published.map(announcement => [
            announcement.change,
            announcement.eventId,
            announcement.recipientIds,
        ]), [
            ['read', 'event-1', ['user-a']],
            ['dismissed', 'event-1', ['user-a']],
        ]);
    });

    test('a bulk clear announces one recipient-scoped reconcile', async () => {
        await createEvent('event-1', ['user-a']);
        await createEvent('event-2', ['user-a']);
        published = [];

        await service.dismissAllNotifications('user-a');
        await service.dismissAllNotifications('user-a');

        assert.deepEqual(published, [{
            change: 'dismissed_all',
            eventId: null,
            recipientIds: ['user-a'],
            repository: null,
            occurredAt: published[0]?.occurredAt
        }]);
    });

    test('a server-side pull request cleanup announces the cards it closed', async () => {
        await service.createNotificationEvent({
            eventId: 'pr-event',
            deduplicationKey: 'dedupe:pr-event',
            kind: 'pull_request',
            severity: 'info',
            target: {
                type: 'pull_request',
                repository: 'integry/propr',
                prNumber: 42
            },
            title: 'PR needs attention',
            body: 'Review requested',
            recipients: ['user-a', 'user-b']
        });
        published = [];

        assert.equal(await service.dismissNotificationsForPullRequest('integry/propr', 42), 2);

        assert.equal(published.length, 1);
        assert.equal(published[0].change, 'dismissed');
        assert.equal(published[0].eventId, 'pr-event');
        assert.deepEqual(published[0].recipientIds.sort(), ['user-a', 'user-b']);
        assert.equal(published[0].repository, 'integry/propr');
    });

    test('a publish failure is swallowed and the write still stands', async () => {
        publishError = new Error('Redis is unreachable');
        await assert.doesNotReject(createEvent('event-1', ['user-a']));
        publishError = null;

        const stored = await database('notification_user_states')
            .where({ event_id: 'event-1', user_id: 'user-a' })
            .first();
        assert.ok(stored, 'the receipt must exist even though its announcement failed');

        await assert.doesNotReject(async () => {
            publishError = new Error('Redis is unreachable');
            await service.dismissNotification('user-a', 'event-1');
        });
        publishError = null;
        const dismissed = await database('notification_user_states')
            .where({ event_id: 'event-1', user_id: 'user-a' })
            .first() as { dismissed_at?: string | null };
        assert.ok(dismissed.dismissed_at, 'the dismissal must have committed');
    });
});
