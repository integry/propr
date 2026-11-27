/**
 * What happens to an Ultrafix loop when one of its step jobs fails for good.
 *
 * A step refused at worker admission for disk pressure is a wait for the loop
 * (see `ultrafixDiskPressureWait.ts`): it posts one "waiting for free disk
 * space" notice once, instead of a refusal comment per attempt. The notice
 * counts as given only once GitHub accepted it: a failed publication is
 * retried on the next refusal of the same wait. Any other failure is a failed step for the breaker.
 */

import type { Logger } from 'pino';
import type { Redis } from 'ioredis';
import { isWorktreeDiskPressureError, worktreeDiskPressureDetails } from '@propr/core';
import { buildDiskPressureWaitNotice, markDiskPressureNoticePosted, needsDiskPressureWaitNotice } from './ultrafixDiskPressureWait.js';
import { recordFailedUltrafixStep, recordUltrafixDiskPressureRefusal, type FailedStepJobData } from './ultrafixFailedStep.js';
import { postPrComment } from './ultrafixLoopGithub.js';

export interface ExhaustedUltrafixStepOutcome {
    /** The loop already told the pull request (or deliberately stays quiet): no refusal comment. */
    reportedOnPullRequest: boolean;
}

export async function handleExhaustedUltrafixStep(
    redis: Redis,
    data: FailedStepJobData,
    error: Error,
    { correlatedLogger, post = postPrComment }: { correlatedLogger: Logger; post?: typeof postPrComment },
): Promise<ExhaustedUltrafixStepOutcome> {
    if (isWorktreeDiskPressureError(error)) {
        const details = worktreeDiskPressureDetails(error);
        const wait = await recordUltrafixDiskPressureRefusal(redis, data, Date.now(), details);
        if (wait) {
            correlatedLogger.info(
                {
                    pullRequestNumber: data.pullRequestNumber, action: wait.action, refusals: wait.refusals, retryAt: wait.retryAt, exhausted: wait.exhausted === true,
                    ...(details ? { diskPressureDetails: details } : {}),
                },
                `Ultrafix step refused for disk pressure: waiting for free disk space${details ? ` (${details})` : ''}`,
            );
            // Once published, later refusals stay quiet; running out of retries ends the loop with its own stop notice.
            if (needsDiskPressureWaitNotice(wait)) {
                const owner = data.repoOwner!, repo = data.repoName!, pr = data.pullRequestNumber!;
                const commentId = await post({
                    owner, repo, pullRequestNumber: pr, body: buildDiskPressureWaitNotice(wait.action, wait.details), correlatedLogger,
                });
                if (commentId === null) {
                    correlatedLogger.warn({ pullRequestNumber: pr, refusals: wait.refusals }, 'Ultrafix disk-space waiting notice not published: retrying on the next refusal');
                } else if (!await markDiskPressureNoticePosted(redis, { owner, repo, pr }, data.ultrafixMeta?.workEpoch ?? 0, wait)) {
                    correlatedLogger.warn({ pullRequestNumber: pr, commentId }, 'Ultrafix disk-space waiting notice posted, but the loop moved on before it was recorded');
                }
            }
            return { reportedOnPullRequest: true };
        }
    }
    await recordFailedUltrafixStep(redis, data);
    return { reportedOnPullRequest: false };
}
