import type {
    JobResult,
    TaskState,
    TaskStateData,
    TaskStateExpectation,
    UpdateMetadata,
    WorkerStateManager,
} from '@propr/core';
import { hashTaskAttemptToken, TaskStates } from '@propr/core';
import { sanitizeErrorMessage } from './errorSanitizer.js';

type TaskStateStore = Pick<WorkerStateManager, 'getTaskState' | 'updateTaskStateIfCurrent'>;

const TERMINAL_STATES: ReadonlySet<TaskState> = new Set([
    TaskStates.COMPLETED,
    TaskStates.FAILED,
    TaskStates.CANCELLED,
]);

export function isTerminalTaskState(state: TaskState): boolean {
    return TERMINAL_STATES.has(state);
}

export type KnownPRCommentResultStatus = 'cancelled' | 'rescheduled' | 'requeued' | 'failed' | 'complete' | 'partial' | 'skipped';

const KNOWN_RESULT_STATUSES: ReadonlySet<string> = new Set([
    'cancelled',
    'rescheduled',
    'requeued',
    'failed',
    'complete',
    'partial',
    'skipped',
]);

function isKnownResultStatus(status: string | null): status is KnownPRCommentResultStatus {
    return status !== null && KNOWN_RESULT_STATUSES.has(status);
}

function asResultRecord(result: unknown): Record<string, unknown> | null {
    return result !== null && typeof result === 'object'
        ? result as Record<string, unknown>
        : null;
}

export interface ParsedPRCommentJobResult {
    result: JobResult;
    status: KnownPRCommentResultStatus;
}

/** The single parser used by direct finalizers, worker hooks, and reconciliation. */
export function parsePRCommentJobResult(result: unknown): ParsedPRCommentJobResult | null {
    const record = asResultRecord(result);
    const status = typeof record?.status === 'string' ? record.status : null;
    return isKnownResultStatus(status)
        ? { result: record as JobResult, status }
        : null;
}

function resultReason(result: Record<string, unknown>): string | undefined {
    return typeof result.reason === 'string' && result.reason.trim() ? result.reason : undefined;
}

function invalidResultDescription(result: unknown): string {
    const record = asResultRecord(result);
    if (!record || typeof record.status !== 'string') return 'missing result status';
    return `unknown result status: ${record.status}`;
}

interface TaskFinalizationTransition {
    state: TaskState;
    metadata: UpdateMetadata;
}

function invalidResultTransition(result: unknown, status: string | null): TaskFinalizationTransition {
    const diagnostic = `Completed PR comment job returned an invalid outcome (${invalidResultDescription(result)})`;
    return {
        state: TaskStates.FAILED,
        metadata: {
            reason: diagnostic,
            error: { message: diagnostic, category: 'worker' },
            historyMetadata: {
                outcome: 'invalid_completed_result',
                returnedStatus: status,
            },
        },
    };
}

function knownResultTransition(
    result: JobResult,
    status: KnownPRCommentResultStatus,
): TaskFinalizationTransition {
    const reason = resultReason(result);
    const historyMetadata = {
        outcome: status,
        resultReason: reason ?? null,
        pullRequestNumber: typeof result.pullRequestNumber === 'number' ? result.pullRequestNumber : null,
    };

    switch (status) {
        case 'cancelled':
            return {
                state: TaskStates.CANCELLED,
                metadata: {
                    reason: reason ? `Task cancelled: ${reason}` : 'Task cancelled',
                    historyMetadata,
                },
            };
        case 'rescheduled':
        case 'requeued':
            return {
                state: TaskStates.CANCELLED,
                metadata: {
                    reason: reason ? `Task attempt ${status}: ${reason}` : `Task attempt ${status}`,
                    historyMetadata: { ...historyMetadata, superseded: true },
                },
            };
        case 'failed': {
            const sanitizedReason = sanitizeErrorMessage(reason);
            return {
                state: TaskStates.FAILED,
                metadata: {
                    reason: reason ? `Task failed: ${sanitizedReason}` : 'Task failed',
                    error: { message: reason ? sanitizedReason : 'PR comment job returned a failed outcome', category: 'worker' },
                    historyMetadata: { ...historyMetadata, resultReason: reason ? sanitizedReason : null },
                },
            };
        }
        case 'complete':
        case 'partial':
        case 'skipped':
            return {
                state: TaskStates.COMPLETED,
                metadata: {
                    reason: status === 'skipped'
                        ? `Task skipped: ${reason ?? 'no work required'}`
                        : reason ?? `Task finished with outcome: ${status}`,
                    historyMetadata,
                    commitHash: typeof result.commit === 'string' ? result.commit : undefined,
                },
            };
    }
}

export interface PRCommentTaskFinalizationOptions {
    /** Full scanned-state fence used by reconciliation without a second read. */
    expectation?: TaskStateExpectation;
    /** Attempt fence supplied by a running worker or BullMQ result. */
    prProcessingLockToken?: string;
    onError?: (error: unknown) => void;
}

export function taskStateExpectation(task: TaskStateData): TaskStateExpectation {
    return {
        state: task.state,
        updatedAt: task.updatedAt,
        version: task.version,
        prProcessingLockToken: task.prProcessingLockToken,
    };
}

function finalizationAttemptMatches(
    values: {
        expectationToken?: string;
        optionToken?: string;
        resultGeneration?: string;
        expectedToken?: string;
        requiresMatchingToken: boolean;
    },
): boolean {
    const { expectationToken, optionToken, resultGeneration, expectedToken, requiresMatchingToken } = values;
    if (requiresMatchingToken && expectationToken !== undefined) {
        const expectedGeneration = optionToken
            ? hashTaskAttemptToken(optionToken)
            : resultGeneration;
        if (expectedGeneration !== hashTaskAttemptToken(expectationToken)) return false;
    }
    return expectedToken === undefined || expectationToken === expectedToken;
}

async function resolveFinalizationExpectation(
    taskId: string,
    stateManager: TaskStateStore,
    options: PRCommentTaskFinalizationOptions,
    completedResult?: { value: unknown },
): Promise<TaskStateExpectation | null> {
    const expectation = options.expectation ?? await stateManager.getTaskState(taskId);
    if (!expectation || isTerminalTaskState(expectation.state)) return null;
    const resultRecord = asResultRecord(completedResult?.value);
    const resultToken = typeof resultRecord?.prProcessingLockToken === 'string'
        ? resultRecord.prProcessingLockToken
        : undefined;
    const resultGeneration = typeof resultRecord?.prProcessingAttemptGeneration === 'string'
        ? resultRecord.prProcessingAttemptGeneration
        : resultToken ? hashTaskAttemptToken(resultToken) : undefined;
    const expectedToken = options.prProcessingLockToken ?? (completedResult ? resultToken : undefined);
    const requiresMatchingToken = completedResult !== undefined
        || options.prProcessingLockToken !== undefined
        || options.expectation === undefined;
    // Once a task has an attempt generation, an unfenced old BullMQ event must
    // never be allowed to finalize whichever attempt happens to be current.
    if (!finalizationAttemptMatches({
        expectationToken: expectation.prProcessingLockToken,
        optionToken: options.prProcessingLockToken,
        resultGeneration,
        expectedToken,
        requiresMatchingToken,
    })) return null;
    return options.expectation ?? taskStateExpectation(expectation as TaskStateData);
}

/**
 * Makes a BullMQ PR-comment result visible in the persistent task state.
 *
 * Processors still update their detailed states while they work. This finalizer
 * covers early-return paths and acts as an idempotent safety net from the
 * worker's `completed` event.
 */
export async function finalizePRCommentTaskResult(
    taskId: string,
    stateManager: TaskStateStore,
    result: unknown,
    options: PRCommentTaskFinalizationOptions = {},
): Promise<boolean> {
    const resultRecord = asResultRecord(result);
    const status = typeof resultRecord?.status === 'string' ? resultRecord.status : null;
    const parsed = parsePRCommentJobResult(result);
    const transition = parsed
        ? knownResultTransition(parsed.result, parsed.status)
        : invalidResultTransition(result, status);
    const expectation = await resolveFinalizationExpectation(taskId, stateManager, options, { value: result });
    if (!expectation) return false;
    return Boolean(await stateManager.updateTaskStateIfCurrent(
        taskId,
        expectation,
        transition.state,
        transition.metadata,
    ));
}

/** Direct processor finalization is repairable by the completed hook/reconciler. */
export async function finalizePRCommentTaskResultBestEffort(
    taskId: string,
    stateManager: TaskStateStore,
    result: unknown,
    options: PRCommentTaskFinalizationOptions = {},
): Promise<boolean> {
    try {
        return await finalizePRCommentTaskResult(taskId, stateManager, result, options);
    } catch (error) {
        options.onError?.(error);
        return false;
    }
}

/** Marks a failed BullMQ attempt terminal if the processor did not already do so. */
export async function finalizePRCommentTaskFailure(
    taskId: string,
    stateManager: TaskStateStore,
    error: Error,
    options: PRCommentTaskFinalizationOptions = {},
): Promise<boolean> {
    const expectation = await resolveFinalizationExpectation(taskId, stateManager, options);
    if (!expectation) return false;
    const sanitizedMessage = sanitizeErrorMessage(error.message);

    return Boolean(await stateManager.updateTaskStateIfCurrent(
        taskId,
        expectation,
        TaskStates.FAILED,
        {
            reason: `Worker job failed: ${sanitizedMessage}`,
            error: { message: sanitizedMessage, category: 'worker' },
            historyMetadata: { outcome: 'failed' },
        },
    ));
}
