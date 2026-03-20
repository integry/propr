/**
 * Pure status machine module for PR status transitions.
 *
 * This module contains no side effects and can be tested without mocks.
 * All functions are pure - they take inputs and return outputs without
 * modifying any external state.
 */

/**
 * Status enum for plan issues, representing the lifecycle of an issue.
 * - pending: Issue is waiting to be processed
 * - processing: Issue is currently being worked on
 * - under_review: PR has been opened for review
 * - in_refinement: PR is being refined based on feedback
 * - refinement_processing: Refinement changes are being processed
 * - merged: PR has been merged
 * - closed: Issue/PR closed without merge
 */
export type PlanIssueStatus =
    | 'pending'
    | 'processing'
    | 'under_review'
    | 'in_refinement'
    | 'refinement_processing'
    | 'merged'
    | 'closed';

/**
 * Terminal statuses that cannot be transitioned from.
 * Once an issue reaches one of these statuses, it is considered complete.
 */
export const TERMINAL_STATUSES: readonly PlanIssueStatus[] = ['merged', 'closed'] as const;

/**
 * Determines the new status for a plan issue based on a PR event.
 *
 * This is a pure function that implements a state machine for PR status transitions.
 * It handles race conditions by preventing transitions from terminal states.
 *
 * @param action - The PR event action (e.g., 'opened', 'closed', 'synchronize')
 * @param merged - Whether the PR was merged (only relevant for 'closed' action)
 * @param currentStatus - The current status of the plan issue
 * @returns The new status to transition to, or null if no transition should occur
 *
 * @example
 * // PR opened - transition to under_review
 * determinePRStatusUpdate('opened', false, 'processing') // returns 'under_review'
 *
 * @example
 * // PR merged - transition to merged
 * determinePRStatusUpdate('closed', true, 'under_review') // returns 'merged'
 *
 * @example
 * // Terminal state - no transition
 * determinePRStatusUpdate('opened', false, 'merged') // returns null
 */
export function determinePRStatusUpdate(
    action: string,
    merged: boolean,
    currentStatus: PlanIssueStatus
): PlanIssueStatus | null {
    // Never downgrade from terminal statuses - prevents race conditions where
    // delayed PR events (e.g., 'opened') run after the PR is already merged
    if (currentStatus === 'merged' || currentStatus === 'closed') {
        return null;
    }

    if (action === 'closed') {
        return merged ? 'merged' : 'closed';
    }
    if (action === 'opened' || action === 'reopened') {
        return 'under_review';
    }
    if (action === 'synchronize' && currentStatus === 'in_refinement') {
        return 'refinement_processing';
    }
    return null;
}

/**
 * Checks if a status is a terminal status.
 *
 * @param status - The status to check
 * @returns true if the status is terminal, false otherwise
 */
export function isTerminalStatus(status: PlanIssueStatus): boolean {
    return status === 'merged' || status === 'closed';
}

/**
 * Checks if a status represents an in-progress state.
 *
 * @param status - The status to check
 * @returns true if the status indicates work in progress
 */
export function isInProgressStatus(status: PlanIssueStatus): boolean {
    return status === 'processing' ||
           status === 'under_review' ||
           status === 'in_refinement' ||
           status === 'refinement_processing';
}
