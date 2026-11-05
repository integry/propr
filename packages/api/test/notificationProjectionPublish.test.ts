import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, describe, test } from 'node:test';
import type { Knex } from 'knex';
import { closeConnection, NotificationService } from '@propr/core';
import { DRAFT_UPDATE, INDEXING_UPDATE, TASK_UPDATE } from '@propr/shared';
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

  test('a suppressed plan and a replayed plan never announce an Inbox arrival', async () => {
    const notifications = new NotificationService({ database, publishUpdate: async () => {} });
    await database('task_drafts').insert({
      draft_id: 'draft-muted', user_id: 'draft-owner', repository: 'integry/propr',
    });
    await notifications.updateNotificationPreferences('draft-owner', {
      preferences: { plan: { inboxEnabled: false, pushEnabled: false } },
    });
    const payload = {
      eventType: DRAFT_UPDATE, draftId: 'draft-muted', step: 'complete',
      status: 'completed' as const, draftStatus: 'review' as const, timestamp: iso(),
    };
    await projection.projectDraftUpdate(payload);
    assert.equal((await database('notification_events')).length, 1, 'the audit event still exists');
    assert.equal((await database('notification_user_states')).length, 0);
    assert.deepEqual(published, []);

    await notifications.updateNotificationPreferences('draft-owner', {
      preferences: { plan: { inboxEnabled: true } },
    });
    await projection.projectDraftUpdate(payload);
    assert.equal(published.length, 1, 'the replay assigns the newly eligible recipient');
    published.length = 0;
    await projection.projectDraftUpdate(payload);
    assert.deepEqual(published, [], 'returning the same event is not another arrival');
  });

  for (const taskType of ['issue', 'review']) {
    test(`replayed ${taskType} PR notifications announce only newly assigned receipts`, async () => {
      await database('tasks').insert({
        task_id: 'pr-task', repository: 'integry/propr', issue_number: 17,
        pr_number: 42, task_type: taskType, initial_job_data: '{}',
      });
      await new NotificationService({ database, publishUpdate: async () => {} })
        .updateNotificationPreferences('member-user', {
          preferences: {
            task: { inboxEnabled: false, pushEnabled: false },
            review: { inboxEnabled: false, pushEnabled: false },
            pull_request: { inboxEnabled: false, pushEnabled: false },
          },
        });
      const payload = {
        eventType: TASK_UPDATE, taskId: 'pr-task', state: 'completed',
        repository: 'integry/propr', issueNumber: 17, timestamp: iso(),
      };
      await projection.projectTaskUpdate(payload);
      const receipts = await database('notification_user_states').where({ inbox_enabled: true });
      assert.ok(receipts.length > 0);
      assert.equal(changesFor('created').length, receipts.length);
      assert.ok(published.every(frame => frame.recipientId === 'admin-user'));
      published.length = 0;
      await projection.projectTaskUpdate(payload);
      assert.deepEqual(published, []);

      await database('instance_members').insert({ github_user_id: 'new-member', role: 'member' });
      await projection.projectTaskUpdate(payload);
      assert.ok(published.length > 0);
      assert.ok(published.every(frame => frame.recipientId === 'new-member'));
    });
  }

  test('indexing failure and stalled activity replays stay quiet', async () => {
    const indexing = {
      eventType: INDEXING_UPDATE, repository: 'integry/propr', branch: 'main',
      phase: 'failed' as const, timestamp: iso(),
    };
    await projection.projectIndexingUpdate(indexing);
    assert.equal(changesFor('created').length, 1);
    published.length = 0;
    await projection.projectIndexingUpdate(indexing);
    assert.deepEqual(published, []);

    await database('tasks').insert({
      task_id: 'stalled-task', repository: 'integry/propr', task_type: 'issue',
      initial_job_data: '{}',
    });
    await projection.projectTaskUpdate({
      eventType: TASK_UPDATE, taskId: 'stalled-task', state: 'processing',
      repository: 'integry/propr', timestamp: iso(-30_000),
    });
    await projection.projectIndexingUpdate({
      ...indexing, branch: 'stalled-branch', phase: 'indexing', timestamp: iso(-30_000),
    });
    await projection.detectStalledActivities();
    assert.equal(changesFor('created').length, 3, 'task members and indexing administrator');
    published.length = 0;
    await projection.detectStalledActivities();
    assert.deepEqual(published, []);
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
    const failureEventId = (await database('notification_events')
      .where({ kind: 'system_failure' })
      .first()).event_id;
    published.length = 0;

    clock += 1_000;
    await projection.projectSystemSnapshot({ timestamp: iso(), redis: 'connected' });

    // The receipt the recovery closed is named, so the Inbox knows which card
    // left rather than only that something did.
    assert.deepEqual(changesFor('dismissed'), [
      { recipientId: 'admin-user', eventId: failureEventId },
    ]);

    // A component that stays healthy has nothing left to dismiss, so it is quiet.
    published.length = 0;
    clock += 1_000;
    await projection.projectSystemSnapshot({ timestamp: iso(), redis: 'connected' });
    assert.deepEqual(published, []);
  });

  test('tells the administrator who kept a failure card after losing the role', async () => {
    await projection.projectSystemSnapshot({ timestamp: iso(), redis: 'disconnected' });
    const failureEventId = (await database('notification_events')
      .where({ kind: 'system_failure' })
      .first()).event_id;
    // The administrator who received the card becomes an ordinary member while
    // the failure persists. Their receipt still belongs to them and their Inbox
    // still shows it, so the recovery has to reach them and not the
    // administrator who replaced them.
    await database('instance_members')
      .where({ github_user_id: 'admin-user' })
      .update({ role: 'member' });
    await database('instance_members')
      .where({ github_user_id: 'member-user' })
      .update({ role: 'admin' });
    published.length = 0;

    clock += 1_000;
    await projection.projectSystemSnapshot({ timestamp: iso(), redis: 'connected' });

    assert.deepEqual(changesFor('dismissed'), [
      { recipientId: 'admin-user', eventId: failureEventId },
    ]);
  });

  test('tells the holder of a seat-limit card when seats free up after a role change', async () => {
    const connectAccount = {
      installationId: 42, activeSeats: 2, allowedSeats: 2, seatsRemaining: 0,
      billingCycleResetAt: iso(30 * 24 * 60 * 60 * 1_000), seatLimitBlockedAt: iso(-5_000),
    };
    await projection.projectSystemSnapshot({ timestamp: iso(), connectAccount });
    const seatLimitEventId = (await database('notification_events')
      .where({ kind: 'system_failure' })
      .first()).event_id;
    await database('instance_members')
      .where({ github_user_id: 'admin-user' })
      .update({ role: 'member' });
    await database('instance_members')
      .where({ github_user_id: 'member-user' })
      .update({ role: 'admin' });
    published.length = 0;

    clock += 1_000;
    await projection.projectSystemSnapshot({
      timestamp: iso(),
      connectAccount: { ...connectAccount, activeSeats: 1, seatsRemaining: 1 },
    });

    assert.deepEqual(changesFor('dismissed'), [
      { recipientId: 'admin-user', eventId: seatLimitEventId },
    ]);
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
    await new NotificationService({ database, now: () => new Date(clock), publishUpdate: async () => {} })
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
