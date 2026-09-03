import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, describe, test } from 'node:test';
import type { Knex } from 'knex';
import { closeConnection, NotificationService } from '@propr/core';
import { TASK_UPDATE } from '@propr/shared';
import type { NotificationProjectionService } from '../services/notificationProjectionService.js';
import {
  countNotificationEvents,
  countUndismissedNotificationReceipts,
  createNotificationProjectionTestHarness,
  listActiveNotificationReceipts,
} from './notificationProjectionTestHarness.js';

let database: Knex;
let projection: NotificationProjectionService;
let clock: number;
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

describe('notification projection lifecycle races', { concurrency: false }, () => {
  test('replaces an older PR-attention card while preserving both audit events', async () => {
    const firstAt = iso();
    const secondAt = iso(1_000);
    await database('tasks').insert([
      {
        task_id: 'pr-work-first', repository: 'integry/propr', issue_number: 42,
        pr_number: 42, task_type: 'pr-comment', initial_job_data: '{}',
      },
      {
        task_id: 'pr-work-second', repository: 'integry/propr', issue_number: 42,
        pr_number: 42, task_type: 'pr-comment', initial_job_data: '{}',
      },
    ]);
    await database('task_history').insert([
      { task_id: 'pr-work-first', state: 'completed', timestamp: firstAt, metadata: '{}' },
      { task_id: 'pr-work-second', state: 'completed', timestamp: secondAt, metadata: '{}' },
    ]);

    await projection.projectTaskUpdate({
      eventType: TASK_UPDATE, taskId: 'pr-work-first', state: 'completed',
      repository: 'integry/propr', timestamp: firstAt,
    });
    clock += 1_000;
    await projection.projectTaskUpdate({
      eventType: TASK_UPDATE, taskId: 'pr-work-second', state: 'completed',
      repository: 'integry/propr', timestamp: secondAt,
    });

    const attentionEvents = await database('notification_events')
      .where({ kind: 'pull_request' });
    assert.equal(attentionEvents.length, 2, 'immutable audit events are retained');
    const visibleReceipts = await listActiveNotificationReceipts(database, 'pull_request');
    assert.deepEqual(visibleReceipts.map(row => row.user_id).sort(), [
      'admin-user', 'member-user',
    ]);
    assert.ok(visibleReceipts.every(row => row.occurred_at === secondAt));
  });

  test('does not recreate PR notifications after the durable merge transition', async () => {
    const beforeMergeAt = iso();
    const delayedAt = iso(1_000);
    await database('tasks').insert([
      {
        task_id: 'pr-before-merge', repository: 'integry/propr', issue_number: 42,
        pr_number: 42, task_type: 'pr-comment', initial_job_data: '{}',
      },
      {
        task_id: 'pr-delayed-after-merge', repository: 'integry/propr', issue_number: 42,
        pr_number: 42, task_type: 'pr-comment', initial_job_data: '{}',
      },
    ]);
    await database('task_history').insert([
      { task_id: 'pr-before-merge', state: 'completed', timestamp: beforeMergeAt, metadata: '{}' },
      { task_id: 'pr-delayed-after-merge', state: 'completed', timestamp: delayedAt, metadata: '{}' },
    ]);

    await projection.projectTaskUpdate({
      eventType: TASK_UPDATE, taskId: 'pr-before-merge', state: 'completed',
      repository: 'integry/propr', timestamp: beforeMergeAt,
    });
    const notifications = new NotificationService({ database, now: () => new Date(clock) });
    await notifications.markPullRequestMergedAndDismissNotifications(
      'integry/propr', 42, iso(500),
    );
    clock += 1_000;
    await projection.projectTaskUpdate({
      eventType: TASK_UPDATE, taskId: 'pr-delayed-after-merge', state: 'completed',
      repository: 'integry/propr', timestamp: delayedAt,
    });

    assert.equal(await countNotificationEvents(database), 1);
    assert.equal(await countUndismissedNotificationReceipts(database, 'task'), 0);
    assert.equal(await countUndismissedNotificationReceipts(database, 'pull_request'), 0);
    assert.deepEqual(
      await database('notification_pull_request_state').select('repository', 'pr_number'),
      [{ repository: 'integry/propr', pr_number: 42 }],
    );
  });
});
