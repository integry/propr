/* eslint-disable max-lines -- lifecycle projection regressions share one database fixture */
import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, describe, mock, test } from 'node:test';
import type { Knex } from 'knex';
import { closeConnection, closeEventPublisher, NotificationService } from '@propr/core';
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

after(async () => {
  await closeConnection();
  // Notification writes now publish a push event; close the publisher's Redis
  // client so a test process is not held open by best-effort telemetry.
  await closeEventPublisher();
});

describe('notification lifecycle projection', { concurrency: false }, () => {
  test('creates exactly one plan-ready event for the draft owner', async () => {
    await database('task_drafts').insert({
      draft_id: 'draft-1', user_id: 'draft-owner', repository: 'integry/propr',
      name: 'Improve Inbox notifications',
      plan_json: JSON.stringify([{ title: 'Swipe dismissal' }, { title: 'Rich recaps' }]),
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
    assert.equal(events[0].title, 'Improve Inbox notifications');
    assert.equal(events[0].body, 'Ready for review with 2 planned tasks.');
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
        prResult: {
          prNumber: 42,
          prUrl: 'https://evil.example/SECRET-token',
          notificationRecap: 'Added notification deduplication and covered the refresh race.',
        },
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
      timestamp: reviewAt, metadata: JSON.stringify({
        commandMode: 'review',
        notificationRecap: 'Score 8/10 · 1 issue found: Restore unread count on undo',
      }),
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
        title: 'Deduplicate Inbox notifications',
        body: 'Added notification deduplication and covered the refresh race.',
      },
      {
        title: 'Review PR #7 notification behavior',
        body: 'Score 8/10 · 1 issue found: Restore unread count on undo',
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

  test('persists the actual fix and merge outcomes in completed PR notifications', async () => {
    const completions = [
      {
        taskId: 'fix-pr-81', commandMode: 'fix', timestamp: iso(),
        recap: 'Corrected the stale unread count and added a regression test.',
        title: 'Fix run completed for PR #81',
      },
      {
        taskId: 'merge-pr-81', commandMode: 'merge', timestamp: iso(1_000),
        recap: 'Merged main into feature/inbox and resolved conflicts in 2 files.',
        title: 'Merge completed for PR #81',
      },
    ];
    await database('tasks').insert(completions.map(completion => ({
      task_id: completion.taskId, repository: 'integry/propr', issue_number: 81,
      pr_number: 81, task_type: 'pr-comment', initial_job_data: '{}',
    })));
    await database('task_history').insert(completions.map(completion => ({
      task_id: completion.taskId, state: 'completed', timestamp: completion.timestamp,
      metadata: JSON.stringify({
        commandMode: completion.commandMode,
        notificationRecap: completion.recap,
      }),
    })));

    for (const completion of completions) {
      clock = Date.parse(completion.timestamp);
      await projection.projectTaskUpdate({
        eventType: TASK_UPDATE, taskId: completion.taskId, state: 'completed',
        repository: 'integry/propr', timestamp: completion.timestamp,
      });
    }

    const events = await database('notification_events')
      .where({ kind: 'pull_request' })
      .orderBy('occurred_at')
      .select('title', 'body');
    assert.deepEqual(events, completions.map(({ title, recap }) => ({ title, body: recap })));
    assert.equal(await countUndismissedNotificationReceipts(database, 'pull_request'), 2);
  });

  test('titles completed PR and failed issue notifications by the PR or issue title', async () => {
    const completedAt = iso();
    const failedAt = iso(1_000);
    await database('tasks').insert([
      {
        task_id: 'merge-pr-90', repository: 'integry/propr', issue_number: 90, pr_number: 90,
        task_type: 'pr-comment',
        initial_job_data: JSON.stringify({ title: 'Merge PR #90: Improve Inbox notifications' }),
      },
      {
        task_id: 'issue-91', repository: 'integry/propr', issue_number: 91, pr_number: null,
        task_type: 'issue', initial_job_data: JSON.stringify({ title: 'New Issue: Flatten the Inbox list' }),
      },
    ]);
    await database('task_history').insert({
      task_id: 'merge-pr-90', state: 'completed', timestamp: completedAt,
      metadata: JSON.stringify({ commandMode: 'merge', notificationRecap: 'Merged main without conflicts.' }),
    });

    await projection.projectTaskUpdate({
      eventType: TASK_UPDATE, taskId: 'merge-pr-90', state: 'completed',
      repository: 'integry/propr', timestamp: completedAt,
    });
    clock += 1_000;
    await projection.projectTaskUpdate({
      eventType: TASK_UPDATE, taskId: 'issue-91', state: 'failed',
      repository: 'integry/propr', issueNumber: 91, timestamp: failedAt,
    });

    const events = await database('notification_events')
      .orderBy('occurred_at')
      .select('kind', 'title', 'target_json');
    assert.deepEqual(events.map(event => ({ kind: event.kind, title: event.title })), [
      { kind: 'pull_request', title: 'Improve Inbox notifications' },
      { kind: 'task', title: 'Flatten the Inbox list' },
    ]);
    assert.equal(JSON.parse(events[0].target_json).prNumber, 90);
    assert.equal(JSON.parse(events[1].target_json).issueNumber, 91);
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
    assert.equal(
      (await database('notification_events').first('body')).body,
      'Indexing branch 1719/safe-branch stopped before completion.',
    );
    assert.deepEqual(
      await database('notification_user_states').pluck('user_id'),
      ['admin-user'],
    );
  });

  test('projects each Connect seat-limit block once for administrators', async () => {
    const blockedAt = iso(-5_000);
    const billingCycleResetAt = iso(30 * 24 * 60 * 60 * 1_000);
    const snapshot = {
      timestamp: iso(),
      connectAccount: {
        installationId: 42,
        accountLogin: 'integry',
        plan: 'community',
        hasPlusAccess: false,
        activeSeats: 2,
        allowedSeats: 2,
        seatsRemaining: 0,
        billingCycleResetAt,
        seatLimitBlockedAt: blockedAt,
        sentAt: iso(),
      },
    };

    await projection.projectSystemSnapshot(snapshot);
    await projection.projectSystemSnapshot({
      ...snapshot,
      timestamp: iso(1_000),
      connectAccount: { ...snapshot.connectAccount, sentAt: iso(1_000) },
    });

    const events = await database('notification_events').select('*');
    assert.equal(events.length, 1);
    assert.equal(events[0].kind, 'system_failure');
    assert.equal(events[0].severity, 'warning');
    assert.equal(events[0].title, 'GitHub event blocked by seat limit');
    assert.equal(
      events[0].body,
      `No developer seat was available when ProPR Connect received a GitHub event. Current usage is 2 of 2; the billing cycle resets at ${billingCycleResetAt}.`,
    );
    assert.equal(events[0].occurred_at, blockedAt);
    assert.deepEqual(JSON.parse(events[0].target_json), {
      type: 'system_failure', component: 'propr-connect-seat-limit',
    });
    assert.deepEqual(JSON.parse(events[0].metadata_json), {
      installationId: 42,
      activeSeats: 2,
      allowedSeats: 2,
      seatsRemaining: 0,
      billingCycleResetAt,
    });
    assert.deepEqual(
      await database('notification_user_states').pluck('user_id'),
      ['admin-user'],
    );

    const nextBlockedAt = iso(2_000);
    clock += 3_000;
    await projection.projectSystemSnapshot({
      ...snapshot,
      timestamp: iso(),
      connectAccount: {
        ...snapshot.connectAccount,
        seatLimitBlockedAt: nextBlockedAt,
        sentAt: iso(),
      },
    });
    assert.equal(await countNotificationEvents(database), 2);
  });

  test('removes the Connect seat-limit card once seats are available again', async () => {
    const connectAccount = {
      installationId: 42, activeSeats: 2, allowedSeats: 2, seatsRemaining: 0,
      billingCycleResetAt: iso(30 * 24 * 60 * 60 * 1_000), seatLimitBlockedAt: iso(-5_000),
    };
    await projection.projectSystemSnapshot({ timestamp: iso(), connectAccount });
    assert.equal(await countUndismissedNotificationReceipts(database, 'system_failure'), 1);

    clock += 1_000;
    await projection.projectSystemSnapshot({
      timestamp: iso(),
      connectAccount: { ...connectAccount, activeSeats: 1, seatsRemaining: 1 },
    });

    assert.equal(await countNotificationEvents(database), 1);
    assert.equal(await countUndismissedNotificationReceipts(database, 'system_failure'), 0);

    // Later healthy ticks find no active card and skip the dismissal write.
    const notificationService = new NotificationService({ database, now: () => new Date(clock) });
    const dismissals = mock.method(notificationService, 'dismissSystemFailureNotifications');
    const quietProjection = new NotificationProjectionService({ database, notificationService, now: () => new Date(clock) });
    clock += 1_000;
    await quietProjection.projectSystemSnapshot({
      timestamp: iso(),
      connectAccount: { ...connectAccount, activeSeats: 1, seatsRemaining: 1 },
    });
    quietProjection.close();
    assert.equal(dismissals.mock.callCount(), 0);
  });

  test('removes failure cards once the same task or indexing source later completes', async () => {
    await database('tasks').insert({
      task_id: 'task-retried', repository: 'integry/propr', issue_number: 51,
      pr_number: null, task_type: 'issue', initial_job_data: '{}',
    });
    await projection.projectTaskUpdate({
      eventType: TASK_UPDATE, taskId: 'task-retried', state: 'failed',
      repository: 'integry/propr', issueNumber: 51, timestamp: iso(),
    });
    await projection.projectIndexingUpdate({
      eventType: INDEXING_UPDATE, repository: 'integry/propr', branch: 'main',
      phase: 'failed', timestamp: iso(),
    });
    await projection.projectIndexingUpdate({
      eventType: INDEXING_UPDATE, repository: 'integry/propr', branch: 'feature',
      phase: 'failed', timestamp: iso(),
    });
    assert.equal(await countUndismissedNotificationReceipts(database, 'task'), 2);
    assert.equal(await countUndismissedNotificationReceipts(database, 'indexing'), 2);

    for (const state of ['processing', 'completed'] as const) {
      clock += 1_000;
      await projection.projectTaskUpdate({
        eventType: TASK_UPDATE, taskId: 'task-retried', state,
        repository: 'integry/propr', issueNumber: 51, timestamp: iso(),
      });
    }
    for (const phase of ['indexing', 'completed'] as const) {
      clock += 1_000;
      await projection.projectIndexingUpdate({
        eventType: INDEXING_UPDATE, repository: 'integry/propr', branch: 'main',
        phase, timestamp: iso(),
      });
    }

    const activeTaskTitles = await database('notification_user_states as receipt')
      .join('notification_events as event', 'event.event_id', 'receipt.event_id')
      .where({ 'event.kind': 'task' })
      .whereNull('receipt.dismissed_at')
      .distinct('event.title')
      .pluck('event.title');
    assert.deepEqual(activeTaskTitles, ['Issue #51 implementation completed']);
    const activeIndexingTargets = await database('notification_user_states as receipt')
      .join('notification_events as event', 'event.event_id', 'receipt.event_id')
      .where({ 'event.kind': 'indexing' })
      .whereNull('receipt.dismissed_at')
      .pluck('event.target_json');
    assert.deepEqual(activeIndexingTargets.map(target => JSON.parse(target).branch), ['feature']);
  });

  test('advertises PR commands only when the completed task can post to that pull request', async () => {
    const completions = [
      { taskId: 'implementation-with-pr', issueNumber: 70, prNumber: 71, timestamp: iso() },
      { taskId: 'implementation-invalid-repo', issueNumber: 72, prNumber: 73, timestamp: iso(1_000) },
    ];
    await database('tasks').insert(completions.map(completion => ({
      task_id: completion.taskId,
      repository: completion.taskId === 'implementation-invalid-repo' ? 'integry$/propr' : 'integry/propr',
      issue_number: completion.issueNumber, pr_number: completion.prNumber,
      task_type: 'issue', initial_job_data: '{}',
    })));
    for (const completion of completions) {
      clock = Date.parse(completion.timestamp);
      await projection.projectTaskUpdate({
        eventType: TASK_UPDATE, taskId: completion.taskId, state: 'completed',
        repository: 'integry/propr', timestamp: completion.timestamp,
      });
    }

    const events = await database('notification_events')
      .where({ kind: 'pull_request' })
      .orderBy('occurred_at')
      .select('advertised_actions_json');
    assert.deepEqual(events.map(event => JSON.parse(event.advertised_actions_json)), [
      ['follow_up', 'open_pr', 'dismiss'],
      ['dismiss'],
    ]);
  });

  test('ignores absent or malformed Connect seat-limit block signals', async () => {
    await projection.projectSystemSnapshot({
      timestamp: iso(),
      connectAccount: {
        installationId: 42,
        activeSeats: 2,
        allowedSeats: 2,
        seatsRemaining: 0,
        billingCycleResetAt: iso(1_000),
        seatLimitBlockedAt: 'not-a-timestamp',
      },
    });
    await projection.projectSystemSnapshot({
      timestamp: iso(1_000),
      connectAccount: {
        installationId: 42,
        activeSeats: 2,
        allowedSeats: 2,
        seatsRemaining: 0,
        billingCycleResetAt: iso(1_000),
        seatLimitBlockedAt: null,
      },
    });
    await projection.projectSystemSnapshot({
      timestamp: iso(2_000),
      connectAccount: {
        installationId: 42,
        activeSeats: 2,
        allowedSeats: 2,
        seatsRemaining: 0,
        billingCycleResetAt: iso(4_000),
        seatLimitBlockedAt: iso(3_000),
      },
    });

    assert.equal(await countNotificationEvents(database), 0);
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
    assert.equal(events[0].title, 'System component unhealthy: redis');
    assert.equal(events[0].body, 'redis reported “disconnected”; administrator attention may be required.');
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
