import type { Logger } from 'pino';
import { AgentRegistry, resolveLlmLabel, runLightweightLLMAnalysis } from '@propr/core';
import { getDefaultModel, loadSettings, loadSummarizationSettings, NoDefaultModelConfiguredError } from '@propr/core';
import type { ClaudeCodeResponse } from '@propr/core';
import type { WorkerStateManager } from '@propr/core';
import type { WorktreeInfo } from '@propr/core';
import { createSessionIdCallbackForPR, createContainerIdCallbackForPR } from './prCommentJobHelpers.js';
import { agentResultToClaudeResponse } from './prCommentJobUtils.js';
import { selectFallbackSummaryLine } from './prTaskTitleHelpers.js';
import type { Redis } from 'ioredis';

const DEFAULT_MODEL_NAME = process.env.DEFAULT_CLAUDE_MODEL || getDefaultModel() || null;
const MAX_GENERATED_SUBTITLE_LENGTH = 140;
const NOOP_LOGGER = { debug: () => undefined, warn: () => undefined } as unknown as Logger;

interface GitHubToken { token: string }

interface SummaryTitleOptions {
    combinedCommentBody: string;
    titleContext?: string;
    fallbackSubtitle?: string;
    worktreeInfo?: WorktreeInfo;
    githubToken: GitHubToken;
    pullRequestNumber: number;
    prTitle?: string;
    workflowLabel?: string;
    repoOwner: string;
    repoName: string;
    correlationId: string;
    taskId: string;
    correlatedLogger: Logger;
    analysisRunner?: typeof runLightweightLLMAnalysis;
    summarizationSettingsLoader?: typeof loadSummarizationSettings;
}

function sanitizeGeneratedSubtitle(value: string, fallbackSubtitle: string): string {
    const cleaned = value.replace(/\s+/g, ' ').trim();
    const quote = cleaned[0];
    const unquoted = quote && quote === cleaned[cleaned.length - 1] && ['"', "'", '`'].includes(quote)
        ? cleaned.substring(1, cleaned.length - 1).trim()
        : cleaned;
    if (!unquoted) return fallbackSubtitle;
    return unquoted.length > MAX_GENERATED_SUBTITLE_LENGTH
        ? `${unquoted.substring(0, MAX_GENERATED_SUBTITLE_LENGTH - 3).trimEnd()}...`
        : unquoted;
}

function titleGenerationTaskKind(workflowLabel?: string): string {
    const workflow = (workflowLabel || 'workflow')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '') || 'workflow';
    return `pr-${workflow}-title-generation`;
}

export async function generateSummaryTitle(options: SummaryTitleOptions): Promise<string> {
    const { combinedCommentBody, titleContext, fallbackSubtitle, worktreeInfo, githubToken, pullRequestNumber, prTitle, workflowLabel, repoOwner, repoName, correlationId, taskId, correlatedLogger } = options;
    const contextToSummarize = (titleContext !== undefined ? titleContext : combinedCommentBody || '').trim();
    const deterministicFallback = fallbackSubtitle || `Follow-up: PR #${pullRequestNumber}`;
    if (!contextToSummarize) {
        return deterministicFallback;
    }

    try {
        const workflowText = workflowLabel ? `${workflowLabel} workflow` : 'PR workflow';
        const prText = prTitle ? `PR #${pullRequestNumber}: ${prTitle}` : `PR #${pullRequestNumber}`;
        const summaryRequest = `Summarize this ${workflowText} as a concise task subtitle for ${prText}. Focus on the concrete action or discussion context, not the slash command itself.\n\nContext:\n${contextToSummarize}`;
        const summarizationSettings = await (options.summarizationSettingsLoader || loadSummarizationSettings)();
        const configuredModel = summarizationSettings.agent_alias?.trim();
        const model = configuredModel || 'haiku';
        const title = await (options.analysisRunner || runLightweightLLMAnalysis)({
            prompt: `${summaryRequest}\n\nYour output must be ONLY the summary string itself, with no other text.`,
            model,
            correlationId,
            worktreePath: worktreeInfo?.worktreePath || process.cwd(),
            githubToken: githubToken.token,
            issueRef: { number: pullRequestNumber, repoOwner, repoName },
            taskId,
            prNumber: pullRequestNumber,
            executionType: 'title-generation',
            metadata: {
                taskKind: titleGenerationTaskKind(workflowLabel),
                configuredVia: configuredModel ? 'summarization.agent_alias' : 'fallback'
            }
        });
        const sanitizedTitle = sanitizeGeneratedSubtitle(title, deterministicFallback);
        correlatedLogger.info({ taskId, summaryTitle: sanitizedTitle }, 'Generated AI summary for PR task subtitle');
        return sanitizedTitle;
    } catch (summaryError) {
        correlatedLogger.warn({ taskId, error: (summaryError as Error).message }, 'Failed to generate AI summary, falling back to truncation.');
        if (contextToSummarize) {
            const firstLine = selectFallbackSummaryLine(contextToSummarize).replace(/\s+/g, ' ').trim();
            if (!firstLine) return deterministicFallback;
            const prefix = workflowLabel || 'Follow-up';
            return `${prefix}: ${firstLine.substring(0, 75)}${firstLine.length > 75 ? '...' : ''}`;
        }
        return deterministicFallback;
    }
}

export async function resolveDefaultAgentAndModel(
    registry: AgentRegistry,
    correlatedLogger: Logger
): Promise<{ resolvedAlias: string; resolvedModel: string }> {
    try {
        const settings = await loadSettings();
        if (settings.default_agent_alias) {
            const configuredAgent = registry.getAgentByAlias(settings.default_agent_alias as string);
            if (configuredAgent && configuredAgent.config.enabled) {
                const resolvedAlias = settings.default_agent_alias as string;
                const resolvedModel = configuredAgent.config.defaultModel || DEFAULT_MODEL_NAME;
                if (!resolvedModel) {
                    throw new NoDefaultModelConfiguredError();
                }
                correlatedLogger.debug({ configuredDefaultAgent: resolvedAlias, defaultModel: resolvedModel }, 'Using default agent from settings');
                return { resolvedAlias, resolvedModel };
            }
        }
    } catch (settingsError) {
        if (settingsError instanceof NoDefaultModelConfiguredError) throw settingsError;
        correlatedLogger.debug({ error: (settingsError as Error).message }, 'Failed to load default agent from settings');
    }

    const defaultAgent = registry.getDefaultAgent();
    const resolvedAlias = defaultAgent?.config.alias || 'claude';
    const resolvedModel = defaultAgent?.config.defaultModel || DEFAULT_MODEL_NAME;
    if (!resolvedModel) {
        throw new NoDefaultModelConfiguredError();
    }
    correlatedLogger.debug({ fallbackAgent: resolvedAlias, fallbackModel: resolvedModel }, 'Using fallback default agent');
    return { resolvedAlias, resolvedModel };
}

export async function resolvePRCommentModelName(llm: string | null | undefined, correlatedLogger: Logger = NOOP_LOGGER): Promise<string> {
    let modelName: string | null = DEFAULT_MODEL_NAME;
    if (llm) {
        try {
            modelName = (await resolveLlmLabel(llm)).model;
        } catch (labelError) {
            correlatedLogger.warn({ llm, error: (labelError as Error).message }, 'Failed to resolve explicit LLM label for PR comment task state');
            throw labelError;
        }
    } else {
        try {
            const registry = AgentRegistry.getInstance();
            await registry.ensureInitialized();
            modelName = (await resolveDefaultAgentAndModel(registry, correlatedLogger)).resolvedModel;
        } catch {
            // Keep the configured default if the registry is unavailable.
        }
    }
    if (!modelName) throw new NoDefaultModelConfiguredError();
    return modelName;
}

export interface AgentExecutionParams {
    llm: string | null | undefined;
    worktreePath: string;
    branchName: string;
    prompt: string;
    pullRequestNumber: number;
    repoOwner: string;
    repoName: string;
    taskId: string;
    stateManager: WorkerStateManager;
    correlatedLogger: Logger;
    githubToken: string;
    redisClient: Redis;
}

export async function resolveAndExecuteAgent(params: AgentExecutionParams): Promise<{ claudeResult: ClaudeCodeResponse; agentType: string }> {
    const { llm, worktreePath, branchName, prompt, pullRequestNumber, repoOwner, repoName, taskId, stateManager, correlatedLogger, githubToken, redisClient } = params;

    const registry = AgentRegistry.getInstance();
    await registry.ensureInitialized();

    let agentAlias: string;
    let modelToUse: string;

    if (llm) {
        const resolution = await resolveLlmLabel(llm);
        agentAlias = resolution.agentAlias;
        modelToUse = resolution.model;
    } else {
        const { resolvedAlias, resolvedModel } = await resolveDefaultAgentAndModel(registry, correlatedLogger);
        agentAlias = resolvedAlias;
        modelToUse = resolvedModel;
    }

    const agent = registry.getAgentByAlias(agentAlias);

    if (!agent) {
        throw new Error(`Agent not found for alias: ${agentAlias}`);
    }

    correlatedLogger.info({
        agentAlias,
        agentType: agent.config.type,
        model: modelToUse,
        pullRequestNumber
    }, 'Executing PR comment task with agent');

    const agentResult = await agent.executeTask({
        worktreePath,
        issueRef: { number: pullRequestNumber, repoOwner, repoName },
        prompt,
        model: modelToUse,
        githubToken,
        branchName,
        onSessionId: createSessionIdCallbackForPR(taskId, { pullRequestNumber, repoOwner, repoName }, { llm: modelToUse, stateManager, correlatedLogger, redisClient }),
        onContainerId: createContainerIdCallbackForPR(taskId, stateManager),
        taskId,
        prNumber: pullRequestNumber
    });

    return { claudeResult: agentResultToClaudeResponse(agentResult), agentType: agent.config.type };
}
