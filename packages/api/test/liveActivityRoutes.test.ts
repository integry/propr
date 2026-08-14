import assert from 'node:assert/strict';
import { afterEach, mock, test } from 'node:test';
import type { Request, Response } from 'express';
import knex, { type Knex } from 'knex';

process.env.PROPR_DEMO_MODE = 'true';
await mock.module('@propr/core', {
  namedExports: {
    inspectExactTaskContainerLivenessForTask: async () => 'not_found',
    logger: { warn: mock.fn(), error: mock.fn() },
  },
});
const { createLiveActivityRoutes } = await import('../routes/liveActivityRoutes.js');

const databases: Knex[] = [];

async function database(): Promise<Knex> {
  const db = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  databases.push(db);
  await db.schema.createTable('tasks', table => {
    table.text('task_id').primary();
    table.text('job_id');
    table.text('repository');
    table.text('created_at');
    table.text('initial_job_data');
  });
  await db.schema.createTable('task_history', table => {
    table.increments('history_id').primary();
    table.text('task_id');
    table.text('state');
  });
  await db.schema.createTable('task_drafts', table => {
    table.text('draft_id').primary();
    table.text('user_id');
    table.text('name');
    table.text('initial_prompt');
    table.text('repository');
    table.text('status');
    table.text('created_at');
  });
  return db;
}

afterEach(async () => {
  await Promise.all(databases.splice(0).map(db => db.destroy()));
});

async function invoke(handler: (req: Request, res: Response) => Promise<void>, limit = 50) {
  let body: unknown;
  let status = 200;
  const req = { query: { limit: String(limit) }, user: { id: 'user-1' } } as unknown as Request;
  const res = {
    status(code: number) { status = code; return this; },
    json(value: unknown) { body = value; return this; },
  } as unknown as Response;
  await handler(req, res);
  return { status, body: body as { items: Array<{ id: string; type: string; label: string; repository: string; status: string; createdAt: string }>; total: number; remaining: number } };
}

test('header count and list share the exact live set beyond the historical 20-row window', async () => {
  const db = await database();
  const staleTasks = Array.from({ length: 25 }, (_, index) => ({
    task_id: `stale-${String(index).padStart(2, '0')}`,
    job_id: `stale-job-${index}`,
    repository: 'integry/propr',
    created_at: `2026-08-14T12:${String(index).padStart(2, '0')}:00.000Z`,
    initial_job_data: JSON.stringify({ title: `Stale ${index}` }),
  }));
  await db('tasks').insert([
    ...staleTasks,
    { task_id: 'long-live', job_id: 'long-job', repository: 'integry/propr', created_at: '2026-06-01T00:00:00.000Z', initial_job_data: JSON.stringify({ title: 'Long running', type: 'issue' }) },
    { task_id: 'container-live', job_id: 'finished-job', repository: 'integry/propr', created_at: '2026-08-14T13:00:00.000Z', initial_job_data: '{}' },
  ]);
  await db('task_history').insert([...staleTasks.map(task => ({ task_id: task.task_id, state: 'processing' })),
    { task_id: 'long-live', state: 'processing' }, { task_id: 'container-live', state: 'processing' }]);
  await db('task_drafts').insert({ draft_id: 'plan-live', user_id: 'user-1', name: 'Plan', repository: 'integry/propr', status: 'refining', created_at: '2026-08-14T14:00:00.000Z' });

  const queue = {
    getJobs: async () => [],
    getJob: async (jobId: string) => jobId === 'long-job'
      ? { id: jobId, data: { taskId: 'long-live' }, getState: async () => 'active' }
      : jobId === 'finished-job' ? { getState: async () => 'completed' } : null,
  };
  const routes = createLiveActivityRoutes({
    db,
    taskQueue: queue as never,
    inspectContainer: async taskId => taskId === 'container-live' ? 'running' : 'not_found',
  });
  const result = await invoke(routes.getLiveActivity);

  assert.equal(result.status, 200);
  assert.equal(result.body.total, 3);
  assert.deepEqual(new Set(result.body.items.map(item => item.id)), new Set(['plan-live', 'long-live', 'container-live']));
  assert.equal(result.body.remaining, 0);
});

test('demo queue preserves plan activity and reports the undisplayed live remainder', async () => {
  const db = await database();
  await db('task_drafts').insert([0, 1, 2].map(index => ({
    draft_id: `plan-${index}`, user_id: 'user-1', name: `Plan ${index}`,
    repository: 'integry/propr', status: 'generating', created_at: `2026-08-14T1${index}:00:00.000Z`,
  })));
  const routes = createLiveActivityRoutes({ db, taskQueue: { getJob: async () => null, getJobs: async () => [] } as never });
  const result = await invoke(routes.getLiveActivity, 2);

  assert.equal(result.body.total, 3);
  assert.equal(result.body.items.length, 2);
  assert.equal(result.body.remaining, 1);
});

test('includes first-attempt child jobs in every accepted live queue state', async () => {
  const db = await database();
  const states = ['active', 'waiting', 'delayed', 'prioritized', 'waiting-children', 'paused'] as const;
  const jobs = states.map((state, index) => ({
    id: `child-job-${state}`,
    name: 'processGitHubIssue',
    timestamp: Date.parse(`2026-08-14T12:0${index}:00.000Z`),
    data: {
      isChildJob: true,
      repoOwner: 'integry',
      repoName: 'propr',
      number: 1898 + index,
      agentAlias: 'codex',
      modelName: 'gpt-5',
      correlationId: `correlation-${index}`,
      issuePayload: { title: `Queued issue ${index}` },
    },
    getState: async () => state,
  }));
  jobs.push({
    ...jobs[0],
    id: 'parent-job',
    data: { ...jobs[0].data, isChildJob: false },
  });
  const routes = createLiveActivityRoutes({
    db,
    taskQueue: { getJob: async jobId => jobs.find(job => job.id === jobId) ?? null, getJobs: async () => jobs } as never,
  });
  const result = await invoke(routes.getLiveActivity);

  assert.equal(result.status, 200);
  assert.equal(result.body.total, states.length);
  assert.deepEqual(
    new Set(result.body.items.map(item => item.id)),
    new Set(states.map((_, index) => `integry-propr-${1898 + index}-codex-gpt-5-correlation-${index}`)),
  );
});

test('includes every task-producing worker job kind but omits issue dispatch parents', async () => {
  const db = await database();
  const base = {
    timestamp: Date.parse('2026-08-14T12:00:00.000Z'),
    getState: async () => 'waiting',
  };
  const jobs = [
    {
      ...base,
      id: 'issue-child',
      name: 'processGitHubIssue',
      data: {
        isChildJob: true, repoOwner: 'integry', repoName: 'propr', number: 1898,
        agentAlias: 'codex', modelName: 'gpt-5', correlationId: 'issue-correlation',
      },
    },
    {
      ...base,
      id: 'pr-comment-job',
      name: 'processPullRequestComment',
      data: { repoOwner: 'integry', repoName: 'propr', pullRequestNumber: 1899 },
    },
    {
      ...base,
      id: 'task-import-job',
      name: 'processTaskImport',
      data: { repository: 'integry/propr', taskDescription: 'Import these tasks' },
    },
    {
      ...base,
      id: 'merge-job',
      name: 'processMergeConflict',
      data: { repoOwner: 'integry', repoName: 'propr', pullRequestNumber: 1899 },
    },
    {
      ...base,
      id: 'issue-parent',
      name: 'processGitHubIssue',
      data: { isChildJob: false, repoOwner: 'integry', repoName: 'propr', number: 1898 },
    },
    {
      ...base,
      id: 'system-task',
      name: 'processSystemTask',
      data: { owner: 'integry', repoName: 'propr' },
    },
  ];
  const routes = createLiveActivityRoutes({
    db,
    taskQueue: { getJob: async jobId => jobs.find(job => job.id === jobId) ?? null, getJobs: async () => jobs } as never,
  });
  const result = await invoke(routes.getLiveActivity);

  assert.equal(result.status, 200);
  assert.equal(result.body.total, 4);
  assert.deepEqual(
    new Set(result.body.items.map(item => item.id)),
    new Set([
      'integry-propr-1898-codex-gpt-5-issue-correlation',
      'pr-comment-job',
      'task-import-job',
      'merge-job',
    ]),
  );
});

test('a reused issue job ID neither revives nor hides a historical execution', async () => {
  const db = await database();
  await db('tasks').insert({
    task_id: 'old-execution',
    job_id: 'reused-job',
    repository: 'integry/propr',
    created_at: '2026-08-14T11:00:00.000Z',
    initial_job_data: JSON.stringify({ type: 'issue', title: 'Old execution' }),
  });
  await db('task_history').insert({ task_id: 'old-execution', state: 'processing' });
  const reusedJob = {
    id: 'reused-job',
    name: 'processGitHubIssue',
    timestamp: Date.parse('2026-08-14T12:00:00.000Z'),
    data: {
      isChildJob: true,
      taskId: 'new-execution',
      repoOwner: 'integry',
      repoName: 'propr',
      number: 1899,
      title: 'New execution',
    },
    getState: async () => 'active',
  };
  const routes = createLiveActivityRoutes({
    db,
    taskQueue: {
      getJob: async () => reusedJob,
      getJobs: async () => [reusedJob],
    } as never,
    inspectContainer: async () => 'not_found',
  });
  const result = await invoke(routes.getLiveActivity);

  assert.equal(result.status, 200);
  assert.equal(result.body.total, 1);
  assert.deepEqual(result.body.items.map(item => item.id), ['new-execution']);
});

test('legacy PR-comment task without a persisted job ID is not counted again from the queue', async () => {
  const db = await database();
  const taskId = 'pr-comment-integry-propr-1899-codex';
  await db('tasks').insert({
    task_id: taskId,
    job_id: null,
    repository: 'integry/propr',
    created_at: '2026-08-14T11:00:00.000Z',
    initial_job_data: JSON.stringify({ type: 'pr_comment', title: 'Address review comment' }),
  });
  await db('task_history').insert({ task_id: taskId, state: 'processing' });
  const job = {
    id: taskId,
    name: 'processPullRequestComment',
    timestamp: Date.parse('2026-08-14T12:00:00.000Z'),
    data: {
      repoOwner: 'integry',
      repoName: 'propr',
      pullRequestNumber: 1899,
    },
    getState: async () => 'waiting',
  };
  const routes = createLiveActivityRoutes({
    db,
    taskQueue: {
      getJob: async () => job,
      getJobs: async () => [job],
    } as never,
    inspectContainer: async () => 'not_found',
  });
  const result = await invoke(routes.getLiveActivity);

  assert.equal(result.status, 200);
  assert.equal(result.body.total, 1);
  assert.deepEqual(result.body.items.map(item => item.id), [taskId]);
});

test('deduplicates a task initialized after queue enumeration', async () => {
  const db = await database();
  const taskId = 'integry-propr-1898-codex-gpt-5-racing-correlation';
  const jobData = {
    isChildJob: true,
    repoOwner: 'integry',
    repoName: 'propr',
    number: 1898,
    agentAlias: 'codex',
    modelName: 'gpt-5',
    correlationId: 'racing-correlation',
  };
  let initialized = false;
  const refreshedJob = {
    id: 'issue-job-1898',
    name: 'processGitHubIssue',
    timestamp: Date.parse('2026-08-14T12:00:00.000Z'),
    data: { ...jobData, taskId },
    getState: async () => 'active',
  };
  const enumeratedJob = {
    ...refreshedJob,
    data: jobData,
    getState: async () => {
      if (!initialized) {
        await db('tasks').insert({
          task_id: taskId,
          job_id: 'issue-job-1898',
          repository: 'integry/propr',
          created_at: '2026-08-14T12:00:00.000Z',
          initial_job_data: JSON.stringify({ type: 'issue', title: 'Racing initialization' }),
        });
        await db('task_history').insert({ task_id: taskId, state: 'processing' });
        initialized = true;
      }
      return 'active';
    },
  };
  const routes = createLiveActivityRoutes({
    db,
    taskQueue: {
      getJobs: async () => [enumeratedJob],
      getJob: async () => initialized ? refreshedJob : enumeratedJob,
    } as never,
    inspectContainer: async () => 'not_found',
  });
  const result = await invoke(routes.getLiveActivity);

  assert.equal(result.status, 200);
  assert.equal(result.body.total, 1);
  assert.deepEqual(result.body.items.map(item => item.id), [taskId]);
});

test('omits an active queued candidate that completes during the database scan', async () => {
  const db = await database();
  let scanStarted = false;
  const enumeratedJob = {
    id: 'late-success-job',
    name: 'processPullRequestComment',
    timestamp: Date.parse('2026-08-14T12:00:00.000Z'),
    data: { repoOwner: 'integry', repoName: 'propr', pullRequestNumber: 1899 },
    getState: async () => {
      scanStarted = true;
      return 'active';
    },
  };
  const completedJob = {
    ...enumeratedJob,
    getState: async () => 'completed',
  };
  const routes = createLiveActivityRoutes({
    db,
    taskQueue: {
      getJobs: async () => [enumeratedJob],
      getJob: async () => scanStarted ? completedJob : enumeratedJob,
    } as never,
    inspectContainer: async () => 'not_found',
  });
  const result = await invoke(routes.getLiveActivity);

  assert.equal(result.status, 200);
  assert.equal(result.body.total, 0);
  assert.deepEqual(result.body.items, []);
});
