import crypto from 'node:crypto';
import type { Knex } from 'knex';
import { GOAL_ERROR_CODES } from '@propr/shared';
import { GoalAttemptStore, type ArtifactRow } from './goalAttemptStore.js';
import { GoalError, boundedText, goalTransaction, guardLease, idempotencyKey, nowIso } from './goalRepositorySupport.js';
import type { GoalLeaseFence } from './goalTypes.js';
import type {
  GoalArtifactKind, GoalArtifactMarker, GoalArtifactState, GoalClaimedOutboxOperation,
  GoalGitHubArtifact, GoalGitHubRemoteArtifact, GoalOutboxOperation, GoalOutboxOperationKind,
} from './goalOrchestrationTypes.js';

export interface GoalArtifactRow extends ArtifactRow {
  kind: GoalArtifactKind;
  state: GoalArtifactState;
}

interface OutboxRow {
  operation_id: string; goal_id: string; node_id: string; artifact_id: string | null;
  operation_kind: GoalOutboxOperationKind; idempotency_key: string; marker: string;
  payload_json: string; attempts: number; claimed_by: string | null;
  claim_token: string | null; claim_expires_at: string | null; state: string;
}

/** Marker-bound GitHub artifact and renewable outbox claim persistence. */
export class GoalGitHubStore extends GoalAttemptStore {
  async acquireBranchLock(input: {
    goalId: string; nodeId: string; targetBranch: string; owner: string; ttlMs: number;
    fence: GoalLeaseFence;
  }): Promise<boolean> {
    const lockOwner = boundedText(input.owner, 'owner') as string;
    const branch = boundedText(input.targetBranch, 'targetBranch') as string;
    positive(input.ttlMs, 'ttlMs', 86_400_000);
    return goalTransaction(this.db, async (trx) => {
      const goal = await guardLease(trx, input.goalId, input.fence);
      const timestamp = nowIso();
      await trx('goal_branch_locks').where('expires_at', '<=', timestamp).delete();
      const inserted = await trx('goal_branch_locks').insert({
        repository: goal.repository, target_branch: branch, goal_id: input.goalId, node_id: input.nodeId,
        owner: lockOwner, lease_generation: input.fence.leaseEpoch,
        expires_at: nowIso(Date.now() + input.ttlMs), created_at: timestamp,
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
      const tuple: GoalArtifactMarker = {
        schemaVersion: 1, repository: goal.repository, goalId: input.goalId,
        nodeId: input.nodeId, artifactKind: input.artifactKind,
        head: input.head ?? null, base: input.base ?? null,
      };
      const marker = buildGoalArtifactMarker(tuple);
      const existing = await trx<OutboxRow>('goal_github_outbox')
        .where({ goal_id: input.goalId, idempotency_key: key }).first();
      if (existing) return updatePendingPayload(trx, existing, input, marker);
      const artifactId = artifactIdentity(input.goalId, input.nodeId, input.artifactKind);
      await ensureArtifact(trx, {
        artifactId, repository: goal.repository, input, marker,
      });
      const record: OutboxRow = {
        operation_id: crypto.randomUUID(), goal_id: input.goalId, node_id: input.nodeId,
        artifact_id: artifactId, operation_kind: input.operationKind, idempotency_key: key,
        marker, payload_json: JSON.stringify(input.payload), state: 'pending', attempts: 0,
        claimed_by: null, claim_token: null, claim_expires_at: null,
      };
      await trx('goal_github_outbox').insert({
        ...record, claim_generation: null, last_error: null, available_at: nowIso(),
        completed_at: null, superseded_at: null, created_at: nowIso(), updated_at: nowIso(),
      });
      return toOutbox(record);
    });
  }

  async claimGitHubOperations(
    goalId: string,
    owner: string,
    claim: number | { limit: number; ttlMs?: number },
    fence: GoalLeaseFence
  ): Promise<GoalClaimedOutboxOperation[]> {
    const limit = positive(typeof claim === 'number' ? claim : claim.limit, 'limit', 100);
    const ttlMs = positive(typeof claim === 'number' ? 60_000 : claim.ttlMs ?? 60_000, 'ttlMs', 86_400_000);
    return goalTransaction(this.db, async (trx) => {
      await guardLease(trx, goalId, fence);
      const timestamp = nowIso();
      await trx('goal_github_outbox').where({ goal_id: goalId, state: 'claimed' })
        .andWhere('claim_expires_at', '<=', timestamp).update({
          state: 'pending', claimed_by: null, claim_generation: null,
          claim_token: null, claim_expires_at: null, updated_at: timestamp,
        });
      const rows = await trx<OutboxRow>('goal_github_outbox').where({ goal_id: goalId, state: 'pending' })
        .andWhere('available_at', '<=', timestamp).orderBy('created_at').limit(limit);
      const claimed: GoalClaimedOutboxOperation[] = [];
      for (const row of rows) {
        const claimToken = crypto.randomUUID();
        const claimExpiresAt = nowIso(Date.now() + ttlMs);
        const changed = await trx('goal_github_outbox').where({ operation_id: row.operation_id, state: 'pending' }).update({
          state: 'claimed', claimed_by: owner, claim_generation: fence.leaseEpoch,
          claim_token: claimToken, claim_expires_at: claimExpiresAt,
          attempts: trx.raw('attempts + 1'), updated_at: timestamp,
        });
        if (changed === 1) claimed.push({
          ...toOutbox({ ...row, attempts: row.attempts + 1 }),
          claimOwner: owner, claimToken, claimExpiresAt,
        });
      }
      return claimed;
    });
  }

  async renewGitHubOperationClaim(operation: GoalClaimedOutboxOperation, ttlMs: number, fence: GoalLeaseFence): Promise<void> {
    positive(ttlMs, 'ttlMs', 86_400_000);
    await goalTransaction(this.db, async (trx) => {
      await guardLease(trx, operation.goalId, fence);
      const changed = await claimedOperation(trx, operation).andWhere('claim_expires_at', '>', nowIso())
        .update({ claim_expires_at: nowIso(Date.now() + ttlMs), updated_at: nowIso() });
      if (changed !== 1) staleClaim();
    });
  }

  async renewGitHubOperationClaims(
    operations: GoalClaimedOutboxOperation[],
    ttlMs: number,
    fence: GoalLeaseFence
  ): Promise<void> {
    if (operations.length === 0) return;
    positive(ttlMs, 'ttlMs', 86_400_000);
    await goalTransaction(this.db, async (trx) => {
      await guardLease(trx, operations[0].goalId, fence);
      const timestamp = nowIso();
      const claimExpiresAt = nowIso(Date.now() + ttlMs);
      for (const operation of operations) {
        if (operation.goalId !== operations[0].goalId) staleClaim();
        const changed = await claimedOperation(trx, operation).andWhere('claim_expires_at', '>', timestamp)
          .update({ claim_expires_at: claimExpiresAt, updated_at: timestamp });
        if (changed !== 1) staleClaim();
      }
    });
  }

  async adoptGitHubArtifact(operation: GoalClaimedOutboxOperation, remote: GoalGitHubRemoteArtifact, fence: GoalLeaseFence): Promise<GoalGitHubArtifact> {
    return goalTransaction(this.db, async (trx) => {
      await guardLease(trx, operation.goalId, fence);
      const row = await claimedOperation(trx, operation).first<OutboxRow>();
      if (!row) staleClaim();
      const expected = parseGoalArtifactMarker(row!.marker);
      assertRemote(remote, expected);
      const timestamp = nowIso();
      await trx('goal_github_artifacts').where('artifact_id', row!.artifact_id).update({
        remote_id: remote.remoteId, number: remote.number ?? null, url: remote.url ?? null,
        head_branch: remote.headBranch ?? expected.head, base_branch: remote.baseBranch ?? expected.base,
        head_sha: remote.headSha ?? null, base_sha: remote.baseSha ?? null, state: remote.state,
        last_observed_at: timestamp, updated_at: timestamp,
      });
      if (await completeClaim(trx, operation, timestamp) !== 1) staleClaim();
      return toArtifact((await trx<GoalArtifactRow>('goal_github_artifacts').where('artifact_id', row!.artifact_id).first())!);
    });
  }

  async completeNoArtifactOperation(operation: GoalClaimedOutboxOperation, fence: GoalLeaseFence): Promise<void> {
    await goalTransaction(this.db, async (trx) => {
      await guardLease(trx, operation.goalId, fence);
      if (await completeClaim(trx, operation, nowIso()) !== 1) staleClaim();
    });
  }

  async retryGitHubOperation(operation: GoalClaimedOutboxOperation, error: string, fence: GoalLeaseFence): Promise<void> {
    await goalTransaction(this.db, async (trx) => {
      await guardLease(trx, operation.goalId, fence);
      const changed = await claimedOperation(trx, operation).update({
        state: 'pending', claimed_by: null, claim_generation: null, claim_token: null,
        claim_expires_at: null, last_error: error.slice(0, 2000),
        available_at: nowIso(Date.now() + 1000), updated_at: nowIso(),
      });
      if (changed !== 1) staleClaim();
    });
  }

  async reconcileArtifacts(goalId: string, remotes: GoalGitHubRemoteArtifact[], fence: GoalLeaseFence): Promise<void> {
    await goalTransaction(this.db, async (trx) => {
      await guardLease(trx, goalId, fence);
      const artifacts = await trx<GoalArtifactRow>('goal_github_artifacts').where('goal_id', goalId);
      const byMarker = new Map(remotes.map((remote) => [remote.marker, remote]));
      for (const artifact of artifacts) {
        const remote = byMarker.get(artifact.marker);
        if (!remote) {
          await reconcileMissingArtifact(trx, artifact);
          continue;
        }
        assertRemote(remote, parseGoalArtifactMarker(artifact.marker));
        await updateObservedArtifact(trx, artifact, remote);
        await reconcileDrift(trx, artifact, remote);
      }
    });
  }

  async getArtifacts(goalId: string): Promise<GoalGitHubArtifact[]> {
    return (await this.db<GoalArtifactRow>('goal_github_artifacts').where('goal_id', goalId)
      .orderBy(['node_id', 'kind'])).map(toArtifact);
  }
}

export function buildGoalArtifactMarker(marker: GoalArtifactMarker): string {
  const canonical = JSON.stringify({
    schemaVersion: 1, repository: marker.repository, goalId: marker.goalId,
    nodeId: marker.nodeId, artifactKind: marker.artifactKind, head: marker.head, base: marker.base,
  });
  return `<!-- propr-goal:${Buffer.from(canonical).toString('base64url')} -->`;
}

export function parseGoalArtifactMarker(value: string): GoalArtifactMarker {
  const match = /^<!-- propr-goal:([A-Za-z0-9_-]+) -->$/.exec(value);
  if (!match) invalidMarker();
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.from(match![1], 'base64url').toString('utf8')); } catch { invalidMarker(); }
  if (!parsed || typeof parsed !== 'object') invalidMarker();
  const marker = parsed as Record<string, unknown>;
  const keys = Object.keys(marker).sort();
  if (JSON.stringify(keys) !== JSON.stringify(['artifactKind', 'base', 'goalId', 'head', 'nodeId', 'repository', 'schemaVersion'])) invalidMarker();
  if (marker.schemaVersion !== 1 || typeof marker.repository !== 'string' || typeof marker.goalId !== 'string'
    || typeof marker.nodeId !== 'string' || !['issue', 'branch', 'pull_request', 'comment', 'label'].includes(String(marker.artifactKind))
    || (marker.head !== null && typeof marker.head !== 'string') || (marker.base !== null && typeof marker.base !== 'string')) invalidMarker();
  return marker as unknown as GoalArtifactMarker;
}

function claimedOperation(trx: Knex.Transaction, operation: GoalClaimedOutboxOperation) {
  return trx('goal_github_outbox').where({
    goal_id: operation.goalId, operation_id: operation.operationId, state: 'claimed',
    claimed_by: operation.claimOwner, claim_token: operation.claimToken,
  });
}

function completeClaim(trx: Knex.Transaction, operation: GoalClaimedOutboxOperation, timestamp: string) {
  return claimedOperation(trx, operation).update({
    state: 'succeeded', completed_at: timestamp, claimed_by: null, claim_generation: null,
    claim_token: null, claim_expires_at: null, updated_at: timestamp,
  });
}

async function ensureArtifact(trx: Knex.Transaction, options: {
  artifactId: string; repository: string;
  input: { goalId: string; nodeId: string; artifactKind: GoalArtifactKind; head?: string | null; base?: string | null };
  marker: string;
}): Promise<void> {
  const { artifactId, repository, input, marker } = options;
  await trx('goal_github_artifacts').insert({
    artifact_id: artifactId, goal_id: input.goalId, node_id: input.nodeId,
    kind: input.artifactKind, repository, remote_id: null, number: null, url: null,
    head_branch: input.head ?? null, base_branch: input.base ?? null, head_sha: null, base_sha: null,
    state: 'expected', marker, last_observed_at: null, created_at: nowIso(), updated_at: nowIso(),
  }).onConflict(['goal_id', 'node_id', 'kind']).ignore();
  const artifact = await trx<GoalArtifactRow>('goal_github_artifacts').where('artifact_id', artifactId).first();
  if (artifact && artifact.marker !== marker) {
    await trx('goal_github_outbox').where({ artifact_id: artifactId }).whereIn('state', ['pending', 'claimed']).update({
      state: 'superseded', claimed_by: null, claim_generation: null, claim_token: null,
      claim_expires_at: null, superseded_at: nowIso(), updated_at: nowIso(),
    });
    await trx('goal_github_artifacts').where('artifact_id', artifactId).update({
      marker, head_branch: input.head ?? null, base_branch: input.base ?? null,
      remote_id: null, number: null, url: null, head_sha: null, base_sha: null,
      state: 'expected', last_observed_at: null, updated_at: nowIso(),
    });
  }
}

async function updatePendingPayload(trx: Knex.Transaction, row: OutboxRow, input: {
  operationKind: GoalOutboxOperationKind; payload: Record<string, unknown>;
}, marker: string): Promise<GoalOutboxOperation> {
  const operation = toOutbox(row);
  if (operation.operationKind !== input.operationKind || operation.marker !== marker) conflict();
  if (JSON.stringify(operation.payload) === JSON.stringify(input.payload)) return operation;
  const changed = await trx('goal_github_outbox').where({ operation_id: row.operation_id, state: 'pending' })
    .update({ payload_json: JSON.stringify(input.payload), updated_at: nowIso() });
  if (changed !== 1) conflict();
  return { ...operation, payload: input.payload };
}

async function reconcileMissingArtifact(trx: Knex.Transaction, artifact: GoalArtifactRow): Promise<void> {
  if (artifact.remote_id === null && artifact.state !== 'expected') return;
  await trx('goal_github_artifacts').where('artifact_id', artifact.artifact_id)
    .update({ state: 'deleted', last_observed_at: nowIso(), updated_at: nowIso() });
  if (artifact.remote_id !== null) await trx('goal_github_outbox').where({ artifact_id: artifact.artifact_id, state: 'succeeded' })
    .update({ state: 'pending', completed_at: null, available_at: nowIso(), updated_at: nowIso() });
}

async function updateObservedArtifact(trx: Knex.Transaction, artifact: GoalArtifactRow, remote: GoalGitHubRemoteArtifact): Promise<void> {
  await trx('goal_github_artifacts').where('artifact_id', artifact.artifact_id).update({
    remote_id: remote.remoteId, number: remote.number ?? null, url: remote.url ?? null,
    head_branch: remote.headBranch ?? artifact.head_branch, base_branch: remote.baseBranch ?? artifact.base_branch,
    head_sha: remote.headSha ?? null, base_sha: remote.baseSha ?? null, state: remote.state,
    last_observed_at: nowIso(), updated_at: nowIso(),
  });
}

async function reconcileDrift(trx: Knex.Transaction, artifact: GoalArtifactRow, remote: GoalGitHubRemoteArtifact): Promise<void> {
  if (artifact.kind === 'pull_request' && remote.state === 'closed') {
    await enqueueRepair(trx, artifact, 'update_pull_request', {
      payload: { state: 'open', head: artifact.head_branch, base: artifact.base_branch },
      key: `reopen:${artifact.artifact_id}:${remote.headSha ?? 'unknown'}`,
    });
  }
  const createKind = artifact.kind === 'issue' ? 'create_issue' : 'create_pull_request';
  const create = await trx<OutboxRow>('goal_github_outbox').where({ artifact_id: artifact.artifact_id, operation_kind: createKind })
    .orderBy('created_at', 'desc').first();
  const labels = create ? strings(JSON.parse(create.payload_json).labels) : [];
  if (labels.length > 0 && JSON.stringify([...(remote.labels ?? [])].sort()) !== JSON.stringify(labels)) {
    await enqueueRepair(trx, artifact, 'sync_labels', {
      payload: { number: remote.number, labels }, key: `labels:${artifact.artifact_id}:${hash(labels)}`,
    });
  }
}

async function enqueueRepair(trx: Knex.Transaction, artifact: GoalArtifactRow, kind: GoalOutboxOperationKind, operation: {
  payload: Record<string, unknown>; key: string;
}): Promise<void> {
  await trx('goal_github_outbox').insert({
    operation_id: crypto.randomUUID(), goal_id: artifact.goal_id, node_id: artifact.node_id,
    artifact_id: artifact.artifact_id, operation_kind: kind, idempotency_key: operation.key,
    marker: artifact.marker, payload_json: JSON.stringify(operation.payload), state: 'pending', attempts: 0,
    claimed_by: null, claim_generation: null, claim_token: null, claim_expires_at: null,
    last_error: null, available_at: nowIso(), completed_at: null, superseded_at: null,
    created_at: nowIso(), updated_at: nowIso(),
  }).onConflict(['goal_id', 'idempotency_key']).ignore();
}

function assertRemote(remote: GoalGitHubRemoteArtifact, expected: GoalArtifactMarker): void {
  const actual = parseGoalArtifactMarker(remote.marker);
  if (JSON.stringify(actual) !== JSON.stringify(expected) || remote.repository !== expected.repository
    || remote.kind !== expected.artifactKind || (remote.headBranch ?? null) !== expected.head
    || (remote.baseBranch ?? null) !== expected.base) conflict();
}

function toArtifact(row: GoalArtifactRow): GoalGitHubArtifact {
  return {
    artifactId: row.artifact_id, goalId: row.goal_id, nodeId: row.node_id, kind: row.kind,
    repository: row.repository, remoteId: row.remote_id, number: row.number, url: row.url,
    headBranch: row.head_branch, baseBranch: row.base_branch, headSha: row.head_sha,
    baseSha: row.base_sha, state: row.state, marker: row.marker, lastObservedAt: row.last_observed_at,
  };
}

function toOutbox(row: OutboxRow): GoalOutboxOperation {
  return {
    operationId: row.operation_id, goalId: row.goal_id, nodeId: row.node_id,
    artifactId: row.artifact_id, operationKind: row.operation_kind,
    idempotencyKey: row.idempotency_key, marker: row.marker,
    payload: JSON.parse(row.payload_json), attempts: row.attempts,
    claimOwner: row.claimed_by, claimToken: row.claim_token, claimExpiresAt: row.claim_expires_at,
  };
}

function artifactIdentity(goalId: string, nodeId: string, kind: GoalArtifactKind): string {
  return `ga_${crypto.createHash('sha256').update(`${goalId}\0${nodeId}\0${kind}`).digest('hex').slice(0, 32)}`;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? [...value].sort() : [];
}

function hash(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);
}

function positive(value: number, field: string, max: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new GoalError(GOAL_ERROR_CODES.validation, `${field} must be a positive integer`, 400);
  }
  return value;
}

function conflict(): never {
  throw new GoalError(GOAL_ERROR_CODES.idempotencyConflict, 'GitHub artifact identity conflict', 409);
}

function staleClaim(): never {
  throw new GoalError(GOAL_ERROR_CODES.staleLease, 'Outbox claim is stale', 409);
}

function invalidMarker(): never {
  throw new GoalError(GOAL_ERROR_CODES.validation, 'Malformed goal artifact marker', 400);
}
