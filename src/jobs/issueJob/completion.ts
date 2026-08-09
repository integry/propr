/**
 * Task completion functions for GitHub issue job.
 */

import type { Logger } from 'pino';
import {
  db,
  findPlanIssueByRepoAndNumber,
  PlanIssueStatus,
  triggerNextPendingIssue,
  updatePlanIssueStatus,
  resolveAgentTerminationReason,
  ErrorCategories
} from '@propr/core';
import type { CommitResult, ClaudeCodeResponse } from '@propr/core';
import type { PostProcessingResult } from '../issueJobHelpers.js';
import type { TaskCompletionParams } from './types.js';

export function getTaskCompletionStatus(claudeResult: ClaudeCodeResponse | null, postProcessingResult: PostProcessingResult | null): string {
  if (postProcessingResult?.pr && claudeResult && resolveAgentTerminationReason(claudeResult)) {
    return 'partial_with_pr';
  }
  if (!claudeResult?.success) {
    return 'claude_processing_failed';
  }
  return postProcessingResult?.pr ? 'complete_with_pr' : 'claude_success_no_changes';
}

type TerminalStateParams = Pick<
  TaskCompletionParams,
  'stateManager' | 'taskId' | 'claudeResult' | 'postProcessingResult' | 'commitResult'
>;

export async function markTaskTerminalState(params: TerminalStateParams): Promise<void> {
  const { stateManager, taskId, claudeResult, postProcessingResult, commitResult } = params;
  const status = getTaskCompletionStatus(claudeResult, postProcessingResult);
  const commitResultData = commitResult
    ? { commitHash: commitResult.commitHash, commitMessage: commitResult.commitMessage }
    : null;
  const taskResult = {
    status,
    claudeSuccess: claudeResult?.success || false,
    prCreated: !!postProcessingResult?.pr,
    prNumber: postProcessingResult?.pr?.number ?? undefined,
    prUrl: postProcessingResult?.pr?.url ?? undefined,
    commitResult: commitResultData
  };

  if (status === 'claude_processing_failed') {
    await stateManager.markTaskFailed(
      taskId,
      new Error(claudeResult?.error || 'Agent processing failed'),
      {
        errorCategory: ErrorCategories.CLAUDE_EXECUTION,
        prResult: taskResult,
        historyMetadata: {
          pr: (taskResult.prUrl && taskResult.prNumber)
            ? { number: taskResult.prNumber, url: taskResult.prUrl }
            : null,
          commitResult: commitResultData
        }
      }
    );
    return;
  }

  await stateManager.markTaskCompleted(taskId, taskResult);
}

function buildTaskUpdateFields(
  commitResult: CommitResult | null,
  postProcessingResult: PostProcessingResult | null
): { commit_hash?: string; pr_number?: number } {
  const updateFields: { commit_hash?: string; pr_number?: number } = {};
  if (commitResult?.commitHash) {
    updateFields.commit_hash = commitResult.commitHash;
  }
  if (postProcessingResult?.pr?.number) {
    updateFields.pr_number = postProcessingResult.pr.number;
  }
  return updateFields;
}

async function persistTaskUpdateFields(
  taskId: string,
  updateFields: { commit_hash?: string; pr_number?: number },
  correlatedLogger: Logger
): Promise<void> {
  if (Object.keys(updateFields).length === 0) {
    return;
  }
  try {
    await db('tasks')
      .where({ task_id: taskId })
      .update(updateFields);
    correlatedLogger.debug({ taskId, ...updateFields }, 'Saved task completion data to tasks table');
  } catch (dbError) {
    correlatedLogger.warn({ taskId, error: (dbError as Error).message }, 'Failed to save task completion data to database');
  }
}

async function closeFailedPlanIssueAndContinue(taskCompletionParams: TaskCompletionParams): Promise<void> {
  const { issueRef, currentIssueLabels, claudeResult, postProcessingResult, correlatedLogger } = taskCompletionParams;
  if (claudeResult?.success || postProcessingResult?.pr) return;

  const repository = `${issueRef.repoOwner}/${issueRef.repoName}`;
  const planIssue = await findPlanIssueByRepoAndNumber(repository, issueRef.number);
  if (!planIssue?.draft_id) return;

  await updatePlanIssueStatus(repository, issueRef.number, PlanIssueStatus.CLOSED);
  correlatedLogger.warn({
    repository,
    issueNumber: issueRef.number,
    draftId: planIssue.draft_id
  }, 'Marked plan issue closed after terminal task without PR');

  const hasAutoMerge = currentIssueLabels.includes('auto-merge');
  const epicLabel = currentIssueLabels.find((label) => label.startsWith('base-'));
  if (!hasAutoMerge && !epicLabel) return;

  await triggerNextPendingIssue(planIssue.draft_id, repository, epicLabel, correlatedLogger);
}

export async function markTaskComplete(taskCompletionParams: TaskCompletionParams): Promise<void> {
  const { taskId, postProcessingResult, commitResult, correlatedLogger } = taskCompletionParams;
  try {
    await markTaskTerminalState(taskCompletionParams);

    const updateFields = buildTaskUpdateFields(commitResult, postProcessingResult);
    await persistTaskUpdateFields(taskId, updateFields, correlatedLogger);
    await closeFailedPlanIssueAndContinue(taskCompletionParams);
  } catch (stateError) {
    correlatedLogger.warn({ error: (stateError as Error).message }, 'Failed to update terminal task state');
  }
}
