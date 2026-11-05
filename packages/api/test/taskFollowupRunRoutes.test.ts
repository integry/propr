import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import type { Request, Response } from 'express';
import knex from 'knex';
import { createTaskFollowupRunRoutes } from '../routes/taskFollowupRunRoutes.js';

const database = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
after(() => database.destroy());

await database.schema.createTable('tasks', table => {
  table.text('task_id').primary();
  table.text('repository').notNullable();
  table.integer('issue_number').nullable();
  table.integer('pr_number').nullable();
  table.text('replay_job_data').nullable();
});
await database.schema.createTable('task_history', table => {
  table.increments('history_id');
  table.text('task_id').notNullable();
  table.text('state').notNullable();
});

const retry = (commentId: number, requesterId: string) => JSON.stringify({ triggeringLabel: 'AI', retryCommentId: commentId, retryRequesterId: requesterId });
await database('tasks').insert([
  { task_id: 'failed-issue-run', repository: 'acme/widgets', issue_number: 32, replay_job_data: JSON.stringify({ triggeringLabel: 'AI' }) },
  // Not yet started: the worker records the retry's job data when the run begins.
  { task_id: 'queued-row', repository: 'acme/widgets', issue_number: 32, replay_job_data: null },
  { task_id: 'another-users-retry', repository: 'acme/widgets', issue_number: 32, replay_job_data: retry(501, 'user-2') },
  { task_id: 'other-issue-same-comment', repository: 'acme/widgets', issue_number: 33, replay_job_data: retry(500, 'user-1') },
  { task_id: 'other-repository-same-comment', repository: 'acme/gadgets', issue_number: 32, replay_job_data: retry(500, 'user-1') },
  { task_id: 'earlier-request', repository: 'acme/widgets', issue_number: 32, replay_job_data: retry(499, 'user-1') },
  { task_id: 'pr-only-task', repository: 'acme/widgets', issue_number: null, pr_number: 7, replay_job_data: null },
]);
await database('task_history').insert([
  { task_id: 'failed-issue-run', state: 'processing' },
  { task_id: 'failed-issue-run', state: 'failed' },
]);

async function read(taskId: string, query: Record<string, unknown>, userId: string | null = 'user-1') {
  let status = 200;
  let json: Record<string, unknown> = {};
  const res = {
    status(code: number) { status = code; return res; },
    json(value: Record<string, unknown>) { json = value; return res; },
  } as unknown as Response;
  const req = { params: { taskId }, query, user: userId ? { id: userId } : undefined } as unknown as Request;
  await createTaskFollowupRunRoutes({ db: database }).getFollowupRuns(req, res);
  return { status, json };
}

test('a follow-up whose run has not started yet reports no run, rather than another run of the issue', async () => {
  assert.deepEqual(await read('failed-issue-run', { commentId: '500' }), {
    status: 200, json: { sourceTaskId: 'failed-issue-run', commentId: 500, runs: [] },
  });
});

test('once the run starts, it is the run the request carried, for its requester only, and the failed run is unchanged', async () => {
  await database('tasks').insert({ task_id: 'fresh-run', repository: 'acme/widgets', issue_number: 32, replay_job_data: retry(500, 'user-1') });
  await database('task_history').insert({ task_id: 'fresh-run', state: 'processing' });
  assert.deepEqual((await read('failed-issue-run', { commentId: '500' })).json.runs, [{ taskId: 'fresh-run', status: 'processing' }]);

  await database('task_history').insert({ task_id: 'fresh-run', state: 'completed' });
  assert.deepEqual((await read('failed-issue-run', { commentId: '500' })).json.runs, [{ taskId: 'fresh-run', status: 'completed' }]);
  const original = await database('task_history').where({ task_id: 'failed-issue-run' }).orderBy('history_id', 'desc').first('state');
  assert.equal(original.state, 'failed');

  // Another user reading the same comment's runs finds nothing of the requester's.
  assert.deepEqual((await read('failed-issue-run', { commentId: '500' }, 'user-2')).json.runs, []);
  // And the requester never adopts another user's retry of the same issue.
  assert.deepEqual((await read('failed-issue-run', { commentId: '501' })).json.runs, []);
});

test('a run that has started but recorded no state yet reads as queued', async () => {
  await database('tasks').insert({ task_id: 'just-admitted', repository: 'acme/widgets', issue_number: 32, replay_job_data: retry(502, 'user-1') });
  assert.deepEqual((await read('failed-issue-run', { commentId: '502' })).json.runs, [{ taskId: 'just-admitted', status: 'queued' }]);
});

test('a task without an issue has no issue retry to report', async () => {
  assert.deepEqual((await read('pr-only-task', { commentId: '500' })).json.runs, []);
});

test('refuses unauthenticated reads, unknown tasks and malformed comment IDs', async () => {
  assert.equal((await read('failed-issue-run', { commentId: '500' }, null)).status, 401);
  assert.equal((await read('missing-task', { commentId: '500' })).status, 404);
  for (const commentId of [undefined, '', '0', '-1', '12abc', '1.5', ['500', '501'], '99999999999999999']) {
    assert.equal((await read('failed-issue-run', { commentId })).status, 400, String(commentId));
  }
});
