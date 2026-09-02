import assert from 'node:assert/strict';
import { after, beforeEach, describe, test } from 'node:test';
import knex, { type Knex } from 'knex';
import type { BetterSqliteConnection } from '../src/db/connection.js';
import { down, up } from '../src/db/migrations/20260831000000_create_goal_control_plane.js';
import { up as createNativeExecutions } from '../src/db/migrations/20260902000000_add_goal_native_executions.js';
import { GoalRepository, GoalError } from '../src/services/goals/goalRepository.js';
import { GoalLifecycleService } from '../src/services/goals/goalLifecycleService.js';
import { GoalLeaseRepository } from '../src/services/goals/goalLeaseRepository.js';

let database: Knex;
let repo: GoalRepository;

function createDatabase(): Knex {
  return knex({
    client: 'better-sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true,
    pool: {
      afterCreate(
        connection: BetterSqliteConnection,
        done: (error: Error | null, connection: BetterSqliteConnection) => void
      ) {
        connection.pragma('foreign_keys = ON');
        connection.pragma('recursive_triggers = ON');
        connection.pragma('busy_timeout = 1000');
        done(null, connection);
      },
    },
  });
}

async function seedGoal(overrides: Partial<Parameters<GoalRepository['createGoal']>[0]> = {}) {
  return repo.createGoal({
    ownerUserId: 'user-1',
    repository: 'octo/repo',
    objective: 'Ship the control plane',
    agent: 'claude',
    requestedModel: 'claude-opus-4-8',
    ...overrides,
  });
}

async function claimFence(goalId: string, owner = 'controller') {
  const lease = await repo.claimLease(goalId, owner, 60_000);
  return { leaseOwner: owner, leaseEpoch: lease.epoch };
}

beforeEach(async () => {
  if (database) await database.destroy();
  database = createDatabase();
  await up(database);
  await createNativeExecutions(database);
  repo = new GoalRepository(database);
});

after(async () => {
  if (database) await database.destroy();
});

describe('GoalRepository', () => {
  test('round-trips a created goal with defaults', async () => {
    const goal = await seedGoal();
    assert.equal(goal.state, 'queued');
    assert.equal(goal.effectiveModel, 'claude-opus-4-8');
    assert.equal(goal.requestedModel, 'claude-opus-4-8');
    assert.equal(goal.maxActiveTasks, 3);
    assert.equal(goal.version, 1);
    assert.equal(goal.leaseEpoch, 0);

    const loaded = await repo.getGoal(goal.goalId);
    assert.deepEqual(loaded, goal);
  });

  test('foreign keys are enforced for nodes', async () => {
    await assert.rejects(
      database('goal_nodes').insert({
        node_id: 'n1',
        goal_id: 'missing',
        kind: 'root_epic',
        idempotency_key: 'k1',
        status: 'pending',
        attempt_count: 0,
        order_index: 0,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
    );
  });

  test('persists hierarchy with dependencies', async () => {
    const goal = await seedGoal();
    const fence = await claimFence(goal.goalId);
    const root = await repo.addNode(goal.goalId, {
      kind: 'root_epic',
      idempotencyKey: 'root',
      title: 'Epic',
      ...fence,
    });
    const issue = await repo.addNode(goal.goalId, {
      parentNodeId: root.nodeId,
      kind: 'implementation_issue',
      idempotencyKey: 'issue-1',
      externalRef: '42',
      externalKind: 'issue',
      orderIndex: 1,
      ...fence,
    });
    const dependent = await repo.addNode(goal.goalId, {
      parentNodeId: root.nodeId,
      kind: 'implementation_issue',
      idempotencyKey: 'issue-2',
      orderIndex: 2,
      ...fence,
    });
    await repo.addDependency(goal.goalId, dependent.nodeId, issue.nodeId, fence);
    // Duplicate dependency is a no-op.
    await repo.addDependency(goal.goalId, dependent.nodeId, issue.nodeId, fence);

    const nodes = await repo.getNodes(goal.goalId);
    assert.equal(nodes.length, 3);
    const deps = await repo.getDependencies(goal.goalId);
    assert.deepEqual(deps, [
      { nodeId: dependent.nodeId, dependsOnNodeId: issue.nodeId },
    ]);
  });

  test('rejects cross-goal parents, dependencies, and dependency cycles', async () => {
    const first = await seedGoal();
    const second = await seedGoal({ objective: 'Other goal' });
    const firstFence = await claimFence(first.goalId);
    const secondFence = await claimFence(second.goalId, 'second-controller');
    const firstRoot = await repo.addNode(first.goalId, { kind: 'root_epic', idempotencyKey: 'first-root', ...firstFence });
    const firstChild = await repo.addNode(first.goalId, { kind: 'implementation_issue', idempotencyKey: 'first-child', ...firstFence });
    const secondRoot = await repo.addNode(second.goalId, { kind: 'root_epic', idempotencyKey: 'second-root', ...secondFence });

    await assert.rejects(
      repo.addNode(first.goalId, { parentNodeId: secondRoot.nodeId, kind: 'sub_epic', idempotencyKey: 'bad-parent', ...firstFence }),
      (error: GoalError) => error.code === 'goal_hierarchy_conflict'
    );
    await assert.rejects(
      repo.addDependency(first.goalId, firstRoot.nodeId, secondRoot.nodeId, firstFence),
      (error: GoalError) => error.code === 'goal_hierarchy_conflict'
    );
    await assert.rejects(database('goal_nodes').insert({
      node_id: 'forged-cross-goal-child',
      goal_id: first.goalId,
      parent_node_id: secondRoot.nodeId,
      kind: 'sub_epic',
      idempotency_key: 'forged-parent',
      status: 'pending',
      attempt_count: 0,
      order_index: 0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }));
    await assert.rejects(database('goal_node_dependencies').insert({
      goal_id: first.goalId,
      node_id: firstRoot.nodeId,
      depends_on_node_id: secondRoot.nodeId,
      created_at: new Date().toISOString(),
    }));
    await repo.addDependency(first.goalId, firstChild.nodeId, firstRoot.nodeId, firstFence);
    await assert.rejects(
      repo.addDependency(first.goalId, firstRoot.nodeId, firstChild.nodeId, firstFence),
      (error: GoalError) => error.code === 'goal_hierarchy_conflict'
    );
  });

  test('node creation is idempotent per goal + key', async () => {
    const goal = await seedGoal();
    const fence = await claimFence(goal.goalId);
    const first = await repo.addNode(goal.goalId, {
      kind: 'root_epic',
      idempotencyKey: 'root',
      ...fence,
    });
    const second = await repo.addNode(goal.goalId, {
      kind: 'root_epic',
      idempotencyKey: 'root',
      ...fence,
    });
    assert.equal(first.nodeId, second.nodeId);
    assert.equal((await repo.getNodes(goal.goalId)).length, 1);
  });

  test('allocates a monotonic per-goal event sequence', async () => {
    const goal = await seedGoal();
    const other = await seedGoal({ objective: 'Second goal' });
    const fence = await claimFence(goal.goalId);
    const otherFence = await claimFence(other.goalId, 'other-controller');
    const e1 = await repo.appendEvent(goal.goalId, {
      kind: 'lifecycle',
      eventType: 'created',
      idempotencyKey: 'evt-1',
      ...fence,
    });
    const e2 = await repo.appendEvent(goal.goalId, {
      kind: 'output',
      eventType: 'log',
      payload: { line: 'hello' },
      idempotencyKey: 'evt-2',
      ...fence,
    });
    // A different goal has its own independent sequence.
    const otherEvent = await repo.appendEvent(other.goalId, {
      kind: 'lifecycle',
      eventType: 'created',
      idempotencyKey: 'evt-1',
      ...otherFence,
    });
    assert.equal(e1.sequence, 1);
    assert.equal(e2.sequence, 2);
    assert.equal(otherEvent.sequence, 1);
    assert.deepEqual(e2.payload, { line: 'hello' });
  });

  test('retried event append accepts reordered nested payload keys', async () => {
    const goal = await seedGoal();
    const fence = await claimFence(goal.goalId);
    const first = await repo.appendEvent(goal.goalId, {
      kind: 'lifecycle',
      eventType: 'created',
      payload: {
        alpha: 1,
        nested: { first: true, second: { left: 'a', right: 'b' } },
        omega: 2,
      },
      idempotencyKey: 'dup',
      ...fence,
    });
    const retry = await repo.appendEvent(goal.goalId, {
      kind: 'lifecycle',
      eventType: 'created',
      payload: {
        omega: 2,
        nested: { second: { right: 'b', left: 'a' }, first: true },
        alpha: 1,
      },
      idempotencyKey: 'dup',
      ...fence,
    });
    assert.equal(first.id, retry.id);
    assert.equal(first.sequence, retry.sequence);
    const { events } = await repo.readEvents(goal.goalId);
    assert.equal(events.length, 1);
  });

  test('reads events from an exclusive cursor (replay)', async () => {
    const goal = await seedGoal();
    const fence = await claimFence(goal.goalId);
    for (let i = 1; i <= 5; i += 1) {
      await repo.appendEvent(goal.goalId, {
        kind: 'output',
        eventType: 'log',
        idempotencyKey: `e${i}`,
        ...fence,
      });
    }
    const firstPage = await repo.readEvents(goal.goalId, { limit: 2 });
    assert.deepEqual(
      firstPage.events.map((e) => e.sequence),
      [1, 2]
    );
    assert.equal(firstPage.nextCursor, 2);
    const secondPage = await repo.readEvents(goal.goalId, {
      afterSequence: firstPage.nextCursor!,
      limit: 2,
    });
    assert.deepEqual(
      secondPage.events.map((e) => e.sequence),
      [3, 4]
    );
  });

  test('orders corrective messages and tracks delivery state', async () => {
    const goal = await seedGoal();
    const fence = await claimFence(goal.goalId);
    const m1 = await repo.enqueueMessage(goal.goalId, {
      body: 'first',
      idempotencyKey: 'm1',
    });
    const m2 = await repo.enqueueMessage(goal.goalId, {
      body: 'second',
      idempotencyKey: 'm2',
    });
    // Idempotent retry.
    const m2Retry = await repo.enqueueMessage(goal.goalId, {
      body: 'second',
      idempotencyKey: 'm2',
    });
    assert.equal(m1.sequence, 1);
    assert.equal(m2.sequence, 2);
    assert.equal(m2.messageId, m2Retry.messageId);

    await repo.markMessageDelivered(goal.goalId, m1.messageId, fence);
    await repo.markMessageAcknowledged(goal.goalId, m1.messageId, fence);
    const messages = await repo.getMessages(goal.goalId);
    assert.deepEqual(
      messages.map((m) => [m.sequence, m.state]),
      [
        [1, 'acknowledged'],
        [2, 'queued'],
      ]
    );
  });

  test('fences message delivery, scopes it to a goal, and preserves FIFO', async () => {
    const goal = await seedGoal();
    const other = await seedGoal({ objective: 'Other' });
    const fence = await claimFence(goal.goalId);
    const first = await repo.enqueueMessage(goal.goalId, { body: 'first', idempotencyKey: 'fifo-1' });
    const second = await repo.enqueueMessage(goal.goalId, { body: 'second', idempotencyKey: 'fifo-2' });
    await assert.rejects(
      repo.markMessageDelivered(goal.goalId, second.messageId, fence),
      (error: GoalError) => error.code === 'goal_message_order_conflict'
    );
    await assert.rejects(
      repo.markMessageDelivered(other.goalId, first.messageId, fence),
      (error: GoalError) => error.code === 'goal_stale_lease' || error.code === 'goal_not_found'
    );
    await repo.markMessageDelivered(goal.goalId, first.messageId, fence);
    await repo.markMessageDelivered(goal.goalId, second.messageId, fence);
  });

  test('validates lifecycle transitions', async () => {
    const goal = await seedGoal();
    const fence = await claimFence(goal.goalId);
    const running = await repo.transition(goal.goalId, { toState: 'running', ...fence });
    assert.equal(running.state, 'running');
    assert.equal(running.version, 2);

    await assert.rejects(
      repo.transition(goal.goalId, { toState: 'completed', ...fence }),
      (error: GoalError) => error.code === 'goal_invalid_transition'
    );
  });

  test('fences generic transitions and constrains operator intent sources', async () => {
    const goal = await seedGoal();
    assert.equal(
      (repo as unknown as Record<string, unknown>).transitionOperatorIntent,
      undefined
    );
    await assert.rejects(
      repo.transition(goal.goalId, { toState: 'running' } as never),
      (error: GoalError) => error.code === 'goal_validation_error'
    );
    await assert.rejects(
      repo.requestResume(goal.goalId),
      (error: GoalError) => error.code === 'goal_invalid_transition'
    );

    const fence = await claimFence(goal.goalId);
    await repo.transition(goal.goalId, { toState: 'planning', ...fence });
    await assert.rejects(
      repo.requestResume(goal.goalId),
      (error: GoalError) => error.code === 'goal_invalid_transition'
    );
    await repo.transition(goal.goalId, { toState: 'running', ...fence });
    await repo.transition(goal.goalId, { toState: 'recovering', ...fence });
    await assert.rejects(
      repo.requestResume(goal.goalId),
      (error: GoalError) => error.code === 'goal_invalid_transition'
    );

    const pausing = await repo.requestPause(goal.goalId);
    assert.equal(pausing.state, 'pausing');
    await repo.transition(goal.goalId, { toState: 'paused', ...fence });
    const resumed = await repo.requestResume(goal.goalId);
    assert.equal(resumed.state, 'running');
  });

  test('rejects a terminal transition without a reason but records it with one', async () => {
    const goal = await seedGoal();
    const fence = await claimFence(goal.goalId);
    await repo.transition(goal.goalId, { toState: 'running', ...fence });
    await assert.rejects(
      repo.transition(goal.goalId, { toState: 'completing', ...fence }).then(() =>
        repo.transition(goal.goalId, { toState: 'completed', ...fence })
      ),
      (error: GoalError) => error.code === 'goal_validation_error'
    );
    const completed = await repo.transition(goal.goalId, {
      toState: 'completed',
      terminalReason: 'objective_met',
      ...fence,
    });
    assert.equal(completed.state, 'completed');
    assert.equal(completed.terminalReason, 'objective_met');
  });

  test('requestCancel durably records nonterminal cancellation intent', async () => {
    const goal = await seedGoal();

    const pending = await repo.requestCancel(goal.goalId);
    const intent = await database('goal_cancellation_intents')
      .where({ goal_id: goal.goalId }).first();

    assert.equal(pending.state, 'queued');
    assert.equal(pending.terminalReason, null);
    assert.equal(intent.terminal_reason, 'user_cancelled');
    assert.equal(intent.acknowledged_at, null);
  });

  test('enforces optimistic version preconditions', async () => {
    const goal = await seedGoal();
    const fence = await claimFence(goal.goalId);
    await assert.rejects(
      repo.transition(goal.goalId, { toState: 'running', expectedVersion: 99, ...fence }),
      (error: GoalError) => error.code === 'goal_version_conflict'
    );
    const ok = await repo.transition(goal.goalId, {
      toState: 'running',
      expectedVersion: 1,
      ...fence,
    });
    assert.equal(ok.version, 2);
  });

  test('pause intervals let active time be derived', async () => {
    const goal = await seedGoal();
    const fence = await claimFence(goal.goalId);
    await repo.transition(goal.goalId, { toState: 'running', ...fence });
    await repo.transition(goal.goalId, { toState: 'pausing', ...fence });
    await repo.transition(goal.goalId, { toState: 'paused', ...fence });
    const openIntervals = await database('goal_pause_intervals')
      .where('goal_id', goal.goalId)
      .whereNull('resumed_at');
    assert.equal(openIntervals.length, 1);
    await repo.transition(goal.goalId, { toState: 'running', ...fence });
    const closedIntervals = await database('goal_pause_intervals')
      .where('goal_id', goal.goalId)
      .whereNotNull('resumed_at');
    assert.equal(closedIntervals.length, 1);

    const stats = await repo.getActiveTimeStats(goal.goalId);
    assert.equal(stats.currentlyPaused, false);
    assert.ok(stats.pausedMs >= 0);
    assert.ok(stats.activeMs <= stats.elapsedMs);
  });

  test('stores requested model separately until applied', async () => {
    const goal = await seedGoal();
    const fence = await claimFence(goal.goalId);
    const requested = await repo.requestModelChange(goal.goalId, 'claude-sonnet-5');
    assert.equal(requested.requestedModel, 'claude-sonnet-5');
    assert.equal(requested.effectiveModel, 'claude-opus-4-8');
    const pending = await database('goal_model_transitions')
      .where({ goal_id: goal.goalId, applied: 0 })
      .first();
    assert.ok(pending);

    const applied = await repo.applyModelChange(goal.goalId, fence);
    assert.equal(applied.effectiveModel, 'claude-sonnet-5');
    const appliedRow = await database('goal_model_transitions')
      .where({ goal_id: goal.goalId, applied: 1 })
      .first();
    assert.ok(appliedRow);
  });

  describe('fenced controller lease', () => {
    test('two concurrent claimants produce one winner', async () => {
      const goal = await seedGoal();
      const results = await Promise.allSettled([
        repo.claimLease(goal.goalId, 'controller-a', 60_000),
        repo.claimLease(goal.goalId, 'controller-b', 60_000),
      ]);
      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');
      assert.equal(fulfilled.length, 1);
      assert.equal(rejected.length, 1);
      assert.equal(
        (rejected[0] as PromiseRejectedResult).reason.code,
        'goal_lease_conflict'
      );
    });

    test('stale lease epoch cannot commit transitions or events', async () => {
      const goal = await seedGoal();
      const first = await repo.claimLease(goal.goalId, 'controller-a', 1);
      // Force expiry so a takeover can occur, then take over with a new epoch.
      await database('goals')
        .where('goal_id', goal.goalId)
        .update({ lease_expires_at: '2000-01-01T00:00:00.000Z' });
      const second = await repo.claimLease(goal.goalId, 'controller-b', 60_000);
      assert.ok(second.epoch > first.epoch);

      await assert.rejects(
        repo.transition(goal.goalId, {
          toState: 'running',
          leaseOwner: 'controller-a',
          leaseEpoch: first.epoch,
        }),
        (error: GoalError) => error.code === 'goal_stale_lease'
      );
      await assert.rejects(
        repo.appendEvent(goal.goalId, {
          kind: 'lifecycle',
          eventType: 'stale',
          idempotencyKey: 'x',
          leaseOwner: 'controller-a',
          leaseEpoch: first.epoch,
        }),
        (error: GoalError) => error.code === 'goal_stale_lease'
      );

      // The current holder can still commit.
      const running = await repo.transition(goal.goalId, {
        toState: 'running',
        leaseOwner: 'controller-b',
        leaseEpoch: second.epoch,
      });
      assert.equal(running.state, 'running');
    });

    test('renew requires the current epoch', async () => {
      const goal = await seedGoal();
      const lease = await repo.claimLease(goal.goalId, 'controller-a', 60_000);
      await assert.rejects(
        repo.renewLease(goal.goalId, 'controller-a', lease.epoch + 5, 60_000),
        (error: GoalError) => error.code === 'goal_stale_lease'
      );
      const renewed = await repo.renewLease(
        goal.goalId,
        'controller-a',
        lease.epoch,
        60_000
      );
      assert.ok(renewed.expiresAt);
    });

    test('calculates claim, renew, and release timestamps inside the transaction', async () => {
      const goal = await seedGoal();
      const originalNow = Date.now;
      let clock = Date.parse('2026-08-31T12:00:00.000Z');
      let transactionStartedAt = clock;
      const transactionDb = {
        transaction<T>(effect: (trx: Knex.Transaction) => Promise<T>): Promise<T> {
          return database.transaction(async (trx) => {
            clock += 10_000;
            transactionStartedAt = clock;
            return effect(trx);
          });
        },
      } as Knex;
      const leases = new GoalLeaseRepository(transactionDb);

      Date.now = () => clock;
      try {
        const claimed = await leases.claimLease(goal.goalId, 'timed-controller', 60_000);
        assert.equal(Date.parse(claimed.expiresAt), transactionStartedAt + 60_000);

        const renewed = await leases.renewLease(
          goal.goalId,
          'timed-controller',
          claimed.epoch,
          60_000
        );
        assert.equal(Date.parse(renewed.expiresAt), transactionStartedAt + 60_000);

        await database('goals').where('goal_id', goal.goalId).update({
          lease_expires_at: new Date(clock + 5_000).toISOString(),
        });
        await assert.rejects(
          leases.releaseLease(goal.goalId, 'timed-controller', claimed.epoch),
          (error: GoalError) => error.code === 'goal_stale_lease'
        );
      } finally {
        Date.now = originalNow;
      }
    });

    test('rejects forged future, wrong-owner, and null-owner controller writes', async () => {
      const goal = await seedGoal();
      const lease = await repo.claimLease(goal.goalId, 'controller-a', 60_000);
      for (const fence of [
        { leaseOwner: 'controller-a', leaseEpoch: lease.epoch + 1 },
        { leaseOwner: 'controller-b', leaseEpoch: lease.epoch },
      ]) {
        await assert.rejects(
          repo.appendEvent(goal.goalId, { kind: 'domain', eventType: 'forged', idempotencyKey: `${fence.leaseOwner}-${fence.leaseEpoch}`, ...fence }),
          (error: GoalError) => error.code === 'goal_stale_lease'
        );
      }
      await repo.releaseLease(goal.goalId, 'controller-a', lease.epoch);
      await assert.rejects(
        repo.appendEvent(goal.goalId, { kind: 'domain', eventType: 'released', idempotencyKey: 'released', leaseOwner: 'controller-a', leaseEpoch: lease.epoch }),
        (error: GoalError) => error.code === 'goal_stale_lease'
      );
    });

    test('a terminal controller transition fences every mutation while exact release still works', async () => {
      const goal = await seedGoal();
      const fence = await claimFence(goal.goalId, 'terminal-controller');
      const firstNode = await repo.addNode(goal.goalId, {
        kind: 'root_epic', idempotencyKey: 'terminal-root', ...fence,
      });
      const secondNode = await repo.addNode(goal.goalId, {
        kind: 'implementation_issue', idempotencyKey: 'terminal-child', ...fence,
      });
      await repo.upsertProviderSession(goal.goalId, 'claude', {
        ...fence,
        providerThreadId: 'thread-before-cancel',
        effectiveModel: 'claude-opus-4-8',
        recoveryMetadata: { schemaVersion: 1, attempt: 1, providerState: 'active' },
      });
      await repo.appendEvent(goal.goalId, {
        kind: 'lifecycle', eventType: 'before-cancel', idempotencyKey: 'before-cancel', ...fence,
      });
      const delivered = await repo.enqueueMessage(goal.goalId, {
        body: 'ack after cancel', idempotencyKey: 'terminal-ack',
      });
      const queued = await repo.enqueueMessage(goal.goalId, {
        body: 'deliver after cancel', idempotencyKey: 'terminal-deliver',
      });
      await repo.markMessageDelivered(goal.goalId, delivered.messageId, fence);
      await repo.requestModelChange(goal.goalId, 'claude-sonnet-5');
      const cancelled = await repo.transition(goal.goalId, {
        toState: 'cancelled', terminalReason: 'user_cancelled', ...fence,
      });
      const before = {
        goal: cancelled,
        nodes: await repo.getNodes(goal.goalId),
        dependencies: await repo.getDependencies(goal.goalId),
        events: (await repo.readEvents(goal.goalId)).events,
        messages: await repo.getMessages(goal.goalId),
        provider: await repo.getProviderSession(goal.goalId, 'claude'),
        modelTransitions: await database('goal_model_transitions').where('goal_id', goal.goalId),
        stateTransitions: await database('goal_state_transitions').where('goal_id', goal.goalId),
        pauseIntervals: await database('goal_pause_intervals').where('goal_id', goal.goalId),
        stats: await repo.getActiveTimeStats(goal.goalId),
      };
      await new Promise(resolve => setTimeout(resolve, 2));
      const expectTerminal = async (operation: Promise<unknown>) => assert.rejects(
        operation,
        (error: GoalError) => error.code === 'goal_terminal_state'
      );

      await expectTerminal(repo.appendEvent(goal.goalId, {
        kind: 'domain', eventType: 'after-cancel', idempotencyKey: 'after-cancel', ...fence,
      }));
      await expectTerminal(repo.addNode(goal.goalId, {
        kind: 'sub_epic', idempotencyKey: 'after-cancel-node', ...fence,
      }));
      await expectTerminal(repo.addDependency(goal.goalId, secondNode.nodeId, firstNode.nodeId, fence));
      await expectTerminal(repo.upsertProviderSession(goal.goalId, 'claude', {
        ...fence,
        providerThreadId: 'thread-after-cancel',
        effectiveModel: 'claude-sonnet-5',
        recoveryMetadata: { schemaVersion: 1, attempt: 2, providerState: 'recoverable' },
      }));
      await expectTerminal(repo.markMessageDelivered(goal.goalId, queued.messageId, fence));
      await expectTerminal(repo.markMessageAcknowledged(goal.goalId, delivered.messageId, fence));
      await expectTerminal(repo.applyModelChange(goal.goalId, fence));
      await expectTerminal(repo.renewLease(goal.goalId, fence.leaseOwner, fence.leaseEpoch, 60_000));
      assert.deepEqual(await repo.enqueueMessage(goal.goalId, {
        body: 'deliver after cancel', idempotencyKey: 'terminal-deliver',
      }), queued);
      await expectTerminal(repo.enqueueMessage(goal.goalId, {
        body: 'new work after cancel', idempotencyKey: 'after-cancel-message',
      }));
      await repo.releaseLease(goal.goalId, fence.leaseOwner, fence.leaseEpoch);

      const afterGoal = await repo.requireGoal(goal.goalId);
      assert.deepEqual({ ...afterGoal, leaseOwner: before.goal.leaseOwner, leaseExpiresAt: before.goal.leaseExpiresAt }, before.goal);
      assert.deepEqual(await repo.getNodes(goal.goalId), before.nodes);
      assert.deepEqual(await repo.getDependencies(goal.goalId), before.dependencies);
      assert.deepEqual((await repo.readEvents(goal.goalId)).events, before.events);
      assert.deepEqual(await repo.getMessages(goal.goalId), before.messages);
      assert.deepEqual(await repo.getProviderSession(goal.goalId, 'claude'), before.provider);
      assert.deepEqual(await database('goal_model_transitions').where('goal_id', goal.goalId), before.modelTransitions);
      assert.deepEqual(await database('goal_state_transitions').where('goal_id', goal.goalId), before.stateTransitions);
      assert.deepEqual(await database('goal_pause_intervals').where('goal_id', goal.goalId), before.pauseIntervals);
      assert.deepEqual(await repo.getActiveTimeStats(goal.goalId), before.stats);
      assert.equal(afterGoal.leaseOwner, null);
      assert.equal(afterGoal.leaseExpiresAt, null);
    });
  });

  test('fences provider sessions and validates bounded credential-free recovery metadata', async () => {
    const goal = await seedGoal();
    const fence = await claimFence(goal.goalId);
    await repo.upsertProviderSession(goal.goalId, 'claude', {
      ...fence,
      effectiveModel: 'claude-opus-4-8',
      recoveryMetadata: { schemaVersion: 1, attempt: 1, providerState: 'active' },
    });
    await assert.rejects(
      repo.upsertProviderSession(goal.goalId, 'claude', {
        leaseOwner: fence.leaseOwner,
        leaseEpoch: fence.leaseEpoch + 1,
        recoveryMetadata: { schemaVersion: 1 },
      }),
      (error: GoalError) => error.code === 'goal_stale_lease'
    );
    await assert.rejects(
      repo.upsertProviderSession(goal.goalId, 'claude', {
        ...fence,
        recoveryMetadata: { schemaVersion: 1, token: 'secret' } as never,
      }),
      (error: GoalError) => error.code === 'goal_recovery_metadata_invalid'
    );
  });

  test('createGoal is idempotent and detects key reuse', async () => {
    const first = await seedGoal({ idempotencyKey: 'idem-1' });
    const retry = await seedGoal({ idempotencyKey: 'idem-1' });
    assert.equal(first.goalId, retry.goalId);
    assert.notEqual(first.goalId, 'idem-1');
    await assert.rejects(
      seedGoal({ idempotencyKey: 'idem-1', objective: 'different' }),
      (error: GoalError) => error.code === 'goal_idempotency_conflict'
    );
  });

  test('createGoal rejects null defaults before durable or idempotency mutation', async () => {
    const baseInput = {
      ownerUserId: 'user-1',
      repository: 'octo/repo',
      objective: 'Reject invalid runtime input',
      agent: 'claude',
      requestedModel: 'claude-opus-4-8',
    };
    const invalidInputs = [
      {
        input: { ...baseInput, maxActiveTasks: null, idempotencyKey: 'null-max-active-tasks' },
        code: 'goal_concurrency_bound_exceeded',
      },
      {
        input: { ...baseInput, mergePolicy: null, idempotencyKey: 'null-merge-policy' },
        code: 'goal_validation_error',
      },
    ];

    for (const { input, code } of invalidInputs) {
      await assert.rejects(
        repo.createGoal(input as unknown as Parameters<GoalRepository['createGoal']>[0]),
        (error: GoalError) => error.status === 400 && error.code === code
      );
    }

    assert.equal(Number((await database('goals').count({ count: '*' }).first())?.count), 0);
    assert.equal(
      Number((await database('goal_idempotency_keys').count({ count: '*' }).first())?.count),
      0
    );
  });

  test('concurrent create retries return one original response', async () => {
    const [first, retry] = await Promise.all([
      seedGoal({ idempotencyKey: 'concurrent-create' }),
      seedGoal({ idempotencyKey: 'concurrent-create' }),
    ]);
    assert.deepEqual(retry, first);
    assert.equal(Number((await database('goals').count({ count: '*' }).first())?.count), 1);
  });

  test('operator lifecycle retries return the original response and reject mismatches', async () => {
    const service = new GoalLifecycleService(database);
    const goal = await seedGoal();
    const first = await service.pause(goal.goalId, { idempotencyKey: 'pause-1', reason: 'operator' });
    const retry = await service.pause(goal.goalId, { idempotencyKey: 'pause-1', reason: 'operator' });
    assert.deepEqual(retry, first);
    await assert.rejects(
      service.pause(goal.goalId, { idempotencyKey: 'pause-1', reason: 'different' }),
      (error: GoalError) => error.code === 'goal_idempotency_conflict'
    );
    assert.equal((await database('goal_state_transitions').where('goal_id', goal.goalId)).length, 1);
  });

  test('migration down removes all goal control-plane tables', async () => {
    const isolated = createDatabase();
    try {
      await up(isolated);
      await down(isolated);
      const rows = await isolated.raw("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'goal%'");
      assert.deepEqual(rows, []);
    } finally {
      await isolated.destroy();
    }
  });

  test('list pagination is stable with a keyset cursor', async () => {
    const created = [];
    for (let i = 0; i < 5; i += 1) {
      created.push(await seedGoal({ objective: `goal ${i}` }));
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    const page1 = await repo.listGoals({ visibility: 'owner', ownerUserId: 'user-1', limit: 2 });
    assert.equal(page1.goals.length, 2);
    assert.ok(page1.nextCursor);
    const page2 = await repo.listGoals({
      visibility: 'owner',
      ownerUserId: 'user-1',
      limit: 2,
      cursor: page1.nextCursor,
    });
    assert.equal(page2.goals.length, 2);
    const ids = new Set([
      ...page1.goals.map((g) => g.goalId),
      ...page2.goals.map((g) => g.goalId),
    ]);
    assert.equal(ids.size, 4);
  });

  test('list rejects a missing visibility discriminator without exposing goals', async () => {
    await seedGoal();
    await seedGoal({ ownerUserId: 'user-2', objective: 'Other owner goal' });

    await assert.rejects(
      repo.listGoals({} as Parameters<GoalRepository['listGoals']>[0]),
      (error: GoalError) => error.code === 'goal_validation_error'
    );
  });

  test('list rejects an invalid visibility discriminator without exposing goals', async () => {
    await seedGoal();
    await seedGoal({ ownerUserId: 'user-2', objective: 'Other owner goal' });

    await assert.rejects(
      repo.listGoals({ visibility: 'unknown' } as unknown as Parameters<GoalRepository['listGoals']>[0]),
      (error: GoalError) => error.code === 'goal_validation_error'
    );
  });

  test('list rejects a legacy ownerUserId-only call without exposing cross-owner goals', async () => {
    await seedGoal();
    await seedGoal({ ownerUserId: 'user-2', objective: 'Other owner goal' });

    await assert.rejects(
      repo.listGoals({ ownerUserId: 'user-1' } as Parameters<GoalRepository['listGoals']>[0]),
      (error: GoalError) => error.code === 'goal_validation_error'
    );
  });

  test('lifecycle service reconstructs a summary from SQL alone', async () => {
    const service = new GoalLifecycleService(database);
    const goal = await seedGoal();
    const fence = await claimFence(goal.goalId);
    await repo.addNode(goal.goalId, {
      kind: 'root_epic',
      idempotencyKey: 'root',
      status: 'in_progress',
      ...fence,
    });
    await repo.appendEvent(goal.goalId, {
      kind: 'lifecycle',
      eventType: 'created',
      idempotencyKey: 'e1',
      ...fence,
    });
    const detail = await service.getDetail(goal.goalId);
    assert.equal('nodeCount' in detail.summary, false);
    assert.equal('activeNodeCount' in detail.summary, false);
    assert.equal(detail.summary.nativePlan, null);
    assert.equal(detail.summary.latestSequence, 1);
    assert.equal(detail.summary.objective, 'Ship the control plane');
  });
});
