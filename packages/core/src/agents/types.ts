import { IssueRef, IssueDetails } from '../claude/prompts/promptGenerator.js';
import type { CliVersionType } from '../config/configManager.js';

/**
 * Configuration for a specific agent instance.
 * Stored in config.json under 'agents' array.
 */
export interface AgentConfig {
    id: string;             // UUID v4
    type: 'claude' | 'codex' | 'gemini';
    alias: string;          // Human-readable ID (e.g., 'claude-prod', 'codex-beta')
    enabled: boolean;

    // Docker configuration
    dockerImage: string;    // e.g., 'propr-claude:latest'
    configPath: string;     // Host path to mount (e.g., '/root/.claude')

    // Model configuration
    supportedModels: string[]; // List of models this agent supports
    defaultModel?: string;     // Default model if none specified

    // Environment variables to inject into container
    envVars?: Record<string, string>;

    // Custom GitHub labels per model (maps model ID to custom label)
    // e.g., { 'claude-opus-4-5-20251101': 'my-opus-bot', 'claude-sonnet-4-5-20251101': 'my-sonnet-bot' }
    modelCustomLabels?: Record<string, string>;

    // CLI Version Configuration
    cliVersionType?: CliVersionType;  // How the version is specified (default, tag, specific, custom)
    cliVersion?: string;              // User-specified version (e.g., "2.1.84", "stable", "latest")
    cliVersionResolved?: string;      // Resolved semver version (populated by backend)
}

export interface AgentTaskOptions {
    worktreePath: string;
    issueRef: IssueRef;
    issueDetails?: IssueDetails;
    prompt: string;

    // Execution overrides
    model?: string;
    systemPrompt?: string;
    isRetry?: boolean;
    retryReason?: string;

    // Callbacks
    onSessionId?: (sessionId: string, conversationId?: string) => void;
    onContainerId?: (containerId: string, containerName: string) => void;

    // GitHub token for container
    githubToken: string;

    // Branch information
    branchName?: string;

    // Additional options
    tools?: string;

    // Task ID for abort signal checking
    taskId?: string;
}

export interface TokenUsage {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
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

export interface AgentExecutionResult {
    success: boolean;
    logs: string;           // Full stderr/stdout logs
    summary?: string;       // Extracted summary of work
    modifiedFiles: string[];
    cost?: number;          // Estimated cost in USD

    // Metadata
    modelUsed: string;
    sessionId?: string;
    conversationId?: string;
    executionTimeMs: number;

    // Token usage metrics
    tokenUsage?: TokenUsage;

    // Additional fields for compatibility with existing ClaudeCodeResponse
    rawOutput?: string;
    exitCode?: number | null;
    error?: string;
    commitMessage?: string | null;
    prompt?: string;

    // Conversation log for execution analysis
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    conversationLog?: any[];
}

export interface Agent {
    readonly config: AgentConfig;

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
     * @param executionType - Type of execution for container naming (e.g., 'plan-generation', 'context-analysis')
     */
    analyze(prompt: string, context?: string, model?: string, taskId?: string, executionType?: string): Promise<AnalysisResult>;

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
export type AgentType = AgentConfig['type'];

/**
 * Container config paths for different agent types.
 * These are the paths inside the Docker container where configs are mounted.
 */
export const CONTAINER_CONFIG_PATHS: Record<AgentType, string> = {
    claude: '/home/node/.claude',
    codex: '/home/node/.codex',
    gemini: '/home/node/.gemini'
};

