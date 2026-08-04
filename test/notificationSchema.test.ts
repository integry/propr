import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert';
import { createECDH } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import knex, { type Knex } from 'knex';
import {
  NOTIFICATION_ACTION_TYPES,
  NOTIFICATION_KINDS,
  NOTIFICATION_PAYLOAD_LIMITS,
  NOTIFICATION_SEVERITIES,
  NOTIFICATION_SOURCE_ACTIVITY_TYPES,
  NOTIFICATION_SOURCE_ACTIVITY_STATUSES,
  PUSH_DELIVERY_ATTEMPT_STATUSES,
  PUSH_DELIVERY_STATUSES,
  MAX_CANONICAL_TIMESTAMP_EPOCH_MS,
  WEB_PUSH_ENDPOINT_HOSTS,
  WEB_PUSH_ENDPOINT_HOST_SUFFIXES,
  normalizeISO8601Timestamp,
  parseISO8601Timestamp,
  parseNotification,
  parseNotificationAction,
  parseNotificationCapabilitiesResponse,
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
  parsePushSubscriptionEnrollmentResponse,
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
const eventCreatedAt = '2026-08-02T07:59:00.000Z';
const claimedAt = '2026-08-02T08:01:00.000Z';
const leaseExpiresAt = '2099-08-02T08:06:00.000Z';
function generatedP256dhKey(privateKeyValue: number): string {
  const privateKey = Buffer.alloc(32);
  privateKey[31] = privateKeyValue;
  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(privateKey);
  return ecdh.getPublicKey(undefined, 'uncompressed').toString('base64url');
}

const validP256dhKey = generatedP256dhKey(1);
const validAuthKey = 'A'.repeat(22);
const pushEndpointOrigin = 'https://fcm.googleapis.com';
const betterSqliteModulePath = createRequire(import.meta.url).resolve('better-sqlite3');

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

function createMigrationRunnerDatabase(filename = ':memory:'): Knex {
  return knex({
    client: 'better-sqlite3',
    connection: { filename },
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
    occurred_at: eventCreatedAt,
    created_at: eventCreatedAt,
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
    endpoint: pushEndpointOrigin + '/fcm/send/' + subscriptionId,
    p256dh_key: validP256dhKey,
    auth_key: validAuthKey,
    created_at: timestamp,
    updated_at: timestamp,
    ...overrides,
  };
}

function sourceActivityClock(lastActivityAt: string): {
  created_at: string;
  updated_at: string;
} {
  return {
    created_at: eventCreatedAt,
    updated_at: lastActivityAt,
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
      created_at: recipient.createdAt ?? timestamp,
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

function createCrossProcessClaimWorker(
  filename: string,
  jobId: string,
  claimToken: string,
  gate: SharedArrayBuffer,
): { ready: Promise<void>; result: Promise<string | null> } {
  const worker = new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    const Database = require(workerData.betterSqliteModulePath);
    const database = new Database(workerData.filename);
    database.pragma('busy_timeout = 30000');
    database.pragma('foreign_keys = ON');
    database.pragma('recursive_triggers = ON');
    const gate = new Int32Array(workerData.gate);
    parentPort.postMessage({ type: 'ready' });
    Atomics.wait(gate, 0, 0);
    try {
      const rows = database.prepare(\`
        UPDATE push_delivery_jobs
        SET status = 'processing',
            claim_token = ?,
            claimed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
            lease_expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+5 minutes'),
            next_retry_at = NULL
        WHERE job_id = (
          SELECT job_id
          FROM push_delivery_claimable_jobs
          WHERE job_id = ?
        )
        RETURNING claim_token
      \`).all(workerData.claimToken, workerData.jobId);
      parentPort.postMessage({
        type: 'result',
        claimToken: rows[0]?.claim_token ?? null,
      });
    } catch (error) {
      parentPort.postMessage({
        type: 'error',
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      database.close();
    }
  `, {
    eval: true,
    workerData: {
      betterSqliteModulePath,
      filename,
      jobId,
      claimToken,
      gate,
    },
  });

  let markReady: (() => void) | undefined;
  const ready = new Promise<void>((resolve) => {
    markReady = resolve;
  });
  const result = new Promise<string | null>((resolve, reject) => {
    worker.on('message', (message: {
      type: 'ready' | 'result' | 'error';
      claimToken?: string | null;
      message?: string;
    }) => {
      if (message.type === 'ready') {
        markReady?.();
      } else if (message.type === 'result') {
        resolve(message.claimToken ?? null);
      } else {
        reject(new Error(message.message ?? 'claim worker failed'));
      }
    });
    worker.on('error', reject);
    worker.on('exit', (code) => {
      if (code !== 0) {
        reject(new Error('claim worker exited with code ' + code));
      }
    });
  });
  return { ready, result };
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
      'push_subscriptions_expiration_idx',
      'push_delivery_jobs_subscription_user_idx',
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
      indexSql('push_subscriptions_expiration_idx'),
      /\(expires_at, subscription_id, user_id\)[\s\S]+WHERE revoked_at IS NULL AND expires_at IS NOT NULL/i,
    );
    assert.match(
      indexSql('push_delivery_jobs_subscription_user_idx'),
      /\(subscription_id, user_id\)/i,
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
    const subscriptionJobsPlan = await db.raw(
      `EXPLAIN QUERY PLAN
       SELECT job_id
       FROM push_delivery_jobs
       WHERE subscription_id = ? AND user_id = ?`,
      ['subscription-plan', 'user-a'],
    ) as Array<{ detail: string }>;
    assert.ok(
      subscriptionJobsPlan.some(({ detail }) =>
        detail.includes('push_delivery_jobs_subscription_user_idx')),
    );
    const expirationPlan = await db.raw(
      `EXPLAIN QUERY PLAN
       SELECT subscription_id
       FROM push_subscriptions
       WHERE revoked_at IS NULL
         AND expires_at IS NOT NULL
         AND expires_at <= ?`,
      [timestamp],
    ) as Array<{ detail: string }>;
    assert.ok(
      expirationPlan.some(({ detail }) =>
        detail.includes('push_subscriptions_expiration_idx')),
    );

    const dispatcherPlan = await db.raw(
      `EXPLAIN QUERY PLAN
       SELECT job_id
       FROM push_delivery_claimable_jobs
       ORDER BY CASE status
         WHEN 'pending' THEN created_at
         WHEN 'retryable' THEN next_retry_at
         ELSE lease_expires_at
       END, job_id
       LIMIT 1`,
    ) as Array<{ detail: string }>;
    for (const indexName of [
      'push_delivery_jobs_pending_idx',
      'push_delivery_jobs_retry_idx',
      'push_delivery_jobs_processing_lease_idx',
    ]) {
      assert.ok(
        dispatcherPlan.some(({ detail }) => detail.includes(indexName)),
        'dispatcher should use ' + indexName,
      );
    }
    assert.strictEqual(
      dispatcherPlan.some(({ detail }) => /^SCAN job$/i.test(detail)),
      false,
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
        ...sourceActivityClock(timestamp),
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
        ...sourceActivityClock(timestamp),
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
        ...sourceActivityClock(timestamp),
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
        ...sourceActivityClock(timestamp),
      }),
      /notification_source_activity_completion_state_check/i,
    );
    await assert.rejects(
      db('notification_source_activity').insert({
        activity_type: 'task',
        activity_key: 'task-with-branch',
        repository: 'integry/propr',
        branch: 'main',
        status: 'processing',
        last_activity_at: timestamp,
        ...sourceActivityClock(timestamp),
      }),
      /notification_source_activity_required_text_check/i,
    );
    assert.throws(
      () => parseNotificationSourceActivity({
        type: 'task',
        key: 'task-with-branch',
        repository: 'integry/propr',
        branch: 'main',
        status: 'processing',
        lastActivityAt: timestamp,
        completedAt: null,
        createdAt: eventCreatedAt,
        updatedAt: timestamp,
      }),
      /indexing-only field/,
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

    const duplicateKeyPayloads: Array<Partial<EventRow>> = [
      {
        target_json: '{"type":"task","type":"review","repository":"integry/propr","taskId":"task-1","prNumber":1}',
      },
      {
        action_json: '{"type":"navigate","type":"external_link","label":"Open","href":"/tasks/1","href":"https://example.test/tasks/1"}',
      },
      {
        metadata_json: '{"nested":{"worker":"first","worker":"second"}}',
      },
    ];
    for (const [index, overrides] of duplicateKeyPayloads.entries()) {
      await assert.rejects(
        db('notification_events').insert(createEvent({
          event_id: 'duplicate-json-key-' + index,
          ...overrides,
        })),
        /must not contain duplicate object keys/,
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
    for (const field of ['readAt', 'dismissedAt'] as const) {
      assert.throws(
        () => parseNotification({
          ...createContractEvent(),
          readAt: null,
          dismissedAt: null,
          [field]: eventCreatedAt,
        }),
        new RegExp('notification\\.' + field + '.*at or after event createdAt'),
      );
    }
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
      {
        id: 'unknown-action-property',
        action: {
          type: 'navigate',
          label: 'Open',
          href: '/tasks/1',
          lable: 'Typo',
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

    for (const codepoint of [
      ...Array.from({ length: 32 }, (_, index) => index),
      127,
    ]) {
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
      {
        type: 'task',
        repository: 'integry/propr',
        taskId: 'task-1',
        taskID: 'typo',
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
    assert.throws(
      () => normalizeISO8601Timestamp(8_640_000_000_000_000),
      /four-digit-year range/,
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
        created_at: '2020-01-01T00:00:00.000Z',
        updated_at: timestamp,
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
    await assert.rejects(
      db('notification_events').insert(createEvent({
        event_id: 'event-created-before-occurrence',
        occurred_at: timestamp,
        created_at: eventCreatedAt,
      })),
      /notification_events_temporal_order_check/i,
    );
    assert.throws(
      () => parseNotificationEvent({
        ...createContractEvent(),
        occurredAt: timestamp,
        createdAt: eventCreatedAt,
      }),
      /at or after occurredAt/,
    );

    const event = createEvent({ event_id: 'temporal-event' });
    await db('notification_events').insert(event);
    await assert.rejects(
      db('notification_user_states').insert({
        event_id: event.event_id,
        user_id: 'recipient-before-event',
        inbox_enabled: true,
        push_enabled: false,
        created_at: '2026-08-02T07:58:00.000Z',
      }),
      /assignment must follow event creation/,
    );
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
    for (const field of ['read_at', 'dismissed_at'] as const) {
      await assert.rejects(
        db('notification_user_states').insert({
          event_id: event.event_id,
          user_id: 'future-' + field,
          inbox_enabled: true,
          push_enabled: false,
          created_at: timestamp,
          [field]: '2099-01-01T00:00:00.000Z',
        }),
        /notification Inbox state timestamps cannot be in the future/i,
      );
    }

    await db('notification_user_states').insert({
      event_id: event.event_id,
      user_id: 'temporal-user',
      inbox_enabled: true,
      push_enabled: true,
      created_at: timestamp,
    });
    for (const field of ['read_at', 'dismissed_at'] as const) {
      await assert.rejects(
        db('notification_user_states')
          .where({ event_id: event.event_id, user_id: 'temporal-user' })
          .update({ [field]: '2099-01-01T00:00:00.000Z' }),
        /notification Inbox state timestamps cannot be in the future/i,
      );
    }
    const subscription = createSubscription({
      subscription_id: 'temporal-subscription',
      user_id: 'temporal-user',
    });
    await db('push_subscriptions').insert(subscription);
    await assert.rejects(
      db('push_subscriptions').insert(createSubscription({
        subscription_id: 'revoked-before-creation',
        revoked_at: eventCreatedAt,
      })),
      /push_subscriptions_temporal_order_check/i,
    );
    for (const rewrite of [
      { endpoint: pushEndpointOrigin + '/fcm/send/active-rewrite' },
      { p256dh_key: generatedP256dhKey(2) },
      { user_id: 'rewritten-user' },
      { subscription_id: 'rewritten-subscription-id' },
    ]) {
      await assert.rejects(
        db('push_subscriptions')
          .where({ subscription_id: subscription.subscription_id })
          .update(rewrite),
        /push subscription versions are immutable/,
      );
    }
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
      db('notification_source_activity').insert({
        activity_type: 'task',
        activity_key: 'activity-before-creation',
        repository: 'integry/propr',
        status: 'processing',
        last_activity_at: eventCreatedAt,
        created_at: timestamp,
        updated_at: timestamp,
      }),
      /invalid notification source activity timestamps/,
    );
    assert.throws(
      () => parseNotificationSourceActivity({
        type: 'task',
        key: 'activity-before-creation',
        repository: 'integry/propr',
        status: 'processing',
        lastActivityAt: eventCreatedAt,
        completedAt: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      }),
      /between createdAt and updatedAt/,
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

  test('persists only vetted Web Push service endpoints', async () => {
    for (const [index, host] of WEB_PUSH_ENDPOINT_HOSTS.entries()) {
      const endpoint = 'https://' + host + '/push/subscription-' + index;
      await db('push_subscriptions').insert(createSubscription({
        subscription_id: 'valid-push-host-' + index,
        endpoint,
      }));
      assert.strictEqual(
        parsePushSubscriptionInput({
          endpoint,
          expirationTime: null,
          keys: { p256dh: validP256dhKey, auth: validAuthKey },
        }).endpoint,
        endpoint,
      );
    }
    for (const [index, suffix] of WEB_PUSH_ENDPOINT_HOST_SUFFIXES.entries()) {
      const endpoint = 'https://web' + suffix + '/push/subscription-' + index;
      await db('push_subscriptions').insert(createSubscription({
        subscription_id: 'valid-push-suffix-' + index,
        endpoint,
      }));
      assert.strictEqual(
        parsePushSubscriptionInput({
          endpoint,
          expirationTime: null,
          keys: { p256dh: validP256dhKey, auth: validAuthKey },
        }).endpoint,
        endpoint,
      );
    }

    const invalidEndpoints = [
      'https://?x',
      'https://user:secret@fcm.googleapis.com/fcm/send/subscription',
      'https://fcm.googleapis.com:not-a-port/fcm/send/subscription',
      'https://fcm.googleapis.com:8443/fcm/send/subscription',
      'https://fcm.googleapis.com/fcm/send/subscription#fragment',
      'https://fcm.googleapis.com\\redirect',
      'http://fcm.googleapis.com/fcm/send/subscription',
      'https://localhost/subscription',
      'https://127.0.0.1/subscription',
      'https://push.attacker.example/subscription',
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
      { value: new Array(NOTIFICATION_PAYLOAD_LIMITS.metadataNodes + 1) },
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

  test('bounds durable text, Web Push keys, and metadata complexity', async () => {
    const oversizedTitle = 't'.repeat(NOTIFICATION_PAYLOAD_LIMITS.titleBytes + 1);
    const oversizedBody = 'b'.repeat(NOTIFICATION_PAYLOAD_LIMITS.bodyBytes + 1);
    const oversizedIdentifier = 'i'.repeat(
      NOTIFICATION_PAYLOAD_LIMITS.identifierBytes + 1,
    );
    for (const [field, value] of [
      ['title', oversizedTitle],
      ['body', oversizedBody],
      ['id', oversizedIdentifier],
    ] as const) {
      assert.throws(
        () => parseNotificationEvent({ ...createContractEvent(), [field]: value }),
        /UTF-8 bytes/,
      );
    }
    await assert.rejects(
      db('notification_events').insert(createEvent({
        event_id: 'oversized-title',
        title: oversizedTitle,
      })),
      /notification_events_required_text_check/i,
    );
    await assert.rejects(
      db('notification_events').insert(createEvent({
        event_id: 'oversized-body',
        body: oversizedBody,
      })),
      /notification_events_required_text_check/i,
    );
    await assert.rejects(
      db('notification_events').insert(createEvent({ event_id: oversizedIdentifier })),
      /notification_events_required_text_check/i,
    );

    const oversizedEndpoint = pushEndpointOrigin + '/fcm/send/'
      + 'x'.repeat(NOTIFICATION_PAYLOAD_LIMITS.urlBytes);
    assert.throws(
      () => parsePushSubscriptionInput({
        endpoint: oversizedEndpoint,
        expirationTime: null,
        keys: { p256dh: validP256dhKey, auth: validAuthKey },
      }),
      /UTF-8 bytes/,
    );
    await assert.rejects(
      db('push_subscriptions').insert(createSubscription({
        subscription_id: 'oversized-endpoint',
        endpoint: oversizedEndpoint,
      })),
      /push_subscriptions_required_values_check/i,
    );
    await assert.rejects(
      db('push_subscriptions').insert(createSubscription({
        subscription_id: 'short-web-push-keys',
        p256dh_key: 'p256dh',
        auth_key: 'auth',
      })),
      /push_subscriptions_required_values_check/i,
    );

    const oversizedMetadata = {
      value: 'm'.repeat(NOTIFICATION_PAYLOAD_LIMITS.metadataBytes),
    };
    assert.throws(
      () => parseNotificationEvent({
        ...createContractEvent(),
        metadata: oversizedMetadata,
      }),
      /metadata no larger/,
    );
    await assert.rejects(
      db('notification_events').insert(createEvent({
        event_id: 'oversized-metadata',
        metadata_json: JSON.stringify(oversizedMetadata),
      })),
      /notification_events_metadata_json_check/i,
    );

    let deeplyNested: Record<string, unknown> = { leaf: true };
    for (let depth = 0; depth <= NOTIFICATION_PAYLOAD_LIMITS.metadataDepth; depth += 1) {
      deeplyNested = { nested: deeplyNested };
    }
    assert.throws(
      () => parseNotificationEvent({
        ...createContractEvent(),
        metadata: deeplyNested,
      }),
      /nested at most/,
    );
    await assert.rejects(
      db('notification_events').insert(createEvent({
        event_id: 'deeply-nested-metadata',
        metadata_json: JSON.stringify(deeplyNested),
      })),
      /metadata exceeds structural limits/,
    );

    const event = await seedEventAndRecipients(db, undefined, {
      event_id: 'oversized-attempt-event',
    });
    const subscription = createSubscription({
      subscription_id: 'oversized-attempt-subscription',
    });
    await db('push_subscriptions').insert(subscription);
    await insertDeliveryJob(db, {
      jobId: 'oversized-attempt-job',
      eventId: event.event_id,
      subscriptionId: subscription.subscription_id,
    });
    await claimJob(db, 'oversized-attempt-job', 'oversized-attempt-worker');
    await assert.rejects(
      db('push_delivery_attempts').insert({
        attempt_id: 'oversized-error-attempt',
        job_id: 'oversized-attempt-job',
        attempt_number: 1,
        status: 'failed',
        error_code: 'delivery-error',
        error_message: 'e'.repeat(NOTIFICATION_PAYLOAD_LIMITS.errorMessageBytes + 1),
        attempted_at: '2026-08-02T08:02:00.000Z',
        claim_token: 'oversized-attempt-worker',
      }),
      /push_delivery_attempts_text_values_check/i,
    );
  });

  test('covers every shared payload limit at its persistence/runtime boundaries', async () => {
    type LimitName = keyof typeof NOTIFICATION_PAYLOAD_LIMITS;
    type StringBoundaryCase = {
      name: Exclude<LimitName, 'metadataBytes' | 'metadataDepth' | 'metadataNodes'>;
      minimum: string;
      maximum: string;
      overflow: string;
      parse?: (value: string) => unknown;
      insert: (value: string, boundary: string) => Promise<unknown>;
      sqlError: RegExp;
    };

    const urlPrefix = 'https://example.test/';
    const insertAttemptBoundary = async (
      field: 'error_code' | 'error_message',
      value: string,
      boundary: string,
    ): Promise<unknown> => {
      const stem = field.replace('_', '-') + '-' + boundary;
      const event = await seedEventAndRecipients(db, undefined, {
        event_id: 'limit-' + stem + '-event',
      });
      const subscription = createSubscription({
        subscription_id: 'limit-' + stem + '-subscription',
      });
      await db('push_subscriptions').insert(subscription);
      const jobId = 'limit-' + stem + '-job';
      await insertDeliveryJob(db, {
        jobId,
        eventId: event.event_id,
        subscriptionId: subscription.subscription_id,
      });
      const claimToken = 'limit-' + stem + '-claim';
      await claimJob(db, jobId, claimToken);
      return db('push_delivery_attempts').insert({
        attempt_id: 'limit-' + stem + '-attempt',
        job_id: jobId,
        attempt_number: 1,
        status: 'failed',
        response_status: null,
        error_code: field === 'error_code' ? value : 'failure',
        error_message: field === 'error_message' ? value : null,
        attempted_at: '2026-08-02T08:02:00.000Z',
        next_retry_at: null,
        claim_token: claimToken,
      });
    };
    const runtimeFailureAttempt = (
      field: 'errorCode' | 'errorMessage',
      value: string,
    ) => parsePushDeliveryAttempt({
      id: 'limit-runtime-attempt',
      jobId: 'limit-runtime-job',
      attemptNumber: 1,
      status: 'failed',
      responseStatus: null,
      errorCode: field === 'errorCode' ? value : 'failure',
      errorMessage: field === 'errorMessage' ? value : null,
      attemptedAt: timestamp,
      nextRetryAt: null,
      claimToken: 'limit-runtime-claim',
      createdAt: timestamp,
    });

    const stringCases: StringBoundaryCase[] = [
      {
        name: 'identifierBytes',
        minimum: 'i',
        maximum: 'i'.repeat(NOTIFICATION_PAYLOAD_LIMITS.identifierBytes),
        overflow: 'i'.repeat(NOTIFICATION_PAYLOAD_LIMITS.identifierBytes + 1),
        parse: (value) => parseNotificationEvent({
          ...createContractEvent(),
          id: value,
        }),
        insert: (value) => db('notification_events').insert(createEvent({
          event_id: value,
          title: 'Identifier boundary',
          body: 'Identifier boundary body',
        })),
        sqlError: /notification_events_required_text_check/i,
      },
      {
        name: 'deduplicationKeyBytes',
        minimum: 'd',
        maximum: 'd'.repeat(NOTIFICATION_PAYLOAD_LIMITS.deduplicationKeyBytes),
        overflow: 'd'.repeat(NOTIFICATION_PAYLOAD_LIMITS.deduplicationKeyBytes + 1),
        parse: (value) => parseNotificationEvent({
          ...createContractEvent(),
          deduplicationKey: value,
        }),
        insert: (value, boundary) => db('notification_events').insert(createEvent({
          event_id: 'limit-deduplication-' + boundary,
          deduplication_key: value,
        })),
        sqlError: /notification_events_required_text_check/i,
      },
      {
        name: 'repositoryBytes',
        minimum: 'a/b',
        maximum: 'o'.repeat(39) + '/' + 'r'.repeat(100),
        overflow: 'o'.repeat(39) + '/' + 'r'.repeat(101),
        parse: (value) => parseNotificationTarget({
          type: 'task',
          repository: value,
          taskId: 'task-1',
        }),
        insert: (value, boundary) => db('notification_events').insert(createEvent({
          event_id: 'limit-repository-' + boundary,
          target_json: JSON.stringify({
            type: 'task',
            repository: value,
            taskId: 'task-1',
          }),
        })),
        sqlError: /notification_events_target_contract_check/i,
      },
      {
        name: 'titleBytes',
        minimum: 't',
        maximum: 't'.repeat(NOTIFICATION_PAYLOAD_LIMITS.titleBytes),
        overflow: 't'.repeat(NOTIFICATION_PAYLOAD_LIMITS.titleBytes + 1),
        parse: (value) => parseNotificationEvent({
          ...createContractEvent(),
          title: value,
        }),
        insert: (value, boundary) => db('notification_events').insert(createEvent({
          event_id: 'limit-title-' + boundary,
          title: value,
        })),
        sqlError: /notification_events_required_text_check/i,
      },
      {
        name: 'bodyBytes',
        minimum: '',
        maximum: 'b'.repeat(NOTIFICATION_PAYLOAD_LIMITS.bodyBytes),
        overflow: 'b'.repeat(NOTIFICATION_PAYLOAD_LIMITS.bodyBytes + 1),
        parse: (value) => parseNotificationEvent({
          ...createContractEvent(),
          body: value,
        }),
        insert: (value, boundary) => db('notification_events').insert(createEvent({
          event_id: 'limit-body-' + boundary,
          body: value,
        })),
        sqlError: /notification_events_required_text_check/i,
      },
      {
        name: 'actionLabelBytes',
        minimum: 'a',
        maximum: 'a'.repeat(NOTIFICATION_PAYLOAD_LIMITS.actionLabelBytes),
        overflow: 'a'.repeat(NOTIFICATION_PAYLOAD_LIMITS.actionLabelBytes + 1),
        parse: (value) => parseNotificationAction({
          type: 'navigate',
          label: value,
          href: '/tasks/1',
        }),
        insert: (value, boundary) => db('notification_events').insert(createEvent({
          event_id: 'limit-action-label-' + boundary,
          action_json: JSON.stringify({
            type: 'navigate',
            label: value,
            href: '/tasks/1',
          }),
        })),
        sqlError: /notification_events_action_json_check/i,
      },
      {
        name: 'urlBytes',
        minimum: urlPrefix,
        maximum: urlPrefix + 'u'.repeat(
          NOTIFICATION_PAYLOAD_LIMITS.urlBytes - Buffer.byteLength(urlPrefix),
        ),
        overflow: urlPrefix + 'u'.repeat(
          NOTIFICATION_PAYLOAD_LIMITS.urlBytes - Buffer.byteLength(urlPrefix) + 1,
        ),
        parse: (value) => parseNotificationAction({
          type: 'external_link',
          label: 'Open',
          href: value,
        }),
        insert: (value, boundary) => db('notification_events').insert(createEvent({
          event_id: 'limit-url-' + boundary,
          action_json: JSON.stringify({
            type: 'external_link',
            label: 'Open',
            href: value,
          }),
        })),
        sqlError: /notification_events_action_json_check/i,
      },
      {
        name: 'userAgentBytes',
        minimum: '',
        maximum: 'u'.repeat(NOTIFICATION_PAYLOAD_LIMITS.userAgentBytes),
        overflow: 'u'.repeat(NOTIFICATION_PAYLOAD_LIMITS.userAgentBytes + 1),
        insert: (value, boundary) => db('push_subscriptions').insert({
          ...createSubscription({
            subscription_id: 'limit-user-agent-' + boundary,
          }),
          user_agent: value,
        }),
        sqlError: /push_subscriptions_required_values_check/i,
      },
      {
        name: 'errorCodeBytes',
        minimum: 'e',
        maximum: 'e'.repeat(NOTIFICATION_PAYLOAD_LIMITS.errorCodeBytes),
        overflow: 'e'.repeat(NOTIFICATION_PAYLOAD_LIMITS.errorCodeBytes + 1),
        parse: (value) => runtimeFailureAttempt('errorCode', value),
        insert: (value, boundary) => insertAttemptBoundary(
          'error_code',
          value,
          boundary,
        ),
        sqlError: /push_delivery_attempts_text_values_check/i,
      },
      {
        name: 'errorMessageBytes',
        minimum: '',
        maximum: 'e'.repeat(NOTIFICATION_PAYLOAD_LIMITS.errorMessageBytes),
        overflow: 'e'.repeat(NOTIFICATION_PAYLOAD_LIMITS.errorMessageBytes + 1),
        parse: (value) => runtimeFailureAttempt('errorMessage', value),
        insert: (value, boundary) => insertAttemptBoundary(
          'error_message',
          value,
          boundary,
        ),
        sqlError: /push_delivery_attempts_text_values_check/i,
      },
    ];

    for (const boundaryCase of stringCases) {
      if (boundaryCase.parse !== undefined) {
        assert.doesNotThrow(
          () => boundaryCase.parse?.(boundaryCase.minimum),
          boundaryCase.name + ' runtime minimum',
        );
        assert.doesNotThrow(
          () => boundaryCase.parse?.(boundaryCase.maximum),
          boundaryCase.name + ' runtime maximum',
        );
        assert.throws(
          () => boundaryCase.parse?.(boundaryCase.overflow),
          /UTF-8 bytes/,
          boundaryCase.name + ' runtime overflow',
        );
      }
      await boundaryCase.insert(boundaryCase.minimum, 'minimum');
      await boundaryCase.insert(boundaryCase.maximum, 'maximum');
      await assert.rejects(
        boundaryCase.insert(boundaryCase.overflow, 'overflow'),
        boundaryCase.sqlError,
        boundaryCase.name + ' SQL overflow',
      );
    }

    const metadataForBytes = (serializedBytes: number): Record<string, string> => ({
      value: 'm'.repeat(serializedBytes - Buffer.byteLength('{"value":""}')),
    });
    const maximumMetadata = metadataForBytes(NOTIFICATION_PAYLOAD_LIMITS.metadataBytes);
    const oversizedMetadata = metadataForBytes(
      NOTIFICATION_PAYLOAD_LIMITS.metadataBytes + 1,
    );
    assert.strictEqual(
      Buffer.byteLength(JSON.stringify(maximumMetadata)),
      NOTIFICATION_PAYLOAD_LIMITS.metadataBytes,
    );
    assert.doesNotThrow(() => parseNotificationEvent({
      ...createContractEvent(),
      metadata: {},
    }));
    assert.doesNotThrow(() => parseNotificationEvent({
      ...createContractEvent(),
      metadata: maximumMetadata,
    }));
    assert.throws(
      () => parseNotificationEvent({
        ...createContractEvent(),
        metadata: oversizedMetadata,
      }),
      /metadata no larger/,
    );
    await db('notification_events').insert(createEvent({
      event_id: 'limit-metadata-bytes-minimum',
      metadata_json: JSON.stringify({}),
    }));
    await db('notification_events').insert(createEvent({
      event_id: 'limit-metadata-bytes-maximum',
      metadata_json: JSON.stringify(maximumMetadata),
    }));
    await assert.rejects(
      db('notification_events').insert(createEvent({
        event_id: 'limit-metadata-bytes-overflow',
        metadata_json: JSON.stringify(oversizedMetadata),
      })),
      /notification_events_metadata_json_check/i,
    );

    const metadataAtDepth = (wrappers: number): Record<string, unknown> => {
      let metadata: Record<string, unknown> = { leaf: true };
      for (let depth = 0; depth < wrappers; depth += 1) {
        metadata = { nested: metadata };
      }
      return metadata;
    };
    const maximumDepthMetadata = metadataAtDepth(
      NOTIFICATION_PAYLOAD_LIMITS.metadataDepth - 1,
    );
    const oversizedDepthMetadata = metadataAtDepth(
      NOTIFICATION_PAYLOAD_LIMITS.metadataDepth,
    );
    assert.doesNotThrow(() => parseNotificationEvent({
      ...createContractEvent(),
      metadata: maximumDepthMetadata,
    }));
    assert.throws(
      () => parseNotificationEvent({
        ...createContractEvent(),
        metadata: oversizedDepthMetadata,
      }),
      /nested at most/,
    );
    await db('notification_events').insert(createEvent({
      event_id: 'limit-metadata-depth-maximum',
      metadata_json: JSON.stringify(maximumDepthMetadata),
    }));
    await assert.rejects(
      db('notification_events').insert(createEvent({
        event_id: 'limit-metadata-depth-overflow',
        metadata_json: JSON.stringify(oversizedDepthMetadata),
      })),
      /metadata exceeds structural limits/i,
    );

    const metadataWithNodes = (nodes: number): Record<string, unknown> => ({
      values: Array.from({ length: nodes - 2 }, () => null),
    });
    const maximumNodeMetadata = metadataWithNodes(
      NOTIFICATION_PAYLOAD_LIMITS.metadataNodes,
    );
    const oversizedNodeMetadata = metadataWithNodes(
      NOTIFICATION_PAYLOAD_LIMITS.metadataNodes + 1,
    );
    assert.doesNotThrow(() => parseNotificationEvent({
      ...createContractEvent(),
      metadata: maximumNodeMetadata,
    }));
    assert.throws(
      () => parseNotificationEvent({
        ...createContractEvent(),
        metadata: oversizedNodeMetadata,
      }),
      /at most 256 nodes|256-node limit/,
    );
    await db('notification_events').insert(createEvent({
      event_id: 'limit-metadata-nodes-maximum',
      metadata_json: JSON.stringify(maximumNodeMetadata),
    }));
    await assert.rejects(
      db('notification_events').insert(createEvent({
        event_id: 'limit-metadata-nodes-overflow',
        metadata_json: JSON.stringify(oversizedNodeMetadata),
      })),
      /metadata exceeds structural limits/i,
    );

    const coveredLimits = new Set<LimitName>([
      ...stringCases.map(({ name }) => name),
      'metadataBytes',
      'metadataDepth',
      'metadataNodes',
    ]);
    assert.deepStrictEqual(
      [...coveredLimits].sort(),
      (Object.keys(NOTIFICATION_PAYLOAD_LIMITS) as LimitName[]).sort(),
    );
  });

  test('keeps delivery deduplication and claim-token boundaries in runtime/SQL parity', async () => {
    const event = await seedEventAndRecipients(db, undefined, {
      event_id: 'delivery-boundary-event',
    });
    const runtimeJob = (deduplicationKey: string) => ({
      id: 'delivery-boundary-job',
      deduplicationKey,
      eventId: event.event_id,
      userId: 'user-a',
      subscriptionId: 'delivery-boundary-subscription',
      attemptCount: 0,
      status: 'pending',
      nextRetryAt: null,
      claimToken: null,
      claimedAt: null,
      leaseExpiresAt: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    for (const length of [256, NOTIFICATION_PAYLOAD_LIMITS.deduplicationKeyBytes]) {
      const deduplicationKey = 'd'.repeat(length);
      assert.strictEqual(
        parsePushDeliveryJob(runtimeJob(deduplicationKey)).deduplicationKey,
        deduplicationKey,
      );
      const subscription = createSubscription({
        subscription_id: 'delivery-boundary-subscription-' + length,
      });
      await db('push_subscriptions').insert(subscription);
      await db('push_delivery_jobs').insert({
        job_id: 'delivery-boundary-job-' + length,
        deduplication_key: deduplicationKey,
        event_id: event.event_id,
        user_id: 'user-a',
        subscription_id: subscription.subscription_id,
        created_at: timestamp,
        updated_at: timestamp,
      });
    }

    const oversizedDeduplicationKey = 'd'.repeat(
      NOTIFICATION_PAYLOAD_LIMITS.deduplicationKeyBytes + 1,
    );
    assert.throws(
      () => parsePushDeliveryJob(runtimeJob(oversizedDeduplicationKey)),
      /512 UTF-8 bytes/,
    );
    const oversizedSubscription = createSubscription({
      subscription_id: 'delivery-boundary-subscription-oversized',
    });
    await db('push_subscriptions').insert(oversizedSubscription);
    await assert.rejects(
      db('push_delivery_jobs').insert({
        job_id: 'delivery-boundary-job-oversized',
        deduplication_key: oversizedDeduplicationKey,
        event_id: event.event_id,
        user_id: 'user-a',
        subscription_id: oversizedSubscription.subscription_id,
        created_at: timestamp,
        updated_at: timestamp,
      }),
      /push_delivery_jobs_identifiers_check/i,
    );

    const boundedClaimToken = 'c'.repeat(NOTIFICATION_PAYLOAD_LIMITS.identifierBytes);
    assert.strictEqual((await claimJob(
      db,
      'delivery-boundary-job-256',
      boundedClaimToken,
    )).length, 1);
    assert.strictEqual(parsePushDeliveryJob({
      ...runtimeJob('d'.repeat(256)),
      attemptCount: 0,
      status: 'processing',
      claimToken: boundedClaimToken,
      claimedAt,
      leaseExpiresAt,
    }).claimToken, boundedClaimToken);
    assert.throws(
      () => parsePushDeliveryJob({
        ...runtimeJob('d'.repeat(256)),
        attemptCount: 0,
        status: 'processing',
        claimToken: boundedClaimToken + 'c',
        claimedAt,
        leaseExpiresAt,
      }),
      /255 UTF-8 bytes/,
    );
    assert.strictEqual(parsePushDeliveryAttempt({
      id: 'delivery-boundary-attempt',
      jobId: 'delivery-boundary-job-256',
      attemptNumber: 1,
      status: 'delivered',
      responseStatus: 201,
      errorCode: null,
      errorMessage: null,
      attemptedAt: '2026-08-02T08:02:00.000Z',
      nextRetryAt: null,
      claimToken: boundedClaimToken,
      createdAt: '2026-08-02T08:02:00.000Z',
    }).claimToken, boundedClaimToken);
    await recordAttempt(db, {
      attemptId: 'delivery-boundary-attempt',
      jobId: 'delivery-boundary-job-256',
      attemptNumber: 1,
      claimToken: boundedClaimToken,
      status: 'delivered',
      responseStatus: 201,
      attemptedAt: '2026-08-02T08:02:00.000Z',
    });
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
      endpoint: pushEndpointOrigin + '/fcm/send/subscription',
      expirationTime: 1_800_000_000_000,
      keys: { p256dh: validP256dhKey, auth: validAuthKey },
    });
    assert.strictEqual(input.endpoint, pushEndpointOrigin + '/fcm/send/subscription');
    for (const endpoint of [
      'https://?x',
      'https://user:secret@fcm.googleapis.com/fcm/send/subscription',
      'https://fcm.googleapis.com:invalid/fcm/send/subscription',
      'http://fcm.googleapis.com/fcm/send/subscription',
      'https://localhost/subscription',
      'https://push.attacker.example/subscription',
    ]) {
      assert.throws(
        () => parsePushSubscriptionInput({
          endpoint,
          expirationTime: null,
          keys: { p256dh: validP256dhKey, auth: validAuthKey },
        }),
        /URL/,
      );
    }
    assert.throws(
      () => parsePushSubscriptionInput({
        endpoint: pushEndpointOrigin + '/fcm/send/subscription',
        expirationTime: MAX_CANONICAL_TIMESTAMP_EPOCH_MS + 1,
        keys: { p256dh: validP256dhKey, auth: validAuthKey },
      }),
      /epoch-millisecond/,
    );
    assert.strictEqual(
      parsePushSubscriptionInput({
        endpoint: pushEndpointOrigin + '/fcm/send/max-expiration',
        expirationTime: MAX_CANONICAL_TIMESTAMP_EPOCH_MS,
        keys: { p256dh: validP256dhKey, auth: validAuthKey },
      }).expirationTime,
      MAX_CANONICAL_TIMESTAMP_EPOCH_MS,
    );
    assert.strictEqual(
      normalizeISO8601Timestamp(MAX_CANONICAL_TIMESTAMP_EPOCH_MS),
      '9999-12-31T23:59:59.999Z',
    );
    assert.throws(
      () => parsePushSubscriptionInput({
        endpoint: pushEndpointOrigin + '/fcm/send/subscription',
        expirationTime: null,
        keys: { p256dh: '***', auth: validAuthKey },
      }),
      /base64url/,
    );
    const offCurvePoint = Buffer.alloc(65);
    offCurvePoint[0] = 0x04;
    assert.throws(
      () => parsePushSubscriptionInput({
        endpoint: pushEndpointOrigin + '/fcm/send/off-curve',
        expirationTime: null,
        keys: {
          p256dh: offCurvePoint.toString('base64url'),
          auth: validAuthKey,
        },
      }),
      /P-256 curve/,
    );
    assert.throws(
      () => parsePushSubscriptionInput({
        endpoint: pushEndpointOrigin + '/fcm/send/subscription',
        expirationTime: null,
        keys: { p256dh: validP256dhKey, auth: 'auth' },
      }),
      /16-byte base64url/,
    );
    const normalizationExpansion =
      pushEndpointOrigin + '/fcm/send/' + 'ü'.repeat(900);
    assert.ok(Buffer.byteLength(normalizationExpansion, 'utf8') < 2_048);
    assert.throws(
      () => parsePushSubscriptionInput({
        endpoint: normalizationExpansion,
        expirationTime: null,
        keys: { p256dh: validP256dhKey, auth: validAuthKey },
      }),
      /safe HTTPS browser push endpoint URL/,
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
    assert.strictEqual(
      parsePushSubscriptionEnrollmentResponse({ subscription }).subscription.id,
      subscription.id,
    );
    assert.deepStrictEqual(
      parseNotificationCapabilitiesResponse({
        push: { configured: true, vapidPublicKey: validP256dhKey },
      }),
      { push: { configured: true, vapidPublicKey: validP256dhKey } },
    );
    assert.throws(
      () => parseNotificationCapabilitiesResponse({
        push: { configured: false, vapidPublicKey: validP256dhKey },
      }),
      /configured to match/,
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
      created_at: '2026-08-02T08:30:00.000Z',
    });
    const laterEvent = createEvent({
      event_id: 'occurred-later',
      occurred_at: '2026-08-02T08:00:00.000Z',
      created_at: '2026-08-02T08:30:00.000Z',
    });
    const pushOnlyEvent = createEvent({
      event_id: 'push-only-hidden',
      occurred_at: timestamp,
      created_at: '2026-08-02T08:30:00.000Z',
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
        created_at: '2026-08-02T09:30:00.000Z',
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
      claimJob(
        db,
        'atomic-job',
        'c'.repeat(NOTIFICATION_PAYLOAD_LIMITS.identifierBytes + 1),
      ),
      /push_delivery_jobs_state_check/i,
    );

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

  test('classifies delivered and failure attempts by HTTP response status', async () => {
    const runtimeAttempt = {
      id: 'runtime-outcome-attempt',
      jobId: 'runtime-outcome-job',
      attemptNumber: 1,
      attemptedAt: timestamp,
      claimToken: 'runtime-outcome-claim',
      createdAt: timestamp,
    };
    for (const responseStatus of [200, 299]) {
      assert.strictEqual(parsePushDeliveryAttempt({
        ...runtimeAttempt,
        status: 'delivered',
        responseStatus,
        errorCode: null,
        errorMessage: null,
        nextRetryAt: null,
      }).responseStatus, responseStatus);
    }
    for (const responseStatus of [199, 300, 500]) {
      assert.throws(
        () => parsePushDeliveryAttempt({
          ...runtimeAttempt,
          status: 'delivered',
          responseStatus,
          errorCode: null,
          errorMessage: null,
          nextRetryAt: null,
        }),
        /successful delivered outcome/,
      );
    }
    for (const status of ['retryable', 'failed'] as const) {
      for (const responseStatus of [200, 299]) {
        assert.throws(
          () => parsePushDeliveryAttempt({
            ...runtimeAttempt,
            status,
            responseStatus,
            errorCode: null,
            errorMessage: null,
            nextRetryAt: status === 'retryable' ? leaseExpiresAt : null,
          }),
          /non-2xx HTTP status/,
        );
      }
    }
    assert.strictEqual(parsePushDeliveryAttempt({
      ...runtimeAttempt,
      status: 'retryable',
      responseStatus: 300,
      errorCode: null,
      errorMessage: null,
      nextRetryAt: leaseExpiresAt,
    }).status, 'retryable');
    assert.strictEqual(parsePushDeliveryAttempt({
      ...runtimeAttempt,
      status: 'failed',
      responseStatus: 500,
      errorCode: null,
      errorMessage: null,
      nextRetryAt: null,
    }).status, 'failed');

    const event = await seedEventAndRecipients(db, undefined, {
      event_id: 'http-outcome-event',
    });
    const subscription = createSubscription({
      subscription_id: 'http-outcome-subscription',
    });
    await db('push_subscriptions').insert(subscription);
    await insertDeliveryJob(db, {
      jobId: 'http-outcome-job',
      eventId: event.event_id,
      subscriptionId: subscription.subscription_id,
    });
    await claimJob(db, 'http-outcome-job', 'http-outcome-claim');

    const invalidOutcomes = [
      { status: 'delivered', response_status: 500, next_retry_at: null },
      { status: 'retryable', response_status: 200, next_retry_at: leaseExpiresAt },
      { status: 'failed', response_status: 299, next_retry_at: null },
    ];
    for (const [index, outcome] of invalidOutcomes.entries()) {
      await assert.rejects(
        db('push_delivery_attempts').insert({
          attempt_id: 'invalid-http-outcome-' + index,
          job_id: 'http-outcome-job',
          attempt_number: 1,
          attempted_at: '2026-08-02T08:02:00.000Z',
          claim_token: 'http-outcome-claim',
          error_code: null,
          error_message: null,
          ...outcome,
        }),
        /push_delivery_attempts_outcome_check/i,
      );
    }
    await recordAttempt(db, {
      attemptId: 'valid-http-outcome',
      jobId: 'http-outcome-job',
      attemptNumber: 1,
      claimToken: 'http-outcome-claim',
      status: 'delivered',
      responseStatus: 204,
      attemptedAt: '2026-08-02T08:02:00.000Z',
    });
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

      const gate = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
      const firstReclaim = createCrossProcessClaimWorker(
        filename,
        'three-state-claim-job',
        'expired-worker-a',
        gate,
      );
      const secondReclaim = createCrossProcessClaimWorker(
        filename,
        'three-state-claim-job',
        'expired-worker-b',
        gate,
      );
      await Promise.all([firstReclaim.ready, secondReclaim.ready]);
      const gateView = new Int32Array(gate);
      Atomics.store(gateView, 0, 1);
      Atomics.notify(gateView, 0, 2);
      const competingResults = await Promise.all([
        firstReclaim.result,
        secondReclaim.result,
      ]);
      assert.strictEqual(competingResults.filter((result) => result !== null).length, 1);
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

  test('cancels queued work and documents best-effort live-lease revocation', async () => {
    const event = await seedEventAndRecipients(db);
    const unreferencedActive = createSubscription({
      subscription_id: 'unreferenced-active-subscription',
      endpoint: pushEndpointOrigin + '/fcm/send/unreferenced-active',
    });
    await db('push_subscriptions').insert(unreferencedActive);
    await assert.rejects(
      db('push_subscriptions')
        .where({ subscription_id: unreferencedActive.subscription_id })
        .delete(),
      /push subscription versions cannot be deleted/i,
    );
    await assert.rejects(
      db('push_subscriptions').insert(createSubscription({
        subscription_id: unreferencedActive.subscription_id,
        endpoint: pushEndpointOrigin + '/fcm/send/reused-id',
      })),
      /UNIQUE constraint failed/i,
    );
    await assert.rejects(
      db('push_subscriptions').insert(createSubscription({
        subscription_id: 'reused-active-endpoint',
        endpoint: unreferencedActive.endpoint,
      })),
      /UNIQUE constraint failed/i,
    );
    const subscription = createSubscription({
      subscription_id: 'subscription-revoked',
      endpoint: pushEndpointOrigin + '/fcm/send/versioned-endpoint',
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
    const revokedSubscription = await db('push_subscriptions')
      .where({ subscription_id: subscription.subscription_id })
      .first();
    assert.strictEqual(revokedSubscription.p256dh_key, null);
    assert.strictEqual(revokedSubscription.auth_key, null);
    assert.strictEqual(
      await db('push_delivery_claimable_jobs').where({ job_id: 'revoked-job' }).first(),
      undefined,
    );

    await assert.rejects(
      db('push_subscriptions')
        .where({ subscription_id: subscription.subscription_id })
        .update({ endpoint: pushEndpointOrigin + '/fcm/send/rewritten' }),
      /push subscription versions are immutable/,
    );
    await assert.rejects(
      db('push_subscriptions')
        .where({ subscription_id: subscription.subscription_id })
        .delete(),
      /push subscription versions cannot be deleted/,
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
    // Persistence cannot recall key material a live worker already loaded. The
    // dispatcher contract therefore requires a subscription/job recheck just
    // before sending; this audit transition represents the residual race window.
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
    await db('push_subscriptions').insert({
      ...createSubscription({
        subscription_id: 'expired-subscription',
        user_id: 'expired-user',
      }),
      expires_at: db.raw(
        "strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+0.150 seconds')",
      ),
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    await assert.rejects(
      insertDeliveryJob(db, {
        jobId: 'expired-job',
        eventId: expiredEvent.event_id,
        userId: 'expired-user',
        subscriptionId: 'expired-subscription',
        // A caller-supplied old timestamp must not bypass current expiration.
        createdAt: timestamp,
      }),
      /push delivery requires an eligible recipient and active subscription/,
    );
    assert.strictEqual(
      await db('push_delivery_jobs').where({ job_id: 'expired-job' }).first(),
      undefined,
    );
  });

  test('versions subscription refreshes and cleans up natural expiration', async () => {
    const event = await seedEventAndRecipients(db);
    const subscription = createSubscription({
      subscription_id: 'subscription-version-1',
      expires_at: '2099-01-01T00:00:00.000Z',
    });
    await db('push_subscriptions').insert(subscription);
    await insertDeliveryJob(db, {
      jobId: 'version-1-job',
      eventId: event.event_id,
      subscriptionId: subscription.subscription_id,
    });

    await assert.rejects(
      db('push_subscriptions')
        .where({ subscription_id: subscription.subscription_id })
        .update({ expires_at: '2098-01-01T00:00:00.000Z' }),
      /push subscription versions are immutable/,
    );
    await db('push_subscriptions')
      .where({ subscription_id: subscription.subscription_id })
      .update({ revoked_at: '2026-08-02T08:03:00.000Z' });
    assert.strictEqual(
      (await db('push_delivery_jobs').where({ job_id: 'version-1-job' }).first()).status,
      'cancelled',
    );

    const refreshed = createSubscription({
      subscription_id: 'subscription-version-2-refresh',
      endpoint: subscription.endpoint,
      expires_at: '2098-01-01T00:00:00.000Z',
    });
    await db('push_subscriptions').insert(refreshed);
    assert.strictEqual(
      (await db('push_subscriptions')
        .where({ subscription_id: refreshed.subscription_id })
        .first()).revoked_at,
      null,
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
      ...sourceActivityClock('2026-08-02T08:10:00.000Z'),
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

    await assert.rejects(
      db('notification_source_activity')
        .where({ activity_type: 'task', activity_key: 'task-monotonic' })
        .update({
          status: 'queued',
          last_activity_at: '2026-08-02T08:11:00.000Z',
        }),
      /status cannot regress/,
    );

    await db('notification_source_activity')
      .insert({
        activity_type: 'task',
        activity_key: 'task-monotonic',
        repository: 'integry/propr',
        status: 'completed',
        last_activity_at: '2026-08-02T08:20:00.000Z',
        completed_at: '2026-08-02T08:20:00.000Z',
        ...sourceActivityClock('2026-08-02T08:20:00.000Z'),
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
        ...sourceActivityClock('2026-08-02T08:30:00.000Z'),
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
      await db('system_configs').insert({
        key: 'legacy-trigger-regression',
        value: JSON.stringify({ enabled: false }),
      });
      await db('system_configs').insert({
        key: 'user_repo_prefs_legacy-user',
        value: JSON.stringify({
          'Octo-Org/repo.name': { hidden: false },
          'owner--name/repo': { hidden: false },
          'owner/repo:name': { hidden: false },
        }),
      });
      await db.raw(`
        CREATE TABLE legacy_system_config_updates (
          config_key TEXT NOT NULL
        )
      `);
      await db.raw(`
        CREATE TRIGGER legacy_system_configs_touch_updated_at
        AFTER UPDATE OF value ON system_configs
        BEGIN
          UPDATE system_configs
          SET updated_at = '2026-08-02 08:00:00'
          WHERE key = NEW.key;
          INSERT INTO legacy_system_config_updates (config_key) VALUES (NEW.key);
        END
      `);

      const [, upgradeMigrations] = await db.migrate.latest();
      assert.strictEqual(upgradeMigrations[0], notificationMigrationName);
      assert.ok(upgradeMigrations.includes(notificationMigrationName));
      assert.strictEqual(await db.schema.hasTable('push_delivery_attempts'), true);
      assert.deepStrictEqual(
        await db('notification_repository_subscriptions')
          .where({ user_id: 'legacy-user' })
          .select('repository', 'hidden'),
        [{ repository: 'octo-org/repo.name', hidden: 0 }],
      );
      await db('system_configs')
        .where({ key: 'legacy-trigger-regression' })
        .update({ value: JSON.stringify({ enabled: true }) });
      const legacyConfig = await db('system_configs')
        .where({ key: 'legacy-trigger-regression' })
        .first();
      const legacyUpdates = await db('legacy_system_config_updates');
      assert.strictEqual(legacyConfig.updated_at, '2026-08-02 08:00:00');
      assert.deepStrictEqual(legacyUpdates, [{ config_key: 'legacy-trigger-regression' }]);

      const [, repeatedMigrations] = await db.migrate.latest();
      assert.deepStrictEqual(repeatedMigrations, []);
    } finally {
      await db.destroy();
    }
  });

  test('upgrades an existing database and restores its pre-upgrade rollback backup', async () => {
    const temporaryDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), 'propr-notification-upgrade-rollback-'),
    );
    const databasePath = path.join(temporaryDirectory, 'propr.sqlite');
    const backupPath = path.join(temporaryDirectory, 'pre-upgrade.sqlite');
    const migrationNames = fs.readdirSync(migrationsDirectory)
      .filter((name) => name.endsWith('.js'))
      .sort();
    const notificationMigrationIndex = migrationNames.indexOf(notificationMigrationName);
    let migrationDatabase: Knex | undefined;
    try {
      migrationDatabase = createMigrationRunnerDatabase(databasePath);
      for (const migrationName of migrationNames.slice(0, notificationMigrationIndex)) {
        await migrationDatabase.migrate.up({ name: migrationName });
      }
      await migrationDatabase('system_configs').insert({
        key: 'pre-upgrade-state',
        value: JSON.stringify({ retained: true }),
      });
      await migrationDatabase.destroy();
      migrationDatabase = undefined;
      fs.copyFileSync(databasePath, backupPath);

      migrationDatabase = createMigrationRunnerDatabase(databasePath);
      await migrationDatabase.migrate.latest();
      assert.strictEqual(
        await migrationDatabase.schema.hasTable('notification_instance_user_eligibility'),
        true,
      );
      assert.strictEqual(
        await migrationDatabase.schema.hasColumn('notification_events', 'enrichment_sequence'),
        true,
      );
      await migrationDatabase.destroy();
      migrationDatabase = undefined;

      fs.copyFileSync(backupPath, databasePath);
      migrationDatabase = createMigrationRunnerDatabase(databasePath);
      assert.strictEqual(await migrationDatabase.schema.hasTable('notification_events'), false);
      const restoredConfig = await migrationDatabase('system_configs')
        .where({ key: 'pre-upgrade-state' })
        .first();
      assert.strictEqual(restoredConfig.key, 'pre-upgrade-state');
      assert.strictEqual(restoredConfig.value, JSON.stringify({ retained: true }));
      assert.strictEqual(typeof restoredConfig.updated_at, 'string');
    } finally {
      await migrationDatabase?.destroy();
      fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });
});

describe('production SQLite connection initialization', { concurrency: false }, () => {
  test('applies and verifies required pragmas and reports callback errors', async () => {
    const temporaryDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), 'propr-notification-connection-'),
    );
    const previousDataDirectory = process.env.DATA_DIR;
    const previousNodeEnvironment = process.env.NODE_ENV;
    process.env.DATA_DIR = temporaryDirectory;
    process.env.NODE_ENV = 'production';

    const connectionModule = await import('../packages/core/src/db/connection.ts');
    try {
      const productionConfig = connectionModule
        .createKnexConfigForMigrations().production;
      assert.strictEqual(
        productionConfig.pool?.afterCreate,
        connectionModule.configurePooledSqliteConnection,
      );

      const pragmaCalls: string[] = [];
      const validConnection = {
        pragma(statement: string, options?: { simple?: boolean }): unknown {
          pragmaCalls.push(statement);
          if (options?.simple && statement === 'foreign_keys') {
            return 1;
          }
          if (options?.simple && statement === 'recursive_triggers') {
            return 1;
          }
          return undefined;
        },
      };
      await new Promise<void>((resolve, reject) => {
        connectionModule.configurePooledSqliteConnection(
          validConnection,
          (error, configuredConnection) => {
            if (error !== null) {
              reject(error);
              return;
            }
            assert.strictEqual(configuredConnection, validConnection);
            resolve();
          },
        );
      });
      for (const pragma of [
        'journal_mode = WAL',
        'foreign_keys = ON',
        'recursive_triggers = ON',
        'foreign_keys',
        'recursive_triggers',
      ]) {
        assert.ok(pragmaCalls.includes(pragma), pragma);
      }

      await new Promise<void>((resolve) => {
        connectionModule.configurePooledSqliteConnection(
          {
            pragma(statement: string, options?: { simple?: boolean }): unknown {
              if (statement === 'foreign_keys' && options?.simple) {
                return 0;
              }
              return 1;
            },
          },
          (error) => {
            assert.match(error?.message ?? '', /foreign_keys pragma must be enabled/);
            resolve();
          },
        );
      });
    } finally {
      await connectionModule.closeConnection();
      if (previousDataDirectory === undefined) {
        delete process.env.DATA_DIR;
      } else {
        process.env.DATA_DIR = previousDataDirectory;
      }
      if (previousNodeEnvironment === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = previousNodeEnvironment;
      }
      fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });
});
