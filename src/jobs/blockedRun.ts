/**
 * Shared pieces of the opt-in "stop and report the blocker" outcome
 * (`on_blocker: report` in `.propr/workflow.yml`). Loaded lazily by the issue
 * and follow-up paths only when the option is enabled, so runs without it keep
 * their module graph and behaviour unchanged.
 */
import type { Logger } from 'pino';
import { createHooklessGit, createNotificationEvent, isGeneratedRuntimePath, type BlockerReport } from '@propr/core';
import { instanceMemberNotificationRecipients, repositoryNotificationsEnabled } from './runCostCap.js';
import { blockedRunRecap } from './blockedRunText.js';

export { blockedRunRecap, describeUncommittedFiles, quoteBlockerExplanation } from './blockedRunText.js';

/** Recorded on the task result and history of a blocked run. */
export interface BlockedRunOutcome {
    explanation: string;
    /** Files the agent left changed despite reporting the blocker; never committed. */
    uncommittedFiles: string[];
}

/**
 * Files the agent left changed in the worktree, excluding ProPR's own runtime
 * directories (which a commit would skip too). A status that cannot be read
 * is logged and treated as no changes: the run is blocked either way and
 * nothing is committed.
 */
export async function uncommittedWorktreeFiles(worktreePath: string | undefined, logger: Pick<Logger, 'warn'>): Promise<string[]> {
    if (!worktreePath) return [];
    try {
        const status = await createHooklessGit(worktreePath).status();
        return [...new Set(status.files.map(file => file.path))].filter(file => !isGeneratedRuntimePath(file));
    } catch (error) {
        logger.warn({ worktreePath, error: (error as Error).message }, 'Could not read the worktree status of a blocked run');
        return [];
    }
}

export async function blockedRunOutcome(report: BlockerReport, worktreePath: string | undefined, logger: Pick<Logger, 'warn'>): Promise<BlockedRunOutcome> {
    return { explanation: report.explanation, uncommittedFiles: await uncommittedWorktreeFiles(worktreePath, logger) };
}

export interface BlockedRunNotificationTarget {
    taskId: string;
    repoOwner: string;
    repoName: string;
    number: number;
    kind: 'issue' | 'pull_request';
}

/** A warning-severity Inbox entry for the blocked run; best-effort. */
export async function notifyBlockedRun(target: BlockedRunNotificationTarget, outcome: BlockedRunOutcome, logger: Pick<Logger, 'warn'>): Promise<void> {
    const repository = `${target.repoOwner}/${target.repoName}`;
    try {
        if (!await repositoryNotificationsEnabled(repository)) return;
        const recipients = await instanceMemberNotificationRecipients();
        if (recipients.length === 0) return;
        const subject = target.kind === 'pull_request' ? `PR #${target.number}` : `issue #${target.number}`;
        await createNotificationEvent({
            deduplicationKey: `task-blocked:${target.taskId}`,
            kind: 'task',
            severity: 'warning',
            target: {
                type: 'task', repository, taskId: target.taskId,
                ...(target.kind === 'pull_request' ? { prNumber: target.number } : { issueNumber: target.number }),
            },
            title: `Run stopped on a blocker for ${subject}`,
            body: blockedRunRecap(outcome),
            metadata: { event: 'task.blocked', uncommittedFiles: outcome.uncommittedFiles.length },
        }, recipients);
    } catch (error) {
        logger.warn({ taskId: target.taskId, error: (error as Error).message }, 'Could not record the blocked-run notification');
    }
}
