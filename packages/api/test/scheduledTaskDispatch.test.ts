import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import knex from 'knex';
import { closeConnection, createSchedule } from '@propr/core';
import { up as submissionsMigration } from '../../core/src/db/migrations/20260922000000_add_task_submissions.js';
import { up as identityMigration } from '../../core/src/db/migrations/20260922010000_preserve_task_submission_identity.js';
import { up as scheduleMigration } from '../../core/src/db/migrations/20261007000000_create_task_schedules.js';
import { dispatchScheduledTask } from '../services/scheduledTaskDispatch.js';
import type { TaskSubmissionServices } from '../services/taskSubmissionCreation.js';

after(closeConnection);

async function fixture() {
  const db = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  await db.schema.createTable('tasks', table => { table.string('task_id').primary(); });
  await submissionsMigration(db);
  await identityMigration(db);
  await scheduleMigration(db);
  return db;
}

test('a scheduled run is submitted like a REST task, on behalf of the owner, with schedule provenance', async () => {
  const db = await fixture();
  const calls: Array<{ route: string; body: Record<string, unknown> }> = [];
  const enqueued: Array<{ userId: string }> = [];
  const services: TaskSubmissionServices = {
    routing: async body => ({ agentAlias: body.agentAlias ?? 'default-agent', model: body.model ?? 'default-model', routingLabel: 'llm-agent-model' }),
    getOctokit: async () => ({ request: async (route: string, body: Record<string, unknown>) => {
      calls.push({ route, body });
      if (route === 'POST /repos/{owner}/{repo}/issues') return { data: { number: 7, html_url: 'https://github.com/acme/repo/issues/7' } };
      return { data: {} };
    } }) as never,
    processingLabels: async () => ['AI'],
    enqueue: async input => { enqueued.push(input); },
  };
  const repositories = async () => [{ name: 'acme/repo', enabled: true, baseBranch: 'main' }] as never;
  try {
    const schedule = await createSchedule(db, {
      name: 'Nightly *patrol*', repository: 'acme/repo', cron: '0 3 * * *', timezone: 'UTC',
      instruction: { text: 'Upgrade outdated dependencies', runUltrafix: true, autoMerge: true },
    }, { userId: '42', username: 'octocat' });
    const key = `schedule:${schedule.id}:2026-10-07T03:00:00.000Z`;
    const result = await dispatchScheduledTask(db, schedule, key, { services, repositories });
    assert.equal(result.state, 'queued');
    const create = calls.find(call => call.route === 'POST /repos/{owner}/{repo}/issues')!;
    assert.equal(create.body.title, 'Upgrade outdated dependencies');
    assert.match(String(create.body.body), /\n---\nScheduled: Nightly \\\*patrol\\\*\nSubmitted by @octocat through ProPR\./);
    assert.deepEqual(calls.filter(call => call.route.endsWith('/labels')).map(call => call.body.labels),
      [['llm-agent-model'], ['base-main'], ['auto-merge'], ['ultrafix'], ['AI']]);
    assert.deepEqual(enqueued.map(entry => entry.userId), ['42']);
    const row = await db('task_submissions').first();
    assert.equal(row.user_id, '42');
    assert.equal(row.submission_key, key);
    assert.equal(row.schedule_id, schedule.id);
    assert.equal(JSON.parse(row.payload).scheduleName, 'Nightly *patrol*');

    // Dispatching the same slot again resumes the same submission: no second issue.
    const again = await dispatchScheduledTask(db, schedule, key, { services, repositories });
    assert.equal(again.submissionId, result.submissionId);
    assert.equal(calls.filter(call => call.route === 'POST /repos/{owner}/{repo}/issues').length, 1);

    await assert.rejects(dispatchScheduledTask(db, schedule, `${key}:other`, { services, repositories: async () => [] }), /no longer an enabled repository/);
  } finally {
    await db.destroy();
  }
});
