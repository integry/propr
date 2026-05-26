import type { Job } from 'bullmq';
import type { Knex } from 'knex';
import {
  buildIssueRefFromQueueJob,
  db,
  getIssueQueue,
  getPrNumberFromJobData,
  getStateManager,
  getTaskIdFromQueueJob,
  logger,
  normalizeTaskId as normalizeCoreTaskId,
  type TaskStateData,
} from '@propr/core';

export type QueueJobData = Record<string, unknown>;

export interface TaskStateHistory {
  state: string;
  metadata?: {
    containerId?: string;
    containerName?: string;
  };
}

export interface TaskState {
  history: TaskStateHistory[];
}

export interface PersistedTaskRecord {
  taskId: string;
  jobId: string | null;
}

export interface StopTaskContext {
  normalizedTaskId: string;
  state: TaskState | null;
  currentState: string | null;
  queueJob: Job<QueueJobData> | null;
  queueState: string | null;
  taskId: string;
  abortTaskIds: string[];
}

interface StopTaskContextDeps {
  db?: typeof db;
  getIssueQueue?: typeof getIssueQueue;
  forceQueueScan?: boolean;
}

interface StopTaskStateDeps {
  db?: typeof db;
  getStateManager?: typeof getStateManager;
}

interface ResolvedPersistedTaskContext {
  persistedTask: PersistedTaskRecord | null;
  queueJob: Job<QueueJobData> | null;
  queueTaskId: string | null;
}

type RedisClientLike = {
  get: (key: string) => Promise<string | null>;
};
type IssueQueue = Awaited<ReturnType<typeof getIssueQueue>>;

const TRACKED_QUEUE_STATES = ['waiting', 'active', 'delayed', 'paused', 'prioritized', 'waiting-children'] as const;
const STOP_TASK_QUEUE_SCAN_PAGE_SIZE = 1000;
const STOP_TASK_QUEUE_SCAN_MAX_JOBS = 20000;

export function normalizeTaskId(jobId: string): string {
  return normalizeCoreTaskId(jobId);
}

export async function loadStopTaskContext(
  taskReference: string,
  redisClient: RedisClientLike,
  deps: StopTaskContextDeps,
): Promise<StopTaskContext> {
  const normalizedTaskId = normalizeTaskId(taskReference);
  const directStateLookup = await loadTaskState(redisClient, [normalizedTaskId, taskReference]);
  const { persistedTask, queueJob, queueTaskId } = await resolvePersistedTaskContextBestEffort({
    taskReference,
    normalizedTaskId,
    deps,
    extraCandidates: directStateLookup.taskId ? [directStateLookup.taskId] : [],
    hasDirectState: directStateLookup.state !== null,
  });
  const stateLookup = await loadTaskState(redisClient, [
    directStateLookup.taskId,
    persistedTask?.taskId,
    queueTaskId,
    normalizedTaskId,
    taskReference,
    persistedTask?.jobId,
  ]);

  logger.debug({
    taskReference,
    normalizedTaskId,
    persistedTaskId: persistedTask?.taskId ?? null,
    persistedJobId: persistedTask?.jobId ?? null,
    queueTaskId,
  }, 'Loading task stop context');

  const state = stateLookup.state ?? directStateLookup.state;
  const currentState = state?.history[state.history.length - 1]?.state ?? null;
  const queueState = queueJob ? await queueJob.getState() : null;
  const taskId = resolveStopTaskId(normalizedTaskId, queueTaskId, persistedTask?.taskId ?? stateLookup.taskId ?? directStateLookup.taskId);
  const abortTaskIds = buildAbortTaskIds({
    taskId,
    normalizedTaskId,
    queueTaskId,
    queueJob,
    persistedJobId: persistedTask?.jobId ?? null,
  });

  return {
    normalizedTaskId,
    state,
    currentState,
    queueJob,
    queueState,
    taskId,
    abortTaskIds,
  };
}

export async function ensureTaskStateForCancellation(
  taskId: string,
  state: TaskState | null,
  queueJob: Job<QueueJobData> | null,
  deps: StopTaskStateDeps,
): Promise<TaskState | null> {
  if (state || !queueJob) {
    return state;
  }

  return createCancellationTaskStateFromQueueJob(taskId, queueJob, deps);
}

async function findPersistedTaskRecord(
  taskReference: string,
  normalizedTaskId: string,
  database: typeof db,
  extraCandidates: string[] = [],
): Promise<PersistedTaskRecord | null> {
  const lookupCandidates = [
    { column: 'task_id', value: taskReference },
    { column: 'task_id', value: normalizedTaskId },
    { column: 'job_id', value: taskReference },
    { column: 'job_id', value: normalizedTaskId },
    ...extraCandidates.flatMap((value) => [
      { column: 'task_id', value },
      { column: 'job_id', value },
    ]),
  ];
  const lookupValues = [...new Set(lookupCandidates
    .map((candidate) => candidate.value)
    .filter((value): value is string => Boolean(value)))];

  if (lookupValues.length === 0) {
    return null;
  }

  const records = await database('tasks')
    .select('task_id', 'job_id')
    .where((queryBuilder: Knex.QueryBuilder) => {
      queryBuilder.whereIn('task_id', lookupValues).orWhereIn('job_id', lookupValues);
    }) as unknown as Array<{
    task_id: string;
    job_id: string | null;
  }>;

  for (const candidate of lookupCandidates) {
    if (!candidate.value) {
      continue;
    }

    const record = records.find((row) => row[candidate.column as 'task_id' | 'job_id'] === candidate.value);
    if (record) {
      return {
        taskId: record.task_id,
        jobId: record.job_id,
      };
    }
  }

  return null;
}

async function resolvePersistedTaskContext(
  taskReference: string,
  normalizedTaskId: string,
  deps: StopTaskContextDeps,
  extraCandidates: string[] = [],
): Promise<ResolvedPersistedTaskContext> {
  const database = deps.db ?? db;
  let persistedTask = await findPersistedTaskRecord(taskReference, normalizedTaskId, database, extraCandidates);
  const queueJob = await getQueueJob({
    candidateTaskIds: [
      taskReference,
      normalizedTaskId,
      ...extraCandidates,
      persistedTask?.jobId,
      persistedTask?.taskId,
    ].filter((value): value is string => Boolean(value)),
    loadQueue: deps.getIssueQueue,
    forceQueueScan: deps.forceQueueScan === true,
  });
  const queueTaskId = queueJob ? getTaskIdFromQueueJob(queueJob) : null;

  if (!persistedTask && queueTaskId) {
    persistedTask = await findPersistedTaskRecord(taskReference, normalizedTaskId, database, [queueTaskId, ...extraCandidates]);
  }

  return {
    persistedTask,
    queueJob,
    queueTaskId,
  };
}

async function resolvePersistedTaskContextBestEffort(params: {
  taskReference: string;
  normalizedTaskId: string;
  deps: StopTaskContextDeps;
  extraCandidates: string[];
  hasDirectState: boolean;
}): Promise<ResolvedPersistedTaskContext> {
  const { taskReference, normalizedTaskId, deps, extraCandidates, hasDirectState } = params;
  try {
    return await resolvePersistedTaskContext(taskReference, normalizedTaskId, deps, extraCandidates);
  } catch (error) {
    if (!hasDirectState) {
      throw error;
    }

    logger.warn({
      taskReference,
      normalizedTaskId,
      error: (error as Error).message,
    }, 'Continuing stop lookup with direct worker state after persisted or queue context lookup failed');
    return {
      persistedTask: null,
      queueJob: null,
      queueTaskId: null,
    };
  }
}

async function loadTaskState(
  redisClient: RedisClientLike,
  candidateTaskIds: Array<string | null | undefined>,
): Promise<{ state: TaskState | null; taskId: string | null }> {
  for (const candidateTaskId of candidateTaskIds) {
    if (!candidateTaskId) {
      continue;
    }

    const stateData = await redisClient.get(`worker:state:${candidateTaskId}`);
    if (!stateData) {
      continue;
    }

    try {
      return {
        state: JSON.parse(stateData) as TaskState,
        taskId: candidateTaskId,
      };
    } catch (error) {
      logger.warn({
        taskId: candidateTaskId,
        error: (error as Error).message,
      }, 'Ignoring malformed worker task state during stop lookup');
    }
  }

  return { state: null, taskId: null };
}

async function getQueueJob(params: {
  candidateTaskIds: string[];
  loadQueue?: typeof getIssueQueue;
  forceQueueScan: boolean;
}): Promise<Job<QueueJobData> | null> {
  const {
    candidateTaskIds,
    loadQueue = getIssueQueue,
    forceQueueScan,
  } = params;
  const queue = await loadQueue();
  const uniqueCandidates = [...new Set(candidateTaskIds.filter((value): value is string => Boolean(value)))];
  const directJob = await getDirectQueueJob(queue, uniqueCandidates);
  if (directJob) {
    return directJob;
  }

  if (!forceQueueScan || typeof queue.getJobs !== 'function') {
    return null;
  }

  if (uniqueCandidates.length === 0) {
    return null;
  }

  return scanQueueForMatchingJob(queue, new Set(uniqueCandidates), uniqueCandidates);
}

async function getDirectQueueJob(queue: IssueQueue, candidateTaskIds: string[]): Promise<Job<QueueJobData> | null> {
  for (const candidateTaskId of candidateTaskIds) {
    const job = await queue.getJob(candidateTaskId) as unknown as Job<QueueJobData> | undefined;
    if (job) {
      return job;
    }
  }

  return null;
}

async function scanQueueForMatchingJob(
  queue: IssueQueue,
  candidateTaskIdSet: Set<string>,
  uniqueCandidates: string[],
): Promise<Job<QueueJobData> | null> {
  let scannedJobs = 0;
  for (const trackedQueueState of TRACKED_QUEUE_STATES) {
    let start = 0;
    let jobs = await queue.getJobs([trackedQueueState], start, start + STOP_TASK_QUEUE_SCAN_PAGE_SIZE - 1) as unknown as Job<QueueJobData>[];
    while (jobs.length > 0) {
      scannedJobs += jobs.length;
      const matchedJob = findMatchingQueueJob(jobs, candidateTaskIdSet);
      if (matchedJob) {
        logger.info({
          taskReferenceCandidates: uniqueCandidates,
          queueJobId: matchedJob.rawJobId,
          derivedTaskId: matchedJob.derivedTaskId,
          scannedJobs,
        }, 'Resolved queued task stop lookup via fallback task-id scan');
        return matchedJob.job;
      }

      if (jobs.length < STOP_TASK_QUEUE_SCAN_PAGE_SIZE) {
        break;
      }
      if (scannedJobs >= STOP_TASK_QUEUE_SCAN_MAX_JOBS) {
        logger.warn({
          taskReferenceCandidates: uniqueCandidates,
          scannedJobs,
          maxJobs: STOP_TASK_QUEUE_SCAN_MAX_JOBS,
        }, 'Stopping queued task fallback scan after reaching scan limit');
        return null;
      }
      start += jobs.length;
      jobs = await queue.getJobs([trackedQueueState], start, start + STOP_TASK_QUEUE_SCAN_PAGE_SIZE - 1) as unknown as Job<QueueJobData>[];
    }
  }

  return null;
}

function findMatchingQueueJob(
  jobs: Job<QueueJobData>[],
  candidateTaskIdSet: Set<string>,
): { job: Job<QueueJobData>; rawJobId: string | null; derivedTaskId: string | null } | null {
  for (const job of jobs) {
    const derivedTaskId = getTaskIdFromQueueJob(job);
    const rawJobId = job.id === null || job.id === undefined ? null : String(job.id);
    const normalizedJobId = rawJobId === null ? null : normalizeTaskId(rawJobId);
    if (
      (derivedTaskId !== null && candidateTaskIdSet.has(derivedTaskId))
      || (rawJobId !== null && candidateTaskIdSet.has(rawJobId))
      || (normalizedJobId !== null && candidateTaskIdSet.has(normalizedJobId))
    ) {
      return { job, rawJobId, derivedTaskId };
    }
  }

  return null;
}

// Queue-only jobs have no worker state yet. Create the minimal task record and
// state required for a durable cancellation before reporting stop success.
async function createCancellationTaskStateFromQueueJob(
  taskId: string,
  queueJob: Job<QueueJobData>,
  deps: StopTaskStateDeps = {},
): Promise<TaskStateData> {
  const issueRef = buildIssueRefFromQueueJob(queueJob);
  if (!issueRef) {
    throw new Error(`Cannot reconstruct IssueRef for queued task cancellation: ${String(queueJob.id ?? taskId)}`);
  }

  const database = deps.db ?? db;
  const stateManager = (deps.getStateManager ?? getStateManager)();
  const correlationId = typeof queueJob.data.correlationId === 'string' ? queueJob.data.correlationId : null;
  const initialJobData = JSON.stringify(queueJob.data);
  const repository = `${issueRef.repoOwner}/${issueRef.repoName}`;
  const prNumber = getPrNumberFromJobData(queueJob.data);
  const queueJobId = String(queueJob.id ?? taskId);

  await database('tasks')
    .insert({
      task_id: taskId,
      job_id: queueJobId,
      correlation_id: correlationId,
      repository,
      issue_number: issueRef.number,
      task_type: typeof issueRef.type === 'string' && issueRef.type.length > 0 ? issueRef.type : prNumber !== null ? 'pr' : 'issue',
      model_name: typeof issueRef.modelName === 'string' ? issueRef.modelName : null,
      initial_job_data: initialJobData,
      ...(prNumber !== null ? { pr_number: prNumber } : {}),
    })
    .onConflict('task_id')
    .ignore();

  const existingState = await stateManager.getTaskState(taskId);
  const taskState = existingState ?? await stateManager.createTaskState(taskId, issueRef, correlationId);

  await database('tasks')
    .where({ task_id: taskId })
    .andWhere((queryBuilder: Knex.QueryBuilder) => {
      queryBuilder.whereNull('job_id').orWhere('job_id', queueJobId);
    })
    .update({
      job_id: queueJobId,
      ...(prNumber !== null ? { pr_number: prNumber } : {}),
    });

  return taskState;
}

function resolveStopTaskId(
  normalizedTaskId: string,
  queueTaskId: string | null,
  persistedTaskId: string | null,
): string {
  return persistedTaskId ?? queueTaskId ?? normalizedTaskId;
}

function buildAbortTaskIds(params: {
  taskId: string;
  normalizedTaskId: string;
  queueTaskId: string | null;
  queueJob: Job<QueueJobData> | null;
  persistedJobId: string | null;
}): string[] {
  const { taskId, normalizedTaskId, queueTaskId, queueJob, persistedJobId } = params;
  const queueJobId = queueJob?.id ? String(queueJob.id) : null;
  return [...new Set([taskId, normalizedTaskId, queueTaskId, queueJobId, persistedJobId].filter((value): value is string => Boolean(value)))];
}
