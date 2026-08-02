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
  PUSH_DELIVERY_ATTEMPT_STATUSES,
  PUSH_DELIVERY_STATUSES,
  normalizeISO8601Timestamp,
  parseISO8601Timestamp,
  parseNotification,
  parseNotificationAction,
  parseNotificationEvent,
  parseNotificationListResponse,
  parseNotificationPreferences,
  parseNotificationPreferencesResponse,
  parseNotificationTarget,
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
  'push_delivery_jobs',
  'push_delivery_attempts',
  'notification_source_activity',
] as const;

const notificationMigrationName = '20260802000000_create_notification_schema.js';
const migrationsDirectory = fileURLToPath(
  new URL('../packages/core/src/db/migrations/', import.meta.url),
);
const timestamp = '2026-08-02T08:00:00.000Z';
const claimedAt = '2026-08-02T08:01:00.000Z';
const leaseExpiresAt = '2026-08-02T08:06:00.000Z';

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
  expires_at?: string | null;
  revoked_at?: string | null;
  created_at?: string;
  updated_at?: string;
}

interface RecipientInput {
  userId: string;
  inboxEnabled?: boolean;
  pushEnabled?: boolean;
  createdAt?: string;
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
  connection.pragma('recursive_triggers = ON');
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
  recipients: RecipientInput[] = [{ userId: 'user-a' }],
  overrides: Partial<EventRow> = {},
): Promise<EventRow> {
  const event = createEvent(overrides);
  await db('notification_events').insert(event);
  await db('notification_user_states').insert(
    recipients.map((recipient) => ({
      event_id: event.event_id,
      user_id: recipient.userId,
      inbox_enabled: recipient.inboxEnabled ?? true,
      push_enabled: recipient.pushEnabled ?? true,
      ...(recipient.createdAt === undefined
        ? {}
        : { created_at: recipient.createdAt }),
    })),
  );
  return event;
}

async function insertDeliveryJob(
  db: Knex,
  options: {
    jobId: string;
    eventId: string;
    userId?: string;
    subscriptionId: string;
    createdAt?: string;
  },
): Promise<void> {
  await db('push_delivery_jobs').insert({
    job_id: options.jobId,
    deduplication_key: 'delivery:' + options.jobId,
    event_id: options.eventId,
    user_id: options.userId ?? 'user-a',
    subscription_id: options.subscriptionId,
    ...(options.createdAt === undefined ? {} : {
      created_at: options.createdAt,
      updated_at: options.createdAt,
    }),
  });
}

async function claimJob(
  db: Knex,
  jobId: string,
  claimToken: string,
  claimTime = claimedAt,
  leaseTime = leaseExpiresAt,
): Promise<Array<Record<string, unknown>>> {
  return db.raw(
    `UPDATE push_delivery_jobs
     SET status = 'processing',
         claim_token = ?,
         claimed_at = ?,
         lease_expires_at = ?,
         next_retry_at = NULL
     WHERE job_id = (
       SELECT job_id
       FROM push_delivery_claimable_jobs
       WHERE job_id = ?
     )
       AND status IN ('pending', 'retryable')
     RETURNING *`,
    [claimToken, claimTime, leaseTime, jobId],
  ) as Promise<Array<Record<string, unknown>>>;
}

async function recordAttempt(
  db: Knex,
  options: {
    attemptId: string;
    jobId: string;
    attemptNumber: number;
    claimToken: string;
    status: 'delivered' | 'retryable' | 'failed';
    attemptedAt: string;
    nextRetryAt?: string;
    responseStatus?: number;
    errorCode?: string;
  },
): Promise<void> {
  await db('push_delivery_attempts').insert({
    attempt_id: options.attemptId,
    job_id: options.jobId,
    attempt_number: options.attemptNumber,
    status: options.status,
    claim_token: options.claimToken,
    attempted_at: options.attemptedAt,
    next_retry_at: options.nextRetryAt ?? null,
    response_status: options.responseStatus ?? null,
    error_code: options.errorCode ?? null,
    error_message: options.errorCode === undefined ? null : 'delivery failed',
  });
}

function createContractEvent(): Record<string, unknown> {
  return {
    id: 'event-runtime',
    deduplicationKey: 'notification:event-runtime',
    kind: 'task',
    severity: 'success',
    target: targetsByKind.task,
    title: 'Task completed',
    body: 'The task completed successfully.',
    action: {
      type: 'external_link',
      label: 'Open task',
      href: 'https://example.test/tasks/1',
    },
    metadata: { worker: 'task-worker' },
    occurredAt: timestamp,
    createdAt: timestamp,
  };
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

  test('exports complete enum contracts for jobs and immutable attempts', () => {
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
      'processing',
      'retryable',
      'delivered',
      'failed',
      'cancelled',
    ]);
    assert.deepStrictEqual(PUSH_DELIVERY_ATTEMPT_STATUSES, [
      'delivered',
      'retryable',
      'failed',
    ]);
    assert.deepStrictEqual(NOTIFICATION_SOURCE_ACTIVITY_TYPES, ['task', 'indexing']);
  });

  test('creates canonical TEXT timestamps, dispatch view, and polling indexes', async () => {
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
          tableName + '.' + column.name + ' should be canonical TEXT',
        );
      }
    }

    const view = await db('sqlite_master')
      .where({ type: 'view', name: 'push_delivery_claimable_jobs' })
      .first();
    assert.ok(view);
    assert.match(view.sql, /subscription\.revoked_at IS NULL/i);
    assert.match(view.sql, /subscription\.expires_at > strftime/i);
    assert.match(view.sql, /recipient\.push_enabled = 1/i);

    const indexNames = [
      'notification_user_states_visible_idx',
      'notification_user_states_unread_idx',
      'push_subscriptions_active_endpoint_idx',
      'push_delivery_jobs_pending_idx',
      'push_delivery_jobs_retry_idx',
      'push_delivery_jobs_processing_lease_idx',
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
      /WHERE inbox_enabled = 1 AND dismissed_at IS NULL/i,
    );
    assert.match(
      indexSql('notification_user_states_unread_idx'),
      /inbox_enabled = 1 AND read_at IS NULL AND dismissed_at IS NULL/i,
    );
    assert.match(
      indexSql('push_subscriptions_active_endpoint_idx'),
      /CREATE UNIQUE INDEX[\s\S]+WHERE revoked_at IS NULL/i,
    );
    assert.match(
      indexSql('push_delivery_jobs_pending_idx'),
      /WHERE status = 'pending'/i,
    );
    assert.match(
      indexSql('push_delivery_jobs_retry_idx'),
      /WHERE status = 'retryable' AND next_retry_at IS NOT NULL/i,
    );
    assert.match(
      indexSql('push_delivery_jobs_processing_lease_idx'),
      /WHERE status = 'processing' AND lease_expires_at IS NOT NULL/i,
    );

    const pendingPlan = await db.raw(
      "EXPLAIN QUERY PLAN SELECT job_id FROM push_delivery_jobs WHERE status = 'pending' ORDER BY created_at, job_id",
    ) as Array<{ detail: string }>;
    assert.ok(
      pendingPlan.some(({ detail }) => detail.includes('push_delivery_jobs_pending_idx')),
    );
    const retryPlan = await db.raw(
      "EXPLAIN QUERY PLAN SELECT job_id FROM push_delivery_jobs WHERE status = 'retryable' AND next_retry_at IS NOT NULL ORDER BY next_retry_at, job_id",
    ) as Array<{ detail: string }>;
    assert.ok(
      retryPlan.some(({ detail }) => detail.includes('push_delivery_jobs_retry_idx')),
    );
  });

  test('accepts every event, action, activity, and attempt enum value', async () => {
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
          href: actionType === 'navigate'
            ? '/tasks/1'
            : 'https://example.test/tasks/1',
        }),
      }));
    }

    await db('notification_preferences').insert(
      NOTIFICATION_KINDS.map((kind) => ({
        user_id: 'enum-user',
        notification_kind: kind,
      })),
    );
    await db('notification_source_activity').insert(
      NOTIFICATION_SOURCE_ACTIVITY_TYPES.map((activityType) => ({
        activity_type: activityType,
        activity_key: 'activity-' + activityType,
        repository: 'integry/propr',
        status: 'processing',
        last_activity_at: timestamp,
      })),
    );

    const event = await seedEventAndRecipients(db, [{ userId: 'attempt-user' }], {
      event_id: 'attempt-enums',
    });
    for (const [index, status] of PUSH_DELIVERY_ATTEMPT_STATUSES.entries()) {
      const subscription = createSubscription({
        subscription_id: 'attempt-subscription-' + status,
        user_id: 'attempt-user',
      });
      await db('push_subscriptions').insert(subscription);
      const jobId = 'attempt-job-' + status;
      await insertDeliveryJob(db, {
        jobId,
        eventId: event.event_id,
        userId: 'attempt-user',
        subscriptionId: subscription.subscription_id,
      });
      const token = 'claim-' + status;
      assert.strictEqual((await claimJob(db, jobId, token)).length, 1);
      await recordAttempt(db, {
        attemptId: 'attempt-' + status,
        jobId,
        attemptNumber: 1,
        claimToken: token,
        status,
        attemptedAt: '2026-08-02T08:02:00.000Z',
        ...(status === 'retryable'
          ? {
            nextRetryAt: '2099-08-02T08:07:00.000Z',
            errorCode: 'temporary',
          }
          : status === 'delivered'
            ? { responseStatus: 201 }
            : { errorCode: 'permanent' }),
      });

      const storedJob = await db('push_delivery_jobs').where({ job_id: jobId }).first();
      assert.strictEqual(storedJob.status, status);
      assert.strictEqual(storedJob.attempt_count, 1);
      assert.strictEqual(index >= 0, true);
    }

    const attempts = await db('push_delivery_attempts').select('status').orderBy('status');
    assert.deepStrictEqual(
      attempts.map((attempt) => attempt.status).sort(),
      [...PUSH_DELIVERY_ATTEMPT_STATUSES].sort(),
    );
  });

  test('rejects values outside the durable enum contracts', async () => {
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

  test('rejects incomplete targets and unsafe actions at SQL and runtime boundaries', async () => {
    const invalidEvents: Array<[string, Partial<EventRow>, RegExp]> = [
      ['malformed-target', { target_json: '{not-json' }, /target_json_check/i],
      [
        'mismatched-target',
        { kind: 'task', target_json: JSON.stringify(targetsByKind.review) },
        /target_kind_check/i,
      ],
      [
        'incomplete-target',
        { kind: 'task', target_json: JSON.stringify({ type: 'task' }) },
        /target_contract_check/i,
      ],
      [
        'invalid-target-number',
        {
          kind: 'review',
          target_json: JSON.stringify({
            type: 'review',
            repository: 'integry/propr',
            prNumber: 0,
          }),
        },
        /target_contract_check/i,
      ],
      [
        'invalid-target-repository',
        {
          kind: 'task',
          target_json: JSON.stringify({
            type: 'task',
            repository: 'not-a-repository-slug',
            taskId: 'task-1',
          }),
        },
        /target_contract_check/i,
      ],
      ['malformed-action', { action_json: '{not-json' }, /action_json_check/i],
      [
        'missing-action-fields',
        { action_json: JSON.stringify({ type: 'external_link' }) },
        /action_json_check/i,
      ],
      [
        'unsafe-action-scheme',
        {
          action_json: JSON.stringify({
            type: 'external_link',
            label: 'Open',
            href: 'javascript:alert(1)',
          }),
        },
        /action_json_check/i,
      ],
      [
        'protocol-relative-action',
        {
          action_json: JSON.stringify({
            type: 'navigate',
            label: 'Open',
            href: '//example.test/task',
          }),
        },
        /action_json_check/i,
      ],
    ];

    for (const [eventId, overrides, error] of invalidEvents) {
      await assert.rejects(
        db('notification_events').insert(createEvent({
          event_id: eventId,
          ...overrides,
        })),
        error,
      );
    }

    assert.throws(
      () => parseNotificationTarget({ type: 'task' }),
      /target\.repository/,
    );
    assert.throws(
      () => parseNotificationTarget({
        type: 'review',
        repository: 'integry/propr',
        prNumber: 1.5,
      }),
      /positive integer/,
    );
    assert.throws(
      () => parseNotificationAction({
        type: 'external_link',
        label: 'Open',
        href: 'javascript:alert(1)',
      }),
      /absolute HTTP\(S\) URL/,
    );
    assert.throws(
      () => parseNotificationAction({
        type: 'navigate',
        label: 'Open',
        href: '//example.test/task',
      }),
      /application-relative path/,
    );

    const event = parseNotificationEvent(createContractEvent());
    assert.strictEqual(event.kind, 'task');
    assert.strictEqual(event.target.taskId, 'task-1');
    const notification = parseNotification({
      ...createContractEvent(),
      readAt: null,
      dismissedAt: timestamp,
    });
    assert.strictEqual(notification.dismissedAt, timestamp);
    const listResponse = parseNotificationListResponse({
      notifications: [{
        ...createContractEvent(),
        readAt: null,
        dismissedAt: null,
      }],
      unreadCount: 1,
      nextCursor: 'cursor-1',
    });
    assert.strictEqual(listResponse.notifications.length, 1);
    assert.throws(
      () => parseNotificationListResponse({
        notifications: [],
        unreadCount: -1,
        nextCursor: null,
      }),
      /nonnegative integer/,
    );
  });

  test('normalizes timestamps at runtime and rejects noncanonical database values', async () => {
    assert.strictEqual(
      normalizeISO8601Timestamp('2026-08-02T10:00:00+02:00'),
      timestamp,
    );
    assert.strictEqual(parseISO8601Timestamp(timestamp), timestamp);
    assert.throws(
      () => parseISO8601Timestamp('2026-08-02T10:00:00+02:00'),
      /canonical ISO-8601/,
    );
    assert.throws(
      () => parseISO8601Timestamp('2026-02-31T08:00:00.000Z'),
      /canonical ISO-8601/,
    );

    await assert.rejects(
      db('notification_events').insert(createEvent({
        event_id: 'offset-time',
        occurred_at: '2026-08-02T10:00:00+02:00',
      })),
      /notification_events_occurred_at_check/i,
    );
    await assert.rejects(
      db('notification_source_activity').insert({
        activity_type: 'task',
        activity_key: 'invalid-date',
        repository: 'integry/propr',
        status: 'processing',
        last_activity_at: '2026-02-31T08:00:00.000Z',
      }),
      /notification_source_activity_last_activity_at_check/i,
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

  test('snapshots independent Inbox and Push eligibility per recipient', async () => {
    const event = await seedEventAndRecipients(db, [
      { userId: 'push-only', inboxEnabled: false, pushEnabled: true },
      { userId: 'inbox-only', inboxEnabled: true, pushEnabled: false },
      { userId: 'both', inboxEnabled: true, pushEnabled: true },
    ], { event_id: 'channel-event' });

    const visibleRows = await db('notification_user_states')
      .select('user_id')
      .whereIn('user_id', ['push-only', 'inbox-only', 'both'])
      .where({ inbox_enabled: true })
      .whereNull('dismissed_at')
      .orderBy('user_id');
    assert.deepStrictEqual(
      visibleRows.map((row) => row.user_id),
      ['both', 'inbox-only'],
    );

    for (const userId of ['push-only', 'inbox-only', 'both']) {
      await db('push_subscriptions').insert(createSubscription({
        subscription_id: 'channel-subscription-' + userId,
        user_id: userId,
      }));
    }
    await insertDeliveryJob(db, {
      jobId: 'push-only-job',
      eventId: event.event_id,
      userId: 'push-only',
      subscriptionId: 'channel-subscription-push-only',
    });
    await insertDeliveryJob(db, {
      jobId: 'both-job',
      eventId: event.event_id,
      userId: 'both',
      subscriptionId: 'channel-subscription-both',
    });
    await assert.rejects(
      insertDeliveryJob(db, {
        jobId: 'inbox-only-job',
        eventId: event.event_id,
        userId: 'inbox-only',
        subscriptionId: 'channel-subscription-inbox-only',
      }),
      /push delivery requires an eligible recipient/,
    );

    await db('notification_preferences').insert({
      user_id: 'push-only',
      notification_kind: 'task',
      inbox_enabled: true,
      push_enabled: false,
    });
    const pushOnlyState = await db('notification_user_states')
      .where({ event_id: event.event_id, user_id: 'push-only' })
      .first();
    assert.strictEqual(pushOnlyState.inbox_enabled, 0);
    assert.strictEqual(pushOnlyState.push_enabled, 1);

    await assert.rejects(
      db('notification_user_states')
        .where({ event_id: event.event_id, user_id: 'push-only' })
        .update({ inbox_enabled: true }),
      /notification recipient assignment is immutable/,
    );
    await assert.rejects(
      db('notification_user_states').insert({
        event_id: event.event_id,
        user_id: 'no-channels',
        inbox_enabled: false,
        push_enabled: false,
      }),
      /notification_user_states_channel_required_check/i,
    );
  });

  test('constrains preference booleans and validates one complete response shape', async () => {
    await assert.rejects(
      db('notification_preferences').insert({
        user_id: 'invalid-inbox',
        notification_kind: 'task',
        inbox_enabled: 2,
      }),
      /notification_preferences_inbox_boolean_check/i,
    );
    await assert.rejects(
      db('notification_preferences').insert({
        user_id: 'invalid-push',
        notification_kind: 'task',
        push_enabled: -1,
      }),
      /notification_preferences_push_boolean_check/i,
    );

    const snapshot = Object.fromEntries(NOTIFICATION_KINDS.map((kind) => [
      kind,
      {
        inboxEnabled: kind !== 'system_failure',
        pushEnabled: true,
        updatedAt: timestamp,
      },
    ]));
    const parsed = parseNotificationPreferences(snapshot);
    assert.deepStrictEqual(Object.keys(parsed), [...NOTIFICATION_KINDS]);
    assert.strictEqual(parsed.task.updatedAt, timestamp);
    assert.deepStrictEqual(
      parseNotificationPreferencesResponse({ preferences: snapshot }).preferences,
      parsed,
    );
    assert.throws(
      () => parseNotificationPreferences({ task: snapshot.task }),
      /preferences\.plan/,
    );
  });

  test('orders only Inbox-eligible rows by recipient assignment time', async () => {
    const earlierEvent = createEvent({
      event_id: 'occurred-earlier',
      occurred_at: '2026-08-01T08:00:00.000Z',
    });
    const laterEvent = createEvent({
      event_id: 'occurred-later',
      occurred_at: '2026-08-02T08:00:00.000Z',
    });
    const pushOnlyEvent = createEvent({
      event_id: 'push-only-hidden',
      occurred_at: timestamp,
    });
    await db('notification_events').insert([earlierEvent, laterEvent, pushOnlyEvent]);
    await db('notification_user_states').insert([
      {
        event_id: laterEvent.event_id,
        user_id: 'user-a',
        inbox_enabled: true,
        push_enabled: true,
        read_at: '2026-08-02T09:01:00.000Z',
        created_at: '2026-08-02T09:00:00.000Z',
      },
      {
        event_id: earlierEvent.event_id,
        user_id: 'user-a',
        inbox_enabled: true,
        push_enabled: true,
        created_at: '2026-08-02T10:00:00.000Z',
      },
      {
        event_id: pushOnlyEvent.event_id,
        user_id: 'user-a',
        inbox_enabled: false,
        push_enabled: true,
        created_at: '2026-08-02T11:00:00.000Z',
      },
    ]);

    const rows = await db('notification_user_states')
      .select('event_id')
      .where({ user_id: 'user-a', inbox_enabled: true })
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
      "EXPLAIN QUERY PLAN SELECT event_id FROM notification_user_states WHERE user_id = ? AND inbox_enabled = 1 AND dismissed_at IS NULL ORDER BY created_at DESC, event_id DESC",
      ['user-a'],
    ) as Array<{ detail: string }>;
    assert.ok(
      queryPlan.some(({ detail }) => detail.includes('notification_user_states_visible_idx')),
    );
  });

  test('claims a delivery atomically and only reclaims an expired lease', async () => {
    const event = await seedEventAndRecipients(db);
    const subscription = createSubscription();
    await db('push_subscriptions').insert(subscription);
    await insertDeliveryJob(db, {
      jobId: 'atomic-job',
      eventId: event.event_id,
      subscriptionId: subscription.subscription_id,
    });

    await assert.rejects(
      db('push_delivery_jobs')
        .where({ job_id: 'atomic-job' })
        .update({
          status: 'processing',
          claimed_at: claimedAt,
          lease_expires_at: leaseExpiresAt,
        }),
      /push_delivery_jobs_state_check/i,
    );

    const firstClaim = await claimJob(db, 'atomic-job', 'worker-a');
    const competingClaim = await claimJob(db, 'atomic-job', 'worker-b');
    assert.strictEqual(firstClaim.length, 1);
    assert.strictEqual(competingClaim.length, 0);

    let job = await db('push_delivery_jobs').where({ job_id: 'atomic-job' }).first();
    assert.strictEqual(job.status, 'processing');
    assert.strictEqual(job.claim_token, 'worker-a');

    await assert.rejects(
      db('push_delivery_jobs')
        .where({ job_id: 'atomic-job' })
        .update({
          claim_token: 'worker-early',
          claimed_at: '2026-08-02T08:05:59.999Z',
          lease_expires_at: '2026-08-02T08:10:59.999Z',
        }),
      /invalid push delivery job transition/,
    );

    const reclaimed = await db('push_delivery_jobs')
      .where({ job_id: 'atomic-job', status: 'processing' })
      .update({
        claim_token: 'worker-c',
        claimed_at: '2026-08-02T08:06:00.000Z',
        lease_expires_at: '2026-08-02T08:11:00.000Z',
      });
    assert.strictEqual(reclaimed, 1);
    job = await db('push_delivery_jobs').where({ job_id: 'atomic-job' }).first();
    assert.strictEqual(job.claim_token, 'worker-c');

    await assert.rejects(
      db('push_delivery_attempts').insert({
        attempt_id: 'missing-outcome-detail',
        job_id: 'atomic-job',
        attempt_number: 1,
        status: 'failed',
        attempted_at: '2026-08-02T08:07:00.000Z',
        claim_token: 'worker-c',
      }),
      /push_delivery_attempts_outcome_check/i,
    );

    await assert.rejects(
      db('push_delivery_attempts').insert({
        attempt_id: 'stale-worker-attempt',
        job_id: 'atomic-job',
        attempt_number: 1,
        status: 'delivered',
        response_status: 201,
        attempted_at: '2026-08-02T08:07:00.000Z',
        claim_token: 'worker-a',
      }),
      /does not own the active claim/,
    );
  });

  test('separates retry scheduling from append-only attempt audit history', async () => {
    const event = await seedEventAndRecipients(db);
    const subscription = createSubscription();
    await db('push_subscriptions').insert(subscription);
    await insertDeliveryJob(db, {
      jobId: 'retry-job',
      eventId: event.event_id,
      subscriptionId: subscription.subscription_id,
    });
    await claimJob(db, 'retry-job', 'retry-worker');

    const retryAt = '2026-08-02T08:10:00.000Z';
    await recordAttempt(db, {
      attemptId: 'retry-attempt-1',
      jobId: 'retry-job',
      attemptNumber: 1,
      claimToken: 'retry-worker',
      status: 'retryable',
      attemptedAt: '2026-08-02T08:02:00.000Z',
      nextRetryAt: retryAt,
      errorCode: 'timeout',
    });

    let job = await db('push_delivery_jobs').where({ job_id: 'retry-job' }).first();
    assert.strictEqual(job.status, 'retryable');
    assert.strictEqual(job.next_retry_at, retryAt);
    assert.strictEqual(job.attempt_count, 1);

    await assert.rejects(
      db('push_delivery_attempts')
        .where({ attempt_id: 'retry-attempt-1' })
        .update({ error_code: 'rewritten' }),
      /push delivery attempts are immutable/,
    );
    await assert.rejects(
      db('push_delivery_attempts')
        .where({ attempt_id: 'retry-attempt-1' })
        .delete(),
      /push delivery attempts are immutable/,
    );

    const secondClaim = await db('push_delivery_jobs')
      .where({ job_id: 'retry-job', status: 'retryable' })
      .update({
        status: 'processing',
        next_retry_at: null,
        claim_token: 'retry-worker-2',
        claimed_at: retryAt,
        lease_expires_at: '2026-08-02T08:15:00.000Z',
      });
    assert.strictEqual(secondClaim, 1);
    await recordAttempt(db, {
      attemptId: 'retry-attempt-2',
      jobId: 'retry-job',
      attemptNumber: 2,
      claimToken: 'retry-worker-2',
      status: 'delivered',
      attemptedAt: '2026-08-02T08:11:00.000Z',
      responseStatus: 201,
    });

    job = await db('push_delivery_jobs').where({ job_id: 'retry-job' }).first();
    const attempts = await db('push_delivery_attempts')
      .where({ job_id: 'retry-job' })
      .orderBy('attempt_number');
    assert.strictEqual(job.status, 'delivered');
    assert.strictEqual(job.attempt_count, 2);
    assert.deepStrictEqual(
      attempts.map((attempt) => [attempt.attempt_number, attempt.status]),
      [[1, 'retryable'], [2, 'delivered']],
    );

    await assert.rejects(
      db('push_delivery_jobs')
        .where({ job_id: 'retry-job' })
        .update({ status: 'pending', attempt_count: 0 }),
      /invalid push delivery job transition/,
    );
    await assert.rejects(
      db('push_delivery_jobs').where({ job_id: 'retry-job' }).delete(),
      /push delivery jobs cannot be deleted/,
    );
  });

  test('cancels queued work on revocation and filters naturally expired subscriptions', async () => {
    const event = await seedEventAndRecipients(db);
    const subscription = createSubscription({
      subscription_id: 'subscription-revoked',
      endpoint: 'https://push.example.test/versioned-endpoint',
    });
    await db('push_subscriptions').insert(subscription);
    await insertDeliveryJob(db, {
      jobId: 'revoked-job',
      eventId: event.event_id,
      subscriptionId: subscription.subscription_id,
    });
    await claimJob(db, 'revoked-job', 'revoked-worker');
    await recordAttempt(db, {
      attemptId: 'revoked-attempt-1',
      jobId: 'revoked-job',
      attemptNumber: 1,
      claimToken: 'revoked-worker',
      status: 'retryable',
      attemptedAt: '2026-08-02T08:02:00.000Z',
      nextRetryAt: '2099-08-02T08:07:00.000Z',
      errorCode: 'temporary',
    });

    const revokedAt = '2026-08-02T08:03:00.000Z';
    await db('push_subscriptions')
      .where({ subscription_id: subscription.subscription_id })
      .update({ revoked_at: revokedAt });

    const cancelled = await db('push_delivery_jobs')
      .where({ job_id: 'revoked-job' })
      .first();
    const historicalAttempt = await db('push_delivery_attempts')
      .where({ attempt_id: 'revoked-attempt-1' })
      .first();
    assert.strictEqual(cancelled.status, 'cancelled');
    assert.strictEqual(historicalAttempt.status, 'retryable');
    assert.strictEqual(
      await db('push_delivery_claimable_jobs').where({ job_id: 'revoked-job' }).first(),
      undefined,
    );

    await assert.rejects(
      db('push_subscriptions')
        .where({ subscription_id: subscription.subscription_id })
        .update({ endpoint: 'https://push.example.test/rewritten' }),
      /revoked push subscriptions are immutable/,
    );
    await assert.rejects(
      db('push_subscriptions')
        .where({ subscription_id: subscription.subscription_id })
        .delete(),
      /revoked push subscriptions cannot be deleted/,
    );
    await db('push_subscriptions').insert(createSubscription({
      subscription_id: 'subscription-version-2',
      user_id: 'user-b',
      endpoint: subscription.endpoint,
    }));

    const processingSubscription = createSubscription({
      subscription_id: 'processing-subscription',
    });
    await db('push_subscriptions').insert(processingSubscription);
    await insertDeliveryJob(db, {
      jobId: 'processing-revoked-job',
      eventId: event.event_id,
      subscriptionId: processingSubscription.subscription_id,
    });
    await claimJob(db, 'processing-revoked-job', 'processing-worker');
    await db('push_subscriptions')
      .where({ subscription_id: processingSubscription.subscription_id })
      .update({ revoked_at: revokedAt });
    const processingJob = await db('push_delivery_jobs')
      .where({ job_id: 'processing-revoked-job' })
      .first();
    assert.strictEqual(processingJob.status, 'cancelled');
    await assert.rejects(
      db('push_delivery_attempts').insert({
        attempt_id: 'attempt-after-revocation',
        job_id: 'processing-revoked-job',
        attempt_number: 1,
        status: 'delivered',
        response_status: 201,
        attempted_at: '2026-08-02T08:04:00.000Z',
        claim_token: 'processing-worker',
      }),
      /does not own the active claim/,
    );

    const expiredEvent = await seedEventAndRecipients(db, [{ userId: 'expired-user' }], {
      event_id: 'expired-event',
    });
    const expiredSubscription = createSubscription({
      subscription_id: 'expired-subscription',
      user_id: 'expired-user',
      expires_at: '2020-01-02T00:00:00.000Z',
    });
    await db('push_subscriptions').insert(expiredSubscription);
    await insertDeliveryJob(db, {
      jobId: 'expired-job',
      eventId: expiredEvent.event_id,
      userId: 'expired-user',
      subscriptionId: expiredSubscription.subscription_id,
      createdAt: '2020-01-01T00:00:00.000Z',
    });
    assert.strictEqual(
      await db('push_delivery_claimable_jobs').where({ job_id: 'expired-job' }).first(),
      undefined,
    );
    await assert.rejects(
      db('push_delivery_jobs')
        .where({ job_id: 'expired-job' })
        .update({
          status: 'processing',
          claim_token: 'expired-worker',
          claimed_at: timestamp,
          lease_expires_at: leaseExpiresAt,
        }),
      /cannot claim delivery for an inactive subscription/,
    );
  });

  test('cancels existing jobs when an active subscription becomes expired', async () => {
    const event = await seedEventAndRecipients(db);
    const subscription = createSubscription({
      subscription_id: 'newly-expired-subscription',
      expires_at: '2099-01-01T00:00:00.000Z',
    });
    await db('push_subscriptions').insert(subscription);
    await insertDeliveryJob(db, {
      jobId: 'newly-expired-job',
      eventId: event.event_id,
      subscriptionId: subscription.subscription_id,
    });

    await db('push_subscriptions')
      .where({ subscription_id: subscription.subscription_id })
      .update({ expires_at: '2020-01-01T00:00:00.000Z' });

    const job = await db('push_delivery_jobs')
      .where({ job_id: 'newly-expired-job' })
      .first();
    assert.strictEqual(job.status, 'cancelled');
  });

  test('rejects delivery ownership mismatches and attempts without a live claim', async () => {
    const event = await seedEventAndRecipients(db, [{ userId: 'user-a' }]);
    const userBSubscription = createSubscription({
      subscription_id: 'subscription-user-b',
      user_id: 'user-b',
    });
    await db('push_subscriptions').insert(userBSubscription);

    await assert.rejects(
      insertDeliveryJob(db, {
        jobId: 'wrong-subscription-owner',
        eventId: event.event_id,
        userId: 'user-a',
        subscriptionId: userBSubscription.subscription_id,
      }),
      /eligible recipient|FOREIGN KEY constraint failed/,
    );

    const userASubscription = createSubscription();
    await db('push_subscriptions').insert(userASubscription);
    await insertDeliveryJob(db, {
      jobId: 'unclaimed-job',
      eventId: event.event_id,
      subscriptionId: userASubscription.subscription_id,
    });
    await assert.rejects(
      db('push_delivery_attempts').insert({
        attempt_id: 'unclaimed-attempt',
        job_id: 'unclaimed-job',
        attempt_number: 1,
        status: 'delivered',
        response_status: 201,
        attempted_at: '2026-08-02T08:02:00.000Z',
        claim_token: 'no-claim',
      }),
      /does not own the active claim/,
    );
  });

  test('automatically advances updated_at for ordinary updates and conflict merges', async () => {
    const oldTimestamp = '2020-01-01T00:00:00.000Z';
    await db('notification_preferences').insert({
      user_id: 'touch-user',
      notification_kind: 'task',
      created_at: oldTimestamp,
      updated_at: oldTimestamp,
    });
    await db('notification_preferences')
      .where({ user_id: 'touch-user', notification_kind: 'task' })
      .update({ push_enabled: false });
    const preference = await db('notification_preferences')
      .where({ user_id: 'touch-user', notification_kind: 'task' })
      .first();
    assert.ok(preference.updated_at > oldTimestamp);

    await db('push_subscriptions').insert(createSubscription({
      subscription_id: 'touch-subscription',
      created_at: oldTimestamp,
      updated_at: oldTimestamp,
    }));
    await db('push_subscriptions')
      .where({ subscription_id: 'touch-subscription' })
      .update({ last_used_at: timestamp });
    const subscription = await db('push_subscriptions')
      .where({ subscription_id: 'touch-subscription' })
      .first();
    assert.ok(subscription.updated_at > oldTimestamp);

    await db('notification_source_activity').insert({
      activity_type: 'task',
      activity_key: 'touch-activity',
      repository: 'integry/propr',
      status: 'processing',
      last_activity_at: oldTimestamp,
      created_at: oldTimestamp,
      updated_at: oldTimestamp,
    });
    await db('notification_source_activity')
      .insert({
        activity_type: 'task',
        activity_key: 'touch-activity',
        repository: 'integry/propr',
        status: 'processing',
        last_activity_at: timestamp,
      })
      .onConflict(['activity_type', 'activity_key'])
      .merge(['repository', 'status', 'last_activity_at']);
    const activity = await db('notification_source_activity')
      .where({ activity_type: 'task', activity_key: 'touch-activity' })
      .first();
    assert.ok(activity.updated_at > oldTimestamp);
    assert.match(activity.updated_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  test('ignores stale activity upserts and never reopens completed work', async () => {
    await db('notification_source_activity').insert({
      activity_type: 'task',
      activity_key: 'task-monotonic',
      repository: 'integry/propr',
      status: 'processing',
      last_activity_at: '2026-08-02T08:10:00.000Z',
      metadata_json: JSON.stringify({ worker: 'new-worker' }),
    });

    await db('notification_source_activity')
      .insert({
        activity_type: 'task',
        activity_key: 'task-monotonic',
        repository: 'integry/propr',
        status: 'queued',
        last_activity_at: timestamp,
        metadata_json: JSON.stringify({ worker: 'stale-worker' }),
      })
      .onConflict(['activity_type', 'activity_key'])
      .merge();

    let activity = await db('notification_source_activity')
      .where({ activity_type: 'task', activity_key: 'task-monotonic' })
      .first();
    assert.strictEqual(activity.last_activity_at, '2026-08-02T08:10:00.000Z');
    assert.strictEqual(activity.status, 'processing');
    assert.strictEqual(JSON.parse(activity.metadata_json).worker, 'new-worker');

    await db('notification_source_activity')
      .insert({
        activity_type: 'task',
        activity_key: 'task-monotonic',
        repository: 'integry/propr',
        status: 'completed',
        last_activity_at: '2026-08-02T08:20:00.000Z',
        completed_at: '2026-08-02T08:20:00.000Z',
      })
      .onConflict(['activity_type', 'activity_key'])
      .merge(['repository', 'status', 'last_activity_at', 'completed_at']);
    await db('notification_source_activity')
      .insert({
        activity_type: 'task',
        activity_key: 'task-monotonic',
        repository: 'integry/propr',
        status: 'processing',
        last_activity_at: '2026-08-02T08:30:00.000Z',
        completed_at: null,
      })
      .onConflict(['activity_type', 'activity_key'])
      .merge(['repository', 'status', 'last_activity_at', 'completed_at']);

    activity = await db('notification_source_activity')
      .where({ activity_type: 'task', activity_key: 'task-monotonic' })
      .first();
    assert.strictEqual(activity.status, 'completed');
    assert.strictEqual(activity.last_activity_at, '2026-08-02T08:20:00.000Z');
    assert.strictEqual(activity.completed_at, '2026-08-02T08:20:00.000Z');
  });

  test('rolls back every notification table, view, and trigger', async () => {
    await down(db);

    for (const table of notificationTables) {
      assert.strictEqual(await db.schema.hasTable(table), false, table + ' should be removed');
    }
    const schemaObjects = await db('sqlite_master')
      .select('name')
      .whereIn('type', ['trigger', 'view'])
      .where((query) => query
        .whereLike('name', 'notification_%')
        .orWhereLike('name', 'push_delivery_%')
        .orWhereLike('name', 'push_subscriptions_%'));
    assert.deepStrictEqual(schemaObjects, []);
  });
});

describe('notification migration runner compatibility', { concurrency: false }, () => {
  test('migrates a fresh database and rolls the notification migration back and up', async () => {
    const db = createMigrationRunnerDatabase();
    try {
      const [, migrations] = await db.migrate.latest();
      assert.ok(migrations.includes(notificationMigrationName));
      assert.strictEqual(await db.schema.hasTable('notification_events'), true);
      assert.strictEqual(await db.schema.hasTable('push_delivery_jobs'), true);

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
      assert.strictEqual(await db.schema.hasTable('push_delivery_attempts'), true);

      const [, repeatedMigrations] = await db.migrate.latest();
      assert.deepStrictEqual(repeatedMigrations, []);
    } finally {
      await db.destroy();
    }
  });
});
