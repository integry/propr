import { formatTaskTerminalReason } from '@propr/shared';
/**
 * GitHub issue job processor - facade module that imports from issueJob/ subdirectory.
 * This maintains backwards compatibility with existing imports.
 */

import { Job } from 'bullmq';
import { postCancellationNotice } from './errorHandlers.js';
import {
  isBookkeepingCancellation, taskIntentIssueRef, isIssueClosureProtected, withdrawnIntentReason, updateWithdrawnIssueLabels, excludeWithdrawnIssue, retainClosureCleanup, releaseWithdrawalCleanup, db, associateSubmissionTask, findIssueSubmission, logger, TaskStates, ensureRepoCloned, getRepoUrl, safeAddLabel, safeRemoveLabel, ensureGitRepository,
  UsageLimitError, validateRepositoryInfo, addModelSpecificDelay, withRetry, retryConfigs, updatePlanIssueTaskId, readIssueCostCapOverride
} from '@propr/core';
import type { TaskStateData, IssueJobData, JobResult, WorktreeInfo, ClaudeCodeResponse, CommitResult, RepoValidationResult, SubmissionPayload } from '@propr/core';
import { withRunCostCap, type CommentOctokit, type RunCostCapTarget } from './runCostCap.js';
import { handleDispatch } from './issueJobDispatcher.js';
import { handleUsageLimitError, handleGenericError, updateTaskTitleInStorage, buildFinalResult } from './issueJobHelpers.js';
import type { PostProcessingResult } from './issueJobHelpers.js';
import { performFinalValidation } from './issueJobPostProcessing.js';
import {
  initializeJobContext, getAuthenticatedClient, checkLabelConditions,
  ensureProcessingLabel, executeWorktreeOperations, markTaskComplete
} from './issueJob/index.js';
import type { GitHubToken, CurrentIssueData, JobContext } from './issueJob/index.js';

import {
  prepareRepositoryWorkflow, resolveRepositoryWorkflow, persistRepositoryWorkflowDeferral, repositoryWorkflowHistoryMetadata, CLEARED_REPOSITORY_WORKFLOW_DEFERRAL,
  withRepositoryWorkflowAdmission, reconcileRepositoryWorkflowAdmission, deferRepositoryWorkflowJob, RepositoryWorkflowCapacityError, isUserCancellationError, nonRetryableRepositoryWorkflowError,
} from './repositoryWorkflow.js';
import { redisClient } from './issueJob/config.js';

function isStoppedTask(task: TaskStateData | null): task is TaskStateData & { state: 'cancelled' } {
  return !!task && task.state === TaskStates.CANCELLED && !isBookkeepingCancellation(task);
}

async function prepareIssueJob(job: Job<IssueJobData>, context: Awaited<ReturnType<typeof initializeJobContext>>): Promise<
  { cancelled: JobResult } | { octokit: Awaited<ReturnType<typeof getAuthenticatedClient>> }
> {
  const { jobId, issueRef, correlationId, correlatedLogger, stateManager, agentAlias, modelName, taskId } = context;

  // Keep the task identity stable when this same BullMQ job is delayed for capacity.
  if (!job.data.correlationId || !job.data.agentAlias || !job.data.modelName) {
    await job.updateData({ ...job.data, correlationId, agentAlias, modelName });
  }
  await addModelSpecificDelay(modelName);

  try {
    const initialState = await stateManager.createTaskStateIfAbsent(
      taskId,
      taskIntentIssueRef({ ...issueRef, modelName }, { ...issueRef, kind: 'issue' }),
      correlationId,
      jobId === undefined ? null : String(jobId),
    );
    if (isStoppedTask(initialState)) return { cancelled: { status: 'cancelled', reason: initialState.terminalReason } };
    if (initialState && (initialState.state === TaskStates.FAILED || isBookkeepingCancellation(initialState))) {
      await stateManager.updateTaskState(taskId, TaskStates.PROCESSING, { isRetry: true, reason: 'Resuming issue task' });
    }
  } catch (stateError) {
    correlatedLogger.warn({ taskId, error: (stateError as Error).message }, 'Failed to create task state, continuing anyway');
  }

  if (job.data.isRetryFromRateLimit && jobId !== undefined) {
    // The original queue job has completed with a handoff result. Reconciliation
    // must now observe the retry job while preserving the task's parent link.
    await db('tasks').where({ task_id: taskId }).update({ job_id: String(jobId) });
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
  return { octokit };
}

async function checkIssueCancellation(
  context: Awaited<ReturnType<typeof initializeJobContext>>,
  currentIssueData: CurrentIssueData,
): Promise<JobResult | null> {
  const { issueRef, stateManager, taskId, AI_PRIMARY_TAG } = context;
  const target = { ...issueRef, kind: 'issue' as const, triggeringLabel: AI_PRIMARY_TAG };
  const reason = withdrawnIntentReason(target, currentIssueData.data, [AI_PRIMARY_TAG]);
  if (reason) {
    if (reason === 'cancelled_issue_closed' && await isIssueClosureProtected(target, await stateManager.getTaskState(taskId))) return null;
    // Retained before recording: once cancelled, this request leaves the
    // reconciliation scans, and only the obligation keeps a reopen idle.
    const cleanup = await retainClosureCleanup(target, reason);
    const cancelled = await stateManager.markTaskCancelled(taskId, 'system', { reason: formatTaskTerminalReason(reason), terminalReason: reason });
    if (cancelled && cancelled.state !== TaskStates.CANCELLED) {
      await releaseWithdrawalCleanup(cleanup);
      return null;
    }
    await excludeWithdrawnIssue(target, reason, undefined, cleanup);
    return { status: 'cancelled', reason };
  }
  const latest = await stateManager.getTaskState(taskId);
  if (isStoppedTask(latest)) return { status: 'cancelled', reason: latest.terminalReason };
  return null;
}

async function cleanupUserStoppedIssue(
  context: Awaited<ReturnType<typeof initializeJobContext>>,
  reason?: unknown,
): Promise<void> {
  const { stateManager, taskId, issueRef, AI_PRIMARY_TAG, correlatedLogger } = context;
  try {
    const terminalReason = reason ?? (await stateManager.getTaskState(taskId))?.terminalReason;
    if (terminalReason !== 'cancelled_by_user') return;
    await updateWithdrawnIssueLabels(
      { ...issueRef, kind: 'issue', triggeringLabel: AI_PRIMARY_TAG },
      [AI_PRIMARY_TAG], terminalReason, taskId,
    );
  } catch (error) {
    correlatedLogger.warn({ taskId, error }, 'Failed to clean up user-stopped issue processing label');
  }
}

function prepareIssueRepositoryWorkflow(octokit: Awaited<ReturnType<typeof getAuthenticatedClient>>, issueRef: IssueJobData) {
  return prepareRepositoryWorkflow({
    octokit, repoOwner: issueRef.repoOwner, repoName: issueRef.repoName, baseBranch: issueRef.baseBranch, correlationId: issueRef.correlationId,
    defaultBranch: typeof issueRef.repoPayload?.defaultBranch === 'string' ? issueRef.repoPayload.defaultBranch : undefined,
  });
}

export function processGitHubIssueJob(job: Job<IssueJobData>): Promise<JobResult> {
  return deferRepositoryWorkflowJob(job, () => processAdmittedIssueJob(job));
}

async function processAdmittedIssueJob(job: Job<IssueJobData>): Promise<JobResult> {
  logger.debug({ jobId: job.id, isChildJob: job.data.isChildJob, hasModelName: !!job.data.modelName }, 'Checking if job should be dispatched');

  if (!job.data.isChildJob) {
    logger.info({ jobId: job.id }, 'Running as matrix dispatcher');
    return await handleDispatch(job);
  }

  const context = await initializeJobContext(job);
  const { issueRef, correlatedLogger, stateManager, taskId, AI_PROCESSING_TAG } = context;

  const prepared = await prepareIssueJob(job, context);
  if ('cancelled' in prepared) {
    await cleanupUserStoppedIssue(context, prepared.cancelled.reason);
    return prepared.cancelled;
  }
  const { octokit } = prepared;

  let policyReadThisAttempt = false;
  try {
    context.repositoryWorkflow = await resolveRepositoryWorkflow(job.data, issueRef.baseBranch, () => {
      policyReadThisAttempt = true;
      return prepareIssueRepositoryWorkflow(octokit, issueRef);
    });
  } catch (error) {
    await handleGenericError(error as Error, job, issueRef, {
      octokit, claudeResult: null, worktreeInfo: undefined, correlatedLogger, stateManager, taskId, AI_PROCESSING_TAG,
    });
    throw nonRetryableRepositoryWorkflowError(error);
  }
  try {
    return await processIssueWithAdmission(job, context, octokit, !policyReadThisAttempt);
  } catch (error) {
    if (error instanceof RepositoryWorkflowCapacityError) {
      await persistRepositoryWorkflowDeferral({
        job, workflow: context.repositoryWorkflow, baseBranch: issueRef.baseBranch, extraData: { repositoryWorkflowDeferred: true },
        stateManager, taskId, correlatedLogger,
        onPersistFailure: persistError => handleGenericError(persistError, job, issueRef, {
          octokit, claudeResult: null, worktreeInfo: undefined, correlatedLogger, stateManager, taskId, AI_PROCESSING_TAG,
        }),
      });
    }
    throw error;
  } finally {
    await cleanupUserStoppedIssue(context);
  }
}

async function handleIssueProcessingError(error: unknown, progress: {
  job: Job<IssueJobData>; context: JobContext; octokit: Awaited<ReturnType<typeof getAuthenticatedClient>>;
  claudeResult: ClaudeCodeResponse | null; worktreeInfo?: WorktreeInfo;
}): Promise<JobResult> {
  const { job, context, octokit, claudeResult, worktreeInfo } = progress;
  const { issueRef, correlatedLogger, stateManager, taskId, AI_PROCESSING_TAG, AI_WAITING_TAG } = context;
  const latest = await stateManager.getTaskState(taskId);
  if (isStoppedTask(latest)) {
    if (latest.terminalReason === 'cancelled_by_user') {
      await postCancellationNotice(issueRef, { octokit, claudeResult, worktreeInfo, correlatedLogger, stateManager, taskId, AI_PROCESSING_TAG });
    }
    if (['cancelled_issue_closed', 'cancelled_label_removed'].some(reason => reason === latest.terminalReason)) {
      // Another cleanup failure keeps a closure obligation for reconciliation.
      await excludeWithdrawnIssue({ ...issueRef, kind: 'issue', triggeringLabel: context.AI_PRIMARY_TAG }, latest.terminalReason);
    }
    return { status: 'cancelled', reason: latest.terminalReason };
  }
  if (error instanceof UsageLimitError) {
    await handleUsageLimitError(error, job, issueRef, {
      octokit, correlatedLogger, stateManager, taskId,
      AI_PROCESSING_TAG, AI_WAITING_TAG
    });
    const afterRetry = await stateManager.getTaskState(taskId);
    if (isStoppedTask(afterRetry)) return { status: 'cancelled', reason: afterRetry.terminalReason };
    return { status: 'requeued', reason: 'rate_limit' };
  } else {
    await handleGenericError(error as Error, job, issueRef, { octokit, claudeResult, worktreeInfo, correlatedLogger, stateManager, taskId, AI_PROCESSING_TAG });
    const isUserCancelled = isUserCancellationError(error);
    if (isUserCancelled) {
      return { status: 'cancelled', reason: 'user_request' };
    }
    throw nonRetryableRepositoryWorkflowError(error);
  }
}

async function processIssueWithAdmission(
  job: Job<IssueJobData>, context: JobContext, octokit: Awaited<ReturnType<typeof getAuthenticatedClient>>,
  /** The policy is a snapshot from an earlier attempt, not read from the base branch by this one. */
  reusedWorkflowSnapshot: boolean,
): Promise<JobResult> {
  const { jobId, issueRef, correlationId, correlatedLogger, stateManager, taskId, AI_PROCESSING_TAG, AI_DONE_TAG, AI_WAITING_TAG } = context;
  // A withdrawn or skipped issue ends before admission, so it never holds
  // repository capacity; deferred attempts repeat these checks on re-entry.
  let currentIssueData: CurrentIssueData;
  let currentLabels: string[];
  try {
    currentIssueData = await withRetry(() => octokit.request('GET /repos/{owner}/{repo}/issues/{issue_number}', {
      owner: issueRef.repoOwner, repo: issueRef.repoName, issue_number: issueRef.number,
      mediaType: { format: 'full' }
    }), { ...retryConfigs.githubApi, correlationId }, `get_issue_${issueRef.number}`) as unknown as CurrentIssueData;

    const cancellation = await checkIssueCancellation(context, currentIssueData);
    if (cancellation) return cancellation;
    currentLabels = currentIssueData.data.labels.map(label => label.name);
    const labelCheck = checkLabelConditions(currentLabels, context);
    if (labelCheck.skip) return { status: 'skipped', reason: labelCheck.reason, issueNumber: issueRef.number };
  } catch (error) {
    return handleIssueProcessingError(error, { job, context, octokit, claudeResult: null });
  }
  return withRepositoryWorkflowAdmission({
    workflow: context.repositoryWorkflow, repoOwner: issueRef.repoOwner, repoName: issueRef.repoName,
    redisClient, taskId, stateManager, correlatedLogger, job,
  }, async (): Promise<JobResult> => withRunCostCap(await issueRunCostCapTarget(job, context, octokit), async (costGuard): Promise<JobResult> => {
    // Successful admission ends this capacity wait; subsequent execution failures
    // retain the existing ordinary retry behavior and reload the base policy.
    const refreshWorkflow = !!job.data.repositoryWorkflowDeferred && reusedWorkflowSnapshot;
    if (job.data.repositoryWorkflowDeferred) {
      await job.updateData({ ...job.data, repositoryWorkflowDeferred: false, ...CLEARED_REPOSITORY_WORKFLOW_DEFERRAL });
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
        currentLabels = [...currentLabels.filter(label => label !== AI_WAITING_TAG), AI_PROCESSING_TAG];
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
      // The snapshot that requested admission can be many deferrals old. Run hooks,
      // instructions and validation from the base head the worktree now starts from.
      if (refreshWorkflow) {
        context.repositoryWorkflow = await prepareIssueRepositoryWorkflow(octokit, issueRef);
        // A refusal here defers with the refreshed policy saved in context.repositoryWorkflow.
        await reconcileRepositoryWorkflowAdmission(context.repositoryWorkflow);
        await costGuard.setWorkflowCap(context.repositoryWorkflow?.config.limits?.max_cost_usd);
      }
      await stateManager.updateTaskState(taskId, TaskStates.PROCESSING, {
        reason: 'Starting issue processing', historyMetadata: repositoryWorkflowHistoryMetadata(context.repositoryWorkflow),
      });

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
      if (error instanceof RepositoryWorkflowCapacityError) throw error;
      return handleIssueProcessingError(error, { job, context, octokit, claudeResult, worktreeInfo });
    }
  }));
}

/** The issue run's spend cap inputs: the task override (job, submission or `propr issue implement --max-cost`) and the workflow file. */
async function issueRunCostCapTarget(
  job: Job<IssueJobData>, context: JobContext, octokit: Awaited<ReturnType<typeof getAuthenticatedClient>>,
): Promise<RunCostCapTarget> {
  const { issueRef, taskId, modelName, correlatedLogger } = context;
  let override: unknown = job.data.maxCostUsd;
  try {
    if (override === undefined) {
      const submission = await findIssueSubmission(issueRef);
      override = submission ? (JSON.parse(submission.payload) as SubmissionPayload).maxCostUsd : undefined;
    }
    override ??= await readIssueCostCapOverride(`${issueRef.repoOwner}/${issueRef.repoName}`, issueRef.number);
  } catch (error) {
    correlatedLogger.warn({ taskId, error: (error as Error).message }, 'Could not read the task spend cap override');
  }
  return {
    taskId, repoOwner: issueRef.repoOwner, repoName: issueRef.repoName, number: issueRef.number, kind: 'issue',
    modelName, override, workflowCap: context.repositoryWorkflow?.config.limits?.max_cost_usd,
    getOctokit: () => octokit as unknown as CommentOctokit, logger: correlatedLogger,
  };
}

export { processGitHubIssueJob as default };
