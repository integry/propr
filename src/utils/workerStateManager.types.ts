export const TaskStates = {
    PENDING: 'pending',
    PROCESSING: 'processing',
    CLAUDE_EXECUTION: 'claude_execution',
    POST_PROCESSING: 'post_processing',
    COMPLETED: 'completed',
    FAILED: 'failed',
    CANCELLED: 'cancelled'
} as const;

export type TaskState = typeof TaskStates[keyof typeof TaskStates];

export interface IssueRef {
    number: number;
    repoOwner: string;
    repoName: string;
    type?: string;
    modelName?: string;
    [key: string]: unknown;
}

export interface HistoryEntry {
    state: TaskState;
    timestamp: string;
    reason: string;
    metadata?: Record<string, unknown>;
}

export interface LastError {
    message: string;
    category: string;
    timestamp: string;
}

export interface ClaudeResultSummary {
    success: boolean;
    sessionId?: string | null;
    executionTime?: number;
    conversationId?: string | null;
}

export interface WorktreeInfo {
    [key: string]: unknown;
}

export interface PRResult {
    prNumber?: number;
    prUrl?: string;
    [key: string]: unknown;
}

export interface TaskStateData {
    taskId: string;
    issueRef: IssueRef;
    correlationId: string;
    state: TaskState;
    createdAt: string;
    updatedAt: string;
    attempts: number;
    history: HistoryEntry[];
    lastError?: LastError;
    worktreeInfo?: WorktreeInfo;
    claudeResult?: ClaudeResultSummary;
    prResult?: PRResult;
}

export interface UpdateMetadata {
    isRetry?: boolean;
    error?: {
        message: string;
        category?: string;
    };
    worktreeInfo?: WorktreeInfo;
    claudeResult?: ClaudeResultSummary;
    prResult?: PRResult;
    reason?: string;
    historyMetadata?: Record<string, unknown>;
    errorCategory?: string;
    commitHash?: string;
}

export interface TaskResult {
    prUrl?: string;
    prNumber?: number;
    commitResult?: unknown;
    [key: string]: unknown;
}

export interface ResumableTaskInfo extends TaskStateData {
    isStale: boolean;
    staleDuration?: number;
}

export interface WorkerStateManagerOptions {
    redis?: Record<string, unknown>;
    keyPrefix?: string;
    stateExpiry?: number;
}
