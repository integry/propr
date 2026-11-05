import type { CommentJobData, UnprocessedComment } from '@propr/core';

/** Commands that intake accepts on a pull request without a processing label. */
const EXPLICIT_COMMANDS = new Set(['review', 'fix', 'ultrafix']);

/**
 * Whether a pull request comment job may run on this pull request. A
 * processing label opts the whole pull request in. Without one, the job runs
 * only when someone asked for it explicitly: a slash command, an Ultrafix
 * cycle, or a trigger keyword. Intake accepts exactly these on unlabelled
 * pull requests (a running goal's draft PR stays unlabelled until the goal
 * succeeds), so refusing them here would acknowledge a request and then drop
 * it silently. Plain comments on unlabelled pull requests stay skipped.
 */
export async function pullRequestJobAllowed(
    labels: Array<{ name: string }>,
    primaryProcessingLabels: string[],
    request: { data: Pick<CommentJobData, 'commandMode' | 'ultrafixMeta'>; comments: UnprocessedComment[]; correlationId: string },
): Promise<boolean> {
    if (labels.some(label => primaryProcessingLabels.includes(label.name))) return true;
    if (request.data.ultrafixMeta || EXPLICIT_COMMANDS.has(request.data.commandMode ?? 'default')) return true;
    // Loaded lazily: callers' tests enumerate the core exports they mock.
    const { hasValidTriggerLabel, checkCommentTrigger } = await import('@propr/core');
    if (await hasValidTriggerLabel(labels)) return true;
    return request.comments.some(comment => checkCommentTrigger(comment.body, request.correlationId).isTriggered);
}
