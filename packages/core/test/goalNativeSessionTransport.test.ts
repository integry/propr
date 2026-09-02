import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import knex, { type Knex } from 'knex';
import type { BetterSqliteConnection } from '../src/db/connection.js';
import { up as foundation } from '../src/db/migrations/20260831000000_create_goal_control_plane.js';
import { up as durable } from '../src/db/migrations/20260901000000_add_durable_goal_replay.js';
import {
  GoalNativeSessionTransport,
  GoalRepository,
  type NativeGoalAttempt,
  type NativeGoalSupervisor,
} from '../src/services/goals/index.js';

function openDatabase(filename: string): Knex {
  return knex({
    client: 'better-sqlite3', connection: { filename }, useNullAsDefault: true,
    pool: { afterCreate(connection: BetterSqliteConnection, done: (error: Error | null, value: BetterSqliteConnection) => void) {
      connection.pragma('foreign_keys = ON');
      connection.pragma('journal_mode = WAL');
      connection.pragma('busy_timeout = 5000');
      done(null, connection);
    } },
  });
}

class IdempotentNativeSupervisor implements NativeGoalSupervisor {
  readonly accepted = new Map<string, string>();
  effects = 0;
  lastInputSequence = 0;

  async get(): Promise<{ lastInputSequence: number }> {
    return { lastInputSequence: this.lastInputSequence };
  }

  async steer(goalId: string, input: { sequence: number; text: string }): Promise<void> {
    const providerIdempotencyKey = `${goalId}:steer:${input.sequence}`;
    const existing = this.accepted.get(providerIdempotencyKey);
    if (existing !== undefined) {
      assert.equal(existing, input.text);
      return;
    }
    assert.equal(input.sequence, this.lastInputSequence + 1);
    this.accepted.set(providerIdempotencyKey, input.text);
    this.lastInputSequence = input.sequence;
    this.effects += 1;
  }
}

test('native-goal transport resumes the same session and reconciles provider-accepted FIFO input', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'propr-native-goal-'));
  const filename = path.join(directory, 'goals.sqlite');
  let first: Knex | undefined;
  let second: Knex | undefined;
  let reopened: Knex | undefined;
  try {
    first = openDatabase(filename);
    await foundation(first);
    await durable(first);
    const firstRepository = new GoalRepository(first);
    const goal = await firstRepository.createGoal({
      ownerUserId: 'owner', repository: 'integry/propr', objective: 'Use native /goal',
      agent: 'codex', requestedModel: 'gpt-5.6-sol',
    });
    const lease = await firstRepository.claimLease(goal.goalId, 'supervisor-1', 60_000);
    const attempt: NativeGoalAttempt = {
      goalId: goal.goalId, agent: 'codex', providerThreadId: 'codex-thread-1',
      runtimeId: 'container-1', worktreeId: 'worktree-1', effectiveModel: 'gpt-5.6-sol',
      controllerId: 'supervisor-1', leaseEpoch: lease.epoch,
      turnId: 'turn-1', executionId: 'execution-1', attemptId: 'attempt-1',
    };
    const transport = new GoalNativeSessionTransport(firstRepository);
    const attached = await transport.attach(attempt);
    await transport.ingest(attempt, {
      type: 'provider.plan', providerSequence: 1, chunkIndex: 0, idempotencyKey: 'native-plan-1',
      payload: { items: [{ id: 'step-1', text: 'Let the coding agent plan', status: 'in_progress' }] },
    });
    await transport.ingest(attempt, {
      type: 'provider.output', providerSequence: 2, chunkIndex: 0, idempotencyKey: 'native-output-1',
      payload: { stream: 'stdout', outputType: 'text', chunk: 'working' },
    });
    const firstMessage = await firstRepository.enqueueMessage(goal.goalId, {
      body: '', cannedAction: 'whats_done', authorUserId: 'owner', idempotencyKey: 'message-1',
    });
    await firstRepository.enqueueMessage(goal.goalId, {
      body: 'Please preserve the thin design', authorUserId: 'owner', idempotencyKey: 'message-2',
    });

    const provider = new IdempotentNativeSupervisor();
    const acceptedWithoutLocalAck = await transport.claimNext(attempt, 1);
    assert(acceptedWithoutLocalAck);
    await provider.steer(goal.goalId, {
      sequence: acceptedWithoutLocalAck.fence.providerSequence,
      text: acceptedWithoutLocalAck.message.body,
    });
    assert.equal(provider.effects, 1);
    assert.equal((await firstRepository.getMessages(goal.goalId))[0].state, 'delivering');

    await first('goals').where('goal_id', goal.goalId).update({ lease_expires_at: '2000-01-01T00:00:00.000Z' });
    second = openDatabase(filename);
    const secondRepository = new GoalRepository(second);
    const replacementLease = await secondRepository.claimLease(goal.goalId, 'supervisor-2', 60_000);
    const replacement: NativeGoalAttempt = {
      ...attempt, runtimeId: 'container-2', controllerId: 'supervisor-2',
      leaseEpoch: replacementLease.epoch, turnId: 'turn-2', executionId: 'execution-2', attemptId: 'attempt-2',
    };
    const resumed = new GoalNativeSessionTransport(secondRepository);
    const resumedSession = await resumed.attach(replacement);
    assert.equal(resumedSession.session_id, attached.session_id);
    assert.equal(resumedSession.provider_thread_id, attempt.providerThreadId);

    const reconciled = await resumed.deliverNextToSupervisor(replacement, 2, provider);
    assert.equal(reconciled?.messageId, firstMessage.messageId);
    assert.equal(reconciled?.state, 'acknowledged');
    assert.equal(provider.effects, 1, 'provider idempotency prevented a duplicate steering effect');
    const secondDelivery = await resumed.deliverNextToSupervisor(replacement, 2, provider);
    assert.equal(secondDelivery?.state, 'acknowledged');
    assert.equal(provider.effects, 2);

    const checklist = await secondRepository.readProviderChecklistPage(goal.goalId);
    assert.deepEqual(checklist.items.map(item => item.text), ['Let the coding agent plan']);
    const beforeCompaction = await resumed.replay(goal.goalId);
    assert.deepEqual(beforeCompaction.events.slice(0, 2).map(event => event.eventType), [
      'provider.plan', 'provider.output',
    ]);
    await resumed.compact(replacement, beforeCompaction.asOfSequence);

    await first.destroy();
    first = undefined;
    await second.destroy();
    second = undefined;
    reopened = openDatabase(filename);
    const afterRestart = await new GoalNativeSessionTransport(new GoalRepository(reopened)).replay(goal.goalId);
    assert.equal(afterRestart.events.find(event => event.sequence === 2)?.eventType, 'provider.output_compacted');
    assert.deepEqual(
      (await new GoalRepository(reopened).getMessages(goal.goalId)).map(message => message.state),
      ['acknowledged', 'acknowledged']
    );
  } finally {
    await first?.destroy();
    await second?.destroy();
    await reopened?.destroy();
    await fs.rm(directory, { recursive: true, force: true });
  }
});
