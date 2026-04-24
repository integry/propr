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

/** Event fired when live task details (Claude log) changes */
export const TASK_LIVE_UPDATE = 'task:live:update';

/** Event fired when queue statistics change */
export const QUEUE_STATS_UPDATE = 'queue:stats:update';

/** Redis channel names for pub/sub */
export const REDIS_CHANNELS = {
  /** Channel for all task-related events */
  TASKS: 'propr:events:tasks',
  /** Channel for draft/plan generation events */
  DRAFTS: 'propr:events:drafts',
  /** Channel for indexing events */
  INDEXING: 'propr:events:indexing',
  /** Channel for live task details (Claude log updates) */
  LIVE_DETAILS: 'propr:events:live',
  /** Channel for queue statistics updates */
  QUEUE_STATS: 'propr:events:queue'
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

/** Event for a single parsed conversation event from Claude log */
export interface ConversationEvent {
  type: 'thought' | 'tool_use' | 'tool_result';
  content?: string;
  toolName?: string;
  input?: Record<string, unknown>;
  id?: string;
  toolUseId?: string;
  result?: unknown;
  isError?: boolean;
  isSubagentSummary?: boolean;
  timestamp: string;
}

/** Todo item from Claude's TodoWrite calls */
export interface TodoItem {
  status: string;
  content: string;
}

/** Token usage information */
export interface TokenUsageInfo {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

/** Event payload for live task details updates */
export interface TaskLiveUpdatePayload {
  eventType: typeof TASK_LIVE_UPDATE;
  taskId: string;
  events: ConversationEvent[];
  todos: TodoItem[];
  currentTask: string | null;
  tokenUsage: TokenUsageInfo | null;
  timestamp: string;
}

/** Queue statistics data */
export interface QueueStatsData {
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
  total: number;
}

/** Event payload for queue statistics updates */
export interface QueueStatsUpdatePayload {
  eventType: typeof QUEUE_STATS_UPDATE;
  stats: QueueStatsData;
  timestamp: string;
}

/** Command mode for slash-command-driven tasks */
export type CommandMode = 'default' | 'review' | 'fix';

/** Union type for all event payloads */
export type EventPayload =
  | TaskUpdatePayload
  | DraftUpdatePayload
  | PlanStepUpdatePayload
  | IndexingUpdatePayload
  | TaskLiveUpdatePayload
  | QueueStatsUpdatePayload;
