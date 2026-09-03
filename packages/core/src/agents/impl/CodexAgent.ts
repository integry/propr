import fs from 'fs';
import { execSync } from 'child_process';
import logger from '../../utils/logger.js';
import { Agent, AgentConfig, AgentTaskOptions, AgentExecutionResult, AnalysisResult, AnalyzeOptions } from '../types.js';
import { executeDockerCommand } from '../../claude/docker/dockerExecutor.js';
import { verifyWorktreeStructure, verifyWorktreePostExecution, setWorktreeOwnership, UsageLimitError } from '../../claude/claudeHelpers.js';
import { buildCodexPrompt, parseCodexStreamOutput, storeCodexPromptInRedis } from '../../codex/codexHelpers.js';
import {
    assertReasoningLevelCliVersionSupported,
    loadModelReasoningLevel, resolveAgentModelReasoningLevel, resolveCodexReasoningLevel, type CodexRuntimeReasoningLevel,
    type ModelReasoningLevel
} from '../../config/configManager.js';
import { AGENT_DEFAULT_VERSIONS } from '../version/types.js';
import { DEFAULT_AGENT_EXECUTION_TIMEOUT_MS } from '../constants.js';
import { persistLlmLog, createLlmLogFromAnalysis, buildTaskWorkRef, buildAnalysisWorkRef } from '../../utils/llmLogger.js';
import { buildAnalysisSafetySuffix, executeWithUsageTracking } from './utils/index.js';
import type { ExecutionType } from '../../utils/llmMetrics.types.js';
import { resolveAgentTerminationReason } from '../termination.js';
import { buildCodexDockerArgs, type CodexDockerArgsParams } from './utils/codexDockerArgsBuilder.js';
import { executeCodexAppServerGoal } from './codexAppServer.js';

// Re-export UsageLimitError for convenience
export { UsageLimitError };

const DEFAULT_CODEX_MAX_TURNS = 1000;
const ANALYSIS_AGENT_TANK_TIMEOUT_MS = parseInt(process.env.ANALYSIS_AGENT_TANK_TIMEOUT_MS || '2000', 10);

type CodexExecutionOutput = Awaited<ReturnType<typeof executeDockerCommand>>;
type CodexParsedOutput = ReturnType<typeof parseCodexStreamOutput>;
type CodexUsageMetrics = Awaited<ReturnType<typeof executeWithUsageTracking>>['usageMetrics'];

export class CodexAgent implements Agent {
    readonly config: AgentConfig;
    readonly goalCapable = true;
    private readonly maxTurns: number;
    private readonly timeoutMs: number;

    constructor(config: AgentConfig) {
        this.config = config;
        this.maxTurns = parseInt(process.env.CODEX_MAX_TURNS || String(DEFAULT_CODEX_MAX_TURNS), 10);
        this.timeoutMs = parseInt(process.env.CODEX_TIMEOUT_MS || String(DEFAULT_AGENT_EXECUTION_TIMEOUT_MS), 10);
    }

    async executeTask(options: AgentTaskOptions): Promise<AgentExecutionResult> {
        if (options.executionMode === 'goal') return this.executeNativeGoal(options);
        const { worktreePath, issueRef, prompt: customPrompt, model, systemPrompt,
            isRetry = false, retryReason, branchName, issueDetails,
            onSessionId, onContainerId, githubToken, environment, taskId, prNumber, reasoningLevel,
            executionMode = 'task', resumeSessionId, metadata } = options;

        const startTime = Date.now();
        const effectiveModel = model || this.config.defaultModel;
        const repo = `${issueRef.repoOwner}/${issueRef.repoName}`;
        logger.info({
            issueNumber: issueRef.number, repository: repo, worktreePath,
            dockerImage: this.config.dockerImage, agentAlias: this.config.alias, isRetry, retryReason
        }, isRetry ? 'Starting Codex agent execution (RETRY)...' : 'Starting Codex agent execution...');

        try {
            const prompt = buildCodexPrompt({
                customPrompt, issueRef, branchName, modelName: effectiveModel,
                issueDetails, isRetry, retryReason, systemPrompt
            });
            await setWorktreeOwnership(worktreePath, issueRef.number);
            const worktreeGitContent = verifyWorktreeStructure(worktreePath, issueRef.number);
            const effectiveReasoningLevel = await this.resolveEffectiveReasoningLevel(reasoningLevel, effectiveModel);
            const dockerArgs = this.buildDockerArgs({
                worktreePath, githubToken, modelName: effectiveModel,
                issueNumber: issueRef.number, environment, taskId,
                reasoningLevel: effectiveReasoningLevel, executionMode, resumeSessionId
            });

            const { result, usageMetrics } = await executeWithUsageTracking(
                'codex',
                async () => executeDockerCommand('docker', dockerArgs, {
                    timeout: this.timeoutMs,
                    cwd: worktreePath,
                    onSessionId,
                    onContainerId,
                    worktreePath,
                    stdinData: prompt,
                    taskId,
                    streamToRedis: true,
                    preserveOutputOnTimeout: true
                })
            );

            const executionTime = Date.now() - startTime;
            const parsedOutput = parseCodexStreamOutput(result.stdout);

            const response = this.buildTaskExecutionResult({ parsedOutput, result, effectiveModel, effectiveReasoningLevel, executionTime, prompt, usageMetrics });

            await this.persistTaskLog({
                response, parsedOutput, executionTime, modelUsed: response.modelUsed, prompt, usageMetrics,
                issueRef, repo, taskId, prNumber, isRetry, retryReason, metadata
            });

            this.handleTaskCompletion({ response, issueNumber: issueRef.number, result, parsedOutput, worktreePath, worktreeGitContent });

            return response;
        } catch (error) {
            if (error instanceof UsageLimitError) {
                throw error;
            }
            return this.handleTaskError({ error: error as Error, executionTime: Date.now() - startTime, issueRef, repo, effectiveModel });
        }
    }

    private async executeNativeGoal(options: AgentTaskOptions): Promise<AgentExecutionResult> {
        await setWorktreeOwnership(options.worktreePath, options.issueRef.number, {
            protectGitMetadata: options.environment?.PROPR_GOAL_LAUNCH_STRATEGY === 'direct',
        });
        const worktreeGitContent = verifyWorktreeStructure(options.worktreePath, options.issueRef.number);
        const result = await executeCodexAppServerGoal(this.config, options, this.timeoutMs);
        if (result.success) {
            verifyWorktreePostExecution(options.worktreePath, options.issueRef.number, worktreeGitContent);
        }
        return result;
    }

    private buildTaskExecutionResult(params: {
        parsedOutput: CodexParsedOutput;
        result: CodexExecutionOutput;
        effectiveModel?: string; effectiveReasoningLevel: CodexRuntimeReasoningLevel | '';
        executionTime: number;
        prompt: string;
        usageMetrics: CodexUsageMetrics;
    }): AgentExecutionResult {
        const { parsedOutput, result, effectiveModel, effectiveReasoningLevel, executionTime, prompt, usageMetrics } = params;
        const terminationReason = resolveAgentTerminationReason({
            timedOut: result.timedOut,
            error: parsedOutput.error || result.stderr
        });
        return {
            success: parsedOutput.success && result.exitCode === 0 && !terminationReason,
            executionTimeMs: executionTime,
            logs: parsedOutput.logs + (result.stderr ? `\n\nSTDERR:\n${result.stderr}` : ''),
            exitCode: result.exitCode,
            rawOutput: result.stdout,
            modelUsed: parsedOutput.model || effectiveModel || 'unknown',
            ...(effectiveReasoningLevel && { reasoningLevel: effectiveReasoningLevel }),
            sessionId: parsedOutput.sessionId,
            conversationId: parsedOutput.conversationId,
            conversationLog: parsedOutput.conversationLog,
            modifiedFiles: [],
            commitMessage: null,
            summary: parsedOutput.result ?? undefined,
            prompt,
            error: parsedOutput.error || (result.exitCode === 0 ? undefined : result.stderr?.trim() || undefined),
            terminationReason,
            tokenUsage: parsedOutput.tokenUsage,
            usageMetrics: usageMetrics ?? undefined
        };
    }

    private async persistTaskLog(params: {
        response: AgentExecutionResult; parsedOutput: CodexParsedOutput;
        executionTime: number; modelUsed: string; prompt: string;
        usageMetrics: CodexUsageMetrics;
        issueRef: AgentTaskOptions['issueRef']; repo: string;
        taskId?: string; prNumber?: number; isRetry: boolean; retryReason?: string; metadata?: Record<string, unknown>;
    }): Promise<void> {
        const { response, parsedOutput, executionTime, modelUsed, usageMetrics, issueRef, repo, taskId, prNumber, isRetry, retryReason, metadata } = params;
        await storeCodexPromptInRedis({ codexOutput: parsedOutput, prompt: params.prompt, issueRef, model: modelUsed, isRetry, retryReason });
        const logEntry = createLlmLogFromAnalysis({
            executionType: 'implementation', modelUsed,
            executionTimeMs: executionTime, success: response.success,
            tokenUsage: parsedOutput.tokenUsage,
            error: response.success ? undefined : (parsedOutput.error || 'Execution failed'),
            sessionId: parsedOutput.sessionId, draftId: taskId,
            repository: `${issueRef.repoOwner}/${issueRef.repoName}`,
            agentAlias: this.config.alias, reasoningLevel: response.reasoningLevel,
            metadata: { ...metadata, isRetry, retryReason, conversationId: parsedOutput.conversationId },
            ...this.formatUsageMetrics(usageMetrics),
            workRef: buildTaskWorkRef(taskId, issueRef.number, repo, prNumber),
        });
        await persistLlmLog(logEntry);
    }

    private handleTaskCompletion(params: {
        response: AgentExecutionResult;
        issueNumber: number;
        result: CodexExecutionOutput;
        parsedOutput: CodexParsedOutput;
        worktreePath: string;
        worktreeGitContent: string | null;
    }): void {
        const { response, issueNumber, result, parsedOutput, worktreePath, worktreeGitContent } = params;
        if (!response.success) {
            logger.error({
                issueNumber, exitCode: result.exitCode,
                stderr: result.stderr, agentAlias: this.config.alias, error: parsedOutput.error
            }, 'Codex agent execution failed');
            return;
        }

        logger.info({ issueNumber, model: response.modelUsed, agentAlias: this.config.alias }, 'Codex agent execution succeeded');
        verifyWorktreePostExecution(worktreePath, issueNumber, worktreeGitContent);
    }

    private handleTaskError(params: {
        error: Error; executionTime: number;
        issueRef: AgentTaskOptions['issueRef']; repo: string;
        effectiveModel: string | undefined;
    }): AgentExecutionResult {
        const { error, executionTime, issueRef, repo, effectiveModel } = params;
        logger.error({
            issueNumber: issueRef.number, repository: repo,
            executionTime, error: error.message, agentAlias: this.config.alias
        }, 'Error during Codex agent execution');

        return {
            success: false, error: error.message, executionTimeMs: executionTime,
            logs: (error as unknown as { stderr?: string }).stderr || error.message,
            modifiedFiles: [], commitMessage: null, summary: undefined,
            modelUsed: effectiveModel || 'unknown'
        };
    }

    async analyze(prompt: string, options?: AnalyzeOptions): Promise<AnalysisResult> {
        const { context, model, taskId, taskNumber, prNumber, executionType, correlationId, repository, metadata, timeoutMs, responseFormat = 'text', reasoningLevel, useConfiguredReasoningLevel = false, suppressLlmLog, readOnlyWorkspacePath, allowReadOnlyCommands = false } = options || {};
        const startTime = Date.now();
        const effectiveModel = model || this.config.defaultModel || 'unknown';

        logger.info({
            agentAlias: this.config.alias, promptLength: prompt.length,
            hasContext: !!context, requestedModel: model, taskId, executionType
        }, 'Running lightweight analysis via Codex agent...');

        const suffix = buildAnalysisSafetySuffix(responseFormat, allowReadOnlyCommands, readOnlyWorkspacePath);
        const analysisPrompt = context ? `${prompt}\n\nContext:\n${context}${suffix}` : `${prompt}${suffix}`;
        const analysisWorkspace = readOnlyWorkspacePath || this.ensureAnalysisWorkspace();

        try {
            const effectiveReasoningLevel = await this.resolveEffectiveReasoningLevel(reasoningLevel, effectiveModel, useConfiguredReasoningLevel);
            const dockerArgs = this.buildDockerArgs({
                worktreePath: analysisWorkspace,
                githubToken: process.env.GITHUB_TOKEN || '',
                modelName: effectiveModel === 'unknown' ? undefined : effectiveModel,
                issueNumber: 0, jsonOutput: true, taskId, executionType, reasoningLevel: effectiveReasoningLevel,
                readOnlyWorkspace: !!readOnlyWorkspacePath,
                repositoryInspection: !!readOnlyWorkspacePath && allowReadOnlyCommands,
            });

            const { result, usageMetrics } = await executeWithUsageTracking(
                'codex',
                async () => executeDockerCommand('docker', dockerArgs, {
                    timeout: timeoutMs ?? 1800000, stdinData: analysisPrompt, taskId
                }),
                ANALYSIS_AGENT_TANK_TIMEOUT_MS
            );

            const executionTimeMs = Date.now() - startTime;
            const parsedOutput = parseCodexStreamOutput(result.stdout);

            if (!result.timedOut && (result.exitCode === 0 || parsedOutput.result)) {
                return this.buildAnalysisSuccess({ parsedOutput, effectiveModel, effectiveReasoningLevel, executionTimeMs, usageMetrics, executionType, taskId, taskNumber, prNumber, correlationId, repository, metadata, suppressLlmLog });
            }

            logger.warn({
                agentAlias: this.config.alias,
                exitCode: result.exitCode,
                timedOut: result.timedOut ?? false,
                stdoutLength: result.stdout.length,
                stderrLength: result.stderr.length,
                parsedResultPresent: Boolean(parsedOutput.result),
                parsedErrorPresent: Boolean(parsedOutput.error),
                executionType,
                taskId,
            }, 'Codex analysis process exited without a usable result');
            const errorMsg = parsedOutput.error || result.stderr || 'No result returned';
            return { response: '', modelUsed: effectiveModel, executionTimeMs, success: false, error: `Analysis failed: ${errorMsg}` };
        } catch (error) {
            const executionTimeMs = Date.now() - startTime;
            const err = error as Error;
            logger.error({ agentAlias: this.config.alias, error: err.message, executionTimeMs }, 'Lightweight analysis failed');
            return { response: '', modelUsed: effectiveModel, executionTimeMs, success: false, error: err.message };
        }
    }

    /**
     * Ensures the analysis workspace directory exists as a git repo writable by the container node user.
     */
    private ensureAnalysisWorkspace(): string {
        const workspace = '/tmp/codex-analysis';
        try {
            if (!fs.existsSync(workspace)) fs.mkdirSync(workspace, { recursive: true });
            if (!fs.existsSync(`${workspace}/.git`)) {
                execSync('git init', { cwd: workspace, stdio: 'pipe' });
                execSync('git config user.email "codex@propr.dev"', { cwd: workspace, stdio: 'pipe' });
                execSync('git config user.name "Codex Analysis"', { cwd: workspace, stdio: 'pipe' });
            }
            execSync(`chown -R 1000:1000 ${workspace}`, { stdio: 'pipe' });
        } catch (initError) {
            logger.warn({ error: (initError as Error).message }, 'Failed to initialize analysis workspace git repo');
        }
        return workspace;
    }

    /**
     * Builds a successful AnalysisResult from parsed output, logging and persisting the LLM log.
     */
    private async buildAnalysisSuccess(opts: {
        parsedOutput: ReturnType<typeof parseCodexStreamOutput>;
        effectiveModel: string; effectiveReasoningLevel: CodexRuntimeReasoningLevel | ''; executionTimeMs: number;
        usageMetrics: Awaited<ReturnType<typeof executeWithUsageTracking>>['usageMetrics'];
        executionType?: string; taskId?: string; taskNumber?: number; prNumber?: number;
        correlationId?: string; repository?: string; metadata?: Record<string, unknown>;
        suppressLlmLog?: boolean;
    }): Promise<AnalysisResult> {
        const { parsedOutput, effectiveModel, effectiveReasoningLevel, executionTimeMs, usageMetrics, executionType, taskId, taskNumber, prNumber, correlationId, repository, metadata, suppressLlmLog } = opts;
        const analysisText = (parsedOutput.result || '').trim();
        logger.info({
            agentAlias: this.config.alias, responseLength: analysisText.length,
            model: effectiveModel, executionTimeMs,
            inputTokens: parsedOutput.tokenUsage?.input_tokens,
            outputTokens: parsedOutput.tokenUsage?.output_tokens,
            usageMetrics: usageMetrics ? { delta: usageMetrics.delta } : null
        }, 'Lightweight analysis completed');

        if (!suppressLlmLog) {
            await persistLlmLog(createLlmLogFromAnalysis({
                executionType: (executionType || 'other') as ExecutionType,
                modelUsed: parsedOutput.model || effectiveModel, executionTimeMs,
                success: true, tokenUsage: parsedOutput.tokenUsage,
                sessionId: parsedOutput.sessionId, draftId: taskId,
                correlationId, repository, metadata,
                agentAlias: this.config.alias, reasoningLevel: effectiveReasoningLevel || undefined,
                ...this.formatUsageMetrics(usageMetrics),
                workRef: buildAnalysisWorkRef(executionType, taskId, repository, { taskNumber, prNumber }),
            }));
        }

        return {
            response: analysisText, modelUsed: parsedOutput.model || effectiveModel,
            executionTimeMs, success: true,
            tokenUsage: parsedOutput.tokenUsage, sessionId: parsedOutput.sessionId
        };
    }

    /**
     * Formats Agent Tank usage metrics into the shape expected by createLlmLogFromAnalysis.
     */
    private formatUsageMetrics(usageMetrics: Awaited<ReturnType<typeof executeWithUsageTracking>>['usageMetrics']) {
        if (!usageMetrics) return {};
        return {
            usageMetrics: {
                preCall: usageMetrics.preCall, postCall: usageMetrics.postCall,
                delta: usageMetrics.delta, timestamp: usageMetrics.timestamp,
                agent: usageMetrics.agent
            },
            usageMetricRecords: usageMetrics.records
        };
    }

    private async resolveEffectiveReasoningLevel(
        reasoningLevel: ModelReasoningLevel | undefined,
        model: string | undefined,
        useConfiguredReasoningLevel = true
    ): Promise<CodexRuntimeReasoningLevel | ''> {
        const configuredLevel = reasoningLevel ?? (useConfiguredReasoningLevel
            ? resolveAgentModelReasoningLevel(this.config.modelReasoningLevels, model) ?? await loadModelReasoningLevel()
            : '');
        const runtimeLevel = resolveCodexReasoningLevel(configuredLevel) ?? '';
        assertReasoningLevelCliVersionSupported({
            agentType: 'codex',
            agentAlias: this.config.alias,
            cliVersion: this.config.cliVersionResolved ?? AGENT_DEFAULT_VERSIONS.codex,
            reasoningLevel: runtimeLevel
        });
        return runtimeLevel;
    }

    async healthCheck(): Promise<boolean> {
        const { alias: agentAlias } = this.config;
        const dockerImage = this.config.dockerImage;
        logger.debug({ agentAlias, dockerImage }, 'Running health check for Codex agent...');
        try {
            const result = await executeDockerCommand('docker', ['images', '-q', dockerImage], { timeout: 10000 });
            const imageExists = !!result.stdout.trim();
            logger.info({ agentAlias, dockerImage, imageExists }, imageExists ? 'Health check passed' : 'Health check failed: Docker image not found');
            return imageExists;
        } catch (error) {
            logger.error({ agentAlias, error: (error as Error).message }, 'Health check failed with error');
            return false;
        }
    }

    /**
     * Builds Docker arguments for running Codex in a container.
     */
    private buildDockerArgs(params: CodexDockerArgsParams): string[] {
        return buildCodexDockerArgs(this.config, params);
    }
}
