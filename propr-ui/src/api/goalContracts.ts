/**
 * Temporary exact mirror of the V1 goal summary contract from the goal control
 * plane. Replace this file with imports from @propr/shared when #2006 is
 * integrated; keeping the mirror isolated prevents a second UI naming dialect.
 */
export const GOAL_STATES = [
  'queued',
  'planning',
  'running',
  'pausing',
  'paused',
  'recovering',
  'completing',
  'completed',
  'failed',
  'cancelled',
] as const;

export type GoalState = (typeof GOAL_STATES)[number];
export const GOAL_MERGE_POLICIES = ['manual', 'auto', 'auto_squash'] as const;
export type GoalMergePolicy = (typeof GOAL_MERGE_POLICIES)[number];

export interface GoalProjectionReadyV1 {
  status: 'ready';
  checklist: { total: number; completed: number };
  issues: { total: number; active: number; processed: number; failed: number; blocked: number };
  pullRequests: { open: number; reviewPending: number; ultrafixPending: number; mergeReady: number; merged: number };
  tokens: { total: number };
  time: { elapsedSeconds: number; pausedSeconds: number };
  latestEvent: string | null;
  connectionState: 'connected' | 'recovering' | 'disconnected';
  epicPrUrl: string | null;
}

export type GoalProjectionV1 =
  | { status: 'not-yet-projected' }
  | GoalProjectionReadyV1;

export interface GoalRecordV1 {
  goalId: string;
  objective: string;
  repository: string;
  state: GoalState;
  agent: string;
  requestedModel: string;
  effectiveModel: string;
  maxActiveTasks: number;
  mergePolicy: GoalMergePolicy;
  ultrafixEnabled: boolean;
  ultrafixGoal: number | null;
  ultrafixMaxCycles: number | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

/** V1 list summary: baseline SQL fields plus an explicitly-versioned extension projection. */
export interface GoalSummaryV1 extends GoalRecordV1 {
  nodeCount: number;
  activeNodeCount: number;
  latestSequence: number;
  projection: GoalProjectionV1;
}

export interface GoalsListResponseV1 {
  goals: GoalSummaryV1[];
  nextCursor: string | null;
}

export interface CreateGoalRequestV1 {
  objective: string;
  repository: string;
  agent: string;
  model: string;
  maxActiveTasks: number;
  mergePolicy: GoalMergePolicy;
  ultrafixEnabled: boolean;
  ultrafixGoal: number | null;
  ultrafixMaxCycles: number | null;
}

