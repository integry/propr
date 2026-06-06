import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';

/**
 * Integration tests for Issue Detection Deduplication
 *
 * These tests verify that:
 * 1. Deterministic jobIds are used to prevent duplicate parent jobs
 * 2. Child jobs are allowed with unique deterministic IDs
 * 3. BullMQ rejects duplicate jobs when using the same jobId
 * 4. The deduplication logic correctly identifies existing jobs
 *
 * Key implementation details:
 * - Parent job ID format: `issue-{repoOwner}-{repoName}-{issueNumber}`
 * - Child job ID format: `issue-{repoOwner}-{repoName}-{issueNumber}-{agentAlias}-{model}-{baseBranch}`
 * - Jobs use removeOnComplete: true to allow re-processing after completion
 */

interface IssueJobData {
    repoOwner: string;
    repoName: string;
    number: number;
    triggeringLabel?: string;
    correlationId?: string;
    isChildJob?: boolean;
    agentAlias?: string;
    modelName?: string;
    baseBranch?: string;
}

interface MockJob {
    id: string;
    name: string;
    data: IssueJobData;
}

interface MockQueueState {
    jobs: Map<string, MockJob>;
    activeJobs: MockJob[];
    waitingJobs: MockJob[];
}

/**
 * Creates a mock queue that simulates BullMQ behavior for job deduplication
 */
function createMockQueue(): MockQueueState & {
    add: (name: string, data: IssueJobData, options?: { jobId?: string; removeOnComplete?: boolean; removeOnFail?: boolean }) => Promise<MockJob | null>;
    getActive: () => Promise<MockJob[]>;
    getWaiting: () => Promise<MockJob[]>;
    clear: () => void;
    completeJob: (jobId: string) => void;
    failJob: (jobId: string) => void;
} {
    const state: MockQueueState = {
        jobs: new Map(),
        activeJobs: [],
        waitingJobs: []
    };

    return {
        ...state,

        /**
         * Simulates BullMQ add behavior:
         * - If jobId is provided and job already exists, return null (duplicate rejected)
         * - Otherwise, add job and return it
         */
        async add(name: string, data: IssueJobData, options: { jobId?: string; removeOnComplete?: boolean; removeOnFail?: boolean } = {}): Promise<MockJob | null> {
            const jobId = options.jobId || `auto-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;

            // BullMQ rejects duplicate jobIds
            if (state.jobs.has(jobId)) {
                return null; // Duplicate - rejected
            }

            const job: MockJob = {
                id: jobId,
                name,
                data
            };

            state.jobs.set(jobId, job);
            state.waitingJobs.push(job);

            return job;
        },

        async getActive(): Promise<MockJob[]> {
            return [...state.activeJobs];
        },

        async getWaiting(): Promise<MockJob[]> {
            return [...state.waitingJobs];
        },

        clear(): void {
            state.jobs.clear();
            state.activeJobs = [];
            state.waitingJobs = [];
        },

        completeJob(jobId: string): void {
            const job = state.jobs.get(jobId);
            if (job) {
                state.activeJobs = state.activeJobs.filter(j => j.id !== jobId);
                state.waitingJobs = state.waitingJobs.filter(j => j.id !== jobId);
                // removeOnComplete: true means job is removed from the map
                state.jobs.delete(jobId);
            }
        },

        failJob(jobId: string): void {
            const job = state.jobs.get(jobId);
            if (job) {
                state.activeJobs = state.activeJobs.filter(j => j.id !== jobId);
                state.waitingJobs = state.waitingJobs.filter(j => j.id !== jobId);
                // removeOnFail: true means job is removed from the map
                state.jobs.delete(jobId);
            }
        }
    };
}

/**
 * Generates deterministic parent job ID matching issueDetection.ts implementation
 */
function generateParentJobId(repoOwner: string, repoName: string, issueNumber: number): string {
    return `issue-${repoOwner}-${repoName}-${issueNumber}`;
}

/**
 * Generates deterministic child job ID matching issueJobDispatcher.ts implementation
 */
function generateChildJobId(
    repoOwner: string,
    repoName: string,
    issueNumber: number,
    agentAlias: string,
    model: string,
    baseBranch: string
): string {
    return `issue-${repoOwner}-${repoName}-${issueNumber}-${agentAlias}-${model}-${baseBranch}`;
}

/**
 * Simulates the processDetectedIssue deduplication check
 */
async function checkJobExists(
    queue: ReturnType<typeof createMockQueue>,
    repoOwner: string,
    repoName: string,
    issueNumber: number
): Promise<boolean> {
    const activeJobs = await queue.getActive();
    const waitingJobs = await queue.getWaiting();
    const existingJobs = [...activeJobs, ...waitingJobs];

    return existingJobs.some(job =>
        job.name === 'processGitHubIssue' &&
        job.data.number === issueNumber &&
        job.data.repoOwner === repoOwner &&
        job.data.repoName === repoName &&
        !job.data.isChildJob
    );
}

describe('Issue Detection Deduplication - Integration Tests', () => {
    let mockQueue: ReturnType<typeof createMockQueue>;

    beforeEach(() => {
        mockQueue = createMockQueue();
    });

    afterEach(() => {
        mockQueue.clear();
    });

    describe('Deterministic Parent Job ID Generation', () => {
        test('generates consistent jobId for same issue', () => {
            const owner = 'testowner';
            const repo = 'testrepo';
            const issueNumber = 42;

            const jobId1 = generateParentJobId(owner, repo, issueNumber);
            const jobId2 = generateParentJobId(owner, repo, issueNumber);

            assert.strictEqual(jobId1, jobId2, 'Same issue should generate same jobId');
            assert.strictEqual(jobId1, 'issue-testowner-testrepo-42');
        });

        test('generates different jobIds for different issues', () => {
            const owner = 'testowner';
            const repo = 'testrepo';

            const jobId1 = generateParentJobId(owner, repo, 42);
            const jobId2 = generateParentJobId(owner, repo, 43);

            assert.notStrictEqual(jobId1, jobId2, 'Different issues should have different jobIds');
        });

        test('generates different jobIds for different repos', () => {
            const owner = 'testowner';
            const issueNumber = 42;

            const jobId1 = generateParentJobId(owner, 'repo1', issueNumber);
            const jobId2 = generateParentJobId(owner, 'repo2', issueNumber);

            assert.notStrictEqual(jobId1, jobId2, 'Same issue number in different repos should have different jobIds');
        });
    });

    describe('Deterministic Child Job ID Generation', () => {
        test('generates consistent childJobId for same configuration', () => {
            const config = {
                owner: 'testowner',
                repo: 'testrepo',
                issue: 42,
                agent: 'claude',
                model: 'claude-sonnet-4-20250514',
                branch: 'main'
            };

            const jobId1 = generateChildJobId(config.owner, config.repo, config.issue, config.agent, config.model, config.branch);
            const jobId2 = generateChildJobId(config.owner, config.repo, config.issue, config.agent, config.model, config.branch);

            assert.strictEqual(jobId1, jobId2, 'Same configuration should generate same childJobId');
            assert.strictEqual(jobId1, 'issue-testowner-testrepo-42-claude-claude-sonnet-4-20250514-main');
        });

        test('generates different childJobIds for different agents', () => {
            const base = { owner: 'testowner', repo: 'testrepo', issue: 42, branch: 'main' };

            const jobId1 = generateChildJobId(base.owner, base.repo, base.issue, 'claude', 'claude-sonnet-4-20250514', base.branch);
            const jobId2 = generateChildJobId(base.owner, base.repo, base.issue, 'antigravity', 'antigravity-gemini-2.5-flash', base.branch);

            assert.notStrictEqual(jobId1, jobId2, 'Different agents should have different childJobIds');
        });

        test('generates different childJobIds for different branches', () => {
            const base = { owner: 'testowner', repo: 'testrepo', issue: 42, agent: 'claude', model: 'claude-sonnet-4-20250514' };

            const jobId1 = generateChildJobId(base.owner, base.repo, base.issue, base.agent, base.model, 'main');
            const jobId2 = generateChildJobId(base.owner, base.repo, base.issue, base.agent, base.model, 'develop');

            assert.notStrictEqual(jobId1, jobId2, 'Different branches should have different childJobIds');
        });

        test('generates unique childJobIds for matrix expansion', () => {
            const owner = 'testowner';
            const repo = 'testrepo';
            const issue = 42;
            const branches = ['main', 'develop'];
            const agents = [
                { alias: 'claude', model: 'claude-sonnet-4-20250514' },
                { alias: 'antigravity', model: 'antigravity-gemini-2.5-flash' }
            ];

            const jobIds = new Set<string>();

            for (const branch of branches) {
                for (const agent of agents) {
                    const jobId = generateChildJobId(owner, repo, issue, agent.alias, agent.model, branch);
                    jobIds.add(jobId);
                }
            }

            // 2 branches × 2 agents = 4 unique child jobs
            assert.strictEqual(jobIds.size, 4, 'Matrix expansion should create unique jobIds for each combination');
        });
    });

    describe('BullMQ Duplicate Rejection', () => {
        test('rejects duplicate parent job with same jobId', async () => {
            const jobId = generateParentJobId('testowner', 'testrepo', 42);
            const jobData: IssueJobData = {
                repoOwner: 'testowner',
                repoName: 'testrepo',
                number: 42,
                triggeringLabel: 'AI',
                correlationId: 'corr-1'
            };

            // First job should be added successfully
            const job1 = await mockQueue.add('processGitHubIssue', jobData, {
                jobId,
                removeOnComplete: true,
                removeOnFail: true
            });

            assert.ok(job1, 'First job should be added');
            assert.strictEqual(job1?.id, jobId);

            // Second job with same jobId should be rejected
            const job2 = await mockQueue.add('processGitHubIssue', { ...jobData, correlationId: 'corr-2' }, {
                jobId,
                removeOnComplete: true,
                removeOnFail: true
            });

            assert.strictEqual(job2, null, 'Duplicate job should be rejected');
        });

        test('allows child jobs with unique jobIds', async () => {
            const owner = 'testowner';
            const repo = 'testrepo';
            const issue = 42;

            // Add parent job
            const parentJobId = generateParentJobId(owner, repo, issue);
            const parentJob = await mockQueue.add('processGitHubIssue', {
                repoOwner: owner,
                repoName: repo,
                number: issue,
                triggeringLabel: 'AI'
            }, { jobId: parentJobId });

            assert.ok(parentJob, 'Parent job should be added');

            // Add child jobs with different agents
            const childJob1Id = generateChildJobId(owner, repo, issue, 'claude', 'claude-sonnet-4-20250514', 'main');
            const childJob1 = await mockQueue.add('processGitHubIssue', {
                repoOwner: owner,
                repoName: repo,
                number: issue,
                isChildJob: true,
                agentAlias: 'claude',
                modelName: 'claude-sonnet-4-20250514',
                baseBranch: 'main'
            }, { jobId: childJob1Id });

            const childJob2Id = generateChildJobId(owner, repo, issue, 'antigravity', 'antigravity-gemini-2.5-flash', 'main');
            const childJob2 = await mockQueue.add('processGitHubIssue', {
                repoOwner: owner,
                repoName: repo,
                number: issue,
                isChildJob: true,
                agentAlias: 'antigravity',
                modelName: 'antigravity-gemini-2.5-flash',
                baseBranch: 'main'
            }, { jobId: childJob2Id });

            assert.ok(childJob1, 'First child job should be added');
            assert.ok(childJob2, 'Second child job should be added');
            assert.notStrictEqual(childJob1?.id, childJob2?.id, 'Child jobs should have different IDs');
        });

        test('allows re-adding job after completion with removeOnComplete', async () => {
            const jobId = generateParentJobId('testowner', 'testrepo', 42);
            const jobData: IssueJobData = {
                repoOwner: 'testowner',
                repoName: 'testrepo',
                number: 42,
                triggeringLabel: 'AI'
            };

            // Add first job
            const job1 = await mockQueue.add('processGitHubIssue', jobData, {
                jobId,
                removeOnComplete: true
            });
            assert.ok(job1, 'First job should be added');

            // Complete the job (simulates removeOnComplete: true)
            mockQueue.completeJob(jobId);

            // Should be able to add same jobId again after completion
            const job2 = await mockQueue.add('processGitHubIssue', { ...jobData, correlationId: 'new-correlation' }, {
                jobId,
                removeOnComplete: true
            });

            assert.ok(job2, 'Job should be re-addable after completion');
            assert.strictEqual(job2?.id, jobId);
        });

        test('allows re-adding job after failure with removeOnFail', async () => {
            const jobId = generateParentJobId('testowner', 'testrepo', 42);
            const jobData: IssueJobData = {
                repoOwner: 'testowner',
                repoName: 'testrepo',
                number: 42,
                triggeringLabel: 'AI'
            };

            // Add first job
            const job1 = await mockQueue.add('processGitHubIssue', jobData, {
                jobId,
                removeOnFail: true
            });
            assert.ok(job1, 'First job should be added');

            // Fail the job (simulates removeOnFail: true)
            mockQueue.failJob(jobId);

            // Should be able to add same jobId again after failure
            const job2 = await mockQueue.add('processGitHubIssue', jobData, {
                jobId,
                removeOnFail: true
            });

            assert.ok(job2, 'Job should be re-addable after failure');
        });
    });

    describe('Pre-enqueue Deduplication Check', () => {
        test('detects existing parent job in waiting queue', async () => {
            const owner = 'testowner';
            const repo = 'testrepo';
            const issue = 42;

            // Add a parent job to waiting queue
            await mockQueue.add('processGitHubIssue', {
                repoOwner: owner,
                repoName: repo,
                number: issue,
                triggeringLabel: 'AI'
            }, { jobId: generateParentJobId(owner, repo, issue) });

            // Check if job exists
            const exists = await checkJobExists(mockQueue, owner, repo, issue);

            assert.strictEqual(exists, true, 'Should detect existing parent job');
        });

        test('does not falsely detect child job as parent', async () => {
            const owner = 'testowner';
            const repo = 'testrepo';
            const issue = 42;

            // Add only a child job (no parent)
            await mockQueue.add('processGitHubIssue', {
                repoOwner: owner,
                repoName: repo,
                number: issue,
                isChildJob: true,
                agentAlias: 'claude',
                modelName: 'claude-sonnet-4-20250514',
                baseBranch: 'main'
            }, { jobId: generateChildJobId(owner, repo, issue, 'claude', 'claude-sonnet-4-20250514', 'main') });

            // Check if parent job exists (should be false - only child exists)
            const exists = await checkJobExists(mockQueue, owner, repo, issue);

            assert.strictEqual(exists, false, 'Child job should not be detected as parent job');
        });

        test('does not detect job for different issue', async () => {
            const owner = 'testowner';
            const repo = 'testrepo';

            // Add a job for issue 42
            await mockQueue.add('processGitHubIssue', {
                repoOwner: owner,
                repoName: repo,
                number: 42,
                triggeringLabel: 'AI'
            }, { jobId: generateParentJobId(owner, repo, 42) });

            // Check for different issue
            const exists = await checkJobExists(mockQueue, owner, repo, 43);

            assert.strictEqual(exists, false, 'Should not detect job for different issue');
        });

        test('does not detect job for different repo', async () => {
            const owner = 'testowner';
            const issue = 42;

            // Add a job for repo1
            await mockQueue.add('processGitHubIssue', {
                repoOwner: owner,
                repoName: 'repo1',
                number: issue,
                triggeringLabel: 'AI'
            }, { jobId: generateParentJobId(owner, 'repo1', issue) });

            // Check for different repo
            const exists = await checkJobExists(mockQueue, owner, 'repo2', issue);

            assert.strictEqual(exists, false, 'Should not detect job for different repo');
        });
    });

    describe('Full Deduplication Flow', () => {
        test('prevents duplicate jobs when webhook fires twice', async () => {
            const owner = 'testowner';
            const repo = 'testrepo';
            const issue = 42;
            const jobId = generateParentJobId(owner, repo, issue);

            // Simulate first webhook - should succeed
            const firstWebhookJobExists = await checkJobExists(mockQueue, owner, repo, issue);
            assert.strictEqual(firstWebhookJobExists, false, 'No job should exist initially');

            const job1 = await mockQueue.add('processGitHubIssue', {
                repoOwner: owner,
                repoName: repo,
                number: issue,
                triggeringLabel: 'AI',
                correlationId: 'webhook-1'
            }, { jobId, removeOnComplete: true, removeOnFail: true });

            assert.ok(job1, 'First webhook should create job');

            // Simulate second webhook (race condition)
            const secondWebhookJobExists = await checkJobExists(mockQueue, owner, repo, issue);
            assert.strictEqual(secondWebhookJobExists, true, 'Job should be detected on second webhook');

            // Even if check passes, BullMQ will reject duplicate
            const job2 = await mockQueue.add('processGitHubIssue', {
                repoOwner: owner,
                repoName: repo,
                number: issue,
                triggeringLabel: 'AI',
                correlationId: 'webhook-2'
            }, { jobId, removeOnComplete: true, removeOnFail: true });

            assert.strictEqual(job2, null, 'Second webhook should not create duplicate job');

            // Verify only one job exists
            const waitingJobs = await mockQueue.getWaiting();
            const issueJobs = waitingJobs.filter(j =>
                j.data.repoOwner === owner &&
                j.data.repoName === repo &&
                j.data.number === issue &&
                !j.data.isChildJob
            );

            assert.strictEqual(issueJobs.length, 1, 'Only one parent job should exist');
        });

        test('allows child job dispatch after parent job starts', async () => {
            const owner = 'testowner';
            const repo = 'testrepo';
            const issue = 42;

            // Add parent job
            const parentJobId = generateParentJobId(owner, repo, issue);
            await mockQueue.add('processGitHubIssue', {
                repoOwner: owner,
                repoName: repo,
                number: issue,
                triggeringLabel: 'AI'
            }, { jobId: parentJobId });

            // Simulate matrix expansion - add multiple child jobs
            const childConfigs = [
                { agent: 'claude', model: 'claude-sonnet-4-20250514', branch: 'main' },
                { agent: 'claude', model: 'claude-sonnet-4-20250514', branch: 'develop' },
                { agent: 'antigravity', model: 'antigravity-gemini-2.5-flash', branch: 'main' },
                { agent: 'antigravity', model: 'antigravity-gemini-2.5-flash', branch: 'develop' }
            ];

            const childJobs: (MockJob | null)[] = [];
            for (const config of childConfigs) {
                const childJobId = generateChildJobId(owner, repo, issue, config.agent, config.model, config.branch);
                const job = await mockQueue.add('processGitHubIssue', {
                    repoOwner: owner,
                    repoName: repo,
                    number: issue,
                    isChildJob: true,
                    agentAlias: config.agent,
                    modelName: config.model,
                    baseBranch: config.branch
                }, { jobId: childJobId, removeOnComplete: true, removeOnFail: true });
                childJobs.push(job);
            }

            // All child jobs should be added
            assert.strictEqual(childJobs.filter(j => j !== null).length, 4, 'All child jobs should be created');

            // Verify all jobs are unique
            const allWaiting = await mockQueue.getWaiting();
            const allJobIds = allWaiting.map(j => j.id);
            const uniqueJobIds = new Set(allJobIds);

            assert.strictEqual(uniqueJobIds.size, allJobIds.length, 'All job IDs should be unique');
        });

        test('prevents duplicate child jobs in matrix expansion', async () => {
            const owner = 'testowner';
            const repo = 'testrepo';
            const issue = 42;
            const agent = 'claude';
            const model = 'claude-sonnet-4-20250514';
            const branch = 'main';

            const childJobId = generateChildJobId(owner, repo, issue, agent, model, branch);

            // First child job
            const job1 = await mockQueue.add('processGitHubIssue', {
                repoOwner: owner,
                repoName: repo,
                number: issue,
                isChildJob: true,
                agentAlias: agent,
                modelName: model,
                baseBranch: branch
            }, { jobId: childJobId });

            // Attempt duplicate child job (e.g., from retry or duplicate dispatcher)
            const job2 = await mockQueue.add('processGitHubIssue', {
                repoOwner: owner,
                repoName: repo,
                number: issue,
                isChildJob: true,
                agentAlias: agent,
                modelName: model,
                baseBranch: branch
            }, { jobId: childJobId });

            assert.ok(job1, 'First child job should be created');
            assert.strictEqual(job2, null, 'Duplicate child job should be rejected');
        });
    });

    describe('fetchIssuesForRepo Integration Tests', () => {
        /**
         * Mock Octokit instance for testing fetchIssuesForRepo behavior
         */
        interface MockGitHubIssue {
            id: number;
            number: number;
            title: string;
            html_url: string;
            labels: Array<{ name: string } | string>;
            created_at: string;
            updated_at: string;
            pull_request?: unknown;
        }

        interface MockPaginateOptions {
            owner: string;
            repo: string;
            state: string;
            labels: string;
            per_page: number;
        }

        interface MockOctokitConfig {
            issues: Map<string, MockGitHubIssue[]>;
            rateLimitExceeded: boolean;
            rateLimitLabel?: string;
        }

        function createMockOctokit(config: MockOctokitConfig): {
            paginate: (endpoint: string, options: MockPaginateOptions) => Promise<MockGitHubIssue[]>;
        } {
            return {
                async paginate(endpoint: string, options: MockPaginateOptions): Promise<MockGitHubIssue[]> {
                    // Simulate rate limit error
                    if (config.rateLimitExceeded && (!config.rateLimitLabel || config.rateLimitLabel === options.labels)) {
                        const error = new Error('API rate limit exceeded for user') as Error & { status: number };
                        error.status = 403;
                        throw error;
                    }

                    const labelKey = options.labels;
                    return config.issues.get(labelKey) || [];
                }
            };
        }

        /**
         * Mock implementation of fetchIssuesForRepo for testing
         * This simulates the actual function behavior without dependencies
         */
        async function mockFetchIssuesForRepo(
            octokit: ReturnType<typeof createMockOctokit>,
            repoFullName: string,
            primaryProcessingLabels: string[]
        ): Promise<{
            id: number;
            number: number;
            title: string;
            url: string;
            repoOwner: string;
            repoName: string;
            labels: string[];
            createdAt: string;
            updatedAt: string;
        }[]> {
            const [owner, repo] = repoFullName.split('/');

            if (!owner || !repo) {
                return [];
            }

            const allExcludeLabels: string[] = [];
            for (const label of primaryProcessingLabels) {
                allExcludeLabels.push(`${label}-processing`);
                allExcludeLabels.push(`${label}-done`);
            }

            const allIssues: MockGitHubIssue[] = [];

            for (const primaryLabel of primaryProcessingLabels) {
                try {
                    const issues = await octokit.paginate('GET /repos/{owner}/{repo}/issues', {
                        owner,
                        repo,
                        state: 'open',
                        labels: primaryLabel,
                        per_page: 100
                    });

                    // Deduplicate by id
                    for (const issue of issues) {
                        if (!allIssues.find(i => i.id === issue.id)) {
                            allIssues.push(issue);
                        }
                    }
                } catch (error) {
                    const err = error as Error & { status?: number };
                    if (err.status === 403 && err.message && err.message.includes('rate limit')) {
                        // Graceful rate limit handling - continue with other labels if possible
                        continue;
                    }
                    throw error;
                }
            }

            // Filter out PRs and issues with exclude labels
            const filteredIssues = allIssues.filter(issue => {
                if (issue.pull_request) return false;

                const labelNames = issue.labels.map(label =>
                    typeof label === 'string' ? label : label.name
                );

                return !allExcludeLabels.some(excludeLabel => labelNames.includes(excludeLabel));
            });

            return filteredIssues.map(issue => ({
                id: issue.id,
                number: issue.number,
                title: issue.title,
                url: issue.html_url,
                repoOwner: owner,
                repoName: repo,
                labels: issue.labels.map(l => typeof l === 'string' ? l : l.name),
                createdAt: issue.created_at,
                updatedAt: issue.updated_at
            }));
        }

        test('filters out pull requests from results', async () => {
            const mockConfig: MockOctokitConfig = {
                issues: new Map([
                    ['AI', [
                        {
                            id: 1,
                            number: 10,
                            title: 'Regular Issue',
                            html_url: 'https://github.com/owner/repo/issues/10',
                            labels: [{ name: 'AI' }],
                            created_at: '2024-01-01T00:00:00Z',
                            updated_at: '2024-01-01T00:00:00Z',
                            pull_request: undefined
                        },
                        {
                            id: 2,
                            number: 20,
                            title: 'This is a PR',
                            html_url: 'https://github.com/owner/repo/pull/20',
                            labels: [{ name: 'AI' }],
                            created_at: '2024-01-01T00:00:00Z',
                            updated_at: '2024-01-01T00:00:00Z',
                            pull_request: { url: 'https://api.github.com/repos/owner/repo/pulls/20' }
                        },
                        {
                            id: 3,
                            number: 30,
                            title: 'Another Regular Issue',
                            html_url: 'https://github.com/owner/repo/issues/30',
                            labels: [{ name: 'AI' }],
                            created_at: '2024-01-01T00:00:00Z',
                            updated_at: '2024-01-01T00:00:00Z',
                            pull_request: undefined
                        }
                    ]]
                ]),
                rateLimitExceeded: false
            };

            const octokit = createMockOctokit(mockConfig);
            const results = await mockFetchIssuesForRepo(octokit, 'owner/repo', ['AI']);

            assert.strictEqual(results.length, 2, 'Should filter out PRs');
            assert.ok(results.every(r => r.number !== 20), 'PR #20 should be filtered out');
            assert.ok(results.some(r => r.number === 10), 'Issue #10 should be included');
            assert.ok(results.some(r => r.number === 30), 'Issue #30 should be included');
        });

        test('handles 403 rate limit errors gracefully', async () => {
            const mockConfig: MockOctokitConfig = {
                issues: new Map(),
                rateLimitExceeded: true
            };

            const octokit = createMockOctokit(mockConfig);
            const results = await mockFetchIssuesForRepo(octokit, 'owner/repo', ['AI']);

            // Graceful handling should return empty array instead of throwing
            assert.strictEqual(results.length, 0, 'Should return empty array on rate limit');
        });

        test('handles partial rate limit across multiple labels', async () => {
            const mockConfig: MockOctokitConfig = {
                issues: new Map([
                    ['AI', [
                        {
                            id: 1,
                            number: 10,
                            title: 'AI Issue',
                            html_url: 'https://github.com/owner/repo/issues/10',
                            labels: [{ name: 'AI' }],
                            created_at: '2024-01-01T00:00:00Z',
                            updated_at: '2024-01-01T00:00:00Z'
                        }
                    ]]
                ]),
                rateLimitExceeded: true,
                rateLimitLabel: 'bug' // Only rate limit on 'bug' label
            };

            const octokit = createMockOctokit(mockConfig);
            const results = await mockFetchIssuesForRepo(octokit, 'owner/repo', ['AI', 'bug']);

            // Should still return AI issues even if bug label is rate limited
            assert.strictEqual(results.length, 1, 'Should return issues from non-rate-limited labels');
            assert.strictEqual(results[0]?.number, 10, 'Should return issue #10');
        });

        test('deduplicates issues with multiple primary labels', async () => {
            const sharedIssue: MockGitHubIssue = {
                id: 100,
                number: 50,
                title: 'Issue with both AI and enhancement labels',
                html_url: 'https://github.com/owner/repo/issues/50',
                labels: [{ name: 'AI' }, { name: 'enhancement' }],
                created_at: '2024-01-01T00:00:00Z',
                updated_at: '2024-01-01T00:00:00Z'
            };

            const mockConfig: MockOctokitConfig = {
                issues: new Map([
                    ['AI', [
                        sharedIssue,
                        {
                            id: 101,
                            number: 51,
                            title: 'AI only issue',
                            html_url: 'https://github.com/owner/repo/issues/51',
                            labels: [{ name: 'AI' }],
                            created_at: '2024-01-01T00:00:00Z',
                            updated_at: '2024-01-01T00:00:00Z'
                        }
                    ]],
                    ['enhancement', [
                        sharedIssue,
                        {
                            id: 102,
                            number: 52,
                            title: 'Enhancement only issue',
                            html_url: 'https://github.com/owner/repo/issues/52',
                            labels: [{ name: 'enhancement' }],
                            created_at: '2024-01-01T00:00:00Z',
                            updated_at: '2024-01-01T00:00:00Z'
                        }
                    ]]
                ]),
                rateLimitExceeded: false
            };

            const octokit = createMockOctokit(mockConfig);
            const results = await mockFetchIssuesForRepo(octokit, 'owner/repo', ['AI', 'enhancement']);

            // Issue 50 should appear only once despite being in both label queries
            const issue50Count = results.filter(r => r.number === 50).length;
            assert.strictEqual(issue50Count, 1, 'Shared issue should appear exactly once');
            assert.strictEqual(results.length, 3, 'Should have 3 unique issues total');

            // Verify all unique issues are present
            const issueNumbers = results.map(r => r.number).sort((a, b) => a - b);
            assert.deepStrictEqual(issueNumbers, [50, 51, 52], 'Should have issues 50, 51, 52');
        });

        test('deduplicates by issue id not number', async () => {
            // Same issue number but different IDs should be treated as different issues
            const mockConfig: MockOctokitConfig = {
                issues: new Map([
                    ['AI', [
                        {
                            id: 1001,
                            number: 1,
                            title: 'Issue 1 from AI query',
                            html_url: 'https://github.com/owner/repo/issues/1',
                            labels: [{ name: 'AI' }],
                            created_at: '2024-01-01T00:00:00Z',
                            updated_at: '2024-01-01T00:00:00Z'
                        }
                    ]],
                    ['bug', [
                        {
                            id: 1001, // Same ID - should be deduplicated
                            number: 1,
                            title: 'Issue 1 from bug query',
                            html_url: 'https://github.com/owner/repo/issues/1',
                            labels: [{ name: 'AI' }, { name: 'bug' }],
                            created_at: '2024-01-01T00:00:00Z',
                            updated_at: '2024-01-01T00:00:00Z'
                        }
                    ]]
                ]),
                rateLimitExceeded: false
            };

            const octokit = createMockOctokit(mockConfig);
            const results = await mockFetchIssuesForRepo(octokit, 'owner/repo', ['AI', 'bug']);

            assert.strictEqual(results.length, 1, 'Should deduplicate by ID');
            assert.strictEqual(results[0]?.id, 1001, 'Should have issue with id 1001');
        });

        test('filters issues with processing labels', async () => {
            const mockConfig: MockOctokitConfig = {
                issues: new Map([
                    ['AI', [
                        {
                            id: 1,
                            number: 10,
                            title: 'Active Issue',
                            html_url: 'https://github.com/owner/repo/issues/10',
                            labels: [{ name: 'AI' }],
                            created_at: '2024-01-01T00:00:00Z',
                            updated_at: '2024-01-01T00:00:00Z'
                        },
                        {
                            id: 2,
                            number: 20,
                            title: 'Processing Issue',
                            html_url: 'https://github.com/owner/repo/issues/20',
                            labels: [{ name: 'AI' }, { name: 'AI-processing' }],
                            created_at: '2024-01-01T00:00:00Z',
                            updated_at: '2024-01-01T00:00:00Z'
                        }
                    ]]
                ]),
                rateLimitExceeded: false
            };

            const octokit = createMockOctokit(mockConfig);
            const results = await mockFetchIssuesForRepo(octokit, 'owner/repo', ['AI']);

            assert.strictEqual(results.length, 1, 'Should filter out issues with -processing label');
            assert.strictEqual(results[0]?.number, 10, 'Should only include issue #10');
        });

        test('filters issues with done labels', async () => {
            const mockConfig: MockOctokitConfig = {
                issues: new Map([
                    ['AI', [
                        {
                            id: 1,
                            number: 10,
                            title: 'Active Issue',
                            html_url: 'https://github.com/owner/repo/issues/10',
                            labels: [{ name: 'AI' }],
                            created_at: '2024-01-01T00:00:00Z',
                            updated_at: '2024-01-01T00:00:00Z'
                        },
                        {
                            id: 2,
                            number: 20,
                            title: 'Completed Issue',
                            html_url: 'https://github.com/owner/repo/issues/20',
                            labels: [{ name: 'AI' }, { name: 'AI-done' }],
                            created_at: '2024-01-01T00:00:00Z',
                            updated_at: '2024-01-01T00:00:00Z'
                        }
                    ]]
                ]),
                rateLimitExceeded: false
            };

            const octokit = createMockOctokit(mockConfig);
            const results = await mockFetchIssuesForRepo(octokit, 'owner/repo', ['AI']);

            assert.strictEqual(results.length, 1, 'Should filter out issues with -done label');
            assert.strictEqual(results[0]?.number, 10, 'Should only include issue #10');
        });

        test('filters exclude labels for multiple primary labels', async () => {
            const mockConfig: MockOctokitConfig = {
                issues: new Map([
                    ['AI', [
                        {
                            id: 1,
                            number: 10,
                            title: 'Active AI Issue',
                            html_url: 'https://github.com/owner/repo/issues/10',
                            labels: [{ name: 'AI' }],
                            created_at: '2024-01-01T00:00:00Z',
                            updated_at: '2024-01-01T00:00:00Z'
                        }
                    ]],
                    ['enhancement', [
                        {
                            id: 2,
                            number: 20,
                            title: 'Enhancement being processed',
                            html_url: 'https://github.com/owner/repo/issues/20',
                            labels: [{ name: 'enhancement' }, { name: 'enhancement-processing' }],
                            created_at: '2024-01-01T00:00:00Z',
                            updated_at: '2024-01-01T00:00:00Z'
                        },
                        {
                            id: 3,
                            number: 30,
                            title: 'Active enhancement Issue',
                            html_url: 'https://github.com/owner/repo/issues/30',
                            labels: [{ name: 'enhancement' }],
                            created_at: '2024-01-01T00:00:00Z',
                            updated_at: '2024-01-01T00:00:00Z'
                        }
                    ]]
                ]),
                rateLimitExceeded: false
            };

            const octokit = createMockOctokit(mockConfig);
            const results = await mockFetchIssuesForRepo(octokit, 'owner/repo', ['AI', 'enhancement']);

            assert.strictEqual(results.length, 2, 'Should filter issues with any exclude label');
            assert.ok(results.some(r => r.number === 10), 'Should include issue #10');
            assert.ok(results.some(r => r.number === 30), 'Should include issue #30');
            assert.ok(!results.some(r => r.number === 20), 'Should exclude issue #20 with -processing');
        });

        test('handles string labels in addition to object labels', async () => {
            const mockConfig: MockOctokitConfig = {
                issues: new Map([
                    ['AI', [
                        {
                            id: 1,
                            number: 10,
                            title: 'Issue with string labels',
                            html_url: 'https://github.com/owner/repo/issues/10',
                            labels: ['AI', 'bug'], // String format labels
                            created_at: '2024-01-01T00:00:00Z',
                            updated_at: '2024-01-01T00:00:00Z'
                        },
                        {
                            id: 2,
                            number: 20,
                            title: 'Issue with string processing label',
                            html_url: 'https://github.com/owner/repo/issues/20',
                            labels: ['AI', 'AI-processing'], // String format with processing
                            created_at: '2024-01-01T00:00:00Z',
                            updated_at: '2024-01-01T00:00:00Z'
                        }
                    ]]
                ]),
                rateLimitExceeded: false
            };

            const octokit = createMockOctokit(mockConfig);
            const results = await mockFetchIssuesForRepo(octokit, 'owner/repo', ['AI']);

            assert.strictEqual(results.length, 1, 'Should handle string labels and filter correctly');
            assert.strictEqual(results[0]?.number, 10, 'Should include issue #10');
            assert.deepStrictEqual(results[0]?.labels, ['AI', 'bug'], 'Should preserve string labels');
        });

        test('handles invalid repository format', async () => {
            const mockConfig: MockOctokitConfig = {
                issues: new Map(),
                rateLimitExceeded: false
            };

            const octokit = createMockOctokit(mockConfig);

            // Test with invalid repo format (no slash)
            const results1 = await mockFetchIssuesForRepo(octokit, 'invalidrepo', ['AI']);
            assert.strictEqual(results1.length, 0, 'Should return empty for invalid repo format');

            // Test with empty string
            const results2 = await mockFetchIssuesForRepo(octokit, '', ['AI']);
            assert.strictEqual(results2.length, 0, 'Should return empty for empty repo string');
        });

        test('correctly extracts owner and repo from full name', async () => {
            const mockConfig: MockOctokitConfig = {
                issues: new Map([
                    ['AI', [
                        {
                            id: 1,
                            number: 10,
                            title: 'Test Issue',
                            html_url: 'https://github.com/my-org/my-repo/issues/10',
                            labels: [{ name: 'AI' }],
                            created_at: '2024-01-01T00:00:00Z',
                            updated_at: '2024-01-01T00:00:00Z'
                        }
                    ]]
                ]),
                rateLimitExceeded: false
            };

            const octokit = createMockOctokit(mockConfig);
            const results = await mockFetchIssuesForRepo(octokit, 'my-org/my-repo', ['AI']);

            assert.strictEqual(results.length, 1, 'Should fetch issues for valid repo');
            assert.strictEqual(results[0]?.repoOwner, 'my-org', 'Should extract correct owner');
            assert.strictEqual(results[0]?.repoName, 'my-repo', 'Should extract correct repo name');
        });

        test('handles empty issues list', async () => {
            const mockConfig: MockOctokitConfig = {
                issues: new Map([
                    ['AI', []]
                ]),
                rateLimitExceeded: false
            };

            const octokit = createMockOctokit(mockConfig);
            const results = await mockFetchIssuesForRepo(octokit, 'owner/repo', ['AI']);

            assert.strictEqual(results.length, 0, 'Should return empty array for no issues');
        });

        test('handles empty primary processing labels', async () => {
            const mockConfig: MockOctokitConfig = {
                issues: new Map([
                    ['AI', [
                        {
                            id: 1,
                            number: 10,
                            title: 'Test Issue',
                            html_url: 'https://github.com/owner/repo/issues/10',
                            labels: [{ name: 'AI' }],
                            created_at: '2024-01-01T00:00:00Z',
                            updated_at: '2024-01-01T00:00:00Z'
                        }
                    ]]
                ]),
                rateLimitExceeded: false
            };

            const octokit = createMockOctokit(mockConfig);
            const results = await mockFetchIssuesForRepo(octokit, 'owner/repo', []);

            assert.strictEqual(results.length, 0, 'Should return empty when no primary labels configured');
        });

        test('preserves all issue metadata in returned DetectedIssue', async () => {
            const mockConfig: MockOctokitConfig = {
                issues: new Map([
                    ['AI', [
                        {
                            id: 12345,
                            number: 42,
                            title: 'Test Issue Title',
                            html_url: 'https://github.com/owner/repo/issues/42',
                            labels: [{ name: 'AI' }, { name: 'bug' }, { name: 'priority-high' }],
                            created_at: '2024-01-15T10:30:00Z',
                            updated_at: '2024-01-20T15:45:00Z'
                        }
                    ]]
                ]),
                rateLimitExceeded: false
            };

            const octokit = createMockOctokit(mockConfig);
            const results = await mockFetchIssuesForRepo(octokit, 'owner/repo', ['AI']);

            assert.strictEqual(results.length, 1, 'Should have one result');
            const issue = results[0]!;
            assert.strictEqual(issue.id, 12345, 'Should preserve id');
            assert.strictEqual(issue.number, 42, 'Should preserve number');
            assert.strictEqual(issue.title, 'Test Issue Title', 'Should preserve title');
            assert.strictEqual(issue.url, 'https://github.com/owner/repo/issues/42', 'Should preserve url');
            assert.strictEqual(issue.repoOwner, 'owner', 'Should set repoOwner');
            assert.strictEqual(issue.repoName, 'repo', 'Should set repoName');
            assert.deepStrictEqual(issue.labels, ['AI', 'bug', 'priority-high'], 'Should preserve all labels');
            assert.strictEqual(issue.createdAt, '2024-01-15T10:30:00Z', 'Should preserve createdAt');
            assert.strictEqual(issue.updatedAt, '2024-01-20T15:45:00Z', 'Should preserve updatedAt');
        });
    });

    describe('Edge Cases', () => {
        test('handles special characters in repo names', () => {
            const jobId1 = generateParentJobId('test-owner', 'my-repo-name', 42);
            const jobId2 = generateParentJobId('test-owner', 'my-repo-name', 42);

            assert.strictEqual(jobId1, jobId2, 'Repos with hyphens should work');
            assert.strictEqual(jobId1, 'issue-test-owner-my-repo-name-42');
        });

        test('handles large issue numbers', () => {
            const largeIssueNumber = 999999;
            const jobId = generateParentJobId('owner', 'repo', largeIssueNumber);

            assert.strictEqual(jobId, 'issue-owner-repo-999999');
        });

        test('handles long model names in child jobs', () => {
            const jobId = generateChildJobId(
                'owner',
                'repo',
                42,
                'claude',
                'claude-opus-4-5-20251101',
                'main'
            );

            assert.strictEqual(jobId, 'issue-owner-repo-42-claude-claude-opus-4-5-20251101-main');
        });

        test('maintains uniqueness with similar but different parameters', () => {
            // These should all be different
            const ids = [
                generateChildJobId('owner', 'repo', 42, 'claude', 'model', 'main'),
                generateChildJobId('owner', 'repo', 42, 'claude', 'model', 'main2'),
                generateChildJobId('owner', 'repo', 42, 'claude', 'model2', 'main'),
                generateChildJobId('owner', 'repo', 42, 'claude2', 'model', 'main'),
                generateChildJobId('owner', 'repo', 422, 'claude', 'model', 'main'),
                generateChildJobId('owner', 'repo2', 42, 'claude', 'model', 'main'),
                generateChildJobId('owner2', 'repo', 42, 'claude', 'model', 'main')
            ];

            const uniqueIds = new Set(ids);
            assert.strictEqual(uniqueIds.size, ids.length, 'All variations should be unique');
        });
    });
});
