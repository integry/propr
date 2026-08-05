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
    agentAlias?: string;
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
    /** Monotonic revision used to order concurrent persistence and UI events. */
    version?: number;
    attempts: number;
    history: HistoryEntry[];
    /** Exact renewable lease token owned by this PR-comment attempt. */
    prProcessingLockToken?: string;
    lastError?: LastError;
    worktreeInfo?: WorktreeInfo;
    claudeResult?: ClaudeResultSummary;
    prResult?: PRResult;
}

export interface CreateTaskStateOptions {
    prProcessingLockToken?: string;
    /** PR lease key whose current value must match the attempt token at creation. */
    prProcessingLockKey?: string;
}

export interface NonTerminalTaskFilter {
    taskTypes?: string[];
    /** Maximum number of matching records returned by one rotating scan. */
    limit?: number;
}

export interface NonTerminalTaskPage {
    tasks: TaskStateData[];
    /** True after every key in the current Redis SCAN cycle was inspected. */
    scanComplete: boolean;
}

export interface TaskStateExpectation {
    state: TaskState;
    updatedAt?: string;
    version?: number;
    prProcessingLockToken?: string;
}

export interface CancellationMetadata {
    cancelledBy?: 'user' | 'system';
    cancelledAt?: string;
    reason?: string;
    containerStopped?: boolean;
    containerId?: string;
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
    cancellation?: CancellationMetadata;
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
    /** Namespace for durable task revisions; kept outside state scans. */
    revisionKeyPrefix?: string;
    stateExpiry?: number;
    /** Retains ordering after state cleanup without leaking one key per task forever. */
    revisionExpiry?: number;
}
