import { Request, Response } from 'express';
import { Queue, Job } from 'bullmq';
import { Knex } from 'knex';

interface JobData {
    repoOwner?: string;
    repoName?: string;
    number?: number;
    issueNumber?: number;
    pullRequestNumber?: number;
    title?: string;
    subtitle?: string;
    comments?: unknown[];
    modelName?: string;
    agentAlias?: string;
}

interface JobReturnValue {
    issueTitle?: string;
    modelName?: string;
    claudeResult?: {
        sessionId: string;
        conversationId?: string;
        executionTime?: number;
        success?: boolean;
        conversationLog?: unknown[];
        model?: string;
    };
    postProcessing?: {
        success?: boolean;
        pr?: {
            number: number;
            url: string;
        };
    };
}

interface TaskRoutesDeps {
  taskQueue: Queue;
  db: Knex;
}

export function createTaskRoutes(deps: TaskRoutesDeps) {
  const { db } = deps;

  async function getTasks(req: Request, res: Response): Promise<void> {
    try {
      const { status = 'all', limit = '50', offset = '0', repository = 'all' } = req.query as Record<string, string>;

      const result = await getTasksFromDb({ db, status, repository, limit: parseInt(limit), offset: parseInt(offset) });
      res.json(result);
    } catch (error) {
      console.error('Error in /api/tasks:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  return { getTasks };
}

interface TaskQuery {
  db: Knex;
  status: string;
  repository: string;
  limit: number;
  offset: number;
}

async function getTasksFromDb(
  query: TaskQuery
): Promise<{ tasks: unknown[]; total: number; offset: number; limit: number }> {
  const { db, status, repository, limit, offset } = query;
  const latestHistorySubquery = db('task_history')
    .select(
      'task_id',
      'state',
      'timestamp',
      'reason',
      db.raw('ROW_NUMBER() OVER(PARTITION BY task_id ORDER BY timestamp DESC) as rn')
    )
    .as('h');

  const processingStartSubquery = db('task_history')
    .select(
      'task_id',
      db.raw('MIN(timestamp) as processing_start_timestamp')
    )
    .whereIn('state', ['processing', 'claude_execution', 'post_processing'])
    .groupBy('task_id')
    .as('ps');

  const completionSubquery = db('task_history')
    .select(
      'task_id',
      db.raw('MIN(timestamp) as completion_timestamp')
    )
    .whereIn('state', ['completed', 'failed'])
    .groupBy('task_id')
    .as('cs');

  const baseQuery = db('tasks as t')
    .join(latestHistorySubquery, function() {
      this.on('t.task_id', '=', 'h.task_id').andOn('h.rn', '=', db!.raw('?', [1]));
    })
    .leftJoin(processingStartSubquery, 'ps.task_id', 't.task_id')
    .leftJoin(completionSubquery, 'cs.task_id', 't.task_id');

  if (status && status !== 'all') {
    baseQuery.where('h.state', status);
  }

  if (repository && repository !== 'all') {
    baseQuery.where('t.repository', repository);
  }

  const totalResult = await baseQuery.clone().count('* as total').first();
  const total = parseInt(String(totalResult?.total || 0), 10);

  const dbTasks = await baseQuery
    .select('t.*', 'h.state', 'h.timestamp as state_timestamp', 'h.reason as failedReason',
            'ps.processing_start_timestamp', 'cs.completion_timestamp')
    .orderBy('t.created_at', 'desc')
    .limit(limit)
    .offset(offset);

  const tasks = dbTasks.map((row: Record<string, unknown>) => mapDbTaskToResponse(row));

  return { tasks, total, offset, limit };
}

function parseRepositoryParts(repository: unknown): { owner: string | null; name: string | null } {
  if (repository && typeof repository === 'string') {
    const parts = repository.split('/');
    if (parts.length === 2) {
      return { owner: parts[0], name: parts[1] };
    }
  }
  return { owner: null, name: null };
}

function parseInitialJobData(row: Record<string, unknown>): {
  title: string | null;
  subtitle: string | null;
  llmProvider: string | null;
  prNumber: number | null;
} {
  const result = { title: null as string | null, subtitle: null as string | null, llmProvider: null as string | null, prNumber: null as number | null };

  if (!row.initial_job_data) {
    return result;
  }

  try {
    const jobData = typeof row.initial_job_data === 'string'
      ? JSON.parse(row.initial_job_data)
      : row.initial_job_data;
    result.title = jobData.title || (jobData.issueRef ? jobData.issueRef.title : null) || null;
    result.subtitle = jobData.subtitle || null;
    result.llmProvider = jobData.agentAlias || null;
    if (jobData.pullRequestNumber) {
      result.prNumber = jobData.pullRequestNumber;
    }
  } catch (e) {
    console.error('Failed to parse initial_job_data', e);
  }

  return result;
}

function extractPrNumberFromFinalResult(row: Record<string, unknown>): number | null {
  if (!row.final_result) {
    return null;
  }

  try {
    const finalResult = typeof row.final_result === 'string'
      ? JSON.parse(row.final_result)
      : row.final_result;
    return finalResult?.postProcessing?.pr?.number || null;
  } catch {
    // Silently ignore parse errors for final_result
    return null;
  }
}

function mapDbTaskToResponse(row: Record<string, unknown>): Record<string, unknown> {
  const { owner: repositoryOwner, name: repositoryName } = parseRepositoryParts(row.repository);
  const { title, subtitle, llmProvider, prNumber: jobDataPrNumber } = parseInitialJobData(row);
  const prNumber = jobDataPrNumber || extractPrNumberFromFinalResult(row);

  return {
    id: row.task_id,
    issueId: row.task_id,
    repository: row.repository,
    repositoryOwner: repositoryOwner,
    repositoryName: repositoryName,
    issueNumber: row.issue_number,
    prNumber: prNumber,
    title: title,
    subtitle: subtitle,
    status: row.state,
    createdAt: new Date(row.created_at as string).toISOString(),
    completedAt: row.completion_timestamp ? new Date(row.completion_timestamp as string).toISOString() : null,
    processedAt: row.processing_start_timestamp ? new Date(row.processing_start_timestamp as string).toISOString() : null,
    failedReason: row.state === 'failed' ? row.failedReason : null,
    progress: (row.state === 'completed' || row.state === 'failed') ? 100 : (row.state === 'processing' ? 50 : 0),
    attemptsMade: 1,
    modelName: row.model_name,
    model: row.model_name,
    llmProvider: llmProvider
  };
}

interface QueueQuery {
  taskQueue: Queue;
  status: string;
  repository: string;
  limit: number;
  offset: number;
}

async function getTasksFromQueue(
  query: QueueQuery
): Promise<{ tasks: unknown[]; total: number; offset: number; limit: number }> {
  const { taskQueue, status, repository, limit, offset } = query;
  let jobs: Job<JobData, JobReturnValue>[] = [];
  if (status === 'all' || status === 'completed') {
    const completed = await taskQueue.getJobs(['completed'], offset, offset + limit);
    jobs = jobs.concat(completed as Job<JobData, JobReturnValue>[]);
  }
  if (status === 'all' || status === 'failed') {
    const failed = await taskQueue.getJobs(['failed'], offset, offset + limit);
    jobs = jobs.concat(failed as Job<JobData, JobReturnValue>[]);
  }
  if (status === 'all' || status === 'active') {
    const active = await taskQueue.getJobs(['active'], offset, offset + limit);
    jobs = jobs.concat(active as Job<JobData, JobReturnValue>[]);
  }
  if (status === 'all' || status === 'waiting') {
    const waiting = await taskQueue.getJobs(['waiting'], offset, offset + limit);
    jobs = jobs.concat(waiting as Job<JobData, JobReturnValue>[]);
  }

  const tasks = jobs
    .map(job => mapQueueJobToResponse(job))
    .filter(task => repository === 'all' || task.repository === repository);

  tasks.sort((a, b) => new Date(b.createdAt as string).getTime() - new Date(a.createdAt as string).getTime());

  return {
    tasks: tasks.slice(0, limit),
    total: tasks.length,
    offset,
    limit
  };
}

function getJobRepository(job: Job<JobData, JobReturnValue>): string {
  if (job.data?.repoOwner && job.data?.repoName) {
    return `${job.data.repoOwner}/${job.data.repoName}`;
  }
  return 'Unknown';
}

function getJobIssueNumber(job: Job<JobData, JobReturnValue>): number | null {
  if (job.data?.number) return job.data.number;
  if (job.data?.issueNumber) return job.data.issueNumber;
  if (job.id?.startsWith('pr-comments-batch')) {
    const match = job.id.match(/-(\d+)-\d+$/);
    return match ? parseInt(match[1]) : null;
  }
  return null;
}

function getJobStatus(job: Job<JobData, JobReturnValue>): string {
  if (job.failedReason) return 'failed';
  if (job.finishedOn) return 'completed';
  if (job.processedOn) return 'active';
  return 'waiting';
}

function parseJobRepository(repository: string): { owner: string | null; name: string | null } {
  if (repository && repository !== 'Unknown') {
    const parts = repository.split('/');
    if (parts.length === 2) {
      return { owner: parts[0], name: parts[1] };
    }
  }
  return { owner: null, name: null };
}

function extractPrNumberFromJob(job: Job<JobData, JobReturnValue>): number | null {
  if (job.data?.pullRequestNumber) {
    return job.data.pullRequestNumber;
  }
  if (job.returnvalue?.postProcessing?.pr?.number) {
    return job.returnvalue.postProcessing.pr.number;
  }
  return null;
}

function mapQueueJobToResponse(job: Job<JobData, JobReturnValue>): Record<string, unknown> {
  const repository = getJobRepository(job);
  const { owner: repositoryOwner, name: repositoryName } = parseJobRepository(repository);
  const prNumber = extractPrNumberFromJob(job);

  return {
    id: job.id,
    issueId: job.id,
    repository: repository,
    repositoryOwner: repositoryOwner,
    repositoryName: repositoryName,
    issueNumber: getJobIssueNumber(job),
    prNumber: prNumber,
    title: job.returnvalue?.issueTitle || job.data?.title || null,
    subtitle: job.data?.subtitle || null,
    status: getJobStatus(job),
    createdAt: new Date(job.timestamp).toISOString(),
    completedAt: job.finishedOn ? new Date(job.finishedOn).toISOString() : null,
    processedAt: job.processedOn ? new Date(job.processedOn).toISOString() : null,
    failedReason: job.failedReason,
    progress: job.progress,
    attemptsMade: job.attemptsMade,
    modelName: job.data?.modelName,
    model: job.data?.modelName || null,
    llmProvider: job.data?.agentAlias || null
  };
}
