import logger from '../../utils/logger.js';
import { executeDockerCommand } from '../../claude/docker/dockerExecutor.js';
import { verifyWorktreeStructure, verifyWorktreePostExecution, setWorktreeOwnership, UsageLimitError } from '../../claude/claudeHelpers.js';
import { assertReasoningLevelCliVersionSupported, loadModelReasoningLevel, resolveAgentModelReasoningLevel, resolveMuseReasoningLevel, type MuseRuntimeReasoningLevel } from '../../config/configManager.js';
import { AGENT_DEFAULT_VERSIONS } from '../version/types.js';
import { NoDefaultModelConfiguredError } from '../../config/modelAliases.js';
import { persistLlmLog, createLlmLogFromAnalysis, buildTaskWorkRef, buildAnalysisWorkRef } from '../../utils/llmLogger.js';
import { buildAnalysisSafetySuffix } from './utils/index.js';
import { DEFAULT_AGENT_EXECUTION_TIMEOUT_MS } from '../constants.js';
import type { ExecutionType } from '../../utils/llmMetrics.types.js';
import type { ReasoningLevel } from '@propr/shared';
import type { Agent, AgentConfig, AgentTaskOptions, AgentExecutionResult, AnalysisResult, AnalyzeOptions } from '../types.js';
import { buildMuseDockerArgs, buildMusePrompt, cleanupMuseAnalysisWorkspace, ensureMuseAnalysisWorkspace, parseMuseJsonl } from './museUtils.js';
import { resolveAgentTerminationReason } from '../termination.js';

export { UsageLimitError };
export { buildMuseDockerArgs, parseMuseJsonl } from './museUtils.js';

const DEFAULT_MUSE_MAX_STEPS = 1000;

export class MuseAgent implements Agent {
    readonly config: AgentConfig;
    readonly goalCapable = false;
    private readonly maxSteps: number;
    private readonly timeoutMs: number;

    constructor(config: AgentConfig) {
        this.config = config;
        this.maxSteps = parseInt(process.env.MUSE_MAX_MODEL_STEPS || String(DEFAULT_MUSE_MAX_STEPS), 10);
        this.timeoutMs = parseInt(process.env.MUSE_TIMEOUT_MS || String(DEFAULT_AGENT_EXECUTION_TIMEOUT_MS), 10);
    }

    // eslint-disable-next-line complexity
    async executeTask(options: AgentTaskOptions): Promise<AgentExecutionResult> {
        const {
            worktreePath, issueRef, prompt: customPrompt, model, systemPrompt, isRetry = false,
            retryReason, branchName, issueDetails, onSessionId, onContainerId, githubToken,
            environment, taskId, prNumber, reasoningLevel, metadata,
        } = options;
        const startedAt = Date.now();
        const effectiveModel = model || this.config.defaultModel;
        if (!effectiveModel) throw new NoDefaultModelConfiguredError();
        const repository = `${issueRef.repoOwner}/${issueRef.repoName}`;
        const prompt = buildMusePrompt({ customPrompt, issueRef, branchName, modelName: effectiveModel, issueDetails, isRetry, retryReason, systemPrompt });

        try {
            await setWorktreeOwnership(worktreePath, issueRef.number);
            const worktreeGitContent = verifyWorktreeStructure(worktreePath, issueRef.number);
            const effectiveReasoning = await this.resolveEffectiveReasoningLevel(reasoningLevel, effectiveModel);
            const dockerArgs = buildMuseDockerArgs(this.config, {
                worktreePath, githubToken, modelName: effectiveModel, issueNumber: issueRef.number,
                taskId, environment, reasoningLevel: effectiveReasoning, maxModelSteps: this.maxSteps,
            });
            const result = await executeDockerCommand('docker', dockerArgs, {
                timeout: this.timeoutMs, cwd: worktreePath, onSessionId, onContainerId,
                worktreePath, stdinData: prompt, taskId, streamToRedis: true, preserveOutputOnTimeout: true,
            });
            const executionTimeMs = Date.now() - startedAt;
            const parsed = parseMuseJsonl(result.stdout, prompt);
            if (parsed.sessionId && onSessionId) onSessionId(parsed.sessionId);
            const terminationReason = resolveAgentTerminationReason({ timedOut: result.timedOut, error: parsed.error || result.stderr });
            const success = result.exitCode === 0 && parsed.completed && !terminationReason;
            const modelUsed = parsed.model || effectiveModel;
            const response: AgentExecutionResult = {
                success, executionTimeMs, exitCode: result.exitCode, rawOutput: result.stdout,
                logs: result.stdout + (result.stderr ? `\n\nSTDERR:\n${result.stderr}` : ''),
                modelUsed, providerModel: parsed.model, modifiedFiles: [], commitMessage: null,
                summary: parsed.text, prompt, sessionId: parsed.sessionId, conversationLog: parsed.conversationLog,
                error: success ? undefined : (parsed.error || result.stderr || `Muse exited with code ${result.exitCode ?? 'unknown'}`),
                terminationReason, reasoningLevel: effectiveReasoning || undefined,
            };
            await persistLlmLog(createLlmLogFromAnalysis({
                executionType: 'implementation', modelUsed, executionTimeMs, success,
                error: response.error, sessionId: parsed.sessionId, draftId: taskId, repository,
                agentAlias: this.config.alias, reasoningLevel: effectiveReasoning || undefined,
                metadata: { ...metadata, isRetry, retryReason },
                workRef: buildTaskWorkRef(taskId, issueRef.number, repository, prNumber),
            }));
            if (success) verifyWorktreePostExecution(worktreePath, issueRef.number, worktreeGitContent);
            return response;
        } catch (error) {
            if (error instanceof UsageLimitError) throw error;
            const executionTimeMs = Date.now() - startedAt;
            const err = error as Error & { stderr?: string };
            logger.error({ agentAlias: this.config.alias, repository, error: err.message }, 'Muse Code agent execution failed');
            return {
                success: false, error: err.message, executionTimeMs, logs: err.stderr || err.message,
                modifiedFiles: [], commitMessage: null, modelUsed: effectiveModel, prompt,
            };
        }
    }

    // eslint-disable-next-line complexity
    async analyze(prompt: string, options?: AnalyzeOptions): Promise<AnalysisResult> {
        const {
            context, model, taskId, taskNumber, prNumber, executionType, correlationId,
            repository, metadata, timeoutMs, responseFormat = 'text', reasoningLevel,
            useConfiguredReasoningLevel = false, suppressLlmLog, readOnlyWorkspacePath,
            allowReadOnlyCommands = false,
        } = options || {};
        const startedAt = Date.now();
        const effectiveModel = model || this.config.defaultModel;
        if (!effectiveModel) throw new NoDefaultModelConfiguredError();
        const suffix = buildAnalysisSafetySuffix(responseFormat, allowReadOnlyCommands, readOnlyWorkspacePath);
        const analysisPrompt = context ? `${prompt}\n\nContext:\n${context}${suffix}` : `${prompt}${suffix}`;
        const temporaryWorkspace = readOnlyWorkspacePath ? undefined : ensureMuseAnalysisWorkspace();
        const workspace = readOnlyWorkspacePath || temporaryWorkspace!;

        try {
            const effectiveReasoning = await this.resolveEffectiveReasoningLevel(reasoningLevel, effectiveModel, useConfiguredReasoningLevel);
            const dockerArgs = buildMuseDockerArgs(this.config, {
                worktreePath: workspace, githubToken: '', modelName: effectiveModel, issueNumber: 0,
                taskId, executionType, reasoningLevel: effectiveReasoning, maxModelSteps: 20,
                readOnlyWorkspace: true, allowReadOnlyCommands,
            });
            const result = await executeDockerCommand('docker', dockerArgs, {
                timeout: timeoutMs ?? parseInt(process.env.MUSE_ANALYSIS_TIMEOUT_MS || '1800000', 10),
                stdinData: analysisPrompt, taskId,
            });
            const executionTimeMs = Date.now() - startedAt;
            const parsed = parseMuseJsonl(result.stdout, analysisPrompt);
            const success = result.exitCode === 0 && parsed.completed && !result.timedOut;
            const modelUsed = parsed.model || effectiveModel;
            const error = success ? undefined : (parsed.error || result.stderr || `Muse exited with code ${result.exitCode ?? 'unknown'}`);
            if (!suppressLlmLog) {
                await persistLlmLog(createLlmLogFromAnalysis({
                    executionType: (executionType || 'other') as ExecutionType, modelUsed,
                    executionTimeMs, success, error, sessionId: parsed.sessionId, draftId: taskId,
                    correlationId, repository, metadata, agentAlias: this.config.alias,
                    reasoningLevel: effectiveReasoning || undefined,
                    workRef: buildAnalysisWorkRef(executionType, taskId, repository, { taskNumber, prNumber }),
                }));
            }
            return success
                ? { response: parsed.text!, modelUsed, executionTimeMs, success: true, sessionId: parsed.sessionId }
                : { response: '', modelUsed, executionTimeMs, success: false, error: `Analysis failed: ${error}` };
        } catch (error) {
            const executionTimeMs = Date.now() - startedAt;
            logger.error({ agentAlias: this.config.alias, error: (error as Error).message }, 'Muse lightweight analysis failed');
            return { response: '', modelUsed: effectiveModel, executionTimeMs, success: false, error: (error as Error).message };
        } finally {
            cleanupMuseAnalysisWorkspace(temporaryWorkspace);
        }
    }

    async healthCheck(): Promise<boolean> {
        try {
            const result = await executeDockerCommand('docker', ['images', '-q', this.config.dockerImage], { timeout: 10000 });
            return !!result.stdout.trim();
        } catch (error) {
            logger.error({ agentAlias: this.config.alias, error: (error as Error).message }, 'Muse health check failed');
            return false;
        }
    }

    /** Loads the configured reasoning level when it is supported by this agent runtime. */
    private async resolveEffectiveReasoningLevel(
        requested: ReasoningLevel | undefined,
        model: string,
        useConfiguredReasoningLevel = true
    ): Promise<MuseRuntimeReasoningLevel | ''> {
        const configuredLevel = requested
            ?? (useConfiguredReasoningLevel
                ? resolveAgentModelReasoningLevel(this.config.modelReasoningLevels, model) ?? await loadModelReasoningLevel()
                : '');
        const runtimeLevel = resolveMuseReasoningLevel(configuredLevel) ?? '';
        assertReasoningLevelCliVersionSupported({
            agentType: 'muse',
            agentAlias: this.config.alias,
            cliVersion: this.config.cliVersionResolved ?? AGENT_DEFAULT_VERSIONS.muse,
            reasoningLevel: runtimeLevel
        });
        return runtimeLevel;
    }
}
