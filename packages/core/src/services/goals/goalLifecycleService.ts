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
import { GoalRuntimeControlRepository } from './goalRuntimeControlRepository.js';
import type {
  Goal,
  GoalMessage,
  GoalActiveTimeStats,
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
  messages: GoalMessage[];
  summary: GoalSummaryView;
  stats: GoalActiveTimeStats;
}

export class GoalLifecycleService {
  readonly repository: GoalRepository;
  private readonly controls: GoalRuntimeControlRepository;

  constructor(dbOrRepository: Knex | GoalRepository) {
    this.repository =
      dbOrRepository instanceof GoalRepository
        ? dbOrRepository
        : new GoalRepository(dbOrRepository);
    this.controls = new GoalRuntimeControlRepository(this.repository.database);
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
    const goal = await this.repository.requireGoal(goalId);
    const [messages, latestSequence, stats, projection] =
      await Promise.all([
        this.repository.getMessages(goalId),
        this.repository.getLatestSequence(goalId),
        this.repository.getActiveTimeStats(goalId),
        this.controls.getProjection(goalId),
      ]);

    return {
      goal,
      messages,
      summary: buildSummary(goal, latestSequence, projection),
      stats,
    };
  }
}

export function buildSummary(
  goal: Goal,
  latestSequence: number,
  projection: Awaited<ReturnType<GoalRuntimeControlRepository['getProjection']>> = {
    plan: null, todos: null, status: null, nativeSequence: 0, updatedAt: null,
  }
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
    nativePlan: projection.plan as GoalSummaryView['nativePlan'],
    nativeTodos: projection.todos as GoalSummaryView['nativeTodos'],
    nativeStatus: projection.status as GoalSummaryView['nativeStatus'],
    latestSequence,
    createdAt: goal.createdAt,
    updatedAt: goal.updatedAt,
  };
}

export function isGoalTerminal(goal: Goal): boolean {
  return isTerminalGoalState(goal.state);
}
