import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import type {
    ClaudeCodeResponse,
    CommentJobData,
    UnprocessedComment,
    WorkerStateManager,
    WorktreeInfo,
    getAuthenticatedOctokit,
} from '@propr/core';

export interface PRData {
    data: {
        head: { ref: string; sha?: string };
        body: string | null;
        labels: Array<{ name: string }>;
        user: { login: string };
        title: string;
    };
}

export interface PRComment {
    id: number;
    body: string;
    body_html?: string;
    user: { login: string; type?: string };
    created_at: string;
    pull_request_review_id?: number;
}

export interface PRJobContext {
    pullRequestNumber: number;
    jobBranchName: string | undefined;
    repoOwner: string;
    repoName: string;
    llm: string | null | undefined;
    agentAlias?: string;
    modelName?: string;
    modelLabel?: string;
    isRetryFromRateLimit?: boolean;
    correlationId: string;
    correlatedLogger: Logger;
    primaryProcessingLabels: string[];
    isBatchJob: boolean;
    commentsToProcess: UnprocessedComment[];
    pickedUpComments: UnprocessedComment[];
    originalUltrafixMeta: CommentJobData['ultrafixMeta'];
}

export interface ValidationResult {
    skip: boolean;
    reason?: string;
    prData?: PRData;
    validatedComments?: UnprocessedComment[];
    unprocessedComments?: UnprocessedComment[];
    llm?: string | null;
    prCommentsForValidation?: PRComment[];
}

export interface LockParams {
    lockKey: string;
    lockToken: string;
    correlatedLogger: Logger;
    job: Job<CommentJobData>;
}

export interface ProcessingState {
    octokit: Awaited<ReturnType<typeof getAuthenticatedOctokit>> | null;
    localRepoPath: string | undefined;
    worktreeInfo: WorktreeInfo | undefined;
    claudeResult: ClaudeCodeResponse | null;
    authorsText: string;
    unprocessedComments: UnprocessedComment[];
    startingWorkComment: { data: { id: number; html_url: string } } | null;
}

export interface ExecuteProcessingParams {
    job: Job<CommentJobData>;
    context: PRJobContext;
    llm: string | null | undefined;
    taskId: string;
    stateManager: WorkerStateManager;
    state: ProcessingState;
    lockKey: string;
    lockToken: string;
}
