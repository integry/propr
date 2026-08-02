import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import knex, { type Knex } from 'knex';
import {
  NOTIFICATION_ACTION_TYPES,
  NOTIFICATION_KINDS,
  NOTIFICATION_SEVERITIES,
  NOTIFICATION_SOURCE_ACTIVITY_TYPES,
  PUSH_DELIVERY_STATUSES,
  type NotificationKind,
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
const migrationsDirectory = fileURLToPath(
  new URL('../packages/core/src/db/migrations/', import.meta.url),
);
const timestamp = '2026-08-02T08:00:00.000Z';

const targetsByKind = {
  plan: {
    type: 'plan',
    draftId: 'draft-1',
    repository: 'integry/propr',
  },
  task: {
    type: 'task',
    taskId: 'task-1',
    repository: 'integry/propr',
  },
  review: {
    type: 'review',
    prNumber: 1730,
    repository: 'integry/propr',
  },
  pull_request: {
    type: 'pull_request',
    prNumber: 1730,
    repository: 'integry/propr',
  },
  indexing: {
    type: 'indexing',
    branch: 'main',
    repository: 'integry/propr',
  },
  system_failure: {
    type: 'system_failure',
    component: 'notification-worker',
  },
} satisfies Record<NotificationKind, object>;

interface EventRow {
  event_id: string;
  deduplication_key: string;
  kind: string;
  severity: string;
  target_json: string;
  title: string;
  body: string;
  action_json?: string | null;
  metadata_json?: string | null;
  occurred_at?: string;
  created_at?: string;
}

interface SubscriptionRow {
  subscription_id: string;
  user_id: string;
  endpoint: string;
  p256dh_key: string;
  auth_key: string;
  revoked_at?: string | null;
}

interface SqliteConnection {
  pragma(statement: string): unknown;
}

type AfterCreate = (
  error: Error | null,
  connection: SqliteConnection,
) => void;

function enableForeignKeys(
  connection: SqliteConnection,
  done: AfterCreate,
): void {
  connection.pragma('foreign_keys = ON');
  done(null, connection);
}

function createSchemaDatabase(): Knex {
  return knex({
    client: 'better-sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true,
    pool: {
      afterCreate: enableForeignKeys,
    },
  });
}

function createMigrationRunnerDatabase(): Knex {
  return knex({
    client: 'better-sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true,
    migrations: { directory: migrationsDirectory },
    pool: {
      afterCreate: enableForeignKeys,
    },
  });
}

function createEvent(overrides: Partial<EventRow> = {}): EventRow {
  const eventId = overrides.event_id ?? 'event-1';
  const kind = overrides.kind ?? 'task';
  const target = targetsByKind[kind as NotificationKind] ?? { type: kind };

  return {
    event_id: eventId,
    deduplication_key: 'notification:' + eventId,
    kind,
    severity: 'success',
    target_json: JSON.stringify(target),
    title: 'Notification ' + eventId,
    body: 'Body for ' + eventId,
    ...overrides,
  };
}

function createSubscription(
  overrides: Partial<SubscriptionRow> = {},
): SubscriptionRow {
  const subscriptionId = overrides.subscription_id ?? 'subscription-1';
  return {
    subscription_id: subscriptionId,
    user_id: 'user-a',
    endpoint: 'https://push.example.test/' + subscriptionId,
    p256dh_key: 'p256dh',
    auth_key: 'auth',
    ...overrides,
  };
}

async function seedEventAndRecipients(
  db: Knex,
  userIds: string[] = ['user-a'],
  overrides: Partial<EventRow> = {},
): Promise<EventRow> {
  const event = createEvent(overrides);
  await db('notification_events').insert(event);
  await db('notification_user_states').insert(
    userIds.map((userId) => ({
      event_id: event.event_id,
      user_id: userId,
    })),
  );
  return event;
}

describe('durable notification schema', { concurrency: false }, () => {
  let db: Knex;

  beforeEach(async () => {
    db = createSchemaDatabase();
    await up(db);
  });

  afterEach(async () => {
    await db.destroy();
  });

  test('exports the complete durable enum contract', () => {
    assert.deepStrictEqual(NOTIFICATION_KINDS, [
      'plan',
      'task',
      'review',
      'pull_request',
      'indexing',
      'system_failure',
    ]);
    assert.deepStrictEqual(NOTIFICATION_SEVERITIES, [
      'info',
      'success',
      'warning',
      'error',
    ]);
    assert.deepStrictEqual(NOTIFICATION_ACTION_TYPES, [
      'navigate',
      'external_link',
    ]);
    assert.deepStrictEqual(PUSH_DELIVERY_STATUSES, [
      'pending',
      'delivered',
      'retryable',
      'failed',
    ]);
    assert.deepStrictEqual(NOTIFICATION_SOURCE_ACTIVITY_TYPES, ['task', 'indexing']);
  });

  test('creates tables with ISO-8601 TEXT timestamps and purpose-built indexes', async () => {
    for (const table of notificationTables) {
      assert.strictEqual(await db.schema.hasTable(table), true, table + ' should exist');
    }

    for (const tableName of notificationTables) {
      const columns = await db.raw('PRAGMA table_info(' + tableName + ')') as Array<{
        name: string;
        type: string;
      }>;
      for (const column of columns.filter(({ name }) => name.endsWith('_at'))) {
        assert.strictEqual(
          column.type.toLowerCase(),
          'text',
          tableName + '.' + column.name + ' should be stored as ISO-8601 TEXT',
        );
      }
    }

    const indexNames = [
      'notification_events_deduplication_key_idx',
      'notification_user_states_visible_idx',
      'notification_user_states_unread_idx',
      'push_subscriptions_active_endpoint_idx',
      'push_delivery_attempts_pending_idx',
      'push_delivery_attempts_retry_idx',
      'notification_source_activity_stalled_idx',
    ];
    const indexes = await db('sqlite_master')
      .select('name', 'sql')
      .where({ type: 'index' })
      .whereIn('name', indexNames) as Array<{ name: string; sql: string }>;
    assert.strictEqual(indexes.length, indexNames.length);

    const indexSql = (name: string) =>
      indexes.find((index) => index.name === name)?.sql ?? '';
    assert.match(
      indexSql('notification_user_states_visible_idx'),
      /\(user_id, created_at DESC, event_id DESC\)\s+WHERE dismissed_at IS NULL/i,
    );
    assert.match(
      indexSql('notification_user_states_unread_idx'),
      /WHERE read_at IS NULL AND dismissed_at IS NULL/i,
    );
    assert.match(
      indexSql('push_subscriptions_active_endpoint_idx'),
      /CREATE UNIQUE INDEX[\s\S]+WHERE revoked_at IS NULL/i,
    );
    assert.match(
      indexSql('push_delivery_attempts_pending_idx'),
      /WHERE status = 'pending'/i,
    );
    assert.match(
      indexSql('push_delivery_attempts_retry_idx'),
      /WHERE status = 'retryable' AND next_retry_at IS NOT NULL/i,
    );
  });

  test('accepts every shared enum value enforced by the schema', async () => {
    for (const kind of NOTIFICATION_KINDS) {
      await db('notification_events').insert(createEvent({
        event_id: 'kind-' + kind,
        kind,
        target_json: JSON.stringify(targetsByKind[kind]),
      }));
    }

    for (const severity of NOTIFICATION_SEVERITIES) {
      await db('notification_events').insert(createEvent({
        event_id: 'severity-' + severity,
        severity,
      }));
    }

    for (const actionType of NOTIFICATION_ACTION_TYPES) {
      await db('notification_events').insert(createEvent({
        event_id: 'action-' + actionType,
        action_json: JSON.stringify({
          type: actionType,
          label: 'Open',
          href: actionType === 'navigate' ? '/tasks/1' : 'https://example.test/tasks/1',
        }),
      }));
    }

    await db('notification_preferences').insert(
      NOTIFICATION_KINDS.map((kind) => ({
        user_id: 'enum-user',
        notification_kind: kind,
      })),
    );

    const deliveryEvent = await seedEventAndRecipients(db, ['enum-user'], {
      event_id: 'delivery-enums',
    });
    const subscription = createSubscription({
      subscription_id: 'subscription-enums',
      user_id: 'enum-user',
    });
    await db('push_subscriptions').insert(subscription);

    for (const [index, status] of PUSH_DELIVERY_STATUSES.entries()) {
      const attempt: Record<string, unknown> = {
        attempt_id: 'attempt-' + status,
        deduplication_key: 'delivery-status:' + status,
        event_id: deliveryEvent.event_id,
        user_id: 'enum-user',
        subscription_id: subscription.subscription_id,
        attempt_number: index + 1,
        status,
      };
      if (status !== 'pending') {
        attempt.attempted_at = timestamp;
      }
      if (status === 'retryable') {
        attempt.next_retry_at = '2026-08-02T08:05:00.000Z';
      }
      await db('push_delivery_attempts').insert(attempt);
    }

    await db('notification_source_activity').insert(
      NOTIFICATION_SOURCE_ACTIVITY_TYPES.map((activityType) => ({
        activity_type: activityType,
        activity_key: 'activity-' + activityType,
        repository: 'integry/propr',
        status: 'processing',
        last_activity_at: timestamp,
      })),
    );

    const preferenceCount = await db('notification_preferences')
      .count({ count: '*' })
      .first();
    const attemptCount = await db('push_delivery_attempts')
      .count({ count: '*' })
      .first();
    assert.ok(preferenceCount);
    assert.ok(attemptCount);
    assert.strictEqual(Number(preferenceCount.count), NOTIFICATION_KINDS.length);
    assert.strictEqual(Number(attemptCount.count), PUSH_DELIVERY_STATUSES.length);
  });

  test('rejects enum values missing from the durable contract', async () => {
    await assert.rejects(
      db('notification_events').insert(createEvent({
        event_id: 'invalid-kind',
        kind: 'unknown',
        target_json: JSON.stringify({ type: 'unknown' }),
      })),
      /notification_events_kind_check/i,
    );
    await assert.rejects(
      db('notification_events').insert(createEvent({
        event_id: 'invalid-severity',
        severity: 'critical',
      })),
      /notification_events_severity_check/i,
    );
    await assert.rejects(
      db('notification_preferences').insert({
        user_id: 'user-a',
        notification_kind: 'unknown',
      }),
      /notification_preferences_kind_check/i,
    );

    const event = await seedEventAndRecipients(db, ['user-a'], {
      event_id: 'invalid-delivery-status',
    });
    const subscription = createSubscription();
    await db('push_subscriptions').insert(subscription);
    await assert.rejects(
      db('push_delivery_attempts').insert({
        attempt_id: 'invalid-status',
        deduplication_key: 'invalid-status',
        event_id: event.event_id,
        user_id: 'user-a',
        subscription_id: subscription.subscription_id,
        status: 'unknown',
      }),
      /push_delivery_attempts_status_check/i,
    );
    await assert.rejects(
      db('notification_source_activity').insert({
        activity_type: 'review',
        activity_key: 'invalid-activity',
        repository: 'integry/propr',
        status: 'processing',
        last_activity_at: timestamp,
      }),
      /notification_source_activity_type_check/i,
    );
  });

  test('rejects malformed or contract-incompatible JSON', async () => {
    await assert.rejects(
      db('notification_events').insert(createEvent({
        event_id: 'malformed-target',
        target_json: '{not-json',
      })),
      /notification_events_target_json_check/i,
    );
    await assert.rejects(
      db('notification_events').insert(createEvent({
        event_id: 'mismatched-target',
        kind: 'task',
        target_json: JSON.stringify(targetsByKind.review),
      })),
      /notification_events_target_kind_check/i,
    );
    await assert.rejects(
      db('notification_events').insert(createEvent({
        event_id: 'malformed-action',
        action_json: '{not-json',
      })),
      /notification_events_action_json_check/i,
    );
    await assert.rejects(
      db('notification_events').insert(createEvent({
        event_id: 'invalid-action',
        action_json: JSON.stringify({
          type: 'execute',
          label: 'Run',
          href: '/run',
        }),
      })),
      /notification_events_action_json_check/i,
    );
    await assert.rejects(
      db('notification_events').insert(createEvent({
        event_id: 'malformed-metadata',
        metadata_json: '{not-json',
      })),
      /notification_events_metadata_json_check/i,
    );
    await assert.rejects(
      db('notification_source_activity').insert({
        activity_type: 'task',
        activity_key: 'malformed-activity-metadata',
        repository: 'integry/propr',
        status: 'processing',
        last_activity_at: timestamp,
        metadata_json: '[]',
      }),
      /notification_source_activity_metadata_json_check/i,
    );
  });

  test('deduplicates immutable events and rejects update and delete', async () => {
    const event = createEvent();
    await db('notification_events').insert(event);

    const stored = await db('notification_events').where({ event_id: event.event_id }).first();
    assert.match(stored.created_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.match(stored.occurred_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

    await assert.rejects(
      db('notification_events').insert(createEvent({
        event_id: 'event-duplicate',
        deduplication_key: event.deduplication_key,
      })),
      /UNIQUE constraint failed: notification_events\.deduplication_key/,
    );
    await assert.rejects(
      db('notification_events')
        .where({ event_id: event.event_id })
        .update({ title: 'Rewritten title' }),
      /notification events are immutable/,
    );
    await assert.rejects(
      db('notification_events').where({ event_id: event.event_id }).delete(),
      /notification events are immutable/,
    );
  });

  test('keeps read and dismissal state independent for every user', async () => {
    const event = await seedEventAndRecipients(db, ['user-a', 'user-b']);

    const readAt = '2026-08-02T08:01:00.000Z';
    const dismissedAt = '2026-08-02T08:02:00.000Z';
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

  test('orders visible Inbox rows by recipient assignment time', async () => {
    const earlierEvent = createEvent({
      event_id: 'occurred-earlier',
      occurred_at: '2026-08-01T08:00:00.000Z',
    });
    const laterEvent = createEvent({
      event_id: 'occurred-later',
      occurred_at: '2026-08-02T08:00:00.000Z',
    });
    await db('notification_events').insert([earlierEvent, laterEvent]);
    await db('notification_user_states').insert([
      {
        event_id: laterEvent.event_id,
        user_id: 'user-a',
        read_at: '2026-08-02T09:01:00.000Z',
        created_at: '2026-08-02T09:00:00.000Z',
      },
      {
        event_id: earlierEvent.event_id,
        user_id: 'user-a',
        created_at: '2026-08-02T10:00:00.000Z',
      },
    ]);

    const rows = await db('notification_user_states')
      .select('event_id')
      .where({ user_id: 'user-a' })
      .whereNull('dismissed_at')
      .orderBy([
        { column: 'created_at', order: 'desc' },
        { column: 'event_id', order: 'desc' },
      ]);
    assert.deepStrictEqual(
      rows.map((row) => row.event_id),
      [earlierEvent.event_id, laterEvent.event_id],
    );

    const queryPlan = await db.raw(
      "EXPLAIN QUERY PLAN SELECT event_id FROM notification_user_states WHERE user_id = ? AND dismissed_at IS NULL ORDER BY created_at DESC, event_id DESC",
      ['user-a'],
    ) as Array<{ detail: string }>;
    assert.ok(
      queryPlan.some(({ detail }) => detail.includes('notification_user_states_visible_idx')),
    );
  });

  test('recovers pending deliveries and enforces delivery timestamp states', async () => {
    const event = await seedEventAndRecipients(db);
    const subscription = createSubscription();
    await db('push_subscriptions').insert(subscription);

    await db('push_delivery_attempts').insert({
      attempt_id: 'pending-attempt',
      deduplication_key: 'pending-attempt',
      event_id: event.event_id,
      user_id: 'user-a',
      subscription_id: subscription.subscription_id,
    });

    const pending = await db('push_delivery_attempts')
      .where({ status: 'pending' })
      .orderBy([{ column: 'created_at' }, { column: 'attempt_id' }]);
    assert.deepStrictEqual(pending.map((attempt) => attempt.attempt_id), ['pending-attempt']);
    assert.strictEqual(pending[0].attempted_at, null);
    assert.strictEqual(pending[0].next_retry_at, null);

    const queryPlan = await db.raw(
      "EXPLAIN QUERY PLAN SELECT attempt_id FROM push_delivery_attempts WHERE status = 'pending' ORDER BY created_at, attempt_id",
    ) as Array<{ detail: string }>;
    assert.ok(
      queryPlan.some(({ detail }) => detail.includes('push_delivery_attempts_pending_idx')),
    );

    await assert.rejects(
      db('push_delivery_attempts').insert({
        attempt_id: 'stranded-retry',
        deduplication_key: 'stranded-retry',
        event_id: event.event_id,
        user_id: 'user-a',
        subscription_id: subscription.subscription_id,
        attempt_number: 2,
        status: 'retryable',
        attempted_at: timestamp,
      }),
      /push_delivery_attempts_timestamps_check/i,
    );
    await assert.rejects(
      db('push_delivery_attempts').insert({
        attempt_id: 'already-attempted-pending',
        deduplication_key: 'already-attempted-pending',
        event_id: event.event_id,
        user_id: 'user-a',
        subscription_id: subscription.subscription_id,
        attempt_number: 3,
        status: 'pending',
        attempted_at: timestamp,
      }),
      /push_delivery_attempts_timestamps_check/i,
    );
  });

  test('versions a revoked endpoint across users without losing delivery history', async () => {
    const event = await seedEventAndRecipients(db, ['user-b']);
    const endpoint = 'https://push.example.test/shared-endpoint';
    const oldSubscription = createSubscription({
      subscription_id: 'subscription-old',
      user_id: 'user-b',
      endpoint,
    });
    await db('push_subscriptions').insert(oldSubscription);

    await assert.rejects(
      db('push_subscriptions').insert(createSubscription({
        subscription_id: 'subscription-active-duplicate',
        user_id: 'user-a',
        endpoint,
      })),
      /UNIQUE constraint failed: push_subscriptions\.endpoint/,
    );

    await db('push_delivery_attempts').insert({
      attempt_id: 'attempt-old',
      deduplication_key: 'attempt-old',
      event_id: event.event_id,
      user_id: 'user-b',
      subscription_id: oldSubscription.subscription_id,
      status: 'retryable',
      attempted_at: '2026-08-02T08:02:00.000Z',
      next_retry_at: '2026-08-02T08:07:00.000Z',
    });

    const revokedAt = '2026-08-02T08:03:00.000Z';
    await db('push_subscriptions')
      .where({ subscription_id: oldSubscription.subscription_id })
      .update({ revoked_at: revokedAt, updated_at: revokedAt });

    const newSubscription = createSubscription({
      subscription_id: 'subscription-new',
      user_id: 'user-a',
      endpoint,
    });
    await db('push_subscriptions').insert(newSubscription);

    const subscriptions = await db('push_subscriptions')
      .where({ endpoint })
      .orderBy('subscription_id');
    const attempt = await db('push_delivery_attempts')
      .where({ attempt_id: 'attempt-old' })
      .first();
    assert.strictEqual(subscriptions.length, 2);
    assert.strictEqual(
      subscriptions.find((subscription) => subscription.revoked_at === null)?.user_id,
      'user-a',
    );
    assert.strictEqual(attempt.subscription_id, oldSubscription.subscription_id);
    assert.strictEqual(attempt.user_id, 'user-b');
  });

  test('rejects delivery attempts with mismatched event or subscription ownership', async () => {
    const event = await seedEventAndRecipients(db, ['user-a']);
    const userBSubscription = createSubscription({
      subscription_id: 'subscription-user-b',
      user_id: 'user-b',
    });
    await db('push_subscriptions').insert(userBSubscription);

    await assert.rejects(
      db('push_delivery_attempts').insert({
        attempt_id: 'wrong-subscription-owner',
        deduplication_key: 'wrong-subscription-owner',
        event_id: event.event_id,
        user_id: 'user-a',
        subscription_id: userBSubscription.subscription_id,
      }),
      /FOREIGN KEY constraint failed/,
    );
    await assert.rejects(
      db('push_delivery_attempts').insert({
        attempt_id: 'wrong-event-owner',
        deduplication_key: 'wrong-event-owner',
        event_id: event.event_id,
        user_id: 'user-b',
        subscription_id: userBSubscription.subscription_id,
      }),
      /FOREIGN KEY constraint failed/,
    );
  });

  test('stores one mutable latest-activity row per task or indexing key', async () => {
    await db('notification_source_activity').insert({
      activity_type: 'task',
      activity_key: 'task-1',
      repository: 'integry/propr',
      status: 'processing',
      last_activity_at: timestamp,
      metadata_json: JSON.stringify({ worker: 'task-worker' }),
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
        metadata_json: JSON.stringify({ worker: 'task-worker' }),
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
      assert.strictEqual(await db.schema.hasTable(table), false, table + ' should be removed');
    }

    const triggers = await db.raw(
      "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'notification_events_immutable_%'",
    ) as Array<{ name: string }>;
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
      assert.strictEqual(upgradeMigrations[0], notificationMigrationName);
      assert.ok(upgradeMigrations.includes(notificationMigrationName));
      assert.strictEqual(await db.schema.hasTable('notification_events'), true);

      const [, repeatedMigrations] = await db.migrate.latest();
      assert.deepStrictEqual(repeatedMigrations, []);
    } finally {
      await db.destroy();
    }
  });
});
