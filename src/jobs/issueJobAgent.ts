import type { Logger } from 'pino';
import type { Redis } from 'ioredis';
import { TaskStates } from '@gitfix/core';
import type { WorkerStateManager } from '@gitfix/core';
import type { WorktreeInfo } from '@gitfix/core';
import type { ClaudeCodeResponse } from '@gitfix/core';
import type { ClaudeResult } from '@gitfix/core';
import { recordLLMMetrics } from '@gitfix/core';
import { AgentRegistry, generateClaudePrompt } from '@gitfix/core';
import type { AgentExecutionResult } from '@gitfix/core';
import { localizeContentImages } from './issueJobHelpers.js';
import { createSessionIdCallback, createContainerIdCallback } from './issueJobCallbacks.js';
import type { IssueJobData } from '@gitfix/core';

interface GitHubToken {
    token: string;
}

interface CurrentIssueData {
    data: {
        title: string;
        body: string | null | undefined;
        labels: Array<{ name: string }>;
        created_at: string;
        updatedAt?: string;
        user: { login: string };
    };
}

interface IssueComment {
    id: number;
    body: string;
    body_html?: string;
    user: { login: string; type?: string };
}

export interface ExecutionParams {
    octokit: { request: <T = unknown>(endpoint: string, options: Record<string, unknown>) => Promise<T> };
    worktreeInfo: WorktreeInfo;
    issueRef: IssueJobData;
    githubToken: GitHubToken;
    currentIssueData: CurrentIssueData;
    issueComments: IssueComment[];
}

export interface AgentJobContext {
    taskId: string;
    agentAlias: string;
    modelName: string;
    stateManager: WorkerStateManager;
    correlatedLogger: Logger;
    correlationId: string;
}

function toClaudeResult(response: AgentExecutionResult): ClaudeResult {
    return {
        model: response.modelUsed,
        success: response.success,
        executionTime: response.executionTimeMs,
        sessionId: response.sessionId,
        conversationId: response.conversationId,
        finalResult: response.summary ? { type: 'result', result: response.summary } : null,
        conversationLog: undefined,
        error: response.error
    };
}

function agentResultToClaudeResponse(result: AgentExecutionResult): ClaudeCodeResponse {
    return {
        success: result.success,
        model: result.modelUsed,
        executionTime: result.executionTimeMs,
        output: null,
        sessionId: result.sessionId || null,
        conversationId: result.conversationId,
        finalResult: result.summary ? { type: 'result', result: result.summary } : null,
        rawOutput: result.rawOutput,
        summary: result.summary || null,
        logs: result.logs,
        exitCode: result.exitCode ?? null,
        error: result.error,
        modifiedFiles: result.modifiedFiles,
        commitMessage: result.commitMessage || null
    };
}

interface LocalizeContentParams {
    currentIssueData: CurrentIssueData;
    issueComments: IssueComment[];
    worktreePath: string;
    issueNumber: number;
    correlatedLogger: Logger;
}

async function localizeIssueContent(params: LocalizeContentParams): Promise<{ localizedBody: string | undefined; localizedComments: IssueComment[] }> {
    const { currentIssueData, issueComments, worktreePath, issueNumber, correlatedLogger } = params;
    const issueBodyHtml = (currentIssueData.data as { body_html?: string }).body_html;
    const localizedBody = currentIssueData.data.body
        ? await localizeContentImages(currentIssueData.data.body, worktreePath, correlatedLogger, { bodyHtml: issueBodyHtml, issueOrPrId: issueNumber })
        : undefined;

    const localizedComments = await Promise.all(
        issueComments.map(async (comment) => ({
            ...comment,
            body: comment.body ? await localizeContentImages(comment.body, worktreePath, correlatedLogger, { bodyHtml: comment.body_html, issueOrPrId: issueNumber }) : comment.body
        }))
    );

    return { localizedBody, localizedComments };
}

export async function executeAgentAndRecordMetrics(
    executionParams: ExecutionParams,
    context: AgentJobContext,
    redisClient: Redis
): Promise<ClaudeCodeResponse> {
    const { worktreeInfo, issueRef, githubToken, currentIssueData, issueComments } = executionParams;
    const { taskId, agentAlias, modelName, stateManager, correlatedLogger, correlationId } = context;

    const registry = AgentRegistry.getInstance();
    const agent = registry.getAgentByAlias(agentAlias);

    if (!agent) {
        throw new Error(`Agent not found: ${agentAlias}`);
    }

    correlatedLogger.info({
        agentAlias,
        agentType: agent.config.type,
        modelName,
        issueNumber: issueRef.number
    }, 'Executing task with agent');

    const { localizedBody, localizedComments } = await localizeIssueContent({
        currentIssueData,
        issueComments,
        worktreePath: worktreeInfo.worktreePath,
        issueNumber: issueRef.number,
        correlatedLogger
    });

    const prompt = generateClaudePrompt(
        { number: issueRef.number, repoOwner: issueRef.repoOwner, repoName: issueRef.repoName },
        worktreeInfo.branchName,
        modelName,
        {
            title: currentIssueData.data.title,
            body: localizedBody,
            comments: localizedComments,
            labels: currentIssueData.data.labels,
            created_at: currentIssueData.data.created_at,
            user: currentIssueData.data.user
        }
    );

    const agentResult = await agent.executeTask({
        worktreePath: worktreeInfo.worktreePath,
        issueRef: { number: issueRef.number, repoOwner: issueRef.repoOwner, repoName: issueRef.repoName },
        prompt,
        model: modelName,
        githubToken: githubToken.token,
        branchName: worktreeInfo.branchName,
        onSessionId: createSessionIdCallback(taskId, issueRef, { modelName, stateManager, correlatedLogger, redisClient }),
        onContainerId: createContainerIdCallback(taskId, stateManager, correlatedLogger),
        taskId
    });

    const claudeResult = agentResultToClaudeResponse(agentResult);

    const currentState = await stateManager.getTaskState(taskId);
    const TERMINAL_STATES: string[] = [TaskStates.COMPLETED, TaskStates.FAILED, TaskStates.CANCELLED];
    if (currentState && TERMINAL_STATES.includes(currentState.state)) {
        correlatedLogger.info({ taskId, currentState: currentState.state }, 'Task already in terminal state after agent execution, skipping state update');
        if (currentState.state === TaskStates.CANCELLED) {
            throw new Error('Execution aborted by user request');
        }
        throw new Error(`Task already in terminal state: ${currentState.state}`);
    }

    await stateManager.updateTaskState(taskId, TaskStates.CLAUDE_EXECUTION, {
        reason: `${agent.config.type} agent execution completed`,
        claudeResult: { success: claudeResult.success, sessionId: claudeResult.sessionId, conversationId: claudeResult.conversationId, executionTime: claudeResult.executionTime },
        historyMetadata: { sessionId: claudeResult.sessionId, conversationId: claudeResult.conversationId, model: claudeResult.model }
    });

    await recordLLMMetrics(toClaudeResult(agentResult), { number: issueRef.number, repoOwner: issueRef.repoOwner, repoName: issueRef.repoName }, { jobType: 'issue', correlationId, taskId });

    correlatedLogger.info({
        agentAlias,
        success: agentResult.success,
        executionTimeMs: agentResult.executionTimeMs,
        modelUsed: agentResult.modelUsed
    }, 'Agent execution completed');

    return claudeResult;
}
