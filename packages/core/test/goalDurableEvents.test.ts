import assert from 'node:assert/strict';
import { after, beforeEach, describe, test } from 'node:test';
import knex, { type Knex } from 'knex';
import type { BetterSqliteConnection } from '../src/db/connection.js';
import { up as foundation } from '../src/db/migrations/20260831000000_create_goal_control_plane.js';
import { up as durable } from '../src/db/migrations/20260901000000_add_durable_goal_replay.js';
import { GoalError, GoalRepository } from '../src/services/goals/goalRepository.js';
import { GoalLifecycleService } from '../src/services/goals/goalLifecycleService.js';
import type { DurableGoalEventInput } from '@propr/shared';

let database: Knex;
let repository: GoalRepository;
let goalId: string;
let fence: { leaseOwner: string; leaseEpoch: number };
let source: DurableGoalEventInput['source'];

function openDatabase(): Knex {
  return knex({
    client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true,
    pool: { afterCreate(connection: BetterSqliteConnection, done: (error: Error | null, value: BetterSqliteConnection) => void) {
      connection.pragma('foreign_keys = ON');
      connection.pragma('journal_mode = WAL');
      done(null, connection);
    } },
  });
}

function event<K extends DurableGoalEventInput['type']>(
  type: K,
  payload: Extract<DurableGoalEventInput, { type: K }>['payload'],
  key: string,
  providerSequence: number,
  chunkIndex = 0
): DurableGoalEventInput {
  return {
    schemaVersion: 1, type, payload, idempotencyKey: key, ...fence,
    source: { ...source, providerSequence, chunkIndex },
  } as DurableGoalEventInput;
}

beforeEach(async () => {
  if (database) await database.destroy();
  database = openDatabase();
  await foundation(database);
  await durable(database);
  repository = new GoalRepository(database);
  const goal = await repository.createGoal({
    ownerUserId: 'owner-1', repository: 'integry/propr', objective: 'Durable replay',
    agent: 'codex', requestedModel: 'gpt-5.6-sol',
  });
  goalId = goal.goalId;
  const lease = await repository.claimLease(goalId, 'controller-1', 60_000);
  fence = { leaseOwner: 'controller-1', leaseEpoch: lease.epoch };
  await repository.upsertProviderSession(goalId, 'codex', {
    ...fence, turnId: 'turn-1', executionId: 'execution-1', attemptId: 'attempt-1',
  });
  const session = await repository.getProviderSession(goalId, 'codex');
  assert(session);
  source = {
    sessionId: session.session_id, turnId: 'turn-1', executionId: 'execution-1',
    attemptId: 'attempt-1', providerSequence: 0, chunkIndex: 0,
    leaseGeneration: fence.leaseEpoch,
  };
});

after(async () => {
  if (database) await database.destroy();
});

describe('durable goal events and messages', () => {
  test('deduplicates normalized source occurrences and replays opaque exclusive cursors', async () => {
    const firstInput = event('provider.output', {
      stream: 'stdout', outputType: 'text', chunk: 'first',
    }, 'output-1', 1);
    const first = await repository.appendTypedEvent(goalId, firstInput);
    const replay = await repository.appendTypedEvent(goalId, firstInput);
    assert.equal(replay.sequence, first.sequence);
    await repository.appendTypedEvent(goalId, event('provider.output', {
      stream: 'stderr', outputType: 'text', chunk: 'second',
    }, 'output-2', 2));

    const page1 = await repository.readEventPage(goalId, { limit: 1 });
    assert.deepEqual(page1.events.map(item => item.sequence), [1]);
    assert(page1.nextCursor);
    const page2 = await repository.readEventPage(goalId, { cursor: page1.nextCursor, limit: 10 });
    assert.deepEqual(page2.events.map(item => item.sequence), [2]);
    await assert.rejects(
      repository.readEventPage(goalId, { cursor: page1.nextCursor, kind: 'output' }),
      (error: GoalError) => error.code === 'goal_invalid_cursor'
    );
  });

  test('rejects stale and malformed events without consuming a sequence', async () => {
    await assert.rejects(
      repository.appendTypedEvent(goalId, {
        ...event('provider.output', { stream: 'stdout', outputType: 'text', chunk: 'bad' }, 'bad-kind', 1),
        type: 'provider.unknown',
      }),
      (error: GoalError) => error.code === 'goal_invalid_event_kind'
    );
    assert.equal(await repository.getLatestSequence(goalId), 0);
    assert.equal(Number((await database('goal_event_quarantine').count({ count: '*' }).first())?.count), 1);
    await assert.rejects(
      repository.appendTypedEvent(goalId, {
        ...event('provider.output', { stream: 'stdout', outputType: 'text', chunk: 'stale' }, 'stale', 2),
        source: { ...source, leaseGeneration: source.leaseGeneration + 1 },
      }),
      (error: GoalError) => error.code === 'goal_stale_lease'
    );
    assert.equal(await repository.getLatestSequence(goalId), 0);
  });

  test('commits FIFO message states and matching audit events atomically', async () => {
    const message = await repository.enqueueMessage(goalId, {
      body: '', cannedAction: 'whats_left', authorUserId: 'owner-1', idempotencyKey: 'message-1',
    });
    assert.equal(message.body, "What's left?");
    assert.equal(message.enqueueEventSequence, 1);
    const claimed = await repository.claimNextMessage(goalId, {
      ...fence, sessionId: source.sessionId, turnId: source.turnId, deliveryKey: 'delivery-1',
    });
    assert.equal(claimed?.state, 'delivering');
    await repository.markMessageDelivered(goalId, message.messageId, fence);
    await repository.markMessageAcknowledged(goalId, message.messageId, fence);
    assert.deepEqual(
      (await repository.readEvents(goalId)).events.map(item => item.eventType),
      ['message.enqueued', 'message.claimed', 'message.delivered', 'message.acknowledged']
    );
  });

  test('deduplicates usage and preserves aggregates across output compaction', async () => {
    const usage = event('usage.reported', {
      provider: 'openai', model: 'gpt-5.6-sol', occurrenceId: 'usage-1',
      inputTokens: 100, outputTokens: 20, cacheReadTokens: 30,
      cacheWriteTokens: 5, reasoningTokens: 7,
    }, 'usage-1', 1);
    await repository.appendTypedEvent(goalId, usage);
    await repository.appendTypedEvent(goalId, usage);
    await repository.appendTypedEvent(goalId, event('provider.output', {
      stream: 'stdout', outputType: 'text', chunk: 'compact me',
    }, 'output-after-usage', 2));
    const cursor = (await repository.readEventPage(goalId, { limit: 1 })).lastCursor;
    assert(cursor);
    const stats = await repository.getStatistics(goalId);
    assert.equal(stats.tokens.input, 100);
    assert.equal(stats.tokens.output, 20);
    await repository.compactOutput(goalId, 2, fence);
    assert.equal((await repository.getStatistics(goalId)).tokens.input, 100);
    await assert.rejects(
      repository.readEventPage(goalId, { cursor }),
      (error: GoalError) => error.code === 'goal_cursor_expired' && error.status === 410
    );
    assert.deepEqual((await repository.readEventPage(goalId)).events, []);
  });

  test('bounds detail checklists and exposes a canonical continuation cursor', async () => {
    const now = '2026-09-01T23:00:00.000Z';
    await database('goal_nodes').insert(Array.from({ length: 205 }, (_, index) => ({
      node_id: `node-${String(index).padStart(3, '0')}`,
      requested_node_id: null,
      goal_id: goalId,
      parent_node_id: null,
      kind: 'implementation_issue',
      idempotency_key: `node-key-${index}`,
      external_ref: String(index + 1),
      external_kind: 'issue',
      title: `Issue ${index + 1}`,
      status: 'pending',
      attempt_count: 0,
      order_index: index,
      created_at: now,
      updated_at: now,
    })));
    const detail = await new GoalLifecycleService(repository).getDetail(goalId);
    assert.equal(detail.nodes.length, 200);
    assert.equal(detail.summary.nodeCount, 205);
    assert(detail.checklistNextCursor);
    const rest = await repository.readNodePage(goalId, { cursor: detail.checklistNextCursor });
    assert.equal(rest.nodes.length, 5);
    assert.equal(rest.nextCursor, null);
  });
});
