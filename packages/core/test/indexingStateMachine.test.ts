import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, describe, test } from 'node:test';
import knex, { type Knex } from 'knex';
import { closeConnection } from '../src/db/connection.js';
import {
  recordSkippedIndexingRun,
  updateRepositoryStatus,
} from '../src/services/relevance/summaryMinerQueries.js';

let database: Knex;

beforeEach(async () => {
  database = knex({
    client: 'better-sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true,
  });
  await database.schema.createTable('repositories', (table) => {
    table.text('full_name').notNullable();
    table.text('branch').notNullable();
    table.text('indexing_status').notNullable();
    table.text('indexing_transition_at');
    table.text('indexing_run_id');
    table.text('created_at').notNullable();
    table.text('updated_at').notNullable();
    table.text('last_indexed_at');
    table.text('last_indexed_hash');
    table.text('last_indexed_commit_message');
    table.text('icon_path');
    table.unique(['full_name', 'branch']);
  });
  await database.schema.createTable('repository_indexing_transitions', (table) => {
    table.increments('transition_id').primary();
    table.text('full_name').notNullable();
    table.text('branch').notNullable();
    table.text('run_id').notNullable();
    table.text('status').notNullable();
    table.text('transition_at').notNullable();
    table.text('observed_at').notNullable();
    table.unique(['full_name', 'branch', 'run_id', 'status', 'transition_at']);
  });
  await database.raw(`
    CREATE UNIQUE INDEX repository_indexing_transitions_terminal_run_unique
    ON repository_indexing_transitions (full_name, branch, run_id)
    WHERE status IN ('idle', 'completed', 'failed')
  `);
});

afterEach(async () => database.destroy());
after(async () => closeConnection());

function statusOptions(runId: string, transitionAt = '2000-01-01T00:00:00.000Z') {
  return { runId, transitionAt, database };
}

describe('repository indexing run state machine', { concurrency: false }, () => {
  test('a consumer cannot create a producer-owned run before durable acceptance', async () => {
    const transition = await updateRepositoryStatus('acme/api', 'indexing', 'main', {
      ...statusOptions('producer-run'),
      requireExistingRun: true,
    });

    assert.equal(transition.applied, false);
    assert.equal(await database('repositories').count<{ count: number }>('* as count')
      .first().then((row) => Number(row?.count)), 0);
    assert.equal(await database('repository_indexing_transitions')
      .count<{ count: number }>('* as count').first().then((row) => Number(row?.count)), 0);
  });

  test('a stable legacy job identity cannot adopt a replacement run', async () => {
    await updateRepositoryStatus('acme/api', 'indexing', 'main', {
      ...statusOptions('replacement-run'),
      startNewRun: true,
    });

    const legacy = await updateRepositoryStatus('acme/api', 'indexing', 'main', {
      ...statusOptions('legacy-job-run'),
      startNewRunIfIdle: true,
    });

    assert.equal(legacy.applied, false);
    assert.deepEqual(
      await database('repositories').first('indexing_status', 'indexing_run_id'),
      { indexing_status: 'indexing', indexing_run_id: 'replacement-run' }
    );
  });

  test('a successful stop rejects late completion and failure from the same run', async () => {
    const started = await updateRepositoryStatus('acme/api', 'indexing', 'main', {
      ...statusOptions('run-1'),
      startNewRun: true,
    });
    assert.equal(started.applied, true);

    const stopped = await updateRepositoryStatus(
      'acme/api',
      'idle',
      'main',
      statusOptions('run-1')
    );
    const completed = await updateRepositoryStatus(
      'acme/api',
      'completed',
      'main',
      statusOptions('run-1')
    );
    const failed = await updateRepositoryStatus(
      'acme/api',
      'failed',
      'main',
      statusOptions('run-1')
    );

    assert.equal(stopped.applied, true);
    assert.equal(completed.applied, false);
    assert.equal(failed.applied, false);
    assert.deepEqual(
      await database('repositories').first('indexing_status', 'indexing_run_id'),
      { indexing_status: 'idle', indexing_run_id: 'run-1' }
    );
    assert.deepEqual(
      await database('repository_indexing_transitions').orderBy('transition_id').pluck('status'),
      ['indexing', 'idle']
    );
  });

  test('a database-accepted replacement is not rejected by an older producer clock', async () => {
    await updateRepositoryStatus('acme/api', 'indexing', 'main', {
      ...statusOptions('run-newer-clock', '2099-01-01T00:00:00.000Z'),
      startNewRun: true,
    });
    const replacement = await updateRepositoryStatus('acme/api', 'indexing', 'main', {
      ...statusOptions('run-accepted-later', '2000-01-01T00:00:00.000Z'),
      startNewRun: true,
    });

    assert.equal(replacement.applied, true);
    assert.equal(
      await database('repositories').first('indexing_run_id').then((row) => row?.indexing_run_id),
      'run-accepted-later'
    );
    const history = await database('repository_indexing_transitions')
      .orderBy('transition_id')
      .select('run_id', 'status', 'transition_at');
    assert.deepEqual(history.map(({ run_id, status }) => ({ run_id, status })), [
      { run_id: 'run-newer-clock', status: 'indexing' },
      { run_id: 'run-newer-clock', status: 'idle' },
      { run_id: 'run-accepted-later', status: 'indexing' },
    ]);
    assert.ok(Date.parse(history[1].transition_at) < Date.parse(history[2].transition_at));
  });

  test('a legacy terminal callback cannot overwrite an already terminal run', async () => {
    await updateRepositoryStatus('acme/api', 'indexing', 'main', {
      ...statusOptions('run-legacy-callback'),
      startNewRun: true,
    });
    await updateRepositoryStatus(
      'acme/api',
      'completed',
      'main',
      statusOptions('run-legacy-callback')
    );

    const lateCancellation = await updateRepositoryStatus('acme/api', 'idle', 'main', {
      database,
    });

    assert.equal(lateCancellation.applied, false);
    assert.deepEqual(
      await database('repositories').first('indexing_status', 'indexing_run_id'),
      { indexing_status: 'completed', indexing_run_id: 'run-legacy-callback' }
    );
  });

  test('history fallback refuses to cancel a run that already completed', async () => {
    await updateRepositoryStatus('acme/api', 'indexing', 'main', {
      ...statusOptions('run-completed-first'),
      startNewRun: true,
    });
    await updateRepositoryStatus(
      'acme/api',
      'completed',
      'main',
      statusOptions('run-completed-first')
    );

    const cancellation = await recordSkippedIndexingRun(
      'acme/api',
      'main',
      { runId: 'run-completed-first', transitionAt: '2000-01-01T00:00:00.000Z' },
      database
    );

    assert.equal(cancellation.applied, false);
    assert.deepEqual(
      await database('repository_indexing_transitions').orderBy('transition_id').pluck('status'),
      ['indexing', 'completed']
    );
  });

  test('a removed queued run records a terminal transition without replacing its owner', async () => {
    await updateRepositoryStatus('acme/api', 'indexing', 'main', {
      ...statusOptions('active-owner'),
      startNewRun: true,
    });
    const skipped = await recordSkippedIndexingRun(
      'acme/api',
      'main',
      { runId: 'queued-run', transitionAt: '2000-01-01T00:00:00.000Z' },
      database
    );

    assert.equal(skipped.applied, true);
    assert.equal(
      await database('repositories').first('indexing_run_id').then((row) => row?.indexing_run_id),
      'active-owner'
    );
    assert.equal(
      await database('repository_indexing_transitions')
        .where({ run_id: 'queued-run' })
        .first('status')
        .then((row) => row?.status),
      'idle'
    );
    const lateProducer = await updateRepositoryStatus('acme/api', 'indexing', 'main', {
      ...statusOptions('queued-run'),
      startNewRun: true,
    });
    assert.equal(lateProducer.applied, false);
  });

  test('a skipped run closes the durable owner when startup won the race', async () => {
    await updateRepositoryStatus('acme/api', 'indexing', 'main', {
      ...statusOptions('starting-run'),
      startNewRun: true,
    });

    const skipped = await recordSkippedIndexingRun(
      'acme/api',
      'main',
      { runId: 'starting-run', transitionAt: '2000-01-01T00:00:00.000Z' },
      database
    );

    assert.equal(skipped.applied, true);
    assert.deepEqual(
      await database('repositories').first('indexing_status', 'indexing_run_id'),
      { indexing_status: 'idle', indexing_run_id: 'starting-run' }
    );
  });

  test('the database rejects contradictory terminal results for one run', async () => {
    await updateRepositoryStatus('acme/api', 'indexing', 'main', {
      ...statusOptions('terminal-invariant-run'),
      startNewRun: true,
    });
    await updateRepositoryStatus(
      'acme/api',
      'completed',
      'main',
      statusOptions('terminal-invariant-run')
    );

    await assert.rejects(database('repository_indexing_transitions').insert({
      full_name: 'acme/api',
      branch: 'main',
      run_id: 'terminal-invariant-run',
      status: 'failed',
      transition_at: new Date().toISOString(),
      observed_at: new Date().toISOString(),
    }), /UNIQUE constraint failed/);
  });

  test('terminal history repairs a legacy owner that was reopened after completion', async () => {
    await updateRepositoryStatus('acme/api', 'indexing', 'main', {
      ...statusOptions('reopened-run'),
      startNewRun: true,
    });
    await updateRepositoryStatus(
      'acme/api',
      'completed',
      'main',
      statusOptions('reopened-run')
    );
    await database('repositories')
      .where({ full_name: 'acme/api', branch: 'main' })
      .update({ indexing_status: 'indexing' });

    const replacement = await updateRepositoryStatus('acme/api', 'indexing', 'main', {
      ...statusOptions('reopened-run'),
      startNewRun: true,
    });

    assert.equal(replacement.applied, false);
    assert.deepEqual(
      await database('repositories').first('indexing_status', 'indexing_run_id'),
      { indexing_status: 'completed', indexing_run_id: 'reopened-run' }
    );
  });
});
