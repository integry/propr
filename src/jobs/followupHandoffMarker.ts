import type { FollowupHandoffRecord } from './followupHandoffStore.js';

/**
 * Stable machine-readable markers that bind a GitHub comment to one follow-up
 * handoff incarnation. Kept dependency-free so the normal publication path can
 * embed them without pulling recovery modules into its import graph.
 */

type MarkerRecord = Pick<FollowupHandoffRecord, 'repository' | 'pull_request' | 'incarnation'>;

export function handoffCommentMarker(record: MarkerRecord): string {
    return `<!-- propr-followup-handoff:${record.repository}:${record.pull_request}:${record.incarnation} -->`;
}

/** Flags a marked comment as the normal path's own completion, as opposed to a recovery notice. */
export const HANDOFF_NORMAL_COMPLETION_MARKER = '<!-- propr-followup-handoff-delivery:normal-completion -->';

/**
 * Prefix for the normal completion comment. The external publication precedes
 * its durable checkpoint, so restart recovery finds a delivered completion by
 * this marker and checkpoints it instead of overwriting or duplicating it.
 */
export function normalCompletionHandoffMarkers(record: MarkerRecord | null | undefined): string {
    return record ? `${handoffCommentMarker(record)}\n${HANDOFF_NORMAL_COMPLETION_MARKER}` : '';
}

/** Flags a marked comment as the normal path's own failure notice. */
export const HANDOFF_NORMAL_FAILURE_MARKER = '<!-- propr-followup-handoff-delivery:normal-failure -->';

/**
 * Prefix for the normal error path's failure notice. The handoff settles only
 * after the notice is delivered, so restart recovery finds a delivered failure
 * by this marker and reconciles to the settlement's outcome instead of
 * requeueing the answered request or overwriting the notice.
 */
export function normalFailureHandoffMarkers(record: MarkerRecord | null | undefined): string {
    return record ? `${handoffCommentMarker(record)}\n${HANDOFF_NORMAL_FAILURE_MARKER}` : '';
}
