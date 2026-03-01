/**
 * Worktree operations for GitHub issue job.
 */

import { createWorktreeForIssue, pushBranch, TaskStates, updateFileChangesFromWorktree } from '@propr/core';
import type { ExecuteWorktreeParams, ExecuteWorktreeResult } from './types.js';
import { fetchIssueComments } from './github.js';
import { executeAgentAndRecordMetrics } from './agent.js';
import { performPostProcessing } from '../issueJobPostProcessing.js';

export async function executeWorktreeOperations(params: ExecuteWorktreeParams): Promise<ExecuteWorktreeResult> {
  const { job, context, octokit, currentIssueData, repoValidation, githubToken, repoUrl, localRepoPath } = params;
  const { issueRef, agentAlias, modelName, taskId, correlatedLogger, stateManager, AI_PROCESSING_TAG, AI_DONE_TAG, PR_LABEL } = context;

  const worktreeInfo = await createWorktreeForIssue(localRepoPath, { issueId: issueRef.number, issueTitle: currentIssueData.data.title, owner: issueRef.repoOwner, repoName: issueRef.repoName }, { baseBranch: issueRef.baseBranch || null, octokit, modelName });
  await job.updateProgress(75);

  // Construct the task dashboard URL
  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
  const taskUrl = `${frontendUrl}/tasks/${taskId}`;

  await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
    owner: issueRef.repoOwner, repo: issueRef.repoName, issue_number: issueRef.number,
    body: `🤖 AI processing has started for this issue using **${agentAlias}** agent with **${modelName}** model.\n\nI'll analyze the problem and work on a solution. This may take a few minutes.\n\n**Processing Details:**\n- Agent: \`${agentAlias}\`\n- Model: \`${modelName}\`\n- Branch: \`${worktreeInfo.branchName}\`\n- Base Branch: \`${issueRef.baseBranch || repoValidation.repoData?.defaultBranch || 'main'}\`\n- Worktree: \`${worktreeInfo.worktreePath.split('/').pop()}\`\n\n🔍 [Track Task Execution](${taskUrl})`,
  });

  await pushBranch(worktreeInfo.worktreePath, worktreeInfo.branchName, { repoUrl, authToken: githubToken.token });
  await job.updateProgress(80);

  const issueComments = await fetchIssueComments(octokit, issueRef, correlatedLogger);
  const claudeResult = await executeAgentAndRecordMetrics({ octokit, worktreeInfo, issueRef, githubToken, currentIssueData, issueComments }, context);

  // Check for cancellation after agent execution and before post-processing
  const currentState = await stateManager.getTaskState(taskId);
  if (currentState?.state === TaskStates.CANCELLED) {
    correlatedLogger.info({ taskId }, 'Task was cancelled by user after agent execution, skipping post-processing');
    throw new Error('Execution aborted by user request');
  }

  const postProcessResult = await performPostProcessing({ octokit, issueRef, worktreeInfo, currentIssueData, claudeResult, modelName, repoValidation, repoUrl, githubToken, PR_LABEL, AI_PROCESSING_TAG, AI_DONE_TAG, jobId: context.jobId, correlatedLogger, taskId, stateManager });
  const commitResult = postProcessResult.commitResult;
  const postProcessingResult = postProcessResult.postProcessingResult;

  // Update file changes after post-processing to capture final state
  try {
    await updateFileChangesFromWorktree(taskId, worktreeInfo.worktreePath);
  } catch (fileChangesError) {
    correlatedLogger.warn({ error: (fileChangesError as Error).message }, 'Failed to update file changes after post-processing');
  }

  await job.updateProgress(95);

  return { worktreeInfo, claudeResult, postProcessingResult, commitResult };
}
