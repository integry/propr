import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { Response as ExpressResponse } from 'express';
import knex, { type Knex } from 'knex';
import type { RedisClientType } from 'redis';
import type { Server as SocketIOServer } from 'socket.io';
import type { FlatRequest } from '../requestTypes.js';
import { withLiveOutputReads } from './liveOutputRedisFake.js';

process.env.NODE_ENV = 'test';
process.env.PROPR_DEMO_MODE = 'true';

const { createLiveDetailsRoutes, projectTaskLiveDetails } = await import('../routes/liveDetailsRoutes.js');
const { parseExecutionDetailsRows } = await import('../routes/liveDetailsExecutionParser.js');
const { TaskWatcherManager } = await import('../services/taskWatcher.js');

/*
 * A completed Claude follow-up whose task live log holds only narration, while
 * the persisted provider records of its execution hold the tool calls and their
 * results. All data here is synthetic.
 */
const TASK_ID = 'synthetic-owner-repo-42';
const EARLIER_SESSION = 'synthetic-session-attempt-1';
const SESSION = 'synthetic-session-attempt-2';

let projectsDirectory = '';
let previousProjectsDirectory: string | undefined;

before(async () => {
  // No Claude conversation file exists: tasks run with --no-session-persistence.
  projectsDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'live-details-completed-'));
  previousProjectsDirectory = process.env.CLAUDE_PROJECTS_DIR;
  process.env.CLAUDE_PROJECTS_DIR = projectsDirectory;
});

after(async () => {
  if (previousProjectsDirectory === undefined) delete process.env.CLAUDE_PROJECTS_DIR;
  else process.env.CLAUDE_PROJECTS_DIR = previousProjectsDirectory;
  await fs.rm(projectsDirectory, { recursive: true, force: true });
  const { db } = await import('@propr/core');
  await db.destroy();
});

function timestamp(seconds: number): string {
  return new Date(Date.UTC(2026, 9, 16, 12, 0, seconds)).toISOString();
}

type ClaudeBlock = Record<string, unknown>;

/** A row as core's llmMetrics persists a Claude stream message. */
function claudeRow(executionId: string, sequence: number, { type, content, id }: { type: 'user' | 'assistant'; content: ClaudeBlock[] | null; id?: string }) {
  return {
    execution_id: executionId,
    sequence_number: sequence,
    event_type: type,
    event_timestamp: timestamp(sequence),
    content: JSON.stringify(content ? { id, role: type, content } : { id }),
    is_error: false,
    tool_name: content?.find(block => block.type === 'tool_use')?.name as string ?? null,
    tool_input: content?.find(block => block.type === 'tool_use') ? JSON.stringify(content.find(block => block.type === 'tool_use')!.input) : null,
    metadata: null,
  };
}

function bashExchange(executionId: string, sequence: number, [toolId, command, output]: [string, string, string]) {
  return [
    claudeRow(executionId, sequence, { type: 'assistant', content: [{ type: 'tool_use', id: toolId, name: 'Bash', input: { command } }], id: `msg-${toolId}` }),
    claudeRow(executionId, sequence + 1, { type: 'user', content: [{ type: 'tool_result', tool_use_id: toolId, content: output, is_error: false }] }),
  ];
}

const NARRATION = ['Checking the repository endpoints.', 'Running the HTTP checks.', 'All requested checks passed.'];

function completedExecutionRows(executionId: string) {
  return [
    // The worker prepends the prompt as a user message without content blocks.
    claudeRow(executionId, 0, { type: 'user', content: null, id: 'initial-prompt' }),
    claudeRow(executionId, 1, { type: 'assistant', content: [{ type: 'text', text: NARRATION[0] }], id: 'msg-1' }),
    ...bashExchange(executionId, 2, ['toolu_synthetic_1', 'curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:8080/health', '200']),
    ...bashExchange(executionId, 4, ['toolu_synthetic_2', 'curl -s http://127.0.0.1:8080/api/version', '{"version":"synthetic"}']),
    claudeRow(executionId, 6, { type: 'assistant', content: [{ type: 'text', text: NARRATION[1] }], id: 'msg-2' }),
    ...bashExchange(executionId, 7, ['toolu_synthetic_3', 'curl -sI http://127.0.0.1:8080/', 'HTTP/1.1 200 OK']),
    ...bashExchange(executionId, 9, ['toolu_synthetic_4', 'curl -s http://127.0.0.1:8080/missing -o /dev/null -w "%{http_code}"', '404']),
    claudeRow(executionId, 11, { type: 'assistant', content: [{ type: 'text', text: NARRATION[2] }], id: 'msg-3' }),
    // User text (not a tool result) is not part of the timeline.
    claudeRow(executionId, 12, { type: 'user', content: [{ type: 'text', text: 'synthetic user note' }] }),
  ];
}

/** What the task's live log holds: Claude narration only, no tool records. */
const THOUGHT_ONLY_LIVE_LOG = NARRATION.map(text => JSON.stringify({
  type: 'assistant', message: { id: `live-${text.length}`, content: [{ type: 'text', text }] },
})).join('\n');

async function createDatabase(): Promise<Knex> {
  const database = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  await database.schema.createTable('llm_executions', table => {
    table.text('execution_id').notNullable();
    table.text('task_id').notNullable();
    table.text('session_id').notNullable();
    table.text('start_time').notNullable();
    table.integer('input_tokens');
    table.integer('output_tokens');
    table.integer('cache_creation_input_tokens');
    table.integer('cache_read_input_tokens');
  });
  await database.schema.createTable('llm_execution_details', table => {
    table.text('execution_id').notNullable();
    table.integer('sequence_number').notNullable();
    table.text('event_type').notNullable();
    table.text('event_timestamp').notNullable();
    table.text('content');
    table.boolean('is_error');
    table.text('tool_name');
    table.text('tool_input');
    table.text('metadata');
  });
  await database.schema.createTable('task_history', table => {
    table.increments('history_id');
    table.text('task_id').notNullable();
    table.text('state').notNullable();
    table.text('timestamp').notNullable();
    table.text('metadata');
  });
  // An earlier attempt of the same task, in its own session.
  await database('llm_executions').insert({ execution_id: 'execution-attempt-1', task_id: TASK_ID, session_id: EARLIER_SESSION, start_time: timestamp(0) });
  await database('llm_execution_details').insert(bashExchange('execution-attempt-1', 0, ['toolu_earlier', 'echo earlier-attempt', 'earlier-attempt']));
  // Another task reusing the session identifier must not leak in.
  await database('llm_executions').insert({ execution_id: 'execution-other-task', task_id: 'synthetic-other-task', session_id: SESSION, start_time: timestamp(30) });
  await database('llm_execution_details').insert(bashExchange('execution-other-task', 0, ['toolu_other', 'echo other-task', 'other-task']));
  // The completed follow-up.
  await database('llm_executions').insert({
    execution_id: 'execution-attempt-2', task_id: TASK_ID, session_id: SESSION, start_time: timestamp(20),
    input_tokens: 120, output_tokens: 40, cache_creation_input_tokens: 0, cache_read_input_tokens: 15,
  });
  await database('llm_execution_details').insert(completedExecutionRows('execution-attempt-2'));
  return database;
}

function workerState(finalState: string): string {
  return JSON.stringify({ history: [
    { state: 'claude_execution', timestamp: timestamp(0), metadata: { sessionId: EARLIER_SESSION } },
    { state: 'completed', timestamp: timestamp(10) },
    { state: 'claude_execution', timestamp: timestamp(20), metadata: { sessionId: SESSION } },
    ...(finalState === 'claude_execution' ? [] : [{ state: finalState, timestamp: timestamp(40) }]),
  ] });
}

function createRedis(finalState: string) {
  return withLiveOutputReads({
    get: async (key: string) => {
      if (key === `worker:state:${TASK_ID}`) return workerState(finalState);
      if (key === `agent:output:${TASK_ID}`) return THOUGHT_ONLY_LIVE_LOG;
      return null;
    },
  }) as unknown as RedisClientType;
}

type LiveEvent = Record<string, unknown> & { id: string; type: string };
type LiveBody = { events: LiveEvent[]; omittedEventCount?: number; tokenUsage?: Record<string, number> | null };

async function readLiveDetails(redisClient: RedisClientType, database: Knex): Promise<LiveBody> {
  let payload: unknown;
  const response = {
    status() { return response; },
    json(value: unknown) { payload = value; return response; },
  } as unknown as ExpressResponse;
  await createLiveDetailsRoutes({ redisClient, db: database }).getLiveDetails({ params: { taskId: TASK_ID } } as unknown as FlatRequest, response);
  return payload as LiveBody;
}

/** A database whose every query fails, as when the persisted store is unavailable. */
function unavailableDatabase(): Knex {
  return (() => { throw new Error('database unavailable'); }) as unknown as Knex;
}

test('persisted Claude rows project tool calls paired with their results and skip prompt and user text', () => {
  const parsed = parseExecutionDetailsRows(completedExecutionRows('execution-attempt-2'));
  assert.deepEqual(parsed.events.map(event => event.type), [
    'thought', 'tool_use', 'tool_result', 'tool_use', 'tool_result', 'thought', 'tool_use', 'tool_result', 'tool_use', 'tool_result', 'thought',
  ]);
  assert.equal(JSON.stringify(parsed.events).includes('initial-prompt'), false);
  assert.equal(JSON.stringify(parsed.events).includes('synthetic user note'), false);
});

test('completed task live details prefer persisted tool trace over a thought-only live log', async () => {
  const database = await createDatabase();
  try {
    const redisClient = createRedis('completed');
    const first = await readLiveDetails(redisClient, database);
    const second = await readLiveDetails(redisClient, database);

    assert.deepEqual(first.events.map(event => event.type), [
      'thought', 'tool_use', 'tool_result', 'tool_use', 'tool_result', 'thought', 'tool_use', 'tool_result', 'tool_use', 'tool_result', 'thought',
    ]);
    assert.equal(first.omittedEventCount, 0);
    assert.deepEqual(first.tokenUsage, { input_tokens: 120, output_tokens: 40, cache_creation_input_tokens: 0, cache_read_input_tokens: 15 });

    // Every tool call is followed by its own result.
    const uses = first.events.filter(event => event.type === 'tool_use');
    assert.equal(uses.length, 4);
    for (const use of uses) {
      const result = first.events[first.events.indexOf(use) + 1];
      assert.equal(result.type, 'tool_result');
      assert.equal(result.toolUseId, use.id.split(":external:")[1]);
      assert.equal(use.toolName, 'Bash');
    }
    assert.deepEqual(uses.map(use => (use.input as { command: string }).command), [
      'curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:8080/health',
      'curl -s http://127.0.0.1:8080/api/version',
      'curl -sI http://127.0.0.1:8080/',
      'curl -s http://127.0.0.1:8080/missing -o /dev/null -w "%{http_code}"',
    ]);
    assert.deepEqual(first.events.filter(event => event.type === 'tool_result').map(event => event.result), [
      '200', '{"version":"synthetic"}', 'HTTP/1.1 200 OK', '404',
    ]);
    assert.deepEqual(first.events.filter(event => event.type === 'thought').map(event => event.content), NARRATION);

    // Stable, unique, execution-scoped IDs across repeated full reloads.
    assert.deepEqual(second, first);
    assert.equal(new Set(first.events.map(event => event.id)).size, first.events.length);
    assert.ok(first.events.every(event => event.id.startsWith(`live:${TASK_ID}:database:${SESSION}:`)));

    // Neither the earlier attempt nor another task's execution is mixed in.
    const serialized = JSON.stringify(first);
    assert.equal(serialized.includes('earlier-attempt'), false);
    assert.equal(serialized.includes('other-task'), false);
    assert.equal(serialized.includes(EARLIER_SESSION), false);
  } finally {
    await database.destroy();
  }
});

test('a live task keeps serving its live log', async () => {
  const database = await createDatabase();
  try {
    const live = await readLiveDetails(createRedis('claude_execution'), database);
    assert.deepEqual(live.events.map(event => event.content), NARRATION);
    assert.ok(live.events.every(event => event.id.includes(':redis:')));
  } finally {
    await database.destroy();
  }
});

test('a completed task falls back to its live log when the database is unavailable or holds no execution', async () => {
  const unavailable = await readLiveDetails(createRedis('completed'), unavailableDatabase());
  assert.deepEqual(unavailable.events.map(event => event.content), NARRATION);

  const empty = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  try {
    await empty.schema.createTable('llm_executions', table => {
      table.text('execution_id'); table.text('task_id'); table.text('session_id'); table.text('start_time');
      table.integer('input_tokens'); table.integer('output_tokens');
      table.integer('cache_creation_input_tokens'); table.integer('cache_read_input_tokens');
    });
    await empty.schema.createTable('task_history', table => {
      table.text('task_id'); table.text('state'); table.text('timestamp'); table.text('metadata');
    });
    const withoutExecution = await readLiveDetails(createRedis('completed'), empty);
    assert.deepEqual(withoutExecution.events.map(event => event.content), NARRATION);
  } finally {
    await empty.destroy();
  }
});

test('the shared projection prefers persisted details for a completed task only', async () => {
  const database = await createDatabase();
  try {
    const completed = await projectTaskLiveDetails(createRedis('completed'), database, TASK_ID, { sessionId: SESSION, limitEvents: false });
    assert.equal(completed?.events.filter(event => event.type === 'tool_use').length, 4);
    assert.deepEqual(completed?.events.map(event => event.id), (await readLiveDetails(createRedis('completed'), database)).events.map(event => event.id));

    const live = await projectTaskLiveDetails(createRedis('claude_execution'), database, TASK_ID, { sessionId: SESSION });
    assert.deepEqual(live?.events.map(event => event.content), NARRATION);

    const unavailable = await projectTaskLiveDetails(createRedis('completed'), unavailableDatabase(), TASK_ID, { sessionId: SESSION });
    assert.deepEqual(unavailable?.events.map(event => event.content), NARRATION);
  } finally {
    await database.destroy();
  }
});

async function watcherBroadcasts(finalState: string, database: Knex): Promise<Array<{ events: LiveEvent[] }>> {
  const emitted: Array<{ events: LiveEvent[] }> = [];
  const io = {
    to: () => ({ emit: (_event: string, payload: { events: LiveEvent[] }) => { emitted.push(payload); } }),
    sockets: { adapter: { rooms: new Map() } },
  } as unknown as SocketIOServer;
  const manager = new TaskWatcherManager(io);
  manager.setDeps({ redisClient: createRedis(finalState), db: database });
  try {
    await manager.startTaskWatcher(TASK_ID);
  } finally {
    await manager.closeAll();
  }
  return emitted;
}

test('the realtime watcher does not broadcast a completed task live log over its persisted details', async () => {
  const database = await createDatabase();
  try {
    assert.deepEqual(await watcherBroadcasts('completed', database), []);

    const live = await watcherBroadcasts('claude_execution', database);
    assert.equal(live.length, 1);
    assert.deepEqual(live[0].events.map(event => event.content), NARRATION);

    const unavailable = await watcherBroadcasts('completed', unavailableDatabase());
    assert.equal(unavailable.length, 1);
    assert.deepEqual(unavailable[0].events.map(event => event.content), NARRATION);
  } finally {
    await database.destroy();
  }
});

const FOLLOWUP_SESSION = 'synthetic-session-attempt-3';
const FOLLOWUP_LIVE_LOG = JSON.stringify({
  type: 'assistant', message: { id: 'live-followup', content: [{ type: 'text', text: 'Follow-up finished without persisted records.' }] },
});

/** The completed task, then a follow-up execution in its own session that is live or finished. */
function followupWorkerState(followupFinished: boolean): string {
  const { history } = JSON.parse(workerState('completed')) as { history: unknown[] };
  history.push({ state: 'claude_execution', timestamp: timestamp(50), metadata: { sessionId: FOLLOWUP_SESSION } });
  if (followupFinished) history.push({ state: 'completed', timestamp: timestamp(60) });
  return JSON.stringify({ history });
}

/** One watcher kept subscribed while the task's state and live log change between polls. */
async function subscribedWatcher(database: Knex, state: { worker: string; output: string }) {
  const emitted: Array<{ events: LiveEvent[] }> = [];
  const io = {
    to: () => ({ emit: (_event: string, payload: { events: LiveEvent[] }) => { emitted.push(payload); } }),
    sockets: { adapter: { rooms: new Map() } },
  } as unknown as SocketIOServer;
  const redisClient = withLiveOutputReads({
    get: async (key: string) => {
      if (key === `worker:state:${TASK_ID}`) return state.worker;
      if (key === `agent:output:${TASK_ID}`) return state.output;
      return null;
    },
  }) as unknown as RedisClientType;
  const manager = new TaskWatcherManager(io);
  manager.setDeps({ redisClient, db: database });
  await manager.startTaskWatcher(TASK_ID);
  const poll = (manager as unknown as { sendRedisLiveUpdate: (id: string) => Promise<void> }).sendRedisLiveUpdate.bind(manager);
  return { emitted, redisClient, poll: () => poll(TASK_ID), close: () => manager.closeAll() };
}

test('a follow-up finishing between polls without persisted details still broadcasts its live log', async () => {
  const database = await createDatabase();
  const state = { worker: workerState('completed'), output: THOUGHT_ONLY_LIVE_LOG };
  const watcher = await subscribedWatcher(database, state);
  try {
    assert.equal(watcher.emitted.length, 0);
    // The follow-up is live while the task's legacy log is still the earlier execution's.
    state.worker = followupWorkerState(false);
    await watcher.poll();
    assert.equal(watcher.emitted.length, 0);
    // It finishes and replaces the log before the next poll; it has no persisted details.
    state.worker = followupWorkerState(true);
    state.output = FOLLOWUP_LIVE_LOG;
    await watcher.poll();
    assert.equal(watcher.emitted.length, 1);
    assert.deepEqual(watcher.emitted[0].events.map(event => event.content), ['Follow-up finished without persisted records.']);
    // HTTP reads serve the same fallback.
    const read = await readLiveDetails(watcher.redisClient, database);
    assert.deepEqual(read.events.map(event => event.content), ['Follow-up finished without persisted records.']);
  } finally {
    await watcher.close();
    await database.destroy();
  }
});

test('a subscribed client of a task completing between polls gets its persisted details from the completion read', async () => {
  const database = await createDatabase();
  const state = { worker: workerState('claude_execution'), output: THOUGHT_ONLY_LIVE_LOG.split('\n')[0] };
  const watcher = await subscribedWatcher(database, state);
  try {
    assert.equal(watcher.emitted.length, 1);
    assert.deepEqual(watcher.emitted[0].events.map(event => event.content), [NARRATION[0]]);
    // Final output and completion both land before the next poll.
    state.output = THOUGHT_ONLY_LIVE_LOG;
    state.worker = workerState('completed');
    await watcher.poll();
    assert.equal(watcher.emitted.length, 1);
    // The client's read on completion replaces its live view with the canonical trace.
    const read = await readLiveDetails(watcher.redisClient, database);
    assert.equal(read.events.filter(event => event.type === 'tool_use').length, 4);
    assert.ok(read.events.every(event => event.id.startsWith(`live:${TASK_ID}:database:${SESSION}:`)));
  } finally {
    await watcher.close();
    await database.destroy();
  }
});
