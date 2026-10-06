/** `stalled` / `degenerate_output`: the agent activity watchdog stopped the run. */
export type TaskTerminalReason = 'timed_out' | 'stalled' | 'degenerate_output' | 'cost_cap' | 'cancelled_issue_closed' | 'cancelled_label_removed' | 'cancelled_pr_closed' | 'cancelled_by_user' | 'pr_merged';

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
    /** Monotonically increasing revision used for compare-and-set updates. */
    version?: number;
    attempts: number;
    history: HistoryEntry[];
    lastError?: LastError;
    terminalReason?: TaskTerminalReason;
    worktreeInfo?: WorktreeInfo;
    claudeResult?: ClaudeResultSummary;
    prResult?: PRResult;
}

export interface TaskStateExpectation {
    state: TaskState;
    createdAt: string;
    updatedAt: string;
    correlationId: string;
    version?: number;
}

export interface TaskStatePublicationResult {
    historyPersisted: boolean;
    eventPublished: boolean;
    errors: string[];
}

export interface TaskStateUpdateResult {
    state: TaskStateData;
    publication: TaskStatePublicationResult;
}

export interface CancellationMetadata {
    cancelledBy?: 'user' | 'system';
    cancelledAt?: string;
    reason?: string;
    containerStopped?: boolean;
    containerId?: string;
}

export interface UpdateMetadata {
    terminalReason?: TaskTerminalReason;
    isRetry?: boolean;
    /** The failed attempt's queued retry was removed, so its withdrawal must be recorded. */
    withdrawnQueuedRetry?: boolean;
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

export interface NonTerminalTaskScanResult {
    tasks: TaskStateData[];
    nextCursor: string;
}

export interface WorkerStateManagerOptions {
    redis?: Record<string, unknown>;
    keyPrefix?: string;
    stateExpiry?: number;
}

/** Queue handoffs are bookkeeping, not a withdrawal of the user's request. */
export function isBookkeepingCancellation(task: Pick<TaskStateData, 'state' | 'terminalReason' | 'history'>): boolean {
    if (task.state !== TaskStates.CANCELLED || task.terminalReason) return false;
    const entry = task.history?.at(-1);
    return ['requeued', 'rescheduled'].includes(String(entry?.metadata?.jobResultStatus))
        || /^Task job (requeued|rescheduled)(:|$)/.test(entry?.reason ?? '');
}
