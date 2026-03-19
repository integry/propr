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

/**
 * Interface representing a PullRequestEvent payload for testing handlePlanPRUpdate.
 */
interface MockPullRequestEvent {
    action: string;
    repository: { full_name: string };
    pull_request: {
        number: number;
        title?: string;
        body?: string;
        merged?: boolean;
    };
}

/**
 * Interface representing a plan issue returned from database for testing.
 */
interface MockPlanIssueFromDB {
    repository: string;
    issue_number: number;
    pr_number?: number;
    status: PlanIssueStatus;
    draft_id?: string;
    followup_count?: number;
}

/**
 * Test context for handlePlanPRUpdate tests.
 * Tracks mock function calls and allows verifying behavior.
 */
interface HandlePlanPRUpdateTestContext {
    findPlanIssueByRepoAndPRCalls: Array<{ repository: string; prNumber: number }>;
    findPlanIssueByRepoAndNumberCalls: Array<{ repository: string; issueNumber: number }>;
    linkPRToPlanIssueCalls: Array<{ repository: string; issueNumber: number; prNumber: number }>;
    updatePlanIssueByPRCalls: Array<{ repository: string; prNumber: number; updates: { status?: PlanIssueStatus } }>;
    handleEpicPROpenedCalls: Array<{ repository: string; prNumber: number }>;
    handleMergedPRNextIssueTriggerCalls: Array<{ repository: string; issueNumber: number; draftId: string }>;
    loggedInfo: Array<Record<string, unknown>>;
    loggedWarnings: Array<Record<string, unknown>>;
    loggedErrors: Array<Record<string, unknown>>;
}

/**
 * Simulates the core logic of handlePlanPRUpdate for isolated unit testing.
 * This is a pure function that replicates the handler's behavior without
 * external dependencies (database, GitHub API, logging module initialization).
 *
 * The function returns what actions would be taken, allowing verification of
 * the handler's decision-making logic.
 */
function simulateHandlePlanPRUpdate(
    payload: MockPullRequestEvent,
    context: HandlePlanPRUpdateTestContext,
    mockDependencies: {
        findPlanIssueByRepoAndPR: (repo: string, prNumber: number) => MockPlanIssueFromDB | null;
        findPlanIssueByRepoAndNumber: (repo: string, issueNumber: number) => MockPlanIssueFromDB | null;
    }
): { skipped: boolean; reason?: string; updatedStatus?: PlanIssueStatus | null; linkedIssue?: number; triggeredNextIssue?: boolean } {
    const repository = payload.repository.full_name;
    const prNumber = payload.pull_request.number;
    const action = payload.action;
    const prTitle = payload.pull_request.title || '';

    // Handle Epic PRs - they skip regular processing
    if (prTitle.startsWith('[Epic]')) {
        if (action === 'opened') {
            context.handleEpicPROpenedCalls.push({ repository, prNumber });
        }
        return { skipped: true, reason: 'Epic PR' };
    }

    // Try to find existing plan issue by PR
    context.findPlanIssueByRepoAndPRCalls.push({ repository, prNumber });
    let planIssue = mockDependencies.findPlanIssueByRepoAndPR(repository, prNumber);

    // For new PRs, try to link to a referenced plan issue
    if (!planIssue && action === 'opened') {
        const prBody = payload.pull_request.body || '';
        const issueRefs = prBody.match(/(?:fixes|closes|resolves|fix|close|resolve)\s*#(\d+)/gi);
        if (issueRefs) {
            for (const ref of issueRefs) {
                const match = ref.match(/#(\d+)/);
                if (match) {
                    const linkedIssueNumber = parseInt(match[1], 10);
                    context.findPlanIssueByRepoAndNumberCalls.push({ repository, issueNumber: linkedIssueNumber });
                    const linkedPlanIssue = mockDependencies.findPlanIssueByRepoAndNumber(repository, linkedIssueNumber);
                    if (linkedPlanIssue) {
                        // Don't overwrite existing PR link
                        if (linkedPlanIssue.pr_number && linkedPlanIssue.pr_number !== prNumber) {
                            continue;
                        }
                        context.linkPRToPlanIssueCalls.push({ repository, issueNumber: linkedIssueNumber, prNumber });
                        planIssue = linkedPlanIssue;
                        return {
                            skipped: false,
                            linkedIssue: linkedIssueNumber,
                            updatedStatus: determinePRStatusUpdate(action, payload.pull_request.merged ?? false, planIssue.status)
                        };
                    }
                }
            }
        }
    }

    if (!planIssue) {
        return { skipped: true, reason: 'No plan issue found' };
    }

    // Determine status update
    const newStatus = determinePRStatusUpdate(action, payload.pull_request.merged ?? false, planIssue.status);

    if (newStatus) {
        context.updatePlanIssueByPRCalls.push({ repository, prNumber, updates: { status: newStatus } });
        context.loggedInfo.push({ repository, prNumber, newStatus });
    }

    // Check for merge and next issue triggering
    const isMerged = newStatus === 'merged' || (action === 'closed' && payload.pull_request.merged && planIssue.status === 'merged');
    let triggeredNextIssue = false;

    if (isMerged && planIssue.draft_id) {
        context.handleMergedPRNextIssueTriggerCalls.push({
            repository,
            issueNumber: planIssue.issue_number,
            draftId: planIssue.draft_id
        });
        triggeredNextIssue = true;
    } else if (isMerged && !planIssue.draft_id) {
        context.loggedWarnings.push({ repository, prNumber, hasDraftId: false });
    }

    return { skipped: false, updatedStatus: newStatus, triggeredNextIssue };
}

/**
 * Creates a fresh test context for handlePlanPRUpdate tests.
 */
function createTestContext(): HandlePlanPRUpdateTestContext {
    return {
        findPlanIssueByRepoAndPRCalls: [],
        findPlanIssueByRepoAndNumberCalls: [],
        linkPRToPlanIssueCalls: [],
        updatePlanIssueByPRCalls: [],
        handleEpicPROpenedCalls: [],
        handleMergedPRNextIssueTriggerCalls: [],
        loggedInfo: [],
        loggedWarnings: [],
        loggedErrors: []
    };
}

describe('handlePlanPRUpdate', () => {
    describe('Epic PR handling', () => {
        test('skips processing for Epic PRs with opened action and calls handleEpicPROpened', () => {
            const context = createTestContext();
            const payload: MockPullRequestEvent = {
                action: 'opened',
                repository: { full_name: 'owner/repo' },
                pull_request: {
                    number: 100,
                    title: '[Epic] Implement new feature',
                    body: 'This epic tracks multiple issues fixes #1 fixes #2'
                }
            };

            const result = simulateHandlePlanPRUpdate(payload, context, {
                findPlanIssueByRepoAndPR: () => null,
                findPlanIssueByRepoAndNumber: () => null
            });

            assert.strictEqual(result.skipped, true);
            assert.strictEqual(result.reason, 'Epic PR');
            assert.strictEqual(context.handleEpicPROpenedCalls.length, 1);
            assert.deepStrictEqual(context.handleEpicPROpenedCalls[0], {
                repository: 'owner/repo',
                prNumber: 100
            });
            // Should not attempt to find plan issues
            assert.strictEqual(context.findPlanIssueByRepoAndPRCalls.length, 0);
        });

        test('skips processing for Epic PRs with closed action (does not call handleEpicPROpened)', () => {
            const context = createTestContext();
            const payload: MockPullRequestEvent = {
                action: 'closed',
                repository: { full_name: 'owner/repo' },
                pull_request: {
                    number: 100,
                    title: '[Epic] Implement new feature',
                    merged: true
                }
            };

            const result = simulateHandlePlanPRUpdate(payload, context, {
                findPlanIssueByRepoAndPR: () => null,
                findPlanIssueByRepoAndNumber: () => null
            });

            assert.strictEqual(result.skipped, true);
            assert.strictEqual(result.reason, 'Epic PR');
            // handleEpicPROpened only called for 'opened' action
            assert.strictEqual(context.handleEpicPROpenedCalls.length, 0);
        });

        test('skips processing for Epic PRs with synchronize action', () => {
            const context = createTestContext();
            const payload: MockPullRequestEvent = {
                action: 'synchronize',
                repository: { full_name: 'owner/repo' },
                pull_request: {
                    number: 100,
                    title: '[Epic] Large refactor'
                }
            };

            const result = simulateHandlePlanPRUpdate(payload, context, {
                findPlanIssueByRepoAndPR: () => null,
                findPlanIssueByRepoAndNumber: () => null
            });

            assert.strictEqual(result.skipped, true);
            assert.strictEqual(result.reason, 'Epic PR');
            assert.strictEqual(context.handleEpicPROpenedCalls.length, 0);
        });
    });

    describe('opened action - PR linking', () => {
        test('links PR to referenced plan issue when "fixes #N" is in PR body', () => {
            const context = createTestContext();
            const payload: MockPullRequestEvent = {
                action: 'opened',
                repository: { full_name: 'owner/repo' },
                pull_request: {
                    number: 50,
                    title: 'Fix bug in authentication',
                    body: 'This PR fixes #123 by updating the auth flow'
                }
            };

            const mockPlanIssue: MockPlanIssueFromDB = {
                repository: 'owner/repo',
                issue_number: 123,
                status: 'processing'
            };

            const result = simulateHandlePlanPRUpdate(payload, context, {
                findPlanIssueByRepoAndPR: () => null, // No existing link
                findPlanIssueByRepoAndNumber: (repo, num) => num === 123 ? mockPlanIssue : null
            });

            assert.strictEqual(result.skipped, false);
            assert.strictEqual(result.linkedIssue, 123);
            assert.strictEqual(context.linkPRToPlanIssueCalls.length, 1);
            assert.deepStrictEqual(context.linkPRToPlanIssueCalls[0], {
                repository: 'owner/repo',
                issueNumber: 123,
                prNumber: 50
            });
        });

        test('links PR using "closes #N" syntax', () => {
            const context = createTestContext();
            const payload: MockPullRequestEvent = {
                action: 'opened',
                repository: { full_name: 'owner/repo' },
                pull_request: {
                    number: 51,
                    title: 'Update docs',
                    body: 'Closes #456'
                }
            };

            const mockPlanIssue: MockPlanIssueFromDB = {
                repository: 'owner/repo',
                issue_number: 456,
                status: 'pending'
            };

            const result = simulateHandlePlanPRUpdate(payload, context, {
                findPlanIssueByRepoAndPR: () => null,
                findPlanIssueByRepoAndNumber: (repo, num) => num === 456 ? mockPlanIssue : null
            });

            assert.strictEqual(result.linkedIssue, 456);
        });

        test('links PR using "resolves #N" syntax', () => {
            const context = createTestContext();
            const payload: MockPullRequestEvent = {
                action: 'opened',
                repository: { full_name: 'owner/repo' },
                pull_request: {
                    number: 52,
                    title: 'Fix issue',
                    body: 'Resolves #789'
                }
            };

            const mockPlanIssue: MockPlanIssueFromDB = {
                repository: 'owner/repo',
                issue_number: 789,
                status: 'pending'
            };

            const result = simulateHandlePlanPRUpdate(payload, context, {
                findPlanIssueByRepoAndPR: () => null,
                findPlanIssueByRepoAndNumber: (repo, num) => num === 789 ? mockPlanIssue : null
            });

            assert.strictEqual(result.linkedIssue, 789);
        });

        test('does not overwrite existing PR link on plan issue', () => {
            const context = createTestContext();
            const payload: MockPullRequestEvent = {
                action: 'opened',
                repository: { full_name: 'owner/repo' },
                pull_request: {
                    number: 200,
                    title: 'Another fix',
                    body: 'fixes #123'
                }
            };

            const mockPlanIssue: MockPlanIssueFromDB = {
                repository: 'owner/repo',
                issue_number: 123,
                pr_number: 100, // Already linked to PR #100
                status: 'under_review'
            };

            const result = simulateHandlePlanPRUpdate(payload, context, {
                findPlanIssueByRepoAndPR: () => null,
                findPlanIssueByRepoAndNumber: (repo, num) => num === 123 ? mockPlanIssue : null
            });

            // Should skip because the issue already has a different PR linked
            assert.strictEqual(result.skipped, true);
            assert.strictEqual(result.reason, 'No plan issue found');
            assert.strictEqual(context.linkPRToPlanIssueCalls.length, 0);
        });

        test('does not attempt linking on non-opened actions', () => {
            const context = createTestContext();
            const payload: MockPullRequestEvent = {
                action: 'synchronize',
                repository: { full_name: 'owner/repo' },
                pull_request: {
                    number: 50,
                    title: 'Fix bug',
                    body: 'fixes #123'
                }
            };

            const result = simulateHandlePlanPRUpdate(payload, context, {
                findPlanIssueByRepoAndPR: () => null,
                findPlanIssueByRepoAndNumber: () => null
            });

            assert.strictEqual(result.skipped, true);
            assert.strictEqual(context.findPlanIssueByRepoAndNumberCalls.length, 0);
            assert.strictEqual(context.linkPRToPlanIssueCalls.length, 0);
        });
    });

    describe('opened action - status transition', () => {
        test('transitions plan issue status to under_review when PR is opened', () => {
            const context = createTestContext();
            const payload: MockPullRequestEvent = {
                action: 'opened',
                repository: { full_name: 'owner/repo' },
                pull_request: {
                    number: 50,
                    title: 'Implement feature',
                    body: 'fixes #123'
                }
            };

            const mockPlanIssue: MockPlanIssueFromDB = {
                repository: 'owner/repo',
                issue_number: 123,
                status: 'processing'
            };

            const result = simulateHandlePlanPRUpdate(payload, context, {
                findPlanIssueByRepoAndPR: () => null,
                findPlanIssueByRepoAndNumber: () => mockPlanIssue
            });

            assert.strictEqual(result.updatedStatus, 'under_review');
        });

        test('transitions to under_review for existing linked PR', () => {
            const context = createTestContext();
            const payload: MockPullRequestEvent = {
                action: 'opened',
                repository: { full_name: 'owner/repo' },
                pull_request: {
                    number: 50,
                    title: 'Implement feature'
                }
            };

            const mockPlanIssue: MockPlanIssueFromDB = {
                repository: 'owner/repo',
                issue_number: 123,
                pr_number: 50,
                status: 'processing'
            };

            const result = simulateHandlePlanPRUpdate(payload, context, {
                findPlanIssueByRepoAndPR: () => mockPlanIssue,
                findPlanIssueByRepoAndNumber: () => null
            });

            assert.strictEqual(result.updatedStatus, 'under_review');
            assert.strictEqual(context.updatePlanIssueByPRCalls.length, 1);
        });
    });

    describe('merged action - status and next issue triggering', () => {
        test('transitions to merged status when PR is closed and merged', () => {
            const context = createTestContext();
            const payload: MockPullRequestEvent = {
                action: 'closed',
                repository: { full_name: 'owner/repo' },
                pull_request: {
                    number: 50,
                    title: 'Feature implementation',
                    merged: true
                }
            };

            const mockPlanIssue: MockPlanIssueFromDB = {
                repository: 'owner/repo',
                issue_number: 123,
                pr_number: 50,
                status: 'under_review'
            };

            const result = simulateHandlePlanPRUpdate(payload, context, {
                findPlanIssueByRepoAndPR: () => mockPlanIssue,
                findPlanIssueByRepoAndNumber: () => null
            });

            assert.strictEqual(result.updatedStatus, 'merged');
            assert.strictEqual(context.updatePlanIssueByPRCalls.length, 1);
            assert.deepStrictEqual(context.updatePlanIssueByPRCalls[0].updates, { status: 'merged' });
        });

        test('triggers next pending issue when PR is merged and has draft_id', () => {
            const context = createTestContext();
            const payload: MockPullRequestEvent = {
                action: 'closed',
                repository: { full_name: 'owner/repo' },
                pull_request: {
                    number: 50,
                    merged: true
                }
            };

            const mockPlanIssue: MockPlanIssueFromDB = {
                repository: 'owner/repo',
                issue_number: 123,
                pr_number: 50,
                status: 'under_review',
                draft_id: 'draft-abc-123'
            };

            const result = simulateHandlePlanPRUpdate(payload, context, {
                findPlanIssueByRepoAndPR: () => mockPlanIssue,
                findPlanIssueByRepoAndNumber: () => null
            });

            assert.strictEqual(result.triggeredNextIssue, true);
            assert.strictEqual(context.handleMergedPRNextIssueTriggerCalls.length, 1);
            assert.deepStrictEqual(context.handleMergedPRNextIssueTriggerCalls[0], {
                repository: 'owner/repo',
                issueNumber: 123,
                draftId: 'draft-abc-123'
            });
        });

        test('logs warning when merged but no draft_id', () => {
            const context = createTestContext();
            const payload: MockPullRequestEvent = {
                action: 'closed',
                repository: { full_name: 'owner/repo' },
                pull_request: {
                    number: 50,
                    merged: true
                }
            };

            const mockPlanIssue: MockPlanIssueFromDB = {
                repository: 'owner/repo',
                issue_number: 123,
                pr_number: 50,
                status: 'under_review'
                // No draft_id
            };

            const result = simulateHandlePlanPRUpdate(payload, context, {
                findPlanIssueByRepoAndPR: () => mockPlanIssue,
                findPlanIssueByRepoAndNumber: () => null
            });

            assert.strictEqual(result.triggeredNextIssue, false);
            assert.strictEqual(context.handleMergedPRNextIssueTriggerCalls.length, 0);
            assert.strictEqual(context.loggedWarnings.length, 1);
            assert.strictEqual(context.loggedWarnings[0].hasDraftId, false);
        });

        test('does not trigger next issue when PR is closed but not merged', () => {
            const context = createTestContext();
            const payload: MockPullRequestEvent = {
                action: 'closed',
                repository: { full_name: 'owner/repo' },
                pull_request: {
                    number: 50,
                    merged: false
                }
            };

            const mockPlanIssue: MockPlanIssueFromDB = {
                repository: 'owner/repo',
                issue_number: 123,
                pr_number: 50,
                status: 'under_review',
                draft_id: 'draft-abc-123'
            };

            const result = simulateHandlePlanPRUpdate(payload, context, {
                findPlanIssueByRepoAndPR: () => mockPlanIssue,
                findPlanIssueByRepoAndNumber: () => null
            });

            assert.strictEqual(result.updatedStatus, 'closed');
            assert.strictEqual(result.triggeredNextIssue, false);
            assert.strictEqual(context.handleMergedPRNextIssueTriggerCalls.length, 0);
        });
    });

    describe('race condition handling', () => {
        test('handles race condition where status was already updated to merged', () => {
            const context = createTestContext();
            const payload: MockPullRequestEvent = {
                action: 'closed',
                repository: { full_name: 'owner/repo' },
                pull_request: {
                    number: 50,
                    merged: true
                }
            };

            // Plan issue already marked as merged (race condition)
            const mockPlanIssue: MockPlanIssueFromDB = {
                repository: 'owner/repo',
                issue_number: 123,
                pr_number: 50,
                status: 'merged',
                draft_id: 'draft-abc-123'
            };

            const result = simulateHandlePlanPRUpdate(payload, context, {
                findPlanIssueByRepoAndPR: () => mockPlanIssue,
                findPlanIssueByRepoAndNumber: () => null
            });

            // determinePRStatusUpdate returns null for terminal states
            assert.strictEqual(result.updatedStatus, null);
            // But should still trigger next issue since isMerged check accounts for this
            assert.strictEqual(result.triggeredNextIssue, true);
        });

        test('does not downgrade from merged to under_review on delayed opened event', () => {
            const context = createTestContext();
            const payload: MockPullRequestEvent = {
                action: 'opened',
                repository: { full_name: 'owner/repo' },
                pull_request: {
                    number: 50,
                    title: 'Feature'
                }
            };

            // PR already merged before 'opened' event arrived
            const mockPlanIssue: MockPlanIssueFromDB = {
                repository: 'owner/repo',
                issue_number: 123,
                pr_number: 50,
                status: 'merged'
            };

            const result = simulateHandlePlanPRUpdate(payload, context, {
                findPlanIssueByRepoAndPR: () => mockPlanIssue,
                findPlanIssueByRepoAndNumber: () => null
            });

            assert.strictEqual(result.updatedStatus, null);
            assert.strictEqual(context.updatePlanIssueByPRCalls.length, 0);
        });
    });

    describe('no plan issue found scenarios', () => {
        test('returns early when no plan issue found and action is not opened', () => {
            const context = createTestContext();
            const payload: MockPullRequestEvent = {
                action: 'synchronize',
                repository: { full_name: 'owner/repo' },
                pull_request: {
                    number: 50,
                    title: 'Some PR'
                }
            };

            const result = simulateHandlePlanPRUpdate(payload, context, {
                findPlanIssueByRepoAndPR: () => null,
                findPlanIssueByRepoAndNumber: () => null
            });

            assert.strictEqual(result.skipped, true);
            assert.strictEqual(result.reason, 'No plan issue found');
        });

        test('returns early when PR body has no issue references', () => {
            const context = createTestContext();
            const payload: MockPullRequestEvent = {
                action: 'opened',
                repository: { full_name: 'owner/repo' },
                pull_request: {
                    number: 50,
                    title: 'Some PR',
                    body: 'This PR does some work without referencing issues'
                }
            };

            const result = simulateHandlePlanPRUpdate(payload, context, {
                findPlanIssueByRepoAndPR: () => null,
                findPlanIssueByRepoAndNumber: () => null
            });

            assert.strictEqual(result.skipped, true);
            assert.strictEqual(context.linkPRToPlanIssueCalls.length, 0);
        });

        test('returns early when referenced issue is not a plan issue', () => {
            const context = createTestContext();
            const payload: MockPullRequestEvent = {
                action: 'opened',
                repository: { full_name: 'owner/repo' },
                pull_request: {
                    number: 50,
                    title: 'Some PR',
                    body: 'fixes #999'
                }
            };

            const result = simulateHandlePlanPRUpdate(payload, context, {
                findPlanIssueByRepoAndPR: () => null,
                findPlanIssueByRepoAndNumber: () => null // Issue #999 is not a plan issue
            });

            assert.strictEqual(result.skipped, true);
            assert.strictEqual(context.findPlanIssueByRepoAndNumberCalls.length, 1);
            assert.strictEqual(context.linkPRToPlanIssueCalls.length, 0);
        });
    });

    describe('synchronize action', () => {
        test('transitions to refinement_processing when synchronize on in_refinement status', () => {
            const context = createTestContext();
            const payload: MockPullRequestEvent = {
                action: 'synchronize',
                repository: { full_name: 'owner/repo' },
                pull_request: {
                    number: 50
                }
            };

            const mockPlanIssue: MockPlanIssueFromDB = {
                repository: 'owner/repo',
                issue_number: 123,
                pr_number: 50,
                status: 'in_refinement'
            };

            const result = simulateHandlePlanPRUpdate(payload, context, {
                findPlanIssueByRepoAndPR: () => mockPlanIssue,
                findPlanIssueByRepoAndNumber: () => null
            });

            assert.strictEqual(result.updatedStatus, 'refinement_processing');
            assert.strictEqual(context.updatePlanIssueByPRCalls.length, 1);
        });

        test('does not change status when synchronize on under_review status', () => {
            const context = createTestContext();
            const payload: MockPullRequestEvent = {
                action: 'synchronize',
                repository: { full_name: 'owner/repo' },
                pull_request: {
                    number: 50
                }
            };

            const mockPlanIssue: MockPlanIssueFromDB = {
                repository: 'owner/repo',
                issue_number: 123,
                pr_number: 50,
                status: 'under_review'
            };

            const result = simulateHandlePlanPRUpdate(payload, context, {
                findPlanIssueByRepoAndPR: () => mockPlanIssue,
                findPlanIssueByRepoAndNumber: () => null
            });

            assert.strictEqual(result.updatedStatus, null);
            assert.strictEqual(context.updatePlanIssueByPRCalls.length, 0);
        });
    });

    describe('reopened action', () => {
        test('transitions to under_review when PR is reopened', () => {
            const context = createTestContext();
            const payload: MockPullRequestEvent = {
                action: 'reopened',
                repository: { full_name: 'owner/repo' },
                pull_request: {
                    number: 50
                }
            };

            const mockPlanIssue: MockPlanIssueFromDB = {
                repository: 'owner/repo',
                issue_number: 123,
                pr_number: 50,
                status: 'in_refinement'
            };

            const result = simulateHandlePlanPRUpdate(payload, context, {
                findPlanIssueByRepoAndPR: () => mockPlanIssue,
                findPlanIssueByRepoAndNumber: () => null
            });

            assert.strictEqual(result.updatedStatus, 'under_review');
        });
    });
});
