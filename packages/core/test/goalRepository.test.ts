import assert from 'node:assert/strict';
import { after, beforeEach, describe, test } from 'node:test';
import knex, { type Knex } from 'knex';
import type { BetterSqliteConnection } from '../src/db/connection.js';
import { up } from '../src/db/migrations/20260831000000_create_goal_control_plane.js';
import { GoalRepository, GoalError } from '../src/services/goals/goalRepository.js';
import { GoalLifecycleService } from '../src/services/goals/goalLifecycleService.js';

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

beforeEach(async () => {
  if (database) await database.destroy();
  database = createDatabase();
  await up(database);
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
    const root = await repo.addNode(goal.goalId, {
      kind: 'root_epic',
      idempotencyKey: 'root',
      title: 'Epic',
    });
    const issue = await repo.addNode(goal.goalId, {
      parentNodeId: root.nodeId,
      kind: 'implementation_issue',
      idempotencyKey: 'issue-1',
      externalRef: '42',
      externalKind: 'issue',
      orderIndex: 1,
    });
    const dependent = await repo.addNode(goal.goalId, {
      parentNodeId: root.nodeId,
      kind: 'implementation_issue',
      idempotencyKey: 'issue-2',
      orderIndex: 2,
    });
    await repo.addDependency(goal.goalId, dependent.nodeId, issue.nodeId);
    // Duplicate dependency is a no-op.
    await repo.addDependency(goal.goalId, dependent.nodeId, issue.nodeId);

    const nodes = await repo.getNodes(goal.goalId);
    assert.equal(nodes.length, 3);
    const deps = await repo.getDependencies(goal.goalId);
    assert.deepEqual(deps, [
      { nodeId: dependent.nodeId, dependsOnNodeId: issue.nodeId },
    ]);
  });

  test('node creation is idempotent per goal + key', async () => {
    const goal = await seedGoal();
    const first = await repo.addNode(goal.goalId, {
      kind: 'root_epic',
      idempotencyKey: 'root',
    });
    const second = await repo.addNode(goal.goalId, {
      kind: 'root_epic',
      idempotencyKey: 'root',
    });
    assert.equal(first.nodeId, second.nodeId);
    assert.equal((await repo.getNodes(goal.goalId)).length, 1);
  });

  test('allocates a monotonic per-goal event sequence', async () => {
    const goal = await seedGoal();
    const other = await seedGoal({ objective: 'Second goal' });
    const e1 = await repo.appendEvent(goal.goalId, {
      kind: 'lifecycle',
      eventType: 'created',
      idempotencyKey: 'evt-1',
    });
    const e2 = await repo.appendEvent(goal.goalId, {
      kind: 'output',
      eventType: 'log',
      payload: { line: 'hello' },
      idempotencyKey: 'evt-2',
    });
    // A different goal has its own independent sequence.
    const otherEvent = await repo.appendEvent(other.goalId, {
      kind: 'lifecycle',
      eventType: 'created',
      idempotencyKey: 'evt-1',
    });
    assert.equal(e1.sequence, 1);
    assert.equal(e2.sequence, 2);
    assert.equal(otherEvent.sequence, 1);
    assert.deepEqual(e2.payload, { line: 'hello' });
  });

  test('retried event append with same key has one effect', async () => {
    const goal = await seedGoal();
    const first = await repo.appendEvent(goal.goalId, {
      kind: 'lifecycle',
      eventType: 'created',
      idempotencyKey: 'dup',
    });
    const retry = await repo.appendEvent(goal.goalId, {
      kind: 'lifecycle',
      eventType: 'created',
      idempotencyKey: 'dup',
    });
    assert.equal(first.id, retry.id);
    assert.equal(first.sequence, retry.sequence);
    const { events } = await repo.readEvents(goal.goalId);
    assert.equal(events.length, 1);
  });

  test('reads events from an exclusive cursor (replay)', async () => {
    const goal = await seedGoal();
    for (let i = 1; i <= 5; i += 1) {
      await repo.appendEvent(goal.goalId, {
        kind: 'output',
        eventType: 'log',
        idempotencyKey: `e${i}`,
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

    await repo.markMessageDelivered(m1.messageId);
    await repo.markMessageAcknowledged(m1.messageId);
    const messages = await repo.getMessages(goal.goalId);
    assert.deepEqual(
      messages.map((m) => [m.sequence, m.state]),
      [
        [1, 'acknowledged'],
        [2, 'queued'],
      ]
    );
  });

  test('validates lifecycle transitions', async () => {
    const goal = await seedGoal();
    const running = await repo.transition(goal.goalId, { toState: 'running' });
    assert.equal(running.state, 'running');
    assert.equal(running.version, 2);

    await assert.rejects(
      repo.transition(goal.goalId, { toState: 'completed' }),
      (error: GoalError) => error.code === 'goal_invalid_transition'
    );
  });

  test('rejects a terminal transition without a reason but records it with one', async () => {
    const goal = await seedGoal();
    await repo.transition(goal.goalId, { toState: 'running' });
    await assert.rejects(
      repo.transition(goal.goalId, { toState: 'completing' }).then(() =>
        repo.transition(goal.goalId, { toState: 'completed' })
      ),
      (error: GoalError) => error.code === 'goal_validation_error'
    );
    const completed = await repo.transition(goal.goalId, {
      toState: 'completed',
      terminalReason: 'objective_met',
    });
    assert.equal(completed.state, 'completed');
    assert.equal(completed.terminalReason, 'objective_met');
  });

  test('enforces optimistic version preconditions', async () => {
    const goal = await seedGoal();
    await assert.rejects(
      repo.transition(goal.goalId, { toState: 'running', expectedVersion: 99 }),
      (error: GoalError) => error.code === 'goal_version_conflict'
    );
    const ok = await repo.transition(goal.goalId, {
      toState: 'running',
      expectedVersion: 1,
    });
    assert.equal(ok.version, 2);
  });

  test('pause intervals let active time be derived', async () => {
    const goal = await seedGoal();
    await repo.transition(goal.goalId, { toState: 'running' });
    await repo.transition(goal.goalId, { toState: 'pausing' });
    await repo.transition(goal.goalId, { toState: 'paused' });
    const openIntervals = await database('goal_pause_intervals')
      .where('goal_id', goal.goalId)
      .whereNull('resumed_at');
    assert.equal(openIntervals.length, 1);
    await repo.transition(goal.goalId, { toState: 'running' });
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
    const requested = await repo.requestModelChange(goal.goalId, 'claude-sonnet-5');
    assert.equal(requested.requestedModel, 'claude-sonnet-5');
    assert.equal(requested.effectiveModel, 'claude-opus-4-8');
    const pending = await database('goal_model_transitions')
      .where({ goal_id: goal.goalId, applied: 0 })
      .first();
    assert.ok(pending);

    const applied = await repo.applyModelChange(goal.goalId);
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
  });

  test('createGoal is idempotent and detects key reuse', async () => {
    const first = await seedGoal({ idempotencyKey: 'idem-1' });
    const retry = await seedGoal({ idempotencyKey: 'idem-1' });
    assert.equal(first.goalId, retry.goalId);
    await assert.rejects(
      seedGoal({ idempotencyKey: 'idem-1', objective: 'different' }),
      (error: GoalError) => error.code === 'goal_idempotency_conflict'
    );
  });

  test('list pagination is stable with a keyset cursor', async () => {
    const created = [];
    for (let i = 0; i < 5; i += 1) {
      created.push(await seedGoal({ objective: `goal ${i}` }));
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    const page1 = await repo.listGoals({ ownerUserId: 'user-1', limit: 2 });
    assert.equal(page1.goals.length, 2);
    assert.ok(page1.nextCursor);
    const page2 = await repo.listGoals({
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

  test('lifecycle service reconstructs a summary from SQL alone', async () => {
    const service = new GoalLifecycleService(database);
    const goal = await seedGoal();
    await repo.addNode(goal.goalId, {
      kind: 'root_epic',
      idempotencyKey: 'root',
      status: 'in_progress',
    });
    await repo.appendEvent(goal.goalId, {
      kind: 'lifecycle',
      eventType: 'created',
      idempotencyKey: 'e1',
    });
    const detail = await service.getDetail(goal.goalId);
    assert.equal(detail.summary.nodeCount, 1);
    assert.equal(detail.summary.activeNodeCount, 1);
    assert.equal(detail.summary.latestSequence, 1);
    assert.equal(detail.summary.objective, 'Ship the control plane');
  });
});
