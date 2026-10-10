import { IssueRef, IssueDetails } from '../claude/prompts/promptGenerator.js';
import type { CliVersionType } from '../config/configManager.js';
import type { UsageTrackingMetrics } from './impl/utils/usageTrackingWrapper.js';
import type { AgentType as SharedAgentType, ReasoningLevel } from '@propr/shared';

export { AGENT_TYPES } from '@propr/shared';

/**
 * Configuration for a specific agent instance.
 * Stored in config.json under 'agents' array.
 */
export interface AgentConfig {
    id: string;             // UUID v4
    type: SharedAgentType;
    alias: string;          // Human-readable ID (e.g., 'claude-prod', 'codex-beta')
    enabled: boolean;

    // Docker configuration
    dockerImage: string;    // e.g., 'propr/agent:latest'
    configPath: string;     // Host path or '~' path resolved before Docker bind use

    // Model configuration
    supportedModels: string[]; // List of models this agent supports
    defaultModel?: string;     // Default model if none specified

    // Environment variables to inject into container
    envVars?: Record<string, string>;

    // Custom GitHub labels per model (maps model ID to custom label)
    // e.g., { 'claude-opus-4-5-20251101': 'my-opus-bot', 'claude-sonnet-4-5-20251101': 'my-sonnet-bot' }
    modelCustomLabels?: Record<string, string>;

    // Per-model reasoning levels. These override the system setting when no task label overrides them.
    modelReasoningLevels?: Record<string, ReasoningLevel>;

    // CLI Version Configuration
    cliVersionType?: CliVersionType;  // How the version is specified (default, tag, specific, custom)
    cliVersion?: string;              // User-specified version (e.g., "2.1.84", "stable", "latest")
    cliVersionResolved?: string;      // Resolved semver version (populated by backend)
}

/** Bearer-authenticated MCP server exposed to one run; the token travels only through the container environment. */
export interface AgentToolPolicyMcpServer {
    name: string;
    url: string;
    /** Container environment variable holding the token. */
    bearerTokenEnv: string;
    bearerToken: string;
}

/**
 * Per-run tool restrictions enforced with the runtime's native CLI switches
 * (Claude, Codex); other runtimes apply the web restriction through the prompt only.
 */
export interface AgentToolPolicy {
    allowWeb: boolean;
    mcpServers?: AgentToolPolicyMcpServer[];
}

export interface AgentTaskOptions {
    worktreePath: string;
    issueRef: IssueRef;
    issueDetails?: IssueDetails;
    prompt: string;

    /**
     * Selects the provider's native long-running goal path. Goal input is
     * delivered verbatim and provider session persistence is retained.
     * Omitted for the existing one-shot task behavior.
     */
    executionMode?: 'task' | 'goal';
    /** Exact provider session identity to resume in goal mode. */
    resumeSessionId?: string;
    /** Provider conversation identity when it differs from the session ID. */
    resumeConversationId?: string;
    /** Stable initial native goal instruction used by provider goal metadata APIs. */
    nativeGoalObjective?: string;
    /** Pending FIFO input consumed by the turn being started, when applicable. */
    initialControlInputId?: string;
    /** Message paired with initialControlInputId when the first Codex turn starts from a different objective. */
    initialControlInputMessage?: string;
    /** Durable ProPR checkpoint feedback to inject at the resumed Codex boundary. */
    initialGoalFeedback?: string;
    /** Durable controls observed only at provider turn boundaries. */
    goalControl?: GoalExecutionControl;

    // Execution overrides
    model?: string;
    systemPrompt?: string;
    isRetry?: boolean;
    retryReason?: string;

    // Callbacks
    onSessionId?: (sessionId: string, conversationId?: string) => void | Promise<void>;
    onContainerId?: (containerId: string, containerName: string) => void;

    /** Worker credential; adapters replace this with a scoped token before launch. */
    githubToken: string;
    /** Worker-prepared mounts; never supplied by the agent. */
    gitMountArgs?: string[];
    /**
     * `none` launches without repository clone mounts or repository
     * credentials (for example an agent run without `repository_read`).
     */
    repositoryAccess?: 'none';

    // Branch information
    branchName?: string;

    // Additional options
    tools?: string;
    /**
     * Absent keeps the runtime's default tools. Task execution only: Claude,
     * Codex and Antigravity reject it in goal mode rather than run unrestricted.
     */
    toolPolicy?: AgentToolPolicy;
    /**
     * Turn limit for this task when it needs more than the configured default
     * (for example writing a plan task by task). Agents without a turn limit ignore it.
     */
    maxTurns?: number;
    /** Optional per-task reasoning level override. Omitted means use the global setting. */
    reasoningLevel?: ReasoningLevel;
    /** Per-execution environment variables to inject into the agent container. */
    environment?: Record<string, string>;

    /** Additional structured fields persisted with the execution LLM log. */
    metadata?: Record<string, unknown>;

    // Task ID for abort signal checking
    taskId?: string;

    /** PR number when this is a PR follow-up task (distinct from issueRef.number) */
    prNumber?: number;
}

export interface GoalControlInput {
    id: string;
    message: string;
    /** Durable submission order of the input within its goal. */
    sequence?: number;
}

export interface GoalCheckpointRequest {
    id?: string;
    kind: 'agent';
    commitMessage: string;
    include?: string[];
    exclude?: string[];
    summary?: string;
}

export interface GoalCheckpointRejection {
    kind: 'agent';
    error: string;
    commitMessage?: string;
    include?: string[];
    exclude?: string[];
    summary?: string;
}

export interface GoalCheckpointOutcome {
    accepted: boolean;
    commitSha?: string | null;
    error?: string;
}

export interface GoalControlSnapshot {
    desiredState: 'running' | 'paused' | 'cancelled';
    requestedModel: string;
    pendingInputs: GoalControlInput[];
    controlGeneration: number;
}

/**
 * An explicit, structured provider request for a person: a question or an
 * approval. Reported only from provider protocol events, never inferred from
 * narration, silence or slow work.
 */
export interface GoalBlockerReport {
    /** The provider's own identity for this request, stable across repeated events. */
    requestKey: string;
    category: 'question' | 'approval';
    /** Protocol event that carried the request, e.g. `codex_app_server:item/tool/requestUserInput`. */
    source: string;
    summary: string;
    questions?: Array<{ id: string; header: string | null; question: string; options: string[]; confidential: boolean }>;
    responseActions: Array<'send_input' | 'pause' | 'cancel'>;
    turnId?: string;
}

export interface GoalExecutionControl {
    load(): Promise<GoalControlSnapshot>;
    heartbeat(): Promise<void>;
    setActiveTurn(turnId: string | null): Promise<void>;
    markInputDelivered(inputId: string, turnId: string): Promise<void>;
    markInputUndeliverable(inputId: string, reason: string): Promise<void>;
    publishCheckpoint(request: GoalCheckpointRequest, turnId: string): Promise<GoalCheckpointOutcome>;
    rejectCheckpoint(request: GoalCheckpointRejection, turnId: string): Promise<void>;
    appendOutput(records: string[]): Promise<void>;
    /**
     * Persist an open provider blocker for this attempt. Repeated reports update the same blocker.
     * Returns the highest input sequence submitted before the blocker was first opened, captured
     * atomically with opening it, or null when no blocker is open for the report.
     */
    reportBlocker?(report: GoalBlockerReport): Promise<number | null>;
    /** Close an open provider blocker on authoritative evidence that it no longer waits. */
    resolveBlocker?(requestKey: string, resolution: string): Promise<void>;
}

export interface TokenUsage {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
    /**
     * Set when the cache counts above cover only some of the prompts: the known
     * cached subtotal is kept so pricing applies its discount, but it is not a
     * measurement of the whole prompt and must stay out of any hit rate.
     */
    cache_usage_incomplete?: boolean;
    /** Informational subset of output_tokens; never bill separately. */
    reasoning_output_tokens?: number;
}

/**
 * Result from Agent.analyze() - includes response text and metadata for metrics.
 */
export interface AnalysisResult {
    /** The analysis response text */
    response: string;
    /** Model that was actually used */
    modelUsed: string;
    /** Execution time in milliseconds */
    executionTimeMs: number;
    /** Whether the analysis succeeded */
    success: boolean;
    /** Optional token usage metrics */
    tokenUsage?: TokenUsage;
    /** Optional session ID */
    sessionId?: string;
    /** Optional error message if failed */
    error?: string;
}

export interface AnalyzeOptions {
    context?: string;
    model?: string;
    taskId?: string;
    /** The GitHub issue number the task is associated with. */
    taskNumber?: number;
    /** The GitHub PR number when this call is part of a PR follow-up. */
    prNumber?: number;
    /** Type of execution for container naming (e.g., 'plan-generation', 'context-analysis') */
    executionType?: string;
    /** Correlation ID for log tracking */
    correlationId?: string;
    /** Repository in owner/repo format */
    repository?: string;
    /** Additional metadata to include in logs */
    metadata?: Record<string, unknown>;
    /** Optional timeout for lightweight analysis execution. */
    timeoutMs?: number;
    /** Expected response format. Defaults to plain text analysis. */
    responseFormat?: 'text' | 'json';
    /** Optional per-analysis reasoning level override. */
    reasoningLevel?: ReasoningLevel;
    /**
     * Whether an omitted reasoning level may inherit the configured levels meant for
     * implementation runs (the agent's per-model config, then the global setting).
     * Defaults to false so lightweight analysis runs use the model's default effort.
     */
    useConfiguredReasoningLevel?: boolean;
    /** Skip the low-level agent LLM log when a caller persists a higher-level authoritative log. */
    suppressLlmLog?: boolean;
    /** Skip quota collection for latency-sensitive probes. */
    skipUsageTracking?: boolean;
    /**
     * Optional repository workspace exposed to the analysis agent as a read-only
     * bind mount. Omitted analyses continue to use their isolated empty
     * workspace.
     */
    readOnlyWorkspacePath?: string;
    /**
     * Request runtime-enforced repository file read/search tools inside
     * readOnlyWorkspacePath. This never authorizes a general-purpose shell.
     * Scout callers must skip agents without a granular file-tool allowlist.
     */
    allowReadOnlyCommands?: boolean;
}

export interface AgentExecutionResult {
    /** Container-observed workflow validation report, independent of agent prose. */
    repositoryValidation?: string;
    success: boolean;
    logs: string;           // Full stderr/stdout logs
    summary?: string;       // Extracted summary of work
    modifiedFiles: string[];
    cost?: number;          // Estimated cost in USD

    // Metadata
    modelUsed: string;
    /** Model identity observed in provider output, distinct from the requested fallback. */
    providerModel?: string;
    /** Effective reasoning level passed to the agent runtime, when configured. */
    reasoningLevel?: ReasoningLevel;
    sessionId?: string;
    conversationId?: string;
    executionTimeMs: number;

    // Token usage metrics
    tokenUsage?: TokenUsage;

    // Agent Tank subscription usage metrics (for tracking session/weekly usage)
    usageMetrics?: UsageTrackingMetrics;

    // Additional fields for compatibility with existing ClaudeCodeResponse
    rawOutput?: string;
    exitCode?: number | null;
    error?: string;
    /** Why an otherwise publishable implementation run stopped before completion. */
    terminationReason?: AgentTerminationReason;
    commitMessage?: string | null;
    prompt?: string;

    // Conversation log for execution analysis
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    conversationLog?: any[];
}

/**
 * `cost_cap` is set when the run reached its spend cap. `stalled` and
 * `degenerate_output` are set when the activity watchdog stopped a live run
 * (no output past its threshold, or a run of whitespace-only deltas).
 */
export type AgentTerminationReason = 'timeout' | 'max_turns' | 'cost_cap' | 'stalled' | 'degenerate_output' | 'runtime_crash';

export interface Agent {
    readonly config: AgentConfig;

    /** Whether this provider implements a proven durable goal/session path. */
    readonly goalCapable: boolean;

    /**
     * Executes a complex task modifying files in the worktree.
     * Typically runs inside a Docker container.
     */
    executeTask(options: AgentTaskOptions): Promise<AgentExecutionResult>;

    /**
     * Runs a lightweight, read-only analysis.
     * Used for planning, summarization, and PR reviews.
     * Updated to support model override and abort signal.
     * Returns AnalysisResult with response and metadata for metrics tracking.
     */
    analyze(prompt: string, options?: AnalyzeOptions): Promise<AnalysisResult>;

    /**
     * Verifies the agent is ready (e.g. docker image exists).
     */
    healthCheck(): Promise<boolean>;
}

// Re-export types that are commonly needed with agent types
export type { IssueRef, IssueDetails };

/**
 * Agent type identifier.
 */
export type AgentType = SharedAgentType;

/**
 * Container config paths for different agent types.
 * These are the paths inside the Docker container where configs are mounted.
 */
export const CONTAINER_CONFIG_PATHS: Record<AgentType, string> = {
    claude: '/home/node/.claude',
    codex: '/home/node/.codex',
    antigravity: '/home/node/.gemini',
    opencode: '/home/node/.config/opencode',
    vibe: '/home/node/.vibe'
};
