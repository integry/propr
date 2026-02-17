/**
 * Event names for real-time updates via WebSocket
 * These events are published to Redis and broadcast to WebSocket clients
 */

/** Event fired when a task's state changes (e.g., pending -> processing -> completed) */
export const TASK_UPDATE = 'task:update';

/** Event fired when draft generation progress changes (relevance, context, llm steps) */
export const DRAFT_UPDATE = 'draft:update';

/** Event fired when a plan generation step completes */
export const PLAN_STEP_UPDATE = 'plan:step:update';

/** Event fired when indexing progress changes */
export const INDEXING_UPDATE = 'indexing:update';

/** Redis channel names for pub/sub */
export const REDIS_CHANNELS = {
  /** Channel for all task-related events */
  TASKS: 'gitfix:events:tasks',
  /** Channel for draft/plan generation events */
  DRAFTS: 'gitfix:events:drafts',
  /** Channel for indexing events */
  INDEXING: 'gitfix:events:indexing'
} as const;

/** Event payload for task updates */
export interface TaskUpdatePayload {
  eventType: typeof TASK_UPDATE;
  taskId: string;
  state: string;
  previousState?: string;
  repository?: string;
  issueNumber?: number;
  timestamp: string;
  /** Additional metadata about the state change */
  metadata?: Record<string, unknown>;
}

/** Event payload for draft updates */
export interface DraftUpdatePayload {
  eventType: typeof DRAFT_UPDATE;
  draftId: string;
  step: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  timestamp: string;
  /** Step-specific data (e.g., progress percentage, file counts) */
  data?: Record<string, unknown>;
}

/** Event payload for plan step updates */
export interface PlanStepUpdatePayload {
  eventType: typeof PLAN_STEP_UPDATE;
  draftId: string;
  step: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  timestamp: string;
  data?: Record<string, unknown>;
}

/** Event payload for indexing updates */
export interface IndexingUpdatePayload {
  eventType: typeof INDEXING_UPDATE;
  repository: string;
  phase: string;
  progress?: number;
  totalFiles?: number;
  processedFiles?: number;
  timestamp: string;
}

/** Union type for all event payloads */
export type EventPayload =
  | TaskUpdatePayload
  | DraftUpdatePayload
  | PlanStepUpdatePayload
  | IndexingUpdatePayload;
