/**
 * One implementation of "this job cannot run yet, delay it on the same BullMQ
 * job" for every capacity kind: repository workflow capacity
 * (`limits.max_parallel_tasks`) and per-agent capacity
 * (`PROPR_AGENT_RUN_ALIAS_LIMITS`). The kinds differ only in their job-data
 * fields, reason text and timeline metadata.
 *
 * A deferral is `job.moveToDelayed` followed by `DelayedError`: BullMQ keeps
 * `attemptsMade` unchanged, so a wait never consumes the job's failure budget.
 *
 * This module imports no values from `@propr/core`: suites that mock that module
 * with a fixed export list load it through `repositoryWorkflow.ts`.
 */
// A namespace import: suites that mock `bullmq` with a fixed export list load this module too.
import * as bullmq from 'bullmq';
import type { WorkerStateManager } from '@propr/core';
import type { Logger } from 'pino';

export type CapacityKind = 'repository' | 'agent';

/** Job-data fields holding a wait's count and next retry time, per capacity kind. */
export const CAPACITY_DEFERRAL_FIELDS = {
    repository: { deferrals: 'repositoryWorkflowDeferrals', retryAt: 'repositoryWorkflowRetryAt' },
    agent: { deferrals: 'agentCapacityDeferrals', retryAt: 'agentCapacityRetryAt' },
} as const satisfies Record<CapacityKind, { deferrals: string; retryAt: string }>;

const DEFERRAL_BASE_MS = 10_000;
const DEFERRAL_MAX_MS = 300_000;

/** Exponential backoff with jitter so waiting jobs do not re-enter in lockstep. */
export function capacityDeferralDelayMs(deferrals: number, random: () => number = Math.random): number {
    const ceiling = Math.min(DEFERRAL_BASE_MS * 2 ** Math.max(0, Math.min(deferrals, 16) - 1), DEFERRAL_MAX_MS);
    return Math.round(ceiling / 2 + random() * ceiling / 2);
}

/** The next count and retry time; chosen once so the delayed job and the timeline agree. */
export function nextCapacityDeferral(previous: number | undefined, { now = Date.now(), random = Math.random }: { now?: number; random?: () => number } = {}): { deferrals: number; retryAt: number } {
    const deferrals = (previous ?? 0) + 1;
    return { deferrals, retryAt: now + capacityDeferralDelayMs(deferrals, random) };
}

/** Which capacity refused the job, if the error is a capacity refusal at all. */
export function capacityRefusalKind(error: unknown, isRepositoryRefusal: (error: unknown) => boolean): CapacityKind | null {
    if (isRepositoryRefusal(error)) return 'repository';
    const name = (error as { name?: unknown } | null)?.name;
    // By name: this module must not load `@propr/core` values (see above).
    return name === 'AgentCapacityError' ? 'agent' : null;
}

const ENDED_STATES = ['cancelled', 'failed', 'completed'];

/**
 * Explain a silent capacity wait on the task timeline without changing its
 * state: one waiting row per wait, updated in place (count and retry time) on
 * every later refusal. Best effort: a timeline write must never prevent the job
 * from being delayed, and a task that changed meanwhile (cancelled, admitted
 * elsewhere) is left untouched.
 */
export async function recordCapacityDeferral(options: {
    kind: CapacityKind; stateManager: WorkerStateManager; taskId: string; correlatedLogger: Logger;
    deferrals: number; retryAt: number; reason: string; metadata?: Record<string, unknown>;
}): Promise<void> {
    const { kind, stateManager, taskId, correlatedLogger } = options;
    const fields = CAPACITY_DEFERRAL_FIELDS[kind];
    try {
        const current = await stateManager.getTaskState(taskId);
        if (!current || ENDED_STATES.includes(current.state)) return;
        const historyMetadata = { ...options.metadata, [fields.deferrals]: options.deferrals, [fields.retryAt]: new Date(options.retryAt).toISOString() };
        const latest = current.history?.at(-1);
        if (latest?.state === current.state && latest.metadata?.[fields.deferrals]) {
            await stateManager.updateHistoryMetadata(taskId, current.state, historyMetadata);
            return;
        }
        await stateManager.updateTaskStateIfCurrent(taskId, {
            state: current.state, createdAt: current.createdAt, updatedAt: current.updatedAt, correlationId: current.correlationId, version: current.version,
        }, current.state, { reason: options.reason, historyMetadata });
    } catch (error) {
        correlatedLogger.warn({ taskId, kind, error: (error as Error).message }, 'Failed to record capacity wait');
    }
}

type DeferrableJob = { moveToDelayed(timestamp: number, token?: string): Promise<void>; token?: string; data?: object };

/** Delay the same job until the retry time its processor persisted for this capacity kind. */
export async function moveCapacityRefusalToDelayed(job: DeferrableJob, kind: CapacityKind): Promise<void> {
    const fields = CAPACITY_DEFERRAL_FIELDS[kind];
    const data = job.data as Record<string, unknown> | undefined;
    const retryAt = data?.[fields.retryAt] as number | undefined;
    const deferrals = (data?.[fields.deferrals] as number | undefined) ?? 1;
    await job.moveToDelayed(retryAt && retryAt > Date.now() ? retryAt : Date.now() + capacityDeferralDelayMs(deferrals), job.token);
}

/**
 * Delay only after the processor has unwound its locks and durable claims: a
 * capacity refusal thrown by `execute` (with its deferral already persisted)
 * moves the same job to delayed and ends this attempt with DelayedError.
 */
export async function deferOnCapacityRefusal<T>(job: DeferrableJob, execute: () => Promise<T>, isRepositoryRefusal: (error: unknown) => boolean = () => false): Promise<T> {
    try {
        return await execute();
    } catch (error) {
        const kind = capacityRefusalKind(error, isRepositoryRefusal);
        if (!kind) throw error;
        await moveCapacityRefusalToDelayed(job, kind);
        throw new bullmq.DelayedError();
    }
}
