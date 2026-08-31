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
  CreateGoalInput,
  CreateNodeInput,
  AppendEventInput,
  EnqueueMessageInput,
  TransitionInput,
  ListGoalsQuery,
  ListGoalsResult,
  GoalActiveTimeStats,
} from './goalTypes.js';

const MAX_LIST_LIMIT = 100;
const DEFAULT_LIST_LIMIT = 25;
const MAX_EVENT_READ_LIMIT = 500;
const DEFAULT_EVENT_READ_LIMIT = 100;

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
    idempotencyKey: row.idempotency_key,
    createdAt: row.created_at,
  };
}

export class GoalRepository {
  constructor(private readonly db: Knex) {}

  async createGoal(input: CreateGoalInput): Promise<Goal> {
    const maxActiveTasks = input.maxActiveTasks ?? GOAL_DEFAULT_MAX_ACTIVE_TASKS;
    // The idempotency key is the deterministic goal id: a retried create with
    // the same key resolves to the already-committed row instead of a new goal.
    const goalId = input.goalId ?? input.idempotencyKey ?? crypto.randomUUID();

    return this.db.transaction(async (trx) => {
      const existing = await trx<GoalRecord>('goals')
        .where('goal_id', goalId)
        .first();
      if (existing) {
        if (
          existing.owner_user_id !== input.ownerUserId ||
          existing.repository !== input.repository ||
          existing.objective !== input.objective
        ) {
          throw new GoalError(
            GOAL_ERROR_CODES.idempotencyConflict,
            'Idempotency key was reused with different goal parameters',
            409
          );
        }
        return toGoal(existing);
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
      return toGoal(record);
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
      const existing = await trx<GoalNodeRecord>('goal_nodes')
        .where({ goal_id: goalId, idempotency_key: input.idempotencyKey })
        .first();
      if (existing) return toNode(existing);

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
    dependsOnNodeId: string
  ): Promise<void> {
    await this.db('goal_node_dependencies')
      .insert({
        goal_id: goalId,
        node_id: nodeId,
        depends_on_node_id: dependsOnNodeId,
        created_at: nowIso(),
      })
      .onConflict(['node_id', 'depends_on_node_id'])
      .ignore();
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
    fields: Partial<
      Pick<
        GoalProviderSessionRecord,
        | 'provider_thread_id'
        | 'runtime_id'
        | 'worktree_id'
        | 'last_checkpoint'
        | 'effective_model'
        | 'lease_generation'
      >
    > & { effectiveModel?: string; recoveryMetadata?: unknown }
  ): Promise<void> {
    const now = nowIso();
    const effectiveModel =
      fields.effectiveModel ?? fields.effective_model ?? '';
    await this.db.transaction(async (trx) => {
      const existing = await trx<GoalProviderSessionRecord>(
        'goal_provider_sessions'
      )
        .where({ goal_id: goalId, agent })
        .first();
      const recoveryJson =
        fields.recoveryMetadata === undefined
          ? existing?.recovery_metadata_json ?? null
          : JSON.stringify(fields.recoveryMetadata);
      if (existing) {
        await trx('goal_provider_sessions')
          .where({ session_id: existing.session_id })
          .update({
            provider_thread_id:
              fields.provider_thread_id ?? existing.provider_thread_id,
            runtime_id: fields.runtime_id ?? existing.runtime_id,
            worktree_id: fields.worktree_id ?? existing.worktree_id,
            last_checkpoint:
              fields.last_checkpoint ?? existing.last_checkpoint,
            effective_model: effectiveModel || existing.effective_model,
            recovery_metadata_json: recoveryJson,
            lease_generation:
              fields.lease_generation ?? existing.lease_generation,
            updated_at: now,
          });
        return;
      }
      await trx('goal_provider_sessions').insert({
        session_id: crypto.randomUUID(),
        goal_id: goalId,
        agent,
        provider_thread_id: fields.provider_thread_id ?? null,
        runtime_id: fields.runtime_id ?? null,
        worktree_id: fields.worktree_id ?? null,
        last_checkpoint: fields.last_checkpoint ?? null,
        effective_model: effectiveModel,
        recovery_metadata_json: recoveryJson,
        lease_generation: fields.lease_generation ?? 0,
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

      const existing = await trx<GoalEventRecord>('goal_events')
        .where({ goal_id: goalId, idempotency_key: input.idempotencyKey })
        .first();
      if (existing) return toEvent(existing);

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
      const existing = await trx<GoalMessageRecord>('goal_messages')
        .where({ goal_id: goalId, idempotency_key: input.idempotencyKey })
        .first();
      if (existing) return toMessage(existing);

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
        idempotency_key: input.idempotencyKey,
        created_at: nowIso(),
      };
      await trx('goal_messages').insert(record);
      return toMessage(record);
    });
  }

  async getMessages(goalId: string): Promise<GoalMessage[]> {
    const rows = await this.db<GoalMessageRecord>('goal_messages')
      .where('goal_id', goalId)
      .orderBy('sequence', 'asc');
    return rows.map(toMessage);
  }

  async markMessageDelivered(messageId: string): Promise<void> {
    await this.db('goal_messages')
      .where({ message_id: messageId, state: 'queued' })
      .update({ state: 'delivered', delivered_at: nowIso() });
  }

  async markMessageAcknowledged(messageId: string): Promise<void> {
    await this.db('goal_messages')
      .where({ message_id: messageId, state: 'delivered' })
      .update({ state: 'acknowledged', acknowledged_at: nowIso() });
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
    return this.db.transaction(async (trx) => {
      const goal = await trx<GoalRecord>('goals')
        .where('goal_id', goalId)
        .first();
      if (!goal) {
        throw new GoalError(GOAL_ERROR_CODES.notFound, 'Goal not found', 404);
      }
      const now = nowIso();
      const heldByOther =
        goal.lease_owner !== null &&
        goal.lease_owner !== owner &&
        goal.lease_expires_at !== null &&
        goal.lease_expires_at > now;
      if (heldByOther) {
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
      await trx('goals')
        .where('goal_id', goalId)
        .update({
          lease_owner: owner,
          lease_epoch: epoch,
          lease_expires_at: expiresAt,
          updated_at: now,
        });
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
      if (goal.lease_owner !== owner || goal.lease_epoch !== epoch) {
        throw new GoalError(
          GOAL_ERROR_CODES.staleLease,
          'Controller lease epoch is stale',
          409
        );
      }
      const expiresAt = new Date(Date.now() + ttlMs)
        .toISOString()
        .replace(/(\.\d{3})\d*Z$/, '$1Z');
      await trx('goals')
        .where('goal_id', goalId)
        .update({ lease_expires_at: expiresAt, updated_at: nowIso() });
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
      if (goal.lease_owner !== owner || goal.lease_epoch !== epoch) {
        throw new GoalError(
          GOAL_ERROR_CODES.staleLease,
          'Controller lease epoch is stale',
          409
        );
      }
      await trx('goals')
        .where('goal_id', goalId)
        .update({
          lease_owner: null,
          lease_expires_at: null,
          updated_at: nowIso(),
        });
    });
  }

  private assertLease(
    goal: GoalRecord,
    leaseOwner?: string,
    leaseEpoch?: number
  ): void {
    if (leaseEpoch === undefined && leaseOwner === undefined) return;
    // A stale epoch (lower than the goal's current epoch) has been fenced by a
    // takeover and must not append authoritative state.
    if (leaseEpoch !== undefined && leaseEpoch < goal.lease_epoch) {
      throw new GoalError(
        GOAL_ERROR_CODES.staleLease,
        'Controller lease epoch is stale; a takeover has occurred',
        409
      );
    }
    if (
      leaseOwner !== undefined &&
      goal.lease_owner !== null &&
      goal.lease_owner !== leaseOwner
    ) {
      throw new GoalError(
        GOAL_ERROR_CODES.staleLease,
        'Controller lease is owned by another controller',
        409
      );
    }
  }

  // ---- Lifecycle transitions --------------------------------------------

  async transition(goalId: string, input: TransitionInput): Promise<Goal> {
    return this.db.transaction(async (trx) => {
      const goal = await trx<GoalRecord>('goals')
        .where('goal_id', goalId)
        .first();
      if (!goal) {
        throw new GoalError(GOAL_ERROR_CODES.notFound, 'Goal not found', 404);
      }
      this.assertLease(goal, input.leaseOwner, input.leaseEpoch);

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
      return toGoal(updated!);
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
    options: { expectedVersion?: number; reason?: string } = {}
  ): Promise<Goal> {
    return this.db.transaction(async (trx) => {
      const goal = await trx<GoalRecord>('goals')
        .where('goal_id', goalId)
        .first();
      if (!goal) {
        throw new GoalError(GOAL_ERROR_CODES.notFound, 'Goal not found', 404);
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
      return toGoal(updated!);
    });
  }

  /** Advance the effective model to the requested model at a safe boundary. */
  async applyModelChange(
    goalId: string,
    options: { leaseOwner?: string; leaseEpoch?: number } = {}
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
