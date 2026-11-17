import { describeFailureCause } from './failureCause.js';
import { taskPageUrl } from './taskPageUrl.js';
import { buildWorkEvidenceMarker, filterRealComments } from '../shared/workEvidenceMarker.js';

interface FailureCommentRequest {
    id: number;
    author: string;
}

/**
 * The ❌ comment for a PR follow-up that failed. It leads with a plain cause
 * when one is recognisable, keeps the sanitized error as detail, links the task,
 * and lists the `<id>✓` receipts polling reads, but only for comments that exist
 * on GitHub: synthetic requests (an automatic `/review`, a retry) carry id 0.
 */
export function buildFollowupFailureCommentBody(options: {
    /** Handoff markers and publication status that lead the comment, if any. */
    prefixes?: ReadonlyArray<string | null | undefined | false>;
    authorsText: string;
    /** Sanitized error message, shown when there is no push-failure explanation. */
    errorMessage: string;
    /** A push failure's own explanation, which replaces the error block. */
    pushFailureMarkdown?: string;
    comments: readonly FailureCommentRequest[];
    taskId?: string;
}): string {
    const { prefixes = [], authorsText, errorMessage, pushFailureMarkdown, comments, taskId } = options;
    const prefix = prefixes.filter(Boolean).join('\n\n');
    const cause = pushFailureMarkdown ? null : describeFailureCause(errorMessage);
    const detail = pushFailureMarkdown
        ?? `${cause ? `${cause}\n\n` : ''}\`\`\`\n${errorMessage}\n\`\`\``;
    const receiptIds = comments.map(comment => comment.id).filter(id => Number.isSafeInteger(id) && id > 0);
    const evidence = buildWorkEvidenceMarker('failed', filterRealComments(comments).map(comment => comment.id));
    const footer = [
        receiptIds.length ? `Comment ID${receiptIds.length > 1 ? 's' : ''}: ${receiptIds.map(id => `${id}✓`).join(', ')}` : '',
        evidence,
    ].filter(Boolean).join('\n');
    return [
        prefix ? `${prefix}\n\n` : '',
        `❌ **Failed to apply follow-up changes** requested by ${authorsText}\n\n`,
        detail,
        taskId ? `\n\n[View task](${taskPageUrl(taskId)})` : '',
        footer ? `\n\n---\n${footer}` : '',
    ].join('');
}
