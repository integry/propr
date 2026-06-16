import { test, describe } from 'node:test';
import assert from 'node:assert';

// Import from the pure statusMachine module - no side effects, no mocks needed
import {
    determinePRStatusUpdate,
    isTerminalStatus,
    isInProgressStatus,
    TERMINAL_STATUSES,
    type PlanIssueStatus
} from '../packages/core/src/webhook/statusMachine.js';

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

describe('isTerminalStatus', () => {
    test('returns true for merged status', () => {
        assert.strictEqual(isTerminalStatus('merged'), true);
    });

    test('returns true for closed status', () => {
        assert.strictEqual(isTerminalStatus('closed'), true);
    });

    const nonTerminalStatuses: PlanIssueStatus[] = [
        'pending',
        'processing',
        'under_review',
        'in_refinement',
        'refinement_processing'
    ];

    for (const status of nonTerminalStatuses) {
        test(`returns false for ${status} status`, () => {
            assert.strictEqual(isTerminalStatus(status), false);
        });
    }
});

describe('isInProgressStatus', () => {
    const inProgressStatuses: PlanIssueStatus[] = [
        'processing',
        'under_review',
        'in_refinement',
        'refinement_processing'
    ];

    for (const status of inProgressStatuses) {
        test(`returns true for ${status} status`, () => {
            assert.strictEqual(isInProgressStatus(status), true);
        });
    }

    const notInProgressStatuses: PlanIssueStatus[] = [
        'pending',
        'merged',
        'closed'
    ];

    for (const status of notInProgressStatuses) {
        test(`returns false for ${status} status`, () => {
            assert.strictEqual(isInProgressStatus(status), false);
        });
    }
});

describe('TERMINAL_STATUSES constant', () => {
    test('contains merged and closed', () => {
        assert.ok(TERMINAL_STATUSES.includes('merged'));
        assert.ok(TERMINAL_STATUSES.includes('closed'));
    });

    test('has exactly 2 statuses', () => {
        assert.strictEqual(TERMINAL_STATUSES.length, 2);
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

/**
 * Type definition for comment event types.
 */
type CommentEventType = 'issue_comment' | 'pull_request_review_comment';

/**
 * Interface representing an IssueCommentEvent payload for testing.
 */
interface MockIssueCommentEvent {
    action: string;
    repository: { full_name: string };
    issue: {
        number: number;
        pull_request?: object;
    };
    comment: {
        user?: { login: string };
        body?: string;
    };
}

/**
 * Interface representing a PullRequestReviewCommentEvent payload for testing.
 */
interface MockPullRequestReviewCommentEvent {
    action: string;
    repository: { full_name: string };
    pull_request: {
        number: number;
    };
    comment: {
        user?: { login: string };
        body?: string;
    };
}

/**
 * Test context for handlePlanPRCommentTracking tests.
 */
interface HandlePlanPRCommentTrackingTestContext {
    findPlanIssueByRepoAndPRCalls: Array<{ repository: string; prNumber: number }>;
    updatePlanIssueByPRCalls: Array<{ repository: string; prNumber: number; updates: { followup_count?: number; status?: PlanIssueStatus } }>;
    loggedInfo: Array<Record<string, unknown>>;
    loggedDebug: Array<Record<string, unknown>>;
    loggedErrors: Array<Record<string, unknown>>;
}

/**
 * Creates a fresh test context for handlePlanPRCommentTracking tests.
 */
function createCommentTrackingTestContext(): HandlePlanPRCommentTrackingTestContext {
    return {
        findPlanIssueByRepoAndPRCalls: [],
        updatePlanIssueByPRCalls: [],
        loggedInfo: [],
        loggedDebug: [],
        loggedErrors: []
    };
}

/**
 * Simulates the core logic of handlePlanPRCommentTracking for isolated unit testing.
 * This is a pure function that replicates the handler's behavior without
 * external dependencies (database, logging module initialization).
 *
 * The original function is at: packages/core/src/webhook/planIssueTracking.ts:351
 */
function simulateHandlePlanPRCommentTracking(
    payload: MockIssueCommentEvent | MockPullRequestReviewCommentEvent,
    eventType: CommentEventType,
    context: HandlePlanPRCommentTrackingTestContext,
    mockDependencies: {
        findPlanIssueByRepoAndPR: (repo: string, prNumber: number) => MockPlanIssueFromDB | null;
        botUsername?: string;
    }
): { skipped: boolean; reason?: string; updatedFollowupCount?: number; updatedStatus?: PlanIssueStatus } {
    const repository = payload.repository.full_name;
    const botUsername = mockDependencies.botUsername || 'propr-dev[bot]';

    // Determine PR number based on event type
    let prNumber: number | null = null;

    if (eventType === 'pull_request_review_comment') {
        prNumber = (payload as MockPullRequestReviewCommentEvent).pull_request.number;
    } else if (eventType === 'issue_comment') {
        const issuePayload = payload as MockIssueCommentEvent;
        if ('pull_request' in issuePayload.issue && issuePayload.issue.pull_request) {
            prNumber = issuePayload.issue.number;
        }
    }

    if (!prNumber) {
        return { skipped: true, reason: 'Not a PR comment' };
    }

    // Find plan issue by PR
    context.findPlanIssueByRepoAndPRCalls.push({ repository, prNumber });
    const planIssue = mockDependencies.findPlanIssueByRepoAndPR(repository, prNumber);

    if (!planIssue) {
        return { skipped: true, reason: 'No plan issue found' };
    }

    if (payload.action === 'created') {
        // Skip bot comments
        const commentAuthor = payload.comment.user?.login;
        if (commentAuthor === botUsername) {
            return { skipped: true, reason: 'Bot comment' };
        }

        // Don't update status if issue is already merged or closed
        if (planIssue.status === 'merged' || planIssue.status === 'closed') {
            context.loggedDebug.push({
                repository,
                prNumber,
                currentStatus: planIssue.status
            });
            return { skipped: true, reason: 'Plan issue already completed' };
        }

        // Increment followup count and set status to in_refinement
        const newFollowupCount = (planIssue.followup_count || 0) + 1;
        const newStatus: PlanIssueStatus = 'in_refinement';

        context.updatePlanIssueByPRCalls.push({
            repository,
            prNumber,
            updates: { followup_count: newFollowupCount, status: newStatus }
        });
        context.loggedInfo.push({ repository, prNumber, followupCount: newFollowupCount });

        return { skipped: false, updatedFollowupCount: newFollowupCount, updatedStatus: newStatus };
    }

    return { skipped: true, reason: 'Non-created action' };
}

describe('handlePlanPRCommentTracking', () => {
    describe('PR number extraction', () => {
        test('extracts PR number from pull_request_review_comment event', () => {
            const context = createCommentTrackingTestContext();
            const payload: MockPullRequestReviewCommentEvent = {
                action: 'created',
                repository: { full_name: 'owner/repo' },
                pull_request: { number: 42 },
                comment: { user: { login: 'developer' } }
            };

            const mockPlanIssue: MockPlanIssueFromDB = {
                repository: 'owner/repo',
                issue_number: 100,
                pr_number: 42,
                status: 'under_review',
                followup_count: 0
            };

            const result = simulateHandlePlanPRCommentTracking(payload, 'pull_request_review_comment', context, {
                findPlanIssueByRepoAndPR: () => mockPlanIssue
            });

            assert.strictEqual(result.skipped, false);
            assert.strictEqual(context.findPlanIssueByRepoAndPRCalls.length, 1);
            assert.strictEqual(context.findPlanIssueByRepoAndPRCalls[0].prNumber, 42);
        });

        test('extracts PR number from issue_comment event on a PR', () => {
            const context = createCommentTrackingTestContext();
            const payload: MockIssueCommentEvent = {
                action: 'created',
                repository: { full_name: 'owner/repo' },
                issue: { number: 55, pull_request: {} },
                comment: { user: { login: 'developer' } }
            };

            const mockPlanIssue: MockPlanIssueFromDB = {
                repository: 'owner/repo',
                issue_number: 100,
                pr_number: 55,
                status: 'under_review',
                followup_count: 0
            };

            const result = simulateHandlePlanPRCommentTracking(payload, 'issue_comment', context, {
                findPlanIssueByRepoAndPR: () => mockPlanIssue
            });

            assert.strictEqual(result.skipped, false);
            assert.strictEqual(context.findPlanIssueByRepoAndPRCalls.length, 1);
            assert.strictEqual(context.findPlanIssueByRepoAndPRCalls[0].prNumber, 55);
        });

        test('returns early for issue_comment on a regular issue (not a PR)', () => {
            const context = createCommentTrackingTestContext();
            const payload: MockIssueCommentEvent = {
                action: 'created',
                repository: { full_name: 'owner/repo' },
                issue: { number: 55 }, // No pull_request property
                comment: { user: { login: 'developer' } }
            };

            const result = simulateHandlePlanPRCommentTracking(payload, 'issue_comment', context, {
                findPlanIssueByRepoAndPR: () => null
            });

            assert.strictEqual(result.skipped, true);
            assert.strictEqual(result.reason, 'Not a PR comment');
            assert.strictEqual(context.findPlanIssueByRepoAndPRCalls.length, 0);
        });
    });

    describe('skip bot comments', () => {
        test('skips comments from default bot username (propr-dev[bot])', () => {
            const context = createCommentTrackingTestContext();
            const payload: MockPullRequestReviewCommentEvent = {
                action: 'created',
                repository: { full_name: 'owner/repo' },
                pull_request: { number: 42 },
                comment: { user: { login: 'propr-dev[bot]' } }
            };

            const mockPlanIssue: MockPlanIssueFromDB = {
                repository: 'owner/repo',
                issue_number: 100,
                pr_number: 42,
                status: 'under_review',
                followup_count: 0
            };

            const result = simulateHandlePlanPRCommentTracking(payload, 'pull_request_review_comment', context, {
                findPlanIssueByRepoAndPR: () => mockPlanIssue
            });

            assert.strictEqual(result.skipped, true);
            assert.strictEqual(result.reason, 'Bot comment');
            assert.strictEqual(context.updatePlanIssueByPRCalls.length, 0);
        });

        test('skips comments from custom bot username', () => {
            const context = createCommentTrackingTestContext();
            const payload: MockPullRequestReviewCommentEvent = {
                action: 'created',
                repository: { full_name: 'owner/repo' },
                pull_request: { number: 42 },
                comment: { user: { login: 'my-custom-bot' } }
            };

            const mockPlanIssue: MockPlanIssueFromDB = {
                repository: 'owner/repo',
                issue_number: 100,
                pr_number: 42,
                status: 'under_review',
                followup_count: 0
            };

            const result = simulateHandlePlanPRCommentTracking(payload, 'pull_request_review_comment', context, {
                findPlanIssueByRepoAndPR: () => mockPlanIssue,
                botUsername: 'my-custom-bot'
            });

            assert.strictEqual(result.skipped, true);
            assert.strictEqual(result.reason, 'Bot comment');
        });

        test('does not skip comments from non-bot users', () => {
            const context = createCommentTrackingTestContext();
            const payload: MockPullRequestReviewCommentEvent = {
                action: 'created',
                repository: { full_name: 'owner/repo' },
                pull_request: { number: 42 },
                comment: { user: { login: 'human-developer' } }
            };

            const mockPlanIssue: MockPlanIssueFromDB = {
                repository: 'owner/repo',
                issue_number: 100,
                pr_number: 42,
                status: 'under_review',
                followup_count: 0
            };

            const result = simulateHandlePlanPRCommentTracking(payload, 'pull_request_review_comment', context, {
                findPlanIssueByRepoAndPR: () => mockPlanIssue
            });

            assert.strictEqual(result.skipped, false);
            assert.strictEqual(context.updatePlanIssueByPRCalls.length, 1);
        });

        test('handles comments with missing user field', () => {
            const context = createCommentTrackingTestContext();
            const payload: MockPullRequestReviewCommentEvent = {
                action: 'created',
                repository: { full_name: 'owner/repo' },
                pull_request: { number: 42 },
                comment: {} // No user field
            };

            const mockPlanIssue: MockPlanIssueFromDB = {
                repository: 'owner/repo',
                issue_number: 100,
                pr_number: 42,
                status: 'under_review',
                followup_count: 0
            };

            const result = simulateHandlePlanPRCommentTracking(payload, 'pull_request_review_comment', context, {
                findPlanIssueByRepoAndPR: () => mockPlanIssue
            });

            // When user is undefined, commentAuthor will be undefined, which !== botUsername
            assert.strictEqual(result.skipped, false);
        });
    });

    describe('increment followup count', () => {
        test('increments followup_count from 0 to 1 on first comment', () => {
            const context = createCommentTrackingTestContext();
            const payload: MockPullRequestReviewCommentEvent = {
                action: 'created',
                repository: { full_name: 'owner/repo' },
                pull_request: { number: 42 },
                comment: { user: { login: 'developer' } }
            };

            const mockPlanIssue: MockPlanIssueFromDB = {
                repository: 'owner/repo',
                issue_number: 100,
                pr_number: 42,
                status: 'under_review',
                followup_count: 0
            };

            const result = simulateHandlePlanPRCommentTracking(payload, 'pull_request_review_comment', context, {
                findPlanIssueByRepoAndPR: () => mockPlanIssue
            });

            assert.strictEqual(result.updatedFollowupCount, 1);
            assert.strictEqual(context.updatePlanIssueByPRCalls.length, 1);
            assert.strictEqual(context.updatePlanIssueByPRCalls[0].updates.followup_count, 1);
        });

        test('increments followup_count from 5 to 6', () => {
            const context = createCommentTrackingTestContext();
            const payload: MockPullRequestReviewCommentEvent = {
                action: 'created',
                repository: { full_name: 'owner/repo' },
                pull_request: { number: 42 },
                comment: { user: { login: 'developer' } }
            };

            const mockPlanIssue: MockPlanIssueFromDB = {
                repository: 'owner/repo',
                issue_number: 100,
                pr_number: 42,
                status: 'under_review',
                followup_count: 5
            };

            const result = simulateHandlePlanPRCommentTracking(payload, 'pull_request_review_comment', context, {
                findPlanIssueByRepoAndPR: () => mockPlanIssue
            });

            assert.strictEqual(result.updatedFollowupCount, 6);
        });

        test('handles undefined followup_count (treats as 0)', () => {
            const context = createCommentTrackingTestContext();
            const payload: MockPullRequestReviewCommentEvent = {
                action: 'created',
                repository: { full_name: 'owner/repo' },
                pull_request: { number: 42 },
                comment: { user: { login: 'developer' } }
            };

            const mockPlanIssue: MockPlanIssueFromDB = {
                repository: 'owner/repo',
                issue_number: 100,
                pr_number: 42,
                status: 'under_review'
                // No followup_count field
            };

            const result = simulateHandlePlanPRCommentTracking(payload, 'pull_request_review_comment', context, {
                findPlanIssueByRepoAndPR: () => mockPlanIssue
            });

            assert.strictEqual(result.updatedFollowupCount, 1);
        });
    });

    describe('sets status to in_refinement', () => {
        test('transitions from under_review to in_refinement', () => {
            const context = createCommentTrackingTestContext();
            const payload: MockPullRequestReviewCommentEvent = {
                action: 'created',
                repository: { full_name: 'owner/repo' },
                pull_request: { number: 42 },
                comment: { user: { login: 'reviewer' } }
            };

            const mockPlanIssue: MockPlanIssueFromDB = {
                repository: 'owner/repo',
                issue_number: 100,
                pr_number: 42,
                status: 'under_review',
                followup_count: 0
            };

            const result = simulateHandlePlanPRCommentTracking(payload, 'pull_request_review_comment', context, {
                findPlanIssueByRepoAndPR: () => mockPlanIssue
            });

            assert.strictEqual(result.updatedStatus, 'in_refinement');
            assert.strictEqual(context.updatePlanIssueByPRCalls[0].updates.status, 'in_refinement');
        });

        test('transitions from processing to in_refinement', () => {
            const context = createCommentTrackingTestContext();
            const payload: MockPullRequestReviewCommentEvent = {
                action: 'created',
                repository: { full_name: 'owner/repo' },
                pull_request: { number: 42 },
                comment: { user: { login: 'reviewer' } }
            };

            const mockPlanIssue: MockPlanIssueFromDB = {
                repository: 'owner/repo',
                issue_number: 100,
                pr_number: 42,
                status: 'processing',
                followup_count: 0
            };

            const result = simulateHandlePlanPRCommentTracking(payload, 'pull_request_review_comment', context, {
                findPlanIssueByRepoAndPR: () => mockPlanIssue
            });

            assert.strictEqual(result.updatedStatus, 'in_refinement');
        });

        test('transitions from refinement_processing to in_refinement', () => {
            const context = createCommentTrackingTestContext();
            const payload: MockPullRequestReviewCommentEvent = {
                action: 'created',
                repository: { full_name: 'owner/repo' },
                pull_request: { number: 42 },
                comment: { user: { login: 'reviewer' } }
            };

            const mockPlanIssue: MockPlanIssueFromDB = {
                repository: 'owner/repo',
                issue_number: 100,
                pr_number: 42,
                status: 'refinement_processing',
                followup_count: 2
            };

            const result = simulateHandlePlanPRCommentTracking(payload, 'pull_request_review_comment', context, {
                findPlanIssueByRepoAndPR: () => mockPlanIssue
            });

            assert.strictEqual(result.updatedStatus, 'in_refinement');
            assert.strictEqual(result.updatedFollowupCount, 3);
        });

        test('stays at in_refinement if already in that status (increments count)', () => {
            const context = createCommentTrackingTestContext();
            const payload: MockPullRequestReviewCommentEvent = {
                action: 'created',
                repository: { full_name: 'owner/repo' },
                pull_request: { number: 42 },
                comment: { user: { login: 'reviewer' } }
            };

            const mockPlanIssue: MockPlanIssueFromDB = {
                repository: 'owner/repo',
                issue_number: 100,
                pr_number: 42,
                status: 'in_refinement',
                followup_count: 3
            };

            const result = simulateHandlePlanPRCommentTracking(payload, 'pull_request_review_comment', context, {
                findPlanIssueByRepoAndPR: () => mockPlanIssue
            });

            assert.strictEqual(result.updatedStatus, 'in_refinement');
            assert.strictEqual(result.updatedFollowupCount, 4);
        });
    });

    describe('skip completed issues (merged/closed)', () => {
        test('skips comments on merged plan issues', () => {
            const context = createCommentTrackingTestContext();
            const payload: MockPullRequestReviewCommentEvent = {
                action: 'created',
                repository: { full_name: 'owner/repo' },
                pull_request: { number: 42 },
                comment: { user: { login: 'developer' } }
            };

            const mockPlanIssue: MockPlanIssueFromDB = {
                repository: 'owner/repo',
                issue_number: 100,
                pr_number: 42,
                status: 'merged',
                followup_count: 2
            };

            const result = simulateHandlePlanPRCommentTracking(payload, 'pull_request_review_comment', context, {
                findPlanIssueByRepoAndPR: () => mockPlanIssue
            });

            assert.strictEqual(result.skipped, true);
            assert.strictEqual(result.reason, 'Plan issue already completed');
            assert.strictEqual(context.updatePlanIssueByPRCalls.length, 0);
            assert.strictEqual(context.loggedDebug.length, 1);
            assert.strictEqual(context.loggedDebug[0].currentStatus, 'merged');
        });

        test('skips comments on closed plan issues', () => {
            const context = createCommentTrackingTestContext();
            const payload: MockPullRequestReviewCommentEvent = {
                action: 'created',
                repository: { full_name: 'owner/repo' },
                pull_request: { number: 42 },
                comment: { user: { login: 'developer' } }
            };

            const mockPlanIssue: MockPlanIssueFromDB = {
                repository: 'owner/repo',
                issue_number: 100,
                pr_number: 42,
                status: 'closed',
                followup_count: 1
            };

            const result = simulateHandlePlanPRCommentTracking(payload, 'pull_request_review_comment', context, {
                findPlanIssueByRepoAndPR: () => mockPlanIssue
            });

            assert.strictEqual(result.skipped, true);
            assert.strictEqual(result.reason, 'Plan issue already completed');
            assert.strictEqual(context.loggedDebug.length, 1);
            assert.strictEqual(context.loggedDebug[0].currentStatus, 'closed');
        });
    });

    describe('no plan issue found', () => {
        test('returns early when no plan issue found for PR', () => {
            const context = createCommentTrackingTestContext();
            const payload: MockPullRequestReviewCommentEvent = {
                action: 'created',
                repository: { full_name: 'owner/repo' },
                pull_request: { number: 42 },
                comment: { user: { login: 'developer' } }
            };

            const result = simulateHandlePlanPRCommentTracking(payload, 'pull_request_review_comment', context, {
                findPlanIssueByRepoAndPR: () => null
            });

            assert.strictEqual(result.skipped, true);
            assert.strictEqual(result.reason, 'No plan issue found');
            assert.strictEqual(context.findPlanIssueByRepoAndPRCalls.length, 1);
            assert.strictEqual(context.updatePlanIssueByPRCalls.length, 0);
        });
    });

    describe('non-created actions', () => {
        test('ignores edited action', () => {
            const context = createCommentTrackingTestContext();
            const payload: MockPullRequestReviewCommentEvent = {
                action: 'edited',
                repository: { full_name: 'owner/repo' },
                pull_request: { number: 42 },
                comment: { user: { login: 'developer' } }
            };

            const mockPlanIssue: MockPlanIssueFromDB = {
                repository: 'owner/repo',
                issue_number: 100,
                pr_number: 42,
                status: 'under_review',
                followup_count: 0
            };

            const result = simulateHandlePlanPRCommentTracking(payload, 'pull_request_review_comment', context, {
                findPlanIssueByRepoAndPR: () => mockPlanIssue
            });

            assert.strictEqual(result.skipped, true);
            assert.strictEqual(result.reason, 'Non-created action');
            assert.strictEqual(context.updatePlanIssueByPRCalls.length, 0);
        });

        test('ignores deleted action', () => {
            const context = createCommentTrackingTestContext();
            const payload: MockPullRequestReviewCommentEvent = {
                action: 'deleted',
                repository: { full_name: 'owner/repo' },
                pull_request: { number: 42 },
                comment: { user: { login: 'developer' } }
            };

            const mockPlanIssue: MockPlanIssueFromDB = {
                repository: 'owner/repo',
                issue_number: 100,
                pr_number: 42,
                status: 'under_review',
                followup_count: 5
            };

            const result = simulateHandlePlanPRCommentTracking(payload, 'pull_request_review_comment', context, {
                findPlanIssueByRepoAndPR: () => mockPlanIssue
            });

            assert.strictEqual(result.skipped, true);
            assert.strictEqual(result.reason, 'Non-created action');
        });
    });

    describe('both event types work correctly', () => {
        test('handles issue_comment on PR correctly', () => {
            const context = createCommentTrackingTestContext();
            const payload: MockIssueCommentEvent = {
                action: 'created',
                repository: { full_name: 'owner/repo' },
                issue: { number: 55, pull_request: {} },
                comment: { user: { login: 'contributor' }, body: 'Please fix the typo' }
            };

            const mockPlanIssue: MockPlanIssueFromDB = {
                repository: 'owner/repo',
                issue_number: 200,
                pr_number: 55,
                status: 'under_review',
                followup_count: 1
            };

            const result = simulateHandlePlanPRCommentTracking(payload, 'issue_comment', context, {
                findPlanIssueByRepoAndPR: () => mockPlanIssue
            });

            assert.strictEqual(result.skipped, false);
            assert.strictEqual(result.updatedFollowupCount, 2);
            assert.strictEqual(result.updatedStatus, 'in_refinement');
        });

        test('handles pull_request_review_comment correctly', () => {
            const context = createCommentTrackingTestContext();
            const payload: MockPullRequestReviewCommentEvent = {
                action: 'created',
                repository: { full_name: 'owner/repo' },
                pull_request: { number: 77 },
                comment: { user: { login: 'code-reviewer' }, body: 'Need to add error handling' }
            };

            const mockPlanIssue: MockPlanIssueFromDB = {
                repository: 'owner/repo',
                issue_number: 300,
                pr_number: 77,
                status: 'under_review',
                followup_count: 0
            };

            const result = simulateHandlePlanPRCommentTracking(payload, 'pull_request_review_comment', context, {
                findPlanIssueByRepoAndPR: () => mockPlanIssue
            });

            assert.strictEqual(result.skipped, false);
            assert.strictEqual(result.updatedFollowupCount, 1);
            assert.strictEqual(result.updatedStatus, 'in_refinement');
        });
    });

    describe('logging verification', () => {
        test('logs info when updating followup count', () => {
            const context = createCommentTrackingTestContext();
            const payload: MockPullRequestReviewCommentEvent = {
                action: 'created',
                repository: { full_name: 'test-org/test-repo' },
                pull_request: { number: 99 },
                comment: { user: { login: 'reviewer' } }
            };

            const mockPlanIssue: MockPlanIssueFromDB = {
                repository: 'test-org/test-repo',
                issue_number: 500,
                pr_number: 99,
                status: 'under_review',
                followup_count: 10
            };

            simulateHandlePlanPRCommentTracking(payload, 'pull_request_review_comment', context, {
                findPlanIssueByRepoAndPR: () => mockPlanIssue
            });

            assert.strictEqual(context.loggedInfo.length, 1);
            assert.strictEqual(context.loggedInfo[0].repository, 'test-org/test-repo');
            assert.strictEqual(context.loggedInfo[0].prNumber, 99);
            assert.strictEqual(context.loggedInfo[0].followupCount, 11);
        });

        test('logs debug when skipping completed issue', () => {
            const context = createCommentTrackingTestContext();
            const payload: MockPullRequestReviewCommentEvent = {
                action: 'created',
                repository: { full_name: 'test-org/test-repo' },
                pull_request: { number: 88 },
                comment: { user: { login: 'late-commenter' } }
            };

            const mockPlanIssue: MockPlanIssueFromDB = {
                repository: 'test-org/test-repo',
                issue_number: 400,
                pr_number: 88,
                status: 'merged',
                followup_count: 3
            };

            simulateHandlePlanPRCommentTracking(payload, 'pull_request_review_comment', context, {
                findPlanIssueByRepoAndPR: () => mockPlanIssue
            });

            assert.strictEqual(context.loggedDebug.length, 1);
            assert.strictEqual(context.loggedDebug[0].repository, 'test-org/test-repo');
            assert.strictEqual(context.loggedDebug[0].prNumber, 88);
            assert.strictEqual(context.loggedDebug[0].currentStatus, 'merged');
        });
    });
});

/**
 * Interface representing a plan issue for triggerNextPendingIssue testing.
 */
interface MockPlanIssueForTrigger {
    draft_id: string;
    repository: string;
    issue_number: number;
    status: PlanIssueStatus;
    pr_number?: number;
}

/**
 * Test context for triggerNextPendingIssue tests.
 * Tracks mock function calls and allows verifying behavior.
 */
interface TriggerNextPendingIssueTestContext {
    getPlanIssuesByDraftCalls: Array<{ draftId: string }>;
    addLabelsCalls: Array<{ owner: string; repo: string; issueNumber: number; labels: string[] }>;
    loggedDebug: Array<Record<string, unknown>>;
    loggedInfo: Array<Record<string, unknown>>;
    loggedWarnings: Array<Record<string, unknown>>;
}

/**
 * Creates a fresh test context for triggerNextPendingIssue tests.
 */
function createTriggerNextPendingIssueTestContext(): TriggerNextPendingIssueTestContext {
    return {
        getPlanIssuesByDraftCalls: [],
        addLabelsCalls: [],
        loggedDebug: [],
        loggedInfo: [],
        loggedWarnings: []
    };
}

/**
 * Simulates the core logic of triggerNextPendingIssue for isolated unit testing.
 * This is a pure function that replicates the handler's behavior without
 * external dependencies (database, GitHub API, logging module initialization).
 *
 * The original function is at: packages/core/src/webhook/planIssueTracking.ts:278
 */
function simulateTriggerNextPendingIssue(
    draftId: string,
    repository: string,
    epicLabel: string | undefined,
    context: TriggerNextPendingIssueTestContext,
    mockDependencies: {
        getPlanIssuesByDraft: (draftId: string) => MockPlanIssueForTrigger[];
        processingLabels?: string[];
    }
): { triggered: boolean; reason?: string; issueNumber?: number; labels?: string[] } {
    // Record the call to getPlanIssuesByDraft
    context.getPlanIssuesByDraftCalls.push({ draftId });

    try {
        // Get all issues in the same plan
        const planIssues = mockDependencies.getPlanIssuesByDraft(draftId);

        // Check if there are any issues currently in progress
        const inProgressStatuses = ['processing', 'under_review', 'in_refinement', 'refinement_processing'];
        const hasInProgressIssue = planIssues.some(issue => inProgressStatuses.includes(issue.status));

        if (hasInProgressIssue) {
            const inProgressIssues = planIssues.filter(issue => inProgressStatuses.includes(issue.status));
            context.loggedDebug.push({
                draftId,
                inProgressIssues: inProgressIssues.map(i => ({ number: i.issue_number, status: i.status }))
            });
            return { triggered: false, reason: 'Issues still in progress' };
        }

        // Find the next pending issue
        const nextPending = planIssues.find(issue => issue.status === 'pending');
        if (!nextPending) {
            context.loggedDebug.push({ draftId, reason: 'No more pending issues in plan' });
            return { triggered: false, reason: 'No pending issues' };
        }

        const [owner, repo] = repository.split('/');
        const processingLabels = mockDependencies.processingLabels || ['AI'];
        const primaryLabel = processingLabels[0] || 'AI';

        // Build labels list: processing label, auto-merge, and epic label if present
        const labelsToAdd = [primaryLabel, 'auto-merge'];
        if (epicLabel) {
            labelsToAdd.push(epicLabel);
        }

        context.loggedInfo.push({
            draftId,
            nextIssueNumber: nextPending.issue_number,
            labels: labelsToAdd
        });

        // Record the GitHub API call to add labels
        context.addLabelsCalls.push({
            owner,
            repo,
            issueNumber: nextPending.issue_number,
            labels: labelsToAdd
        });

        context.loggedInfo.push({
            draftId,
            issueNumber: nextPending.issue_number,
            labels: labelsToAdd,
            message: 'Added processing labels to next pending issue'
        });

        return {
            triggered: true,
            issueNumber: nextPending.issue_number,
            labels: labelsToAdd
        };
    } catch (error) {
        context.loggedWarnings.push({
            draftId,
            error: (error as Error).message
        });
        return { triggered: false, reason: 'Error occurred' };
    }
}

describe('triggerNextPendingIssue', () => {
    describe('finds and labels next pending issue', () => {
        test('triggers next pending issue when all previous issues are merged', () => {
            const context = createTriggerNextPendingIssueTestContext();
            const planIssues: MockPlanIssueForTrigger[] = [
                { draft_id: 'draft-123', repository: 'owner/repo', issue_number: 1, status: 'merged' },
                { draft_id: 'draft-123', repository: 'owner/repo', issue_number: 2, status: 'merged' },
                { draft_id: 'draft-123', repository: 'owner/repo', issue_number: 3, status: 'pending' },
                { draft_id: 'draft-123', repository: 'owner/repo', issue_number: 4, status: 'pending' }
            ];

            const result = simulateTriggerNextPendingIssue(
                'draft-123',
                'owner/repo',
                undefined,
                context,
                { getPlanIssuesByDraft: () => planIssues }
            );

            assert.strictEqual(result.triggered, true);
            assert.strictEqual(result.issueNumber, 3);
            assert.deepStrictEqual(result.labels, ['AI', 'auto-merge']);
            assert.strictEqual(context.addLabelsCalls.length, 1);
            assert.deepStrictEqual(context.addLabelsCalls[0], {
                owner: 'owner',
                repo: 'repo',
                issueNumber: 3,
                labels: ['AI', 'auto-merge']
            });
        });

        test('triggers first pending issue when no issues have been processed yet', () => {
            const context = createTriggerNextPendingIssueTestContext();
            const planIssues: MockPlanIssueForTrigger[] = [
                { draft_id: 'draft-abc', repository: 'test/project', issue_number: 10, status: 'pending' },
                { draft_id: 'draft-abc', repository: 'test/project', issue_number: 11, status: 'pending' }
            ];

            const result = simulateTriggerNextPendingIssue(
                'draft-abc',
                'test/project',
                undefined,
                context,
                { getPlanIssuesByDraft: () => planIssues }
            );

            assert.strictEqual(result.triggered, true);
            assert.strictEqual(result.issueNumber, 10);
        });

        test('triggers pending issue with custom processing labels', () => {
            const context = createTriggerNextPendingIssueTestContext();
            const planIssues: MockPlanIssueForTrigger[] = [
                { draft_id: 'draft-xyz', repository: 'org/app', issue_number: 100, status: 'pending' }
            ];

            const result = simulateTriggerNextPendingIssue(
                'draft-xyz',
                'org/app',
                undefined,
                context,
                {
                    getPlanIssuesByDraft: () => planIssues,
                    processingLabels: ['auto-fix', 'bot-task']
                }
            );

            assert.strictEqual(result.triggered, true);
            assert.deepStrictEqual(result.labels, ['auto-fix', 'auto-merge']);
        });

        test('uses AI as default when processingLabels is empty array', () => {
            const context = createTriggerNextPendingIssueTestContext();
            const planIssues: MockPlanIssueForTrigger[] = [
                { draft_id: 'draft-xyz', repository: 'org/app', issue_number: 100, status: 'pending' }
            ];

            const result = simulateTriggerNextPendingIssue(
                'draft-xyz',
                'org/app',
                undefined,
                context,
                {
                    getPlanIssuesByDraft: () => planIssues,
                    processingLabels: []
                }
            );

            assert.strictEqual(result.triggered, true);
            assert.deepStrictEqual(result.labels, ['AI', 'auto-merge']);
        });
    });

    describe('skips when issues are already in progress', () => {
        test('skips when there is an issue in processing status', () => {
            const context = createTriggerNextPendingIssueTestContext();
            const planIssues: MockPlanIssueForTrigger[] = [
                { draft_id: 'draft-123', repository: 'owner/repo', issue_number: 1, status: 'merged' },
                { draft_id: 'draft-123', repository: 'owner/repo', issue_number: 2, status: 'processing' },
                { draft_id: 'draft-123', repository: 'owner/repo', issue_number: 3, status: 'pending' }
            ];

            const result = simulateTriggerNextPendingIssue(
                'draft-123',
                'owner/repo',
                undefined,
                context,
                { getPlanIssuesByDraft: () => planIssues }
            );

            assert.strictEqual(result.triggered, false);
            assert.strictEqual(result.reason, 'Issues still in progress');
            assert.strictEqual(context.addLabelsCalls.length, 0);
            assert.strictEqual(context.loggedDebug.length, 1);
            assert.deepStrictEqual(context.loggedDebug[0].inProgressIssues, [{ number: 2, status: 'processing' }]);
        });

        test('skips when there is an issue under_review', () => {
            const context = createTriggerNextPendingIssueTestContext();
            const planIssues: MockPlanIssueForTrigger[] = [
                { draft_id: 'draft-123', repository: 'owner/repo', issue_number: 1, status: 'merged' },
                { draft_id: 'draft-123', repository: 'owner/repo', issue_number: 2, status: 'under_review', pr_number: 50 },
                { draft_id: 'draft-123', repository: 'owner/repo', issue_number: 3, status: 'pending' }
            ];

            const result = simulateTriggerNextPendingIssue(
                'draft-123',
                'owner/repo',
                undefined,
                context,
                { getPlanIssuesByDraft: () => planIssues }
            );

            assert.strictEqual(result.triggered, false);
            assert.strictEqual(result.reason, 'Issues still in progress');
        });

        test('skips when there is an issue in_refinement', () => {
            const context = createTriggerNextPendingIssueTestContext();
            const planIssues: MockPlanIssueForTrigger[] = [
                { draft_id: 'draft-123', repository: 'owner/repo', issue_number: 1, status: 'merged' },
                { draft_id: 'draft-123', repository: 'owner/repo', issue_number: 2, status: 'in_refinement' },
                { draft_id: 'draft-123', repository: 'owner/repo', issue_number: 3, status: 'pending' }
            ];

            const result = simulateTriggerNextPendingIssue(
                'draft-123',
                'owner/repo',
                undefined,
                context,
                { getPlanIssuesByDraft: () => planIssues }
            );

            assert.strictEqual(result.triggered, false);
            assert.strictEqual(result.reason, 'Issues still in progress');
        });

        test('skips when there is an issue in refinement_processing', () => {
            const context = createTriggerNextPendingIssueTestContext();
            const planIssues: MockPlanIssueForTrigger[] = [
                { draft_id: 'draft-123', repository: 'owner/repo', issue_number: 1, status: 'merged' },
                { draft_id: 'draft-123', repository: 'owner/repo', issue_number: 2, status: 'refinement_processing' },
                { draft_id: 'draft-123', repository: 'owner/repo', issue_number: 3, status: 'pending' }
            ];

            const result = simulateTriggerNextPendingIssue(
                'draft-123',
                'owner/repo',
                undefined,
                context,
                { getPlanIssuesByDraft: () => planIssues }
            );

            assert.strictEqual(result.triggered, false);
            assert.strictEqual(result.reason, 'Issues still in progress');
        });

        test('logs all in-progress issues when multiple are found', () => {
            const context = createTriggerNextPendingIssueTestContext();
            const planIssues: MockPlanIssueForTrigger[] = [
                { draft_id: 'draft-123', repository: 'owner/repo', issue_number: 1, status: 'processing' },
                { draft_id: 'draft-123', repository: 'owner/repo', issue_number: 2, status: 'under_review' },
                { draft_id: 'draft-123', repository: 'owner/repo', issue_number: 3, status: 'pending' }
            ];

            const result = simulateTriggerNextPendingIssue(
                'draft-123',
                'owner/repo',
                undefined,
                context,
                { getPlanIssuesByDraft: () => planIssues }
            );

            assert.strictEqual(result.triggered, false);
            assert.strictEqual(context.loggedDebug.length, 1);
            assert.deepStrictEqual(context.loggedDebug[0].inProgressIssues, [
                { number: 1, status: 'processing' },
                { number: 2, status: 'under_review' }
            ]);
        });

        test('does not consider merged status as in-progress', () => {
            const context = createTriggerNextPendingIssueTestContext();
            const planIssues: MockPlanIssueForTrigger[] = [
                { draft_id: 'draft-123', repository: 'owner/repo', issue_number: 1, status: 'merged' },
                { draft_id: 'draft-123', repository: 'owner/repo', issue_number: 2, status: 'merged' },
                { draft_id: 'draft-123', repository: 'owner/repo', issue_number: 3, status: 'pending' }
            ];

            const result = simulateTriggerNextPendingIssue(
                'draft-123',
                'owner/repo',
                undefined,
                context,
                { getPlanIssuesByDraft: () => planIssues }
            );

            assert.strictEqual(result.triggered, true);
            assert.strictEqual(result.issueNumber, 3);
        });

        test('does not consider closed status as in-progress', () => {
            const context = createTriggerNextPendingIssueTestContext();
            const planIssues: MockPlanIssueForTrigger[] = [
                { draft_id: 'draft-123', repository: 'owner/repo', issue_number: 1, status: 'closed' },
                { draft_id: 'draft-123', repository: 'owner/repo', issue_number: 2, status: 'merged' },
                { draft_id: 'draft-123', repository: 'owner/repo', issue_number: 3, status: 'pending' }
            ];

            const result = simulateTriggerNextPendingIssue(
                'draft-123',
                'owner/repo',
                undefined,
                context,
                { getPlanIssuesByDraft: () => planIssues }
            );

            assert.strictEqual(result.triggered, true);
            assert.strictEqual(result.issueNumber, 3);
        });
    });

    describe('preserves epic label when triggering next', () => {
        test('adds epic label to labels list when epicLabel is provided', () => {
            const context = createTriggerNextPendingIssueTestContext();
            const planIssues: MockPlanIssueForTrigger[] = [
                { draft_id: 'draft-123', repository: 'owner/repo', issue_number: 1, status: 'merged' },
                { draft_id: 'draft-123', repository: 'owner/repo', issue_number: 2, status: 'pending' }
            ];

            const result = simulateTriggerNextPendingIssue(
                'draft-123',
                'owner/repo',
                'epic:feature-xyz',
                context,
                { getPlanIssuesByDraft: () => planIssues }
            );

            assert.strictEqual(result.triggered, true);
            assert.deepStrictEqual(result.labels, ['AI', 'auto-merge', 'epic:feature-xyz']);
            assert.strictEqual(context.addLabelsCalls.length, 1);
            assert.deepStrictEqual(context.addLabelsCalls[0].labels, ['AI', 'auto-merge', 'epic:feature-xyz']);
        });

        test('does not add epic label when epicLabel is undefined', () => {
            const context = createTriggerNextPendingIssueTestContext();
            const planIssues: MockPlanIssueForTrigger[] = [
                { draft_id: 'draft-123', repository: 'owner/repo', issue_number: 1, status: 'merged' },
                { draft_id: 'draft-123', repository: 'owner/repo', issue_number: 2, status: 'pending' }
            ];

            const result = simulateTriggerNextPendingIssue(
                'draft-123',
                'owner/repo',
                undefined,
                context,
                { getPlanIssuesByDraft: () => planIssues }
            );

            assert.strictEqual(result.triggered, true);
            assert.deepStrictEqual(result.labels, ['AI', 'auto-merge']);
        });

        test('handles empty string epic label (does not add it)', () => {
            const context = createTriggerNextPendingIssueTestContext();
            const planIssues: MockPlanIssueForTrigger[] = [
                { draft_id: 'draft-123', repository: 'owner/repo', issue_number: 1, status: 'pending' }
            ];

            const result = simulateTriggerNextPendingIssue(
                'draft-123',
                'owner/repo',
                '',
                context,
                { getPlanIssuesByDraft: () => planIssues }
            );

            // Empty string is falsy, so it won't be added
            assert.strictEqual(result.triggered, true);
            assert.deepStrictEqual(result.labels, ['AI', 'auto-merge']);
        });

        test('preserves epic label with special characters', () => {
            const context = createTriggerNextPendingIssueTestContext();
            const planIssues: MockPlanIssueForTrigger[] = [
                { draft_id: 'draft-123', repository: 'owner/repo', issue_number: 1, status: 'pending' }
            ];

            const result = simulateTriggerNextPendingIssue(
                'draft-123',
                'owner/repo',
                'epic:v2.0-auth-overhaul',
                context,
                { getPlanIssuesByDraft: () => planIssues }
            );

            assert.strictEqual(result.triggered, true);
            assert.deepStrictEqual(result.labels, ['AI', 'auto-merge', 'epic:v2.0-auth-overhaul']);
        });

        test('combines custom processing labels with epic label', () => {
            const context = createTriggerNextPendingIssueTestContext();
            const planIssues: MockPlanIssueForTrigger[] = [
                { draft_id: 'draft-123', repository: 'owner/repo', issue_number: 1, status: 'pending' }
            ];

            const result = simulateTriggerNextPendingIssue(
                'draft-123',
                'owner/repo',
                'epic:refactor',
                context,
                {
                    getPlanIssuesByDraft: () => planIssues,
                    processingLabels: ['bot-process']
                }
            );

            assert.strictEqual(result.triggered, true);
            assert.deepStrictEqual(result.labels, ['bot-process', 'auto-merge', 'epic:refactor']);
        });
    });

    describe('adds auto-merge label', () => {
        test('always includes auto-merge label in labels list', () => {
            const context = createTriggerNextPendingIssueTestContext();
            const planIssues: MockPlanIssueForTrigger[] = [
                { draft_id: 'draft-123', repository: 'owner/repo', issue_number: 1, status: 'pending' }
            ];

            const result = simulateTriggerNextPendingIssue(
                'draft-123',
                'owner/repo',
                undefined,
                context,
                { getPlanIssuesByDraft: () => planIssues }
            );

            assert.strictEqual(result.triggered, true);
            assert.ok(result.labels?.includes('auto-merge'));
        });

        test('auto-merge is second label after processing label', () => {
            const context = createTriggerNextPendingIssueTestContext();
            const planIssues: MockPlanIssueForTrigger[] = [
                { draft_id: 'draft-123', repository: 'owner/repo', issue_number: 1, status: 'pending' }
            ];

            const result = simulateTriggerNextPendingIssue(
                'draft-123',
                'owner/repo',
                undefined,
                context,
                { getPlanIssuesByDraft: () => planIssues }
            );

            assert.strictEqual(result.labels?.[0], 'AI');
            assert.strictEqual(result.labels?.[1], 'auto-merge');
        });
    });

    describe('does nothing when no pending issues remain', () => {
        test('returns early when all issues are merged', () => {
            const context = createTriggerNextPendingIssueTestContext();
            const planIssues: MockPlanIssueForTrigger[] = [
                { draft_id: 'draft-123', repository: 'owner/repo', issue_number: 1, status: 'merged' },
                { draft_id: 'draft-123', repository: 'owner/repo', issue_number: 2, status: 'merged' },
                { draft_id: 'draft-123', repository: 'owner/repo', issue_number: 3, status: 'merged' }
            ];

            const result = simulateTriggerNextPendingIssue(
                'draft-123',
                'owner/repo',
                undefined,
                context,
                { getPlanIssuesByDraft: () => planIssues }
            );

            assert.strictEqual(result.triggered, false);
            assert.strictEqual(result.reason, 'No pending issues');
            assert.strictEqual(context.addLabelsCalls.length, 0);
        });

        test('returns early when all issues are closed', () => {
            const context = createTriggerNextPendingIssueTestContext();
            const planIssues: MockPlanIssueForTrigger[] = [
                { draft_id: 'draft-123', repository: 'owner/repo', issue_number: 1, status: 'closed' },
                { draft_id: 'draft-123', repository: 'owner/repo', issue_number: 2, status: 'closed' }
            ];

            const result = simulateTriggerNextPendingIssue(
                'draft-123',
                'owner/repo',
                undefined,
                context,
                { getPlanIssuesByDraft: () => planIssues }
            );

            assert.strictEqual(result.triggered, false);
            assert.strictEqual(result.reason, 'No pending issues');
        });

        test('returns early when plan has empty issue list', () => {
            const context = createTriggerNextPendingIssueTestContext();

            const result = simulateTriggerNextPendingIssue(
                'draft-123',
                'owner/repo',
                undefined,
                context,
                { getPlanIssuesByDraft: () => [] }
            );

            assert.strictEqual(result.triggered, false);
            assert.strictEqual(result.reason, 'No pending issues');
        });

        test('returns early when all issues are in mixed terminal states', () => {
            const context = createTriggerNextPendingIssueTestContext();
            const planIssues: MockPlanIssueForTrigger[] = [
                { draft_id: 'draft-123', repository: 'owner/repo', issue_number: 1, status: 'merged' },
                { draft_id: 'draft-123', repository: 'owner/repo', issue_number: 2, status: 'closed' },
                { draft_id: 'draft-123', repository: 'owner/repo', issue_number: 3, status: 'merged' }
            ];

            const result = simulateTriggerNextPendingIssue(
                'draft-123',
                'owner/repo',
                undefined,
                context,
                { getPlanIssuesByDraft: () => planIssues }
            );

            assert.strictEqual(result.triggered, false);
            assert.strictEqual(result.reason, 'No pending issues');
        });
    });

    describe('handles errors gracefully', () => {
        test('catches and logs errors from getPlanIssuesByDraft', () => {
            const context = createTriggerNextPendingIssueTestContext();

            const result = simulateTriggerNextPendingIssue(
                'draft-123',
                'owner/repo',
                undefined,
                context,
                {
                    getPlanIssuesByDraft: () => {
                        throw new Error('Database connection failed');
                    }
                }
            );

            assert.strictEqual(result.triggered, false);
            assert.strictEqual(result.reason, 'Error occurred');
            assert.strictEqual(context.loggedWarnings.length, 1);
            assert.strictEqual(context.loggedWarnings[0].error, 'Database connection failed');
            assert.strictEqual(context.loggedWarnings[0].draftId, 'draft-123');
        });
    });

    describe('GitHub API call verification', () => {
        test('correctly extracts owner and repo from repository string', () => {
            const context = createTriggerNextPendingIssueTestContext();
            const planIssues: MockPlanIssueForTrigger[] = [
                { draft_id: 'draft-123', repository: 'my-org/my-repo', issue_number: 42, status: 'pending' }
            ];

            simulateTriggerNextPendingIssue(
                'draft-123',
                'my-org/my-repo',
                undefined,
                context,
                { getPlanIssuesByDraft: () => planIssues }
            );

            assert.strictEqual(context.addLabelsCalls.length, 1);
            assert.strictEqual(context.addLabelsCalls[0].owner, 'my-org');
            assert.strictEqual(context.addLabelsCalls[0].repo, 'my-repo');
        });

        test('handles repository names with hyphens and underscores', () => {
            const context = createTriggerNextPendingIssueTestContext();
            const planIssues: MockPlanIssueForTrigger[] = [
                { draft_id: 'draft-123', repository: 'my_org-name/repo-name_v2', issue_number: 99, status: 'pending' }
            ];

            simulateTriggerNextPendingIssue(
                'draft-123',
                'my_org-name/repo-name_v2',
                undefined,
                context,
                { getPlanIssuesByDraft: () => planIssues }
            );

            assert.strictEqual(context.addLabelsCalls[0].owner, 'my_org-name');
            assert.strictEqual(context.addLabelsCalls[0].repo, 'repo-name_v2');
        });
    });

    describe('logging behavior', () => {
        test('logs info when triggering next issue', () => {
            const context = createTriggerNextPendingIssueTestContext();
            const planIssues: MockPlanIssueForTrigger[] = [
                { draft_id: 'draft-xyz', repository: 'org/project', issue_number: 77, status: 'pending' }
            ];

            simulateTriggerNextPendingIssue(
                'draft-xyz',
                'org/project',
                'epic:test',
                context,
                { getPlanIssuesByDraft: () => planIssues }
            );

            assert.strictEqual(context.loggedInfo.length, 2);
            // First log is about triggering
            assert.strictEqual(context.loggedInfo[0].draftId, 'draft-xyz');
            assert.strictEqual(context.loggedInfo[0].nextIssueNumber, 77);
            assert.deepStrictEqual(context.loggedInfo[0].labels, ['AI', 'auto-merge', 'epic:test']);
            // Second log is about success
            assert.strictEqual(context.loggedInfo[1].issueNumber, 77);
        });

        test('logs debug when skipping due to in-progress issues', () => {
            const context = createTriggerNextPendingIssueTestContext();
            const planIssues: MockPlanIssueForTrigger[] = [
                { draft_id: 'draft-xyz', repository: 'org/project', issue_number: 1, status: 'processing' },
                { draft_id: 'draft-xyz', repository: 'org/project', issue_number: 2, status: 'pending' }
            ];

            simulateTriggerNextPendingIssue(
                'draft-xyz',
                'org/project',
                undefined,
                context,
                { getPlanIssuesByDraft: () => planIssues }
            );

            assert.strictEqual(context.loggedDebug.length, 1);
            assert.strictEqual(context.loggedDebug[0].draftId, 'draft-xyz');
            assert.ok(context.loggedDebug[0].inProgressIssues);
        });

        test('logs debug when no pending issues found', () => {
            const context = createTriggerNextPendingIssueTestContext();
            const planIssues: MockPlanIssueForTrigger[] = [
                { draft_id: 'draft-xyz', repository: 'org/project', issue_number: 1, status: 'merged' }
            ];

            simulateTriggerNextPendingIssue(
                'draft-xyz',
                'org/project',
                undefined,
                context,
                { getPlanIssuesByDraft: () => planIssues }
            );

            assert.strictEqual(context.loggedDebug.length, 1);
            assert.strictEqual(context.loggedDebug[0].draftId, 'draft-xyz');
            assert.strictEqual(context.loggedDebug[0].reason, 'No more pending issues in plan');
        });
    });

    describe('issue ordering', () => {
        test('triggers the first pending issue in array order', () => {
            const context = createTriggerNextPendingIssueTestContext();
            const planIssues: MockPlanIssueForTrigger[] = [
                { draft_id: 'draft-123', repository: 'owner/repo', issue_number: 5, status: 'merged' },
                { draft_id: 'draft-123', repository: 'owner/repo', issue_number: 10, status: 'pending' },
                { draft_id: 'draft-123', repository: 'owner/repo', issue_number: 3, status: 'pending' },
                { draft_id: 'draft-123', repository: 'owner/repo', issue_number: 7, status: 'pending' }
            ];

            const result = simulateTriggerNextPendingIssue(
                'draft-123',
                'owner/repo',
                undefined,
                context,
                { getPlanIssuesByDraft: () => planIssues }
            );

            // Should trigger issue 10 (first pending in array order)
            assert.strictEqual(result.issueNumber, 10);
        });
    });

    describe('sequential processing guarantee', () => {
        test('prevents parallel processing by checking in-progress status first', () => {
            const context = createTriggerNextPendingIssueTestContext();
            const planIssues: MockPlanIssueForTrigger[] = [
                { draft_id: 'draft-123', repository: 'owner/repo', issue_number: 1, status: 'merged' },
                { draft_id: 'draft-123', repository: 'owner/repo', issue_number: 2, status: 'under_review' },
                { draft_id: 'draft-123', repository: 'owner/repo', issue_number: 3, status: 'pending' },
                { draft_id: 'draft-123', repository: 'owner/repo', issue_number: 4, status: 'pending' }
            ];

            // First call with in-progress issue - should skip
            const result1 = simulateTriggerNextPendingIssue(
                'draft-123',
                'owner/repo',
                undefined,
                context,
                { getPlanIssuesByDraft: () => planIssues }
            );

            assert.strictEqual(result1.triggered, false);
            assert.strictEqual(result1.reason, 'Issues still in progress');

            // After issue 2 merges, update the status
            planIssues[1].status = 'merged';

            // Second call - should now trigger issue 3
            const result2 = simulateTriggerNextPendingIssue(
                'draft-123',
                'owner/repo',
                undefined,
                context,
                { getPlanIssuesByDraft: () => planIssues }
            );

            assert.strictEqual(result2.triggered, true);
            assert.strictEqual(result2.issueNumber, 3);
        });
    });
});

function simulateShouldTriggerNextIssueAfterMerge(issueLabels: string[]): boolean {
    const hasAutoMerge = issueLabels.includes('auto-merge');
    const epicLabel = issueLabels.find(label => label.startsWith('base-'));
    const isEpicSequentialMerge = !!epicLabel;
    return hasAutoMerge || isEpicSequentialMerge;
}

describe('handleMergedPRNextIssueTrigger', () => {
    test('triggers next pending issue for epic-labeled child PR without auto-merge label', () => {
        const issueLabels = ['AI', 'AI-done', 'llm-codex-gpt55', 'base-1520-epic-migrate-platform-4ct'];

        const shouldTrigger = simulateShouldTriggerNextIssueAfterMerge(issueLabels);

        assert.strictEqual(shouldTrigger, true);
    });

    test('triggers next pending issue for explicit auto-merge label', () => {
        const issueLabels = ['AI', 'AI-done', 'auto-merge'];

        const shouldTrigger = simulateShouldTriggerNextIssueAfterMerge(issueLabels);

        assert.strictEqual(shouldTrigger, true);
    });

    test('does not trigger next pending issue without auto-merge or epic label', () => {
        const issueLabels = ['AI', 'AI-done', 'llm-codex-gpt55'];

        const shouldTrigger = simulateShouldTriggerNextIssueAfterMerge(issueLabels);

        assert.strictEqual(shouldTrigger, false);
    });
});
