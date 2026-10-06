import type { TaskReplacementDependencies } from './service.js';
import type { FailureNoticeRecord, ReplaceableTask } from './store.js';

/** Posting attempts of an exhausted lineage's final comment before recovery gives up on it. */
export const MAX_EXHAUSTED_COMMENT_ATTEMPTS = 5;

/** Identifies a notice's final comment on the issue, so an uncertain post can be reconciled. */
export function exhaustedCommentMarker(noticeId: string): string {
    return `<!-- propr-replacement-exhausted:${noticeId} -->`;
}

/**
 * Posts an exhausted lineage's final comment. Delivery is recorded on the notice,
 * not inferred from the timeline event, and every posting attempt is counted first:
 * a later attempt looks for the comment's marker before posting again, since a
 * lost response does not prove GitHub rejected the comment. Returns whether the
 * obligation is settled (delivered, not owed, or abandoned after repeated failures).
 */
export async function deliverExhaustedComment(
    deps: Pick<TaskReplacementDependencies, 'store' | 'postIssueComment' | 'findIssueComment' | 'logger'>,
    task: ReplaceableTask,
    notice: FailureNoticeRecord,
    lineage: { count: number; formatted: string },
): Promise<boolean> {
    const [owner, repo, ...rest] = task.repository.split('/');
    if (notice.commentDelivered || notice.cause !== 'infra_lost' || !deps.postIssueComment
        || !owner || !repo || rest.length > 0 || !task.issueNumber) return true;
    const marker = exhaustedCommentMarker(notice.id);
    const attempts = notice.commentAttempts ?? 0;
    try {
        const posted = attempts > 0 && !!deps.findIssueComment && await deps.findIssueComment(owner, repo, task.issueNumber, marker);
        if (!posted) {
            if (attempts >= MAX_EXHAUSTED_COMMENT_ATTEMPTS) {
                deps.logger?.warn({ taskId: task.taskId, attempts }, 'Giving up on the final replacement failure comment');
                return true;
            }
            await deps.store.updateFailureNotice(task.taskId, notice.id, { commentAttempts: attempts + 1 });
            await deps.postIssueComment(owner, repo, task.issueNumber, `❌ **Failed to process this issue after ${lineage.count} attempts**\n\n`
                + 'The last attempt was lost with its worker (no queue job or running task container remained), '
                + 'and a second loss in the same lineage is final.\n\n'
                + `**Attempts:**\n${lineage.formatted}\n\n`
                + `---\n*Re-apply the trigger label to start a new run.*\n${marker}`);
        }
        await deps.store.updateFailureNotice(task.taskId, notice.id, { commentDelivered: true });
        return true;
    } catch (error) {
        deps.logger?.warn({ taskId: task.taskId, error: (error as Error).message }, 'Failed to post the final replacement failure comment; recovery will retry it');
        return false;
    }
}
