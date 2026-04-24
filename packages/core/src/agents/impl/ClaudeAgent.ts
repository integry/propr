/**
 * Claude Agent Implementation.
 *
 * This module provides the ClaudeAgent class that executes tasks using
 * Claude AI running inside a Docker container. It handles task execution,
 * lightweight analysis, and health checks.
 */

import logger from '../../utils/logger.js';
import {
    Agent,
    AgentConfig,
    AgentTaskOptions,
    AgentExecutionResult,
    AnalysisResult,
    AnalyzeOptions,
    TokenUsage
} from '../types.js';
import { executeDockerCommand, ExecutionResult } from '../../claude/docker/dockerExecutor.js';
import {
    verifyWorktreeStructure,
    verifyWorktreePostExecution,
    setWorktreeOwnership,
    parseStreamJsonOutput,
    storePromptInRedis,
    buildClaudePrompt,
    UsageLimitError
} from '../../claude/claudeHelpers.js';
import { resolveModelAlias, NoDefaultModelConfiguredError } from '../../config/modelAliases.js';
import { persistLlmLog, createLlmLogFromAnalysis, buildTaskWorkRef, buildAnalysisWorkRef, formatUsageMetrics } from '../../utils/llmLogger.js';
import { processDockerResult, buildDockerArgs, getCorrectedTokenUsage, ensurePromptInConversationLog, executeWithUsageTracking, type UsageTrackingMetrics } from './utils/index.js';
import type { ExecutionType } from '../../utils/llmMetrics.types.js';

// Re-export UsageLimitError for convenience
export { UsageLimitError };

/** Default maximum conversation turns for Claude */
const DEFAULT_CLAUDE_MAX_TURNS = 1000;

/** Default timeout for Claude execution in milliseconds */
const DEFAULT_CLAUDE_TIMEOUT_MS = 300000;

/**
 * Parameters for persisting execution logs.
 */
interface PersistLogsParams {
    result: ExecutionResult;
    prompt: string;
    issueRef: { number: number; repoOwner: string; repoName: string };
    modelUsed: string;
    isRetry: boolean;
    retryReason?: string;
    executionTime: number;
    correctedTokenUsage: TokenUsage | undefined;
    taskId?: string;
    prNumber?: number;
    usageMetrics?: UsageTrackingMetrics | null;
}

/**
 * ClaudeAgent implements the Agent interface for Claude AI.
 *
 * This agent runs Claude inside a Docker container to execute tasks
 * that modify code in a git worktree. It supports:
 * - Full task execution with code modifications
 * - Lightweight read-only analysis
 * - Health checks to verify Docker image availability
 */
export class ClaudeAgent implements Agent {
    readonly config: AgentConfig;
    private readonly maxTurns: number;
    private readonly timeoutMs: number;

    constructor(config: AgentConfig) {
        this.config = config;
        this.maxTurns = parseInt(
            process.env.CLAUDE_MAX_TURNS || String(DEFAULT_CLAUDE_MAX_TURNS),
            10
        );
        this.timeoutMs = parseInt(
            process.env.CLAUDE_TIMEOUT_MS || String(DEFAULT_CLAUDE_TIMEOUT_MS),
            10
        );
    }

    /**
     * Executes a task that modifies files in the worktree.
     *
     * This method:
     * 1. Builds the Claude prompt with safety rules
     * 2. Sets up worktree ownership for container access
     * 3. Verifies worktree structure before execution
     * 4. Runs Claude in a Docker container
     * 5. Processes results and corrects token usage
     * 6. Persists execution logs
     * 7. Verifies worktree integrity after execution
     */
    async executeTask(options: AgentTaskOptions): Promise<AgentExecutionResult> {
        const {
            worktreePath,
            issueRef,
            prompt: customPrompt,
            model,
            systemPrompt,
            isRetry = false,
            retryReason,
            branchName,
            issueDetails,
            onSessionId,
            onContainerId,
            githubToken,
            tools,
            taskId,
            prNumber
        } = options;

        const startTime = Date.now();
        const effectiveModel = model || this.config.defaultModel;
        if (!effectiveModel) {
            throw new NoDefaultModelConfiguredError();
        }
        const repo = `${issueRef.repoOwner}/${issueRef.repoName}`;

        logger.info({
            issueNumber: issueRef.number,
            repository: repo,
            worktreePath,
            dockerImage: this.config.dockerImage,
            agentAlias: this.config.alias,
            isRetry,
            retryReason
        }, isRetry ? 'Starting Claude agent execution (RETRY)...' : 'Starting Claude agent execution...');

        try {
            // Build prompt with safety rules
            const prompt = buildClaudePrompt({
                customPrompt,
                issueRef,
                branchName,
                modelName: effectiveModel,
                issueDetails,
                isRetry,
                retryReason
            });

            // Prepare worktree for container access
            await setWorktreeOwnership(worktreePath, issueRef.number);
            const worktreeGitContent = verifyWorktreeStructure(worktreePath, issueRef.number);

            // Build Docker arguments and execute
            const dockerArgs = buildDockerArgs(this.config, this.maxTurns, {
                worktreePath,
                githubToken,
                modelName: effectiveModel,
                issueNumber: issueRef.number,
                systemPrompt,
                tools,
                taskId
            });

            // Wrap execution with Agent Tank usage tracking
            const { result, usageMetrics } = await executeWithUsageTracking(
                'claude',
                async () => executeDockerCommand('docker', dockerArgs, {
                    timeout: this.timeoutMs,
                    cwd: worktreePath,
                    onSessionId,
                    onContainerId,
                    worktreePath,
                    stdinData: prompt,
                    taskId
                })
            );

            const executionTime = Date.now() - startTime;

            logger.info({
                issueNumber: issueRef.number,
                repository: repo,
                executionTime,
                outputLength: result.stdout?.length || 0,
                success: result.exitCode === 0,
                exitCode: result.exitCode,
                agentAlias: this.config.alias
            }, 'Claude agent execution completed');

            // Process result and correct token usage
            const { response, correctedTokenUsage, modelUsed } = processDockerResult(
                result,
                prompt,
                effectiveModel,
                executionTime
            );

            // Persist execution logs with usage metrics
            await this.persistExecutionLogs({
                result,
                prompt,
                issueRef,
                modelUsed,
                isRetry,
                retryReason,
                executionTime,
                correctedTokenUsage,
                taskId,
                prNumber,
                usageMetrics
            });

            // Log outcome and verify worktree
            if (!response.success) {
                logger.error({
                    issueNumber: issueRef.number,
                    exitCode: result.exitCode,
                    stderr: result.stderr,
                    agentAlias: this.config.alias
                }, 'Claude agent execution failed');
            } else {
                logger.info({
                    issueNumber: issueRef.number,
                    model: modelUsed,
                    agentAlias: this.config.alias
                }, 'Claude agent execution succeeded');
                verifyWorktreePostExecution(worktreePath, issueRef.number, worktreeGitContent);
            }

            return response;
        } catch (error) {
            if (error instanceof UsageLimitError) {
                throw error;
            }

            const executionTime = Date.now() - startTime;
            logger.error({
                issueNumber: issueRef.number,
                repository: repo,
                executionTime,
                error: (error as Error).message,
                agentAlias: this.config.alias
            }, 'Error during Claude agent execution');

            return {
                success: false,
                error: (error as Error).message,
                executionTimeMs: executionTime,
                logs: (error as { stderr?: string }).stderr || (error as Error).message,
                modifiedFiles: [],
                commitMessage: null,
                summary: undefined,
                modelUsed: this.config.defaultModel || 'unknown'
            };
        }
    }

    /**
     * Runs a lightweight, read-only analysis.
     *
     * This method is used for planning, summarization, and PR reviews.
     * It runs Claude with instructions to only provide analysis without
     * modifying any files.
     */
    async analyze(
        prompt: string,
        options?: AnalyzeOptions
    ): Promise<AnalysisResult> {
        const { context, model, taskId, executionType, correlationId, repository, metadata } = options || {};
        const startTime = Date.now();

        logger.info({
            agentAlias: this.config.alias,
            promptLength: prompt.length,
            hasContext: !!context,
            requestedModel: model,
            taskId,
            executionType
        }, 'Running lightweight analysis via Claude agent...');

        const effectiveModel = model || resolveModelAlias('haiku');
        const suffix = '\n\nCRITICAL: Do not modify any files. Do not run any commands. Only provide your analysis as plain text output.';
        const analysisPrompt = context
            ? `${prompt}\n\nContext:\n${context}${suffix}`
            : `${prompt}${suffix}`;

        try {
            const dockerArgs = buildDockerArgs(this.config, this.maxTurns, {
                worktreePath: '/tmp/claude-analysis',
                githubToken: process.env.GITHUB_TOKEN || '',
                modelName: effectiveModel,
                issueNumber: 0,
                systemPrompt: 'You are a helpful assistant.',
                tools: '',
                taskId,
                executionType
            });

            // Wrap execution with Agent Tank usage tracking
            const { result, usageMetrics } = await executeWithUsageTracking(
                'claude',
                async () => executeDockerCommand('docker', dockerArgs, {
                    timeout: 1800000,
                    stdinData: analysisPrompt,
                    taskId
                })
            );

            const executionTimeMs = Date.now() - startTime;
            const claudeOutput = parseStreamJsonOutput(result);

            // Ensure the prompt is in the conversation log and get corrected token usage
            const fullConversationLog = ensurePromptInConversationLog(
                claudeOutput.conversationLog,
                analysisPrompt
            );
            const correctedTokenUsage = getCorrectedTokenUsage(
                claudeOutput.tokenUsage,
                fullConversationLog
            );

            if (claudeOutput.finalResult?.result || claudeOutput.success) {
                const analysisText = (claudeOutput.finalResult?.result || '').trim();
                logger.info({
                    agentAlias: this.config.alias,
                    responseLength: analysisText.length,
                    model: effectiveModel,
                    executionTimeMs,
                    reportedTokens: claudeOutput.tokenUsage,
                    correctedTokens: correctedTokenUsage,
                    usageMetrics: usageMetrics ? { delta: usageMetrics.delta } : null
                }, 'Lightweight analysis completed');

                // Persist LLM log with usage metrics for analysis calls
                const usage = formatUsageMetrics(usageMetrics);
                await persistLlmLog(createLlmLogFromAnalysis({
                    executionType: (executionType || 'other') as ExecutionType,
                    modelUsed: claudeOutput.model || effectiveModel,
                    executionTimeMs,
                    success: true,
                    tokenUsage: correctedTokenUsage,
                    sessionId: claudeOutput.sessionId ?? undefined,
                    draftId: taskId,
                    correlationId,
                    repository,
                    metadata,
                    agentAlias: this.config.alias,
                    usageMetrics: usage.metrics,
                    usageMetricRecords: usage.records,
                    workRef: buildAnalysisWorkRef(executionType, taskId, repository),
                }));

                return {
                    response: analysisText,
                    modelUsed: claudeOutput.model || effectiveModel,
                    executionTimeMs,
                    success: true,
                    tokenUsage: correctedTokenUsage,
                    sessionId: claudeOutput.sessionId ?? undefined
                };
            }

            return {
                response: '',
                modelUsed: effectiveModel,
                executionTimeMs,
                success: false,
                error: `Analysis failed: ${result.stderr || 'No result returned'}`
            };
        } catch (error) {
            const executionTimeMs = Date.now() - startTime;
            logger.error({
                agentAlias: this.config.alias,
                error: (error as Error).message,
                executionTimeMs
            }, 'Lightweight analysis failed');

            return {
                response: '',
                modelUsed: effectiveModel,
                executionTimeMs,
                success: false,
                error: (error as Error).message
            };
        }
    }

    /**
     * Verifies the agent is ready by checking if the Docker image exists.
     */
    async healthCheck(): Promise<boolean> {
        logger.debug({
            agentAlias: this.config.alias,
            dockerImage: this.config.dockerImage
        }, 'Running health check for Claude agent...');

        try {
            const result = await executeDockerCommand(
                'docker',
                ['images', '-q', this.config.dockerImage],
                { timeout: 10000 }
            );

            const imageExists = !!result.stdout.trim();
            logger.info({
                agentAlias: this.config.alias,
                dockerImage: this.config.dockerImage,
                imageExists
            }, imageExists ? 'Health check passed' : 'Health check failed: Docker image not found');

            return imageExists;
        } catch (error) {
            logger.error({
                agentAlias: this.config.alias,
                error: (error as Error).message
            }, 'Health check failed with error');
            return false;
        }
    }

    /**
     * Persists execution logs to Redis and the LLM log store.
     */
    private async persistExecutionLogs(params: PersistLogsParams): Promise<void> {
        const {
            result,
            prompt,
            issueRef,
            modelUsed,
            isRetry,
            retryReason,
            executionTime,
            correctedTokenUsage,
            taskId,
            prNumber,
            usageMetrics
        } = params;

        const claudeOutput = parseStreamJsonOutput(result);

        // Store prompt in Redis for retrieval
        await storePromptInRedis({
            claudeOutput,
            prompt,
            issueRef,
            model: modelUsed,
            isRetry,
            retryReason
        });

        // Persist LLM log for metrics tracking (including Agent Tank usage if available)
        const repository = `${issueRef.repoOwner}/${issueRef.repoName}`;
        await persistLlmLog(createLlmLogFromAnalysis({
            executionType: 'implementation',
            modelUsed,
            executionTimeMs: executionTime,
            success: claudeOutput.success,
            tokenUsage: correctedTokenUsage,
            error: claudeOutput.success ? undefined : (result.stderr || 'Execution failed'),
            sessionId: claudeOutput.sessionId ?? undefined,
            draftId: taskId,
            repository,
            agentAlias: this.config.alias,
            metadata: {
                isRetry,
                retryReason,
                conversationId: claudeOutput.conversationId
            },
            usageMetrics: usageMetrics ? {
                preCall: usageMetrics.preCall,
                postCall: usageMetrics.postCall,
                delta: usageMetrics.delta,
                timestamp: usageMetrics.timestamp,
                agent: usageMetrics.agent
            } : undefined,
            usageMetricRecords: usageMetrics?.records,
            workRef: buildTaskWorkRef(taskId, issueRef.number, repository, prNumber),
        }));
    }
}
