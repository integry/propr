import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, describe, test } from 'node:test';
import knex, { type Knex } from 'knex';
import { closeConnection, NotificationService } from '@propr/core';
import { DRAFT_UPDATE, INDEXING_UPDATE, TASK_UPDATE } from '@propr/shared';
import { up as createNotificationSchema } from '../../core/src/db/migrations/20260802000000_create_notification_schema.js';
import { up as addNotificationPreferenceApis } from '../../core/src/db/migrations/20260802010000_add_notification_preference_apis.js';
import { NotificationProjectionService } from '../services/notificationProjectionService.js';

let database: Knex;
let clock: number;
let projection: NotificationProjectionService;

function iso(offsetMs = 0): string {
  return new Date(clock + offsetMs).toISOString();
}

async function eventCount(): Promise<number> {
  return database('notification_events')
    .count('* as count')
    .first()
    .then(row => Number(row?.count ?? 0));
}

async function createProjectionTables(db: Knex): Promise<void> {
  await db.schema.createTable('tasks', table => {
    table.text('task_id').primary();
    table.text('repository').notNullable();
    table.integer('issue_number').nullable();
    table.integer('pr_number').nullable();
    table.text('task_type').notNullable();
    table.text('initial_job_data').nullable();
  });
  await db.schema.createTable('task_history', table => {
    table.increments('history_id').primary();
    table.text('task_id').notNullable();
    table.text('state').notNullable();
    table.text('timestamp').notNullable();
    table.text('metadata').nullable();
  });
  await db.schema.createTable('task_drafts', table => {
    table.text('draft_id').primary();
    table.text('user_id').notNullable();
    table.text('repository').notNullable();
  });
  await db.schema.createTable('instance_members', table => {
    table.text('github_user_id').primary();
    table.text('role').notNullable();
  });
}

beforeEach(async () => {
  clock = Date.now() - 60_000;
  database = knex({
    client: 'better-sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true,
    pool: {
      afterCreate(connection: { pragma(statement: string): void }, done: (error: Error | null, connection: unknown) => void) {
        connection.pragma('foreign_keys = ON');
        connection.pragma('recursive_triggers = ON');
        done(null, connection);
      },
    },
  });
  await createProjectionTables(database);
  await createNotificationSchema(database);
  await addNotificationPreferenceApis(database);
  const notificationService = new NotificationService({
    database,
    now: () => new Date(clock),
  });
  projection = new NotificationProjectionService({
    database,
    notificationService,
    now: () => new Date(clock),
    stalledAfterMs: 10_000,
  });
  await database('instance_members').insert([
    { github_user_id: 'admin-user', role: 'admin' },
    { github_user_id: 'member-user', role: 'member' },
  ]);
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
    assert.equal(events.length, 1);
    assert.equal(events[0].kind, 'plan');
    assert.doesNotMatch(JSON.stringify(events[0]), /SECRET|run-secret/);
    assert.deepEqual(
      await database('notification_user_states').pluck('user_id'),
      ['draft-owner'],
    );
  });

  test('separates implementation, review, and sanitized PR-attention events', async () => {
    const implementationAt = iso();
    await database('tasks').insert({
      task_id: 'implementation-1', repository: 'integry/propr', issue_number: 1719,
      pr_number: null, task_type: 'issue', initial_job_data: '{}',
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
      initial_job_data: JSON.stringify({ number: 7, commentBody: 'SECRET COMMENT' }),
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
      .select('kind', 'title', 'action_json')
      .orderBy('occurred_at') as Array<{ kind: string; title: string; action_json: string | null }>;
    assert.deepEqual(
      events.map(event => event.kind).sort(),
      ['pull_request', 'pull_request', 'review', 'task'],
    );
    assert.ok(events.some(event => event.title === 'Implementation completed'));
    assert.ok(events.some(event => event.title === 'Review completed'));
    const implementationPrEvent = events.find(event =>
      event.action_json?.includes('/pull/42'));
    assert.equal(
      JSON.parse(implementationPrEvent?.action_json ?? '{}').href,
      'https://github.com/integry/propr/pull/42',
    );
    assert.doesNotMatch(JSON.stringify(events), /evil\.example|SECRET/);
    assert.equal(await eventCount(), 4);
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
    const events = await database('notification_events').select('kind', 'title');
    assert.deepEqual(events, [{ kind: 'task', title: 'Task appears stalled' }]);
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
    assert.equal(events[0].title, 'Task failed');
    assert.doesNotMatch(JSON.stringify(events[0]), /SECRET/);
    assert.deepEqual(
      (await database('notification_user_states').pluck('user_id')).sort(),
      ['admin-user', 'member-user'],
    );
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

    assert.equal(await eventCount(), 1);
    assert.deepEqual(
      await database('notification_user_states').pluck('user_id'),
      ['admin-user'],
    );
  });

  test('deduplicates one unhealthy period and allows a later failure after recovery', async () => {
    const unhealthy = {
      timestamp: iso(), api: 'healthy', redis: 'disconnected', daemon: 'running',
      worker: 'running', githubAuth: 'connected', githubEventIntakeStatus: 'active',
      claudeAuth: 'connected', indexing: 'idle',
      warnings: [{ message: 'SECRET SYSTEM ERROR' }],
    };
    await projection.projectSystemSnapshot(unhealthy);
    clock += 1_000;
    await projection.projectSystemSnapshot({ ...unhealthy, timestamp: iso() });
    await projection.projectSystemSnapshot({
      ...unhealthy,
      timestamp: new Date(clock - 2_000).toISOString(),
      redis: 'connected',
    });
    clock += 1_000;
    await projection.projectSystemSnapshot({ ...unhealthy, timestamp: iso(), redis: 'connected' });
    clock += 1_000;
    await projection.projectSystemSnapshot({ ...unhealthy, timestamp: iso() });

    const events = await database('notification_events').where({ kind: 'system_failure' });
    assert.equal(events.length, 2);
    assert.doesNotMatch(JSON.stringify(events), /SECRET SYSTEM ERROR/);
    assert.deepEqual(
      await database('notification_user_states').distinct('user_id').pluck('user_id'),
      ['admin-user'],
    );
  });

  test('logs and isolates projection persistence failures', async () => {
    const warnings: string[] = [];
    const isolated = new NotificationProjectionService({
      database,
      notificationService: {
        createNotificationEvent: async () => {
          throw new Error('database unavailable');
        },
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
