import path from 'path';
import os from 'os';
import logger from '../utils/logger.js';
import { getDefaultModel, resolveModelAlias } from '../config/modelAliases.js';
import { AgentRegistry } from '../agents/AgentRegistry.js';
import type { AnalysisResult } from '../agents/types.js';
import { generateTaskImportPrompt, IssueRef, IssueDetails } from './prompts/promptGenerator.js';
import { executeDockerCommand, buildClaudeDockerImage as buildDockerImageInternal } from './docker/dockerExecutor.js';
import {
    verifyWorktreeStructure,
    verifyWorktreePostExecution,
    setWorktreeOwnership,
    buildDockerArgs,
    parseStreamJsonOutput,
    storePromptInRedis,
    buildClaudePrompt,
    UsageLimitError,
    ClaudeOutput,
    ConversationLogEntry,
    ClaudeOutputResult,
    TokenUsage
} from './claudeHelpers.js';
import { recordLLMMetrics } from '../utils/llmMetrics.js';
import { persistLlmLog, createLlmLogFromAnalysis } from '../utils/llmLogger.js';
import type { ExecutionType, ConversationStep } from '../utils/llmMetrics.types.js';
import { executeWithUsageTracking, type UsageTrackingMetrics } from '../agents/impl/utils/index.js';
import { DEFAULT_AGENT_DOCKER_IMAGES } from '../agents/constants.js';
import type { ReasoningLevel } from '@propr/shared';
export { UsageLimitError };
export type { IssueRef, IssueDetails };

const CLAUDE_DOCKER_IMAGE: string = process.env.AGENT_DOCKER_IMAGE || DEFAULT_AGENT_DOCKER_IMAGES.claude;
const CLAUDE_CONFIG_PATH: string = process.env.CLAUDE_CONFIG_PATH || path.join(os.homedir(), '.claude');
const CLAUDE_MAX_TURNS: number = parseInt(process.env.CLAUDE_MAX_TURNS || '1000', 10);
const CLAUDE_TIMEOUT_MS: number = parseInt(process.env.CLAUDE_TIMEOUT_MS || '300000', 10);

/** @deprecated Use AgentRegistry and Agent.executeTask() instead. */
export interface ExecuteClaudeCodeOptions {
    worktreePath: string;
    issueRef: IssueRef;
    githubToken: string;
    customPrompt?: string;
    isRetry?: boolean;
    retryReason?: string;
    branchName?: string;
    modelName?: string;
    issueDetails?: IssueDetails;
    onSessionId?: (sessionId: string, conversationId?: string) => void;
    onContainerId?: (containerId: string, containerName: string) => void;
    systemPrompt?: string;
    tools?: string;
    timeoutMs?: number;
}

export interface ClaudeCodeResponse {
    success: boolean;
    executionTime: number;
    output: ClaudeOutput | null;
    logs: string;
    exitCode?: number | null;
    rawOutput?: string;
    conversationLog?: ConversationLogEntry[];
    sessionId?: string | null;
    conversationId?: string;
    model?: string;
    finalResult?: ClaudeOutputResult | null;
    modifiedFiles: string[];
    commitMessage: string | null;
    summary: string | null;
    prompt?: string;
    error?: string;
    tokenUsage?: TokenUsage;
    usageMetrics?: UsageTrackingMetrics | null;
}

export interface GenerateTaskSummaryOptions {
    summaryRequest: string;
    worktreePath: string;
    githubToken: string;
    issueRef: IssueRef;
    correlationId: string;
    modelAlias?: string;
}

export interface RunLightweightLLMAnalysisOptions {
    prompt: string;
    model: string;
    correlationId: string;
    worktreePath: string;
    githubToken: string;
    issueRef: IssueRef;
    taskId?: string;
    prNumber?: number;
    executionType?: ExecutionType;
    metadata?: Record<string, unknown>;
    timeoutMs?: number;
    reasoningLevel?: ReasoningLevel;
}

/** @deprecated Use AgentRegistry.getDefaultAgent().executeTask() instead. */
export async function executeClaudeCode(options: ExecuteClaudeCodeOptions): Promise<ClaudeCodeResponse> {
    const { worktreePath, issueRef, githubToken, customPrompt, isRetry = false, retryReason, branchName, modelName, issueDetails, onSessionId, onContainerId, timeoutMs } = options;
    const startTime = Date.now();

    const repo = `${issueRef.repoOwner}/${issueRef.repoName}`;
    logger.info({ issueNumber: issueRef.number, repository: repo, worktreePath, isRetry },
        isRetry ? 'Starting Claude Code execution (RETRY)' : 'Starting Claude Code execution');

    try {
        const prompt = buildClaudePrompt({ customPrompt, issueRef, branchName, modelName, issueDetails, isRetry, retryReason });
        await setWorktreeOwnership(worktreePath, issueRef.number);
        const worktreeGitContent = verifyWorktreeStructure(worktreePath, issueRef.number);

        const dockerArgs = buildDockerArgs({
            worktreePath, githubToken, prompt, modelName, issueNumber: issueRef.number,
            CLAUDE_DOCKER_IMAGE, CLAUDE_CONFIG_PATH, CLAUDE_MAX_TURNS,
            systemPrompt: options.systemPrompt, tools: options.tools, agentAlias: 'claude'
        });
        const { result, usageMetrics } = await executeWithUsageTracking(
            'claude',
            async () => executeDockerCommand('docker', dockerArgs, {
                timeout: timeoutMs ?? CLAUDE_TIMEOUT_MS,
                cwd: worktreePath,
                onSessionId,
                onContainerId,
                worktreePath,
                stdinData: prompt // Always pass prompt via stdin
            })
        );

        const executionTime = Date.now() - startTime;
        logger.info({ issueNumber: issueRef.number, executionTime, exitCode: result.exitCode }, 'Claude Code execution completed');

        const claudeOutput = parseStreamJsonOutput(result);
        const response: ClaudeCodeResponse = {
            success: claudeOutput.success,
            executionTime,
            output: claudeOutput,
            logs: result.stderr || '',
            exitCode: result.exitCode,
            rawOutput: result.stdout,
            conversationLog: claudeOutput.conversationLog || [],
            sessionId: claudeOutput.sessionId,
            conversationId: claudeOutput.conversationId,
            model: claudeOutput.model || process.env.CLAUDE_MODEL || getDefaultModel() || (() => {
                logger.error('No default model configured - using sentinel value "unconfigured". Configure an AI agent with a default model in the dashboard.');
                return 'unconfigured';
            })(),
            finalResult: claudeOutput.finalResult,
            modifiedFiles: [],
            commitMessage: null,
            summary: claudeOutput.finalResult?.result || null,
            prompt: prompt,
            tokenUsage: claudeOutput.tokenUsage,
            usageMetrics
        };

        await storePromptInRedis({ claudeOutput, prompt, issueRef, model: response.model!, isRetry, retryReason });

        if (!response.success) {
            logger.error({ issueNumber: issueRef.number, exitCode: result.exitCode }, 'Claude Code execution failed');
        } else {
            logger.info({ issueNumber: issueRef.number, model: response.model }, 'Claude Code execution succeeded');
            verifyWorktreePostExecution(worktreePath, issueRef.number, worktreeGitContent);
        }

        return response;
    } catch (error) {
        if (error instanceof UsageLimitError) {
            throw error;
        }

        const executionTime = Date.now() - startTime;
        const err = error as Error;
        logger.error({ issueNumber: issueRef.number, executionTime, error: err.message }, 'Error during Claude Code execution');
        return {
            success: false, error: err.message, executionTime, output: null,
            logs: (error as { stderr?: string }).stderr || err.message,
            modifiedFiles: [], commitMessage: null, summary: null
        };
    }
}

const LIGHTWEIGHT_SYSTEM_PROMPT = 'You are a helpful assistant.';
const LIGHTWEIGHT_TOOLS = '';

export async function generateTaskSummary(options: GenerateTaskSummaryOptions): Promise<string> {
    const { summaryRequest, worktreePath, githubToken, issueRef, correlationId, modelAlias = 'haiku' } = options;
    const correlatedLogger = logger.withCorrelation(correlationId);
    correlatedLogger.info({ modelAlias, issueRef: issueRef.number }, 'Generating task summary');
    const model = resolveModelAlias(modelAlias);
    const summaryPrompt = `Please provide a one-sentence summary for the following request, focusing on the main action. Your output must be ONLY the summary string itself, with no other text.\n\nREQUEST:\n${summaryRequest}\n\nCRITICAL: Do not modify any files. Do not run any commands. Only output the summary.`;

    try {
        const claudeResult = await executeClaudeCode({
            worktreePath, issueRef, githubToken, customPrompt: summaryPrompt,
            branchName: 'summary-generation', modelName: model,
            systemPrompt: LIGHTWEIGHT_SYSTEM_PROMPT, tools: LIGHTWEIGHT_TOOLS
        });
        await recordLLMMetrics(buildLlmMetricsPayload(claudeResult, model), issueRef, { correlationId, executionType: 'title-generation' });

        if (claudeResult.success && (claudeResult.finalResult?.result || claudeResult.summary)) {
            const rawSummary = claudeResult.finalResult?.result || claudeResult.summary;
            // Clean: first line only, strip markdown headers and surrounding quotes
            const summary = rawSummary!.split('\n')[0].replace(/^#+\s*/, '').replace(/^"|"$/g, '').trim();
            correlatedLogger.info({ summary, model }, 'Successfully generated task summary');
            return summary;
        }
        throw new Error(`Invalid summary response from Claude execution: ${claudeResult.error}`);
    } catch (error) {
        const err = error as Error;
        correlatedLogger.error({ error: err.message, model }, 'Failed to generate task summary');
        throw error;
    }
}

export const buildClaudeDockerImage = buildDockerImageInternal;

export { generateTaskImportPrompt };

interface ParsedModelInfo {
    agentAlias?: string;
    modelOverride?: string;
    effectiveModel: string;
}

function parseAgentModelFormat(model: string, correlatedLogger: ReturnType<typeof logger.withCorrelation>): ParsedModelInfo {
    if (model && model.includes(':')) {
        const parts = model.split(':');
        const agentAlias = parts[0];
        const modelOverride = parts.slice(1).join(':');
        correlatedLogger.info({ model, agentAlias, modelOverride }, 'Parsed agent:model format');
        return { agentAlias, modelOverride, effectiveModel: modelOverride };
    }
    return { effectiveModel: model };
}

function buildLlmMetricsPayload(claudeResult: ClaudeCodeResponse, fallbackModel: string) {
    return {
        model: claudeResult.model ?? fallbackModel,
        success: claudeResult.success,
        executionTime: claudeResult.executionTime,
        sessionId: claudeResult.sessionId,
        conversationId: claudeResult.conversationId,
        conversationLog: claudeResult.conversationLog as unknown as ConversationStep[],
        tokenUsage: claudeResult.tokenUsage,
        finalResult: claudeResult.finalResult ? {
            num_turns: claudeResult.conversationLog?.length ?? 0,
            cost_usd: undefined
        } : null,
        error: claudeResult.error
    };
}

function mapUsageMetrics(usageMetrics: UsageTrackingMetrics | null | undefined) {
    if (!usageMetrics) return undefined;
    return {
        preCall: usageMetrics.preCall,
        postCall: usageMetrics.postCall,
        delta: usageMetrics.delta,
        records: usageMetrics.records,
        timestamp: usageMetrics.timestamp,
        agent: usageMetrics.agent
    };
}

interface AgentExecutionParams {
    agentAlias: string;
    modelOverride?: string;
    prompt: string;
    taskId?: string;
    taskNumber?: number;
    prNumber?: number;
    executionType?: string;
    correlationId?: string;
    repository?: string;
    metadata?: Record<string, unknown>;
    timeoutMs?: number;
    reasoningLevel?: ReasoningLevel;
    correlatedLogger: ReturnType<typeof logger.withCorrelation>;
}

async function tryExecuteWithAgent(params: AgentExecutionParams): Promise<AnalysisResult | null> {
    const { agentAlias, modelOverride, prompt, taskId, taskNumber, prNumber, executionType, correlationId, repository, metadata, timeoutMs, reasoningLevel, correlatedLogger } = params;
    const registry = AgentRegistry.getInstance();
    await registry.ensureInitialized();

    const agent = registry.getAgentByAlias(agentAlias);
    if (!agent) {
        correlatedLogger.warn({ agentAlias }, 'Agent not found, falling back to default execution');
        return null;
    }

    const resolvedModel = modelOverride ? resolveModelAlias(modelOverride) : agent.config.defaultModel;
    correlatedLogger.info({ agentAlias, resolvedModel, taskId, executionType }, 'Using agent-specific lightweight LLM analysis');
    return await agent.analyze(prompt, { model: resolvedModel, taskId, taskNumber, prNumber, executionType, correlationId, repository, metadata, timeoutMs, reasoningLevel });
}

function buildWorkRef(opts: {
    executionType: string;
    taskId?: string;
    prNumber?: number;
    issueRef?: IssueRef;
    repository?: string;
}): Record<string, unknown> {
    const isPlan = opts.executionType === 'plan-generation' || opts.executionType === 'plan-refinement';
    const taskNumber = isPlan ? undefined : opts.issueRef?.number;
    return {
        workType: isPlan ? 'plan' : (opts.taskId || taskNumber) ? 'task' : 'repository',
        taskId: isPlan ? undefined : opts.taskId,
        taskNumber,
        prNumber: isPlan ? undefined : opts.prNumber,
        planDraftId: isPlan ? opts.taskId : undefined,
        workRepository: opts.repository,
    };
}

async function executeClaudeAnalysis(
    options: RunLightweightLLMAnalysisOptions,
    resolvedModel: string,
    correlatedLogger: ReturnType<typeof logger.withCorrelation>
): Promise<string> {
    const { prompt, correlationId, worktreePath, githubToken, issueRef, taskId, prNumber, executionType = 'other', model, timeoutMs } = options;

    const claudeResult = await executeClaudeCode({
        worktreePath, issueRef, githubToken,
        customPrompt: `${prompt}\n\nCRITICAL: Do not modify any files. Do not run any commands. Only provide direct output.`,
        branchName: 'analysis-generation',
        modelName: resolvedModel,
        systemPrompt: LIGHTWEIGHT_SYSTEM_PROMPT,
        tools: LIGHTWEIGHT_TOOLS,
        timeoutMs,
    });

    await recordLLMMetrics(buildLlmMetricsPayload(claudeResult, resolvedModel), issueRef, { correlationId, taskId, executionType });

    const repository = issueRef ? `${issueRef.repoOwner}/${issueRef.repoName}` : undefined;
    await persistLlmLog(createLlmLogFromAnalysis({
        executionType,
        modelUsed: claudeResult.model ?? resolvedModel,
        executionTimeMs: claudeResult.executionTime,
        success: claudeResult.success,
        tokenUsage: claudeResult.tokenUsage,
        error: claudeResult.error,
        sessionId: claudeResult.sessionId ?? undefined,
        correlationId, draftId: taskId, repository,
        agentAlias: 'claude',
        usageMetrics: mapUsageMetrics(claudeResult.usageMetrics),
        usageMetricRecords: claudeResult.usageMetrics?.records,
        workRef: buildWorkRef({ executionType, taskId, prNumber, issueRef, repository }),
    }));

    const analysisText = (claudeResult.finalResult?.result || claudeResult.summary)?.trim();
    if (analysisText) {
        correlatedLogger.info({ model, responseLength: analysisText.length, exitCode: claudeResult.exitCode }, 'Lightweight LLM analysis completed via Docker');
        return analysisText;
    }

    correlatedLogger.error({ exitCode: claudeResult.exitCode, rawOutputLength: claudeResult.rawOutput?.length }, 'Claude execution did not produce valid result');
    throw new Error(`Invalid analysis response from Claude execution: ${claudeResult.error || 'No result returned'}`);
}

export async function runLightweightLLMAnalysis(options: RunLightweightLLMAnalysisOptions): Promise<string> {
    const { prompt, model, correlationId, taskId, prNumber, issueRef, executionType = 'other', metadata, timeoutMs } = options;
    const reasoningLevel = options.reasoningLevel ?? issueRef.reasoningLevel;
    const correlatedLogger = logger.withCorrelation(correlationId);

    const { agentAlias, modelOverride, effectiveModel } = parseAgentModelFormat(model, correlatedLogger);

    if (agentAlias) {
        try {
            const repository = issueRef ? `${issueRef.repoOwner}/${issueRef.repoName}` : undefined;
            const taskNumber = issueRef?.number;
            // Pass all logging fields to agent - agent handles persistence internally
            const analysisResult = await tryExecuteWithAgent({
                agentAlias, modelOverride, prompt, taskId, taskNumber, prNumber, executionType,
                correlationId, repository, metadata, timeoutMs, reasoningLevel, correlatedLogger
            });
            if (analysisResult !== null) {
                if (!analysisResult.success) {
                    throw new Error(analysisResult.error || 'Agent analysis failed');
                }
                correlatedLogger.info({ agentAlias, model: analysisResult.modelUsed, responseLength: analysisResult.response.length }, 'Agent analysis completed');
                return analysisResult.response;
            }
        } catch (agentError) {
            const err = agentError as Error;
            correlatedLogger.error({ error: err.message, agentAlias }, 'Agent execution failed');
            throw new Error(`Agent '${agentAlias}' failed: ${err.message}`);
        }
    }

    const resolvedModel = resolveModelAlias(effectiveModel);
    correlatedLogger.info({ model, resolvedModel }, 'Running lightweight LLM analysis via Docker...');

    try {
        return await executeClaudeAnalysis(options, resolvedModel, correlatedLogger);
    } catch (error) {
        const err = error as Error;
        correlatedLogger.error({ error: err.message, model }, 'Lightweight LLM analysis failed');
        throw error;
    }
}
