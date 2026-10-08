import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import knex from 'knex';
import type { Request, Response } from 'express';
import { closeConnection, completeTodosForIssue } from '@propr/core';
import { up } from '../../core/src/db/migrations/20260922000000_add_task_submissions.js';
import { up as identityMigration } from '../../core/src/db/migrations/20260922010000_preserve_task_submission_identity.js';
import { up as repoTodosMigration } from '../../core/src/db/migrations/20260317000000_create_repo_todos.js';
import { up as todoIssueLinkMigration } from '../../core/src/db/migrations/20261013000000_add_todo_issue_link.js';
import { up as submissionTodosLinkedMigration } from '../../core/src/db/migrations/20261013010000_add_task_submission_todos_linked.js';
import { createTaskSubmissionRoutes } from '../routes/taskSubmissionRoutes.js';
import { configureDemoMode } from '../demoMode.js';

after(closeConnection);
function request(body: unknown, key = 'stable-key', user: unknown = { id: 'alice', username: 'alice' }): Request {
  return { body, user, files: [], params: { key }, get: () => key } as unknown as Request;
}
function response() {
  const state: { status: number; body: Record<string, unknown> } = { status: 200, body: {} };
  const res = { status(code: number) { state.status = code; return this; }, json(body: Record<string, unknown>) { state.body = body; return this; } } as Response;
  return { res, state };
}
async function fixture() {
  const db = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  await up(db);
  await identityMigration(db);
  await repoTodosMigration(db);
  await todoIssueLinkMigration(db);
  await submissionTodosLinkedMigration(db);
  return db;
}

test('an accepted submission completes and links its to-dos once, and to-do failures never fail it', async () => {
  configureDemoMode(false);
  const db = await fixture();
  const todo = (todo_id: string, user_id = 'alice', repository = 'owner/repo') =>
    ({ todo_id, user_id, repository, content: todo_id, order_index: 0, is_completed: false, linked_draft_id: null });
  await db('repo_todos').insert([todo('todo-1'), todo('todo-bob', 'bob'), todo('todo-elsewhere', 'alice', 'owner/other')]);
  let failQueue = true;
  let failTodos = false;
  let completions = 0;
  let issues = 6;
  const routes = createTaskSubmissionRoutes({ db, services: {
    authorize: async () => ({ id: 'repo', name: 'owner/repo', enabled: true }),
    routing: async () => ({ agentAlias: 'agent', model: 'model', routingLabel: 'llm-agent-model' }),
    processingLabels: async () => ['AI'],
    enqueue: async () => { if (failQueue) throw new Error('Queue unavailable'); },
    getOctokit: async () => ({ request: async (route: string) => {
      if (route === 'POST /repos/{owner}/{repo}/issues') { issues++; return { data: { number: issues, html_url: `https://github.com/owner/repo/issues/${issues}` } }; }
      return { data: [] };
    } }) as never,
    completeTodos: async (params, database) => {
      completions++;
      if (failTodos) throw new Error('repo_todos is read-only');
      return completeTodosForIssue(params, database);
    },
  } });
  try {
    const body = { repository: 'Owner/Repo', instruction: 'Fix it', todoIds: ['todo-1', 'todo-bob', 'todo-elsewhere'] };
    const first = response();
    await routes.submit(request(body), first.res);
    assert.equal(first.state.status, 202);
    assert.equal(first.state.body.issueNumber, 7);
    const linked = await db('repo_todos').where({ todo_id: 'todo-1' }).first();
    assert.equal(Boolean(linked.is_completed), true);
    assert.equal(linked.linked_issue_repository, 'owner/repo');
    assert.equal(linked.linked_issue_number, 7);
    for (const id of ['todo-bob', 'todo-elsewhere']) {
      const untouched = await db('repo_todos').where({ todo_id: id }).first();
      assert.equal(Boolean(untouched.is_completed), false);
      assert.equal(untouched.linked_issue_number, null);
    }
    failQueue = false;
    const retry = response();
    await routes.retry(request({}), retry.res);
    assert.equal(retry.state.body.state, 'queued');
    const duplicate = response();
    await routes.submit(request(body), duplicate.res);
    assert.equal(duplicate.state.status, 200);
    assert.equal((await db('repo_todos').where({ linked_issue_number: 7 })).length, 1);

    failTodos = true;
    const unwritable = response();
    await routes.submit(request({ ...body, instruction: 'Fix it again' }, 'second-key'), unwritable.res);
    assert.equal(unwritable.state.status, 200);
    assert.equal(unwritable.state.body.state, 'queued');
    assert.equal(unwritable.state.body.issueNumber, 8);
    assert.equal(completions, 2);
    assert.equal((await db('repo_todos').where({ todo_id: 'todo-1' }).first()).linked_issue_number, 7);

    failTodos = false;
    const recovered = response();
    await routes.retry(request({}, 'second-key'), recovered.res);
    assert.equal(recovered.state.body.state, 'queued');
    assert.equal(completions, 3);
    assert.equal((await db('repo_todos').where({ todo_id: 'todo-1' }).first()).linked_issue_number, 8);
  } finally { await db.destroy(); }
});

test('replaying an older submission leaves a reopened or relaunched to-do alone', async () => {
  configureDemoMode(false);
  const db = await fixture();
  await db('repo_todos').insert({ todo_id: 'todo-1', user_id: 'alice', repository: 'owner/repo', content: 'todo-1', order_index: 0, is_completed: false, linked_draft_id: null });
  let issues = 41;
  const routes = createTaskSubmissionRoutes({ db, services: {
    authorize: async () => ({ id: 'repo', name: 'owner/repo', enabled: true }),
    routing: async () => ({ agentAlias: 'agent', model: 'model', routingLabel: 'llm-agent-model' }),
    processingLabels: async () => ['AI'],
    enqueue: async () => {},
    getOctokit: async () => ({ request: async (route: string) => {
      if (route === 'POST /repos/{owner}/{repo}/issues') { issues++; return { data: { number: issues, html_url: `https://github.com/owner/repo/issues/${issues}` } }; }
      return { data: [] };
    } }) as never,
  } });
  const todo = () => db('repo_todos').where({ todo_id: 'todo-1' }).first();
  const replayA = async () => {
    const duplicate = response();
    await routes.submit(request(launchA, 'launch-a'), duplicate.res);
    assert.equal(duplicate.state.body.issueNumber, 42);
    const retried = response();
    await routes.retry(request({}, 'launch-a'), retried.res);
    assert.equal(retried.state.body.issueNumber, 42);
  };
  const launchA = { repository: 'owner/repo', instruction: 'Fix it', todoIds: ['todo-1'] };
  try {
    const first = response();
    await routes.submit(request(launchA, 'launch-a'), first.res);
    assert.equal(first.state.body.issueNumber, 42);
    assert.equal((await todo()).linked_issue_number, 42);

    await db('repo_todos').where({ todo_id: 'todo-1' }).update({ is_completed: false });
    await replayA();
    assert.equal(Boolean((await todo()).is_completed), false);

    const launchB = response();
    await routes.submit(request({ ...launchA, instruction: 'Fix it properly' }, 'launch-b'), launchB.res);
    assert.equal(launchB.state.body.issueNumber, 43);
    await replayA();
    const relaunched = await todo();
    assert.equal(Boolean(relaunched.is_completed), true);
    assert.equal(relaunched.linked_issue_number, 43);
  } finally { await db.destroy(); }
});
