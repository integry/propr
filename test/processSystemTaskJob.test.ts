import { test, describe, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert';
import { generateAuthToken } from '@propr/core';
import type { SystemTaskJobData, JobResult } from '@propr/core';

/**
 * Worker-path tests for processSystemTaskJob.
 *
 * These tests verify that:
 * 1. Authorization (whitelist + HMAC) fails BEFORE any git operations execute
 * 2. Fork PRs with proper headRepoOwner/headRepoName target the head repo correctly
 * 3. Fork PRs without headRepoOwner/headRepoName in the payload are rejected
 */

const TEST_SECRET = 'test-secret-for-worker-tests';

// Track call order to prove auth runs before git operations
let callOrder: string[] = [];

const mockOctokitInstance = {
    request: mock.fn(async (route: string, params: Record<string, unknown>) => {
        if (route === 'GET /repos/{owner}/{repo}/pulls/{pull_number}') {
            callOrder.push('github:getPR');
            // Default: non-fork PR
            return {
                data: {
                    head: {
                        ref: 'feature-branch',
                        sha: 'head1234567890abcdef1234567890abcdef123456',
                        repo: {
                            owner: { login: params.owner as string },
                            name: params.repo as string,
                            full_name: `${params.owner}/${params.repo}`
                        }
                    },
                    base: {
                        repo: {
                            full_name: `${params.owner}/${params.repo}`
                        }
                    }
                }
            };
        }
        if (route === 'GET /repos/{owner}/{repo}/collaborators/{username}/permission') {
            callOrder.push('github:checkPermission');
            return { data: { permission: 'write' } };
        }
        if (route === 'GET /repos/{owner}/{repo}/issues/{issue_number}/comments') {
            callOrder.push('github:getComments');
            return { data: [] };
        }
        if (route === 'DELETE /repos/{owner}/{repo}/issues/comments/{comment_id}') {
            callOrder.push('github:deleteComment');
            return { data: {} };
        }
        return { data: {} };
    }),
    paginate: mock.fn(async (route: string) => {
        if (typeof route === 'string' && route.includes('/commits')) {
            callOrder.push('github:getPRCommits');
            // Return a commit that matches the default test commitHash
            return [{ sha: 'abc1234def5678' }];
        }
        callOrder.push('github:paginate');
        return [];
    }),
    auth: mock.fn(async () => {
        callOrder.push('github:auth');
        return { token: 'mock-installation-token' };
    })
};

// Mock all external dependencies
await mock.module('@propr/core', {
    namedExports: {
        logger: {
            withCorrelation: () => ({
                info: () => {},
                warn: () => {},
                error: () => {},
                debug: () => {}
            })
        },
        getUserWhitelist: mock.fn(() => ['alice', 'bob']),
        verifyAuthToken: (await import('@propr/core')).verifyAuthToken,
        getAuthenticatedOctokit: mock.fn(async () => mockOctokitInstance),
        ensureRepoCloned: mock.fn(async (opts: Record<string, string>) => {
            callOrder.push(`git:clone:${opts.owner}/${opts.repoName}`);
            return `/tmp/repos/${opts.owner}/${opts.repoName}`;
        }),
        createWorktreeFromExistingBranch: mock.fn(async (localRepoPath: string, _branch: string, opts: Record<string, string>) => {
            callOrder.push(`git:worktree:${opts.owner}/${opts.repoName}`);
            return { worktreePath: `${localRepoPath}/worktrees/revert`, branchName: _branch };
        }),
        getRepoUrl: mock.fn((issue: { repoOwner: string; repoName: string }) => {
            return `https://github.com/${issue.repoOwner}/${issue.repoName}.git`;
        }),
        cleanupWorktree: mock.fn(async () => {
            callOrder.push('git:cleanup');
        }),
        generateAuthToken,
        buildAuthPayload: (await import('@propr/core')).buildAuthPayload
    }
});

const mockSimpleGit = {
    reset: mock.fn(async () => { callOrder.push('git:reset'); }),
    push: mock.fn(async () => { callOrder.push('git:push'); })
};
await mock.module('simple-git', {
    namedExports: {
        simpleGit: mock.fn(() => mockSimpleGit)
    }
});

const { processSystemTaskJob } = await import('../src/jobs/processSystemTaskJob.ts');

const originalEnv: Record<string, string | undefined> = {};

function saveAndSetEnv(key: string, value: string | undefined): void {
    if (!(key in originalEnv)) {
        originalEnv[key] = process.env[key];
    }
    if (value === undefined) {
        delete process.env[key];
    } else {
        process.env[key] = value;
    }
}

function restoreEnv(): void {
    for (const [key, value] of Object.entries(originalEnv)) {
        if (value === undefined) {
            delete process.env[key];
        } else {
            process.env[key] = value;
        }
    }
    // Clear the snapshot so subsequent suites start fresh
    for (const key of Object.keys(originalEnv)) {
        delete originalEnv[key];
    }
}

function makeJobData(overrides: Partial<SystemTaskJobData> = {}): SystemTaskJobData {
    const base: SystemTaskJobData = {
        type: 'revert',
        owner: 'testorg',
        repoName: 'testrepo',
        prNumber: 42,
        requestingUser: 'alice',
        commitHash: 'abc1234def5678',
        targetCommentId: 99999,
        prBranch: 'feature-branch',
        prHeadSha: 'head1234567890abcdef1234567890abcdef123456',
        authTimestamp: Date.now(),
        authToken: '',
        correlationId: 'test-correlation',
        ...overrides
    };
    return base;
}

function makeSignedJobData(overrides: Partial<SystemTaskJobData> = {}): SystemTaskJobData {
    const data = makeJobData(overrides);
    data.authToken = generateAuthToken(data, TEST_SECRET);
    return data;
}

function makeJob(data: SystemTaskJobData) {
    return { id: 'test-job-1', data } as { id: string; data: SystemTaskJobData };
}

describe('processSystemTaskJob — worker-path authorization', () => {
    beforeEach(() => {
        callOrder = [];
        saveAndSetEnv('SYSTEM_TASK_SECRET', TEST_SECRET);
        // Reset mock call counts
        mockSimpleGit.reset.mock.resetCalls();
        mockSimpleGit.push.mock.resetCalls();
    });

    afterEach(() => {
        restoreEnv();
    });

    test('rejects when user whitelist is empty — before any git operations', async () => {
        const { getUserWhitelist } = await import('@propr/core');
        (getUserWhitelist as ReturnType<typeof mock.fn>).mock.mockImplementation(() => []);

        const data = makeSignedJobData();
        const job = makeJob(data);

        await assert.rejects(
            () => processSystemTaskJob(job as never),
            (err: Error) => {
                assert.ok(err.message.includes('whitelist is not configured'));
                return true;
            }
        );

        // No git operations should have been called
        assert.strictEqual(callOrder.filter(c => c.startsWith('git:')).length, 0,
            'No git operations should execute when whitelist is empty');
        assert.strictEqual(callOrder.filter(c => c.startsWith('github:')).length, 0,
            'No GitHub API calls should execute when whitelist is empty');

        // Restore whitelist
        (getUserWhitelist as ReturnType<typeof mock.fn>).mock.mockImplementation(() => ['alice', 'bob']);
    });

    test('rejects when user is not in whitelist — before any git operations', async () => {
        const data = makeSignedJobData({ requestingUser: 'mallory' });
        const job = makeJob(data);

        await assert.rejects(
            () => processSystemTaskJob(job as never),
            (err: Error) => {
                assert.ok(err.message.includes('not allowed to perform system tasks'));
                return true;
            }
        );

        assert.strictEqual(callOrder.filter(c => c.startsWith('git:')).length, 0,
            'No git operations should execute for unauthorized user');
    });

    test('rejects when auth token is missing — before any git operations', async () => {
        const data = makeJobData({ authToken: '' });
        const job = makeJob(data);

        await assert.rejects(
            () => processSystemTaskJob(job as never),
            (err: Error) => {
                assert.ok(err.message.includes('auth token invalid'));
                return true;
            }
        );

        assert.strictEqual(callOrder.filter(c => c.startsWith('git:')).length, 0,
            'No git operations should execute with missing auth token');
    });

    test('rejects when HMAC token is invalid — before any git operations', async () => {
        const data = makeJobData({
            authToken: 'a'.repeat(64) // valid format but wrong HMAC
        });
        const job = makeJob(data);

        await assert.rejects(
            () => processSystemTaskJob(job as never),
            (err: Error) => {
                assert.ok(err.message.includes('auth token invalid'));
                return true;
            }
        );

        assert.strictEqual(callOrder.filter(c => c.startsWith('git:')).length, 0,
            'No git operations should execute with invalid HMAC');
    });

    test('rejects when SYSTEM_TASK_SECRET is not set — before any git operations', async () => {
        saveAndSetEnv('SYSTEM_TASK_SECRET', undefined);
        const data = makeSignedJobData();
        const job = makeJob(data);

        await assert.rejects(
            () => processSystemTaskJob(job as never),
            (err: Error) => {
                assert.ok(err.message.includes('auth token invalid'));
                return true;
            }
        );

        assert.strictEqual(callOrder.filter(c => c.startsWith('git:')).length, 0,
            'No git operations should execute without SYSTEM_TASK_SECRET');
    });
});

describe('processSystemTaskJob — fork PR handling', () => {
    beforeEach(async () => {
        callOrder = [];
        saveAndSetEnv('SYSTEM_TASK_SECRET', TEST_SECRET);
        mockSimpleGit.reset.mock.resetCalls();
        mockSimpleGit.push.mock.resetCalls();

        // Restore whitelist (awaited to avoid race)
        const coreMod = await import('@propr/core');
        (coreMod.getUserWhitelist as ReturnType<typeof mock.fn>).mock.mockImplementation(() => ['alice', 'bob']);
    });

    afterEach(() => {
        restoreEnv();
    });

    test('rejects fork PR when headRepoOwner/headRepoName missing from payload', async () => {
        // Configure mock to return a fork PR
        mockOctokitInstance.request.mock.mockImplementation(async (route: string, params: Record<string, unknown>) => {
            if (route === 'GET /repos/{owner}/{repo}/pulls/{pull_number}') {
                callOrder.push('github:getPR');
                return {
                    data: {
                        head: {
                            ref: 'feature-branch',
                            sha: 'head1234567890abcdef1234567890abcdef123456',
                            repo: {
                                owner: { login: 'fork-user' },
                                name: 'testrepo',
                                full_name: 'fork-user/testrepo'
                            }
                        },
                        base: {
                            repo: {
                                full_name: 'testorg/testrepo'
                            }
                        }
                    }
                };
            }
            if (route === 'GET /repos/{owner}/{repo}/collaborators/{username}/permission') {
                callOrder.push('github:checkPermission');
                return { data: { permission: 'write' } };
            }
            return { data: {} };
        });

        // Job data does NOT include headRepoOwner/headRepoName
        const data = makeSignedJobData();
        const job = makeJob(data);

        await assert.rejects(
            () => processSystemTaskJob(job as never),
            (err: Error) => {
                assert.ok(err.message.includes('fork PR'));
                assert.ok(err.message.includes('does not include headRepoOwner'));
                return true;
            }
        );

        // git operations should not have executed
        assert.ok(!callOrder.includes('git:reset'), 'git reset should not execute for fork PR without head repo in payload');
        assert.ok(!callOrder.includes('git:push'), 'git push should not execute for fork PR without head repo in payload');
    });

    test('rejects fork PR when headRepoOwner/headRepoName mismatch actual head', async () => {
        // Configure mock to return a fork PR
        mockOctokitInstance.request.mock.mockImplementation(async (route: string, params: Record<string, unknown>) => {
            if (route === 'GET /repos/{owner}/{repo}/pulls/{pull_number}') {
                callOrder.push('github:getPR');
                return {
                    data: {
                        head: {
                            ref: 'feature-branch',
                            sha: 'head1234567890abcdef1234567890abcdef123456',
                            repo: {
                                owner: { login: 'fork-user' },
                                name: 'testrepo',
                                full_name: 'fork-user/testrepo'
                            }
                        },
                        base: {
                            repo: {
                                full_name: 'testorg/testrepo'
                            }
                        }
                    }
                };
            }
            if (route === 'GET /repos/{owner}/{repo}/collaborators/{username}/permission') {
                callOrder.push('github:checkPermission');
                return { data: { permission: 'write' } };
            }
            return { data: {} };
        });

        // Job claims a different fork owner than actual
        const data = makeSignedJobData({
            headRepoOwner: 'wrong-fork-user',
            headRepoName: 'testrepo'
        });
        const job = makeJob(data);

        await assert.rejects(
            () => processSystemTaskJob(job as never),
            (err: Error) => {
                assert.ok(err.message.includes('head repo mismatch'));
                return true;
            }
        );

        assert.ok(!callOrder.includes('git:reset'), 'git reset should not execute for mismatched fork');
        assert.ok(!callOrder.includes('git:push'), 'git push should not execute for mismatched fork');
    });

    test('authorized fork PR targets the head (fork) repo for git operations', async () => {
        // Configure mock to return a fork PR
        mockOctokitInstance.request.mock.mockImplementation(async (route: string, params: Record<string, unknown>) => {
            if (route === 'GET /repos/{owner}/{repo}/pulls/{pull_number}') {
                callOrder.push('github:getPR');
                return {
                    data: {
                        head: {
                            ref: 'feature-branch',
                            sha: 'head1234567890abcdef1234567890abcdef123456',
                            repo: {
                                owner: { login: 'fork-user' },
                                name: 'forked-repo',
                                full_name: 'fork-user/forked-repo'
                            }
                        },
                        base: {
                            repo: {
                                full_name: 'testorg/testrepo'
                            }
                        }
                    }
                };
            }
            if (route === 'GET /repos/{owner}/{repo}/collaborators/{username}/permission') {
                callOrder.push('github:checkPermission');
                return { data: { permission: 'write' } };
            }
            return { data: {} };
        });

        const data = makeSignedJobData({
            headRepoOwner: 'fork-user',
            headRepoName: 'forked-repo'
        });
        const job = makeJob(data);

        const result = await processSystemTaskJob(job as never) as JobResult;

        assert.strictEqual(result.status, 'complete');

        // Verify git operations targeted the fork repo, not the base repo
        assert.ok(callOrder.includes('git:clone:fork-user/forked-repo'),
            `Expected clone to target fork-user/forked-repo, got: ${callOrder.join(', ')}`);
        assert.ok(callOrder.includes('git:worktree:fork-user/forked-repo'),
            `Expected worktree to target fork-user/forked-repo, got: ${callOrder.join(', ')}`);

        // Ensure it did NOT target the base repo
        assert.ok(!callOrder.includes('git:clone:testorg/testrepo'),
            'Clone should NOT target the base repo for fork PRs');
    });

    test('non-fork PR targets the base repo for git operations', async () => {
        // Configure mock to return a non-fork PR
        mockOctokitInstance.request.mock.mockImplementation(async (route: string, params: Record<string, unknown>) => {
            if (route === 'GET /repos/{owner}/{repo}/pulls/{pull_number}') {
                callOrder.push('github:getPR');
                return {
                    data: {
                        head: {
                            ref: 'feature-branch',
                            repo: {
                                owner: { login: 'testorg' },
                                name: 'testrepo',
                                full_name: 'testorg/testrepo'
                            }
                        },
                        base: {
                            repo: {
                                full_name: 'testorg/testrepo'
                            }
                        }
                    }
                };
            }
            if (route === 'GET /repos/{owner}/{repo}/collaborators/{username}/permission') {
                callOrder.push('github:checkPermission');
                return { data: { permission: 'write' } };
            }
            return { data: {} };
        });

        const data = makeSignedJobData();
        const job = makeJob(data);

        const result = await processSystemTaskJob(job as never) as JobResult;

        assert.strictEqual(result.status, 'complete');

        // Verify git operations targeted the base repo
        assert.ok(callOrder.includes('git:clone:testorg/testrepo'),
            `Expected clone to target testorg/testrepo, got: ${callOrder.join(', ')}`);
    });
});

describe('processSystemTaskJob — authorization order guarantee', () => {
    beforeEach(async () => {
        callOrder = [];
        saveAndSetEnv('SYSTEM_TASK_SECRET', TEST_SECRET);

        const coreMod = await import('@propr/core');
        (coreMod.getUserWhitelist as ReturnType<typeof mock.fn>).mock.mockImplementation(() => ['alice', 'bob']);

        // Reset to non-fork PR
        mockOctokitInstance.request.mock.mockImplementation(async (route: string, params: Record<string, unknown>) => {
            if (route === 'GET /repos/{owner}/{repo}/pulls/{pull_number}') {
                callOrder.push('github:getPR');
                return {
                    data: {
                        head: {
                            ref: 'feature-branch',
                            sha: 'head1234567890abcdef1234567890abcdef123456',
                            repo: {
                                owner: { login: params.owner as string },
                                name: params.repo as string,
                                full_name: `${params.owner}/${params.repo}`
                            }
                        },
                        base: {
                            repo: {
                                full_name: `${params.owner}/${params.repo}`
                            }
                        }
                    }
                };
            }
            if (route === 'GET /repos/{owner}/{repo}/collaborators/{username}/permission') {
                callOrder.push('github:checkPermission');
                return { data: { permission: 'write' } };
            }
            return { data: {} };
        });
    });

    afterEach(() => {
        restoreEnv();
    });

    test('successful request executes auth checks before git operations', async () => {
        const data = makeSignedJobData();
        const job = makeJob(data);

        await processSystemTaskJob(job as never);

        // Auth checks happen before any GitHub/git calls
        const firstGitOp = callOrder.findIndex(c => c.startsWith('git:') || c.startsWith('github:'));
        assert.ok(firstGitOp >= 0, 'Should have git/github operations');
        // The auth checks are synchronous and happen before any async GitHub calls,
        // so the first entry in callOrder should be a GitHub API call (getPR), not a git op
        assert.strictEqual(callOrder[0], 'github:getPR',
            'First external call should be GitHub PR lookup (after auth checks)');
    });
});
