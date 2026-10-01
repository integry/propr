import {
    loadRepositoryWorkflow, loadSettings, WORKFLOW_MAX_BYTES,
    executeWithRepositoryWorkflow, withRepositoryWorkflowSlot, TaskStates,
} from '@propr/core';
import type { getAuthenticatedOctokit, ResolvedRepositoryWorkflow, WorkerStateManager, AgentExecutionResult } from '@propr/core';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';

type Octokit = Awaited<ReturnType<typeof getAuthenticatedOctokit>>;

export async function prepareRepositoryWorkflow(options: {
    octokit: Octokit; repoOwner: string; repoName: string; baseBranch?: string | null;
    taskId: string; stateManager: WorkerStateManager;
}): Promise<ResolvedRepositoryWorkflow | undefined> {
    const { octokit, repoOwner: owner, repoName: repo, taskId, stateManager } = options;
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
    if (workflow) {
        await stateManager.updateHistoryMetadata(taskId, TaskStates.PROCESSING, {
            repositoryWorkflow: { path: '.propr/workflow.yml', baseBranch, revision: workflow.revision, fileRevision: workflow.fileRevision,
                maxParallelTasks: workflow.maxParallelTasks, timeoutMs: workflow.timeoutMs },
        });
    }
    return workflow;
}

export async function runRepositoryWorkflow(options: {
    workflow?: ResolvedRepositoryWorkflow; repoOwner: string; repoName: string;
    redisClient: Redis; taskId: string; stateManager: WorkerStateManager; correlatedLogger: Logger;
}, execute: () => Promise<AgentExecutionResult>): Promise<AgentExecutionResult> {
    return withRepositoryWorkflowSlot({
        redis: options.redisClient, repository: `${options.repoOwner}/${options.repoName}`, limit: options.workflow?.maxParallelTasks,
        checkCancelled: async () => {
            const state = await options.stateManager.getTaskState(options.taskId);
            if (state && ([TaskStates.CANCELLED, TaskStates.FAILED, TaskStates.COMPLETED] as string[]).includes(state.state)) throw new Error('Task ended while waiting for repository workflow capacity');
        },
        onLeaseError: error => options.correlatedLogger.error({ error }, 'Repository workflow capacity lease failed'),
    }, () => executeWithRepositoryWorkflow(options.workflow, execute));
}
