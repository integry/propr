import type { Logger } from 'pino';
import { setTimeout } from 'timers/promises';
import type { ClaudeCodeResponse, WorktreeInfo, CommitResult, WorkerStateManager, VisualPreviewSettings, ReviewConfig } from '@propr/core';
import {
    cleanupWorktree, cleanupPreparedVisualPreviewEvidence, commitChanges,
    prepareVisualPreviewEvidence, TaskStates,
    describeAgentTermination,
    resolveAgentTerminationReason,
    sanitizeAgentReport,
} from '@propr/core';
import { getAuthenticatedOctokit, linkPRToPlanIssue } from '@propr/core';
import { safeUpdateLabels } from '@propr/core';
import { generateCompletionComment } from '@propr/core';
import { redactSecrets } from '@propr/core';
import { agentFailureLine, isUnfinishedRun, UNFINISHED_RUN_HEADLINE } from '@propr/shared';
import { validatePRCreation } from '@propr/core';
import type { RepoValidationResult, PRValidationResult } from '@propr/core';
import type { IssueJobData } from '@propr/core';
import { createPullRequest, ensureEpicBaseBranchExists, type PostProcessingResult } from './issueJobHelpers.js';
import { addPullRequestProcessingLabels, issuePullRequestLabels } from './pullRequestProcessingLabels.js';
import { handleCreatedPlanIssuePR, handleNoCodeChanges } from './issueJobPostProcessingHelpers.js';
import { AI_COMMIT_AUTHOR } from './commitAuthor.js';
import { buildAgentCommitMessage, pendingChangePaths } from './agentCommitMessage.js';
import { pushImplementationBranch, type GitHubToken } from './issueJobPush.js';
import { prepareProviderReplacement } from './providerReplacement.js';
import { autoAssignCompletedPullRequest, type CompletedPullRequestAssignmentContext } from './issueJobAutoAssignment.js';
import { retryPRCreationViaAPI } from './issueJobPRRetry.js';
import { completeIssueLabelsBestEffort } from './issueJobCompletionLabels.js';
import { taskPageUrl } from './taskPageUrl.js';
import { describeFailureCause } from './failureCause.js';
import type { PostProcessingStep } from './postProcessingStep.js';
import { formatErrorBlock, getErrorMessage, handlePostProcessingFailure } from './issueJobPostProcessingFailure.js';

type RepoValidation = RepoValidationResult;
type PRValidation = PRValidationResult;

const EXECUTION_ABORTED_MESSAGE = 'Execution aborted by user request';

function formatFailureCause(message: string): string {
    const cause = describeFailureCause(message);
    return cause ? `${cause}\n\n` : '';
}

function buildImplementationCompletionNote(claudeResult: ClaudeCodeResponse): string {
    const terminationReason = resolveAgentTerminationReason(claudeResult);
    if (terminationReason) return `Partial implementation: ${describeAgentTermination(terminationReason)}`;
    if (claudeResult.success && isUnfinishedRun(claudeResult)) return UNFINISHED_RUN_HEADLINE;
    return claudeResult.success
        ? 'Implementation completed successfully.'
        : 'Implementation attempted - see PR comments for details.';
}

function resolveAgentCommitBody(candidate: string | null | undefined, fallback: string): string { return (candidate && sanitizeAgentReport(candidate)) || fallback; }

function hasPublishableAgentWork(claudeResult: ClaudeCodeResponse | null): boolean {
    if (!claudeResult) return false;
    return claudeResult.success || resolveAgentTerminationReason(claudeResult) !== undefined;
}

async function handleUnpublishableAgentFailure(options: {
    octokit: Octokit;
    issueRef: IssueJobData;
    claudeResult: ClaudeCodeResponse;
    AI_PROCESSING_TAG: string;
    correlatedLogger: Logger; taskId?: string;
}): Promise<PostProcessingResult> {
    const { octokit, issueRef, claudeResult, AI_PROCESSING_TAG, correlatedLogger, taskId } = options;
    const errorMessage = (claudeResult.error && agentFailureLine(claudeResult.error)) || 'The coding agent stopped before producing publishable work.';

    correlatedLogger.warn({ issueNumber: issueRef.number, error: redactSecrets(errorMessage) }, 'Agent execution failed without publishable work');
    const labelUpdate = await safeUpdateLabels(
        { octokit, owner: issueRef.repoOwner, repo: issueRef.repoName, issueNumber: issueRef.number, logger: correlatedLogger },
        [AI_PROCESSING_TAG],
        [],
    );
    if (!labelUpdate.success) {
        const details = labelUpdate.errors.length > 0 ? `: ${labelUpdate.errors.join('; ')}` : '';
        throw new Error(`Failed to remove the processing label from issue #${issueRef.number}${details}`);
    }

    const completionComment = await generateCompletionComment(claudeResult, {
        number: issueRef.number,
        repoOwner: issueRef.repoOwner,
        repoName: issueRef.repoName,
    }, { publishedAs: 'issue_comment', ...(taskId ? { taskUrl: taskPageUrl(taskId) } : {}) });
    const replacementSection = await prepareProviderReplacement({ taskId, error: claudeResult.error ?? errorMessage, fromAgentExecution: true, terminationReason: resolveAgentTerminationReason(claudeResult) ?? null, correlatedLogger });
    await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
        owner: issueRef.repoOwner,
        repo: issueRef.repoName,
        issue_number: issueRef.number,
        body: `❌ **AI processing failed before producing publishable work.**\n\n${formatFailureCause(errorMessage)}${formatErrorBlock('System Error', errorMessage)}${completionComment}${replacementSection}`,
    });

    return { success: false, pr: null, updatedLabels: [], error: errorMessage };
}

/**
 * Outcomes that publish nothing, settled before any commit: no publishable
 * agent work, or a reported blocker (`on_blocker: report`). Null when the run
 * goes on to commit.
 */
async function settleUnpublishedOutcome(options: PostProcessOptions): Promise<PostProcessingResult | null> {
    const { octokit, issueRef, claudeResult, AI_PROCESSING_TAG, correlatedLogger, taskId } = options;
    if (!hasPublishableAgentWork(claudeResult)) {
        return handleUnpublishableAgentFailure({ octokit, issueRef, claudeResult, AI_PROCESSING_TAG, correlatedLogger, taskId });
    }
    if (!options.reportsBlockers) return null;
    return (await import('./issueJobBlocked.js')).settleReportedIssueBlocker(options);
}

type Octokit = {
    request: <T = unknown>(endpoint: string, options: Record<string, unknown>) => Promise<T>;
};

export interface PostProcessOptions {
    octokit: Octokit & Pick<Awaited<ReturnType<typeof getAuthenticatedOctokit>>, 'auth'>;
    issueRef: IssueJobData;
    worktreeInfo: WorktreeInfo;
    currentIssueData: { data: { title: string; body?: string | null; labels: Array<{ name: string }>; user?: { login?: string } | null } };
    claudeResult: ClaudeCodeResponse;
    modelName: string;
    repoValidation: RepoValidation;
    repoUrl: string;
    githubToken: GitHubToken;
    PR_LABEL: string;
    AI_PROCESSING_TAG: string;
    AI_DONE_TAG: string;
    jobId: string | undefined;
    correlatedLogger: Logger;
    taskId?: string;
    stateManager?: WorkerStateManager;
    visualPreviewSettings: VisualPreviewSettings; // Already restricted by the run's workflow snapshot.
    /** `on_blocker: report` in the run's workflow snapshot: a reported blocker ends the run without publishing. */
    reportsBlockers?: boolean;
    /** The task's starting commit, for the review digest. */
    diffBase?: string;
    /** `review` from the run's workflow snapshot. */
    review?: ReviewConfig;
}

export interface PostProcessResult {
    commitResult: CommitResult | null;
    postProcessingResult: PostProcessingResult | null;
}

async function handleMissingCommit(options: PostProcessOptions): Promise<PostProcessingResult> {
    const { octokit, issueRef, claudeResult, currentIssueData, AI_PROCESSING_TAG, AI_DONE_TAG, correlatedLogger } = options;
    if (claudeResult.success) {
        return handleNoCodeChanges({
            octokit,
            issueRef,
            claudeResult,
            currentIssueData,
            AI_PROCESSING_TAG,
            AI_DONE_TAG,
            correlatedLogger,
        });
    }

    return handleUnpublishableAgentFailure({
        octokit, issueRef, claudeResult, AI_PROCESSING_TAG,
        correlatedLogger, taskId: options.taskId,
    });
}

/** Opens the pull request for committed and pushed work; throws when none was opened. */
async function openPullRequest(
    options: PostProcessOptions,
    commitResult: CommitResult,
    evidence: Awaited<ReturnType<typeof prepareVisualPreviewEvidence>>['evidence'],
): Promise<PostProcessingResult & { pr: NonNullable<PostProcessingResult['pr']> }> {
    const { octokit, issueRef, worktreeInfo, currentIssueData, claudeResult, modelName, repoValidation, PR_LABEL, correlatedLogger, taskId, stateManager } = options;
    // Check for cancellation before creating PR
    if (taskId && stateManager) {
        const currentState = await stateManager.getTaskState(taskId);
        if (currentState?.state === TaskStates.CANCELLED) {
            correlatedLogger.info({ taskId }, 'Task was cancelled by user, skipping PR creation');
            throw new Error(EXECUTION_ABORTED_MESSAGE);
        }
    }

    // Self-heal a deleted epic base branch (e.g. after its Epic PR was
    // closed) so the child PR isn't rejected with base "invalid" on rerun.
    if (issueRef.baseBranch) {
        await ensureEpicBaseBranchExists(octokit, {
            owner: issueRef.repoOwner,
            repo: issueRef.repoName,
            baseBranch: issueRef.baseBranch,
            defaultBranch: repoValidation.repoData?.defaultBranch,
            correlatedLogger
        });
    }

    const result = await createPullRequest(
        octokit, issueRef, worktreeInfo,
        {
            commitResult,
            claudeResult,
            modelName,
            repoValidation,
            PR_LABEL,
            correlatedLogger,
            issueTitle: currentIssueData.data.title,
            visualPreview: { evidence, worktreePath: worktreeInfo.worktreePath },
            taskId,
            stateManager,
            diffBase: options.diffBase,
            review: options.review,
            issueBody: currentIssueData.data.body,
        }
    );
    // Committed and pushed work without a pull request must never reach the success path.
    if (!result.pr) throw new Error(result.error || 'GitHub did not return the created pull request');
    return result as PostProcessingResult & { pr: NonNullable<PostProcessingResult['pr']> };
}

export async function performPostProcessing(options: PostProcessOptions): Promise<PostProcessResult> {
    const { octokit, issueRef, worktreeInfo, currentIssueData, claudeResult, modelName, AI_PROCESSING_TAG, AI_DONE_TAG, correlatedLogger, taskId, visualPreviewSettings } = options;
    let commitResult: CommitResult | null = null;
    let postProcessingResult: PostProcessingResult | null = null;
    let preparedVisualPreview: Awaited<ReturnType<typeof prepareVisualPreviewEvidence>> | undefined;
    let step: PostProcessingStep | undefined;

    try {
        postProcessingResult = await settleUnpublishedOutcome(options);
        if (postProcessingResult) return { commitResult, postProcessingResult };

        const completionNote = buildImplementationCompletionNote(claudeResult);
        // The subject says what changed (its own small call, else the issue title); the run summary is the body.
        const commitMessage = buildAgentCommitMessage({
            generatedSubject: claudeResult?.commitSubject,
            title: currentIssueData.data.title,
            fallbackSubject: `resolve issue #${issueRef.number}`,
            paths: await pendingChangePaths(worktreeInfo.worktreePath),
            body: resolveAgentCommitBody(claudeResult?.commitMessage, `Implemented by ProPR AI using ${modelName} model.\n\n${completionNote}`),
            agentAlias: claudeResult?.agentAlias ?? issueRef.agentAlias,
            model: claudeResult?.model || modelName,
        });

        step = 'commit';
        preparedVisualPreview = await prepareVisualPreviewEvidence({
            worktreePath: worktreeInfo.worktreePath,
            settings: visualPreviewSettings,
            taskId: taskId || `${issueRef.repoOwner}-${issueRef.repoName}-${issueRef.number}`
        });

        commitResult = await commitChanges(
            worktreeInfo.worktreePath, commitMessage,
            AI_COMMIT_AUTHOR,
            { issueNumber: issueRef.number, issueTitle: currentIssueData.data.title }
        );

        claudeResult.modifiedFiles = commitResult?.filesChanged || claudeResult.modifiedFiles;

        // Successful no-change runs are complete; interrupted no-change runs have
        // no partial implementation to publish and must remain retryable.
        if (commitResult === null) {
            step = undefined;
            postProcessingResult = await handleMissingCommit(options);
            return { commitResult, postProcessingResult };
        }

        step = 'push';
        await pushImplementationBranch(options);
        step = 'pull_request';

        correlatedLogger.debug('Waiting for branch propagation...');
        await setTimeout(3000);

        const openedPullRequest = await openPullRequest(options, commitResult, preparedVisualPreview.evidence);
        postProcessingResult = openedPullRequest;
        step = undefined;

        // Update plan issue status to 'under_review' now the PR exists
        await handleCreatedPlanIssuePR({ issueRef, currentIssueData, prNumber: openedPullRequest.pr.number, correlatedLogger, taskId });

        // The pull request exists: a label failure is logged, never fatal to its follow-up steps.
        await completeIssueLabelsBestEffort({ octokit, issueRef, AI_PROCESSING_TAG, AI_DONE_TAG, correlatedLogger });

        await autoAssignCompletedPullRequest(options, openedPullRequest);

    } catch (postProcessingError) {
        // A user cancellation is not a failed step; the task is already cancelled.
        const failedStep = getErrorMessage(postProcessingError) === EXECUTION_ABORTED_MESSAGE ? undefined : step;
        postProcessingResult = await handlePostProcessingFailure(options, postProcessingError, { step: failedStep, commitResult });
    } finally {
        try {
            await cleanupPreparedVisualPreviewEvidence(preparedVisualPreview);
        } catch (cleanupError) {
            correlatedLogger.warn({ error: getErrorMessage(cleanupError) }, 'Could not clean up staged visual previews');
        }
    }

    return { commitResult, postProcessingResult };
}

export interface PRValidationOptions {
    claudeResult: ClaudeCodeResponse | null;
    worktreeInfo: WorktreeInfo | undefined;
    issueRef: IssueJobData;
    octokit: Octokit;
    postProcessingResult: PostProcessingResult | null;
    commitResult: CommitResult | null;
    repoValidation: RepoValidation;
    AI_PROCESSING_TAG: string;
    AI_DONE_TAG: string;
    correlationId: string;
    correlatedLogger: Logger;
    jobId: string | undefined;
    /** For auto-assigning a pull request this validation finds or recreates. */
    taskId?: string;
    stateManager?: WorkerStateManager;
    currentIssueData?: CompletedPullRequestAssignmentContext['currentIssueData'];
    /** The processing label normal creation adds; a recovered pull request gets it too. */
    PR_LABEL?: string;
    modelName?: string;
}

/** The labels normal creation adds, so follow-ups on a recovered pull request are accepted. */
async function recoveredPullRequestLabels(options: Pick<PRValidationOptions, 'issueRef' | 'PR_LABEL' | 'modelName'>): Promise<string[]> {
    // Labelling must never stop the pull request itself from being recovered.
    return issuePullRequestLabels(options.issueRef, options.PR_LABEL, options.modelName).catch(() => options.PR_LABEL ? [options.PR_LABEL] : []);
}

/** Recreates the missing pull request; the recreated one, not the earlier failure, is the run's outcome. */
async function recreatePullRequest(
    options: PRValidationOptions,
    worktreeInfo: WorktreeInfo,
    assignmentContext: CompletedPullRequestAssignmentContext,
): Promise<PostProcessingResult | null> {
    const { issueRef, octokit, repoValidation, AI_PROCESSING_TAG, AI_DONE_TAG, correlatedLogger, postProcessingResult } = options;
    const recoveredPr = await retryPRCreationViaAPI({ worktreeInfo, issueRef, repoValidation, correlatedLogger, labels: await recoveredPullRequestLabels(options) });
    await autoAssignCompletedPullRequest(assignmentContext, { pr: recoveredPr });
    if (!recoveredPr) return null;
    await completeIssueLabelsBestEffort({ octokit, issueRef, AI_PROCESSING_TAG, AI_DONE_TAG, correlatedLogger });
    return {
        success: true,
        pr: { number: recoveredPr.number, url: `https://github.com/${issueRef.repoOwner}/${issueRef.repoName}/pull/${recoveredPr.number}`, title: `Fix issue #${issueRef.number}` },
        updatedLabels: postProcessingResult?.updatedLabels || [],
    };
}

export async function handlePRValidation(options: PRValidationOptions): Promise<PostProcessingResult | null> {
    const { claudeResult, worktreeInfo, issueRef, octokit, postProcessingResult, commitResult, AI_PROCESSING_TAG, AI_DONE_TAG, correlationId, correlatedLogger } = options;
    const assignmentContext = { octokit, issueRef, correlatedLogger, taskId: options.taskId, stateManager: options.stateManager, currentIssueData: options.currentIssueData };

    // After a rejected push the salvage ladder already ran; another push would be refused too.
    if (!worktreeInfo || postProcessingResult?.pushFailure) return postProcessingResult;

    const finalPRValidation: PRValidation = await validatePRCreation({
        owner: issueRef.repoOwner, repoName: issueRef.repoName,
        branchName: worktreeInfo.branchName, expectedPrNumber: postProcessingResult?.pr?.number, correlationId
    });

    if (finalPRValidation.isValid && !postProcessingResult?.pr) {
        // The pull request exists: a label failure is logged, never fatal to linking and assignment.
        await completeIssueLabelsBestEffort({ octokit, issueRef, AI_PROCESSING_TAG, AI_DONE_TAG, correlatedLogger });

        // Link PR to plan issue if found during validation
        if (finalPRValidation.pr?.number) {
            await addPullRequestProcessingLabels(octokit, { repoOwner: issueRef.repoOwner, repoName: issueRef.repoName, prNumber: finalPRValidation.pr.number }, await recoveredPullRequestLabels(options), { correlatedLogger, presentLabels: finalPRValidation.pr.labels });
            const repository = `${issueRef.repoOwner}/${issueRef.repoName}`;
            await linkPRToPlanIssue(repository, issueRef.number, finalPRValidation.pr.number);
            correlatedLogger.info({ repository, issueNumber: issueRef.number, prNumber: finalPRValidation.pr.number }, 'Linked PR to plan issue (found during validation)');
        }
        // Post-processing never saw this pull request, so it was not assigned there.
        await autoAssignCompletedPullRequest(assignmentContext, finalPRValidation);

        return { success: true, pr: finalPRValidation.pr ? { number: finalPRValidation.pr.number, url: finalPRValidation.pr.url, title: finalPRValidation.pr.title } : null, updatedLabels: postProcessingResult?.updatedLabels || [] };
    }

    // Only retry PR creation if:
    // 1. PR validation failed (no PR found)
    // 2. Agent execution completed, or stopped at a publishable timeout/turn limit
    // 3. There were actual commits (commitResult !== null means changes were made and a PR is expected)
    if (finalPRValidation.isValid || !hasPublishableAgentWork(claudeResult)) return postProcessingResult;
    if (commitResult !== null) return await recreatePullRequest(options, worktreeInfo, assignmentContext) ?? postProcessingResult;
    correlatedLogger.info({ issueNumber: issueRef.number }, 'No PR validation needed - no code changes were made');
    return postProcessingResult;
}

export interface CleanupOptions {
    worktreeInfo: WorktreeInfo | undefined;
    localRepoPath: string;
    claudeResult: ClaudeCodeResponse | null | undefined;
    postProcessingResult: PostProcessingResult | null;
    jobId: string | undefined;
    issueRef: IssueJobData;
    correlatedLogger: Logger;
}

export async function cleanupWorktreeIfExists(options: CleanupOptions): Promise<void> {
    const { worktreeInfo, localRepoPath, claudeResult, postProcessingResult, jobId, issueRef, correlatedLogger } = options;
    if (!worktreeInfo) return;

    try {
        const wasSuccessful = claudeResult?.success && postProcessingResult?.pr;
        await cleanupWorktree(localRepoPath, worktreeInfo.worktreePath, worktreeInfo.branchName, {
            deleteBranch: !wasSuccessful, success: !!wasSuccessful,
            retentionStrategy: process.env.WORKTREE_RETENTION_STRATEGY || 'always_delete'
        });
    } catch (cleanupError) {
        correlatedLogger.warn({ jobId, issueNumber: issueRef.number, error: (cleanupError as Error).message }, 'Failed to cleanup worktree');
    }
}

export interface FinalValidationOptions {
    claudeResult: ClaudeCodeResponse | undefined;
    worktreeInfo: WorktreeInfo | undefined;
    issueRef: IssueJobData;
    octokit: Octokit;
    postProcessingResult: PostProcessingResult | null;
    commitResult: CommitResult | null;
    repoValidation: RepoValidation;
    AI_PROCESSING_TAG: string;
    AI_DONE_TAG: string;
    localRepoPath: string;
    jobId: string | undefined;
    correlationId: string;
    correlatedLogger: Logger;
    taskId?: string;
    stateManager?: WorkerStateManager;
    currentIssueData?: CompletedPullRequestAssignmentContext['currentIssueData'];
    PR_LABEL?: string;
    modelName?: string;
}

/** Returns the run's post-processing outcome, including a pull request final validation found or recreated. */
export async function performFinalValidation(options: FinalValidationOptions): Promise<PostProcessingResult | null> {
    const { claudeResult, worktreeInfo, issueRef, octokit, postProcessingResult, commitResult, repoValidation, AI_PROCESSING_TAG, AI_DONE_TAG, localRepoPath, jobId, correlationId, correlatedLogger, taskId, stateManager, currentIssueData, PR_LABEL, modelName } = options;
    let resolvedPostProcessingResult = postProcessingResult;

    // A blocked run deliberately published nothing, so there is no pull request to find or recreate.
    if (claudeResult?.success && worktreeInfo?.branchName && !postProcessingResult?.blocked) {
        try {
            resolvedPostProcessingResult = await handlePRValidation({ claudeResult, worktreeInfo, issueRef, octokit, postProcessingResult, commitResult, repoValidation, AI_PROCESSING_TAG, AI_DONE_TAG, correlationId, correlatedLogger, jobId, taskId, stateManager, currentIssueData, PR_LABEL, modelName });
        } catch (validationError) {
            correlatedLogger.error({ jobId, issueNumber: issueRef.number, error: (validationError as Error).message }, 'Final PR validation failed');
        }
    }

    await cleanupWorktreeIfExists({ worktreeInfo, localRepoPath, claudeResult, postProcessingResult: resolvedPostProcessingResult, jobId, issueRef, correlatedLogger });
    return resolvedPostProcessingResult;
}
