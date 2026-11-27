import fs from 'fs';
import os from 'os';
import path from 'path';
import { withPromptOnlyToolPolicy } from '../agentToolPolicy.js';
import { prepareAgentGitAccess, prepareAnalysisGitAccess } from '../agentGitAccess.js';
import logger from '../../utils/logger.js';
import type { Agent, AgentConfig, AgentCredentialCheckResult, AgentTaskOptions, AgentExecutionResult, AnalysisResult, AnalyzeOptions } from '../types.js';
import { executeDockerCommand, type ExecutionResult as DockerCommandResult } from '../../claude/docker/dockerExecutor.js';
import { agentDockerImageExists } from '../../claude/docker/dockerImagePresence.js';
import { verifyWorktreeStructure, verifyWorktreePostExecution, setWorktreeOwnership, UsageLimitError } from '../../claude/claudeHelpers.js';
import { isAgentCapacityError } from '../agentCapacity.js';
import { resolveConfigPath, AgentConfigPathUnavailableError, loadModelReasoningLevel, resolveAgentModelReasoningLevel, resolvePiReasoningLevel, type PiThinkingLevel } from '../../config/configManager.js';
import type { ModelReasoningLevel } from '../../config/configManagerReasoning.js';
import { persistLlmLog, createLlmLogFromAnalysis, buildTaskWorkRef, buildAnalysisWorkRef, formatUsageMetrics, resolveTaskLogAttribution } from '../../utils/llmLogger.js';
import type { ExecutionType } from '../../utils/llmMetrics.types.js';
import { analysisReasoningLevelField, buildAnalysisSafetySuffix, executeWithUsageTracking } from './utils/index.js';
import { buildPromptWithRetryContext, buildLogMetadata } from './utils/vibeAgentHelpers.js';
import { buildPiDockerArgs, forwardablePiEnvVars, type PiDockerArgsParams, type PiDockerInvocation } from './utils/piDockerArgsBuilder.js';
import { buildPiFailureMessage, isSuccessfulPiResult, parsePiOutput, type ParsedPiOutput } from './utils/piOutputParser.js';
import { buildPiAuthCheckDockerArgs, runPiAuthCheck, type PiAuthCheckRunner } from './utils/piAuthCheck.js';
import { toPiCliModel } from './piModelIds.js';
import { buildPiExecutionResult, reportedPiReasoningLevel } from './utils/piExecutionResult.js';
import { failedExecutionResult } from './utils/failedAgentExecution.js';
import { DEFAULT_AGENT_EXECUTION_TIMEOUT_MS } from '../constants.js';
import { NoDefaultModelConfiguredError } from '../../config/modelAliases.js';

export { UsageLimitError };
export { parsePiOutput, parsePiConversationLog, isSuccessfulPiResult } from './utils/piOutputParser.js';

const DEFAULT_PI_ANALYSIS_TIMEOUT_MS = 1800000;
const PI_ANALYSIS_ROOT = path.join(os.tmpdir(), 'propr-pi-analysis');

/** The run that threw as a failed result, keeping a finished run's tokens, cost, session and trace. */
function buildFailedExecutionResult(error: Error, context: { executionTimeMs: number; model?: string; prompt?: string; completed?: AgentExecutionResult }): AgentExecutionResult {
    const { executionTimeMs, model, prompt, completed } = context;
    const failed = failedExecutionResult(error, { completed, model: model || 'unknown', executionTimeMs });
    if (!completed && prompt) failed.prompt = prompt;
    if (completed?.usageMetrics) failed.usageMetrics = completed.usageMetrics;
    return failed;
}

export class PiAgent implements Agent {
    readonly config: AgentConfig;
    readonly goalCapable = false;
    private readonly timeoutMs: number;

    constructor(config: AgentConfig) {
        this.config = config;
        this.timeoutMs = parseInt(process.env.PI_TIMEOUT_MS || String(DEFAULT_AGENT_EXECUTION_TIMEOUT_MS), 10);
    }

    async executeTask(options: AgentTaskOptions): Promise<AgentExecutionResult> {
        const { worktreePath, issueRef, prompt: customPrompt, model, isRetry = false, retryReason, onSessionId, onContainerId, taskId, prNumber, metadata } = options;
        const startTime = Date.now();
        const effectiveModel = model || this.config.defaultModel;
        const repository = `${issueRef.repoOwner}/${issueRef.repoName}`;
        logger.info({ issueNumber: issueRef.number, repository, worktreePath, dockerImage: this.config.dockerImage, agentAlias: this.config.alias, isRetry, retryReason },
            isRetry ? 'Starting Pi agent execution (RETRY)...' : 'Starting Pi agent execution...');

        let prompt: string | undefined;
        // A finished run whose later step throws still spent tokens and produced a trace.
        let completed: { response: AgentExecutionResult; parsed: ParsedPiOutput; result: DockerCommandResult } | undefined;
        let logsPersisted = false;
        try {
            if (!effectiveModel) throw new NoDefaultModelConfiguredError();
            // Pi has no native web switch: the restriction is best effort through the prompt.
            prompt = buildPromptWithRetryContext(withPromptOnlyToolPolicy(customPrompt, options.toolPolicy), isRetry, retryReason);
            const thinkingLevel = await this.resolveThinkingLevel(options.reasoningLevel, effectiveModel);
            await setWorktreeOwnership(worktreePath, issueRef.number);
            const worktreeGitContent = verifyWorktreeStructure(worktreePath, issueRef.number);
            const { githubToken, gitMountArgs } = await prepareAgentGitAccess(options);
            const invocation = this.buildDockerArgs({ worktreePath, gitMountArgs, modelName: effectiveModel, thinkingLevel, issueNumber: issueRef.number, taskId }, githubToken);
            const { result, usageMetrics } = await executeWithUsageTracking('pi', async () => executeDockerCommand('docker', invocation.args, {
                agentAlias: this.config.alias, diagnostics: this.diagnosticContext(invocation),
                timeout: this.timeoutMs, cwd: worktreePath, onSessionId, onContainerId, worktreePath, taskId,
                stdinData: prompt, extraEnvVars: invocation.secretEnv,
                streamToRedis: true, streamStderrToRedis: true, preserveOutputOnTimeout: true, model: effectiveModel,
            }));

            const { response, parsed } = buildPiExecutionResult({ result, modelUsed: effectiveModel, thinkingLevel, prompt, executionTimeMs: Date.now() - startTime, usageMetrics });
            completed = { response, parsed, result };
            if (parsed.sessionId && onSessionId) await onSessionId(parsed.sessionId);
            await this.persistTaskLog(response, parsed, { result, metadata, issueNumber: issueRef.number, repository, taskId, prNumber, isRetry, retryReason });
            logsPersisted = true;
            if (response.success) {
                logger.info({ issueNumber: issueRef.number, model: effectiveModel, agentAlias: this.config.alias }, 'Pi agent execution succeeded');
                verifyWorktreePostExecution(worktreePath, issueRef.number, worktreeGitContent);
            } else {
                logger.error({ issueNumber: issueRef.number, exitCode: result.exitCode, stderr: result.stderr, agentAlias: this.config.alias, error: response.error }, 'Pi agent execution failed');
            }
            return response;
        } catch (error) {
            // A capacity wait is not a provider failure: the job defers or reports the wait.
            if (error instanceof UsageLimitError || isAgentCapacityError(error)) throw error;
            const executionTimeMs = Date.now() - startTime;
            const err = error as Error;
            logger.error({ issueNumber: issueRef.number, repository, executionTimeMs, error: err.message, agentAlias: this.config.alias, hadCompletedRun: !!completed }, 'Error during Pi agent execution');
            const failed = buildFailedExecutionResult(err, { executionTimeMs, model: effectiveModel, prompt, completed: completed?.response });
            if (completed && !logsPersisted) {
                // The run's log row was never written: write it as failed, with the run's tokens and provider cost.
                try {
                    await this.persistTaskLog(failed, completed.parsed, { result: completed.result, metadata, issueNumber: issueRef.number, repository, taskId, prNumber, isRetry, retryReason });
                } catch (persistError) {
                    logger.warn({ issueNumber: issueRef.number, error: (persistError as Error).message, agentAlias: this.config.alias }, 'Failed to persist Pi task log after execution error');
                }
            }
            return failed;
        }
    }

    private async persistTaskLog(response: AgentExecutionResult, parsed: ParsedPiOutput, context: {
        result: DockerCommandResult; metadata?: Record<string, unknown>; issueNumber: number; repository: string; taskId?: string; prNumber?: number; isRetry: boolean; retryReason?: string;
    }): Promise<void> {
        const { result, metadata, issueNumber, repository, taskId, prNumber, isRetry, retryReason } = context;
        const usage = formatUsageMetrics(response.usageMetrics ?? null);
        const baseMetadata = { isRetry, retryReason, ...(parsed.providerModel && { providerModel: parsed.providerModel }) };
        await persistLlmLog({
            ...createLlmLogFromAnalysis({
                ...resolveTaskLogAttribution(metadata, buildTaskWorkRef(taskId, issueNumber, repository, prNumber), buildLogMetadata(baseMetadata, result, !response.success)),
                modelUsed: response.modelUsed, executionTimeMs: response.executionTimeMs, success: response.success, tokenUsage: response.tokenUsage,
                error: response.error, sessionId: response.sessionId, draftId: taskId, repository, agentAlias: this.config.alias,
                reasoningLevel: response.reasoningLevel, usageMetrics: usage.metrics, usageMetricRecords: usage.records,
            }),
            ...(response.providerCostUsd !== undefined && { costUsd: response.providerCostUsd }),
        });
    }

    async analyze(prompt: string, options?: AnalyzeOptions): Promise<AnalysisResult> {
        const { context, model, taskId, taskNumber, prNumber, executionType, correlationId, repository, metadata, timeoutMs, responseFormat = 'text', suppressLlmLog, readOnlyWorkspacePath, allowReadOnlyCommands = false, reasoningLevel, useConfiguredReasoningLevel = false } = options || {};
        const startTime = Date.now();
        const effectiveModel = model || this.config.defaultModel;
        if (!effectiveModel) throw new NoDefaultModelConfiguredError();
        const suffix = buildAnalysisSafetySuffix(responseFormat, allowReadOnlyCommands, readOnlyWorkspacePath);
        const analysisPrompt = context ? `${prompt}\n\nContext:\n${context}${suffix}` : `${prompt}${suffix}`;
        logger.info({ agentAlias: this.config.alias, promptLength: prompt.length, hasContext: !!context, requestedModel: model, taskId, executionType }, 'Running lightweight analysis via Pi agent...');

        let analysisWorkspace: string | undefined;
        try {
            analysisWorkspace = readOnlyWorkspacePath || this.createAnalysisWorkspace();
            const thinkingLevel = await this.resolveThinkingLevel(reasoningLevel, effectiveModel, useConfiguredReasoningLevel);
            const gitAccess = await prepareAnalysisGitAccess(options, analysisWorkspace);
            const invocation = this.buildDockerArgs({
                worktreePath: analysisWorkspace, gitMountArgs: gitAccess.gitMountArgs, modelName: effectiveModel, thinkingLevel,
                issueNumber: 0, taskId, executionType, mode: 'analysis', readOnlyTools: !!readOnlyWorkspacePath && allowReadOnlyCommands,
            }, gitAccess.githubToken);
            const { result, usageMetrics } = await executeWithUsageTracking('pi', async () => executeDockerCommand('docker', invocation.args, {
                agentAlias: this.config.alias, diagnostics: this.diagnosticContext(invocation),
                timeout: timeoutMs ?? parseInt(process.env.PI_ANALYSIS_TIMEOUT_MS || String(DEFAULT_PI_ANALYSIS_TIMEOUT_MS), 10),
                stdinData: analysisPrompt, extraEnvVars: invocation.secretEnv, taskId, model: effectiveModel,
            }), { alias: this.config.alias, skipUsageTracking: options?.skipUsageTracking });
            return await this.finishAnalysis({ result, usageMetrics, effectiveModel, thinkingLevel, startTime, suppressLlmLog, executionType, taskId, taskNumber, prNumber, correlationId, repository, metadata });
        } catch (error) {
            const executionTimeMs = Date.now() - startTime;
            const err = error as Error;
            logger.error({ agentAlias: this.config.alias, error: err.message, executionTimeMs }, 'Lightweight analysis failed');
            return { response: '', modelUsed: effectiveModel, executionTimeMs, success: false, error: err.message };
        } finally {
            if (analysisWorkspace && !readOnlyWorkspacePath) {
                try { fs.rmSync(analysisWorkspace, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
            }
        }
    }

    private async finishAnalysis(params: {
        result: DockerCommandResult; usageMetrics: Parameters<typeof formatUsageMetrics>[0]; effectiveModel: string; thinkingLevel: PiThinkingLevel | null; startTime: number;
        suppressLlmLog?: boolean; executionType?: string; taskId?: string; taskNumber?: number; prNumber?: number; correlationId?: string; repository?: string; metadata?: Record<string, unknown>;
    }): Promise<AnalysisResult> {
        const { result, usageMetrics, effectiveModel, thinkingLevel, startTime, executionType, taskId, repository } = params;
        const executionTimeMs = Date.now() - startTime;
        const parsed = parsePiOutput(result.stdout);
        const analysisText = (parsed.summary || '').trim();
        const success = !result.timedOut && isSuccessfulPiResult(result.exitCode, parsed) && !!analysisText;
        const errorMsg = success ? undefined : (analysisText || !isSuccessfulPiResult(result.exitCode, parsed) ? buildPiFailureMessage(result, parsed) : 'Pi returned an empty response');
        const reasoningLevel = reportedPiReasoningLevel(thinkingLevel);
        if (!params.suppressLlmLog) {
            const usage = formatUsageMetrics(usageMetrics);
            await persistLlmLog({
                ...createLlmLogFromAnalysis({
                    executionType: (executionType || 'other') as ExecutionType, modelUsed: effectiveModel, executionTimeMs, success,
                    tokenUsage: parsed.tokenUsage, error: errorMsg, sessionId: parsed.sessionId, draftId: taskId, correlationId: params.correlationId, repository,
                    metadata: buildLogMetadata(params.metadata || {}, result, !success), agentAlias: this.config.alias, reasoningLevel,
                    usageMetrics: usage.metrics, usageMetricRecords: usage.records,
                    workRef: buildAnalysisWorkRef(executionType, taskId, repository, { taskNumber: params.taskNumber, prNumber: params.prNumber }),
                }),
                ...(parsed.costUsd !== undefined && { costUsd: parsed.costUsd }),
            });
        }
        if (!success) return { response: '', modelUsed: effectiveModel, executionTimeMs, success: false, error: `Analysis failed: ${errorMsg}` };
        return { response: analysisText, modelUsed: effectiveModel, executionTimeMs, success: true, tokenUsage: parsed.tokenUsage, sessionId: parsed.sessionId, ...analysisReasoningLevelField(reasoningLevel) };
    }

    async healthCheck(): Promise<boolean> {
        logger.debug({ agentAlias: this.config.alias, dockerImage: this.config.dockerImage }, 'Running health check for Pi agent...');
        try {
            const imageExists = await agentDockerImageExists(this.config.dockerImage, 10000);
            if (!imageExists) {
                logger.info({ agentAlias: this.config.alias, dockerImage: this.config.dockerImage }, 'Health check failed: Docker image not found');
                return false;
            }
            const configPath = this.resolveOptionalConfigPath();
            const hasAuthFile = !!configPath && fs.existsSync(path.join(configPath, 'auth.json'));
            const hasApiKey = Object.keys(forwardablePiEnvVars(this.config.envVars)).some(name => /_(API_KEY|TOKEN)$/.test(name));
            if (!hasAuthFile && !hasApiKey) {
                logger.warn({ agentAlias: this.config.alias, configPath }, 'Health check warning: no Pi credentials found (run `pi auth login` for ~/.pi/agent or set a provider API key)');
            }
            logger.info({ agentAlias: this.config.alias, dockerImage: this.config.dockerImage, hasAuthFile, hasApiKey }, 'Health check passed');
            return true;
        } catch (error) {
            logger.error({ agentAlias: this.config.alias, error: (error as Error).message }, 'Health check failed with error');
            return false;
        }
    }

    /**
     * `pi auth check --provider <p> --json --no-refresh` for the model's
     * provider: reports ready, not_ready or invalid without a prompt or a
     * token refresh.
     */
    async checkCredentials(model: string, run?: PiAuthCheckRunner): Promise<AgentCredentialCheckResult> {
        const { provider } = toPiCliModel(model);
        const invocation = buildPiAuthCheckDockerArgs({ config: this.config, configPath: this.resolveOptionalConfigPath(), provider });
        const result = await runPiAuthCheck(invocation, provider, { run });
        logger.info({ agentAlias: this.config.alias, provider, status: result.status, reason: result.reason, authType: result.authType }, 'Pi credential check finished');
        return result;
    }

    private async resolveThinkingLevel(reasoningLevel: ModelReasoningLevel | undefined, model: string, useConfiguredReasoningLevel = true): Promise<PiThinkingLevel | null> {
        const configured = reasoningLevel ?? (useConfiguredReasoningLevel
            ? resolveAgentModelReasoningLevel(this.config.modelReasoningLevels, model) ?? await loadModelReasoningLevel()
            : '');
        return resolvePiReasoningLevel(configured);
    }

    /**
     * The host Pi agent dir, or undefined when a containerized install has no
     * mapping for it: provider API keys alone are enough to run Pi.
     */
    private resolveOptionalConfigPath(): string | undefined {
        try {
            return resolveConfigPath(this.config.configPath);
        } catch (error) {
            if (error instanceof AgentConfigPathUnavailableError) return undefined;
            throw error;
        }
    }

    private createAnalysisWorkspace(): string {
        fs.mkdirSync(PI_ANALYSIS_ROOT, { recursive: true });
        return fs.mkdtempSync(path.join(PI_ANALYSIS_ROOT, 'analysis-'));
    }

    private diagnosticContext(invocation: PiDockerInvocation) {
        return { provider: this.config.type, agent: this.config.id, configPath: this.config.configPath, credentials: { ...this.config.envVars, ...invocation.secretEnv } };
    }

    buildDockerArgs(params: Omit<PiDockerArgsParams, 'config' | 'configPath'>, githubToken: string): PiDockerInvocation {
        const invocation = buildPiDockerArgs({ ...params, config: this.config, configPath: this.resolveOptionalConfigPath() }, githubToken);
        logger.info({ issueNumber: params.issueNumber, agentAlias: this.config.alias, mode: params.mode ?? 'execute', dockerImage: this.config.dockerImage, thinkingLevel: params.thinkingLevel ?? null, forwardedEnv: Object.keys(invocation.secretEnv) }, 'Docker args built for Pi agent');
        return invocation;
    }
}
