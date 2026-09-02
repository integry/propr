import crypto from 'node:crypto';
import type { Knex } from 'knex';
import { GOAL_ERROR_CODES } from '@propr/shared';
import type { GoalLeaseFence } from './goalTypes.js';
import type {
  GoalReportedArtifact,
  PersistedGoalReportedArtifact,
  VerifiedGoalPullRequest,
} from './goalRuntimeTypes.js';
import {
  GoalError,
  boundedText,
  guardLease,
  goalTransaction,
  nowIso,
} from './goalRepositorySupport.js';

interface ArtifactRecord {
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

interface ExecutionArtifactIdentity {
  execution_id: string;
  goal_id: string;
  repository: string;
  head_branch: string;
  base_branch: string;
}

export class GoalArtifactRepository {
  constructor(private readonly db: Knex) {}

  async record(input: {
    goalId: string;
    executionId: string;
    artifact: GoalReportedArtifact;
    fence: GoalLeaseFence;
  }): Promise<void> {
    validateArtifact(input.artifact);
    await goalTransaction(this.db, async trx => {
      await guardLease(trx, input.goalId, input.fence);
      const execution = await trx<ExecutionArtifactIdentity>('goal_runtime_executions')
        .where({ execution_id: input.executionId, goal_id: input.goalId }).first();
      if (!execution) throw new GoalError(GOAL_ERROR_CODES.notFound, 'Goal execution not found', 404);
      validateAssociation(execution, input.artifact);
      await this.upsert(trx, input);
    });
  }

  async list(goalId: string): Promise<PersistedGoalReportedArtifact[]> {
    const rows = await this.db<ArtifactRecord>('goal_reported_artifacts')
      .where('goal_id', goalId).orderBy('created_at', 'asc').orderBy('artifact_id', 'asc');
    return rows.map(toArtifact);
  }

  async getFinal(goalId: string): Promise<PersistedGoalReportedArtifact | null> {
    const row = await this.db<ArtifactRecord>('goal_reported_artifacts')
      .where({ goal_id: goalId, final_slot: 'final' }).first();
    return row ? toArtifact(row) : null;
  }

  async markVerified(input: {
    goalId: string;
    executionId: string;
    verified: VerifiedGoalPullRequest;
    fence: GoalLeaseFence;
  }): Promise<void> {
    await goalTransaction(this.db, async trx => {
      await guardLease(trx, input.goalId, input.fence);
      const affected = await trx('goal_reported_artifacts').where({
        goal_id: input.goalId,
        execution_id: input.executionId,
        final_slot: 'final',
        repository: input.verified.repository,
        external_ref: input.verified.externalRef,
        head_branch: input.verified.headBranch,
        base_branch: input.verified.baseBranch,
      }).update({
        head_sha: input.verified.headSha,
        state: input.verified.state,
        draft: 1,
        verified_at: nowIso(),
        verified_head_sha: input.verified.headSha,
        lease_generation: input.fence.leaseEpoch,
        updated_at: nowIso(),
      });
      if (affected !== 1) throw new GoalError(
        GOAL_ERROR_CODES.recoveryMetadataInvalid,
        'Verified GitHub pull request does not match the durable final association',
        409
      );
    });
  }

  private async upsert(
    trx: Knex.Transaction,
    input: Parameters<GoalArtifactRepository['record']>[0]
  ): Promise<void> {
    const desired = artifactTuple(input.executionId, input.artifact, input.fence.leaseEpoch);
    const existing = await trx<ArtifactRecord>('goal_reported_artifacts')
      .where({ goal_id: input.goalId, artifact_key: input.artifact.artifactKey }).first();
    if (existing) {
      if (!sameArtifactIdentity(existing, desired)) throw new GoalError(
        GOAL_ERROR_CODES.idempotencyConflict,
        'Reported artifact key collides with a different durable association',
        409
      );
      await trx('goal_reported_artifacts').where({ artifact_id: existing.artifact_id }).update({
        head_sha: desired.head_sha, state: desired.state, draft: desired.draft,
        verified_at: null, verified_head_sha: null,
        lease_generation: input.fence.leaseEpoch, updated_at: nowIso(),
      });
      return;
    }
    await trx('goal_reported_artifacts').insert({
      artifact_id: artifactId(input.goalId, input.artifact.artifactKey),
      goal_id: input.goalId,
      ...desired,
      created_at: nowIso(),
      updated_at: nowIso(),
    });
  }
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

function validateAssociation(execution: ExecutionArtifactIdentity, artifact: GoalReportedArtifact): void {
  if (artifact.repository !== execution.repository) throw new GoalError(
    GOAL_ERROR_CODES.validation,
    'Reported artifact repository does not match the execution',
    400
  );
  if (artifact.finalEpicPullRequest
      && (artifact.headBranch !== execution.head_branch || artifact.baseBranch !== execution.base_branch)) {
    throw new GoalError(
      GOAL_ERROR_CODES.validation,
      'Final epic PR must report the execution head and base branches',
      400
    );
  }
}

function artifactTuple(executionId: string, artifact: GoalReportedArtifact, leaseEpoch: number) {
  return {
    execution_id: executionId, artifact_key: artifact.artifactKey, kind: artifact.kind,
    repository: artifact.repository, external_ref: artifact.externalRef, url: artifact.url ?? null,
    head_branch: artifact.headBranch ?? null, base_branch: artifact.baseBranch ?? null,
    head_sha: artifact.headSha ?? null, state: artifact.state ?? null,
    draft: artifact.draft == null ? null : Number(artifact.draft), marker: artifact.marker,
    final_slot: artifact.finalEpicPullRequest ? 'final' : null, lease_generation: leaseEpoch,
  };
}

function sameArtifactIdentity(existing: ArtifactRecord, desired: ReturnType<typeof artifactTuple>): boolean {
  const mutable = new Set(['lease_generation', 'head_sha', 'state', 'draft']);
  return Object.entries(desired).filter(([key]) => !mutable.has(key))
    .every(([key, value]) => existing[key as keyof ArtifactRecord] === value);
}

function artifactId(goalId: string, key: string): string {
  return `gart_${crypto.createHash('sha256').update(`${goalId}\0${key}`).digest('hex')}`;
}

function toArtifact(row: ArtifactRecord): PersistedGoalReportedArtifact {
  return {
    artifactId: row.artifact_id, goalId: row.goal_id, executionId: row.execution_id,
    artifactKey: row.artifact_key, kind: row.kind, repository: row.repository,
    externalRef: row.external_ref, url: row.url, headBranch: row.head_branch,
    baseBranch: row.base_branch, headSha: row.head_sha, state: row.state,
    draft: row.draft === null ? null : Boolean(row.draft), marker: row.marker,
    finalEpicPullRequest: row.final_slot === 'final', leaseGeneration: row.lease_generation,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}
