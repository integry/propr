import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, describe, test } from 'node:test';
import type { Request, Response } from 'express';
import type { RedisClientType } from 'redis';

const originalNodeEnv = process.env.NODE_ENV;
const originalDbFilename = process.env.DB_FILENAME;
const originalDataDir = process.env.DATA_DIR;
const isolatedDir = await mkdtemp(path.join(tmpdir(), 'propr-creator-projection-'));
process.env.NODE_ENV = 'test';
process.env.DATA_DIR = isolatedDir;
process.env.DB_FILENAME = path.join(isolatedDir, 'propr.sqlite');

const { db, runMigrations, closeConnection } = await import('@propr/core');
const { attachCreator, projectCreator, projectCreators, rememberCreator } = await import('../services/creatorProjection.js');
const { goalCreator, loadGoalCreators, serializeGoal } = await import('../services/goalProjection.js');
type GoalProjectionRow = import('../services/goalProjection.js').GoalProjectionRow;
const { createPlannerRoutes } = await import('../routes/plannerRoutes.js');
const { createAgentDefinitionRoutes } = await import('../routes/agentDefinitionRoutes.js');
const { createRepoTodoRoutes } = await import('../routes/repoTodoRoutes.js');
const { withLiveOutputReads } = await import('./liveOutputRedisFake.js');

after(async () => {
  await closeConnection();
  await rm(isolatedDir, { recursive: true, force: true });
  for (const [key, value] of [['NODE_ENV', originalNodeEnv], ['DB_FILENAME', originalDbFilename], ['DATA_DIR', originalDataDir]] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const KNOWN = { id: '101', login: 'octocat', displayName: 'The Octocat', avatarUrl: 'https://avatars.example/u/101' };
const UNKNOWN_ID = '202';

/** Counts reads of the profile cache, the only table a creator projection may touch. */
function countProfileQueries(): { count: () => number; stop: () => void } {
  let count = 0;
  const listener = (query: { sql: string }) => { if (query.sql.includes('github_user_profiles')) count += 1; };
  db.on('query', listener);
  return { count: () => count, stop: () => { db.removeListener('query', listener); } };
}

function request(user: Record<string, unknown> | null, options: { params?: Record<string, string>; query?: Record<string, string>; body?: unknown } = {}): Request {
  return {
    user: user ?? undefined,
    authenticationMethod: 'session',
    params: options.params ?? {},
    query: options.query ?? {},
    body: options.body ?? {},
    get: () => undefined,
  } as unknown as Request;
}

async function call(handler: (req: Request, res: Response, next: () => void) => unknown, req: Request) {
  const state: { status: number; body?: unknown } = { status: 200 };
  const res = {
    headersSent: false,
    status(code: number) { state.status = code; return this; },
    json(body: unknown) { state.body = body; return this; },
    end() { return this; },
  } as unknown as Response;
  await handler(req, res, () => undefined);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- assertions read arbitrary JSON bodies
  return state as { status: number; body: any };
}

const knownUser = { id: KNOWN.id, login: KNOWN.login, username: KNOWN.login, displayName: KNOWN.displayName, avatarUrl: KNOWN.avatarUrl, accessToken: 'token' };
const unknownUser = { id: UNKNOWN_ID, login: 'ghost', username: 'ghost', accessToken: 'token' };

function goalRow(goalId: string, ownerId: string, ownerLogin: string): GoalProjectionRow {
  return {
    goal_id: goalId, owner_id: ownerId, owner_login: ownerLogin, repository: 'acme/repo', title: 'Goal', objective: 'Ship it',
    launch_strategy: 'pull_request', initial_prompt: 'Ship it', attachments: null, base_branch: 'main', branch_name: null,
    worktree_path: null, agent_id: 'claude', agent_alias: 'claude', agent_type: 'claude', requested_model: 'model',
    effective_model: null, max_parallel_tasks: null, ultrafix: null, desired_state: 'running', result_state: null,
    current_task_id: `task-${goalId}`, session_id: null, conversation_id: null, run_generation: 0, run_claim: null,
    claimed_at: null, active_turn_id: null, pause_confirmed_at: null, resume_requested: 0, final_pr_number: null,
    final_pr_url: null, artifact_refs: null, artifact_stats: null, artifacts_checked_at: null, failure_reason: null,
    create_idempotency_key: null, create_idempotency_operation: null, create_payload_hash: null, control_generation: 0,
    control_ack_generation: 0, task_reconciled_at: null, created_at: '2026-10-09T00:00:00.000Z',
    updated_at: '2026-10-09T00:00:00.000Z', started_at: null, paused_at: null, paused_ms: 0, completed_at: null,
    checkpoint_interval_minutes: null, last_checkpoint_at: null, last_checkpoint_commit_sha: null, checkpoint_count: 0,
    checkpoint_error: null,
  } as GoalProjectionRow;
}

describe('creator projection', () => {
  before(async () => {
    await runMigrations();
  });

  beforeEach(async () => {
    await db('github_user_profiles').del();
    await db('task_drafts').del();
    await db('repo_todos').del();
    await db('repo_todo_categories').del();
    await db('agent_definitions').del();
    await rememberCreator(knownUser);
  });

  test('projectCreators reads a whole page of ids with one profile query', async () => {
    const ids = Array.from({ length: 50 }, (_, index) => String(index % 2 === 0 ? KNOWN.id : 1000 + index));
    const counter = countProfileQueries();
    try {
      const profiles = await projectCreators(ids);
      assert.equal(counter.count(), 1);
      assert.deepEqual(profiles.get(KNOWN.id), KNOWN);
      assert.equal(profiles.size, 1);
    } finally {
      counter.stop();
    }
  });

  test('attachCreator attaches known creators and null for unknown or missing ids', async () => {
    const rows = await attachCreator([{ owner: KNOWN.id }, { owner: UNKNOWN_ID }, { owner: null }], 'owner');
    assert.deepEqual(rows.map(row => row.createdBy), [KNOWN, null, null]);
    const renamed = await attachCreator([{ user_id: KNOWN.id }], 'user_id', 'created_by');
    assert.deepEqual(renamed[0].created_by, KNOWN);
    assert.equal(await projectCreator(UNKNOWN_ID), null);
  });

  test('rememberCreator ignores a login standing in for the display name', async () => {
    await rememberCreator({ id: '303', login: 'hubot', displayName: 'hubot', avatarUrl: null });
    assert.deepEqual(await projectCreator('303'), { id: '303', login: 'hubot', displayName: null, avatarUrl: null });
    await rememberCreator({ id: '404' });
    assert.equal(await projectCreator('404'), null);
  });

  describe('goals', () => {
    const emptyRedis = withLiveOutputReads({ get: async () => null }) as unknown as RedisClientType;

    test('a cached creator projects in full beside the unchanged owner field', async () => {
      const projected = await serializeGoal(db, emptyRedis, goalRow('goal-known', KNOWN.id, KNOWN.login));
      assert.equal(projected.owner, KNOWN.login);
      assert.deepEqual(projected.createdBy, KNOWN);
    });

    test('an uncached creator falls back to the stored login with no avatar', async () => {
      const projected = await serializeGoal(db, emptyRedis, goalRow('goal-unknown', UNKNOWN_ID, 'ghost'));
      assert.equal(projected.owner, 'ghost');
      assert.deepEqual(projected.createdBy, { id: UNKNOWN_ID, login: 'ghost', displayName: null, avatarUrl: null });
      assert.equal(goalCreator({ owner_id: UNKNOWN_ID, owner_login: '' }, new Map()), null);
    });

    test('a list page resolves every creator with one profile query', async () => {
      const rows = Array.from({ length: 50 }, (_, index) => goalRow(`goal-${index}`, index % 2 ? KNOWN.id : UNKNOWN_ID, index % 2 ? KNOWN.login : 'ghost'));
      const counter = countProfileQueries();
      try {
        const creators = await loadGoalCreators(rows);
        const goals = await Promise.all(rows.map(row => serializeGoal(db, emptyRedis, row, { includeInputs: false, creators })));
        assert.equal(counter.count(), 1);
        assert.deepEqual(goals[1].createdBy, KNOWN);
        assert.equal(goals[0].createdBy?.login, 'ghost');
      } finally {
        counter.stop();
      }
    });
  });

  describe('plans', () => {
    test('listDrafts and getDraft carry created_by, null when the creator is unknown', async () => {
      const routes = createPlannerRoutes({ db });
      const knownDraft = randomUUID();
      const unknownDraft = randomUUID();
      await db('task_drafts').insert([
        { draft_id: knownDraft, user_id: KNOWN.id, repository: 'acme/repo', initial_prompt: 'one', name: 'One' },
        { draft_id: unknownDraft, user_id: UNKNOWN_ID, repository: 'acme/repo', initial_prompt: 'two', name: 'Two' },
      ]);

      const listed = await call(routes.listDrafts, request(knownUser, { query: { page: '1', limit: '50' } }));
      assert.equal(listed.status, 200);
      assert.deepEqual(listed.body.drafts.map((draft: { draft_id: string }) => draft.draft_id), [knownDraft]);
      assert.deepEqual(listed.body.drafts[0].created_by, KNOWN);
      assert.equal('user_id' in listed.body.drafts[0], false);

      const detail = await call(routes.getDraft, request(knownUser, { params: { id: knownDraft } }));
      assert.deepEqual(detail.body.created_by, KNOWN);
      const unknown = await call(routes.getDraft, request(unknownUser, { params: { id: unknownDraft } }));
      assert.equal(unknown.body.created_by, null);
    });

    test('a page of 50 drafts issues one profile query', async () => {
      const routes = createPlannerRoutes({ db });
      await db('task_drafts').insert(Array.from({ length: 50 }, (_, index) => ({
        draft_id: randomUUID(), user_id: KNOWN.id, repository: 'acme/repo', initial_prompt: `p${index}`, name: `Plan ${index}`,
      })));
      const counter = countProfileQueries();
      try {
        const listed = await call(routes.listDrafts, request(knownUser, { query: { page: '1', limit: '50' } }));
        assert.equal(listed.body.drafts.length, 50);
        assert.equal(counter.count(), 1);
        assert.ok(listed.body.drafts.every((draft: { created_by: unknown }) => JSON.stringify(draft.created_by) === JSON.stringify(KNOWN)));
      } finally {
        counter.stop();
      }
    });

    test('creating a plan warms the profile cache for its creator', async () => {
      const routes = createPlannerRoutes({ db });
      const creator = { id: '505', login: 'planner', username: 'planner', avatarUrl: 'https://avatars.example/u/505', accessToken: 'token' };
      const created = await call(routes.createDraft, request(creator, { body: { repository: 'acme/repo', prompt: 'Plan' } }));
      assert.equal(created.status, 201);
      const detail = await call(routes.getDraft, request(creator, { params: { id: created.body.draft_id } }));
      assert.equal(detail.body.created_by.avatarUrl, creator.avatarUrl);
    });
  });

  describe('automations', () => {
    const routes = () => createAgentDefinitionRoutes({ db, services: { validateRuntime: async () => null, now: () => Date.UTC(2026, 9, 9) } });

    test('create, get and list carry createdBy, null when the creator is unknown', async () => {
      const creator = { id: '606', login: 'automator', username: 'automator', avatarUrl: 'https://avatars.example/u/606', accessToken: 'token' };
      const created = await call(routes().create, request(creator, { body: { name: 'Nightly', prompt: 'Check things' } }));
      assert.equal(created.status, 201);
      assert.equal(created.body.definition.createdBy.avatarUrl, creator.avatarUrl);

      const detail = await call(routes().get, request(creator, { params: { id: created.body.definition.id } }));
      assert.equal(detail.body.definition.createdBy.login, 'automator');

      const other = await call(routes().create, request(knownUser, { body: { name: 'Other', prompt: 'Other' } }));
      await db('github_user_profiles').where({ github_user_id: KNOWN.id }).del();
      const listed = await call(routes().list, request(knownUser));
      assert.deepEqual(listed.body.definitions.map((definition: { id: string }) => definition.id), [other.body.definition.id]);
      assert.equal(listed.body.definitions[0].createdBy, null);
    });

    test('a list page resolves every creator with one profile query', async () => {
      for (let index = 0; index < 5; index += 1) {
        await call(routes().create, request(knownUser, { body: { name: `Agent ${index}`, prompt: 'Run' } }));
      }
      const counter = countProfileQueries();
      try {
        const listed = await call(routes().list, request(knownUser));
        assert.equal(listed.body.definitions.length, 5);
        assert.equal(counter.count(), 1);
        assert.deepEqual(listed.body.definitions[0].createdBy, KNOWN);
      } finally {
        counter.stop();
      }
    });
  });

  describe('to-dos', () => {
    test('list, detail, create and categories carry createdBy, scoped to the owner', async () => {
      const routes = createRepoTodoRoutes();
      const creator = { id: '707', login: 'listmaker', username: 'listmaker', avatarUrl: 'https://avatars.example/u/707', accessToken: 'token' };
      const created = await call(routes.createTodo, request(creator, { body: { repository: 'acme/repo', content: 'Do it' } }));
      assert.equal(created.status, 201);
      assert.equal(created.body.createdBy.avatarUrl, creator.avatarUrl);
      await db('repo_todos').insert({
        todo_id: randomUUID(), user_id: UNKNOWN_ID, repository: 'acme/repo', category_id: null, content: 'Not mine',
        order_index: 0, is_completed: false, linked_draft_id: null,
      });

      const listed = await call(routes.getTodos, request(creator, { query: { repository: 'acme/repo' } }));
      assert.deepEqual(listed.body.todos.map((todo: { content: string }) => todo.content), ['Do it']);
      assert.equal(listed.body.todos[0].createdBy.login, 'listmaker');

      const detail = await call(routes.getTodo, request(creator, { params: { todoId: created.body.todoId } }));
      assert.equal(detail.body.createdBy.login, 'listmaker');
      const foreign = await call(routes.getTodo, request(unknownUser, { params: { todoId: created.body.todoId } }));
      assert.equal(foreign.status, 404);

      const unknownTodos = await call(routes.getTodos, request(unknownUser, { query: { repository: 'acme/repo' } }));
      assert.equal(unknownTodos.body.todos[0].createdBy, null);

      await call(routes.createCategory, request(creator, { body: { repository: 'acme/repo', name: 'Later' } }));
      const categories = await call(routes.getCategories, request(creator, { query: { repository: 'acme/repo' } }));
      assert.equal(categories.body.categories[0].createdBy.login, 'listmaker');
    });

    test('updating another owner\'s to-do or category returns 404, never the caller as creator', async () => {
      const routes = createRepoTodoRoutes();
      const owner = { id: '808', login: 'owner', username: 'owner', avatarUrl: 'https://avatars.example/u/808', accessToken: 'token' };
      const todo = await call(routes.createTodo, request(owner, { body: { repository: 'acme/repo', content: 'Mine' } }));
      const category = await call(routes.createCategory, request(owner, { body: { repository: 'acme/repo', name: 'Mine' } }));

      const foreignTodo = await call(routes.updateTodo, request(knownUser, { params: { todoId: todo.body.todoId }, body: { content: 'Taken' } }));
      assert.equal(foreignTodo.status, 404);
      assert.equal(foreignTodo.body.createdBy, undefined);
      const foreignCategory = await call(routes.updateCategory, request(knownUser, { params: { categoryId: category.body.categoryId }, body: { name: 'Taken' } }));
      assert.equal(foreignCategory.status, 404);
      assert.equal(foreignCategory.body.createdBy, undefined);

      const ownTodo = await call(routes.updateTodo, request(owner, { params: { todoId: todo.body.todoId }, body: { content: 'Still mine' } }));
      assert.equal(ownTodo.status, 200);
      assert.equal(ownTodo.body.content, 'Still mine');
      assert.equal(ownTodo.body.createdBy.login, 'owner');
      const ownCategory = await call(routes.updateCategory, request(owner, { params: { categoryId: category.body.categoryId }, body: { name: 'Still mine' } }));
      assert.equal(ownCategory.status, 200);
      assert.equal(ownCategory.body.name, 'Still mine');
      assert.equal(ownCategory.body.createdBy.login, 'owner');
    });

    test('a list of 50 to-dos issues one profile query', async () => {
      await db('repo_todos').insert(Array.from({ length: 50 }, (_, index) => ({
        todo_id: randomUUID(), user_id: KNOWN.id, repository: 'acme/repo', category_id: null, content: `todo ${index}`,
        order_index: index, is_completed: false, linked_draft_id: null,
      })));
      const counter = countProfileQueries();
      try {
        const listed = await call(createRepoTodoRoutes().getTodos, request(knownUser, { query: { repository: 'acme/repo' } }));
        assert.equal(listed.body.todos.length, 50);
        assert.equal(counter.count(), 1);
        assert.deepEqual(listed.body.todos[49].createdBy, KNOWN);
      } finally {
        counter.stop();
      }
    });
  });
});
