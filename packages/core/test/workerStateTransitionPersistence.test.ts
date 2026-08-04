import assert from 'node:assert/strict';
import { test } from 'node:test';
import knex, { type Knex } from 'knex';
import { up as addTaskNotificationEnrichments }
  from '../src/db/migrations/20260803040000_add_task_notification_enrichments.js';
import {
  down as removeWorkerStateTransitionIdentity,
  up as addWorkerStateTransitionIdentity,
}
  from '../src/db/migrations/20260804030000_idempotent_worker_state_transitions.js';
import { persistIssueRefNotificationEnrichment }
  from '../src/utils/workerStateNotificationPersistence.js';
import {
  persistTaskCreation,
  persistTaskTransition,
} from '../src/utils/workerStateTransitionPersistence.js';
import type { TaskStateData } from '../src/utils/workerStateManager.types.js';

async function createDatabase(): Promise<Knex> {
  const database = knex({
    client: 'better-sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true,
  });
  await database.raw('PRAGMA foreign_keys = ON');
  await database.schema.createTable('tasks', (table) => {
    table.text('task_id').primary();
    table.text('correlation_id');
    table.text('repository').notNullable();
    table.integer('issue_number');
    table.integer('pr_number');
    table.text('task_type').notNullable();
    table.text('model_name');
    table.text('created_at').notNullable();
    table.text('initial_job_data');
  });
  await database.schema.createTable('task_history', (table) => {
    table.increments('history_id').primary();
    table.text('task_id').notNullable().references('task_id').inTable('tasks')
      .onDelete('CASCADE');
    table.text('state').notNullable();
    table.text('timestamp').notNullable();
    table.text('reason');
    table.text('metadata');
  });
  await addTaskNotificationEnrichments(database);
  await addWorkerStateTransitionIdentity(database);
  return database;
}

function taskData(taskId: string): Record<string, unknown> {
  return {
    task_id: taskId,
    correlation_id: `correlation-${taskId}`,
    repository: 'integry/propr',
    issue_number: 1734,
    task_type: 'issue',
    model_name: 'codex',
    created_at: '2026-08-04T01:00:00.000Z',
    initial_job_data: JSON.stringify({
      number: 1734,
      repoOwner: 'integry',
      repoName: 'propr',
    }),
  };
}

function creationInput(database: Knex, taskId: string, timestamp: string) {
  return {
    database,
    taskData: taskData(taskId),
    historyData: {
      task_id: taskId,
      state: 'pending',
      timestamp,
      reason: 'Task created',
      metadata: '{}',
    },
    taskId,
    transitionKey: `task-created:${taskId}`,
    fallbackTimestamp: timestamp,
  };
}

test('task creation rolls back its task row when history persistence fails', async () => {
  const database = await createDatabase();
  try {
    await database.raw(`
      CREATE TRIGGER reject_task_history
      BEFORE INSERT ON task_history
      BEGIN
        SELECT RAISE(ABORT, 'injected history failure');
      END
    `);
    await assert.rejects(
      persistTaskCreation(creationInput(
        database,
        'atomic-create',
        '2026-08-04T01:00:00.000Z'
      )),
      /injected history failure/
    );
    assert.equal((await database('tasks').where({ task_id: 'atomic-create' })).length, 0);
    assert.equal((await database('task_history').where({ task_id: 'atomic-create' })).length, 0);
  } finally {
    await database.destroy();
  }
});

test('task creation and transitions reuse their durable row on retry', async () => {
  const database = await createDatabase();
  try {
    const firstCreation = await persistTaskCreation(creationInput(
      database,
      'retry-task',
      '2026-08-04T01:00:00.000Z'
    ));
    const retriedCreation = await persistTaskCreation(creationInput(
      database,
      'retry-task',
      '2026-08-04T02:00:00.000Z'
    ));
    assert.equal(retriedCreation.history.history_id, firstCreation.history.history_id);
    assert.equal(retriedCreation.history.timestamp, firstCreation.history.timestamp);

    const transitionKey = 'task-transition:stable-delivery';
    const firstTransition = await persistTaskTransition({
      database,
      taskId: 'retry-task',
      transitionKey,
      fallbackTimestamp: '2026-08-04T03:00:00.000Z',
      historyData: {
        task_id: 'retry-task',
        state: 'processing',
        timestamp: '2026-08-04T03:00:00.000Z',
        reason: 'Processing',
        metadata: JSON.stringify({ transitionFingerprint: 'stable-fingerprint' }),
      },
    });
    const retriedTransition = await persistTaskTransition({
      database,
      taskId: 'retry-task',
      transitionKey,
      fallbackTimestamp: '2026-08-04T04:00:00.000Z',
      historyData: {
        task_id: 'retry-task',
        state: 'processing',
        timestamp: '2026-08-04T04:00:00.000Z',
        reason: 'Processing',
        metadata: JSON.stringify({ transitionFingerprint: 'stable-fingerprint' }),
      },
    });
    assert.equal(retriedTransition.history_id, firstTransition.history_id);
    assert.equal(retriedTransition.timestamp, firstTransition.timestamp);
    assert.equal((await database('tasks').where({ task_id: 'retry-task' })).length, 1);
    assert.equal((await database('task_history').where({ task_id: 'retry-task' })).length, 2);
  } finally {
    await database.destroy();
  }
});

test('notification enrichment retry keeps a single durable change row', async () => {
  const database = await createDatabase();
  try {
    const created = await persistTaskCreation(creationInput(
      database,
      'enrichment-task',
      '2026-08-04T01:00:00.000Z'
    ));
    const state: TaskStateData = {
      taskId: 'enrichment-task',
      issueRef: {
        number: 1734,
        repoOwner: 'integry',
        repoName: 'propr',
        pullRequestNumber: 1734,
      },
      correlationId: 'correlation-enrichment-task',
      state: 'pending',
      createdAt: created.history.timestamp,
      updatedAt: '2026-08-04T02:00:00.000Z',
      attempts: 0,
      history: [{
        state: 'pending',
        timestamp: created.history.timestamp,
        reason: 'Task created',
      }],
    };
    const input = {
      database,
      taskId: state.taskId,
      state,
      issueRefPatch: { pullRequestNumber: 1734 },
      transitionAt: created.history.timestamp,
      changeKey: 'task-enrichment:stable-delivery',
    };
    await persistIssueRefNotificationEnrichment(input);
    state.updatedAt = '2026-08-04T03:00:00.000Z';
    await persistIssueRefNotificationEnrichment(input);

    const changes = await database('task_notification_enrichments')
      .where({ task_id: state.taskId });
    assert.equal(changes.length, 1);
    assert.equal(changes[0].changed_at, '2026-08-04T02:00:00.000Z');
  } finally {
    await database.destroy();
  }
});

test('worker transition identity migration rolls back its schema additions', async () => {
  const database = await createDatabase();
  try {
    await removeWorkerStateTransitionIdentity(database);
    assert.equal(await database.schema.hasColumn('task_history', 'transition_key'), false);
    assert.equal(await database.schema.hasColumn(
      'task_notification_enrichments',
      'change_key'
    ), false);
  } finally {
    await database.destroy();
  }
});
