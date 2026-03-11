/**
 * GitHub issue job processor - facade module that imports from issueJob/ subdirectory.
 * This maintains backwards compatibility with existing imports.
 */

import { Job } from 'bullmq';
import {
  logger, TaskStates, ensureRepoCloned, getRepoUrl, safeAddLabel, ensureGitRepository,
  UsageLimitError, validateRepositoryInfo, addModelSpecificDelay, withRetry, retryConfigs, updatePlanIssueTaskId
} from '@propr/core';
import type { IssueJobData, JobResult, WorktreeInfo, ClaudeCodeResponse, CommitResult, RepoValidationResult } from '@propr/core';
import { handleDispatch } from './issueJobDispatcher.js';
import { handleUsageLimitError, handleGenericError, updateTaskTitleInStorage, buildFinalResult } from './issueJobHelpers.js';
import type { PostProcessingResult } from './issueJobHelpers.js';
import { performFinalValidation } from './issueJobPostProcessing.js';
import {
  initializeJobContext, getAuthenticatedClient, checkLabelConditions,
  executeWorktreeOperations, markTaskComplete
} from './issueJob/index.js';
import type { GitHubToken, CurrentIssueData } from './issueJob/index.js';

export async function processGitHubIssueJob(job: Job<IssueJobData>): Promise<JobResult> {
  logger.debug({ jobId: job.id, isChildJob: job.data.isChildJob, hasModelName: !!job.data.modelName }, 'Checking if job should be dispatched');

  if (!job.data.isChildJob) {
    logger.info({ jobId: job.id }, 'Running as matrix dispatcher');
    return await handleDispatch(job);
  }

  const context = await initializeJobContext(job);
  const { jobId, issueRef, correlationId, correlatedLogger, stateManager, modelName, taskId, AI_PROCESSING_TAG, AI_DONE_TAG, PR_LABEL } = context;

  await addModelSpecificDelay(modelName);

  try {
    await stateManager.createTaskState(taskId, { number: issueRef.number, repoOwner: issueRef.repoOwner, repoName: issueRef.repoName, modelName } as import('@propr/core').IssueRef, correlationId);
  } catch (stateError) {
    correlatedLogger.warn({ taskId, error: (stateError as Error).message }, 'Failed to create task state, continuing anyway');
  }

  // Update plan issue with task_id for progress tracking
  const repository = `${issueRef.repoOwner}/${issueRef.repoName}`;
  try {
    await updatePlanIssueTaskId(repository, issueRef.number, taskId);
    correlatedLogger.debug({ repository, issueNumber: issueRef.number, taskId }, 'Updated plan issue with task_id');
  } catch (planIssueError) {
    correlatedLogger.debug({ taskId, error: (planIssueError as Error).message }, 'Could not update plan issue task_id (may not be a plan issue)');
  }

  correlatedLogger.info({ jobId, taskId, issueNumber: issueRef.number, repo: `${issueRef.repoOwner}/${issueRef.repoName}` }, 'Processing job started');

  const octokit = await getAuthenticatedClient(context);

  let localRepoPath: string | undefined;
  let worktreeInfo: WorktreeInfo | undefined;
  let claudeResult: ClaudeCodeResponse | null = null;
  let postProcessingResult: PostProcessingResult | null = null;
  let commitResult: CommitResult | null = null;

  try {
    await stateManager.updateTaskState(taskId, TaskStates.PROCESSING, { reason: 'Starting issue processing' });

    const currentIssueData: CurrentIssueData = issueRef.issuePayload ? { data: issueRef.issuePayload as CurrentIssueData['data'] } :
      await withRetry(() => octokit.request('GET /repos/{owner}/{repo}/issues/{issue_number}', {
        owner: issueRef.repoOwner, repo: issueRef.repoName, issue_number: issueRef.number,
        mediaType: { format: 'full' }
      }), { ...retryConfigs.githubApi, correlationId }, `get_issue_${issueRef.number}`) as unknown as CurrentIssueData;

    const currentLabels = currentIssueData.data.labels.map(label => label.name);
    const labelCheck = checkLabelConditions(currentLabels, context);
    if (labelCheck.skip) return { status: 'skipped', reason: labelCheck.reason, issueNumber: issueRef.number };

    if (!currentLabels.includes(AI_PROCESSING_TAG)) {
      await safeAddLabel({ octokit, owner: issueRef.repoOwner, repo: issueRef.repoName, issueNumber: issueRef.number, logger: correlatedLogger }, AI_PROCESSING_TAG);
    }

    const updatedIssueRef: IssueJobData = { ...issueRef, title: `New Issue: ${currentIssueData.data.title}`, subtitle: `Preparing a PR for issue #${issueRef.number}` };
    await updateTaskTitleInStorage(taskId, updatedIssueRef, stateManager, correlatedLogger);
    await job.updateProgress(25);

    const repoValidation: RepoValidationResult = issueRef.repoPayload ? { isValid: true, repoData: issueRef.repoPayload as unknown as RepoValidationResult['repoData'] } : await validateRepositoryInfo({ repoOwner: issueRef.repoOwner, repoName: issueRef.repoName, number: issueRef.number }, octokit, correlationId);
    const githubToken = await octokit.auth({ type: "installation" }) as GitHubToken;
    const repoUrl = getRepoUrl(issueRef);

    try {
      await ensureGitRepository(correlatedLogger);
      localRepoPath = await ensureRepoCloned({ repoUrl, owner: issueRef.repoOwner, repoName: issueRef.repoName, authToken: githubToken.token });
      await job.updateProgress(50);

      const worktreeResult = await executeWorktreeOperations({
        job, context, octokit, currentIssueData, repoValidation, githubToken, repoUrl, localRepoPath
      });
      worktreeInfo = worktreeResult.worktreeInfo;
      claudeResult = worktreeResult.claudeResult;
      postProcessingResult = worktreeResult.postProcessingResult;
      commitResult = worktreeResult.commitResult;

    } finally {
      await performFinalValidation({ claudeResult: claudeResult || undefined, worktreeInfo, issueRef, octokit, postProcessingResult, repoValidation, AI_PROCESSING_TAG, AI_DONE_TAG, localRepoPath: localRepoPath || '', jobId, correlationId, correlatedLogger });
    }

    await job.updateProgress(100);
    await markTaskComplete({ stateManager, taskId, claudeResult, postProcessingResult, commitResult, correlatedLogger });
    return buildFinalResult(issueRef, localRepoPath || '', { worktreeInfo, claudeResult, postProcessingResult, commitResult });

  } catch (error) {
    if (error instanceof UsageLimitError) {
      await handleUsageLimitError(error, job, issueRef, { octokit, correlatedLogger, stateManager, taskId });
      return { status: 'error', error: (error as Error).message };
    } else {
      await handleGenericError(error as Error, job, issueRef, { octokit, claudeResult, worktreeInfo, correlatedLogger, stateManager, taskId, AI_PROCESSING_TAG });
      const isUserCancelled = (error as Error).message?.includes('aborted by user') || (error as Error).name === 'ExecutionAbortedError';
      if (isUserCancelled) {
        return { status: 'cancelled', reason: 'user_request' };
      }
      throw error;
    }
  }
}

export { processGitHubIssueJob as default };
