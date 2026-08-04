import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, test } from 'node:test';
import knex from 'knex';
import { up as addIndexingTransitionIdentity }
  from '../src/db/migrations/20260802030000_add_indexing_transition_identity.js';
import { closeConnection } from '../src/db/connection.js';
import { getActiveRepositoryIndexingRuns }
  from '../src/services/relevance/summaryMinerQueries.js';

after(async () => closeConnection());

test('indexing identity migration canonicalizes repositories and backfills active run owners', async () => {
  const database = knex({
    client: 'better-sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true,
  });
  try {
    await database.raw('PRAGMA foreign_keys = ON');
    await database.schema.createTable('repositories', (table) => {
      table.text('full_name').notNullable();
      table.text('branch').notNullable();
      table.text('indexing_status').notNullable();
      table.text('last_indexed_at');
      table.text('last_indexed_hash');
      table.text('last_indexed_commit_message');
      table.text('icon_path');
      table.text('created_at').notNullable();
      table.text('updated_at').notNullable();
      table.primary(['full_name', 'branch']);
    });
    for (const tableName of [
      'task_drafts', 'plan_issues', 'tasks', 'repo_chat_messages',
      'repo_todo_categories', 'repo_todos', 'notification_source_activity'
    ]) {
      await database.schema.createTable(tableName, (table) => {
        table.increments('id').primary();
        table.text('repository').notNullable();
        if (tableName === 'tasks') table.text('initial_job_data');
      });
    }
    await database.schema.createTable('system_configs', (table) => {
      table.text('key').primary();
      table.text('value');
    });
    await database.schema.createTable('llm_logs', (table) => {
      table.increments('id').primary();
      table.text('repository');
      table.text('work_repository');
    });
    await database.schema.createTable('file_summaries', (table) => {
      table.text('path').notNullable();
      table.text('branch').notNullable();
      table.text('summary').notNullable();
      table.text('commit_hash').notNullable();
      table.text('model_used');
      table.text('last_updated_at');
      table.primary(['path', 'branch']);
    });
    await database.schema.createTable('directory_summaries', (table) => {
      table.text('path').notNullable();
      table.text('branch').notNullable();
      table.text('summary').notNullable();
      table.text('hash').notNullable();
      table.text('last_updated_at');
      table.primary(['path', 'branch']);
    });
    await database.schema.createTable('notification_events', (table) => {
      table.increments('id').primary();
      table.text('target_json').notNullable();
    });
    await database.schema.createTable('repository_indexing_transitions', (table) => {
      table.increments('transition_id').primary();
      table.text('full_name').notNullable();
      table.text('branch').notNullable();
      table.foreign(['full_name', 'branch']).references(['full_name', 'branch'])
        .inTable('repositories');
    });
    await database('repositories').insert([
      {
        full_name: 'Acme/API', branch: 'main', indexing_status: 'completed',
        created_at: '2026-08-01T00:00:00.000Z',
        updated_at: '2026-08-01T01:00:00.000Z',
        last_indexed_at: '2026-08-01T00:30:00.000Z',
        last_indexed_hash: 'preserved-hash',
        last_indexed_commit_message: 'Preserve this metadata',
        icon_path: '/icons/acme-api.png',
      },
      {
        full_name: 'acme/api', branch: 'main', indexing_status: 'indexing',
        created_at: '2026-08-02T00:00:00.000Z',
        updated_at: '2026-08-02T01:00:00.000Z',
      },
    ]);
    for (const tableName of [
      'task_drafts', 'plan_issues', 'tasks', 'repo_chat_messages',
      'repo_todo_categories', 'repo_todos', 'notification_source_activity'
    ]) {
      await database(tableName).insert({
        repository: 'ACME/api',
        ...(tableName === 'tasks' ? {
          initial_job_data: JSON.stringify({
            repoOwner: 'ACME', repoName: 'API', repository: 'Acme/API'
          })
        } : {})
      });
    }
    await database('system_configs').insert({
      key: 'user_repo_prefs_user-1',
      value: JSON.stringify({
        'ACME/api': { starred: true },
        'acme/api': { hidden: true },
        'other/repo': { starred: true }
      })
    });
    await database('llm_logs').insert({
      repository: 'Acme/API', work_repository: 'Acme/API'
    });
    await database('file_summaries').insert([
      {
        path: 'Acme/API/src/index.ts', branch: 'main', summary: 'new summary',
        commit_hash: 'new-hash', last_updated_at: '2026-08-02T00:00:00.000Z'
      },
      {
        path: 'acme/api/src/index.ts', branch: 'main', summary: 'old summary',
        commit_hash: 'old-hash', last_updated_at: '2026-08-01T00:00:00.000Z'
      }
    ]);
    await database('directory_summaries').insert({
      path: 'Acme/API', branch: 'main', summary: 'root summary', hash: 'root-hash',
      last_updated_at: '2026-08-02T00:00:00.000Z'
    });
    await database('notification_events').insert({
      target_json: JSON.stringify({ type: 'task', repository: 'Acme/API', taskId: 'task-1' })
    });
    await database('repository_indexing_transitions').insert({
      full_name: 'Acme/API', branch: 'main'
    });

    await addIndexingTransitionIdentity(database);

    const repository = await database('repositories').first(
      'full_name', 'branch', 'indexing_status', 'indexing_transition_at', 'indexing_run_id',
      'last_indexed_at', 'last_indexed_hash', 'last_indexed_commit_message', 'icon_path',
      'created_at'
    );
    const expectedRunId = `legacy-${createHash('sha256')
      .update(['acme/api', 'main', '2026-08-02T01:00:00.000Z'].join('\0'))
      .digest('hex')}`;
    assert.deepEqual(repository, {
      full_name: 'acme/api',
      branch: 'main',
      indexing_status: 'indexing',
      indexing_transition_at: '2026-08-02T01:00:00.000Z',
      indexing_run_id: expectedRunId,
      last_indexed_at: '2026-08-01T00:30:00.000Z',
      last_indexed_hash: 'preserved-hash',
      last_indexed_commit_message: 'Preserve this metadata',
      icon_path: '/icons/acme-api.png',
      created_at: '2026-08-01T00:00:00.000Z',
    });
    assert.deepEqual(await getActiveRepositoryIndexingRuns('ACME/API', 'main', database), [{
      fullName: 'acme/api',
      branch: 'main',
      transitionAt: '2026-08-02T01:00:00.000Z',
      runId: expectedRunId,
    }]);
    for (const tableName of [
      'task_drafts', 'plan_issues', 'tasks', 'repo_chat_messages',
      'repo_todo_categories', 'repo_todos', 'notification_source_activity'
    ]) {
      assert.deepEqual(await database(tableName).pluck('repository'), ['acme/api']);
    }
    assert.deepEqual(await database('llm_logs').first('repository', 'work_repository'), {
      repository: 'acme/api', work_repository: 'acme/api'
    });
    assert.deepEqual(JSON.parse((await database('tasks').first('initial_job_data'))
      .initial_job_data), {
      repoOwner: 'acme', repoName: 'api', repository: 'acme/api'
    });
    assert.deepEqual(JSON.parse((await database('system_configs').first('value')).value), {
      'other/repo': { starred: true },
      'acme/api': { starred: true, hidden: true }
    });
    assert.deepEqual(await database('file_summaries').first(
      'path', 'summary', 'commit_hash'
    ), {
      path: 'acme/api/src/index.ts', summary: 'new summary', commit_hash: 'new-hash'
    });
    assert.deepEqual(await database('directory_summaries').pluck('path'), ['acme/api']);
    assert.equal(JSON.parse((await database('notification_events').first('target_json')).target_json)
      .repository, 'acme/api');
    assert.deepEqual(await database('repository_indexing_transitions').first(
      'full_name', 'branch'
    ), { full_name: 'acme/api', branch: 'main' });
    await assert.rejects(database('repositories').insert({
      full_name: 'ACME/API',
      branch: 'main',
      indexing_status: 'idle',
      created_at: '2026-08-03T00:00:00.000Z',
      updated_at: '2026-08-03T00:00:00.000Z',
    }), /UNIQUE constraint failed/);
  } finally {
    await database.destroy();
  }
});
