import { DelayedError, Job, Queue, UnrecoverableError } from 'bullmq';
import {
    loadRepositoryWorkflow, loadSettings, WORKFLOW_MAX_BYTES, WORKFLOW_PATH,
    executeWithRepositoryWorkflow, withRepositoryWorkflowSlot, releaseRepositoryWorkflowSlot, reconcileRepositoryWorkflowSlot, forgetRepositoryWorkflowWaiter, RepositoryWorkflowCapacityError, RepositoryWorkflowLeaseLostError, TaskStates,
    RepositoryWorkflowPolicyError, withRetry, retryConfigs,
} from '@propr/core';
import type { getAuthenticatedOctokit, ResolvedRepositoryWorkflow, WorkerStateManager, AgentExecutionResult, IssueJobData } from '@propr/core';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import { runWithNetworkPolicy } from './networkEgress.js';

type Octokit = Awaited<ReturnType<typeof getAuthenticatedOctokit>>;
type RepositoryWorkflowDeferralData = Pick<IssueJobData, 'repositoryWorkflow' | 'repositoryWorkflowBaseBranch' | 'repositoryWorkflowDeferrals' | 'repositoryWorkflowRetryAt'>;

// A blob's absence at an immutable commit never changes, so repositories without
// a workflow file skip the contents lookup for jobs sharing a base commit.
const ABSENT_WORKFLOW_CACHE_TTL_MS = 10 * 60_000;
const ABSENT_WORKFLOW_CACHE_MAX_ENTRIES = 1_000;
const absentWorkflowRevisions = new Map<string, number>();

function absentWorkflowKey(owner: string, repo: string, revision: string): string {
    return `${owner}/${repo}`.toLowerCase() + `@${revision}`;
}
function isKnownAbsentWorkflow(key: string): boolean {
    const expiresAt = absentWorkflowRevisions.get(key);
    if (expiresAt === undefined) return false;
    if (expiresAt > Date.now()) return true;
    absentWorkflowRevisions.delete(key);
    return false;
}
function rememberAbsentWorkflow(key: string): void {
    absentWorkflowRevisions.delete(key);
    absentWorkflowRevisions.set(key, Date.now() + ABSENT_WORKFLOW_CACHE_TTL_MS);
    // Map iteration follows insertion order, so the first key is the oldest entry.
    if (absentWorkflowRevisions.size > ABSENT_WORKFLOW_CACHE_MAX_ENTRIES) absentWorkflowRevisions.delete(absentWorkflowRevisions.keys().next().value!);
}
/** Test hook: forget cached absent-workflow lookups. */
export function clearAbsentRepositoryWorkflowCache(): void {
    absentWorkflowRevisions.clear();
}

/** GitHub reports a repository without any commit as 409 "Git Repository is empty." */
function isEmptyRepositoryError(error: unknown): boolean {
    const { status, message, response } = (error ?? {}) as { status?: number; message?: string; response?: { data?: { message?: string } } };
    return status === 409 && /repository is empty/i.test(`${response?.data?.message ?? ''} ${message ?? ''}`);
}

/** Instance `worker_concurrency`, falling back like the worker does when the setting is unusable. */
function instanceWorkerConcurrency(setting: unknown): number {
    for (const value of [setting, process.env.WORKER_CONCURRENCY]) {
        const parsed = typeof value === 'string' && value.trim() ? Number(value) : value;
        if (Number.isSafeInteger(parsed) && (parsed as number) > 0) return parsed as number;
    }
    return 5;
}

export async function prepareRepositoryWorkflow(options: {
    octokit: Octokit; repoOwner: string; repoName: string; baseBranch?: string | null;
    /** Known default branch (e.g. from the dispatched repository payload) to avoid a repository lookup. */
    defaultBranch?: string | null;
    correlationId?: string;
}): Promise<ResolvedRepositoryWorkflow | undefined> {
    const { octokit, repoOwner: owner, repoName: repo, correlationId } = options;
    // Transient GitHub failures must not fail runs that, without a workflow, never needed these reads.
    const request = <T>(context: string, fn: () => Promise<T>) => withRetry(fn, { ...retryConfigs.githubApi, correlationId }, context);
    const defaultBranch = async () => options.defaultBranch
        || (await request('get_repository_default_branch', () => octokit.request('GET /repos/{owner}/{repo}', { owner, repo }))).data.default_branch;
    const resolveRevision = async (ref: string) => (await request('resolve_workflow_base_revision', () => octokit.request('GET /repos/{owner}/{repo}/commits/{ref}', { owner, repo, ref }))).data.sha;
    let baseBranch = options.baseBranch || await defaultBranch();
    let revision: string;
    try {
        try {
            revision = await resolveRevision(baseBranch);
        } catch (error) {
            // Worktree creation falls back to the default branch when the requested base
            // does not exist yet (e.g. an epic branch created when its first child PR is
            // opened). Read the policy from the same commit the task will start from.
            if (!options.baseBranch || (error as { status?: number }).status !== 404) throw error;
            baseBranch = await defaultBranch();
            revision = await resolveRevision(baseBranch);
        }
    } catch (error) {
        // A repository without commits has no workflow file; repository cloning
        // creates its initial contents, so the task proceeds without a policy.
        if (isEmptyRepositoryError(error)) return undefined;
        throw error;
    }
    const absentKey = absentWorkflowKey(owner, repo, revision);
    if (isKnownAbsentWorkflow(absentKey)) return undefined;
    const settings = await loadSettings();
    const workflow = await loadRepositoryWorkflow({
        resolveRevision: async () => revision,
        readFile: async (path, ref) => {
            let response;
            try {
                response = await request('read_repository_workflow_file', () => octokit.request('GET /repos/{owner}/{repo}/contents/{path}', { owner, repo, path, ref }));
            } catch (error) {
                if ((error as { status?: number }).status === 404) return null;
                throw error;
            }
            const file = response.data;
            if (Array.isArray(file) || file.type !== 'file' || !('content' in file) || file.encoding !== 'base64' || file.size > WORKFLOW_MAX_BYTES) {
                throw new RepositoryWorkflowPolicyError(`Invalid .propr/workflow.yml: ${path} must be a regular UTF-8 file of at most 128 KiB`);
            }
            const bytes = Buffer.from(file.content, 'base64');
            try {
                const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
                return { content, sha: file.sha };
            } catch {
                throw new RepositoryWorkflowPolicyError(`Invalid .propr/workflow.yml: ${path} must contain valid UTF-8 text`);
            }
        },
    }, baseBranch, {
        maxParallelTasks: instanceWorkerConcurrency(settings?.worker_concurrency),
    });
    if (!workflow) rememberAbsentWorkflow(absentKey);
    return workflow;
}

/** Timeline metadata for the PROCESSING transition made after admission. */
export function repositoryWorkflowHistoryMetadata(workflow?: ResolvedRepositoryWorkflow): Record<string, unknown> {
    if (!workflow) return {};
    return { repositoryWorkflow: { path: WORKFLOW_PATH, baseBranch: workflow.baseBranch, revision: workflow.revision, fileRevision: workflow.fileRevision,
        maxParallelTasks: workflow.maxParallelTasks, timeoutMs: workflow.timeoutMs } };
}

/**
 * Reuse the policy resolved before an earlier capacity refusal without calling
 * GitHub again, unless the task's known base branch has since changed.
 */
export async function resolveRepositoryWorkflow(
    data: RepositoryWorkflowDeferralData, baseBranch: string | null | undefined, prepare: () => Promise<ResolvedRepositoryWorkflow | undefined>,
): Promise<ResolvedRepositoryWorkflow | undefined> {
    const cached = data.repositoryWorkflowDeferrals ? data.repositoryWorkflow : undefined;
    // A policy read from the default branch because the requested base did not exist yet
    // is keyed by the requested branch it was resolved for.
    if (cached && (!baseBranch || cached.baseBranch === baseBranch || data.repositoryWorkflowBaseBranch === baseBranch)) return cached;
    // An absent policy is only known for the branch it was read from; a snapshot without one predates retarget tracking.
    if (cached === null && data.repositoryWorkflowBaseBranch !== undefined && data.repositoryWorkflowBaseBranch === (baseBranch ?? null)) return undefined;
    return prepare();
}

/**
 * Resolves this attempt's policy. `admitted` ends a capacity wait (ordinary retries
 * then read the base policy again) and returns the policy to run: a snapshot reused
 * from an earlier refusal can be many deferrals old, so it is read again.
 */
export async function resolveAttemptRepositoryWorkflow<T extends RepositoryWorkflowDeferralData>(
    data: T, baseBranch: string | null | undefined, prepare: () => Promise<ResolvedRepositoryWorkflow | undefined>,
): Promise<{ workflow?: ResolvedRepositoryWorkflow; admitted(job: { data: T; updateData(data: T): Promise<unknown> }): Promise<ResolvedRepositoryWorkflow | undefined> }> {
    let readThisAttempt = false;
    const workflow = await resolveRepositoryWorkflow(data, baseBranch, () => { readThisAttempt = true; return prepare(); });
    return {
        workflow,
        async admitted(job) {
            await job.updateData({ ...job.data, ...CLEARED_REPOSITORY_WORKFLOW_DEFERRAL });
            return readThisAttempt ? workflow : prepare();
        },
    };
}

type RepositoryWorkflowDeferral = RepositoryWorkflowDeferralData & { repositoryWorkflowDeferrals: number; repositoryWorkflowRetryAt: number };

/**
 * Persist with the deferral so re-entry can attempt admission before any policy request.
 * The retry time is chosen here so the delayed job and the task timeline agree on it.
 */
export function repositoryWorkflowDeferralData(
    data: RepositoryWorkflowDeferralData, workflow: ResolvedRepositoryWorkflow | undefined, baseBranch: string | null | undefined,
    { now = Date.now(), random = Math.random }: { now?: number; random?: () => number } = {},
): RepositoryWorkflowDeferral {
    const deferrals = (data.repositoryWorkflowDeferrals ?? 0) + 1;
    return { repositoryWorkflow: workflow ?? null, repositoryWorkflowBaseBranch: baseBranch ?? workflow?.baseBranch ?? null,
        repositoryWorkflowDeferrals: deferrals, repositoryWorkflowRetryAt: now + repositoryWorkflowDeferralDelayMs(deferrals, random) };
}

/** Admission ends the wait; ordinary retries must read the base branch policy again. */
export const CLEARED_REPOSITORY_WORKFLOW_DEFERRAL: RepositoryWorkflowDeferralData = {
    repositoryWorkflow: undefined, repositoryWorkflowBaseBranch: undefined, repositoryWorkflowDeferrals: undefined, repositoryWorkflowRetryAt: undefined,
};

/**
 * Explain a silent capacity wait on the task timeline without changing its state.
 * Best effort: a timeline write must never prevent the job from being delayed, and
 * a task that changed meanwhile (cancelled, admitted elsewhere) is left untouched.
 */
export async function recordRepositoryWorkflowDeferral(options: {
    stateManager: WorkerStateManager; taskId: string; correlatedLogger: Logger;
    deferral: Pick<RepositoryWorkflowDeferral, 'repositoryWorkflowDeferrals' | 'repositoryWorkflowRetryAt'>;
    workflow?: ResolvedRepositoryWorkflow;
}): Promise<void> {
    const { stateManager, taskId, correlatedLogger, deferral, workflow } = options;
    try {
        const current = await stateManager.getTaskState(taskId);
        if (!current || ([TaskStates.CANCELLED, TaskStates.FAILED, TaskStates.COMPLETED] as string[]).includes(current.state)) return;
        const limit = workflow?.maxParallelTasks ? ` (limit ${workflow.maxParallelTasks})` : '';
        const historyMetadata = {
            repositoryWorkflowDeferrals: deferral.repositoryWorkflowDeferrals,
            repositoryWorkflowRetryAt: new Date(deferral.repositoryWorkflowRetryAt).toISOString(),
        };
        // One waiting row per wait: a later refusal updates its count and retry time
        // instead of appending another row for every backoff cycle.
        const latest = current.history?.at(-1);
        if (latest?.state === current.state && latest.metadata?.repositoryWorkflowDeferrals) {
            await stateManager.updateHistoryMetadata(taskId, current.state, historyMetadata);
            return;
        }
        await stateManager.updateTaskStateIfCurrent(taskId, {
            state: current.state, createdAt: current.createdAt, updatedAt: current.updatedAt, correlationId: current.correlationId, version: current.version,
        }, current.state, { reason: `Waiting for repository workflow capacity${limit}`, historyMetadata });
    } catch (error) {
        correlatedLogger.warn({ taskId, error: (error as Error).message }, 'Failed to record repository workflow capacity wait');
    }
}

/**
 * Durably store a capacity refusal on the same job, then explain the wait on the
 * timeline. A refusal that cannot be stored ends this attempt through
 * `onPersistFailure` instead of leaving the task pending without a scheduled retry.
 */
export async function persistRepositoryWorkflowDeferral<T extends RepositoryWorkflowDeferralData>(options: {
    job: { data: T; updateData(data: T): Promise<unknown> };
    workflow: ResolvedRepositoryWorkflow | undefined; baseBranch: string | null | undefined; extraData?: Partial<T>;
    stateManager: WorkerStateManager; taskId: string; correlatedLogger: Logger;
    onPersistFailure(error: Error): Promise<void>;
}): Promise<void> {
    const { job, workflow, stateManager, taskId, correlatedLogger } = options;
    const deferral = repositoryWorkflowDeferralData(job.data, workflow, options.baseBranch);
    try {
        await job.updateData({ ...job.data, ...options.extraData, ...deferral });
    } catch (error) {
        await options.onPersistFailure(error as Error);
        throw error;
    }
    await recordRepositoryWorkflowDeferral({ stateManager, taskId, correlatedLogger, deferral, workflow });
}

const DEFERRAL_BASE_MS = 10_000;
const DEFERRAL_MAX_MS = 300_000;

/** Exponential backoff with jitter so waiting jobs do not re-enter in lockstep. */
export function repositoryWorkflowDeferralDelayMs(deferrals: number, random: () => number = Math.random): number {
    const ceiling = Math.min(DEFERRAL_BASE_MS * 2 ** Math.max(0, Math.min(deferrals, 16) - 1), DEFERRAL_MAX_MS);
    return Math.round(ceiling / 2 + random() * ceiling / 2);
}

async function checkWorkflowTaskActive(options: { taskId: string; stateManager: WorkerStateManager }): Promise<void> {
    const state = await options.stateManager.getTaskState(options.taskId);
    if (state && ([TaskStates.CANCELLED, TaskStates.FAILED, TaskStates.COMPLETED] as string[]).includes(state.state)) {
        throw new Error('Task ended while waiting for repository workflow capacity');
    }
}

const waiterQueues = new Map<string, Queue>();

/**
 * Wake up to `free` capacity waiters, oldest first, by promoting their delayed
 * jobs, so a released slot goes to the longest-waiting task rather than to
 * whichever job re-enters first. Best effort: a waiter that is not delayed right
 * now is re-entering anyway, and one whose job no longer exists leaves the list
 * without using up the wakeup.
 */
export async function wakeRepositoryWorkflowWaiters(
    redisClient: Redis, repository: string, released: { waiters: string[]; free: number }, correlatedLogger: Logger,
): Promise<void> {
    let woken = 0;
    for (const waiter of released.waiters) {
        if (woken >= released.free) return;
        try {
            const [queueName, jobId] = JSON.parse(waiter) as [string, string];
            let queue = waiterQueues.get(queueName);
            if (!queue) waiterQueues.set(queueName, queue = new Queue(queueName, { connection: redisClient }));
            const job = await Job.fromId(queue, jobId);
            if (!job) { await forgetRepositoryWorkflowWaiter(redisClient, repository, waiter); continue; }
            woken++;
            if (await job.isDelayed()) await job.promote();
        } catch (error) {
            correlatedLogger.debug({ waiter, error: (error as Error).message }, 'Could not wake repository workflow capacity waiter');
        }
    }
}

export async function withRepositoryWorkflowAdmission<T>(options: {
    workflow?: ResolvedRepositoryWorkflow; repoOwner: string; repoName: string;
    redisClient: Redis; taskId: string; stateManager: WorkerStateManager; correlatedLogger: Logger;
    /** The queue job that is delayed when refused, so a released slot can wake it. */
    job?: Pick<Job, 'queueName' | 'id'>;
}, execute: () => Promise<T>): Promise<T> {
    const repository = `${options.repoOwner}/${options.repoName}`;
    const { job } = options;
    return withRepositoryWorkflowSlot({
        redis: options.redisClient, repository, limit: options.workflow?.maxParallelTasks,
        checkCancelled: () => checkWorkflowTaskActive(options),
        onLeaseError: error => options.correlatedLogger.error({ error }, 'Repository workflow capacity lease failed'),
        waiter: job?.queueName && job.id ? JSON.stringify([job.queueName, job.id]) : undefined,
        onReleased: (waiters, free) => void wakeRepositoryWorkflowWaiters(options.redisClient, repository, { waiters, free }, options.correlatedLogger),
    }, execute);
}

export { RepositoryWorkflowCapacityError, RepositoryWorkflowLeaseLostError };

/**
 * Admission used the policy saved when the task was refused. Once the admitted
 * execution has read its current policy again, that policy's cap must admit it as
 * well; otherwise the reservation is given up and RepositoryWorkflowCapacityError
 * defers the task with the refreshed policy, which callers must already have saved.
 * Returns that policy once admitted.
 */
export async function reconcileRepositoryWorkflowAdmission(workflow: ResolvedRepositoryWorkflow | undefined): Promise<ResolvedRepositoryWorkflow | undefined> {
    await reconcileRepositoryWorkflowSlot(workflow?.maxParallelTasks);
    return workflow;
}

/**
 * An unusable workflow file fails identically on every retry of the same base
 * commit, so the job fails once instead of re-reporting the same error per attempt.
 */
export function nonRetryableRepositoryWorkflowError(error: unknown): unknown {
    return error instanceof RepositoryWorkflowPolicyError ? new UnrecoverableError(error.message) : error;
}

/**
 * A lost capacity lease stops the container through the same ownership signal as a
 * user stop, but it is an operational failure and must never be reported as a cancellation.
 */
export function isUserCancellationError(error: unknown): boolean {
    if (error instanceof RepositoryWorkflowLeaseLostError) return false;
    const { message, name } = (error ?? {}) as Partial<Error>;
    return !!message?.includes('aborted by user') || name === 'ExecutionAbortedError';
}

/** Delay only after the processor has unwound its locks and durable claims. */
export async function deferRepositoryWorkflowJob<T>(job: Pick<Job<RepositoryWorkflowDeferralData>, 'moveToDelayed' | 'token'> & { data?: RepositoryWorkflowDeferralData }, execute: () => Promise<T>): Promise<T> {
    try {
        return await execute();
    } catch (error) {
        if (!(error instanceof RepositoryWorkflowCapacityError)) throw error;
        // Processors persist the incremented deferral count and retry time before unwinding.
        const retryAt = job.data?.repositoryWorkflowRetryAt;
        await job.moveToDelayed(retryAt && retryAt > Date.now() ? retryAt : Date.now() + repositoryWorkflowDeferralDelayMs(job.data?.repositoryWorkflowDeferrals ?? 1), job.token);
        throw new DelayedError();
    }
}

export async function runRepositoryWorkflow(options: {
    workflow?: ResolvedRepositoryWorkflow; repoOwner: string; repoName: string;
    redisClient: Redis; taskId: string; stateManager: WorkerStateManager; correlatedLogger: Logger;
}, execute: () => Promise<AgentExecutionResult>): Promise<AgentExecutionResult> {
    // Preparation awaits GitHub and worktree operations after admission. Keep the
    // final cancellation check immediately before starting the implementation agent.
    let result: AgentExecutionResult;
    try {
        await checkWorkflowTaskActive(options);
        // The network policy applies with or without a workflow file: the instance may require restricted mode.
        result = await runWithNetworkPolicy({ workflow: options.workflow, taskId: options.taskId, correlatedLogger: options.correlatedLogger },
            () => executeWithRepositoryWorkflow(options.workflow, execute));
    } catch (error) {
        await releaseRepositoryWorkflowSlot().catch(() => undefined);
        throw error;
    }
    // The container has exited. Capacity covers only that execution, so a lease
    // lost later, during commit, PR creation or completion comments, can no
    // longer fail work that has already finished. A lease lost while the
    // container ran still fails the attempt here, before anything is published.
    await releaseRepositoryWorkflowSlot();
    return result;
}
