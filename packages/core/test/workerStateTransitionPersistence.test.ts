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
import { up as fenceTerminalTaskTransitions }
  from '../src/db/migrations/20260804040000_fence_terminal_task_transitions.js';
import {
  persistHistoryMetadataNotificationEnrichment,
  persistIssueRefNotificationEnrichment,
}
  from '../src/utils/workerStateNotificationPersistence.js';
import {
  buildTaskTransitionKey,
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

test('duplicate task creation reconstructs the latest durable history', async () => {
  const database = await createDatabase();
  try {
    await persistTaskCreation(creationInput(
      database,
      'creation-redelivery',
      '2026-08-04T01:00:00.000Z'
    ));
    await persistTaskTransition({
      database,
      taskId: 'creation-redelivery',
      transitionKey: 'task-transition:processing',
      fallbackTimestamp: '2026-08-04T02:00:00.000Z',
      historyData: {
        task_id: 'creation-redelivery',
        state: 'processing',
        timestamp: '2026-08-04T02:00:00.000Z',
        reason: 'Processing',
        metadata: JSON.stringify({ attempts: 1, transitionFingerprint: 'processing' }),
      },
    });

    const redelivered = await persistTaskCreation(creationInput(
      database,
      'creation-redelivery',
      '2026-08-04T03:00:00.000Z'
    ));

    assert.deepEqual(redelivered.histories.map(row => row.state), ['pending', 'processing']);
    assert.equal(redelivered.histories.at(-1)?.transition_key, 'task-transition:processing');
  } finally {
    await database.destroy();
  }
});

test('the first terminal task transition fences competing and late callbacks', async () => {
  const database = await createDatabase();
  try {
    await fenceTerminalTaskTransitions(database);
    await persistTaskCreation(creationInput(
      database,
      'terminal-race',
      '2026-08-04T01:00:00.000Z'
    ));
    const completed = await persistTaskTransition({
      database,
      taskId: 'terminal-race',
      transitionKey: 'task-transition:completed',
      fallbackTimestamp: '2026-08-04T02:00:00.000Z',
      historyData: {
        task_id: 'terminal-race', state: 'completed',
        timestamp: '2026-08-04T02:00:00.000Z', reason: 'Completed',
        metadata: JSON.stringify({ transitionFingerprint: 'completed' }),
      },
    });
    const failed = await persistTaskTransition({
      database,
      taskId: 'terminal-race',
      transitionKey: 'task-transition:failed',
      fallbackTimestamp: '2026-08-04T02:00:01.000Z',
      historyData: {
        task_id: 'terminal-race', state: 'failed',
        timestamp: '2026-08-04T02:00:01.000Z', reason: 'Failed',
        metadata: JSON.stringify({ transitionFingerprint: 'failed' }),
      },
    });
    const lateProgress = await persistTaskTransition({
      database,
      taskId: 'terminal-race',
      transitionKey: 'task-transition:late-progress',
      fallbackTimestamp: '2026-08-04T02:00:02.000Z',
      historyData: {
        task_id: 'terminal-race', state: 'processing',
        timestamp: '2026-08-04T02:00:02.000Z', reason: 'Late progress',
        metadata: JSON.stringify({ transitionFingerprint: 'late-progress' }),
      },
    });

    assert.equal(completed.applied, true);
    assert.equal(failed.applied, false);
    assert.equal(failed.transition_key, completed.transition_key);
    assert.equal(lateProgress.applied, false);
    assert.deepEqual(await database('task_history')
      .where({ task_id: 'terminal-race' }).orderBy('history_id').pluck('state'), [
      'pending',
      'completed',
    ]);
  } finally {
    await database.destroy();
  }
});

test('terminal fencing archives post-terminal history and cascade evidence', async () => {
  const database = await createDatabase();
  try {
    await database('tasks').insert(taskData('legacy-terminal-corruption'));
    const [pendingId] = await database('task_history').insert({
      task_id: 'legacy-terminal-corruption', state: 'pending',
      timestamp: '2026-08-04T01:00:00.000Z', transition_key: 'pending',
    });
    const [completedId] = await database('task_history').insert({
      task_id: 'legacy-terminal-corruption', state: 'completed',
      timestamp: '2026-08-04T02:00:00.000Z', transition_key: 'completed',
    });
    const [lateProgressId] = await database('task_history').insert({
      task_id: 'legacy-terminal-corruption', state: 'processing',
      timestamp: '2026-08-04T03:00:00.000Z', transition_key: 'late-progress',
    });
    const [duplicateTerminalId] = await database('task_history').insert({
      task_id: 'legacy-terminal-corruption', state: 'failed',
      timestamp: '2026-08-04T04:00:00.000Z', transition_key: 'failed',
    });
    const [changeId] = await database('task_notification_enrichments').insert({
      task_id: 'legacy-terminal-corruption', state: 'failed',
      transition_history_id: duplicateTerminalId,
      transition_at: '2026-08-04T04:00:00.000Z',
      changed_at: '2026-08-04T04:01:00.000Z', metadata: '{}', change_key: 'failed-evidence',
    });

    await fenceTerminalTaskTransitions(database);

    assert.deepEqual(await database('task_history')
      .where({ task_id: 'legacy-terminal-corruption' })
      .orderBy('history_id').pluck('history_id'), [pendingId, completedId]);
    assert.equal(await database('task_notification_enrichments')
      .where({ change_id: changeId }).first(), undefined);
    const auditRows = await database('task_terminal_transition_cleanup_audit')
      .where({ task_id: 'legacy-terminal-corruption' })
      .orderBy(['record_type', 'record_id']);
    assert.deepEqual(auditRows.map(row => row.record_type), [
      'task_history', 'task_history', 'task_notification_enrichment'
    ]);
    assert.deepEqual(auditRows.slice(0, 2).map(row => JSON.parse(row.payload_json).history_id), [
      lateProgressId, duplicateTerminalId
    ]);
    assert.equal(JSON.parse(auditRows[2].payload_json).change_id, changeId);
  } finally {
    await database.destroy();
  }
});

test('same-state fallback transitions receive a distinct operation identity', () => {
  const metadata = { reason: 'Observed the same state' };
  const first = buildTaskTransitionKey('same-state-task', 'task-created:same-state-task',
    'processing', metadata);
  const second = buildTaskTransitionKey('same-state-task', first, 'processing', metadata);

  assert.notEqual(first, second);
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

test('history enrichment targets transition_key when timestamps collide', async () => {
  const database = await createDatabase();
  try {
    await persistTaskCreation(creationInput(
      database,
      'same-time-enrichment',
      '2026-08-04T01:00:00.000Z'
    ));
    const transitionAt = '2026-08-04T02:00:00.000Z';
    for (const transitionKey of ['task-transition:first', 'task-transition:second']) {
      await database('task_history').insert({
        task_id: 'same-time-enrichment',
        state: 'processing',
        timestamp: transitionAt,
        reason: transitionKey,
        metadata: '{}',
        transition_key: transitionKey,
      });
    }
    const state: TaskStateData = {
      taskId: 'same-time-enrichment',
      issueRef: { number: 1734, repoOwner: 'integry', repoName: 'propr' },
      correlationId: 'same-time-correlation',
      state: 'processing',
      createdAt: '2026-08-04T01:00:00.000Z',
      updatedAt: '2026-08-04T03:00:00.000Z',
      attempts: 0,
      history: [
        { state: 'pending', timestamp: '2026-08-04T01:00:00.000Z', reason: 'created' },
        {
          state: 'processing', timestamp: transitionAt, reason: 'first',
          transitionKey: 'task-transition:first', metadata: { prNumber: 1734 },
        },
        {
          state: 'processing', timestamp: transitionAt, reason: 'second',
          transitionKey: 'task-transition:second',
        },
      ],
    };

    await persistHistoryMetadataNotificationEnrichment({
      database,
      taskId: state.taskId,
      state,
      historyState: 'processing',
      historyIndex: 1,
      metadata: { prNumber: 1734 },
      transitionAt,
      transitionKey: 'task-transition:first',
      changeKey: 'task-enrichment:first',
    });

    const rows = await database('task_history')
      .where({ task_id: state.taskId })
      .whereIn('transition_key', ['task-transition:first', 'task-transition:second'])
      .orderBy('history_id');
    assert.deepEqual(rows.map(row => JSON.parse(String(row.metadata))), [
      { prNumber: 1734 },
      {},
    ]);
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
