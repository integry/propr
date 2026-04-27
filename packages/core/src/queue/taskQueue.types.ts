// Task queue type definitions
import type { Job } from 'bullmq';
import type { ConversationStep, TokenUsage } from '../utils/llmMetrics.types.js';
import type { CommandMeta } from '../webhook/slashCommandParser.js';

export interface IssueJobData {
    repoOwner: string;
    repoName: string;
    number: number;
    repository?: string;
    agentAlias?: string;       // Agent to use (e.g., 'claude', 'gemini', 'codex')
    modelName?: string;
    correlationId?: string;
    triggeringLabel?: string;
    baseBranch?: string;
    baseLabel?: string | null;
    modelLabel?: string | null;
    isChildJob?: boolean;
    issuePayload?: Record<string, unknown>;
    repoPayload?: Record<string, unknown>;
    title?: string;
    subtitle?: string;
    issueNumber?: number;
    isRetryFromRateLimit?: boolean;  // Set when job is retried after rate limit
}

export type SystemAction = 'auto_resolve_merge_conflicts';

export interface AutoResolveContext {
    baseBranch: string;
    headBranch: string;
    headSha: string;
    baseSha: string;
    triggerSource: 'pull_request' | 'push' | 'auto_merge' | 'comment';
}

export interface CommentJobData {
    pullRequestNumber: number;
    commentId?: number;
    commentBody?: string;
    commentAuthor?: string;
    comments?: UnprocessedComment[];
    branchName?: string;
    repoOwner: string;
    repoName: string;
    llm?: string | null;
    correlationId: string;
    title?: string;
    subtitle?: string;
    systemAction?: SystemAction;
    autoResolveContext?: AutoResolveContext;
    /** Structured slash-command metadata (e.g. /review, /fix) */
    commandMeta?: CommandMeta;
    /** Flattened command mode for queue serialization; defaults to 'default' when absent */
    commandMode?: 'default' | 'review' | 'fix';
    /** Requested model labels for /review commands */
    requestedModels?: string[];
    /** Extra instructions from the slash command body */
    commandInstructions?: string;
}

export interface UnprocessedComment {
    id: number;
    body: string;
    body_html?: string;  // HTML with signed image URLs (from accept: application/vnd.github.full+json)
    author: string;
    type: 'review' | 'issue';
    hasCodeContext?: boolean;
}

export interface TaskImportJobData {
    taskDescription: string;
    repository: string;
    correlationId: string;
    user?: string;
}

export interface AnalysisJobData {
    taskId: string;
    executionId: string;
    sessionId: string;
    correlationId: string;
}

export interface SystemTaskJobData {
    type: 'revert';
    repoName: string;
    prNumber: number;
    commitHash: string;
    targetCommentId: number;
    prBranch: string;
    owner: string;
    correlationId: string;
    requestingUser: string;
    authToken: string;
}

export interface IndexingJobData {
    repository: string;      // Full repo name (e.g., 'owner/repo')
    repoPath: string;        // Path to the cloned repository
    correlationId: string;
    priority?: 'high' | 'normal' | 'low';
    fullReindex?: boolean;   // Force full re-index even if summaries exist
    baseBranch?: string;     // Optional specific branch to index (defaults to repo default branch)
}

export interface MergeConflictJobData {
    pullRequestNumber: number;
    repoOwner: string;
    repoName: string;
    headBranch: string;
    baseBranch: string;
    headSha: string;
    baseSha: string;
    triggerSource: 'pull_request' | 'push' | 'auto_merge' | 'comment';
    correlationId: string;
    systemGenerated: true;    // Distinguishes from user-authored follow-up comments
}

export type JobData = IssueJobData | CommentJobData | TaskImportJobData | AnalysisJobData | SystemTaskJobData | IndexingJobData | MergeConflictJobData;

export interface ClaudeOutputResult {
    type?: string;
    is_error?: boolean;
    result?: string;
    total_cost_usd?: number;
    cost_usd?: number;
    num_turns?: number;
    model?: string;
    conversation_id?: string;
}

export interface ClaudeResult {
    success: boolean;
    sessionId?: string | null;
    conversationId?: string;
    executionTime?: number;
    model?: string;
    finalResult?: ClaudeOutputResult | null;
    conversationLog?: ConversationStep[];
    claudeCostUsd?: number;
    costUsd?: number;
    claudeNumTurns?: number;
    output?: {
        rawOutput?: string;
    };
    rawOutput?: string;
    error?: string;
    tokenUsage?: TokenUsage;
}

export interface JobResult {
    status: string;
    claudeResult?: ClaudeResult;
    correlationId?: string;
    [key: string]: unknown;
}

export interface AiMetrics {
    timestamp: number;
    cost: number;
    model: string;
    turns: number;
    executionTimeMs: number;
    issueNumber?: number;
    repo: string | null;
    status: 'success' | 'failed';
    correlationId?: string;
    error?: string;
}

export interface WorkerCreateOptions {
    concurrency?: number;
}

export interface ActivityLog {
    id: string;
    type: string;
    timestamp: string;
    repository: string | null;
    issueNumber?: number;
    description: string;
    status: 'success' | 'error' | 'info';
}

export interface MetricsUpdateOptions {
    duration: number;
    repoFullName: string | null;
}

export type ProcessorFunction<T = JobData, R = JobResult> = (job: Job<T>) => Promise<R>;
