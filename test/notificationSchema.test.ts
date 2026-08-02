import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import knex, { type Knex } from 'knex';
import {
  NOTIFICATION_ACTION_TYPES,
  NOTIFICATION_KINDS,
  NOTIFICATION_SEVERITIES,
  NOTIFICATION_SOURCE_ACTIVITY_TYPES,
  NOTIFICATION_SOURCE_ACTIVITY_STATUSES,
  PUSH_DELIVERY_ATTEMPT_STATUSES,
  PUSH_DELIVERY_STATUSES,
  normalizeISO8601Timestamp,
  parseISO8601Timestamp,
  parseNotification,
  parseNotificationAction,
  parseNotificationEvent,
  parseNotificationListResponse,
  parseNotificationSourceActivity,
  parseNotificationUserState,
  parseNotificationPreferences,
  parseNotificationPreferencesResponse,
  parseNotificationTarget,
  parsePushDeliveryAttempt,
  parsePushDeliveryJob,
  parsePushSubscription,
  parsePushSubscriptionInput,
  parsePushSubscriptionsResponse,
  type NotificationKind,
} from '../packages/shared/src/index.ts';
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
const leaseExpiresAt = '2099-08-02T08:06:00.000Z';

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
  connection.pragma('busy_timeout = 1000');
  done(null, connection);
}

function createSchemaDatabase(filename = ':memory:'): Knex {
  return knex({
    client: 'better-sqlite3',
    connection: { filename },
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
  const createdAt = options.createdAt ?? timestamp;
  await db('push_delivery_jobs').insert({
    job_id: options.jobId,
    deduplication_key: 'delivery:' + options.jobId,
    event_id: options.eventId,
    user_id: options.userId ?? 'user-a',
    subscription_id: options.subscriptionId,
    created_at: createdAt,
    updated_at: createdAt,
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
     RETURNING *`,
    [claimToken, claimTime, leaseTime, jobId],
  ) as Promise<Array<Record<string, unknown>>>;
}

async function claimJobUsingDatabaseTime(
  db: Knex,
  jobId: string,
  claimToken: string,
  leaseModifier = '+5 minutes',
): Promise<Array<Record<string, unknown>>> {
  return db.raw(
    `UPDATE push_delivery_jobs
     SET status = 'processing',
         claim_token = ?,
         claimed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
         lease_expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?),
         next_retry_at = NULL
     WHERE job_id = (
       SELECT job_id
       FROM push_delivery_claimable_jobs
       WHERE job_id = ?
     )
     RETURNING *`,
    [claimToken, leaseModifier, jobId],
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
    assert.deepStrictEqual(NOTIFICATION_SOURCE_ACTIVITY_STATUSES, [
      'queued',
      'processing',
      'completed',
      'failed',
      'cancelled',
    ]);
  });

  test('creates canonical TEXT timestamps, dispatch view, and polling indexes', async () => {
    const pragmas = {
      foreignKeys: await db.raw('PRAGMA foreign_keys') as Array<{ foreign_keys: number }>,
      recursiveTriggers: await db.raw('PRAGMA recursive_triggers') as Array<{
        recursive_triggers: number;
      }>,
    };
    assert.strictEqual(pragmas.foreignKeys[0]?.foreign_keys, 1);
    assert.strictEqual(pragmas.recursiveTriggers[0]?.recursive_triggers, 1);

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

    const cancellationView = await db('sqlite_master')
      .where({ type: 'view', name: 'push_delivery_jobs_requiring_cancellation' })
      .first();
    assert.ok(cancellationView);
    assert.match(cancellationView.sql, /subscription\.expires_at <= strftime/i);
    assert.match(cancellationView.sql, /job\.lease_expires_at <= strftime/i);

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
    await assert.rejects(
      db('notification_source_activity').insert({
        activity_type: 'task',
        activity_key: 'invalid-status',
        repository: 'integry/propr',
        status: 'running',
        last_activity_at: timestamp,
      }),
      /notification_source_activity_status_check/i,
    );
    await assert.rejects(
      db('notification_source_activity').insert({
        activity_type: 'task',
        activity_key: 'contradictory-status',
        repository: 'integry/propr',
        status: 'processing',
        last_activity_at: timestamp,
        completed_at: timestamp,
      }),
      /notification_source_activity_completion_state_check/i,
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

  test('keeps immutable SQL action and target validation compatible with runtime parsing', async () => {
    const actionCorpus: Array<{
      id: string;
      action: Record<string, unknown>;
      valid: boolean;
    }> = [
      {
        id: 'valid-navigation',
        action: { type: 'navigate', label: 'Open', href: '/tasks/1?tab=logs' },
        valid: true,
      },
      {
        id: 'valid-external-port',
        action: {
          type: 'external_link',
          label: 'Open',
          href: 'https://example.test:443/tasks/1',
        },
        valid: true,
      },
      {
        id: 'missing-host',
        action: { type: 'external_link', label: 'Open', href: 'https://?x' },
        valid: false,
      },
      {
        id: 'credentials',
        action: {
          type: 'external_link',
          label: 'Open',
          href: 'https://user:secret@example.test/task',
        },
        valid: false,
      },
      {
        id: 'malformed-port',
        action: {
          type: 'external_link',
          label: 'Open',
          href: 'https://example.test:not-a-port/task',
        },
        valid: false,
      },
      {
        id: 'out-of-range-port',
        action: {
          type: 'external_link',
          label: 'Open',
          href: 'https://example.test:65536/task',
        },
        valid: false,
      },
      {
        id: 'invalid-numeric-host-notation',
        action: {
          type: 'external_link',
          label: 'Open',
          href: 'https://0x100000000f/task',
        },
        valid: false,
      },
      {
        id: 'invalid-dotted-numeric-host-notation',
        action: {
          type: 'external_link',
          label: 'Open',
          href: 'https://example.0x100000000f/task',
        },
        valid: false,
      },
    ];

    for (const { id, action, valid } of actionCorpus) {
      let runtimeAccepted = true;
      try {
        parseNotificationAction(action);
      } catch {
        runtimeAccepted = false;
      }
      assert.strictEqual(runtimeAccepted, valid, id + ' runtime result');

      const insertion = db('notification_events').insert(createEvent({
        event_id: 'action-corpus-' + id,
        action_json: JSON.stringify(action),
      }));
      if (valid) {
        await insertion;
      } else {
        await assert.rejects(insertion, /notification_events_action_json_check/i);
      }
    }

    const javascriptWhitespaceCodepoints = [
      9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196,
      8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288,
      65279,
    ];
    for (const codepoint of javascriptWhitespaceCodepoints) {
      const whitespace = String.fromCodePoint(codepoint);
      const target = {
        type: 'task',
        repository: 'integry/propr',
        taskId: whitespace,
      };
      assert.throws(() => parseNotificationTarget(target), /non-empty string/);
      await assert.rejects(
        db('notification_events').insert(createEvent({
          event_id: 'target-whitespace-' + codepoint,
          target_json: JSON.stringify(target),
        })),
        /notification_events_target_contract_check/i,
      );
    }

    for (let codepoint = 0; codepoint <= 31; codepoint += 1) {
      const action = {
        type: 'navigate',
        label: 'Open',
        href: '/tasks/' + String.fromCodePoint(codepoint),
      };
      assert.throws(() => parseNotificationAction(action), /application-relative path/);
      await assert.rejects(
        db('notification_events').insert(createEvent({
          event_id: 'navigation-control-' + codepoint,
          action_json: JSON.stringify(action),
        })),
        /notification_events_action_json_check/i,
      );
    }

    const incompatibleTargets = [
      {
        type: 'task',
        repository: 'integry\u00a0/propr',
        taskId: 'task-1',
      },
      {
        type: 'review',
        repository: 'integry/propr',
        prNumber: Number.MAX_SAFE_INTEGER + 1,
      },
    ];
    for (const [index, target] of incompatibleTargets.entries()) {
      assert.throws(() => parseNotificationTarget(target));
      await assert.rejects(
        db('notification_events').insert(createEvent({
          event_id: 'incompatible-target-' + index,
          kind: target.type,
          target_json: JSON.stringify(target),
        })),
        /notification_events_target_contract_check/i,
      );
    }
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

  test('rejects null, empty, and whitespace-only durable identifiers', async () => {
    const primaryIdentifiers = [
      ['notification_events', 'event_id'],
      ['push_subscriptions', 'subscription_id'],
      ['push_delivery_jobs', 'job_id'],
      ['push_delivery_attempts', 'attempt_id'],
    ] as const;
    for (const [tableName, columnName] of primaryIdentifiers) {
      const columns = await db.raw('PRAGMA table_info(' + tableName + ')') as Array<{
        name: string;
        notnull: number;
      }>;
      assert.strictEqual(
        columns.find(({ name }) => name === columnName)?.notnull,
        1,
        tableName + '.' + columnName + ' should be explicitly NOT NULL',
      );
    }

    for (const [index, eventId] of [null, '', '   ', '\u00a0'].entries()) {
      await assert.rejects(
        db('notification_events').insert({
          ...createEvent({ event_id: 'identifier-event-' + index }),
          event_id: eventId,
        }),
        /NOT NULL|notification_events_required_text_check/i,
      );
    }

    const event = await seedEventAndRecipients(db);
    for (const userId of [null, '', '   ', '\u00a0']) {
      await assert.rejects(
        db('notification_user_states').insert({
          event_id: event.event_id,
          user_id: userId,
          inbox_enabled: true,
          push_enabled: false,
        }),
        /NOT NULL|notification_user_states_identifiers_check/i,
      );
      await assert.rejects(
        db('notification_preferences').insert({
          user_id: userId,
          notification_kind: 'task',
        }),
        /NOT NULL|notification_preferences_user_id_check/i,
      );
    }

    for (const [index, subscriptionId] of [null, '', '   ', '\u00a0'].entries()) {
      await assert.rejects(
        db('push_subscriptions').insert({
          ...createSubscription({ subscription_id: 'identifier-subscription-' + index }),
          subscription_id: subscriptionId,
        }),
        /NOT NULL|push_subscriptions_required_values_check/i,
      );
    }

    const subscription = createSubscription({ subscription_id: 'identifier-subscription' });
    await db('push_subscriptions').insert(subscription);
    await assert.rejects(
      db('push_delivery_jobs').insert({
        job_id: '   ',
        deduplication_key: 'delivery:identifier-job',
        event_id: event.event_id,
        user_id: 'user-a',
        subscription_id: subscription.subscription_id,
      }),
      /push_delivery_jobs_identifiers_check/i,
    );
    await assert.rejects(
      db('push_delivery_jobs').insert({
        job_id: 'identifier-job',
        deduplication_key: '\u00a0',
        event_id: event.event_id,
        user_id: 'user-a',
        subscription_id: subscription.subscription_id,
      }),
      /push_delivery_jobs_identifiers_check/i,
    );

    await insertDeliveryJob(db, {
      jobId: 'identifier-attempt-job',
      eventId: event.event_id,
      subscriptionId: subscription.subscription_id,
    });
    await claimJob(db, 'identifier-attempt-job', 'identifier-worker');
    for (const attemptId of [null, '', '   ', '\u00a0']) {
      await assert.rejects(
        db('push_delivery_attempts').insert({
          attempt_id: attemptId,
          job_id: 'identifier-attempt-job',
          attempt_number: 1,
          status: 'delivered',
          response_status: 201,
          attempted_at: '2026-08-02T08:02:00.000Z',
          claim_token: 'identifier-worker',
        }),
        /NOT NULL|push_delivery_attempts_text_values_check/i,
      );
    }
  });

  test('enforces associated timestamp ordering and database-managed updated_at', async () => {
    const event = createEvent({ event_id: 'temporal-event' });
    await db('notification_events').insert(event);
    await assert.rejects(
      db('notification_user_states').insert({
        event_id: event.event_id,
        user_id: 'temporal-user',
        inbox_enabled: true,
        push_enabled: false,
        created_at: '2026-08-02T08:10:00.000Z',
        read_at: timestamp,
      }),
      /notification_user_states_temporal_order_check/i,
    );

    await db('notification_user_states').insert({
      event_id: event.event_id,
      user_id: 'temporal-user',
      inbox_enabled: true,
      push_enabled: true,
      created_at: timestamp,
    });
    const subscription = createSubscription({
      subscription_id: 'temporal-subscription',
      user_id: 'temporal-user',
    });
    await db('push_subscriptions').insert(subscription);
    await insertDeliveryJob(db, {
      jobId: 'temporal-job',
      eventId: event.event_id,
      userId: 'temporal-user',
      subscriptionId: subscription.subscription_id,
    });
    await claimJob(db, 'temporal-job', 'temporal-worker');
    await assert.rejects(
      db('push_delivery_attempts').insert({
        attempt_id: 'backdated-created-attempt',
        job_id: 'temporal-job',
        attempt_number: 1,
        status: 'delivered',
        response_status: 201,
        attempted_at: '2026-08-02T08:02:00.000Z',
        created_at: claimedAt,
        claim_token: 'temporal-worker',
      }),
      /push_delivery_attempts_temporal_order_check/i,
    );

    await assert.rejects(
      db('notification_preferences').insert({
        user_id: 'future-insert',
        notification_kind: 'task',
        updated_at: '2099-01-01T00:00:00.000Z',
      }),
      /updated_at cannot be in the future/i,
    );
    await db('notification_preferences').insert({
      user_id: 'managed-update',
      notification_kind: 'task',
      created_at: '2020-01-01T00:00:00.000Z',
      updated_at: '2020-01-01T00:00:00.000Z',
    });
    await assert.rejects(
      db('notification_preferences')
        .where({ user_id: 'managed-update', notification_kind: 'task' })
        .update({
          push_enabled: false,
          updated_at: '2099-01-01T00:00:00.000Z',
        }),
      /updated_at is database managed/i,
    );
    await db('notification_preferences')
      .where({ user_id: 'managed-update', notification_kind: 'task' })
      .update({ push_enabled: false });
    const preference = await db('notification_preferences')
      .where({ user_id: 'managed-update', notification_kind: 'task' })
      .first();
    assert.ok(preference.updated_at < '2099-01-01T00:00:00.000Z');
    assert.ok(preference.updated_at > '2020-01-01T00:00:00.000Z');
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

  test('persists only structurally valid HTTPS push endpoints', async () => {
    await db('push_subscriptions').insert(createSubscription({
      subscription_id: 'valid-port-endpoint',
      endpoint: 'https://push.example.test:8443/subscription?token=abc',
    }));

    const invalidEndpoints = [
      'https://?x',
      'https://user:secret@push.example.test/subscription',
      'https://push.example.test:not-a-port/subscription',
      'https://push.example.test:65536/subscription',
      'https://push.example.test/#fragment',
      'https://push.example.test\\redirect',
      'http://push.example.test/subscription',
    ];
    for (const [index, endpoint] of invalidEndpoints.entries()) {
      await assert.rejects(
        db('push_subscriptions').insert(createSubscription({
          subscription_id: 'invalid-endpoint-' + index,
          endpoint,
        })),
        /push_subscriptions_required_values_check/i,
      );
    }
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

  test('deep-clones JSON-safe metadata and rejects values serialization cannot preserve', async () => {
    const metadata = {
      nested: { enabled: true },
      values: [1, 'two', null],
    };
    const parsed = parseNotificationEvent({
      ...createContractEvent(),
      metadata,
    });
    metadata.nested.enabled = false;
    assert.deepStrictEqual(parsed.metadata, {
      nested: { enabled: true },
      values: [1, 'two', null],
    });
    assert.doesNotThrow(() => JSON.stringify(parsed));

    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const invalidMetadata = [
      { value: 1n },
      { value: () => undefined },
      { value: Number.POSITIVE_INFINITY },
      { value: new Date(timestamp) },
      { value: new Array(1) },
      circular,
    ];
    for (const candidate of invalidMetadata) {
      assert.throws(
        () => parseNotificationEvent({
          ...createContractEvent(),
          metadata: candidate,
        }),
        /JSON|finite|acyclic|object/,
      );
    }

    await assert.rejects(
      db('notification_events').insert(createEvent({
        event_id: 'non-finite-metadata-number',
        metadata_json: '{"nested":{"value":1e400}}',
      })),
      /metadata numbers must be finite/i,
    );
  });

  test('validates every public notification persistence and API boundary', () => {
    assert.deepStrictEqual(parseNotificationUserState({
      eventId: 'event-1',
      userId: 'user-a',
      inboxEnabled: false,
      pushEnabled: true,
      readAt: null,
      dismissedAt: null,
      createdAt: timestamp,
    }).inboxEnabled, false);
    assert.throws(
      () => parseNotificationUserState({
        eventId: 'event-1',
        userId: 'user-a',
        inboxEnabled: false,
        pushEnabled: false,
        readAt: null,
        dismissedAt: null,
        createdAt: timestamp,
      }),
      /at least one enabled channel/,
    );
    assert.throws(
      () => parseNotificationUserState({
        eventId: 'event-1',
        userId: 'user-a',
        inboxEnabled: false,
        pushEnabled: true,
        readAt: timestamp,
        dismissedAt: null,
        createdAt: timestamp,
      }),
      /no Inbox timestamps/,
    );

    const input = parsePushSubscriptionInput({
      endpoint: 'https://push.example.test/subscription',
      expirationTime: 1_800_000_000_000,
      keys: { p256dh: 'p256dh', auth: 'auth' },
    });
    assert.strictEqual(input.endpoint, 'https://push.example.test/subscription');
    for (const endpoint of [
      'https://?x',
      'https://user:secret@push.example.test/subscription',
      'https://push.example.test:invalid/subscription',
      'http://push.example.test/subscription',
    ]) {
      assert.throws(
        () => parsePushSubscriptionInput({
          endpoint,
          expirationTime: null,
          keys: { p256dh: 'p256dh', auth: 'auth' },
        }),
        /URL/,
      );
    }
    assert.throws(
      () => parsePushSubscriptionInput({
        endpoint: 'https://push.example.test/subscription',
        expirationTime: Number.POSITIVE_INFINITY,
        keys: { p256dh: 'p256dh', auth: 'auth' },
      }),
      /epoch-millisecond/,
    );
    assert.throws(
      () => parsePushSubscriptionInput({
        endpoint: 'https://push.example.test/subscription',
        expirationTime: null,
        keys: { p256dh: '***', auth: 'auth' },
      }),
      /base64url/,
    );

    const subscription = parsePushSubscription({
      id: 'subscription-1',
      endpoint: input.endpoint,
      expiresAt: null,
      revokedAt: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    assert.strictEqual(
      parsePushSubscriptionsResponse({ subscriptions: [subscription] })
        .subscriptions.length,
      1,
    );

    assert.strictEqual(parsePushDeliveryJob({
      id: 'job-1',
      deduplicationKey: 'delivery:job-1',
      eventId: 'event-1',
      userId: 'user-a',
      subscriptionId: 'subscription-1',
      attemptCount: 0,
      status: 'pending',
      nextRetryAt: null,
      claimToken: null,
      claimedAt: null,
      leaseExpiresAt: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    }).status, 'pending');
    assert.throws(
      () => parsePushDeliveryJob({
        id: 'job-1',
        deduplicationKey: 'delivery:job-1',
        eventId: 'event-1',
        userId: 'user-a',
        subscriptionId: 'subscription-1',
        attemptCount: 0.5,
        status: 'pending',
        nextRetryAt: null,
        claimToken: null,
        claimedAt: null,
        leaseExpiresAt: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      }),
      /nonnegative integer/,
    );

    assert.strictEqual(parsePushDeliveryAttempt({
      id: 'attempt-1',
      jobId: 'job-1',
      attemptNumber: 1,
      status: 'delivered',
      responseStatus: 201,
      errorCode: null,
      errorMessage: null,
      attemptedAt: timestamp,
      nextRetryAt: null,
      claimToken: 'claim-1',
      createdAt: timestamp,
    }).status, 'delivered');
    assert.throws(
      () => parsePushDeliveryAttempt({
        id: 'attempt-1',
        jobId: 'job-1',
        attemptNumber: 1,
        status: 'retryable',
        responseStatus: null,
        errorCode: null,
        errorMessage: null,
        attemptedAt: timestamp,
        nextRetryAt: leaseExpiresAt,
        claimToken: 'claim-1',
        createdAt: timestamp,
      }),
      /response status or non-empty error code/,
    );

    assert.strictEqual(parseNotificationSourceActivity({
      type: 'task',
      key: 'task-1',
      repository: 'integry/propr',
      status: 'processing',
      lastActivityAt: timestamp,
      completedAt: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    }).status, 'processing');
    assert.throws(
      () => parseNotificationSourceActivity({
        type: 'task',
        key: 'task-1',
        repository: 'integry/propr',
        status: 'processing',
        lastActivityAt: timestamp,
        completedAt: timestamp,
        createdAt: timestamp,
        updatedAt: timestamp,
      }),
      /null for active work/,
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
      /push_delivery_jobs_state_check|invalid push delivery job transition/i,
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

    await assert.rejects(
      db('push_delivery_attempts').insert({
        attempt_id: 'missing-outcome-detail',
        job_id: 'atomic-job',
        attempt_number: 1,
        status: 'failed',
        attempted_at: '2026-08-02T08:07:00.000Z',
        claim_token: 'worker-a',
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
        claim_token: 'worker-c',
      }),
      /does not own the active claim/,
    );
  });

  test('uses one database-timed claim statement for pending, retryable, and expired processing jobs', async () => {
    const temporaryDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), 'propr-notification-claim-'),
    );
    const filename = path.join(temporaryDirectory, 'claims.sqlite');
    const firstConnection = createSchemaDatabase(filename);
    const secondConnection = createSchemaDatabase(filename);
    try {
      await up(firstConnection);
      const event = await seedEventAndRecipients(firstConnection);
      const subscription = createSubscription();
      await firstConnection('push_subscriptions').insert(subscription);
      await insertDeliveryJob(firstConnection, {
        jobId: 'three-state-claim-job',
        eventId: event.event_id,
        subscriptionId: subscription.subscription_id,
      });

      const pendingClaim = await claimJobUsingDatabaseTime(
        firstConnection,
        'three-state-claim-job',
        'pending-worker',
      );
      assert.strictEqual(pendingClaim.length, 1);

      await firstConnection.raw(`
        INSERT INTO push_delivery_attempts (
          attempt_id,
          job_id,
          attempt_number,
          status,
          error_code,
          attempted_at,
          next_retry_at,
          claim_token
        ) VALUES (
          'three-state-attempt',
          'three-state-claim-job',
          1,
          'retryable',
          'temporary',
          strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
          strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+0.200 seconds'),
          'pending-worker'
        )
      `);
      const scheduled = await firstConnection('push_delivery_jobs')
        .where({ job_id: 'three-state-claim-job' })
        .first();
      await assert.rejects(
        firstConnection('push_delivery_jobs')
          .where({ job_id: 'three-state-claim-job' })
          .update({
            status: 'processing',
            claim_token: 'future-time-worker',
            claimed_at: scheduled.next_retry_at,
            lease_expires_at: leaseExpiresAt,
            next_retry_at: null,
          }),
        /invalid push delivery job transition/,
      );
      await new Promise((resolve) => setTimeout(resolve, 250));

      const retryableClaim = await claimJobUsingDatabaseTime(
        secondConnection,
        'three-state-claim-job',
        'retryable-worker',
        '+0.200 seconds',
      );
      assert.strictEqual(retryableClaim.length, 1);
      await new Promise((resolve) => setTimeout(resolve, 250));

      const [firstReclaim, secondReclaim] = await Promise.all([
        claimJobUsingDatabaseTime(
          firstConnection,
          'three-state-claim-job',
          'expired-worker-a',
        ),
        claimJobUsingDatabaseTime(
          secondConnection,
          'three-state-claim-job',
          'expired-worker-b',
        ),
      ]);
      assert.strictEqual(firstReclaim.length + secondReclaim.length, 1);
      const stored = await firstConnection('push_delivery_jobs')
        .where({ job_id: 'three-state-claim-job' })
        .first();
      assert.ok(['expired-worker-a', 'expired-worker-b'].includes(stored.claim_token));
    } finally {
      await firstConnection.destroy();
      await secondConnection.destroy();
      fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    }
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
        lease_expires_at: leaseExpiresAt,
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

  test('cancels queued work while preserving in-flight audit claims on revocation', async () => {
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
    let processingJob = await db('push_delivery_jobs')
      .where({ job_id: 'processing-revoked-job' })
      .first();
    assert.strictEqual(processingJob.status, 'processing');
    assert.strictEqual(processingJob.claim_token, 'processing-worker');
    await recordAttempt(db, {
      attemptId: 'attempt-after-revocation',
      jobId: 'processing-revoked-job',
      attemptNumber: 1,
      claimToken: 'processing-worker',
      status: 'delivered',
      responseStatus: 201,
      attemptedAt: '2026-08-02T08:04:00.000Z',
    });
    processingJob = await db('push_delivery_jobs')
      .where({ job_id: 'processing-revoked-job' })
      .first();
    assert.strictEqual(processingJob.status, 'delivered');
    assert.strictEqual(
      await db('push_delivery_attempts')
        .where({ attempt_id: 'attempt-after-revocation' })
        .count({ count: '*' })
        .first()
        .then((row) => Number(row?.count)),
      1,
    );

    const retryableSubscription = createSubscription({
      subscription_id: 'processing-retryable-subscription',
    });
    await db('push_subscriptions').insert(retryableSubscription);
    await insertDeliveryJob(db, {
      jobId: 'processing-retryable-revoked-job',
      eventId: event.event_id,
      subscriptionId: retryableSubscription.subscription_id,
    });
    await claimJob(db, 'processing-retryable-revoked-job', 'retryable-worker');
    await db('push_subscriptions')
      .where({ subscription_id: retryableSubscription.subscription_id })
      .update({ revoked_at: revokedAt });
    await recordAttempt(db, {
      attemptId: 'retryable-attempt-after-revocation',
      jobId: 'processing-retryable-revoked-job',
      attemptNumber: 1,
      claimToken: 'retryable-worker',
      status: 'retryable',
      attemptedAt: '2026-08-02T08:04:00.000Z',
      nextRetryAt: leaseExpiresAt,
      errorCode: 'timeout',
    });
    const retryableJob = await db('push_delivery_jobs')
      .where({ job_id: 'processing-retryable-revoked-job' })
      .first();
    assert.strictEqual(retryableJob.status, 'cancelled');
    assert.strictEqual(retryableJob.attempt_count, 1);

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
    assert.ok(
      await db('push_delivery_jobs_requiring_cancellation')
        .where({ job_id: 'expired-job' })
        .first(),
    );
    const cleanup = await db.raw(
      `UPDATE push_delivery_jobs
       SET status = 'cancelled',
           next_retry_at = NULL,
           claim_token = NULL,
           claimed_at = NULL,
           lease_expires_at = NULL
       WHERE job_id = (
         SELECT job_id
         FROM push_delivery_jobs_requiring_cancellation
         WHERE job_id = ?
       )
       RETURNING *`,
      ['expired-job'],
    ) as Array<Record<string, unknown>>;
    assert.strictEqual(cleanup.length, 1);
    assert.strictEqual(cleanup[0]?.status, 'cancelled');
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

    const processingSubscription = createSubscription({
      subscription_id: 'newly-expired-processing-subscription',
      expires_at: '2099-01-01T00:00:00.000Z',
    });
    await db('push_subscriptions').insert(processingSubscription);
    await insertDeliveryJob(db, {
      jobId: 'newly-expired-processing-job',
      eventId: event.event_id,
      subscriptionId: processingSubscription.subscription_id,
    });
    await claimJob(db, 'newly-expired-processing-job', 'expiry-worker');
    await db('push_subscriptions')
      .where({ subscription_id: processingSubscription.subscription_id })
      .update({ expires_at: '2020-01-01T00:00:00.000Z' });
    assert.strictEqual(
      (await db('push_delivery_jobs')
        .where({ job_id: 'newly-expired-processing-job' })
        .first()).status,
      'processing',
    );
    await recordAttempt(db, {
      attemptId: 'attempt-after-expiry-update',
      jobId: 'newly-expired-processing-job',
      attemptNumber: 1,
      claimToken: 'expiry-worker',
      status: 'delivered',
      attemptedAt: '2026-08-02T08:02:00.000Z',
      responseStatus: 201,
    });
    assert.strictEqual(
      (await db('push_delivery_jobs')
        .where({ job_id: 'newly-expired-processing-job' })
        .first()).status,
      'delivered',
    );

    await db('push_subscriptions').insert({
      ...createSubscription({ subscription_id: 'naturally-expiring-subscription' }),
      expires_at: db.raw(
        "strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+0.200 seconds')",
      ),
    });
    await insertDeliveryJob(db, {
      jobId: 'naturally-expiring-processing-job',
      eventId: event.event_id,
      subscriptionId: 'naturally-expiring-subscription',
    });
    assert.strictEqual((await claimJobUsingDatabaseTime(
      db,
      'naturally-expiring-processing-job',
      'naturally-expiring-worker',
      '+0.200 seconds',
    )).length, 1);
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.ok(
      await db('push_delivery_jobs_requiring_cancellation')
        .where({ job_id: 'naturally-expiring-processing-job' })
        .first(),
    );
    const cleaned = await db('push_delivery_jobs')
      .whereIn('job_id', db('push_delivery_jobs_requiring_cancellation').select('job_id'))
      .where({ job_id: 'naturally-expiring-processing-job' })
      .update({
        status: 'cancelled',
        next_retry_at: null,
        claim_token: null,
        claimed_at: null,
        lease_expires_at: null,
      });
    assert.strictEqual(cleaned, 1);
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
    await db('notification_source_activity')
      .where({ activity_type: 'task', activity_key: 'task-monotonic' })
      .update({
        status: 'processing',
        last_activity_at: '2026-08-02T08:30:00.000Z',
        completed_at: '2026-08-02T08:20:00.000Z',
      });

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
