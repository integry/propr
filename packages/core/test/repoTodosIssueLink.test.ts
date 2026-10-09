import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import knex, { type Knex } from 'knex';
import { closeConnection } from '../src/db/connection.js';
import { up as createRepoTodos } from '../src/db/migrations/20260317000000_create_repo_todos.js';
import { down as removeIssueLink, up as addIssueLink } from '../src/db/migrations/20261013000000_add_todo_issue_link.js';
import { completeTodosForIssue } from '../src/services/repoTodosService.js';

after(closeConnection);

async function fixture(): Promise<Knex> {
  const db = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  await createRepoTodos(db);
  await addIssueLink(db);
  const todo = (todo_id: string, user_id: string, repository: string, linked_draft_id: string | null = null) =>
    ({ todo_id, user_id, repository, content: todo_id, order_index: 0, is_completed: false, linked_draft_id });
  await db('repo_todos').insert([
    todo('mine', 'alice', 'Owner/Repo'),
    todo('planned', 'alice', 'owner/repo', 'draft-1'),
    todo('other-user', 'bob', 'owner/repo'),
    todo('other-repo', 'alice', 'owner/elsewhere'),
  ]);
  return db;
}

const row = (db: Knex, todoId: string) => db('repo_todos').where({ todo_id: todoId }).first();

test('completing to-dos for an issue records the issue only on the submitting user\'s to-dos in that repository', async () => {
  const db = await fixture();
  try {
    const updated = await completeTodosForIssue({ todoIds: ['mine', 'planned', 'other-user', 'other-repo', 'missing'], userId: 'alice',
      repository: 'owner/repo', issueNumber: 42 }, db);
    assert.equal(updated, 2);
    const mine = await row(db, 'mine');
    assert.equal(Boolean(mine.is_completed), true);
    assert.equal(mine.linked_issue_repository, 'owner/repo');
    assert.equal(mine.linked_issue_number, 42);
    assert.equal(mine.linked_task_id, null);
    assert.equal((await row(db, 'planned')).linked_draft_id, 'draft-1');
    for (const untouched of ['other-user', 'other-repo']) {
      const record = await row(db, untouched);
      assert.equal(Boolean(record.is_completed), false);
      assert.equal(record.linked_issue_number, null);
    }
  } finally { await db.destroy(); }
});

test('repeating the completion is idempotent and a relaunch retargets the to-do', async () => {
  const db = await fixture();
  try {
    const params = { todoIds: ['mine'], userId: 'alice', repository: 'owner/repo', issueNumber: 42, taskId: 'task-1' };
    await completeTodosForIssue(params, db);
    const first = await row(db, 'mine');
    await completeTodosForIssue(params, db);
    const second = await row(db, 'mine');
    assert.deepEqual({ ...second, updated_at: null }, { ...first, updated_at: null });
    assert.equal(second.linked_task_id, 'task-1');
    await completeTodosForIssue({ ...params, issueNumber: 43, taskId: null }, db);
    assert.equal((await row(db, 'mine')).linked_issue_number, 43);
    assert.equal(await completeTodosForIssue({ ...params, todoIds: [] }, db), 0);
  } finally { await db.destroy(); }
});

test('an older issue never replaces the link a newer launch recorded', async () => {
  const db = await fixture();
  try {
    const params = { todoIds: ['mine'], userId: 'alice', repository: 'owner/repo' };
    await completeTodosForIssue({ ...params, issueNumber: 43, taskId: 'task-b' }, db);
    await db('repo_todos').where({ todo_id: 'mine' }).update({ is_completed: false });
    assert.equal(await completeTodosForIssue({ ...params, issueNumber: 42, taskId: 'task-a' }, db), 0);
    const kept = await row(db, 'mine');
    assert.equal(Boolean(kept.is_completed), false);
    assert.equal(kept.linked_issue_number, 43);
    assert.equal(kept.linked_task_id, 'task-b');
    assert.equal(await completeTodosForIssue({ ...params, issueNumber: 44 }, db), 1);
    assert.equal((await row(db, 'mine')).linked_issue_number, 44);
  } finally { await db.destroy(); }
});

test('the issue link migration rolls back cleanly', async () => {
  const db = await fixture();
  try {
    await removeIssueLink(db);
    for (const column of ['linked_issue_repository', 'linked_issue_number', 'linked_task_id']) {
      assert.equal(await db.schema.hasColumn('repo_todos', column), false);
    }
    const indexes = await db.raw("select name from sqlite_master where type = 'index' and tbl_name = 'repo_todos'");
    assert.equal(indexes.some((index: { name: string }) => index.name === 'repo_todos_linked_issue_index'), false);
    assert.equal(await db.schema.hasColumn('repo_todos', 'linked_draft_id'), true);
    await addIssueLink(db);
    assert.equal(await db.schema.hasColumn('repo_todos', 'linked_issue_number'), true);
  } finally { await db.destroy(); }
});
