import { after, before, describe, test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import knex, { type Knex } from 'knex';
import {
  NOTIFICATION_KINDS,
  NOTIFICATION_SOURCE_ACTIVITY_TYPES,
} from '../packages/shared/src/notifications.ts';
import {
  down,
  up,
} from '../packages/core/src/db/migrations/20260802000000_create_notification_schema.js';

const notificationTables = [
  'notification_events',
  'notification_user_states',
  'notification_preferences',
  'push_subscriptions',
  'push_delivery_attempts',
  'notification_source_activity',
] as const;

const notificationMigrationName = '20260802000000_create_notification_schema.js';
const migrationsDirectory = path.resolve('packages/core/src/db/migrations');

function createMigrationRunnerDatabase(): Knex {
  return knex({
    client: 'better-sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true,
    migrations: { directory: migrationsDirectory },
    pool: {
      afterCreate(connection, done) {
        connection.pragma('foreign_keys = ON');
        done(null, connection);
      },
    },
  });
}

const event = {
  event_id: 'event-1',
  deduplication_key: 'task:task-1:completed',
  kind: 'task',
  severity: 'success',
  target_json: JSON.stringify({
    type: 'task',
    taskId: 'task-1',
    repository: 'integry/propr',
  }),
  title: 'Task completed',
  body: 'Task task-1 completed successfully.',
};

describe('durable notification schema', { concurrency: false }, () => {
  let db: Knex;

  before(async () => {
    db = knex({
      client: 'better-sqlite3',
      connection: { filename: ':memory:' },
      useNullAsDefault: true,
      pool: {
        afterCreate(connection, done) {
          connection.pragma('foreign_keys = ON');
          done(null, connection);
        },
      },
    });

    await up(db);
  });

  after(async () => {
    await db.destroy();
  });

  test('exports all durable notification and activity kinds', () => {
    assert.deepStrictEqual(NOTIFICATION_KINDS, [
      'plan',
      'task',
      'review',
      'pull_request',
      'indexing',
      'system_failure',
    ]);
    assert.deepStrictEqual(NOTIFICATION_SOURCE_ACTIVITY_TYPES, ['task', 'indexing']);
  });

  test('creates tables with ISO-8601 TEXT timestamps and purpose-built indexes', async () => {
    for (const table of notificationTables) {
      assert.strictEqual(await db.schema.hasTable(table), true, `${table} should exist`);
    }

    for (const tableName of notificationTables) {
      const columns = await db.raw(`PRAGMA table_info(${tableName})`) as Array<{
        name: string;
        type: string;
      }>;
      for (const column of columns.filter(({ name }) => name.endsWith('_at'))) {
        assert.strictEqual(
          column.type.toLowerCase(),
          'text',
          `${tableName}.${column.name} should be stored as ISO-8601 TEXT`,
        );
      }
    }

    const indexes = await db.raw(`
      SELECT name, sql
      FROM sqlite_master
      WHERE type = 'index'
        AND name IN (
          'notification_events_deduplication_key_idx',
          'notification_user_states_unread_idx',
          'push_delivery_attempts_retry_idx',
          'notification_source_activity_stalled_idx'
        )
    `) as Array<{ name: string; sql: string }>;
    assert.strictEqual(indexes.length, 4);
    assert.match(
      indexes.find(({ name }) => name === 'notification_user_states_unread_idx')?.sql ?? '',
      /WHERE read_at IS NULL AND dismissed_at IS NULL/i,
    );
    assert.match(
      indexes.find(({ name }) => name === 'push_delivery_attempts_retry_idx')?.sql ?? '',
      /next_retry_at IS NOT NULL/i,
    );
  });

  test('deduplicates immutable events', async () => {
    await db('notification_events').insert(event);

    const stored = await db('notification_events').where({ event_id: event.event_id }).first();
    assert.match(stored.created_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.match(stored.occurred_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

    await assert.rejects(
      db('notification_events').insert({
        ...event,
        event_id: 'event-duplicate',
      }),
      /UNIQUE constraint failed: notification_events\.deduplication_key/,
    );

    await assert.rejects(
      db('notification_events')
        .where({ event_id: event.event_id })
        .update({ title: 'Rewritten title' }),
      /notification events are immutable/,
    );
  });

  test('keeps read and dismissal state independent for every user', async () => {
    await db('notification_user_states').insert([
      { event_id: event.event_id, user_id: 'user-a' },
      { event_id: event.event_id, user_id: 'user-b' },
    ]);

    const readAt = '2026-08-02T08:00:00.000Z';
    const dismissedAt = '2026-08-02T08:01:00.000Z';
    await db('notification_user_states')
      .where({ event_id: event.event_id, user_id: 'user-a' })
      .update({ read_at: readAt, dismissed_at: dismissedAt });

    const userA = await db('notification_user_states')
      .where({ event_id: event.event_id, user_id: 'user-a' })
      .first();
    const userB = await db('notification_user_states')
      .where({ event_id: event.event_id, user_id: 'user-b' })
      .first();

    assert.strictEqual(userA.read_at, readAt);
    assert.strictEqual(userA.dismissed_at, dismissedAt);
    assert.strictEqual(userB.read_at, null);
    assert.strictEqual(userB.dismissed_at, null);
  });

  test('revokes unique push endpoints without losing delivery history', async () => {
    await db('push_subscriptions').insert({
      subscription_id: 'subscription-1',
      user_id: 'user-b',
      endpoint: 'https://push.example.test/subscription/1',
      p256dh_key: 'p256dh',
      auth_key: 'auth',
    });

    await assert.rejects(
      db('push_subscriptions').insert({
        subscription_id: 'subscription-duplicate',
        user_id: 'user-b',
        endpoint: 'https://push.example.test/subscription/1',
        p256dh_key: 'different-p256dh',
        auth_key: 'different-auth',
      }),
      /UNIQUE constraint failed: push_subscriptions\.endpoint/,
    );

    await db('push_delivery_attempts').insert({
      attempt_id: 'attempt-1',
      deduplication_key: 'event-1:subscription-1:1',
      event_id: event.event_id,
      user_id: 'user-b',
      subscription_id: 'subscription-1',
      attempt_number: 1,
      status: 'retryable',
      attempted_at: '2026-08-02T08:02:00.000Z',
      next_retry_at: '2026-08-02T08:07:00.000Z',
    });

    const revokedAt = '2026-08-02T08:03:00.000Z';
    await db('push_subscriptions')
      .where({ subscription_id: 'subscription-1' })
      .update({ revoked_at: revokedAt, updated_at: revokedAt });

    const subscription = await db('push_subscriptions')
      .where({ subscription_id: 'subscription-1' })
      .first();
    const attempt = await db('push_delivery_attempts')
      .where({ attempt_id: 'attempt-1' })
      .first();

    assert.strictEqual(subscription.revoked_at, revokedAt);
    assert.strictEqual(attempt.subscription_id, subscription.subscription_id);
  });

  test('stores one mutable latest-activity row per task or indexing key', async () => {
    await db('notification_source_activity').insert({
      activity_type: 'task',
      activity_key: 'task-1',
      repository: 'integry/propr',
      status: 'processing',
      last_activity_at: '2026-08-02T08:00:00.000Z',
    });

    await db('notification_source_activity')
      .insert({
        activity_type: 'task',
        activity_key: 'task-1',
        repository: 'integry/propr',
        status: 'completed',
        last_activity_at: '2026-08-02T08:10:00.000Z',
        completed_at: '2026-08-02T08:10:00.000Z',
        updated_at: '2026-08-02T08:10:00.000Z',
      })
      .onConflict(['activity_type', 'activity_key'])
      .merge();

    const rows = await db('notification_source_activity')
      .where({ activity_type: 'task', activity_key: 'task-1' });
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].status, 'completed');
    assert.strictEqual(rows[0].completed_at, '2026-08-02T08:10:00.000Z');
  });

  test('rolls back every notification table and trigger', async () => {
    await down(db);

    for (const table of notificationTables) {
      assert.strictEqual(await db.schema.hasTable(table), false, `${table} should be removed`);
    }

    const triggers = await db.raw(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'trigger' AND name LIKE 'notification_events_immutable_%'
    `) as Array<{ name: string }>;
    assert.deepStrictEqual(triggers, []);
  });
});

describe('notification migration runner compatibility', { concurrency: false }, () => {
  test('migrates a fresh database and rolls the notification migration back and up', async () => {
    const db = createMigrationRunnerDatabase();
    try {
      const [, migrations] = await db.migrate.latest();
      assert.ok(migrations.includes(notificationMigrationName));
      assert.strictEqual(await db.schema.hasTable('notification_events'), true);

      await db.migrate.down({ name: notificationMigrationName });
      assert.strictEqual(await db.schema.hasTable('notification_events'), false);

      await db.migrate.up({ name: notificationMigrationName });
      assert.strictEqual(await db.schema.hasTable('notification_events'), true);
    } finally {
      await db.destroy();
    }
  });

  test('upgrades an existing database and is idempotent once applied', async () => {
    const db = createMigrationRunnerDatabase();
    try {
      const migrationNames = fs.readdirSync(migrationsDirectory)
        .filter((name) => name.endsWith('.js'))
        .sort();
      const notificationMigrationIndex = migrationNames.indexOf(notificationMigrationName);
      assert.notStrictEqual(notificationMigrationIndex, -1);

      for (const migrationName of migrationNames.slice(0, notificationMigrationIndex)) {
        await db.migrate.up({ name: migrationName });
      }
      assert.strictEqual(await db.schema.hasTable('notification_events'), false);

      const [, upgradeMigrations] = await db.migrate.latest();
      assert.deepStrictEqual(upgradeMigrations, [notificationMigrationName]);
      assert.strictEqual(await db.schema.hasTable('notification_events'), true);

      const [, repeatedMigrations] = await db.migrate.latest();
      assert.deepStrictEqual(repeatedMigrations, []);
    } finally {
      await db.destroy();
    }
  });
});
