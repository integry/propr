import type { Job } from 'bullmq';
import {
  buildIssueRefFromQueueJob,
  db,
  getPendingPrQueueJobs,
  getIssueQueue,
  getPrNumberFromJobData,
  getTrackedPrQueueJobs,
  getStateManager,
  getTaskIdFromQueueJob,
  logger,
  normalizeTaskId as normalizeCoreTaskId,
  TRACKED_PR_QUEUE_STATES,
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
  repository: string | null;
  prNumber: number | null;
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

export function normalizeTaskId(jobId: string): string {
  return normalizeCoreTaskId(jobId);
}

export async function loadStopTaskContext(
  taskReference: string,
  redisClient: RedisClientLike,
  deps: StopTaskContextDeps,
): Promise<StopTaskContext> {
  const normalizedTaskId = normalizeTaskId(taskReference);
  const { persistedTask, queueJob, queueTaskId } = await resolvePersistedTaskContext(
    taskReference,
    normalizedTaskId,
    deps,
  );
  const stateLookup = await loadTaskState(redisClient, [
    persistedTask?.taskId,
    queueTaskId,
    normalizedTaskId,
    taskReference,
    persistedTask?.jobId,
  ]);

  logger.info({
    taskReference,
    normalizedTaskId,
    persistedTaskId: persistedTask?.taskId ?? null,
    persistedJobId: persistedTask?.jobId ?? null,
    queueTaskId,
  }, 'Loading task stop context');

  const state = stateLookup.state;
  const currentState = state?.history[state.history.length - 1]?.state ?? null;
  const queueState = queueJob ? await queueJob.getState() : null;
  const taskId = resolveStopTaskId(normalizedTaskId, queueTaskId, persistedTask?.taskId ?? stateLookup.taskId);
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
): Promise<void> {
  if (!state && queueJob) {
    await createTaskStateFromQueueJob(taskId, queueJob, deps);
  }
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
    .select('task_id', 'job_id', 'repository', 'pr_number')
    .whereIn('task_id', lookupValues)
    .orWhereIn('job_id', lookupValues) as Array<{
      task_id: string;
      job_id: string | null;
      repository: string | null;
      pr_number: number | null;
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
        repository: typeof record.repository === 'string' ? record.repository : null,
        prNumber: typeof record.pr_number === 'number' ? record.pr_number : null,
      };
    }
  }

  return null;
}

async function resolvePersistedTaskContext(
  taskReference: string,
  normalizedTaskId: string,
  deps: StopTaskContextDeps,
): Promise<ResolvedPersistedTaskContext> {
  const database = deps.db ?? db;
  let persistedTask = await findPersistedTaskRecord(taskReference, normalizedTaskId, database);
  const queueJob = await getQueueJob({
    candidateTaskIds: [
      taskReference,
      normalizedTaskId,
      persistedTask?.jobId,
      persistedTask?.taskId,
    ].filter((value): value is string => Boolean(value)),
    loadQueue: deps.getIssueQueue,
    repository: persistedTask?.repository ?? null,
    prNumber: persistedTask?.prNumber ?? null,
  });
  const queueTaskId = queueJob ? getTaskIdFromQueueJob(queueJob) : null;

  if (!persistedTask && queueTaskId) {
    persistedTask = await findPersistedTaskRecord(taskReference, normalizedTaskId, database, [queueTaskId]);
  }

  return {
    persistedTask,
    queueJob,
    queueTaskId,
  };
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

    return {
      state: JSON.parse(stateData) as TaskState,
      taskId: candidateTaskId,
    };
  }

  return { state: null, taskId: null };
}

async function getQueueJob(params: {
  candidateTaskIds: string[];
  loadQueue?: typeof getIssueQueue;
  repository?: string | null;
  prNumber?: number | null;
}): Promise<Job<QueueJobData> | null> {
  const {
    candidateTaskIds,
    loadQueue = getIssueQueue,
    repository = null,
    prNumber = null,
  } = params;
  const queue = await loadQueue();
  const uniqueCandidates = [...new Set(candidateTaskIds.filter((value): value is string => Boolean(value)))];
  for (const candidateTaskId of uniqueCandidates) {
    const job = await queue.getJob(candidateTaskId) as Job<QueueJobData> | undefined;
    if (job) {
      return job;
    }
  }

  const candidateTaskIdSet = new Set(uniqueCandidates);
  if (candidateTaskIdSet.size === 0) {
    return null;
  }

  if (repository && prNumber !== null) {
    const prScopedJob = await findPrScopedQueueJob({
      queue,
      repository,
      prNumber,
      candidateTaskIdSet,
      uniqueCandidates,
    });
    if (prScopedJob) {
      return prScopedJob;
    }
  }

  if (typeof queue.getJobs !== 'function') {
    return null;
  }

  const jobs = await queue.getJobs([...TRACKED_PR_QUEUE_STATES]) as unknown as Job<QueueJobData>[];
  for (const job of jobs) {
    const derivedTaskId = getTaskIdFromQueueJob(job);
    const normalizedJobId = job.id === null || job.id === undefined ? null : normalizeTaskId(String(job.id));
    if (
      (derivedTaskId && candidateTaskIdSet.has(derivedTaskId))
      || (normalizedJobId && candidateTaskIdSet.has(normalizedJobId))
    ) {
      logger.info({
        taskReferenceCandidates: uniqueCandidates,
        queueJobId: job.id === null || job.id === undefined ? null : String(job.id),
        derivedTaskId,
        queueState: await job.getState(),
      }, 'Resolved queued task stop lookup via fallback task-id scan');
      return job;
    }
  }

  return null;
}

async function findPrScopedQueueJob(params: {
  queue: Awaited<ReturnType<typeof getIssueQueue>>;
  repository: string;
  prNumber: number;
  candidateTaskIdSet: Set<string>;
  uniqueCandidates: string[];
}): Promise<Job<QueueJobData> | null> {
  const {
    queue,
    repository,
    prNumber,
    candidateTaskIdSet,
    uniqueCandidates,
  } = params;
  const indexedQueueJobs = [
    ...await getTrackedPrQueueJobs(queue as never, repository, prNumber),
    ...await getPendingPrQueueJobs(queue as never, repository, prNumber),
  ];
  const uniqueQueueJobIds = [...new Set(indexedQueueJobs.map((job) => job.jobId))];

  for (const queueJobId of uniqueQueueJobIds) {
    const job = await queue.getJob(queueJobId) as Job<QueueJobData> | undefined;
    if (!job) {
      continue;
    }

    const derivedTaskId = getTaskIdFromQueueJob(job);
    const normalizedJobId = job.id === null || job.id === undefined ? null : normalizeTaskId(String(job.id));
    if (
      (derivedTaskId && candidateTaskIdSet.has(derivedTaskId))
      || (normalizedJobId && candidateTaskIdSet.has(normalizedJobId))
    ) {
      logger.info({
        taskReferenceCandidates: uniqueCandidates,
        repository,
        prNumber,
        queueJobId: job.id === null || job.id === undefined ? null : String(job.id),
        derivedTaskId,
        queueState: await job.getState(),
      }, 'Resolved queued task stop lookup via PR-scoped queue-job index');
      return job;
    }
  }

  return null;
}

async function createTaskStateFromQueueJob(
  taskId: string,
  queueJob: Job<QueueJobData>,
  deps: StopTaskStateDeps = {},
): Promise<void> {
  const issueRef = buildIssueRefFromQueueJob(queueJob);
  if (!issueRef) {
    throw new Error(`Cannot reconstruct IssueRef for queued task cancellation: ${String(queueJob.id ?? taskId)}`);
  }

  const stateManager = (deps.getStateManager ?? getStateManager)();
  const correlationId = typeof queueJob.data.correlationId === 'string' ? queueJob.data.correlationId : null;
  await stateManager.createTaskState(taskId, issueRef, correlationId);

  const prNumber = getPrNumberFromJobData(queueJob.data);
  const initialJobData = JSON.stringify(queueJob.data);
  await (deps.db ?? db)('tasks')
    .where({ task_id: taskId })
    .update({
      job_id: String(queueJob.id ?? taskId),
      ...(prNumber !== null ? { pr_number: prNumber } : {}),
      initial_job_data: initialJobData,
    });
}

function resolveStopTaskId(
  normalizedTaskId: string,
  queueTaskId: string | null,
  persistedTaskId: string | null,
): string {
  if (persistedTaskId) {
    return persistedTaskId;
  }

  if (!queueTaskId) {
    return normalizedTaskId;
  }

  return queueTaskId ?? normalizedTaskId;
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
