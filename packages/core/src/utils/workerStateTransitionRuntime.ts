import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import { db } from '../db/connection.js';
import { getEventPublisher } from './eventPublisher.js';
import logger, { generateCorrelationId } from './logger.js';
import { buildPublishedTaskMetadata } from './workerStateNotificationPersistence.js';
import {
  buildTaskTransitionFingerprint,
  buildTaskTransitionKey,
  currentTaskTransitionKey,
  persistTaskCreation,
  persistTaskTransition,
  taskCreationTransitionKey,
  type DurableTaskHistoryRow,
  type PersistedTaskTransition,
} from './workerStateTransitionPersistence.js';
import {
  TaskStates,
  type IssueRef,
  type TaskState,
  type TaskStateData,
  type UpdateMetadata,
} from './workerStateManager.types.js';

type WorkerStateRedis = InstanceType<typeof Redis>;
const REDIS_STATE_CAS_SCRIPT = `
local current = redis.call('GET', KEYS[1])
if current then
  local decoded_ok, decoded = pcall(cjson.decode, current)
  if decoded_ok and type(decoded) == 'table' then
    local current_sequence = tonumber(decoded.currentTransitionSequence)
    if current_sequence and current_sequence > tonumber(ARGV[1]) then
      return {0, current}
    end
  end
end
redis.call('SETEX', KEYS[1], ARGV[2], ARGV[3])
return {1, ARGV[3]}
`;

interface TransitionRuntimeInput {
  redis: WorkerStateRedis;
  key: string;
  stateExpiry: number;
  taskId: string;
}

interface CreateTaskRuntimeInput extends TransitionRuntimeInput {
  issueRef: IssueRef;
  correlationId: string | null;
}

interface UpdateTaskRuntimeInput extends TransitionRuntimeInput {
  newState: TaskState;
  metadata: UpdateMetadata;
}

function parseRecord(value: unknown): Record<string, unknown> {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== 'string') return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function parseIssueRef(value: unknown): IssueRef | undefined {
  const candidate = parseRecord(value);
  return typeof candidate.number === 'number'
    && typeof candidate.repoOwner === 'string'
    && typeof candidate.repoName === 'string'
    ? candidate as unknown as IssueRef
    : undefined;
}

function repositoryFor(issueRef: IssueRef): string {
  return `${issueRef.repoOwner ?? 'unknown'}/${issueRef.repoName ?? 'unknown'}`;
}

function durableTransitionState(value: unknown, fallback: TaskState): TaskState {
  return Object.values(TaskStates).includes(value as TaskState) ? value as TaskState : fallback;
}

function durableAttempts(value: unknown, fallback: number): number {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : fallback;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function applyDurableMetadata(
  state: TaskStateData,
  metadata: Record<string, unknown>,
  transitionAt: string
): void {
  const error = recordValue(metadata.error);
  if (typeof error?.message === 'string') {
    state.lastError = {
      message: error.message,
      category: typeof error.category === 'string' ? error.category : 'unknown',
      timestamp: transitionAt,
    };
  }
  const worktreeInfo = recordValue(metadata.worktreeInfo);
  if (worktreeInfo) state.worktreeInfo = worktreeInfo;
  const claudeResult = recordValue(metadata.claudeResult);
  if (claudeResult) {
    state.claudeResult = claudeResult as unknown as TaskStateData['claudeResult'];
  }
  const prResult = recordValue(metadata.prResult);
  if (prResult) state.prResult = prResult;
}

function reconstructDurableState(
  initial: TaskStateData,
  histories: DurableTaskHistoryRow[]
): TaskStateData {
  if (histories.length === 0) return initial;
  const state = { ...initial, history: [] as TaskStateData['history'] };
  for (const row of histories) {
    const metadata = parseRecord(row.metadata);
    const transitionState = durableTransitionState(row.state, state.state);
    state.history.push({
      state: transitionState,
      timestamp: row.timestamp,
      reason: row.reason ?? `Task entered ${transitionState}`,
      metadata,
      transitionKey: row.transition_key,
    });
    state.state = transitionState;
    state.updatedAt = row.timestamp;
    state.attempts = durableAttempts(metadata.attempts, state.attempts);
    state.currentTransitionKey = row.transition_key;
    state.currentTransitionSequence = row.history_id;
    if (typeof metadata.transitionFingerprint === 'string') {
      state.currentTransitionFingerprint = metadata.transitionFingerprint;
    }
    applyDurableMetadata(state, metadata, row.timestamp);
  }
  state.createdAt = histories[0].timestamp;
  return state;
}

async function writeTaskStateProjection(
  input: TransitionRuntimeInput,
  state: TaskStateData,
  transitionSequence: number
): Promise<TaskStateData> {
  state.currentTransitionSequence = transitionSequence;
  const serialized = JSON.stringify(state);
  // Test doubles and rolling-upgrade adapters may only implement SETEX. Real
  // ioredis clients use the monotonic compare-and-set script below.
  if (typeof input.redis.eval !== 'function') {
    await input.redis.setex(input.key, input.stateExpiry, serialized);
    return state;
  }
  const result = await input.redis.eval(
    REDIS_STATE_CAS_SCRIPT,
    1,
    input.key,
    String(transitionSequence),
    String(input.stateExpiry),
    serialized
  );
  if (!Array.isArray(result) || result.length < 2) {
    throw new Error('Task state compare-and-set returned an invalid result');
  }
  const stored = String(result[1]);
  return JSON.parse(stored) as TaskStateData;
}

function buildHistoryMetadata(
  metadata: UpdateMetadata,
  newState: TaskState,
  generatedAt: string
): Record<string, unknown> {
  const historyMetadata = { ...(metadata.historyMetadata ?? {}) };
  if (newState === TaskStates.CANCELLED
      && typeof metadata.historyMetadata?.cancelledAt !== 'string') {
    historyMetadata.cancelledAt = generatedAt;
  }
  return historyMetadata;
}

async function publishCreation(
  state: TaskStateData,
  transitionSequence: number,
  correlatedLogger: Logger
): Promise<void> {
  try {
    await getEventPublisher().publishTaskUpdate({
      taskId: state.taskId,
      state: TaskStates.PENDING,
      repository: repositoryFor(state.issueRef),
      issueNumber: state.issueRef.number,
      metadata: { transitionSequence },
      timestamp: state.createdAt,
    });
  } catch (error) {
    correlatedLogger.warn({ error: (error as Error).message, taskId: state.taskId },
      'Failed to publish durable task creation update');
  }
}

export async function createDurableTaskState(
  input: CreateTaskRuntimeInput
): Promise<TaskStateData> {
  const transitionAt = new Date().toISOString();
  const transitionKey = taskCreationTransitionKey(input.taskId);
  let state: TaskStateData = {
    taskId: input.taskId,
    issueRef: input.issueRef,
    correlationId: input.correlationId ?? generateCorrelationId(),
    state: TaskStates.PENDING,
    createdAt: transitionAt,
    updatedAt: transitionAt,
    attempts: 0,
    history: [{
      state: TaskStates.PENDING,
      timestamp: transitionAt,
      reason: 'Task created',
      transitionKey,
    }],
    currentTransitionKey: transitionKey,
  };
  let correlatedLogger = logger.withCorrelation(state.correlationId);
  let transitionSequence: number;
  try {
    const persisted = await persistTaskCreation({
      database: db,
      taskId: input.taskId,
      transitionKey,
      fallbackTimestamp: transitionAt,
      taskData: {
        task_id: input.taskId,
        job_id: null,
        correlation_id: state.correlationId,
        repository: repositoryFor(input.issueRef),
        issue_number: input.issueRef.number,
        task_type: input.issueRef.type ?? 'issue',
        model_name: input.issueRef.modelName ?? null,
        created_at: transitionAt,
        initial_job_data: JSON.stringify(input.issueRef),
      },
      historyData: {
        task_id: input.taskId,
        state: TaskStates.PENDING,
        timestamp: transitionAt,
        reason: 'Task created',
        metadata: JSON.stringify({}),
      },
    });
    transitionSequence = persisted.history.history_id;
    state = {
      ...state,
      issueRef: parseIssueRef(persisted.task.initial_job_data) ?? input.issueRef,
      correlationId: typeof persisted.task.correlation_id === 'string'
        ? persisted.task.correlation_id : state.correlationId,
    };
    state = reconstructDurableState(state, persisted.histories);
    transitionSequence = state.currentTransitionSequence ?? transitionSequence;
    correlatedLogger = logger.withCorrelation(state.correlationId);
  } catch (error) {
    correlatedLogger.error({ error: (error as Error).message, taskId: input.taskId },
      'Failed to persist task state to database');
    throw error;
  }
  state = await writeTaskStateProjection(input, state, transitionSequence);
  correlatedLogger.info({
    taskId: input.taskId,
    issueNumber: state.issueRef.number,
    repository: repositoryFor(state.issueRef),
    state: state.state,
  }, 'Task state created');
  if (state.state === TaskStates.PENDING && state.history.length === 1) {
    await publishCreation(state, transitionSequence, correlatedLogger);
  }
  return state;
}

export async function updateDurableTaskState(
  input: UpdateTaskRuntimeInput
): Promise<TaskStateData> {
  const stateJson = await input.redis.get(input.key);
  if (!stateJson) throw new Error(`Task state not found for taskId: ${input.taskId}`);
  let state = JSON.parse(stateJson) as TaskStateData;
  const previousState = state.state;
  const reason = input.metadata.reason ?? `State changed from ${previousState}`;
  const attempts = input.metadata.isRetry ? state.attempts + 1 : state.attempts;
  const fingerprint = buildTaskTransitionFingerprint(
    input.taskId,
    input.newState,
    input.metadata
  );
  const transitionKey = buildTaskTransitionKey(
    input.taskId,
    currentTaskTransitionKey(state),
    input.newState,
    input.metadata
  );
  const generatedAt = new Date().toISOString();
  const historyMetadata = buildHistoryMetadata(input.metadata, input.newState, generatedAt);
  const correlatedLogger = logger.withCorrelation(state.correlationId);
  let transitionSequence: number;
  let transitionAt: string;
  let persistedPreviousState = previousState;
  let persistedAttempts = attempts;
  let persistedMetadata: Record<string, unknown> = {};
  let persisted: PersistedTaskTransition;
  try {
    persisted = await persistTaskTransition({
      database: db,
      taskId: input.taskId,
      transitionKey,
      fallbackTimestamp: generatedAt,
      historyData: {
        task_id: input.taskId,
        state: input.newState,
        timestamp: generatedAt,
        reason,
        metadata: JSON.stringify({
          ...historyMetadata,
          previousState,
          attempts,
          error: input.metadata.error,
          worktreeInfo: input.metadata.worktreeInfo,
          claudeResult: input.metadata.claudeResult,
          prResult: input.metadata.prResult,
          commitHash: input.metadata.commitHash,
          transitionFingerprint: fingerprint,
        }),
      },
    });
    persistedMetadata = parseRecord(persisted.metadata);
    if (persisted.applied && persisted.state !== input.newState) {
      throw new Error('Task transition idempotency key resolved to a different state');
    }
    if (persisted.applied && persistedMetadata.transitionFingerprint !== fingerprint) {
      throw new Error('Task transition idempotency key resolved to different metadata');
    }
    transitionSequence = persisted.history_id;
    transitionAt = persisted.timestamp;
    persistedPreviousState = durableTransitionState(
      persistedMetadata.previousState,
      previousState
    );
    persistedAttempts = durableAttempts(persistedMetadata.attempts, attempts);
  } catch (error) {
    correlatedLogger.error({ error: (error as Error).message, taskId: input.taskId },
      'Failed to persist task state update to database');
    throw error;
  }
  const durableState = durableTransitionState(persisted.state, input.newState);
  const durableTransitionKey = persisted.transition_key;
  const alreadyApplied = state.currentTransitionKey === durableTransitionKey
    || state.history.some(entry => entry.transitionKey === durableTransitionKey);
  if (!alreadyApplied) {
    state.state = durableState;
    state.updatedAt = transitionAt;
    state.attempts = persistedAttempts;
    state.currentTransitionKey = durableTransitionKey;
    state.currentTransitionFingerprint = typeof persistedMetadata.transitionFingerprint === 'string'
      ? persistedMetadata.transitionFingerprint
      : undefined;
    applyDurableMetadata(state, persistedMetadata, transitionAt);
    state.history.push({
      state: durableState,
      timestamp: transitionAt,
      reason: persisted.reason ?? reason,
      metadata: persistedMetadata,
      transitionKey: durableTransitionKey,
    });
  }
  state = await writeTaskStateProjection(input, state, transitionSequence);
  correlatedLogger.info({
    taskId: input.taskId,
    issueNumber: state.issueRef.number,
    repository: repositoryFor(state.issueRef),
    previousState: persistedPreviousState,
    newState: durableState,
    attempts: persistedAttempts,
  }, 'Task state updated');
  if (!persisted.applied) return state;
  try {
    await getEventPublisher().publishTaskUpdate({
      taskId: input.taskId,
      state: input.newState,
      previousState: persistedPreviousState,
      repository: repositoryFor(state.issueRef),
      issueNumber: state.issueRef.number,
      metadata: buildPublishedTaskMetadata(
        state.issueRef.number,
        persistedAttempts,
        input.metadata,
        transitionSequence
      ),
      timestamp: transitionAt,
    });
  } catch (error) {
    correlatedLogger.warn({ error: (error as Error).message, taskId: input.taskId },
      'Failed to publish durable task state update');
  }
  return state;
}
