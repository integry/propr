import crypto from 'crypto';
import type { Knex } from 'knex';
import { GOAL_ERROR_CODES } from '@propr/shared';
import type {
  CreateNodeInput,
  GoalLeaseFence,
  GoalNode,
  GoalNodeRecord,
  GoalProviderSessionRecord,
  ProviderSessionUpdate,
} from './goalTypes.js';
import {
  GoalError,
  boundedText,
  guardLease,
  goalTransaction,
  idempotencyKey,
  nowIso,
  toNode,
} from './goalRepositorySupport.js';

const MAX_RECOVERY_METADATA_BYTES = 4096;

export class GoalHierarchyRepository {
  constructor(private readonly db: Knex) {}

  async addNode(goalId: string, input: CreateNodeInput): Promise<GoalNode> {
    const normalized = normalizeNode(input);
    return goalTransaction(this.db, async (trx) => {
      await guardLease(trx, goalId, normalized);
      const existing = await trx<GoalNodeRecord>('goal_nodes').where({
        goal_id: goalId,
        idempotency_key: normalized.idempotencyKey,
      }).first();
      if (existing) {
        if (!sameNodeRequest(existing, normalized)) {
          throw new GoalError(GOAL_ERROR_CODES.idempotencyConflict, 'Node idempotency key was reused with a different payload', 409);
        }
        return toNode(existing);
      }
      if (normalized.nodeId) {
        const duplicateId = await trx('goal_nodes').where('node_id', normalized.nodeId).first('node_id');
        if (duplicateId) throw new GoalError(GOAL_ERROR_CODES.idempotencyConflict, 'Requested node identifier already exists', 409);
      }
      if (normalized.parentNodeId) {
        const parent = await trx('goal_nodes').where({ goal_id: goalId, node_id: normalized.parentNodeId }).first('node_id');
        if (!parent) throw new GoalError(GOAL_ERROR_CODES.hierarchyConflict, 'Parent node must belong to the same goal', 409);
      }
      const now = nowIso();
      const record: GoalNodeRecord = {
        node_id: normalized.nodeId ?? crypto.randomUUID(),
        requested_node_id: normalized.nodeId,
        goal_id: goalId,
        parent_node_id: normalized.parentNodeId,
        kind: normalized.kind,
        idempotency_key: normalized.idempotencyKey,
        external_ref: normalized.externalRef,
        external_kind: normalized.externalKind,
        title: normalized.title,
        status: normalized.status,
        attempt_count: 0,
        order_index: normalized.orderIndex,
        created_at: now,
        updated_at: now,
      };
      await trx('goal_nodes').insert(record);
      return toNode(record);
    });
  }

  async addDependency(
    goalId: string,
    nodeId: string,
    dependsOnNodeId: string,
    fence: GoalLeaseFence
  ): Promise<void> {
    const node = boundedText(nodeId, 'nodeId') as string;
    const dependency = boundedText(dependsOnNodeId, 'dependsOnNodeId') as string;
    await goalTransaction(this.db, async (trx) => {
      await guardLease(trx, goalId, fence);
      const nodes = await trx('goal_nodes').where('goal_id', goalId).whereIn('node_id', [node, dependency]);
      if (nodes.length !== 2) {
        throw new GoalError(GOAL_ERROR_CODES.hierarchyConflict, 'Both dependency nodes must belong to the same goal', 409);
      }
      const dependencies = await trx('goal_node_dependencies').where('goal_id', goalId).select('node_id', 'depends_on_node_id');
      const edges = new Map<string, string[]>();
      for (const edge of dependencies) {
        const targets = edges.get(edge.node_id) ?? [];
        targets.push(edge.depends_on_node_id);
        edges.set(edge.node_id, targets);
      }
      assertAcyclic(edges, node, dependency);
      await trx('goal_node_dependencies').insert({
        goal_id: goalId,
        node_id: node,
        depends_on_node_id: dependency,
        created_at: nowIso(),
      }).onConflict(['goal_id', 'node_id', 'depends_on_node_id']).ignore();
    });
  }

  async getNodes(goalId: string): Promise<GoalNode[]> {
    const rows = await this.db<GoalNodeRecord>('goal_nodes').where('goal_id', goalId)
      .orderBy('order_index', 'asc').orderBy('node_id', 'asc');
    return rows.map(toNode);
  }

  async getDependencies(goalId: string): Promise<Array<{ nodeId: string; dependsOnNodeId: string }>> {
    const rows = await this.db('goal_node_dependencies').where('goal_id', goalId)
      .select('node_id', 'depends_on_node_id');
    return rows.map((row) => ({ nodeId: row.node_id, dependsOnNodeId: row.depends_on_node_id }));
  }

  async upsertProviderSession(
    goalId: string,
    agent: string,
    fields: ProviderSessionUpdate
  ): Promise<void> {
    const normalizedAgent = boundedText(agent, 'agent') as string;
    validateProviderFields(fields);
    await goalTransaction(this.db, async (trx) => {
      const goal = await guardLease(trx, goalId, fields);
      const existing = await trx<GoalProviderSessionRecord>('goal_provider_sessions')
        .where({ goal_id: goalId, agent: normalizedAgent }).first();
      const recoveryJson = fields.recoveryMetadata === undefined
        ? existing?.recovery_metadata_json ?? null
        : validateRecoveryMetadata(fields.recoveryMetadata);
      const now = nowIso();
      if (existing) {
        const affected = await trx('goal_provider_sessions').where({
          session_id: existing.session_id,
          goal_id: goalId,
          lease_generation: existing.lease_generation,
        }).update({
          provider_thread_id: fields.providerThreadId ?? existing.provider_thread_id,
          runtime_id: fields.runtimeId ?? existing.runtime_id,
          worktree_id: fields.worktreeId ?? existing.worktree_id,
          last_checkpoint: fields.lastCheckpoint ?? existing.last_checkpoint,
          effective_model: fields.effectiveModel ?? existing.effective_model,
          recovery_metadata_json: recoveryJson,
          lease_generation: fields.leaseEpoch,
          updated_at: now,
        });
        if (affected !== 1) throw new GoalError(GOAL_ERROR_CODES.staleLease, 'Provider session changed concurrently', 409);
        return;
      }
      await trx('goal_provider_sessions').insert({
        session_id: crypto.randomUUID(), goal_id: goalId, agent: normalizedAgent,
        provider_thread_id: fields.providerThreadId ?? null,
        runtime_id: fields.runtimeId ?? null, worktree_id: fields.worktreeId ?? null,
        last_checkpoint: fields.lastCheckpoint ?? null,
        effective_model: fields.effectiveModel ?? goal.effective_model,
        recovery_metadata_json: recoveryJson, lease_generation: fields.leaseEpoch,
        created_at: now, updated_at: now,
      });
    });
  }

  async getProviderSession(goalId: string, agent: string): Promise<GoalProviderSessionRecord | null> {
    const row = await this.db<GoalProviderSessionRecord>('goal_provider_sessions')
      .where({ goal_id: goalId, agent }).first();
    return row ?? null;
  }
}

type NormalizedNode = Required<Omit<CreateNodeInput, 'nodeId' | 'parentNodeId' | 'externalRef' | 'externalKind' | 'title'>> & {
  nodeId: string | null;
  parentNodeId: string | null;
  externalRef: string | null;
  externalKind: string | null;
  title: string | null;
};

function normalizeNode(input: CreateNodeInput): NormalizedNode {
  const orderIndex = input.orderIndex ?? 0;
  if (!Number.isSafeInteger(orderIndex) || orderIndex < 0) {
    throw new GoalError(GOAL_ERROR_CODES.validation, 'orderIndex must be a non-negative safe integer', 400);
  }
  return {
    nodeId: boundedText(input.nodeId, 'nodeId', undefined, true),
    parentNodeId: boundedText(input.parentNodeId, 'parentNodeId', undefined, true),
    kind: input.kind,
    idempotencyKey: idempotencyKey(input.idempotencyKey),
    externalRef: boundedText(input.externalRef, 'externalRef', undefined, true),
    externalKind: boundedText(input.externalKind, 'externalKind', undefined, true),
    title: boundedText(input.title, 'title', 1000, true),
    status: input.status ?? 'pending',
    orderIndex,
    leaseOwner: boundedText(input.leaseOwner, 'leaseOwner') as string,
    leaseEpoch: input.leaseEpoch,
  };
}

function sameNodeRequest(row: GoalNodeRecord, input: NormalizedNode): boolean {
  return row.requested_node_id === input.nodeId
    && row.parent_node_id === input.parentNodeId
    && row.kind === input.kind
    && row.external_ref === input.externalRef
    && row.external_kind === input.externalKind
    && row.title === input.title
    && row.status === input.status
    && row.order_index === input.orderIndex;
}

function assertAcyclic(edges: Map<string, string[]>, nodeId: string, dependencyId: string): void {
  const pending = [dependencyId];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current === nodeId) throw new GoalError(GOAL_ERROR_CODES.hierarchyConflict, 'Dependency would create a cycle', 409);
    if (visited.has(current)) continue;
    visited.add(current);
    pending.push(...(edges.get(current) ?? []));
  }
}

function validateProviderFields(fields: ProviderSessionUpdate): void {
  for (const [name, value] of Object.entries({
    providerThreadId: fields.providerThreadId,
    runtimeId: fields.runtimeId,
    worktreeId: fields.worktreeId,
    effectiveModel: fields.effectiveModel,
  })) {
    if (value !== undefined) boundedText(value, name, undefined, true);
  }
  if (fields.lastCheckpoint !== undefined && fields.lastCheckpoint !== null
    && (typeof fields.lastCheckpoint !== 'string' || Buffer.byteLength(fields.lastCheckpoint, 'utf8') > 4096)) {
    throw new GoalError(GOAL_ERROR_CODES.validation, 'lastCheckpoint exceeds 4096 bytes', 400);
  }
}

function validateRecoveryMetadata(value: ProviderSessionUpdate['recoveryMetadata']): string | null {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalidRecovery();
  const metadata = value as unknown as Record<string, unknown>;
  const allowed = new Set(['schemaVersion', 'reason', 'attempt', 'lastEventSequence', 'providerState']);
  if (Object.keys(metadata).some((key) => !allowed.has(key)) || metadata.schemaVersion !== 1) invalidRecovery();
  if (metadata.reason !== undefined && (typeof metadata.reason !== 'string' || metadata.reason.length > 256)) invalidRecovery();
  for (const field of ['attempt', 'lastEventSequence'] as const) {
    const candidate = metadata[field];
    if (candidate !== undefined && (!Number.isSafeInteger(candidate) || (candidate as number) < 0)) invalidRecovery();
  }
  if (metadata.providerState !== undefined
    && !['starting', 'active', 'interrupted', 'recoverable'].includes(metadata.providerState as string)) invalidRecovery();
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json, 'utf8') > MAX_RECOVERY_METADATA_BYTES) invalidRecovery();
  return json;
}

function invalidRecovery(): never {
  throw new GoalError(GOAL_ERROR_CODES.recoveryMetadataInvalid, 'Recovery metadata is invalid', 400);
}
