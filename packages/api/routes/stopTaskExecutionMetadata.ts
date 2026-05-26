import type { StopTaskCancellationReason } from './stopTaskExecution.js';

export function buildStopMessageMetadata(
  cancellation: StopTaskCancellationReason,
  requestedBy: string,
): Record<string, string> {
  return {
    reasonCode: cancellation.code,
    requestedBy,
    ...(cancellation.requestId ? { cancellationRequestId: cancellation.requestId } : {}),
  };
}
