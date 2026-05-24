import type { Job } from 'bullmq';
import { db, getIssueQueue, getStateManager } from '@propr/core';
import type { IssueRef } from '@propr/core';

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
}

interface StopTaskStateDeps {
  db?: typeof db;
  getStateManager?: typeof getStateManager;
}

type RedisClientLike = {
  get: (key: string) => Promise<string | null>;
};

export function normalizeTaskId(jobId: string): string {
  if (jobId.startsWith('issue-')) {
    const parts = jobId.replace(/^issue-/, '').split('-');
    parts.pop();
    return parts.join('-');
  }
  return jobId;
}

export async function loadStopTaskContext(
  taskReference: string,
  redisClient: RedisClientLike,
  deps: StopTaskContextDeps,
): Promise<StopTaskContext> {
  const normalizedTaskId = normalizeTaskId(taskReference);
  const persistedTask = await findPersistedTaskRecord(taskReference, normalizedTaskId, deps.db ?? db);
  const stateLookup = await loadTaskState(redisClient, [persistedTask?.taskId, normalizedTaskId, taskReference]);
  const candidateTaskIds = [...new Set([
    taskReference,
    normalizedTaskId,
    persistedTask?.taskId,
    persistedTask?.jobId,
  ].filter((value): value is string => Boolean(value)))];

  console.log(`[stop-execution] Attempting to stop task: ${taskReference} (taskId: ${normalizedTaskId})`);

  const state = stateLookup.state;
  const currentState = state?.history[state.history.length - 1]?.state ?? null;
  const queueJob = await getQueueJob(candidateTaskIds, deps.getIssueQueue);
  const queueState = queueJob ? await queueJob.getState() : null;
  const taskId = resolveStopTaskId(normalizedTaskId, queueJob, persistedTask?.taskId ?? stateLookup.taskId);
  const abortTaskIds = buildAbortTaskIds(taskId, normalizedTaskId, queueJob, persistedTask?.jobId ?? null);

  return {
    normalizedTaskId,
    state,
    currentState,
    queueJob,
    queueState,
    taskId: stateLookup.taskId ?? taskId,
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
): Promise<PersistedTaskRecord | null> {
  const lookupCandidates = [
    { column: 'task_id', value: taskReference },
    { column: 'task_id', value: normalizedTaskId },
    { column: 'job_id', value: taskReference },
    { column: 'job_id', value: normalizedTaskId },
  ];
  const seen = new Set<string>();

  for (const candidate of lookupCandidates) {
    const key = `${candidate.column}:${candidate.value}`;
    if (!candidate.value || seen.has(key)) {
      continue;
    }
    seen.add(key);

    const record = await database('tasks')
      .where({ [candidate.column]: candidate.value })
      .select('task_id', 'job_id')
      .first() as { task_id: string; job_id: string | null } | undefined;
    if (record) {
      return {
        taskId: record.task_id,
        jobId: record.job_id,
      };
    }
  }

  return null;
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

async function getQueueJob(
  candidateTaskIds: string[],
  loadQueue: typeof getIssueQueue = getIssueQueue,
): Promise<Job<QueueJobData> | null> {
  const queue = await loadQueue();
  for (const candidateTaskId of candidateTaskIds) {
    const job = await queue.getJob(candidateTaskId) as Job<QueueJobData> | undefined;
    if (job) {
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
    return;
  }

  const stateManager = (deps.getStateManager ?? getStateManager)();
  const correlationId = typeof queueJob.data.correlationId === 'string' ? queueJob.data.correlationId : null;
  await stateManager.createTaskState(taskId, issueRef, correlationId);

  const prNumber = extractPrNumber(queueJob.data);
  const initialJobData = JSON.stringify(queueJob.data);
  await (deps.db ?? db)('tasks')
    .where({ task_id: taskId })
    .update({
      job_id: String(queueJob.id ?? taskId),
      ...(prNumber !== null ? { pr_number: prNumber } : {}),
      initial_job_data: initialJobData,
    });
}

function buildIssueRefFromQueueJob(queueJob: Job<QueueJobData>): IssueRef | null {
  const jobData = queueJob.data;
  const repoOwner = getRepoOwner(jobData);
  const repoName = getRepoName(jobData);
  const number = extractTaskNumber(jobData);
  const prNumber = extractPrNumber(jobData);

  if (!repoOwner || !repoName || number === null) {
    return null;
  }

  return {
    number,
    repoOwner,
    repoName,
    ...(typeof jobData.modelName === 'string' ? { modelName: jobData.modelName } : {}),
    ...(typeof jobData.title === 'string' ? { title: jobData.title } : {}),
    ...(typeof jobData.subtitle === 'string' ? { subtitle: jobData.subtitle } : {}),
    ...(prNumber !== null ? { pullRequestNumber: prNumber, type: getQueueJobIssueType(queueJob) } : {}),
  };
}

function getQueueJobIssueType(queueJob: Job<QueueJobData>): string {
  const jobData = queueJob.data;
  const commandMode = typeof jobData.commandMode === 'string' ? jobData.commandMode : null;

  if (queueJob.name === 'processMergeConflict' || String(queueJob.id).startsWith('merge-conflict-')) {
    return 'merge-conflict';
  }

  if (
    queueJob.name === 'processPullRequestComment'
    || String(queueJob.id).startsWith('pr-comments-batch-')
    || Array.isArray(jobData.comments)
  ) {
    if (commandMode === 'review') {
      return 'pr-review';
    }
    if (commandMode === 'fix') {
      return 'pr-fix';
    }
    if (commandMode === 'switch') {
      return 'pr-switch';
    }
    if (commandMode === 'use') {
      return 'pr-use';
    }
    if (commandMode === 'ultrafix') {
      return 'pr-ultrafix';
    }
    return 'pr-comment';
  }

  return 'pr-followup';
}

function extractTaskNumber(jobData: QueueJobData): number | null {
  if (typeof jobData.pullRequestNumber === 'number') {
    return jobData.pullRequestNumber;
  }
  if (typeof jobData.prNumber === 'number') {
    return jobData.prNumber;
  }
  if (typeof jobData.number === 'number') {
    return jobData.number;
  }
  return null;
}

function extractPrNumber(jobData: QueueJobData): number | null {
  if (typeof jobData.pullRequestNumber === 'number') {
    return jobData.pullRequestNumber;
  }
  if (typeof jobData.prNumber === 'number') {
    return jobData.prNumber;
  }
  return null;
}

function getRepoOwner(jobData: QueueJobData): string | null {
  if (typeof jobData.repoOwner === 'string') {
    return jobData.repoOwner;
  }
  if (typeof jobData.owner === 'string') {
    return jobData.owner;
  }
  const repository = getRepositoryValue(jobData);
  if (!repository) {
    return null;
  }
  return repository.split('/')[0] || null;
}

function getRepoName(jobData: QueueJobData): string | null {
  if (typeof jobData.repoName === 'string') {
    return jobData.repoName;
  }
  const repository = getRepositoryValue(jobData);
  if (!repository) {
    return null;
  }
  return repository.split('/')[1] || null;
}

function getRepositoryValue(jobData: QueueJobData): string | null {
  return typeof jobData.repository === 'string' ? jobData.repository : null;
}

function resolveStopTaskId(
  normalizedTaskId: string,
  queueJob: Job<QueueJobData> | null,
  persistedTaskId: string | null,
): string {
  if (persistedTaskId) {
    return persistedTaskId;
  }

  if (!queueJob) {
    return normalizedTaskId;
  }

  const queueTaskId = buildTaskIdFromQueueJob(queueJob);
  return queueTaskId ?? normalizedTaskId;
}

function buildAbortTaskIds(
  taskId: string,
  normalizedTaskId: string,
  queueJob: Job<QueueJobData> | null,
  persistedJobId: string | null,
): string[] {
  const queueJobId = queueJob?.id ? String(queueJob.id) : null;
  return [...new Set([taskId, normalizedTaskId, queueJobId, persistedJobId].filter((value): value is string => Boolean(value)))];
}

function buildTaskIdFromQueueJob(queueJob: Job<QueueJobData>): string | null {
  if (typeof queueJob.id === 'string' && isPullRequestQueueJob(queueJob.data)) {
    return normalizeTaskId(queueJob.id);
  }

  if (
    typeof queueJob.data.repoOwner === 'string'
    && typeof queueJob.data.repoName === 'string'
    && typeof queueJob.data.number === 'number'
    && typeof queueJob.data.agentAlias === 'string'
    && typeof queueJob.data.modelName === 'string'
    && typeof queueJob.data.correlationId === 'string'
  ) {
    return `${queueJob.data.repoOwner}-${queueJob.data.repoName}-${queueJob.data.number}-${queueJob.data.agentAlias}-${queueJob.data.modelName}-${queueJob.data.correlationId}`;
  }

  return null;
}

function isPullRequestQueueJob(jobData: QueueJobData): boolean {
  return typeof jobData.pullRequestNumber === 'number' || typeof jobData.prNumber === 'number';
}
