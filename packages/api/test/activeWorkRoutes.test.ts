import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { Request, Response as ExpressResponse } from 'express';
import knex, { type Knex } from 'knex';
import type { CommentJobData, IssueJobData } from '@propr/core';
import type { InstanceAuthorization } from '../authorization.js';
import { createActiveWorkRoutes, ACTIVE_WORK_DEFINITION } from '../routes/activeWorkRoutes.js';

let database: Knex;

before(async () => {
  database = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  await database.schema.createTable('task_drafts', table => {
    table.text('draft_id').primary();
    table.text('user_id').notNullable();
    table.text('status').notNullable();
  });
  await database.schema.createTable('repo_todos', table => {
    table.text('todo_id').primary();
    table.text('user_id').notNullable();
    table.boolean('is_completed').notNullable();
    table.text('linked_draft_id').nullable();
  });
  await database.schema.createTable('goals', table => {
    table.text('goal_id').primary();
    table.text('owner_id').notNullable();
    table.text('desired_state').notNullable();
    table.text('result_state').nullable();
    table.text('current_task_id').notNullable();
    table.integer('run_generation').notNullable();
    table.text('run_claim').nullable();
  });
});

after(async () => database.destroy());

const instanceAuthorization: InstanceAuthorization = {
  role: 'member',
  permissions: [],
  source: 'managed',
};

const authorizedRequest = (userId: string, schemaVersion?: string): Request => ({
  user: { id: userId },
  authorization: instanceAuthorization,
  query: schemaVersion ? { schemaVersion } : {},
} as Request);

const responseRecorder = (): {
  response: ExpressResponse;
  status: () => number;
  body: () => Record<string, unknown>;
} => {
  let statusCode = 200;
  let body: Record<string, unknown> = {};
  const response = {
    status(code: number) { statusCode = code; return response; },
    json(value: Record<string, unknown>) { body = value; return response; },
  } as unknown as ExpressResponse;
  return { response, status: () => statusCode, body: () => body };
};

test('idle goal backlog is reported as open and cannot inflate active work', async () => {
  await database('task_drafts').del();
  await database('repo_todos').del();
  await database('goals').del();
  await database('task_drafts').insert([
    { draft_id: 'generating-a', user_id: 'user-a', status: 'generating' },
    { draft_id: 'refining-a', user_id: 'user-a', status: 'refining' },
    { draft_id: 'review-a', user_id: 'user-a', status: 'review' },
    { draft_id: 'generating-b', user_id: 'user-b', status: 'generating' },
  ]);
  await database('repo_todos').insert([
    { todo_id: 'standalone-a', user_id: 'user-a', is_completed: false, linked_draft_id: null },
    { todo_id: 'standalone-a-2', user_id: 'user-a', is_completed: false, linked_draft_id: null },
    { todo_id: 'linked-a', user_id: 'user-a', is_completed: false, linked_draft_id: 'generating-a' },
    { todo_id: 'completed-a', user_id: 'user-a', is_completed: true, linked_draft_id: null },
    { todo_id: 'standalone-b', user_id: 'user-b', is_completed: false, linked_draft_id: null },
  ]);
  const requestedStates: string[][] = [];
  const routes = createActiveWorkRoutes({
    db: database,
    taskQueue: {
      getJobs: async (states: string[]) => {
        requestedStates.push(states);
        return [
          { id: 'task-1', data: { repoOwner: 'integry', repoName: 'propr', number: 2191 } },
          { id: 'task-2', data: { repoOwner: 'integry', repoName: 'propr', number: 2192 } },
          { id: 'task-1', data: { repoOwner: 'integry', repoName: 'propr', number: 2191 } },
          { id: undefined, data: { repoOwner: 'integry', repoName: 'propr', number: 2193 } },
        ] as never;
      },
    } as never,
  });
  const recorded = responseRecorder();

  await routes.getActiveWork(authorizedRequest('user-a'), recorded.response);

  assert.equal(recorded.status(), 200);
  assert.deepEqual(requestedStates, [['active']]);
  assert.deepEqual(recorded.body(), {
    schemaVersion: 2,
    label: 'Active work',
    definition: 'Running tasks + generating or refining plans; open goals are reported separately',
    availability: {
      tasks: 'available',
      plans: 'available',
      goals: 'unsupported',
      openGoals: 'available',
    },
    counts: { tasks: 2, plans: 2, goals: null, openGoals: 2, total: 4 },
  });
});

test('v3 counts current executing owned goals separately from ordinary tasks and plans', async () => {
  await database('task_drafts').del();
  await database('repo_todos').del();
  await database('goals').del();
  await database('task_drafts').insert([
    { draft_id: 'generating-a', user_id: 'user-a', status: 'generating' },
    { draft_id: 'generating-b', user_id: 'user-b', status: 'generating' },
  ]);
  await database('goals').insert([
    { goal_id: 'executing', owner_id: 'user-a', desired_state: 'running', result_state: null, current_task_id: 'goal-task-1', run_generation: 2, run_claim: 'claim-2' },
    { goal_id: 'paused', owner_id: 'user-a', desired_state: 'paused', result_state: null, current_task_id: 'goal-task-2', run_generation: 0, run_claim: 'claim-paused' },
    { goal_id: 'queued', owner_id: 'user-a', desired_state: 'running', result_state: null, current_task_id: 'goal-task-3', run_generation: 0, run_claim: 'claim-queued' },
    { goal_id: 'completed', owner_id: 'user-a', desired_state: 'running', result_state: 'completed', current_task_id: 'goal-task-4', run_generation: 0, run_claim: 'claim-completed' },
    { goal_id: 'other-owner', owner_id: 'user-b', desired_state: 'running', result_state: null, current_task_id: 'goal-task-5', run_generation: 0, run_claim: 'claim-other' },
    { goal_id: 'other-owner-2', owner_id: 'user-b', desired_state: 'running', result_state: null, current_task_id: 'goal-task-7', run_generation: 1, run_claim: 'claim-other-2' },
    { goal_id: 'stale-attempt', owner_id: 'user-a', desired_state: 'running', result_state: null, current_task_id: 'goal-task-6', run_generation: 3, run_claim: 'claim-current' },
  ]);
  const requestedStates: string[][] = [];
  const activeJobs = [
    { id: 'ordinary-task', name: 'processGitHubIssue', data: { number: 2358 } },
    { id: 'goal-executing', name: 'processGoal', data: { goalId: 'executing', taskId: 'goal-task-1', generation: 2, claimId: 'claim-2' } },
    { id: 'goal-executing-duplicate', name: 'processGoal', data: { goalId: 'executing', taskId: 'goal-task-1', generation: 2, claimId: 'claim-2' } },
    { id: 'goal-paused', name: 'processGoal', data: { goalId: 'paused', taskId: 'goal-task-2', generation: 0, claimId: 'claim-paused' } },
    { id: 'goal-completed', name: 'processGoal', data: { goalId: 'completed', taskId: 'goal-task-4', generation: 0, claimId: 'claim-completed' } },
    { id: 'goal-other-owner', name: 'processGoal', data: { goalId: 'other-owner', taskId: 'goal-task-5', generation: 0, claimId: 'claim-other' } },
    { id: 'goal-other-owner-2', name: 'processGoal', data: { goalId: 'other-owner-2', taskId: 'goal-task-7', generation: 1, claimId: 'claim-other-2' } },
    { id: 'goal-stale-attempt', name: 'processGoal', data: { goalId: 'stale-attempt', taskId: 'goal-task-6', generation: 2, claimId: 'claim-old' } },
  ];
  const routes = createActiveWorkRoutes({
    db: database,
    taskQueue: { getJobs: async (states: string[]) => { requestedStates.push(states); return activeJobs; } } as never,
  });

  const current = responseRecorder();
  await routes.getActiveWork(authorizedRequest('user-a', '3'), current.response);

  assert.equal(current.status(), 200);
  assert.deepEqual(requestedStates, [['active']]);
  assert.deepEqual(current.body(), {
    schemaVersion: 3,
    label: 'Active work',
    definition: ACTIVE_WORK_DEFINITION,
    availability: { tasks: 'available', plans: 'available', goals: 'available', openGoals: 'available' },
    counts: { tasks: 1, plans: 1, goals: 1, openGoals: 0, total: 3 },
  });

  const legacy = responseRecorder();
  await routes.getActiveWork(authorizedRequest('user-a'), legacy.response);
  assert.deepEqual(legacy.body(), {
    schemaVersion: 2,
    label: 'Active work',
    definition: 'Running tasks + generating or refining plans; open goals are reported separately',
    availability: { tasks: 'available', plans: 'available', goals: 'unsupported', openGoals: 'available' },
    counts: { tasks: 2, plans: 1, goals: null, openGoals: 0, total: 3 },
  });

  const otherOwner = responseRecorder();
  await routes.getActiveWork(authorizedRequest('user-b', '3'), otherOwner.response);
  assert.deepEqual((otherOwner.body().counts as Record<string, unknown>), {
    tasks: 1, plans: 1, goals: 2, openGoals: 0, total: 4,
  });
});

test('authorized instance account sees canonical active jobs and unresolved accounts stay isolated', async () => {
  await database('task_drafts').del();
  await database('repo_todos').del();
  await database('goals').del();
  const issueJobData: IssueJobData = {
    repoOwner: 'integry',
    repoName: 'propr',
    number: 2191,
    agentAlias: 'codex',
    modelName: 'gpt-5.6-sol',
    correlationId: 'issue-correlation',
  };
  const commentJobData: CommentJobData = {
    pullRequestNumber: 2196,
    comments: [{ id: 501, body: 'Please apply the follow-up', author: 'integry', type: 'issue' }],
    repoOwner: 'integry',
    repoName: 'propr',
    branchName: '2191/system-tray',
    llm: 'gpt-5.6-sol',
    correlationId: 'comment-correlation',
  };
  assert.equal('userId' in issueJobData, false);
  assert.equal('userId' in commentJobData, false);
  const jobs = [
    { id: 'issue-integry-propr-2191-codex-gpt-5.6-sol', data: issueJobData },
    { id: 'pr-comments-batch-integry-propr-2196-501', data: commentJobData },
    { id: 'issue-integry-propr-2191-codex-gpt-5.6-sol', data: issueJobData },
  ];
  let queueReads = 0;
  const routes = createActiveWorkRoutes({
    db: database,
    taskQueue: { getJobs: async () => { queueReads += 1; return jobs; } } as never,
  });

  const authorized = responseRecorder();
  await routes.getActiveWork(authorizedRequest('authorized-user'), authorized.response);

  assert.equal(authorized.status(), 200);
  assert.equal(queueReads, 1);
  assert.deepEqual((authorized.body().counts as Record<string, unknown>).tasks, 2);

  const unresolvedAccount = responseRecorder();
  await routes.getActiveWork(
    { user: { id: 'account-without-resolved-instance-access' } } as Request,
    unresolvedAccount.response,
  );

  assert.equal(unresolvedAccount.status(), 403);
  assert.deepEqual(unresolvedAccount.body(), { error: 'Instance access required' });
  assert.equal(queueReads, 1);
});

test('active work does not present unavailable data as a verified zero', async () => {
  const routes = createActiveWorkRoutes({
    db: database,
    taskQueue: { getJobs: async () => { throw new Error('queue offline'); } } as never,
  });
  const recorded = responseRecorder();
  const previousError = console.error;
  console.error = () => undefined;
  try {
    await routes.getActiveWork(authorizedRequest('user-a'), recorded.response);
  } finally {
    console.error = previousError;
  }
  assert.equal(recorded.status(), 500);
  assert.deepEqual(recorded.body(), { error: 'Failed to fetch active work' });
});

test('active work rejects a missing authenticated account', async () => {
  const routes = createActiveWorkRoutes({ db: database, taskQueue: { getJobs: async () => [] } as never });
  const recorded = responseRecorder();
  await routes.getActiveWork({} as Request, recorded.response);
  assert.equal(recorded.status(), 401);
});
