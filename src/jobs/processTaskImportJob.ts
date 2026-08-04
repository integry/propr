import { Job } from 'bullmq';
import type { Logger } from 'pino';
import { logger } from '@propr/core';
import { getAuthenticatedOctokit } from '@propr/core';
import { withRetry, retryConfigs } from '@propr/core';
import { getStateManager, TaskStates } from '@propr/core';
import {
    createWorktreeForIssue,
    cleanupWorktree,
    getRepoUrl,
    ensureRepoCloned
} from '@propr/core';
import type { WorktreeInfo } from '@propr/core';
import { ensureGitRepository } from '@propr/core';
import { AgentRegistry, UsageLimitError } from '@propr/core';
import { generateTaskImportPrompt } from '@propr/core';
import { handleError } from '@propr/core';
import { handleSimpleUsageLimitError } from './issueJobHelpers.js';
import type { TaskImportJobData, JobResult } from '@propr/core';
import type { GitHubToken } from './githubTypes.js';
import { resolveDefaultAgentAndModel } from './prCommentAgentUtils.js';

interface TaskImportResult extends JobResult {
    repository?: string;
    success?: boolean;
    claudeResult?: {
        success: boolean;
        executionTime?: number;
        conversationTurns?: number;
        stdout?: string;
    };
}

export async function processTaskImportJob(job: Job<TaskImportJobData>): Promise<TaskImportResult> {
    const { id: jobId, name: jobName, data } = job;
    const {
        taskDescription,
        repository,
        correlationId,
        user
    } = data;
    const correlatedLogger: Logger = logger.withCorrelation(correlationId);
    const stateManager = getStateManager();

    correlatedLogger.info({
        jobId,
        jobName,
        repository,
        user,
        taskDescriptionLength: taskDescription?.length || 0,
        taskDescriptionPreview: taskDescription?.substring(0, 100) + '...'
    }, 'Processing task import job...');

    let octokit: Awaited<ReturnType<typeof getAuthenticatedOctokit>>;
    let localRepoPath: string | undefined;
    let worktreeInfo: WorktreeInfo | undefined;
    const [repoOwner, repoName] = repository.split('/');
    const taskId = `task-import-${repoOwner}-${repoName}-${Date.now()}`;

    try {
        await stateManager.createTaskState(taskId, { number: 0, repoOwner, repoName }, correlationId);

        octokit = await withRetry(
            () => getAuthenticatedOctokit(),
            { ...retryConfigs.githubApi, correlationId },
            'get_authenticated_octokit'
        );

        if (!repoOwner || !repoName) {
            throw new Error(`Invalid repository format: ${repository}. Expected format: owner/name`);
        }

        const githubToken = await octokit.auth({ type: "installation" }) as GitHubToken;
        const repoUrl = getRepoUrl({ repoOwner, repoName });

        await ensureGitRepository(correlatedLogger);

        await stateManager.updateTaskState(taskId, TaskStates.PROCESSING, { reason: 'Cloning repository if needed' });
        localRepoPath = await ensureRepoCloned({ repoUrl, owner: repoOwner, repoName, authToken: githubToken.token });

        await stateManager.updateTaskState(taskId, TaskStates.PROCESSING, { reason: 'Creating worktree for analysis' });

        worktreeInfo = await createWorktreeForIssue(
            localRepoPath,
            { issueId: 'import', issueTitle: 'Task Import Analysis', owner: repoOwner, repoName },
            { baseBranch: null, octokit, modelName: 'planner' }
        );

        correlatedLogger.info({
            worktreePath: worktreeInfo.worktreePath,
            branchName: worktreeInfo.branchName
        }, 'Created worktree for task import analysis');

        await stateManager.updateTaskState(taskId, TaskStates.CLAUDE_EXECUTION, { reason: 'Generating task import prompt' });

        const prompt = generateTaskImportPrompt(taskDescription, repoOwner, repoName, worktreeInfo.worktreePath);


        const registry = AgentRegistry.getInstance();
        await registry.ensureInitialized();
        const { resolvedAlias, resolvedModel } = await resolveDefaultAgentAndModel(registry, correlatedLogger);
        const agent = registry.getAgentByAlias(resolvedAlias);
        if (!agent) throw new Error(`Configured default agent not found: ${resolvedAlias}`);

        const agentResult = await agent.executeTask({
            worktreePath: worktreeInfo.worktreePath,
            issueRef: {
                number: 0,
                repoOwner,
                repoName
            },
            githubToken: githubToken.token,
            prompt,
            branchName: worktreeInfo.branchName,
            model: resolvedModel,
            taskId,
        });

        correlatedLogger.info({
            agentAlias: resolvedAlias,
            model: resolvedModel,
            success: agentResult.success,
            executionTime: agentResult.executionTimeMs,
            conversationTurns: agentResult.conversationLog?.length || 0
        }, 'Task import analysis completed');

        if (agentResult.success) {
            correlatedLogger.info({
                repository,
                user,
                stdout: agentResult.rawOutput || agentResult.logs
            }, 'Task import job completed successfully - agent executed gh commands');
        } else {
            correlatedLogger.error({
                repository,
                user,
                error: agentResult.error
            }, 'Task import job failed');
        }

        await stateManager.updateTaskState(taskId, TaskStates.POST_PROCESSING, { reason: 'Cleaning up worktree' });
        await stateManager.markTaskCompleted(taskId, { status: 'complete', repository });

        return {
            status: 'complete',
            repository,
            success: agentResult.success,
            jobId,
            claudeResult: {
                success: agentResult.success,
                executionTime: agentResult.executionTimeMs,
                conversationTurns: agentResult.conversationLog?.length || 0,
                stdout: agentResult.rawOutput || agentResult.logs
            }
        };

    } catch (error) {
        if (error instanceof UsageLimitError) {
            return handleSimpleUsageLimitError(error, job as unknown as Job<{ repoOwner: string; repoName: string; number: number; modelName?: string; correlationId?: string }>, correlatedLogger, repository);
        }
        correlatedLogger.error({ error: (error as Error).message, stack: (error as Error).stack }, 'Task import job failed');
        await stateManager.markTaskFailed(taskId, error as Error);
        handleError(error, 'Failed to process task import job', { correlationId });
        throw error;
    } finally {
        if (localRepoPath && worktreeInfo) {
            try {
                await cleanupWorktree(localRepoPath, worktreeInfo.worktreePath, worktreeInfo.branchName, {
                    deleteBranch: true,
                    success: true
                });
            } catch (cleanupError) {
                correlatedLogger.warn({ error: (cleanupError as Error).message }, 'Failed to cleanup worktree');
            }
        }
    }
}
