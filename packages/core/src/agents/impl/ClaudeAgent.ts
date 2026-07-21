/** Claude Agent Implementation. */

import logger from '../../utils/logger.js';
import {
    Agent,
    AgentConfig,
    AgentTaskOptions,
    AgentExecutionResult,
    AnalysisResult,
    AnalyzeOptions
} from '../types.js';
import { executeDockerCommand } from '../../claude/docker/dockerExecutor.js';
import {
    verifyWorktreeStructure,
    verifyWorktreePostExecution,
    setWorktreeOwnership,
    parseStreamJsonOutput,
    storePromptInRedis,
    buildClaudePrompt,
    UsageLimitError,
    type ClaudeOutput
} from '../../claude/claudeHelpers.js';
import { resolveModelAlias, NoDefaultModelConfiguredError } from '../../config/modelAliases.js';
import {
    assertReasoningLevelCliVersionSupported,
    loadModelReasoningLevel,
    resolveClaudeReasoningLevel,
    type ClaudeRuntimeReasoningLevel,
    type ModelReasoningLevel
} from '../../config/configManager.js';
import { AGENT_DEFAULT_VERSIONS } from '../version/types.js';
import { persistLlmLog, createLlmLogFromAnalysis, buildTaskWorkRef, buildAnalysisWorkRef, formatUsageMetrics } from '../../utils/llmLogger.js';
import { processDockerResult, buildDockerArgs, getCorrectedTokenUsage, ensurePromptInConversationLog, executeWithUsageTracking, getClaudeAnalysisText, type PersistLogsParams } from './utils/index.js';
import type { ExecutionType } from '../../utils/llmMetrics.types.js';

export { UsageLimitError };

const DEFAULT_CLAUDE_MAX_TURNS = 1000;
const DEFAULT_CLAUDE_TIMEOUT_MS = 300000;
const ANALYSIS_AGENT_TANK_TIMEOUT_MS = parseInt(process.env.ANALYSIS_AGENT_TANK_TIMEOUT_MS || '2000', 10);

type AnalysisOutcome = { isSuccess: true } | { isSuccess: false; errorDetail: string };

/**
 * Decides whether a parsed agent result represents a successful analysis.
 *
 * A result line flagged with is_error (e.g. an API 400 such as "Prompt is too long")
 * still carries text in `result`. It must be treated as a failure so retry/fallback logic
 * can act, instead of handing the error string back as a "successful" analysis that
 * downstream JSON parsing then silently rejects.
 */
export function resolveAnalysisOutcome(claudeOutput: ClaudeOutput, stderr: string): AnalysisOutcome {
    const finalResult = claudeOutput.finalResult;
    if (finalResult?.is_error !== true && (finalResult?.result || claudeOutput.success)) {
        return { isSuccess: true };
    }
    const errorDetail = finalResult?.is_error && finalResult.result
        ? finalResult.result
        : (stderr || 'No result returned');
    return { isSuccess: false, errorDetail };
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

    /** Executes a task that modifies files in the worktree. */
    async executeTask(options: AgentTaskOptions): Promise<AgentExecutionResult> {
        const {
            worktreePath, issueRef, prompt: customPrompt, model, systemPrompt,
            isRetry = false, retryReason, branchName, issueDetails,
            onSessionId, onContainerId, githubToken, tools, environment, taskId, prNumber, reasoningLevel
        } = options;

        const startTime = Date.now();
        const effectiveModel = model || this.config.defaultModel;
        if (!effectiveModel) throw new NoDefaultModelConfiguredError();
        const repo = `${issueRef.repoOwner}/${issueRef.repoName}`;

        logger.info({
            issueNumber: issueRef.number, repository: repo, worktreePath,
            dockerImage: this.config.dockerImage, agentAlias: this.config.alias, isRetry, retryReason
        }, isRetry ? 'Starting Claude agent execution (RETRY)...' : 'Starting Claude agent execution...');

        try {
            const prompt = buildClaudePrompt({
                customPrompt, issueRef, branchName, modelName: effectiveModel, issueDetails, isRetry, retryReason
            });

            await setWorktreeOwnership(worktreePath, issueRef.number);
            const worktreeGitContent = verifyWorktreeStructure(worktreePath, issueRef.number);

            const dockerArgs = buildDockerArgs(this.config, this.maxTurns, {
                worktreePath, githubToken, modelName: effectiveModel, issueNumber: issueRef.number,
                systemPrompt, tools, environment, taskId,
                reasoningLevel: await this.resolveEffectiveReasoningLevel(reasoningLevel)
            });

            const { result, usageMetrics } = await executeWithUsageTracking(
                'claude',
                async () => executeDockerCommand('docker', dockerArgs, {
                    timeout: this.timeoutMs, cwd: worktreePath, onSessionId, onContainerId,
                    worktreePath, stdinData: prompt, taskId
                })
            );

            const executionTime = Date.now() - startTime;

            logger.info({
                issueNumber: issueRef.number, repository: repo, executionTime,
                outputLength: result.stdout?.length || 0, success: result.exitCode === 0,
                exitCode: result.exitCode, agentAlias: this.config.alias
            }, 'Claude agent execution completed');

            const { response, correctedTokenUsage, modelUsed } = processDockerResult(result, prompt, effectiveModel, executionTime);

            await this.persistExecutionLogs({
                result, prompt, issueRef, modelUsed, isRetry, retryReason,
                executionTime, correctedTokenUsage, taskId, prNumber, usageMetrics
            });

            if (!response.success) {
                logger.error({ issueNumber: issueRef.number, exitCode: result.exitCode, stderr: result.stderr, agentAlias: this.config.alias }, 'Claude agent execution failed');
            } else {
                logger.info({ issueNumber: issueRef.number, model: modelUsed, agentAlias: this.config.alias }, 'Claude agent execution succeeded');
                verifyWorktreePostExecution(worktreePath, issueRef.number, worktreeGitContent);
            }

            if (usageMetrics) response.usageMetrics = usageMetrics;
            return response;
        } catch (error) {
            if (error instanceof UsageLimitError) throw error;

            const executionTime = Date.now() - startTime;
            logger.error({
                issueNumber: issueRef.number, repository: repo, executionTime,
                error: (error as Error).message, agentAlias: this.config.alias
            }, 'Error during Claude agent execution');

            return {
                success: false, error: (error as Error).message, executionTimeMs: executionTime,
                logs: (error as { stderr?: string }).stderr || (error as Error).message,
                modifiedFiles: [], commitMessage: null, summary: undefined,
                modelUsed: this.config.defaultModel || 'unknown'
            };
        }
    }

    /** Runs a lightweight, read-only analysis for planning, summarization, and PR reviews. */
    async analyze(prompt: string, options?: AnalyzeOptions): Promise<AnalysisResult> {
        const { context, model, taskId, taskNumber, prNumber, executionType, correlationId, repository, metadata, timeoutMs, responseFormat = 'text', suppressLlmLog } = options || {};
        const startTime = Date.now();

        logger.info({
            agentAlias: this.config.alias, promptLength: prompt.length, hasContext: !!context,
            requestedModel: model, taskId, executionType
        }, 'Running lightweight analysis via Claude agent...');

        const effectiveModel = model || resolveModelAlias('haiku');
        const suffix = responseFormat === 'json'
            ? '\n\nCRITICAL: Do not modify any files. Do not run any commands. Return only valid JSON matching the requested schema. Do not include markdown or explanatory text.'
            : '\n\nCRITICAL: Do not modify any files. Do not run any commands. Only provide your analysis as plain text output.';
        const analysisPrompt = context ? `${prompt}\n\nContext:\n${context}${suffix}` : `${prompt}${suffix}`;

        try {
            const dockerArgs = buildDockerArgs(this.config, this.maxTurns, {
                worktreePath: '/tmp/claude-analysis', githubToken: process.env.GITHUB_TOKEN || '',
                modelName: effectiveModel, issueNumber: 0, systemPrompt: 'You are a helpful assistant.',
                tools: '', taskId, executionType,
                reasoningLevel: await this.resolveEffectiveReasoningLevel()
            });

            const { result, usageMetrics } = await executeWithUsageTracking(
                'claude',
                async () => executeDockerCommand('docker', dockerArgs, {
                    timeout: timeoutMs ?? 1800000, stdinData: analysisPrompt, taskId
                }),
                ANALYSIS_AGENT_TANK_TIMEOUT_MS
            );

            const executionTimeMs = Date.now() - startTime;
            const claudeOutput = parseStreamJsonOutput(result);

            const fullConversationLog = ensurePromptInConversationLog(claudeOutput.conversationLog, analysisPrompt);
            const correctedTokenUsage = getCorrectedTokenUsage(claudeOutput.tokenUsage, fullConversationLog);

            const outcome = resolveAnalysisOutcome(claudeOutput, result.stderr);
            if (outcome.isSuccess) {
                const analysisText = getClaudeAnalysisText(claudeOutput);
                logger.info({
                    agentAlias: this.config.alias, responseLength: analysisText.length, model: effectiveModel,
                    executionTimeMs, reportedTokens: claudeOutput.tokenUsage, correctedTokens: correctedTokenUsage,
                    usageMetrics: usageMetrics ? { delta: usageMetrics.delta } : null
                }, 'Lightweight analysis completed');

                if (!suppressLlmLog) {
                    const usage = formatUsageMetrics(usageMetrics);
                    await persistLlmLog(createLlmLogFromAnalysis({
                        executionType: (executionType || 'other') as ExecutionType,
                        modelUsed: claudeOutput.model || effectiveModel, executionTimeMs, success: true,
                        tokenUsage: correctedTokenUsage, sessionId: claudeOutput.sessionId ?? undefined,
                        draftId: taskId, correlationId, repository, metadata, agentAlias: this.config.alias,
                        usageMetrics: usage.metrics, usageMetricRecords: usage.records,
                        workRef: buildAnalysisWorkRef(executionType, taskId, repository, { taskNumber, prNumber }),
                    }));
                }

                return {
                    response: analysisText, modelUsed: claudeOutput.model || effectiveModel,
                    executionTimeMs, success: true, tokenUsage: correctedTokenUsage,
                    sessionId: claudeOutput.sessionId ?? undefined
                };
            }

            return {
                response: '', modelUsed: effectiveModel, executionTimeMs, success: false,
                error: `Analysis failed: ${outcome.errorDetail}`
            };
        } catch (error) {
            const executionTimeMs = Date.now() - startTime;
            logger.error({ agentAlias: this.config.alias, error: (error as Error).message, executionTimeMs }, 'Lightweight analysis failed');
            return {
                response: '', modelUsed: effectiveModel, executionTimeMs, success: false, error: (error as Error).message
            };
        }
    }

    /** Loads the configured reasoning level when it is supported by this agent runtime. */
    private async resolveEffectiveReasoningLevel(reasoningLevel?: ModelReasoningLevel): Promise<ClaudeRuntimeReasoningLevel | ''> {
        const configuredLevel = reasoningLevel === undefined ? await loadModelReasoningLevel() : reasoningLevel;
        const runtimeLevel = resolveClaudeReasoningLevel(configuredLevel) ?? '';
        assertReasoningLevelCliVersionSupported({
            agentType: 'claude',
            agentAlias: this.config.alias,
            cliVersion: this.config.cliVersionResolved ?? AGENT_DEFAULT_VERSIONS.claude,
            reasoningLevel: runtimeLevel
        });
        return runtimeLevel;
    }

    /** Verifies the agent is ready by checking if the Docker image exists. */
    async healthCheck(): Promise<boolean> {
        logger.debug({ agentAlias: this.config.alias, dockerImage: this.config.dockerImage }, 'Running health check for Claude agent...');
        try {
            const result = await executeDockerCommand('docker', ['images', '-q', this.config.dockerImage], { timeout: 10000 });
            const imageExists = !!result.stdout.trim();
            logger.info({
                agentAlias: this.config.alias, dockerImage: this.config.dockerImage, imageExists
            }, imageExists ? 'Health check passed' : 'Health check failed: Docker image not found');
            return imageExists;
        } catch (error) {
            logger.error({ agentAlias: this.config.alias, error: (error as Error).message }, 'Health check failed with error');
            return false;
        }
    }

    /** Persists execution logs to Redis and the LLM log store. */
    private async persistExecutionLogs(params: PersistLogsParams): Promise<void> {
        const { result, prompt, issueRef, modelUsed, isRetry, retryReason, executionTime, correctedTokenUsage, taskId, prNumber, usageMetrics } = params;
        const claudeOutput = parseStreamJsonOutput(result);

        await storePromptInRedis({ claudeOutput, prompt, issueRef, model: modelUsed, isRetry, retryReason });

        const repository = `${issueRef.repoOwner}/${issueRef.repoName}`;
        await persistLlmLog(createLlmLogFromAnalysis({
            executionType: 'implementation', modelUsed, executionTimeMs: executionTime,
            success: claudeOutput.success,
            tokenUsage: correctedTokenUsage,
            error: claudeOutput.success ? undefined : (result.stderr || 'Execution failed'),
            sessionId: claudeOutput.sessionId ?? undefined, draftId: taskId, repository,
            agentAlias: this.config.alias,
            metadata: { isRetry, retryReason, conversationId: claudeOutput.conversationId },
            usageMetrics: usageMetrics ? {
                preCall: usageMetrics.preCall, postCall: usageMetrics.postCall,
                delta: usageMetrics.delta, timestamp: usageMetrics.timestamp, agent: usageMetrics.agent
            } : undefined,
            usageMetricRecords: usageMetrics?.records,
            workRef: buildTaskWorkRef(taskId, issueRef.number, repository, prNumber),
        }));
    }
}
