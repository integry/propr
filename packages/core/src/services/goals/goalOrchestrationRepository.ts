/* eslint-disable max-lines -- orchestration state transitions share one fenced transaction boundary */
import crypto from 'node:crypto';
import type { Knex } from 'knex';
import { GOAL_ERROR_CODES, type GoalNodeKind } from '@propr/shared';
import type { GoalLeaseFence, GoalRecord } from './goalTypes.js';
import {
  GoalError,
  boundedText,
  goalTransaction,
  guardLease,
  idempotencyKey,
  nowIso,
} from './goalRepositorySupport.js';
import { validateGoalPlan } from './goalPlanValidator.js';
import type {
  GoalArtifactKind,
  GoalArtifactMarker,
  GoalArtifactState,
  GoalAttempt,
  GoalAttemptStatus,
  GoalCompletionReadiness,
  GoalDispatchReservation,
  GoalGitHubArtifact,
  GoalGitHubRemoteArtifact,
  GoalNodeReadiness,
  GoalOutboxOperation,
  GoalOutboxOperationKind,
  GoalPlanInput,
  GoalReadinessPolicy,
  GoalValidationEvidenceInput,
  ValidatedGoalPlan,
  ValidatedGoalPlanNode,
} from './goalOrchestrationTypes.js';

const ACTIVE_ATTEMPT_STATES: GoalAttemptStatus[] = ['reserved', 'dispatching', 'running', 'safe_boundary'];
const COUNTED_RESERVATION_STATES = ['reserved', 'active'];

interface AttemptRow {
  attempt_id: string; goal_id: string; node_id: string; execution_id: string;
  attempt_number: number; session_id: string | null; status: GoalAttemptStatus;
  requested_model: string; effective_model: string; parallelism_snapshot: number;
  ultrafix_enabled: number; ultrafix_goal: number | null; ultrafix_max_cycles: number | null;
  lease_generation: number; external_ref: string | null; started_at: string | null;
  finished_at: string | null; created_at: string; updated_at: string;
}

interface ArtifactRow {
  artifact_id: string; goal_id: string; node_id: string; kind: GoalArtifactKind;
  repository: string; remote_id: string | null; number: number | null; url: string | null;
  head_branch: string | null; base_branch: string | null; head_sha: string | null;
  base_sha: string | null; state: GoalArtifactState; marker: string; last_observed_at: string | null;
}

interface NodeSpecRow {
  node_id: string; goal_id: string; plan_revision: number; correlation_key: string;
  acceptance_criteria_json: string; estimate: number; depth: number; base_branch: string;
  head_branch: string; no_code: number;
}

interface OutboxRow {
  operation_id: string; goal_id: string; node_id: string; artifact_id: string | null;
  operation_kind: GoalOutboxOperationKind; idempotency_key: string; marker: string;
  payload_json: string; attempts: number;
}

export class GoalOrchestrationRepository {
  constructor(private readonly db: Knex) {}

  async installPlan(goalId: string, input: GoalPlanInput, fence: GoalLeaseFence): Promise<{ revision: number; plan: ValidatedGoalPlan; replayed: boolean }> {
    const plan = validateGoalPlan(goalId, input);
    return goalTransaction(this.db, async (trx) => {
      await guardLease(trx, goalId, fence);
      const latest = await trx('goal_plan_revisions').where('goal_id', goalId).orderBy('revision', 'desc').first();
      if (latest?.plan_hash === plan.hash) return { revision: latest.revision as number, plan, replayed: true };
      await assertReplacementPreservesWork(trx, goalId, plan);
      const revision = Number(latest?.revision ?? 0) + 1;
      const diff = await planDiff(trx, goalId, plan);
      await trx('goal_plan_revisions').insert({
        goal_id: goalId,
        revision,
        schema_version: 1,
        plan_hash: plan.hash,
        plan_json: JSON.stringify(plan),
        change_summary_json: JSON.stringify(diff),
        created_at: nowIso(),
      });

      const currentIds = plan.nodes.map((node) => node.nodeId);
      const prior = await trx('goal_nodes').where('goal_id', goalId).select('node_id');
      const omitted = prior.map((row) => row.node_id as string).filter((nodeId) => !currentIds.includes(nodeId));
      if (omitted.length > 0) {
        await trx('goal_nodes').where('goal_id', goalId).whereIn('node_id', omitted).whereIn('status', ['pending', 'blocked'])
          .update({ status: 'cancelled', updated_at: nowIso() });
      }

      for (const node of plan.nodes) {
        const existing = await trx('goal_nodes').where({ goal_id: goalId, node_id: node.nodeId }).first();
        if (!existing) {
          await trx('goal_nodes').insert({
            node_id: node.nodeId,
            requested_node_id: node.nodeId,
            goal_id: goalId,
            parent_node_id: node.parentNodeId,
            kind: node.kind,
            idempotency_key: `plan-node:${node.key}`,
            external_ref: null,
            external_kind: null,
            title: node.title,
            status: 'pending',
            attempt_count: 0,
            order_index: node.orderIndex,
            created_at: nowIso(),
            updated_at: nowIso(),
          });
        } else {
          await trx('goal_nodes').where({ goal_id: goalId, node_id: node.nodeId }).update({
            parent_node_id: node.parentNodeId,
            kind: node.kind,
            title: node.title,
            order_index: node.orderIndex,
            ...(existing.status === 'cancelled' ? { status: 'pending' } : {}),
            updated_at: nowIso(),
          });
        }
        await trx('goal_node_specs').insert(toSpecRecord(goalId, revision, node)).onConflict('node_id').merge({
          plan_revision: revision,
          acceptance_criteria_json: JSON.stringify(node.acceptanceCriteria),
          estimate: node.estimate,
          depth: node.depth,
          base_branch: node.baseBranch,
          head_branch: node.headBranch,
          no_code: node.noCode,
          updated_at: nowIso(),
        });
      }
      await trx('goal_node_dependencies').where('goal_id', goalId).whereIn('node_id', currentIds).delete();
      const dependencies = plan.nodes.flatMap((node) => node.dependencyNodeIds.map((dependency) => ({
        goal_id: goalId,
        node_id: node.nodeId,
        depends_on_node_id: dependency,
        created_at: nowIso(),
      })));
      if (dependencies.length > 0) await trx('goal_node_dependencies').insert(dependencies);
      return { revision, plan, replayed: false };
    });
  }

  async getCurrentPlan(goalId: string): Promise<{ revision: number; plan: ValidatedGoalPlan } | null> {
    const row = await this.db('goal_plan_revisions').where('goal_id', goalId).orderBy('revision', 'desc').first();
    if (!row) return null;
    return { revision: row.revision as number, plan: JSON.parse(row.plan_json as string) as ValidatedGoalPlan };
  }

  async reserveRunnableNodes(
    goalId: string,
    fence: GoalLeaseFence,
    options: { repositoryMaxActiveTasks?: number; ttlMs?: number } = {}
  ): Promise<GoalDispatchReservation[]> {
    const repositoryLimit = validatePositive(options.repositoryMaxActiveTasks ?? 20, 'repositoryMaxActiveTasks', 1000);
    const ttlMs = validatePositive(options.ttlMs ?? 5 * 60_000, 'ttlMs', 86_400_000);
    return goalTransaction(this.db, async (trx) => {
      const goal = await guardLease(trx, goalId, fence);
      if (!['planning', 'running', 'recovering'].includes(goal.state)) return [];
      await expireCapacity(trx);
      const goalUsed = await countReservations(trx, { goal_id: goalId });
      const repositoryUsed = await countReservations(trx, { repository: goal.repository });
      const available = Math.max(0, Math.min(goal.max_active_tasks - goalUsed, repositoryLimit - repositoryUsed));
      if (available === 0) return [];
      const revisionRow = await trx('goal_plan_revisions').where('goal_id', goalId).orderBy('revision', 'desc').first('revision');
      if (!revisionRow) return [];
      const rows = await trx('goal_nodes as n')
        .join('goal_node_specs as s', 's.node_id', 'n.node_id')
        .where({ 'n.goal_id': goalId, 's.plan_revision': revisionRow.revision })
        .whereIn('n.kind', ['implementation_issue', 'implementation_pr'])
        .whereIn('n.status', ['pending', 'blocked'])
        .select('n.*', 's.correlation_key', 's.acceptance_criteria_json', 's.estimate', 's.depth', 's.base_branch', 's.head_branch', 's.no_code')
        .orderBy('n.order_index', 'asc');
      const dependencies = await trx('goal_node_dependencies as d')
        .join('goal_nodes as dependency', 'dependency.node_id', 'd.depends_on_node_id')
        .where('d.goal_id', goalId)
        .select('d.node_id', 'dependency.status');
      const blocked = new Set(dependencies.filter((edge) => edge.status !== 'completed').map((edge) => edge.node_id as string));
      const activeNodes = new Set((await trx('goal_attempts').where('goal_id', goalId).whereIn('status', ACTIVE_ATTEMPT_STATES).pluck('node_id')) as string[]);
      const reservations: GoalDispatchReservation[] = [];
      for (const row of rows) {
        if (reservations.length >= available) break;
        if (blocked.has(row.node_id as string) || activeNodes.has(row.node_id as string)) continue;
        if (row.no_code) {
          await trx('goal_nodes').where({ goal_id: goalId, node_id: row.node_id }).update({ status: 'completed', updated_at: nowIso() });
          continue;
        }
        const attemptNumberRow = await trx('goal_attempts').where({ goal_id: goalId, node_id: row.node_id }).max({ max: 'attempt_number' }).first();
        const attemptNumber = Number(attemptNumberRow?.max ?? 0) + 1;
        const attemptId = crypto.randomUUID();
        const executionId = crypto.randomUUID();
        const reservationId = crypto.randomUUID();
        const createdAt = nowIso();
        const expiresAt = nowIso(Date.now() + ttlMs);
        const attemptRecord: AttemptRow = {
          attempt_id: attemptId, goal_id: goalId, node_id: row.node_id as string,
          execution_id: executionId, attempt_number: attemptNumber, session_id: null,
          status: 'reserved', requested_model: goal.requested_model,
          effective_model: goal.effective_model, parallelism_snapshot: goal.max_active_tasks,
          ultrafix_enabled: goal.ultrafix_enabled, ultrafix_goal: goal.ultrafix_goal,
          ultrafix_max_cycles: goal.ultrafix_max_cycles, lease_generation: fence.leaseEpoch,
          external_ref: null, started_at: null, finished_at: null,
          created_at: createdAt, updated_at: createdAt,
        };
        await trx('goal_attempts').insert(attemptRecord);
        await trx('goal_capacity_reservations').insert({
          reservation_id: reservationId, goal_id: goalId, repository: goal.repository,
          node_id: row.node_id, attempt_id: attemptId, state: 'reserved',
          lease_generation: fence.leaseEpoch, expires_at: expiresAt, released_at: null,
          created_at: createdAt,
        });
        await trx('goal_nodes').where({ goal_id: goalId, node_id: row.node_id }).update({
          status: 'in_progress', attempt_count: attemptNumber, updated_at: createdAt,
        });
        reservations.push({
          reservationId,
          expiresAt,
          attempt: toAttempt(attemptRecord),
          node: { ...toValidatedNode(row), status: 'in_progress' },
        });
      }
      return reservations;
    });
  }

  async markAttemptDispatched(goalId: string, attemptId: string, result: { sessionId: string; externalRef?: string }, fence: GoalLeaseFence): Promise<GoalAttempt> {
    return this.updateAttempt(goalId, attemptId, fence, async (trx, attempt) => {
      if (!['reserved', 'dispatching', 'running'].includes(attempt.status)) invalidState('Attempt is not dispatchable');
      const timestamp = nowIso();
      await trx('goal_attempts').where({ goal_id: goalId, attempt_id: attemptId }).update({
        status: 'running', session_id: boundedText(result.sessionId, 'sessionId'),
        external_ref: result.externalRef == null ? attempt.external_ref : boundedText(result.externalRef, 'externalRef'),
        started_at: attempt.started_at ?? timestamp, updated_at: timestamp,
      });
      await trx('goal_capacity_reservations').where({ goal_id: goalId, attempt_id: attemptId }).update({ state: 'active' });
    });
  }

  async markAttemptDispatching(goalId: string, attemptId: string, fence: GoalLeaseFence): Promise<GoalAttempt> {
    return this.updateAttempt(goalId, attemptId, fence, async (trx, attempt) => {
      if (attempt.status !== 'reserved') invalidState('Only a reserved attempt can begin dispatch');
      await trx('goal_attempts').where({ goal_id: goalId, attempt_id: attemptId }).update({ status: 'dispatching', updated_at: nowIso() });
    });
  }

  async finishAttempt(goalId: string, attemptId: string, status: 'succeeded' | 'failed' | 'cancelled', fence: GoalLeaseFence): Promise<GoalAttempt> {
    return this.updateAttempt(goalId, attemptId, fence, async (trx, attempt) => {
      if (!ACTIVE_ATTEMPT_STATES.includes(attempt.status)) {
        if (attempt.status === status) return;
        invalidState('Attempt is already terminal');
      }
      const timestamp = nowIso();
      await trx('goal_attempts').where({ goal_id: goalId, attempt_id: attemptId }).update({ status, finished_at: timestamp, updated_at: timestamp });
      await trx('goal_capacity_reservations').where({ goal_id: goalId, attempt_id: attemptId }).whereIn('state', COUNTED_RESERVATION_STATES)
        .update({ state: 'released', released_at: timestamp });
      await trx('goal_nodes').where({ goal_id: goalId, node_id: attempt.node_id }).update({
        status: status === 'succeeded' ? 'completed' : status === 'failed' ? 'failed' : 'cancelled', updated_at: timestamp,
      });
    });
  }

  async markAttemptSafeBoundary(goalId: string, attemptId: string, fence: GoalLeaseFence): Promise<GoalAttempt> {
    return this.updateAttempt(goalId, attemptId, fence, async (trx, attempt) => {
      if (attempt.status === 'safe_boundary') return;
      if (attempt.status !== 'running') invalidState('Only a running attempt can enter a safe boundary');
      await trx('goal_attempts').where({ goal_id: goalId, attempt_id: attemptId }).update({ status: 'safe_boundary', updated_at: nowIso() });
    });
  }

  async resumeAttempt(goalId: string, attemptId: string, fence: GoalLeaseFence): Promise<GoalAttempt> {
    return this.updateAttempt(goalId, attemptId, fence, async (trx, attempt) => {
      if (attempt.status === 'running') return;
      if (attempt.status !== 'safe_boundary') invalidState('Only an attempt at a safe boundary can resume');
      await trx('goal_attempts').where({ goal_id: goalId, attempt_id: attemptId }).update({ status: 'running', updated_at: nowIso() });
    });
  }

  async releaseUndispatchedAttemptsForPause(goalId: string, fence: GoalLeaseFence): Promise<void> {
    await goalTransaction(this.db, async (trx) => {
      await guardLease(trx, goalId, fence);
      const attempts = await trx<AttemptRow>('goal_attempts').where({ goal_id: goalId, status: 'reserved' });
      if (attempts.length === 0) return;
      const timestamp = nowIso();
      const attemptIds = attempts.map((attempt) => attempt.attempt_id);
      await trx('goal_attempts').whereIn('attempt_id', attemptIds).update({ status: 'cancelled', finished_at: timestamp, updated_at: timestamp });
      await trx('goal_capacity_reservations').whereIn('attempt_id', attemptIds).update({ state: 'released', released_at: timestamp });
      await trx('goal_nodes').where('goal_id', goalId).whereIn('node_id', attempts.map((attempt) => attempt.node_id))
        .where('status', 'in_progress').update({ status: 'pending', updated_at: timestamp });
    });
  }

  async getAttempts(goalId: string, nodeId?: string): Promise<GoalAttempt[]> {
    const query = this.db<AttemptRow>('goal_attempts').where('goal_id', goalId);
    if (nodeId) query.andWhere('node_id', nodeId);
    return (await query.orderBy(['node_id', 'attempt_number'])).map(toAttempt);
  }

  async assertFence(goalId: string, fence: GoalLeaseFence): Promise<void> {
    await goalTransaction(this.db, async (trx) => { await guardLease(trx, goalId, fence); });
  }

  // Lock identity, expiry, and lease fencing are intentionally explicit at this persistence boundary.
  // eslint-disable-next-line max-params
  async acquireBranchLock(goalId: string, nodeId: string, targetBranch: string, owner: string, ttlMs: number, fence: GoalLeaseFence): Promise<boolean> {
    const lockOwner = boundedText(owner, 'owner') as string;
    const branch = boundedText(targetBranch, 'targetBranch') as string;
    validatePositive(ttlMs, 'ttlMs', 86_400_000);
    return goalTransaction(this.db, async (trx) => {
      const goal = await guardLease(trx, goalId, fence);
      const timestamp = nowIso();
      await trx('goal_branch_locks').where('expires_at', '<=', timestamp).delete();
      const inserted = await trx('goal_branch_locks').insert({
        repository: goal.repository, target_branch: branch, goal_id: goalId, node_id: nodeId,
        owner: lockOwner, lease_generation: fence.leaseEpoch,
        expires_at: nowIso(Date.now() + ttlMs), created_at: timestamp,
      }).onConflict(['repository', 'target_branch']).ignore();
      return inserted.length > 0;
    });
  }

  async releaseBranchLock(goalId: string, targetBranch: string, owner: string, fence: GoalLeaseFence): Promise<void> {
    await goalTransaction(this.db, async (trx) => {
      const goal = await guardLease(trx, goalId, fence);
      await trx('goal_branch_locks').where({
        repository: goal.repository, target_branch: targetBranch, owner,
        goal_id: goalId, lease_generation: fence.leaseEpoch,
      }).delete();
    });
  }

  async enqueueGitHubOperation(input: {
    goalId: string; nodeId: string; artifactKind: GoalArtifactKind;
    operationKind: GoalOutboxOperationKind; payload: Record<string, unknown>;
    idempotencyKey: string; head?: string | null; base?: string | null;
  } & GoalLeaseFence): Promise<GoalOutboxOperation> {
    const key = idempotencyKey(input.idempotencyKey);
    return goalTransaction(this.db, async (trx) => {
      const goal = await guardLease(trx, input.goalId, input);
      const markerTuple: GoalArtifactMarker = {
        schemaVersion: 1, repository: goal.repository, goalId: input.goalId,
        nodeId: input.nodeId, artifactKind: input.artifactKind,
        head: input.head ?? null, base: input.base ?? null,
      };
      const marker = buildGoalArtifactMarker(markerTuple);
      const existing = await trx<OutboxRow>('goal_github_outbox').where({ goal_id: input.goalId, idempotency_key: key }).first();
      if (existing) {
        const operation = toOutbox(existing);
        if (operation.operationKind !== input.operationKind || operation.marker !== marker || JSON.stringify(operation.payload) !== JSON.stringify(input.payload)) {
          throw new GoalError(GOAL_ERROR_CODES.idempotencyConflict, 'GitHub operation key was reused with a different payload', 409);
        }
        return operation;
      }
      const artifactId = deterministicArtifactId(input.goalId, input.nodeId, input.artifactKind);
      await trx('goal_github_artifacts').insert({
        artifact_id: artifactId, goal_id: input.goalId, node_id: input.nodeId,
        kind: input.artifactKind, repository: goal.repository, remote_id: null, number: null,
        url: null, head_branch: input.head ?? null, base_branch: input.base ?? null,
        head_sha: null, base_sha: null, state: 'expected', marker,
        last_observed_at: null, created_at: nowIso(), updated_at: nowIso(),
      }).onConflict(['goal_id', 'node_id', 'kind']).ignore();
      const record: OutboxRow = {
        operation_id: crypto.randomUUID(), goal_id: input.goalId, node_id: input.nodeId,
        artifact_id: artifactId, operation_kind: input.operationKind,
        idempotency_key: key, marker, payload_json: JSON.stringify(input.payload), attempts: 0,
      };
      await trx('goal_github_outbox').insert({
        ...record, state: 'pending', claimed_by: null, claim_generation: null,
        claim_expires_at: null, last_error: null, available_at: nowIso(),
        completed_at: null, created_at: nowIso(), updated_at: nowIso(),
      });
      return toOutbox(record);
    });
  }

  async claimGitHubOperations(goalId: string, owner: string, limit: number, fence: GoalLeaseFence): Promise<GoalOutboxOperation[]> {
    const count = validatePositive(limit, 'limit', 100);
    return goalTransaction(this.db, async (trx) => {
      await guardLease(trx, goalId, fence);
      const timestamp = nowIso();
      await trx('goal_github_outbox').where({ goal_id: goalId, state: 'claimed' }).andWhere('claim_expires_at', '<=', timestamp)
        .update({ state: 'pending', claimed_by: null, claim_generation: null, claim_expires_at: null, updated_at: timestamp });
      const rows = await trx<OutboxRow>('goal_github_outbox').where('goal_id', goalId).andWhere('state', 'pending')
        .andWhere('available_at', '<=', timestamp).orderBy('created_at').limit(count);
      if (rows.length === 0) return [];
      const ids = rows.map((row) => row.operation_id);
      await trx('goal_github_outbox').whereIn('operation_id', ids).update({
        state: 'claimed', claimed_by: owner, claim_generation: fence.leaseEpoch,
        claim_expires_at: nowIso(Date.now() + 60_000), attempts: trx.raw('attempts + 1'), updated_at: timestamp,
      });
      return rows.map((row) => toOutbox({ ...row, attempts: row.attempts + 1 }));
    });
  }

  async adoptGitHubArtifact(goalId: string, operationId: string, remote: GoalGitHubRemoteArtifact, fence: GoalLeaseFence): Promise<GoalGitHubArtifact> {
    return goalTransaction(this.db, async (trx) => {
      await guardLease(trx, goalId, fence);
      const operation = await trx<OutboxRow>('goal_github_outbox').where({ goal_id: goalId, operation_id: operationId }).first();
      if (!operation) throw new GoalError(GOAL_ERROR_CODES.notFound, 'Outbox operation not found', 404);
      const expected = parseGoalArtifactMarker(operation.marker);
      assertRemoteMatchesMarker(remote, expected);
      const timestamp = nowIso();
      await trx('goal_github_artifacts').where('artifact_id', operation.artifact_id).update({
        remote_id: remote.remoteId, number: remote.number ?? null, url: remote.url ?? null,
        head_branch: remote.headBranch ?? expected.head, base_branch: remote.baseBranch ?? expected.base,
        head_sha: remote.headSha ?? null, base_sha: remote.baseSha ?? null, state: remote.state,
        last_observed_at: timestamp, updated_at: timestamp,
      });
      await trx('goal_github_outbox').where({ operation_id: operationId, claim_generation: fence.leaseEpoch }).update({
        state: 'succeeded', completed_at: timestamp, claimed_by: null, claim_expires_at: null, updated_at: timestamp,
      });
      const row = await trx<ArtifactRow>('goal_github_artifacts').where('artifact_id', operation.artifact_id).first();
      return toArtifact(row!);
    });
  }

  async completeNoArtifactOperation(goalId: string, operationId: string, fence: GoalLeaseFence): Promise<void> {
    await goalTransaction(this.db, async (trx) => {
      await guardLease(trx, goalId, fence);
      const changed = await trx('goal_github_outbox').where({ goal_id: goalId, operation_id: operationId, claim_generation: fence.leaseEpoch })
        .update({ state: 'succeeded', completed_at: nowIso(), claimed_by: null, claim_expires_at: null, updated_at: nowIso() });
      if (changed !== 1) throw new GoalError(GOAL_ERROR_CODES.staleLease, 'Outbox claim is stale', 409);
    });
  }

  async retryGitHubOperation(goalId: string, operationId: string, error: string, fence: GoalLeaseFence): Promise<void> {
    await goalTransaction(this.db, async (trx) => {
      await guardLease(trx, goalId, fence);
      await trx('goal_github_outbox').where({ goal_id: goalId, operation_id: operationId, claim_generation: fence.leaseEpoch }).update({
        state: 'pending', claimed_by: null, claim_generation: null, claim_expires_at: null,
        last_error: error.slice(0, 2000), available_at: nowIso(Date.now() + 1000), updated_at: nowIso(),
      });
    });
  }

  async reconcileArtifacts(goalId: string, remotes: GoalGitHubRemoteArtifact[], fence: GoalLeaseFence): Promise<void> {
    await goalTransaction(this.db, async (trx) => {
      await guardLease(trx, goalId, fence);
      const artifacts = await trx<ArtifactRow>('goal_github_artifacts').where('goal_id', goalId);
      const remoteByMarker = new Map(remotes.map((remote) => [remote.marker, remote]));
      for (const artifact of artifacts) {
        const remote = remoteByMarker.get(artifact.marker);
        if (!remote) {
          if (artifact.remote_id !== null) {
            await trx('goal_github_artifacts').where('artifact_id', artifact.artifact_id).update({ state: 'deleted', last_observed_at: nowIso(), updated_at: nowIso() });
            // Re-open the original operation rather than allocating a second
            // identity. A recreated branch/PR therefore keeps its durable key.
            await trx('goal_github_outbox').where({ artifact_id: artifact.artifact_id, state: 'succeeded' }).update({
              state: 'pending', completed_at: null, available_at: nowIso(), updated_at: nowIso(),
            });
          }
          continue;
        }
        assertRemoteMatchesMarker(remote, parseGoalArtifactMarker(artifact.marker));
        await trx('goal_github_artifacts').where('artifact_id', artifact.artifact_id).update({
          remote_id: remote.remoteId, number: remote.number ?? null, url: remote.url ?? null,
          head_branch: remote.headBranch ?? artifact.head_branch, base_branch: remote.baseBranch ?? artifact.base_branch,
          head_sha: remote.headSha ?? null, base_sha: remote.baseSha ?? null, state: remote.state,
          last_observed_at: nowIso(), updated_at: nowIso(),
        });
      }
    });
  }

  async getArtifacts(goalId: string): Promise<GoalGitHubArtifact[]> {
    return (await this.db<ArtifactRow>('goal_github_artifacts').where('goal_id', goalId).orderBy(['node_id', 'kind'])).map(toArtifact);
  }

  async descendantsIntegrated(goalId: string, nodeId: string): Promise<boolean> {
    const descendants = await descendantIds(this.db, goalId, nodeId);
    if (descendants.length === 0) return true;
    const rows = await this.db('goal_nodes as n').join('goal_node_specs as s', 's.node_id', 'n.node_id')
      .where('n.goal_id', goalId).whereIn('n.node_id', descendants)
      .select('n.node_id', 'n.kind', 'n.status', 's.no_code');
    const artifacts = await this.db<ArtifactRow>('goal_github_artifacts').where('goal_id', goalId)
      .whereIn('node_id', descendants).andWhere('kind', 'pull_request');
    const byNode = new Map(artifacts.map((artifact) => [artifact.node_id, artifact]));
    return rows.every((row) => {
      if (row.no_code) return row.kind === 'implementation_issue' || row.kind === 'implementation_pr'
        ? row.status === 'completed'
        : true;
      if ((row.kind === 'implementation_issue' || row.kind === 'implementation_pr') && row.status !== 'completed') return false;
      return ['merged', 'no_diff'].includes(byNode.get(row.node_id as string)?.state ?? 'expected');
    });
  }

  // Cycle identity and exact-SHA evidence are kept explicit at this persistence boundary.
  // eslint-disable-next-line max-params
  async startUltrafixCycle(goalId: string, nodeId: string, attemptId: string, headSha: string, fence: GoalLeaseFence): Promise<number> {
    return goalTransaction(this.db, async (trx) => {
      await guardLease(trx, goalId, fence);
      const attempt = await trx<AttemptRow>('goal_attempts').where({ goal_id: goalId, node_id: nodeId, attempt_id: attemptId }).first();
      if (!attempt) throw new GoalError(GOAL_ERROR_CODES.notFound, 'Goal attempt not found', 404);
      if (!attempt.ultrafix_enabled || attempt.ultrafix_max_cycles === null) invalidState('Ultrafix is not enabled for this attempt snapshot');
      const latest = await trx('goal_ultrafix_cycles').where({ goal_id: goalId, node_id: nodeId }).max({ max: 'cycle' }).first();
      const cycle = Number(latest?.max ?? 0) + 1;
      if (cycle > attempt.ultrafix_max_cycles) invalidState('Ultrafix cycle snapshot has been exhausted');
      await trx('goal_ultrafix_cycles').insert({
        goal_id: goalId, node_id: nodeId, cycle, attempt_id: attemptId,
        head_sha: boundedText(headSha, 'headSha') as string, status: 'running',
        score: null, created_at: nowIso(), completed_at: null,
      });
      return cycle;
    });
  }

  // Cycle identity, outcome, and lease fencing are kept explicit at this persistence boundary.
  // eslint-disable-next-line max-params
  async finishUltrafixCycle(
    goalId: string,
    nodeId: string,
    cycle: number,
    result: { status: 'passed' | 'failed' | 'exhausted'; score?: number | null },
    fence: GoalLeaseFence
  ): Promise<void> {
    await goalTransaction(this.db, async (trx) => {
      await guardLease(trx, goalId, fence);
      if (!Number.isSafeInteger(cycle) || cycle < 1) throw new GoalError(GOAL_ERROR_CODES.validation, 'cycle must be a positive integer', 400);
      if (result.score != null && (!Number.isInteger(result.score) || result.score < 0 || result.score > 10)) {
        throw new GoalError(GOAL_ERROR_CODES.validation, 'Ultrafix score must be between 0 and 10', 400);
      }
      const changed = await trx('goal_ultrafix_cycles').where({ goal_id: goalId, node_id: nodeId, cycle }).update({
        status: result.status, score: result.score ?? null, completed_at: nowIso(),
      });
      if (changed !== 1) throw new GoalError(GOAL_ERROR_CODES.notFound, 'Ultrafix cycle not found', 404);
    });
  }

  async recordNoDiffArtifact(goalId: string, nodeId: string, fence: GoalLeaseFence): Promise<GoalGitHubArtifact> {
    return goalTransaction(this.db, async (trx) => {
      const goal = await guardLease(trx, goalId, fence);
      const spec = await trx<NodeSpecRow>('goal_node_specs').where({ goal_id: goalId, node_id: nodeId }).first();
      if (!spec) throw new GoalError(GOAL_ERROR_CODES.notFound, 'Goal node specification not found', 404);
      const tuple: GoalArtifactMarker = {
        schemaVersion: 1, repository: goal.repository, goalId, nodeId,
        artifactKind: 'pull_request', head: spec.head_branch, base: spec.base_branch,
      };
      const marker = buildGoalArtifactMarker(tuple);
      const artifactId = deterministicArtifactId(goalId, nodeId, 'pull_request');
      await trx('goal_github_artifacts').insert({
        artifact_id: artifactId, goal_id: goalId, node_id: nodeId, kind: 'pull_request',
        repository: goal.repository, remote_id: null, number: null, url: null,
        head_branch: spec.head_branch, base_branch: spec.base_branch,
        head_sha: null, base_sha: null, state: 'no_diff', marker,
        last_observed_at: nowIso(), created_at: nowIso(), updated_at: nowIso(),
      }).onConflict(['goal_id', 'node_id', 'kind']).merge({
        state: 'no_diff', marker, head_branch: spec.head_branch,
        base_branch: spec.base_branch, last_observed_at: nowIso(), updated_at: nowIso(),
      });
      return toArtifact((await trx<ArtifactRow>('goal_github_artifacts').where('artifact_id', artifactId).first())!);
    });
  }

  async recordEvidence(goalId: string, nodeId: string, input: GoalValidationEvidenceInput): Promise<void> {
    await goalTransaction(this.db, async (trx) => {
      await guardLease(trx, goalId, input);
      const evidenceId = crypto.createHash('sha256').update([
        goalId, nodeId, input.kind, input.headSha, input.baseSha, input.policyHash, String(input.cycle ?? 0),
      ].join('\0')).digest('hex');
      await trx('goal_validation_evidence').insert({
        evidence_id: evidenceId, goal_id: goalId, node_id: nodeId, kind: input.kind,
        head_sha: input.headSha, base_sha: input.baseSha, policy_hash: input.policyHash,
        cycle: input.cycle ?? 0, expected_checks_json: JSON.stringify([...(input.expectedChecks ?? [])].sort()),
        result_json: JSON.stringify(input.result), status: input.status,
        observed_at: input.observedAt ?? nowIso(), invalidated_at: null, created_at: nowIso(),
      }).onConflict(['goal_id', 'node_id', 'kind', 'head_sha', 'base_sha', 'policy_hash', 'cycle']).merge({
        expected_checks_json: JSON.stringify([...(input.expectedChecks ?? [])].sort()),
        result_json: JSON.stringify(input.result), status: input.status,
        observed_at: input.observedAt ?? nowIso(), invalidated_at: null,
      });
      await trx('goal_validation_evidence').where({ goal_id: goalId, node_id: nodeId, kind: input.kind, invalidated_at: null })
        .andWhere((query) => void query.whereNot('head_sha', input.headSha).orWhereNot('base_sha', input.baseSha).orWhereNot('policy_hash', input.policyHash))
        .update({ invalidated_at: nowIso() });
    });
  }

  async nodeReadiness(goalId: string, nodeId: string, policy: GoalReadinessPolicy): Promise<GoalNodeReadiness> {
    const node = await this.db('goal_nodes').where({ goal_id: goalId, node_id: nodeId }).first();
    if (!node) throw new GoalError(GOAL_ERROR_CODES.notFound, 'Goal node not found', 404);
    const descendants = await descendantIds(this.db, goalId, nodeId);
    const descendantRows = descendants.length === 0 ? [] : await this.db('goal_nodes as n')
      .join('goal_node_specs as s', 's.node_id', 'n.node_id')
      .where('n.goal_id', goalId).whereIn('n.node_id', descendants)
      .select('n.node_id', 'n.kind', 'n.status', 's.no_code');
    const descendantArtifacts = descendants.length === 0 ? [] : await this.db<ArtifactRow>('goal_github_artifacts')
      .where('goal_id', goalId).whereIn('node_id', descendants).andWhere('kind', 'pull_request');
    const artifactByNode = new Map(descendantArtifacts.map((candidate) => [candidate.node_id, candidate]));
    const incomplete = descendantRows.filter((candidate) => {
      if (candidate.kind === 'implementation_issue' || candidate.kind === 'implementation_pr') {
        if (candidate.status !== 'completed') return true;
        if (candidate.no_code) return false;
        const childArtifact = artifactByNode.get(candidate.node_id as string);
        return childArtifact == null || !['merged', 'no_diff'].includes(childArtifact.state);
      }
      if (candidate.no_code) return false;
      const integrationArtifact = artifactByNode.get(candidate.node_id as string);
      return integrationArtifact == null || !['merged', 'no_diff'].includes(integrationArtifact.state);
    });
    const artifact = await this.db<ArtifactRow>('goal_github_artifacts').where({ goal_id: goalId, node_id: nodeId, kind: 'pull_request' }).first();
    const reasons: string[] = [];
    if (incomplete.length > 0) reasons.push('descendants_not_integrated');
    const noDiff = artifact?.state === 'no_diff';
    if (!artifact || (!noDiff && (!['present', 'merged'].includes(artifact.state) || !artifact.head_sha || !artifact.base_sha))) reasons.push('pull_request_head_missing');
    if (!noDiff && artifact?.head_sha && artifact.base_sha) {
      const evidence = await this.db('goal_validation_evidence').where({
        goal_id: goalId, node_id: nodeId, head_sha: artifact.head_sha,
        base_sha: artifact.base_sha, policy_hash: policy.policyHash, invalidated_at: null,
      });
      for (const kind of policy.requiredEvidence) {
        const passing = evidence.filter((row) => row.kind === kind && row.status === 'passed');
        if (passing.length === 0) reasons.push(`${kind}_evidence_missing_or_unsuccessful`);
        if (kind === 'ci' && policy.expectedChecks) {
          const expected = [...policy.expectedChecks].sort();
          if (!passing.some((row) => JSON.stringify(JSON.parse(row.expected_checks_json as string)) === JSON.stringify(expected))) reasons.push('ci_expected_check_set_mismatch');
        }
      }
    }
    return { ready: reasons.length === 0, reasons: [...new Set(reasons)] };
  }

  async goalCompletionReadiness(goalId: string, policy: GoalReadinessPolicy): Promise<GoalCompletionReadiness> {
    const goal = await this.db<GoalRecord>('goals').where('goal_id', goalId).first();
    if (!goal) throw new GoalError(GOAL_ERROR_CODES.notFound, 'Goal not found', 404);
    const root = await this.db('goal_nodes').where({ goal_id: goalId, kind: 'root_epic' }).orderBy('order_index').first();
    if (!root) return { ready: false, reasons: ['root_epic_missing'], terminalAction: null };
    const readiness = await this.nodeReadiness(goalId, root.node_id as string, policy);
    if (!readiness.ready) return { ...readiness, terminalAction: null };
    const artifact = await this.db<ArtifactRow>('goal_github_artifacts').where({ goal_id: goalId, node_id: root.node_id, kind: 'pull_request' }).first();
    if (goal.merge_policy === 'manual') return { ready: true, reasons: [], terminalAction: 'complete' };
    if (artifact?.state !== 'merged') return { ready: false, reasons: ['final_merge_pending'], terminalAction: 'wait_for_merge' };
    return { ready: true, reasons: [], terminalAction: 'complete' };
  }

  async heartbeat(goalId: string, controllerId: string, scanState: Record<string, unknown>, fence: GoalLeaseFence): Promise<void> {
    await goalTransaction(this.db, async (trx) => {
      await guardLease(trx, goalId, fence);
      await trx('goal_controller_heartbeats').insert({
        goal_id: goalId, controller_id: controllerId, lease_generation: fence.leaseEpoch,
        heartbeat_at: nowIso(), scan_state_json: JSON.stringify(scanState),
      }).onConflict('goal_id').merge({
        controller_id: controllerId, lease_generation: fence.leaseEpoch,
        heartbeat_at: nowIso(), scan_state_json: JSON.stringify(scanState),
      });
    });
  }

  async listRecoverableGoals(now = nowIso()): Promise<string[]> {
    return this.db<GoalRecord>('goals').whereNotIn('state', ['completed', 'failed', 'cancelled'])
      .andWhere((query) => void query.whereNull('lease_owner').orWhereNull('lease_expires_at').orWhere('lease_expires_at', '<=', now))
      .orderBy('created_at').pluck('goal_id');
  }

  private async updateAttempt(
    goalId: string,
    attemptId: string,
    fence: GoalLeaseFence,
    effect: (trx: Knex.Transaction, attempt: AttemptRow) => Promise<void>
  ): Promise<GoalAttempt> {
    return goalTransaction(this.db, async (trx) => {
      await guardLease(trx, goalId, fence);
      const attempt = await trx<AttemptRow>('goal_attempts').where({ goal_id: goalId, attempt_id: attemptId }).first();
      if (!attempt) throw new GoalError(GOAL_ERROR_CODES.notFound, 'Goal attempt not found', 404);
      if (attempt.lease_generation > fence.leaseEpoch) throw new GoalError(GOAL_ERROR_CODES.staleLease, 'Attempt belongs to a newer controller generation', 409);
      await effect(trx, attempt);
      return toAttempt((await trx<AttemptRow>('goal_attempts').where('attempt_id', attemptId).first())!);
    });
  }
}

export function buildGoalArtifactMarker(marker: GoalArtifactMarker): string {
  const canonical = JSON.stringify({
    schemaVersion: 1,
    repository: marker.repository,
    goalId: marker.goalId,
    nodeId: marker.nodeId,
    artifactKind: marker.artifactKind,
    head: marker.head,
    base: marker.base,
  });
  return `<!-- propr-goal:${Buffer.from(canonical).toString('base64url')} -->`;
}

export function parseGoalArtifactMarker(value: string): GoalArtifactMarker {
  const match = /^<!-- propr-goal:([A-Za-z0-9_-]+) -->$/.exec(value);
  if (!match) throw new GoalError(GOAL_ERROR_CODES.validation, 'Malformed goal artifact marker', 400);
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.from(match[1], 'base64url').toString('utf8')); } catch { invalidMarker(); }
  if (!parsed || typeof parsed !== 'object') invalidMarker();
  const marker = parsed as Record<string, unknown>;
  const keys = Object.keys(marker).sort();
  if (JSON.stringify(keys) !== JSON.stringify(['artifactKind', 'base', 'goalId', 'head', 'nodeId', 'repository', 'schemaVersion'])) invalidMarker();
  if (marker.schemaVersion !== 1 || typeof marker.repository !== 'string' || typeof marker.goalId !== 'string'
    || typeof marker.nodeId !== 'string' || !['issue', 'branch', 'pull_request', 'comment', 'label'].includes(String(marker.artifactKind))
    || (marker.head !== null && typeof marker.head !== 'string') || (marker.base !== null && typeof marker.base !== 'string')) invalidMarker();
  return marker as unknown as GoalArtifactMarker;
}

function assertRemoteMatchesMarker(remote: GoalGitHubRemoteArtifact, expected: GoalArtifactMarker): void {
  const actual = parseGoalArtifactMarker(remote.marker);
  if (JSON.stringify(actual) !== JSON.stringify(expected)
    || remote.repository !== expected.repository || remote.kind !== expected.artifactKind
    || (remote.headBranch ?? null) !== expected.head || (remote.baseBranch ?? null) !== expected.base) {
    throw new GoalError(GOAL_ERROR_CODES.idempotencyConflict, 'Remote artifact marker tuple does not match the durable operation', 409);
  }
}

function toAttempt(row: AttemptRow): GoalAttempt {
  return {
    attemptId: row.attempt_id, goalId: row.goal_id, nodeId: row.node_id,
    executionId: row.execution_id, attemptNumber: row.attempt_number,
    sessionId: row.session_id, status: row.status, requestedModel: row.requested_model,
    effectiveModel: row.effective_model, parallelismSnapshot: row.parallelism_snapshot,
    ultrafixEnabled: Boolean(row.ultrafix_enabled), ultrafixGoal: row.ultrafix_goal,
    ultrafixMaxCycles: row.ultrafix_max_cycles, leaseGeneration: row.lease_generation,
    externalRef: row.external_ref, startedAt: row.started_at, finishedAt: row.finished_at,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

function toArtifact(row: ArtifactRow): GoalGitHubArtifact {
  return {
    artifactId: row.artifact_id, goalId: row.goal_id, nodeId: row.node_id,
    kind: row.kind, repository: row.repository, remoteId: row.remote_id,
    number: row.number, url: row.url, headBranch: row.head_branch,
    baseBranch: row.base_branch, headSha: row.head_sha, baseSha: row.base_sha,
    state: row.state, marker: row.marker, lastObservedAt: row.last_observed_at,
  };
}

function toOutbox(row: OutboxRow): GoalOutboxOperation {
  return {
    operationId: row.operation_id, goalId: row.goal_id, nodeId: row.node_id,
    artifactId: row.artifact_id, operationKind: row.operation_kind,
    idempotencyKey: row.idempotency_key, marker: row.marker,
    payload: JSON.parse(row.payload_json), attempts: row.attempts,
  };
}

function toValidatedNode(row: Record<string, unknown>): ValidatedGoalPlanNode {
  return {
    nodeId: row.node_id as string,
    key: row.correlation_key as string,
    kind: row.kind as GoalNodeKind,
    title: row.title as string,
    parentNodeId: row.parent_node_id as string | null,
    dependencyNodeIds: [],
    estimate: row.estimate as number,
    acceptanceCriteria: JSON.parse(row.acceptance_criteria_json as string),
    depth: row.depth as number,
    orderIndex: row.order_index as number,
    baseBranch: row.base_branch as string,
    headBranch: row.head_branch as string,
    noCode: Boolean(row.no_code),
  };
}

function toSpecRecord(goalId: string, revision: number, node: ValidatedGoalPlanNode): NodeSpecRow & { created_at: string; updated_at: string } {
  return {
    node_id: node.nodeId, goal_id: goalId, plan_revision: revision,
    correlation_key: node.key, acceptance_criteria_json: JSON.stringify(node.acceptanceCriteria),
    estimate: node.estimate, depth: node.depth, base_branch: node.baseBranch,
    head_branch: node.headBranch, no_code: node.noCode ? 1 : 0,
    created_at: nowIso(), updated_at: nowIso(),
  };
}

async function assertReplacementPreservesWork(trx: Knex.Transaction, goalId: string, plan: ValidatedGoalPlan): Promise<void> {
  const protectedRows = await trx('goal_nodes as n').join('goal_node_specs as s', 's.node_id', 'n.node_id')
    .where('n.goal_id', goalId).whereIn('n.status', ['in_progress', 'completed'])
    .select('n.node_id', 'n.parent_node_id', 'n.kind', 'n.title', 's.correlation_key',
      's.base_branch', 's.head_branch', 's.acceptance_criteria_json', 's.estimate', 's.no_code');
  const dependencyRows = await trx('goal_node_dependencies').where('goal_id', goalId).select('node_id', 'depends_on_node_id');
  const byKey = new Map(plan.nodes.map((node) => [node.key, node]));
  for (const existing of protectedRows) {
    const replacement = byKey.get(existing.correlation_key as string);
    if (!replacement) throw new GoalError(GOAL_ERROR_CODES.hierarchyConflict, 'A replan cannot discard active or completed work', 409);
    if (replacement.nodeId !== existing.node_id || replacement.parentNodeId !== existing.parent_node_id
      || replacement.kind !== existing.kind || replacement.title !== existing.title
      || replacement.baseBranch !== existing.base_branch || replacement.headBranch !== existing.head_branch
      || replacement.estimate !== existing.estimate || replacement.noCode !== Boolean(existing.no_code)
      || JSON.stringify(replacement.acceptanceCriteria) !== existing.acceptance_criteria_json
      || JSON.stringify(replacement.dependencyNodeIds) !== JSON.stringify(dependencyRows
        .filter((edge) => edge.node_id === existing.node_id)
        .map((edge) => edge.depends_on_node_id as string).sort())) {
      throw new GoalError(GOAL_ERROR_CODES.hierarchyConflict, 'A replan cannot remap active or completed work', 409);
    }
  }
}

async function planDiff(trx: Knex.Transaction, goalId: string, plan: ValidatedGoalPlan): Promise<Array<Record<string, unknown>>> {
  const revision = await trx('goal_plan_revisions').where('goal_id', goalId).orderBy('revision', 'desc').first('plan_json');
  const previous = revision ? JSON.parse(revision.plan_json as string) as ValidatedGoalPlan : null;
  const oldByKey = new Map((previous?.nodes ?? []).map((node) => [node.key, node]));
  const oldKeys = new Set(oldByKey.keys());
  const newKeys = new Set(plan.nodes.map((node) => node.key));
  return [
    ...[...newKeys].filter((key) => !oldKeys.has(key)).map((key) => ({ action: 'added', key })),
    ...[...oldKeys].filter((key) => !newKeys.has(key)).map((key) => ({ action: 'removed', key })),
    ...plan.nodes.filter((node) => {
      const old = oldByKey.get(node.key);
      return old !== undefined && JSON.stringify(old) !== JSON.stringify(node);
    }).map((node) => ({
      action: 'modified', key: node.key,
      before: oldByKey.get(node.key), after: node,
    })),
  ];
}

async function expireCapacity(trx: Knex.Transaction): Promise<void> {
  const timestamp = nowIso();
  // Once dispatch is acknowledged, capacity remains durable until the attempt
  // is reconciled terminal; a controller crash must not make live work vanish.
  const expired = await trx('goal_capacity_reservations').where('state', 'reserved')
    .andWhere('expires_at', '<=', timestamp).pluck('attempt_id');
  if (expired.length === 0) return;
  await trx('goal_capacity_reservations').whereIn('attempt_id', expired).update({ state: 'expired', released_at: timestamp });
  await trx('goal_attempts').whereIn('attempt_id', expired).whereIn('status', ['reserved', 'dispatching']).update({ status: 'expired', finished_at: timestamp, updated_at: timestamp });
  const nodeIds = await trx('goal_attempts').whereIn('attempt_id', expired).pluck('node_id');
  if (nodeIds.length > 0) await trx('goal_nodes').whereIn('node_id', nodeIds).where('status', 'in_progress').update({ status: 'pending', updated_at: timestamp });
}

async function countReservations(trx: Knex.Transaction, filter: Record<string, unknown>): Promise<number> {
  const row = await trx('goal_capacity_reservations').where(filter).whereIn('state', COUNTED_RESERVATION_STATES).count({ count: '*' }).first();
  return Number(row?.count ?? 0);
}

async function descendantIds(db: Knex | Knex.Transaction, goalId: string, rootId: string): Promise<string[]> {
  const rows = await db('goal_nodes').where('goal_id', goalId).select('node_id', 'parent_node_id');
  const children = new Map<string, string[]>();
  rows.forEach((row) => {
    if (row.parent_node_id == null) return;
    const current = children.get(row.parent_node_id as string) ?? [];
    current.push(row.node_id as string);
    children.set(row.parent_node_id as string, current);
  });
  const result: string[] = [];
  const pending = [...(children.get(rootId) ?? [])];
  while (pending.length > 0) {
    const nodeId = pending.pop()!;
    result.push(nodeId);
    pending.push(...(children.get(nodeId) ?? []));
  }
  return result;
}

function deterministicArtifactId(goalId: string, nodeId: string, kind: GoalArtifactKind): string {
  return `ga_${crypto.createHash('sha256').update(`${goalId}\0${nodeId}\0${kind}`).digest('hex').slice(0, 32)}`;
}

function validatePositive(value: number, field: string, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new GoalError(GOAL_ERROR_CODES.validation, `${field} must be a positive safe integer no greater than ${max}`, 400);
  }
  return value;
}

function invalidState(message: string): never {
  throw new GoalError(GOAL_ERROR_CODES.invalidTransition, message, 409);
}

function invalidMarker(): never {
  throw new GoalError(GOAL_ERROR_CODES.validation, 'Malformed goal artifact marker', 400);
}
