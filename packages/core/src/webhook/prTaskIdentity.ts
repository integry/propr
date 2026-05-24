import type { IssueRef } from '../utils/workerStateManager.types.js';

export interface PrTaskJobData {
  repository?: unknown;
  repoOwner?: unknown;
  repoName?: unknown;
  owner?: unknown;
  prNumber?: unknown;
  pullRequestNumber?: unknown;
  number?: unknown;
  commandMode?: unknown;
  comments?: unknown;
  modelName?: unknown;
  title?: unknown;
  subtitle?: unknown;
  agentAlias?: unknown;
  correlationId?: unknown;
}

export interface QueueJobIdentityLike {
  id?: string | number | null;
  name?: string;
  data: PrTaskJobData;
}

export function getRepositoryFromJobData(jobData: PrTaskJobData): string | null {
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

export function getPrNumberFromJobData(jobData: PrTaskJobData): number | null {
  if (typeof jobData.prNumber === 'number') {
    return jobData.prNumber;
  }
  if (typeof jobData.pullRequestNumber === 'number') {
    return jobData.pullRequestNumber;
  }
  return null;
}

export function buildPrQueueJobContext(queueJob: QueueJobIdentityLike): { repository: string; prNumber: number; jobId: string } | null {
  const repository = getRepositoryFromJobData(queueJob.data);
  const prNumber = getPrNumberFromJobData(queueJob.data);
  if (!repository || prNumber === null || queueJob.id === null || queueJob.id === undefined) {
    return null;
  }

  return {
    repository,
    prNumber,
    jobId: String(queueJob.id),
  };
}

export function getTaskIdFromQueueJob(queueJob: QueueJobIdentityLike): string | null {
  if (typeof queueJob.id === 'string') {
    return normalizeQueueTaskId(queueJob.id);
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

export function buildIssueRefFromQueueJob(queueJob: QueueJobIdentityLike): IssueRef | null {
  const jobData = queueJob.data;
  const repoOwner = getRepoOwner(jobData);
  const repoName = getRepoName(jobData);
  const number = getTaskNumber(jobData);
  const prNumber = getPrNumberFromJobData(jobData);

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

export function isPullRequestQueueJob(jobData: PrTaskJobData): boolean {
  return getPrNumberFromJobData(jobData) !== null;
}

function normalizeQueueTaskId(taskId: string): string {
  if (taskId.startsWith('issue-')) {
    const parts = taskId.replace(/^issue-/, '').split('-');
    parts.pop();
    return parts.join('-');
  }

  return taskId;
}

function getTaskNumber(jobData: PrTaskJobData): number | null {
  if (typeof jobData.number === 'number') {
    return jobData.number;
  }
  return getPrNumberFromJobData(jobData);
}

function getQueueJobIssueType(queueJob: QueueJobIdentityLike): string {
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

function getRepoOwner(jobData: PrTaskJobData): string | null {
  if (typeof jobData.repoOwner === 'string') {
    return jobData.repoOwner;
  }
  if (typeof jobData.owner === 'string') {
    return jobData.owner;
  }

  const repository = getRepositoryFromJobData(jobData);
  if (!repository) {
    return null;
  }

  return repository.split('/')[0] || null;
}

function getRepoName(jobData: PrTaskJobData): string | null {
  if (typeof jobData.repoName === 'string') {
    return jobData.repoName;
  }

  const repository = getRepositoryFromJobData(jobData);
  if (!repository) {
    return null;
  }

  return repository.split('/')[1] || null;
}
