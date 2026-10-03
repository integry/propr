import { DelayedError, type Job } from 'bullmq';
import {
    loadRepositoryWorkflow, loadSettings, WORKFLOW_MAX_BYTES, WORKFLOW_PATH,
    executeWithRepositoryWorkflow, withRepositoryWorkflowSlot, RepositoryWorkflowCapacityError, TaskStates,
} from '@propr/core';
import type { getAuthenticatedOctokit, ResolvedRepositoryWorkflow, WorkerStateManager, AgentExecutionResult, IssueJobData } from '@propr/core';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';

type Octokit = Awaited<ReturnType<typeof getAuthenticatedOctokit>>;
type RepositoryWorkflowDeferralData = Pick<IssueJobData, 'repositoryWorkflow' | 'repositoryWorkflowDeferrals'>;

export async function prepareRepositoryWorkflow(options: {
    octokit: Octokit; repoOwner: string; repoName: string; baseBranch?: string | null;
}): Promise<ResolvedRepositoryWorkflow | undefined> {
    const { octokit, repoOwner: owner, repoName: repo } = options;
    const baseBranch = options.baseBranch || (await octokit.request('GET /repos/{owner}/{repo}', { owner, repo })).data.default_branch;
    const settings = await loadSettings();
    const workflow = await loadRepositoryWorkflow({
        resolveRevision: async branch => (await octokit.request('GET /repos/{owner}/{repo}/commits/{ref}', { owner, repo, ref: branch })).data.sha,
        readFile: async (path, revision) => {
            let response;
            try {
                response = await octokit.request('GET /repos/{owner}/{repo}/contents/{path}', { owner, repo, path, ref: revision });
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
    if (cached === null || (cached && (!baseBranch || cached.baseBranch === baseBranch))) return cached ?? undefined;
    return prepare();
}

/** Persist with the deferral so re-entry can attempt admission before any policy request. */
export function repositoryWorkflowDeferralData(data: RepositoryWorkflowDeferralData, workflow?: ResolvedRepositoryWorkflow): RepositoryWorkflowDeferralData {
    return { repositoryWorkflow: workflow ?? null, repositoryWorkflowDeferrals: (data.repositoryWorkflowDeferrals ?? 0) + 1 };
}

/** Admission ends the wait; ordinary retries must read the base branch policy again. */
export const CLEARED_REPOSITORY_WORKFLOW_DEFERRAL: RepositoryWorkflowDeferralData = { repositoryWorkflow: undefined, repositoryWorkflowDeferrals: undefined };

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

export { RepositoryWorkflowCapacityError };

/** Delay only after the processor has unwound its locks and durable claims. */
export async function deferRepositoryWorkflowJob<T>(job: Pick<Job<RepositoryWorkflowDeferralData>, 'moveToDelayed' | 'token'> & { data?: RepositoryWorkflowDeferralData }, execute: () => Promise<T>): Promise<T> {
    try {
        return await execute();
    } catch (error) {
        if (!(error instanceof RepositoryWorkflowCapacityError)) throw error;
        // Processors persist the incremented deferral count before unwinding.
        await job.moveToDelayed(Date.now() + repositoryWorkflowDeferralDelayMs(job.data?.repositoryWorkflowDeferrals ?? 1), job.token);
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
