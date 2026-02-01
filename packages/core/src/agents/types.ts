import { IssueRef, IssueDetails } from '../claude/prompts/promptGenerator.js';

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
    dockerImage: string;    // e.g., 'claude-code-processor:latest'
    configPath: string;     // Host path to mount (e.g., '/root/.claude')

    // Model configuration
    supportedModels: string[]; // List of models this agent supports
    defaultModel?: string;     // Default model if none specified

    // Environment variables to inject into container
    envVars?: Record<string, string>;
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
     * Updated to support model override.
     */
    analyze(prompt: string, context?: string, model?: string): Promise<string>;

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

