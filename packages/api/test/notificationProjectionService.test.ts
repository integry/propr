import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, describe, test } from 'node:test';
import type { Knex } from 'knex';
import { closeConnection, NotificationService } from '@propr/core';
import { DRAFT_UPDATE, INDEXING_UPDATE, TASK_UPDATE } from '@propr/shared';
import { NotificationProjectionService } from '../services/notificationProjectionService.js';
import {
  countNotificationEvents, countUndismissedNotificationReceipts,
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

describe('notification lifecycle projection', { concurrency: false }, () => {
  test('creates exactly one plan-ready event for the draft owner', async () => {
    await database('task_drafts').insert({
      draft_id: 'draft-1', user_id: 'draft-owner', repository: 'integry/propr',
    });
    const payload = {
      eventType: DRAFT_UPDATE,
      draftId: 'draft-1',
      runId: 'run-secret-is-not-copied',
      step: 'complete',
      status: 'completed' as const,
      draftStatus: 'review' as const,
      timestamp: iso(),
      data: { prompt: 'SECRET PROMPT' },
    };

    await projection.projectDraftUpdate(payload);
    await projection.projectDraftUpdate(payload);

    const events = await database('notification_events').select('*');
    assert.deepEqual(events.map(event => event.kind), ['plan']);
    assert.deepEqual(JSON.parse(events[0].advertised_actions_json), ['refine', 'approve_execute', 'dismiss']);
    assert.doesNotMatch(JSON.stringify(events[0]), /SECRET|run-secret/);
    assert.deepEqual(
      await database('notification_user_states').pluck('user_id'),
      ['draft-owner'],
    );
  });

  test('emits one descriptive notification for each completed task', async () => {
    const implementationAt = iso();
    await database('tasks').insert({
      task_id: 'implementation-1', repository: 'integry/propr', issue_number: 1719,
      pr_number: null, task_type: 'issue',
      initial_job_data: JSON.stringify({
        title: 'Follow-up PR #42: Deduplicate Inbox notifications',
        subtitle: 'Keep only the newest actionable Inbox update.',
      }),
    });
    await database('task_history').insert({
      task_id: 'implementation-1', state: 'completed', timestamp: implementationAt,
      metadata: JSON.stringify({
        prResult: { prNumber: 42, prUrl: 'https://evil.example/SECRET-token' },
        error: { stack: 'SECRET STACK' },
      }),
    });

    const implementationPayload = {
      eventType: TASK_UPDATE,
      taskId: 'implementation-1',
      state: 'completed',
      repository: 'integry/propr',
      issueNumber: 1719,
      timestamp: implementationAt,
      metadata: { prompt: 'SECRET PROMPT', prUrl: 'https://evil.example/' },
    };
    await projection.projectTaskUpdate(implementationPayload);
    await projection.projectTaskUpdate(implementationPayload);

    clock += 1_000;
    const reviewAt = iso();
    await database('tasks').insert({
      task_id: 'pr-comments-batch-integry-propr-7', repository: 'integry/propr',
      issue_number: 1719, pr_number: null, task_type: 'issue',
      initial_job_data: JSON.stringify({
        number: 7,
        title: 'Review PR #7 notification behavior',
        commentBody: 'SECRET COMMENT',
      }),
    });
    await database('task_history').insert({
      task_id: 'pr-comments-batch-integry-propr-7', state: 'completed',
      timestamp: reviewAt, metadata: JSON.stringify({ commandMode: 'review' }),
    });
    await projection.projectTaskUpdate({
      eventType: TASK_UPDATE,
      taskId: 'pr-comments-batch-integry-propr-7',
      state: 'completed',
      repository: 'integry/propr',
      timestamp: reviewAt,
    });

    const events = await database('notification_events')
      .select('kind', 'title', 'body', 'action_json')
      .orderBy('occurred_at') as Array<{
        kind: string; title: string; body: string; action_json: string | null;
      }>;
    assert.deepEqual(
      events.map(event => event.kind).sort(),
      ['pull_request', 'review'],
    );
    assert.deepEqual(events.map(event => ({ title: event.title, body: event.body })), [
      {
        title: 'Keep only the newest actionable Inbox update.',
        body: 'PR #42 is ready for review.',
      },
      {
        title: 'Review completed for PR #7',
        body: 'Review PR #7 notification behavior',
      },
    ]);
    const implementationPrEvent = events.find(event =>
      event.action_json?.includes('/pull/42'));
    assert.equal(
      JSON.parse(implementationPrEvent?.action_json ?? '{}').href,
      'https://github.com/integry/propr/pull/42',
    );
    assert.doesNotMatch(JSON.stringify(events), /evil\.example|SECRET/);
    assert.equal(await countNotificationEvents(database), 2);
  });

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

  test('ignores stale task transitions and emits one stalled event per unchanged activity', async () => {
    const activeAt = iso(-30_000);
    await database('tasks').insert({
      task_id: 'task-stale', repository: 'integry/propr', issue_number: 12,
      pr_number: null, task_type: 'issue', initial_job_data: '{}',
    });
    await projection.projectTaskUpdate({
      eventType: TASK_UPDATE, taskId: 'task-stale', state: 'processing',
      repository: 'integry/propr', issueNumber: 12, timestamp: activeAt,
    });
    await projection.projectTaskUpdate({
      eventType: TASK_UPDATE, taskId: 'task-stale', state: 'failed',
      repository: 'integry/propr', issueNumber: 12, timestamp: iso(-40_000),
    });

    await projection.detectStalledActivities();
    await projection.detectStalledActivities();

    const activity = await database('notification_source_activity').first();
    assert.equal(activity.status, 'processing');
    assert.equal(activity.last_activity_at, activeAt);
    const events = await database('notification_events')
      .select('kind', 'title', 'advertised_actions_json');
    assert.deepEqual(events.map(event => ({ kind: event.kind, title: event.title })), [
      { kind: 'task', title: 'Task appears stalled' },
    ]);
    assert.deepEqual(JSON.parse(events[0].advertised_actions_json), ['stop', 'dismiss']);
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

  test('projects a task failure once without copying error details', async () => {
    await database('tasks').insert({
      task_id: 'task-failed', repository: 'integry/propr', issue_number: 99,
      pr_number: null, task_type: 'issue', initial_job_data: '{}',
    });
    const payload = {
      eventType: TASK_UPDATE,
      taskId: 'task-failed',
      state: 'failed',
      repository: 'integry/propr',
      issueNumber: 99,
      timestamp: iso(),
      metadata: {
        reason: 'SECRET failure reason',
        error: 'SECRET stack trace',
      },
    };

    await projection.projectTaskUpdate(payload);
    await projection.projectTaskUpdate(payload);

    const events = await database('notification_events').select('*');
    assert.equal(events.length, 1);
    assert.equal(events[0].title, 'Task failed for issue #99');
    assert.doesNotMatch(JSON.stringify(events[0]), /SECRET/);
    assert.deepEqual(
      (await database('notification_user_states').pluck('user_id')).sort(),
      ['admin-user', 'member-user'],
    );
  });

  test('does not advertise Open PR when a trusted GitHub URL cannot be constructed', async () => {
    await database('tasks').insert({
      task_id: 'task-invalid-pr-url', repository: 'integry$/propr', issue_number: 99,
      pr_number: 42, task_type: 'issue', initial_job_data: '{}',
    });
    await database('task_history').insert({
      task_id: 'task-invalid-pr-url', state: 'completed', timestamp: iso(), metadata: '{}',
    });

    await projection.projectTaskUpdate({
      eventType: TASK_UPDATE,
      taskId: 'task-invalid-pr-url',
      state: 'completed',
      repository: 'integry$/propr',
      timestamp: iso(),
    });

    const events = await database('notification_events')
      .select('title', 'action_json', 'advertised_actions_json')
      .orderBy('title') as Array<{
        title: string;
        action_json: string | null;
        advertised_actions_json: string;
      }>;
    assert.deepEqual(events.map(event => event.title), [
      'PR #42 ready for review',
    ]);
    assert.ok(events.every(event => event.action_json === null));
    assert.deepEqual(events.map(event => JSON.parse(event.advertised_actions_json)), [
      ['dismiss'],
    ]);
  });

  test('advertises follow-up only with the stored repository and issue identity the endpoint requires', async () => {
    const failedAt = iso();
    const completedAt = iso(1_000);
    const reviewAt = iso(2_000);
    await database('tasks').insert([
      {
        task_id: 'failed-with-mismatched-payload-issue', repository: 'integry/propr',
        issue_number: 100, pr_number: null, task_type: 'issue', initial_job_data: '{}',
      },
      {
        task_id: 'completed-without-stored-issue', repository: 'integry/propr',
        issue_number: null, pr_number: null, task_type: 'issue', initial_job_data: '{}',
      },
      {
        task_id: 'review-without-stored-issue', repository: 'integry/propr',
        issue_number: null, pr_number: 7, task_type: 'review', initial_job_data: '{}',
      },
    ]);
    await database('task_history').insert([
      {
        task_id: 'completed-without-stored-issue', state: 'completed',
        timestamp: completedAt, metadata: '{}',
      },
      {
        task_id: 'review-without-stored-issue', state: 'completed',
        timestamp: reviewAt, metadata: JSON.stringify({ commandMode: 'review' }),
      },
    ]);

    await projection.projectTaskUpdate({
      eventType: TASK_UPDATE, taskId: 'failed-with-mismatched-payload-issue', state: 'failed',
      repository: 'integry/propr', issueNumber: 101, timestamp: failedAt,
    });
    clock += 1_000;
    await projection.projectTaskUpdate({
      eventType: TASK_UPDATE, taskId: 'completed-without-stored-issue', state: 'completed',
      repository: 'integry/propr', issueNumber: 102, timestamp: completedAt,
    });
    clock += 1_000;
    await projection.projectTaskUpdate({
      eventType: TASK_UPDATE, taskId: 'review-without-stored-issue', state: 'completed',
      repository: 'integry/propr', issueNumber: 103, timestamp: reviewAt,
    });

    const listed = await new NotificationService({ database }).listNotifications('admin-user');
    const lifecycleEvents = listed.notifications.filter(notification => [
      'Task failed for issue #101',
      'Issue #102 implementation completed',
      'Review completed for PR #7',
    ].includes(notification.title));
    assert.deepEqual(lifecycleEvents.map(notification => notification.title).sort(), [
      'Issue #102 implementation completed',
      'Review completed for PR #7',
      'Task failed for issue #101',
    ]);
    assert.ok(lifecycleEvents.every(notification => !notification.actions.includes('follow_up')));
  });

  test('advertises review follow-up only when the endpoint issue is the reviewed PR', async () => {
    const reviews = [
      { taskId: 'review-mismatched-thread', issueNumber: 1724, timestamp: iso() },
      { taskId: 'review-matching-thread', issueNumber: 1938, timestamp: iso(1_000) },
    ];
    await database('tasks').insert(reviews.map(review => ({
      task_id: review.taskId, repository: 'integry/propr', issue_number: review.issueNumber,
      pr_number: 1938, task_type: 'review', initial_job_data: '{}',
    })));
    await database('task_history').insert(reviews.map(review => ({
      task_id: review.taskId, state: 'completed', timestamp: review.timestamp,
      metadata: JSON.stringify({ commandMode: 'review' }),
    })));
    for (const review of reviews) {
      clock = Date.parse(review.timestamp);
      await projection.projectTaskUpdate({
        eventType: TASK_UPDATE, taskId: review.taskId, state: 'completed',
        repository: 'integry/propr', timestamp: review.timestamp,
      });
    }

    const listed = await new NotificationService({ database }).listNotifications('admin-user');
    const reviewByTask = new Map(listed.notifications
      .filter(notification => notification.target.type === 'review')
      .map(notification => [notification.target.taskId, notification]));
    assert.equal(reviewByTask.get(reviews[0].taskId)?.actions.includes('follow_up'), false);
    assert.equal(reviewByTask.get(reviews[1].taskId)?.actions.includes('follow_up'), true);
  });

  test('restricts indexing failures to administrators', async () => {
    const payload = {
      eventType: INDEXING_UPDATE,
      repository: 'integry/propr',
      branch: '1719/safe-branch',
      phase: 'failed' as const,
      timestamp: iso(),
    };
    await projection.projectIndexingUpdate(payload);
    await projection.projectIndexingUpdate(payload);

    assert.equal(await countNotificationEvents(database), 1);
    assert.deepEqual(
      await database('notification_user_states').pluck('user_id'),
      ['admin-user'],
    );
  });

  test('deduplicates system failures across instances and dismisses them on recovery', async () => {
    const unhealthy = {
      timestamp: iso(), api: 'healthy', redis: 'disconnected', daemon: 'running',
      worker: 'running', githubAuth: 'connected', githubEventIntakeStatus: 'active',
      claudeAuth: 'connected', indexing: 'idle',
      warnings: [{ message: 'SECRET SYSTEM ERROR' }],
    };
    await projection.projectSystemSnapshot(unhealthy);
    const secondProjection = new NotificationProjectionService({
      database,
      notificationService: new NotificationService({ database, now: () => new Date(clock) }),
      now: () => new Date(clock),
    });
    clock += 1_000;
    await secondProjection.projectSystemSnapshot({ ...unhealthy, timestamp: iso() });
    await projection.projectSystemSnapshot({
      ...unhealthy,
      timestamp: new Date(clock - 2_000).toISOString(),
      redis: 'connected',
    });
    clock += 1_000;
    await secondProjection.projectSystemSnapshot({
      ...unhealthy, timestamp: iso(), redis: 'connected',
    });

    let events = await database('notification_events').where({ kind: 'system_failure' });
    assert.equal(events.length, 1);
    assert.equal(
      await countUndismissedNotificationReceipts(database, 'system_failure'),
      0,
      'healthy recovery closes the active card',
    );

    clock += 1_000;
    await projection.projectSystemSnapshot({ ...unhealthy, timestamp: iso() });

    events = await database('notification_events').where({ kind: 'system_failure' });
    assert.equal(events.length, 2);
    assert.doesNotMatch(JSON.stringify(events), /SECRET SYSTEM ERROR/);
    assert.deepEqual(
      await database('notification_user_states').distinct('user_id').pluck('user_id'),
      ['admin-user'],
    );
    assert.equal(
      await countUndismissedNotificationReceipts(database, 'system_failure'),
      1,
    );
    secondProjection.close();
  });

  test('logs and isolates projection persistence failures', async () => {
    const warnings: string[] = [];
    const isolated = new NotificationProjectionService({
      database,
      notificationService: {
        createNotificationEvent: async () => {
          throw new Error('database unavailable');
        },
        createPullRequestAttentionNotificationEvent: async () => null,
        createPullRequestNotificationEvent: async () => null,
        createSourceActivityNotificationEvent: async () => null,
        reconcileSystemFailureTransition: async () => ({ accepted: true, event: null }),
      },
      logger: { warn: message => warnings.push(message) },
    });
    await database('task_drafts').insert({
      draft_id: 'draft-isolation', user_id: 'draft-owner', repository: 'integry/propr',
    });

    await assert.doesNotReject(() => isolated.bestEffort('draft publication', () =>
      isolated.projectDraftUpdate({
        eventType: DRAFT_UPDATE, draftId: 'draft-isolation', step: 'complete',
        status: 'completed', draftStatus: 'review', timestamp: iso(),
      })));
    assert.deepEqual(warnings, ['[NotificationProjection] Failed to project draft publication']);
  });
});
