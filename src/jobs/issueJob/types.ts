/**
 * Type definitions for GitHub issue job processing.
 */

import type { Logger } from 'pino';
import type { WorkerStateManager, IssueJobData, WorktreeInfo, CommitResult, ClaudeCodeResponse } from '@propr/core';
import type { PostProcessingResult } from '../issueJobHelpers.js';
import type { GitHubToken } from '../githubTypes.js';

export type { GitHubToken };

export interface JobContext {
  jobId: string | undefined;
  jobName: string;
  issueRef: IssueJobData;
  correlationId: string;
  correlatedLogger: Logger;
  stateManager: WorkerStateManager;
  agentAlias: string;
  modelName: string;
  taskId: string;
  AI_PROCESSING_TAG: string;
  AI_DONE_TAG: string;
  AI_WAITING_TAG: string;
  AI_PRIMARY_TAG: string;
  PR_LABEL: string;
}

export interface CurrentIssueData {
  data: {
    title: string;
    body: string | null | undefined;
    body_html?: string;
    labels: Array<{ name: string }>;
    created_at: string;
    updatedAt?: string;
    user: { login: string };
  };
}

export interface IssueComment {
  id: number;
  body: string;
  body_html?: string;  // HTML with signed image URLs
  user: { login: string; type?: string };
}

export interface LabelCheckResult {
  skip: boolean;
  reason?: string;
}

export interface TaskCompletionParams {
  stateManager: WorkerStateManager;
  taskId: string;
  issueRef: IssueJobData;
  currentIssueLabels: string[];
  claudeResult: ClaudeCodeResponse | null;
  postProcessingResult: PostProcessingResult | null;
  commitResult: CommitResult | null;
  correlatedLogger: Logger;
}

export interface ExecuteWorktreeParams {
  job: import('bullmq').Job<IssueJobData>;
  context: JobContext;
  octokit: Awaited<ReturnType<typeof import('@propr/core').getAuthenticatedOctokit>>;
  currentIssueData: CurrentIssueData;
  repoValidation: import('@propr/core').RepoValidationResult;
  githubToken: GitHubToken;
  repoUrl: string;
  localRepoPath: string;
}

export interface ExecuteWorktreeResult {
  worktreeInfo: WorktreeInfo;
  claudeResult: ClaudeCodeResponse;
  postProcessingResult: PostProcessingResult | null;
  commitResult: CommitResult | null;
}

export interface ExecutionParams {
  octokit: Awaited<ReturnType<typeof import('@propr/core').getAuthenticatedOctokit>>;
  worktreeInfo: WorktreeInfo;
  issueRef: IssueJobData;
  githubToken: GitHubToken;
  currentIssueData: CurrentIssueData;
  issueComments: IssueComment[];
}
