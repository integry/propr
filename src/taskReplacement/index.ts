import {
    db,
    getAuthenticatedOctokit,
    getEventPublisher,
    issueQueue,
    loadSettings,
    logger,
    retryConfigs,
    withRetry,
} from '@propr/core';
import { infraLostReplacementEnabled, resolveMaxProviderReplacements } from './policy.js';
import { createTaskReplacementService, type TaskReplacementService } from './service.js';
import { createTaskReplacementStore } from './store.js';

export * from './policy.js';
export * from './service.js';
export {
    createTaskReplacementStore,
    recordPushedBranch,
    recordReplayableIssueTask,
    replayJobData,
    type LineageAttempt,
    type ReplaceableTask,
    type TaskReplacementStore,
} from './store.js';

export async function loadMaxProviderReplacements(): Promise<number> {
    try {
        const settings = await loadSettings();
        return resolveMaxProviderReplacements(settings.max_provider_replacements);
    } catch (error) {
        logger.warn({ error: (error as Error).message }, 'Could not load the provider replacement cap; using the environment value');
        return resolveMaxProviderReplacements(undefined);
    }
}

let defaultService: TaskReplacementService | null = null;

/** Replacement service wired to the worker's database, queue, GitHub and event publisher. */
export function getTaskReplacementService(): TaskReplacementService {
    defaultService ??= createTaskReplacementService({
        store: createTaskReplacementStore(db),
        async enqueue(jobName, data, jobId) {
            await issueQueue.add(jobName, data, { jobId });
        },
        loadMaxProviderReplacements,
        infraLostEnabled: () => infraLostReplacementEnabled(),
        async readIssueState(owner, repo, issueNumber) {
            const octokit = await getAuthenticatedOctokit();
            const response = await withRetry(
                () => octokit.request('GET /repos/{owner}/{repo}/issues/{issue_number}', { owner, repo, issue_number: issueNumber }),
                retryConfigs.githubApi,
                'read_issue_state_for_replacement',
            );
            return { state: String((response.data as { state?: unknown }).state ?? '') };
        },
        async postIssueComment(owner, repo, issueNumber, body) {
            const octokit = await getAuthenticatedOctokit();
            await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
                owner, repo, issue_number: issueNumber, body,
            });
        },
        publishTaskUpdate: payload => getEventPublisher().publishTaskUpdate(payload),
        logger,
    });
    return defaultService;
}
