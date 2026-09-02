/**
 * Higher-level lifecycle operations composed from {@link GoalRepository}
 * transitions, plus the provider-native checklist, summary, and derived time
 * read model returned by the API.
 *
 * Pause is nonterminal: `pause` records the intent (`pausing`), a controller
 * confirms `paused`, and `resume` returns the goal to active work while every
 * durable child record (nodes, dependencies, sessions, messages, events, stats)
 * is preserved. Cancellation is distinct from pause and records why active work
 * was stopped.
 */

import type { Knex } from 'knex';
import {
  isTerminalGoalState,
  type GoalSummaryView,
  type GoalTerminalReason,
} from '@propr/shared';
import { GoalRepository } from './goalRepository.js';
import type {
  Goal,
  GoalNode,
  GoalMessage,
  GoalStatistics,
  GoalChecklistItem,
} from './goalTypes.js';

export interface GoalMutationOptions {
  expectedVersion?: number;
  reason?: string;
  idempotencyKey?: string;
}

export interface ControllerGoalMutationOptions extends GoalMutationOptions {
  leaseOwner: string;
  leaseEpoch: number;
}

export interface GoalDetail {
  goal: Goal;
  nodes: GoalNode[];
  dependencies: Array<{ nodeId: string; dependsOnNodeId: string }>;
  messages: GoalMessage[];
  summary: GoalSummaryView;
  stats: GoalStatistics;
  checklist: GoalChecklistItem[];
  messagesNextCursor: string | null;
  checklistNextCursor: string | null;
  asOfVersion: number;
  asOfSequence: number;
}

export class GoalLifecycleService {
  readonly repository: GoalRepository;

  constructor(dbOrRepository: Knex | GoalRepository) {
    this.repository =
      dbOrRepository instanceof GoalRepository
        ? dbOrRepository
        : new GoalRepository(dbOrRepository);
  }

  async pause(goalId: string, options: GoalMutationOptions = {}): Promise<Goal> {
    return this.repository.requestPause(goalId, {
      expectedVersion: options.expectedVersion,
      reason: options.reason ?? 'user_requested_pause',
      idempotencyKey: options.idempotencyKey,
    });
  }

  /** Controller confirmation that the goal is fully paused. */
  async confirmPaused(
    goalId: string,
    options: ControllerGoalMutationOptions
  ): Promise<Goal> {
    return this.repository.transition(goalId, {
      toState: 'paused',
      expectedVersion: options.expectedVersion,
      reason: options.reason ?? 'controller_paused',
      leaseOwner: options.leaseOwner,
      leaseEpoch: options.leaseEpoch,
      idempotencyKey: options.idempotencyKey,
      idempotencyOperation: `confirm-paused:${goalId}`,
    });
  }

  async resume(
    goalId: string,
    options: GoalMutationOptions = {}
  ): Promise<Goal> {
    return this.repository.requestResume(goalId, {
      expectedVersion: options.expectedVersion,
      reason: options.reason ?? 'user_requested_resume',
      idempotencyKey: options.idempotencyKey,
    });
  }

  async cancel(
    goalId: string,
    options: GoalMutationOptions & { terminalReason?: GoalTerminalReason } = {}
  ): Promise<Goal> {
    return this.repository.requestCancel(goalId, {
      expectedVersion: options.expectedVersion,
      reason: options.reason ?? 'user_requested_cancel',
      terminalReason: options.terminalReason ?? 'user_cancelled',
      idempotencyKey: options.idempotencyKey,
    });
  }

  async getDetail(goalId: string): Promise<GoalDetail> {
    return this.repository.withReadSnapshot(async repository => {
      // The first read establishes the WAL snapshot used by every projection.
      const goal = await repository.requireGoal(goalId);
      const [nodes, dependencies, messagePage, checklistPage, latestSequence, stats] =
        await Promise.all([
          repository.readNodePage(goalId),
          repository.getDependencies(goalId),
          repository.readMessagePage(goalId),
          repository.readProviderChecklistPage(goalId),
          repository.getLatestSequence(goalId),
          repository.getStatistics(goalId),
        ]);
      return {
        goal,
        nodes: nodes.nodes,
        dependencies,
        messages: messagePage.messages,
        messagesNextCursor: messagePage.nextCursor,
        checklist: checklistPage.items,
        checklistNextCursor: checklistPage.nextCursor,
        summary: buildSummary(goal, latestSequence),
        stats,
        asOfVersion: goal.version,
        asOfSequence: latestSequence,
      };
    });
  }
}

export function buildSummary(
  goal: Goal,
  latestSequence: number
): GoalSummaryView {
  return {
    goalId: goal.goalId,
    state: goal.state,
    objective: goal.objective,
    repository: goal.repository,
    agent: goal.agent,
    requestedModel: goal.requestedModel,
    effectiveModel: goal.effectiveModel,
    maxActiveTasks: goal.maxActiveTasks,
    mergePolicy: goal.mergePolicy,
    ultrafixEnabled: goal.ultrafixEnabled,
    ultrafixGoal: goal.ultrafixGoal,
    ultrafixMaxCycles: goal.ultrafixMaxCycles,
    version: goal.version,
    latestSequence,
    createdAt: goal.createdAt,
    updatedAt: goal.updatedAt,
  };
}

export function isGoalTerminal(goal: Goal): boolean {
  return isTerminalGoalState(goal.state);
}
