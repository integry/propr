import type { Agent, AgentConfig, AgentExecutionResult, AnalysisResult } from '../types.js';
import { UsageLimitError } from '../../claude/claudeHelpers.js';

export { UsageLimitError };

/**
 * @deprecated Gemini is no longer a runnable canonical agent. Use AntigravityAgent.
 */
export class GeminiAgent implements Agent {
    readonly config: AgentConfig;

    constructor(config: AgentConfig) {
        this.config = config;
    }

    async executeTask(): Promise<AgentExecutionResult> {
        return {
            success: false,
            error: 'GeminiAgent is deprecated and no longer runnable. Use AntigravityAgent instead.',
            executionTimeMs: 0,
            logs: 'GeminiAgent is deprecated and no longer runnable. Use AntigravityAgent instead.',
            modifiedFiles: [],
            commitMessage: null,
            summary: undefined,
            modelUsed: this.config.defaultModel || 'unknown'
        };
    }

    async analyze(): Promise<AnalysisResult> {
        return {
            response: '',
            modelUsed: this.config.defaultModel || 'unknown',
            executionTimeMs: 0,
            success: false,
            error: 'GeminiAgent is deprecated and no longer runnable. Use AntigravityAgent instead.'
        };
    }

    async healthCheck(): Promise<boolean> {
        return false;
    }
}
