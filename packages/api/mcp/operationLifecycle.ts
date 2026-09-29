import { redactSecrets, type McpErrorEnvelope } from './errorEnvelope.js';
import type { McpOperations, LifecycleOutcome, Operation } from './operations.js';

const startedTaskStates = new Set(['processing', 'claude_execution', 'post_processing']);
const executedGoalTaskStates = new Set([...startedTaskStates, 'completed', 'failed']);
const terminalStates = new Set<LifecycleOutcome>(['completed', 'failed', 'cancelled']);

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function positiveInteger(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value !== 'number' && (typeof value !== 'string' || value.trim().length === 0)) continue;
    const number = Number(value);
    if (Number.isSafeInteger(number) && number > 0) return number;
  }
  return undefined;
}

function nonEmptyString(...values: unknown[]): string | undefined {
  return values.find(value => typeof value === 'string' && value.length > 0) as string | undefined;
}

function epochMilliseconds(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function taskIdFromReceipt(
  target: Record<string, unknown>,
  continuation: Record<string, unknown>,
  result: Record<string, unknown>,
  targetIssues: Record<string, unknown>[],
): string | undefined {
  const currentTask = record(target.currentTask) ?? {};
  return nonEmptyString(target.taskId, target.task_id, target.current_task_id, currentTask.taskId,
    currentTask.task_id, continuation.taskId, result.taskId,
    ...targetIssues.flatMap(issue => [issue.taskId, issue.task_id]));
}

function issueNumbersFromReceipt(
  result: Record<string, unknown>,
  continuation: Record<string, unknown>,
  target: Record<string, unknown>,
  targetIssues: Record<string, unknown>[],
): number[] {
  const issueNumbers = new Set<number>();
  for (const value of [result.issueNumber, result.issue_number, continuation.issueNumber, target.issueNumber, target.issue_number]) {
    const number = positiveInteger(value);
    if (number) issueNumbers.add(number);
  }
  if (Array.isArray(result.issues)) for (const value of result.issues) {
    const issue = record(value);
    const number = positiveInteger(issue?.number, issue?.issueNumber, value);
    if (number) issueNumbers.add(number);
  }
  for (const issue of targetIssues) {
    const number = positiveInteger(issue.number, issue.issueNumber, issue.issue_number);
    if (number) issueNumbers.add(number);
  }
  return [...issueNumbers];
}

/** Collect stable output handles from mutation results and tracker observations. */
export function artifactsFromReceipt(row: Pick<Operation, 'repository'>, receipt: Record<string, unknown>): Record<string, unknown> {
  const result = record(receipt.result) ?? {};
  const continuation = record(result.continuation) ?? {};
  const target = record(receipt.targetState) ?? {};
  const submissionProgress = record(result.progress) ?? {};
  const submissionTask = record(submissionProgress.task) ?? {};
  const submissionPullRequest = record(submissionProgress.pullRequest) ?? {};
  const targetIssues: Record<string, unknown>[] = Array.isArray(target.issues)
    ? target.issues.map(record).filter((value): value is Record<string, unknown> => !!value) : [];
  const artifacts: Record<string, unknown> = {};

  const submissionId = nonEmptyString(result.submissionId);
  if (submissionId) artifacts.submissionId = submissionId;

  // A terminal target identifies the execution whose outcome this receipt
  // describes. Submission progress may already point at a newer retry.
  const taskId = taskIdFromReceipt(target, continuation, result, targetIssues) ?? nonEmptyString(submissionTask.id);
  if (taskId) artifacts.taskId = taskId;

  const repository = nonEmptyString(result.repository, row.repository);
  const pullRequestNumber = positiveInteger(
    result.pullRequest, result.pr_number, result.prNumber,
    continuation.pullRequest, continuation.pr_number,
    target.pullRequest, target.pr_number, target.final_pr_number,
    submissionPullRequest.number,
    ...targetIssues.flatMap(issue => [issue.pullRequest, issue.pr_number]),
  );
  if (repository && pullRequestNumber) artifacts.pullRequest = {
    repository,
    number: pullRequestNumber,
    url: `https://github.com/${repository}/pull/${pullRequestNumber}`,
  };

  const issueNumbers = issueNumbersFromReceipt(result, continuation, target, targetIssues);
  if (repository && issueNumbers.length) artifacts.issues = issueNumbers.map(number => ({
    repository,
    number,
    url: `https://github.com/${repository}/issues/${number}`,
  }));

  const commentId = positiveInteger(result.commentId, continuation.commentId, target.commentId);
  if (commentId) artifacts.commentId = commentId;
  const reviews = Array.isArray(result.reviewResults) ? result.reviewResults.map(record).filter(Boolean) : [];
  const reviewCommentId = positiveInteger(...reviews.flatMap(review => [review?.commentId]));
  if (reviewCommentId) artifacts.reviewCommentId = reviewCommentId;
  const headSha = nonEmptyString(result.currentHead, target.headSha, target.head_sha);
  if (headSha && /^[0-9a-f]{40}$/i.test(headSha)) artifacts.headSha = headSha;
  return artifacts;
}

function publicFailure(code: string, message: string, details?: Record<string, unknown>): McpErrorEnvelope {
  return { code, message: redactSecrets(message), stage: 'internal', retryable: false, status: 500, ...(details ? { details } : {}) };
}

function resultFailure(result: Record<string, unknown> | undefined): McpErrorEnvelope | undefined {
  const resultError = record(result?.error);
  if (resultError && typeof resultError.code === 'string' && typeof resultError.message === 'string'
    && typeof resultError.retryable === 'boolean' && typeof resultError.status === 'number') {
    return resultError as unknown as McpErrorEnvelope;
  }

  const loop = record(result?.loop);
  return loop?.completionStatus === 'failed'
    ? publicFailure('EXECUTION_FAILED', nonEmptyString(loop.completionReason) ?? 'Ultrafix loop failed.')
    : undefined;
}

/** Normalize durable backend failure evidence into the public error envelope. */
// eslint-disable-next-line complexity -- failure precedence is intentionally centralized and ordered
export function failureFromReceipt(receipt: Record<string, unknown>): McpErrorEnvelope | undefined {
  const lifecycleFailure = record(receipt.lifecycleFailure);
  if (lifecycleFailure && typeof lifecycleFailure.code === 'string' && typeof lifecycleFailure.message === 'string'
    && typeof lifecycleFailure.retryable === 'boolean' && typeof lifecycleFailure.status === 'number') {
    return lifecycleFailure as unknown as McpErrorEnvelope;
  }
  const result = record(receipt.result);
  const ultrafix = record(result?.ultrafixProgress) ?? record(receipt.lifecycleProgress);
  if (ultrafix?.outcome === 'failed') {
    const loop = record(result?.loop);
    const legacyFailure = loop?.completionStatus === 'failed' && nonEmptyString(loop.completionReason)
      ? resultFailure(result) : undefined;
    if (legacyFailure) return legacyFailure;
    const taskId = nonEmptyString(ultrafix.failingTaskId, record(receipt.targetState)?.taskId);
    return {
      code: 'ULTRAFIX_CYCLE_FAILED', message: 'An ultrafix cycle failed.', stage: 'workflow', retryable: false, status: 500,
      ...(taskId ? { details: { taskId } } : {}),
    };
  }
  const backendFailure = resultFailure(result);
  if (backendFailure) return backendFailure;

  const target = record(receipt.targetState);
  const reviewResults = Array.isArray(target?.reviewResults) ? target.reviewResults
    : Array.isArray(result?.reviewResults) ? result.reviewResults : [];
  const failedReviews = reviewResults.map(record).filter((review): review is Record<string, unknown> => review?.success === false);
  if (failedReviews.length && failedReviews.length === reviewResults.length) {
    const reasons = failedReviews.flatMap(review => typeof review.error === 'string' && review.error.length ? [review.error] : []);
    return publicFailure('REVIEW_FAILED', reasons.length ? reasons.join('; ') : 'Every requested review failed.', {
      failedReviewCount: failedReviews.length,
    });
  }

  const currentTask = record(target?.currentTask);
  const reason = nonEmptyString(target?.failure_reason, currentTask?.reason, target?.reason, result?.reason);
  return reason ? publicFailure('EXECUTION_FAILED', reason) : undefined;
}

function lifecycleOutcome(
  row: Operation,
  target: Record<string, unknown> | undefined,
  receiptState: string,
  targetState: string,
): LifecycleOutcome | undefined {
  if (terminalStates.has(receiptState as LifecycleOutcome)) return receiptState as LifecycleOutcome;
  if (row.tool === 'run_ultrafix' || (!target?.taskId && !target?.task_id)) return undefined;
  return terminalStates.has(targetState as LifecycleOutcome) ? targetState as LifecycleOutcome : undefined;
}

async function syncCancellation(
  operations: McpOperations,
  row: Operation,
  receipt: Record<string, unknown>,
): Promise<void> {
  if (row.tool !== 'cancel_operation') return;
  const result = record(receipt.result);
  const sourceId = nonEmptyString(result?.operationId);
  if (sourceId && result?.cancellation === 'confirmed') await operations.finishCancellationSource(row, sourceId);
}

function observedStartTimestamp(
  target: Record<string, unknown> | undefined,
  result: Record<string, unknown> | undefined,
  targetState: string,
): number | null | undefined {
  const loop = record(result?.loop);
  const currentTask = record(target?.currentTask);
  const currentTaskState = String(currentTask?.state ?? '');
  const observedStart = startedTaskStates.has(targetState) || executedGoalTaskStates.has(currentTaskState)
    || target?.queueState === 'active' || loop?.active === true;
  if (!observedStart) return null;
  return epochMilliseconds(currentTask?.timestamp) ?? epochMilliseconds(target?.timestamp);
}

function progressFromReceipt(
  receipt: Record<string, unknown>,
  result: Record<string, unknown> | undefined,
  target: Record<string, unknown> | undefined,
  outcome: LifecycleOutcome | undefined,
): unknown {
  if (outcome && result?.ultrafixProgress != null) return result.ultrafixProgress;
  return receipt.lifecycleProgress ?? target;
}

/** Persist tracker observations without allowing stale concurrent polls to undo newer lifecycle facts. */
export async function syncLifecycle(
  operations: McpOperations,
  row: Operation,
  receipt: Record<string, unknown>,
): Promise<void> {
  const artifacts = artifactsFromReceipt(row, receipt);
  if (Object.keys(artifacts).length) await operations.recordArtifacts(row.id, artifacts);

  const target = record(receipt.targetState);
  const targetState = String(target?.state ?? '');
  const receiptState = String(receipt.state ?? '');
  const result = record(receipt.result);
  const outcome = lifecycleOutcome(row, target, receiptState, targetState);
  const lifecycleProgress = progressFromReceipt(receipt, result, target, outcome);
  if (lifecycleProgress && !outcome) await operations.recordProgress(row.id, lifecycleProgress);

  const pickedUpCommand = ['review_pull_request', 'fix_review_findings', 'run_ultrafix', 'comment_on_pull_request'].includes(row.tool)
    && typeof artifacts.taskId === 'string';
  const startedAt = pickedUpCommand ? epochMilliseconds(target?.timestamp) ?? Date.now()
    : observedStartTimestamp(target, result, targetState);
  if (startedAt !== null) await operations.markStarted(row.id, startedAt);

  if (outcome) {
    // Persist the terminal snapshot in the same guarded update as the outcome.
    // This closes the window where an older nonterminal poll could otherwise
    // replace terminal progress between two lifecycle writes.
    await operations.finish(row.id, outcome, outcome === 'failed' ? failureFromReceipt(receipt) : undefined, lifecycleProgress);
  } else if (receiptState === 'unknown') {
    await operations.markUnknown(row.id, failureFromReceipt(receipt));
  } else if (receiptState === 'queued' && target) {
    // A task or queue can appear after an earlier timeout. Resolve pre-start
    // uncertainty without erasing evidence that execution had already begun.
    await operations.markAccepted(row.id);
  }

  await syncCancellation(operations, row, receipt);
}
