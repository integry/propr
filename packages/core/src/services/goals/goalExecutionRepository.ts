import crypto from 'crypto';
import type { Knex } from 'knex';
import { GOAL_ERROR_CODES } from '@propr/shared';
import type { Goal, GoalLeaseFence } from './goalTypes.js';
import type {
  GoalRuntimeExecution,
  GoalRuntimeExecutionState,
  GoalRuntimeSessionIdentity,
  GoalWorkspaceIdentity,
  NativeGoalPolicy,
} from './goalRuntimeTypes.js';
import {
  GoalError,
  boundedText,
  guardLease,
  goalTransaction,
  nowIso,
} from './goalRepositorySupport.js';
import { canonicalizeRuntimeJson } from './strictCanonicalJson.js';

interface GoalRuntimeExecutionRecord {
  execution_id: string;
  goal_id: string;
  attempt_number: number;
  schema_version: number;
  state: GoalRuntimeExecutionState;
  agent: string;
  effective_model: string;
  provider_session_id: string | null;
  provider_thread_id: string | null;
  runtime_id: string | null;
  worktree_id: string;
  worktree_path: string;
  repository: string;
  base_branch: string;
  head_branch: string;
  policy_json: string;
  policy_hash: string;
  last_checkpoint: string | null;
  last_native_event_sequence: number;
  lease_generation: number;
  heartbeat_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface GoalExecutionAllocation {
  attemptNumber?: number;
  workspace: GoalWorkspaceIdentity;
  policy: NativeGoalPolicy;
}

export class GoalExecutionRepository {
  constructor(private readonly db: Knex) {}

  async allocate(
    goal: Goal,
    allocation: GoalExecutionAllocation,
    fence: GoalLeaseFence
  ): Promise<GoalRuntimeExecution> {
    const attemptNumber = allocation.attemptNumber ?? 1;
    if (!Number.isSafeInteger(attemptNumber) || attemptNumber < 1) {
      throw new GoalError(GOAL_ERROR_CODES.validation, 'attemptNumber must be a positive safe integer', 400);
    }
    validateWorkspace(goal, allocation.workspace);
    const policyJson = canonicalizeRuntimeJson(allocation.policy);
    const policyHash = crypto.createHash('sha256').update(policyJson).digest('hex');
    const executionId = deterministicExecutionId(goal.goalId, attemptNumber);

    return goalTransaction(this.db, async (trx) => {
      await guardLease(trx, goal.goalId, fence);
      const existing = await trx<GoalRuntimeExecutionRecord>('goal_runtime_executions')
        .where({ goal_id: goal.goalId, attempt_number: attemptNumber }).first();
      if (existing) {
        if (existing.execution_id !== executionId
          || existing.agent !== goal.agent
          || existing.repository !== allocation.workspace.repository
          || existing.worktree_id !== allocation.workspace.worktreeId
          || existing.worktree_path !== allocation.workspace.worktreePath
          || existing.base_branch !== allocation.workspace.baseBranch
          || existing.head_branch !== allocation.workspace.headBranch
          || existing.policy_hash !== policyHash) {
          throw new GoalError(
            GOAL_ERROR_CODES.idempotencyConflict,
            'Goal execution allocation conflicts with its durable snapshot',
            409
          );
        }
        return toExecution(existing);
      }

      const now = nowIso();
      const row: GoalRuntimeExecutionRecord = {
        execution_id: executionId,
        goal_id: goal.goalId,
        attempt_number: attemptNumber,
        schema_version: 1,
        state: 'allocated',
        agent: goal.agent,
        effective_model: goal.effectiveModel,
        provider_session_id: null,
        provider_thread_id: null,
        runtime_id: null,
        worktree_id: allocation.workspace.worktreeId,
        worktree_path: allocation.workspace.worktreePath,
        repository: allocation.workspace.repository,
        base_branch: allocation.workspace.baseBranch,
        head_branch: allocation.workspace.headBranch,
        policy_json: policyJson,
        policy_hash: policyHash,
        last_checkpoint: null,
        last_native_event_sequence: 0,
        lease_generation: fence.leaseEpoch,
        heartbeat_at: now,
        created_at: now,
        updated_at: now,
      };
      await trx('goal_runtime_executions').insert(row);
      return toExecution(row);
    });
  }

  async get(goalId: string, attemptNumber = 1): Promise<GoalRuntimeExecution | null> {
    const row = await this.db<GoalRuntimeExecutionRecord>('goal_runtime_executions')
      .where({ goal_id: goalId, attempt_number: attemptNumber }).first();
    return row ? toExecution(row) : null;
  }

  async persistSessionIdentity(
    goalId: string,
    executionId: string,
    identity: GoalRuntimeSessionIdentity,
    fence: GoalLeaseFence
  ): Promise<GoalRuntimeExecution> {
    for (const [field, value] of Object.entries(identity)) {
      if (value !== null && value !== undefined) boundedText(value, field);
    }
    return this.updateFenced(goalId, executionId, fence, (row, now) => {
      if (row.worktree_id !== identity.worktreeId) {
        throw new GoalError(GOAL_ERROR_CODES.recoveryMetadataInvalid, 'Provider returned a different worktree identity', 409);
      }
      if (row.provider_session_id && row.provider_session_id !== identity.providerSessionId) {
        throw new GoalError(GOAL_ERROR_CODES.recoveryMetadataInvalid, 'Provider session identity cannot be replaced', 409);
      }
      if (row.provider_thread_id && row.provider_thread_id !== identity.providerThreadId) {
        throw new GoalError(GOAL_ERROR_CODES.recoveryMetadataInvalid, 'Provider thread identity cannot be replaced', 409);
      }
      return {
        provider_session_id: identity.providerSessionId,
        provider_thread_id: identity.providerThreadId,
        runtime_id: identity.runtimeId ?? row.runtime_id,
        state: 'active',
        heartbeat_at: now,
      };
    });
  }

  heartbeat(
    goalId: string,
    executionId: string,
    fence: GoalLeaseFence
  ): Promise<GoalRuntimeExecution> {
    return this.updateFenced(goalId, executionId, fence, (_row, now) => ({
      heartbeat_at: now,
    }));
  }

  updateState(input: {
    goalId: string;
    executionId: string;
    state: GoalRuntimeExecutionState;
    fence: GoalLeaseFence;
    fields?: { checkpoint?: string | null; effectiveModel?: string; nativeSequence?: number };
  }): Promise<GoalRuntimeExecution> {
    const fields = input.fields ?? {};
    return this.updateFenced(input.goalId, input.executionId, input.fence, (row, now) => ({
      state: input.state,
      heartbeat_at: now,
      last_checkpoint: fields.checkpoint === undefined ? row.last_checkpoint : fields.checkpoint,
      effective_model: fields.effectiveModel ?? row.effective_model,
      last_native_event_sequence: fields.nativeSequence === undefined
        ? row.last_native_event_sequence
        : Math.max(row.last_native_event_sequence, fields.nativeSequence),
    }));
  }

  async reconcileModelChange(input: {
    goalId: string;
    executionId: string;
    effectiveModel: string;
    fence: GoalLeaseFence;
  }): Promise<GoalRuntimeExecution> {
    return goalTransaction(this.db, async trx => {
      const goal = await guardLease(trx, input.goalId, input.fence);
      const transition = await trx('goal_model_transitions').where({
        goal_id: input.goalId, requested_model: input.effectiveModel, applied: 0,
      }).orderBy('id', 'desc').first('id');
      if (!transition || goal.requested_model !== input.effectiveModel) {
        throw new GoalError(GOAL_ERROR_CODES.versionConflict, 'Requested model transition changed', 409);
      }
      const now = nowIso();
      const goalUpdated = await trx('goals').where({
        goal_id: input.goalId, version: goal.version,
        lease_owner: input.fence.leaseOwner, lease_epoch: input.fence.leaseEpoch,
      }).update({ effective_model: input.effectiveModel, version: goal.version + 1, updated_at: now });
      const executionUpdated = await trx('goal_runtime_executions').where({
        goal_id: input.goalId, execution_id: input.executionId,
      }).update({ effective_model: input.effectiveModel, lease_generation: input.fence.leaseEpoch, updated_at: now });
      const auditUpdated = await trx('goal_model_transitions').where({ id: transition.id, applied: 0 })
        .update({ effective_model: input.effectiveModel, applied: 1, applied_at: now });
      if (goalUpdated !== 1 || executionUpdated !== 1 || auditUpdated !== 1) {
        throw new GoalError(GOAL_ERROR_CODES.versionConflict, 'Model reconciliation changed concurrently', 409);
      }
      const row = await trx<GoalRuntimeExecutionRecord>('goal_runtime_executions')
        .where({ execution_id: input.executionId }).first();
      return toExecution(row!);
    });
  }

  private async updateFenced(
    goalId: string,
    executionId: string,
    fence: GoalLeaseFence,
    build: (row: GoalRuntimeExecutionRecord, now: string) => Record<string, unknown>
  ): Promise<GoalRuntimeExecution> {
    return goalTransaction(this.db, async (trx) => {
      await guardLease(trx, goalId, fence);
      const row = await trx<GoalRuntimeExecutionRecord>('goal_runtime_executions')
        .where({ execution_id: executionId, goal_id: goalId }).first();
      if (!row) throw new GoalError(GOAL_ERROR_CODES.notFound, 'Goal execution not found', 404);
      const now = nowIso();
      const affected = await trx('goal_runtime_executions').where({
        execution_id: executionId,
        goal_id: goalId,
        lease_generation: row.lease_generation,
      }).update({
        ...build(row, now),
        lease_generation: fence.leaseEpoch,
        updated_at: now,
      });
      if (affected !== 1) throw new GoalError(GOAL_ERROR_CODES.staleLease, 'Goal execution changed concurrently', 409);
      const updated = await trx<GoalRuntimeExecutionRecord>('goal_runtime_executions')
        .where({ execution_id: executionId }).first();
      return toExecution(updated!);
    });
  }
}

export function buildNativeGoalPolicy(goal: Goal): NativeGoalPolicy {
  return {
    schemaVersion: 1,
    maxActiveTasks: goal.maxActiveTasks,
    mergePolicy: 'manual',
    ultrafix: {
      enabled: goal.ultrafixEnabled,
      goal: goal.ultrafixGoal,
      maxCycles: goal.ultrafixMaxCycles,
    },
    finalPullRequest: {
      draft: true,
      requireHumanApproval: true,
    },
  };
}

export function buildNativeGoalCommand(objective: string, policy: NativeGoalPolicy): string {
  return `/goal ${objective}\n\n<propr-goal-policy schema-version="1">\n${JSON.stringify(policy)}\n</propr-goal-policy>`;
}

export function deterministicGoalWorkspace(
  goal: Goal,
  baseBranch: string,
  worktreePath = `/tmp/git-processor/worktrees/${goal.repository}/${goal.goalId}`
): GoalWorkspaceIdentity {
  const digest = crypto.createHash('sha256').update(`${goal.repository}\0${goal.goalId}`).digest('hex');
  const safeGoal = goal.goalId.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'goal';
  return {
    repository: goal.repository,
    worktreePath,
    baseBranch,
    headBranch: `propr/goal-${safeGoal}-${digest.slice(0, 10)}`,
    worktreeId: `goal-${digest.slice(0, 24)}`,
  };
}

function deterministicExecutionId(goalId: string, attempt: number): string {
  return `gexec_${crypto.createHash('sha256').update(`${goalId}\0${attempt}`).digest('hex')}`;
}

function validateWorkspace(goal: Goal, workspace: GoalWorkspaceIdentity): void {
  if (workspace.repository !== goal.repository) {
    throw new GoalError(GOAL_ERROR_CODES.validation, 'Execution workspace repository does not match the goal', 400);
  }
  for (const [field, value] of Object.entries(workspace)) boundedText(value, field);
}

function toExecution(row: GoalRuntimeExecutionRecord): GoalRuntimeExecution {
  return {
    executionId: row.execution_id,
    goalId: row.goal_id,
    attemptNumber: row.attempt_number,
    schemaVersion: 1,
    state: row.state,
    agent: row.agent,
    effectiveModel: row.effective_model,
    providerSessionId: row.provider_session_id,
    providerThreadId: row.provider_thread_id,
    runtimeId: row.runtime_id,
    workspace: {
      worktreeId: row.worktree_id,
      worktreePath: row.worktree_path,
      repository: row.repository,
      baseBranch: row.base_branch,
      headBranch: row.head_branch,
    },
    policy: JSON.parse(row.policy_json) as NativeGoalPolicy,
    policyHash: row.policy_hash,
    lastCheckpoint: row.last_checkpoint,
    lastNativeEventSequence: row.last_native_event_sequence,
    leaseGeneration: row.lease_generation,
    heartbeatAt: row.heartbeat_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
