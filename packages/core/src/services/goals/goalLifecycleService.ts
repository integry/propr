/**
 * Higher-level lifecycle operations composed from {@link GoalRepository}
 * transitions, plus the read-model assembly (hierarchy + summary + derived
 * time) the API returns.
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
  GoalActiveTimeStats,
} from './goalTypes.js';

export interface GoalMutationOptions {
  expectedVersion?: number;
  reason?: string;
  leaseOwner?: string;
  leaseEpoch?: number;
  idempotencyKey?: string;
}

export interface GoalDetail {
  goal: Goal;
  nodes: GoalNode[];
  dependencies: Array<{ nodeId: string; dependsOnNodeId: string }>;
  messages: GoalMessage[];
  summary: GoalSummaryView;
  stats: GoalActiveTimeStats;
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
    return this.repository.transitionOperatorIntent(goalId, {
      toState: 'pausing',
      expectedVersion: options.expectedVersion,
      reason: options.reason ?? 'user_requested_pause',
      leaseOwner: options.leaseOwner,
      leaseEpoch: options.leaseEpoch,
      idempotencyKey: options.idempotencyKey,
      idempotencyOperation: `pause:${goalId}`,
    });
  }

  /** Controller confirmation that the goal is fully paused. */
  async confirmPaused(
    goalId: string,
    options: GoalMutationOptions = {}
  ): Promise<Goal> {
    return this.repository.transition(goalId, {
      toState: 'paused',
      expectedVersion: options.expectedVersion,
      reason: options.reason ?? 'controller_paused',
      leaseOwner: options.leaseOwner,
      leaseEpoch: options.leaseEpoch,
    });
  }

  async resume(
    goalId: string,
    options: GoalMutationOptions & { toState?: 'running' | 'planning' } = {}
  ): Promise<Goal> {
    return this.repository.transitionOperatorIntent(goalId, {
      toState: options.toState ?? 'running',
      expectedVersion: options.expectedVersion,
      reason: options.reason ?? 'user_requested_resume',
      leaseOwner: options.leaseOwner,
      leaseEpoch: options.leaseEpoch,
      idempotencyKey: options.idempotencyKey,
      idempotencyOperation: `resume:${goalId}`,
    });
  }

  async cancel(
    goalId: string,
    options: GoalMutationOptions & { terminalReason?: GoalTerminalReason } = {}
  ): Promise<Goal> {
    return this.repository.transitionOperatorIntent(goalId, {
      toState: 'cancelled',
      expectedVersion: options.expectedVersion,
      reason: options.reason ?? 'user_requested_cancel',
      terminalReason: options.terminalReason ?? 'user_cancelled',
      leaseOwner: options.leaseOwner,
      leaseEpoch: options.leaseEpoch,
      idempotencyKey: options.idempotencyKey,
      idempotencyOperation: `cancel:${goalId}`,
    });
  }

  async getDetail(goalId: string): Promise<GoalDetail> {
    const goal = await this.repository.requireGoal(goalId);
    const [nodes, dependencies, messages, latestSequence, stats] =
      await Promise.all([
        this.repository.getNodes(goalId),
        this.repository.getDependencies(goalId),
        this.repository.getMessages(goalId),
        this.repository.getLatestSequence(goalId),
        this.repository.getActiveTimeStats(goalId),
      ]);

    return {
      goal,
      nodes,
      dependencies,
      messages,
      summary: buildSummary(goal, nodes, latestSequence),
      stats,
    };
  }
}

export function buildSummary(
  goal: Goal,
  nodes: GoalNode[],
  latestSequence: number
): GoalSummaryView {
  const activeNodeCount = nodes.filter(
    (node) => node.status === 'in_progress'
  ).length;
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
    nodeCount: nodes.length,
    activeNodeCount,
    latestSequence,
  };
}

export function isGoalTerminal(goal: Goal): boolean {
  return isTerminalGoalState(goal.state);
}
