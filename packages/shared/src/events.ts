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

/**
 * General activity envelope derived from the lifecycle events above.
 *
 * Consumers declare an interest (domain, and optionally the kind of change)
 * instead of matching worker state strings, so a new producer does not have to
 * touch every surface that reacts to it.
 */
export const ACTIVITY_UPDATE = 'activity:update';

/** Event fired when a notification is created, read or dismissed for a recipient */
export const NOTIFICATION_UPDATE = 'notification:update';

/** Event fired when agent capacity or quota changes */
export const USAGE_UPDATE = 'usage:update';

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
  QUEUE_STATS: 'propr:events:queue',
  /** Channel for the derived activity envelope */
  ACTIVITY: 'propr:events:activity',
  /** Channel for per-recipient notification changes */
  NOTIFICATIONS: 'propr:events:notifications',
  /** Channel for agent capacity/quota changes */
  USAGE: 'propr:events:usage'
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
  /** Monotonic task-state revision; consumers ignore older revisions. */
  version?: number;
  /** Additional metadata about the state change */
  metadata?: Record<string, unknown>;
}

/** Known draft statuses used across the backend/frontend event contract */
export type DraftStatus = 'draft' | 'generating' | 'refining' | 'review' | 'approved' | 'executed' | 'executing' | 'pr_created' | 'merged' | 'failed';

/** Status of a generation trace step */
export type StepStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

/** Generation trace snapshot carried in draft update payloads */
export interface DraftUpdateGenerationTrace {
  steps: Array<{ name: string; status: StepStatus; data?: Record<string, unknown> }>;
  /** Generation run that owns this trace snapshot. */
  runId?: string;
  error?: string;
  failedAt?: string;
}

/** Event payload for draft updates */
export interface DraftUpdatePayload {
  eventType: typeof DRAFT_UPDATE;
  draftId: string;
  step: string;
  status: StepStatus;
  timestamp: string;
  /** Generation run that emitted this update. */
  runId?: string;
  /** Step-specific data (e.g., progress percentage, file counts) */
  data?: Record<string, unknown>;
  /** Current draft status — allows the UI to react without fetching */
  draftStatus?: DraftStatus;
  /** Full generation trace snapshot — allows the UI to update progress without fetching */
  generationTrace?: DraftUpdateGenerationTrace;
}

/** Event payload for plan step updates */
export interface PlanStepUpdatePayload {
  eventType: typeof PLAN_STEP_UPDATE;
  draftId: string;
  step: string;
  status: StepStatus;
  timestamp: string;
  data?: Record<string, unknown>;
}

/** Valid phase values for indexing status events */
export type IndexingPhase = 'indexing' | 'files' | 'directories' | 'completed' | 'failed' | 'idle';

/** Event payload for indexing updates */
export interface IndexingUpdatePayload {
  eventType: typeof INDEXING_UPDATE;
  repository: string;
  branch?: string;
  phase: IndexingPhase;
  progress?: number;
  totalFiles?: number;
  processedFiles?: number;
  totalDirectories?: number;
  processedDirectories?: number;
  timestamp: string;
}

/** Event for a single parsed conversation event from Claude log */
export interface ConversationEvent {
  type: 'thought' | 'tool_use' | 'tool_result';
  content?: string;
  /** Provider-labelled reasoning is excluded from concise external activity feeds by default. */
  internalReasoning?: boolean;
  /** Content comes exclusively from a Codex app-server reasoning item's summary. */
  reasoningSummary?: boolean;
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
  id?: string;
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
  /** Active native goal jobs included in the aggregate active count. */
  activeGoals?: number;
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

/** Area of the product an activity event belongs to */
export type ActivityDomain =
  | 'task'
  | 'plan'
  | 'queue'
  | 'indexing'
  | 'goal'
  | 'notification'
  | 'usage';

/** What happened to the subject of an activity event */
export type ActivityChange =
  | 'created'
  | 'started'
  | 'progress'
  | 'blocked'
  | 'failed'
  | 'completed'
  | 'cancelled'
  | 'updated';

/**
 * Event payload for the derived activity envelope.
 *
 * It deliberately carries no projection: it says that something in `domain`
 * changed, and the surface that cares re-reads its own endpoint. That keeps
 * each endpoint the single owner of its permission check.
 */
export interface ActivityUpdatePayload {
  eventType: typeof ACTIVITY_UPDATE;
  domain: ActivityDomain;
  change: ActivityChange;
  /** Repository the change belongs to, when it has one. */
  repository?: string;
  /** Task, draft, goal or notification id the change belongs to, when it has one. */
  subjectId?: string;
  /** True when the change ends the subject's lifecycle (completed/failed/cancelled). */
  terminal?: boolean;
  occurredAt: string;
}

/** What happened to a notification */
export type NotificationChange = 'created' | 'read' | 'dismissed' | 'dismissed_all';

/** Event payload for notification changes, published per recipient */
export interface NotificationUpdatePayload {
  eventType: typeof NOTIFICATION_UPDATE;
  change: NotificationChange;
  /** Notification event id the change concerns; absent for `dismissed_all`. */
  eventId?: string;
  /** Recipient the change was published for. */
  recipientId?: string;
  /** Recipient's unread count after the change, when the producer knows it. */
  unreadCount?: number;
  occurredAt: string;
}

/**
 * Event payload for agent capacity/quota changes.
 *
 * A bare trigger on purpose: the usage endpoint owns the projection and its
 * permission check, so pushing the numbers would authorize them twice.
 */
export interface UsageUpdatePayload {
  eventType: typeof USAGE_UPDATE;
  /** Provider whose capacity moved, when the producer knows it. */
  provider?: string;
  occurredAt: string;
}

/** Union type for all event payloads */
export type EventPayload =
  | TaskUpdatePayload
  | DraftUpdatePayload
  | PlanStepUpdatePayload
  | IndexingUpdatePayload
  | TaskLiveUpdatePayload
  | QueueStatsUpdatePayload
  | ActivityUpdatePayload
  | NotificationUpdatePayload
  | UsageUpdatePayload;
