import type { Logger } from 'pino';
import { createWorktreePushSalvageOperations, formatPushFailureMarkdown, getPushFailure, pushBranch, salvageFailedPush } from '@propr/core';
import type { getAuthenticatedOctokit, IssueJobData, PushFailureRecord, WorkerStateManager, WorktreeInfo } from '@propr/core';
import type { GitHubToken } from './githubTypes.js';

export type { GitHubToken };
import { recordPushSalvageEvent } from './pushSalvageTimeline.js';

export interface ImplementationPushOptions {
    octokit: Pick<Awaited<ReturnType<typeof getAuthenticatedOctokit>>, 'auth'>;
    issueRef: IssueJobData;
    worktreeInfo: WorktreeInfo;
    repoUrl: string;
    taskId?: string;
    stateManager?: WorkerStateManager;
    correlatedLogger: Logger;
}

/** A rejected final push runs the salvage ladder so the agent's commits survive the
 * worktree cleanup; it then rethrows a PushFailedError describing the recovery. */
export async function pushImplementationBranch(options: ImplementationPushOptions): Promise<void> {
    const { octokit, issueRef, worktreeInfo, repoUrl, taskId, stateManager, correlatedLogger } = options;
    const { worktreePath, branchName } = worktreeInfo;
    try {
        // The token captured before agent execution may have expired while it worked; a
        // failure to obtain a new one must reach the salvage ladder like a rejected push.
        const { token } = await octokit.auth({ type: 'installation' }) as GitHubToken;
        await pushBranch(worktreePath, branchName, { repoUrl, authToken: token });
    } catch (error) {
        const salvageTaskId = taskId || `${issueRef.repoOwner}-${issueRef.repoName}-${issueRef.number}`;
        await salvageFailedPush({
            taskId: salvageTaskId, repoOwner: issueRef.repoOwner, repoName: issueRef.repoName,
            branchName, worktreePath, error,
            onEvent: taskId && stateManager ? recordPushSalvageEvent(stateManager, taskId, correlatedLogger) : undefined,
            operations: createWorktreePushSalvageOperations({
                worktreePath, taskId: salvageTaskId, branchName, repoUrl,
                refreshToken: async () => (await octokit.auth({ type: 'installation', refresh: true }) as GitHubToken).token,
                retryPush: async freshToken => { await pushBranch(worktreePath, branchName, { repoUrl, authToken: freshToken }); },
            }),
        });
    }
}

/** Heading and diagnosis for the issue's failure comment. */
export function formatIssuePushFailure(pushFailure: PushFailureRecord): string {
    return `❌ **ProPR could not push the implementation branch.**\n\n${formatPushFailureMarkdown(pushFailure)}\n\n`;
}

export function describePushFailure(error: unknown): { pushFailure?: PushFailureRecord; failureFields: { pushFailure?: PushFailureRecord } } {
    const pushFailure = getPushFailure(error);
    return { pushFailure, failureFields: pushFailure ? { pushFailure } : {} };
}
