import path from 'path';
import os from 'os';
import fs from 'fs';
import logger from '../../utils/logger.js';
import { Agent, AgentConfig, AgentTaskOptions, AgentExecutionResult, AnalysisResult, TokenUsage } from '../types.js';
import { executeDockerCommand, ExecutionResult } from '../../claude/docker/dockerExecutor.js';
import {
    verifyWorktreeStructure,
    verifyWorktreePostExecution,
    setWorktreeOwnership,
    parseStreamJsonOutput,
    storePromptInRedis,
    buildClaudePrompt,
    UsageLimitError,
    ConversationLogEntry
} from '../../claude/claudeHelpers.js';
import { resolveModelAlias, getDefaultModel } from '../../config/modelAliases.js';
import { resolveConfigPath } from '../../config/configManager.js';
import { persistLlmLog, createLlmLogFromAnalysis } from '../../utils/llmLogger.js';

// Re-export UsageLimitError for convenience
export { UsageLimitError };

const DEFAULT_CLAUDE_MAX_TURNS = 1000;
const DEFAULT_CLAUDE_TIMEOUT_MS = 300000;

/** Aggregates token usage from all assistant messages in the conversation log */
function aggregateTokensFromConversationLog(conversationLog: ConversationLogEntry[]): TokenUsage {
    const aggregated: TokenUsage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
    for (const entry of conversationLog) {
        if (entry.type === 'assistant' && entry.message) {
            const usage = (entry.message as { usage?: TokenUsage }).usage;
            if (usage) {
                aggregated.input_tokens = (aggregated.input_tokens || 0) + (usage.input_tokens || 0);
                aggregated.output_tokens = (aggregated.output_tokens || 0) + (usage.output_tokens || 0);
                aggregated.cache_creation_input_tokens = (aggregated.cache_creation_input_tokens || 0) + (usage.cache_creation_input_tokens || 0);
                aggregated.cache_read_input_tokens = (aggregated.cache_read_input_tokens || 0) + (usage.cache_read_input_tokens || 0);
            }
        }
    }
    return aggregated;
}

/** Returns the better token usage between reported and aggregated values */
function getCorrectedTokenUsage(reported: TokenUsage | undefined, conversationLog: ConversationLogEntry[]): TokenUsage | undefined {
    const aggregated = aggregateTokensFromConversationLog(conversationLog);
    const aggregatedTotal = (aggregated.input_tokens || 0) + (aggregated.output_tokens || 0);
    const reportedTotal = (reported?.input_tokens || 0) + (reported?.output_tokens || 0);
    if (aggregatedTotal > reportedTotal) {
        logger.debug({ reportedInputTokens: reported?.input_tokens, reportedOutputTokens: reported?.output_tokens, aggregatedInputTokens: aggregated.input_tokens, aggregatedOutputTokens: aggregated.output_tokens }, 'Using aggregated token usage (higher than reported)');
        return aggregated;
    }
    return reported;
}

/** Ensures the initial prompt is included in the conversation log */
function ensurePromptInConversationLog(conversationLog: ConversationLogEntry[], prompt: string): ConversationLogEntry[] {
    if (conversationLog.length > 0 && conversationLog[0].type === 'user') return conversationLog;
    return [{ type: 'user', message: { id: 'initial-prompt' }, timestamp: new Date().toISOString(), content: [{ type: 'text', text: prompt }] }, ...conversationLog];
}

interface ProcessedResult { response: AgentExecutionResult; correctedTokenUsage: TokenUsage | undefined; modelUsed: string; }

/** Processes Docker execution result and builds the agent response */
function processDockerResult(result: ExecutionResult, prompt: string, effectiveModel: string, executionTime: number): ProcessedResult {
    const claudeOutput = parseStreamJsonOutput(result);
    const modelUsed = claudeOutput.model || effectiveModel || getDefaultModel();
    const fullConversationLog = ensurePromptInConversationLog(claudeOutput.conversationLog, prompt);
    const correctedTokenUsage = getCorrectedTokenUsage(claudeOutput.tokenUsage, fullConversationLog);
    return {
        response: {
            success: claudeOutput.success, executionTimeMs: executionTime, logs: result.stderr || '', exitCode: result.exitCode,
            rawOutput: result.stdout, sessionId: claudeOutput.sessionId ?? undefined, conversationId: claudeOutput.conversationId,
            modelUsed, cost: claudeOutput.finalResult?.total_cost_usd || claudeOutput.finalResult?.cost_usd, modifiedFiles: [],
            commitMessage: null, summary: claudeOutput.finalResult?.result ?? undefined, prompt, conversationLog: fullConversationLog, tokenUsage: correctedTokenUsage
        },
        correctedTokenUsage, modelUsed
    };
}

export class ClaudeAgent implements Agent {
    readonly config: AgentConfig;
    private readonly maxTurns: number;
    private readonly timeoutMs: number;

    constructor(config: AgentConfig) {
        this.config = config;
        this.maxTurns = parseInt(process.env.CLAUDE_MAX_TURNS || String(DEFAULT_CLAUDE_MAX_TURNS), 10);
        this.timeoutMs = parseInt(process.env.CLAUDE_TIMEOUT_MS || String(DEFAULT_CLAUDE_TIMEOUT_MS), 10);
    }

    async executeTask(options: AgentTaskOptions): Promise<AgentExecutionResult> {
        const { worktreePath, issueRef, prompt: customPrompt, model, systemPrompt, isRetry = false, retryReason, branchName, issueDetails, onSessionId, onContainerId, githubToken, tools, taskId } = options;
        const startTime = Date.now();
        const effectiveModel = model || this.config.defaultModel || getDefaultModel();
        const repo = `${issueRef.repoOwner}/${issueRef.repoName}`;
        logger.info({ issueNumber: issueRef.number, repository: repo, worktreePath, dockerImage: this.config.dockerImage, agentAlias: this.config.alias, isRetry, retryReason }, isRetry ? 'Starting Claude agent execution (RETRY)...' : 'Starting Claude agent execution...');

        try {
            const prompt = buildClaudePrompt({ customPrompt, issueRef, branchName, modelName: effectiveModel, issueDetails, isRetry, retryReason });
            await setWorktreeOwnership(worktreePath, issueRef.number);
            const worktreeGitContent = verifyWorktreeStructure(worktreePath, issueRef.number);
            const dockerArgs = this.buildDockerArgs({ worktreePath, githubToken, modelName: effectiveModel, issueNumber: issueRef.number, systemPrompt, tools });
            const result = await executeDockerCommand('docker', dockerArgs, { timeout: this.timeoutMs, cwd: worktreePath, onSessionId, onContainerId, worktreePath, stdinData: prompt, taskId });
            const executionTime = Date.now() - startTime;
            logger.info({ issueNumber: issueRef.number, repository: repo, executionTime, outputLength: result.stdout?.length || 0, success: result.exitCode === 0, exitCode: result.exitCode, agentAlias: this.config.alias }, 'Claude agent execution completed');
            const { response, correctedTokenUsage, modelUsed } = processDockerResult(result, prompt, effectiveModel, executionTime);
            await this.persistExecutionLogs({ result, prompt, issueRef, modelUsed, isRetry, retryReason, executionTime, correctedTokenUsage, taskId });
            if (!response.success) {
                logger.error({ issueNumber: issueRef.number, exitCode: result.exitCode, stderr: result.stderr, agentAlias: this.config.alias }, 'Claude agent execution failed');
            } else {
                logger.info({ issueNumber: issueRef.number, model: modelUsed, agentAlias: this.config.alias }, 'Claude agent execution succeeded');
                verifyWorktreePostExecution(worktreePath, issueRef.number, worktreeGitContent);
            }
            return response;
        } catch (error) {
            if (error instanceof UsageLimitError) throw error;
            const executionTime = Date.now() - startTime;
            logger.error({ issueNumber: issueRef.number, repository: repo, executionTime, error: (error as Error).message, agentAlias: this.config.alias }, 'Error during Claude agent execution');
            return { success: false, error: (error as Error).message, executionTimeMs: executionTime, logs: (error as { stderr?: string }).stderr || (error as Error).message, modifiedFiles: [], commitMessage: null, summary: undefined, modelUsed: this.config.defaultModel || getDefaultModel() };
        }
    }

    async analyze(prompt: string, context?: string, model?: string, taskId?: string): Promise<AnalysisResult> {
        const startTime = Date.now();
        logger.info({ agentAlias: this.config.alias, promptLength: prompt.length, hasContext: !!context, requestedModel: model, taskId }, 'Running lightweight analysis via Claude agent...');
        const effectiveModel = model || resolveModelAlias('haiku');
        const suffix = '\n\nCRITICAL: Do not modify any files. Do not run any commands. Only provide your analysis as plain text output.';
        const analysisPrompt = context ? `${prompt}\n\nContext:\n${context}${suffix}` : `${prompt}${suffix}`;
        try {
            const dockerArgs = this.buildDockerArgs({ worktreePath: '/tmp/claude-analysis', githubToken: process.env.GITHUB_TOKEN || '', modelName: effectiveModel, issueNumber: 0, systemPrompt: 'You are a helpful assistant.', tools: '' });
            const result = await executeDockerCommand('docker', dockerArgs, { timeout: 1800000, stdinData: analysisPrompt, taskId });
            const executionTimeMs = Date.now() - startTime;
            const claudeOutput = parseStreamJsonOutput(result);
            if (claudeOutput.finalResult?.result || claudeOutput.success) {
                const analysisText = (claudeOutput.finalResult?.result || '').trim();
                logger.info({ agentAlias: this.config.alias, responseLength: analysisText.length, model: effectiveModel, executionTimeMs }, 'Lightweight analysis completed');
                return { response: analysisText, modelUsed: claudeOutput.model || effectiveModel, executionTimeMs, success: true, tokenUsage: claudeOutput.tokenUsage, sessionId: claudeOutput.sessionId ?? undefined };
            }
            return { response: '', modelUsed: effectiveModel, executionTimeMs, success: false, error: `Analysis failed: ${result.stderr || 'No result returned'}` };
        } catch (error) {
            const executionTimeMs = Date.now() - startTime;
            logger.error({ agentAlias: this.config.alias, error: (error as Error).message, executionTimeMs }, 'Lightweight analysis failed');
            return { response: '', modelUsed: effectiveModel, executionTimeMs, success: false, error: (error as Error).message };
        }
    }

    async healthCheck(): Promise<boolean> {
        logger.debug({ agentAlias: this.config.alias, dockerImage: this.config.dockerImage }, 'Running health check for Claude agent...');
        try {
            const result = await executeDockerCommand('docker', ['images', '-q', this.config.dockerImage], { timeout: 10000 });
            const imageExists = !!result.stdout.trim();
            logger.info({ agentAlias: this.config.alias, dockerImage: this.config.dockerImage, imageExists }, imageExists ? 'Health check passed' : 'Health check failed: Docker image not found');
            return imageExists;
        } catch (error) {
            logger.error({ agentAlias: this.config.alias, error: (error as Error).message }, 'Health check failed with error');
            return false;
        }
    }

    /** Persists execution logs to Redis and LLM log store */
    private async persistExecutionLogs(params: { result: ExecutionResult; prompt: string; issueRef: { number: number; repoOwner: string; repoName: string }; modelUsed: string; isRetry: boolean; retryReason?: string; executionTime: number; correctedTokenUsage: TokenUsage | undefined; taskId?: string; }): Promise<void> {
        const { result, prompt, issueRef, modelUsed, isRetry, retryReason, executionTime, correctedTokenUsage, taskId } = params;
        const claudeOutput = parseStreamJsonOutput(result);
        await storePromptInRedis({ claudeOutput, prompt, issueRef, model: modelUsed, isRetry, retryReason });
        await persistLlmLog(createLlmLogFromAnalysis({
            executionType: 'implementation', modelUsed, executionTimeMs: executionTime, success: claudeOutput.success, tokenUsage: correctedTokenUsage,
            error: claudeOutput.success ? undefined : (result.stderr || 'Execution failed'), sessionId: claudeOutput.sessionId ?? undefined, draftId: taskId,
            repository: `${issueRef.repoOwner}/${issueRef.repoName}`, agentAlias: this.config.alias, metadata: { isRetry, retryReason, conversationId: claudeOutput.conversationId }
        }));
    }

    /** Builds Docker arguments for running Claude in a container */
    private buildDockerArgs(params: { worktreePath: string; githubToken: string; modelName?: string; issueNumber: number; systemPrompt?: string; tools?: string; }): string[] {
        const { worktreePath, githubToken, modelName, issueNumber, systemPrompt, tools } = params;
        const configPath = resolveConfigPath(this.config.configPath);
        const envVars: string[] = [];
        if (this.config.envVars) {
            for (const [key, value] of Object.entries(this.config.envVars)) envVars.push('-e', `${key}=${value}`);
        }
        const claudeJsonPath = path.join(os.homedir(), '.claude.json');
        const dockerArgs: string[] = [
            'run', '--rm', '-i', '--security-opt', 'no-new-privileges', '--cap-add', 'CHOWN', '--network', 'bridge', '--user', '0:0',
            '-v', `${worktreePath}:/home/node/workspace:rw`, '-v', '/tmp/git-processor:/tmp/git-processor:rw', '-v', '/tmp/claude-logs:/tmp/claude-logs:rw',
            '-v', `${configPath}:/home/node/.claude:rw`, ...(fs.existsSync(claudeJsonPath) ? ['-v', `${claudeJsonPath}:/home/node/.claude.json:rw`] : []),
            '-e', `GH_TOKEN=${githubToken}`, ...envVars, '-w', '/home/node/workspace', this.config.dockerImage,
            'claude', '-p', '-', '--max-turns', this.maxTurns.toString(), '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions'
        ];
        if (modelName) {
            dockerArgs.splice(dockerArgs.indexOf('--max-turns'), 0, '--model', modelName);
            logger.info({ issueNumber, requestedModel: modelName, agentAlias: this.config.alias }, 'Using specific model for Claude agent execution');
        } else {
            logger.debug({ issueNumber, agentAlias: this.config.alias }, 'No model specified, Claude agent will use default');
        }
        if (systemPrompt !== undefined) {
            dockerArgs.push('--system-prompt', systemPrompt);
            logger.info({ issueNumber, systemPromptLength: systemPrompt.length, agentAlias: this.config.alias }, 'Using custom system prompt');
        }
        if (tools !== undefined) {
            dockerArgs.push('--tools', tools);
            logger.info({ issueNumber, tools, agentAlias: this.config.alias }, 'Using custom tools configuration');
        }
        logger.info({ issueNumber, hasSystemPrompt: systemPrompt !== undefined, hasTools: tools !== undefined, agentAlias: this.config.alias }, 'Docker args built for Claude agent');
        return dockerArgs;
    }
}
