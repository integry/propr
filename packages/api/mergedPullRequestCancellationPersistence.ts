import { logger } from '@propr/core';
import type { StopTaskExecutionOptions } from './routes/stopTaskExecution.js';
import type { MergeTaskCancellationFailure } from './mergedPullRequestCancellation.js';

const MERGE_CANCELLATION_FAILURE_TTL_SECONDS = 24 * 60 * 60;

export async function persistMergedCancellationFailures(params: {
  redisClient: StopTaskExecutionOptions['redisClient'];
  repository: string;
  prNumber: number;
  correlationId: string;
  failures: MergeTaskCancellationFailure[];
  log: Pick<typeof logger, 'info' | 'warn' | 'error'>;
}): Promise<void> {
  const {
    redisClient,
    repository,
    prNumber,
    correlationId,
    failures,
    log,
  } = params;
  const failureKey = `webhook:merged-pr-cancellation:${repository}#${prNumber}:${correlationId}`;
  try {
    await redisClient.set(
      failureKey,
      JSON.stringify({
        repository,
        prNumber,
        correlationId,
        recordedAt: new Date().toISOString(),
        failures,
      }),
      { EX: MERGE_CANCELLATION_FAILURE_TTL_SECONDS },
    );
  } catch (error) {
    log.error({
      correlationId,
      repository,
      prNumber,
      error: error instanceof Error ? error.message : String(error),
    }, 'Failed to persist merged PR cancellation verification details');
  }
}
