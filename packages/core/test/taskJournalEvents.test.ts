import assert from 'node:assert/strict';
import { after, beforeEach, mock, test } from 'node:test';
import knex from 'knex';
import { up as createJournal } from '../src/db/migrations/20261112160000_create_repository_events.js';
import { up as addTaskDomain } from '../src/db/migrations/20261114120000_add_task_repository_event_domain.js';

/**
 * The task state manager journals `task` events where it records task state
 * changes: `queued` on creation, `started` when a run starts, and one terminal
 * event. Driven through the real manager against SQLite and an in-memory Redis.
 */
const database = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
const warnings: Array<Record<string, unknown>> = [];
const log = {
  info() {}, debug() {}, error() {}, warn(entry: Record<string, unknown>) { warnings.push(entry); },
  withCorrelation: () => log,
};
const redisValues = new Map<string, string>();
await mock.module('ioredis', { namedExports: { Redis: function Redis() {
  return {
    setex: async (key: string, _ttl: number, value: string) => { redisValues.set(key, value); return 'OK'; },
    set: async (key: string, value: string, ..._args: unknown[]) => {
      if (redisValues.has(key)) return null;
      redisValues.set(key, value); return 'OK';
    },
    get: async (key: string) => redisValues.get(key) ?? null,
    // The compare-and-set script: replace the value only while it still equals the one read.
    eval: async (_script: string, _keys: number, key: string, current: string, _ttl: number, next: string) => {
      if (redisValues.get(key) !== current) return 0;
      redisValues.set(key, next); return 1;
    },
    on: () => {}, quit: async () => {}, disconnect: () => {},
  };
} } });
await mock.module('../src/db/connection.js', { namedExports: { db: database, closeConnection: async () => {} } });
await mock.module('../src/utils/logger.js', { defaultExport: log, namedExports: { generateCorrelationId: () => 'corr-1' } });
const activity: unknown[] = [];
await mock.module('../src/utils/eventPublisher.js', { namedExports: { getEventPublisher: () => ({
  publishTaskUpdate: async () => true,
  publishActivity: async (event: unknown) => { activity.push(event); return true; },
}) } });

const { WorkerStateManager, TaskStates } = await import('../src/utils/workerStateManager.js');
const { listRepositoryEvents } = await import('../src/services/repositoryEventJournal.js');
const { buildTaskJournalEvent } = await import('../src/services/taskJournalEvents.js');

await database.schema.createTable('tasks', table => {
  table.string('task_id').primary(); table.string('job_id').unique(); table.string('correlation_id'); table.string('repository');
  table.integer('issue_number'); table.string('task_type'); table.string('model_name'); table.timestamp('created_at'); table.text('initial_job_data');
});
await database.schema.createTable('task_history', table => {
  table.increments('history_id'); table.string('task_id'); table.string('state'); table.timestamp('timestamp');
  table.text('reason'); table.json('metadata');
});
await createJournal(database);
await addTaskDomain(database);

const manager = new WorkerStateManager({ keyPrefix: 'test:task-journal:', stateExpiry: 3600 });
after(async () => { await manager.close(); await database.destroy(); });
beforeEach(async () => {
  for (const table of ['tasks', 'task_history', 'repository_events']) await database(table).delete();
  redisValues.clear(); warnings.length = 0; activity.length = 0;
});

const repository = 'acme/app';
const issueRef = (overrides: Record<string, unknown> = {}) => ({
  number: 42, repoOwner: 'acme', repoName: 'app', type: 'issue', agentAlias: 'claude', modelName: 'claude-opus-5-5', ...overrides,
});
const taskEvents = async () => (await listRepositoryEvents(database, { repository, domains: ['task'] }))
  .map(event => ({ type: event.type, entityId: event.entityId, issueNumber: event.issueNumber, prNumber: event.prNumber, payload: event.payload }));
const types = async () => (await taskEvents()).map(event => event.type);

async function runToProcessing(taskId: string, ref: Record<string, unknown>): Promise<void> {
  await manager.createTaskStateIfAbsent(taskId, ref as never, null, `job-${taskId}`);
  await manager.updateTaskState(taskId, TaskStates.PROCESSING, { reason: 'Starting' });
  await manager.updateTaskState(taskId, TaskStates.CLAUDE_EXECUTION, { reason: 'Agent running' });
  await manager.updateTaskState(taskId, TaskStates.POST_PROCESSING, { reason: 'Publishing' });
}

test('an implementation task journals queued, started and completed in order with the documented payload', async () => {
  await runToProcessing('issue-42', issueRef());
  await manager.markTaskCompleted('issue-42', { prCreated: true, prNumber: 77, prUrl: 'https://github.com/acme/app/pull/77' });

  const events = await taskEvents();
  assert.deepEqual(events.map(event => event.type), ['queued', 'started', 'completed']);
  const base = { taskId: 'issue-42', kind: 'implementation', issueNumber: 42, prNumber: null, agent: 'claude', model: 'claude-opus-5-5', attempts: 0 };
  assert.deepEqual(events[0], { type: 'queued', entityId: 'issue-42', issueNumber: 42, prNumber: null, payload: base });
  assert.deepEqual(events[1].payload, base);
  const { durationMs, ...terminal } = events[2].payload;
  assert.deepEqual(terminal, { ...base, status: 'completed', terminalReason: null, pullRequest: 'opened', failureCategory: null });
  assert.equal(typeof durationMs, 'number');
  assert.ok((durationMs as number) >= 0);
  // Task state already has its own realtime event; the journal publishes no second one.
  assert.equal(activity.length, 0);
});

test('a pull request follow-up journals queued, started and completed, and reports the pull request as updated', async () => {
  const ref = issueRef({ number: 9, pullRequestNumber: 9, type: 'pr-comment', agentAlias: 'codex', modelName: 'gpt-5' });
  await runToProcessing('pr-comment-9-1', ref);
  await manager.updateTaskState('pr-comment-9-1', TaskStates.COMPLETED, { reason: 'PR comment processing completed successfully', commitHash: 'abc123' });

  const events = await taskEvents();
  assert.deepEqual(events.map(event => event.type), ['queued', 'started', 'completed']);
  for (const event of events) {
    assert.equal(event.prNumber, 9);
    assert.equal(event.issueNumber, null);
    assert.equal(event.payload.kind, 'follow-up');
    assert.equal(event.payload.agent, 'codex');
    assert.equal(event.payload.model, 'gpt-5');
  }
  assert.equal(events[2].payload.pullRequest, 'updated');
});

test('a cancelled task appends cancelled with its coded reason', async () => {
  await manager.createTaskStateIfAbsent('issue-5', issueRef({ number: 5 }) as never);
  await manager.markTaskCancelled('issue-5', 'user');
  const events = await taskEvents();
  assert.deepEqual(events.map(event => event.type), ['queued', 'cancelled']);
  assert.equal(events[1].payload.status, 'cancelled');
  assert.equal(events[1].payload.terminalReason, 'cancelled_by_user');
  assert.equal(events[1].payload.durationMs, null, 'a task cancelled before it started has no run duration');
  assert.equal(events[1].payload.failureCategory, null);
});

test('a failed task appends failed with a failure category; a retry starts again and ends once more', async () => {
  await runToProcessing('issue-6', issueRef({ number: 6 }));
  await manager.markTaskFailed('issue-6', new Error('git push rejected'), { errorCategory: 'git_operation' });
  let events = await taskEvents();
  assert.deepEqual(events.map(event => event.type), ['queued', 'started', 'failed']);
  assert.equal(events[2].payload.failureCategory, 'git_operation');
  assert.equal(events[2].payload.status, 'failed');

  await manager.updateTaskState('issue-6', TaskStates.PROCESSING, { isRetry: true, reason: 'Retrying' });
  await manager.updateTaskState('issue-6', TaskStates.FAILED, { terminalReason: 'timed_out', reason: 'Timed out' });
  events = await taskEvents();
  assert.deepEqual(events.map(event => event.type), ['queued', 'started', 'failed', 'started', 'failed']);
  assert.equal(events[3].payload.attempts, 1);
  assert.equal(events[4].payload.failureCategory, 'timed_out');
});

test('a free-text error category is not journaled as a failure category', async () => {
  await runToProcessing('issue-8', issueRef({ number: 8 }));
  await manager.markTaskFailed('issue-8', new Error('boom'), { errorCategory: 'Error: the agent said something long' });
  assert.equal((await taskEvents())[2].payload.failureCategory, 'unknown');
});

/** Run `steps` with `Date` frozen at each given minute past midnight in turn. */
async function atMinutes(steps: Array<[number, () => Promise<unknown>]>): Promise<void> {
  const midnight = Date.parse('2026-11-14T00:00:00.000Z');
  mock.timers.enable({ apis: ['Date'], now: midnight });
  try {
    for (const [minute, step] of steps) { mock.timers.setTime(midnight + minute * 60_000); await step(); }
  } finally { mock.timers.reset(); }
}

test('a queue handoff is not journaled as a cancellation, resuming it is not a new start, and its duration spans the handoff', async () => {
  const taskId = 'pr-comment-3-1';
  await atMinutes([
    [0, () => runToProcessing(taskId, issueRef({ number: 3, type: 'pr-comment' }))],
    [5, () => manager.updateTaskState(taskId, TaskStates.CANCELLED, {
      reason: 'PR comment job requeued', historyMetadata: { jobResultStatus: 'requeued' },
    })],
    [10, () => manager.updateTaskState(taskId, TaskStates.PROCESSING, { reason: 'Resumed' })],
    [11, () => manager.updateTaskState(taskId, TaskStates.COMPLETED, { reason: 'done' })],
  ]);
  assert.deepEqual(await types(), ['queued', 'started', 'completed']);
  assert.equal((await taskEvents())[2].payload.durationMs, 11 * 60_000, 'the run is measured from its journaled start');
});

test('repeated queue handoffs keep the original start; a retry after a real failure measures the new run', async () => {
  const taskId = 'pr-comment-4-1';
  await atMinutes([
    [0, () => runToProcessing(taskId, issueRef({ number: 4, type: 'pr-comment' }))],
    [2, () => manager.updateTaskState(taskId, TaskStates.CANCELLED, { reason: 'Task job rescheduled: rate limit' })],
    [3, () => manager.updateTaskState(taskId, TaskStates.PROCESSING, { reason: 'Resumed' })],
    [4, () => manager.updateTaskState(taskId, TaskStates.CANCELLED, {
      reason: 'PR comment job requeued', historyMetadata: { jobResultStatus: 'requeued' },
    })],
    [6, () => manager.updateTaskState(taskId, TaskStates.CLAUDE_EXECUTION, { reason: 'Resumed' })],
    [7, () => manager.markTaskFailed(taskId, new Error('boom'), { errorCategory: 'worker' })],
    [20, () => manager.updateTaskState(taskId, TaskStates.PROCESSING, { isRetry: true, reason: 'Retrying' })],
    [23, () => manager.updateTaskState(taskId, TaskStates.COMPLETED, { reason: 'done' })],
  ]);
  const events = await taskEvents();
  assert.deepEqual(events.map(event => event.type), ['queued', 'started', 'failed', 'started', 'completed']);
  assert.equal(events[2].payload.durationMs, 7 * 60_000, 'both handoffs belong to the first run');
  assert.equal(events[4].payload.durationMs, 3 * 60_000, 'the retry is a new run');
});

test('task types outside the documented kinds, and tasks without a repository, append nothing', async () => {
  await manager.createTaskStateIfAbsent('goal-1', issueRef({ number: 0, type: 'goal' }) as never);
  await manager.markTaskCompleted('goal-1', {});
  await manager.createTaskStateIfAbsent('agent-run-x', issueRef({ number: 0, type: 'agent-run', repoOwner: '', repoName: '' }) as never);
  await manager.markTaskCompleted('agent-run-x', {});
  assert.deepEqual(await types(), []);
  assert.equal(warnings.length, 0);

  await manager.createTaskStateIfAbsent('agent-run-y', issueRef({ number: 0, type: 'agent-run' }) as never);
  const [queued] = await taskEvents();
  assert.equal(queued.payload.kind, 'automation');
  assert.equal(queued.issueNumber, null);
});

test('sentinel: prompt text and tool output never appear in a task event', async () => {
  const PROMPT = 'SENTINEL_PROMPT_TEXT_93f1';
  const TOOL = 'SENTINEL_TOOL_OUTPUT_5ab2';
  const ref = issueRef({
    number: 11, title: PROMPT, body: PROMPT, taskDescription: PROMPT, prompt: PROMPT, commentBody: PROMPT,
    triggeringLabel: PROMPT,
  });
  await manager.createTaskStateIfAbsent('issue-11', ref as never);
  await manager.updateTaskState('issue-11', TaskStates.PROCESSING, { reason: `Starting: ${PROMPT}`, historyMetadata: { prompt: PROMPT } });
  await manager.updateTaskState('issue-11', TaskStates.CLAUDE_EXECUTION, {
    reason: TOOL, claudeResult: { success: true, sessionId: TOOL }, historyMetadata: { toolOutput: TOOL, log: TOOL },
  });
  await manager.markTaskCompleted('issue-11', {
    prCreated: true, prNumber: 12, prUrl: `https://example.test/${TOOL}`, notificationRecap: TOOL, notificationSummary: PROMPT,
    commitResult: { message: TOOL, files: [PROMPT] },
  });
  await runToProcessing('issue-13', issueRef({ number: 13, title: PROMPT }));
  await manager.markTaskFailed('issue-13', new Error(`${TOOL} ${PROMPT}`), { errorCategory: TOOL, historyMetadata: { stderr: TOOL } });

  const rows = await database('repository_events').where({ domain: 'task' }).select('*');
  assert.deepEqual(rows.map(row => row.type), ['queued', 'started', 'completed', 'queued', 'started', 'failed']);
  const serialized = JSON.stringify(rows);
  assert.ok(!serialized.includes(PROMPT), 'prompt text leaked into a task event');
  assert.ok(!serialized.includes(TOOL), 'tool output leaked into a task event');
  // Every payload is limited to the documented keys.
  const allowed = new Set(['taskId', 'kind', 'issueNumber', 'prNumber', 'agent', 'model', 'attempts',
    'status', 'terminalReason', 'durationMs', 'pullRequest', 'failureCategory']);
  for (const row of rows) for (const key of Object.keys(JSON.parse(row.payload))) assert.ok(allowed.has(key), `unexpected payload key ${key}`);
});

test('a journal append failure does not change the task outcome', async () => {
  await database.schema.renameTable('repository_events', 'repository_events_away');
  try {
    await runToProcessing('issue-21', issueRef({ number: 21 }));
    const completed = await manager.markTaskCompleted('issue-21', { prCreated: true, prNumber: 3 });
    assert.equal(completed.state, TaskStates.COMPLETED);
    assert.equal((await manager.getTaskState('issue-21'))?.state, TaskStates.COMPLETED);
    const history = await database('task_history').where({ task_id: 'issue-21' }).orderBy('history_id').pluck('state');
    assert.deepEqual(history, ['pending', 'processing', 'claude_execution', 'post_processing', 'completed']);
    assert.ok(warnings.some(entry => entry.domain === 'task'), 'the failed append is logged');
  } finally {
    await database.schema.renameTable('repository_events_away', 'repository_events');
  }
});

test('building an event from a malformed state never throws into the task', async () => {
  const { appendTaskJournalEvent } = await import('../src/services/taskJournalEvents.js');
  await assert.doesNotReject(appendTaskJournalEvent({ state: null as never, previousState: 'pending' }));
  assert.equal(buildTaskJournalEvent({ state: { taskId: 't', issueRef: issueRef(), state: 'processing', history: [] } as never, previousState: 'processing' }), null);
});

test('the domain migration keeps rows, indexes and the seq high-water mark, and rolls back without task rows', async () => {
  const { up: nocaseIndex } = await import('../src/db/migrations/20261113000000_add_repository_events_nocase_index.js');
  const { down: removeTaskDomain } = await import('../src/db/migrations/20261114120000_add_task_repository_event_domain.js');
  const scratch = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  const row = (seq: number | undefined, domain: string, type: string) => ({
    ...(seq === undefined ? {} : { seq }), repository, domain, type, entity_id: '1', payload: '{}', occurred_at: '2026-11-14T00:00:00.000Z',
  });
  try {
    await createJournal(scratch);
    await nocaseIndex(scratch);
    await scratch('repository_events').insert([row(undefined, 'pull_request', 'opened'), row(undefined, 'plan_issue', 'status_changed'), row(undefined, 'epic_queue', 'advanced')]);
    // Retention deleted the newest row: its seq must never be reused.
    await scratch('repository_events').where({ seq: 3 }).delete();
    await assert.rejects(scratch('repository_events').insert(row(undefined, 'task', 'queued')), /CHECK constraint/);

    await addTaskDomain(scratch);
    assert.deepEqual(await scratch('repository_events').orderBy('seq').pluck('seq'), [1, 2]);
    const indexes = (await scratch.raw("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'repository_events'"))
      .map((entry: { name: string }) => entry.name).sort();
    assert.deepEqual(indexes, ['repository_events_dedupe', 'repository_events_entity_seq', 'repository_events_occurred_at',
      'repository_events_repository_nocase_seq', 'repository_events_repository_seq']);
    const [seq] = await scratch('repository_events').insert(row(undefined, 'task', 'queued')).returning('seq');
    assert.equal(typeof seq === 'object' ? seq.seq : seq, 4);
    await assert.rejects(scratch('repository_events').insert(row(undefined, 'unknown', 'x')), /CHECK constraint/);

    await removeTaskDomain(scratch);
    assert.deepEqual(await scratch('repository_events').orderBy('seq').pluck('domain'), ['pull_request', 'plan_issue']);
    const [next] = await scratch('repository_events').insert(row(undefined, 'pull_request', 'merged')).returning('seq');
    assert.equal(typeof next === 'object' ? next.seq : next, 5);
  } finally {
    await scratch.destroy();
  }
});
