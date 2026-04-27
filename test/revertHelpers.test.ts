import { test, describe, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert';

/**
 * Route-level tests for revert authorization and scope checks.
 *
 * Exercises the production helpers in revertHelpers.ts:
 * - checkRevertAuthorization: whitelist denial, missing SYSTEM_TASK_SECRET
 * - checkUserRepoAccess: proper status codes for 404/403 vs server errors
 * - verifyCommitBelongsToPr: commit-not-in-PR rejection
 * - verifyAppRepoAccess: fork access failure before queueing
 */

const TEST_SECRET = 'test-secret-for-route-tests';

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
    for (const key of Object.keys(originalEnv)) {
        delete originalEnv[key];
    }
}

// Mock getAuthenticatedOctokit for helpers that need it
const mockOctokit = {
    request: mock.fn(async (_route: string, _params: Record<string, unknown>) => {
        return { data: {} };
    }),
    paginate: mock.fn(async (_route: string, _params: Record<string, unknown>) => {
        return [];
    })
};

await mock.module('@propr/core', {
    namedExports: {
        getUserWhitelist: mock.fn(() => ['alice', 'bob']),
        getAuthenticatedOctokit: mock.fn(async () => mockOctokit),
        generateCorrelationId: () => 'test-correlation',
        generateAuthToken: (await import('@propr/core')).generateAuthToken,
        buildAuthPayload: (await import('@propr/core')).buildAuthPayload
    }
});

const {
    checkRevertAuthorization,
    checkUserRepoAccess,
    verifyCommitBelongsToPr,
    verifyAppRepoAccess,
    validateRevertRequestBody
} = await import('../packages/api/routes/revertHelpers.ts');

describe('checkRevertAuthorization — route-level', () => {
    beforeEach(() => {
        saveAndSetEnv('SYSTEM_TASK_SECRET', TEST_SECRET);
    });

    afterEach(async () => {
        restoreEnv();
        const coreMod = await import('@propr/core');
        (coreMod.getUserWhitelist as ReturnType<typeof mock.fn>).mock.mockImplementation(() => ['alice', 'bob']);
    });

    test('rejects when user is not authenticated', () => {
        const result = checkRevertAuthorization({ user: undefined });
        assert.strictEqual(result.authorized, false);
        if (!result.authorized) {
            assert.strictEqual(result.status, 401);
        }
    });

    test('rejects when whitelist is empty (fail-closed)', async () => {
        const coreMod = await import('@propr/core');
        (coreMod.getUserWhitelist as ReturnType<typeof mock.fn>).mock.mockImplementation(() => []);

        const result = checkRevertAuthorization({ user: { username: 'alice' } });
        assert.strictEqual(result.authorized, false);
        if (!result.authorized) {
            assert.strictEqual(result.status, 403);
            assert.ok(result.error.includes('whitelist'));
        }
    });

    test('rejects when user is not in whitelist', () => {
        const result = checkRevertAuthorization({ user: { username: 'mallory' } });
        assert.strictEqual(result.authorized, false);
        if (!result.authorized) {
            assert.strictEqual(result.status, 403);
            assert.ok(result.error.includes('mallory'));
        }
    });

    test('rejects when SYSTEM_TASK_SECRET is not configured', () => {
        saveAndSetEnv('SYSTEM_TASK_SECRET', undefined);
        const result = checkRevertAuthorization({ user: { username: 'alice' } });
        assert.strictEqual(result.authorized, false);
        if (!result.authorized) {
            assert.strictEqual(result.status, 503);
        }
    });

    test('authorizes a whitelisted user with configured secret', () => {
        const result = checkRevertAuthorization({ user: { username: 'alice' } });
        assert.strictEqual(result.authorized, true);
        if (result.authorized) {
            assert.strictEqual(result.requestingUser, 'alice');
            assert.strictEqual(result.systemTaskSecret, TEST_SECRET);
        }
    });
});

describe('checkUserRepoAccess — status code differentiation', () => {
    afterEach(() => {
        mockOctokit.request.mock.resetCalls();
    });

    test('returns 403 when GitHub returns 404 (user not a collaborator)', async () => {
        mockOctokit.request.mock.mockImplementation(async () => {
            const err = new Error('Not Found') as Error & { status: number };
            err.status = 404;
            throw err;
        });

        const result = await checkUserRepoAccess('owner', 'repo', 'unknown-user', mockOctokit as never);
        assert.strictEqual(result.allowed, false);
        if (!result.allowed) {
            assert.strictEqual(result.status, 403, 'Should return 403 for non-collaborator, not 502');
            assert.ok(result.error.includes('does not have access'));
        }
    });

    test('returns 403 when GitHub returns 403 (app lacks repo access)', async () => {
        mockOctokit.request.mock.mockImplementation(async () => {
            const err = new Error('Forbidden') as Error & { status: number };
            err.status = 403;
            throw err;
        });

        const result = await checkUserRepoAccess('owner', 'repo', 'user', mockOctokit as never);
        assert.strictEqual(result.allowed, false);
        if (!result.allowed) {
            assert.strictEqual(result.status, 403, 'Should return 403 for forbidden, not 502');
        }
    });

    test('returns 502 for genuine server errors', async () => {
        mockOctokit.request.mock.mockImplementation(async () => {
            const err = new Error('Internal Server Error') as Error & { status: number };
            err.status = 500;
            throw err;
        });

        const result = await checkUserRepoAccess('owner', 'repo', 'user', mockOctokit as never);
        assert.strictEqual(result.allowed, false);
        if (!result.allowed) {
            assert.strictEqual(result.status, 502, 'Should return 502 for actual server errors');
        }
    });

    test('returns 403 for insufficient permissions (read-only)', async () => {
        mockOctokit.request.mock.mockImplementation(async () => {
            return { data: { permission: 'read' } };
        });

        const result = await checkUserRepoAccess('owner', 'repo', 'reader', mockOctokit as never);
        assert.strictEqual(result.allowed, false);
        if (!result.allowed) {
            assert.strictEqual(result.status, 403);
            assert.ok(result.error.includes('does not have write access'));
        }
    });

    test('allows write permission', async () => {
        mockOctokit.request.mock.mockImplementation(async () => {
            return { data: { permission: 'write' } };
        });

        const result = await checkUserRepoAccess('owner', 'repo', 'writer', mockOctokit as never);
        assert.strictEqual(result.allowed, true);
    });
});

describe('verifyCommitBelongsToPr — commit scope check', () => {
    afterEach(() => {
        mockOctokit.paginate.mock.resetCalls();
    });

    test('rejects commit not in PR', async () => {
        mockOctokit.paginate.mock.mockImplementation(async () => {
            return [{ sha: 'aaaa1111bbbb2222' }, { sha: 'cccc3333dddd4444' }];
        });

        const result = await verifyCommitBelongsToPr({ octokit: mockOctokit as never, owner: 'owner', repo: 'repo', prNumber: 42, commit: 'not-in-pr-hash' });
        assert.strictEqual(result.valid, false);
        if (!result.valid) {
            assert.strictEqual(result.status, 400);
            assert.ok(result.error.includes('does not belong'));
        }
    });

    test('accepts commit that is in PR', async () => {
        mockOctokit.paginate.mock.mockImplementation(async () => {
            return [{ sha: 'abc1234def5678' }, { sha: 'cccc3333dddd4444' }];
        });

        const result = await verifyCommitBelongsToPr({ octokit: mockOctokit as never, owner: 'owner', repo: 'repo', prNumber: 42, commit: 'abc1234def5678' });
        assert.strictEqual(result.valid, true);
    });
});

describe('verifyAppRepoAccess — fork repo access check', () => {
    afterEach(() => {
        mockOctokit.request.mock.resetCalls();
    });

    test('returns accessible when app can access the repo', async () => {
        mockOctokit.request.mock.mockImplementation(async () => {
            return { data: { full_name: 'fork-user/repo' } };
        });

        const result = await verifyAppRepoAccess('fork-user', 'repo', mockOctokit as never);
        assert.strictEqual(result.accessible, true);
    });

    test('returns 422 when app cannot access fork (404)', async () => {
        mockOctokit.request.mock.mockImplementation(async () => {
            const err = new Error('Not Found') as Error & { status: number };
            err.status = 404;
            throw err;
        });

        const result = await verifyAppRepoAccess('fork-user', 'repo', mockOctokit as never);
        assert.strictEqual(result.accessible, false);
        if (!result.accessible) {
            assert.strictEqual(result.status, 422);
            assert.ok(result.error.includes('does not have access to fork'));
        }
    });

    test('returns 422 when app cannot access fork (403)', async () => {
        mockOctokit.request.mock.mockImplementation(async () => {
            const err = new Error('Forbidden') as Error & { status: number };
            err.status = 403;
            throw err;
        });

        const result = await verifyAppRepoAccess('fork-user', 'repo', mockOctokit as never);
        assert.strictEqual(result.accessible, false);
        if (!result.accessible) {
            assert.strictEqual(result.status, 422);
        }
    });

    test('returns 502 for genuine server errors', async () => {
        mockOctokit.request.mock.mockImplementation(async () => {
            const err = new Error('Server Error') as Error & { status: number };
            err.status = 500;
            throw err;
        });

        const result = await verifyAppRepoAccess('fork-user', 'repo', mockOctokit as never);
        assert.strictEqual(result.accessible, false);
        if (!result.accessible) {
            assert.strictEqual(result.status, 502);
        }
    });
});

describe('validateRevertRequestBody — input validation', () => {
    test('rejects missing required fields', () => {
        const result = validateRevertRequestBody({});
        assert.strictEqual(result.valid, false);
    });

    test('rejects invalid owner name', () => {
        const result = validateRevertRequestBody({
            repo: 'testrepo', pr: '1', commit: 'abc1234', commentId: '100', owner: 'bad/owner'
        });
        assert.strictEqual(result.valid, false);
        if (!result.valid) assert.ok(result.error.includes('owner'));
    });

    test('rejects invalid commit hash', () => {
        const result = validateRevertRequestBody({
            repo: 'testrepo', pr: '1', commit: 'not-a-hash!', commentId: '100', owner: 'testorg'
        });
        assert.strictEqual(result.valid, false);
        if (!result.valid) assert.ok(result.error.includes('commit'));
    });

    test('accepts valid request body', () => {
        const result = validateRevertRequestBody({
            repo: 'testrepo', pr: '42', commit: 'abc1234def', commentId: '99999', owner: 'testorg'
        });
        assert.strictEqual(result.valid, true);
    });
});
