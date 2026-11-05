import { buildAcceptedRequestMarkers, buildWorkEvidenceMarker, filterRealComments } from '../shared/workEvidenceMarker.js';
import { handoffCommentMarker, HANDOFF_NORMAL_COMPLETION_MARKER, HANDOFF_NORMAL_FAILURE_MARKER } from './followupHandoffMarker.js';
import { parseClaimedComments, type FollowupHandoffRecord } from './followupHandoffStore.js';

/** Comment bodies, commit messages and task outcome wording of follow-up handoff recovery. */

export function recoveryCommitMessage(record: FollowupHandoffRecord): string {
    return `fix(ai): recover interrupted follow-up for PR #${record.pull_request}\n\n`
        + 'The agent produced this work before a worker restart interrupted publication. '
        + 'ProPR adopted the retained worktree and committed it during follow-up handoff recovery.';
}

export function recoveredCompletionBody(record: FollowupHandoffRecord): string {
    const comments = filterRealComments(parseClaimedComments(record));
    const ids = comments.map(comment => comment.id);
    const authors = [...new Set(comments.map(comment => comment.author))].map(author => `@${author}`).join(', ');
    return [
        handoffCommentMarker(record),
        `✅ **Recovered and published follow-up changes**${authors ? ` requested by ${authors}` : ''}`,
        'A worker restart interrupted the original attempt after the agent produced work. ProPR adopted the retained worktree and published it.',
        record.commit_hash ? `Commit: \`${record.commit_hash}\`` : '',
        ids.length ? `---\nComment ID${ids.length > 1 ? 's' : ''}: ${ids.map(id => `${id}✓`).join(', ')}` : '',
        buildWorkEvidenceMarker('completed', ids),
        // Like the normal completion footer, accepted request bodies are bound
        // only when full completion is substantiated: the agent itself exited
        // reporting success. A lost or stopped-short agent keeps the completed
        // marker but binds nothing.
        record.agent_completed === 1 ? buildAcceptedRequestMarkers(comments) : '',
    ].filter(Boolean).join('\n\n');
}

/**
 * The no-change completion a recorded successful agent run owed when the
 * worker died before delivering it: the agent itself reported success, so
 * the request is answered (with the persisted analysis) and binds its
 * accepted bodies like the normal no-change completion — never requeued.
 */
export function recoveredNoChangeCompletionBody(record: FollowupHandoffRecord): string {
    const comments = filterRealComments(parseClaimedComments(record));
    const ids = comments.map(comment => comment.id);
    const authors = [...new Set(comments.map(comment => comment.author))].map(author => `@${author}`).join(', ');
    return [
        handoffCommentMarker(record),
        `ℹ️ **Analyzed the follow-up request**${authors ? ` by ${authors}` : ''}`,
        'A worker restart interrupted publication after the agent completed the request successfully. ProPR recovered the result from the retained worktree.',
        record.agent_summary ? `## Analysis Summary\n\n${record.agent_summary}` : '',
        'No code changes were necessary based on the current state of the branch.',
        ids.length ? `---\nComment ID${ids.length > 1 ? 's' : ''}: ${ids.map(id => `${id}✓`).join(', ')}` : '',
        buildWorkEvidenceMarker('completed', ids),
        buildAcceptedRequestMarkers(comments),
    ].filter(Boolean).join('\n\n');
}

/** Durable diagnostic that recovery rebuilt a worktree deleted outside ProPR; the rebuild also invalidated any recorded agent success. */
export const WORKTREE_LOST_REASON = 'worktree_lost';

/** Whether the record carries durable evidence that its worktree was deleted and rebuilt. */
export function worktreeWasLost(record: Pick<FollowupHandoffRecord, 'status_reason'>): boolean {
    return record.status_reason === WORKTREE_LOST_REASON;
}

export function interruptedWithoutChangesBody(record: FollowupHandoffRecord): string {
    const worktreeLost = worktreeWasLost(record);
    const comments = filterRealComments(parseClaimedComments(record));
    const ids = comments.map(comment => comment.id);
    const authors = [...new Set(comments.map(comment => comment.author))].map(author => `@${author}`).join(', ');
    return [
        handoffCommentMarker(record),
        `⚠️ **Follow-up interrupted before any changes were produced**${authors ? ` (requested by ${authors})` : ''}`,
        worktreeLost
            ? 'The agent run was interrupted and its worktree was deleted before any changes were committed, so nothing could be published. The request has been returned to the queue and will be picked up by the next follow-up on this pull request.'
            : 'A worker restart interrupted the agent run and its worktree holds no unpublished work. The request has been returned to the queue and will be picked up by the next follow-up on this pull request.',
        ids.length ? `Returned comment ID${ids.length > 1 ? 's' : ''}: ${ids.join(', ')}` : '',
        buildWorkEvidenceMarker('failed', ids),
    ].filter(Boolean).join('\n\n');
}

export interface OwedCommentDelivery {
    url: string | null;
    /**
     * Who delivered the found comment: the normal path's own completion or
     * failure notice (published before its checkpoint), or this recovery.
     */
    delivery: 'normal_completion' | 'normal_failure' | 'recovery';
}

export function normalDelivery(body: string | undefined): OwedCommentDelivery['delivery'] {
    if (body?.includes(HANDOFF_NORMAL_COMPLETION_MARKER)) return 'normal_completion';
    return body?.includes(HANDOFF_NORMAL_FAILURE_MARKER) ? 'normal_failure' : 'recovery';
}

export type RecoveredTaskOutcome = 'published' | 'completion_delivered' | 'completed_without_changes' | 'failure_delivered' | 'no_changes';

export const recoveredTaskRecaps: Record<RecoveredTaskOutcome, string> = {
    published: 'Recovered and published the interrupted follow-up after a worker restart.',
    completion_delivered: 'The follow-up completion was delivered before a worker restart; recovery recorded it without republishing.',
    completed_without_changes: 'The agent completed the follow-up without file changes before a worker restart; recovery delivered its completion without running it again.',
    failure_delivered: 'The follow-up failure was reported before a worker restart; recovery recorded it without requeueing the request.',
    no_changes: 'A worker restart interrupted the follow-up before it produced changes; the request was returned to the queue.',
};

export const recoveredTaskReasons: Record<RecoveredTaskOutcome, string> = {
    published: 'Recovered interrupted follow-up publication after a worker restart',
    completion_delivered: 'Recorded the follow-up completion delivered before a worker restart',
    completed_without_changes: 'Recovered the no-change follow-up completion after a worker restart',
    failure_delivered: 'Recorded the follow-up failure reported before a worker restart',
    no_changes: 'Worker restart interrupted the follow-up before it produced changes',
};

export const failedOutcomes: ReadonlySet<RecoveredTaskOutcome> = new Set(['failure_delivered', 'no_changes']);

/** A delivered completion comment is completion evidence even without a commit (a no-change completion). */
export function deliveredOutcome(record: FollowupHandoffRecord): RecoveredTaskOutcome {
    if (record.commit_hash) return 'published';
    return record.completion_comment_url ? 'completion_delivered' : 'no_changes';
}
