import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, describe, test } from 'node:test';
import type { Knex } from 'knex';
import { closeConnection, NotificationService } from '@propr/core';
import { NotificationProjectionService } from '../services/notificationProjectionService.js';
import {
  countNotificationEvents,
  countUndismissedNotificationReceipts,
  createNotificationProjectionTestHarness,
} from './notificationProjectionTestHarness.js';

let database: Knex;
let clock: number;
let projection: NotificationProjectionService;

const iso = (): string => new Date(clock).toISOString();

beforeEach(async () => {
  clock = Date.now() - 60_000;
  ({ database, projection } = await createNotificationProjectionTestHarness(
    () => new Date(clock),
  ));
});

afterEach(async () => {
  projection.close();
  await database.destroy();
});

after(async () => closeConnection());

describe('Claude auth health projection', { concurrency: false }, () => {
  test('preserves an unknown applicable auth state as a failure', async () => {
    await projection.projectSystemSnapshot({ timestamp: iso(), claudeAuth: 'unknown' });

    const event = await database('notification_events').first();
    assert.equal(event.kind, 'system_failure');
    assert.deepEqual(JSON.parse(event.target_json), {
      type: 'system_failure', component: 'claudeAuth',
    });
    assert.equal(await countUndismissedNotificationReceipts(database, 'system_failure'), 1);
  });

  test('treats not-applicable as healthy and warns again when re-enabled unhealthy', async () => {
    const snapshot = {
      timestamp: iso(), api: 'healthy', redis: 'connected', daemon: 'running',
      worker: 'running', githubAuth: 'connected', githubEventIntakeStatus: 'active',
      claudeAuth: 'disconnected', indexing: 'idle',
    };
    await projection.projectSystemSnapshot(snapshot);
    assert.equal(await countNotificationEvents(database), 1);
    assert.equal(await countUndismissedNotificationReceipts(database, 'system_failure'), 1);

    clock += 1_000;
    await projection.projectSystemSnapshot({
      ...snapshot, timestamp: iso(), claudeAuth: 'not_applicable',
    });
    assert.equal(
      await countNotificationEvents(database),
      1,
      'disabling Claude must not create a recovery notification',
    );
    assert.equal(await countUndismissedNotificationReceipts(database, 'system_failure'), 0);

    clock += 1_000;
    await projection.projectSystemSnapshot({ ...snapshot, timestamp: iso() });
    assert.equal(await countNotificationEvents(database), 2);
    assert.equal(await countUndismissedNotificationReceipts(database, 'system_failure'), 1);
  });

  test('reconciles a legacy stale card without changing unrelated inbox history', async () => {
    const notifications = new NotificationService({ database, now: () => new Date(clock) });
    await notifications.createNotificationEvent({
      deduplicationKey: 'legacy-claude-auth-failure',
      kind: 'system_failure',
      severity: 'error',
      target: { type: 'system_failure', component: 'claudeAuth' },
      title: 'System component unhealthy',
      body: 'claudeAuth is not reporting a healthy status.',
      actions: ['dismiss'],
      occurredAt: iso(),
    }, ['admin-user']);
    await notifications.createNotificationEvent({
      deduplicationKey: 'unrelated-redis-failure',
      kind: 'system_failure',
      severity: 'error',
      target: { type: 'system_failure', component: 'redis' },
      title: 'System component unhealthy',
      body: 'redis is not reporting a healthy status.',
      actions: ['dismiss'],
      occurredAt: iso(),
    }, ['admin-user']);

    clock += 1_000;
    await projection.projectSystemSnapshot({ timestamp: iso(), claudeAuth: 'not_applicable' });

    const receipts = await database('notification_user_states as receipt')
      .join('notification_events as event', 'event.event_id', 'receipt.event_id')
      .select('event.deduplication_key', 'receipt.dismissed_at')
      .orderBy('event.deduplication_key');
    assert.equal(await countNotificationEvents(database), 2, 'audit events are retained');
    assert.equal(
      receipts.find(receipt => receipt.deduplication_key === 'legacy-claude-auth-failure')?.dismissed_at !== null,
      true,
    );
    assert.equal(
      receipts.find(receipt => receipt.deduplication_key === 'unrelated-redis-failure')?.dismissed_at,
      null,
    );
  });
});
