import crypto from 'crypto';
import type { Knex } from 'knex';
import {
  GOAL_CANNED_ACTION_TEXT, GOAL_ERROR_CODES, GOAL_MESSAGE_DEFAULT_LIMIT,
  GOAL_MESSAGE_MAX_LIMIT, isTerminalGoalState,
} from '@propr/shared';
import type {
  ClaimMessageInput, EnqueueMessageInput, GoalLeaseFence, GoalMessage,
  GoalMessagePageResult, GoalMessageRecord, MessageDeliveryFence,
} from './goalTypes.js';
import {
  GoalError, boundedText, guardLease, goalTransaction, nowIso, requireGoalRecord, runIdempotent, toMessage,
} from './goalRepositorySupport.js';
import { decodeGoalPageCursor, encodeGoalPageCursor } from './goalPageCursor.js';
import { validateLimit } from './goalEventIngestion.js';
import {
  appendAudit, assertDeliveryFence, assertDeliveryIdentity, assertFifoHead,
  claimMessage, clearDeliveryColumns, compareMessage,
  guardDeliveryAttempt, latestSequence, messageConflict, nextMessageOrdinal,
  normalizeDeliveryIdentity, normalizeMessage, requireEnhanced, requireMessage,
  sanitizeError, storedEvidence, takeoverMessage,
} from './goalMessageSupport.js';

export class GoalMessageRepository {
  constructor(private readonly db: Knex) {}

  async enqueue(goalId: string, input: EnqueueMessageInput): Promise<GoalMessage> {
    const enhanced = await this.hasEnhancedSchema();
    const goal = await requireGoalRecord(this.db, goalId);
    const normalized = normalizeMessage(input, goal.owner_user_id);
    if (!enhanced) return this.enqueueFoundation(goalId, goal.owner_user_id, normalized);
    const request = {
      messageId: normalized.messageId, body: normalized.body,
      cannedAction: normalized.cannedAction, authorUserId: normalized.authorUserId,
    };
    return runIdempotent({
      db: this.db, ownerUserId: goal.owner_user_id, operation: `message:${goalId}`,
      key: normalized.idempotencyKey, request, goalId,
      effect: async trx => {
        const currentGoal = await requireGoalRecord(trx, goalId);
        if (isTerminalGoalState(currentGoal.state)) {
          throw new GoalError(GOAL_ERROR_CODES.terminalState, 'Terminal goals cannot accept new messages', 409);
        }
        const existing = await trx<GoalMessageRecord>('goal_messages').where({
          goal_id: goalId, idempotency_key: normalized.idempotencyKey,
        }).first();
        if (existing) return compareMessage(existing, normalized);
        const messageId = normalized.messageId ?? crypto.randomUUID();
        if (normalized.messageId && await trx('goal_messages').where('message_id', messageId).first()) {
          throw new GoalError(GOAL_ERROR_CODES.idempotencyConflict, 'Requested message identifier already exists', 409);
        }
        const queueOrdinal = await nextMessageOrdinal(trx, goalId);
        const createdAt = nowIso();
        const body = normalized.cannedAction
          ? GOAL_CANNED_ACTION_TEXT[normalized.cannedAction]
          : normalized.body;
        const enqueueSequence = await appendAudit(trx, currentGoal, {
          type: 'message.enqueued',
          payload: { messageId, queueOrdinal, authorUserId: normalized.authorUserId },
          idempotencyKey: `message:${messageId}:enqueued`, createdAt,
        });
        const record: GoalMessageRecord = {
          message_id: messageId, goal_id: goalId, sequence: queueOrdinal, queue_ordinal: queueOrdinal,
          body, predefined_kind: normalized.cannedAction, canned_action: normalized.cannedAction,
          author_user_id: normalized.authorUserId, state: 'queued', delivered_at: null,
          acknowledged_at: null, delivery_attempts: 0, last_error: null,
          idempotency_key: normalized.idempotencyKey, created_at: createdAt,
          cancelled_at: null, failed_at: null, retry_count: 0,
          enqueue_event_sequence: enqueueSequence, state_event_sequence: enqueueSequence,
        };
        await trx('goal_messages').insert(record);
        return toMessage(record);
      },
    });
  }

  async getAll(goalId: string): Promise<GoalMessage[]> {
    const rows = await this.db<GoalMessageRecord>('goal_messages').where('goal_id', goalId)
      .orderBy('sequence', 'asc');
    return rows.map(toMessage);
  }

  async readPage(
    goalId: string,
    options: { cursor?: string | null; limit?: number; state?: string } = {}
  ): Promise<GoalMessagePageResult> {
    const limit = validateLimit(options.limit, GOAL_MESSAGE_DEFAULT_LIMIT, GOAL_MESSAGE_MAX_LIMIT);
    const goal = await requireGoalRecord(this.db, goalId);
    const binding = {
      type: 'goal-messages' as const, goalId, ownerUserId: goal.owner_user_id,
      repository: goal.repository, filter: options.state ?? null,
    };
    const cursor = decodeGoalPageCursor(options.cursor, binding);
    let query = this.db<GoalMessageRecord>('goal_messages').where('goal_id', goalId)
      .andWhere('sequence', '>', cursor?.sequence ?? 0);
    if (options.state) query = query.andWhere('state', options.state);
    const rows = await query.orderBy('sequence', 'asc').limit(limit + 1);
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      messages: page.map(toMessage),
      nextCursor: rows.length > limit && last
        ? encodeGoalPageCursor(binding, { sequence: last.sequence, createdAt: last.created_at })
        : null,
      asOfSequence: await latestSequence(this.db, goalId),
    };
  }

  async claim(goalId: string, input: ClaimMessageInput): Promise<GoalMessage | null> {
    requireEnhanced(await this.hasEnhancedSchema());
    const identity = normalizeDeliveryIdentity(input);
    if (identity.controllerId !== input.leaseOwner) {
      throw messageConflict('Controller identity must match the active lease owner');
    }
    return goalTransaction(this.db, async trx => {
      const goal = await guardLease(trx, goalId, input);
      await guardDeliveryAttempt(trx, goalId, identity, input.leaseEpoch);
      const accepted = await trx<GoalMessageRecord>('goal_messages').where({
        goal_id: goalId, delivery_key: identity.deliveryKey,
      }).first();
      if (accepted) {
        assertDeliveryIdentity(accepted, identity, input.leaseEpoch);
        return toMessage(accepted);
      }
      const providerReuse = await trx<GoalMessageRecord>('goal_messages').where({
        goal_id: goalId, provider_idempotency_key: identity.providerIdempotencyKey,
      }).first();
      if (providerReuse && providerReuse.message_id !== identity.messageId) {
        throw messageConflict('Provider idempotency identity is already bound to another message');
      }
      const blocking = await trx<GoalMessageRecord>('goal_messages').where('goal_id', goalId)
        .whereIn('state', ['delivering', 'delivered']).orderBy('queue_ordinal', 'asc').first();
      if (blocking) {
        if (blocking.message_id !== identity.messageId) {
          throw messageConflict('Delivery identity does not name the durable FIFO head');
        }
        if (blocking.provider_idempotency_key !== identity.providerIdempotencyKey) {
          throw messageConflict('FIFO head requires its original stable provider idempotency identity');
        }
        if ((blocking.claimed_lease_generation ?? 0) >= input.leaseEpoch) return null;
        return takeoverMessage(trx, goal, blocking, { identity, leaseEpoch: input.leaseEpoch });
      }
      const message = await trx<GoalMessageRecord>('goal_messages').where({ goal_id: goalId, state: 'queued' })
        .orderBy('queue_ordinal', 'asc').first();
      if (!message) return null;
      if (message.message_id !== identity.messageId) {
        throw messageConflict('Delivery identity does not name the durable FIFO head');
      }
      return claimMessage(trx, goal, message, { identity, leaseEpoch: input.leaseEpoch });
    });
  }

  async delivered(goalId: string, messageId: string, fence: MessageDeliveryFence | GoalLeaseFence): Promise<void> {
    if (!await this.hasEnhancedSchema()) return this.transitionFoundation(goalId, messageId, fence, 'delivered');
    await this.transitionDelivery(goalId, messageId, fence, { from: 'delivering', to: 'delivered' });
  }

  async acknowledged(goalId: string, messageId: string, fence: MessageDeliveryFence | GoalLeaseFence): Promise<void> {
    if (!await this.hasEnhancedSchema()) return this.transitionFoundation(goalId, messageId, fence, 'acknowledged');
    await this.transitionDelivery(goalId, messageId, fence, { from: 'delivered', to: 'acknowledged' });
  }

  async fail(
    goalId: string,
    messageId: string,
    fence: MessageDeliveryFence,
    options: { error: string; retryable?: boolean }
  ): Promise<void> {
    const sanitized = sanitizeError(options.error);
    const retryable = options.retryable ?? false;
    await goalTransaction(this.db, async trx => {
      const goal = await guardLease(trx, goalId, fence);
      const message = await requireMessage(trx, goalId, messageId);
      assertDeliveryFence(message, messageId, fence);
      if (message.state === 'failed') return;
      if (message.state !== 'delivering') throw messageConflict('Only a delivering message can fail');
      const failedAt = nowIso();
      const sequence = await appendAudit(trx, goal, {
        type: 'message.failed', payload: { ...storedEvidence(message), retryable, error: sanitized },
        idempotencyKey: `message:${messageId}:failed:${message.delivery_key}`, createdAt: failedAt,
      });
      await trx('goal_messages').where({ message_id: messageId, state: 'delivering' }).update({
        state: retryable ? 'queued' : 'failed', failed_at: failedAt,
        retry_count: (message.retry_count ?? 0) + 1, last_error: sanitized,
        ...(retryable ? clearDeliveryColumns() : {}), state_event_sequence: sequence,
      });
    });
  }

  async cancel(goalId: string, messageId: string, authorUserId: string): Promise<GoalMessage> {
    const id = boundedText(messageId, 'messageId', 128) as string;
    const author = boundedText(authorUserId, 'authorUserId', 128) as string;
    return goalTransaction(this.db, async trx => {
      const goal = await requireGoalRecord(trx, goalId);
      const message = await requireMessage(trx, goalId, id);
      if (message.state === 'cancelled') return toMessage(message);
      if (message.state !== 'queued') throw messageConflict('Only a queued message can be cancelled safely');
      const cancelledAt = nowIso();
      const sequence = await appendAudit(trx, goal, {
        type: 'message.cancelled',
        payload: { messageId: id, queueOrdinal: message.queue_ordinal ?? message.sequence, authorUserId: author },
        idempotencyKey: `message:${id}:cancelled`, createdAt: cancelledAt,
      });
      await trx('goal_messages').where({ message_id: id, state: 'queued' }).update({
        state: 'cancelled', cancelled_at: cancelledAt, state_event_sequence: sequence,
      });
      return toMessage({ ...message, state: 'cancelled', cancelled_at: cancelledAt, state_event_sequence: sequence });
    });
  }

  private hasEnhancedSchema(): Promise<boolean> {
    return this.db.schema.hasTable('goal_event_state');
  }

  private async enqueueFoundation(
    goalId: string,
    ownerUserId: string,
    input: ReturnType<typeof normalizeMessage>
  ): Promise<GoalMessage> {
    return runIdempotent({
      db: this.db, ownerUserId, operation: `message:${goalId}`, key: input.idempotencyKey,
      request: input, goalId,
      effect: async trx => {
        const goal = await requireGoalRecord(trx, goalId);
        if (isTerminalGoalState(goal.state)) {
          throw new GoalError(GOAL_ERROR_CODES.terminalState, 'Terminal goals cannot accept new messages', 409);
        }
        const existing = await trx<GoalMessageRecord>('goal_messages').where({
          goal_id: goalId, idempotency_key: input.idempotencyKey,
        }).first();
        if (existing) return compareMessage(existing, input);
        const sequence = await nextMessageOrdinal(trx, goalId);
        const record: GoalMessageRecord = {
          message_id: input.messageId ?? crypto.randomUUID(), goal_id: goalId, sequence,
          body: input.cannedAction ? GOAL_CANNED_ACTION_TEXT[input.cannedAction] : input.body,
          predefined_kind: input.cannedAction, state: 'queued', delivered_at: null,
          acknowledged_at: null, delivery_attempts: 0, last_error: null,
          idempotency_key: input.idempotencyKey, created_at: nowIso(),
        };
        await trx('goal_messages').insert(record);
        return toMessage(record);
      },
    });
  }

  private async transitionFoundation(
    goalId: string,
    messageId: string,
    fence: GoalLeaseFence,
    to: 'delivered' | 'acknowledged'
  ): Promise<void> {
    await goalTransaction(this.db, async trx => {
      await guardLease(trx, goalId, fence);
      const message = await requireMessage(trx, goalId, messageId);
      if (message.state === to) return;
      const from = to === 'delivered' ? 'queued' : 'delivered';
      if (message.state !== from) throw messageConflict(`Only a ${from} message can be ${to}`);
      if (to === 'delivered') {
        const earlier = await trx('goal_messages').where({ goal_id: goalId, state: 'queued' })
          .andWhere('sequence', '<', message.sequence).first('message_id');
        if (earlier) throw messageConflict('An earlier message must be delivered first');
      }
      if (to === 'acknowledged') await assertFifoHead(trx, goalId, message);
      const at = nowIso();
      await trx('goal_messages').where({ message_id: messageId, state: from }).update(to === 'delivered'
        ? { state: to, delivered_at: at, delivery_attempts: message.delivery_attempts + 1 }
        : { state: to, acknowledged_at: at });
    });
  }

  private async transitionDelivery(
    goalId: string,
    messageId: string,
    fence: MessageDeliveryFence | GoalLeaseFence,
    states: { from: 'delivering' | 'delivered'; to: 'delivered' | 'acknowledged' }
  ): Promise<void> {
    const { from, to } = states;
    requireEnhanced(await this.hasEnhancedSchema());
    await goalTransaction(this.db, async trx => {
      const goal = await guardLease(trx, goalId, fence);
      const message = await requireMessage(trx, goalId, messageId);
      assertDeliveryFence(message, messageId, fence);
      if (message.state === to) return;
      if (message.state !== from) throw messageConflict(`Only a ${from} message can be ${to}`);
      if (to === 'acknowledged') await assertFifoHead(trx, goalId, message);
      const at = nowIso();
      const type = `message.${to}` as 'message.delivered' | 'message.acknowledged';
      const sequence = await appendAudit(trx, goal, {
        type, payload: storedEvidence(message),
        idempotencyKey: `message:${messageId}:${to}:${message.delivery_key}`, createdAt: at,
      });
      const update = to === 'delivered'
        ? { state: to, delivered_at: at, last_error: null, state_event_sequence: sequence }
        : { state: to, acknowledged_at: at, state_event_sequence: sequence };
      const affected = await trx('goal_messages').where({ goal_id: goalId, message_id: messageId, state: from })
        .update(update);
      if (affected !== 1) throw messageConflict(`Message ${to} state changed concurrently`);
    });
  }
}
