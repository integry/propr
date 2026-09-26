import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, describe, test } from 'node:test';
import type { Knex } from 'knex';
import { closeConnection, NotificationService } from '@propr/core';
import { TASK_UPDATE } from '@propr/shared';
import { NotificationProjectionService } from '../services/notificationProjectionService.js';
import {
  countNotificationEvents,
  countUndismissedNotificationReceipts,
  createNotificationProjectionTestHarness,
} from './notificationProjectionTestHarness.js';

let database: Knex;
let clock: number;
let projection: NotificationProjectionService;

const iso = (offsetMs = 0): string => new Date(clock + offsetMs).toISOString();

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

describe('notification lifecycle cleanup', { concurrency: false }, () => {
  test('uses the issue title instead of boilerplate completion text', async () => {
    await database('tasks').insert({
      task_id: 'implementation-description', repository: 'integry/propr', issue_number: 2103,
      pr_number: null, task_type: 'issue',
      initial_job_data: JSON.stringify({
        title: 'New Issue: Inbox notification cleanup',
        subtitle: 'Preparing a PR for issue #2103',
      }),
    });

    await projection.projectTaskUpdate({
      eventType: TASK_UPDATE, taskId: 'implementation-description', state: 'completed',
      repository: 'integry/propr', issueNumber: 2103, timestamp: iso(),
    });

    const event = await database('notification_events').first();
    assert.equal(event.title, 'Inbox notification cleanup');
    assert.equal(
      event.body,
      'Issue #2103 is complete. Open task details to review the result.',
    );
  });

  test('actively dismisses stalled cards when their task reaches a terminal state', async () => {
    const processingAt = iso(-30_000);
    await database('tasks').insert({
      task_id: 'task-resolved', repository: 'integry/propr', issue_number: 12,
      pr_number: null, task_type: 'issue', initial_job_data: '{}',
    });
    await projection.projectTaskUpdate({
      eventType: TASK_UPDATE, taskId: 'task-resolved', state: 'processing',
      repository: 'integry/propr', issueNumber: 12, timestamp: processingAt,
    });
    await projection.detectStalledActivities();
    assert.equal(await countUndismissedNotificationReceipts(database, 'task'), 2);

    clock += 1_000;
    await projection.projectTaskUpdate({
      eventType: TASK_UPDATE, taskId: 'task-resolved', state: 'failed',
      repository: 'integry/propr', issueNumber: 12, timestamp: iso(),
    });

    const active = await new NotificationService({ database }).listNotifications('admin-user');
    assert.deepEqual(active.notifications.map(notification => notification.title), [
      'Task failed for issue #12',
    ]);
    const delayedStall = await new NotificationService({
      database, now: () => new Date(clock),
    }).createSourceActivityNotificationEvent({
      type: 'task', key: 'task-resolved', repository: 'integry/propr',
      lastActivityAt: processingAt,
    }, {
      eventId: 'delayed-stalled-card', deduplicationKey: 'delayed-stalled-card',
      kind: 'task', severity: 'warning',
      target: {
        type: 'task', repository: 'integry/propr', taskId: 'task-resolved', issueNumber: 12,
      },
      title: 'Task appears stalled', body: 'This delayed card must not be created.',
      occurredAt: processingAt,
    }, ['admin-user']);
    assert.equal(delayedStall, null, 'a delayed detector cannot resurrect a stale card');
    assert.equal(await countNotificationEvents(database), 2, 'audit events are retained');
  });

  test('passively dismisses a stale activity card created after resolution', async () => {
    await database('tasks').insert({
      task_id: 'task-passive-cleanup', repository: 'integry/propr', issue_number: 13,
      pr_number: null, task_type: 'issue', initial_job_data: '{}',
    });
    await projection.projectTaskUpdate({
      eventType: TASK_UPDATE, taskId: 'task-passive-cleanup', state: 'failed',
      repository: 'integry/propr', issueNumber: 13, timestamp: iso(),
    });
    const notifications = new NotificationService({ database, now: () => new Date(clock) });
    await notifications.createNotificationEvent({
      eventId: 'legacy-stalled-card', deduplicationKey: 'legacy-stalled-card',
      kind: 'task', severity: 'warning',
      target: {
        type: 'task', repository: 'integry/propr', taskId: 'task-passive-cleanup',
        issueNumber: 13,
      },
      title: 'Task appears stalled', body: 'This legacy card is no longer relevant.',
      occurredAt: iso(),
    }, ['admin-user']);
    assert.equal(await countUndismissedNotificationReceipts(database, 'task'), 3);

    assert.equal(await projection.cleanupResolvedActivities(), 1);
    assert.equal(await projection.cleanupResolvedActivities(), 0);
    const active = await notifications.listNotifications('admin-user');
    assert.deepEqual(active.notifications.map(notification => notification.title), [
      'Task failed for issue #13',
    ]);
  });
});
