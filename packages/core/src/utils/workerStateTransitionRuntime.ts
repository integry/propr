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
} from './workerStateTransitionPersistence.js';
import {
  TaskStates,
  type IssueRef,
  type TaskState,
  type TaskStateData,
  type UpdateMetadata,
} from './workerStateManager.types.js';

type WorkerStateRedis = InstanceType<typeof Redis>;

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

function resolveTransitionKey(input: {
  state: TaskStateData;
  taskId: string;
  newState: TaskState;
  metadata: UpdateMetadata;
  fingerprint: string;
}): string {
  const { state, taskId, newState, metadata, fingerprint } = input;
  if (state.currentTransitionFingerprint === fingerprint && state.currentTransitionKey) {
    return state.currentTransitionKey;
  }
  return buildTaskTransitionKey(
    taskId,
    currentTaskTransitionKey(state),
    newState,
    metadata
  );
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
  const correlatedLogger = logger.withCorrelation(state.correlationId);
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
    const persistedAt = persisted.history.timestamp;
    state = {
      ...state,
      issueRef: parseIssueRef(persisted.task.initial_job_data) ?? input.issueRef,
      correlationId: typeof persisted.task.correlation_id === 'string'
        ? persisted.task.correlation_id : state.correlationId,
      createdAt: persistedAt,
      updatedAt: persistedAt,
      history: [{
        state: TaskStates.PENDING,
        timestamp: persistedAt,
        reason: persisted.history.reason ?? 'Task created',
        transitionKey,
      }],
    };
  } catch (error) {
    correlatedLogger.error({ error: (error as Error).message, taskId: input.taskId },
      'Failed to persist task state to database');
    throw error;
  }
  await input.redis.setex(input.key, input.stateExpiry, JSON.stringify(state));
  correlatedLogger.info({
    taskId: input.taskId,
    issueNumber: state.issueRef.number,
    repository: repositoryFor(state.issueRef),
    state: TaskStates.PENDING,
  }, 'Task state created');
  await publishCreation(state, transitionSequence, correlatedLogger);
  return state;
}

export async function updateDurableTaskState(
  input: UpdateTaskRuntimeInput
): Promise<TaskStateData> {
  const stateJson = await input.redis.get(input.key);
  if (!stateJson) throw new Error(`Task state not found for taskId: ${input.taskId}`);
  const state = JSON.parse(stateJson) as TaskStateData;
  const previousState = state.state;
  const reason = input.metadata.reason ?? `State changed from ${previousState}`;
  const attempts = input.metadata.isRetry ? state.attempts + 1 : state.attempts;
  const fingerprint = buildTaskTransitionFingerprint(
    input.taskId,
    input.newState,
    input.metadata
  );
  const transitionKey = resolveTransitionKey({
    state,
    taskId: input.taskId,
    newState: input.newState,
    metadata: input.metadata,
    fingerprint,
  });
  const generatedAt = new Date().toISOString();
  const historyMetadata = buildHistoryMetadata(input.metadata, input.newState, generatedAt);
  const correlatedLogger = logger.withCorrelation(state.correlationId);
  let transitionSequence: number;
  let transitionAt: string;
  let persistedPreviousState = previousState;
  let persistedAttempts = attempts;
  let persistedMetadata: Record<string, unknown> = {};
  try {
    const persisted = await persistTaskTransition({
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
    if (persisted.state !== input.newState) {
      throw new Error('Task transition idempotency key resolved to a different state');
    }
    if (persistedMetadata.transitionFingerprint !== fingerprint) {
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
  const alreadyApplied = state.currentTransitionKey === transitionKey
    || state.history.some(entry => entry.transitionKey === transitionKey);
  if (!alreadyApplied) {
    state.state = input.newState;
    state.updatedAt = transitionAt;
    state.attempts = persistedAttempts;
    state.currentTransitionKey = transitionKey;
    state.currentTransitionFingerprint = fingerprint;
    if (input.metadata.error) {
      state.lastError = {
        message: input.metadata.error.message,
        category: input.metadata.error.category ?? 'unknown',
        timestamp: transitionAt,
      };
    }
    if (input.metadata.worktreeInfo) state.worktreeInfo = input.metadata.worktreeInfo;
    if (input.metadata.claudeResult) state.claudeResult = input.metadata.claudeResult;
    if (input.metadata.prResult) state.prResult = input.metadata.prResult;
    state.history.push({
      state: input.newState,
      timestamp: transitionAt,
      reason,
      metadata: {
        ...historyMetadata,
        ...(typeof persistedMetadata.cancelledAt === 'string'
          ? { cancelledAt: persistedMetadata.cancelledAt }
          : {}),
      },
      transitionKey,
    });
    await input.redis.setex(input.key, input.stateExpiry, JSON.stringify(state));
  }
  correlatedLogger.info({
    taskId: input.taskId,
    issueNumber: state.issueRef.number,
    repository: repositoryFor(state.issueRef),
    previousState: persistedPreviousState,
    newState: input.newState,
    attempts: persistedAttempts,
  }, 'Task state updated');
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
