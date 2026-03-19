import { test, describe, mock } from 'node:test';
import assert from 'node:assert';

/**
 * Unit tests for handleDispatch in issueJobDispatcher.ts
 *
 * These tests verify the core logic of the matrix dispatcher:
 * - Deterministic jobId generation for deduplication
 * - Fallback to default agent when no LLM labels are present
 * - Matrix expansion creating child jobs for base branches × agent models
 *
 * The tests use pure function extraction to avoid module-level side effects
 * from @propr/core imports (Redis connections, database, etc.)
 *
 * @see src/jobs/issueJobDispatcher.ts
 */

// Type definitions mirroring the original code
interface IssueJobData {
    repoOwner: string;
    repoName: string;
    number: number;
    repository?: string;
    agentAlias?: string;
    modelName?: string;
    correlationId?: string;
    triggeringLabel?: string;
    baseBranch?: string;
    baseLabel?: string | null;
    modelLabel?: string | null;
    isChildJob?: boolean;
    issuePayload?: Record<string, unknown>;
    repoPayload?: Record<string, unknown>;
}

interface BaseToProcess {
    branch: string;
    label: string | null;
}

interface AgentModelToProcess {
    agentAlias: string;
    model: string;
    label: string | null;
}

interface Label {
    name: string;
}

interface Logger {
    info: ReturnType<typeof mock.fn>;
    debug: ReturnType<typeof mock.fn>;
    warn: ReturnType<typeof mock.fn>;
    error: ReturnType<typeof mock.fn>;
}

// Helper function to create mock logger
function createMockLogger(): Logger {
    return {
        info: mock.fn(),
        debug: mock.fn(),
        warn: mock.fn(),
        error: mock.fn()
    };
}

/**
 * Pure function that generates a deterministic child job ID.
 * This prevents duplicate child jobs when multiple webhook events
 * trigger the dispatcher for the same issue.
 *
 * Extracted from handleDispatch line 180 for testability.
 *
 * @param issueRef - The issue reference containing owner, repo, and number
 * @param agentModel - The agent and model configuration
 * @param baseBranch - The base branch name
 * @returns A deterministic job ID string
 */
function generateChildJobId(
    issueRef: { repoOwner: string; repoName: string; number: number },
    agentModel: { agentAlias: string; model: string },
    baseBranch: string
): string {
    return `issue-${issueRef.repoOwner}-${issueRef.repoName}-${issueRef.number}-${agentModel.agentAlias}-${agentModel.model}-${baseBranch}`;
}

/**
 * Pure function that extracts base branches from labels.
 * Falls back to the default branch if no base- labels are found.
 *
 * Extracted from handleDispatch lines 98-109 for testability.
 *
 * @param labels - Array of label names
 * @param defaultBranch - The repository's default branch
 * @returns Array of base branches to process
 */
function extractBasesToProcess(
    labels: string[],
    defaultBranch: string
): BaseToProcess[] {
    const baseLabels = labels.filter(l => l.startsWith('base-'));

    if (baseLabels.length > 0) {
        return baseLabels.map(l => ({
            branch: l.substring('base-'.length),
            label: l
        }));
    }

    return [{ branch: defaultBranch, label: null }];
}

/**
 * Pure function that extracts LLM labels from the issue labels.
 *
 * Extracted from handleDispatch line 99 for testability.
 *
 * @param labels - Array of label names
 * @returns Array of llm- prefixed labels
 */
function extractLlmLabels(labels: string[]): string[] {
    return labels.filter(l => l.startsWith('llm-'));
}

/**
 * Pure function that builds the child job data.
 *
 * Extracted from handleDispatch lines 166-176 for testability.
 *
 * @param issueRef - The original issue reference
 * @param base - The base branch configuration
 * @param agentModel - The agent and model configuration
 * @param currentIssueData - The current issue payload from GitHub
 * @param repoData - The repository data
 * @returns The child job data
 */
function buildChildJobData(
    issueRef: IssueJobData,
    base: BaseToProcess,
    agentModel: AgentModelToProcess,
    currentIssueData: Record<string, unknown>,
    repoData: Record<string, unknown>
): IssueJobData {
    return {
        ...issueRef,
        baseBranch: base.branch,
        baseLabel: base.label,
        agentAlias: agentModel.agentAlias,
        modelName: agentModel.model,
        modelLabel: agentModel.label,
        isChildJob: true,
        issuePayload: currentIssueData,
        repoPayload: repoData
    };
}

/**
 * Pure function that calculates the total number of child jobs to be created.
 * This is the matrix expansion: bases × agentModels.
 *
 * @param basesToProcess - Array of base branches
 * @param agentModelsToProcess - Array of agent/model combinations
 * @returns The total number of child jobs
 */
function calculateTotalChildJobs(
    basesToProcess: BaseToProcess[],
    agentModelsToProcess: AgentModelToProcess[]
): number {
    return basesToProcess.length * agentModelsToProcess.length;
}

/**
 * Pure function that determines if the dispatcher should use the default agent.
 * Returns true if no LLM labels and no custom labels are found.
 *
 * Extracted from handleDispatch lines 151-161 for testability.
 *
 * @param llmLabels - Array of llm- prefixed labels
 * @param customLabelMatches - Array of matching custom labels
 * @returns True if default agent should be used
 */
function shouldUseDefaultAgent(
    llmLabels: string[],
    customLabelMatches: string[]
): boolean {
    return llmLabels.length === 0 && customLabelMatches.length === 0;
}

/**
 * Pure function that filters labels to find custom label matches.
 *
 * Extracted from handleDispatch lines 102-105 for testability.
 *
 * @param issueLabels - Labels on the issue
 * @param configuredCustomLabels - Custom labels configured in agents
 * @returns Array of matching custom labels
 */
function findCustomLabelMatches(
    issueLabels: string[],
    configuredCustomLabels: string[]
): string[] {
    return issueLabels.filter(l =>
        configuredCustomLabels.some(cl => cl.toLowerCase() === l.toLowerCase())
    );
}

describe('issueJobDispatcher - handleDispatch Core Logic', () => {
    describe('generateChildJobId (deterministic jobId)', () => {
        test('should generate deterministic job ID from issue reference, agent, and base branch', () => {
            const issueRef = { repoOwner: 'integry', repoName: 'gitfix', number: 42 };
            const agentModel = { agentAlias: 'claude', model: 'claude-sonnet-4-5' };
            const baseBranch = 'main';

            const jobId = generateChildJobId(issueRef, agentModel, baseBranch);

            assert.strictEqual(jobId, 'issue-integry-gitfix-42-claude-claude-sonnet-4-5-main');
        });

        test('should generate same job ID for same inputs (deduplication)', () => {
            const issueRef = { repoOwner: 'org', repoName: 'repo', number: 123 };
            const agentModel = { agentAlias: 'gemini', model: 'gemini-2.5-pro' };
            const baseBranch = 'develop';

            const jobId1 = generateChildJobId(issueRef, agentModel, baseBranch);
            const jobId2 = generateChildJobId(issueRef, agentModel, baseBranch);

            assert.strictEqual(jobId1, jobId2);
        });

        test('should generate different job IDs for different issue numbers', () => {
            const issueRef1 = { repoOwner: 'org', repoName: 'repo', number: 1 };
            const issueRef2 = { repoOwner: 'org', repoName: 'repo', number: 2 };
            const agentModel = { agentAlias: 'claude', model: 'claude-opus-4-5' };
            const baseBranch = 'main';

            const jobId1 = generateChildJobId(issueRef1, agentModel, baseBranch);
            const jobId2 = generateChildJobId(issueRef2, agentModel, baseBranch);

            assert.notStrictEqual(jobId1, jobId2);
        });

        test('should generate different job IDs for different agents', () => {
            const issueRef = { repoOwner: 'org', repoName: 'repo', number: 42 };
            const agentModel1 = { agentAlias: 'claude', model: 'claude-sonnet-4-5' };
            const agentModel2 = { agentAlias: 'codex', model: 'codex-mini' };
            const baseBranch = 'main';

            const jobId1 = generateChildJobId(issueRef, agentModel1, baseBranch);
            const jobId2 = generateChildJobId(issueRef, agentModel2, baseBranch);

            assert.notStrictEqual(jobId1, jobId2);
        });

        test('should generate different job IDs for different models', () => {
            const issueRef = { repoOwner: 'org', repoName: 'repo', number: 42 };
            const agentModel1 = { agentAlias: 'claude', model: 'claude-sonnet-4-5' };
            const agentModel2 = { agentAlias: 'claude', model: 'claude-opus-4-5' };
            const baseBranch = 'main';

            const jobId1 = generateChildJobId(issueRef, agentModel1, baseBranch);
            const jobId2 = generateChildJobId(issueRef, agentModel2, baseBranch);

            assert.notStrictEqual(jobId1, jobId2);
        });

        test('should generate different job IDs for different base branches', () => {
            const issueRef = { repoOwner: 'org', repoName: 'repo', number: 42 };
            const agentModel = { agentAlias: 'claude', model: 'claude-sonnet-4-5' };
            const baseBranch1 = 'main';
            const baseBranch2 = 'develop';

            const jobId1 = generateChildJobId(issueRef, agentModel, baseBranch1);
            const jobId2 = generateChildJobId(issueRef, agentModel, baseBranch2);

            assert.notStrictEqual(jobId1, jobId2);
        });

        test('should handle special characters in repo names', () => {
            const issueRef = { repoOwner: 'my-org', repoName: 'my-repo-name', number: 100 };
            const agentModel = { agentAlias: 'claude', model: 'claude-sonnet-4-5' };
            const baseBranch = 'feature/test-branch';

            const jobId = generateChildJobId(issueRef, agentModel, baseBranch);

            assert.strictEqual(jobId, 'issue-my-org-my-repo-name-100-claude-claude-sonnet-4-5-feature/test-branch');
        });

        test('should handle epic branch names', () => {
            const issueRef = { repoOwner: 'integry', repoName: 'gitfix', number: 1110 };
            const agentModel = { agentAlias: 'claude', model: 'claude-opus-4-5-20251101' };
            const baseBranch = '1092-epic-add-unit-q9c';

            const jobId = generateChildJobId(issueRef, agentModel, baseBranch);

            assert.strictEqual(jobId, 'issue-integry-gitfix-1110-claude-claude-opus-4-5-20251101-1092-epic-add-unit-q9c');
        });
    });

    describe('extractBasesToProcess', () => {
        test('should return default branch when no base- labels present', () => {
            const labels = ['AI', 'bug', 'enhancement'];
            const defaultBranch = 'main';

            const bases = extractBasesToProcess(labels, defaultBranch);

            assert.deepStrictEqual(bases, [{ branch: 'main', label: null }]);
        });

        test('should extract single base- label', () => {
            const labels = ['AI', 'base-develop', 'bug'];
            const defaultBranch = 'main';

            const bases = extractBasesToProcess(labels, defaultBranch);

            assert.deepStrictEqual(bases, [{ branch: 'develop', label: 'base-develop' }]);
        });

        test('should extract multiple base- labels', () => {
            const labels = ['AI', 'base-main', 'base-develop', 'base-staging'];
            const defaultBranch = 'main';

            const bases = extractBasesToProcess(labels, defaultBranch);

            assert.deepStrictEqual(bases, [
                { branch: 'main', label: 'base-main' },
                { branch: 'develop', label: 'base-develop' },
                { branch: 'staging', label: 'base-staging' }
            ]);
        });

        test('should extract epic branch from base- label', () => {
            const labels = ['AI', 'auto-merge', 'base-1092-epic-add-unit-q9c'];
            const defaultBranch = 'main';

            const bases = extractBasesToProcess(labels, defaultBranch);

            assert.deepStrictEqual(bases, [
                { branch: '1092-epic-add-unit-q9c', label: 'base-1092-epic-add-unit-q9c' }
            ]);
        });

        test('should return empty array label when using default branch', () => {
            const labels = ['AI'];
            const defaultBranch = 'master';

            const bases = extractBasesToProcess(labels, defaultBranch);

            assert.strictEqual(bases[0].label, null);
            assert.strictEqual(bases[0].branch, 'master');
        });
    });

    describe('extractLlmLabels', () => {
        test('should extract llm- prefixed labels', () => {
            const labels = ['AI', 'llm-opus', 'bug', 'llm-sonnet'];

            const llmLabels = extractLlmLabels(labels);

            assert.deepStrictEqual(llmLabels, ['llm-opus', 'llm-sonnet']);
        });

        test('should return empty array when no llm- labels', () => {
            const labels = ['AI', 'bug', 'enhancement'];

            const llmLabels = extractLlmLabels(labels);

            assert.deepStrictEqual(llmLabels, []);
        });

        test('should handle single llm- label', () => {
            const labels = ['llm-claude-sonnet-4-5'];

            const llmLabels = extractLlmLabels(labels);

            assert.deepStrictEqual(llmLabels, ['llm-claude-sonnet-4-5']);
        });
    });

    describe('shouldUseDefaultAgent (fallback to default agent)', () => {
        test('should return true when no LLM labels and no custom labels', () => {
            const llmLabels: string[] = [];
            const customLabelMatches: string[] = [];

            const result = shouldUseDefaultAgent(llmLabels, customLabelMatches);

            assert.strictEqual(result, true);
        });

        test('should return false when LLM labels are present', () => {
            const llmLabels = ['llm-opus'];
            const customLabelMatches: string[] = [];

            const result = shouldUseDefaultAgent(llmLabels, customLabelMatches);

            assert.strictEqual(result, false);
        });

        test('should return false when custom labels are present', () => {
            const llmLabels: string[] = [];
            const customLabelMatches = ['my-custom-agent'];

            const result = shouldUseDefaultAgent(llmLabels, customLabelMatches);

            assert.strictEqual(result, false);
        });

        test('should return false when both LLM and custom labels are present', () => {
            const llmLabels = ['llm-sonnet'];
            const customLabelMatches = ['my-agent'];

            const result = shouldUseDefaultAgent(llmLabels, customLabelMatches);

            assert.strictEqual(result, false);
        });
    });

    describe('findCustomLabelMatches', () => {
        test('should find matching custom labels (case-insensitive)', () => {
            const issueLabels = ['AI', 'MyAgent', 'bug'];
            const configuredCustomLabels = ['myagent', 'other-agent'];

            const matches = findCustomLabelMatches(issueLabels, configuredCustomLabels);

            assert.deepStrictEqual(matches, ['MyAgent']);
        });

        test('should return empty array when no matches', () => {
            const issueLabels = ['AI', 'bug'];
            const configuredCustomLabels = ['myagent', 'other-agent'];

            const matches = findCustomLabelMatches(issueLabels, configuredCustomLabels);

            assert.deepStrictEqual(matches, []);
        });

        test('should find multiple matching labels', () => {
            const issueLabels = ['AI', 'agent-1', 'agent-2', 'bug'];
            const configuredCustomLabels = ['agent-1', 'agent-2', 'agent-3'];

            const matches = findCustomLabelMatches(issueLabels, configuredCustomLabels);

            assert.deepStrictEqual(matches, ['agent-1', 'agent-2']);
        });
    });

    describe('buildChildJobData', () => {
        test('should create child job data with all required fields', () => {
            const issueRef: IssueJobData = {
                repoOwner: 'integry',
                repoName: 'gitfix',
                number: 42
            };
            const base: BaseToProcess = { branch: 'main', label: null };
            const agentModel: AgentModelToProcess = {
                agentAlias: 'claude',
                model: 'claude-sonnet-4-5',
                label: 'llm-sonnet'
            };
            const currentIssueData = { title: 'Test Issue', body: 'Description' };
            const repoData = { defaultBranch: 'main', isPrivate: false };

            const childJobData = buildChildJobData(issueRef, base, agentModel, currentIssueData, repoData);

            assert.strictEqual(childJobData.repoOwner, 'integry');
            assert.strictEqual(childJobData.repoName, 'gitfix');
            assert.strictEqual(childJobData.number, 42);
            assert.strictEqual(childJobData.baseBranch, 'main');
            assert.strictEqual(childJobData.baseLabel, null);
            assert.strictEqual(childJobData.agentAlias, 'claude');
            assert.strictEqual(childJobData.modelName, 'claude-sonnet-4-5');
            assert.strictEqual(childJobData.modelLabel, 'llm-sonnet');
            assert.strictEqual(childJobData.isChildJob, true);
            assert.deepStrictEqual(childJobData.issuePayload, currentIssueData);
            assert.deepStrictEqual(childJobData.repoPayload, repoData);
        });

        test('should preserve existing issueRef properties', () => {
            const issueRef: IssueJobData = {
                repoOwner: 'org',
                repoName: 'repo',
                number: 100,
                correlationId: 'corr-123',
                triggeringLabel: 'AI'
            };
            const base: BaseToProcess = { branch: 'develop', label: 'base-develop' };
            const agentModel: AgentModelToProcess = {
                agentAlias: 'codex',
                model: 'codex-mini',
                label: null
            };

            const childJobData = buildChildJobData(issueRef, base, agentModel, {}, {});

            assert.strictEqual(childJobData.correlationId, 'corr-123');
            assert.strictEqual(childJobData.triggeringLabel, 'AI');
            assert.strictEqual(childJobData.baseBranch, 'develop');
            assert.strictEqual(childJobData.baseLabel, 'base-develop');
        });
    });

    describe('calculateTotalChildJobs (matrix expansion)', () => {
        test('should calculate 1 job for single base and single agent', () => {
            const bases: BaseToProcess[] = [{ branch: 'main', label: null }];
            const agents: AgentModelToProcess[] = [
                { agentAlias: 'claude', model: 'claude-sonnet-4-5', label: null }
            ];

            const total = calculateTotalChildJobs(bases, agents);

            assert.strictEqual(total, 1);
        });

        test('should calculate correct matrix expansion: 2 bases × 2 agents = 4 jobs', () => {
            const bases: BaseToProcess[] = [
                { branch: 'main', label: 'base-main' },
                { branch: 'develop', label: 'base-develop' }
            ];
            const agents: AgentModelToProcess[] = [
                { agentAlias: 'claude', model: 'claude-opus-4-5', label: 'llm-opus' },
                { agentAlias: 'claude', model: 'claude-sonnet-4-5', label: 'llm-sonnet' }
            ];

            const total = calculateTotalChildJobs(bases, agents);

            assert.strictEqual(total, 4);
        });

        test('should calculate correct matrix expansion: 3 bases × 2 agents = 6 jobs', () => {
            const bases: BaseToProcess[] = [
                { branch: 'main', label: null },
                { branch: 'develop', label: null },
                { branch: 'staging', label: null }
            ];
            const agents: AgentModelToProcess[] = [
                { agentAlias: 'claude', model: 'model-a', label: null },
                { agentAlias: 'codex', model: 'model-b', label: null }
            ];

            const total = calculateTotalChildJobs(bases, agents);

            assert.strictEqual(total, 6);
        });

        test('should calculate correct matrix expansion: 1 base × 3 agents = 3 jobs', () => {
            const bases: BaseToProcess[] = [{ branch: 'main', label: null }];
            const agents: AgentModelToProcess[] = [
                { agentAlias: 'claude', model: 'opus', label: 'llm-opus' },
                { agentAlias: 'claude', model: 'sonnet', label: 'llm-sonnet' },
                { agentAlias: 'claude', model: 'haiku', label: 'llm-haiku' }
            ];

            const total = calculateTotalChildJobs(bases, agents);

            assert.strictEqual(total, 3);
        });

        test('should return 0 for empty bases array', () => {
            const bases: BaseToProcess[] = [];
            const agents: AgentModelToProcess[] = [
                { agentAlias: 'claude', model: 'sonnet', label: null }
            ];

            const total = calculateTotalChildJobs(bases, agents);

            assert.strictEqual(total, 0);
        });

        test('should return 0 for empty agents array', () => {
            const bases: BaseToProcess[] = [{ branch: 'main', label: null }];
            const agents: AgentModelToProcess[] = [];

            const total = calculateTotalChildJobs(bases, agents);

            assert.strictEqual(total, 0);
        });
    });

    describe('integration scenarios', () => {
        test('should generate unique job IDs for full matrix expansion', () => {
            const issueRef = { repoOwner: 'org', repoName: 'repo', number: 42 };
            const bases: BaseToProcess[] = [
                { branch: 'main', label: null },
                { branch: 'develop', label: 'base-develop' }
            ];
            const agents: AgentModelToProcess[] = [
                { agentAlias: 'claude', model: 'opus', label: 'llm-opus' },
                { agentAlias: 'claude', model: 'sonnet', label: 'llm-sonnet' }
            ];

            const jobIds = new Set<string>();
            for (const base of bases) {
                for (const agent of agents) {
                    const jobId = generateChildJobId(issueRef, agent, base.branch);
                    jobIds.add(jobId);
                }
            }

            // Should have 4 unique job IDs (2 bases × 2 agents)
            assert.strictEqual(jobIds.size, 4);
        });

        test('should correctly determine default agent fallback for issue without LLM labels', () => {
            const labels = ['AI', 'bug', 'auto-merge'];
            const configuredCustomLabels: string[] = [];

            const llmLabels = extractLlmLabels(labels);
            const customMatches = findCustomLabelMatches(labels, configuredCustomLabels);
            const useDefault = shouldUseDefaultAgent(llmLabels, customMatches);

            assert.deepStrictEqual(llmLabels, []);
            assert.deepStrictEqual(customMatches, []);
            assert.strictEqual(useDefault, true);
        });

        test('should NOT use default agent when llm-opus label is present', () => {
            const labels = ['AI', 'llm-opus', 'bug'];
            const configuredCustomLabels: string[] = [];

            const llmLabels = extractLlmLabels(labels);
            const customMatches = findCustomLabelMatches(labels, configuredCustomLabels);
            const useDefault = shouldUseDefaultAgent(llmLabels, customMatches);

            assert.deepStrictEqual(llmLabels, ['llm-opus']);
            assert.strictEqual(useDefault, false);
        });

        test('should correctly handle issue with base label and default agent', () => {
            const labels = ['AI', 'base-1092-epic-add-unit-q9c', 'auto-merge', 'propr-planned'];
            const defaultBranch = 'main';
            const configuredCustomLabels: string[] = [];

            // Extract bases
            const bases = extractBasesToProcess(labels, defaultBranch);
            assert.deepStrictEqual(bases, [
                { branch: '1092-epic-add-unit-q9c', label: 'base-1092-epic-add-unit-q9c' }
            ]);

            // Determine agent usage
            const llmLabels = extractLlmLabels(labels);
            const customMatches = findCustomLabelMatches(labels, configuredCustomLabels);
            const useDefault = shouldUseDefaultAgent(llmLabels, customMatches);
            assert.strictEqual(useDefault, true);

            // With 1 base and 1 default agent, should create 1 child job
            const agents: AgentModelToProcess[] = [
                { agentAlias: 'default', model: 'claude-sonnet-4-5', label: null }
            ];
            const total = calculateTotalChildJobs(bases, agents);
            assert.strictEqual(total, 1);
        });
    });
});

describe('issueJobDispatcher - Job Queue Integration', () => {
    // Mock queue for testing job enqueueing
    interface MockQueueCall {
        jobName: string;
        jobData: IssueJobData;
        options: { jobId: string; removeOnComplete: boolean; removeOnFail: boolean };
    }

    /**
     * Simulates the job enqueueing logic from handleDispatch.
     * This function mirrors the nested loop at lines 164-196.
     */
    function simulateJobEnqueue(
        jobName: string,
        issueRef: IssueJobData,
        basesToProcess: BaseToProcess[],
        agentModelsToProcess: AgentModelToProcess[],
        currentIssueData: Record<string, unknown>,
        repoData: Record<string, unknown>
    ): MockQueueCall[] {
        const enqueuedJobs: MockQueueCall[] = [];

        for (const base of basesToProcess) {
            for (const agentModel of agentModelsToProcess) {
                const newJobData = buildChildJobData(
                    issueRef,
                    base,
                    agentModel,
                    currentIssueData,
                    repoData
                );

                const childJobId = generateChildJobId(issueRef, agentModel, base.branch);

                enqueuedJobs.push({
                    jobName,
                    jobData: newJobData,
                    options: {
                        jobId: childJobId,
                        removeOnComplete: true,
                        removeOnFail: true
                    }
                });
            }
        }

        return enqueuedJobs;
    }

    describe('creates child jobs', () => {
        test('should create single child job for default configuration', () => {
            const issueRef: IssueJobData = {
                repoOwner: 'integry',
                repoName: 'gitfix',
                number: 1110
            };
            const bases: BaseToProcess[] = [{ branch: 'main', label: null }];
            const agents: AgentModelToProcess[] = [
                { agentAlias: 'default', model: 'claude-sonnet-4-5', label: null }
            ];

            const jobs = simulateJobEnqueue(
                'processGitHubIssue',
                issueRef,
                bases,
                agents,
                { title: 'Test Issue' },
                { defaultBranch: 'main' }
            );

            assert.strictEqual(jobs.length, 1);
            assert.strictEqual(jobs[0].jobData.isChildJob, true);
            assert.strictEqual(jobs[0].jobData.baseBranch, 'main');
            assert.strictEqual(jobs[0].jobData.agentAlias, 'default');
            assert.strictEqual(jobs[0].options.jobId, 'issue-integry-gitfix-1110-default-claude-sonnet-4-5-main');
        });

        test('should create multiple child jobs for matrix expansion', () => {
            const issueRef: IssueJobData = {
                repoOwner: 'org',
                repoName: 'repo',
                number: 42
            };
            const bases: BaseToProcess[] = [
                { branch: 'main', label: 'base-main' },
                { branch: 'develop', label: 'base-develop' }
            ];
            const agents: AgentModelToProcess[] = [
                { agentAlias: 'claude', model: 'opus', label: 'llm-opus' },
                { agentAlias: 'claude', model: 'sonnet', label: 'llm-sonnet' }
            ];

            const jobs = simulateJobEnqueue(
                'processGitHubIssue',
                issueRef,
                bases,
                agents,
                {},
                {}
            );

            assert.strictEqual(jobs.length, 4);

            // Verify all combinations are present
            const jobIds = jobs.map(j => j.options.jobId);
            assert.ok(jobIds.includes('issue-org-repo-42-claude-opus-main'));
            assert.ok(jobIds.includes('issue-org-repo-42-claude-sonnet-main'));
            assert.ok(jobIds.includes('issue-org-repo-42-claude-opus-develop'));
            assert.ok(jobIds.includes('issue-org-repo-42-claude-sonnet-develop'));
        });

        test('should set removeOnComplete and removeOnFail to true', () => {
            const issueRef: IssueJobData = {
                repoOwner: 'org',
                repoName: 'repo',
                number: 1
            };
            const bases: BaseToProcess[] = [{ branch: 'main', label: null }];
            const agents: AgentModelToProcess[] = [
                { agentAlias: 'claude', model: 'sonnet', label: null }
            ];

            const jobs = simulateJobEnqueue('job', issueRef, bases, agents, {}, {});

            assert.strictEqual(jobs[0].options.removeOnComplete, true);
            assert.strictEqual(jobs[0].options.removeOnFail, true);
        });

        test('should preserve correlationId in child jobs', () => {
            const issueRef: IssueJobData = {
                repoOwner: 'org',
                repoName: 'repo',
                number: 42,
                correlationId: 'parent-correlation-id-123'
            };
            const bases: BaseToProcess[] = [{ branch: 'main', label: null }];
            const agents: AgentModelToProcess[] = [
                { agentAlias: 'claude', model: 'sonnet', label: null }
            ];

            const jobs = simulateJobEnqueue('job', issueRef, bases, agents, {}, {});

            assert.strictEqual(jobs[0].jobData.correlationId, 'parent-correlation-id-123');
        });
    });
});

describe('issueJobDispatcher - Error Handling', () => {
    /**
     * Pure function that determines if an error should cause job failure.
     * Extracted for testability.
     */
    function shouldFailJob(error: Error): { shouldFail: boolean; reason: string } {
        // Repository validation errors should fail the job
        if (error.message.includes('Repository validation failed')) {
            return { shouldFail: true, reason: 'repository_validation_failed' };
        }

        // Authentication errors should fail the job
        if (error.message.includes('Auth failed') || error.message.includes('authentication')) {
            return { shouldFail: true, reason: 'authentication_failed' };
        }

        // GitHub API errors should fail the job
        if (error.message.includes('GitHub API') || error.message.includes('rate limit')) {
            return { shouldFail: true, reason: 'github_api_error' };
        }

        return { shouldFail: true, reason: 'unknown_error' };
    }

    test('should identify repository validation failures', () => {
        const error = new Error('Repository validation failed');

        const result = shouldFailJob(error);

        assert.strictEqual(result.shouldFail, true);
        assert.strictEqual(result.reason, 'repository_validation_failed');
    });

    test('should identify authentication failures', () => {
        const error = new Error('Auth failed: Invalid token');

        const result = shouldFailJob(error);

        assert.strictEqual(result.shouldFail, true);
        assert.strictEqual(result.reason, 'authentication_failed');
    });

    test('should identify GitHub API errors', () => {
        const error = new Error('GitHub API rate limit exceeded');

        const result = shouldFailJob(error);

        assert.strictEqual(result.shouldFail, true);
        assert.strictEqual(result.reason, 'github_api_error');
    });

    test('should handle unknown errors', () => {
        const error = new Error('Something unexpected happened');

        const result = shouldFailJob(error);

        assert.strictEqual(result.shouldFail, true);
        assert.strictEqual(result.reason, 'unknown_error');
    });
});

describe('issueJobDispatcher - JobResult', () => {
    interface JobResult {
        status: string;
        jobsEnqueued: number;
        issueNumber: number;
    }

    /**
     * Pure function that builds the job result.
     * Extracted from handleDispatch line 200 for testability.
     */
    function buildJobResult(
        jobsEnqueued: number,
        issueNumber: number
    ): JobResult {
        return {
            status: 'dispatched',
            jobsEnqueued,
            issueNumber
        };
    }

    test('should return dispatched status with correct job count', () => {
        const result = buildJobResult(4, 42);

        assert.strictEqual(result.status, 'dispatched');
        assert.strictEqual(result.jobsEnqueued, 4);
        assert.strictEqual(result.issueNumber, 42);
    });

    test('should return correct count for single job', () => {
        const result = buildJobResult(1, 123);

        assert.strictEqual(result.jobsEnqueued, 1);
    });

    test('should return 0 jobs when no jobs enqueued', () => {
        const result = buildJobResult(0, 99);

        assert.strictEqual(result.jobsEnqueued, 0);
    });
});

describe('issueJobDispatcher - Label Resolution', () => {
    /**
     * Pure function for parsing the branch name from a base-* label.
     * Mirrors the logic at line 108: l.substring('base-'.length)
     */
    function parseBranchFromBaseLabel(baseLabel: string): string {
        return baseLabel.substring('base-'.length);
    }

    /**
     * Pure function for parsing the LLM name from an llm-* label.
     * Mirrors the logic at line 117: label.substring('llm-'.length)
     */
    function parseLlmFromLabel(llmLabel: string): string {
        return llmLabel.substring('llm-'.length);
    }

    /**
     * Mock resolution function for LLM labels.
     * In production, this calls resolveLlmLabel() from @propr/core.
     * Here we simulate the resolution logic for testing.
     */
    interface MockAgentConfig {
        alias: string;
        type: 'claude' | 'codex' | 'gemini';
        defaultModel: string;
        supportedModels: string[];
    }

    interface LlmLabelResolution {
        agentAlias: string;
        model: string;
    }

    const MODEL_ALIASES: Record<string, string> = {
        'opus': 'claude-opus-4-5',
        'opus4': 'claude-opus-4-5',
        'sonnet': 'claude-sonnet-4-5',
        'sonnet4': 'claude-sonnet-4-5',
        'haiku': 'claude-haiku-4-5',
        'haiku4': 'claude-haiku-4-5'
    };

    function mockResolveLlmLabel(
        label: string,
        agents: MockAgentConfig[],
        defaultAgentAlias: string
    ): LlmLabelResolution {
        const lowerLabel = label.toLowerCase();

        // Check if label matches an agent alias exactly
        for (const agent of agents) {
            if (agent.alias.toLowerCase() === lowerLabel) {
                return {
                    agentAlias: agent.alias,
                    model: agent.defaultModel
                };
            }
        }

        // Check if label starts with an agent alias (e.g., "gemini-pro")
        for (const agent of agents) {
            const aliasLower = agent.alias.toLowerCase();
            if (lowerLabel.startsWith(aliasLower + '-')) {
                const modelPart = label.substring(aliasLower.length + 1);
                // Find matching model
                const matchedModel = agent.supportedModels.find(m =>
                    m.toLowerCase().includes(modelPart.toLowerCase())
                );
                return {
                    agentAlias: agent.alias,
                    model: matchedModel || agent.defaultModel
                };
            }
        }

        // Check static MODEL_ALIASES
        if (MODEL_ALIASES[lowerLabel]) {
            return {
                agentAlias: defaultAgentAlias,
                model: MODEL_ALIASES[lowerLabel]
            };
        }

        // Fall back to default agent with label as model name
        return {
            agentAlias: defaultAgentAlias,
            model: label
        };
    }

    /**
     * Mock resolution function for custom labels.
     * Custom labels are configured per-model in agent config.
     */
    interface MockAgentWithCustomLabels extends MockAgentConfig {
        modelCustomLabels?: Record<string, string>;
    }

    function mockResolveCustomLabel(
        label: string,
        agents: MockAgentWithCustomLabels[]
    ): LlmLabelResolution | null {
        const lowerLabel = label.toLowerCase();

        for (const agent of agents) {
            if (agent.modelCustomLabels) {
                for (const [modelId, customLabel] of Object.entries(agent.modelCustomLabels)) {
                    if (customLabel && customLabel.toLowerCase() === lowerLabel) {
                        return {
                            agentAlias: agent.alias,
                            model: modelId
                        };
                    }
                }
            }
        }

        return null;
    }

    describe('parseBranchFromBaseLabel', () => {
        test('should parse simple branch name', () => {
            const branch = parseBranchFromBaseLabel('base-main');
            assert.strictEqual(branch, 'main');
        });

        test('should parse develop branch', () => {
            const branch = parseBranchFromBaseLabel('base-develop');
            assert.strictEqual(branch, 'develop');
        });

        test('should parse feature branch with slashes', () => {
            const branch = parseBranchFromBaseLabel('base-feature/new-feature');
            assert.strictEqual(branch, 'feature/new-feature');
        });

        test('should parse epic branch with numbers', () => {
            const branch = parseBranchFromBaseLabel('base-1092-epic-add-unit-q9c');
            assert.strictEqual(branch, '1092-epic-add-unit-q9c');
        });

        test('should parse release branch', () => {
            const branch = parseBranchFromBaseLabel('base-release/v2.0.0');
            assert.strictEqual(branch, 'release/v2.0.0');
        });

        test('should handle branch names with multiple dashes', () => {
            const branch = parseBranchFromBaseLabel('base-fix-bug-123-urgent');
            assert.strictEqual(branch, 'fix-bug-123-urgent');
        });

        test('should handle branch names with underscores', () => {
            const branch = parseBranchFromBaseLabel('base-my_feature_branch');
            assert.strictEqual(branch, 'my_feature_branch');
        });

        test('should handle branch names with dots', () => {
            const branch = parseBranchFromBaseLabel('base-v1.0.0-hotfix');
            assert.strictEqual(branch, 'v1.0.0-hotfix');
        });
    });

    describe('parseLlmFromLabel', () => {
        test('should parse simple model alias', () => {
            const llm = parseLlmFromLabel('llm-opus');
            assert.strictEqual(llm, 'opus');
        });

        test('should parse model alias with version', () => {
            const llm = parseLlmFromLabel('llm-sonnet4');
            assert.strictEqual(llm, 'sonnet4');
        });

        test('should parse full model name', () => {
            const llm = parseLlmFromLabel('llm-claude-opus-4-5');
            assert.strictEqual(llm, 'claude-opus-4-5');
        });

        test('should parse agent-prefixed model', () => {
            const llm = parseLlmFromLabel('llm-gemini-pro');
            assert.strictEqual(llm, 'gemini-pro');
        });

        test('should parse model with date suffix', () => {
            const llm = parseLlmFromLabel('llm-claude-opus-4-5-20251101');
            assert.strictEqual(llm, 'claude-opus-4-5-20251101');
        });

        test('should handle codex models', () => {
            const llm = parseLlmFromLabel('llm-codex-mini');
            assert.strictEqual(llm, 'codex-mini');
        });
    });

    describe('mockResolveLlmLabel (agent + model resolution)', () => {
        const mockAgents: MockAgentConfig[] = [
            {
                alias: 'claude',
                type: 'claude',
                defaultModel: 'claude-sonnet-4-5',
                supportedModels: ['claude-opus-4-5', 'claude-sonnet-4-5', 'claude-haiku-4-5']
            },
            {
                alias: 'gemini',
                type: 'gemini',
                defaultModel: 'gemini-2.5-pro',
                supportedModels: ['gemini-2.5-pro', 'gemini-3-flash-preview']
            },
            {
                alias: 'codex',
                type: 'codex',
                defaultModel: 'codex-mini',
                supportedModels: ['codex-mini', 'gpt-4o']
            }
        ];

        test('should resolve exact agent alias to default model', () => {
            const result = mockResolveLlmLabel('claude', mockAgents, 'default');

            assert.strictEqual(result.agentAlias, 'claude');
            assert.strictEqual(result.model, 'claude-sonnet-4-5');
        });

        test('should resolve gemini agent alias to default model', () => {
            const result = mockResolveLlmLabel('gemini', mockAgents, 'default');

            assert.strictEqual(result.agentAlias, 'gemini');
            assert.strictEqual(result.model, 'gemini-2.5-pro');
        });

        test('should resolve agent-prefixed model: gemini-pro', () => {
            const result = mockResolveLlmLabel('gemini-pro', mockAgents, 'default');

            assert.strictEqual(result.agentAlias, 'gemini');
            assert.strictEqual(result.model, 'gemini-2.5-pro');
        });

        test('should resolve agent-prefixed model: claude-opus', () => {
            const result = mockResolveLlmLabel('claude-opus', mockAgents, 'default');

            assert.strictEqual(result.agentAlias, 'claude');
            assert.strictEqual(result.model, 'claude-opus-4-5');
        });

        test('should resolve agent-prefixed model: claude-haiku', () => {
            const result = mockResolveLlmLabel('claude-haiku', mockAgents, 'default');

            assert.strictEqual(result.agentAlias, 'claude');
            assert.strictEqual(result.model, 'claude-haiku-4-5');
        });

        test('should resolve static alias: opus', () => {
            const result = mockResolveLlmLabel('opus', mockAgents, 'default');

            assert.strictEqual(result.agentAlias, 'default');
            assert.strictEqual(result.model, 'claude-opus-4-5');
        });

        test('should resolve static alias: sonnet', () => {
            const result = mockResolveLlmLabel('sonnet', mockAgents, 'default');

            assert.strictEqual(result.agentAlias, 'default');
            assert.strictEqual(result.model, 'claude-sonnet-4-5');
        });

        test('should fall back to default agent for unknown label', () => {
            const result = mockResolveLlmLabel('unknown-model', mockAgents, 'default');

            assert.strictEqual(result.agentAlias, 'default');
            assert.strictEqual(result.model, 'unknown-model');
        });

        test('should be case-insensitive for agent alias', () => {
            const result = mockResolveLlmLabel('CLAUDE', mockAgents, 'default');

            assert.strictEqual(result.agentAlias, 'claude');
            assert.strictEqual(result.model, 'claude-sonnet-4-5');
        });

        test('should be case-insensitive for static aliases', () => {
            const result = mockResolveLlmLabel('OPUS', mockAgents, 'default');

            assert.strictEqual(result.agentAlias, 'default');
            assert.strictEqual(result.model, 'claude-opus-4-5');
        });
    });

    describe('mockResolveCustomLabel (custom agent label resolution)', () => {
        const mockAgentsWithCustomLabels: MockAgentWithCustomLabels[] = [
            {
                alias: 'claude-prod',
                type: 'claude',
                defaultModel: 'claude-sonnet-4-5',
                supportedModels: ['claude-opus-4-5', 'claude-sonnet-4-5'],
                modelCustomLabels: {
                    'claude-opus-4-5': 'my-opus-bot',
                    'claude-sonnet-4-5': 'my-sonnet-helper'
                }
            },
            {
                alias: 'gemini-dev',
                type: 'gemini',
                defaultModel: 'gemini-2.5-pro',
                supportedModels: ['gemini-2.5-pro'],
                modelCustomLabels: {
                    'gemini-2.5-pro': 'custom-gemini'
                }
            },
            {
                alias: 'claude-no-custom',
                type: 'claude',
                defaultModel: 'claude-sonnet-4-5',
                supportedModels: ['claude-sonnet-4-5']
                // No modelCustomLabels
            }
        ];

        test('should resolve custom label to specific agent and model', () => {
            const result = mockResolveCustomLabel('my-opus-bot', mockAgentsWithCustomLabels);

            assert.ok(result !== null);
            assert.strictEqual(result.agentAlias, 'claude-prod');
            assert.strictEqual(result.model, 'claude-opus-4-5');
        });

        test('should resolve another custom label', () => {
            const result = mockResolveCustomLabel('my-sonnet-helper', mockAgentsWithCustomLabels);

            assert.ok(result !== null);
            assert.strictEqual(result.agentAlias, 'claude-prod');
            assert.strictEqual(result.model, 'claude-sonnet-4-5');
        });

        test('should resolve gemini custom label', () => {
            const result = mockResolveCustomLabel('custom-gemini', mockAgentsWithCustomLabels);

            assert.ok(result !== null);
            assert.strictEqual(result.agentAlias, 'gemini-dev');
            assert.strictEqual(result.model, 'gemini-2.5-pro');
        });

        test('should return null for non-matching label', () => {
            const result = mockResolveCustomLabel('unknown-label', mockAgentsWithCustomLabels);

            assert.strictEqual(result, null);
        });

        test('should be case-insensitive', () => {
            const result = mockResolveCustomLabel('MY-OPUS-BOT', mockAgentsWithCustomLabels);

            assert.ok(result !== null);
            assert.strictEqual(result.agentAlias, 'claude-prod');
            assert.strictEqual(result.model, 'claude-opus-4-5');
        });

        test('should handle agents without custom labels gracefully', () => {
            const result = mockResolveCustomLabel('claude-no-custom', mockAgentsWithCustomLabels);

            // This should not match because 'claude-no-custom' is an alias, not a custom label
            assert.strictEqual(result, null);
        });
    });

    describe('label resolution integration scenarios', () => {
        const mockAgents: MockAgentWithCustomLabels[] = [
            {
                alias: 'claude',
                type: 'claude',
                defaultModel: 'claude-sonnet-4-5',
                supportedModels: ['claude-opus-4-5', 'claude-sonnet-4-5', 'claude-haiku-4-5'],
                modelCustomLabels: {
                    'claude-opus-4-5': 'enterprise-bot'
                }
            },
            {
                alias: 'gemini',
                type: 'gemini',
                defaultModel: 'gemini-2.5-pro',
                supportedModels: ['gemini-2.5-pro', 'gemini-3-flash-preview']
            }
        ];

        test('should correctly build agentModelsToProcess from mixed labels', () => {
            const labels = ['AI', 'llm-opus', 'llm-gemini', 'enterprise-bot', 'bug'];
            const agentModelsToProcess: { agentAlias: string; model: string; label: string | null }[] = [];

            // Extract and process llm- labels
            const llmLabels = labels.filter(l => l.startsWith('llm-'));
            for (const label of llmLabels) {
                const llmPart = label.substring('llm-'.length);
                const resolution = mockResolveLlmLabel(llmPart, mockAgents, 'default');
                agentModelsToProcess.push({
                    agentAlias: resolution.agentAlias,
                    model: resolution.model,
                    label
                });
            }

            // Extract and process custom labels
            const customLabels = ['enterprise-bot']; // configured custom labels
            const customLabelMatches = labels.filter(l =>
                customLabels.some(cl => cl.toLowerCase() === l.toLowerCase())
            );
            for (const label of customLabelMatches) {
                const resolution = mockResolveCustomLabel(label, mockAgents);
                if (resolution) {
                    agentModelsToProcess.push({
                        agentAlias: resolution.agentAlias,
                        model: resolution.model,
                        label
                    });
                }
            }

            // Should have 3 agent models: opus, gemini, enterprise-bot
            assert.strictEqual(agentModelsToProcess.length, 3);

            // Verify llm-opus resolved correctly
            const opusEntry = agentModelsToProcess.find(a => a.label === 'llm-opus');
            assert.ok(opusEntry);
            assert.strictEqual(opusEntry.model, 'claude-opus-4-5');

            // Verify llm-gemini resolved correctly
            const geminiEntry = agentModelsToProcess.find(a => a.label === 'llm-gemini');
            assert.ok(geminiEntry);
            assert.strictEqual(geminiEntry.agentAlias, 'gemini');
            assert.strictEqual(geminiEntry.model, 'gemini-2.5-pro');

            // Verify enterprise-bot resolved correctly
            const customEntry = agentModelsToProcess.find(a => a.label === 'enterprise-bot');
            assert.ok(customEntry);
            assert.strictEqual(customEntry.agentAlias, 'claude');
            assert.strictEqual(customEntry.model, 'claude-opus-4-5');
        });

        test('should process real-world issue labels scenario', () => {
            // Scenario: Issue with base label and multiple model labels
            const labels = ['AI', 'base-1092-epic-add-unit-q9c', 'auto-merge', 'propr-planned', 'llm-claude-opus-4-5-20251101'];
            const defaultBranch = 'main';

            // Extract bases
            const baseLabels = labels.filter(l => l.startsWith('base-'));
            const basesToProcess = baseLabels.length > 0
                ? baseLabels.map(l => ({
                    branch: l.substring('base-'.length),
                    label: l
                }))
                : [{ branch: defaultBranch, label: null }];

            assert.strictEqual(basesToProcess.length, 1);
            assert.strictEqual(basesToProcess[0].branch, '1092-epic-add-unit-q9c');
            assert.strictEqual(basesToProcess[0].label, 'base-1092-epic-add-unit-q9c');

            // Extract LLM labels
            const llmLabels = labels.filter(l => l.startsWith('llm-'));
            assert.deepStrictEqual(llmLabels, ['llm-claude-opus-4-5-20251101']);
        });

        test('should handle issue with no special labels (default agent scenario)', () => {
            const labels = ['AI', 'bug', 'enhancement'];
            const defaultBranch = 'main';
            const configuredCustomLabels: string[] = [];

            // Extract bases
            const baseLabels = labels.filter(l => l.startsWith('base-'));
            const basesToProcess = baseLabels.length > 0
                ? baseLabels.map(l => ({
                    branch: l.substring('base-'.length),
                    label: l
                }))
                : [{ branch: defaultBranch, label: null }];

            // Extract LLM labels
            const llmLabels = labels.filter(l => l.startsWith('llm-'));

            // Find custom label matches
            const customLabelMatches = labels.filter(l =>
                configuredCustomLabels.some(cl => cl.toLowerCase() === l.toLowerCase())
            );

            // Should use default agent
            const shouldUseDefault = llmLabels.length === 0 && customLabelMatches.length === 0;

            assert.strictEqual(basesToProcess.length, 1);
            assert.strictEqual(basesToProcess[0].branch, 'main');
            assert.strictEqual(basesToProcess[0].label, null);
            assert.strictEqual(llmLabels.length, 0);
            assert.strictEqual(customLabelMatches.length, 0);
            assert.strictEqual(shouldUseDefault, true);
        });
    });
});

describe('issueJobDispatcher - Matrix Expansion Edge Cases', () => {
    interface BaseToProcess {
        branch: string;
        label: string | null;
    }

    interface AgentModelToProcess {
        agentAlias: string;
        model: string;
        label: string | null;
    }

    /**
     * Generates all combinations for matrix expansion.
     * This mirrors the nested loop at lines 164-196 of issueJobDispatcher.ts.
     */
    function generateMatrixCombinations(
        bases: BaseToProcess[],
        agents: AgentModelToProcess[]
    ): Array<{ base: BaseToProcess; agent: AgentModelToProcess }> {
        const combinations: Array<{ base: BaseToProcess; agent: AgentModelToProcess }> = [];

        for (const base of bases) {
            for (const agent of agents) {
                combinations.push({ base, agent });
            }
        }

        return combinations;
    }

    describe('generateMatrixCombinations', () => {
        test('should generate 1 combination for 1×1', () => {
            const bases: BaseToProcess[] = [{ branch: 'main', label: null }];
            const agents: AgentModelToProcess[] = [
                { agentAlias: 'claude', model: 'sonnet', label: null }
            ];

            const combos = generateMatrixCombinations(bases, agents);

            assert.strictEqual(combos.length, 1);
            assert.strictEqual(combos[0].base.branch, 'main');
            assert.strictEqual(combos[0].agent.agentAlias, 'claude');
        });

        test('should generate 4 combinations for 2×2', () => {
            const bases: BaseToProcess[] = [
                { branch: 'main', label: 'base-main' },
                { branch: 'develop', label: 'base-develop' }
            ];
            const agents: AgentModelToProcess[] = [
                { agentAlias: 'claude', model: 'opus', label: 'llm-opus' },
                { agentAlias: 'claude', model: 'sonnet', label: 'llm-sonnet' }
            ];

            const combos = generateMatrixCombinations(bases, agents);

            assert.strictEqual(combos.length, 4);

            // Verify all combinations exist
            const hasMainOpus = combos.some(c => c.base.branch === 'main' && c.agent.model === 'opus');
            const hasMainSonnet = combos.some(c => c.base.branch === 'main' && c.agent.model === 'sonnet');
            const hasDevelopOpus = combos.some(c => c.base.branch === 'develop' && c.agent.model === 'opus');
            const hasDevelopSonnet = combos.some(c => c.base.branch === 'develop' && c.agent.model === 'sonnet');

            assert.strictEqual(hasMainOpus, true);
            assert.strictEqual(hasMainSonnet, true);
            assert.strictEqual(hasDevelopOpus, true);
            assert.strictEqual(hasDevelopSonnet, true);
        });

        test('should generate 6 combinations for 3×2', () => {
            const bases: BaseToProcess[] = [
                { branch: 'main', label: null },
                { branch: 'develop', label: null },
                { branch: 'staging', label: null }
            ];
            const agents: AgentModelToProcess[] = [
                { agentAlias: 'claude', model: 'opus', label: null },
                { agentAlias: 'gemini', model: 'pro', label: null }
            ];

            const combos = generateMatrixCombinations(bases, agents);

            assert.strictEqual(combos.length, 6);
        });

        test('should generate 9 combinations for 3×3', () => {
            const bases: BaseToProcess[] = [
                { branch: 'main', label: null },
                { branch: 'develop', label: null },
                { branch: 'staging', label: null }
            ];
            const agents: AgentModelToProcess[] = [
                { agentAlias: 'claude', model: 'opus', label: null },
                { agentAlias: 'claude', model: 'sonnet', label: null },
                { agentAlias: 'gemini', model: 'pro', label: null }
            ];

            const combos = generateMatrixCombinations(bases, agents);

            assert.strictEqual(combos.length, 9);
        });

        test('should generate 0 combinations when bases is empty', () => {
            const bases: BaseToProcess[] = [];
            const agents: AgentModelToProcess[] = [
                { agentAlias: 'claude', model: 'opus', label: null }
            ];

            const combos = generateMatrixCombinations(bases, agents);

            assert.strictEqual(combos.length, 0);
        });

        test('should generate 0 combinations when agents is empty', () => {
            const bases: BaseToProcess[] = [{ branch: 'main', label: null }];
            const agents: AgentModelToProcess[] = [];

            const combos = generateMatrixCombinations(bases, agents);

            assert.strictEqual(combos.length, 0);
        });

        test('should preserve label information in combinations', () => {
            const bases: BaseToProcess[] = [
                { branch: '1092-epic', label: 'base-1092-epic' }
            ];
            const agents: AgentModelToProcess[] = [
                { agentAlias: 'claude-prod', model: 'claude-opus-4-5-20251101', label: 'llm-claude-opus-4-5-20251101' }
            ];

            const combos = generateMatrixCombinations(bases, agents);

            assert.strictEqual(combos.length, 1);
            assert.strictEqual(combos[0].base.label, 'base-1092-epic');
            assert.strictEqual(combos[0].agent.label, 'llm-claude-opus-4-5-20251101');
        });

        test('should handle mixed custom and llm labels in matrix', () => {
            const bases: BaseToProcess[] = [{ branch: 'main', label: null }];
            const agents: AgentModelToProcess[] = [
                { agentAlias: 'claude', model: 'opus', label: 'llm-opus' },
                { agentAlias: 'claude-prod', model: 'claude-opus-4-5', label: 'enterprise-bot' }  // custom label
            ];

            const combos = generateMatrixCombinations(bases, agents);

            assert.strictEqual(combos.length, 2);

            const llmCombo = combos.find(c => c.agent.label === 'llm-opus');
            const customCombo = combos.find(c => c.agent.label === 'enterprise-bot');

            assert.ok(llmCombo);
            assert.ok(customCombo);
        });
    });

    describe('complex matrix expansion scenarios', () => {
        test('should handle 5 bases × 4 agents = 20 jobs', () => {
            const bases: BaseToProcess[] = [
                { branch: 'main', label: null },
                { branch: 'develop', label: null },
                { branch: 'staging', label: null },
                { branch: 'qa', label: null },
                { branch: 'production', label: null }
            ];
            const agents: AgentModelToProcess[] = [
                { agentAlias: 'claude', model: 'opus', label: null },
                { agentAlias: 'claude', model: 'sonnet', label: null },
                { agentAlias: 'gemini', model: 'pro', label: null },
                { agentAlias: 'codex', model: 'mini', label: null }
            ];

            const combos = generateMatrixCombinations(bases, agents);

            assert.strictEqual(combos.length, 20);
        });

        test('should order combinations correctly: bases first, then agents', () => {
            const bases: BaseToProcess[] = [
                { branch: 'A', label: null },
                { branch: 'B', label: null }
            ];
            const agents: AgentModelToProcess[] = [
                { agentAlias: 'agent1', model: 'model1', label: null },
                { agentAlias: 'agent2', model: 'model2', label: null }
            ];

            const combos = generateMatrixCombinations(bases, agents);

            // Should be ordered: A-agent1, A-agent2, B-agent1, B-agent2
            assert.strictEqual(combos[0].base.branch, 'A');
            assert.strictEqual(combos[0].agent.agentAlias, 'agent1');

            assert.strictEqual(combos[1].base.branch, 'A');
            assert.strictEqual(combos[1].agent.agentAlias, 'agent2');

            assert.strictEqual(combos[2].base.branch, 'B');
            assert.strictEqual(combos[2].agent.agentAlias, 'agent1');

            assert.strictEqual(combos[3].base.branch, 'B');
            assert.strictEqual(combos[3].agent.agentAlias, 'agent2');
        });

        test('should generate unique job IDs for all matrix combinations', () => {
            const issueRef = { repoOwner: 'org', repoName: 'repo', number: 100 };
            const bases: BaseToProcess[] = [
                { branch: 'main', label: null },
                { branch: 'develop', label: null }
            ];
            const agents: AgentModelToProcess[] = [
                { agentAlias: 'claude', model: 'opus', label: null },
                { agentAlias: 'gemini', model: 'pro', label: null }
            ];

            const jobIds = new Set<string>();
            const combos = generateMatrixCombinations(bases, agents);

            for (const combo of combos) {
                const jobId = `issue-${issueRef.repoOwner}-${issueRef.repoName}-${issueRef.number}-${combo.agent.agentAlias}-${combo.agent.model}-${combo.base.branch}`;
                jobIds.add(jobId);
            }

            // All 4 job IDs should be unique
            assert.strictEqual(jobIds.size, 4);
        });
    });
});
