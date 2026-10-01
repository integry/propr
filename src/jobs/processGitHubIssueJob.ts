/**
 * GitHub issue job processor - facade module that imports from issueJob/ subdirectory.
 * This maintains backwards compatibility with existing imports.
 */

import { Job } from 'bullmq';
import {
  preventWithdrawnJob, withdrawnIntentReason, updateWithdrawnIssueLabels, db, associateSubmissionTask, findIssueSubmission, logger, TaskStates, ensureRepoCloned, getRepoUrl, safeAddLabel, safeRemoveLabel, ensureGitRepository,
  UsageLimitError, validateRepositoryInfo, addModelSpecificDelay, withRetry, retryConfigs, updatePlanIssueTaskId
} from '@propr/core';
import type { IssueJobData, JobResult, WorktreeInfo, ClaudeCodeResponse, CommitResult, RepoValidationResult } from '@propr/core';
import { handleDispatch } from './issueJobDispatcher.js';
import { handleUsageLimitError, handleGenericError, updateTaskTitleInStorage, buildFinalResult } from './issueJobHelpers.js';
import type { PostProcessingResult } from './issueJobHelpers.js';
import { performFinalValidation } from './issueJobPostProcessing.js';
import {
  initializeJobContext, getAuthenticatedClient, checkLabelConditions,
  ensureProcessingLabel, executeWorktreeOperations, markTaskComplete
} from './issueJob/index.js';
import type { GitHubToken, CurrentIssueData } from './issueJob/index.js';

async function prepareIssueJob(job: Job<IssueJobData>, context: Awaited<ReturnType<typeof initializeJobContext>>): Promise<
  { cancelled: JobResult } | { octokit: Awaited<ReturnType<typeof getAuthenticatedClient>> }
> {
  const { jobId, issueRef, correlationId, correlatedLogger, stateManager, modelName, taskId, AI_PROCESSING_TAG, AI_WAITING_TAG } = context;

  await addModelSpecificDelay(modelName);
  const withdrawnReason = await preventWithdrawnJob(job);
  if (withdrawnReason) return { cancelled: { status: 'cancelled', reason: withdrawnReason } };

  try {
    const initialState = await stateManager.createTaskStateIfAbsent(
      taskId,
      { ...issueRef, number: issueRef.number, repoOwner: issueRef.repoOwner, repoName: issueRef.repoName, modelName } as import('@propr/core').IssueRef,
      correlationId,
      jobId === undefined ? null : String(jobId),
    );
    if (initialState?.state === TaskStates.CANCELLED) return { cancelled: { status: 'cancelled', reason: initialState.terminalReason } };
    if (initialState?.state === TaskStates.FAILED) {
      await stateManager.updateTaskState(taskId, TaskStates.PROCESSING, { isRetry: true, reason: 'Retrying failed issue task' });
    }
  } catch (stateError) {
    correlatedLogger.warn({ taskId, error: (stateError as Error).message }, 'Failed to create task state, continuing anyway');
  }

  const submission = await findIssueSubmission(issueRef);
  if (submission) await associateSubmissionTask(db, submission.id, taskId);

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

  // Handle retry from rate limit - swap AI-waiting back to AI-processing
  if (job.data.isRetryFromRateLimit) {
    correlatedLogger.info({ jobId, issueNumber: issueRef.number }, 'Resuming from rate limit retry - swapping labels');
    try {
      await safeRemoveLabel(
        { octokit, owner: issueRef.repoOwner, repo: issueRef.repoName, issueNumber: issueRef.number, logger: correlatedLogger },
        AI_WAITING_TAG
      );
      await safeAddLabel(
        { octokit, owner: issueRef.repoOwner, repo: issueRef.repoName, issueNumber: issueRef.number, logger: correlatedLogger },
        AI_PROCESSING_TAG
      );
    } catch (labelError) {
      correlatedLogger.warn({ error: (labelError as Error).message }, 'Failed to swap labels on rate limit retry');
    }
  }

  return { octokit };
}

export async function processGitHubIssueJob(job: Job<IssueJobData>): Promise<JobResult> {
  logger.debug({ jobId: job.id, isChildJob: job.data.isChildJob, hasModelName: !!job.data.modelName }, 'Checking if job should be dispatched');

  if (!job.data.isChildJob) {
    logger.info({ jobId: job.id }, 'Running as matrix dispatcher');
    return await handleDispatch(job);
  }

  const context = await initializeJobContext(job);
  const { jobId, issueRef, correlationId, correlatedLogger, stateManager, taskId, AI_PROCESSING_TAG, AI_DONE_TAG, AI_WAITING_TAG } = context;

  const prepared = await prepareIssueJob(job, context);
  if ('cancelled' in prepared) return prepared.cancelled;
  const { octokit } = prepared;

  let localRepoPath: string | undefined;
  let worktreeInfo: WorktreeInfo | undefined;
  let claudeResult: ClaudeCodeResponse | null = null;
  let postProcessingResult: PostProcessingResult | null = null;
  let commitResult: CommitResult | null = null;

  try {
    await stateManager.updateTaskState(taskId, TaskStates.PROCESSING, { reason: 'Starting issue processing' });

    const currentIssueData: CurrentIssueData =
      await withRetry(() => octokit.request('GET /repos/{owner}/{repo}/issues/{issue_number}', {
        owner: issueRef.repoOwner, repo: issueRef.repoName, issue_number: issueRef.number,
        mediaType: { format: 'full' }
      }), { ...retryConfigs.githubApi, correlationId }, `get_issue_${issueRef.number}`) as unknown as CurrentIssueData;

    const target = { ...issueRef, kind: 'issue' as const, triggeringLabel: context.AI_PRIMARY_TAG };
    const reason = withdrawnIntentReason(target, currentIssueData.data, [context.AI_PRIMARY_TAG]);
    if (reason) {
      await stateManager.markTaskCancelled(taskId, 'system', { reason, terminalReason: reason });
      await updateWithdrawnIssueLabels(target, [context.AI_PRIMARY_TAG]);
      return { status: 'cancelled', reason };
    }
    const latest = await stateManager.getTaskState(taskId);
    if (latest?.state === TaskStates.CANCELLED) return { status: 'cancelled', reason: latest.terminalReason };
    const currentLabels = currentIssueData.data.labels.map(label => label.name);
    const labelCheck = checkLabelConditions(currentLabels, context);
    if (labelCheck.skip) return { status: 'skipped', reason: labelCheck.reason, issueNumber: issueRef.number };

    await ensureProcessingLabel(currentLabels, context, octokit);

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
      await performFinalValidation({ claudeResult: claudeResult || undefined, worktreeInfo, issueRef, octokit, postProcessingResult, commitResult, repoValidation, AI_PROCESSING_TAG, AI_DONE_TAG, localRepoPath: localRepoPath || '', jobId, correlationId, correlatedLogger });
    }

    await job.updateProgress(100);
    await markTaskComplete({
      stateManager,
      taskId,
      issueRef,
      currentIssueLabels: currentLabels,
      claudeResult,
      postProcessingResult,
      commitResult,
      correlatedLogger
    });
    return buildFinalResult(issueRef, localRepoPath || '', { worktreeInfo, claudeResult, postProcessingResult, commitResult });

  } catch (error) {
    const latest = await stateManager.getTaskState(taskId);
    if (latest?.state === TaskStates.CANCELLED) {
      await updateWithdrawnIssueLabels({ ...issueRef, kind: 'issue' }, [context.AI_PRIMARY_TAG]);
      return { status: 'cancelled', reason: latest.terminalReason };
    }
    if (error instanceof UsageLimitError) {
      await handleUsageLimitError(error, job, issueRef, {
        octokit, correlatedLogger, stateManager, taskId,
        AI_PROCESSING_TAG, AI_WAITING_TAG
      });
      const afterRetry = await stateManager.getTaskState(taskId);
      if (afterRetry?.state === TaskStates.CANCELLED) return { status: 'cancelled', reason: afterRetry.terminalReason };
      return { status: 'requeued', reason: 'rate_limit' };
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
