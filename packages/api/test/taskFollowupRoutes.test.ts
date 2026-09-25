import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { after, test } from 'node:test';
import type { Request, Response } from 'express';
import knex from 'knex';

const originalNodeEnv = process.env.NODE_ENV;
const originalDbFilename = process.env.DB_FILENAME;
const isolatedDbDir = await mkdtemp(path.join(tmpdir(), 'propr-task-followup-routes-'));
process.env.NODE_ENV = 'test';
process.env.DB_FILENAME = path.join(isolatedDbDir, 'propr.sqlite');

const { closeConnection } = await import('@propr/core');
const { createTaskRoutes, resolveFollowupThread } = await import('../routes/taskRoutes.js');

const database = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
await database.schema.createTable('tasks', table => {
  table.text('task_id').primary();
  table.text('repository').notNullable();
  table.integer('issue_number').nullable();
  table.integer('pr_number').nullable();
  table.text('task_type').notNullable();
});
await database('tasks').insert([
  { task_id: 'task-without-pr', repository: 'integry/propr', issue_number: null, pr_number: null, task_type: 'issue' },
  { task_id: 'issue-task-without-pr', repository: 'integry/propr', issue_number: 12, pr_number: null, task_type: 'issue' },
]);

after(async () => {
  await database.destroy();
  await closeConnection();
  await rm(isolatedDbDir, { recursive: true, force: true });
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalNodeEnv;
  if (originalDbFilename === undefined) delete process.env.DB_FILENAME;
  else process.env.DB_FILENAME = originalDbFilename;
});

async function postFollowup(body: Record<string, unknown>, taskId = 'task-without-pr'): Promise<{ status: number; json: unknown }> {
  const result = { status: 200, json: undefined as unknown };
  const response = {
    status(code: number) { result.status = code; return this; },
    json(payload: unknown) { result.json = payload; return this; },
  } as unknown as Response;
  await createTaskRoutes({ db: database }).postFollowup({
    params: { taskId },
    body,
    user: { id: 'user-1' },
  } as unknown as Request, response);
  return result;
}

test('rejects unknown follow-up targets before posting anything', async () => {
  assert.deepEqual(await postFollowup({ body: '/review', target: 'issue' }), {
    status: 400,
    json: { error: 'Follow-up target must be "pull_request" when provided' },
  });
});

test('requires a pull request when a follow-up command targets one', async () => {
  assert.deepEqual(await postFollowup({ body: '/review', target: 'pull_request' }), {
    status: 400,
    json: { error: 'Task does not have a valid GitHub pull request' },
  });
});

test('does not post a pull request command onto the issue of an issue task without a PR', async () => {
  assert.deepEqual(await postFollowup({ body: '/review', target: 'pull_request' }, 'issue-task-without-pr'), {
    status: 400,
    json: { error: 'Task does not have a valid GitHub pull request' },
  });
});

test('resolves historical PR-comment task IDs whose stored task type is issue', () => {
  const task = {
    task_id: 'pr-comments-batch-integry-propr-2506-5831013617-2026-09-25T10-37-33Z-87ecb969a008',
    repository: 'integry/propr',
    issue_number: 2506,
    pr_number: null,
    task_type: 'issue',
  };

  assert.deepEqual(resolveFollowupThread(task, true), {
    number: 2506,
    error: 'Task does not have a valid GitHub pull request',
  });
});
