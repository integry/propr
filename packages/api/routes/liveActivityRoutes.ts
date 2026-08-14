import type { Request, Response } from 'express';
import type { Knex } from 'knex';
import type { Job, Queue } from 'bullmq';
import {
  inspectExactTaskContainerLivenessForTask,
  logger,
} from '@propr/core';

const LIVE_JOB_TYPES = ['active', 'waiting', 'delayed', 'prioritized', 'waiting-children', 'paused'] as const;
const LIVE_JOB_STATES = new Set<string>(LIVE_JOB_TYPES);
const NONTERMINAL_TASK_STATES = ['pending', 'processing', 'claude_execution', 'post_processing'];
const TASK_EXECUTION_JOB_NAMES = new Set([
  'processGitHubIssue',
  'processPullRequestComment',
  'processTaskImport',
  'processMergeConflict',
]);
const CANDIDATE_PAGE_SIZE = 100;
const LIVENESS_CONCURRENCY = 10;

export interface LiveActivityItem {
  id: string;
  type: 'plan' | 'task';
  label: string;
  repository: string;
  status: string;
  createdAt: string;
}

interface LiveActivityRoutesDeps {
  db: Knex;
  taskQueue: Pick<Queue, 'getJob' | 'getJobs'>;
  inspectContainer?: (taskId: string) => Promise<'running' | 'not_found' | 'unavailable'>;
}

function asIso(value: unknown): string {
  const parsed = typeof value === 'number' ? new Date(value) : new Date(String(value ?? ''));
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : new Date(0).toISOString();
}

function taskLabel(row: Record<string, unknown>): string {
  try {
    const payload = typeof row.initial_job_data === 'string'
      ? JSON.parse(row.initial_job_data)
      : row.initial_job_data;
    if (payload?.title) return String(payload.title);
    if (payload?.issueRef?.title) return String(payload.issueRef.title);
  } catch {
    // A malformed historical payload should not hide otherwise-live work.
  }
  return `Task ${String(row.task_id).slice(0, 8)}`;
}

interface QueueActivityCandidate {
  job: Job;
}

function persistedTaskType(row: Record<string, unknown>): string | undefined {
  try {
    const payload = typeof row.initial_job_data === 'string'
      ? JSON.parse(row.initial_job_data)
      : row.initial_job_data;
    return typeof payload?.type === 'string' ? payload.type : undefined;
  } catch {
    return undefined;
  }
}

function queuedTaskId(job: Job): string | undefined {
  const data = job.data as Record<string, unknown>;
  if (typeof data.taskId === 'string' && data.taskId) return data.taskId;
  if (job.name === 'processPullRequestComment' || job.name === 'processMergeConflict') {
    return job.id === undefined ? undefined : String(job.id);
  }
  if (job.name !== 'processGitHubIssue') return undefined;
  const fields = ['repoOwner', 'repoName', 'agentAlias', 'modelName', 'correlationId'] as const;
  if (!fields.every(field => typeof data[field] === 'string' && data[field])
    || (typeof data.number !== 'number' && typeof data.number !== 'string')) return undefined;
  return `${data.repoOwner}-${data.repoName}-${data.number}-${data.agentAlias}-${data.modelName}-${data.correlationId}`;
}

function queuedTaskLabel(job: Job): string {
  const data = job.data as Record<string, unknown>;
  if (typeof data.title === 'string' && data.title) return data.title;
  if (job.name === 'processTaskImport' && typeof data.taskDescription === 'string' && data.taskDescription) {
    return data.taskDescription;
  }
  if (job.name === 'processPullRequestComment') {
    return `PR #${String(data.pullRequestNumber ?? 'unknown')}`;
  }
  if (job.name === 'processMergeConflict') {
    return `Resolve conflicts for PR #${String(data.pullRequestNumber ?? 'unknown')}`;
  }
  const issuePayload = data.issuePayload as Record<string, unknown> | undefined;
  if (typeof issuePayload?.title === 'string' && issuePayload.title) return issuePayload.title;
  return `Issue #${String(data.number ?? 'unknown')}`;
}

function queuedRepository(job: Job): string {
  const data = job.data as Record<string, unknown>;
  if (typeof data.repository === 'string' && data.repository) return data.repository;
  return `${String(data.repoOwner ?? 'unknown')}/${String(data.repoName ?? 'unknown')}`;
}

function isTaskExecutionJob(job: Job): boolean {
  if (!TASK_EXECUTION_JOB_NAMES.has(job.name)) return false;
  // This mirrors processGitHubIssueJob's dispatch predicate: falsey
  // isChildJob values are matrix-dispatch parents and do not create tasks.
  return job.name !== 'processGitHubIssue'
    || Boolean((job.data as Record<string, unknown>).isChildJob);
}

function queueStatus(state: string): string {
  if (state === 'active') return 'Implementing';
  if (state === 'delayed') return 'Delayed';
  if (state === 'paused') return 'Paused';
  return 'Queued';
}

async function findLiveQueuedTaskJobs(deps: LiveActivityRoutesDeps): Promise<QueueActivityCandidate[]> {
  const jobs = await deps.taskQueue.getJobs([...LIVE_JOB_TYPES], 0, -1, true);
  const candidates: QueueActivityCandidate[] = [];
  for (let index = 0; index < jobs.length; index += LIVENESS_CONCURRENCY) {
    const batch = jobs.slice(index, index + LIVENESS_CONCURRENCY);
    const states = await Promise.all(batch.map(job => job.getState()));
    batch.forEach((job, offset) => {
      const state = states[offset];
      if (!isTaskExecutionJob(job as Job)
        || job.id === undefined
        || !LIVE_JOB_STATES.has(state)) return;
      candidates.push({
        job: job as Job,
      });
    });
  }
  return candidates;
}

function jobMatchesPersistedExecution(job: Job, row: Record<string, unknown>): boolean {
  const taskId = String(row.task_id);
  const data = job.data as Record<string, unknown>;
  if (typeof data.taskId === 'string' && data.taskId) return data.taskId === taskId;
  const isPRComment = persistedTaskType(row) === 'pr_comment'
    || taskId.startsWith('pr-comment-')
    || taskId.startsWith('pr-comments-');
  return isPRComment
    && job.id !== undefined
    && String(job.id) === taskId;
}

async function hasAuthoritativeLiveness(
  row: Record<string, unknown>,
  deps: LiveActivityRoutesDeps,
): Promise<boolean> {
  const taskId = String(row.task_id);
  const jobId = row.job_id ? String(row.job_id) : taskId;
  let queueAvailable = true;
  try {
    const job = await deps.taskQueue.getJob(jobId);
    if (job && jobMatchesPersistedExecution(job as Job, row)
      && LIVE_JOB_STATES.has(await job.getState())) return true;
  } catch (error) {
    queueAvailable = false;
    logger.warn({ taskId, jobId, error: (error as Error).message }, 'BullMQ liveness unavailable for header activity');
  }

  const container = await (deps.inspectContainer ?? inspectExactTaskContainerLivenessForTask)(taskId);
  if (container === 'running') return true;
  if (!queueAvailable || container === 'unavailable') {
    logger.warn({ taskId, jobId, queueAvailable, container },
      'Omitting task from header because authoritative liveness is unavailable');
  }
  return false;
}

async function filterLivePage(
  rows: Array<Record<string, unknown>>,
  deps: LiveActivityRoutesDeps,
): Promise<LiveActivityItem[]> {
  const items: LiveActivityItem[] = [];
  for (let index = 0; index < rows.length; index += LIVENESS_CONCURRENCY) {
    const batch = rows.slice(index, index + LIVENESS_CONCURRENCY);
    const live = await Promise.all(batch.map(row => hasAuthoritativeLiveness(row, deps)));
    batch.forEach((row, offset) => {
      if (!live[offset]) return;
      items.push({
        id: String(row.task_id),
        type: 'task',
        label: taskLabel(row),
        repository: String(row.repository ?? 'unknown/unknown'),
        status: 'Implementing',
        createdAt: asIso(row.created_at),
      });
    });
  }
  return items;
}

export function createLiveActivityRoutes(deps: LiveActivityRoutesDeps) {
  async function getLiveActivity(req: Request, res: Response): Promise<void> {
    try {
      const requestedLimit = Number(req.query.limit ?? 50);
      const limit = Number.isSafeInteger(requestedLimit) && requestedLimit > 0
        ? Math.min(requestedLimit, 100)
        : 50;
      const userId = (req.user as { id?: string } | undefined)?.id;
      let plansQuery = deps.db('task_drafts')
        .whereIn('status', ['generating', 'refining'])
        .select('draft_id', 'name', 'initial_prompt', 'repository', 'status', 'created_at');
      if (userId) plansQuery = plansQuery.where({ user_id: userId });
      const plans = await plansQuery;
      const items: LiveActivityItem[] = plans.map(row => ({
        id: String(row.draft_id),
        type: 'plan',
        label: String(row.name || row.initial_prompt || 'Generating Plan'),
        repository: String(row.repository ?? 'unknown/unknown'),
        status: row.status === 'generating' ? 'Generating Spec' : 'Refining',
        createdAt: asIso(row.created_at),
      }));

      // Task-producing jobs can be live before their worker creates a
      // task/history row. Enumerate them directly, then prefer a persisted task
      // only when both records identify the same execution.
      const queuedCandidates = await findLiveQueuedTaskJobs(deps);
      const persistedExecutions = new Map<string, Record<string, unknown>>();

      const latestHistory = deps.db('task_history')
        .select('task_id')
        .max('history_id as history_id')
        .groupBy('task_id')
        .as('latest');
      let afterTaskId = '';
      while (true) {
        const rows = await deps.db('tasks as t')
          .join(latestHistory, 'latest.task_id', 't.task_id')
          .join('task_history as h', 'h.history_id', 'latest.history_id')
          .whereIn('h.state', NONTERMINAL_TASK_STATES)
          .modify(query => { if (afterTaskId) query.where('t.task_id', '>', afterTaskId); })
          .select('t.task_id', 't.job_id', 't.repository', 't.created_at', 't.initial_job_data')
          .orderBy('t.task_id', 'asc')
          .limit(CANDIDATE_PAGE_SIZE) as Array<Record<string, unknown>>;
        rows.forEach(row => {
          persistedExecutions.set(String(row.task_id), row);
        });
        items.push(...await filterLivePage(rows, deps));
        if (rows.length < CANDIDATE_PAGE_SIZE) break;
        afterTaskId = String(rows[rows.length - 1].task_id);
      }
      for (const candidate of queuedCandidates) {
        if (candidate.job.id === undefined) continue;
        const refreshedJob = await deps.taskQueue.getJob(String(candidate.job.id)) as Job | undefined;
        if (!refreshedJob || refreshedJob.id === undefined || !isTaskExecutionJob(refreshedJob)) continue;
        const refreshedState = await refreshedJob.getState();
        if (!LIVE_JOB_STATES.has(refreshedState)) continue;
        const refreshedJobId = String(refreshedJob.id);
        const authoritativeTaskId = queuedTaskId(refreshedJob) ?? refreshedJobId;
        const persisted = persistedExecutions.get(authoritativeTaskId);
        if (persisted && jobMatchesPersistedExecution(refreshedJob, persisted)) continue;
        items.push({
          id: authoritativeTaskId,
          type: 'task',
          label: queuedTaskLabel(refreshedJob),
          repository: queuedRepository(refreshedJob),
          status: queueStatus(refreshedState),
          createdAt: asIso(refreshedJob.timestamp),
        });
      }

      items.sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
      const visibleItems = items.slice(0, limit);
      res.json({
        items: visibleItems,
        total: items.length,
        remaining: Math.max(0, items.length - visibleItems.length),
      });
    } catch (error) {
      logger.error({ error: (error as Error).message }, 'Failed to resolve live header activity');
      // Fail closed: never fall back to historical processing rows.
      res.status(503).json({ error: 'Live activity is temporarily unavailable', items: [], total: 0, remaining: 0 });
    }
  }

  return { getLiveActivity };
}
