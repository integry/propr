/**
 * Pure status machine module for PR status transitions.
 *
 * This module contains no side effects and can be tested without mocks.
 * All functions are pure - they take inputs and return outputs without
 * modifying any external state.
 */

import { PlanIssueStatus } from '../config/planIssueManager.js';

// Re-export the enum for backwards compatibility
export { PlanIssueStatus };

/**
 * Terminal statuses that cannot be transitioned from.
 * Once an issue reaches one of these statuses, it is considered complete.
 */
export const TERMINAL_STATUSES: readonly PlanIssueStatus[] = [PlanIssueStatus.MERGED, PlanIssueStatus.CLOSED] as const;

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
    if (currentStatus === PlanIssueStatus.MERGED || currentStatus === PlanIssueStatus.CLOSED) {
        return null;
    }

    if (action === 'closed') {
        return merged ? PlanIssueStatus.MERGED : PlanIssueStatus.CLOSED;
    }
    if (action === 'opened' || action === 'reopened') {
        return PlanIssueStatus.UNDER_REVIEW;
    }
    if (action === 'synchronize' && currentStatus === PlanIssueStatus.IN_REFINEMENT) {
        return PlanIssueStatus.REFINEMENT_PROCESSING;
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
    return status === PlanIssueStatus.MERGED || status === PlanIssueStatus.CLOSED;
}

/**
 * Checks if a status represents an in-progress state.
 *
 * @param status - The status to check
 * @returns true if the status indicates work in progress
 */
export function isInProgressStatus(status: PlanIssueStatus): boolean {
    return status === PlanIssueStatus.PROCESSING ||
           status === PlanIssueStatus.UNDER_REVIEW ||
           status === PlanIssueStatus.IN_REFINEMENT ||
           status === PlanIssueStatus.REFINEMENT_PROCESSING;
}
