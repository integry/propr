import { createHash } from 'crypto';
import type { StopTaskExecutionOptions } from './routes/stopTaskExecution.js';

export function buildTaskCancellation(
  cancellation: StopTaskExecutionOptions['cancellation'],
  taskId: string,
): StopTaskExecutionOptions['cancellation'] {
  if (!cancellation?.requestId) {
    return cancellation;
  }

  return {
    ...cancellation,
    requestId: `${cancellation.requestId}:${hashRequestIdPart(taskId)}`,
  };
}

export function buildMergeCancellationRequestId(
  repository: string,
  prNumber: number,
): string {
  return `merge-pr-cancel:${hashRequestIdPart(`${repository}#${prNumber}`)}`;
}

function hashRequestIdPart(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 32);
}
