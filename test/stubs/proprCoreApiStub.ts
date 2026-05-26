export const STOPPABLE_TASK_STATES = ['processing', 'claude_execution', 'post_processing'] as const;
export const TERMINAL_TASK_STATES = ['completed', 'failed', 'cancelled'] as const;
export const SUPPORTED_WEBHOOK_EVENTS = [
  'issues',
  'issue_comment',
  'pull_request_review_comment',
  'pull_request',
  'check_run',
  'status',
  'push',
] as const;

export const logger = {
  info: (..._args: unknown[]) => {},
  debug: (..._args: unknown[]) => {},
  warn: (..._args: unknown[]) => {},
  error: (..._args: unknown[]) => {},
};

export async function getActiveTasksForPR(..._args: unknown[]): Promise<never[]> {
  return [];
}

export async function markPullRequestMerged(..._args: unknown[]): Promise<void> {}

export async function stopDockerContainer(..._args: unknown[]): Promise<{ success: boolean; error?: string }> {
  return { success: true };
}

export function getStateManager() {
  return {
    markTaskCancelled: async (..._args: unknown[]) => {},
    getTaskState: async (..._args: unknown[]) => null,
    createTaskState: async (..._args: unknown[]) => ({ history: [{ state: 'pending' }] }),
  };
}

export async function getIssueQueue() {
  return {
    getJob: async (..._args: unknown[]) => null,
    getJobs: async (..._args: unknown[]) => [],
  };
}

export const db = Object.assign((..._args: unknown[]) => ({
  select(..._args: unknown[]) {
    return this;
  },
  where(..._args: unknown[]) {
    return this;
  },
  whereNotNull(..._args: unknown[]) {
    return this;
  },
  whereIn(..._args: unknown[]) {
    return this;
  },
  orWhereIn(..._args: unknown[]) {
    return this;
  },
  leftJoin(..._args: unknown[]) {
    return this;
  },
  andWhere(..._args: unknown[]) {
    return this;
  },
  insert(..._args: unknown[]) {
    return this;
  },
  onConflict(..._args: unknown[]) {
    return this;
  },
  ignore: async () => undefined,
  update: async (..._args: unknown[]) => 0,
  first: async () => null,
}), {
  raw(..._args: unknown[]) {
    return 'raw';
  },
});

type QueueJobLike = {
  id?: string | number | null;
  name?: string;
  data: Record<string, unknown>;
};

interface StubIssueRef {
  number: number;
  repoOwner: string;
  repoName: string;
  pullRequestNumber?: number;
  type?: string;
  modelName?: string;
}

export interface TaskStateData {
  history: Array<{ state: string; metadata?: Record<string, unknown> }>;
}

export function buildIssueRefFromQueueJob(queueJob: QueueJobLike): StubIssueRef | null {
  const repository = getRepositoryFromJobData(queueJob.data);
  const repoOwner = typeof queueJob.data.repoOwner === 'string'
    ? queueJob.data.repoOwner
    : repository?.split('/')[0];
  const repoName = typeof queueJob.data.repoName === 'string'
    ? queueJob.data.repoName
    : repository?.split('/')[1];
  const number = getPositiveInteger(queueJob.data.number)
    ?? getPositiveInteger(queueJob.data.issueNumber)
    ?? getPrNumberFromJobData(queueJob.data);
  const prNumber = getPrNumberFromJobData(queueJob.data);

  if (!repoOwner || !repoName || number === null) {
    return null;
  }

  return {
    number,
    repoOwner,
    repoName,
    ...(typeof queueJob.data.modelName === 'string' ? { modelName: queueJob.data.modelName } : {}),
    ...(prNumber !== null ? { pullRequestNumber: prNumber, type: getQueueJobIssueType(queueJob) } : {}),
  };
}

export function getRepositoryFromJobData(jobData: Record<string, unknown>) {
  if (typeof jobData.repository === 'string') {
    return jobData.repository;
  }
  if (typeof jobData.repoOwner === 'string' && typeof jobData.repoName === 'string') {
    return `${jobData.repoOwner}/${jobData.repoName}`;
  }
  if (typeof jobData.owner === 'string' && typeof jobData.repoName === 'string') {
    return `${jobData.owner}/${jobData.repoName}`;
  }
  return null;
}

export function getPrNumberFromJobData(jobData: Record<string, unknown>) {
  return getPositiveInteger(jobData.prNumber) ?? getPositiveInteger(jobData.pullRequestNumber);
}

export function getTaskIdFromQueueJob(queueJob: QueueJobLike) {
  if (typeof queueJob.id === 'string') {
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

export function normalizeTaskId(taskId: string): string {
  if (taskId.startsWith('issue-')) {
    const parts = taskId.replace(/^issue-/, '').split('-');
    parts.pop();
    return parts.join('-');
  }

  return taskId;
}

function getPositiveInteger(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
    return value;
  }
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    return null;
  }

  const parsedValue = Number(value);
  return Number.isSafeInteger(parsedValue) && parsedValue > 0 ? parsedValue : null;
}

function getQueueJobIssueType(queueJob: QueueJobLike): string {
  const commandMode = typeof queueJob.data.commandMode === 'string' ? queueJob.data.commandMode : null;
  if (
    queueJob.name === 'processPullRequestComment'
    || String(queueJob.id).startsWith('pr-comments-batch-')
    || Array.isArray(queueJob.data.comments)
  ) {
    if (commandMode === 'review') return 'pr-review';
    if (commandMode === 'fix') return 'pr-fix';
    if (commandMode === 'switch') return 'pr-switch';
    if (commandMode === 'use') return 'pr-use';
    if (commandMode === 'ultrafix') return 'pr-ultrafix';
    return 'pr-comment';
  }

  return 'pr-followup';
}
