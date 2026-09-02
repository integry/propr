/**
 * Facade for the durable goal repositories. Cohesive modules own identity and
 * reads, hierarchy/session writes, ordered events/messages, leases, and
 * lifecycle/model mutations while callers retain one repository surface.
 */
import type { Knex } from 'knex';
import type {
  AppendEventInput,
  CancelIntentInput,
  CreateGoalInput,
  CreateNodeInput,
  EnqueueMessageInput,
  Goal,
  GoalActiveTimeStats,
  GoalEvent,
  GoalLeaseFence,
  GoalMessage,
  GoalNode,
  OperatorIntentInput,
  GoalProviderSessionRecord,
  ListGoalsQuery,
  ListGoalsResult,
  ProviderSessionUpdate,
  TransitionInput,
} from './goalTypes.js';
import { GoalReadRepository } from './goalReadRepository.js';
import { GoalHierarchyRepository } from './goalHierarchyRepository.js';
import { GoalEventRepository } from './goalEventRepository.js';
import { GoalLeaseRepository } from './goalLeaseRepository.js';
import { GoalMutationRepository } from './goalMutationRepository.js';

export { GoalError } from './goalRepositorySupport.js';

export class GoalRepository {
  private readonly reads: GoalReadRepository;
  private readonly hierarchy: GoalHierarchyRepository;
  private readonly events: GoalEventRepository;
  private readonly leases: GoalLeaseRepository;
  private readonly mutations: GoalMutationRepository;

  constructor(readonly database: Knex) {
    const db = database;
    this.reads = new GoalReadRepository(db);
    this.hierarchy = new GoalHierarchyRepository(db);
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

  addNode(goalId: string, input: CreateNodeInput): Promise<GoalNode> {
    return this.hierarchy.addNode(goalId, input);
  }

  addDependency(
    goalId: string,
    nodeId: string,
    dependsOnNodeId: string,
    fence: GoalLeaseFence
  ): Promise<void> {
    return this.hierarchy.addDependency(goalId, nodeId, dependsOnNodeId, fence);
  }

  getNodes(goalId: string): Promise<GoalNode[]> {
    return this.hierarchy.getNodes(goalId);
  }

  getDependencies(goalId: string): Promise<Array<{ nodeId: string; dependsOnNodeId: string }>> {
    return this.hierarchy.getDependencies(goalId);
  }

  upsertProviderSession(
    goalId: string,
    agent: string,
    fields: ProviderSessionUpdate
  ): Promise<void> {
    return this.hierarchy.upsertProviderSession(goalId, agent, fields);
  }

  getProviderSession(goalId: string, agent: string): Promise<GoalProviderSessionRecord | null> {
    return this.hierarchy.getProviderSession(goalId, agent);
  }

  appendEvent(goalId: string, input: AppendEventInput): Promise<GoalEvent> {
    return this.events.appendEvent(goalId, input);
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

  assertLease(
    goalId: string,
    owner: string,
    epoch: number,
    options: { allowTerminal?: boolean } = {}
  ): Promise<void> {
    return this.leases.assertCurrent(goalId, owner, epoch, options);
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
