import { test, mock, describe } from 'node:test';
import assert from 'node:assert';
import type { CheckRunEvent } from '@octokit/webhooks-types';

// Mock Octokit used by all helper functions
const mockOctokit = {
    request: mock.fn()
};

const mockRedisGet = mock.fn(async () => null);
const redisConstructorCalls: unknown[][] = [];

// Mock simple-git (transitive dependency)
await mock.module('simple-git', {
    namedExports: {
        simpleGit: mock.fn(() => ({})),
        SimpleGit: class {}
    }
});

// Mock ioredis
await mock.module('ioredis', {
    defaultExport: function Redis(...args: unknown[]) {
        redisConstructorCalls.push(args);
        return { on: mock.fn(), get: mockRedisGet, quit: mock.fn(async () => {}) };
    },
    namedExports: {
        Redis: function Redis(...args: unknown[]) {
            redisConstructorCalls.push(args);
            return { on: mock.fn(), get: mockRedisGet, quit: mock.fn(async () => {}) };
        }
    }
});

// Mock bullmq
await mock.module('bullmq', {
    namedExports: {
        Queue: function Queue() {
            return { add: mock.fn(), close: mock.fn(), on: mock.fn() };
        },
        Worker: function Worker() {
            return { on: mock.fn(), close: mock.fn() };
        }
    }
});

// Mock better-sqlite3
await mock.module('better-sqlite3', {
    defaultExport: function Database() {
        return {
            exec: mock.fn(),
            prepare: mock.fn(() => ({ run: mock.fn(), get: mock.fn(), all: mock.fn(() => []) })),
            close: mock.fn(),
            pragma: mock.fn(),
        };
    }
});

// Mock GitHub auth
await mock.module('../packages/core/src/auth/githubAuth.js', {
    namedExports: {
        getAuthenticatedOctokit: mock.fn(async () => mockOctokit),
    }
});

// Mock logger
const mockLogger = {
    info: mock.fn(),
    warn: mock.fn(),
    error: mock.fn(),
    debug: mock.fn(),
    withCorrelation: mock.fn(() => ({
        info: mock.fn(),
        warn: mock.fn(),
        error: mock.fn(),
        debug: mock.fn(),
    })),
};

await mock.module('../packages/core/src/utils/logger.js', {
    defaultExport: mockLogger
});

// Mock planIssueManager
const mockFindPlanIssueByRepoAndPR = mock.fn(async () => null);
const mockFindPlanIssueByRepoAndNumber = mock.fn(async () => null);
const mockUpdatePlanIssueByPR = mock.fn(async () => {});

await mock.module('../packages/core/src/config/planIssueManager.js', {
    namedExports: {
        findPlanIssueByRepoAndPR: mockFindPlanIssueByRepoAndPR,
        findPlanIssueByRepoAndNumber: mockFindPlanIssueByRepoAndNumber,
        updatePlanIssueByPR: mockUpdatePlanIssueByPR
    }
});

// Mock planIssueTracking
const mockTriggerNextPendingIssue = mock.fn(async () => {});

await mock.module('../packages/core/src/webhook/planIssueTracking.js', {
    namedExports: {
        triggerNextPendingIssue: mockTriggerNextPendingIssue
    }
});

// Mock taskExecutionService (isEpicBranch)
await mock.module('../packages/core/src/services/taskExecutionService.js', {
    namedExports: {
        isEpicBranch: mock.fn((branchName: string) => /^\d+-epic-\w+-\w+-\w+$/.test(branchName)),
        extractFirstIssueIdFromEpicBranch: mock.fn((branchName: string) => {
            const match = branchName.match(/^(\d+)-epic-/);
            return match ? parseInt(match[1], 10) : null;
        }),
    }
});

// Import the modules under test
const {
    mergePR,
    deleteBranch,
    getCurrentPRHead,
    areAllChecksPassing,
    getPRAutoMergeInfo,
    linkedIssueHasAutoMergeLabel,
    getFirstCommitMessage,
    resetUltrafixStateRedisForTests
} = await import('../packages/core/src/webhook/checkRunHelpers.js');

const { handleCheckRunEvent, shouldAutoMergePR } = await import('../packages/core/src/webhook/checkRunHandler.js');
import type { PRMergeContext } from '../packages/core/src/webhook/checkRunHandler.js';

// Helper to reset all mocks
function resetMocks(): void {
    mockOctokit.request.mock.resetCalls();
    mockRedisGet.mock.resetCalls();
    mockRedisGet.mock.mockImplementation(async () => null);
    redisConstructorCalls.length = 0;
    mockFindPlanIssueByRepoAndPR.mock.resetCalls();
    mockFindPlanIssueByRepoAndNumber.mock.resetCalls();
    mockUpdatePlanIssueByPR.mock.resetCalls();
    mockTriggerNextPendingIssue.mock.resetCalls();
    resetUltrafixStateRedisForTests();
}

// Helper to create a mock CheckRunEvent payload
function createMockCheckRunPayload(options: {
    action?: string;
    conclusion?: string | null;
    headSha?: string;
    pullRequests?: Array<{ number: number }>;
    repoFullName?: string;
    checkRunName?: string;
}): CheckRunEvent {
    const {
        action = 'completed',
        conclusion = 'success',
        headSha = 'abc123sha',
        pullRequests = [{ number: 42 }],
        repoFullName = 'test-owner/test-repo',
        checkRunName = 'CI Tests'
    } = options;

    return {
        action,
        check_run: {
            id: 1,
            name: checkRunName,
            head_sha: headSha,
            conclusion,
            status: 'completed',
            pull_requests: pullRequests.map(pr => ({
                number: pr.number,
                id: pr.number,
                url: `https://api.github.com/repos/${repoFullName}/pulls/${pr.number}`,
                head: { sha: headSha, ref: 'feature-branch' },
                base: { sha: 'base123', ref: 'main' }
            })),
            check_suite: { id: 1 },
            app: { id: 1 },
            started_at: new Date().toISOString(),
            html_url: `https://github.com/${repoFullName}/runs/1`,
            details_url: null,
            external_id: '',
            node_id: 'node1',
            output: { title: null, summary: null, text: null, annotations_count: 0, annotations_url: '' },
            url: `https://api.github.com/repos/${repoFullName}/check-runs/1`
        },
        repository: {
            id: 1,
            node_id: 'R_1',
            name: repoFullName.split('/')[1],
            full_name: repoFullName,
            private: false,
            owner: {
                login: repoFullName.split('/')[0],
                id: 1,
                node_id: 'U_1',
                avatar_url: '',
                gravatar_id: '',
                url: '',
                html_url: '',
                followers_url: '',
                following_url: '',
                gists_url: '',
                starred_url: '',
                subscriptions_url: '',
                organizations_url: '',
                repos_url: '',
                events_url: '',
                received_events_url: '',
                type: 'User',
                site_admin: false
            },
            html_url: `https://github.com/${repoFullName}`,
            description: null,
            fork: false,
            url: `https://api.github.com/repos/${repoFullName}`,
            forks_url: '', keys_url: '', collaborators_url: '', teams_url: '', hooks_url: '',
            issue_events_url: '', events_url: '', assignees_url: '', branches_url: '', tags_url: '',
            blobs_url: '', git_tags_url: '', git_refs_url: '', trees_url: '', statuses_url: '',
            languages_url: '', stargazers_url: '', contributors_url: '', subscribers_url: '',
            subscription_url: '', commits_url: '', git_commits_url: '', comments_url: '',
            issue_comment_url: '', contents_url: '', compare_url: '', merges_url: '', archive_url: '',
            downloads_url: '', issues_url: '', pulls_url: '', milestones_url: '', notifications_url: '',
            labels_url: '', releases_url: '', deployments_url: '', created_at: '', updated_at: '',
            pushed_at: '', git_url: '', ssh_url: '', clone_url: '', svn_url: '', homepage: null,
            size: 0, stargazers_count: 0, watchers_count: 0, language: null, has_issues: true,
            has_projects: true, has_downloads: true, has_wiki: true, has_pages: false, has_discussions: false,
            forks_count: 0, mirror_url: null, archived: false, disabled: false, open_issues_count: 0,
            license: null, allow_forking: true, is_template: false, web_commit_signoff_required: false,
            topics: [], visibility: 'public', forks: 0, open_issues: 0, watchers: 0, default_branch: 'main'
        },
        sender: {
            login: 'github-actions', id: 1, node_id: 'U_1', avatar_url: '', gravatar_id: '', url: '',
            html_url: '', followers_url: '', following_url: '', gists_url: '', starred_url: '',
            subscriptions_url: '', organizations_url: '', repos_url: '', events_url: '',
            received_events_url: '', type: 'Bot', site_admin: false
        }
    } as CheckRunEvent;
}

// ============= areAllChecksPassing Tests =============

describe('areAllChecksPassing', () => {
    test('returns true when all checks completed with success', async () => {
        resetMocks();
        mockOctokit.request.mock.mockImplementation(async () => ({
            data: {
                check_runs: [
                    { name: 'CI', status: 'completed', conclusion: 'success' },
                    { name: 'Build', status: 'completed', conclusion: 'success' }
                ]
            }
        }));

        const result = await areAllChecksPassing('owner', 'repo', 'sha123');
        assert.strictEqual(result, true);
    });

    test('returns true when checks are success + skipped mix', async () => {
        resetMocks();
        mockOctokit.request.mock.mockImplementation(async () => ({
            data: {
                check_runs: [
                    { name: 'CI', status: 'completed', conclusion: 'success' },
                    { name: 'Optional', status: 'completed', conclusion: 'skipped' }
                ]
            }
        }));

        const result = await areAllChecksPassing('owner', 'repo', 'sha123');
        assert.strictEqual(result, true);
    });

    test('returns false when any check is in_progress', async () => {
        resetMocks();
        mockOctokit.request.mock.mockImplementation(async () => ({
            data: {
                check_runs: [
                    { name: 'CI', status: 'completed', conclusion: 'success' },
                    { name: 'Build', status: 'in_progress', conclusion: null }
                ]
            }
        }));

        const result = await areAllChecksPassing('owner', 'repo', 'sha123');
        assert.strictEqual(result, false);
    });

    test('returns false when any check failed', async () => {
        resetMocks();
        mockOctokit.request.mock.mockImplementation(async () => ({
            data: {
                check_runs: [
                    { name: 'CI', status: 'completed', conclusion: 'success' },
                    { name: 'Build', status: 'completed', conclusion: 'failure' }
                ]
            }
        }));

        const result = await areAllChecksPassing('owner', 'repo', 'sha123');
        assert.strictEqual(result, false);
    });

    test('returns false when no check runs exist', async () => {
        resetMocks();
        mockOctokit.request.mock.mockImplementation(async () => ({
            data: { check_runs: [] }
        }));

        const result = await areAllChecksPassing('owner', 'repo', 'sha123');
        assert.strictEqual(result, false);
    });

    test('returns false on API error', async () => {
        resetMocks();
        mockOctokit.request.mock.mockImplementation(async () => {
            throw new Error('API error');
        });

        const result = await areAllChecksPassing('owner', 'repo', 'sha123');
        assert.strictEqual(result, false);
    });

    test('returns true when all checks are skipped', async () => {
        resetMocks();
        mockOctokit.request.mock.mockImplementation(async () => ({
            data: {
                check_runs: [
                    { name: 'Optional CI', status: 'completed', conclusion: 'skipped' },
                    { name: 'Optional Lint', status: 'completed', conclusion: 'skipped' }
                ]
            }
        }));

        const result = await areAllChecksPassing('owner', 'repo', 'sha123');
        assert.strictEqual(result, true);
    });

    test('returns true with single successful check', async () => {
        resetMocks();
        mockOctokit.request.mock.mockImplementation(async () => ({
            data: {
                check_runs: [
                    { name: 'CI', status: 'completed', conclusion: 'success' }
                ]
            }
        }));

        const result = await areAllChecksPassing('owner', 'repo', 'sha123');
        assert.strictEqual(result, true);
    });

    test('returns false when any check has queued status', async () => {
        resetMocks();
        mockOctokit.request.mock.mockImplementation(async () => ({
            data: {
                check_runs: [
                    { name: 'CI', status: 'completed', conclusion: 'success' },
                    { name: 'Deploy', status: 'queued', conclusion: null }
                ]
            }
        }));

        const result = await areAllChecksPassing('owner', 'repo', 'sha123');
        assert.strictEqual(result, false);
    });

    test('returns false when any check has cancelled conclusion', async () => {
        resetMocks();
        mockOctokit.request.mock.mockImplementation(async () => ({
            data: {
                check_runs: [
                    { name: 'CI', status: 'completed', conclusion: 'success' },
                    { name: 'Build', status: 'completed', conclusion: 'cancelled' }
                ]
            }
        }));

        const result = await areAllChecksPassing('owner', 'repo', 'sha123');
        assert.strictEqual(result, false);
    });

    test('returns false when any check has neutral conclusion', async () => {
        resetMocks();
        mockOctokit.request.mock.mockImplementation(async () => ({
            data: {
                check_runs: [
                    { name: 'CI', status: 'completed', conclusion: 'success' },
                    { name: 'Code Quality', status: 'completed', conclusion: 'neutral' }
                ]
            }
        }));

        const result = await areAllChecksPassing('owner', 'repo', 'sha123');
        assert.strictEqual(result, false);
    });

    test('returns false when any check has timed_out conclusion', async () => {
        resetMocks();
        mockOctokit.request.mock.mockImplementation(async () => ({
            data: {
                check_runs: [
                    { name: 'CI', status: 'completed', conclusion: 'success' },
                    { name: 'Integration', status: 'completed', conclusion: 'timed_out' }
                ]
            }
        }));

        const result = await areAllChecksPassing('owner', 'repo', 'sha123');
        assert.strictEqual(result, false);
    });

    test('returns false when any check has action_required conclusion', async () => {
        resetMocks();
        mockOctokit.request.mock.mockImplementation(async () => ({
            data: {
                check_runs: [
                    { name: 'CI', status: 'completed', conclusion: 'success' },
                    { name: 'Security Scan', status: 'completed', conclusion: 'action_required' }
                ]
            }
        }));

        const result = await areAllChecksPassing('owner', 'repo', 'sha123');
        assert.strictEqual(result, false);
    });

    test('returns false when any check has stale conclusion', async () => {
        resetMocks();
        mockOctokit.request.mock.mockImplementation(async () => ({
            data: {
                check_runs: [
                    { name: 'CI', status: 'completed', conclusion: 'success' },
                    { name: 'Old Check', status: 'completed', conclusion: 'stale' }
                ]
            }
        }));

        const result = await areAllChecksPassing('owner', 'repo', 'sha123');
        assert.strictEqual(result, false);
    });

    test('correctly aggregates many checks with mixed success/skipped', async () => {
        resetMocks();
        mockOctokit.request.mock.mockImplementation(async () => ({
            data: {
                check_runs: [
                    { name: 'Unit Tests', status: 'completed', conclusion: 'success' },
                    { name: 'Integration Tests', status: 'completed', conclusion: 'success' },
                    { name: 'E2E Tests', status: 'completed', conclusion: 'skipped' },
                    { name: 'Lint', status: 'completed', conclusion: 'success' },
                    { name: 'Type Check', status: 'completed', conclusion: 'success' },
                    { name: 'Optional Coverage', status: 'completed', conclusion: 'skipped' }
                ]
            }
        }));

        const result = await areAllChecksPassing('owner', 'repo', 'sha123');
        assert.strictEqual(result, true);
    });

    test('returns false when one check among many fails', async () => {
        resetMocks();
        mockOctokit.request.mock.mockImplementation(async () => ({
            data: {
                check_runs: [
                    { name: 'Unit Tests', status: 'completed', conclusion: 'success' },
                    { name: 'Integration Tests', status: 'completed', conclusion: 'success' },
                    { name: 'E2E Tests', status: 'completed', conclusion: 'failure' },
                    { name: 'Lint', status: 'completed', conclusion: 'success' },
                    { name: 'Type Check', status: 'completed', conclusion: 'success' }
                ]
            }
        }));

        const result = await areAllChecksPassing('owner', 'repo', 'sha123');
        assert.strictEqual(result, false);
    });

    test('returns false when one check among many is in_progress', async () => {
        resetMocks();
        mockOctokit.request.mock.mockImplementation(async () => ({
            data: {
                check_runs: [
                    { name: 'Unit Tests', status: 'completed', conclusion: 'success' },
                    { name: 'Integration Tests', status: 'completed', conclusion: 'success' },
                    { name: 'E2E Tests', status: 'in_progress', conclusion: null },
                    { name: 'Lint', status: 'completed', conclusion: 'success' },
                    { name: 'Type Check', status: 'completed', conclusion: 'success' }
                ]
            }
        }));

        const result = await areAllChecksPassing('owner', 'repo', 'sha123');
        assert.strictEqual(result, false);
    });
});

// ============= getCurrentPRHead Tests =============

describe('getCurrentPRHead', () => {
    test('returns the current PR head SHA', async () => {
        resetMocks();
        mockOctokit.request.mock.mockImplementation(async () => ({
            data: { head: { sha: 'current-sha-456' } }
        }));

        const result = await getCurrentPRHead('owner', 'repo', 42);
        assert.strictEqual(result, 'current-sha-456');
    });

    test('returns null on API error', async () => {
        resetMocks();
        mockOctokit.request.mock.mockImplementation(async () => {
            throw new Error('API error');
        });

        const result = await getCurrentPRHead('owner', 'repo', 42);
        assert.strictEqual(result, null);
    });
});

// ============= getPRAutoMergeInfo Tests =============

describe('getPRAutoMergeInfo', () => {
    test('returns correct info for PR with auto-merge label', async () => {
        resetMocks();
        mockOctokit.request.mock.mockImplementation(async () => ({
            data: {
                labels: [{ name: 'auto-merge' }, { name: 'enhancement' }],
                draft: false,
                base: { ref: 'main' },
                head: { ref: 'feature-branch' }
            }
        }));

        const result = await getPRAutoMergeInfo('owner', 'repo', 42);
        assert.strictEqual(result.hasLabel, true);
        assert.strictEqual(result.hasActiveUltrafixLoop, false);
        assert.strictEqual(result.isDraft, false);
        assert.strictEqual(result.baseBranch, 'main');
        assert.strictEqual(result.headBranch, 'feature-branch');
    });

    test('returns hasActiveUltrafixLoop true when Redis state is active', async () => {
        resetMocks();
        mockRedisGet.mock.mockImplementation(async () => JSON.stringify({ active: true }));
        mockOctokit.request.mock.mockImplementation(async () => ({
            data: {
                labels: [{ name: 'auto-merge' }, { name: 'ultrafix' }],
                draft: false,
                base: { ref: 'main' },
                head: { ref: 'feature-branch' }
            }
        }));

        const result = await getPRAutoMergeInfo('owner', 'repo', 42);
        assert.strictEqual(result.hasActiveUltrafixLoop, true);
    });

    test('returns ultrafix completion status when loop finished', async () => {
        resetMocks();
        mockRedisGet.mock.mockImplementation(async () => JSON.stringify({ active: false, completionStatus: 'failed' }));
        mockOctokit.request.mock.mockImplementation(async () => ({
            data: {
                labels: [{ name: 'auto-merge' }, { name: 'ultrafix' }],
                draft: false,
                base: { ref: 'main' },
                head: { ref: 'feature-branch' }
            }
        }));

        const result = await getPRAutoMergeInfo('owner', 'repo', 42);
        assert.strictEqual(result.hasActiveUltrafixLoop, false);
        assert.strictEqual(result.ultrafixCompletionStatus, 'failed');
    });

    test('uses REDIS_URL for ultrafix state lookup when configured', async () => {
        resetMocks();
        const originalRedisUrl = process.env.REDIS_URL;
        const originalRedisHost = process.env.REDIS_HOST;
        const originalRedisPort = process.env.REDIS_PORT;
        const originalRedisTlsRejectUnauthorized = process.env.REDIS_TLS_REJECT_UNAUTHORIZED;
        process.env.REDIS_URL = 'rediss://user:secret@example.com:6380/4';
        process.env.REDIS_TLS_REJECT_UNAUTHORIZED = 'false';
        delete process.env.REDIS_HOST;
        delete process.env.REDIS_PORT;

        try {
            mockOctokit.request.mock.mockImplementation(async () => ({
                data: {
                    labels: [{ name: 'auto-merge' }, { name: 'ultrafix' }],
                    draft: false,
                    base: { ref: 'main' },
                    head: { ref: 'feature-branch' }
                }
            }));

            await getPRAutoMergeInfo('owner', 'repo', 42);

            assert.deepStrictEqual(redisConstructorCalls[0], [
                'rediss://user:secret@example.com:6380/4',
                {
                    maxRetriesPerRequest: null,
                    enableReadyCheck: false,
                    host: 'example.com',
                    port: 6380,
                    username: 'user',
                    password: 'secret',
                    db: 4,
                    tls: {
                        rejectUnauthorized: false
                    }
                }
            ]);
        } finally {
            if (originalRedisUrl === undefined) delete process.env.REDIS_URL;
            else process.env.REDIS_URL = originalRedisUrl;
            if (originalRedisHost === undefined) delete process.env.REDIS_HOST;
            else process.env.REDIS_HOST = originalRedisHost;
            if (originalRedisPort === undefined) delete process.env.REDIS_PORT;
            else process.env.REDIS_PORT = originalRedisPort;
            if (originalRedisTlsRejectUnauthorized === undefined) delete process.env.REDIS_TLS_REJECT_UNAUTHORIZED;
            else process.env.REDIS_TLS_REJECT_UNAUTHORIZED = originalRedisTlsRejectUnauthorized;
        }
    });

    test('uses Redis auth and TLS env config for ultrafix state lookup without REDIS_URL', async () => {
        resetMocks();
        const originalEnv = {
            REDIS_URL: process.env.REDIS_URL,
            REDIS_HOST: process.env.REDIS_HOST,
            REDIS_PORT: process.env.REDIS_PORT,
            REDIS_USERNAME: process.env.REDIS_USERNAME,
            REDIS_PASSWORD: process.env.REDIS_PASSWORD,
            REDIS_TLS: process.env.REDIS_TLS,
            REDIS_TLS_REJECT_UNAUTHORIZED: process.env.REDIS_TLS_REJECT_UNAUTHORIZED,
        };
        delete process.env.REDIS_URL;
        process.env.REDIS_HOST = 'secure-redis.internal';
        process.env.REDIS_PORT = '6381';
        process.env.REDIS_USERNAME = 'planner';
        process.env.REDIS_PASSWORD = 'secret-pass';
        process.env.REDIS_TLS = 'true';
        process.env.REDIS_TLS_REJECT_UNAUTHORIZED = 'false';

        try {
            mockOctokit.request.mock.mockImplementation(async () => ({
                data: {
                    labels: [{ name: 'auto-merge' }, { name: 'ultrafix' }],
                    draft: false,
                    base: { ref: 'main' },
                    head: { ref: 'feature-branch' }
                }
            }));

            await getPRAutoMergeInfo('owner', 'repo', 42);

            assert.deepStrictEqual(redisConstructorCalls[0], [
                {
                    host: 'secure-redis.internal',
                    port: 6381,
                    username: 'planner',
                    password: 'secret-pass',
                    tls: {
                        rejectUnauthorized: false
                    },
                    maxRetriesPerRequest: null,
                    enableReadyCheck: false
                }
            ]);
        } finally {
            for (const [key, value] of Object.entries(originalEnv)) {
                if (value === undefined) delete process.env[key];
                else process.env[key] = value;
            }
        }
    });

    test('returns hasLabel false when label is missing', async () => {
        resetMocks();
        mockOctokit.request.mock.mockImplementation(async () => ({
            data: {
                labels: [{ name: 'bug' }],
                draft: false,
                base: { ref: 'main' },
                head: { ref: 'feature' }
            }
        }));

        const result = await getPRAutoMergeInfo('owner', 'repo', 42);
        assert.strictEqual(result.hasLabel, false);
    });

    test('returns isDraft true for draft PRs', async () => {
        resetMocks();
        mockOctokit.request.mock.mockImplementation(async () => ({
            data: {
                labels: [],
                draft: true,
                base: { ref: 'main' },
                head: { ref: 'feature' }
            }
        }));

        const result = await getPRAutoMergeInfo('owner', 'repo', 42);
        assert.strictEqual(result.isDraft, true);
    });

    test('returns defaults on API error', async () => {
        resetMocks();
        mockOctokit.request.mock.mockImplementation(async () => {
            throw new Error('API error');
        });

        const result = await getPRAutoMergeInfo('owner', 'repo', 42);
        assert.strictEqual(result.hasLabel, false);
        assert.strictEqual(result.isDraft, false);
        assert.strictEqual(result.baseBranch, '');
        assert.strictEqual(result.headBranch, '');
    });
});

// ============= linkedIssueHasAutoMergeLabel Tests =============

describe('linkedIssueHasAutoMergeLabel', () => {
    test('returns true when linked issue has auto-merge label', async () => {
        resetMocks();
        mockOctokit.request.mock.mockImplementation(async (endpoint: string) => {
            if (endpoint.includes('pulls')) {
                return { data: { body: 'Fixes #100' } };
            }
            if (endpoint.includes('issues')) {
                return { data: { labels: [{ name: 'auto-merge' }] } };
            }
            return { data: {} };
        });

        const result = await linkedIssueHasAutoMergeLabel('owner', 'repo', 42);
        assert.strictEqual(result, true);
    });

    test('returns false when linked issue lacks label', async () => {
        resetMocks();
        mockOctokit.request.mock.mockImplementation(async (endpoint: string) => {
            if (endpoint.includes('pulls')) {
                return { data: { body: 'Closes #100' } };
            }
            if (endpoint.includes('issues')) {
                return { data: { labels: [{ name: 'bug' }] } };
            }
            return { data: {} };
        });

        const result = await linkedIssueHasAutoMergeLabel('owner', 'repo', 42);
        assert.strictEqual(result, false);
    });

    test('returns false when no linked issues in PR body', async () => {
        resetMocks();
        mockOctokit.request.mock.mockImplementation(async () => ({
            data: { body: 'This PR adds a feature' }
        }));

        const result = await linkedIssueHasAutoMergeLabel('owner', 'repo', 42);
        assert.strictEqual(result, false);
    });

    test('handles multiple linked issues', async () => {
        resetMocks();
        let issueCallCount = 0;
        mockOctokit.request.mock.mockImplementation(async (endpoint: string) => {
            if (endpoint.includes('pulls')) {
                return { data: { body: 'Fixes #100 and closes #101' } };
            }
            if (endpoint.includes('issues')) {
                issueCallCount++;
                // First issue doesn't have label, second does
                if (issueCallCount === 1) {
                    return { data: { labels: [{ name: 'bug' }] } };
                }
                return { data: { labels: [{ name: 'auto-merge' }] } };
            }
            return { data: {} };
        });

        const result = await linkedIssueHasAutoMergeLabel('owner', 'repo', 42);
        assert.strictEqual(result, true);
    });
});

// ============= mergePR Tests =============

describe('mergePR', () => {
    test('successfully merges PR with squash method', async () => {
        resetMocks();
        mockOctokit.request.mock.mockImplementation(async () => ({
            data: { merged: true, sha: 'merge-sha-789' }
        }));

        const result = await mergePR({ owner: 'test-owner', repoName: 'test-repo', prNumber: 42 });

        assert.strictEqual(result.success, true);
        assert.strictEqual(result.merged, true);
        assert.strictEqual(result.sha, 'merge-sha-789');

        const apiCalls = mockOctokit.request.mock.calls;
        const mergeCall = apiCalls.find((call: { arguments: [string, { merge_method?: string }] }) =>
            call.arguments[0].includes('merge')
        );
        assert.ok(mergeCall);
        assert.strictEqual((mergeCall as { arguments: [string, { merge_method?: string }] }).arguments[1].merge_method, 'squash');
    });

    test('handles merge failure', async () => {
        resetMocks();
        mockOctokit.request.mock.mockImplementation(async () => {
            throw new Error('Merge conflict');
        });

        const result = await mergePR({ owner: 'test-owner', repoName: 'test-repo', prNumber: 42 });

        assert.strictEqual(result.success, false);
        assert.ok(result.error);
    });

    test('uses custom commit title and message', async () => {
        resetMocks();
        mockOctokit.request.mock.mockImplementation(async () => ({
            data: { merged: true, sha: 'merge-sha' }
        }));

        await mergePR({
            owner: 'test-owner',
            repoName: 'test-repo',
            prNumber: 42,
            commitTitle: 'Custom title',
            commitMessage: 'Custom message'
        });

        const apiCalls = mockOctokit.request.mock.calls;
        const mergeCall = apiCalls[0] as { arguments: [string, { commit_title?: string; commit_message?: string }] };
        assert.strictEqual(mergeCall.arguments[1].commit_title, 'Custom title');
        assert.strictEqual(mergeCall.arguments[1].commit_message, 'Custom message');
    });
});

// ============= getFirstCommitMessage Tests =============

describe('getFirstCommitMessage', () => {
    test('returns first commit title and message', async () => {
        resetMocks();
        mockOctokit.request.mock.mockImplementation(async () => ({
            data: [
                { commit: { message: 'First commit title\n\nFirst commit body' } },
                { commit: { message: 'Second commit' } }
            ]
        }));

        const result = await getFirstCommitMessage('owner', 'repo', 42);

        assert.ok(result);
        assert.strictEqual(result.title, 'First commit title');
        assert.strictEqual(result.message, 'First commit body');
    });

    test('returns null when no commits', async () => {
        resetMocks();
        mockOctokit.request.mock.mockImplementation(async () => ({
            data: []
        }));

        const result = await getFirstCommitMessage('owner', 'repo', 42);
        assert.strictEqual(result, null);
    });

    test('handles commit with no body', async () => {
        resetMocks();
        mockOctokit.request.mock.mockImplementation(async () => ({
            data: [{ commit: { message: 'Single line commit' } }]
        }));

        const result = await getFirstCommitMessage('owner', 'repo', 42);

        assert.ok(result);
        assert.strictEqual(result.title, 'Single line commit');
        assert.strictEqual(result.message, '');
    });
});

// ============= handleCheckRunEvent Tests =============

describe('handleCheckRunEvent', () => {
    test('skips when action is not completed', async () => {
        resetMocks();

        const payload = createMockCheckRunPayload({ action: 'created' });
        await handleCheckRunEvent(payload, 'test-correlation-id');

        assert.strictEqual(mockOctokit.request.mock.calls.length, 0);
    });

    test('skips when conclusion is failure', async () => {
        resetMocks();

        const payload = createMockCheckRunPayload({ conclusion: 'failure' });
        await handleCheckRunEvent(payload, 'test-correlation-id');

        assert.strictEqual(mockOctokit.request.mock.calls.length, 0);
    });

    test('skips when conclusion is cancelled', async () => {
        resetMocks();

        const payload = createMockCheckRunPayload({ conclusion: 'cancelled' });
        await handleCheckRunEvent(payload, 'test-correlation-id');

        assert.strictEqual(mockOctokit.request.mock.calls.length, 0);
    });

    test('skips when no pull requests are associated', async () => {
        resetMocks();

        const payload = createMockCheckRunPayload({ pullRequests: [] });
        await handleCheckRunEvent(payload, 'test-correlation-id');

        assert.strictEqual(mockOctokit.request.mock.calls.length, 0);
    });

    test('processes check run with success conclusion', async () => {
        resetMocks();
        mockOctokit.request.mock.mockImplementation(async (endpoint: string) => {
            if (endpoint.includes('pulls') && !endpoint.includes('merge') && !endpoint.includes('commits')) {
                return {
                    data: {
                        labels: [{ name: 'auto-merge' }],
                        draft: false,
                        base: { ref: 'main' },
                        head: { ref: 'feature', sha: 'abc123sha', repo: { owner: { login: 'test-owner' } } },
                        body: ''
                    }
                };
            }
            if (endpoint.includes('check-runs')) {
                return {
                    data: {
                        check_runs: [{ name: 'CI', status: 'completed', conclusion: 'success' }]
                    }
                };
            }
            if (endpoint.includes('merge')) {
                return { data: { merged: true, sha: 'merge123' } };
            }
            return { data: {} };
        });

        const payload = createMockCheckRunPayload({ conclusion: 'success' });
        await handleCheckRunEvent(payload, 'test-correlation-id');

        // Should have made API calls to process the PR
        assert.ok(mockOctokit.request.mock.calls.length > 0, 'Should make API calls');
    });

    test('processes check run with skipped conclusion', async () => {
        resetMocks();
        mockOctokit.request.mock.mockImplementation(async (endpoint: string) => {
            if (endpoint.includes('pulls') && !endpoint.includes('merge')) {
                return {
                    data: {
                        labels: [{ name: 'auto-merge' }],
                        draft: false,
                        base: { ref: 'main' },
                        head: { ref: 'feature', sha: 'abc123sha', repo: { owner: { login: 'test-owner' } } },
                        body: ''
                    }
                };
            }
            if (endpoint.includes('check-runs')) {
                return {
                    data: { check_runs: [{ name: 'CI', status: 'completed', conclusion: 'success' }] }
                };
            }
            if (endpoint.includes('merge')) {
                return { data: { merged: true, sha: 'merge123' } };
            }
            return { data: {} };
        });

        const payload = createMockCheckRunPayload({ conclusion: 'skipped' });
        await handleCheckRunEvent(payload, 'test-correlation-id');

        assert.ok(mockOctokit.request.mock.calls.length > 0, 'Should process skipped conclusion');
    });

    test('skips draft PRs', async () => {
        resetMocks();
        mockOctokit.request.mock.mockImplementation(async () => ({
            data: {
                labels: [{ name: 'auto-merge' }],
                draft: true,
                base: { ref: 'main' },
                head: { ref: 'feature' }
            }
        }));

        const payload = createMockCheckRunPayload({});
        await handleCheckRunEvent(payload, 'test-correlation-id');

        const mergeCall = mockOctokit.request.mock.calls.find((call: { arguments: [string] }) =>
            call.arguments[0].includes('merge')
        );
        assert.strictEqual(mergeCall, undefined, 'Should not merge draft PRs');
    });

    test('skips PR without auto-merge label', async () => {
        resetMocks();
        mockOctokit.request.mock.mockImplementation(async (endpoint: string) => {
            if (endpoint.includes('pulls')) {
                return {
                    data: {
                        labels: [{ name: 'bug' }],
                        draft: false,
                        base: { ref: 'main' },
                        head: { ref: 'feature' },
                        body: ''
                    }
                };
            }
            return { data: { labels: [] } };
        });

        const payload = createMockCheckRunPayload({});
        await handleCheckRunEvent(payload, 'test-correlation-id');

        const mergeCall = mockOctokit.request.mock.calls.find((call: { arguments: [string] }) =>
            call.arguments[0].includes('merge')
        );
        assert.strictEqual(mergeCall, undefined, 'Should not merge without label');
    });

    test('skips merge when SHA mismatch (newer commits pushed)', async () => {
        resetMocks();
        mockOctokit.request.mock.mockImplementation(async (endpoint: string) => {
            if (endpoint.includes('pulls') && !endpoint.includes('merge')) {
                return {
                    data: {
                        labels: [{ name: 'auto-merge' }],
                        draft: false,
                        base: { ref: 'main' },
                        head: { ref: 'feature', sha: 'different-sha-456' }, // Different SHA
                        body: ''
                    }
                };
            }
            if (endpoint.includes('check-runs')) {
                return {
                    data: { check_runs: [{ name: 'CI', status: 'completed', conclusion: 'success' }] }
                };
            }
            return { data: {} };
        });

        const payload = createMockCheckRunPayload({ headSha: 'abc123sha' }); // Check run for old SHA
        await handleCheckRunEvent(payload, 'test-correlation-id');

        const mergeCall = mockOctokit.request.mock.calls.find((call: { arguments: [string] }) =>
            call.arguments[0].includes('merge')
        );
        assert.strictEqual(mergeCall, undefined, 'Should NOT merge when SHA mismatch');
    });

    test('merges when SHA matches and all checks pass', async () => {
        resetMocks();
        mockOctokit.request.mock.mockImplementation(async (endpoint: string) => {
            if (endpoint.includes('pulls') && !endpoint.includes('merge') && !endpoint.includes('commits')) {
                return {
                    data: {
                        labels: [{ name: 'auto-merge' }],
                        draft: false,
                        base: { ref: 'main' },
                        head: { ref: 'feature', sha: 'abc123sha', repo: { owner: { login: 'test-owner' } } },
                        body: ''
                    }
                };
            }
            if (endpoint.includes('check-runs')) {
                return {
                    data: { check_runs: [{ name: 'CI', status: 'completed', conclusion: 'success' }] }
                };
            }
            if (endpoint.includes('merge')) {
                return { data: { merged: true, sha: 'merge123' } };
            }
            return { data: {} };
        });

        const payload = createMockCheckRunPayload({ headSha: 'abc123sha' });
        await handleCheckRunEvent(payload, 'test-correlation-id');

        const mergeCall = mockOctokit.request.mock.calls.find((call: { arguments: [string] }) =>
            call.arguments[0].includes('merge')
        );
        assert.ok(mergeCall, 'Should merge when SHA matches');
    });

    test('handles errors gracefully without throwing', async () => {
        resetMocks();
        mockOctokit.request.mock.mockImplementation(async () => {
            throw new Error('API error');
        });

        const payload = createMockCheckRunPayload({});

        // Should not throw
        await handleCheckRunEvent(payload, 'test-correlation-id');
        // Test passes if no error is thrown
    });

    test('processes multiple PRs from same check run', async () => {
        resetMocks();
        let prCallCount = 0;
        mockOctokit.request.mock.mockImplementation(async (endpoint: string) => {
            if (endpoint.includes('pulls') && !endpoint.includes('merge')) {
                prCallCount++;
                return {
                    data: {
                        labels: [{ name: 'auto-merge' }],
                        draft: false,
                        base: { ref: 'main' },
                        head: { ref: 'feature', sha: 'abc123sha', repo: { owner: { login: 'test-owner' } } },
                        body: ''
                    }
                };
            }
            if (endpoint.includes('check-runs')) {
                return {
                    data: { check_runs: [{ name: 'CI', status: 'completed', conclusion: 'success' }] }
                };
            }
            if (endpoint.includes('merge')) {
                return { data: { merged: true, sha: 'merge123' } };
            }
            return { data: {} };
        });

        const payload = createMockCheckRunPayload({
            pullRequests: [{ number: 42 }, { number: 43 }]
        });
        await handleCheckRunEvent(payload, 'test-correlation-id');

        // Should have processed both PRs
        assert.ok(prCallCount >= 2, 'Should process multiple PRs');
    });

    test('updates plan issue status after successful merge', async () => {
        resetMocks();
        mockFindPlanIssueByRepoAndPR.mock.mockImplementation(async () => ({
            id: 'plan-123',
            draft_id: 'draft-456',
            status: 'in_progress'
        }));

        mockOctokit.request.mock.mockImplementation(async (endpoint: string) => {
            if (endpoint.includes('pulls') && !endpoint.includes('merge') && !endpoint.includes('commits')) {
                return {
                    data: {
                        labels: [{ name: 'auto-merge' }],
                        draft: false,
                        base: { ref: 'main' },
                        head: { ref: 'feature', sha: 'abc123sha', repo: { owner: { login: 'test-owner' } } },
                        body: ''
                    }
                };
            }
            if (endpoint.includes('check-runs')) {
                return {
                    data: { check_runs: [{ name: 'CI', status: 'completed', conclusion: 'success' }] }
                };
            }
            if (endpoint.includes('merge')) {
                return { data: { merged: true, sha: 'merge123' } };
            }
            return { data: {} };
        });

        const payload = createMockCheckRunPayload({ headSha: 'abc123sha' });
        await handleCheckRunEvent(payload, 'test-correlation-id');

        assert.strictEqual(mockUpdatePlanIssueByPR.mock.calls.length, 1, 'Should update plan issue');
        const updateCall = mockUpdatePlanIssueByPR.mock.calls[0] as { arguments: [string, number, { status: string }] };
        assert.strictEqual(updateCall.arguments[2].status, 'merged');
    });

    test('triggers next issue for epic branch without auto-merge label', async () => {
        resetMocks();
        mockFindPlanIssueByRepoAndNumber.mock.mockImplementation(async () => ({
            id: 'plan-123',
            draft_id: 'draft-456'
        }));

        mockOctokit.request.mock.mockImplementation(async (endpoint: string) => {
            if (endpoint.includes('pulls') && !endpoint.includes('merge')) {
                return {
                    data: {
                        labels: [], // No auto-merge label
                        draft: false,
                        base: { ref: 'main' },
                        head: { ref: '800-epic-short-name-x7y', sha: 'abc123sha' }, // Epic branch
                        body: ''
                    }
                };
            }
            if (endpoint.includes('check-runs')) {
                return {
                    data: { check_runs: [{ name: 'CI', status: 'completed', conclusion: 'success' }] }
                };
            }
            return { data: {} };
        });

        const payload = createMockCheckRunPayload({ headSha: 'abc123sha' });
        await handleCheckRunEvent(payload, 'test-correlation-id');

        // Should not merge but should trigger next issue
        const mergeCall = mockOctokit.request.mock.calls.find((call: { arguments: [string] }) =>
            call.arguments[0].includes('merge')
        );
        assert.strictEqual(mergeCall, undefined, 'Should not merge epic PR without label');
        assert.strictEqual(mockTriggerNextPendingIssue.mock.calls.length, 1, 'Should trigger next issue');
    });

    test('merges epic branch when it has auto-merge label', async () => {
        resetMocks();
        mockOctokit.request.mock.mockImplementation(async (endpoint: string) => {
            if (endpoint.includes('pulls') && !endpoint.includes('merge') && !endpoint.includes('commits')) {
                return {
                    data: {
                        labels: [{ name: 'auto-merge' }],
                        draft: false,
                        base: { ref: 'main' },
                        head: { ref: '800-epic-short-name-x7y', sha: 'abc123sha', repo: { owner: { login: 'test-owner' } } },
                        body: ''
                    }
                };
            }
            if (endpoint.includes('check-runs')) {
                return {
                    data: { check_runs: [{ name: 'CI', status: 'completed', conclusion: 'success' }] }
                };
            }
            if (endpoint.includes('merge')) {
                return { data: { merged: true, sha: 'merge123' } };
            }
            return { data: {} };
        });

        const payload = createMockCheckRunPayload({ headSha: 'abc123sha' });
        await handleCheckRunEvent(payload, 'test-correlation-id');

        const mergeCall = mockOctokit.request.mock.calls.find((call: { arguments: [string] }) =>
            call.arguments[0].includes('merge')
        );
        assert.ok(mergeCall, 'Should merge epic PR with auto-merge label');
    });

    test('deletes branch after successful merge', async () => {
        resetMocks();
        mockOctokit.request.mock.mockImplementation(async (endpoint: string) => {
            if (endpoint.includes('pulls') && !endpoint.includes('merge') && !endpoint.includes('commits')) {
                return {
                    data: {
                        labels: [{ name: 'auto-merge' }],
                        draft: false,
                        base: { ref: 'main' },
                        head: { ref: 'feature', sha: 'abc123sha', repo: { owner: { login: 'test-owner' } } },
                        body: ''
                    }
                };
            }
            if (endpoint.includes('check-runs')) {
                return {
                    data: { check_runs: [{ name: 'CI', status: 'completed', conclusion: 'success' }] }
                };
            }
            if (endpoint.includes('merge')) {
                return { data: { merged: true, sha: 'merge123' } };
            }
            return { data: {} };
        });

        const payload = createMockCheckRunPayload({ headSha: 'abc123sha' });
        await handleCheckRunEvent(payload, 'test-correlation-id');

        const deleteCall = mockOctokit.request.mock.calls.find((call: { arguments: [string] }) =>
            call.arguments[0].includes('DELETE') && call.arguments[0].includes('refs')
        );
        assert.ok(deleteCall, 'Should delete branch after merge');
    });

    test('does not delete branch from fork', async () => {
        resetMocks();
        mockOctokit.request.mock.mockImplementation(async (endpoint: string) => {
            if (endpoint.includes('pulls') && !endpoint.includes('merge') && !endpoint.includes('commits')) {
                return {
                    data: {
                        labels: [{ name: 'auto-merge' }],
                        draft: false,
                        base: { ref: 'main' },
                        head: {
                            ref: 'feature',
                            sha: 'abc123sha',
                            repo: { owner: { login: 'fork-owner' } } // Different owner - fork
                        },
                        body: ''
                    }
                };
            }
            if (endpoint.includes('check-runs')) {
                return {
                    data: { check_runs: [{ name: 'CI', status: 'completed', conclusion: 'success' }] }
                };
            }
            if (endpoint.includes('merge')) {
                return { data: { merged: true, sha: 'merge123' } };
            }
            return { data: {} };
        });

        const payload = createMockCheckRunPayload({ headSha: 'abc123sha' });
        await handleCheckRunEvent(payload, 'test-correlation-id');

        const deleteCall = mockOctokit.request.mock.calls.find((call: { arguments: [string] }) =>
            call.arguments[0].includes('DELETE') && call.arguments[0].includes('refs')
        );
        assert.strictEqual(deleteCall, undefined, 'Should not delete branch from fork');
    });
});

// ============= shouldAutoMergePR Tests =============

describe('shouldAutoMergePR', () => {
    // Helper to create a mock PRMergeContext
    function createMockPRMergeContext(options: {
        owner?: string;
        repoName?: string;
        prNumber?: number;
        headSha?: string;
        hasLabel?: boolean;
        hasUltrafixLabel?: boolean;
        hasActiveUltrafixLoop?: boolean;
        ultrafixCompletionStatus?: 'succeeded' | 'failed' | null;
        ultrafixStateUnavailable?: boolean;
        isDraft?: boolean;
        baseBranch?: string;
        headBranch?: string;
    }): PRMergeContext {
        const {
            owner = 'test-owner',
            repoName = 'test-repo',
            prNumber = 42,
            headSha = 'abc123sha',
            hasLabel = false,
            hasUltrafixLabel = false,
            hasActiveUltrafixLoop = false,
            ultrafixCompletionStatus = null,
            ultrafixStateUnavailable = false,
            isDraft = false,
            baseBranch = 'main',
            headBranch = 'feature-branch'
        } = options;

        return {
            owner,
            repoName,
            prNumber,
            headSha,
            prInfo: {
                hasLabel,
                hasUltrafixLabel,
                hasActiveUltrafixLoop,
                ultrafixCompletionStatus,
                ultrafixStateUnavailable,
                isDraft,
                baseBranch,
                headBranch
            },
            log: mockLogger.withCorrelation('test-correlation')
        };
    }

    test('returns true with direct auto-merge label on regular branch', async () => {
        resetMocks();
        // No API calls needed - PR already has the label
        const ctx = createMockPRMergeContext({
            hasLabel: true,
            headBranch: 'feature-branch'
        });

        const result = await shouldAutoMergePR(ctx);
        assert.strictEqual(result, true);
    });

    test('returns false when PR is blocked by ultrafix label', async () => {
        resetMocks();
        const ctx = createMockPRMergeContext({
            hasLabel: true,
            hasActiveUltrafixLoop: true,
            headBranch: 'feature-branch'
        });

        const result = await shouldAutoMergePR(ctx);
        assert.strictEqual(result, false);
    });

    test('blocks epic auto-merge progression while ultrafix loop is active', async () => {
        resetMocks();
        const ctx = createMockPRMergeContext({
            hasLabel: false,
            hasActiveUltrafixLoop: true,
            hasUltrafixLabel: true,
            headBranch: '800-epic-short-name-x7y'
        });

        const result = await shouldAutoMergePR(ctx);
        assert.strictEqual(result, false);
        assert.strictEqual(mockTriggerNextPendingIssue.mock.calls.length, 0);
    });

    test('does not hard-block auto-merge solely because the ultrafix label remains without Redis state', async () => {
        resetMocks();
        const ctx = createMockPRMergeContext({
            hasLabel: true,
            hasUltrafixLabel: true,
            hasActiveUltrafixLoop: false,
            headBranch: 'feature-branch'
        });

        const result = await shouldAutoMergePR(ctx);
        assert.strictEqual(result, true);
    });

    test('falls back to auto-merge when ultrafix state is unavailable while ultrafix is still labeled', async () => {
        resetMocks();
        const ctx = createMockPRMergeContext({
            hasLabel: true,
            hasUltrafixLabel: true,
            ultrafixStateUnavailable: true,
            headBranch: 'feature-branch'
        });

        const result = await shouldAutoMergePR(ctx);
        assert.strictEqual(result, true);
    });

    test('falls back to linked issue auto-merge when ultrafix state is unavailable and PR has no direct label', async () => {
        resetMocks();
        mockOctokit.request.mock.mockImplementation(async (endpoint: string) => {
            if (endpoint.includes('pulls')) {
                return { data: { body: 'Fixes #100' } };
            }
            if (endpoint.includes('issues')) {
                return { data: { labels: [{ name: 'auto-merge' }] } };
            }
            return { data: {} };
        });

        const ctx = createMockPRMergeContext({
            hasLabel: false,
            hasUltrafixLabel: true,
            ultrafixStateUnavailable: true,
            headBranch: 'feature-branch'
        });

        const result = await shouldAutoMergePR(ctx);
        assert.strictEqual(result, true);
    });

    test('blocks auto-merge when ultrafix finished unsuccessfully', async () => {
        resetMocks();
        const ctx = createMockPRMergeContext({
            hasLabel: true,
            hasUltrafixLabel: false,
            hasActiveUltrafixLoop: false,
            ultrafixCompletionStatus: 'failed',
            headBranch: 'feature-branch'
        });

        const result = await shouldAutoMergePR(ctx);
        assert.strictEqual(result, false);
    });

    test('allows auto-merge after ultrafix completed successfully', async () => {
        resetMocks();
        const ctx = createMockPRMergeContext({
            hasLabel: true,
            hasUltrafixLabel: false,
            hasActiveUltrafixLoop: false,
            ultrafixCompletionStatus: 'succeeded',
            headBranch: 'feature-branch'
        });

        const result = await shouldAutoMergePR(ctx);
        assert.strictEqual(result, true);
    });

    test('returns true with auto-merge label on linked issue', async () => {
        resetMocks();
        // Mock linkedIssueHasAutoMergeLabel to return true
        mockOctokit.request.mock.mockImplementation(async (endpoint: string) => {
            if (endpoint.includes('pulls')) {
                return { data: { body: 'Fixes #100' } };
            }
            if (endpoint.includes('issues')) {
                return { data: { labels: [{ name: 'auto-merge' }] } };
            }
            return { data: {} };
        });

        const ctx = createMockPRMergeContext({
            hasLabel: false, // PR doesn't have label
            headBranch: 'feature-branch'
        });

        const result = await shouldAutoMergePR(ctx);
        assert.strictEqual(result, true);
    });

    test('returns false without any auto-merge label', async () => {
        resetMocks();
        // Mock linkedIssueHasAutoMergeLabel to return false
        mockOctokit.request.mock.mockImplementation(async (endpoint: string) => {
            if (endpoint.includes('pulls')) {
                return { data: { body: 'Fixes #100' } };
            }
            if (endpoint.includes('issues')) {
                return { data: { labels: [{ name: 'bug' }] } }; // No auto-merge label
            }
            return { data: {} };
        });

        const ctx = createMockPRMergeContext({
            hasLabel: false,
            headBranch: 'feature-branch'
        });

        const result = await shouldAutoMergePR(ctx);
        assert.strictEqual(result, false);
    });

    test('returns true for epic branch with auto-merge label', async () => {
        resetMocks();
        const ctx = createMockPRMergeContext({
            hasLabel: true,
            headBranch: '800-epic-short-name-x7y' // Epic branch pattern
        });

        const result = await shouldAutoMergePR(ctx);
        assert.strictEqual(result, true);
    });

    test('returns false for epic branch without auto-merge label', async () => {
        resetMocks();
        // Mock getCurrentPRHead and areAllChecksPassing for handleEpicPRWithoutAutoMerge
        mockOctokit.request.mock.mockImplementation(async (endpoint: string) => {
            if (endpoint.includes('pulls') && !endpoint.includes('merge') && !endpoint.includes('commits')) {
                return {
                    data: {
                        head: { sha: 'abc123sha' }
                    }
                };
            }
            if (endpoint.includes('check-runs')) {
                return {
                    data: { check_runs: [{ name: 'CI', status: 'completed', conclusion: 'success' }] }
                };
            }
            return { data: {} };
        });

        mockFindPlanIssueByRepoAndNumber.mock.mockImplementation(async () => null);

        const ctx = createMockPRMergeContext({
            hasLabel: false,
            headBranch: '800-epic-short-name-x7y' // Epic branch pattern
        });

        const result = await shouldAutoMergePR(ctx);
        assert.strictEqual(result, false);
    });

    test('returns false when no linked issues found and PR has no label', async () => {
        resetMocks();
        // PR body without issue reference
        mockOctokit.request.mock.mockImplementation(async () => ({
            data: { body: 'This PR adds a feature without issue reference' }
        }));

        const ctx = createMockPRMergeContext({
            hasLabel: false,
            headBranch: 'feature-branch'
        });

        const result = await shouldAutoMergePR(ctx);
        assert.strictEqual(result, false);
    });

    test('epic branch triggers handleEpicPRWithoutAutoMerge when no label', async () => {
        resetMocks();
        mockOctokit.request.mock.mockImplementation(async (endpoint: string) => {
            if (endpoint.includes('pulls') && !endpoint.includes('merge') && !endpoint.includes('commits')) {
                return { data: { head: { sha: 'abc123sha' } } };
            }
            if (endpoint.includes('check-runs')) {
                return {
                    data: { check_runs: [{ name: 'CI', status: 'completed', conclusion: 'success' }] }
                };
            }
            return { data: {} };
        });

        mockFindPlanIssueByRepoAndNumber.mock.mockImplementation(async () => ({
            id: 'plan-123',
            draft_id: 'draft-456'
        }));

        const ctx = createMockPRMergeContext({
            hasLabel: false,
            headBranch: '800-epic-short-name-x7y'
        });

        await shouldAutoMergePR(ctx);

        // Should have triggered the next pending issue
        assert.strictEqual(mockTriggerNextPendingIssue.mock.calls.length, 1);
    });

    test('returns true when only linked issue has label (PR label false)', async () => {
        resetMocks();
        mockOctokit.request.mock.mockImplementation(async (endpoint: string) => {
            if (endpoint.includes('pulls')) {
                return { data: { body: 'Closes #50' } };
            }
            if (endpoint.includes('issues')) {
                return { data: { labels: [{ name: 'auto-merge' }, { name: 'enhancement' }] } };
            }
            return { data: {} };
        });

        const ctx = createMockPRMergeContext({
            hasLabel: false,
            headBranch: 'fix-bug'
        });

        const result = await shouldAutoMergePR(ctx);
        assert.strictEqual(result, true);
    });

    test('returns true when PR has label regardless of linked issue', async () => {
        resetMocks();
        // Even if linkedIssueHasAutoMergeLabel would be checked, PR label takes precedence
        // For non-epic branches with hasLabel=true, we don't even check linked issue

        const ctx = createMockPRMergeContext({
            hasLabel: true,
            headBranch: 'feature-branch'
        });

        const result = await shouldAutoMergePR(ctx);
        assert.strictEqual(result, true);

        // Verify linkedIssueHasAutoMergeLabel wasn't called (no pulls API call for body)
        // When PR has label, we skip the linked issue check
    });
});
