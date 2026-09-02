import crypto from 'node:crypto';
import type { Knex } from 'knex';
import { GOAL_ERROR_CODES, type GoalNodeKind } from '@propr/shared';
import type { GoalLeaseFence } from './goalTypes.js';
import { GoalError, boundedText, goalTransaction, guardLease, nowIso } from './goalRepositorySupport.js';
import type {
  GoalAttempt,
  GoalAttemptStatus,
  GoalDispatchReservation,
  ValidatedGoalPlanNode,
} from './goalOrchestrationTypes.js';

export const ACTIVE_ATTEMPT_STATES: GoalAttemptStatus[] = ['reserved', 'dispatching', 'running', 'safe_boundary'];
const COUNTED_RESERVATION_STATES = ['reserved', 'active'];

export interface AttemptRow {
  attempt_id: string; goal_id: string; node_id: string; execution_id: string;
  dispatch_identity: string; attempt_number: number; session_id: string | null;
  status: GoalAttemptStatus; requested_model: string; effective_model: string;
  parallelism_snapshot: number; ultrafix_enabled: number; ultrafix_goal: number | null;
  ultrafix_max_cycles: number | null; lease_generation: number; external_ref: string | null;
  last_dispatch_error: string | null; started_at: string | null; finished_at: string | null;
  created_at: string; updated_at: string;
}

export interface ArtifactRow {
  artifact_id: string; goal_id: string; node_id: string; kind: string;
  repository: string; remote_id: string | null; number: number | null; url: string | null;
  head_branch: string | null; base_branch: string | null; head_sha: string | null;
  base_sha: string | null; state: string; marker: string; last_observed_at: string | null;
}

/** Attempt reservations and provider receipt state share one serializable boundary. */
export class GoalAttemptStore {
  constructor(protected readonly db: Knex) {}

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
      const activeGoals = await trx('goals as g').join('goal_plan_revisions as p', 'p.goal_id', 'g.goal_id')
        .where('g.repository', goal.repository).whereIn('g.state', ['planning', 'running', 'recovering'])
        .countDistinct({ count: 'g.goal_id' }).first();
      const fairShare = Math.max(1, Math.floor(repositoryLimit / Math.max(1, Number(activeGoals?.count ?? 1))));
      const available = Math.max(0, Math.min(
        goal.max_active_tasks - goalUsed, fairShare - goalUsed, repositoryLimit - repositoryUsed
      ));
      if (available === 0) return [];
      const revision = await trx('goal_plan_revisions').where('goal_id', goalId).orderBy('revision', 'desc').first('revision');
      if (!revision) return [];
      const rows = await trx('goal_nodes as n')
        .join('goal_node_specs as s', 's.node_id', 'n.node_id')
        .join('goal_node_integrations as integration', 'integration.node_id', 'n.node_id')
        .where({ 'n.goal_id': goalId, 's.plan_revision': revision.revision })
        .whereIn('n.kind', ['implementation_issue', 'implementation_pr'])
        .whereIn('n.status', ['pending', 'blocked'])
        .whereIn('integration.runtime_state', ['pending', 'failed'])
        .select('n.*', 's.correlation_key', 's.acceptance_criteria_json', 's.estimate', 's.depth', 's.base_branch', 's.head_branch', 's.no_code')
        .orderBy('n.order_index', 'asc');
      const dependencies = await trx('goal_node_dependencies').where('goal_id', goalId)
        .select('node_id', 'depends_on_node_id');
      const dependencyIds = dependencies.map((edge) => edge.depends_on_node_id as string);
      const integratedIds = dependencyIds.length === 0 ? [] : await trx('goal_node_integrations')
        .where('goal_id', goalId).whereIn('node_id', dependencyIds)
        .whereIn('integration_state', ['integrated', 'no_diff']).pluck('node_id') as string[];
      const integrated = new Set(integratedIds);
      const blocked = new Set(dependencies.filter((edge) => !integrated.has(edge.depends_on_node_id as string))
        .map((edge) => edge.node_id as string));
      const activeNodes = new Set(await trx('goal_attempts').where('goal_id', goalId)
        .whereIn('status', ACTIVE_ATTEMPT_STATES).pluck('node_id') as string[]);
      const reservations: GoalDispatchReservation[] = [];
      for (const row of rows) {
        if (reservations.length >= available) break;
        if (blocked.has(row.node_id as string) || activeNodes.has(row.node_id as string)) continue;
        if (row.no_code) {
          await completeNoCodeNode(trx, goalId, row.node_id as string);
          continue;
        }
        if (!await artifactsReady(trx, goalId, row)) continue;
        const highest = await trx('goal_attempts').where({ goal_id: goalId, node_id: row.node_id })
          .max({ max: 'attempt_number' }).first();
        const attemptNumber = Number(highest?.max ?? 0) + 1;
        const executionId = crypto.randomUUID();
        const timestamp = nowIso();
        const attempt: AttemptRow = {
          attempt_id: crypto.randomUUID(), goal_id: goalId, node_id: row.node_id as string,
          execution_id: executionId, dispatch_identity: `goal-dispatch:${goalId}:${row.node_id as string}:${executionId}`,
          attempt_number: attemptNumber, session_id: null, status: 'reserved',
          requested_model: goal.requested_model, effective_model: goal.effective_model,
          parallelism_snapshot: goal.max_active_tasks, ultrafix_enabled: goal.ultrafix_enabled,
          ultrafix_goal: goal.ultrafix_goal, ultrafix_max_cycles: goal.ultrafix_max_cycles,
          lease_generation: fence.leaseEpoch, external_ref: null, last_dispatch_error: null,
          started_at: null, finished_at: null, created_at: timestamp, updated_at: timestamp,
        };
        const reservationId = crypto.randomUUID();
        const expiresAt = nowIso(Date.now() + ttlMs);
        await trx('goal_attempts').insert(attempt);
        await trx('goal_capacity_reservations').insert({
          reservation_id: reservationId, goal_id: goalId, repository: goal.repository,
          node_id: row.node_id, attempt_id: attempt.attempt_id, state: 'reserved',
          lease_generation: fence.leaseEpoch, expires_at: expiresAt, released_at: null, created_at: timestamp,
        });
        await trx('goal_nodes').where({ goal_id: goalId, node_id: row.node_id })
          .update({ status: 'in_progress', attempt_count: attemptNumber, updated_at: timestamp });
        await trx('goal_node_integrations').where({ goal_id: goalId, node_id: row.node_id })
          .update({ runtime_state: 'running', integration_state: 'pending', updated_at: timestamp });
        reservations.push({
          reservationId, expiresAt, attempt: toAttempt(attempt),
          node: { ...toValidatedNode(row), status: 'in_progress' },
        });
      }
      return reservations;
    });
  }

  markAttemptDispatched(goalId: string, attemptId: string, result: { sessionId: string; externalRef?: string }, fence: GoalLeaseFence): Promise<GoalAttempt> {
    return this.updateAttempt(goalId, attemptId, fence, async (trx, attempt) => {
      if (!['reserved', 'dispatching', 'running'].includes(attempt.status)) invalidState('Attempt is not dispatchable');
      const timestamp = nowIso();
      await trx('goal_attempts').where({ goal_id: goalId, attempt_id: attemptId }).update({
        status: 'running', session_id: boundedText(result.sessionId, 'sessionId'),
        external_ref: result.externalRef == null ? attempt.external_ref : boundedText(result.externalRef, 'externalRef'),
        last_dispatch_error: null, started_at: attempt.started_at ?? timestamp, updated_at: timestamp,
      });
      await trx('goal_capacity_reservations').where({ goal_id: goalId, attempt_id: attemptId }).update({ state: 'active' });
    });
  }

  markAttemptDispatching(goalId: string, attemptId: string, fence: GoalLeaseFence): Promise<GoalAttempt> {
    return this.updateAttempt(goalId, attemptId, fence, async (trx, attempt) => {
      if (attempt.status !== 'reserved') invalidState('Only a reserved attempt can begin dispatch');
      await trx('goal_attempts').where({ goal_id: goalId, attempt_id: attemptId }).update({ status: 'dispatching', updated_at: nowIso() });
    });
  }

  async recordDispatchError(goalId: string, attemptId: string, error: string, fence: GoalLeaseFence): Promise<void> {
    await this.updateAttempt(goalId, attemptId, fence, async (trx, attempt) => {
      if (attempt.status !== 'dispatching') invalidState('Only a dispatching attempt can record a dispatch error');
      await trx('goal_attempts').where({ goal_id: goalId, attempt_id: attemptId })
        .update({ last_dispatch_error: error.slice(0, 2000), updated_at: nowIso() });
    });
  }

  finishAttempt(goalId: string, attemptId: string, status: 'succeeded' | 'failed' | 'cancelled', fence: GoalLeaseFence): Promise<GoalAttempt> {
    return this.updateAttempt(goalId, attemptId, fence, async (trx, attempt) => {
      if (!ACTIVE_ATTEMPT_STATES.includes(attempt.status)) {
        if (attempt.status === status) return;
        invalidState('Attempt is already terminal');
      }
      const timestamp = nowIso();
      await trx('goal_attempts').where({ goal_id: goalId, attempt_id: attemptId })
        .update({ status, finished_at: timestamp, updated_at: timestamp });
      await trx('goal_capacity_reservations').where({ goal_id: goalId, attempt_id: attemptId })
        .whereIn('state', COUNTED_RESERVATION_STATES).update({ state: 'released', released_at: timestamp });
      const nodeStatus = status === 'succeeded' ? 'blocked' : status === 'failed' ? 'failed' : 'cancelled';
      const integrationState = status === 'succeeded' ? 'awaiting_artifacts' : status;
      await trx('goal_nodes').where({ goal_id: goalId, node_id: attempt.node_id })
        .update({ status: nodeStatus, updated_at: timestamp });
      await trx('goal_node_integrations').where({ goal_id: goalId, node_id: attempt.node_id }).update({
        runtime_state: status, integration_state: integrationState,
        runtime_completed_at: status === 'succeeded' ? timestamp : null, updated_at: timestamp,
      });
    });
  }

  markAttemptSafeBoundary(goalId: string, attemptId: string, fence: GoalLeaseFence): Promise<GoalAttempt> {
    return this.updateAttempt(goalId, attemptId, fence, async (trx, attempt) => {
      if (attempt.status === 'safe_boundary') return;
      if (attempt.status !== 'running') invalidState('Only a running attempt can enter a safe boundary');
      await trx('goal_attempts').where({ goal_id: goalId, attempt_id: attemptId }).update({ status: 'safe_boundary', updated_at: nowIso() });
    });
  }

  resumeAttempt(goalId: string, attemptId: string, fence: GoalLeaseFence): Promise<GoalAttempt> {
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
      const ids = attempts.map((attempt) => attempt.attempt_id);
      await trx('goal_attempts').whereIn('attempt_id', ids).update({ status: 'cancelled', finished_at: timestamp, updated_at: timestamp });
      await trx('goal_capacity_reservations').whereIn('attempt_id', ids).update({ state: 'released', released_at: timestamp });
      const nodes = attempts.map((attempt) => attempt.node_id);
      await trx('goal_nodes').where('goal_id', goalId).whereIn('node_id', nodes).where('status', 'in_progress')
        .update({ status: 'pending', updated_at: timestamp });
      await trx('goal_node_integrations').where('goal_id', goalId).whereIn('node_id', nodes)
        .update({ runtime_state: 'pending', integration_state: 'pending', updated_at: timestamp });
    });
  }

  async getAttempts(goalId: string, nodeId?: string): Promise<GoalAttempt[]> {
    const query = this.db<AttemptRow>('goal_attempts').where('goal_id', goalId);
    if (nodeId) query.andWhere('node_id', nodeId);
    return (await query.orderBy(['node_id', 'attempt_number'])).map(toAttempt);
  }

  async isModelChangeBoundary(goalId: string): Promise<boolean> {
    const active = await this.db<AttemptRow>('goal_attempts').where('goal_id', goalId).whereIn('status', ACTIVE_ATTEMPT_STATES);
    return active.every((attempt) => attempt.status === 'safe_boundary');
  }

  async assertFence(goalId: string, fence: GoalLeaseFence): Promise<void> {
    await goalTransaction(this.db, async (trx) => { await guardLease(trx, goalId, fence); });
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
      if (attempt.lease_generation > fence.leaseEpoch) {
        throw new GoalError(GOAL_ERROR_CODES.staleLease, 'Attempt belongs to a newer controller generation', 409);
      }
      await effect(trx, attempt);
      return toAttempt((await trx<AttemptRow>('goal_attempts').where('attempt_id', attemptId).first())!);
    });
  }
}

export function toAttempt(row: AttemptRow): GoalAttempt {
  return {
    attemptId: row.attempt_id, goalId: row.goal_id, nodeId: row.node_id,
    executionId: row.execution_id, dispatchIdentity: row.dispatch_identity, attemptNumber: row.attempt_number,
    sessionId: row.session_id, status: row.status, requestedModel: row.requested_model,
    effectiveModel: row.effective_model, parallelismSnapshot: row.parallelism_snapshot,
    ultrafixEnabled: Boolean(row.ultrafix_enabled), ultrafixGoal: row.ultrafix_goal,
    ultrafixMaxCycles: row.ultrafix_max_cycles, leaseGeneration: row.lease_generation,
    externalRef: row.external_ref, lastDispatchError: row.last_dispatch_error,
    startedAt: row.started_at, finishedAt: row.finished_at, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

function toValidatedNode(row: Record<string, unknown>): ValidatedGoalPlanNode {
  return {
    nodeId: row.node_id as string, key: row.correlation_key as string, kind: row.kind as GoalNodeKind,
    title: row.title as string, parentNodeId: row.parent_node_id as string | null,
    dependencyNodeIds: [], estimate: row.estimate as number,
    acceptanceCriteria: JSON.parse(row.acceptance_criteria_json as string), depth: row.depth as number,
    orderIndex: row.order_index as number, baseBranch: row.base_branch as string,
    headBranch: row.head_branch as string, noCode: Boolean(row.no_code),
  };
}

async function artifactsReady(trx: Knex.Transaction, goalId: string, row: Record<string, unknown>): Promise<boolean> {
  const artifacts = await trx<ArtifactRow>('goal_github_artifacts')
    .where({ goal_id: goalId, node_id: row.node_id as string }).whereIn('kind', ['issue', 'branch']);
  const issue = artifacts.some((item) => item.kind === 'issue' && item.remote_id !== null && item.state === 'present');
  const branch = artifacts.some((item) => item.kind === 'branch' && item.remote_id !== null && item.state === 'present'
    && item.head_branch === row.head_branch && item.base_branch === row.base_branch);
  return issue && branch;
}

async function completeNoCodeNode(trx: Knex.Transaction, goalId: string, nodeId: string): Promise<void> {
  const timestamp = nowIso();
  await trx('goal_nodes').where({ goal_id: goalId, node_id: nodeId }).update({ status: 'completed', updated_at: timestamp });
  await trx('goal_node_integrations').where({ goal_id: goalId, node_id: nodeId }).update({
    runtime_state: 'succeeded', integration_state: 'no_diff', runtime_completed_at: timestamp,
    integrated_at: timestamp, updated_at: timestamp,
  });
}

async function expireCapacity(trx: Knex.Transaction): Promise<void> {
  const timestamp = nowIso();
  const expired = await trx('goal_capacity_reservations as reservation')
    .join('goal_attempts as attempt', 'attempt.attempt_id', 'reservation.attempt_id')
    .where('reservation.state', 'reserved').andWhere('attempt.status', 'reserved')
    .andWhere('reservation.expires_at', '<=', timestamp).pluck('reservation.attempt_id');
  if (expired.length === 0) return;
  await trx('goal_capacity_reservations').whereIn('attempt_id', expired).update({ state: 'expired', released_at: timestamp });
  await trx('goal_attempts').whereIn('attempt_id', expired).where('status', 'reserved')
    .update({ status: 'expired', finished_at: timestamp, updated_at: timestamp });
  const nodes = await trx('goal_attempts').whereIn('attempt_id', expired).pluck('node_id');
  if (nodes.length > 0) await trx('goal_nodes').whereIn('node_id', nodes).where('status', 'in_progress')
    .update({ status: 'pending', updated_at: timestamp });
}

async function countReservations(trx: Knex.Transaction, filter: Record<string, unknown>): Promise<number> {
  const row = await trx('goal_capacity_reservations').where(filter)
    .whereIn('state', COUNTED_RESERVATION_STATES).count({ count: '*' }).first();
  return Number(row?.count ?? 0);
}

function validatePositive(value: number, field: string, max: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new GoalError(GOAL_ERROR_CODES.validation, `${field} must be a positive integer`, 400);
  }
  return value;
}

function invalidState(message: string): never {
  throw new GoalError(GOAL_ERROR_CODES.invalidTransition, message, 409);
}
