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

/**
 * Interface representing a plan issue for testing.
 */
interface MockPlanIssue {
    status: PlanIssueStatus;
    repository: string;
    issue_number: number;
}

/**
 * Interface representing an IssuesEvent payload for testing.
 */
interface MockIssuesEvent {
    action: string;
    repository: { full_name: string };
    issue: {
        number: number;
        labels?: Array<{ name: string } | string>;
    };
}

/**
 * Pure logic extracted from handlePlanIssueStatusUpdate for isolated testing.
 * This function determines what status transition should occur based on:
 * - The event action ('labeled', 'closed', etc.)
 * - The current plan issue status
 * - The labels on the issue
 * - The configured processing labels (defaults to 'AI')
 *
 * Returns the new status if a transition should occur, null otherwise.
 */
function determineIssueStatusUpdate(
    payload: MockIssuesEvent,
    planIssue: MockPlanIssue,
    processingLabels: string[] = ['AI']
): PlanIssueStatus | null {
    const labels = payload.issue.labels?.map(l => typeof l === 'string' ? l : l.name) ?? [];

    if (payload.action === 'closed') {
        // Don't downgrade from 'merged' to 'closed' - when a PR is merged,
        // GitHub auto-closes the linked issue, but we want to keep 'merged' status
        if (planIssue.status !== 'merged') {
            return 'closed';
        }
        return null;
    }

    if (payload.action === 'labeled') {
        const hasProcessingLabel = labels.some(label => processingLabels.includes(label));
        if (hasProcessingLabel && planIssue.status === 'pending') {
            return 'processing';
        }
    }

    return null;
}

describe('handlePlanIssueStatusUpdate - determineIssueStatusUpdate', () => {
    describe('closed action transitions', () => {
        test('transitions pending to closed when issue is closed', () => {
            const payload: MockIssuesEvent = {
                action: 'closed',
                repository: { full_name: 'owner/repo' },
                issue: { number: 123 }
            };
            const planIssue: MockPlanIssue = {
                status: 'pending',
                repository: 'owner/repo',
                issue_number: 123
            };

            const result = determineIssueStatusUpdate(payload, planIssue);
            assert.strictEqual(result, 'closed');
        });

        test('transitions processing to closed when issue is closed', () => {
            const payload: MockIssuesEvent = {
                action: 'closed',
                repository: { full_name: 'owner/repo' },
                issue: { number: 123 }
            };
            const planIssue: MockPlanIssue = {
                status: 'processing',
                repository: 'owner/repo',
                issue_number: 123
            };

            const result = determineIssueStatusUpdate(payload, planIssue);
            assert.strictEqual(result, 'closed');
        });

        test('transitions under_review to closed when issue is closed', () => {
            const payload: MockIssuesEvent = {
                action: 'closed',
                repository: { full_name: 'owner/repo' },
                issue: { number: 123 }
            };
            const planIssue: MockPlanIssue = {
                status: 'under_review',
                repository: 'owner/repo',
                issue_number: 123
            };

            const result = determineIssueStatusUpdate(payload, planIssue);
            assert.strictEqual(result, 'closed');
        });

        test('transitions in_refinement to closed when issue is closed', () => {
            const payload: MockIssuesEvent = {
                action: 'closed',
                repository: { full_name: 'owner/repo' },
                issue: { number: 123 }
            };
            const planIssue: MockPlanIssue = {
                status: 'in_refinement',
                repository: 'owner/repo',
                issue_number: 123
            };

            const result = determineIssueStatusUpdate(payload, planIssue);
            assert.strictEqual(result, 'closed');
        });

        test('transitions refinement_processing to closed when issue is closed', () => {
            const payload: MockIssuesEvent = {
                action: 'closed',
                repository: { full_name: 'owner/repo' },
                issue: { number: 123 }
            };
            const planIssue: MockPlanIssue = {
                status: 'refinement_processing',
                repository: 'owner/repo',
                issue_number: 123
            };

            const result = determineIssueStatusUpdate(payload, planIssue);
            assert.strictEqual(result, 'closed');
        });
    });

    describe('merged to closed downgrade prevention', () => {
        test('does NOT downgrade from merged to closed when issue is auto-closed after PR merge', () => {
            // This is the critical bug fix scenario: when a PR is merged, GitHub auto-closes
            // the linked issue, triggering a 'closed' event. We must not downgrade the status.
            const payload: MockIssuesEvent = {
                action: 'closed',
                repository: { full_name: 'owner/repo' },
                issue: { number: 123 }
            };
            const planIssue: MockPlanIssue = {
                status: 'merged',
                repository: 'owner/repo',
                issue_number: 123
            };

            const result = determineIssueStatusUpdate(payload, planIssue);
            assert.strictEqual(result, null, 'Should not downgrade from merged to closed');
        });

        test('returns null when attempting to close an already merged issue', () => {
            const payload: MockIssuesEvent = {
                action: 'closed',
                repository: { full_name: 'owner/repo' },
                issue: { number: 456, labels: [{ name: 'bug' }] }
            };
            const planIssue: MockPlanIssue = {
                status: 'merged',
                repository: 'owner/repo',
                issue_number: 456
            };

            const result = determineIssueStatusUpdate(payload, planIssue);
            assert.strictEqual(result, null);
        });
    });

    describe('labeled action transitions to processing', () => {
        test('transitions pending to processing when AI label is added', () => {
            const payload: MockIssuesEvent = {
                action: 'labeled',
                repository: { full_name: 'owner/repo' },
                issue: { number: 123, labels: [{ name: 'AI' }] }
            };
            const planIssue: MockPlanIssue = {
                status: 'pending',
                repository: 'owner/repo',
                issue_number: 123
            };

            const result = determineIssueStatusUpdate(payload, planIssue);
            assert.strictEqual(result, 'processing');
        });

        test('transitions pending to processing with custom processing label', () => {
            const payload: MockIssuesEvent = {
                action: 'labeled',
                repository: { full_name: 'owner/repo' },
                issue: { number: 123, labels: [{ name: 'auto-fix' }] }
            };
            const planIssue: MockPlanIssue = {
                status: 'pending',
                repository: 'owner/repo',
                issue_number: 123
            };

            const result = determineIssueStatusUpdate(payload, planIssue, ['auto-fix', 'AI']);
            assert.strictEqual(result, 'processing');
        });

        test('transitions pending to processing when one of multiple processing labels is present', () => {
            const payload: MockIssuesEvent = {
                action: 'labeled',
                repository: { full_name: 'owner/repo' },
                issue: { number: 123, labels: [{ name: 'bug' }, { name: 'fix-me' }] }
            };
            const planIssue: MockPlanIssue = {
                status: 'pending',
                repository: 'owner/repo',
                issue_number: 123
            };

            const result = determineIssueStatusUpdate(payload, planIssue, ['AI', 'fix-me']);
            assert.strictEqual(result, 'processing');
        });

        test('handles string labels correctly', () => {
            const payload: MockIssuesEvent = {
                action: 'labeled',
                repository: { full_name: 'owner/repo' },
                issue: { number: 123, labels: ['AI', 'enhancement'] }
            };
            const planIssue: MockPlanIssue = {
                status: 'pending',
                repository: 'owner/repo',
                issue_number: 123
            };

            const result = determineIssueStatusUpdate(payload, planIssue);
            assert.strictEqual(result, 'processing');
        });
    });

    describe('labeled action - no transition when not pending', () => {
        const nonPendingStatuses: PlanIssueStatus[] = [
            'processing',
            'under_review',
            'in_refinement',
            'refinement_processing',
            'merged',
            'closed'
        ];

        for (const status of nonPendingStatuses) {
            test(`returns null when labeled with AI but status is "${status}"`, () => {
                const payload: MockIssuesEvent = {
                    action: 'labeled',
                    repository: { full_name: 'owner/repo' },
                    issue: { number: 123, labels: [{ name: 'AI' }] }
                };
                const planIssue: MockPlanIssue = {
                    status,
                    repository: 'owner/repo',
                    issue_number: 123
                };

                const result = determineIssueStatusUpdate(payload, planIssue);
                assert.strictEqual(result, null);
            });
        }
    });

    describe('labeled action - no transition without processing label', () => {
        test('returns null when labeled with non-processing label on pending issue', () => {
            const payload: MockIssuesEvent = {
                action: 'labeled',
                repository: { full_name: 'owner/repo' },
                issue: { number: 123, labels: [{ name: 'bug' }, { name: 'enhancement' }] }
            };
            const planIssue: MockPlanIssue = {
                status: 'pending',
                repository: 'owner/repo',
                issue_number: 123
            };

            const result = determineIssueStatusUpdate(payload, planIssue);
            assert.strictEqual(result, null);
        });

        test('returns null when issue has no labels', () => {
            const payload: MockIssuesEvent = {
                action: 'labeled',
                repository: { full_name: 'owner/repo' },
                issue: { number: 123, labels: [] }
            };
            const planIssue: MockPlanIssue = {
                status: 'pending',
                repository: 'owner/repo',
                issue_number: 123
            };

            const result = determineIssueStatusUpdate(payload, planIssue);
            assert.strictEqual(result, null);
        });

        test('returns null when labels is undefined', () => {
            const payload: MockIssuesEvent = {
                action: 'labeled',
                repository: { full_name: 'owner/repo' },
                issue: { number: 123 }
            };
            const planIssue: MockPlanIssue = {
                status: 'pending',
                repository: 'owner/repo',
                issue_number: 123
            };

            const result = determineIssueStatusUpdate(payload, planIssue);
            assert.strictEqual(result, null);
        });
    });

    describe('unrecognized actions return null', () => {
        const unrecognizedActions = ['opened', 'reopened', 'edited', 'unlabeled', 'assigned', 'milestoned'];

        for (const action of unrecognizedActions) {
            test(`returns null for action="${action}"`, () => {
                const payload: MockIssuesEvent = {
                    action,
                    repository: { full_name: 'owner/repo' },
                    issue: { number: 123, labels: [{ name: 'AI' }] }
                };
                const planIssue: MockPlanIssue = {
                    status: 'pending',
                    repository: 'owner/repo',
                    issue_number: 123
                };

                const result = determineIssueStatusUpdate(payload, planIssue);
                assert.strictEqual(result, null);
            });
        }
    });

    describe('edge cases', () => {
        test('handles mixed label types (string and object)', () => {
            const payload: MockIssuesEvent = {
                action: 'labeled',
                repository: { full_name: 'owner/repo' },
                issue: {
                    number: 123,
                    labels: ['bug', { name: 'AI' }, 'enhancement']
                }
            };
            const planIssue: MockPlanIssue = {
                status: 'pending',
                repository: 'owner/repo',
                issue_number: 123
            };

            const result = determineIssueStatusUpdate(payload, planIssue);
            assert.strictEqual(result, 'processing');
        });

        test('case-sensitive label matching', () => {
            const payload: MockIssuesEvent = {
                action: 'labeled',
                repository: { full_name: 'owner/repo' },
                issue: { number: 123, labels: [{ name: 'ai' }] } // lowercase 'ai'
            };
            const planIssue: MockPlanIssue = {
                status: 'pending',
                repository: 'owner/repo',
                issue_number: 123
            };

            // Default processing labels is ['AI'], so lowercase 'ai' should not match
            const result = determineIssueStatusUpdate(payload, planIssue);
            assert.strictEqual(result, null);
        });

        test('already closed issue receives closed event (idempotent)', () => {
            const payload: MockIssuesEvent = {
                action: 'closed',
                repository: { full_name: 'owner/repo' },
                issue: { number: 123 }
            };
            const planIssue: MockPlanIssue = {
                status: 'closed',
                repository: 'owner/repo',
                issue_number: 123
            };

            // Even though status is already 'closed', the function returns 'closed'
            // The actual handler should check if newStatus !== currentStatus before updating
            const result = determineIssueStatusUpdate(payload, planIssue);
            assert.strictEqual(result, 'closed');
        });
    });
});
