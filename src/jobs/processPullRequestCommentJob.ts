import { Job } from 'bullmq';
import type { Logger } from 'pino';
import {
    getAuthenticatedOctokit, hashTaskAttemptToken, logger, retryConfigs, runWithExecutionAbortSignal, withRetry,
    getStateManager, TaskStates, ensureGitRepository, createLogFiles, UsageLimitError, recordLLMMetrics,
    loadPrimaryProcessingLabels, loadRepositoryVisualPreviewSettings,
    type CommentJobData, type UnprocessedComment, type JobResult,
} from '@propr/core';
import { Redis } from 'ioredis';
import {
    validateAndFilterComments, filterUnprocessedComments, fetchLinkedIssueContext,
    buildCommentHistory, updateTaskTitleForPR, resolvePrReasoningLevelOverride
} from './prCommentJobHelpers.js';
import { localizeContentImages } from './issueJobHelpers.js';
import {
    buildCombinedComment, extractModelFromLabels, fetchAllComments, buildPrompt,
    handleJobError, cleanupJob, toClaudeResult, buildStartingWorkCommentBody
} from './prCommentJobUtils.js';
import { pickUpPendingCommentsWithClaim, applyPendingCommentCommandContext, restorePendingComments } from './prPendingComments.js';
import { executeReviewProcessing, type PRJobContext } from './prCommentReviewJob.js';
import { generateSummaryTitle, resolveAndExecuteAgent, resolvePRCommentModelName } from './prCommentAgentUtils.js';
import { isReviewComment } from './reviewCommentFormatter.js';
import { hasAuthorizedFixFeedback, prepareFixReviewFeedback } from './reviewFindingSelector.js';
import { retainOriginalScope } from './ultrafixOrchestrationService.js';
import {
    handleUltrafixContinuation,
    markSelectedUltrafixFindings,
    restorePendingCommentsIfUltrafixJobSuperseded,
} from './ultrafixJobHelpers.js';
import { shouldDeferUltrafixReview } from './ultrafixReviewExecutionGate.js';
import { handleNoAuthorizedFindings } from './prCommentNoAuthorizedFindings.js';
import { handlePostExecution } from './prCommentPostExecution.js';
import {
    buildDeterministicPrTaskSubtitle, buildPrTaskTitle, buildPrTaskTitleContext,
    buildPrTaskTitleContextHistoryMetadata, getPrTaskWorkflowLabel, resolvePrTaskWorkflow,
} from './prTaskTitleHelpers.js';
import type { GitHubToken } from './githubTypes.js';
import {
    acquirePRProcessingLock,
    ensurePRProcessingLockToken,
    releasePRProcessingLock,
    startPRProcessingLockHeartbeat,
} from './prProcessingLock.js';
import { createPRCommentTaskStateIfMissing, evaluatePRCommentPreExecutionRecovery, handlePRCommentLockContention } from './prCommentCollisionRecovery.js';
import { stopOriginalPRReviewCycle } from './prContinuationReview.js';
import { loadOriginalContributionDiscussion } from './prContributionDiscussion.js';
import { PullRequestPublication } from './prPublication.js';
import { recoverPendingPublication, type ProcessingState, type ExecuteProcessingParams } from './prPublicationRecovery.js';
import { findPRContinuation, type Contribution } from './prContinuation.js';
import { suspendObsoleteValidationForImplementation } from './followupCiSuspension.js';
import { deferredUltrafixReviewRecap, stoppedReviewRecap } from './notificationRecap.js';

const redisClient = new Redis({
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
    maxRetriesPerRequest: null, enableReadyCheck: false,
});

interface PRData { data: Contribution & { labels: Array<{ name: string }> } }
interface PRComment { id: number; body: string; body_html?: string; user: { login: string; type?: string }; created_at: string; pull_request_review_id?: number }

interface ValidationResult {
    skip: boolean;
    reason?: string;
    prData?: PRData;
    validatedComments?: UnprocessedComment[];
    unprocessedComments?: UnprocessedComment[];
    llm?: string | null;
    prCommentsForValidation?: PRComment[];
}

interface LockParams {
    lockKey: string;
    lockToken: string;
    correlatedLogger: Logger;
}

async function getPrimaryLabels(): Promise<string[]> {
    try {
        if (process.env.CONFIG_REPO) return await loadPrimaryProcessingLabels();
    } catch (error) {
        logger.warn({ error: (error as Error).message }, 'Failed to load primary processing labels from config, using fallback');
    }
    // Fallback to environment variable or default
    const envLabels = process.env.PRIMARY_PROCESSING_LABELS;
    if (envLabels) {
        return envLabels.split(',').map(l => l.trim()).filter(l => l);
    }
    // Final fallback to PR_LABEL for backwards compatibility
    return [process.env.PR_LABEL || 'propr'];
}

async function initializePRJobContext(job: Job<CommentJobData>): Promise<PRJobContext & { pickedUpComments: UnprocessedComment[]; originalUltrafixMeta: CommentJobData['ultrafixMeta'] }> {
    const { pullRequestNumber, commentId, commentBody, commentAuthor, comments, repoOwner, repoName, correlationId, ultrafixMeta: originalUltrafixMeta } = job.data;
    const correlatedLogger = logger.withCorrelation(correlationId);

    // Normalize missing commandMode to 'default' for backward compatibility
    if (!job.data.commandMode) {
        job.data.commandMode = 'default';
    }

    correlatedLogger.debug({ commandMode: job.data.commandMode, hasCommandMeta: !!job.data.commandMeta }, 'Normalized command mode for PR comment job');

    const primaryProcessingLabels = await getPrimaryLabels();
    const isBatchJob = !!comments && Array.isArray(comments);
    const initialComments: UnprocessedComment[] = isBatchJob ? [...comments] : [{ id: commentId!, body: commentBody!, author: commentAuthor!, type: 'issue' as const }];
    const { commentsToProcess, pickedUpComments } = await pickUpPendingCommentsWithClaim(initialComments, { repoOwner, repoName, pullRequestNumber, correlatedLogger, redisClient });
    applyPendingCommentCommandContext(job.data, commentsToProcess, correlatedLogger);
    const { branchName: jobBranchName, llm: jobLlm } = job.data;
    return { pullRequestNumber, jobBranchName, repoOwner, repoName, llm: jobLlm, correlationId, correlatedLogger, primaryProcessingLabels, isBatchJob, commentsToProcess, pickedUpComments, originalUltrafixMeta };
}

async function acquirePRLock(lockParams: LockParams): Promise<boolean> {
    const { lockKey, lockToken, correlatedLogger } = lockParams;

    if (await acquirePRProcessingLock(redisClient, lockKey, lockToken)) {
        correlatedLogger.debug({ lockKey }, 'PR lock acquired');
        return true;
    }

    correlatedLogger.info({ lockKey }, 'PR is currently being processed by another execution. Rescheduling...');
    return false;
}

async function validatePRAndComments(octokit: Awaited<ReturnType<typeof getAuthenticatedOctokit>>, context: PRJobContext & { llm: string | null | undefined }): Promise<ValidationResult> {
    const { commentsToProcess, pullRequestNumber, repoOwner, repoName, primaryProcessingLabels, correlatedLogger, llm: initialLlm } = context;
    const prData = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
        owner: repoOwner, repo: repoName, pull_number: pullRequestNumber,
        mediaType: { format: 'full' }  // Get body_html with signed image URLs
    }) as PRData;
    const botUsername = process.env.GITHUB_BOT_USERNAME || 'propr-dev[bot]';
    // Fetch ALL comments with pagination to handle PRs with 100+ comments
    const allCommentsForValidation = await fetchAllComments(octokit, repoOwner, repoName, pullRequestNumber);
    // Separate issue comments for unprocessed detection (issue comments are first in the array from fetchAllComments)
    const prCommentsForValidation = allCommentsForValidation.filter(c => !('diff_hunk' in c));
    const validatedComments = await validateAndFilterComments(commentsToProcess, allCommentsForValidation, pullRequestNumber, correlatedLogger);
    if (validatedComments.length === 0) return { skip: true, reason: 'all_comments_deleted' };
    // Check if PR has ANY of the primary processing labels (e.g., 'AI' or 'gitfix')
    if (!prData.data.labels.some(label => primaryProcessingLabels.includes(label.name))) return { skip: true, reason: 'missing_required_label' };
    const llm = extractModelFromLabels(prData.data.labels, initialLlm, pullRequestNumber, correlatedLogger);
    const unprocessedComments = filterUnprocessedComments(validatedComments, prCommentsForValidation, botUsername, { pullRequestNumber, correlatedLogger });
    if (unprocessedComments.length === 0) return { skip: true, reason: 'already_processed' };
    return { skip: false, prData, validatedComments, unprocessedComments, llm, prCommentsForValidation };
}

function checkTerminalStateAfterExecution(currentState: { state: string } | null, taskId: string, correlatedLogger: Logger): void {
    const TERMINAL_STATES: string[] = [TaskStates.COMPLETED, TaskStates.FAILED, TaskStates.CANCELLED];
    if (currentState && TERMINAL_STATES.includes(currentState.state)) {
        correlatedLogger.info({ taskId, currentState: currentState.state }, 'Task already in terminal state after agent execution, skipping state update');
        if (currentState.state === TaskStates.CANCELLED) {
            throw new Error('Execution aborted by user request');
        }
        throw new Error(`Task already in terminal state: ${currentState.state}`);
    }
}

function getWebUiUrl(): string {
    return process.env.WEB_UI_URL || process.env.FRONTEND_URL || 'https://gitfix.dev';
}

async function executeProcessing(params: ExecuteProcessingParams): Promise<JobResult> {
    const { job, context, taskId, stateManager, state, lockKey, lockToken } = params;
    let { llm } = params;
    const { pullRequestNumber, repoOwner, repoName, correlationId, correlatedLogger } = context;

    state.octokit = await withRetry(() => getAuthenticatedOctokit(), { ...retryConfigs.githubApi, correlationId }, 'get_authenticated_octokit');
    const validation = await validatePRAndComments(state.octokit, { ...context, llm });
    if (validation.skip) {
        correlatedLogger.info({ pullRequestNumber, reason: validation.reason }, 'Skipping PR comment processing');
        return { status: 'skipped', reason: validation.reason, pullRequestNumber };
    }

    const { prData, unprocessedComments: validUnprocessed, llm: resolvedLlm } = validation;
    state.unprocessedComments = validUnprocessed!;
    llm = resolvedLlm;
    const publication = state.publication ??= new PullRequestPublication(state.octokit, context, prData!.data);
    const { combinedCommentBody, combinedBodyHtml, commentAuthors } = buildCombinedComment(state.unprocessedComments);
    state.authorsText = commentAuthors.map(a => `@${a}`).join(', ');

    const taskUrl = `${getWebUiUrl()}/tasks/${encodeURIComponent(taskId)}`;

    const allComments = await fetchAllComments(state.octokit, repoOwner, repoName, pullRequestNumber);
    const commentsByTime = allComments
        .filter(comment => !comment.body || !isReviewComment(comment.body))
        .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
    const linkedIssueResult = await fetchLinkedIssueContext(state.octokit as unknown as Parameters<typeof fetchLinkedIssueContext>[0], prData!, { repoOwner, repoName, pullRequestNumber }, { correlationId, correlatedLogger });
    job.data.reasoningLevel = resolvePrReasoningLevelOverride(prData!.data.labels, linkedIssueResult.linkedIssueLabels, {
        repoOwner,
        repoName,
        pullRequestNumber,
        correlatedLogger,
    });
    let commentHistory = '';
    if (!job.data.ultrafixMeta) {
        commentHistory = buildCommentHistory(commentsByTime, prData!, correlationId);
        commentHistory += await loadOriginalContributionDiscussion(state.octokit, context);
    }

    const {
        isFixMode,
        fixSelection,
        selectedReviewComments,
        reviewCommentsSection,
    } = await prepareFixReviewFeedback({
        job, allComments, repoOwner, repoName, pullRequestNumber, correlatedLogger, redisClient,
    });

    if (isFixMode && !hasAuthorizedFixFeedback(selectedReviewComments)) {
        correlatedLogger.info(
            { pullRequestNumber },
            'Skipping fix processing because no actionable findings were selected',
        );
        await handleNoAuthorizedFindings({
            job,
            taskId,
            taskUrl,
            stateManager,
            octokit: state.octokit,
            unprocessedComments: state.unprocessedComments,
            redisClient,
            repoOwner,
            repoName,
            pullRequestNumber,
            correlatedLogger,
            correlationId,
        });
        return { status: 'skipped', reason: 'no_authorized_review_findings', pullRequestNumber };
    }

    await markSelectedUltrafixFindings(
        job,
        redisClient,
        { owner: repoOwner, repo: repoName, pr: pullRequestNumber },
        selectedReviewComments,
    );

    state.startingWorkComment = await state.octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
        owner: repoOwner, repo: repoName, issue_number: pullRequestNumber,
        body: [buildStartingWorkCommentBody(state.authorsText, state.unprocessedComments, taskUrl), publication.status].filter(Boolean).join('\n\n'),
    });

    await stateManager.updateTaskState(taskId, TaskStates.PROCESSING, {
        reason: 'Checking PR publication destination',
        historyMetadata: { commandMode: job.data.commandMode || 'default' }
    });
    await ensureGitRepository(correlatedLogger);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
    const prepared = state.worktreeInfo ? { localRepoPath: state.localRepoPath, worktreeInfo: state.worktreeInfo } : await publication.prepare(`pr-${pullRequestNumber}-followup-${timestamp}`);
    state.localRepoPath = prepared.localRepoPath;
    state.worktreeInfo = prepared.worktreeInfo;
    const githubToken = await state.octokit.auth({ type: 'installation' }) as GitHubToken;
    correlatedLogger.info({ worktreePath: state.worktreeInfo.worktreePath, gitTarget: publication.target, destination: publication.status }, 'Prepared PR publication destination');

    // Implementation is authorized and the publication destination is resolved, so
    // the validation of the head this task is about to replace is now obsolete.
    // Opt-in per repository; a failure there never stops the implementation.
    await suspendObsoleteValidationForImplementation({ ref: context, continuation: publication.continuation, taskId, correlationId }, { octokit: state.octokit, log: correlatedLogger });

    const requestBody = isFixMode ? (fixSelection.remainingInstructions || 'Apply only the selected review finding records below.') : combinedCommentBody;
    const localizedCombinedCommentBody = await localizeContentImages(requestBody, state.worktreeInfo.worktreePath, correlatedLogger, { bodyHtml: combinedBodyHtml, issueOrPrId: pullRequestNumber });
    let originalTaskSpec = linkedIssueResult.context || prData!.data.body || '';
    if (job.data.ultrafixMeta) {
        originalTaskSpec = await retainOriginalScope(redisClient, {
            owner: repoOwner,
            repo: repoName,
            pr: pullRequestNumber, workEpoch: job.data.ultrafixMeta.workEpoch ?? 0,
            scope: originalTaskSpec,
        });
    }
    const localizedOriginalTaskSpec = originalTaskSpec
        ? await localizeContentImages(originalTaskSpec, state.worktreeInfo.worktreePath, correlatedLogger, {
            bodyHtml: originalTaskSpec === linkedIssueResult.context ? linkedIssueResult.bodyHtml : undefined,
            issueOrPrId: pullRequestNumber,
        })
        : originalTaskSpec;

    const workflow = resolvePrTaskWorkflow(job.data.commandMode, Boolean(job.data.ultrafixMeta));
    const instructionText = workflow === 'followup'
        ? localizedCombinedCommentBody
        : job.data.commandInstructions;
    const titleContext = buildPrTaskTitleContext({
        workflow,
        pullRequestNumber,
        prTitle: prData!.data.title,
        instructionText,
        recentComments: allComments,
        prDescription: prData!.data.body,
        reviewFeedback: reviewCommentsSection,
        excludeCommentIds: state.unprocessedComments.map(comment => comment.id),
    });
    const fallbackSubtitle = buildDeterministicPrTaskSubtitle(workflow);
    const summaryTitle = await generateSummaryTitle({
        combinedCommentBody: localizedCombinedCommentBody,
        titleContext: titleContext.context,
        fallbackSubtitle,
        worktreeInfo: state.worktreeInfo,
        githubToken,
        pullRequestNumber,
        prTitle: prData!.data.title,
        workflowLabel: getPrTaskWorkflowLabel(workflow),
        repoOwner,
        repoName,
        correlationId,
        taskId,
        correlatedLogger,
    });
    job.data.title = buildPrTaskTitle({ workflow, pullRequestNumber, prTitle: prData!.data.title });
    job.data.subtitle = summaryTitle;
    await updateTaskTitleForPR({ taskId, jobData: job.data, stateManager, correlatedLogger, redisClient, linkedIssueNumber: linkedIssueResult.linkedIssueNumber });
    await stateManager.updateHistoryMetadata(taskId, TaskStates.PROCESSING, {
        titleContext: buildPrTaskTitleContextHistoryMetadata(titleContext),
    });

    const visualPreviewSettings = await loadRepositoryVisualPreviewSettings(`${repoOwner}/${repoName}`);
    const prompt = [publication.status, buildPrompt({ pullRequestNumber, combinedCommentBody: localizedCombinedCommentBody, commentHistory, originalTaskSpec: localizedOriginalTaskSpec, worktreeInfo: state.worktreeInfo, repoOwner, repoName, commentCount: state.unprocessedComments.length, commandMode: job.data.commandMode || 'default', reviewCommentsSection, visualPreviewSettings })].filter(Boolean).join('\n\n');

    const { claudeResult, agentType } = await resolveAndExecuteAgent({
        llm, worktreePath: state.worktreeInfo.worktreePath, branchName: state.worktreeInfo.branchName, prompt,
        pullRequestNumber, repoOwner, repoName, stateManager, correlatedLogger, githubToken: githubToken.token, taskId, redisClient,
        reasoningLevel: job.data.reasoningLevel,
    });
    state.claudeResult = claudeResult;

    checkTerminalStateAfterExecution(await stateManager.getTaskState(taskId), taskId, correlatedLogger);

    await recordLLMMetrics(toClaudeResult(state.claudeResult), { number: pullRequestNumber, repoOwner, repoName }, { jobType: 'pr_comment', correlationId, taskId });
    await createLogFiles(state.claudeResult as unknown, { number: pullRequestNumber, repoOwner, repoName });
    await stateManager.updateTaskState(taskId, TaskStates.CLAUDE_EXECUTION, {
        reason: `${agentType} agent execution completed`,
        claudeResult: { success: state.claudeResult.success, sessionId: state.claudeResult.sessionId, conversationId: state.claudeResult.conversationId, executionTime: state.claudeResult.executionTime },
        historyMetadata: {
            sessionId: state.claudeResult.sessionId,
            conversationId: state.claudeResult.conversationId,
            model: state.claudeResult.model,
            tokenUsage: state.claudeResult.tokenUsage
        }
    });

    const postResult = await handlePostExecution(
        { state, job, taskId, stateManager, context: { ...context, publication }, unprocessedReviewComments: selectedReviewComments, llm, redisClient, prProcessingLockKey: lockKey, prProcessingLockToken: lockToken },
        taskUrl,
    );

    const stopped = await stopOriginalPRReviewCycle({
        ref: context, continuation: publication.continuation, commandMode: job.data.commandMode,
        ultrafix: Boolean(job.data.ultrafixMeta), redis: redisClient, octokit: state.octokit,
    });
    if (!stopped) await handleUltrafixContinuation('fix', { job, stateManager, taskId, redisClient, repoOwner, repoName, pullRequestNumber, correlatedLogger, correlationId });
    await publication.finishCompletion();

    return { status: postResult.partial ? 'partial' : 'complete', commit: postResult.commitHash, pullRequestNumber, claudeResult: { success: state.claudeResult.success } };
}

export async function processPullRequestCommentJob(job: Job<CommentJobData>): Promise<JobResult> {
    const context = await initializePRJobContext(job);
    const { pullRequestNumber, repoOwner, repoName, correlationId, correlatedLogger, isBatchJob, commentsToProcess, jobBranchName, llm } = context;
    correlatedLogger.info({ pullRequestNumber, branchName: jobBranchName, llm, isBatchJob, commentsCount: commentsToProcess.length }, `Processing PR comment${isBatchJob ? 's batch' : ''} job...`);
    if (await restorePendingCommentsIfUltrafixJobSuperseded(job, { repoOwner, repoName, pullRequestNumber, redisClient }, context.pickedUpComments, context.originalUltrafixMeta)) return { status: 'cancelled', reason: 'ultrafix_superseded' };

    const modelName = await resolvePRCommentModelName(llm, correlatedLogger);

    const taskId = job.id || `pr-comment-${pullRequestNumber}-${Date.now()}`;
    const stateManager = getStateManager();
    // Requests on either PR share the source lease so they cannot implement in parallel.
    const octokit = await getAuthenticatedOctokit();
    const resolveLockKey = async () => {
        const continuation = await findPRContinuation(context, octokit);
        return `lock:pr:${repoOwner}:${repoName}:${continuation?.source_pr ?? pullRequestNumber}`;
    };
    let lockKey = await resolveLockKey();
    const lockToken = await ensurePRProcessingLockToken(job.data, correlationId, () => job.updateData(job.data));

    for (;;) {
        const lockAcquired = await acquirePRLock({ lockKey, lockToken, correlatedLogger });
        if (!lockAcquired) {
            return handlePRCommentLockContention({
                job, taskId, stateManager, redisClient, pickedUpComments: context.pickedUpComments,
                correlatedLogger,
            });
        }
        let resolvedLockKey: string;
        try {
            resolvedLockKey = await resolveLockKey();
        } catch (error) {
            await releasePRProcessingLock(redisClient, lockKey, lockToken);
            throw error;
        }
        if (resolvedLockKey === lockKey) break;
        // Adoption may have become visible while acquiring the lease. Do no work
        // under the continuation's own lease; acquire and revalidate the source.
        await releasePRProcessingLock(redisClient, lockKey, lockToken);
        lockKey = resolvedLockKey;
    }

    const recovery = await evaluatePRCommentPreExecutionRecovery({
        job, taskId, stateManager, redisClient, pickedUpComments: context.pickedUpComments,
        correlatedLogger,
        releaseLock: () => releasePRProcessingLock(redisClient, lockKey, lockToken),
    });
    if (recovery.result) return recovery.result;
    const { preexistingState } = recovery;

    const executionController = new AbortController();
    const stopLockHeartbeat = startPRProcessingLockHeartbeat({
        redisClient,
        lockKey,
        lockToken,
        onLockLost: () => { correlatedLogger.error({ lockKey }, 'Lost PR processing lock while execution is still running'); executionController.abort(new Error('PR processing lock was lost during agent execution')); },
        onError: error => correlatedLogger.warn({ lockKey, error: (error as Error).message }, 'Failed to renew PR processing lock'),
    });

    await createPRCommentTaskStateIfMissing({
        job, taskId, stateManager, preexistingState, modelName, correlatedLogger,
    });

    const state: ProcessingState = { octokit: null, localRepoPath: undefined, worktreeInfo: undefined, claudeResult: null, authorsText: '', unprocessedComments: [], startingWorkComment: null };

    try {
        // Re-read under the shared lease: implementation may have adopted while queued.
        state.octokit = octokit;
        const recovered = await runWithExecutionAbortSignal(executionController.signal,
            () => recoverPendingPublication({ job, context, llm, taskId, stateManager, state, lockKey, lockToken }, redisClient), hashTaskAttemptToken(lockToken));
        if (recovered) return recovered;
        const stopped = await stopOriginalPRReviewCycle({
            ref: context, continuation: await findPRContinuation(context), commandMode: job.data.commandMode,
            ultrafix: Boolean(job.data.ultrafixMeta), redis: redisClient, octokit: state.octokit,
        });
        if (stopped) {
            await stateManager.updateTaskState(taskId, TaskStates.COMPLETED, { reason: stopped, historyMetadata: stoppedReviewRecap(stopped) });
            return { status: 'skipped', reason: 'review_moved_to_continuation', pullRequestNumber };
        }
        // Branch early for review mode — read-only analysis, no commits or pushes
        if (job.data.commandMode === 'review') {
            // Recovery can advance the continuation HEAD; gate its checks only after publication completes.
            if (await shouldDeferUltrafixReview(job, redisClient, correlatedLogger)) {
                await restorePendingComments(context.pickedUpComments, { ...context, redisClient });
                await stateManager.updateTaskState(taskId, TaskStates.COMPLETED, {
                    reason: 'Ultrafix review deferred until exact-head checks pass',
                    historyMetadata: { deferred: true, recoveryReason: 'ultrafix_waiting_for_exact_head_checks', ...deferredUltrafixReviewRecap },
                });
                return { status: 'deferred', reason: 'ultrafix_waiting_for_exact_head_checks' };
            }
            return await runWithExecutionAbortSignal(executionController.signal, () => executeReviewProcessing({ job, context, llm, taskId, stateManager, state, redisClient, validatePRAndComments }), hashTaskAttemptToken(lockToken));
        }
        return await runWithExecutionAbortSignal(executionController.signal, () => executeProcessing({ job, context, llm, taskId, stateManager, state, lockKey, lockToken }), hashTaskAttemptToken(lockToken));
    } catch (error) {
        await handleJobError(error as Error, job, { pullRequestNumber, repoOwner, repoName, authorsText: state.authorsText, unprocessedComments: state.unprocessedComments, octokit: state.octokit, startingWorkComment: state.startingWorkComment, claudeResult: state.claudeResult, correlationId, correlatedLogger, stateManager, taskId, retryComments: context.commentsToProcess, publicationStatus: state.publication?.status });
        // Don't re-throw for user cancellations (not an error, just cancelled)
        const isUserCancelled = (error as Error).message?.includes('aborted by user');
        if (isUserCancelled) {
            return { status: 'cancelled', reason: 'user_cancelled' };
        }
        if (!(error instanceof UsageLimitError)) throw error;
        return { status: 'requeued', reason: 'usage_limit' };
    } finally {
        await stopLockHeartbeat();
        await cleanupJob({ stateManager, lockKey, lockToken, taskId, octokit: state.octokit ?? undefined, localRepoPath: state.localRepoPath, worktreeInfo: state.worktreeInfo, repoOwner, repoName, pullRequestNumber, jobBranchName: context.jobBranchName, jobLlm: context.llm, jobUserId: job.data.userId, jobReasoningLevel: job.data.reasoningLevel, correlatedLogger, redisClient });
    }
}
