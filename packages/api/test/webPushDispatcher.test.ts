import assert from 'node:assert/strict';
import { createECDH } from 'node:crypto';
import { after, afterEach, beforeEach, describe, test } from 'node:test';
import knex, { type Knex } from 'knex';
import type { SendResult } from 'web-push';
import { closeConnection, type BetterSqliteConnection } from '../../core/src/db/connection.js';
import { up as createNotificationSchema } from '../../core/src/db/migrations/20260802000000_create_notification_schema.js';
import { up as addPreferenceApis } from '../../core/src/db/migrations/20260802010000_add_notification_preference_apis.js';
import { NotificationService } from '../../core/src/services/notificationService.js';
import { WebPushDispatcher } from '../services/webPushDispatcher.js';

const success: SendResult = { statusCode: 201, body: '', headers: {} };

function createDatabase(): Knex {
  return knex({
    client: 'better-sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true,
    pool: {
      afterCreate(
        connection: BetterSqliteConnection,
        done: (error: Error | null, connection: BetterSqliteConnection) => void,
      ) {
        connection.pragma('foreign_keys = ON');
        connection.pragma('recursive_triggers = ON');
        done(null, connection);
      },
    },
  });
}

function vapidConfiguration() {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return {
    subject: 'mailto:notifications@example.com',
    publicKey: ecdh.getPublicKey(undefined, 'uncompressed').toString('base64url'),
    privateKey: ecdh.getPrivateKey().toString('base64url'),
  };
}

function browserPublicKey(): string {
  const privateKey = Buffer.alloc(32);
  privateKey[31] = 7;
  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(privateKey);
  return ecdh.getPublicKey(undefined, 'uncompressed').toString('base64url');
}

let database: Knex;
let notifications: NotificationService;
let userSequence = 0;

beforeEach(async () => {
  database = createDatabase();
  await createNotificationSchema(database);
  await addPreferenceApis(database);
  notifications = new NotificationService({
    database,
    now: () => new Date(Date.now() - 5_000),
  });
});

afterEach(async () => database.destroy());
after(async () => closeConnection());

async function queuedEvent(options: {
  pushEnabled?: boolean;
  quietHours?: { start: string; end: string; timezone: string };
  body?: string;
} = {}) {
  userSequence += 1;
  const userId = `push-user-${userSequence}`;
  await notifications.updateNotificationPreferences(userId, {
    preferences: { task: { pushEnabled: options.pushEnabled ?? true } },
    ...(options.quietHours === undefined ? {} : { quietHours: options.quietHours }),
  });
  const subscription = await notifications.upsertPushSubscription(userId, {
    endpoint: `https://fcm.googleapis.com/fcm/send/${userId}`,
    expirationTime: null,
    keys: { p256dh: browserPublicKey(), auth: 'A'.repeat(22) },
  });
  const event = await notifications.createNotificationEvent({
    deduplicationKey: `dispatcher:${userId}`,
    kind: 'task',
    severity: 'error',
    target: { type: 'task', repository: 'integry/propr', taskId: `task-${userId}` },
    title: 'Sensitive custom title',
    body: options.body ?? 'SECRET prompt text must stay out of the lock screen payload',
    recipients: [{ userId, pushEnabled: true }],
  });
  return { userId, subscription, event };
}

function dispatcher(sender: {
  sendNotification: (...args: Parameters<NonNullable<ConstructorParameters<typeof WebPushDispatcher>[0]['sender']>['sendNotification']>) => Promise<SendResult>;
}, overrides: Partial<ConstructorParameters<typeof WebPushDispatcher>[0]> = {}) {
  return new WebPushDispatcher({
    database,
    configuration: vapidConfiguration(),
    sender,
    frontendUrl: 'https://app.example.com/?tenant=installation-1',
    apiBaseUrl: 'https://api.example.com',
    leaseMs: 5_000,
    requestTimeoutMs: 1_000,
    ...overrides,
  });
}

describe('Web Push dispatcher', { concurrency: false }, () => {
  test('fans one eligible event out to every active subscription', async () => {
    userSequence += 1;
    const userId = `fanout-user-${userSequence}`;
    await notifications.updateNotificationPreferences(userId, {
      preferences: { task: { pushEnabled: true } },
    });
    for (const suffix of ['desktop', 'mobile']) {
      await notifications.upsertPushSubscription(userId, {
        endpoint: `https://fcm.googleapis.com/fcm/send/${userId}-${suffix}`,
        expirationTime: null,
        keys: { p256dh: browserPublicKey(), auth: 'A'.repeat(22) },
      });
    }
    await notifications.createNotificationEvent({
      deduplicationKey: `fanout:${userId}`,
      kind: 'task',
      target: { type: 'task', repository: 'integry/propr', taskId: userId },
      title: 'Task update',
      body: 'A task update is ready.',
      recipients: [{ userId, pushEnabled: true }],
    });

    assert.equal(Number((await database('push_delivery_jobs').count('* as count').first())?.count), 2);
  });

  test('delivers an allowed event with a lock-screen-safe payload', async () => {
    const { event } = await queuedEvent();
    const payloads: string[] = [];
    const worker = dispatcher({
      sendNotification: async (_subscription, payload) => {
        payloads.push(payload);
        return success;
      },
    });

    assert.equal(await worker.runOnce(), 1);
    assert.equal(payloads.length, 1);
    const payload = JSON.parse(payloads[0]) as Record<string, unknown>;
    assert.equal(payload.eventId, event.id);
    assert.equal(payload.unreadCount, 1);
    assert.equal(payload.apiBaseUrl, 'https://api.example.com/');
    assert.match(String(payload.deepLink), /^https:\/\/app\.example\.com\/tasks\//);
    assert.match(String(payload.deepLink), /tenant=installation-1/);
    assert.equal(payloads[0].includes('Sensitive custom title'), false);
    assert.equal(payloads[0].includes('SECRET prompt text'), false);
    assert.ok(Array.isArray(payload.actions));
    assert.ok(payload.actions.length <= 2);

    const job = await database('push_delivery_jobs').first();
    assert.equal(job.status, 'delivered');
    assert.equal(job.attempt_count, 1);
  });

  test('keeps the Inbox event but creates no job when the category is disabled', async () => {
    const { userId } = await queuedEvent({ pushEnabled: false });

    assert.equal((await notifications.listNotifications(userId)).notifications.length, 1);
    assert.equal(Number((await database('push_delivery_jobs').count('* as count').first())?.count), 0);
  });

  test('does not claim work during quiet hours', async () => {
    const now = new Date();
    const start = `${String(now.getUTCHours()).padStart(2, '0')}:${String(now.getUTCMinutes()).padStart(2, '0')}`;
    const endDate = new Date(now.getTime() + 60_000);
    const end = `${String(endDate.getUTCHours()).padStart(2, '0')}:${String(endDate.getUTCMinutes()).padStart(2, '0')}`;
    await queuedEvent({ quietHours: { start, end, timezone: 'UTC' } });
    let calls = 0;
    const worker = dispatcher({
      sendNotification: async () => { calls += 1; return success; },
    });

    assert.equal(await worker.runOnce(), 0);
    assert.equal(calls, 0);
    assert.equal((await database('push_delivery_jobs').first()).status, 'pending');
  });

  test('paginates past a quiet-hour prefix larger than the scan window', async () => {
    const quietUsers: string[] = [];
    for (let index = 0; index < 21; index += 1) {
      const queued = await queuedEvent({
        quietHours: { start: '00:00', end: '23:59', timezone: 'UTC' },
      });
      quietUsers.push(queued.userId);
    }
    const eligible = await queuedEvent();
    const dispatchAt = new Date();
    const currentMinute = dispatchAt.getUTCHours() * 60 + dispatchAt.getUTCMinutes();
    const formatMinute = (minute: number) => {
      const normalized = (minute + 24 * 60) % (24 * 60);
      return `${String(Math.floor(normalized / 60)).padStart(2, '0')}:${
        String(normalized % 60).padStart(2, '0')
      }`;
    };
    await database('notification_preference_settings')
      .whereIn('user_id', quietUsers)
      .update({
        quiet_hours_start: formatMinute(currentMinute - 1),
        quiet_hours_end: formatMinute(currentMinute + 1),
      });
    const deliveredEventIds: string[] = [];
    const worker = dispatcher({
      sendNotification: async (_subscription, payload) => {
        deliveredEventIds.push((JSON.parse(payload) as { eventId: string }).eventId);
        return success;
      },
    }, {
      batchSize: 1,
      now: () => dispatchAt,
    });

    assert.equal(await worker.runOnce(), 1);
    assert.deepEqual(deliveredEventIds, [eligible.event.id]);
    assert.equal(Number((await database('push_delivery_jobs')
      .where({ status: 'pending' })
      .count('* as count')
      .first())?.count), 21);
  });

  test('revokes and erases a subscription after a 410 response', async () => {
    const { subscription } = await queuedEvent();
    const worker = dispatcher({
      sendNotification: async () => Promise.reject({ statusCode: 410 }),
    });

    assert.equal(await worker.runOnce(), 1);
    const stored = await database('push_subscriptions')
      .where({ subscription_id: subscription.id })
      .first();
    assert.ok(stored.revoked_at);
    assert.equal(stored.p256dh_key, null);
    assert.equal(stored.auth_key, null);
    assert.equal((await database('push_delivery_jobs').first()).status, 'failed');
  });

  test('schedules 429 and 5xx responses, then retains a safe terminal summary', async () => {
    await queuedEvent();
    const retrying = dispatcher({
      sendNotification: async () => Promise.reject({
        statusCode: 429,
        endpoint: 'SECRET endpoint must not be persisted',
        body: 'SECRET provider body',
      }),
    }, { retryBaseMs: 10, retryCapMs: 10 });

    await retrying.runOnce();
    const retryable = await database('push_delivery_jobs').first();
    assert.equal(retryable.status, 'retryable');
    assert.ok(retryable.next_retry_at > retryable.updated_at);
    const firstAttempt = await database('push_delivery_attempts').first();
    assert.equal(firstAttempt.error_code, 'http_429');
    assert.doesNotMatch(JSON.stringify(firstAttempt), /SECRET/);

    await database.destroy();
    database = createDatabase();
    await createNotificationSchema(database);
    await addPreferenceApis(database);
    notifications = new NotificationService({ database, now: () => new Date(Date.now() - 5_000) });
    await queuedEvent();
    const exhausted = dispatcher({
      sendNotification: async () => Promise.reject({ statusCode: 503, body: 'SECRET' }),
    }, { maxAttempts: 1 });
    await exhausted.runOnce();
    const terminal = await database('push_delivery_jobs').first();
    const terminalAttempt = await database('push_delivery_attempts').first();
    assert.equal(terminal.status, 'failed');
    assert.equal(terminalAttempt.error_code, 'retry_exhausted');
    assert.doesNotMatch(JSON.stringify(terminalAttempt), /SECRET/);
  });

  test('a database lease prevents concurrent dispatcher instances from sending twice', async () => {
    await queuedEvent();
    let release!: () => void;
    let started!: () => void;
    const requestStarted = new Promise<void>(resolve => { started = resolve; });
    const pending = new Promise<void>(resolve => { release = resolve; });
    let calls = 0;
    const sender = {
      sendNotification: async () => {
        calls += 1;
        started();
        await pending;
        return success;
      },
    };
    const first = dispatcher(sender);
    const second = dispatcher(sender);
    const firstRun = first.runOnce();
    await requestStarted;
    assert.equal(await second.runOnce(), 0);
    release();
    await firstRun;
    assert.equal(calls, 1);
  });

  test('missing VAPID configuration disables startup with one sanitized warning', () => {
    const warnings: string[] = [];
    const worker = new WebPushDispatcher({
      database,
      configuration: {},
      logger: { info: () => undefined, warn: message => warnings.push(message) },
    });

    assert.deepEqual(worker.start(), { configured: false, publicKey: null });
    assert.deepEqual(worker.start(), { configured: false, publicKey: null });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /dispatcher disabled/i);
  });
});
