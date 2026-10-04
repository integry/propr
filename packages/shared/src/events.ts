// The envelope-shaped variants of these payloads live in `activityEvents.ts`
// and are aliased here: that module owns the general activity surface, while
// the declarations below stay the shape the shell surfaces already consume.
// `EventPayload` has to admit both, so neither publisher is excluded.
// The vocabularies the two formats genuinely share are imported rather than
// restated: the notification changes and the capacity readings are one list, so
// a guard here cannot drift from the envelope's, and `isActivityTimestamp` is
// the single definition of a usable instant.
import {
  isActivityTimestamp,
  NOTIFICATION_CHANGES,
  USAGE_SOURCES,
  type ActivityUpdatePayload as ScopedActivityUpdatePayload,
  type GoalUpdatePayload,
  type GoalUpdateTriggerPayload,
  type NotificationUpdatePayload as RecipientListNotificationUpdatePayload,
  type UsageUpdatePayload as ScopedUsageUpdatePayload,
} from './activityEvents.js';
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
  ACTIVITY: 'propr:events:activity',
  /** Channel for draft/plan generation events */
  DRAFTS: 'propr:events:drafts',
  /** Channel for indexing events */
  INDEXING: 'propr:events:indexing',
  /** Channel for live task details (Claude log updates) */
  LIVE_DETAILS: 'propr:events:live',
  /** Channel for queue statistics updates */
  QUEUE_STATS: 'propr:events:queue',
  // Separate channels rather than one multiplexed channel so a process that
  // only cares about notifications does not have to decode and discard every
  // task frame on a busy instance.
  /** Channel for goal lifecycle transitions */
  GOALS: 'propr:events:goals',
  /** Channel for notification create/read/dismiss changes */
  NOTIFICATIONS: 'propr:events:notifications',
  /** Channel for agent usage change triggers */
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

/**
 * How far into a task's live output log a read got. Within one epoch a larger
 * offset reflects newer output, so a read at or past an update's position
 * already contains everything that update carried, grown events included.
 */
export interface LiveOutputPosition {
  epoch: string;
  offset: number;
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
  /**
   * Full-state payloads only: raw terminal events of this execution left out to
   * keep the payload bounded. Readable (`thought`) events are never left out.
   */
  omittedEventCount?: number;
  /**
   * Full-state payloads only: earlier output of this execution exceeded the
   * live log's retention limit and was discarded, so neither `events` nor
   * `omittedEventCount` covers it.
   */
  historyTruncated?: boolean;
  /** Where in the live output log this payload was read; absent for output without ordered offsets. */
  liveOutputPosition?: LiveOutputPosition;
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
  /** Subscription snapshot, not a change requiring an HTTP reconciliation. */
  initial?: boolean;
  eventType: typeof QUEUE_STATS_UPDATE;
  stats: QueueStatsData;
  timestamp: string;
}

/** Command mode for slash-command-driven tasks */
export type CommandMode = 'default' | 'review' | 'fix';

/**
 * Area of the product an activity event belongs to.
 *
 * A runtime list, not just a union: these frames are decoded from Redis and
 * re-emitted to browsers, so the relay has to be able to check the same
 * vocabulary a producer compiles against. Additive: append, never reorder.
 */
export const SHELL_ACTIVITY_DOMAINS = [
  'task',
  'plan',
  'queue',
  'indexing',
  'goal',
  'notification',
  'usage',
  /**
   * Instance health: daemon, workers, Redis, GitHub/agent authentication and
   * agent reachability. Nothing in a run's lifecycle announces that a worker
   * or the daemon stopped, so `health` is published by the watcher that looks
   * at the status snapshot itself.
   */
  'health',
] as const;
export type ActivityDomain = (typeof SHELL_ACTIVITY_DOMAINS)[number];

/** What happened to the subject of an activity event */
export const SHELL_ACTIVITY_CHANGES = [
  'created',
  'started',
  'progress',
  'blocked',
  'failed',
  'completed',
  'cancelled',
  'updated',
] as const;
export type ActivityChange = (typeof SHELL_ACTIVITY_CHANGES)[number];

/**
 * Changes that end the subject's lifecycle.
 *
 * `terminal` travels on the wire so consumers do not re-derive it; this is what
 * it has to agree with, both where a producer sets it and where the relay
 * checks an incoming frame against its own change.
 */
const SHELL_TERMINAL_CHANGES = new Set<ActivityChange>(['completed', 'failed', 'cancelled']);

/** Whether a shell-shaped change ends the subject's lifecycle. */
export const isTerminalShellActivityChange = (change: ActivityChange): boolean =>
  SHELL_TERMINAL_CHANGES.has(change);

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

/**
 * Runtime guards for the shell-shaped wire formats above.
 *
 * The relay accepts two published formats per event - the envelope declared in
 * `activityEvents.ts` and the shell shape declared here - and re-emits either
 * to browsers unchanged apart from filling in the envelope's required fields.
 * Supporting the second shape must not cost the first one's validation, so each
 * accepted format is checked whole - timestamps, enum values, identifiers,
 * repository scope and terminal consistency - before anything is broadcast.
 * Normalizing a missing field is not the same as validating the ones that are
 * present, so these guards, not the normalization, are the trust boundary.
 */

/** A present identifier. An empty string addresses no record, so it is not one. */
const isShellIdentifier = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0;

/**
 * An optional identifier or scope. Absent is legitimate - a queue or health
 * frame has no subject and no repository - but a present one that a consumer
 * cannot filter on would silently keep or drop the wrong frames.
 */
const isOptionalShellIdentifier = (value: unknown): boolean =>
  value === undefined || value === null || isShellIdentifier(value);

/** An optional whole non-negative count, such as a recipient's unread total. */
const isOptionalShellCount = (value: unknown): boolean =>
  value === undefined || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0);

const isShellMember = (values: readonly string[], value: unknown): boolean =>
  typeof value === 'string' && values.includes(value);

/** True when `value` satisfies the shell activity contract in full. */
export function isShellActivityUpdatePayload(value: unknown): value is ActivityUpdatePayload {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<ActivityUpdatePayload>;
  if (candidate.eventType !== ACTIVITY_UPDATE) return false;
  if (!isActivityTimestamp(candidate.occurredAt)) return false;
  if (!isShellMember(SHELL_ACTIVITY_DOMAINS, candidate.domain)) return false;
  if (!isShellMember(SHELL_ACTIVITY_CHANGES, candidate.change)) return false;
  if (!isOptionalShellIdentifier(candidate.repository)) return false;
  if (!isOptionalShellIdentifier(candidate.subjectId)) return false;
  // A flag that disagrees with its own change means producer and consumer would
  // read the same event differently, which is malformed rather than redundant.
  return candidate.terminal === undefined
    || candidate.terminal === isTerminalShellActivityChange(candidate.change as ActivityChange);
}

/** True when `value` satisfies the per-recipient notification contract in full. */
export function isShellNotificationUpdatePayload(
  value: unknown,
): value is NotificationUpdatePayload {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<NotificationUpdatePayload>;
  if (candidate.eventType !== NOTIFICATION_UPDATE) return false;
  if (!isActivityTimestamp(candidate.occurredAt)) return false;
  if (!isShellMember(NOTIFICATION_CHANGES, candidate.change)) return false;
  // `eventId` is absent for `dismissed_all` and for a multi-event dismissal,
  // which are both 'reconcile the list' to the client, so only its type is
  // fixed here. `unreadCount` drives the badge, so a non-count is dropped.
  if (!isOptionalShellIdentifier(candidate.eventId)) return false;
  if (!isOptionalShellIdentifier(candidate.recipientId)) return false;
  return isOptionalShellCount(candidate.unreadCount);
}

/**
 * True when `value` satisfies the usage trigger contract in full.
 *
 * Accepts both published usage formats: the envelope's required `source` and
 * the shell shape's optional `provider`. A `source` that is present but not a
 * known capacity reading is rejected rather than forwarded, so relaxing the
 * required field does not relax what the field means.
 */
export function isShellUsageUpdatePayload(value: unknown): value is UsageUpdatePayload {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<UsageUpdatePayload> & { source?: unknown };
  if (candidate.eventType !== USAGE_UPDATE) return false;
  if (!isActivityTimestamp(candidate.occurredAt)) return false;
  if (candidate.source !== undefined && !isShellMember(USAGE_SOURCES, candidate.source)) return false;
  return candidate.provider === undefined || isShellIdentifier(candidate.provider);
}

/** Union type for all event payloads */
export type EventPayload =
  | GoalUpdateTriggerPayload
  | TaskUpdatePayload
  | DraftUpdatePayload
  | PlanStepUpdatePayload
  | IndexingUpdatePayload
  | TaskLiveUpdatePayload
  | QueueStatsUpdatePayload
  | ActivityUpdatePayload
  | NotificationUpdatePayload
  | UsageUpdatePayload
  | GoalUpdatePayload
  | ScopedActivityUpdatePayload
  | RecipientListNotificationUpdatePayload
  | ScopedUsageUpdatePayload;
