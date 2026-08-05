import type { Logger } from 'pino';
import type { ReasoningLevel } from '@propr/shared';
import {
    generateCorrelationId,
    hashTaskAttemptToken,
    issueQueue,
} from '@propr/core';

export interface CleanupRecoveryOptions {
    repoOwner: string;
    repoName: string;
    pullRequestNumber: number;
    jobBranchName: string | undefined;
    jobLlm: string | null | undefined;
    jobReasoningLevel?: ReasoningLevel;
    attemptGeneration: string;
    correlatedLogger: Logger;
}

export function buildPRCommentWorktreeDirName(
    pullRequestNumber: number,
    lockToken: string,
): string {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const attemptSlug = hashTaskAttemptToken(lockToken).slice(0, 24);
    return `pr-${pullRequestNumber}-followup-${timestamp}-${attemptSlug}`;
}

/** Queues an empty batch that will collect pending comments without rerunning this attempt. */
export async function schedulePRCommentCleanupRecovery(options: CleanupRecoveryOptions): Promise<void> {
    const {
        repoOwner, repoName, pullRequestNumber, jobBranchName, jobLlm,
        jobReasoningLevel, attemptGeneration, correlatedLogger,
    } = options;
    const ownerSlug = repoOwner.replace(/[^a-zA-Z0-9-]/g, '-');
    const repoSlug = repoName.replace(/[^a-zA-Z0-9-]/g, '-');
    const recoveryCorrelationId = generateCorrelationId();
    const generationSlug = attemptGeneration.replace(/[^a-zA-Z0-9-]/g, '-');
    const recoveryJobId = `pr-comments-cleanup-recovery-${ownerSlug}-${repoSlug}-${pullRequestNumber}-${generationSlug}`;
    await issueQueue.add('processPullRequestComment', {
        pullRequestNumber,
        comments: [],
        repoOwner,
        repoName,
        branchName: jobBranchName,
        llm: jobLlm,
        correlationId: recoveryCorrelationId,
        reasoningLevel: jobReasoningLevel,
    }, { jobId: recoveryJobId, delay: 3000 });
    correlatedLogger.info(
        { jobId: recoveryJobId, pullRequestNumber },
        'Queued durable cleanup recovery for comments that may still be pending',
    );
}
