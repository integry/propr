import crypto from 'crypto';
import type { Knex } from 'knex';
import { GOAL_CHECKLIST_DEFAULT_LIMIT, GOAL_CHECKLIST_MAX_LIMIT, GOAL_ERROR_CODES } from '@propr/shared';
import type {
  CreateNodeInput,
  GoalLeaseFence,
  GoalNode,
  GoalNodeRecord,
  GoalRecord,
  GoalProviderSessionRecord,
  ProviderSessionUpdate,
  GoalNodePageResult,
} from './goalTypes.js';
import { decodeChecklistCursor, encodeChecklistCursor } from './goalChecklistCursor.js';
import {
  GoalError,
  boundedText,
  guardLease,
  goalTransaction,
  idempotencyKey,
  nowIso,
  requireGoalRecord,
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

  async readNodePage(
    goalId: string,
    options: { cursor?: string | null; limit?: number } = {}
  ): Promise<GoalNodePageResult> {
    const limit = options.limit ?? GOAL_CHECKLIST_DEFAULT_LIMIT;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > GOAL_CHECKLIST_MAX_LIMIT) {
      throw new GoalError(GOAL_ERROR_CODES.validation, `limit must be from 1 to ${GOAL_CHECKLIST_MAX_LIMIT}`, 400);
    }
    const goal = await requireGoalRecord(this.db, goalId);
    const binding = { goalId, ownerUserId: goal.owner_user_id, repository: goal.repository };
    const cursor = decodeChecklistCursor(options.cursor, binding);
    let query = this.db<GoalNodeRecord>('goal_nodes').where('goal_id', goalId);
    if (cursor) {
      query = query.andWhere(nested => {
        void nested.where('order_index', '>', cursor.orderIndex).orWhere(same => {
          void same.where('order_index', cursor.orderIndex).andWhere('node_id', '>', cursor.nodeId);
        });
      });
    }
    const rows = await query.orderBy('order_index', 'asc').orderBy('node_id', 'asc').limit(limit + 1);
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      nodes: page.map(toNode),
      nextCursor: rows.length > limit && last ? encodeChecklistCursor(binding, {
        orderIndex: last.order_index, nodeId: last.node_id, createdAt: last.created_at,
      }) : null,
    };
  }

  async getNodeCounts(goalId: string): Promise<{ total: number; active: number }> {
    const row = await this.db('goal_nodes').where('goal_id', goalId).first(
      this.db.raw('COUNT(*) AS total'),
      this.db.raw("SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) AS active")
    ) as { total?: number; active?: number } | undefined;
    return { total: Number(row?.total ?? 0), active: Number(row?.active ?? 0) };
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
    const hasExecutionIdentity = await this.db.schema.hasColumn('goal_provider_sessions', 'current_turn_id');
    await goalTransaction(this.db, async (trx) => {
      const goal = await guardLease(trx, goalId, fields);
      assertSelectedAgent(normalizedAgent, goal.agent);
      const existing = await trx<GoalProviderSessionRecord>('goal_provider_sessions')
        .where({ goal_id: goalId, agent: normalizedAgent }).first();
      const recoveryJson = fields.recoveryMetadata === undefined
        ? existing?.recovery_metadata_json ?? null
        : validateRecoveryMetadata(fields.recoveryMetadata);
      const now = nowIso();
      if (existing) {
        await updateProviderSession(trx, {
          goalId, fields, existing, recoveryJson, now, hasExecutionIdentity,
        });
        return;
      }
      await insertProviderSession(trx, {
        goal, agent: normalizedAgent, fields, recoveryJson, now, hasExecutionIdentity,
      });
    });
  }

  async getProviderSession(goalId: string, agent: string): Promise<GoalProviderSessionRecord | null> {
    const row = await this.db<GoalProviderSessionRecord>('goal_provider_sessions')
      .where({ goal_id: goalId, agent }).first();
    return row ?? null;
  }
}

function assertSelectedAgent(agent: string, selectedAgent: string): void {
  if (agent !== selectedAgent) {
    throw new GoalError(GOAL_ERROR_CODES.validation, 'Provider session must use the goal selected agent', 400);
  }
}

async function updateProviderSession(
  trx: Knex.Transaction,
  context: {
    goalId: string; fields: ProviderSessionUpdate; existing: GoalProviderSessionRecord;
    recoveryJson: string | null; now: string; hasExecutionIdentity: boolean;
  }
): Promise<void> {
  const { goalId, fields, existing, recoveryJson, now, hasExecutionIdentity } = context;
  if (fields.providerThreadId !== undefined && fields.providerThreadId !== null
    && existing.provider_thread_id !== null && fields.providerThreadId !== existing.provider_thread_id) {
    throw new GoalError(GOAL_ERROR_CODES.idempotencyConflict, 'Provider thread identity is immutable', 409);
  }
  if (fields.worktreeId !== undefined && fields.worktreeId !== null
    && existing.worktree_id !== null && fields.worktreeId !== existing.worktree_id) {
    throw new GoalError(GOAL_ERROR_CODES.idempotencyConflict, 'Goal worktree identity is immutable', 409);
  }
  const update = {
    provider_thread_id: preserveUndefined(fields.providerThreadId, existing.provider_thread_id),
    runtime_id: preserveUndefined(fields.runtimeId, existing.runtime_id),
    worktree_id: preserveUndefined(fields.worktreeId, existing.worktree_id),
    last_checkpoint: preserveUndefined(fields.lastCheckpoint, existing.last_checkpoint),
    effective_model: fields.effectiveModel ?? existing.effective_model,
    recovery_metadata_json: recoveryJson,
    lease_generation: fields.leaseEpoch,
    updated_at: now,
    ...(hasExecutionIdentity ? {
      current_turn_id: preserveUndefined(fields.turnId, existing.current_turn_id ?? null),
      current_execution_id: preserveUndefined(fields.executionId, existing.current_execution_id ?? null),
      current_attempt_id: preserveUndefined(fields.attemptId, existing.current_attempt_id ?? null),
    } : {}),
  };
  const affected = await trx('goal_provider_sessions').where({
    session_id: existing.session_id, goal_id: goalId, lease_generation: existing.lease_generation,
  }).update(update);
  if (affected !== 1) throw new GoalError(GOAL_ERROR_CODES.staleLease, 'Provider session changed concurrently', 409);
}

function insertProviderSession(
  trx: Knex.Transaction,
  context: {
    goal: GoalRecord; agent: string; fields: ProviderSessionUpdate;
    recoveryJson: string | null; now: string; hasExecutionIdentity: boolean;
  }
): Promise<number[]> {
  const { goal, agent, fields, recoveryJson, now, hasExecutionIdentity } = context;
  return trx('goal_provider_sessions').insert({
    session_id: crypto.randomUUID(), goal_id: goal.goal_id, agent,
    provider_thread_id: fields.providerThreadId ?? null,
    runtime_id: fields.runtimeId ?? null, worktree_id: fields.worktreeId ?? null,
    last_checkpoint: fields.lastCheckpoint ?? null,
    effective_model: fields.effectiveModel ?? goal.effective_model,
    recovery_metadata_json: recoveryJson, lease_generation: fields.leaseEpoch,
    created_at: now, updated_at: now,
    ...(hasExecutionIdentity ? {
      current_turn_id: fields.turnId ?? null,
      current_execution_id: fields.executionId ?? null,
      current_attempt_id: fields.attemptId ?? null,
    } : {}),
  });
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
    turnId: fields.turnId,
    executionId: fields.executionId,
    attemptId: fields.attemptId,
  })) {
    if (value !== undefined) boundedText(value, name, undefined, true);
  }
  if (fields.lastCheckpoint !== undefined && fields.lastCheckpoint !== null
    && (typeof fields.lastCheckpoint !== 'string' || Buffer.byteLength(fields.lastCheckpoint, 'utf8') > 4096)) {
    throw new GoalError(GOAL_ERROR_CODES.validation, 'lastCheckpoint exceeds 4096 bytes', 400);
  }
}

function preserveUndefined<T>(value: T | undefined, existing: T): T {
  return value === undefined ? existing : value;
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
