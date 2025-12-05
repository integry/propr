import logger from '../utils/logger.js';
import { getAuthenticatedOctokit } from '../auth/githubAuth.js';
import { withRetry, retryConfigs } from '../utils/retryHandler.js';
import { getStateManager, TaskStates } from '../utils/workerStateManager.js';
import {
    createWorktreeForIssue,
    cleanupWorktree,
    getRepoUrl
} from '../git/repoManager.js';
import { ensureGitRepository } from '../utils/git/gitValidation.js';
import { executeClaudeCode, UsageLimitError } from '../claude/claudeService.js';
import { generateTaskImportPrompt } from '../claude/prompts/promptGenerator.js';
import { handleError } from '../utils/errorHandler.js';
import { handleSimpleUsageLimitError } from './issueJobHelpers.js';
import type { TaskImportJobData, Job, JobResult } from '../queue/taskQueue.js';
import type { Octokit } from '@octokit/core';

interface WorktreeInfo {
    worktreePath: string;
    branchName: string;
}

interface GitHubToken {
    token: string;
}

export async function processTaskImportJob(job: Job<TaskImportJobData>): Promise<JobResult> {
    const { id: jobId, name: jobName, data } = job;
    const {
        taskDescription,
        repository,
        correlationId,
        user
    } = data;
    const correlatedLogger = logger.withCorrelation(correlationId);
    const stateManager = getStateManager();

    correlatedLogger.info({
        jobId,
        jobName,
        repository,
        user,
        taskDescriptionLength: taskDescription?.length || 0,
        taskDescriptionPreview: taskDescription?.substring(0, 100) + '...'
    }, 'Processing task import job...');

    let octokit: Octokit | undefined;
    let localRepoPath: string | undefined;
    let worktreeInfo: WorktreeInfo | undefined;
    const taskId = `task-import-${repository.replace('/', '-')}-${Date.now()}`;

    try {
        await stateManager.createTaskState(taskId, { number: 0, repoOwner: repository.split('/')[0], repoName: repository.split('/')[1] }, correlationId);
        await stateManager.updateTaskState(taskId, TaskStates.PROCESSING, { reason: 'Initializing task import process' });

        octokit = await withRetry(
            () => getAuthenticatedOctokit(),
            { ...retryConfigs.githubApi, correlationId },
            'get_authenticated_octokit'
        );

        const [repoOwner, repoName] = repository.split('/');

        if (!repoOwner || !repoName) {
            throw new Error(`Invalid repository format: ${repository}. Expected format: owner/name`);
        }

        const githubToken = await octokit.auth() as GitHubToken;
        const repoUrl = getRepoUrl({ repoOwner, repoName });

        await ensureGitRepository(correlatedLogger);

        await stateManager.updateTaskState(taskId, TaskStates.PROCESSING, { reason: 'Cloning repository if needed' });
        const { ensureRepoCloned } = await import('../git/repoManager.js');
        localRepoPath = await ensureRepoCloned(repoUrl, repoOwner, repoName, githubToken.token);

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

        await stateManager.updateTaskState(taskId, TaskStates.CLAUDE_EXECUTION, { reason: 'Executing Claude analysis' });

        const claudeResult = await executeClaudeCode({
            worktreePath: worktreeInfo.worktreePath,
            issueRef: {
                number: 0,
                repoOwner,
                repoName
            },
            githubToken: githubToken.token,
            customPrompt: prompt,
            branchName: worktreeInfo.branchName,
            modelName: 'claude-3-5-sonnet-20241022'
        });

        correlatedLogger.info({
            success: claudeResult.success,
            executionTime: claudeResult.executionTime,
            conversationTurns: claudeResult.conversationLog?.length || 0
        }, 'Claude task import analysis completed');

        if (claudeResult.success) {
            const outputStr = typeof claudeResult.output === 'object' && claudeResult.output?.rawOutput 
                ? claudeResult.output.rawOutput 
                : claudeResult.output;
            correlatedLogger.info({
                repository,
                user,
                stdout: outputStr
            }, 'Task import job completed successfully - Claude executed gh commands');
        } else {
            correlatedLogger.error({
                repository,
                user,
                error: claudeResult.error
            }, 'Task import job failed');
        }

        await stateManager.updateTaskState(taskId, TaskStates.POST_PROCESSING, { reason: 'Cleaning up worktree' });
        await stateManager.markTaskCompleted(taskId, {});


        return {
            status: 'complete',
            repository,
            claudeResult: {
                success: claudeResult.success,
                executionTime: claudeResult.executionTime || 0,
                conversationLog: claudeResult.conversationLog || [],
            }
        };

    } catch (error) {
        if (error instanceof UsageLimitError) {
            return handleSimpleUsageLimitError(error, job as unknown as Job<import('../queue/taskQueue.js').IssueJobData>, correlatedLogger, repository);
        }
        correlatedLogger.error({ error: (error as Error).message, stack: (error as Error).stack }, 'Task import job failed');
        await stateManager.markTaskFailed(taskId, error as Error, {});
        handleError(error as Error, 'Failed to process task import job', { correlationId });
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
