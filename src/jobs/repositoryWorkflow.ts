import { DelayedError, type Job } from 'bullmq';
import {
    loadRepositoryWorkflow, loadSettings, WORKFLOW_MAX_BYTES, WORKFLOW_PATH,
    executeWithRepositoryWorkflow, withRepositoryWorkflowSlot, RepositoryWorkflowCapacityError, RepositoryWorkflowLeaseLostError, TaskStates,
} from '@propr/core';
import type { getAuthenticatedOctokit, ResolvedRepositoryWorkflow, WorkerStateManager, AgentExecutionResult, IssueJobData } from '@propr/core';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';

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

export async function prepareRepositoryWorkflow(options: {
    octokit: Octokit; repoOwner: string; repoName: string; baseBranch?: string | null;
    /** Known default branch (e.g. from the dispatched repository payload) to avoid a repository lookup. */
    defaultBranch?: string | null;
}): Promise<ResolvedRepositoryWorkflow | undefined> {
    const { octokit, repoOwner: owner, repoName: repo } = options;
    const defaultBranch = async () => options.defaultBranch || (await octokit.request('GET /repos/{owner}/{repo}', { owner, repo })).data.default_branch;
    const resolveRevision = async (ref: string) => (await octokit.request('GET /repos/{owner}/{repo}/commits/{ref}', { owner, repo, ref })).data.sha;
    let baseBranch = options.baseBranch || await defaultBranch();
    let revision: string;
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
    const absentKey = absentWorkflowKey(owner, repo, revision);
    if (isKnownAbsentWorkflow(absentKey)) return undefined;
    const settings = await loadSettings();
    const workflow = await loadRepositoryWorkflow({
        resolveRevision: async () => revision,
        readFile: async (path, ref) => {
            let response;
            try {
                response = await octokit.request('GET /repos/{owner}/{repo}/contents/{path}', { owner, repo, path, ref });
            } catch (error) {
                if ((error as { status?: number }).status === 404) return null;
                throw error;
            }
            const file = response.data;
            if (Array.isArray(file) || file.type !== 'file' || !('content' in file) || file.encoding !== 'base64' || file.size > WORKFLOW_MAX_BYTES) {
                throw new Error(`Invalid .propr/workflow.yml: ${path} must be a regular UTF-8 file of at most 128 KiB`);
            }
            const bytes = Buffer.from(file.content, 'base64');
            try {
                const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
                return { content, sha: file.sha };
            } catch {
                throw new Error(`Invalid .propr/workflow.yml: ${path} must contain valid UTF-8 text`);
            }
        },
    }, baseBranch, {
        maxParallelTasks: Number(settings?.worker_concurrency ?? process.env.WORKER_CONCURRENCY ?? 5),
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
        await stateManager.updateTaskStateIfCurrent(taskId, {
            state: current.state, createdAt: current.createdAt, updatedAt: current.updatedAt, correlationId: current.correlationId, version: current.version,
        }, current.state, {
            reason: `Waiting for repository workflow capacity${limit}`,
            historyMetadata: {
                repositoryWorkflowDeferrals: deferral.repositoryWorkflowDeferrals,
                repositoryWorkflowRetryAt: new Date(deferral.repositoryWorkflowRetryAt).toISOString(),
            },
        });
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

export async function withRepositoryWorkflowAdmission<T>(options: {
    workflow?: ResolvedRepositoryWorkflow; repoOwner: string; repoName: string;
    redisClient: Redis; taskId: string; stateManager: WorkerStateManager; correlatedLogger: Logger;
}, execute: () => Promise<T>): Promise<T> {
    return withRepositoryWorkflowSlot({
        redis: options.redisClient, repository: `${options.repoOwner}/${options.repoName}`, limit: options.workflow?.maxParallelTasks,
        checkCancelled: () => checkWorkflowTaskActive(options),
        onLeaseError: error => options.correlatedLogger.error({ error }, 'Repository workflow capacity lease failed'),
    }, execute);
}

export { RepositoryWorkflowCapacityError, RepositoryWorkflowLeaseLostError };

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
    await checkWorkflowTaskActive(options);
    return executeWithRepositoryWorkflow(options.workflow, execute);
}
