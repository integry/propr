import type { Logger } from 'pino';
import { AgentRegistry, resolveLlmLabel, runLightweightLLMAnalysis } from '@propr/core';
import { getDefaultModel, loadSettings, loadSummarizationSettings, NoDefaultModelConfiguredError } from '@propr/core';
import type { AnalysisResult, ClaudeCodeResponse } from '@propr/core';
import type { WorkerStateManager } from '@propr/core';
import type { WorktreeInfo } from '@propr/core';
import { createSessionIdCallbackForPR, createContainerIdCallbackForPR } from './prCommentJobHelpers.js';
import { agentResultToClaudeResponse } from './prCommentJobUtils.js';
import { isGenericPrTitleText, selectFallbackSummaryLine } from './prTaskTitleHelpers.js';
import type { Redis } from 'ioredis';
import type { GitHubToken } from './githubTypes.js';
import type { ReasoningLevel } from '@propr/shared';

const DEFAULT_MODEL_NAME = process.env.DEFAULT_CLAUDE_MODEL || getDefaultModel() || null;
const MAX_GENERATED_SUBTITLE_LENGTH = 140;
const CONFIGURED_TITLE_GENERATION_TIMEOUT_MS = Number.parseInt(process.env.PR_TASK_TITLE_GENERATION_TIMEOUT_MS || '5000', 10);
const TITLE_GENERATION_TIMEOUT_MS = Number.isFinite(CONFIGURED_TITLE_GENERATION_TIMEOUT_MS) ? CONFIGURED_TITLE_GENERATION_TIMEOUT_MS : 5000;
const NOOP_LOGGER = { debug: () => undefined, warn: () => undefined } as unknown as Logger;

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
    titleGenerationTimeoutMs?: number;
    reasoningLevel?: ReasoningLevel;
}

type TitleAnalysisOptions = Parameters<typeof runLightweightLLMAnalysis>[0];
type TitleAnalysisOptionsWithoutWorktree = Omit<TitleAnalysisOptions, 'worktreePath'>;

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

function buildFallbackGeneratedSubtitle(workflowLabel: string | undefined, firstLine: string): string {
    const prefix = workflowLabel || 'Follow-up';
    const clipped = `${firstLine.substring(0, 75)}${firstLine.length > 75 ? '...' : ''}`;
    const lowerClipped = clipped.toLowerCase();
    const lowerPrefix = prefix.toLowerCase();
    if (lowerClipped === lowerPrefix || lowerClipped.startsWith(`${lowerPrefix}:`) || lowerClipped.startsWith(`${lowerPrefix} `)) {
        return clipped;
    }
    return `${prefix}: ${clipped}`;
}

function stripWorkflowPrefix(value: string, workflowLabel: string | undefined): string {
    const prefix = workflowLabel || 'Follow-up';
    return value.replace(new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:?\\s*`, 'i'), '').trim();
}

function buildContextFallbackSubtitle(context: string, workflowLabel: string | undefined, deterministicFallback: string): string {
    const firstLine = selectFallbackSummaryLine(context).replace(/\s+/g, ' ').trim();
    if (!firstLine) return deterministicFallback;
    return buildFallbackGeneratedSubtitle(workflowLabel, firstLine);
}

function isGenericGeneratedSubtitle(value: string, workflowLabel: string | undefined): boolean {
    const withoutWorkflow = stripWorkflowPrefix(value, workflowLabel);
    return isGenericPrTitleText(withoutWorkflow);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const timeoutPromise = new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    });
    return Promise.race([promise, timeoutPromise]).finally(() => {
        if (timeout) clearTimeout(timeout);
    });
}

async function runWorktreeFreeTitleAnalysis(options: TitleAnalysisOptions, correlatedLogger: Logger): Promise<string> {
    const registry = AgentRegistry.getInstance();
    await registry.ensureInitialized();

    const resolution = options.model === 'haiku'
        ? await resolveDefaultAgentAndModel(registry, correlatedLogger)
        : await resolveLlmLabel(options.model);
    const agentAlias = 'resolvedAlias' in resolution ? resolution.resolvedAlias : resolution.agentAlias;
    const model = 'resolvedModel' in resolution ? resolution.resolvedModel : resolution.model;
    const agent = registry.getAgentByAlias(agentAlias);
    if (!agent) throw new Error(`Agent not found for alias: ${agentAlias}`);

    const repository = `${options.issueRef.repoOwner}/${options.issueRef.repoName}`;
    const result: AnalysisResult = await agent.analyze(options.prompt, {
        model,
        taskId: options.taskId,
        taskNumber: options.issueRef.number,
        prNumber: options.prNumber,
        executionType: options.executionType,
        correlationId: options.correlationId,
        repository,
        metadata: options.metadata,
        timeoutMs: options.timeoutMs,
        reasoningLevel: options.reasoningLevel ?? options.issueRef.reasoningLevel,
    });

    if (!result.success) {
        throw new Error(result.error || 'Agent title analysis failed');
    }
    return result.response;
}

function runTitleAnalysis(options: {
    analysisOptions: TitleAnalysisOptionsWithoutWorktree;
    analysisRunner?: typeof runLightweightLLMAnalysis;
    worktreeInfo?: WorktreeInfo;
    correlatedLogger: Logger;
}): Promise<string> {
    if (options.analysisRunner) {
        return options.analysisRunner({
            ...options.analysisOptions,
            worktreePath: options.worktreeInfo?.worktreePath || '',
        });
    }
    if (options.worktreeInfo?.worktreePath) {
        return runLightweightLLMAnalysis({
            ...options.analysisOptions,
            worktreePath: options.worktreeInfo.worktreePath,
        });
    }
    return runWorktreeFreeTitleAnalysis({
        ...options.analysisOptions,
        worktreePath: '',
    }, options.correlatedLogger);
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
        const prText = prTitle && !isGenericPrTitleText(prTitle) ? `PR #${pullRequestNumber}: ${prTitle}` : `PR #${pullRequestNumber}`;
        const summaryRequest = `Summarize this ${workflowText} as a concise task subtitle for ${prText}. Focus on the concrete action or discussion context, not the slash command itself.\n\nContext:\n${contextToSummarize}`;
        const summarizationSettings = await (options.summarizationSettingsLoader || loadSummarizationSettings)();
        const configuredModel = summarizationSettings.agent_alias?.trim();
        const model = configuredModel || 'haiku';
        const timeoutMs = options.titleGenerationTimeoutMs ?? TITLE_GENERATION_TIMEOUT_MS;
        const analysisOptions: TitleAnalysisOptionsWithoutWorktree = {
            prompt: `${summaryRequest}\n\nYour output must be ONLY the summary string itself, with no other text.`,
            model,
            correlationId,
            githubToken: githubToken.token,
            issueRef: { number: pullRequestNumber, repoOwner, repoName, reasoningLevel: options.reasoningLevel },
            taskId,
            prNumber: pullRequestNumber,
            executionType: 'title-generation',
            metadata: {
                taskKind: titleGenerationTaskKind(workflowLabel),
                configuredVia: configuredModel ? 'summarization.agent_alias' : 'fallback'
            },
            timeoutMs,
            reasoningLevel: options.reasoningLevel,
        };
        const titlePromise = runTitleAnalysis({
            analysisOptions,
            analysisRunner: options.analysisRunner,
            worktreeInfo,
            correlatedLogger,
        });
        const title = await withTimeout(titlePromise, timeoutMs, 'PR task title generation');
        const sanitizedTitle = sanitizeGeneratedSubtitle(title, deterministicFallback);
        if (isGenericGeneratedSubtitle(sanitizedTitle, workflowLabel)) {
            const fallbackFromContext = buildContextFallbackSubtitle(contextToSummarize, workflowLabel, deterministicFallback);
            correlatedLogger.warn({ taskId, summaryTitle: sanitizedTitle, fallbackSubtitle: fallbackFromContext }, 'Generated PR task subtitle was generic, falling back to context.');
            return fallbackFromContext;
        }
        correlatedLogger.info({ taskId, summaryTitle: sanitizedTitle }, 'Generated AI summary for PR task subtitle');
        return sanitizedTitle;
    } catch (summaryError) {
        correlatedLogger.warn({ taskId, error: (summaryError as Error).message }, 'Failed to generate AI summary, falling back to truncation.');
        if (contextToSummarize) return buildContextFallbackSubtitle(contextToSummarize, workflowLabel, deterministicFallback);
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
            modelName = DEFAULT_MODEL_NAME || llm;
        }
    } else {
        const registry = AgentRegistry.getInstance();
        await registry.ensureInitialized();
        modelName = (await resolveDefaultAgentAndModel(registry, correlatedLogger)).resolvedModel;
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
    reasoningLevel?: ReasoningLevel;
}

export async function resolveAndExecuteAgent(params: AgentExecutionParams): Promise<{ claudeResult: ClaudeCodeResponse; agentType: string }> {
    const { llm, worktreePath, branchName, prompt, pullRequestNumber, repoOwner, repoName, taskId, stateManager, correlatedLogger, githubToken, redisClient, reasoningLevel } = params;

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
        pullRequestNumber,
        reasoningLevel,
    }, 'Executing PR comment task with agent');

    const agentResult = await agent.executeTask({
        worktreePath,
        issueRef: { number: pullRequestNumber, repoOwner, repoName, reasoningLevel },
        prompt,
        model: modelToUse,
        githubToken,
        branchName,
        onSessionId: createSessionIdCallbackForPR(taskId, { pullRequestNumber, repoOwner, repoName }, { llm: modelToUse, stateManager, correlatedLogger, redisClient }),
        onContainerId: createContainerIdCallbackForPR(taskId, stateManager),
        taskId,
        prNumber: pullRequestNumber,
        reasoningLevel,
    });

    return { claudeResult: agentResultToClaudeResponse(agentResult), agentType: agent.config.type };
}
