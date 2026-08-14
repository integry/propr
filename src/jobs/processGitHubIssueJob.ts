/**
 * GitHub issue job processor - facade module that imports from issueJob/ subdirectory.
 * This maintains backwards compatibility with existing imports.
 */

import { Job } from 'bullmq';
import {
  logger, TaskStates, ensureRepoCloned, getRepoUrl, safeAddLabel, safeRemoveLabel, ensureGitRepository,
  UsageLimitError, validateRepositoryInfo, addModelSpecificDelay, withRetry, retryConfigs, updatePlanIssueTaskId
} from '@propr/core';
import type { IssueJobData, JobResult, WorktreeInfo, ClaudeCodeResponse, CommitResult, RepoValidationResult, TaskStateData, WorkerStateManager } from '@propr/core';
import { handleDispatch } from './issueJobDispatcher.js';
import { handleUsageLimitError, handleGenericError, updateTaskTitleInStorage, buildFinalResult } from './issueJobHelpers.js';
import type { GenericErrorOptions, PostProcessingResult } from './issueJobHelpers.js';
import { performFinalValidation } from './issueJobPostProcessing.js';
import {
  initializeJobContext, getAuthenticatedClient, checkLabelConditions,
  ensureProcessingLabel, executeWorktreeOperations, markTaskComplete
} from './issueJob/index.js';
import type { GitHubToken, CurrentIssueData } from './issueJob/index.js';
import { finalizeSkippedIssueTask } from './issueTaskFinalizer.js';

function getTerminalIssueJobResult(state: string, issueNumber: number): JobResult | undefined {
  if (state === TaskStates.COMPLETED) {
    return { status: 'complete', reason: 'task_already_completed', issueNumber };
  }
  if (state === TaskStates.CANCELLED) {
    return { status: 'cancelled', reason: 'task_already_cancelled', issueNumber };
  }
  if (state === TaskStates.FAILED) {
    return { status: 'failed', reason: 'task_already_failed', issueNumber };
  }
  return undefined;
}

async function reconcileInitialIssueTaskState(options: {
  stateManager: WorkerStateManager;
  taskId: string;
  createdState: TaskStateData | undefined;
  job: Job<IssueJobData>;
  jobId: string | undefined;
  issueNumber: number;
}): Promise<JobResult | undefined> {
  const { stateManager, taskId, createdState, job, jobId, issueNumber } = options;
  if (!createdState) return undefined;
  const terminalResult = await stateManager.getTerminalJobResultForAutomaticRetry(taskId, createdState, {
    jobId: job.id, attemptsMade: job.attemptsMade, totalAttempts: job.opts.attempts,
  });
  if (terminalResult) return { ...terminalResult, issueNumber };
  if (typeof jobId === 'string') await stateManager.associateTaskWithJob(taskId, jobId);
  return undefined;
}

async function handleIssueJobError(
  error: unknown,
  job: Job<IssueJobData>,
  issueRef: IssueJobData,
  options: GenericErrorOptions,
): Promise<JobResult> {
  if (error instanceof UsageLimitError) {
    await handleUsageLimitError(error, job, issueRef, options);
    return { status: 'requeued', reason: 'rate_limit' };
  }

  const jobError = error as Error;
  await handleGenericError(jobError, job, issueRef, options);
  const isUserCancelled = jobError.message?.includes('aborted by user') || jobError.name === 'ExecutionAbortedError';
  if (isUserCancelled) {
    return { status: 'cancelled', reason: 'user_request' };
  }
  throw error;
}

export async function processGitHubIssueJob(job: Job<IssueJobData>): Promise<JobResult> {
  logger.debug({ jobId: job.id, isChildJob: job.data.isChildJob, hasModelName: !!job.data.modelName }, 'Checking if job should be dispatched');

  if (!job.data.isChildJob) {
    logger.info({ jobId: job.id }, 'Running as matrix dispatcher');
    return await handleDispatch(job);
  }

  const context = await initializeJobContext(job);
  const { jobId, issueRef, correlationId, correlatedLogger, stateManager, modelName, taskId, AI_PROCESSING_TAG, AI_DONE_TAG, AI_WAITING_TAG } = context;

  await addModelSpecificDelay(modelName);

  if (job.data.taskId !== taskId) {
    await job.updateData({ ...job.data, taskId });
  }

  let createdState: TaskStateData | undefined;
  try {
    createdState = await stateManager.createTaskState(taskId, {
      ...issueRef,
      modelName,
      type: 'issue',
      jobId: typeof jobId === 'string' ? jobId : undefined,
    } as import('@propr/core').IssueRef, correlationId);
  } catch (stateError) {
    correlatedLogger.warn({ taskId, error: (stateError as Error).message }, 'Failed to create task state, continuing anyway');
  }
  const terminalResult = await reconcileInitialIssueTaskState({ stateManager, taskId, createdState, job, jobId, issueNumber: issueRef.number });
  if (terminalResult) return terminalResult;

  // Update plan issue with task_id for progress tracking
  const repository = `${issueRef.repoOwner}/${issueRef.repoName}`;
  try {
    await updatePlanIssueTaskId(repository, issueRef.number, taskId);
    correlatedLogger.debug({ repository, issueNumber: issueRef.number, taskId }, 'Updated plan issue with task_id');
  } catch (planIssueError) {
    correlatedLogger.debug({ taskId, error: (planIssueError as Error).message }, 'Could not update plan issue task_id (may not be a plan issue)');
  }

  correlatedLogger.info({ jobId, taskId, issueNumber: issueRef.number, repo: `${issueRef.repoOwner}/${issueRef.repoName}` }, 'Processing job started');

  let octokit: Awaited<ReturnType<typeof getAuthenticatedClient>>;
  try {
    octokit = await getAuthenticatedClient(context);
  } catch (error) {
    try {
      await stateManager.markTaskFailed(taskId, error as Error, { errorCategory: 'github_auth' });
    } catch (stateError) {
      correlatedLogger.error({ taskId, error: (stateError as Error).message }, 'Failed to terminalize task after GitHub authentication failure');
    }
    throw error;
  }

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

  let localRepoPath: string | undefined;
  let worktreeInfo: WorktreeInfo | undefined;
  let claudeResult: ClaudeCodeResponse | null = null;
  let postProcessingResult: PostProcessingResult | null = null;
  let commitResult: CommitResult | null = null;

  try {
    const processingState = await stateManager.updateTaskState(taskId, TaskStates.PROCESSING, {
      reason: 'Starting issue processing',
      isRetry: job.attemptsMade > 0,
    });
    const terminalResult = getTerminalIssueJobResult(processingState.state, issueRef.number);
    if (terminalResult) return terminalResult;

    const currentIssueData: CurrentIssueData = issueRef.issuePayload ? { data: issueRef.issuePayload as CurrentIssueData['data'] } :
      await withRetry(() => octokit.request('GET /repos/{owner}/{repo}/issues/{issue_number}', {
        owner: issueRef.repoOwner, repo: issueRef.repoName, issue_number: issueRef.number,
        mediaType: { format: 'full' }
      }), { ...retryConfigs.githubApi, correlationId }, `get_issue_${issueRef.number}`) as unknown as CurrentIssueData;

    const currentLabels = currentIssueData.data.labels.map(label => label.name);
    const labelCheck = checkLabelConditions(currentLabels, context);
    if (labelCheck.skip) {
      const outcome = await finalizeSkippedIssueTask(taskId, labelCheck.reason, stateManager, processingState);
      correlatedLogger.info({ taskId, reason: labelCheck.reason, outcome }, 'Finalized label-based issue skip');
      return { status: 'skipped', reason: labelCheck.reason, issueNumber: issueRef.number };
    }

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
    return handleIssueJobError(error, job, issueRef, {
      octokit, claudeResult, worktreeInfo, correlatedLogger, stateManager, taskId,
      AI_PROCESSING_TAG, AI_WAITING_TAG
    });
  }
}

export { processGitHubIssueJob as default };
