import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, describe, test } from 'node:test';
import type { Knex } from 'knex';
import { closeConnection, NotificationService } from '@propr/core';
import { DRAFT_UPDATE, INDEXING_UPDATE, TASK_UPDATE } from '@propr/shared';
import { NotificationProjectionService } from '../services/notificationProjectionService.js';
import {
  countNotificationEvents,
  createNotificationProjectionTestHarness,
} from './notificationProjectionTestHarness.js';

let database: Knex;
let clock: number;
let projection: NotificationProjectionService;

const iso = (offsetMs = 0): string => new Date(clock + offsetMs).toISOString();

async function storeMonitoredRepos(value: unknown): Promise<void> {
  await database('system_configs')
    .insert({ key: 'repos_to_monitor', value: JSON.stringify(value) })
    .onConflict('key')
    .merge();
}

async function projectRepositoryLifecycle(repository: string, suffix: string): Promise<void> {
  await database('task_drafts').insert({
    draft_id: `draft-${suffix}`, user_id: 'draft-owner', repository, name: 'Plan',
  });
  await projection.projectDraftUpdate({
    eventType: DRAFT_UPDATE, draftId: `draft-${suffix}`, step: 'complete',
    status: 'completed', draftStatus: 'review', timestamp: iso(),
  });
  await database('tasks').insert([
    {
      task_id: `failed-${suffix}`, repository, issue_number: 1, pr_number: null,
      task_type: 'issue', initial_job_data: '{}',
    },
    {
      task_id: `completed-${suffix}`, repository, issue_number: 2, pr_number: null,
      task_type: 'issue', initial_job_data: '{}',
    },
    {
      task_id: `review-${suffix}`, repository, issue_number: null, pr_number: 3,
      task_type: 'review', initial_job_data: '{}',
    },
    {
      task_id: `pr-${suffix}`, repository, issue_number: 5, pr_number: 6,
      task_type: 'issue', initial_job_data: '{}',
    },
  ]);
  await projection.projectTaskUpdate({
    eventType: TASK_UPDATE, taskId: `failed-${suffix}`, state: 'failed',
    repository, issueNumber: 1, timestamp: iso(),
  });
  await projection.projectTaskUpdate({
    eventType: TASK_UPDATE, taskId: `completed-${suffix}`, state: 'completed',
    repository, issueNumber: 2, timestamp: iso(),
  });
  await projection.projectTaskUpdate({
    eventType: TASK_UPDATE, taskId: `review-${suffix}`, state: 'completed',
    repository, timestamp: iso(),
  });
  await projection.projectTaskUpdate({
    eventType: TASK_UPDATE, taskId: `pr-${suffix}`, state: 'completed',
    repository, issueNumber: 5, timestamp: iso(),
  });
  await projection.projectIndexingUpdate({
    eventType: INDEXING_UPDATE, repository, phase: 'failed', timestamp: iso(),
  });
}

beforeEach(async () => {
  clock = Date.now() - 60 * 60_000;
  ({ database, projection } = await createNotificationProjectionTestHarness(
    () => new Date(clock),
  ));
});

afterEach(async () => {
  projection.close();
  await database.destroy();
});

after(async () => closeConnection());

describe('repository notification filter', { concurrency: false }, () => {
  test('produces repository notifications by default, including for legacy entries', async () => {
    await storeMonitoredRepos(['integry/legacy', { id: 'a', name: 'integry/propr', enabled: true }]);

    await projectRepositoryLifecycle('integry/propr', 'default');
    await projectRepositoryLifecycle('integry/legacy', 'legacy');

    const kinds = await database('notification_events').where('target_json', 'like', '%integry/propr%').pluck('kind');
    assert.ok(kinds.includes('plan'));
    assert.ok(kinds.includes('task'));
    assert.ok(kinds.includes('review'));
    assert.ok(kinds.includes('pull_request'));
    assert.ok(kinds.includes('indexing'));
    assert.ok(await database('notification_events').where('target_json', 'like', '%integry/legacy%').first());
  });

  test('produces no repository notifications when the repository opts out, but keeps system failures', async () => {
    await storeMonitoredRepos([
      { id: 'main', name: 'integry/propr', enabled: true, baseBranch: 'main', notificationsEnabled: false },
      { id: 'release', name: 'INTEGRY/PROPR', enabled: true, baseBranch: 'release', notificationsEnabled: false },
    ]);

    await projectRepositoryLifecycle('integry/propr', 'muted');
    await database('tasks').insert({
      task_id: 'stalled-muted', repository: 'integry/propr', issue_number: 4,
      pr_number: null, task_type: 'issue', initial_job_data: '{}',
    });
    await projection.projectTaskUpdate({
      eventType: TASK_UPDATE, taskId: 'stalled-muted', state: 'processing',
      repository: 'integry/propr', issueNumber: 4, timestamp: iso(),
    });
    await projection.projectIndexingUpdate({
      eventType: INDEXING_UPDATE, repository: 'integry/propr', branch: 'main',
      phase: 'processing', timestamp: iso(),
    });
    clock += 45 * 60_000;
    await projection.detectStalledActivities();

    assert.equal(await countNotificationEvents(database), 0);
    // Source activity bookkeeping continues so stalled/resolution tracking stays correct.
    assert.ok(await database('notification_source_activity').where({ activity_key: 'stalled-muted' }).first());

    await projection.projectSystemSnapshot({
      timestamp: iso(), api: 'healthy', redis: 'disconnected', daemon: 'running',
      worker: 'running', githubAuth: 'connected', githubEventIntakeStatus: 'active',
      claudeAuth: 'connected', indexing: 'idle',
    });
    assert.equal(
      await database('notification_events').where({ kind: 'system_failure' }).count('* as count')
        .first().then(row => Number(row?.count)),
      1,
    );
  });

  test('keeps notifications enabled unless every branch entry opts out', async () => {
    await storeMonitoredRepos([
      { id: 'main', name: 'integry/propr', enabled: true, notificationsEnabled: false },
      { id: 'release', name: 'integry/propr', enabled: true, baseBranch: 'release' },
      { id: 'other', name: 'integry/other', enabled: true, notificationsEnabled: false },
    ]);

    await projection.projectIndexingUpdate({
      eventType: INDEXING_UPDATE, repository: 'integry/propr', phase: 'failed', timestamp: iso(),
    });
    await projection.projectIndexingUpdate({
      eventType: INDEXING_UPDATE, repository: 'integry/other', phase: 'failed', timestamp: iso(),
    });

    const targets = await database('notification_events').pluck('target_json');
    assert.equal(targets.length, 1);
    assert.match(targets[0], /integry\/propr/);
  });

  test('applies a changed setting after the short cache TTL', async () => {
    await storeMonitoredRepos([{ id: 'a', name: 'integry/propr', enabled: true }]);
    await projection.projectIndexingUpdate({
      eventType: INDEXING_UPDATE, repository: 'integry/propr', branch: 'one', phase: 'failed', timestamp: iso(),
    });
    await storeMonitoredRepos([{ id: 'a', name: 'integry/propr', enabled: true, notificationsEnabled: false }]);
    clock += 10_000;
    await projection.projectIndexingUpdate({
      eventType: INDEXING_UPDATE, repository: 'integry/propr', branch: 'two', phase: 'failed', timestamp: iso(),
    });

    assert.equal(await countNotificationEvents(database), 1);
  });

  test('fails open when the repository configuration cannot be read', async () => {
    const warnings: string[] = [];
    const failOpen = new NotificationProjectionService({
      database,
      notificationService: new NotificationService({ database, now: () => new Date(clock) }),
      now: () => new Date(clock),
      logger: { warn: message => warnings.push(message) },
    });
    await database('system_configs').insert({ key: 'repos_to_monitor', value: '{not json' });

    await failOpen.projectIndexingUpdate({
      eventType: INDEXING_UPDATE, repository: 'integry/propr', branch: 'one', phase: 'failed', timestamp: iso(),
    });
    await failOpen.projectIndexingUpdate({
      eventType: INDEXING_UPDATE, repository: 'integry/propr', branch: 'two', phase: 'failed', timestamp: iso(),
    });
    failOpen.close();

    assert.equal(await countNotificationEvents(database), 2);
    assert.deepEqual(warnings, ['[NotificationProjection] Failed to read repository notification settings']);
  });
});
