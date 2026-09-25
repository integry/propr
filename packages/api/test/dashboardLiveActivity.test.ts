import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import type { Knex } from 'knex';
import type { RedisClientType } from 'redis';
import { closeConnection } from '@propr/core';
import { createDashboardRoutes } from '../routes/dashboardRoutes.js';
import { describeToolUse, EMPTY_LIVE_DETAILS, summariseLiveActivity } from '../routes/dashboardLiveActivity.js';
import {
  call,
  clearDashboardTestDatabase,
  createDashboardTestDatabase,
  createTestDashboardRoutes,
  minutesAgo,
  NOW,
  seedTask,
} from './dashboardTestHarness.js';

let database: Knex;

before(async () => { database = await createDashboardTestDatabase(); });
after(async () => {
  await database.destroy();
  // The production projector's module opens the shared core connection.
  await closeConnection();
});
beforeEach(async () => clearDashboardTestDatabase(database));

test('a tool call is described as the action it performs, by file name rather than host path', () => {
  assert.equal(
    describeToolUse('Edit', { file_path: '/tmp/git-processor/worktrees/acme/app/src/Dashboard.tsx' }),
    'Editing Dashboard.tsx',
  );
  assert.equal(describeToolUse('Read', { file_path: '/workspace/README.md' }), 'Reading README.md');
  assert.equal(describeToolUse('Grep', { pattern: 'useNowTick' }), 'Searching for useNowTick');
  assert.equal(describeToolUse('Task', { description: 'Find dashboard tests' }), 'Sub-agent: Find dashboard tests');
  assert.equal(
    describeToolUse('FileChange', { changes: [{ path: '/w/a.ts' }, { path: '/w/b.ts' }, { path: '/w/c.ts' }] }),
    'Editing a.ts and 2 more',
  );
  assert.equal(describeToolUse('WebFetch', { url: 'https://docs.example.com/page' }), 'Fetching docs.example.com');
  assert.equal(describeToolUse('mcp__github__get_issue', {}), 'Using mcp__github__get_issue');
});

test('a shell command prefers the model-written description, then the command without its cd preamble', () => {
  assert.equal(describeToolUse('Bash', { command: 'npm test', description: 'Run dashboard unit tests' }), 'Run dashboard unit tests');
  assert.equal(describeToolUse('Bash', { command: 'cd /workspace/app && npx vitest run' }), 'Running npx vitest run');
  assert.equal(describeToolUse('command_execution', { command: ['bash', '-lc', 'npm run lint'] }), 'Running npm run lint');
});

test('plan bookkeeping is not an action: the latest real tool call is', () => {
  const summary = summariseLiveActivity({
    currentTask: null,
    todos: [],
    events: [
      { type: 'tool_use', toolName: 'Edit', input: { file_path: '/w/retry.ts' }, timestamp: '2026-09-23T11:58:00.000Z' },
      { type: 'tool_use', toolName: 'TodoWrite', input: { todos: [] }, timestamp: '2026-09-23T11:59:00.000Z' },
    ],
  });
  assert.equal(summary.activity, 'Editing retry.ts');
  assert.equal(summary.lastActivityAt, '2026-09-23T11:59:00.000Z');
});

test('the plan step counts only while a step is in progress', () => {
  const todos = [
    { status: 'completed', content: 'Read the code' },
    { status: 'completed', content: 'Change it' },
    { status: 'in_progress', content: 'Run the tests' },
    { status: 'pending', content: 'Open the PR' },
  ];
  assert.deepEqual(summariseLiveActivity({ todos }).step, { current: 3, total: 4 });
  assert.equal(summariseLiveActivity({ todos: todos.map(todo => ({ ...todo, status: 'completed' })) }).step, null);
});

test('a raw-output fallback has no event time, and an empty projection reports nothing', () => {
  const summary = summariseLiveActivity({
    events: [{ type: 'thought', content: 'raw', rawFallback: true, timestamp: '2026-09-23T11:59:00.000Z' }],
  });
  assert.equal(summary.lastActivityAt, null);
  assert.equal(summary.awaitingFirstOutput, false);
  // A read that found the stream empty: the agent has written nothing yet.
  assert.deepEqual(
    summariseLiveActivity(EMPTY_LIVE_DETAILS),
    { progressLine: null, activity: null, step: null, lastActivityAt: null, awaitingFirstOutput: true },
  );
  assert.equal(summariseLiveActivity({ events: [] }).awaitingFirstOutput, true);
  // No projection is unknown, not empty: the shared projector also returns null when its read failed.
  assert.deepEqual(
    summariseLiveActivity(null),
    { progressLine: null, activity: null, step: null, lastActivityAt: null, awaitingFirstOutput: false },
  );
});

test('output that names no action is not an empty stream', () => {
  const summary = summariseLiveActivity({
    events: [{ type: 'thought', content: 'Reading the issue', timestamp: '2026-09-23T11:59:00.000Z' }],
  });
  assert.deepEqual(
    [summary.progressLine, summary.activity, summary.lastActivityAt, summary.awaitingFirstOutput],
    [null, null, '2026-09-23T11:59:00.000Z', false],
  );
});

test('only a stream that was read and found empty is awaiting first output', async () => {
  // 21 running tasks: the oldest is past the live-details lookup cap.
  for (let index = 0; index < 21; index += 1) {
    await seedTask(database, { taskId: `run-${index}`, issueNumber: 300 + index, states: [{ state: 'claude_execution', timestamp: minutesAgo(60 - index) }] });
  }
  const dashboard = createTestDashboardRoutes(database, {}, async taskId => {
    if (taskId === 'run-20') return EMPTY_LIVE_DETAILS;
    if (taskId === 'run-19') throw new Error('unreadable stream');
    if (taskId === 'run-18') return null;
    return { events: [{ type: 'thought', content: 'Thinking', timestamp: minutesAgo(1) }] };
  });
  const active = await call(dashboard.getActive, { repository: 'all' });
  const byTask = new Map((active.body.running as Array<Record<string, unknown>>).map(item => [item.taskId, item]));

  assert.equal(byTask.get('run-20')?.awaitingFirstOutput, true);
  assert.equal(byTask.get('run-19')?.awaitingFirstOutput, false);
  assert.equal(byTask.get('run-18')?.awaitingFirstOutput, false);
  assert.deepEqual([byTask.get('run-10')?.activity, byTask.get('run-10')?.awaitingFirstOutput], [null, false]);
  // Never read: past the cap is unknown, not empty.
  assert.equal(byTask.get('run-0')?.awaitingFirstOutput, false);
});

test('the production projector reports an empty stream only when its persisted fallback was read', async () => {
  await seedTask(database, { taskId: 'silent-task', issueNumber: 81, states: [{ state: 'claude_execution', timestamp: minutesAgo(3) }] });
  await seedTask(database, { taskId: 'unreadable-task', issueNumber: 82, states: [{ state: 'claude_execution', timestamp: minutesAgo(2) }] });
  // No active Redis output for either task, so both fall back to persisted
  // output; that database read fails for one of them.
  let failPersistedRead = false;
  const redisClient = {
    get: async (key: string) => {
      failPersistedRead = key === 'agent:output:unreadable-task';
      return null;
    },
    sMembers: async () => ['worker:0'],
    hGetAll: async () => ({ 'worker:0': '1' }),
  } as unknown as RedisClientType;
  const db = new Proxy(database, {
    apply(target, thisArg, args: unknown[]) {
      if (failPersistedRead && args[0] === 'task_history') throw new Error('database unavailable');
      return Reflect.apply(target, thisArg, args);
    },
  });
  const dashboard = createDashboardRoutes({
    db,
    redisClient,
    taskQueue: { isPaused: async () => false, getActiveCount: async () => 0 } as never,
    now: () => NOW,
  });

  const active = await call(dashboard.getActive, { repository: 'all' });
  const byTask = new Map((active.body.running as Array<Record<string, unknown>>).map(item => [item.taskId, item]));
  assert.equal(byTask.get('silent-task')?.awaitingFirstOutput, true);
  assert.deepEqual(
    [byTask.get('unreadable-task')?.activity, byTask.get('unreadable-task')?.awaitingFirstOutput],
    [null, false],
  );
});

test('active carries each running agent\'s latest action, plan step and last output time', async () => {
  await seedTask(database, { taskId: 'busy-task', issueNumber: 91, states: [{ state: 'claude_execution', timestamp: minutesAgo(26) }] });
  await seedTask(database, { taskId: 'broken-task', issueNumber: 92, states: [{ state: 'claude_execution', timestamp: minutesAgo(5) }] });
  await seedTask(database, { taskId: 'queued-task', issueNumber: 93, states: [{ state: 'queued', timestamp: minutesAgo(1) }] });

  const dashboard = createTestDashboardRoutes(database, {}, async taskId => {
    if (taskId === 'broken-task') throw new Error('unreadable stream');
    return {
      currentTask: 'Running tests',
      todos: [{ status: 'completed', content: 'Plan' }, { status: 'in_progress', content: 'Running tests' }],
      events: [
        { type: 'tool_use', toolName: 'Bash', input: { command: 'npm test' }, timestamp: minutesAgo(1) },
      ],
    };
  });
  const active = await call(dashboard.getActive, { repository: 'all' });

  const running = active.body.running as Array<Record<string, unknown>>;
  const busy = running.find(item => item.taskId === 'busy-task');
  assert.deepEqual(
    [busy?.progressLine, busy?.activity, busy?.step, busy?.lastActivityAt],
    ['Running tests', 'Running npm test', { current: 2, total: 2 }, minutesAgo(1)],
  );
  // An unreadable stream is unknown progress, never a failed read.
  const broken = running.find(item => item.taskId === 'broken-task');
  assert.deepEqual(
    [broken?.phase, broken?.progressLine, broken?.activity, broken?.step, broken?.lastActivityAt],
    ['Implementing', null, null, null, null],
  );

  const queued = active.body.queued as Array<Record<string, unknown>>;
  assert.deepEqual([queued[0].activity, queued[0].lastActivityAt], [null, null]);
});
