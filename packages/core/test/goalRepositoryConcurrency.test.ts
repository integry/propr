import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import knex, { type Knex } from 'knex';
import type { BetterSqliteConnection } from '../src/db/connection.js';
import { up } from '../src/db/migrations/20260831000000_create_goal_control_plane.js';
import { GoalError, GoalRepository } from '../src/services/goals/goalRepository.js';
import { GoalLifecycleService } from '../src/services/goals/goalLifecycleService.js';

let directory: string;
let firstDb: Knex;
let secondDb: Knex;
let first: GoalRepository;
let second: GoalRepository;

function openDatabase(filename: string): Knex {
  return knex({
    client: 'better-sqlite3',
    connection: { filename },
    useNullAsDefault: true,
    pool: {
      min: 1,
      max: 1,
      afterCreate(
        connection: BetterSqliteConnection,
        done: (error: Error | null, connection: BetterSqliteConnection) => void
      ) {
        connection.pragma('journal_mode = WAL');
        connection.pragma('foreign_keys = ON');
        connection.pragma('busy_timeout = 25');
        done(null, connection);
      },
    },
  });
}

async function createGoal(key: string, objective = 'Concurrent objective') {
  return first.createGoal({
    ownerUserId: 'owner', repository: 'octo/repo', objective,
    agent: 'claude', requestedModel: 'claude-opus-4-8', idempotencyKey: key,
  });
}

before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'propr-goal-wal-'));
  const filename = join(directory, 'goals.sqlite');
  firstDb = openDatabase(filename);
  await up(firstDb);
  secondDb = openDatabase(filename);
  await secondDb.raw('SELECT 1');
  first = new GoalRepository(firstDb);
  second = new GoalRepository(secondDb);
});

after(async () => {
  await Promise.all([firstDb.destroy(), secondDb.destroy()]);
  await rm(directory, { recursive: true, force: true });
});

describe('GoalRepository WAL contention', () => {
  test('two independent connections replay one idempotent create response', async () => {
    const input = {
      ownerUserId: 'owner', repository: 'octo/repo', objective: 'same create',
      agent: 'claude', requestedModel: 'claude-opus-4-8', idempotencyKey: 'wal-create',
    };
    const [left, right] = await Promise.all([first.createGoal(input), second.createGoal(input)]);
    assert.deepEqual(right, left);
    assert.equal(Number((await firstDb('goals').where('objective', 'same create').count({ count: '*' }).first())?.count), 1);
  });

  test('same-key different-payload create contention returns a stable conflict', async () => {
    const base = {
      ownerUserId: 'owner', repository: 'octo/repo', agent: 'claude',
      requestedModel: 'claude-opus-4-8', idempotencyKey: 'wal-create-conflict',
    };
    const results = await Promise.allSettled([
      first.createGoal({ ...base, objective: 'left payload' }),
      second.createGoal({ ...base, objective: 'right payload' }),
    ]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    const rejected = results.find(result => result.status === 'rejected') as PromiseRejectedResult;
    assert.ok(rejected.reason instanceof GoalError);
    assert.equal(rejected.reason.code, 'goal_idempotency_conflict');
  });

  test('two connections replay one operator transition and one audit effect', async () => {
    const goal = await createGoal('operator-retry-goal');
    const left = new GoalLifecycleService(first);
    const right = new GoalLifecycleService(second);
    const options = { idempotencyKey: 'wal-pause', reason: 'operator' };
    const [one, two] = await Promise.all([
      left.pause(goal.goalId, options),
      right.pause(goal.goalId, options),
    ]);
    assert.deepEqual(two, one);
    assert.equal((await firstDb('goal_state_transitions').where('goal_id', goal.goalId)).length, 1);
  });

  test('concurrent ordered events replay winners and allocate unique sequences', async () => {
    const goal = await createGoal('event-goal');
    const lease = await first.claimLease(goal.goalId, 'controller', 60_000);
    const event = {
      kind: 'output' as const, eventType: 'line', payload: { line: 1 },
      idempotencyKey: 'same-event', leaseOwner: 'controller', leaseEpoch: lease.epoch,
    };
    const [left, right] = await Promise.all([
      first.appendEvent(goal.goalId, event),
      second.appendEvent(goal.goalId, event),
    ]);
    assert.deepEqual(right, left);
    const allocated = await Promise.all([
      first.appendEvent(goal.goalId, { ...event, payload: { line: 2 }, idempotencyKey: 'event-2' }),
      second.appendEvent(goal.goalId, { ...event, payload: { line: 3 }, idempotencyKey: 'event-3' }),
    ]);
    assert.deepEqual(allocated.map(item => item.sequence).sort((a, b) => a - b), [2, 3]);
    await assert.rejects(
      second.appendEvent(goal.goalId, { ...event, payload: { line: 99 } }),
      (error: GoalError) => error.code === 'goal_idempotency_conflict'
    );
    const conflictResults = await Promise.allSettled([
      first.appendEvent(goal.goalId, { ...event, payload: { value: 'left' }, idempotencyKey: 'event-race-conflict' }),
      second.appendEvent(goal.goalId, { ...event, payload: { value: 'right' }, idempotencyKey: 'event-race-conflict' }),
    ]);
    assert.equal(conflictResults.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal((conflictResults.find(result => result.status === 'rejected') as PromiseRejectedResult).reason.code, 'goal_idempotency_conflict');
  });

  test('concurrent message enqueue and delivery preserve FIFO and stable repeats', async () => {
    const goal = await createGoal('message-goal');
    const same = { body: 'same', idempotencyKey: 'same-message' };
    const [left, right] = await Promise.all([
      first.enqueueMessage(goal.goalId, same),
      second.enqueueMessage(goal.goalId, same),
    ]);
    assert.deepEqual(right, left);
    const [next, last] = await Promise.all([
      first.enqueueMessage(goal.goalId, { body: 'next', idempotencyKey: 'next-message' }),
      second.enqueueMessage(goal.goalId, { body: 'last', idempotencyKey: 'last-message' }),
    ]);
    assert.deepEqual([next.sequence, last.sequence].sort((a, b) => a - b), [2, 3]);
    const lease = await first.claimLease(goal.goalId, 'message-controller', 60_000);
    const fence = { leaseOwner: 'message-controller', leaseEpoch: lease.epoch };
    await Promise.all([
      first.markMessageDelivered(goal.goalId, left.messageId, fence),
      second.markMessageDelivered(goal.goalId, left.messageId, fence),
    ]);
    const delivered = (await first.getMessages(goal.goalId))[0];
    assert.equal(delivered.state, 'delivered');
    assert.equal(delivered.deliveryAttempts, 1);
    const conflicts = await Promise.allSettled([
      first.enqueueMessage(goal.goalId, { body: 'left conflict', idempotencyKey: 'message-race-conflict' }),
      second.enqueueMessage(goal.goalId, { body: 'right conflict', idempotencyKey: 'message-race-conflict' }),
    ]);
    assert.equal(conflicts.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal((conflicts.find(result => result.status === 'rejected') as PromiseRejectedResult).reason.code, 'goal_idempotency_conflict');
  });

  test('message transitions reject queued acknowledgement and acknowledged redelivery', async () => {
    const goal = await createGoal('message-state-goal');
    const message = await first.enqueueMessage(goal.goalId, { body: 'stateful', idempotencyKey: 'state-message' });
    const lease = await first.claimLease(goal.goalId, 'state-controller', 60_000);
    const fence = { leaseOwner: 'state-controller', leaseEpoch: lease.epoch };
    await assert.rejects(
      first.markMessageAcknowledged(goal.goalId, message.messageId, fence),
      (error: GoalError) => error.code === 'goal_message_order_conflict'
    );
    await first.markMessageDelivered(goal.goalId, message.messageId, fence);
    await first.markMessageDelivered(goal.goalId, message.messageId, fence);
    await first.markMessageAcknowledged(goal.goalId, message.messageId, fence);
    await first.markMessageAcknowledged(goal.goalId, message.messageId, fence);
    await assert.rejects(
      first.markMessageDelivered(goal.goalId, message.messageId, fence),
      (error: GoalError) => error.code === 'goal_message_order_conflict'
    );
  });

  test('expired fences cannot write or renew and takeover advances the epoch', async () => {
    const goal = await createGoal('expired-goal');
    const lease = await first.claimLease(goal.goalId, 'old-controller', 60_000);
    await firstDb('goals').where('goal_id', goal.goalId).update({ lease_expires_at: '2000-01-01T00:00:00.000Z' });
    const staleFence = { leaseOwner: 'old-controller', leaseEpoch: lease.epoch };
    await assert.rejects(
      first.appendEvent(goal.goalId, { kind: 'domain', eventType: 'expired', idempotencyKey: 'expired-event', ...staleFence }),
      (error: GoalError) => error.code === 'goal_stale_lease'
    );
    await assert.rejects(
      first.renewLease(goal.goalId, 'old-controller', lease.epoch, 1000),
      (error: GoalError) => error.code === 'goal_stale_lease'
    );
    const takeover = await second.claimLease(goal.goalId, 'new-controller', 60_000);
    assert.equal(takeover.epoch, lease.epoch + 1);
    await assert.rejects(
      first.upsertProviderSession(goal.goalId, 'claude', { ...staleFence, runtimeId: 'stale' }),
      (error: GoalError) => error.code === 'goal_stale_lease'
    );
    await assert.rejects(
      first.markMessageDelivered(
        goal.goalId,
        (await first.enqueueMessage(goal.goalId, { body: 'expired', idempotencyKey: 'expired-message' })).messageId,
        staleFence
      ),
      (error: GoalError) => error.code === 'goal_stale_lease'
    );
    await assert.rejects(
      first.transition(goal.goalId, { toState: 'running', idempotencyKey: 'stale-transition', ...staleFence }),
      (error: GoalError) => error.code === 'goal_stale_lease'
    );
  });

  test('restart cleanup preserves undefined provider fields and clears explicit nulls under the new fence', async () => {
    const goal = await createGoal('provider-restart-cleanup-goal');
    const original = await first.claimLease(goal.goalId, 'crashed-controller', 60_000);
    const staleFence = { leaseOwner: 'crashed-controller', leaseEpoch: original.epoch };
    await first.upsertProviderSession(goal.goalId, 'claude', {
      ...staleFence,
      providerThreadId: 'thread-before-crash', runtimeId: 'runtime-before-crash',
      worktreeId: 'worktree-before-crash', lastCheckpoint: 'checkpoint-before-crash',
    });
    await firstDb('goals').where('goal_id', goal.goalId)
      .update({ lease_expires_at: '2000-01-01T00:00:00.000Z' });
    const restarted = await second.claimLease(goal.goalId, 'restarted-controller', 60_000);
    const restartedFence = { leaseOwner: 'restarted-controller', leaseEpoch: restarted.epoch };

    await assert.rejects(
      first.upsertProviderSession(goal.goalId, 'claude', {
        ...staleFence, providerThreadId: null, runtimeId: null,
        worktreeId: null, lastCheckpoint: null,
      }),
      (error: GoalError) => error.code === 'goal_stale_lease'
    );
    await second.upsertProviderSession(goal.goalId, 'claude', {
      ...restartedFence,
      runtimeId: null, worktreeId: null, lastCheckpoint: null,
    });
    let session = await second.getProviderSession(goal.goalId, 'claude');
    assert.equal(session?.provider_thread_id, 'thread-before-crash');
    assert.equal(session?.runtime_id, null);
    assert.equal(session?.worktree_id, null);
    assert.equal(session?.last_checkpoint, null);

    await second.upsertProviderSession(goal.goalId, 'claude', {
      ...restartedFence, providerThreadId: null,
    });
    session = await second.getProviderSession(goal.goalId, 'claude');
    assert.equal(session?.provider_thread_id, null);
  });

  test('renew rejects invalid TTLs and non-current owner or epoch', async () => {
    const goal = await createGoal('renew-goal');
    const lease = await first.claimLease(goal.goalId, 'renew-controller', 60_000);
    for (const ttl of [0, -1, Number.NaN, Number.MAX_SAFE_INTEGER, 86_400_001, 1.5]) {
      await assert.rejects(
        first.renewLease(goal.goalId, 'renew-controller', lease.epoch, ttl),
        (error: GoalError) => error.code === 'goal_validation_error'
      );
    }
    for (const [owner, epoch] of [['wrong', lease.epoch], ['renew-controller', lease.epoch - 1], ['renew-controller', lease.epoch + 1]] as const) {
      await assert.rejects(
        first.renewLease(goal.goalId, owner, epoch, 1000),
        (error: GoalError) => error.code === 'goal_stale_lease'
      );
    }
    await assert.rejects(
      first.renewLease(goal.goalId, null as unknown as string, lease.epoch, 1000),
      (error: GoalError) => error.code === 'goal_validation_error'
    );
  });

  test('separate-connection lease contention has one stable winner', async () => {
    const goal = await createGoal('lease-contention-goal');
    const results = await Promise.allSettled([
      first.claimLease(goal.goalId, 'left-controller', 60_000),
      second.claimLease(goal.goalId, 'right-controller', 60_000),
    ]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    const rejected = results.find(result => result.status === 'rejected') as PromiseRejectedResult;
    assert.equal((rejected.reason as GoalError).code, 'goal_lease_conflict');
  });

  test('confirmPaused replays its original controller outcome', async () => {
    const goal = await createGoal('confirm-paused-goal');
    const lifecycle = new GoalLifecycleService(first);
    await lifecycle.pause(goal.goalId, { idempotencyKey: 'pause-confirm-intent' });
    const lease = await first.claimLease(goal.goalId, 'pause-controller', 60_000);
    const options = {
      leaseOwner: 'pause-controller', leaseEpoch: lease.epoch,
      idempotencyKey: 'confirm-paused-key', reason: 'drained',
    };
    const committed = await lifecycle.confirmPaused(goal.goalId, options);
    const replay = await lifecycle.confirmPaused(goal.goalId, options);
    assert.deepEqual(replay, committed);
    assert.equal((await firstDb('goal_state_transitions').where({ goal_id: goal.goalId, to_state: 'paused' })).length, 1);
  });

  test('node retries audit every semantically relevant field', async () => {
    const goal = await createGoal('node-audit-goal');
    const lease = await first.claimLease(goal.goalId, 'node-controller', 60_000);
    const base = {
      nodeId: 'requested-node', kind: 'implementation_issue' as const,
      externalRef: '42', externalKind: 'issue', title: 'Node',
      status: 'pending' as const, orderIndex: 3, idempotencyKey: 'node-key',
      leaseOwner: 'node-controller', leaseEpoch: lease.epoch,
    };
    await first.addNode(goal.goalId, base);
    for (const changed of [
      { externalRef: '43' }, { externalKind: 'pull_request' },
      { status: 'in_progress' as const }, { orderIndex: 4 },
      { nodeId: 'other-node' }, { nodeId: undefined },
    ]) {
      await assert.rejects(
        first.addNode(goal.goalId, { ...base, ...changed }),
        (error: GoalError) => error.code === 'goal_idempotency_conflict'
      );
    }

    const generated = { ...base, nodeId: undefined, idempotencyKey: 'generated-node-key' };
    const created = await first.addNode(goal.goalId, generated);
    await assert.rejects(
      first.addNode(goal.goalId, { ...generated, nodeId: created.nodeId }),
      (error: GoalError) => error.code === 'goal_idempotency_conflict'
    );
  });

  test('model application audits only the deterministic current request', async () => {
    const goal = await createGoal('model-audit-goal');
    await first.requestModelChange(goal.goalId, 'model-a', { idempotencyKey: 'model-a-key' });
    await first.requestModelChange(goal.goalId, 'model-b', { idempotencyKey: 'model-b-key' });
    const lease = await first.claimLease(goal.goalId, 'model-controller', 60_000);
    const applied = await first.applyModelChange(goal.goalId, { leaseOwner: 'model-controller', leaseEpoch: lease.epoch });
    assert.equal(applied.effectiveModel, 'model-b');
    const audits = await firstDb('goal_model_transitions').where('goal_id', goal.goalId).orderBy('id');
    assert.deepEqual(audits.map(row => ({ requested: row.requested_model, applied: row.applied })), [
      { requested: 'model-a', applied: 0 },
      { requested: 'model-b', applied: 1 },
    ]);
  });

  test('model application audits a current no-op without applying superseded requests', async () => {
    const goal = await createGoal('model-no-op-audit-goal');
    await first.requestModelChange(goal.goalId, 'model-a', { idempotencyKey: 'no-op-model-a' });
    await first.requestModelChange(goal.goalId, goal.effectiveModel, { idempotencyKey: 'no-op-current-model' });
    const lease = await first.claimLease(goal.goalId, 'no-op-model-controller', 60_000);
    const fence = { leaseOwner: 'no-op-model-controller', leaseEpoch: lease.epoch };
    const applied = await first.applyModelChange(goal.goalId, fence);
    assert.equal(applied.effectiveModel, goal.effectiveModel);
    await first.applyModelChange(goal.goalId, fence);
    const audits = await firstDb('goal_model_transitions').where('goal_id', goal.goalId).orderBy('id');
    assert.deepEqual(audits.map(row => ({ requested: row.requested_model, applied: row.applied })), [
      { requested: 'model-a', applied: 0 },
      { requested: goal.effectiveModel, applied: 1 },
    ]);
  });

  test('cancel fences model application, permits release, and prevents terminal reclaim', async () => {
    const goal = await createGoal('cancel-model-race-goal');
    await first.requestModelChange(goal.goalId, 'model-after-cancel', {
      idempotencyKey: 'cancel-model-request',
    });
    const lease = await first.claimLease(goal.goalId, 'terminal-controller', 60_000);
    const fence = { leaseOwner: 'terminal-controller', leaseEpoch: lease.epoch };
    const lifecycle = new GoalLifecycleService(second);
    const [cancelOutcome, applyOutcome] = await Promise.allSettled([
      lifecycle.cancel(goal.goalId, { idempotencyKey: 'cancel-wins-model-race' }),
      first.applyModelChange(goal.goalId, fence),
    ]);
    if (cancelOutcome.status !== 'fulfilled') throw cancelOutcome.reason;
    const cancelling = cancelOutcome.value;
    const immediatelyAfterRace = await first.requireGoal(goal.goalId);
    assert.ok(immediatelyAfterRace.version >= cancelling.version);
    if (applyOutcome.status === 'rejected') {
      assert.equal((applyOutcome.reason as GoalError).code, 'goal_terminal_state');
    }
    const terminal = await first.transition(goal.goalId, {
      toState: 'cancelled', terminalReason: 'user_cancelled', ...fence,
    });
    const statsAtTerminal = await first.getActiveTimeStats(goal.goalId);

    await assert.rejects(
      first.applyModelChange(goal.goalId, fence),
      (error: GoalError) => error.code === 'goal_terminal_state'
    );
    await assert.rejects(
      second.claimLease(goal.goalId, 'terminal-reclaimer-before-release', 60_000),
      (error: GoalError) => error.code === 'goal_terminal_state'
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    await first.releaseLease(goal.goalId, fence.leaseOwner, fence.leaseEpoch);
    await assert.rejects(
      second.claimLease(goal.goalId, 'terminal-reclaimer-after-release', 60_000),
      (error: GoalError) => error.code === 'goal_terminal_state'
    );

    const reopened = await new GoalLifecycleService(second).getDetail(goal.goalId);
    assert.equal(reopened.goal.state, 'cancelled');
    assert.equal(reopened.goal.version, terminal.version);
    assert.equal(reopened.goal.requestedModel, 'model-after-cancel');
    assert.equal(reopened.goal.effectiveModel, terminal.effectiveModel);
    assert.deepEqual(reopened.stats, statsAtTerminal);
  });

  test('terminal elapsed and active time survive completion, release, and service reopen', async () => {
    const goal = await createGoal('completed-timing-goal');
    const lease = await first.claimLease(goal.goalId, 'completion-controller', 60_000);
    const fence = { leaseOwner: 'completion-controller', leaseEpoch: lease.epoch };
    await first.transition(goal.goalId, { toState: 'running', ...fence });
    await first.transition(goal.goalId, { toState: 'completing', ...fence });
    await first.transition(goal.goalId, {
      toState: 'completed', terminalReason: 'objective_met', ...fence,
    });
    const beforeRelease = await new GoalLifecycleService(first).getDetail(goal.goalId);

    await new Promise((resolve) => setTimeout(resolve, 5));
    await first.releaseLease(goal.goalId, fence.leaseOwner, fence.leaseEpoch);
    const afterReopen = await new GoalLifecycleService(second).getDetail(goal.goalId);
    assert.deepEqual(afterReopen.stats, beforeRelease.stats);
    assert.equal(afterReopen.goal.version, beforeRelease.goal.version);
    assert.equal(afterReopen.goal.effectiveModel, beforeRelease.goal.effectiveModel);
  });

  test('repository trust boundaries reject oversized objectives, bodies, reasons, IDs, and keys', async () => {
    await assert.rejects(
      first.createGoal({
        ownerUserId: 'owner', repository: 'octo/repo', objective: 'x'.repeat(4001),
        agent: 'claude', requestedModel: 'model', idempotencyKey: 'bounded-objective',
      }),
      (error: GoalError) => error.code === 'goal_validation_error'
    );
    await assert.rejects(
      first.createGoal({
        ownerUserId: 'owner', repository: 'octo/repo', objective: 'valid',
        agent: 'claude', requestedModel: 'model', idempotencyKey: 'x'.repeat(256),
      }),
      (error: GoalError) => error.code === 'goal_invalid_idempotency_key'
    );
    const goal = await createGoal('boundary-goal');
    await assert.rejects(
      first.enqueueMessage(goal.goalId, { body: 'x'.repeat(4001), idempotencyKey: 'bounded-message' }),
      (error: GoalError) => error.code === 'goal_validation_error'
    );
    await assert.rejects(
      first.requestModelChange(goal.goalId, 'x'.repeat(256), { idempotencyKey: 'bounded-model' }),
      (error: GoalError) => error.code === 'goal_validation_error'
    );
    await assert.rejects(
      first.requestPause(goal.goalId, {
        reason: 'x'.repeat(1001), idempotencyKey: 'bounded-reason',
      }),
      (error: GoalError) => error.code === 'goal_validation_error'
    );
  });
});
