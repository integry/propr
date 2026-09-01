import assert from 'node:assert/strict';
import { after, beforeEach, describe, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import knex, { type Knex } from 'knex';
import type { BetterSqliteConnection } from '../src/db/connection.js';
import { up as upGoals } from '../src/db/migrations/20260831000000_create_goal_control_plane.js';
import { up as upOrchestration } from '../src/db/migrations/20260901000000_create_goal_orchestration.js';
import { GoalRepository } from '../src/services/goals/goalRepository.js';
import {
  buildGoalArtifactMarker,
  GoalOrchestrationRepository,
  parseGoalArtifactMarker,
} from '../src/services/goals/goalOrchestrationRepository.js';
import { validateGoalPlan } from '../src/services/goals/goalPlanValidator.js';
import { GoalController } from '../src/services/goals/goalController.js';
import type {
  GoalGitHubPort,
  GoalGitHubRemoteArtifact,
  GoalPlanInput,
} from '../src/services/goals/goalOrchestrationTypes.js';

let database: Knex;
let goals: GoalRepository;
let orchestration: GoalOrchestrationRepository;

function createDatabase(): Knex {
  return knex({
    client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true,
    pool: {
      afterCreate(connection: BetterSqliteConnection, done: (error: Error | null, connection: BetterSqliteConnection) => void) {
        connection.pragma('foreign_keys = ON');
        connection.pragma('journal_mode = WAL');
        done(null, connection);
      },
    },
  });
}

function plan(): GoalPlanInput {
  return {
    schemaVersion: 1,
    baseBranch: 'epic/base-2003',
    nodes: [
      { key: 'root', kind: 'root_epic', title: 'Root', estimate: 0, acceptanceCriteria: ['All work integrated'] },
      { key: 'backend', kind: 'sub_epic', parentKey: 'root', title: 'Backend', estimate: 2, acceptanceCriteria: ['Backend integrated'] },
      { key: 'api', kind: 'implementation_issue', parentKey: 'backend', title: 'API', estimate: 3, acceptanceCriteria: ['API passes'] },
      { key: 'db', kind: 'implementation_issue', parentKey: 'backend', dependsOn: ['api'], title: 'DB', estimate: 2, acceptanceCriteria: ['DB passes'] },
      { key: 'docs', kind: 'implementation_issue', parentKey: 'root', title: 'Docs', estimate: 1, acceptanceCriteria: ['Docs pass'] },
    ],
  };
}

async function setupGoal(maxActiveTasks = 2) {
  const goal = await goals.createGoal({
    ownerUserId: 'owner', repository: 'octo/repo', objective: 'Ship it',
    agent: 'codex', requestedModel: 'gpt-5.6-sol', maxActiveTasks,
  });
  const lease = await goals.claimLease(goal.goalId, 'controller-a', 60_000);
  const fence = { leaseOwner: 'controller-a', leaseEpoch: lease.epoch };
  await goals.transition(goal.goalId, { toState: 'planning', ...fence });
  return { goal, fence };
}

beforeEach(async () => {
  if (database) await database.destroy();
  database = createDatabase();
  await upGoals(database);
  await upOrchestration(database);
  goals = new GoalRepository(database);
  orchestration = new GoalOrchestrationRepository(database);
});

after(async () => { if (database) await database.destroy(); });

describe('durable goal orchestration', () => {
  test('validates a nested plan deterministically and assigns integration bases', () => {
    const first = validateGoalPlan('goal-1', plan());
    const second = validateGoalPlan('goal-1', { ...plan(), nodes: [...plan().nodes].reverse() });
    assert.equal(first.hash, second.hash);
    assert.deepEqual(first.nodes.map((node) => node.nodeId), second.nodes.map((node) => node.nodeId));

    const root = first.nodes.find((node) => node.key === 'root')!;
    const backend = first.nodes.find((node) => node.key === 'backend')!;
    const api = first.nodes.find((node) => node.key === 'api')!;
    const docs = first.nodes.find((node) => node.key === 'docs')!;
    assert.equal(root.baseBranch, 'epic/base-2003');
    assert.equal(backend.baseBranch, root.headBranch);
    assert.equal(api.baseBranch, backend.headBranch);
    assert.equal(docs.baseBranch, root.headBranch);
    assert.notEqual(api.baseBranch, first.baseBranch, 'leaf PR must never leak to the repository/base default');
  });

  test('atomically installs one plan and preserves active work across replans', async () => {
    const { goal, fence } = await setupGoal();
    const installed = await orchestration.installPlan(goal.goalId, plan(), fence);
    const replay = await orchestration.installPlan(goal.goalId, plan(), fence);
    assert.equal(replay.replayed, true);
    assert.equal(replay.revision, installed.revision);
    assert.equal(await database('goal_nodes').where('goal_id', goal.goalId).count({ count: '*' }).first().then((row) => Number(row?.count)), 5);

    const reservations = await orchestration.reserveRunnableNodes(goal.goalId, fence);
    assert.deepEqual(reservations.map((item) => item.node.key).sort(), ['api', 'docs']);
    const withoutActive = plan();
    withoutActive.nodes = withoutActive.nodes.filter((node) => node.key !== 'api');
    withoutActive.nodes = withoutActive.nodes.map((node) => node.key === 'db' ? { ...node, dependsOn: [] } : node);
    await assert.rejects(
      orchestration.installPlan(goal.goalId, withoutActive, fence),
      (error: Error & { code?: string }) => error.code === 'goal_hierarchy_conflict'
    );
  });

  test('enforces dependency readiness and SQL-backed goal capacity', async () => {
    const { goal, fence } = await setupGoal(2);
    await orchestration.installPlan(goal.goalId, plan(), fence);
    const first = await orchestration.reserveRunnableNodes(goal.goalId, fence);
    assert.deepEqual(first.map((item) => item.node.key).sort(), ['api', 'docs']);
    assert.equal((await orchestration.reserveRunnableNodes(goal.goalId, fence)).length, 0);

    const api = first.find((item) => item.node.key === 'api')!;
    const docs = first.find((item) => item.node.key === 'docs')!;
    await orchestration.markAttemptDispatching(goal.goalId, api.attempt.attemptId, fence);
    await orchestration.markAttemptDispatched(goal.goalId, api.attempt.attemptId, { sessionId: 'same-agent-session-a' }, fence);
    await orchestration.markAttemptDispatching(goal.goalId, docs.attempt.attemptId, fence);
    await orchestration.markAttemptDispatched(goal.goalId, docs.attempt.attemptId, { sessionId: 'same-agent-session-a' }, fence);
    await orchestration.finishAttempt(goal.goalId, api.attempt.attemptId, 'succeeded', fence);
    const next = await orchestration.reserveRunnableNodes(goal.goalId, fence);
    assert.deepEqual(next.map((item) => item.node.key), ['db']);
    assert.notEqual(next[0].attempt.executionId, api.attempt.executionId);
  });

  test('snapshots future model and Ultrafix policy per attempt', async () => {
    const { goal, fence } = await setupGoal(1);
    await orchestration.installPlan(goal.goalId, plan(), fence);
    const [first] = await orchestration.reserveRunnableNodes(goal.goalId, fence);
    assert.equal(first.attempt.effectiveModel, 'gpt-5.6-sol');
    assert.equal(first.attempt.parallelismSnapshot, 1);
    assert.equal(first.attempt.ultrafixEnabled, false);

    await orchestration.finishAttempt(goal.goalId, first.attempt.attemptId, 'succeeded', fence);
    await database('goals').where('goal_id', goal.goalId).update({
      requested_model: 'future-model', effective_model: 'future-model',
    });
    const [second] = await orchestration.reserveRunnableNodes(goal.goalId, fence);
    assert.equal(second.attempt.effectiveModel, 'future-model');
    assert.equal((await orchestration.getAttempts(goal.goalId)).find((attempt) => attempt.attemptId === first.attempt.attemptId)?.effectiveModel, 'gpt-5.6-sol');
  });

  test('uses full hidden marker tuples and rejects hostile adoption collisions', async () => {
    const { goal, fence } = await setupGoal();
    const installed = await orchestration.installPlan(goal.goalId, plan(), fence);
    const api = installed.plan.nodes.find((node) => node.key === 'api')!;
    const operation = await orchestration.enqueueGitHubOperation({
      goalId: goal.goalId, nodeId: api.nodeId, artifactKind: 'pull_request',
      operationKind: 'create_pull_request', idempotencyKey: 'api-pr',
      head: api.headBranch, base: api.baseBranch, payload: { draft: false }, ...fence,
    });
    assert.deepEqual(parseGoalArtifactMarker(operation.marker), {
      schemaVersion: 1, repository: 'octo/repo', goalId: goal.goalId,
      nodeId: api.nodeId, artifactKind: 'pull_request', head: api.headBranch, base: api.baseBranch,
    });
    const [claimed] = await orchestration.claimGitHubOperations(goal.goalId, 'controller-a', 1, fence);
    const hostileMarker = buildGoalArtifactMarker({
      ...parseGoalArtifactMarker(claimed.marker), base: 'main',
    });
    await assert.rejects(
      orchestration.adoptGitHubArtifact(goal.goalId, claimed.operationId, {
        remoteId: '1', number: 1, repository: 'octo/repo', kind: 'pull_request',
        marker: hostileMarker, headBranch: api.headBranch, baseBranch: 'main', state: 'present',
      }, fence),
      (error: Error & { code?: string }) => error.code === 'goal_idempotency_conflict'
    );
  });

  test('adopts ambiguous remote success instead of posting a duplicate', async () => {
    const { goal, fence } = await setupGoal();
    const remotes = new Map<string, GoalGitHubRemoteArtifact>();
    let executeCalls = 0;
    let failAfterFirstRemote = true;
    const github: GoalGitHubPort = {
      async findByMarker(marker) { return remotes.get(buildGoalArtifactMarker(marker)) ?? null; },
      async execute(operation, marker) {
        executeCalls += 1;
        const remote: GoalGitHubRemoteArtifact = {
          remoteId: `remote-${executeCalls}`,
          number: executeCalls,
          repository: marker.repository,
          kind: marker.artifactKind,
          marker: operation.marker,
          headBranch: marker.head,
          baseBranch: marker.base,
          state: 'present',
        };
        remotes.set(operation.marker, remote);
        if (failAfterFirstRemote) {
          failAfterFirstRemote = false;
          throw new Error('connection lost after remote accepted request');
        }
        return remote;
      },
      async inspectGoal() { return [...remotes.values()]; },
      async branchHasDiff() { return true; },
    };
    const controller = new GoalController(
      goals,
      orchestration,
      { async dispatch() { return { sessionId: 'runtime-session' }; } },
      github,
      { async emit() {} },
      { controllerId: 'controller-a' }
    );
    await controller.installPlan(goal.goalId, plan(), fence);
    await controller.drainOutbox(goal.goalId, fence);
    const callsAfterAmbiguousSuccess = executeCalls;
    await database('goal_github_outbox').where('state', 'pending').update({ available_at: '2000-01-01T00:00:00.000Z' });
    await controller.drainOutbox(goal.goalId, fence);
    assert.equal(executeCalls, callsAfterAmbiguousSuccess, 'retry must adopt the marker-bound artifact');
    assert.equal(Number((await database('goal_github_artifacts').whereNotNull('remote_id').count({ count: '*' }).first())?.count), remotes.size);
  });

  test('fails completion closed on missing or stale exact-head evidence', async () => {
    const { goal, fence } = await setupGoal();
    const installed = await orchestration.installPlan(goal.goalId, plan(), fence);
    const root = installed.plan.nodes.find((node) => node.key === 'root')!;
    await orchestration.recordNoDiffArtifact(goal.goalId, root.nodeId, fence);
    const readiness = await orchestration.goalCompletionReadiness(goal.goalId, {
      policyHash: 'policy-v1', requiredEvidence: ['ci'], expectedChecks: ['test'], mergePolicy: 'manual',
    });
    assert.equal(readiness.ready, false);
    assert.ok(readiness.reasons.includes('descendants_not_integrated'));
  });

  test('invalidates policy evidence when the exact PR head changes', async () => {
    const { goal, fence } = await setupGoal();
    const tinyPlan: GoalPlanInput = {
      schemaVersion: 1,
      baseBranch: 'epic/base-2003',
      nodes: [
        { key: 'root', kind: 'root_epic', title: 'Root', estimate: 0, acceptanceCriteria: ['Ready'] },
        { key: 'noop', kind: 'implementation_issue', parentKey: 'root', title: 'No-op', estimate: 0, acceptanceCriteria: ['No code needed'], noCode: true },
      ],
    };
    const installed = await orchestration.installPlan(goal.goalId, tinyPlan, fence);
    await orchestration.reserveRunnableNodes(goal.goalId, fence);
    const root = installed.plan.nodes.find((node) => node.key === 'root')!;
    const operation = await orchestration.enqueueGitHubOperation({
      goalId: goal.goalId, nodeId: root.nodeId, artifactKind: 'pull_request',
      operationKind: 'create_pull_request', idempotencyKey: 'root-pr',
      head: root.headBranch, base: root.baseBranch, payload: {}, ...fence,
    });
    const [claimed] = await orchestration.claimGitHubOperations(goal.goalId, 'controller-a', 1, fence);
    await orchestration.adoptGitHubArtifact(goal.goalId, claimed.operationId, {
      remoteId: 'root-pr', number: 99, repository: 'octo/repo', kind: 'pull_request',
      marker: operation.marker, headBranch: root.headBranch, baseBranch: root.baseBranch,
      headSha: 'head-new', baseSha: 'base-1', state: 'present',
    }, fence);
    await orchestration.recordEvidence(goal.goalId, root.nodeId, {
      kind: 'ci', headSha: 'head-old', baseSha: 'base-1', policyHash: 'policy-v1',
      expectedChecks: ['test'], result: { conclusion: 'success' }, status: 'passed', ...fence,
    });
    const policy = { policyHash: 'policy-v1', requiredEvidence: ['ci'] as const, expectedChecks: ['test'], mergePolicy: 'manual' as const };
    const stale = await orchestration.goalCompletionReadiness(goal.goalId, { ...policy, requiredEvidence: [...policy.requiredEvidence] });
    assert.equal(stale.ready, false);
    assert.ok(stale.reasons.includes('ci_evidence_missing_or_unsuccessful'));
    await orchestration.recordEvidence(goal.goalId, root.nodeId, {
      kind: 'ci', headSha: 'head-new', baseSha: 'base-1', policyHash: 'policy-v1',
      expectedChecks: ['test'], result: { conclusion: 'success' }, status: 'passed', ...fence,
    });
    const exact = await orchestration.goalCompletionReadiness(goal.goalId, { ...policy, requiredEvidence: [...policy.requiredEvidence] });
    assert.equal(exact.ready, true);
    assert.equal(exact.terminalAction, 'complete');
  });

  test('controller capability boundary has no target-code mutation primitive', async () => {
    const source = await readFile(new URL('../src/services/goals/goalController.ts', import.meta.url), 'utf8');
    for (const forbidden of ['node:child_process', 'node:fs', 'simple-git', 'dockerExecutor', 'worktree']) {
      assert.equal(new RegExp(`from ['\"][^'\"]*${forbidden}[^'\"]*['\"]`).test(source), false, `controller must not import ${forbidden}`);
    }
    assert.equal(source.includes('GoalRuntimePort'), true);
    assert.equal(source.includes('GoalGitHubPort'), true);
  });
});
