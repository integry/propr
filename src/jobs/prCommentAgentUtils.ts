import type { Logger } from 'pino';
import { AgentRegistry, resolveLlmLabel, runLightweightLLMAnalysis } from '@propr/core';
import { getDefaultModel, loadSettings, loadSummarizationSettings, NoDefaultModelConfiguredError } from '@propr/core';
import type { ClaudeCodeResponse } from '@propr/core';
import type { WorkerStateManager } from '@propr/core';
import type { WorktreeInfo } from '@propr/core';
import { createSessionIdCallbackForPR, createContainerIdCallbackForPR } from './prCommentJobHelpers.js';
import { agentResultToClaudeResponse } from './prCommentJobUtils.js';
import type { Redis } from 'ioredis';

const DEFAULT_MODEL_NAME = process.env.DEFAULT_CLAUDE_MODEL || getDefaultModel() || null;

interface GitHubToken { token: string }

interface SummaryTitleOptions {
    combinedCommentBody: string;
    worktreeInfo: WorktreeInfo;
    githubToken: GitHubToken;
    pullRequestNumber: number;
    repoOwner: string;
    repoName: string;
    correlationId: string;
    taskId: string;
    correlatedLogger: Logger;
}

export async function generateSummaryTitle(options: SummaryTitleOptions): Promise<string> {
    const { combinedCommentBody, worktreeInfo, githubToken, pullRequestNumber, repoOwner, repoName, correlationId, taskId, correlatedLogger } = options;
    try {
        const summaryRequest = `Summarize this change request in one sentence, focusing on the main action: ${combinedCommentBody}`;
        const summarizationSettings = await loadSummarizationSettings();
        const configuredModel = summarizationSettings.agent_alias?.trim();
        const model = configuredModel || 'haiku';
        const title = await runLightweightLLMAnalysis({
            prompt: `${summaryRequest}\n\nYour output must be ONLY the summary string itself, with no other text.`,
            model,
            correlationId,
            worktreePath: worktreeInfo.worktreePath,
            githubToken: githubToken.token,
            issueRef: { number: pullRequestNumber, repoOwner, repoName },
            taskId,
            prNumber: pullRequestNumber,
            executionType: 'title-generation',
            metadata: {
                taskKind: 'pr-followup-title-generation',
                configuredVia: configuredModel ? 'summarization.agent_alias' : 'fallback'
            }
        });
        correlatedLogger.info({ taskId, summaryTitle: title }, 'Generated AI summary for follow-up task');
        return title;
    } catch (summaryError) {
        correlatedLogger.warn({ taskId, error: (summaryError as Error).message }, 'Failed to generate AI summary, falling back to truncation.');
        if (combinedCommentBody) {
            const firstLine = combinedCommentBody.split('\n')[0].replace(/[^a-zA-Z0-9 ]/g, '').trim();
            return "Follow-up: " + firstLine.substring(0, 75) + (firstLine.length > 75 ? '...' : '');
        }
        return `Follow-up: PR #${pullRequestNumber}`;
    }
}

async function resolveDefaultAgentAndModel(
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
