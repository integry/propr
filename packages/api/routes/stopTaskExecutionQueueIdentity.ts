export interface CancellationTarget {
  repository: string;
  prNumber: number;
}

export function assertQueueJobMatchesCancellationTarget(params: {
  taskId: string;
  queueJobId: string;
  repository: string;
  prNumber: number | null;
  cancellationTarget?: CancellationTarget;
}): void {
  const {
    taskId,
    queueJobId,
    repository,
    prNumber,
    cancellationTarget,
  } = params;
  if (!cancellationTarget) {
    return;
  }

  if (repository === cancellationTarget.repository && prNumber === cancellationTarget.prNumber) {
    return;
  }

  throw new Error(
    `Queued task cancellation target mismatch for ${taskId} (${queueJobId}): expected ${cancellationTarget.repository}#${cancellationTarget.prNumber}, got ${repository}#${prNumber ?? 'unknown'}`,
  );
}
