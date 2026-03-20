import { test, describe, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert';

/**
 * E2E Test: Webhook Issue Events Simulation
 *
 * These tests simulate GitHub webhook events for issues and verify
 * that the appropriate daemon actions are triggered:
 * - labeled: Triggers issue processing when a primary processing label is added
 * - closed: Updates plan issue status to closed
 * - reopened: Updates plan issue status (re-enables processing)
 *
 * The tests mock the webhook handler infrastructure to simulate events
 * without requiring actual GitHub webhook delivery.
 */

// --- Types ---

interface MockLabel {
    id: number;
    name: string;
    color: string;
    default: boolean;
    description: string | null;
}

interface MockIssue {
    id: number;
    number: number;
    title: string;
    html_url: string;
    labels: MockLabel[];
    state: 'open' | 'closed';
    created_at: string;
    updated_at: string;
    body: string | null;
}

interface MockRepository {
    id: number;
    name: string;
    full_name: string;
    owner: {
        login: string;
        id: number;
    };
    html_url: string;
    default_branch: string;
}

interface MockSender {
    login: string;
    id: number;
    type: string;
}

interface IssuesLabeledPayload {
    action: 'labeled';
    issue: MockIssue;
    label: MockLabel;
    repository: MockRepository;
    sender: MockSender;
}

interface IssuesClosedPayload {
    action: 'closed';
    issue: MockIssue;
    repository: MockRepository;
    sender: MockSender;
}

interface IssuesReopenedPayload {
    action: 'reopened';
    issue: MockIssue;
    repository: MockRepository;
    sender: MockSender;
}

type IssuesEventPayload = IssuesLabeledPayload | IssuesClosedPayload | IssuesReopenedPayload;

interface DetectedIssue {
    id: number;
    number: number;
    title: string;
    url: string;
    repoOwner: string;
    repoName: string;
    labels: string[];
    createdAt: string;
    updatedAt: string;
}

interface ProcessedEvent {
    type: 'issue_labeled' | 'issue_closed' | 'issue_reopened' | 'issue_processed';
    payload: IssuesEventPayload | DetectedIssue;
    correlationId: string;
    timestamp: Date;
}

interface MockWebhookHandler {
    processedEvents: ProcessedEvent[];
    issueProcessor: ((issue: DetectedIssue, correlationId: string) => Promise<void>) | null;
    planIssueUpdates: Array<{
        action: string;
        repository: string;
        issueNumber: number;
        newStatus?: string;
    }>;
}

// --- Mock Factory ---

function createMockLabel(name: string, id = Math.floor(Math.random() * 1000000)): MockLabel {
    return {
        id,
        name,
        color: '0366d6',
        default: false,
        description: null
    };
}

function createMockIssue(
    number: number,
    labels: string[] = [],
    state: 'open' | 'closed' = 'open'
): MockIssue {
    return {
        id: number * 1000,
        number,
        title: `Test Issue #${number}`,
        html_url: `https://github.com/testowner/testrepo/issues/${number}`,
        labels: labels.map(name => createMockLabel(name)),
        state,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        body: `Test issue body for #${number}`
    };
}

function createMockRepository(owner = 'testowner', name = 'testrepo'): MockRepository {
    return {
        id: 123456,
        name,
        full_name: `${owner}/${name}`,
        owner: {
            login: owner,
            id: 789
        },
        html_url: `https://github.com/${owner}/${name}`,
        default_branch: 'main'
    };
}

function createMockSender(): MockSender {
    return {
        login: 'testuser',
        id: 456,
        type: 'User'
    };
}

// --- Mock Webhook Handler ---

function createMockWebhookHandler(): MockWebhookHandler & {
    processIssuesEvent: (payload: IssuesEventPayload, correlationId: string) => Promise<void>;
    registerIssueProcessor: (processor: (issue: DetectedIssue, correlationId: string) => Promise<void>) => void;
    clear: () => void;
} {
    const state: MockWebhookHandler = {
        processedEvents: [],
        issueProcessor: null,
        planIssueUpdates: []
    };

    return {
        ...state,

        /**
         * Simulates the webhookHandler.processWebhookEvent for issues events.
         * This mimics the behavior in packages/core/src/webhook/webhookHandler.ts
         */
        async processIssuesEvent(payload: IssuesEventPayload, correlationId: string): Promise<void> {
            // Record the event
            const eventType = payload.action === 'labeled' ? 'issue_labeled' :
                             payload.action === 'closed' ? 'issue_closed' :
                             'issue_reopened';

            state.processedEvents.push({
                type: eventType,
                payload,
                correlationId,
                timestamp: new Date()
            });

            // Handle labeled event - triggers issue processing
            if (payload.action === 'labeled') {
                const labeledPayload = payload as IssuesLabeledPayload;
                const [owner, repo] = labeledPayload.repository.full_name.split('/');

                const detectedIssue: DetectedIssue = {
                    id: labeledPayload.issue.id,
                    number: labeledPayload.issue.number,
                    title: labeledPayload.issue.title,
                    url: labeledPayload.issue.html_url,
                    repoOwner: owner,
                    repoName: repo,
                    labels: labeledPayload.issue.labels.map(l => l.name),
                    createdAt: labeledPayload.issue.created_at,
                    updatedAt: labeledPayload.issue.updated_at
                };

                if (state.issueProcessor) {
                    await state.issueProcessor(detectedIssue, correlationId);
                    state.processedEvents.push({
                        type: 'issue_processed',
                        payload: detectedIssue,
                        correlationId,
                        timestamp: new Date()
                    });
                }
            }

            // Handle closed event - updates plan issue status
            if (payload.action === 'closed') {
                state.planIssueUpdates.push({
                    action: 'closed',
                    repository: payload.repository.full_name,
                    issueNumber: payload.issue.number,
                    newStatus: 'closed'
                });
            }

            // Handle reopened event - updates plan issue status
            if (payload.action === 'reopened') {
                state.planIssueUpdates.push({
                    action: 'reopened',
                    repository: payload.repository.full_name,
                    issueNumber: payload.issue.number,
                    newStatus: 'pending'
                });
            }
        },

        registerIssueProcessor(processor: (issue: DetectedIssue, correlationId: string) => Promise<void>): void {
            state.issueProcessor = processor;
        },

        clear(): void {
            state.processedEvents = [];
            state.issueProcessor = null;
            state.planIssueUpdates = [];
        }
    };
}

// --- Mock Queue for Daemon Actions ---

interface MockQueueJob {
    id: string;
    name: string;
    data: {
        repoOwner: string;
        repoName: string;
        number: number;
        triggeringLabel?: string;
        correlationId: string;
    };
    status: 'waiting' | 'active' | 'completed' | 'failed';
}

function createMockIssueQueue(): {
    jobs: Map<string, MockQueueJob>;
    add: (name: string, data: MockQueueJob['data'], options?: { jobId?: string }) => Promise<MockQueueJob | null>;
    getActive: () => Promise<MockQueueJob[]>;
    getWaiting: () => Promise<MockQueueJob[]>;
    clear: () => void;
} {
    const jobs = new Map<string, MockQueueJob>();

    return {
        jobs,

        async add(name: string, data: MockQueueJob['data'], options: { jobId?: string } = {}): Promise<MockQueueJob | null> {
            const jobId = options.jobId || `job-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;

            // BullMQ-like duplicate rejection
            if (jobs.has(jobId)) {
                return null;
            }

            const job: MockQueueJob = {
                id: jobId,
                name,
                data,
                status: 'waiting'
            };

            jobs.set(jobId, job);
            return job;
        },

        async getActive(): Promise<MockQueueJob[]> {
            return Array.from(jobs.values()).filter(j => j.status === 'active');
        },

        async getWaiting(): Promise<MockQueueJob[]> {
            return Array.from(jobs.values()).filter(j => j.status === 'waiting');
        },

        clear(): void {
            jobs.clear();
        }
    };
}

// --- Tests ---

describe('E2E Webhook Issue Events Simulation', () => {
    let webhookHandler: ReturnType<typeof createMockWebhookHandler>;
    let issueQueue: ReturnType<typeof createMockIssueQueue>;

    beforeEach(() => {
        webhookHandler = createMockWebhookHandler();
        issueQueue = createMockIssueQueue();

        // Register issue processor that enqueues jobs (simulates daemon behavior)
        webhookHandler.registerIssueProcessor(async (issue, correlationId) => {
            const jobId = `issue-${issue.repoOwner}-${issue.repoName}-${issue.number}`;
            await issueQueue.add('processGitHubIssue', {
                repoOwner: issue.repoOwner,
                repoName: issue.repoName,
                number: issue.number,
                triggeringLabel: issue.labels.find(l => l === 'AI') || issue.labels[0],
                correlationId
            }, { jobId });
        });
    });

    afterEach(() => {
        webhookHandler.clear();
        issueQueue.clear();
    });

    describe('Labeled Event Simulation', () => {
        test('triggers issue processing when AI label is added', async () => {
            const payload: IssuesLabeledPayload = {
                action: 'labeled',
                issue: createMockIssue(42, ['AI']),
                label: createMockLabel('AI'),
                repository: createMockRepository(),
                sender: createMockSender()
            };

            await webhookHandler.processIssuesEvent(payload, 'corr-labeled-001');

            // Verify event was recorded
            const labeledEvents = webhookHandler.processedEvents.filter(e => e.type === 'issue_labeled');
            assert.strictEqual(labeledEvents.length, 1, 'Should record one labeled event');

            // Verify issue was processed
            const processedEvents = webhookHandler.processedEvents.filter(e => e.type === 'issue_processed');
            assert.strictEqual(processedEvents.length, 1, 'Should process the issue');

            // Verify job was enqueued
            const waitingJobs = await issueQueue.getWaiting();
            assert.strictEqual(waitingJobs.length, 1, 'Should enqueue one job');
            assert.strictEqual(waitingJobs[0]?.data.number, 42, 'Job should be for issue #42');
            assert.strictEqual(waitingJobs[0]?.data.triggeringLabel, 'AI', 'Triggering label should be AI');
        });

        test('handles multiple labels on issue', async () => {
            const payload: IssuesLabeledPayload = {
                action: 'labeled',
                issue: createMockIssue(43, ['bug', 'AI', 'priority-high']),
                label: createMockLabel('AI'),
                repository: createMockRepository(),
                sender: createMockSender()
            };

            await webhookHandler.processIssuesEvent(payload, 'corr-labeled-002');

            const processedEvents = webhookHandler.processedEvents.filter(e => e.type === 'issue_processed');
            assert.strictEqual(processedEvents.length, 1, 'Should process issue with multiple labels');

            const detectedIssue = processedEvents[0]?.payload as DetectedIssue;
            assert.deepStrictEqual(detectedIssue.labels, ['bug', 'AI', 'priority-high'], 'Should preserve all labels');
        });

        test('prevents duplicate job creation on rapid label events', async () => {
            const payload1: IssuesLabeledPayload = {
                action: 'labeled',
                issue: createMockIssue(44, ['AI']),
                label: createMockLabel('AI'),
                repository: createMockRepository(),
                sender: createMockSender()
            };

            const payload2: IssuesLabeledPayload = {
                action: 'labeled',
                issue: createMockIssue(44, ['AI', 'enhancement']),
                label: createMockLabel('enhancement'),
                repository: createMockRepository(),
                sender: createMockSender()
            };

            // Simulate rapid webhook events
            await webhookHandler.processIssuesEvent(payload1, 'corr-labeled-003a');
            await webhookHandler.processIssuesEvent(payload2, 'corr-labeled-003b');

            // Both events should be recorded
            const labeledEvents = webhookHandler.processedEvents.filter(e => e.type === 'issue_labeled');
            assert.strictEqual(labeledEvents.length, 2, 'Should record both labeled events');

            // But only one job should exist (deduplication by jobId)
            const waitingJobs = await issueQueue.getWaiting();
            assert.strictEqual(waitingJobs.length, 1, 'Should only have one job due to deduplication');
        });

        test('creates separate jobs for different issues', async () => {
            const payload1: IssuesLabeledPayload = {
                action: 'labeled',
                issue: createMockIssue(45, ['AI']),
                label: createMockLabel('AI'),
                repository: createMockRepository(),
                sender: createMockSender()
            };

            const payload2: IssuesLabeledPayload = {
                action: 'labeled',
                issue: createMockIssue(46, ['AI']),
                label: createMockLabel('AI'),
                repository: createMockRepository(),
                sender: createMockSender()
            };

            await webhookHandler.processIssuesEvent(payload1, 'corr-labeled-004a');
            await webhookHandler.processIssuesEvent(payload2, 'corr-labeled-004b');

            const waitingJobs = await issueQueue.getWaiting();
            assert.strictEqual(waitingJobs.length, 2, 'Should create jobs for both issues');

            const issueNumbers = waitingJobs.map(j => j.data.number).sort((a, b) => a - b);
            assert.deepStrictEqual(issueNumbers, [45, 46], 'Should have jobs for issues 45 and 46');
        });

        test('extracts correct repository information', async () => {
            const payload: IssuesLabeledPayload = {
                action: 'labeled',
                issue: createMockIssue(47, ['AI']),
                label: createMockLabel('AI'),
                repository: createMockRepository('myorg', 'myrepo'),
                sender: createMockSender()
            };

            await webhookHandler.processIssuesEvent(payload, 'corr-labeled-005');

            const waitingJobs = await issueQueue.getWaiting();
            assert.strictEqual(waitingJobs[0]?.data.repoOwner, 'myorg', 'Should extract correct owner');
            assert.strictEqual(waitingJobs[0]?.data.repoName, 'myrepo', 'Should extract correct repo name');
        });
    });

    describe('Closed Event Simulation', () => {
        test('records closed event and updates plan issue status', async () => {
            const payload: IssuesClosedPayload = {
                action: 'closed',
                issue: createMockIssue(50, ['AI'], 'closed'),
                repository: createMockRepository(),
                sender: createMockSender()
            };

            await webhookHandler.processIssuesEvent(payload, 'corr-closed-001');

            // Verify event was recorded
            const closedEvents = webhookHandler.processedEvents.filter(e => e.type === 'issue_closed');
            assert.strictEqual(closedEvents.length, 1, 'Should record one closed event');

            // Verify plan issue update was tracked
            assert.strictEqual(webhookHandler.planIssueUpdates.length, 1, 'Should track plan issue update');
            assert.strictEqual(webhookHandler.planIssueUpdates[0]?.action, 'closed', 'Action should be closed');
            assert.strictEqual(webhookHandler.planIssueUpdates[0]?.issueNumber, 50, 'Should update issue #50');
            assert.strictEqual(webhookHandler.planIssueUpdates[0]?.newStatus, 'closed', 'New status should be closed');
        });

        test('does not trigger issue processing on close', async () => {
            const payload: IssuesClosedPayload = {
                action: 'closed',
                issue: createMockIssue(51, ['AI'], 'closed'),
                repository: createMockRepository(),
                sender: createMockSender()
            };

            await webhookHandler.processIssuesEvent(payload, 'corr-closed-002');

            // Should NOT create a job (closed issues are not processed)
            const waitingJobs = await issueQueue.getWaiting();
            assert.strictEqual(waitingJobs.length, 0, 'Should not enqueue job for closed issue');

            // Should NOT record issue_processed event
            const processedEvents = webhookHandler.processedEvents.filter(e => e.type === 'issue_processed');
            assert.strictEqual(processedEvents.length, 0, 'Should not process closed issue');
        });

        test('handles closing issues without AI label', async () => {
            const payload: IssuesClosedPayload = {
                action: 'closed',
                issue: createMockIssue(52, ['bug', 'wontfix'], 'closed'),
                repository: createMockRepository(),
                sender: createMockSender()
            };

            await webhookHandler.processIssuesEvent(payload, 'corr-closed-003');

            const closedEvents = webhookHandler.processedEvents.filter(e => e.type === 'issue_closed');
            assert.strictEqual(closedEvents.length, 1, 'Should record closed event even without AI label');
        });
    });

    describe('Reopened Event Simulation', () => {
        test('records reopened event and updates plan issue status', async () => {
            const payload: IssuesReopenedPayload = {
                action: 'reopened',
                issue: createMockIssue(60, ['AI'], 'open'),
                repository: createMockRepository(),
                sender: createMockSender()
            };

            await webhookHandler.processIssuesEvent(payload, 'corr-reopened-001');

            // Verify event was recorded
            const reopenedEvents = webhookHandler.processedEvents.filter(e => e.type === 'issue_reopened');
            assert.strictEqual(reopenedEvents.length, 1, 'Should record one reopened event');

            // Verify plan issue update was tracked
            assert.strictEqual(webhookHandler.planIssueUpdates.length, 1, 'Should track plan issue update');
            assert.strictEqual(webhookHandler.planIssueUpdates[0]?.action, 'reopened', 'Action should be reopened');
            assert.strictEqual(webhookHandler.planIssueUpdates[0]?.issueNumber, 60, 'Should update issue #60');
            assert.strictEqual(webhookHandler.planIssueUpdates[0]?.newStatus, 'pending', 'New status should be pending');
        });

        test('does not trigger new processing on reopen alone', async () => {
            // Reopening alone should not trigger processing - only labeled event does
            const payload: IssuesReopenedPayload = {
                action: 'reopened',
                issue: createMockIssue(61, ['AI'], 'open'),
                repository: createMockRepository(),
                sender: createMockSender()
            };

            await webhookHandler.processIssuesEvent(payload, 'corr-reopened-002');

            const waitingJobs = await issueQueue.getWaiting();
            assert.strictEqual(waitingJobs.length, 0, 'Reopened alone should not enqueue job');
        });

        test('handles reopening issues that were already processed', async () => {
            const repository = createMockRepository();

            // First: label and process
            const labelPayload: IssuesLabeledPayload = {
                action: 'labeled',
                issue: createMockIssue(62, ['AI']),
                label: createMockLabel('AI'),
                repository,
                sender: createMockSender()
            };
            await webhookHandler.processIssuesEvent(labelPayload, 'corr-reopen-flow-001');

            // Second: close
            const closePayload: IssuesClosedPayload = {
                action: 'closed',
                issue: createMockIssue(62, ['AI'], 'closed'),
                repository,
                sender: createMockSender()
            };
            await webhookHandler.processIssuesEvent(closePayload, 'corr-reopen-flow-002');

            // Third: reopen
            const reopenPayload: IssuesReopenedPayload = {
                action: 'reopened',
                issue: createMockIssue(62, ['AI'], 'open'),
                repository,
                sender: createMockSender()
            };
            await webhookHandler.processIssuesEvent(reopenPayload, 'corr-reopen-flow-003');

            // Verify complete event sequence
            const events = webhookHandler.processedEvents;
            assert.strictEqual(events.filter(e => e.type === 'issue_labeled').length, 1, 'Should have one labeled event');
            assert.strictEqual(events.filter(e => e.type === 'issue_closed').length, 1, 'Should have one closed event');
            assert.strictEqual(events.filter(e => e.type === 'issue_reopened').length, 1, 'Should have one reopened event');

            // Verify plan issue updates sequence
            assert.strictEqual(webhookHandler.planIssueUpdates.length, 2, 'Should have closed and reopened updates');
            assert.strictEqual(webhookHandler.planIssueUpdates[0]?.action, 'closed');
            assert.strictEqual(webhookHandler.planIssueUpdates[1]?.action, 'reopened');
        });
    });

    describe('Event Correlation', () => {
        test('preserves correlation ID through event processing', async () => {
            const payload: IssuesLabeledPayload = {
                action: 'labeled',
                issue: createMockIssue(70, ['AI']),
                label: createMockLabel('AI'),
                repository: createMockRepository(),
                sender: createMockSender()
            };

            const correlationId = 'test-correlation-12345';
            await webhookHandler.processIssuesEvent(payload, correlationId);

            // All events should have the same correlation ID
            for (const event of webhookHandler.processedEvents) {
                assert.strictEqual(event.correlationId, correlationId, 'Correlation ID should be preserved');
            }

            // Job should have correlation ID
            const waitingJobs = await issueQueue.getWaiting();
            assert.strictEqual(waitingJobs[0]?.data.correlationId, correlationId, 'Job should have correlation ID');
        });

        test('different events have different correlation IDs', async () => {
            const issue = createMockIssue(71, ['AI']);
            const repository = createMockRepository();

            const payload1: IssuesLabeledPayload = {
                action: 'labeled',
                issue,
                label: createMockLabel('AI'),
                repository,
                sender: createMockSender()
            };

            const payload2: IssuesClosedPayload = {
                action: 'closed',
                issue: { ...issue, state: 'closed' },
                repository,
                sender: createMockSender()
            };

            await webhookHandler.processIssuesEvent(payload1, 'corr-event-001');
            await webhookHandler.processIssuesEvent(payload2, 'corr-event-002');

            // We have 2 correlation IDs from the webhookHandler calls
            // corr-event-001 is used for both labeled and processed events (same flow)
            // corr-event-002 is used for closed event
            const correlationIds = new Set(webhookHandler.processedEvents.map(e => e.correlationId));
            assert.strictEqual(correlationIds.size, 2, 'Should have 2 unique correlation IDs (labeled/processed shares one, closed has another)');
            assert.ok(correlationIds.has('corr-event-001'), 'Should have labeled/processed correlation ID');
            assert.ok(correlationIds.has('corr-event-002'), 'Should have closed correlation ID');
        });
    });

    describe('Complex Event Sequences', () => {
        test('handles label -> close -> reopen -> label sequence', async () => {
            const repository = createMockRepository();
            const sender = createMockSender();
            let issue = createMockIssue(80, []);

            // 1. Add AI label
            issue = createMockIssue(80, ['AI']);
            await webhookHandler.processIssuesEvent({
                action: 'labeled',
                issue,
                label: createMockLabel('AI'),
                repository,
                sender
            } as IssuesLabeledPayload, 'seq-001');

            // 2. Close issue
            issue = createMockIssue(80, ['AI'], 'closed');
            await webhookHandler.processIssuesEvent({
                action: 'closed',
                issue,
                repository,
                sender
            } as IssuesClosedPayload, 'seq-002');

            // 3. Reopen issue
            issue = createMockIssue(80, ['AI'], 'open');
            await webhookHandler.processIssuesEvent({
                action: 'reopened',
                issue,
                repository,
                sender
            } as IssuesReopenedPayload, 'seq-003');

            // 4. Add another label (triggers processing again)
            issue = createMockIssue(80, ['AI', 'enhancement'], 'open');
            await webhookHandler.processIssuesEvent({
                action: 'labeled',
                issue,
                label: createMockLabel('enhancement'),
                repository,
                sender
            } as IssuesLabeledPayload, 'seq-004');

            // Verify complete sequence
            const eventTypes = webhookHandler.processedEvents.map(e => e.type);
            assert.ok(eventTypes.includes('issue_labeled'), 'Should have labeled events');
            assert.ok(eventTypes.includes('issue_closed'), 'Should have closed event');
            assert.ok(eventTypes.includes('issue_reopened'), 'Should have reopened event');
            assert.ok(eventTypes.includes('issue_processed'), 'Should have processed events');

            // Second label event should not create a new job (deduplication)
            const waitingJobs = await issueQueue.getWaiting();
            assert.strictEqual(waitingJobs.length, 1, 'Should have only one job due to deduplication');
        });

        test('handles concurrent events from multiple issues', async () => {
            const repository = createMockRepository();
            const sender = createMockSender();

            // Simulate concurrent webhook deliveries
            const promises = [
                webhookHandler.processIssuesEvent({
                    action: 'labeled',
                    issue: createMockIssue(90, ['AI']),
                    label: createMockLabel('AI'),
                    repository,
                    sender
                } as IssuesLabeledPayload, 'concurrent-001'),
                webhookHandler.processIssuesEvent({
                    action: 'labeled',
                    issue: createMockIssue(91, ['AI']),
                    label: createMockLabel('AI'),
                    repository,
                    sender
                } as IssuesLabeledPayload, 'concurrent-002'),
                webhookHandler.processIssuesEvent({
                    action: 'closed',
                    issue: createMockIssue(92, ['AI'], 'closed'),
                    repository,
                    sender
                } as IssuesClosedPayload, 'concurrent-003'),
            ];

            await Promise.all(promises);

            // All events should be recorded
            assert.strictEqual(webhookHandler.processedEvents.length, 5, 'Should record all events (2 labeled + 2 processed + 1 closed)');

            // Two jobs should be created (for issues 90 and 91)
            const waitingJobs = await issueQueue.getWaiting();
            assert.strictEqual(waitingJobs.length, 2, 'Should create jobs for issues 90 and 91');

            // Closed issue should update plan status but not create job
            assert.strictEqual(webhookHandler.planIssueUpdates.length, 1, 'Should have one plan issue update (closed)');
        });
    });

    describe('Edge Cases', () => {
        test('handles empty labels array', async () => {
            const payload: IssuesLabeledPayload = {
                action: 'labeled',
                issue: createMockIssue(100, []),
                label: createMockLabel('AI'),
                repository: createMockRepository(),
                sender: createMockSender()
            };

            // Update issue to have the label
            payload.issue.labels = [createMockLabel('AI')];

            await webhookHandler.processIssuesEvent(payload, 'edge-001');

            const processedEvents = webhookHandler.processedEvents.filter(e => e.type === 'issue_processed');
            assert.strictEqual(processedEvents.length, 1, 'Should process even if issue had no labels before');
        });

        test('handles special characters in repository name', async () => {
            const payload: IssuesLabeledPayload = {
                action: 'labeled',
                issue: createMockIssue(101, ['AI']),
                label: createMockLabel('AI'),
                repository: createMockRepository('my-org', 'my-repo-name'),
                sender: createMockSender()
            };

            await webhookHandler.processIssuesEvent(payload, 'edge-002');

            const waitingJobs = await issueQueue.getWaiting();
            assert.strictEqual(waitingJobs[0]?.data.repoOwner, 'my-org');
            assert.strictEqual(waitingJobs[0]?.data.repoName, 'my-repo-name');
        });

        test('handles large issue numbers', async () => {
            const payload: IssuesLabeledPayload = {
                action: 'labeled',
                issue: createMockIssue(999999, ['AI']),
                label: createMockLabel('AI'),
                repository: createMockRepository(),
                sender: createMockSender()
            };

            await webhookHandler.processIssuesEvent(payload, 'edge-003');

            const waitingJobs = await issueQueue.getWaiting();
            assert.strictEqual(waitingJobs[0]?.data.number, 999999, 'Should handle large issue numbers');
        });

        test('records timestamp for each event', async () => {
            const beforeTime = new Date();

            const payload: IssuesLabeledPayload = {
                action: 'labeled',
                issue: createMockIssue(102, ['AI']),
                label: createMockLabel('AI'),
                repository: createMockRepository(),
                sender: createMockSender()
            };

            await webhookHandler.processIssuesEvent(payload, 'edge-004');

            const afterTime = new Date();

            for (const event of webhookHandler.processedEvents) {
                assert.ok(event.timestamp >= beforeTime, 'Event timestamp should be after test start');
                assert.ok(event.timestamp <= afterTime, 'Event timestamp should be before test end');
            }
        });
    });
});

// --- PR Event Types ---

interface MockPullRequest {
    id: number;
    number: number;
    title: string;
    html_url: string;
    state: 'open' | 'closed';
    merged: boolean;
    body: string | null;
    head: {
        ref: string;
        sha: string;
    };
    base: {
        ref: string;
        sha: string;
    };
    labels: MockLabel[];
    created_at: string;
    updated_at: string;
    merged_at: string | null;
}

interface PullRequestOpenedPayload {
    action: 'opened';
    pull_request: MockPullRequest;
    repository: MockRepository;
    sender: MockSender;
}

interface PullRequestClosedPayload {
    action: 'closed';
    pull_request: MockPullRequest;
    repository: MockRepository;
    sender: MockSender;
}

interface PullRequestLabeledPayload {
    action: 'labeled';
    pull_request: MockPullRequest;
    label: MockLabel;
    repository: MockRepository;
    sender: MockSender;
}

interface PullRequestSynchronizePayload {
    action: 'synchronize';
    pull_request: MockPullRequest;
    repository: MockRepository;
    sender: MockSender;
}

type PullRequestEventPayload = PullRequestOpenedPayload | PullRequestClosedPayload | PullRequestLabeledPayload | PullRequestSynchronizePayload;

// --- PR Event Types for Mock Handler ---

interface ProcessedPREvent {
    type: 'pr_opened' | 'pr_closed' | 'pr_merged' | 'pr_labeled' | 'pr_synchronized';
    payload: PullRequestEventPayload;
    correlationId: string;
    timestamp: Date;
}

interface LinkedPlanIssue {
    repository: string;
    issueNumber: number;
    prNumber: number;
    status: string;
}

interface MockPRWebhookHandler {
    processedEvents: ProcessedPREvent[];
    linkedPlanIssues: LinkedPlanIssue[];
    statusUpdates: Array<{
        action: string;
        repository: string;
        prNumber: number;
        newStatus: string;
    }>;
    nextIssueTriggers: Array<{
        draftId: string;
        repository: string;
        triggeredIssueNumber: number;
    }>;
}

// --- Mock Factory for PR Events ---

function createMockPullRequest(
    number: number,
    body: string | null = null,
    state: 'open' | 'closed' = 'open',
    merged = false,
    labels: string[] = []
): MockPullRequest {
    return {
        id: number * 2000,
        number,
        title: `Test PR #${number}`,
        html_url: `https://github.com/testowner/testrepo/pull/${number}`,
        state,
        merged,
        body,
        head: {
            ref: `feature-branch-${number}`,
            sha: `abc123${number}`
        },
        base: {
            ref: 'main',
            sha: `def456${number}`
        },
        labels: labels.map(name => createMockLabel(name)),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        merged_at: merged ? new Date().toISOString() : null
    };
}

// --- Mock PR Webhook Handler ---

function createMockPRWebhookHandler(): MockPRWebhookHandler & {
    processPullRequestEvent: (payload: PullRequestEventPayload, correlationId: string) => Promise<void>;
    registerPlanIssue: (repository: string, issueNumber: number, draftId: string, status?: string) => void;
    getPlanIssueStatus: (repository: string, issueNumber: number) => string | null;
    clear: () => void;
} {
    const state: MockPRWebhookHandler = {
        processedEvents: [],
        linkedPlanIssues: [],
        statusUpdates: [],
        nextIssueTriggers: []
    };

    // Mock plan issues database
    const planIssues = new Map<string, { issueNumber: number; draftId: string; status: string; prNumber?: number }>();

    return {
        ...state,

        /**
         * Simulates PR event processing based on webhookHandler.ts behavior.
         * This includes:
         * - Linking PRs to issues via "fixes #X" references
         * - Status updates when PR is opened, merged, or closed
         * - Triggering next pending issue on merge
         */
        async processPullRequestEvent(payload: PullRequestEventPayload, correlationId: string): Promise<void> {
            const [owner, repo] = payload.repository.full_name.split('/');
            const repository = payload.repository.full_name;
            const prNumber = payload.pull_request.number;

            // Record the event
            let eventType: ProcessedPREvent['type'];
            if (payload.action === 'opened') eventType = 'pr_opened';
            else if (payload.action === 'closed' && payload.pull_request.merged) eventType = 'pr_merged';
            else if (payload.action === 'closed') eventType = 'pr_closed';
            else if (payload.action === 'labeled') eventType = 'pr_labeled';
            else eventType = 'pr_synchronized';

            state.processedEvents.push({
                type: eventType,
                payload,
                correlationId,
                timestamp: new Date()
            });

            // Handle PR opened - link to issue via "fixes #X" reference
            if (payload.action === 'opened') {
                const prBody = payload.pull_request.body || '';
                const issueRefs = prBody.match(/(?:fixes|closes|resolves|fix|close|resolve)\s*#(\d+)/gi);

                if (issueRefs) {
                    for (const ref of issueRefs) {
                        const match = ref.match(/#(\d+)/);
                        if (match) {
                            const linkedIssueNumber = parseInt(match[1], 10);
                            const issueKey = `${repository}:${linkedIssueNumber}`;
                            const planIssue = planIssues.get(issueKey);

                            if (planIssue) {
                                // Link PR to plan issue
                                planIssue.prNumber = prNumber;
                                state.linkedPlanIssues.push({
                                    repository,
                                    issueNumber: linkedIssueNumber,
                                    prNumber,
                                    status: planIssue.status
                                });

                                // Update status to under_review
                                planIssue.status = 'under_review';
                                state.statusUpdates.push({
                                    action: 'opened',
                                    repository,
                                    prNumber,
                                    newStatus: 'under_review'
                                });
                            }
                        }
                    }
                }
            }

            // Handle PR closed (merged or not)
            if (payload.action === 'closed') {
                // Find the plan issue linked to this PR
                const linkedIssue = Array.from(planIssues.entries()).find(([_, issue]) => issue.prNumber === prNumber);

                if (linkedIssue) {
                    const [issueKey, planIssue] = linkedIssue;
                    const newStatus = payload.pull_request.merged ? 'merged' : 'closed';

                    // Update status
                    planIssue.status = newStatus;
                    state.statusUpdates.push({
                        action: payload.pull_request.merged ? 'merged' : 'closed',
                        repository,
                        prNumber,
                        newStatus
                    });

                    // Trigger next issue if merged
                    if (payload.pull_request.merged && planIssue.draftId) {
                        // Find next pending issue in the same draft
                        const sameDraftIssues = Array.from(planIssues.entries())
                            .filter(([_, issue]) => issue.draftId === planIssue.draftId)
                            .sort((a, b) => a[1].issueNumber - b[1].issueNumber);

                        const nextPending = sameDraftIssues.find(([_, issue]) => issue.status === 'pending');

                        if (nextPending) {
                            const [_, nextIssue] = nextPending;
                            nextIssue.status = 'processing';
                            state.nextIssueTriggers.push({
                                draftId: planIssue.draftId,
                                repository,
                                triggeredIssueNumber: nextIssue.issueNumber
                            });
                        }
                    }
                }
            }
        },

        registerPlanIssue(repository: string, issueNumber: number, draftId: string, status = 'pending'): void {
            const key = `${repository}:${issueNumber}`;
            planIssues.set(key, { issueNumber, draftId, status });
        },

        getPlanIssueStatus(repository: string, issueNumber: number): string | null {
            const key = `${repository}:${issueNumber}`;
            return planIssues.get(key)?.status ?? null;
        },

        clear(): void {
            state.processedEvents = [];
            state.linkedPlanIssues = [];
            state.statusUpdates = [];
            state.nextIssueTriggers = [];
            planIssues.clear();
        }
    };
}

// --- PR Webhook Tests ---

describe('E2E Webhook PR Events Simulation', () => {
    let prWebhookHandler: ReturnType<typeof createMockPRWebhookHandler>;

    beforeEach(() => {
        prWebhookHandler = createMockPRWebhookHandler();
    });

    afterEach(() => {
        prWebhookHandler.clear();
    });

    describe('PR Opened Event Simulation', () => {
        test('links PR to plan issue when body contains fixes reference', async () => {
            // Register a plan issue first
            prWebhookHandler.registerPlanIssue('testowner/testrepo', 42, 'draft-001');

            const payload: PullRequestOpenedPayload = {
                action: 'opened',
                pull_request: createMockPullRequest(100, 'Fixes #42 - implementing feature'),
                repository: createMockRepository(),
                sender: createMockSender()
            };

            await prWebhookHandler.processPullRequestEvent(payload, 'corr-pr-opened-001');

            // Verify event was recorded
            const openedEvents = prWebhookHandler.processedEvents.filter(e => e.type === 'pr_opened');
            assert.strictEqual(openedEvents.length, 1, 'Should record one opened event');

            // Verify PR was linked to plan issue
            assert.strictEqual(prWebhookHandler.linkedPlanIssues.length, 1, 'Should link PR to plan issue');
            assert.strictEqual(prWebhookHandler.linkedPlanIssues[0]?.issueNumber, 42, 'Should link to issue #42');
            assert.strictEqual(prWebhookHandler.linkedPlanIssues[0]?.prNumber, 100, 'Should link PR #100');
        });

        test('updates plan issue status to under_review when PR is opened', async () => {
            prWebhookHandler.registerPlanIssue('testowner/testrepo', 43, 'draft-002', 'processing');

            const payload: PullRequestOpenedPayload = {
                action: 'opened',
                pull_request: createMockPullRequest(101, 'Closes #43'),
                repository: createMockRepository(),
                sender: createMockSender()
            };

            await prWebhookHandler.processPullRequestEvent(payload, 'corr-pr-opened-002');

            // Verify status update
            assert.strictEqual(prWebhookHandler.statusUpdates.length, 1, 'Should record status update');
            assert.strictEqual(prWebhookHandler.statusUpdates[0]?.newStatus, 'under_review', 'Status should be under_review');
            assert.strictEqual(prWebhookHandler.getPlanIssueStatus('testowner/testrepo', 43), 'under_review');
        });

        test('handles multiple issue references in PR body', async () => {
            prWebhookHandler.registerPlanIssue('testowner/testrepo', 44, 'draft-003');
            prWebhookHandler.registerPlanIssue('testowner/testrepo', 45, 'draft-003');

            const payload: PullRequestOpenedPayload = {
                action: 'opened',
                pull_request: createMockPullRequest(102, 'Fixes #44 and Resolves #45'),
                repository: createMockRepository(),
                sender: createMockSender()
            };

            await prWebhookHandler.processPullRequestEvent(payload, 'corr-pr-opened-003');

            // Verify both issues were linked
            assert.strictEqual(prWebhookHandler.linkedPlanIssues.length, 2, 'Should link to both issues');
            const linkedNumbers = prWebhookHandler.linkedPlanIssues.map(l => l.issueNumber).sort((a, b) => a - b);
            assert.deepStrictEqual(linkedNumbers, [44, 45], 'Should link to issues 44 and 45');
        });

        test('ignores PR without issue references', async () => {
            const payload: PullRequestOpenedPayload = {
                action: 'opened',
                pull_request: createMockPullRequest(103, 'Some feature without issue reference'),
                repository: createMockRepository(),
                sender: createMockSender()
            };

            await prWebhookHandler.processPullRequestEvent(payload, 'corr-pr-opened-004');

            // Event should be recorded
            assert.strictEqual(prWebhookHandler.processedEvents.length, 1);
            // But no linking should occur
            assert.strictEqual(prWebhookHandler.linkedPlanIssues.length, 0, 'Should not link any issues');
        });

        test('ignores references to non-existent plan issues', async () => {
            // No plan issues registered
            const payload: PullRequestOpenedPayload = {
                action: 'opened',
                pull_request: createMockPullRequest(104, 'Fixes #999'),
                repository: createMockRepository(),
                sender: createMockSender()
            };

            await prWebhookHandler.processPullRequestEvent(payload, 'corr-pr-opened-005');

            assert.strictEqual(prWebhookHandler.linkedPlanIssues.length, 0, 'Should not link non-existent issues');
        });

        test('handles various reference formats', async () => {
            prWebhookHandler.registerPlanIssue('testowner/testrepo', 50, 'draft-004');
            prWebhookHandler.registerPlanIssue('testowner/testrepo', 51, 'draft-004');
            prWebhookHandler.registerPlanIssue('testowner/testrepo', 52, 'draft-004');

            const payload: PullRequestOpenedPayload = {
                action: 'opened',
                pull_request: createMockPullRequest(105, 'fix #50, close #51, resolve #52'),
                repository: createMockRepository(),
                sender: createMockSender()
            };

            await prWebhookHandler.processPullRequestEvent(payload, 'corr-pr-opened-006');

            assert.strictEqual(prWebhookHandler.linkedPlanIssues.length, 3, 'Should handle all reference formats');
        });
    });

    describe('PR Merged Event Simulation', () => {
        test('updates plan issue status to merged when PR is merged', async () => {
            // Register and link a plan issue
            prWebhookHandler.registerPlanIssue('testowner/testrepo', 60, 'draft-005', 'processing');

            // First, open the PR to link it
            const openPayload: PullRequestOpenedPayload = {
                action: 'opened',
                pull_request: createMockPullRequest(200, 'Fixes #60'),
                repository: createMockRepository(),
                sender: createMockSender()
            };
            await prWebhookHandler.processPullRequestEvent(openPayload, 'corr-pr-merge-001a');

            // Then merge the PR
            const mergePayload: PullRequestClosedPayload = {
                action: 'closed',
                pull_request: createMockPullRequest(200, 'Fixes #60', 'closed', true),
                repository: createMockRepository(),
                sender: createMockSender()
            };
            await prWebhookHandler.processPullRequestEvent(mergePayload, 'corr-pr-merge-001b');

            // Verify merged event was recorded
            const mergedEvents = prWebhookHandler.processedEvents.filter(e => e.type === 'pr_merged');
            assert.strictEqual(mergedEvents.length, 1, 'Should record one merged event');

            // Verify status update to merged
            const mergeUpdate = prWebhookHandler.statusUpdates.find(u => u.newStatus === 'merged');
            assert.ok(mergeUpdate, 'Should have merged status update');
            assert.strictEqual(prWebhookHandler.getPlanIssueStatus('testowner/testrepo', 60), 'merged');
        });

        test('triggers next pending issue when PR is merged', async () => {
            // Register multiple plan issues in the same draft
            prWebhookHandler.registerPlanIssue('testowner/testrepo', 61, 'draft-006', 'processing');
            prWebhookHandler.registerPlanIssue('testowner/testrepo', 62, 'draft-006', 'pending');
            prWebhookHandler.registerPlanIssue('testowner/testrepo', 63, 'draft-006', 'pending');

            // Open and link PR to first issue
            const openPayload: PullRequestOpenedPayload = {
                action: 'opened',
                pull_request: createMockPullRequest(201, 'Fixes #61'),
                repository: createMockRepository(),
                sender: createMockSender()
            };
            await prWebhookHandler.processPullRequestEvent(openPayload, 'corr-pr-merge-002a');

            // Merge the PR
            const mergePayload: PullRequestClosedPayload = {
                action: 'closed',
                pull_request: createMockPullRequest(201, 'Fixes #61', 'closed', true),
                repository: createMockRepository(),
                sender: createMockSender()
            };
            await prWebhookHandler.processPullRequestEvent(mergePayload, 'corr-pr-merge-002b');

            // Verify next issue was triggered
            assert.strictEqual(prWebhookHandler.nextIssueTriggers.length, 1, 'Should trigger next issue');
            assert.strictEqual(prWebhookHandler.nextIssueTriggers[0]?.draftId, 'draft-006');
            assert.strictEqual(prWebhookHandler.nextIssueTriggers[0]?.triggeredIssueNumber, 62, 'Should trigger issue #62');

            // Verify next issue status changed to processing
            assert.strictEqual(prWebhookHandler.getPlanIssueStatus('testowner/testrepo', 62), 'processing');
        });

        test('does not trigger next issue when all issues are completed', async () => {
            // Register issues where all are either merged or processing
            prWebhookHandler.registerPlanIssue('testowner/testrepo', 64, 'draft-007', 'processing');
            prWebhookHandler.registerPlanIssue('testowner/testrepo', 65, 'draft-007', 'merged');

            // Open and merge PR
            const openPayload: PullRequestOpenedPayload = {
                action: 'opened',
                pull_request: createMockPullRequest(202, 'Fixes #64'),
                repository: createMockRepository(),
                sender: createMockSender()
            };
            await prWebhookHandler.processPullRequestEvent(openPayload, 'corr-pr-merge-003a');

            const mergePayload: PullRequestClosedPayload = {
                action: 'closed',
                pull_request: createMockPullRequest(202, 'Fixes #64', 'closed', true),
                repository: createMockRepository(),
                sender: createMockSender()
            };
            await prWebhookHandler.processPullRequestEvent(mergePayload, 'corr-pr-merge-003b');

            // Should not trigger any new issues
            assert.strictEqual(prWebhookHandler.nextIssueTriggers.length, 0, 'Should not trigger when no pending issues');
        });

        test('handles complete plan execution flow', async () => {
            // Set up a plan with 3 issues
            prWebhookHandler.registerPlanIssue('testowner/testrepo', 70, 'draft-008', 'processing');
            prWebhookHandler.registerPlanIssue('testowner/testrepo', 71, 'draft-008', 'pending');
            prWebhookHandler.registerPlanIssue('testowner/testrepo', 72, 'draft-008', 'pending');

            // Process first issue
            await prWebhookHandler.processPullRequestEvent({
                action: 'opened',
                pull_request: createMockPullRequest(300, 'Fixes #70'),
                repository: createMockRepository(),
                sender: createMockSender()
            }, 'flow-001a');

            await prWebhookHandler.processPullRequestEvent({
                action: 'closed',
                pull_request: createMockPullRequest(300, 'Fixes #70', 'closed', true),
                repository: createMockRepository(),
                sender: createMockSender()
            }, 'flow-001b');

            // First issue should be merged, second should be processing
            assert.strictEqual(prWebhookHandler.getPlanIssueStatus('testowner/testrepo', 70), 'merged');
            assert.strictEqual(prWebhookHandler.getPlanIssueStatus('testowner/testrepo', 71), 'processing');
            assert.strictEqual(prWebhookHandler.getPlanIssueStatus('testowner/testrepo', 72), 'pending');

            // Process second issue
            await prWebhookHandler.processPullRequestEvent({
                action: 'opened',
                pull_request: createMockPullRequest(301, 'Fixes #71'),
                repository: createMockRepository(),
                sender: createMockSender()
            }, 'flow-002a');

            await prWebhookHandler.processPullRequestEvent({
                action: 'closed',
                pull_request: createMockPullRequest(301, 'Fixes #71', 'closed', true),
                repository: createMockRepository(),
                sender: createMockSender()
            }, 'flow-002b');

            // Second issue should be merged, third should be processing
            assert.strictEqual(prWebhookHandler.getPlanIssueStatus('testowner/testrepo', 71), 'merged');
            assert.strictEqual(prWebhookHandler.getPlanIssueStatus('testowner/testrepo', 72), 'processing');

            // Verify all triggers happened
            assert.strictEqual(prWebhookHandler.nextIssueTriggers.length, 2, 'Should have triggered two issues');
        });
    });

    describe('PR Closed (Not Merged) Event Simulation', () => {
        test('updates plan issue status to closed when PR is closed without merge', async () => {
            prWebhookHandler.registerPlanIssue('testowner/testrepo', 80, 'draft-009', 'processing');

            // Open PR
            await prWebhookHandler.processPullRequestEvent({
                action: 'opened',
                pull_request: createMockPullRequest(400, 'Fixes #80'),
                repository: createMockRepository(),
                sender: createMockSender()
            }, 'corr-pr-close-001a');

            // Close without merge
            await prWebhookHandler.processPullRequestEvent({
                action: 'closed',
                pull_request: createMockPullRequest(400, 'Fixes #80', 'closed', false),
                repository: createMockRepository(),
                sender: createMockSender()
            }, 'corr-pr-close-001b');

            // Verify closed event
            const closedEvents = prWebhookHandler.processedEvents.filter(e => e.type === 'pr_closed');
            assert.strictEqual(closedEvents.length, 1, 'Should record one closed event');

            // Verify status update to closed (not merged)
            assert.strictEqual(prWebhookHandler.getPlanIssueStatus('testowner/testrepo', 80), 'closed');
        });

        test('does not trigger next issue when PR is closed without merge', async () => {
            prWebhookHandler.registerPlanIssue('testowner/testrepo', 81, 'draft-010', 'processing');
            prWebhookHandler.registerPlanIssue('testowner/testrepo', 82, 'draft-010', 'pending');

            // Open and close without merge
            await prWebhookHandler.processPullRequestEvent({
                action: 'opened',
                pull_request: createMockPullRequest(401, 'Fixes #81'),
                repository: createMockRepository(),
                sender: createMockSender()
            }, 'corr-pr-close-002a');

            await prWebhookHandler.processPullRequestEvent({
                action: 'closed',
                pull_request: createMockPullRequest(401, 'Fixes #81', 'closed', false),
                repository: createMockRepository(),
                sender: createMockSender()
            }, 'corr-pr-close-002b');

            // Should NOT trigger next issue
            assert.strictEqual(prWebhookHandler.nextIssueTriggers.length, 0, 'Should not trigger when PR closed without merge');
            assert.strictEqual(prWebhookHandler.getPlanIssueStatus('testowner/testrepo', 82), 'pending', 'Next issue should remain pending');
        });
    });

    describe('Event Correlation for PR Events', () => {
        test('preserves correlation ID through PR event processing', async () => {
            prWebhookHandler.registerPlanIssue('testowner/testrepo', 90, 'draft-011');

            const correlationId = 'pr-correlation-12345';
            await prWebhookHandler.processPullRequestEvent({
                action: 'opened',
                pull_request: createMockPullRequest(500, 'Fixes #90'),
                repository: createMockRepository(),
                sender: createMockSender()
            }, correlationId);

            // All events should have the same correlation ID
            for (const event of prWebhookHandler.processedEvents) {
                assert.strictEqual(event.correlationId, correlationId, 'Correlation ID should be preserved');
            }
        });

        test('different PR events have different correlation IDs', async () => {
            prWebhookHandler.registerPlanIssue('testowner/testrepo', 91, 'draft-012');

            await prWebhookHandler.processPullRequestEvent({
                action: 'opened',
                pull_request: createMockPullRequest(501, 'Fixes #91'),
                repository: createMockRepository(),
                sender: createMockSender()
            }, 'pr-corr-001');

            await prWebhookHandler.processPullRequestEvent({
                action: 'closed',
                pull_request: createMockPullRequest(501, 'Fixes #91', 'closed', true),
                repository: createMockRepository(),
                sender: createMockSender()
            }, 'pr-corr-002');

            const correlationIds = new Set(prWebhookHandler.processedEvents.map(e => e.correlationId));
            assert.strictEqual(correlationIds.size, 2, 'Should have 2 unique correlation IDs');
        });
    });

    describe('Complex PR Event Sequences', () => {
        test('handles concurrent PRs for different plan issues', async () => {
            prWebhookHandler.registerPlanIssue('testowner/testrepo', 100, 'draft-013', 'processing');
            prWebhookHandler.registerPlanIssue('testowner/testrepo', 101, 'draft-013', 'pending');
            prWebhookHandler.registerPlanIssue('testowner/testrepo', 102, 'draft-014', 'processing');

            // Open two PRs concurrently
            await Promise.all([
                prWebhookHandler.processPullRequestEvent({
                    action: 'opened',
                    pull_request: createMockPullRequest(600, 'Fixes #100'),
                    repository: createMockRepository(),
                    sender: createMockSender()
                }, 'concurrent-pr-001'),
                prWebhookHandler.processPullRequestEvent({
                    action: 'opened',
                    pull_request: createMockPullRequest(601, 'Fixes #102'),
                    repository: createMockRepository(),
                    sender: createMockSender()
                }, 'concurrent-pr-002')
            ]);

            // Both should be linked
            assert.strictEqual(prWebhookHandler.linkedPlanIssues.length, 2, 'Should link both PRs');

            // Both statuses should be under_review
            assert.strictEqual(prWebhookHandler.getPlanIssueStatus('testowner/testrepo', 100), 'under_review');
            assert.strictEqual(prWebhookHandler.getPlanIssueStatus('testowner/testrepo', 102), 'under_review');
        });

        test('handles PR lifecycle: open -> close -> reopen (via new PR)', async () => {
            prWebhookHandler.registerPlanIssue('testowner/testrepo', 110, 'draft-015', 'processing');

            // Open first PR
            await prWebhookHandler.processPullRequestEvent({
                action: 'opened',
                pull_request: createMockPullRequest(700, 'Fixes #110'),
                repository: createMockRepository(),
                sender: createMockSender()
            }, 'lifecycle-001');

            assert.strictEqual(prWebhookHandler.getPlanIssueStatus('testowner/testrepo', 110), 'under_review');

            // Close without merge
            await prWebhookHandler.processPullRequestEvent({
                action: 'closed',
                pull_request: createMockPullRequest(700, 'Fixes #110', 'closed', false),
                repository: createMockRepository(),
                sender: createMockSender()
            }, 'lifecycle-002');

            assert.strictEqual(prWebhookHandler.getPlanIssueStatus('testowner/testrepo', 110), 'closed');
        });
    });

    describe('Edge Cases for PR Events', () => {
        test('handles PR with null body', async () => {
            const payload: PullRequestOpenedPayload = {
                action: 'opened',
                pull_request: createMockPullRequest(800, null),
                repository: createMockRepository(),
                sender: createMockSender()
            };

            await prWebhookHandler.processPullRequestEvent(payload, 'edge-pr-001');

            // Should not throw and should record event
            assert.strictEqual(prWebhookHandler.processedEvents.length, 1);
            assert.strictEqual(prWebhookHandler.linkedPlanIssues.length, 0);
        });

        test('handles large PR numbers', async () => {
            prWebhookHandler.registerPlanIssue('testowner/testrepo', 999, 'draft-016');

            await prWebhookHandler.processPullRequestEvent({
                action: 'opened',
                pull_request: createMockPullRequest(99999, 'Fixes #999'),
                repository: createMockRepository(),
                sender: createMockSender()
            }, 'edge-pr-002');

            assert.strictEqual(prWebhookHandler.linkedPlanIssues[0]?.prNumber, 99999);
        });

        test('records timestamp for each PR event', async () => {
            const beforeTime = new Date();

            await prWebhookHandler.processPullRequestEvent({
                action: 'opened',
                pull_request: createMockPullRequest(900, 'Test PR'),
                repository: createMockRepository(),
                sender: createMockSender()
            }, 'edge-pr-003');

            const afterTime = new Date();

            for (const event of prWebhookHandler.processedEvents) {
                assert.ok(event.timestamp >= beforeTime, 'Event timestamp should be after test start');
                assert.ok(event.timestamp <= afterTime, 'Event timestamp should be before test end');
            }
        });

        test('handles special characters in repository name', async () => {
            prWebhookHandler.registerPlanIssue('my-org/my-repo-name', 120, 'draft-017');

            await prWebhookHandler.processPullRequestEvent({
                action: 'opened',
                pull_request: createMockPullRequest(901, 'Fixes #120'),
                repository: createMockRepository('my-org', 'my-repo-name'),
                sender: createMockSender()
            }, 'edge-pr-004');

            assert.strictEqual(prWebhookHandler.linkedPlanIssues[0]?.repository, 'my-org/my-repo-name');
        });
    });

    describe('Status Update Verification', () => {
        test('tracks all status transitions correctly', async () => {
            prWebhookHandler.registerPlanIssue('testowner/testrepo', 130, 'draft-018', 'pending');

            // Change to processing (simulated by changing initial status)
            prWebhookHandler.registerPlanIssue('testowner/testrepo', 130, 'draft-018', 'processing');

            // Open PR -> under_review
            await prWebhookHandler.processPullRequestEvent({
                action: 'opened',
                pull_request: createMockPullRequest(1000, 'Fixes #130'),
                repository: createMockRepository(),
                sender: createMockSender()
            }, 'status-001');

            assert.strictEqual(prWebhookHandler.getPlanIssueStatus('testowner/testrepo', 130), 'under_review');

            // Merge PR -> merged
            await prWebhookHandler.processPullRequestEvent({
                action: 'closed',
                pull_request: createMockPullRequest(1000, 'Fixes #130', 'closed', true),
                repository: createMockRepository(),
                sender: createMockSender()
            }, 'status-002');

            assert.strictEqual(prWebhookHandler.getPlanIssueStatus('testowner/testrepo', 130), 'merged');

            // Verify all status updates were recorded
            const statusUpdateActions = prWebhookHandler.statusUpdates.map(u => u.newStatus);
            assert.ok(statusUpdateActions.includes('under_review'), 'Should have under_review status');
            assert.ok(statusUpdateActions.includes('merged'), 'Should have merged status');
        });
    });
});

describe('Daemon Action Verification', () => {
    test('labeled event triggers appropriate daemon action chain', async () => {
        const webhookHandler = createMockWebhookHandler();
        const issueQueue = createMockIssueQueue();

        let daemonActionTriggered = false;
        let daemonActionIssue: DetectedIssue | null = null;

        // Register a processor that simulates daemon action
        webhookHandler.registerIssueProcessor(async (issue, correlationId) => {
            daemonActionTriggered = true;
            daemonActionIssue = issue;

            // Daemon would enqueue the job
            const jobId = `issue-${issue.repoOwner}-${issue.repoName}-${issue.number}`;
            await issueQueue.add('processGitHubIssue', {
                repoOwner: issue.repoOwner,
                repoName: issue.repoName,
                number: issue.number,
                triggeringLabel: 'AI',
                correlationId
            }, { jobId });
        });

        const payload: IssuesLabeledPayload = {
            action: 'labeled',
            issue: createMockIssue(200, ['AI', 'bug']),
            label: createMockLabel('AI'),
            repository: createMockRepository('testorg', 'testproject'),
            sender: createMockSender()
        };

        await webhookHandler.processIssuesEvent(payload, 'daemon-test-001');

        // Verify daemon action was triggered
        assert.strictEqual(daemonActionTriggered, true, 'Daemon action should be triggered');
        assert.ok(daemonActionIssue, 'Daemon should receive issue data');
        assert.strictEqual(daemonActionIssue?.number, 200, 'Daemon should receive correct issue number');
        assert.strictEqual(daemonActionIssue?.repoOwner, 'testorg', 'Daemon should receive correct repo owner');
        assert.strictEqual(daemonActionIssue?.repoName, 'testproject', 'Daemon should receive correct repo name');
        assert.deepStrictEqual(daemonActionIssue?.labels, ['AI', 'bug'], 'Daemon should receive all labels');

        // Verify job was created
        const jobs = await issueQueue.getWaiting();
        assert.strictEqual(jobs.length, 1, 'Should create one job');
        assert.strictEqual(jobs[0]?.id, 'issue-testorg-testproject-200', 'Job ID should follow pattern');
    });

    test('closed event triggers plan status update action', async () => {
        const webhookHandler = createMockWebhookHandler();

        const payload: IssuesClosedPayload = {
            action: 'closed',
            issue: createMockIssue(201, ['AI'], 'closed'),
            repository: createMockRepository('testorg', 'testproject'),
            sender: createMockSender()
        };

        await webhookHandler.processIssuesEvent(payload, 'daemon-test-002');

        // Verify plan update action was triggered
        assert.strictEqual(webhookHandler.planIssueUpdates.length, 1, 'Should trigger plan update');
        assert.strictEqual(webhookHandler.planIssueUpdates[0]?.action, 'closed');
        assert.strictEqual(webhookHandler.planIssueUpdates[0]?.repository, 'testorg/testproject');
        assert.strictEqual(webhookHandler.planIssueUpdates[0]?.issueNumber, 201);
        assert.strictEqual(webhookHandler.planIssueUpdates[0]?.newStatus, 'closed');
    });

    test('reopened event triggers plan status reset action', async () => {
        const webhookHandler = createMockWebhookHandler();

        const payload: IssuesReopenedPayload = {
            action: 'reopened',
            issue: createMockIssue(202, ['AI'], 'open'),
            repository: createMockRepository('testorg', 'testproject'),
            sender: createMockSender()
        };

        await webhookHandler.processIssuesEvent(payload, 'daemon-test-003');

        // Verify plan update action was triggered
        assert.strictEqual(webhookHandler.planIssueUpdates.length, 1, 'Should trigger plan update');
        assert.strictEqual(webhookHandler.planIssueUpdates[0]?.action, 'reopened');
        assert.strictEqual(webhookHandler.planIssueUpdates[0]?.repository, 'testorg/testproject');
        assert.strictEqual(webhookHandler.planIssueUpdates[0]?.issueNumber, 202);
        assert.strictEqual(webhookHandler.planIssueUpdates[0]?.newStatus, 'pending');
    });
});
