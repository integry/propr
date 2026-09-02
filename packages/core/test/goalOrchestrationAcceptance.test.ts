import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import knex, { type Knex } from 'knex';
import type { BetterSqliteConnection } from '../src/db/connection.js';
import { up as upGoals } from '../src/db/migrations/20260831000000_create_goal_control_plane.js';
import { up as upOrchestration } from '../src/db/migrations/20260901000000_create_goal_orchestration.js';
import { GoalController } from '../src/services/goals/goalController.js';
import { GoalOrchestrationRepository, buildGoalArtifactMarker } from '../src/services/goals/goalOrchestrationRepository.js';
import { GoalRepository } from '../src/services/goals/goalRepository.js';
import { ProductionGoalOrchestrator } from '../src/services/goals/goalProductionOrchestrator.js';
import type {
  GoalGitHubPort, GoalGitHubRemoteArtifact, GoalOutboxOperation, GoalPlanInput,
  GoalReadinessPolicy, GoalRuntimeDispatch, GoalRuntimeExecution, GoalRuntimePort,
} from '../src/services/goals/goalOrchestrationTypes.js';

const databases: Knex[] = [];
const directories: string[] = [];
const policy: GoalReadinessPolicy = {
  policyHash: 'acceptance-v1', requiredEvidence: [], mergePolicy: 'manual',
};

function database(filename = ':memory:'): Knex {
  const value = knex({
    client: 'better-sqlite3', connection: { filename }, useNullAsDefault: true,
    pool: { afterCreate(connection: BetterSqliteConnection, done: (error: Error | null, value?: BetterSqliteConnection) => void) {
      connection.pragma('foreign_keys = ON');
      connection.pragma('journal_mode = WAL');
      connection.pragma('busy_timeout = 200');
      done(null, connection);
    } },
  });
  databases.push(value);
  return value;
}

async function migrate(value: Knex): Promise<void> {
  await upGoals(value);
  await upOrchestration(value);
}

function singlePlan(title = 'Implement exact change'): GoalPlanInput {
  return {
    schemaVersion: 1, baseBranch: 'integration/main',
    nodes: [{ key: 'only', kind: 'implementation_pr', title, estimate: 1, acceptanceCriteria: ['Tests pass'] }],
  };
}

class RuntimeFake implements GoalRuntimePort {
  readonly executions = new Map<string, GoalRuntimeExecution>();
  readonly dispatches: GoalRuntimeDispatch[] = [];
  readonly messages: string[] = [];
  failAfterCreate = false;

  async lookup(input: { dispatchIdentity: string }): Promise<GoalRuntimeExecution> {
    return this.executions.get(input.dispatchIdentity)
      ?? { dispatchIdentity: input.dispatchIdentity, state: 'absent' };
  }

  async dispatch(input: GoalRuntimeDispatch): Promise<{ sessionId: string }> {
    this.dispatches.push(input);
    const execution = { dispatchIdentity: input.dispatchIdentity, state: 'running' as const, sessionId: `session-${input.attemptId}` };
    this.executions.set(input.dispatchIdentity, execution);
    if (this.failAfterCreate) {
      this.failAfterCreate = false;
      throw new Error('ambiguous runtime response');
    }
    return { sessionId: execution.sessionId };
  }

  async requestSafeBoundary(input: { attemptId: string; sessionId: string }): Promise<void> {
    const execution = [...this.executions.values()].find((item) => item.sessionId === input.sessionId)!;
    this.executions.set(execution.dispatchIdentity, { ...execution, state: 'safe_boundary' });
  }

  async resume(input: { attemptId: string; sessionId: string }): Promise<void> {
    const execution = [...this.executions.values()].find((item) => item.sessionId === input.sessionId)!;
    this.executions.set(execution.dispatchIdentity, { ...execution, state: 'running' });
  }

  async stop(input: { dispatchIdentity: string }): Promise<GoalRuntimeExecution> {
    const stopped = { dispatchIdentity: input.dispatchIdentity, state: 'cancelled' as const };
    this.executions.set(input.dispatchIdentity, stopped);
    return stopped;
  }

  async sendFollowup(input: { messageId: string }): Promise<void> { this.messages.push(input.messageId); }
}

class GitHubFake implements GoalGitHubPort {
  readonly remotes = new Map<string, GoalGitHubRemoteArtifact>();
  executeCalls = 0;
  delayMs = 0;
  nullCreate = false;

  async findByMarker(marker: Parameters<GoalGitHubPort['findByMarker']>[0]) {
    return this.remotes.get(buildGoalArtifactMarker(marker)) ?? null;
  }

  async execute(operation: GoalOutboxOperation, marker: Parameters<GoalGitHubPort['findByMarker']>[0]) {
    this.executeCalls += 1;
    if (this.delayMs) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    if (this.nullCreate && operation.operationKind.startsWith('create_')) return null;
    const prior = this.remotes.get(operation.marker);
    const kind = marker.artifactKind;
    const state = operation.operationKind === 'merge_pull_request' ? 'merged'
      : operation.operationKind === 'update_pull_request' ? 'present' : prior?.state ?? 'present';
    const remote: GoalGitHubRemoteArtifact = {
      remoteId: prior?.remoteId ?? `${kind}-${this.executeCalls}`,
      number: kind === 'issue' || kind === 'pull_request' ? prior?.number ?? this.executeCalls : undefined,
      repository: marker.repository, kind, marker: operation.marker,
      headBranch: marker.head, baseBranch: marker.base,
      headSha: kind === 'pull_request' ? prior?.headSha ?? `head-${operation.nodeId}` : undefined,
      baseSha: kind === 'pull_request' ? prior?.baseSha ?? 'base-sha' : undefined,
      state, labels: operation.operationKind === 'sync_labels'
        ? operation.payload.labels as string[] : prior?.labels ?? operation.payload.labels as string[] | undefined,
    };
    this.remotes.set(operation.marker, remote);
    return remote;
  }

  async inspectGoal() { return [...this.remotes.values()]; }
  async branchHasDiff() { return true; }
}

async function fixture(options: { max?: number; agent?: string; model?: string; mergePolicy?: 'manual' | 'auto'; ultrafix?: boolean } = {}) {
  const db = database();
  await migrate(db);
  const goals = new GoalRepository(db);
  const orchestration = new GoalOrchestrationRepository(db);
  const goal = await goals.createGoal({
    ownerUserId: 'owner', repository: 'octo/repo', objective: 'ship',
    agent: options.agent ?? 'codex', requestedModel: options.model ?? 'gpt-5.6-sol',
    maxActiveTasks: options.max ?? 2, mergePolicy: options.mergePolicy,
    ultrafixEnabled: options.ultrafix, ultrafixGoal: options.ultrafix ? 8 : undefined,
    ultrafixMaxCycles: options.ultrafix ? 2 : undefined,
  });
  const lease = await goals.claimLease(goal.goalId, 'controller-a', 60_000);
  const fence = { leaseOwner: 'controller-a', leaseEpoch: lease.epoch };
  await goals.transition(goal.goalId, { toState: 'planning', ...fence });
  const runtime = new RuntimeFake();
  const github = new GitHubFake();
  const controller = new GoalController(goals, orchestration, runtime, github, { async emit() {} }, {
    controllerId: 'controller-a', repositoryMaxActiveTasks: 2, outboxClaimTtlMs: 40,
  });
  return { db, goals, orchestration, goal, fence, runtime, github, controller };
}

afterEach(async () => {
  await Promise.all(databases.splice(0).map((value) => value.destroy()));
  await Promise.all(directories.splice(0).map((value) => rm(value, { recursive: true, force: true })));
});

describe('goal orchestration acceptance matrix', () => {
  test('single-PR dispatch proves artifacts and carries stable identity, agent, and model', async () => {
    const value = await fixture({ agent: 'codex', model: 'gpt-5.6-sol' });
    await value.controller.installPlan(value.goal.goalId, singlePlan(), value.fence);
    assert.equal((await value.orchestration.reserveRunnableNodes(value.goal.goalId, value.fence)).length, 0);
    const result = await value.controller.tick(value.goal.goalId, value.fence);
    assert.equal(result.dispatchedAttempts, 1);
    assert.equal(value.runtime.dispatches[0].agent, 'codex');
    assert.equal(value.runtime.dispatches[0].model, 'gpt-5.6-sol');
    assert.match(value.runtime.dispatches[0].dispatchIdentity, /^goal-dispatch:/);
  });

  test('single-PR no-diff completion does not invent an aggregate hierarchy or merge', async () => {
    const value = await fixture();
    await value.controller.installPlan(value.goal.goalId, singlePlan(), value.fence);
    await value.controller.tick(value.goal.goalId, value.fence, policy);
    const attempt = (await value.orchestration.getAttempts(value.goal.goalId))[0];
    value.runtime.executions.set(attempt.dispatchIdentity, {
      dispatchIdentity: attempt.dispatchIdentity, state: 'succeeded', hasDiff: false,
    });
    await value.controller.tick(value.goal.goalId, value.fence, policy);
    assert.equal((await value.goals.requireGoal(value.goal.goalId)).state, 'completed');
    assert.equal(Number((await value.db('goal_github_outbox').where('operation_kind', 'merge_pull_request')
      .count({ count: '*' }).first())?.count), 0);
  });

  test('ambiguous dispatch is adopted after restart without a second runtime', async () => {
    const value = await fixture();
    value.runtime.failAfterCreate = true;
    await value.controller.installPlan(value.goal.goalId, singlePlan(), value.fence);
    await value.controller.tick(value.goal.goalId, value.fence);
    assert.equal((await value.orchestration.getAttempts(value.goal.goalId))[0].status, 'dispatching');
    const restarted = new GoalController(value.goals, value.orchestration, value.runtime, value.github, { async emit() {} }, { controllerId: 'controller-a' });
    await restarted.tick(value.goal.goalId, value.fence);
    assert.equal(value.runtime.dispatches.length, 1);
    assert.equal((await value.orchestration.getAttempts(value.goal.goalId))[0].status, 'running');
  });

  test('pause, pending model, FIFO messages, resume, and cancel are durable', async () => {
    const value = await fixture();
    await value.controller.installPlan(value.goal.goalId, singlePlan(), value.fence);
    await value.controller.tick(value.goal.goalId, value.fence);
    await value.goals.enqueueMessage(value.goal.goalId, { body: 'fix first', idempotencyKey: 'm1' });
    await value.goals.enqueueMessage(value.goal.goalId, { body: 'status', predefinedKind: 'status_prompt', idempotencyKey: 'm2' });
    await value.goals.requestPause(value.goal.goalId);
    await value.controller.tick(value.goal.goalId, value.fence);
    assert.equal((await value.goals.requireGoal(value.goal.goalId)).state, 'paused');
    await value.goals.requestModelChange(value.goal.goalId, 'future-model');
    await value.goals.requestResume(value.goal.goalId);
    await value.controller.tick(value.goal.goalId, value.fence);
    assert.equal((await value.goals.requireGoal(value.goal.goalId)).effectiveModel, 'future-model');
    assert.deepEqual(value.runtime.messages.length, 2);
    await value.goals.requestCancel(value.goal.goalId);
    await value.controller.tick(value.goal.goalId, value.fence);
    assert.equal((await value.goals.requireGoal(value.goal.goalId)).state, 'cancelled');
  });

  test('renewable outbox claim blocks takeover and null create remains retryable', async () => {
    const value = await fixture();
    const controller = new GoalController(
      value.goals, value.orchestration, value.runtime, value.github, { async emit() {} },
      { controllerId: 'controller-a', repositoryMaxActiveTasks: 2, outboxClaimTtlMs: 200, outboxBatchSize: 1 }
    );
    await value.controller.installPlan(value.goal.goalId, singlePlan(), value.fence);
    value.github.delayMs = 500;
    const draining = controller.drainOutbox(value.goal.goalId, value.fence);
    const initialClaim = await waitForClaim(value.db);
    const initialExpiry = initialClaim.claim_expires_at as string;
    await waitForClaimRenewal(value.db, initialExpiry);
    const competing = await value.orchestration.claimGitHubOperations(value.goal.goalId, 'controller-b', 10, value.fence);
    assert.ok(competing.every((operation) => operation.operationId !== initialClaim.operation_id));
    await draining;
    for (const operation of competing) await value.orchestration.retryGitHubOperation(operation, 'test release', value.fence);
    value.github.delayMs = 0;
    await controller.drainOutbox(value.goal.goalId, value.fence);
    value.github.nullCreate = true;
    const node = (await value.orchestration.getCurrentPlan(value.goal.goalId))!.plan.nodes[0];
    await value.orchestration.enqueueGitHubOperation({
      goalId: value.goal.goalId, nodeId: node.nodeId, artifactKind: 'comment',
      operationKind: 'create_comment', idempotencyKey: 'null-comment', payload: { body: 'audit' },
      ...value.fence,
    });
    await controller.drainOutbox(value.goal.goalId, value.fence);
    assert.ok(Number((await value.db('goal_github_outbox').where('state', 'pending').count({ count: '*' }).first())?.count) >= 1);
  });

  test('replanning updates pending payloads and supersedes removed artifacts', async () => {
    const value = await fixture();
    const nested: GoalPlanInput = {
      schemaVersion: 1, baseBranch: 'integration/main', nodes: [
        { key: 'root', kind: 'root_epic', title: 'Root', estimate: 0, acceptanceCriteria: ['done'] },
        { key: 'remove', kind: 'implementation_issue', parentKey: 'root', title: 'Old', estimate: 1, acceptanceCriteria: ['old'] },
      ],
    };
    await value.controller.installPlan(value.goal.goalId, nested, value.fence);
    await value.controller.installPlan(value.goal.goalId, {
      ...nested, nodes: [{ ...nested.nodes[0], title: 'Root revised' }],
    }, value.fence);
    const removed = await value.db('goal_nodes').where({ goal_id: value.goal.goalId, title: 'Old' }).first();
    assert.equal(removed.status, 'cancelled');
    assert.equal(Number((await value.db('goal_github_outbox').where({ node_id: removed.node_id, state: 'superseded' }).count({ count: '*' }).first())?.count), 2);
  });

  test('replanning a remote pending branch adopts a revisioned exact parent base', async () => {
    const value = await fixture();
    const initial: GoalPlanInput = {
      schemaVersion: 1, baseBranch: 'integration/main', nodes: [
        { key: 'root', kind: 'root_epic', title: 'Root', estimate: 0, acceptanceCriteria: ['done'] },
        { key: 'sub', kind: 'sub_epic', parentKey: 'root', title: 'Sub', estimate: 0, acceptanceCriteria: ['done'] },
        { key: 'leaf', kind: 'implementation_issue', parentKey: 'root', title: 'Leaf', estimate: 1, acceptanceCriteria: ['done'] },
      ],
    };
    await value.controller.installPlan(value.goal.goalId, initial, value.fence);
    await value.controller.drainOutbox(value.goal.goalId, value.fence);
    const revised: GoalPlanInput = {
      ...initial,
      nodes: initial.nodes.map((node) => node.key === 'leaf' ? { ...node, parentKey: 'sub' } : node),
    };
    await value.controller.installPlan(value.goal.goalId, revised, value.fence);
    const leaf = (await value.orchestration.getCurrentPlan(value.goal.goalId))!.plan.nodes.find((node) => node.key === 'leaf')!;
    const beforeDrain = (await value.orchestration.getArtifacts(value.goal.goalId)).find((artifact) =>
      artifact.nodeId === leaf.nodeId && artifact.kind === 'branch'
    )!;
    assert.equal(beforeDrain.state, 'expected');
    assert.equal(beforeDrain.remoteId, null);
    assert.equal(beforeDrain.baseBranch, leaf.baseBranch);
    await value.controller.drainOutbox(value.goal.goalId, value.fence);
    const afterDrain = (await value.orchestration.getArtifacts(value.goal.goalId)).find((artifact) =>
      artifact.nodeId === leaf.nodeId && artifact.kind === 'branch'
    )!;
    assert.equal(afterDrain.state, 'present');
    assert.equal(afterDrain.baseBranch, leaf.baseBranch);
  });

  test('two WAL controllers reserve fairly across two goals in one repository', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'goal-fairness-'));
    directories.push(directory);
    const filename = path.join(directory, 'goals.sqlite');
    const firstDb = database(filename);
    await migrate(firstDb);
    const secondDb = database(filename);
    const firstGoals = new GoalRepository(firstDb);
    const secondGoals = new GoalRepository(secondDb);
    const goals = [];
    for (const [index, repository] of [firstGoals, secondGoals].entries()) {
      goals.push(await repository.createGoal({
        ownerUserId: `owner-${index}`, repository: 'octo/shared', objective: 'ship',
        agent: 'codex', requestedModel: 'model', maxActiveTasks: 2,
      }));
    }
    const repositories = [new GoalOrchestrationRepository(firstDb), new GoalOrchestrationRepository(secondDb)];
    const fences: Array<{ leaseOwner: string; leaseEpoch: number }> = [];
    for (const [index, goal] of goals.entries()) {
      const repository = index ? secondGoals : firstGoals;
      const lease = await repository.claimLease(goal.goalId, `controller-${index}`, 60_000);
      const fence = { leaseOwner: `controller-${index}`, leaseEpoch: lease.epoch };
      await repository.transition(goal.goalId, { toState: 'planning', ...fence });
      await repositories[index].installPlan(goal.goalId, singlePlan(), fence);
      const node = (await repositories[index].getCurrentPlan(goal.goalId))!.plan.nodes[0];
      await seedArtifacts(repositories[index], goal.goalId, node, fence, 'octo/shared');
      fences.push(fence);
    }
    const reserved = await Promise.all(goals.map((goal, index) =>
      repositories[index].reserveRunnableNodes(goal.goalId, fences[index], { repositoryMaxActiveTasks: 2 })
    ));
    assert.deepEqual(reserved.map((items) => items.length), [1, 1]);
  });

  test('expired merge lock takeover fences the former controller', async () => {
    const value = await fixture();
    await value.controller.installPlan(value.goal.goalId, singlePlan(), value.fence);
    const node = (await value.orchestration.getCurrentPlan(value.goal.goalId))!.plan.nodes[0];
    assert.equal(await value.orchestration.acquireBranchLock({
      goalId: value.goal.goalId, nodeId: node.nodeId, targetBranch: node.baseBranch,
      owner: 'controller-a', ttlMs: 60_000, fence: value.fence,
    }), true);
    await value.goals.releaseLease(value.goal.goalId, value.fence.leaseOwner, value.fence.leaseEpoch);
    await value.db('goal_branch_locks').where('goal_id', value.goal.goalId)
      .update({ expires_at: new Date(0).toISOString() });
    const lease = await value.goals.claimLease(value.goal.goalId, 'controller-b', 60_000);
    const takeover = { leaseOwner: 'controller-b', leaseEpoch: lease.epoch };
    assert.equal(await value.orchestration.acquireBranchLock({
      goalId: value.goal.goalId, nodeId: node.nodeId, targetBranch: node.baseBranch,
      owner: 'controller-b', ttlMs: 60_000, fence: takeover,
    }), true);
    await assert.rejects(
      value.orchestration.releaseBranchLock(value.goal.goalId, node.baseBranch, 'controller-a', value.fence),
      /lease|fence/i
    );
  });

  test('tick schedules exact-head validation, Ultrafix threshold cycles, and gated auto merge', async () => {
    const value = await fixture({ mergePolicy: 'auto', ultrafix: true });
    const scores = [7, 9];
    const validation = {
      async validate(input: { headSha: string; baseSha: string }) {
        return [{
          kind: 'ci' as const, headSha: input.headSha, baseSha: input.baseSha,
          policyHash: 'auto-policy', result: { checks: ['test'] }, status: 'passed' as const,
        }];
      },
      async runUltrafix(input: { headSha: string; baseSha: string }) {
        return { score: scores.shift()!, headSha: input.headSha, baseSha: input.baseSha };
      },
    };
    const controller = new GoalController(
      value.goals, value.orchestration, value.runtime, value.github, { async emit() {} },
      { controllerId: 'controller-a' }, validation
    );
    const autoPolicy: GoalReadinessPolicy = {
      policyHash: 'auto-policy', requiredEvidence: ['ci', 'ultrafix'], mergePolicy: 'auto',
    };
    await controller.installPlan(value.goal.goalId, singlePlan(), value.fence);
    await controller.tick(value.goal.goalId, value.fence, autoPolicy);
    const attempt = (await value.orchestration.getAttempts(value.goal.goalId))[0];
    value.runtime.executions.set(attempt.dispatchIdentity, {
      dispatchIdentity: attempt.dispatchIdentity, state: 'succeeded', hasDiff: true,
    });
    await controller.tick(value.goal.goalId, value.fence, autoPolicy);
    assert.equal(Number((await value.db('goal_ultrafix_cycles').count({ count: '*' }).first())?.count), 1);
    assert.equal((await value.goals.requireGoal(value.goal.goalId)).state, 'planning');
    await controller.tick(value.goal.goalId, value.fence, autoPolicy);
    assert.equal(Number((await value.db('goal_ultrafix_cycles').count({ count: '*' }).first())?.count), 2);
    assert.equal(Number((await value.db('goal_github_outbox').where({ operation_kind: 'merge_pull_request', state: 'succeeded' }).count({ count: '*' }).first())?.count), 1);
    assert.equal((await value.goals.requireGoal(value.goal.goalId)).state, 'completed');
  });

  test('reconciliation reopens closed PRs and repairs label drift', async () => {
    const value = await fixture();
    await value.controller.installPlan(value.goal.goalId, singlePlan(), value.fence);
    await value.controller.tick(value.goal.goalId, value.fence);
    const attempt = (await value.orchestration.getAttempts(value.goal.goalId))[0];
    value.runtime.executions.set(attempt.dispatchIdentity, {
      dispatchIdentity: attempt.dispatchIdentity, state: 'succeeded', hasDiff: true,
    });
    await value.controller.tick(value.goal.goalId, value.fence);
    for (const [marker, remote] of value.github.remotes) {
      if (remote.kind === 'pull_request') value.github.remotes.set(marker, { ...remote, state: 'closed' });
      if (remote.kind === 'issue') value.github.remotes.set(marker, { ...remote, labels: [] });
    }
    await value.controller.reconcile(value.goal.goalId, value.fence);
    await value.controller.drainOutbox(value.goal.goalId, value.fence);
    assert.ok([...value.github.remotes.values()].some((remote) => remote.kind === 'pull_request' && remote.state === 'present'));
    assert.ok([...value.github.remotes.values()].filter((remote) => remote.kind === 'issue')
      .every((remote) => remote.labels?.includes('propr-goal')));
  });

  test('production scheduler wires the real repositories and startup recovery lifecycle', async () => {
    const value = await fixture();
    await value.goals.releaseLease(value.goal.goalId, value.fence.leaseOwner, value.fence.leaseEpoch);
    const service = new ProductionGoalOrchestrator({
      database: value.db, runtime: value.runtime, github: value.github,
      controller: { controllerId: 'production-controller' },
      supervisor: { controllerId: 'production-controller', pollIntervalMs: 10_000 },
      async readinessPolicy() { return policy; },
    });
    await service.start();
    assert.equal(Number((await value.db('goal_controller_heartbeats').where('goal_id', value.goal.goalId).count({ count: '*' }).first())?.count), 1);
    await service.stop();
  });
});

async function waitForClaim(db: Knex): Promise<Record<string, unknown>> {
  for (let index = 0; index < 50; index += 1) {
    const row = await db('goal_github_outbox').where('state', 'claimed').first('operation_id', 'claim_expires_at');
    if (row?.claim_expires_at) return row as Record<string, unknown>;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Outbox row was not claimed');
}

async function waitForClaimRenewal(db: Knex, initialExpiry: string): Promise<void> {
  for (let index = 0; index < 100; index += 1) {
    const row = await db('goal_github_outbox').where('state', 'claimed').first('claim_expires_at');
    if (row?.claim_expires_at > initialExpiry) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Outbox claim was not renewed during the external call');
}

async function seedArtifacts(
  repository: GoalOrchestrationRepository,
  goalId: string,
  node: ReturnType<typeof singlePlan>['nodes'][number] & { nodeId?: string; headBranch?: string; baseBranch?: string },
  fence: { leaseOwner: string; leaseEpoch: number },
  remoteRepository: string
): Promise<void> {
  for (const kind of ['issue', 'branch'] as const) {
    const operation = await repository.enqueueGitHubOperation({
      goalId, nodeId: node.nodeId!, artifactKind: kind,
      operationKind: kind === 'issue' ? 'create_issue' : 'create_branch', idempotencyKey: `seed:${kind}`,
      head: kind === 'branch' ? node.headBranch : null, base: kind === 'branch' ? node.baseBranch : null,
      payload: {}, ...fence,
    });
    void operation;
    const [claimed] = await repository.claimGitHubOperations(goalId, fence.leaseOwner, 1, fence);
    await repository.adoptGitHubArtifact(claimed, {
      remoteId: `${goalId}-${kind}`, number: kind === 'issue' ? 1 : undefined,
      repository: remoteRepository, kind, marker: claimed.marker,
      headBranch: kind === 'branch' ? node.headBranch : null,
      baseBranch: kind === 'branch' ? node.baseBranch : null, state: 'present',
    }, fence);
  }
}
