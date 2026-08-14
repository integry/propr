import type { CommentJobData } from '@propr/core';

/** Reconstruct a delayed provider retry without dropping explicit routing. */
export function buildProviderLimitRetryJobData(jobData: CommentJobData): CommentJobData {
    return { ...jobData, isRetryFromRateLimit: true };
}
