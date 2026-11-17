import { logger } from '@propr/core';
import type { PRCommentTaskStateFinalizerOptions } from './prCommentTaskStateFinalizers.js';
import { redisClient } from './issueJob/config.js';
import type { FailedStepJobData } from './ultrafixFailedStep.js';
import { handleExhaustedUltrafixStep } from './ultrafixExhaustedStep.js';

/** A step that failed for good runs no continuation: leave the resume sweep a retry. */
export const ultrafixFailedStepFinalizerOptions: PRCommentTaskStateFinalizerOptions = {
    onExhaustedFailure: async (job, error) => {
        const data = job.data as FailedStepJobData & { correlationId?: string };
        // A step job always carries its own correlation ID; the fallback only covers malformed data.
        const log = logger.withCorrelation(data.correlationId ?? `ultrafix-step-${job.id ?? 'unknown'}`);
        return handleExhaustedUltrafixStep(redisClient, data, error, { correlatedLogger: log });
    },
};
