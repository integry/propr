import type {
    TaskStateData,
    findTaskContainer,
    inspectLegacyDockerContainerLivenessForTask,
    stopDockerContainer,
    WorkerStateManager,
} from '@propr/core';

export interface ReconciliationJob {
    getState(): Promise<string>;
    returnvalue?: unknown;
    failedReason?: string;
}

export interface ReconciliationQueue {
    getJob(jobId: string): Promise<ReconciliationJob | undefined>;
    toKey(type: string): string;
}

export interface ReconciliationRedis {
    eval(script: string, numberOfKeys: number, ...args: Array<string | number>): Promise<unknown>;
    pttl(key: string): Promise<number>;
    /** Optional for compatibility with embedded reconcilers predating remote-outcome checkpoints. */
    get?(key: string): Promise<string | null>;
}

export type ReconciliationStateManager = Pick<
    WorkerStateManager,
    'getNonTerminalTaskPage' | 'getTaskState' | 'updateTaskStateIfCurrent'
>;

export interface TaskReconciliationSummary {
    scanned: number;
    fresh: number;
    live: number;
    queued: number;
    finalized: number;
    interrupted: number;
    containersStopped: number;
    locksCleared: number;
    errors: number;
}

export interface TaskReconciliationOptions {
    stateManager: ReconciliationStateManager;
    queue: ReconciliationQueue;
    redis: ReconciliationRedis;
    staleAfterMs?: number;
    now?: () => number;
    findRunningContainer?: typeof findTaskContainer;
    inspectLegacyContainerLiveness?: typeof inspectLegacyDockerContainerLivenessForTask;
    stopContainer?: typeof stopDockerContainer;
    signal?: AbortSignal;
    batchSize?: number;
    concurrency?: number;
    /** Maximum wall-clock time in which new reconciliation batches may start. */
    timeBudgetMs?: number;
    futureSkewAllowanceMs?: number;
}

export interface ReconciliationContext {
    options: TaskReconciliationOptions;
    summary: TaskReconciliationSummary;
    findRunningContainer: typeof findTaskContainer;
    inspectLegacyContainerLiveness: typeof inspectLegacyDockerContainerLivenessForTask;
    stopContainer: typeof stopDockerContainer;
}

export const DEFAULT_TASK_RECONCILIATION_STALE_MS = 90 * 1000;
export const DEFAULT_TASK_RECONCILIATION_BATCH_SIZE = 100;
export const DEFAULT_TASK_RECONCILIATION_CONCURRENCY = 4;
export const DEFAULT_TASK_RECONCILIATION_TIME_BUDGET_MS = 30 * 1000;
export const DEFAULT_TASK_FUTURE_SKEW_ALLOWANCE_MS = 5 * 60 * 1000;

export function createTaskReconciliationSummary(): TaskReconciliationSummary {
    return {
        scanned: 0,
        fresh: 0,
        live: 0,
        queued: 0,
        finalized: 0,
        interrupted: 0,
        containersStopped: 0,
        locksCleared: 0,
        errors: 0,
    };
}

export function throwIfAborted(signal?: AbortSignal): void {
    signal?.throwIfAborted();
}

export function taskMatchesExpectation(
    current: TaskStateData | null,
    scanned: TaskStateData,
): boolean {
    if (!current) return false;
    return current.state === scanned.state
        && current.updatedAt === scanned.updatedAt
        && current.version === scanned.version
        && current.prProcessingLockToken === scanned.prProcessingLockToken;
}
