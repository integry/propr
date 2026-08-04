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
  /** Durable repository status-transition time; unlike repositories.updated_at it is indexing-specific. */
  transitionAt?: string;
  /** Stable identity for one indexing run, shared by progress and terminal publications. */
  runId?: string;
  timestamp: string;
}

export type ProjectionEventPayload =
  | TaskUpdatePayload
  | DraftUpdatePayload
  | IndexingUpdatePayload;

const STEP_STATUSES = new Set<StepStatus>(['pending', 'in_progress', 'completed', 'failed']);
const DRAFT_STATUSES = new Set<DraftStatus>([
  'draft', 'generating', 'refining', 'review', 'approved', 'executed',
  'executing', 'pr_created', 'merged', 'failed'
]);
const INDEXING_PHASES = new Set<IndexingPhase>([
  'indexing', 'files', 'directories', 'completed', 'failed', 'idle'
]);
const TASK_UPDATE_STATES = new Set([
  'pending', 'processing', 'claude_execution', 'post_processing',
  'completed', 'failed', 'cancelled'
]);

function eventRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('event payload must be an object');
  }
  return value as Record<string, unknown>;
}

function requiredEventString(
  payload: Record<string, unknown>,
  field: string
): string {
  const value = payload[field];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`event payload ${field} must be a non-blank string`);
  }
  return value;
}

function optionalEventString(payload: Record<string, unknown>, field: string): void {
  if (payload[field] !== undefined) requiredEventString(payload, field);
}

function optionalEventNumber(
  payload: Record<string, unknown>,
  field: string,
  integer = false
): void {
  const value = payload[field];
  if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value)
      || (integer && !Number.isSafeInteger(value)))) {
    throw new TypeError(`event payload ${field} must be a finite${integer ? ' integer' : ''}`);
  }
}

function optionalEventRecord(payload: Record<string, unknown>, field: string): void {
  const value = payload[field];
  if (value !== undefined && (typeof value !== 'object' || value === null
      || Array.isArray(value))) {
    throw new TypeError(`event payload ${field} must be an object`);
  }
}

function requiredEventTimestamp(payload: Record<string, unknown>, field: string): void {
  const value = requiredEventString(payload, field);
  if (!Number.isFinite(Date.parse(value))) {
    throw new TypeError(`event payload ${field} must be a valid timestamp`);
  }
}

function validateTaskUpdatePayload(payload: Record<string, unknown>): TaskUpdatePayload {
  requiredEventString(payload, 'taskId');
  if (!TASK_UPDATE_STATES.has(requiredEventString(payload, 'state'))) {
    throw new TypeError('event payload state is not a supported task state');
  }
  requiredEventTimestamp(payload, 'timestamp');
  if (payload.previousState !== undefined
      && !TASK_UPDATE_STATES.has(requiredEventString(payload, 'previousState'))) {
    throw new TypeError('event payload previousState is not a supported task state');
  }
  optionalEventString(payload, 'repository');
  optionalEventNumber(payload, 'issueNumber', true);
  if (typeof payload.issueNumber === 'number' && payload.issueNumber <= 0) {
    throw new TypeError('event payload issueNumber must be a positive integer');
  }
  optionalEventRecord(payload, 'metadata');
  return payload as unknown as TaskUpdatePayload;
}

function validateDraftUpdatePayload(payload: Record<string, unknown>): DraftUpdatePayload {
  requiredEventString(payload, 'draftId');
  requiredEventString(payload, 'step');
  requiredEventTimestamp(payload, 'timestamp');
  if (!STEP_STATUSES.has(payload.status as StepStatus)) {
    throw new TypeError('event payload status is not a supported step status');
  }
  optionalEventString(payload, 'runId');
  optionalEventRecord(payload, 'data');
  if (payload.draftStatus !== undefined
      && !DRAFT_STATUSES.has(payload.draftStatus as DraftStatus)) {
    throw new TypeError('event payload draftStatus is not supported');
  }
  if (payload.generationTrace !== undefined) {
    const trace = eventRecord(payload.generationTrace);
    if (!Array.isArray(trace.steps)) {
      throw new TypeError('event payload generationTrace.steps must be an array');
    }
    for (const stepValue of trace.steps) {
      const step = eventRecord(stepValue);
      requiredEventString(step, 'name');
      if (!STEP_STATUSES.has(step.status as StepStatus)) {
        throw new TypeError('event payload generation trace status is not supported');
      }
      optionalEventRecord(step, 'data');
    }
    optionalEventString(trace, 'runId');
    optionalEventString(trace, 'error');
    optionalEventString(trace, 'failedAt');
  }
  return payload as unknown as DraftUpdatePayload;
}

function validateIndexingUpdatePayload(payload: Record<string, unknown>): IndexingUpdatePayload {
  requiredEventString(payload, 'repository');
  requiredEventTimestamp(payload, 'timestamp');
  if (!INDEXING_PHASES.has(payload.phase as IndexingPhase)) {
    throw new TypeError('event payload phase is not a supported indexing phase');
  }
  optionalEventString(payload, 'branch');
  if (payload.transitionAt !== undefined) requiredEventTimestamp(payload, 'transitionAt');
  optionalEventString(payload, 'runId');
  optionalEventNumber(payload, 'progress');
  if (typeof payload.progress === 'number'
      && (payload.progress < 0 || payload.progress > 100)) {
    throw new TypeError('event payload progress must be between 0 and 100');
  }
  for (const field of [
    'totalFiles', 'processedFiles', 'totalDirectories', 'processedDirectories'
  ]) {
    optionalEventNumber(payload, field, true);
    if (typeof payload[field] === 'number' && payload[field] < 0) {
      throw new TypeError(`event payload ${field} must be a non-negative integer`);
    }
  }
  if (typeof payload.processedFiles === 'number' && typeof payload.totalFiles === 'number'
      && payload.processedFiles > payload.totalFiles) {
    throw new TypeError('event payload processedFiles cannot exceed totalFiles');
  }
  if (typeof payload.processedDirectories === 'number'
      && typeof payload.totalDirectories === 'number'
      && payload.processedDirectories > payload.totalDirectories) {
    throw new TypeError('event payload processedDirectories cannot exceed totalDirectories');
  }
  return payload as unknown as IndexingUpdatePayload;
}

/** Runtime schema for durable projection payloads crossing the JSON boundary. */
export function parseProjectionEventPayload(value: unknown): ProjectionEventPayload {
  const payload = eventRecord(value);
  switch (payload.eventType) {
    case TASK_UPDATE: return validateTaskUpdatePayload(payload);
    case DRAFT_UPDATE: return validateDraftUpdatePayload(payload);
    case INDEXING_UPDATE: return validateIndexingUpdatePayload(payload);
    default: throw new TypeError('event payload eventType is not a projection event');
  }
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
  /** Distinguishes observable work from a merely alive child process. */
  activityKind?: 'progress' | 'process_liveness';
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
