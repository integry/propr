import type { JsonValue } from './notifications.js';

/** Host lifecycle. Provider-native status is exposed separately. */
export const GOAL_STATES = [
  'queued', 'planning', 'running', 'pausing', 'paused', 'recovering',
  'completing', 'completed', 'failed', 'cancelled',
] as const;
export type GoalState = (typeof GOAL_STATES)[number];

export const GOAL_CANNED_ACTIONS = ['whats_done', 'whats_left'] as const;
export type GoalCannedAction = (typeof GOAL_CANNED_ACTIONS)[number];

/** FIFO delivery states shared by every free-form and canned provider input. */
export const GOAL_MESSAGE_STATES = [
  'queued', 'delivering', 'delivered', 'acknowledged', 'failed', 'cancelled',
] as const;
export type GoalMessageState = (typeof GOAL_MESSAGE_STATES)[number];

export const GOAL_CONTROL_APPLICATIONS = ['immediate', 'next_turn', 'safe_boundary'] as const;
export type GoalControlApplication = (typeof GOAL_CONTROL_APPLICATIONS)[number];

export interface GoalControlCapability {
  supported: boolean;
  application: GoalControlApplication | null;
  description?: string;
}

export interface GoalProviderCapabilities {
  nativeGoal: boolean;
  pause: GoalControlCapability;
  resume: GoalControlCapability;
  steer: GoalControlCapability;
  modelChange: GoalControlCapability;
}

export interface GoalPolicyPreferences {
  /** Preference passed to the provider; ProPR does not schedule this work. */
  maxParallelism: number;
  /** Preference passed to the provider; ProPR does not run a goal scheduler. */
  ultrafix: {
    enabled: boolean;
    ratingGoal: number | null;
    maxCycles: number | null;
  };
}

export interface CreateGoalRequest {
  objective: string;
  repository: string;
  agent: string;
  model: string;
  /** Provider policy preference; this is not a ProPR scheduler width. */
  maxActiveTasks: number;
  /** The final goal pull request remains draft for manual approval. */
  mergePolicy: 'manual';
  ultrafixEnabled: boolean;
  ultrafixGoal: number | null;
  ultrafixMaxCycles: number | null;
}

export interface PublicGoalDto {
  goalId: string;
  objective: string;
  repository: string;
  state: GoalState;
  agent: string;
  requestedModel: string;
  effectiveModel: string;
  maxActiveTasks: number;
  mergePolicy: 'manual';
  ultrafixEnabled: boolean;
  ultrafixGoal: number | null;
  ultrafixMaxCycles: number | null;
  version: number;
  terminalReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export type GoalPlanItemStatus = 'pending' | 'in_progress' | 'completed' | 'blocked' | 'cancelled';
export interface GoalPlanItem {
  itemId: string;
  text: string;
  status: GoalPlanItemStatus;
  detail: string | null;
}

/**
 * Materialized provider plan. The source tuple prevents an event from an old
 * session/generation from replacing the current provider's authoritative plan.
 */
export type GoalPlanProjection =
  | { status: 'not-reported' }
  | {
      status: 'reported';
      provider: string;
      sessionId: string;
      generation: number;
      eventSequence: number;
      title: string | null;
      items: GoalPlanItem[];
      updatedAt: string;
    };

export interface GoalNativeProviderState {
  sessionId: string | null;
  generation: number;
  eventSequence: number;
  status: string | null;
  statusDetail: string | null;
  updatedAt: string | null;
  checkpoint: { checkpointId: string; label: string | null; eventSequence: number; updatedAt: string } | null;
  capabilities: GoalProviderCapabilities;
}

export interface GoalTokenBreakdown {
  provider: string;
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  total: number;
}

export interface GoalPassiveArtifacts {
  issues: { total: number; open: number; closed: number };
  pullRequests: { total: number; open: number; merged: number; draft: number };
  finalPullRequest: { number: number; url: string; draft: boolean } | null;
}

export interface GoalStats {
  tokens: { total: number; byProviderModel: GoalTokenBreakdown[] };
  time: { elapsedSeconds: number; activeSeconds: number; pausedSeconds: number };
  messages: { queued: number; oldestQueuedSeconds: number | null };
  artifacts: GoalPassiveArtifacts;
}

export interface PublicGoalMessageDto {
  messageId: string;
  sequence: number;
  body: string;
  cannedAction: GoalCannedAction | null;
  state: GoalMessageState;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface GoalInfrastructureState {
  recovery: { state: 'healthy' | 'recovering' | 'offline'; attempt: number; reason: string | null };
  warnings: string[];
}

export interface PublicGoalDetailDto {
  goal: PublicGoalDto;
  provider: GoalNativeProviderState;
  plan: GoalPlanProjection;
  messages: PublicGoalMessageDto[];
  stats: GoalStats;
  infrastructure: GoalInfrastructureState;
  latestSequence: number;
  latestCursor: string | null;
}

export type GoalSummaryProjection =
  | { status: 'not-yet-projected' }
  | {
      status: 'ready';
      provider: Pick<GoalNativeProviderState, 'status' | 'statusDetail' | 'updatedAt'>;
      plan: { total: number; completed: number } | null;
      stats: GoalStats;
      latestEvent: string | null;
      connectionState: 'connected' | 'recovering' | 'disconnected';
    };

export interface GoalSummaryView extends Omit<PublicGoalDto, 'terminalReason'> {
  latestSequence: number;
  projection: GoalSummaryProjection;
}

export interface GoalListResponse {
  goals: GoalSummaryView[];
  nextCursor: string | null;
}

export interface GoalEventPage<TEvent = unknown> {
  schemaVersion: 1;
  events: TEvent[];
  previousCursor: string | null;
  nextCursor: string | null;
  hasMoreBefore: boolean;
  asOfSequence: number;
}

export type GoalJsonValue = JsonValue;
