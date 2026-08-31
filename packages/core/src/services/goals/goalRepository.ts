/* eslint-disable max-lines -- one cohesive repository for the goal domain */
/**
 * Durable repository for the goal control plane.
 *
 * Every invariant that spans more than one row is enforced here inside a
 * transaction, because SQLite CHECK constraints cannot express them:
 *
 *  - Monotonic per-goal event/message sequence allocation.
 *  - Fenced controller leases: a takeover strictly increases the epoch, and a
 *    stale epoch may not append authoritative events or commit transitions.
 *  - Optimistic concurrency: mutations may require an expected version and bump
 *    it on success so retries and racing writers cannot silently clobber.
 *  - Idempotency: create/append/enqueue accept an idempotency key and, on
 *    replay, return the already-committed row instead of duplicating effects.
 *  - State-machine validity and pause-interval accounting.
 *
 * The class takes a Knex instance so the API can use the shared connection and
 * tests can use an isolated in-memory database.
 */

import crypto from 'crypto';
import type { Knex } from 'knex';
import {
  GOAL_ERROR_CODES,
  GOAL_DEFAULT_MAX_ACTIVE_TASKS,
  GOAL_EVENT_KINDS,
  isValidGoalTransition,
  isTerminalGoalState,
  type GoalErrorCode,
} from '@propr/shared';
import type {
  Goal,
  GoalRecord,
  GoalNode,
  GoalNodeRecord,
  GoalEvent,
  GoalEventRecord,
  GoalMessage,
  GoalMessageRecord,
  GoalProviderSessionRecord,
  GoalIdempotencyRecord,
  CreateGoalInput,
  CreateNodeInput,
  AppendEventInput,
  EnqueueMessageInput,
  TransitionInput,
  ListGoalsQuery,
  ListGoalsResult,
  GoalActiveTimeStats,
  GoalLeaseFence,
  ProviderSessionUpdate,
} from './goalTypes.js';

const MAX_LIST_LIMIT = 100;
const DEFAULT_LIST_LIMIT = 25;
const MAX_EVENT_READ_LIMIT = 500;
const DEFAULT_EVENT_READ_LIMIT = 100;
const MAX_RECOVERY_METADATA_BYTES = 4096;

interface IdempotencyContext {
  trx: Knex.Transaction;
  ownerUserId: string;
  operation: string;
  key: string | undefined;
  request: unknown;
}

export class GoalError extends Error {
  readonly code: GoalErrorCode;
  readonly status: number;

  constructor(code: GoalErrorCode, message: string, status: number) {
    super(message);
    this.name = 'GoalError';
    this.code = code;
    this.status = status;
  }
}

function nowIso(): string {
  return new Date().toISOString().replace(/(\.\d{3})\d*Z$/, '$1Z');
}

function toGoal(row: GoalRecord): Goal {
  return {
    goalId: row.goal_id,
    ownerUserId: row.owner_user_id,
    repository: row.repository,
    objective: row.objective,
    state: row.state,
    agent: row.agent,
    requestedModel: row.requested_model,
    effectiveModel: row.effective_model,
    maxActiveTasks: row.max_active_tasks,
    ultrafixEnabled: Boolean(row.ultrafix_enabled),
    ultrafixGoal: row.ultrafix_goal,
    ultrafixMaxCycles: row.ultrafix_max_cycles,
    mergePolicy: row.merge_policy,
    version: row.version,
    leaseOwner: row.lease_owner,
    leaseEpoch: row.lease_epoch,
    leaseExpiresAt: row.lease_expires_at,
    terminalReason: row.terminal_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toNode(row: GoalNodeRecord): GoalNode {
  return {
    nodeId: row.node_id,
    goalId: row.goal_id,
    parentNodeId: row.parent_node_id,
    kind: row.kind,
    idempotencyKey: row.idempotency_key,
    externalRef: row.external_ref,
    externalKind: row.external_kind,
    title: row.title,
    status: row.status,
    attemptCount: row.attempt_count,
    orderIndex: row.order_index,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toEvent(row: GoalEventRecord): GoalEvent {
  return {
    id: row.id,
    goalId: row.goal_id,
    sequence: row.sequence,
    kind: row.kind,
    eventType: row.event_type,
    payload: row.payload_json === null ? null : JSON.parse(row.payload_json),
    idempotencyKey: row.idempotency_key,
    leaseEpoch: row.lease_epoch,
    createdAt: row.created_at,
  };
}

function toMessage(row: GoalMessageRecord): GoalMessage {
  return {
    messageId: row.message_id,
    goalId: row.goal_id,
    sequence: row.sequence,
    body: row.body,
    predefinedKind: row.predefined_kind,
    state: row.state,
    deliveredAt: row.delivered_at,
    acknowledgedAt: row.acknowledged_at,
    deliveryAttempts: row.delivery_attempts,
    lastError: row.last_error,
    idempotencyKey: row.idempotency_key,
    createdAt: row.created_at,
  };
}

export class GoalRepository {
  constructor(private readonly db: Knex) {}

  async createGoal(input: CreateGoalInput): Promise<Goal> {
    const maxActiveTasks = input.maxActiveTasks ?? GOAL_DEFAULT_MAX_ACTIVE_TASKS;
    const goalId = input.goalId ?? crypto.randomUUID();
    const request = {
      goalId: input.goalId ?? null,
      repository: input.repository,
      objective: input.objective,
      agent: input.agent,
      requestedModel: input.requestedModel,
      effectiveModel: input.effectiveModel ?? input.requestedModel,
      maxActiveTasks,
      ultrafixEnabled: input.ultrafixEnabled ?? false,
      ultrafixGoal: input.ultrafixGoal ?? null,
      ultrafixMaxCycles: input.ultrafixMaxCycles ?? null,
      mergePolicy: input.mergePolicy ?? 'manual',
    };

    return this.db.transaction(async (trx) => {
      const replay = await this.readIdempotency<Goal>({
        trx, ownerUserId: input.ownerUserId, operation: 'create',
        key: input.idempotencyKey, request,
      });
      if (replay) return replay;
      const existing = await trx<GoalRecord>('goals')
        .where('goal_id', goalId)
        .first();
      if (existing) {
        throw new GoalError(
          GOAL_ERROR_CODES.idempotencyConflict,
          'The requested goal identifier already exists',
          409
        );
      }

      const now = nowIso();
      const record: GoalRecord = {
        goal_id: goalId,
        owner_user_id: input.ownerUserId,
        repository: input.repository,
        objective: input.objective,
        state: 'queued',
        agent: input.agent,
        requested_model: input.requestedModel,
        effective_model: input.effectiveModel ?? input.requestedModel,
        max_active_tasks: maxActiveTasks,
        ultrafix_enabled: input.ultrafixEnabled ? 1 : 0,
        ultrafix_goal: input.ultrafixGoal ?? null,
        ultrafix_max_cycles: input.ultrafixMaxCycles ?? null,
        merge_policy: input.mergePolicy ?? 'manual',
        version: 1,
        lease_owner: null,
        lease_epoch: 0,
        lease_expires_at: null,
        terminal_reason: null,
        created_at: now,
        updated_at: now,
      };
      await trx('goals').insert(record);
      const goal = toGoal(record);
      await this.writeIdempotency({
        trx, ownerUserId: input.ownerUserId, operation: 'create',
        key: input.idempotencyKey, request, goalId, response: goal,
      });
      return goal;
    });
  }

  async getGoal(goalId: string): Promise<Goal | null> {
    const row = await this.db<GoalRecord>('goals').where('goal_id', goalId).first();
    return row ? toGoal(row) : null;
  }

  /** Load a goal, throwing a stable not-found error when absent. */
  async requireGoal(goalId: string): Promise<Goal> {
    const goal = await this.getGoal(goalId);
    if (!goal) {
      throw new GoalError(GOAL_ERROR_CODES.notFound, 'Goal not found', 404);
    }
    return goal;
  }

  async listGoals(query: ListGoalsQuery): Promise<ListGoalsResult> {
    const limit = Math.min(
      Math.max(1, query.limit ?? DEFAULT_LIST_LIMIT),
      MAX_LIST_LIMIT
    );
    let builder = this.db<GoalRecord>('goals').where(
      'owner_user_id',
      query.ownerUserId
    );
    if (query.repository) builder = builder.andWhere('repository', query.repository);
    if (query.state) builder = builder.andWhere('state', query.state);

    // Stable keyset pagination on (created_at, goal_id) descending. The cursor
    // is the last row's opaque token so concurrent inserts never skip rows.
    const cursor = decodeCursor(query.cursor);
    if (cursor) {
      builder = builder.andWhere((qb) => {
        void qb
          .where('created_at', '<', cursor.createdAt)
          .orWhere((inner) => {
            void inner
              .where('created_at', cursor.createdAt)
              .andWhere('goal_id', '<', cursor.goalId);
          });
      });
    }

    const rows = await builder
      .orderBy('created_at', 'desc')
      .orderBy('goal_id', 'desc')
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];
    const nextCursor =
      hasMore && last ? encodeCursor(last.created_at, last.goal_id) : null;
    return { goals: page.map(toGoal), nextCursor };
  }

  // ---- Hierarchy ---------------------------------------------------------

  async addNode(goalId: string, input: CreateNodeInput): Promise<GoalNode> {
    return this.db.transaction(async (trx) => {
      const goal = await this.requireGoalRecord(trx, goalId);
      this.assertLease(goal, input.leaseOwner, input.leaseEpoch);
      const existing = await trx<GoalNodeRecord>('goal_nodes')
        .where({ goal_id: goalId, idempotency_key: input.idempotencyKey })
        .first();
      if (existing) {
        if (
          existing.parent_node_id !== (input.parentNodeId ?? null) ||
          existing.kind !== input.kind ||
          existing.title !== (input.title ?? null)
        ) {
          throw new GoalError(
            GOAL_ERROR_CODES.idempotencyConflict,
            'Node idempotency key was reused with a different payload',
            409
          );
        }
        return toNode(existing);
      }
      if (input.parentNodeId) {
        const parent = await trx<GoalNodeRecord>('goal_nodes')
          .where({ goal_id: goalId, node_id: input.parentNodeId })
          .first();
        if (!parent) {
          throw new GoalError(
            GOAL_ERROR_CODES.hierarchyConflict,
            'Parent node must belong to the same goal',
            409
          );
        }
      }

      const now = nowIso();
      const record: GoalNodeRecord = {
        node_id: input.nodeId ?? crypto.randomUUID(),
        goal_id: goalId,
        parent_node_id: input.parentNodeId ?? null,
        kind: input.kind,
        idempotency_key: input.idempotencyKey,
        external_ref: input.externalRef ?? null,
        external_kind: input.externalKind ?? null,
        title: input.title ?? null,
        status: input.status ?? 'pending',
        attempt_count: 0,
        order_index: input.orderIndex ?? 0,
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
    await this.db.transaction(async (trx) => {
      const goal = await this.requireGoalRecord(trx, goalId);
      this.assertLease(goal, fence.leaseOwner, fence.leaseEpoch);
      const nodes = await trx<GoalNodeRecord>('goal_nodes')
        .where('goal_id', goalId)
        .whereIn('node_id', [nodeId, dependsOnNodeId]);
      if (nodes.length !== 2) {
        throw new GoalError(
          GOAL_ERROR_CODES.hierarchyConflict,
          'Both dependency nodes must belong to the same goal',
          409
        );
      }
      const dependencies = await trx('goal_node_dependencies')
        .where('goal_id', goalId)
        .select('node_id', 'depends_on_node_id');
      const edges = new Map<string, string[]>();
      for (const dependency of dependencies) {
        const targets = edges.get(dependency.node_id) ?? [];
        targets.push(dependency.depends_on_node_id);
        edges.set(dependency.node_id, targets);
      }
      const pending = [dependsOnNodeId];
      const visited = new Set<string>();
      while (pending.length > 0) {
        const current = pending.pop()!;
        if (current === nodeId) {
          throw new GoalError(
            GOAL_ERROR_CODES.hierarchyConflict,
            'Dependency would create a cycle',
            409
          );
        }
        if (visited.has(current)) continue;
        visited.add(current);
        pending.push(...(edges.get(current) ?? []));
      }
      await trx('goal_node_dependencies').insert({
        goal_id: goalId,
        node_id: nodeId,
        depends_on_node_id: dependsOnNodeId,
        created_at: nowIso(),
      })
        .onConflict(['goal_id', 'node_id', 'depends_on_node_id'])
        .ignore();
    });
  }

  async getNodes(goalId: string): Promise<GoalNode[]> {
    const rows = await this.db<GoalNodeRecord>('goal_nodes')
      .where('goal_id', goalId)
      .orderBy('order_index', 'asc')
      .orderBy('node_id', 'asc');
    return rows.map(toNode);
  }

  async getDependencies(
    goalId: string
  ): Promise<Array<{ nodeId: string; dependsOnNodeId: string }>> {
    const rows = await this.db('goal_node_dependencies')
      .where('goal_id', goalId)
      .select('node_id', 'depends_on_node_id');
    return rows.map((r) => ({
      nodeId: r.node_id,
      dependsOnNodeId: r.depends_on_node_id,
    }));
  }

  // ---- Provider sessions -------------------------------------------------

  async upsertProviderSession(
    goalId: string,
    agent: string,
    fields: ProviderSessionUpdate
  ): Promise<void> {
    const now = nowIso();
    await this.db.transaction(async (trx) => {
      const goal = await this.requireGoalRecord(trx, goalId);
      this.assertLease(goal, fields.leaseOwner, fields.leaseEpoch);
      const existing = await trx<GoalProviderSessionRecord>(
        'goal_provider_sessions'
      )
        .where({ goal_id: goalId, agent })
        .first();
      const recoveryJson = fields.recoveryMetadata === undefined
        ? existing?.recovery_metadata_json ?? null
        : validateRecoveryMetadata(fields.recoveryMetadata);
      if (existing) {
        await trx('goal_provider_sessions')
          .where({
            session_id: existing.session_id,
            goal_id: goalId,
          })
          .update({
            provider_thread_id: fields.providerThreadId ?? existing.provider_thread_id,
            runtime_id: fields.runtimeId ?? existing.runtime_id,
            worktree_id: fields.worktreeId ?? existing.worktree_id,
            last_checkpoint: fields.lastCheckpoint ?? existing.last_checkpoint,
            effective_model: fields.effectiveModel ?? existing.effective_model,
            recovery_metadata_json: recoveryJson,
            lease_generation: fields.leaseEpoch,
            updated_at: now,
          });
        return;
      }
      await trx('goal_provider_sessions').insert({
        session_id: crypto.randomUUID(),
        goal_id: goalId,
        agent,
        provider_thread_id: fields.providerThreadId ?? null,
        runtime_id: fields.runtimeId ?? null,
        worktree_id: fields.worktreeId ?? null,
        last_checkpoint: fields.lastCheckpoint ?? null,
        effective_model: fields.effectiveModel ?? goal.effective_model,
        recovery_metadata_json: recoveryJson,
        lease_generation: fields.leaseEpoch,
        created_at: now,
        updated_at: now,
      });
    });
  }

  async getProviderSession(
    goalId: string,
    agent: string
  ): Promise<GoalProviderSessionRecord | null> {
    const row = await this.db<GoalProviderSessionRecord>(
      'goal_provider_sessions'
    )
      .where({ goal_id: goalId, agent })
      .first();
    return row ?? null;
  }

  // ---- Events (append-only, monotonic sequence) --------------------------

  async appendEvent(goalId: string, input: AppendEventInput): Promise<GoalEvent> {
    return this.db.transaction(async (trx) => {
      const goal = await trx<GoalRecord>('goals')
        .where('goal_id', goalId)
        .first();
      if (!goal) {
        throw new GoalError(GOAL_ERROR_CODES.notFound, 'Goal not found', 404);
      }
      this.assertLease(goal, input.leaseOwner, input.leaseEpoch);
      if (!GOAL_EVENT_KINDS.includes(input.kind)) {
        throw new GoalError(
          GOAL_ERROR_CODES.invalidEventKind,
          'Event kind is not recognized',
          400
        );
      }

      const existing = await trx<GoalEventRecord>('goal_events')
        .where({ goal_id: goalId, idempotency_key: input.idempotencyKey })
        .first();
      if (existing) {
        const payloadJson = input.payload === undefined ? null : JSON.stringify(input.payload);
        if (
          existing.kind !== input.kind ||
          existing.event_type !== input.eventType ||
          existing.payload_json !== payloadJson
        ) {
          throw new GoalError(
            GOAL_ERROR_CODES.idempotencyConflict,
            'Event idempotency key was reused with a different payload',
            409
          );
        }
        return toEvent(existing);
      }

      const maxRow = (await trx('goal_events')
        .where('goal_id', goalId)
        .max('sequence as maxSeq')
        .first()) as { maxSeq: number | null } | undefined;
      const sequence = (maxRow?.maxSeq ?? 0) + 1;

      const record = {
        goal_id: goalId,
        sequence,
        kind: input.kind,
        event_type: input.eventType,
        payload_json:
          input.payload === undefined ? null : JSON.stringify(input.payload),
        idempotency_key: input.idempotencyKey,
        lease_epoch: input.leaseEpoch ?? goal.lease_epoch,
        created_at: nowIso(),
      };
      const [id] = await trx('goal_events').insert(record);
      return toEvent({ ...record, id: id as number } as GoalEventRecord);
    });
  }

  /** Read events after an exclusive sequence cursor, ascending. */
  async readEvents(
    goalId: string,
    options: { afterSequence?: number; limit?: number; kind?: string } = {}
  ): Promise<{ events: GoalEvent[]; nextCursor: number | null }> {
    if (options.afterSequence !== undefined && (!Number.isInteger(options.afterSequence) || options.afterSequence < 0)) {
      throw new GoalError(GOAL_ERROR_CODES.invalidCursor, 'Event cursor must be a non-negative integer', 400);
    }
    if (options.kind !== undefined && !GOAL_EVENT_KINDS.includes(options.kind as typeof GOAL_EVENT_KINDS[number])) {
      throw new GoalError(GOAL_ERROR_CODES.invalidEventKind, 'Event kind is not recognized', 400);
    }
    const limit = Math.min(
      Math.max(1, options.limit ?? DEFAULT_EVENT_READ_LIMIT),
      MAX_EVENT_READ_LIMIT
    );
    let builder = this.db<GoalEventRecord>('goal_events').where(
      'goal_id',
      goalId
    );
    if (options.afterSequence !== undefined) {
      builder = builder.andWhere('sequence', '>', options.afterSequence);
    }
    if (options.kind) builder = builder.andWhere('kind', options.kind);
    const rows = await builder.orderBy('sequence', 'asc').limit(limit + 1);
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor =
      hasMore && page.length > 0 ? page[page.length - 1].sequence : null;
    return { events: page.map(toEvent), nextCursor };
  }

  /** The highest event sequence allocated for a goal, or 0 when none exist. */
  async getLatestSequence(goalId: string): Promise<number> {
    const row = (await this.db('goal_events')
      .where('goal_id', goalId)
      .max('sequence as maxSeq')
      .first()) as { maxSeq: number | null } | undefined;
    return row?.maxSeq ?? 0;
  }

  // ---- Corrective messages ----------------------------------------------

  async enqueueMessage(
    goalId: string,
    input: EnqueueMessageInput
  ): Promise<GoalMessage> {
    return this.db.transaction(async (trx) => {
      const goal = await trx<GoalRecord>('goals')
        .where('goal_id', goalId)
        .first();
      if (!goal) {
        throw new GoalError(GOAL_ERROR_CODES.notFound, 'Goal not found', 404);
      }
      const request = { body: input.body, predefinedKind: input.predefinedKind ?? null };
      const replay = await this.readIdempotency<GoalMessage>({
        trx, ownerUserId: goal.owner_user_id, operation: `message:${goalId}`,
        key: input.idempotencyKey, request,
      });
      if (replay) return replay;
      const existing = await trx<GoalMessageRecord>('goal_messages')
        .where({ goal_id: goalId, idempotency_key: input.idempotencyKey })
        .first();
      if (existing) {
        if (existing.body !== input.body || existing.predefined_kind !== (input.predefinedKind ?? null)) {
          throw new GoalError(GOAL_ERROR_CODES.idempotencyConflict, 'Message idempotency key was reused with a different payload', 409);
        }
        return toMessage(existing);
      }

      const maxRow = (await trx('goal_messages')
        .where('goal_id', goalId)
        .max('sequence as maxSeq')
        .first()) as { maxSeq: number | null } | undefined;
      const sequence = (maxRow?.maxSeq ?? 0) + 1;

      const record: GoalMessageRecord = {
        message_id: input.messageId ?? crypto.randomUUID(),
        goal_id: goalId,
        sequence,
        body: input.body,
        predefined_kind: input.predefinedKind ?? null,
        state: 'queued',
        delivered_at: null,
        acknowledged_at: null,
        delivery_attempts: 0,
        last_error: null,
        idempotency_key: input.idempotencyKey,
        created_at: nowIso(),
      };
      await trx('goal_messages').insert(record);
      const message = toMessage(record);
      await this.writeIdempotency({
        trx, ownerUserId: goal.owner_user_id, operation: `message:${goalId}`,
        key: input.idempotencyKey, request, goalId, response: message,
      });
      return message;
    });
  }

  async getMessages(goalId: string): Promise<GoalMessage[]> {
    const rows = await this.db<GoalMessageRecord>('goal_messages')
      .where('goal_id', goalId)
      .orderBy('sequence', 'asc');
    return rows.map(toMessage);
  }

  async markMessageDelivered(
    goalId: string,
    messageId: string,
    fence: GoalLeaseFence
  ): Promise<void> {
    await this.db.transaction(async (trx) => {
      const goal = await this.requireGoalRecord(trx, goalId);
      this.assertLease(goal, fence.leaseOwner, fence.leaseEpoch);
      const message = await trx<GoalMessageRecord>('goal_messages').where({ goal_id: goalId, message_id: messageId }).first();
      if (!message) throw new GoalError(GOAL_ERROR_CODES.notFound, 'Goal message not found', 404);
      const earlierQueued = await trx<GoalMessageRecord>('goal_messages')
        .where({ goal_id: goalId, state: 'queued' })
        .andWhere('sequence', '<', message.sequence)
        .first();
      if (earlierQueued) throw new GoalError(GOAL_ERROR_CODES.messageOrderConflict, 'An earlier message must be delivered first', 409);
      await trx('goal_messages')
        .where({ goal_id: goalId, message_id: messageId, state: 'queued' })
        .update({ state: 'delivered', delivered_at: nowIso(), delivery_attempts: message.delivery_attempts + 1, last_error: null });
    });
  }

  async markMessageAcknowledged(
    goalId: string,
    messageId: string,
    fence: GoalLeaseFence
  ): Promise<void> {
    await this.db.transaction(async (trx) => {
      const goal = await this.requireGoalRecord(trx, goalId);
      this.assertLease(goal, fence.leaseOwner, fence.leaseEpoch);
      const message = await trx<GoalMessageRecord>('goal_messages').where({ goal_id: goalId, message_id: messageId }).first();
      if (!message) throw new GoalError(GOAL_ERROR_CODES.notFound, 'Goal message not found', 404);
      const earlierDelivered = await trx<GoalMessageRecord>('goal_messages')
        .where({ goal_id: goalId, state: 'delivered' })
        .andWhere('sequence', '<', message.sequence)
        .first();
      if (earlierDelivered) throw new GoalError(GOAL_ERROR_CODES.messageOrderConflict, 'An earlier message must be acknowledged first', 409);
      await trx('goal_messages')
        .where({ goal_id: goalId, message_id: messageId, state: 'delivered' })
        .update({ state: 'acknowledged', acknowledged_at: nowIso() });
    });
  }

  // ---- Fenced controller lease ------------------------------------------

  /**
   * Claim (or take over an expired) controller lease. Exactly one concurrent
   * claimant wins because the guarded UPDATE runs inside a transaction and the
   * epoch strictly increases on every successful claim.
   */
  async claimLease(
    goalId: string,
    owner: string,
    ttlMs: number
  ): Promise<{ epoch: number; expiresAt: string }> {
    if (!owner.trim() || !Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new GoalError(GOAL_ERROR_CODES.validation, 'Lease owner and positive TTL are required', 400);
    }
    return this.db.transaction(async (trx) => {
      const goal = await trx<GoalRecord>('goals')
        .where('goal_id', goalId)
        .first();
      if (!goal) {
        throw new GoalError(GOAL_ERROR_CODES.notFound, 'Goal not found', 404);
      }
      const now = nowIso();
      const available = goal.lease_owner === null || (
        goal.lease_expires_at !== null && goal.lease_expires_at <= now
      );
      if (!available) {
        throw new GoalError(
          GOAL_ERROR_CODES.leaseConflict,
          'Controller lease is held by another owner',
          409
        );
      }
      const epoch = goal.lease_epoch + 1;
      const expiresAt = new Date(Date.now() + ttlMs)
        .toISOString()
        .replace(/(\.\d{3})\d*Z$/, '$1Z');
      const updated = await trx('goals')
        .where({ goal_id: goalId, lease_epoch: goal.lease_epoch })
        .andWhere((builder) => {
          void builder.whereNull('lease_owner').orWhere('lease_expires_at', '<=', now);
        })
        .update({
          lease_owner: owner,
          lease_epoch: epoch,
          lease_expires_at: expiresAt,
          updated_at: now,
        });
      if (updated !== 1) {
        throw new GoalError(GOAL_ERROR_CODES.leaseConflict, 'Controller lease was claimed by another owner', 409);
      }
      return { epoch, expiresAt };
    });
  }

  async renewLease(
    goalId: string,
    owner: string,
    epoch: number,
    ttlMs: number
  ): Promise<{ expiresAt: string }> {
    return this.db.transaction(async (trx) => {
      const goal = await trx<GoalRecord>('goals')
        .where('goal_id', goalId)
        .first();
      if (!goal) {
        throw new GoalError(GOAL_ERROR_CODES.notFound, 'Goal not found', 404);
      }
      this.assertLease(goal, owner, epoch);
      const expiresAt = new Date(Date.now() + ttlMs)
        .toISOString()
        .replace(/(\.\d{3})\d*Z$/, '$1Z');
      const updated = await trx('goals')
        .where({ goal_id: goalId, lease_owner: owner, lease_epoch: epoch })
        .update({ lease_expires_at: expiresAt, updated_at: nowIso() });
      if (updated !== 1) throw new GoalError(GOAL_ERROR_CODES.staleLease, 'Controller lease changed while renewing', 409);
      return { expiresAt };
    });
  }

  async releaseLease(
    goalId: string,
    owner: string,
    epoch: number
  ): Promise<void> {
    await this.db.transaction(async (trx) => {
      const goal = await trx<GoalRecord>('goals')
        .where('goal_id', goalId)
        .first();
      if (!goal) return;
      this.assertLease(goal, owner, epoch);
      const updated = await trx('goals')
        .where({ goal_id: goalId, lease_owner: owner, lease_epoch: epoch })
        .update({
          lease_owner: null,
          lease_expires_at: null,
          updated_at: nowIso(),
        });
      if (updated !== 1) throw new GoalError(GOAL_ERROR_CODES.staleLease, 'Controller lease changed while releasing', 409);
    });
  }

  private assertLease(
    goal: GoalRecord,
    leaseOwner?: string,
    leaseEpoch?: number
  ): void {
    if (
      goal.lease_owner === null ||
      leaseOwner === undefined ||
      leaseEpoch === undefined ||
      goal.lease_owner !== leaseOwner ||
      goal.lease_epoch !== leaseEpoch
    ) {
      throw new GoalError(
        GOAL_ERROR_CODES.staleLease,
        'Controller write requires the current non-null owner and exact lease epoch',
        409
      );
    }
  }

  // ---- Lifecycle transitions --------------------------------------------

  async transition(goalId: string, input: TransitionInput): Promise<Goal> {
    return this.transitionInternal(goalId, input, true);
  }

  /** Explicit operator-intent path; it cannot be used for controller writes. */
  async transitionOperatorIntent(
    goalId: string,
    input: TransitionInput
  ): Promise<Goal> {
    if (input.leaseOwner !== undefined || input.leaseEpoch !== undefined) {
      throw new GoalError(GOAL_ERROR_CODES.validation, 'Operator intents must not include a lease fence', 400);
    }
    return this.transitionInternal(goalId, input, false);
  }

  private async transitionInternal(
    goalId: string,
    input: TransitionInput,
    controllerAuthoritative: boolean
  ): Promise<Goal> {
    return this.db.transaction(async (trx) => {
      const goal = await trx<GoalRecord>('goals')
        .where('goal_id', goalId)
        .first();
      if (!goal) {
        throw new GoalError(GOAL_ERROR_CODES.notFound, 'Goal not found', 404);
      }
      if (controllerAuthoritative) {
        this.assertLease(goal, input.leaseOwner, input.leaseEpoch);
      }
      const operation = input.idempotencyOperation ?? `transition:${input.toState}:${goalId}`;
      const request = {
        toState: input.toState,
        expectedVersion: input.expectedVersion ?? null,
        reason: input.reason ?? null,
        terminalReason: input.terminalReason ?? null,
      };
      const replay = await this.readIdempotency<Goal>({
        trx, ownerUserId: goal.owner_user_id, operation,
        key: input.idempotencyKey, request,
      });
      if (replay) return replay;

      if (
        input.expectedVersion !== undefined &&
        input.expectedVersion !== goal.version
      ) {
        throw new GoalError(
          GOAL_ERROR_CODES.versionConflict,
          `Goal version conflict: expected ${input.expectedVersion}, found ${goal.version}`,
          409
        );
      }

      if (!isValidGoalTransition(goal.state, input.toState)) {
        throw new GoalError(
          GOAL_ERROR_CODES.invalidTransition,
          `Invalid transition from ${goal.state} to ${input.toState}`,
          409
        );
      }

      const now = nowIso();
      if (isTerminalGoalState(input.toState) && input.terminalReason == null) {
        throw new GoalError(
          GOAL_ERROR_CODES.validation,
          `A terminal reason is required to enter ${input.toState}`,
          400
        );
      }

      await trx('goals')
        .where('goal_id', goalId)
        .update({
          state: input.toState,
          version: goal.version + 1,
          terminal_reason: isTerminalGoalState(input.toState)
            ? input.terminalReason ?? null
            : goal.terminal_reason,
          updated_at: now,
        });

      await trx('goal_state_transitions').insert({
        goal_id: goalId,
        from_state: goal.state,
        to_state: input.toState,
        reason: input.reason ?? null,
        lease_epoch: input.leaseEpoch ?? goal.lease_epoch,
        created_at: now,
      });

      // Pause-interval accounting: open an interval when entering `paused`,
      // close the open one on any transition out of `paused`.
      if (input.toState === 'paused') {
        // The state machine forbids paused -> paused, and the partial unique
        // index guarantees at most one open interval, so a plain insert is safe.
        await trx('goal_pause_intervals').insert({
          goal_id: goalId,
          paused_at: now,
          reason: input.reason ?? null,
        });
      } else if (goal.state === 'paused') {
        await trx('goal_pause_intervals')
          .where({ goal_id: goalId })
          .whereNull('resumed_at')
          .update({ resumed_at: now });
      }

      const updated = await trx<GoalRecord>('goals')
        .where('goal_id', goalId)
        .first();
      const result = toGoal(updated!);
      await this.writeIdempotency({
        trx, ownerUserId: goal.owner_user_id, operation,
        key: input.idempotencyKey, request, goalId, response: result,
      });
      return result;
    });
  }

  // ---- Model changes -----------------------------------------------------

  /**
   * Record a requested model change. The requested model is stored separately
   * and the effective model is left untouched until a runtime acknowledges the
   * change at a safe boundary via {@link applyModelChange}.
   */
  async requestModelChange(
    goalId: string,
    requestedModel: string,
    options: {
      expectedVersion?: number;
      reason?: string;
      idempotencyKey?: string;
    } = {}
  ): Promise<Goal> {
    return this.db.transaction(async (trx) => {
      const goal = await trx<GoalRecord>('goals')
        .where('goal_id', goalId)
        .first();
      if (!goal) {
        throw new GoalError(GOAL_ERROR_CODES.notFound, 'Goal not found', 404);
      }
      const operation = `model-change:${goalId}`;
      const request = {
        requestedModel,
        expectedVersion: options.expectedVersion ?? null,
        reason: options.reason ?? null,
      };
      const replay = await this.readIdempotency<Goal>({
        trx, ownerUserId: goal.owner_user_id, operation,
        key: options.idempotencyKey, request,
      });
      if (replay) return replay;
      if (isTerminalGoalState(goal.state)) {
        throw new GoalError(
          GOAL_ERROR_CODES.terminalState,
          'Requested model cannot change after the goal is terminal',
          409
        );
      }
      if (
        options.expectedVersion !== undefined &&
        options.expectedVersion !== goal.version
      ) {
        throw new GoalError(
          GOAL_ERROR_CODES.versionConflict,
          `Goal version conflict: expected ${options.expectedVersion}, found ${goal.version}`,
          409
        );
      }
      const now = nowIso();
      await trx('goals').where('goal_id', goalId).update({
        requested_model: requestedModel,
        version: goal.version + 1,
        updated_at: now,
      });
      await trx('goal_model_transitions').insert({
        goal_id: goalId,
        previous_model: goal.effective_model,
        requested_model: requestedModel,
        effective_model: goal.effective_model,
        applied: 0,
        reason: options.reason ?? null,
        created_at: now,
        applied_at: null,
      });
      const updated = await trx<GoalRecord>('goals')
        .where('goal_id', goalId)
        .first();
      const result = toGoal(updated!);
      await this.writeIdempotency({
        trx, ownerUserId: goal.owner_user_id, operation,
        key: options.idempotencyKey, request, goalId, response: result,
      });
      return result;
    });
  }

  /** Advance the effective model to the requested model at a safe boundary. */
  async applyModelChange(
    goalId: string,
    options: GoalLeaseFence
  ): Promise<Goal> {
    return this.db.transaction(async (trx) => {
      const goal = await trx<GoalRecord>('goals')
        .where('goal_id', goalId)
        .first();
      if (!goal) {
        throw new GoalError(GOAL_ERROR_CODES.notFound, 'Goal not found', 404);
      }
      this.assertLease(goal, options.leaseOwner, options.leaseEpoch);
      if (goal.requested_model === goal.effective_model) return toGoal(goal);
      const now = nowIso();
      await trx('goals').where('goal_id', goalId).update({
        effective_model: goal.requested_model,
        version: goal.version + 1,
        updated_at: now,
      });
      await trx('goal_model_transitions')
        .where({ goal_id: goalId, applied: 0 })
        .update({
          effective_model: goal.requested_model,
          applied: 1,
          applied_at: now,
        });
      const updated = await trx<GoalRecord>('goals')
        .where('goal_id', goalId)
        .first();
      return toGoal(updated!);
    });
  }

  private async requireGoalRecord(
    trx: Knex.Transaction,
    goalId: string
  ): Promise<GoalRecord> {
    const goal = await trx<GoalRecord>('goals').where('goal_id', goalId).first();
    if (!goal) throw new GoalError(GOAL_ERROR_CODES.notFound, 'Goal not found', 404);
    return goal;
  }

  private async readIdempotency<T>(context: IdempotencyContext): Promise<T | null> {
    const { trx, ownerUserId, operation, key, request } = context;
    if (!key) return null;
    const row = await trx<GoalIdempotencyRecord>('goal_idempotency_keys')
      .where({ owner_user_id: ownerUserId, operation, idempotency_key: key })
      .first();
    if (!row) return null;
    if (row.request_hash !== hashRequest(request)) {
      throw new GoalError(
        GOAL_ERROR_CODES.idempotencyConflict,
        'Idempotency key was reused with a different payload',
        409
      );
    }
    return JSON.parse(row.response_json) as T;
  }

  private async writeIdempotency(context: IdempotencyContext & {
    goalId: string;
    response: unknown;
  }): Promise<void> {
    const { trx, ownerUserId, operation, key, request, goalId, response } = context;
    if (!key) return;
    await trx('goal_idempotency_keys').insert({
      owner_user_id: ownerUserId,
      operation,
      idempotency_key: key,
      request_hash: hashRequest(request),
      goal_id: goalId,
      response_json: JSON.stringify(response),
      created_at: nowIso(),
    });
  }

  // ---- Derived time accounting ------------------------------------------

  async getActiveTimeStats(goalId: string): Promise<GoalActiveTimeStats> {
    const goal = await this.requireGoal(goalId);
    const intervals = await this.db('goal_pause_intervals')
      .where('goal_id', goalId)
      .select('paused_at', 'resumed_at');
    const now = Date.now();
    const start = Date.parse(goal.createdAt);
    const end = isTerminalGoalState(goal.state)
      ? Date.parse(goal.updatedAt)
      : now;
    const elapsedMs = Math.max(0, end - start);
    let pausedMs = 0;
    let currentlyPaused = false;
    for (const interval of intervals) {
      const pausedAt = Date.parse(interval.paused_at);
      const resumedAt = interval.resumed_at
        ? Date.parse(interval.resumed_at)
        : end;
      if (!interval.resumed_at) currentlyPaused = true;
      pausedMs += Math.max(0, resumedAt - pausedAt);
    }
    return {
      elapsedMs,
      pausedMs,
      activeMs: Math.max(0, elapsedMs - pausedMs),
      currentlyPaused,
    };
  }
}

function hashRequest(value: unknown): string {
  return crypto.createHash('sha256').update(stableJson(value)).digest('hex');
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function validateRecoveryMetadata(value: ProviderSessionUpdate['recoveryMetadata']): string | null {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new GoalError(GOAL_ERROR_CODES.recoveryMetadataInvalid, 'Recovery metadata must be an object', 400);
  }
  const metadata = value as unknown as Record<string, unknown>;
  const allowed = new Set(['schemaVersion', 'reason', 'attempt', 'lastEventSequence', 'providerState']);
  if (Object.keys(metadata).some(key => !allowed.has(key)) || metadata.schemaVersion !== 1) {
    throw new GoalError(GOAL_ERROR_CODES.recoveryMetadataInvalid, 'Recovery metadata schema is invalid', 400);
  }
  if (metadata.reason !== undefined && (typeof metadata.reason !== 'string' || metadata.reason.length > 256)) {
    throw new GoalError(GOAL_ERROR_CODES.recoveryMetadataInvalid, 'Recovery reason is invalid', 400);
  }
  for (const field of ['attempt', 'lastEventSequence'] as const) {
    const candidate = metadata[field];
    if (candidate !== undefined && (!Number.isSafeInteger(candidate) || (candidate as number) < 0)) {
      throw new GoalError(GOAL_ERROR_CODES.recoveryMetadataInvalid, `${field} must be a non-negative safe integer`, 400);
    }
  }
  const states = ['starting', 'active', 'interrupted', 'recoverable'];
  if (metadata.providerState !== undefined && !states.includes(metadata.providerState as string)) {
    throw new GoalError(GOAL_ERROR_CODES.recoveryMetadataInvalid, 'Provider recovery state is invalid', 400);
  }
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json, 'utf8') > MAX_RECOVERY_METADATA_BYTES) {
    throw new GoalError(GOAL_ERROR_CODES.recoveryMetadataInvalid, 'Recovery metadata exceeds 4096 bytes', 400);
  }
  return json;
}

interface Cursor {
  createdAt: string;
  goalId: string;
}

function encodeCursor(createdAt: string, goalId: string): string {
  return Buffer.from(JSON.stringify({ c: createdAt, g: goalId })).toString(
    'base64url'
  );
}

function decodeCursor(cursor: string | null | undefined): Cursor | null {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (
      parsed &&
      typeof parsed.c === 'string' &&
      typeof parsed.g === 'string'
    ) {
      return { createdAt: parsed.c, goalId: parsed.g };
    }
  } catch {
    // Fall through to null on malformed cursors.
  }
  return null;
}
