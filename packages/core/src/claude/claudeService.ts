import path from 'path';
import os from 'os';
import logger from '../utils/logger.js';
import { getDefaultModel, resolveModelAlias } from '../config/modelAliases.js';
import { AgentRegistry } from '../agents/AgentRegistry.js';
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
import type { ExecutionType, ConversationStep } from '../utils/llmMetrics.types.js';
export { UsageLimitError };
export type { IssueRef, IssueDetails };

const CLAUDE_DOCKER_IMAGE: string = process.env.CLAUDE_DOCKER_IMAGE || 'claude-code-processor:latest';
const CLAUDE_CONFIG_PATH: string = process.env.CLAUDE_CONFIG_PATH || path.join(os.homedir(), '.claude');
const CLAUDE_MAX_TURNS: number = parseInt(process.env.CLAUDE_MAX_TURNS || '1000', 10);
const CLAUDE_TIMEOUT_MS: number = parseInt(process.env.CLAUDE_TIMEOUT_MS || '300000', 10);

/**
 * @deprecated Use AgentRegistry and Agent.executeTask() instead.
 * This function is maintained for backward compatibility.
 */

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
    taskId?: string; // For abort signal checking (e.g., draftId for planning)
    executionType?: ExecutionType; // Type of execution for metrics tracking (defaults to 'lightweight-analysis')
}


/**
 * Executes Claude Code in a Docker container.
 *
 * @deprecated This function is maintained for backward compatibility.
 * New code should use AgentRegistry to get an agent and call executeTask() directly:
 *
 * ```typescript
 * const registry = AgentRegistry.getInstance();
 * await registry.ensureInitialized();
 * const agent = registry.getDefaultAgent();
 * const result = await agent.executeTask(options);
 * ```
 */
export async function executeClaudeCode(options: ExecuteClaudeCodeOptions): Promise<ClaudeCodeResponse> {
    const { worktreePath, issueRef, githubToken, customPrompt, isRetry = false, retryReason, branchName, modelName, issueDetails, onSessionId, onContainerId } = options;
    const startTime = Date.now();

    logger.info({
        issueNumber: issueRef.number,
        repository: `${issueRef.repoOwner}/${issueRef.repoName}`,
        worktreePath,
        dockerImage: CLAUDE_DOCKER_IMAGE,
        isRetry,
        retryReason
    }, isRetry ? 'Starting Claude Code execution (RETRY)...' : 'Starting Claude Code execution...');

    try {
        const prompt = buildClaudePrompt({ customPrompt, issueRef, branchName, modelName, issueDetails, isRetry, retryReason });
        await setWorktreeOwnership(worktreePath, issueRef.number);
        const worktreeGitContent = verifyWorktreeStructure(worktreePath, issueRef.number);

        const dockerArgs = buildDockerArgs({
            worktreePath,
            githubToken,
            prompt,
            modelName,
            issueNumber: issueRef.number,
            CLAUDE_DOCKER_IMAGE,
            CLAUDE_CONFIG_PATH,
            CLAUDE_MAX_TURNS,
            systemPrompt: options.systemPrompt,
            tools: options.tools
        });

        const result = await executeDockerCommand('docker', dockerArgs, {
            timeout: CLAUDE_TIMEOUT_MS,
            cwd: worktreePath,
            onSessionId,
            onContainerId,
            worktreePath,
            stdinData: prompt // Always pass prompt via stdin
        });

        const executionTime = Date.now() - startTime;
        logger.info({
            issueNumber: issueRef.number,
            repository: `${issueRef.repoOwner}/${issueRef.repoName}`,
            executionTime,
            outputLength: result.stdout?.length || 0,
            success: result.exitCode === 0,
            exitCode: result.exitCode
        }, 'Claude Code execution completed');

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
            model: claudeOutput.model || process.env.CLAUDE_MODEL || getDefaultModel(),
            finalResult: claudeOutput.finalResult,
            modifiedFiles: [],
            commitMessage: null,
            summary: claudeOutput.finalResult?.result || null,
            prompt: prompt,
            tokenUsage: claudeOutput.tokenUsage
        };

        await storePromptInRedis({ claudeOutput, prompt, issueRef, model: response.model!, isRetry, retryReason });

        if (!response.success) {
            logger.error({ issueNumber: issueRef.number, exitCode: result.exitCode, stderr: result.stderr }, 'Claude Code execution failed');
        } else {
            logger.info({
                issueNumber: issueRef.number,
                conversationTurns: response.conversationLog?.length || 0,
                model: response.model
            }, 'Claude Code execution succeeded');
            verifyWorktreePostExecution(worktreePath, issueRef.number, worktreeGitContent);
        }

        return response;
    } catch (error) {
        const executionTime = Date.now() - startTime;
        const err = error as Error;
        logger.error({
            issueNumber: issueRef.number,
            repository: `${issueRef.repoOwner}/${issueRef.repoName}`,
            executionTime,
            error: err.message
        }, 'Error during Claude Code execution');

        return {
            success: false,
            error: err.message,
            executionTime,
            output: null,
            logs: (error as { stderr?: string }).stderr || err.message,
            modifiedFiles: [],
            commitMessage: null,
            summary: null
        };
    }
}

const LIGHTWEIGHT_SYSTEM_PROMPT = 'You are a helpful assistant.';
const LIGHTWEIGHT_TOOLS = '';

export async function generateTaskSummary(options: GenerateTaskSummaryOptions): Promise<string> {
    const { summaryRequest, worktreePath, githubToken, issueRef, correlationId, modelAlias = 'haiku' } = options;
    const correlatedLogger = logger.withCorrelation(correlationId);
    correlatedLogger.info({ modelAlias, issueRef: issueRef.number }, 'Generating task summary via Docker executor...');

    const model = resolveModelAlias(modelAlias);

    const summaryPrompt = `Please provide a one-sentence summary for the following request, focusing on the main action. Your output must be ONLY the summary string itself, with no other text.

REQUEST:
${summaryRequest}

CRITICAL: Do not modify any files. Do not run any commands. Only output the summary.`;

    try {
        const claudeResult = await executeClaudeCode({
            worktreePath: worktreePath,
            issueRef: issueRef,
            githubToken: githubToken,
            customPrompt: summaryPrompt,
            branchName: 'summary-generation',
            modelName: model,
            systemPrompt: LIGHTWEIGHT_SYSTEM_PROMPT,
            tools: LIGHTWEIGHT_TOOLS
        });

        // Record metrics for title generation
        await recordLLMMetrics(
            {
                model: claudeResult.model ?? model,
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
            },
            issueRef,
            {
                correlationId,
                executionType: 'title-generation'
            }
        );

        if (claudeResult.success && (claudeResult.finalResult?.result || claudeResult.summary)) {
            const summary = (claudeResult.finalResult?.result || claudeResult.summary)!.trim().replace(/^"|"$/g, '');
            correlatedLogger.info({ summary, model }, 'Successfully generated task summary');
            return summary;
        }

        throw new Error(`Invalid summary response from Claude execution: ${claudeResult.error}`);
    } catch (error) {
        const err = error as Error;
        correlatedLogger.error({ error: err.message, model, promptLength: summaryPrompt.length }, 'Failed to generate task summary');
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
        const modelOverride = parts.slice(1).join(':'); // Handle model IDs that might contain colons
        correlatedLogger.info({ model, agentAlias, modelOverride }, 'Parsed agent:model format for lightweight analysis');
        return { agentAlias, modelOverride, effectiveModel: modelOverride };
    }
    return { effectiveModel: model };
}

interface AgentExecutionParams {
    agentAlias: string;
    modelOverride?: string;
    prompt: string;
    taskId?: string;
    correlatedLogger: ReturnType<typeof logger.withCorrelation>;
}

async function tryExecuteWithAgent(params: AgentExecutionParams): Promise<string | null> {
    const { agentAlias, modelOverride, prompt, taskId, correlatedLogger } = params;
    const registry = AgentRegistry.getInstance();
    await registry.ensureInitialized();

    const agent = registry.getAgentByAlias(agentAlias);
    if (!agent) {
        correlatedLogger.warn({ agentAlias }, 'Agent not found, falling back to default execution');
        return null;
    }

    const resolvedModel = modelOverride ? resolveModelAlias(modelOverride) : agent.config.defaultModel;
    correlatedLogger.info({ agentAlias, resolvedModel, taskId }, 'Using agent-specific lightweight LLM analysis');
    return await agent.analyze(prompt, undefined, resolvedModel, taskId);
}

async function executeClaudeAnalysis(
    options: RunLightweightLLMAnalysisOptions,
    resolvedModel: string,
    correlatedLogger: ReturnType<typeof logger.withCorrelation>
): Promise<string> {
    const { prompt, correlationId, worktreePath, githubToken, issueRef, taskId, executionType = 'lightweight-analysis', model } = options;

    const analysisPrompt = `${prompt}

CRITICAL: Do not modify any files. Do not run any commands. Only provide direct output.`;

    const claudeResult = await executeClaudeCode({
        worktreePath: worktreePath,
        issueRef: issueRef,
        githubToken: githubToken,
        customPrompt: analysisPrompt,
        branchName: 'analysis-generation',
        modelName: resolvedModel,
        systemPrompt: LIGHTWEIGHT_SYSTEM_PROMPT,
        tools: LIGHTWEIGHT_TOOLS
    });

    await recordLLMMetrics(
        {
            model: claudeResult.model ?? resolvedModel,
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
        },
        issueRef,
        { correlationId, taskId, executionType }
    );

    if (claudeResult.finalResult?.result || claudeResult.summary) {
        const analysisText = (claudeResult.finalResult?.result || claudeResult.summary)!.trim();
        correlatedLogger.info({
            model,
            responseLength: analysisText.length,
            exitCode: claudeResult.exitCode
        }, 'Lightweight LLM analysis completed via Docker');
        return analysisText;
    }

    correlatedLogger.error({
        exitCode: claudeResult.exitCode,
        rawOutputLength: claudeResult.rawOutput?.length,
        rawOutputPreview: claudeResult.rawOutput?.substring(0, 500),
        logs: claudeResult.logs?.substring(0, 500),
        finalResult: claudeResult.finalResult
    }, 'Claude execution did not produce valid result');

    throw new Error(`Invalid analysis response from Claude execution: ${claudeResult.error || 'No result returned'}`);
}

export async function runLightweightLLMAnalysis(options: RunLightweightLLMAnalysisOptions): Promise<string> {
    const { prompt, model, correlationId, taskId } = options;
    const correlatedLogger = logger.withCorrelation(correlationId);

    const { agentAlias, modelOverride, effectiveModel } = parseAgentModelFormat(model, correlatedLogger);

    if (agentAlias) {
        try {
            const result = await tryExecuteWithAgent({ agentAlias, modelOverride, prompt, taskId, correlatedLogger });
            if (result !== null) {
                return result;
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
