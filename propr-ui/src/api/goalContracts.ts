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
  time: { elapsedSeconds: number; activeSeconds: number; pausedSeconds: number };
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

export const GOAL_NODE_KINDS = ['root_epic', 'sub_epic', 'implementation_issue', 'implementation_pr'] as const;
export type GoalNodeKind = (typeof GOAL_NODE_KINDS)[number];

export const GOAL_NODE_STATES = ['pending', 'ready', 'active', 'blocked', 'failed', 'completed', 'cancelled'] as const;
export type GoalNodeState = (typeof GOAL_NODE_STATES)[number];

export const GOAL_EVENT_TYPES = [
  'stdout',
  'stderr',
  'assistant',
  'tool',
  'checkpoint',
  'usage',
  'message',
  'lifecycle',
] as const;
export type GoalEventType = (typeof GOAL_EVENT_TYPES)[number];

export const GOAL_MESSAGE_STATES = [
  'pending',
  'delivered',
  'acknowledged',
  'failed',
  'cancelled',
] as const;
export type GoalMessageState = (typeof GOAL_MESSAGE_STATES)[number];
export type GoalMessageResponseSource = 'controller' | 'provider' | null;

export type GoalJsonValue = null | boolean | number | string | GoalJsonValue[] | { [key: string]: GoalJsonValue };

export interface GoalHierarchyNodeV1 {
  nodeId: string;
  parentNodeId: string | null;
  kind: GoalNodeKind;
  title: string;
  state: GoalNodeState;
  orderIndex: number;
  externalRef: string | null;
  externalUrl: string | null;
  blockedReason: string | null;
  ci: 'pending' | 'running' | 'passed' | 'failed' | 'not_applicable';
  review: 'pending' | 'approved' | 'changes_requested' | 'not_applicable';
  ultrafix: 'pending' | 'running' | 'passed' | 'failed' | 'not_applicable';
  merge: 'pending' | 'ready' | 'merged' | 'failed' | 'not_applicable';
}

export interface GoalProviderTodoV1 {
  todoId: string;
  provider: string;
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  updatedAt: string;
}

export interface GoalTokenBreakdownV1 {
  provider: string;
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  total: number;
}

export interface GoalDetailStatsV1 {
  issues: { total: number; active: number; processed: number; failed: number; blocked: number };
  pullRequests: { open: number; reviewPending: number; ultrafixPending: number; mergeReady: number; merged: number };
  tokens: { total: number; byModel: GoalTokenBreakdownV1[] };
  time: { elapsedSeconds: number; activeSeconds: number; pausedSeconds: number; recoverySeconds: number };
}

export interface GoalMessageV1 {
  messageId: string;
  sequence: number;
  body: string;
  predefinedKind: 'whats_done' | 'whats_left' | null;
  state: GoalMessageState;
  responseSource: GoalMessageResponseSource;
  response: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface GoalDetailV1 {
  goal: GoalRecordV1 & { terminalReason: string | null };
  hierarchy: {
    nodes: GoalHierarchyNodeV1[];
    dependencies: Array<{ nodeId: string; dependsOnNodeId: string }>;
  };
  providerTodos: GoalProviderTodoV1[];
  messages: GoalMessageV1[];
  stats: GoalDetailStatsV1;
  recovery: { state: 'healthy' | 'recovering' | 'offline'; attempt: number; reason: string | null };
  epicPrUrl: string | null;
  completionBlockers: string[];
  latestSequence: number;
}

export interface GoalEventV1 {
  goalId: string;
  sequence: number;
  type: GoalEventType;
  source: string;
  timestamp: string;
  turnId: string | null;
  content: string;
  payload: GoalJsonValue;
}

export interface GoalEventsPageV1 {
  events: GoalEventV1[];
  previousCursor: number | null;
  nextCursor: number | null;
  hasMoreBefore: boolean;
}
