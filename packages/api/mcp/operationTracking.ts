import { getIssueQueue, getIndexingQueue } from '@propr/core';
import type { ToolDeps } from './tools.js';
import type { Operation } from './operations.js';
import type { McpPrincipal } from './policy.js';
import { McpError } from './config.js';
import { redactDetails } from './errorEnvelope.js';
import {
  COMMAND_NOT_PICKED_UP_FAILURE,
  PICKUP_DEADLINE_MS,
  detectPickup,
  ultrafixProgress,
  type UltrafixProgress,
} from './commandProgress.js';
import { reconcileTerminalSubmissionProgress, type SubmissionProgress } from './submissionProgress.js';
import { isUltrafixCommandTool } from './ultrafix.js';

const commentTools = ['review_pull_request', 'fix_review_findings', 'run_ultrafix', 'start_ultrafix', 'comment_on_pull_request'];
const trackedTools = ['create_task', 'retry_task_submission', ...commentTools, 'send_task_followup', 'revert_pull_request_commit', 'index_repository'];
const terminalStates = ['completed', 'failed', 'cancelled'];

/** Resolve only an owned target in the receipt's currently authorized repository. */
export async function cancellationTarget(deps: ToolDeps, principal: McpPrincipal, repository: string | null, target: Record<string, unknown>) {
  let state: Record<string, unknown> | undefined;
  if (target.goalId) state = await deps.db('goals').where({ goal_id: target.goalId, owner_id: principal.user.id, repository }).first('desired_state', 'result_state', 'current_task_id');
  else if (target.taskId) {
    const task = await deps.db('tasks').where({ task_id: target.taskId, repository }).whereNot('task_type', 'goal').first('task_id');
    const goal = await deps.db('goals').where({ current_task_id: target.taskId }).first('goal_id');
    if (task && !goal) state = await deps.db('task_history').where({ task_id: target.taskId }).orderBy('history_id', 'desc').first('state', 'timestamp') || {};
  } else if (target.planId) state = await deps.db('task_drafts').where({ draft_id: target.planId, user_id: principal.user.id, repository }).first('status', 'generation_trace', 'refinement_result');
  if (!state) throw new McpError('NOT_FOUND', 'Cancellation target not found in your authorized repository.', 404);
  return state;
}

export function assertPlannerCancellationIdentity(row: Operation, target: Record<string, unknown>, result: { runId?: string }): void {
  if (!['generate_plan', 'refine_plan'].includes(row.tool)) return;
  const metadata = JSON.parse(String(target[row.tool === 'generate_plan' ? 'generation_trace' : 'refinement_result'] || '{}'));
  if (!result.runId || metadata.runId !== result.runId) throw new McpError('NOT_CANCELLABLE', 'Planner execution identity changed or is unavailable. Inspect the plan directly.', 409);
}

export function cancellationOutcome(target: Record<string, unknown>, tool?: string): string | undefined {
  const state = target.result_state || target.state;
  if (terminalStates.includes(String(state))) return String(state);
  if (tool === 'generate_plan' && target.status === 'failed') return 'failed';
  if (tool === 'generate_plan' && target.status === 'review') return 'completed';
  if (tool === 'refine_plan' && target.status === 'review') {
    const metadata = JSON.parse(String(target.refinement_result || '{}'));
    if (metadata.status === 'failed') return 'failed';
    if (metadata.status === 'completed') return 'completed';
  }
  return undefined;
}

export async function trackCancellation(deps: ToolDeps, row: Operation, principal: McpPrincipal, receipt: Record<string, unknown>): Promise<void> {
  if (!['cancel_operation', 'cancel_goal', 'cancel_task'].includes(row.tool) || !row.result) return;
  const result = JSON.parse(row.result);
  if (result.error) return;
  // Owner/grant and current repository authorization precede this projection.
  // Historical evidence survives deletion; do not substitute a later run's state.
  if (result.executionResolved) { receipt.targetState = result.targetState; return; }
  const target = await cancellationTarget(deps, principal, row.repository, result.continuation || result);
  receipt.targetState = Object.fromEntries(Object.entries(target).filter(([key]) => !['generation_trace', 'refinement_result'].includes(key)));
  result.cancellation ||= 'requested';
  let outcome = result.targetOutcome || cancellationOutcome(target, result.targetTool);
  if (result.plannerRunId && result.cancellation === 'requested') {
    // Abort acceptance only fences writes; the background finally block confirms stop.
    const record = await deps.db('mcp_records').where({ kind: 'planner_stop', id: result.plannerRunId }).first('value');
    const stopped = record && JSON.parse(record.value);
    outcome = stopped?.draftId === result.continuation.planId ? 'cancelled' : undefined;
    if (outcome) receipt.targetState = { planId: stopped.draftId, runId: result.plannerRunId, state: 'cancelled', stoppedAt: stopped.stoppedAt };
  }
  if (outcome) {
    receipt.state = 'completed';
    result.cancellation = outcome === 'cancelled' ? 'confirmed' : 'not_applied';
    result.targetOutcome = outcome;
    result.executionResolved = true;
    result.targetState = receipt.targetState;
  }
  receipt.result = result;
  await deps.db('mcp_operations').where({ id: row.id }).whereNotIn('state', terminalStates).update({ state: receipt.state, result: JSON.stringify(redactDetails(result)), updated_at: Date.now() });
}

async function refreshPullRequestContext(
  row: Operation,
  principal: McpPrincipal,
  result: ExecutionResult & Record<string, unknown>,
): Promise<void> {
  if (!result.pullRequest) return;
  const [owner, repo] = String(row.repository).split('/');
  const { data: pr } = await principal.github.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
    owner, repo, pull_number: result.pullRequest,
  });
  result.currentHead = pr.head.sha;
  result.results = {
    tool: 'get_pull_request_discussion', repository: row.repository,
    pullRequest: result.pullRequest, taskId: result.continuation?.taskId,
  };
}

function restoreResolvedTarget(
  receipt: Record<string, unknown>,
  result: ExecutionResult,
  task: TrackingContext['task'] | undefined,
): void {
  const target = result.targetState
    ?? (receipt.targetState as Record<string, unknown> | undefined)
    ?? {};
  if (!task && !Object.keys(target).length) return;
  receipt.targetState = {
    ...target,
    ...(task ? { taskId: task.task_id, pr_number: task.pr_number } : {}),
  };
}

/** Resolve the execution from the actual job or the exact triggering comment. */
// eslint-disable-next-line complexity -- tool-specific recovery paths converge on one guarded receipt write
export async function trackExecution(deps: ToolDeps, row: Operation, principal: McpPrincipal, receipt: Record<string, unknown>): Promise<void> {
  if (!trackedTools.includes(row.tool) || !row.result) return;
  const { db } = deps;
  const result = JSON.parse(row.result) as ExecutionResult & Record<string, unknown>;
  if (['create_task', 'retry_task_submission'].includes(row.tool) && !result.continuation?.taskId) return;
  if (result.error) return;
  // Follow every model review, including a list that ended with a single posted
  // review because the head moved or a later comment could not be posted.
  const fanOut = row.tool === 'review_pull_request' && Array.isArray(result.reviews) && result.reviews.length > 1 && postedReviews(result).length > 0;
  const task = row.tool === 'index_repository' || fanOut ? undefined : await findExecutionTask(deps, row, result);
  if (result.executionResolved && terminalStates.includes(row.state)) {
    restoreResolvedTarget(receipt, result, task);
    return;
  }
  let pickupTimedOut = false;
  if (fanOut) pickupTimedOut = await trackReviewFanOut(deps, row, result, receipt);
  else if (task) await trackTask(deps, row, { task, result, receipt });
  else if (result.jobId) await trackQueuedJob(row, result.jobId, receipt);
  else if (isUltrafixCommandTool(row.tool) && await trackUnpickedUltrafix(deps, row, result, receipt)) { /* deferral or stop reported from loop state */ }
  else if (commentTools.includes(row.tool) && Date.now() - Number(row.created_at) > PICKUP_DEADLINE_MS) {
    pickupTimedOut = true;
    receipt.state = 'unknown';
    receipt.lifecycleFailure = COMMAND_NOT_PICKED_UP_FAILURE;
  } else if (!commentTools.includes(row.tool) && Date.now() - Number(row.created_at) > 120000) receipt.state = 'unknown';
  await refreshPullRequestContext(row, principal, result);
  if (terminalStates.includes(String(receipt.state))) {
    if (['create_task', 'retry_task_submission'].includes(row.tool)) {
      const targetState = receipt.targetState && typeof receipt.targetState === 'object' && !Array.isArray(receipt.targetState)
        ? receipt.targetState as Record<string, unknown> : undefined;
      result.progress = reconcileTerminalSubmissionProgress(result.progress, targetState, receipt.state);
      const taskId = typeof targetState?.taskId === 'string' ? targetState.taskId : task?.task_id;
      if (taskId) {
        result.taskId = taskId;
        result.continuation = { ...result.continuation, taskId };
      }
    }
    result.executionResolved = true;
    result.targetState = receipt.targetState as Record<string, unknown> | undefined;
  }
  receipt.result = result;
  if (receipt.state === 'unknown') receipt.message = 'Execution cannot yet be confirmed. Inspect the linked comment/job; polling can still resolve it. Do not blindly resubmit.';
  const eligible = db('mcp_operations').where({ id: row.id }).whereNotIn('state', terminalStates);
  if (pickupTimedOut) {
    const validResult = "CASE WHEN json_valid(result) THEN result ELSE '{}' END";
    const validArtifacts = "CASE WHEN json_valid(artifacts) THEN artifacts ELSE '{}' END";
    eligible.whereNot('state', 'running').whereNull('started_at')
      .whereRaw(`json_extract(${validResult}, '$.continuation.taskId') IS NULL`)
      .whereRaw(`json_extract(${validArtifacts}, '$.taskId') IS NULL`);
  }
  const recorded = await eligible.update({ state: receipt.state, result: JSON.stringify(redactDetails(result)), updated_at: Date.now() });
  if (!recorded) {
    // Another poll persisted stronger evidence while this observation was
    // awaiting external context. Adopt its receipt so both the response and
    // lifecycle synchronization retain the confirmed continuation/outcome.
    const current = await db<Operation>('mcp_operations').where({ id: row.id }).first();
    if (current) {
      const currentResult = current.result ? JSON.parse(current.result) as ExecutionResult & Record<string, unknown> : {};
      receipt.state = current.state;
      receipt.result = currentResult;
      // Losing the guarded timeout write proves a task/start or terminal fact
      // was recorded. Do not let this poll's older pickup failure outrank it.
      delete receipt.lifecycleFailure;
      if (currentResult.ultrafixProgress !== undefined) receipt.lifecycleProgress = currentResult.ultrafixProgress;
      else delete receipt.lifecycleProgress;
      if (currentResult.targetState) receipt.targetState = currentResult.targetState;
      else delete receipt.targetState;
      delete receipt.message;
    }
  }
}

interface ReviewReceipt {
  model?: string; commentId?: number; state?: string;
  taskId?: string; taskState?: string; reviewResults?: ExecutionResult['reviewResults'];
}

function postedReviews(result: ExecutionResult): ReviewReceipt[] {
  return Array.isArray(result.reviews) ? result.reviews.filter(review => review?.commentId && review.state !== 'not_posted') : [];
}

/** Record which task picked up one model's review comment, and where that task is now. */
async function observeReview(deps: ToolDeps, row: Operation, pullRequest: number | undefined, { review, pastDeadline }: { review: ReviewReceipt; pastDeadline: boolean }): Promise<void> {
  const task = pullRequest && row.repository ? await detectPickup(deps.db, {
    repository: row.repository, pullRequest, commentId: Number(review.commentId), tool: row.tool,
  }) : undefined;
  if (!task) {
    delete review.taskId;
    review.taskState = pastDeadline ? 'unknown' : 'pending';
    return;
  }
  const event = await deps.db('task_history').where({ task_id: task.task_id }).orderBy('history_id', 'desc').first('state', 'metadata');
  const metadata = typeof event?.metadata === 'string' ? JSON.parse(event.metadata) : event?.metadata;
  review.taskId = task.task_id;
  review.taskState = event?.state ?? 'pending';
  if (metadata?.reviewResults) review.reviewResults = metadata.reviewResults;
  if (review.taskState === 'completed' && review.reviewResults?.length && review.reviewResults.every(outcome => !outcome.success)) review.taskState = 'failed';
}

/**
 * Follow each comment of a multi-model review on its own, so every model reports
 * the task that picked it up and that task's state. The operation completes once
 * every posted review has finished, fails only when every one of them failed, and
 * is unknown when a review was never picked up within the pickup deadline. A
 * review whose comment may have been posted but was never confirmed cannot be
 * followed, so it holds the operation unknown once the confirmed reviews settle.
 */
async function trackReviewFanOut(deps: ToolDeps, row: Operation, result: ExecutionResult, receipt: Record<string, unknown>): Promise<boolean> {
  const reviews = postedReviews(result);
  const pastDeadline = Date.now() - Number(row.created_at) > PICKUP_DEADLINE_MS;
  for (const review of reviews) await observeReview(deps, row, result.pullRequest, { review, pastDeadline });
  const states = reviews.map(review => String(review.taskState));
  const taskIds = reviews.flatMap(review => review.taskId ? [review.taskId] : []);
  const finished = states.every(state => terminalStates.includes(state));
  const allFailed = finished && states.every(state => state === 'failed');
  // Only reviews that never got picked up may hold the operation in doubt; one
  // still pending or running keeps it running instead.
  const stalled = states.includes('unknown') && states.every(state => state === 'unknown' || terminalStates.includes(state));
  const uncertain = (result.reviews ?? []).filter(review => review?.state === 'unknown' && !review.commentId);
  if (finished && !uncertain.length) receipt.state = allFailed ? 'failed' : 'completed';
  else if (finished || stalled) receipt.state = 'unknown';
  else if (taskIds.length) receipt.state = 'running';
  receipt.targetState = { state: receipt.state, taskIds,
    reviews: reviews.map(review => ({ model: review.model, commentId: review.commentId, taskId: review.taskId ?? null, state: review.taskState })) };
  if (finished && uncertain.length) {
    receipt.lifecycleFailure = { code: 'OUTCOME_UNKNOWN', stage: 'github', retryable: false, status: 502,
      message: 'A requested model review may have been posted but could not be confirmed. Inspect the pull request comments before requesting it again.',
      details: { uncertainModels: uncertain.map(review => review.model ?? null) } };
  } else if (allFailed) {
    receipt.lifecycleFailure = { code: 'REVIEW_FAILED', message: 'Every requested model review failed.', stage: 'workflow', retryable: false, status: 500,
      details: { failedReviewCount: reviews.length } };
  } else if (receipt.state === 'unknown') {
    receipt.lifecycleFailure = COMMAND_NOT_PICKED_UP_FAILURE;
  }
  return receipt.state === 'unknown' && !taskIds.length;
}

interface ExecutionResult {
  reviews?: ReviewReceipt[];
  jobId?: string; commentId?: number; pullRequest?: number;
  submissionId?: string; taskId?: string; progress?: SubmissionProgress;
  goal?: number; maxCycles?: number;
  continuation?: { taskId?: string; jobId?: string; sourceTaskId?: string };
  targetState?: Record<string, unknown>;
  reviewResults?: Array<{ success: boolean; commentId?: number; commentUrl?: string }>;
  loop?: { completionStatus?: string | null } & Record<string, unknown>;
  ultrafixProgress?: unknown;
}
interface TrackingContext {
  task: { task_id: string; pr_number: number | null; initial_job_data: unknown };
  result: ExecutionResult; receipt: Record<string, unknown>;
}

async function findExecutionTask(deps: ToolDeps, row: Operation, result: ExecutionResult) {
  const { db } = deps;
  const continuation = result.continuation || {};
  if (commentTools.includes(row.tool)) {
    if (!result.commentId || !result.pullRequest || !row.repository) return undefined;
    return detectPickup(db, {
      repository: row.repository, pullRequest: result.pullRequest,
      commentId: result.commentId, tool: row.tool,
    });
  }
  const query = db('tasks').where({ repository: row.repository }).whereNot('task_type', 'goal');
  if (['create_task', 'retry_task_submission'].includes(row.tool)) {
    query.where('task_id', continuation.taskId);
  } else {
    query.andWhere(builder => builder.where('task_id', result.jobId || continuation.taskId).orWhere('job_id', result.jobId || continuation.jobId));
  }
  return query.orderBy('created_at', 'desc').first('task_id', 'pr_number', 'initial_job_data');
}

// eslint-disable-next-line complexity -- command pickup and terminal review normalization share the same task snapshot
async function trackTask(deps: ToolDeps, row: Operation, { task, result, receipt }: TrackingContext): Promise<void> {
  result.continuation = { ...result.continuation, taskId: task.task_id };
  const event = await deps.db('task_history').where({ task_id: task.task_id }).orderBy('history_id', 'desc').first('state', 'timestamp', 'reason', 'metadata');
  const metadata = typeof event?.metadata === 'string' ? JSON.parse(event.metadata) : event?.metadata;
  receipt.targetState = { taskId: task.task_id, pr_number: task.pr_number, state: event?.state,
    timestamp: event?.timestamp, reason: event?.reason, reviewResults: metadata?.reviewResults };
  if (metadata?.reviewResults) result.reviewResults = metadata.reviewResults;
  receipt.state = terminalStates.includes(event?.state) ? event.state
    : commentTools.includes(row.tool) ? 'running'
    : !event || event.state === 'pending' ? 'queued' : 'running';
  if (event?.state === 'completed' && result.reviewResults?.length && result.reviewResults.every(review => !review.success)) receipt.state = 'failed';
  if (isUltrafixCommandTool(row.tool)) await trackUltrafix(deps, row, { task, result, receipt });
}

async function trackQueuedJob(row: Operation, jobId: string, receipt: Record<string, unknown>): Promise<void> {
  try {
    const queue = row.tool === 'index_repository' ? await getIndexingQueue() : await getIssueQueue();
    const job = await queue.getJob(jobId);
    const state = await job?.getState();
    // Queue completion without task persistence is not proof that work ran.
    receipt.state = queueReceiptState(state, row.tool === 'index_repository');
    receipt.targetState = { jobId, queueState: state };
  } catch { receipt.state = row.state === 'failed' ? 'failed' : 'unknown'; }
}

function queueReceiptState(state: string | undefined, indexing: boolean): string {
  if (state === 'active') return 'running';
  if (state === 'failed') return 'failed';
  if (state === 'completed' && indexing) return 'completed';
  return ['waiting', 'delayed', 'prioritized', 'waiting-children', 'paused'].includes(state || '') ? 'queued' : 'unknown';
}

// eslint-disable-next-line complexity -- durable progress plus Redis compatibility must preserve strict epoch ownership
async function trackUltrafix(deps: ToolDeps, row: Operation, context: TrackingContext): Promise<void> {
  const { task, result, receipt } = context;
  if (!result.pullRequest) { receipt.state = 'unknown'; return; }
  const jobData = typeof task.initial_job_data === 'string' ? JSON.parse(task.initial_job_data) : task.initial_job_data as { ultrafixMeta?: { workEpoch?: number; goal?: number; maxCycles?: number } } | null;
  const epoch = jobData?.ultrafixMeta?.workEpoch;
  if (!Number.isSafeInteger(epoch) || Number(epoch) < 0 || !row.repository) {
    receipt.state = 'unknown';
    return;
  }
  const progress = await ultrafixProgress(deps.db, {
    repository: row.repository, pullRequest: result.pullRequest, sinceMs: Number(row.created_at), workEpoch: epoch,
    goal: Number(result.goal ?? jobData?.ultrafixMeta?.goal ?? 9),
    maxCycles: Number(result.maxCycles ?? jobData?.ultrafixMeta?.maxCycles ?? 3),
  });
  if (!progress.outcome && row.progress) {
    try {
      if (JSON.parse(row.progress).phase === 'stopping') progress.phase = 'stopping';
    } catch { /* Ignore malformed legacy progress. */ }
  }
  let legacyState: string | undefined;
  if (!progress.outcome) {
    try {
      const [owner, repo] = row.repository.split('/');
      const stored = await deps.redisClient.get(`ultrafix:state:${owner}:${repo}:${result.pullRequest}`);
      const loop = stored ? JSON.parse(stored) : null;
      if (loop && loop.workEpoch !== epoch) {
        receipt.state = 'unknown';
        return;
      }
      if (loop?.completionStatus === 'succeeded') {
        progress.outcome = 'goal_reached'; progress.phase = 'done';
        progress.cycle = Number(loop.cycleCount ?? progress.cycle);
        progress.lastScore = loop.finalScore ?? progress.lastScore;
      } else if (loop?.completionStatus === 'failed') {
        progress.outcome = 'failed'; progress.phase = 'done';
        progress.cycle = Number(loop.cycleCount ?? progress.cycle);
        progress.lastScore = loop.finalScore ?? progress.lastScore;
        legacyState = 'failed';
      }
      if (loop) result.loop = { workEpoch: epoch, active: loop.active, cycleCount: loop.cycleCount,
        completionStatus: loop.completionStatus, completionReason: loop.completionReason, finalScore: loop.finalScore };
    } catch { /* Durable task history remains authoritative when Redis is unavailable. */ }
  }
  result.ultrafixProgress = progress;
  result.loop = { ...result.loop, workEpoch: epoch,
    tasks: progress.cycles.flatMap(cycle => [cycle.reviewTaskId, cycle.fixTaskId].filter(Boolean)),
    completionStatus: result.loop?.completionStatus ?? progress.outcome };
  result.continuation = { ...result.continuation, sourceTaskId: task.task_id,
    taskId: progress.latestTaskId ?? task.task_id };
  receipt.lifecycleProgress = progress;
  receipt.state = legacyState ?? (progress.outcome === 'goal_reached' || progress.outcome === 'cycles_exhausted' ? 'completed'
    : progress.outcome === 'stopped' ? 'cancelled' : progress.outcome === 'failed' ? 'failed' : 'running');
}

function parseJson(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== 'string') return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch { return null; }
}

/**
 * An ultrafix command whose first review was deferred for CI before any task
 * picked it up (or whose loop stopped waiting) is not a pickup failure: report
 * the deferral reason and blocking checks from the loop's Redis state instead
 * of COMMAND_NOT_PICKED_UP. The loop must have been started by this
 * operation's own comment; a loop another command started on the same PR
 * (possibly a newer one) never describes this operation.
 */
// eslint-disable-next-line complexity -- each Redis record is optional and independently validated
async function trackUnpickedUltrafix(deps: ToolDeps, row: Operation, result: ExecutionResult, receipt: Record<string, unknown>): Promise<boolean> {
  if (!result.pullRequest || !row.repository) return false;
  const [owner, repo] = row.repository.split('/');
  const suffix = `${owner}:${repo}:${result.pullRequest}`;
  try {
    const [deferredRaw, loopRaw, ciRaw] = await Promise.all([
      deps.redisClient.get(`ultrafix:deferred:${suffix}`),
      deps.redisClient.get(`ultrafix:state:${suffix}`),
      deps.redisClient.get(`ultrafix:ci-wait:${suffix}`),
    ]);
    const loop = parseJson(loopRaw);
    if (!loop || typeof loop.workEpoch !== 'number') return false;
    if (typeof result.commentId !== 'number' || loop.sourceCommentId !== result.commentId) return false;
    const createdAt = Number(row.created_at);
    const base: UltrafixProgress = {
      kind: 'ultrafix', goal: Number(result.goal ?? loop.goal ?? 9), maxCycles: Number(result.maxCycles ?? loop.maxCycles ?? 3),
      cycle: Number(loop.cycleCount ?? 0), lastScore: typeof loop.finalScore === 'number' ? loop.finalScore : null,
      phase: 'waiting_for_ci', outcome: null, cycles: [],
    };
    if (!loop.active) {
      const completedAt = typeof loop.completedAt === 'string' ? Date.parse(loop.completedAt) : NaN;
      if (loop.completionStatus !== 'failed' || !(completedAt >= createdAt)) return false;
      const progress: UltrafixProgress = { ...base, phase: 'done', outcome: 'failed' };
      result.ultrafixProgress = progress;
      result.loop = { workEpoch: loop.workEpoch, active: false, completionStatus: 'failed', completionReason: loop.completionReason };
      receipt.lifecycleProgress = progress;
      receipt.state = 'failed';
      receipt.targetState = { state: 'failed', reason: loop.completionReason, workEpoch: loop.workEpoch };
      return true;
    }
    const deferred = parseJson(deferredRaw);
    if (!deferred) return false;
    const deferredEpoch = deferred.workEpoch ?? jsonField(deferred.ultrafixMeta, 'workEpoch');
    const savedAt = typeof deferred.savedAt === 'string' ? Date.parse(deferred.savedAt) : NaN;
    if (deferredEpoch !== loop.workEpoch || !(savedAt >= createdAt)) return false;
    const ci = parseJson(ciRaw);
    const blockingChecks = ci && ci.workEpoch === loop.workEpoch
      ? [...new Set([...stringList(ci.blockingFailed), ...stringList(ci.blockingPending)])] : [];
    const progress: UltrafixProgress = {
      ...base,
      deferral: { reason: String(deferred.reason ?? 'waiting for readiness'), ...(blockingChecks.length ? { blockingChecks } : {}) },
    };
    result.ultrafixProgress = progress;
    receipt.lifecycleProgress = progress;
    receipt.state = 'running';
    receipt.targetState = { state: 'waiting_for_ci', workEpoch: loop.workEpoch, deferral: progress.deferral };
    return true;
  } catch { return false; }
}

function jsonField(value: unknown, key: string): unknown {
  return value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').slice(0, 20) : [];
}
