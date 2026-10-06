import type { Logger } from 'pino';
import type { LineageAttempt } from '../taskReplacement/store.js';

/**
 * Replacement attempts for issue runs that end with a transient provider error.
 *
 * The replacement module is loaded lazily: it pulls in the queue, GitHub and
 * settings wiring, which job modules otherwise do not need. A failure to load
 * or run it never changes how the failed run itself is reported.
 */
export interface ProviderFailure {
    taskId?: string;
    error: unknown;
    /**
     * Whether the error came from the coding agent's execution (its result or an
     * error it threw). GitHub, git and other job failures are never replaced,
     * whatever their status: the provider may already have completed the run.
     */
    fromAgentExecution: boolean;
    /** Agent termination reason (timeout, max turns); such runs are never replaced. */
    terminationReason?: string | null;
    terminalReason?: string | null;
    correlatedLogger: Pick<Logger, 'warn'>;
}

const agentExecutionFailures = new WeakSet<object>();

/** Tags an error thrown by the coding agent's own execution, so the job's error handler can tell it from GitHub or git failures. */
export function markAgentExecutionFailure<T>(error: T): T {
    if (error && typeof error === 'object') agentExecutionFailures.add(error);
    return error;
}

export function isAgentExecutionFailure(error: unknown): boolean {
    return !!error && typeof error === 'object' && agentExecutionFailures.has(error);
}

async function loadReplacement() {
    const module = await import('../taskReplacement/index.js');
    return { service: module.getTaskReplacementService(), isTransient: module.isTransientProviderError };
}

function failureText(error: unknown): string {
    if (typeof error === 'string') return error;
    return error instanceof Error ? error.message : String((error as { message?: unknown })?.message ?? '');
}

function markCurrentFailed(lineage: LineageAttempt[], taskId: string): LineageAttempt[] {
    return lineage.map(attempt => attempt.taskId === taskId ? { ...attempt, state: 'failed' } : attempt);
}

/**
 * Call before the failure comment and the failed state are published. Records
 * whether a replacement will follow (so the Inbox holds back the failure alert)
 * and returns a section for the failure comment: the retry notice, or the
 * lineage's attempts when this is the final failure of a replaced task.
 */
export async function prepareProviderReplacement(failure: ProviderFailure): Promise<string> {
    if (!failure.taskId) return '';
    try {
        const { service, isTransient } = await loadReplacement();
        let lineage: LineageAttempt[];
        if (failure.fromAgentExecution && isTransient(failure.error, failure.terminationReason)) {
            const evaluation = await service.prepare({
                taskId: failure.taskId, cause: 'provider_transient', terminalReason: failure.terminalReason ?? null,
            });
            if (evaluation.eligible) {
                return `\n\n🔁 **Retrying automatically.** This run ended with a transient provider error, so replacement attempt ${evaluation.attemptNumber} `
                    + `(up to ${evaluation.maxReplacements} replacement${evaluation.maxReplacements === 1 ? '' : 's'}) will start with the same agent and model.`;
            }
            lineage = evaluation.reason === null ? [] : evaluation.lineage;
        } else {
            lineage = await service.lineage(failure.taskId);
        }
        return lineage.length > 1
            ? `\n\n**Attempts:**\n${service.formatAttempts(markCurrentFailed(lineage, failure.taskId))}`
            : '';
    } catch (error) {
        failure.correlatedLogger.warn({ taskId: failure.taskId, error: (error as Error).message }, 'Failed to evaluate a provider replacement');
        return '';
    }
}

/** Call after the task was marked failed: dispatches the replacement or records why there is none. */
export async function completeProviderReplacement(failure: ProviderFailure): Promise<void> {
    if (!failure.taskId) return;
    try {
        const { service, isTransient } = await loadReplacement();
        if (!failure.fromAgentExecution || !isTransient(failure.error, failure.terminationReason)) return;
        await service.complete({
            taskId: failure.taskId,
            cause: 'provider_transient',
            terminalReason: failure.terminalReason ?? null,
            error: failureText(failure.error),
        });
    } catch (error) {
        failure.correlatedLogger.warn({ taskId: failure.taskId, error: (error as Error).message }, 'Failed to dispatch a provider replacement');
    }
}
