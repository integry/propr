import type { PRCommentTaskStateFinalizerOptions } from './prCommentTaskStateFinalizers.js';
import { redisClient } from './issueJob/config.js';
import { recordFailedUltrafixStep, type FailedStepJobData } from './ultrafixFailedStep.js';

/** A step that failed for good runs no continuation: leave the resume sweep a retry. */
export const ultrafixFailedStepFinalizerOptions: PRCommentTaskStateFinalizerOptions = {
    onExhaustedFailure: async job => {
        await recordFailedUltrafixStep(redisClient, job.data as FailedStepJobData);
    },
};
