/**
 * Agent execution for GitHub issue job.
 */

import {
  TaskStates, AgentRegistry, generateClaudePrompt, updateFileChangesFromWorktree, recordLLMMetrics
} from '@propr/core';
import type { AgentExecutionResult, ClaudeCodeResponse, ClaudeResult } from '@propr/core';
import type { ExecutionParams, JobContext } from './types.js';
import { localizeContentImages } from '../issueJobHelpers.js';
import { createSessionIdCallback, createContainerIdCallback } from '../issueJobCallbacks.js';
import { redisClient } from './config.js';

export function toClaudeResult(response: AgentExecutionResult): ClaudeResult {
  return {
    model: response.modelUsed,
    success: response.success,
    executionTime: response.executionTimeMs,
    sessionId: response.sessionId,
    conversationId: response.conversationId,
    finalResult: response.summary ? { type: 'result', result: response.summary } : null,
    conversationLog: response.conversationLog,
    error: response.error,
    tokenUsage: response.tokenUsage
  };
}

/**
 * Converts AgentExecutionResult to ClaudeCodeResponse for backwards compatibility
 * with existing post-processing code.
 */
export function agentResultToClaudeResponse(result: AgentExecutionResult): ClaudeCodeResponse {
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
    commitMessage: result.commitMessage || null,
    conversationLog: result.conversationLog,
    tokenUsage: result.tokenUsage
  };
}

export async function executeAgentAndRecordMetrics(executionParams: ExecutionParams, context: JobContext): Promise<ClaudeCodeResponse> {
  const { worktreeInfo, issueRef, githubToken, currentIssueData, issueComments } = executionParams;
  const { taskId, agentAlias, modelName, stateManager, correlatedLogger, correlationId } = context;

  // Get the agent from registry
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

  // Localize remote images in issue body and comments
  const issueBodyHtml = (currentIssueData.data as { body_html?: string }).body_html;
  const localizedBody = currentIssueData.data.body
    ? await localizeContentImages(currentIssueData.data.body, worktreeInfo.worktreePath, correlatedLogger, { bodyHtml: issueBodyHtml, issueOrPrId: issueRef.number })
    : undefined;

  const localizedComments = await Promise.all(
    issueComments.map(async (comment) => ({
      ...comment,
      body: comment.body ? await localizeContentImages(comment.body, worktreeInfo.worktreePath, correlatedLogger, { bodyHtml: comment.body_html, issueOrPrId: issueRef.number }) : comment.body
    }))
  );

  // Build prompt for the agent
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

  // Start periodic file changes updates during agent execution
  const FILE_CHANGES_INTERVAL_MS = 2000;
  const fileChangesInterval = setInterval(async () => {
    try {
      await updateFileChangesFromWorktree(taskId, worktreeInfo.worktreePath);
    } catch (err) {
      correlatedLogger.debug({ error: (err as Error).message }, 'Periodic file changes update failed');
    }
  }, FILE_CHANGES_INTERVAL_MS);

  // Execute task via agent abstraction
  let agentResult;
  try {
    agentResult = await agent.executeTask({
      worktreePath: worktreeInfo.worktreePath,
      issueRef: { number: issueRef.number, repoOwner: issueRef.repoOwner, repoName: issueRef.repoName },
      prompt,
      model: modelName,
      githubToken: githubToken.token,
      branchName: worktreeInfo.branchName,
      onSessionId: createSessionIdCallback(taskId, issueRef, { modelName, stateManager, correlatedLogger, redisClient }),
      onContainerId: createContainerIdCallback(taskId, stateManager, correlatedLogger, worktreeInfo.worktreePath),
      taskId
    });
  } finally {
    clearInterval(fileChangesInterval);
  }

  // Convert to ClaudeCodeResponse for backwards compatibility
  const claudeResult = agentResultToClaudeResponse(agentResult);

  // Check if task was cancelled during execution
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

  // Capture file changes after execution
  try {
    const fileChanges = await updateFileChangesFromWorktree(taskId, worktreeInfo.worktreePath);
    correlatedLogger.debug({ taskId, fileCount: fileChanges.length }, 'Captured file changes after agent execution');
  } catch (fileChangesError) {
    correlatedLogger.warn({ error: (fileChangesError as Error).message }, 'Failed to capture file changes');
  }

  return claudeResult;
}
