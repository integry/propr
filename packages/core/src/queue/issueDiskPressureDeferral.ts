/**
 * Issue jobs refused at worker admission for disk pressure.
 *
 * `StorageLifecycle.admit` refuses a job (`WorktreeDiskPressureError`) when the
 * disk that holds working copies is nearly full. The refused attempt never
 * reaches its processor, and the host frees space by itself (worktree sweeps,
 * finished tasks), so for an issue job the refusal is a wait, not a failure:
 * the same job is delayed on a backoff measured in minutes, without consuming
 * its attempt budget, until space returns or the total wait
 * (`WORKTREE_DISK_PRESSURE_MAX_WAIT_MS`) runs out. Only then does the job fail
 * for good, and the queue's failure handler reports it on the issue
 * (`issueDiskPressureRefusal.ts`). The issue's dispatch row (`issueDispatch.ts`)
 * follows: queued → deferred at a refusal, deferred → queued when the job is
 * picked up again, and → processing, with `started_at`, once an attempt is admitted.
 *
 * A deferral is `job.moveToDelayed` followed by `DelayedError`, as for the
 * capacity waits: BullMQ keeps `attemptsMade` unchanged.
 */
// A namespace import: suites that mock `bullmq` with a fixed export list load this module too.
import * as bullmq from 'bullmq';
import { isWorktreeDiskPressureError, worktreeDiskPressureDetails, worktreeDiskPressureLogFields, worktreeDiskPressureMeasurementOf } from '../storage/lifecycle.js';
import logger from '../utils/logger.js';

/** Loaded only for jobs that have a dispatch row: importing the database opens it, which keeps importers' processes alive. */
const dispatchRows = () => import('./issueDispatch.js');

export const ISSUE_JOB_NAME = 'processGitHubIssue';

/** Job-data fields of an issue job's disk-pressure wait. */
export interface IssueDiskPressureWaitData {
    /** Admission refusals so far in this wait. */
    diskPressureDeferrals?: number;
    /** Epoch ms of the first refusal of this wait. */
    diskPressureSince?: number;
    /** Epoch ms of the next attempt. */
    diskPressureRetryAt?: number;
    /** What admission measured at the latest refusal, in words (`formatWorktreeDiskPressure`). */
    diskPressureDetails?: string;
}

const MINUTE_MS = 60_000;

/** Wait before each retry: 2, 5, 10, then every 20 minutes, until the total wait runs out. */
export const ISSUE_DISK_PRESSURE_RETRY_DELAYS_MS: readonly number[] = [2, 5, 10, 20].map(minutes => minutes * MINUTE_MS);

export const DEFAULT_ISSUE_DISK_PRESSURE_MAX_WAIT_MS = 60 * MINUTE_MS;

/** A last retry closer than this to the end of the wait is not worth scheduling. */
const MIN_RETRY_DELAY_MS = MINUTE_MS;

/**
 * `WORKTREE_DISK_PRESSURE_MAX_WAIT_MS`: total wait for disk space. 0 disables waiting: a refusal then fails
 * the attempt and uses the job's normal retries. Invalid values use the default.
 */
export function issueDiskPressureMaxWaitMs(env: NodeJS.ProcessEnv = process.env): number {
    const raw = env.WORKTREE_DISK_PRESSURE_MAX_WAIT_MS;
    if (raw === undefined || raw.trim() === '') return DEFAULT_ISSUE_DISK_PRESSURE_MAX_WAIT_MS;
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < 0) {
        logger.warn({ value: raw }, 'Invalid WORKTREE_DISK_PRESSURE_MAX_WAIT_MS; using the default');
        return DEFAULT_ISSUE_DISK_PRESSURE_MAX_WAIT_MS;
    }
    return value;
}

export type IssueDiskPressureDecision =
    | { action: 'defer'; deferrals: number; since: number; retryAt: number; delayMs: number }
    | { action: 'exhausted'; deferrals: number; since: number; waitedMs: number };

/** What one more refusal at `now` means for a job whose wait so far is `data`. */
export function decideIssueDiskPressure(
    data: IssueDiskPressureWaitData | undefined,
    { now = Date.now(), maxWaitMs = issueDiskPressureMaxWaitMs() }: { now?: number; maxWaitMs?: number } = {},
): IssueDiskPressureDecision {
    const previous = data?.diskPressureDeferrals ?? 0;
    const since = data?.diskPressureSince ?? now;
    const waitedMs = Math.max(0, now - since);
    const remaining = maxWaitMs - waitedMs;
    const scheduled = ISSUE_DISK_PRESSURE_RETRY_DELAYS_MS[Math.min(previous, ISSUE_DISK_PRESSURE_RETRY_DELAYS_MS.length - 1)];
    const delayMs = Math.min(scheduled, remaining);
    if (delayMs < Math.min(MIN_RETRY_DELAY_MS, scheduled)) return { action: 'exhausted', deferrals: previous, since, waitedMs };
    return { action: 'defer', deferrals: previous + 1, since, retryAt: now + delayMs, delayMs };
}

/** The message of the final refusal; it keeps the admission prefix, so `isWorktreeDiskPressureError` still recognises it. */
export function exhaustedIssueDiskPressureMessage(waitedMs: number, deferrals: number, details?: string | null): string {
    const minutes = Math.round(waitedMs / MINUTE_MS);
    return `Worktree disk pressure: admission reserve unavailable after waiting ${minutes} minute${minutes === 1 ? '' : 's'} `
        + `(${deferrals + 1} refusal${deferrals === 0 ? '' : 's'}); data retained${details ? ` (${details})` : ''}`;
}

interface DeferrableIssueJob {
    id?: string;
    name: string;
    data: unknown;
    token?: string;
    moveToDelayed(timestamp: number, token?: string): Promise<void>;
    updateData(data: unknown): Promise<void>;
}

/**
 * Run `execute` (worker admission plus the processor). An issue job refused at
 * admission for disk pressure is delayed on the same BullMQ job, or failed for
 * good, without retries, once the wait runs out. Every other outcome is
 * returned or thrown unchanged.
 */
export async function deferIssueJobOnDiskPressure<T>(
    job: DeferrableIssueJob | undefined,
    execute: () => Promise<T>,
    options: { now?: () => number; maxWaitMs?: number } = {},
): Promise<T> {
    try {
        return await execute();
    } catch (error) {
        if (job?.name !== ISSUE_JOB_NAME || !isWorktreeDiskPressureError(error) || !job.token) throw error;
        const maxWaitMs = options.maxWaitMs ?? issueDiskPressureMaxWaitMs();
        // Waiting disabled: the refusal fails the attempt, as any other error does.
        if (maxWaitMs === 0) throw error;
        const data = (job.data ?? {}) as IssueJobDataWithWait;
        const decision = decideIssueDiskPressure(data, { now: options.now?.() ?? Date.now(), maxWaitMs });
        const log = typeof data.correlationId === 'string' ? logger.withCorrelation(data.correlationId) : logger;
        const target = { jobId: job.id, repository: `${data.repoOwner}/${data.repoName}`, issueNumber: data.number };
        const details = worktreeDiskPressureDetails(error);
        const measured = worktreeDiskPressureLogFields(error);
        if (decision.action === 'exhausted') {
            log.error({ ...target, ...measured, refusals: decision.deferrals + 1, waitedMs: decision.waitedMs },
                `Issue job refused for disk pressure: the wait for free disk space ran out${details ? ` (${details})` : ''}`);
            const Unrecoverable = bullmq.UnrecoverableError;
            const message = exhaustedIssueDiskPressureMessage(decision.waitedMs, decision.deferrals, details);
            const final = Unrecoverable
                ? new Unrecoverable(message)
                // Recognised by name by BullMQ, so the job is not retried.
                : Object.assign(new Error(message), { name: 'UnrecoverableError' });
            const measurement = worktreeDiskPressureMeasurementOf(error);
            if (measurement) Object.assign(final, { measurement });
            throw final;
        }
        const next: IssueJobDataWithWait = {
            ...data, diskPressureDeferrals: decision.deferrals, diskPressureSince: decision.since, diskPressureRetryAt: decision.retryAt,
            ...(details ? { diskPressureDetails: details } : {}),
        };
        await job.updateData(next);
        await job.moveToDelayed(decision.retryAt, job.token);
        await recordDeferral(data, decision.retryAt, details, (fields, msg) => log.warn({ ...target, ...fields }, msg));
        log.warn({ ...target, ...measured, refusals: decision.deferrals, retryAt: new Date(decision.retryAt).toISOString(), delayMs: decision.delayMs },
            `Issue job refused for disk pressure: waiting for free disk space${details ? ` (${details})` : ''}`);
        const Delayed = bullmq.DelayedError;
        if (Delayed) throw new Delayed();
        throw Object.assign(new Error('bullmq:movedToDelayed'), { name: 'DelayedError' });
    }
}

/** The dispatch row of a top-level job moves to deferred. Best effort: the wait itself is on the job. */
async function recordDeferral(data: unknown, retryAt: number, details: string | null, warn: (fields: object, msg: string) => void): Promise<void> {
    const dispatchId = topLevelDispatchId(data);
    if (!dispatchId) return;
    await dispatchRows().then(rows => rows.markIssueDispatchDeferred(dispatchId, { retryAt, details }))
        .catch(error => warn({ dispatchId, error: (error as Error).message }, 'Could not record the deferral on the issue dispatch'));
}

/** The dispatch a top-level issue job runs for; children share it but do not move it. */
export function topLevelDispatchId(data: unknown): string | null {
    const value = data as { isChildJob?: unknown; issueDispatchId?: unknown } | undefined;
    return !value?.isChildJob && typeof value?.issueDispatchId === 'string' && value.issueDispatchId ? value.issueDispatchId : null;
}

/** An issue job was picked up: a deferred dispatch is queued again until admission decides. Best effort. */
export async function beginIssueJobAttempt(job: Pick<DeferrableIssueJob, 'id' | 'data'>): Promise<void> {
    const dispatchId = topLevelDispatchId(job.data);
    if (!dispatchId) return;
    await dispatchRows().then(rows => rows.markIssueDispatchAttempt(dispatchId))
        .catch(error => logger.warn({ jobId: job.id, dispatchId, error: (error as Error).message }, 'Could not record the attempt on the issue dispatch'));
}

/**
 * Admission passed: the processor is about to run. Records it on the
 * dispatch (`started_at`, the evidence a later refusal report relies on), so
 * a failed write fails the attempt before the processor runs (an ordinary,
 * retryable failure). Also drops a disk-pressure wait the job went through,
 * so a later refusal starts a new wait.
 */
export async function recordIssueJobAdmitted(job: Pick<DeferrableIssueJob, 'id' | 'data' | 'updateData'>): Promise<void> {
    const dispatchId = topLevelDispatchId(job.data);
    if (dispatchId) await (await dispatchRows()).markIssueDispatchStarted(dispatchId);
    const data = (job.data ?? {}) as IssueJobDataWithWait;
    const waitFields = new Set(['diskPressureDeferrals', 'diskPressureSince', 'diskPressureRetryAt', 'diskPressureDetails']);
    if (!Object.keys(data).some(key => waitFields.has(key))) return;
    await job.updateData(Object.fromEntries(Object.entries(data).filter(([key]) => !waitFields.has(key))));
}

type IssueJobDataWithWait = IssueDiskPressureWaitData & { correlationId?: unknown; repoOwner?: unknown; repoName?: unknown; number?: unknown; [key: string]: unknown };

/** Whether a failed issue job ended for good (no BullMQ retry follows). */
export function isFinalJobFailure(job: { attemptsMade: number; finishedOn?: number; opts?: { attempts?: number } }, error: Error): boolean {
    return error.name === 'UnrecoverableError' || typeof job.finishedOn === 'number' || job.attemptsMade >= (job.opts?.attempts ?? 1);
}
