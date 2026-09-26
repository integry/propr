import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, describe, test } from 'node:test';
import type { Knex } from 'knex';
import { closeConnection, NotificationService } from '@propr/core';
import { DRAFT_UPDATE, TASK_UPDATE } from '@propr/shared';
import type {
  NotificationProjectionService,
  RecipientNotificationUpdate,
} from '../services/notificationProjectionService.js';
import {
  countUndismissedNotificationReceipts,
  createNotificationProjectionTestHarness,
} from './notificationProjectionTestHarness.js';

let database: Knex;
let clock: number;
let projection: NotificationProjectionService;
let published: RecipientNotificationUpdate[];

const iso = (offsetMs = 0): string => new Date(clock + offsetMs).toISOString();

const changesFor = (change: string): Array<{ recipientId: string; eventId?: string }> => published
  .filter(payload => payload.change === change)
  .map(payload => ({ recipientId: payload.recipientId, eventId: payload.eventId }));

beforeEach(async () => {
  clock = Date.now() - 60_000;
  ({ database, projection, published } = await createNotificationProjectionTestHarness(
    () => new Date(clock),
  ));
});

afterEach(async () => {
  projection.close();
  await database.destroy();
});

after(async () => closeConnection());

describe('notification projection publishing', { concurrency: false }, () => {
  test('tells the plan owner about a notification it just created', async () => {
    await database('task_drafts').insert({
      draft_id: 'draft-1', user_id: 'draft-owner', repository: 'integry/propr',
      name: 'Improve Inbox notifications', plan_json: JSON.stringify([{ title: 'Swipe' }]),
    });

    await projection.projectDraftUpdate({
      eventType: DRAFT_UPDATE, draftId: 'draft-1', step: 'complete',
      status: 'completed', draftStatus: 'review', timestamp: iso(),
    });

    const created = published.filter(payload => payload.change === 'created');
    assert.equal(created.length, 1);
    assert.equal(created[0].eventType, 'notification:update');
    assert.equal(created[0].recipientId, 'draft-owner');
    assert.equal(
      created[0].eventId,
      (await database('notification_events').first()).event_id,
    );
  });

  test('tells every recipient of a completed task, once each', async () => {
    await database('tasks').insert({
      task_id: 'implementation-1', repository: 'integry/propr', issue_number: 17,
      pr_number: null, task_type: 'issue', initial_job_data: '{}',
    });

    await projection.projectTaskUpdate({
      eventType: TASK_UPDATE, taskId: 'implementation-1', state: 'completed',
      repository: 'integry/propr', issueNumber: 17, timestamp: iso(),
    });

    assert.deepEqual(
      changesFor('created').map(payload => payload.recipientId).sort(),
      ['admin-user', 'member-user'],
    );
  });

  test('publishes nothing for a task update that creates no notification', async () => {
    await database('tasks').insert({
      task_id: 'implementation-2', repository: 'integry/propr', issue_number: 18,
      pr_number: null, task_type: 'issue', initial_job_data: '{}',
    });

    await projection.projectTaskUpdate({
      eventType: TASK_UPDATE, taskId: 'implementation-2', state: 'processing',
      repository: 'integry/propr', issueNumber: 18, timestamp: iso(),
    });

    assert.deepEqual(published, []);
  });

  test('announces an unhealthy component once, not on every health snapshot', async () => {
    const unhealthy = { redis: 'disconnected' };

    await projection.projectSystemSnapshot({ timestamp: iso(), ...unhealthy });
    const afterFirstSnapshot = changesFor('created').length;
    clock += 1_000;
    await projection.projectSystemSnapshot({ timestamp: iso(), ...unhealthy });

    assert.equal(afterFirstSnapshot, 1, 'the admin is told the card appeared');
    assert.equal(
      changesFor('created').length,
      afterFirstSnapshot,
      'the same card persisting is not a change the Inbox has to re-read for',
    );
  });

  test('tells administrators when a recovered component clears its card', async () => {
    await projection.projectSystemSnapshot({ timestamp: iso(), redis: 'disconnected' });
    published.length = 0;

    clock += 1_000;
    await projection.projectSystemSnapshot({ timestamp: iso(), redis: 'connected' });

    assert.deepEqual(changesFor('dismissed'), [{ recipientId: 'admin-user', eventId: undefined }]);

    // A component that stays healthy has nothing left to dismiss, so it is quiet.
    published.length = 0;
    clock += 1_000;
    await projection.projectSystemSnapshot({ timestamp: iso(), redis: 'connected' });
    assert.deepEqual(published, []);
  });

  test('announces a repeated Connect seat-limit block only when it first appears', async () => {
    const connectAccount = {
      installationId: 42, activeSeats: 2, allowedSeats: 2, seatsRemaining: 0,
      billingCycleResetAt: iso(30 * 24 * 60 * 60 * 1_000), seatLimitBlockedAt: iso(-5_000),
    };

    await projection.projectSystemSnapshot({ timestamp: iso(), connectAccount });
    assert.deepEqual(changesFor('created'), [
      { recipientId: 'admin-user', eventId: (await database('notification_events').first()).event_id },
    ]);

    published.length = 0;
    clock += 1_000;
    await projection.projectSystemSnapshot({ timestamp: iso(), connectAccount });
    assert.deepEqual(published, []);
  });

  test('tells recipients when a terminal transition dismisses their stalled card', async () => {
    await database('tasks').insert({
      task_id: 'task-resolved', repository: 'integry/propr', issue_number: 12,
      pr_number: null, task_type: 'issue', initial_job_data: '{}',
    });
    await projection.projectTaskUpdate({
      eventType: TASK_UPDATE, taskId: 'task-resolved', state: 'processing',
      repository: 'integry/propr', issueNumber: 12, timestamp: iso(-30_000),
    });
    await projection.detectStalledActivities();
    const stalledEventId = (await database('notification_events')
      .where({ kind: 'task', severity: 'warning' })
      .first()).event_id;
    assert.equal(await countUndismissedNotificationReceipts(database, 'task'), 2);
    published.length = 0;

    clock += 1_000;
    await projection.projectTaskUpdate({
      eventType: TASK_UPDATE, taskId: 'task-resolved', state: 'failed',
      repository: 'integry/propr', issueNumber: 12, timestamp: iso(),
    });

    assert.deepEqual(
      changesFor('dismissed').sort((a, b) => a.recipientId.localeCompare(b.recipientId)),
      [
        { recipientId: 'admin-user', eventId: stalledEventId },
        { recipientId: 'member-user', eventId: stalledEventId },
      ],
      'the server dismissed the card, so nothing else would tell the open Inbox',
    );
    // The replacement card is announced too, so the same read covers both.
    assert.equal(changesFor('created').length, 2);
  });

  test('tells recipients when the passive cleanup dismisses a stale card', async () => {
    await database('tasks').insert({
      task_id: 'task-passive-cleanup', repository: 'integry/propr', issue_number: 13,
      pr_number: null, task_type: 'issue', initial_job_data: '{}',
    });
    await projection.projectTaskUpdate({
      eventType: TASK_UPDATE, taskId: 'task-passive-cleanup', state: 'failed',
      repository: 'integry/propr', issueNumber: 13, timestamp: iso(),
    });
    await new NotificationService({ database, now: () => new Date(clock) })
      .createNotificationEvent({
        eventId: 'legacy-stalled-card', deduplicationKey: 'legacy-stalled-card',
        kind: 'task', severity: 'warning',
        target: {
          type: 'task', repository: 'integry/propr', taskId: 'task-passive-cleanup',
          issueNumber: 13,
        },
        title: 'Task appears stalled', body: 'This legacy card is no longer relevant.',
        occurredAt: iso(),
      }, ['admin-user']);
    published.length = 0;

    assert.equal(await projection.cleanupResolvedActivities(), 1);

    assert.deepEqual(changesFor('dismissed'), [
      { recipientId: 'admin-user', eventId: 'legacy-stalled-card' },
    ]);

    // A second sweep finds nothing, so it says nothing.
    published.length = 0;
    assert.equal(await projection.cleanupResolvedActivities(), 0);
    assert.deepEqual(published, []);
  });
});
