/**
 * Facade for the durable goal repositories. Cohesive modules own identity and
 * reads, the single provider session, ordered events/messages, leases, and
 * lifecycle/model mutations while callers retain one repository surface.
 */
import type { Knex } from 'knex';
import type {
  AppendInternalEventInput,
  CancelIntentInput,
  CreateGoalInput,
  EnqueueMessageInput,
  Goal,
  GoalActiveTimeStats,
  GoalEvent,
  GoalLeaseFence,
  GoalMessage,
  OperatorIntentInput,
  GoalProviderSessionRecord,
  ListGoalsQuery,
  ListGoalsResult,
  ProviderSessionUpdate,
  TransitionInput,
} from './goalTypes.js';
import { GoalReadRepository } from './goalReadRepository.js';
import { GoalSessionRepository } from './goalSessionRepository.js';
import { GoalEventRepository } from './goalEventRepository.js';
import { GoalLeaseRepository } from './goalLeaseRepository.js';
import { GoalMutationRepository } from './goalMutationRepository.js';

export { GoalError } from './goalRepositorySupport.js';

export class GoalRepository {
  private readonly reads: GoalReadRepository;
  private readonly sessions: GoalSessionRepository;
  private readonly events: GoalEventRepository;
  private readonly leases: GoalLeaseRepository;
  private readonly mutations: GoalMutationRepository;

  constructor(db: Knex) {
    this.reads = new GoalReadRepository(db);
    this.sessions = new GoalSessionRepository(db);
    this.events = new GoalEventRepository(db);
    this.leases = new GoalLeaseRepository(db);
    this.mutations = new GoalMutationRepository(db);
  }

  createGoal(input: CreateGoalInput): Promise<Goal> {
    return this.reads.createGoal(input);
  }

  readCreateGoalReplay(input: CreateGoalInput): Promise<Goal | null> {
    return this.reads.readCreateGoalReplay(input);
  }

  getGoal(goalId: string): Promise<Goal | null> {
    return this.reads.getGoal(goalId);
  }

  requireGoal(goalId: string): Promise<Goal> {
    return this.reads.requireGoal(goalId);
  }

  listGoals(query: ListGoalsQuery): Promise<ListGoalsResult> {
    return this.reads.listGoals(query);
  }

  getActiveTimeStats(goalId: string): Promise<GoalActiveTimeStats> {
    return this.reads.getActiveTimeStats(goalId);
  }

  upsertProviderSession(
    goalId: string,
    fields: ProviderSessionUpdate
  ): Promise<void> {
    return this.sessions.upsertProviderSession(goalId, fields);
  }

  getProviderSession(goalId: string): Promise<GoalProviderSessionRecord | null> {
    return this.sessions.getProviderSession(goalId);
  }

  appendInternalEvent(goalId: string, input: AppendInternalEventInput): Promise<GoalEvent> {
    return this.events.appendInternalEvent(goalId, input);
  }

  readEvents(
    goalId: string,
    options: { afterSequence?: number; limit?: number; kind?: string } = {}
  ): Promise<{ events: GoalEvent[]; nextCursor: number | null }> {
    return this.events.readEvents(goalId, options);
  }

  getLatestSequence(goalId: string): Promise<number> {
    return this.events.getLatestSequence(goalId);
  }

  enqueueMessage(goalId: string, input: EnqueueMessageInput): Promise<GoalMessage> {
    return this.events.enqueueMessage(goalId, input);
  }

  getMessages(goalId: string): Promise<GoalMessage[]> {
    return this.events.getMessages(goalId);
  }

  markMessageDelivered(goalId: string, messageId: string, fence: GoalLeaseFence): Promise<void> {
    return this.events.markMessageDelivered(goalId, messageId, fence);
  }

  markMessageAcknowledged(goalId: string, messageId: string, fence: GoalLeaseFence): Promise<void> {
    return this.events.markMessageAcknowledged(goalId, messageId, fence);
  }

  claimLease(goalId: string, owner: string, ttlMs: number): Promise<{ epoch: number; expiresAt: string }> {
    return this.leases.claimLease(goalId, owner, ttlMs);
  }

  renewLease(goalId: string, owner: string, epoch: number, ttlMs: number): Promise<{ expiresAt: string }> {
    return this.leases.renewLease(goalId, owner, epoch, ttlMs);
  }

  releaseLease(goalId: string, owner: string, epoch: number): Promise<void> {
    return this.leases.releaseLease(goalId, owner, epoch);
  }

  transition(goalId: string, input: TransitionInput): Promise<Goal> {
    return this.mutations.transition(goalId, input);
  }

  requestPause(goalId: string, input: OperatorIntentInput = {}): Promise<Goal> {
    return this.mutations.requestPause(goalId, input);
  }

  requestResume(goalId: string, input: OperatorIntentInput = {}): Promise<Goal> {
    return this.mutations.requestResume(goalId, input);
  }

  requestCancel(
    goalId: string,
    input: CancelIntentInput = {}
  ): Promise<Goal> {
    return this.mutations.requestCancel(goalId, input);
  }

  requestModelChange(
    goalId: string,
    requestedModel: string,
    options: { expectedVersion?: number; reason?: string; idempotencyKey?: string } = {}
  ): Promise<Goal> {
    return this.mutations.requestModelChange(goalId, requestedModel, options);
  }

  readModelChangeReplay(
    goalId: string,
    requestedModel: string,
    options: { expectedVersion?: number; reason?: string; idempotencyKey?: string } = {}
  ): Promise<Goal | null> {
    return this.mutations.readModelChangeReplay(goalId, requestedModel, options);
  }

  applyModelChange(goalId: string, fence: GoalLeaseFence): Promise<Goal> {
    return this.mutations.applyModelChange(goalId, fence);
  }
}
