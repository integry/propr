import assert from 'node:assert/strict';
import { after, beforeEach, describe, test } from 'node:test';
import knex, { type Knex } from 'knex';
import type { BetterSqliteConnection } from '../src/db/connection.js';
import { up as foundation } from '../src/db/migrations/20260831000000_create_goal_control_plane.js';
import { up as durable } from '../src/db/migrations/20260901000000_add_durable_goal_replay.js';
import { up as hardenDurable } from '../src/db/migrations/20260901010000_harden_durable_goal_replay.js';
import { GoalError, GoalRepository } from '../src/services/goals/goalRepository.js';
import { GoalLifecycleService } from '../src/services/goals/goalLifecycleService.js';
import type { DurableGoalEventInput } from '@propr/shared';

let database: Knex;
let repository: GoalRepository;
let goalId: string;
let fence: { leaseOwner: string; leaseEpoch: number };
let source: DurableGoalEventInput['source'];
let delivery: {
  messageId: string; sessionId: string; turnId: string; executionId: string;
  attemptId: string; controllerId: string; providerSequence: number; chunkIndex: number;
  deliveryKey: string; providerIdempotencyKey: string; leaseOwner: string; leaseEpoch: number;
};

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
  delivery = {
    messageId: '', sessionId: source.sessionId, turnId: source.turnId,
    executionId: source.executionId, attemptId: source.attemptId,
    controllerId: fence.leaseOwner, providerSequence: 1, chunkIndex: 0,
    deliveryKey: 'delivery-1', providerIdempotencyKey: 'provider-message-1', ...fence,
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
    delivery.messageId = message.messageId;
    assert.equal(message.body, 'Controller status queued: 0 authoritative checklist item(s) left; 0 active, 0 blocked, 0 failed.');
    assert.equal(message.enqueueEventSequence, 1);
    await assert.rejects(
      repository.claimNextMessage(goalId, { ...delivery, messageId: 'different-message' }),
      (error: GoalError) => error.code === 'goal_message_order_conflict'
    );
    const claimed = await repository.claimNextMessage(goalId, {
      ...delivery,
    });
    assert.equal(claimed?.state, 'delivering');
    const exactDelivery = { ...delivery };
    await repository.markMessageDelivered(goalId, message.messageId, exactDelivery);
    await repository.markMessageAcknowledged(goalId, message.messageId, exactDelivery);
    assert.deepEqual(
      (await repository.readEvents(goalId)).events.map(item => item.eventType),
      ['message.enqueued', 'message.claimed', 'message.delivered', 'message.acknowledged']
    );
    const second = await repository.enqueueMessage(goalId, {
      body: 'second', authorUserId: 'owner-1', idempotencyKey: 'message-2',
    });
    await assert.rejects(
      repository.claimNextMessage(goalId, {
        ...delivery, messageId: second.messageId, deliveryKey: 'delivery-2',
      }),
      (error: GoalError) => error.code === 'goal_message_order_conflict'
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
    await repository.compactOutput(goalId, 1, fence);
    await repository.compactOutput(goalId, 2, fence);
    assert.equal((await repository.getStatistics(goalId)).tokens.input, 100);
    const replay = await repository.readEventPage(goalId, { cursor });
    assert.deepEqual(replay.events.map(item => item.eventType), ['provider.output_compacted']);
    assert.deepEqual(
      (await repository.readEventPage(goalId)).events.map(item => item.sequence),
      [1, 2]
    );
  });

  test('reports an explicit oversized-page error without consuming its cursor', async () => {
    const large = 'x'.repeat(60 * 1024);
    await repository.appendTypedEvent(goalId, event('provider.output', {
      stream: 'stdout', outputType: 'text', chunk: large,
    }, 'large-output', 1));
    await assert.rejects(
      repository.readEventPage(goalId, { maxBytes: 1024 }),
      (error: GoalError) => error.code === 'goal_replay_item_too_large' && error.status === 413
    );
    const page = await repository.readEventPage(goalId, { maxBytes: 128 * 1024 });
    assert.equal(page.events.length, 1);
    assert.equal((page.events[0].payload as { chunk: string }).chunk.length, large.length);
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

  test('separates provider todos from controller checklist and derives canned status', async () => {
    await repository.addNode(goalId, {
      kind: 'implementation_issue', status: 'completed', idempotencyKey: 'done-node', ...fence,
    });
    await repository.addNode(goalId, {
      kind: 'implementation_issue', status: 'pending', idempotencyKey: 'left-node', ...fence,
    });
    await repository.appendTypedEvent(goalId, event('provider.todo', {
      items: [{ id: 'advice-1', text: 'Provider suggestion', status: 'pending' }],
    }, 'provider-todos', 20));
    const status = await repository.enqueueMessage(goalId, {
      body: '', cannedAction: 'whats_left', authorUserId: 'owner-1', idempotencyKey: 'status-left',
    });
    assert.match(status.body, /1 authoritative checklist item\(s\) left/);
    await assert.rejects(
      repository.enqueueMessage(goalId, {
        body: 'arbitrary override', cannedAction: 'whats_left',
        authorUserId: 'owner-1', idempotencyKey: 'status-conflict',
      }),
      (error: GoalError) => error.code === 'goal_validation_error'
    );
    const detail = await new GoalLifecycleService(repository).getDetail(goalId);
    assert.equal(detail.nodes.length, 2);
    assert.deepEqual(detail.providerAdvisoryTodos.map(todo => todo.todoId), ['advice-1']);
  });

  test('keeps cumulative usage monotonic and rejects occurrence relabeling', async () => {
    const usage = (occurrenceId: string, tokens: number, key: string, order: number, model = 'model-a') =>
      event('usage.reported', {
        provider: 'openai', model, occurrenceId, inputTokens: tokens, outputTokens: 0,
        cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, cumulative: true,
      }, key, order);
    await repository.appendTypedEvent(goalId, usage('newest', 100, 'usage-newest', 10));
    await repository.appendTypedEvent(goalId, usage('older', 80, 'usage-older', 5));
    await repository.appendTypedEvent(goalId, usage('next', 120, 'usage-next', 11));
    assert.equal((await repository.getStatistics(goalId)).tokens.input, 120);
    await assert.rejects(
      repository.appendTypedEvent(goalId, usage('next', 120, 'usage-relabeled', 12, 'model-b')),
      (error: GoalError) => error.code === 'goal_idempotency_conflict'
    );
    assert.equal((await repository.getStatistics(goalId)).tokens.input, 120);
  });

  test('retains failed-attempt and model usage for no-code work with recovery timing after reopen', async () => {
    await repository.appendTypedEvent(goalId, event('scheduler.node_changed', {
      nodeId: 'provider-attempt-1', status: 'failed', attemptId: 'attempt-1',
    }, 'attempt-1-failed', 30));
    await repository.appendTypedEvent(goalId, event('usage.reported', {
      provider: 'openai', model: 'model-a', occurrenceId: 'attempt-usage',
      inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0,
      reasoningTokens: 1,
    }, 'attempt-1-usage', 31));
    await repository.upsertProviderSession(goalId, 'codex', {
      ...fence, effectiveModel: 'model-b', turnId: 'turn-2',
      executionId: 'execution-2', attemptId: 'attempt-2',
    });
    source = {
      ...source, turnId: 'turn-2', executionId: 'execution-2', attemptId: 'attempt-2',
    };
    await repository.appendTypedEvent(goalId, event('usage.reported', {
      provider: 'openai', model: 'model-b', occurrenceId: 'attempt-usage',
      inputTokens: 20, outputTokens: 3, cacheReadTokens: 4, cacheWriteTokens: 0,
      reasoningTokens: 2,
    }, 'attempt-2-usage', 1));

    for (const state of ['planning', 'running', 'recovering', 'running', 'completing'] as const) {
      await repository.transition(goalId, { toState: state, ...fence });
    }
    await repository.transition(goalId, {
      toState: 'completed', terminalReason: 'objective_met', ...fence,
    });
    const base = Date.parse('2026-09-01T00:00:00.000Z');
    const transitions = await database('goal_state_transitions').where('goal_id', goalId).orderBy('id');
    await database('goals').where('goal_id', goalId).update({ created_at: new Date(base).toISOString() });
    for (const [index, transition] of transitions.entries()) {
      const offsets = [1_000, 2_000, 3_000, 7_000, 8_000, 9_000];
      await database('goal_state_transitions').where('id', transition.id)
        .update({ created_at: new Date(base + offsets[index]).toISOString() });
    }

    const stats = await new GoalRepository(database).getStatistics(goalId);
    assert.deepEqual({ input: stats.tokens.input, output: stats.tokens.output }, { input: 30, output: 5 });
    assert.deepEqual(stats.tokens.byProviderModel.map(row => row.model).sort(), ['model-a', 'model-b']);
    assert.equal(stats.issues.total, 0);
    assert.equal(stats.recoveryMs, 4_000);
    assert.equal(stats.elapsedMs, 9_000);
    assert.equal(stats.activeMs, 5_000);
  });

  test('atomically orders lifecycle evidence through terminal completion', async () => {
    await repository.transition(goalId, { toState: 'planning', ...fence });
    await repository.transition(goalId, { toState: 'running', ...fence });
    await repository.requestPause(goalId, { reason: 'operator_pause' });
    await repository.transition(goalId, { toState: 'paused', ...fence });
    await repository.requestResume(goalId, { reason: 'operator_resume' });
    await repository.requestCancel(goalId, { reason: 'operator_cancel' });
    const page = await repository.readEventPage(goalId);
    assert.equal(page.events.length, 6);
    assert.ok(page.events.every(item => item.eventType === 'lifecycle.state_changed'));
    assert.equal((page.events.at(-1)!.payload as { to: string }).to, 'cancelled');
    assert.equal((page.events.at(-1)!.payload as { terminalReason: string }).terminalReason, 'user_cancelled');
    assert.equal(page.asOfSequence, 6);
    const snapshots = await Promise.all(Array.from(
      { length: 12 }, () => new GoalLifecycleService(database).getDetail(goalId)
    ));
    for (const detail of snapshots) {
      assert.deepEqual([detail.asOfVersion, detail.goal.version], [7, 7]);
      assert.deepEqual([detail.asOfSequence, detail.summary.latestSequence], [6, 6]);
    }
  });

  test('takes over a crashed FIFO delivery only with stable provider identity', async () => {
    const message = await repository.enqueueMessage(goalId, {
      body: 'continue safely', authorUserId: 'owner-1', idempotencyKey: 'takeover-message',
    });
    delivery.messageId = message.messageId;
    await repository.claimNextMessage(goalId, delivery);
    await repository.markMessageDelivered(goalId, message.messageId, {
      ...delivery, messageId: message.messageId,
    });
    await database('goals').where('goal_id', goalId).update({ lease_expires_at: '2000-01-01T00:00:00.000Z' });
    const lease = await repository.claimLease(goalId, 'controller-2', 60_000);
    const nextFence = { leaseOwner: 'controller-2', leaseEpoch: lease.epoch };
    await repository.upsertProviderSession(goalId, 'codex', {
      ...nextFence, turnId: 'turn-2', executionId: 'execution-2', attemptId: 'attempt-2',
    });
    const next = {
      ...nextFence, messageId: message.messageId, sessionId: source.sessionId,
      turnId: 'turn-2', executionId: 'execution-2', attemptId: 'attempt-2',
      controllerId: 'controller-2', providerSequence: 2, chunkIndex: 0,
      deliveryKey: 'delivery-2', providerIdempotencyKey: delivery.providerIdempotencyKey,
    };
    const taken = await repository.claimNextMessage(goalId, next);
    assert.equal(taken?.messageId, message.messageId);
    assert.equal(taken?.deliveryAttempts, 1);
    await assert.rejects(
      repository.markMessageDelivered(goalId, message.messageId, { ...delivery, messageId: message.messageId }),
      (error: GoalError) => error.code === 'goal_stale_lease'
    );
    await repository.markMessageDelivered(goalId, message.messageId, next);
    await repository.markMessageAcknowledged(goalId, message.messageId, next);
  });
});

test('durable migration is retryable in both foundation merge orders', async () => {
  const leafFirst = openDatabase();
  await assert.rejects(durable(leafFirst), /requires the #2018/);
  await foundation(leafFirst);
  await hardenDurable(leafFirst);
  assert.equal(await leafFirst.schema.hasTable('goal_event_state'), true);
  await leafFirst.destroy();

  const foundationFirst = openDatabase();
  await foundation(foundationFirst);
  await durable(foundationFirst);
  await hardenDurable(foundationFirst);
  assert.equal(await foundationFirst.schema.hasColumn('goal_messages', 'claimed_attempt_id'), true);
  await foundationFirst.destroy();
});
