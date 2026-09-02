import crypto from 'crypto';
import {
  DURABLE_GOAL_EVENT_SCHEMA_VERSION,
  type DurableGoalEventPayloadMap,
  type ProviderGoalEventType,
} from '@propr/shared';
import { GoalRepository } from './goalRepository.js';
import type {
  GoalEvent,
  GoalEventPageResult,
  GoalMessage,
  GoalProviderSessionRecord,
  MessageDeliveryFence,
} from './goalTypes.js';

/** Exact selected-agent attempt currently supervised for a native `/goal` session. */
export interface NativeGoalAttempt {
  goalId: string;
  agent: string;
  providerThreadId: string;
  runtimeId: string;
  worktreeId: string;
  effectiveModel: string;
  controllerId: string;
  leaseEpoch: number;
  turnId: string;
  executionId: string;
  attemptId: string;
}

export type NativeGoalIngressEvent = {
  [K in ProviderGoalEventType]: {
    type: K;
    payload: DurableGoalEventPayloadMap[K];
    providerSequence: number;
    chunkIndex: number;
    idempotencyKey: string;
  }
}[ProviderGoalEventType];

export interface NativeGoalMessageSender {
  /** Resolves only once the same native provider session has accepted the input. */
  send(input: {
    messageId: string;
    body: string;
    providerIdempotencyKey: string;
  }): Promise<void>;
}

/** Structural subset implemented by the production NativeGoalSessionSupervisor. */
export interface NativeGoalSupervisor {
  get(goalId: string): Promise<{ lastInputSequence: number } | null>;
  steer(goalId: string, input: { sequence: number; text: string }): Promise<unknown>;
}

export interface NativeGoalClaim {
  message: GoalMessage;
  fence: MessageDeliveryFence;
}

/**
 * Production bridge between the selected-agent native-goal supervisor and the
 * SQL durability layer. The provider session remains the planning/execution
 * authority; this class only persists its stream and transports FIFO input.
 */
export class GoalNativeSessionTransport {
  constructor(private readonly repository: GoalRepository) {}

  async attach(attempt: NativeGoalAttempt): Promise<GoalProviderSessionRecord> {
    const fence = { leaseOwner: attempt.controllerId, leaseEpoch: attempt.leaseEpoch };
    await this.repository.upsertProviderSession(attempt.goalId, attempt.agent, {
      ...fence,
      providerThreadId: attempt.providerThreadId,
      runtimeId: attempt.runtimeId,
      worktreeId: attempt.worktreeId,
      effectiveModel: attempt.effectiveModel,
      turnId: attempt.turnId,
      executionId: attempt.executionId,
      attemptId: attempt.attemptId,
    });
    const session = await this.repository.getProviderSession(attempt.goalId, attempt.agent);
    if (!session) throw new Error(`Native goal session was not persisted for ${attempt.goalId}`);
    return session;
  }

  async ingest(attempt: NativeGoalAttempt, event: NativeGoalIngressEvent): Promise<GoalEvent> {
    const session = await this.attach(attempt);
    return this.repository.appendProviderEvent(attempt.goalId, {
      schemaVersion: DURABLE_GOAL_EVENT_SCHEMA_VERSION,
      type: event.type,
      payload: event.payload,
      source: {
        sessionId: session.session_id,
        turnId: attempt.turnId,
        executionId: attempt.executionId,
        attemptId: attempt.attemptId,
        providerSequence: event.providerSequence,
        chunkIndex: event.chunkIndex,
        leaseGeneration: attempt.leaseEpoch,
      },
      idempotencyKey: event.idempotencyKey,
      leaseOwner: attempt.controllerId,
      leaseEpoch: attempt.leaseEpoch,
    });
  }

  async claimNext(attempt: NativeGoalAttempt, providerSequence: number): Promise<NativeGoalClaim | null> {
    const session = await this.attach(attempt);
    const messages = await this.repository.getMessages(attempt.goalId);
    const head = messages.find(message => !['acknowledged', 'failed', 'cancelled'].includes(message.state));
    if (!head) return null;
    const fence = deliveryFence(attempt, session.session_id, head, providerSequence);
    const message = await this.repository.claimNextMessage(attempt.goalId, fence);
    return message ? { message, fence } : null;
  }

  async acknowledgeAccepted(claim: NativeGoalClaim): Promise<void> {
    const { message, fence } = claim;
    if (message.state === 'delivering') {
      await this.repository.markMessageDelivered(message.goalId, message.messageId, fence);
    }
    await this.repository.markMessageAcknowledged(message.goalId, message.messageId, fence);
  }

  async deliverNext(
    attempt: NativeGoalAttempt,
    providerSequence: number,
    sender: NativeGoalMessageSender
  ): Promise<GoalMessage | null> {
    const claim = await this.claimNext(attempt, providerSequence);
    if (!claim) return null;
    if (claim.message.state === 'delivering') {
      // An unknown send outcome intentionally remains `delivering`. A replacement
      // supervisor resends this same provider idempotency identity before acking.
      await sender.send({
        messageId: claim.message.messageId,
        body: claim.message.body,
        providerIdempotencyKey: claim.fence.providerIdempotencyKey,
      });
    }
    await this.acknowledgeAccepted(claim);
    return (await this.repository.getMessages(attempt.goalId))
      .find(message => message.messageId === claim.message.messageId) ?? null;
  }

  async deliverNextToSupervisor(
    attempt: NativeGoalAttempt,
    inputSequence: number,
    supervisor: NativeGoalSupervisor
  ): Promise<GoalMessage | null> {
    const claim = await this.claimNext(attempt, inputSequence);
    if (!claim) return null;
    if (claim.message.state === 'delivering') {
      const session = await supervisor.get(attempt.goalId);
      if (!session) throw new Error(`Native goal supervisor is not attached to ${attempt.goalId}`);
      const deliverySequence = claim.fence.providerSequence;
      if (session.lastInputSequence < deliverySequence) {
        if (session.lastInputSequence + 1 !== deliverySequence) {
          throw new Error(
            `Native goal input sequence is ${session.lastInputSequence}; cannot deliver ${deliverySequence}`
          );
        }
        await supervisor.steer(attempt.goalId, {
          sequence: deliverySequence,
          text: claim.message.body,
        });
      }
    }
    await this.acknowledgeAccepted(claim);
    return (await this.repository.getMessages(attempt.goalId))
      .find(message => message.messageId === claim.message.messageId) ?? null;
  }

  replay(
    goalId: string,
    options: { cursor?: string | null; limit?: number; maxBytes?: number } = {}
  ): Promise<GoalEventPageResult> {
    return this.repository.readEventPage(goalId, options);
  }

  compact(attempt: NativeGoalAttempt, throughSequence: number): Promise<void> {
    return this.repository.compactOutput(attempt.goalId, throughSequence, {
      leaseOwner: attempt.controllerId,
      leaseEpoch: attempt.leaseEpoch,
    });
  }
}

function deliveryFence(
  attempt: NativeGoalAttempt,
  sessionId: string,
  message: GoalMessage,
  providerSequence: number
): MessageDeliveryFence {
  if (message.claimedLeaseGeneration === attempt.leaseEpoch && message.deliveryKey
    && message.providerIdempotencyKey && message.claimedControllerId && message.claimedTurnId
    && message.claimedExecutionId && message.claimedAttemptId
    && message.claimedProviderSequence !== null && message.claimedChunkIndex !== null) {
    return {
      messageId: message.messageId,
      sessionId: message.claimedBy ?? sessionId,
      turnId: message.claimedTurnId,
      executionId: message.claimedExecutionId,
      attemptId: message.claimedAttemptId,
      controllerId: message.claimedControllerId,
      providerSequence: message.claimedProviderSequence,
      chunkIndex: message.claimedChunkIndex,
      deliveryKey: message.deliveryKey,
      providerIdempotencyKey: message.providerIdempotencyKey,
      leaseOwner: attempt.controllerId,
      leaseEpoch: attempt.leaseEpoch,
    };
  }
  const stableProviderKey = message.providerIdempotencyKey
    ?? digestKey('native-goal-input', attempt.agent, attempt.providerThreadId, message.messageId);
  const deliverySequence = message.claimedProviderSequence ?? providerSequence;
  return {
    messageId: message.messageId,
    sessionId,
    turnId: attempt.turnId,
    executionId: attempt.executionId,
    attemptId: attempt.attemptId,
    controllerId: attempt.controllerId,
    providerSequence: deliverySequence,
    chunkIndex: 0,
    deliveryKey: digestKey('native-goal-delivery', attempt.executionId, attempt.attemptId, message.messageId),
    providerIdempotencyKey: stableProviderKey,
    leaseOwner: attempt.controllerId,
    leaseEpoch: attempt.leaseEpoch,
  };
}

function digestKey(...parts: string[]): string {
  return `${parts[0]}:${crypto.createHash('sha256').update(parts.join('\0')).digest('hex')}`;
}
