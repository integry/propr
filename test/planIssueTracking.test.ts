import { test, describe } from 'node:test';
import assert from 'node:assert';

// Define PlanIssueStatus type locally to avoid importing from @propr/core
// which triggers module-level initialization (Redis, GitHub auth, etc.)
type PlanIssueStatus =
    | 'pending'
    | 'processing'
    | 'under_review'
    | 'in_refinement'
    | 'refinement_processing'
    | 'merged'
    | 'closed';

/**
 * Pure function extracted from planIssueTracking.ts for testing.
 * This is a copy of the original function to enable isolated unit testing
 * without triggering module-level side effects from @propr/core imports.
 *
 * The original function is at: packages/core/src/webhook/planIssueTracking.ts:166
 */
function determinePRStatusUpdate(
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

describe('determinePRStatusUpdate', () => {
    describe('terminal states (merged, closed) should return null', () => {
        const terminalStatuses: PlanIssueStatus[] = ['merged', 'closed'];
        const allActions = ['opened', 'reopened', 'closed', 'synchronize', 'edited', 'labeled'];

        for (const status of terminalStatuses) {
            for (const action of allActions) {
                test(`returns null for action="${action}" when currentStatus="${status}"`, () => {
                    const result = determinePRStatusUpdate(action, false, status);
                    assert.strictEqual(result, null);
                });

                test(`returns null for action="${action}" with merged=true when currentStatus="${status}"`, () => {
                    const result = determinePRStatusUpdate(action, true, status);
                    assert.strictEqual(result, null);
                });
            }
        }
    });

    describe('closed action transitions', () => {
        const nonTerminalStatuses: PlanIssueStatus[] = [
            'pending',
            'processing',
            'under_review',
            'in_refinement',
            'refinement_processing'
        ];

        for (const status of nonTerminalStatuses) {
            test(`returns "merged" when action="closed" and merged=true from "${status}"`, () => {
                const result = determinePRStatusUpdate('closed', true, status);
                assert.strictEqual(result, 'merged');
            });

            test(`returns "closed" when action="closed" and merged=false from "${status}"`, () => {
                const result = determinePRStatusUpdate('closed', false, status);
                assert.strictEqual(result, 'closed');
            });
        }
    });

    describe('opened/reopened action transitions', () => {
        const nonTerminalStatuses: PlanIssueStatus[] = [
            'pending',
            'processing',
            'under_review',
            'in_refinement',
            'refinement_processing'
        ];

        for (const status of nonTerminalStatuses) {
            test(`returns "under_review" when action="opened" from "${status}"`, () => {
                const result = determinePRStatusUpdate('opened', false, status);
                assert.strictEqual(result, 'under_review');
            });

            test(`returns "under_review" when action="reopened" from "${status}"`, () => {
                const result = determinePRStatusUpdate('reopened', false, status);
                assert.strictEqual(result, 'under_review');
            });
        }
    });

    describe('synchronize action transitions', () => {
        test('returns "refinement_processing" when action="synchronize" and currentStatus="in_refinement"', () => {
            const result = determinePRStatusUpdate('synchronize', false, 'in_refinement');
            assert.strictEqual(result, 'refinement_processing');
        });

        const otherStatuses: PlanIssueStatus[] = [
            'pending',
            'processing',
            'under_review',
            'refinement_processing'
        ];

        for (const status of otherStatuses) {
            test(`returns null when action="synchronize" and currentStatus="${status}"`, () => {
                const result = determinePRStatusUpdate('synchronize', false, status);
                assert.strictEqual(result, null);
            });
        }
    });

    describe('unrecognized actions return null', () => {
        const unrecognizedActions = ['edited', 'labeled', 'unlabeled', 'assigned', 'review_requested', 'converted_to_draft'];
        const nonTerminalStatuses: PlanIssueStatus[] = [
            'pending',
            'processing',
            'under_review',
            'in_refinement',
            'refinement_processing'
        ];

        for (const action of unrecognizedActions) {
            for (const status of nonTerminalStatuses) {
                test(`returns null for action="${action}" when currentStatus="${status}"`, () => {
                    const result = determinePRStatusUpdate(action, false, status);
                    assert.strictEqual(result, null);
                });
            }
        }
    });

    describe('merged flag handling', () => {
        test('merged flag only affects "closed" action behavior', () => {
            // For opened action, merged flag should not change the result
            const openedWithMergedTrue = determinePRStatusUpdate('opened', true, 'pending');
            const openedWithMergedFalse = determinePRStatusUpdate('opened', false, 'pending');
            assert.strictEqual(openedWithMergedTrue, 'under_review');
            assert.strictEqual(openedWithMergedFalse, 'under_review');

            // For synchronize action, merged flag should not change the result
            const syncWithMergedTrue = determinePRStatusUpdate('synchronize', true, 'in_refinement');
            const syncWithMergedFalse = determinePRStatusUpdate('synchronize', false, 'in_refinement');
            assert.strictEqual(syncWithMergedTrue, 'refinement_processing');
            assert.strictEqual(syncWithMergedFalse, 'refinement_processing');
        });
    });

    describe('race condition prevention', () => {
        test('prevents downgrade from merged to under_review on delayed "opened" event', () => {
            // This scenario: PR is merged, then a delayed "opened" event arrives
            const result = determinePRStatusUpdate('opened', false, 'merged');
            assert.strictEqual(result, null);
        });

        test('prevents downgrade from merged to closed on delayed "closed" event without merge flag', () => {
            // This scenario: PR is merged, then a delayed "closed" event arrives with merged=false
            const result = determinePRStatusUpdate('closed', false, 'merged');
            assert.strictEqual(result, null);
        });

        test('prevents downgrade from closed to under_review on delayed "reopened" event', () => {
            // This scenario: Issue is closed, then a delayed "reopened" event arrives
            const result = determinePRStatusUpdate('reopened', false, 'closed');
            assert.strictEqual(result, null);
        });
    });
});
