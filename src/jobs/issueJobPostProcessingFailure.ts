/**
 * The fallback for an issue run whose deterministic post-processing threw: it
 * comments on the issue (naming the publication step that failed, when one did)
 * and returns a result that never carries a pull request.
 */
import type { CommitResult, ClaudeCodeResponse } from '@propr/core';
import { generateCompletionComment, redactSecrets, safeUpdateLabels } from '@propr/core';
import { agentFailureLine } from '@propr/shared';
import type { PostProcessingResult } from './issueJobHelpers.js';
import type { PostProcessOptions } from './issueJobPostProcessing.js';
import { describePushFailure, formatIssuePushFailure } from './issueJobPush.js';
import { completeIssueLabelsBestEffort } from './issueJobCompletionLabels.js';
import { taskPageUrl } from './taskPageUrl.js';
import { stripUpstreamPageTitles } from './upstreamPageTitle.js';
import { formatPostProcessingStepHeading, type PostProcessingStep } from './postProcessingStep.js';

export function formatErrorBlock(title: string, message: string): string {
    const redacted = stripUpstreamPageTitles(redactSecrets(message || 'Unknown error')).slice(0, 4000);
    return `**${title}:**\n${redacted}\n\n`;
}

export function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function formatFallbackDiagnostics(claudeResult: ClaudeCodeResponse, postProcessingError: unknown): string {
    const systemError = claudeResult?.success === false && claudeResult.error ? agentFailureLine(claudeResult.error) : '';
    const postProcessingMessage = getErrorMessage(postProcessingError).trim();
    let diagnostics = '';

    if (systemError) {
        diagnostics += formatErrorBlock('System Error', systemError);
    }

    if (postProcessingMessage && postProcessingMessage !== systemError) {
        diagnostics += formatErrorBlock('Post-processing Error', postProcessingMessage);
    }

    return diagnostics;
}


export interface FailedPublication {
    /** The step that was running; set once the run started publishing its work. */
    step?: PostProcessingStep;
    commitResult: CommitResult | null;
}

export async function handlePostProcessingFailure(
    options: PostProcessOptions,
    postProcessingError: unknown,
    publication: FailedPublication = { commitResult: null },
): Promise<PostProcessingResult> {
    const { octokit, issueRef, claudeResult, worktreeInfo, AI_PROCESSING_TAG, AI_DONE_TAG, jobId, correlatedLogger } = options;
    // A rejected push already ran the salvage ladder; the comment says how to recover.
    const { pushFailure, failureFields } = describePushFailure(postProcessingError);
    const failedStep = pushFailure ? undefined : publication.step;
    // A failed publication step opened no pull request, so the issue is not done and stays retryable.
    // Otherwise a completed execution or an actual commit can be marked done; a failed/interrupted
    // run with no commit must remain retryable.
    const canMarkDone = !failedStep && (claudeResult.success || publication.commitResult !== null);
    const stepFields = failedStep ? { failedStep } : {};

    correlatedLogger.error({ jobId, issueNumber: issueRef.number, failedStep, error: (postProcessingError as Error).message }, 'Deterministic post-processing failed');

    try {
        const completedLabels = canMarkDone ? [AI_DONE_TAG] : [];
        // A failed label mutation or report must not suppress the failure comment below.
        if (canMarkDone) {
            await completeIssueLabelsBestEffort({ octokit, issueRef, AI_PROCESSING_TAG, AI_DONE_TAG, correlatedLogger });
        } else {
            await safeUpdateLabels({ octokit, owner: issueRef.repoOwner, repo: issueRef.repoName, issueNumber: issueRef.number, logger: correlatedLogger }, [AI_PROCESSING_TAG], [])
                .catch((labelError: unknown) => correlatedLogger.warn({ issueNumber: issueRef.number, error: getErrorMessage(labelError) }, 'Could not remove the processing label after a post-processing failure'));
        }
        const completionComment = await generateCompletionComment(
            claudeResult,
            { number: issueRef.number, repoOwner: issueRef.repoOwner, repoName: issueRef.repoName },
            { publishedAs: 'issue_comment', ...(options.taskId ? { taskUrl: taskPageUrl(options.taskId) } : {}) },
        ).catch((reportError: unknown) => {
            correlatedLogger.warn({ issueNumber: issueRef.number, error: getErrorMessage(reportError) }, 'Could not build the processing report for the failure comment');
            return '';
        });
        const fallbackHeading = failedStep
            ? formatPostProcessingStepHeading(failedStep, { commitHash: publication.commitResult?.commitHash, branchName: worktreeInfo.branchName })
            : canMarkDone
                ? '⚠️ **Post-processing encountered an error, but ProPR analysis was completed.**'
                : '❌ **AI processing failed before producing publishable work.**';
        await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
            owner: issueRef.repoOwner, repo: issueRef.repoName, issue_number: issueRef.number,
            body: `${pushFailure ? formatIssuePushFailure(pushFailure) : `${fallbackHeading}\n\n${formatFallbackDiagnostics(claudeResult, postProcessingError)}`}${completionComment}`,
        });
        return { success: false, pr: null, updatedLabels: completedLabels, error: (postProcessingError as Error).message, ...failureFields, ...stepFields };
    } catch (fallbackError) {
        correlatedLogger.error({ jobId, issueNumber: issueRef.number, error: (fallbackError as Error).message }, 'Fallback post-processing also failed');
        return { success: false, pr: null, updatedLabels: [], error: (postProcessingError as Error).message, ...failureFields, ...stepFields };
    }
}

