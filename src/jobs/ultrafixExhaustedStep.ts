/**
 * What happens to an Ultrafix loop when one of its step jobs fails for good.
 *
 * A step refused at worker admission for disk pressure is a wait for the loop
 * (see `ultrafixDiskPressureWait.ts`): it posts one "waiting for free disk
 * space" notice on the first refusal and none after, instead of a refusal
 * comment per attempt. Any other failure is a failed step for the breaker.
 */

import type { Logger } from 'pino';
import type { Redis } from 'ioredis';
import { isWorktreeDiskPressureError } from '@propr/core';
import { buildDiskPressureWaitNotice } from './ultrafixDiskPressureWait.js';
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
        const wait = await recordUltrafixDiskPressureRefusal(redis, data);
        if (wait) {
            correlatedLogger.info(
                { pullRequestNumber: data.pullRequestNumber, action: wait.action, refusals: wait.refusals, retryAt: wait.retryAt, exhausted: wait.exhausted === true },
                'Ultrafix step refused for disk pressure: waiting for free disk space',
            );
            // Later refusals stay quiet; running out of retries ends the loop with its own stop notice.
            if (wait.refusals === 1 && !wait.exhausted) {
                await post({
                    owner: data.repoOwner!, repo: data.repoName!, pullRequestNumber: data.pullRequestNumber!,
                    body: buildDiskPressureWaitNotice(wait.action), correlatedLogger,
                });
            }
            return { reportedOnPullRequest: true };
        }
    }
    await recordFailedUltrafixStep(redis, data);
    return { reportedOnPullRequest: false };
}
