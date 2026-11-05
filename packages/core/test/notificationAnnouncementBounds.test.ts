import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, describe, test } from 'node:test';
import knex, { type Knex } from 'knex';
import { closeConnection, type BetterSqliteConnection } from '../src/db/connection.js';
import { NotificationService } from '../src/services/notificationService.js';
import { closeEventPublisher } from '../src/utils/eventPublisher.js';
import { SilentRedis } from './silentRedisStub.js';
import { up } from '../src/db/migrations/20260802000000_create_notification_schema.js';
import { up as addPreferenceApis } from '../src/db/migrations/20260802010000_add_notification_preference_apis.js';
import { up as addBadgePreference } from '../src/db/migrations/20260824010000_add_notification_badge_preference.js';
import { up as addAdvertisedActions } from '../src/db/migrations/20260824020000_add_notification_advertised_actions.js';
import { up as addSystemFailureState } from '../src/db/migrations/20260829000000_add_notification_system_failure_state.js';
import { up as addPullRequestState } from '../src/db/migrations/20260829010000_add_notification_pull_request_state.js';

/**
 * How many events one cleanup closes here.
 *
 * Small enough to keep the test quick, large enough that paying one publish
 * timeout per announcement would be unmistakable: the real cleanups close
 * whatever a pull request accumulated, which is routinely more than this.
 */
const CLOSED_EVENTS = 8;

let database: Knex;
let service: NotificationService;
let stub: SilentRedis;
let redisHost: string | undefined;
let redisPort: string | undefined;

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

async function migrate(target: Knex): Promise<void> {
    await up(target);
    await addPreferenceApis(target);
    await addBadgePreference(target);
    await addAdvertisedActions(target);
    await addSystemFailureState(target);
    await addPullRequestState(target);
}

beforeEach(async () => {
    stub = await SilentRedis.listen();
    redisHost = process.env.REDIS_HOST;
    redisPort = process.env.REDIS_PORT;
    process.env.REDIS_HOST = '127.0.0.1';
    process.env.REDIS_PORT = String(stub.port);
    database = createDatabase();
    await migrate(database);
    // The real publisher on purpose: the point of this suite is what a caller
    // waits for when the announcements go nowhere.
    service = new NotificationService({ database, allowInsecureLocalhost: false });
});

afterEach(async () => {
    await closeEventPublisher();
    await database.destroy();
    await stub.goAway();
    if (redisHost === undefined) delete process.env.REDIS_HOST;
    else process.env.REDIS_HOST = redisHost;
    if (redisPort === undefined) delete process.env.REDIS_PORT;
    else process.env.REDIS_PORT = redisPort;
});

after(async () => closeConnection());

describe('notification announcement bounds', { concurrency: false }, () => {
    test('a multi-event cleanup does not wait out one timeout per announcement', async () => {
        for (let index = 0; index < CLOSED_EVENTS; index += 1) {
            await service.createNotificationEvent({
                eventId: `pr-event-${index}`,
                deduplicationKey: `pr-event-${index}-key`,
                kind: 'task',
                target: {
                    type: 'task',
                    repository: 'integry/propr',
                    taskId: `task-${index}`,
                    prNumber: 42
                },
                title: `Implementation completed ${index}`,
                body: 'Implementation completed.',
                recipients: ['user-a', 'user-b']
            });
        }

        const started = Date.now();
        const dismissed = await service.dismissNotificationsForPullRequest('integry/propr', 42);
        const duration = Date.now() - started;

        assert.equal(dismissed, CLOSED_EVENTS * 2, 'every receipt is still closed');
        assert.ok(
            duration < 3_000,
            `the cleanup waited ${duration}ms on its ${CLOSED_EVENTS} announcements`
        );
    });
});
