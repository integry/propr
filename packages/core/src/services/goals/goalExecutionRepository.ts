import crypto from 'crypto';
import type { Knex } from 'knex';
import { GOAL_ERROR_CODES } from '@propr/shared';
import type { Goal, GoalLeaseFence } from './goalTypes.js';
import type {
  GoalReportedArtifact,
  GoalRuntimeExecution,
  GoalRuntimeExecutionState,
  GoalRuntimeSessionIdentity,
  GoalWorkspaceIdentity,
  NativeGoalPolicy,
  PersistedGoalReportedArtifact,
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

interface GoalReportedArtifactRecord {
  artifact_id: string;
  goal_id: string;
  execution_id: string;
  artifact_key: string;
  kind: GoalReportedArtifact['kind'];
  repository: string;
  external_ref: string;
  url: string | null;
  head_branch: string | null;
  base_branch: string | null;
  head_sha: string | null;
  state: string | null;
  draft: number | null;
  marker: string;
  final_slot: string | null;
  lease_generation: number;
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

  updateState(
    goalId: string,
    executionId: string,
    state: GoalRuntimeExecutionState,
    fence: GoalLeaseFence,
    fields: { checkpoint?: string | null; effectiveModel?: string; nativeSequence?: number } = {}
  ): Promise<GoalRuntimeExecution> {
    return this.updateFenced(goalId, executionId, fence, (row, now) => ({
      state,
      heartbeat_at: now,
      last_checkpoint: fields.checkpoint === undefined ? row.last_checkpoint : fields.checkpoint,
      effective_model: fields.effectiveModel ?? row.effective_model,
      last_native_event_sequence: fields.nativeSequence === undefined
        ? row.last_native_event_sequence
        : Math.max(row.last_native_event_sequence, fields.nativeSequence),
    }));
  }

  async recordArtifact(
    goalId: string,
    executionId: string,
    artifact: GoalReportedArtifact,
    fence: GoalLeaseFence
  ): Promise<void> {
    validateArtifact(artifact);
    await goalTransaction(this.db, async (trx) => {
      await guardLease(trx, goalId, fence);
      const execution = await trx<GoalRuntimeExecutionRecord>('goal_runtime_executions')
        .where({ execution_id: executionId, goal_id: goalId }).first();
      if (!execution) throw new GoalError(GOAL_ERROR_CODES.notFound, 'Goal execution not found', 404);
      if (artifact.repository !== execution.repository) {
        throw new GoalError(GOAL_ERROR_CODES.validation, 'Reported artifact repository does not match the execution', 400);
      }
      if (artifact.finalEpicPullRequest
        && (artifact.headBranch !== execution.head_branch || artifact.baseBranch !== execution.base_branch)) {
        throw new GoalError(
          GOAL_ERROR_CODES.validation,
          'Final epic PR must report the execution head and base branches',
          400
        );
      }
      const artifactId = deterministicArtifactId(goalId, artifact.artifactKey);
      const existing = await trx('goal_reported_artifacts')
        .where({ goal_id: goalId, artifact_key: artifact.artifactKey }).first();
      const desired = artifactTuple(executionId, artifact, fence.leaseEpoch);
      if (existing) {
        if (!sameArtifactIdentity(existing, desired)) {
          throw new GoalError(
            GOAL_ERROR_CODES.idempotencyConflict,
            'Reported artifact key collides with a different marker tuple',
            409
          );
        }
        await trx('goal_reported_artifacts').where({ artifact_id: existing.artifact_id }).update({
          head_sha: desired.head_sha,
          state: desired.state,
          draft: desired.draft,
          lease_generation: fence.leaseEpoch,
          updated_at: nowIso(),
        });
        return;
      }
      await trx('goal_reported_artifacts').insert({
        artifact_id: artifactId,
        goal_id: goalId,
        ...desired,
        created_at: nowIso(),
        updated_at: nowIso(),
      });
    });
  }

  async getArtifacts(goalId: string): Promise<PersistedGoalReportedArtifact[]> {
    const rows = await this.db<GoalReportedArtifactRecord>('goal_reported_artifacts')
      .where('goal_id', goalId)
      .orderBy('created_at', 'asc')
      .orderBy('artifact_id', 'asc');
    return rows.map(toArtifact);
  }

  async getFinalEpicPullRequest(goalId: string): Promise<PersistedGoalReportedArtifact | null> {
    const row = await this.db<GoalReportedArtifactRecord>('goal_reported_artifacts')
      .where({ goal_id: goalId, final_slot: 'final' }).first();
    return row ? toArtifact(row) : null;
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
    mergePolicy: goal.mergePolicy,
    ultrafix: {
      enabled: goal.ultrafixEnabled,
      goal: goal.ultrafixGoal,
      maxCycles: goal.ultrafixMaxCycles,
    },
    finalPullRequest: {
      draft: true,
      requireHumanApproval: goal.mergePolicy === 'manual',
    },
  };
}

export function buildNativeGoalCommand(objective: string, policy: NativeGoalPolicy): string {
  return `/goal ${objective}\n\n<propr-goal-policy schema-version="1">\n${JSON.stringify(policy)}\n</propr-goal-policy>`;
}

export function deterministicGoalWorkspace(goal: Goal, baseBranch: string): GoalWorkspaceIdentity {
  const digest = crypto.createHash('sha256').update(`${goal.repository}\0${goal.goalId}`).digest('hex');
  const safeGoal = goal.goalId.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'goal';
  return {
    repository: goal.repository,
    baseBranch,
    headBranch: `propr/goal-${safeGoal}-${digest.slice(0, 10)}`,
    worktreeId: `goal-${digest.slice(0, 24)}`,
  };
}

function deterministicExecutionId(goalId: string, attempt: number): string {
  return `gexec_${crypto.createHash('sha256').update(`${goalId}\0${attempt}`).digest('hex')}`;
}

function deterministicArtifactId(goalId: string, key: string): string {
  return `gart_${crypto.createHash('sha256').update(`${goalId}\0${key}`).digest('hex')}`;
}

function validateWorkspace(goal: Goal, workspace: GoalWorkspaceIdentity): void {
  if (workspace.repository !== goal.repository) {
    throw new GoalError(GOAL_ERROR_CODES.validation, 'Execution workspace repository does not match the goal', 400);
  }
  for (const [field, value] of Object.entries(workspace)) boundedText(value, field);
}

function validateArtifact(artifact: GoalReportedArtifact): void {
  for (const [field, value] of Object.entries({
    artifactKey: artifact.artifactKey,
    repository: artifact.repository,
    externalRef: artifact.externalRef,
    marker: artifact.marker,
  })) boundedText(value, field, field === 'marker' ? 2048 : undefined);
  if (artifact.finalEpicPullRequest && artifact.kind !== 'epic_pr') {
    throw new GoalError(GOAL_ERROR_CODES.validation, 'Only an epic PR can be the final goal artifact', 400);
  }
}

function artifactTuple(executionId: string, artifact: GoalReportedArtifact, leaseEpoch: number) {
  return {
    execution_id: executionId,
    artifact_key: artifact.artifactKey,
    kind: artifact.kind,
    repository: artifact.repository,
    external_ref: artifact.externalRef,
    url: artifact.url ?? null,
    head_branch: artifact.headBranch ?? null,
    base_branch: artifact.baseBranch ?? null,
    head_sha: artifact.headSha ?? null,
    state: artifact.state ?? null,
    draft: artifact.draft === null || artifact.draft === undefined ? null : Number(artifact.draft),
    marker: artifact.marker,
    final_slot: artifact.finalEpicPullRequest ? 'final' : null,
    lease_generation: leaseEpoch,
  };
}

function sameArtifactIdentity(existing: Record<string, unknown>, desired: ReturnType<typeof artifactTuple>): boolean {
  const mutable = new Set(['lease_generation', 'head_sha', 'state', 'draft']);
  return Object.entries(desired)
    .filter(([key]) => !mutable.has(key))
    .every(([key, value]) => existing[key] === value);
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


function toArtifact(row: GoalReportedArtifactRecord): PersistedGoalReportedArtifact {
  return {
    artifactId: row.artifact_id,
    goalId: row.goal_id,
    executionId: row.execution_id,
    artifactKey: row.artifact_key,
    kind: row.kind,
    repository: row.repository,
    externalRef: row.external_ref,
    url: row.url,
    headBranch: row.head_branch,
    baseBranch: row.base_branch,
    headSha: row.head_sha,
    state: row.state,
    draft: row.draft === null ? null : Boolean(row.draft),
    marker: row.marker,
    finalEpicPullRequest: row.final_slot === 'final',
    leaseGeneration: row.lease_generation,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
